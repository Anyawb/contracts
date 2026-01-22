// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { HealthFactorLib } from "../../../libraries/HealthFactorLib.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { IPositionViewValuation } from "../../../interfaces/IPositionViewValuation.sol";
import { IGuaranteeFundManager } from "../../../interfaces/IGuaranteeFundManager.sol";

/// @dev Minimal interface for HealthView reads to avoid circular dependencies.
interface IHealthViewLite {
    function getUserHealthFactor(address user)
        external
        view
        returns (uint256 healthFactor, bool isValid, uint256 timestamp);
}

/**
 * @title RiskView
 * @notice Read-only risk view that derives coarse risk assessments from HealthView cache.
 * @dev Reverts if:
 *      - registry is not configured or not a contract
 *        (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
 *      - caller lacks ACTION_VIEW_RISK_DATA permission (via onlyRiskViewer / ViewAccessLib)
 *
 * Security:
 * - Role-gated reads via ACTION_VIEW_RISK_DATA
 * - Upgrade authorization is role-gated (ACTION_ADMIN)
 * - Best-effort HealthView dependency: falls back to healthFactor=10_000 (bps) if HealthView cache
 *   is invalid or the call fails
 * @custom:security-contact security@example.com
 */
contract RiskView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Types ━━━━━━━━━━━━━━━*/
    enum WarningLevel { NONE, WARNING, CRITICAL }

    struct RiskAssessment {
        bool liquidatable;
        /// @dev Cached health factor, as provided by HealthView (bps; 10_000 = 100%).
        uint256 healthFactor;
        WarningLevel warningLevel;
    }

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    address private _registryAddr;
    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    bytes4 private constant _SEL_GET_LOCKED_GUARANTEE = IGuaranteeFundManager.getLockedGuarantee.selector;

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when users.length exceeds MAX_BATCH_SIZE. Used by {batchGetRiskAssessments}.
    error RiskView__BatchTooLarge();

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    modifier onlyRiskViewer() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_RISK_DATA, msg.sender);
        _;
    }

    /*━━━━━━━━━━━━━━━ Constructor / Initializer ━━━━━━━━━━━━━━━*/
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the RiskView module with a Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - Callable once via proxy initializer
     *
     * @param initialRegistryAddr Registry address used for module resolution and access control
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get a user's risk assessment derived from HealthView cache.
     * @dev Reverts if:
     *      - registry is not configured or not a contract
     *        (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_RISK_DATA permission (via onlyRiskViewer / ViewAccessLib)
     *
     * Security:
     * - Role-gated reads via ACTION_VIEW_RISK_DATA
     * - Best-effort HealthView read: falls back to healthFactor=10_000 (bps) if cache is invalid or the call fails
     *
     * @param user Target user address
     * @return a Risk assessment:
     *         - healthFactor: cached HF (bps; 10_000 = 100%)
     *         - liquidatable: true if healthFactor < 10_000
     *         - warningLevel: CRITICAL if < 10_000, WARNING if < 11_000, NONE otherwise
     */
    function getUserRiskAssessment(address user)
        external
        view
        onlyValidRegistry
        onlyRiskViewer
        returns (RiskAssessment memory a)
    {
        uint256 hf = _healthFactor(user);
        a.healthFactor = hf;
        a.liquidatable = hf < 10_000;
        a.warningLevel = hf < 10_000 ? WarningLevel.CRITICAL : (hf < 11_000 ? WarningLevel.WARNING : WarningLevel.NONE);
    }

    /**
     * @notice Calculate a user's health factor after excluding locked guarantee for a given asset.
     * @dev Reverts if:
     *      - registry is not configured or not a contract
     *        (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_RISK_DATA permission (via onlyRiskViewer / ViewAccessLib)
     *
     * Security:
     * - Role-gated reads via ACTION_VIEW_RISK_DATA
     * - Best-effort dependency reads: missing modules / failed calls default to 0 totals/guarantee
     *
     * @param user Target user address
     * @param asset Asset address whose locked guarantee should be excluded
     * @return healthFactor Health factor (bps; 10_000 = 100%) computed from best-effort totals/guarantee reads
     */
    function calculateHealthFactorExcludingGuarantee(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyRiskViewer
        returns (uint256)
    {
        (uint256 totalCol, uint256 totalDebt) = _getUserTotals(user);
        uint256 guarantee = _getUserGuarantee(user, asset);
        uint256 effectiveCol = HealthFactorLib.effectiveCollateral(totalCol, guarantee);
        return HealthFactorLib.calcHealthFactor(effectiveCol, totalDebt);
    }

    /**
     * @notice Batch-get risk assessments for multiple users.
     * @dev Reverts if:
     *      - registry is not configured or not a contract
     *        (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_RISK_DATA permission (via onlyRiskViewer / ViewAccessLib)
     *      - users.length exceeds the maximum batch size (see {RiskView__BatchTooLarge})
     *
     * Security:
     * - Role-gated reads via ACTION_VIEW_RISK_DATA
     * - Best-effort HealthView reads per user (see {_healthFactor})
     *
     * @param users Target user addresses (may be empty; returns an empty array)
     * @return arr Per-user risk assessments, in the same order as input
     */
    function batchGetRiskAssessments(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyRiskViewer
        returns (RiskAssessment[] memory arr)
    {
        if (users.length > _MAX_BATCH_SIZE) revert RiskView__BatchTooLarge();
        uint256 len = users.length;
        arr = new RiskAssessment[](len);
        for (uint256 i; i < len; ) {
            arr[i] = _buildRisk(users[i]);
            unchecked { ++i; }
        }
    }

    /**
     * @notice Returns the currently configured Registry address.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return registry Current Registry address
     */
    function registryAddr() external view returns (address) { return _registryAddr; }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/
    function _buildRisk(address user) internal view returns (RiskAssessment memory a) {
        uint256 hf = _healthFactor(user);
        a.healthFactor = hf;
        a.liquidatable = hf < 10_000;
        a.warningLevel = hf < 10_000 ? WarningLevel.CRITICAL : (hf < 11_000 ? WarningLevel.WARNING : WarningLevel.NONE);
    }

    /// @dev Best-effort HealthView read. Returns 10_000 (bps) if the cache is invalid or the call fails.
    function _healthFactor(address user) internal view returns (uint256) {
        address hv = _getModule(ModuleKeys.KEY_HEALTH_VIEW);
        if (hv != address(0)) {
            try IHealthViewLite(hv).getUserHealthFactor(user) returns (uint256 hf, bool valid, uint256) {
                return valid ? hf : 10_000;
            } catch {
                // best-effort: fall back below
            }
        }
        return 10_000;
    }

    /// @dev Best-effort totals read. Missing modules / failed calls default to 0 for that total.
    function _getUserTotals(address user) internal view returns (uint256 totalCollateral, uint256 totalDebt) {
        address le = _getModule(ModuleKeys.KEY_LE);
        address pv = _getModule(ModuleKeys.KEY_POSITION_VIEW);
        if (le != address(0)) {
            try ILendingEngineBasic(le).getUserTotalDebtValue(user) returns (uint256 v) {
                totalDebt = v;
            } catch {
                totalDebt = 0;
            }
        }
        if (pv != address(0)) {
            try IPositionViewValuation(pv).getUserTotalCollateralValue(user) returns (uint256 v) {
                totalCollateral = v;
            } catch {
                totalCollateral = 0;
            }
        }
    }

    /// @dev Best-effort guarantee read via staticcall. Returns 0 on failure or missing module.
    function _getUserGuarantee(address user, address asset) internal view returns (uint256 amount) {
        address gfm = _getModule(ModuleKeys.KEY_GUARANTEE_FUND);
        if (gfm != address(0)) {
            (bool success, bytes memory data) = gfm.staticcall(
                abi.encodeWithSelector(_SEL_GET_LOCKED_GUARANTEE, user, asset)
            );
            if (success && data.length >= 32) amount = abi.decode(data, (uint256));
        }
    }

    function _getModule(bytes32 key) internal view returns (address moduleAddr) {
        moduleAddr = Registry(_registryAddr).getModule(key);
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━━━*/
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the API version for this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return version API version
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Returns the schema version for this module's outputs/caches.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return version Schema version
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;
}
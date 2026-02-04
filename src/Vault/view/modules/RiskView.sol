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
import { BatchTooLarge, EmptyArray, MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { IPositionViewValuation } from "../../../interfaces/IPositionViewValuation.sol";
import { IGuaranteeFundManager } from "../../../interfaces/IGuaranteeFundManager.sol";

/// @dev Minimal interface for HealthView reads to avoid circular dependencies.
interface IHealthViewLite {
    function getUserHealthFactorWithMeta(address user)
        external
        view
        returns (uint256 healthFactor, bool isValid, uint256 blockNumber);
}

/**
 * @title RiskView
 * @notice Read-only risk view that derives coarse risk assessments from HealthView cache.
 * @dev Reverts if:
 *      - registry is not configured or not a contract
 *        (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
 *      - caller lacks Scheme U permission (self or VIEW_USER_DATA/ADMIN)
 *
 * Security:
 * - Scheme U reads (self or VIEW_USER_DATA/ADMIN)
 * - Upgrade authorization is role-gated (ACTION_ADMIN)
 * - Best-effort HealthView dependency: falls back to healthFactor=10_000 (bps) if HealthView cache
 *   is invalid or the call fails
 * @custom:security-contact security@example.com
 */
contract RiskView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Types ━━━━━━━━━━━━━━━*/
    enum WarningLevel { NONE, WARNING, CRITICAL }

    struct RiskAssessmentWithMeta {
        bool liquidatable;
        bool isValid;
        WarningLevel warningLevel;
        /// @dev Cached health factor, as provided by HealthView (bps; 10_000 = 100%).
        uint256 healthFactor;
        uint256 blockNumber;
    }

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    address private _registryAddr;
    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    bytes4 private constant _SEL_GET_LOCKED_GUARANTEE = IGuaranteeFundManager.getLockedGuarantee.selector;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Scheme U: self-read allowed; non-self requires VIEW_USER_DATA or ADMIN.
    modifier onlyUserOrViewer(address user) {
        if (
            msg.sender != user
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    /// @dev Scheme U batch: no self-bypass; must have VIEW_USER_DATA or ADMIN.
    modifier onlyUserBatchViewer() {
        if (
            !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
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
     *      - caller lacks Scheme U permission (self or VIEW_USER_DATA/ADMIN)
     *
     * Security:
     * - Scheme U reads (self or VIEW_USER_DATA/ADMIN)
     * - Best-effort HealthView read: falls back to healthFactor=10_000 (bps) if cache is invalid or the call fails
     *
     * @param user Target user address
     * @return a Risk assessment with cache metadata:
     *         - healthFactor: cached HF (bps; 10_000 = 100%)
     *         - liquidatable: true if healthFactor < 10_000
     *         - warningLevel: CRITICAL if < 10_000, WARNING if < 11_000, NONE otherwise
     *         - isValid: HealthView cache validity flag
     *         - blockNumber: HealthView cache blockNumber
     */
    function getUserRiskAssessment(address user)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (RiskAssessmentWithMeta memory a)
    {
        (uint256 hf, bool ok, uint256 blockNumber) = _healthFactorWithMeta(user);
        a.healthFactor = hf;
        a.liquidatable = ok && hf < 10_000;
        a.warningLevel = hf < 10_000 ? WarningLevel.CRITICAL : (hf < 11_000 ? WarningLevel.WARNING : WarningLevel.NONE);
        a.isValid = ok;
        a.blockNumber = blockNumber;
    }

    /**
     * @notice Calculate a user's health factor after excluding locked guarantee for a given asset, with metadata.
     * @dev Reverts if:
     *      - registry is not configured or not a contract
     *        (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller lacks Scheme U permission (self or VIEW_USER_DATA/ADMIN)
     *
     * Security:
     * - Scheme U reads (self or VIEW_USER_DATA/ADMIN)
     * - Best-effort dependency reads: missing modules / failed calls default to 0 totals/guarantee
     *
     * @param user Target user address
     * @param asset Asset address whose locked guarantee should be excluded
     * @return healthFactor Health factor (bps; 10_000 = 100%) computed from best-effort totals/guarantee reads
     * @return isValid Whether the read succeeded
     * @return blockNumber Read block number (block.number)
     */
    function calculateHealthFactorExcludingGuarantee(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (uint256 healthFactor, bool isValid, uint256 blockNumber)
    {
        (uint256 totalCol, uint256 totalDebt) = _getUserTotals(user);
        uint256 guarantee = _getUserGuarantee(user, asset);
        uint256 effectiveCol = HealthFactorLib.effectiveCollateral(totalCol, guarantee);
        healthFactor = HealthFactorLib.calcHealthFactor(effectiveCol, totalDebt);
        return (healthFactor, true, _now());
    }

    /**
     * @notice Batch-get risk assessments for multiple users.
     * @dev Reverts if:
     *      - registry is not configured or not a contract
     *        (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller lacks Scheme U batch permission (VIEW_USER_DATA/ADMIN)
     *      - users is empty (see {EmptyArray})
     *      - users.length exceeds the maximum batch size (see {BatchTooLarge})
     *
     * Security:
     * - Scheme U batch reads (VIEW_USER_DATA/ADMIN)
     * - Best-effort HealthView reads per user (see {_healthFactor})
     *
     * @param users Target user addresses (must be non-empty)
     * @return arr Per-user risk assessments with meta, in the same order as input
     */
    function batchGetRiskAssessments(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyUserBatchViewer
        returns (RiskAssessmentWithMeta[] memory arr)
    {
        if (users.length == 0) {
            revert EmptyArray();
        }
        if (users.length > _MAX_BATCH_SIZE) {
            revert BatchTooLarge(users.length, _MAX_BATCH_SIZE);
        }
        uint256 len = users.length;
        arr = new RiskAssessmentWithMeta[](len);
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

    /// @dev View-only block helper for meta outputs (not used for state changes).
    function _now() internal view returns (uint256) {
        return block.number;
    }

    function _buildRisk(address user) internal view returns (RiskAssessmentWithMeta memory a) {
        (uint256 hf, bool ok, uint256 blockNumber) = _healthFactorWithMeta(user);
        a.healthFactor = hf;
        a.liquidatable = ok && hf < 10_000;
        a.warningLevel = hf < 10_000 ? WarningLevel.CRITICAL : (hf < 11_000 ? WarningLevel.WARNING : WarningLevel.NONE);
        a.isValid = ok;
        a.blockNumber = blockNumber;
    }

    /// @dev Best-effort HealthView read. Returns (10_000,false,0) if the cache is invalid or the call fails.
    function _healthFactorWithMeta(address user) internal view returns (uint256, bool, uint256) {
        address hv = _getModule(ModuleKeys.KEY_HEALTH_VIEW);
        if (hv != address(0)) {
            try IHealthViewLite(hv).getUserHealthFactorWithMeta(user) returns (uint256 hf, bool valid, uint256 blockNumber) {
                return (valid ? hf : 10_000, valid, blockNumber);
            } catch {
                // best-effort: fall back below
            }
        }
        return (10_000, false, 0);
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
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
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
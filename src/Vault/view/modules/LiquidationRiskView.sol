// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { LiquidationRiskLib } from "../../liquidation/libraries/LiquidationRiskLib.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ArrayLengthMismatch, EmptyArray, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @dev Minimal HealthView interface (read-only).
 *      This view module intentionally relies on a narrow surface area to reduce coupling.
 */
interface IHealthViewLite {
    function getUserHealthFactor(address user)
        external
        view
        returns (uint256 healthFactor, bool isValid, uint256 timestamp);
    function getCacheTimestamp(address user) external view returns (uint256); // legacy
    function batchGetHealthFactors(address[] calldata users)
        external
        view
        returns (uint256[] memory factors, bool[] memory validFlags, uint256[] memory timestamps);
}

/**
 * @title LiquidationRiskView
 * @notice Exposes role-gated liquidation risk reads and batch helpers for liquidation risk evaluation.
 * @dev Reverts if:
 *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
 *      - caller lacks required risk-view permissions (see access-control modifiers)
 *      - batch inputs are invalid (see {EmptyArray}, {ArrayLengthMismatch}, {LiquidationRiskView__BatchTooLarge})
 *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
 *
 * Security:
 * - Role-gated reads via {ViewAccessLib} and {ActionKeys}
 * - Upgrade authorization is role-gated (ACTION_ADMIN)
 */
contract LiquidationRiskView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when a batch query exceeds {ViewConstants.MAX_BATCH_SIZE}.
    error LiquidationRiskView__BatchTooLarge();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Ensures the Registry address is configured and is a contract.
     * @dev Reverts if:
     *      - _registryAddr is zero (see {ZeroAddress})
     *      - _registryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - Read-only guard
     */
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /**
     * @notice Requires system-level risk view permission.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_RISK_DATA (via {ViewAccessLib})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_RISK_DATA)
     */
    modifier onlyRiskViewerSystem() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_RISK_DATA, msg.sender);
        _;
    }

    /**
     * @notice Requires caller to be authorized to view risk data for a specific user.
     * @dev Reverts if:
     *      - caller is not user and lacks ACTION_VIEW_RISK_DATA (via {ViewAccessLib})
     *
     * Security:
     * - Self access is allowed; non-self access is risk-role gated
     *
     * @param user Target user address
     */
    modifier onlyRiskViewerFor(address user) {
        if (msg.sender != user) {
            ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_RISK_DATA, msg.sender);
        }
        _;
    }

    /*━━━━━━━━━━━━━━━ Constructor / Initializer ━━━━━━━━━━━━━━━*/
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the view module with the Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - Initializer is single-use (OpenZeppelin Initializable)
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Pure helpers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Calculates health factors for a batch of collateral/debt pairs.
     * @dev Reverts if:
     *      - collaterals.length != debts.length (see {ArrayLengthMismatch})
     *
     * Security:
     * - Pure function
     *
     * @param collaterals Collateral amounts (implementation-defined units)
     * @param debts Debt amounts (implementation-defined units)
     * @return healthFactors Health factors as returned by LiquidationRiskLib.calculateHealthFactor
     *         (implementation-defined scale)
     */
    function batchCalculateHealthFactors(
        uint256[] calldata collaterals,
        uint256[] calldata debts
    ) external pure returns (uint256[] memory healthFactors) {
        uint256 len = collaterals.length;
        if (len != debts.length) revert ArrayLengthMismatch(len, debts.length);
        healthFactors = new uint256[](len);
        for (uint256 i; i < len; ) {
            healthFactors[i] = LiquidationRiskLib.calculateHealthFactor(collaterals[i], debts[i]);
            unchecked { ++i; }
        }
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the cached health factor together with a read-time block number.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized for user (see {onlyRiskViewerFor})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (self or ACTION_VIEW_RISK_DATA)
     * - Best-effort semantics: returns (0,0,0) if cache is missing/invalid
     *
     * @param user Target user address
     * @return healthFactor Cached health factor (implementation-defined scale); 0 if missing/invalid
     * @return timestamp Cache timestamp (seconds); 0 if missing/invalid
     * @return blockNumber Current block number at read time; 0 if missing/invalid
     */
    function getHealthFactorCacheWithBlock(address user)
        external
        view
        onlyValidRegistry
        onlyRiskViewerFor(user)
        returns (uint256 healthFactor, uint256 timestamp, uint256 blockNumber)
    {
        (uint256 hf, bool valid, uint256 ts) = _hv().getUserHealthFactor(user);
        if (hf == 0 || !valid || ts == 0) {
            return (0, 0, 0);
        }
        return (hf, ts, block.number);
    }

    /**
     * @notice Returns whether a user is liquidatable according to the RiskManager.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized for user (see {onlyRiskViewerFor})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (self or ACTION_VIEW_RISK_DATA)
     *
     * @param user Target user address
     * @return liquidatable True if the RiskManager reports the user is liquidatable
     */
    function isLiquidatable(address user) external view onlyValidRegistry onlyRiskViewerFor(user) returns (bool) {
        return _rm().isLiquidatable(user);
    }

    /**
     * @notice Returns whether a user is liquidatable under a provided collateral/debt scenario for an asset.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized for user (see {onlyRiskViewerFor})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (self or ACTION_VIEW_RISK_DATA)
     *
     * @param user Target user address
     * @param collateral Collateral amount (asset decimals; as expected by RiskManager)
     * @param debt Debt amount (asset decimals; as expected by RiskManager)
     * @param asset Asset address
     * @return liquidatable True if the RiskManager reports the scenario is liquidatable
     */
    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address asset
    ) external view onlyValidRegistry onlyRiskViewerFor(user) returns (bool) {
        return _rm().isLiquidatable(user, collateral, debt, asset);
    }

    /**
     * @notice Returns the liquidation risk score for a user.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized for user (see {onlyRiskViewerFor})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (self or ACTION_VIEW_RISK_DATA)
     *
     * @param user Target user address
     * @return riskScore Risk score (implementation-defined scale)
     */
    function getLiquidationRiskScore(address user)
        external
        view
        onlyValidRegistry
        onlyRiskViewerFor(user)
        returns (uint256 riskScore)
    {
        return _rm().getLiquidationRiskScore(user);
    }

    /**
     * @notice Returns the cached user health factor (0 if invalid).
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized for user (see {onlyRiskViewerFor})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (self or ACTION_VIEW_RISK_DATA)
     * - Best-effort semantics: returns 0 if cache validity flag is false
     *
     * @param user Target user address
     * @return healthFactor Cached health factor (implementation-defined scale); 0 if invalid
     */
    function getUserHealthFactor(address user)
        external
        view
        onlyValidRegistry
        onlyRiskViewerFor(user)
        returns (uint256 healthFactor)
    {
        (uint256 hf, bool valid, ) = _hv().getUserHealthFactor(user);
        return valid ? hf : 0;
    }

    /**
     * @notice Batch-check whether users are liquidatable.
     * @dev Reverts if:
     *      - users is empty (see {EmptyArray})
     *      - users.length exceeds the maximum batch size (see {LiquidationRiskView__BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_RISK_DATA (via {ViewAccessLib})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_RISK_DATA)
     *
     * @param users Target user addresses
     * @return liquidatableFlags Per-user liquidation flags
     */
    function batchIsLiquidatable(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyRiskViewerSystem
        returns (bool[] memory liquidatableFlags)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len > ViewConstants.MAX_BATCH_SIZE) revert LiquidationRiskView__BatchTooLarge();
        return _rm().batchIsLiquidatable(users);
    }

    /**
     * @notice Returns cached health factors for a batch of users (0 if invalid per user).
     * @dev Reverts if:
     *      - users is empty (see {EmptyArray})
     *      - users.length exceeds the maximum batch size (see {LiquidationRiskView__BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_RISK_DATA (via {ViewAccessLib})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_RISK_DATA)
     * - Best-effort semantics: invalid cache entries are returned as 0
     *
     * @param users Target user addresses
     * @return healthFactors Cached health factors (implementation-defined scale); 0 where invalid
     */
    function batchGetUserHealthFactors(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyRiskViewerSystem
        returns (uint256[] memory healthFactors)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len > ViewConstants.MAX_BATCH_SIZE) revert LiquidationRiskView__BatchTooLarge();
        (uint256[] memory factors, bool[] memory flags, ) = _hv().batchGetHealthFactors(users);
        uint256[] memory out = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            out[i] = flags[i] ? factors[i] : 0;
        }
        return out;
    }

    /**
     * @notice Returns liquidation risk scores for a batch of users.
     * @dev Reverts if:
     *      - users is empty (see {EmptyArray})
     *      - users.length exceeds the maximum batch size (see {LiquidationRiskView__BatchTooLarge})
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_RISK_DATA (via {ViewAccessLib})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_RISK_DATA)
     *
     * @param users Target user addresses
     * @return riskScores Risk scores (implementation-defined scale)
     */
    function batchGetLiquidationRiskScores(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyRiskViewerSystem
        returns (uint256[] memory riskScores)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len > ViewConstants.MAX_BATCH_SIZE) revert LiquidationRiskView__BatchTooLarge();
        return _rm().batchGetLiquidationRiskScores(users);
    }

    /**
     * @notice Returns the liquidation threshold as defined by the RiskManager.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_RISK_DATA (via {ViewAccessLib})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_RISK_DATA)
     *
     * @return threshold Liquidation threshold (implementation-defined scale; commonly bps)
     */
    function getLiquidationThreshold()
        external
        view
        onlyValidRegistry
        onlyRiskViewerSystem
        returns (uint256 threshold)
    {
        return _rm().getLiquidationThreshold();
    }

    /**
     * @notice Returns the minimum health factor as defined by the RiskManager.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_VIEW_RISK_DATA (via {ViewAccessLib})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (ACTION_VIEW_RISK_DATA)
     *
     * @return minHealthFactor Minimum health factor (implementation-defined scale; commonly bps)
     */
    function getMinHealthFactor()
        external
        view
        onlyValidRegistry
        onlyRiskViewerSystem
        returns (uint256 minHealthFactor)
    {
        return _rm().getMinHealthFactor();
    }

    /**
     * @notice Returns the raw cached health factor and timestamp from HealthView.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized for user (see {onlyRiskViewerFor})
     *      - Registry module resolution fails (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated reads (self or ACTION_VIEW_RISK_DATA)
     * - This function returns the raw cache tuple; it does not enforce the HealthView validity flag
     *
     * @param user Target user address
     * @return healthFactor Cached health factor (implementation-defined scale)
     * @return timestamp Cache timestamp (seconds)
     */
    function getHealthFactorCache(address user)
        external
        view
        onlyValidRegistry
        onlyRiskViewerFor(user)
        returns (uint256 healthFactor, uint256 timestamp)
    {
        (uint256 hf, , uint256 ts) = _hv().getUserHealthFactor(user);
        return (hf, ts);
    }

    /*━━━━━━━━━━━━━━━ View (Registry) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the Registry address (preferred getter name).
     * @dev Reverts if:
     *      - (never; may return address(0) if not initialized)
     *
     * Security:
     * - Read-only
     *
     * @return registry Registry address
     */
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }

    /**
     * @notice Returns the Registry address (legacy getter name).
     * @dev Reverts if:
     *      - (never; may return address(0) if not initialized)
     *
     * Security:
     * - Read-only
     *
     * @return registry Registry address
     */
    function registryAddr() external view returns (address registry) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/
    function _rm() internal view returns (ILiquidationRiskManager) {
        address rm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        return ILiquidationRiskManager(rm);
    }

    function _hv() internal view returns (IHealthViewLite) {
        address hv = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_HEALTH_VIEW);
        return IHealthViewLite(hv);
    }

    /*━━━━━━━━━━━━━━━ UUPS Upgradeable ━━━━━━━━━━━━━━━*/
    /**
     * @notice Authorizes upgrades for the UUPS proxy.
     * @dev Reverts if:
     *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks ACTION_ADMIN (via {ViewAccessLib})
     *      - newImplementation is zero (see {ZeroAddress})
     *      - newImplementation is not a contract (see {NotAContract})
     *
     * Security:
     * - Role-gated upgrades (ACTION_ADMIN)
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Returns the API version of this module.
     * @dev Reverts if:
     *      - (never)
     *
     * Security:
     * - Pure function
     *
     * @return version API version
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Returns the schema version of this module.
     * @dev Reverts if:
     *      - (never)
     *
     * Security:
     * - Pure function
     *
     * @return version Schema version
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    /// @dev Storage gap reserved for future upgrades.
    uint256[50] private __gap;
}

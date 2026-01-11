// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {ILiquidationRiskManager} from "../../../interfaces/ILiquidationRiskManager.sol";
import {LiquidationTypes} from "../types/LiquidationTypes.sol";
import {LiquidationRiskLib} from "../libraries/LiquidationRiskLib.sol";
import {HealthFactorLib} from "../../../libraries/HealthFactorLib.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ZeroAddress} from "../../../errors/StandardErrors.sol";


import {ModuleCache} from "../libraries/ModuleCache.sol";
import {LiquidationRiskQueryLib} from "../libraries/LiquidationRiskQueryLib.sol";
import {Registry} from "../../../registry/Registry.sol";
import {IAccessControlManager} from "../../../interfaces/IAccessControlManager.sol";
import {ICacheRefreshable} from "../../../interfaces/ICacheRefreshable.sol";

/// @dev Minimal interface for the liquidation config module (Option B).
///      IMPORTANT: update paths must preserve original caller role checks.
interface ILiquidationConfigModuleLite {
    function getLiquidationThreshold() external view returns (uint256);
    function getMinHealthFactor() external view returns (uint256);
    function updateLiquidationThresholdFromRiskManager(uint256 newThreshold, address caller) external;
    function updateMinHealthFactorFromRiskManager(uint256 newMinHealthFactor, address caller) external;
}

/// @dev Minimal HealthView interface (read-only cache).
interface IHealthViewLite {
    function getUserHealthFactor(address user) external view returns (uint256 healthFactor, bool isValid);
}

/// @title LiquidationRiskManager - Liquidation Risk Manager
/// @author RWA Lending Platform Team
/// @notice Read-only liquidation risk manager.
/// @dev Provides liquidation threshold, liquidatability checks, and risk scoring aggregation capabilities.
/// @dev Follows architecture guide: risk control is read-only/aggregation, does not participate in write operations
/// @dev Module resolution: dynamically resolves KEY_CM/KEY_LE/KEY_POSITION_VIEW/KEY_HEALTH_VIEW via Registry.
/// @dev Health factor SSOT: reads through HealthView.getUserHealthFactor cache
///      (RiskManager does not directly calculate/push HealthView cache).
/// @dev Oracle/GD: does not access PriceOracle, nor implements Graceful Degradation.
///      Valuation degradation is centralized in VaultLendingEngine.
/// @dev Permissions: governance/upgrade authorization unified through Registry.KEY_ACCESS_CONTROL (ACM).
///      Read interfaces default to no role gate (per Architecture-Guide).
contract LiquidationRiskManager is
    Initializable,
    UUPSUpgradeable,
    ILiquidationRiskManager,
    ICacheRefreshable
{
    // NOTE: keep external/public API minimal; avoid unnecessary using-directives.

    // ============ Custom Errors ============
    /**
     * @notice Unauthorized access attempt.
     * @dev Thrown when caller does not have required permission (e.g., not CacheMaintenanceManager for cache refresh).
     */
    error LiquidationRiskManager__UnauthorizedAccess();
    
    /**
     * @notice Invalid threshold parameter.
     * @dev Thrown when threshold value fails validation (e.g., invalid liquidation threshold or
     *      min health factor < liquidation threshold).
     */
    error LiquidationRiskManager__InvalidThreshold();
    
    /**
     * @notice Invalid batch size.
     * @dev Thrown when batch operation array length exceeds maxBatchSizeVar limit.
     */
    error LiquidationRiskManager__InvalidBatchSize();
    
    /**
     * @notice Required module address is missing in Registry.
     * @param key Module key that was not found in Registry
     */
    error LiquidationRiskManager__MissingModule(bytes32 key);

    // ============ State Variables ============
    /// @notice Liquidation threshold in basis points (bps, 10000 = 100%)
    uint256 public liquidationThresholdVar;
    /// @notice Minimum health factor in basis points (bps, 10000 = 100%)
    uint256 public minHealthFactorVar;
    /// @notice Maximum cache duration in seconds
    uint256 public maxCacheDurationVar;
    /// @notice Maximum batch operation size
    uint256 public maxBatchSizeVar;

    /// @notice Registry address - used for module management and address resolution
    address private _registryAddr;

    /// @notice Module cache - used to cache module addresses, optimizing query performance
    ModuleCache.ModuleCacheStorage private _moduleCache;

    // ============ Events ============
    /**
     * @notice Emitted when a parameter is updated (liquidation threshold or min health factor).
     * @param param Parameter identifier (_PARAM_LIQUIDATION_THRESHOLD or _PARAM_MIN_HEALTH_FACTOR)
     * @param oldValue Previous parameter value (in bps for thresholds/factors)
     * @param newValue New parameter value (in bps for thresholds/factors)
     */
    event ParameterUpdated(bytes32 param, uint256 oldValue, uint256 newValue);

    /**
     * @notice Emitted when minimum health factor is updated.
     * @param oldMinHealthFactor Previous minimum health factor (bps, 10000 = 100%)
     * @param newMinHealthFactor New minimum health factor (bps, 10000 = 100%)
     * @param timestamp Update timestamp (in seconds)
     */
    event MinHealthFactorUpdated(uint256 oldMinHealthFactor, uint256 newMinHealthFactor, uint256 timestamp);

    /**
     * @notice Emitted when module cache is refreshed via maintenance manager.
     * @param caller Caller that performed refresh (should be CacheMaintenanceManager)
     * @param timestamp Refresh timestamp (in seconds)
     */
    event ModuleCacheRefreshed(address indexed caller, uint256 timestamp);

    /// @dev Parameter key: liquidation threshold
    bytes32 private constant _PARAM_LIQUIDATION_THRESHOLD = keccak256("LIQUIDATION_THRESHOLD");
    /// @dev Parameter key: minimum health factor
    bytes32 private constant _PARAM_MIN_HEALTH_FACTOR = keccak256("MIN_HEALTH_FACTOR");

    // ============ Modifiers ============
    /**
     * @notice Role verification modifier.
     * @param role Required role identifier
     */
    modifier onlyRole(bytes32 role) {
        _requireRole(role, msg.sender);
        _;
    }

    // NOTE:
    // LiquidationRiskManager follows the global AccessControlManager (Registry.KEY_ACCESS_CONTROL)
    // for governance/upgrade gating.
    // Read paths remain open (no role gate) per Architecture-Guide.

    

    // ============ Constructor and Initialization ============
    /**
     * @notice Constructor that disables initializers to prevent direct calls.
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the liquidation risk manager contract with Registry and cache parameters.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero address
     *      - Required core modules (KEY_CM, KEY_LE, KEY_HEALTH_VIEW) are missing in Registry (via _primeCoreModules)
     *
     * Security:
     * - Initializer pattern (only callable once)
     * - Preloads core module addresses into cache during initialization
     *
     * @param initialRegistryAddr Registry contract address for module resolution
     * @param initialAccessControl Access control interface address (backward compatible, not validated)
     * @param initialMaxCacheDuration Maximum cache duration in seconds
     * @param initialMaxBatchSize Maximum batch operation size
     */
    function initialize(
        address initialRegistryAddr, 
        address initialAccessControl, 
        uint256 initialMaxCacheDuration, 
        uint256 initialMaxBatchSize
    ) public initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();

        __UUPSUpgradeable_init();

        _registryAddr = initialRegistryAddr;
        // Backward compatible initializer param:
        // Some deployments/tests still pass an "access control" address here.
        // RiskManager sources governance/role checks from Registry.KEY_ACCESS_CONTROL at call-time,
        // so we intentionally do NOT validate or store this parameter.
        initialAccessControl;
        liquidationThresholdVar = LiquidationTypes.DEFAULT_LIQUIDATION_THRESHOLD;
        minHealthFactorVar = LiquidationTypes.DEFAULT_LIQUIDATION_THRESHOLD;
        maxCacheDurationVar = initialMaxCacheDuration;
        maxBatchSizeVar = initialMaxBatchSize;

        // Initialize module cache
        ModuleCache.initialize(_moduleCache, false, address(this));
        _primeCoreModules();
    }

    /**
     * @notice Refresh internal module cache for this contract (unified interface for maintenance manager batch calls).
     * @dev Reverts if:
     *      - KEY_CACHE_MAINTENANCE_MANAGER module is not found in Registry
     *      - caller is not the CacheMaintenanceManager address
     *
     * Security:
     * - Only CacheMaintenanceManager can refresh module caches
     * - Best-effort: missing optional modules in Registry are skipped (no revert)
     */
    function refreshModuleCache() external override {
        _requireCacheMaintainer();
        _refreshModuleCacheBestEffort();
        // Optional migration helper: keep local threshold mirrors aligned to ConfigManager SSOT.
        _syncThresholdMirrorBestEffort();
        // solhint-disable-next-line not-rely-on-time
        emit ModuleCacheRefreshed(msg.sender, block.timestamp);
    }

    /**
     * @notice Require that caller is the CacheMaintenanceManager.
     * @dev Reverts if:
     *      - KEY_CACHE_MAINTENANCE_MANAGER module is not found in Registry
     *      - caller is not the CacheMaintenanceManager address
     */
    function _requireCacheMaintainer() internal view {
        address maint = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_CACHE_MAINTENANCE_MANAGER
        );
        if (msg.sender != maint) revert LiquidationRiskManager__UnauthorizedAccess();
    }

    /**
     * @notice Refresh module cache for core modules (best-effort, never reverts on missing optional modules).
     * @dev Best-effort pattern: optional modules (KEY_POSITION_VIEW, KEY_LIQUIDATION_CONFIG_MANAGER) are skipped
     *      if missing.
     */
    function _refreshModuleCacheBestEffort() internal {
        _tryCacheModule(ModuleKeys.KEY_CM);
        _tryCacheModule(ModuleKeys.KEY_LE);
        _tryCacheModule(ModuleKeys.KEY_POSITION_VIEW); // optional
        _tryCacheModule(ModuleKeys.KEY_HEALTH_VIEW);
        _tryCacheModule(ModuleKeys.KEY_LIQUIDATION_CONFIG_MANAGER); // optional (migration)
    }

    /**
     * @notice Authorize UUPS upgrade (internal override).
     * @dev Reverts if:
     *      - caller does not have ACTION_UPGRADE_MODULE role
     *      - newImplementation is zero address
     *
     * Security:
     * - Role-gated via onlyRole(ActionKeys.ACTION_UPGRADE_MODULE)
     * - Timelock/Multisig governance can be added here if needed
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(address newImplementation)
        internal
        view
        override
        onlyRole(ActionKeys.ACTION_UPGRADE_MODULE)
    {
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // ============ Core Module Resolution (Registry + Cache) ============

    /**
     * @notice Resolve and cache module address from Registry; use cache if valid, otherwise fetch from Registry.
     * @dev Reverts if:
     *      - module is not found in Registry (address(0))
     *
     * Security:
     * - Internal function (no external access)
     * - Updates cache timestamp on successful fetch
     *
     * @param key Module key to resolve
     * @return moduleAddr Resolved module address
     */
    function _resolveModule(bytes32 key) internal returns (address moduleAddr) {
        moduleAddr = _moduleCache.moduleAddresses[key];
        uint256 ts = _moduleCache.cacheTimestamps[key];
        // solhint-disable-next-line not-rely-on-time
        if (moduleAddr != address(0) && ts != 0 && block.timestamp - ts <= maxCacheDurationVar) {
            return moduleAddr;
        }

        moduleAddr = Registry(_registryAddr).getModule(key);
        if (moduleAddr == address(0)) revert LiquidationRiskManager__MissingModule(key);

        _moduleCache.moduleAddresses[key] = moduleAddr;
        // solhint-disable-next-line not-rely-on-time
        _moduleCache.cacheTimestamps[key] = block.timestamp;
        return moduleAddr;
    }

    /**
     * @notice Best-effort cache refresh helper: cache module address if found in Registry, skip silently if missing.
     * @dev Never reverts on missing modules (best-effort pattern).
     *
     * Security:
     * - Internal function (no external access)
     * - Best-effort: missing modules are skipped without error
     *
     * @param key Module key to cache
     */
    function _tryCacheModule(bytes32 key) internal {
        address addr = Registry(_registryAddr).getModule(key);
        if (addr == address(0)) {
            return;
        }
        _moduleCache.moduleAddresses[key] = addr;
        // solhint-disable-next-line not-rely-on-time
        _moduleCache.cacheTimestamps[key] = block.timestamp;
    }

    /**
     * @notice Preload core module addresses into cache (called during initialization).
     * @dev Reverts if:
     *      - Required modules (KEY_CM, KEY_LE, KEY_HEALTH_VIEW) are missing in Registry
     *
     * Security:
     * - Internal function (no external access)
     * - Optional modules (KEY_POSITION_VIEW, KEY_LIQUIDATION_CONFIG_MANAGER) use best-effort caching
     * - Called during initialization to ensure core modules are cached
     */
    function _primeCoreModules() internal {
        _resolveModule(ModuleKeys.KEY_CM);
        _resolveModule(ModuleKeys.KEY_LE);
        _primeOptionalModule(ModuleKeys.KEY_POSITION_VIEW);
        _resolveModule(ModuleKeys.KEY_HEALTH_VIEW);
        _primeOptionalModule(ModuleKeys.KEY_LIQUIDATION_CONFIG_MANAGER); // optional (migration)
    }

    /**
     * @notice Cache optional module address if it exists in Registry (best-effort).
     * @dev Never reverts; silently skips if module is not found in Registry.
     *
     * Security:
     * - Internal function (no external access)
     * - Best-effort: used for modules that may be registered after deployment
     *
     * @param key Module key to cache (if available)
     */
    function _primeOptionalModule(bytes32 key) internal {
        address moduleAddr = Registry(_registryAddr).getModule(key);
        if (moduleAddr == address(0)) {
            return;
        }
        _moduleCache.moduleAddresses[key] = moduleAddr;
        // solhint-disable-next-line not-rely-on-time
        _moduleCache.cacheTimestamps[key] = block.timestamp;
    }

    // ============ Registry Helper Functions (Read-Only) ============

    /**
     * @notice Get Registry contract address (naming follows architecture standard).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only function (no state changes)
     *
     * @return Registry contract address
     */
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    // NOTE: priceOracle / settlementToken getters removed from RiskManager.
    // Oracle health + valuation concerns belong to ValuationOracleView / LendingEngine.

    // ============ Risk Assessment Core Functions ============
    
    /**
     * @notice Check if a user is liquidatable based on current health factor.
     * @dev Reverts if:
     *      - user is zero address
     *      - KEY_HEALTH_VIEW module is not found in Registry (via _getUserHealthFactorFromHealthView)
     *
     * Security:
     * - Read-only view function (no state changes)
     * - Returns false if health factor cache is invalid (safe fallback)
     *
     * @param user User address to check
     * @return True if user is liquidatable (health factor < liquidation threshold), false otherwise
     */
    function isLiquidatable(address user) external view override returns (bool) {
        if (user == address(0)) revert ZeroAddress();
        (uint256 hf, bool valid) = _getUserHealthFactorFromHealthView(user);
        if (!valid) return false; // safe fallback if cache is not valid
        return hf < _getLiquidationThresholdBps();
    }

    /**
     * @notice Check if a user is liquidatable based on provided collateral and debt values.
     * @dev Reverts if:
     *      - user is zero address
     *      - asset is zero address
     *
     * Security:
     * - Read-only view function (no state changes)
     * - Uses `HealthFactorLib.isUnderCollateralized(...)` to avoid division on the hot path
     *
     * @param user User address to check
     * @param collateral Collateral value (same precision as debt)
     * @param debt Debt value (same precision as collateral)
     * @param asset Asset address
     * @return True if user is liquidatable (collateralization below liquidation threshold), false otherwise
     */
    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address asset
    ) external view override returns (bool) {
        if (user == address(0) || asset == address(0)) revert ZeroAddress();
        // Architecture-Guide recommended primary path: avoid division for threshold checks.
        return HealthFactorLib.isUnderCollateralized(collateral, debt, _getLiquidationThresholdBps());
    }

    /**
     * @notice Get liquidation risk score for a user based on current collateral and debt values.
     * @dev Reverts if:
     *      - user is zero address
     *
     * Security:
     * - Read-only view function (no state changes)
     * - Uses module cache for performance optimization
     * - Returns risk score based on (0, 0) if required modules are missing (best-effort, no revert)
     *
     * @param user User address to calculate risk score for
     * @return Risk score from 0 to 100 (0 = lowest risk, 100 = highest risk)
     */
    function getLiquidationRiskScore(address user) external view override returns (uint256) {
        if (user == address(0)) revert ZeroAddress();
        (uint256 collateralValue, uint256 debtValue) = LiquidationRiskQueryLib.getUserValues(
            user,
            _registryAddr,
            _moduleCache,
            maxCacheDurationVar
        );
        return LiquidationRiskLib.calculateLiquidationRiskScore(collateralValue, debtValue);
    }

    /**
     * @notice Calculate liquidation risk score based on collateral and debt values.
     * @dev Reverts if:
     *      - (none, pure function with no external dependencies)
     *
     * Security:
     * - Pure function (no state access, no external calls)
     * - Risk score calculated based on LTV ratio
     *
     * @param collateral Collateral value (same precision as debt)
     * @param debt Debt value (same precision as collateral)
     * @return Risk score from 0 to 100 (0 = lowest risk, 100 = highest risk)
     */
    function calculateLiquidationRiskScore(
        uint256 collateral,
        uint256 debt
    ) public pure override returns (uint256) {
        return LiquidationRiskLib.calculateLiquidationRiskScore(collateral, debt);
    }

    // NOTE: Health factor read path is centralized in HealthView.
    // RiskManager no longer exposes getUserHealthFactor or health-factor cache APIs.

    /**
     * @notice Batch check if multiple users are liquidatable based on their current health factors.
     * @dev Reverts if:
     *      - users array length exceeds maxBatchSizeVar
     *      - KEY_HEALTH_VIEW module is not found in Registry (when processing non-zero addresses)
     *
     * Security:
     * - Read-only view function (no state changes)
     * - Zero addresses in array are skipped (returns false for them)
     * - Uses cached health factors via HealthView for performance
     *
     * @param users Array of user addresses to check
     * @return liquidatable Array of boolean values indicating if each user is liquidatable
     */
    function batchIsLiquidatable(address[] calldata users) external view override returns (bool[] memory liquidatable) {
        uint256 length = users.length;
        if (length > maxBatchSizeVar) revert LiquidationRiskManager__InvalidBatchSize();
        liquidatable = new bool[](length);
        uint256 threshold = _getLiquidationThresholdBps();
        for (uint256 i = 0; i < length;) {
            address u = users[i];
            if (u != address(0)) {
                // reuse cached health factor via HealthView
                (uint256 hf, bool valid) = _getUserHealthFactorFromHealthView(u);
                liquidatable[i] = valid && hf < threshold;
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice Batch get liquidation risk scores for multiple users.
     * @dev Reverts if:
     *      - users array length exceeds maxBatchSizeVar
     *
     * Security:
     * - Read-only view function (no state changes)
     * - Uses module cache for performance optimization
     * - Best-effort: zero-address users return score 0 (skipped)
     *
     * @param users Array of user addresses to calculate risk scores for
     * @return riskScores Array of risk scores from 0 to 100 for each user (0 = lowest risk, 100 = highest risk)
     */
    function batchGetLiquidationRiskScores(address[] calldata users)
        external
        view
        override
        returns (uint256[] memory riskScores)
    {
        uint256 length = users.length;
        if (length > maxBatchSizeVar) revert LiquidationRiskManager__InvalidBatchSize();

        riskScores = new uint256[](length);
        for (uint256 i = 0; i < length;) {
            address u = users[i];
            if (u != address(0)) {
                (uint256 collateralValue, uint256 debtValue) = LiquidationRiskQueryLib.getUserValues(
                    u,
                    _registryAddr,
                    _moduleCache,
                    maxCacheDurationVar
                );
                riskScores[i] = LiquidationRiskLib.calculateLiquidationRiskScore(collateralValue, debtValue);
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice Get comprehensive risk assessment for a user.
     * @dev Reverts if:
     *      - user is zero address
     *      - KEY_HEALTH_VIEW module is not found in Registry (via _getUserHealthFactorFromHealthView)
     *
     * Security:
     * - Read-only view function (no state changes)
     * - Returns healthFactor = 0 if health factor cache is invalid
     * - Returns risk score based on (0, 0) if required modules for getUserValues are missing (best-effort, no revert)
     *
     * @param user User address to assess
     * @return liquidatable True if user is liquidatable (health factor < liquidation threshold)
     * @return riskScore Risk score from 0 to 100 (0 = lowest risk, 100 = highest risk)
     * @return healthFactor Health factor in bps (10000 = 100%, 0 if invalid)
     * @return riskLevel Risk level calculated from health factor
     * @return safetyMargin Safety margin calculated from health factor and threshold (bps)
     */
    function getUserRiskAssessment(
        address user
    ) external view override returns (
        bool liquidatable,
        uint256 riskScore,
        uint256 healthFactor,
        uint256 riskLevel,
        uint256 safetyMargin
    ) {
        if (user == address(0)) revert ZeroAddress();
        
        (uint256 hf, bool valid) = _getUserHealthFactorFromHealthView(user);
        healthFactor = valid ? hf : 0;
        uint256 threshold = _getLiquidationThresholdBps();
        (uint256 collateralValue, uint256 debtValue) = LiquidationRiskQueryLib.getUserValues(
            user,
            _registryAddr,
            _moduleCache,
            maxCacheDurationVar
        );
        riskScore = LiquidationRiskLib.calculateLiquidationRiskScore(collateralValue, debtValue);
        riskLevel = LiquidationTypes.calculateRiskLevel(healthFactor);
        liquidatable = valid && healthFactor < threshold;
        safetyMargin = LiquidationTypes.calculateSafetyMargin(healthFactor, threshold);
    }

    // ============ Threshold Management Functions ============
    
    /**
     * @notice Get the current liquidation threshold.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only function (no state changes)
     * - SSOT migration: prefers `KEY_LIQUIDATION_CONFIG_MANAGER` if available; falls back to `liquidationThresholdVar`
     *
     * @return Liquidation threshold in basis points (bps, 10000 = 100%)
     */
    function getLiquidationThreshold() external view override returns (uint256) {
        return _getLiquidationThresholdBps();
    }

    /**
     * @notice Update the liquidation threshold (governance function).
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *      - newThreshold is invalid (fails LiquidationTypes.isValidLiquidationThreshold check)
     *      - LiquidationConfigManager.updateLiquidationThresholdFromRiskManager reverts (if ConfigManager exists)
     *
     * Security:
     * - Role-gated via onlyRole(ActionKeys.ACTION_SET_PARAMETER)
     * - Syncs with LiquidationConfigManager if available (SSOT migration)
     * - Emits ParameterUpdated event
     * - ConfigManager sync is skipped if module is not found (best-effort pattern)
     *
     * @param newThreshold New liquidation threshold in basis points (bps, 10000 = 100%)
     */
    function updateLiquidationThreshold(uint256 newThreshold)
        external
        override
        onlyRole(ActionKeys.ACTION_SET_PARAMETER)
    {
        if (!LiquidationTypes.isValidLiquidationThreshold(newThreshold)) {
            revert LiquidationRiskManager__InvalidThreshold();
        }

        address cfg = _getModuleViewBestEffort(ModuleKeys.KEY_LIQUIDATION_CONFIG_MANAGER);
        if (cfg != address(0)) {
            ILiquidationConfigModuleLite(cfg).updateLiquidationThresholdFromRiskManager(newThreshold, msg.sender);
        }

        uint256 oldThreshold = liquidationThresholdVar;
        liquidationThresholdVar = newThreshold;
        emit ParameterUpdated(_PARAM_LIQUIDATION_THRESHOLD, oldThreshold, newThreshold);
        // solhint-disable-next-line not-rely-on-time
        emit LiquidationThresholdUpdated(oldThreshold, newThreshold, block.timestamp);
    }

    /**
     * @notice Get the current minimum health factor.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only function (no state changes)
     * - SSOT migration: prefers `KEY_LIQUIDATION_CONFIG_MANAGER` if available; falls back to `minHealthFactorVar`
     *
     * @return Minimum health factor in basis points (bps, 10000 = 100%)
     */
    function getMinHealthFactor() external view override returns (uint256) {
        return _getMinHealthFactorBps();
    }

    /**
     * @notice Update the minimum health factor (governance function).
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *      - newMinHealthFactor is zero
     *      - newMinHealthFactor is less than current liquidation threshold
     *      - LiquidationConfigManager.updateMinHealthFactorFromRiskManager reverts (if ConfigManager exists)
     *
     * Security:
     * - Role-gated via onlyRole(ActionKeys.ACTION_SET_PARAMETER)
     * - Syncs with LiquidationConfigManager if available (SSOT migration)
     * - Emits ParameterUpdated event
     * - ConfigManager sync is skipped if module is not found (best-effort pattern)
     *
     * @param newMinHealthFactor New minimum health factor in basis points (bps, 10000 = 100%)
     */
    function updateMinHealthFactor(uint256 newMinHealthFactor)
        external
        override
        onlyRole(ActionKeys.ACTION_SET_PARAMETER)
    {
        uint256 threshold = _getLiquidationThresholdBps();
        if (newMinHealthFactor == 0 || newMinHealthFactor < threshold) {
            revert LiquidationRiskManager__InvalidThreshold();
        }

        address cfg = _getModuleViewBestEffort(ModuleKeys.KEY_LIQUIDATION_CONFIG_MANAGER);
        if (cfg != address(0)) {
            ILiquidationConfigModuleLite(cfg).updateMinHealthFactorFromRiskManager(newMinHealthFactor, msg.sender);
        }

        uint256 oldFactor = minHealthFactorVar;
        minHealthFactorVar = newMinHealthFactor;
        emit ParameterUpdated(_PARAM_MIN_HEALTH_FACTOR, oldFactor, newMinHealthFactor);
        // solhint-disable-next-line not-rely-on-time
        emit MinHealthFactorUpdated(oldFactor, newMinHealthFactor, block.timestamp);
    }

    // ============ Internal Helper Functions ============
    /// @dev SSOT migration: prefer ConfigManager, fallback to local mirror (deployment transition only).
    function _getLiquidationThresholdBps() internal view returns (uint256 threshold) {
        address cfg = _getModuleViewBestEffort(ModuleKeys.KEY_LIQUIDATION_CONFIG_MANAGER);
        if (cfg != address(0)) {
            try ILiquidationConfigModuleLite(cfg).getLiquidationThreshold() returns (uint256 t) {
                if (t != 0) return t;
            } catch {
                _noop();
            }
        }
        return liquidationThresholdVar;
    }

    /// @dev SSOT migration: prefer ConfigManager, fallback to local mirror (deployment transition only).
    function _getMinHealthFactorBps() internal view returns (uint256 minHf) {
        address cfg = _getModuleViewBestEffort(ModuleKeys.KEY_LIQUIDATION_CONFIG_MANAGER);
        if (cfg != address(0)) {
            try ILiquidationConfigModuleLite(cfg).getMinHealthFactor() returns (uint256 m) {
                if (m != 0) return m;
            } catch {
                _noop();
            }
        }
        return minHealthFactorVar;
    }

    /// @dev Best-effort mirror sync: used by CacheMaintenanceManager to reduce accidental direct reads of `*Var`.
    function _syncThresholdMirrorBestEffort() internal {
        address cfg = _getModuleViewBestEffort(ModuleKeys.KEY_LIQUIDATION_CONFIG_MANAGER);
        if (cfg == address(0)) return;

        // best-effort: do not revert on interface mismatch / missing methods
        try ILiquidationConfigModuleLite(cfg).getLiquidationThreshold() returns (uint256 t) {
            if (t != 0) liquidationThresholdVar = t;
        } catch {
            _noop();
        }

        try ILiquidationConfigModuleLite(cfg).getMinHealthFactor() returns (uint256 m) {
            if (m != 0) minHealthFactorVar = m;
        } catch {
            _noop();
        }
    }

    /**
     * @notice Get user health factor from HealthView module (best-effort cache lookup).
     * @dev Reverts if:
     *      - KEY_HEALTH_VIEW module is not found in Registry (via _getModuleViewBestEffort)
     *
     * Security:
     * - Internal view function (no state changes)
     * - Best-effort: prefers cached module, falls back to Registry if cache is stale
     *
     * @param user User address to get health factor for
     * @return hf Health factor in bps (10000 = 100%)
     * @return valid True if health factor is valid, false if cache is invalid
     */
    function _getUserHealthFactorFromHealthView(address user) internal view returns (uint256 hf, bool valid) {
        // Best-effort: prefer cached module, but if stale try Registry (view-only) to improve availability.
        address hv = _getModuleViewBestEffort(ModuleKeys.KEY_HEALTH_VIEW);
        if (hv == address(0)) revert LiquidationRiskManager__MissingModule(ModuleKeys.KEY_HEALTH_VIEW);
        return IHealthViewLite(hv).getUserHealthFactor(user);
    }

    /**
     * @notice Get module address with best-effort cache lookup (view-only, does not update cache).
     * @dev Never reverts; returns address(0) if module is not found in Registry.
     *
     * Security:
     * - Internal view function (no state changes)
     * - Best-effort: uses cache if valid, falls back to Registry without updating cache
     *
     * @param key Module key to lookup
     * @return moduleAddr Module address (address(0) if not found)
     */
    function _getModuleViewBestEffort(bytes32 key) internal view returns (address moduleAddr) {
        moduleAddr = _moduleCache.moduleAddresses[key];
        uint256 ts = _moduleCache.cacheTimestamps[key];
        if (moduleAddr != address(0) && ts != 0) {
            if (maxCacheDurationVar == 0) return moduleAddr;
            // If time goes backwards, keep cache to avoid underflow and keep availability.
            // solhint-disable-next-line not-rely-on-time
            if (block.timestamp < ts) return moduleAddr;
            // solhint-disable-next-line not-rely-on-time
            if (block.timestamp - ts <= maxCacheDurationVar) return moduleAddr;
        }
        // Cache missing or stale: fall back to Registry without updating cache.
        address fromReg = Registry(_registryAddr).getModule(key);
        return fromReg != address(0) ? fromReg : moduleAddr;
    }

    /**
     * @notice Require that caller has the specified role via AccessControlManager.
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL module is not found in Registry
     *      - caller does not have the required role (via AccessControlManager.requireRole)
     *
     * Security:
     * - Internal view function (no state changes)
     * - Delegates role checking to AccessControlManager
     *
     * @param role Required role identifier
     * @param caller Address to check role for
     */
    function _requireRole(bytes32 role, address caller) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(role, caller);
    }

    /// @dev No-op helper to satisfy solhint `no-empty-blocks` in best-effort try/catch paths.
    function _noop() private pure {
        uint256 unused = 0;
        unused;
    }

    // ============ Storage Gap ============
    // NOTE: Reserved storage space to allow for layout changes in future upgrades.
    uint256[50] private __gap;
} 
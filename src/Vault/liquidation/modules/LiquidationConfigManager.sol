// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {LiquidationAccessControl} from "../libraries/LiquidationAccessControl.sol";
import {ModuleCache} from "../libraries/ModuleCache.sol";
import {LiquidationTypes} from "../types/LiquidationTypes.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {
    ArrayLengthMismatch,
    EmptyArray,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
import {ICacheRefreshable} from "../../../interfaces/ICacheRefreshable.sol";
import {ILiquidationConfigManager} from "../../../interfaces/ILiquidationConfigManager.sol";
import {IAccessControlManager} from "../../../interfaces/IAccessControlManager.sol";
import {Registry} from "../../../registry/Registry.sol";
import {RegistryEvents} from "../../../registry/RegistryEventsLibrary.sol";

/**
 * @title LiquidationConfigManager
 * @notice Provides shared liquidation configuration, module cache, and governance helpers.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - Abstract base contract for liquidation modules.
 * - Resolves dependencies through Registry and gates privileged writes through AccessControlManager.
 * - Supports pause controls and UUPS upgrades with governance-enforced permissions.
 */
abstract contract LiquidationConfigManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ICacheRefreshable,
    ILiquidationConfigManager
{
    using LiquidationAccessControl for LiquidationAccessControl.Storage;

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/

    /// @notice Maximum cache validity period for module addresses (in blocks).
    /// @dev Time-Dependency-Refactor SSOT: cache aging is block-based (block.number).
    uint256 public constant CACHE_MAX_AGE = 7200;

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @notice Registry address (internal storage, following naming conventions)
    /// @dev Used for module address resolution and access control, exposed publicly through registryAddrVar()
    /// @dev Architecture requirement: resolve dependencies through Registry; hardcoding is prohibited
    address internal _registryAddr;

    /// @notice Access control storage
    /// @dev Uses LiquidationAccessControl library for permission management, supports ACM integration
    /// @dev Follows architecture guide: access control is unified through ACM
    LiquidationAccessControl.Storage internal _accessControlStorage;

    /// @notice Module cache storage (internal storage)
    /// @dev Used to cache commonly used module addresses, reducing Registry query overhead and improving performance
    ModuleCache.ModuleCacheStorage internal _moduleCache;

    /// @notice Liquidation bonus rate (in basis points, bps=1e4).
    /// @dev Governance-managed parameter; calculator and other modules should read this instead of duplicating config.
    uint256 public liquidationBonusRateVar;

    /// @notice Liquidation threshold (in basis points, bps=1e4).
    /// @dev Governance-managed parameter; used by calculators/risk modules as a shared reference.
    uint256 public liquidationThresholdVar;

    /// @notice Minimum health factor (in basis points, bps=1e4).
    /// @dev Governance-managed parameter; used as a shared safety bound across risk/settlement flows.
    uint256 public minHealthFactorVar;

    /// @notice Maximum loan-to-value (LTV) in basis points (bps=1e4).
    /// @dev Governance-managed, system-scoped parameter; Preview/risk modules MUST read via SSOT
    ///      (preferably `SystemRiskView.getMaxLtvBps()`).
    uint256 public maxLtvBpsVar;

    /**
     * @notice Get Registry address (naming follows architecture conventions)
     * @return registryAddr Registry contract address
     */
    function registryAddrVar() external view returns (address registryAddr) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when a minimum health factor is zero or lower than the liquidation threshold mirror. Used by min-health-factor governance paths.
    error LiquidationConfigManager__InvalidMinHealthFactor();

    /// @dev Reverts when a maximum LTV value is zero or above 10_000 bps. Used by max-LTV governance paths.
    error LiquidationConfigManager__InvalidMaxLtvBps();

    /// @dev Reverts when a cache refresh is called by an address other than the configured CacheMaintenanceManager. Used by {refreshModuleCache}.
    error LiquidationConfigManager__UnauthorizedAccess();

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when the system is paused.
    /// @dev Emitted by pause flows after the pause state is enabled and recorded for off-chain monitoring.
    event SystemPaused(address indexed pauser, uint256 blockNumber);

    /// @notice Emitted when the system is unpaused.
    /// @dev Emitted by unpause flows after the pause state is cleared.
    event SystemUnpaused(address indexed unpauser, uint256 blockNumber);

    /// @notice Emitted when the minimum health factor is updated.
    /// @dev Emitted by governance-controlled min-health-factor update paths after validation succeeds.
    event MinHealthFactorUpdated(
        uint256 oldMinHealthFactor,
        uint256 newMinHealthFactor,
        uint256 blockNumber
    );

    /// @notice Emitted when the maximum LTV is updated.
    /// @dev Emitted by governance-controlled max-LTV update paths after validation succeeds.
    event MaxLtvBpsUpdated(
        uint256 oldMaxLtvBps,
        uint256 newMaxLtvBps,
        uint256 blockNumber
    );

    /// @notice Emitted when the module cache is refreshed.
    /// @dev Emitted by maintenance-manager refresh flows after the cache refresh completes.
    event ModuleCacheRefreshed(address indexed caller, uint256 blockNumber);

    /*━━━━━━━━━━━━━━━ Constructor ━━━━━━━━━━━━━━━*/

    /**
     * @notice Constructor (disables initialization)
     * @dev Prevents direct calls to initialization function, ensures deployment through proxy pattern
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /**
     * @notice Initialize the liquidation configuration manager
     * @dev Reverts if:
     *      - initialRegistryAddr is zero address
     *      - initialAccessControl is zero address
     *
     * Security:
     * - Initializer modifier ensures single initialization
     * - All addresses are validated to be non-zero
     *
     * @param initialRegistryAddr Registry contract address for module management and address resolution
     * @param initialAccessControl Access control interface address for permission verification
     */
    /// @dev Base initializer. Derived deployable modules may call `_initializeLiquidationConfigManager`.
    function initialize(
        address initialRegistryAddr,
        address initialAccessControl
    ) public virtual initializer {
        _initializeLiquidationConfigManager(
            initialRegistryAddr,
            initialAccessControl
        );
    }

    function _initializeLiquidationConfigManager(
        address initialRegistryAddr,
        address initialAccessControl
    ) internal onlyInitializing {
        if (
            initialRegistryAddr == address(0) ||
            initialAccessControl == address(0)
        ) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        _registryAddr = initialRegistryAddr;
        LiquidationAccessControl.initialize(
            _accessControlStorage,
            initialAccessControl,
            initialAccessControl
        );

        // Initialize module cache:
        // - allow time rollback tolerance for better availability on dev/test chains
        // - disable ModuleCache's internal accessController placeholder checks (this contract enforces roles itself)
        ModuleCache.initialize(_moduleCache, true, address(0));

        // Default liquidation parameters (bps) - can be updated via governance.
        liquidationBonusRateVar = LiquidationTypes.DEFAULT_LIQUIDATION_BONUS;
        liquidationThresholdVar = LiquidationTypes
            .DEFAULT_LIQUIDATION_THRESHOLD;
        minHealthFactorVar = LiquidationTypes.DEFAULT_LIQUIDATION_THRESHOLD;
        maxLtvBpsVar = LiquidationTypes.DEFAULT_MAX_LTV_BPS;

        // Prime commonly-used module cache entries (best-effort).
        _refreshModuleCacheBestEffort();
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    /**
     * @notice Access control modifier
     * @param role Required role (ActionKeys constant)
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL module is not found in Registry
     *      - caller does not have the required role (via AccessControlManager.requireRole)
     *
     * Security:
     * - Role-gated via global AccessControlManager (Registry.KEY_ACCESS_CONTROL)
     * - Aligns with Architecture-Guide: write entrypoints must be gated by ACM
     */
    modifier onlyRole(bytes32 role) {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(role, msg.sender);
        _;
    }

    /*━━━━━━━━━━━━━━━ Registry Module Getter Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get module address from Registry (internal function)
     * @param moduleKey Module key (ModuleKeys constant)
     * @return Module address (reverts if not registered)
     * @dev Architecture requirement: all module addresses are resolved through Registry, hardcoding is prohibited
     */
    function _getModuleFromRegistry(
        bytes32 moduleKey
    ) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /**
     * @notice Check if module is registered in Registry (internal function)
     * @param moduleKey Module key (ModuleKeys constant)
     * @return Whether the module is registered
     * @dev Used to check if module exists, avoiding unnecessary reverts
     */
    function _isModuleRegistered(
        bytes32 moduleKey
    ) internal view returns (bool) {
        return Registry(_registryAddr).isModuleRegistered(moduleKey);
    }

    /*━━━━━━━━━━━━━━━ Module Management Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get module address (from cache).
     * @param moduleKey Module key (ModuleKeys constant)
     * @return moduleAddress Cached module address (best-effort; may be zero if not set)
     */
    function getModule(
        bytes32 moduleKey
    ) public view returns (address moduleAddress) {
        return _getModuleViewBestEffort(moduleKey);
    }

    /**
     * @notice Refresh internal module cache (unified interface for CacheMaintenanceManager batch calls).
     * @dev Reverts if:
     *      - KEY_CACHE_MAINTENANCE_MANAGER module is not found in Registry
     *      - caller is not the CacheMaintenanceManager address
     *
     * Security:
     * - CacheMaintenanceManager-only
     * - Best-effort: missing modules are skipped (no revert)
     */
    function refreshModuleCache() external override {
        address maint = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_CACHE_MAINTENANCE_MANAGER
        );
        if (msg.sender != maint)
            revert LiquidationConfigManager__UnauthorizedAccess();
        _refreshModuleCacheBestEffort();
        emit ModuleCacheRefreshed(msg.sender, block.number);
    }

    /**
     * @notice Update a module cache entry.
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *      - addr is zero address
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param key Module key (ModuleKeys constant)
     * @param addr Module address
     */
    function updateModule(
        bytes32 key,
        address addr
    ) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (addr == address(0)) revert ZeroAddress();
        ModuleCache.set(_moduleCache, key, addr, msg.sender);
    }

    /**
     * @notice Batch update module cache entries.
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *      - keys.length == 0
     *      - keys.length != addresses.length
     *      - any address is zero address
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param keys Array of module keys
     * @param addresses Array of module addresses
     */
    function batchUpdateModules(
        bytes32[] calldata keys,
        address[] calldata addresses
    ) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        uint256 length = keys.length;
        if (length == 0) revert EmptyArray();
        if (length != addresses.length)
            revert ArrayLengthMismatch(length, addresses.length);

        for (uint256 i = 0; i < length; ) {
            if (addresses[i] == address(0)) revert ZeroAddress();
            unchecked {
                ++i;
            }
        }

        ModuleCache.batchSet(_moduleCache, keys, addresses, msg.sender);
    }

    /**
     * @notice Remove a module cache entry.
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param key Module key (ModuleKeys constant)
     */
    function removeModule(
        bytes32 key
    ) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.remove(_moduleCache, key, msg.sender);
    }

    /*━━━━━━━━━━━━━━━ Liquidation Parameter Governance ━━━━━━━━━━━━━━━*/

    /**
     * @notice Update liquidation bonus rate.
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param newRate New bonus rate (bps=1e4)
     */
    function updateLiquidationBonusRate(
        uint256 newRate
    ) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        liquidationBonusRateVar = newRate;
    }

    /**
     * @notice Update liquidation threshold.
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param newThreshold New threshold (bps=1e4)
     */
    function updateLiquidationThreshold(
        uint256 newThreshold
    ) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        liquidationThresholdVar = newThreshold;
    }

    /**
     * @notice Get liquidation bonus rate.
     * @return bonusRate Bonus rate (bps=1e4)
     */
    function getLiquidationBonusRate()
        external
        view
        returns (uint256 bonusRate)
    {
        return liquidationBonusRateVar;
    }

    /**
     * @notice Get liquidation threshold.
     * @return threshold Threshold (bps=1e4)
     */
    function getLiquidationThreshold()
        external
        view
        returns (uint256 threshold)
    {
        return liquidationThresholdVar;
    }

    /**
     * @notice Get minimum health factor.
     * @return minHealthFactor Minimum health factor (bps=1e4)
     */
    function getMinHealthFactor()
        external
        view
        returns (uint256 minHealthFactor)
    {
        return minHealthFactorVar;
    }

    /**
     * @notice Get maximum LTV.
     * @return maxLtvBps Maximum LTV (bps=1e4)
     */
    function getMaxLtvBps() external view returns (uint256 maxLtvBps) {
        return maxLtvBpsVar;
    }

    /**
     * @notice Update minimum health factor.
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *      - newMinHealthFactor is zero
     *      - newMinHealthFactor < liquidationThresholdVar
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param newMinHealthFactor New minimum health factor (bps=1e4)
     */
    function updateMinHealthFactor(
        uint256 newMinHealthFactor
    ) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (
            newMinHealthFactor == 0 ||
            newMinHealthFactor < liquidationThresholdVar
        ) {
            revert LiquidationConfigManager__InvalidMinHealthFactor();
        }
        uint256 old = minHealthFactorVar;
        minHealthFactorVar = newMinHealthFactor;
        emit MinHealthFactorUpdated(old, newMinHealthFactor, block.number);
    }

    /**
     * @notice Update maximum LTV.
     * @dev Reverts if:
     *      - caller does not have ACTION_SET_PARAMETER role
     *      - newMaxLtvBps is zero
     *      - newMaxLtvBps > 10_000 bps
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param newMaxLtvBps New maximum LTV (bps=1e4)
     */
    function updateMaxLtvBps(
        uint256 newMaxLtvBps
    ) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (!LiquidationTypes.isValidMaxLtvBps(newMaxLtvBps)) {
            revert LiquidationConfigManager__InvalidMaxLtvBps();
        }
        uint256 old = maxLtvBpsVar;
        maxLtvBpsVar = newMaxLtvBps;
        emit MaxLtvBpsUpdated(old, newMaxLtvBps, block.number);
    }

    /*━━━━━━━━━━━━━━━ Query Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get cached orchestrator address
     * @return orchestrator Liquidation orchestrator address
     */
    function getCachedOrchestrator()
        external
        view
        returns (address orchestrator)
    {
        return
            _getModuleViewBestEffort(ModuleKeys.KEY_LIQUIDATION_ORCHESTRATOR);
    }

    /**
     * @notice Get cached calculator address
     * @return calculator Liquidation calculator address
     */
    function getCachedCalculator() external view returns (address calculator) {
        return _getModuleViewBestEffort(ModuleKeys.KEY_LIQUIDATION_CALCULATOR);
    }

    /**
     * @notice Get cached risk manager address
     * @return riskManager Liquidation risk manager address
     */
    function getCachedRiskManager()
        external
        view
        returns (address riskManager)
    {
        return
            _getModuleViewBestEffort(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
    }

    /**
     * @notice Get all cached module addresses
     * @return orchestrator Orchestrator address
     * @return calculator Calculator address
     * @return riskManager Risk manager address
     * @return collateralManager Collateral manager address (using KEY_CM)
     * @return debtManager Debt manager address (using KEY_LE)
     */
    function getAllCachedModules()
        external
        view
        returns (
            address orchestrator,
            address calculator,
            address riskManager,
            address collateralManager,
            address debtManager
        )
    {
        return (
            _getModuleViewBestEffort(ModuleKeys.KEY_LIQUIDATION_ORCHESTRATOR),
            _getModuleViewBestEffort(ModuleKeys.KEY_LIQUIDATION_CALCULATOR),
            _getModuleViewBestEffort(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER),
            _getModuleViewBestEffort(ModuleKeys.KEY_CM),
            _getModuleViewBestEffort(ModuleKeys.KEY_LE)
        );
    }

    /*━━━━━━━━━━━━━━━ Emergency Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emergency pause the liquidation system
     * @dev Reverts if:
     *      - caller does not have ACTION_LIQUIDATE role
     *
     * Security:
     * - Role-gated (ACTION_LIQUIDATE)
     * - All liquidation operations will revert after pause, used as emergency safety switch
     */
    function emergencyPause() external onlyRole(ActionKeys.ACTION_LIQUIDATE) {
        _pause();
        emit SystemPaused(msg.sender, block.number);
    }

    /**
     * @notice Emergency unpause the liquidation system
     * @dev Reverts if:
     *      - caller does not have ACTION_LIQUIDATE role
     *
     * Security:
     * - Role-gated (ACTION_LIQUIDATE)
     * - Used in pair with emergencyPause, liquidation operations can execute normally after unpause
     */
    function emergencyUnpause() external onlyRole(ActionKeys.ACTION_LIQUIDATE) {
        _unpause();
        emit SystemUnpaused(msg.sender, block.number);
    }

    /**
     * @notice Check if the system is paused
     * @return paused Whether the system is paused
     */
    function isPaused() external view returns (bool paused) {
        return super.paused();
    }

    /*━━━━━━━━━━━━━━━ Utility Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get access control interface address
     * @return Access control interface address (returns this contract address)
     */
    function getAccessControl() external view returns (address) {
        return address(this);
    }

    /**
     * @notice Check if cache for specified module is valid
     * @param key Module key (ModuleKeys constant)
     * @return Whether the cache is valid (within CACHE_MAX_AGE validity period)
     */
    function isCacheValid(bytes32 key) external view returns (bool) {
        return ModuleCache.isValid(_moduleCache, key, CACHE_MAX_AGE);
    }

    /**
     * @notice Get Vault storage address
     * @return Vault storage address (returns Registry address)
     */
    function getVaultStorage() external view returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ UUPS Upgradeable ━━━━━━━━━━━━━━━*/

    /**
     * @notice UUPS upgrade authorization function
     * @dev Reverts if:
     *      - caller does not have ACTION_UPGRADE_MODULE role
     *      - newImplementation is zero address
     *
     * Security:
     * - Role-gated (ACTION_UPGRADE_MODULE)
     * - Validates new implementation address is non-zero to prevent upgrading to invalid address
     * - Follows UUPS upgrade pattern, supports secure contract upgrades
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /*━━━━━━━━━━━━━━━ Internal Cache Refresh And Best-Effort Resolution ━━━━━━━━━━━━━━━*/

    /// @dev Best-effort: refresh commonly-used module cache entries from Registry.
    function _refreshModuleCacheBestEffort() internal {
        _tryRefreshModule(ModuleKeys.KEY_LIQUIDATION_ORCHESTRATOR);
        _tryRefreshModule(ModuleKeys.KEY_LIQUIDATION_CALCULATOR);
        _tryRefreshModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        _tryRefreshModule(ModuleKeys.KEY_CM);
        _tryRefreshModule(ModuleKeys.KEY_LE);
    }

    /// @dev Best-effort: set cache entry if module exists in Registry; emits ModuleCacheUpdated on address changes.
    function _tryRefreshModule(bytes32 key) internal {
        address addr = Registry(_registryAddr).getModule(key);
        if (addr == address(0)) return;

        address old = _moduleCache.moduleAddresses[key];
        _moduleCache.moduleAddresses[key] = addr;
        _moduleCache.cacheBlocks[key] = block.number;

        if (old != addr) {
            emit RegistryEvents.ModuleCacheUpdated(key, old, addr);
        }
    }

    /// @dev Best-effort cache lookup; falls back to Registry without updating cache.
    function _getModuleViewBestEffort(
        bytes32 key
    ) internal view returns (address moduleAddr) {
        moduleAddr = _moduleCache.moduleAddresses[key];
        uint256 cacheBlock = _moduleCache.cacheBlocks[key];
        if (moduleAddr != address(0) && cacheBlock != 0) {
            // block.number is monotonic; treat cache as valid if within age blocks.
            if (block.number - cacheBlock <= CACHE_MAX_AGE) return moduleAddr;
        }

        address fromReg = Registry(_registryAddr).getModule(key);
        return fromReg != address(0) ? fromReg : moduleAddr;
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    uint256[49] private __gap;
}

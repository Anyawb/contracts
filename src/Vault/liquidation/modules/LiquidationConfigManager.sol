// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import "../libraries/LiquidationValidationLibrary.sol";
import "../libraries/LiquidationEventLibrary.sol";
import "../libraries/LiquidationAccessControl.sol";
import "../libraries/ModuleCache.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ZeroAddress, ArrayLengthMismatch, EmptyArray } from "../../../errors/StandardErrors.sol";
import { ILiquidationConfigManager } from "../../../interfaces/ILiquidationConfigManager.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { Registry } from "../../../registry/Registry.sol";
import { IRegistryUpgradeEvents } from "../../../interfaces/IRegistryUpgradeEvents.sol";

/// @title LiquidationConfigManager
/// @notice Base class for liquidation configuration management: provides common functionality for liquidation modules (module caching, access control, emergency pause)
/// @dev Abstract base class: provides module address caching, Registry integration, access control, emergency pause, and other common capabilities
/// @dev Module positioning: serves as an abstract base class for other liquidation modules to inherit, providing unified configuration management and module access capabilities
/// @dev Design principles:
///     - Module address caching: caches commonly used module addresses through ModuleCache to reduce Registry query overhead
///     - Unified access control: uses LiquidationAccessControl library, unified permission verification through ACM
///     - Registry integration: all module addresses are resolved through Registry, hardcoding is prohibited, compliant with architecture guide requirements
///     - Emergency pause mechanism: provides emergency pause/resume functionality for governance/operations in emergency situations
///     - UUPS upgrade support: supports secure contract upgrades, upgrade permissions controlled through ACTION_UPGRADE_MODULE
/// @dev Integration with liquidation flow:
///     - Subclasses inherit module caching, access control, and other common capabilities
///     - Module addresses are uniformly resolved through Registry to ensure address consistency
///     - Permission verification is unified through ACM to avoid scattered permission logic
/// @dev Naming conventions (following Architecture-Guide.md §852-879):
///     - Private state variables: _ + camelCase (e.g., _registryAddr, _baseStorage, _moduleCache)
///     - Public variables: camelCase + Var (e.g., registryAddrVar)
///     - Constants: UPPER_SNAKE_CASE (e.g., CACHE_MAX_AGE)
///     - Event names: PascalCase, past tense (e.g., SystemPaused, SystemUnpaused)
abstract contract LiquidationConfigManager is 
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationConfigManager,
    IRegistryUpgradeEvents
{
    using LiquidationValidationLibrary for *;
    using LiquidationEventLibrary for *;
    using LiquidationAccessControl for LiquidationAccessControl.Storage;
    using LiquidationBase for *;

    /* ============ Constants ============ */
    
    /// @notice Maximum cache validity period for module addresses (in seconds)
    /// @dev Maximum validity period for module address cache, must be refreshed from Registry after this time
    uint256 public constant CACHE_MAX_AGE = 1 days;

    /* ============ Storage ============ */
    
    /// @notice Registry address (internal storage, following naming conventions)
    /// @dev Used for module address resolution and access control, exposed publicly through registryAddrVar()
    /// @dev Architecture requirement: all business modules resolve dependencies through Registry, hardcoding module addresses is prohibited
    address internal _registryAddr;

    /// @notice Base storage (internal storage)
    /// @dev Contains state required for basic functionality such as access control and cache management
    LiquidationBase.BaseStorage internal _baseStorage;

    /// @notice Access control storage
    /// @dev Uses LiquidationAccessControl library for permission management, supports ACM integration
    /// @dev Follows architecture guide: access control is unified through ACM
    LiquidationAccessControl.Storage internal accessControlStorage;

    /// @notice Module cache storage (internal storage)
    /// @dev Used to cache commonly used module addresses, reducing Registry query overhead and improving performance
    ModuleCache.ModuleCacheStorage internal _moduleCache;

    /// @notice Liquidation bonus rate (in basis points, bps=1e4).
    /// @dev Governance-managed parameter; calculator and other modules should read this instead of duplicating config.
    uint256 public liquidationBonusRateVar;

    /// @notice Liquidation threshold (in basis points, bps=1e4).
    /// @dev Governance-managed parameter; used by calculators/risk modules as a shared reference.
    uint256 public liquidationThresholdVar;

    /**
     * @notice Get Registry address (naming follows architecture conventions)
     * @return registryAddr Registry contract address
     */
    function registryAddrVar() external view returns (address registryAddr) {
        return _registryAddr;
    }

    /* ============ Events ============ */
    
    /**
     * @notice System paused event
     * @param pauser Address that executed the pause
     * @param timestamp Pause timestamp (in seconds)
     * @dev Follows event naming convention: PascalCase, past tense
     * @dev Emitted when the system is emergency paused, for off-chain monitoring and auditing
     */
    event SystemPaused(address indexed pauser, uint256 timestamp);

    /**
     * @notice System unpaused event
     * @param unpauser Address that executed the unpause
     * @param timestamp Unpause timestamp (in seconds)
     * @dev Follows event naming convention: PascalCase, past tense
     * @dev Emitted when the system resumes from paused state, for off-chain monitoring and auditing
     */
    event SystemUnpaused(address indexed unpauser, uint256 timestamp);

    /* ============ Constructor ============ */
    
    /**
     * @notice Constructor (disables initialization)
     * @dev Prevents direct calls to initialization function, ensures deployment through proxy pattern
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    /* ============ Initializer ============ */
    
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
    function initialize(address initialRegistryAddr, address initialAccessControl) external initializer {
        LiquidationValidationLibrary.validateAddress(initialRegistryAddr, "Registry");
        LiquidationValidationLibrary.validateAddress(initialAccessControl, "AccessControl");
        
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        
        _registryAddr = initialRegistryAddr;
        LiquidationAccessControl.initialize(_baseStorage.accessControl, initialAccessControl, initialAccessControl);
        
        // Initialize module cache: disable auto-refresh, cache addresses managed by this contract
        ModuleCache.initialize(_moduleCache, false, address(this));

        // Default liquidation parameters (bps) - can be updated via governance.
        liquidationBonusRateVar = LiquidationTypes.DEFAULT_LIQUIDATION_BONUS;
        liquidationThresholdVar = LiquidationTypes.DEFAULT_LIQUIDATION_THRESHOLD;
    }

    // ============ Modifiers ============
    
    /**
     * @notice Access control modifier
     * @param role Required role (ActionKeys constant)
     * @dev Uses LiquidationAccessControl library for permission verification
     * @dev Follows architecture guide: access control is unified through ACM
     */
    modifier onlyRole(bytes32 role) {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, role, msg.sender);
        _;
    }


    // ============ Registry Module Getter Functions ============
    
    /**
     * @notice Get module address from Registry (internal function)
     * @param moduleKey Module key (ModuleKeys constant)
     * @return Module address (reverts if not registered)
     * @dev Architecture requirement: all module addresses are resolved through Registry, hardcoding is prohibited
     */
    function getModuleFromRegistry(bytes32 moduleKey) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /**
     * @notice Check if module is registered in Registry (internal function)
     * @param moduleKey Module key (ModuleKeys constant)
     * @return Whether the module is registered
     * @dev Used to check if module exists, avoiding unnecessary reverts
     */
    function isModuleRegistered(bytes32 moduleKey) internal view returns (bool) {
        return Registry(_registryAddr).isModuleRegistered(moduleKey);
    }

    /* ============ Module Management Functions ============ */

    /**
     * @notice Get module address (from cache).
     * @param moduleKey Module key (ModuleKeys constant)
     * @return moduleAddress Cached module address (may be zero if not set)
     */
    function getModule(bytes32 moduleKey) public view returns (address moduleAddress) {
        return ModuleCache.get(_moduleCache, moduleKey, CACHE_MAX_AGE);
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
    function updateModule(bytes32 key, address addr) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
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
    function batchUpdateModules(bytes32[] memory keys, address[] memory addresses) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        uint256 length = keys.length;
        if (length == 0) revert EmptyArray();
        if (length != addresses.length) revert ArrayLengthMismatch(length, addresses.length);

        for (uint256 i = 0; i < length;) {
            if (addresses[i] == address(0)) revert ZeroAddress();
            unchecked { ++i; }
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
    function removeModule(bytes32 key) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.remove(_moduleCache, key, msg.sender);
    }

    /* ============ Liquidation Parameter Governance ============ */

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
    function updateLiquidationBonusRate(uint256 newRate) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
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
    function updateLiquidationThreshold(uint256 newThreshold) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        liquidationThresholdVar = newThreshold;
    }

    /**
     * @notice Get liquidation bonus rate.
     * @return bonusRate Bonus rate (bps=1e4)
     */
    function getLiquidationBonusRate() external view returns (uint256 bonusRate) {
        return liquidationBonusRateVar;
    }

    /**
     * @notice Get liquidation threshold.
     * @return threshold Threshold (bps=1e4)
     */
    function getLiquidationThreshold() external view returns (uint256 threshold) {
        return liquidationThresholdVar;
    }

    /* ============ Query Functions ============ */
    
    /**
     * @notice Get cached orchestrator address
     * @return orchestrator Liquidation orchestrator address
     */
    function getCachedOrchestrator() external view returns (address orchestrator) {
        return ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_ORCHESTRATOR, CACHE_MAX_AGE);
    }

    /**
     * @notice Get cached calculator address
     * @return calculator Liquidation calculator address
     */
    function getCachedCalculator() external view returns (address calculator) {
        return ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_CALCULATOR, CACHE_MAX_AGE);
    }

    /**
     * @notice Get cached risk manager address
     * @return riskManager Liquidation risk manager address
     */
    function getCachedRiskManager() external view returns (address riskManager) {
        return ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, CACHE_MAX_AGE);
    }

    /**
     * @notice Get all cached module addresses
     * @return orchestrator Orchestrator address
     * @return calculator Calculator address
     * @return riskManager Risk manager address
     * @return collateralManager Collateral manager address (using KEY_CM)
     * @return debtManager Debt manager address (using KEY_LE)
     */
    function getAllCachedModules() external view returns (
        address orchestrator,
        address calculator,
        address riskManager,
        address collateralManager,
        address debtManager
    ) {
        return (
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_ORCHESTRATOR, CACHE_MAX_AGE),
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_CALCULATOR, CACHE_MAX_AGE),
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, CACHE_MAX_AGE),
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_CM, CACHE_MAX_AGE),
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_LE, CACHE_MAX_AGE)
        );
    }

    /* ============ Emergency Functions ============ */
    
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
        emit SystemPaused(msg.sender, block.timestamp);
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
        emit SystemUnpaused(msg.sender, block.timestamp);
    }

    /**
     * @notice Check if the system is paused
     * @return paused Whether the system is paused
     */
    function isPaused() external view returns (bool paused) {
        return super.paused();
    }

    /* ============ Utility Functions ============ */
    
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

    /* ============ UUPS Upgradeable ============ */
    
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
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        LiquidationBase.validateAddress(newImplementation, "Implementation");
    }
} 
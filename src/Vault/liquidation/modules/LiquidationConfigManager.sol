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
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ILiquidationConfigManager } from "../../../interfaces/ILiquidationConfigManager.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { Registry } from "../../../registry/Registry.sol";
import { IRegistryUpgradeEvents } from "../../../interfaces/IRegistryUpgradeEvents.sol";

/**
 * @title LiquidationConfigManager
 * @dev 清算配置管理器 - 负责配置和模块管理
 * @dev Liquidation Config Manager - Responsible for configuration and module management
 * @dev 提供模块地址缓存、配置更新、紧急暂停等功能
 * @dev Provides module address caching, configuration updates, emergency pause and other functions
 * @dev 支持升级功能，可升级实现合约
 * @dev Supports upgrade functionality, upgradeable implementation contract
 * @dev 使用ReentrancyGuard防止重入攻击
 * @dev Uses ReentrancyGuard to prevent reentrancy attacks
 * @dev 支持暂停功能，紧急情况下可暂停所有操作
 * @dev Supports pause functionality, can pause all operations in emergency situations
 * @dev 优化：使用 LiquidationAccessControl 库进行权限管理
 * @dev Optimized: Using LiquidationAccessControl library for permission management
 * @dev 使用Registry系统进行模块管理
 * @dev Uses Registry system for module management
 */
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
    
    /**
     * 缓存过期时间 - 模块缓存的最大有效期（秒）
     * Cache expiration time - Maximum validity period for module cache (seconds)
     */
    uint256 public constant CACHE_MAX_AGE = 1 days;

    /* ============ Storage ============ */
    
    /// @notice Registry地址 - 用于模块管理
    /// @notice Registry address - For module management
    address private _registryAddr;

    /**
     * 基础存储 - 包含权限控制和缓存管理
     * Base storage - Contains access control and cache management
     */
    LiquidationBase.BaseStorage private _baseStorage;

    /**
     * 权限控制存储 - 使用 LiquidationAccessControl 库
     * Access control storage - Using LiquidationAccessControl library
     */
    LiquidationAccessControl.Storage internal accessControlStorage;

    /**
     * 模块缓存 - 用于缓存模块地址
     * Module cache - Used to cache module addresses
     */
    ModuleCache.ModuleCacheStorage private _moduleCache;

    /* ============ Events ============ */
    
    /**
     * 系统暂停事件 - 当系统被暂停时触发
     * System paused event - Triggered when system is paused
     * @param pauser 暂停者地址 Pauser address
     * @param timestamp 时间戳 Timestamp
     */
    event SystemPaused(address indexed pauser, uint256 timestamp);

    /**
     * 系统恢复事件 - 当系统恢复时触发
     * System unpaused event - Triggered when system is resumed
     * @param unpauser 恢复者地址 Unpauser address
     * @param timestamp 时间戳 Timestamp
     */
    event SystemUnpaused(address indexed unpauser, uint256 timestamp);

    /* ============ Constructor ============ */
    
    constructor() {
        _disableInitializers();
    }

    /* ============ Initializer ============ */
    
    /**
     * 初始化函数 - 设置Registry地址和权限控制接口
     * Initialize function - Set Registry address and access control interface
     * @param initialRegistryAddr Registry合约地址 Registry contract address
     * @param initialAccessControl 权限控制接口地址 Access control interface address
     */
    function initialize(address initialRegistryAddr, address initialAccessControl) external initializer {
        LiquidationValidationLibrary.validateAddress(initialRegistryAddr, "Registry");
        LiquidationValidationLibrary.validateAddress(initialAccessControl, "AccessControl");
        
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        
        _registryAddr = initialRegistryAddr;
        LiquidationAccessControl.initialize(_baseStorage.accessControl, initialAccessControl, initialAccessControl);
        
        // 初始化模块缓存
        ModuleCache.initialize(_moduleCache, false, address(this));
    }

    // ============ 修饰符 ============
    /// @dev 角色验证修饰符
    /// @param role 所需角色
    modifier onlyRole(bytes32 role) {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, role, msg.sender);
        _;
    }

    // ============ Registry 模块获取函数 ============
    
    /// @notice 从Registry获取模块地址
    /// @param moduleKey 模块键值
    /// @return 模块地址
    function getModuleFromRegistry(bytes32 moduleKey) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 检查模块是否在Registry中注册
    /// @param moduleKey 模块键值
    /// @return 是否已注册
    function isModuleRegistered(bytes32 moduleKey) internal view returns (bool) {
        return Registry(_registryAddr).isModuleRegistered(moduleKey);
    }

    /// @notice 安排模块升级
    /// @param moduleKey 模块键值
    /// @param newAddress 新模块地址
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        Registry(_registryAddr).scheduleModuleUpgrade(moduleKey, newAddress);
        
        // 获取当前模块地址用于事件
        address currentAddress = Registry(_registryAddr).getModule(moduleKey);
        (address pendingAddress, uint256 executeAfter, ) = Registry(_registryAddr).getPendingUpgrade(moduleKey);
        
        emit RegistryModuleUpgradeScheduled(moduleKey, currentAddress, pendingAddress, executeAfter);
    }

    /// @notice 执行模块升级
    /// @param moduleKey 模块键值
    function executeModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        address oldAddress = Registry(_registryAddr).getModule(moduleKey);
        Registry(_registryAddr).executeModuleUpgrade(moduleKey);
        address newAddress = Registry(_registryAddr).getModule(moduleKey);
        
        emit RegistryModuleUpgradeExecuted(moduleKey, oldAddress, newAddress);
    }

    /// @notice 取消模块升级
    /// @param moduleKey 模块键值
    function cancelModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        address oldAddress = Registry(_registryAddr).getModule(moduleKey);
        (address pendingAddress, , ) = Registry(_registryAddr).getPendingUpgrade(moduleKey);
        
        Registry(_registryAddr).cancelModuleUpgrade(moduleKey);
        
        emit RegistryModuleUpgradeCancelled(moduleKey, oldAddress, pendingAddress);
    }

    /// @notice 获取待升级信息
    /// @param moduleKey 模块键值
    /// @return newAddress 新地址
    /// @return executeAfter 执行时间
    /// @return hasPending 是否有待升级
    function getPendingUpgrade(bytes32 moduleKey) external view returns (address newAddress, uint256 executeAfter, bool hasPending) {
        return Registry(_registryAddr).getPendingUpgrade(moduleKey);
    }

    /* ============ Module Management Functions ============ */
    
    /**
     * 获取模块地址 - 从缓存中获取模块地址
     * Get module address - Get module address from cache
     * @param moduleKey 模块键值 Module key
     * @return 模块地址 Module address
     */
    function getModule(bytes32 moduleKey) public view returns (address) {
        return ModuleCache.get(_moduleCache, moduleKey, CACHE_MAX_AGE);
    }

    /**
     * 更新模块 - 更新指定模块的缓存地址
     * Update module - Update cached address for specified module
     * @param key 模块键值 Module key
     * @param addr 模块地址 Module address
     */
    function updateModule(bytes32 key, address addr) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.set(_moduleCache, key, addr, msg.sender);
    }

    /**
     * 批量更新模块 - 一次性更新多个模块
     * Batch update modules - Update multiple modules at once
     * @param keys 模块键值数组 Array of module keys
     * @param addresses 模块地址数组 Array of module addresses
     */
    function batchUpdateModules(bytes32[] memory keys, address[] memory addresses) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.batchSet(_moduleCache, keys, addresses, msg.sender);
    }

    /**
     * 移除模块 - 从缓存中移除指定模块
     * Remove module - Remove specified module from cache
     * @param key 模块键值 Module key
     */
    function removeModule(bytes32 key) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.remove(_moduleCache, key, msg.sender);
    }

    /* ============ Query Functions ============ */
    
    /**
     * 获取缓存的协调器地址 - 获取缓存的清算协调器地址
     * Get cached orchestrator address - Get cached liquidation orchestrator address
     * @return orchestrator 协调器地址 Orchestrator address
     */
    function getCachedOrchestrator() external view returns (address orchestrator) {
        return ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_ORCHESTRATOR, CACHE_MAX_AGE);
    }

    /**
     * 获取缓存的计算器地址 - 获取缓存的清算计算器地址
     * Get cached calculator address - Get cached liquidation calculator address
     * @return calculator 计算器地址 Calculator address
     */
    function getCachedCalculator() external view returns (address calculator) {
        return ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_CALCULATOR, CACHE_MAX_AGE);
    }

    /**
     * 获取缓存的奖励分配器地址 - 获取缓存的清算奖励分配器地址
     * Get cached reward distributor address - Get cached liquidation reward distributor address
     * @return rewardDistributor 奖励分配器地址 Reward distributor address
     */
    function getCachedRewardDistributor() external view returns (address rewardDistributor) {
        return ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_REWARD_DISTRIBUTOR, CACHE_MAX_AGE);
    }

    /**
     * 获取缓存的记录管理器地址 - 获取缓存的清算记录管理器地址
     * Get cached record manager address - Get cached liquidation record manager address
     * @return recordManager 记录管理器地址 Record manager address
     */
    function getCachedRecordManager() external view returns (address recordManager) {
        return ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_RECORD_MANAGER, CACHE_MAX_AGE);
    }

    /**
     * 获取缓存的风险管理器地址 - 获取缓存的清算风险管理器地址
     * Get cached risk manager address - Get cached liquidation risk manager address
     * @return riskManager 风险管理器地址 Risk manager address
     */
    function getCachedRiskManager() external view returns (address riskManager) {
        return ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, CACHE_MAX_AGE);
    }

    /**
     * 获取缓存的抵押物管理器地址 - 获取缓存的清算抵押物管理器地址
     * Get cached collateral manager address - Get cached liquidation collateral manager address
     * @return collateralManager 抵押物管理器地址 Collateral manager address
     */
    function getCachedCollateralManager() external view returns (address collateralManager) {
        return ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER, CACHE_MAX_AGE);
    }

    /**
     * 获取缓存的债务管理器地址 - 获取缓存的清算债务管理器地址
     * Get cached debt manager address - Get cached liquidation debt manager address
     * @return debtManager 债务管理器地址 Debt manager address
     */
    function getCachedDebtManager() external view returns (address debtManager) {
        return ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_DEBT_MANAGER, CACHE_MAX_AGE);
    }

    /**
     * 获取所有缓存的模块地址 - 获取所有缓存的清算模块地址
     * Get all cached module addresses - Get all cached liquidation module addresses
     * @return orchestrator 协调器地址 Orchestrator address
     * @return calculator 计算器地址 Calculator address
     * @return rewardDistributor 奖励分配器地址 Reward distributor address
     * @return recordManager 记录管理器地址 Record manager address
     * @return riskManager 风险管理器地址 Risk manager address
     * @return collateralManager 抵押物管理器地址 Collateral manager address
     * @return debtManager 债务管理器地址 Debt manager address
     */
    function getAllCachedModules() external view returns (
        address orchestrator,
        address calculator,
        address rewardDistributor,
        address recordManager,
        address riskManager,
        address collateralManager,
        address debtManager
    ) {
        return (
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_ORCHESTRATOR, CACHE_MAX_AGE),
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_CALCULATOR, CACHE_MAX_AGE),
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_REWARD_DISTRIBUTOR, CACHE_MAX_AGE),
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_RECORD_MANAGER, CACHE_MAX_AGE),
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, CACHE_MAX_AGE),
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER, CACHE_MAX_AGE),
            ModuleCache.get(_moduleCache, ModuleKeys.KEY_LIQUIDATION_DEBT_MANAGER, CACHE_MAX_AGE)
        );
    }

    /* ============ Emergency Functions ============ */
    
    /**
     * 紧急暂停 - 暂停所有操作
     * Emergency pause - Pause all operations
     */
    function emergencyPause() external onlyRole(ActionKeys.ACTION_LIQUIDATE) {
        _pause();
        emit SystemPaused(msg.sender, block.timestamp);
    }

    /**
     * 紧急恢复 - 恢复所有操作
     * Emergency unpause - Resume all operations
     */
    function emergencyUnpause() external onlyRole(ActionKeys.ACTION_LIQUIDATE) {
        _unpause();
        emit SystemUnpaused(msg.sender, block.timestamp);
    }

    /**
     * 检查是否暂停 - 检查系统是否处于暂停状态
     * Check if paused - Check if system is in paused state
     * @return paused 是否暂停 Whether paused
     */
    function isPaused() external view returns (bool paused) {
        return super.paused();
    }

    /* ============ Utility Functions ============ */
    
    /**
     * 获取权限控制接口地址 - 返回权限控制接口地址
     * Get access control interface address - Return access control interface address
     * @return 权限控制接口地址 Access control interface address
     */
    function getAccessControl() external view returns (address) {
        return address(this);
    }

    /**
     * 检查缓存是否有效 - 检查指定模块的缓存是否在有效期内
     * Check if cache is valid - Check if specified module cache is within validity period
     * @param key 模块键值 Module key
     * @return 是否有效 Whether valid
     */
    function isCacheValid(bytes32 key) external view returns (bool) {
        return ModuleCache.isValid(_moduleCache, key, CACHE_MAX_AGE);
    }

    /**
     * 获取Vault存储地址 - 返回Vault存储地址
     * Get Vault storage address - Return Vault storage address
     * @return Vault存储地址 Vault storage address
     */
    function getVaultStorage() external view returns (address) {
        return _registryAddr; // Assuming registry address holds the Vault storage address reference
    }

    /* ============ UUPS Upgradeable ============ */
    
    /**
     * 授权升级 - 检查调用者是否具有升级权限
     * Authorize upgrade - Check if caller has upgrade permission
     * @param newImplementation 新实现地址 New implementation address
     */
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        LiquidationBase.validateAddress(newImplementation, "Implementation");
    }
} 
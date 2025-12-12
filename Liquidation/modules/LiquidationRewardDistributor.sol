// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import "../libraries/LiquidationValidationLibrary.sol";
import "../libraries/LiquidationTokenLibrary.sol";
import "../libraries/LiquidationInterfaceLibrary.sol";
import "../libraries/LiquidationUtilityLibrary.sol";
import "../libraries/ModuleCache.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { VaultTypes } from "../../VaultTypes.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ILiquidationRewardDistributor } from "../../../interfaces/ILiquidationRewardDistributor.sol";
import { IRegistryUpgradeEvents } from "../../../interfaces/IRegistryUpgradeEvents.sol";
import { ILiquidationCollateralManager } from "../../../interfaces/ILiquidationCollateralManager.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { LiquidationAccessControl } from "../libraries/LiquidationAccessControl.sol";
import { Registry } from "../../../registry/Registry.sol";
import { IRegistry } from "../../../interfaces/IRegistry.sol";

/**
 * @title LiquidationRewardDistributor
 * @notice 清算奖励分配器 - 负责清算残值的分配和平台收入管理
 * @notice Liquidation Reward Distributor - Responsible for liquidation residual allocation and platform revenue management
 * @dev 提供残值分配、平台收入管理、风险准备金管理等功能
 * @dev Provides residual allocation, platform revenue management, risk reserve management and other functions
 * @dev 积分奖励功能已移至 LiquidationRewardManager
 * @dev Reward functions have been moved to LiquidationRewardManager
 * @dev 支持升级功能，可升级实现合约
 * @dev Supports upgrade functionality, upgradeable implementation contract
 * @dev 使用ReentrancyGuard防止重入攻击
 * @dev Uses ReentrancyGuard to prevent reentrancy attacks
 * @dev 支持暂停功能，紧急情况下可暂停所有操作
 * @dev Supports pause functionality, can pause all operations in emergency situations
 * @dev 与 ActionKeys 和 ModuleKeys 集成，提供标准化的权限和模块管理
 * @dev Integrates with ActionKeys and ModuleKeys, provides standardized permission and module management
 * @dev 遵循存储结构统一规范，使用标准化的存储布局
 * @dev Follows storage structure unification guidelines, uses standardized storage layout
 * @dev 使用Registry系统进行模块管理
 * @dev Uses Registry system for module management
 * @custom:security-contact security@example.com
 */
abstract contract LiquidationRewardDistributor is 
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationRewardDistributor,
    IRegistryUpgradeEvents
{
    using LiquidationValidationLibrary for *;
    using LiquidationTokenLibrary for *;
    using LiquidationInterfaceLibrary for *;
    using LiquidationUtilityLibrary for *;
    using LiquidationBase for *;
    using LiquidationAccessControl for LiquidationAccessControl.Storage;
    using ModuleCache for ModuleCache.ModuleCacheStorage;

    // ============ 自定义错误 ============
    /// @dev 无效地址错误
    error LiquidationRewardDistributor__InvalidAddress();
    /// @dev 无效参数错误
    error LiquidationRewardDistributor__InvalidParameters();
    /// @dev 外部模块调用失败错误
    error LiquidationRewardDistributor__ExternalModuleCallFailed();
    /// @dev 权限不足错误
    error LiquidationRewardDistributor__InsufficientPermission();
    /// @dev Registry未初始化错误
    error LiquidationRewardDistributor__RegistryNotInitialized();

    /* ============ Constants ============ */
    /// @notice 缓存最大有效期（秒）
    /// @notice Maximum cache validity period (seconds)
    uint256 public constant CACHE_MAX_AGE = 1 days;

    /* ============ Storage ============ */
    
    /// @notice Registry地址 - 用于模块管理
    /// @notice Registry address - For module management
    address private _registryAddr;

    /// @notice 基础存储 - 所有模块共享
    /// @notice Base storage - Shared by all modules
    LiquidationBase.BaseStorage private _baseStorage;

    /// @notice 模块缓存 - 用于缓存模块地址
    /// @notice Module cache - For caching module addresses
    ModuleCache.ModuleCacheStorage private _moduleCache;

    /// @notice 平台收入接收地址
    /// @notice Platform revenue receiver address
    address public platformRevenueReceiverAddr;

    /// @notice 风险准备金池地址
    /// @notice Risk reserve pool address
    address public riskReservePoolAddr;

    /// @notice 出借人补偿池地址
    /// @notice Lender compensation pool address
    address public lenderCompensationPoolAddr;

    /* ============ Events ============ */
    /// @notice 平台收入接收者更新事件
    event PlatformRevenueReceiverUpdated(address indexed oldReceiver, address indexed newReceiver, uint256 timestamp);
    
    /// @notice 风险准备金池更新事件
    event RiskReservePoolUpdated(address indexed oldPool, address indexed newPool, uint256 timestamp);
    
    /// @notice 出借人补偿池更新事件
    event LenderCompensationPoolUpdated(address indexed oldPool, address indexed newPool, uint256 timestamp);

    // Registry升级相关事件已在 IRegistryUpgradeEvents 接口中定义

    /* ============ Constructor ============ */
    /// @dev 禁用实现合约的初始化器，防止直接调用
    /// @dev Disable initializer for implementation contract to prevent direct calls
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

    /// @dev 地址验证修饰符
    /// @dev Address validation modifier
    modifier validAddress(address addr) {
        if (addr == address(0)) revert LiquidationRewardDistributor__InvalidAddress();
        _;
    }

    /// @dev Registry验证修饰符
    /// @dev Registry validation modifier
    modifier registryInitialized() {
        if (_registryAddr == address(0)) revert LiquidationRewardDistributor__RegistryNotInitialized();
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
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) registryInitialized {
        Registry(_registryAddr).scheduleModuleUpgrade(moduleKey, newAddress);
        
        // 获取当前模块地址用于事件
        address currentAddress = Registry(_registryAddr).getModule(moduleKey);
        (address pendingAddress, uint256 executeAfter, ) = Registry(_registryAddr).getPendingUpgrade(moduleKey);
        
        emit RegistryModuleUpgradeScheduled(moduleKey, currentAddress, pendingAddress, executeAfter);
    }

    /// @notice 执行模块升级
    /// @param moduleKey 模块键值
    function executeModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) registryInitialized {
        address oldAddress = Registry(_registryAddr).getModule(moduleKey);
        Registry(_registryAddr).executeModuleUpgrade(moduleKey);
        address newAddress = Registry(_registryAddr).getModule(moduleKey);
        
        emit RegistryModuleUpgradeExecuted(moduleKey, oldAddress, newAddress);
    }

    /// @notice 取消模块升级
    /// @param moduleKey 模块键值
    function cancelModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) registryInitialized {
        Registry(_registryAddr).cancelModuleUpgrade(moduleKey);
    }

    // ============ 内部函数 ============
    
    /**
     * @notice 获取缓存的模块地址 - 从缓存中获取模块地址，如果缓存失效则从Registry获取
     * @notice Get cached module address - Get module address from cache, fallback to Registry if cache expired
     * @param moduleKey 模块键值，用于标识特定模块 Module key to identify specific module
     * @return 模块地址，如果未找到则返回零地址 Module address, returns zero address if not found
     * @dev 优先从缓存获取以提高性能，缓存失效时从 Registry 获取最新地址
     * @dev Prioritizes cache for performance, falls back to Registry for latest address when cache expires
     */
    function _getCachedModule(bytes32 moduleKey) internal view returns (address) {
        // 尝试从缓存获取模块地址，使用最大缓存有效期
        // Try to get module address from cache using maximum cache age
        address moduleAddr = ModuleCache.get(_moduleCache, moduleKey, CACHE_MAX_AGE);
        if (moduleAddr != address(0)) {
            return moduleAddr;
        }
        // 如果缓存失败或地址为零，直接从 Registry 获取最新地址
        // If cache fails or address is zero, get latest address directly from Registry
        return getModuleFromRegistry(moduleKey);
    }

    /**
     * @notice 初始化模块缓存系统 - 设置访问控制器并更新模块缓存
     * @notice Initialize module cache system - Set access controller and update module cache
     * @dev 在合约初始化时调用，建立模块缓存的基础设施
     * @dev Called during contract initialization to establish module cache infrastructure
     * @dev 设置当前合约作为缓存访问控制器，确保缓存操作的安全性
     * @dev Sets current contract as cache access controller to ensure cache operation security
     */
    function _initializeModuleCacheSystem() internal {
        // 设置当前合约作为模块缓存的访问控制器
        // Set current contract as access controller for module cache
        ModuleCache.setAccessController(_moduleCache, address(this), address(this));
        
        // 更新关键模块缓存，包括清算抵押物管理器
        // Update key module cache, including liquidation collateral manager
        _updateModuleCache();
    }

    /**
     * @notice 更新模块缓存 - 从 Registry 获取最新模块地址并更新缓存
     * @notice Update module cache - Get latest module addresses from Registry and update cache
     * @dev 更新清算抵押物管理器的缓存地址
     * @dev Updates cached addresses for liquidation collateral manager
     * @dev 如果 Registry 未初始化或模块地址无效，则跳过更新
     * @dev Skips update if Registry is not initialized or module addresses are invalid
     */
    function _updateModuleCache() internal {
        // 检查Registry是否已初始化
        // Check if Registry is initialized
        if (_registryAddr == address(0)) return;

        // 更新清算抵押物管理器缓存地址
        // Update liquidation collateral manager cache address
        address collateralManager = getModuleFromRegistry(ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER);
        if (collateralManager != address(0)) {
            // 将有效的清算抵押物管理器地址存储到缓存中
            // Store valid liquidation collateral manager address in cache
            ModuleCache.set(_moduleCache, ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER, collateralManager, msg.sender);
        }
    }

    /* ============ Reward Distribution Functions ============ */
    
    /**
     * @notice 分配清算残值 - 将清算后的残值按比例分配给不同接收方
     * @notice Distribute residual value - Allocate liquidation residual value to different recipients
     * @param collateralAsset 抵押资产地址，清算的抵押品类型 Collateral asset address, type of liquidated collateral
     * @param allocation 残值分配结构，包含平台收入、风险准备金、出借人补偿等分配比例
     * @param allocation Residual allocation structure containing platform revenue, risk reserve, lender compensation ratios
     * @dev 只有在合约未暂停时才能执行分配操作
     * @dev Distribution can only be executed when contract is not paused
     * @dev 如果清算抵押物管理器未配置，则跳过分配操作
     * @dev Skips distribution if liquidation collateral manager is not configured
     * @dev 每个分配项只有在金额大于0且接收地址有效时才执行转账
     * @dev Each allocation item is only executed when amount > 0 and recipient address is valid
     */
    function distributeResidualValue(
        address collateralAsset,
        LiquidationTypes.ResidualAllocation memory allocation
    ) external override whenNotPaused registryInitialized {
        // 验证抵押资产地址的有效性
        // Validate collateral asset address
        LiquidationValidationLibrary.validateAddress(collateralAsset, "CollateralAsset");
        
        // 获取清算抵押物管理器地址，如果未配置则直接返回
        // Get liquidation collateral manager address, return if not configured
        address collateralManager = _getCachedModule(ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER);
        if (collateralManager == address(0)) return;

        // 分配平台收入 - 将平台收入部分转移给平台收入接收者
        // Distribute platform revenue - Transfer platform revenue portion to platform revenue receiver
        if (allocation.platformRevenue > 0 && platformRevenueReceiverAddr != address(0)) {
            ILiquidationCollateralManager(collateralManager).transferLiquidationCollateral(
                collateralAsset, allocation.platformRevenue, platformRevenueReceiverAddr
            );
        }

        // 分配风险准备金 - 将风险准备金部分转移给风险准备金池
        // Distribute risk reserve - Transfer risk reserve portion to risk reserve pool
        if (allocation.riskReserve > 0 && riskReservePoolAddr != address(0)) {
            ILiquidationCollateralManager(collateralManager).transferLiquidationCollateral(
                collateralAsset, allocation.riskReserve, riskReservePoolAddr
            );
        }

        // 分配出借人补偿 - 将出借人补偿部分转移给出借人补偿池
        // Distribute lender compensation - Transfer lender compensation portion to lender compensation pool
        if (allocation.lenderCompensation > 0 && lenderCompensationPoolAddr != address(0)) {
            ILiquidationCollateralManager(collateralManager).transferLiquidationCollateral(
                collateralAsset, allocation.lenderCompensation, lenderCompensationPoolAddr
            );
        }
    }

    /* ============ Admin Functions ============ */
    
    /**
     * @notice 更新平台收入接收者地址 - 设置新的平台收入接收地址
     * @notice Update platform revenue receiver - Set new platform revenue receiver address
     * @param newReceiver 新的平台收入接收者地址 New platform revenue receiver address
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     * @dev 触发平台收入接收者更新事件，记录地址变更
     * @dev Emits platform revenue receiver updated event to record address change
     */
    function updatePlatformRevenueReceiver(address newReceiver) external override whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        // 保存旧的接收者地址用于事件记录
        // Save old receiver address for event recording
        address oldReceiver = platformRevenueReceiverAddr;
        
        // 更新平台收入接收者地址
        // Update platform revenue receiver address
        platformRevenueReceiverAddr = newReceiver;
        
        // 触发平台收入接收者更新事件
        // Emit platform revenue receiver updated event
        emit PlatformRevenueReceiverUpdated(oldReceiver, newReceiver, block.timestamp);
    }

    /**
     * @notice 更新风险准备金池地址 - 设置新的风险准备金池地址
     * @notice Update risk reserve pool - Set new risk reserve pool address
     * @param newPool 新的风险准备金池地址 New risk reserve pool address
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     * @dev 触发风险准备金池更新事件，记录地址变更
     * @dev Emits risk reserve pool updated event to record address change
     */
    function updateRiskReservePool(address newPool) external override whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        // 保存旧的风险准备金池地址用于事件记录
        // Save old risk reserve pool address for event recording
        address oldPool = riskReservePoolAddr;
        
        // 更新风险准备金池地址
        // Update risk reserve pool address
        riskReservePoolAddr = newPool;
        
        // 触发风险准备金池更新事件
        // Emit risk reserve pool updated event
        emit RiskReservePoolUpdated(oldPool, newPool, block.timestamp);
    }

    /**
     * @notice 更新出借人补偿池地址 - 设置新的出借人补偿池地址
     * @notice Update lender compensation pool - Set new lender compensation pool address
     * @param newPool 新的出借人补偿池地址 New lender compensation pool address
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     * @dev 触发出借人补偿池更新事件，记录地址变更
     * @dev Emits lender compensation pool updated event to record address change
     */
    function updateLenderCompensationPool(address newPool) external override whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        // 保存旧的出借人补偿池地址用于事件记录
        // Save old lender compensation pool address for event recording
        address oldPool = lenderCompensationPoolAddr;
        
        // 更新出借人补偿池地址
        // Update lender compensation pool address
        lenderCompensationPoolAddr = newPool;
        
        // 触发出借人补偿池更新事件
        // Emit lender compensation pool updated event
        emit LenderCompensationPoolUpdated(oldPool, newPool, block.timestamp);
    }

    /* ============ Query Functions ============ */
    
    /**
     * @notice 获取平台收入接收者地址 - 查询当前平台收入接收者地址
     * @notice Get platform revenue receiver - Query current platform revenue receiver address
     * @return 平台收入接收者地址，如果未设置则返回零地址 Platform revenue receiver address, returns zero address if not set
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getPlatformRevenueReceiver() external view override returns (address) {
        return platformRevenueReceiverAddr;
    }

    /**
     * @notice 获取风险准备金池地址 - 查询当前风险准备金池地址
     * @notice Get risk reserve pool - Query current risk reserve pool address
     * @return 风险准备金池地址，如果未设置则返回零地址 Risk reserve pool address, returns zero address if not set
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getRiskReservePool() external view override returns (address) {
        return riskReservePoolAddr;
    }

    /**
     * @notice 获取出借人补偿池地址 - 查询当前出借人补偿池地址
     * @notice Get lender compensation pool - Query current lender compensation pool address
     * @return 出借人补偿池地址，如果未设置则返回零地址 Lender compensation pool address, returns zero address if not set
     * @dev 这是一个只读查询函数，不修改合约状态
     * @dev This is a read-only query function that does not modify contract state
     */
    function getLenderCompensationPool() external view override returns (address) {
        return lenderCompensationPoolAddr;
    }

    /* ============ Module Management Functions ============ */
    
    /**
     * @notice 获取模块地址 - 从 Registry 获取指定模块的地址
     * @notice Get module address - Get address of specified module from Registry
     * @param moduleKey 模块键值，用于标识特定模块 Module key to identify specific module
     * @return 模块地址，如果未找到则返回零地址 Module address, returns zero address if not found
     * @dev 直接从 Registry 获取最新地址，不经过缓存
     * @dev Gets latest address directly from Registry, bypassing cache
     */
    function getModule(bytes32 moduleKey) public view override returns (address) {
        if (_registryAddr == address(0)) return address(0);
        return Registry(_registryAddr).getModule(moduleKey);
    }

    /**
     * @notice 更新缓存的模块地址 - 强制更新所有缓存的模块地址
     * @notice Update cached module addresses - Force update all cached module addresses
     * @dev 只有具有设置参数权限的角色才能调用此函数
     * @dev Only roles with parameter setting permission can call this function
     * @dev 在合约未暂停时才能执行更新操作
     * @dev Can only execute update when contract is not paused
     * @dev 调用内部函数更新清算抵押物管理器的缓存地址
     * @dev Calls internal function to update cached addresses for liquidation collateral manager
     */
    function updateCachedModuleAddresses() external override whenNotPaused onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        _updateModuleCache();
    }

    /**
     * @notice 获取缓存的清算抵押物管理器地址 - 从缓存中获取清算抵押物管理器地址
     * @notice Get cached liquidation collateral manager - Get liquidation collateral manager address from cache
     * @return 清算抵押物管理器地址，如果缓存失效则从Registry获取 Liquidation collateral manager address, falls back to Registry if cache expired
     * @dev 优先从缓存获取以提高性能，缓存失效时从 Registry 获取最新地址
     * @dev Prioritizes cache for performance, falls back to Registry for latest address when cache expires
     */
    function getCachedCollateralManager() external view override returns (address) { 
        return _getCachedModule(ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER); 
    }

    /* ============ Getter Functions ============ */
    
    /**
     * @notice 获取基础存储信息 - 查询合约的基础配置信息
     * @notice Get base storage - Query contract's basic configuration information
     * @return priceOracle 价格预言机地址，用于获取资产价格 Price oracle address for asset pricing
     * @return settlementToken 结算币地址，用于债务结算的币种 Settlement token address for debt settlement
     * @return registry Registry地址，用于模块地址管理 Registry address for module address management
     * @return acm 权限控制管理器地址，用于权限验证 Access control manager address for permission validation
     * @dev 这是一个只读查询函数，返回合约的核心配置信息
     * @dev This is a read-only query function that returns contract's core configuration information
     */
    function getBaseStorage() external view returns (address priceOracle, address settlementToken, address registry, address acm) {
        return (_baseStorage.priceOracleAddr, _baseStorage.settlementTokenAddr, _registryAddr, address(this));
    }

    /**
     * @notice 获取模块缓存信息 - 从缓存中获取指定模块的地址
     * @notice Get cached module - Get address of specified module from cache
     * @param moduleKey 模块键值，用于标识特定模块 Module key to identify specific module
     * @return moduleAddress 模块地址，如果缓存失效则返回零地址 Module address, returns zero address if cache expired
     * @dev 这是一个只读查询函数，优先从缓存获取以提高性能
     * @dev This is a read-only query function that prioritizes cache for performance
     * @dev 使用最大缓存有效期进行查询，确保缓存数据的时效性
     * @dev Uses maximum cache age for query to ensure cache data timeliness
     */
    function getCachedModule(bytes32 moduleKey) external view returns (address moduleAddress) {
        return ModuleCache.get(_moduleCache, moduleKey, CACHE_MAX_AGE);
    }

    /**
     * @notice 获取价格预言机地址 - 查询当前价格预言机地址
     * @notice Get price oracle - Query current price oracle address
     * @return priceOracle 价格预言机地址，用于获取资产价格 Price oracle address for asset pricing
     * @dev 这是一个只读查询函数，返回价格预言机地址
     * @dev This is a read-only query function that returns price oracle address
     */
    function getPriceOracle() external view returns (address priceOracle) {
        return _baseStorage.priceOracleAddr;
    }

    /**
     * @notice 获取结算币地址 - 查询当前结算币地址
     * @notice Get settlement token - Query current settlement token address
     * @return settlementToken 结算币地址，用于债务结算的币种 Settlement token address for debt settlement
     * @dev 这是一个只读查询函数，返回结算币地址
     * @dev This is a read-only query function that returns settlement token address
     */
    function getSettlementToken() external view returns (address settlementToken) {
        return _baseStorage.settlementTokenAddr;
    }

    /**
     * @notice 获取Registry地址 - 查询当前Registry地址
     * @notice Get Registry address - Query current Registry address
     * @return registry Registry地址，用于模块地址管理 Registry address for module address management
     * @dev 这是一个只读查询函数，返回Registry地址
     * @dev This is a read-only query function that returns Registry address
     */
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }

    /**
     * @notice 获取权限控制管理器地址 - 查询当前权限控制管理器地址
     * @notice Get access control manager - Query current access control manager address
     * @return acm 权限控制管理器地址，用于权限验证 Access control manager address for permission validation
     * @dev 这是一个只读查询函数，返回当前合约地址作为权限控制管理器
     * @dev This is a read-only query function that returns current contract address as access control manager
     */
    function getAccessControlManager() external view returns (address acm) {
        return address(this);
    }

    /* ============ UUPS Upgradeable ============ */
    
    /**
     * @notice 授权升级函数 - 验证升级权限并检查新实现合约地址
     * @notice Authorize upgrade - Validate upgrade permission and check new implementation address
     * @param newImplementation 新实现合约地址，用于升级当前合约 New implementation contract address for upgrading current contract
     * @dev 只有具有升级模块权限的角色才能调用此函数
     * @dev Only roles with module upgrade permission can call this function
     * @dev 验证新实现合约地址的有效性，确保升级安全性
     * @dev Validates new implementation contract address to ensure upgrade security
     * @dev 这是 UUPS 升级模式的核心安全机制
     * @dev This is the core security mechanism for UUPS upgrade pattern
     */
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        // 验证新实现合约地址的有效性
        // Validate new implementation contract address
        LiquidationBase.validateAddress(newImplementation, "Implementation");
    }
} 
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
// Removed Pausable/Reentrancy to reduce bytecode size

import {ILiquidationRiskManager} from "../../../interfaces/ILiquidationRiskManager.sol";
import {LiquidationAccessControl} from "../libraries/LiquidationAccessControl.sol";
import {LiquidationTypes} from "../types/LiquidationTypes.sol";
import {LiquidationBase} from "../types/LiquidationBase.sol";
import {LiquidationRiskLib} from "../libraries/LiquidationRiskLib.sol";

/// @dev 轻量接口，调用 HealthView.pushRiskStatusBatch，避免循环依赖（需顶层声明）
 
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {ZeroAddress} from "../../../errors/StandardErrors.sol";
 

import {ModuleCache} from "../libraries/ModuleCache.sol";
import {LiquidationViewLibrary} from "../libraries/LiquidationViewLibrary.sol";
import {LiquidationRiskQueryLib} from "../libraries/LiquidationRiskQueryLib.sol";
import {LiquidationRiskBatchLib} from "../libraries/LiquidationRiskBatchLib.sol";
import {LiquidationRiskCacheLib} from "../libraries/LiquidationRiskCacheLib.sol";

/// @title LiquidationRiskManager - 清算风险管理器
/// @author RWA Lending Platform Team
/// @notice 管理用户清算风险评估、健康因子计算和缓存管理
/// @dev 提供风险评估、批量查询、预览功能和缓存优化
/// @dev 支持模块化架构，通过 Registry 获取模块地址
/// @dev 使用自定义错误和事件聚合优化 Gas 效率
/// @dev 使用Registry系统进行模块管理和升级流程
/// @dev Uses Registry system for module management and upgrade flow
contract LiquidationRiskManager is
    Initializable,
    UUPSUpgradeable,
    ILiquidationRiskManager
{
    using LiquidationBase for *;
    using ModuleCache for ModuleCache.ModuleCacheStorage;

    // ============ 自定义错误 ============
    /// @dev 未授权访问错误
    error LiquidationRiskManager__UnauthorizedAccess();
    /// @dev 批量操作长度无效错误
    error LiquidationRiskManager__InvalidBatchLength();
    /// @dev 模块地址无效错误
    error LiquidationRiskManager__InvalidModuleAddress();
    /// @dev 阈值参数无效错误
    error LiquidationRiskManager__InvalidThreshold();
    /// @dev 健康因子计算失败错误
    error LiquidationRiskManager__HealthFactorCalculationFailed();
    /// @dev 模块调用失败错误
    error LiquidationRiskManager__ModuleCallFailed();
    /// @dev 返回数据不足错误
    error LiquidationRiskManager__InsufficientReturnData();
    /// @dev 批量大小无效错误
    error LiquidationRiskManager__InvalidBatchSize();
    /// @dev Registry未初始化错误
    error LiquidationRiskManager__RegistryNotInitialized();
    /// @dev 升级未准备就绪错误
    error LiquidationRiskManager__UpgradeNotReady();
    /// @dev 升级已计划错误
    error LiquidationRiskManager__UpgradeAlreadyScheduled();

    // ============ 数据结构 ============
    // 使用 LiquidationCacheLibrary.CacheEntry 替代本地定义

    

    // ============ 常量与状态变量 ============
    /// @notice 健康因子清算阈值（100%）
    uint256 public constant HEALTH_FACTOR_LIQUIDATION_THRESHOLD = 1e18;
    /// @notice 清算阈值（基点）
    uint256 public liquidationThresholdVar;
    /// @notice 最小健康因子（基点）
    uint256 public minHealthFactorVar;
    /// @notice 最大缓存持续时间（秒）
    uint256 public maxCacheDurationVar;
    /// @notice 最大批量操作大小
    uint256 public maxBatchSizeVar;

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
     * 模块缓存 - 用于缓存模块地址
     * Module cache - Used to cache module addresses
     */
    ModuleCache.ModuleCacheStorage private _moduleCache;

    /**
     * 清算积分存储 - 包含清算积分相关配置
     * Liquidation reward storage - Contains liquidation reward configuration
     */
    LiquidationBase.LiquidationRewardStorage internal liquidationRewardStorage;

    /// @dev 用户健康因子缓存映射
    mapping(address => uint256) private _healthFactorCache;

    // ============ 事件定义 ============
    /// @notice 健康因子事件（聚合事件）
    /// @param user 用户地址
    /// @param value 健康因子值
    /// @param status 状态标签（updated/anomaly/expired）
    /// @param timestamp 时间戳
    // status: 1=updated, 2=anomaly, 3=expired
    event HealthFactorEvent(address indexed user, uint256 value, uint8 status, uint256 timestamp);
    /// @notice 参数更新事件
    /// @param param 参数名称
    /// @param oldValue 旧值
    /// @param newValue 新值
    event ParameterUpdated(bytes32 param, uint256 oldValue, uint256 newValue);
    
    

    

    // ============ 修饰符 ============
    /// @dev 角色验证修饰符
    /// @param role 所需角色
    modifier onlyRole(bytes32 role) {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, role, msg.sender);
        _;
    }

    // ============ 状态常量 ============
    uint8 private constant HEALTH_STATUS_UPDATED = 1;
    uint8 private constant HEALTH_STATUS_ANOMALY = 2;

    bytes32 private constant PARAM_LIQUIDATION_THRESHOLD = keccak256("liquidationThreshold");
    bytes32 private constant PARAM_MIN_HEALTH_FACTOR = keccak256("minHealthFactor");
    bytes32 private constant PARAM_MAX_CACHE_DURATION = keccak256("maxCacheDuration");
    bytes32 private constant PARAM_MAX_BATCH_SIZE = keccak256("maxBatchSize");

    /// @dev 管理员权限验证修饰符
    modifier onlyAdmin() {
        LiquidationAccessControl.requireRole(_baseStorage.accessControl, ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _;
    }

    

    // ============ 构造函数与初始化 ============
    /// @dev 构造函数，禁用初始化器
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry合约地址
    /// @param initialAccessControl 权限控制接口地址
    /// @param initialMaxCacheDuration 最大缓存持续时间
    /// @param initialMaxBatchSize 最大批量操作大小
    /// @dev 设置初始参数并缓存模块地址
    function initialize(
        address initialRegistryAddr, 
        address initialAccessControl, 
        uint256 initialMaxCacheDuration, 
        uint256 initialMaxBatchSize
    ) public initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialAccessControl == address(0)) revert ZeroAddress();

        __UUPSUpgradeable_init();

        _registryAddr = initialRegistryAddr;
        LiquidationAccessControl.initialize(_baseStorage.accessControl, initialAccessControl, initialAccessControl);
        liquidationThresholdVar = LiquidationTypes.DEFAULT_LIQUIDATION_THRESHOLD;
        minHealthFactorVar = LiquidationTypes.DEFAULT_LIQUIDATION_THRESHOLD;
        maxCacheDurationVar = initialMaxCacheDuration;
        maxBatchSizeVar = initialMaxBatchSize;

        // 初始化模块缓存
        ModuleCache.initialize(_moduleCache, false, address(this));
    }

    /// @dev UUPS 升级授权函数
    /// @param newImplementation 新实现地址
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        LiquidationBase.validateAddress(newImplementation, "Implementation");
    }

    // ============ 内部辅助函数 ============
    
    // Removed: rely on ModuleCache.get with Registry fallback in callers

    /// @dev 获取缓存的模块地址，如果不存在则更新缓存
    /// @param key 模块键
    /// @return 模块地址
    // Removed helper: use ModuleCache.get directly

    /// @dev 静默获取缓存的模块地址
    /// @param key 模块键
    /// @return 模块地址
    // Removed helper: use ModuleCache.get directly

    /// @dev 设置健康因子缓存
    /// @param user 用户地址
    /// @param value 健康因子值
    function _setHealthFactorCache(address user, uint256 value) internal {
        _healthFactorCache[user] = value;
        emit HealthFactorEvent(user, value, HEALTH_STATUS_UPDATED, block.timestamp);
    }

    /// @notice 更新模块地址缓存
    /// @dev 仅管理员可调用
    // Removed explicit updater to reduce size; ModuleCache resolves on demand

    // ============ 风险评估核心功能 ============
    
    /// @notice 检查用户是否可清算
    /// @param user 用户地址
    /// @return 是否可清算
    /// @dev 基于用户当前健康因子判断
    function isLiquidatable(address user) external view override returns (bool) {
        if (user == address(0)) revert ZeroAddress();
        uint256 hf = getUserHealthFactor(user);
        return hf < liquidationThresholdVar;
    }

    /// @notice 检查指定参数下用户是否可清算
    /// @param user 用户地址
    /// @param collateral 抵押物价值
    /// @param debt 债务价值
    /// @param asset 资产地址
    /// @return 是否可清算
    /// @dev 基于提供的参数计算健康因子
    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address asset
    ) external view override returns (bool) {
        if (user == address(0) || asset == address(0)) revert ZeroAddress();
        uint256 hf = LiquidationRiskLib.calculateHealthFactor(collateral, debt);
        return hf < liquidationThresholdVar;
    }

    /// @notice 获取用户清算风险评分
    /// @param user 用户地址
    /// @return 风险评分（0-100）
    /// @dev 基于用户当前抵押物和债务计算风险评分
    function getLiquidationRiskScore(address user) external view override returns (uint256) {
        if (user == address(0)) revert ZeroAddress();
        (uint256 collateralValue, uint256 debtValue) = LiquidationRiskQueryLib.getUserValuesWithFallback(
            user,
            _moduleCache,
            maxCacheDurationVar,
            _baseStorage.priceOracleAddr,
            _baseStorage.settlementTokenAddr
        );
        return LiquidationRiskLib.calculateLiquidationRiskScore(collateralValue, debtValue);
    }

    /// @notice 计算清算风险评分
    /// @param collateral 抵押物价值
    /// @param debt 债务价值
    /// @return 风险评分（0-100）
    /// @dev 基于 LTV 比率计算风险评分
    function calculateLiquidationRiskScore(
        uint256 collateral,
        uint256 debt
    ) public pure override returns (uint256) {
        return LiquidationRiskLib.calculateLiquidationRiskScore(collateral, debt);
    }

    /// @notice 获取用户健康因子 - 使用优雅降级机制
    /// @param user 用户地址
    /// @return 健康因子值
    /// @dev 优先使用缓存，缓存过期时重新计算
    function getUserHealthFactor(address user) public view override returns (uint256) {
        if (user == address(0)) revert ZeroAddress();
        
        uint256 cachedValue = _healthFactorCache[user];
        if (cachedValue != 0) {
            return cachedValue;
        }
        
        // 缓存过期，重新计算但不更新缓存（view函数不能修改状态）
        (uint256 collateralValue, uint256 debtValue) = LiquidationRiskQueryLib.getUserValuesWithFallback(
            user,
            _moduleCache,
            maxCacheDurationVar,
            _baseStorage.priceOracleAddr,
            _baseStorage.settlementTokenAddr
        );
        uint256 healthFactor = LiquidationRiskLib.calculateHealthFactor(collateralValue, debtValue);
        
        return healthFactor;
    }

    /// @notice 更新用户健康因子缓存
    /// @param user 用户地址
    /// @dev 用于更新缓存，供外部调用
    function updateHealthFactorCache(address user) external {
        if (user == address(0)) revert ZeroAddress();
        
        (uint256 collateralValue, uint256 debtValue) = LiquidationRiskQueryLib.getUserValuesWithFallback(
            user,
            _moduleCache,
            maxCacheDurationVar,
            _baseStorage.priceOracleAddr,
            _baseStorage.settlementTokenAddr
        );
        if (collateralValue == 0 && debtValue == 0) {
            // 如果获取数据失败，不更新缓存
            return;
        }
        
        uint256 healthFactor = LiquidationRiskLib.calculateHealthFactor(collateralValue, debtValue);
        
        LiquidationRiskCacheLib.setCache(_healthFactorCache, user, healthFactor);
        emit HealthFactorEvent(user, healthFactor, HEALTH_STATUS_UPDATED, block.timestamp);
        
        if (healthFactor < minHealthFactorVar) {
            emit HealthFactorEvent(user, healthFactor, HEALTH_STATUS_ANOMALY, block.timestamp);
        }
    }

    /// @notice 批量检查用户是否可清算
    /// @param users 用户地址数组
    /// @return liquidatable 是否可清算数组
    function batchIsLiquidatable(address[] calldata users) external view override returns (bool[] memory liquidatable) {
        uint256 length = users.length;
        if (length > maxBatchSizeVar) revert LiquidationRiskManager__InvalidBatchSize();
        return LiquidationRiskBatchLib.batchIsLiquidatable(address(this), users, liquidationThresholdVar);
    }

    /// @notice 批量获取用户清算风险评分
    /// @param users 用户地址数组
    /// @return riskScores 风险评分数组
    function batchGetLiquidationRiskScores(address[] calldata users) external view override returns (uint256[] memory riskScores) {
        return LiquidationViewLibrary.batchGetLiquidationRiskScores(users, _moduleCache);
    }

    /// @notice 批量获取用户健康因子
    /// @param users 用户地址数组
    /// @return healthFactors 健康因子数组
    function batchGetUserHealthFactors(address[] calldata users) external view override returns (uint256[] memory healthFactors) {
        uint256 length = users.length;
        if (length > maxBatchSizeVar) revert LiquidationRiskManager__InvalidBatchSize();
        return LiquidationRiskBatchLib.batchGetUserHealthFactors(address(this), users);
    }

    /// @notice 计算健康因子
    /// @param collateral 抵押物价值
    /// @param debt 债务价值
    /// @return 健康因子值
    /// @dev 健康因子 = 抵押物价值 / 债务价值
    function calculateHealthFactor(
        uint256 collateral,
        uint256 debt
    ) public pure override returns (uint256) {
        return LiquidationRiskLib.calculateHealthFactor(collateral, debt);
    }

    /// @notice 获取用户完整的风险评估
    /// @param user 用户地址
    /// @return liquidatable 是否可清算
    /// @return riskScore 风险评分
    /// @return healthFactor 健康因子
    /// @return riskLevel 风险等级
    /// @return safetyMargin 安全边际
    /// @dev 返回用户风险的完整评估结果
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
        
        healthFactor = getUserHealthFactor(user);
        (uint256 collateralValue, uint256 debtValue) = LiquidationRiskQueryLib.getUserValuesWithFallback(
            user,
            _moduleCache,
            maxCacheDurationVar,
            _baseStorage.priceOracleAddr,
            _baseStorage.settlementTokenAddr
        );
        riskScore = LiquidationRiskLib.calculateLiquidationRiskScore(collateralValue, debtValue);
        riskLevel = LiquidationTypes.calculateRiskLevel(healthFactor);
        liquidatable = healthFactor < liquidationThresholdVar;
        safetyMargin = LiquidationTypes.calculateSafetyMargin(healthFactor, liquidationThresholdVar);
    }

    // ============ 阈值管理功能 ============
    
    /// @notice 获取清算阈值
    /// @return 清算阈值（基点）
    function getLiquidationThreshold() external view override returns (uint256) {
        return liquidationThresholdVar;
    }

    /// @notice 更新清算阈值
    /// @param newThreshold 新的清算阈值
    /// @dev 仅管理员可调用，需验证阈值有效性
    function updateLiquidationThreshold(uint256 newThreshold) external override onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (!LiquidationTypes.isValidLiquidationThreshold(newThreshold)) revert LiquidationRiskManager__InvalidThreshold();
        
        uint256 oldThreshold = liquidationThresholdVar;
        liquidationThresholdVar = newThreshold;
        emit ParameterUpdated(PARAM_LIQUIDATION_THRESHOLD, oldThreshold, newThreshold);
    }

    /// @notice 获取最小健康因子
    /// @return 最小健康因子（基点）
    function getMinHealthFactor() external view override returns (uint256) {
        return minHealthFactorVar;
    }

    /// @notice 更新最小健康因子
    /// @param newMinHealthFactor 新的最小健康因子
    /// @dev 仅管理员可调用，需大于清算阈值
    function updateMinHealthFactor(uint256 newMinHealthFactor) external override onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (newMinHealthFactor < liquidationThresholdVar) revert LiquidationRiskManager__InvalidThreshold();
        
        uint256 oldFactor = minHealthFactorVar;
        minHealthFactorVar = newMinHealthFactor;
        emit ParameterUpdated(PARAM_MIN_HEALTH_FACTOR, oldFactor, newMinHealthFactor);
    }

    // ============ 缓存管理功能 ============
    
    /// @notice 更新用户健康因子缓存
    /// @param user 用户地址
    /// @param healthFactor 健康因子值
    /// @dev 仅管理员可调用
    function updateHealthFactorCache(address user, uint256 healthFactor) external override onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (user == address(0)) revert ZeroAddress();
        
        _setHealthFactorCache(user, healthFactor);
    }

    /// @notice 获取用户健康因子缓存信息
    /// @param user 用户地址
    /// @return healthFactor 健康因子值
    /// @return timestamp 缓存时间戳
    function getHealthFactorCache(
        address user
    ) external view override returns (uint256 healthFactor, uint256 timestamp) {
        if (user == address(0)) revert ZeroAddress();
        uint256 cachedValue = LiquidationRiskCacheLib.getCache(_healthFactorCache, user);
        if (cachedValue != 0) {
            return (cachedValue, block.timestamp);
        } else {
            return (0, 0);
        }
    }

    // moved to View: getHealthFactorCacheWithBlock

    /// @notice 清除用户健康因子缓存
    /// @param user 用户地址
    /// @dev 仅管理员可调用
    function clearHealthFactorCache(address user) external override onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (user == address(0)) revert ZeroAddress();
        LiquidationRiskCacheLib.clearCache(_healthFactorCache, user);
    }

    /// @notice 批量更新健康因子缓存
    /// @param users 用户地址数组
    /// @param healthFactors 健康因子值数组
    /// @dev 仅管理员可调用，数组长度必须一致
    function batchUpdateHealthFactorCache(
        address[] calldata users,
        uint256[] calldata healthFactors
    ) external override onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (users.length != healthFactors.length) revert LiquidationRiskManager__InvalidBatchLength();
        if (users.length > maxBatchSizeVar) revert LiquidationRiskManager__InvalidBatchLength();

        LiquidationRiskCacheLib.batchUpdate(_healthFactorCache, users, healthFactors, maxBatchSizeVar);
        // 批量更新不逐条 emit，避免事件风暴
    }

    /// @notice 批量清除健康因子缓存
    /// @param users 用户地址数组
    /// @dev 仅管理员可调用
    function batchClearHealthFactorCache(address[] calldata users) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (users.length > maxBatchSizeVar) revert LiquidationRiskManager__InvalidBatchLength();

        LiquidationRiskCacheLib.batchClear(_healthFactorCache, users, maxBatchSizeVar);
    }

    

    // ============ 预览功能 ============
    
    

    // ============ 内部辅助函数 ============
    
    // Removed: helper query functions now live in LiquidationRiskQueryLib
    // moved to View

    // ============ Registry 模块获取函数 ============
    
    

    // ============ Registry 升级流程函数 ============
    
    

    /// @notice 获取待升级信息
    /// @param moduleKey 模块键
    /// @return newAddress 新地址
    /// @return executeAfter 执行时间
    /// @return hasPending 是否有待升级
    // moved to View

    /// @notice 检查升级是否准备就绪
    /// @param moduleKey 模块键
    /// @return 是否准备就绪
    // moved to View

    /* ============ Registry 管理函数 ============ */
    
    /**
     * 获取模块地址 - 从 Registry 中获取模块地址
     * Get module address - Get module address from Registry
     * @param moduleKey 模块键值 Module key
     * @return 模块地址 Module address
     */
    // moved to View

    /**
     * 获取模块地址或回滚 - 从 Registry 中获取模块地址，如果不存在则回滚
     * Get module address or revert - Get module address from Registry, revert if not exists
     * @param moduleKey 模块键值 Module key
     * @return 模块地址 Module address
     */
    // moved to View



    /**
     * 设置模块 - 设置指定模块的地址
     * Set module - Set address for specified module
     * @param moduleKey 模块键值 Module key
     * @param moduleAddress 模块地址 Module address
     * @param allowReplace 是否允许替换 Whether to allow replacement
     */
    

    /**
     * 获取 Registry 延时窗口
     * Get Registry min delay
     * @return 延时窗口 Min delay
     */
    // moved to View

    /**
     * 获取 Registry 最大延时窗口
     * Get Registry max delay
     * @return 最大延时窗口 Max delay
     */
    // moved to View

    /**
     * 获取 Registry 所有者
     * Get Registry owner
     * @return 所有者地址 Owner address
     */
    // moved to View

    // ============ 管理功能 ============
    
    

    /// @notice 设置最大缓存持续时间
    /// @param duration 缓存持续时间（秒）
    /// @dev 仅管理员可调用
    function setMaxCacheDuration(uint256 duration) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        uint256 oldPeriod = maxCacheDurationVar;
        maxCacheDurationVar = duration;
        emit ParameterUpdated(PARAM_MAX_CACHE_DURATION, oldPeriod, duration);
    }

    /// @notice 设置最大批量操作大小
    /// @param size 批量操作大小
    /// @dev 仅管理员可调用，大小范围 1-200
    function setMaxBatchSize(uint256 size) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (size == 0 || size > 200) revert LiquidationRiskManager__InvalidBatchSize();
        
        uint256 oldSize = maxBatchSizeVar;
        maxBatchSizeVar = size;
        emit ParameterUpdated(PARAM_MAX_BATCH_SIZE, oldSize, size);
    }

    /// @notice 获取最大批量操作大小
    /// @return 最大批量操作大小
    // moved to View

    // ============ 健康批量检查与推送（已迁移至 View/或外部执行器） =========

    // 接口已上移至文件顶部以满足 Solidity 解析顺序要求

    /// @notice 批量评估指定用户健康状态并推送至 HealthView
    /// @param users 用户地址数组
    /// @dev 仅在系统配置存在价格预言机时执行；内部使用优雅降级聚合总额
    

    // ============ 兼容性函数 ============
    
    /// @notice 获取清算阈值（兼容性函数）
    /// @return 清算阈值
    // moved to View

    /// @notice 获取最小健康因子（兼容性函数）
    /// @return 最小健康因子
    // moved to View

    /// @notice 获取最大缓存持续时间（兼容性函数）
    /// @return 最大缓存持续时间
    // moved to View

    /// @notice 获取最大批量操作大小（兼容性函数）
    /// @return 最大批量操作大小
    // moved to View
} 
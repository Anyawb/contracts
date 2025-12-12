// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import "../libraries/LiquidationValidationLibrary.sol";
import "../libraries/LiquidationCoreOperations.sol";
import "../libraries/LiquidationEventLibrary.sol";
import "../libraries/LiquidationViewLibrary.sol";
import "../libraries/LiquidationUtilityLibrary.sol";
import "../libraries/LiquidationAccessControl.sol";
import "../libraries/ModuleCache.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ILiquidationBatchQueryManager } from "../../../interfaces/ILiquidationBatchQueryManager.sol";
import { IRegistryUpgradeEvents } from "../../../interfaces/IRegistryUpgradeEvents.sol";
import { ILendingEngineBasic as ILendingEngine } from "../../../interfaces/ILendingEngineBasic.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { Registry } from "../../../registry/Registry.sol";
import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";

/**
 * @title LiquidationBatchQueryManager
 * @dev 清算批量查询管理器 - 负责清算批量查询和优化功能
 * @dev Liquidation Batch Query Manager - Responsible for liquidation batch query and optimization functions
 * @dev 从 LiquidationDebtManager 拆分出的清算批量查询管理功能
 * @dev Liquidation batch query management functions split from LiquidationDebtManager
 * @dev 提供高效的批量查询和优化功能
 * @dev Provides efficient batch query and optimization functions
 * @dev 支持升级功能，可升级实现合约
 * @dev Supports upgrade functionality, upgradeable implementation contract
 * @dev 使用ReentrancyGuard防止重入攻击
 * @dev Uses ReentrancyGuard to prevent reentrancy attacks
 * @dev 支持暂停功能，紧急情况下可暂停所有操作
 * @dev Supports pause functionality, can pause all operations in emergency situations
 * @dev 与 ActionKeys 和 ModuleKeys 集成，提供标准化的权限和模块管理
 * @dev Integrates with ActionKeys and ModuleKeys, provides standardized permission and module management
 * @dev 优化：使用 LiquidationAccessControl 库进行权限管理
 * @dev Optimized: Using LiquidationAccessControl library for permission management
 * @dev 完全使用Registry系统进行模块管理，支持模块升级
 * @dev Fully uses Registry system for module management, supports module upgrades
 * @dev 新增：支持模块升级流程，包括安排升级、执行升级、取消升级
 * @dev New: Supports module upgrade process, including scheduling, executing, and cancelling upgrades
 * @dev 新增：集成优雅降级机制，处理价格预言机失败情况
 * @dev New: Integrated graceful degradation mechanism to handle price oracle failures
 */
abstract contract LiquidationBatchQueryManager is 
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationBatchQueryManager,
    IRegistryUpgradeEvents
{
    using LiquidationValidationLibrary for *;
    using LiquidationCoreOperations for *;
    using LiquidationEventLibrary for *;
    using LiquidationViewLibrary for *;
    using LiquidationAccessControl for LiquidationAccessControl.Storage;
    using LiquidationBase for *;
    using GracefulDegradation for *;

    // ============ 自定义错误 ============
    /// @dev 无效查询参数错误
    error LiquidationBatchQueryManager__InvalidQueryParameters();
    /// @dev 查询超时错误
    error LiquidationBatchQueryManager__QueryTimeout();
    /// @dev 零地址错误
    error LiquidationBatchQueryManager__ZeroAddress();
    /// @dev 缓存过期错误
    error LiquidationBatchQueryManager__CacheExpired();
    /// @dev 外部模块调用失败错误
    error LiquidationBatchQueryManager__ExternalModuleCallFailed();
    /// @dev 查询权限不足错误
    error LiquidationBatchQueryManager__InsufficientQueryPermission();
    /// @dev 批量操作失败错误
    error LiquidationBatchQueryManager__BatchOperationFailed();
    /// @dev Registry未初始化错误
    error LiquidationBatchQueryManager__RegistryNotInitialized();
    /// @dev 模块升级未准备就绪错误
    error LiquidationBatchQueryManager__UpgradeNotReady();
    /// @dev 模块升级已安排错误
    error LiquidationBatchQueryManager__UpgradeAlreadyScheduled();

    // ============ 事件 ============
    /// @dev 外部模块调用失败事件
    event ExternalModuleCallFailed(
        bytes32 indexed moduleKey,
        address indexed moduleAddress,
        string reason,
        uint256 timestamp
    );

    /// @dev 缓存更新事件
    event CacheUpdated(
        address indexed user,
        bytes32 indexed cacheType,
        uint256 oldValue,
        uint256 newValue,
        uint256 timestamp
    );

    /// @dev Flash Loan影响计算事件
    event FlashLoanImpactCalculated(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 impact,
        uint256 timestamp
    );

    /// @dev 批量查询优雅降级事件
    /// @param queryType 查询类型
    /// @param affectedCount 受影响数量
    /// @param reason 降级原因
    event BatchQueryGracefulDegradation(
        string indexed queryType,
        uint256 affectedCount,
        string reason
    );

    // Registry升级相关事件已在 IRegistryUpgradeEvents 接口中定义

    // ============ 常量与状态变量 ============
    /// @notice 最大批量查询大小
    uint256 public constant MAX_BATCH_SIZE = 100;
    /// @notice 查询超时时间（秒）
    uint256 public constant QUERY_TIMEOUT = 30;
    /// @notice 缓存过期时间（秒）
    uint256 public constant CACHE_EXPIRY = 300; // 5分钟

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

    /**
     * 查询缓存：queryId → (timestamp, resultCount)
     * Query cache: queryId → (timestamp, resultCount)
     * @dev 缓存查询结果以减少重复计算
     * @dev Cache query results to reduce redundant calculations
     */
    mapping(bytes32 => LiquidationTypes.QueryCache) private _queryCache;

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
        LiquidationAccessControl.initialize(accessControlStorage, initialAccessControl, initialAccessControl);
        
        // 初始化模块缓存
        ModuleCache.initialize(_moduleCache, false, address(this));
    }

    // ============ 修饰符 ============
    /// @dev 角色验证修饰符
    /// @param role 所需角色
    modifier onlyRole(bytes32 role) {
        LiquidationAccessControl.requireRole(accessControlStorage, role, msg.sender);
        _;
    }

    // ============ 内部函数 ============
    
    /**
     * 安全获取模块地址 - 使用 Registry 系统
     * Safe get module address - Using Registry system
     * @param moduleKey 模块键值 Module key
     * @return 模块地址 Module address
     */
    function _safeGetModule(bytes32 moduleKey) internal view returns (address) {
        if (_registryAddr == address(0)) revert LiquidationBatchQueryManager__RegistryNotInitialized();
        
        try Registry(_registryAddr).getModuleOrRevert(moduleKey) returns (address module) {
            return module;
        } catch {
            revert LiquidationBatchQueryManager__ExternalModuleCallFailed();
        }
    }

    /**
     * 获取借贷引擎接口 - 使用 Registry 系统
     * Get lending engine interface - Using Registry system
     * @return 借贷引擎接口 Lending engine interface
     */
    function _getLendingEngine() internal view returns (ILendingEngine) {
        address lendingEngine = _safeGetModule(ModuleKeys.KEY_LE);
        return ILendingEngine(lendingEngine);
    }

    /**
     * 获取借贷引擎地址 - 使用 Registry 系统
     * Get lending engine address - Using Registry system
     * @return 借贷引擎地址 Lending engine address
     */
    function _getLendingEngineAddress() internal view returns (address) {
        return _safeGetModule(ModuleKeys.KEY_LE);
    }

    /**
     * 获取清算风险管理器 - 使用 Registry 系统
     * Get liquidation risk manager - Using Registry system
     * @return 清算风险管理器接口 Liquidation risk manager interface
     */
    function _getLiquidationRiskManager() internal view returns (ILiquidationRiskManager) {
        address riskManager = _safeGetModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        return ILiquidationRiskManager(riskManager);
    }

    /**
     * 验证缓存是否过期 - 检查查询缓存是否过期
     * Validate cache expiration - Check if query cache is expired
     * @param queryId 查询ID Query ID
     * @param maxAge 最大缓存时间 Maximum cache age
     */
    function _validateCacheExpiration(bytes32 queryId, uint256 maxAge) internal view {
        LiquidationTypes.QueryCache memory cache = _queryCache[queryId];
        if (cache.timestamp > 0 && block.timestamp - cache.timestamp > maxAge) {
            revert LiquidationBatchQueryManager__CacheExpired();
        }
    }

    /**
     * 更新查询缓存 - 更新查询缓存信息
     * Update query cache - Update query cache information
     * @param queryId 查询ID Query ID
     * @param resultCount 结果数量 Result count
     */
    function _updateQueryCache(bytes32 queryId, uint256 resultCount) internal {
        LiquidationTypes.QueryCache storage cache = _queryCache[queryId];
        uint256 oldResultCount = cache.resultCount;
        
        cache.timestamp = block.timestamp;
        cache.resultCount = resultCount;
        
        emit CacheUpdated(
            address(0),
            queryId,
            oldResultCount,
            resultCount,
            block.timestamp
        );
    }

    /**
     * 计算Flash Loan影响 - 计算Flash Loan对清算的影响
     * Calculate Flash Loan impact - Calculate Flash Loan impact on liquidation
     * @param collateralAsset 抵押资产地址 Collateral asset address
     * @param debtAsset 债务资产地址 Debt asset address
     * @param collateralAmount 抵押物数量 Collateral amount
     * @param debtAmount 债务数量 Debt amount
     * @return impact Flash Loan影响 Flash Loan impact
     */
    function _calculateFlashLoanImpact(
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) internal view returns (uint256 impact) {
        // 使用 LiquidationViewLibrary 库计算Flash Loan影响
        return LiquidationViewLibrary._calculateFlashLoanImpact(
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            _baseStorage
        );
    }

    /**
     * 创建优雅降级配置 - 创建默认的降级配置
     * Create graceful degradation config - Create default degradation config
     * @return config 降级配置 Degradation config
     */
    function _createDegradationConfig() internal view returns (GracefulDegradation.DegradationConfig memory config) {
        address settlementToken = _safeGetModule(ModuleKeys.KEY_SETTLEMENT_TOKEN);
        return GracefulDegradation.createDefaultConfig(settlementToken);
    }

    /* ============ 批量查询函数 ============ */
    
    /**
     * 批量获取用户健康因子 - 使用优雅降级机制
     * Batch get user health factors - Using graceful degradation
     * @param userAddresses 用户地址数组 User addresses array
     * @return healthFactors 健康因子数组 Health factors array
     */
    function batchGetUserHealthFactors(
        address[] calldata userAddresses
    ) external view returns (uint256[] memory healthFactors) {
        uint256 length = userAddresses.length;
        if (length > MAX_BATCH_SIZE) revert LiquidationBatchQueryManager__InvalidQueryParameters();
        
        // 使用带优雅降级的批量健康因子计算
        address priceOracle = _safeGetModule(ModuleKeys.KEY_PRICE_ORACLE);
        address settlementToken = _safeGetModule(ModuleKeys.KEY_SETTLEMENT_TOKEN);
        healthFactors = LiquidationViewLibrary.batchGetUserHealthFactorsWithFallback(
            userAddresses,
            _moduleCache,
            priceOracle,
            settlementToken
        );
        
        // 发出降级事件（如果需要）
        // 注意：由于这是view函数，事件应该在调用此函数的非view函数中发出
    }

    /**
     * 批量获取用户风险评分 - 使用优雅降级机制
     * Batch get user risk scores - Using graceful degradation
     * @param userAddresses 用户地址数组 User addresses array
     * @return riskScores 风险评分数组 Risk scores array
     */
    function batchGetUserRiskScores(
        address[] calldata userAddresses
    ) external view returns (uint256[] memory riskScores) {
        uint256 length = userAddresses.length;
        if (length > MAX_BATCH_SIZE) revert LiquidationBatchQueryManager__InvalidQueryParameters();
        
        // 使用现有的批量风险评分计算（暂时使用简单版本）
        riskScores = LiquidationViewLibrary.batchGetLiquidationRiskScores(userAddresses, _moduleCache);
        
        // 发出降级事件（如果需要）
        // 注意：由于这是view函数，事件应该在调用此函数的非view函数中发出
    }

    /**
     * 批量获取可减少金额 - 批量获取多个用户的可减少金额
     * Batch get reducible amounts - Batch get reducible amounts for multiple users
     * @param users 用户地址数组 Array of user addresses
     * @param assets 资产地址数组 Array of asset addresses
     * @return reducibleAmounts 可减少金额数组 Array of reducible amounts
     */
    function batchGetReducibleAmounts(
        address[] calldata users,
        address[] calldata assets
    ) external view returns (uint256[] memory reducibleAmounts) {
        return LiquidationViewLibrary.batchGetReducibleAmounts(users, assets, _getLendingEngineAddress());
    }

    /**
     * 批量计算债务价值 - 批量计算多个用户的债务价值
     * Batch calculate debt values - Batch calculate debt values for multiple users
     * @param users 用户地址数组 Array of user addresses
     * @param assets 资产地址数组 Array of asset addresses
     * @return debtValues 债务价值数组 Array of debt values
     */
    function batchCalculateDebtValues(
        address[] calldata users,
        address[] calldata assets
    ) external view returns (uint256[] memory debtValues) {
        return LiquidationViewLibrary.batchCalculateDebtValues(users, assets, _getLendingEngineAddress());
    }

    /**
     * 获取可清算用户列表 - 获取可清算用户列表
     * Get liquidatable user list - Get list of liquidatable users
     * @param healthFactorThreshold 健康因子阈值 Health factor threshold
     * @param limit 限制数量 Limit count
     * @return users 用户地址数组 Array of user addresses
     * @return healthFactors 健康因子数组 Array of health factors
     */
    function getLiquidatableUserList(
        uint256 healthFactorThreshold,
        uint256 limit
    ) external view returns (address[] memory users, uint256[] memory healthFactors) {
        return LiquidationViewLibrary.getLiquidatableUserList(healthFactorThreshold, limit, _getLendingEngineAddress());
    }

    /**
     * 批量获取可清算用户列表 - 使用库函数
     * Batch get liquidatable user list - Using library function
     * @param healthFactorThreshold 健康因子阈值 Health factor threshold
     * @param limit 限制数量 Limit
     * @return users 用户地址数组 User addresses array
     * @return healthFactors 健康因子数组 Health factors array
     */
    function batchGetLiquidatableUsers(
        uint256 healthFactorThreshold,
        uint256 limit
    ) external view returns (address[] memory users, uint256[] memory healthFactors) {
        return LiquidationViewLibrary.getLiquidatableUserList(healthFactorThreshold, limit, _getLendingEngineAddress());
    }

    /**
     * 批量获取高风险用户列表 - 使用库函数
     * Batch get high risk user list - Using library function
     * @param riskThreshold 风险阈值 Risk threshold
     * @param limit 限制数量 Limit
     * @return users 用户地址数组 User addresses array
     * @return riskScores 风险评分数组 Risk scores array
     */
    function batchGetHighRiskUsers(
        uint256 riskThreshold,
        uint256 limit
    ) external view returns (address[] memory users, uint256[] memory riskScores) {
        return LiquidationViewLibrary.getHighRiskUserList(riskThreshold, limit, _getLendingEngineAddress());
    }

    /**
     * 批量预览清算效果 - 使用优雅降级机制
     * Batch preview liquidation effects - Using graceful degradation
     * @param targetUsers 用户地址数组 User addresses array
     * @param collateralAssets 抵押资产地址数组 Collateral asset addresses array
     * @param debtAssets 债务资产地址数组 Debt asset addresses array
     * @param collateralAmounts 清算抵押物数量数组 Collateral amounts array
     * @param debtAmounts 清算债务数量数组 Debt amounts array
     * @param simulateFlashLoan 是否模拟Flash Loan影响数组 Whether to simulate Flash Loan impact array
     * @return bonuses 清算奖励数组 Bonuses array
     * @return newHealthFactors 清算后健康因子数组 New health factors array
     * @return newRiskScores 清算后风险评分数组 New risk scores array
     * @return slippageImpacts Flash Loan影响数组 Flash Loan impacts array
     */
    function batchPreviewLiquidation(
        address[] calldata targetUsers,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        bool[] calldata simulateFlashLoan
    ) external view returns (
        uint256[] memory bonuses,
        uint256[] memory newHealthFactors,
        uint256[] memory newRiskScores,
        uint256[] memory slippageImpacts
    ) {
        uint256 length = targetUsers.length;
        if (length > MAX_BATCH_SIZE) revert LiquidationBatchQueryManager__InvalidQueryParameters();
        
        // 使用现有的批量预览清算（暂时使用简单版本）
        (bonuses, newHealthFactors, newRiskScores, slippageImpacts) = LiquidationViewLibrary.batchPreviewLiquidation(
            targetUsers,
            collateralAssets,
            debtAssets,
            collateralAmounts,
            debtAmounts,
            simulateFlashLoan,
            _baseStorage,
            _moduleCache
        );
        
        // 发出降级事件（如果需要）
        // 注意：由于这是view函数，事件应该在调用此函数的非view函数中发出
    }

    /* ============ 优化查询函数 ============ */
    
    /**
     * 计算最优清算组合 - 使用库函数
     * Calculate optimal liquidation combination - Using library function
     * @param targetUser 用户地址 User address
     * @param maxDebtReduction 最大债务减少量 Maximum debt reduction
     * @param maxCollateralReduction 最大抵押物减少量 Maximum collateral reduction
     * @return optimalDebtReduction 最优债务减少量 Optimal debt reduction
     * @return optimalCollateralReduction 最优抵押物减少量 Optimal collateral reduction
     * @return healthFactor 健康因子 Health factor
     */
    function calculateOptimalLiquidationCombination(
        address targetUser,
        uint256 maxDebtReduction,
        uint256 maxCollateralReduction
    ) external view returns (
        uint256 optimalDebtReduction,
        uint256 optimalCollateralReduction,
        uint256 healthFactor
    ) {
        return LiquidationViewLibrary.calculateOptimalLiquidationCombination(
            targetUser,
            maxDebtReduction,
            maxCollateralReduction,
            _getLendingEngineAddress()
        );
    }

    /**
     * 预览清算债务状态 - 使用库函数
     * Preview liquidation debt state - Using library function
     * @param targetUser 用户地址 User address
     * @param debtReduction 债务减少量 Debt reduction
     * @param collateralReduction 抵押物减少量 Collateral reduction
     * @return newHealthFactor 新健康因子 New health factor
     * @return newRiskScore 新风险评分 New risk score
     * @return newRiskLevel 新风险等级 New risk level
     */
    function previewLiquidationDebtState(
        address targetUser,
        uint256 debtReduction,
        uint256 collateralReduction
    ) external view returns (
        uint256 newHealthFactor,
        uint256 newRiskScore,
        uint256 newRiskLevel
    ) {
        return LiquidationViewLibrary.previewLiquidationDebtState(
            targetUser,
            debtReduction,
            collateralReduction,
            _getLendingEngineAddress()
        );
    }

    /**
     * 计算最优清算路径 - 使用库函数
     * Calculate optimal liquidation path - Using library function
     * @param targetUser 用户地址 User address
     * @param targetHealthFactor 目标健康因子 Target health factor
     * @return liquidationSteps 清算步骤数组 Liquidation steps array
     * @return totalDebtReduction 总债务减少量 Total debt reduction
     * @return totalCollateralReduction 总抵押物减少量 Total collateral reduction
     */
    function calculateOptimalLiquidationPath(
        address targetUser,
        uint256 targetHealthFactor
    ) external view returns (
        address[] memory liquidationSteps,
        uint256 totalDebtReduction,
        uint256 totalCollateralReduction
    ) {
        return LiquidationViewLibrary.calculateOptimalLiquidationPath(
            targetUser,
            targetHealthFactor,
            _getLendingEngineAddress()
        );
    }

    /**
     * 批量优化清算策略 - 使用库函数
     * Batch optimize liquidation strategies - Using library function
     * @param userAddresses 用户地址数组 User addresses array
     * @param targetHealthFactors 目标健康因子数组 Target health factors array
     * @return strategies 策略数组 Strategies array
     */
    function batchOptimizeLiquidationStrategies(
        address[] calldata userAddresses,
        uint256[] calldata targetHealthFactors
    ) external view returns (bytes[] memory strategies) {
        return LiquidationViewLibrary.batchOptimizeLiquidationStrategies(
            userAddresses,
            targetHealthFactors,
            _getLendingEngineAddress()
        );
    }

    /* ============ Flash Loan 影响计算 ============ */
    
    /**
     * 计算Flash Loan影响 - 计算Flash Loan对清算的影响
     * Calculate Flash Loan impact - Calculate Flash Loan impact on liquidation
     * @param user 用户地址 User address
     * @param collateralAsset 抵押资产地址 Collateral asset address
     * @param debtAsset 债务资产地址 Debt asset address
     * @param collateralAmount 抵押物数量 Collateral amount
     * @param debtAmount 债务数量 Debt amount
     * @return impact Flash Loan影响 Flash Loan impact
     */
    function calculateFlashLoanImpact(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external returns (uint256 impact) {
        impact = _calculateFlashLoanImpact(collateralAsset, debtAsset, collateralAmount, debtAmount);
        
        emit FlashLoanImpactCalculated(
            user,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            impact,
            block.timestamp
        );
    }

    /* ============ 缓存管理函数 ============ */
    
    /**
     * 清除查询缓存 - 清除指定查询的缓存
     * Clear query cache - Clear cache for specified query
     * @param queryId 查询ID Query ID
     */
    function clearQueryCache(bytes32 queryId) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        delete _queryCache[queryId];
        
        emit CacheUpdated(
            address(0),
            queryId,
            0,
            0,
            block.timestamp
        );
    }

    /**
     * 获取查询缓存信息 - 获取指定查询的缓存信息
     * Get query cache info - Get cache info for specified query
     * @param queryId 查询ID Query ID
     * @return timestamp 缓存时间戳 Cache timestamp
     * @return resultCount 结果数量 Result count
     */
    function getQueryCacheInfo(bytes32 queryId) external view returns (uint256 timestamp, uint256 resultCount) {
        LiquidationTypes.QueryCache memory cache = _queryCache[queryId];
        return (cache.timestamp, cache.resultCount);
    }

    /* ============ 管理员函数 ============ */
    
    /**
     * 更新价格预言机地址
     * @param newPriceOracle 新的价格预言机地址
     */
    function updatePriceOracle(address newPriceOracle) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        LiquidationBase.validateAddress(newPriceOracle, "PriceOracle");
        // 通过Registry更新模块地址
        Registry(_registryAddr).setModule(ModuleKeys.KEY_PRICE_ORACLE, newPriceOracle);
    }

    /**
     * 更新结算币地址
     * @param newSettlementToken 新的结算币地址
     */
    function updateSettlementToken(address newSettlementToken) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        LiquidationBase.validateAddress(newSettlementToken, "SettlementToken");
        // 通过Registry更新模块地址
        Registry(_registryAddr).setModule(ModuleKeys.KEY_SETTLEMENT_TOKEN, newSettlementToken);
    }

    /**
     * 获取价格预言机地址
     * @return priceOracle 价格预言机地址
     */
    function getPriceOracle() external view returns (address priceOracle) {
        return _safeGetModule(ModuleKeys.KEY_PRICE_ORACLE);
    }

    /**
     * 获取结算币地址
     * @return settlementToken 结算币地址
     */
    function getSettlementToken() external view returns (address settlementToken) {
        return _safeGetModule(ModuleKeys.KEY_SETTLEMENT_TOKEN);
    }

    /* ============ Registry 模块管理函数 ============ */
    
    /**
     * 获取模块地址 - 从 Registry 中获取模块地址
     * Get module address - Get module address from Registry
     * @param moduleKey 模块键值 Module key
     * @return 模块地址 Module address
     */
    function getModule(bytes32 moduleKey) public view returns (address) {
        return Registry(_registryAddr).getModule(moduleKey);
    }

    /**
     * 获取模块地址或回滚 - 从 Registry 中获取模块地址，如果不存在则回滚
     * Get module address or revert - Get module address from Registry, revert if not exists
     * @param moduleKey 模块键值 Module key
     * @return 模块地址 Module address
     */
    function getModuleOrRevert(bytes32 moduleKey) public view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /**
     * 检查模块是否已注册
     * Check if module is registered
     * @param moduleKey 模块键值 Module key
     * @return 是否已注册 Whether registered
     */
    function isModuleRegistered(bytes32 moduleKey) public view returns (bool) {
        return Registry(_registryAddr).isModuleRegistered(moduleKey);
    }

    /**
     * 更新模块 - 更新指定模块的缓存地址
     * Update module - Update cached address for specified module
     * @param key 模块键值 Module key
     * @param addr 模块地址 Module address
     */
    function updateModule(bytes32 key, address addr) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        LiquidationBase.validateAddress(addr, "Module");
        ModuleCache.updateModule(_moduleCache, key, addr, msg.sender);
    }

    /**
     * 批量更新模块 - 一次性更新多个模块
     * Batch update modules - Update multiple modules at once
     * @param keys 模块键值数组 Array of module keys
     * @param addresses 模块地址数组 Array of module addresses
     */
    function batchUpdateModules(bytes32[] memory keys, address[] memory addresses) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        uint256 length = keys.length;
        if (length != addresses.length) revert LiquidationBatchQueryManager__InvalidQueryParameters();
        
        for (uint256 i = 0; i < length;) {
            LiquidationBase.validateAddress(addresses[i], "Module");
            unchecked { ++i; }
        }
        
        ModuleCache.batchUpdateModules(_moduleCache, keys, addresses, msg.sender);
    }

    /**
     * 移除模块 - 从缓存中移除指定模块
     * Remove module - Remove specified module from cache
     * @param key 模块键值 Module key
     */
    function removeModule(bytes32 key) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        ModuleCache.removeModule(_moduleCache, key, msg.sender);
    }

    /* ============ Registry 升级管理函数 ============ */
    
    /**
     * 安排模块升级 - 安排指定模块的升级
     * Schedule module upgrade - Schedule upgrade for specified module
     * @param moduleKey 模块键值 Module key
     * @param newAddress 新模块地址 New module address
     */
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        LiquidationBase.validateAddress(newAddress, "NewModule");
        
        Registry(_registryAddr).scheduleModuleUpgrade(moduleKey, newAddress);
        
        emit RegistryModuleUpgradeScheduled(
            moduleKey,
            getModule(moduleKey),
            newAddress,
            block.timestamp + Registry(_registryAddr).minDelay()
        );
    }

    /**
     * 执行模块升级 - 执行指定模块的升级
     * Execute module upgrade - Execute upgrade for specified module
     * @param moduleKey 模块键值 Module key
     */
    function executeModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        address oldAddress = getModule(moduleKey);
        
        Registry(_registryAddr).executeModuleUpgrade(moduleKey);
        
        address newAddress = getModule(moduleKey);
        
        emit RegistryModuleUpgradeExecuted(
            moduleKey,
            oldAddress,
            newAddress
        );
    }

    /**
     * 取消模块升级 - 取消指定模块的升级
     * Cancel module upgrade - Cancel upgrade for specified module
     * @param moduleKey 模块键值 Module key
     */
    function cancelModuleUpgrade(bytes32 moduleKey) external onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        address oldAddress = getModule(moduleKey);
        
        Registry(_registryAddr).cancelModuleUpgrade(moduleKey);
        
        emit RegistryModuleUpgradeCancelled(
            moduleKey,
            oldAddress,
            address(0)
        );
    }

    /**
     * 获取待升级信息 - 获取指定模块的待升级信息
     * Get pending upgrade info - Get pending upgrade info for specified module
     * @param moduleKey 模块键值 Module key
     * @return newAddress 新地址 New address
     * @return executeAfter 执行时间 Execute after
     * @return hasPending 是否有待升级 Whether has pending upgrade
     */
    function getPendingUpgrade(bytes32 moduleKey) external view returns (
        address newAddress,
        uint256 executeAfter,
        bool hasPending
    ) {
        return Registry(_registryAddr).getPendingUpgrade(moduleKey);
    }

    /**
     * 检查升级是否准备就绪 - 检查指定模块的升级是否准备就绪
     * Check if upgrade is ready - Check if upgrade is ready for specified module
     * @param moduleKey 模块键值 Module key
     * @return 是否准备就绪 Whether ready
     */
    function isUpgradeReady(bytes32 moduleKey) external view returns (bool) {
        (, uint256 executeAfter, bool hasPending) = Registry(_registryAddr).getPendingUpgrade(moduleKey);
        return hasPending && block.timestamp >= executeAfter;
    }

    /* ============ Registry 管理函数 ============ */
    
    /**
     * 设置模块 - 设置指定模块的地址
     * Set module - Set address for specified module
     * @param moduleKey 模块键值 Module key
     * @param moduleAddress 模块地址 Module address
     * @param allowReplace 是否允许替换 Whether to allow replacement
     */
    function setModule(bytes32 moduleKey, address moduleAddress, bool allowReplace) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        LiquidationBase.validateAddress(moduleAddress, "Module");
        
        Registry(_registryAddr).setModuleWithReplaceFlag(moduleKey, moduleAddress, allowReplace);
    }

    /**
     * 获取 Registry 延时窗口
     * Get Registry min delay
     * @return 延时窗口 Min delay
     */
    // moved to RegistryView: getRegistryMinDelay

    /**
     * 获取 Registry 最大延时窗口
     * Get Registry max delay
     * @return 最大延时窗口 Max delay
     */
    // moved to RegistryView: getRegistryMaxDelay

    /**
     * 获取 Registry 所有者
     * Get Registry owner
     * @return 所有者地址 Owner address
     */
    // moved to RegistryView: getRegistryOwner

    /* ============ UUPS Upgradeable ============ */
    
    /**
     * 授权升级函数
     * @param newImplementation 新实现合约地址
     */
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        LiquidationBase.validateAddress(newImplementation, "Implementation");
    }
} 
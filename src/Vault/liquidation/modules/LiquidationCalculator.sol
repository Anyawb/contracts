// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import "../libraries/LiquidationValidationLibrary.sol";
import "../libraries/LiquidationCoreOperations.sol";
import "../libraries/LiquidationEventLibrary.sol";
import "../libraries/LiquidationAccessControl.sol";
import "../libraries/ModuleCache.sol";
import "../libraries/LiquidationViewLibrary.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { VaultTypes } from "../../VaultTypes.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ILiquidationCalculator } from "../../../interfaces/ILiquidationCalculator.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { ILiquidationCollateralManager } from "../../../interfaces/ILiquidationCollateralManager.sol";
import { ILiquidationDebtManager } from "../../../interfaces/ILiquidationDebtManager.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { VaultMath } from "../../VaultMath.sol";
import { Registry } from "../../../registry/Registry.sol";
import { IRegistry } from "../../../interfaces/IRegistry.sol";
import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";

/**
 * @title LiquidationCalculator
 * @dev 清算计算器 - 负责清算相关的所有计算和预览功能
 * @dev Liquidation Calculator - Responsible for all liquidation-related calculations and preview functions
 * @dev 提供清算奖励计算、预览清算结果、资产价值计算等功能
 * @dev Provides liquidation bonus calculation, liquidation result preview, asset value calculation and other functions
 * @dev 支持升级功能，可升级实现合约
 * @dev Supports upgrade functionality, upgradeable implementation contract
 * @dev 使用ReentrancyGuard防止重入攻击
 * @dev Uses ReentrancyGuard to prevent reentrancy attacks
 * @dev 优化：使用 LiquidationAccessControl 库进行权限管理
 * @dev Optimized: Using LiquidationAccessControl library for permission management
 * @dev 使用Registry系统进行模块管理
 * @dev Uses Registry system for module management
 * @dev 集成优雅降级机制，确保价格预言机失败时系统仍能正常运行
 * @dev Integrated graceful degradation mechanism to ensure system continues to operate when price oracle fails
 */
abstract contract LiquidationCalculator is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    ILiquidationCalculator
{
    using LiquidationValidationLibrary for *;
    using LiquidationCoreOperations for *;
    using LiquidationEventLibrary for *;
    using LiquidationAccessControl for LiquidationAccessControl.Storage;
    using LiquidationBase for *;
    using VaultMath for uint256;

    /* ============ Constants ============ */
    
    /**
     * 缓存过期时间 - 模块缓存的最大有效期（秒）
     * Cache expiration time - Maximum validity period for module cache (seconds)
     */
    uint256 public constant CACHE_MAX_AGE = 1 days;

    /* ============ Errors ============ */
    
    /// @dev 资产地址无效错误
    error LiquidationCalculator__InvalidAssetAddress(address asset);
    
    /// @dev 数组长度不匹配错误
    error LiquidationCalculator__InvalidArrayLength();
    
    /// @dev 模块调用失败错误
    error LiquidationCalculator__ModuleCallFailed(bytes32 moduleKey, address moduleAddress);

    /* ============ Events ============ */

    /// @notice 优雅降级事件
    /// @param asset 资产地址
    /// @param reason 降级原因
    /// @param fallbackValue 降级价值
    /// @param usedFallback 是否使用了降级
    event LiquidationGracefulDegradation(
        address indexed asset, 
        string reason, 
        uint256 fallbackValue, 
        bool usedFallback
    );

    /// @notice 价格预言机健康检查事件
    /// @param asset 资产地址
    /// @param isHealthy 是否健康
    /// @param details 详细信息
    event PriceOracleHealthCheck(
        address indexed asset, 
        bool isHealthy, 
        string details
    );

    /// @notice 健康因子计算降级事件
    /// @param user 用户地址
    /// @param reason 降级原因
    /// @param fallbackHealthFactor 降级健康因子
    /// @param usedFallback 是否使用了降级
    event HealthFactorDegradation(
        address indexed user, 
        string reason, 
        uint256 fallbackHealthFactor, 
        bool usedFallback
    );

    /* ============ Storage ============ */
    
    /// @notice Registry地址 - 用于模块管理
    /// @notice Registry address - For module management
    address private _registryAddr;

    /**
     * 模块缓存存储 - 包含模块地址缓存管理
     * Module cache storage - Contains module address cache management
     */
    ModuleCache.ModuleCacheStorage private _moduleCache;

    /**
     * 基础存储 - 包含权限控制接口
     * Base storage - Contains access control interface
     */
    LiquidationBase.BaseStorage private _baseStorage;

    /**
     * 权限控制存储 - 使用 LiquidationAccessControl 库
     * Access control storage - Using LiquidationAccessControl library
     */
    LiquidationAccessControl.Storage internal accessControlStorage;

    /**
     * 清算奖励比例（basis points）
     * Liquidation bonus rate (basis points)
     */
    uint256 public liquidationBonusRateVar;

    /**
     * 清算阈值（basis points）
     * Liquidation threshold (basis points)
     */
    uint256 public liquidationThresholdVar;

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
        
        _registryAddr = initialRegistryAddr;
        LiquidationAccessControl.initialize(_baseStorage.accessControl, initialAccessControl, initialAccessControl);
        
        // 初始化模块缓存
        ModuleCache.initialize(_moduleCache, false, address(this));
        
        // 设置默认值
        liquidationBonusRateVar = LiquidationTypes.DEFAULT_LIQUIDATION_BONUS;
        liquidationThresholdVar = LiquidationTypes.DEFAULT_LIQUIDATION_THRESHOLD;
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

    /* ============ 核心计算函数 ============ */
    
    /**
     * 计算清算奖励 - 计算清算奖励金额
     * Calculate liquidation bonus - Calculate liquidation bonus amount
     * @param seizedAmount 扣押数量 Seized amount
     * @param reducedAmount 减少数量 Reduced amount
     * @return bonus 清算奖励 Liquidation bonus
     */
    function calculateLiquidationBonus(
        uint256 seizedAmount,
        uint256 reducedAmount
    ) external view returns (uint256 bonus) {
        // 使用 LiquidationViewLibrary 库计算清算奖励
        return LiquidationViewLibrary.calculateLiquidationBonus(
            seizedAmount,
            reducedAmount,
            liquidationBonusRateVar
        );
    }

    /**
     * 计算清算阈值 - 计算清算阈值
     * Calculate liquidation threshold - Calculate liquidation threshold
     * @param collateralValue 抵押物价值 Collateral value
     * @param debtValue 债务价值 Debt value
     * @return threshold 清算阈值 Liquidation threshold
     */
    function calculateLiquidationThreshold(
        uint256 collateralValue,
        uint256 debtValue
    ) external view returns (uint256 threshold) {
        if (debtValue == 0) {
            return 0;
        }
        
        // 清算阈值 = (抵押物价值 * 清算阈值比例) / 债务价值
        threshold = (collateralValue * liquidationThresholdVar) / debtValue;
    }

    /**
     * 计算健康因子 - 计算用户健康因子
     * Calculate health factor - Calculate user health factor
     * @param collateralValue 抵押物价值 Collateral value
     * @param debtValue 债务价值 Debt value
     * @return healthFactor 健康因子 Health factor
     */
    function calculateHealthFactor(
        uint256 collateralValue,
        uint256 debtValue
    ) external view returns (uint256 healthFactor) {
        return LiquidationViewLibrary.calculateHealthFactor(
            collateralValue,
            debtValue,
            liquidationThresholdVar * 1e16 // 转换为标准精度
        );
    }

    /**
     * 计算风险评分 - 计算用户风险评分
     * Calculate risk score - Calculate user risk score
     * @param healthFactor 健康因子 Health factor
     * @param collateralDiversity 抵押物多样性 Collateral diversity
     * @return riskScore 风险评分 Risk score
     */
    function calculateRiskScore(
        uint256 healthFactor,
        uint256 collateralDiversity
    ) external pure returns (uint256 riskScore) {
        return LiquidationViewLibrary.calculateRiskScore(healthFactor, collateralDiversity);
    }

    /* ============ 预览函数 ============ */
    
    /**
     * 预览清算结果 - 预览清算后的结果
     * Preview liquidation result - Preview result after liquidation
     * @param user 用户地址 User address
     * @param collateralAsset 抵押资产地址 Collateral asset address
     * @param debtAsset 债务资产地址 Debt asset address
     * @param collateralAmount 清算抵押物数量 Collateral amount
     * @param debtAmount 清算债务数量 Debt amount
     * @return bonus 清算奖励 Liquidation bonus
     * @return newHealthFactor 新健康因子 New health factor
     * @return newRiskScore 新风险评分 New risk score
     */
    function previewLiquidationResult(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external view returns (
        uint256 bonus,
        uint256 newHealthFactor,
        uint256 newRiskScore
    ) {
        // 使用 LiquidationViewLibrary 库预览清算结果
        (bonus, newHealthFactor, newRiskScore, ) = LiquidationViewLibrary.previewLiquidation(
            user,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            false, // 不模拟Flash Loan
            _baseStorage,
            _moduleCache
        );
    }

    /**
     * 预览Flash Loan影响 - 预览Flash Loan对清算的影响
     * Preview Flash Loan impact - Preview Flash Loan impact on liquidation
     * @param user 用户地址 User address
     * @param collateralAsset 抵押资产地址 Collateral asset address
     * @param debtAsset 债务资产地址 Debt asset address
     * @param collateralAmount 清算抵押物数量 Collateral amount
     * @param debtAmount 清算债务数量 Debt amount
     * @return impact Flash Loan影响 Flash Loan impact
     */
    function previewFlashLoanImpact(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external view returns (uint256 impact) {
        // 验证用户地址
        LiquidationBase.validateAddress(user, "User");
        
        return LiquidationViewLibrary._calculateFlashLoanImpact(
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            _baseStorage
        );
    }

    /* ============ 资产价值计算函数（带优雅降级） ============ */
    
    /**
     * 计算资产价值 - 使用优雅降级机制计算指定资产的价值
     * Calculate asset value - Calculate value of specified asset using graceful degradation
     * @param asset 资产地址 Asset address
     * @param amount 数量 Amount
     * @return value 价值 Value
     */
    function calculateAssetValue(
        address asset,
        uint256 amount
    ) external view returns (uint256 value) {
        if (asset == address(0)) revert LiquidationCalculator__InvalidAssetAddress(asset);
        if (amount == 0) return 0;
        if (_baseStorage.priceOracleAddr == address(0)) revert LiquidationCalculator__ModuleCallFailed(bytes32(0), _baseStorage.priceOracleAddr);

        // 创建优雅降级配置
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(_baseStorage.settlementTokenAddr);
        
        // 使用优雅降级获取资产价值
        GracefulDegradation.PriceResult memory result = 
            GracefulDegradation.getAssetValueWithFallback(_baseStorage.priceOracleAddr, asset, amount, config);
        
        // 发出相应的事件（注意：view函数不能发出事件，事件应该在调用此函数的非view函数中发出）
        if (result.usedFallback) {
            // 这里不能直接发出事件，因为这是view函数
            // 事件应该在调用此函数的非view函数中发出
        }
        
        return result.value;
    }

    /**
     * 批量计算资产价值 - 使用优雅降级机制批量计算多个资产的价值
     * Batch calculate asset values - Batch calculate values of multiple assets using graceful degradation
     * @param assets 资产地址数组 Asset addresses array
     * @param amounts 数量数组 Amounts array
     * @return values 价值数组 Values array
     */
    function batchCalculateAssetValues(
        address[] calldata assets,
        uint256[] calldata amounts
    ) external view returns (uint256[] memory values) {
        uint256 length = assets.length;
        if (length != amounts.length) revert LiquidationCalculator__InvalidArrayLength();
        
        values = new uint256[](length);
        
        // 创建优雅降级配置
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(_baseStorage.settlementTokenAddr);
        
        for (uint256 i = 0; i < length;) {
            if (assets[i] != address(0) && amounts[i] > 0) {
                GracefulDegradation.PriceResult memory result = 
                    GracefulDegradation.getAssetValueWithFallback(_baseStorage.priceOracleAddr, assets[i], amounts[i], config);
                values[i] = result.value;
            }
            unchecked { ++i; }
        }
    }

    /* ============ 用户价值计算函数（带优雅降级） ============ */
    
    /**
     * 计算用户总抵押物价值 - 使用优雅降级机制计算用户的总抵押物价值
     * Calculate user total collateral value - Calculate user's total collateral value using graceful degradation
     * @param user 用户地址 User address
     * @return totalValue 总价值 Total value
     */
    function calculateUserTotalCollateralValue(
        address user
    ) external view returns (uint256 totalValue) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        
        // 获取用户抵押物资产
        address[] memory assets = _getUserCollateralAssets(user);
        uint256 length = assets.length;
        
        // 创建优雅降级配置
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(_baseStorage.settlementTokenAddr);
        
        for (uint256 i = 0; i < length;) {
            address asset = assets[i];
            uint256 amount = _getUserCollateralAmount(user, asset);
            
            if (amount > 0) {
                // 使用优雅降级计算资产价值
                GracefulDegradation.PriceResult memory result = 
                    GracefulDegradation.getAssetValueWithFallback(_baseStorage.priceOracleAddr, asset, amount, config);
                
                totalValue += result.value;
            }
            unchecked { ++i; }
        }
    }

    /**
     * 计算用户总债务价值 - 计算用户的总债务价值
     * Calculate user total debt value - Calculate user's total debt value
     * @param user 用户地址 User address
     * @return totalValue 总价值 Total value
     */
    function calculateUserTotalDebtValue(
        address user
    ) external view returns (uint256 totalValue) {
        LiquidationValidationLibrary.validateAddress(user, "User");
        
        // 通过Registry获取借贷引擎地址
        address lendingEngine = ModuleCache.get(_moduleCache, ModuleKeys.KEY_LE, CACHE_MAX_AGE);
        if (lendingEngine == address(0)) {
            return 0;
        }
        
        // 调用借贷引擎的getUserTotalDebtValue函数
        (bool success, bytes memory data) = lendingEngine.staticcall(
            abi.encodeWithSignature("getUserTotalDebtValue(address)", user)
        );
        
        if (!success || data.length < 32) {
            return 0;
        }
        
        totalValue = abi.decode(data, (uint256));
    }

    /**
     * 计算用户净价值 - 计算用户的净价值（抵押物价值 - 债务价值）
     * Calculate user net value - Calculate user's net value (collateral value - debt value)
     * @param user 用户地址 User address
     * @return netValue 净价值 Net value
     */
    function calculateUserNetValue(
        address user
    ) external view returns (uint256 netValue) {
        uint256 collateralValue = this.calculateUserTotalCollateralValue(user);
        uint256 debtValue = this.calculateUserTotalDebtValue(user);
        
        if (collateralValue > debtValue) {
            netValue = collateralValue - debtValue;
        } else {
            netValue = 0;
        }
    }

    /* ============ 批量计算函数（带优雅降级） ============ */
    
    /**
     * 批量计算用户健康因子 - 使用优雅降级机制批量计算多个用户的健康因子
     * Batch calculate user health factors - Batch calculate health factors for multiple users using graceful degradation
     * @param users 用户地址数组 User addresses array
     * @return healthFactors 健康因子数组 Health factors array
     */
    function batchCalculateUserHealthFactors(
        address[] calldata users
    ) external view returns (uint256[] memory healthFactors) {
        uint256 length = users.length;
        healthFactors = new uint256[](length);
        
        // 创建优雅降级配置
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(_baseStorage.settlementTokenAddr);
        
        for (uint256 i = 0; i < length;) {
            address user = users[i];
            if (user != address(0)) {
                // 计算用户健康因子（使用优雅降级）
                uint256 collateralValue = _calculateUserTotalCollateralValueWithFallback(user, config);
                uint256 debtValue = _getUserTotalDebtValue(user);
                healthFactors[i] = _calculateHealthFactor(collateralValue, debtValue);
            }
            unchecked { ++i; }
        }
    }

    /**
     * 批量计算用户风险评分 - 批量计算多个用户的风险评分
     * Batch calculate user risk scores - Batch calculate risk scores for multiple users
     * @param users 用户地址数组 User addresses array
     * @return riskScores 风险评分数组 Risk scores array
     */
    function batchCalculateUserRiskScores(
        address[] calldata users
    ) external view returns (uint256[] memory riskScores) {
        return LiquidationViewLibrary.batchGetLiquidationRiskScores(users, _moduleCache);
    }

    /**
     * 批量计算用户净价值 - 批量计算多个用户的净价值
     * Batch calculate user net values - Batch calculate net values for multiple users
     * @param users 用户地址数组 User addresses array
     * @return netValues 净价值数组 Net values array
     */
    function batchCalculateUserNetValues(
        address[] calldata users
    ) external view returns (uint256[] memory netValues) {
        uint256 length = users.length;
        netValues = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            netValues[i] = this.calculateUserNetValue(users[i]);
            unchecked { ++i; }
        }
    }

    /* ============ 健康检查函数 ============ */
    
    /**
     * 检查价格预言机健康状态
     * Check price oracle health status
     * @param asset 资产地址 Asset address
     * @return isHealthy 是否健康 Is healthy
     * @return details 详细信息 Details
     */
    function checkPriceOracleHealth(address asset) external view returns (bool isHealthy, string memory details) {
        if (asset == address(0)) revert LiquidationCalculator__InvalidAssetAddress(asset);
        return GracefulDegradation.checkPriceOracleHealth(_baseStorage.priceOracleAddr, asset);
    }

    /* ============ 管理员函数 ============ */
    
    /**
     * 更新清算奖励比例
     * @param newRate 新的奖励比例（基点）
     */
    function updateLiquidationBonusRate(uint256 newRate) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        liquidationBonusRateVar = newRate;
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /**
     * 更新清算阈值
     * @param newThreshold 新的清算阈值（基点）
     */
    function updateLiquidationThreshold(uint256 newThreshold) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        liquidationThresholdVar = newThreshold;
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /**
     * 获取清算奖励比例
     * @return bonusRate 奖励比例
     */
    function getLiquidationBonusRate() external view returns (uint256 bonusRate) {
        return liquidationBonusRateVar;
    }

    /**
     * 获取清算阈值
     * @return threshold 清算阈值
     */
    function getLiquidationThreshold() external view returns (uint256 threshold) {
        return liquidationThresholdVar;
    }

    /* ============ 模块管理函数 ============ */
    
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

    /* ============ 内部辅助函数 ============ */
    
    /**
     * 获取用户抵押物资产列表
     * Get user collateral assets list
     * @param user 用户地址 User address
     * @return assets 资产地址数组 Asset addresses array
     */
    function _getUserCollateralAssets(address user) internal view returns (address[] memory assets) {
        // 通过Registry获取CollateralManager地址
        address collateralManager = ModuleCache.get(_moduleCache, ModuleKeys.KEY_CM, CACHE_MAX_AGE);
        if (collateralManager == address(0)) {
            // 如果无法获取CollateralManager，返回空数组
            return new address[](0);
        }
        
        // 调用CollateralManager的getUserCollateralAssets方法
        (bool success, bytes memory data) = collateralManager.staticcall(
            abi.encodeWithSignature("getUserCollateralAssets(address)", user)
        );
        
        if (!success || data.length == 0) {
            return new address[](0);
        }
        
        assets = abi.decode(data, (address[]));
    }

    /**
     * 获取用户抵押物数量
     * Get user collateral amount
     * @param user 用户地址 User address
     * @param asset 资产地址 Asset address
     * @return amount 数量 Amount
     */
    function _getUserCollateralAmount(address user, address asset) internal view returns (uint256 amount) {
        // 通过Registry获取CollateralManager地址
        address collateralManager = ModuleCache.get(_moduleCache, ModuleKeys.KEY_CM, CACHE_MAX_AGE);
        if (collateralManager == address(0)) {
            // 如果无法获取CollateralManager，返回0
            return 0;
        }
        
        // 调用CollateralManager的getCollateral方法
        (bool success, bytes memory data) = collateralManager.staticcall(
            abi.encodeWithSignature("getCollateral(address,address)", user, asset)
        );
        
        if (!success || data.length < 32) {
            return 0;
        }
        
        amount = abi.decode(data, (uint256));
    }

    /**
     * 使用优雅降级计算用户总抵押物价值
     * Calculate user total collateral value with graceful degradation
     * @param user 用户地址 User address
     * @param degradationConfig 降级配置 Degradation config
     * @return totalValue 总价值 Total value
     */
    function _calculateUserTotalCollateralValueWithFallback(
        address user,
        GracefulDegradation.DegradationConfig memory degradationConfig
    ) internal view returns (uint256 totalValue) {
        address[] memory assets = _getUserCollateralAssets(user);
        uint256 length = assets.length;
        
        for (uint256 i = 0; i < length;) {
            address asset = assets[i];
            uint256 amount = _getUserCollateralAmount(user, asset);
            
            if (amount > 0) {
                GracefulDegradation.PriceResult memory result = 
                    GracefulDegradation.getAssetValueWithFallback(_baseStorage.priceOracleAddr, asset, amount, degradationConfig);
                totalValue += result.value;
            }
            unchecked { ++i; }
        }
    }

    /**
     * 获取用户总债务价值
     * Get user total debt value
     * @param user 用户地址 User address
     * @return totalValue 总价值 Total value
     */
    function _getUserTotalDebtValue(address user) internal view returns (uint256 totalValue) {
        address lendingEngine = ModuleCache.get(_moduleCache, ModuleKeys.KEY_LE, CACHE_MAX_AGE);
        if (lendingEngine == address(0)) {
            return 0;
        }
        
        (bool success, bytes memory data) = lendingEngine.staticcall(
            abi.encodeWithSignature("getUserTotalDebtValue(address)", user)
        );
        
        if (!success || data.length < 32) {
            return 0;
        }
        
        totalValue = abi.decode(data, (uint256));
    }

    /**
     * 计算健康因子
     * Calculate health factor
     * @param collateralValue 抵押物价值 Collateral value
     * @param debtValue 债务价值 Debt value
     * @return healthFactor 健康因子 Health factor
     */
    function _calculateHealthFactor(uint256 collateralValue, uint256 debtValue) internal view returns (uint256 healthFactor) {
        if (debtValue == 0) {
            return type(uint256).max; // 无债务时健康因子为最大值
        }
        
        return (collateralValue * liquidationThresholdVar) / debtValue;
    }

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
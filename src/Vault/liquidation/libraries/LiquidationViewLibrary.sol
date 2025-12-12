// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LiquidationValidationLibrary.sol";
import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";

import "./LiquidationCoreOperations.sol";
import "./ModuleCache.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { VaultMath } from "../../VaultMath.sol";
import { ILiquidationDebtManager } from "../../../interfaces/ILiquidationDebtManager.sol";
import { ILiquidationCollateralManager } from "../../../interfaces/ILiquidationCollateralManager.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";

/**
 * @title 清算视图库
 * @title Liquidation View Library
 * @author RWA Lending Platform
 * @notice 提供清算查询相关功能，整合所有清算模块中重复的查询逻辑
 * @notice Provides liquidation query-related functionality, integrates all repeated query logic from liquidation modules
 * @dev 提供标准化的查询函数，确保一致性和可维护性
 * @dev Provides standardized query functions to ensure consistency and maintainability
 * @dev 按照ModuleCache_Usage_Guide.md规范使用ModuleCache
 * @dev Uses ModuleCache according to ModuleCache_Usage_Guide.md specifications
 */
library LiquidationViewLibrary {
    using LiquidationValidationLibrary for *;


    using ModuleCache for ModuleCache.ModuleCacheStorage;
    using VaultMath for uint256;
    using LiquidationBase for *;

    /* ============ Custom Errors ============ */
    
    /// @dev 用户地址无效错误
    error LiquidationViewLibrary__InvalidUserAddress(address user);
    
    /// @dev 资产地址无效错误
    error LiquidationViewLibrary__InvalidAssetAddress(address asset);
    
    /// @dev 批量操作数量过多错误
    error LiquidationViewLibrary__TooManyBatchOperations(uint256 count, uint256 maxCount);
    
    /// @dev 数组长度不匹配错误
    error LiquidationViewLibrary__ArrayLengthMismatch(uint256 length1, uint256 length2);
    
    /// @dev 模块调用失败错误
    error LiquidationViewLibrary__ModuleCallFailed(bytes32 moduleKey, address moduleAddress);

    /* ============ Constants ============ */
    
    /// @dev 最大批量操作数量
    uint256 public constant MAX_BATCH_OPERATIONS = 50;
    
    /// @dev 默认缓存过期时间
    uint256 public constant DEFAULT_CACHE_DURATION = 300; // 5分钟
    
    /// @dev 默认模块缓存最大有效期 - 按照ModuleCache规范
    uint256 public constant DEFAULT_CACHE_MAX_AGE = 1 days;

    /* ============ Health Factor Query Functions ============ */
    
    /**
     * @notice 获取用户健康因子
     * @notice Get user health factor
     * @param targetUserAddr 用户地址 User address
     * @param baseStorage 基础存储结构 Base storage structure
     * @param moduleCache 模块缓存 Module cache
     * @return healthFactor 健康因子 Health factor
     */
    function getUserHealthFactor(
        address targetUserAddr,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        mapping(address => uint256) storage /* healthFactorCache */
    ) internal view returns (uint256 healthFactor) {
        // 获取用户的总抵押物价值和债务价值
        (uint256 totalCollateralValue, uint256 totalDebtValue) = _getUserValues(targetUserAddr, baseStorage, moduleCache);
        
        // 获取清算阈值
        uint256 liquidationThreshold = _getLiquidationThreshold(baseStorage);
        
        // 计算健康因子
        healthFactor = calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
    }
    




    /* ============ Collateral Query Functions ============ */
    
    /**
     * @notice 获取用户可清算的抵押物数量
     * @notice Get user seizable collateral amount
     * @param targetUserAddr 用户地址 User address
     * @param targetAssetAddr 资产地址 Asset address
     * @param moduleCache 模块缓存 Module cache
     * @return seizableAmount 可清算数量 Seizable amount
     */
    function getSeizableCollateralAmount(
        address targetUserAddr,
        address targetAssetAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 seizableAmount) {
        if (targetUserAddr == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUserAddr);
        if (targetAssetAddr == address(0)) revert LiquidationViewLibrary__InvalidAssetAddress(targetAssetAddr);
        
        // 使用ModuleCache规范获取模块地址
        address collateralManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        
        if (collateralManagerAddr == address(0)) {
            revert LiquidationViewLibrary__ModuleCallFailed(ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER, collateralManagerAddr);
        }
        
        seizableAmount = ILiquidationCollateralManager(collateralManagerAddr).getSeizableCollateralAmount(targetUserAddr, targetAssetAddr);
    }
    
    /**
     * @notice 获取用户所有可清算的抵押物
     * @notice Get user all seizable collaterals
     * @param targetUserAddr 用户地址 User address
     * @param moduleCache 模块缓存 Module cache
     * @return assets 资产地址数组 Asset addresses array
     * @return amounts 数量数组 Amounts array
     */
    function getSeizableCollaterals(
        address targetUserAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (address[] memory assets, uint256[] memory amounts) {
        if (targetUserAddr == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUserAddr);
        
        // 使用ModuleCache规范获取模块地址
        address collateralManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        
        if (collateralManagerAddr == address(0)) {
            revert LiquidationViewLibrary__ModuleCallFailed(ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER, collateralManagerAddr);
        }
        
        (assets, amounts) = ILiquidationCollateralManager(collateralManagerAddr).getSeizableCollaterals(targetUserAddr);
    }

    /* ============ Debt Query Functions ============ */
    
    /**
     * @notice 获取用户可清算的债务数量
     * @notice Get user reducible debt amount
     * @param targetUserAddr 用户地址 User address
     * @param targetAssetAddr 资产地址 Asset address
     * @param moduleCache 模块缓存 Module cache
     * @return reducibleAmount 可清算数量 Reducible amount
     */
    function getReducibleDebtAmount(
        address targetUserAddr,
        address targetAssetAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 reducibleAmount) {
        if (targetUserAddr == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUserAddr);
        if (targetAssetAddr == address(0)) revert LiquidationViewLibrary__InvalidAssetAddress(targetAssetAddr);

        // 以 LendingEngine 为准：通过 KEY_LE 查询可减少债务
        address lendingEngineAddr = ModuleCache.get(
            moduleCache,
            ModuleKeys.KEY_LE,
            DEFAULT_CACHE_MAX_AGE
        );
        if (lendingEngineAddr == address(0)) {
            revert LiquidationViewLibrary__ModuleCallFailed(ModuleKeys.KEY_LE, lendingEngineAddr);
        }
        try ILendingEngineBasic(lendingEngineAddr).getReducibleDebtAmount(targetUserAddr, targetAssetAddr) returns (uint256 amount) {
            return amount;
        } catch {
            return 0;
        }
    }
    
    /**
     * @notice 获取用户所有可清算的债务
     * @notice Get user all reducible debts
     * @param targetUserAddr 用户地址 User address
     * @param moduleCache 模块缓存 Module cache
     * @return assets 资产地址数组 Asset addresses array
     * @return amounts 数量数组 Amounts array
     */
    function getReducibleDebts(
        address targetUserAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (address[] memory assets, uint256[] memory amounts) {
        if (targetUserAddr == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUserAddr);
        
        // 使用ModuleCache规范获取模块地址
        address debtManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_DEBT_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        
        if (debtManagerAddr == address(0)) {
            revert LiquidationViewLibrary__ModuleCallFailed(ModuleKeys.KEY_LIQUIDATION_DEBT_MANAGER, debtManagerAddr);
        }
        
        // 注意：getReducibleDebts 方法已从接口中移除
        // 这里返回空数组，实际实现应该通过其他方式获取
        assets = new address[](0);
        amounts = new uint256[](0);
    }

    /* ============ Preview Functions ============ */
    
    /**
     * @notice 预览清算效果
     * @notice Preview liquidation effect
     * @param targetUserAddr 用户地址 User address
     * @param collateralAssetAddr 抵押资产地址 Collateral asset address
     * @param debtAssetAddr 债务资产地址 Debt asset address
     * @param collateralAmount 清算抵押物数量 Collateral amount
     * @param debtAmount 清算债务数量 Debt amount
     * @param simulateFlashLoan 是否模拟Flash Loan影响 Whether to simulate Flash Loan impact
     * @param baseStorage 基础存储结构 Base storage structure
     * @param moduleCache 模块缓存 Module cache
     * @return bonus 清算奖励 Liquidation bonus
     * @return newHealthFactor 新的健康因子 New health factor
     * @return newRiskScore 新的风险评分 New risk score
     * @return slippageImpact 滑点影响 Slippage impact
     */
    function previewLiquidation(
        address targetUserAddr,
        address collateralAssetAddr,
        address debtAssetAddr,
        uint256 collateralAmount,
        uint256 debtAmount,
        bool simulateFlashLoan,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (
        uint256 bonus,
        uint256 newHealthFactor,
        uint256 newRiskScore,
        uint256 slippageImpact
    ) {
        if (targetUserAddr == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUserAddr);
        if (collateralAssetAddr == address(0)) revert LiquidationViewLibrary__InvalidAssetAddress(collateralAssetAddr);
        if (debtAssetAddr == address(0)) revert LiquidationViewLibrary__InvalidAssetAddress(debtAssetAddr);
        
        // 计算清算奖励（简化版本）
        bonus = (collateralAmount + debtAmount) * 50 / 10000; // 0.5% 基础奖励
        
        // 计算新的健康因子
        newHealthFactor = _calculatePreviewHealthFactor(
            targetUserAddr,
            collateralAmount,
            debtAmount,
            baseStorage,
            moduleCache
        );
        
        // 计算新的风险评分
        newRiskScore = _calculatePreviewRiskScore(
            targetUserAddr,
            collateralAmount,
            debtAmount,
            baseStorage,
            moduleCache
        );
        
        // 计算Flash Loan影响
        if (simulateFlashLoan) {
            slippageImpact = _calculateFlashLoanImpact(
                collateralAssetAddr,
                debtAssetAddr,
                collateralAmount,
                debtAmount,
                baseStorage
            );
            bonus = bonus > slippageImpact ? bonus - slippageImpact : 0;
        } else {
            slippageImpact = 0;
        }
        
        return (bonus, newHealthFactor, newRiskScore, slippageImpact);
    }

    /* ============ Internal Helper Functions ============ */
    
    /**
     * @notice 获取用户价值（抵押物和债务）
     * @notice Get user values (collateral and debt)
     * @param targetUserAddr 用户地址 User address
     * @param moduleCache 模块缓存 Module cache
     * @return collateralValue 抵押物价值 Collateral value
     * @return debtValue 债务价值 Debt value
     */
    function _getUserValues(
        address targetUserAddr,
        LiquidationBase.BaseStorage storage /* baseStorage */,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 collateralValue, uint256 debtValue) {
        // 获取抵押物价值 - 使用ModuleCache规范
        address collateralManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        if (collateralManagerAddr != address(0)) {
            collateralValue = ILiquidationCollateralManager(collateralManagerAddr).getUserTotalCollateralValue(targetUserAddr);
        }
        
        // 获取债务价值 - 使用ModuleCache规范
        address debtManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_DEBT_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        if (debtManagerAddr != address(0)) {
            // 注意：getUserTotalDebtValue 方法已从接口中移除
            // 这里返回0，实际实现应该通过其他方式获取
            debtValue = 0;
        }
    }

    /**
     * @notice 获取用户价值（简化版本，不需要BaseStorage）
     * @notice Get user values (simplified version, no BaseStorage required)
     * @param targetUserAddr 用户地址 User address
     * @param moduleCache 模块缓存 Module cache
     * @return collateralValue 抵押物价值 Collateral value
     * @return debtValue 债务价值 Debt value
     */
    function _getUserValuesSimple(
        address targetUserAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 collateralValue, uint256 debtValue) {
        // 获取抵押物价值 - 使用ModuleCache规范
        address collateralManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        if (collateralManagerAddr != address(0)) {
            collateralValue = ILiquidationCollateralManager(collateralManagerAddr).getUserTotalCollateralValue(targetUserAddr);
        }
        
        // 获取债务价值 - 使用ModuleCache规范
        address debtManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_DEBT_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        if (debtManagerAddr != address(0)) {
            // 注意：getUserTotalDebtValue 方法已从接口中移除
            // 这里返回0，实际实现应该通过其他方式获取
            debtValue = 0;
        }
    }
    
    /**
     * @notice 获取清算阈值
     * @notice Get liquidation threshold
     * @return threshold 清算阈值 Liquidation threshold
     */
    function _getLiquidationThreshold(
        LiquidationBase.BaseStorage storage /* baseStorage */
    ) internal pure returns (uint256 threshold) {
        // 简化版本，使用默认清算阈值
        threshold = 1e18; // 默认100%
    }
    
    /**
     * @notice 计算预览健康因子
     * @notice Calculate preview health factor
     * @param targetUserAddr 用户地址 User address
     * @param collateralAmount 抵押物数量 Collateral amount
     * @param debtAmount 债务数量 Debt amount
     * @param baseStorage 基础存储结构 Base storage structure
     * @param moduleCache 模块缓存 Module cache
     * @return newHealthFactor 新的健康因子 New health factor
     */
    function _calculatePreviewHealthFactor(
        address targetUserAddr,
        uint256 collateralAmount,
        uint256 debtAmount,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 newHealthFactor) {
        (uint256 currentCollateralValue, uint256 currentDebtValue) = _getUserValues(targetUserAddr, baseStorage, moduleCache);
        
        // 计算新的价值
        uint256 newCollateralValue = currentCollateralValue > collateralAmount ? currentCollateralValue - collateralAmount : 0;
        uint256 newDebtValue = currentDebtValue > debtAmount ? currentDebtValue - debtAmount : 0;
        
        // 计算新的健康因子
        uint256 liquidationThreshold = _getLiquidationThreshold(baseStorage);
        newHealthFactor = calculateHealthFactor(newCollateralValue, newDebtValue, liquidationThreshold);
    }
    
    /**
     * @notice 计算预览风险评分
     * @notice Calculate preview risk score
     * @param targetUserAddr 用户地址 User address
     * @param collateralAmount 抵押物数量 Collateral amount
     * @param debtAmount 债务数量 Debt amount
     * @param baseStorage 基础存储结构 Base storage structure
     * @param moduleCache 模块缓存 Module cache
     * @return newRiskScore 新的风险评分 New risk score
     */
    function _calculatePreviewRiskScore(
        address targetUserAddr,
        uint256 collateralAmount,
        uint256 debtAmount,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 newRiskScore) {
        (uint256 currentCollateralValue, uint256 currentDebtValue) = _getUserValues(targetUserAddr, baseStorage, moduleCache);
        
        // 计算新的价值
        uint256 newCollateralValue = currentCollateralValue > collateralAmount ? currentCollateralValue - collateralAmount : 0;
        uint256 newDebtValue = currentDebtValue > debtAmount ? currentDebtValue - debtAmount : 0;
        
        // 计算新的风险评分
        uint256 liquidationThreshold = _getLiquidationThreshold(baseStorage);
        uint256 newHealthFactor = calculateHealthFactor(newCollateralValue, newDebtValue, liquidationThreshold);
        newRiskScore = calculateRiskScore(newHealthFactor, 1e18); // 简化版本，使用默认值
    }
    
    /**
     * @notice 计算Flash Loan影响（使用优雅降级）
     * @notice Calculate Flash Loan impact (with graceful degradation)
     * @param collateralAssetAddr 抵押资产地址 Collateral asset address
     * @param debtAssetAddr 债务资产地址 Debt asset address
     * @param collateralAmount 抵押物数量 Collateral amount
     * @param debtAmount 债务数量 Debt amount
     * @param baseStorage 基础存储结构 Base storage structure
     * @return impact Flash Loan影响 Flash Loan impact
     */
    function _calculateFlashLoanImpact(
        address collateralAssetAddr,
        address debtAssetAddr,
        uint256 collateralAmount,
        uint256 debtAmount,
        LiquidationBase.BaseStorage storage baseStorage
    ) internal view returns (uint256 impact) {
        // 创建优雅降级配置
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(baseStorage.settlementTokenAddr);
        
        // 获取抵押物价格（使用优雅降级）
        uint256 collateralPrice = 0;
        if (baseStorage.priceOracleAddr != address(0)) {
            GracefulDegradation.PriceResult memory collateralResult = 
                GracefulDegradation.getAssetValueWithFallback(baseStorage.priceOracleAddr, collateralAssetAddr, 1e18, config);
            collateralPrice = collateralResult.value;
        }
        
        // 获取债务价格（使用优雅降级）
        uint256 debtPrice = 0;
        if (baseStorage.priceOracleAddr != address(0)) {
            GracefulDegradation.PriceResult memory debtResult = 
                GracefulDegradation.getAssetValueWithFallback(baseStorage.priceOracleAddr, debtAssetAddr, 1e18, config);
            debtPrice = debtResult.value;
        }
        
        // 计算市场冲击
        uint256 marketImpact = _calculateMarketImpact(collateralAmount, debtAmount);
        
        // 计算滑点影响
        if (collateralPrice > 0 && debtPrice > 0) {
            impact = (marketImpact * (collateralPrice + debtPrice)) / 10000;
        } else {
            impact = 0;
        }
    }
    
    /**
     * @notice 计算市场冲击
     * @notice Calculate market impact
     * @param collateralAmount 抵押物数量 Collateral amount
     * @param debtAmount 债务数量 Debt amount
     * @return impact 市场冲击 Market impact
     */
    function _calculateMarketImpact(
        uint256 collateralAmount,
        uint256 debtAmount
    ) internal pure returns (uint256 impact) {
        // 简化的市场冲击计算
        uint256 totalAmount = collateralAmount + debtAmount;
        if (totalAmount == 0) {
            return 0;
        }
        
        // 基于总量的线性冲击模型
        impact = (totalAmount * 50) / 10000; // 0.5% 基础冲击
        
        return impact;
    }

    /* ============ Calculation Functions ============ */
    
    /**
     * @notice 计算健康因子 - 计算用户的健康因子
     * @notice Calculate health factor - Calculate user's health factor
     * @param totalCollateralValueInput 总抵押物价值 Total collateral value
     * @param totalDebtValueInput 总债务价值 Total debt value
     * @param liquidationThresholdValue 清算阈值 Liquidation threshold
     * @return healthFactor 健康因子 Health factor
     */
    function calculateHealthFactor(
        uint256 totalCollateralValueInput,
        uint256 totalDebtValueInput,
        uint256 liquidationThresholdValue
    ) internal pure returns (uint256 healthFactor) {
        if (totalDebtValueInput == 0) {
            return 1e20; // MAX_HEALTH_FACTOR
        }
        
        // 健康因子 = (总抵押物价值 * 清算阈值) / 总债务价值
        // Health factor = (Total collateral value * liquidation threshold) / Total debt value
        healthFactor = (totalCollateralValueInput * liquidationThresholdValue) / totalDebtValueInput;
        
        // 限制在有效范围内
        // Limit to valid range
        if (healthFactor > 1e20) {
            healthFactor = 1e20;
        } else if (healthFactor < 1e15) {
            healthFactor = 1e15;
        }
    }

    /**
     * @notice 计算风险评分 - 计算用户的风险评分
     * @notice Calculate risk score - Calculate user's risk score
     * @param healthFactor 健康因子 Health factor
     * @param collateralDiversity 抵押物多样性 Collateral diversity
     * @return riskScore 风险评分 Risk score
     */
    function calculateRiskScore(
        uint256 healthFactor,
        uint256 collateralDiversity
    ) internal pure returns (uint256 riskScore) {
        // 基于健康因子计算基础风险评分
        // Calculate base risk score based on health factor
        if (healthFactor >= 1e20) {
            riskScore = 0; // MIN_RISK_SCORE
        } else if (healthFactor <= 1e15) {
            riskScore = 1000; // MAX_RISK_SCORE
        } else {
            // 线性插值计算风险评分
            // Linear interpolation to calculate risk score
            riskScore = 1000 - ((healthFactor - 1e15) * 1000) / (1e20 - 1e15);
        }
        
        // 根据抵押物多样性调整风险评分
        // Adjust risk score based on collateral diversity
        if (collateralDiversity > 3) {
            riskScore = riskScore * 80 / 100; // 多样性好，风险降低20%
        } else if (collateralDiversity == 1) {
            riskScore = riskScore * 120 / 100; // 单一抵押物，风险增加20%
        }
        
        // 限制在有效范围内
        // Limit to valid range
        if (riskScore > 1000) {
            riskScore = 1000;
        } else if (riskScore < 0) {
            riskScore = 0;
        }
    }

    /**
     * @notice 获取用户风险评分 - 获取用户的风险评分
     * @notice Get user risk score - Get user's risk score
     * @param targetUserAddr 用户地址 User address
     * @param baseStorage 基础存储结构 Base storage structure
     * @param moduleCache 模块缓存 Module cache
     * @return riskScore 风险评分 Risk score
     */
    function getUserRiskScore(
        address targetUserAddr,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 riskScore) {
        // 获取用户健康因子 - 直接调用内部函数
        (uint256 totalCollateralValue, uint256 totalDebtValue) = _getUserValues(targetUserAddr, baseStorage, moduleCache);
        uint256 liquidationThreshold = _getLiquidationThreshold(baseStorage);
        uint256 healthFactor = calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
        
        // 获取抵押物多样性
        uint256 collateralDiversity = _getCollateralDiversity(targetUserAddr, moduleCache);
        
        // 计算风险评分
        riskScore = calculateRiskScore(healthFactor, collateralDiversity);
    }

    /**
     * @notice 获取清算风险评分 - 获取用户的清算风险评分
     * @notice Get liquidation risk score - Get user's liquidation risk score
     * @param targetUserAddr 用户地址 User address
     * @param moduleCache 模块缓存 Module cache
     * @return riskScore 风险评分 Risk score
     */
    function getLiquidationRiskScore(
        address targetUserAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 riskScore) {
        // 获取用户健康因子 - 简化版本
        (uint256 totalCollateralValue, uint256 totalDebtValue) = _getUserValuesSimple(targetUserAddr, moduleCache);
        uint256 liquidationThreshold = 1e18; // 默认100%
        uint256 healthFactor = calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
        
        // 获取抵押物多样性
        uint256 collateralDiversity = _getCollateralDiversity(targetUserAddr, moduleCache);
        
        // 计算风险评分
        riskScore = calculateRiskScore(healthFactor, collateralDiversity);
    }

    /**
     * @notice 获取缓存健康因子 - 获取用户的缓存健康因子
     * @notice Get cached health factor - Get user's cached health factor
     * @param user 用户地址 User address
     * @param cache 缓存映射 Cache mapping
     * @return healthFactor 健康因子 Health factor
     */
    function getCachedHealthFactor(
        address user,
        mapping(address => uint256) storage cache
    ) internal view returns (uint256 healthFactor) {
        healthFactor = cache[user];
        if (healthFactor == 0) {
            return 0;
        }
        return healthFactor;
    }

    /**
     * @notice 获取抵押物多样性 - 获取用户的抵押物多样性
     * @notice Get collateral diversity - Get user's collateral diversity
     * @return diversity 多样性 Diversity
     */
    function _getCollateralDiversity(
        address /* targetUserAddr */,
        ModuleCache.ModuleCacheStorage storage /* moduleCache */
    ) internal pure returns (uint256 diversity) {
        // 简化版本，返回默认值
        // Simplified version, return default value
        return 1e18; // 默认多样性值
    }

    /* ============ Bonus Calculation Functions ============ */
    
    /**
     * @notice 计算清算奖励 - 计算清算奖励
     * @notice Calculate liquidation bonus - Calculate liquidation bonus
     * @param seizedAmount 扣押数量 Seized amount
     * @param bonusRate 奖励比例 Bonus rate
     * @return bonus 清算奖励 Liquidation bonus
     */
    function calculateLiquidationBonus(
        uint256 seizedAmount,
        uint256 /* reducedAmount */,
        uint256 bonusRate
    ) internal pure returns (uint256 bonus) {
        // 计算奖励：扣押数量 * 奖励比例
        // Calculate bonus: seized amount * bonus rate
        bonus = (seizedAmount * bonusRate) / 1e18; // 使用标准精度
    }

    /**
     * @notice 计算清算奖励 - 从配置存储计算
     * @notice Calculate liquidation bonus from config storage
     * @param seizedAmount 扣押数量 Seized amount
     * @param reducedAmount 减少数量 Reduced amount
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @return bonus 清算奖励 Liquidation bonus
     */
    function calculateLiquidationBonus(
        uint256 seizedAmount,
        uint256 reducedAmount,
        mapping(bytes32 => uint256) storage liquidationConfigStorage
    ) internal view returns (uint256 bonus) {
        uint256 bonusRate = liquidationConfigStorage[keccak256("LIQUIDATION_BONUS_RATE")];
        bonus = calculateLiquidationBonus(seizedAmount, reducedAmount, bonusRate);
    }

    /* ============ Batch Query Functions ============ */
    
    /**
     * @notice 批量获取可减少金额
     * @notice Batch get reducible amounts
     * @param userAddresses 用户地址数组 User addresses array
     * @param assetAddresses 资产地址数组 Asset addresses array
     * @param lendingEngine 借贷引擎地址 Lending engine address
     * @return reducibleAmounts 可减少金额数组 Reducible amounts array
     */
    function batchGetReducibleAmounts(
        address[] calldata userAddresses,
        address[] calldata assetAddresses,
        address lendingEngine
    ) internal view returns (uint256[] memory reducibleAmounts) {
        uint256 length = userAddresses.length;
        reducibleAmounts = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            if (lendingEngine != address(0)) {
                try ILendingEngineBasic(lendingEngine).getReducibleDebtAmount(userAddresses[i], assetAddresses[i]) returns (uint256 amount) {
                    reducibleAmounts[i] = amount;
                } catch {
                    reducibleAmounts[i] = 0;
                }
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice 批量计算债务价值
     * @notice Batch calculate debt values
     * @param userAddresses 用户地址数组 User addresses array
     * @param assetAddresses 资产地址数组 Asset addresses array
     * @param lendingEngine 借贷引擎地址 Lending engine address
     * @return debtValues 债务价值数组 Debt values array
     */
    function batchCalculateDebtValues(
        address[] calldata userAddresses,
        address[] calldata assetAddresses,
        address lendingEngine
    ) internal view returns (uint256[] memory debtValues) {
        uint256 length = userAddresses.length;
        debtValues = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            if (lendingEngine != address(0)) {
                try ILendingEngineBasic(lendingEngine).calculateDebtValue(userAddresses[i], assetAddresses[i]) returns (uint256 value) {
                    debtValues[i] = value;
                } catch {
                    debtValues[i] = 0;
                }
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice 批量获取用户健康因子
     * @notice Batch get user health factors
     * @param userAddresses 用户地址数组 User addresses array
     * @param baseStorage 基础存储结构 Base storage structure
     * @param moduleCache 模块缓存 Module cache
     * @return healthFactors 健康因子数组 Health factors array
     */
    function batchGetUserHealthFactors(
        address[] calldata userAddresses,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory healthFactors) {
        uint256 length = userAddresses.length;
        healthFactors = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            // 直接调用内部计算函数，避免缓存参数
            (uint256 totalCollateralValue, uint256 totalDebtValue) = _getUserValues(userAddresses[i], baseStorage, moduleCache);
            uint256 liquidationThreshold = _getLiquidationThreshold(baseStorage);
            healthFactors[i] = calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
            unchecked { ++i; }
        }
    }

    /**
     * @notice 批量获取用户风险评分
     * @notice Batch get user risk scores
     * @param userAddresses 用户地址数组 User addresses array
     * @param baseStorage 基础存储结构 Base storage structure
     * @param moduleCache 模块缓存 Module cache
     * @return riskScores 风险评分数组 Risk scores array
     */
    function batchGetUserRiskScores(
        address[] calldata userAddresses,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory riskScores) {
        uint256 length = userAddresses.length;
        riskScores = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            riskScores[i] = getUserRiskScore(userAddresses[i], baseStorage, moduleCache);
            unchecked { ++i; }
        }
    }

    /**
     * @notice 批量预览清算效果
     * @notice Batch preview liquidation effects
     * @param targetUsers 用户地址数组 User addresses array
     * @param collateralAssets 抵押资产地址数组 Collateral asset addresses array
     * @param debtAssets 债务资产地址数组 Debt asset addresses array
     * @param collateralAmounts 清算抵押物数量数组 Collateral amounts array
     * @param debtAmounts 清算债务数量数组 Debt amounts array
     * @param simulateFlashLoan 是否模拟Flash Loan影响数组 Whether to simulate Flash Loan impact array
     * @param baseStorage 基础存储结构 Base storage structure
     * @param moduleCache 模块缓存 Module cache
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
        bool[] calldata simulateFlashLoan,
        LiquidationBase.BaseStorage storage baseStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (
        uint256[] memory bonuses,
        uint256[] memory newHealthFactors,
        uint256[] memory newRiskScores,
        uint256[] memory slippageImpacts
    ) {
        uint256 length = targetUsers.length;
        bonuses = new uint256[](length);
        newHealthFactors = new uint256[](length);
        newRiskScores = new uint256[](length);
        slippageImpacts = new uint256[](length);

        for (uint256 i = 0; i < length;) {
            (
                bonuses[i],
                newHealthFactors[i],
                newRiskScores[i],
                slippageImpacts[i]
            ) = previewLiquidation(
                targetUsers[i],
                collateralAssets[i],
                debtAssets[i],
                collateralAmounts[i],
                debtAmounts[i],
                simulateFlashLoan[i],
                baseStorage,
                moduleCache
            );
            unchecked { ++i; }
        }
    }

    /* ============ Collateral Batch Query Functions ============ */
    
    /**
     * @notice 批量获取可清算抵押物数量
     * @notice Batch get seizable collateral amounts
     * @param targetUsers 用户地址数组 User addresses array
     * @param targetAssets 资产地址数组 Asset addresses array
     * @param moduleCache 模块缓存 Module cache
     * @return seizableAmounts 可清算数量数组 Seizable amounts array
     */
    function batchGetSeizableAmounts(
        address[] calldata targetUsers,
        address[] calldata targetAssets,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory seizableAmounts) {
        if (targetUsers.length != targetAssets.length) revert LiquidationViewLibrary__ArrayLengthMismatch(targetUsers.length, targetAssets.length);
        if (targetUsers.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(targetUsers.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = targetUsers.length;
        seizableAmounts = new uint256[](length);
        
        // 使用ModuleCache规范获取模块地址
        address collateralManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        
        if (collateralManagerAddr != address(0)) {
            for (uint256 i = 0; i < length;) {
                if (targetUsers[i] != address(0) && targetAssets[i] != address(0)) {
                    try ILiquidationCollateralManager(collateralManagerAddr).getSeizableCollateralAmount(targetUsers[i], targetAssets[i]) returns (uint256 amount) {
                        seizableAmounts[i] = amount;
                    } catch {
                        seizableAmounts[i] = 0;
                    }
                }
                unchecked { ++i; }
            }
        }
    }

    /**
     * @notice 批量计算抵押物价值
     * @notice Batch calculate collateral values
     * @param targetAssets 资产地址数组 Asset addresses array
     * @param targetAmounts 数量数组 Amounts array
     * @param moduleCache 模块缓存 Module cache
     * @return values 价值数组 Values array
     */
    function batchCalculateCollateralValues(
        address[] calldata targetAssets,
        uint256[] calldata targetAmounts,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory values) {
        if (targetAssets.length != targetAmounts.length) revert LiquidationViewLibrary__ArrayLengthMismatch(targetAssets.length, targetAmounts.length);
        if (targetAssets.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(targetAssets.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = targetAssets.length;
        values = new uint256[](length);
        
        // 使用ModuleCache规范获取模块地址
        address collateralManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        
        if (collateralManagerAddr != address(0)) {
            for (uint256 i = 0; i < length;) {
                if (targetAssets[i] != address(0)) {
                    try ILiquidationCollateralManager(collateralManagerAddr).calculateCollateralValue(targetAssets[i], targetAmounts[i]) returns (uint256 value) {
                        values[i] = value;
                    } catch {
                        values[i] = 0;
                    }
                }
                unchecked { ++i; }
            }
        }
    }

    /**
     * @notice 批量获取用户总抵押物价值
     * @notice Batch get user total collateral values
     * @param targetUsers 用户地址数组 User addresses array
     * @param moduleCache 模块缓存 Module cache
     * @return totalValues 总价值数组 Total values array
     */
    function batchGetUserTotalCollateralValues(
        address[] calldata targetUsers,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory totalValues) {
        if (targetUsers.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(targetUsers.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = targetUsers.length;
        totalValues = new uint256[](length);
        
        // 使用ModuleCache规范获取模块地址
        address collateralManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        
        if (collateralManagerAddr != address(0)) {
            for (uint256 i = 0; i < length;) {
                if (targetUsers[i] != address(0)) {
                    try ILiquidationCollateralManager(collateralManagerAddr).getUserTotalCollateralValue(targetUsers[i]) returns (uint256 value) {
                        totalValues[i] = value;
                    } catch {
                        totalValues[i] = 0;
                    }
                }
                unchecked { ++i; }
            }
        }
    }

    /**
     * @notice 批量预览清算抵押物状态
     * @notice Batch preview liquidation collateral states
     * @param targetUsers 用户地址数组 User addresses array
     * @param targetAssets 资产地址数组 Asset addresses array
     * @param seizeAmounts 扣押数量数组 Seize amounts array
     * @param moduleCache 模块缓存 Module cache
     * @return newCollateralAmounts 新抵押物数量数组 New collateral amounts array
     * @return newTotalValues 新总价值数组 New total values array
     */
    function batchPreviewLiquidationCollateralStates(
        address[] calldata targetUsers,
        address[] calldata targetAssets,
        uint256[] calldata seizeAmounts,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (
        uint256[] memory newCollateralAmounts,
        uint256[] memory newTotalValues
    ) {
        if (targetUsers.length != targetAssets.length || targetUsers.length != seizeAmounts.length) {
            revert LiquidationViewLibrary__ArrayLengthMismatch(targetUsers.length, targetAssets.length);
        }
        if (targetUsers.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(targetUsers.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = targetUsers.length;
        newCollateralAmounts = new uint256[](length);
        newTotalValues = new uint256[](length);
        
        // 使用ModuleCache规范获取模块地址
        address collateralManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_COLLATERAL_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        
        if (collateralManagerAddr != address(0)) {
            for (uint256 i = 0; i < length;) {
                if (targetUsers[i] != address(0) && targetAssets[i] != address(0)) {
                    try ILiquidationCollateralManager(collateralManagerAddr).previewLiquidationCollateralState(
                        targetUsers[i], 
                        targetAssets[i], 
                        seizeAmounts[i]
                    ) returns (uint256 newCollateralAmount, uint256 newTotalValue) {
                        newCollateralAmounts[i] = newCollateralAmount;
                        newTotalValues[i] = newTotalValue;
                    } catch {
                        newCollateralAmounts[i] = 0;
                        newTotalValues[i] = 0;
                    }
                }
                unchecked { ++i; }
            }
        }
    }

    /* ============ Debt Record Batch Query Functions ============ */
    
    /**
     * @notice 批量获取用户清算债务记录
     * @notice Batch get liquidation debt records
     * @param users 用户地址数组 User addresses array
     * @param assets 资产地址数组 Asset addresses array
     * @param moduleCache 模块缓存 Module cache
     * @return reducedAmounts 已清算债务数量数组 Reduced debt amounts array
     * @return lastReducedTimes 最后清算时间数组 Last reduction times array
     */
    function batchGetLiquidationDebtRecords(
        address[] calldata users,
        address[] calldata assets,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (
        uint256[] memory reducedAmounts,
        uint256[] memory lastReducedTimes
    ) {
        if (users.length != assets.length) revert LiquidationViewLibrary__ArrayLengthMismatch(users.length, assets.length);
        if (users.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(users.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = users.length;
        reducedAmounts = new uint256[](length);
        lastReducedTimes = new uint256[](length);
        
        // 使用ModuleCache规范获取模块地址
        address debtRecordManagerAddr = ModuleCache.get(
            moduleCache, 
            ModuleKeys.KEY_LIQUIDATION_DEBT_MANAGER,
            DEFAULT_CACHE_MAX_AGE
        );
        
        if (debtRecordManagerAddr != address(0)) {
            for (uint256 i = 0; i < length;) {
                if (users[i] != address(0) && assets[i] != address(0)) {
                    try ILiquidationDebtManager(debtRecordManagerAddr).getLiquidationDebtRecord(users[i], assets[i]) returns (
                        uint256 reducedAmount, 
                        uint256 lastReducedTime
                    ) {
                        reducedAmounts[i] = reducedAmount;
                        lastReducedTimes[i] = lastReducedTime;
                    } catch {
                        reducedAmounts[i] = 0;
                        lastReducedTimes[i] = 0;
                    }
                }
                unchecked { ++i; }
            }
        }
    }

    /* ============ Risk Management Batch Query Functions ============ */
    
    /**
     * @notice 批量获取清算风险评分
     * @notice Batch get liquidation risk scores
     * @param users 用户地址数组 User addresses array
     * @param moduleCache 模块缓存 Module cache
     * @return riskScores 风险评分数组 Risk scores array
     */
    function batchGetLiquidationRiskScores(
        address[] calldata users,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory riskScores) {
        if (users.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(users.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = users.length;
        riskScores = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            riskScores[i] = getLiquidationRiskScore(users[i], moduleCache);
            unchecked { ++i; }
        }
    }

    /**
     * @notice 批量获取用户健康因子（简化版本）
     * @notice Batch get user health factors (simplified version)
     * @param users 用户地址数组 User addresses array
     * @param moduleCache 模块缓存 Module cache
     * @return healthFactors 健康因子数组 Health factors array
     */
    function batchGetUserHealthFactorsSimple(
        address[] calldata users,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory healthFactors) {
        if (users.length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(users.length, MAX_BATCH_OPERATIONS);
        
        uint256 length = users.length;
        healthFactors = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            (uint256 totalCollateralValue, uint256 totalDebtValue) = _getUserValuesSimple(users[i], moduleCache);
            uint256 liquidationThreshold = 1e18; // 默认100%
            healthFactors[i] = calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
            unchecked { ++i; }
        }
    }

    /* ============ Advanced Query Functions ============ */
    
    /**
     * @notice 计算最优清算组合
     * @notice Calculate optimal liquidation combination
     * @param targetUser 用户地址 User address
     * @param maxDebtReduction 最大债务减少量 Maximum debt reduction
     * @param maxCollateralReduction 最大抵押物减少量 Maximum collateral reduction
     * @param lendingEngine 借贷引擎地址 Lending engine address
     * @return optimalDebtReduction 最优债务减少量 Optimal debt reduction
     * @return optimalCollateralReduction 最优抵押物减少量 Optimal collateral reduction
     * @return healthFactor 健康因子 Health factor
     */
    function calculateOptimalLiquidationCombination(
        address targetUser,
        uint256 maxDebtReduction,
        uint256 maxCollateralReduction,
        address lendingEngine
    ) internal view returns (
        uint256 optimalDebtReduction,
        uint256 optimalCollateralReduction,
        uint256 healthFactor
    ) {
        if (lendingEngine != address(0)) {
            try ILendingEngineBasic(lendingEngine).calculateOptimalLiquidation(
                targetUser,
                maxDebtReduction,
                maxCollateralReduction
            ) returns (
                uint256 debtReduction,
                uint256 collateralReduction,
                uint256 hf
            ) {
                optimalDebtReduction = debtReduction;
                optimalCollateralReduction = collateralReduction;
                healthFactor = hf;
            } catch {
                optimalDebtReduction = 0;
                optimalCollateralReduction = 0;
                healthFactor = 0;
            }
        } else {
            optimalDebtReduction = 0;
            optimalCollateralReduction = 0;
            healthFactor = 0;
        }
    }

    /**
     * @notice 预览清算债务状态
     * @notice Preview liquidation debt state
     * @param targetUser 用户地址 User address
     * @param debtReduction 债务减少量 Debt reduction
     * @param collateralReduction 抵押物减少量 Collateral reduction
     * @param lendingEngine 借贷引擎地址 Lending engine address
     * @return newHealthFactor 新健康因子 New health factor
     * @return newRiskScore 新风险评分 New risk score
     * @return newRiskLevel 新风险等级 New risk level
     */
    function previewLiquidationDebtState(
        address targetUser,
        uint256 debtReduction,
        uint256 collateralReduction,
        address lendingEngine
    ) internal view returns (
        uint256 newHealthFactor,
        uint256 newRiskScore,
        uint256 newRiskLevel
    ) {
        if (lendingEngine != address(0)) {
            try ILendingEngineBasic(lendingEngine).previewLiquidationState(
                targetUser,
                debtReduction,
                collateralReduction
            ) returns (
                uint256 healthFactor,
                uint256 riskScore,
                uint256 riskLevel
            ) {
                newHealthFactor = healthFactor;
                newRiskScore = riskScore;
                newRiskLevel = riskLevel;
            } catch {
                newHealthFactor = 0;
                newRiskScore = 0;
                newRiskLevel = 0;
            }
        } else {
            newHealthFactor = 0;
            newRiskScore = 0;
            newRiskLevel = 0;
        }
    }

    /**
     * @notice 获取高风险用户列表
     * @notice Get high risk user list
     * @param riskThreshold 风险阈值 Risk threshold
     * @param limit 限制数量 Limit
     * @param lendingEngine 借贷引擎地址 Lending engine address
     * @return users 用户地址数组 User addresses array
     * @return riskScores 风险评分数组 Risk scores array
     */
    function getHighRiskUserList(
        uint256 riskThreshold,
        uint256 limit,
        address lendingEngine
    ) internal view returns (
        address[] memory users,
        uint256[] memory riskScores
    ) {
        if (lendingEngine != address(0)) {
            try ILendingEngineBasic(lendingEngine).getHighRiskUsers(riskThreshold, limit) returns (
                address[] memory highRiskUsers,
                uint256[] memory scores
            ) {
                users = highRiskUsers;
                riskScores = scores;
            } catch {
                users = new address[](0);
                riskScores = new uint256[](0);
            }
        } else {
            users = new address[](0);
            riskScores = new uint256[](0);
        }
    }

    /**
     * @notice 获取可清算用户列表
     * @notice Get liquidatable user list
     * @param healthFactorThreshold 健康因子阈值 Health factor threshold
     * @param limit 限制数量 Limit
     * @param lendingEngine 借贷引擎地址 Lending engine address
     * @return users 用户地址数组 User addresses array
     * @return healthFactors 健康因子数组 Health factors array
     */
    function getLiquidatableUserList(
        uint256 healthFactorThreshold,
        uint256 limit,
        address lendingEngine
    ) internal view returns (
        address[] memory users,
        uint256[] memory healthFactors
    ) {
        if (lendingEngine != address(0)) {
            try ILendingEngineBasic(lendingEngine).getLiquidatableUsers(healthFactorThreshold, limit) returns (
                address[] memory liquidatableUsers,
                uint256[] memory factors
            ) {
                users = liquidatableUsers;
                healthFactors = factors;
            } catch {
                users = new address[](0);
                healthFactors = new uint256[](0);
            }
        } else {
            users = new address[](0);
            healthFactors = new uint256[](0);
        }
    }

    /**
     * @notice 计算最优清算路径
     * @notice Calculate optimal liquidation path
     * @param targetUser 用户地址 User address
     * @param targetHealthFactor 目标健康因子 Target health factor
     * @param lendingEngine 借贷引擎地址 Lending engine address
     * @return liquidationSteps 清算步骤数组 Liquidation steps array
     * @return totalDebtReduction 总债务减少量 Total debt reduction
     * @return totalCollateralReduction 总抵押物减少量 Total collateral reduction
     */
    function calculateOptimalLiquidationPath(
        address targetUser,
        uint256 targetHealthFactor,
        address lendingEngine
    ) internal view returns (
        address[] memory liquidationSteps,
        uint256 totalDebtReduction,
        uint256 totalCollateralReduction
    ) {
        if (lendingEngine != address(0)) {
            try ILendingEngineBasic(lendingEngine).calculateOptimalLiquidationPath(
                targetUser,
                targetHealthFactor
            ) returns (
                address[] memory steps,
                uint256 debtReduction,
                uint256 collateralReduction
            ) {
                liquidationSteps = steps;
                totalDebtReduction = debtReduction;
                totalCollateralReduction = collateralReduction;
            } catch {
                liquidationSteps = new address[](0);
                totalDebtReduction = 0;
                totalCollateralReduction = 0;
            }
        } else {
            liquidationSteps = new address[](0);
            totalDebtReduction = 0;
            totalCollateralReduction = 0;
        }
    }

    /**
     * @notice 批量优化清算策略
     * @notice Batch optimize liquidation strategies
     * @param userAddresses 用户地址数组 User addresses array
     * @param targetHealthFactors 目标健康因子数组 Target health factors array
     * @param lendingEngine 借贷引擎地址 Lending engine address
     * @return strategies 策略数组 Strategies array
     */
    function batchOptimizeLiquidationStrategies(
        address[] calldata userAddresses,
        uint256[] calldata targetHealthFactors,
        address lendingEngine
    ) internal view returns (bytes[] memory strategies) {
        uint256 length = userAddresses.length;
        strategies = new bytes[](length);

        if (lendingEngine != address(0)) {
            for (uint256 i = 0; i < length;) {
                if (userAddresses[i] != address(0)) {
                    try ILendingEngineBasic(lendingEngine).optimizeLiquidationStrategy(
                        userAddresses[i],
                        targetHealthFactors[i]
                    ) returns (bytes memory strategy) {
                        strategies[i] = strategy;
                    } catch {
                        strategies[i] = "";
                    }
                }
                unchecked { ++i; }
            }
        }
    }

    /* ============ Price Calculation Functions ============ */
    
    /**
     * @notice 计算抵押物价值 - 使用优雅降级机制
     * @notice Calculate collateral value - Using graceful degradation
     * @param targetAsset 资产地址 Asset address
     * @param targetAmount 数量 Amount
     * @param priceOracleAddr 价格预言机地址 Price oracle address
     * @param settlementTokenAddr 结算币地址 Settlement token address
     * @return value 价值（以结算币计价）Value (denominated in settlement token)
     */
    function calculateCollateralValue(
        address targetAsset,
        uint256 targetAmount,
        address priceOracleAddr,
        address settlementTokenAddr
    ) internal view returns (uint256 value) {
        if (targetAsset == address(0)) revert LiquidationViewLibrary__InvalidAssetAddress(targetAsset);
        if (targetAmount == 0) return 0;
        if (priceOracleAddr == address(0)) revert LiquidationViewLibrary__ModuleCallFailed(bytes32(0), priceOracleAddr);

        // 创建优雅降级配置
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(settlementTokenAddr);
        
        // 使用优雅降级获取资产价值
        GracefulDegradation.PriceResult memory result = 
            GracefulDegradation.getAssetValueWithFallback(priceOracleAddr, targetAsset, targetAmount, config);
        
        return result.value;
    }

    /**
     * @notice 计算抵押物价值 - 兼容旧接口（向后兼容）
     * @notice Calculate collateral value - Compatible with old interface (backward compatibility)
     * @param targetAsset 资产地址 Asset address
     * @param targetAmount 数量 Amount
     * @param priceOracleAddr 价格预言机地址 Price oracle address
     * @return value 价值（以结算币计价）Value (denominated in settlement token)
     */
    function calculateCollateralValue(
        address targetAsset,
        uint256 targetAmount,
        address priceOracleAddr
    ) internal view returns (uint256 value) {
        // 使用默认结算币地址（需要调用方提供）
        // 这里使用一个默认值，实际使用时应该传入正确的结算币地址
        address defaultSettlementToken = address(0); // 这个值应该由调用方提供
        
        return calculateCollateralValue(targetAsset, targetAmount, priceOracleAddr, defaultSettlementToken);
    }

    /**
     * @notice 获取用户总抵押物价值 - 获取指定用户的总抵押物价值
     * @notice Get user's total collateral value - Get total collateral value of specified user
     * @param targetUser 用户地址 User address
     * @param moduleCache 模块缓存 Module cache
     * @return totalValue 总价值 Total value
     */
    function getUserTotalCollateralValue(
        address targetUser,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 totalValue) {
        if (targetUser == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUser);

        address collateralManager = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, DEFAULT_CACHE_MAX_AGE);
        if (collateralManager == address(0)) {
            return 0;
        }
        
        totalValue = ICollateralManager(collateralManager).getUserTotalCollateralValue(targetUser);
        
        if (totalValue > type(uint256).max / 2) {
            revert("Total value too large");
        }
    }

    /**
     * @notice 批量计算抵押物价值 - 使用优雅降级机制
     * @notice Batch calculate collateral values - Using graceful degradation
     * @param targetAssets 资产地址数组 Array of asset addresses
     * @param targetAmounts 数量数组 Array of amounts
     * @param priceOracleAddr 价格预言机地址 Price oracle address
     * @param settlementTokenAddr 结算币地址 Settlement token address
     * @return values 价值数组 Array of values
     */
    function batchCalculateCollateralValuesWithFallback(
        address[] memory targetAssets,
        uint256[] memory targetAmounts,
        address priceOracleAddr,
        address settlementTokenAddr
    ) internal view returns (uint256[] memory values) {
        uint256 length = targetAssets.length;
        if (length != targetAmounts.length) revert LiquidationViewLibrary__ArrayLengthMismatch(length, targetAmounts.length);
        
        values = new uint256[](length);
        
        // 创建优雅降级配置
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(settlementTokenAddr);
        
        for (uint256 i = 0; i < length;) {
            if (targetAssets[i] != address(0) && targetAmounts[i] > 0) {
                GracefulDegradation.PriceResult memory result = 
                    GracefulDegradation.getAssetValueWithFallback(priceOracleAddr, targetAssets[i], targetAmounts[i], config);
                values[i] = result.value;
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice 批量获取用户健康因子 - 使用优雅降级机制
     * @notice Batch get user health factors - Using graceful degradation
     * @param userAddresses 用户地址数组 Array of user addresses
     * @param moduleCache 模块缓存 Module cache
     * @param priceOracleAddr 价格预言机地址 Price oracle address
     * @param settlementTokenAddr 结算币地址 Settlement token address
     * @return healthFactors 健康因子数组 Health factors array
     */
    function batchGetUserHealthFactorsWithFallback(
        address[] memory userAddresses,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        address priceOracleAddr,
        address settlementTokenAddr
    ) internal view returns (uint256[] memory healthFactors) {
        uint256 length = userAddresses.length;
        if (length > MAX_BATCH_OPERATIONS) revert LiquidationViewLibrary__TooManyBatchOperations(length, MAX_BATCH_OPERATIONS);
        
        healthFactors = new uint256[](length);
        
        // 创建优雅降级配置
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(settlementTokenAddr);
        
        for (uint256 i = 0; i < length;) {
            address user = userAddresses[i];
            if (user != address(0)) {
                // 获取用户抵押物和债务价值（使用优雅降级）
                uint256 totalCollateralValue = getUserTotalCollateralValueWithFallback(user, moduleCache, priceOracleAddr, config);
                uint256 totalDebtValue = getUserTotalDebtValue(user, moduleCache);
                
                // 获取清算阈值
                uint256 liquidationThreshold = _getLiquidationThresholdFromCache(moduleCache);
                
                // 计算健康因子
                healthFactors[i] = calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice 获取用户总抵押物价值 - 使用优雅降级机制
     * @notice Get user's total collateral value - Using graceful degradation
     * @param targetUser 用户地址 User address
     * @param moduleCache 模块缓存 Module cache
     * @param priceOracleAddr 价格预言机地址 Price oracle address
     * @param config 优雅降级配置 Graceful degradation config
     * @return totalValue 总价值 Total value
     */
    function getUserTotalCollateralValueWithFallback(
        address targetUser,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        address priceOracleAddr,
        GracefulDegradation.DegradationConfig memory config
    ) internal view returns (uint256 totalValue) {
        if (targetUser == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUser);

        address collateralManager = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, DEFAULT_CACHE_MAX_AGE);
        if (collateralManager == address(0)) {
            return 0;
        }
        
        // 获取用户抵押物资产
        address[] memory assets = ICollateralManager(collateralManager).getUserCollateralAssets(targetUser);
        uint256 length = assets.length;
        
        for (uint256 i = 0; i < length;) {
            address asset = assets[i];
            uint256 amount = ICollateralManager(collateralManager).getCollateral(targetUser, asset);
            
            if (amount > 0) {
                // 使用优雅降级计算资产价值
                GracefulDegradation.PriceResult memory result = 
                    GracefulDegradation.getAssetValueWithFallback(priceOracleAddr, asset, amount, config);
                
                totalValue += result.value;
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice 获取用户总债务价值 - 从借贷引擎获取
     * @notice Get user's total debt value - Get from lending engine
     * @param targetUser 用户地址 User address
     * @param moduleCache 模块缓存 Module cache
     * @return totalValue 总价值 Total value
     */
    function getUserTotalDebtValue(
        address targetUser,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 totalValue) {
        if (targetUser == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUser);

        address lendingEngine = ModuleCache.get(moduleCache, ModuleKeys.KEY_LE, DEFAULT_CACHE_MAX_AGE);
        if (lendingEngine == address(0)) {
            return 0;
        }
        
        // 从借贷引擎获取用户总债务价值
        totalValue = ILendingEngineBasic(lendingEngine).getUserTotalDebtValue(targetUser);
    }

    /**
     * @notice 从缓存获取清算阈值
     * @notice Get liquidation threshold from cache
     * @return threshold 清算阈值 Liquidation threshold
     */
    function _getLiquidationThresholdFromCache(
        ModuleCache.ModuleCacheStorage storage /* moduleCache */
    ) internal pure returns (uint256 threshold) {
        // 简化版本，使用默认清算阈值
        threshold = 1e18; // 默认100%
    }

    /**
     * @notice 检查价格预言机健康状态
     * @notice Check price oracle health status
     * @param priceOracleAddr 价格预言机地址 Price oracle address
     * @param asset 资产地址 Asset address
     * @return isHealthy 是否健康 Is healthy
     * @return details 详细信息 Details
     */
    function checkPriceOracleHealth(
        address priceOracleAddr,
        address asset
    ) internal view returns (bool isHealthy, string memory details) {
        if (priceOracleAddr == address(0)) {
            return (false, "Price oracle address is zero");
        }
        if (asset == address(0)) {
            return (false, "Asset address is zero");
        }
        
        return GracefulDegradation.checkPriceOracleHealth(priceOracleAddr, asset);
    }

    /**
     * @notice 预览清算抵押物状态 - 使用优雅降级机制
     * @notice Preview liquidation collateral state - Using graceful degradation
     * @param targetUser 用户地址 User address
     * @param targetAsset 资产地址 Asset address
     * @param seizeAmount 扣押数量 Seize amount
     * @param moduleCache 模块缓存 Module cache
     * @param priceOracleAddr 价格预言机地址 Price oracle address
     * @param settlementTokenAddr 结算币地址 Settlement token address
     * @return newCollateralAmount 新的抵押物数量 New collateral amount
     * @return newTotalValue 新的总价值 New total value
     */
    function previewLiquidationCollateralStateWithFallback(
        address targetUser,
        address targetAsset,
        uint256 seizeAmount,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        address priceOracleAddr,
        address settlementTokenAddr
    ) internal view returns (uint256 newCollateralAmount, uint256 newTotalValue) {
        if (targetUser == address(0)) revert LiquidationViewLibrary__InvalidUserAddress(targetUser);
        if (targetAsset == address(0)) revert LiquidationViewLibrary__InvalidAssetAddress(targetAsset);
        if (seizeAmount == 0) return (0, 0);

        uint256 currentAmount = getSeizableCollateralAmount(targetUser, targetAsset, moduleCache);
        
        newCollateralAmount = currentAmount > seizeAmount ? currentAmount - seizeAmount : 0;
        newTotalValue = calculateCollateralValue(targetAsset, newCollateralAmount, priceOracleAddr, settlementTokenAddr);
        
        if (newCollateralAmount > currentAmount) {
            revert("Invalid collateral calculation");
        }
    }

    /**
     * @notice 预览清算抵押物状态 - 兼容旧接口（向后兼容）
     * @notice Preview liquidation collateral state - Compatible with old interface (backward compatibility)
     * @param targetUser 用户地址 User address
     * @param targetAsset 资产地址 Asset address
     * @param seizeAmount 扣押数量 Seize amount
     * @param moduleCache 模块缓存 Module cache
     * @param priceOracleAddr 价格预言机地址 Price oracle address
     * @return newCollateralAmount 新的抵押物数量 New collateral amount
     * @return newTotalValue 新的总价值 New total value
     */
    function previewLiquidationCollateralState(
        address targetUser,
        address targetAsset,
        uint256 seizeAmount,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        address priceOracleAddr
    ) internal view returns (uint256 newCollateralAmount, uint256 newTotalValue) {
        // 使用默认结算币地址（需要调用方提供）
        address defaultSettlementToken = address(0); // 这个值应该由调用方提供
        
        return previewLiquidationCollateralStateWithFallback(
            targetUser,
            targetAsset,
            seizeAmount,
            moduleCache,
            priceOracleAddr,
            defaultSettlementToken
        );
    }

    /* ============ 优雅降级辅助函数 ============ */
    
    /**
     * @notice 创建默认优雅降级配置
     * @notice Create default graceful degradation config
     * @param settlementTokenAddr 结算币地址 Settlement token address
     * @return config 降级配置 Degradation config
     */
    function createDefaultDegradationConfig(
        address settlementTokenAddr
    ) internal pure returns (GracefulDegradation.DegradationConfig memory config) {
        return GracefulDegradation.createDefaultConfig(settlementTokenAddr);
    }

    /**
     * @notice 创建自定义优雅降级配置
     * @notice Create custom graceful degradation config
     * @param conservativeRatio 保守估值比例（基点）Conservative valuation ratio (basis points)
     * @param useStablecoinFaceValue 是否对稳定币使用面值 Whether to use face value for stablecoins
     * @param enablePriceCache 是否启用价格缓存 Whether to enable price cache
     * @param settlementTokenAddr 结算币地址 Settlement token address
     * @return config 降级配置 Degradation config
     */
    function createCustomDegradationConfig(
        uint256 conservativeRatio,
        bool useStablecoinFaceValue,
        bool enablePriceCache,
        address settlementTokenAddr
    ) internal pure returns (GracefulDegradation.DegradationConfig memory config) {
        config.conservativeRatio = conservativeRatio;
        config.useStablecoinFaceValue = useStablecoinFaceValue;
        config.enablePriceCache = enablePriceCache;
        config.settlementToken = settlementTokenAddr;
    }

    /**
     * @notice 批量检查价格预言机健康状态
     * @notice Batch check price oracle health status
     * @param priceOracleAddr 价格预言机地址 Price oracle address
     * @param assets 资产地址数组 Asset addresses array
     * @return healthStatuses 健康状态数组 Health statuses array
     * @return details 详细信息数组 Details array
     */
    function batchCheckPriceOracleHealth(
        address priceOracleAddr,
        address[] memory assets
    ) internal view returns (bool[] memory healthStatuses, string[] memory details) {
        uint256 length = assets.length;
        healthStatuses = new bool[](length);
        details = new string[](length);
        
        for (uint256 i = 0; i < length;) {
            (healthStatuses[i], details[i]) = checkPriceOracleHealth(priceOracleAddr, assets[i]);
            unchecked { ++i; }
        }
    }

    /**
     * @notice 获取资产价值（带降级信息）
     * @notice Get asset value with degradation info
     * @param targetAsset 资产地址 Asset address
     * @param targetAmount 数量 Amount
     * @param priceOracleAddr 价格预言机地址 Price oracle address
     * @param settlementTokenAddr 结算币地址 Settlement token address
     * @return value 价值 Value
     * @return usedFallback 是否使用了降级策略 Whether fallback was used
     * @return reason 降级原因 Degradation reason
     */
    function getAssetValueWithDegradationInfo(
        address targetAsset,
        uint256 targetAmount,
        address priceOracleAddr,
        address settlementTokenAddr
    ) internal view returns (uint256 value, bool usedFallback, string memory reason) {
        if (targetAsset == address(0)) revert LiquidationViewLibrary__InvalidAssetAddress(targetAsset);
        if (targetAmount == 0) return (0, false, "Zero amount");
        if (priceOracleAddr == address(0)) revert LiquidationViewLibrary__ModuleCallFailed(bytes32(0), priceOracleAddr);

        // 创建优雅降级配置
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(settlementTokenAddr);
        
        // 使用优雅降级获取资产价值
        GracefulDegradation.PriceResult memory result = 
            GracefulDegradation.getAssetValueWithFallback(priceOracleAddr, targetAsset, targetAmount, config);
        
        return (result.value, result.usedFallback, result.reason);
    }
} 
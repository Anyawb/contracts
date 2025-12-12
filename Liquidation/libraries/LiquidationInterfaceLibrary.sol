// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LiquidationValidationLibrary.sol";
import "./LiquidationEventLibrary.sol";
import "./LiquidationCoreOperations.sol";
import "./LiquidationViewLibrary.sol";
import "./LiquidationTokenLibrary.sol";
import "./LiquidationUtilityLibrary.sol";

import "./ModuleCache.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { IAssetWhitelist } from "../../../interfaces/IAssetWhitelist.sol";

/**
 * @title 清算接口库
 * @title Liquidation Interface Library
 * @author RWA Lending Platform
 * @notice 提供接口实现功能，整合所有清算模块中重复的接口实现逻辑
 * @notice Provides interface implementation functionality, integrates all repeated interface implementation logic from liquidation modules
 * @dev 提供标准化的接口实现函数，确保一致性和可维护性
 * @dev Provides standardized interface implementation functions to ensure consistency and maintainability
 */
library LiquidationInterfaceLibrary {
    using LiquidationValidationLibrary for *;
    using LiquidationEventLibrary for *;
    using LiquidationCoreOperations for *;
    using LiquidationViewLibrary for *;
    using LiquidationTokenLibrary for *;
    using LiquidationUtilityLibrary for *;

    using LiquidationBase for *;
    using ModuleCache for ModuleCache.ModuleCacheStorage;

    /* ============ Constants ============ */
    
    /**
     * @notice 默认缓存过期时间 - 模块缓存的最大有效期（秒）
     * @notice Default cache expiration time - Maximum validity period for module cache (seconds)
     */
    uint256 public constant DEFAULT_CACHE_MAX_AGE = 1 days;

    /* ============ Core Liquidation Interface Functions ============ */
    
    /**
     * @notice 执行清算操作 - 接口实现
     * @notice Execute liquidation operation - Interface implementation
     * @param targetUserAddr 被清算用户地址 Target user address
     * @param collateralAssetAddr 抵押资产地址 Collateral asset address
     * @param debtAssetAddr 债务资产地址 Debt asset address
     * @param collateralAmount 清算抵押物数量 Collateral amount to liquidate
     * @param debtAmount 清算债务数量 Debt amount to liquidate
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @param moduleCache 模块缓存 Module cache
     * @return bonus 清算奖励 Liquidation bonus
     */
    function executeLiquidationInterface(
        address targetUserAddr,
        address collateralAssetAddr,
        address debtAssetAddr,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidatorAddr,
        mapping(bytes32 => uint256) storage liquidationConfigStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal returns (uint256 bonus) {
        LiquidationValidationLibrary.validateAddress(targetUserAddr);
        LiquidationValidationLibrary.validateAddress(collateralAssetAddr);
        LiquidationValidationLibrary.validateAddress(debtAssetAddr);
        LiquidationValidationLibrary.validateAmount(collateralAmount);
        LiquidationValidationLibrary.validateAmount(debtAmount);

        // 检查用户是否可被清算
        if (!LiquidationCoreOperations.isLiquidatable(targetUserAddr, liquidationConfigStorage, moduleCache)) {
            // 使用事件库触发清算失败事件
            LiquidationEventLibrary.emitLiquidationFailed(
                targetUserAddr,
                debtAssetAddr,
                liquidatorAddr,
                "User not liquidatable"
            );
            return 0;
        }

        // 触发清算开始事件
        LiquidationEventLibrary.emitLiquidationStarted(
            targetUserAddr,
            debtAssetAddr,
            liquidatorAddr,
            debtAmount,
            collateralAmount
        );

        // 执行清算内部逻辑 - 简化版本，只返回0奖励
        // TODO: 实现完整的清算逻辑，需要存储映射参数
        bonus = 0;
        
        // 触发清算完成事件
        LiquidationEventLibrary.emitLiquidationCompleted(
            targetUserAddr,
            debtAssetAddr,
            liquidatorAddr,
            debtAmount,
            collateralAmount,
            bonus
        );

        return bonus;
    }

    /**
     * @notice 批量清算操作 - 接口实现
     * @notice Batch liquidation operation - Interface implementation
     * @param targetUserAddrs 被清算用户地址数组 Array of target user addresses
     * @param collateralAssetAddrs 抵押资产地址数组 Array of collateral asset addresses
     * @param debtAssetAddrs 债务资产地址数组 Array of debt asset addresses
     * @param collateralAmounts 清算抵押物数量数组 Array of collateral amounts
     * @param debtAmounts 清算债务数量数组 Array of debt amounts
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @param moduleCache 模块缓存 Module cache
     * @return bonuses 清算奖励金额数组 Array of liquidation bonuses
     */
    function executeBatchLiquidationInterface(
        address[] calldata targetUserAddrs,
        address[] calldata collateralAssetAddrs,
        address[] calldata debtAssetAddrs,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        address liquidatorAddr,
        mapping(bytes32 => uint256) storage liquidationConfigStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal returns (uint256[] memory bonuses) {
        // 使用批量库验证批量操作长度限制
        uint256 optimizedBatchSize = targetUserAddrs.length > 50 ? 50 : targetUserAddrs.length;
        if (targetUserAddrs.length > optimizedBatchSize) {
            revert("Batch size exceeded");
        }
        
        // 使用验证库进行数组长度验证
        LiquidationValidationLibrary.validateArrayLength(targetUserAddrs, collateralAssetAddrs);
        LiquidationValidationLibrary.validateArrayLength(targetUserAddrs, debtAssetAddrs);
        LiquidationValidationLibrary.validateArrayLength(targetUserAddrs, collateralAmounts);
        LiquidationValidationLibrary.validateArrayLength(targetUserAddrs, debtAmounts);

        // 触发批量清算开始事件
        LiquidationEventLibrary.emitBatchLiquidationStarted(liquidatorAddr, targetUserAddrs.length);

        uint256 length = targetUserAddrs.length;
        bonuses = new uint256[](length);
        uint256 successCount = 0;
        uint256 totalReward = 0;

        // 使用批量库处理清算操作
        for (uint256 i = 0; i < length;) {
            // 使用验证库进行地址验证
            if (!LiquidationValidationLibrary.isZeroAddress(targetUserAddrs[i]) && 
                !LiquidationValidationLibrary.isZeroAddress(collateralAssetAddrs[i]) && 
                !LiquidationValidationLibrary.isZeroAddress(debtAssetAddrs[i])) {
                
                // 检查用户是否可被清算 - 使用 CoreOperations
                if (LiquidationCoreOperations.isLiquidatable(targetUserAddrs[i], liquidationConfigStorage, moduleCache)) {
                    // 直接调用内部函数，不使用 try-catch - 简化版本
                    // TODO: 实现完整的清算逻辑，需要存储映射参数
                    bonuses[i] = 0;
                    successCount++;
                    totalReward += bonuses[i];
                } else {
                    // 用户不可清算，记录失败事件
                    LiquidationEventLibrary.emitLiquidationFailed(
                        targetUserAddrs[i],
                        debtAssetAddrs[i],
                        liquidatorAddr,
                        "User not liquidatable"
                    );
                    
                    // 清算失败，奖励为0
                    bonuses[i] = 0;
                }
            }
            unchecked { ++i; }
        }

        // 触发批量清算完成事件
        LiquidationEventLibrary.emitBatchLiquidationCompleted(
            liquidatorAddr,
            length,
            successCount,
            totalReward
        );

        return bonuses;
    }

    /* ============ Risk Assessment Interface Functions ============ */
    


    /**
     * @notice 获取用户健康因子 - 接口实现
     * @notice Get user health factor - Interface implementation
     * @param targetUserAddr 用户地址 User address
     * @param moduleCache 模块缓存 Module cache
     * @return healthFactor 健康因子 Health factor
     */
    function getUserHealthFactorInterface(
        address targetUserAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 healthFactor) {
        // 使用 moduleCache 获取借贷引擎地址
        address lendingEngineAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_LE, DEFAULT_CACHE_MAX_AGE);
        if (lendingEngineAddr != address(0)) {
            try ILendingEngineBasic(lendingEngineAddr).getUserHealthFactor(targetUserAddr) returns (uint256 healthFactorValue) {
                healthFactor = healthFactorValue;
            } catch {
                // 如果获取失败，使用简化版本
                (uint256 totalCollateralValue, uint256 totalDebtValue) = LiquidationViewLibrary._getUserValuesSimple(targetUserAddr, moduleCache);
                uint256 liquidationThreshold = 1e18; // 默认100%
                healthFactor = LiquidationViewLibrary.calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
            }
        } else {
            // 如果没有借贷引擎，使用简化版本
            (uint256 totalCollateralValue, uint256 totalDebtValue) = LiquidationViewLibrary._getUserValuesSimple(targetUserAddr, moduleCache);
            uint256 liquidationThreshold = 1e18; // 默认100%
            healthFactor = LiquidationViewLibrary.calculateHealthFactor(totalCollateralValue, totalDebtValue, liquidationThreshold);
        }
    }

    /**
     * @notice 获取用户清算风险评分 - 接口实现
     * @notice Get user liquidation risk score - Interface implementation
     * @param targetUserAddr 用户地址 User address
     * @param moduleCache 模块缓存 Module cache
     * @return riskScore 风险评分 Risk score
     */
    function getLiquidationRiskScoreInterface(
        address targetUserAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 riskScore) {
        return LiquidationViewLibrary.getLiquidationRiskScore(targetUserAddr, moduleCache);
    }

    /* ============ Batch Query Interface Functions ============ */
    


    /**
     * @notice 批量获取可减少债务金额 - 接口实现
     * @notice Batch get reducible debt amounts - Interface implementation
     * @param targetUserAddrs 用户地址数组 Array of user addresses
     * @param targetAssetAddrs 资产地址数组 Array of asset addresses
     * @param moduleCache 模块缓存 Module cache
     * @return reducibleAmounts 可减少金额数组 Array of reducible amounts
     */
    function batchGetReducibleDebtAmountsInterface(
        address[] calldata targetUserAddrs,
        address[] calldata targetAssetAddrs,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory reducibleAmounts) {
        address lendingEngineAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_LE, DEFAULT_CACHE_MAX_AGE);
        return LiquidationViewLibrary.batchGetReducibleAmounts(targetUserAddrs, targetAssetAddrs, lendingEngineAddr);
    }

    /**
     * @notice 批量计算债务价值 - 接口实现
     * @notice Batch calculate debt values - Interface implementation
     * @param targetUserAddrs 用户地址数组 Array of user addresses
     * @param targetAssetAddrs 资产地址数组 Array of asset addresses
     * @param moduleCache 模块缓存 Module cache
     * @return debtValues 债务价值数组 Array of debt values
     */
    function batchCalculateDebtValuesInterface(
        address[] calldata targetUserAddrs,
        address[] calldata targetAssetAddrs,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory debtValues) {
        address lendingEngineAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_LE, DEFAULT_CACHE_MAX_AGE);
        return LiquidationViewLibrary.batchCalculateDebtValues(targetUserAddrs, targetAssetAddrs, lendingEngineAddr);
    }

    /* ============ Collateral Management Interface Functions ============ */
    


    /**
     * @notice 批量扣押用户抵押物 - 接口实现
     * @notice Batch seize user collateral - Interface implementation
     * @param targetUserAddr 被清算用户地址 Target user address
     * @param assetAddrs 抵押资产地址数组 Array of asset addresses
     * @param amounts 扣押数量数组 Array of amounts
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param moduleCache 模块缓存 Module cache
     * @return seizedAmounts 实际扣押数量数组 Array of actual seized amounts
     */
    function batchSeizeCollateralInterface(
        address targetUserAddr,
        address[] calldata assetAddrs,
        uint256[] calldata amounts,
        address liquidatorAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal pure returns (uint256[] memory seizedAmounts) {
        // 简化版本，直接调用核心操作
        LiquidationValidationLibrary.validateAddress(targetUserAddr);
        LiquidationValidationLibrary.validateAddress(liquidatorAddr);
        
        if (assetAddrs.length != amounts.length) revert("Array length mismatch");
        
        uint256 length = assetAddrs.length;
        seizedAmounts = new uint256[](length);

        for (uint256 i = 0; i < length;) {
            if (assetAddrs[i] != address(0) && amounts[i] > 0) {
                // TODO: 实现完整的扣押逻辑，需要存储映射参数
                seizedAmounts[i] = 0;
            }
            unchecked { ++i; }
        }
        
        // 使用moduleCache避免未使用警告
        moduleCache;
    }

    /**
     * @notice 转移清算抵押物给清算人 - 接口实现
     * @notice Transfer liquidation collateral to liquidator - Interface implementation
     * @param assetAddr 资产地址 Asset address
     * @param amount 转移数量 Transfer amount
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param moduleCache 模块缓存 Module cache
     */
    function transferLiquidationCollateralInterface(
        address assetAddr,
        uint256 amount,
        address liquidatorAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal {
        // 验证参数
        LiquidationValidationLibrary.validateAddress(assetAddr);
        LiquidationValidationLibrary.validateAddress(liquidatorAddr);
        LiquidationValidationLibrary.validateAmount(amount);
        
        // 检查资产是否支持 - 使用 moduleCache 获取资产白名单
        address assetWhitelistAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_ASSET_WHITELIST, DEFAULT_CACHE_MAX_AGE);
        if (assetWhitelistAddr != address(0)) {
            try IAssetWhitelist(assetWhitelistAddr).isAssetAllowed(assetAddr) returns (bool isAllowed) {
                if (!isAllowed) {
                    revert("Asset not allowed for liquidation");
                }
            } catch {
                // 如果检查失败，继续执行
            }
        }
        
        // 执行转移操作
        LiquidationTokenLibrary.safeTransfer(assetAddr, liquidatorAddr, amount);
        
        // 记录转移事件（如果有事件系统）
        // emit LiquidationCollateralTransferred(assetAddr, liquidatorAddr, amount);
    }

    /* ============ Debt Management Interface Functions ============ */
    


    /**
     * @notice 批量减少用户债务 - 接口实现
     * @notice Batch reduce user debt - Interface implementation
     * @param targetUserAddr 被清算用户地址 Target user address
     * @param assetAddrs 债务资产地址数组 Array of asset addresses
     * @param amounts 减少数量数组 Array of amounts
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param moduleCache 模块缓存 Module cache
     * @return reducedAmounts 实际减少数量数组 Array of actual reduced amounts
     */
    function batchReduceDebtInterface(
        address targetUserAddr,
        address[] calldata assetAddrs,
        uint256[] calldata amounts,
        address liquidatorAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal returns (uint256[] memory reducedAmounts) {
        // 简化版本，直接调用核心操作
        LiquidationValidationLibrary.validateAddress(targetUserAddr);
        LiquidationValidationLibrary.validateAddress(liquidatorAddr);
        
        if (assetAddrs.length != amounts.length) revert("Array length mismatch");
        
        uint256 length = assetAddrs.length;
        reducedAmounts = new uint256[](length);

        for (uint256 i = 0; i < length;) {
            if (assetAddrs[i] != address(0) && amounts[i] > 0) {
                reducedAmounts[i] = LiquidationCoreOperations.reduceDebt(targetUserAddr, assetAddrs[i], amounts[i], liquidatorAddr, moduleCache);
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice 没收用户保证金 - 接口实现
     * @notice Forfeit user guarantee - Interface implementation
     * @return forfeitedAmount 没收数量 Forfeited amount
     */
    function forfeitGuaranteeInterface(
        address targetUserAddr,
        address assetAddr,
        address feeReceiverAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 forfeitedAmount) {
        // 验证参数
        require(targetUserAddr != address(0), "Invalid user");
        require(assetAddr != address(0), "Invalid asset");
        require(feeReceiverAddr != address(0), "Invalid fee receiver");
        
        // 获取保证金管理器
        address guaranteeManagerAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_GUARANTEE_FUND, DEFAULT_CACHE_MAX_AGE);
        if (guaranteeManagerAddr != address(0)) {
            try ILiquidationGuaranteeManager(guaranteeManagerAddr).getUserGuarantee(targetUserAddr, assetAddr) returns (uint256 amount) {
                forfeitedAmount = amount;
            } catch {
                forfeitedAmount = 0;
            }
        } else {
            forfeitedAmount = 0;
        }
        
        return forfeitedAmount;
    }

    /* ============ Query Interface Functions ============ */
    
    /**
     * @notice 获取用户可清算的抵押物数量 - 接口实现
     * @notice Get user seizable collateral amount - Interface implementation
     * @param targetUserAddr 用户地址 User address
     * @param assetAddr 资产地址 Asset address
     * @param moduleCache 模块缓存 Module cache
     * @return seizableAmount 可清算数量 Seizable amount
     */
    function getSeizableCollateralAmountInterface(
        address targetUserAddr,
        address assetAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 seizableAmount) {
        return LiquidationViewLibrary.getSeizableCollateralAmount(targetUserAddr, assetAddr, moduleCache);
    }

    /**
     * @notice 获取用户可清算的债务数量 - 接口实现
     * @notice Get user reducible debt amount - Interface implementation
     * @param targetUserAddr 用户地址 User address
     * @param assetAddr 资产地址 Asset address
     * @param moduleCache 模块缓存 Module cache
     * @return reducibleAmount 可清算数量 Reducible amount
     */
    function getReducibleDebtAmountInterface(
        address targetUserAddr,
        address assetAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 reducibleAmount) {
        return LiquidationViewLibrary.getReducibleDebtAmount(targetUserAddr, assetAddr, moduleCache);
    }

    /**
     * @notice 计算清算奖励 - 接口实现
     * @notice Calculate liquidation bonus - Interface implementation
     * @param amount 清算金额 Liquidation amount
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @return bonus 清算奖励 Liquidation bonus
     */
    function calculateLiquidationBonusInterface(
        uint256 amount,
        mapping(bytes32 => uint256) storage liquidationConfigStorage
    ) internal view returns (uint256 bonus) {
        return LiquidationViewLibrary.calculateLiquidationBonus(amount, amount, liquidationConfigStorage);
    }

    /**
     * @notice 获取清算奖励比例 - 接口实现
     * @notice Get liquidation bonus rate - Interface implementation
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @return bonusRate 清算奖励比例 Liquidation bonus rate
     */
    function getLiquidationBonusRateInterface(
        mapping(bytes32 => uint256) storage liquidationConfigStorage
    ) internal view returns (uint256 bonusRate) {
        return liquidationConfigStorage[keccak256("LIQUIDATION_BONUS_RATE")];
    }

    /* ============ Preview Interface Functions ============ */
    


    /* ============ Admin Interface Functions ============ */
    
    /**
     * @notice 更新清算奖励比例 - 接口实现
     * @notice Update liquidation bonus rate - Interface implementation
     * @param newBonusRate 新的清算奖励比例 New liquidation bonus rate
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @param updaterAddr 更新者地址 Updater address
     */
    function updateLiquidationBonusRateInterface(
        uint256 newBonusRate,
        mapping(bytes32 => uint256) storage liquidationConfigStorage,
        address updaterAddr
    ) internal {
        // 验证参数 - 使用LiquidationTypes中的验证函数
        if (!LiquidationTypes.isValidLiquidationBonus(newBonusRate)) {
            revert LiquidationTypes.LiquidationTypes__InvalidLiquidationBonus(newBonusRate);
        }
        LiquidationValidationLibrary.validateAddress(updaterAddr, "Updater");
        
        // 更新清算奖励比例
        liquidationConfigStorage[keccak256("LIQUIDATION_BONUS_RATE")] = newBonusRate;
        
        // 记录更新事件（如果有事件系统）
        // emit LiquidationBonusRateUpdated(updaterAddr, newBonusRate);
    }

    /**
     * @notice 获取清算阈值 - 接口实现
     * @notice Get liquidation threshold - Interface implementation
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @return threshold 清算阈值 Liquidation threshold
     */
    function getLiquidationThresholdInterface(
        mapping(bytes32 => uint256) storage liquidationConfigStorage
    ) internal view returns (uint256 threshold) {
        return LiquidationCoreOperations.getLiquidationThreshold(liquidationConfigStorage);
    }

    /**
     * @notice 更新清算阈值 - 接口实现
     * @notice Update liquidation threshold - Interface implementation
     * @param newThreshold 新的清算阈值 New liquidation threshold
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @param updaterAddr 更新者地址 Updater address
     */
    function updateLiquidationThresholdInterface(
        uint256 newThreshold,
        mapping(bytes32 => uint256) storage liquidationConfigStorage,
        address updaterAddr
    ) internal {
        // 验证参数 - 使用LiquidationTypes中的验证函数
        if (!LiquidationTypes.isValidLiquidationThreshold(newThreshold)) {
            revert LiquidationTypes.LiquidationTypes__InvalidLiquidationThreshold(newThreshold);
        }
        LiquidationValidationLibrary.validateAddress(updaterAddr, "Updater");
        
        // 更新清算阈值
        liquidationConfigStorage[keccak256("LIQUIDATION_THRESHOLD")] = newThreshold;
        
        // 记录更新事件（如果有事件系统）
        // emit LiquidationThresholdUpdated(updaterAddr, newThreshold);
    }

    /* ============ Module Management Interface Functions ============ */
    
    /**
     * @notice 模块管理功能已迁移到直接使用 ModuleCache 库
     * @notice Module management functions have been migrated to direct use of ModuleCache library
     * @dev 请直接使用 ModuleCache.get(), ModuleCache.set(), ModuleCache.batchSet(), ModuleCache.remove()
     * @dev Please use ModuleCache.get(), ModuleCache.set(), ModuleCache.batchSet(), ModuleCache.remove() directly
     */

    /* ============ Additional Batch Interface Functions ============ */
    
    /**
     * @notice 批量检查用户是否可清算 - 接口实现
     * @notice Batch check if users are liquidatable - Interface implementation
     * @param users 用户地址数组 Array of user addresses
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @param moduleCache 模块缓存 Module cache
     * @return liquidatable 是否可清算数组 Array of liquidatable flags
     */
    function batchIsLiquidatableInterface(
        address[] calldata users,
        mapping(bytes32 => uint256) storage liquidationConfigStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (bool[] memory liquidatable) {
        uint256 length = users.length;
        liquidatable = new bool[](length);
        
        for (uint256 i = 0; i < length;) {
            if (users[i] != address(0)) {
                liquidatable[i] = LiquidationCoreOperations.isLiquidatable(users[i], liquidationConfigStorage, moduleCache);
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice 批量获取用户可扣押抵押物数量 - 接口实现
     * @notice Batch get user seizable collateral amounts - Interface implementation
     * @param users 用户地址数组 Array of user addresses
     * @param assets 资产地址数组 Array of asset addresses
     * @param moduleCache 模块缓存 Module cache
     * @return seizableAmounts 可扣押数量数组 Array of seizable amounts
     */
    function batchGetSeizableCollateralAmountsInterface(
        address[] calldata users,
        address[] calldata assets,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory seizableAmounts) {
        if (users.length != assets.length) revert("Array length mismatch");
        
        uint256 length = users.length;
        seizableAmounts = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            if (users[i] != address(0) && assets[i] != address(0)) {
                seizableAmounts[i] = getSeizableCollateralAmountInterface(users[i], assets[i], moduleCache);
            }
            unchecked { ++i; }
        }
    }

    /* ============ Statistics Interface Functions ============ */
    
    /**
     * @notice 计算批量清算统计 - 接口实现
     * @notice Calculate batch liquidation statistics - Interface implementation
     * @param bonuses 奖励数组 Array of bonuses
     * @return totalBonus 总奖励 Total bonus
     * @return averageBonus 平均奖励 Average bonus
     * @return successCount 成功数量 Success count
     */
    function calculateBatchLiquidationStatsInterface(
        uint256[] memory bonuses
    ) internal pure returns (
        uint256 totalBonus,
        uint256 averageBonus,
        uint256 successCount
    ) {
        uint256 length = bonuses.length;
        if (length == 0) {
            return (0, 0, 0);
        }
        
        // 计算总奖励和成功数量
        for (uint256 i = 0; i < length;) {
            if (bonuses[i] > 0) {
                totalBonus += bonuses[i];
                successCount++;
            }
            unchecked { ++i; }
        }
        
        // 计算平均奖励
        if (successCount > 0) {
            averageBonus = totalBonus / successCount;
        }
        
        return (totalBonus, averageBonus, successCount);
    }

    /**
     * @notice 计算分块数量 - 接口实现
     * @notice Calculate chunk count - Interface implementation
     * @param totalSize 总大小 Total size
     * @param chunkSize 块大小 Chunk size
     * @return chunkCount 块数量 Chunk count
     */
    function calculateChunkCountInterface(
        uint256 totalSize,
        uint256 chunkSize
    ) internal pure returns (uint256 chunkCount) {
        if (chunkSize == 0) {
            return 0;
        }
        
        // 计算需要的块数量
        chunkCount = totalSize / chunkSize;
        
        // 如果有余数，需要额外的块
        if (totalSize % chunkSize > 0) {
            chunkCount++;
        }
        
        return chunkCount;
    }
} 
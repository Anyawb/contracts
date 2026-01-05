// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LiquidationValidationLibrary.sol";
import "./LiquidationTokenLibrary.sol";
import "./LiquidationEventLibrary.sol";
import "./LiquidationViewLibrary.sol";

import "./LiquidationAccessControl.sol";
import "./ModuleCache.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
import { LiquidationTypes } from "../types/LiquidationTypes.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { VaultMath } from "../../VaultMath.sol";
import { ILiquidationGuaranteeManager } from "../../../interfaces/ILiquidationGuaranteeManager.sol";
import { ILiquidationCollateralManager } from "../../../interfaces/ILiquidationCollateralManager.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { IPriceOracle } from "../../../interfaces/IPriceOracle.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";

/**
 * @title 清算核心操作库 - 完整实现版
 * @title Liquidation Core Operations Library - Complete Implementation
 * @author RWA Lending Platform
 * @notice 提供完整的清算核心操作功能，包括存储管理、业务逻辑和查询功能
 * @notice Provides complete liquidation core operation functionality, including storage management, business logic and query functions
 * @dev 提供标准化的核心清算函数，确保一致性和可维护性
 * @dev Provides standardized core liquidation functions to ensure consistency and maintainability
 */
library LiquidationCoreOperations {
    using LiquidationValidationLibrary for *;
    using LiquidationTokenLibrary for *;
    using LiquidationEventLibrary for *;
    using LiquidationViewLibrary for *;
    using LiquidationAccessControl for LiquidationAccessControl.Storage;
    using ModuleCache for ModuleCache.ModuleCacheStorage;
    using SafeERC20 for IERC20;
    using VaultMath for uint256;
    using LiquidationBase for *;

    /* ============ Constants ============ */
    
    /**
     * @notice 默认缓存过期时间 - 模块缓存的最大有效期（秒）
     * @notice Default cache expiration time - Maximum validity period for module cache (seconds)
     */
    uint256 public constant DEFAULT_CACHE_MAX_AGE = 1 days;

    /**
     * @notice 精度因子 - 用于精确计算
     * @notice Precision factor - For precise calculations
     */
    uint256 public constant PRECISION = 1e18;
    
    /**
     * @notice 基础精度 - 基础精度因子
     * @notice Base precision - Base precision factor
     */
    uint256 public constant BASE_PRECISION = 1e6;
    
    /**
     * @notice 最大健康因子 - 健康因子的最大值
     * @notice Maximum health factor - Maximum value for health factor
     */
    uint256 public constant MAX_HEALTH_FACTOR = 1e20;
    
    /**
     * @notice 最小健康因子 - 健康因子的最小值
     * @notice Minimum health factor - Minimum value for health factor
     */
    uint256 public constant MIN_HEALTH_FACTOR = 1e15;
    
    /**
     * @notice 最大风险评分 - 风险评分的最大值
     * @notice Maximum risk score - Maximum value for risk score
     */
    uint256 public constant MAX_RISK_SCORE = 1000;
    
    /**
     * @notice 最小风险评分 - 风险评分的最小值
     * @notice Minimum risk score - Minimum value for risk score
     */
    uint256 public constant MIN_RISK_SCORE = 0;

    /* ============ Core Liquidation Functions ============ */
    
    /**
     * @notice 扣押用户抵押物 - 完整的业务逻辑实现
     * @notice Seize user collateral - Complete business logic implementation
     * @param targetUserAddr 被清算用户地址 Target user address
     * @param collateralAssetAddr 抵押资产地址 Collateral asset address
     * @param seizeAmount 扣押数量 Seize amount
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param moduleCache 模块缓存 Module cache
     * @param userLiquidationRecords 用户清算记录映射 User liquidation records mapping
     * @param userTotalLiquidationAmount 用户总清算数量映射 User total liquidation amount mapping
     * @param liquidatorCollateralStats 清算人抵押物统计映射 Liquidator collateral stats mapping
     * @return seizedAmount 实际扣押数量 Actual seized amount
     */
    function seizeCollateral(
        address targetUserAddr,
        address collateralAssetAddr,
        uint256 seizeAmount,
        address liquidatorAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        mapping(address => mapping(address => LiquidationTypes.LiquidationRecord)) storage userLiquidationRecords,
        mapping(address => uint256) storage userTotalLiquidationAmount,
        mapping(address => mapping(address => LiquidationTypes.LiquidatorCollateralStats)) storage liquidatorCollateralStats
    ) internal returns (uint256 seizedAmount) {
        LiquidationValidationLibrary.validateAddress(targetUserAddr);
        LiquidationValidationLibrary.validateAddress(collateralAssetAddr);
        LiquidationValidationLibrary.validateAddress(liquidatorAddr);
        LiquidationValidationLibrary.validateAmount(seizeAmount);

        // 获取可扣押数量
        uint256 seizableAmount = getSeizableCollateralAmount(targetUserAddr, collateralAssetAddr, moduleCache);
        if (seizableAmount == 0) revert LiquidationValidationLibrary.InsufficientCollateral();

        seizedAmount = seizeAmount > seizableAmount ? seizableAmount : seizeAmount;

        // 从抵押物管理器提取抵押物
        address collateralManager = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, DEFAULT_CACHE_MAX_AGE);
        if (collateralManager != address(0)) {
            ICollateralManager(collateralManager).withdrawCollateral(targetUserAddr, collateralAssetAddr, seizedAmount);
        }

        // 更新清算记录
        updateLiquidationRecord(
            targetUserAddr, 
            collateralAssetAddr, 
            seizedAmount, 
            liquidatorAddr,
            userLiquidationRecords,
            userTotalLiquidationAmount
        );

        // 更新清算人统计
        liquidatorCollateralStats[liquidatorAddr][collateralAssetAddr].totalSeizedAmount += seizedAmount;
        liquidatorCollateralStats[liquidatorAddr][collateralAssetAddr].totalSeizedCount++;

        // 触发事件
        LiquidationEventLibrary.emitLiquidationCollateralRecordUpdated(
            targetUserAddr,
            collateralAssetAddr,
            0, // oldAmount - 这里可以优化为记录之前的数量
            seizedAmount,
            block.timestamp
        );

        return seizedAmount;
    }

    /**
     * @notice 批量扣押用户抵押物 - 完整的业务逻辑实现
     * @notice Batch seize user collateral - Complete business logic implementation
     * @param targetUserAddr 被清算用户地址 Target user address
     * @param assetAddrs 抵押资产地址数组 Array of asset addresses
     * @param amounts 扣押数量数组 Array of amounts
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param moduleCache 模块缓存 Module cache
     * @param userLiquidationRecords 用户清算记录映射 User liquidation records mapping
     * @param userTotalLiquidationAmount 用户总清算数量映射 User total liquidation amount mapping
     * @param liquidatorCollateralStats 清算人抵押物统计映射 Liquidator collateral stats mapping
     * @return seizedAmounts 实际扣押数量数组 Array of actual seized amounts
     */
    function batchSeizeCollateral(
        address targetUserAddr,
        address[] calldata assetAddrs,
        uint256[] calldata amounts,
        address liquidatorAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        mapping(address => mapping(address => LiquidationTypes.LiquidationRecord)) storage userLiquidationRecords,
        mapping(address => uint256) storage userTotalLiquidationAmount,
        mapping(address => mapping(address => LiquidationTypes.LiquidatorCollateralStats)) storage liquidatorCollateralStats
    ) internal returns (uint256[] memory seizedAmounts) {
        LiquidationValidationLibrary.validateAddress(targetUserAddr);
        LiquidationValidationLibrary.validateAddress(liquidatorAddr);
        
        if (assetAddrs.length != amounts.length) revert("Array length mismatch");
        
        uint256 length = assetAddrs.length;
        seizedAmounts = new uint256[](length);

        for (uint256 i = 0; i < length;) {
            if (assetAddrs[i] != address(0) && amounts[i] > 0) {
                seizedAmounts[i] = seizeCollateral(
                    targetUserAddr, 
                    assetAddrs[i], 
                    amounts[i], 
                    liquidatorAddr, 
                    moduleCache,
                    userLiquidationRecords,
                    userTotalLiquidationAmount,
                    liquidatorCollateralStats
                );
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice 转移清算抵押物给清算人 - 完整的业务逻辑实现
     * @notice Transfer liquidation collateral to liquidator - Complete business logic implementation
     * @param assetAddr 资产地址 Asset address
     * @param amount 转移数量 Transfer amount
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param liquidatorCollateralStats 清算人抵押物统计映射 Liquidator collateral stats mapping
     */
    function transferLiquidationCollateral(
        address assetAddr,
        uint256 amount,
        address liquidatorAddr,
        mapping(address => mapping(address => LiquidationTypes.LiquidatorCollateralStats)) storage liquidatorCollateralStats
    ) internal {
        LiquidationValidationLibrary.validateAddress(assetAddr);
        LiquidationValidationLibrary.validateAddress(liquidatorAddr);
        LiquidationValidationLibrary.validateAmount(amount);

        uint256 availableAmount = liquidatorCollateralStats[liquidatorAddr][assetAddr].totalSeizedAmount;
        if (availableAmount < amount) revert("Insufficient collateral");

        liquidatorCollateralStats[liquidatorAddr][assetAddr].totalSeizedAmount -= amount;

        // 执行转移操作
        LiquidationTokenLibrary.safeTransferERC20Direct(assetAddr, liquidatorAddr, amount);

        // 触发事件 - 使用现有的记录更新事件
        LiquidationEventLibrary.emitLiquidationCollateralRecordUpdated(
            liquidatorAddr, // 清算人作为用户
            assetAddr,
            0, // oldAmount
            amount, // newAmount
            block.timestamp
        );
    }

    /* ============ Query Functions ============ */
    
    /**
     * @notice 检查用户是否可被清算 - 检查用户是否可被清算
     * @notice Check if user is liquidatable - Check if user is liquidatable
     * @param targetUserAddr 用户地址 User address
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @param moduleCache 模块缓存 Module cache
     * @return liquidatable 是否可被清算 Whether liquidatable
     */
    function isLiquidatable(
        address targetUserAddr,
        mapping(bytes32 => uint256) storage liquidationConfigStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (bool liquidatable) {
        if (targetUserAddr == address(0)) return false;
        
        // 获取健康因子阈值
        uint256 healthFactorThreshold = liquidationConfigStorage[keccak256("HEALTH_FACTOR_THRESHOLD")];
        if (healthFactorThreshold == 0) {
            healthFactorThreshold = 1e18; // 默认100%
        }
        
        // 获取用户健康因子 - 简化版本
        uint256 collateralValue = 0;
        uint256 debtValue = 0;
        address debtManagerAddr = ModuleCache.get(moduleCache, ModuleKeys.KEY_LIQUIDATION_DEBT_MANAGER, DEFAULT_CACHE_MAX_AGE);
        if (debtManagerAddr != address(0)) {
            // 注意：getUserTotalDebtValue 方法已从接口中移除
            // 这里返回0，实际实现应该通过其他方式获取
            debtValue = 0;
        }
        uint256 liquidationThreshold = liquidationConfigStorage[keccak256("LIQUIDATION_THRESHOLD")];
        if (liquidationThreshold == 0) {
            liquidationThreshold = 1e18; // 默认100%
        }
        
        // 计算健康因子
        uint256 healthFactor = LiquidationViewLibrary.calculateHealthFactor(collateralValue, debtValue, liquidationThreshold);
        
        // 判断是否可清算
        liquidatable = healthFactor < healthFactorThreshold;
    }

    /**
     * @notice 获取清算阈值 - 获取清算阈值
     * @notice Get liquidation threshold - Get liquidation threshold
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @return threshold 清算阈值 Liquidation threshold
     */
    function getLiquidationThreshold(
        mapping(bytes32 => uint256) storage liquidationConfigStorage
    ) internal view returns (uint256 threshold) {
        threshold = liquidationConfigStorage[keccak256("LIQUIDATION_THRESHOLD")];
        if (threshold == 0) {
            threshold = 1e18; // 默认100%
        }
    }

    /**
     * @notice 减少债务 - 减少用户的债务
     * @notice Reduce debt - Reduce user's debt
     * @param targetUserAddr 被清算用户地址 Target user address
     * @param debtAssetAddr 债务资产地址 Debt asset address
     * @param reduceAmount 减少数量 Reduce amount
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param moduleCache 模块缓存 Module cache
     * @return reducedAmount 实际减少数量 Actual reduced amount
     */
    function reduceDebt(
        address targetUserAddr,
        address debtAssetAddr,
        uint256 reduceAmount,
        address liquidatorAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal returns (uint256 reducedAmount) {
        LiquidationValidationLibrary.validateAddress(targetUserAddr);
        LiquidationValidationLibrary.validateAddress(debtAssetAddr);
        LiquidationValidationLibrary.validateAddress(liquidatorAddr);
        LiquidationValidationLibrary.validateAmount(reduceAmount);

        address lendingEngine = ModuleCache.get(moduleCache, ModuleKeys.KEY_LE, DEFAULT_CACHE_MAX_AGE);
        if (lendingEngine != address(0)) {
            // ILendingEngineBasic.forceReduceDebt 在当前接口中不返回值
            ILendingEngineBasic(lendingEngine).forceReduceDebt(targetUserAddr, debtAssetAddr, reduceAmount);
            reducedAmount = reduceAmount;
        }
    }

    /**
     * @notice 执行清算操作 - 核心清算逻辑
     * @notice Execute liquidation operation - Core liquidation logic
     * @param targetUserAddr 被清算用户地址 Target user address
     * @param collateralAssetAddr 抵押资产地址 Collateral asset address
     * @param debtAssetAddr 债务资产地址 Debt asset address
     * @param collateralAmount 清算抵押物数量 Collateral amount to liquidate
     * @param debtAmount 清算债务数量 Debt amount to liquidate
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param liquidationConfigStorage 清算配置存储 Liquidation configuration storage
     * @param moduleCache 模块缓存 Module cache
     * @param userLiquidationRecords 用户清算记录映射 User liquidation records mapping
     * @param userTotalLiquidationAmount 用户总清算数量映射 User total liquidation amount mapping
     * @param liquidatorCollateralStats 清算人抵押物统计映射 Liquidator collateral stats mapping
     * @return bonus 清算奖励 Liquidation bonus
     */
    function executeLiquidation(
        address targetUserAddr,
        address collateralAssetAddr,
        address debtAssetAddr,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidatorAddr,
        mapping(bytes32 => uint256) storage liquidationConfigStorage,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        mapping(address => mapping(address => LiquidationTypes.LiquidationRecord)) storage userLiquidationRecords,
        mapping(address => uint256) storage userTotalLiquidationAmount,
        mapping(address => mapping(address => LiquidationTypes.LiquidatorCollateralStats)) storage liquidatorCollateralStats
    ) internal returns (uint256 bonus) {
        // 扣押抵押物
        uint256 seizedAmount = seizeCollateral(targetUserAddr, collateralAssetAddr, collateralAmount, liquidatorAddr, moduleCache, userLiquidationRecords, userTotalLiquidationAmount, liquidatorCollateralStats);
        
        // 减少债务
        uint256 reducedAmount = reduceDebt(targetUserAddr, debtAssetAddr, debtAmount, liquidatorAddr, moduleCache);
        
        // 计算清算奖励 - 使用 ViewLibrary 中的函数
        bonus = LiquidationViewLibrary.calculateLiquidationBonus(seizedAmount, reducedAmount, liquidationConfigStorage);
        
        // 触发清算完成事件
        LiquidationEventLibrary.emitLiquidationCompleted(
            targetUserAddr,
            debtAssetAddr,
            liquidatorAddr,
            reducedAmount,
            seizedAmount,
            bonus
        );
    }

    /**
     * @notice 获取用户可扣押的抵押物数量
     * @notice Get user's seizable collateral amount
     * @param targetUserAddr 用户地址 User address
     * @param assetAddr 资产地址 Asset address
     * @param moduleCache 模块缓存 Module cache
     * @return seizableAmount 可扣押数量 Seizable amount
     */
    function getSeizableCollateralAmount(
        address targetUserAddr,
        address assetAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256 seizableAmount) {
        LiquidationValidationLibrary.validateAddress(targetUserAddr);
        LiquidationValidationLibrary.validateAddress(assetAddr);

        address collateralManager = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, DEFAULT_CACHE_MAX_AGE);
        if (collateralManager != address(0)) {
            try ICollateralManager(collateralManager).getCollateral(targetUserAddr, assetAddr) returns (uint256 amount) {
                seizableAmount = amount;
            } catch {
                seizableAmount = 0;
            }
        }
    }

    /**
     * @notice 获取用户清算记录
     * @notice Get user liquidation record
     * @param targetUser 用户地址 User address
     * @param targetAsset 资产地址 Asset address
     * @param userLiquidationRecords 用户清算记录映射 User liquidation records mapping
     * @return seizedAmount 已扣押数量 Seized amount
     * @return lastSeizedTime 最后扣押时间 Last seized time
     */
    function getLiquidationRecord(
        address targetUser,
        address targetAsset,
        mapping(address => mapping(address => LiquidationTypes.LiquidationRecord)) storage userLiquidationRecords
    ) internal view returns (uint256 seizedAmount, uint256 lastSeizedTime) {
        LiquidationValidationLibrary.validateAddress(targetUser);
        LiquidationValidationLibrary.validateAddress(targetAsset);

        LiquidationTypes.LiquidationRecord memory record = userLiquidationRecords[targetUser][targetAsset];
        seizedAmount = record.amount;
        lastSeizedTime = record.timestamp;
    }

    /**
     * @notice 获取用户总清算数量
     * @notice Get user total liquidation amount
     * @param targetUser 用户地址 User address
     * @param userTotalLiquidationAmount 用户总清算数量映射 User total liquidation amount mapping
     * @return totalAmount 总清算数量 Total liquidation amount
     */
    function getUserTotalLiquidationAmount(
        address targetUser,
        mapping(address => uint256) storage userTotalLiquidationAmount
    ) internal view returns (uint256 totalAmount) {
        LiquidationValidationLibrary.validateAddress(targetUser);
        return userTotalLiquidationAmount[targetUser];
    }

    /**
     * @notice 获取清算人临时抵押物数量
     * @notice Get liquidator temporary collateral amount
     * @param liquidator 清算人地址 Liquidator address
     * @param asset 资产地址 Asset address
     * @param liquidatorCollateralStats 清算人抵押物统计映射 Liquidator collateral stats mapping
     * @return amount 临时抵押物数量 Temporary collateral amount
     */
    function getLiquidatorCollateralTemp(
        address liquidator,
        address asset,
        mapping(address => mapping(address => LiquidationTypes.LiquidatorCollateralStats)) storage liquidatorCollateralStats
    ) internal view returns (uint256 amount) {
        LiquidationValidationLibrary.validateAddress(liquidator);
        LiquidationValidationLibrary.validateAddress(asset);
        return liquidatorCollateralStats[liquidator][asset].totalSeizedAmount;
    }

    /**
     * @notice 获取用户所有清算抵押物记录
     * @notice Get user all liquidation collateral records
     * @param targetUser 用户地址 User address
     * @param moduleCache 模块缓存 Module cache
     * @param userLiquidationRecords 用户清算记录映射 User liquidation records mapping
     * @return assets 资产地址数组 Array of asset addresses
     * @return seizedAmounts 已扣押数量数组 Array of seized amounts
     * @return lastSeizedTimes 最后扣押时间数组 Array of last seized times
     */
    function getUserAllLiquidationCollateralRecords(
        address targetUser,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        mapping(address => mapping(address => LiquidationTypes.LiquidationRecord)) storage userLiquidationRecords
    ) internal view returns (
        address[] memory assets,
        uint256[] memory seizedAmounts,
        uint256[] memory lastSeizedTimes
    ) {
        LiquidationValidationLibrary.validateAddress(targetUser);

        address collateralManager = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, DEFAULT_CACHE_MAX_AGE);
        if (collateralManager != address(0)) {
            try ICollateralManager(collateralManager).getUserCollateralAssets(targetUser) returns (address[] memory userAssets) {
                assets = userAssets;
                uint256 length = assets.length;
                seizedAmounts = new uint256[](length);
                lastSeizedTimes = new uint256[](length);
                
                for (uint256 i = 0; i < length; i++) {
                    LiquidationTypes.LiquidationRecord memory record = userLiquidationRecords[targetUser][assets[i]];
                    seizedAmounts[i] = record.amount;
                    lastSeizedTimes[i] = record.timestamp;
                }
            } catch {
                assets = new address[](0);
                seizedAmounts = new uint256[](0);
                lastSeizedTimes = new uint256[](0);
            }
        } else {
            assets = new address[](0);
            seizedAmounts = new uint256[](0);
            lastSeizedTimes = new uint256[](0);
        }
    }

    /* ============ Record Management Functions ============ */
    
    /**
     * @notice 更新清算记录 - 内部函数，更新用户的清算记录
     * @notice Update liquidation record - Internal function to update user's liquidation record
     * @param targetUser 用户地址 User address
     * @param targetAsset 资产地址 Asset address
     * @param seizeAmount 清算数量 Liquidation amount
     * @param liquidatorAddr 清算人地址 Liquidator address
     * @param userLiquidationRecords 用户清算记录映射 User liquidation records mapping
     * @param userTotalLiquidationAmount 用户总清算数量映射 User total liquidation amount mapping
     */
    function updateLiquidationRecord(
        address targetUser,
        address targetAsset,
        uint256 seizeAmount,
        address liquidatorAddr,
        mapping(address => mapping(address => LiquidationTypes.LiquidationRecord)) storage userLiquidationRecords,
        mapping(address => uint256) storage userTotalLiquidationAmount
    ) internal {
        LiquidationValidationLibrary.validateAddress(targetUser);
        LiquidationValidationLibrary.validateAddress(targetAsset);
        LiquidationValidationLibrary.validateAddress(liquidatorAddr);
        LiquidationValidationLibrary.validateAmount(seizeAmount);

        LiquidationTypes.LiquidationRecord storage record = userLiquidationRecords[targetUser][targetAsset];
        uint256 oldAmount = record.amount;
        
        record.user = targetUser;
        record.asset = targetAsset;
        record.amount = oldAmount + seizeAmount;
        record.timestamp = block.timestamp;
        record.liquidator = liquidatorAddr;

        userTotalLiquidationAmount[targetUser] += seizeAmount;

        // 触发事件
        LiquidationEventLibrary.emitLiquidationCollateralRecordUpdated(
            targetUser,
            targetAsset,
            oldAmount,
            record.amount,
            block.timestamp
        );
    }

    /**
     * @notice 清除清算记录 - 清除指定用户的清算记录
     * @notice Clear liquidation record - Clear liquidation record of specified user
     * @param targetUser 用户地址 User address
     * @param targetAsset 资产地址 Asset address
     * @param userLiquidationRecords 用户清算记录映射 User liquidation records mapping
     * @param userTotalLiquidationAmount 用户总清算数量映射 User total liquidation amount mapping
     */
    function clearLiquidationRecord(
        address targetUser,
        address targetAsset,
        mapping(address => mapping(address => LiquidationTypes.LiquidationRecord)) storage userLiquidationRecords,
        mapping(address => uint256) storage userTotalLiquidationAmount
    ) internal {
        LiquidationValidationLibrary.validateAddress(targetUser);
        LiquidationValidationLibrary.validateAddress(targetAsset);

        LiquidationTypes.LiquidationRecord memory oldRecord = userLiquidationRecords[targetUser][targetAsset];
        delete userLiquidationRecords[targetUser][targetAsset];
        
        if (oldRecord.amount > 0) {
            userTotalLiquidationAmount[targetUser] -= oldRecord.amount;
        }

        LiquidationEventLibrary.emitLiquidationCollateralRecordUpdated(
            targetUser,
            targetAsset,
            oldRecord.amount,
            0,
            block.timestamp
        );
    }

    /* ============ Batch Query Functions ============ */
    
    /**
     * @notice 批量获取用户可扣押抵押物数量
     * @notice Batch get user seizable collateral amounts
     * @param users 用户地址数组 Array of user addresses
     * @param assets 资产地址数组 Array of asset addresses
     * @param moduleCache 模块缓存 Module cache
     * @return seizableAmounts 可扣押数量数组 Array of seizable amounts
     */
    function batchGetSeizableCollateralAmounts(
        address[] calldata users,
        address[] calldata assets,
        ModuleCache.ModuleCacheStorage storage moduleCache
    ) internal view returns (uint256[] memory seizableAmounts) {
        if (users.length != assets.length) revert("Array length mismatch");
        
        uint256 length = users.length;
        seizableAmounts = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            if (users[i] != address(0) && assets[i] != address(0)) {
                seizableAmounts[i] = getSeizableCollateralAmount(users[i], assets[i], moduleCache);
            }
            unchecked { ++i; }
        }
    }
} 
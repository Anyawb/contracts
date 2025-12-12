// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { VaultTypes } from "./VaultTypes.sol";
import { DivisionByZero } from "../errors/StandardErrors.sol";

/// @title VaultMath
/// @notice 纯数学计算库，所有函数应保持无状态、纯函数特性。
/// @dev 重命名自CollateralVaultMath，提供统一的数学计算功能
library VaultMath {
    /// @notice 计算百分比乘法
    /// @param value 基础值
    /// @param percentage 百分比（基点）
    /// @return 计算结果
    function percentageMul(uint256 value, uint256 percentage)
        internal
        pure
        returns (uint256)
    {
        if (percentage == 0) revert DivisionByZero();
        return (value * percentage) / VaultTypes.HUNDRED_PERCENT;
    }

    /// @notice 计算百分比除法
    /// @param value 基础值
    /// @param percentage 百分比（基点）
    /// @return 计算结果
    function percentageDiv(uint256 value, uint256 percentage)
        internal
        pure
        returns (uint256)
    {
        if (percentage == 0) revert DivisionByZero();
        return (value * VaultTypes.HUNDRED_PERCENT) / percentage;
    }

    /// @notice 计算健康因子
    /// @param collateral 抵押物价值
    /// @param debt 债务价值
    /// @return 健康因子（基点）
    function calculateHealthFactor(uint256 collateral, uint256 debt)
        internal
        pure
        returns (uint256)
    {
        if (debt == 0) return type(uint256).max;
        return (collateral * VaultTypes.HUNDRED_PERCENT) / debt;
    }

    /// @notice 计算贷款价值比（LTV）
    /// @param debt 债务价值
    /// @param collateral 抵押物价值
    /// @return LTV（基点）
    function calculateLTV(uint256 debt, uint256 collateral)
        internal
        pure
        returns (uint256)
    {
        if (collateral == 0) return 0;
        return (debt * VaultTypes.HUNDRED_PERCENT) / collateral;
    }

    /// @notice 计算清算奖励
    /// @param amount 清算金额
    /// @param bonus 奖励比例（基点）
    /// @return 奖励金额
    function calculateLiquidationBonus(uint256 amount, uint256 bonus)
        internal
        pure
        returns (uint256)
    {
        return percentageMul(amount, bonus);
    }

    /// @notice 计算手续费
    /// @param amount 基础金额
    /// @param feeRate 手续费率（基点）
    /// @return 手续费金额
    function calculateFee(uint256 amount, uint256 feeRate)
        internal
        pure
        returns (uint256)
    {
        return percentageMul(amount, feeRate);
    }

    /// @notice 计算扣除手续费后的金额
    /// @param amount 原始金额
    /// @param feeRate 手续费率（基点）
    /// @return 扣除手续费后的金额
    function calculateAmountAfterFee(uint256 amount, uint256 feeRate)
        internal
        pure
        returns (uint256)
    {
        return amount - calculateFee(amount, feeRate);
    }

    /// @notice 计算最大可借金额
    /// @param collateral 抵押物价值
    /// @param currentDebt 当前债务
    /// @param maxLTV 最大LTV（基点）
    /// @return 最大可借金额
    function calculateMaxBorrowable(uint256 collateral, uint256 currentDebt, uint256 maxLTV)
        internal
        pure
        returns (uint256)
    {
        uint256 maxDebt = percentageMul(collateral, maxLTV);
        if (currentDebt >= maxDebt) return 0;
        return maxDebt - currentDebt;
    }

    /// @notice 计算最小抵押物要求
    /// @param debt 债务金额
    /// @param maxLTV 最大LTV（基点）
    /// @return 最小抵押物要求
    function calculateMinCollateral(uint256 debt, uint256 maxLTV)
        internal
        pure
        returns (uint256)
    {
        if (maxLTV == 0) return type(uint256).max;
        return percentageDiv(debt, maxLTV);
    }

    // ============ 新增残值计算函数 ============
    /// @notice 计算清算残值
    /// @param collateralValue 抵押物价值
    /// @param debtValue 债务价值
    /// @return residualValue 残值金额
    function calculateLiquidationResidual(uint256 collateralValue, uint256 debtValue)
        internal
        pure
        returns (uint256 residualValue)
    {
        if (collateralValue <= debtValue) return 0;
        return collateralValue - debtValue;
    }

    /// @notice 计算清算残值比例
    /// @param collateralValue 抵押物价值
    /// @param debtValue 债务价值
    /// @return residualRatio 残值比例（基点）
    function calculateResidualRatio(uint256 collateralValue, uint256 debtValue)
        internal
        pure
        returns (uint256 residualRatio)
    {
        if (collateralValue == 0) return 0;
        if (debtValue >= collateralValue) return 0;
        
        uint256 residual = collateralValue - debtValue;
        return (residual * VaultTypes.HUNDRED_PERCENT) / collateralValue;
    }

    /// @notice 计算清算效率（债务覆盖率）
    /// @param collateralValue 抵押物价值
    /// @param debtValue 债务价值
    /// @return efficiency 清算效率（基点）
    function calculateLiquidationEfficiency(uint256 collateralValue, uint256 debtValue)
        internal
        pure
        returns (uint256 efficiency)
    {
        if (collateralValue == 0) return 0;
        if (debtValue == 0) return VaultTypes.HUNDRED_PERCENT;
        
        uint256 coverage = (debtValue * VaultTypes.HUNDRED_PERCENT) / collateralValue;
        return coverage > VaultTypes.HUNDRED_PERCENT ? VaultTypes.HUNDRED_PERCENT : coverage;
    }

    /// @notice 计算清算损失
    /// @param collateralValue 抵押物价值
    /// @param debtValue 债务价值
    /// @return loss 清算损失金额
    function calculateLiquidationLoss(uint256 collateralValue, uint256 debtValue)
        internal
        pure
        returns (uint256 loss)
    {
        if (debtValue <= collateralValue) return 0;
        return debtValue - collateralValue;
    }

    /// @notice 计算清算损失比例
    /// @param collateralValue 抵押物价值
    /// @param debtValue 债务价值
    /// @return lossRatio 清算损失比例（基点）
    function calculateLiquidationLossRatio(uint256 collateralValue, uint256 debtValue)
        internal
        pure
        returns (uint256 lossRatio)
    {
        if (debtValue == 0) return 0;
        if (collateralValue >= debtValue) return 0;
        
        uint256 loss = debtValue - collateralValue;
        return (loss * VaultTypes.HUNDRED_PERCENT) / debtValue;
    }

    /// @notice 计算最优清算金额（最大化残值）
    /// @param collateralValue 抵押物价值
    /// @param debtValue 债务价值
    /// @param maxLiquidationRatio 最大清算比例（基点）
    /// @return optimalAmount 最优清算金额
    function calculateOptimalLiquidationAmount(
        uint256 collateralValue,
        uint256 debtValue,
        uint256 maxLiquidationRatio
    ) internal pure returns (uint256 optimalAmount) {
        if (collateralValue == 0 || debtValue == 0) return 0;
        
        // 计算最大可清算金额
        uint256 maxLiquidationAmount = percentageMul(collateralValue, maxLiquidationRatio);
        
        // 如果债务价值小于最大可清算金额，则清算全部债务
        if (debtValue <= maxLiquidationAmount) {
            return debtValue;
        }
        
        // 否则清算最大可清算金额
        return maxLiquidationAmount;
    }

    /// @notice 计算清算后的剩余抵押物
    /// @param originalCollateral 原始抵押物价值
    /// @param liquidationAmount 清算金额
    /// @return remainingCollateral 剩余抵押物价值
    function calculateRemainingCollateral(uint256 originalCollateral, uint256 liquidationAmount)
        internal
        pure
        returns (uint256 remainingCollateral)
    {
        if (liquidationAmount >= originalCollateral) return 0;
        return originalCollateral - liquidationAmount;
    }

    /// @notice 计算清算后的剩余债务
    /// @param originalDebt 原始债务价值
    /// @param liquidationAmount 清算金额
    /// @return remainingDebt 剩余债务价值
    function calculateRemainingDebt(uint256 originalDebt, uint256 liquidationAmount)
        internal
        pure
        returns (uint256 remainingDebt)
    {
        if (liquidationAmount >= originalDebt) return 0;
        return originalDebt - liquidationAmount;
    }
} 
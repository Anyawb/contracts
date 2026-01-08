// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ISettlementManager
/// @notice 统一结算/清算写入口（SSOT）：承接还款结算与被动清算
/// @dev 目标：所有 repay/early repay/overdue/risk-liquidation 统一收敛到该模块
interface ISettlementManager {
    /// @notice 用户还款并触发结算（可能释放抵押；必要时进入清算分支）
    /// @param user 借款人/还款人
    /// @param debtAsset 债务资产
    /// @param repayAmount 还款金额
    /// @param orderId 仓位主键（SSOT）：LendingEngine 生成的订单 ID（历史旧称/旧口径一律视为该值）
    function repayAndSettle(address user, address debtAsset, uint256 repayAmount, uint256 orderId) external;

    /// @notice Keeper/机器人触发到期/风控处置入口：合约内部基于 orderId 自动判定结算 or 清算，并计算清算参数
    /// @param orderId 仓位主键（SSOT）：LendingEngine 生成的订单 ID（历史旧称/旧口径一律视为该值）
    function settleOrLiquidate(uint256 orderId) external;
}


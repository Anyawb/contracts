// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SettlementReserveLib
/// @notice 出借资金保留/取消/消耗的轻量库（仅管理状态与最小校验，不做外部转账）
/// @dev 存储变量需定义在调用方合约中（mapping(bytes32=>LendReserve)），库仅对其进行读写
library SettlementReserveLib {
    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/
    struct LendReserve {
        address lender;      // 出借人
        address asset;       // 借出资产
        uint256 amount;      // 预留金额
        bool active;         // 是否有效
    }

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    error Settlement__ZeroAddress();
    error Settlement__InvalidAmount();
    error Settlement__AlreadyReserved();
    error Settlement__NotActive();
    error Settlement__NotOwner();

    /*━━━━━━━━━━━━━━━ API ━━━━━━━━━━━━━━━*/

    /// @notice 记录一次资金保留（不做转账，由上层负责先完成转账，再落状态更安全）
    /// @param reserves 储备映射（调用方合约中的 storage）
    /// @param lender 出借人
    /// @param asset 资产
    /// @param amount 金额
    /// @param intentHash 出借意向哈希（去中心化订单标识）
    function reserve(
        mapping(bytes32 => LendReserve) storage reserves,
        address lender,
        address asset,
        uint256 amount,
        bytes32 intentHash
    ) internal {
        if (lender == address(0) || asset == address(0)) revert Settlement__ZeroAddress();
        if (amount == 0) revert Settlement__InvalidAmount();
        LendReserve storage slot = reserves[intentHash];
        if (slot.active) revert Settlement__AlreadyReserved();

        slot.lender = lender;
        slot.asset = asset;
        slot.amount = amount;
        slot.active = true;
    }

    /// @notice 取消已保留的资金（仅限原出借人）
    /// @return asset 被释放资产
    /// @return amount 被释放金额
    function cancel(
        mapping(bytes32 => LendReserve) storage reserves,
        bytes32 intentHash,
        address caller
    ) internal returns (address asset, uint256 amount) {
        LendReserve storage slot = reserves[intentHash];
        if (!slot.active) revert Settlement__NotActive();
        if (slot.lender != caller) revert Settlement__NotOwner();
        asset = slot.asset;
        amount = slot.amount;
        delete reserves[intentHash];
    }

    /// @notice 成交时消耗保留资金（将其标记为无效）
    /// @dev 仅允许原出借人或上层指定的撮合执行者调用（此处仅检查 lender，一般由上层传入并二次校验）
    /// @return lender 出借人
    /// @return asset 资产
    /// @return amount 金额
    function consume(
        mapping(bytes32 => LendReserve) storage reserves,
        bytes32 intentHash,
        address expectedLender
    ) internal returns (address lender, address asset, uint256 amount) {
        LendReserve storage slot = reserves[intentHash];
        if (!slot.active) revert Settlement__NotActive();
        if (expectedLender != address(0) && slot.lender != expectedLender) revert Settlement__NotOwner();
        lender = slot.lender;
        asset = slot.asset;
        amount = slot.amount;
        delete reserves[intentHash];
    }

    /// @notice 按需消耗（最多消耗 maxAmount），支持部分消耗并回写剩余
    /// @return lender 出借人
    /// @return asset 资产
    /// @return used 实际消耗金额
    /// @return remaining 剩余保留金额（0 表示该 intentHash 已被清除）
    function consumeUpTo(
        mapping(bytes32 => LendReserve) storage reserves,
        bytes32 intentHash,
        address expectedLender,
        uint256 maxAmount
    ) internal returns (address lender, address asset, uint256 used, uint256 remaining) {
        if (maxAmount == 0) revert Settlement__InvalidAmount();
        LendReserve storage slot = reserves[intentHash];
        if (!slot.active) revert Settlement__NotActive();
        if (expectedLender != address(0) && slot.lender != expectedLender) revert Settlement__NotOwner();
        lender = slot.lender;
        asset = slot.asset;
        if (slot.amount <= maxAmount) {
            used = slot.amount;
            remaining = 0;
            delete reserves[intentHash];
        } else {
            used = maxAmount;
            remaining = slot.amount - maxAmount;
            slot.amount = remaining;
        }
    }
}



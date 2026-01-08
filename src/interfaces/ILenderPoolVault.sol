// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILenderPoolVault
/// @notice 线上流动性资金池（LenderPoolVault）的最小接口：托管出借资金并允许撮合合约拨付借款
/// @dev 设计目标（与用户选择对齐）：
/// - 订单中的 lender 字段语义为“资金池合约地址”（本合约地址）
/// - 线上流动性集中托管于本合约，撮合/结算合约按规则从本合约拨付
interface ILenderPoolVault {
    /// @notice 从调用者拉取资金并存入资金池（供 LP/资金方入金使用）
    function deposit(address asset, uint256 amount) external;

    /// @notice 由撮合/结算模块调用：将指定资产拨付到目标地址（通常为撮合编排合约自身）
    function transferOut(address asset, address to, uint256 amount) external;
}


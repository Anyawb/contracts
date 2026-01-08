// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IVaultCore
/// @notice 核心业务流程接口定义
/// @dev 包含 deposit、borrow、repay、withdraw 等核心业务函数
interface IVaultCore {
    /* ============ Events ============ */
    /// @notice 抵押事件
    event CollateralDeposited(address indexed user, address indexed asset, uint256 amount);
    
    /// @notice 借款事件
    event Borrowed(address indexed user, address indexed asset, uint256 amount);
    
    /// @notice 还款事件
    event Repaid(address indexed user, address indexed asset, uint256 amount);
    
    /// @notice 提取抵押物事件
    event CollateralWithdrawn(address indexed user, address indexed asset, uint256 amount);

    /* ============ Core Business Functions ============ */
    /// @notice 存入抵押物
    /// @param asset 抵押资产地址
    /// @param amount 存入数量
    function deposit(address asset, uint256 amount) external;

    /// @notice 借款
    /// @param asset 借款资产地址
    /// @param amount 借款数量
    function borrow(address asset, uint256 amount) external;

    /// @notice 还款（统一结算入口，SSOT）
    /// @param orderId 仓位主键（SSOT）：LendingEngine 生成的订单 ID（历史旧称/旧口径一律视为该值）
    /// @param asset 还款资产地址
    /// @param amount 还款数量
    function repay(uint256 orderId, address asset, uint256 amount) external;

    /// @notice 提取抵押物
    /// @param asset 抵押资产地址
    /// @param amount 提取数量
    function withdraw(address asset, uint256 amount) external;

    /// @notice 批量存入抵押物
    /// @param assets 资产地址数组
    /// @param amounts 数量数组
    function batchDeposit(address[] calldata assets, uint256[] calldata amounts) external;

    /// @notice 批量借款
    /// @param assets 资产地址数组
    /// @param amounts 数量数组
    function batchBorrow(address[] calldata assets, uint256[] calldata amounts) external;

    /// @notice 批量还款（若启用批量接口，需确保每笔还款都携带对应 orderId）
    function batchRepay(uint256[] calldata orderIds, address[] calldata assets, uint256[] calldata amounts) external;

    /// @notice 批量提取抵押物
    /// @param assets 资产地址数组
    /// @param amounts 数量数组
    function batchWithdraw(address[] calldata assets, uint256[] calldata amounts) external;

    /// @notice 业务编排专用：代表指定 borrower 记账（撮合/结算路径）
    /// @param borrower 借款人地址
    /// @param asset 借款资产地址
    /// @param amount 借款金额
    /// @param termDays 借款期限（天）
    function borrowFor(address borrower, address asset, uint256 amount, uint16 termDays) external;
} 
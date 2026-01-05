// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILendingEngineBasic 多资产债务管理基础接口
/// @notice 提供多资产债务记录、查询和管理的统一入口
/// @dev 支持多种结算币的债务管理，每种资产独立记账
interface ILendingEngineBasic {
    /**
     * @notice 记录用户指定资产的借款
     * @param user 用户地址
     * @param asset 债务资产地址
     * @param amount 借款金额
     * @param collateralAdded 本次伴随的新增抵押物价值（占位参数）
     * @param termDays 借款期限（天，预留参数）
     */
    function borrow(address user, address asset, uint256 amount, uint256 collateralAdded, uint16 termDays) external;

    /**
     * @notice 记录用户指定资产的还款
     * @param user 用户地址
     * @param asset 债务资产地址
     * @param amount 还款金额
     */
    function repay(address user, address asset, uint256 amount) external;

    /**
     * @notice 查询用户指定资产的当前债务
     * @param user 用户地址
     * @param asset 债务资产地址
     * @return debt 当前债务金额
     */
    function getDebt(address user, address asset) external view returns (uint256 debt);

    /**
     * @notice 查询指定资产的总债务
     * @param asset 债务资产地址
     * @return totalDebt 总债务金额
     */
    function getTotalDebtByAsset(address asset) external view returns (uint256 totalDebt);

    /**
     * @notice 查询用户总债务价值（以结算币计价）
     * @param user 用户地址
     * @return totalValue 用户总债务价值
     */
    function getUserTotalDebtValue(address user) external view returns (uint256 totalValue);

    /**
     * @notice 查询系统总债务价值（以结算币计价）
     * @return totalValue 系统总债务价值
     */
    function getTotalDebtValue() external view returns (uint256 totalValue);

    /**
     * @notice 查询用户所有债务资产列表
     * @param user 用户地址
     * @return assets 用户债务的资产地址数组
     */
    function getUserDebtAssets(address user) external view returns (address[] memory assets);

    /**
     * @notice 强制减少用户指定资产的债务（清算场景）
     * @param user 用户地址
     * @param asset 债务资产地址
     * @param amount 减少的债务金额
     */
    function forceReduceDebt(address user, address asset, uint256 amount) external;

    /**
     * @notice 计算用户借款一定数量资产时应该产生的利息
     * @param user 用户地址
     * @param asset 债务资产地址
     * @param amount 借款金额
     * @return interest 预估利息金额
     */
    function calculateExpectedInterest(address user, address asset, uint256 amount) external view returns (uint256 interest);

    /* ============ Liquidation Related Functions ============ */
    
    /**
     * @notice 获取用户可清算的债务数量
     * @param user 用户地址
     * @param asset 债务资产地址
     * @return reducibleAmount 可清算数量
     */
    function getReducibleDebtAmount(address user, address asset) external view returns (uint256 reducibleAmount);

    /**
     * @notice 计算债务价值（以结算币计价）
     * @param user 用户地址
     * @param asset 债务资产地址
     * @return value 债务价值
     */
    function calculateDebtValue(address user, address asset) external view returns (uint256 value);

} 
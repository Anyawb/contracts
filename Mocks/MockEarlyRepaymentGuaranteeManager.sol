// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockEarlyRepaymentGuaranteeManager
/// @notice 提前还款保证金管理器的Mock实现，用于测试
contract MockEarlyRepaymentGuaranteeManager {
    // 用户保证金记录映射
    mapping(address => mapping(address => mapping(address => uint256))) private _userGuarantees;
    
    // 事件
    event GuaranteeRecordLocked(address indexed user, address indexed lender, address indexed asset, uint256 amount, uint256 interest, uint256 termDays);
    event GuaranteeRecordReleased(address indexed user, address indexed lender, address indexed asset, uint256 amount);
    event EarlyRepaymentSettled(address indexed user, address indexed asset, uint256 amount);
    
    /// @notice 锁定保证金记录
    /// @param user 用户地址
    /// @param lender 出借人地址
    /// @param asset 资产地址
    /// @param amount 本金金额
    /// @param interest 利息金额
    /// @param termDays 借款期限
    function lockGuaranteeRecord(
        address user,
        address lender,
        address asset,
        uint256 amount,
        uint256 interest,
        uint256 termDays
    ) external {
        _userGuarantees[user][lender][asset] += interest;
        emit GuaranteeRecordLocked(user, lender, asset, amount, interest, termDays);
    }
    
    /// @notice 释放保证金记录
    /// @param user 用户地址
    /// @param lender 出借人地址
    /// @param asset 资产地址
    /// @param amount 释放金额
    function releaseGuaranteeRecord(
        address user,
        address lender,
        address asset,
        uint256 amount
    ) external {
        require(_userGuarantees[user][lender][asset] >= amount, "Insufficient guarantee record");
        _userGuarantees[user][lender][asset] -= amount;
        emit GuaranteeRecordReleased(user, lender, asset, amount);
    }

    /// @notice 结算提前还款
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 还款金额
    function settleEarlyRepayment(
        address user,
        address asset,
        uint256 amount
    ) external {
        // Mock实现：简单记录事件
        emit EarlyRepaymentSettled(user, asset, amount);
    }
    
    /// @notice 获取用户保证金记录数量
    /// @param user 用户地址
    /// @param lender 出借人地址
    /// @param asset 资产地址
    /// @return 保证金记录数量
    function getUserGuaranteeRecord(
        address user,
        address lender,
        address asset
    ) external view returns (uint256) {
        return _userGuarantees[user][lender][asset];
    }
}

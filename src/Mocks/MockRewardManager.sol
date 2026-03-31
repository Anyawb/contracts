// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IRewardManagerByOrder, IRewardManagerByOrderWithLender } from "../interfaces/IRewardManager.sol";

/// @title MockRewardManager
/// @notice 奖励管理器的Mock实现，用于测试
contract MockRewardManager is IRewardManagerByOrder, IRewardManagerByOrderWithLender {
    // 用户奖励映射
    mapping(address => uint256) private _userRewards;
    
    // 测试控制标志
    bool public mockSuccess = true;
    
    // 事件
    event RewardEarned(address indexed user, uint256 amount);
    
    /// @notice 处理借贷事件（按订单维度）
    /// @dev 测试用：仅做最简累加，不代表真实 Reward 逻辑
    function onLoanEventByOrder(
        address user,
        uint256,
        uint256 amount,
        uint256,
        LoanEventOutcome outcome
    ) public override {
        if (!mockSuccess) revert("MRM: loan event fail");
        if (outcome != LoanEventOutcome.Borrow) return;
        uint256 reward = amount / 100;
        if (reward == 0) return;
        _userRewards[user] += reward;
        emit RewardEarned(user, reward);
    }

    /// @notice 处理借贷事件（按订单维度，含 lender 与 asset）
    /// @dev 测试用：直接复用 onLoanEventByOrder 的逻辑
    function onLoanEventByOrderWithLender(
        address borrower,
        address,
        address,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        IRewardManagerByOrder.LoanEventOutcome outcome
    ) external override {
        onLoanEventByOrder(borrower, orderId, amount, maturity, outcome);
    }
    
    /// @notice 设置用户奖励数量（用于测试）
    /// @param user 用户地址
    /// @param amount 奖励数量
    function setUserReward(address user, uint256 amount) external {
        _userRewards[user] = amount;
    }

    /// @notice 设置成功标志（测试用）
    /// @param success 是否成功
    function setMockSuccess(bool success) external {
        mockSuccess = success;
    }
} 
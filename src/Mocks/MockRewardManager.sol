// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    IRewardManagerByOrder,
    IRewardManagerByOrderWithLender
} from "../interfaces/IRewardManager.sol";

/// @title MockRewardManager
/// @notice Mock reward manager implementation for tests.
contract MockRewardManager is
    IRewardManagerByOrder,
    IRewardManagerByOrderWithLender
{
    // User reward balances.
    mapping(address => uint256) private _userRewards;

    // Test control flag.
    bool public mockSuccess = true;

    // Events.
    event RewardEarned(address indexed user, uint256 amount);

    /// @notice Processes an order-scoped loan event.
    /// @dev Test-only logic accumulates a minimal synthetic reward.
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

    /// @notice Processes an order-scoped loan event with lender and asset context.
    /// @dev Test-only logic reuses onLoanEventByOrder.
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

    /// @notice Sets a user's reward balance for tests.
    /// @param user User address.
    /// @param amount Reward amount.
    function setUserReward(address user, uint256 amount) external {
        _userRewards[user] = amount;
    }

    /// @notice Sets whether mock operations succeed.
    /// @param success True when operations should succeed.
    function setMockSuccess(bool success) external {
        mockSuccess = success;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IRewardManager } from "../interfaces/IRewardManager.sol";

/// @title MockRewardManager
/// @notice 奖励管理器的Mock实现，用于测试
contract MockRewardManager is IRewardManager {
    // 用户奖励映射
    mapping(address => uint256) private _userRewards;
    
    // 测试控制标志
    bool public mockSuccess = true;
    
    // 事件
    event RewardEarned(address indexed user, uint256 amount);
    
    /// @notice 处理借贷事件（落账后触发的标准入口）
    /// @param user 用户地址
    /// @param amount 金额（以最小单位，USDT/USDC按 6 位，ETH 按 18 位）
    function onLoanEvent(address user, uint256 amount, uint256, bool) external override {
        if (!mockSuccess) revert("MockRewardManager: onLoanEvent failed");
        // 模拟奖励计算（简化版本）
        uint256 reward = amount / 100; // 基础奖励
        // 简化：忽略健康因子
        
        if (reward > 0) {
            _userRewards[user] += reward;
            emit RewardEarned(user, reward);
        }
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
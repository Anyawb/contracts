// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IRewardManager } from "../interfaces/IRewardManager.sol";

/// @title MockRewardManager
/// @notice 奖励管理器的Mock实现，用于测试
contract MockRewardManager is IRewardManager {
    // 用户奖励映射
    mapping(address => uint256) private _userRewards;
    uint256 private _rewardRate = 100; // 默认 1%
    
    // 测试控制标志
    bool public mockSuccess = true;
    
    // 事件
    event LoanEventProcessed(address indexed user, int256 debtChange, int256 collateralChange);
    event RewardEarned(address indexed user, uint256 amount);
    event RewardRateUpdated(uint256 newRate);
    event PenaltyApplied(address indexed user, uint256 points);
    
    /// @notice 设置奖励率
    /// @param rate 奖励率（基点）
    function setRewardRate(uint256 rate) external override {
        require(rate <= 10000, "Reward rate too high"); // 最高 100%
        _rewardRate = rate;
        emit RewardRateUpdated(rate);
    }
    
    /// @notice 获取奖励率
    /// @return 奖励率
    function getRewardRate() external view override returns (uint256) {
        return _rewardRate;
    }
    
    /// @notice 处理借贷事件
    /// @param user 用户地址
    /// @param debtChange 债务变化量（+借款，-还款）
    /// @param collateralChange 抵押变化量（+存入，-提取）
    function onLoanEvent(address user, int256 debtChange, int256 collateralChange) external override {
        if (!mockSuccess) revert("MockRewardManager: onLoanEvent failed");
        // 模拟奖励计算（简化版本）
        uint256 reward = 0;
        if (debtChange > 0) {
            reward = uint256(debtChange) / 100; // 借款奖励
        }
        if (collateralChange > 0) {
            reward += uint256(collateralChange) / 200; // 存款奖励
        }
        
        if (reward > 0) {
            _userRewards[user] += reward;
            emit RewardEarned(user, reward);
        }
        
        emit LoanEventProcessed(user, debtChange, collateralChange);
    }

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
    
    /// @notice 应用惩罚
    /// @param user 用户地址
    /// @param points 惩罚点数
    function applyPenalty(address user, uint256 points) external override {
        if (_userRewards[user] >= points) {
            _userRewards[user] -= points;
        } else {
            // 如果用户积分不足，清零
            _userRewards[user] = 0;
        }
        emit PenaltyApplied(user, points);
    }
    
    /// @notice 获取用户奖励数量
    /// @param user 用户地址
    /// @return 奖励数量
    function getUserReward(address user) external view returns (uint256) {
        return _userRewards[user];
    }
    
    /// @notice 获取用户等级（0-5）
    /// @param user 用户地址
    /// @return level 用户等级
    function getUserLevel(address user) external view override returns (uint8) {
        // Mock实现：根据奖励数量返回等级
        uint256 reward = _userRewards[user];
        if (reward >= 10000) return 5;
        if (reward >= 5000) return 4;
        if (reward >= 2000) return 3;
        if (reward >= 1000) return 2;
        if (reward >= 100) return 1;
        return 0;
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
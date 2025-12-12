// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRewardManager 奖励管理接口
/// @notice 当借款/还款/抵押变动发生时触发激励逻辑
/// @dev 实现合约可根据业务规则累积积分或分发 Token
interface IRewardManager {
    /**
     * @notice 处理一次借贷事件
     * @param user 操作用户
     * @param debtChange 借款变化量（+ 借款，- 还款）
     * @param collateralChange 抵押变化量（+ 存，- 取）
     */
    function onLoanEvent(address user, int256 debtChange, int256 collateralChange) external;

    /**
     * @notice 处理一次借贷事件（落账后触发的标准入口）
     * @param user 用户地址
     * @param amount 金额（以最小单位，USDT/USDC按 6 位，ETH 按 18 位）
     * @param duration 借款时长（秒），还款时可为 0
     * @param hfHighEnough 健康因子是否达标（用于加成）
     */
    function onLoanEvent(address user, uint256 amount, uint256 duration, bool hfHighEnough) external;

    /**
     * @notice 设置奖励率
     * @param rate 新的奖励率（基点，10000 = 100%）
     */
    function setRewardRate(uint256 rate) external;

    /**
     * @notice 获取当前奖励率
     * @return 当前奖励率（基点）
     */
    function getRewardRate() external view returns (uint256);

    /**
     * @notice 获取用户累积的奖励
     * @param user 用户地址
     * @return 用户的奖励数量
     */
    function getUserReward(address user) external view returns (uint256);

    /**
     * @notice 获取用户等级（0-5）
     * @param user 用户地址
     * @return level 用户等级
     */
    function getUserLevel(address user) external view returns (uint8);

    /**
     * @notice 惩罚用户积分（清算模块调用）
     * @param user 用户地址
     * @param points 扣除积分数量
     */
    function applyPenalty(address user, uint256 points) external;
} 
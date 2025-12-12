// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationRewardManager
 * @dev 清算积分奖励管理器接口 - 负责清算积分奖励的存储、查询和管理
 * @dev Liquidation Reward Manager Interface - Responsible for liquidation reward storage, query and management
 * @dev 从 ILiquidationDebtManager 拆分出的清算积分奖励管理接口
 * @dev Liquidation reward management interface split from ILiquidationDebtManager
 */
interface ILiquidationRewardManager {
    /* ============ Events ============ */
    
    /**
     * 清算奖励发放事件 - 当清算奖励发放时触发
     * Liquidation reward issued event - Triggered when liquidation reward is issued
     * @param liquidator 清算人地址 Liquidator address
     * @param user 被清算用户地址 User address
     * @param reward 奖励金额 Reward amount
     * @param timestamp 时间戳 Timestamp
     */
    event LiquidationRewardIssued(
        address indexed liquidator,
        address indexed user,
        uint256 reward,
        uint256 timestamp
    );

    /**
     * 清算积分处理事件 - 当清算积分处理时触发
     * Liquidation points processed event - Triggered when liquidation points are processed
     * @param liquidator 清算人地址 Liquidator address
     * @param points 积分数量 Points amount
     * @param timestamp 时间戳 Timestamp
     */
    event LiquidationPointsProcessed(
        address indexed liquidator,
        uint256 points,
        uint256 timestamp
    );

    /* ============ Module Management Functions ============ */
    
    /**
     * 获取模块地址 - 从缓存中获取模块地址
     * Get module address - Get module address from cache
     * @param moduleKey 模块键值 Module key
     * @return moduleAddress 模块地址 Module address
     */
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress);

    /**
     * 更新模块 - 更新指定模块的缓存地址
     * Update module - Update cached address for specified module
     * @param key 模块键值 Module key
     * @param addr 模块地址 Module address
     */
    function updateModule(bytes32 key, address addr) external;

    /**
     * 批量更新模块 - 一次性更新多个模块
     * Batch update modules - Update multiple modules at once
     * @param keys 模块键值数组 Array of module keys
     * @param addresses 模块地址数组 Array of module addresses
     */
    function batchUpdateModules(bytes32[] memory keys, address[] memory addresses) external;

    /**
     * 移除模块 - 从缓存中移除指定模块
     * Remove module - Remove specified module from cache
     * @param key 模块键值 Module key
     */
    function removeModule(bytes32 key) external;

    /* ============ Core Reward Management Functions ============ */
    
    /**
     * 发放清算奖励 - 向清算人发放清算奖励
     * Issue liquidation reward - Issue liquidation reward to liquidator
     * @param liquidator 清算人地址 Liquidator address
     * @param user 被清算用户地址 User address
     * @param debtAmount 债务金额 Debt amount
     * @param collateralAmount 抵押物金额 Collateral amount
     */
    function issueLiquidationReward(
        address liquidator,
        address user,
        uint256 debtAmount,
        uint256 collateralAmount
    ) external;

    /**
     * 批量处理清算积分 - 批量处理清算积分
     * Batch process liquidation points - Batch process liquidation points
     * @param liquidators 清算人地址数组 Array of liquidator addresses
     * @param points 积分数组 Array of points
     */
    function batchProcessLiquidationPoints(
        address[] calldata liquidators,
        uint256[] calldata points
    ) external;

    /**
     * 计算清算奖励 - 计算清算奖励金额
     * Calculate liquidation reward - Calculate liquidation reward amount
     * @param debtAmount 债务金额 Debt amount
     * @param collateralAmount 抵押物金额 Collateral amount
     * @return reward 奖励金额 Reward amount
     */
    function calculateLiquidationReward(
        uint256 debtAmount,
        uint256 collateralAmount
    ) external view returns (uint256 reward);

    /**
     * 计算清算惩罚 - 计算清算惩罚金额
     * Calculate liquidation penalty - Calculate liquidation penalty amount
     * @param debtAmount 债务金额 Debt amount
     * @param collateralAmount 抵押物金额 Collateral amount
     * @return penalty 惩罚金额 Penalty amount
     */
    function calculateLiquidationPenalty(
        uint256 debtAmount,
        uint256 collateralAmount
    ) external view returns (uint256 penalty);

    /* ============ Query Functions ============ */
    
    /**
     * 获取清算统计 - 获取清算统计信息
     * Get liquidation stats - Get liquidation statistics
     * @return totalLiquidations 总清算次数 Total liquidations
     * @return totalRewards 总奖励金额 Total rewards
     * @return totalPenalties 总惩罚金额 Total penalties
     */
    function getLiquidationStats() external view returns (
        uint256 totalLiquidations,
        uint256 totalRewards,
        uint256 totalPenalties
    );

    /**
     * 获取清算人统计 - 获取指定清算人的统计信息
     * Get liquidator stats - Get statistics for specified liquidator
     * @param liquidator 清算人地址 Liquidator address
     * @return totalRewards 总奖励金额 Total rewards
     * @return totalLiquidations 总清算次数 Total liquidations
     * @return lastLiquidationTime 最后清算时间 Last liquidation time
     */
    function getLiquidatorStats(
        address liquidator
    ) external view returns (
        uint256 totalRewards,
        uint256 totalLiquidations,
        uint256 lastLiquidationTime
    );

    /**
     * 获取用户清算统计 - 获取指定用户的清算统计信息
     * Get user liquidation stats - Get liquidation statistics for specified user
     * @param user 用户地址 User address
     * @return totalLiquidations 总清算次数 Total liquidations
     * @return totalPenalties 总惩罚金额 Total penalties
     * @return lastLiquidationTime 最后清算时间 Last liquidation time
     */
    function getUserLiquidationStats(
        address user
    ) external view returns (
        uint256 totalLiquidations,
        uint256 totalPenalties,
        uint256 lastLiquidationTime
    );

    /**
     * 获取清算奖励率 - 获取当前清算奖励率
     * Get liquidation reward rate - Get current liquidation reward rate
     * @return rewardRate 奖励率 Reward rate
     */
    function getLiquidationRewardRate() external view returns (uint256 rewardRate);

    /**
     * 获取清算惩罚率 - 获取当前清算惩罚率
     * Get liquidation penalty rate - Get current liquidation penalty rate
     * @return penaltyRate 惩罚率 Penalty rate
     */
    function getLiquidationPenaltyRate() external view returns (uint256 penaltyRate);

    /* ============ Admin Functions ============ */
    
    /**
     * 更新清算奖励率 - 更新清算奖励率
     * Update liquidation reward rate - Update liquidation reward rate
     * @param newRate 新奖励率 New reward rate
     */
    function updateLiquidationRewardRate(uint256 newRate) external;

    /**
     * 更新清算惩罚率 - 更新清算惩罚率
     * Update liquidation penalty rate - Update liquidation penalty rate
     * @param newRate 新惩罚率 New penalty rate
     */
    function updateLiquidationPenaltyRate(uint256 newRate) external;

    /**
     * 更新清算人收益率 - 更新清算人收益率
     * Update liquidator profit rate - Update liquidator profit rate
     * @param newRate 新收益率 New profit rate
     */
    function updateLiquidatorProfitRate(uint256 newRate) external;

    /* ============ Registry Management Functions ============ */
    /// @notice 安排模块升级
    /// @param moduleKey 模块键值
    /// @param newAddress 新模块地址
    function scheduleModuleUpgrade(bytes32 moduleKey, address newAddress) external;

    /// @notice 执行模块升级
    /// @param moduleKey 模块键值
    function executeModuleUpgrade(bytes32 moduleKey) external;

    /// @notice 取消模块升级
    /// @param moduleKey 模块键值
    function cancelModuleUpgrade(bytes32 moduleKey) external;

    /// @notice 获取待升级信息
    /// @param moduleKey 模块键值
    /// @return newAddress 新地址
    /// @return executeAfter 执行时间
    /// @return hasPending 是否有待升级
    function getPendingUpgrade(bytes32 moduleKey) external view returns (address newAddress, uint256 executeAfter, bool hasPending);

} 
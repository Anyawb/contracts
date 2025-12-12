// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SystemUtils
/// @notice 系统状态计算工具库 - 提供系统级计算相关的函数
/// @dev 包含系统健康度、统计信息等计算逻辑
/// @custom:security-contact security@example.com
library SystemUtils {
    
    /// @notice 计算系统健康评分
    /// @param totalUsers 总用户数
    /// @param warningUsers 预警用户数
    /// @param criticalUsers 危险用户数
    /// @param averageHealthFactor 平均健康因子
    /// @return healthScore 系统健康评分 (0-100)
    function calculateSystemHealthScore(
        uint256 totalUsers,
        uint256 warningUsers,
        uint256 criticalUsers,
        uint256 averageHealthFactor
    ) internal pure returns (uint256 healthScore) {
        if (totalUsers == 0) return 100; // 无用户时认为系统健康
        
        // 基础分数：基于平均健康因子
        uint256 baseScore = _calculateBaseHealthScore(averageHealthFactor);
        
        // 风险用户比例扣分
        uint256 riskPenalty = _calculateRiskPenalty(totalUsers, warningUsers, criticalUsers);
        
        // 计算最终分数
        if (baseScore > riskPenalty) {
            healthScore = baseScore - riskPenalty;
        } else {
            healthScore = 0;
        }
    }
    
    /// @notice 计算基础健康分数
    /// @param averageHealthFactor 平均健康因子
    /// @return baseScore 基础健康分数
    function _calculateBaseHealthScore(uint256 averageHealthFactor) internal pure returns (uint256 baseScore) {
        if (averageHealthFactor >= 12000) return 100;      // ≥120%: 100分
        if (averageHealthFactor >= 11000) return 90;       // ≥110%: 90分
        if (averageHealthFactor >= 10500) return 80;       // ≥105%: 80分
        if (averageHealthFactor >= 10000) return 70;       // ≥100%: 70分
        if (averageHealthFactor >= 9500) return 50;        // ≥95%: 50分
        return 30;                                         // <95%: 30分
    }
    
    /// @notice 计算风险用户扣分
    /// @param totalUsers 总用户数
    /// @param warningUsers 预警用户数
    /// @param criticalUsers 危险用户数
    /// @return riskPenalty 风险扣分
    function _calculateRiskPenalty(
        uint256 totalUsers,
        uint256 warningUsers,
        uint256 criticalUsers
    ) internal pure returns (uint256 riskPenalty) {
        uint256 warningPenalty = (warningUsers * 5) / totalUsers;   // 预警用户每个扣5分
        uint256 criticalPenalty = (criticalUsers * 15) / totalUsers; // 危险用户每个扣15分
        
        return warningPenalty + criticalPenalty;
    }
    
    /// @notice 计算利用率
    /// @param used 已使用量
    /// @param total 总量
    /// @return utilization 利用率（单位：bps）
    function calculateUtilization(uint256 used, uint256 total) internal pure returns (uint256 utilization) {
        if (total == 0) return 0;
        return (used * 10000) / total;
    }
    
    /// @notice 计算增长率
    /// @param current 当前值
    /// @param previous 之前值
    /// @return growthRate 增长率（单位：bps）
    function calculateGrowthRate(uint256 current, uint256 previous) internal pure returns (uint256 growthRate) {
        if (previous == 0) return 0;
        if (current < previous) return 0; // 负增长返回0
        
        return ((current - previous) * 10000) / previous;
    }
    
    /// @notice 计算平均值
    /// @param values 数值数组
    /// @return average 平均值
    function calculateAverage(uint256[] memory values) internal pure returns (uint256 average) {
        if (values.length == 0) return 0;
        
        uint256 sum = 0;
        for (uint256 i = 0; i < values.length; i++) {
            sum += values[i];
        }
        
        return sum / values.length;
    }
    
    /// @notice 计算加权平均值
    /// @param values 数值数组
    /// @param weights 权重数组
    /// @return weightedAverage 加权平均值
    function calculateWeightedAverage(
        uint256[] memory values,
        uint256[] memory weights
    ) internal pure returns (uint256 weightedAverage) {
        require(values.length == weights.length, "Arrays length mismatch");
        if (values.length == 0) return 0;
        
        uint256 weightedSum = 0;
        uint256 totalWeight = 0;
        
        for (uint256 i = 0; i < values.length; i++) {
            weightedSum += values[i] * weights[i];
            totalWeight += weights[i];
        }
        
        if (totalWeight == 0) return 0;
        return weightedSum / totalWeight;
    }
    
    /// @notice 检查缓存是否过期
    /// @param cacheTimestamp 缓存时间戳
    /// @param maxAge 最大缓存时间
    /// @return isExpired 是否过期
    function isCacheExpired(uint256 cacheTimestamp, uint256 maxAge) internal view returns (bool isExpired) {
        return block.timestamp - cacheTimestamp > maxAge;
    }
    
    /// @notice 计算缓存剩余时间
    /// @param cacheTimestamp 缓存时间戳
    /// @param maxAge 最大缓存时间
    /// @return remainingTime 剩余时间
    function getCacheRemainingTime(uint256 cacheTimestamp, uint256 maxAge) internal view returns (uint256 remainingTime) {
        if (block.timestamp - cacheTimestamp >= maxAge) {
            return 0;
        }
        return maxAge - (block.timestamp - cacheTimestamp);
    }
} 
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { LiquidationTypes } from "../liquidation/types/LiquidationTypes.sol";

/// @title RiskUtils
/// @notice 风险评估工具库 - 提供风险评估相关的纯函数
/// @dev 所有函数都是 pure，不依赖外部状态
/// @custom:security-contact security@example.com
library RiskUtils {
    
    // ====== 风险评分阈值常量 ======
    /// @notice 获取风险评分阈值数组（健康因子阈值，单位：bps）
    /// @return arr 阈值数组 [120%, 110%, 105%, 100%, 95%]
    /// @dev 阈值按降序排列，用于风险等级判断
    function getRiskScoreThresholds() internal pure returns (uint256[] memory arr) {
        arr = new uint256[](5);
        arr[0] = 12000; // 120% - 极低风险阈值
        arr[1] = 11000; // 110% - 低风险阈值
        arr[2] = 10500; // 105% - 中等风险阈值
        arr[3] = 10000; // 100% - 高风险阈值
        arr[4] = 9500;  // 95%  - 极高风险阈值
    }
    
    /// @notice 获取风险评分值数组（风险评分，范围：0-100）
    /// @return arr 评分数组 [0, 20, 40, 60, 80, 100]
    /// @dev 评分按升序排列，对应不同风险等级
    function getRiskScoreValues() internal pure returns (uint256[] memory arr) {
        arr = new uint256[](6);
        arr[0] = 0;   // 120%+ - 极低风险
        arr[1] = 20;  // 110-120% - 低风险
        arr[2] = 40;  // 105-110% - 中等风险
        arr[3] = 60;  // 100-105% - 高风险
        arr[4] = 80;  // 95-100%  - 极高风险
        arr[5] = 100; // <95%     - 清算风险
    }

    /// @notice 计算简化风险评分
    /// @param healthFactor 健康因子（单位：bps，如 12000 表示 120%）
    /// @return riskScore 风险评分 (0-100，0 表示极低风险，100 表示极高风险)
    /// @dev 基于健康因子阈值计算风险评分，使用预定义的阈值和评分映射
    function calculateSimpleRiskScore(uint256 healthFactor) internal pure returns (uint256 riskScore) {
        uint256[] memory thresholds = getRiskScoreThresholds();
        uint256[] memory values = getRiskScoreValues();
        for (uint256 i = 0; i < thresholds.length; i++) {
            if (healthFactor >= thresholds[i]) {
                return values[i];
            }
        }
        return values[values.length - 1];
    }

    /// @notice 计算安全边际
    /// @param healthFactor 健康因子
    /// @param threshold 阈值
    /// @return safetyMargin 安全边际
    function calculateSafetyMargin(uint256 healthFactor, uint256 threshold) internal pure returns (uint256 safetyMargin) {
        if (healthFactor <= threshold) return 0;
        return healthFactor - threshold;
    }

    /// @notice 计算贷款价值比 (LTV)
    /// @param debt 债务价值
    /// @param collateral 抵押价值
    /// @return ltv 贷款价值比（单位：bps）
    function calculateLTV(uint256 debt, uint256 collateral) internal pure returns (uint256 ltv) {
        if (collateral == 0) return 0;
        return (debt * 10000) / collateral;
    }

    /// @notice 判断是否处于清算风险
    /// @param healthFactor 健康因子
    /// @param liquidationThreshold 清算阈值
    /// @return isRisky 是否处于清算风险
    function isLiquidationRisky(uint256 healthFactor, uint256 liquidationThreshold) internal pure returns (bool isRisky) {
        return healthFactor < liquidationThreshold;
    }

    /// @notice 获取预警级别
    /// @param healthFactor 健康因子
    /// @param warningThreshold 预警阈值
    /// @param liquidationThreshold 清算阈值
    /// @return warningLevel 预警级别 (0: 无预警, 1: 一般预警, 2: 紧急预警)
    function getWarningLevel(
        uint256 healthFactor, 
        uint256 warningThreshold, 
        uint256 liquidationThreshold
    ) internal pure returns (uint8 warningLevel) {
        if (healthFactor >= warningThreshold) {
            return 0; // NONE
        } else if (healthFactor >= liquidationThreshold) {
            return 1; // WARNING
        } else {
            return 2; // CRITICAL
        }
    }

    /// @notice 计算最大可借额度（简化版本）
    /// @param collateral 抵押价值
    /// @param currentDebt 当前债务
    /// @param maxLTV 最大贷款价值比（单位：bps）
    /// @return maxBorrowable 最大可借额度
    function calculateMaxBorrowable(
        uint256 collateral, 
        uint256 currentDebt, 
        uint256 maxLTV
    ) internal pure returns (uint256 maxBorrowable) {
        if (collateral == 0) return 0;
        
        uint256 maxDebt = (collateral * maxLTV) / 10000;
        if (currentDebt >= maxDebt) return 0;
        
        return maxDebt - currentDebt;
    }
} 
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RewardFormulaExample
/// @notice 示例：历史/拟议的“公式计分”计算（不属于当前主路径）
/// @dev
/// - 当前链上基线以 RewardManagerCore 的“borrow 锁定 / repay(按期足额) 释放”逻辑为准；
/// - 本库仅用于：文档/测试/未来升级设计讨论时的参考，避免将公式代码混入主路径合约导致误读与审计气味点。
library RewardFormulaExample {
    /// @notice 示例公式：根据金额与期限计算基础奖励 + bonus + 动态奖励
    /// @dev 该示例不读取任何链上状态；所有参数由调用方显式传入，便于审计与演进。
    /// @param amount 借款金额（最小单位；例如 USDC 6 位）
    /// @param duration 借款期限（区块数）
    /// @param levelMultiplierBps 用户等级倍数（BPS，10000=1x）
    /// @param bonusBps bonus 倍数（BPS，0-10000）
    /// @param dynamicThresholdEasy 动态奖励阈值（EasyToken 单位）
    /// @param dynamicMultiplierBps 动态奖励倍数（BPS）
    /// @param isOnTimeAndFullyRepaid 是否按期且足额还清（示例 gate）
    function calculateExample(
        uint256 amount,
        uint256 duration,
        uint256 levelMultiplierBps,
        uint256 bonusBps,
        uint256 dynamicThresholdEasy,
        uint256 dynamicMultiplierBps,
        bool isOnTimeAndFullyRepaid
    ) internal pure returns (uint256 baseEasy, uint256 bonusEasy, uint256 totalEasy) {
        // 示例基准：把 amount/duration 映射为一个线性 baseEasy（注意：仅示例，实际口径以产品/治理决策为准）
        if (amount == 0 || duration == 0) return (0, 0, 0);

        // Very simple example: scale by duration, then apply level multiplier.
        baseEasy = (amount * duration) / 1e6; // assume 6 decimals asset; example only
        if (levelMultiplierBps > 0) {
            baseEasy = (baseEasy * levelMultiplierBps) / 10000;
        }

        // Bonus example: only when "on time & full" gate is true.
        if (isOnTimeAndFullyRepaid && bonusBps > 0) {
            bonusEasy = (baseEasy * bonusBps) / 10000;
        }

        totalEasy = baseEasy + bonusEasy;

        // Dynamic bonus example.
        if (dynamicThresholdEasy > 0 && totalEasy >= dynamicThresholdEasy && dynamicMultiplierBps > 0) {
            uint256 dynamicBonus = (totalEasy * dynamicMultiplierBps) / 10000;
            totalEasy += dynamicBonus;
        }
    }
}

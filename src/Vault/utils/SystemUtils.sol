// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ArrayLengthMismatch } from "../../errors/StandardErrors.sol";

/**
 * @title SystemUtils
 * @notice Stateless system-level helpers for scores, rates, and cache timing.
 * @dev Security:
 * - Library functions are pure/view only; no external calls.
 * - Solidity ^0.8.x overflow/underflow checks apply (operations revert on overflow).
 *
 * @custom:security-contact security@example.com
 */
library SystemUtils {
    uint256 internal constant _BPS_DENOMINATOR = 10_000;
    
    /**
     * @notice Compute a system health score in [0..100].
     * @dev Reverts if:
     *      - arithmetic overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure aggregation only; does not read external state.
     *
     * @param totalUsers Total number of users (count).
     * @param warningUsers Number of users in warning state (count).
     * @param criticalUsers Number of users in critical state (count).
     * @param averageHealthFactorBps Average health factor in bps (10_000 = 100%).
     * @return healthScore System score in [0..100] (higher is healthier).
     */
    function calculateSystemHealthScore(
        uint256 totalUsers,
        uint256 warningUsers,
        uint256 criticalUsers,
        uint256 averageHealthFactorBps
    ) internal pure returns (uint256 healthScore) {
        if (totalUsers == 0) return 100; // No users => treat as healthy.
        
        // 基础分数：基于平均健康因子
        uint256 baseScore = _calculateBaseHealthScore(averageHealthFactorBps);
        
        // 风险用户比例扣分
        uint256 riskPenalty = _calculateRiskPenalty(totalUsers, warningUsers, criticalUsers);
        
        // 计算最终分数
        if (baseScore > riskPenalty) {
            healthScore = baseScore - riskPenalty;
        } else {
            healthScore = 0;
        }
    }
    
    /**
     * @notice Compute a base score from average health factor.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Pure mapping only.
     *
     * @param averageHealthFactorBps Average health factor in bps.
     * @return baseScore Base score in [0..100].
     */
    function _calculateBaseHealthScore(uint256 averageHealthFactorBps) internal pure returns (uint256 baseScore) {
        if (averageHealthFactorBps >= 12000) return 100; // >=120% => 100
        if (averageHealthFactorBps >= 11000) return 90;  // >=110% => 90
        if (averageHealthFactorBps >= 10500) return 80;  // >=105% => 80
        if (averageHealthFactorBps >= 10000) return 70;  // >=100% => 70
        if (averageHealthFactorBps >= 9500) return 50;   // >=95%  => 50
        return 30; // <95% => 30
    }
    
    /**
     * @notice Compute the penalty based on risky user ratios.
     * @dev Reverts if:
     *      - totalUsers == 0 would divide by zero (caller prevents this)
     *      - arithmetic overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param totalUsers Total number of users (must be non-zero).
     * @param warningUsers Number of users in warning state.
     * @param criticalUsers Number of users in critical state.
     * @return riskPenalty Penalty points to subtract from base score.
     */
    function _calculateRiskPenalty(
        uint256 totalUsers,
        uint256 warningUsers,
        uint256 criticalUsers
    ) internal pure returns (uint256 riskPenalty) {
        uint256 warningPenalty = (warningUsers * 5) / totalUsers; // Warning users: -5 each (ratio-based)
        uint256 criticalPenalty = (criticalUsers * 15) / totalUsers; // Critical users: -15 each (ratio-based)
        
        return warningPenalty + criticalPenalty;
    }
    
    /**
     * @notice Compute utilization as bps (used / total).
     * @dev Reverts if:
     *      - used * 10_000 overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param used Used amount (any unit).
     * @param total Total amount (same unit as used).
     * @return utilizationBps Utilization in bps; returns 0 if total == 0.
     */
    function calculateUtilization(uint256 used, uint256 total) internal pure returns (uint256 utilizationBps) {
        if (total == 0) return 0;
        return (used * _BPS_DENOMINATOR) / total;
    }
    
    /**
     * @notice Compute growth rate as bps ((current - previous) / previous).
     * @dev Reverts if:
     *      - subtraction underflows (Solidity ^0.8.x), though guarded by the comparison
     *      - multiplication overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param current Current value (any unit).
     * @param previous Previous value (same unit as current).
     * @return growthRateBps Growth rate in bps; returns 0 if previous == 0 or current < previous.
     */
    function calculateGrowthRate(uint256 current, uint256 previous) internal pure returns (uint256 growthRateBps) {
        if (previous == 0) return 0;
        if (current < previous) return 0; // Negative growth => 0 (clamped)
        
        return ((current - previous) * _BPS_DENOMINATOR) / previous;
    }
    
    /**
     * @notice Compute the arithmetic mean of an array.
     * @dev Reverts if:
     *      - sum overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure aggregation only.
     *
     * @param values Array of values.
     * @return average Floor(sum(values) / values.length); returns 0 if empty.
     */
    function calculateAverage(uint256[] memory values) internal pure returns (uint256 average) {
        if (values.length == 0) return 0;
        
        uint256 sum = 0;
        for (uint256 i = 0; i < values.length; i++) {
            sum += values[i];
        }
        
        return sum / values.length;
    }
    
    /**
     * @notice Compute a weighted average of values with corresponding weights.
     * @dev Reverts if:
     *      - values.length != weights.length (ArrayLengthMismatch)
     *      - arithmetic overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure aggregation only.
     *
     * @param values Array of values.
     * @param weights Array of weights (same length as values).
     * @return weightedAverage Floor(sum(values[i] * weights[i]) / sum(weights));
     *         returns 0 if values empty or totalWeight == 0.
     */
    function calculateWeightedAverage(
        uint256[] memory values,
        uint256[] memory weights
    ) internal pure returns (uint256 weightedAverage) {
        if (values.length != weights.length) revert ArrayLengthMismatch(values.length, weights.length);
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
    
    /**
     * @notice Return whether a cache entry is expired (block-based).
     * @dev Reverts if:
     *      - cacheBlock > block.number would underflow (Solidity ^0.8.x)
     *
     * Security:
     * - Reads block number; do not use for critical security decisions.
     *
     * @param cacheBlock Cache update block (block.number).
     * @param maxAgeBlocks Maximum allowed age (blocks).
     * @return isExpired True if (block.number - cacheBlock) > maxAgeBlocks.
     */
    function isCacheExpiredBlocks(uint256 cacheBlock, uint256 maxAgeBlocks) internal view returns (bool isExpired) {
        if (cacheBlock == 0 || cacheBlock > block.number) return true;
        return (block.number - cacheBlock) > maxAgeBlocks;
    }

    /**
     * @notice Get the remaining cache age before expiration (block-based).
     * @dev Reverts if:
     *      - cacheBlock > block.number would underflow (Solidity ^0.8.x)
     *
     * Security:
     * - Reads block number; do not use for critical security decisions.
     *
     * @param cacheBlock Cache update block (block.number).
     * @param maxAgeBlocks Maximum allowed age (blocks).
     * @return remainingBlocks Remaining blocks; returns 0 if already expired.
     */
    function getCacheRemainingBlocks(uint256 cacheBlock, uint256 maxAgeBlocks)
        internal
        view
        returns (uint256 remainingBlocks)
    {
        if (cacheBlock == 0 || cacheBlock > block.number) {
            return 0;
        }
        if (block.number - cacheBlock >= maxAgeBlocks) {
            return 0;
        }
        return maxAgeBlocks - (block.number - cacheBlock);
    }
} 
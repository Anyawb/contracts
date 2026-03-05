// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RewardFormulaLib
/// @notice Example-only earn formula library (NOT used by current main path).
/// @dev
/// - This library is intentionally isolated to avoid mixing "formula" code into the baseline earn SSOT.
/// - If/when the protocol decides to adopt formula-based earning, RewardManagerCore can call this library
///   from its write-path and mirror the results into RewardView (push + DataPushed).
library RewardFormulaLib {
    /// @notice Compute example EasyToken amount for a borrow event.
    /// @dev Pure math helper; callers must ensure units/decimals are consistent.
    /// @param amount Asset amount in base units (e.g., USDC 6 decimals)
    /// @param durationBlocks Term length in blocks (block-based; no seconds)
    /// @param levelMultiplierBps Level multiplier in BPS (10000=1x)
    /// @param dynamicThresholdEasy Dynamic threshold in EasyToken units (0 disables)
    /// @param dynamicMultiplierBps Dynamic multiplier in BPS (0 disables)
    function calculateBorrowEasyTokenExample(
        uint256 amount,
        uint256 durationBlocks,
        uint256 levelMultiplierBps,
        uint256 dynamicThresholdEasy,
        uint256 dynamicMultiplierBps
    ) internal pure returns (uint256 easyTokenAmount) {
        if (amount == 0 || durationBlocks == 0) return 0;

        // Example-only baseline: linear scale by duration; assume 6-decimals assets.
        easyTokenAmount = (amount * durationBlocks) / 1e6;

        if (levelMultiplierBps != 0) {
            easyTokenAmount = (easyTokenAmount * levelMultiplierBps) / 10_000;
        }

        if (
            dynamicMultiplierBps != 0 && dynamicThresholdEasy != 0 && easyTokenAmount >= dynamicThresholdEasy
        ) {
            easyTokenAmount += (easyTokenAmount * dynamicMultiplierBps) / 10_000;
        }
    }
}

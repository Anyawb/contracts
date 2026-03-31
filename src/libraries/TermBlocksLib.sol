// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TermBlocksLib
/// @notice SSOT mapping for term "day buckets" -> explicit block durations.
/// @dev This library exists to avoid any onchain seconds/days arithmetic or implicit blocks-per-day conversions.
///      The input `termDays` is treated as a *term bucket identifier* (legacy naming kept for ABI compatibility).
library TermBlocksLib {
    /// @notice Thrown when `termDays` is not a supported term bucket.
    error TermBlocksLib__UnsupportedTermDays(uint16 termDays);

    /// @notice Map a legacy `termDays` bucket to an explicit block duration.
    /// @dev The returned value MUST match LendingEngine's allowed duration whitelist.
    function termDaysToBlocks(uint16 termDays) internal pure returns (uint256) {
        // Explicit mapping (block-based SSOT). Governance may enforce/adjust allowed buckets at higher layers.
        if (termDays == 5) return 36_000;
        if (termDays == 10) return 72_000;
        if (termDays == 15) return 108_000;
        if (termDays == 30) return 216_000;
        if (termDays == 60) return 432_000;
        if (termDays == 90) return 648_000;
        if (termDays == 180) return 1_296_000;
        if (termDays == 360) return 2_592_000;
        revert TermBlocksLib__UnsupportedTermDays(termDays);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ViewConstants
/// @notice Shared constants for all View-layer modules
library ViewConstants {
    /// @dev Cache TTL for view-layer data (5 minutes)
    uint256 internal constant CACHE_DURATION = 5 minutes;

    /// @dev Cache TTL for view-layer data, expressed in blocks (Time-Dependency-Refactor SSOT).
    /// NOTE: this is a governance-tunable parameter in production; the default assumes ~2s blocks:
    /// 5 minutes (300s) ~= 150 blocks.
    uint256 internal constant CACHE_DURATION_BLOCKS = 150;

    /// @dev Maximum items allowed in any batch view call
    uint256 internal constant MAX_BATCH_SIZE = 100;
}

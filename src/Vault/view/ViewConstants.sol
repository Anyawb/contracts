// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ViewConstants
/// @notice Shared constants for all View-layer modules
library ViewConstants {
    /// @dev Cache TTL for view-layer data (5 minutes)
    uint256 internal constant CACHE_DURATION = 5 minutes;

    /// @dev Maximum items allowed in any batch view call
    uint256 internal constant MAX_BATCH_SIZE = 100;
}

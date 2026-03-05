// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ViewConstants
/// @notice Shared constants for all View-layer modules
library ViewConstants {
    /// @dev Cache TTL for view-layer data, expressed in blocks (Time-Dependency-Refactor SSOT).
    /// NOTE: keep chain-agnostic onchain: do NOT use seconds/minutes/days units.
    /// Offchain consumers may estimate wall-clock ETA using avg block time.
    uint256 internal constant CACHE_DURATION_BLOCKS = 150;

    /// @dev Maximum items allowed in any batch view call
    uint256 internal constant MAX_BATCH_SIZE = 100;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MathConstants
/// @notice Shared math constants for the protocol.
/// @dev Keeps common constants (e.g. basis points) out of event/type libraries.
library MathConstants {
    /// @notice 100% expressed in basis points (bps).
    uint256 internal constant BPS = 10_000;
}


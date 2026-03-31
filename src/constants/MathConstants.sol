// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MathConstants
/// @notice Define shared math constants reused across protocol modules.
/// @dev Reverts if:
///      - (none)
///
/// Security:
/// - Constants centralize shared numeric semantics so fee, ratio,
///   and accounting code do not diverge on scale assumptions.
library MathConstants {
    /// @notice Represent 100% in basis points.
    /// @dev Scale denominator for bps-based arithmetic where 1 bps = 0.01%.
    uint256 internal constant BPS = 10_000;
}

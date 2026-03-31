// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FeeTypes
 * @notice Define the canonical fee-type identifiers consumed by FeeRouter routing and statistics.
 * @dev Reverts if:
 *      - (none)
 *
 * Security:
 * - Values are deterministic keccak256 hashes and form part of the fee-routing SSOT.
 * - Existing identifiers must remain stable after deployment to preserve
 *   accounting, analytics, and event-decoding compatibility.
 */
library FeeTypes {
    /// @notice Fee type for early-repayment guarantee platform-fee routing.
    /// @dev Used by fee accounting and analytics paths that classify guarantee-related platform fees.
    bytes32 public constant FEE_TYPE_EARLY_REPAYMENT_PLATFORM =
        keccak256("EARLY_REPAYMENT_PLATFORM_FEE");

    /// @notice Fee type for liquidation platform-share routing.
    /// @dev Used by fee accounting and analytics paths that classify liquidation platform proceeds.
    bytes32 public constant FEE_TYPE_LIQUIDATION_PLATFORM =
        keccak256("LIQUIDATION_PLATFORM_SHARE");
}

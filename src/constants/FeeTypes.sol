// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FeeTypes
 * @notice Fee-type identifiers for FeeRouter statistics and routing.
 * @dev Values are stable keccak256 hashes; do not change once deployed.
 */
library FeeTypes {
    /// @notice Fee type for early repayment guarantee platform fee routing.
    bytes32 public constant FEE_TYPE_EARLY_REPAYMENT_PLATFORM =
        keccak256("EARLY_REPAYMENT_PLATFORM_FEE");

    /// @notice Fee type for liquidation platform share routing.
    bytes32 public constant FEE_TYPE_LIQUIDATION_PLATFORM =
        keccak256("LIQUIDATION_PLATFORM_SHARE");
}
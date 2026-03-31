// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RewardTypes
 * @notice Shared enums and structs for the Reward subsystem.
 * @dev Types-only abstract contract.
 *      It is intended to be inherited or referenced by Reward modules and MUST NOT be deployed standalone.
 *      The {ServiceLevel} enum order is part of the external ABI surface.
 *      Scripts and frontends rely on it, so it MUST NOT be reordered or extended in place.
 */
abstract contract RewardTypes {
    /*━━━━━━━━━━━━━━━ ENUMS ━━━━━━━━━━━━━━━*/

    /// @notice Service levels used by Reward-gated features and governance thresholds.
    /// @dev Enum ordinals are ABI-significant: Basic=0, Standard=1, Premium=2, VIP=3.
    enum ServiceLevel {
        Basic,
        Standard,
        Premium,
        VIP
    }
}

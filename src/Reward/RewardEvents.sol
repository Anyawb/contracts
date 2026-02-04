// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RewardEvents
/// @notice Reward-domain events shared across Reward modules.
/// @dev Keeps Reward-specific events out of the Vault/global event hub.
library RewardEvents {
    /// @notice Emitted when reward points are earned/minted for a user.
    /// @param user User address
    /// @param points Points minted (token decimals)
    /// @param reason Human-readable reason (short string)
    /// @param blockNumber Emission block number (block.number)
    event RewardEarned(address indexed user, uint256 points, string reason, uint256 blockNumber);

    /// @notice Emitted for lightweight performance/metric tracking in Reward flows.
    /// @param operation Operation name
    /// @param value Metric value (context-dependent)
    /// @param blockNumber Emission block number (block.number)
    event PerformanceMonitor(string operation, uint256 value, uint256 blockNumber);

    /// @notice Emitted when upgrade multiplier is updated.
    /// @param oldMultiplier Previous multiplier (bps)
    /// @param newMultiplier New multiplier (bps)
    /// @param blockNumber Emission block number (block.number)
    event UpgradeMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 blockNumber);
}


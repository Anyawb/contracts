// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockDegradationMonitor
/// @notice Mock degradation monitor used in tests.
contract MockDegradationMonitor {
    // Events.
    event DegradationEventRecorded(
        string reason,
        uint256 fallbackValue,
        bool usedFallback
    );

    /// @notice Records a degradation event originating from PriceOracle.
    function recordDegradationEventFromPriceOracle(
        string calldata reason,
        uint256 fallbackValue,
        bool usedFallback
    ) external {
        emit DegradationEventRecorded(reason, fallbackValue, usedFallback);
    }

    /// @notice Records a degradation event through the admin-facing entrypoint.
    function recordDegradationEvent(
        address,
        string calldata reason,
        uint256 fallbackValue,
        bool usedFallback
    ) external {
        emit DegradationEventRecorded(reason, fallbackValue, usedFallback);
    }
}

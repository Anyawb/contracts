// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockGracefulDegradationMonitor
/// @notice Mock graceful-degradation monitor used in tests.
contract MockGracefulDegradationMonitor {
    // Events.
    event DegradationEventRecorded(
        address indexed module,
        string reason,
        uint256 fallbackValue,
        bool usedFallback,
        uint256 blockNumber
    );

    event GracefulDegradationStatsUpdated(
        uint256 totalDegradations,
        uint256 lastDegradationTime,
        address lastDegradedModule,
        string lastDegradationReason
    );

    // Aggregate statistics.
    uint256 public totalDegradations;
    // block number of last degradation (kept name for compatibility)
    uint256 public lastDegradationTime;
    address public lastDegradedModule;
    string public lastDegradationReason;
    uint256 public fallbackValueUsed;
    uint256 public totalFallbackValue;
    uint256 public averageFallbackValue;

    /// @notice Records a degradation event using block-number time semantics.
    /// @param module Degraded module address.
    /// @param reason Degradation reason.
    /// @param fallbackValue Fallback value used.
    /// @param usedFallback True when fallback logic was used.
    function recordDegradationEvent(
        address module,
        string memory reason,
        uint256 fallbackValue,
        bool usedFallback
    ) external {
        totalDegradations++;
        lastDegradationTime = block.number;
        lastDegradedModule = module;
        lastDegradationReason = reason;

        if (usedFallback) {
            fallbackValueUsed = fallbackValue;
            totalFallbackValue += fallbackValue;
            averageFallbackValue = totalFallbackValue / totalDegradations;
        }

        emit DegradationEventRecorded(
            module,
            reason,
            fallbackValue,
            usedFallback,
            block.number
        );
        emit GracefulDegradationStatsUpdated(
            totalDegradations,
            lastDegradationTime,
            lastDegradedModule,
            lastDegradationReason
        );
    }

    /// @notice Overrides graceful-degradation statistics for tests.
    /// @param _totalDegradations Total degradation count.
    /// @param _lastDegradationTime Last degradation block number.
    /// @param _lastDegradedModule Last degraded module.
    /// @param _lastDegradationReason Last degradation reason.
    /// @param _fallbackValueUsed Fallback value used.
    /// @param _totalFallbackValue Total fallback value.
    /// @param _averageFallbackValue Average fallback value.
    function setGracefulDegradationStats(
        uint256 _totalDegradations,
        uint256 _lastDegradationTime,
        address _lastDegradedModule,
        string calldata _lastDegradationReason,
        uint256 _fallbackValueUsed,
        uint256 _totalFallbackValue,
        uint256 _averageFallbackValue
    ) external {
        totalDegradations = _totalDegradations;
        lastDegradationTime = _lastDegradationTime;
        lastDegradedModule = _lastDegradedModule;
        lastDegradationReason = _lastDegradationReason;
        fallbackValueUsed = _fallbackValueUsed;
        totalFallbackValue = _totalFallbackValue;
        averageFallbackValue = _averageFallbackValue;
    }

    /// @notice Returns graceful-degradation statistics.
    /// @return _totalDegradations Total degradation count.
    /// @return _lastDegradationTime Last degradation block number.
    /// @return _lastDegradedModule Last degraded module.
    /// @return _lastDegradationReason Last degradation reason.
    /// @return _fallbackValueUsed Fallback value used.
    /// @return _totalFallbackValue Total fallback value.
    /// @return _averageFallbackValue Average fallback value.
    function getGracefulDegradationStats()
        external
        view
        returns (
            uint256 _totalDegradations,
            uint256 _lastDegradationTime,
            address _lastDegradedModule,
            string memory _lastDegradationReason,
            uint256 _fallbackValueUsed,
            uint256 _totalFallbackValue,
            uint256 _averageFallbackValue
        )
    {
        return (
            totalDegradations,
            lastDegradationTime,
            lastDegradedModule,
            lastDegradationReason,
            fallbackValueUsed,
            totalFallbackValue,
            averageFallbackValue
        );
    }
}

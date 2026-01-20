// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ModuleHealthView } from "../Vault/view/modules/ModuleHealthView.sol";
import { DegradationCore as GracefulDegradationCore } from "../monitor/DegradationCore.sol";
import { DegradationStorage } from "../monitor/DegradationStorage.sol";

/// @title MockHealthDegradationMonitor
/// @notice Lightweight mock that implements the subset of APIs used by HealthView for graceful degradation data.
contract MockHealthDegradationMonitor {
    GracefulDegradationCore.DegradationStats private _stats;
    mapping(address => ModuleHealthView.ModuleHealthStatus) private _moduleStatuses;
    DegradationStorage.DegradationEvent[] private _history;

    bool private _checkHealthy;
    string private _checkDetails;

    uint256 private _totalEvents;
    uint256 private _recentEvents;
    address private _mostFrequentModule;
    uint256 private _averageFallbackValue;

    function setStats(
        uint256 totalDegradations,
        uint256 lastDegradationTime,
        address lastDegradedModule,
        bytes32 lastDegradationReasonHash,
        uint256 fallbackValueUsed,
        uint256 totalFallbackValue,
        uint256 averageFallbackValue
    ) external {
        _stats = GracefulDegradationCore.DegradationStats({
            totalDegradations: totalDegradations,
            lastDegradationTime: lastDegradationTime,
            lastDegradedModule: lastDegradedModule,
            lastDegradationReasonHash: lastDegradationReasonHash,
            fallbackValueUsed: fallbackValueUsed,
            totalFallbackValue: totalFallbackValue,
            averageFallbackValue: averageFallbackValue
        });
    }

    function setModuleHealthStatus(
        address module,
        bool isHealthy,
        bytes32 detailsHash,
        uint256 lastCheckTime,
        uint256 consecutiveFailures,
        uint256 totalChecks,
        uint256 successRate
    ) external {
        _moduleStatuses[module] = ModuleHealthView.ModuleHealthStatus({
            module: module,
            isHealthy: isHealthy,
            detailsHash: detailsHash,
            lastCheckTime: lastCheckTime,
            consecutiveFailures: consecutiveFailures,
            totalChecks: totalChecks,
            successRate: successRate
        });
    }

    function pushHistoryEvent(
        address module,
        bytes32 reasonHash,
        uint256 fallbackValue,
        bool usedFallback,
        uint256 timestamp,
        uint256 blockNumber
    ) external {
        _history.push(
            DegradationStorage.DegradationEvent({
                module: module,
                reasonHash: reasonHash,
                fallbackValue: fallbackValue,
                usedFallback: usedFallback,
                timestamp: timestamp,
                blockNumber: blockNumber
            })
        );
    }

    function clearHistory() external {
        delete _history;
    }

    function setCheckResult(bool isHealthy, string calldata details) external {
        _checkHealthy = isHealthy;
        _checkDetails = details;
    }

    function setTrends(
        uint256 totalEvents,
        uint256 recentEvents,
        address mostFrequentModule,
        uint256 averageFallbackValue
    ) external {
        _totalEvents = totalEvents;
        _recentEvents = recentEvents;
        _mostFrequentModule = mostFrequentModule;
        _averageFallbackValue = averageFallbackValue;
    }

    // -------- HealthView-consumed APIs --------

    function getGracefulDegradationStats() external view returns (GracefulDegradationCore.DegradationStats memory) {
        return _stats;
    }

    function getModuleHealthStatus(address module) external view returns (ModuleHealthView.ModuleHealthStatus memory) {
        return _moduleStatuses[module];
    }

    function getSystemDegradationHistory(uint256 limit) external view returns (DegradationStorage.DegradationEvent[] memory history) {
        uint256 available = _history.length;
        if (limit > available) {
            limit = available;
        }
        history = new DegradationStorage.DegradationEvent[](limit);
        for (uint256 i; i < limit; ++i) {
            history[i] = _history[available - 1 - i];
        }
    }

    function checkModuleHealth(address /*module*/) external view returns (bool, string memory) {
        return (_checkHealthy, _checkDetails);
    }

    function getSystemDegradationTrends() external view returns (
        uint256 totalEvents,
        uint256 recentEvents,
        address mostFrequentModule,
        uint256 averageFallbackValue
    ) {
        return (_totalEvents, _recentEvents, _mostFrequentModule, _averageFallbackValue);
    }
}


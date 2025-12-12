// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockDegradationMonitor
/// @notice 供测试使用的DegradationMonitor模拟合约
contract MockDegradationMonitor {
    // 事件
    event DegradationEventRecorded(string reason, uint256 fallbackValue, bool usedFallback);
    
    /// @notice 记录来自PriceOracle的降级事件
    function recordDegradationEventFromPriceOracle(
        string memory reason,
        uint256 fallbackValue,
        bool usedFallback
    ) external {
        emit DegradationEventRecorded(reason, fallbackValue, usedFallback);
    }
    
    /// @notice 记录降级事件（管理员接口）
    function recordDegradationEvent(
        address,
        string memory reason,
        uint256 fallbackValue,
        bool usedFallback
    ) external {
        emit DegradationEventRecorded(reason, fallbackValue, usedFallback);
    }
}

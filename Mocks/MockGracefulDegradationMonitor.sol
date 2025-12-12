// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockGracefulDegradationMonitor
/// @notice 供测试使用的优雅降级监控模拟合约
contract MockGracefulDegradationMonitor {
    // 事件
    event DegradationEventRecorded(
        address indexed module,
        string reason,
        uint256 fallbackValue,
        bool usedFallback,
        uint256 timestamp
    );
    
    event GracefulDegradationStatsUpdated(
        uint256 totalDegradations,
        uint256 lastDegradationTime,
        address lastDegradedModule,
        string lastDegradationReason
    );
    
    // 统计数据
    uint256 public totalDegradations;
    uint256 public lastDegradationTime;
    address public lastDegradedModule;
    string public lastDegradationReason;
    uint256 public fallbackValueUsed;
    uint256 public totalFallbackValue;
    uint256 public averageFallbackValue;
    
    /// @notice 记录降级事件
    /// @param module 降级的模块地址
    /// @param reason 降级原因
    /// @param fallbackValue 使用的降级值
    /// @param usedFallback 是否使用了降级
    function recordDegradationEvent(
        address module,
        string memory reason,
        uint256 fallbackValue,
        bool usedFallback
    ) external {
        totalDegradations++;
        lastDegradationTime = block.timestamp;
        lastDegradedModule = module;
        lastDegradationReason = reason;
        
        if (usedFallback) {
            fallbackValueUsed = fallbackValue;
            totalFallbackValue += fallbackValue;
            averageFallbackValue = totalFallbackValue / totalDegradations;
        }
        
        emit DegradationEventRecorded(module, reason, fallbackValue, usedFallback, block.timestamp);
        emit GracefulDegradationStatsUpdated(
            totalDegradations,
            lastDegradationTime,
            lastDegradedModule,
            lastDegradationReason
        );
    }
    
    /// @notice 设置统计数据（用于测试）
    /// @param _totalDegradations 总降级次数
    /// @param _lastDegradationTime 最后降级时间
    /// @param _lastDegradedModule 最后降级的模块
    /// @param _lastDegradationReason 最后降级原因
    /// @param _fallbackValueUsed 使用的降级值
    /// @param _totalFallbackValue 总降级值
    /// @param _averageFallbackValue 平均降级值
    function setGracefulDegradationStats(
        uint256 _totalDegradations,
        uint256 _lastDegradationTime,
        address _lastDegradedModule,
        string memory _lastDegradationReason,
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
    
    /// @notice 获取优雅降级统计信息
    /// @return _totalDegradations 总降级次数
    /// @return _lastDegradationTime 最后降级时间
    /// @return _lastDegradedModule 最后降级的模块
    /// @return _lastDegradationReason 最后降级原因
    /// @return _fallbackValueUsed 使用的降级值
    /// @return _totalFallbackValue 总降级值
    /// @return _averageFallbackValue 平均降级值
    function getGracefulDegradationStats() external view returns (
        uint256 _totalDegradations,
        uint256 _lastDegradationTime,
        address _lastDegradedModule,
        string memory _lastDegradationReason,
        uint256 _fallbackValueUsed,
        uint256 _totalFallbackValue,
        uint256 _averageFallbackValue
    ) {
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

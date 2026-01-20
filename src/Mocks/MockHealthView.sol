// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockHealthView
/// @notice 供测试使用的HealthView模拟合约
contract MockHealthView {
    // 用户健康因子映射
    mapping(address => uint256) private _userHealthFactors;
    mapping(address => uint256) private _cacheTimestamps;
    
    // 事件
    event HealthFactorCached(address indexed user, uint256 healthFactor, uint256 timestamp);
    
    /// @notice 推送风险状态（模拟业务模块调用）
    function pushRiskStatus(
        address user,
        uint256 healthFactor,
        uint256 /* _threshold */,
        bool /* _isLiquidatable */,
        uint256 timestamp
    ) external {
        require(user != address(0), "MockHealthView: user is zero");
        _userHealthFactors[user] = healthFactor;
        _cacheTimestamps[user] = timestamp;
        emit HealthFactorCached(user, healthFactor, timestamp);
    }
    
    /// @notice 获取用户健康因子
    function getUserHealthFactor(address user) external view returns (uint256) {
        return _userHealthFactors[user];
    }
    
    /// @notice 获取缓存时间戳
    function getCacheTimestamp(address user) external view returns (uint256) {
        return _cacheTimestamps[user];
    }
}

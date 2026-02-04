// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockHealthView
/// @notice 供测试使用的HealthView模拟合约
contract MockHealthView {
    // 用户健康因子映射
    mapping(address => uint256) private _userHealthFactors;
    mapping(address => uint256) private _cacheBlocks;
    
    // 事件
    event HealthFactorCached(address indexed user, uint256 healthFactor, uint256 cacheBlock);
    
    /// @notice 推送风险状态（模拟业务模块调用）
    function pushRiskStatus(
        address user,
        uint256 healthFactor,
        uint256 /* _threshold */,
        bool /* _isLiquidatable */,
        uint256 cacheBlock
    ) external {
        require(user != address(0), "MockHealthView: user is zero");
        _userHealthFactors[user] = healthFactor;
        _cacheBlocks[user] = cacheBlock;
        emit HealthFactorCached(user, healthFactor, cacheBlock);
    }
    
    /// @notice 获取用户健康因子（带meta）
    function getUserHealthFactorWithMeta(address user)
        external
        view
        returns (uint256 healthFactor, bool isValid, uint256 cacheBlock)
    {
        healthFactor = _userHealthFactors[user];
        cacheBlock = _cacheBlocks[user];
        isValid = cacheBlock != 0;
    }
}

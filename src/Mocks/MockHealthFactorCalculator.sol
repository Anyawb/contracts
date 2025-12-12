// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockHealthFactorCalculator
/// @notice 简化版健康因子计算器 Mock（无接口依赖，仅用于测试）
contract MockHealthFactorCalculator {
    uint256 private _healthFactorBps;

    constructor() {
        _healthFactorBps = 11000; // 默认 110%
    }

    /// @notice 设置健康因子（bps）
    function setHealthFactor(uint256 newHfBps) external {
        _healthFactorBps = newHfBps;
    }

    /// @notice 获取用户健康因子（忽略用户，仅返回全局数值）
    function getHealthFactor(address /* user */) external view returns (uint256) {
        return _healthFactorBps;
    }

    /// @notice 预估健康因子（此处直接返回当前全局数值）
    function previewHealthFactor(uint256 /* collateral */, uint256 /* debt */) external view returns (uint256) {
        return _healthFactorBps;
    }
}



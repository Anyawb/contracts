// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockSimpleContract
/// @notice 简单的 Mock 合约，用于测试中作为模块地址
/// @dev 这个合约只用于满足 Registry 的"模块必须是合约"的要求
contract MockSimpleContract {
    /// @notice 简单的状态变量
    uint256 public value;

    /// @notice 设置值
    function setValue(uint256 _value) external {
        value = _value;
    }

    /// @notice 获取值
    function getValue() external view returns (uint256) {
        return value;
    }
}

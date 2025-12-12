// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IKeeperRegistry
/// @notice Keeper注册表接口定义
/// @dev 提供统一的Keeper权限检查接口
interface IKeeperRegistry {
    /// @notice 检查地址是否为Keeper
    /// @param caller 待检查的地址
    /// @return 是否为Keeper
    function isKeeper(address caller) external view returns (bool);
} 
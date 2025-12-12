// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IWhitelistRegistry
/// @notice 白名单注册表接口定义
/// @dev 提供统一的白名单权限检查接口
interface IWhitelistRegistry {
    /// @notice 检查地址是否在白名单中
    /// @param account 待检查的地址
    /// @return 是否在白名单中
    function isWhitelisted(address account) external view returns (bool);
} 
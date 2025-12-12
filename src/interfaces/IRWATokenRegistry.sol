// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRWATokenRegistry
/// @notice 管理可借出 RWA 资产的白名单
interface IRWATokenRegistry {
    /// @notice 判断指定资产是否被允许
    function isAllowed(address token) external view returns (bool);
} 
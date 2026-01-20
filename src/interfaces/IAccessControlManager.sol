// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAccessControlManager
/// @notice 简化的权限控制管理器接口
/// @dev 提供基础的角色管理与权限验证（业务写权限 SSOT）
/// @custom:security-contact security@example.com
interface IAccessControlManager {
    // =================== 权限级别枚举 ===================
    
    /// @notice 权限级别枚举
    enum PermissionLevel {
        NONE,       // 无权限
        VIEWER,     // 查看权限
        OPERATOR,   // 操作权限
        ADMIN       // 管理员权限
    }
    // =================== 核心权限验证接口 ===================
    
    /// @notice 如果 caller 不具备 role 则 revert
    /// @param role 角色哈希
    /// @param caller 调用者地址
    function requireRole(bytes32 role, address caller) external view;

    /// @notice 查询 caller 是否具备 role
    /// @param role 角色哈希
    /// @param caller 调用者地址
    /// @return 是否具备角色
    function hasRole(bytes32 role, address caller) external view returns (bool);

    // =================== 角色管理接口 ===================
    
    /// @notice 授予账户角色
    /// @param role 角色哈希
    /// @param account 目标账户
    function grantRole(bytes32 role, address account) external;

    /// @notice 撤销账户角色
    /// @param role 角色哈希
    /// @param account 目标账户
    function revokeRole(bytes32 role, address account) external;

    // =================== 查询接口 ===================
    // 注意：角色枚举/分页等“治理运维查询”能力不属于本接口的 SSOT 范畴，避免接口膨胀。

    /// @notice 获取当前owner地址
    /// @return owner地址
    function owner() external view returns (address);
    
    // =================== Permission Helper ===================
    /// @notice 获取账户的综合权限级别
    /// @dev 基于账户拥有的角色动态计算
    /// @param account 账户地址
    /// @return level 权限级别枚举
    function getUserPermission(address account) external view returns (PermissionLevel level);
} 
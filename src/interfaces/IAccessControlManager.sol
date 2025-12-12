// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAccessControlManager
/// @notice 简化的权限控制管理器接口
/// @dev 提供基础的角色管理、权限验证、Keeper管理和紧急暂停功能
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

    // =================== Keeper管理接口 ===================
    
    /// @notice 更新keeper地址
    /// @param newKeeper 新的keeper地址
    function updateKeeper(address newKeeper) external;

    // =================== 紧急暂停接口 ===================
    
    /// @notice 紧急暂停合约
    /// @param reason 暂停原因
    function emergencyPause(string calldata reason) external;

    /// @notice 恢复合约运行
    function emergencyUnpause() external;

    // =================== 查询接口 ===================
    
    /// @notice 获取账户拥有的所有角色
    /// @param account 目标账户
    /// @return 角色数组
    function getAccountRoles(address account) external view returns (bytes32[] memory);
    
    /// @notice 获取角色拥有的所有账户
    /// @param role 目标角色
    /// @return 账户数组
    function getRoleAccounts(bytes32 role) external view returns (address[] memory);
    
    /// @notice 获取角色的账户数量
    /// @param role 目标角色
    /// @return 账户数量
    function getRoleAccountCount(bytes32 role) external view returns (uint256);
    
    /// @notice 获取当前owner地址
    /// @return owner地址
    function owner() external view returns (address);
    
    /// @notice 获取合约暂停状态（兼容旧接口）
    /// @return paused 合约是否已暂停
    function getContractStatus() external view returns (bool paused);
    
    // =================== Permission Helper ===================
    /// @notice 获取账户的综合权限级别
    /// @dev 基于账户拥有的角色动态计算
    /// @param account 账户地址
    /// @return level 权限级别枚举
    function getUserPermission(address account) external view returns (PermissionLevel level);
} 
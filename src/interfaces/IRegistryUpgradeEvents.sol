// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRegistryUpgradeEvents
/// @notice Registry升级相关事件的统一接口定义
/// @dev 所有需要registry升级功能的模块都应该继承这个接口
interface IRegistryUpgradeEvents {
    
    /* ============ Registry Upgrade Events ============ */
    
    /// @notice Registry模块升级计划事件
    /// @param moduleKey 模块键值
    /// @param oldAddress 旧地址
    /// @param newAddress 新地址
    /// @param executeAfter 执行时间
    event RegistryModuleUpgradeScheduled(
        bytes32 indexed moduleKey, 
        address indexed oldAddress, 
        address indexed newAddress, 
        uint256 executeAfter
    );

    /// @notice Registry模块升级执行事件
    /// @param moduleKey 模块键值
    /// @param oldAddress 旧地址
    /// @param newAddress 新地址
    event RegistryModuleUpgradeExecuted(
        bytes32 indexed moduleKey, 
        address indexed oldAddress, 
        address indexed newAddress
    );

    /// @notice Registry模块升级取消事件
    /// @param moduleKey 模块键值
    /// @param oldAddress 旧地址
    /// @param newAddress 新地址
    event RegistryModuleUpgradeCancelled(
        bytes32 indexed moduleKey, 
        address indexed oldAddress, 
        address indexed newAddress
    );

    /// @notice 模块缓存更新事件
    /// @param moduleKey 模块键值
    /// @param oldAddress 旧地址
    /// @param newAddress 新地址
    event ModuleCacheUpdated(
        bytes32 indexed moduleKey, 
        address indexed oldAddress, 
        address indexed newAddress
    );
} 
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockRegistry
/// @notice 仅用于测试环境的轻量级Registry，实现基本的模块地址管理
/// @dev 不包含访问控制，任何人都可设置模块地址，切勿用于生产
contract MockRegistry {
    mapping(bytes32 => address) private _modules;

    event ModuleUpgraded(bytes32 indexed key, address indexed oldAddress, address indexed newAddress);

    /// @notice 设置模块地址
    /// @param key 模块键
    /// @param moduleAddr 模块地址
    function setModule(bytes32 key, address moduleAddr) external {
        address oldAddr = _modules[key];
        _modules[key] = moduleAddr;
        emit ModuleUpgraded(key, oldAddr, moduleAddr);
    }

    /// @notice 读取模块地址
    /// @param key 模块键
    /// @return 模块地址
    function getModule(bytes32 key) external view returns (address) {
        return _modules[key];
    }

    /// @notice 读取模块地址，不存在则 revert
    /// @param key 模块键
    function getModuleOrRevert(bytes32 key) external view returns (address) {
        address moduleAddr = _modules[key];
        require(moduleAddr != address(0), "MockRegistry: module not found");
        return moduleAddr;
    }

    /// @notice 检查模块是否已注册
    /// @param key 模块键
    /// @return 是否已注册
    function isModuleRegistered(bytes32 key) external view returns (bool) {
        return _modules[key] != address(0);
    }
} 
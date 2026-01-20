// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IRegistryDynamicModuleKey } from "../interfaces/IRegistryDynamicModuleKey.sol";
import { IndexOutOfBounds, ZeroAddress } from "../errors/StandardErrors.sol";
import {RegistryEvents} from "../registry/RegistryEventsLibrary.sol";

/// @title MockRegistryDynamicModuleKey
/// @notice Mock 动态模块键注册表，用于测试
/// @dev 仅用于测试环境，不包含完整的权限控制和验证逻辑
contract MockRegistryDynamicModuleKey is IRegistryDynamicModuleKey {
    // NOTE:
    // - `IRegistryDynamicModuleKey` intentionally declares only functions (no events/errors).
    // - Events are emitted via the canonical RegistryEvents library (Architecture-Guide.md unified event library rule).

    // ============ Custom errors (test-only) ============
    error RegistryDynamicModuleKey__ModuleKeyAlreadyExists(bytes32 moduleKey);
    error RegistryDynamicModuleKey__ModuleKeyNotExists(bytes32 moduleKey);
    error RegistryDynamicModuleKey__ModuleNameNotExists(string name);

    bytes32[] private _dynamicKeys;
    mapping(bytes32 => bool) private _keyExists;
    mapping(bytes32 => string) private _keyNames;

    // Minimal admin/pause state to avoid empty-block bodies (solhint no-empty-blocks).
    address private _registrationAdmin;
    address private _systemAdmin;
    bool private _paused;

    /// @notice 注册动态模块键（测试用，无权限控制）
    function registerModuleKey(string calldata name) external returns (bytes32 moduleKey) {
        moduleKey = keccak256(abi.encodePacked("DYNAMIC_", name));
        if (_keyExists[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyAlreadyExists(moduleKey);
        }
        _dynamicKeys.push(moduleKey);
        _keyExists[moduleKey] = true;
        _keyNames[moduleKey] = name;
        bytes32 nameHash = keccak256(abi.encodePacked(name));
        emit RegistryEvents.ModuleKeyRegistered(moduleKey, nameHash, msg.sender);
        return moduleKey;
    }

    /// @notice 批量注册动态模块键
    function batchRegisterModuleKeys(string[] calldata names) external returns (bytes32[] memory moduleKeys) {
        moduleKeys = new bytes32[](names.length);
        for (uint256 i = 0; i < names.length; ) {
            moduleKeys[i] = this.registerModuleKey(names[i]);
            unchecked { ++i; }
        }
    }

    /// @notice 注销动态模块键
    function unregisterModuleKey(bytes32 moduleKey) external {
        if (!_keyExists[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        string memory keyName = _keyNames[moduleKey];
        _keyExists[moduleKey] = false;
        // 简化实现：不移除数组元素，只标记为不存在
        emit RegistryEvents.ModuleKeyUnregistered(moduleKey, keyName, msg.sender);
    }

    /// @notice 检查是否为动态模块键
    function isDynamicModuleKey(bytes32 moduleKey) external view returns (bool) {
        return _keyExists[moduleKey];
    }

    /// @notice 检查模块键是否有效
    function isValidModuleKey(bytes32 /* moduleKey */) external pure returns (bool) {
        // Mock 实现：总是返回 true（实际应该检查静态键和动态键）
        return true;
    }

    /// @notice 根据名称获取模块键
    function getModuleKeyByName(string calldata name) external view returns (bytes32 moduleKey) {
        moduleKey = keccak256(abi.encodePacked("DYNAMIC_", name));
        if (!_keyExists[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleNameNotExists(name);
        }
        return moduleKey;
    }

    /// @notice 根据模块键获取名称
    function getModuleKeyName(bytes32 moduleKey) external view returns (string memory name) {
        if (!_keyExists[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        return _keyNames[moduleKey];
    }

    /// @notice 获取所有动态模块键
    function getDynamicModuleKeys() external view returns (bytes32[] memory keys) {
        // 只返回存在的键
        uint256 count;
        for (uint256 i = 0; i < _dynamicKeys.length; ) {
            if (_keyExists[_dynamicKeys[i]]) count++;
            unchecked { ++i; }
        }
        keys = new bytes32[](count);
        uint256 idx;
        for (uint256 i = 0; i < _dynamicKeys.length; ) {
            if (_keyExists[_dynamicKeys[i]]) {
                keys[idx++] = _dynamicKeys[i];
            }
            unchecked { ++i; }
        }
    }

    /// @notice 获取动态模块键总数
    function getDynamicKeyCount() external view returns (uint256) {
        uint256 count;
        for (uint256 i = 0; i < _dynamicKeys.length; ) {
            if (_keyExists[_dynamicKeys[i]]) count++;
            unchecked { ++i; }
        }
        return count;
    }

    /// @notice 获取动态模块键名称
    function getDynamicModuleKeyName(bytes32 moduleKey) external view returns (string memory name) {
        if (!_keyExists[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        return _keyNames[moduleKey];
    }

    /// @notice 根据名称哈希获取模块键（Mock 简化实现）
    function getNameHashToModuleKey(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    /// @notice 根据索引获取动态模块键
    function getDynamicModuleKeyByIndex(uint256 index) external view returns (bytes32 moduleKey) {
        if (index >= _dynamicKeys.length) revert IndexOutOfBounds(index, _dynamicKeys.length);
        return _dynamicKeys[index];
    }

    /// @notice 获取注册管理员（Mock 仅返回内部状态）
    function getRegistrationAdmin() external view returns (address) {
        return _registrationAdmin;
    }

    /// @notice 获取系统管理员（Mock 仅返回内部状态）
    function getSystemAdmin() external view returns (address) {
        return _systemAdmin;
    }

    /// @notice 设置注册管理员（Mock 空实现）
    function setRegistrationAdmin(address newRegistrationAdmin) external {
        if (newRegistrationAdmin == address(0)) revert ZeroAddress();
        _registrationAdmin = newRegistrationAdmin;
    }

    /// @notice 设置系统管理员（Mock 空实现）
    function setSystemAdmin(address newSystemAdmin) external {
        if (newSystemAdmin == address(0)) revert ZeroAddress();
        _systemAdmin = newSystemAdmin;
    }

    /// @notice 紧急暂停（Mock 空实现）
    function pause() external {
        _paused = true;
    }

    /// @notice 恢复运行（Mock 空实现）
    function unpause() external {
        _paused = false;
    }
}


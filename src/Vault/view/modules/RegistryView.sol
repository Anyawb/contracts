// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { IRegistryDynamicModuleKey } from "../../../interfaces/IRegistryDynamicModuleKey.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/// @title RegistryView
/// @notice 只读注册表视图：承接模块键枚举、注册检查、反查地址、分页等查询
/// @dev 不存业务状态，仅持有 Registry 指针；查询均为 0-gas view
/// @dev 遵循双架构：不缓存模块地址，实时从 Registry 解析；保留 UUPS 升级与 __gap
/// @custom:security-contact security@example.com
contract RegistryView is Initializable, UUPSUpgradeable, ViewVersioned {
    address private _registryAddr;
    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    // ============ Errors ============
    error RegistryView__BatchTooLarge();

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ============ Internal helpers ============
    function _enforceBatchLimit(uint256 len) internal pure {
        if (len > MAX_BATCH_SIZE) revert RegistryView__BatchTooLarge();
    }

    /// @notice 内部函数：获取所有模块键（静态键 + 动态键）
    /// @return 所有模块键数组（静态键在前，动态键在后）
    /// @dev 聚合静态键和动态键，动态键通过 RegistryDynamicModuleKey 获取
    function _getAllModuleKeys() internal view returns (bytes32[] memory) {
        bytes32[] memory staticKeys = ModuleKeys.getAllKeys();
        address dynReg = Registry(_registryAddr).getModule(ModuleKeys.KEY_DYNAMIC_MODULE_REGISTRY);
        
        // 如果没有动态模块键注册表，直接返回静态键
        if (dynReg == address(0)) return staticKeys;
        
        // 尝试获取动态模块键
        try IRegistryDynamicModuleKey(dynReg).getDynamicModuleKeys() returns (bytes32[] memory dynamicKeys) {
            // 合并静态键和动态键
            uint256 staticLen = staticKeys.length;
            uint256 dynamicLen = dynamicKeys.length;
            bytes32[] memory allKeys = new bytes32[](staticLen + dynamicLen);
            
            // 复制静态键
            for (uint256 i = 0; i < staticLen; ) {
                allKeys[i] = staticKeys[i];
                unchecked { ++i; }
            }
            
            // 复制动态键
            for (uint256 i = 0; i < dynamicLen; ) {
                allKeys[staticLen + i] = dynamicKeys[i];
                unchecked { ++i; }
            }
            
            return allKeys;
        } catch {
            // 如果动态键查询失败，只返回静态键
            return staticKeys;
        }
    }

    // ---- Keys ----
    /// @notice 获取所有模块键（静态键 + 动态键）
    /// @return 所有模块键数组（静态键在前，动态键在后）
    /// @dev 聚合静态键和动态键，动态键通过 RegistryDynamicModuleKey 获取
    function getAllModuleKeys() external view onlyValidRegistry returns (bytes32[] memory) {
        return _getAllModuleKeys();
    }

    /// @notice 获取已注册的模块键（包括静态键和动态键）
    /// @return 已注册的模块键数组
    /// @dev 聚合静态键和动态键中已注册的模块
    function getAllRegisteredModuleKeys() external view onlyValidRegistry returns (bytes32[] memory) {
        bytes32[] memory allKeys = _getAllModuleKeys(); // 使用内部函数获取所有键（包括动态键）
        uint256 count;
        for (uint256 i; i < allKeys.length; i++) {
            if (Registry(_registryAddr).getModule(allKeys[i]) != address(0)) count++;
        }
        bytes32[] memory keys = new bytes32[](count);
        uint256 k;
        for (uint256 i; i < allKeys.length; i++) {
            address addr = Registry(_registryAddr).getModule(allKeys[i]);
            if (addr != address(0)) keys[k++] = allKeys[i];
        }
        return keys;
    }

    /// @notice 获取已注册的模块键与地址（包括静态键和动态键）
    /// @return keys 已注册的模块键数组
    /// @return addrs 对应的模块地址数组
    /// @dev 聚合静态键和动态键中已注册的模块
    function getAllRegisteredModules() external view onlyValidRegistry returns (bytes32[] memory keys, address[] memory addrs) {
        bytes32[] memory allKeys = _getAllModuleKeys(); // 使用内部函数获取所有键（包括动态键）
        uint256 count;
        for (uint256 i; i < allKeys.length; i++) if (Registry(_registryAddr).getModule(allKeys[i]) != address(0)) count++;
        keys = new bytes32[](count);
        addrs = new address[](count);
        uint256 k;
        for (uint256 i; i < allKeys.length; i++) {
            address addr = Registry(_registryAddr).getModule(allKeys[i]);
            if (addr != address(0)) { keys[k] = allKeys[i]; addrs[k] = addr; k++; }
        }
    }

    /// @notice 批量检查模块是否存在
    /// @param keys 模块键数组
    function checkModulesExist(bytes32[] memory keys) external view onlyValidRegistry returns (bool[] memory exists) {
        _enforceBatchLimit(keys.length);
        exists = new bool[](keys.length);
        for (uint256 i; i < keys.length; i++) exists[i] = (Registry(_registryAddr).getModule(keys[i]) != address(0));
    }

    function batchModuleExists(bytes32[] memory keys) external view onlyValidRegistry returns (bool[] memory exists) {
        return this.checkModulesExist(keys);
    }

    /// @notice 通过地址反查模块键（可限制扫描数量）
    function findModuleKeyByAddress(address moduleAddr, uint256 maxCount) external view onlyValidRegistry returns (bytes32 key, bool found) {
        if (moduleAddr == address(0)) return (bytes32(0), false);
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        uint256 limit = maxCount == 0 || maxCount > allKeys.length ? allKeys.length : maxCount;
        for (uint256 i; i < limit; i++) {
            if (Registry(_registryAddr).getModule(allKeys[i]) == moduleAddr) return (allKeys[i], true);
        }
        return (bytes32(0), false);
    }

    /// @notice 批量通过地址反查模块键
    /// @param moduleAddrs 模块地址数组
    /// @param maxCount 每个地址的最大扫描键数（0 表示扫描全部静态键）
    function batchFindModuleKeysByAddresses(address[] memory moduleAddrs, uint256 maxCount) external view onlyValidRegistry returns (bytes32[] memory keys, bool[] memory founds) {
        _enforceBatchLimit(moduleAddrs.length);
        keys = new bytes32[](moduleAddrs.length);
        founds = new bool[](moduleAddrs.length);
        for (uint256 i; i < moduleAddrs.length; i++) { (keys[i], founds[i]) = this.findModuleKeyByAddress(moduleAddrs[i], maxCount); }
    }

    /// @notice 分页获取已注册模块键（包括静态键和动态键）
    /// @param offset 偏移
    /// @param limit 返回数量上限（不可超过 MAX_BATCH_SIZE）
    /// @return keys 当前页键列表
    /// @return totalCount 已注册模块总数
    /// @dev 聚合静态键和动态键中已注册的模块进行分页
    function getRegisteredModuleKeysPaginated(uint256 offset, uint256 limit) external view onlyValidRegistry returns (bytes32[] memory keys, uint256 totalCount) {
        if (limit > MAX_BATCH_SIZE) revert RegistryView__BatchTooLarge();
        bytes32[] memory allKeys = _getAllModuleKeys(); // 使用内部函数获取所有键（包括动态键）
        for (uint256 i; i < allKeys.length; i++) if (Registry(_registryAddr).getModule(allKeys[i]) != address(0)) totalCount++;
        if (offset >= totalCount) return (new bytes32[](0), totalCount);
        uint256 end = offset + limit; if (end > totalCount) end = totalCount; uint256 pageLen = end - offset;
        keys = new bytes32[](pageLen);
        uint256 idx; uint256 write;
        for (uint256 i; i < allKeys.length && write < pageLen; i++) {
            if (Registry(_registryAddr).getModule(allKeys[i]) != address(0)) {
                if (idx >= offset && idx < end) { keys[write++] = allKeys[i]; }
                idx++;
            }
        }
    }

    function registryAddrVar() external view returns (address) { return _registryAddr; }
    function registryAddr() external view returns (address) { return _registryAddr; }
    function getRegistry() external view returns (address) { return _registryAddr; }

    // ---- Read-only: governance/window/owner ----
    function minDelay() external view onlyValidRegistry returns (uint256) {
        try Registry(_registryAddr).minDelay() returns (uint256 v) { return v; } catch { return 0; }
    }

    function maxDelay() external view onlyValidRegistry returns (uint256) {
        try Registry(_registryAddr).MAX_DELAY() returns (uint256 v) { return v; } catch { return 0; }
    }

    function owner() external view onlyValidRegistry returns (address) {
        try Registry(_registryAddr).owner() returns (address v) { return v; } catch { return address(0); }
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    uint256[50] private __gap;
}



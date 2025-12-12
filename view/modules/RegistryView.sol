// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";

/// @title RegistryView
/// @notice 只读注册表视图：承接模块键枚举、注册检查、反查地址、分页等查询
contract RegistryView is Initializable, UUPSUpgradeable {
    address private _registryAddr;

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ---- Keys ----
    function getAllModuleKeys() external view onlyValidRegistry returns (bytes32[] memory) {
        bytes32[] memory staticKeys = ModuleKeys.getAllKeys();
        address dynReg = Registry(_registryAddr).getModule(ModuleKeys.KEY_DYNAMIC_MODULE_REGISTRY);
        if (dynReg == address(0)) return staticKeys;
        try IAccessControlManager(dynReg).getContractStatus() returns (bool) {
            // 占位：动态键查询接口可能与 ACM 冲突，这里直接回退静态键
        } catch {}
        // 为安全起见，这里不聚合动态键，保持与 SystemView 现状等价的最小实现
        return staticKeys;
    }

    function getAllRegisteredModuleKeys() external view onlyValidRegistry returns (bytes32[] memory) {
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
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

    function getAllRegisteredModules() external view onlyValidRegistry returns (bytes32[] memory keys, address[] memory addrs) {
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
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

    function checkModulesExist(bytes32[] memory keys) external view onlyValidRegistry returns (bool[] memory exists) {
        exists = new bool[](keys.length);
        for (uint256 i; i < keys.length; i++) exists[i] = (Registry(_registryAddr).getModule(keys[i]) != address(0));
    }

    function batchModuleExists(bytes32[] memory keys) external view onlyValidRegistry returns (bool[] memory exists) {
        return this.checkModulesExist(keys);
    }

    function findModuleKeyByAddress(address moduleAddr, uint256 maxCount) external view onlyValidRegistry returns (bytes32 key, bool found) {
        if (moduleAddr == address(0)) return (bytes32(0), false);
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
        uint256 limit = maxCount == 0 || maxCount > allKeys.length ? allKeys.length : maxCount;
        for (uint256 i; i < limit; i++) {
            if (Registry(_registryAddr).getModule(allKeys[i]) == moduleAddr) return (allKeys[i], true);
        }
        return (bytes32(0), false);
    }

    function batchFindModuleKeysByAddresses(address[] memory moduleAddrs, uint256 maxCount) external view onlyValidRegistry returns (bytes32[] memory keys, bool[] memory founds) {
        keys = new bytes32[](moduleAddrs.length);
        founds = new bool[](moduleAddrs.length);
        for (uint256 i; i < moduleAddrs.length; i++) { (keys[i], founds[i]) = this.findModuleKeyByAddress(moduleAddrs[i], maxCount); }
    }

    function getRegisteredModuleKeysPaginated(uint256 offset, uint256 limit) external view onlyValidRegistry returns (bytes32[] memory keys, uint256 totalCount) {
        bytes32[] memory allKeys = ModuleKeys.getAllKeys();
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

    // ---- Read-only: governance/window/owner ----
    function minDelay() external view onlyValidRegistry returns (uint256) {
        return Registry(_registryAddr).minDelay();
    }

    function maxDelay() external view onlyValidRegistry returns (uint256) {
        return Registry(_registryAddr).MAX_DELAY();
    }

    function owner() external view onlyValidRegistry returns (address) {
        return Registry(_registryAddr).owner();
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }
}



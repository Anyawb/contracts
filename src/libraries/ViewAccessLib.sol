// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";

/// @title ViewAccessLib
/// @notice 视图层通用权限库：减少各 View 合约中 _requireRole/_hasRole 的重复实现
library ViewAccessLib {
    function requireRole(address registryAddr, bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    function hasRole(address registryAddr, bytes32 actionKey, address user) internal view returns (bool) {
        address acmAddr = Registry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(actionKey, user);
    }
}



// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { EventLibrary } from "../libraries/EventLibrary.sol";
import { ModuleAccessLibrary } from "../libraries/ModuleAccessLibrary.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";

/// @title AccessControlLibrary
/// @notice 统一的权限控制库
/// @dev 提供所有合约都需要的基础权限验证功能
/// @dev 避免重复代码，统一事件发出
/// @custom:security-contact security@example.com
library AccessControlLibrary {
    
    /// @notice 权限验证内部函数
    /// @param registryAddr Registry合约地址
    /// @param actionKey 动作键
    /// @param user 用户地址
    /// @param caller 调用者地址
    function requireRole(
        address registryAddr,
        bytes32 actionKey,
        address user,
        address caller
    ) internal {
        address acmAddr = ModuleAccessLibrary.getModule(registryAddr, ModuleKeys.KEY_ACCESS_CONTROL, caller);
        
        if (acmAddr == address(0)) {
            emit EventLibrary.PermissionVerified(user, actionKey, false, block.timestamp);
            revert("Access control module not available");
        }
        
        try IAccessControlManager(acmAddr).requireRole(actionKey, user) {
            emit EventLibrary.PermissionVerified(user, actionKey, true, block.timestamp);
        } catch {
            emit EventLibrary.PermissionVerified(user, actionKey, false, block.timestamp);
            revert("Insufficient permissions");
        }
    }
    
    /// @notice 角色检查内部函数
    /// @param registryAddr Registry合约地址
    /// @param actionKey 动作键
    /// @param user 用户地址
    /// @param caller 调用者地址
    /// @return 是否具有角色
    function hasRole(
        address registryAddr,
        bytes32 actionKey,
        address user,
        address caller
    ) internal returns (bool) {
        address acmAddr = ModuleAccessLibrary.safeGetModule(registryAddr, ModuleKeys.KEY_ACCESS_CONTROL, caller);
        
        if (acmAddr == address(0)) {
            emit EventLibrary.PermissionVerified(user, actionKey, false, block.timestamp);
            return false;
        }
        
        try IAccessControlManager(acmAddr).hasRole(actionKey, user) returns (bool hasPermission) {
            emit EventLibrary.PermissionVerified(user, actionKey, hasPermission, block.timestamp);
            return hasPermission;
        } catch {
            emit EventLibrary.PermissionVerified(user, actionKey, false, block.timestamp);
            return false;
        }
    }
    
    /// @notice 用户数据访问验证
    /// @param registryAddr Registry合约地址
    /// @param user 用户地址
    /// @param caller 调用者地址
    function requireUserDataAccess(
        address registryAddr,
        address user,
        address caller
    ) internal {
        // 用户只能访问自己的数据，或者管理员可以访问所有数据
        if (user != address(0) && caller != user) {
            requireRole(registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, caller, caller);
        }
    }
    
    /// @notice 系统数据访问验证
    /// @param registryAddr Registry合约地址
    /// @param caller 调用者地址
    function requireSystemDataAccess(
        address registryAddr,
        address caller
    ) internal {
        requireRole(registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, caller, caller);
    }
}

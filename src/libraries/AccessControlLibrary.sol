// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { EventLibrary } from "./EventLibrary.sol";
import { ModuleAccessLibrary } from "./ModuleAccessLibrary.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { MissingRole } from "../errors/StandardErrors.sol";

/// @title AccessControlLibrary
/// @notice Shared access-control helpers with standardized events.
/// @dev Provides common permission checks and emits audit-friendly events.
/// @custom:security-contact security@example.com
library AccessControlLibrary {
    
    /**
     * @notice Require a role via Registry-resolved AccessControlManager.
     * @dev Reverts if:
     *      - Registry access fails (see ModuleAccessLibrary.getModule)
     *      - KEY_ACCESS_CONTROL is missing (acmAddr == address(0))
     *      - ACM.requireRole reverts (MissingRole)
     *
     * Security:
     * - Emits PermissionVerified event on success/failure.
     *
     * @param registryAddr Registry address.
     * @param actionKey Action key (see ActionKeys).
     * @param user Address to authorize.
     * @param caller Caller used for module resolution.
     */
    function requireRole(
        address registryAddr,
        bytes32 actionKey,
        address user,
        address caller
    ) internal {
        address acmAddr = ModuleAccessLibrary.getModule(registryAddr, ModuleKeys.KEY_ACCESS_CONTROL, caller);
        
        if (acmAddr == address(0)) {
            emit EventLibrary.PermissionVerified(user, actionKey, false, block.number);
            revert MissingRole();
        }
        
        try IAccessControlManager(acmAddr).requireRole(actionKey, user) {
            emit EventLibrary.PermissionVerified(user, actionKey, true, block.number);
        } catch {
            emit EventLibrary.PermissionVerified(user, actionKey, false, block.number);
            revert MissingRole();
        }
    }
    
    /**
     * @notice Check whether a user has a role.
     * @dev Reverts if:
     *      - (none; returns false on failure)
     *
     * Security:
     * - Emits PermissionVerified event on success/failure.
     *
     * @param registryAddr Registry address.
     * @param actionKey Action key (see ActionKeys).
     * @param user Address to check.
     * @param caller Caller used for module resolution.
     * @return hasPermission True if user has role, otherwise false.
     */
    function hasRole(
        address registryAddr,
        bytes32 actionKey,
        address user,
        address caller
    ) internal returns (bool) {
        address acmAddr = ModuleAccessLibrary.safeGetModule(registryAddr, ModuleKeys.KEY_ACCESS_CONTROL, caller);
        
        if (acmAddr == address(0)) {
            emit EventLibrary.PermissionVerified(user, actionKey, false, block.number);
            return false;
        }
        
        try IAccessControlManager(acmAddr).hasRole(actionKey, user) returns (bool hasPermission) {
            emit EventLibrary.PermissionVerified(user, actionKey, hasPermission, block.number);
            return hasPermission;
        } catch {
            emit EventLibrary.PermissionVerified(user, actionKey, false, block.number);
            return false;
        }
    }
    
    /**
     * @notice Require access to user-scoped data.
     * @dev Reverts if:
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA (MissingRole)
     *
     * Security:
     * - Calls requireRole for authorization.
     *
     * @param registryAddr Registry address.
     * @param user User address.
     * @param caller Caller address.
     */
    function requireUserDataAccess(
        address registryAddr,
        address user,
        address caller
    ) internal {
        // Users can access their own data; otherwise requires VIEW_USER_DATA.
        if (user != address(0) && caller != user) {
            requireRole(registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, caller, caller);
        }
    }
    
    /**
     * @notice Require access to system-scoped data.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA (MissingRole)
     *
     * Security:
     * - Calls requireRole for authorization.
     *
     * @param registryAddr Registry address.
     * @param caller Caller address.
     */
    function requireSystemDataAccess(
        address registryAddr,
        address caller
    ) internal {
        requireRole(registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, caller, caller);
    }
}

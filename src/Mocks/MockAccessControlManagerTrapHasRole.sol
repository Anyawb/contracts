// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAccessControlManager} from "../interfaces/IAccessControlManager.sol";
import {MissingRole} from "../errors/StandardErrors.sol";

/// @title MockAccessControlManagerTrapHasRole
/// @notice Test-only ACM mock: traps any call to hasRole().
/// @dev Purpose: detect accidental refactors from requireRole()-based gating to hasRole()-based gating.
contract MockAccessControlManagerTrapHasRole is IAccessControlManager {
    mapping(bytes32 => mapping(address => bool)) private _roles;

    /// @notice Emitted when a role is granted (test helper).
    event RoleGranted(bytes32 indexed role, address indexed account);
    /// @notice Emitted when a role is revoked (test helper).
    event RoleRevoked(bytes32 indexed role, address indexed account);

    /// @notice Thrown when hasRole() is called (trap).
    error HasRoleCalled(bytes32 role, address caller);

    function requireRole(bytes32 role, address caller) external view override {
        if (!_roles[role][caller]) revert MissingRole();
    }

    function hasRole(
        bytes32 role,
        address caller
    ) external pure override returns (bool) {
        role;
        caller;
        revert HasRoleCalled(role, caller);
    }

    function grantRole(bytes32 role, address account) external override {
        _roles[role][account] = true;
        emit RoleGranted(role, account);
    }

    function revokeRole(bytes32 role, address account) external override {
        _roles[role][account] = false;
        emit RoleRevoked(role, account);
    }

    function owner() external pure override returns (address) {
        return address(0);
    }

    function getUserPermission(
        address /* account */
    ) external pure override returns (PermissionLevel level) {
        // Not needed for trap purposes.
        return PermissionLevel.NONE;
    }
}

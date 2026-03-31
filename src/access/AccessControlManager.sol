// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAccessControlManager} from "../interfaces/IAccessControlManager.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {
    AccessControlManager__ZeroAddress,
    MissingRole
} from "../errors/StandardErrors.sol";

/**
 * @title AccessControlManager
 * @notice Provide the SSOT write-path permission registry for ActionKeys-based access checks.
 * @dev Reverts if:
 *      - `initialOwner` is the zero address during construction (AccessControlManager__ZeroAddress)
 *      - a caller without the required role is validated through {requireRole} (MissingRole)
 *      - a non-owner attempts role administration (AccessControlManager__OnlyOwnerAllowed)
 *      - a zero role is used for role administration (AccessControlManager__InvalidRole)
 *      - a role grant/revoke targets an invalid state transition
 *        (AccessControlManager__RoleAlreadyGranted / AccessControlManager__RoleNotGranted)
 *
 * Security:
 * - Owner is the only authority allowed to mutate role assignments after deployment.
 * - Role checks are pure in-protocol permission checks and emit no audit side effects on reads.
 * - This module does not define a pause SSOT; pause semantics must be enforced by the caller's architecture path.
 *
 * @custom:security-contact security@example.com
 */
contract AccessControlManager is IAccessControlManager {
    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @notice Thrown when attempting to grant a role that is already granted.
    error AccessControlManager__RoleAlreadyGranted();
    /// @notice Thrown when attempting to revoke a role that is not granted.
    error AccessControlManager__RoleNotGranted();
    /// @notice Thrown when role is the zero hash.
    error AccessControlManager__InvalidRole();
    /// @notice Thrown when a non-owner attempts to administer roles.
    error AccessControlManager__OnlyOwnerAllowed();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    address private _owner;

    /// @notice Store per-role permission bits for each account.
    mapping(bytes32 => mapping(address => bool)) private _roles;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /// @notice Emit when `account` is granted `role`.
    /// @dev `grantedBy` is the caller that performed the state transition.
    event RoleGranted(
        bytes32 indexed role,
        address indexed account,
        address grantedBy
    );

    /// @notice Emit when `role` is revoked from `account`.
    /// @dev `revokedBy` is the caller that performed the state transition.
    event RoleRevoked(
        bytes32 indexed role,
        address indexed account,
        address revokedBy
    );

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    /**
     * @dev Restricts access to the AccessControlManager owner.
     */
    modifier onlyOwner() {
        if (msg.sender != _owner)
            revert AccessControlManager__OnlyOwnerAllowed();
        _;
    }

    /*━━━━━━━━━━━━━━━ Constructor ━━━━━━━━━━━━━━━*/
    /**
     * @notice Creates the AccessControlManager and sets the initial owner.
     * @dev Reverts if:
     *      - initialOwner == address(0) (AccessControlManager__ZeroAddress)
     *
     * Security:
     * - Owner is fixed at deployment time (constructor argument).
     *
     * @param initialOwner Owner address that can grant/revoke roles.
     */
    constructor(address initialOwner) {
        if (initialOwner == address(0))
            revert AccessControlManager__ZeroAddress();

        _owner = initialOwner;

        // Bootstrap: grant the owner baseline admin/operator roles.
        _grantRole(ActionKeys.ACTION_ADMIN, initialOwner);
        _grantRole(ActionKeys.ACTION_SET_PARAMETER, initialOwner);
        _grantRole(ActionKeys.ACTION_UPGRADE_MODULE, initialOwner);
        _grantRole(ActionKeys.ACTION_PAUSE_SYSTEM, initialOwner);
        _grantRole(ActionKeys.ACTION_UNPAUSE_SYSTEM, initialOwner);
    }

    /*━━━━━━━━━━━━━━━ Permission Checks ━━━━━━━━━━━━━━━*/

    /**
     * @notice Return whether `caller` currently has `role`.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only permission probe; does not mutate state or emit audit events.
     * - Callers should use canonical {ActionKeys} constants instead of ad hoc role hashes.
     *
     * @param role Action key / role hash to check.
     * @param caller Address whose permission bit is queried.
     * @return hasPermission True if `caller` has `role`.
     */
    function hasRole(
        bytes32 role,
        address caller
    ) external view override returns (bool) {
        return _roles[role][caller];
    }

    /**
     * @notice Return the inferred aggregate permission tier for `account`.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only classification helper; used for coarse-grained UI / integration logic, not as a write-path SSOT.
     * - Permission level is inferred in descending precedence: ADMIN, OPERATOR, VIEWER, NONE.
     *
     * @param account Account whose aggregate permission tier is derived.
     * @return level Inferred permission level.
     */
    function getUserPermission(
        address account
    ) external view override returns (PermissionLevel level) {
        if (account == address(0)) {
            return PermissionLevel.NONE;
        }

        // ADMIN
        if (_roles[ActionKeys.ACTION_ADMIN][account]) {
            return PermissionLevel.ADMIN;
        }

        // OPERATOR
        if (
            _roles[ActionKeys.ACTION_SET_PARAMETER][account] ||
            _roles[ActionKeys.ACTION_UPGRADE_MODULE][account] ||
            _roles[ActionKeys.ACTION_PAUSE_SYSTEM][account] ||
            _roles[ActionKeys.ACTION_UNPAUSE_SYSTEM][account]
        ) {
            return PermissionLevel.OPERATOR;
        }

        // VIEWER
        if (
            _roles[ActionKeys.ACTION_VIEW_SYSTEM_DATA][account] ||
            _roles[ActionKeys.ACTION_VIEW_USER_DATA][account] ||
            _roles[ActionKeys.ACTION_VIEW_DEGRADATION_DATA][account] ||
            _roles[ActionKeys.ACTION_VIEW_CACHE_DATA][account]
        ) {
            return PermissionLevel.VIEWER;
        }

        return PermissionLevel.NONE;
    }

    /**
     * @notice Enforce that `caller` has been granted `role`.
     * @dev Reverts if:
     *      - `caller` does not have `role` (MissingRole)
     *
     * Security:
     * - Read-only gate used by downstream write paths as the central permission SSOT.
     * - This function intentionally returns no boolean; unauthorized callers must revert explicitly.
     *
     * @param role Action key / role hash required for the guarded path.
     * @param caller Address being authorized.
     */
    function requireRole(bytes32 role, address caller) external view override {
        if (!_roles[role][caller]) {
            revert MissingRole();
        }
    }
    /*━━━━━━━━━━━━━━━ Role Administration ━━━━━━━━━━━━━━━*/

    /**
     * @notice Grant `role` to `account`.
     * @dev Reverts if:
     *      - `msg.sender` is not the ACM owner (AccessControlManager__OnlyOwnerAllowed)
     *      - `account` is the zero address (AccessControlManager__ZeroAddress)
     *      - `role` is zero (AccessControlManager__InvalidRole)
     *      - `account` already has `role` (AccessControlManager__RoleAlreadyGranted)
     *
     * Security:
     * - Owner-gated role administration.
     * - This mutates the write-path permission SSOT used across the protocol,
     *   so callers must treat it as governance-sensitive.
     *
     * @param role Action key / role hash to grant.
     * @param account Target account receiving `role`.
     */
    function grantRole(bytes32 role, address account) external onlyOwner {
        if (account == address(0)) revert AccessControlManager__ZeroAddress();
        if (role == bytes32(0)) revert AccessControlManager__InvalidRole();

        if (_roles[role][account]) {
            revert AccessControlManager__RoleAlreadyGranted();
        }

        _grantRole(role, account);
    }

    /**
     * @notice Revoke `role` from `account`.
     * @dev Reverts if:
     *      - `msg.sender` is not the ACM owner (AccessControlManager__OnlyOwnerAllowed)
     *      - `account` is the zero address (AccessControlManager__ZeroAddress)
     *      - `role` is zero (AccessControlManager__InvalidRole)
     *      - `account` does not currently have `role` (AccessControlManager__RoleNotGranted)
     *
     * Security:
     * - Owner-gated role administration.
     * - Revocations take effect immediately for all downstream paths that rely on this ACM as permission SSOT.
     *
     * @param role Action key / role hash to revoke.
     * @param account Target account losing `role`.
     */
    function revokeRole(bytes32 role, address account) external onlyOwner {
        if (account == address(0)) revert AccessControlManager__ZeroAddress();
        if (role == bytes32(0)) revert AccessControlManager__InvalidRole();

        if (!_roles[role][account]) {
            revert AccessControlManager__RoleNotGranted();
        }

        _revokeRole(role, account);
    }

    /**
     * @dev Internal role grant implementation.
     * @param role Role hash.
     * @param account Target account.
     */
    function _grantRole(bytes32 role, address account) private {
        _roles[role][account] = true;

        emit RoleGranted(role, account, msg.sender);
    }

    /**
     * @dev Internal role revoke implementation.
     * @param role Role hash.
     * @param account Target account.
     */
    function _revokeRole(bytes32 role, address account) private {
        _roles[role][account] = false;

        emit RoleRevoked(role, account, msg.sender);
    }

    /**
     * @notice Return the current ACM owner.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only governance introspection helper.
     *
     * @return currentOwner Owner address.
     */
    function owner() external view returns (address) {
        return _owner;
    }
}

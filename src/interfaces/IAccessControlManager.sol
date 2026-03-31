// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAccessControlManager
 * @notice Interface for the access control manager SSOT used by privileged write paths.
 * @dev Reverts if:
 *      - the implementation rejects unauthorized role checks or invalid role-administration inputs
 *      - role administration is attempted by a caller outside the implementation's owner/governance policy
 *
 * Security:
 * - Provides role checks, role administration, and a coarse permission-level helper.
 * - This interface is the permission SSOT for ActionKeys-based write-path authorization across the protocol.
 */
interface IAccessControlManager {
    /*━━━━━━━━━━━━━━━ Permission Levels ━━━━━━━━━━━━━━━*/

    /// @notice Coarse-grained permission levels derived from the account's assigned roles.
    enum PermissionLevel {
        NONE,
        VIEWER,
        OPERATOR,
        ADMIN
    }

    /*━━━━━━━━━━━━━━━ Role Checks ━━━━━━━━━━━━━━━*/

    /**
     * @notice Reverts unless `caller` currently holds `role`.
     * @dev Reverts if:
     *      - `caller` does not hold `role`
     *      - the implementation rejects the role-check query due to invalid state
     *
     * Security:
     * - Read-only authorization gate used by downstream write paths.
     * - Callers should prefer canonical {ActionKeys} constants instead of ad hoc role hashes.
     *
     * @param role Role identifier.
     * @param caller Caller address to validate.
     */
    function requireRole(bytes32 role, address caller) external view;

    /**
     * @notice Returns whether `caller` currently holds `role`.
     * @dev Reverts if:
     *      - (none expected; implementations typically return `false` for unassigned roles)
     *
     * Security:
     * - Read-only permission probe.
     *
     * @param role Role identifier.
     * @param caller Caller address to validate.
     * @return Whether the caller holds the role.
     */
    function hasRole(bytes32 role, address caller) external view returns (bool);

    /*━━━━━━━━━━━━━━━ Role Administration ━━━━━━━━━━━━━━━*/

    /**
     * @notice Grants `role` to `account`.
     * @dev Reverts if:
     *      - the caller is not authorized to administer roles
     *      - `role` or `account` is invalid for the implementation
     *      - the implementation rejects the requested state transition
     *
     * Security:
     * - Governance-sensitive write path that mutates the protocol permission SSOT.
     *
     * @param role Role identifier.
     * @param account Account receiving the role.
     */
    function grantRole(bytes32 role, address account) external;

    /**
     * @notice Revokes `role` from `account`.
     * @dev Reverts if:
     *      - the caller is not authorized to administer roles
     *      - `role` or `account` is invalid for the implementation
     *      - the implementation rejects the requested state transition
     *
     * Security:
     * - Governance-sensitive write path that mutates the protocol permission SSOT.
     *
     * @param role Role identifier.
     * @param account Account losing the role.
     */
    function revokeRole(bytes32 role, address account) external;

    /*━━━━━━━━━━━━━━━ Queries ━━━━━━━━━━━━━━━*/

    /// @dev Role enumeration and pagination are intentionally excluded to keep the interface minimal.

    /**
     * @notice Returns the current owner address.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only metadata helper for governance tooling.
     *
     * @return Current owner address.
     */
    function owner() external view returns (address);

    /*━━━━━━━━━━━━━━━ Permission Helper ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns the derived permission level for `account`.
     * @dev Reverts if:
     *      - (none expected; implementations may return `PermissionLevel.NONE` for invalid or unprivileged accounts)
     *
     * Security:
     * - Read-only helper for coarse-grained UI and integration logic.
     * - Implementations may compute the level dynamically from assigned roles; callers must not use it as a more
     *   precise substitute for {requireRole}.
     *
     * @param account Account address.
     * @return level Derived permission level.
     */
    function getUserPermission(
        address account
    ) external view returns (PermissionLevel level);
}

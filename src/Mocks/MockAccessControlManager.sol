// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAccessControlManager} from "../interfaces/IAccessControlManager.sol";
import {MissingRole} from "../errors/StandardErrors.sol";

interface IAccessControlViewHooks {
    function pushPermissionUpdate(
        address user,
        bytes32 actionKey,
        bool hasPermission
    ) external;
    function pushPermissionLevelUpdate(
        address user,
        IAccessControlManager.PermissionLevel newLevel
    ) external;
}

/// @title MockAccessControlManager
/// @notice Lightweight role manager used only in tests.
/// @dev Anyone may grant or revoke roles. Do not use this contract in production.
contract MockAccessControlManager is IAccessControlManager {
    mapping(bytes32 => mapping(address => bool)) private _roles;
    mapping(address => PermissionLevel) private _permissionLevels;

    /// @notice Emitted when an account is granted a role.
    /// @param role Role identifier.
    /// @param account Grantee account address.
    event RoleGranted(bytes32 indexed role, address indexed account);
    /// @notice Emitted when an account loses a role.
    /// @param role Role identifier.
    /// @param account Revoked account address.
    event RoleRevoked(bytes32 indexed role, address indexed account);

    /// @notice Grants a role to an account in the mock environment.
    /// @param role Role identifier.
    /// @param account Target account address.
    function grantRole(bytes32 role, address account) external {
        _roles[role][account] = true;
        emit RoleGranted(role, account);
    }

    /// @notice Revokes a role from an account in the mock environment.
    /// @param role Role identifier.
    /// @param account Target account address.
    function revokeRole(bytes32 role, address account) external {
        _roles[role][account] = false;
        emit RoleRevoked(role, account);
    }

    /// @notice Reverts unless the caller has the requested role.
    /// @param role Role identifier.
    /// @param caller Caller address.
    function requireRole(bytes32 role, address caller) external view override {
        if (!_roles[role][caller]) revert MissingRole();
    }

    /// @notice Returns whether the caller has the requested role.
    /// @param role Role identifier.
    /// @param caller Caller address.
    /// @return True when the caller has the role.
    function hasRole(
        bytes32 role,
        address caller
    ) external view override returns (bool) {
        return _roles[role][caller];
    }

    /// @notice Reverts unless the caller has at least one of two roles.
    /// @param role1 First role identifier.
    /// @param role2 Second role identifier.
    /// @param caller Caller address.
    function requireEitherRole(
        bytes32 role1,
        bytes32 role2,
        address caller
    ) external view {
        if (!_roles[role1][caller] && !_roles[role2][caller]) {
            revert MissingRole();
        }
    }

    /*━━━━━━━━━━━━━━━ Compatibility Helpers ━━━━━━━━━━━━━━━*/

    function batchGrantRole(
        bytes32 role,
        address[] calldata accounts
    ) external {
        for (uint256 i = 0; i < accounts.length; i++) {
            _roles[role][accounts[i]] = true;
            emit RoleGranted(role, accounts[i]);
        }
    }

    function batchRevokeRole(
        bytes32 role,
        address[] calldata accounts
    ) external {
        for (uint256 i = 0; i < accounts.length; i++) {
            _roles[role][accounts[i]] = false;
            emit RoleRevoked(role, accounts[i]);
        }
    }

    function setUserPermission(
        address user,
        IAccessControlManager.PermissionLevel level
    ) external {
        _permissionLevels[user] = level;
    }

    function setBatchUserPermissions(
        address[] calldata users,
        IAccessControlManager.PermissionLevel[] calldata levels
    ) external {
        require(users.length == levels.length, "MockACM: length mismatch");
        for (uint256 i = 0; i < users.length; i++) {
            _permissionLevels[users[i]] = levels[i];
        }
    }

    function getUserPermission(
        address user
    ) external view override returns (IAccessControlManager.PermissionLevel) {
        return _permissionLevels[user];
    }

    function setUserPermissionLevel(
        address user,
        PermissionLevel level
    ) external {
        _permissionLevels[user] = level;
    }

    function getUserPermissionWithCache(
        address /* user */
    )
        external
        pure
        returns (
            IAccessControlManager.PermissionLevel level,
            uint256 blockNumber,
            bool isValid
        )
    {
        return (IAccessControlManager.PermissionLevel.NONE, 0, false);
    }

    function checkPermissionWithCache(
        address /* user */,
        IAccessControlManager.PermissionLevel /* requiredLevel */
    ) external pure returns (bool) {
        return false;
    }

    function clearPermissionCache(address /* user */) external pure {
        // Mock implementation keeps no cache.
        uint256 noop = 0;
        noop;
    }

    function clearBatchPermissionCache(
        address[] calldata /* users */
    ) external pure {
        // Mock implementation keeps no cache.
        uint256 noop = 0;
        noop;
    }

    function setCacheExpirationTime(
        uint256 /* newExpirationTime */
    ) external pure {
        // Mock implementation keeps no cache.
        uint256 noop = 0;
        noop;
    }

    // Note: Keeper / emergency pause APIs were removed from IAccessControlManager as they are not part of SSOT.

    function initiateEmergencyRecovery(address /* newKeeper */) external pure {
        // Mock implementation does not execute emergency recovery.
        uint256 noop = 0;
        noop;
    }

    function executeEmergencyRecovery() external pure {
        // Mock implementation does not execute emergency recovery.
        uint256 noop = 0;
        noop;
    }

    function cancelEmergencyRecovery() external pure {
        // Mock implementation does not execute emergency recovery.
        uint256 noop = 0;
        noop;
    }

    function setEmergencyRecoveryDelay(uint256 /* delay */) external pure {
        // Mock implementation does not persist a recovery delay.
        uint256 noop = 0;
        noop;
    }

    function transferOwnership(address /* newOwner */) external pure {
        // Mock implementation does not transfer ownership.
        uint256 noop = 0;
        noop;
    }

    function renounceOwnership() external pure {
        // Mock implementation does not renounce ownership.
        uint256 noop = 0;
        noop;
    }

    function owner() external pure override returns (address) {
        return address(0);
    }

    function isOwner(address /* caller */) external pure returns (bool) {
        return false;
    }

    function getPermissionHistory(
        uint256 /* index */
    )
        external
        pure
        returns (
            address user,
            IAccessControlManager.PermissionLevel oldLevel,
            IAccessControlManager.PermissionLevel newLevel,
            uint256 blockNumber
        )
    {
        return (
            address(0),
            IAccessControlManager.PermissionLevel.NONE,
            IAccessControlManager.PermissionLevel.NONE,
            0
        );
    }

    function getPermissionHistoryCount() external pure returns (uint256) {
        return 0;
    }

    function setMaxHistorySize(uint256 /* newMaxSize */) external pure {
        // Mock implementation does not store permission history.
        uint256 noop = 0;
        noop;
    }

    // Note: role enumeration APIs were removed from IAccessControlManager; keep any extra helpers here as needed for tests.

    function hasRoleByAccount(
        address account,
        bytes32 role
    ) external view returns (bool) {
        return _roles[role][account];
    }

    function totalBatchOperations() external pure returns (uint256) {
        return 0;
    }

    function totalCachedPermissions() external pure returns (uint256) {
        return 0;
    }

    function cacheExpirationTime() external pure returns (uint256) {
        return 0;
    }

    function maxHistorySize() external pure returns (uint256) {
        return 0;
    }

    function emergencyRecoveryDelay() external pure returns (uint256) {
        return 0;
    }

    function lastEmergencyRecoveryTime() external pure returns (uint256) {
        return 0;
    }

    function pendingEmergencyKeeper() external pure returns (address) {
        return address(0);
    }
    function callPushPermissionUpdate(
        address accessControlView,
        address user,
        bytes32 actionKey,
        bool hasPermission
    ) external {
        IAccessControlViewHooks(accessControlView).pushPermissionUpdate(
            user,
            actionKey,
            hasPermission
        );
    }

    function callPushPermissionLevelUpdate(
        address accessControlView,
        address user,
        PermissionLevel newLevel
    ) external {
        IAccessControlViewHooks(accessControlView).pushPermissionLevelUpdate(
            user,
            newLevel
        );
    }
}

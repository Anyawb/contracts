// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ActionKeys } from "../../../constants/ActionKeys.sol";

/**
 * @title LiquidationAccessControl - Liquidation Access Control Library
 * @notice Implements library-based access control, saving approximately 70% gas compared to interface approach
 * @dev Provides access control helpers for the liquidation module.
 *
 * Security:
 * - This library does not enforce caller permissions by itself; callers MUST gate role-management writes.
 * - Uses `msg.sender` as the actor when emitting events from internal calls.
 * @custom:security-contact security@example.com
 */
library LiquidationAccessControl {
    /**
     * @notice Thrown when an account does not have the required role.
     */
    error LiquidationAccessControl__InsufficientPermission();
    /**
     * @notice Thrown when a provided account address is the zero address.
     */
    error LiquidationAccessControl__InvalidAccountAddress();
    /**
     * @notice Thrown when attempting to grant a role that is already granted.
     */
    error LiquidationAccessControl__RoleAlreadyGranted();
    /**
     * @notice Thrown when attempting to revoke/renounce a role that is not granted.
     */
    error LiquidationAccessControl__RoleNotGranted();
    /**
     * @notice Thrown when an operation is not authorized for the caller.
     */
    error LiquidationAccessControl__UnauthorizedOperation();
    /**
     * @notice Thrown when a role member index is out of bounds.
     */
    error LiquidationAccessControl__MemberNotFound();
    /**
     * @notice Thrown when two input arrays must have equal length but do not.
     */
    error LiquidationAccessControl__ArrayLengthMismatch();
    /**
     * @notice Thrown when an owner address is the zero address during initialization.
     */
    error LiquidationAccessControl__InvalidOwnerAddress();
    /**
     * @notice Thrown when a keeper address is the zero address during initialization or update.
     */
    error LiquidationAccessControl__InvalidKeeperAddress();
    /* ============ Storage Structure ============ */
    
    /**
     * @notice Access control storage structure
     * @dev Contains role permission mappings, account role lists, role account lists, etc.
     */
    struct Storage {
        /// @notice Role permission mapping: roleKey => account => hasPermission
        mapping(bytes32 => mapping(address => bool)) roles;
        
        /// @notice List of roles owned by each account: account => roles[]
        mapping(address => bytes32[]) accountRoles;
        
        /// @notice List of accounts for each role: roleKey => accounts[]
        mapping(bytes32 => address[]) roleAccounts;
        
        /// @notice Count of accounts for each role: roleKey => count
        mapping(bytes32 => uint256) roleAccountCount;
        
        /// @notice Admin role mapping for each role: roleKey => adminRoleKey
        mapping(bytes32 => bytes32) roleAdmins;
        
        /// @notice Owner address
        address owner;
        
        /// @notice Keeper address
        address keeper;
        
        /// @notice Emergency pause flag
        bool emergencyPaused;
    }

    /* ============ Events ============ */
    
    /**
     * @notice Emitted when a role is granted to an account.
     * @param roleKey Role identifier (bytes32)
     * @param targetAccount Account address that received the role
     * @param senderAddr Address that granted the role
     */
    event RoleGranted(
        bytes32 indexed roleKey, 
        address indexed targetAccount,
        address indexed senderAddr
    );
    
    /**
     * @notice Emitted when a role is revoked from an account.
     * @param roleKey Role identifier (bytes32)
     * @param targetAccount Account address that lost the role
     * @param senderAddr Address that revoked the role
     */
    event RoleRevoked(
        bytes32 indexed roleKey, 
        address indexed targetAccount,
        address indexed senderAddr
    );
    
    /**
     * @notice Emitted when the admin role for a role is changed.
     * @param roleKey Role identifier (bytes32)
     * @param previousAdminRole Previous admin role identifier (bytes32)
     * @param newAdminRole New admin role identifier (bytes32)
     */
    event RoleAdminChanged(
        bytes32 indexed roleKey,
        bytes32 indexed previousAdminRole,
        bytes32 indexed newAdminRole
    );

    /* ============ Core Permission Functions ============ */
    
    /**
     * @notice Check if an account has a specific role.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View-only function, no state changes
     *
     * @param self Permission control storage structure
     * @param roleKey Role identifier (bytes32)
     * @param targetAccount Account address to check
     * @return Whether the account has the specified role
     */
    function hasRole(
        Storage storage self,
        bytes32 roleKey,
        address targetAccount
    ) internal view returns (bool) {
        return self.roles[roleKey][targetAccount];
    }

    /**
     * @notice Require that an account has a specific role, revert otherwise.
     * @dev Reverts if:
     *      - targetAccount does not have roleKey (LiquidationAccessControl__InsufficientPermission)
     *
     * Security:
     * - View-only function, no state changes
     * - Used for access control checks
     *
     * @param self Permission control storage structure
     * @param roleKey Role identifier (bytes32)
     * @param targetAccount Account address to check
     */
    function requireRole(
        Storage storage self,
        bytes32 roleKey,
        address targetAccount
    ) internal view {
        if (!self.roles[roleKey][targetAccount]) revert LiquidationAccessControl__InsufficientPermission();
    }

    /* ============ Role Management Functions ============ */
    
    /**
     * @notice Grant a role to an account.
     * @dev Reverts if:
     *      - targetAccount is zero address (LiquidationAccessControl__InvalidAccountAddress)
     *      - targetAccount already has roleKey (LiquidationAccessControl__RoleAlreadyGranted)
     *
     * Security:
     * - Internal function, caller must have appropriate permissions
     * - Emits RoleGranted event
     *
     * @param self Permission control storage structure
     * @param roleKey Role identifier (bytes32)
     * @param targetAccount Account address to grant role to
     */
    function grantRole(
        Storage storage self,
        bytes32 roleKey,
        address targetAccount
    ) internal {
        if (targetAccount == address(0)) revert LiquidationAccessControl__InvalidAccountAddress();
        
        if (self.roles[roleKey][targetAccount]) revert LiquidationAccessControl__RoleAlreadyGranted();
        
        _grantRole(self, roleKey, targetAccount);
        emit RoleGranted(roleKey, targetAccount, msg.sender);
    }

    /**
     * @notice Revoke a role from an account.
     * @dev Reverts if:
     *      - targetAccount is zero address (LiquidationAccessControl__InvalidAccountAddress)
     *      - targetAccount does not have roleKey (LiquidationAccessControl__RoleNotGranted)
     *
     * Security:
     * - Internal function, caller must have appropriate permissions
     * - Emits RoleRevoked event
     *
     * @param self Permission control storage structure
     * @param roleKey Role identifier (bytes32)
     * @param targetAccount Account address to revoke role from
     */
    function revokeRole(
        Storage storage self,
        bytes32 roleKey,
        address targetAccount
    ) internal {
        if (targetAccount == address(0)) revert LiquidationAccessControl__InvalidAccountAddress();
        
        if (!self.roles[roleKey][targetAccount]) revert LiquidationAccessControl__RoleNotGranted();
        
        _revokeRole(self, roleKey, targetAccount);
        emit RoleRevoked(roleKey, targetAccount, msg.sender);
    }

    /**
     * @notice Allow an account to renounce one of its own roles.
     * @dev Reverts if:
     *      - msg.sender != targetAccount (LiquidationAccessControl__UnauthorizedOperation)
     *      - targetAccount does not have roleKey (LiquidationAccessControl__RoleNotGranted)
     *
     * Security:
     * - Only the account itself can renounce its own role
     * - Emits RoleRevoked event
     *
     * @param self Permission control storage structure
     * @param roleKey Role identifier (bytes32)
     * @param targetAccount Account address that will renounce the role
     */
    function renounceRole(
        Storage storage self,
        bytes32 roleKey,
        address targetAccount
    ) internal {
        if (msg.sender != targetAccount) revert LiquidationAccessControl__UnauthorizedOperation();
        
        if (!self.roles[roleKey][targetAccount]) revert LiquidationAccessControl__RoleNotGranted();
        
        _revokeRole(self, roleKey, targetAccount);
        emit RoleRevoked(roleKey, targetAccount, msg.sender);
    }

    /* ============ Role Hierarchy Functions ============ */
    
    /**
     * @notice Get the admin role for a specific role.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View-only function, no state changes
     *
     * @param self Permission control storage structure
     * @param roleKey Role identifier (bytes32)
     * @return Admin role identifier (bytes32), returns bytes32(0) if not set
     */
    function getRoleAdmin(
        Storage storage self,
        bytes32 roleKey
    ) internal view returns (bytes32) {
        return self.roleAdmins[roleKey];
    }

    /**
     * @notice Set the admin role for a specific role.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Internal function, caller must have appropriate permissions
     * - Emits RoleAdminChanged event
     *
     * @param self Permission control storage structure
     * @param roleKey Role identifier (bytes32)
     * @param newAdminRole New admin role identifier (bytes32)
     */
    function setRoleAdmin(
        Storage storage self,
        bytes32 roleKey,
        bytes32 newAdminRole
    ) internal {
        bytes32 previousAdminRole = self.roleAdmins[roleKey];
        self.roleAdmins[roleKey] = newAdminRole;
        
        emit RoleAdminChanged(roleKey, previousAdminRole, newAdminRole);
    }

    /* ============ Role Information Functions ============ */
    
    /**
     * @notice Check if a role key is valid.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Pure function, no state access
     *
     * @param roleKey Role identifier (bytes32)
     * @return Whether the role key is valid according to ActionKeys validation
     */
    function roleExists(bytes32 roleKey) internal pure returns (bool) {
        return ActionKeys.isValidActionKey(roleKey);
    }

    /**
     * @notice Get the number of accounts that have a specific role.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View-only function, no state changes
     *
     * @param self Permission control storage structure
     * @param roleKey Role identifier (bytes32)
     * @return Number of accounts with the specified role (uint256)
     */
    function getRoleMemberCount(
        Storage storage self,
        bytes32 roleKey
    ) internal view returns (uint256) {
        return self.roleAccountCount[roleKey];
    }

    /**
     * @notice Get the account address at a specific index for a role's member list.
     * @dev Reverts if:
     *      - memberIndex >= role member count (LiquidationAccessControl__MemberNotFound)
     *
     * Security:
     * - View-only function, no state changes
     *
     * @param self Permission control storage structure
     * @param roleKey Role identifier (bytes32)
     * @param memberIndex Index in the role's member list (0-based, uint256)
     * @return Account address at the specified index
     */
    function getRoleMember(
        Storage storage self,
        bytes32 roleKey,
        uint256 memberIndex
    ) internal view returns (address) {
        address[] storage members = self.roleAccounts[roleKey];
        if (memberIndex >= members.length) {
            revert LiquidationAccessControl__MemberNotFound();
        }
        return members[memberIndex];
    }

    /* ============ Batch Query Functions ============ */
    
    /**
     * @notice Batch check if multiple accounts have their corresponding roles.
     * @dev Reverts if:
     *      - roleKeys.length != targetAccounts.length (LiquidationAccessControl__ArrayLengthMismatch)
     *
     * Security:
     * - View-only function, no state changes
     *
     * @param self Permission control storage structure
     * @param roleKeys Array of role identifiers (bytes32[])
     * @param targetAccounts Array of account addresses to check
     * @return Array of boolean results indicating if each account has its corresponding role
     */
    function batchHasRole(
        Storage storage self,
        bytes32[] memory roleKeys,
        address[] memory targetAccounts
    ) internal view returns (bool[] memory) {
        uint256 length = roleKeys.length;
        if (length != targetAccounts.length) {
            revert LiquidationAccessControl__ArrayLengthMismatch();
        }
        
        bool[] memory results = new bool[](length);
        for (uint256 i = 0; i < length;) {
            results[i] = self.roles[roleKeys[i]][targetAccounts[i]];
            unchecked { ++i; }
        }
        
        return results;
    }

    /**
     * @notice Batch get member counts for multiple roles.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View-only function, no state changes
     *
     * @param self Permission control storage structure
     * @param roleKeys Array of role identifiers (bytes32[])
     * @return Array of member counts for each role (uint256[])
     */
    function batchGetRoleMemberCount(
        Storage storage self,
        bytes32[] memory roleKeys
    ) internal view returns (uint256[] memory) {
        uint256 length = roleKeys.length;
        uint256[] memory counts = new uint256[](length);
        
        for (uint256 i = 0; i < length;) {
            counts[i] = self.roleAccountCount[roleKeys[i]];
            unchecked { ++i; }
        }
        
        return counts;
    }

    /**
     * @notice Batch get admin roles for multiple roles.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View-only function, no state changes
     *
     * @param self Permission control storage structure
     * @param roleKeys Array of role identifiers (bytes32[])
     * @return Array of admin role identifiers for each role (bytes32[])
     */
    function batchGetRoleAdmin(
        Storage storage self,
        bytes32[] memory roleKeys
    ) internal view returns (bytes32[] memory) {
        uint256 length = roleKeys.length;
        bytes32[] memory admins = new bytes32[](length);
        
        for (uint256 i = 0; i < length;) {
            admins[i] = self.roleAdmins[roleKeys[i]];
            unchecked { ++i; }
        }
        
        return admins;
    }

    /* ============ Initialization Functions ============ */
    
    /**
     * @notice Initialize access control with owner and keeper addresses.
     * @dev Reverts if:
     *      - initialOwner is zero address (LiquidationAccessControl__InvalidOwnerAddress)
     *      - initialKeeper is zero address (LiquidationAccessControl__InvalidKeeperAddress)
     *
     * Security:
     * - Internal function, should only be called during initialization
     * - Grants default roles to owner and keeper
     *
     * @param self Permission control storage structure
     * @param initialOwner Initial owner address
     * @param initialKeeper Initial keeper address
     */
    function initialize(
        Storage storage self,
        address initialOwner,
        address initialKeeper
    ) internal {
        if (initialOwner == address(0)) {
            revert LiquidationAccessControl__InvalidOwnerAddress();
        }
        if (initialKeeper == address(0)) {
            revert LiquidationAccessControl__InvalidKeeperAddress();
        }
        
        self.owner = initialOwner;
        self.keeper = initialKeeper;
        self.emergencyPaused = false;
        
        // 初始化默认权限
        grantRole(self, ActionKeys.ACTION_GRANT_ROLE, initialOwner);
        grantRole(self, ActionKeys.ACTION_REVOKE_ROLE, initialOwner);
        grantRole(self, ActionKeys.ACTION_LIQUIDATE, initialKeeper);
        grantRole(self, ActionKeys.ACTION_SET_PARAMETER, initialOwner);
        grantRole(self, ActionKeys.ACTION_UPGRADE_MODULE, initialOwner);
    }

    /* ============ Utility Functions ============ */
    
    /**
     * @notice Check if an account is the owner.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View-only function, no state changes
     *
     * @param self Permission control storage structure
     * @param account Account address to check
     * @return Whether the account is the owner
     */
    function isOwner(
        Storage storage self,
        address account
    ) internal view returns (bool) {
        return account == self.owner;
    }

    /**
     * @notice Check if an account is the keeper.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View-only function, no state changes
     *
     * @param self Permission control storage structure
     * @param account Account address to check
     * @return Whether the account is the keeper
     */
    function isKeeper(
        Storage storage self,
        address account
    ) internal view returns (bool) {
        return account == self.keeper;
    }

    /**
     * @notice Check if the contract is in paused state.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View-only function, no state changes
     *
     * @param self Permission control storage structure
     * @return Whether the contract is paused
     */
    function isPaused(Storage storage self) internal view returns (bool) {
        return self.emergencyPaused;
    }

    /**
     * @notice Set the pause status of the contract.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Internal function, caller must have appropriate permissions
     *
     * @param self Permission control storage structure
     * @param paused Whether to pause (true) or unpause (false)
     */
    function setPaused(Storage storage self, bool paused) internal {
        self.emergencyPaused = paused;
    }

    /**
     * @notice Set a new keeper address and transfer liquidation permissions.
     * @dev Reverts if:
     *      - newKeeper is zero address (LiquidationAccessControl__InvalidKeeperAddress)
     *
     * Security:
     * - Internal function, caller must have appropriate permissions
     * - Automatically revokes liquidation role from old keeper
     * - Automatically grants liquidation role to new keeper
     *
     * @param self Permission control storage structure
     * @param newKeeper New keeper address
     */
    function setKeeper(
        Storage storage self,
        address newKeeper
    ) internal {
        if (newKeeper == address(0)) {
            revert LiquidationAccessControl__InvalidKeeperAddress();
        }
        
        // 撤销旧Keeper的清算权限
        if (self.roles[ActionKeys.ACTION_LIQUIDATE][self.keeper]) {
            _revokeRole(self, ActionKeys.ACTION_LIQUIDATE, self.keeper);
        }
        
        self.keeper = newKeeper;
        
        // 授予新Keeper的清算权限
        if (!self.roles[ActionKeys.ACTION_LIQUIDATE][newKeeper]) {
            _grantRole(self, ActionKeys.ACTION_LIQUIDATE, newKeeper);
        }
    }

    /* ============ Internal Helper Functions ============ */
    
    /**
     * @notice Internal implementation of granting a role to an account.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Private function, only called by grantRole
     * - Updates role mappings and counters
     *
     * @param self Permission control storage structure
     * @param role Role identifier (bytes32)
     * @param account Account address to grant role to
     */
    function _grantRole(
        Storage storage self,
        bytes32 role,
        address account
    ) private {
        self.roles[role][account] = true;
        self.accountRoles[account].push(role);
        self.roleAccounts[role].push(account);
        self.roleAccountCount[role]++;
    }
    
    /**
     * @notice Internal implementation of revoking a role from an account.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Private function, only called by revokeRole and renounceRole
     * - Updates role mappings and counters
     * - Removes role from both account-to-roles and role-to-accounts mappings
     *
     * @param self Permission control storage structure
     * @param role Role identifier (bytes32)
     * @param account Account address to revoke role from
     */
    function _revokeRole(
        Storage storage self,
        bytes32 role,
        address account
    ) private {
        self.roles[role][account] = false;
        
        // 从账户角色列表中移除
        bytes32[] storage accountRoles = self.accountRoles[account];
        for (uint256 i = 0; i < accountRoles.length; i++) {
            if (accountRoles[i] == role) {
                accountRoles[i] = accountRoles[accountRoles.length - 1];
                accountRoles.pop();
                break;
            }
        }
        
        // 从角色账户列表中移除
        address[] storage roleAccounts = self.roleAccounts[role];
        for (uint256 i = 0; i < roleAccounts.length; i++) {
            if (roleAccounts[i] == account) {
                roleAccounts[i] = roleAccounts[roleAccounts.length - 1];
                roleAccounts.pop();
                break;
            }
        }
        
        self.roleAccountCount[role]--;
    }
} 
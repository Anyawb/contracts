// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { 
    AccessControlManager__ZeroAddress,
    MissingRole
} from "../errors/StandardErrors.sol";

/**
 * @title AccessControlManager
 * @notice SSOT access control module for role-gated write permissions (ActionKeys-based).
 * @dev Reverts if:
 *      - caller is missing a required role (MissingRole)
 *      - non-owner attempts to grant/revoke roles (AccessControlManager__OnlyOwnerAllowed)
 *      - zero address is provided where not allowed (AccessControlManager__ZeroAddress)
 *      - role is zero (AccessControlManager__InvalidRole)
 *      - role already granted (AccessControlManager__RoleAlreadyGranted)
 *      - role not granted (AccessControlManager__RoleNotGranted)
 *
 * Security:
 * - Owner-gated role administration (constructor sets initial owner)
 * - This contract does NOT implement a global pause; system pause SSOT is handled by VaultRouter.
 * @custom:security-contact security@example.com
 */
contract AccessControlManager is IAccessControlManager {
    // =================== 自定义错误 ===================
    /// @notice Thrown when attempting to grant a role that is already granted.
    error AccessControlManager__RoleAlreadyGranted();
    /// @notice Thrown when attempting to revoke a role that is not granted.
    error AccessControlManager__RoleNotGranted();
    /// @notice Thrown when role is the zero hash.
    error AccessControlManager__InvalidRole();
    /// @notice Thrown when a non-owner attempts to administer roles.
    error AccessControlManager__OnlyOwnerAllowed();
    
    // =================== 状态变量 ===================
    address private _owner;
    
    /// @notice 角色权限映射
    mapping(bytes32 => mapping(address => bool)) private _roles;

    // =================== 事件定义 ===================
    
    /// @notice 当账户被授予角色时触发
    event RoleGranted(
        bytes32 indexed role, 
        address indexed account,
        address grantedBy
    );
    
    /// @notice 当账户角色被撤销时触发
    event RoleRevoked(
        bytes32 indexed role, 
        address indexed account,
        address revokedBy
    );

    // =================== 修饰符 ===================
    /**
     * @dev Restricts access to the AccessControlManager owner.
     */
    modifier onlyOwner() {
        if (msg.sender != _owner) revert AccessControlManager__OnlyOwnerAllowed();
        _;
    }

    // =================== 构造函数 ===================
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
        if (initialOwner == address(0)) revert AccessControlManager__ZeroAddress();
        
        _owner = initialOwner;
        
        // Bootstrap: grant the owner baseline admin/operator roles.
        _grantRole(ActionKeys.ACTION_ADMIN, initialOwner);
        _grantRole(ActionKeys.ACTION_SET_PARAMETER, initialOwner);
        _grantRole(ActionKeys.ACTION_UPGRADE_MODULE, initialOwner);
        _grantRole(ActionKeys.ACTION_PAUSE_SYSTEM, initialOwner);
        _grantRole(ActionKeys.ACTION_UNPAUSE_SYSTEM, initialOwner);
    }

    // =================== 基础权限验证 ===================
    
    /**
     * @notice Returns whether `caller` has `role`.
     * @param role Action key / role hash.
     * @param caller Address to check.
     * @return True if `caller` has `role`.
     */
    function hasRole(bytes32 role, address caller) external view override returns (bool) {
        return _roles[role][caller];
    }
    
    /**
     * @notice Returns the inferred permission level for `account`.
     * @dev PermissionLevel is inferred from roles, in priority order:
     *      ADMIN → OPERATOR → VIEWER → NONE.
     *
     * @param account Account address.
     * @return level Inferred permission level.
     */
    function getUserPermission(address account) external view override returns (PermissionLevel level) {
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
     * @notice Reverts if `caller` does not have `role`.
     * @dev Reverts if:
     *      - caller does not have role (MissingRole)
     * @param role Action key / role hash.
     * @param caller Address to validate.
     */
    function requireRole(bytes32 role, address caller) external view override {
        if (!_roles[role][caller]) {
            revert MissingRole();
        }
    }
    


    // =================== 角色管理 ===================
    
    /**
     * @notice Grants `role` to `account`.
     * @dev Reverts if:
     *      - msg.sender is not owner (AccessControlManager__OnlyOwnerAllowed)
     *      - account == address(0) (AccessControlManager__ZeroAddress)
     *      - role == bytes32(0) (AccessControlManager__InvalidRole)
     *      - role already granted (AccessControlManager__RoleAlreadyGranted)
     *
     * Security:
     * - Owner-gated.
     *
     * @param role Action key / role hash.
     * @param account Target account to grant the role to.
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
     * @notice Revokes `role` from `account`.
     * @dev Reverts if:
     *      - msg.sender is not owner (AccessControlManager__OnlyOwnerAllowed)
     *      - account == address(0) (AccessControlManager__ZeroAddress)
     *      - role == bytes32(0) (AccessControlManager__InvalidRole)
     *      - role not granted (AccessControlManager__RoleNotGranted)
     *
     * Security:
     * - Owner-gated.
     *
     * @param role Action key / role hash.
     * @param account Target account to revoke the role from.
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
     * @notice Returns the owner address.
     * @return Owner address.
     */
    function owner() external view returns (address) {
        return _owner;
    }
} 
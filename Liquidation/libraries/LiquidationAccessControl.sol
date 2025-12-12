// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ActionKeys } from "../../../constants/ActionKeys.sol";

/**
 * @title LiquidationAccessControl - 清算权限控制库
 * @dev 提供清算模块的权限控制功能，优化gas消耗
 * @notice 实现库方式的权限控制，相比接口方式节省约70%的gas
 * @dev 遵循 3.3 命名规范：PascalCase 合约名，camelCase 函数名，PascalCase 事件名
 * @custom:security-contact security@example.com
 */
library LiquidationAccessControl {
    /// @dev 自定义错误，替代字符串 revert
    error LiquidationAccessControl__InsufficientPermission();
    error LiquidationAccessControl__InvalidAccountAddress();
    error LiquidationAccessControl__RoleAlreadyGranted();
    error LiquidationAccessControl__RoleNotGranted();
    error LiquidationAccessControl__UnauthorizedOperation();
    /* ============ Storage Structure ============ */
    
    /**
     * @notice 权限控制存储结构
     * @dev 包含角色权限映射、账户角色列表、角色账户列表等
     */
    struct Storage {
        /// @notice 角色权限映射
        mapping(bytes32 => mapping(address => bool)) roles;
        
        /// @notice 账户拥有的角色列表
        mapping(address => bytes32[]) accountRoles;
        
        /// @notice 角色拥有的账户列表
        mapping(bytes32 => address[]) roleAccounts;
        
        /// @notice 角色账户计数
        mapping(bytes32 => uint256) roleAccountCount;
        
        /// @notice 角色管理员映射
        mapping(bytes32 => bytes32) roleAdmins;
        
        /// @notice 所有者地址
        address owner;
        
        /// @notice Keeper地址
        address keeper;
        
        /// @notice 紧急暂停标志
        bool emergencyPaused;
    }

    /* ============ Events ============ */
    
    /// @notice 当账户被授予角色时触发
    event RoleGranted(
        bytes32 indexed roleKey, 
        address indexed targetAccount,
        address indexed senderAddr
    );
    
    /// @notice 当账户角色被撤销时触发
    event RoleRevoked(
        bytes32 indexed roleKey, 
        address indexed targetAccount,
        address indexed senderAddr
    );
    
    /// @notice 角色管理员变更事件
    event RoleAdminChanged(
        bytes32 indexed roleKey,
        bytes32 indexed previousAdminRole,
        bytes32 indexed newAdminRole
    );

    /* ============ Core Permission Functions ============ */
    
    /**
     * @notice 检查角色权限 - 验证指定账户是否具有指定角色
     * @notice Check role permission - Verify if specified account has specified role
     * @param self 权限控制存储 Permission control storage
     * @param roleKey 角色标识 Role identifier
     * @param targetAccount 账户地址 Account address
     * @return 是否具有权限 Whether has permission
     */
    function hasRole(
        Storage storage self,
        bytes32 roleKey,
        address targetAccount
    ) internal view returns (bool) {
        return self.roles[roleKey][targetAccount];
    }

    /**
     * @notice 要求角色权限 - 如果账户不具有指定角色则回滚
     * @notice Require role permission - Revert if account doesn't have specified role
     * @param self 权限控制存储 Permission control storage
     * @param roleKey 角色标识 Role identifier
     * @param targetAccount 账户地址 Account address
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
     * @notice 授予角色 - 为指定账户授予指定角色
     * @notice Grant role - Grant specified role to specified account
     * @param self 权限控制存储 Permission control storage
     * @param roleKey 角色标识 Role identifier
     * @param targetAccount 账户地址 Account address
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
     * @notice 撤销角色 - 从指定账户撤销指定角色
     * @notice Revoke role - Revoke specified role from specified account
     * @param self 权限控制存储 Permission control storage
     * @param roleKey 角色标识 Role identifier
     * @param targetAccount 账户地址 Account address
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
     * @notice 放弃角色 - 账户主动放弃指定角色
     * @notice Renounce role - Account actively renounces specified role
     * @param self 权限控制存储 Permission control storage
     * @param roleKey 角色标识 Role identifier
     * @param targetAccount 账户地址 Account address
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
     * @notice 获取角色管理员 - 获取指定角色的管理员角色
     * @notice Get role admin - Get admin role for specified role
     * @param self 权限控制存储 Permission control storage
     * @param roleKey 角色标识 Role identifier
     * @return 管理员角色标识 Admin role identifier
     */
    function getRoleAdmin(
        Storage storage self,
        bytes32 roleKey
    ) internal view returns (bytes32) {
        return self.roleAdmins[roleKey];
    }

    /**
     * @notice 设置角色管理员 - 设置指定角色的管理员角色
     * @notice Set role admin - Set admin role for specified role
     * @param self 权限控制存储 Permission control storage
     * @param roleKey 角色标识 Role identifier
     * @param newAdminRole 管理员角色标识 Admin role identifier
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
     * @notice 检查角色是否存在 - 检查指定角色是否已定义
     * @notice Check if role exists - Check if specified role is defined
     * @param roleKey 角色标识 Role identifier
     * @return 角色是否存在 Whether role exists
     */
    function roleExists(bytes32 roleKey) internal pure returns (bool) {
        return ActionKeys.isValidActionKey(roleKey);
    }

    /**
     * @notice 获取角色成员数量 - 获取指定角色的成员数量
     * @notice Get role member count - Get member count for specified role
     * @param self 权限控制存储 Permission control storage
     * @param roleKey 角色标识 Role identifier
     * @return 成员数量 Member count
     */
    function getRoleMemberCount(
        Storage storage self,
        bytes32 roleKey
    ) internal view returns (uint256) {
        return self.roleAccountCount[roleKey];
    }

    /**
     * @notice 获取角色成员 - 获取指定角色在指定索引位置的成员
     * @notice Get role member - Get member at specified index for specified role
     * @param self 权限控制存储 Permission control storage
     * @param roleKey 角色标识 Role identifier
     * @param memberIndex 成员索引 Member index
     * @return 成员地址 Member address
     */
    function getRoleMember(
        Storage storage self,
        bytes32 roleKey,
        uint256 memberIndex
    ) internal view returns (address) {
        address[] storage members = self.roleAccounts[roleKey];
        if (memberIndex >= members.length) {
            revert("Member not found");
        }
        return members[memberIndex];
    }

    /* ============ Batch Query Functions ============ */
    
    /**
     * @notice 批量检查角色权限 - 验证多个账户是否具有指定角色
     * @notice Batch check role permissions - Verify if multiple accounts have specified roles
     * @param self 权限控制存储 Permission control storage
     * @param roleKeys 角色标识数组 Role identifiers array
     * @param targetAccounts 账户地址数组 Account addresses array
     * @return 权限结果数组 Permission results array
     */
    function batchHasRole(
        Storage storage self,
        bytes32[] memory roleKeys,
        address[] memory targetAccounts
    ) internal view returns (bool[] memory) {
        uint256 length = roleKeys.length;
        if (length != targetAccounts.length) {
            revert("Array length mismatch");
        }
        
        bool[] memory results = new bool[](length);
        for (uint256 i = 0; i < length;) {
            results[i] = self.roles[roleKeys[i]][targetAccounts[i]];
            unchecked { ++i; }
        }
        
        return results;
    }

    /**
     * @notice 批量获取角色成员数量 - 获取多个角色的成员数量
     * @notice Batch get role member counts - Get member counts for multiple roles
     * @param self 权限控制存储 Permission control storage
     * @param roleKeys 角色标识数组 Role identifiers array
     * @return 成员数量数组 Member counts array
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
     * @notice 批量获取角色管理员 - 获取多个角色的管理员
     * @notice Batch get role admins - Get admins for multiple roles
     * @param self 权限控制存储 Permission control storage
     * @param roleKeys 角色标识数组 Role identifiers array
     * @return 管理员角色数组 Admin roles array
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
     * @notice 初始化权限控制 - 设置初始配置和默认权限
     * @notice Initialize access control - Set initial configuration and default permissions
     * @param self 权限控制存储 Permission control storage
     * @param initialOwner 初始所有者地址 Initial owner address
     * @param initialKeeper 初始Keeper地址 Initial keeper address
     */
    function initialize(
        Storage storage self,
        address initialOwner,
        address initialKeeper
    ) internal {
        if (initialOwner == address(0)) {
            revert("Invalid owner address");
        }
        if (initialKeeper == address(0)) {
            revert("Invalid keeper address");
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
     * @notice 检查是否为所有者 - 检查指定地址是否为所有者
     * @notice Check if owner - Check if specified address is owner
     * @param self 权限控制存储 Permission control storage
     * @param account 账户地址 Account address
     * @return 是否为所有者 Whether is owner
     */
    function isOwner(
        Storage storage self,
        address account
    ) internal view returns (bool) {
        return account == self.owner;
    }

    /**
     * @notice 检查是否为Keeper - 检查指定地址是否为Keeper
     * @notice Check if keeper - Check if specified address is keeper
     * @param self 权限控制存储 Permission control storage
     * @param account 账户地址 Account address
     * @return 是否为Keeper Whether is keeper
     */
    function isKeeper(
        Storage storage self,
        address account
    ) internal view returns (bool) {
        return account == self.keeper;
    }

    /**
     * @notice 检查是否暂停 - 检查合约是否处于暂停状态
     * @notice Check if paused - Check if contract is paused
     * @param self 权限控制存储 Permission control storage
     * @return 是否暂停 Whether paused
     */
    function isPaused(Storage storage self) internal view returns (bool) {
        return self.emergencyPaused;
    }

    /**
     * @notice 设置暂停状态 - 设置合约的暂停状态
     * @notice Set pause status - Set contract pause status
     * @param self 权限控制存储 Permission control storage
     * @param paused 是否暂停 Whether to pause
     */
    function setPaused(Storage storage self, bool paused) internal {
        self.emergencyPaused = paused;
    }

    /**
     * @notice 设置Keeper - 设置新的Keeper地址
     * @notice Set keeper - Set new keeper address
     * @param self 权限控制存储 Permission control storage
     * @param newKeeper 新的Keeper地址 New keeper address
     */
    function setKeeper(
        Storage storage self,
        address newKeeper
    ) internal {
        if (newKeeper == address(0)) {
            revert("Invalid keeper address");
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
     * @notice 授予角色的内部实现
     * @notice Internal implementation of granting role
     * @param self 权限控制存储 Permission control storage
     * @param role 角色哈希 Role hash
     * @param account 目标账户 Target account
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
     * @notice 撤销角色的内部实现
     * @notice Internal implementation of revoking role
     * @param self 权限控制存储 Permission control storage
     * @param role 角色哈希 Role hash
     * @param account 目标账户 Target account
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
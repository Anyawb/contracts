// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { 
    ZeroAddress,
    MissingRole
} from "../errors/StandardErrors.sol";

/**
 * @title AccessControlCore - 核心权限控制
 * @dev 提供基础的权限验证功能，实现IAccessControlManager接口
 * @notice 包含角色管理、紧急暂停和Keeper管理
 * @custom:security-contact security@example.com
 */
contract AccessControlCore is IAccessControlManager, ReentrancyGuard {
    // =================== 自定义错误 ===================
    error InvalidKeeperAddress();
    error OnlyKeeperAllowed();
    error ContractPaused();
    error RoleAlreadyGranted();
    error RoleNotGranted();
    error InvalidRole();
    
    // =================== 状态变量 ===================
    address private _owner;
    address private _keeper;
    bool private _emergencyPaused;


    
    /// @notice 角色权限映射
    mapping(bytes32 => mapping(address => bool)) private _roles;
    
    /// @notice 账户拥有的角色列表
    mapping(address => bytes32[]) private _accountRoles;
    
    /// @notice 角色拥有的账户列表
    mapping(bytes32 => address[]) private _roleAccounts;
    
    /// @notice 角色账户计数
    mapping(bytes32 => uint256) private _roleAccountCount;

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
    
    /// @notice Keeper更新事件
    event KeeperUpdated(
        address indexed oldKeeper,
        address indexed newKeeper,
        uint256 timestamp
    );
    
    /// @notice 紧急暂停事件
    event EmergencyPaused(
        address indexed pausedBy,
        string reason,
        uint256 timestamp
    );
    
    /// @notice 紧急恢复事件
    event EmergencyUnpaused(
        address indexed unpausedBy,
        uint256 timestamp
    );

    // =================== 修饰符 ===================
    /**
     * @dev 仅keeper可调用
     */
    modifier onlyKeeper() {
        if (msg.sender != _keeper) {
            revert OnlyKeeperAllowed();
        }
        _;
    }

    /**
     * @dev 仅owner可调用
     */
    modifier onlyOwner() {
        if (msg.sender != _owner) {
            revert MissingRole();
        }
        _;
    }

    /**
     * @dev 检查合约是否暂停
     */
    modifier whenNotPaused() {
        if (_emergencyPaused) {
            revert ContractPaused();
        }
        _;
    }

    /**
     * @dev 验证角色是否为有效角色
     */
    modifier validRole(bytes32 role) {
        if (!_isValidRole(role)) {
            revert InvalidRole();
        }
        _;
    }

    // =================== 构造函数 ===================
    /**
     * @dev 构造函数
     * @param initialKeeper 初始keeper地址
     */
    constructor(address initialKeeper) {
        if (initialKeeper == address(0)) {
            revert InvalidKeeperAddress();
        }
        _keeper = initialKeeper;
        _owner = msg.sender; // 设置部署者为owner
        
        // 初始化角色权限
        _grantRole(ActionKeys.ACTION_GRANT_ROLE, _keeper);
        _grantRole(ActionKeys.ACTION_GRANT_ROLE, msg.sender);
        _grantRole(ActionKeys.ACTION_REVOKE_ROLE, msg.sender);
    }

    // =================== IAccessControlManager 接口实现 ===================
    
    /**
     * @notice 查询 caller 是否具备 role
     */
    function requireRole(bytes32 role, address caller) external view override {
        if (!_roles[role][caller]) {
            revert MissingRole();
        }
    }

    /**
     * @notice 同时不具备 role1 与 role2 中任意角色则 revert
     */
    function hasRole(bytes32 role, address caller) external view override returns (bool) {
        return _roles[role][caller];
    }

    /**
     * @notice 同时不具备 role1 与 role2 中任意角色则 revert
     */
    function requireEitherRole(bytes32 role1, bytes32 role2, address caller) external view {
        if (!_roles[role1][caller] && !_roles[role2][caller]) {
            revert MissingRole();
        }
    }

    // =================== 角色管理 ===================
    
    /**
     * @dev 授予账户角色，仅 owner 可调用
     * @param role 角色哈希
     * @param account 目标账户
     */
    function grantRole(bytes32 role, address account) 
        external 
        onlyOwner 
        validRole(role)
        whenNotPaused
    {
        if (account == address(0)) {
            revert InvalidKeeperAddress();
        }
        
        if (_roles[role][account]) {
            revert RoleAlreadyGranted();
        }
        
        _grantRole(role, account);
        emit RoleGranted(role, account, msg.sender);
    }

    /**
     * @dev 撤销账户角色，仅 owner 可调用
     * @param role 角色哈希
     * @param account 目标账户
     */
    function revokeRole(bytes32 role, address account) 
        external 
        onlyOwner 
        validRole(role)
        whenNotPaused
    {
        if (account == address(0)) {
            revert InvalidKeeperAddress();
        }
        
        if (!_roles[role][account]) {
            revert RoleNotGranted();
        }
        
        _revokeRole(role, account);
        emit RoleRevoked(role, account, msg.sender);
    }

    // =================== Keeper管理 ===================
    /**
     * @dev 设置keeper地址（仅owner可调用）
     * @param newKeeper 新的keeper地址
     */
    function updateKeeper(address newKeeper) external onlyOwner whenNotPaused {
        if (newKeeper == address(0)) {
            revert InvalidKeeperAddress();
        }
        address oldKeeper = _keeper;
        _keeper = newKeeper;
        emit KeeperUpdated(oldKeeper, newKeeper, block.timestamp);
    }

    /**
     * @dev 获取当前keeper地址
     * @return keeper地址
     */
    function getKeeper() external view returns (address) {
        return _keeper;
    }

    // =================== 紧急暂停功能 ===================
    /**
     * @dev 紧急暂停合约（仅owner可调用）
     * @param reason 暂停原因
     */
    function emergencyPause(string calldata reason) external onlyOwner {
        _emergencyPaused = true;
        
        emit EmergencyPaused(msg.sender, reason, block.timestamp);
    }

    /**
     * @dev 恢复合约（仅owner可调用）
     */
    function emergencyUnpause() external onlyOwner {
        _emergencyPaused = false;
        
        emit EmergencyUnpaused(msg.sender, block.timestamp);
    }

    /**
     * @dev 检查合约状态
     * @return 是否紧急暂停
     */
    function getContractStatus() external view returns (bool) {
        return _emergencyPaused;
    }

    // =================== 权限验证 ===================
    /**
     * @dev 验证调用者是否为keeper
     * @param caller 调用者地址
     * @return 是否为keeper
     */
    function isKeeper(address caller) external view returns (bool) {
        return caller == _keeper;
    }

    /**
     * @dev 获取当前owner地址
     * @return owner地址
     */
    function owner() external view returns (address) {
        return _owner;
    }

    /**
     * @dev 验证调用者是否为owner
     * @param caller 调用者地址
     * @return 是否为owner
     */
    function isOwner(address caller) external view returns (bool) {
        return caller == _owner;
    }

    // =================== 视图函数 ===================
    
    /**
     * @dev 获取账户拥有的所有角色
     * @param account 目标账户
     * @return 角色数组
     */
    function getAccountRoles(address account) external view returns (bytes32[] memory) {
        return _accountRoles[account];
    }
    
    /**
     * @dev 获取角色拥有的所有账户
     * @param role 目标角色
     * @return 账户数组
     */
    function getRoleAccounts(bytes32 role) external view returns (address[] memory) {
        return _roleAccounts[role];
    }
    
    /**
     * @dev 获取角色的账户数量
     * @param role 目标角色
     * @return 账户数量
     */
    function getRoleAccountCount(bytes32 role) external view returns (uint256) {
        return _roleAccountCount[role];
    }
    
    /**
     * @dev 检查账户是否拥有指定角色
     * @param account 目标账户
     * @param role 目标角色
     * @return 是否拥有角色
     */
    function hasRoleByAccount(address account, bytes32 role) external view returns (bool) {
        return _roles[role][account];
    }

    // =================== 内部函数 ===================
    
    /**
     * @dev 授予角色的内部实现
     * @param role 角色哈希
     * @param account 目标账户
     */
    function _grantRole(bytes32 role, address account) internal {
        _roles[role][account] = true;
        _accountRoles[account].push(role);
        _roleAccounts[role].push(account);
        _roleAccountCount[role]++;
    }
    
    /**
     * @dev 撤销角色的内部实现
     * @param role 角色哈希
     * @param account 目标账户
     */
    function _revokeRole(bytes32 role, address account) internal {
        _roles[role][account] = false;
        
        // 从账户角色列表中移除
        bytes32[] storage accountRoles = _accountRoles[account];
        for (uint256 i = 0; i < accountRoles.length; i++) {
            if (accountRoles[i] == role) {
                accountRoles[i] = accountRoles[accountRoles.length - 1];
                accountRoles.pop();
                break;
            }
        }
        
        // 从角色账户列表中移除
        address[] storage roleAccounts = _roleAccounts[role];
        for (uint256 i = 0; i < roleAccounts.length; i++) {
            if (roleAccounts[i] == account) {
                roleAccounts[i] = roleAccounts[roleAccounts.length - 1];
                roleAccounts.pop();
                break;
            }
        }
        
        _roleAccountCount[role]--;
    }

    // =================== 缺失的方法实现 ===================
    
    function batchGrantRole(bytes32 /* role */, address[] calldata /* accounts */) external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function batchRevokeRole(bytes32 /* role */, address[] calldata /* accounts */) external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function setUserPermission(address /* user */, IAccessControlManager.PermissionLevel /* level */) external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function setBatchUserPermissions(
        address[] calldata /* users */,
        IAccessControlManager.PermissionLevel[] calldata /* levels */
    ) external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function getUserPermission(address /* user */) external pure returns (IAccessControlManager.PermissionLevel) {
        // 简单实现，仅用于满足接口要求
        return IAccessControlManager.PermissionLevel.NONE;
    }

    function getUserPermissionWithCache(address /* user */) external pure returns (
        IAccessControlManager.PermissionLevel level,
        uint256 timestamp,
        bool isValid
    ) {
        // 简单实现，仅用于满足接口要求
        return (IAccessControlManager.PermissionLevel.NONE, 0, false);
    }

    function checkPermissionWithCache(address /* user */, IAccessControlManager.PermissionLevel /* requiredLevel */) external pure returns (bool) {
        // 简单实现，仅用于满足接口要求
        return false;
    }

    function clearPermissionCache(address /* user */) external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function clearBatchPermissionCache(address[] calldata /* users */) external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function setCacheExpirationTime(uint256 /* newExpirationTime */) external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function initiateEmergencyRecovery(address /* newKeeper */) external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function executeEmergencyRecovery() external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function cancelEmergencyRecovery() external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function setEmergencyRecoveryDelay(uint256 /* delay */) external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function transferOwnership(address /* newOwner */) external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function renounceOwnership() external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function getPermissionHistory(uint256 /* index */) external pure returns (
        address user,
        IAccessControlManager.PermissionLevel oldLevel,
        IAccessControlManager.PermissionLevel newLevel,
        uint256 timestamp
    ) {
        // 简单实现，仅用于满足接口要求
        return (address(0), IAccessControlManager.PermissionLevel.NONE, IAccessControlManager.PermissionLevel.NONE, 0);
    }

    function getPermissionHistoryCount() external pure returns (uint256) {
        // 简单实现，仅用于满足接口要求
        return 0;
    }

    function setMaxHistorySize(uint256 /* newMaxSize */) external pure {
        // 简单实现，仅用于满足接口要求
        revert("Not implemented in core version");
    }

    function totalBatchOperations() external pure returns (uint256) {
        // 简单实现，仅用于满足接口要求
        return 0;
    }

    function totalCachedPermissions() external pure returns (uint256) {
        // 简单实现，仅用于满足接口要求
        return 0;
    }

    function cacheExpirationTime() external pure returns (uint256) {
        // 简单实现，仅用于满足接口要求
        return 0;
    }

    function maxHistorySize() external pure returns (uint256) {
        // 简单实现，仅用于满足接口要求
        return 0;
    }

    function emergencyRecoveryDelay() external pure returns (uint256) {
        // 简单实现，仅用于满足接口要求
        return 0;
    }

    function lastEmergencyRecoveryTime() external pure returns (uint256) {
        // 简单实现，仅用于满足接口要求
        return 0;
    }

    function pendingEmergencyKeeper() external pure returns (address) {
        // 简单实现，仅用于满足接口要求
        return address(0);
    }
    
    /**
     * @dev 检查角色是否为有效角色
     * @param role 待检查的角色
     * @return 是否为有效角色
     */
    function _isValidRole(bytes32 role) internal pure returns (bool) {
        return ActionKeys.isValidActionKey(role);
    }
} 
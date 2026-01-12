// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { 
    ZeroAddress,
    MissingRole
} from "../errors/StandardErrors.sol";

/**
 * @title AccessControlManager - 简化版权限控制中心
 * @dev 提供基础的权限验证功能，实现IAccessControlManager接口
 * @notice 包含角色管理、紧急暂停和基础权限验证
 * @dev 简化架构，移除复杂的多级权限系统和缓存机制
 * @custom:security-contact security@example.com
 */
contract AccessControlManager is IAccessControlManager, ReentrancyGuard {
    // =================== 自定义错误 ===================
    error InvalidKeeperAddress();
    error OnlyKeeperAllowed();
    error ContractPaused();
    error RoleAlreadyGranted();
    error RoleNotGranted();
    error InvalidRole();
    error OnlyOwnerAllowed();
    
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
     * @dev 仅owner可调用
     */
    modifier onlyOwner() {
        if (msg.sender != _owner) revert OnlyOwnerAllowed();
        _;
    }
    
    /**
     * @dev 仅keeper可调用
     */
    modifier onlyKeeper() {
        if (msg.sender != _keeper) revert OnlyKeeperAllowed();
        _;
    }
    
    /**
     * @dev 检查合约是否暂停
     */
    modifier whenNotPaused() {
        if (_emergencyPaused) revert ContractPaused();
        _;
    }
    
    /**
     * @dev 检查角色权限
     */
    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) revert MissingRole();
        _;
    }

    // =================== 构造函数 ===================
    /**
     * @dev 构造函数，设置初始owner
     * @param initialOwner 初始owner地址
     */
    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        
        _owner = initialOwner;
        _keeper = initialOwner; // 初始时owner也是keeper
        
        // 为owner授予所有基础角色
        _grantRole(ActionKeys.ACTION_SET_PARAMETER, initialOwner);
        _grantRole(ActionKeys.ACTION_UPGRADE_MODULE, initialOwner);
        _grantRole(ActionKeys.ACTION_PAUSE_SYSTEM, initialOwner);
    }

    // =================== 基础权限验证 ===================
    
    /**
     * @dev 检查用户是否拥有指定角色
     * @param role 角色标识符
     * @param user 用户地址
     * @return 是否拥有角色
     */
    function hasRole(bytes32 role, address user) external view override returns (bool) {
        return _roles[role][user];
    }
    
    /**
     * @notice 获取用户的综合权限级别
     * @dev 根据账户所拥有的角色动态推断权限级别，优先级从高到低：ADMIN → OPERATOR → VIEWER → NONE
     * @param user 用户地址
     * @return level 权限级别枚举
     */
    function getUserPermission(address user) external view override returns (PermissionLevel level) {
        if (user == address(0)) {
            return PermissionLevel.NONE;
        }

        // 最高权限：管理员
        if (_roles[ActionKeys.ACTION_ADMIN][user]) {
            return PermissionLevel.ADMIN;
        }

        // 次级权限：可执行运营级别操作
        if (
            _roles[ActionKeys.ACTION_SET_PARAMETER][user] ||
            _roles[ActionKeys.ACTION_UPGRADE_MODULE][user] ||
            _roles[ActionKeys.ACTION_PAUSE_SYSTEM][user] ||
            _roles[ActionKeys.ACTION_UNPAUSE_SYSTEM][user]
        ) {
            return PermissionLevel.OPERATOR;
        }

        // 基础查看权限
        if (
            _roles[ActionKeys.ACTION_VIEW_SYSTEM_DATA][user] ||
            _roles[ActionKeys.ACTION_VIEW_USER_DATA][user] ||
            _roles[ActionKeys.ACTION_VIEW_DEGRADATION_DATA][user] ||
            _roles[ActionKeys.ACTION_VIEW_CACHE_DATA][user]
        ) {
            return PermissionLevel.VIEWER;
        }

        return PermissionLevel.NONE;
    }
    
    /**
     * @dev 要求用户拥有指定角色，否则回滚
     * @param role 角色标识符
     * @param caller 调用者地址
     */
    function requireRole(bytes32 role, address caller) external view override {
        if (!_roles[role][caller]) {
            revert MissingRole();
        }
    }
    


    // =================== 角色管理 ===================
    
    /**
     * @dev 授予角色给指定账户
     * @param role 角色标识符
     * @param account 账户地址
     */
    function grantRole(bytes32 role, address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (role == bytes32(0)) revert InvalidRole();
        
        if (_roles[role][account]) {
            revert RoleAlreadyGranted();
        }
        
        _grantRole(role, account);
    }
    
    /**
     * @dev 撤销指定账户的角色
     * @param role 角色标识符
     * @param account 账户地址
     */
    function revokeRole(bytes32 role, address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (role == bytes32(0)) revert InvalidRole();
        
        if (!_roles[role][account]) {
            revert RoleNotGranted();
        }
        
        _revokeRole(role, account);
    }
    
    /**
     * @dev 内部授予角色函数
     * @param role 角色标识符
     * @param account 账户地址
     */
    function _grantRole(bytes32 role, address account) private {
        _roles[role][account] = true;
        _accountRoles[account].push(role);
        _roleAccounts[role].push(account);
        _roleAccountCount[role]++;
        
        emit RoleGranted(role, account, msg.sender);
    }
    
    /**
     * @dev 内部撤销角色函数
     * @param role 角色标识符
     * @param account 账户地址
     */
    function _revokeRole(bytes32 role, address account) private {
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
        
        emit RoleRevoked(role, account, msg.sender);
    }

    // =================== Keeper管理 ===================
    
    /**
     * @dev 更新keeper地址
     * @param newKeeper 新的keeper地址
     */
    function updateKeeper(address newKeeper) external onlyOwner {
        if (newKeeper == address(0)) revert ZeroAddress();
        if (newKeeper == _keeper) revert InvalidKeeperAddress();
        
        address oldKeeper = _keeper;
        _keeper = newKeeper;
        
        emit KeeperUpdated(oldKeeper, newKeeper, block.timestamp);
    }

    // =================== 紧急暂停 ===================
    
    /**
     * @dev 紧急暂停合约
     * @param reason 暂停原因
     */
    function emergencyPause(string calldata reason) external onlyOwner {
        if (_emergencyPaused) revert ContractPaused();
        
        _emergencyPaused = true;
        
        emit EmergencyPaused(msg.sender, reason, block.timestamp);
    }
    
    /**
     * @dev 恢复合约运行
     */
    function emergencyUnpause() external onlyOwner {
        if (!_emergencyPaused) revert ContractPaused();
        _emergencyPaused = false;
        
        emit EmergencyUnpaused(msg.sender, block.timestamp);
    }

    // =================== 查询功能 ===================
    
    /**
     * @dev 获取账户的所有角色
     * @param account 账户地址
     * @return 角色列表
     */
    function getAccountRoles(address account) external view returns (bytes32[] memory) {
        return _accountRoles[account];
    }
    
    /**
     * @dev 获取角色的所有账户
     * @param role 角色标识符
     * @return 账户列表
     */
    function getRoleAccounts(bytes32 role) external view returns (address[] memory) {
        return _roleAccounts[role];
    }
    
    /**
     * @dev 获取角色的账户数量
     * @param role 角色标识符
     * @return 账户数量
     */
    function getRoleAccountCount(bytes32 role) external view returns (uint256) {
        return _roleAccountCount[role];
    }
    
    /**
     * @dev 获取owner地址
     * @return owner地址
     */
    function owner() external view returns (address) {
        return _owner;
    }
    
    /**
     * @notice 获取合约暂停状态（兼容旧接口）
     * @return paused 当前是否暂停
     */
    function getContractStatus() external view override returns (bool paused) {
        return _emergencyPaused;
    }
} 
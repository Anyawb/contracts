// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { MissingRole } from "../errors/StandardErrors.sol";

/// @title MockAccessControlManager
/// @notice 仅用于测试环境的轻量级角色管理器，实现 IAccessControlManager 接口。
/// @dev 不包含访问控制自身的权限控制，任何人都可授予/撤销角色，切勿用于生产。
contract MockAccessControlManager is IAccessControlManager {
    mapping(bytes32 => mapping(address => bool)) private _roles;

    /// @notice 当账户被授予角色时触发。
    /// @param role 角色标识符
    /// @param account 被授予角色的账户地址
    event RoleGranted(bytes32 indexed role, address indexed account);
    /// @notice 当账户的角色被撤销时触发。
    /// @param role 角色标识符
    /// @param account 被撤销角色的账户地址
    event RoleRevoked(bytes32 indexed role, address indexed account);

    /// @notice 授予账户指定角色（仅测试环境，默认对任何调用者开放）。
    /// @param role 角色标识符
    /// @param account 目标账户地址
    function grantRole(bytes32 role, address account) external {
        _roles[role][account] = true;
        emit RoleGranted(role, account);
    }

    /// @notice 撤销账户的指定角色（仅测试环境）。
    /// @param role 角色标识符
    /// @param account 目标账户地址
    function revokeRole(bytes32 role, address account) external {
        _roles[role][account] = false;
        emit RoleRevoked(role, account);
    }

    /// @notice 强制要求调用者拥有某角色，否则 revert。
    /// @param role 角色标识符
    /// @param caller 调用者地址
    function requireRole(bytes32 role, address caller) external view override {
        if (!_roles[role][caller]) revert MissingRole();
    }

    /// @notice 检查调用者是否拥有某角色。
    /// @param role 角色标识符
    /// @param caller 调用者地址
    /// @return 是否拥有角色
    function hasRole(bytes32 role, address caller) external view override returns (bool) {
        return _roles[role][caller];
    }

    /// @notice 若调用者同时不具备 role1 与 role2 中任意角色则 revert。
    /// @param role1 角色 1
    /// @param role2 角色 2
    /// @param caller 调用者地址
    function requireEitherRole(bytes32 role1, bytes32 role2, address caller) external view {
        if (!_roles[role1][caller] && !_roles[role2][caller]) {
            revert MissingRole();
        }
    }

    // =================== 缺失的方法实现 ===================
    
    function batchGrantRole(bytes32 role, address[] calldata accounts) external {
        for (uint256 i = 0; i < accounts.length; i++) {
            _roles[role][accounts[i]] = true;
            emit RoleGranted(role, accounts[i]);
        }
    }

    function batchRevokeRole(bytes32 role, address[] calldata accounts) external {
        for (uint256 i = 0; i < accounts.length; i++) {
            _roles[role][accounts[i]] = false;
            emit RoleRevoked(role, accounts[i]);
        }
    }

    function setUserPermission(address user, IAccessControlManager.PermissionLevel level) external {
        // Mock实现，不存储权限级别
    }

    function setBatchUserPermissions(
        address[] calldata users,
        IAccessControlManager.PermissionLevel[] calldata levels
    ) external {
        // Mock实现，不存储权限级别
    }

    function getUserPermission(address /* user */) external pure override returns (IAccessControlManager.PermissionLevel) {
        return IAccessControlManager.PermissionLevel.NONE;
    }

    function getUserPermissionWithCache(address /* user */) external pure returns (
        IAccessControlManager.PermissionLevel level,
        uint256 timestamp,
        bool isValid
    ) {
        return (IAccessControlManager.PermissionLevel.NONE, 0, false);
    }

    function checkPermissionWithCache(address /* user */, IAccessControlManager.PermissionLevel /* requiredLevel */) external pure returns (bool) {
        return false;
    }

    function clearPermissionCache(address user) external {
        // Mock实现，无缓存
    }

    function clearBatchPermissionCache(address[] calldata users) external {
        // Mock实现，无缓存
    }

    function setCacheExpirationTime(uint256 newExpirationTime) external {
        // Mock实现，无缓存
    }

    function updateKeeper(address _keeper) external {
        // Mock实现，不存储keeper
    }

    function getKeeper() external pure returns (address) {
        return address(0);
    }

    function isKeeper(address /* caller */) external pure returns (bool) {
        return false;
    }

    function emergencyPause(string calldata reason) external override {
        // Mock实现，不暂停
    }

    function emergencyUnpause() external override {
        // Mock实现，不恢复
    }

    function getContractStatus() external pure override returns (bool) {
        return false;
    }

    function initiateEmergencyRecovery(address newKeeper) external {
        // Mock实现，不执行紧急恢复
    }

    function executeEmergencyRecovery() external {
        // Mock实现，不执行紧急恢复
    }

    function cancelEmergencyRecovery() external {
        // Mock实现，不执行紧急恢复
    }

    function setEmergencyRecoveryDelay(uint256 delay) external {
        // Mock实现，不设置延迟
    }

    function transferOwnership(address newOwner) external {
        // Mock实现，不转移所有权
    }

    function renounceOwnership() external {
        // Mock实现，不放弃所有权
    }

    function owner() external pure override returns (address) {
        return address(0);
    }

    function isOwner(address /* caller */) external pure returns (bool) {
        return false;
    }

    function getPermissionHistory(uint256 /* index */) external pure returns (
        address user,
        IAccessControlManager.PermissionLevel oldLevel,
        IAccessControlManager.PermissionLevel newLevel,
        uint256 timestamp
    ) {
        return (address(0), IAccessControlManager.PermissionLevel.NONE, IAccessControlManager.PermissionLevel.NONE, 0);
    }

    function getPermissionHistoryCount() external pure returns (uint256) {
        return 0;
    }

    function setMaxHistorySize(uint256 newMaxSize) external {
        // Mock实现，不设置历史大小
    }

    function getAccountRoles(address /* account */) external pure override returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    function getRoleAccounts(bytes32 /* role */) external pure override returns (address[] memory) {
        return new address[](0);
    }

    function getRoleAccountCount(bytes32 /* role */) external pure override returns (uint256) {
        return 0;
    }

    function hasRoleByAccount(address account, bytes32 role) external view returns (bool) {
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
} 
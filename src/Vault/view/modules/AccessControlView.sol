// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";

/// @title AccessControlView
/// @notice 权限视图缓存模块：缓存用户权限位和权限级别，供前端 0 gas 查询
/// @dev 权限数据由链上 AccessControlManager 推送；本模块仅做缓存写入与只读查询
contract AccessControlView is Initializable, UUPSUpgradeable {
    // =========================  Events  =========================

    /// @notice 单个权限位更新事件
    event PermissionDataUpdated(address indexed user, bytes32 indexed actionKey, bool hasPermission, uint256 timestamp);

    /// @notice 用户权限级别更新事件
    event PermissionLevelUpdated(address indexed user, IAccessControlManager.PermissionLevel newLevel, uint256 timestamp);

    // =========================  Errors  =========================

    error AccessControlView__ZeroAddress();
    error AccessControlView__Unauthorized();

    // =========================  Storage  =========================

    /// @notice Registry 合约地址（仅内部使用）
    address private _registryAddr;

    /// @dev 用户权限位缓存：user => actionKey => bool
    mapping(address => mapping(bytes32 => bool)) private _userPermissionsCache;

    /// @dev 用户权限级别缓存
    mapping(address => IAccessControlManager.PermissionLevel) private _userPermissionLevelCache;

    /// @dev 最后缓存更新时间戳
    mapping(address => uint256) private _cacheTimestamps;

    uint256 private constant CACHE_DURATION = ViewConstants.CACHE_DURATION;

    /// @notice DataPush 类型常量（供链下索引服务读取）
    bytes32 public constant DATA_TYPE_PERMISSION_BIT_UPDATE   = keccak256("PERMISSION_BIT_UPDATE");
    bytes32 public constant DATA_TYPE_PERMISSION_LEVEL_UPDATE = keccak256("PERMISSION_LEVEL_UPDATE");

    // =========================  Access helpers  =========================

    function _getUserPermission(address user) internal view returns (IAccessControlManager.PermissionLevel) {
        return IAccessControlManager(_getACM()).getUserPermission(user);
    }

    /// @dev 仅当调用者是目标用户或具备 ADMIN 权限时放行
    modifier onlyAuthorizedFor(address targetUser) {
        IAccessControlManager.PermissionLevel level = _getUserPermission(msg.sender);
        if (level < IAccessControlManager.PermissionLevel.ADMIN && msg.sender != targetUser) {
            revert AccessControlView__Unauthorized();
        }
        _;
    }

    // =========================  Modifiers  =========================

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert AccessControlView__ZeroAddress();
        _;
    }

    /// @dev 仅允许 AccessControlManager 模块调用
    modifier onlyACM() {
        require(msg.sender == _getACM(), "AccessControlView: caller is not ACM");
        _;
    }

    // =========================  Initialiser  =========================

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert AccessControlView__ZeroAddress();

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // =========================  Push APIs  =========================

    /// @notice 推送单个权限位更新（由 ACM 在角色变更后调用）
    function pushPermissionUpdate(address user, bytes32 actionKey, bool hasPermission) external onlyValidRegistry onlyACM {
        _userPermissionsCache[user][actionKey] = hasPermission;
        _cacheTimestamps[user] = block.timestamp;
        emit PermissionDataUpdated(user, actionKey, hasPermission, block.timestamp);
        // 统一 DataPush（链下消费）
        DataPushLibrary._emitData(DATA_TYPE_PERMISSION_BIT_UPDATE, abi.encode(user, actionKey, hasPermission));
    }

    /// @notice 推送权限级别更新
    function pushPermissionLevelUpdate(address user, IAccessControlManager.PermissionLevel newLevel) external onlyValidRegistry onlyACM {
        _userPermissionLevelCache[user] = newLevel;
        _cacheTimestamps[user] = block.timestamp;
        emit PermissionLevelUpdated(user, newLevel, block.timestamp);
        // 统一 DataPush（链下消费）
        DataPushLibrary._emitData(DATA_TYPE_PERMISSION_LEVEL_UPDATE, abi.encode(user, newLevel));
    }

    // =========================  Read APIs  =========================

    /// @notice 查询用户是否拥有某权限位
    function getUserPermission(address user, bytes32 actionKey) external view onlyValidRegistry onlyAuthorizedFor(user) returns (bool hasPermission, bool isValid) {
        hasPermission = _userPermissionsCache[user][actionKey];
        isValid       = _isCacheValid(_cacheTimestamps[user]);
    }

    /// @notice 查询用户是否为管理员
    function isUserAdmin(address user) external view onlyValidRegistry onlyAuthorizedFor(user) returns (bool isAdmin, bool isValid) {
        isAdmin = _userPermissionsCache[user][ActionKeys.ACTION_ADMIN];
        isValid = _isCacheValid(_cacheTimestamps[user]);
    }

    /// @notice 查询用户权限级别
    function getUserPermissionLevel(address user) external view onlyValidRegistry onlyAuthorizedFor(user) returns (IAccessControlManager.PermissionLevel level, bool isValid) {
        level   = _userPermissionLevelCache[user];
        isValid = _isCacheValid(_cacheTimestamps[user]);
    }

    // =========================  Internal helpers  =========================

    function _getACM() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
    }

    function _isCacheValid(uint256 timestamp) internal view returns (bool) {
        return timestamp > 0 && block.timestamp - timestamp <= CACHE_DURATION;
    }

    // =========================  UUPS upgradeability  =========================

    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        // 仅 ADMIN 允许升级
        IAccessControlManager(_getACM()).requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert AccessControlView__ZeroAddress();
    }

    /// @notice 兼容旧版 getter
    function registryAddr() external view returns(address){ return _registryAddr; }
} 
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { IAuthorityWhitelist } from "./interfaces/IAuthorityWhitelist.sol";
import { IAccessControlManager } from "./interfaces/IAccessControlManager.sol";
import { ActionKeys } from "./constants/ActionKeys.sol";
import { ModuleKeys } from "./constants/ModuleKeys.sol";
import { VaultTypes } from "./Vault/VaultTypes.sol";
import { ZeroAddress } from "./errors/StandardErrors.sol";
import { Registry } from "./registry/Registry.sol";

// ======== Custom Errors ========
error AuthorityWhitelist__AuthorityNotExisted(); // E001
error AuthorityWhitelist__AlreadyExists(); // E002

/// @title AuthorityWhitelist
/// @notice 管理权威认证机构白名单，供 Vault 等模块验证
/// @dev 使用ACM进行权限控制，确保系统安全性
/// @dev 支持Registry升级事件监听，实现模块化架构
/// @custom:security-contact security@example.com
contract AuthorityWhitelist is Initializable, UUPSUpgradeable, IAuthorityWhitelist {
    // 使用 bytes32 存储字符串哈希，节省 gas 且避免动态 key 复杂性
    mapping(bytes32 => bool) private _whitelist;

    /// @notice Registry合约地址
    address private _registryAddr;

    /* ============ Modifiers ============ */
    /// @notice 验证Registry地址有效性
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    event AuthorityAdded(string name, address indexed operator);
    event AuthorityRemoved(string name, address indexed operator);

    /// @dev 禁用实现合约的初始化器
    constructor() {
        _disableInitializers();
    }

    /* ============ Initializer ============ */
    /// @notice 初始化权威认证机构白名单合约
    /// @param initialRegistryAddr Registry合约地址
    /// @dev 使用 StandardErrors 进行错误处理
    function initialize(address initialRegistryAddr) external initializer {
        __UUPSUpgradeable_init();
        
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        _registryAddr = initialRegistryAddr;
        
        // 预置常用机构
        _add("Moody's");
        _add("Standard Chartered");
        _add("S&P Global");
        _add("Fitch Ratings");
        
        // 记录初始化动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ External Admin ============ */

    /// @notice 向白名单新增认证机构
    /// @param name 机构名称（区分大小写）
    function addAuthority(string calldata name) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
        _add(name);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_ADD_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_ADD_WHITELIST),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 从白名单移除认证机构
    /// @param name 机构名称（区分大小写）
    function removeAuthority(string calldata name) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_REMOVE_WHITELIST, msg.sender);
        bytes32 key = keccak256(bytes(name));
        if (!_whitelist[key]) revert AuthorityWhitelist__AuthorityNotExisted();
        _whitelist[key] = false;
        emit AuthorityRemoved(name, msg.sender);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_REMOVE_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REMOVE_WHITELIST),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ View ============ */

    /// @notice 查询某机构是否在白名单内
    /// @param name 机构名称
    /// @return existed 是否存在
    function check(string calldata name) external view override onlyValidRegistry returns (bool) {
        return _whitelist[keccak256(bytes(name))];
    }

    /// @notice 获取Registry地址（仅管理员）
    /// @return Registry合约地址
    function getRegistry() external view onlyValidRegistry returns (address) {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        return _registryAddr;
    }

    /// @notice 更新Registry地址
    /// @param newRegistryAddr 新的Registry地址
    /// @dev Registry地址不能为零地址
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
        
        // 发出模块地址更新事件
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_REGISTRY),
            oldRegistry,
            newRegistryAddr,
            block.timestamp
        );
    }

    /* ============ Internal Functions ============ */
    
    /// @notice 内部权限验证函数
    /// @param actionKey 动作标识符
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    function _add(string memory name) internal {
        bytes32 key = keccak256(bytes(name));
        if (_whitelist[key]) revert AuthorityWhitelist__AlreadyExists();
        _whitelist[key] = true;
        emit AuthorityAdded(name, msg.sender);
    }

    /* ============ Upgrade Functions ============ */
    
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // 记录升级动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ Storage Gap ============ */
    
    /// @dev 为可升级合约预留存储空间
    uint256[50] private __gap;
} 
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { 
    ZeroAddress, 
    MinDelayTooLarge, 
    PausedSystem, 
    InvalidPendingAdmin, 
    NotPendingAdmin,
    ArrayLengthMismatch,
    ModuleCapExceeded,
    MinDelayOverflow,
    NotGovernance,
    NotAContract
} from "../errors/StandardErrors.sol";
import { RegistryStorage } from "./RegistryStorageLibrary.sol";
import { RegistryEvents } from "./RegistryEventsLibrary.sol";

/// @title RegistryCore
/// @notice 核心模块地址注册功能
/// @dev 提供基础的模块地址存储和查询功能
/// @dev 使用 RegistryStorage 进行存储管理，支持可升级合约
contract RegistryCore is 
    Initializable, 
    OwnableUpgradeable,
    UUPSUpgradeable
{
    /// @dev 模块已存在但不允许替换
    error RegistryCore__ModuleAlreadyExists(bytes32 key, address existing);
    // ============ Constants ============
    uint256 private constant MAX_DELAY = 7 days;
    uint256 private constant MAX_BATCH_MODULES = 20;

    // ============ Constructor ============
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    /// @notice 初始化 Registry 核心功能
    /// @param admin_ 治理地址
    /// @param minDelay_ 最小延迟时间
    /// @dev 使用统一的初始化函数，确保所有关键字段正确设置
    function initialize(address admin_, uint256 minDelay_) external initializer {
        if (admin_ == address(0)) revert ZeroAddress();
        if (minDelay_ > MAX_DELAY) revert MinDelayTooLarge(minDelay_, MAX_DELAY);
        
        // Registry 家族：owner 仅用于升级/紧急治理；这里将 owner 与 admin 绑定，避免口径分叉。
        __Ownable_init(admin_);
        __UUPSUpgradeable_init();
        
        // 使用统一的存储初始化函数
        RegistryStorage.initializeRegistryStorage(admin_, minDelay_);
        
        // 触发初始化事件，避免与紧急升级混淆
        emit RegistryEvents.RegistryInitialized(
            admin_,
            minDelay_,
            msg.sender
        );
    }

    // ============ UUPS Upgrade Authorization ============
    /// @notice 升级授权函数
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
        
        emit RegistryEvents.EmergencyActionExecuted(
            uint8(RegistryEvents.EmergencyAction.EMERGENCY_UPGRADE),
            msg.sender,
            block.timestamp
        );
    }

    // ============ Core Functions ============
    /// @notice 读取模块地址（若未设置返回 0 地址）
    /// @param key 模块键名
    /// @return 模块地址
    function getModule(bytes32 key) external view returns (address) {
        return RegistryStorage.layout().modules[key];
    }

    /// @notice 读取模块地址，若未注册则回滚
    /// @param key 模块键名
    /// @return 模块地址
    function getModuleOrRevert(bytes32 key) external view returns (address) {
        address addr = RegistryStorage.layout().modules[key];
        if (addr == address(0)) revert ZeroAddress();
        return addr;
    }

    /// @notice 检查模块是否已注册
    /// @param key 模块键名
    /// @return 是否已注册
    function isModuleRegistered(bytes32 key) external view returns (bool) {
        return RegistryStorage.layout().modules[key] != address(0);
    }

    /// @notice 获取当前延时窗口
    /// @return 最小延迟时间
    function minDelay() external view returns (uint256) {
        return RegistryStorage.getMinDelay();
    }

    // ============ 治理相关函数 ============
    /// @notice 获取主治理地址
    /// @return 治理地址
    function getAdmin() external view returns (address) {
        return RegistryStorage.getAdmin();
    }

    /// @notice 获取待接管地址
    /// @return 待接管地址
    function getPendingAdmin() external view returns (address) {
        return RegistryStorage.layout().pendingAdmin;
    }

    /// @notice 检查是否已暂停
    /// @return 是否已暂停
    function isPaused() external view returns (bool) {
        return RegistryStorage.isPaused();
    }

    /// @notice 检查调用者是否为治理地址
    /// @param addr 待检查地址
    /// @return 是否为治理地址
    function isAdmin(address addr) external view returns (bool) {
        return RegistryStorage.isAdmin(addr);
    }

    /// @notice 要求调用者为治理地址
    /// @dev 内部函数，用于权限验证
    /// @notice 要求当前调用者为治理地址，否则revert
    /// @dev 内部函数，用于权限验证
    function requireAdminMsgSender() internal view {
        if (!RegistryStorage.isAdmin(msg.sender)) revert NotGovernance();
    }

    // ============ Ownable ↔ RegistryStorage admin 一致性 ============
    /// @notice Transfer ownership (syncs RegistryStorage.admin/pendingAdmin).
    /// @dev Keeps RegistryStorage.admin consistent with Ownable owner.
    function transferOwnership(address newOwner) public override onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (newOwner == address(0)) revert ZeroAddress();
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        address oldAdmin = owner();
        address oldPending = l.pendingAdmin;

        super.transferOwnership(newOwner);
        l.admin = newOwner;

        if (oldPending != address(0)) {
            l.pendingAdmin = address(0);
            emit RegistryEvents.PendingAdminChanged(oldPending, address(0));
        }
        emit RegistryEvents.AdminChanged(oldAdmin, newOwner);
    }

    /// @notice Renounce ownership (syncs RegistryStorage.admin/pendingAdmin).
    function renounceOwnership() public override onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        address oldAdmin = owner();
        address oldPending = l.pendingAdmin;

        super.renounceOwnership();
        l.admin = address(0);

        if (oldPending != address(0)) {
            l.pendingAdmin = address(0);
            emit RegistryEvents.PendingAdminChanged(oldPending, address(0));
        }
        emit RegistryEvents.AdminChanged(oldAdmin, address(0));
    }

    // ============ 存储管理函数 ============
    /// @notice 验证存储布局完整性
    /// @dev 用于升级时验证存储布局是否正确
    function validateStorageLayout() external view {
        RegistryStorage.validateStorageLayout();
    }

    /// @notice 获取当前存储版本
    /// @return 存储版本
    function getStorageVersion() external view returns (uint256) {
        return RegistryStorage.getStorageVersion();
    }

    /// @notice 检查是否已初始化
    /// @return 是否已初始化
    function isInitialized() external view returns (bool) {
        return RegistryStorage.isInitialized();
    }

    // ============ 升级管理函数 ============
    /// @notice 升级存储版本（仅治理地址可调用）
    /// @param newVersion 新的存储版本
    function upgradeStorageVersion(uint256 newVersion) external {
        requireAdminMsgSender();
        if (RegistryStorage.isPaused()) revert PausedSystem();
        
        uint256 oldVersion = RegistryStorage.getStorageVersion();
        RegistryStorage.upgradeStorageVersion(newVersion);
        emit RegistryEvents.StorageVersionUpgraded(oldVersion, newVersion);
    }

    // ============ 紧急操作函数 ============
    /// @notice 暂停系统（仅治理地址可调用）
    function pause() external {
        requireAdminMsgSender();
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.layout().paused = 1; // uint8 1 = true
        
        emit RegistryEvents.Paused(msg.sender);
    }

    /// @notice 恢复系统（仅治理地址可调用）
    function unpause() external {
        requireAdminMsgSender();
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.layout().paused = 0; // uint8 0 = false
        
        emit RegistryEvents.Unpaused(msg.sender);
    }

    // ============ 治理地址管理 ============
    /// @notice 设置待接管地址（仅当前治理地址可调用）
    /// @param newPendingAdmin 新的待接管地址
    function setPendingAdmin(address newPendingAdmin) external {
        requireAdminMsgSender();
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (RegistryStorage.isPaused()) revert PausedSystem();
        if (newPendingAdmin == address(0)) revert InvalidPendingAdmin(newPendingAdmin);
        
        address oldPendingAdmin = RegistryStorage.layout().pendingAdmin;
        RegistryStorage.layout().pendingAdmin = newPendingAdmin;
        
        // 触发待接管地址变更事件
        emit RegistryEvents.PendingAdminChanged(oldPendingAdmin, newPendingAdmin);
    }

    /// @notice 接受治理权限（仅待接管地址可调用）
    /// @dev 此函数不检查 pause 状态，因为 admin 变更可能是救急操作
    /// @dev 在系统暂停时，admin 变更可能是恢复系统的必要步骤
    function acceptAdmin() external {
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        if (msg.sender != l.pendingAdmin) revert NotPendingAdmin(msg.sender, l.pendingAdmin);
        
        address oldAdmin = l.admin;
        address oldPending = l.pendingAdmin;
        // 同步 Ownable.owner() 与 storage admin，避免升级权限与治理口径分叉
        _transferOwnership(msg.sender);
        l.admin = msg.sender;
        l.pendingAdmin = address(0);
        
        emit RegistryEvents.PendingAdminChanged(oldPending, address(0));
        emit RegistryEvents.AdminChanged(oldAdmin, l.admin);
    }

    // ============ 模块管理 ============
    /// @notice 设置模块地址（仅治理地址可调用，兼容 IRegistry 接口）
    /// @param key 模块键名
    /// @param moduleAddress 模块地址
    function setModule(bytes32 key, address moduleAddress) external {
        _setModule(key, moduleAddress);
    }

    /// @notice 设置模块地址（仅治理地址可调用，返回变更状态）
    /// @param key 模块键名
    /// @param moduleAddress 模块地址
    /// @return changed 是否实际发生了变更
    function setModuleWithStatus(bytes32 key, address moduleAddress) external returns (bool changed) {
        return _setModule(key, moduleAddress);
    }

    /// @notice 设置模块地址（支持allowReplace参数）
    /// @param key 模块键名
    /// @param moduleAddress 模块地址
    /// @param allowReplace 是否允许替换现有模块
    function setModuleWithReplaceFlag(bytes32 key, address moduleAddress, bool allowReplace) external {
        _setModuleWithReplaceFlag(key, moduleAddress, allowReplace);
    }

    /// @notice 内部设置模块地址函数
    /// @param key 模块键名
    /// @param moduleAddress 模块地址
    /// @return changed 是否实际发生了变更
    function _setModule(bytes32 key, address moduleAddress) internal returns (bool changed) {
        requireAdminMsgSender();
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (RegistryStorage.isPaused()) revert PausedSystem();
        if (moduleAddress == address(0)) revert ZeroAddress();
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        address oldAddress = l.modules[key];
        
        // 防止设置同样地址（幂等行为）
        if (oldAddress == moduleAddress) {
            return false;
        }
        
        l.modules[key] = moduleAddress;
        
        // 触发模块变更事件
        emit RegistryEvents.ModuleChanged(key, oldAddress, moduleAddress);
        return true;
    }

    /// @notice 内部设置模块地址函数（支持allowReplace参数）
    /// @param key 模块键名
    /// @param moduleAddress 模块地址
    /// @param allowReplace 是否允许替换现有模块
    function _setModuleWithReplaceFlag(bytes32 key, address moduleAddress, bool allowReplace) internal {
        requireAdminMsgSender();
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (RegistryStorage.isPaused()) revert PausedSystem();
        if (moduleAddress == address(0)) revert ZeroAddress();
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        address oldAddress = l.modules[key];
        
        // 如果不允许替换且模块已存在，则回滚
        if (!allowReplace && oldAddress != address(0)) {
            revert RegistryCore__ModuleAlreadyExists(key, oldAddress);
        }
        
        // 防止设置同样地址（幂等行为）
        if (oldAddress == moduleAddress) {
            return;
        }
        
        l.modules[key] = moduleAddress;
        
        // 触发模块变更事件
        emit RegistryEvents.ModuleChanged(key, oldAddress, moduleAddress);
    }

    /// @notice 批量设置模块地址（仅治理地址可调用，默认不触发单个事件以节省 gas）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    function setModules(bytes32[] calldata keys, address[] calldata addresses) external {
        _setModules(keys, addresses, false);
    }

    /// @notice 批量设置模块地址（仅治理地址可调用，返回变更状态）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @return changedCount 实际发生变更的模块数量
    /// @return changedKeys 发生变更的模块键名数组
    function setModulesWithStatus(bytes32[] calldata keys, address[] calldata addresses) external 
        returns (uint256 changedCount, bytes32[] memory changedKeys) {
        return _setModulesWithStatus(keys, addresses, false);
    }

    /// @notice 批量设置模块地址（仅治理地址可调用）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @param emitIndividualEvents 是否同时触发单个模块变更事件（默认 false 以节省 gas）
    function setModulesWithEvents(bytes32[] calldata keys, address[] calldata addresses, bool emitIndividualEvents) external {
        _setModules(keys, addresses, emitIndividualEvents);
    }

    /// @notice 内部批量设置模块地址函数
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @param emitIndividualEvents 是否同时触发单个模块变更事件
    function _setModules(bytes32[] calldata keys, address[] calldata addresses, bool emitIndividualEvents) internal {
        _setModulesWithStatus(keys, addresses, emitIndividualEvents);
        // 这里不需要返回 changedCount，因为调用者不关心
    }

    /// @notice 内部批量设置模块地址函数（返回变更状态）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @param emitIndividualEvents 是否同时触发单个模块变更事件
    /// @return changedCount 实际发生变更的模块数量
    /// @return changedKeys 发生变更的模块键名数组
    function _setModulesWithStatus(bytes32[] calldata keys, address[] calldata addresses, bool emitIndividualEvents) internal 
        returns (uint256 changedCount, bytes32[] memory changedKeys) {
        requireAdminMsgSender();
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (RegistryStorage.isPaused()) revert PausedSystem();
        if (keys.length != addresses.length) revert ArrayLengthMismatch(keys.length, addresses.length);
        if (keys.length > MAX_BATCH_MODULES) revert ModuleCapExceeded(keys.length, MAX_BATCH_MODULES);
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        uint256 len = keys.length;
        changedKeys = new bytes32[](len);
        address[] memory oldAddresses = new address[](len);
        address[] memory newAddresses = new address[](len);
        changedCount = 0;
        
        for (uint256 i = 0; i < len; ) {
            bytes32 k = keys[i];
            address newAddr = addresses[i];
            if (newAddr == address(0)) revert ZeroAddress();
            
            address oldAddr = l.modules[k];
            if (oldAddr != newAddr) {
                l.modules[k] = newAddr;
                changedKeys[changedCount] = k;
                oldAddresses[changedCount] = oldAddr;
                newAddresses[changedCount] = newAddr;
                unchecked { ++changedCount; }
                if (emitIndividualEvents) {
                    emit RegistryEvents.ModuleChanged(k, oldAddr, newAddr);
                }
            }
            unchecked { ++i; }
        }
        
        // 收缩数组长度以匹配实际变更数量
        assembly {
            mstore(changedKeys, changedCount)
            mstore(oldAddresses, changedCount)
            mstore(newAddresses, changedCount)
        }
        
        // 仅当未发单个事件时，才发批量事件，避免重复
        if (changedCount > 0 && !emitIndividualEvents) {
            emit RegistryEvents.BatchModuleChanged(
                changedKeys,
                oldAddresses,
                newAddresses,
                msg.sender
            );
        }
    }

    // ============ 配置管理 ============
    /// @notice 设置最小延迟（仅治理地址可调用）
    /// @param newMinDelay 新的最小延迟
    function setMinDelay(uint256 newMinDelay) external {
        requireAdminMsgSender();
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (RegistryStorage.isPaused()) revert PausedSystem();
        if (newMinDelay > MAX_DELAY) revert MinDelayTooLarge(newMinDelay, MAX_DELAY);
        if (newMinDelay > type(uint64).max) revert MinDelayOverflow(newMinDelay);
        
        uint256 oldDelay = RegistryStorage.getMinDelay();
        if (oldDelay == newMinDelay) {
            return;
        }
        RegistryStorage.layout().minDelay = uint64(newMinDelay);
        
        emit RegistryEvents.MinDelayChanged(oldDelay, newMinDelay);
    }

    // ============ Storage Gap ============
    uint256[50] private __gap;
} 
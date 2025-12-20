// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts/utils/Address.sol";

import { IRegistry } from "../interfaces/IRegistry.sol";
import { IRegistryStorageMigrator } from "../interfaces/IRegistryStorageMigrator.sol";
import { IRegistryDynamicModuleKey } from "../interfaces/IRegistryDynamicModuleKey.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { RegistryStorage } from "./RegistryStorageLibrary.sol";
import { RegistryEvents } from "./RegistryEventsLibrary.sol";
import { RegistryQuery } from "./RegistryQueryLibrary.sol";
import { RegistryCore } from "./RegistryCore.sol";
import { RegistryUpgradeManager } from "./RegistryUpgradeManager.sol";
import { RegistryAdmin } from "./RegistryAdmin.sol";

/// @title Registry
/// @notice 轻量级模块地址注册中心入口点
/// @dev 作为统一入口，将功能委托给专门的模块合约
/// @dev 保持向后兼容性，同时减少合约大小
/// @dev 只负责路由和权限控制，不包含任何业务逻辑
contract Registry is 
    IRegistry,
    Initializable, 
    OwnableUpgradeable, 
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    PausableUpgradeable
{
    using Address for address;
    
    // ============ 类型定义 ============
    /// @notice 升级历史记录结构体
    struct UpgradeHistory {
        address oldAddress;        // 旧地址
        address newAddress;        // 新地址
        uint256 timestamp;         // 升级时间戳
        address executor;          // 执行者地址
    }
    
    // ============ Custom Errors ============
    /// @notice 非升级管理员错误
    error NotUpgradeAdmin(address caller);
    /// @notice 延迟时间过长错误
    error DelayTooLong(uint256 provided, uint256 max);
    /// @notice 延迟时间无效错误
    error InvalidDelayValue(uint256 delay);
    /// @notice 模块未设置错误
    error ModuleNotSet(string moduleName);
    /// @notice 非待接管管理员错误
    error NotPendingAdmin(address caller, address pendingAdmin);
    /// @notice 无效的待接管管理员错误
    error InvalidPendingAdmin(address pendingAdmin);
    /// @notice 紧急管理员未授权错误
    error EmergencyAdminNotAuthorized(address caller, address emergencyAdmin);
    /// @notice 零地址错误
    error ZeroAddress();
    /// @notice 存储版本不匹配
    error StorageVersionMismatch(uint256 expected, uint256 actual);
    /// @notice 存储迁移目标非法（必须递增）
    error InvalidMigrationTarget(uint256 fromVersion, uint256 toVersion);
    /// @notice 迁移合约执行失败
    error MigratorFailed(address migrator, bytes reason);

    // ============ Constants ============
    /// @notice 最大延迟时间（7天）
    uint256 private constant _MAX_DELAY = 7 days;

    // ============ Upgrade Admin ============
    /// @notice 升级管理员地址
    address private _upgradeAdmin;
    /// @notice 紧急管理员地址
    address private _emergencyAdmin;

    // ============ 模块合约地址 ============
    /// @notice 核心业务逻辑模块（私有存储）
    RegistryCore private _registryCore;
    /// @notice 升级管理模块（私有存储）
    RegistryUpgradeManager private _upgradeManager;
    /// @notice 治理管理模块（私有存储）
    RegistryAdmin private _registryAdmin;
    /// @notice 动态模块键注册表地址
    address private _dynamicModuleKeyRegistry;

    // ============ Constructor ============
    /// @notice 构造函数，禁用初始化器
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    /// @notice 初始化Registry合约
    /// @param _minDelay 最小延迟时间（秒）
    /// @dev 初始化所有必要的状态变量和权限设置
    /// @param _minDelay 最小延迟时间
    /// @param upgradeAdmin_ 升级管理员地址
    /// @param emergencyAdmin_ 紧急管理员地址
    function initialize(uint256 _minDelay, address upgradeAdmin_, address emergencyAdmin_) external initializer {
        if (_minDelay > _MAX_DELAY) revert DelayTooLong(_minDelay, _MAX_DELAY);
        if (upgradeAdmin_ == address(0)) revert ZeroAddress();
        if (emergencyAdmin_ == address(0)) revert ZeroAddress();
        
        __Ownable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        __Pausable_init();
        
        RegistryStorage.initializeStorageVersion();
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        l.admin = msg.sender;
        l.pendingAdmin = address(0);
        l.minDelay = uint64(_minDelay);
        
        _upgradeAdmin = upgradeAdmin_;
        _emergencyAdmin = emergencyAdmin_;
        
        emit RegistryEvents.RegistryInitialized(
            msg.sender,
            _minDelay,
            upgradeAdmin_
        );
    }

    // ============ UUPS Upgrade Authorization ============
    /// @notice UUPS升级授权函数
    /// @param newImplementation 新的实现合约地址
    /// @dev 只有升级管理员、紧急管理员或owner可以升级
    function _authorizeUpgrade(address newImplementation) internal override {
        if (msg.sender == _upgradeAdmin || msg.sender == _emergencyAdmin || msg.sender == owner()) {
            emit RegistryEvents.ModuleUpgradeAuthorized(
                msg.sender,
                newImplementation
            );
            return;
        }
        revert NotUpgradeAdmin(msg.sender);
    }

    // ============ 模块设置函数 ============
    /// @notice 设置核心业务逻辑模块地址
    /// @param registryCoreAddr 核心业务逻辑模块地址
    /// @dev 只有owner可以设置模块地址
    function setRegistryCore(address registryCoreAddr) external onlyOwner {
        if (registryCoreAddr == address(0)) revert ZeroAddress();
        if (!registryCoreAddr.isContract()) revert("Registry core must be a contract");
        
        // 验证模块是否实现了必要的接口（可选）
        // 这里可以添加更严格的验证逻辑
        
        _registryCore = RegistryCore(registryCoreAddr);
        emit RegistryEvents.ModuleChanged(bytes32("RegistryCore"), address(0), registryCoreAddr);
    }

    /// @notice 设置升级管理模块地址
    /// @param upgradeManagerAddr 升级管理模块地址
    /// @dev 只有owner可以设置模块地址
    function setUpgradeManager(address upgradeManagerAddr) external onlyOwner {
        if (upgradeManagerAddr == address(0)) revert ZeroAddress();
        if (!upgradeManagerAddr.isContract()) revert("Upgrade manager must be a contract");
        
        // 验证模块是否实现了必要的接口（可选）
        // 这里可以添加更严格的验证逻辑
        
        _upgradeManager = RegistryUpgradeManager(upgradeManagerAddr);
        emit RegistryEvents.ModuleChanged(bytes32("RegistryUpgradeManager"), address(0), upgradeManagerAddr);
        // 尝试初始化升级管理器，绑定 Registry 地址（忽略已初始化的情况，由其内部防重复）
        try _upgradeManager.initialize(address(this)) {
        } catch {}
    }

    /// @notice 设置治理管理模块地址
    /// @param registryAdminAddr 治理管理模块地址
    /// @dev 只有owner可以设置模块地址
    function setRegistryAdmin(address registryAdminAddr) external onlyOwner {
        if (registryAdminAddr == address(0)) revert ZeroAddress();
        if (!registryAdminAddr.isContract()) revert("Registry admin must be a contract");
        
        // 验证模块是否实现了必要的接口（可选）
        // 这里可以添加更严格的验证逻辑
        
        _registryAdmin = RegistryAdmin(registryAdminAddr);
        emit RegistryEvents.ModuleChanged(bytes32("RegistryAdmin"), address(0), registryAdminAddr);
    }

    /// @notice 设置动态模块键注册表地址
    /// @param dynamicModuleKeyRegistryAddr 动态模块键注册表地址
    /// @dev 只有owner可以设置模块地址
    function setDynamicModuleKeyRegistry(address dynamicModuleKeyRegistryAddr) external onlyOwner {
        if (dynamicModuleKeyRegistryAddr != address(0) && !dynamicModuleKeyRegistryAddr.isContract()) {
            revert("Dynamic module key registry must be a contract or zero address");
        }
        
        address oldAddr = _dynamicModuleKeyRegistry;
        _dynamicModuleKeyRegistry = dynamicModuleKeyRegistryAddr;
        emit RegistryEvents.ModuleChanged(bytes32("DynamicModuleKeyRegistry"), oldAddr, dynamicModuleKeyRegistryAddr);
    }

    // ============ 接口函数覆盖 ============
    /// @notice 获取所有者地址（覆盖IRegistry接口）
    /// @return 所有者地址
    function owner() public view override(IRegistry, OwnableUpgradeable) returns (address) {
        return super.owner();
    }

    /// @notice 转移所有权（覆盖IRegistry接口）
    /// @param newOwner 新所有者地址
    function transferOwnership(address newOwner) public override(IRegistry, OwnableUpgradeable) onlyOwner {
        super.transferOwnership(newOwner);
    }

    // ============ 纯查询功能 (委托给RegistryQuery) ============
    /// @notice 获取模块地址
    /// @param key 模块键
    /// @return 模块地址，如果未设置则返回零地址
    function getModule(bytes32 key) external view override returns (address) {
        return RegistryQuery.getModule(key);
    }

    /// @notice 获取模块地址，如果未设置则回滚
    /// @param key 模块键
    /// @return 模块地址
    /// @dev 如果模块未注册，函数会回滚
    function getModuleOrRevert(bytes32 key) external view override returns (address) {
        return RegistryQuery.getModuleOrRevert(key);
    }

    /// @notice 检查模块是否已注册
    /// @param key 模块键
    /// @return 是否已注册
    function isModuleRegistered(bytes32 key) external view override returns (bool) {
        return RegistryQuery.isModuleRegistered(key);
    }

    /// @notice 获取当前最小延迟时间
    /// @return 最小延迟时间（秒）
    function minDelay() external view override returns (uint256) {
        return RegistryStorage.layout().minDelay;
    }

    // ============ 升级管理员管理 (纯入口) ============
    /// @notice 设置升级管理员
    /// @param newAdmin 新的升级管理员地址
    /// @dev 只有owner可以设置升级管理员
    function setUpgradeAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert ZeroAddress();
        _upgradeAdmin = newAdmin;
        emit RegistryEvents.UpgradeAdminChanged(_upgradeAdmin, newAdmin);
    }

    /// @notice 设置紧急管理员
    /// @param newAdmin 新的紧急管理员地址
    /// @dev 只有owner可以设置紧急管理员
    function setEmergencyAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert ZeroAddress();
        _emergencyAdmin = newAdmin;
        emit RegistryEvents.EmergencyAdminChanged(_emergencyAdmin, newAdmin);
    }

    /// @notice 获取升级管理员地址
    /// @return 升级管理员地址
    function getUpgradeAdmin() external view returns (address) {
        return _upgradeAdmin;
    }

    /// @notice 获取紧急管理员地址
    /// @return 紧急管理员地址
    function getEmergencyAdmin() external view returns (address) {
        return _emergencyAdmin;
    }

    /// @notice 获取动态模块键注册表地址
    /// @return 动态模块键注册表地址
    function getDynamicModuleKeyRegistry() external view returns (address) {
        return _dynamicModuleKeyRegistry;
    }

    // ============ 治理功能 (委托给RegistryAdmin) ============
    /// @notice 获取主治理地址
    /// @return 主治理地址
    function getAdmin() external view override returns (address) {
        return owner();
    }

    /// @notice 获取待接管地址
    /// @return 待接管地址
    function getPendingAdmin() external view override returns (address) {
        return RegistryStorage.layout().pendingAdmin;
    }

    /// @notice 检查是否已暂停
    /// @return 是否已暂停
    function isPaused() external view override returns (bool) {
        return paused();
    }

    /// @notice 设置主治理地址
    /// @param newAdmin 新的治理地址
    /// @dev 只有owner可以设置治理地址
    function setAdmin(address newAdmin) external onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        address oldAdmin = owner();
        _transferOwnership(newAdmin);
        RegistryStorage.layout().admin = newAdmin;
        emit RegistryEvents.AdminChanged(oldAdmin, newAdmin);
    }

    /// @notice 设置待接管地址
    /// @param newPendingAdmin 新的待接管地址
    /// @dev 只有owner可以设置待接管地址
    function setPendingAdmin(address newPendingAdmin) external override onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        address oldPending = l.pendingAdmin;
        l.pendingAdmin = newPendingAdmin;
        emit RegistryEvents.PendingAdminChanged(oldPending, newPendingAdmin);
    }

    /// @notice 接受治理权转移
    /// @dev 只有待接管管理员可以调用此函数
    function acceptAdmin() external override {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        if (msg.sender != l.pendingAdmin) revert NotPendingAdmin(msg.sender, l.pendingAdmin);
        if (l.pendingAdmin == address(0)) revert InvalidPendingAdmin(l.pendingAdmin);
        
        address oldAdmin = owner();
        _transferOwnership(msg.sender);
        l.admin = msg.sender;
        l.pendingAdmin = address(0);
        emit RegistryEvents.AdminChanged(oldAdmin, msg.sender);
    }

    /// @notice 暂停合约
    /// @dev 只有owner和紧急管理员可以暂停
    function pause() external override {
        if (msg.sender != owner() && msg.sender != _emergencyAdmin) {
            revert EmergencyAdminNotAuthorized(msg.sender, _emergencyAdmin);
        }
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _pause();
        RegistryStorage.layout().paused = 1;
        emit RegistryEvents.EmergencyActionExecuted(
            uint8(RegistryEvents.EmergencyAction.PAUSE),
            msg.sender
        );
    }

    /// @notice 恢复合约
    /// @dev 只有owner可以恢复
    function unpause() external override onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        _unpause();
        RegistryStorage.layout().paused = 0;
        emit RegistryEvents.EmergencyActionExecuted(
            uint8(RegistryEvents.EmergencyAction.UNPAUSE),
            msg.sender
        );
    }

    // ============ 模块管理 (委托给RegistryCore) ============
    /// @notice 设置模块地址
    /// @param key 模块键
    /// @param moduleAddr 模块地址
    /// @dev 委托给RegistryCore模块处理
    function setModule(bytes32 key, address moduleAddr) external override onlyOwner whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (address(_registryCore) == address(0)) revert ModuleNotSet("RegistryCore");
        if (moduleAddr == address(0)) revert("Invalid module address: zero address");
        if (!moduleAddr.isContract()) revert("Module must be a contract");
        _registryCore.setModule(key, moduleAddr);
    }

    /// @notice 设置模块地址（返回变更状态）
    /// @param key 模块键
    /// @param moduleAddr 模块合约地址
    /// @return changed 是否实际发生了变更
    function setModuleWithStatus(bytes32 key, address moduleAddr) external override onlyOwner whenNotPaused returns (bool changed) {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (address(_registryCore) == address(0)) revert ModuleNotSet("RegistryCore");
        if (moduleAddr == address(0)) revert("Invalid module address: zero address");
        if (!moduleAddr.isContract()) revert("Module must be a contract");
        return _registryCore.setModuleWithStatus(key, moduleAddr);
    }

    /// @notice 设置模块地址（支持allowReplace参数）
    /// @param key 模块键
    /// @param moduleAddr 模块地址
    /// @param _allowReplace 是否允许替换现有模块
    /// @dev 委托给RegistryCore模块处理
    function setModuleWithReplaceFlag(bytes32 key, address moduleAddr, bool _allowReplace) external override onlyOwner whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (address(_registryCore) == address(0)) revert ModuleNotSet("RegistryCore");
        if (moduleAddr == address(0)) revert ZeroAddress();
        if (!moduleAddr.isContract()) revert("Module must be a contract");
        
        _registryCore.setModuleWithReplaceFlag(key, moduleAddr, _allowReplace);
    }

    /// @notice 批量设置模块地址（返回变更状态）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @return changedCount 实际发生变更的模块数量
    /// @return changedKeys 发生变更的模块键名数组
    function setModulesWithStatus(bytes32[] calldata keys, address[] calldata addresses) external override onlyOwner whenNotPaused 
        returns (uint256 changedCount, bytes32[] memory changedKeys) {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (address(_registryCore) == address(0)) revert ModuleNotSet("RegistryCore");
        return _registryCore.setModulesWithStatus(keys, addresses);
    }

    /// @notice 批量设置模块地址（控制事件触发）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @param emitIndividualEvents 是否同时触发单个模块变更事件
    function setModulesWithEvents(bytes32[] calldata keys, address[] calldata addresses, bool emitIndividualEvents) external override onlyOwner whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (address(_registryCore) == address(0)) revert ModuleNotSet("RegistryCore");
        _registryCore.setModulesWithEvents(keys, addresses, emitIndividualEvents);
    }

    /// @notice 批量设置模块地址
    /// @param keys 模块键数组
    /// @param addresses 模块地址数组
    /// @dev 委托给RegistryCore模块处理
    function setModules(bytes32[] calldata keys, address[] calldata addresses) external override onlyOwner whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (address(_registryCore) == address(0)) revert ModuleNotSet("RegistryCore");
        _registryCore.setModules(keys, addresses);
    }

    // ============ 升级管理 (委托给RegistryUpgradeManager) ============
    /// @notice 计划模块升级
    /// @param key 模块键
    /// @param newAddr 新模块地址
    /// @dev 委托给RegistryUpgradeManager模块处理
    function scheduleModuleUpgrade(bytes32 key, address newAddr) external override onlyOwner whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (address(_upgradeManager) == address(0)) revert ModuleNotSet("RegistryUpgradeManager");
        _upgradeManager.scheduleModuleUpgrade(key, newAddr);
    }

    /// @notice 取消模块升级
    /// @param key 模块键
    /// @dev 只有owner和紧急管理员可以取消升级
    function cancelModuleUpgrade(bytes32 key) external override onlyOwner whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (address(_upgradeManager) == address(0)) revert ModuleNotSet("RegistryUpgradeManager");
        _upgradeManager.cancelModuleUpgrade(key);
    }

    /// @notice 执行模块升级
    /// @param key 模块键
    /// @dev 委托给RegistryUpgradeManager模块处理
    function executeModuleUpgrade(bytes32 key) external override onlyOwner nonReentrant whenNotPaused {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (address(_upgradeManager) == address(0)) revert ModuleNotSet("RegistryUpgradeManager");
        _upgradeManager.executeModuleUpgrade(key);
    }

    // ============ 查询功能 (委托给RegistryQuery) ============
    /// @notice 获取待升级模块信息
    /// @param key 模块键
    /// @return newAddr 新模块地址
    /// @return executeAfter 执行时间
    /// @return hasPendingUpgrade 是否有待升级
    function getPendingUpgrade(bytes32 key) external view override returns (
        address newAddr,
        uint256 executeAfter,
        bool hasPendingUpgrade
    ) {
        return RegistryQuery.getPendingUpgrade(key);
    }

    /// @notice 检查升级是否准备就绪
    /// @param key 模块键
    /// @return 是否准备就绪
    function isUpgradeReady(bytes32 key) external view override returns (bool) {
        return RegistryQuery.isUpgradeReady(key);
    }

    // 轻量化：移除 getAllModuleKeys
    
    // 轻量化：移除 getAllRegisteredModuleKeys / getAllRegisteredModules

    // 轻量化：移除 checkModulesExist

    // 轻量化：移除 findModuleKeyByAddress (2个重载)

    // 轻量化：移除 batchFindModuleKeysByAddresses (2个重载)

    // 轻量化：移除 batchModuleExists

    // 轻量化：移除 getRegisteredModuleKeysPaginated

    /// @notice 获取模块的升级历史数量
    /// @param key 模块键
    /// @return 升级历史记录数量
    function getUpgradeHistoryCount(bytes32 key) external view returns (uint256) {
        return RegistryQuery.getUpgradeHistoryCount(key);
    }

    /// @notice 获取模块的升级历史记录
    /// @param key 模块键
    /// @param index 历史记录索引
    /// @return oldAddress 旧地址
    /// @return newAddress 新地址
    /// @return timestamp 升级时间戳
    /// @return executor 执行者地址
    function getUpgradeHistory(bytes32 key, uint256 index) external view returns (
        address oldAddress,
        address newAddress,
        uint256 timestamp,
        address executor
    ) {
        return RegistryQuery.getUpgradeHistory(key, index);
    }

    /// @notice 获取模块的所有升级历史记录
    /// @param key 模块键
    /// @return 升级历史记录数组
    function getAllUpgradeHistory(bytes32 key) external view override returns (bytes memory) {
        RegistryStorage.UpgradeHistory[] memory history = RegistryQuery.getAllUpgradeHistory(key);
        
        // 将结构体数组编码为bytes
        return abi.encode(history);
    }

    // ============ 模块状态检查 ============
    // 轻量化：移除 areModulesInitialized / getModuleInitializationStatus

    // 轻量化：移除 registryCore / upgradeManager / registryAdmin getter

    // ============ 工具函数 (委托给RegistryStorage) ============
    /// @notice 设置最小延迟时间
    /// @param newDelay 新的延迟时间（秒）
    /// @dev 只有owner可以设置延迟时间
    function setMinDelay(uint256 newDelay) external override onlyOwner {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (newDelay > _MAX_DELAY) revert DelayTooLong(newDelay, _MAX_DELAY);
        if (newDelay == 0) revert InvalidDelayValue(newDelay);
        uint256 oldDelay = RegistryStorage.layout().minDelay;
        RegistryStorage.layout().minDelay = uint64(newDelay);
        emit RegistryEvents.MinDelayChanged(oldDelay, newDelay);
    }

    /// @notice 通过迁移合约执行存储迁移（保持固定 STORAGE_SLOT 不变）
    /// @param fromVersion 预期的当前存储版本
    /// @param toVersion 目标存储版本（必须大于当前版本）
    /// @param migrator 迁移合约地址
    /// @dev 迁移流程：
    ///      1) 校验当前版本 == fromVersion 且 toVersion 递增
    ///      2) 迁移前执行 validateStorageLayout()
    ///      3) 调用迁移合约执行实际搬迁/初始化（不改槽位）
    ///      4) bump storageVersion 至 toVersion
    ///      5) 迁移后再次 validateStorageLayout()
    function migrateStorage(uint256 fromVersion, uint256 toVersion, address migrator) external override onlyOwner {
        if (migrator == address(0)) revert ZeroAddress();

        uint256 cur = RegistryStorage.getStorageVersion();
        if (cur != fromVersion) revert StorageVersionMismatch(fromVersion, cur);
        if (toVersion <= cur) revert InvalidMigrationTarget(fromVersion, toVersion);

        // 迁移前校验，确保关键字段未被破坏
        RegistryStorage.validateStorageLayout();

        // 执行迁移逻辑（数据搬迁/初始化），保持 STORAGE_SLOT 不变（delegatecall）
        bytes memory data = abi.encodeWithSelector(IRegistryStorageMigrator.migrate.selector, fromVersion, toVersion);
        (bool ok, bytes memory reason) = migrator.delegatecall(data);
        if (!ok) revert MigratorFailed(migrator, reason);

        // 版本递增并做迁移后校验
        RegistryStorage.upgradeStorageVersion(toVersion);
        RegistryStorage.validateStorageLayout();

        emit RegistryEvents.StorageMigrated(fromVersion, toVersion, migrator);
    }

    /// @notice 升级存储版本（仅治理地址可调用）
    /// @param newVersion 新的存储版本
    function upgradeStorageVersion(uint256 newVersion) external override onlyOwner {
        RegistryStorage.upgradeStorageVersion(newVersion);
    }

    /// @notice 验证存储布局
    /// @dev 用于确保存储布局的正确性
    function validateStorageLayout() external view override {
        RegistryStorage.validateStorageLayout();
    }

    /// @notice 获取最大延迟时间
    /// @return 最大延迟时间（秒）
    function MAX_DELAY() external pure override returns (uint256) {
        return _MAX_DELAY;
    }

    /// @notice 检查是否为管理员
    /// @param addr 待检查地址
    /// @return 是否为管理员
    function isAdmin(address addr) external view override returns (bool) {
        return RegistryStorage.isAdmin(addr);
    }

    /// @notice 获取存储版本
    /// @return 存储版本
    function getStorageVersion() external view override returns (uint256) {
        return RegistryStorage.getStorageVersion();
    }

    /// @notice 检查是否已初始化
    /// @return 是否已初始化
    function isInitialized() external view override returns (bool) {
        return RegistryStorage.isInitialized();
    }

    // ============ Storage Gap ============
    uint256[50] private __gap;
}

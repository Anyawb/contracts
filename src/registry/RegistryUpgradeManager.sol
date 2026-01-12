// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardSlimUpgradeable } from "../utils/ReentrancyGuardSlimUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { 
    ZeroAddress, 
    InvalidCaller,
    MismatchedArrayLengths,
    ModuleAlreadyRegistered,
    ModuleNotRegistered,
    ModuleUpgradeNotReady,
    ModuleUpgradeNotFound,
    ModuleUpgradeAlreadyExists,
    ModuleUpgradeDuplicate,
    DelayTooLong,
    DelayTooShort,
    InvalidDelayValue,
    UpgradeNotAuthorized,
    InvalidUpgradeAdmin
} from "../errors/StandardErrors.sol";
import { RegistryStorage } from "./RegistryStorageLibrary.sol";
import { RegistryEvents } from "./RegistryEventsLibrary.sol";
import { RegistryQuery } from "./RegistryQueryLibrary.sol";

/// @title RegistryUpgradeManager
/// @notice 模块升级管理功能
/// @dev 专门处理模块的升级、延时执行和历史记录
/// @dev 权限管理：owner 和 _upgradeAdmin 都有升级权限，但 owner 具有最终治理权
contract RegistryUpgradeManager is 
    Initializable, 
    OwnableUpgradeable, 
    ReentrancyGuardSlimUpgradeable,
    PausableUpgradeable
{ 
    using RegistryStorage for RegistryStorage.Layout;
    using RegistryQuery for *;
    // ============ Registry Address (唯一入口) ============
    address private _registry;
    /// @notice 可选的升级管理员（用于单独部署/测试场景）
    address private _upgradeAdmin;

    /// @notice 允许 Registry 调用；或（当未绑定 Registry 时）允许 owner / upgradeAdmin 直接调用（用于测试）
    modifier onlyRegistryOrAuthorized() {
        if (_registry != address(0)) {
            require(msg.sender == _registry, "UpgradeManager: caller is not registry");
        } else {
            // standalone mode (tests)
            if (msg.sender != owner() && msg.sender != _upgradeAdmin) revert UpgradeNotAuthorized(msg.sender, _upgradeAdmin);
        }
        _;
    }

    // ============ Constants ============
    /// @notice 批量操作的最大数量限制
    uint256 private constant MAX_BATCH_SIZE = 50;
    /// @notice 升级历史记录的最大数量限制
    uint256 private constant MAX_UPGRADE_HISTORY = 100;
    /// @notice 最大延迟时间限制（10年）
    uint256 private constant MAX_MIN_DELAY = 365 days * 10;

    // ============ Custom Errors ============
    error ModuleAlreadyExists(bytes32 key, address existingModule);
    error BatchSizeExceeded(uint256 provided, uint256 max);
    error InvalidProposer(address proposer);
    error TimestampOverflow(uint256 current, uint256 delay);

    // ============ Constructor ============
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    /// @notice 初始化合约，绑定 Registry 地址
    /// @param registryOrAdmin 若为合约地址：绑定 Registry；若为 EOA：作为 upgradeAdmin（用于测试）
    /// @param initialOwner 最终治理 owner（Timelock/Multisig 或 Registry 入口）
    function initialize(address registryOrAdmin, address initialOwner) external initializer {
        require(registryOrAdmin != address(0), "Invalid registry");
        if (initialOwner == address(0)) revert ZeroAddress();
        __Ownable_init(initialOwner);
        __ReentrancyGuardSlim_init();
        __Pausable_init();

        if (registryOrAdmin.code.length > 0) {
            _registry = registryOrAdmin;
            // registry mode 下 upgradeAdmin 不作为授权来源；这里填充为 owner 仅用于可读性
            _upgradeAdmin = owner();
        } else {
            // standalone/test mode
            _registry = address(0);
            _upgradeAdmin = registryOrAdmin;
        }
        // 初始化 RegistryStorage 版本，避免后续 requireCompatibleVersion 永久失败
        RegistryStorage.initializeStorageVersion();
        // standalone/test mode 期望默认 minDelay=1h（与现有测试一致）
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        if (l.minDelay == 0) {
            l.minDelay = uint64(1 hours);
        }
    }

    /// @notice 设置升级管理员（仅 standalone/test mode 需要）
    function setUpgradeAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert InvalidUpgradeAdmin(newAdmin);
        _upgradeAdmin = newAdmin;
    }

    /// @notice 获取升级管理员
    function getUpgradeAdmin() external view returns (address) {
        return _upgradeAdmin;
    }

    /// @notice 暂停（用于测试与紧急控制）
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice 解除暂停
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============ Upgrade Management ============
    /// @notice 首次设置或紧急替换模块地址（一次性操作，无延时）
    /// @param key 模块键
    /// @param moduleAddr 新模块地址
    /// @param allowReplace 是否允许替换已存在的模块
    function setModule(bytes32 key, address moduleAddr, bool allowReplace) external whenNotPaused onlyRegistryOrAuthorized {
        _executeModuleUpgrade(key, moduleAddr, allowReplace, msg.sender);
    }

    /// @notice 批量设置多个模块地址（一次性操作，无延时）
    /// @param keys 模块键数组
    /// @param addresses 新模块地址数组
    /// @param allowReplace 是否允许替换已存在的模块
    function batchSetModules(bytes32[] calldata keys, address[] calldata addresses, bool allowReplace) external whenNotPaused onlyRegistryOrAuthorized {
        _reentrancyGuardEnter();

        // 检查批量大小限制
        if (keys.length > MAX_BATCH_SIZE) {
            revert BatchSizeExceeded(keys.length, MAX_BATCH_SIZE);
        }
        
        _executeBatchModuleUpgrade(keys, addresses, allowReplace, msg.sender);
        _reentrancyGuardExit();
    }

    /// @notice 发起模块升级计划，进入延时队列
    /// @param key 模块键
    /// @param newAddr 新模块地址
    function scheduleModuleUpgrade(bytes32 key, address newAddr) external whenNotPaused onlyRegistryOrAuthorized {
        if (newAddr == address(0)) revert ModuleNotRegistered(key);
        
        // 添加存储版本兼容检查
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        RegistryStorage.PendingUpgrade storage pending = l.pendingUpgrades[key];
        pending.newAddr = newAddr;
        
        // 添加溢出检查
        uint256 executeAfter = block.timestamp + l.minDelay;
        if (executeAfter < block.timestamp) {
            revert TimestampOverflow(block.timestamp, l.minDelay);
        }
        pending.executeAfter = executeAfter;
        
        emit RegistryEvents.ModuleUpgradeScheduled(key, l.modules[key], newAddr, executeAfter, msg.sender);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 取消尚未执行的升级计划
    /// @param key 模块键
    function cancelModuleUpgrade(bytes32 key) external whenNotPaused onlyRegistryOrAuthorized {
        
        // 添加存储版本兼容检查
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        RegistryStorage.PendingUpgrade memory pending = l.pendingUpgrades[key];
        if (pending.newAddr == address(0)) revert ModuleUpgradeNotFound(key);
        emit RegistryEvents.ModuleUpgradeCancelled(key, l.modules[key], pending.newAddr, msg.sender);
        delete l.pendingUpgrades[key];
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 到期后执行模块升级，将新地址写入映射
    /// @param key 模块键
    function executeModuleUpgrade(bytes32 key) external whenNotPaused onlyRegistryOrAuthorized {
        _reentrancyGuardEnter();
        _executeDelayedUpgrade(key, msg.sender);
        _reentrancyGuardExit();
    }

    // ============ View Functions ============
    /// @notice 获取待升级模块信息
    function getPendingUpgrade(bytes32 key) external view returns (
        address newAddr,
        uint256 executeAfter,
        bool hasPendingUpgrade
    ) {
        return RegistryQuery.getPendingUpgrade(key);
    }

    /// @notice 检查升级是否准备就绪
    function isUpgradeReady(bytes32 key) external view returns (bool) {
        return RegistryQuery.isUpgradeReady(key);
    }

    /// @notice 获取模块的升级历史数量
    function getUpgradeHistoryCount(bytes32 key) external view returns (uint256) {
        return RegistryQuery.getUpgradeHistoryCount(key);
    }

    /// @notice 获取模块的升级历史记录
    function getUpgradeHistory(bytes32 key, uint256 index) external view returns (
        address oldAddress,
        address newAddress,
        uint256 timestamp,
        address executor
    ) {
        return RegistryQuery.getUpgradeHistory(key, index);
    }

    /// @notice 获取模块的所有升级历史记录
    function getAllUpgradeHistory(bytes32 key) external view returns (RegistryStorage.UpgradeHistory[] memory) {
        return RegistryQuery.getAllUpgradeHistory(key);
    }

    // ============ Admin Functions ============
    /// @notice 更新延时窗口，允许只增不减
    /// @param newDelay 新的最小延迟时间
    function setMinDelay(uint256 newDelay) external whenNotPaused onlyRegistryOrAuthorized {
        // 添加存储版本兼容检查
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        if (newDelay < l.minDelay) revert DelayTooShort(newDelay, l.minDelay);
        if (newDelay > MAX_MIN_DELAY) revert DelayTooLong(newDelay, MAX_MIN_DELAY);
        
        // 添加溢出检查
        if (newDelay > type(uint64).max) {
            revert TimestampOverflow(0, newDelay);
        }
        
        emit RegistryEvents.MinDelayChanged(l.minDelay, newDelay);
        l.minDelay = uint64(newDelay);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ============ Internal Functions ============
    // 统一由 Registry 控制权限，这里不再做二次授权检查

    /// @notice 执行单个模块升级
    /// @param key 模块键
    /// @param newAddr 新合约地址
    /// @param allowReplace 是否允许替换
    /// @param executor 执行者地址
    function _executeModuleUpgrade(
        bytes32 key,
        address newAddr,
        bool allowReplace,
        address executor
    ) internal {
        if (newAddr == address(0)) revert ZeroAddress();
        
        // 添加存储版本兼容检查
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        address oldAddr = l.modules[key];
        
        // 改进错误处理：当 allowReplace == false 且模块已存在时，使用自定义错误
        if (!allowReplace && oldAddr != address(0)) {
            revert ModuleAlreadyExists(key, oldAddr);
        }
        
        // 防止重复升级到相同地址
        if (oldAddr == newAddr) revert InvalidCaller();
        
        l.modules[key] = newAddr;
        emit RegistryEvents.ModuleUpgraded(key, oldAddr, newAddr, executor);
        
        // 记录升级历史
        _recordUpgradeHistory(key, oldAddr, newAddr, executor);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            executor,
            block.timestamp
        );
        
        // 发出模块地址更新事件（使用常量字符串名称，提高日志可读性）
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyConstantString(key),
            oldAddr,
            newAddr,
            block.timestamp
        );
    }

    /// @notice 执行批量模块升级
    /// @param keys 模块键数组
    /// @param addresses 新合约地址数组
    /// @param allowReplace 是否允许替换
    /// @param executor 执行者地址
    function _executeBatchModuleUpgrade(
        bytes32[] calldata keys,
        address[] calldata addresses,
        bool allowReplace,
        address executor
    ) internal {
        if (keys.length != addresses.length) revert InvalidCaller();
        
        // ✅ 优化：将存储布局引用放在循环外，避免多次 SLOAD
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 准备批量事件和历史记录数据
        bytes32[] memory tempChangedKeys = new bytes32[](keys.length);
        address[] memory oldAddresses = new address[](keys.length);
        address[] memory newAddresses = new address[](keys.length);
        uint256 tempChangedCount = 0;
        
        for (uint256 i = 0; i < keys.length; i++) {
            // 验证地址不为零
            if (addresses[i] == address(0)) revert ZeroAddress();
            
            address oldAddr = l.modules[keys[i]];
            if (!allowReplace && oldAddr != address(0)) revert InvalidCaller();
            
            // 防止重复升级到相同地址
            if (oldAddr == addresses[i]) continue;
            
            l.modules[keys[i]] = addresses[i];
            
            // 收集变更数据用于批量事件和历史记录
            tempChangedKeys[tempChangedCount] = keys[i];
            oldAddresses[tempChangedCount] = oldAddr;
            newAddresses[tempChangedCount] = addresses[i];
            tempChangedCount++;
        }
        
        // ✅ 优化：批量记录历史（如果有变更）
        if (tempChangedCount > 0) {
            _recordBatchUpgradeHistory(tempChangedKeys, oldAddresses, newAddresses, executor);
            
            // ✅ 优化：批量事件触发，替代多个单独事件
            emit RegistryEvents.BatchModuleChanged(
                tempChangedKeys,
                oldAddresses,
                newAddresses,
                executor
            );
        }
    }

    /// @notice 执行延时升级
    /// @param key 模块键
    /// @param executor 执行者地址
    function _executeDelayedUpgrade(bytes32 key, address executor) internal {
        // 添加存储版本兼容检查
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        RegistryStorage.PendingUpgrade memory pending = l.pendingUpgrades[key];
        if (pending.newAddr == address(0)) revert InvalidCaller();
        if (block.timestamp < pending.executeAfter) revert InvalidCaller();

        address oldAddr = l.modules[key];
        if (pending.newAddr == oldAddr) revert InvalidCaller(); // ✅ 防止重复升级

        l.modules[key] = pending.newAddr;
        emit RegistryEvents.ModuleUpgraded(key, oldAddr, pending.newAddr, executor);
        delete l.pendingUpgrades[key];
        
        // 记录升级历史
        _recordUpgradeHistory(key, oldAddr, pending.newAddr, executor);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            executor,
            block.timestamp
        );
        
        // 发出模块地址更新事件（使用常量字符串名称，提高日志可读性）
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyConstantString(key),
            oldAddr,
            pending.newAddr,
            block.timestamp
        );
    }

    /// @notice 记录模块升级历史（使用环形缓冲，限制历史数量）
    /// @param key 模块键
    /// @param oldAddr 旧地址
    /// @param newAddr 新地址
    /// @param executor 执行者地址
    function _recordUpgradeHistory(bytes32 key, address oldAddr, address newAddr, address executor) private {
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        RegistryStorage.UpgradeHistory memory history = RegistryStorage.UpgradeHistory({
            oldAddress: oldAddr,
            newAddress: newAddr,
            timestamp: block.timestamp,
            executor: executor
        });
        
        // ✅ 优化：使用环形缓冲策略，限制历史记录数量，防止存储膨胀
        uint256 currentIdx = l.historyIndex[key];
        if (l.upgradeHistory[key].length < MAX_UPGRADE_HISTORY) {
            // 如果历史记录未满，直接添加
            l.upgradeHistory[key].push(history);
        } else {
            // 如果历史记录已满，使用环形缓冲覆盖最旧的记录（FIFO）
            uint256 ring = currentIdx % MAX_UPGRADE_HISTORY;
            l.upgradeHistory[key][ring] = history;
        }
        
        // 更新索引（用于环形缓冲计算）
        l.historyIndex[key] = currentIdx + 1;
        
        // 事件中的 txHash 参数保留用于外部索引器填充
        emit RegistryEvents.UpgradeHistoryRecorded(key, oldAddr, newAddr, block.timestamp, executor, bytes32(0));
    }

    /// @notice 批量记录模块升级历史（使用环形缓冲，限制历史数量）
    /// @param keys 模块键数组
    /// @param oldAddresses 旧地址数组
    /// @param newAddresses 新地址数组
    /// @param executor 执行者地址
    function _recordBatchUpgradeHistory(bytes32[] memory keys, address[] memory oldAddresses, address[] memory newAddresses, address executor) private {
        RegistryStorage.Layout storage l = RegistryStorage.layout();

        for (uint256 i = 0; i < keys.length; i++) {
            bytes32 key = keys[i];
            address oldAddr = oldAddresses[i];
            address newAddr = newAddresses[i];

            RegistryStorage.UpgradeHistory memory history = RegistryStorage.UpgradeHistory({
                oldAddress: oldAddr,
                newAddress: newAddr,
                timestamp: block.timestamp,
                executor: executor
            });

            // ✅ 优化：使用环形缓冲策略，限制历史记录数量，防止存储膨胀
            uint256 currentIdx = l.historyIndex[key];
            if (l.upgradeHistory[key].length < MAX_UPGRADE_HISTORY) {
                l.upgradeHistory[key].push(history);
            } else {
                // 数组已满，覆盖最旧的记录（FIFO 环形缓冲）
                uint256 ring = currentIdx % MAX_UPGRADE_HISTORY;
                l.upgradeHistory[key][ring] = history;
            }
            
            l.historyIndex[key] = currentIdx + 1;
        }
        
        // 触发批量历史记录事件
        emit RegistryEvents.BatchModuleChanged(keys, oldAddresses, newAddresses, executor);
    }

    // ============ Storage Gap ============
    uint256[50] private __gap;
} 
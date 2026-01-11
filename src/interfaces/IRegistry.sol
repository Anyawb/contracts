// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRegistry
/// @notice Registry 合约的接口定义
/// @dev 提供统一的模块注册和访问接口，供所有模块使用
interface IRegistry {

    /* ============ Structs ============ */
    /// @notice 模块升级历史记录
    struct UpgradeHistory {
        address oldAddress;
        address newAddress;
        uint256 timestamp;
        address executor;
    }
    
    /* ============ Events ============ */
    /// @notice Registry 已初始化
    event RegistryInitialized(
        address indexed admin,
        uint256 minDelay,
        address indexed initializer
    );

    /// @notice 存储版本已升级
    event StorageVersionUpgraded(uint256 oldVersion, uint256 newVersion);

    /// @notice 待接管地址已变更
    event PendingAdminChanged(address indexed oldPendingAdmin, address indexed newPendingAdmin);

    /// @notice 模块地址已直接变更（无延迟升级）
    event ModuleChanged(
        bytes32 indexed key, 
        address indexed oldAddress, 
        address indexed newAddress
    );

    /// @notice 模块地址无变更（幂等操作）
    event ModuleNoOp(
        bytes32 indexed key,
        address indexed currentAddress,
        address executor
    );

    /// @notice 批量模块地址已直接变更（无延迟升级）
    event BatchModuleChanged(
        bytes32[] keys,
        address[] oldAddresses,
        address[] newAddresses,
        address executor
    );

    /// @notice 模块升级计划事件
    event ModuleUpgradeScheduled(bytes32 indexed key, address indexed oldAddress, address indexed newAddress, uint256 executeAfter);
    
    /// @notice 模块升级完成事件
    event ModuleUpgraded(bytes32 indexed key, address indexed oldAddress, address indexed newAddress, address executor);
    
    /// @notice 模块升级取消事件
    event ModuleUpgradeCancelled(bytes32 indexed key, address indexed oldAddress, address indexed newAddress, address canceller);
    
    /// @notice 紧急操作已执行
    event EmergencyActionExecuted(
        uint8 indexed action, 
        address indexed executor,
        uint256 timestamp
    );

    /// @notice 延时窗口变更事件
    event MinDelayChanged(uint256 oldDelay, uint256 newDelay);
    
    /// @notice 升级管理员已变更
    event UpgradeAdminChanged(
        address indexed oldAdmin, 
        address indexed newAdmin
    );

    /* ============ View Functions ============ */
    
    /// @notice 获取模块地址
    /// @param key 模块键
    /// @return 模块合约地址
    function getModule(bytes32 key) external view returns (address);
    
    /// @notice 获取模块地址，若未注册则回滚
    /// @param key 模块键
    /// @return 模块合约地址
    function getModuleOrRevert(bytes32 key) external view returns (address);

    /// @notice 检查模块是否已注册
    /// @param key 模块键名
    /// @return 是否已注册
    function isModuleRegistered(bytes32 key) external view returns (bool);
    
    // 轻量化：删除批量与反查相关对外查询接口（迁移至 View 合约）
    
    /// @notice 获取当前延时窗口
    /// @return 延时窗口（秒）
    function minDelay() external view returns (uint256);
    
    /// @notice 获取最大延时窗口
    /// @return 最大延时窗口（秒）
    function MAX_DELAY() external view returns (uint256);

    /// @notice 获取主治理地址
    /// @return 治理地址
    function getAdmin() external view returns (address);

    /// @notice 获取待接管地址
    /// @return 待接管地址
    function getPendingAdmin() external view returns (address);

    /// @notice 检查是否已暂停
    /// @return 是否已暂停
    function isPaused() external view returns (bool);

    /// @notice 检查调用者是否为治理地址
    /// @param addr 待检查地址
    /// @return 是否为治理地址
    function isAdmin(address addr) external view returns (bool);

    /// @notice 获取当前存储版本
    /// @return 存储版本
    function getStorageVersion() external view returns (uint256);

    /// @notice 检查是否已初始化
    /// @return 是否已初始化
    function isInitialized() external view returns (bool);

    /// @notice 获取所有者地址
    /// @return 所有者地址
    function owner() external view returns (address);

    /* ============ Admin Functions ============ */
    
    /// @notice 设置模块地址（兼容旧版本）
    /// @param key 模块键
    /// @param moduleAddr 模块合约地址
    function setModule(bytes32 key, address moduleAddr) external;
    
    /// @notice 设置模块地址（返回变更状态）
    /// @param key 模块键
    /// @param moduleAddr 模块合约地址
    /// @return changed 是否实际发生了变更
    function setModuleWithStatus(bytes32 key, address moduleAddr) external returns (bool changed);

    /// @notice 批量设置模块地址（默认不触发单个事件以节省 gas）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    function setModules(bytes32[] calldata keys, address[] calldata addresses) external;

    /// @notice 批量设置模块地址（返回变更状态）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @return changedCount 实际发生变更的模块数量
    /// @return changedKeys 发生变更的模块键名数组
    function setModulesWithStatus(bytes32[] calldata keys, address[] calldata addresses) external 
        returns (uint256 changedCount, bytes32[] memory changedKeys);

    /// @notice 批量设置模块地址（控制事件触发）
    /// @param keys 模块键名数组
    /// @param addresses 模块地址数组
    /// @param emitIndividualEvents 是否同时触发单个模块变更事件
    function setModulesWithEvents(bytes32[] calldata keys, address[] calldata addresses, bool emitIndividualEvents) external;

    /// @notice 升级存储版本（仅治理地址可调用）
    /// @param newVersion 新的存储版本
    function upgradeStorageVersion(uint256 newVersion) external;
    
    /// @notice 通过外部迁移合约执行存储迁移（保持固定 STORAGE_SLOT）
    /// @param fromVersion 预期的当前存储版本
    /// @param toVersion 目标存储版本
    /// @param migrator 迁移合约地址
    function migrateStorage(uint256 fromVersion, uint256 toVersion, address migrator) external;

    /// @notice 暂停系统（仅治理地址可调用）
    function pause() external;

    /// @notice 恢复系统（仅治理地址可调用）
    function unpause() external;

    /// @notice 设置待接管地址（仅当前治理地址可调用）
    /// @param newPendingAdmin 新的待接管地址
    function setPendingAdmin(address newPendingAdmin) external;

    /// @notice 接受治理权限（仅待接管地址可调用）
    function acceptAdmin() external;
    
    /// @notice 安排模块升级
    /// @param key 模块键
    /// @param newAddr 新模块合约地址
    function scheduleModuleUpgrade(bytes32 key, address newAddr) external;
    
    /// @notice 取消模块升级计划
    /// @param key 模块键
    function cancelModuleUpgrade(bytes32 key) external;
    
    /// @notice 执行模块升级
    /// @param key 模块键
    function executeModuleUpgrade(bytes32 key) external;
    
    /// @notice 设置延时窗口
    /// @param newDelay 新延时窗口（秒）
    function setMinDelay(uint256 newDelay) external;
    
    /// @notice 转移所有权
    /// @param newOwner 新所有者地址
    function transferOwnership(address newOwner) external;

    /// @notice 验证存储布局完整性
    function validateStorageLayout() external view;

    /// @notice 获取模块的所有升级历史记录
    /// @param key 模块键
    /// @return 升级历史记录数组
    function getAllUpgradeHistory(bytes32 key) external view returns (UpgradeHistory[] memory);

    // ============ 新增缺失的接口函数 ============
    
    /// @notice 设置升级管理员
    /// @param newAdmin 新的升级管理员地址
    function setUpgradeAdmin(address newAdmin) external;
    
    /// @notice 设置紧急管理员
    /// @param newAdmin 新的紧急管理员地址
    function setEmergencyAdmin(address newAdmin) external;
    
    /// @notice 获取升级管理员地址
    /// @return 升级管理员地址
    function getUpgradeAdmin() external view returns (address);
    
    /// @notice 获取紧急管理员地址
    /// @return 紧急管理员地址
    function getEmergencyAdmin() external view returns (address);
    
    // 轻量化：删除模块初始化状态对外查询接口（迁移至 View 合约）
    
    /// @notice 获取待升级模块信息
    /// @param key 模块键
    /// @return newAddr 新模块地址
    /// @return executeAfter 执行时间
    /// @return hasPendingUpgrade 是否有待升级
    function getPendingUpgrade(bytes32 key) external view returns (
        address newAddr,
        uint256 executeAfter,
        bool hasPendingUpgrade
    );
    
    /// @notice 检查升级是否准备就绪
    /// @param key 模块键
    /// @return 是否准备就绪
    function isUpgradeReady(bytes32 key) external view returns (bool);
    
    // 轻量化：删除模块键列表与分页对外查询接口（迁移至 View 合约）
    
    /// @notice 获取模块的升级历史数量
    /// @param key 模块键
    /// @return 升级历史记录数量
    function getUpgradeHistoryCount(bytes32 key) external view returns (uint256);
    
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
    );
    
    /// @notice 设置模块地址（支持allowReplace参数）
    /// @param key 模块键
    /// @param moduleAddr 模块地址
    /// @param _allowReplace 是否允许替换现有模块
    function setModuleWithReplaceFlag(bytes32 key, address moduleAddr, bool _allowReplace) external;
} 
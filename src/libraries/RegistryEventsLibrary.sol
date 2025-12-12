// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RegistryEvents
/// @notice Registry 合约的事件定义库
/// @dev 这是一个库文件，用于分离事件定义，减少主合约大小
/// @dev 所有 Registry 相关的事件都在这里统一定义，便于维护和复用
/// @dev 使用 emit RegistryEvents.Xxx 语法在其他合约中发出事件
library RegistryEvents {
    // ============ 行为开关（常量） ============
    /// @notice 是否发出 ModuleNoOp 事件（默认关闭节省 gas）
    bool public constant EMIT_MODULE_NOOP = false;
    // ============ 枚举定义 ============
    
    /// @notice 紧急操作类型枚举
    /// @dev 使用枚举替代字符串，节省 gas 且更规范
    /// @dev 注意：如果添加新的操作类型，需要同时更新事件定义
    enum EmergencyAction {
        PAUSE,              // 0: 暂停系统
        UNPAUSE,            // 1: 恢复系统
        EMERGENCY_UPGRADE,  // 2: 紧急升级
        EMERGENCY_RECOVERY, // 3: 紧急恢复
        EMERGENCY_WITHDRAW  // 4: 紧急提款
    }

    // ============ 初始化相关事件 ============
    
    /// @notice Registry 已初始化
    /// @param admin 治理地址
    /// @param minDelay 最小延迟时间
    /// @param initializer 初始化者地址
    event RegistryInitialized(
        address indexed admin,
        uint256 minDelay,
        address indexed initializer
    );

    // ============ 存储管理相关事件 ============
    
    /// @notice 存储版本已升级
    /// @param oldVersion 旧版本
    /// @param newVersion 新版本
    event StorageVersionUpgraded(uint256 oldVersion, uint256 newVersion);

    // ============ 治理相关事件 ============
    
    /// @notice 主治理地址已变更
    /// @param oldAdmin 旧治理地址
    /// @param newAdmin 新治理地址
    event AdminChanged(
        address indexed oldAdmin, 
        address indexed newAdmin
    );

    /// @notice 待接管地址已变更
    /// @param oldPendingAdmin 旧待接管地址
    /// @param newPendingAdmin 新待接管地址
    event PendingAdminChanged(address indexed oldPendingAdmin, address indexed newPendingAdmin);

    /// @notice 升级管理员已变更
    /// @param oldAdmin 旧升级管理员地址
    /// @param newAdmin 新升级管理员地址
    event UpgradeAdminChanged(
        address indexed oldAdmin, 
        address indexed newAdmin
    );

    /// @notice 紧急管理员已变更
    /// @param oldAdmin 旧紧急管理员地址
    /// @param newAdmin 新紧急管理员地址
    event EmergencyAdminChanged(
        address indexed oldAdmin, 
        address indexed newAdmin
    );

    // ============ 模块管理相关事件 ============
    
    /// @notice 模块地址已直接变更（无延迟升级）
    /// @param key 模块键名
    /// @param oldAddress 旧模块地址
    /// @param newAddress 新模块地址
    /// @dev 用于直接设置模块地址，无需延迟升级流程
    event ModuleChanged(
        bytes32 indexed key, 
        address indexed oldAddress, 
        address indexed newAddress
    );

    /// @notice 模块地址无变更（幂等操作）
    /// @param key 模块键名
    /// @param currentAddress 当前模块地址
    /// @param executor 执行者地址
    /// @dev 用于前端追踪无变更的操作
    event ModuleNoOp(
        bytes32 indexed key,
        address indexed currentAddress,
        address executor
    );

    /// @notice 模块升级已排期（延迟升级流程）
    /// @param key 模块键名
    /// @param oldAddress 旧模块地址
    /// @param newAddress 新模块地址
    /// @param executeAfter 执行时间戳
    /// @param proposer 提议者地址
    event ModuleUpgradeScheduled(
        bytes32 indexed key, 
        address indexed oldAddress, 
        address indexed newAddress, 
        uint256 executeAfter,
        address proposer
    );

    /// @notice 模块升级已执行（延迟升级流程完成）
    /// @param key 模块键名
    /// @param oldAddress 旧模块地址
    /// @param newAddress 新模块地址
    /// @param executor 执行者地址
    event ModuleUpgraded(
        bytes32 indexed key, 
        address indexed oldAddress, 
        address indexed newAddress,
        address executor
    );

    /// @notice 模块升级已取消（延迟升级流程）
    /// @param key 模块键名
    /// @param oldAddress 旧模块地址
    /// @param newAddress 新模块地址
    /// @param canceller 取消者地址
    event ModuleUpgradeCancelled(
        bytes32 indexed key, 
        address indexed oldAddress, 
        address indexed newAddress,
        address canceller
    );

    /// @notice 批量模块地址已直接变更（无延迟升级）
    /// @param keys 模块键名数组
    /// @param oldAddresses 旧模块地址数组
    /// @param newAddresses 新模块地址数组
    /// @dev 批量变更事件仅携带变更数据，移除冗余 executor 以降 gas
    /// @dev 用于批量直接设置模块地址，无需延迟升级流程
    /// @dev 建议在合约逻辑中限制数组长度不超过 20，防止单个交易中传入过大数组
    event BatchModuleChanged(
        bytes32[] keys,
        address[] oldAddresses,
        address[] newAddresses
    );

    // ============ 升级历史记录事件 ============
    
    /// @notice 升级历史已记录
    /// @param key 模块键名
    /// @param oldAddress 旧模块地址
    /// @param newAddress 新模块地址
    /// @param timestamp 升级时间戳
    /// @param executor 执行者地址
    /// @param txHash 交易哈希（可选，用于链上链下联动审计）
    /// @dev txHash 参数保留用于外部索引器填充，合约内无法获取当前交易哈希
    /// @dev 外部索引器可以通过事件日志关联实际的交易哈希
    event UpgradeHistoryRecorded(
        bytes32 indexed key, 
        address indexed oldAddress, 
        address indexed newAddress, 
        uint256 timestamp, 
        address executor,
        bytes32 txHash
    );

    // ============ 权限验证相关事件 ============
    
    /// @notice 单个模块升级权限已验证
    /// @param key 模块键名
    /// @param newAddress 新模块地址
    /// @param signer 签名者地址
    /// @param nonce 使用的 nonce
    event ModuleUpgradePermitted(
        bytes32 indexed key, 
        address indexed newAddress, 
        address indexed signer, 
        uint256 nonce
    );

    /// @notice 批量模块升级权限已验证
    /// @param keys 模块键名数组
    /// @param addresses 新模块地址数组
    /// @param signer 签名者地址
    /// @param nonce 使用的 nonce
    /// @dev 建议在合约逻辑中限制数组长度不超过 20，防止单个交易中传入过大数组造成 gas 问题
    /// @dev 建议分批处理大量升级，每批不超过 10-20 个模块
    /// @dev 推荐在接口层或文档中明确限制，避免恶意传入超长数组
    event BatchModuleUpgradePermitted(
        bytes32[] keys, 
        address[] addresses, 
        address indexed signer, 
        uint256 nonce
    );

    // ============ 紧急操作相关事件 ============
    
    /// @notice 紧急操作已执行（使用枚举，节省 gas）
    /// @param action 操作类型（EmergencyAction 枚举值）
    /// @param executor 执行者地址
    /// @dev 使用枚举替代字符串，节省 gas 且更规范
    /// @dev EmergencyAction 枚举值：
    /// - 0: PAUSE - 暂停系统
    /// - 1: UNPAUSE - 恢复系统
    /// - 2: EMERGENCY_UPGRADE - 紧急升级
    /// - 3: EMERGENCY_RECOVERY - 紧急恢复
    /// - 4: EMERGENCY_WITHDRAW - 紧急提款
    event EmergencyActionExecuted(
        uint8 indexed action, 
        address indexed executor
    );

    /// @notice 系统已暂停
    /// @param executor 执行者地址
    event Paused(
        address indexed executor
    );

    /// @notice 系统已恢复
    /// @param executor 执行者地址
    event Unpaused(
        address indexed executor
    );

    // ============ 配置变更相关事件 ============
    
    /// @notice 最小延迟已变更
    /// @param oldDelay 旧延迟时间
    /// @param newDelay 新延迟时间
    event MinDelayChanged(
        uint256 oldDelay, 
        uint256 newDelay
    );

    // ============ 系统恢复相关事件 ============
    
    /// @notice Registry 恢复已执行
    /// @param oldRegistry 旧 Registry 地址
    /// @param newRegistry 新 Registry 地址
    /// @param executor 执行者地址
    event RegistryRecoveryExecuted(
        address indexed oldRegistry, 
        address indexed newRegistry, 
        address indexed executor
    );

    // ============ 升级授权相关事件 ============
    
    /// @notice 模块升级已授权
    /// @param authorizer 授权者地址
    /// @param newImplementation 新实现合约地址
    event ModuleUpgradeAuthorized(
        address indexed authorizer,
        address indexed newImplementation
    );

    // ============ ETH 接收相关事件 ============
    
    /// @notice 接收到 ETH
    /// @param sender 发送者地址
    /// @param amount ETH 数量
    event EthReceived(
        address indexed sender,
        uint256 amount
    );

    /// @notice 未知函数被调用
    /// @param sender 调用者地址
    /// @param value 发送的 ETH 数量
    event UnknownFunctionCalled(
        address indexed sender,
        uint256 value
    );

    // ============ 事件使用场景说明 ============
    /// @dev 模块相关事件使用场景区分：
    /// 
    /// ModuleChanged vs ModuleUpgraded:
    /// - ModuleChanged: 直接设置模块地址，无需延迟升级流程
    ///   - 使用场景：setModule(), setModules() 等直接操作
    ///   - 特点：立即生效，无延迟期
    /// 
    /// - ModuleUpgraded: 延迟升级流程完成后的最终执行
    ///   - 使用场景：延迟升级流程中的最终执行步骤
    ///   - 特点：经过延迟期后执行，有完整的升级流程
    /// 
    /// - ModuleUpgradeScheduled: 延迟升级流程的开始
    ///   - 使用场景：提议模块升级，进入延迟期
    ///   - 特点：需要等待延迟期后才能执行
    /// 
    /// - ModuleUpgradeCancelled: 延迟升级流程的取消
    ///   - 使用场景：在延迟期内取消已排期的升级
    ///   - 特点：取消尚未执行的升级提议

    // ============ 事件参数命名规范说明 ============
    /// @dev 事件参数命名规范：
    /// - 地址参数使用描述性名称：executor（执行者）、proposer（提议者）、signer（签名者）
    /// - 保持命名一致性，便于阅读和维护
    /// - 新事件应遵循此命名规范
} 
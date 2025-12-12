// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { 
    ZeroAddress, 
    AlreadyInitialized, 
    MinDelayOverflow, 
    MinDelayTooLarge,
    NotInitialized,
    InvalidStorageVersion,
    NotGovernance
} from "../errors/StandardErrors.sol";

/// @title RegistryStorage
/// @notice Registry 合约的存储结构定义
/// @dev 用于分离存储结构，便于升级和维护
/// 
/// @dev 存储布局版本控制：
/// - 如需升级存储结构，请变更STORAGE_SLOT常量字符串为新的版本（v2）
/// - 并在实现合约中添加迁移逻辑
/// 
/// @dev 重要提醒 - 升级策略选择：
/// 1. 迁移策略（推荐）：保持 STORAGE_SLOT 不变，在新实现中写迁移函数
///    - 优点：保留历史数据，平滑升级
///    - 需要：治理提案 + 迁移脚本 + 充分测试
/// 
/// 2. 全新存储策略：变更 STORAGE_SLOT 为新版本
///    - 优点：简单直接，避免迁移复杂性
///    - 缺点：丢失所有历史数据，等于全新部署
///    - 适用：破坏性升级或数据重置场景
/// 
/// @dev 推荐流程：
/// - 优先选择迁移策略，在实现合约中写 migrateV1toV2() 函数
/// - 通过治理提案执行迁移，而不是切换存储槽位
/// - 切换存储槽位仅用于"破坏性升级"场景
/// 
/// @dev 开发注意事项：
/// - 所有存储字段变更都需要版本升级
/// - 升级前必须充分测试迁移逻辑
/// - 在 README 或治理文档中明确升级流程
library RegistryStorage {
    struct Layout {
        // ============ 存储布局版本控制 ============
        uint256 storageVersion;    // 存储布局版本，用于防止升级时的存储冲突

        // ============ 管理/治理相关 ============
        address admin;             // 主治理地址（保留用于 RegistryCore 兼容性）
        address pendingAdmin;      // 待接管地址（保留，因为 Ownable 没有此功能）

        // ============ 时间延迟配置 ============
        uint8 paused;              // 紧急停止开关（保留用于 RegistryCore 兼容性）
        uint64 minDelay;           // 最小延迟，用于升级/关键操作的 timelock（最大 ~5.8e19 秒）
        // 存储优化说明：
        // - paused(uint8) + minDelay(uint64) 打包在同一 slot，节省存储空间
        // - minDelay 使用 uint64，支持最大 ~5.8e19 秒（约 18.4 亿年），足够所有实际场景
        // - 如果未来需要更大的延迟，可考虑升级存储布局
        // - 注意：admin 和 paused 字段保留用于 RegistryCore 兼容性

        // ============ 模块映射 ============
        mapping(bytes32 => address) modules;  // moduleKey => moduleAddress

        // ============ 等待执行的升级（timelocked upgrades） ============
        mapping(bytes32 => PendingUpgrade) pendingUpgrades;

        // ============ 升级历史记录 ============
        mapping(bytes32 => UpgradeHistory[]) upgradeHistory;
        mapping(bytes32 => uint256) historyIndex;
        // 存储成本说明：
        // - UpgradeHistory[] 动态数组写入会消耗较多 gas（push 操作）
        // - 如果历史条目极其频繁，需考虑存储策略或把部分审计信息放在事件中
        // - 通常把完整历史记录同时保存在链上是可以接受的，但要衡量 gas 成本
        // - 建议：如果升级非常频繁，考虑仅在链上保留简短摘要，完整历史放 off-chain

        // ============ 签名/nonce 管理 ============
        mapping(address => uint256) nonces;   // 每个签名者的独立nonce，用于防止重放攻击
        // 防重放策略说明：
        // 1. 单次递增策略：每次签名验证后 nonces[signer]++
        //    - 优点：简单可靠，确保每个nonce只使用一次
        //    - 缺点：无法并行处理同一用户的多个签名
        // 
        // 2. Bitmap策略：使用 usedNonces[signer][nonce/256] 的位图
        //    - 优点：支持并行，节省gas（批量验证）
        //    - 缺点：实现复杂，需要位操作
        // 
        // 当前实现采用单次递增策略，确保安全性优先
        // 如需支持并行签名，可考虑升级为bitmap策略

        // ============ 预留字段，供未来扩展，防止 storage collision ============
        uint256[50] __gap;
    }

    struct PendingUpgrade {
        address newAddr;           // 新模块地址
        uint256 executeAfter;      // 执行时间戳
        address proposer;          // 提议者地址
        uint256 minDelaySnapshot;  // 提议时的minDelay快照，防止后续规则变更影响已排队的升级
        // 设计说明：
        // - proposer: 记录谁提议的升级，便于审计和权限管理
        // - minDelaySnapshot: 防止在升级排队期间修改minDelay规则
        //   例如：原minDelay=1天，升级排队后有人改为7天，可能导致意外延迟
        //   通过快照确保升级按提议时的规则执行
    }

    struct UpgradeHistory {
        address oldAddress;        // 旧地址
        address newAddress;        // 新地址
        uint256 timestamp;         // 升级时间戳
        address executor;          // 执行者地址
        // 注意：移除了 txHash 字段，因为 EVM 无法直接获取当前交易哈希
        // 交易哈希信息可通过事件中的 txHash 参数由外部索引器填充
        // 这样设计更符合 EVM 的限制，避免存储无用数据
    }

    // ============ 存储槽位常量 ============
    /// @dev 存储槽位标识符，版本化以防止存储冲突
    /// @dev 如需升级存储结构，请变更此常量字符串为新的版本（v2）
    /// @dev 并在实现合约中添加迁移逻辑
    bytes32 internal constant STORAGE_SLOT = keccak256("registry.storage.v1");

    // ============ 存储版本常量 ============
    uint256 internal constant CURRENT_STORAGE_VERSION = 1;

    // ============ 存储访问函数 ============
    /// @notice 获取存储布局
    /// @return l 存储布局引用
    /// @dev 使用钻石存储模式，确保存储布局稳定
    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = STORAGE_SLOT;
        assembly {
            l.slot := slot
        }
    }

    // ============ 存储版本管理 ============
    /// @notice 检查存储版本兼容性（严格相等）
    /// @param expectedVersion 期望的存储版本
    /// @dev 使用严格相等确保强制迁移，防止意外兼容性问题
    function requireCompatibleVersion(uint256 expectedVersion) internal view {
        require(
            layout().storageVersion == expectedVersion,
            "RegistryStorage: incompatible storage version"
        );
    }

    /// @notice 统一初始化存储（一次性），设置 version + admin + minDelay
    /// @param admin_ 治理地址
    /// @param minDelay_ 最小延迟时间
    /// @dev 确保关键字段一次性设置并做检查，防止遗漏
    function initializeRegistryStorage(address admin_, uint256 minDelay_) internal {
        if (admin_ == address(0)) revert ZeroAddress();
        Layout storage l = layout();
        if (l.storageVersion != 0) revert AlreadyInitialized();

        // 防止 uint64 截断
        if (minDelay_ > type(uint64).max) revert MinDelayOverflow(minDelay_);
        // 可选额外防错：对业务上界做检查（与 validateStorageLayout 保持一致）
        if (minDelay_ > 365 days * 10) revert MinDelayTooLarge(minDelay_, 365 days * 10);

        l.storageVersion = CURRENT_STORAGE_VERSION;
        l.admin = admin_;
        l.pendingAdmin = address(0);
        l.paused = 0; // uint8 0 = false
        l.minDelay = uint64(minDelay_);
        // nonces mapping 默认为 0，无需初始化
    }

    /// @notice 仅在第一次初始化时设置 storageVersion（防重复初始化）
    /// @dev 如果意外调用或被错误的实现合约重复调用，会revert而不是覆盖已有值
    function initializeStorageVersion() internal {
        if (layout().storageVersion != 0) revert AlreadyInitialized();
        layout().storageVersion = CURRENT_STORAGE_VERSION;
    }

    /// @notice 升级存储版本（必须大于当前版本）
    /// @param newVersion 新的存储版本
    /// @dev 确保版本递增，防止降级或重复升级
    /// @dev ⚠️ 警告：此函数应在治理/迁移逻辑经审查的合约中调用
    /// @dev 调用前必须进行迁移与备份，确保数据完整性
    function upgradeStorageVersion(uint256 newVersion) internal {
        uint256 cur = layout().storageVersion;
        if (cur == 0) revert NotInitialized();
        if (newVersion <= cur) revert InvalidStorageVersion(newVersion);
        layout().storageVersion = newVersion;
    }

    /// @notice 获取当前存储版本
    /// @return 当前存储版本
    function getStorageVersion() internal view returns (uint256) {
        return layout().storageVersion;
    }

    /// @notice 检查是否已初始化
    /// @return 是否已初始化
    function isInitialized() internal view returns (bool) {
        return layout().storageVersion != 0;
    }

    // ============ 存储管理辅助函数 ============
    /// @notice 获取当前治理地址
    /// @return 当前治理地址
    function getAdmin() internal view returns (address) {
        return layout().admin;
    }

    /// @notice 获取当前暂停状态
    /// @return 是否已暂停
    function isPaused() internal view returns (bool) {
        return layout().paused != 0;
    }

    /// @notice 获取当前最小延迟
    /// @return 当前最小延迟（uint256，底层存储为 uint64，自动扩展）
    /// @dev 底层存储为 uint64，返回时自动扩展为 uint256，安全且兼容
    function getMinDelay() internal view returns (uint256) {
        return layout().minDelay;
    }

    /// @notice 检查地址是否为非零地址（纯工具函数）
    /// @param addr 待检查地址
    /// @return 是否为非零地址
    /// @dev 通用工具函数，用于地址有效性检查
    function isNonZeroAddress(address addr) internal pure returns (bool) {
        return addr != address(0);
    }

    /// @notice 检查指定地址是否为当前治理地址
    /// @param addr 待检查地址
    /// @return 是否为当前治理地址
    /// @dev 用于权限验证，检查传入地址是否匹配当前admin
    function isAdmin(address addr) internal view returns (bool) {
        return layout().admin == addr;
    }

    /// @notice 要求指定地址为当前治理地址，否则revert
    /// @param addr 待检查地址
    /// @dev 用于权限验证，失败时提供清晰的错误信息
    function requireAdmin(address addr) internal view {
        if (!isAdmin(addr)) revert NotGovernance();
    }

    /// @notice 要求当前调用者为治理地址，否则revert
    /// @dev 便利函数，用于大多数基于 msg.sender 的权限验证
    function requireAdminMsgSender() internal view {
        if (!isAdmin(msg.sender)) revert NotGovernance();
    }

    /// @notice 验证存储布局完整性
    /// @dev 用于升级时验证存储布局是否正确
    /// @dev 包含基本的安全检查，防止关键字段被意外清空
    /// @dev 建议：在治理函数（如 setMinDelay）中也做相同的上界检查，实现双重保险
    function validateStorageLayout() internal view {
        Layout storage l = layout();
        if (l.storageVersion == 0) revert NotInitialized();
        if (l.admin == address(0)) revert ZeroAddress();
        
        // 可选但有用的额外检查
        if (l.minDelay > 365 days * 10) revert MinDelayTooLarge(l.minDelay, 365 days * 10); // 防止异常大的延迟
        
        // 注意：如果需要检查关键模块是否已设置，可以在这里添加
        // 例如：require(l.modules[KEY_ACCESS_CONTROL] != address(0), "RegistryStorage: missing access control");
        // 但这需要在部署时根据实际情况决定是否启用
    }
} 
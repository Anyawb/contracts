// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { IRewardManager } from "../../../interfaces/IRewardManager.sol";
import { VaultMath } from "../../VaultMath.sol";
import { DegradationMonitor as GracefulDegradationMonitor } from "../../../monitor/DegradationMonitor.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";

/**
 * @title StatisticsView 统计视图模块 / Aggregated Statistics View
 * @notice 提供系统级别的关键统计数据（用户活跃度、抵押/债务汇总、降级信息、奖励速率等），全部为 0 gas 的只读接口。
 * @dev 新架构：本合约在 View 层承接“系统级聚合统计”的缓存存储（例如活跃用户数、全局抵押/债务汇总、保证金聚合），
 *      并提供写入推送接口（业务模块入口统一推送），查询均为 view（0 gas）。
 *
 * 用途概述（Purpose）：
 * 1. 前端 / 数据看板：快速拉取系统聚合数据，无需多次 RPC 调用。
 * 2. 监控服务：订阅 DegradationStatsCached 事件，实时掌握系统降级概况。
 *
 * Security – 安全注意：
 * - 仅在 Registry 设置完成后才能调用（onlyValidRegistry）。
 * - pushDegradationStats 受 AccessControl 管理（ACTION_ADMIN / ACTION_VIEW_SYSTEM_STATUS / owner）。
 *
 * @custom:security-contact security@example.com
 */
contract StatisticsView is Initializable, UUPSUpgradeable {
    // ======== Vault Global Statistics (migrated from VaultStatistics) ========
    /// @notice 用户快照结构体（保持与原 VaultStatistics 一致，便于平滑迁移）
    struct UserSnapshot {
        uint256 collateral;      // 抵押数量
        uint256 debt;            // 债务数量
        uint256 ltv;             // 贷款价值比（bps）
        uint256 healthFactor;    // 健康因子（bps）
        uint256 timestamp;       // 快照时间戳
        bool isActive;           // 是否活跃
    }

    /// @notice 全局统计快照结构体（保持与原 VaultStatistics 一致）
    struct GlobalSnapshot {
        uint256 totalCollateral;       // 总抵押价值
        uint256 totalDebt;             // 总债务价值
        uint256 averageLTV;            // 平均贷款价值比（bps）
        uint256 averageHealthFactor;   // 平均健康因子（bps）
        uint256 activeUsers;           // 活跃用户数
        uint256 timestamp;             // 快照时间戳
    }

    struct GlobalStatistics {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateTime;
    }

    struct RewardStats { uint256 rewardRate; uint256 totalRewardPoints; }

    // ======== Graceful Degradation Stats ========
    struct GracefulDegradationStats {
        uint256 totalDegradations;
        uint256 lastDegradationTime;
        address lastDegradedModule;
        bytes32 lastDegradationReasonHash;
        uint256 fallbackValueUsed;
        uint256 totalFallbackValue;
        uint256 averageFallbackValue;
    }

    GracefulDegradationStats private _degradationStats;

    // ======== Storage: Aggregated Stats Cache ========
    /// @notice 活跃用户数量
    uint256 private _activeUsers;
    /// @notice 用户快照映射：user => UserSnapshot
    mapping(address => UserSnapshot) private _userSnapshots;
    /// @notice 用户活跃状态
    mapping(address => bool) private _userActiveStatus;
    /// @notice 用户最后活跃时间
    mapping(address => uint256) private _userLastActiveTime;
    /// @notice 用户保证金（user => asset => amount）
    mapping(address => mapping(address => uint256)) private _userGuarantees;
    /// @notice 资产总保证金（asset => totalAmount）
    mapping(address => uint256) private _totalGuaranteesByAsset;
    /// @notice 全局统计快照
    GlobalSnapshot private _globalSnapshot;
    /// @notice 最后全局更新时间戳
    uint256 private _lastGlobalUpdate;

    /// @notice 系统级降级统计更新事件，供离链监控使用
    event DegradationStatsCached(
        uint256 totalDegradations,
        uint256 lastDegradationTime,
        address indexed lastDegradedModule,
        bytes32 indexed reasonHash,
        uint256 fallbackValueUsed,
        uint256 totalFallbackValue,
        uint256 averageFallbackValue,
        uint256 timestamp
    );

    // Registry contract address (private per §340-348 naming standard)
    address private _registryAddr;

    // ======== Modifiers ========
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /// @notice 统一权限验证：通过 Registry 解析 ACM 并校验角色
    modifier onlyRole(bytes32 actionKey) {
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acm).requireRole(actionKey, msg.sender);
        _;
    }

    // ======== Init ========
    /**
     * @notice 初始化 StatisticsView
     * @dev 只能调用一次（OpenZeppelin Initializable）
     * @param initialRegistryAddr Registry 合约地址
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;

        // 初始化全局快照（与原 VaultStatistics 对齐）
        _globalSnapshot = GlobalSnapshot({
            totalCollateral: 0,
            totalDebt: 0,
            averageLTV: 0,
            averageHealthFactor: 0,
            activeUsers: 0,
            timestamp: block.timestamp
        });
    }

    // ======== Read APIs ========

    /**
     * @notice 获取全局 Vault 统计快照 / Get aggregated Vault statistics
     * @return g 参见 GlobalStatistics 结构体
     */
    function getGlobalStatistics() external view returns (GlobalStatistics memory g) {
        // 直接返回本地缓存，KEY_STATS 将在部署层映射到本合约地址
        GlobalSnapshot memory s = _globalSnapshot;
        g.activeUsers      = s.activeUsers;
        g.totalCollateral = s.totalCollateral;
        g.totalDebt       = s.totalDebt;
        g.lastUpdateTime  = s.timestamp;
    }

    /**
     * @notice 获取奖励系统统计信息 / Get reward-system statistics
     * @return r RewardStats 结构体，包含 rewardRate、totalRewardPoints（可选）
     */
    function getRewardStats() external view returns (RewardStats memory r) {
        address rm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        try IRewardManager(rm).getRewardRate() returns (uint256 rate) { r.rewardRate = rate; } catch {}
        // totalRewardPoints optional – ignore if interface missing
    }

    // -------- Degradation Stats --------
    /**
     * @notice 写入最新的系统降级统计（仅监控模块调用）
     * @dev 触发 DegradationStatsCached & DataPushLibrary._emitData 事件；不存储历史，仅覆盖最新快照。
     * @param s GracefulDegradationStats 结构体
     */
    function pushDegradationStats(GracefulDegradationStats calldata s) external onlyValidRegistry {
        // 仅允许通过 Registry 权限控制（ACTION_ADMIN or ACTION_VIEW_SYSTEM_STATUS）
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        bool hasAdmin = IAccessControlManager(acm).hasRole(ActionKeys.ACTION_ADMIN, msg.sender);
        bool hasView  = IAccessControlManager(acm).hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS, msg.sender);
        bool isOwner  = msg.sender == IAccessControlManager(acm).owner();
        require(hasAdmin || hasView || isOwner, "StatsView: no permission");

        _degradationStats = s;

        emit DegradationStatsCached(
            s.totalDegradations,
            s.lastDegradationTime,
            s.lastDegradedModule,
            s.lastDegradationReasonHash,
            s.fallbackValueUsed,
            s.totalFallbackValue,
            s.averageFallbackValue,
            block.timestamp
        );
        // Push to generic data bus
        DataPushLibrary._emitData(keccak256("DEGRADATION_STATS_UPDATE"), abi.encode(s));
    }

    /**
     * @notice 获取最近一次系统降级统计快照 / Get last recorded degradation stats
     * @return 最近一次降级统计
     */
    function getDegradationStats() external view returns (GracefulDegradationStats memory) {
        return _degradationStats;
    }

    // ======== Write APIs: Unified push interfaces from business modules ========
    /// @notice 转发：清算单条更新（统一从业务层通过 View 写入）
    /// @dev 写入白名单：仅允许 KEY_LIQUIDATION_MANAGER 调用；内部转发至 KEY_LIQUIDATION_VIEW
    /// @param user 被清算用户地址
    /// @param collateralAsset 抵押资产地址
    /// @param debtAsset 债务资产地址
    /// @param collateralAmount 扣押抵押物数量
    /// @param debtAmount 减少债务数量
    /// @param liquidator 清算人地址
    /// @param bonus 清算奖励（如有）
    /// @param ts 业务发生时间戳
    function forwardPushLiquidationUpdate(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        uint256 ts
    ) external onlyValidRegistry {
        address lm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_MANAGER);
        require(msg.sender == lm, "only LM");
        address eventsView = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_VIEW);
        // 转发到 LiquidatorView（单点推送）
        (bool ok, ) = eventsView.call(
            abi.encodeWithSignature(
                "pushLiquidationUpdate(address,address,address,uint256,uint256,address,uint256,uint256)",
                user, collateralAsset, debtAsset, collateralAmount, debtAmount, liquidator, bonus, ts
            )
        );
        require(ok, "pushLiquidationUpdate failed");
    }

    /// @notice 转发：清算批量更新（统一从业务层通过 View 写入）
    /// @dev 写入白名单：仅允许 KEY_LIQUIDATION_MANAGER 调用；内部转发至 KEY_LIQUIDATION_VIEW
    /// @param users 被清算用户地址数组
    /// @param collateralAssets 抵押资产地址数组
    /// @param debtAssets 债务资产地址数组
    /// @param collateralAmounts 扣押抵押物数量数组
    /// @param debtAmounts 减少债务数量数组
    /// @param liquidator 清算人地址
    /// @param bonuses 清算奖励数组（与 users 对应，可为空值占位）
    /// @param ts 业务发生时间戳
    function forwardPushBatchLiquidationUpdate(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        address liquidator,
        uint256[] calldata bonuses,
        uint256 ts
    ) external onlyValidRegistry {
        address lm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_MANAGER);
        require(msg.sender == lm, "only LM");
        address eventsView = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_VIEW);
        (bool ok, ) = eventsView.call(
            abi.encodeWithSignature(
                "pushBatchLiquidationUpdate(address[],address[],address[],uint256[],uint256[],address,uint256[],uint256)",
                users, collateralAssets, debtAssets, collateralAmounts, debtAmounts, liquidator, bonuses, ts
            )
        );
        require(ok, "pushBatchLiquidationUpdate failed");
    }
    /// @notice 业务入口统一推送用户统计变更，保持活跃用户计数一致更新
    /// @dev 与原 updateUserStats 语义保持一致；仅权限角色可调用
    function pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay
    ) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (user == address(0)) revert ZeroAddress();

        // 更新用户快照（基于增量）
        UserSnapshot storage snap = _userSnapshots[user];
        if (collateralIn > 0) {
            snap.collateral += collateralIn;
        }
        if (collateralOut > 0) {
            snap.collateral = snap.collateral > collateralOut ? snap.collateral - collateralOut : 0;
        }
        if (borrow > 0) {
            snap.debt += borrow;
        }
        if (repay > 0) {
            snap.debt = snap.debt > repay ? snap.debt - repay : 0;
        }
        // 计算派生指标
        snap.ltv = VaultMath.calculateLTV(snap.debt, snap.collateral);
        snap.healthFactor = VaultMath.calculateHealthFactor(snap.collateral, snap.debt);
        snap.timestamp = block.timestamp;

        // 更新用户活跃时间
        _userLastActiveTime[user] = block.timestamp;

        // 活跃用户计数：严格以仓位>0 为准
        bool wasActive = _userActiveStatus[user];
        bool isActive = (snap.collateral > 0 || snap.debt > 0);
        if (wasActive != isActive) {
            _userActiveStatus[user] = isActive;
            if (isActive) {
                _activeUsers += 1;
            } else if (_activeUsers > 0) {
                _activeUsers -= 1;
            }
        }

        // 维护全局抵押/债务（使用增量）
        if (collateralIn > 0) {
            _globalSnapshot.totalCollateral += collateralIn;
        }
        if (collateralOut > 0) {
            uint256 tc = _globalSnapshot.totalCollateral;
            _globalSnapshot.totalCollateral = tc > collateralOut ? tc - collateralOut : 0;
        }
        if (borrow > 0) {
            _globalSnapshot.totalDebt += borrow;
        }
        if (repay > 0) {
            uint256 td = _globalSnapshot.totalDebt;
            _globalSnapshot.totalDebt = td > repay ? td - repay : 0;
        }

        // 更新时间戳与活跃人数到快照
        _globalSnapshot.activeUsers = _activeUsers;
        _globalSnapshot.timestamp = block.timestamp;
        _lastGlobalUpdate = block.timestamp;
    }

    /// @notice 兼容旧接口：updateUserStats（调用 pushUserStatsUpdate）
    function updateUserStats(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay
    ) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        this.pushUserStatsUpdate(user, collateralIn, collateralOut, borrow, repay);
    }

    /// @notice 推送保证金统计更新（锁定/释放）
    function pushGuaranteeUpdate(
        address user,
        address asset,
        uint256 amount,
        bool isLocked
    ) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();

        if (isLocked) {
            _userGuarantees[user][asset] += amount;
            _totalGuaranteesByAsset[asset] += amount;
        } else {
            uint256 cur = _userGuarantees[user][asset];
            uint256 rel = amount > cur ? cur : amount;
            if (rel > 0) {
                _userGuarantees[user][asset] -= rel;
                _totalGuaranteesByAsset[asset] -= rel;
            }
        }
        _lastGlobalUpdate = block.timestamp;
    }

    /// @notice 兼容旧接口：updateGuaranteeStats（调用 pushGuaranteeUpdate）
    function updateGuaranteeStats(
        address user,
        address asset,
        uint256 guaranteeAmount,
        bool isLocked
    ) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        this.pushGuaranteeUpdate(user, asset, guaranteeAmount, isLocked);
    }

    /// @notice 记录用户快照时间（轻量化版本，供链下消费）
    function recordSnapshot(address user) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (user == address(0)) revert ZeroAddress();
        _userLastActiveTime[user] = block.timestamp;
        _globalSnapshot.timestamp = block.timestamp;
        _lastGlobalUpdate = block.timestamp;
    }

    // ======== Read APIs (global/user getters) ========
    function getGlobalSnapshot() external view returns (GlobalSnapshot memory s) {
        return _globalSnapshot;
    }

    function isUserActive(address user) external view returns (bool) {
        return _userActiveStatus[user];
    }

    function getUserLastActiveTime(address user) external view returns (uint256) {
        return _userLastActiveTime[user];
    }

    function getUserGuaranteeBalance(address user, address asset) external view returns (uint256) {
        return _userGuarantees[user][asset];
    }

    function getTotalGuaranteeByAsset(address asset) external view returns (uint256) {
        return _totalGuaranteesByAsset[asset];
    }

    function getActiveUsers() external view returns (uint256) {
        return _activeUsers;
    }

    function getLastGlobalUpdate() external view returns (uint256) {
        return _lastGlobalUpdate;
    }

    // ======== UUPS ========
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acm).requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        require(newImplementation!=address(0),"StatsView: zero impl");
    }
} 
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { VaultMath } from "../../VaultMath.sol";
import { DegradationMonitor as GracefulDegradationMonitor } from "../../../monitor/DegradationMonitor.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

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
contract StatisticsView is Initializable, UUPSUpgradeable, ViewVersioned {
    // ======== Errors ========
    error StatisticsView__StaleUserStatsVersion(uint64 currentVersion, uint64 incomingVersion);
    error StatisticsView__ZeroImplementation();
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
    /// @notice 用户统计版本号（顺序/幂等校验）
    mapping(address => uint64) private _userStatsVersion;
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

    /// @notice storage gap for upgrade safety
    uint256[50] private __gap;

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    // ======== Modifiers ========
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /// @notice 统一权限验证：通过 Registry 解析 ACM 并校验角色
    modifier onlyRole(bytes32 actionKey) {
        ViewAccessLib.requireRole(_registryAddr, actionKey, msg.sender);
        _;
    }

    // ======== Init ========
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

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
     * @dev RewardManager 的只读查询入口已移除；奖励只读统一通过 RewardView / RewardPoints 等模块读取。
     * @return r RewardStats 结构体（当前仅保留 totalRewardPoints 的可选统计；rewardRate 固定为 0）
     */
    function getRewardStats() external view onlyValidRegistry returns (RewardStats memory r) {
        // rewardRate 语义已废弃，保持 0
        r.rewardRate = 0;
        // best-effort：统计总积分供应量（RewardPoints.totalSupply），模块缺失则返回 0
        address rp = _getModule(ModuleKeys.KEY_REWARD_POINTS);
        if (rp == address(0)) return r;
        try IRewardPointsSupply(rp).totalSupply() returns (uint256 s) { r.totalRewardPoints = s; } catch {}
    }

    // -------- Degradation Stats --------
    /**
     * @notice 写入最新的系统降级统计（仅监控模块调用）
     * @dev 触发 DegradationStatsCached & DataPushLibrary._emitData 事件；不存储历史，仅覆盖最新快照。
     * @param s GracefulDegradationStats 结构体
     */
    function pushDegradationStats(GracefulDegradationStats calldata s) external onlyValidRegistry {
        // 仅允许通过 Registry 权限控制（ACTION_ADMIN or ACTION_VIEW_SYSTEM_STATUS）
        // allow admin; otherwise要求系统状态查看权限
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_STATUS, msg.sender);
        }

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
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_DEGRADATION_STATS_UPDATE, abi.encode(s));
    }

    /**
     * @notice 获取最近一次系统降级统计快照 / Get last recorded degradation stats
     * @return 最近一次降级统计
     */
    function getDegradationStats() external view returns (GracefulDegradationStats memory) {
        return _degradationStats;
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
        _pushUserStatsUpdate(user, collateralIn, collateralOut, borrow, repay, 0);
    }

    /// @notice 业务入口统一推送用户统计变更（携带 nextVersion）
    function pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay,
        uint64 nextVersion
    ) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        _pushUserStatsUpdate(user, collateralIn, collateralOut, borrow, repay, nextVersion);
    }

    function _pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay,
        uint64 nextVersion
    ) internal {
        if (user == address(0)) revert ZeroAddress();

        uint64 currentVersion = _userStatsVersion[user];
        uint64 newVersion = nextVersion;
        if (nextVersion == 0) {
            newVersion = currentVersion + 1;
        } else {
            // strict: nextVersion must be exactly current+1
            if (nextVersion != currentVersion + 1) revert StatisticsView__StaleUserStatsVersion(currentVersion, nextVersion);
        }
        _userStatsVersion[user] = newVersion;

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

    /// @notice 当前 Registry 地址
    function registryAddr() external view returns (address) {
        return _registryAddr;
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
    function _getModule(bytes32 key) internal view returns (address moduleAddr) {
        moduleAddr = Registry(_registryAddr).getModule(key);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert StatisticsView__ZeroImplementation();
    }
} 

/// @dev RewardPoints 最小只读接口（避免直接依赖完整实现）
interface IRewardPointsSupply {
    function totalSupply() external view returns (uint256);
}
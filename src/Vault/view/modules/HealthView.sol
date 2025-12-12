// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { DegradationMonitor as GracefulDegradationMonitor } from "../../../monitor/DegradationMonitor.sol";
import { DegradationCore as GracefulDegradationCore } from "../../../monitor/DegradationCore.sol";
import { DegradationStorage as GracefulDegradationStorage } from "../../../monitor/DegradationStorage.sol";
import { ModuleHealthView } from "./ModuleHealthView.sol";

/// @title HealthView
/// @notice Minimal user health-factor view. Provides gas-free helpers for front-end and bots.
contract HealthView is Initializable, UUPSUpgradeable {
    // ============ Events ============
    event HealthFactorCached(address indexed user, uint256 healthFactor, uint256 timestamp);
    /// @notice 模块健康缓存事件 - 便于离链监控索引
    /// @param module   模块地址
    /// @param isHealthy 是否健康
    /// @param detailsHash  详情哈希（离链解码）
    /// @param failures 连续失败次数
    /// @param timestamp 当前区块时间戳
    event ModuleHealthCached(address indexed module, bool isHealthy, bytes32 detailsHash, uint32 failures, uint256 timestamp);

    // =========================  Errors  =========================
    error HealthView__RegistryNotSet();
    error HealthView__CallerNotAuthorized();

    // ============ Storage ============
    address private _registryAddr;

    // --- User health-factor cache ---
    mapping(address => uint256) private _healthFactorCache;
    mapping(address => uint256) private _cacheTimestamps;

    // --- Module health cache (new) ---
    struct ModuleHealth {
        bool    isHealthy;
        bytes32 detailsHash;
        uint32  lastCheckTime;
        uint32  consecutiveFailures;
    }

    mapping(address => ModuleHealth) private _moduleHealth;

    // constants now come from ViewConstants

    // ============ Modifiers ============
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert HealthView__RegistryNotSet();
        _;
    }

    modifier onlyAuthorizedPusher() {
        if (!_isAuthorizedPusher(msg.sender)) revert HealthView__CallerNotAuthorized();
        _;
    }

    /// @dev Allow ModuleHealthView or admin to push module health status
    modifier onlyModuleHealthPusher() {
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        if (!IAccessControlManager(acm).hasRole(ActionKeys.ACTION_ADMIN, msg.sender) && msg.sender != IAccessControlManager(acm).owner()) {
            revert("HealthView: no permission");
        }
        _;
    }

    // ============ Initializer ============
    function initialize(address initialRegistryAddr) external initializer {
        require(initialRegistryAddr != address(0), "HealthView: zero registry");
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ============ Push API ============
    /// @notice Push latest healthFactor (legacy). 推荐使用 pushRiskStatus。
    function pushHealthFactor(address user, uint256 healthFactor) external onlyValidRegistry onlyAuthorizedPusher {
        _healthFactorCache[user] = healthFactor;
        _cacheTimestamps[user]   = block.timestamp;
        emit HealthFactorCached(user, healthFactor, block.timestamp);
        // Push to generic data stream
        DataPushLibrary._emitData(keccak256("HEALTH_FACTOR_UPDATE"), abi.encode(user, healthFactor));
    }

    /// @notice 推送完整风险状态（推荐）
    /// @param user 用户地址
    /// @param healthFactorBps 健康因子（bps）
    /// @param minHFBps 最小健康因子阈值（bps）
    /// @param undercollateralized 是否低于阈值
    /// @param timestamp 时间戳
    function pushRiskStatus(
        address user,
        uint256 healthFactorBps,
        uint256 minHFBps,
        bool undercollateralized,
        uint256 timestamp
    ) external onlyValidRegistry onlyAuthorizedPusher {
        _healthFactorCache[user] = healthFactorBps;
        _cacheTimestamps[user] = timestamp == 0 ? block.timestamp : timestamp;
        emit HealthFactorCached(user, healthFactorBps, _cacheTimestamps[user]);
        DataPushLibrary._emitData(keccak256("RISK_STATUS_UPDATE"), abi.encode(user, healthFactorBps, minHFBps, undercollateralized, _cacheTimestamps[user]));
    }

    /// @notice 批量推送风险状态（推荐 keeper/监控调用）
    function pushRiskStatusBatch(
        address[] calldata users,
        uint256[] calldata healthFactorsBps,
        uint256[] calldata minHFsBps,
        bool[] calldata underFlags,
        uint256 timestamp
    ) external onlyValidRegistry onlyAuthorizedPusher {
        require(
            users.length == healthFactorsBps.length &&
            users.length == minHFsBps.length &&
            users.length == underFlags.length,
            "HealthView: array length mismatch"
        );
        uint256 len = users.length;
        uint256 ts = timestamp == 0 ? block.timestamp : timestamp;
        for (uint256 i; i < len; ++i) {
            address u = users[i];
            _healthFactorCache[u] = healthFactorsBps[i];
            _cacheTimestamps[u] = ts;
            emit HealthFactorCached(u, healthFactorsBps[i], ts);
        }
        DataPushLibrary._emitData(keccak256("RISK_STATUS_UPDATE_BATCH"), abi.encode(users, healthFactorsBps, minHFsBps, underFlags, ts));
    }

    /// @notice Push latest module health status
    function pushModuleHealth(
        address module,
        bool isHealthy,
        bytes32 detailsHash,
        uint32 consecutiveFailures
    ) external onlyValidRegistry onlyModuleHealthPusher {
        ModuleHealth storage mh = _moduleHealth[module];
        mh.isHealthy = isHealthy;
        mh.detailsHash = detailsHash;
        mh.consecutiveFailures = consecutiveFailures;
        mh.lastCheckTime = uint32(block.timestamp);

        emit ModuleHealthCached(module, isHealthy, detailsHash, consecutiveFailures, block.timestamp);
        // Push to generic data stream
        DataPushLibrary._emitData(keccak256("MODULE_HEALTH_UPDATE"), abi.encode(module, isHealthy, detailsHash, consecutiveFailures));
    }

    /// @notice Get cached module health
    function getModuleHealth(address module) external view returns (ModuleHealth memory) {
        return _moduleHealth[module];
    }

    // ============ Read APIs ============
    function getUserHealthFactor(address user) external view returns (uint256 healthFactor, bool isValid) {
        healthFactor = _healthFactorCache[user];
        isValid      = _isValid(_cacheTimestamps[user]);
    }

    function isUserLiquidatable(address user) external view returns (bool) {
        (uint256 hf, bool valid) = this.getUserHealthFactor(user);
        if (!valid) return false; // fall back to safe
        return hf < 1e18;
    }

    function batchGetHealthFactors(address[] calldata users) external view returns (uint256[] memory factors, bool[] memory validFlags) {
        require(users.length <= ViewConstants.MAX_BATCH_SIZE, "HealthView: batch too large");
        uint256 len = users.length;
        factors     = new uint256[](len);
        validFlags  = new bool[](len);
        for (uint256 i; i < len; ++i) {
            factors[i]    = _healthFactorCache[users[i]];
            validFlags[i] = _isValid(_cacheTimestamps[users[i]]);
        }
    }

    // ============ Internal helpers ============
    function _isValid(uint256 ts) internal view returns (bool) {
        return ts > 0 && block.timestamp - ts <= ViewConstants.CACHE_DURATION;
    }

    function _isAuthorizedPusher(address caller) internal view returns (bool) {
        address vbl = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC);
        if (caller == vbl) return true;
        address le = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        if (caller == le) return true;
        address lrm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        if (caller == lrm) return true;
        address lm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_MANAGER);
        if (caller == lm) return true;
        return false;
    }

    // ============ UUPS ============
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acm).requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        require(newImplementation != address(0), "HealthView: zero impl");
    }

    /// @notice 兼容旧版 getter
    function registryAddr() external view returns(address){return _registryAddr;}

    // ============ System Health (migrated from SystemHealthView) ============
    modifier onlySystemHealthViewer() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_STATUS, msg.sender);
        _;
    }

    function getGracefulDegradationStats() external view returns (GracefulDegradationCore.DegradationStats memory stats) {
        address mon = Registry(_registryAddr).getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (mon == address(0)) {
            return GracefulDegradationCore.DegradationStats({
                totalDegradations: 0,
                lastDegradationTime: 0,
                lastDegradedModule: address(0),
                lastDegradationReasonHash: bytes32(0),
                fallbackValueUsed: 0,
                totalFallbackValue: 0,
                averageFallbackValue: 0
            });
        }
        return GracefulDegradationMonitor(mon).getGracefulDegradationStats();
    }

    function getModuleHealthStatus(address module) external view returns (ModuleHealthView.ModuleHealthStatus memory healthStatus) {
        address mon = Registry(_registryAddr).getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (mon == address(0)) {
            return ModuleHealthView.ModuleHealthStatus({
                module: module,
                isHealthy: false,
                detailsHash: bytes32(0),
                lastCheckTime: 0,
                consecutiveFailures: 0,
                totalChecks: 0,
                successRate: 0
            });
        }
        return GracefulDegradationMonitor(mon).getModuleHealthStatus(module);
    }

    function getSystemDegradationHistory(uint256 limit) external view returns (GracefulDegradationStorage.DegradationEvent[] memory history) {
        address mon = Registry(_registryAddr).getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (mon == address(0)) {
            return new GracefulDegradationStorage.DegradationEvent[](0);
        }
        return GracefulDegradationMonitor(mon).getSystemDegradationHistory(limit);
    }

    function checkModuleHealth(address module) external view returns (bool isHealthy, string memory details) {
        address mon = Registry(_registryAddr).getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (mon == address(0)) {
            return (false, "No health monitor available");
        }
        return GracefulDegradationMonitor(mon).checkModuleHealth(module);
    }

    function getSystemDegradationTrends() external view returns (
        uint256 totalEvents,
        uint256 recentEvents,
        address mostFrequentModule,
        uint256 averageFallbackValue
    ) {
        address mon = Registry(_registryAddr).getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (mon == address(0)) {
            return (0, 0, address(0), 0);
        }
        return GracefulDegradationMonitor(mon).getSystemDegradationTrends();
    }
} 
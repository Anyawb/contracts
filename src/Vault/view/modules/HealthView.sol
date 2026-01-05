// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { DegradationMonitor as GracefulDegradationMonitor } from "../../../monitor/DegradationMonitor.sol";
import { DegradationCore as GracefulDegradationCore } from "../../../monitor/DegradationCore.sol";
import { DegradationStorage as GracefulDegradationStorage } from "../../../monitor/DegradationStorage.sol";
import { ModuleHealthView } from "./ModuleHealthView.sol";
import { ZeroAddress, ArrayLengthMismatch } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/// @title HealthView
/// @notice Minimal user health-factor view. Provides gas-free helpers for front-end and bots.
contract HealthView is Initializable, UUPSUpgradeable, ViewVersioned {
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
    error HealthView__CallerNotAuthorized();
    error HealthView__BatchTooLarge();
    error HealthView__EmptyBatch();

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
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    modifier onlyViewPusher() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_PUSH, msg.sender);
        _;
    }

    modifier onlyModuleHealthPusher() {
        if (
            !_hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS, msg.sender) &&
            !_hasRole(ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert HealthView__CallerNotAuthorized();
        _;
    }

    modifier onlySystemHealthViewer() {
        if (
            !_hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS, msg.sender) &&
            !_hasRole(ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert HealthView__CallerNotAuthorized();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ============ Push API ============
    /// @notice Push latest healthFactor (legacy). 推荐使用 pushRiskStatus。
    function pushHealthFactor(address user, uint256 healthFactor) external onlyValidRegistry onlyViewPusher {
        _healthFactorCache[user] = healthFactor;
        _cacheTimestamps[user]   = block.timestamp;
        emit HealthFactorCached(user, healthFactor, block.timestamp);
        // Push to generic data stream
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_HEALTH_FACTOR, abi.encode(user, healthFactor));
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
    ) external onlyValidRegistry onlyViewPusher {
        _healthFactorCache[user] = healthFactorBps;
        _cacheTimestamps[user] = timestamp == 0 ? block.timestamp : timestamp;
        emit HealthFactorCached(user, healthFactorBps, _cacheTimestamps[user]);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_RISK_STATUS,
            abi.encode(user, healthFactorBps, minHFBps, undercollateralized, _cacheTimestamps[user])
        );
    }

    /// @notice 批量推送风险状态（推荐 keeper/监控调用）
    function pushRiskStatusBatch(
        address[] calldata users,
        uint256[] calldata healthFactorsBps,
        uint256[] calldata minHFsBps,
        bool[] calldata underFlags,
        uint256 timestamp
    ) external onlyValidRegistry onlyViewPusher {
        if (users.length == 0) revert HealthView__EmptyBatch();
        if (users.length > ViewConstants.MAX_BATCH_SIZE) revert HealthView__BatchTooLarge();
        if (users.length != healthFactorsBps.length) {
            revert ArrayLengthMismatch(users.length, healthFactorsBps.length);
        }
        if (users.length != minHFsBps.length) {
            revert ArrayLengthMismatch(users.length, minHFsBps.length);
        }
        if (users.length != underFlags.length) {
            revert ArrayLengthMismatch(users.length, underFlags.length);
        }
        uint256 len = users.length;
        uint256 ts = timestamp == 0 ? block.timestamp : timestamp;
        for (uint256 i; i < len; ++i) {
            address u = users[i];
            _healthFactorCache[u] = healthFactorsBps[i];
            _cacheTimestamps[u] = ts;
            emit HealthFactorCached(u, healthFactorsBps[i], ts);
        }
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_RISK_STATUS_BATCH,
            abi.encode(users, healthFactorsBps, minHFsBps, underFlags, ts)
        );
    }

    /// @notice Push latest module health status
    function pushModuleHealth(
        address module,
        bool isHealthy,
        bytes32 detailsHash,
        uint32 consecutiveFailures
    ) external onlyValidRegistry onlyModuleHealthPusher {
        if (module == address(0)) revert ZeroAddress();
        ModuleHealth storage mh = _moduleHealth[module];
        mh.isHealthy = isHealthy;
        mh.detailsHash = detailsHash;
        mh.consecutiveFailures = consecutiveFailures;
        mh.lastCheckTime = uint32(block.timestamp);

        emit ModuleHealthCached(module, isHealthy, detailsHash, consecutiveFailures, block.timestamp);
        // Push to generic data stream
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_MODULE_HEALTH,
            abi.encode(module, isHealthy, detailsHash, consecutiveFailures)
        );
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
        return hf < 10_000; // <100% health factor (bps)
    }

    function batchGetHealthFactors(address[] calldata users) external view returns (uint256[] memory factors, bool[] memory validFlags) {
        if (users.length == 0) revert HealthView__EmptyBatch();
        if (users.length > ViewConstants.MAX_BATCH_SIZE) revert HealthView__BatchTooLarge();
        uint256 len = users.length;
        factors     = new uint256[](len);
        validFlags  = new bool[](len);
        for (uint256 i; i < len; ++i) {
            factors[i]    = _healthFactorCache[users[i]];
            validFlags[i] = _isValid(_cacheTimestamps[users[i]]);
        }
    }

    function getCacheTimestamp(address user) external view returns (uint256) {
        return _cacheTimestamps[user];
    }

    // ============ Internal helpers ============
    function _isValid(uint256 ts) internal view returns (bool) {
        return ts > 0 && block.timestamp - ts <= ViewConstants.CACHE_DURATION;
    }

    function _hasRole(bytes32 actionKey, address user) internal view returns (bool) {
        return ViewAccessLib.hasRole(_registryAddr, actionKey, user);
    }

    // ============ UUPS ============
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /// @notice 兼容旧版 getter
    function registryAddr() external view returns(address){return _registryAddr;}
    /// @notice 推荐的新 getter
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    // ============ System Health (migrated from SystemHealthView) ============
    function getGracefulDegradationStats()
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (GracefulDegradationCore.DegradationStats memory stats)
    {
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

    function getModuleHealthStatus(address module)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (ModuleHealthView.ModuleHealthStatus memory healthStatus)
    {
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

    function getSystemDegradationHistory(uint256 limit)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (GracefulDegradationStorage.DegradationEvent[] memory history)
    {
        address mon = Registry(_registryAddr).getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (mon == address(0)) {
            return new GracefulDegradationStorage.DegradationEvent[](0);
        }
        return GracefulDegradationMonitor(mon).getSystemDegradationHistory(limit);
    }

    function checkModuleHealth(address module)
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (bool isHealthy, string memory details)
    {
        address mon = Registry(_registryAddr).getModule(ModuleKeys.KEY_DEGRADATION_MONITOR);
        if (mon == address(0)) {
            return (false, "No health monitor available");
        }
        return GracefulDegradationMonitor(mon).checkModuleHealth(module);
    }

    function getSystemDegradationTrends()
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (
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

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;
} 
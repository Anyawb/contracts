// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// solhint-disable-next-line no-global-import
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
import { ArrayLengthMismatch, BatchTooLarge, EmptyArray, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @title HealthView
 * @notice Risk/health view cache module: caches user health factors and system/module health status for 0-gas reads.
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - caller lacks required view role (via ViewAccessLib / ACM)
 *      - caller lacks required push role (via ViewAccessLib / ACM)
 *      - caller is not authorized for system health operations (HealthView__CallerNotAuthorized)
 *      - batch input is empty (EmptyArray)
 *      - batch size exceeds MAX_BATCH_SIZE (BatchTooLarge)
 *      - batch array lengths mismatch (ArrayLengthMismatch)
 *
 * Security:
 * - Cache writes are restricted via ACTION_VIEW_PUSH and/or system-status/admin roles.
 * - Read entrypoints are role-gated via ViewAccessLib to prevent unauthorized access.
 * - UUPS upgradeability is role-gated (ACTION_ADMIN via ACM).
 */
contract HealthView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when a user's health factor is cached.
     * @param user Target user address
     * @param healthFactor Cached health factor (bps)
     * @param timestamp Cache update timestamp (seconds since epoch)
     */
    event HealthFactorCached(address indexed user, uint256 healthFactor, uint256 timestamp);

    /**
     * @notice Emitted when a module health status is cached for off-chain indexing.
     * @param module Target module address
     * @param isHealthy Whether the module is healthy
     * @param detailsHash Details hash (off-chain resolvable)
     * @param failures Consecutive failure count
     * @param timestamp Cache update timestamp (seconds since epoch)
     */
    event ModuleHealthCached(
        address indexed module,
        bool isHealthy,
        bytes32 detailsHash,
        uint32 failures,
        uint256 timestamp
    );

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Caller is not authorized for the requested system health operation.
    error HealthView__CallerNotAuthorized();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ User health-factor cache ━━━━━━━━━━━━━━━*/
    mapping(address => uint256) private _healthFactorCache;
    mapping(address => uint256) private _cacheTimestamps;

    /*━━━━━━━━━━━━━━━ Module health cache ━━━━━━━━━━━━━━━*/
    // NOTE: Storage layout must remain stable across upgrades; do not reorder fields for packing.
    // solhint-disable-next-line gas-struct-packing
    struct ModuleHealth {
        bool    isHealthy;
        bytes32 detailsHash;
        uint32  lastCheckTime;
        uint32  consecutiveFailures;
    }

    mapping(address => ModuleHealth) private _moduleHealth;

    // constants now come from ViewConstants

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    modifier onlyViewPusher() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_PUSH, msg.sender);
        _;
    }

    /// @notice Risk data viewer (health factor / risk status)
    modifier onlyRiskViewer() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_RISK_DATA, msg.sender);
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

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /**
     * @notice Initialize the HealthView (UUPS).
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *
     * Security:
     * - initializer (UUPS)
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Push APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Push a user's health factor into the cache (legacy entrypoint).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_PUSH role (via onlyViewPusher / ViewAccessLib)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_PUSH
     *
     * @param user Target user address
     * @param healthFactor Health factor (bps)
     */
    function pushHealthFactor(address user, uint256 healthFactor) external onlyValidRegistry onlyViewPusher {
        _healthFactorCache[user] = healthFactor;
        // solhint-disable-next-line not-rely-on-time
        _cacheTimestamps[user]   = block.timestamp;
        // solhint-disable-next-line not-rely-on-time
        emit HealthFactorCached(user, healthFactor, block.timestamp);
        // Push to generic data stream
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_HEALTH_FACTOR, abi.encode(user, healthFactor));
    }

    /**
     * @notice Push a full risk status update into the cache (recommended).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_PUSH role (via onlyViewPusher / ViewAccessLib)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_PUSH
     * - If `timestamp == 0`, the current block timestamp is used.
     *
     * @param user Target user address
     * @param healthFactorBps Health factor (bps, 1e4 = 100%)
     * @param minHFBps Minimum health factor threshold (bps)
     * @param undercollateralized Whether healthFactorBps is below the threshold
     * @param timestamp Cache timestamp override (seconds since epoch; 0 to use block timestamp)
     */
    function pushRiskStatus(
        address user,
        uint256 healthFactorBps,
        uint256 minHFBps,
        bool undercollateralized,
        uint256 timestamp
    ) external onlyValidRegistry onlyViewPusher {
        _healthFactorCache[user] = healthFactorBps;
        // solhint-disable-next-line not-rely-on-time
        _cacheTimestamps[user] = timestamp == 0 ? block.timestamp : timestamp;
        emit HealthFactorCached(user, healthFactorBps, _cacheTimestamps[user]);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_RISK_STATUS,
            abi.encode(user, healthFactorBps, minHFBps, undercollateralized, _cacheTimestamps[user])
        );
    }

    /**
     * @notice Push a batch of risk status updates (recommended for keepers/monitors).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_PUSH role (via onlyViewPusher / ViewAccessLib)
     *      - users is empty (EmptyArray)
     *      - users.length > MAX_BATCH_SIZE (BatchTooLarge)
     *      - input array lengths mismatch (ArrayLengthMismatch)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_PUSH
     * - If `timestamp == 0`, the current block timestamp is used.
     *
     * @param users Target user addresses
     * @param healthFactorsBps Health factors (bps)
     * @param minHFsBps Minimum health factor thresholds (bps)
     * @param underFlags Undercollateralized flags
     * @param timestamp Cache timestamp override (seconds since epoch; 0 to use block timestamp)
     */
    function pushRiskStatusBatch(
        address[] calldata users,
        uint256[] calldata healthFactorsBps,
        uint256[] calldata minHFsBps,
        bool[] calldata underFlags,
        uint256 timestamp
    ) external onlyValidRegistry onlyViewPusher {
        if (users.length == 0) revert EmptyArray();
        if (users.length > ViewConstants.MAX_BATCH_SIZE) revert BatchTooLarge(users.length, ViewConstants.MAX_BATCH_SIZE);
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
        // solhint-disable-next-line not-rely-on-time
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

    /**
     * @notice Push the latest module health status into the cache.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_STATUS and is not an admin (HealthView__CallerNotAuthorized)
     *      - module is zero (ZeroAddress)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_STATUS or ACTION_ADMIN
     *
     * @param module Target module address
     * @param isHealthy Whether the module is healthy
     * @param detailsHash Details hash (off-chain resolvable)
     * @param consecutiveFailures Consecutive failure count
     */
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
        // solhint-disable-next-line not-rely-on-time
        mh.lastCheckTime = uint32(block.timestamp);

        // solhint-disable-next-line not-rely-on-time
        emit ModuleHealthCached(module, isHealthy, detailsHash, consecutiveFailures, block.timestamp);
        // Push to generic data stream
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_MODULE_HEALTH,
            abi.encode(module, isHealthy, detailsHash, consecutiveFailures)
        );
    }

    /**
     * @notice Get cached module health status.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @param module Target module address
     * @return moduleHealth_ Cached module health data
     */
    function getModuleHealth(address module) external view returns (ModuleHealth memory) {
        return _moduleHealth[module];
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get a user's cached health factor, including cache validity and timestamp.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_RISK_DATA permission (via onlyRiskViewer / ViewAccessLib)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA
     *
     * @param user Target user address
     * @return healthFactor Cached health factor (bps)
     * @return isValid Whether the cached value is valid (within CACHE_DURATION)
     * @return timestamp Cache update timestamp (seconds since epoch)
     */
    function getUserHealthFactor(address user)
        external
        view
        onlyValidRegistry
        onlyRiskViewer
        returns (uint256 healthFactor, bool isValid, uint256 timestamp)
    {
        healthFactor = _healthFactorCache[user];
        timestamp = _cacheTimestamps[user];
        isValid = _isValid(timestamp);
    }

    /**
     * @notice Get a user's health factor with cache validity and timestamp (B-class unified output).
     * @dev Reverts if:
     *      - (same as getUserHealthFactor)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA
     *
     * @param user Target user address
     * @return healthFactor Cached health factor (bps)
     * @return isValid Whether the cached value is valid (within CACHE_DURATION)
     * @return timestamp Cache update timestamp (seconds since epoch)
     */
    function getUserHealthFactorWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyRiskViewer
        returns (uint256 healthFactor, bool isValid, uint256 timestamp)
    {
        // NOTE: Do NOT call `this.getUserHealthFactor(user)` here.
        // `this.*` is an external call where msg.sender becomes the HealthView contract itself,
        // which will fail the role gate (VIEW_RISK_DATA) unless the contract is granted that role.
        healthFactor = _healthFactorCache[user];
        timestamp = _cacheTimestamps[user];
        isValid = _isValid(timestamp);
    }

    /**
     * @notice Check whether a user is liquidatable based on cached health factor (best-effort).
     * @dev Reverts if:
     *      - (same as getUserHealthFactor)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA
     * - Conservative: returns false if cache is invalid.
     *
     * @param user Target user address
     * @return isLiquidatable True if cached health factor is valid and below 100% (bps)
     */
    function isUserLiquidatable(address user) external view onlyValidRegistry onlyRiskViewer returns (bool) {
        (uint256 hf, bool valid, ) = this.getUserHealthFactor(user);
        if (!valid) return false; // fall back to safe
        return hf < 10_000; // <100% health factor (bps)
    }

    /**
     * @notice Batch query cached health factors with cache validity and timestamps.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_RISK_DATA permission (via onlyRiskViewer / ViewAccessLib)
     *      - users is empty (EmptyArray)
     *      - users.length > MAX_BATCH_SIZE (BatchTooLarge)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA
     *
     * @param users Target user addresses
     * @return factors Cached health factors (bps)
     * @return validFlags Cache validity flags
     * @return timestamps Cache update timestamps (seconds since epoch)
     */
    function batchGetHealthFactors(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyRiskViewer
        returns (uint256[] memory factors, bool[] memory validFlags, uint256[] memory timestamps)
    {
        if (users.length == 0) revert EmptyArray();
        if (users.length > ViewConstants.MAX_BATCH_SIZE) revert BatchTooLarge(users.length, ViewConstants.MAX_BATCH_SIZE);
        uint256 len = users.length;
        factors     = new uint256[](len);
        validFlags  = new bool[](len);
        timestamps  = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            uint256 ts = _cacheTimestamps[users[i]];
            factors[i] = _healthFactorCache[users[i]];
            timestamps[i] = ts;
            validFlags[i] = _isValid(ts);
        }
    }

    /**
     * @notice Batch query cached health factors with meta (B-class unified output).
     * @dev Reverts if:
     *      - (same as batchGetHealthFactors)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA
     *
     * @param users Target user addresses
     * @return factors Cached health factors (bps)
     * @return validFlags Cache validity flags
     * @return timestamps Cache update timestamps (seconds since epoch)
     */
    function batchGetHealthFactorsWithMeta(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyRiskViewer
        returns (uint256[] memory factors, bool[] memory validFlags, uint256[] memory timestamps)
    {
        // NOTE: Do NOT call `this.batchGetHealthFactors(users)` here for the same reason as above.
        if (users.length == 0) revert EmptyArray();
        if (users.length > ViewConstants.MAX_BATCH_SIZE) revert BatchTooLarge(users.length, ViewConstants.MAX_BATCH_SIZE);
        uint256 len = users.length;
        factors     = new uint256[](len);
        validFlags  = new bool[](len);
        timestamps  = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            uint256 ts = _cacheTimestamps[users[i]];
            factors[i] = _healthFactorCache[users[i]];
            timestamps[i] = ts;
            validFlags[i] = _isValid(ts);
        }
    }

    /**
     * @notice Get the cached timestamp for a user.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_RISK_DATA permission (via onlyRiskViewer / ViewAccessLib)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA
     *
     * @param user Target user address
     * @return timestamp Cache update timestamp (seconds since epoch)
     */
    function getCacheTimestamp(address user) external view onlyValidRegistry onlyRiskViewer returns (uint256) {
        return _cacheTimestamps[user];
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/
    function _isValid(uint256 ts) internal view returns (bool) {
        // solhint-disable-next-line not-rely-on-time
        return ts > 0 && block.timestamp - ts <= ViewConstants.CACHE_DURATION;
    }

    function _hasRole(bytes32 actionKey, address user) internal view returns (bool) {
        return ViewAccessLib.hasRole(_registryAddr, actionKey, user);
    }

    /*━━━━━━━━━━━━━━━ UUPS upgradeability ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize UUPS upgrade (internal, called by upgradeTo/upgradeToAndCall).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN role (MissingRole via ACM)
     *      - newImplementation is zero (ZeroAddress)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
     * - onlyValidRegistry modifier
     * - ACTION_ADMIN role-gated via ACM
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /**
     * @notice Get Registry contract address (legacy getter for backward compatibility).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr_ Registry contract address
     */
    function registryAddr() external view returns (address registryAddr_) {
        return _registryAddr;
    }

    /**
     * @notice Get Registry contract address (legacy getter for backward compatibility).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr_ Registry contract address
     */
    function getRegistry() external view returns (address registryAddr_) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ System health (migrated from SystemHealthView) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get system-wide graceful degradation statistics.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized (HealthView__CallerNotAuthorized)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_STATUS or ACTION_ADMIN
     *
     * @return stats System degradation statistics (zeroed if monitor is not configured)
     */
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

    /**
     * @notice Get cached health status for a module from the degradation monitor.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized (HealthView__CallerNotAuthorized)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_STATUS or ACTION_ADMIN
     *
     * @param module Target module address
     * @return healthStatus Module health status (defaults if monitor is not configured)
     */
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

    /**
     * @notice Get system degradation history from the degradation monitor.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized (HealthView__CallerNotAuthorized)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_STATUS or ACTION_ADMIN
     *
     * @param limit Maximum number of events to return
     * @return history Degradation events (empty if monitor is not configured)
     */
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

    /**
     * @notice Run a module health check via the degradation monitor.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized (HealthView__CallerNotAuthorized)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_STATUS or ACTION_ADMIN
     *
     * @param module Target module address
     * @return isHealthy Whether the module is healthy
     * @return details Human-readable status string (intended for off-chain tools; not for on-chain branching)
     */
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

    /**
     * @notice Get system degradation trends via the degradation monitor.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized (HealthView__CallerNotAuthorized)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_STATUS or ACTION_ADMIN
     *
     * @return totalEvents Total recorded events
     * @return recentEvents Recent event count
     * @return mostFrequentModule Most frequently degraded module
     * @return averageFallbackValue Average fallback value used
     */
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

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the API semantic version for this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return apiVersion_ API semantic version
     */
    function apiVersion() public pure override returns (uint256 apiVersion_) {
        return 1;
    }

    /**
     * @notice Get the output/schema version for this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return schemaVersion_ Schema version
     */
    function schemaVersion() public pure override returns (uint256 schemaVersion_) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    /// @notice Storage gap for future upgrades.
    uint256[50] private __gap;
} 
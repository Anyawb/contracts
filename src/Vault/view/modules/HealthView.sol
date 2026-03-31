// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Registry} from "../../../registry/Registry.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {ViewConstants} from "../ViewConstants.sol";
import {DataPushLibrary} from "../../../libraries/DataPushLibrary.sol";
import {DataPushTypes} from "../../../constants/DataPushTypes.sol";
import {ViewAccessLib} from "../../../libraries/ViewAccessLib.sol";
import {DegradationMonitor as GracefulDegradationMonitor} from "../../../monitor/DegradationMonitor.sol";
import {DegradationCore as GracefulDegradationCore} from "../../../monitor/DegradationCore.sol";
import {DegradationStorage as GracefulDegradationStorage} from "../../../monitor/DegradationStorage.sol";
import {ModuleHealthView} from "./ModuleHealthView.sol";
import {
    ArrayLengthMismatch,
    BatchTooLarge,
    EmptyArray,
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
import {ViewVersioned} from "../ViewVersioned.sol";

/// @title ISystemRiskViewLite
/// @notice Minimal read interface for system risk thresholds.
/// @dev Used by {HealthView} to read the system minimum health factor without importing the full risk module.
interface ISystemRiskViewLite {
    /// @notice Returns the minimum health factor configured for the system.
    function getMinHealthFactor()
        external
        view
        returns (uint256 minHealthFactor);
}

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
 * - User health-factor reads follow Scheme U
 *   (self read allowed; non-self requires ACTION_VIEW_USER_DATA or ACTION_ADMIN).
 * - Batch user reads (users[]) are treated as enumeration capabilities: no self-bypass; requires
 *   ACTION_VIEW_USER_DATA or ACTION_ADMIN.
 * - UUPS upgradeability is role-gated (ACTION_ADMIN via ACM).
 */
contract HealthView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when a user's health factor is cached.
     * @param user Target user address
     * @param healthFactor Cached health factor (bps)
     * @param blockNumber Cache update blockNumber (block.number)
     */
    event HealthFactorCached(
        address indexed user,
        uint256 healthFactor,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when a module health status is cached for off-chain indexing.
     * @param module Target module address
     * @param isHealthy Whether the module is healthy
     * @param detailsHash Details hash (off-chain resolvable)
     * @param failures Consecutive failure count
     * @param blockNumber Cache update blockNumber (block.number)
     */
    event ModuleHealthCached(
        address indexed module,
        bool isHealthy,
        bytes32 detailsHash,
        uint32 failures,
        uint256 blockNumber
    );

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice System-scoped minimum health factor is invalid (misconfigured as 0).
    error HealthView__InvalidMinHealthFactor();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ User health-factor cache ━━━━━━━━━━━━━━━*/
    mapping(address => uint256) private _healthFactorCache;
    mapping(address => uint256) private _cacheUpdateBlocks;

    /*━━━━━━━━━━━━━━━ Module health cache ━━━━━━━━━━━━━━━*/
    // NOTE: Storage layout must remain stable across upgrades; do not reorder fields for packing.
    struct ModuleHealth {
        bool isHealthy;
        bytes32 detailsHash;
        uint32 lastCheckTime;
        uint32 consecutiveFailures;
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
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_PUSH,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        _;
    }

    modifier onlyModuleHealthPusher() {
        if (
            !_hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS, msg.sender) &&
            !_hasRole(ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    modifier onlySystemHealthViewer() {
        if (
            !_hasRole(ActionKeys.ACTION_VIEW_SYSTEM_STATUS, msg.sender) &&
            !_hasRole(ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    /// @dev Scheme U: self read allowed; non-self requires ACTION_VIEW_USER_DATA or ACTION_ADMIN.
    modifier onlyAuthorizedFor(address user) {
        if (msg.sender != user) {
            bool ok = _hasRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender) ||
                _hasRole(ActionKeys.ACTION_ADMIN, msg.sender);
            if (!ok) revert MissingRole();
        }
        _;
    }

    /// @dev Scheme U batch: no self-bypass; requires ACTION_VIEW_USER_DATA or ACTION_ADMIN.
    modifier onlyOpsOrAdmin() {
        bool ok = _hasRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender) ||
            _hasRole(ActionKeys.ACTION_ADMIN, msg.sender);
        if (!ok) revert MissingRole();
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
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
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
    function pushHealthFactor(
        address user,
        uint256 healthFactor
    ) external onlyValidRegistry onlyViewPusher {
        _healthFactorCache[user] = healthFactor;
        _cacheUpdateBlocks[user] = block.number;
        emit HealthFactorCached(user, healthFactor, block.number);
        // Push to generic data stream
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_HEALTH_FACTOR,
            abi.encode(user, healthFactor)
        );
    }

    /**
     * @notice Push a full risk status update into the cache (recommended).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_PUSH role (via onlyViewPusher / ViewAccessLib)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_PUSH
     * - If `blockNumber == 0`, the current block number is used.
     *
     * @param user Target user address
     * @param healthFactorBps Health factor (bps, 1e4 = 100%)
     * @param minHFBps Minimum health factor threshold (bps)
     * @param undercollateralized Whether healthFactorBps is below the threshold
     * @param blockNumber Cache update blockNumber override (block.number; 0 to use current block)
     */
    function pushRiskStatus(
        address user,
        uint256 healthFactorBps,
        uint256 minHFBps,
        bool undercollateralized,
        uint256 blockNumber
    ) external onlyValidRegistry onlyViewPusher {
        _healthFactorCache[user] = healthFactorBps;
        _cacheUpdateBlocks[user] = blockNumber == 0
            ? block.number
            : blockNumber;
        emit HealthFactorCached(
            user,
            healthFactorBps,
            _cacheUpdateBlocks[user]
        );
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_RISK_STATUS,
            abi.encode(
                user,
                healthFactorBps,
                minHFBps,
                undercollateralized,
                _cacheUpdateBlocks[user]
            )
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
     * - If `blockNumber == 0`, the current block number is used.
     *
     * @param users Target user addresses
     * @param healthFactorsBps Health factors (bps)
     * @param minHFsBps Minimum health factor thresholds (bps)
     * @param underFlags Undercollateralized flags
     * @param blockNumber Cache update blockNumber override (block.number; 0 to use current block)
     */
    function pushRiskStatusBatch(
        address[] calldata users,
        uint256[] calldata healthFactorsBps,
        uint256[] calldata minHFsBps,
        bool[] calldata underFlags,
        uint256 blockNumber
    ) external onlyValidRegistry onlyViewPusher {
        if (users.length == 0) revert EmptyArray();
        if (users.length > ViewConstants.MAX_BATCH_SIZE) {
            revert BatchTooLarge(users.length, ViewConstants.MAX_BATCH_SIZE);
        }
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
        uint256 resolvedBlockNumber = blockNumber == 0
            ? block.number
            : blockNumber;
        for (uint256 i; i < len; ++i) {
            address u = users[i];
            _healthFactorCache[u] = healthFactorsBps[i];
            _cacheUpdateBlocks[u] = resolvedBlockNumber;
            emit HealthFactorCached(
                u,
                healthFactorsBps[i],
                resolvedBlockNumber
            );
        }
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_RISK_STATUS_BATCH,
            abi.encode(
                users,
                healthFactorsBps,
                minHFsBps,
                underFlags,
                resolvedBlockNumber
            )
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
        uint256 blockNumber = block.number;
        mh.lastCheckTime = uint32(blockNumber);

        emit ModuleHealthCached(
            module,
            isHealthy,
            detailsHash,
            consecutiveFailures,
            blockNumber
        );
        // Push to generic data stream
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_MODULE_HEALTH,
            abi.encode(
                module,
                isHealthy,
                detailsHash,
                consecutiveFailures,
                blockNumber
            )
        );
    }

    /**
     * @notice Get cached module health status with cache metadata.
     * @dev Reverts if: (never)
     *
     * Security:
     * - View-only.
     *
     * @param module Target module address.
     * @return moduleHealth_ Cached module health data.
     * @return isValid True if the cache update block is within the configured TTL.
     * @return blockNumber Cache update block number.
     */
    function getModuleHealthWithMeta(
        address module
    )
        external
        view
        returns (
            ModuleHealth memory moduleHealth_,
            bool isValid,
            uint256 blockNumber
        )
    {
        moduleHealth_ = _moduleHealth[module];
        blockNumber = uint256(moduleHealth_.lastCheckTime);
        isValid = _isValid(blockNumber);
    }

    /*━━━━━━━━━━━━━━━ Read APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get a user's health factor with cache validity and blockNumber (B-class unified output).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the target user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via Scheme U)
     *
     * Security:
     * - Scheme U user-dimensional read (self allowed; non-self requires ACTION_VIEW_USER_DATA or ACTION_ADMIN)
     *
     * @param user Target user address.
     * @return healthFactor Cached health factor in bps.
     * @return isValid True if the cached value is within the configured TTL.
     * @return blockNumber Cache update block number.
     */
    function getUserHealthFactorWithMeta(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 healthFactor, bool isValid, uint256 blockNumber)
    {
        // NOTE: Do NOT call `this.getUserHealthFactorWithMeta(user)` here.
        // `this.*` would be an external call (unnecessary) and may change the effective msg.sender.
        healthFactor = _healthFactorCache[user];
        blockNumber = _cacheUpdateBlocks[user];
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Batch query cached health factors with meta (B-class unified output).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole; batch user reads have no self-bypass)
     *      - users is empty (EmptyArray)
     *      - users.length > MAX_BATCH_SIZE (BatchTooLarge)
     *
     * Security:
     * - Scheme U batch user-dimensional read: enumeration capability (no self-bypass; ops/admin only)
     *
     * @param users Target user addresses.
     * @return factors Cached health factors in bps.
     * @return validFlags Cache-validity flags for each user.
     * @return blockNumbers Cache update block numbers for each user.
     */
    function batchGetHealthFactorsWithMeta(
        address[] calldata users
    )
        external
        view
        onlyValidRegistry
        onlyOpsOrAdmin
        returns (
            uint256[] memory factors,
            bool[] memory validFlags,
            uint256[] memory blockNumbers
        )
    {
        // NOTE: Do NOT call `this.batchGetHealthFactorsWithMeta(users)` here (unnecessary external call).
        if (users.length == 0) revert EmptyArray();
        if (users.length > ViewConstants.MAX_BATCH_SIZE) {
            revert BatchTooLarge(users.length, ViewConstants.MAX_BATCH_SIZE);
        }
        uint256 len = users.length;
        factors = new uint256[](len);
        validFlags = new bool[](len);
        blockNumbers = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            uint256 blockNumber = _cacheUpdateBlocks[users[i]];
            factors[i] = _healthFactorCache[users[i]];
            blockNumbers[i] = blockNumber;
            validFlags[i] = _isValid(blockNumber);
        }
    }

    /**
     * @notice Check whether a user is liquidatable based on the cached health factor through a best-effort path.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the target user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via Scheme U)
     *      - SystemRiskView returns `minHealthFactor == 0` (HealthView__InvalidMinHealthFactor)
     *
     * Security:
     * - Scheme U user-dimensional read
     *   (self allowed; non-self requires ACTION_VIEW_USER_DATA or ACTION_ADMIN)
     * - Conservative: returns `(false, false, blockNumber)` if cache is
     *   invalid or system risk parameters cannot be read.
     *
     * @param user Target user address.
     * @return isLiquidatable True if cached health factor is valid and below the SSOT min health factor.
     * @return isValid Whether this best-effort determination is valid (cache valid AND min health factor resolved).
     * @return blockNumber Cache update block number.
     */
    function isUserLiquidatableWithMeta(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (bool isLiquidatable, bool isValid, uint256 blockNumber)
    {
        blockNumber = _cacheUpdateBlocks[user];
        isValid = _isValid(blockNumber);
        if (!isValid) return (false, false, blockNumber); // conservative: invalid cache => not liquidatable

        // SSOT threshold: resolve SystemRiskView (system-scoped) and read min health factor.
        // If the SystemRiskView is not configured or the call fails, return "unknown/invalid" conservatively.
        address srv = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_SYSTEM_RISK_VIEW
        );
        if (srv == address(0)) return (false, false, blockNumber);

        uint256 minHf;
        try ISystemRiskViewLite(srv).getMinHealthFactor() returns (uint256 v) {
            minHf = v;
        } catch {
            return (false, false, blockNumber);
        }
        if (minHf == 0) revert HealthView__InvalidMinHealthFactor();

        return (_healthFactorCache[user] < minHf, true, blockNumber);
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/
    function _isValid(uint256 updateBlock) internal view returns (bool) {
        if (updateBlock == 0 || updateBlock > block.number) return false;
        return
            block.number - updateBlock <= ViewConstants.CACHE_DURATION_BLOCKS;
    }

    function _hasRole(
        bytes32 actionKey,
        address user
    ) internal view returns (bool) {
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
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyValidRegistry {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0)
            revert NotAContract(newImplementation);
    }

    /**
     * @notice Get Registry contract address (legacy getter for backward compatibility).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return registryAddr_ Registry contract address.
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
     * @return stats System degradation statistics, or a zeroed struct if the monitor is not configured.
     */
    function getGracefulDegradationStats()
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (GracefulDegradationCore.DegradationStats memory stats)
    {
        address mon = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_DEGRADATION_MONITOR
        );
        if (mon == address(0)) {
            return
                GracefulDegradationCore.DegradationStats({
                    totalDegradations: 0,
                    lastDegradationBlock: 0,
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
     * @return healthStatus Module health status, or a defaulted struct if the monitor is not configured.
     */
    function getModuleHealthStatus(
        address module
    )
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (ModuleHealthView.ModuleHealthStatus memory healthStatus)
    {
        address mon = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_DEGRADATION_MONITOR
        );
        if (mon == address(0)) {
            return
                ModuleHealthView.ModuleHealthStatus({
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
     * @param limit Maximum number of events to return.
     * @return history Degradation events, or an empty array if the monitor is not configured.
     */
    function getSystemDegradationHistory(
        uint256 limit
    )
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (GracefulDegradationStorage.DegradationEvent[] memory history)
    {
        address mon = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_DEGRADATION_MONITOR
        );
        if (mon == address(0)) {
            return new GracefulDegradationStorage.DegradationEvent[](0);
        }
        return
            GracefulDegradationMonitor(mon).getSystemDegradationHistory(limit);
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
     * @param module Target module address.
     * @return isHealthy True if the module is currently healthy.
     * @return details Human-readable status string intended for off-chain tools.
     */
    function checkModuleHealth(
        address module
    )
        external
        view
        onlyValidRegistry
        onlySystemHealthViewer
        returns (bool isHealthy, string memory details)
    {
        address mon = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_DEGRADATION_MONITOR
        );
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
     * @return totalEvents Total recorded degradation events.
     * @return recentEvents Recent degradation-event count.
     * @return mostFrequentModule Module most frequently seen in degradation events.
     * @return averageFallbackValue Average fallback value recorded by the monitor.
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
        )
    {
        address mon = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_DEGRADATION_MONITOR
        );
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
     * - Pure function.
     *
     * @return apiVersion_ API semantic version.
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
     * - Pure function.
     *
     * @return schemaVersion_ Schema version.
     */
    function schemaVersion()
        public
        pure
        override
        returns (uint256 schemaVersion_)
    {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    /// @notice Storage gap for future upgrades.
    uint256[50] private __gap;
}

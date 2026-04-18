// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Registry} from "../../../registry/Registry.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {VaultMath} from "../../VaultMath.sol";
import {DataPushLibrary} from "../../../libraries/DataPushLibrary.sol";
import {DataPushTypes} from "../../../constants/DataPushTypes.sol";
import {ViewAccessLib} from "../../../libraries/ViewAccessLib.sol";
import {
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
import {ViewConstants} from "../ViewConstants.sol";
import {ViewVersioned} from "../ViewVersioned.sol";

/**
 * @title StatisticsView
 * @notice Aggregated (cached) system-level statistics and lightweight push-based cache updates.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - UUPS upgradeable contract; upgrades are admin-gated via Registry.
 * - All write paths are role-gated via Registry (admin or system-data pushers).
 * - Health factor and LTV are expressed in basis points where 10_000 = 100%.
 * - Collateral and debt values must share the same value-denominated unit.
 * - Guarantee amounts are tracked in raw token base units.
 */
contract StatisticsView is Initializable, UUPSUpgradeable, ViewVersioned {
    uint8 private constant _SYSTEM_VALUATION_DECIMALS = 18;

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    /// @notice Thrown when an incoming user stats version is not the expected next version.
    /// @dev Reverts when `incomingVersion != currentVersion + 1`. Used by {pushUserStatsUpdate} overloads that
    ///      enforce strict optimistic concurrency via `nextVersion`.
    error StatisticsView__StaleUserStatsVersion(
        uint64 currentVersion,
        uint64 incomingVersion
    );
    /// @notice Thrown when an incoming user stats sequence number is not strictly increasing.
    /// @dev Reverts when `incomingSeq <= currentSeq`. Used by {pushUserStatsUpdate} when `seq != 0`.
    error StatisticsView__OutOfOrderSeq(uint64 currentSeq, uint64 incomingSeq);
    /// @notice Thrown when attempting to upgrade to the zero address.
    /// @dev Reverts when `newImplementation == address(0)`. Used by {_authorizeUpgrade}.
    error StatisticsView__ZeroImplementation();

    /*━━━━━━━━━━━━━━━ Types ━━━━━━━━━━━━━━━*/
    /// @notice Per-user cached snapshot (kept compatible with legacy VaultStatistics for migration).
    struct UserSnapshot {
        uint256 collateral; // Collateral value in the shared 18-decimal system valuation unit
        uint256 debt; // Debt value in the shared 18-decimal system valuation unit
        uint256 ltv; // Loan-to-value (bps, 10_000 = 100%)
        uint256 healthFactor; // Health factor (bps, 10_000 = 100%; max uint if debt==0 in VaultMath)
        uint256 blockNumber; // Snapshot blockNumber (block.number)
        bool isActive; // Reserved for legacy compatibility (do NOT use as SSOT)
    }

    /// @notice Global cached snapshot (kept compatible with legacy VaultStatistics for migration).
    struct GlobalSnapshot {
        uint256 totalCollateral; // Total collateral value in the shared 18-decimal system valuation unit
        uint256 totalDebt; // Total debt value in the shared 18-decimal system valuation unit
        uint256 averageLTV; // Average LTV (bps, 10_000 = 100%) (currently best-effort / may be 0)
        uint256 averageHealthFactor; // Average health factor (bps) (currently best-effort / may be 0)
        uint256 activeUsers; // Active user count (position > 0)
        uint256 blockNumber; // Snapshot blockNumber (block.number)
    }

    struct GlobalStatistics {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateBlock;
    }

    struct RewardStats {
        uint256 rewardRate;
        uint256 totalEasyTokenSupply;
    }

    /// @notice Cached graceful degradation stats payload.
    struct GracefulDegradationStats {
        uint256 totalDegradations;
        uint256 lastDegradationBlock;
        address lastDegradedModule;
        bytes32 lastDegradationReasonHash;
        uint256 fallbackValueUsed;
        uint256 totalFallbackValue;
        uint256 averageFallbackValue;
    }

    GracefulDegradationStats private _degradationStats;

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    /// @notice Cached active user count (position > 0).
    uint256 private _activeUsers;
    /// @notice Cached total "seen" users (counted on first successful user stats push).
    uint256 private _totalUsers;
    /// @notice user => cached snapshot.
    mapping(address => UserSnapshot) private _userSnapshots;
    /// @notice user => whether the user has been counted into `_totalUsers`.
    mapping(address => bool) private _userSeen;
    /// @notice user => whether the user is currently active (position > 0).
    mapping(address => bool) private _userActiveStatus;
    /// @notice user => last activity block (block.number).
    mapping(address => uint256) private _userLastActiveTime;
    /// @notice user => optimistic concurrency version (monotonic).
    mapping(address => uint64) private _userStatsVersion;
    /// @notice user => optional offchain ordering sequence (must be strictly increasing if provided).
    mapping(address => uint64) private _userStatsSeq;
    /// @notice user => last applied idempotency key (O(1)).
    mapping(address => bytes32) private _lastAppliedUserStatsRequestId;
    /// @notice user => asset => locked guarantee amount (token decimals).
    mapping(address => mapping(address => uint256)) private _userGuarantees;
    /// @notice asset => total locked guarantee amount across all users (token decimals).
    mapping(address => uint256) private _totalGuaranteesByAsset;
    /// @notice (user, asset) => optimistic concurrency version for guarantee snapshots.
    mapping(address => mapping(address => uint64)) private _guaranteeVersion;
    /// @notice (user, asset) => optional monotonic sequence for guarantee snapshots.
    mapping(address => mapping(address => uint64)) private _guaranteeSeq;
    /// @notice (user, asset) => last applied idempotency key for guarantee snapshots (O(1)).
    mapping(address => mapping(address => bytes32))
        private _lastAppliedGuaranteeRequestId;
    /// @notice (user, asset) => last guarantee cache update block (block.number).
    /// @dev This blockNumber is per-key to avoid "asset-level freshness pollution" across users.
    mapping(address => mapping(address => uint256))
        private _guaranteeLastUpdate;
    /// @notice asset => last guarantee cache update block (block.number).
    mapping(address => uint256) private _guaranteeLastUpdateByAsset;
    /// @notice Last guarantee cache update block (block.number).
    uint256 private _lastGuaranteeUpdate;
    /// @notice Cached global snapshot.
    GlobalSnapshot private _globalSnapshot;
    /// @notice Last global cache update block (block.number).
    uint256 private _lastGlobalUpdate;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /**
     * @notice Emitted when graceful degradation stats are cached.
     * @dev Emitted by {pushDegradationStats}. `blockNumber` is the emit-time blockNumber.
     */
    event DegradationStatsCached(
        uint256 totalDegradations,
        uint256 lastDegradationBlock,
        address indexed lastDegradedModule,
        bytes32 indexed reasonHash,
        uint256 fallbackValueUsed,
        uint256 totalFallbackValue,
        uint256 averageFallbackValue,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when a replayed idempotent request is ignored.
     * @dev Emitted by {pushUserStatsUpdate} when the same `(user, version, requestId)` is replayed and can be
     *      safely ignored without mutating state.
     */
    event IdempotentRequestIgnored(
        address indexed user,
        bytes32 indexed requestId,
        uint64 seq
    );

    /*━━━━━━━━━━━━━━━ Configuration ━━━━━━━━━━━━━━━*/
    /// @notice Registry address used for SSOT module resolution and access control.
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Upgrade Gap ━━━━━━━━━━━━━━━*/
    /// @dev Storage gap for upgrade safety (UUPS).
    uint256[49] private __gap;

    /*━━━━━━━━━━━━━━━ Versioning ━━━━━━━━━━━━━━━*/
    /**
     * @notice Return the external API semantic version for this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function.
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Return the schema version for cached outputs and DataPushed payloads.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function.
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /**
     * @dev Enforce Scheme B SSOT: StatisticsView writes must be single-entry orchestrated.
     *      Only the on-chain orchestrator (Registry.KEY_STATS_PUSH_MANAGER) or an ACTION_ADMIN may push.
     */
    modifier onlyStatsPusherOrAdmin() {
        _requireStatsPusherOrAdmin();
        _;
    }

    /// @dev Resolve ACM via Registry and require a role for `msg.sender`.
    modifier onlyRole(bytes32 actionKey) {
        if (!ViewAccessLib.hasRole(_registryAddr, actionKey, msg.sender)) {
            revert MissingRole();
        }
        _;
    }

    /// @dev Scheme U: self-read allowed; non-self requires VIEW_USER_DATA or ADMIN.
    modifier onlyUserOrViewer(address user) {
        if (
            msg.sender != user &&
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_USER_DATA,
                msg.sender
            ) &&
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) revert MissingRole();
        _;
    }

    /*━━━━━━━━━━━━━━━ Initialization ━━━━━━━━━━━━━━━*/
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the StatisticsView proxy.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0) (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *
     * Security:
     * - Initializer: callable once via proxy.
     * - Sets the Registry address used for module resolution and access control.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;

        // Initialize snapshot for legacy compatibility.
        _globalSnapshot = GlobalSnapshot({
            totalCollateral: 0,
            totalDebt: 0,
            averageLTV: 0,
            averageHealthFactor: 0,
            activeUsers: 0,
            blockNumber: block.number
        });
    }

    /*━━━━━━━━━━━━━━━ View Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Return cached global statistics together with cache freshness metadata.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return g Cached global statistics snapshot.
     * @return isValid True if the cache block number is within the configured TTL.
     * @return blockNumber Cache block number.
     */
    function getGlobalStatisticsWithMeta()
        external
        view
        returns (GlobalStatistics memory g, bool isValid, uint256 blockNumber)
    {
        GlobalSnapshot memory s = _globalSnapshot;
        g.totalUsers = _totalUsers;
        g.activeUsers = s.activeUsers;
        g.totalCollateral = s.totalCollateral;
        g.totalDebt = s.totalDebt;
        g.lastUpdateBlock = s.blockNumber;
        blockNumber = s.blockNumber;
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return cached global snapshot together with cache freshness metadata.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return s Cached global snapshot.
     * @return isValid True if the cache block number is within the configured TTL.
     * @return blockNumber Cache block number.
     */
    function getGlobalSnapshotWithMeta()
        external
        view
        returns (GlobalSnapshot memory s, bool isValid, uint256 blockNumber)
    {
        s = _globalSnapshot;
        blockNumber = s.blockNumber;
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return cached active user count together with cache freshness metadata.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return activeUsers Cached active user count.
     * @return isValid True if the cache block number is within the configured TTL.
     * @return blockNumber Cache block number.
     */
    function getActiveUsersWithMeta()
        external
        view
        returns (uint256 activeUsers, bool isValid, uint256 blockNumber)
    {
        GlobalSnapshot memory s = _globalSnapshot;
        activeUsers = s.activeUsers;
        blockNumber = s.blockNumber;
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return cached per-user snapshot together with concurrency/idempotency metadata.
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is not authorized for `user` (see {MissingRole} via Scheme U in onlyUserOrViewer)
     *
     * Security:
     * - View-only.
     * - User-dimensional read follows Scheme U: self-read allowed; non-self requires `ACTION_VIEW_USER_DATA` or
     *   `ACTION_ADMIN`.
     *
     * @param user User address.
     * @return s Cached user snapshot.
     * @return version Current optimistic concurrency version.
     * @return seq Current monotonic sequence (0 if never provided).
     * @return lastAppliedRequestId Last applied idempotency key (bytes32(0) if none).
     * @return isValid True if the snapshot block number is within the configured TTL.
     * @return blockNumber Snapshot block number.
     */
    function getUserSnapshotWithMeta(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (
            UserSnapshot memory s,
            uint64 version,
            uint64 seq,
            bytes32 lastAppliedRequestId,
            bool isValid,
            uint256 blockNumber
        )
    {
        s = _userSnapshots[user];
        version = _userStatsVersion[user];
        seq = _userStatsSeq[user];
        lastAppliedRequestId = _lastAppliedUserStatsRequestId[user];
        blockNumber = s.blockNumber;
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return the current user stats version (for upstream optimistic concurrency).
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is not authorized for `user` (see {MissingRole} via Scheme U in onlyUserOrViewer)
     *
     * Security:
     * - View-only.
     *
     * @param user User address.
     * @return version Current monotonic version.
     */
    function getUserStatsVersion(
        address user
    ) external view onlyValidRegistry onlyUserOrViewer(user) returns (uint64) {
        return _userStatsVersion[user];
    }

    /**
     * @notice Return the current user stats version for authorized pushers (for strict optimistic concurrency).
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is neither Registry `KEY_STATS_PUSH_MANAGER` nor has `ACTION_ADMIN` (MissingRole)
     *
     * Security:
     * - View-only pusher helper.
     * - This is intended for on-chain modules that perform best-effort pushes and need to compute
     *   `nextVersion = currentVersion + 1` before calling the strict {pushUserStatsUpdate(..., requestId, seq, nextVersion)}.
     *
     * @param user User address.
     * @return version Current monotonic version.
     */
    function getUserStatsVersionForPusher(
        address user
    ) external view onlyValidRegistry returns (uint64) {
        // Single-entry orchestrator helper: only stats pusher or admin may read.
        _requireStatsPusherOrAdmin();
        return _userStatsVersion[user];
    }

    /**
     * @notice Return the current guarantee snapshot version for authorized pushers (for strict optimistic concurrency).
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is neither Registry `KEY_STATS_PUSH_MANAGER` nor has `ACTION_ADMIN` (MissingRole)
     *
     * Security:
     * - View-only pusher helper.
     *
     * @param user User address.
     * @param asset Guarantee asset address.
     * @return version Current monotonic version.
     */
    function getGuaranteeVersionForPusher(
        address user,
        address asset
    ) external view onlyValidRegistry returns (uint64) {
        // Single-entry orchestrator helper: only stats pusher or admin may read.
        _requireStatsPusherOrAdmin();
        return _guaranteeVersion[user][asset];
    }

    /**
     * @notice Return the current user stats sequence number (optional offchain ordering aid).
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is not authorized for `user` (see {MissingRole} via Scheme U in onlyUserOrViewer)
     *
     * Security:
     * - View-only.
     *
     * @param user User address.
     * @return seq Current monotonic sequence.
     */
    function getUserStatsSeq(
        address user
    ) external view onlyValidRegistry onlyUserOrViewer(user) returns (uint64) {
        return _userStatsSeq[user];
    }

    /**
     * @notice Return the last applied idempotency key for the user (O(1) replay context).
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is not authorized for `user` (see {MissingRole} via Scheme U in onlyUserOrViewer)
     *
     * Security:
     * - View-only.
     *
     * @param user User address.
     * @return requestId Last applied idempotency key.
     */
    function getUserStatsLastAppliedRequestId(
        address user
    ) external view onlyValidRegistry onlyUserOrViewer(user) returns (bytes32) {
        return _lastAppliedUserStatsRequestId[user];
    }

    /*━━━━━━━━━━━━━━━ Internal Helpers ━━━━━━━━━━━━━━━*/
    function _isValid(uint256 updateBlock) internal view returns (bool) {
        uint256 dur = ViewConstants.CACHE_DURATION_BLOCKS;
        if (updateBlock == 0 || updateBlock > block.number) return false;
        return block.number - updateBlock <= dur;
    }

    /**
     * @notice Cache the latest graceful degradation stats snapshot.
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks `ACTION_VIEW_SYSTEM_STATUS` and is not an admin (MissingRole)
     *
     * Security:
     * - Role-gated: `ACTION_VIEW_SYSTEM_STATUS` or `ACTION_ADMIN`.
     * - Emits {DegradationStatsCached} and `DataPushed(DATA_TYPE_DEGRADATION_STATS_UPDATE, payload)` for off-chain
     *   monitoring.
     *
     * @param s Degradation stats payload to cache.
     */
    function pushDegradationStats(
        GracefulDegradationStats calldata s
    ) external onlyValidRegistry {
        // Allow admin; otherwise require system status view permission.
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) {
            if (
                !ViewAccessLib.hasRole(
                    _registryAddr,
                    ActionKeys.ACTION_VIEW_SYSTEM_STATUS,
                    msg.sender
                )
            ) {
                revert MissingRole();
            }
        }

        _degradationStats = s;

        emit DegradationStatsCached(
            s.totalDegradations,
            s.lastDegradationBlock,
            s.lastDegradedModule,
            s.lastDegradationReasonHash,
            s.fallbackValueUsed,
            s.totalFallbackValue,
            s.averageFallbackValue,
            block.number
        );
        // Push to generic data bus
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_DEGRADATION_STATS_UPDATE,
            abi.encode(s)
        );
    }

    /**
     * @notice Return the last cached degradation stats payload.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return stats Last cached degradation stats payload.
     */
    function getDegradationStats()
        external
        view
        returns (GracefulDegradationStats memory stats)
    {
        return _degradationStats;
    }

    /**
     * @notice DEPRECATED: Push an incremental user stats update (no explicit versioning context).
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is neither Registry `KEY_STATS_PUSH_MANAGER` nor has `ACTION_ADMIN` (MissingRole)
     *      - user == address(0) (ZeroAddress)
     *
     * Security:
     * - Writer-gated: Registry `KEY_STATS_PUSH_MANAGER` or `ACTION_ADMIN`.
     *
     * @dev Deprecation:
     * - This overload exists for migration/backward compatibility and does NOT carry concurrency/idempotency context.
     * - Prefer the overloads that include `nextVersion` (and optionally `requestId`/`seq`) to satisfy Workguide Phase-3
     *   requirements and enable deterministic off-chain replay/diagnostics.
     *
     * @param user User address.
     * @param collateralIn Collateral value delta added (18-decimal valuation unit).
     * @param collateralOut Collateral value delta removed (18-decimal valuation unit).
     * @param borrow Debt value delta added (18-decimal valuation unit).
     * @param repay Debt value delta removed (18-decimal valuation unit).
     */
    function pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay
    ) external onlyValidRegistry onlyStatsPusherOrAdmin {
        _pushUserStatsUpdate(
            user,
            collateralIn,
            collateralOut,
            borrow,
            repay,
            bytes32(0),
            0,
            0
        );
    }

    /**
     * @notice Push an incremental user stats update with optimistic concurrency (nextVersion).
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is neither Registry `KEY_STATS_PUSH_MANAGER` nor has `ACTION_ADMIN` (MissingRole)
     *      - user == address(0) (ZeroAddress)
     *      - nextVersion != currentVersion + 1 (StatisticsView__StaleUserStatsVersion)
     *
     * Security:
     * - Writer-gated: Registry `KEY_STATS_PUSH_MANAGER` or `ACTION_ADMIN`.
     * - Strict optimistic concurrency when nextVersion != 0.
     *
     * @param user User address.
     * @param collateralIn Collateral value delta added (18-decimal valuation unit).
     * @param collateralOut Collateral value delta removed (18-decimal valuation unit).
     * @param borrow Debt value delta added (18-decimal valuation unit).
     * @param repay Debt value delta removed (18-decimal valuation unit).
     * @param nextVersion Expected next version (must be current + 1).
     */
    function pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay,
        uint64 nextVersion
    ) external onlyValidRegistry onlyStatsPusherOrAdmin {
        _pushUserStatsUpdate(
            user,
            collateralIn,
            collateralOut,
            borrow,
            repay,
            bytes32(0),
            0,
            nextVersion
        );
    }

    /**
     * @notice Push an incremental user stats update with idempotency + ordering context.
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is neither Registry `KEY_STATS_PUSH_MANAGER` nor has `ACTION_ADMIN` (MissingRole)
     *      - user == address(0) (ZeroAddress)
     *      - seq is not strictly increasing (StatisticsView__OutOfOrderSeq) when seq != 0
     *      - nextVersion != currentVersion + 1 (StatisticsView__StaleUserStatsVersion) when nextVersion != 0
     *
     * Security:
     * - Writer-gated: Registry `KEY_STATS_PUSH_MANAGER` or `ACTION_ADMIN`.
     * - Idempotent replay (no revert): if (nextVersion == currentVersion) AND (requestId matches lastAppliedRequestId),
     *   this function emits `IdempotentRequestIgnored` and returns without writing.
     *
     * @param user User address.
     * @param collateralIn Collateral value delta added (18-decimal valuation unit).
     * @param collateralOut Collateral value delta removed (18-decimal valuation unit).
     * @param borrow Debt value delta added (18-decimal valuation unit).
     * @param repay Debt value delta removed (18-decimal valuation unit).
     * @param requestId Offchain idempotency key (bytes32(0) disables idempotency short-circuit).
     * @param seq Optional monotonic sequence (0 disables sequence enforcement).
     * @param nextVersion Expected next version (0 means auto-increment).
     */
    function pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external onlyValidRegistry onlyStatsPusherOrAdmin {
        _pushUserStatsUpdate(
            user,
            collateralIn,
            collateralOut,
            borrow,
            repay,
            requestId,
            seq,
            nextVersion
        );
    }

    /**
     * @notice Push an authoritative user stats snapshot (recommended; strict B+).
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is neither Registry `KEY_STATS_PUSH_MANAGER` nor has `ACTION_ADMIN` (MissingRole)
     *      - user == address(0) (ZeroAddress)
     *      - seq is not strictly increasing (StatisticsView__OutOfOrderSeq) when seq != 0
     *      - nextVersion != currentVersion + 1 (StatisticsView__StaleUserStatsVersion)
     *
     * Security:
     * - Writer-gated: Registry `KEY_STATS_PUSH_MANAGER` or `ACTION_ADMIN`.
     *
     * Snapshot semantics:
     * - The provided `collateralValue` and `debtValue` are treated as the new authoritative totals for the user.
     * - Global totals are maintained as: global = global - oldUser + newUser (best-effort clamped).
     * - Snapshot pushes are naturally replay-friendly: re-sending the same snapshot with the same
     *   `(requestId, nextVersion)` can be made idempotent.
     *
     * @param user User address.
     * @param collateralValue New authoritative total collateral value (18-decimal valuation unit).
     * @param debtValue New authoritative total debt value (18-decimal valuation unit).
     * @param requestId Idempotency key (recommended non-zero).
     * @param seq Monotonic ordering sequence (recommended non-zero).
     * @param nextVersion Expected next version (must be current + 1).
     */
    function pushUserStatsSnapshot(
        address user,
        uint256 collateralValue,
        uint256 debtValue,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external onlyValidRegistry onlyStatsPusherOrAdmin {
        _pushUserStatsSnapshot(
            user,
            collateralValue,
            debtValue,
            requestId,
            seq,
            nextVersion
        );
    }

    function valuationDecimals() external pure returns (uint8) {
        return _SYSTEM_VALUATION_DECIMALS;
    }

    function _pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) internal {
        if (user == address(0)) revert ZeroAddress();

        // totalUsers: count first-time seen user
        if (!_userSeen[user]) {
            _userSeen[user] = true;
            _totalUsers += 1;
        }

        uint64 currentVersion = _userStatsVersion[user];
        // O(1) idempotency (version-bound):
        // - If a tx is replayed after success, currentVersion == applied nextVersion.
        // - If requestId matches the last applied requestId, ignore as idempotent replay.
        if (requestId != bytes32(0) && nextVersion != 0) {
            if (
                nextVersion == currentVersion &&
                _lastAppliedUserStatsRequestId[user] == requestId
            ) {
                emit IdempotentRequestIgnored(user, requestId, seq);
                return;
            }
        }

        // Optional monotonic ordering aid (seq):
        if (seq != 0) {
            uint64 curSeq = _userStatsSeq[user];
            if (seq <= curSeq)
                revert StatisticsView__OutOfOrderSeq(curSeq, seq);
            _userStatsSeq[user] = seq;
        }

        uint64 newVersion = nextVersion;
        if (nextVersion == 0) {
            newVersion = currentVersion + 1;
        } else {
            // strict: nextVersion must be exactly current + 1
            if (nextVersion != currentVersion + 1) {
                revert StatisticsView__StaleUserStatsVersion(
                    currentVersion,
                    nextVersion
                );
            }
        }
        _userStatsVersion[user] = newVersion;
        if (requestId != bytes32(0) && nextVersion != 0) {
            _lastAppliedUserStatsRequestId[user] = requestId;
        }

        // Update per-user snapshot (incremental deltas).
        UserSnapshot storage snap = _userSnapshots[user];
        if (collateralIn > 0) {
            snap.collateral += collateralIn;
        }
        if (collateralOut > 0) {
            snap.collateral = snap.collateral > collateralOut
                ? snap.collateral - collateralOut
                : 0;
        }
        if (borrow > 0) {
            snap.debt += borrow;
        }
        if (repay > 0) {
            snap.debt = snap.debt > repay ? snap.debt - repay : 0;
        }
        // Compute derived metrics (bps).
        snap.ltv = VaultMath.calculateLTV(snap.debt, snap.collateral);
        snap.healthFactor = VaultMath.calculateHealthFactor(
            snap.collateral,
            snap.debt
        );
        snap.blockNumber = block.number;

        // Update last activity blockNumber.
        _userLastActiveTime[user] = block.number;

        // Active user counting rule: strictly position > 0 (collateral > 0 OR debt > 0).
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

        // Maintain global collateral/debt aggregates (incremental deltas).
        if (collateralIn > 0) {
            _globalSnapshot.totalCollateral += collateralIn;
        }
        if (collateralOut > 0) {
            uint256 tc = _globalSnapshot.totalCollateral;
            _globalSnapshot.totalCollateral = tc > collateralOut
                ? tc - collateralOut
                : 0;
        }
        if (borrow > 0) {
            _globalSnapshot.totalDebt += borrow;
        }
        if (repay > 0) {
            uint256 td = _globalSnapshot.totalDebt;
            _globalSnapshot.totalDebt = td > repay ? td - repay : 0;
        }

        // Update snapshot blockNumber and active user count.
        _globalSnapshot.activeUsers = _activeUsers;
        _globalSnapshot.blockNumber = block.number;
        _lastGlobalUpdate = block.number;

        // Observable success path (Phase 3): emit DataPushed with replay-friendly payload.
        // NOTE: Keep payload compact to avoid "stack too deep" and reduce gas.
        _emitUserStatsDataPushed(user, newVersion, requestId, seq);
    }

    function _pushUserStatsSnapshot(
        address user,
        uint256 collateralValue,
        uint256 debtValue,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) internal {
        if (user == address(0)) revert ZeroAddress();

        // totalUsers: count first-time seen user
        if (!_userSeen[user]) {
            _userSeen[user] = true;
            _totalUsers += 1;
        }

        uint64 currentVersion = _userStatsVersion[user];
        // Idempotency short-circuit (version-bound):
        if (requestId != bytes32(0)) {
            if (
                nextVersion == currentVersion &&
                _lastAppliedUserStatsRequestId[user] == requestId
            ) {
                emit IdempotentRequestIgnored(user, requestId, seq);
                return;
            }
        }

        // Strict ordering (seq):
        if (seq != 0) {
            uint64 curSeq = _userStatsSeq[user];
            if (seq <= curSeq)
                revert StatisticsView__OutOfOrderSeq(curSeq, seq);
            _userStatsSeq[user] = seq;
        }

        // Strict optimistic concurrency: nextVersion must be exactly current + 1
        if (nextVersion != currentVersion + 1) {
            revert StatisticsView__StaleUserStatsVersion(
                currentVersion,
                nextVersion
            );
        }
        _userStatsVersion[user] = nextVersion;
        if (requestId != bytes32(0)) {
            _lastAppliedUserStatsRequestId[user] = requestId;
        }

        // Snapshot: compute deltas from previous snapshot for global aggregates.
        UserSnapshot storage snap = _userSnapshots[user];
        uint256 oldCollateral = snap.collateral;
        uint256 oldDebt = snap.debt;

        snap.collateral = collateralValue;
        snap.debt = debtValue;
        snap.ltv = VaultMath.calculateLTV(snap.debt, snap.collateral);
        snap.healthFactor = VaultMath.calculateHealthFactor(
            snap.collateral,
            snap.debt
        );
        snap.blockNumber = block.number;
        _userLastActiveTime[user] = block.number;

        // Active user counting rule: strictly position > 0 (collateral > 0 OR debt > 0).
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

        // Maintain global aggregates as (global - old + new), clamped.
        uint256 tc = _globalSnapshot.totalCollateral;
        tc = tc > oldCollateral ? tc - oldCollateral : 0;
        _globalSnapshot.totalCollateral = tc + collateralValue;

        uint256 td = _globalSnapshot.totalDebt;
        td = td > oldDebt ? td - oldDebt : 0;
        _globalSnapshot.totalDebt = td + debtValue;

        _globalSnapshot.activeUsers = _activeUsers;
        _globalSnapshot.blockNumber = block.number;
        _lastGlobalUpdate = block.number;

        // Observable success path: emit DataPushed with replay-friendly payload.
        _emitUserStatsDataPushed(user, nextVersion, requestId, seq);
    }

    /**
     * @notice DEPRECATED: Legacy alias for pushing user stats deltas (historical entrypoint).
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller lacks `ACTION_SET_PARAMETER` (see {MissingRole})
     *      - user == address(0) (see {ZeroAddress})
     *
     * Security:
     * - Role-gated: `ACTION_SET_PARAMETER` (legacy path).
     *
     * @dev Deprecation:
     * - Prefer {pushUserStatsSnapshot} (strict B+) or the {pushUserStatsUpdate} overloads that include
     *   `nextVersion`/`requestId`/`seq` for deterministic replay/diagnostics.
     *
     * @param user User address.
     * @param collateralIn Collateral value added (must share unit with debt).
     * @param collateralOut Collateral value removed (must share unit with debt).
     * @param borrow Debt value added (must share unit with collateral).
     * @param repay Debt value removed (must share unit with collateral).
     */
    function updateUserStats(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay
    )
        external
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_SET_PARAMETER)
        onlyStatsPusherOrAdmin
    {
        // NOTE: do NOT use external self-call (`this.`), otherwise msg.sender becomes this contract and
        // would change the effective caller and may fail writer-gating. Keep this as an internal call.
        _pushUserStatsUpdate(
            user,
            collateralIn,
            collateralOut,
            borrow,
            repay,
            bytes32(0),
            0,
            0
        );
    }

    /**
     * @notice Push an incremental guarantee cache update for (user, asset).
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is neither Registry `KEY_STATS_PUSH_MANAGER` nor has `ACTION_ADMIN` (see {MissingRole})
     *      - user == address(0) (see {ZeroAddress})
     *      - asset == address(0) (see {ZeroAddress})
     *
     * Security:
     * - Writer-gated: Registry `KEY_STATS_PUSH_MANAGER` or `ACTION_ADMIN`.
     * - Emits `DataPushed(DATA_TYPE_GUARANTEE_STATS_UPDATE, payload)` for off-chain monitoring.
     *
     * @param user User address.
     * @param asset ERC20 guarantee asset address.
     * @param amount Amount delta (token decimals).
     * @param isLocked True to add/lock; false to subtract/release (clamped to current balance).
     */
    function pushGuaranteeUpdate(
        address user,
        address asset,
        uint256 amount,
        bool isLocked
    ) external onlyValidRegistry onlyStatsPusherOrAdmin {
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
        uint256 blockNumber = block.number;
        _guaranteeLastUpdate[user][asset] = blockNumber;
        _guaranteeLastUpdateByAsset[asset] = blockNumber;
        _lastGuaranteeUpdate = blockNumber;

        // keep global stats freshness monotonic for any stats-related update
        _globalSnapshot.blockNumber = blockNumber;
        _lastGlobalUpdate = blockNumber;

        // Observable success path (Phase 3)
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_GUARANTEE_STATS_UPDATE,
            abi.encode(
                user,
                asset,
                amount,
                isLocked,
                _userGuarantees[user][asset],
                _totalGuaranteesByAsset[asset],
                blockNumber
            )
        );
    }

    /**
     * @notice Push an authoritative guarantee snapshot for (user, asset) (recommended; strict B+).
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is neither Registry `KEY_STATS_PUSH_MANAGER` nor has `ACTION_ADMIN` (MissingRole)
     *      - user == address(0) or asset == address(0) (ZeroAddress)
     *      - seq is not strictly increasing (StatisticsView__OutOfOrderSeq) when seq != 0
     *      - nextVersion != currentVersion + 1 (StatisticsView__StaleUserStatsVersion)
     *
     * Security:
     * - Writer-gated: Registry `KEY_STATS_PUSH_MANAGER` or `ACTION_ADMIN`.
     *
     * Snapshot semantics:
     * - `userBalance` and `totalByAsset` are treated as authoritative SSOT-derived snapshots.
     * - This keeps `CacheUpdateFailedWithContext` payload stable and replayable.
     *
     * @param user User address.
     * @param asset Guarantee asset address.
     * @param userBalance Authoritative locked guarantee balance for (user, asset).
     * @param totalByAsset Authoritative total locked guarantee for `asset` across all users.
     * @param requestId Idempotency key (recommended non-zero).
     * @param seq Monotonic ordering sequence for this (user, asset) key (recommended non-zero).
     * @param nextVersion Expected next version for this (user, asset) key (must be current + 1).
     */
    function pushGuaranteeSnapshot(
        address user,
        address asset,
        uint256 userBalance,
        uint256 totalByAsset,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external onlyValidRegistry onlyStatsPusherOrAdmin {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();

        uint64 currentVersion = _guaranteeVersion[user][asset];
        // Idempotency short-circuit (version-bound):
        if (requestId != bytes32(0)) {
            if (
                nextVersion == currentVersion &&
                _lastAppliedGuaranteeRequestId[user][asset] == requestId
            ) {
                emit IdempotentRequestIgnored(user, requestId, seq);
                return;
            }
        }

        // Strict ordering (seq) per (user, asset):
        if (seq != 0) {
            uint64 curSeq = _guaranteeSeq[user][asset];
            if (seq <= curSeq)
                revert StatisticsView__OutOfOrderSeq(curSeq, seq);
            _guaranteeSeq[user][asset] = seq;
        }

        // Strict optimistic concurrency:
        if (nextVersion != currentVersion + 1) {
            revert StatisticsView__StaleUserStatsVersion(
                currentVersion,
                nextVersion
            );
        }
        _guaranteeVersion[user][asset] = nextVersion;
        if (requestId != bytes32(0)) {
            _lastAppliedGuaranteeRequestId[user][asset] = requestId;
        }

        _userGuarantees[user][asset] = userBalance;
        _totalGuaranteesByAsset[asset] = totalByAsset;
        uint256 blockNumber = block.number;
        _guaranteeLastUpdate[user][asset] = blockNumber;
        _guaranteeLastUpdateByAsset[asset] = blockNumber;
        _lastGuaranteeUpdate = blockNumber;
        // keep global stats freshness monotonic for any stats-related update
        _globalSnapshot.blockNumber = blockNumber;
        _lastGlobalUpdate = blockNumber;

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_GUARANTEE_STATS_UPDATE,
            abi.encode(
                user,
                asset,
                userBalance,
                totalByAsset,
                requestId,
                seq,
                nextVersion,
                blockNumber
            )
        );
    }

    function _emitUserStatsDataPushed(
        address user,
        uint64 version,
        bytes32 requestId,
        uint64 seq
    ) internal {
        UserSnapshot memory u = _userSnapshots[user];
        GlobalSnapshot memory g = _globalSnapshot;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_USER_STATS_UPDATE,
            abi.encode(
                user,
                version,
                requestId,
                seq,
                _SYSTEM_VALUATION_DECIMALS,
                u,
                g
            )
        );
    }

    /**
     * @notice DEPRECATED: Legacy alias for applying guarantee updates (historical entrypoint).
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller lacks `ACTION_SET_PARAMETER` (see {MissingRole})
     *      - user == address(0) (see {ZeroAddress})
     *      - asset == address(0) (see {ZeroAddress})
     *
     * Security:
     * - Role-gated: `ACTION_SET_PARAMETER` (legacy path).
     *
     * @dev Deprecation:
     * - Prefer {pushGuaranteeUpdate} (system-data pusher/admin) and consume the unified DataPush stream.
     *
     * @param user User address.
     * @param asset ERC20 guarantee asset address.
     * @param guaranteeAmount Amount delta (token decimals).
     * @param isLocked True to add/lock; false to subtract/release (clamped to current balance).
     */
    function updateGuaranteeStats(
        address user,
        address asset,
        uint256 guaranteeAmount,
        bool isLocked
    )
        external
        onlyValidRegistry
        onlyRole(ActionKeys.ACTION_SET_PARAMETER)
        onlyStatsPusherOrAdmin
    {
        // legacy compatibility: keep ACTION_SET_PARAMETER gate and apply directly
        _applyGuaranteeUpdate(user, asset, guaranteeAmount, isLocked);
    }

    /**
     * @notice Record a lightweight user snapshot blockNumber for offchain consumers.
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is neither Registry `KEY_STATS_PUSH_MANAGER` nor has `ACTION_ADMIN` (see {MissingRole})
     *      - user == address(0) (see {ZeroAddress})
     *
     * Security:
     * - Writer-gated: Registry `KEY_STATS_PUSH_MANAGER` or `ACTION_ADMIN`.
     * - Emits `DataPushed(DATA_TYPE_STATS_SNAPSHOT_RECORDED, payload)` for off-chain monitoring.
     *
     * @param user User address.
     */
    function recordSnapshot(address user) external onlyValidRegistry {
        _requireStatsPusherOrAdmin();
        if (user == address(0)) revert ZeroAddress();
        uint256 blockNumber = block.number;
        _userLastActiveTime[user] = blockNumber;
        _globalSnapshot.blockNumber = blockNumber;
        _lastGlobalUpdate = blockNumber;

        // Emit DataPushed for off-chain monitoring and replay diagnostics.
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_STATS_SNAPSHOT_RECORDED,
            abi.encode(
                user,
                blockNumber,
                _userStatsVersion[user],
                _userStatsSeq[user]
            )
        );
    }

    /*━━━━━━━━━━━━━━━ Additional View Getters ━━━━━━━━━━━━━━━*/
    /**
     * @notice Return the cached user guarantee balance with cache freshness metadata.
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is not authorized for `user` (see {MissingRole} via Scheme U in onlyUserOrViewer)
     *
     * Security:
     * - View-only.
     *
     * @param user User address.
     * @param asset ERC20 guarantee asset address.
     * @return amount Current cached locked amount in token base units.
     * @return isValid True if the cache block number is within the configured TTL.
     * @return blockNumber Cache block number.
     */
    function getUserGuaranteeBalanceWithMeta(
        address user,
        address asset
    )
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (uint256 amount, bool isValid, uint256 blockNumber)
    {
        amount = _userGuarantees[user][asset];
        blockNumber = _guaranteeLastUpdate[user][asset];
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return the cached total guarantee by asset with cache freshness metadata.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @param asset ERC20 guarantee asset address.
     * @return amount Current cached total locked amount in token base units.
     * @return isValid True if the cache block number is within the configured TTL.
     * @return blockNumber Cache block number.
     */
    function getTotalGuaranteeByAssetWithMeta(
        address asset
    )
        external
        view
        returns (uint256 amount, bool isValid, uint256 blockNumber)
    {
        amount = _totalGuaranteesByAsset[asset];
        blockNumber = _guaranteeLastUpdateByAsset[asset];
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return reward-related statistics with cache metadata through a best-effort path.
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *
     * Security:
     * - View-only.
     * - Best-effort external dependency: if EasyToken is missing in Registry or the call reverts,
     *   `r.totalEasyTokenSupply` is returned as 0.
     *   - Callers MUST treat this output as informational (not a ledger SSOT).
     *
     * @return r Reward stats where `rewardRate` is always 0 and `totalEasyTokenSupply` is best-effort.
     * @return isValid True if the global snapshot block number is within the configured TTL.
     * @return blockNumber Cache block number.
     */
    function getRewardStatsWithMeta()
        external
        view
        onlyValidRegistry
        returns (RewardStats memory r, bool isValid, uint256 blockNumber)
    {
        // rewardRate is deprecated; keep as 0.
        r.rewardRate = 0;
        // Best-effort: EasyToken.totalSupply(); module may be unset or revert.
        address easyTokenAddr = _getModule(ModuleKeys.KEY_EASY_TOKEN);
        if (easyTokenAddr != address(0)) {
            try IEasyTokenSupply(easyTokenAddr).totalSupply() returns (
                uint256 s
            ) {
                r.totalEasyTokenSupply = s;
            } catch {
                r.totalEasyTokenSupply = 0;
            }
        }
        blockNumber = _globalSnapshot.blockNumber;
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return the cached total seen user count with cache metadata.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return totalUsers Total seen user count.
     * @return isValid True if the global snapshot block number is within the configured TTL.
     * @return blockNumber Global snapshot block number.
     */
    function getTotalUsersWithMeta()
        external
        view
        returns (uint256 totalUsers, bool isValid, uint256 blockNumber)
    {
        totalUsers = _totalUsers;
        blockNumber = _globalSnapshot.blockNumber;
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return the last global cache update block number with cache metadata.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return blockNumber Last global update block number.
     * @return isValid True if `blockNumber` is within the configured TTL.
     */
    function getLastGlobalUpdateWithMeta()
        external
        view
        returns (uint256 blockNumber, bool isValid)
    {
        blockNumber = _lastGlobalUpdate;
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return the cached last-activity block number for a user with cache metadata.
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is not authorized for `user` (see {MissingRole} via Scheme U in onlyUserOrViewer)
     *
     * Security:
     * - View-only.
     *
     * @param user User address.
     * @return blockNumber Last activity block number.
     * @return isValid True if `blockNumber` is within the configured TTL.
     */
    function getUserLastActiveTimeWithMeta(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (uint256 blockNumber, bool isValid)
    {
        blockNumber = _userLastActiveTime[user];
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return the last guarantee-cache update block number with cache metadata.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return blockNumber Last guarantee update block number.
     * @return isValid True if `blockNumber` is within the configured TTL.
     */
    function getLastGuaranteeUpdateWithMeta()
        external
        view
        returns (uint256 blockNumber, bool isValid)
    {
        blockNumber = _lastGuaranteeUpdate;
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return the last guarantee-cache update block number for an asset with metadata.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @param asset ERC20 guarantee asset address.
     * @return blockNumber Last update block number for the asset.
     * @return isValid True if `blockNumber` is within the configured TTL.
     */
    function getGuaranteeLastUpdateByAssetWithMeta(
        address asset
    ) external view returns (uint256 blockNumber, bool isValid) {
        blockNumber = _guaranteeLastUpdateByAsset[asset];
        isValid = _isValid(blockNumber);
    }

    /**
     * @notice Return whether the user is currently considered active (position > 0) with metadata.
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller is not authorized for `user` (see {MissingRole} via Scheme U in onlyUserOrViewer)
     *
     * Security:
     * - View-only.
     *
     * @param user User address.
     * @return isActive True if cached collateral > 0 or cached debt > 0.
     * @return isValid Whether the cached user snapshot blockNumber is within `ViewConstants.CACHE_DURATION`.
     * @return blockNumber User snapshot blockNumber (block.number).
     */
    function isUserActiveWithMeta(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (bool isActive, bool isValid, uint256 blockNumber)
    {
        isActive = _userActiveStatus[user];
        blockNumber = _userSnapshots[user].blockNumber;
        isValid = _isValid(blockNumber);
    }

    function _applyGuaranteeUpdate(
        address user,
        address asset,
        uint256 amount,
        bool isLocked
    ) internal {
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

        uint256 blockNumber = block.number;
        _guaranteeLastUpdate[user][asset] = blockNumber;
        _guaranteeLastUpdateByAsset[asset] = blockNumber;
        _lastGuaranteeUpdate = blockNumber;
        _globalSnapshot.blockNumber = blockNumber;
        _lastGlobalUpdate = blockNumber;

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_GUARANTEE_STATS_UPDATE,
            abi.encode(
                user,
                asset,
                amount,
                isLocked,
                _userGuarantees[user][asset],
                _totalGuaranteesByAsset[asset],
                blockNumber
            )
        );
    }

    /*━━━━━━━━━━━━━━━ UUPS Upgrade ━━━━━━━━━━━━━━━*/
    function _getModule(
        bytes32 key
    ) internal view returns (address moduleAddr) {
        moduleAddr = Registry(_registryAddr).getModule(key);
    }

    function _requireStatsPusherOrAdmin() internal view {
        if (
            ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) return;
        address statsPusher = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_STATS_PUSH_MANAGER
        );
        if (msg.sender != statsPusher) revert MissingRole();
    }

    /**
     * @notice Authorize a UUPS upgrade.
     * @dev Reverts if:
     *      - registry is not set (see {ZeroAddress}, {NotAContract} via onlyValidRegistry)
     *      - caller lacks `ACTION_ADMIN` (see {MissingRole})
     *      - newImplementation == address(0) (see {StatisticsView__ZeroImplementation})
     *      - newImplementation is not a contract (see {NotAContract})
     *
     * Security:
     * - Role-gated via `ACTION_ADMIN` using {ViewAccessLib.hasRole} against the configured Registry.
     *
     * @param newImplementation New implementation address.
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
        if (newImplementation == address(0))
            revert StatisticsView__ZeroImplementation();
        if (newImplementation.code.length == 0)
            revert NotAContract(newImplementation);
    }
}

/// @dev Minimal view-only interface for EasyToken (avoid importing the full implementation).
interface IEasyTokenSupply {
    function totalSupply() external view returns (uint256);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { VaultMath } from "../../VaultMath.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @title StatisticsView
 * @notice Aggregated (cached) system-level statistics and lightweight push-based cache updates.
 * @dev Security:
 * - UUPS upgradeable contract; upgrades are admin-gated via Registry.
 * - All write paths are role-gated via Registry (admin or system-data pushers).
 *
 * Notes:
 * - Health factor and LTV are expressed in basis points (bps) where 10_000 = 100%.
 * - Collateral/debt values MUST share the same unit (domain "value" unit).
 * - Guarantee amounts are tracked in raw token units (token decimals).
 */
// solhint-disable-next-line max-states-count
contract StatisticsView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    /// @notice Thrown when an incoming user stats version is not the expected next version.
    error StatisticsView__StaleUserStatsVersion(uint64 currentVersion, uint64 incomingVersion);
    /// @notice Thrown when an incoming user stats sequence number is not strictly increasing.
    error StatisticsView__OutOfOrderSeq(uint64 currentSeq, uint64 incomingSeq);
    /// @notice Thrown when attempting to upgrade to the zero address.
    error StatisticsView__ZeroImplementation();

    /*━━━━━━━━━━━━━━━ Types ━━━━━━━━━━━━━━━*/
    /// @notice Per-user cached snapshot (kept compatible with legacy VaultStatistics for migration).
    struct UserSnapshot {
        uint256 collateral;      // Collateral value (must match `debt` unit)
        uint256 debt;            // Debt value (must match `collateral` unit)
        uint256 ltv;             // Loan-to-value (bps, 10_000 = 100%)
        uint256 healthFactor;    // Health factor (bps, 10_000 = 100%; max uint if debt==0 in VaultMath)
        uint256 timestamp;       // Snapshot timestamp (seconds)
        bool isActive;           // Reserved for legacy compatibility (do NOT use as SSOT)
    }

    /// @notice Global cached snapshot (kept compatible with legacy VaultStatistics for migration).
    struct GlobalSnapshot {
        uint256 totalCollateral;       // Total collateral value
        uint256 totalDebt;             // Total debt value
        uint256 averageLTV;            // Average LTV (bps, 10_000 = 100%) (currently best-effort / may be 0)
        uint256 averageHealthFactor;   // Average health factor (bps) (currently best-effort / may be 0)
        uint256 activeUsers;           // Active user count (position > 0)
        uint256 timestamp;             // Snapshot timestamp (seconds)
    }

    struct GlobalStatistics {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateTime;
    }

    struct RewardStats { uint256 rewardRate; uint256 totalRewardPoints; }

    /// @notice Cached graceful degradation stats payload.
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
    /// @notice user => last activity timestamp (seconds).
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
    /// @notice asset => last guarantee cache update timestamp (seconds).
    mapping(address => uint256) private _guaranteeLastUpdateByAsset;
    /// @notice Last guarantee cache update timestamp (seconds).
    uint256 private _lastGuaranteeUpdate;
    /// @notice Cached global snapshot.
    GlobalSnapshot private _globalSnapshot;
    /// @notice Last global cache update timestamp (seconds).
    uint256 private _lastGlobalUpdate;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /**
     * @notice Emitted when degradation stats are cached.
     * @dev Reverts if: (never)
     * Security: (event only)
     *
     * @param totalDegradations Total degradation count.
     * @param lastDegradationTime Timestamp (seconds) of the last degradation event.
     * @param lastDegradedModule Module address most recently degraded.
     * @param reasonHash Keccak256 hash of the degradation reason.
     * @param fallbackValueUsed Fallback value used in the last degradation (domain-specific unit).
     * @param totalFallbackValue Total fallback value accumulated (domain-specific unit).
     * @param averageFallbackValue Average fallback value (domain-specific unit).
     * @param timestamp Emit timestamp (seconds).
     */
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

    /**
     * @notice Emitted when a replayed idempotent request is ignored.
     * @dev Reverts if: (never)
     * Security: (event only)
     *
     * @param user User address.
     * @param requestId Idempotency key previously applied for the same version.
     * @param seq Optional monotonic sequence provided by the caller.
     */
    event IdempotentRequestIgnored(address indexed user, bytes32 indexed requestId, uint64 seq);

    /*━━━━━━━━━━━━━━━ Configuration ━━━━━━━━━━━━━━━*/
    /// @notice Registry address used for SSOT module resolution and access control.
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Upgrade Gap ━━━━━━━━━━━━━━━*/
    /// @dev Storage gap for upgrade safety (UUPS).
    uint256[44] private __gap;

    /*━━━━━━━━━━━━━━━ Versioning ━━━━━━━━━━━━━━━*/
    /**
     * @notice Return the external API semantic version for this view module.
     * @dev Reverts if: (never)
     * Security: (read-only)
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Return the schema version for cached outputs and DataPushed payloads.
     * @dev Reverts if: (never)
     * Security: (read-only)
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

    /// @dev Resolve ACM via Registry and require a role for `msg.sender`.
    modifier onlyRole(bytes32 actionKey) {
        ViewAccessLib.requireRole(_registryAddr, actionKey, msg.sender);
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
     * - Initializer: callable once.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;

        // Initialize snapshot for legacy compatibility.
        _globalSnapshot = GlobalSnapshot({
            totalCollateral: 0,
            totalDebt: 0,
            averageLTV: 0,
            averageHealthFactor: 0,
            activeUsers: 0,
            // solhint-disable-next-line not-rely-on-time
            timestamp: block.timestamp
        });
    }

    /*━━━━━━━━━━━━━━━ View Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Return the cached global statistics (legacy aggregate struct).
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @return g Cached global statistics (see `GlobalStatistics`).
     */
    function getGlobalStatistics() external view returns (GlobalStatistics memory g) {
        // Return cached snapshot; KEY_STATS is mapped to this contract at deployment time.
        GlobalSnapshot memory s = _globalSnapshot;
        g.totalUsers      = _totalUsers;
        g.activeUsers      = s.activeUsers;
        g.totalCollateral = s.totalCollateral;
        g.totalDebt       = s.totalDebt;
        g.lastUpdateTime  = s.timestamp;
    }

    /**
     * @notice Return cached global statistics together with cache freshness metadata.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @return g Cached global statistics (see `GlobalStatistics`).
     * @return isValid Whether the cache timestamp is within `ViewConstants.CACHE_DURATION`.
     * @return timestamp Cache timestamp (seconds).
     */
    function getGlobalStatisticsWithMeta()
        external
        view
        returns (GlobalStatistics memory g, bool isValid, uint256 timestamp)
    {
        GlobalSnapshot memory s = _globalSnapshot;
        g.totalUsers     = _totalUsers;
        g.activeUsers     = s.activeUsers;
        g.totalCollateral = s.totalCollateral;
        g.totalDebt       = s.totalDebt;
        g.lastUpdateTime  = s.timestamp;
        timestamp = s.timestamp;
        isValid = _isValid(timestamp);
    }

    /**
     * @notice Return cached global snapshot together with cache freshness metadata.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @return s Cached global snapshot.
     * @return isValid Whether the cache timestamp is within `ViewConstants.CACHE_DURATION`.
     * @return timestamp Cache timestamp (seconds).
     */
    function getGlobalSnapshotWithMeta()
        external
        view
        returns (GlobalSnapshot memory s, bool isValid, uint256 timestamp)
    {
        s = _globalSnapshot;
        timestamp = s.timestamp;
        isValid = _isValid(timestamp);
    }

    /**
     * @notice Return cached active user count together with cache freshness metadata.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @return activeUsers Cached active user count.
     * @return isValid Whether the cache timestamp is within `ViewConstants.CACHE_DURATION`.
     * @return timestamp Cache timestamp (seconds).
     */
    function getActiveUsersWithMeta()
        external
        view
        returns (uint256 activeUsers, bool isValid, uint256 timestamp)
    {
        GlobalSnapshot memory s = _globalSnapshot;
        activeUsers = s.activeUsers;
        timestamp = s.timestamp;
        isValid = _isValid(timestamp);
    }

    /**
     * @notice Return the cached per-user snapshot.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param user User address.
     * @return s Cached snapshot.
     */
    function getUserSnapshot(address user) external view returns (UserSnapshot memory s) {
        return _userSnapshots[user];
    }

    /**
     * @notice Return cached per-user snapshot together with concurrency/idempotency metadata.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param user User address.
     * @return s Cached snapshot.
     * @return version Current optimistic concurrency version.
     * @return seq Current monotonic sequence (0 if never provided).
     * @return lastAppliedRequestId Last applied idempotency key (bytes32(0) if none).
     * @return isValid Whether the snapshot timestamp is within `ViewConstants.CACHE_DURATION`.
     * @return timestamp Snapshot timestamp (seconds).
     */
    function getUserSnapshotWithMeta(address user)
        external
        view
        returns (
            UserSnapshot memory s,
            uint64 version,
            uint64 seq,
            bytes32 lastAppliedRequestId,
            bool isValid,
            uint256 timestamp
        )
    {
        s = _userSnapshots[user];
        version = _userStatsVersion[user];
        seq = _userStatsSeq[user];
        lastAppliedRequestId = _lastAppliedUserStatsRequestId[user];
        timestamp = s.timestamp;
        isValid = _isValid(timestamp);
    }

    /**
     * @notice Return the current user stats version (for upstream optimistic concurrency).
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param user User address.
     * @return Current version.
     */
    function getUserStatsVersion(address user) external view returns (uint64) {
        return _userStatsVersion[user];
    }

    /**
     * @notice Return the current user stats sequence number (optional offchain ordering aid).
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param user User address.
     * @return Current sequence.
     */
    function getUserStatsSeq(address user) external view returns (uint64) {
        return _userStatsSeq[user];
    }

    /**
     * @notice Return the last applied idempotency key for the user (O(1) replay context).
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param user User address.
     * @return requestId Last applied idempotency key.
     */
    function getUserStatsLastAppliedRequestId(address user) external view returns (bytes32) {
        return _lastAppliedUserStatsRequestId[user];
    }

    /**
     * @notice Return reward-related statistics (best-effort).
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only.
     *
     * @return r Reward stats where:
     *         - r.rewardRate is deprecated and always 0
     *         - r.totalRewardPoints is RewardPoints.totalSupply() (0 if module missing / call fails)
     */
    function getRewardStats() external view onlyValidRegistry returns (RewardStats memory r) {
        // rewardRate is deprecated; keep as 0.
        r.rewardRate = 0;
        // Best-effort: RewardPoints.totalSupply(); module may be unset or revert.
        address rp = _getModule(ModuleKeys.KEY_REWARD_POINTS);
        if (rp == address(0)) return r;
        try IRewardPointsSupply(rp).totalSupply() returns (uint256 s) {
            r.totalRewardPoints = s;
        } catch {
            // no-op: keep default 0 on failure
            r.totalRewardPoints = 0;
        }
    }

    /*━━━━━━━━━━━━━━━ Internal Helpers ━━━━━━━━━━━━━━━*/
    function _isValid(uint256 ts) internal view returns (bool) {
        uint256 dur = ViewConstants.CACHE_DURATION;
        // solhint-disable-next-line not-rely-on-time
        return ts > 0 && block.timestamp - ts <= dur;
    }

    /**
     * @notice Cache the latest graceful degradation stats snapshot.
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized (ViewAccessLib.requireRole / admin check)
     *
     * Security:
     * - Role-gated: admin OR ACTION_VIEW_SYSTEM_STATUS.
     *
     * @param s Degradation stats payload to cache.
     */
    function pushDegradationStats(GracefulDegradationStats calldata s) external onlyValidRegistry {
        // Allow admin; otherwise require system status view permission.
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
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );
        // Push to generic data bus
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_DEGRADATION_STATS_UPDATE, abi.encode(s));
    }

    /**
     * @notice Return the last cached degradation stats payload.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @return Last cached degradation stats.
     */
    function getDegradationStats() external view returns (GracefulDegradationStats memory) {
        return _degradationStats;
    }

    /**
     * @notice Push an incremental user stats update (no explicit versioning context).
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized (ViewAccessLib.requireRole / admin check)
     *      - user == address(0) (ZeroAddress)
     *
     * Security:
     * - Role-gated: admin OR ACTION_VIEW_SYSTEM_DATA.
     *
     * @param user User address.
     * @param collateralIn Collateral value added (must share unit with debt).
     * @param collateralOut Collateral value removed (must share unit with debt).
     * @param borrow Debt value added (must share unit with collateral).
     * @param repay Debt value removed (must share unit with collateral).
     */
    function pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay
    ) external onlyValidRegistry {
        // Allow ADMIN; otherwise require system-data view push permission.
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        }
        _pushUserStatsUpdate(user, collateralIn, collateralOut, borrow, repay, bytes32(0), 0, 0);
    }

    /**
     * @notice Push an incremental user stats update with optimistic concurrency (nextVersion).
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized (ViewAccessLib.requireRole / admin check)
     *      - user == address(0) (ZeroAddress)
     *      - nextVersion != currentVersion + 1 (StatisticsView__StaleUserStatsVersion)
     *
     * Security:
     * - Role-gated: admin OR ACTION_VIEW_SYSTEM_DATA.
     * - Strict optimistic concurrency when nextVersion != 0.
     *
     * @param user User address.
     * @param collateralIn Collateral value added (must share unit with debt).
     * @param collateralOut Collateral value removed (must share unit with debt).
     * @param borrow Debt value added (must share unit with collateral).
     * @param repay Debt value removed (must share unit with collateral).
     * @param nextVersion Expected next version (must be current + 1).
     */
    function pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay,
        uint64 nextVersion
    ) external onlyValidRegistry {
        // Allow ADMIN; otherwise require system-data view push permission.
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        }
        _pushUserStatsUpdate(user, collateralIn, collateralOut, borrow, repay, bytes32(0), 0, nextVersion);
    }

    /**
     * @notice Push an incremental user stats update with idempotency + ordering context.
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized (ViewAccessLib.requireRole / admin check)
     *      - user == address(0) (ZeroAddress)
     *      - seq is not strictly increasing (StatisticsView__OutOfOrderSeq) when seq != 0
     *      - nextVersion != currentVersion + 1 (StatisticsView__StaleUserStatsVersion) when nextVersion != 0
     *
     * Security:
     * - Role-gated: admin OR ACTION_VIEW_SYSTEM_DATA.
     * - Idempotent replay (no revert): if (nextVersion == currentVersion) AND (requestId matches lastAppliedRequestId),
     *   this function emits `IdempotentRequestIgnored` and returns without writing.
     *
     * @param user User address.
     * @param collateralIn Collateral value added (must share unit with debt).
     * @param collateralOut Collateral value removed (must share unit with debt).
     * @param borrow Debt value added (must share unit with collateral).
     * @param repay Debt value removed (must share unit with collateral).
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
    ) external onlyValidRegistry {
        // Allow ADMIN; otherwise require system-data view push permission.
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        }
        _pushUserStatsUpdate(user, collateralIn, collateralOut, borrow, repay, requestId, seq, nextVersion);
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
            if (nextVersion == currentVersion && _lastAppliedUserStatsRequestId[user] == requestId) {
                emit IdempotentRequestIgnored(user, requestId, seq);
                return;
            }
        }

        // Optional monotonic ordering aid (seq):
        if (seq != 0) {
            uint64 curSeq = _userStatsSeq[user];
            if (seq <= curSeq) revert StatisticsView__OutOfOrderSeq(curSeq, seq);
            _userStatsSeq[user] = seq;
        }

        uint64 newVersion = nextVersion;
        if (nextVersion == 0) {
            newVersion = currentVersion + 1;
        } else {
            // strict: nextVersion must be exactly current + 1
            if (nextVersion != currentVersion + 1) {
                revert StatisticsView__StaleUserStatsVersion(currentVersion, nextVersion);
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
            snap.collateral = snap.collateral > collateralOut ? snap.collateral - collateralOut : 0;
        }
        if (borrow > 0) {
            snap.debt += borrow;
        }
        if (repay > 0) {
            snap.debt = snap.debt > repay ? snap.debt - repay : 0;
        }
        // Compute derived metrics (bps).
        snap.ltv = VaultMath.calculateLTV(snap.debt, snap.collateral);
        snap.healthFactor = VaultMath.calculateHealthFactor(snap.collateral, snap.debt);
        // solhint-disable-next-line not-rely-on-time
        snap.timestamp = block.timestamp;

        // Update last activity timestamp.
        // solhint-disable-next-line not-rely-on-time
        _userLastActiveTime[user] = block.timestamp;

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
            _globalSnapshot.totalCollateral = tc > collateralOut ? tc - collateralOut : 0;
        }
        if (borrow > 0) {
            _globalSnapshot.totalDebt += borrow;
        }
        if (repay > 0) {
            uint256 td = _globalSnapshot.totalDebt;
            _globalSnapshot.totalDebt = td > repay ? td - repay : 0;
        }

        // Update snapshot timestamp and active user count.
        _globalSnapshot.activeUsers = _activeUsers;
        // solhint-disable-next-line not-rely-on-time
        _globalSnapshot.timestamp = block.timestamp;
        // solhint-disable-next-line not-rely-on-time
        _lastGlobalUpdate = block.timestamp;

        // Observable success path (Phase 3): emit DataPushed with replay-friendly payload.
        // NOTE: Keep payload compact to avoid "stack too deep" and reduce gas.
        _emitUserStatsDataPushed(user, newVersion, requestId, seq);
    }

    /**
     * @notice Legacy compatibility alias for updating user stats (role-gated differently).
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_SET_PARAMETER (ViewAccessLib.requireRole)
     *      - user == address(0) (ZeroAddress)
     *
     * Security:
     * - Role-gated: ACTION_SET_PARAMETER (legacy path).
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
    ) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        // NOTE: do NOT use external self-call (`this.`), otherwise msg.sender becomes this contract and
        // will fail ACTION_VIEW_SYSTEM_DATA checks in pushUserStatsUpdate. Keep legacy permission here.
        _pushUserStatsUpdate(user, collateralIn, collateralOut, borrow, repay, bytes32(0), 0, 0);
    }

    /**
     * @notice Push an incremental guarantee cache update for (user, asset).
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized (ViewAccessLib.requireRole / admin check)
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - Role-gated: admin OR ACTION_VIEW_SYSTEM_DATA.
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
    ) external onlyValidRegistry {
        // Allow ADMIN; otherwise require system-data view push permission.
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        }
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
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        _guaranteeLastUpdateByAsset[asset] = ts;
        _lastGuaranteeUpdate = ts;

        // keep global stats freshness monotonic for any stats-related update
        _globalSnapshot.timestamp = ts;
        _lastGlobalUpdate = ts;

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
                ts
            )
        );
    }

    function _emitUserStatsDataPushed(address user, uint64 version, bytes32 requestId, uint64 seq) internal {
        UserSnapshot memory u = _userSnapshots[user];
        GlobalSnapshot memory g = _globalSnapshot;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_USER_STATS_UPDATE,
            abi.encode(user, version, requestId, seq, u, g)
        );
    }

    /**
     * @notice Legacy compatibility alias for guarantee cache updates (role-gated differently).
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_SET_PARAMETER (ViewAccessLib.requireRole)
     *      - user == address(0) (ZeroAddress)
     *      - asset == address(0) (ZeroAddress)
     *
     * Security:
     * - Role-gated: ACTION_SET_PARAMETER (legacy path).
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
    ) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        // legacy compatibility: keep ACTION_SET_PARAMETER gate and apply directly
        _applyGuaranteeUpdate(user, asset, guaranteeAmount, isLocked);
    }

    /**
     * @notice Record a lightweight user snapshot timestamp for offchain consumers.
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not authorized (ViewAccessLib.requireRole / admin check)
     *      - user == address(0) (ZeroAddress)
     *
     * Security:
     * - Role-gated: admin OR ACTION_VIEW_SYSTEM_DATA.
     *
     * @param user User address.
     */
    function recordSnapshot(address user) external onlyValidRegistry {
        // Allow ADMIN; otherwise require system-data view push permission.
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        }
        if (user == address(0)) revert ZeroAddress();
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        _userLastActiveTime[user] = ts;
        _globalSnapshot.timestamp = ts;
        _lastGlobalUpdate = ts;

        // Emit DataPushed for observability (Architecture-Guide/Workguide acceptance).
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_STATS_SNAPSHOT_RECORDED,
            abi.encode(user, ts, _userStatsVersion[user], _userStatsSeq[user])
        );
    }

    /*━━━━━━━━━━━━━━━ Additional View Getters ━━━━━━━━━━━━━━━*/
    /**
     * @notice Return the cached global snapshot.
     * @dev Reverts if: (never)
     * Security: (read-only)
     */
    function getGlobalSnapshot() external view returns (GlobalSnapshot memory s) {
        return _globalSnapshot;
    }

    /**
     * @notice Return the cached user guarantee balance with cache freshness metadata.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param user User address.
     * @param asset ERC20 guarantee asset address.
     * @return amount Current cached locked amount (token decimals).
     * @return isValid Whether the cache timestamp is within `ViewConstants.CACHE_DURATION`.
     * @return timestamp Cache timestamp (seconds).
     */
    function getUserGuaranteeBalanceWithMeta(address user, address asset)
        external
        view
        returns (uint256 amount, bool isValid, uint256 timestamp)
    {
        amount = _userGuarantees[user][asset];
        timestamp = _guaranteeLastUpdateByAsset[asset];
        isValid = _isValid(timestamp);
    }

    /**
     * @notice Return the cached total guarantee by asset with cache freshness metadata.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param asset ERC20 guarantee asset address.
     * @return amount Current cached total locked amount (token decimals).
     * @return isValid Whether the cache timestamp is within `ViewConstants.CACHE_DURATION`.
     * @return timestamp Cache timestamp (seconds).
     */
    function getTotalGuaranteeByAssetWithMeta(address asset)
        external
        view
        returns (uint256 amount, bool isValid, uint256 timestamp)
    {
        amount = _totalGuaranteesByAsset[asset];
        timestamp = _guaranteeLastUpdateByAsset[asset];
        isValid = _isValid(timestamp);
    }

    /**
     * @notice Return the last guarantee cache update timestamp.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @return timestamp Seconds since epoch.
     */
    function getLastGuaranteeUpdate() external view returns (uint256) {
        return _lastGuaranteeUpdate;
    }

    /**
     * @notice Return the last guarantee cache update timestamp for an asset.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param asset ERC20 guarantee asset address.
     * @return timestamp Seconds since epoch.
     */
    function getGuaranteeLastUpdateByAsset(address asset) external view returns (uint256) {
        return _guaranteeLastUpdateByAsset[asset];
    }

    /**
     * @notice Return the configured Registry address for this view module.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @return Registry address.
     */
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /**
     * @notice Return whether the user is currently considered active (position > 0).
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param user User address.
     * @return True if cached collateral > 0 or cached debt > 0.
     */
    function isUserActive(address user) external view returns (bool) {
        return _userActiveStatus[user];
    }

    /**
     * @notice Return the cached last activity timestamp for a user.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param user User address.
     * @return timestamp Seconds since epoch.
     */
    function getUserLastActiveTime(address user) external view returns (uint256) {
        return _userLastActiveTime[user];
    }

    /**
     * @notice Return the cached locked guarantee amount for (user, asset).
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param user User address.
     * @param asset ERC20 guarantee asset address.
     * @return amount Locked amount (token decimals).
     */
    function getUserGuaranteeBalance(address user, address asset) external view returns (uint256) {
        return _userGuarantees[user][asset];
    }

    /**
     * @notice Return the cached total locked guarantee amount for an asset across all users.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @param asset ERC20 guarantee asset address.
     * @return amount Total locked amount (token decimals).
     */
    function getTotalGuaranteeByAsset(address asset) external view returns (uint256) {
        return _totalGuaranteesByAsset[asset];
    }

    /**
     * @notice Return the cached active user count (position > 0).
     * @dev Reverts if: (never)
     * Security: (read-only)
     */
    function getActiveUsers() external view returns (uint256) {
        return _activeUsers;
    }

    /**
     * @notice Return the cached total seen user count.
     * @dev Reverts if: (never)
     * Security: (read-only)
     */
    function getTotalUsers() external view returns (uint256) {
        return _totalUsers;
    }

    /**
     * @notice Return the last global cache update timestamp.
     * @dev Reverts if: (never)
     * Security: (read-only)
     *
     * @return timestamp Seconds since epoch.
     */
    function getLastGlobalUpdate() external view returns (uint256) {
        return _lastGlobalUpdate;
    }

    function _applyGuaranteeUpdate(address user, address asset, uint256 amount, bool isLocked) internal {
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

        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        _guaranteeLastUpdateByAsset[asset] = ts;
        _lastGuaranteeUpdate = ts;
        _globalSnapshot.timestamp = ts;
        _lastGlobalUpdate = ts;

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_GUARANTEE_STATS_UPDATE,
            abi.encode(
                user,
                asset,
                amount,
                isLocked,
                _userGuarantees[user][asset],
                _totalGuaranteesByAsset[asset],
                ts
            )
        );
    }

    /*━━━━━━━━━━━━━━━ UUPS Upgrade ━━━━━━━━━━━━━━━*/
    function _getModule(bytes32 key) internal view returns (address moduleAddr) {
        moduleAddr = Registry(_registryAddr).getModule(key);
    }

    /**
     * @notice Authorize a UUPS upgrade.
     * @dev Reverts if:
     *      - registry is not set (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (ViewAccessLib.requireRole)
     *      - newImplementation == address(0) (StatisticsView__ZeroImplementation)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
     * - Admin-gated via Registry.
     *
     * @param newImplementation New implementation address.
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert StatisticsView__ZeroImplementation();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }
} 

/// @dev Minimal read-only interface for RewardPoints (avoid importing the full implementation).
interface IRewardPointsSupply {
    function totalSupply() external view returns (uint256);
}
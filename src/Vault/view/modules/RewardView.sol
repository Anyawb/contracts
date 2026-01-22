// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { RewardTypes } from "../../../Reward/RewardTypes.sol";
import { IServiceConfig } from "../../../Reward/interfaces/IServiceConfig.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { ViewConstants } from "../ViewConstants.sol";

/**
 * @title RewardView
 * @notice Reward system view module: read aggregations + unified DataPush for off-chain consumers.
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - caller is not an authorized writer for push APIs (RewardView__UnauthorizedWriter)
 *      - caller is not authorized for a user-scoped read (MissingRole)
 *
 * Security:
 * - Role-gated writes: only RewardManagerCore and RewardConsumption (resolved via Registry) can push updates.
 * - Some reads are role-gated for ops/admin visibility (VIEW_USER_DATA / ADMIN), as these can reveal user reward data.
 * - Unified DataPush: push* functions emit DataPushed events via DataPushLibrary for off-chain indexing.
 */
contract RewardView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Caller is not an authorized writer module.
    /// @dev Reverts when caller is not RewardManagerCore nor RewardConsumption (as resolved via Registry).
    error RewardView__UnauthorizedWriter();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    address private _registryAddr;

    struct UserSummary {
        uint256 totalEarned;
        uint256 totalBurned;
        uint256 pendingPenalty;
        uint8 level;
        uint256 privilegesPacked;
        uint256 lastActivity;
        uint256 totalLoans;
        uint256 totalVolume;
    }

    mapping(address => UserSummary) private _userSummary;
    mapping(address => uint256) private _userCacheTimestamps;

    /*━━━━━━━━━━━━━━━ Local activity cache (RewardView-only) ━━━━━━━━━━━━━━━*/

    /// @notice Minimal activity record for user-centric reward activity browsing.
    /// @dev kind: 1=earned, 2=burned, 3=penalty.
    struct Activity {
        uint8 kind;
        uint256 amount;
        uint256 ts;
    }

    mapping(address => Activity[]) private _activities;
    uint256 private constant _MAX_ACTIVITY_SCAN = 500;
    uint256 private constant _CACHE_DURATION = ViewConstants.CACHE_DURATION;

    /*━━━━━━━━━━━━━━━ Consumption-side cache (RewardView-only) ━━━━━━━━━━━━━━━*/

    mapping(address => RewardTypes.ConsumptionRecord[]) private _consumptions;
    mapping(address => mapping(RewardTypes.ServiceType => uint256)) private _lastConsumption;
    mapping(RewardTypes.ServiceType => uint256) private _serviceUsage;
    
    /*━━━━━━━━━━━━━━━ Top earners cache (fixed length) ━━━━━━━━━━━━━━━*/

    uint256 private constant _TOP_N = 10;
    address[_TOP_N] private _topEarners;
    uint256[_TOP_N] private _topEarnedAmounts;
    mapping(address => bool) private _isActiveUser;

    struct SystemStats {
        uint256 totalBatchOps;
        uint256 totalCachedRewards;
        uint256 activeUsers;
    }

    SystemStats private _systemStats;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    modifier onlyWriter() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        address rmc = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        address rc = _getModule(ModuleKeys.KEY_REWARD_CONSUMPTION);
        if (rmc == address(0) || rc == address(0)) revert ZeroAddress();
        if (msg.sender != rmc && msg.sender != rc) revert RewardView__UnauthorizedWriter();
        _;
    }

    /// @dev Gate: caller must be the user, or have VIEW_USER_DATA.
    modifier onlyAuthorizedFor(address user) {
        if (msg.sender != user && !_hasViewUserDataRole(msg.sender)) {
            revert MissingRole();
        }
        _;
    }

    /// @dev Gate: caller must have VIEW_USER_DATA or ADMIN.
    modifier onlyOps() {
        if (
            !_hasViewUserDataRole(msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) {
            revert MissingRole();
        }
        _;
    }

    /// @dev Gate: caller must be LendingEngine (KEY_LE).
    modifier onlyLendingEngine() {
        address le = _getModule(ModuleKeys.KEY_LE);
        if (le == address(0) || msg.sender != le) revert MissingRole();
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the RewardView (UUPS).
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

    /*━━━━━━━━━━━━━━━ Admin APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Update the Registry address.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (MissingRole via ViewAccessLib.requireRole)
     *      - newRegistry is zero (ZeroAddress)
     *      - newRegistry is not a contract (NotAContract)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     *
     * @param newRegistry New Registry contract address
     */
    function setRegistry(address newRegistry) external onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newRegistry == address(0)) revert ZeroAddress();
        if (newRegistry.code.length == 0) revert NotAContract(newRegistry);
        _registryAddr = newRegistry;
    }

    /*━━━━━━━━━━━━━━━ Push APIs (writers only) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Push a "reward earned" update for a user and emit a unified DataPush event.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract)
     *      - RewardManagerCore / RewardConsumption is missing in Registry (ZeroAddress via onlyWriter)
     *      - caller is not an authorized writer module (RewardView__UnauthorizedWriter)
     *
     * Security:
     * - onlyWriter (RewardManagerCore / RewardConsumption)
     * - Emits DataPushed(DATA_TYPE_REWARD_EARNED, abi.encode(user, amount, reason, ts))
     *
     * @param user User address
     * @param amount Earned points amount (points units, system-defined)
     * @param reason Short reason string (off-chain display only)
     * @param ts Business timestamp (seconds since epoch; writer-defined)
     */
    function pushRewardEarned(address user, uint256 amount, string calldata reason, uint256 ts)
        external
        onlyWriter
    {
        UserSummary storage s = _userSummary[user];
        s.totalEarned += amount;
        if (ts > s.lastActivity) s.lastActivity = ts;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _activities[user].push(Activity({ kind: 1, amount: amount, ts: ts }));
        _updateTopEarners(user, s.totalEarned);
        _touchUserCache(user);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_EARNED, abi.encode(user, amount, reason, ts));
    }

    /**
     * @notice Push a "points burned" update for a user and emit a unified DataPush event.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
     * - onlyWriter (RewardManagerCore / RewardConsumption)
     * - Emits DataPushed(DATA_TYPE_REWARD_BURNED, abi.encode(user, amount, reason, ts))
     *
     * @param user User address
     * @param amount Burned points amount (points units, system-defined)
     * @param reason Short reason string (off-chain display only)
     * @param ts Business timestamp (seconds since epoch; writer-defined)
     */
    function pushPointsBurned(address user, uint256 amount, string calldata reason, uint256 ts)
        external
        onlyWriter
    {
        UserSummary storage s = _userSummary[user];
        s.totalBurned += amount;
        if (ts > s.lastActivity) s.lastActivity = ts;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _activities[user].push(Activity({ kind: 2, amount: amount, ts: ts }));
        _touchUserCache(user);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_BURNED, abi.encode(user, amount, reason, ts));
    }

    /**
     * @notice Admin retry helper: replay a "points burned" push (manual recovery).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (MissingRole via ViewAccessLib.requireRole)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     * - Should not be used on normal paths (manual recovery only)
     *
     * @param user User address
     * @param amount Burned points amount
     * @param reason Short reason string
     * @param ts Business timestamp (seconds since epoch; admin-defined)
     */
    function retryPushPointsBurned(address user, uint256 amount, string calldata reason, uint256 ts)
        external
        onlyValidRegistry
    {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        UserSummary storage s = _userSummary[user];
        s.totalBurned += amount;
        if (ts > s.lastActivity) s.lastActivity = ts;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _activities[user].push(Activity({ kind: 2, amount: amount, ts: ts }));
        _touchUserCache(user);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_BURNED, abi.encode(user, amount, reason, ts));
    }

    /**
     * @notice Push a penalty ledger (pending points debt) update for a user.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
     * - onlyWriter (RewardManagerCore / RewardConsumption)
     * - Emits DataPushed(DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED, abi.encode(user, pendingDebt, ts))
     *
     * @param user User address
     * @param pendingDebt Pending points debt (points units, system-defined)
     * @param ts Business timestamp (seconds since epoch; writer-defined)
     */
    function pushPenaltyLedger(address user, uint256 pendingDebt, uint256 ts) external onlyWriter {
        UserSummary storage s = _userSummary[user];
        s.pendingPenalty = pendingDebt;
        if (ts > s.lastActivity) s.lastActivity = ts;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _activities[user].push(Activity({ kind: 3, amount: pendingDebt, ts: ts }));
        _touchUserCache(user);
        // penaltyLedger uses a dedicated dataTypeHash to avoid payload ambiguity with REWARD_STATS_UPDATED.
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED,
            abi.encode(user, pendingDebt, ts)
        );
    }

    /**
     * @notice Push a user level update and emit a unified DataPush event.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
     * - onlyWriter (RewardManagerCore / RewardConsumption)
     * - Emits DataPushed(DATA_TYPE_REWARD_LEVEL_UPDATED, abi.encode(user, newLevel, ts))
     *
     * @param user User address
     * @param newLevel New level (system-defined; not range-validated here)
     * @param ts Business timestamp (seconds since epoch; writer-defined)
     */
    function pushUserLevel(address user, uint8 newLevel, uint256 ts) external onlyWriter {
        _userSummary[user].level = newLevel;
        if (ts > _userSummary[user].lastActivity) _userSummary[user].lastActivity = ts;
        _touchUserCache(user);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_LEVEL_UPDATED, abi.encode(user, newLevel, ts));
    }

    /**
     * @notice Push a user privilege bitmap update and emit a unified DataPush event.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
     * - onlyWriter (RewardManagerCore / RewardConsumption)
     * - Emits DataPushed(DATA_TYPE_REWARD_PRIVILEGE_UPDATED, abi.encode(user, privilegePacked, ts))
     *
     * @param user User address
     * @param privilegePacked Packed privilege bitmap (uint256)
     * @param ts Business timestamp (seconds since epoch; writer-defined)
     */
    function pushUserPrivilege(address user, uint256 privilegePacked, uint256 ts) external onlyWriter {
        _userSummary[user].privilegesPacked = privilegePacked;
        if (ts > _userSummary[user].lastActivity) _userSummary[user].lastActivity = ts;
        _touchUserCache(user);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_PRIVILEGE_UPDATED,
            abi.encode(user, privilegePacked, ts)
        );
    }

    /**
     * @notice Admin retry helper: replay a "user privilege" push (manual recovery).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (MissingRole via ViewAccessLib.requireRole)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     * - Should not be used on normal paths (manual recovery only)
     *
     * @param user User address
     * @param privilegePacked Packed privilege bitmap
     * @param ts Business timestamp (seconds since epoch; admin-defined)
     */
    function retryPushUserPrivilege(address user, uint256 privilegePacked, uint256 ts)
        external
        onlyValidRegistry
    {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        _userSummary[user].privilegesPacked = privilegePacked;
        if (ts > _userSummary[user].lastActivity) _userSummary[user].lastActivity = ts;
        _touchUserCache(user);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_PRIVILEGE_UPDATED,
            abi.encode(user, privilegePacked, ts)
        );
    }

    /**
     * @notice Push a user consumption record into RewardView's local cache.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract)
     *      - RewardManagerCore / RewardConsumption is missing in Registry (ZeroAddress via onlyWriter)
     *      - caller is not an authorized writer module (RewardView__UnauthorizedWriter)
     *      - caller is not RewardConsumption (RewardView__UnauthorizedWriter)
     *
     * Security:
     * - onlyWriter (and additionally restricted to RewardConsumption)
     * - Does NOT emit DataPushed to avoid duplicating semantics with REWARD_BURNED / REWARD_PRIVILEGE_UPDATED.
     *
     * @param user User address
     * @param serviceType Service type (RewardTypes.ServiceType)
     * @param serviceLevel Service level (RewardTypes.ServiceLevel)
     * @param points Points spent (points units)
     * @param expirationTime Expiration time (seconds since epoch; service-defined)
     * @param ts Business timestamp (seconds since epoch; writer-defined)
     */
    function pushConsumptionRecord(
        address user,
        RewardTypes.ServiceType serviceType,
        RewardTypes.ServiceLevel serviceLevel,
        uint256 points,
        uint256 expirationTime,
        uint256 ts
    ) external onlyWriter {
        address rc = _getModule(ModuleKeys.KEY_REWARD_CONSUMPTION);
        if (msg.sender != rc) revert RewardView__UnauthorizedWriter();

        _consumptions[user].push(
            RewardTypes.ConsumptionRecord({
                points: points,
                timestamp: ts,
                serviceType: serviceType,
                serviceLevel: serviceLevel,
                isActive: true,
                expirationTime: expirationTime
            })
        );
        _lastConsumption[user][serviceType] = ts;
        unchecked { _serviceUsage[serviceType] += 1; }
        _touchUserCache(user);
    }

    /**
     * @notice Admin retry helper: replay a "consumption record" push (manual recovery).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (MissingRole via ViewAccessLib.requireRole)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     * - Should not be used on normal paths (manual recovery only)
     *
     * @param user User address
     * @param serviceType Service type
     * @param serviceLevel Service level
     * @param points Points spent (points units)
     * @param expirationTime Expiration time (seconds)
     * @param ts Business timestamp (seconds)
     */
    function retryPushConsumptionRecord(
        address user,
        RewardTypes.ServiceType serviceType,
        RewardTypes.ServiceLevel serviceLevel,
        uint256 points,
        uint256 expirationTime,
        uint256 ts
    ) external onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        _consumptions[user].push(
            RewardTypes.ConsumptionRecord({
                points: points,
                timestamp: ts,
                serviceType: serviceType,
                serviceLevel: serviceLevel,
                isActive: true,
                expirationTime: expirationTime
            })
        );
        _lastConsumption[user][serviceType] = ts;
        unchecked { _serviceUsage[serviceType] += 1; }
        _touchUserCache(user);
    }

    /**
     * @notice Push system-level reward stats and emit a unified DataPush event.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
     * - onlyWriter (RewardManagerCore / RewardConsumption)
     * - Emits DataPushed(DATA_TYPE_REWARD_STATS_UPDATED, abi.encode(totalBatchOps, totalCachedRewards, ts))
     *
     * @param totalBatchOps Total batch operations count (writer-defined)
     * @param totalCachedRewards Total cache-hit count (writer-defined)
     * @param ts Business timestamp (seconds since epoch; writer-defined)
     */
    function pushSystemStats(uint256 totalBatchOps, uint256 totalCachedRewards, uint256 ts)
        external
        onlyWriter
    {
        _systemStats.totalBatchOps = totalBatchOps;
        _systemStats.totalCachedRewards = totalCachedRewards;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_STATS_UPDATED,
            abi.encode(totalBatchOps, totalCachedRewards, ts)
        );
    }

    /*━━━━━━━━━━━━━━━ Read APIs (0-gas views) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get a user's reward summary from RewardView local cache.
     * @dev Reverts if:
     *      - caller is not the user and lacks VIEW_USER_DATA (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return totalEarned Total earned points (points units)
     * @return totalBurned Total burned points (points units)
     * @return pendingPenalty Pending penalty debt (points units)
     * @return level User level (system-defined)
     * @return privilegesPacked Packed privilege bitmap (uint256)
     * @return lastActivity Last activity timestamp (seconds since epoch; writer-defined)
     * @return totalLoans Reserved (currently not maintained)
     * @return totalVolume Reserved (currently not maintained)
     */
    function getUserRewardSummary(address user)
        external
        view
        onlyAuthorizedFor(user)
        returns (
            uint256 totalEarned,
            uint256 totalBurned,
            uint256 pendingPenalty,
            uint8 level,
            uint256 privilegesPacked,
            uint256 lastActivity,
            uint256 totalLoans,
            uint256 totalVolume
        )
    {
        UserSummary storage s = _userSummary[user];
        return (
            s.totalEarned,
            s.totalBurned,
            s.pendingPenalty,
            s.level,
            s.privilegesPacked,
            s.lastActivity,
            s.totalLoans,
            s.totalVolume
        );
    }

    /**
     * @notice Get a user's reward summary plus local cache metadata (timestamp + TTL validity).
     * @dev Reverts if:
     *      - caller is not the user and lacks VIEW_USER_DATA (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return totalEarned Total earned points
     * @return totalBurned Total burned points
     * @return pendingPenalty Pending penalty debt
     * @return level User level
     * @return privilegesPacked Packed privilege bitmap
     * @return lastActivity Last activity timestamp (seconds; writer-defined)
     * @return totalLoans Reserved (currently not maintained)
     * @return totalVolume Reserved (currently not maintained)
     * @return timestamp RewardView local cache last-write time (block.timestamp, seconds)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserRewardSummaryWithMeta(address user)
        external
        view
        onlyAuthorizedFor(user)
        returns (
            uint256 totalEarned,
            uint256 totalBurned,
            uint256 pendingPenalty,
            uint8 level,
            uint256 privilegesPacked,
            uint256 lastActivity,
            uint256 totalLoans,
            uint256 totalVolume,
            uint256 timestamp,
            bool isValid
        )
    {
        UserSummary storage s = _userSummary[user];
        timestamp = _userCacheTimestamps[user];
        isValid = _isUserCacheValid(timestamp);
        return (
            s.totalEarned,
            s.totalBurned,
            s.pendingPenalty,
            s.level,
            s.privilegesPacked,
            s.lastActivity,
            s.totalLoans,
            s.totalVolume,
            timestamp,
            isValid
        );
    }

    /**
     * @notice Get system-level reward stats from RewardView local cache.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_USER_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - Read-only
     *
     * @return totalBatchOps Total batch operations count (writer-defined)
     * @return totalCachedRewards Total cache-hit count (writer-defined)
     * @return activeUsers Active user count (RewardView-local)
     */
    function getSystemRewardStats()
        external
        view
        onlyValidRegistry
        onlyOps
        returns (uint256 totalBatchOps, uint256 totalCachedRewards, uint256 activeUsers)
    {
        return (_systemStats.totalBatchOps, _systemStats.totalCachedRewards, _systemStats.activeUsers);
    }

    /**
     * @notice Get the current Registry address used by this module.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr Registry contract address
     */
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Extended read APIs ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get a user's recent reward activities from local cache (reverse scan with window filters).
     * @dev Reverts if:
     *      - caller is not the user and lacks VIEW_USER_DATA (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @param fromTs Inclusive start timestamp filter (seconds). 0 means no lower bound.
     * @param toTs Inclusive end timestamp filter (seconds). 0 means no upper bound.
     * @param limit Maximum number of entries to return (0 returns empty)
     * @return out Activity array (most recent first). Scan is capped by _MAX_ACTIVITY_SCAN.
     */
    function getUserRecentActivities(address user, uint256 fromTs, uint256 toTs, uint256 limit)
        external
        view
        onlyAuthorizedFor(user)
        returns (Activity[] memory out)
    {
        Activity[] storage arr = _activities[user];
        if (arr.length == 0 || limit == 0) return new Activity[](0);
        uint256 count;
        uint256 scanned;
        // Reverse scan from the end, capped by _MAX_ACTIVITY_SCAN.
        for (uint256 i = arr.length; i > 0 && scanned < _MAX_ACTIVITY_SCAN && count < limit; i--) {
            Activity storage a = arr[i - 1];
            scanned++;
            if ((fromTs == 0 || a.ts >= fromTs) && (toTs == 0 || a.ts <= toTs)) {
                count++;
            }
        }
        out = new Activity[](count);
        uint256 idx;
        scanned = 0;
        for (uint256 i = arr.length; i > 0 && scanned < _MAX_ACTIVITY_SCAN && idx < count; i--) {
            Activity storage a2 = arr[i - 1];
            scanned++;
            if ((fromTs == 0 || a2.ts >= fromTs) && (toTs == 0 || a2.ts <= toTs)) {
                out[idx++] = a2;
            }
        }
    }

    /**
     * @notice Get the Top-N earners from RewardView local cache.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_USER_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - Read-only
     *
     * @return addrs Top-N user addresses (fixed length)
     * @return amounts Top-N earned totals (fixed length)
     */
    function getTopEarners()
        external
        view
        onlyValidRegistry
        onlyOps
        returns (address[] memory addrs, uint256[] memory amounts)
    {
        // Return fixed _TOP_N list from local cache.
        uint256 n = _TOP_N;
        addrs = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            addrs[i] = _topEarners[i];
            amounts[i] = _topEarnedAmounts[i];
        }
    }

    /**
     * @notice Protocol-enforced read: get a user's level for borrow checks (LendingEngine only).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not LendingEngine (MissingRole via onlyLendingEngine)
     *
     * Security:
     * - Role-gated: KEY_LE only (protocol internal check path)
     *
     * @param user Target user address
     * @return level User level (returns 0 if RewardManagerCore module is missing)
     */
    function getUserLevelForBorrowCheck(address user)
        external
        view
        onlyValidRegistry
        onlyLendingEngine
        returns (uint8)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getUserLevel(user);
    }
    
    /*━━━━━━━━━━━━━━━ Additional read APIs (pass-through + local cache) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get a user's consumption records from RewardView local cache.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return records Consumption records (RewardTypes.ConsumptionRecord[])
     */
    function getUserConsumptions(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (RewardTypes.ConsumptionRecord[] memory records)
    {
        return _consumptions[user];
    }

    /**
     * @notice Get service configuration (best-effort passthrough to service config modules).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns a zero/default config if the module is missing or the call fails.
     *
     * @param serviceType Service type (RewardTypes.ServiceType)
     * @param level Service level (RewardTypes.ServiceLevel)
     * @return config Service configuration struct (zero/default on failure)
     */
    function getServiceConfig(RewardTypes.ServiceType serviceType, RewardTypes.ServiceLevel level)
        external
        view
        onlyValidRegistry
        returns (RewardTypes.ServiceConfig memory config)
    {
        address moduleAddr = _resolveServiceConfigModule(serviceType);
        if (moduleAddr == address(0)) return config;
        // Try RewardCore legacy-compatible signature first.
        (bool ok, bytes memory ret) = moduleAddr.staticcall(
            abi.encodeWithSignature("getServiceConfig(uint8,uint8)", uint8(serviceType), uint8(level))
        );
        if (ok && ret.length > 0) {
            return abi.decode(ret, (RewardTypes.ServiceConfig));
        }
        // Standard IServiceConfig interface.
        try IServiceConfig(moduleAddr).getConfig(level) returns (RewardTypes.ServiceConfig memory cfg) {
            return cfg;
        } catch {
            // Best-effort passthrough: return default config on failure.
            // solhint-disable-next-line no-unused-vars
            config = config; // no-op to satisfy no-empty-blocks
        }
        return config;
    }

    /**
     * @notice Get a user's RewardPoints balance (best-effort passthrough).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if RewardPoints module is missing.
     *
     * @param user Target user address
     * @return balance RewardPoints balance (points units)
     */
    function getUserBalance(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 balance)
    {
        address rp = _getModule(ModuleKeys.KEY_REWARD_POINTS);
        if (rp == address(0)) return 0;
        return IRewardPointsMinimal(rp).balanceOf(user);
    }

    /**
     * @notice Get service usage stats (RewardCore passthrough with local fallback).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: if RewardCore is present and callable, returns its value; otherwise returns local cache.
     *
     * @param serviceType Service type
     * @return usage Usage count (implementation-defined)
     */
    function getServiceUsage(RewardTypes.ServiceType serviceType)
        external
        view
        onlyValidRegistry
        returns (uint256 usage)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_CORE);
        if (core != address(0)) {
            (bool ok, uint256 val) =
                _staticCallUint(core, abi.encodeWithSignature("getServiceUsage(uint8)", uint8(serviceType)));
            if (ok) return val;
        }
        return _serviceUsage[serviceType];
    }

    /**
     * @notice Get the user's last consumption timestamp for a service type.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: if RewardCore is present and callable, returns its value; otherwise returns local cache.
     *
     * @param user Target user address
     * @param serviceType Service type
     * @return timestamp Timestamp (seconds since epoch), 0 if unknown
     */
    function getUserLastConsumption(address user, RewardTypes.ServiceType serviceType)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 timestamp)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_CORE);
        if (core != address(0)) {
            (bool ok, uint256 val) = _staticCallUint(
                core,
                abi.encodeWithSignature("getUserLastConsumption(address,uint8)", user, uint8(serviceType))
            );
            if (ok) return val;
        }
        return _lastConsumption[user][serviceType];
    }

    /**
     * @notice Get a user's packed privilege bitmap from RewardView local cache.
     * @dev Reverts if:
     *      - caller is not the user and lacks VIEW_USER_DATA (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return privilegePacked Packed privilege bitmap (uint256)
     */
    function getUserPrivilegePacked(address user)
        external
        view
        onlyAuthorizedFor(user)
        returns (uint256 privilegePacked)
    {
        return _userSummary[user].privilegesPacked;
    }

    /*━━━━━━━━━━━━━━━ RewardManagerCore passthrough reads (preferred external query path) ━━━━━━━━━━━━━━━*/

    // NOTE: Per Architecture-Guide, external reward queries should go through RewardView.
    // Both legacy "*View" aliases and the preferred non-suffixed forms are provided for compatibility.

    /**
     * @notice Get reward calculation parameters (RewardManagerCore passthrough).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns zeros if RewardManagerCore module is missing.
     *
     * @return baseUsd Parameter (RewardManagerCore-defined units)
     * @return perDay Parameter (RewardManagerCore-defined units)
     * @return bonus Parameter (RewardManagerCore-defined units)
     * @return baseEth Parameter (RewardManagerCore-defined units)
     */
    function getRewardParameters()
        external
        view
        onlyValidRegistry
        returns (uint256 baseUsd, uint256 perDay, uint256 bonus, uint256 baseEth)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return (0, 0, 0, 0);
        return IRewardManagerCoreView(core).getRewardParameters();
    }

    /**
     * @notice Legacy alias for {getRewardParameters}.
     * @dev Reverts if:
     *      - see {getRewardParameters}
     *
     * Security:
     * - Read-only
     *
     * @return baseUsd See {getRewardParameters}
     * @return perDay See {getRewardParameters}
     * @return bonus See {getRewardParameters}
     * @return baseEth See {getRewardParameters}
     */
    function getRewardParametersView()
        external
        view
        onlyValidRegistry
        returns (uint256 baseUsd, uint256 perDay, uint256 bonus, uint256 baseEth)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return (0, 0, 0, 0);
        return IRewardManagerCoreView(core).getRewardParameters();
    }

    /**
     * @notice Get user points cache from RewardManagerCore (authoritative passthrough).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns (0,0,false) if RewardManagerCore module is missing.
     *
     * @param user Target user address
     * @return points Cached points (points units)
     * @return timestamp Cache timestamp (seconds; RewardManagerCore-defined)
     * @return isValid Cache validity flag (RewardManagerCore-defined)
     */
    function getUserCache(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 points, uint256 timestamp, bool isValid)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return (0, 0, false);
        return IRewardManagerCoreView(core).getUserCache(user);
    }

    /**
     * @notice Legacy alias for {getUserCache}.
     * @dev Reverts if:
     *      - see {getUserCache}
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return points See {getUserCache}
     * @return timestamp See {getUserCache}
     * @return isValid See {getUserCache}
     */
    function getUserCacheView(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 points, uint256 timestamp, bool isValid)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return (0, 0, false);
        return IRewardManagerCoreView(core).getUserCache(user);
    }

    /**
     * @notice Get cache expiration time from RewardManagerCore.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @return expirationTime Cache expiration time (seconds; RewardManagerCore-defined), or 0 on failure
     */
    function getCacheExpirationTime() external view onlyValidRegistry returns (uint256 expirationTime) {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getCacheExpirationTime();
    }

    /**
     * @notice Legacy alias for {getCacheExpirationTime}.
     * @dev Reverts if:
     *      - see {getCacheExpirationTime}
     *
     * Security:
     * - Read-only
     *
     * @return expirationTime See {getCacheExpirationTime}
     */
    function getCacheExpirationTimeView() external view onlyValidRegistry returns (uint256 expirationTime) {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getCacheExpirationTime();
    }

    /**
     * @notice Get dynamic reward parameters (legacy "*View" alias).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns (0,0) if RewardManagerCore module is missing.
     *
     * @return threshold Parameter (RewardManagerCore-defined units)
     * @return multiplier Parameter (RewardManagerCore-defined units)
     */
    function getDynamicRewardParametersView()
        external
        view
        onlyValidRegistry
        returns (uint256 threshold, uint256 multiplier)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return (0, 0);
        return IRewardManagerCoreView(core).getDynamicRewardParameters();
    }

    /**
     * @notice Get last reward reset time (legacy "*View" alias).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @return timestamp Last reset timestamp (seconds), or 0 on failure
     */
    function getLastRewardResetTimeView() external view onlyValidRegistry returns (uint256 timestamp) {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getLastRewardResetTime();
    }

    /**
     * @notice Get last reward reset time from RewardManagerCore.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @return timestamp Last reset timestamp (seconds), or 0 on failure
     */
    function getLastRewardResetTime() external view onlyValidRegistry returns (uint256 timestamp) {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getLastRewardResetTime();
    }

    /**
     * @notice Get user level from RewardManagerCore (authoritative passthrough).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Correctness-first: reads RewardManagerCore directly to avoid stale local cache (e.g., governance updates).
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @param user Target user address
     * @return level User level (system-defined), or 0 on failure
     */
    function getUserLevel(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint8)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getUserLevel(user);
    }

    /**
     * @notice Legacy alias for {getUserLevel}.
     * @dev Reverts if:
     *      - see {getUserLevel}
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return level See {getUserLevel}
     */
    function getUserLevelView(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint8 level)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getUserLevel(user);
    }

    /**
     * @notice Get level multiplier from RewardManagerCore.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @param level Level (system-defined)
     * @return multiplier Multiplier (RewardManagerCore-defined units), or 0 on failure
     */
    function getLevelMultiplier(uint8 level) external view onlyValidRegistry returns (uint256 multiplier) {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getLevelMultiplier(level);
    }

    /**
     * @notice Legacy alias for {getLevelMultiplier}.
     * @dev Reverts if:
     *      - see {getLevelMultiplier}
     *
     * Security:
     * - Read-only
     *
     * @param level Level
     * @return multiplier See {getLevelMultiplier}
     */
    function getLevelMultiplierView(uint8 level) external view onlyValidRegistry returns (uint256 multiplier) {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getLevelMultiplier(level);
    }

    /**
     * @notice Get user activity info from RewardManagerCore.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns (0,0,0) if RewardManagerCore module is missing.
     *
     * @param user Target user address
     * @return lastActivity Last activity timestamp (seconds)
     * @return totalLoans Total loans (RewardManagerCore-defined)
     * @return totalVolume Total volume (RewardManagerCore-defined)
     */
    function getUserActivity(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 lastActivity, uint256 totalLoans, uint256 totalVolume)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return (0, 0, 0);
        return IRewardManagerCoreView(core).getUserActivity(user);
    }

    /**
     * @notice Legacy alias for {getUserActivity}.
     * @dev Reverts if:
     *      - see {getUserActivity}
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return lastActivity See {getUserActivity}
     * @return totalLoans See {getUserActivity}
     * @return totalVolume See {getUserActivity}
     */
    function getUserActivityView(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 lastActivity, uint256 totalLoans, uint256 totalVolume)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return (0, 0, 0);
        return IRewardManagerCoreView(core).getUserActivity(user);
    }

    /**
     * @notice Get user's penalty debt from RewardManagerCore (authoritative passthrough).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Correctness-first: reads RewardManagerCore directly to avoid drift from push failures/delays.
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @param user Target user address
     * @return debt Pending penalty debt (points units), or 0 on failure
     */
    function getUserPenaltyDebt(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 debt)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getUserPenaltyDebt(user);
    }

    /**
     * @notice Legacy alias for {getUserPenaltyDebt}.
     * @dev Reverts if:
     *      - see {getUserPenaltyDebt}
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return debt See {getUserPenaltyDebt}
     */
    function getUserPenaltyDebtView(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 debt)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getUserPenaltyDebt(user);
    }

    /**
     * @notice Get total batch operations count from RewardManagerCore.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @return total Total batch operations count, or 0 on failure
     */
    function getTotalBatchOperations() external view onlyValidRegistry returns (uint256 total) {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getTotalBatchOperations();
    }

    /**
     * @notice Get total cached rewards count from RewardManagerCore.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @return total Total cached rewards count, or 0 on failure
     */
    function getTotalCachedRewards() external view onlyValidRegistry returns (uint256 total) {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getTotalCachedRewards();
    }

    /**
     * @notice Get system stats from RewardManagerCore (legacy "*View" composite helper).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns (0,0) if RewardManagerCore module is missing.
     *
     * @return totalBatchOps Total batch operations count
     * @return totalCachedRewards Total cached rewards count
     */
    function getSystemRewardCoreStatsView()
        external
        view
        onlyValidRegistry
        returns (uint256 totalBatchOps, uint256 totalCachedRewards)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return (0, 0);
        totalBatchOps = IRewardManagerCoreView(core).getTotalBatchOperations();
        totalCachedRewards = IRewardManagerCoreView(core).getTotalCachedRewards();
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    function _updateTopEarners(address user, uint256 totalEarned) internal {
        // If already in the list, update and potentially bubble up (simple insertion-sort approach).
        uint256 pos = _TOP_N;
        for (uint256 i = 0; i < _TOP_N; i++) {
            if (_topEarners[i] == user) {
                pos = i;
                break;
            }
        }
        if (pos == _TOP_N) {
            // Not in list: insert only if better than the current tail.
            if (totalEarned <= _topEarnedAmounts[_TOP_N - 1]) return;
            pos = _TOP_N - 1;
            _topEarners[pos] = user;
            _topEarnedAmounts[pos] = totalEarned;
        } else {
            _topEarnedAmounts[pos] = totalEarned;
        }
        // Bubble up to keep descending order.
        while (pos > 0 && _topEarnedAmounts[pos] > _topEarnedAmounts[pos - 1]) {
            (_topEarners[pos], _topEarners[pos - 1]) = (_topEarners[pos - 1], _topEarners[pos]);
            (_topEarnedAmounts[pos], _topEarnedAmounts[pos - 1]) =
                (_topEarnedAmounts[pos - 1], _topEarnedAmounts[pos]);
            pos--;
        }
    }

    function _touchUserCache(address user) internal {
        // solhint-disable-next-line not-rely-on-time
        _userCacheTimestamps[user] = block.timestamp;
    }

    function _isUserCacheValid(uint256 ts) internal view returns (bool) {
        // solhint-disable-next-line not-rely-on-time
        return ts > 0 && block.timestamp - ts <= _CACHE_DURATION;
    }

    /*━━━━━━━━━━━━━━━ Access helpers ━━━━━━━━━━━━━━━*/

    function _hasViewUserDataRole(address user) internal view returns (bool) {
        return ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, user);
    }

    function _getModule(bytes32 key) internal view returns (address moduleAddr) {
        moduleAddr = Registry(_registryAddr).getModule(key);
    }

    function _staticCallUint(address target, bytes memory payload) internal view returns (bool ok, uint256 value) {
        if (target == address(0)) return (false, 0);
        bytes memory ret;
        (ok, ret) = target.staticcall(payload);
        if (!ok || ret.length == 0) return (false, 0);
        value = abi.decode(ret, (uint256));
    }

    function _resolveServiceConfigModule(RewardTypes.ServiceType serviceType)
        internal
        view
        returns (address moduleAddr)
    {
        bytes32 moduleKey;
        if (serviceType == RewardTypes.ServiceType.AdvancedAnalytics) {
            moduleKey = ModuleKeys.KEY_ADVANCED_ANALYTICS_CONFIG;
        } else if (serviceType == RewardTypes.ServiceType.PriorityService) {
            moduleKey = ModuleKeys.KEY_PRIORITY_SERVICE_CONFIG;
        } else if (serviceType == RewardTypes.ServiceType.FeatureUnlock) {
            moduleKey = ModuleKeys.KEY_FEATURE_UNLOCK_CONFIG;
        } else if (serviceType == RewardTypes.ServiceType.GovernanceAccess) {
            moduleKey = ModuleKeys.KEY_GOVERNANCE_ACCESS_CONFIG;
        } else if (serviceType == RewardTypes.ServiceType.TestnetFeatures) {
            moduleKey = ModuleKeys.KEY_TESTNET_FEATURES_CONFIG;
        } else {
            return address(0);
        }
        moduleAddr = _getModule(moduleKey);
        if (moduleAddr == address(0)) {
            moduleAddr = _getModule(ModuleKeys.KEY_REWARD_CORE);
        }
        return moduleAddr;
    }

    /*━━━━━━━━━━━━━━━ UUPS upgrade ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize a UUPS upgrade.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (reverts in ViewAccessLib.requireRole)
     *      - newImplementation is zero (ZeroAddress)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }
    
    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the API version for this module.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Read-only
     *
     * @return version API semantic version
     */
    function apiVersion() public pure override returns (uint256) {
        // v2: split penalty-ledger DataPush type from REWARD_STATS_UPDATED into REWARD_PENALTY_LEDGER_UPDATED.
        return 2;
    }

    /**
     * @notice Get the schema version for this module's outputs.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Read-only
     *
     * @return version Schema version
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    uint256[50] private __gap;
}

/**
 * @notice Minimal RewardManagerCore view interface (used by RewardView passthrough reads).
 * @dev This interface is intentionally minimal to keep coupling low.
 */
interface IRewardManagerCoreView {
    function getRewardParameters()
        external
        view
        returns (uint256 baseUsd, uint256 perDay, uint256 bonus, uint256 baseEth);
    function getUserCache(address user) external view returns (uint256 points, uint256 timestamp, bool isValid);
    function getCacheExpirationTime() external view returns (uint256);
    function getDynamicRewardParameters() external view returns (uint256 threshold, uint256 multiplier);
    function getLastRewardResetTime() external view returns (uint256);
    function getUserLevel(address user) external view returns (uint8);
    function getLevelMultiplier(uint8 level) external view returns (uint256);
    function getUserActivity(address user)
        external
        view
        returns (uint256 lastActivity, uint256 totalLoans, uint256 totalVolume);
    function getUserPenaltyDebt(address user) external view returns (uint256);
    function getTotalBatchOperations() external view returns (uint256);
    function getTotalCachedRewards() external view returns (uint256);
}

/**
 * @notice Minimal RewardPoints interface (used by RewardView).
 */
interface IRewardPointsMinimal {
    function balanceOf(address owner) external view returns (uint256);
}



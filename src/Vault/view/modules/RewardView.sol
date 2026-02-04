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
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { ViewConstants } from "../ViewConstants.sol";

/**
 * @dev Minimal interface for RewardCore consumption-side read helpers.
 *      RewardView uses this strictly for selector derivation and best-effort reads.
 */
interface IRewardCoreConsumptionReads {
    function getUserLastConsumption(address user, uint8 serviceType) external view returns (uint256);
}

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
 * - Some reads are role-gated for ops/admin visibility (VIEW_SYSTEM_DATA / ADMIN), as these are system-level outputs.
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
    mapping(address => uint256) private _userCacheBlocks;

    /*━━━━━━━━━━━━━━━ Local activity cache (RewardView-only) ━━━━━━━━━━━━━━━*/

    /// @notice Minimal activity record for user-centric reward activity browsing.
    /// @dev kind: 1=earned, 2=burned, 3=penalty.
    struct Activity {
        uint8 kind;
        uint256 amount;
        uint256 blockNumber;
    }

    mapping(address => Activity[]) private _activities;
    uint256 private constant _MAX_ACTIVITY_SCAN = 500;
    uint256 private constant _CACHE_DURATION = ViewConstants.CACHE_DURATION_BLOCKS;

    /*━━━━━━━━━━━━━━━ Consumption-side cache (RewardView-only) ━━━━━━━━━━━━━━━*/

    mapping(address => RewardTypes.ConsumptionRecord[]) private _consumptions;
    mapping(address => mapping(RewardTypes.ServiceType => uint256)) private _lastConsumption;

    // RewardCore.getUserLastConsumption(address,uint8)
    bytes4 private constant _SEL_GET_USER_LAST_CONSUMPTION =
        IRewardCoreConsumptionReads.getUserLastConsumption.selector;
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
    uint256 private _systemCacheTimestamp;

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

    /// @dev Scheme U: self read allowed; non-self requires VIEW_USER_DATA or ADMIN.
    modifier onlyAuthorizedFor(address user) {
        if (
            msg.sender != user
                && !_hasViewUserDataRole(msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) {
            revert MissingRole();
        }
        _;
    }

    /// @dev Gate: caller must have VIEW_SYSTEM_DATA or ADMIN.
    modifier onlyOps() {
        if (
            !_hasViewSystemDataRole(msg.sender)
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
     *      - caller lacks ACTION_ADMIN (MissingRole)
     *      - newRegistry is zero (ZeroAddress)
     *      - newRegistry is not a contract (NotAContract)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     *
     * @param newRegistry New Registry contract address
     */
    function setRegistry(address newRegistry) external onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
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
     * - Emits DataPushed(DATA_TYPE_REWARD_EARNED, abi.encode(user, amount, reason, blockNumber))
     *
     * @param user User address
     * @param amount Earned points amount (points units, system-defined)
     * @param reason Short reason string (off-chain display only)
     * @param blockNumber Business blockNumber (block number; writer-defined)
     */
    function pushRewardEarned(address user, uint256 amount, string calldata reason, uint256 blockNumber)
        external
        onlyWriter
    {
        UserSummary storage s = _userSummary[user];
        s.totalEarned += amount;
        if (blockNumber > s.lastActivity) s.lastActivity = blockNumber;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _activities[user].push(Activity({ kind: 1, amount: amount, blockNumber: blockNumber }));
        _updateTopEarners(user, s.totalEarned);
        _touchUserCache(user);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_EARNED, abi.encode(user, amount, reason, blockNumber));
    }

    /**
     * @notice Push a "points burned" update for a user and emit a unified DataPush event.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
     * - onlyWriter (RewardManagerCore / RewardConsumption)
     * - Emits DataPushed(DATA_TYPE_REWARD_BURNED, abi.encode(user, amount, reason, blockNumber))
     *
     * @param user User address
     * @param amount Burned points amount (points units, system-defined)
     * @param reason Short reason string (off-chain display only)
     * @param blockNumber Business blockNumber (block number; writer-defined)
     */
    function pushPointsBurned(address user, uint256 amount, string calldata reason, uint256 blockNumber)
        external
        onlyWriter
    {
        UserSummary storage s = _userSummary[user];
        s.totalBurned += amount;
        if (blockNumber > s.lastActivity) s.lastActivity = blockNumber;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _activities[user].push(Activity({ kind: 2, amount: amount, blockNumber: blockNumber }));
        _touchUserCache(user);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_BURNED, abi.encode(user, amount, reason, blockNumber));
    }

    /**
     * @notice Admin retry helper: replay a "points burned" push (manual recovery).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (MissingRole)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     * - Should not be used on normal paths (manual recovery only)
     *
     * @param user User address
     * @param amount Burned points amount
     * @param reason Short reason string
     * @param blockNumber Business blockNumber (block number; admin-defined)
     */
    function retryPushPointsBurned(address user, uint256 amount, string calldata reason, uint256 blockNumber)
        external
        onlyValidRegistry
    {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        UserSummary storage s = _userSummary[user];
        s.totalBurned += amount;
        if (blockNumber > s.lastActivity) s.lastActivity = blockNumber;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _activities[user].push(Activity({ kind: 2, amount: amount, blockNumber: blockNumber }));
        _touchUserCache(user);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_BURNED, abi.encode(user, amount, reason, blockNumber));
    }

    /**
     * @notice Push a penalty ledger (pending points debt) update for a user.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
     * - onlyWriter (RewardManagerCore / RewardConsumption)
     * - Emits DataPushed(DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED, abi.encode(user, pendingDebt, blockNumber))
     *
     * @param user User address
     * @param pendingDebt Pending points debt (points units, system-defined)
     * @param blockNumber Business blockNumber (block number; writer-defined)
     */
    function pushPenaltyLedger(address user, uint256 pendingDebt, uint256 blockNumber) external onlyWriter {
        UserSummary storage s = _userSummary[user];
        s.pendingPenalty = pendingDebt;
        if (blockNumber > s.lastActivity) s.lastActivity = blockNumber;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _activities[user].push(Activity({ kind: 3, amount: pendingDebt, blockNumber: blockNumber }));
        _touchUserCache(user);
        // penaltyLedger uses a dedicated dataTypeHash to avoid payload ambiguity with REWARD_STATS_UPDATED.
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED,
            abi.encode(user, pendingDebt, blockNumber)
        );
    }

    /**
     * @notice Push a user level update and emit a unified DataPush event.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
     * - onlyWriter (RewardManagerCore / RewardConsumption)
     * - Emits DataPushed(DATA_TYPE_REWARD_LEVEL_UPDATED, abi.encode(user, newLevel, blockNumber))
     *
     * @param user User address
     * @param newLevel New level (system-defined; not range-validated here)
     * @param blockNumber Business blockNumber (block number; writer-defined)
     */
    function pushUserLevel(address user, uint8 newLevel, uint256 blockNumber) external onlyWriter {
        _userSummary[user].level = newLevel;
        if (blockNumber > _userSummary[user].lastActivity) _userSummary[user].lastActivity = blockNumber;
        _touchUserCache(user);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_LEVEL_UPDATED, abi.encode(user, newLevel, blockNumber));
    }

    /**
     * @notice Push a user privilege bitmap update and emit a unified DataPush event.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
     * - onlyWriter (RewardManagerCore / RewardConsumption)
     * - Emits DataPushed(DATA_TYPE_REWARD_PRIVILEGE_UPDATED, abi.encode(user, privilegePacked, blockNumber))
     *
     * @param user User address
     * @param privilegePacked Packed privilege bitmap (uint256)
     * @param blockNumber Business blockNumber (block number; writer-defined)
     */
    function pushUserPrivilege(address user, uint256 privilegePacked, uint256 blockNumber) external onlyWriter {
        _userSummary[user].privilegesPacked = privilegePacked;
        if (blockNumber > _userSummary[user].lastActivity) _userSummary[user].lastActivity = blockNumber;
        _touchUserCache(user);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_PRIVILEGE_UPDATED,
            abi.encode(user, privilegePacked, blockNumber)
        );
    }

    /**
     * @notice Admin retry helper: replay a "user privilege" push (manual recovery).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (MissingRole)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     * - Should not be used on normal paths (manual recovery only)
     *
     * @param user User address
     * @param privilegePacked Packed privilege bitmap
     * @param blockNumber Business blockNumber (block number; admin-defined)
     */
    function retryPushUserPrivilege(address user, uint256 privilegePacked, uint256 blockNumber)
        external
        onlyValidRegistry
    {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        _userSummary[user].privilegesPacked = privilegePacked;
        if (blockNumber > _userSummary[user].lastActivity) _userSummary[user].lastActivity = blockNumber;
        _touchUserCache(user);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_PRIVILEGE_UPDATED,
            abi.encode(user, privilegePacked, blockNumber)
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
     * - Emits DataPushed(DATA_TYPE_REWARD_CONSUMPTION_RECORDED,
     *   abi.encode(user, serviceType, serviceLevel, points, expirationTime, blockNumber))
     *
     * @param user User address
     * @param serviceType Service type (RewardTypes.ServiceType)
     * @param serviceLevel Service level (RewardTypes.ServiceLevel)
     * @param points Points spent (points units)
     * @param expirationTime Expiration time (block number; service-defined)
     * @param blockNumber Business blockNumber (block number; writer-defined)
     */
    function pushConsumptionRecord(
        address user,
        RewardTypes.ServiceType serviceType,
        RewardTypes.ServiceLevel serviceLevel,
        uint256 points,
        uint256 expirationTime,
        uint256 blockNumber
    ) external onlyWriter {
        address rc = _getModule(ModuleKeys.KEY_REWARD_CONSUMPTION);
        if (msg.sender != rc) revert RewardView__UnauthorizedWriter();

        _consumptions[user].push(
            RewardTypes.ConsumptionRecord({
                points: points,
                blockNumber: blockNumber,
                serviceType: serviceType,
                serviceLevel: serviceLevel,
                isActive: true,
                expirationTime: expirationTime
            })
        );
        _lastConsumption[user][serviceType] = blockNumber;
        unchecked { _serviceUsage[serviceType] += 1; }
        _touchUserCache(user);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_CONSUMPTION_RECORDED,
            abi.encode(user, serviceType, serviceLevel, points, expirationTime, blockNumber)
        );
    }

    /**
     * @notice Admin retry helper: replay a "consumption record" push (manual recovery).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (MissingRole)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     * - Should not be used on normal paths (manual recovery only)
     *
     * @param user User address
     * @param serviceType Service type
     * @param serviceLevel Service level
     * @param points Points spent (points units)
     * @param expirationTime Expiration time (block number)
     * @param blockNumber Business blockNumber (block number)
     */
    function retryPushConsumptionRecord(
        address user,
        RewardTypes.ServiceType serviceType,
        RewardTypes.ServiceLevel serviceLevel,
        uint256 points,
        uint256 expirationTime,
        uint256 blockNumber
    ) external onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        _consumptions[user].push(
            RewardTypes.ConsumptionRecord({
                points: points,
                blockNumber: blockNumber,
                serviceType: serviceType,
                serviceLevel: serviceLevel,
                isActive: true,
                expirationTime: expirationTime
            })
        );
        _lastConsumption[user][serviceType] = blockNumber;
        unchecked { _serviceUsage[serviceType] += 1; }
        _touchUserCache(user);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_CONSUMPTION_RECORDED,
            abi.encode(user, serviceType, serviceLevel, points, expirationTime, blockNumber)
        );
    }

    /**
     * @notice Push system-level reward stats and emit a unified DataPush event.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
     * - onlyWriter (RewardManagerCore / RewardConsumption)
     * - Emits DataPushed(DATA_TYPE_REWARD_STATS_UPDATED, abi.encode(totalBatchOps, totalCachedRewards, blockNumber))
     *
     * @param totalBatchOps Total batch operations count (writer-defined)
     * @param totalCachedRewards Total cache-hit count (writer-defined)
     * @param blockNumber Business blockNumber (block number; writer-defined)
     */
    function pushSystemStats(uint256 totalBatchOps, uint256 totalCachedRewards, uint256 blockNumber)
        external
        onlyWriter
    {
        _systemStats.totalBatchOps = totalBatchOps;
        _systemStats.totalCachedRewards = totalCachedRewards;
        _systemCacheTimestamp = block.number;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_STATS_UPDATED,
            abi.encode(totalBatchOps, totalCachedRewards, blockNumber)
        );
    }

    /*━━━━━━━━━━━━━━━ Read APIs (0-gas views) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get a user's reward summary plus local cache metadata (blockNumber + TTL validity).
     * @dev Reverts if:
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
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
     * @return lastActivity Last activity blockNumber (block number; writer-defined)
     * @return totalLoans Reserved (currently not maintained)
     * @return totalVolume Reserved (currently not maintained)
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
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
            uint256 blockNumber,
            bool isValid
        )
    {
        UserSummary storage s = _userSummary[user];
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
        return (
            s.totalEarned,
            s.totalBurned,
            s.pendingPenalty,
            s.level,
            s.privilegesPacked,
            s.lastActivity,
            s.totalLoans,
            s.totalVolume,
            blockNumber,
            isValid
        );
    }

    /**
     * @notice Get system-level reward stats from RewardView local cache, with cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_SYSTEM_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - Read-only
     *
     * @return totalBatchOps Total batch operations count (writer-defined)
     * @return totalCachedRewards Total cache-hit count (writer-defined)
     * @return activeUsers Active user count (RewardView-local)
     * @return blockNumber RewardView system cache blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getSystemRewardStatsWithMeta()
        external
        view
        onlyValidRegistry
        onlyOps
        returns (
            uint256 totalBatchOps,
            uint256 totalCachedRewards,
            uint256 activeUsers,
            uint256 blockNumber,
            bool isValid
        )
    {
        totalBatchOps = _systemStats.totalBatchOps;
        totalCachedRewards = _systemStats.totalCachedRewards;
        activeUsers = _systemStats.activeUsers;
        blockNumber = _systemCacheTimestamp;
        isValid = _isUserCacheValid(blockNumber);
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
     * @notice Get a user's recent reward activities from local cache, with cache metadata.
     * @dev Reverts if:
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @param fromTs Inclusive start blockNumber filter (block number). 0 means no lower bound.
     * @param toTs Inclusive end blockNumber filter (block number). 0 means no upper bound.
     * @param limit Maximum number of entries to return (0 returns empty)
     * @return out Activity array (most recent first). Scan is capped by _MAX_ACTIVITY_SCAN.
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserRecentActivitiesWithMeta(address user, uint256 fromTs, uint256 toTs, uint256 limit)
        external
        view
        onlyAuthorizedFor(user)
        returns (Activity[] memory out, uint256 blockNumber, bool isValid)
    {
        Activity[] storage arr = _activities[user];
        if (arr.length == 0 || limit == 0) {
            blockNumber = _userCacheBlocks[user];
            isValid = _isUserCacheValid(blockNumber);
            return (new Activity[](0), blockNumber, isValid);
        }
        uint256 count;
        uint256 scanned;
        // Reverse scan from the end, capped by _MAX_ACTIVITY_SCAN.
        for (uint256 i = arr.length; i > 0 && scanned < _MAX_ACTIVITY_SCAN && count < limit; i--) {
            Activity storage a = arr[i - 1];
            scanned++;
            if ((fromTs == 0 || a.blockNumber >= fromTs) && (toTs == 0 || a.blockNumber <= toTs)) {
                count++;
            }
        }
        out = new Activity[](count);
        uint256 idx;
        scanned = 0;
        for (uint256 i = arr.length; i > 0 && scanned < _MAX_ACTIVITY_SCAN && idx < count; i--) {
            Activity storage a2 = arr[i - 1];
            scanned++;
            if ((fromTs == 0 || a2.blockNumber >= fromTs) && (toTs == 0 || a2.blockNumber <= toTs)) {
                out[idx++] = a2;
            }
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get the Top-N earners from RewardView local cache, with cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks VIEW_SYSTEM_DATA / ADMIN (MissingRole via onlyOps)
     *
     * Security:
     * - Read-only
     *
     * @return addrs Top-N user addresses (fixed length)
     * @return amounts Top-N earned totals (fixed length)
     * @return blockNumber RewardView system cache blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getTopEarnersWithMeta()
        external
        view
        onlyValidRegistry
        onlyOps
        returns (address[] memory addrs, uint256[] memory amounts, uint256 blockNumber, bool isValid)
    {
        // Return fixed _TOP_N list from local cache.
        uint256 n = _TOP_N;
        addrs = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            addrs[i] = _topEarners[i];
            amounts[i] = _topEarnedAmounts[i];
        }
        blockNumber = _systemCacheTimestamp;
        isValid = _isUserCacheValid(blockNumber);
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
     * @notice Get a user's consumption records from RewardView local cache, with cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return records Consumption records (RewardTypes.ConsumptionRecord[])
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserConsumptionsWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (RewardTypes.ConsumptionRecord[] memory records, uint256 blockNumber, bool isValid)
    {
        records = _consumptions[user];
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
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
            config = config; // no-op to satisfy no-empty-blocks
        }
        return config;
    }

    /**
     * @notice Get a user's RewardPoints balance with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if RewardPoints module is missing.
     *
     * @param user Target user address
     * @return balance RewardPoints balance (points units)
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserBalance(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 balance, uint256 blockNumber, bool isValid)
    {
        address rp = _getModule(ModuleKeys.KEY_REWARD_POINTS);
        if (rp == address(0)) {
            balance = 0;
        } else {
            balance = IRewardPointsMinimal(rp).balanceOf(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get a user's RewardPoints balance, with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if RewardPoints module is missing.
     *
     * @param user Target user address
     * @return balance RewardPoints balance (points units)
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserBalanceWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 balance, uint256 blockNumber, bool isValid)
    {
        address rp = _getModule(ModuleKeys.KEY_REWARD_POINTS);
        if (rp == address(0)) {
            balance = 0;
        } else {
            balance = IRewardPointsMinimal(rp).balanceOf(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
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
     * @notice Get service usage stats with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     * - Best-effort: if RewardCore is present and callable, returns its value; otherwise returns local cache.
     *
     * @param serviceType Service type
     * @return usage Usage count (implementation-defined)
     * @return blockNumber RewardView system cache blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getServiceUsageWithMeta(RewardTypes.ServiceType serviceType)
        external
        view
        onlyValidRegistry
        returns (uint256 usage, uint256 blockNumber, bool isValid)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_CORE);
        if (core != address(0)) {
            (bool ok, uint256 val) =
                _staticCallUint(core, abi.encodeWithSignature("getServiceUsage(uint8)", uint8(serviceType)));
            usage = ok ? val : _serviceUsage[serviceType];
        } else {
            usage = _serviceUsage[serviceType];
        }
        blockNumber = _systemCacheTimestamp;
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get the user's last consumption blockNumber for a service type, with cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: if RewardCore is present and callable, returns its value; otherwise returns local cache.
     *
     * @param user Target user address
     * @param serviceType Service type
     * @return lastConsumption Timestamp (block number), 0 if unknown
     * @return cacheBlock RewardView local cache last-write time (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserLastConsumption(address user, RewardTypes.ServiceType serviceType)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 lastConsumption, uint256 cacheBlock, bool isValid)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_CORE);
        if (core != address(0)) {
            (bool ok, uint256 val) = _staticCallUint(
                core,
                abi.encodeWithSelector(_SEL_GET_USER_LAST_CONSUMPTION, user, uint8(serviceType))
            );
            if (ok) {
                lastConsumption = val;
            } else {
                lastConsumption = _lastConsumption[user][serviceType];
            }
        } else {
            lastConsumption = _lastConsumption[user][serviceType];
        }
        cacheBlock = _userCacheBlocks[user];
        isValid = _isUserCacheValid(cacheBlock);
    }

    /**
     * @notice Get a user's last consumption blockNumber for a service type, with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: if RewardCore is present and callable, returns its value; otherwise returns local cache.
     *
     * @param user Target user address
     * @param serviceType Service type
     * @return lastConsumption Timestamp (block number), 0 if unknown
     * @return cacheBlock RewardView local cache last-write time (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserLastConsumptionWithMeta(address user, RewardTypes.ServiceType serviceType)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 lastConsumption, uint256 cacheBlock, bool isValid)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_CORE);
        if (core != address(0)) {
            (bool ok, uint256 val) = _staticCallUint(
                core,
                abi.encodeWithSelector(_SEL_GET_USER_LAST_CONSUMPTION, user, uint8(serviceType))
            );
            if (ok) {
                lastConsumption = val;
            } else {
                lastConsumption = _lastConsumption[user][serviceType];
            }
        } else {
            lastConsumption = _lastConsumption[user][serviceType];
        }
        cacheBlock = _userCacheBlocks[user];
        isValid = _isUserCacheValid(cacheBlock);
    }

    /**
     * @notice Get a user's packed privilege bitmap from RewardView local cache, with cache metadata.
     * @dev Reverts if:
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return privilegePacked Packed privilege bitmap (uint256)
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserPrivilegePackedWithMeta(address user)
        external
        view
        onlyAuthorizedFor(user)
        returns (uint256 privilegePacked, uint256 blockNumber, bool isValid)
    {
        privilegePacked = _userSummary[user].privilegesPacked;
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
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
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns (0,0,false) if RewardManagerCore module is missing.
     *
     * @param user Target user address
     * @return points Cached points (points units)
     * @return blockNumber Cache blockNumber (block number; RewardManagerCore-defined)
     * @return isValid Cache validity flag (RewardManagerCore-defined)
     */
    function getUserCache(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 points, uint256 blockNumber, bool isValid)
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
     * @return blockNumber See {getUserCache}
     * @return isValid See {getUserCache}
     */
    function getUserCacheView(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 points, uint256 blockNumber, bool isValid)
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
     * @return expirationTime Cache expiration time (block number; RewardManagerCore-defined), or 0 on failure
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
     * @return blockNumber Last reset blockNumber (block number), or 0 on failure
     */
    function getLastRewardResetTimeView() external view onlyValidRegistry returns (uint256 blockNumber) {
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
     * @return blockNumber Last reset blockNumber (block number), or 0 on failure
     */
    function getLastRewardResetTime() external view onlyValidRegistry returns (uint256 blockNumber) {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) return 0;
        return IRewardManagerCoreView(core).getLastRewardResetTime();
    }

    /**
     * @notice Get user level from RewardManagerCore, with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Correctness-first: reads RewardManagerCore directly to avoid stale local cache (e.g., governance updates).
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @param user Target user address
     * @return level User level (system-defined), or 0 on failure
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserLevel(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint8 level, uint256 blockNumber, bool isValid)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) {
            level = 0;
        } else {
            level = IRewardManagerCoreView(core).getUserLevel(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get user level from RewardManagerCore, with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @param user Target user address
     * @return level User level (system-defined), or 0 on failure
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserLevelWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint8 level, uint256 blockNumber, bool isValid)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) {
            level = 0;
        } else {
            level = IRewardManagerCoreView(core).getUserLevel(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Legacy alias for {getUserLevel}, with cache metadata.
     * @dev Reverts if:
     *      - see {getUserLevel}
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return level See {getUserLevel}
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserLevelView(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint8 level, uint256 blockNumber, bool isValid)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) {
            level = 0;
        } else {
            level = IRewardManagerCoreView(core).getUserLevel(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
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
     * @notice Get user activity info from RewardManagerCore, with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns (0,0,0) if RewardManagerCore module is missing.
     *
     * @param user Target user address
     * @return lastActivity Last activity blockNumber (block number)
     * @return totalLoans Total loans (RewardManagerCore-defined)
     * @return totalVolume Total volume (RewardManagerCore-defined)
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserActivity(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (
            uint256 lastActivity,
            uint256 totalLoans,
            uint256 totalVolume,
            uint256 blockNumber,
            bool isValid
        )
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) {
            lastActivity = 0;
            totalLoans = 0;
            totalVolume = 0;
        } else {
            (lastActivity, totalLoans, totalVolume) = IRewardManagerCoreView(core).getUserActivity(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get user activity from RewardManagerCore, with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns (0,0,0) if RewardManagerCore module is missing.
     *
     * @param user Target user address
     * @return lastActivity Last activity blockNumber (block number)
     * @return totalLoans Total loans (RewardManagerCore-defined)
     * @return totalVolume Total volume (RewardManagerCore-defined)
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserActivityWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (
            uint256 lastActivity,
            uint256 totalLoans,
            uint256 totalVolume,
            uint256 blockNumber,
            bool isValid
        )
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) {
            lastActivity = 0;
            totalLoans = 0;
            totalVolume = 0;
        } else {
            (lastActivity, totalLoans, totalVolume) = IRewardManagerCoreView(core).getUserActivity(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Legacy alias for {getUserActivity}, with cache metadata.
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
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserActivityView(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (
            uint256 lastActivity,
            uint256 totalLoans,
            uint256 totalVolume,
            uint256 blockNumber,
            bool isValid
        )
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) {
            lastActivity = 0;
            totalLoans = 0;
            totalVolume = 0;
        } else {
            (lastActivity, totalLoans, totalVolume) = IRewardManagerCoreView(core).getUserActivity(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get user's penalty debt from RewardManagerCore, with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Correctness-first: reads RewardManagerCore directly to avoid drift from push failures/delays.
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @param user Target user address
     * @return debt Pending penalty debt (points units), or 0 on failure
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserPenaltyDebt(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 debt, uint256 blockNumber, bool isValid)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) {
            debt = 0;
        } else {
            debt = IRewardManagerCoreView(core).getUserPenaltyDebt(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get user's penalty debt from RewardManagerCore, with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     * - Best-effort: returns 0 if RewardManagerCore module is missing.
     *
     * @param user Target user address
     * @return debt Pending penalty debt (points units), or 0 on failure
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserPenaltyDebtWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 debt, uint256 blockNumber, bool isValid)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) {
            debt = 0;
        } else {
            debt = IRewardManagerCoreView(core).getUserPenaltyDebt(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Legacy alias for {getUserPenaltyDebt}, with cache metadata.
     * @dev Reverts if:
     *      - see {getUserPenaltyDebt}
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return debt See {getUserPenaltyDebt}
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserPenaltyDebtView(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 debt, uint256 blockNumber, bool isValid)
    {
        address core = _getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (core == address(0)) {
            debt = 0;
        } else {
            debt = IRewardManagerCoreView(core).getUserPenaltyDebt(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
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
        _userCacheBlocks[user] = block.number;
        _systemCacheTimestamp = block.number;
    }

    function _isUserCacheValid(uint256 blockNumber) internal view returns (bool) {
        return blockNumber > 0 && block.number - blockNumber <= _CACHE_DURATION;
    }

    /*━━━━━━━━━━━━━━━ Access helpers ━━━━━━━━━━━━━━━*/

    function _hasViewUserDataRole(address user) internal view returns (bool) {
        return ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, user);
    }

    function _hasViewSystemDataRole(address user) internal view returns (bool) {
        return ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, user);
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
     *      - caller lacks ACTION_ADMIN (MissingRole)
     *      - newImplementation is zero (ZeroAddress)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
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
    function getUserCache(address user) external view returns (uint256 points, uint256 blockNumber, bool isValid);
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



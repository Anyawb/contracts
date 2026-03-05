// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
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
 * - Role-gated writes: only authorized writer modules (resolved via Registry) can push updates.
 * - Some reads are role-gated for ops/admin visibility (VIEW_SYSTEM_DATA / ADMIN), as these are system-level outputs.
 * - Unified DataPush: push* functions emit DataPushed events via DataPushLibrary for off-chain indexing.
 */
contract RewardView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Caller is not an authorized writer module.
    /// @dev Reverts when caller is not an authorized writer module (as resolved via Registry).
    error RewardView__UnauthorizedWriter();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    address private _registryAddr;

    struct UserSummary {
        uint256 totalEarned;
        uint256 totalBurned;
        uint256 pendingPenalty;
        uint8 level;
        uint256 lastActivity;
    }

    mapping(address => UserSummary) private _userSummary;
    mapping(address => uint256) private _userCacheBlocks;

    /// @notice Easy token earned totals (borrower + lender mint shares).
    mapping(address => uint256) private _easyEarned;

    /// @notice Easy token staked totals (RewardView-local).
    mapping(address => uint256) private _easyStaked;

    /*━━━━━━━━━━━━━━━ Easy emission params cache (RewardView-only) ━━━━━━━━━━━━━━━*/

    uint256 private _easyEmissionThresholdUsd8;
    uint256 private _easyEmissionMintPer1000Usd;
    uint256 private _easyEmissionKNum;
    uint256 private _easyEmissionKDen;
    uint256 private _easyEmissionCacheBlock;

    /*━━━━━━━━━━━━━━━ Easy spend/recycle cache (RewardView-only) ━━━━━━━━━━━━━━━*/

    mapping(address => uint256) private _easySpent;
    uint256 private _easyTotalSpent;
    uint256 private _easyTotalRecycled;
    uint256 private _easyTotalBurned;
    uint256 private _easyTotalTeam;
    uint256 private _easyTotalEco;
    uint256 private _easySpendCacheBlock;

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
    uint256 private _systemCacheUpdateBlock;

    /*━━━━━━━━━━━━━━━ Earn-config cache (RewardView-only; governance observability) ━━━━━━━━━━━━━━━*/

    uint256 private _dynamicRewardThresholdEasy;
    uint256 private _dynamicRewardMultiplierBps;
    uint256 private _dynamicRewardCacheBlock;

    mapping(uint8 => uint256) private _levelMultiplierBps;
    uint256 private _levelMultiplierCacheBlock;

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
        address ec = _getModule(ModuleKeys.KEY_EASY_EMISSION_CONTROLLER);
        address es = _getModule(ModuleKeys.KEY_EASY_STAKING);
        address econf = _getModule(ModuleKeys.KEY_EASY_EMISSION_CONFIG);
        address econ = _getModule(ModuleKeys.KEY_EASY_CONSUMPTION);
        address erd = _getModule(ModuleKeys.KEY_EASY_RECYCLE_DISTRIBUTOR);
        if (rmc == address(0)) revert ZeroAddress();
        if (
            msg.sender != rmc
                && msg.sender != ec
                && msg.sender != es
                && msg.sender != econf
                && msg.sender != econ
                && msg.sender != erd
        ) {
            revert RewardView__UnauthorizedWriter();
        }
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

    /// @dev Gate: caller must be OrderEngine (KEY_ORDER_ENGINE).
    modifier onlyOrderEngine() {
        address oe = _getModule(ModuleKeys.KEY_ORDER_ENGINE);
        if (oe == address(0) || msg.sender != oe) revert MissingRole();
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
        *      - a required writer module is missing in Registry (ZeroAddress via onlyWriter)
     *      - caller is not an authorized writer module (RewardView__UnauthorizedWriter)
     *
     * Security:
        * - onlyWriter (authorized writer modules via Registry)
     * - Emits DataPushed(DATA_TYPE_REWARD_EARNED, abi.encode(user, amount, reason, blockNumber))
     *
     * @param user User address
    * @param amount Earned Easy amount (reward units, system-defined)
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
     * @notice Push an "Easy burned" update for a user and emit a unified DataPush event.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
        * - onlyWriter (authorized writer modules via Registry)
     * - Emits DataPushed(DATA_TYPE_REWARD_BURNED, abi.encode(user, amount, reason, blockNumber))
     *
     * @param user User address
    * @param amount Burned Easy amount (reward units, system-defined)
     * @param reason Short reason string (off-chain display only)
     * @param blockNumber Business blockNumber (block number; writer-defined)
     */
    function pushEasyBurned(address user, uint256 amount, string calldata reason, uint256 blockNumber)
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
     * @notice Push an Easy mint update (borrower + lender) and emit a unified DataPush event.
     * @dev Writer: EasyEmissionController
     *
     * @param borrower Borrower address
     * @param lender Lender address
     * @param totalMinted Total Easy minted
     * @param borrowerShare Borrower share
     * @param lenderShare Lender share
     * @param orderId Order id
     * @param amountUsd8 Borrow amount (USD-8)
     * @param blockNumber Business blockNumber (block number)
     */
    function pushEasyMinted(
        address borrower,
        address lender,
        uint256 totalMinted,
        uint256 borrowerShare,
        uint256 lenderShare,
        uint256 orderId,
        uint256 amountUsd8,
        uint256 blockNumber
    ) external onlyWriter {
        address ec = _getModule(ModuleKeys.KEY_EASY_EMISSION_CONTROLLER);
        if (msg.sender != ec) revert RewardView__UnauthorizedWriter();

        if (borrower != address(0) && borrowerShare > 0) {
            _easyEarned[borrower] += borrowerShare;
            if (blockNumber > _userSummary[borrower].lastActivity) _userSummary[borrower].lastActivity = blockNumber;
            if (!_isActiveUser[borrower]) { _isActiveUser[borrower] = true; _systemStats.activeUsers++; }
            _touchUserCache(borrower);
        }

        if (lender != address(0) && lenderShare > 0) {
            _easyEarned[lender] += lenderShare;
            if (blockNumber > _userSummary[lender].lastActivity) _userSummary[lender].lastActivity = blockNumber;
            if (!_isActiveUser[lender]) { _isActiveUser[lender] = true; _systemStats.activeUsers++; }
            _touchUserCache(lender);
        }

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_EASY_MINTED,
            abi.encode(borrower, lender, totalMinted, borrowerShare, lenderShare, orderId, amountUsd8, blockNumber)
        );
    }

    /**
     * @notice Push an Easy staked update (from EasyStaking).
     * @dev Writer: EasyStaking
     */
    function pushEasyStaked(address user, uint256 amount, uint256 newStaked, uint256 blockNumber) external onlyWriter {
        address es = _getModule(ModuleKeys.KEY_EASY_STAKING);
        if (msg.sender != es) revert RewardView__UnauthorizedWriter();

        _easyStaked[user] = newStaked;
        if (blockNumber > _userSummary[user].lastActivity) _userSummary[user].lastActivity = blockNumber;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _touchUserCache(user);

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_EASY_STAKED,
            abi.encode(user, amount, newStaked, blockNumber)
        );
    }

    /**
     * @notice Push an Easy unstaked update (from EasyStaking).
     * @dev Writer: EasyStaking
     */
    function pushEasyUnstaked(address user, uint256 amount, uint256 newStaked, uint256 blockNumber) external onlyWriter {
        address es = _getModule(ModuleKeys.KEY_EASY_STAKING);
        if (msg.sender != es) revert RewardView__UnauthorizedWriter();

        _easyStaked[user] = newStaked;
        if (blockNumber > _userSummary[user].lastActivity) _userSummary[user].lastActivity = blockNumber;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _touchUserCache(user);

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_EASY_UNSTAKED,
            abi.encode(user, amount, newStaked, blockNumber)
        );
    }

    /**
     * @notice Push Easy emission parameters update (from EasyEmissionConfig).
     * @dev Writer: EasyEmissionConfig
     */
    function pushEasyEmissionParamsUpdated(
        uint256 thresholdUsd8,
        uint256 mintPer1000Usd,
        uint256 kNum,
        uint256 kDen,
        uint256 blockNumber
    ) external onlyWriter {
        address econf = _getModule(ModuleKeys.KEY_EASY_EMISSION_CONFIG);
        if (msg.sender != econf) revert RewardView__UnauthorizedWriter();

        _easyEmissionThresholdUsd8 = thresholdUsd8;
        _easyEmissionMintPer1000Usd = mintPer1000Usd;
        _easyEmissionKNum = kNum;
        _easyEmissionKDen = kDen;
        _easyEmissionCacheBlock = block.number;

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_EASY_EMISSION_PARAMS_UPDATED,
            abi.encode(thresholdUsd8, mintPer1000Usd, kNum, kDen, blockNumber)
        );
    }

    /**
     * @notice Push an Easy spent update (from EasyConsumption).
     * @dev Writer: EasyConsumption
     */
    function pushEasySpent(address user, uint8 spendType, uint256 amount, uint256 blockNumber) external onlyWriter {
        address econ = _getModule(ModuleKeys.KEY_EASY_CONSUMPTION);
        if (msg.sender != econ) revert RewardView__UnauthorizedWriter();
        if (user == address(0) || amount == 0) return;

        _easySpent[user] += amount;
        _easyTotalSpent += amount;
        _easySpendCacheBlock = block.number;

        if (blockNumber > _userSummary[user].lastActivity) _userSummary[user].lastActivity = blockNumber;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _touchUserCache(user);

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_EASY_SPENT,
            abi.encode(user, spendType, amount, blockNumber)
        );
    }

    /**
     * @notice Push an Easy recycled split update (from EasyRecycleDistributor).
     * @dev Writer: EasyRecycleDistributor
     */
    function pushEasyRecycledSplit(
        address payer,
        uint256 amount,
        uint256 burnAmount,
        uint256 teamAmount,
        uint256 ecoAmount,
        uint8 spendType,
        uint256 blockNumber
    ) external onlyWriter {
        address erd = _getModule(ModuleKeys.KEY_EASY_RECYCLE_DISTRIBUTOR);
        if (msg.sender != erd) revert RewardView__UnauthorizedWriter();
        if (amount == 0) return;

        _easyTotalRecycled += amount;
        _easyTotalBurned += burnAmount;
        _easyTotalTeam += teamAmount;
        _easyTotalEco += ecoAmount;
        _easySpendCacheBlock = block.number;

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_EASY_RECYCLED_SPLIT,
            abi.encode(payer, amount, burnAmount, teamAmount, ecoAmount, spendType, blockNumber)
        );
    }

    /**
     * @notice Admin retry helper: replay an "Easy burned" push (manual recovery).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (MissingRole)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     * - Should not be used on normal paths (manual recovery only)
     *
     * @param user User address
    * @param amount Burned Easy amount
     * @param reason Short reason string
     * @param blockNumber Business blockNumber (block number; admin-defined)
     */
    function retryPushEasyBurned(address user, uint256 amount, string calldata reason, uint256 blockNumber)
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
        * @notice Push a penalty ledger (pending Easy debt) update for a user.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
        * - onlyWriter (authorized writer modules via Registry)
     * - Emits DataPushed(DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED, abi.encode(user, pendingDebt, blockNumber))
     *
     * @param user User address
        * @param pendingDebt Pending Easy debt (reward units, system-defined)
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
        * - onlyWriter (authorized writer modules via Registry)
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
     * @notice Push earn-side dynamic reward parameters (governance observability) and emit DataPushed.
        * @dev Writer: authorized writer modules via {onlyWriter}.
     *
     * @param thresholdEasy Threshold in reward units (writer-defined; example-only until integrated)
     * @param multiplierBps Multiplier in BPS (10000=1x)
     * @param blockNumber Business blockNumber (writer-defined)
     */
    function pushDynamicRewardParams(uint256 thresholdEasy, uint256 multiplierBps, uint256 blockNumber) external onlyWriter {
        _dynamicRewardThresholdEasy = thresholdEasy;
        _dynamicRewardMultiplierBps = multiplierBps;
        _dynamicRewardCacheBlock = block.number;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_DYNAMIC_REWARD_PARAMS_UPDATED,
            abi.encode(thresholdEasy, multiplierBps, blockNumber)
        );
    }

    /**
     * @notice Push earn-side level multiplier (governance observability) and emit DataPushed.
        * @dev Writer: authorized writer modules via {onlyWriter}.
     *
     * @param level Level (1-5)
     * @param multiplierBps Multiplier in BPS (10000=1x)
     * @param blockNumber Business blockNumber (writer-defined)
     */
    function pushLevelMultiplier(uint8 level, uint256 multiplierBps, uint256 blockNumber) external onlyWriter {
        _levelMultiplierBps[level] = multiplierBps;
        _levelMultiplierCacheBlock = block.number;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_LEVEL_MULTIPLIER_UPDATED,
            abi.encode(level, multiplierBps, blockNumber)
        );
    }

    /**
     * @notice Push system-level reward stats and emit a unified DataPush event.
     * @dev Reverts if:
     *      - see {pushRewardEarned} (onlyWriter)
     *
     * Security:
        * - onlyWriter (authorized writer modules via Registry)
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
        _systemCacheUpdateBlock = block.number;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REWARD_STATS_UPDATED,
            abi.encode(totalBatchOps, totalCachedRewards, blockNumber)
        );
    }

    /*━━━━━━━━━━━━━━━ Read APIs (0-gas views) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Ops-only: checks whether given accounts hold the break-glass role `ACTION_REWARD_CONFIG_EMERGENCY`.
     * @dev Reverts if caller lacks VIEW_SYSTEM_DATA/ADMIN (MissingRole via onlyOps).
     * @param accounts Accounts to check.
     * @return hasRole True/false array aligned to `accounts`.
     */
    function getBreakglassRoleStatus(address[] calldata accounts)
        external
        view
        onlyValidRegistry
        onlyOps
        returns (bool[] memory hasRole)
    {
        address acm = _getModule(ModuleKeys.KEY_ACCESS_CONTROL);
        if (acm == address(0)) revert ZeroAddress();

        hasRole = new bool[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            (bool ok, bytes memory ret) = acm.staticcall(
                abi.encodeWithSignature("hasRole(bytes32,address)", ActionKeys.ACTION_REWARD_CONFIG_EMERGENCY, accounts[i])
            );
            hasRole[i] = ok && ret.length == 32 && abi.decode(ret, (bool));
        }
    }

    /**
     * @notice Get a user's reward summary plus local cache metadata (blockNumber + TTL validity).
     * @dev Reverts if:
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
    * @return totalEarned Total earned Easy
    * @return totalBurned Total burned Easy
     * @return pendingPenalty Pending penalty debt
     * @return level User level
     * @return lastActivity Last activity blockNumber (block number; writer-defined)
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
            uint256 lastActivity,
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
            s.lastActivity,
            blockNumber,
            isValid
        );
    }

    /**
     * @notice Get a user's Easy earned total plus local cache metadata.
     * @dev Reverts if:
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole)
     *
     * @param user Target user address
     * @return easyEarned Total Easy minted to user (RewardView-local)
     * @return blockNumber RewardView local cache last-write blockNumber
     * @return isValid Whether the local cache is within TTL
     */
    function getUserEasyEarnedWithMeta(address user)
        external
        view
        onlyAuthorizedFor(user)
        returns (uint256 easyEarned, uint256 blockNumber, bool isValid)
    {
        easyEarned = _easyEarned[user];
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get a user's Easy staked total plus local cache metadata.
     */
    function getUserEasyStakedWithMeta(address user)
        external
        view
        onlyAuthorizedFor(user)
        returns (uint256 easyStaked, uint256 blockNumber, bool isValid)
    {
        easyStaked = _easyStaked[user];
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get cached Easy emission params with metadata.
     * @dev Gate: VIEW_SYSTEM_DATA or ADMIN.
     */
    function getEasyEmissionParamsWithMeta()
        external
        view
        onlyValidRegistry
        onlyOps
        returns (
            uint256 thresholdUsd8,
            uint256 mintPer1000Usd,
            uint256 kNum,
            uint256 kDen,
            uint256 blockNumber,
            bool isValid
        )
    {
        thresholdUsd8 = _easyEmissionThresholdUsd8;
        mintPer1000Usd = _easyEmissionMintPer1000Usd;
        kNum = _easyEmissionKNum;
        kDen = _easyEmissionKDen;
        blockNumber = _easyEmissionCacheBlock;
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get a user's Easy spent total plus local cache metadata.
     */
    function getUserEasySpentWithMeta(address user)
        external
        view
        onlyAuthorizedFor(user)
        returns (uint256 easySpent, uint256 blockNumber, bool isValid)
    {
        easySpent = _easySpent[user];
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get Easy spend/recycle system totals with metadata.
     */
    function getEasySpendStatsWithMeta()
        external
        view
        onlyValidRegistry
        onlyOps
        returns (
            uint256 totalSpent,
            uint256 totalRecycled,
            uint256 totalBurned,
            uint256 totalTeam,
            uint256 totalEco,
            uint256 blockNumber,
            bool isValid
        )
    {
        totalSpent = _easyTotalSpent;
        totalRecycled = _easyTotalRecycled;
        totalBurned = _easyTotalBurned;
        totalTeam = _easyTotalTeam;
        totalEco = _easyTotalEco;
        blockNumber = _easySpendCacheBlock;
        isValid = _isUserCacheValid(blockNumber);
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
        blockNumber = _systemCacheUpdateBlock;
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

    /**
     * @notice Get cached dynamic reward parameters with TTL metadata.
     * @dev Security: read-only, public (non-user-scoped).
     */
    function getDynamicRewardParamsWithMeta()
        external
        view
        onlyValidRegistry
        returns (uint256 thresholdEasy, uint256 multiplierBps, uint256 cacheBlock, bool isValid)
    {
        thresholdEasy = _dynamicRewardThresholdEasy;
        multiplierBps = _dynamicRewardMultiplierBps;
        cacheBlock = _dynamicRewardCacheBlock;
        isValid = _isUserCacheValid(cacheBlock);
    }

    /**
     * @notice Get cached level multiplier (BPS) for a level with TTL metadata.
     * @dev Security: read-only, public (non-user-scoped).
     */
    function getLevelMultiplierWithMeta(uint8 level)
        external
        view
        onlyValidRegistry
        returns (uint256 multiplierBps, uint256 cacheBlock, bool isValid)
    {
        multiplierBps = _levelMultiplierBps[level];
        cacheBlock = _levelMultiplierCacheBlock;
        isValid = _isUserCacheValid(cacheBlock);
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
     * @param fromBlock Inclusive start blockNumber filter (block-based). 0 means no lower bound.
     * @param toBlock Inclusive end blockNumber filter (block-based). 0 means no upper bound.
     * @param limit Maximum number of entries to return (0 returns empty)
     * @return out Activity array (most recent first). Scan is capped by _MAX_ACTIVITY_SCAN.
     * @return blockNumber RewardView local cache last-write blockNumber (block.number)
     * @return isValid Whether the local cache is within TTL (ViewConstants.CACHE_DURATION)
     */
    function getUserRecentActivitiesWithMeta(address user, uint256 fromBlock, uint256 toBlock, uint256 limit)
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
            if ((fromBlock == 0 || a.blockNumber >= fromBlock) && (toBlock == 0 || a.blockNumber <= toBlock)) {
                count++;
            }
        }
        out = new Activity[](count);
        uint256 idx;
        scanned = 0;
        for (uint256 i = arr.length; i > 0 && scanned < _MAX_ACTIVITY_SCAN && idx < count; i--) {
            Activity storage a2 = arr[i - 1];
            scanned++;
            if ((fromBlock == 0 || a2.blockNumber >= fromBlock) && (toBlock == 0 || a2.blockNumber <= toBlock)) {
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
        blockNumber = _systemCacheUpdateBlock;
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Protocol-enforced read: get a user's level for borrow checks (OrderEngine only).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not OrderEngine (MissingRole via onlyOrderEngine)
     *
     * Security:
     * - Role-gated: KEY_ORDER_ENGINE only (protocol internal check path)
     *
     * @param user Target user address
     * @return level User level (returns 0 if RewardManagerCore module is missing)
     */
    function getUserLevelForBorrowCheck(address user)
        external
        view
        onlyValidRegistry
        onlyOrderEngine
        returns (uint8)
    {
        return _userSummary[user].level;
    }
    
    /*━━━━━━━━━━━━━━━ Additional read APIs (View SSOT) ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get a user's EasyToken balance with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
    * - Best-effort: returns 0 if EasyToken module is missing.
     *
     * @param user Target user address
    * @return balance EasyToken balance (token units)
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
        address easyTokenAddr = _getModule(ModuleKeys.KEY_EASY_TOKEN);
        if (easyTokenAddr == address(0)) {
            balance = 0;
        } else {
            balance = IEasyTokenMinimal(easyTokenAddr).balanceOf(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get a user's EasyToken balance, with RewardView cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole via onlyAuthorizedFor)
     *
     * Security:
     * - Read-only
    * - Best-effort: returns 0 if EasyToken module is missing.
     *
     * @param user Target user address
    * @return balance EasyToken balance (token units)
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
        address easyTokenAddr = _getModule(ModuleKeys.KEY_EASY_TOKEN);
        if (easyTokenAddr == address(0)) {
            balance = 0;
        } else {
            balance = IEasyTokenMinimal(easyTokenAddr).balanceOf(user);
        }
        blockNumber = _userCacheBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
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
        _systemCacheUpdateBlock = block.number;
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
        // API change: split penalty-ledger DataPush type from REWARD_STATS_UPDATED into REWARD_PENALTY_LEDGER_UPDATED.
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
 * @notice Minimal EasyToken interface (used by RewardView).
 */
interface IEasyTokenMinimal {
    function balanceOf(address owner) external view returns (uint256);
}



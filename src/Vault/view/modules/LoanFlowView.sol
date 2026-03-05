// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { MissingRole, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @title LoanFlowView
 * @notice View-cache for protocol loan flow statistics (borrow/repay volumes) in USD-8 SSOT.
 * @dev Architecture SSOT:
 * - Cross-asset aggregates MUST be expressed in USD-8 value (see `docs/Units-And-Conversions-SSOT.md`).
 * - Writes MUST be single-entry orchestrated (Scheme B) via `KEY_LOAN_FLOW_PUSH_MANAGER` (best-effort, retryable).
 *
 * Security:
 * - UUPS upgradeable; upgrades are admin-gated via Registry ACM.
 * - Writes are restricted to the orchestrator (or admin bypass).
 * - Reads follow Scheme U for user-scoped data.
 */
contract LoanFlowView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Incoming version is stale / violates strict optimistic concurrency.
    /// @dev Reverts if `incomingVersion != currentVersion + 1` when `incomingVersion != 0`.
    error LoanFlowView__StaleVersion(uint64 currentVersion, uint64 incomingVersion);

    /// @notice Incoming sequence is out of order (must be strictly increasing).
    /// @dev Reverts if `incomingSeq <= currentSeq` when `incomingSeq != 0`.
    error LoanFlowView__OutOfOrderSeq(uint64 currentSeq, uint64 incomingSeq);

    /// @notice Thrown when attempting to upgrade to the zero address.
    error LoanFlowView__ZeroImplementation();

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when a replayed idempotent request is ignored (no state mutation).
    event IdempotentRequestIgnored(address indexed user, bytes32 indexed requestId, uint64 seq);

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    address private _registryAddr;

    // Per-user volumes (USD-8).
    mapping(address => uint256) private _borrowVolumeUsd8;
    mapping(address => uint256) private _repayVolumeUsd8;

    // Per-user metadata (packed) + last applied requestId.
    mapping(address => uint256) private _userMetaPacked;
    mapping(address => bytes32) private _lastAppliedRequestId;

    // Global volumes (USD-8).
    uint256 private _totalBorrowVolumeUsd8;
    uint256 private _totalRepayVolumeUsd8;
    uint256 private _globalMetaPacked;

    uint256 private constant _CACHE_DURATION = ViewConstants.CACHE_DURATION_BLOCKS;

    /*━━━━━━━━━━━━━━━ Packing constants ━━━━━━━━━━━━━━━*/
    // userMetaPacked layout (low -> high bits):
    // - [0..63]   uint64 version
    // - [64..127] uint64 seq
    // - [128..175] uint48 borrowCount
    // - [176..223] uint48 repayCount
    // - [224..255] uint32 lastUpdateBlock
    uint256 private constant _SHIFT_SEQ = 64;
    uint256 private constant _SHIFT_BORROW_COUNT = 128;
    uint256 private constant _SHIFT_REPAY_COUNT = 176;
    uint256 private constant _SHIFT_LAST_UPDATE_BLOCK = 224;

    uint256 private constant _MASK_64 = type(uint64).max;
    uint256 private constant _MASK_48 = (1 << 48) - 1;
    uint256 private constant _MASK_32 = type(uint32).max;

    // globalMetaPacked layout:
    // - [0..47]   uint48 totalBorrowCount
    // - [48..95]  uint48 totalRepayCount
    // - [96..127] uint32 lastUpdateBlock
    uint256 private constant _SHIFT_G_REPAY_COUNT = 48;
    uint256 private constant _SHIFT_G_LAST_UPDATE_BLOCK = 96;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Scheme U: self-read allowed; non-self requires VIEW_USER_DATA or ADMIN.
    modifier onlyUserOrViewer(address user) {
        if (
            msg.sender != user
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    /// @dev Gate for system/global reads: VIEW_SYSTEM_DATA or ADMIN.
    modifier onlyOpsOrAdmin() {
        if (
            !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender)
                && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
        ) revert MissingRole();
        _;
    }

    /**
     * @notice Internal read gate for RewardManagerCore.
     * @dev Allows `Registry[KEY_REWARD_MANAGER_CORE]` (Reward SSOT module) or ACTION_ADMIN to read user-dimensional flow.
     *
     * Rationale:
     * - External consumers follow Scheme U (self-read or VIEW_USER_DATA/ADMIN).
     * - Reward SSOT logic may need to read protocol loan-flow SSOT to derive reward-qualified activity without
     *   granting broad VIEW_USER_DATA permissions to the RewardManagerCore role set.
     */
    modifier onlyRewardManagerCoreOrAdmin() {
        address rmCore = Registry(_registryAddr).getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        if (msg.sender != rmCore && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
        _;
    }

    /// @dev Scheme B single-entry: only LoanFlowPushManager or ADMIN may push.
    modifier onlyLoanFlowPusherOrAdmin() {
        address pusher = Registry(_registryAddr).getModule(ModuleKeys.KEY_LOAN_FLOW_PUSH_MANAGER);
        bool isAdmin = ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (msg.sender != pusher && !isAdmin) revert MissingRole();
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the LoanFlowView (UUPS).
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

    /*━━━━━━━━━━━━━━━ Push APIs (single-entry orchestrated) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Push a per-user loan-flow delta (USD-8) into the cache with concurrency metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not `Registry[KEY_LOAN_FLOW_PUSH_MANAGER]` and lacks ACTION_ADMIN (MissingRole)
     *      - user is zero (ZeroAddress)
     *      - seq is out of order when `seq != 0` (LoanFlowView__OutOfOrderSeq)
     *      - nextVersion is stale when `nextVersion != 0` (LoanFlowView__StaleVersion)
     *
     * Security:
     * - Writer-gated: single-entry orchestrator (`KEY_LOAN_FLOW_PUSH_MANAGER`) or admin bypass.
     * - Idempotent replay (no revert): if (nextVersion == currentVersion) AND (requestId matches lastAppliedRequestId),
     *   emits {IdempotentRequestIgnored} and returns without writing.
     *
     * Units (SSOT):
     * - All USD values are USD-8 (e.g. $1.00 = 100000000).
     *
     * @param user Target user address
     * @param borrowDeltaUsd8 Borrow flow delta to add (USD-8)
     * @param repayDeltaUsd8 Repay flow delta to add (USD-8)
     * @param borrowCountDelta Borrow event count delta to add (unitless; typically 1 for a borrow event)
     * @param repayCountDelta Repay event count delta to add (unitless; typically 1 for a repay event)
     * @param requestId Idempotency key for replay detection (recommended non-zero)
     * @param seq Optional monotonic sequence number (0 disables ordering enforcement)
     * @param nextVersion Expected next version (0 means auto-increment; otherwise must equal currentVersion + 1)
     */
    function pushUserLoanFlowUpdate(
        address user,
        uint256 borrowDeltaUsd8,
        uint256 repayDeltaUsd8,
        uint64 borrowCountDelta,
        uint64 repayCountDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external onlyValidRegistry onlyLoanFlowPusherOrAdmin {
        if (user == address(0)) revert ZeroAddress();

        (uint64 currentVersion, uint64 currentSeq, uint48 borrowCount, uint48 repayCount, ) =
            _unpackUserMeta(_userMetaPacked[user]);

        // O(1) idempotency (version-bound), aligned with StatisticsView semantics.
        if (requestId != bytes32(0) && nextVersion != 0) {
            if (nextVersion == currentVersion && _lastAppliedRequestId[user] == requestId) {
                emit IdempotentRequestIgnored(user, requestId, seq);
                return;
            }
        }

        // Optional strict ordering aid (seq).
        if (seq != 0) {
            if (seq <= currentSeq) revert LoanFlowView__OutOfOrderSeq(currentSeq, seq);
            currentSeq = seq;
        }

        uint64 newVersion = nextVersion;
        if (nextVersion == 0) {
            newVersion = currentVersion + 1;
        } else {
            if (nextVersion != currentVersion + 1) revert LoanFlowView__StaleVersion(currentVersion, nextVersion);
        }

        // Update user aggregates.
        if (borrowDeltaUsd8 != 0) _borrowVolumeUsd8[user] += borrowDeltaUsd8;
        if (repayDeltaUsd8 != 0) _repayVolumeUsd8[user] += repayDeltaUsd8;

        // Count deltas are explicit to preserve counting semantics even when USD-8 delta rounds to 0.
        borrowCount = uint48(uint256(borrowCount) + uint256(borrowCountDelta));
        repayCount = uint48(uint256(repayCount) + uint256(repayCountDelta));

        uint32 updateBlock = uint32(block.number);
        _userMetaPacked[user] = _packUserMeta(newVersion, currentSeq, borrowCount, repayCount, updateBlock);
        if (requestId != bytes32(0) && nextVersion != 0) {
            _lastAppliedRequestId[user] = requestId;
        }

        // Update global aggregates (USD-8 SSOT).
        if (borrowDeltaUsd8 != 0) _totalBorrowVolumeUsd8 += borrowDeltaUsd8;
        if (repayDeltaUsd8 != 0) _totalRepayVolumeUsd8 += repayDeltaUsd8;
        _updateGlobalCountsAndBlock(borrowCountDelta, repayCountDelta, updateBlock);

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_FLOW_UPDATED,
            abi.encode(user, borrowDeltaUsd8, repayDeltaUsd8, newVersion, requestId, seq, block.number)
        );
    }

    /*━━━━━━━━━━━━━━━ Read APIs (0-gas views) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get per-user loan-flow totals with cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not the user and lacks VIEW_USER_DATA / ADMIN (MissingRole via onlyUserOrViewer)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return borrowVolumeUsd8 Total borrow volume (USD-8)
     * @return repayVolumeUsd8 Total repay volume (USD-8)
     * @return borrowCount Total borrow event count (unitless)
     * @return repayCount Total repay event count (unitless)
     * @return version Current optimistic concurrency version
     * @return seq Current monotonic sequence (0 if never provided)
     * @return lastAppliedRequestId Last applied idempotency key (bytes32(0) if none)
     * @return isValid Cache validity flag (TTL heuristic; see ViewConstants.CACHE_DURATION_BLOCKS)
     * @return blockNumber Last cache update blockNumber (block.number; packed as uint32)
     */
    function getUserLoanFlowWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyUserOrViewer(user)
        returns (
            uint256 borrowVolumeUsd8,
            uint256 repayVolumeUsd8,
            uint256 borrowCount,
            uint256 repayCount,
            uint64 version,
            uint64 seq,
            bytes32 lastAppliedRequestId,
            bool isValid,
            uint256 blockNumber
        )
    {
        borrowVolumeUsd8 = _borrowVolumeUsd8[user];
        repayVolumeUsd8 = _repayVolumeUsd8[user];
        uint48 bc;
        uint48 rc;
        uint32 lastBlock;
        (version, seq, bc, rc, lastBlock) = _unpackUserMeta(_userMetaPacked[user]);
        borrowCount = uint256(bc);
        repayCount = uint256(rc);
        lastAppliedRequestId = _lastAppliedRequestId[user];
        blockNumber = uint256(lastBlock);
        isValid = _isValid(lastBlock);
    }

    /**
     * @notice Get global loan-flow totals with cache metadata.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *
     * Security:
     * - Read-only
     *
     * @return totalBorrowVolumeUsd8 Total borrow volume (USD-8)
     * @return totalRepayVolumeUsd8 Total repay volume (USD-8)
     * @return totalBorrowCount Total borrow event count (unitless)
     * @return totalRepayCount Total repay event count (unitless)
     * @return isValid Cache validity flag (TTL heuristic; see ViewConstants.CACHE_DURATION_BLOCKS)
     * @return blockNumber Last cache update blockNumber (block.number; packed as uint32)
     */
    function getGlobalLoanFlowWithMeta()
        external
        view
        onlyValidRegistry
        returns (
            uint256 totalBorrowVolumeUsd8,
            uint256 totalRepayVolumeUsd8,
            uint256 totalBorrowCount,
            uint256 totalRepayCount,
            bool isValid,
            uint256 blockNumber
        )
    {
        totalBorrowVolumeUsd8 = _totalBorrowVolumeUsd8;
        totalRepayVolumeUsd8 = _totalRepayVolumeUsd8;
        (uint48 bc, uint48 rc, uint32 lastBlock) = _unpackGlobalMeta(_globalMetaPacked);
        totalBorrowCount = uint256(bc);
        totalRepayCount = uint256(rc);
        blockNumber = uint256(lastBlock);
        isValid = _isValid(lastBlock);
    }

    /**
     * @notice Internal read helper for RewardManagerCore: borrow-only flow (USD-8) + cache validity meta.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not `Registry[KEY_REWARD_MANAGER_CORE]` and lacks ACTION_ADMIN (MissingRole)
     *
     * Security:
     * - Read-only (module-gated)
     *
     * Units (SSOT):
     * - USD-8 (e.g. $1.00 = 100000000)
     *
     * @param user Target user address
     * @return borrowVolumeUsd8 Total borrow volume (USD-8)
     * @return borrowCount Total borrow event count (unitless)
     * @return isValid Cache validity flag (TTL heuristic)
     * @return blockNumber Last cache update blockNumber (block.number; packed as uint32)
     */
    function getUserBorrowFlowForReward(address user)
        external
        view
        onlyValidRegistry
        onlyRewardManagerCoreOrAdmin
        returns (uint256 borrowVolumeUsd8, uint256 borrowCount, bool isValid, uint256 blockNumber)
    {
        borrowVolumeUsd8 = _borrowVolumeUsd8[user];
        (, , uint48 bc, , uint32 lastBlock) = _unpackUserMeta(_userMetaPacked[user]);
        borrowCount = uint256(bc);
        blockNumber = uint256(lastBlock);
        isValid = _isValid(lastBlock);
    }

    /**
     * @notice Return the current user loan-flow version for the pusher (or admin).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller is not `Registry[KEY_LOAN_FLOW_PUSH_MANAGER]` and lacks ACTION_ADMIN (MissingRole)
     *
     * Security:
     * - Read-only
     *
     * @param user Target user address
     * @return version Current version (monotonic)
     */
    function getUserLoanFlowVersionForPusher(address user)
        external
        view
        onlyValidRegistry
        onlyLoanFlowPusherOrAdmin
        returns (uint64 version)
    {
        (version, , , , ) = _unpackUserMeta(_userMetaPacked[user]);
    }

    /**
     * @notice Return the current Registry address.
     * @dev Reverts if:
     *      - (never)
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr Registry contract address
     */
    function getRegistry() external view returns (address registryAddr) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    function _isValid(uint32 lastBlock) internal view returns (bool) {
        if (lastBlock == 0) return false;
        uint256 b = uint256(lastBlock);
        return block.number >= b && block.number - b <= _CACHE_DURATION;
    }

    function _unpackUserMeta(uint256 packed)
        internal
        pure
        returns (uint64 version, uint64 seq, uint48 borrowCount, uint48 repayCount, uint32 lastUpdateBlock)
    {
        version = uint64(packed & _MASK_64);
        seq = uint64((packed >> _SHIFT_SEQ) & _MASK_64);
        borrowCount = uint48((packed >> _SHIFT_BORROW_COUNT) & _MASK_48);
        repayCount = uint48((packed >> _SHIFT_REPAY_COUNT) & _MASK_48);
        lastUpdateBlock = uint32((packed >> _SHIFT_LAST_UPDATE_BLOCK) & _MASK_32);
    }

    function _packUserMeta(uint64 version, uint64 seq, uint48 borrowCount, uint48 repayCount, uint32 lastUpdateBlock)
        internal
        pure
        returns (uint256 packed)
    {
        packed =
            uint256(version)
            | (uint256(seq) << _SHIFT_SEQ)
            | (uint256(borrowCount) << _SHIFT_BORROW_COUNT)
            | (uint256(repayCount) << _SHIFT_REPAY_COUNT)
            | (uint256(lastUpdateBlock) << _SHIFT_LAST_UPDATE_BLOCK);
    }

    function _unpackGlobalMeta(uint256 packed) internal pure returns (uint48 borrowCount, uint48 repayCount, uint32 lastUpdateBlock) {
        borrowCount = uint48(packed & _MASK_48);
        repayCount = uint48((packed >> _SHIFT_G_REPAY_COUNT) & _MASK_48);
        lastUpdateBlock = uint32((packed >> _SHIFT_G_LAST_UPDATE_BLOCK) & _MASK_32);
    }

    function _packGlobalMeta(uint48 borrowCount, uint48 repayCount, uint32 lastUpdateBlock) internal pure returns (uint256 packed) {
        packed =
            uint256(borrowCount)
            | (uint256(repayCount) << _SHIFT_G_REPAY_COUNT)
            | (uint256(lastUpdateBlock) << _SHIFT_G_LAST_UPDATE_BLOCK);
    }

    function _updateGlobalCountsAndBlock(uint64 borrowCountDelta, uint64 repayCountDelta, uint32 updateBlock) internal {
        (uint48 bc, uint48 rc, ) = _unpackGlobalMeta(_globalMetaPacked);
        bc = uint48(uint256(bc) + uint256(borrowCountDelta));
        rc = uint48(uint256(rc) + uint256(repayCountDelta));
        _globalMetaPacked = _packGlobalMeta(bc, rc, updateBlock);
    }

    /*━━━━━━━━━━━━━━━ UUPS upgrade ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize a UUPS upgrade.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN (MissingRole)
     *      - newImplementation is zero (LoanFlowView__ZeroImplementation)
     *
     * Security:
     * - Role-gated: ACTION_ADMIN
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) revert MissingRole();
        if (newImplementation == address(0)) revert LoanFlowView__ZeroImplementation();
    }

    /*━━━━━━━━━━━━━━━ Versioning ━━━━━━━━━━━━━━━*/

    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    uint256[50] private __gap;
}


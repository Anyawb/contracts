// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../../registry/Registry.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { EasyToken } from "../../Token/EasyToken.sol";
import { NotAContract, ZeroAddress } from "../../errors/StandardErrors.sol";

/// @title RewardModuleBase
/// @notice Shared base for Reward subsystem: Registry validation, role checks, module access, RewardView push.
/// @dev Provides internal helpers only; no external/public functions to avoid signature clashes.
/// @dev IRewardViewWriter defines the minimal write interface for RewardView (RewardManagerCore and other writers).
interface IRewardViewWriter {
    function pushRewardEarned(address user, uint256 amount, string calldata reason, uint256 blockNumber) external;
    function pushEasyBurned(address user, uint256 amount, string calldata reason, uint256 blockNumber) external;
    function pushPenaltyLedger(address user, uint256 pendingDebt, uint256 blockNumber) external;
    function pushUserLevel(address user, uint8 newLevel, uint256 blockNumber) external;
    function pushEasyMinted(
        address borrower,
        address lender,
        uint256 totalMinted,
        uint256 borrowerShare,
        uint256 lenderShare,
        uint256 orderId,
        uint256 amountUsd8,
        uint256 blockNumber
    ) external;
    function pushEasyStaked(address user, uint256 amount, uint256 newStaked, uint256 blockNumber) external;
    function pushEasyUnstaked(address user, uint256 amount, uint256 newStaked, uint256 blockNumber) external;
    function pushEasyEmissionParamsUpdated(
        uint256 thresholdUsd8,
        uint256 mintPer1000Usd,
        uint256 kNum,
        uint256 kDen,
        uint256 blockNumber
    ) external;
    function pushEasySpent(address user, uint8 spendType, uint256 amount, uint256 blockNumber) external;
    function pushEasyRecycledSplit(
        address payer,
        uint256 amount,
        uint256 burnAmount,
        uint256 teamAmount,
        uint256 ecoAmount,
        uint8 spendType,
        uint256 blockNumber
    ) external;
    function pushSystemStats(uint256 totalBatchOps, uint256 totalCachedRewards, uint256 blockNumber) external;
    function pushDynamicRewardParams(uint256 thresholdEasy, uint256 multiplierBps, uint256 blockNumber) external;
    function pushLevelMultiplier(uint8 level, uint256 multiplierBps, uint256 blockNumber) external;
}

abstract contract RewardModuleBase {

    /*━━━━━━━━━━━━━━━ RewardView Push Failure Event ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when a RewardView push fails (no revert; for off-chain alert and manual retry).
    /// @dev Emitted by _tryPush* functions on failure. Off-chain listeners may retry via governance.
    /// @param user User address (address(0) for system-level pushes).
    /// @param rewardView RewardView address at call time (may be address(0) if unresolved).
    /// @param op Push operation type (e.g. keccak256("REWARD_EARNED")).
    /// @param payload Intended payload (abi.encode(...)).
    /// @param reason Revert reason (or bytes("rewardView unavailable") when rewardView==0).
    event RewardViewPushFailed(
        address indexed user,
        address indexed rewardView,
        bytes32 indexed op,
        bytes payload,
        bytes reason
    );

    bytes32 internal constant _RV_OP_REWARD_EARNED = keccak256("REWARD_EARNED");
    bytes32 internal constant _RV_OP_EASY_BURNED = keccak256("EASY_BURNED");
    bytes32 internal constant _RV_OP_PENALTY_LEDGER = keccak256("PENALTY_LEDGER");
    bytes32 internal constant _RV_OP_USER_LEVEL = keccak256("USER_LEVEL");
    bytes32 internal constant _RV_OP_EASY_MINTED = keccak256("EASY_MINTED");
    bytes32 internal constant _RV_OP_EASY_STAKED = keccak256("EASY_STAKED");
    bytes32 internal constant _RV_OP_EASY_UNSTAKED = keccak256("EASY_UNSTAKED");
    bytes32 internal constant _RV_OP_EASY_EMISSION_PARAMS = keccak256("EASY_EMISSION_PARAMS_UPDATED");
    bytes32 internal constant _RV_OP_EASY_SPENT = keccak256("EASY_SPENT");
    bytes32 internal constant _RV_OP_EASY_RECYCLED_SPLIT = keccak256("EASY_RECYCLED_SPLIT");
    bytes32 internal constant _RV_OP_SYSTEM_STATS = keccak256("SYSTEM_STATS");
    bytes32 internal constant _RV_OP_DYNAMIC_REWARD_PARAMS = keccak256("DYNAMIC_REWARD_PARAMS");
    bytes32 internal constant _RV_OP_LEVEL_MULTIPLIER = keccak256("LEVEL_MULTIPLIER");

    /*━━━━━━━━━━━━━━━ Abstract Dependency ━━━━━━━━━━━━━━━*/

    /// @notice Returns the Registry address used by this contract.
    /// @dev Reverts if:
    ///      - Never reverts (abstract; implemented by child).
    ///
    /// Security:
    /// - View-only; child typically holds `address private _registryAddr`.
    ///
    /// @return Registry address.
    function _getRegistryAddr() internal view virtual returns (address);

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    /// @notice Validates that Registry is set and is a contract.
    /// @dev Reverts if:
    ///      - Registry is zero (see {ZeroAddress})
    ///      - Registry is not a contract (see {NotAContract})
    ///
    /// Security:
    /// - No external calls; checks _getRegistryAddr() only.
    modifier onlyValidRegistry() {
        address registryAddr = _getRegistryAddr();
        if (registryAddr == address(0)) revert ZeroAddress();
        if (registryAddr.code.length == 0) revert NotAContract(registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ Role Utilities ━━━━━━━━━━━━━━━*/

    /// @notice Checks that user has the given action key via ACM.
    /// @dev Reverts if:
    ///      - Registry missing KEY_ACCESS_CONTROL (see {ModuleNotRegistered} in {Registry.getModuleOrRevert})
    ///      - User lacks actionKey (see {MissingRole} via ACM)
    ///
    /// Security:
    /// - Read-only; resolves Registry[KEY_ACCESS_CONTROL], then ACM.requireRole.
    ///
    /// @param actionKey Action key (see {ActionKeys}).
    /// @param user Address to check.
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_getRegistryAddr()).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /*━━━━━━━━━━━━━━━ Module Access ━━━━━━━━━━━━━━━*/

    /// @notice Returns the EasyToken instance.
    /// @dev Reverts if:
    ///      - Registry missing KEY_EASY_TOKEN (see {ModuleNotRegistered} in {Registry.getModuleOrRevert})
    ///
    /// Security:
    /// - Read-only; resolves Registry[KEY_EASY_TOKEN].
    ///
    /// @return EasyToken contract instance.
    function _getRewardToken() internal view returns (EasyToken) {
        address tokenAddr = Registry(_getRegistryAddr()).getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN);
        return EasyToken(tokenAddr);
    }

    /*━━━━━━━━━━━━━━━ RewardView Push (Best-Effort, No Revert) ━━━━━━━━━━━━━━━*/

    address private _cachedRewardViewAddr;
    uint256 private _cachedRewardViewBlock;
    uint256 private constant _RV_CACHE_TTL_BLOCKS = 1_800;

    /// @notice Resolves and caches RewardView address (TTL ~1 hour in blocks).
    /// @dev Reverts if:
    ///      - Never reverts (best-effort; try/catch swallows Registry.getModuleOrRevert failure).
    ///
    /// Security:
    /// - Best-effort: returns address(0) if Registry missing KEY_REWARD_VIEW; callers MUST treat address(0)
    ///   as unavailable. Does not affect security-critical paths (e.g. liquidation, rewards).
    ///
    /// @return rv RewardView address, or address(0) if unresolved/unavailable.
    function _getRewardViewCached() internal returns (address rv) {
        if (_cachedRewardViewAddr != address(0) && block.number < _cachedRewardViewBlock + _RV_CACHE_TTL_BLOCKS) {
            return _cachedRewardViewAddr;
        }
        try Registry(_getRegistryAddr()).getModuleOrRevert(ModuleKeys.KEY_REWARD_VIEW) returns (address viewAddr) {
            _cachedRewardViewAddr = viewAddr;
            _cachedRewardViewBlock = block.number;
            return viewAddr;
        } catch {
            return address(0);
        }
    }

    /// @notice Best-effort push: reward earned (RMCore).
    /// @dev Reverts if:
    ///      - Never reverts; emits {RewardViewPushFailed} on failure.
    ///
    /// Security:
    /// - Best-effort; never reverts; off-chain listeners may retry via governance.
    ///
    /// @param user User address.
    /// @param amount Easy token amount in reward units.
    /// @param reason Reason string.
    function _tryPushRewardEarned(address user, uint256 amount, string memory reason) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, amount, reason, block.number);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, _RV_OP_REWARD_EARNED, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushRewardEarned(user, amount, reason, block.number) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, _RV_OP_REWARD_EARNED, payload, err);
        }
    }

    /// @notice Best-effort push: Easy burned.
    /// @dev Reverts if:
    ///      - Never reverts; emits {RewardViewPushFailed} on failure.
    ///
    /// Security:
    /// - Best-effort; never reverts; off-chain listeners may retry via governance.
    ///
    /// @param user User address.
    /// @param amount Easy burned in reward units.
    /// @param reason Reason string.
    function _tryPushEasyBurned(address user, uint256 amount, string memory reason) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, amount, reason, block.number);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, _RV_OP_EASY_BURNED, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushEasyBurned(user, amount, reason, block.number) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, _RV_OP_EASY_BURNED, payload, err);
        }
    }

    /// @notice Best-effort push: Easy minted (borrower/lender).
    /// @dev Reverts if:
    ///      - Never reverts; emits {RewardViewPushFailed} on failure.
    function _tryPushEasyMinted(
        address borrower,
        address lender,
        uint256 totalMinted,
        uint256 borrowerShare,
        uint256 lenderShare,
        uint256 orderId,
        uint256 amountUsd8
    ) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(
            borrower,
            lender,
            totalMinted,
            borrowerShare,
            lenderShare,
            orderId,
            amountUsd8,
            block.number
        );
        if (rv == address(0)) {
            emit RewardViewPushFailed(borrower, rv, _RV_OP_EASY_MINTED, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushEasyMinted(
            borrower,
            lender,
            totalMinted,
            borrowerShare,
            lenderShare,
            orderId,
            amountUsd8,
            block.number
        ) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(borrower, rv, _RV_OP_EASY_MINTED, payload, err);
        }
    }

    function _tryPushEasyStaked(address user, uint256 amount, uint256 newStaked) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, amount, newStaked, block.number);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, _RV_OP_EASY_STAKED, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushEasyStaked(user, amount, newStaked, block.number) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, _RV_OP_EASY_STAKED, payload, err);
        }
    }

    function _tryPushEasyUnstaked(address user, uint256 amount, uint256 newStaked) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, amount, newStaked, block.number);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, _RV_OP_EASY_UNSTAKED, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushEasyUnstaked(user, amount, newStaked, block.number) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, _RV_OP_EASY_UNSTAKED, payload, err);
        }
    }

    function _tryPushEasyEmissionParamsUpdated(
        uint256 thresholdUsd8,
        uint256 mintPer1000Usd,
        uint256 kNum,
        uint256 kDen
    ) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(thresholdUsd8, mintPer1000Usd, kNum, kDen, block.number);
        if (rv == address(0)) {
            emit RewardViewPushFailed(address(0), rv, _RV_OP_EASY_EMISSION_PARAMS, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushEasyEmissionParamsUpdated(
            thresholdUsd8,
            mintPer1000Usd,
            kNum,
            kDen,
            block.number
        ) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(address(0), rv, _RV_OP_EASY_EMISSION_PARAMS, payload, err);
        }
    }

    function _tryPushEasySpent(address user, uint8 spendType, uint256 amount) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, spendType, amount, block.number);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, _RV_OP_EASY_SPENT, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushEasySpent(user, spendType, amount, block.number) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, _RV_OP_EASY_SPENT, payload, err);
        }
    }

    function _tryPushEasyRecycledSplit(
        address payer,
        uint256 amount,
        uint256 burnAmount,
        uint256 teamAmount,
        uint256 ecoAmount,
        uint8 spendType
    ) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(payer, amount, burnAmount, teamAmount, ecoAmount, spendType, block.number);
        if (rv == address(0)) {
            emit RewardViewPushFailed(payer, rv, _RV_OP_EASY_RECYCLED_SPLIT, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushEasyRecycledSplit(
            payer,
            amount,
            burnAmount,
            teamAmount,
            ecoAmount,
            spendType,
            block.number
        ) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(payer, rv, _RV_OP_EASY_RECYCLED_SPLIT, payload, err);
        }
    }

    /// @notice Best-effort push: penalty ledger (pending debt).
    /// @dev Reverts if:
    ///      - Never reverts; emits {RewardViewPushFailed} on failure.
    ///
    /// Security:
    /// - Best-effort; never reverts; off-chain listeners may retry via governance.
    ///
    /// @param user User address.
    /// @param pendingDebt Pending debt in reward units.
    function _tryPushPenaltyLedger(address user, uint256 pendingDebt) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, pendingDebt, block.number);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, _RV_OP_PENALTY_LEDGER, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushPenaltyLedger(user, pendingDebt, block.number) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, _RV_OP_PENALTY_LEDGER, payload, err);
        }
    }

    /// @notice Best-effort push: user level.
    /// @dev Reverts if:
    ///      - Never reverts; emits {RewardViewPushFailed} on failure.
    ///
    /// Security:
    /// - Best-effort; never reverts; off-chain listeners may retry via governance.
    ///
    /// @param user User address.
    /// @param newLevel New level (0–255).
    function _tryPushUserLevel(address user, uint8 newLevel) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, newLevel, block.number);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, _RV_OP_USER_LEVEL, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushUserLevel(user, newLevel, block.number) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, _RV_OP_USER_LEVEL, payload, err);
        }
    }

    /// @notice Best-effort push: system stats.
    /// @dev Reverts if:
    ///      - Never reverts; emits {RewardViewPushFailed} on failure.
    ///
    /// Security:
    /// - Best-effort; never reverts; off-chain listeners may retry via governance.
    ///
    /// @param totalBatchOps Total batch operations count.
    /// @param totalCachedRewards Total cached rewards in reward units.
    function _tryPushSystemStats(uint256 totalBatchOps, uint256 totalCachedRewards) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(totalBatchOps, totalCachedRewards, block.number);
        if (rv == address(0)) {
            emit RewardViewPushFailed(address(0), rv, _RV_OP_SYSTEM_STATS, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushSystemStats(totalBatchOps, totalCachedRewards, block.number) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(address(0), rv, _RV_OP_SYSTEM_STATS, payload, err);
        }
    }

    /// @notice Best-effort push: dynamic reward params (Earn governance cache).
    /// @dev Reverts if:
    ///      - Never reverts; emits {RewardViewPushFailed} on failure.
    ///
    /// Security:
    /// - Best-effort; never reverts; off-chain listeners may retry via governance.
    ///
    /// @param thresholdEasy Threshold in reward units.
    /// @param multiplierBps Multiplier in basis points (1e4).
    /// @param blockNumber Block number for the record.
    function _tryPushDynamicRewardParams(uint256 thresholdEasy, uint256 multiplierBps, uint256 blockNumber) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(thresholdEasy, multiplierBps, blockNumber);
        if (rv == address(0)) {
            emit RewardViewPushFailed(
                address(0), rv, _RV_OP_DYNAMIC_REWARD_PARAMS, payload, bytes("rewardView unavailable")
            );
            return;
        }
        try IRewardViewWriter(rv).pushDynamicRewardParams(thresholdEasy, multiplierBps, blockNumber) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(address(0), rv, _RV_OP_DYNAMIC_REWARD_PARAMS, payload, err);
        }
    }

    /// @notice Best-effort push: level multiplier (Earn governance cache).
    /// @dev Reverts if:
    ///      - Never reverts; emits {RewardViewPushFailed} on failure.
    ///
    /// Security:
    /// - Best-effort; never reverts; off-chain listeners may retry via governance.
    ///
    /// @param level Level index.
    /// @param multiplierBps Multiplier in basis points (1e4).
    /// @param blockNumber Block number for the record.
    function _tryPushLevelMultiplier(uint8 level, uint256 multiplierBps, uint256 blockNumber) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(level, multiplierBps, blockNumber);
        if (rv == address(0)) {
            emit RewardViewPushFailed(
                address(0), rv, _RV_OP_LEVEL_MULTIPLIER, payload, bytes("rewardView unavailable")
            );
            return;
        }
        try IRewardViewWriter(rv).pushLevelMultiplier(level, multiplierBps, blockNumber) {
            uint256 noop = 0;
            noop;
        } catch (bytes memory err) {
            emit RewardViewPushFailed(address(0), rv, _RV_OP_LEVEL_MULTIPLIER, payload, err);
        }
    }
}

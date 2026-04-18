// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Registry} from "../registry/Registry.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {
    ZeroAddress,
    NotAContract,
    MissingRole,
    InvalidCaller
} from "../errors/StandardErrors.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {RewardModuleBase} from "./internal/RewardModuleBase.sol";

/// @dev Minimal LoanFlowView read adapter used by RewardManagerCore.
interface ILoanFlowViewRewardRead {
    function getUserBorrowFlowForReward(
        address user
    )
        external
        view
        returns (
            uint256 borrowVolumeValue,
            uint256 borrowCount,
            bool isValid,
            uint256 blockNumber
        );
}

/// @dev Minimal EarnConfig read adapter (governance params SSOT).
interface IEarnConfigRewardRead {
    function getDynamicRewardParams()
        external
        view
        returns (
            uint256 thresholdEasy,
            uint256 multiplierBps,
            uint256 updateBlock
        );

    function getLevelMultiplierBps(
        uint8 level
    ) external view returns (uint256 multiplierBps);
}

/// @dev Minimal RewardAccrualManager adapter.
interface IRewardAccrualManager {
    function applyLateRepayPenalty(
        address user,
        uint256 easyAmount,
        address executor
    ) external;
    function applyPenaltyFromGateway(
        address user,
        uint256 easyAmount,
        address executor
    ) external;
    function offsetPenaltyOnReward(
        address user,
        uint256 easyRewardAmount,
        string calldata reason
    ) external returns (uint256 netAmount);
}

/// @title RewardManagerCore
/// @notice Owns earn-side lock, release, penalty, and level-update logic.
/// @dev Current on-chain baseline:
///      - Borrow locks Easy without minting.
///      - On-time full repayment unlocks Easy and lets {EasyEmissionController} handle minting.
///      - Early or late full repayment does not mint and may apply penalty or debt-ledger logic.
///      Historical V1 naming such as `hfHighEnough` should be interpreted as
///      `isOnTimeAndFullyRepaid`, not HealthFactor.

contract RewardManagerCore is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    RewardModuleBase
{
    /// @dev Reverts when an external caller bypasses RewardManager and invokes
    ///      a restricted RewardManagerCore entry directly.
    error RewardManagerCore__UseRewardManagerEntry();
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Registry contract address used for all module lookups.
    address private _registryAddr;

    // NOTE (strict read boundary):
    // RewardManagerCore does not expose frontend-facing read APIs.
    // External/off-chain consumers MUST read RewardView. A protocol-internal borrow-check
    // getter exists for OrderEngine only to avoid using RewardView mirror as a hard gate.

    /// @notice DEPRECATED: penalty ledger moved to RewardAccrualManager (kept for storage compatibility).
    mapping(address => uint256) private _penaltyLedger;

    /*━━━━━━━━━━━━━━━ Level And Lock State ━━━━━━━━━━━━━━━*/

    /// @notice User level ledger. Valid range is 1..5, with 5 as the highest level.
    mapping(address => uint8) private _userLevels;

    /// @notice Minimum principal eligible for Reward lock accounting:
    ///      1000 USDC with 6 decimals.
    uint256 private constant _MIN_ELIGIBLE_PRINCIPAL = 1_000e6;
    /// @notice Earn-side baseline Easy per order (18 decimals).
    uint256 private constant _BASE_LOCK_EASY = 1e18;

    /// @notice Aggregated locked Easy per user. This is virtual lock state, not minted token balance.
    mapping(address => uint256) private _lockedEasy;

    /*━━━━━━━━━━━━━━━ Order-Scoped Lock State ━━━━━━━━━━━━━━━*/

    /// @dev Locked Easy amount per orderId. Zero means unlocked, missing, or already processed.
    mapping(uint256 => uint256) private _lockedEasyByOrderId;
    /// @dev Borrower recorded for each orderId to enforce consistency on repayment callbacks.
    mapping(uint256 => address) private _lockedUserByOrderId;
    /// @dev Maturity recorded for each orderId for auditing and repayment classification.
    mapping(uint256 => uint256) private _lockedMaturityByOrderId;
    /// @notice DEPRECATED storage slot retained for upgrade safety.
    /// @dev Early repayment is intentionally non-penalized in the current design.
    uint256 private _deprecatedEarlyPenaltyBps;
    /// @notice Late repayment penalty in BPS.
    uint256 private _latePenaltyBps;
    /// @notice Liquidation or default penalty in BPS, measured against current
    ///      aggregated lockedEasy.
    uint256 private _liquidationPenaltyBps;
    /// @notice Count of eligible loans where principal meets the minimum threshold.
    mapping(address => uint256) private _eligibleLoanCount;
    /// @notice Count of on-time full repayments.
    mapping(address => uint256) private _onTimeRepayCount;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/

    /// @notice Emitted when a user's Reward level changes.
    /// @dev updatedBy is either RewardManager governance or this contract during automatic level upgrades.
    event UserLevelUpdated(
        bytes32 indexed actionKey,
        address indexed user,
        uint8 oldLevel,
        uint8 newLevel,
        address indexed updatedBy,
        uint256 blockNumber
    );

    /// @notice Emitted when a penalty deduction is recorded.
    /// @dev remainingDebt is reported for compatibility with older
    ///      integrations even though the active debt ledger lives in
    ///      RewardAccrualManager.
    event PenaltyEasyDeducted(
        bytes32 indexed actionKey,
        address indexed user,
        uint256 easyAmount,
        uint256 remainingDebt,
        address indexed deductedBy,
        uint256 blockNumber
    );

    /// @notice Emitted when the liquidation penalty rate changes.
    event LiquidationPenaltyBpsUpdated(
        uint256 oldLiquidationPenaltyBps,
        uint256 newLiquidationPenaltyBps,
        uint256 blockNumber
    );

    /**
     * @notice Initializes the module.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (see {ZeroAddress})
     *      - initialRegistryAddr is not a contract (see {NotAContract})
     *
     * Security:
     * - One-time initializer.
     * - Sets default penalty policy aligned with the current Reward usage guide.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _registryAddr = initialRegistryAddr;
        // Align defaults with the Reward usage guide: no early penalty,
        // 5% late penalty, and 5% liquidation penalty.
        _deprecatedEarlyPenaltyBps = 0;
        _latePenaltyBps = 500;
        _liquidationPenaltyBps = 500;

        // RMCore deliberately does not emit ActionExecuted to avoid duplicating gateway and governance semantics.
    }

    /*━━━━━━━━━━━━━━━ Public Entries ━━━━━━━━━━━━━━━*/

    /**
     * @notice Processes one order-level borrow or full-repayment event.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_RM, KEY_REWARD_ACCRUAL_MANAGER,
     *        or other required downstream modules
     *      - caller is not Registry[KEY_RM]
     *        (see {RewardManagerCore__UseRewardManagerEntry})
     *      - repayment callback user does not match the stored order owner (see {InvalidCaller})
     *
     * Security:
     * - Non-reentrant entry restricted to RewardManager.
     * - Best-effort reads of EarnConfig and LoanFlowView MUST NOT break the
     *   main ledger path.
     * - Unknown outcomes are ignored deliberately for backward compatibility.
     *
     * @param user Borrower account.
     * @param orderId Order identifier.
     * @param amount Principal amount in the loan asset base units.
     * @param maturity Order maturity block (`maturityBlock`, block-based SSOT).
     * @param outcome Outcome code: 0=Borrow, 1=RepayOnTimeFull, 2=RepayEarlyFull, 3=RepayLateFull.
     */
    function onLoanEventByOrder(
        address user,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        uint8 outcome
    ) external onlyValidRegistry nonReentrant {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_RM
        );
        if (msg.sender != rewardManager) {
            revert RewardManagerCore__UseRewardManagerEntry();
        }

        // Observe activity from LoanFlowView only; RMCore does not re-derive cross-asset value locally.
        _updateUserActivity(user, amount);

        // Borrow: lock Easy for this order using order-scoped state.
        if (outcome == 0) {
            if (_lockedEasyByOrderId[orderId] != 0) {
                // Idempotent duplicate callback for the same order.
                return;
            }
            // Principal below the threshold is not eligible for Reward lock accounting.
            if (amount < _MIN_ELIGIBLE_PRINCIPAL) {
                return;
            }
            uint8 level = _userLevels[user];
            if (level < 1) level = 1;

            // Read earn-config params best-effort; never revert the main path.
            (
                uint256 levelMultiplierBps,
                uint256 dynThresholdEasy,
                uint256 dynMultiplierBps
            ) = _readEarnConfigBestEffort(level);

            // lockedEasy = BASE_EASY * levelMultiplierBps / 10000
            uint256 easyAmount = (_BASE_LOCK_EASY * levelMultiplierBps) / 10000;
            if (easyAmount == 0) {
                // Defensive fallback: keep baseline semantics.
                easyAmount = _BASE_LOCK_EASY;
            }

            // Optional dynamic reward:
            // if enabled (bps>0) and easyAmount >= threshold => easyAmount += easyAmount*bps/10000
            if (
                dynMultiplierBps != 0 &&
                dynThresholdEasy != 0 &&
                easyAmount >= dynThresholdEasy
            ) {
                easyAmount += (easyAmount * dynMultiplierBps) / 10000;
            }

            _eligibleLoanCount[user] += 1;
            _lockedEasy[user] += easyAmount;

            _lockedEasyByOrderId[orderId] = easyAmount;
            _lockedUserByOrderId[orderId] = user;
            _lockedMaturityByOrderId[orderId] = maturity;
            _tryPushEarnState(
                user,
                _lockedEasy[user],
                _eligibleLoanCount[user],
                _onTimeRepayCount[user]
            );
            return;
        }

        // Repay: missing or already-cleared order locks are ignored idempotently.
        uint256 locked = _lockedEasyByOrderId[orderId];
        if (locked == 0) {
            return;
        }
        address lockedUser = _lockedUserByOrderId[orderId];
        if (lockedUser != user) revert InvalidCaller();

        // Clear order-scoped lock state before downstream effects to prevent replay.
        delete _lockedEasyByOrderId[orderId];
        delete _lockedUserByOrderId[orderId];
        delete _lockedMaturityByOrderId[orderId];

        // Mirror the unlock into the aggregated user lock ledger for backward compatibility.
        if (_lockedEasy[user] >= locked) {
            _lockedEasy[user] -= locked;
        } else {
            _lockedEasy[user] = 0;
        }

        // outcome == 1: on-time full repayment unlocks and offsets pending debt before minting.
        if (outcome == 1) {
            // Unified offset via RewardAccrualManager (best-effort).
            try
                _getRewardAccrualManager().offsetPenaltyOnReward(
                    user,
                    locked,
                    "PenaltyOffsetOnUnlock"
                )
            {
                uint256 noop = 0;
                noop;
            } catch {
                uint256 ignoredUnlockOffset = locked;
                ignoredUnlockOffset;
            }

            // NOTE: Token minting is handled by EasyEmissionController per WhitePaper.
            // We keep only the ledger offset + observability pushes here.
            _onTimeRepayCount[user] += 1;
            _tryPushEarnState(
                user,
                _lockedEasy[user],
                _eligibleLoanCount[user],
                _onTimeRepayCount[user]
            );
            return;
        }

        // outcome == 2: early full repayment neither mints nor penalizes; the lock is simply voided.
        if (outcome == 2) {
            _tryPushEarnState(
                user,
                _lockedEasy[user],
                _eligibleLoanCount[user],
                _onTimeRepayCount[user]
            );
            return;
        }

        // outcome == 3: late full repayment does not mint and applies late
        // penalty, recording debt if burn is unavailable.
        if (outcome == 3) {
            uint256 bps = _latePenaltyBps;
            if (bps == 0) {
                return;
            }
            uint256 penalty = (locked * bps) / 10000;
            if (penalty == 0) {
                return;
            }
            // Best-effort: do not revert main path on accrual failure.
            try
                _getRewardAccrualManager().applyLateRepayPenalty(
                    user,
                    penalty,
                    msg.sender
                )
            {
                uint256 noop = 0;
                noop;
            } catch {
                uint256 ignoredLatePenalty = penalty;
                ignoredLatePenalty;
            }
            _tryPushEarnState(
                user,
                _lockedEasy[user],
                _eligibleLoanCount[user],
                _onTimeRepayCount[user]
            );
            return;
        }

        // Unknown outcome is ignored deliberately for backward compatibility.
    }

    /**
     * @notice Updates the late-repayment penalty rate.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_RM
     *      - caller is not Registry[KEY_RM] (see {MissingRole})
     *
     * Security:
     * - RewardManager-only governance entry.
     *
     * @param lateBps Late repayment penalty in BPS.
     */
    function setLatePenaltyBps(uint256 lateBps) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_RM
        );
        if (msg.sender != rewardManager) revert MissingRole();
        _latePenaltyBps = lateBps;
    }

    /**
     * @notice Updates the liquidation penalty rate.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_RM
     *      - caller is not Registry[KEY_RM] (see {MissingRole})
     *
     * Security:
     * - RewardManager-only governance entry.
     *
     * @param liquidationBps Liquidation penalty in BPS.
     */
    function setLiquidationPenaltyBps(
        uint256 liquidationBps
    ) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_RM
        );
        if (msg.sender != rewardManager) revert MissingRole();
        uint256 oldLiquidationPenaltyBps = _liquidationPenaltyBps;
        _liquidationPenaltyBps = liquidationBps;
        emit LiquidationPenaltyBpsUpdated(
            oldLiquidationPenaltyBps,
            liquidationBps,
            block.number
        );
    }

    /**
     * @notice Quotes the liquidation penalty based on current aggregated lockedEasy.
     * @dev Reverts if Registry validation fails in {onlyValidRegistry}.
     *
     * Security:
     * - View-only helper.
     *
     * @param user Account to quote.
     * @return easyAmount Quoted Easy penalty amount, in 18 decimals.
     */
    function quoteLiquidationPenalty(
        address user
    ) external view onlyValidRegistry returns (uint256 easyAmount) {
        uint256 bps = _liquidationPenaltyBps;
        uint256 lockedEasy = _lockedEasy[user];
        if (bps == 0 || lockedEasy == 0) {
            return 0;
        }
        return (lockedEasy * bps) / 10000;
    }

    /**
     * @notice Applies the liquidation penalty against the user's current aggregated lockedEasy.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_RM or KEY_REWARD_ACCRUAL_MANAGER
     *      - caller is not Registry[KEY_RM] (see {MissingRole})
     *      - downstream {IRewardAccrualManager.applyPenaltyFromGateway} reverts
     *
     * Security:
     * - Non-reentrant entry restricted to RewardManager.
     * - executor is forwarded downstream and MUST already be validated as the
     *   canonical liquidation executor.
     *
     * @param user Penalized account.
     * @param executor Real liquidation executor, expected to be the current GFM.
     * @return easyAmount Actual Easy penalty applied, in 18 decimals.
     */
    function applyLiquidationPenaltyByCurrentLock(
        address user,
        address executor
    ) external onlyValidRegistry nonReentrant returns (uint256 easyAmount) {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_RM
        );
        if (msg.sender != rewardManager) revert MissingRole();

        uint256 bps = _liquidationPenaltyBps;
        uint256 lockedEasy = _lockedEasy[user];
        if (bps == 0 || lockedEasy == 0) {
            return 0;
        }

        easyAmount = (lockedEasy * bps) / 10000;
        if (easyAmount == 0) {
            return 0;
        }

        _getRewardAccrualManager().applyPenaltyFromGateway(
            user,
            easyAmount,
            executor
        );
    }

    /*━━━━━━━━━━━━━━━ RewardView Observability Pushes ━━━━━━━━━━━━━━━*/

    /// @notice Best-effort push: dynamic reward params (governance observability) into RewardView cache.
    /// @dev Only RewardManager can call; push failures do not revert (RewardModuleBase emits RewardViewPushFailed).
    function pushDynamicRewardParamsToView(
        uint256 thresholdEasy,
        uint256 multiplierBps
    ) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_RM
        );
        if (msg.sender != rewardManager) {
            revert RewardManagerCore__UseRewardManagerEntry();
        }
        _tryPushDynamicRewardParams(thresholdEasy, multiplierBps, block.number);
    }

    /// @notice Best-effort push: level multiplier (governance observability) into RewardView cache.
    /// @dev Only RewardManager can call; push failures do not revert (RewardModuleBase emits RewardViewPushFailed).
    function pushLevelMultiplierToView(
        uint8 level,
        uint256 multiplierBps
    ) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_RM
        );
        if (msg.sender != rewardManager) {
            revert RewardManagerCore__UseRewardManagerEntry();
        }
        _tryPushLevelMultiplier(level, multiplierBps, block.number);
    }

    /**
     * @notice Updates a user's Reward level.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_RM
     *      - caller is not Registry[KEY_RM] (see {MissingRole})
     *      - newLevel is outside 1..5 (see {InvalidCaller})
     *
     * Security:
     * - RewardManager-only governance write.
     * - Mirrors the updated level into RewardView best-effort.
     *
     * @param user Account whose level is updated.
     * @param newLevel New level in the inclusive range 1..5.
     */
    function updateUserLevel(
        address user,
        uint8 newLevel
    ) external onlyValidRegistry {
        // Only RewardManager may write user levels through this core contract.
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_RM
        );
        if (msg.sender != rewardManager) {
            revert MissingRole();
        }

        if (newLevel < 1 || newLevel > 5) revert InvalidCaller();

        uint8 oldLevel = _userLevels[user];
        _userLevels[user] = newLevel;

        emit UserLevelUpdated(
            ActionKeys.ACTION_SET_PARAMETER,
            user,
            oldLevel,
            newLevel,
            msg.sender,
            block.number
        );

        // Best-effort: mirror level into RewardView (external reads must use RewardView).
        _tryPushUserLevel(user, newLevel);
    }

    /**
     * @notice Protocol-enforced read: returns canonical user level for long-term borrow admission.
     * @dev Reverts if:
     *      - Registry validation fails in {onlyValidRegistry}
     *      - Registry missing KEY_ORDER_ENGINE
     *      - caller is not Registry[KEY_ORDER_ENGINE] (see {MissingRole})
     *
     * Security:
     * - Reads canonical level from RewardManagerCore storage, not RewardView mirror cache.
     * - Role-gated to OrderEngine only; not a frontend/off-chain read surface.
     *
     * @param user Target user address.
     * @return level Canonical level in RewardManagerCore storage.
     */
    function getUserLevelForBorrowCheck(
        address user
    ) external view onlyValidRegistry returns (uint8 level) {
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ORDER_ENGINE
        );
        if (msg.sender != orderEngine) revert MissingRole();
        return _userLevels[user];
    }

    /*━━━━━━━━━━━━━━━ Internal Helpers ━━━━━━━━━━━━━━━*/

    function _getRewardAccrualManager()
        internal
        view
        returns (IRewardAccrualManager)
    {
        return
            IRewardAccrualManager(
                Registry(_registryAddr).getModuleOrRevert(
                    ModuleKeys.KEY_REWARD_ACCRUAL_MANAGER
                )
            );
    }

    /// @dev Best-effort: observe protocol flow in the shared 18-decimal valuation unit and auto-upgrade level.
    function _updateUserActivity(address user, uint256 /* amount */) internal {
        // SSOT boundary:
        // - Protocol borrow statistics MUST come from LoanFlowView (shared 18-decimal valuation unit).
        // - RewardManagerCore may read those values for gating/level logic,
        //   without attempting to re-derive cross-asset value locally.
        (
            bool ok,
            uint256 borrowCount,
            uint256 borrowVolumeValue
        ) = _readBorrowFlowValueBestEffort(user);
        if (!ok) {
            // Deliberately do NOT fabricate protocol flow stats inside RMCore.
            // If LoanFlowView is unavailable/invalid, activity totals remain unchanged.
            // (OrderEngine -> LoanFlowPushManager is the SSOT pipeline for these fields.)
            return;
        }

        borrowCount; // silence unused-variable warning (kept for potential future rule changes)
        _autoUpgradeUserLevelFromLoanFlowValue(user, borrowVolumeValue);
    }

    /// @dev Best-effort read: EarnConfig parameters.
    ///      IMPORTANT: Reward is post-ledger; do NOT let missing/misconfigured configs break the main path.
    function _readEarnConfigBestEffort(
        uint8 level
    )
        internal
        view
        returns (
            uint256 levelMultiplierBps,
            uint256 dynThresholdEasy,
            uint256 dynMultiplierBps
        )
    {
        // Defaults: 1x multiplier, dynamic disabled.
        levelMultiplierBps = 10000;
        dynThresholdEasy = 0;
        dynMultiplierBps = 0;

        address earnCfg = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_REWARD_EARN_CONFIG
        );
        if (earnCfg == address(0) || earnCfg.code.length == 0) {
            return (levelMultiplierBps, dynThresholdEasy, dynMultiplierBps);
        }

        // Dynamic params.
        try IEarnConfigRewardRead(earnCfg).getDynamicRewardParams() returns (
            uint256 thresholdEasy,
            uint256 multiplierBps,
            uint256 /* updateBlock */
        ) {
            dynThresholdEasy = thresholdEasy;
            // Safety cap (defense-in-depth); EarnConfig already caps at 100000.
            if (multiplierBps <= 100000) dynMultiplierBps = multiplierBps;
        } catch {
            uint256 ignoredDynamicMultiplier = dynMultiplierBps;
            ignoredDynamicMultiplier;
        }

        // Level multiplier.
        try
            IEarnConfigRewardRead(earnCfg).getLevelMultiplierBps(level)
        returns (uint256 bps) {
            if (bps != 0 && bps <= 100000) levelMultiplierBps = bps;
        } catch {
            uint256 ignoredLevelMultiplier = levelMultiplierBps;
            ignoredLevelMultiplier;
        }
    }

    /// @dev Best-effort auto-upgrades a user level from LoanFlowView
    ///      SSOT metrics.
    function _autoUpgradeUserLevelFromLoanFlowValue(
        address user,
        uint256 borrowVolumeValue
    ) internal {
        uint8 currentLevel = _userLevels[user];
        uint256 eligibleLoans = _eligibleLoanCount[user];
        uint256 onTimeCount = _onTimeRepayCount[user];
        uint8 newLevel = currentLevel;
        // Thresholds are in the shared 18-decimal valuation unit: 10k/50k/100k/500k USD.
        if (
            borrowVolumeValue >= 10000 * 1e18 &&
            eligibleLoans >= 3 &&
            onTimeCount >= 1 &&
            currentLevel < 2
        ) {
            newLevel = 2;
        } else if (
            borrowVolumeValue >= 50000 * 1e18 &&
            eligibleLoans >= 10 &&
            onTimeCount >= 5 &&
            currentLevel < 3
        ) {
            newLevel = 3;
        } else if (
            borrowVolumeValue >= 100000 * 1e18 &&
            eligibleLoans >= 20 &&
            onTimeCount >= 10 &&
            currentLevel < 4
        ) {
            newLevel = 4;
        } else if (
            borrowVolumeValue >= 500000 * 1e18 &&
            eligibleLoans >= 50 &&
            onTimeCount >= 30 &&
            currentLevel < 5
        ) {
            newLevel = 5;
        }
        if (newLevel != currentLevel) {
            _userLevels[user] = newLevel;
            emit UserLevelUpdated(
                ActionKeys.ACTION_SET_PARAMETER,
                user,
                currentLevel,
                newLevel,
                address(this),
                block.number
            );
            _tryPushUserLevel(user, newLevel);
        }
    }

    /// @dev Best-effort read: borrow-only protocol flow from LoanFlowView in the shared 18-decimal valuation unit.
    function _readBorrowFlowValueBestEffort(
        address user
    )
        internal
        view
        returns (bool ok, uint256 borrowCount, uint256 borrowVolumeValue)
    {
        address viewAddr;
        try
            Registry(_registryAddr).getModule(ModuleKeys.KEY_LOAN_FLOW_VIEW)
        returns (address a) {
            viewAddr = a;
        } catch {
            return (false, 0, 0);
        }
        if (viewAddr == address(0) || viewAddr.code.length == 0)
            return (false, 0, 0);

        try
            ILoanFlowViewRewardRead(viewAddr).getUserBorrowFlowForReward(user)
        returns (
            uint256 volumeValue,
            uint256 cnt,
            bool isValid,
            uint256 /* blockNumber */
        ) {
            if (!isValid) return (false, 0, 0);
            return (true, cnt, volumeValue);
        } catch {
            return (false, 0, 0);
        }
    }

    // NOTE: dynamic reward parameters are governance-controlled and consumed internally.
    // Any external observability must be provided via RewardView (push-based) if needed.

    /// @dev Reverts if caller lacks ACTION_UPGRADE_MODULE or newImplementation is zero (see {ZeroAddress}).
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /*━━━━━━━━━━━━━━━ RewardModuleBase ━━━━━━━━━━━━━━━*/
    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    uint256[49] private __gap;
}

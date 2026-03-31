// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICollateralManager} from "../interfaces/ICollateralManager.sol";
import {IGuaranteeFundManager} from "../interfaces/IGuaranteeFundManager.sol";
import {SystemEvents} from "../Vault/SystemEvents.sol";
import {IStatisticsViewGuaranteeMinimal} from "../interfaces/IStatisticsViewGuaranteeMinimal.sol";
import {
    ExternalModuleRevertedRaw,
    AmountIsZero,
    InvalidAmounts,
    ZeroAddress,
    BatchTooLarge
} from "../errors/StandardErrors.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {GracefulDegradation} from "./GracefulDegradation.sol";
import {Registry} from "../registry/Registry.sol";

interface IStatisticsPushManagerMinimal {
    function notifyUserStats(address user) external;
}

/// @title VaultBusinessLogicLibrary
/// @notice Business-logic helpers for VaultBusinessLogic shared routines.
/// @dev Extracts common try/catch wrappers, batch operations, event emission, and graceful degradation helpers.
/// @custom:security-contact security@example.com
library VaultBusinessLogicLibrary {
    using SafeERC20 for IERC20;
    using GracefulDegradation for *;

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    uint256 private constant MAX_BATCH_SIZE = 50;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /// @notice Business operation event.
    /// @param operation Operation label.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Amount.
    event BusinessOperation(
        string indexed operation,
        address indexed user,
        address indexed asset,
        uint256 amount
    );

    // Deprecated: rewards are handled in LendingEngine/RewardManager after ledger updates.

    /// @notice Graceful degradation event.
    /// @param asset Asset address.
    /// @param reason Degradation reason.
    /// @param fallbackValue Fallback value used.
    /// @param usedFallback Whether fallback strategy was used.
    event VaultBusinessLogicGracefulDegradation(
        address indexed asset,
        string reason,
        uint256 fallbackValue,
        bool usedFallback
    );

    /// @notice Health factor check event.
    /// @param user User address.
    /// @param healthFactor Health factor.
    /// @param isHealthy Whether healthy.
    event HealthFactorCheck(
        address indexed user,
        uint256 healthFactor,
        bool isHealthy
    );

    /**
     * @notice Canonical cache/view push failure event (with context) for offchain retry/audit.
     * @dev This mirrors `src/Vault/CacheEvents.sol` (SSOT). Libraries cannot inherit interfaces, so we mirror the
     *      signature here to allow emitting the same event from calling contracts.
     */
    event CacheUpdateFailedWithContext(
        address indexed user,
        address indexed asset,
        bytes32 indexed requestId,
        address viewAddr,
        uint256 collateral,
        uint256 debt,
        bytes reason,
        uint64 seq,
        uint64 nextVersion
    );

    /*━━━━━━━━━━━━━━━ Safe Call Helpers ━━━━━━━━━━━━━━━*/

    /**
     * @notice Calculate expected interest (annual bps + term days).
     * @dev Pure computation; unchecked for gas efficiency.
     *
     * @param principal Principal amount.
     * @param annualRateBps Annual rate in bps (10_000 = 100%).
     * @param termDays Term length (days).
     * @return interest Expected interest.
     */
    function calculateExpectedInterest(
        uint256 principal,
        uint256 annualRateBps,
        uint16 termDays
    ) internal pure returns (uint256 interest) {
        unchecked {
            // interest = principal * annualRateBps/1e4 * termDays/365
            interest =
                (principal * annualRateBps * uint256(termDays)) / (365 * 1e4);
        }
    }

    /**
     * @notice Gas-optimized guarantee lock (no try/catch).
     * @dev Caller must ensure parameter validity and permissions.
     */
    function lockGuaranteeFast(
        address guaranteeManager,
        address user,
        address asset,
        uint256 amount
    ) internal {
        IGuaranteeFundManager(guaranteeManager).lockGuarantee(
            user,
            asset,
            amount
        );
    }

    /**
     * @notice Safely call CollateralManager.depositCollateral.
     * @param collateralManager CollateralManager address.
     * @param user User address.
     * @param asset Asset address.
     * @param amount Deposit amount.
     */
    function safeDepositCollateral(
        address collateralManager,
        address user,
        address asset,
        uint256 amount
    ) internal {
        try
            ICollateralManager(collateralManager).depositCollateral(
                user,
                asset,
                amount
            )
        {
            uint256 noop = 0;
            noop;
        } catch (bytes memory lowLevelData) {
            emit SystemEvents.ExternalModuleReverted(
                "CollateralManager",
                lowLevelData,
                block.number
            );
            revert ExternalModuleRevertedRaw("CollateralManager", lowLevelData);
        }
    }

    /**
     * @notice Safely call CollateralManager.withdrawCollateral.
     * @param collateralManager CollateralManager address.
     * @param user User address.
     * @param asset Asset address.
     * @param amount Withdraw amount.
     */
    function safeWithdrawCollateral(
        address collateralManager,
        address user,
        address asset,
        uint256 amount
    ) internal {
        try
            ICollateralManager(collateralManager).withdrawCollateral(
                user,
                asset,
                amount
            )
        {
            uint256 noop = 0;
            noop;
        } catch (bytes memory lowLevelData) {
            emit SystemEvents.ExternalModuleReverted(
                "CollateralManager",
                lowLevelData,
                block.number
            );
            revert ExternalModuleRevertedRaw("CollateralManager", lowLevelData);
        }
    }

    // Removed: legacy ledger write paths (safeRecordBorrow/safeRepay).

    /**
     * @notice Safely notify the single Statistics push orchestrator.
     * @dev The legacy direct `StatisticsView.pushUserStatsUpdate(...)` delta path is intentionally retired here.
     *      Batch flows must route through `StatisticsPushManager -> StatisticsView.pushUserStatsSnapshot(...)`
     *      so localhost and production share the same authoritative USD-8 semantics.
     * @param registryAddr Registry address used to resolve `KEY_STATS_PUSH_MANAGER`.
     * @param statsView StatisticsView address, kept for failure-event context.
     * @param user User address.
     */
    function safeUpdateStats(
        address registryAddr,
        address statsView,
        address user
    ) internal {
        if (registryAddr == address(0) || registryAddr.code.length == 0) {
            emit CacheUpdateFailedWithContext(
                user,
                address(0),
                bytes32(0),
                statsView,
                0,
                0,
                abi.encode("registry unavailable"),
                0,
                0
            );
            return;
        }

        address statsPushManager = Registry(registryAddr).getModule(
            ModuleKeys.KEY_STATS_PUSH_MANAGER
        );
        if (
            statsPushManager == address(0) ||
            statsPushManager.code.length == 0
        ) {
            emit CacheUpdateFailedWithContext(
                user,
                address(0),
                bytes32(0),
                statsView,
                0,
                0,
                abi.encode("statsPushManager missing"),
                0,
                0
            );
            return;
        }

        try
            IStatisticsPushManagerMinimal(statsPushManager).notifyUserStats(
                user
            )
        {
            uint256 noop = 0;
            noop;
        } catch (bytes memory lowLevelData) {
            emit SystemEvents.ExternalModuleReverted(
                "StatisticsPushManager",
                lowLevelData,
                block.number
            );
            emit CacheUpdateFailedWithContext(
                user,
                address(0), // user-scoped stats push
                bytes32(0), // manager generates requestId/seq/version internally
                statsView,
                0,
                0,
                lowLevelData,
                0,
                0
            );
        }
    }

    /// @notice Safely push guarantee updates to StatisticsView.
    function safeUpdateGuarantee(
        address statsView,
        address user,
        address asset,
        uint256 amount,
        bool isLocked
    ) internal {
        if (statsView == address(0)) return;
        try
            IStatisticsViewGuaranteeMinimal(statsView).pushGuaranteeUpdate(
                user,
                asset,
                amount,
                isLocked
            )
        {
            uint256 noop = 0;
            noop;
        } catch (bytes memory lowLevelData) {
            emit SystemEvents.ExternalModuleReverted(
                "StatisticsView",
                lowLevelData,
                block.number
            );
            emit CacheUpdateFailedWithContext(
                user,
                asset,
                bytes32(0), // no requestId context in legacy path
                statsView,
                amount,
                0,
                abi.encode(isLocked, lowLevelData),
                0,
                0
            );
            // Best-effort: do not revert primary flow.
        }
    }

    /**
     * @notice Safely call GuaranteeFundManager.lockGuarantee.
     * @param guaranteeManager GuaranteeFundManager address.
     * @param user User address.
     * @param asset Asset address.
     * @param amount Guarantee amount.
     */
    function safeLockGuarantee(
        address guaranteeManager,
        address user,
        address asset,
        uint256 amount
    ) internal {
        try
            IGuaranteeFundManager(guaranteeManager).lockGuarantee(
                user,
                asset,
                amount
            )
        {
            uint256 noop = 0;
            noop;
        } catch (bytes memory lowLevelData) {
            emit SystemEvents.ExternalModuleReverted(
                "GuaranteeFundManager",
                lowLevelData,
                block.number
            );
            revert ExternalModuleRevertedRaw(
                "GuaranteeFundManager",
                lowLevelData
            );
        }
    }

    /**
     * @notice Safely call GuaranteeFundManager.releaseGuarantee.
     * @param guaranteeManager GuaranteeFundManager address.
     * @param user User address.
     * @param asset Asset address.
     * @param amount Release amount.
     */
    function safeReleaseGuarantee(
        address guaranteeManager,
        address user,
        address asset,
        uint256 amount
    ) internal {
        try
            IGuaranteeFundManager(guaranteeManager).releaseGuarantee(
                user,
                asset,
                amount
            )
        {
            uint256 noop = 0;
            noop;
        } catch (bytes memory lowLevelData) {
            emit SystemEvents.ExternalModuleReverted(
                "GuaranteeFundManager",
                lowLevelData,
                block.number
            );
            revert ExternalModuleRevertedRaw(
                "GuaranteeFundManager",
                lowLevelData
            );
        }
    }

    // Rewards are handled after ledger updates in LendingEngine.

    /*━━━━━━━━━━━━━━━ Batch Operations ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate batch parameters.
     * @param assets Asset list.
     * @param amounts Amount list.
     */
    function validateBatchParams(
        address[] calldata assets,
        uint256[] calldata amounts
    ) internal pure {
        if (assets.length != amounts.length) revert InvalidAmounts();
        if (assets.length == 0) revert AmountIsZero();
        if (assets.length > MAX_BATCH_SIZE) {
            revert BatchTooLarge(assets.length, MAX_BATCH_SIZE);
        }
    }

    /**
     * @notice Batch deposit single operation (internal).
     * @dev Processes one batch item by transferring collateral, depositing it, locking guarantee, and pushing stats.
     *      Reverts if `amount` is zero or `asset` is zero; downstream helper calls may also revert.
     *
     * Security:
     * - Internal helper intended for caller-controlled batch loops
     * - Performs token transfer + external module calls
     *
     * @param user User address.
     * @param asset Asset address.
     * @param amount Amount.
     * @param collateralManager CollateralManager address.
     * @param guaranteeManager GuaranteeFundManager address.
     * @param vaultStatistics StatisticsView address.
     * @param settlementTokenAddr Deprecated; kept for signature compatibility.
     */
    function batchDepositSingle(
        address user,
        address asset,
        uint256 amount,
        address registryAddr,
        address collateralManager,
        address guaranteeManager,
        address vaultStatistics,
        address settlementTokenAddr
    ) internal {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();

        // Price/health checks are handled in LE + View; not in batch logic.
        settlementTokenAddr; // silence unused (compat).

        // Transfer tokens into this contract.
        IERC20(asset).safeTransferFrom(user, address(this), amount);

        // Deposit collateral.
        safeDepositCollateral(collateralManager, user, asset, amount);

        // Lock guarantee (if needed).
        safeLockGuarantee(guaranteeManager, user, asset, amount);
        // Sync guarantee aggregation.
        safeUpdateGuarantee(vaultStatistics, user, asset, amount, true);

        // Update stats.
        safeUpdateStats(registryAddr, vaultStatistics, user);

        emit BusinessOperation("deposit", user, asset, amount);
    }

    /**
      * @notice Batch borrow single operation (internal).
      * @dev Pulls liquidity to this contract and forwards it to the user.
      *      Debt-ledger post-write stats refresh is owned by VaultLendingEngine,
      *      so this helper must not duplicate that responsibility.
     *      Reverts if `amount` is zero or `asset` is zero; downstream helper calls may also revert.
     *
     * Security:
     * - Internal helper intended for caller-controlled batch loops
     * - Performs token transfer + external module calls
     *
     * @param user User address.
     * @param asset Asset address.
     * @param amount Amount.
     * @param _lendingEngine Deprecated; kept for signature compatibility.
     * @param vaultStatistics StatisticsView address.
     * @param _settlementTokenAddr Deprecated; kept for signature compatibility.
     */
    function batchBorrowSingle(
        address user,
        address asset,
        uint256 amount,
        address registryAddr,
        address _lendingEngine,
        address vaultStatistics,
        address _settlementTokenAddr
    ) internal {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();

        // Price/health checks are handled in LE + View.

        // Ledger updates flow through VaultCore → LE; no direct LE calls here.
        // Debt-side stats refresh also belongs to LE after the ledger write.
        registryAddr;
        vaultStatistics;
        _lendingEngine;
        _settlementTokenAddr; // silence unused (compat).

        // Transfer tokens to user.
        IERC20(asset).safeTransfer(user, amount);

        emit BusinessOperation("borrow", user, asset, amount);
    }

    /**
      * @notice Batch repay single operation (internal).
      * @dev Pulls repayment funds from the user and hands off ledger settlement.
      *      Debt-ledger post-write stats refresh is owned by VaultLendingEngine,
      *      so this helper must not duplicate that responsibility.
     *      Reverts if `amount` is zero or `asset` is zero; downstream helper calls may also revert.
     *
     * Security:
     * - Internal helper intended for caller-controlled batch loops
     * - Performs token transfer + external module calls
     *
     * @param user User address.
     * @param asset Asset address.
     * @param amount Amount.
     * @param _lendingEngine Deprecated; kept for signature compatibility.
     * @param vaultStatistics StatisticsView address.
     * @param _settlementTokenAddr Deprecated; kept for signature compatibility.
     */
    function batchRepaySingle(
        address user,
        address asset,
        uint256 amount,
        address registryAddr,
        address _lendingEngine,
        address vaultStatistics,
        address _settlementTokenAddr
    ) internal {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();

        // Price/health checks are handled in LE + View.

        // Transfer tokens into this contract.
        IERC20(asset).safeTransferFrom(user, address(this), amount);

        // Ledger updates flow through VaultCore → LE; no direct LE calls here.
        // Debt-side stats refresh also belongs to LE after the ledger write.
        registryAddr;
        vaultStatistics;
        _lendingEngine;
        _settlementTokenAddr; // silence unused (compat).

        emit BusinessOperation("repay", user, asset, amount);
    }

    /**
     * @notice Batch withdraw single operation (internal).
     * @dev Releases guarantee, withdraws collateral, transfers assets to the user, and updates stats.
     *      Reverts if `amount` is zero or `asset` is zero; downstream helper calls may also revert.
     *
     * Security:
     * - Internal helper intended for caller-controlled batch loops
     * - Performs token transfer + external module calls
     *
     * @param user User address.
     * @param asset Asset address.
     * @param amount Amount.
     * @param collateralManager CollateralManager address.
     * @param guaranteeManager GuaranteeFundManager address.
     * @param vaultStatistics StatisticsView address.
     * @param _settlementTokenAddr Deprecated; kept for signature compatibility.
     */
    function batchWithdrawSingle(
        address user,
        address asset,
        uint256 amount,
        address registryAddr,
        address collateralManager,
        address guaranteeManager,
        address vaultStatistics,
        address /*rewardManager*/,
        address _settlementTokenAddr
    ) internal {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();

        // Price/health checks are handled in LE + View.

        // Withdraw collateral.
        _settlementTokenAddr; // silence unused (compat).
        safeWithdrawCollateral(collateralManager, user, asset, amount);

        // Release guarantee (if needed).
        safeReleaseGuarantee(guaranteeManager, user, asset, amount);
        // Sync guarantee aggregation.
        safeUpdateGuarantee(vaultStatistics, user, asset, amount, false);

        // Transfer tokens to user.
        IERC20(asset).safeTransfer(user, amount);

        // Update stats.
        safeUpdateStats(registryAddr, vaultStatistics, user);

        emit BusinessOperation("withdraw", user, asset, amount);
    }

    /*━━━━━━━━━━━━━━━ Event Emission ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emit business operation and standardized action events.
     * @param operation Operation label.
     * @param user User address.
     * @param asset Asset address.
     * @param amount Amount.
     * @param actionKey Action key.
     */
    function emitBusinessEvents(
        string memory operation,
        address user,
        address asset,
        uint256 amount,
        bytes32 actionKey
    ) internal {
        emit BusinessOperation(operation, user, asset, amount);

        emit SystemEvents.ActionExecuted(
            actionKey,
            ActionKeys.getActionKeyString(actionKey),
            msg.sender,
            block.number
        );
    }

    /*━━━━━━━━━━━━━━━ Graceful Degradation ━━━━━━━━━━━━━━━*/

    /**
     * @notice Handle graceful degradation for an asset.
     * @param asset Asset address.
     * @param reason Degradation reason.
     * @param config Degradation config.
     * @return fallbackValue Fallback value.
     */
    function _gracefulDegradation(
        address asset,
        string memory reason,
        GracefulDegradation.DegradationConfig memory config
    ) internal returns (uint256 fallbackValue) {
        // Use GracefulDegradation default strategy.
        GracefulDegradation.PriceResult memory result = GracefulDegradation
            .getAssetValueWithFallback(asset, asset, 0, config);

        if (result.usedFallback) {
            emit VaultBusinessLogicGracefulDegradation(
                asset,
                reason,
                result.value,
                true
            );
        }

        return result.value;
    }
}

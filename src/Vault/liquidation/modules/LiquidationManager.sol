// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {Registry} from "../../../registry/Registry.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {ViewConstants} from "../../view/ViewConstants.sol";

import {IAccessControlManager} from "../../../interfaces/IAccessControlManager.sol";
import {ICollateralManager} from "../../../interfaces/ICollateralManager.sol";
import {ILendingEngineDebtWrite} from "../../../interfaces/ILendingEngineDebtWrite.sol";
import {ILiquidationEventsView} from "../../../interfaces/ILiquidationEventsView.sol";
import {ILiquidationManager} from "../../../interfaces/ILiquidationManager.sol";
import {ILiquidationPayoutManager} from "../../../interfaces/ILiquidationPayoutManager.sol";
import {IFeeRouterDistribution} from "../../../interfaces/IFeeRouterDistribution.sol";
import {
    NotAContract,
    ZeroAddress,
    AmountIsZero,
    ArrayLengthMismatch,
    EmptyArray
} from "../../../errors/StandardErrors.sol";
import {CacheEvents} from "../../CacheEvents.sol";
import {FeeTypes} from "../../../constants/FeeTypes.sol";

/**
 * @title LiquidationManager
 * @notice Liquidation executor: direct ledger writes (seize collateral, reduce debt)
 * and best-effort single-point View push.
 * @dev Security:
 * - UUPSUpgradeable: upgrades are role-gated in `_authorizeUpgrade`
 * - Pausable: `pause/unpause` can halt liquidation entrypoints
 * - Non-reentrant: `liquidate/batchLiquidate` are protected against reentrancy
 *
 * @dev Architecture alignment (Architecture-Guide):
 *      - Registry module key: ModuleKeys.KEY_LIQUIDATION_MANAGER
 *      - Direct ledger writes: interacts only with CollateralManager/LendingEngine; writes never go through View
 *      - Residual distribution SSOT: driven by LiquidationPayoutManager governance config
 *      - View push is best-effort: failures do not revert ledger writes (off-chain retries via events)
 *      - Shared downstream executor: legacy SettlementManager and current BlocksOnlyCoordinator may both route into
 *        this module after their own upstream eligibility, authorization, and collateral-selection logic completes
 */
contract LiquidationManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationManager,
    CacheEvents
{
    /**
     * @notice Registry contract address for module resolution and access control.
     * @dev Stored privately; exposed via explicit getter `registryAddrVar()` (no public state variable).
     */
    address private _registryAddr;

    /**
     * @notice Get Registry contract address.
     * @return Registry contract address
     */
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    // NOTE: CacheUpdateFailed is declared in CacheEvents (SSOT) and is inherited here.

    /// @notice Emitted when residual-value distribution is executed.
    /// @dev Emitted after collateral distribution completes, recording actual allocation results for the liquidation.
    event PayoutExecuted(
        address indexed user,
        address indexed collateralAsset,
        address platform,
        address reserve,
        address lenderCompensation,
        address indexed liquidator,
        uint256 platformShare,
        uint256 reserveShare,
        uint256 lenderShare,
        uint256 liquidatorShare
    );

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when batch size exceeds the maximum allowed liquidation batch size. Used by {batchLiquidate}.
    error LiquidationManager__BatchTooLarge(uint256 provided, uint256 max);
    /// @dev Reverts when a SettlementManager-only entrypoint is called by any other address.
    ///      Used by settlement-manager compatibility paths.
    error LiquidationManager__OnlySettlementManager();
    /// @dev Reverts when liquidator/caller attempts to liquidate the same borrower address.
    error LiquidationManager__BorrowerCannotSelfLiquidate();
    /// @dev Reverts when a UUPS upgrade target has no deployed code. Used by {_authorizeUpgrade}.
    error LiquidationManager__InvalidImplementation();

    /**
     * @notice Constructor that disables initialization.
     * @dev Prevents direct initialization, ensures deployment via proxy pattern.
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the LiquidationManager with Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero address
     *
     * Security:
     * - Initializer guard (only callable once)
     * - UUPS upgradeable pattern
     *
     * @param initialRegistryAddr Registry contract address for module resolution and access control
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Core Direct Ledger ━━━━━━━━━━━━━━━*/

    /**
     * @notice Execute single liquidation: seize collateral, reduce debt, and distribute residual value.
     * @dev Reverts if:
     *      - targetUser, collateralAsset, or debtAsset is zero address
     *      - collateralAmount or debtAmount is zero
     *      - caller is not SettlementManager and lacks ACTION_LIQUIDATE role
     *      - contract is paused
     *      - LiquidationPayoutManager is not registered
     *      - CollateralManager.withdrawCollateralTo fails (permission/balance check in ledger)
     *      - LendingEngine.forceReduceDebt fails (permission check in ledger)
     *
     * Security:
     * - Non-reentrant
     * - When-not-paused guard
     * - Role-gated: SettlementManager or ACTION_LIQUIDATE required
     * - Direct ledger writes (bypass View layer)
     * - Best-effort View push (failures do not revert ledger writes)
     * - Shared explicit-parameter executor used after upstream orchestration has already chosen the collateral/debt
     *   slice to liquidate; this includes blocks-only coordinator paths when maturity falls into liquidation.
     *
     * - Preferred legacy keeper entry is SettlementManager.settleOrLiquidate(orderId), which derives parameters from
     *   orderId.
     * - This explicit-parameter executor remains available for tests, emergency operations, manual recovery, and
     *   product-specific upstream orchestrators such as blocks-only liquidation routing.
     *
     * @param targetUser Address of the user being liquidated
     * @param collateralAsset Address of the collateral token
     * @param debtAsset Address of the debt token
     * @param collateralAmount Amount of collateral to seize (token decimals)
     * @param debtAmount Amount of debt to reduce (token decimals)
    * @param bonus Liquidation bonus for reporting only. Writers currently treat this as a token-native
    *        collateral-side amount hint, not as a normalized value-unit field, and it does not affect ledger writes.
     */
    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external override whenNotPaused nonReentrant {
        if (
            targetUser == address(0) ||
            collateralAsset == address(0) ||
            debtAsset == address(0)
        ) {
            revert ZeroAddress();
        }
        if (collateralAmount == 0 || debtAmount == 0) revert AmountIsZero();

        _requireLiquidationCaller(msg.sender);
        _requireNotSelfLiquidation(msg.sender, targetUser);

        address cm = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_CM
        );
        address le = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LE
        );
        address payout = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER
        );
        if (payout == address(0)) revert ZeroAddress();

        // 1) Seize and distribute collateral (SSOT: LiquidationPayoutManager).
        _distributeCollateral(
            cm,
            payout,
            targetUser,
            collateralAsset,
            collateralAmount,
            msg.sender
        );

        // 2) Reduce debt (LE enforces ACTION_LIQUIDATE internally; caller is this contract).
        ILendingEngineDebtWrite(le).forceReduceDebt(
            targetUser,
            debtAsset,
            debtAmount
        );

        // 3) Best-effort View push (failures do not revert; events enable off-chain retries).
        _pushSingle(
            targetUser,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            msg.sender,
            bonus,
            payout
        );
    }

    /**
     * @notice Execute liquidation on behalf of a keeper via SettlementManager,
     * preserving the original liquidator address.
     * @dev Reverts if:
     *      - liquidator is zero address
     *      - msg.sender is not the registered SettlementManager
     *      - targetUser, collateralAsset, or debtAsset is zero address
     *      - collateralAmount or debtAmount is zero
     *      - contract is paused
     *      - LiquidationPayoutManager is not registered
     *      - CollateralManager.withdrawCollateralTo fails (permission/balance check in ledger)
     *      - LendingEngine.forceReduceDebt fails (permission check in ledger)
     *
     * Security:
     * - Non-reentrant
     * - When-not-paused guard
     * - Only SettlementManager can call this function
     * - Direct ledger writes (bypass View layer)
     * - Best-effort View push (failures do not revert ledger writes)
     * - Reserved for the legacy SettlementManager orchestration path; current blocks-only routing does not use this
     *   compatibility entry because it preserves its own dedicated coordinator as the public write boundary.
     *
     * @param liquidator Address of the liquidator (preserved from SettlementManager call)
     * @param targetUser Address of the user being liquidated
     * @param collateralAsset Address of the collateral token
     * @param debtAsset Address of the debt token
     * @param collateralAmount Amount of collateral to seize (token decimals)
     * @param debtAmount Amount of debt to reduce (token decimals)
     * @param bonus Liquidation bonus (for View/off-chain display, does not affect ledger)
     */
    function liquidateFromSettlementManager(
        address liquidator,
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external whenNotPaused nonReentrant {
        if (liquidator == address(0)) revert ZeroAddress();
        address settlementManager = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_SETTLEMENT_MANAGER
        );
        if (msg.sender != settlementManager)
            revert LiquidationManager__OnlySettlementManager();

        if (
            targetUser == address(0) ||
            collateralAsset == address(0) ||
            debtAsset == address(0)
        ) revert ZeroAddress();
        if (collateralAmount == 0 || debtAmount == 0) revert AmountIsZero();
        _requireNotSelfLiquidation(liquidator, targetUser);

        address cm = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_CM
        );
        address le = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LE
        );
        address payout = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER
        );
        if (payout == address(0)) revert ZeroAddress();

        // 1) Seize and distribute collateral (SSOT: LiquidationPayoutManager)
        // to recipients incl. `liquidator`.
        _distributeCollateral(
            cm,
            payout,
            targetUser,
            collateralAsset,
            collateralAmount,
            liquidator
        );

        // 2) Reduce debt (LE enforces ACTION_LIQUIDATE internally; caller is this contract).
        ILendingEngineDebtWrite(le).forceReduceDebt(
            targetUser,
            debtAsset,
            debtAmount
        );

        // 3) Best-effort View push (use `liquidator` for event payloads).
        _pushSingle(
            targetUser,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            liquidator,
            bonus,
            payout
        );
    }

    /**
     * @notice Execute batch liquidations: seize collateral, reduce debt,
     * and distribute residual value for multiple users.
     * @dev Reverts if:
     *      - targetUsers array is empty
     *      - array lengths mismatch (targetUsers, collateralAssets, debtAssets,
     *        collateralAmounts, debtAmounts, bonuses)
     *      - batch size exceeds ViewConstants.MAX_BATCH_SIZE
     *      - any targetUser, collateralAsset, or debtAsset is zero address
     *      - any collateralAmount or debtAmount is zero
     *      - caller is not SettlementManager and lacks ACTION_LIQUIDATE role
     *      - contract is paused
     *      - LiquidationPayoutManager is not registered
     *      - any CollateralManager.withdrawCollateralTo fails (permission/balance check in ledger)
     *      - any LendingEngine.forceReduceDebt fails (permission check in ledger)
     *
     * Security:
     * - Non-reentrant
     * - When-not-paused guard
     * - Role-gated: SettlementManager or ACTION_LIQUIDATE required
     * - Direct ledger writes (bypass View layer)
     * - Best-effort batch View push (failures do not revert ledger writes)
     * - Batch size limit enforced to prevent RPC/execution failures
     * - Batch callers remain responsible for upstream product-specific eligibility checks before invoking this shared
     *   executor.
     *
     * - Preferred legacy keeper entry is SettlementManager.settleOrLiquidate(orderId), which derives parameters from
     *   the order.
     * - This batch entry remains available for tests, emergency handling, and manual execution.
     *
     * @param targetUsers Array of addresses of users being liquidated
     * @param collateralAssets Array of collateral token addresses (one per liquidation)
     * @param debtAssets Array of debt token addresses (one per liquidation)
     * @param collateralAmounts Array of collateral amounts to seize (token decimals)
     * @param debtAmounts Array of debt amounts to reduce (token decimals)
    * @param bonuses Array of liquidation bonus reporting values. These entries are forwarded to the view/data-push
    *        layer as writer-defined reporting fields and do not affect ledger writes.
     */
    function batchLiquidate(
        address[] calldata targetUsers,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        uint256[] calldata bonuses
    ) external override whenNotPaused nonReentrant {
        uint256 len = targetUsers.length;
        if (len == 0) revert EmptyArray();
        if (
            len != collateralAssets.length ||
            len != debtAssets.length ||
            len != collateralAmounts.length ||
            len != debtAmounts.length ||
            len != bonuses.length
        ) {
            revert ArrayLengthMismatch(len, collateralAssets.length);
        }
        if (len > ViewConstants.MAX_BATCH_SIZE) {
            revert LiquidationManager__BatchTooLarge(
                len,
                ViewConstants.MAX_BATCH_SIZE
            );
        }

        _requireLiquidationCaller(msg.sender);

        address cm = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_CM
        );
        address le = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LE
        );
        address payout = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER
        );
        if (payout == address(0)) revert ZeroAddress();

        for (uint256 i = 0; i < len; ) {
            address u = targetUsers[i];
            address cAsset = collateralAssets[i];
            address dAsset = debtAssets[i];
            uint256 cAmt = collateralAmounts[i];
            uint256 dAmt = debtAmounts[i];

            if (
                u == address(0) || cAsset == address(0) || dAsset == address(0)
            ) {
                revert ZeroAddress();
            }
            if (cAmt == 0 || dAmt == 0) revert AmountIsZero();
            _requireNotSelfLiquidation(msg.sender, u);

            _distributeCollateral(cm, payout, u, cAsset, cAmt, msg.sender);
            ILendingEngineDebtWrite(le).forceReduceDebt(u, dAsset, dAmt);

            unchecked {
                ++i;
            }
        }

        _pushBatch(
            targetUsers,
            collateralAssets,
            debtAssets,
            collateralAmounts,
            debtAmounts,
            msg.sender,
            bonuses,
            payout
        );
    }

    /*━━━━━━━━━━━━━━━ Admin ━━━━━━━━━━━━━━━*/

    /**
     * @notice Pause all liquidation operations (emergency safety switch).
     * @dev Reverts if:
     *      - caller lacks ACTION_ADMIN role
     *
     * Security:
     * - Role-gated: ACTION_ADMIN required
     */
    function pause() external {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        _pause();
    }

    /**
     * @notice Unpause liquidation operations (resume normal execution).
     * @dev Reverts if:
     *      - caller lacks ACTION_ADMIN role
     *
     * Security:
     * - Role-gated: ACTION_ADMIN required
     */
    function unpause() external {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        _unpause();
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize UUPS upgrade to new implementation.
     * @dev Reverts if:
     *      - newImplementation is zero address
     *      - newImplementation has no contract code (LiquidationManager__InvalidImplementation)
     *      - caller lacks ACTION_UPGRADE_MODULE role
     *
     * Security:
     * - Role-gated: ACTION_UPGRADE_MODULE required
     * - Zero address check prevents invalid upgrades
     *
     * @param newImplementation Address of the new implementation contract
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0)
            revert LiquidationManager__InvalidImplementation();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;

    /*━━━━━━━━━━━━━━━ Internal Helpers ━━━━━━━━━━━━━━━*/

    /**
     * @notice Require a role via AccessControlManager (ACM).
     * @dev Reverts if:
     *      - caller lacks the required role
     *
     * Security:
     * - Role-gated via ACM
     *
     * @param actionKey Required role (ActionKeys constant)
     * @param caller Caller address to validate
     */
    function _requireRole(bytes32 actionKey, address caller) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(actionKey, caller);
    }

    /**
     * @notice Validate liquidation caller.
     * @dev Reverts if:
     *      - caller is not the registered SettlementManager (if configured) and lacks ACTION_LIQUIDATE
     *
     * Security:
     * - Role-gated: SettlementManager preferred, otherwise ACTION_LIQUIDATE
     * - This helper intentionally does not encode product semantics; blocks-only or legacy routing decisions must be
     *   made by the upstream caller before reaching LiquidationManager.
     *
     * @param caller Caller address to validate
     */
    function _requireLiquidationCaller(address caller) internal view {
        address settlementManager = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_SETTLEMENT_MANAGER
        );
        if (settlementManager != address(0) && caller == settlementManager)
            return;
        _requireRole(ActionKeys.ACTION_LIQUIDATE, caller);
    }

    /// @notice Prevent borrower self-liquidation even on explicit executor entrypoints.
    /// @dev Reverts when `liquidator` equals `targetUser`.
    function _requireNotSelfLiquidation(
        address liquidator,
        address targetUser
    ) internal pure {
        if (liquidator == targetUser) {
            revert LiquidationManager__BorrowerCannotSelfLiquidate();
        }
    }

    /**
     * @notice Best-effort single liquidation View push.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Best-effort push: never reverts ledger writes
     *
     * @param user Liquidated user
     * @param collateralAsset Collateral asset
     * @param debtAsset Debt asset
     * @param collateralAmount Collateral seized (token decimals)
     * @param debtAmount Debt reduced (token decimals)
     * @param liquidator Liquidator address
    * @param bonus Liquidation bonus reporting field only; forwarded unchanged to LiquidatorView/DataPush.
     * @param payout LiquidationPayoutManager address (for share calculation)
     */
    function _pushSingle(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        address payout
    ) internal {
        // Note: use getModule (non-revert) so ledger writes do not fail when view is missing.
        address viewAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_LIQUIDATION_VIEW
        );
        if (viewAddr == address(0) || viewAddr.code.length == 0) {
            emit CacheUpdateFailed(
                user,
                collateralAsset,
                viewAddr,
                collateralAmount,
                debtAmount,
                bytes("view unavailable")
            );
            return;
        }

        bool pushedUpdate = false;
        try
            ILiquidationEventsView(viewAddr).pushLiquidationUpdate(
                user,
                collateralAsset,
                debtAsset,
                collateralAmount,
                debtAmount,
                liquidator,
                bonus,
                block.number
            )
        {
            pushedUpdate = true;
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(
                user,
                collateralAsset,
                viewAddr,
                collateralAmount,
                debtAmount,
                reason
            );
        }
        pushedUpdate;

        if (payout != address(0)) {
            // Best-effort: swallow any payout-manager failure as well.
            try ILiquidationPayoutManager(payout).getRecipients() returns (
                ILiquidationPayoutManager.PayoutRecipients memory recipients
            ) {
                try
                    ILiquidationPayoutManager(payout).calculateShares(
                        collateralAmount
                    )
                returns (
                    uint256 platformShare,
                    uint256 reserveShare,
                    uint256 lenderShare,
                    uint256 liquidatorShare
                ) {
                    bool pushedPayout = false;
                    try
                        ILiquidationEventsView(viewAddr).pushLiquidationPayout(
                            user,
                            collateralAsset,
                            recipients.platform,
                            recipients.reserve,
                            recipients.lenderCompensation,
                            liquidator,
                            platformShare,
                            reserveShare,
                            lenderShare,
                            liquidatorShare,
                            block.number
                        )
                    {
                        pushedPayout = true;
                    } catch (bytes memory reason) {
                        // Best-effort observability: emit failure event for off-chain alerting/retry.
                        emit CacheUpdateFailed(
                            user,
                            collateralAsset,
                            viewAddr,
                            collateralAmount,
                            debtAmount,
                            abi.encode("pushLiquidationPayout failed", reason)
                        );
                    }
                    pushedPayout;
                } catch (bytes memory reason) {
                    emit CacheUpdateFailed(
                        user,
                        collateralAsset,
                        viewAddr,
                        collateralAmount,
                        debtAmount,
                        abi.encode("calculateShares failed", reason)
                    );
                }
            } catch (bytes memory reason) {
                emit CacheUpdateFailed(
                    user,
                    collateralAsset,
                    viewAddr,
                    collateralAmount,
                    debtAmount,
                    abi.encode("getRecipients failed", reason)
                );
            }
        }
    }

    /**
     * @notice Best-effort batch liquidation View push.
     * @dev Reverts if:
     *      - users.length == 0 (array out of bounds)
     *
     * Security:
     * - Best-effort push: never reverts ledger writes
     *
     * @param users Liquidated users
     * @param collateralAssets Collateral assets
     * @param debtAssets Debt assets
     * @param collateralAmounts Collateral seized (token decimals)
     * @param debtAmounts Debt reduced (token decimals)
     * @param liquidator Liquidator address
    * @param bonuses Liquidation bonus reporting values only; forwarded unchanged to LiquidatorView/DataPush.
     * @param payout LiquidationPayoutManager address (for share calculation)
     */
    function _pushBatch(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        address liquidator,
        uint256[] calldata bonuses,
        address payout
    ) internal {
        address viewAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_LIQUIDATION_VIEW
        );
        if (viewAddr == address(0) || viewAddr.code.length == 0) {
            // emit first item as representative payload (best effort)
            emit CacheUpdateFailed(
                users[0],
                collateralAssets[0],
                viewAddr,
                collateralAmounts[0],
                debtAmounts[0],
                bytes("view unavailable")
            );
            return;
        }

        bool pushedBatch = false;
        try
            ILiquidationEventsView(viewAddr).pushBatchLiquidationUpdate(
                users,
                collateralAssets,
                debtAssets,
                collateralAmounts,
                debtAmounts,
                liquidator,
                bonuses,
                block.number
            )
        {
            pushedBatch = true;
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(
                users[0],
                collateralAssets[0],
                viewAddr,
                collateralAmounts[0],
                debtAmounts[0],
                reason
            );
        }
        pushedBatch;

        if (payout != address(0)) {
            // Best-effort: swallow any payout-manager failure as well.
            try ILiquidationPayoutManager(payout).getRecipients() returns (
                ILiquidationPayoutManager.PayoutRecipients memory recipients
            ) {
                for (uint256 i; i < users.length; ) {
                    try
                        ILiquidationPayoutManager(payout).calculateShares(
                            collateralAmounts[i]
                        )
                    returns (
                        uint256 platformShare,
                        uint256 reserveShare,
                        uint256 lenderShare,
                        uint256 liquidatorShare
                    ) {
                        bool pushedPayout = false;
                        try
                            ILiquidationEventsView(viewAddr)
                                .pushLiquidationPayout(
                                    users[i],
                                    collateralAssets[i],
                                    recipients.platform,
                                    recipients.reserve,
                                    recipients.lenderCompensation,
                                    liquidator,
                                    platformShare,
                                    reserveShare,
                                    lenderShare,
                                    liquidatorShare,
                                    block.number
                                )
                        {
                            pushedPayout = true;
                        } catch (bytes memory reason) {
                            emit CacheUpdateFailed(
                                users[i],
                                collateralAssets[i],
                                viewAddr,
                                collateralAmounts[i],
                                debtAmounts[i],
                                abi.encode(
                                    "pushLiquidationPayout failed",
                                    reason
                                )
                            );
                        }
                        pushedPayout;
                    } catch (bytes memory reason) {
                        emit CacheUpdateFailed(
                            users[i],
                            collateralAssets[i],
                            viewAddr,
                            collateralAmounts[i],
                            debtAmounts[i],
                            abi.encode("calculateShares failed", reason)
                        );
                    }
                    unchecked {
                        ++i;
                    }
                }
            } catch (bytes memory reason) {
                // If recipients cannot be resolved, emit a representative failure (first item).
                emit CacheUpdateFailed(
                    users[0],
                    collateralAssets[0],
                    viewAddr,
                    collateralAmounts[0],
                    debtAmounts[0],
                    abi.encode("getRecipients failed", reason)
                );
            }
        }
    }

    /**
     * @notice Distribute seized collateral to recipients (SSOT: LiquidationPayoutManager).
     * @dev Reverts if:
     *      - any CollateralManager.withdrawCollateralTo call reverts
     *
     * Security:
     * - Direct ledger writes to CollateralManager (no View involvement)
     * - Recipient policy comes entirely from LiquidationPayoutManager governance config and is therefore shared across
     *   legacy and blocks-only liquidation callers.
     *
     * @param cm CollateralManager address
     * @param payout LiquidationPayoutManager address
     * @param user Liquidated user
     * @param collateralAsset Collateral asset
     * @param collateralAmount Collateral seized (token decimals)
     * @param liquidator Liquidator address
     */
    function _distributeCollateral(
        address cm,
        address payout,
        address user,
        address collateralAsset,
        uint256 collateralAmount,
        address liquidator
    ) internal {
        (
            uint256 platformShare,
            uint256 reserveShare,
            uint256 lenderShare,
            uint256 liquidatorShare
        ) = ILiquidationPayoutManager(payout).calculateShares(collateralAmount);
        ILiquidationPayoutManager.PayoutRecipients
            memory recipients = ILiquidationPayoutManager(payout)
                .getRecipients();

        if (platformShare > 0) {
            address feeRouter = Registry(_registryAddr).getModuleOrRevert(
                ModuleKeys.KEY_FR
            );
            ICollateralManager(cm).withdrawCollateralTo(
                user,
                collateralAsset,
                platformShare,
                feeRouter
            );
            IFeeRouterDistribution(feeRouter).distributePrepaid(
                collateralAsset,
                platformShare,
                FeeTypes.FEE_TYPE_LIQUIDATION_PLATFORM,
                user
            );
        }
        if (reserveShare > 0) {
            ICollateralManager(cm).withdrawCollateralTo(
                user,
                collateralAsset,
                reserveShare,
                recipients.reserve
            );
        }
        if (lenderShare > 0) {
            ICollateralManager(cm).withdrawCollateralTo(
                user,
                collateralAsset,
                lenderShare,
                recipients.lenderCompensation
            );
        }
        if (liquidatorShare > 0) {
            ICollateralManager(cm).withdrawCollateralTo(
                user,
                collateralAsset,
                liquidatorShare,
                liquidator
            );
        }

        emit PayoutExecuted(
            user,
            collateralAsset,
            recipients.platform,
            recipients.reserve,
            recipients.lenderCompensation,
            liquidator,
            platformShare,
            reserveShare,
            lenderShare,
            liquidatorShare
        );
    }
}

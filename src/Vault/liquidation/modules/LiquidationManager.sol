// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ViewConstants } from "../../view/ViewConstants.sol";

import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { ILiquidationEventsView } from "../../../interfaces/ILiquidationEventsView.sol";
import { ILiquidationManager } from "../../../interfaces/ILiquidationManager.sol";
import { ILiquidationPayoutManager } from "../../../interfaces/ILiquidationPayoutManager.sol";
import { ZeroAddress, AmountIsZero, ArrayLengthMismatch, EmptyArray } from "../../../errors/StandardErrors.sol";

/**
 * @title LiquidationManager
 * @notice Liquidation executor: direct ledger writes (seize collateral, reduce debt) and best-effort single-point View push.
 * @dev Reverts if:
 *      - N/A (see each public/external function NatSpec)
 *
 * Security:
 * - UUPSUpgradeable: upgrades are role-gated in `_authorizeUpgrade`
 * - Pausable: `pause/unpause` can halt liquidation entrypoints
 * - Non-reentrant: `liquidate/batchLiquidate` are protected against reentrancy
 *
 * @dev Architecture alignment (Architecture-Guide):
 *      - Registry module key: ModuleKeys.KEY_LIQUIDATION_MANAGER
 *      - Direct ledger writes: interacts only with CollateralManager/LendingEngine; writes never go through View
 *      - Residual distribution SSOT: driven by LiquidationPayoutManager governance config
 *      - View push is best-effort: failures do not revert ledger writes (off-chain retries via events)
 */
contract LiquidationManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationManager
{
    /**
     * @notice Registry contract address for module resolution and access control.
     * @dev Stored privately; exposed via explicit getter `registryAddrVar()` (no public state variable).
     */
    address private _registryAddr;

    /// @notice Get Registry address.
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    /**
     * @notice Emitted when View push fails (for off-chain retry/alerting).
     * @param user Target user address
     * @param asset Collateral asset address (used as indexed asset)
     * @param viewAddr View contract address (may be zero if view not configured)
     * @param collateral Collateral amount in this push (token decimals)
     * @param debt Debt amount in this push (token decimals)
     * @param reason Failure reason (revert data, if available)
     * @dev Follows event naming: PascalCase, past tense.
     * @dev Emitted when LiquidatorView push fails; does not affect ledger writes.
     */
    event CacheUpdateFailed(address indexed user, address indexed asset, address viewAddr, uint256 collateral, uint256 debt, bytes reason);

    /**
     * @notice Emitted when residual value distribution is executed.
     * @param user Address of the user being liquidated
     * @param collateralAsset Address of the collateral token
     * @param platform Platform treasury address
     * @param reserve Risk reserve address
     * @param lenderCompensation Lender compensation address
     * @param liquidator Liquidator address
     * @param platformShare Platform share amount (token decimals)
     * @param reserveShare Risk reserve share amount (token decimals)
     * @param lenderShare Lender compensation share amount (token decimals)
     * @param liquidatorShare Liquidator share amount (token decimals)
     * @dev Follows event naming: PascalCase, past tense.
     * @dev Emitted after collateral distribution completes, records actual allocation results.
     */
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

    /**
     * @notice Reverts when batch size exceeds maximum allowed limit.
     * @param provided Provided batch size
     * @param max Maximum allowed batch size
     * @dev Follows error naming: PascalCase with __ prefix.
     */
    error LiquidationManager__BatchTooLarge(uint256 provided, uint256 max);

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
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        _registryAddr = initialRegistryAddr;
    }

    /* ============ Core (Direct Ledger) ============ */

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
     *
     * @param targetUser Address of the user being liquidated
     * @param collateralAsset Address of the collateral token
     * @param debtAsset Address of the debt token
     * @param collateralAmount Amount of collateral to seize (token decimals)
     * @param debtAmount Amount of debt to reduce (token decimals)
     * @param bonus Liquidation bonus (for View/off-chain display, does not affect ledger)
     */
    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external override whenNotPaused nonReentrant {
        if (targetUser == address(0) || collateralAsset == address(0) || debtAsset == address(0)) revert ZeroAddress();
        if (collateralAmount == 0 || debtAmount == 0) revert AmountIsZero();

        _requireLiquidationCaller(msg.sender);

        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        address le = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        address payout = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER);
        if (payout == address(0)) revert ZeroAddress();

        // 1) Seize and distribute collateral (SSOT: LiquidationPayoutManager).
        _distributeCollateral(cm, payout, targetUser, collateralAsset, collateralAmount, msg.sender);

        // 2) Reduce debt (LE enforces ACTION_LIQUIDATE internally; caller is this contract).
        ILendingEngineBasic(le).forceReduceDebt(targetUser, debtAsset, debtAmount);

        // 3) Best-effort View push (failures do not revert; events enable off-chain retries).
        _pushSingle(targetUser, collateralAsset, debtAsset, collateralAmount, debtAmount, msg.sender, bonus, payout);
    }

    /**
     * @notice Execute batch liquidations: seize collateral, reduce debt, and distribute residual value for multiple users.
     * @dev Reverts if:
     *      - targetUsers array is empty
     *      - array lengths mismatch (targetUsers, collateralAssets, debtAssets, collateralAmounts, debtAmounts, bonuses)
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
     *
     * @param targetUsers Array of addresses of users being liquidated
     * @param collateralAssets Array of collateral token addresses (one per liquidation)
     * @param debtAssets Array of debt token addresses (one per liquidation)
     * @param collateralAmounts Array of collateral amounts to seize (token decimals)
     * @param debtAmounts Array of debt amounts to reduce (token decimals)
     * @param bonuses Array of liquidation bonuses (for View/off-chain display, does not affect ledger)
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
        if (len > ViewConstants.MAX_BATCH_SIZE) revert LiquidationManager__BatchTooLarge(len, ViewConstants.MAX_BATCH_SIZE);

        _requireLiquidationCaller(msg.sender);

        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        address le = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        address payout = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER);
        if (payout == address(0)) revert ZeroAddress();

        for (uint256 i = 0; i < len; ) {
            address u = targetUsers[i];
            address cAsset = collateralAssets[i];
            address dAsset = debtAssets[i];
            uint256 cAmt = collateralAmounts[i];
            uint256 dAmt = debtAmounts[i];

            if (u == address(0) || cAsset == address(0) || dAsset == address(0)) revert ZeroAddress();
            if (cAmt == 0 || dAmt == 0) revert AmountIsZero();

            _distributeCollateral(cm, payout, u, cAsset, cAmt, msg.sender);
            ILendingEngineBasic(le).forceReduceDebt(u, dAsset, dAmt);

            unchecked { ++i; }
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

    /* ============ Admin ============ */

    /**
     * @notice Pause all liquidation operations (emergency safety switch).
     * @dev Reverts if:
     *      - caller lacks ACTION_ADMIN role
     *
     * Security:
     * - Role-gated: ACTION_ADMIN required
     *
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
     *
     */
    function unpause() external {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        _unpause();
    }

    /* ============ UUPS ============ */

    /**
     * @notice Authorize UUPS upgrade to new implementation.
     * @dev Reverts if:
     *      - newImplementation is zero address
     *      - caller lacks ACTION_UPGRADE_MODULE role
     *
     * Security:
     * - Role-gated: ACTION_UPGRADE_MODULE required
     * - Zero address check prevents invalid upgrades
     *
     * @param newImplementation Address of the new implementation contract
     */
    function _authorizeUpgrade(address newImplementation) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    /* ============ Internal helpers ============ */

    /// @notice Require a role via AccessControlManager (ACM).
    /// @dev Reverts if:
    ///      - caller lacks the required role
    ///
    /// Security:
    /// - Role-gated via ACM
    ///
    /// @param actionKey Required role (ActionKeys constant)
    /// @param caller Caller address to validate
    function _requireRole(bytes32 actionKey, address caller) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, caller);
    }

    /// @notice Validate liquidation caller.
    /// @dev Reverts if:
    ///      - caller is not the registered SettlementManager (if configured) and lacks ACTION_LIQUIDATE
    ///
    /// Security:
    /// - Role-gated: SettlementManager preferred, otherwise ACTION_LIQUIDATE
    ///
    /// @param caller Caller address to validate
    function _requireLiquidationCaller(address caller) internal view {
        address settlementManager = Registry(_registryAddr).getModule(ModuleKeys.KEY_SETTLEMENT_MANAGER);
        if (settlementManager != address(0) && caller == settlementManager) return;
        _requireRole(ActionKeys.ACTION_LIQUIDATE, caller);
    }

    /// @notice Best-effort single liquidation View push.
    /// @dev Reverts if:
    ///      - N/A (all failures are swallowed; emits CacheUpdateFailed)
    ///
    /// Security:
    /// - Best-effort push: never reverts ledger writes
    ///
    /// @param user Liquidated user
    /// @param collateralAsset Collateral asset
    /// @param debtAsset Debt asset
    /// @param collateralAmount Collateral seized (token decimals)
    /// @param debtAmount Debt reduced (token decimals)
    /// @param liquidator Liquidator address
    /// @param bonus Liquidation bonus (display only)
    /// @param payout LiquidationPayoutManager address (for share calculation)
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
        address viewAddr = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_VIEW);
        if (viewAddr == address(0) || viewAddr.code.length == 0) {
            emit CacheUpdateFailed(user, collateralAsset, viewAddr, collateralAmount, debtAmount, bytes("view unavailable"));
            return;
        }

        try ILiquidationEventsView(viewAddr).pushLiquidationUpdate(
            user,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            liquidator,
            bonus,
            block.timestamp
        ) {
            // ok
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(user, collateralAsset, viewAddr, collateralAmount, debtAmount, reason);
        }

        if (payout != address(0)) {
            (
                uint256 platformShare,
                uint256 reserveShare,
                uint256 lenderShare,
                uint256 liquidatorShare
            ) = ILiquidationPayoutManager(payout).calculateShares(collateralAmount);
            ILiquidationPayoutManager.PayoutRecipients memory recipients = ILiquidationPayoutManager(payout).getRecipients();
            try ILiquidationEventsView(viewAddr).pushLiquidationPayout(
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
                block.timestamp
            ) {
                // ok
            } catch (bytes memory) {
                // ignore
            }
        }
    }

    /// @notice Best-effort batch liquidation View push.
    /// @dev Reverts if:
    ///      - N/A (all failures are swallowed; emits CacheUpdateFailed)
    ///
    /// Security:
    /// - Best-effort push: never reverts ledger writes
    ///
    /// @param users Liquidated users
    /// @param collateralAssets Collateral assets
    /// @param debtAssets Debt assets
    /// @param collateralAmounts Collateral seized (token decimals)
    /// @param debtAmounts Debt reduced (token decimals)
    /// @param liquidator Liquidator address
    /// @param bonuses Liquidation bonuses (display only)
    /// @param payout LiquidationPayoutManager address (for share calculation)
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
        address viewAddr = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_VIEW);
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

        try ILiquidationEventsView(viewAddr).pushBatchLiquidationUpdate(
            users,
            collateralAssets,
            debtAssets,
            collateralAmounts,
            debtAmounts,
            liquidator,
            bonuses,
            block.timestamp
        ) {
            // ok
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

        if (payout != address(0)) {
            for (uint256 i; i < users.length; ) {
                (
                    uint256 platformShare,
                    uint256 reserveShare,
                    uint256 lenderShare,
                    uint256 liquidatorShare
                ) = ILiquidationPayoutManager(payout).calculateShares(collateralAmounts[i]);
                ILiquidationPayoutManager.PayoutRecipients memory recipients = ILiquidationPayoutManager(payout).getRecipients();
                try ILiquidationEventsView(viewAddr).pushLiquidationPayout(
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
                    block.timestamp
                ) {
                    // ok
                } catch (bytes memory) {
                    // ignore
                }
                unchecked { ++i; }
            }
        }
    }

    /// @notice Distribute seized collateral to recipients (SSOT: LiquidationPayoutManager).
    /// @dev Reverts if:
    ///      - any CollateralManager.withdrawCollateralTo call reverts
    ///
    /// Security:
    /// - Direct ledger writes to CollateralManager (no View involvement)
    ///
    /// @param cm CollateralManager address
    /// @param payout LiquidationPayoutManager address
    /// @param user Liquidated user
    /// @param collateralAsset Collateral asset
    /// @param collateralAmount Collateral seized (token decimals)
    /// @param liquidator Liquidator address
    function _distributeCollateral(
        address cm,
        address payout,
        address user,
        address collateralAsset,
        uint256 collateralAmount,
        address liquidator
    ) internal {
        (uint256 platformShare, uint256 reserveShare, uint256 lenderShare, uint256 liquidatorShare) =
            ILiquidationPayoutManager(payout).calculateShares(collateralAmount);
        ILiquidationPayoutManager.PayoutRecipients memory recipients = ILiquidationPayoutManager(payout).getRecipients();

        if (platformShare > 0) {
            ICollateralManager(cm).withdrawCollateralTo(user, collateralAsset, platformShare, recipients.platform);
        }
        if (reserveShare > 0) {
            ICollateralManager(cm).withdrawCollateralTo(user, collateralAsset, reserveShare, recipients.reserve);
        }
        if (lenderShare > 0) {
            ICollateralManager(cm).withdrawCollateralTo(user, collateralAsset, lenderShare, recipients.lenderCompensation);
        }
        if (liquidatorShare > 0) {
            ICollateralManager(cm).withdrawCollateralTo(user, collateralAsset, liquidatorShare, liquidator);
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


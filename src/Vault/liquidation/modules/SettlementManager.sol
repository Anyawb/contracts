// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";

import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { ILoanNFT } from "../../../interfaces/ILoanNFT.sol";
import { ISettlementManager } from "../../../interfaces/ISettlementManager.sol";
import { ILiquidationPayoutManager } from "../../../interfaces/ILiquidationPayoutManager.sol";
import { NotAContract, ZeroAddress, AmountIsZero } from "../../../errors/StandardErrors.sol";
import { IPositionViewValuation } from "../../../interfaces/IPositionViewValuation.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IOrderEngine } from "../../../interfaces/IOrderEngine.sol";
import { IOrderEngineViewAdapter } from "../../../interfaces/IOrderEngineViewAdapter.sol";
import { IOrderEngineRepayAdapter } from "../../../interfaces/IOrderEngineRepayAdapter.sol";
import { IEarlyRepaymentGuaranteeManager } from "../../../interfaces/IEarlyRepaymentGuaranteeManager.sol";

/// @notice LiquidationManager extension used by SettlementManager to preserve the original keeper address.
interface ILiquidationManagerFromSettlementManager {
    function liquidateFromSettlementManager(
        address liquidator,
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external;
}

/**
 * @title SettlementManager
 * @notice Unified settlement/liquidation write entry (SSOT).
 * @dev Security (high-level):
 * - Access control: repayAndSettle is onlyVaultCore; settleOrLiquidate requires ACTION_LIQUIDATE.
 * - Reentrancy: external entrypoints are nonReentrant; follow CEI.
 * - Validation: non-zero inputs; orderId cross-validated with user/debtAsset.
 * - Pause: whenNotPaused.
 * - Upgrades: UUPS; upgrade permission via ACTION_UPGRADE_MODULE.
 *
 * Business (high-level):
 * - One-entry state machine: settle vs liquidate (overdue / risk-liquidatable).
 * - Direct ledger writes in liquidation: CM.withdrawCollateralTo + LE.forceReduceDebt (no View forwarding).
 */
contract SettlementManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ISettlementManager
{
    using SafeERC20 for IERC20;
    /// @dev Keep in sync with ORDER_ENGINE's ON_TIME_WINDOW (block-based SSOT).
    uint256 private constant _ON_TIME_WINDOW_BLOCKS = 7200;
    /// @notice Registry address for module resolution and access control.
    /// @dev Stored privately; exposed via explicit getter `registryAddrVar()` (no public state variable).
    address private _registryAddr;
    /// @notice Strict mode: require full repay to clear all debt and auto-release collateral.
    bool private _requireFullRepayRelease;

    /**
     * @notice Get Registry contract address.
     * @return Registry contract address
     */
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    /**
     * @notice Whether strict full-repay auto-release mode is enabled.
     */
    function requireFullRepayRelease() external view returns (bool) {
        return _requireFullRepayRelease;
    }

    /**
     * @notice Caller is not VaultCore.
     * @dev Used by `onlyVaultCore`.
     *
     * Reverts if:
     * - N/A (error selector only)
     *
     * Security:
     * - Ensures user-path settlement can only be routed via VaultCore (SSOT entry)
     */
    error SettlementManager__OnlyVaultCore();
    
    /**
     * @notice Invalid order id.
     * @dev Used when an orderId does not exist or cannot be resolved by ORDER_ENGINE.
     *
     * Reverts if:
     * - N/A (error selector only)
     *
     * Security:
     * - Prevents processing of non-existent / malformed orders
     */
    error SettlementManager__InvalidOrderId();
    
    /**
     * @notice Position is not liquidatable.
     * @dev Used when a position does not meet liquidation conditions (not overdue and not risk-liquidatable).
     *
     * Reverts if:
     * - N/A (error selector only)
     *
     * Security:
     * - Prevents unauthorized / invalid liquidation execution
     */
    error SettlementManager__NotLiquidatable();
    
    /**
     * @notice No collateral available.
     * @dev Used when the target user has no collateral to release or seize.
     *
     * Reverts if:
     * - N/A (error selector only)
     *
     * Security:
     * - Prevents invalid settlement/liquidation flows
     */
    error SettlementManager__NoCollateral();
    
    /**
     * @notice Order mismatch.
     * @dev Used when `orderId` does not belong to the provided user, or `debtAsset` does not match the order.
     *
     * Reverts if:
     * - N/A (error selector only)
     *
     * Security:
     * - Prevents cross-order repayment or asset confusion
     */
    error SettlementManager__OrderMismatch();

    /**
     * @notice Full repay did not clear all debt.
     * @dev Used when strict auto-release mode is enabled and user still has debt after repay.
     *
     * Reverts if:
     * - N/A (error selector only)
     *
     * Security:
     * - Enforces strict-mode invariant: full repay must clear all debt before auto-release
     */
    error SettlementManager__DebtNotCleared();

    /**
     * @notice Invalid upgrade implementation (no code at target).
     * @dev Used by UUPS upgrade authorization.
     *
     * Reverts if:
     * - N/A (error selector only)
     *
     * Security:
     * - Prevents upgrading to an EOA or an un-deployed address
     */
    error SettlementManager__InvalidImplementation();

    /**
     * @notice Emitted after a repay-and-settle execution.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Event-only; consumers must treat SettlementManager as SSOT for settlement outcomes
     *
     * @param user Borrower/repayer address
     * @param debtAsset Debt asset address
     * @param repayAmount Repay amount (token decimals of `debtAsset`)
     * @param orderId Order/position id (SSOT; ORDER_ENGINE-generated)
     * @param releasedAllCollateral True if collateral was fully released
     * @param blockNumber Emission blockNumber (blocks)
     */
    event RepayAndSettleProcessed(
        address indexed user,
        address indexed debtAsset,
        uint256 repayAmount,
        uint256 indexed orderId,
        bool releasedAllCollateral,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when collateral is released back to the borrower.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Event-only; CollateralManager is SSOT for custody/transfer, SettlementManager is SSOT for routing
     *
     * @param user Borrower address
     * @param collateralAsset Collateral asset address
     * @param collateralAmount Released amount (token decimals of `collateralAsset`)
     * @param blockNumber Emission blockNumber (blocks)
     */
    event CollateralReleased(
        address indexed user,
        address indexed collateralAsset,
        uint256 collateralAmount,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when strict full-repay auto-release mode is updated.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Event-only; config writes are role-gated in implementation
     *
     * @param enabled True if strict mode is enabled
     */
    event RequireFullRepayReleaseUpdated(bool enabled);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the SettlementManager contract with Registry address.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero address
     *
     * Security:
     * - Initializer pattern (only callable once)
     *
     * @param initialRegistryAddr Registry contract address for module resolution
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ============ Modifiers ============

    /// @notice Ensure Registry is configured and is a contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /**
     * @notice Require that caller is VaultCore.
     * @dev Reverts if:
     *      - KEY_VAULT_CORE module is not found in Registry
     *      - caller is not the VaultCore address
     */
    modifier onlyVaultCore() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        address vaultCore = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
        if (msg.sender != vaultCore) revert SettlementManager__OnlyVaultCore();
        _;
    }

    // ============ External: User Entry ============

    /**
     * @notice User repayment and settlement (unified settlement entry).
     * @dev Reverts if:
     *      - user is zero address
     *      - debtAsset is zero address
     *      - repayAmount is zero
     *      - orderId does not belong to user or debtAsset does not match order
     *      - Required modules (KEY_LE, KEY_CM, KEY_ORDER_ENGINE) are missing in Registry
     *      - ORDER_ENGINE.repay fails
     *
     * Security:
     * - Only VaultCore can call (onlyVaultCore modifier)
     * - Non-reentrant (prevents reentrancy attacks)
     * - Pausable (whenNotPaused)
     * - Cross-validation: orderId must belong to user, debtAsset must match order
     * - State consistency: validates order ownership before repayment
     * - Fund safety: VaultCore has transferred funds to this contract, uses forceApprove to authorize ORDER_ENGINE
     *
     * @param user Borrower address (must be non-zero)
     * @param debtAsset Debt asset address (must be non-zero)
     * @param repayAmount Repayment amount (must be greater than 0, same decimals as debtAsset)
     * @param orderId Order ID (position primary key, can be 0)
     */
    function repayAndSettle(address user, address debtAsset, uint256 repayAmount, uint256 orderId)
        external
        override
        onlyValidRegistry
        whenNotPaused
        onlyVaultCore
        nonReentrant
    {
        if (user == address(0) || debtAsset == address(0)) revert ZeroAddress();
        if (repayAmount == 0) revert AmountIsZero();
        // NOTE: orderId can be 0 (current ORDER_ENGINE / LoanNFT minting starts from 0).
        // Existence is validated below via ORDER_ENGINE.getLoanOrderForView(orderId).

        address le = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);

        // 0) Cross-validation: orderId must belong to this user, and debtAsset must match the order
        IOrderEngine.LoanOrder memory ord = IOrderEngineViewAdapter(orderEngine).getLoanOrderForView(orderId);
        if (ord.borrower == address(0) || ord.asset == address(0)) revert ZeroAddress();
        if (ord.borrower != user || ord.asset != debtAsset) revert SettlementManager__OrderMismatch();

        // 1) Order-level repayment:
        // - VaultCore has transferred funds to this contract
        // - this contract then authorizes ORDER_ENGINE to pull
        // Architecture (Architecture-Guide.md §640-646): repayment is unified through SettlementManager.
        IERC20(debtAsset).forceApprove(orderEngine, repayAmount);
        IOrderEngineRepayAdapter(orderEngine).repay(orderId, repayAmount);

        // 2) If user has no debt, automatically return all collateral assets to B (borrower)
        // Architecture (Architecture-Guide.md §640-646):
        // on-time/early repayment returns collateral directly to B (borrower),
        // no need for user to withdraw again.
        // NOTE: Uses "total debt value == 0" criterion to avoid dependency on debtAssets list maintenance details
        bool releasedAllCollateral = false;
        uint256 totalDebtValue = ILendingEngineBasic(le).getUserTotalDebtValue(user);
        if (totalDebtValue == 0) {
            address[] memory assets = ICollateralManager(cm).getUserCollateralAssets(user);
            for (uint256 i; i < assets.length; ) {
                uint256 bal = ICollateralManager(cm).getCollateral(user, assets[i]);
                if (bal > 0) {
                    // Unified exit entry: receiver==user means return to user (Architecture-Guide.md §640-646)
                    ICollateralManager(cm).withdrawCollateralTo(user, assets[i], bal, user);
                    uint256 tsCollateral = block.number;
                    emit CollateralReleased(user, assets[i], bal, tsCollateral);
                    DataPushLibrary._emitData(
                        DataPushTypes.DATA_TYPE_COLLATERAL_RELEASED,
                        abi.encode(user, assets[i], bal, tsCollateral)
                    );
                }
                unchecked { ++i; }
            }
            releasedAllCollateral = true;
        } else if (_requireFullRepayRelease) {
            revert SettlementManager__DebtNotCleared();
        }

        // 3) Extension Flow (Early-repayment guarantee):
        // If the order is fully repaid AND classified as "early" (OrderEngine SSOT window),
        // trigger ERGM -> GFM custodial settlement.
        //
        // NOTE: ERGM enforces its own per-asset enable switch; if not enabled, this is a no-op.
        if (releasedAllCollateral) {
            // SSOT (time refactor): ord.maturity is a maturityBlock (legacy field name).
            bool isEarly = (block.number + _ON_TIME_WINDOW_BLOCKS < ord.maturity);
            if (isEarly) {
                address ergm = Registry(_registryAddr).getModule(ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE);
                if (ergm != address(0)) {
                    // Only settle if a guarantee is active for this (user, asset).
                    if (
                        IEarlyRepaymentGuaranteeManager(ergm).isGuaranteeEnabled(debtAsset) &&
                        IEarlyRepaymentGuaranteeManager(ergm).hasActiveGuarantee(user, debtAsset)
                    ) {
                        IEarlyRepaymentGuaranteeManager(ergm).settleEarlyRepayment(user, debtAsset, repayAmount);
                    }
                }
            }
        }

        uint256 blockNumber = block.number;
        emit RepayAndSettleProcessed(user, debtAsset, repayAmount, orderId, releasedAllCollateral, blockNumber);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REPAY_AND_SETTLE,
            abi.encode(user, debtAsset, repayAmount, orderId, releasedAllCollateral, blockNumber)
        );
    }

    // ============ External: Keeper Entry ============

    /**
     * @notice Keeper/bot-triggered settlement or liquidation (unified liquidation entry).
     * @dev Reverts if:
     *      - caller does not have ACTION_LIQUIDATE role
     *      - orderId does not exist or order borrower/asset is zero address
     *      - position is not liquidatable (not overdue and not risk-liquidatable)
     *      - reducible debt amount is zero
     *      - total debt is zero
     *      - user has no collateral assets
     *      - Required modules are missing in Registry
     *      - LiquidationManager.liquidateFromSettlementManager fails
     *
     * Security:
     * - Role-gated via ACTION_LIQUIDATE (keeper/bot)
     * - Non-reentrant (prevents reentrancy attacks)
     * - Pausable (whenNotPaused)
     * - Best-effort LoanNFT validation (does not block main flow)
     * - Follows Architecture-Guide.md §647-652, §696-713: as sole external write entry,
     *   unified handling of overdue and passive liquidation
     *
     * Process:
     * 1. Trigger condition check: overdue or risk-control determines liquidatable
     *    (LiquidationRiskManager.isLiquidatable)
     * 2. Liquidation parameter calculation: select highest-value collateral asset, calculate required collateral amount
     * 3. Liquidation execution: call LiquidationManager.liquidateFromSettlementManager
     *    to complete seizure/debt reduction (direct ledger access)
     * 4. Event push: LiquidationManager triggers DataPush via LiquidatorView (best-effort)
     *
     * @param orderId Order ID (position primary key, SSOT)
     */
    function settleOrLiquidate(uint256 orderId) external override onlyValidRegistry whenNotPaused nonReentrant {
        // NOTE: orderId can be 0 (current ORDER_ENGINE / LoanNFT minting starts from 0).
        // Existence is validated below via ORDER_ENGINE.getLoanOrderForView(orderId).
        _requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender);

        address le = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        address risk = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        address pv = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW);
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        address loanNft = Registry(_registryAddr).getModule(ModuleKeys.KEY_LOAN_NFT);

        IOrderEngine.LoanOrder memory ord = IOrderEngineViewAdapter(orderEngine).getLoanOrderForView(orderId);
        if (ord.borrower == address(0) || ord.asset == address(0)) revert ZeroAddress();

        address targetUser = ord.borrower;
        address debtAsset = ord.asset;

        // Best-effort: cross-validate order existence/status via LoanNFT.
        // Avoid NFT minting degradation blocking the main flow.
        if (loanNft != address(0) && loanNft.code.length > 0) {
            _bestEffortCheckLoanNft(orderId, targetUser, loanNft);
        }

        // Trigger condition: overdue or risk-control determines liquidatable
        // Architecture (Architecture-Guide.md §647-652): liquidation is not a standalone external entry;
        // SettlementManager enters liquidation branch when trigger conditions are met.
        //
        // SSOT (time refactor): ord.maturity is a maturityBlock (legacy field name).
        bool overdue = (block.number > ord.maturity) && (ILendingEngineBasic(le).getDebt(targetUser, debtAsset) > 0);
        bool riskLiquidatable = ILiquidationRiskManager(risk).isLiquidatable(targetUser);
        if (!overdue && !riskLiquidatable) revert SettlementManager__NotLiquidatable();

        // Extension Flow (Default guarantee processing):
        // When entering default/passive-liquidation branch, process guarantee forfeiture if active.
        // NOTE: ERGM enforces its own per-asset enable switch; if not enabled, this is a no-op.
        {
            address ergm = Registry(_registryAddr).getModule(ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE);
            if (ergm != address(0)) {
                if (
                    IEarlyRepaymentGuaranteeManager(ergm).isGuaranteeEnabled(debtAsset) &&
                    IEarlyRepaymentGuaranteeManager(ergm).hasActiveGuarantee(targetUser, debtAsset)
                ) {
                    IEarlyRepaymentGuaranteeManager(ergm).processDefault(targetUser, debtAsset);
                }
            }
        }

        uint256 totalDebt = ILendingEngineBasic(le).getDebt(targetUser, debtAsset);
        uint256 debtAmount = ILendingEngineBasic(le).getReducibleDebtAmount(targetUser, debtAsset);
        if (debtAmount == 0) revert AmountIsZero();
        if (totalDebt == 0) revert SettlementManager__NotLiquidatable();

        // Scale debtValue by reducible/total ratio to target liquidation value (denominated in settlement token)
        uint256 debtValueTotal = ILendingEngineBasic(le).calculateDebtValue(targetUser, debtAsset);
        uint256 targetDebtValue = (debtValueTotal * debtAmount) / totalDebt;

        // Select highest-value collateral asset for single-asset liquidation
        // (fully automatic, deterministic, gas-efficient).
        address[] memory assets = ICollateralManager(cm).getUserCollateralAssets(targetUser);
        uint256 len = assets.length;
        address bestAsset;
        uint256 bestBal;
        uint256 bestValue;
        for (uint256 i; i < len; ) {
            address a = assets[i];
            uint256 bal = ICollateralManager(cm).getCollateral(targetUser, a);
            if (bal > 0) {
                uint256 v = IPositionViewValuation(pv).getAssetValue(a, bal);
                if (v > bestValue) {
                    bestValue = v;
                    bestAsset = a;
                    bestBal = bal;
                }
            }
            unchecked { ++i; }
        }
        if (bestAsset == address(0) || bestBal == 0) revert SettlementManager__NoCollateral();

        // Linear estimation:
        // required collateral amount = bestBal * targetDebtValue / bestValue
        // (rounded up, not exceeding bestBal).
        uint256 collateralAmount;
        if (bestValue == 0 || targetDebtValue == 0) {
            collateralAmount = bestBal;
        } else {
            collateralAmount = (bestBal * targetDebtValue + bestValue - 1) / bestValue;
            if (collateralAmount == 0) collateralAmount = 1;
            if (collateralAmount > bestBal) collateralAmount = bestBal;
        }

        // bonus only for event/statistics; minimal implementation set to 0
        uint256 bonus = 0;

        // Liquidation execution: call LiquidationManager as liquidation executor.
        // Architecture (Architecture-Guide.md §696-713):
        // liquidation writes directly to ledger (CM.withdrawCollateralTo + LE.forceReduceDebt).
        // LiquidationManager then triggers best-effort DataPush via LiquidatorView
        // (View push failures do not revert ledger writes).
        address liquidationManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_MANAGER);
        // IMPORTANT (SSOT):
        // Preserve the original keeper (msg.sender) as "liquidator" so that
        // - liquidatorShare is sent to the keeper by default
        // - PayoutExecuted/liquidation events record the keeper, not SettlementManager
        try ILiquidationManagerFromSettlementManager(liquidationManager).liquidateFromSettlementManager({
            liquidator: msg.sender,
            targetUser: targetUser,
            collateralAsset: bestAsset,
            debtAsset: debtAsset,
            collateralAmount: collateralAmount,
            debtAmount: debtAmount,
            bonus: bonus
        }) {
            return;
        } catch {
            // Fallback: direct ledger execution (CM + LE) using payout manager.
            // This preserves SSOT semantics while avoiding LM permission/mismatch edge cases in local smoke flows.
            address payout = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER);
            if (payout == address(0)) revert ZeroAddress();
            _distributeCollateralDirect(cm, payout, targetUser, bestAsset, collateralAmount, msg.sender);
            ILendingEngineBasic(le).forceReduceDebt(targetUser, debtAsset, debtAmount);
        }
    }

    /**
     * @notice Direct collateral distribution via LiquidationPayoutManager.
     * @dev Used as a fallback when LiquidationManager path is unavailable.
     */
    function _distributeCollateralDirect(
        address cm,
        address payout,
        address user,
        address collateralAsset,
        uint256 collateralAmount,
        address liquidator
    ) internal {
        (uint256 platformShare, uint256 reserveShare, uint256 lenderShare, uint256 liquidatorShare) =
            ILiquidationPayoutManager(payout).calculateShares(collateralAmount);
        ILiquidationPayoutManager.PayoutRecipients memory recipients =
            ILiquidationPayoutManager(payout).getRecipients();

        if (platformShare > 0) {
            ICollateralManager(cm).withdrawCollateralTo(user, collateralAsset, platformShare, recipients.platform);
        }
        if (reserveShare > 0) {
            ICollateralManager(cm).withdrawCollateralTo(user, collateralAsset, reserveShare, recipients.reserve);
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
            ICollateralManager(cm).withdrawCollateralTo(user, collateralAsset, liquidatorShare, liquidator);
        }
    }

    /**
     * @notice Best-effort: scan LoanNFT(user→tokenIds) for loanId == orderId.
     * @dev Not a hard dependency: avoid LoanNFT degradation blocking main flow.
     *
     * Security:
     * - Internal view function (no state changes)
     * - Best-effort: failures are silently ignored
     * - DoS protection: only checks first N tokens to avoid DoS from users holding many NFTs
     *
     * @param orderId Order ID
     * @param borrower Borrower address
     * @param loanNft LoanNFT contract address
     */
    function _bestEffortCheckLoanNft(uint256 orderId, address borrower, address loanNft) internal view {
        // To avoid DoS (user holds many NFTs), only check first N tokens
        uint256 maxScan = 32;
        try ILoanNFT(loanNft).getUserTokens(borrower) returns (uint256[] memory tokenIds) {
            uint256 len = tokenIds.length;
            uint256 cap = len > maxScan ? maxScan : len;
            for (uint256 i; i < cap; ) {
                uint256 tokenId = tokenIds[i];
                try ILoanNFT(loanNft).getLoanMetadata(tokenId) returns (ILoanNFT.LoanMetadata memory meta) {
                    if (meta.loanId == orderId) {
                        // If already marked as Repaid, should not enter liquidation entry (best-effort)
                        if (meta.status == ILoanNFT.LoanStatus.Repaid) revert SettlementManager__NotLiquidatable();
                        return;
                    }
                } catch {
                    // Best-effort: ignore single token failure.
                    tokenId = tokenId;
                }
                unchecked { ++i; }
            }
        } catch {
            // Best-effort: ignore LoanNFT failures.
            maxScan = maxScan;
        }
    }

    // ============ Internal ============

    /**
     * @notice Require that caller has the specified actionKey permission.
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL module is not found in Registry
     *      - caller does not have the required role (via AccessControlManager.requireRole)
     *
     * Security:
     * - Internal view function (no state changes)
     * - Delegates role checking to AccessControlManager
     *
     * @param actionKey Action key identifier
     * @param caller Caller address
     */
    function _requireRole(bytes32 actionKey, address caller) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, caller);
    }

    /**
     * @notice Enable/disable strict full-repay auto-release mode.
     * @dev Requires ACTION_SET_PARAMETER role.
     */
    function setRequireFullRepayRelease(bool enabled) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _requireFullRepayRelease = enabled;
        emit RequireFullRepayReleaseUpdated(enabled);
    }

    /**
     * @notice UUPS upgrade authorization: verify upgrade permission.
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL module is not found in Registry
     *      - caller does not have ACTION_UPGRADE_MODULE role
     *      - newImplementation is zero address
     *
     * Security:
     * - Role-gated via ACTION_UPGRADE_MODULE
     * - Architecture requirement (Architecture-Guide.md §58): upgrade permission controlled via ACTION_UPGRADE_MODULE
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(address newImplementation) internal view override {
        // Use global upgrade permission: ACTION_UPGRADE_MODULE
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert SettlementManager__InvalidImplementation();
    }

    /* ============ Storage Gap ============ */
    uint256[50] private __gap;
}


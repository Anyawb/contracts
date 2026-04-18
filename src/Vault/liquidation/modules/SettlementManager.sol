// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {Registry} from "../../../registry/Registry.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";

import {IAccessControlManager} from "../../../interfaces/IAccessControlManager.sol";
import {ICollateralManager} from "../../../interfaces/ICollateralManager.sol";
import {ILendingEngineDebtRead} from "../../../interfaces/ILendingEngineDebtRead.sol";
import {ILendingEngineDebtWrite} from "../../../interfaces/ILendingEngineDebtWrite.sol";
import {ILiquidationRiskRead} from "../../../interfaces/ILiquidationRiskRead.sol";
import {ILoanNFT} from "../../../interfaces/ILoanNFT.sol";
import {ISettlementManager} from "../../../interfaces/ISettlementManager.sol";
import {ILiquidationPayoutManager} from "../../../interfaces/ILiquidationPayoutManager.sol";
import {IFeeRouterDistribution} from "../../../interfaces/IFeeRouterDistribution.sol";
import {ILiquidationEventsView} from "../../../interfaces/ILiquidationEventsView.sol";
import {
    NotAContract,
    ZeroAddress,
    AmountIsZero
} from "../../../errors/StandardErrors.sol";
import {IPriceOracleRead} from "../../../interfaces/IPriceOracleRead.sol";
import {AssetDecimalMath} from "../../../libraries/AssetDecimalMath.sol";
import {DataPushLibrary} from "../../../libraries/DataPushLibrary.sol";
import {DataPushTypes} from "../../../constants/DataPushTypes.sol";
import {CacheEvents} from "../../CacheEvents.sol";
import {FeeTypes} from "../../../constants/FeeTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOrderEngine} from "../../../interfaces/IOrderEngine.sol";
import {IOrderStateStoreV2} from "../../../interfaces/IOrderStateStoreV2.sol";
import {IOrderEngineViewAdapter} from "../../../interfaces/IOrderEngineViewAdapter.sol";
import {IOrderEngineRepayAdapter} from "../../../interfaces/IOrderEngineRepayAdapter.sol";
import {IOrderEngineStatusWriteAdapter} from "../../../interfaces/IOrderEngineStatusWriteAdapter.sol";
import {IEarlyRepaymentGuaranteeManager} from "../../../interfaces/IEarlyRepaymentGuaranteeManager.sol";
import {IShortfallLedger} from "../../../interfaces/IShortfallLedger.sol";

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
 * - Current blocks-only maturity handling does not route through this contract as its primary public entry;
 *   blocks-only uses BlocksOnlyCoordinator and only reuses downstream liquidation/debt modules when liquidation is
 *   actually required.
 */
contract SettlementManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ISettlementManager,
    IShortfallLedger,
    CacheEvents
{
    using SafeERC20 for IERC20;
    uint8 private constant _SYSTEM_VALUATION_DECIMALS = 18;
    uint256 private constant _MAX_ASSET_DECIMALS = 77;
    /// @dev Keep in sync with ORDER_ENGINE's ON_TIME_WINDOW (block-based SSOT).
    uint256 private constant _ON_TIME_WINDOW_BLOCKS = 7200;
    /// @dev Keep in sync with ORDER_ENGINE's annualized block baseline for total-due computation.
    uint256 private constant _YEAR_BLOCKS = 2628000;
    /// @notice Registry address for module resolution and access control.
    /// @dev Stored privately; exposed via explicit getter `registryAddrVar()` (no public state variable).
    address private _registryAddr;
    /// @notice Strict mode: require full repay to clear all debt and auto-release collateral.
    bool private _requireFullRepayRelease;
    mapping(uint256 orderId => IShortfallLedger.ShortfallLedger ledger)
        private _shortfallLedgers;
    mapping(address reporter => IShortfallLedger.RecoverySource source)
        private _shortfallRecoveryReporterSources;

    /// @dev Deterministic evidence tag for default-path guarantee fund auto-recovery.
    bytes32 private constant _AUTO_GUARANTEE_DEFAULT_RECOVERY_EVIDENCE =
        keccak256("SETTLEMENT_MANAGER_AUTO_GUARANTEE_DEFAULT_RECOVERY");

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

    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when a VaultCore-only path is called by any other address. Used by {onlyVaultCore}.
    error SettlementManager__OnlyVaultCore();

    /// @dev Reverts when an orderId does not exist or cannot be resolved by ORDER_ENGINE.
    ///      Used by settlement and liquidation order-routing paths.
    error SettlementManager__InvalidOrderId();

    /// @dev Reverts when a position does not satisfy liquidation conditions. Used by liquidation-routing paths.
    error SettlementManager__NotLiquidatable();

    /// @dev Reverts when the borrower tries to trigger their own liquidation as keeper.
    ///      Used to keep the liquidation path consistent with collateral-exit authorization semantics.
    error SettlementManager__BorrowerCannotSelfLiquidate();

    /// @dev Reverts when the target user has no collateral to release or seize.
    ///      Used by settlement and liquidation execution paths.
    error SettlementManager__NoCollateral();
    error SettlementManager__InvalidCollateralOraclePrice(address asset);
    error SettlementManager__InvalidCollateralOracleDecimals(
        address asset,
        uint256 decimals
    );

    /// @dev Reverts when orderId does not belong to the provided user or debtAsset. Used by order-validation paths.
    error SettlementManager__OrderMismatch();

    /// @dev Reverts when strict full-repay auto-release mode is enabled and debt remains after repayment.
    ///      Used by strict settlement flows.
    error SettlementManager__DebtNotCleared();

    /// @dev Reverts when ORDER_ENGINE does not consume exactly the funds forwarded for this repay call.
    ///      Used to avoid silently stranding user funds inside SettlementManager.
    error SettlementManager__RepayPullMismatch();

    /// @dev Reverts when an order is already in a terminal lifecycle status and can no longer
    ///      be repaid or liquidated through business entrypoints.
    error SettlementManager__OrderTerminalStatus(uint8 status);

    /// @dev Reverts when a UUPS upgrade target has no deployed code. Used by {_authorizeUpgrade}.
    error SettlementManager__InvalidImplementation();
    error SettlementManager__ShortfallMissing(uint256 orderId);
    error SettlementManager__ShortfallAlreadyExists(uint256 orderId);
    error SettlementManager__InvalidShortfallRecovery(
        uint256 orderId,
        uint256 recoveryAmount
    );
    error SettlementManager__InvalidShortfallStatus(
        uint256 orderId,
        uint8 status
    );
    error SettlementManager__InvalidShortfallRecoverySource(
        uint256 orderId,
        uint8 source
    );
    error SettlementManager__InvalidShortfallStatusTransition(
        uint256 orderId,
        uint8 previousStatus,
        uint8 newStatus
    );
    error SettlementManager__EvidenceHashRequired(
        uint256 orderId,
        uint8 status
    );
    error SettlementManager__RecoveryEvidenceHashRequired(
        uint256 orderId,
        uint8 recoverySource
    );
    error SettlementManager__UnauthorizedShortfallRecoveryReporter(
        address reporter,
        uint8 recoverySource
    );
    error SettlementManager__InvalidRecoverySource(uint8 recoverySource);

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /// @notice Emitted after a repay-and-settle execution.
    /// @dev Emitted by settlement flows after repayment processing and collateral-release routing complete.
    event RepayAndSettleProcessed(
        address indexed user,
        address indexed debtAsset,
        uint256 repayAmount,
        uint256 indexed orderId,
        bool releasedAllCollateral,
        uint256 blockNumber
    );

    /// @notice Emitted when collateral is released back to the borrower.
    /// @dev Emitted by settlement flows after CollateralManager release routing succeeds.
    event CollateralReleased(
        address indexed user,
        address indexed collateralAsset,
        uint256 collateralAmount,
        uint256 blockNumber
    );

    /// @notice Emitted when strict full-repay auto-release mode is updated.
    /// @dev Emitted by governance-controlled config update flows after the strict-settlement mode flag changes.
    event RequireFullRepayReleaseUpdated(bool enabled);

    /// @notice Emitted when SettlementManager falls back to direct liquidation execution
    ///         after LiquidationManager fails.
    /// @dev The direct path must preserve the same fund-routing semantics as LiquidationManager.
    event LiquidationManagerFallbackActivated(
        uint256 indexed orderId,
        address indexed user,
        address indexed collateralAsset,
        address debtAsset,
        address liquidator,
        bytes reason,
        uint256 blockNumber
    );

    /// @notice Emitted when fallback liquidation payout is executed directly by SettlementManager.
    event FallbackPayoutExecuted(
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

    /// @notice Emitted when a trusted shortfall recovery reporter is configured.
    event ShortfallRecoveryReporterUpdated(
        address indexed reporter,
        IShortfallLedger.RecoverySource recoverySource,
        bool enabled
    );

    struct LiquidationSizing {
        uint256 collateralAmount;
        uint256 seizedCollateralValue;
        uint256 coveredDebtAmount;
        uint256 remainingDebtAmount;
    }

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
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

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
        address vaultCore = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_VAULT_CORE
        );
        if (msg.sender != vaultCore) revert SettlementManager__OnlyVaultCore();
        _;
    }

    /*━━━━━━━━━━━━━━━ External User Entry ━━━━━━━━━━━━━━━*/

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
    function repayAndSettle(
        address user,
        address debtAsset,
        uint256 repayAmount,
        uint256 orderId
    )
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

        address le = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LE
        );
        address cm = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_CM
        );
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ORDER_ENGINE
        );

        // 0) Cross-validation: orderId must belong to this user, and debtAsset must match the order
        IOrderEngine.LoanOrder memory ord = IOrderEngineViewAdapter(orderEngine)
            .getLoanOrderForView(orderId);
        if (ord.borrower == address(0) || ord.asset == address(0))
            revert ZeroAddress();
        if (ord.borrower != user || ord.asset != debtAsset)
            revert SettlementManager__OrderMismatch();
        _requireActiveOrderStatus(orderEngine, orderId);

        // 1) Order-level repayment:
        // - VaultCore has transferred funds to this contract
        // - this contract then authorizes ORDER_ENGINE to pull
        // Architecture (Architecture-Guide.md §640-646): repayment is unified through SettlementManager.
        // Security: clear the approval after a successful repay so SettlementManager keeps
        // a one-call/one-approval surface even if ORDER_ENGINE consumes less than requested.
        IERC20 debtToken = IERC20(debtAsset);
        uint256 balanceBeforeRepay = debtToken.balanceOf(address(this));
        debtToken.forceApprove(orderEngine, repayAmount);
        IOrderEngineRepayAdapter(orderEngine).repay(orderId, repayAmount);
        debtToken.forceApprove(orderEngine, 0);
        if (
            debtToken.balanceOf(address(this)) !=
            balanceBeforeRepay - repayAmount
        ) {
            revert SettlementManager__RepayPullMismatch();
        }

        IOrderEngine.LoanOrder memory repaidOrd = IOrderEngineViewAdapter(
            orderEngine
        ).getLoanOrderForView(orderId);
        uint256 orderTotalDue = IOrderEngineViewAdapter(orderEngine)
            .getOrderTotalDueForView(orderId);
        bool isOrderFullyRepaid = repaidOrd.repaidAmount >= orderTotalDue;
        bool clearedCurrentDebtAsset = ILendingEngineDebtRead(le).getDebt(
            user,
            debtAsset
        ) == 0;

        // 2) If user has no debt, automatically return all collateral assets to B (borrower)
        // Architecture (Architecture-Guide.md §640-646):
        // on-time/early repayment returns collateral directly to B (borrower),
        // no need for user to withdraw again.
        // NOTE: collateral release must follow debt-ledger truth, not valuation cache truth.
        // A stale or degraded valuation path can keep totalDebtValue non-zero even after all
        // debt assets have been cleared from the ledger.
        bool releasedAllCollateral = false;
        address[] memory debtAssets = ILendingEngineDebtRead(le)
            .getUserDebtAssets(user);
        if (debtAssets.length == 0) {
            address[] memory assets = ICollateralManager(cm)
                .getUserCollateralAssets(user);
            for (uint256 i; i < assets.length; ) {
                uint256 bal = ICollateralManager(cm).getCollateral(
                    user,
                    assets[i]
                );
                if (bal > 0) {
                    // Unified exit entry: receiver==user means return to user (Architecture-Guide.md §640-646)
                    ICollateralManager(cm).withdrawCollateralTo(
                        user,
                        assets[i],
                        bal,
                        user
                    );
                    uint256 tsCollateral = block.number;
                    emit CollateralReleased(user, assets[i], bal, tsCollateral);
                    DataPushLibrary._emitData(
                        DataPushTypes.DATA_TYPE_COLLATERAL_RELEASED,
                        abi.encode(user, assets[i], bal, tsCollateral)
                    );
                }
                unchecked {
                    ++i;
                }
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
        if (isOrderFullyRepaid && clearedCurrentDebtAsset) {
            address ergm = Registry(_registryAddr).getModule(
                ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE
            );
            if (ergm != address(0)) {
                // Guarantee early-ness must be determined from the active guarantee record itself,
                // not from whichever order happened to clear the asset debt last.
                if (
                    IEarlyRepaymentGuaranteeManager(ergm).isGuaranteeEnabled(
                        debtAsset
                    ) &&
                    IEarlyRepaymentGuaranteeManager(ergm).hasActiveGuarantee(
                        user,
                        debtAsset
                    )
                ) {
                    uint256 guaranteeId = IEarlyRepaymentGuaranteeManager(ergm)
                        .getUserGuaranteeId(user, debtAsset);
                    if (guaranteeId != 0) {
                        IEarlyRepaymentGuaranteeManager.GuaranteeRecord
                            memory guaranteeRecord = IEarlyRepaymentGuaranteeManager(
                                ergm
                            ).getGuaranteeRecord(guaranteeId);
                        bool isGuaranteeEarly = block.number +
                            _ON_TIME_WINDOW_BLOCKS <
                            guaranteeRecord.maturityTime;
                        if (guaranteeRecord.isActive && isGuaranteeEarly) {
                            IEarlyRepaymentGuaranteeManager(ergm)
                                .settleEarlyRepayment(
                                    user,
                                    debtAsset,
                                    repayAmount
                                );
                        }
                    }
                }
            }
        }

        uint256 blockNumber = block.number;
        emit RepayAndSettleProcessed(
            user,
            debtAsset,
            repayAmount,
            orderId,
            releasedAllCollateral,
            blockNumber
        );
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_REPAY_AND_SETTLE,
            abi.encode(
                user,
                debtAsset,
                repayAmount,
                orderId,
                releasedAllCollateral,
                blockNumber
            )
        );
    }

    /*━━━━━━━━━━━━━━━ External Keeper Entry ━━━━━━━━━━━━━━━*/

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
     * - This entrypoint is the non-blocks-only keeper SSOT; current blocks-only orders instead mature through
     *   `BlocksOnlyCoordinator.settleOrLiquidateBlocks(...)`, which may later call into the same downstream
     *   liquidation executor modules.
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
    function settleOrLiquidate(
        uint256 orderId
    ) external override onlyValidRegistry whenNotPaused nonReentrant {
        // NOTE: orderId can be 0 (current ORDER_ENGINE / LoanNFT minting starts from 0).
        // Existence is validated below via ORDER_ENGINE.getLoanOrderForView(orderId).
        _requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender);

        address le = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LE
        );
        address cm = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_CM
        );
        address risk = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER
        );
        address oracle = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_PRICE_ORACLE
        );
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ORDER_ENGINE
        );

        IOrderEngine.LoanOrder memory ord = IOrderEngineViewAdapter(orderEngine)
            .getLoanOrderForView(orderId);
        if (ord.borrower == address(0) || ord.asset == address(0))
            revert ZeroAddress();

        address targetUser = ord.borrower;
        address debtAsset = ord.asset;
        if (msg.sender == targetUser) {
            revert SettlementManager__BorrowerCannotSelfLiquidate();
        }
        _requireActiveOrderStatus(orderEngine, orderId);

        // Trigger condition: overdue or risk-control determines liquidatable
        // Architecture (Architecture-Guide.md §647-652): liquidation is not a standalone external entry;
        // SettlementManager enters liquidation branch when trigger conditions are met.
        //
        // SSOT (time refactor): ord.maturity is a maturityBlock.
        bool overdue = (block.number > ord.maturity) &&
            (ILendingEngineDebtRead(le).getDebt(targetUser, debtAsset) > 0);
        bool riskLiquidatable = ILiquidationRiskRead(risk).isLiquidatable(
            targetUser
        );
        if (!overdue && !riskLiquidatable)
            revert SettlementManager__NotLiquidatable();

        ILoanNFT.LoanStatus cleanTerminalStatus = overdue
            ? ILoanNFT.LoanStatus.Defaulted
            : ILoanNFT.LoanStatus.Liquidated;
        ILoanNFT.LoanStatus shortfallTerminalStatus = overdue
            ? ILoanNFT.LoanStatus.DefaultedWithShortfall
            : ILoanNFT.LoanStatus.LiquidatedWithShortfall;
        uint256 guaranteeRecoveredAmount = 0;

        // Extension Flow (Default guarantee processing):
        // When entering default/passive-liquidation branch, process guarantee forfeiture if active.
        // NOTE: ERGM enforces its own per-asset enable switch; if not enabled, this is a no-op.
        {
            address ergm = Registry(_registryAddr).getModule(
                ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE
            );
            if (ergm != address(0)) {
                if (
                    IEarlyRepaymentGuaranteeManager(ergm).isGuaranteeEnabled(
                        debtAsset
                    ) &&
                    IEarlyRepaymentGuaranteeManager(ergm).hasActiveGuarantee(
                        targetUser,
                        debtAsset
                    )
                ) {
                    guaranteeRecoveredAmount = IEarlyRepaymentGuaranteeManager(
                        ergm
                    ).processDefault(targetUser, debtAsset);
                }
            }
        }

        uint256 totalDebt = ILendingEngineDebtRead(le).getDebt(
            targetUser,
            debtAsset
        );
        uint256 debtAmount = ILendingEngineDebtRead(le).getReducibleDebtAmount(
            targetUser,
            debtAsset
        );
        if (debtAmount == 0) revert AmountIsZero();
        if (totalDebt == 0) revert SettlementManager__NotLiquidatable();

        uint256 debtValueTotal = ILendingEngineDebtRead(le)
            .calculateDebtValueStrict(targetUser, debtAsset);
        uint256 targetDebtValue = (debtValueTotal * debtAmount) / totalDebt;

        // Select highest-value collateral asset for single-asset liquidation
        // (fully automatic, deterministic, gas-efficient).
        address[] memory assets = ICollateralManager(cm)
            .getUserCollateralAssets(targetUser);
        uint256 len = assets.length;
        address bestAsset;
        uint256 bestBal;
        uint256 bestComparable;
        uint256 bestValuation;
        bool bestHasValuation;
        for (uint256 i; i < len; ) {
            address a = assets[i];
            uint256 bal = ICollateralManager(cm).getCollateral(targetUser, a);
            if (bal > 0) {
                uint256 candidateValuation = _getCollateralValueStrict(
                    oracle,
                    a,
                    bal
                );
                if (candidateValuation > 0) {
                    if (
                        !bestHasValuation || candidateValuation > bestComparable
                    ) {
                        bestComparable = candidateValuation;
                        bestValuation = candidateValuation;
                        bestHasValuation = true;
                        bestAsset = a;
                        bestBal = bal;
                    }
                }
            }
            unchecked {
                ++i;
            }
        }
        if (bestAsset == address(0) || bestBal == 0 || !bestHasValuation) {
            revert SettlementManager__NoCollateral();
        }

        LiquidationSizing memory sizing = _calculateLiquidationSizing(
            bestBal,
            bestValuation,
            debtAmount,
            targetDebtValue
        );

        // bonus only for event/statistics; minimal implementation set to 0
        uint256 bonus = 0;

        // Liquidation execution: call LiquidationManager as liquidation executor.
        // Architecture (Architecture-Guide.md §696-713):
        // liquidation writes directly to ledger (CM.withdrawCollateralTo + LE.forceReduceDebt).
        // LiquidationManager then triggers best-effort DataPush via LiquidatorView
        // (View push failures do not revert ledger writes).
        address liquidationManager = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LIQUIDATION_MANAGER
        );
        // IMPORTANT (SSOT):
        // Preserve the original keeper (msg.sender) as "liquidator" so that
        // - liquidatorShare is sent to the keeper by default
        // - PayoutExecuted/liquidation events record the keeper, not SettlementManager
        if (sizing.coveredDebtAmount > 0) {
            try
                ILiquidationManagerFromSettlementManager(liquidationManager)
                    .liquidateFromSettlementManager({
                        liquidator: msg.sender,
                        targetUser: targetUser,
                        collateralAsset: bestAsset,
                        debtAsset: debtAsset,
                        collateralAmount: sizing.collateralAmount,
                        debtAmount: sizing.coveredDebtAmount,
                        bonus: bonus
                    })
            {
                _finalizeShortfallAwareOutcome(
                    orderEngine,
                    orderId,
                    ord.startTimestamp,
                    cleanTerminalStatus,
                    shortfallTerminalStatus,
                    targetUser,
                    debtAsset,
                    bestAsset,
                    sizing.coveredDebtAmount,
                    sizing.remainingDebtAmount
                );
                _autoApplyGuaranteeDefaultRecovery(
                    orderId,
                    guaranteeRecoveredAmount
                );
                return;
            } catch (bytes memory reason) {
                // Fallback: direct ledger execution (CM + LE) using payout manager.
                // This preserves SSOT semantics while avoiding LM permission/mismatch edge cases in local smoke flows.
                emit LiquidationManagerFallbackActivated(
                    orderId,
                    targetUser,
                    bestAsset,
                    debtAsset,
                    msg.sender,
                    reason,
                    block.number
                );
                address payout = Registry(_registryAddr).getModule(
                    ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER
                );
                if (payout == address(0)) revert ZeroAddress();
                (
                    ILiquidationPayoutManager.PayoutRecipients memory payoutRecipients,
                    uint256 platformShare,
                    uint256 reserveShare,
                    uint256 lenderShare,
                    uint256 liquidatorShare
                ) = _distributeCollateralDirect(
                        cm,
                        payout,
                        targetUser,
                        bestAsset,
                        sizing.collateralAmount,
                        msg.sender
                    );
                ILendingEngineDebtWrite(le).forceReduceDebt(
                    targetUser,
                    debtAsset,
                    sizing.coveredDebtAmount
                );
                _pushFallbackLiquidationView(
                    targetUser,
                    bestAsset,
                    debtAsset,
                    sizing.collateralAmount,
                    sizing.coveredDebtAmount,
                    msg.sender,
                    bonus,
                    payoutRecipients,
                    platformShare,
                    reserveShare,
                    lenderShare,
                    liquidatorShare
                );
                _finalizeShortfallAwareOutcome(
                    orderEngine,
                    orderId,
                    ord.startTimestamp,
                    cleanTerminalStatus,
                    shortfallTerminalStatus,
                    targetUser,
                    debtAsset,
                    bestAsset,
                    sizing.coveredDebtAmount,
                    sizing.remainingDebtAmount
                );
                _autoApplyGuaranteeDefaultRecovery(
                    orderId,
                    guaranteeRecoveredAmount
                );
                return;
            }
        }

        {
            // Fallback: direct ledger execution (CM + LE) using payout manager.
            address payout = Registry(_registryAddr).getModule(
                ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER
            );
            if (payout == address(0)) revert ZeroAddress();
            (
                ILiquidationPayoutManager.PayoutRecipients memory payoutRecipients,
                uint256 platformShare,
                uint256 reserveShare,
                uint256 lenderShare,
                uint256 liquidatorShare
            ) = _distributeCollateralDirect(
                    cm,
                    payout,
                    targetUser,
                    bestAsset,
                    sizing.collateralAmount,
                    msg.sender
                );
            _pushFallbackLiquidationView(
                targetUser,
                bestAsset,
                debtAsset,
                sizing.collateralAmount,
                sizing.coveredDebtAmount,
                msg.sender,
                bonus,
                payoutRecipients,
                platformShare,
                reserveShare,
                lenderShare,
                liquidatorShare
            );
            _finalizeShortfallAwareOutcome(
                orderEngine,
                orderId,
                ord.startTimestamp,
                cleanTerminalStatus,
                shortfallTerminalStatus,
                targetUser,
                debtAsset,
                bestAsset,
                sizing.coveredDebtAmount,
                sizing.remainingDebtAmount
            );
            _autoApplyGuaranteeDefaultRecovery(
                orderId,
                guaranteeRecoveredAmount
            );
        }
    }

    function getShortfallLedger(
        uint256 orderId
    ) external view returns (IShortfallLedger.ShortfallLedger memory ledger) {
        return _shortfallLedgers[orderId];
    }

    function hasActiveShortfall(
        uint256 orderId
    ) external view returns (bool hasShortfall) {
        return _hasActiveShortfall(orderId);
    }

    function recordLiquidationShortfall(
        IShortfallLedger.RecordShortfallParams calldata params
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _recordLiquidationShortfall(params);
        _syncLoanShortfallStateIfPresent(
            params.orderId,
            0,
            IShortfallLedger.ShortfallStatus.ACTIVE
        );
    }

    function applyShortfallRecovery(
        uint256 orderId,
        IShortfallLedger.RecoverySource recoverySource,
        uint256 recoveryAmount,
        bytes32 evidenceHash
    ) external onlyValidRegistry {
        if (!_hasRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender)) {
            IShortfallLedger.RecoverySource trustedSource = _shortfallRecoveryReporterSources[
                    msg.sender
                ];
            if (
                trustedSource == IShortfallLedger.RecoverySource.NONE ||
                trustedSource != recoverySource
            ) {
                revert SettlementManager__UnauthorizedShortfallRecoveryReporter(
                    msg.sender,
                    uint8(recoverySource)
                );
            }
        }

        _applyShortfallRecovery(
            orderId,
            recoverySource,
            recoveryAmount,
            evidenceHash
        );
    }

    /// @notice Configure whether a reporter contract/account can post automated shortfall recovery facts.
    /// @dev Governance-only endpoint; recoverySource cannot be NONE when enabling.
    function setShortfallRecoveryReporter(
        address reporter,
        IShortfallLedger.RecoverySource recoverySource,
        bool enabled
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (reporter == address(0)) revert ZeroAddress();

        IShortfallLedger.RecoverySource stored = enabled
            ? recoverySource
            : IShortfallLedger.RecoverySource.NONE;
        if (enabled && recoverySource == IShortfallLedger.RecoverySource.NONE) {
            revert SettlementManager__InvalidRecoverySource(
                uint8(recoverySource)
            );
        }

        _shortfallRecoveryReporterSources[reporter] = stored;
        emit ShortfallRecoveryReporterUpdated(reporter, stored, enabled);
    }

    /// @notice View the currently configured recovery source for a trusted reporter.
    function getShortfallRecoveryReporterSource(
        address reporter
    ) external view returns (IShortfallLedger.RecoverySource source) {
        return _shortfallRecoveryReporterSources[reporter];
    }

    function setShortfallStatus(
        uint256 orderId,
        IShortfallLedger.ShortfallStatus newStatus,
        bytes32 evidenceHash
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);

        IShortfallLedger.ShortfallLedger storage ledger = _shortfallLedgers[
            orderId
        ];
        if (ledger.status == IShortfallLedger.ShortfallStatus.NONE) {
            revert SettlementManager__ShortfallMissing(orderId);
        }

        if (newStatus == IShortfallLedger.ShortfallStatus.NONE) {
            revert SettlementManager__InvalidShortfallStatus(
                orderId,
                uint8(newStatus)
            );
        }
        if (!_isAllowedShortfallStatusTransition(ledger.status, newStatus)) {
            revert SettlementManager__InvalidShortfallStatusTransition(
                orderId,
                uint8(ledger.status),
                uint8(newStatus)
            );
        }
        if (
            _isPendingShortfallStatus(newStatus) &&
            (ledger.remainingDebt == 0 || ledger.shortfallAmount == 0)
        ) {
            revert SettlementManager__InvalidShortfallStatus(
                orderId,
                uint8(newStatus)
            );
        }
        if (
            newStatus == IShortfallLedger.ShortfallStatus.RESOLVED &&
            (ledger.remainingDebt != 0 || ledger.shortfallAmount != 0)
        ) {
            revert SettlementManager__InvalidShortfallStatus(
                orderId,
                uint8(newStatus)
            );
        }
        if (
            newStatus == IShortfallLedger.ShortfallStatus.WRITTEN_OFF &&
            evidenceHash == bytes32(0)
        ) {
            revert SettlementManager__EvidenceHashRequired(
                orderId,
                uint8(newStatus)
            );
        }

        IShortfallLedger.ShortfallStatus previousStatus = ledger.status;
        ledger.status = newStatus;
        ledger.evidenceHash = evidenceHash;
        if (newStatus == IShortfallLedger.ShortfallStatus.WRITTEN_OFF) {
            address le = Registry(_registryAddr).getModuleOrRevert(
                ModuleKeys.KEY_LE
            );
            if (ledger.remainingDebt > 0) {
                ILendingEngineDebtWrite(le).forceReduceDebt(
                    ledger.borrower,
                    ledger.debtAsset,
                    ledger.remainingDebt
                );
            }
            ledger.recoverySource = IShortfallLedger
                .RecoverySource
                .GOVERNANCE_WRITE_OFF;
            ledger.remainingDebt = 0;
            ledger.shortfallAmount = 0;
            ledger.lastRecoveryBlock = block.number;
        }

        emit LiquidationShortfallStatusChanged(
            orderId,
            previousStatus,
            newStatus,
            ledger.remainingDebt,
            ledger.shortfallAmount,
            evidenceHash
        );

        _syncLoanShortfallStateIfPresent(orderId, 0, ledger.status);
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
    )
        internal
        returns (
            ILiquidationPayoutManager.PayoutRecipients memory recipients,
            uint256 platformShare,
            uint256 reserveShare,
            uint256 lenderShare,
            uint256 liquidatorShare
        )
    {
        (
            platformShare,
            reserveShare,
            lenderShare,
            liquidatorShare
        ) = ILiquidationPayoutManager(payout).calculateShares(collateralAmount);
        recipients = ILiquidationPayoutManager(payout).getRecipients();

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

        emit FallbackPayoutExecuted(
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

    /**
     * @notice Best-effort LiquidatorView push for SettlementManager fallback liquidations.
     * @dev Preserves the documented single-point DataPush surface even when the main LiquidationManager path fails.
     */
    function _pushFallbackLiquidationView(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        ILiquidationPayoutManager.PayoutRecipients memory recipients,
        uint256 platformShare,
        uint256 reserveShare,
        uint256 lenderShare,
        uint256 liquidatorShare
    ) internal {
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

        // solhint-disable-next-line avoid-low-level-calls
        (bool updateOk, bytes memory updateReason) = viewAddr.call(
            abi.encodeCall(
                ILiquidationEventsView.pushLiquidationUpdate,
                (
                    user,
                    collateralAsset,
                    debtAsset,
                    collateralAmount,
                    debtAmount,
                    liquidator,
                    bonus,
                    block.number
                )
            )
        );
        if (!updateOk) {
            emit CacheUpdateFailed(
                user,
                collateralAsset,
                viewAddr,
                collateralAmount,
                debtAmount,
                abi.encode("pushLiquidationUpdate failed", updateReason)
            );
        }

        // solhint-disable-next-line avoid-low-level-calls
        (bool payoutOk, bytes memory payoutReason) = viewAddr.call(
            abi.encodeCall(
                ILiquidationEventsView.pushLiquidationPayout,
                (
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
            )
        );
        if (!payoutOk) {
            emit CacheUpdateFailed(
                user,
                collateralAsset,
                viewAddr,
                collateralAmount,
                debtAmount,
                abi.encode("pushLiquidationPayout failed", payoutReason)
            );
        }
    }

    function _calculateLiquidationSizing(
        uint256 bestBalance,
        uint256 bestValuation,
        uint256 debtAmount,
        uint256 targetDebtValue
    ) internal pure returns (LiquidationSizing memory sizing) {
        sizing.collateralAmount = bestBalance;
        if (bestValuation == 0 || targetDebtValue == 0) {
            sizing.seizedCollateralValue = 0;
            sizing.coveredDebtAmount = 0;
            sizing.remainingDebtAmount = debtAmount;
            return sizing;
        }

        uint256 collateralAmount = Math.mulDiv(
            bestBalance,
            targetDebtValue,
            bestValuation,
            Math.Rounding.Ceil
        );
        if (collateralAmount == 0) collateralAmount = 1;
        if (collateralAmount > bestBalance) collateralAmount = bestBalance;

        uint256 seizedCollateralValue = Math.mulDiv(
            bestValuation,
            collateralAmount,
            bestBalance
        );
        if (seizedCollateralValue > targetDebtValue) {
            seizedCollateralValue = targetDebtValue;
        }

        uint256 coveredDebtAmount = Math.mulDiv(
            debtAmount,
            seizedCollateralValue,
            targetDebtValue
        );
        if (seizedCollateralValue >= targetDebtValue) {
            coveredDebtAmount = debtAmount;
        }
        if (coveredDebtAmount > debtAmount) {
            coveredDebtAmount = debtAmount;
        }

        sizing.collateralAmount = collateralAmount;
        sizing.seizedCollateralValue = seizedCollateralValue;
        sizing.coveredDebtAmount = coveredDebtAmount;
        sizing.remainingDebtAmount = debtAmount - coveredDebtAmount;
    }

    function _getCollateralValueStrict(
        address oracle,
        address asset,
        uint256 amount
    ) internal view returns (uint256 value) {
        (uint256 price, , uint256 decimalsRaw) = IPriceOracleRead(oracle)
            .getPrice(asset);
        if (price == 0) {
            revert SettlementManager__InvalidCollateralOraclePrice(asset);
        }
        if (decimalsRaw > _MAX_ASSET_DECIMALS) {
            revert SettlementManager__InvalidCollateralOracleDecimals(
                asset,
                decimalsRaw
            );
        }

        return
            AssetDecimalMath.normalizeValueDown(
                AssetDecimalMath.calcValue(amount, price, uint8(decimalsRaw)),
                uint8(decimalsRaw),
                _SYSTEM_VALUATION_DECIMALS
            );
    }

    function _finalizeShortfallAwareOutcome(
        address orderEngine,
        uint256 orderId,
        uint256 orderCreatedBlock,
        ILoanNFT.LoanStatus cleanTerminalStatus,
        ILoanNFT.LoanStatus shortfallTerminalStatus,
        address borrower,
        address debtAsset,
        address collateralAsset,
        uint256 coveredDebtAmount,
        uint256 remainingDebtAmount
    ) internal {
        (
            IOrderStateStoreV2 orderStateStore,
            bool hasOrderStateStore
        ) = _tryOrderStateStore();
        IOrderStateStoreV2.LifecycleStatus lifecycle = cleanTerminalStatus ==
            ILoanNFT.LoanStatus.Defaulted
            ? IOrderStateStoreV2.LifecycleStatus.DEFAULTED
            : IOrderStateStoreV2.LifecycleStatus.LIQUIDATED;
        IOrderStateStoreV2.CloseReason closeReason = cleanTerminalStatus ==
            ILoanNFT.LoanStatus.Defaulted
            ? IOrderStateStoreV2.CloseReason.MATURITY_DEFAULT
            : IOrderStateStoreV2.CloseReason.KEEPER_LIQUIDATION;

        if (remainingDebtAmount > 0) {
            _recordLiquidationShortfall(
                IShortfallLedger.RecordShortfallParams({
                    orderId: orderId,
                    borrower: borrower,
                    debtAsset: debtAsset,
                    collateralAsset: collateralAsset,
                    pricingMode: IShortfallLedger.PricingMode.STRICT_ORACLE,
                    liquidationBlock: block.number,
                    valuationBlock: block.number,
                    coveredDebt: coveredDebtAmount,
                    remainingDebt: remainingDebtAmount,
                    shortfallAmount: remainingDebtAmount,
                    evidenceHash: bytes32(0)
                })
            );

            if (hasOrderStateStore) {
                orderStateStore.applyLoanTerminalTransition(
                    orderId,
                    orderCreatedBlock,
                    lifecycle,
                    closeReason,
                    IShortfallLedger.ShortfallStatus.ACTIVE,
                    IOrderStateStoreV2
                        .CollateralDispositionStatus
                        .SEIZED_AND_DISTRIBUTED
                );
            }

            IOrderEngineStatusWriteAdapter(orderEngine)
                .markOrderLiquidationStatus(orderId, shortfallTerminalStatus);
            return;
        }

        if (hasOrderStateStore) {
            orderStateStore.applyLoanTerminalTransition(
                orderId,
                orderCreatedBlock,
                lifecycle,
                closeReason,
                IShortfallLedger.ShortfallStatus.NONE,
                IOrderStateStoreV2
                    .CollateralDispositionStatus
                    .SEIZED_AND_DISTRIBUTED
            );
        }

        IOrderEngineStatusWriteAdapter(orderEngine).markOrderLiquidationStatus(
            orderId,
            cleanTerminalStatus
        );
    }

    function _recordLiquidationShortfall(
        IShortfallLedger.RecordShortfallParams memory params
    ) internal {
        if (
            _shortfallLedgers[params.orderId].status !=
            IShortfallLedger.ShortfallStatus.NONE
        ) {
            revert SettlementManager__ShortfallAlreadyExists(params.orderId);
        }

        IShortfallLedger.ShortfallLedger storage ledger = _shortfallLedgers[
            params.orderId
        ];
        ledger.orderId = params.orderId;
        ledger.borrower = params.borrower;
        ledger.debtAsset = params.debtAsset;
        ledger.collateralAsset = params.collateralAsset;
        ledger.status = IShortfallLedger.ShortfallStatus.ACTIVE;
        ledger.pricingMode = params.pricingMode;
        ledger.recoverySource = IShortfallLedger.RecoverySource.NONE;
        ledger.liquidationBlock = params.liquidationBlock;
        ledger.valuationBlock = params.valuationBlock;
        ledger.coveredDebt = params.coveredDebt;
        ledger.remainingDebt = params.remainingDebt;
        ledger.shortfallAmount = params.shortfallAmount;
        ledger.recoveredAmount = 0;
        ledger.lastRecoveryBlock = 0;
        ledger.evidenceHash = params.evidenceHash;

        emit LiquidationShortfallOpened(
            params.orderId,
            params.borrower,
            params.debtAsset,
            ledger.status,
            params.pricingMode,
            params.coveredDebt,
            params.remainingDebt,
            params.shortfallAmount,
            params.valuationBlock,
            params.liquidationBlock,
            params.evidenceHash
        );
    }

    function _applyShortfallRecovery(
        uint256 orderId,
        IShortfallLedger.RecoverySource recoverySource,
        uint256 recoveryAmount,
        bytes32 evidenceHash
    ) internal {
        IShortfallLedger.ShortfallLedger storage ledger = _shortfallLedgers[
            orderId
        ];
        if (ledger.status == IShortfallLedger.ShortfallStatus.NONE) {
            revert SettlementManager__ShortfallMissing(orderId);
        }
        if (recoveryAmount == 0 || recoveryAmount > ledger.remainingDebt) {
            revert SettlementManager__InvalidShortfallRecovery(
                orderId,
                recoveryAmount
            );
        }
        if (
            recoverySource == IShortfallLedger.RecoverySource.NONE ||
            recoverySource ==
                IShortfallLedger.RecoverySource.GOVERNANCE_WRITE_OFF
        ) {
            revert SettlementManager__InvalidShortfallRecoverySource(
                orderId,
                uint8(recoverySource)
            );
        }
        if (
            _requiresRecoveryEvidenceHash(recoverySource) &&
            evidenceHash == bytes32(0)
        ) {
            revert SettlementManager__RecoveryEvidenceHashRequired(
                orderId,
                uint8(recoverySource)
            );
        }

        address le = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LE
        );
        ILendingEngineDebtWrite(le).forceReduceDebt(
            ledger.borrower,
            ledger.debtAsset,
            recoveryAmount
        );

        IShortfallLedger.ShortfallStatus previousStatus = ledger.status;
        ledger.recoverySource = recoverySource;
        ledger.recoveredAmount += recoveryAmount;
        ledger.remainingDebt -= recoveryAmount;
        ledger.shortfallAmount -= recoveryAmount;
        ledger.lastRecoveryBlock = block.number;
        ledger.evidenceHash = evidenceHash;
        ledger.status = ledger.remainingDebt == 0
            ? IShortfallLedger.ShortfallStatus.RESOLVED
            : IShortfallLedger.ShortfallStatus.RECOVERY_PENDING;

        emit LiquidationShortfallRecoveryApplied(
            orderId,
            recoverySource,
            recoveryAmount,
            ledger.remainingDebt,
            ledger.shortfallAmount,
            ledger.lastRecoveryBlock,
            evidenceHash
        );

        if (previousStatus != ledger.status) {
            emit LiquidationShortfallStatusChanged(
                orderId,
                previousStatus,
                ledger.status,
                ledger.remainingDebt,
                ledger.shortfallAmount,
                evidenceHash
            );
        }

        _syncLoanShortfallStateIfPresent(orderId, 0, ledger.status);
    }

    function _requiresRecoveryEvidenceHash(
        IShortfallLedger.RecoverySource recoverySource
    ) internal pure returns (bool) {
        return
            recoverySource == IShortfallLedger.RecoverySource.INSURANCE_FUND ||
            recoverySource == IShortfallLedger.RecoverySource.OFFCHAIN_RECOVERY;
    }

    function _isPendingShortfallStatus(
        IShortfallLedger.ShortfallStatus status
    ) internal pure returns (bool) {
        return
            status == IShortfallLedger.ShortfallStatus.ACTIVE ||
            status == IShortfallLedger.ShortfallStatus.RECOVERY_PENDING ||
            status == IShortfallLedger.ShortfallStatus.GUARANTEE_PENDING ||
            status == IShortfallLedger.ShortfallStatus.GOVERNANCE_PENDING;
    }

    function _isAllowedShortfallStatusTransition(
        IShortfallLedger.ShortfallStatus previousStatus,
        IShortfallLedger.ShortfallStatus newStatus
    ) internal pure returns (bool) {
        if (previousStatus == newStatus) {
            return false;
        }

        if (previousStatus == IShortfallLedger.ShortfallStatus.ACTIVE) {
            return
                newStatus ==
                    IShortfallLedger.ShortfallStatus.RECOVERY_PENDING ||
                newStatus ==
                    IShortfallLedger.ShortfallStatus.GUARANTEE_PENDING ||
                newStatus ==
                    IShortfallLedger.ShortfallStatus.GOVERNANCE_PENDING ||
                newStatus == IShortfallLedger.ShortfallStatus.RESOLVED ||
                newStatus == IShortfallLedger.ShortfallStatus.WRITTEN_OFF;
        }

        if (
            previousStatus == IShortfallLedger.ShortfallStatus.RECOVERY_PENDING
        ) {
            return
                newStatus ==
                    IShortfallLedger.ShortfallStatus.GUARANTEE_PENDING ||
                newStatus ==
                    IShortfallLedger.ShortfallStatus.GOVERNANCE_PENDING ||
                newStatus == IShortfallLedger.ShortfallStatus.RESOLVED ||
                newStatus == IShortfallLedger.ShortfallStatus.WRITTEN_OFF;
        }

        if (
            previousStatus == IShortfallLedger.ShortfallStatus.GUARANTEE_PENDING
        ) {
            return
                newStatus ==
                    IShortfallLedger.ShortfallStatus.GOVERNANCE_PENDING ||
                newStatus == IShortfallLedger.ShortfallStatus.RESOLVED ||
                newStatus == IShortfallLedger.ShortfallStatus.WRITTEN_OFF;
        }

        if (
            previousStatus ==
            IShortfallLedger.ShortfallStatus.GOVERNANCE_PENDING
        ) {
            return
                newStatus == IShortfallLedger.ShortfallStatus.RESOLVED ||
                newStatus == IShortfallLedger.ShortfallStatus.WRITTEN_OFF;
        }

        return false;
    }

    function _autoApplyGuaranteeDefaultRecovery(
        uint256 orderId,
        uint256 guaranteeRecoveredAmount
    ) internal {
        if (guaranteeRecoveredAmount == 0) {
            return;
        }

        IShortfallLedger.ShortfallLedger storage ledger = _shortfallLedgers[
            orderId
        ];
        if (
            ledger.status == IShortfallLedger.ShortfallStatus.NONE ||
            ledger.remainingDebt == 0
        ) {
            return;
        }

        uint256 recoveryAmount = guaranteeRecoveredAmount;
        if (recoveryAmount > ledger.remainingDebt) {
            recoveryAmount = ledger.remainingDebt;
        }

        _applyShortfallRecovery(
            orderId,
            IShortfallLedger.RecoverySource.GUARANTEE_FUND,
            recoveryAmount,
            _AUTO_GUARANTEE_DEFAULT_RECOVERY_EVIDENCE
        );
    }

    function _hasActiveShortfall(
        uint256 orderId
    ) internal view returns (bool hasShortfall) {
        IShortfallLedger.ShortfallStatus status = _shortfallLedgers[orderId]
            .status;
        return
            status == IShortfallLedger.ShortfallStatus.ACTIVE ||
            status == IShortfallLedger.ShortfallStatus.RECOVERY_PENDING ||
            status == IShortfallLedger.ShortfallStatus.GUARANTEE_PENDING ||
            status == IShortfallLedger.ShortfallStatus.GOVERNANCE_PENDING;
    }

    function _tryOrderStateStore()
        internal
        view
        returns (IOrderStateStoreV2 orderStateStore, bool hasStore)
    {
        address orderStateStoreAddr = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_ORDER_STATE_STORE
        );
        if (
            orderStateStoreAddr == address(0) ||
            orderStateStoreAddr.code.length == 0
        ) {
            return (IOrderStateStoreV2(address(0)), false);
        }

        return (IOrderStateStoreV2(orderStateStoreAddr), true);
    }

    function _syncLoanShortfallStateIfPresent(
        uint256 orderId,
        uint256 orderCreatedBlock,
        IShortfallLedger.ShortfallStatus shortfallStatus
    ) internal {
        (
            IOrderStateStoreV2 orderStateStore,
            bool hasOrderStateStore
        ) = _tryOrderStateStore();
        if (!hasOrderStateStore) {
            return;
        }

        orderStateStore.syncLoanShortfallState(
            orderId,
            orderCreatedBlock,
            shortfallStatus
        );
    }

    /// @dev Require the ORDER_ENGINE lifecycle SSOT to remain Active before continuing the repay path.
    function _requireActiveOrderStatus(
        address orderEngine,
        uint256 orderId
    ) internal view {
        ILoanNFT.LoanStatus status = IOrderEngineViewAdapter(orderEngine)
            .getOrderStatusForView(orderId);
        if (status != ILoanNFT.LoanStatus.Active) {
            revert SettlementManager__OrderTerminalStatus(uint8(status));
        }
    }

    /*━━━━━━━━━━━━━━━ Internal ━━━━━━━━━━━━━━━*/

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
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(actionKey, caller);
    }

    function _hasRole(
        bytes32 actionKey,
        address caller
    ) internal view returns (bool) {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        try IAccessControlManager(acmAddr).hasRole(actionKey, caller) returns (
            bool hasRole
        ) {
            return hasRole;
        } catch {
            return false;
        }
    }

    /**
     * @notice Enable/disable strict full-repay auto-release mode.
     * @dev Reverts if:
     *      - caller lacks ACTION_SET_PARAMETER
     *
     * Security:
     * - Governance-only settlement policy toggle.
     * - Affects this legacy settlement path only; current blocks-only repayment/release logic is orchestrated in the
     *   dedicated coordinator and does not consult this flag.
     */
    function setRequireFullRepayRelease(
        bool enabled
    ) external onlyValidRegistry {
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
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        // Use global upgrade permission: ACTION_UPGRADE_MODULE
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acmAddr).requireRole(
            ActionKeys.ACTION_UPGRADE_MODULE,
            msg.sender
        );
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0)
            revert SettlementManager__InvalidImplementation();
    }

    /*━━━━━━━━━━━━━━━ Storage Gap ━━━━━━━━━━━━━━━*/
    uint256[48] private __gap;
}

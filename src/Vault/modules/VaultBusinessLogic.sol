// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;



import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAssetWhitelist } from "../../interfaces/IAssetWhitelist.sol";
import { ICollateralManager } from "../../interfaces/ICollateralManager.sol";
import { SystemEvents } from "../SystemEvents.sol";
import { AmountIsZero, AssetNotAllowed, ArrayLengthMismatch, NotAContract, ZeroAddress } from "../../errors/StandardErrors.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { VaultBusinessLogicLibrary } from "../../libraries/VaultBusinessLogicLibrary.sol";
import { SettlementReserveLib } from "../../libraries/SettlementReserveLib.sol";
import { SettlementIntentLib } from "../../libraries/SettlementIntentLib.sol";
import { SettlementMatchLib } from "../../libraries/SettlementMatchLib.sol";
import { DataPushLibrary } from "../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../constants/DataPushTypes.sol";
import { Registry } from "../../registry/Registry.sol";
import { ILenderPoolVault } from "../../interfaces/ILenderPoolVault.sol";
import { IGuaranteeFundManager } from "../../interfaces/IGuaranteeFundManager.sol";
import { IEarlyRepaymentGuaranteeManager } from "../../interfaces/IEarlyRepaymentGuaranteeManager.sol";

/**
 * @title VaultBusinessLogic
 * @notice Business logic module for Vault (legacy entrypoints + settlement orchestration helpers).
 * @dev Reverts if:
 *      - (see individual functions)
 *
 * Security:
 * - UUPS upgrade authorization is role-gated via AccessControlManager (ACTION_UPGRADE_MODULE)
 * - Selected write entrypoints are pause-aware (whenNotPaused) and non-reentrant (nonReentrant)
 * - Module address resolution is SSOT via Registry (no local cache)
 *
 * Note:
 * - User-facing deposit/withdraw/repay paths are deprecated here and must go through VaultCore/VaultRouter SSOT.
 * - Offchain data push is emitted via DataPushLibrary for select settlement actions.
 *
 * @custom:security-contact security@example.com
 */

contract VaultBusinessLogic is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardUpgradeable,
    PausableUpgradeable 
{
    using SafeERC20 for IERC20;
    using SettlementReserveLib for mapping(bytes32 => SettlementReserveLib.LendReserve);

    /* ============ Storage ============ */
    /// @notice Registry contract address used to resolve module addresses.
    address private _registryAddr;
    
    /// @notice Settlement token address used for graceful-degradation configuration.
    address private _settlementTokenAddr;

    /// @notice Lender reserve ledger: intentHash => reserve record.
    mapping(bytes32 => SettlementReserveLib.LendReserve) private _lendReserves;

    /// @notice Intent match status: intentHash => matched flag.
    mapping(bytes32 => bool) private _matchedIntents;

    /// @notice Storage gap for upgrade safety
    uint256[48] private __gap;

    /* ============ Modifiers ============ */
    /// @notice Validates Registry address is set.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /* ============ Events ============ */

    /**
     * @notice Emitted when a lender reserve is created (funds moved into LenderPoolVault).
     * @param lendIntentHash Hash of the lend intent (EIP-712 struct hash).
     * @param lenderSigner Lender signer / fund owner.
     * @param asset ERC20 asset address.
     * @param amount Amount reserved (token native decimals).
     * @param blockNumber Legacy field: emit time axis marker (treated as blockNumber in this repo).
     */
    event LendReserveCreated(
        bytes32 indexed lendIntentHash,
        address indexed lenderSigner,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /// @notice Explicit block-based companion event for LendReserveCreated.
    event LendReserveCreatedV2(
        bytes32 indexed lendIntentHash,
        address indexed lenderSigner,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when a lender reserve is cancelled (funds returned from LenderPoolVault).
     * @param lendIntentHash Hash of the lend intent (EIP-712 struct hash).
     * @param lenderSigner Lender signer / fund owner (canceller).
     * @param asset ERC20 asset address.
     * @param amount Amount returned (token native decimals).
     * @param blockNumber Legacy field: emit time axis marker (treated as blockNumber in this repo).
     */
    event LendReserveCancelled(
        bytes32 indexed lendIntentHash,
        address indexed lenderSigner,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /// @notice Explicit block-based companion event for LendReserveCancelled.
    event LendReserveCancelledV2(
        bytes32 indexed lendIntentHash,
        address indexed lenderSigner,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when a lender reserve is consumed (used for a match).
     * @param lendIntentHash Hash of the lend intent (EIP-712 struct hash).
     * @param lenderSigner Lender signer / fund owner.
     * @param asset ERC20 asset address.
     * @param amount Amount consumed (token native decimals).
     * @param blockNumber Legacy field: emit time axis marker (treated as blockNumber in this repo).
     */
    event LendReserveConsumed(
        bytes32 indexed lendIntentHash,
        address indexed lenderSigner,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /// @notice Explicit block-based companion event for LendReserveConsumed.
    event LendReserveConsumedV2(
        bytes32 indexed lendIntentHash,
        address indexed lenderSigner,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    // This module no longer emits health-related events; they are handled by LendingEngine (LE) + View layer.

    /* ============ Constructor ============ */
    /**
     * @notice Constructs the implementation contract and disables initializers.
     * @dev Reverts if: (none)
     *
     * Security:
     * - Prevents the implementation contract from being initialized directly.
     */
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /* ============ Internal Functions ============ */
    
    /**
     * @notice Resolves a module address from Registry.
     * @dev Reverts if:
     *      - Registry(moduleKey) is not registered (Registry.getModuleOrRevert)
     * @param moduleKey Module key (see ModuleKeys).
     * @return Module address registered under moduleKey.
     */
    function _getModuleAddress(bytes32 moduleKey) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /**
     * @notice Best-effort lock + record the early-repayment guarantee on borrow-time (Extension Flow).
     * @dev Notes:
     * - This is an optional extension path controlled by ERGM's per-asset toggle.
     * - If the feature is disabled or modules are not registered, this function is a no-op.
     * - If enabled and configured, failures revert to avoid SSOT/accounting drift (资金链对账一致性).
     */
    function _maybeLockEarlyRepaymentGuarantee(
        address borrower,
        address lender,
        address asset,
        uint256 principal,
        uint16 termDays,
        uint256 annualRateBps
    ) internal {
        address ergm = Registry(_registryAddr).getModule(ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE);
        if (ergm == address(0)) return;
        if (!IEarlyRepaymentGuaranteeManager(ergm).isGuaranteeEnabled(asset)) return;

        uint256 promisedInterest = VaultBusinessLogicLibrary.calculateExpectedInterest(principal, annualRateBps, termDays);
        if (promisedInterest == 0) return;

        address gfm = _getModuleAddress(ModuleKeys.KEY_GUARANTEE_FUND);

        // (A) Custody in: pull guarantee from borrower into GuaranteeFundManager (SSOT).
        IGuaranteeFundManager(gfm).lockGuarantee(borrower, asset, promisedInterest);

        // (B) Semantic record: store guarantee record (no transfers in ERGM).
        IEarlyRepaymentGuaranteeManager(ergm).lockGuaranteeRecord(
            borrower,
            lender,
            asset,
            principal,
            promisedInterest,
            termDays
        );
    }

 

    /**
     * @notice Enforces AccessControlManager role for an action key.
     * @dev Reverts if:
     *      - AccessControlManager.requireRole fails (unauthorized)
     * @param actionKey Action key (see ActionKeys).
     * @param user Caller address to validate.
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = _getModuleAddress(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }


    /**
     * @notice Validates the asset is allowed by AssetWhitelist (if configured).
     * @dev Reverts if:
     *      - asset is not allowed (AssetNotAllowed)
     * @param asset ERC20 asset address.
     */
    function _checkAssetWhitelist(address asset) internal view {
        address assetWhitelist = _getModuleAddress(ModuleKeys.KEY_ASSET_WHITELIST);
        if (assetWhitelist != address(0)) {
            if (!IAssetWhitelist(assetWhitelist).isAssetAllowed(asset)) revert AssetNotAllowed();
        }
    }

    /* ============ Initializer ============ */
    /**
     * @notice Initializes VaultBusinessLogic module.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0) (ZeroAddress)
     *      - initialSettlementTokenAddr == address(0) (ZeroAddress)
     *
     * Security:
     * - Initializer can only be called once (initializer)
     *
     * @param initialRegistryAddr Registry contract address.
     * @param initialSettlementTokenAddr Settlement token address used for graceful degradation config.
     */
    function initialize(address initialRegistryAddr, address initialSettlementTokenAddr) external initializer {
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialSettlementTokenAddr == address(0)) revert ZeroAddress();
        
        _registryAddr = initialRegistryAddr;
        _settlementTokenAddr = initialSettlementTokenAddr;
        
        // Emit a standardized action event for off-chain observability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.number
        );
    }

    /* ============ Core Business Logic Functions ============ */
    
    /**
     * @notice DEPRECATED: Deposit must go through VaultCore/VaultRouter SSOT.
     * @dev Reverts if:
     *      - always (VaultBusinessLogic__UseVaultCoreEntry)
     *
     * Security:
     * - N/A (function is permanently disabled)
     *
     * @param user User address (unused).
     * @param asset Asset address (unused).
     * @param amount Amount to deposit (token native decimals; unused).
     */
    function deposit(address user, address asset, uint256 amount) external pure {
        // Consolidation: the SSOT deposit entrypoint is VaultCore.deposit -> VaultRouter -> CollateralManager
        // (CM custody).
        // This legacy entrypoint is permanently disabled to prevent re-introducing the old
        // "BusinessLogic custodies collateral" assumption and related fund-retention risks.
        user; asset; amount; // silence
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /* ============ Liquidation Orchestration (Single Path) ============ */
    /**
     * @notice DEPRECATED: Liquidation must go through LiquidationManager (SSOT).
     * @dev Used when:
     *      - a legacy liquidation entrypoint on this module is called.
     *
     * Security:
     * - This module is not a liquidation SSOT and should not be used for liquidation orchestration.
     */
    error VaultBusinessLogic__UseLiquidationManagerEntry();
    /**
     * @notice DEPRECATED: User entrypoints must go through VaultCore/VaultRouter (SSOT).
     * @dev Used when:
     *      - a legacy user-facing entrypoint on this module is called (e.g., deposit/withdraw/repay).
     *
     * Security:
     * - Prevents write-path divergence and fund-custody assumptions from re-entering via legacy calls.
     */
    error VaultBusinessLogic__UseVaultCoreEntry();
    /**
     * @notice Thrown when a lend intent hash is zero.
     * @dev Used when:
     *      - lendIntentHash == bytes32(0).
     */
    error VaultBusinessLogic__InvalidLendIntentHash();
    /**
     * @notice Thrown when msg.sender is not the declared lenderSigner.
     * @dev Used when:
     *      - a caller attempts to reserve funds for an intent but is not the owner/signer of the funds.
     *
     * Security:
     * - Prevents third parties from locking another user's approved funds.
     */
    error VaultBusinessLogic__CallerNotLenderSigner();
    /**
     * @notice Thrown when a lend intent hash was already matched/consumed.
     * @dev Used when:
     *      - an intent hash is re-used after being marked as matched/consumed.
     *
     * Security:
     * - Intent hashes are single-use to prevent double settlement.
     */
    error VaultBusinessLogic__LendIntentAlreadyMatched();
    /**
     * @notice Thrown when a consumed reserve asset does not match the borrow asset.
     * @dev Used when:
     *      - at least one consumed lender reserve uses an asset != borrowIntent.borrowAsset.
     *
     * @param expected Expected borrow asset address.
     * @param got Actual/consumed reserve asset address.
     */
    error VaultBusinessLogic__AssetMismatch(address expected, address got);
    /**
     * @notice Thrown when the sum of consumed reserves is insufficient for the borrow amount.
     * @dev Used when:
     *      - totalReserved < requiredBorrow.
     *
     * @param totalReserved Sum of consumed reserves (token native decimals).
     * @param requiredBorrow Required borrow amount (token native decimals).
     */
    error VaultBusinessLogic__InsufficientReservedSum(uint256 totalReserved, uint256 requiredBorrow);
    /**
     * @notice Thrown when borrower's collateral balance is insufficient for the required collateral amount.
     * @dev Used when:
     *      - currentCollateral < requiredCollateral.
     *
     * @param current Current collateral amount in CollateralManager (token native decimals).
     * @param required Required collateral amount (token native decimals).
     */
    error VaultBusinessLogic__InsufficientCollateral(uint256 current, uint256 required);

    /**
     * @notice DEPRECATED: Liquidation must go through LiquidationManager SSOT.
     * @dev Reverts if:
     *      - always (VaultBusinessLogic__UseLiquidationManagerEntry)
     *
     * Security:
     * - N/A (function is permanently disabled)
     */
    function liquidate(
        address /*targetUser*/,
        address /*collateralAsset*/,
        address /*debtAsset*/,
        uint256 /*collateralAmount*/,
        uint256 /*debtAmount*/,
        uint256 /*bonus*/
    ) external pure {
        revert VaultBusinessLogic__UseLiquidationManagerEntry();
    }

    /* ============ Settlement: Reserve & Match ============ */
    /**
     * @notice Reserves lender funds by moving tokens into LenderPoolVault for future matching.
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress) via onlyValidRegistry
     *      - paused (whenNotPaused)
     *      - asset == address(0) (ZeroAddress)
     *      - amount == 0 (AmountIsZero)
     *      - lendIntentHash == bytes32(0) (VaultBusinessLogic__InvalidLendIntentHash)
     *      - msg.sender != lenderSigner (VaultBusinessLogic__CallerNotLenderSigner)
     *      - lendIntentHash already matched/consumed (VaultBusinessLogic__LendIntentAlreadyMatched)
     *      - asset not allowed (AssetNotAllowed) if AssetWhitelist is configured
     *      - ERC20 transferFrom fails
     *
     * Security:
     * - Non-reentrant
     * - Pause-aware
     * - Caller must be the lenderSigner to prevent third-party locking approved funds
     *
     * @param lenderSigner Lender signer / fund owner.
     * @param asset ERC20 asset address.
     * @param amount Amount to reserve (token native decimals).
     * @param lendIntentHash Hash of the lend intent (EIP-712 struct hash).
     */
    function reserveForLending(
        address lenderSigner,
        address asset,
        uint256 amount,
        bytes32 lendIntentHash
    ) external onlyValidRegistry whenNotPaused nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        if (lendIntentHash == bytes32(0)) revert VaultBusinessLogic__InvalidLendIntentHash();
        // SSOT safety: prevent third-parties from locking someone else's approved funds.
        if (msg.sender != lenderSigner) revert VaultBusinessLogic__CallerNotLenderSigner();
        // Prevent reuse after a match has marked this intent hash as consumed.
        if (_matchedIntents[lendIntentHash]) revert VaultBusinessLogic__LendIntentAlreadyMatched();
        _checkAssetWhitelist(asset);
        // Move funds into LenderPoolVault custody (recommended location for on-chain liquidity).
        address pool = _getModuleAddress(ModuleKeys.KEY_LENDER_POOL_VAULT);
        IERC20(asset).safeTransferFrom(lenderSigner, pool, amount);
        // Record the reserve in storage.
        _lendReserves.reserve(lenderSigner, asset, amount, lendIntentHash);
        emit LendReserveCreated(lendIntentHash, lenderSigner, asset, amount, block.number);
        emit LendReserveCreatedV2(lendIntentHash, lenderSigner, asset, amount, block.number);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_RESERVE_FOR_LENDING,
            abi.encode(lendIntentHash, lenderSigner, asset, amount, block.number)
        );
        VaultBusinessLogicLibrary.emitBusinessEvents(
            "reserveForLending",
            lenderSigner,
            asset,
            amount,
            ActionKeys.ACTION_RESERVE_FOR_LENDING
        );
    }

    /**
     * @notice Cancels a lender reserve and returns funds from LenderPoolVault.
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress) via onlyValidRegistry
     *      - paused (whenNotPaused)
     *      - lendIntentHash == bytes32(0) (VaultBusinessLogic__InvalidLendIntentHash)
     *      - reserve cannot be cancelled by caller (SettlementReserveLib internal checks)
     *
     * Security:
     * - Non-reentrant
     * - Pause-aware
     *
     * @param lendIntentHash Hash of the lend intent (EIP-712 struct hash).
     */
    function cancelReserve(bytes32 lendIntentHash) external onlyValidRegistry whenNotPaused nonReentrant {
        if (lendIntentHash == bytes32(0)) revert VaultBusinessLogic__InvalidLendIntentHash();
        (address asset, uint256 amount) = _lendReserves.cancel(lendIntentHash, msg.sender);
        if (amount > 0) {
            address pool = _getModuleAddress(ModuleKeys.KEY_LENDER_POOL_VAULT);
            ILenderPoolVault(pool).transferOut(asset, msg.sender, amount);
        }
        emit LendReserveCancelled(lendIntentHash, msg.sender, asset, amount, block.number);
        emit LendReserveCancelledV2(lendIntentHash, msg.sender, asset, amount, block.number);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_CANCEL_RESERVE,
            abi.encode(lendIntentHash, msg.sender, asset, amount, block.number)
        );
        VaultBusinessLogicLibrary.emitBusinessEvents(
            "cancelReserve",
            msg.sender,
            asset,
            amount,
            ActionKeys.ACTION_CANCEL_RESERVE
        );
    }

    /**
     * @notice Finalizes a match by validating intents and executing atomic settlement.
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress) via onlyValidRegistry
     *      - paused (whenNotPaused)
     *      - borrower/lender signatures are invalid (SettlementIntentLib.SettlementIntentLib__InvalidSignature)
     *      - intents are expired or already matched (SettlementIntentLib.validateOpen / markMatched)
     *      - any consumed reserve asset mismatches borrowIntent.borrowAsset (VaultBusinessLogic__AssetMismatch)
     *      - sum of consumed reserves < borrowIntent.amount (VaultBusinessLogic__InsufficientReservedSum)
     *      - borrower's current collateral < required collateral amount (VaultBusinessLogic__InsufficientCollateral)
     *      - SettlementReserveLib consume/cancel constraints fail
     *      - Registry module resolution fails
     *
     * Security:
     * - Non-reentrant
     * - Pause-aware
     * - EIP-712 signature verification for borrower and each lender (EOA or ERC-1271)
     * - Each intent hash is single-use via _matchedIntents
     *
     * @param borrowIntent Borrow intent (EIP-712 struct).
     * @param lendIntents Lend intents (EIP-712 structs) to fund the borrow amount.
     * @param sigBorrower Borrower signature over borrowIntent typed data.
     * @param sigLenders Lender signatures over each lendIntent typed data (must align by index).
     */
    function finalizeMatch(
        SettlementIntentLib.BorrowIntent calldata borrowIntent,
        SettlementIntentLib.LendIntent[] calldata lendIntents,
        bytes calldata sigBorrower,
        bytes[] calldata sigLenders
    ) external onlyValidRegistry whenNotPaused nonReentrant {
        if (lendIntents.length != sigLenders.length) revert ArrayLengthMismatch(lendIntents.length, sigLenders.length);
        // EIP-712 domain separator
        bytes32 domain = SettlementIntentLib.buildDomainSeparator(
            "RwaLending",
            "1",
            block.chainid,
            address(this)
        );
        // Validate borrow intent state (expired / already matched)
        bytes32 bHash = SettlementIntentLib.hashBorrowIntent(borrowIntent);
        // NOTE (Time-Dependency-Refactor): `expireAt` is a legacy field name; semantics are expireBlock (block.number).
        SettlementIntentLib.validateOpen(_matchedIntents, bHash, borrowIntent.expireAt);
        // Verify borrower signature (EOA or ERC-1271)
        bytes32 bDigest = SettlementIntentLib.toTypedDataHash(domain, bHash);
        if (!SettlementIntentLib.verifySignature(borrowIntent.borrower, bDigest, sigBorrower)) {
            revert SettlementIntentLib.SettlementIntentLib__InvalidSignature();
        }

        uint256 total;
        for (uint256 i = 0; i < lendIntents.length; i++) {
            bytes32 lHash = SettlementIntentLib.hashLendIntent(lendIntents[i]);
            SettlementIntentLib.validateOpen(_matchedIntents, lHash, lendIntents[i].expireAt);
            // Verify lender signature
            bytes32 lDigest = SettlementIntentLib.toTypedDataHash(domain, lHash);
            if (!SettlementIntentLib.verifySignature(lendIntents[i].lenderSigner, lDigest, sigLenders[i])) {
                revert SettlementIntentLib.SettlementIntentLib__InvalidSignature();
            }
            // Consume the corresponding reserve and add to the running total
            (address lenderSigner, address asset, uint256 amount) = _lendReserves.consume(
                lHash,
                lendIntents[i].lenderSigner
            );
            lenderSigner; // silence
            if (asset != borrowIntent.borrowAsset) {
                revert VaultBusinessLogic__AssetMismatch(borrowIntent.borrowAsset, asset);
            }
            total += amount;

            // Observe consumption for off-chain accounting and retries.
            emit LendReserveConsumed(lHash, lendIntents[i].lenderSigner, asset, amount, block.number);
            emit LendReserveConsumedV2(lHash, lendIntents[i].lenderSigner, asset, amount, block.number);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_RESERVE_CONSUMED,
                abi.encode(lHash, lendIntents[i].lenderSigner, asset, amount, block.number)
            );
        }

        if (total < borrowIntent.amount) revert VaultBusinessLogic__InsufficientReservedSum(total, borrowIntent.amount);

        // Collateral sufficiency check (does not pull collateral; validation only)
        address cm = _getModuleAddress(ModuleKeys.KEY_CM);
        uint256 currentCollateral = 0;
        if (borrowIntent.collateralAsset != address(0) && borrowIntent.collateralAmount > 0) {
            currentCollateral = ICollateralManager(cm).getCollateral(
                borrowIntent.borrower,
                borrowIntent.collateralAsset
            );
            if (currentCollateral < borrowIntent.collateralAmount) {
                revert VaultBusinessLogic__InsufficientCollateral(currentCollateral, borrowIntent.collateralAmount);
            }
        }

        // Atomic finalization: ledger -> order -> fees -> net disbursement (library does not emit business events).
        // Note: CollateralManager only allows VaultRouter calls; this contract must not call depositCollateral.
        // Therefore we do not "top up collateral" here; borrower collateral must be deposited beforehand via
        // VaultCore/VaultRouter.
        // Lender field convention: use the pool contract address (LenderPoolVault), not the lender EOA.
        address pool = _getModuleAddress(ModuleKeys.KEY_LENDER_POOL_VAULT);
        uint256 orderId = SettlementMatchLib.finalizeAtomicFull(
            _registryAddr,
            borrowIntent.borrower,
            pool,
            address(0),
            0,
            borrowIntent.borrowAsset,
            borrowIntent.amount,
            borrowIntent.termDays,
            borrowIntent.rateBps
        );
        orderId; // silence (for now; orderId SSOT is in ORDER_ENGINE/NFT events)

        // Extension Flow: lock + record early-repayment guarantee (if enabled for this asset).
        _maybeLockEarlyRepaymentGuarantee(
            borrowIntent.borrower,
            pool,
            borrowIntent.borrowAsset,
            borrowIntent.amount,
            borrowIntent.termDays,
            borrowIntent.rateBps
        );

        // Mark matched (both borrow intent and each lend intent)
        _matchedIntents[bHash] = true;
        for (uint256 i = 0; i < lendIntents.length; i++) {
            bytes32 lHash = SettlementIntentLib.hashLendIntent(lendIntents[i]);
            SettlementIntentLib.markMatched(_matchedIntents, lHash);
        }
        // Events and data pushes are handled by LendingEngine + LoanNFT; this module no longer emits match events.
    }

    /**
     * @notice DEPRECATED: Borrow must go through VaultCore/LendingEngine/Settlement (SSOT).
     * @dev Reverts if:
     *      - always (VaultBusinessLogic__UseVaultCoreEntry)
     *
     * Security:
     * - N/A (function is permanently disabled)
     *
     * @param user User address (unused).
     * @param asset ERC20 asset address (unused).
     * @param amount Borrow amount (token native decimals; unused).
     */
    function borrow(address user, address asset, uint256 amount) external onlyValidRegistry whenNotPaused nonReentrant {
        // Strict SSOT: borrowing must go through VaultCore/LendingEngine/Settlement SSOT paths.
        // This legacy entrypoint is permanently disabled to prevent parallel accounting and fund-flow paths.
        user; asset; amount; // silence
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /* ============ Liquidation Orchestration removed: use LiquidationManager ============ */

    /**
     * @notice Borrows with provided annual rate and term (compatibility wrapper; uses settlement library).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress) via onlyValidRegistry
     *      - paused (whenNotPaused)
     *      - SettlementMatchLib.finalizeAtomic reverts
     *      - Registry module resolution fails
     *
     * Security:
     * - Non-reentrant
     * - Pause-aware
     *
     * @param user Borrower address.
     * @param lender Deprecated parameter (unused).
     * @param asset ERC20 asset address.
     * @param amount Borrow amount (token native decimals).
     * @param annualRateBps Annual interest rate in basis points (bps; 1e4 = 100%).
     * @param termDays Term length in days.
     * @return orderId Order id created by settlement library.
     */
    function borrowWithRate(
        address user,
        address lender,
        address asset,
        uint256 amount,
        uint256 annualRateBps,
        uint16 termDays
    ) external onlyValidRegistry whenNotPaused nonReentrant returns (uint256 orderId) {
        lender; // silence (deprecated; kept for backwards compatibility)
        // Migration: route to settlement library to avoid BusinessLogic directly disbursing funds and locking reserves.
        // Signature is preserved for backwards compatibility with legacy scripts.
        // Lender field convention: use the pool contract address (LenderPoolVault),
        // not the deprecated external parameter.
        address pool = _getModuleAddress(ModuleKeys.KEY_LENDER_POOL_VAULT);
        orderId = SettlementMatchLib.finalizeAtomic(
            _registryAddr,
            user,
            pool,
            address(0),
            0,
            asset,
            amount,
            termDays,
            annualRateBps
        );
        // Extension Flow: lock + record early-repayment guarantee (if enabled for this asset).
        _maybeLockEarlyRepaymentGuarantee(user, pool, asset, amount, termDays, annualRateBps);
        VaultBusinessLogicLibrary.emitBusinessEvents("borrowWithRate", user, asset, amount, ActionKeys.ACTION_BORROW);
    }

    /**
     * @notice DEPRECATED: Repay must go through VaultCore.repay SSOT.
     * @dev Reverts if:
     *      - amount == 0 (AmountIsZero)
     *      - asset == address(0) (ZeroAddress)
     *      - always (VaultBusinessLogic__UseVaultCoreEntry)
     *
     * Security:
     * - N/A (function is permanently disabled)
     *
     * @param user User address (unused).
     * @param asset ERC20 asset address (unused).
     * @param amount Repay amount (token native decimals; unused).
     */
    function repay(address user, address asset, uint256 amount) external view onlyValidRegistry whenNotPaused {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();

        // Consolidation: repay/settlement must go through
        // VaultCore.repay(orderId, asset, amount) -> SettlementManager (SSOT).
        // This module no longer custodies repay funds to avoid write-path divergence and fund retention risk.
        user;
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /**
     * @notice DEPRECATED: Repay-with-stop must go through SettlementManager/VaultCore SSOT.
     * @dev Reverts if:
     *      - amount == 0 (AmountIsZero)
     *      - asset == address(0) (ZeroAddress)
     *      - always (VaultBusinessLogic__UseVaultCoreEntry)
     *
     * Security:
     * - N/A (function is permanently disabled)
     *
     * @param user User address (unused).
     * @param asset ERC20 asset address (unused).
     * @param amount Repay amount (token native decimals; unused).
     * @param stop Whether to stop/close the loan (unused).
     */
    function repayWithStop(
        address user,
        address asset,
        uint256 amount,
        bool stop
    ) external view onlyValidRegistry whenNotPaused {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();
        // DEPRECATED: early-repayment settlement must be handled by SettlementManager (SSOT)
        // to avoid repay/settle divergence.
        stop;
        user;
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /**
     * @notice DEPRECATED: Withdraw must go through VaultCore/VaultRouter SSOT.
     * @dev Reverts if:
     *      - always (VaultBusinessLogic__UseVaultCoreEntry)
     *
     * Security:
     * - N/A (function is permanently disabled)
     *
     * @param user User address (unused).
     * @param asset Asset address (unused).
     * @param amount Amount to withdraw (token native decimals; unused).
     */
    function withdraw(address user, address asset, uint256 amount) external pure {
        // Consolidation: the SSOT withdraw entrypoint is VaultCore.withdraw -> VaultRouter -> CollateralManager
        // (CM custody).
        user; asset; amount; // silence
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /* ============ Batch Operations ============ */
    
    /**
     * @notice DEPRECATED: Batch deposit must be done via VaultCore SSOT (or future VaultCore.batchDeposit).
     * @dev Reverts if:
     *      - always (VaultBusinessLogic__UseVaultCoreEntry)
     *
     * Security:
     * - N/A (function is permanently disabled)
     *
     * @param user User address (unused).
     * @param assets Asset address array (unused).
     * @param amounts Amount array (token native decimals; unused).
     */
    function batchDeposit(address user, address[] calldata assets, uint256[] calldata amounts) external pure {
        // Consolidation: batch collateral operations should be decomposed into multiple VaultCore.deposit calls
        // (or a future VaultCore.batchDeposit).
        user; assets; amounts; // silence
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /**
     * @notice DEPRECATED: Batch borrow must be orchestrated through SSOT modules.
     * @dev Reverts if:
     *      - always (VaultBusinessLogic__UseVaultCoreEntry)
     *
     * Security:
     * - N/A (function is permanently disabled)
     *
     * @param user User address (unused).
     * @param assets Asset address array (unused).
     * @param amounts Amount array (token native decimals; unused).
     */
    function batchBorrow(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external onlyValidRegistry whenNotPaused nonReentrant {
        // Strict SSOT: batch borrowing must be orchestrated through SSOT modules (VaultCore/LendingEngine/Settlement).
        // This legacy helper is permanently disabled to avoid parallel settlement/order creation paths.
        user; assets; amounts; // silence
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /**
     * @notice DEPRECATED: Batch repay must be orchestrated through SSOT modules.
     * @dev Reverts if:
     *      - always (VaultBusinessLogic__UseVaultCoreEntry)
     *
     * Security:
     * - N/A (function is permanently disabled)
     *
     * @param user User address (unused).
     * @param assets Asset address array (unused).
     * @param amounts Amount array (token native decimals; unused).
     */
    function batchRepay(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external onlyValidRegistry whenNotPaused nonReentrant {
        // Strict SSOT: repay/settlement must go through VaultCore/SettlementManager (SSOT).
        // This legacy helper is permanently disabled to avoid fund retention and parallel write paths.
        user; assets; amounts; // silence
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /**
     * @notice DEPRECATED: Batch withdraw must be done via VaultCore SSOT (or future VaultCore.batchWithdraw).
     * @dev Reverts if:
     *      - always (VaultBusinessLogic__UseVaultCoreEntry)
     *
     * Security:
     * - N/A (function is permanently disabled)
     *
     * @param user User address (unused).
     * @param assets Asset address array (unused).
     * @param amounts Amount array (token native decimals; unused).
     */
    function batchWithdraw(address user, address[] calldata assets, uint256[] calldata amounts) external pure {
        // Consolidation: batch collateral operations should be decomposed into multiple VaultCore.withdraw calls
        // (or a future VaultCore.batchWithdraw).
        user; assets; amounts; // silence
        revert VaultBusinessLogic__UseVaultCoreEntry();
    }

    /* ============ Upgrade Auth ============ */
    /**
     * @notice Authorizes UUPS upgrade.
     * @dev Reverts if:
     *      - msg.sender lacks upgrade role (AccessControlManager.requireRole via _requireRole)
     *      - newImplementation == address(0) (ZeroAddress)
     *
     * Security:
     * - Upgrade is role-gated (ACTION_UPGRADE_MODULE)
     *
     * @param newImplementation New implementation address.
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // Emit a standardized action event for off-chain observability.
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.number
        );
    }
} 
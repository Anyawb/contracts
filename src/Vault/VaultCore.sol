// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {Registry} from "../registry/Registry.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {IVaultRouter} from "../interfaces/IVaultRouter.sol";
import {IAccessControlManager} from "../interfaces/IAccessControlManager.sol";
import {ILendingEngineBasic} from "../interfaces/ILendingEngineBasic.sol";
import {ISettlementManager} from "../interfaces/ISettlementManager.sol";
import {AmountIsZero, ArrayLengthMismatch, EmptyArray, NotAContract, ZeroAddress} from "../errors/StandardErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title VaultCore
/// @notice Single user entry (dual-architecture): routes writes to ledger modules.
/// @notice Exposes the View address resolver.
/// @dev Architecture-Guide: deposit/withdraw -> CollateralManager; borrow -> LendingEngine.
/// @dev Architecture-Guide: repay -> SettlementManager (SSOT).
/// @dev UUPS + ReentrancyGuard baseline: constructor disables initializers; keep __gap.
/// @dev User-facing write entrypoints are nonReentrant.
/// @custom:security-contact security@example.com
contract VaultCore is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    /*━━━━━━━━━━━━━━━ Core config ━━━━━━━━━━━━━━━*/
    address private _registryAddr;
    address private _viewContractAddr;

    /// @dev Safety cap for batch operations (user-facing)
    uint256 private constant _MAX_BATCH_SIZE = 50;

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    /**
     * @notice Caller is not a registered business module.
     * @dev Used by `onlyBusinessModule`.
     *
     * Reverts if:
     * - N/A (error selector only)
     *
     * Security:
     * - Access control enforcement for module-only entrypoints
     */
    error VaultCore__UnauthorizedModule();
    /**
     * @notice Caller is not the ORDER_ENGINE module.
     * @dev Used by `onlyOrderEngine` (Registry KEY_ORDER_ENGINE).
     *
     * Reverts if:
     * - N/A (error selector only)
     *
     * Security:
     * - Prevents non-SSOT order engine from calling restricted paths
     */
    error VaultCore__OnlyOrderEngine();
    /**
     * @notice Batch size exceeds the configured safety cap.
     * @dev Used by user-facing batch entrypoints.
     *
     * Reverts if:
     * - N/A (error selector only)
     *
     * Security:
     * - DoS/gas guard for user-facing batch operations
     *
     * @param size Requested batch size
     * @param maxSize Max allowed batch size
     */
    error VaultCore__BatchTooLarge(uint256 size, uint256 maxSize);

    /*━━━━━━━━━━━━━━━ Construction & initialization ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize VaultCore with registry and view addresses.
     * @dev Reverts if:
     *      - initialRegistryAddr is zero
     *      - initialViewContractAddr is zero
     *
     * Security:
     * - Initializer guarded (initializer modifier)
     * - Sets UUPS + ReentrancyGuard baselines
     *
     * @param initialRegistryAddr Registry address (non-zero)
     * @param initialViewContractAddr VaultRouter/View address (non-zero)
     */
    function initialize(address initialRegistryAddr, address initialViewContractAddr) external initializer {
        if (initialRegistryAddr == address(0) || initialViewContractAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        if (initialViewContractAddr.code.length == 0) revert NotAContract(initialViewContractAddr);

        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        _registryAddr = initialRegistryAddr;
        _viewContractAddr = initialViewContractAddr;
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    /// @notice Ensure Registry is configured and is a contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @notice Ensure View/VaultRouter address is configured and is a contract.
    modifier onlyValidViewContract() {
        if (_viewContractAddr == address(0)) revert ZeroAddress();
        if (_viewContractAddr.code.length == 0) revert NotAContract(_viewContractAddr);
        _;
    }

    /// @dev Restricts callers to registered business/ledger modules (see `_isBusinessModule`).
    modifier onlyBusinessModule() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        if (!_isBusinessModule(msg.sender)) revert VaultCore__UnauthorizedModule();
        _;
    }

    /// @dev Restricts callers to ORDER_ENGINE (Registry KEY_ORDER_ENGINE).
    modifier onlyOrderEngine() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        if (msg.sender != orderEngine) revert VaultCore__OnlyOrderEngine();
        _;
    }

    /*━━━━━━━━━━━━━━━ Read-only entrypoints ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get Registry address (convenience getter).
     * @return registryAddress Registry contract address
     *
     * @dev Architecture note:
     * - Registry is the SSOT for module address resolution.
     * - On-chain modules SHOULD NOT rely on VaultCore as an address resolver facade.
     *   Modules already carry `_registryAddr` and should call `Registry(_registryAddr).getModule*` directly.
     * - This getter is kept mainly for off-chain tooling, scripts, and external integrations that need
     *   a stable "bridge" to the Registry address.
     */
    function registryAddrVar() external view returns (address registryAddress) {
        return _registryAddr;
    }

    /**
     * @notice Get View (VaultRouter) address.
     * @return viewAddress VaultRouter/View contract address
     */
    function viewContractAddrVar() external view returns (address viewAddress) {
        return _viewContractAddr;
    }

    /**
     * @notice Resolve module address via Registry (off-chain convenience).
     * @param moduleKey Module key (ModuleKeys.*)
     * @return moduleAddress Resolved address (reverts if not registered)
     *
     * @dev Architecture note:
     * - Prefer `Registry.getModuleOrRevert` as the SSOT for module resolution.
     * - This helper is intended for external callers (scripts/frontends) that already have VaultCore
     *   but don't want to also bind the Registry ABI.
     */
    function getModule(bytes32 moduleKey) external view onlyValidRegistry returns (address moduleAddress) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /**
     * @notice Return Registry address (alias to registryAddrVar; convenience getter).
     * @return registryAddress Registry address
     */
    function getRegistry() external view returns (address registryAddress) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ User entrypoints (authority path) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Deposit collateral (authority path) via VaultRouter → CollateralManager.
     * @dev Reverts if:
     *      - asset is zero
     *      - amount is zero
     *
     * Security:
     * - Non-reentrant
     * - Routes through VaultRouter.processUserOperation (Architecture-Guide SSOT for deposit/withdraw routing)
     * - Funds are pulled by CollateralManager from `msg.sender` (user must approve CollateralManager as spender)
     *
     * @param asset Collateral asset address (non-zero)
     * @param amount Collateral amount (token decimals)
     */
    function deposit(address asset, uint256 amount) external nonReentrant onlyValidViewContract {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        // Timestamp is passed through for off-chain audit attribution; not used for business decisions.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        IVaultRouter(_viewContractAddr).processUserOperation(
            msg.sender,
            ActionKeys.ACTION_DEPOSIT,
            asset,
            amount,
            ts
        );
    }

    /**
     * @notice Withdraw collateral (authority path) via VaultRouter → CollateralManager.
     * @dev Reverts if:
     *      - asset is zero
     *      - amount is zero
     *
     * Security:
     * - Non-reentrant
     * - Routes through VaultRouter.processUserOperation (Architecture-Guide SSOT for deposit/withdraw routing)
     * - CollateralManager performs balance checks and real token transfers
     *
     * @param asset Collateral asset address (non-zero)
     * @param amount Withdraw amount (token decimals)
     */
    function withdraw(address asset, uint256 amount) external nonReentrant onlyValidViewContract {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        // Timestamp is passed through for off-chain audit attribution; not used for business decisions.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        IVaultRouter(_viewContractAddr).processUserOperation(
            msg.sender,
            ActionKeys.ACTION_WITHDRAW,
            asset,
            amount,
            ts
        );
    }

    /**
     * @notice Borrow via LendingEngine (single authority entry).
     * @dev Reverts if:
     *      - asset is zero
     *      - amount is zero
     *
     * Security:
     * - Non-reentrant
     * - LendingEngine enforces onlyVaultCore and downstream permissions
     *
     * @param asset Debt asset address (non-zero)
     * @param amount Borrow amount (token decimals)
     */
    function borrow(address asset, uint256 amount) external nonReentrant onlyValidRegistry {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(lendingEngine).borrow(msg.sender, asset, amount, 0, 0);
    }

    /**
     * @notice Borrow on behalf of a borrower (orchestrated modules only).
     * @dev Reverts if:
     *      - borrower or asset is zero
     *      - amount is zero
     *
     * Security:
     * - Only registered business modules
     * - LendingEngine enforces onlyVaultCore and downstream permissions
     *
     * @param borrower Borrower address (non-zero)
     * @param asset Debt asset address (non-zero)
     * @param amount Borrow amount (token decimals)
     * @param termDays Loan term in days
     */
    function borrowFor(address borrower, address asset, uint256 amount, uint16 termDays) external onlyBusinessModule {
        if (borrower == address(0) || asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(lendingEngine).borrow(borrower, asset, amount, 0, termDays);
    }

    /**
     * @notice Principal-ledger sync callback from OrderEngine (internal, non-user entry).
     * @dev Reverts if:
     *      - user or asset is zero
     *      - amount is zero
     *      - caller is not the registered OrderEngine (KEY_ORDER_ENGINE)
     *
     * Security:
     * - Only OrderEngine can call (callback entry)
     * - This function MUST NOT transfer tokens or perform settlement. Token flows, fee splits, and business rules
     *   are handled by OrderEngine/SettlementManager paths; this entry only updates the VaultLendingEngine debt ledger.
     * - LendingEngine enforces onlyVaultCore and downstream permissions
     *
     * @param user Borrower address (non-zero)
     * @param asset Debt asset (non-zero)
     * @param amount Principal repay delta to sync (token decimals)
     */
    function repayFor(address user, address asset, uint256 amount) external onlyOrderEngine {
        if (user == address(0) || asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(lendingEngine).repay(user, asset, amount);
    }

    /**
     * @notice Repay and settle via SettlementManager (single authority entry).
     * @dev Reverts if:
     *      - asset is zero
     *      - amount is zero
     *
     * Security:
     * - Non-reentrant
     * - VaultCore pulls debt asset from msg.sender and forwards to SettlementManager
     * - SettlementManager is the SSOT for repay/settle/clear
     *
     * @param orderId Loan/order id (SSOT)
     * @param asset Debt asset address (non-zero)
     * @param amount Repay amount (token decimals)
     */
    function repay(uint256 orderId, address asset, uint256 amount) external nonReentrant onlyValidRegistry {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        address settlementManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_SETTLEMENT_MANAGER);
        IERC20(asset).safeTransferFrom(msg.sender, settlementManager, amount);
        ISettlementManager(settlementManager).repayAndSettle(msg.sender, asset, amount, orderId);
    }

    /*━━━━━━━━━━━━━━━ Batch user entrypoints ━━━━━━━━━━━━━━━*/

    /**
     * @notice Batch deposit collateral via VaultRouter → CollateralManager.
     * @dev Reverts if:
     *      - assets.length != amounts.length
     *      - assets is empty
     *      - assets.length > _MAX_BATCH_SIZE
     *      - any asset is zero
     *      - any amount is zero
     *
     * Security:
     * - Non-reentrant
     *
     * @param assets Collateral asset addresses
     * @param amounts Collateral amounts (token decimals)
     */
    function batchDeposit(address[] calldata assets, uint256[] calldata amounts) external nonReentrant onlyValidViewContract {
        if (assets.length != amounts.length) revert ArrayLengthMismatch(assets.length, amounts.length);
        if (assets.length == 0) revert EmptyArray();
        if (assets.length > _MAX_BATCH_SIZE) revert VaultCore__BatchTooLarge(assets.length, _MAX_BATCH_SIZE);

        // Timestamp is passed through for off-chain audit attribution; not used for business decisions.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            uint256 amount = amounts[i];
            if (asset == address(0)) revert ZeroAddress();
            if (amount == 0) revert AmountIsZero();
            IVaultRouter(_viewContractAddr).processUserOperation(
                msg.sender,
                ActionKeys.ACTION_DEPOSIT,
                asset,
                amount,
                ts
            );
        }
    }

    /**
     * @notice Batch borrow via LendingEngine.
     * @dev Reverts if:
     *      - assets.length != amounts.length
     *      - assets is empty
     *      - assets.length > _MAX_BATCH_SIZE
     *      - any asset is zero
     *      - any amount is zero
     *
     * Security:
     * - Non-reentrant
     *
     * @param assets Debt asset addresses
     * @param amounts Borrow amounts (token decimals)
     */
    function batchBorrow(address[] calldata assets, uint256[] calldata amounts) external nonReentrant onlyValidRegistry {
        if (assets.length != amounts.length) revert ArrayLengthMismatch(assets.length, amounts.length);
        if (assets.length == 0) revert EmptyArray();
        if (assets.length > _MAX_BATCH_SIZE) revert VaultCore__BatchTooLarge(assets.length, _MAX_BATCH_SIZE);

        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            uint256 amount = amounts[i];
            if (asset == address(0)) revert ZeroAddress();
            if (amount == 0) revert AmountIsZero();
            ILendingEngineBasic(lendingEngine).borrow(msg.sender, asset, amount, 0, 0);
        }
    }

    /**
     * @notice Batch repay and settle via SettlementManager.
     * @dev Reverts if:
     *      - orderIds.length != assets.length
     *      - assets.length != amounts.length
     *      - assets is empty
     *      - assets.length > _MAX_BATCH_SIZE
     *      - any asset is zero
     *      - any amount is zero
     *
     * Security:
     * - Non-reentrant
     * - Pulls debt tokens from msg.sender per item and forwards to SettlementManager
     *
     * @param orderIds Loan/order ids (SSOT)
     * @param assets Debt asset addresses
     * @param amounts Repay amounts (token decimals)
     */
    function batchRepay(
        uint256[] calldata orderIds,
        address[] calldata assets,
        uint256[] calldata amounts
    ) external nonReentrant onlyValidRegistry {
        if (orderIds.length != assets.length) revert ArrayLengthMismatch(orderIds.length, assets.length);
        if (assets.length != amounts.length) revert ArrayLengthMismatch(assets.length, amounts.length);
        if (assets.length == 0) revert EmptyArray();
        if (assets.length > _MAX_BATCH_SIZE) revert VaultCore__BatchTooLarge(assets.length, _MAX_BATCH_SIZE);

        address settlementManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_SETTLEMENT_MANAGER);
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            uint256 amount = amounts[i];
            if (asset == address(0)) revert ZeroAddress();
            if (amount == 0) revert AmountIsZero();
            IERC20(asset).safeTransferFrom(msg.sender, settlementManager, amount);
            ISettlementManager(settlementManager).repayAndSettle(msg.sender, asset, amount, orderIds[i]);
        }
    }

    /**
     * @notice Batch withdraw collateral via VaultRouter → CollateralManager.
     * @dev Reverts if:
     *      - assets.length != amounts.length
     *      - assets is empty
     *      - assets.length > _MAX_BATCH_SIZE
     *      - any asset is zero
     *      - any amount is zero
     *
     * Security:
     * - Non-reentrant
     *
     * @param assets Collateral asset addresses
     * @param amounts Withdraw amounts (token decimals)
     */
    function batchWithdraw(address[] calldata assets, uint256[] calldata amounts) external nonReentrant onlyValidViewContract {
        if (assets.length != amounts.length) revert ArrayLengthMismatch(assets.length, amounts.length);
        if (assets.length == 0) revert EmptyArray();
        if (assets.length > _MAX_BATCH_SIZE) revert VaultCore__BatchTooLarge(assets.length, _MAX_BATCH_SIZE);

        // Timestamp is passed through for off-chain audit attribution; not used for business decisions.
        // solhint-disable-next-line not-rely-on-time
        uint256 ts = block.timestamp;
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            uint256 amount = amounts[i];
            if (asset == address(0)) revert ZeroAddress();
            if (amount == 0) revert AmountIsZero();
            IVaultRouter(_viewContractAddr).processUserOperation(
                msg.sender,
                ActionKeys.ACTION_WITHDRAW,
                asset,
                amount,
                ts
            );
        }
    }

    /*━━━━━━━━━━━━━━━ Data push entrypoints (business -> View) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Push full user position update (versioned + contexted) to View.
     * @dev Security: only registered business modules; view address must be set
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external onlyBusinessModule {
        _forwardUserPositionUpdate(user, asset, collateral, debt, requestId, seq, nextVersion);
    }

    /**
     * @notice Push delta user position update (versioned + contexted) to View.
     * @dev Security: only registered business modules; view address must be set
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external onlyBusinessModule {
        _forwardUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, requestId, seq, nextVersion);
    }

    /**
     * @notice Push asset stats update (contexted) to View.
     * @dev Security: only registered business modules; view address must be set
     */
    function pushAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) external onlyBusinessModule {
        _forwardAssetStatsUpdate(asset, totalCollateral, totalDebt, price, requestId, seq);
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /// @dev Best-effort module allowlist for `onlyBusinessModule`.
    function _isBusinessModule(address caller) internal view returns (bool) {
        if (caller == address(0)) return false;

        address cm = _getModuleOrZero(ModuleKeys.KEY_CM);
        if (caller == cm) return true;

        address le = _getModuleOrZero(ModuleKeys.KEY_LE);
        if (caller == le) return true;

        address settlementManager = _getModuleOrZero(ModuleKeys.KEY_SETTLEMENT_MANAGER);
        if (caller == settlementManager) return true;

        address orderEngine = _getModuleOrZero(ModuleKeys.KEY_ORDER_ENGINE);
        if (caller == orderEngine) return true;

        address liquidation = _getModuleOrZero(ModuleKeys.KEY_LIQUIDATION_MANAGER);
        if (caller == liquidation) return true;

        address vbl = _getModuleOrZero(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC);
        if (caller == vbl) return true;

        return false;
    }

    function _getModuleOrZero(bytes32 moduleKey) internal view returns (address moduleAddress) {
        try Registry(_registryAddr).getModuleOrRevert(moduleKey) returns (address moduleAddr) {
            moduleAddress = moduleAddr;
        } catch {
            moduleAddress = address(0);
        }
    }

    /// @dev Forward full position update to VaultRouter (View); called by push* entrypoints.
    function _forwardUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) internal {
        if (_viewContractAddr == address(0)) revert ZeroAddress();
        if (_viewContractAddr.code.length == 0) revert NotAContract(_viewContractAddr);
        IVaultRouter(_viewContractAddr).pushUserPositionUpdate(
            user,
            asset,
            collateral,
            debt,
            requestId,
            seq,
            nextVersion
        );
    }

    /// @dev Forward delta position update to VaultRouter (View); called by push* delta entrypoints.
    function _forwardUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) internal {
        if (_viewContractAddr == address(0)) revert ZeroAddress();
        if (_viewContractAddr.code.length == 0) revert NotAContract(_viewContractAddr);
        IVaultRouter(_viewContractAddr).pushUserPositionUpdateDelta(
            user,
            asset,
            collateralDelta,
            debtDelta,
            requestId,
            seq,
            nextVersion
        );
    }

    /// @dev Forward asset stats update to VaultRouter (View); called by pushAssetStatsUpdate entrypoints.
    function _forwardAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) internal {
        if (_viewContractAddr == address(0)) revert ZeroAddress();
        if (_viewContractAddr.code.length == 0) revert NotAContract(_viewContractAddr);
        IVaultRouter(_viewContractAddr).pushAssetStatsUpdate(
            asset,
            totalCollateral,
            totalDebt,
            price,
            requestId,
            seq
        );
    }

    /*━━━━━━━━━━━━━━━ Upgrade authorization ━━━━━━━━━━━━━━━*/

    /**
     * @notice UUPS authorize upgrade.
     * @dev Reverts if caller missing ACTION_UPGRADE_MODULE or newImplementation is zero.
     * @param newImplementation New implementation address (non-zero)
     */
    function _authorizeUpgrade(address newImplementation) internal view override {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    uint256[50] private __gap;
}

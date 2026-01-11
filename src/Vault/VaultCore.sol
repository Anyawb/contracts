// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import {Registry} from "../registry/Registry.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {IVaultRouter} from "../interfaces/IVaultRouter.sol";
import {IAccessControlManager} from "../interfaces/IAccessControlManager.sol";
import {ILendingEngineBasic} from "../interfaces/ILendingEngineBasic.sol";
import {ISettlementManager} from "../interfaces/ISettlementManager.sol";
import {ICollateralManager} from "../interfaces/ICollateralManager.sol";
import {AmountIsZero, ArrayLengthMismatch, EmptyArray, ZeroAddress} from "../errors/StandardErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title VaultCore
/// @notice Single user entry (dual-architecture): routes writes to ledger modules.
/// @notice Exposes the View address resolver.
/// @dev Architecture-Guide: deposit/withdraw -> CollateralManager; borrow -> LendingEngine.
/// @dev Architecture-Guide: repay -> SettlementManager (SSOT).
/// @dev UUPS + ReentrancyGuard baseline: constructor disables initializers; keep __gap.
/// @dev External write entrypoints are nonReentrant.
/// @custom:security-contact security@example.com
contract VaultCore is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    /*━━━━━━━━━━━━━━━ Core config ━━━━━━━━━━━━━━━*/
    address private _registryAddr;
    address private _viewContractAddr;

    /// @dev Safety cap for batch operations (user-facing)
    uint256 private constant _MAX_BATCH_SIZE = 50;

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    error VaultCore__UnauthorizedModule();
    error VaultCore__OnlyOrderEngine();
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

        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        _registryAddr = initialRegistryAddr;
        _viewContractAddr = initialViewContractAddr;
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyBusinessModule() {
        if (!_isBusinessModule(msg.sender)) revert VaultCore__UnauthorizedModule();
        _;
    }

    modifier onlyOrderEngine() {
        address orderEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        if (msg.sender != orderEngine) revert VaultCore__OnlyOrderEngine();
        _;
    }

    /*━━━━━━━━━━━━━━━ Read-only entrypoints ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get Registry address.
     * @return registryAddress Registry contract address
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
     * @notice Resolve module address via Registry.
     * @param moduleKey Module key (ModuleKeys.*)
     * @return moduleAddress Resolved address (reverts if not registered)
     */
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /**
     * @notice Return Registry address (alias to registryAddrVar).
     * @return registryAddress Registry address
     */
    function getRegistry() external view returns (address registryAddress) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ User entrypoints (authority path) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Deposit collateral into CollateralManager (authority path).
     * @dev Reverts if:
     *      - asset is zero
     *      - amount is zero
     *
     * Security:
     * - Non-reentrant
     * - Funds pulled by CollateralManager from msg.sender (user must approve CM)
     *
     * @param asset Collateral asset address (non-zero)
     * @param amount Collateral amount (token decimals)
     */
    function deposit(address asset, uint256 amount) external nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        ICollateralManager(cm).depositCollateral(msg.sender, asset, amount);
    }

    /**
     * @notice Withdraw collateral from CollateralManager (authority path).
     * @dev Reverts if:
     *      - asset is zero
     *      - amount is zero
     *
     * Security:
     * - Non-reentrant
     * - CollateralManager performs balance checks and real token transfers
     *
     * @param asset Collateral asset address (non-zero)
     * @param amount Withdraw amount (token decimals)
     */
    function withdraw(address asset, uint256 amount) external nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        ICollateralManager(cm).withdrawCollateral(msg.sender, asset, amount);
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
    function borrow(address asset, uint256 amount) external nonReentrant {
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
     * @notice Repay bookkeeping callback from OrderEngine (internal settlement path).
     * @dev Reverts if:
     *      - user or asset is zero
     *      - amount is zero
     *      - caller is not the registered OrderEngine (KEY_ORDER_ENGINE)
     *
     * Security:
     * - Only OrderEngine can call (callback entry)
     * - LendingEngine enforces onlyVaultCore and downstream permissions
     *
     * @param user Borrower address (non-zero)
     * @param asset Debt asset (non-zero)
     * @param amount Repay amount (token decimals)
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
    function repay(uint256 orderId, address asset, uint256 amount) external nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        address settlementManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_SETTLEMENT_MANAGER);
        IERC20(asset).safeTransferFrom(msg.sender, settlementManager, amount);
        ISettlementManager(settlementManager).repayAndSettle(msg.sender, asset, amount, orderId);
    }

    /*━━━━━━━━━━━━━━━ Batch user entrypoints ━━━━━━━━━━━━━━━*/

    /**
     * @notice Batch deposit collateral into CollateralManager.
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
    function batchDeposit(address[] calldata assets, uint256[] calldata amounts) external nonReentrant {
        if (assets.length != amounts.length) revert ArrayLengthMismatch(assets.length, amounts.length);
        if (assets.length == 0) revert EmptyArray();
        if (assets.length > _MAX_BATCH_SIZE) revert VaultCore__BatchTooLarge(assets.length, _MAX_BATCH_SIZE);

        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            uint256 amount = amounts[i];
            if (asset == address(0)) revert ZeroAddress();
            if (amount == 0) revert AmountIsZero();
            ICollateralManager(cm).depositCollateral(msg.sender, asset, amount);
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
    function batchBorrow(address[] calldata assets, uint256[] calldata amounts) external nonReentrant {
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
    ) external nonReentrant {
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
     * @notice Batch withdraw collateral from CollateralManager.
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
    function batchWithdraw(address[] calldata assets, uint256[] calldata amounts) external nonReentrant {
        if (assets.length != amounts.length) revert ArrayLengthMismatch(assets.length, amounts.length);
        if (assets.length == 0) revert EmptyArray();
        if (assets.length > _MAX_BATCH_SIZE) revert VaultCore__BatchTooLarge(assets.length, _MAX_BATCH_SIZE);

        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            uint256 amount = amounts[i];
            if (asset == address(0)) revert ZeroAddress();
            if (amount == 0) revert AmountIsZero();
            ICollateralManager(cm).withdrawCollateral(msg.sender, asset, amount);
        }
    }

    /*━━━━━━━━━━━━━━━ Data push entrypoints (business -> View) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Push full user position update to View.
     * @dev Security: only registered business modules; view address must be set
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt
    ) external onlyBusinessModule {
        _forwardUserPositionUpdate(user, asset, collateral, debt, bytes32(0), 0, 0);
    }

    /**
     * @notice Push full user position update with requestId/seq.
     * @dev Security: only registered business modules; view address must be set
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq
    ) external onlyBusinessModule {
        _forwardUserPositionUpdate(user, asset, collateral, debt, requestId, seq, 0);
    }

    /**
     * @notice Push full user position update with nextVersion.
     * @dev Security: only registered business modules; view address must be set
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        uint64 nextVersion
    ) external onlyBusinessModule {
        _forwardUserPositionUpdate(user, asset, collateral, debt, bytes32(0), 0, nextVersion);
    }

    /**
     * @notice Push full user position update with requestId/seq and nextVersion.
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
     * @notice Push delta user position update to View.
     * @dev Security: only registered business modules; view address must be set
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta
    ) external onlyBusinessModule {
        _forwardUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, bytes32(0), 0, 0);
    }

    /**
     * @notice Push delta user position update with requestId/seq.
     * @dev Security: only registered business modules; view address must be set
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq
    ) external onlyBusinessModule {
        _forwardUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, requestId, seq, 0);
    }

    /**
     * @notice Push delta user position update with nextVersion.
     * @dev Security: only registered business modules; view address must be set
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        uint64 nextVersion
    ) external onlyBusinessModule {
        _forwardUserPositionUpdateDelta(user, asset, collateralDelta, debtDelta, bytes32(0), 0, nextVersion);
    }

    /**
     * @notice Push delta user position update with requestId/seq and nextVersion.
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
     * @notice Push asset stats update to View (compat path).
     * @dev Security: only registered business modules; view address must be set
     */
    function pushAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price
    ) external onlyBusinessModule {
        _forwardAssetStatsUpdate(asset, totalCollateral, totalDebt, price, bytes32(0), 0);
    }

    /**
     * @notice Push asset stats update with request context.
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

    function _forwardAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) internal {
        if (_viewContractAddr == address(0)) revert ZeroAddress();
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
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    uint256[50] private __gap;
}

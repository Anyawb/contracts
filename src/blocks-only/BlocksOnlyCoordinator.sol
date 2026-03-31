// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ActionKeys} from "../constants/ActionKeys.sol";
import {DataPushTypes} from "../constants/DataPushTypes.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {
    AmountIsZero,
    AssetNotAllowed,
    NotAContract,
    ZeroAddress
} from "../errors/StandardErrors.sol";
import {IAssetWhitelistRead} from "../interfaces/IAssetWhitelistRead.sol";
import {IAccessControlManager} from "../interfaces/IAccessControlManager.sol";
import {IBlocksOnlyCoordinator} from "../interfaces/IBlocksOnlyCoordinator.sol";
import {ICollateralManager} from "../interfaces/ICollateralManager.sol";
import {ILenderPoolVault} from "../interfaces/ILenderPoolVault.sol";
import {ILendingEngineDebtRead} from "../interfaces/ILendingEngineDebtRead.sol";
import {ILiquidationManager} from "../interfaces/ILiquidationManager.sol";
import {IPositionViewValuation} from "../interfaces/IPositionViewValuation.sol";
import {IRegistry} from "../interfaces/IRegistry.sol";
import {IVaultCoreBorrowForBlocks} from "../interfaces/IVaultCoreBorrowForBlocks.sol";
import {DataPushLibrary} from "../libraries/DataPushLibrary.sol";
import {SystemEvents} from "../Vault/SystemEvents.sol";

/**
 * @title BlocksOnlyCoordinator
 * @notice Registry-bound coordinator for the standalone blocks-only borrowing product.
 * @dev Reverts if:
 *      - registry-dependent module resolution fails or resolves to an invalid contract where required
 *      - callers violate product-specific permissions, order-state constraints, or term constraints
 *      - downstream pool, VaultCore, lending-engine, collateral, token-transfer, or liquidation operations revert
 *
 * Security:
 * - Uses the Registry as the module-address SSOT for pool, VaultCore, access control, collateral, and liquidation
 *   dependencies.
 * - Write paths are gated by either the Vault business logic module, the borrower, or explicit ActionKeys role checks.
 * - Maturity is block-based. The collateral-selection helper performs best-effort valuation reads and falls back to raw
 *   collateral balances when valuation reads fail.
 */
contract BlocksOnlyCoordinator is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    IBlocksOnlyCoordinator
{
    using SafeERC20 for IERC20;

    /*━━━━━━━━━━━━━━━ STORAGE ━━━━━━━━━━━━━━━*/

    address private _registryAddr;
    uint256 private _orderIdCounter;
    mapping(uint256 orderId => BlocksOnlyOrder order) private _orders;
    mapping(address borrower => uint256[] orderIds) private _borrowerOrderIds;
    uint256[47] private __gap;

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when a Vault-business-logic-only function is called by any other account.
    error BlocksOnlyCoordinator__OnlyVaultBusinessLogic();

    /// @dev Reverts when a borrower-only action is called by an account other than the order borrower.
    error BlocksOnlyCoordinator__OnlyBorrower();

    /// @dev Reverts when `orderId` is not lower than the number of created orders.
    error BlocksOnlyCoordinator__InvalidOrderId(uint256 orderId);

    /// @dev Reverts when an action expects an open order but the referenced order is missing or already closed.
    error BlocksOnlyCoordinator__OrderNotActive(
        uint256 orderId,
        BlocksOnlyOrderStatus status
    );

    /// @dev Reverts when a matched order requests a block term that the current product configuration does not support.
    error BlocksOnlyCoordinator__InvalidTermBlocks(uint256 termBlocks);

    /// @dev Reverts when a matched order requests a rate that the current product configuration does not support.
    error BlocksOnlyCoordinator__InvalidRateBps(uint256 rateBps);

    /// @dev Reverts when the provided lender does not equal the registered lender pool vault.
    error BlocksOnlyCoordinator__InvalidLender(
        address expected,
        address actual
    );

    /// @dev Reverts when settlement or liquidation is attempted before the order reaches `maturityBlock`.
    error BlocksOnlyCoordinator__NotMatured(
        uint256 orderId,
        uint256 maturityBlock,
        uint256 currentBlock
    );

    /// @dev Reverts when the liquidation path cannot identify any non-zero collateral for `borrower`.
    error BlocksOnlyCoordinator__NoCollateral(address borrower);

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when a matched blocks-only order is finalized and debt is booked.
     * @dev Emitted after principal transfer, VaultCore debt booking, and local order storage initialization complete.
     * @param orderId Newly assigned coordinator order id.
     * @param borrower Borrower receiving the principal.
     * @param lender Registered pool vault that funded the order.
     * @param asset Debt asset address.
     * @param principal Principal amount in token base units.
     * @param termBlocks Loan term measured in blocks.
     * @param startBlock Activation block number.
     * @param maturityBlock First block at which settlement or liquidation becomes eligible.
     */
    event BlocksOnlyMatchFinalized(
        uint256 indexed orderId,
        address indexed borrower,
        address indexed lender,
        address asset,
        uint256 principal,
        uint256 termBlocks,
        uint256 startBlock,
        uint256 maturityBlock
    );

    /**
     * @notice Emitted when repayment is forwarded to the lender and reflected in the debt ledger.
     * @dev `remainingDebt` is read from the lending engine after the VaultCore repayment hook executes.
     * @param orderId Coordinator order id.
     * @param payer Account that supplied the repayment tokens. Current implementation expects the borrower.
     * @param borrower Borrower whose debt was reduced.
     * @param asset Debt asset address.
     * @param repayAmount Repayment amount in token base units.
     * @param remainingDebt Remaining debt reported by the lending engine after repayment.
     */
    event BlocksOnlyRepaymentRecorded(
        uint256 indexed orderId,
        address indexed payer,
        address indexed borrower,
        address asset,
        uint256 repayAmount,
        uint256 remainingDebt
    );

    /**
     * @notice Emitted when a matured order is settled because no remaining debt is observed.
     * @dev Settlement releases all currently tracked collateral assets back to the borrower.
     * @param orderId Coordinator order id.
     * @param borrower Borrower whose order was settled.
     * @param asset Debt asset address.
     * @param closeBlock Block number at which the order was closed.
     */
    event BlocksOnlyOrderSettled(
        uint256 indexed orderId,
        address indexed borrower,
        address indexed asset,
        uint256 closeBlock
    );

    /**
     * @notice Emitted when a matured order is liquidated against borrower collateral.
     * @dev The selected collateral amount may be smaller than the borrower's full collateral balance when the optional
     *      debt-valuation read succeeds and yields a lower target amount.
     * @param orderId Coordinator order id.
     * @param borrower Borrower whose order was liquidated.
     * @param liquidator Caller that triggered the liquidation path.
     * @param asset Debt asset address.
     * @param collateralAsset Collateral asset selected for liquidation.
     * @param collateralAmount Collateral amount passed to the liquidation manager in token base units.
     * @param debtAmount Remaining debt amount passed to the liquidation manager in debt-asset base units.
     * @param closeBlock Block number at which the order was closed.
     */
    event BlocksOnlyOrderLiquidated(
        uint256 indexed orderId,
        address indexed borrower,
        address indexed liquidator,
        address asset,
        address collateralAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 closeBlock
    );

    /*━━━━━━━━━━━━━━━ INITIALIZATION ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev Reverts when the registry address is unset or not a contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Reverts unless the caller is the registered Vault business logic module.
    modifier onlyVaultBusinessLogic() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        address vbl = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_VAULT_BUSINESS_LOGIC
        );
        if (msg.sender != vbl)
            revert BlocksOnlyCoordinator__OnlyVaultBusinessLogic();
        _;
    }

    /**
     * @notice Initializes the coordinator with the registry address.
     * @dev Reverts if:
     *      - `initialRegistryAddr == address(0)`
     *      - `initialRegistryAddr` is not a contract
     *      - the proxy has already been initialized
     *
     * Security:
     * - One-time initializer for the UUPS proxy deployment.
     * - The registry becomes the module-address SSOT used by every write and settlement path.
     *
     * @param initialRegistryAddr Registry contract address.
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

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice Finalizes a matched blocks-only order, transfers principal, and books debt in VaultCore.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the caller is not the registered Vault business logic module
     *      - the coordinator is paused
     *      - `params.borrower` or `params.borrowAsset` is the zero address
     *      - `params.amount == 0`
     *      - `params.termBlocks != 1`
     *      - `params.rateBps != 0`
     *      - `params.lender` does not equal the registered lender pool vault
     *      - the asset whitelist rejects `params.borrowAsset`
     *      - token transfer, registry lookup, or VaultCore debt-booking calls revert
     *
     * Security:
     * - Non-reentrant write path gated by the registered Vault business logic module.
     * - Uses the lender pool vault as the only allowed funding source in the current implementation.
     * - Emits both coordinator events and DataPush payloads after the order is stored.
     *
     * @param params Matched order inputs, including participants, asset, amount, and term.
     * @return orderId Newly assigned coordinator order id.
     */

    function finalizeMatchBlocks(
        BlocksOnlyMatchParams calldata params
    )
        external
        onlyValidRegistry
        onlyVaultBusinessLogic
        whenNotPaused
        nonReentrant
        returns (uint256 orderId)
    {
        if (params.borrower == address(0) || params.borrowAsset == address(0))
            revert ZeroAddress();
        if (params.amount == 0) revert AmountIsZero();
        if (params.termBlocks != 1)
            revert BlocksOnlyCoordinator__InvalidTermBlocks(params.termBlocks);
        if (params.rateBps != 0)
            revert BlocksOnlyCoordinator__InvalidRateBps(params.rateBps);

        address pool = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LENDER_POOL_VAULT
        );
        if (params.lender != pool) {
            revert BlocksOnlyCoordinator__InvalidLender(pool, params.lender);
        }

        address assetWhitelist = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ASSET_WHITELIST
        );
        if (
            !IAssetWhitelistRead(assetWhitelist).isAssetAllowed(
                params.borrowAsset
            )
        ) {
            revert AssetNotAllowed();
        }

        ILenderPoolVault(pool).transferOut(
            params.borrowAsset,
            address(this),
            params.amount
        );
        IERC20(params.borrowAsset).safeTransfer(params.borrower, params.amount);

        address vaultCore = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_VAULT_CORE
        );
        IVaultCoreBorrowForBlocks(vaultCore).borrowForBlocks(
            params.borrower,
            params.borrowAsset,
            params.amount,
            params.termBlocks
        );

        orderId = _orderIdCounter;
        unchecked {
            _orderIdCounter++;
        }

        uint256 startBlock = block.number;
        uint256 maturityBlock = startBlock + params.termBlocks;
        _orders[orderId] = BlocksOnlyOrder({
            principal: params.amount,
            repaidPrincipal: 0,
            rateBps: params.rateBps,
            termBlocks: params.termBlocks,
            borrower: params.borrower,
            lender: params.lender,
            asset: params.borrowAsset,
            startBlock: startBlock,
            maturityBlock: maturityBlock,
            closeBlock: 0,
            status: BlocksOnlyOrderStatus.ACTIVE
        });
        _borrowerOrderIds[params.borrower].push(orderId);

        emit BlocksOnlyMatchFinalized(
            orderId,
            params.borrower,
            params.lender,
            params.borrowAsset,
            params.amount,
            params.termBlocks,
            startBlock,
            maturityBlock
        );

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED,
            abi.encode(
                address(this),
                orderId,
                params.borrower,
                params.lender,
                params.borrowAsset,
                params.amount,
                params.termBlocks,
                startBlock,
                maturityBlock
            )
        );

        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
            msg.sender,
            block.number
        );
    }

    /**
     * @notice Repays a blocks-only order and forwards the repayment asset to the recorded lender.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the coordinator is paused
     *      - `repayAmount == 0`
     *      - `orderId` does not reference an open order
     *      - the caller is not the borrower stored on the order
     *      - token transfer, registry lookup, VaultCore repayment, or lending-engine debt reads revert
     *
     * Security:
     * - Borrower-only non-reentrant write path.
     * - Local settlement state relies on the lending-engine debt SSOT; `repaidPrincipal` is informational only.
     *
     * @param orderId Coordinator order id.
     * @param repayAmount Repayment amount in debt-asset base units.
     * @return remainingDebt Remaining debt reported by the lending engine after repayment.
     */
    function repayBlocks(
        uint256 orderId,
        uint256 repayAmount
    )
        external
        onlyValidRegistry
        whenNotPaused
        nonReentrant
        returns (uint256 remainingDebt)
    {
        if (repayAmount == 0) revert AmountIsZero();

        BlocksOnlyOrder storage order = _getOpenOrder(orderId);
        if (msg.sender != order.borrower)
            revert BlocksOnlyCoordinator__OnlyBorrower();

        IERC20(order.asset).safeTransferFrom(
            msg.sender,
            order.lender,
            repayAmount
        );

        address vaultCore = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_VAULT_CORE
        );
        IVaultCoreBorrowForBlocks(vaultCore).repayForBlocks(
            order.borrower,
            order.asset,
            repayAmount
        );

        address lendingEngine = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LE
        );
        remainingDebt = ILendingEngineDebtRead(lendingEngine).getDebt(
            order.borrower,
            order.asset
        );

        order.repaidPrincipal += repayAmount;
        if (remainingDebt == 0) {
            order.status = BlocksOnlyOrderStatus.REPAID;
        }

        emit BlocksOnlyRepaymentRecorded(
            orderId,
            msg.sender,
            order.borrower,
            order.asset,
            repayAmount,
            remainingDebt
        );

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BLOCKS_ONLY_REPAID,
            abi.encode(
                address(this),
                orderId,
                msg.sender,
                order.borrower,
                order.asset,
                repayAmount,
                remainingDebt,
                block.number
            )
        );
    }

    /**
     * @notice Settles a matured order with no remaining debt or liquidates collateral for the remaining debt.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the coordinator is paused
     *      - the caller lacks `ActionKeys.ACTION_LIQUIDATE`
     *      - `orderId` does not reference an open order
     *      - the current block is below the order's maturity block
     *      - registry lookup, debt reads, collateral release, or liquidation-manager calls revert
     *      - no non-zero collateral can be selected for the liquidation path
     *
     * Security:
     * - Privileged non-reentrant settlement path.
     * - Debt-free settlement releases all tracked collateral assets to the borrower.
     * - Liquidation uses best-effort valuation reads and falls back to balance-based collateral selection on valuation
     *   failures.
     *
     * @param orderId Coordinator order id.
     */
    function settleOrLiquidateBlocks(
        uint256 orderId
    ) external onlyValidRegistry whenNotPaused nonReentrant {
        _requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender);

        BlocksOnlyOrder storage order = _getOpenOrder(orderId);
        if (block.number < order.maturityBlock) {
            revert BlocksOnlyCoordinator__NotMatured(
                orderId,
                order.maturityBlock,
                block.number
            );
        }

        address lendingEngine = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LE
        );
        uint256 remainingDebt = ILendingEngineDebtRead(lendingEngine).getDebt(
            order.borrower,
            order.asset
        );

        if (
            remainingDebt == 0 || order.status == BlocksOnlyOrderStatus.REPAID
        ) {
            _releaseAllCollateral(order.borrower);
            order.status = BlocksOnlyOrderStatus.SETTLED;
            order.closeBlock = block.number;

            emit BlocksOnlyOrderSettled(
                orderId,
                order.borrower,
                order.asset,
                order.closeBlock
            );

            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_BLOCKS_ONLY_SETTLED,
                abi.encode(
                    address(this),
                    orderId,
                    order.borrower,
                    order.asset,
                    order.closeBlock
                )
            );
            return;
        }

        (
            address collateralAsset,
            uint256 collateralAmount
        ) = _selectLiquidationCollateral(
                order.borrower,
                order.asset,
                remainingDebt
            );

        address liquidationManager = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LIQUIDATION_MANAGER
        );
        ILiquidationManager(liquidationManager).liquidate(
            order.borrower,
            collateralAsset,
            order.asset,
            collateralAmount,
            remainingDebt,
            0
        );

        order.status = BlocksOnlyOrderStatus.LIQUIDATED;
        order.closeBlock = block.number;

        emit BlocksOnlyOrderLiquidated(
            orderId,
            order.borrower,
            msg.sender,
            order.asset,
            collateralAsset,
            collateralAmount,
            remainingDebt,
            order.closeBlock
        );

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BLOCKS_ONLY_LIQUIDATED,
            abi.encode(
                address(this),
                orderId,
                order.borrower,
                order.asset,
                msg.sender,
                collateralAsset,
                collateralAmount,
                remainingDebt,
                order.closeBlock
            )
        );
    }

    /**
     * @notice Returns the stored order record for `orderId`.
     * @dev Reverts if:
     *      - (none expected; nonexistent order ids return the default struct in storage)
     *
     * Security:
     * - Raw storage read with no access control.
     * - Callers that need existence validation should compare `orderId` against {getBlocksOnlyOrderCount}.
     *
     * @param orderId Coordinator order id.
     * @return order Stored order struct.
     */
    function getBlocksOnlyOrder(
        uint256 orderId
    ) external view returns (BlocksOnlyOrder memory order) {
        return _orders[orderId];
    }

    /**
     * @notice Returns the number of orders created so far.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only counter used for order-id existence checks and system pagination.
     *
     * @return count Total number of created orders.
     */
    function getBlocksOnlyOrderCount() external view returns (uint256 count) {
        return _orderIdCounter;
    }

    /**
     * @notice Returns the number of order ids tracked for `borrower`.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only borrower index size query.
     *
     * @param borrower Borrower address.
     * @return count Number of order ids associated with `borrower`.
     */
    function getBlocksOnlyOrderCountByBorrower(
        address borrower
    ) external view returns (uint256 count) {
        return _borrowerOrderIds[borrower].length;
    }

    /**
     * @notice Returns a paginated slice of borrower order ids and the full borrower order count.
     * @dev Reverts if:
     *      - (none expected; out-of-range pages or `limit == 0` return an empty array)
     *
     * Security:
     * - Read-only pagination helper over the borrower's local order-id index.
     * - The function does not enforce a maximum page size; callers should apply their own paging limits.
     *
     * @param borrower Borrower address.
     * @param offset Zero-based start index within the borrower's order-id list.
     * @param limit Maximum number of order ids to return.
     * @return orderIds Borrower order ids in stored order.
     * @return totalCount Total number of order ids tracked for `borrower`.
     */
    function getBlocksOnlyOrderIdsByBorrower(
        address borrower,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory orderIds, uint256 totalCount) {
        uint256[] storage borrowerOrderIds = _borrowerOrderIds[borrower];
        totalCount = borrowerOrderIds.length;
        if (offset >= totalCount || limit == 0) {
            return (new uint256[](0), totalCount);
        }

        uint256 end = offset + limit;
        if (end > totalCount) {
            end = totalCount;
        }

        uint256 pageLen = end - offset;
        orderIds = new uint256[](pageLen);
        for (uint256 i; i < pageLen; ) {
            orderIds[i] = borrowerOrderIds[offset + i];
            unchecked {
                ++i;
            }
        }
    }

    /*━━━━━━━━━━━━━━━ INTERNAL HELPERS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns an open order storage reference for `orderId`.
     * @dev Reverts if:
     *      - `orderId` has not been created
     *      - the referenced order is `NONE`, `SETTLED`, or `LIQUIDATED`
     *
     * Security:
     * - Internal state gate used by repayment and settlement paths.
     *
     * @param orderId Coordinator order id.
     * @return order Storage reference for the open order.
     */
    function _getOpenOrder(
        uint256 orderId
    ) internal view returns (BlocksOnlyOrder storage order) {
        if (orderId >= _orderIdCounter) {
            revert BlocksOnlyCoordinator__InvalidOrderId(orderId);
        }

        order = _orders[orderId];
        if (
            order.status == BlocksOnlyOrderStatus.NONE ||
            order.status == BlocksOnlyOrderStatus.SETTLED ||
            order.status == BlocksOnlyOrderStatus.LIQUIDATED
        ) {
            revert BlocksOnlyCoordinator__OrderNotActive(orderId, order.status);
        }
    }

    /**
     * @notice Withdraws every currently tracked collateral balance for `borrower` back to the borrower.
     * @dev Reverts if:
     *      - the collateral manager dependency is missing
     *      - collateral enumeration or withdrawal calls revert
     *
     * Security:
     * - Internal settlement helper used only after the order is considered debt-free.
     * - Releases all tracked collateral assets without imposing per-asset limits.
     *
     * @param borrower Borrower whose collateral should be released.
     */
    function _releaseAllCollateral(address borrower) internal {
        address collateralManager = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_CM
        );
        address[] memory assets = ICollateralManager(collateralManager)
            .getUserCollateralAssets(borrower);
        for (uint256 i; i < assets.length; ) {
            uint256 bal = ICollateralManager(collateralManager).getCollateral(
                borrower,
                assets[i]
            );
            if (bal > 0) {
                ICollateralManager(collateralManager).withdrawCollateralTo(
                    borrower,
                    assets[i],
                    bal,
                    borrower
                );
            }
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Selects the collateral asset and amount to pass into the liquidation manager.
     * @dev Reverts if:
     *      - the collateral manager or lending engine dependency is missing
     *      - collateral enumeration or balance reads revert
     *      - no non-zero collateral balance exists for `borrower`
     *
     * Security:
     * - Best-effort valuation helper: optional position-view and debt-valuation reads are wrapped in `try/catch` and
     *   ignored on failure.
     * - Falls back to choosing the non-zero collateral balance with the largest observed value proxy.
     *
     * @param borrower Borrower being liquidated.
     * @param debtAsset Debt asset address used for optional debt valuation.
     * @param remainingDebt Remaining debt amount in debt-asset base units.
     * @return collateralAsset Selected collateral asset.
     * @return collateralAmount Collateral amount to liquidate in collateral-asset base units.
     */
    function _selectLiquidationCollateral(
        address borrower,
        address debtAsset,
        uint256 remainingDebt
    )
        internal
        view
        returns (address collateralAsset, uint256 collateralAmount)
    {
        address collateralManager = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_CM
        );
        address[] memory assets = ICollateralManager(collateralManager)
            .getUserCollateralAssets(borrower);

        address positionView = IRegistry(_registryAddr).getModule(
            ModuleKeys.KEY_POSITION_VIEW
        );
        address lendingEngine = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LE
        );

        uint256 bestValue;
        uint256 bestBalance;
        for (uint256 i; i < assets.length; ) {
            address asset = assets[i];
            uint256 balance = ICollateralManager(collateralManager)
                .getCollateral(borrower, asset);
            if (balance > 0) {
                uint256 value = balance;
                if (
                    positionView != address(0) && positionView.code.length > 0
                ) {
                    try
                        IPositionViewValuation(positionView).getAssetValue(
                            asset,
                            balance
                        )
                    returns (uint256 assetValue) {
                        if (assetValue > 0) {
                            value = assetValue;
                        }
                    } catch {
                        // Best-effort valuation fallback keeps the largest raw balance candidate.
                        value = value;
                    }
                }
                if (value > bestValue) {
                    bestValue = value;
                    bestBalance = balance;
                    collateralAsset = asset;
                }
            }
            unchecked {
                ++i;
            }
        }

        if (collateralAsset == address(0) || bestBalance == 0) {
            revert BlocksOnlyCoordinator__NoCollateral(borrower);
        }

        collateralAmount = bestBalance;
        if (bestValue > 0) {
            try
                ILendingEngineDebtRead(lendingEngine).calculateDebtValue(
                    borrower,
                    debtAsset
                )
            returns (uint256 debtValue) {
                if (debtValue > 0 && remainingDebt > 0) {
                    uint256 targetCollateralAmount = (bestBalance * debtValue +
                        bestValue -
                        1) / bestValue;
                    if (
                        targetCollateralAmount > 0 &&
                        targetCollateralAmount < bestBalance
                    ) {
                        collateralAmount = targetCollateralAmount;
                    }
                }
            } catch {
                // Best-effort debt valuation fallback keeps the full selected collateral balance.
                collateralAmount = collateralAmount;
            }
        }
    }

    /**
     * @notice Requires `caller` to hold `role` in the registry's access-control manager.
     * @dev Reverts if:
     *      - the access-control module is missing
     *      - the access-control manager rejects the role check
     *
     * Security:
     * - Internal adapter that centralizes ActionKeys authorization against the registry-bound ACM.
     *
     * @param role ActionKeys-compatible role identifier.
     * @param caller Caller address to validate.
     */
    function _requireRole(bytes32 role, address caller) internal view {
        address acm = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acm).requireRole(role, caller);
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorizes a UUPS implementation upgrade.
     * @dev Reverts if:
     *      - `newImplementation == address(0)`
     *      - the access-control module is missing
     *      - `msg.sender` lacks `ActionKeys.ACTION_UPGRADE_MODULE`
     *
     * Security:
     * - Upgrade authorization is delegated to the registry-bound access-control manager.
     * - This hook validates the target is non-zero but does not perform interface-compatibility checks.
     *
     * @param newImplementation Proposed implementation address.
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        address acm = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        IAccessControlManager(acm).requireRole(
            ActionKeys.ACTION_UPGRADE_MODULE,
            msg.sender
        );
    }
}

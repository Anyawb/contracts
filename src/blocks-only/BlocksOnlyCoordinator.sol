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
import {IOrderStateStoreV2} from "../interfaces/IOrderStateStoreV2.sol";
import {IRegistry} from "../interfaces/IRegistry.sol";
import {DataPushLibrary} from "../libraries/DataPushLibrary.sol";
import {SystemEvents} from "../Vault/SystemEvents.sol";

interface IBlocksOnlyEasyEmissionController {
    function onBlocksOnlyTradeSettlement(
        address borrower,
        address lender,
        address asset,
        uint256 orderId,
        uint256 amountBaseUnits
    ) external;
}

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
 * - Maturity close is permissionless by design in the current implementation.
 * - Matched bound collateral is staged into coordinator custody at finalization and later released from the
 *   coordinator's own balance on close or maturity delivery.
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
    uint256[46] private __gap;

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

    /// @dev Reverts when the trade-close path is attempted while debt remains outstanding.
    error BlocksOnlyCoordinator__TradeCloseRequiresZeroDebt(
        uint256 orderId,
        uint256 remainingDebt
    );

    /// @dev Reverts when a repayment exceeds the coordinator-local remaining settlement amount.
    error BlocksOnlyCoordinator__RepayAmountExceedsRemaining(
        uint256 orderId,
        uint256 repayAmount,
        uint256 remainingDebt
    );

    /// @dev Reverts when the coordinator custody does not hold the expected bound collateral for `borrower`.
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
     * @notice Emitted when a debt-free blocks-only order is closed through the trade-style close path.
     * @dev Trade-close is distinct from maturity-gated settlement so integrations can separate trade-like lifecycle
     *      completion from borrow-style settlement analytics.
     * @param orderId Coordinator order id.
     * @param borrower Borrower whose order was closed.
     * @param asset Debt asset address.
     * @param closeBlock Block number at which the order was closed.
     */
    event BlocksOnlyOrderTradeClosed(
        uint256 indexed orderId,
        address indexed borrower,
        address indexed asset,
        uint256 closeBlock
    );

    /**
     * @notice Emitted when maturity closes the order by delivering bound collateral to the lender.
     * @param orderId Coordinator order id.
     * @param borrower Borrower whose pledged collateral was delivered.
     * @param lender Recorded lender receiving the collateral delivery.
     * @param asset Principal asset address used for the trade amount.
     * @param collateralAsset Order-bound collateral asset.
     * @param collateralAmount Order-bound collateral amount.
     * @param closeBlock Block number at which the order was closed.
     */
    event BlocksOnlyOrderDelivered(
        uint256 indexed orderId,
        address indexed borrower,
        address indexed lender,
        address asset,
        address collateralAsset,
        uint256 collateralAmount,
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
     * @notice Finalizes a matched blocks-only order, stages bound collateral into coordinator custody, transfers
     *         principal, and records local settlement state.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the caller is not the registered Vault business logic module
     *      - the coordinator is paused
     *      - `params.borrower`, `params.collateralAsset`, or `params.borrowAsset` is the zero address
     *      - `params.collateralAmount == 0` or `params.amount == 0`
     *      - `params.termBlocks != 1`
     *      - `params.rateBps != 0`
     *      - `params.lender` does not equal the registered lender pool vault
     *      - the asset whitelist rejects `params.borrowAsset` or `params.collateralAsset`
     *      - bound-collateral staging, token transfer, or registry lookup calls revert
     *
     * Security:
     * - Non-reentrant write path gated by the registered Vault business logic module.
     * - Uses the lender pool vault as the only allowed funding source in the current implementation.
     * - Moves the order-bound collateral out of the borrower's collateral ledger into coordinator custody before
     *   creating the order, so the borrower cannot withdraw or reuse it after match.
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
        if (
            params.borrower == address(0) ||
            params.collateralAsset == address(0) ||
            params.borrowAsset == address(0)
        ) revert ZeroAddress();
        if (params.amount == 0) revert AmountIsZero();
        if (params.collateralAmount == 0) revert AmountIsZero();
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
        if (
            !IAssetWhitelistRead(assetWhitelist).isAssetAllowed(
                params.collateralAsset
            )
        ) {
            revert AssetNotAllowed();
        }

        _stageBoundCollateral(
            params.borrower,
            params.collateralAsset,
            params.collateralAmount
        );

        ILenderPoolVault(pool).transferOut(
            params.borrowAsset,
            address(this),
            params.amount
        );
        IERC20(params.borrowAsset).safeTransfer(params.borrower, params.amount);

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
            collateralAsset: params.collateralAsset,
            collateralAmount: params.collateralAmount,
            asset: params.borrowAsset,
            startBlock: startBlock,
            maturityBlock: maturityBlock,
            closeBlock: 0,
            status: BlocksOnlyOrderStatus.ACTIVE,
            maturityDeliveredToLender: false
        });
        _borrowerOrderIds[params.borrower].push(orderId);

        (
            IOrderStateStoreV2 orderStateStore,
            bool hasOrderStateStore
        ) = _tryOrderStateStore();
        if (hasOrderStateStore) {
            orderStateStore.initializeBlocksOnlyOrderState(orderId, startBlock);
        }

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
     *      - token transfer or registry lookup reverts
     *
     * Security:
     * - Borrower-only non-reentrant write path.
     * - Local settlement state is the product SSOT; the generic debt ledger is not consulted.
     * - A debt-free repay keeps the order open until an explicit close/settle transition is executed.
     *
     * @param orderId Coordinator order id.
     * @param repayAmount Repayment amount in debt-asset base units.
     * @return remainingDebt Remaining open settlement amount after repayment.
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

        uint256 remainingBefore = _remainingSettlementAmount(order);
        if (repayAmount > remainingBefore) {
            revert BlocksOnlyCoordinator__RepayAmountExceedsRemaining(
                orderId,
                repayAmount,
                remainingBefore
            );
        }

        IERC20(order.asset).safeTransferFrom(
            msg.sender,
            order.lender,
            repayAmount
        );
        order.repaidPrincipal += repayAmount;
        remainingDebt = _remainingSettlementAmount(order);

        if (remainingDebt == 0) {
            (
                IOrderStateStoreV2 orderStateStore,
                bool hasOrderStateStore
            ) = _tryOrderStateStore();
            if (hasOrderStateStore) {
                orderStateStore.markBlocksOnlyRepaid(orderId, order.startBlock);
            }
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
     * @notice Closes a debt-free blocks-only order through the trade-style close path without waiting for maturity.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the coordinator is paused
     *      - `orderId` does not reference an open order
     *      - the coordinator-local remaining settlement amount is non-zero
     *      - collateral release dependencies revert
     *
     * Security:
     * - Permissionless close path by design: if debt is already zero, any caller may help finalize the trade-style
     *   order lifecycle, but collateral is always returned to the borrower.
     * - Keeps trade-like completion separate from maturity-gated settlement and liquidation.
     *
     * @param orderId Coordinator order id.
     */
    function closeRepaidTradeBlocks(
        uint256 orderId
    ) external onlyValidRegistry whenNotPaused nonReentrant {
        BlocksOnlyOrder storage order = _getOpenOrder(orderId);

        uint256 remainingDebt = _remainingSettlementAmount(order);
        if (remainingDebt != 0) {
            revert BlocksOnlyCoordinator__TradeCloseRequiresZeroDebt(
                orderId,
                remainingDebt
            );
        }

        uint256 closeBlock = _closeDebtFreeOrder(
            order,
            BlocksOnlyOrderStatus.TRADE_CLOSED
        );

        (
            IOrderStateStoreV2 orderStateStore,
            bool hasOrderStateStore
        ) = _tryOrderStateStore();
        if (hasOrderStateStore) {
            orderStateStore.applyBlocksOnlyCloseTransition(
                orderId,
                order.startBlock,
                IOrderStateStoreV2.CloseReason.BLOCKS_TRADE_CLOSE,
                IOrderStateStoreV2
                    .CollateralDispositionStatus
                    .RETURNED_TO_BORROWER
            );
        }

        emit BlocksOnlyOrderTradeClosed(
            orderId,
            order.borrower,
            order.asset,
            closeBlock
        );

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BLOCKS_ONLY_TRADE_CLOSED,
            abi.encode(
                address(this),
                orderId,
                order.borrower,
                order.asset,
                closeBlock
            )
        );

        _tryEmitBlocksOnlyEasy(orderId, order);
    }

    /**
     * @notice Completes maturity-gated product settlement for a blocks-only order.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the coordinator is paused
     *      - `orderId` does not reference an open order
     *      - the current block is below the order's maturity block
     *      - registry lookup or collateral delivery calls revert
     *
     * Security:
     * - Permissionless non-reentrant maturity-close path.
     * - Debt-free maturity close returns coordinator-held order-bound collateral to the borrower.
     * - Unpaid maturity close delivers coordinator-held order-bound collateral to the recorded lender and
     *   extinguishes the remaining settlement amount locally.
     *
     * @param orderId Coordinator order id.
     */
    function settleOrLiquidateBlocks(
        uint256 orderId
    ) external onlyValidRegistry whenNotPaused nonReentrant {
        BlocksOnlyOrder storage order = _getOpenOrder(orderId);
        if (block.number < order.maturityBlock) {
            revert BlocksOnlyCoordinator__NotMatured(
                orderId,
                order.maturityBlock,
                block.number
            );
        }

        uint256 remainingDebt = _remainingSettlementAmount(order);

        if (remainingDebt == 0) {
            uint256 closeBlock = _closeDebtFreeOrder(
                order,
                BlocksOnlyOrderStatus.SETTLED
            );

            (
                IOrderStateStoreV2 orderStateStore,
                bool hasOrderStateStore
            ) = _tryOrderStateStore();
            if (hasOrderStateStore) {
                orderStateStore.applyBlocksOnlyCloseTransition(
                    orderId,
                    order.startBlock,
                    IOrderStateStoreV2.CloseReason.BLOCKS_MATURITY_CLOSE,
                    IOrderStateStoreV2
                        .CollateralDispositionStatus
                        .RETURNED_TO_BORROWER
                );
            }

            emit BlocksOnlyOrderSettled(
                orderId,
                order.borrower,
                order.asset,
                closeBlock
            );

            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_BLOCKS_ONLY_SETTLED,
                abi.encode(
                    address(this),
                    orderId,
                    order.borrower,
                    order.asset,
                    closeBlock
                )
            );

            _tryEmitBlocksOnlyEasy(orderId, order);
            return;
        }

        _releaseBoundCollateral(order, order.lender);

        // Maturity delivery closes the order and extinguishes local remaining settlement amount.
        order.repaidPrincipal = order.principal;
        order.maturityDeliveredToLender = true;

        order.status = BlocksOnlyOrderStatus.SETTLED;

        order.closeBlock = block.number;

        (
            IOrderStateStoreV2 deliveredOrderStateStore,
            bool hasDeliveredStore
        ) = _tryOrderStateStore();
        if (hasDeliveredStore) {
            deliveredOrderStateStore.applyBlocksOnlyCloseTransition(
                orderId,
                order.startBlock,
                IOrderStateStoreV2.CloseReason.BLOCKS_MATURITY_CLOSE,
                IOrderStateStoreV2
                    .CollateralDispositionStatus
                    .DELIVERED_TO_LENDER
            );
        }

        emit BlocksOnlyOrderDelivered(
            orderId,
            order.borrower,
            order.lender,
            order.asset,
            order.collateralAsset,
            order.collateralAmount,
            order.closeBlock
        );

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_BLOCKS_ONLY_DELIVERED,
            abi.encode(
                address(this),
                orderId,
                order.borrower,
                order.asset,
                order.lender,
                order.collateralAsset,
                order.collateralAmount,
                order.closeBlock
            )
        );

        _tryEmitBlocksOnlyEasy(orderId, order);
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
     *      - the referenced order is `NONE`, `SETTLED`, or `TRADE_CLOSED`
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
            order.status == BlocksOnlyOrderStatus.TRADE_CLOSED
        ) {
            revert BlocksOnlyCoordinator__OrderNotActive(orderId, order.status);
        }
    }

    /**
     * @notice Releases coordinator-held bound collateral and marks the order as closed under the provided debt-free
     *         close status.
     * @dev Reverts if the coordinator cannot release the staged collateral.
     *
     * Security:
     * - Internal helper shared by the maturity-gated settlement path and the trade-style close path.
     * - Always returns the staged collateral to the borrower and records `closeBlock = block.number`.
     *
     * @param order Open order storage reference.
     * @param closeStatus Final closed status to assign.
     * @return closeBlock Block number at which the order was closed.
     */
    function _closeDebtFreeOrder(
        BlocksOnlyOrder storage order,
        BlocksOnlyOrderStatus closeStatus
    ) internal returns (uint256 closeBlock) {
        _releaseBoundCollateral(order, order.borrower);
        order.maturityDeliveredToLender = false;
        order.status = closeStatus;
        closeBlock = block.number;
        order.closeBlock = closeBlock;
    }

    function _tryOrderStateStore()
        internal
        view
        returns (IOrderStateStoreV2 orderStateStore, bool hasStore)
    {
        address orderStateStoreAddr = IRegistry(_registryAddr).getModule(
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

    /**
     * @notice Stages the order-bound collateral out of the borrower's collateral ledger into coordinator custody.
     * @dev Reverts if the collateral manager dependency is missing or the withdrawal call reverts.
     *
     * Security:
     * - Internal finalization helper used to hard-bind collateral at match time.
     * - Removes the pledged amount from the borrower's withdrawable collateral balance immediately.
     *
     * @param borrower Borrower whose collateral balance is reduced.
     * @param collateralAsset Bound collateral asset.
     * @param collateralAmount Bound collateral amount.
     */
    function _stageBoundCollateral(
        address borrower,
        address collateralAsset,
        uint256 collateralAmount
    ) internal {
        address collateralManager = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_CM
        );
        ICollateralManager(collateralManager).withdrawCollateralTo(
            borrower,
            collateralAsset,
            collateralAmount,
            address(this)
        );
    }

    /**
     * @notice Releases the coordinator-held order-bound collateral to `recipient`.
     * @dev Reverts if:
     *      - the coordinator custody balance is below the bound collateral amount
     *      - the ERC20 transfer reverts
     *
     * Security:
     * - Internal settlement helper used only for the order-bound collateral asset/amount.
     * - Transfer source is the coordinator's own custody, not the borrower's current collateral ledger.
     *
     * @param order Open order storage reference.
     * @param recipient Recipient of the collateral release.
     */
    function _releaseBoundCollateral(
        BlocksOnlyOrder storage order,
        address recipient
    ) internal {
        uint256 collateralAmount = order.collateralAmount;
        if (collateralAmount == 0) {
            return;
        }
        if (
            IERC20(order.collateralAsset).balanceOf(address(this)) <
            collateralAmount
        ) {
            revert BlocksOnlyCoordinator__NoCollateral(order.borrower);
        }
        IERC20(order.collateralAsset).safeTransfer(recipient, collateralAmount);
    }

    function _remainingSettlementAmount(
        BlocksOnlyOrder storage order
    ) internal view returns (uint256 remainingDebt) {
        if (order.repaidPrincipal >= order.principal) {
            return 0;
        }
        remainingDebt = order.principal - order.repaidPrincipal;
    }

    function _tryEmitBlocksOnlyEasy(
        uint256 orderId,
        BlocksOnlyOrder storage order
    ) internal {
        address controller = IRegistry(_registryAddr).getModule(
            ModuleKeys.KEY_EASY_EMISSION_CONTROLLER
        );
        if (controller == address(0) || controller.code.length == 0) {
            return;
        }
        // Best-effort hook: swallow failures to avoid blocking trade settlement.
        // solhint-disable-next-line avoid-low-level-calls
        (bool hookOk, ) = controller.call(
            abi.encodeCall(
                IBlocksOnlyEasyEmissionController.onBlocksOnlyTradeSettlement,
                (
                    order.borrower,
                    order.lender,
                    order.asset,
                    orderId,
                    order.principal
                )
            )
        );
        if (!hookOk) {
            return;
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

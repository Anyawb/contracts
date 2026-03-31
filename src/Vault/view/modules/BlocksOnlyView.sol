// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Registry} from "../../../registry/Registry.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {IBlocksOnlyCoordinator} from "../../../interfaces/IBlocksOnlyCoordinator.sol";
import {ILendingEngineDebtRead} from "../../../interfaces/ILendingEngineDebtRead.sol";
import {
    BatchTooLarge,
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
import {ViewAccessLib} from "../../../libraries/ViewAccessLib.sol";
import {ViewConstants} from "../ViewConstants.sol";
import {ViewVersioned} from "../ViewVersioned.sol";

/**
 * @title BlocksOnlyView
 * @notice Dedicated view module for registry-bound blocks-only order reads and lifecycle state summaries.
 * @dev Reverts if:
 *      - registry-dependent module resolution fails or resolves to an invalid contract where required
 *      - callers fail the view-layer role checks for user-scoped or system-scoped data
 *      - requested order ids or paging limits violate the module's validation rules
 *      - downstream coordinator or lending-engine reads revert
 *
 * Security:
 * - This module is read-only but still permissioned through ViewAccessLib and ActionKeys role checks.
 * - Order runtime state combines coordinator storage with live debt-ledger reads; `remainingDebt` is not cached here.
 * - Maturity, close-state, and returned `blockNumber` values are block-based rather than timestamp-based.
 */
contract BlocksOnlyView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when a paginated query uses `limit == 0`.
    error BlocksOnlyView__InvalidLimit();

    /// @dev Reverts when `orderId` is not lower than the coordinator's total order count.
    error BlocksOnlyView__InvalidOrderId(uint256 orderId);

    /*━━━━━━━━━━━━━━━ TYPES ━━━━━━━━━━━━━━━*/

    /// @notice Enriched blocks-only order view that combines stored order data with live runtime state.
    struct BlocksOnlyOrderRuntime {
        /// @notice Coordinator order id.
        uint256 orderId;
        /// @notice Original principal in debt-asset base units.
        uint256 principal;
        /// @notice Cumulative repaid principal recorded by the coordinator in debt-asset base units.
        uint256 repaidPrincipal;
        /// @notice Matched rate in basis points using a 1e4 denominator.
        uint256 rateBps;
        /// @notice Loan term measured in blocks.
        uint256 termBlocks;
        /// @notice Borrower responsible for repayment and collateral backing.
        address borrower;
        /// @notice Recorded lender / funding source.
        address lender;
        /// @notice Debt asset address.
        address asset;
        /// @notice Activation block number.
        uint256 startBlock;
        /// @notice First block at which settlement or liquidation becomes eligible.
        uint256 maturityBlock;
        /// @notice Block number at which the order was closed, or zero while still open.
        uint256 closeBlock;
        /// @notice Stored lifecycle status from the coordinator.
        IBlocksOnlyCoordinator.BlocksOnlyOrderStatus status;
        /// @notice Live debt balance returned by the lending engine in debt-asset base units.
        uint256 remainingDebt;
        /// @notice Whether the current block is at or beyond `maturityBlock`.
        bool isMatured;
        /// @notice Whether the order is already settled or liquidated.
        bool isClosed;
        /// @notice Whether the order is currently both open and matured.
        bool canSettleOrLiquidate;
    }

    /*━━━━━━━━━━━━━━━ STORAGE ━━━━━━━━━━━━━━━*/

    address private _registryAddr;

    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    /*━━━━━━━━━━━━━━━ MODIFIERS ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when the registry address is unset or not a contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Reverts unless `msg.sender` equals `user` or already holds a user-data/admin view role.
    modifier onlyAuthorizedUser(address user) {
        if (
            msg.sender != user &&
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_USER_DATA,
                msg.sender
            ) &&
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) revert MissingRole();
        _;
    }

    /// @dev Reverts unless `msg.sender` holds the system-data or admin view role.
    modifier onlyOps() {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_SYSTEM_DATA,
                msg.sender
            ) &&
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) revert MissingRole();
        _;
    }

    /*━━━━━━━━━━━━━━━ INITIALIZATION ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the view module with the registry address.
     * @dev Reverts if:
     *      - `initialRegistryAddr == address(0)`
     *      - `initialRegistryAddr` is not a contract
     *      - the proxy has already been initialized
     *
     * Security:
     * - One-time initializer for the UUPS proxy deployment.
     * - The registry becomes the module-address SSOT for coordinator, debt, and role checks.
     *
     * @param initialRegistryAddr Registry contract address.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns the runtime view for `orderId`, combining stored order data with live debt state.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - `orderId` is not lower than the coordinator's total order count
     *      - the caller is neither the borrower, the lender, nor a holder of `ACTION_VIEW_USER_DATA` or
     *        `ACTION_ADMIN`
     *      - coordinator or lending-engine reads revert
     *
     * Security:
     * - Permissioned user-data read.
     * - `remainingDebt` is fetched live from the lending engine and may diverge from local coordinator accounting if
     *   downstream state changes independently.
     *
     * @param orderId Coordinator order id.
     * @return orderRuntime Enriched runtime order view.
     */
    function getBlocksOnlyOrder(
        uint256 orderId
    )
        external
        view
        onlyValidRegistry
        returns (BlocksOnlyOrderRuntime memory orderRuntime)
    {
        IBlocksOnlyCoordinator.BlocksOnlyOrder memory order = _getExistingOrder(
            orderId
        );
        _requireOrderViewer(order);
        return _buildOrderRuntime(orderId, order);
    }

    /**
     * @notice Returns whether `user` is a participant in `orderId`, together with a validity flag and current block.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the caller is neither `user` nor a holder of `ACTION_VIEW_USER_DATA` or `ACTION_ADMIN`
     *      - `orderId` is not lower than the coordinator's total order count
     *      - coordinator reads revert
     *
     * Security:
     * - Permissioned access probe for user-scoped order visibility.
     * - If `user == address(0)`, the function returns `(false, true, block.number)` without consulting the order
     *   participants beyond order existence validation.
     *
     * @param orderId Coordinator order id.
     * @param user Account being checked for borrower/lender participation.
     * @return hasAccess Whether `user` is the borrower or lender on the order.
     * @return isValid Always `true` on successful return; reserved for compatibility with broader view APIs.
     * @return blockNumber Current block number.
     */
    function canAccessBlocksOnlyOrder(
        uint256 orderId,
        address user
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedUser(user)
        returns (bool hasAccess, bool isValid, uint256 blockNumber)
    {
        if (user == address(0)) {
            return (false, true, _now());
        }

        IBlocksOnlyCoordinator.BlocksOnlyOrder memory order = _getExistingOrder(
            orderId
        );
        hasAccess = user == order.borrower || user == order.lender;
        return (hasAccess, true, _now());
    }

    /**
     * @notice Returns the number of order ids tracked for `borrower`.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the caller is neither `borrower` nor a holder of `ACTION_VIEW_USER_DATA` or `ACTION_ADMIN`
     *      - the coordinator read reverts
     *
     * Security:
     * - Permissioned borrower-scoped count query.
     *
     * @param borrower Borrower address.
     * @return count Number of order ids tracked for `borrower`.
     * @return isValid Always `true` on successful return.
     * @return blockNumber Current block number.
     */
    function getBorrowerOrderCount(
        address borrower
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedUser(borrower)
        returns (uint256 count, bool isValid, uint256 blockNumber)
    {
        count = _coordinator().getBlocksOnlyOrderCountByBorrower(borrower);
        return (count, true, _now());
    }

    /**
     * @notice Returns a paginated borrower-scoped list of order ids.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the caller is neither `borrower` nor a holder of `ACTION_VIEW_USER_DATA` or `ACTION_ADMIN`
     *      - `limit == 0` or `limit > ViewConstants.MAX_BATCH_SIZE`
     *      - the coordinator read reverts
     *
     * Security:
     * - Permissioned borrower-scoped pagination helper.
     * - Out-of-range offsets are delegated to the coordinator and currently yield an empty page rather than reverting.
     *
     * @param borrower Borrower address.
     * @param offset Zero-based page start within the borrower's order-id list.
     * @param limit Maximum number of ids to return.
     * @return orderIds Borrower order ids in stored order.
     * @return totalCount Total number of order ids tracked for `borrower`.
     * @return isValid Always `true` on successful return.
     * @return blockNumber Current block number.
     */
    function getBorrowerOrderIdsPaginated(
        address borrower,
        uint256 offset,
        uint256 limit
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedUser(borrower)
        returns (
            uint256[] memory orderIds,
            uint256 totalCount,
            bool isValid,
            uint256 blockNumber
        )
    {
        _validateLimit(limit);
        (orderIds, totalCount) = _coordinator().getBlocksOnlyOrderIdsByBorrower(
            borrower,
            offset,
            limit
        );
        return (orderIds, totalCount, true, _now());
    }

    /**
     * @notice Returns a paginated borrower-scoped list of enriched runtime orders.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the caller is neither `borrower` nor a holder of `ACTION_VIEW_USER_DATA` or `ACTION_ADMIN`
     *      - `limit == 0` or `limit > ViewConstants.MAX_BATCH_SIZE`
     *      - coordinator or lending-engine reads revert
     *
     * Security:
     * - Permissioned borrower-scoped batch read.
     * - Runtime items are rebuilt from live debt data for each returned order id.
     *
     * @param borrower Borrower address.
     * @param offset Zero-based page start within the borrower's order-id list.
     * @param limit Maximum number of orders to return.
     * @return items Runtime order views for the requested page.
     * @return totalCount Total number of order ids tracked for `borrower`.
     * @return isValid Always `true` on successful return.
     * @return blockNumber Current block number.
     */
    function getBorrowerOrdersPaginated(
        address borrower,
        uint256 offset,
        uint256 limit
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedUser(borrower)
        returns (
            BlocksOnlyOrderRuntime[] memory items,
            uint256 totalCount,
            bool isValid,
            uint256 blockNumber
        )
    {
        _validateLimit(limit);

        uint256[] memory orderIds;
        (orderIds, totalCount) = _coordinator().getBlocksOnlyOrderIdsByBorrower(
            borrower,
            offset,
            limit
        );
        items = _buildOrderRuntimeBatch(orderIds);
        return (items, totalCount, true, _now());
    }

    /**
     * @notice Returns the total number of created orders across the system.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the caller lacks `ACTION_VIEW_SYSTEM_DATA` and `ACTION_ADMIN`
     *      - the coordinator read reverts
     *
     * Security:
     * - Permissioned system-data read intended for operators and admin tooling.
     *
     * @return count Total number of created orders.
     * @return isValid Always `true` on successful return.
     * @return blockNumber Current block number.
     */
    function getSystemOrderCount()
        external
        view
        onlyValidRegistry
        onlyOps
        returns (uint256 count, bool isValid, uint256 blockNumber)
    {
        count = _coordinator().getBlocksOnlyOrderCount();
        return (count, true, _now());
    }

    /**
     * @notice Returns a paginated system-wide list of enriched runtime orders by order id.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the caller lacks `ACTION_VIEW_SYSTEM_DATA` and `ACTION_ADMIN`
     *      - `limit == 0` or `limit > ViewConstants.MAX_BATCH_SIZE`
     *      - coordinator or lending-engine reads revert
     *
     * Security:
     * - Permissioned operator/admin batch read.
     * - Pagination is derived from contiguous coordinator order ids `[offset, totalCount)` rather than from a
     *   separately stored system index.
     *
     * @param offset Zero-based order-id start.
     * @param limit Maximum number of runtime orders to return.
     * @return items Runtime order views for the requested page.
     * @return totalCount Total number of created orders.
     * @return isValid Always `true` on successful return.
     * @return blockNumber Current block number.
     */
    function getSystemOrdersPaginated(
        uint256 offset,
        uint256 limit
    )
        external
        view
        onlyValidRegistry
        onlyOps
        returns (
            BlocksOnlyOrderRuntime[] memory items,
            uint256 totalCount,
            bool isValid,
            uint256 blockNumber
        )
    {
        _validateLimit(limit);

        totalCount = _coordinator().getBlocksOnlyOrderCount();
        if (offset >= totalCount) {
            return (new BlocksOnlyOrderRuntime[](0), totalCount, true, _now());
        }

        uint256 end = offset + limit;
        if (end > totalCount) {
            end = totalCount;
        }

        uint256 pageLen = end - offset;
        items = new BlocksOnlyOrderRuntime[](pageLen);
        for (uint256 i; i < pageLen; ) {
            uint256 orderId = offset + i;
            items[i] = _buildOrderRuntime(
                orderId,
                _coordinator().getBlocksOnlyOrder(orderId)
            );
            unchecked {
                ++i;
            }
        }

        return (items, totalCount, true, _now());
    }

    /**
     * @notice Returns the configured registry address.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Unrestricted metadata getter.
     *
     * @return registryAddrVar Registry contract address stored by the module.
     */
    function getRegistry() external view returns (address registryAddrVar) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ INTERNAL HELPERS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validates a view pagination limit against the module batch cap.
     * @dev Reverts if:
     *      - `limit == 0`
     *      - `limit > ViewConstants.MAX_BATCH_SIZE`
     *
     * Security:
     * - Internal guard that keeps batch reads within the shared view-module cap.
     *
     * @param limit Requested page length.
     */
    function _validateLimit(uint256 limit) internal pure {
        if (limit == 0) revert BlocksOnlyView__InvalidLimit();
        if (limit > _MAX_BATCH_SIZE)
            revert BatchTooLarge(limit, _MAX_BATCH_SIZE);
    }

    /**
     * @notice Returns an existing stored order for `orderId`.
     * @dev Reverts if:
     *      - `orderId` is not lower than the coordinator's total order count
     *      - the coordinator read reverts
     *
     * Security:
     * - Internal existence-checked adapter over the coordinator's raw order getter.
     *
     * @param orderId Coordinator order id.
     * @return order Stored coordinator order.
     */
    function _getExistingOrder(
        uint256 orderId
    )
        internal
        view
        returns (IBlocksOnlyCoordinator.BlocksOnlyOrder memory order)
    {
        if (orderId >= _coordinator().getBlocksOnlyOrderCount()) {
            revert BlocksOnlyView__InvalidOrderId(orderId);
        }
        return _coordinator().getBlocksOnlyOrder(orderId);
    }

    /**
     * @notice Requires the current caller to be allowed to read the given order.
     * @dev Reverts if:
     *      - `msg.sender` is neither the borrower, the lender, nor a holder of `ACTION_VIEW_USER_DATA` or
     *        `ACTION_ADMIN`
     *
     * Security:
     * - Internal authorization gate for user-scoped order reads.
     *
     * @param order Coordinator order being inspected.
     */
    function _requireOrderViewer(
        IBlocksOnlyCoordinator.BlocksOnlyOrder memory order
    ) internal view {
        bool isAdmin = ViewAccessLib.hasRole(
            _registryAddr,
            ActionKeys.ACTION_ADMIN,
            msg.sender
        );
        bool isUserViewer = ViewAccessLib.hasRole(
            _registryAddr,
            ActionKeys.ACTION_VIEW_USER_DATA,
            msg.sender
        );
        bool isBorrower = msg.sender == order.borrower;
        bool isLender = msg.sender == order.lender;
        if (!isAdmin && !isUserViewer && !isBorrower && !isLender)
            revert MissingRole();
    }

    /**
     * @notice Builds runtime order views for a batch of coordinator order ids.
     * @dev Reverts if:
     *      - coordinator or lending-engine reads revert for any order id in the batch
     *
     * Security:
     * - Internal batch helper that performs one live debt read per order.
     *
     * @param orderIds Coordinator order ids.
     * @return items Runtime order views corresponding to `orderIds`.
     */
    function _buildOrderRuntimeBatch(
        uint256[] memory orderIds
    ) internal view returns (BlocksOnlyOrderRuntime[] memory items) {
        items = new BlocksOnlyOrderRuntime[](orderIds.length);
        for (uint256 i; i < orderIds.length; ) {
            uint256 orderId = orderIds[i];
            items[i] = _buildOrderRuntime(
                orderId,
                _coordinator().getBlocksOnlyOrder(orderId)
            );
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Builds a runtime order view from stored coordinator data and live debt state.
     * @dev Reverts if:
     *      - the lending-engine debt read reverts
     *
     * Security:
     * - Read-only composition helper.
     * - `canSettleOrLiquidate` only indicates that the order is open and matured; it does not perform permission or
     *   collateral availability checks.
     *
     * @param orderId Coordinator order id.
     * @param order Stored coordinator order.
     * @return orderRuntime Enriched runtime order view.
     */
    function _buildOrderRuntime(
        uint256 orderId,
        IBlocksOnlyCoordinator.BlocksOnlyOrder memory order
    ) internal view returns (BlocksOnlyOrderRuntime memory orderRuntime) {
        uint256 remainingDebt = _debtRead().getDebt(
            order.borrower,
            order.asset
        );
        bool isClosed = order.status ==
            IBlocksOnlyCoordinator.BlocksOnlyOrderStatus.SETTLED ||
            order.status ==
                IBlocksOnlyCoordinator.BlocksOnlyOrderStatus.LIQUIDATED;
        bool isMatured = order.maturityBlock != 0 &&
            block.number >= order.maturityBlock;

        orderRuntime = BlocksOnlyOrderRuntime({
            orderId: orderId,
            principal: order.principal,
            repaidPrincipal: order.repaidPrincipal,
            rateBps: order.rateBps,
            termBlocks: order.termBlocks,
            borrower: order.borrower,
            lender: order.lender,
            asset: order.asset,
            startBlock: order.startBlock,
            maturityBlock: order.maturityBlock,
            closeBlock: order.closeBlock,
            status: order.status,
            remainingDebt: remainingDebt,
            isMatured: isMatured,
            isClosed: isClosed,
            canSettleOrLiquidate: !isClosed && isMatured
        });
    }

    /**
     * @notice Returns the registered blocks-only coordinator interface.
     * @dev Reverts if:
     *      - the registry is missing `ModuleKeys.KEY_BLOCKS_ONLY_COORDINATOR`
     *      - the resolved address is not a contract
     *
     * Security:
     * - Internal registry-bound module resolver.
     *
     * @return coordinator Registered coordinator interface.
     */
    function _coordinator() internal view returns (IBlocksOnlyCoordinator) {
        address coordinatorAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_BLOCKS_ONLY_COORDINATOR
        );
        if (coordinatorAddr.code.length == 0)
            revert NotAContract(coordinatorAddr);
        return IBlocksOnlyCoordinator(coordinatorAddr);
    }

    /**
     * @notice Returns the registered lending-engine debt-read interface.
     * @dev Reverts if:
     *      - the registry is missing `ModuleKeys.KEY_LE`
     *      - the resolved address is not a contract
     *
     * Security:
     * - Internal registry-bound module resolver for live debt state.
     *
     * @return debtRead Registered debt-read interface.
     */
    function _debtRead() internal view returns (ILendingEngineDebtRead) {
        address lendingEngineAddr = Registry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_LE
        );
        if (lendingEngineAddr.code.length == 0)
            revert NotAContract(lendingEngineAddr);
        return ILendingEngineDebtRead(lendingEngineAddr);
    }

    /**
     * @notice Returns the current block number.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Internal compatibility helper that standardizes block-based view metadata.
     *
     * @return blockNumber Current block number.
     */
    function _now() internal view returns (uint256) {
        return block.number;
    }

    /*━━━━━━━━━━━━━━━ UUPS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorizes a UUPS implementation upgrade.
     * @dev Reverts if:
     *      - the registry is unset or not a contract
     *      - the caller lacks `ACTION_ADMIN`
     *      - `newImplementation == address(0)`
     *      - `newImplementation` is not a contract
     *
     * Security:
     * - Upgrade authorization is restricted to admin-role holders resolved through ViewAccessLib.
     * - This hook checks only non-zero / code presence and does not perform interface-compatibility validation.
     *
     * @param newImplementation Proposed implementation address.
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyValidRegistry {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0)
            revert NotAContract(newImplementation);
    }

    /**
     * @notice Returns the external API version for this view module.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Pure metadata helper for integration compatibility checks.
     *
     * @return version Current API version.
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Returns the schema version for this view module's response payloads.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Pure metadata helper for off-chain decoder compatibility checks.
     *
     * @return version Current schema version.
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    uint256[50] private __gap;
}

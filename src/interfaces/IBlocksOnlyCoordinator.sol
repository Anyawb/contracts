// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IBlocksOnlyCoordinator
 * @notice Minimal write/read surface for the standalone blocks-only product coordinator.
 * @dev Reverts if:
 *      - the coordinator implementation rejects unauthorized callers, invalid product terms, invalid order ids, or
 *        missing registry dependencies
 *      - downstream pool, vault-core, lending-engine, collateral, or liquidation module calls revert while servicing
 *        the requested action
 *
 * Security:
 * - This interface spans both write paths and permissionless close/settlement flows for the blocks-only product.
 * - Integrators should treat the implementation as registry-bound and ActionKeys-gated rather than a free-standing
 *   coordinator.
 * - Order lifecycle state is block-based; callers must not reinterpret maturity or close fields as timestamp values.
 */
interface IBlocksOnlyCoordinator {
    /*━━━━━━━━━━━━━━━ TYPES ━━━━━━━━━━━━━━━*/

    /// @notice Canonical lifecycle status for a blocks-only order.
    /// @dev Closed/terminal reads must only treat SETTLED and TRADE_CLOSED as closed.
    ///      Consumers must not infer closure from `REPAID`,
    ///      `repaidPrincipal`, or the compatibility field name `remainingDebt` alone.
    enum BlocksOnlyOrderStatus {
        NONE,
        ACTIVE,
        REPAID,
        SETTLED,
        TRADE_CLOSED
    }

    /// @notice Input bundle used when finalizing a matched blocks-only trade-like order.
    struct BlocksOnlyMatchParams {
        /// @notice Borrower that receives principal and provides the pledged collateral.
        address borrower;
        /// @notice Expected funding source. Current implementation requires the registered lender pool vault.
        address lender;
        /// @notice Collateral asset explicitly bound to the matched order.
        address collateralAsset;
        /// @notice Collateral amount explicitly bound to the matched order.
        uint256 collateralAmount;
        /// @notice Debt asset transferred to the borrower and booked in VaultCore.
        address borrowAsset;
        /// @notice Principal amount in debt-asset base units.
        uint256 amount;
        /// @notice Loan term measured in blocks. Current implementation only accepts `1`.
        uint256 termBlocks;
        /// @notice Rate in basis points using a 1e4 denominator. Current implementation only accepts `0`.
        uint256 rateBps;
    }

    /// @notice Stored blocks-only order record tracked by the coordinator.
    struct BlocksOnlyOrder {
        /// @notice Original principal in debt-asset base units.
        uint256 principal;
        /// @notice Cumulative principal repayments observed by the coordinator in debt-asset base units.
        /// @dev Maturity-close settlement normalizes this field to `principal` to extinguish local remaining settlement
        ///      amount and keep closed-state amount semantics consistent.
        uint256 repaidPrincipal;
        /// @notice Matched rate in basis points using a 1e4 denominator.
        uint256 rateBps;
        /// @notice Loan term measured in blocks.
        uint256 termBlocks;
        /// @notice Borrower responsible for repayment and collateral backing.
        address borrower;
        /// @notice Funding source that received repayments.
        address lender;
        /// @notice Collateral asset explicitly bound to the order.
        address collateralAsset;
        /// @notice Collateral amount explicitly bound to the order.
        uint256 collateralAmount;
        /// @notice Debt asset for principal and repayment accounting.
        address asset;
        /// @notice Block number at which the order became active.
        uint256 startBlock;
        /// @notice Block number at which maturity close becomes eligible.
        uint256 maturityBlock;
        /// @notice Block number at which the order was closed, or zero while still open.
        uint256 closeBlock;
        /// @notice Current lifecycle status.
        BlocksOnlyOrderStatus status;
        /// @notice Whether maturity close settled through lender-delivery (`true`) instead of borrower-return (`false`).
        /// @dev Used by compatibility readers when external state stores are unavailable.
        bool maturityDeliveredToLender;
    }

    /*━━━━━━━━━━━━━━━ WRITE API ━━━━━━━━━━━━━━━*/

    /**
     * @notice Finalizes a matched blocks-only trade-like order, stores the pledged collateral binding, and stages
     *         the pledged collateral into coordinator custody.
     * @dev Reverts if:
     *      - the caller is not the registered Vault business logic module
     *      - the coordinator is paused or its registry is unset / not a contract
     *      - `params.borrower` or `params.borrowAsset` is the zero address
     *      - `params.amount == 0`
     *      - `params.termBlocks` or `params.rateBps` violates the product constraints enforced by the implementation
     *      - `params.lender` does not match the registered lender pool vault
     *      - the borrow asset is not allowed by the asset whitelist
     *      - registry lookups or downstream pool calls revert
     *
     * Security:
     * - Write path gated by the registry-bound Vault business logic module.
     * - Stages the bound collateral out of the borrower's collateral ledger into coordinator custody before
     *   recording the order.
     * - The coordinator, not the generic debt ledger, is the product-state SSOT for remaining settlement amount.
     *
     * @param params Matched order inputs, including participants, asset, principal, and block term.
     * @return orderId Newly assigned coordinator order id.
     */
    function finalizeMatchBlocks(
        BlocksOnlyMatchParams calldata params
    ) external returns (uint256 orderId);

    /**
     * @notice Repays a blocks-only order and forwards the repayment to the recorded lender.
     * @dev Reverts if:
     *      - the coordinator is paused or its registry is unset / not a contract
     *      - `repayAmount == 0`
     *      - `orderId` does not reference an open order
     *      - the caller is not the recorded borrower
     *      - token transfer or registry lookups revert
     *
     * Security:
     * - Borrower-only write path.
     * - Repayment completeness is determined by the coordinator-local remaining settlement amount.
     * - A debt-free repay does not itself close the order; closed-state consumers must read the explicit close
     *   transition via coordinator/view status.
     *
     * @param orderId Coordinator order id.
     * @param repayAmount Repayment amount in debt-asset base units.
     * @return remainingDebt Remaining open settlement amount after repayment. The field name is retained for
     *         compatibility with existing consumers.
     */
    function repayBlocks(
        uint256 orderId,
        uint256 repayAmount
    ) external returns (uint256 remainingDebt);

    /**
     * @notice Closes a debt-free blocks-only order through the trade-style close path without waiting for maturity.
     * @dev Reverts if:
     *      - the coordinator is paused or its registry is unset / not a contract
     *      - `orderId` does not reference an open order
     *      - the coordinator-local remaining settlement amount is non-zero
     *      - collateral release dependencies revert
     *
     * Security:
     * - Intended for the trade-like blocks-only path where a filled order should close as soon as the remaining
     *   settlement amount is zero.
     * - Does not alter the maturity-gated product-settlement semantics of {settleOrLiquidateBlocks}.
     * - Releases the coordinator-held order-bound collateral back to the borrower and marks the order as
     *   `TRADE_CLOSED`.
     * - This explicit close path, rather than a zero-balance observation alone, is what turns a debt-free open order
     *   into a closed order.
     *
     * @param orderId Coordinator order id.
     */
    function closeRepaidTradeBlocks(uint256 orderId) external;

    /**
     * @notice Completes maturity-gated trade-like close for a blocks-only order.
     * @dev Reverts if:
     *      - the coordinator is paused or its registry is unset / not a contract
     *      - `orderId` does not reference an open order
     *      - the order has not yet reached its maturity block
     *      - required collateral release dependencies revert
     *
     * Security:
     * - Permissionless maturity-close path.
     * - If the order is fully repaid, the coordinator-held order-bound collateral returns to the borrower.
     * - Otherwise the coordinator-held order-bound collateral is delivered to the recorded lender as the
     *   product-defined maturity settlement outcome.
     *
     * @param orderId Coordinator order id.
     */
    function settleOrLiquidateBlocks(uint256 orderId) external;

    /*━━━━━━━━━━━━━━━ READ API ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns the stored coordinator record for `orderId`.
     * @dev Reverts if:
     *      - (none expected in the current implementation; nonexistent ids return the default struct unless guarded by
     *        a higher-level caller)
     *
     * Security:
     * - Raw storage read with no access control in the current implementation.
     * - Callers that require existence validation should pair this with {getBlocksOnlyOrderCount} or higher-level
     *   guarded view modules.
     *
     * @param orderId Coordinator order id.
     * @return order Stored order record.
     */
    function getBlocksOnlyOrder(
        uint256 orderId
    ) external view returns (BlocksOnlyOrder memory order);

    /**
     * @notice Returns the number of orders ever created by the coordinator.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only counter for order-id pagination and existence checks.
     *
     * @return count Total number of created orders.
     */
    function getBlocksOnlyOrderCount() external view returns (uint256 count);

    /**
     * @notice Returns the number of order ids tracked for `borrower`.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only borrower index size query.
     *
     * @param borrower Borrower address whose order count is requested.
     * @return count Number of coordinator order ids associated with `borrower`.
     */
    function getBlocksOnlyOrderCountByBorrower(
        address borrower
    ) external view returns (uint256 count);

    /**
     * @notice Returns a borrower-scoped page of order ids together with the full borrower order count.
     * @dev Reverts if:
     *      - (none expected in the current implementation; out-of-range pages return an empty array)
     *
     * Security:
     * - Read-only pagination helper over the coordinator's borrower index.
     * - `limit == 0` currently returns an empty page instead of reverting; callers should validate paging inputs
     *   themselves when zero-length pages are not acceptable.
     *
     * @param borrower Borrower address whose order ids are requested.
     * @param offset Zero-based page start within the borrower order-id list.
     * @param limit Maximum number of order ids to return.
     * @return orderIds Borrower order ids in implementation-defined stored order.
     * @return totalCount Total number of order ids tracked for `borrower`.
     */
    function getBlocksOnlyOrderIdsByBorrower(
        address borrower,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory orderIds, uint256 totalCount);
}

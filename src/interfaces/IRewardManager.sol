// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IRewardManagerByOrder
 * @notice Order-scoped reward callback that includes `orderId` and `maturity` context.
 * @dev
 * - This interface is intentionally order-scoped (`orderId`, `maturity`, `outcome`).
 * - The design avoids ambiguity from user-aggregated reward accounting under concurrent orders.
 */
interface IRewardManagerByOrder {
    /// @notice Loan event outcomes tracked at order granularity.
    /// @dev Solidity enum values are ABI-encoded as `uint8`.
    enum LoanEventOutcome {
        Borrow,
        RepayOnTimeFull,
        RepayEarlyFull,
        RepayLateFull
    }

    /**
     * @notice Handles a single order-scoped loan lifecycle event.
     * @param user User address.
     * @param orderId Order identifier generated and managed by LendingEngine.
     * @param amount Amount in token base units, primarily for accounting and observability.
     * @param maturity Order maturity block (`maturityBlock`, block-based SSOT).
     * @param outcome Loan event outcome.
     */
    function onLoanEventByOrder(
        address user,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        LoanEventOutcome outcome
    ) external;
}

/**
 * @title IRewardManagerByOrderWithLender
 * @notice Order-scoped reward callback with lender and asset context for Easy emission flows.
 */
interface IRewardManagerByOrderWithLender {
    /**
     * @notice Handles a single order-scoped loan lifecycle event with lender and asset context.
     * @param borrower Borrower address.
     * @param lender Lender address.
     * @param asset Loan asset address.
     * @param orderId Order identifier.
     * @param amount Amount in token base units, typically the principal.
     * @param maturity Order maturity block (`maturityBlock`).
     * @param outcome Loan event outcome.
     */
    function onLoanEventByOrderWithLender(
        address borrower,
        address lender,
        address asset,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        IRewardManagerByOrder.LoanEventOutcome outcome
    ) external;
}

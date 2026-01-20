// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IOrderEngine
 * @notice SSOT write interface for creating loan orders (ORDER_ENGINE).
 * @dev Reverts if:
 *      - caller is not authorized (implementation-defined; role-gated)
 *      - order fields are invalid (implementation-defined)
 *
 * Security:
 * - Role-gated in the implementation (e.g. ACTION_ORDER_CREATE)
 *
 * Architecture:
 * - ORDER_ENGINE is responsible for order lifecycle side-effects (e.g. LoanNFT minting, DataPush events).
 * - Debt ledger writes are handled by KEY_LE (ILendingEngineBasic) via VaultCore.borrowFor / repayFor.
 */
interface IOrderEngine {
    struct LoanOrder {
        uint256 principal;
        uint256 rate;          // bps
        uint256 term;          // seconds
        address borrower;
        address lender;        // MUST be LenderPoolVault (per architecture SSOT)
        address asset;         // ERC20
        uint256 startTimestamp;
        uint256 maturity;
        uint256 repaidAmount;
    }

    /**
     * @notice Create a new loan order.
     * @dev Reverts if:
     *      - caller is not authorized (role-gated in implementation)
     *      - order fields are invalid (e.g. zero borrower/lender/principal)
     *
     * Security:
     * - Role-gated (e.g. ACTION_ORDER_CREATE) in the ORDER_ENGINE implementation.
     *
     * @param order Loan order data. Units:
     *      - principal: token decimals of `order.asset`
     *      - rate: bps (\(1e4 = 100%\))
     *      - term: seconds
     * @return orderId Newly created order id.
     */
    function createLoanOrder(LoanOrder calldata order) external returns (uint256 orderId);
}


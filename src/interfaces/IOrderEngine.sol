// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IOrderEngine
 * @notice SSOT write interface for creating loan orders (ORDER_ENGINE).
 * @dev Implementations are responsible for order lifecycle side-effects (e.g., LoanNFT minting, DataPush).
 *      Debt ledger writes are handled by KEY_LE (ILendingEngineBasic) via VaultCore.borrowFor / repayFor.
 */
interface IOrderEngine {
    struct LoanOrder {
        /// @notice Principal amount (token decimals of `asset`).
        uint256 principal;
        /// @notice Interest rate (bps, 10_000 = 100%).
        uint256 rate;
        /// @dev SSOT (time refactor): term is measured in blocks (NOT seconds).
        ///      Frontend/keeper should do ETA mapping offchain.
        uint256 term;
        /// @notice Borrower address.
        address borrower;
        /// @notice Lender address (MUST be LenderPoolVault per architecture SSOT).
        address lender;
        /// @notice Asset address (ERC20).
        address asset;
        /// @dev Legacy field name kept for ABI stability.
        ///      SSOT (time refactor): this is a block number (startBlock), NOT time-in-seconds.
        uint256 startTimestamp;
        /// @dev Legacy field name kept for ABI stability.
        ///      SSOT (time refactor): this is a block number (maturityBlock), NOT time-in-seconds.
        uint256 maturity;
        /// @notice Amount repaid so far (token decimals of `asset`).
        uint256 repaidAmount;
    }

    /**
     * @notice Create a new loan order.
     * @dev Reverts if:
     *      - caller is not authorized (role-gated in implementation; e.g., ACTION_ORDER_CREATE)
     *      - order fields are invalid (implementation-defined; e.g., zero borrower/lender/asset/principal)
     *
     * Security:
     * - Role-gated in the ORDER_ENGINE implementation (e.g., ACTION_ORDER_CREATE)
     *
     * @param order Loan order data. Units:
     *      - principal: token decimals of `order.asset`
     *      - rate: bps (10_000 = 100%)
     *      - term: blocks (SSOT; no onchain time-in-seconds gates)
     * @return orderId Newly created order id.
     */
    function createLoanOrder(LoanOrder calldata order) external returns (uint256 orderId);
}


// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IOrderEngineRepayAdapter
/// @notice Minimal repay surface SettlementManager relies on (orderId-based repay).
interface IOrderEngineRepayAdapter {
    /**
     * @notice Repay a loan order by order id.
     * @dev Reverts if:
     *      - caller is not authorized (role-gated in implementation)
     *      - orderId is invalid
     *      - repayAmount is zero or exceeds remaining due (implementation-defined)
     *
     * Security:
     * - Role-gated (e.g. ACTION_REPAY) in the ORDER_ENGINE implementation.
     *
     * @param orderId Loan order id.
     * @param repayAmount Amount to repay (token decimals of the order asset; includes fee/interest per implementation).
     */
    function repay(uint256 orderId, uint256 repayAmount) external;
}


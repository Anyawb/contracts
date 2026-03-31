// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IOrderEngineRepayAdapter
 * @notice Minimal repay surface SettlementManager relies on for order-id-based repayment.
 * @dev Reverts if:
 *      - the implementation rejects an unauthorized caller
 *      - the referenced order does not exist or cannot be repaid
 *      - the repay amount is invalid under OrderEngine rules
 *
 * Security:
 * - Write-capable dependency intended for settlement flows.
 * - Exposes only the narrow repay entrypoint so integrations do not depend on the full OrderEngine surface.
 */
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

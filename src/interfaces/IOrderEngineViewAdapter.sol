// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IOrderEngine} from "./IOrderEngine.sol";
import {ILoanNFT} from "./ILoanNFT.sol";

/**
 * @title IOrderEngineViewAdapter
 * @notice Read-only adapter surface used by view-layer modules and settlement helpers.
 * @dev Reverts if:
 *      - the implementation enforces read access control and the caller lacks permission
 *      - the requested order or account cannot be queried under implementation rules
 *
 * Security:
 * - View-only dependency that intentionally separates read helpers from the write-oriented {IOrderEngine} SSOT.
 * - Downstream consumers must not infer write privileges from the availability of this adapter.
 */
interface IOrderEngineViewAdapter {
    /**
     * @notice View-only read of a loan order (ORDER_ENGINE internal view adapter).
     * @dev Reverts if:
     *      - implementation enforces read ACL and caller lacks permissions
     *
     * Security:
     * - View-only; must not mutate state.
     *
     * @param orderId Loan order id.
     * @return order Loan order snapshot (see IOrderEngine.LoanOrder).
     */
    function getLoanOrderForView(
        uint256 orderId
    ) external view returns (IOrderEngine.LoanOrder memory order);

    /**
     * @notice View-only read of the ORDER_ENGINE-authoritative total due for a loan order.
     * @dev Downstream settlement helpers must consume this SSOT instead of reimplementing interest math locally.
     *
     * Security:
     * - View-only; must not mutate state.
     *
     * @param orderId Loan order id.
     * @return totalDue Total due amount (token decimals of order.asset).
     */
    function getOrderTotalDueForView(
        uint256 orderId
    ) external view returns (uint256 totalDue);

    /**
     * @notice View-only read of the business lifecycle status for a loan order.
     * @dev This status is the order-level terminal-state gate for repay/liquidation flows.
     *      Downstream callers should use it for business-state decisions rather than inferring
     *      closure from debt-ledger overpay/force-reduce side effects.
        *      This is the ORDER_ENGINE-side source consumed by LendingEngineView for order-centric
        *      read access; it does not move the lifecycle state machine into the View layer.
     *
     * Security:
     * - View-only; must not mutate state.
     *
     * @param orderId Loan order id.
     * @return status Loan lifecycle status from LoanNFT-backed SSOT.
     */
    function getOrderStatusForView(
        uint256 orderId
    ) external view returns (ILoanNFT.LoanStatus status);

    /**
     * @notice View-only read of a user's loan count (borrower perspective).
     * @dev Reverts if:
     *      - implementation enforces read ACL and caller lacks permissions
     *
     * Security:
     * - View-only; must not mutate state.
     *
     * @param user Borrower address.
     * @return count Number of loans for the borrower.
     */
    function getUserLoanCountForView(
        address user
    ) external view returns (uint256 count);

    /**
     * @notice View-only read of accumulated failed fee amount for an order (ops/monitoring).
     * @dev Reverts if:
     *      - implementation enforces read ACL and caller lacks permissions
     *
     * Security:
     * - View-only; must not mutate state.
     *
     * @param orderId Loan order id.
     * @return feeAmount Failed fee amount (token decimals of order.asset).
     */
    function getFailedFeeAmountForView(
        uint256 orderId
    ) external view returns (uint256 feeAmount);

    /**
     * @notice View-only read of NFT retry count for an order (ops/monitoring).
     * @dev Reverts if:
     *      - implementation enforces read ACL and caller lacks permissions
     *
     * Security:
     * - View-only; must not mutate state.
     *
     * @param orderId Loan order id.
     * @return retryCount Number of NFT mint retry attempts.
     */
    function getNftRetryCountForView(
        uint256 orderId
    ) external view returns (uint256 retryCount);

    /**
     * @notice View-only access check for a loan order.
     * @dev Intended for frontends/AI to preflight whether an address is allowed to view an order.
     *      Returns false for disallowed callers if implementation enforces ACL.
     *
     * Security:
     * - View-only; must not mutate state.
     *
     * @param orderId Loan order id.
     * @param user Address to check.
     * @return hasAccess True if user can access the order, otherwise false.
     */
    function canAccessLoanOrderForView(
        uint256 orderId,
        address user
    ) external view returns (bool hasAccess);

    /**
     * @notice View-only check whether an account is considered a match engine (keeper/orchestrator capability).
     * @dev Reverts if:
     *      - implementation enforces read ACL and caller lacks permissions
     *
     * Security:
     * - View-only; must not mutate state.
     *
     * @param account Address to check.
     * @return isMatch True if account is a match engine, otherwise false.
     */
    function isMatchEngineForView(
        address account
    ) external view returns (bool isMatch);

    /**
     * @notice View-only getter for the Registry address stored in ORDER_ENGINE.
     * @dev Convenience for tooling/AI; should match Registry module SSOT.
     *
     * Security:
     * - View-only; must not mutate state.
     *
     * @return registry Registry address.
     */
    function getRegistryForView() external view returns (address registry);
}

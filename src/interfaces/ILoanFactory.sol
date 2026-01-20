// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILoanFactory
 * @notice Factory interface for deploying upgradeable Loan instances (proxy or clone).
 * @dev Reverts if:
 *      - caller is not authorized (implementation-defined)
 *
 * Security:
 * - Role-gated in the implementation (e.g. governance / matching module)
 */
interface ILoanFactory {
    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when a Loan instance is deployed for an order.
     * @dev Security:
     * - Event-only; consumers must treat the factory implementation as SSOT.
     *
     * @param orderId Order id in the lending engine (implementation-defined)
     * @param proxyAddr Deployed proxy/clone address
     */
    event LoanDeployed(uint256 indexed orderId, address indexed proxyAddr);

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    /**
     * @notice Caller is not authorized to deploy.
     */
    error LoanFactory__NotAuthorized();

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice Deploy a Loan instance for a given order id.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - deployment or initialization fails (implementation-defined)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param orderId Order id in the lending engine (implementation-defined)
     * @param initCalldata ABI-encoded initializer call data for the deployed instance
     * @return proxyAddr Deployed proxy/clone address
     */
    function deployLoan(uint256 orderId, bytes calldata initCalldata) external returns (address proxyAddr);
} 
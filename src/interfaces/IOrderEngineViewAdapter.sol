// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IOrderEngine } from "./IOrderEngine.sol";

/// @title IOrderEngineViewAdapter (view-only adapter surface)
/// @notice Read-only adapter functions used by view-layer modules (e.g. LendingEngineView) and SettlementManager.
/// @dev These are intentionally separated from IOrderEngine to avoid mixing "write SSOT" with view helpers.
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
    // solhint-disable-next-line private-vars-leading-underscore
    function _getLoanOrderForView(uint256 orderId) external view returns (IOrderEngine.LoanOrder memory order);

    /**
     * @notice View-only read of a user's loan count (borrower perspective).
     * @dev Reverts if:
     *      - implementation enforces read ACL and caller lacks permissions
     */
    // solhint-disable-next-line private-vars-leading-underscore
    function _getUserLoanCountForView(address user) external view returns (uint256 count);

    /**
     * @notice View-only read of accumulated failed fee amount for an order (ops/monitoring).
     * @dev Reverts if:
     *      - implementation enforces read ACL and caller lacks permissions
     */
    // solhint-disable-next-line private-vars-leading-underscore
    function _getFailedFeeAmountForView(uint256 orderId) external view returns (uint256 feeAmount);

    /**
     * @notice View-only read of NFT retry count for an order (ops/monitoring).
     * @dev Reverts if:
     *      - implementation enforces read ACL and caller lacks permissions
     */
    // solhint-disable-next-line private-vars-leading-underscore
    function _getNftRetryCountForView(uint256 orderId) external view returns (uint256 retryCount);

    /**
     * @notice View-only access check for a loan order.
     * @dev Intended for frontends/AI to preflight whether an address is allowed to view an order.
     */
    // solhint-disable-next-line private-vars-leading-underscore
    function _canAccessLoanOrderForView(uint256 orderId, address user) external view returns (bool hasAccess);

    /**
     * @notice View-only check whether an account is considered a match engine (keeper/orchestrator capability).
     */
    // solhint-disable-next-line private-vars-leading-underscore
    function _isMatchEngineForView(address account) external view returns (bool isMatch);

    /**
     * @notice View-only getter for the Registry address stored in ORDER_ENGINE.
     * @dev Convenience for tooling/AI; should match Registry module SSOT.
     */
    // solhint-disable-next-line private-vars-leading-underscore
    function _getRegistryForView() external view returns (address registry);
}


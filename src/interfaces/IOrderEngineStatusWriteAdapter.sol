// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ILoanNFT} from "./ILoanNFT.sol";

/**
 * @title IOrderEngineStatusWriteAdapter
 * @notice Narrow ORDER_ENGINE write surface for terminal liquidation outcomes.
 * @dev SettlementManager uses this adapter to atomically write Liquidated/Defaulted
 *      after keeper liquidation succeeds.
 *      This adapter belongs to the business-write path, not the View layer.
 */
interface IOrderEngineStatusWriteAdapter {
    /**
     * @notice Mark an order as Liquidated or Defaulted.
     * @dev Reverts if:
     *      - caller is not authorized by the ORDER_ENGINE implementation
     *      - orderId is invalid
     *      - status is not a liquidation terminal status
     *      - the order is no longer in an active lifecycle state
     *
     * Architecture-Guide alignment:
     * - Lifecycle writes stay in ORDER_ENGINE / SettlementManager.
     * - View modules only read the resulting state via explicit read adapters.
     *
     * @param orderId Loan order id.
     * @param status Terminal liquidation status to persist.
     */
    function markOrderLiquidationStatus(
        uint256 orderId,
        ILoanNFT.LoanStatus status
    ) external;
}

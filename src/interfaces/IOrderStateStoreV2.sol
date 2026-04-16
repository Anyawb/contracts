// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ILoanNFT} from "./ILoanNFT.sol";
import {IShortfallLedger} from "./IShortfallLedger.sol";

interface IOrderStateStoreV2 {
    enum OrderProductType {
        NONE,
        LOAN,
        BLOCKS_ONLY
    }

    enum LifecycleStatus {
        NONE,
        ACTIVE,
        REPAID,
        LIQUIDATED,
        DEFAULTED,
        CLOSED
    }

    enum CloseReason {
        NONE,
        FULL_REPAY,
        KEEPER_LIQUIDATION,
        MATURITY_DEFAULT,
        BLOCKS_TRADE_CLOSE,
        BLOCKS_MATURITY_CLOSE
    }

    enum CollateralDispositionStatus {
        NONE,
        COORDINATOR_CUSTODY,
        RETURNED_TO_BORROWER,
        DELIVERED_TO_LENDER,
        SEIZED_AND_DISTRIBUTED
    }

    struct OrderState {
        OrderProductType productType;
        LifecycleStatus lifecycle;
        CloseReason closeReason;
        IShortfallLedger.ShortfallStatus shortfallStatus;
        CollateralDispositionStatus collateralDisposition;
        uint256 createdBlock;
        uint256 updatedBlock;
        uint256 closedBlock;
    }

    event OrderStateInitialized(
        OrderProductType indexed productType,
        uint256 indexed orderId,
        LifecycleStatus lifecycle,
        CollateralDispositionStatus collateralDisposition,
        uint256 createdBlock
    );

    event OrderLifecycleTransitioned(
        OrderProductType indexed productType,
        uint256 indexed orderId,
        LifecycleStatus previousLifecycle,
        LifecycleStatus newLifecycle,
        CloseReason closeReason,
        uint256 closedBlock,
        uint256 updatedBlock
    );

    event OrderShortfallStateChanged(
        OrderProductType indexed productType,
        uint256 indexed orderId,
        IShortfallLedger.ShortfallStatus previousStatus,
        IShortfallLedger.ShortfallStatus newStatus,
        uint256 updatedBlock
    );

    event OrderCollateralDispositionChanged(
        OrderProductType indexed productType,
        uint256 indexed orderId,
        CollateralDispositionStatus previousDisposition,
        CollateralDispositionStatus newDisposition,
        uint256 updatedBlock
    );

    function initializeLoanOrderState(
        uint256 orderId,
        uint256 createdBlockHint
    ) external;

    function initializeBlocksOnlyOrderState(
        uint256 orderId,
        uint256 createdBlockHint
    ) external;

    function markLoanRepaid(uint256 orderId, uint256 createdBlockHint) external;

    function markBlocksOnlyRepaid(
        uint256 orderId,
        uint256 createdBlockHint
    ) external;

    function applyLoanTerminalTransition(
        uint256 orderId,
        uint256 createdBlockHint,
        LifecycleStatus lifecycle,
        CloseReason closeReason,
        IShortfallLedger.ShortfallStatus shortfallStatus,
        CollateralDispositionStatus collateralDisposition
    ) external;

    function applyBlocksOnlyCloseTransition(
        uint256 orderId,
        uint256 createdBlockHint,
        CloseReason closeReason,
        CollateralDispositionStatus collateralDisposition
    ) external;

    /**
     * @notice Sync loan shortfall status only for an existing loan order state.
     * @dev Reverts if:
     *      - caller is unauthorized in the implementation
     *      - registry/module checks fail in the implementation
     *
     * Security:
    * - Must not bootstrap a missing loan order state into ACTIVE from a shortfall-only update path.
    * - Implementations MAY compensate missing state only when ORDER_ENGINE already reports a terminal
    *   lifecycle (`Liquidated*` / `Defaulted*`), so audit state remains complete after temporary
    *   store outages.
    * - `createdBlockHint` is kept for compatibility and may be used as bootstrap hint during such compensation.
     *
     * @param orderId Loan order identifier
     * @param createdBlockHint Historical compatibility hint (reserved)
     * @param shortfallStatus New shortfall status from SettlementManager shortfall ledger
     */
    function syncLoanShortfallState(
        uint256 orderId,
        uint256 createdBlockHint,
        IShortfallLedger.ShortfallStatus shortfallStatus
    ) external;

    function hasOrderState(
        OrderProductType productType,
        uint256 orderId
    ) external view returns (bool hasState);

    function getOrderState(
        OrderProductType productType,
        uint256 orderId
    ) external view returns (OrderState memory orderState);

    function getLegacyLoanStatus(
        uint256 orderId
    ) external view returns (ILoanNFT.LoanStatus status);
}
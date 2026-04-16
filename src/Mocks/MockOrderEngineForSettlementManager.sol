// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ILendingEngineDebtWrite } from "../interfaces/ILendingEngineDebtWrite.sol";
import { IOrderEngine } from "../interfaces/IOrderEngine.sol";
import { ILoanNFT } from "../interfaces/ILoanNFT.sol";

/// @title MockOrderEngineForSettlementManager
/// @notice Minimal ORDER_ENGINE mock for SettlementManager integration tests.
/// @dev Implements the two functions SettlementManager relies on:
///      - getLoanOrderForView(orderId)
///      - repay(orderId, repayAmount)
contract MockOrderEngineForSettlementManager {
    using SafeERC20 for IERC20;

    uint256 public repayPullAmountOverride;
    mapping(uint256 => uint256) private _totalDueOverride;

    struct LoanOrder {
        uint256 principal;
        uint256 rate;
        uint256 term;
        address borrower;
        address lender;
        address asset;
        uint256 startTimestamp;
        uint256 maturity;
        uint256 repaidAmount;
    }

    mapping(uint256 => LoanOrder) private _orders;
    mapping(uint256 => ILoanNFT.LoanStatus) private _orderStatuses;
    uint256 private _nextOrderId;

    /// @notice Optional linked debt ledger (KEY_LE) to simulate principal repayment effects.
    address public lendingEngineAddrVar;

    event MockOrderSet(uint256 indexed orderId, address borrower, address asset);
    event MockRepaid(uint256 indexed orderId, uint256 repayAmount);
    event MockOrderCreated(uint256 indexed orderId, address borrower, address lender, address asset, uint256 principal, uint256 maturity);
    event MockOrderStatusUpdated(uint256 indexed orderId, uint8 status);

    function setLendingEngine(address le) external {
        lendingEngineAddrVar = le;
    }

    function setRepayPullAmountOverride(uint256 amount) external {
        repayPullAmountOverride = amount;
    }

    function setOrder(uint256 orderId, LoanOrder calldata order) external {
        _orders[orderId] = order;
        _orderStatuses[orderId] = ILoanNFT.LoanStatus.Active;
        emit MockOrderSet(orderId, order.borrower, order.asset);
    }

    function setOrderStatus(uint256 orderId, uint8 status) external {
        _orderStatuses[orderId] = ILoanNFT.LoanStatus(status);
        emit MockOrderStatusUpdated(orderId, status);
    }

    function setOrderTotalDueOverride(uint256 orderId, uint256 totalDue) external {
        _totalDueOverride[orderId] = totalDue;
    }

    /// @notice Create a new order (for SettlementMatchLib tests).
    /// @dev Accepts IOrderEngine.LoanOrder calldata to match the SSOT interface used by production code.
    function createLoanOrder(IOrderEngine.LoanOrder calldata order) external returns (uint256 orderId) {
        // Assign id
        orderId = _nextOrderId;
        unchecked { _nextOrderId = _nextOrderId + 1; }

        // Populate stored order; set start/maturity if caller left them as 0 (common in tests/libraries).
        uint256 startTs = order.startTimestamp == 0 ? block.number : order.startTimestamp;
        uint256 maturity = order.maturity == 0 ? startTs + order.term : order.maturity;

        _orders[orderId] = LoanOrder({
            principal: order.principal,
            rate: order.rate,
            term: order.term,
            borrower: order.borrower,
            lender: order.lender,
            asset: order.asset,
            startTimestamp: startTs,
            maturity: maturity,
            repaidAmount: order.repaidAmount
        });
        _orderStatuses[orderId] = ILoanNFT.LoanStatus.Active;

        emit MockOrderCreated(orderId, order.borrower, order.lender, order.asset, order.principal, maturity);
    }

    function getLoanOrderForView(uint256 orderId) external view returns (LoanOrder memory order) {
        return _orders[orderId];
    }

    function getOrderTotalDueForView(uint256 orderId) external view returns (uint256 totalDue) {
        LoanOrder memory ord = _orders[orderId];
        require(ord.borrower != address(0) && ord.asset != address(0), "MockOrderEngine: invalid order");

        totalDue = _totalDueOverride[orderId];
        if (totalDue != 0) {
            return totalDue;
        }

        uint256 interest = (ord.principal * ord.rate * ord.term) / (2_628_000 * 1e4);
        return ord.principal + interest;
    }

    function getOrderStatusForView(uint256 orderId) external view returns (ILoanNFT.LoanStatus status) {
        LoanOrder memory ord = _orders[orderId];
        require(ord.borrower != address(0) && ord.asset != address(0), "MockOrderEngine: invalid order");
        return _orderStatuses[orderId];
    }

    function markOrderLiquidationStatus(uint256 orderId, ILoanNFT.LoanStatus status) external {
        LoanOrder memory ord = _orders[orderId];
        require(ord.borrower != address(0) && ord.asset != address(0), "MockOrderEngine: invalid order");
        _orderStatuses[orderId] = status;
        emit MockOrderStatusUpdated(orderId, uint8(status));
    }

    /// @notice Mock repay: pulls tokens from msg.sender and optionally updates linked debt ledger.
    /// @dev This is intentionally simplified: treat repayAmount as "principal delta" for KEY_LE.
    function repay(uint256 orderId, uint256 repayAmount) external {
        LoanOrder storage ord = _orders[orderId];
        require(ord.borrower != address(0) && ord.asset != address(0), "MockOrderEngine: invalid order");
        require(repayAmount > 0, "MockOrderEngine: repayAmount=0");
        require(
            _orderStatuses[orderId] != ILoanNFT.LoanStatus.Liquidated &&
                _orderStatuses[orderId] != ILoanNFT.LoanStatus.Defaulted &&
                _orderStatuses[orderId] != ILoanNFT.LoanStatus.LiquidatedWithShortfall &&
                _orderStatuses[orderId] != ILoanNFT.LoanStatus.DefaultedWithShortfall,
            "MockOrderEngine: order not repayable"
        );

        uint256 pullAmount = repayPullAmountOverride == 0 ? repayAmount : repayPullAmountOverride;
        require(pullAmount <= repayAmount, "MockOrderEngine: pullAmount exceeds repay");

        IERC20(ord.asset).safeTransferFrom(msg.sender, address(this), pullAmount);
        ord.repaidAmount += repayAmount;

        address le = lendingEngineAddrVar;
        if (le != address(0)) {
            ILendingEngineDebtWrite(le).repay(ord.borrower, ord.asset, repayAmount);
        }

        if (ord.repaidAmount >= this.getOrderTotalDueForView(orderId)) {
            _orderStatuses[orderId] = ILoanNFT.LoanStatus.Repaid;
            emit MockOrderStatusUpdated(orderId, uint8(ILoanNFT.LoanStatus.Repaid));
        }

        emit MockRepaid(orderId, repayAmount);
    }
}


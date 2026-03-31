// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ILendingEngineDebtWrite } from "../interfaces/ILendingEngineDebtWrite.sol";
import { IOrderEngine } from "../interfaces/IOrderEngine.sol";

/// @title MockOrderEngineForSettlementManager
/// @notice Minimal ORDER_ENGINE mock for SettlementManager integration tests.
/// @dev Implements the two functions SettlementManager relies on:
///      - getLoanOrderForView(orderId)
///      - repay(orderId, repayAmount)
contract MockOrderEngineForSettlementManager {
    using SafeERC20 for IERC20;

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
    uint256 private _nextOrderId;

    /// @notice Optional linked debt ledger (KEY_LE) to simulate principal repayment effects.
    address public lendingEngineAddrVar;

    event MockOrderSet(uint256 indexed orderId, address borrower, address asset);
    event MockRepaid(uint256 indexed orderId, uint256 repayAmount);
    event MockOrderCreated(uint256 indexed orderId, address borrower, address lender, address asset, uint256 principal, uint256 maturity);

    function setLendingEngine(address le) external {
        lendingEngineAddrVar = le;
    }

    function setOrder(uint256 orderId, LoanOrder calldata order) external {
        _orders[orderId] = order;
        emit MockOrderSet(orderId, order.borrower, order.asset);
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

        emit MockOrderCreated(orderId, order.borrower, order.lender, order.asset, order.principal, maturity);
    }

    function getLoanOrderForView(uint256 orderId) external view returns (LoanOrder memory order) {
        return _orders[orderId];
    }

    /// @notice Mock repay: pulls tokens from msg.sender and optionally updates linked debt ledger.
    /// @dev This is intentionally simplified: treat repayAmount as "principal delta" for KEY_LE.
    function repay(uint256 orderId, uint256 repayAmount) external {
        LoanOrder storage ord = _orders[orderId];
        require(ord.borrower != address(0) && ord.asset != address(0), "MockOrderEngine: invalid order");
        require(repayAmount > 0, "MockOrderEngine: repayAmount=0");

        IERC20(ord.asset).safeTransferFrom(msg.sender, address(this), repayAmount);
        ord.repaidAmount += repayAmount;

        address le = lendingEngineAddrVar;
        if (le != address(0)) {
            ILendingEngineDebtWrite(le).repay(ord.borrower, ord.asset, repayAmount);
        }

        emit MockRepaid(orderId, repayAmount);
    }
}


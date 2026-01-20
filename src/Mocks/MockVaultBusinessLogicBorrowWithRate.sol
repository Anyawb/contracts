// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { MockERC20 } from "./MockERC20.sol";

/// @title MockVaultBusinessLogicBorrowWithRate
/// @notice Minimal mock for VaultBusinessLogic.borrowWithRate used by strategy tests
/// @dev Mints `asset` (assumed MockERC20) to `user` and returns an incrementing orderId.
contract MockVaultBusinessLogicBorrowWithRate {
    uint256 public nextOrderId = 1;

    event BorrowWithRateCalled(
        address indexed user,
        address indexed lender,
        address indexed asset,
        uint256 amount,
        uint256 annualRateBps,
        uint16 termDays,
        uint256 orderId
    );

    function borrowWithRate(
        address user,
        address lender,
        address asset,
        uint256 amount,
        uint256 annualRateBps,
        uint16 termDays
    ) external returns (uint256 orderId) {
        orderId = nextOrderId++;
        emit BorrowWithRateCalled(user, lender, asset, amount, annualRateBps, termDays, orderId);

        // Test-only behavior: mint borrowed token to borrower
        MockERC20(asset).mint(user, amount);
    }
}


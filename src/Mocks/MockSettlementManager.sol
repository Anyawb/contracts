// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockSettlementManager
/// @notice Minimal SettlementManager mock for unit tests
/// @dev Accepts VaultCore.repay calls without reverting.
contract MockSettlementManager {
    event RepaidAndSettled(address indexed user, address indexed asset, uint256 amount, uint256 orderId, address caller);

    function repayAndSettle(address user, address asset, uint256 amount, uint256 orderId) external {
        emit RepaidAndSettled(user, asset, amount, orderId, msg.sender);
    }
}


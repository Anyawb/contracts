// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockRewardManagerCoreBorrowCheck
/// @notice Test-only mock for LendingEngine long-duration level gating.
contract MockRewardManagerCoreBorrowCheck {
    mapping(address => uint8) private _levels;

    function setUserLevelForBorrowCheck(address user, uint8 level) external {
        _levels[user] = level;
    }

    function getUserLevelForBorrowCheck(address user) external view returns (uint8) {
        return _levels[user];
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockRewardViewBorrowCheckMirror
/// @notice Configurable RewardView borrow-level mirror used only for drift tests.
contract MockRewardViewBorrowCheckMirror {
    mapping(address => uint8) private _levels;

    function setUserLevelForBorrowCheck(address user, uint8 level) external {
        _levels[user] = level;
    }

    function getUserLevelForBorrowCheck(
        address user
    ) external view returns (uint8) {
        return _levels[user];
    }
}

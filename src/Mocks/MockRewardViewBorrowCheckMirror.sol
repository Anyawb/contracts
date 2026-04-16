// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockRewardViewBorrowCheckMirror
/// @notice 可配置的 RewardView 借款等级镜像，仅用于测试镜像漂移场景。
contract MockRewardViewBorrowCheckMirror {
    mapping(address => uint8) private _levels;

    function setUserLevelForBorrowCheck(address user, uint8 level) external {
        _levels[user] = level;
    }

    function getUserLevelForBorrowCheck(address user) external view returns (uint8) {
        return _levels[user];
    }
}

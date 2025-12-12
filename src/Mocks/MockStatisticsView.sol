// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockStatisticsView
/// @notice 供测试使用的统计视图模拟合约，兼容 StatisticsView 的最小接口
contract MockStatisticsView {
    struct GlobalSnapshot {
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 timestamp;
    }

    bool public shouldFail;
    mapping(address => uint256) public userCollateral;
    mapping(address => uint256) public userDebt;
    mapping(address => bool) public userActive;
    uint256 public activeUsers;
    uint256 public totalCollateral;
    uint256 public totalDebt;
    uint256 public lastUpdate;

    function setShouldFail(bool v) external {
        shouldFail = v;
    }

    function pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay
    ) external {
        if (shouldFail) revert("MockStatisticsView: fail");

        // 更新用户与全局
        if (collateralIn > 0) {
            userCollateral[user] += collateralIn;
            totalCollateral += collateralIn;
        }
        if (collateralOut > 0) {
            uint256 sub = collateralOut > userCollateral[user] ? userCollateral[user] : collateralOut;
            userCollateral[user] -= sub;
            totalCollateral = totalCollateral > sub ? totalCollateral - sub : 0;
        }
        if (borrow > 0) {
            userDebt[user] += borrow;
            totalDebt += borrow;
        }
        if (repay > 0) {
            uint256 subd = repay > userDebt[user] ? userDebt[user] : repay;
            userDebt[user] -= subd;
            totalDebt = totalDebt > subd ? totalDebt - subd : 0;
        }

        bool wasActive = userActive[user];
        bool isActive = (userCollateral[user] > 0 || userDebt[user] > 0);
        if (wasActive != isActive) {
            userActive[user] = isActive;
            if (isActive) activeUsers += 1; else if (activeUsers > 0) activeUsers -= 1;
        }

        lastUpdate = block.timestamp;
    }

    function getGlobalSnapshot() external view returns (GlobalSnapshot memory s) {
        s = GlobalSnapshot({
            activeUsers: activeUsers,
            totalCollateral: totalCollateral,
            totalDebt: totalDebt,
            timestamp: lastUpdate
        });
    }
}



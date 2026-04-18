// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockStatisticsView
/// @notice Mock statistics view contract used in tests.
contract MockStatisticsView {
    struct GlobalSnapshot {
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 updateBlock;
    }

    struct GlobalStatistics {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateBlock;
    }

    bool public shouldFail;
    mapping(address => uint256) public userCollateral;
    mapping(address => uint256) public userDebt;
    mapping(address => bool) public userActive;
    uint256 public activeUsers;
    uint256 public totalCollateral;
    uint256 public totalDebt;
    uint256 public lastUpdateBlock;

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

        // Update user and global counters.
        if (collateralIn > 0) {
            userCollateral[user] += collateralIn;
            totalCollateral += collateralIn;
        }
        if (collateralOut > 0) {
            uint256 sub = collateralOut > userCollateral[user]
                ? userCollateral[user]
                : collateralOut;
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
            if (isActive) activeUsers += 1;
            else if (activeUsers > 0) activeUsers -= 1;
        }

        lastUpdateBlock = block.number;
    }

    function getGlobalStatisticsWithMeta()
        external
        view
        returns (GlobalStatistics memory g, bool isValid, uint256 blockNumber)
    {
        g = GlobalStatistics({
            totalUsers: 0,
            activeUsers: activeUsers,
            totalCollateral: totalCollateral,
            totalDebt: totalDebt,
            lastUpdateBlock: lastUpdateBlock
        });
        blockNumber = lastUpdateBlock;
        isValid = blockNumber != 0;
    }
}

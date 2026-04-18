// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IStatisticsViewBasic
 * @notice Shared read-only subset for global statistics snapshots.
 */
interface IStatisticsViewBasic {
    struct GlobalStatistics {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateBlock;
    }

    function getGlobalStatisticsWithMeta()
        external
        view
        returns (GlobalStatistics memory g, bool isValid, uint256 blockNumber);
}

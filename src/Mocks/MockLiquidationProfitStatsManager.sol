// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockLiquidationProfitStatsManager
/// @notice Mock implementation of LiquidationProfitStatsManager for testing
/// @dev This is a simple mock that stores profit statistics for testing purposes
contract MockLiquidationProfitStatsManager {
    struct ProfitStats {
        uint256 totalProfit;
        uint256 totalLiquidations;
        uint256 lastLiquidationBlock;
    }

    mapping(address => ProfitStats) private _profitStats;

    /// @notice Set profit statistics for a liquidator (for testing)
    /// @param liquidator Liquidator address
    /// @param totalProfit Total profit earned
    /// @param totalLiquidations Total number of liquidations
    /// @param lastLiquidationBlock Last liquidation blockNumber (block.number axis; legacy mock)
    function setProfitStats(
        address liquidator,
        uint256 totalProfit,
        uint256 totalLiquidations,
        uint256 lastLiquidationBlock
    ) external {
        _profitStats[liquidator] = ProfitStats({
            totalProfit: totalProfit,
            totalLiquidations: totalLiquidations,
            lastLiquidationBlock: lastLiquidationBlock
        });
    }

    /// @notice Get profit statistics for a liquidator
    /// @param liquidator Liquidator address
    /// @return totalProfit Total profit earned
    /// @return totalLiquidations Total number of liquidations
    /// @return lastLiquidationBlock Last liquidation blockNumber
    function getProfitStats(address liquidator)
        external
        view
        returns (
            uint256 totalProfit,
            uint256 totalLiquidations,
            uint256 lastLiquidationBlock
        )
    {
        ProfitStats memory stats = _profitStats[liquidator];
        return (stats.totalProfit, stats.totalLiquidations, stats.lastLiquidationBlock);
    }
}

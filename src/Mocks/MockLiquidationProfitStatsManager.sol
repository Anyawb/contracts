// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILiquidationProfitStatsManager } from "../interfaces/ILiquidationProfitStatsManager.sol";

/// @notice Mock implementation for ILiquidationProfitStatsManager used in view tests
contract MockLiquidationProfitStatsManager is ILiquidationProfitStatsManager {
    struct ProfitStat {
        uint256 totalProfit;
        uint256 liquidationCount;
        uint256 lastLiquidationTime;
    }

    mapping(address => ProfitStat) private _stats;

    uint256 private _globalTotalLiquidations;
    uint256 private _globalTotalProfit;
    uint256 private _globalActiveLiquidators;
    uint256 private _globalLastUpdateTime;

    address[] private _leaderboardAddrs;
    uint256[] private _leaderboardProfits;

    // ===== Setters for tests =====
    function setProfitStats(address liquidator, uint256 profit, uint256 count, uint256 lastTs) external {
        _stats[liquidator] = ProfitStat({ totalProfit: profit, liquidationCount: count, lastLiquidationTime: lastTs });
    }

    function setGlobalStats(uint256 totalLiquidations, uint256 totalProfit, uint256 activeLiquidators, uint256 lastUpdateTime) external {
        _globalTotalLiquidations = totalLiquidations;
        _globalTotalProfit = totalProfit;
        _globalActiveLiquidators = activeLiquidators;
        _globalLastUpdateTime = lastUpdateTime;
    }

    function setLeaderboard(address[] calldata liquidators, uint256[] calldata profits) external {
        _leaderboardAddrs = liquidators;
        _leaderboardProfits = profits;
    }

    // ===== Interface implementation (minimal) =====
    function getModule(bytes32) external pure returns (address) { return address(0); }
    function updateModule(bytes32, address) external {}
    function batchUpdateModules(bytes32[] memory, address[] memory) external {}
    function removeModule(bytes32) external {}

    function updateLiquidatorProfitStats(address, uint256) external {}
    function batchUpdateLiquidatorProfitStats(address[] calldata, uint256[] calldata) external {}
    function resetLiquidatorProfitStats(address) external {}

    function getLiquidatorProfitStats(address liquidator) external view override returns (uint256 totalProfit, uint256 liquidationCount, uint256 lastLiquidationTime) {
        ProfitStat memory s = _stats[liquidator];
        return (s.totalProfit, s.liquidationCount, s.lastLiquidationTime);
    }

    function getGlobalLiquidationStats() external view override returns (uint256 totalLiquidations, uint256 totalProfit, uint256 activeLiquidators, uint256 lastUpdateTime) {
        return (_globalTotalLiquidations, _globalTotalProfit, _globalActiveLiquidators, _globalLastUpdateTime);
    }

    function getLiquidatorLeaderboard(uint256 /*limit*/) external view override returns (address[] memory liquidators, uint256[] memory profits) {
        return (_leaderboardAddrs, _leaderboardProfits);
    }

    function hasLiquidatorProfitStats(address liquidator) external view override returns (bool hasStats) {
        return _stats[liquidator].liquidationCount > 0 || _stats[liquidator].totalProfit > 0;
    }

    function getActiveLiquidatorsCount() external view override returns (uint256 activeCount) {
        return _globalActiveLiquidators;
    }

    function batchGetLiquidatorProfitStats(address[] calldata liquidators) external view override returns (uint256[] memory totalProfits, uint256[] memory liquidationCounts, uint256[] memory lastLiquidationTimes) {
        uint256 len = liquidators.length;
        totalProfits = new uint256[](len);
        liquidationCounts = new uint256[](len);
        lastLiquidationTimes = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            ProfitStat memory s = _stats[liquidators[i]];
            totalProfits[i] = s.totalProfit;
            liquidationCounts[i] = s.liquidationCount;
            lastLiquidationTimes[i] = s.lastLiquidationTime;
        }
    }
}


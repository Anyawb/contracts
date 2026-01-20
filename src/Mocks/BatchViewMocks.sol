// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { DegradationStorage } from "../monitor/DegradationStorage.sol";

contract BatchMockHealthView {
    struct ModuleHealth {
        bool    isHealthy;
        bytes32 detailsHash;
        uint32  lastCheckTime;
        uint32  consecutiveFailures;
    }

    mapping(address => uint256) private _healthFactor;
    mapping(address => bool) private _isValid;
    mapping(address => ModuleHealth) private _moduleHealth;

    function setUserHealth(address user, uint256 healthFactor, bool isValid) external {
        _healthFactor[user] = healthFactor;
        _isValid[user] = isValid;
    }

    function setModuleHealth(
        address module,
        bool isHealthy,
        bytes32 detailsHash,
        uint32 lastCheckTime,
        uint32 consecutiveFailures
    ) external {
        _moduleHealth[module] = ModuleHealth({
            isHealthy: isHealthy,
            detailsHash: detailsHash,
            lastCheckTime: lastCheckTime,
            consecutiveFailures: consecutiveFailures
        });
    }

    function getUserHealthFactor(address user) external view returns (uint256, bool) {
        return (_healthFactor[user], _isValid[user]);
    }

    function getModuleHealth(address module) external view returns (ModuleHealth memory) {
        return _moduleHealth[module];
    }
}

contract BatchMockRiskView {
    struct RiskAssessment {
        bool liquidatable;
        uint256 healthFactor;
        uint8 warningLevel;
    }

    mapping(address => RiskAssessment) private _assessments;

    function setRiskAssessment(address user, bool liquidatable, uint256 healthFactor, uint8 warningLevel) external {
        _assessments[user] = RiskAssessment(liquidatable, healthFactor, warningLevel);
    }

    function getUserRiskAssessment(address user) external view returns (RiskAssessment memory) {
        return _assessments[user];
    }
}

contract BatchMockPriceOracle {
    mapping(address => uint256) private _prices;

    function setPrice(address asset, uint256 price) external {
        _prices[asset] = price;
    }

    function getPrice(address asset) external view returns (uint256 price, uint256 refreshedAt, uint256) {
        price = _prices[asset];
        refreshedAt = block.timestamp;
        return (price, refreshedAt, 0);
    }
}

contract BatchMockDegradationMonitor {
    DegradationStorage.DegradationEvent[] private _events;

    function pushEvent(
        address module,
        bytes32 reasonHash,
        uint256 fallbackValue,
        bool usedFallback,
        uint256 timestamp,
        uint256 blockNumber
    ) external {
        _events.push(
            DegradationStorage.DegradationEvent({
                module: module,
                reasonHash: reasonHash,
                fallbackValue: fallbackValue,
                usedFallback: usedFallback,
                timestamp: timestamp,
                blockNumber: blockNumber
            })
        );
    }

    function latestCount() external view returns (uint256) {
        return _events.length;
    }

    function getSystemDegradationHistory(uint256 limit) external view returns (DegradationStorage.DegradationEvent[] memory history) {
        uint256 available = _events.length;
        if (limit > available) {
            limit = available;
        }
        history = new DegradationStorage.DegradationEvent[](limit);
        for (uint256 i; i < limit; ++i) {
            history[i] = _events[available - 1 - i];
        }
    }
}

contract CacheMockPositionView {
    struct Position {
        uint256 collateral;
        uint256 debt;
    }

    mapping(address => mapping(address => Position)) private _positions;

    function setPosition(address user, address asset, uint256 collateral, uint256 debt) external {
        _positions[user][asset] = Position({ collateral: collateral, debt: debt });
    }

    function getUserPosition(address user, address asset) external view returns (uint256 collateral, uint256 debt) {
        Position memory p = _positions[user][asset];
        return (p.collateral, p.debt);
    }
}

contract CacheMockStatisticsView {
    struct GlobalStatistics {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateTime;
    }

    GlobalStatistics private _stats;

    function setGlobalStatistics(GlobalStatistics calldata stats_) external {
        _stats = stats_;
    }

    function getGlobalStatistics() external view returns (GlobalStatistics memory) {
        return _stats;
    }
}

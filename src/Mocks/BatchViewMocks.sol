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

    function getUserHealthFactorWithMeta(address user) external view returns (uint256, bool, uint256) {
        return (_healthFactor[user], _isValid[user], 0);
    }

    function getModuleHealthWithMeta(address module) external view returns (ModuleHealth memory, bool, uint256) {
        ModuleHealth memory mh = _moduleHealth[module];
        return (mh, true, uint256(mh.lastCheckTime));
    }
}

contract BatchMockRiskView {
    struct RiskAssessmentWithMeta {
        bool liquidatable;
        bool isValid;
        uint8 warningLevel;
        uint256 healthFactor;
        uint256 blockNumber;
    }

    mapping(address => RiskAssessmentWithMeta) private _assessments;

    function setRiskAssessment(address user, bool liquidatable, uint256 healthFactor, uint8 warningLevel) external {
        _assessments[user] = RiskAssessmentWithMeta(liquidatable, true, warningLevel, healthFactor, block.number);
    }

    function getUserRiskAssessment(address user) external view returns (RiskAssessmentWithMeta memory) {
        return _assessments[user];
    }
}

contract BatchMockPriceOracle {
    mapping(address => uint256) private _prices;

    function setPrice(address asset, uint256 price) external {
        _prices[asset] = price;
    }

    function getPrice(address asset) external view returns (uint256 price, uint256 blockNumber, uint256) {
        price = _prices[asset];
        blockNumber = block.number;
        return (price, blockNumber, 0);
    }
}

contract BatchMockDegradationMonitor {
    DegradationStorage.DegradationEvent[] private _events;

    function pushEvent(
        address module,
        bytes32 reasonHash,
        uint256 fallbackValue,
        bool usedFallback,
        uint256 legacyBlockNumber,
        uint256 blockNumber
    ) external {
        _events.push(
            DegradationStorage.DegradationEvent({
                module: module,
                reasonHash: reasonHash,
                fallbackValue: fallbackValue,
                usedFallback: usedFallback,
                legacyBlockNumber: legacyBlockNumber,
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

    function getUserPositionWithMeta(address user, address asset)
        external
        view
        returns (uint256 collateral, uint256 debt, bool isValid, uint256 updateBlock, uint64 version)
    {
        Position memory p = _positions[user][asset];
        return (p.collateral, p.debt, true, 0, 0);
    }
}

contract CacheMockStatisticsView {
    struct GlobalStatistics {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateBlock;
    }

    GlobalStatistics private _stats;

    function setGlobalStatistics(GlobalStatistics calldata stats_) external {
        _stats = stats_;
    }

    function getGlobalStatisticsWithMeta()
        external
        view
        returns (GlobalStatistics memory, bool, uint256)
    {
        return (_stats, true, _stats.lastUpdateBlock);
    }
}

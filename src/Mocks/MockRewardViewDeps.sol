// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { RewardTypes } from "../Reward/RewardTypes.sol";

contract MockRewardCoreView {
    mapping(address => RewardTypes.ConsumptionRecord[]) private _records;
    mapping(RewardTypes.ServiceType => uint256) private _serviceUsage;
    mapping(address => mapping(RewardTypes.ServiceType => uint256)) private _lastConsumption;
    mapping(RewardTypes.ServiceType => mapping(RewardTypes.ServiceLevel => RewardTypes.ServiceConfig)) private _configs;

    function setUserConsumptions(address user, RewardTypes.ConsumptionRecord[] calldata records) external {
        delete _records[user];
        for (uint256 i; i < records.length; i++) {
            _records[user].push(records[i]);
        }
    }

    function getUserConsumptions(address user) external view returns (RewardTypes.ConsumptionRecord[] memory) {
        return _records[user];
    }

    function setServiceUsage(RewardTypes.ServiceType serviceType, uint256 usage) external {
        _serviceUsage[serviceType] = usage;
    }

    function getServiceUsage(RewardTypes.ServiceType serviceType) external view returns (uint256) {
        return _serviceUsage[serviceType];
    }

    function setUserLastConsumption(address user, RewardTypes.ServiceType serviceType, uint256 ts) external {
        _lastConsumption[user][serviceType] = ts;
    }

    function getUserLastConsumption(address user, RewardTypes.ServiceType serviceType) external view returns (uint256) {
        return _lastConsumption[user][serviceType];
    }

    function setServiceConfig(
        RewardTypes.ServiceType serviceType,
        RewardTypes.ServiceLevel level,
        RewardTypes.ServiceConfig calldata cfg
    ) external {
        _configs[serviceType][level] = cfg;
    }

    function getServiceConfig(RewardTypes.ServiceType serviceType, RewardTypes.ServiceLevel level)
        external
        view
        returns (RewardTypes.ServiceConfig memory)
    {
        return _configs[serviceType][level];
    }
}

contract MockRewardManagerCoreView {
    struct UserCache {
        uint256 points;
        uint256 timestamp;
        bool isValid;
        uint8 level;
        uint256 lastActivity;
        uint256 totalLoans;
        uint256 totalVolume;
        uint256 penaltyDebt;
    }

    uint256 public baseUsd;
    uint256 public perDay;
    uint256 public bonus;
    uint256 public baseEth;

    uint256 public cacheExpirationTime;
    uint256 public dynamicThreshold;
    uint256 public dynamicMultiplier;
    uint256 public lastRewardResetTime;

    mapping(uint8 => uint256) public levelMultiplier;
    mapping(address => UserCache) public userCache;
    uint256 public totalBatchOperations;
    uint256 public totalCachedRewards;

    function setRewardParameters(uint256 _baseUsd, uint256 _perDay, uint256 _bonus, uint256 _baseEth) external {
        baseUsd = _baseUsd;
        perDay = _perDay;
        bonus = _bonus;
        baseEth = _baseEth;
    }

    function getRewardParameters() external view returns (uint256, uint256, uint256, uint256) {
        return (baseUsd, perDay, bonus, baseEth);
    }

    function setUserCache(address user, uint256 points, uint256 timestamp, bool isValid, uint8 level_, uint256 lastAct, uint256 loans, uint256 volume, uint256 penalty) external {
        userCache[user] = UserCache(points, timestamp, isValid, level_, lastAct, loans, volume, penalty);
    }

    function getUserCache(address user) external view returns (uint256, uint256, bool) {
        UserCache memory c = userCache[user];
        return (c.points, c.timestamp, c.isValid);
    }

    function getCacheExpirationTime() external view returns (uint256) {
        return cacheExpirationTime;
    }

    function setCacheExpirationTime(uint256 v) external { cacheExpirationTime = v; }

    function setDynamicRewardParameters(uint256 threshold, uint256 multiplier) external {
        dynamicThreshold = threshold;
        dynamicMultiplier = multiplier;
    }

    function getDynamicRewardParameters() external view returns (uint256, uint256) {
        return (dynamicThreshold, dynamicMultiplier);
    }

    function setLastRewardResetTime(uint256 ts) external { lastRewardResetTime = ts; }

    function getLastRewardResetTime() external view returns (uint256) {
        return lastRewardResetTime;
    }

    function setUserLevel(address user, uint8 level_) external {
        userCache[user].level = level_;
    }

    function getUserLevel(address user) external view returns (uint8) {
        return userCache[user].level;
    }

    function setLevelMultiplier(uint8 level_, uint256 mul) external { levelMultiplier[level_] = mul; }

    function getLevelMultiplier(uint8 level_) external view returns (uint256) {
        return levelMultiplier[level_];
    }

    function setUserActivity(address user, uint256 lastActivity, uint256 totalLoans, uint256 totalVolume) external {
        userCache[user].lastActivity = lastActivity;
        userCache[user].totalLoans = totalLoans;
        userCache[user].totalVolume = totalVolume;
    }

    function getUserActivity(address user) external view returns (uint256, uint256, uint256) {
        UserCache memory c = userCache[user];
        return (c.lastActivity, c.totalLoans, c.totalVolume);
    }

    function setUserPenaltyDebt(address user, uint256 debt) external {
        userCache[user].penaltyDebt = debt;
    }

    function getUserPenaltyDebt(address user) external view returns (uint256) {
        return userCache[user].penaltyDebt;
    }

    function setSystemStats(uint256 totalOps, uint256 totalCached) external {
        totalBatchOperations = totalOps;
        totalCachedRewards = totalCached;
    }

    function getTotalBatchOperations() external view returns (uint256) {
        return totalBatchOperations;
    }

    function getTotalCachedRewards() external view returns (uint256) {
        return totalCachedRewards;
    }
}

contract MockRewardPointsMinimal {
    mapping(address => uint256) public balances;

    function setBalance(address user, uint256 amount) external {
        balances[user] = amount;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return balances[owner];
    }
}


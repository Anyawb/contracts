// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockRewardManagerCoreView {
    struct UserCache {
        uint256 points;
        uint256 blockNumber;
        bool isValid;
        uint8 level;
        uint256 lastActivity;
        uint256 penaltyDebt;
    }

    uint256 public baseUsd;
    uint256 public perDay;
    uint256 public bonus;
    uint256 public baseEth;

    uint256 public cacheExpirationTime;
    uint256 public dynamicThreshold;
    uint256 public dynamicMultiplier;
    uint256 public lastRewardResetBlock;

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

    function setUserCache(
        address user,
        uint256 points,
        uint256 blockNumber,
        bool isValid,
        uint8 level_,
        uint256 lastAct,
        uint256 penalty
    ) external {
        userCache[user] = UserCache(points, blockNumber, isValid, level_, lastAct, penalty);
    }

    function getUserCache(address user) external view returns (uint256, uint256, bool) {
        UserCache memory c = userCache[user];
        return (c.points, c.blockNumber, c.isValid);
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

    function setLastRewardResetBlock(uint256 blockNumber) external { lastRewardResetBlock = blockNumber; }

    function getLastRewardResetBlock() external view returns (uint256) {
        return lastRewardResetBlock;
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

contract MockEasyTokenMinimal {
    mapping(address => uint256) public balances;

    function setBalance(address user, uint256 amount) external {
        balances[user] = amount;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return balances[owner];
    }
}


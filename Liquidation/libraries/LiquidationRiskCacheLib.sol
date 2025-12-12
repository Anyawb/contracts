// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library LiquidationRiskCacheLib {
    function setCache(mapping(address => uint256) storage cache, address user, uint256 healthFactor) internal {
        cache[user] = healthFactor;
    }

    function getCache(mapping(address => uint256) storage cache, address user) internal view returns (uint256) {
        return cache[user];
    }

    function clearCache(mapping(address => uint256) storage cache, address user) internal {
        delete cache[user];
    }

    function batchUpdate(
        mapping(address => uint256) storage cache,
        address[] calldata users,
        uint256[] calldata healthFactors,
        uint256 maxBatchSize
    ) internal {
        if (users.length != healthFactors.length) revert("InvalidBatchLength");
        if (users.length > maxBatchSize) revert("BatchTooLarge");
        for (uint256 i = 0; i < users.length;) {
            address user = users[i];
            if (user != address(0)) {
                cache[user] = healthFactors[i];
            }
            unchecked { ++i; }
        }
    }

    function batchClear(
        mapping(address => uint256) storage cache,
        address[] calldata users,
        uint256 maxBatchSize
    ) internal {
        if (users.length > maxBatchSize) revert("BatchTooLarge");
        for (uint256 i = 0; i < users.length;) {
            address user = users[i];
            if (user != address(0)) {
                delete cache[user];
            }
            unchecked { ++i; }
        }
    }
}



// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRewardAccrualManager {
    function offsetPenaltyOnReward(
        address user,
        uint256 rewardAmount,
        string calldata reason
    ) external returns (uint256 netAmount);
}

contract MockRewardAccrualBatchCaller {
    function offsetTwice(
        address ram,
        address user,
        uint256 amount1,
        uint256 amount2,
        string calldata reason1,
        string calldata reason2
    ) external returns (uint256 net1, uint256 net2) {
        net1 = IRewardAccrualManager(ram).offsetPenaltyOnReward(
            user,
            amount1,
            reason1
        );
        net2 = IRewardAccrualManager(ram).offsetPenaltyOnReward(
            user,
            amount2,
            reason2
        );
    }
}

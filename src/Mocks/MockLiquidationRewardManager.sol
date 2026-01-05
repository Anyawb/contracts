// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal mock for LiquidationRewardManager used in view tests
contract MockLiquidationRewardManager {
    uint256 private _profitRate;

    function setLiquidatorProfitRate(uint256 rate) external {
        _profitRate = rate;
    }

    function getLiquidatorProfitRate() external view returns (uint256) {
        return _profitRate;
    }
}


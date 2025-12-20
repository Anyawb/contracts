// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal mock for ILiquidationRiskManager used in tests
contract MockLiquidationRiskManager {
    uint256 private _minHealthFactorBps = 11000; // default 110%

    function setMinHealthFactor(uint256 newMinHfBps) external {
        _minHealthFactorBps = newMinHfBps;
    }

    function getMinHealthFactor() external view returns (uint256) {
        return _minHealthFactorBps;
    }
}








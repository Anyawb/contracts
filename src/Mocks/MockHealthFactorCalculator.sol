// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockHealthFactorCalculator
/// @notice Simplified health-factor calculator mock used only in tests.
contract MockHealthFactorCalculator {
    uint256 private _healthFactorBps;

    constructor() {
        _healthFactorBps = 11000; // Default 110%.
    }

    /// @notice Sets the mocked health factor in bps.
    function setHealthFactor(uint256 newHfBps) external {
        _healthFactorBps = newHfBps;
    }

    /// @notice Returns the mocked health factor, ignoring the user argument.
    function getHealthFactor(
        address /* user */
    ) external view returns (uint256) {
        return _healthFactorBps;
    }

    /// @notice Returns the mocked preview health factor.
    function previewHealthFactor(
        uint256 /* collateral */,
        uint256 /* debt */
    ) external view returns (uint256) {
        return _healthFactorBps;
    }
}

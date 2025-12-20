// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RevertingHealthView
/// @notice Mock HealthView that always reverts on push, used to test best-effort health push failure paths.
contract RevertingHealthView {
    function pushRiskStatus(
        address,
        uint256,
        uint256,
        bool,
        uint256
    ) external pure {
        revert("revert-pushRiskStatus");
    }
}




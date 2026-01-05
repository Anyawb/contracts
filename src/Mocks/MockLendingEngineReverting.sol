// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILendingEngineBasic } from "../interfaces/ILendingEngineBasic.sol";

/// @title MockLendingEngineReverting
/// @notice Minimal mock that reverts on forceReduceDebt for testing atomicity
contract MockLendingEngineReverting is ILendingEngineBasic {
    function borrow(address, address, uint256, uint256, uint16) external pure override {}
    function repay(address, address, uint256) external pure override {}
    function getDebt(address, address) external pure override returns (uint256) { return 0; }
    function getTotalDebtByAsset(address) external pure override returns (uint256) { return 0; }
    function getUserTotalDebtValue(address) external pure override returns (uint256) { return 0; }
    function getTotalDebtValue() external pure override returns (uint256) { return 0; }
    function getUserDebtAssets(address) external pure override returns (address[] memory) { return new address[](0); }
    function calculateExpectedInterest(address, address, uint256) external pure override returns (uint256) { return 0; }
    function getReducibleDebtAmount(address, address) external pure override returns (uint256) { return 0; }
    function calculateDebtValue(address, address) external pure override returns (uint256) { return 0; }

    function forceReduceDebt(address, address, uint256) external pure override {
        revert("forceReduceDebt-revert");
    }
}







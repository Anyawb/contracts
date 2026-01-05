// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILendingEngineBasic } from "../interfaces/ILendingEngineBasic.sol";

/// @title BadLendingEngine
/// @dev recordBorrow 总是 revert("LE fail")，供负面测试使用。
contract BadLendingEngine is ILendingEngineBasic {
    function borrow(address user, address asset, uint256 amount, uint256 collateralAdded, uint16 termDays) external pure {
        user; asset; amount; collateralAdded; termDays; // silence unused parameters
        revert("LE fail");
    }

    function repay(address user, address asset, uint256 amount) external pure {
        user; asset; amount; // silence unused parameters
    }

    function forceReduceDebt(address user, address asset, uint256 amount) external pure {
        user; asset; amount; // silence unused parameters
    }

    function getDebt(address user, address asset) external pure returns (uint256 debt) {
        user; asset; // silence unused parameters
        return 0;
    }

    function getTotalDebtByAsset(address asset) external pure returns (uint256 totalDebt) {
        asset; // silence unused parameter
        return 0;
    }

    function getUserTotalDebtValue(address user) external pure returns (uint256 totalValue) {
        user; // silence unused parameter
        return 0;
    }

    function getTotalDebtValue() external pure returns (uint256 totalValue) {
        return 0;
    }

    function getUserDebtAssets(address user) external pure returns (address[] memory assets) {
        user; // silence unused parameter
        return new address[](0);
    }

    function calculateExpectedInterest(address user, address asset, uint256 amount) external pure returns (uint256 interest) {
        user; asset; amount; // silence unused parameters
        return 0;
    }

    // ===== Add stubs to satisfy interface =====
    function getReducibleDebtAmount(address user, address asset) external pure returns (uint256 reducibleAmount) {
        user; asset; return 0;
    }

    function calculateDebtValue(address user, address asset) external pure returns (uint256 value) {
        user; asset; return 0;
    }

} 
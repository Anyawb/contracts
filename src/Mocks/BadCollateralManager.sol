// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ICollateralManager } from "../interfaces/ICollateralManager.sol";

/// @title BadCollateralManager
/// @dev depositCollateral 总是 revert("Mock fail")，供负面测试使用。
contract BadCollateralManager is ICollateralManager {
    function depositCollateral(address user, address asset, uint256 amount) external pure {
        user; asset; amount; // silence unused parameters
        revert("Mock fail");
    }

    function withdrawCollateral(address user, address asset, uint256 amount) external pure {
        user; asset; amount; // silence unused parameters
    }

    function forceWithdrawCollateral(address user, address asset, uint256 amount, address to) external pure {
        user; asset; amount; to; // silence unused parameters
    }

    function getCollateral(address user, address asset) external pure returns (uint256 balance) {
        user; asset; // silence unused parameters
        return 0;
    }

    function getTotalCollateralByAsset(address asset) external pure returns (uint256 total) {
        asset; // silence unused parameter
        return 0;
    }

    function getUserTotalCollateralValue(address user) external pure returns (uint256 totalValue) {
        user; // silence unused parameter
        return 0;
    }

    function getTotalCollateralValue() external pure returns (uint256 totalValue) {
        return 0;
    }

    function getUserCollateralAssets(address user) external pure returns (address[] memory assets) {
        user; // silence unused parameter
        return new address[](0);
    }

    function getAssetValue(address asset, uint256 amount) external pure returns (uint256 value) {
        asset; amount; // silence unused parameters
        return 0;
    }
} 
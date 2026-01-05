// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ICollateralManager } from "../interfaces/ICollateralManager.sol";

/// @title RevertingCollateralTotals
/// @notice Minimal CM mock that reverts on total collateral reads, used to test health push best-effort paths.
contract RevertingCollateralTotals is ICollateralManager {
    function depositCollateral(address, address, uint256) external pure override {
        // no-op
    }

    function withdrawCollateral(address, address, uint256) external pure override {
        // no-op
    }

    function withdrawCollateralTo(address, address, uint256, address) external pure override {
        // no-op
    }

    function seizeCollateralForLiquidation(address, address, uint256, address) external pure override {
        // no-op
    }

    function getCollateral(address, address) external pure override returns (uint256) {
        return 0;
    }

    function getUserTotalCollateralValue(address) external pure override returns (uint256) {
        revert("revert-totalCollateral");
    }

    function getTotalCollateralByAsset(address) external pure override returns (uint256) {
        return 0;
    }

    function getTotalCollateralValue() external pure override returns (uint256) {
        return 0;
    }

    function getUserCollateralAssets(address) external pure override returns (address[] memory) {
        return new address[](0);
    }

    function getAssetValue(address, uint256 amount) external pure override returns (uint256) {
        return amount;
    }
}





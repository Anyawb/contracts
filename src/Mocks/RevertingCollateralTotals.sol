// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RevertingCollateralTotals
/// @notice Test helper used as a "bad valuation source" / "bad CM ledger source".
/// @dev This mock is intentionally NOT an ICollateralManager implementation.
///      - When registered as KEY_POSITION_VIEW, it makes `getUserTotalCollateralValue()` revert (HealthPushFailed path).
///      - When registered as KEY_CM, PositionView's CM reads will revert (best-effort fallback to 0).
contract RevertingCollateralTotals {
    // --- PositionView valuation interface ---
    function getUserTotalCollateralValue(address) external pure returns (uint256) {
        revert("revert-totalCollateral");
    }

    function getAssetValue(address, uint256) external pure returns (uint256) {
        revert("revert-assetValue");
    }

    // --- CollateralManager ledger reads used by PositionView ---
    function getUserCollateralAssets(address) external pure returns (address[] memory) {
        revert("revert-userAssets");
    }

    function getCollateral(address, address) external pure returns (uint256) {
        revert("revert-collateral");
    }
}





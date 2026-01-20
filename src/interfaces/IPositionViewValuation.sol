// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPositionViewValuation
/// @notice Canonical valuation interface exposed by PositionView (view-layer valuation).
/// @dev This interface exists to avoid ad-hoc local interfaces and low-level staticcall usage.
interface IPositionViewValuation {
    /// @notice Get user's total collateral value (settlement token units).
    function getUserTotalCollateralValue(address user) external view returns (uint256 totalValue);

    /// @notice Get system total collateral value (settlement token units).
    function getTotalCollateralValue() external view returns (uint256 totalValue);

    /// @notice Get value of an asset amount (settlement token units).
    function getAssetValue(address asset, uint256 amount) external view returns (uint256 value);
}


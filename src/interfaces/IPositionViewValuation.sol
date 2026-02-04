// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPositionViewValuation
/// @notice Canonical valuation interface exposed by PositionView (view-layer valuation).
/// @dev This interface exists to avoid ad-hoc local interfaces and low-level staticcall usage.
interface IPositionViewValuation {
    /*━━━━━━━━━━━━━━━ Valuation Functions ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get a user's total collateral value (USD-8).
     * @dev Reverts if:
     *      - registry reference is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_VIEW_RISK_DATA and is not admin (MissingRole)
     *      - user is zero address (ZeroAddress)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA (admin bypass)
     * - Best-effort: returns 0 if dependent modules or oracle calls fail
     *
     * @param user Target user address.
     * @return totalValue Total collateral value (USD-8).
     */
    function getUserTotalCollateralValue(address user) external view returns (uint256 totalValue);

    /**
     * @notice Get system total collateral value (USD-8).
     * @dev Reverts if:
     *      - registry reference is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_VIEW_RISK_DATA and is not admin (MissingRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA (admin bypass)
     * - Best-effort: returns 0 if dependent modules or oracle calls fail
     *
     * @return totalValue Total collateral value (USD-8).
     */
    function getTotalCollateralValue() external view returns (uint256 totalValue);

    /**
     * @notice Get USD-8 value of an asset amount.
     * @dev Reverts if:
     *      - registry reference is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_VIEW_RISK_DATA and is not admin (MissingRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA (admin bypass)
     * - Best-effort: returns 0 if asset/amount is zero or oracle call fails
     *
     * @param asset Asset address.
     * @param amount Asset amount (token decimals).
     * @return value Value in USD-8.
     */
    function getAssetValue(address asset, uint256 amount) external view returns (uint256 value);
}


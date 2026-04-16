// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPositionViewValuation
 * @notice Canonical valuation interface exposed by PositionView.
 * @dev Reverts if:
 *      - the PositionView implementation rejects caller permissions for risk-sensitive reads
 *      - the PositionView implementation detects invalid registry or asset inputs
 *
 * Security:
 * - View-only valuation surface intended to replace ad-hoc local interfaces and low-level `staticcall` usage.
 * - Consumers should preserve the implementation's caller-gating assumptions for risk data access.
 */
interface IPositionViewValuation {
    /*━━━━━━━━━━━━━━━ Valuation Functions ━━━━━━━━━━━━━━━*/
    /**
    * @notice Get a user's total collateral value in the normalized system valuation unit.
     * @dev Reverts if:
     *      - registry reference is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_VIEW_RISK_DATA and is not admin (MissingRole)
     *      - user is zero address (ZeroAddress)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA (admin bypass)
     * - Graceful degradation: returns 0 if dependent modules or oracle calls fail
     *
     * @param user Target user address.
    * @return totalValue Total collateral value normalized to 18 decimals.
     */
    function getUserTotalCollateralValue(
        address user
    ) external view returns (uint256 totalValue);

    /**
    * @notice Get system total collateral value in the normalized system valuation unit.
     * @dev Reverts if:
     *      - registry reference is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_VIEW_RISK_DATA and is not admin (MissingRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA (admin bypass)
     * - Graceful degradation: returns 0 if dependent modules or oracle calls fail
     *
    * @return totalValue Total collateral value normalized to 18 decimals.
     */
    function getTotalCollateralValue()
        external
        view
        returns (uint256 totalValue);

    /**
    * @notice Get the value of an asset amount in the normalized system valuation unit.
     * @dev Reverts if:
     *      - registry reference is invalid (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_VIEW_RISK_DATA and is not admin (MissingRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_RISK_DATA (admin bypass)
     * - Graceful degradation: returns 0 if asset, amount, or oracle reads are invalid
     *
     * @param asset Asset address.
     * @param amount Asset amount (token decimals).
    * @return value Value normalized to 18 decimals.
     */
    function getAssetValue(
        address asset,
        uint256 amount
    ) external view returns (uint256 value);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationEventsView
 * @notice View interface for receiving business-side (liquidation) push notifications and forwarding to unified DataPush stream
 * @dev Decoupled from query interface `ILiquidationView` to avoid forcing implementation of many read-only functions
 */
interface ILiquidationEventsView {
    /**
     * @notice Push single liquidation completion update (for off-chain and cache consumption)
     * @param user Liquidated user address
     * @param collateralAsset Seized collateral asset address
     * @param debtAsset Repaid debt asset address
     * @param collateralAmount Amount of seized collateral
     * @param debtAmount Amount of repaid debt
     * @param liquidator Liquidator address
     * @param bonus Actual liquidation bonus received
     * @param timestamp Block timestamp (in seconds)
     */
    function pushLiquidationUpdate(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        uint256 timestamp
    ) external;

    /**
     * @notice Push batch liquidation completion update (batch aggregation)
     * @param users Array of liquidated user addresses
     * @param collateralAssets Array of collateral asset addresses
     * @param debtAssets Array of debt asset addresses
     * @param collateralAmounts Array of seized collateral amounts
     * @param debtAmounts Array of repaid debt amounts
     * @param liquidator Liquidator address
     * @param bonuses Array of bonus amounts
     * @param timestamp Block timestamp (in seconds)
     */
    function pushBatchLiquidationUpdate(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        address liquidator,
        uint256[] calldata bonuses,
        uint256 timestamp
    ) external;

    /**
     * @notice Push liquidation residual value distribution update (optional extension)
     * @param user Liquidated user address
     * @param collateralAsset Seized collateral asset address
     * @param platform Platform revenue recipient address
     * @param reserve Risk reserve recipient address
     * @param lender Lender compensation recipient address
     * @param liquidator Liquidator address
     * @param platformShare Platform distribution share
     * @param reserveShare Reserve distribution share
     * @param lenderShare Lender compensation distribution share
     * @param liquidatorShare Liquidator distribution share
     * @param timestamp Block timestamp (in seconds)
     */
    function pushLiquidationPayout(
        address user,
        address collateralAsset,
        address platform,
        address reserve,
        address lender,
        address liquidator,
        uint256 platformShare,
        uint256 reserveShare,
        uint256 lenderShare,
        uint256 liquidatorShare,
        uint256 timestamp
    ) external;
}



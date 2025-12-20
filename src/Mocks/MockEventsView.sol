// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockEventsView
/// @notice Minimal view sink for liquidation push tests
contract MockEventsView {
    event Pushed(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus
    );

    bool public shouldRevert;

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function pushLiquidationUpdate(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        uint256 /* timestamp */
    ) external {
        if (shouldRevert) revert("events-view-revert");
        emit Pushed(user, collateralAsset, debtAsset, collateralAmount, debtAmount, liquidator, bonus);
    }
}






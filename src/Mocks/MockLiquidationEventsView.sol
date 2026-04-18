// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ILiquidationEventsView} from "../interfaces/ILiquidationEventsView.sol";

/// @title MockLiquidationEventsView
/// @notice Mock liquidation events view used in tests.
contract MockLiquidationEventsView is ILiquidationEventsView {
    // Liquidation statistics.
    mapping(address => uint256) private _userLiquidationCount;
    mapping(address => uint256) private _liquidatorTotalBonus;
    uint256 private _totalLiquidations;

    // Events.
    event MockLiquidationEventPushed(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        uint256 blockNumber
    );

    event MockBatchLiquidationEventPushed(
        address[] users,
        address[] collateralAssets,
        address[] debtAssets,
        uint256[] collateralAmounts,
        uint256[] debtAmounts,
        address liquidator,
        uint256[] bonuses,
        uint256 blockNumber
    );

    /// @notice Pushes a single liquidation update.
    /// @param user Liquidated user.
    /// @param collateralAsset Seized collateral asset.
    /// @param debtAsset Repaid debt asset.
    /// @param collateralAmount Seized collateral amount.
    /// @param debtAmount Repaid debt amount.
    /// @param liquidator Liquidator address.
    /// @param bonus Liquidation bonus received.
    /// @param blockNumber Block number.
    function pushLiquidationUpdate(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        uint256 blockNumber
    ) external override {
        _userLiquidationCount[user]++;
        _liquidatorTotalBonus[liquidator] += bonus;
        _totalLiquidations++;

        emit MockLiquidationEventPushed(
            user,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            liquidator,
            bonus,
            blockNumber
        );
    }

    /// @notice Pushes batch liquidation updates.
    /// @param users Liquidated user array.
    /// @param collateralAssets Collateral asset array.
    /// @param debtAssets Debt asset array.
    /// @param collateralAmounts Seized collateral amount array.
    /// @param debtAmounts Repaid debt amount array.
    /// @param liquidator Liquidator address.
    /// @param bonuses Bonus array.
    /// @param blockNumber Block number.
    function pushBatchLiquidationUpdate(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        address liquidator,
        uint256[] calldata bonuses,
        uint256 blockNumber
    ) external override {
        for (uint256 i = 0; i < users.length; i++) {
            _userLiquidationCount[users[i]]++;
            _liquidatorTotalBonus[liquidator] += bonuses[i];
            _totalLiquidations++;
        }

        emit MockBatchLiquidationEventPushed(
            users,
            collateralAssets,
            debtAssets,
            collateralAmounts,
            debtAmounts,
            liquidator,
            bonuses,
            blockNumber
        );
    }

    function pushLiquidationPayout(
        address,
        address,
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) external pure override {
        // no-op for mock
        uint256 noop = 0;
        noop;
    }

    /*━━━━━━━━━━━━━━━ Test Helpers ━━━━━━━━━━━━━━━*/
    /// @notice Returns the liquidation count for a user.
    /// @param user User address.
    /// @return Liquidation count.
    function getUserLiquidationCount(
        address user
    ) external view returns (uint256) {
        return _userLiquidationCount[user];
    }

    /// @notice Returns the total bonus tracked for a liquidator.
    /// @param liquidator Liquidator address.
    /// @return Total bonus.
    function getLiquidatorTotalBonus(
        address liquidator
    ) external view returns (uint256) {
        return _liquidatorTotalBonus[liquidator];
    }

    /// @notice Returns the total liquidation count.
    /// @return Total liquidation count.
    function getTotalLiquidations() external view returns (uint256) {
        return _totalLiquidations;
    }
}

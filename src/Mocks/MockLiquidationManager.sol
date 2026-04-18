// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ILiquidationManager} from "../interfaces/ILiquidationManager.sol";

/// @title MockLiquidationManager
/// @notice Mock liquidation manager implementation for tests.
contract MockLiquidationManager is ILiquidationManager {
    // Liquidation configuration.
    uint256 private _liquidationBonusRate = 500; // 5% liquidation bonus.
    uint256 private _liquidationThreshold = 11000; // 110% liquidation threshold.

    // Liquidation statistics.
    mapping(address => uint256) private _userLiquidationCount;
    mapping(address => uint256) private _liquidatorTotalBonus;
    uint256 private _totalLiquidations;
    bool private _revertSettlementPath;

    // Events.
    event MockLiquidationExecuted(
        address indexed liquidator,
        address indexed user,
        address indexed collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus,
        uint256 blockNumber
    );

    error MockLiquidationManager__ForcedSettlementRevert();

    /// @notice Executes a mock liquidation.
    /// @dev The mock only validates input and updates counters and events.
    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external override {
        require(targetUser != address(0), "Invalid user address");
        require(collateralAsset != address(0), "Invalid collateral asset");
        require(debtAsset != address(0), "Invalid debt asset");
        require(collateralAmount > 0, "Invalid collateral amount");
        require(debtAmount > 0, "Invalid debt amount");

        // Compute the liquidation bonus when not provided.
        if (bonus == 0) {
            bonus = (debtAmount * _liquidationBonusRate) / 10000;
        }

        // Update counters.
        _userLiquidationCount[targetUser]++;
        _liquidatorTotalBonus[msg.sender] += bonus;
        _totalLiquidations++;

        // Emit the liquidation event.
        emit MockLiquidationExecuted(
            msg.sender,
            targetUser,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            bonus,
            block.number
        );
    }

    /// @notice Executes a mock liquidation through the settlement-manager path.
    /// @dev Preserves the explicit liquidator argument to match SSOT orchestration.
    function liquidateFromSettlementManager(
        address liquidator,
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external override {
        if (_revertSettlementPath)
            revert MockLiquidationManager__ForcedSettlementRevert();
        require(liquidator != address(0), "Invalid liquidator");
        require(targetUser != address(0), "Invalid user address");
        require(collateralAsset != address(0), "Invalid collateral asset");
        require(debtAsset != address(0), "Invalid debt asset");
        require(collateralAmount > 0, "Invalid collateral amount");
        require(debtAmount > 0, "Invalid debt amount");

        if (bonus == 0) {
            bonus = (debtAmount * _liquidationBonusRate) / 10000;
        }

        _userLiquidationCount[targetUser]++;
        _liquidatorTotalBonus[liquidator] += bonus;
        _totalLiquidations++;

        emit MockLiquidationExecuted(
            liquidator,
            targetUser,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            bonus,
            block.number
        );
    }

    /// @notice Executes batch mock liquidations.
    /// @param targetUsers Liquidated user address array.
    /// @param collateralAssets Collateral asset address array.
    /// @param debtAssets Debt asset address array.
    /// @param collateralAmounts Collateral liquidation amount array.
    /// @param debtAmounts Debt liquidation amount array.
    /// @param bonuses Bonus array, where zero means use the default formula.
    function batchLiquidate(
        address[] calldata targetUsers,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        uint256[] calldata bonuses
    ) external override {
        require(
            targetUsers.length == collateralAssets.length &&
                targetUsers.length == debtAssets.length &&
                targetUsers.length == collateralAmounts.length &&
                targetUsers.length == debtAmounts.length &&
                targetUsers.length == bonuses.length,
            "Length mismatch"
        );
        for (uint256 i = 0; i < targetUsers.length; i++) {
            uint256 b = bonuses[i];
            if (b == 0) {
                b = (debtAmounts[i] * _liquidationBonusRate) / 10000;
            }
            // Reuse single-operation validation without changing msg.sender.
            require(targetUsers[i] != address(0), "Invalid user address");
            require(
                collateralAssets[i] != address(0),
                "Invalid collateral asset"
            );
            require(debtAssets[i] != address(0), "Invalid debt asset");
            require(collateralAmounts[i] > 0, "Invalid collateral amount");
            require(debtAmounts[i] > 0, "Invalid debt amount");

            _userLiquidationCount[targetUsers[i]]++;
            _liquidatorTotalBonus[msg.sender] += b;
            _totalLiquidations++;

            emit MockLiquidationExecuted(
                msg.sender,
                targetUsers[i],
                collateralAssets[i],
                debtAssets[i],
                collateralAmounts[i],
                debtAmounts[i],
                b,
                block.number
            );
        }
    }

    /*━━━━━━━━━━━━━━━ Test Helpers ━━━━━━━━━━━━━━━*/
    /// @notice Sets the liquidation bonus rate.
    /// @param bonusRate New bonus rate.
    function setLiquidationBonusRate(uint256 bonusRate) external {
        _liquidationBonusRate = bonusRate;
    }

    /// @notice Sets the liquidation threshold.
    /// @param threshold New liquidation threshold.
    function setLiquidationThreshold(uint256 threshold) external {
        _liquidationThreshold = threshold;
    }

    function setRevertSettlementPath(bool shouldRevert) external {
        _revertSettlementPath = shouldRevert;
    }

    /// @notice Returns the liquidation count for a user.
    /// @param user User address.
    /// @return count Liquidation count.
    function getUserLiquidationCount(
        address user
    ) external view returns (uint256 count) {
        return _userLiquidationCount[user];
    }

    /// @notice Returns the total bonus tracked for a liquidator.
    /// @param liquidator Liquidator address.
    /// @return totalBonus Total bonus amount.
    function getLiquidatorTotalBonus(
        address liquidator
    ) external view returns (uint256 totalBonus) {
        return _liquidatorTotalBonus[liquidator];
    }

    /// @notice Returns the total liquidation count.
    /// @return totalLiquidations Total liquidation count.
    function getTotalLiquidations()
        external
        view
        returns (uint256 totalLiquidations)
    {
        return _totalLiquidations;
    }
}

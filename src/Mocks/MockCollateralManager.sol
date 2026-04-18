// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ICollateralManager} from "../interfaces/ICollateralManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPositionViewPush {
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt
    ) external;
}

/// @title MockCollateralManager
/// @notice Mock collateral manager implementation for tests.
contract MockCollateralManager is ICollateralManager {
    using SafeERC20 for IERC20;
    // User collateral storage.
    mapping(address => mapping(address => uint256)) private _userCollateral;
    mapping(address => uint256) private _totalByAsset;
    mapping(address => address[]) private _userAssets;

    // Test control flag.
    bool public shouldFail;

    // Events.
    event CollateralDeposited(
        address indexed user,
        address indexed asset,
        uint256 amount
    );
    event CollateralWithdrawn(
        address indexed user,
        address indexed asset,
        uint256 amount
    );

    /// @notice Records a collateral deposit.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Deposit amount.
    function depositCollateral(
        address user,
        address asset,
        uint256 amount
    ) external override {
        if (shouldFail) revert("MCM: deposit fail");
        _userCollateral[user][asset] += amount;
        _totalByAsset[asset] += amount;
        _addAsset(user, asset);
        emit CollateralDeposited(user, asset, amount);
    }

    /// @notice Records a collateral withdrawal.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Withdrawal amount.
    function withdrawCollateral(
        address user,
        address asset,
        uint256 amount
    ) external override {
        if (shouldFail) revert("MCM: withdraw fail");
        require(
            _userCollateral[user][asset] >= amount,
            "Insufficient collateral"
        );
        _userCollateral[user][asset] -= amount;
        _totalByAsset[asset] -= amount;
        emit CollateralWithdrawn(user, asset, amount);
    }

    function withdrawCollateralTo(
        address user,
        address asset,
        uint256 amount,
        address receiver
    ) external override {
        if (shouldFail) revert("MCM: withdraw fail");
        require(
            _userCollateral[user][asset] >= amount,
            "Insufficient collateral"
        );
        _userCollateral[user][asset] -= amount;
        _totalByAsset[asset] -= amount;
        if (asset.code.length > 0) {
            IERC20(asset).safeTransfer(receiver, amount);
        }
        emit CollateralWithdrawn(user, asset, amount);
    }

    /// @notice Returns collateral for a user and asset.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return Collateral amount.
    function getCollateral(
        address user,
        address asset
    ) external view override returns (uint256) {
        if (shouldFail) revert("MCM: get fail");
        return _userCollateral[user][asset];
    }

    /// @notice Returns total collateral tracked for an asset.
    /// @param asset Asset address.
    /// @return Total collateral amount.
    function getTotalCollateralByAsset(
        address asset
    ) external view override returns (uint256) {
        return _totalByAsset[asset];
    }

    /// @notice Test helper that overrides the total collateral tracked for an asset.
    function setTotalCollateralByAsset(address asset, uint256 amount) external {
        _totalByAsset[asset] = amount;
    }

    /// @notice Returns the collateral-asset list tracked for a user.
    /// @param _user User address.
    /// @return Asset address array.
    function getUserCollateralAssets(
        address _user
    ) external view override returns (address[] memory) {
        return _userAssets[_user];
    }

    /// @notice Compatibility helper that returns user collateral for an asset.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return Collateral amount.
    function getUserCollateral(
        address user,
        address asset
    ) external view returns (uint256) {
        return _userCollateral[user][asset];
    }

    /// @notice Returns whether a user has at least the requested collateral amount.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Required amount.
    /// @return True when the user has sufficient collateral.
    function hasSufficientCollateral(
        address user,
        address asset,
        uint256 amount
    ) external view returns (bool) {
        return _userCollateral[user][asset] >= amount;
    }

    /// @notice Seizes collateral for liquidation flows.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Requested seizure amount.
    /// @param liquidator Liquidator address.
    /// @return seizedAmount Actual seized amount.
    function seizeCollateral(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external returns (uint256 seizedAmount) {
        require(user != address(0), "Invalid user address");
        require(asset != address(0), "Invalid asset address");
        require(amount > 0, "Invalid amount");
        require(liquidator != address(0), "Invalid liquidator address");

        uint256 availableCollateral = _userCollateral[user][asset];
        seizedAmount = amount > availableCollateral
            ? availableCollateral
            : amount;

        if (seizedAmount > 0) {
            _userCollateral[user][asset] -= seizedAmount;
            _totalByAsset[asset] -= seizedAmount;

            // Emit the collateral seizure event.
            emit CollateralSeized(
                liquidator,
                user,
                asset,
                seizedAmount,
                block.number
            );
        }

        return seizedAmount;
    }

    /// @notice Returns the amount of collateral that can be seized.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return seizableAmount Seizable amount.
    function getSeizableCollateralAmount(
        address user,
        address asset
    ) external view returns (uint256 seizableAmount) {
        return _userCollateral[user][asset];
    }

    /// @notice Test helper that overrides a user's collateral amount.
    function setUserCollateral(
        address user,
        address asset,
        uint256 amount
    ) external {
        _userCollateral[user][asset] = amount;
        _totalByAsset[asset] = amount;
        _addAsset(user, asset);
    }

    function _addAsset(address user, address asset) private {
        address[] storage assets = _userAssets[user];
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == asset) {
                return;
            }
        }
        assets.push(asset);
    }

    // Events.
    event CollateralSeized(
        address indexed liquidator,
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /// @notice Sets whether mock operations should fail.
    /// @param fail True when operations should fail.
    function setShouldFail(bool fail) external {
        shouldFail = fail;
    }

    /// @notice Test helper that pushes PositionView cache updates through this contract.
    function pushToPositionView(
        address positionView,
        address user,
        address asset,
        uint256 collateral,
        uint256 debt
    ) external {
        IPositionViewPush(positionView).pushUserPositionUpdate(
            user,
            asset,
            collateral,
            debt
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ILendingEngineBasic} from "../interfaces/ILendingEngineBasic.sol";

/// @title MockLendingEngineBasic
/// @notice Mock lending engine implementation for tests.
contract MockLendingEngineBasic is ILendingEngineBasic {
    // User debt storage.
    mapping(address => mapping(address => uint256)) private _userDebt;
    mapping(address => uint256) private _totalByAsset;
    mapping(address => uint256) private _userTotalValue;
    uint256 private _totalValue;
    mapping(address => address[]) private _userDebtAssets;
    mapping(address => mapping(address => uint256))
        private _userDebtAssetIndexPlusOne;

    // Test control flag.
    bool public mockSuccess = true;

    // Events.
    event BorrowRecorded(
        address indexed user,
        address indexed asset,
        uint256 amount
    );
    event RepayRecorded(
        address indexed user,
        address indexed asset,
        uint256 amount
    );

    /// @notice Records a borrow operation.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Borrow amount.
    /// @param collateralAdded Collateral increment.
    /// @param termDays Loan term in days.
    function borrow(
        address user,
        address asset,
        uint256 amount,
        uint256 collateralAdded,
        uint16 termDays
    ) external override {
        if (!mockSuccess) revert("MockLendingEngine: borrow failed");
        // Parameters are unused in this mock but preserved for interface compatibility.
        collateralAdded;
        termDays;
        if (_userDebt[user][asset] == 0) {
            _addDebtAsset(user, asset);
        }
        _userDebt[user][asset] += amount;
        _totalByAsset[asset] += amount;
        _userTotalValue[user] += amount;
        _totalValue += amount;
        emit BorrowRecorded(user, asset, amount);
    }

    /// @notice Records a repayment operation.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Repayment amount.
    function repay(
        address user,
        address asset,
        uint256 amount
    ) external override {
        if (!mockSuccess) revert("MockLendingEngine: repay failed");
        require(_userDebt[user][asset] >= amount, "Insufficient debt");
        _userDebt[user][asset] -= amount;
        if (_userDebt[user][asset] == 0) {
            _removeDebtAsset(user, asset);
        }
        _totalByAsset[asset] = _totalByAsset[asset] >= amount
            ? _totalByAsset[asset] - amount
            : 0;
        _userTotalValue[user] = _userTotalValue[user] > amount
            ? _userTotalValue[user] - amount
            : 0;
        _totalValue = _totalValue > amount ? _totalValue - amount : 0;
        emit RepayRecorded(user, asset, amount);
    }

    /// @notice Force-reduces user debt.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Reduction amount.
    function forceReduceDebt(
        address user,
        address asset,
        uint256 amount
    ) external override {
        uint256 currentDebt = _userDebt[user][asset];
        // For liquidation, insufficient debt should revert (matches typical engine behavior and helps test atomicity)
        require(currentDebt >= amount, "Insufficient debt");
        _userDebt[user][asset] = currentDebt - amount;
        if (_userDebt[user][asset] == 0) {
            _removeDebtAsset(user, asset);
        }
        _totalByAsset[asset] -= amount;
        _userTotalValue[user] = _userTotalValue[user] > amount
            ? _userTotalValue[user] - amount
            : 0;
        _totalValue = _totalValue > amount ? _totalValue - amount : 0;
        emit RepayRecorded(user, asset, amount);
    }

    /// @notice Returns user debt for an asset.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return Debt amount.
    function getDebt(
        address user,
        address asset
    ) external view override returns (uint256) {
        if (!mockSuccess) revert("MLE: get debt fail");
        return _userDebt[user][asset];
    }

    /// @notice Returns total debt tracked for an asset.
    /// @param asset Asset address.
    /// @return Total debt amount.
    function getTotalDebtByAsset(
        address asset
    ) external view override returns (uint256) {
        return _totalByAsset[asset];
    }

    /// @notice Test helper that overrides the total debt tracked for an asset.
    function setTotalDebtByAsset(address asset, uint256 amount) external {
        _totalByAsset[asset] = amount;
    }

    /// @notice Returns the cached total debt value for a user.
    /// @param user User address.
    /// @return Total debt value.
    function getUserTotalDebtValue(
        address user
    ) external view override returns (uint256) {
        return _userTotalValue[user];
    }

    function getUserTotalDebtValueBestEffort(
        address user
    ) external view override returns (uint256) {
        return _userTotalValue[user];
    }

    function getUserTotalDebtValueStrict(
        address user
    ) external view override returns (uint256) {
        return _userTotalValue[user];
    }

    /// @notice Returns the cached total debt value across all users.
    /// @return Total debt value.
    function getTotalDebtValue() external view override returns (uint256) {
        return _totalValue;
    }

    /// @notice Returns the debt-asset list tracked for a user.
    /// @param user User address.
    /// @return Asset address array.
    function getUserDebtAssets(
        address user
    ) external view override returns (address[] memory) {
        address[] memory assets = _userDebtAssets[user];
        return assets;
    }

    /// @notice Returns the mock expected interest.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Principal amount.
    /// @return Expected interest amount.
    function calculateExpectedInterest(
        address user,
        address asset,
        uint256 amount
    ) external pure override returns (uint256) {
        // Mock implementation always returns zero while preserving interface compatibility.
        user;
        asset;
        amount;
        return 0;
    }

    /// @notice Returns the reducible debt amount for a user and asset.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return Reducible debt amount.
    function getReducibleDebtAmount(
        address user,
        address asset
    ) external view override returns (uint256) {
        return _userDebt[user][asset];
    }

    /// @notice Returns the mock debt value for a user and asset.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return Debt value.
    function calculateDebtValue(
        address user,
        address asset
    ) external view virtual override returns (uint256) {
        return _userDebt[user][asset];
    }

    function calculateDebtValueBestEffort(
        address user,
        address asset
    ) external view virtual override returns (uint256) {
        return _userDebt[user][asset];
    }

    function calculateDebtValueStrict(
        address user,
        address asset
    ) external view virtual override returns (uint256) {
        return _userDebt[user][asset];
    }

    /// @notice Compatibility helper that returns user debt for an asset.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return Debt amount.
    function getUserDebt(
        address user,
        address asset
    ) external view returns (uint256) {
        return _userDebt[user][asset];
    }

    /// @notice Returns whether a user has debt for an asset.
    /// @param user User address.
    /// @param asset Asset address.
    /// @return True when debt is greater than zero.
    function hasDebt(address user, address asset) external view returns (bool) {
        return _userDebt[user][asset] > 0;
    }

    /// @notice Sets a user's debt amount for tests.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Debt amount.
    function setUserDebt(address user, address asset, uint256 amount) external {
        // Keep derived totals consistent with _userDebt, since production paths
        // rely on getUserTotalDebtValue() for collateral release decisions.
        uint256 prev = _userDebt[user][asset];
        if (prev == 0 && amount > 0) {
            _addDebtAsset(user, asset);
        } else if (prev > 0 && amount == 0) {
            _removeDebtAsset(user, asset);
        }
        _userDebt[user][asset] = amount;

        if (amount >= prev) {
            uint256 delta = amount - prev;
            _totalByAsset[asset] += delta;
            _userTotalValue[user] += delta;
            _totalValue += delta;
        } else {
            uint256 delta = prev - amount;
            _totalByAsset[asset] = _totalByAsset[asset] >= delta
                ? _totalByAsset[asset] - delta
                : 0;
            _userTotalValue[user] = _userTotalValue[user] >= delta
                ? _userTotalValue[user] - delta
                : 0;
            _totalValue = _totalValue >= delta ? _totalValue - delta : 0;
        }
    }

    /// @notice Sets the cached total debt value for test scenarios.
    function setUserTotalDebtValue(address user, uint256 amount) external {
        uint256 prev = _userTotalValue[user];
        _userTotalValue[user] = amount;
        if (amount >= prev) {
            _totalValue += (amount - prev);
        } else {
            _totalValue -= (prev - amount);
        }
    }

    /// @notice Force-reduces debt while recording the liquidator.
    /// @param user User address.
    /// @param asset Asset address.
    /// @param amount Reduction amount.
    /// @param liquidator Liquidator address.
    /// @return reducedAmount Actual reduced amount.
    function forceReduceDebtWithLiquidator(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external returns (uint256 reducedAmount) {
        require(user != address(0), "Invalid user address");
        require(asset != address(0), "Invalid asset address");
        require(amount > 0, "Invalid amount");
        require(liquidator != address(0), "Invalid liquidator address");

        uint256 currentDebt = _userDebt[user][asset];
        reducedAmount = amount > currentDebt ? currentDebt : amount;

        if (reducedAmount > 0) {
            _userDebt[user][asset] -= reducedAmount;
            _totalByAsset[asset] -= reducedAmount;
            _userTotalValue[user] = _userTotalValue[user] > reducedAmount
                ? _userTotalValue[user] - reducedAmount
                : 0;
            _totalValue = _totalValue > reducedAmount
                ? _totalValue - reducedAmount
                : 0;

            // Emit the liquidation debt-reduction event.
            emit DebtReduced(
                liquidator,
                user,
                asset,
                reducedAmount,
                block.number
            );
        }

        return reducedAmount;
    }

    // Events.
    event DebtReduced(
        address indexed liquidator,
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 blockNumber
    );

    /// @notice Sets whether mock operations succeed.
    /// @param success True when operations should succeed.
    function setMockSuccess(bool success) external {
        mockSuccess = success;
    }

    function _addDebtAsset(address user, address asset) internal {
        if (_userDebtAssetIndexPlusOne[user][asset] != 0) {
            return;
        }
        _userDebtAssets[user].push(asset);
        _userDebtAssetIndexPlusOne[user][asset] = _userDebtAssets[user].length;
    }

    function _removeDebtAsset(address user, address asset) internal {
        uint256 indexPlusOne = _userDebtAssetIndexPlusOne[user][asset];
        if (indexPlusOne == 0) {
            return;
        }
        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = _userDebtAssets[user].length - 1;
        if (index != lastIndex) {
            address lastAsset = _userDebtAssets[user][lastIndex];
            _userDebtAssets[user][index] = lastAsset;
            _userDebtAssetIndexPlusOne[user][lastAsset] = index + 1;
        }
        _userDebtAssets[user].pop();
        delete _userDebtAssetIndexPlusOne[user][asset];
    }
}

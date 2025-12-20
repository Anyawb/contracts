// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { AmountIsZero, Overpay, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { VaultTypes } from "../../VaultTypes.sol";
import { LendingEngineStorage } from "./LendingEngineStorage.sol";
import { LendingEngineValuation } from "./LendingEngineValuation.sol";

/// @notice Debt accounting helpers for VaultLendingEngine
library LendingEngineAccounting {
    using LendingEngineStorage for LendingEngineStorage.Layout;

    event DebtRecorded(address indexed user, address indexed asset, uint256 amount, bool isBorrow);

    /// @notice 记录借款并更新估值
    function recordBorrow(LendingEngineStorage.Layout storage s, address user, address asset, uint256 amount) internal {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();
        if (user == address(0)) revert ZeroAddress();

        uint256 oldDebt = s._userDebt[user][asset];
        s._userDebt[user][asset] = oldDebt + amount;
        s._totalDebtByAsset[asset] += amount;

        if (oldDebt == 0) {
            _addUserDebtAsset(s, user, asset);
        }

        LendingEngineValuation.updateUserTotalDebtValue(s, user);

        emit DebtRecorded(user, asset, amount, true);
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 记录还款并更新估值
    function recordRepay(LendingEngineStorage.Layout storage s, address user, address asset, uint256 amount) internal {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();
        if (user == address(0)) revert ZeroAddress();

        uint256 debt = s._userDebt[user][asset];
        if (debt < amount) revert Overpay();

        s._userDebt[user][asset] = debt - amount;
        s._totalDebtByAsset[asset] -= amount;

        if (s._userDebt[user][asset] == 0) {
            _removeUserDebtAsset(s, user, asset);
        }

        LendingEngineValuation.updateUserTotalDebtValue(s, user);

        emit DebtRecorded(user, asset, amount, false);
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_REPAY,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REPAY),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 清算/强制减债并更新估值
    function recordForceReduceDebt(LendingEngineStorage.Layout storage s, address user, address asset, uint256 amount)
        internal
        returns (uint256 reducedAmount)
    {
        if (asset == address(0)) revert ZeroAddress();
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        uint256 debt = s._userDebt[user][asset];
        if (amount > debt) amount = debt;

        s._userDebt[user][asset] = debt - amount;
        s._totalDebtByAsset[asset] -= amount;

        if (s._userDebt[user][asset] == 0) {
            _removeUserDebtAsset(s, user, asset);
        }

        LendingEngineValuation.updateUserTotalDebtValue(s, user);

        emit DebtRecorded(user, asset, amount, false);
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
            msg.sender,
            block.timestamp
        );

        return amount;
    }

    /// @notice 添加用户债务资产到列表
    function _addUserDebtAsset(LendingEngineStorage.Layout storage s, address user, address asset) internal {
        uint256 index = s._userDebtAssetIndex[user][asset];
        if (index == 0) {
            s._userDebtAssets[user].push(asset);
            s._userDebtAssetIndex[user][asset] = s._userDebtAssets[user].length;
            s._userDebtAssetCount[user]++;
        }
    }

    /// @notice 从用户债务资产列表中移除资产
    function _removeUserDebtAsset(LendingEngineStorage.Layout storage s, address user, address asset) internal {
        uint256 index = s._userDebtAssetIndex[user][asset];
        if (index > 0) {
            uint256 lastIndex = s._userDebtAssets[user].length - 1;
            address lastAsset = s._userDebtAssets[user][lastIndex];

            s._userDebtAssets[user][index - 1] = lastAsset;
            s._userDebtAssetIndex[user][lastAsset] = index;

            s._userDebtAssets[user].pop();
            delete s._userDebtAssetIndex[user][asset];
            s._userDebtAssetCount[user]--;
        }
    }
}


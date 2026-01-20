// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { AmountIsZero, Overpay, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { SystemEvents } from "../../SystemEvents.sol";
import { LendingEngineStorage } from "./LendingEngineStorage.sol";
import { LendingEngineValuation } from "./LendingEngineValuation.sol";

/// @notice Debt accounting helpers for VaultLendingEngine.
library LendingEngineAccounting {
    using LendingEngineStorage for LendingEngineStorage.Layout;

    /// @notice Emitted when a user's debt for an asset is recorded (borrow/repay/liquidation debt change).
    /// @param user Borrower address.
    /// @param asset Debt asset address.
    /// @param amount Debt delta amount in `asset` token base units (token decimals).
    /// @param isBorrow True for borrow (increase debt), false for repay / debt reduction.
    event DebtRecorded(address indexed user, address indexed asset, uint256 amount, bool isBorrow);

    /**
     * @notice Record a borrow: increase debt balances and update cached valuation (ledger-side helper).
     * @dev Reverts if:
     *      - amount == 0 (AmountIsZero)
     *      - asset == address(0) (ZeroAddress)
     *      - user == address(0) (ZeroAddress)
     *      - valuation delta underflows system total (LendingEngineValuation__TotalDebtValueUnderflow) (propagated)
     *
     * Security:
     * - Ledger-first: state writes occur before any best-effort cache/view pushes (handled in higher layers).
     * - Emits standardized action events for observability.
     *
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @param amount Borrow amount in `asset` token base units (token decimals).
     */
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
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
            msg.sender,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );
    }

    /**
     * @notice Record a repay: decrease debt balances and update cached valuation (ledger-side helper).
     * @dev Reverts if:
     *      - amount == 0 (AmountIsZero)
     *      - asset == address(0) (ZeroAddress)
     *      - user == address(0) (ZeroAddress)
     *      - amount > current debt (Overpay)
     *      - valuation delta underflows system total (LendingEngineValuation__TotalDebtValueUnderflow) (propagated)
     *
     * Security:
     * - Ledger-first: state writes occur before any best-effort cache/view pushes (handled in higher layers).
     * - Emits standardized action events for observability.
     *
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @param amount Repay amount in `asset` token base units (token decimals).
     */
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
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_REPAY,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REPAY),
            msg.sender,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );
    }

    /**
     * @notice Record a forced debt reduction (liquidation path) and update cached valuation.
     * @dev Reverts if:
     *      - amount == 0 (AmountIsZero)
     *      - asset == address(0) (ZeroAddress)
     *      - user == address(0) (ZeroAddress)
     *      - valuation delta underflows system total (LendingEngineValuation__TotalDebtValueUnderflow) (propagated)
     *
     * Security:
     * - Amount is clamped to current debt (never underflows the user's asset debt).
     * - Emits standardized action events for observability.
     *
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @param amount Requested reduction amount in `asset` token base units (token decimals).
     * @return reducedAmount Actual reduced amount in `asset` token base units (token decimals).
     */
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
        emit SystemEvents.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
            msg.sender,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp
        );

        return amount;
    }

    /**
     * @notice Add an asset to a user's debt asset list (if not already present).
     * @dev Uses a 1-based index mapping (`index+1`) so 0 can represent "not present".
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     * @param asset Debt asset address.
     */
    function _addUserDebtAsset(LendingEngineStorage.Layout storage s, address user, address asset) internal {
        uint256 index = s._userDebtAssetIndex[user][asset];
        if (index == 0) {
            s._userDebtAssets[user].push(asset);
            s._userDebtAssetIndex[user][asset] = s._userDebtAssets[user].length;
            s._userDebtAssetCount[user]++;
        }
    }

    /**
     * @notice Remove an asset from a user's debt asset list (if present).
     * @dev Removal is done via swap-and-pop and updates the 1-based index mapping.
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     * @param asset Debt asset address.
     */
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


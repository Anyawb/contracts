// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILendingEngineDebtWrite
 * @notice Narrow debt-ledger write interface for authorized debt mutations.
 * @dev Reverts if:
 *      - the caller is not authorized by the implementation's module or role gates
 *      - `user`, `asset`, or amount inputs are invalid for the target mutation
 *      - the implementation rejects the requested ledger transition or downstream valuation update
 *
 * Security:
 * - Write-only surface for protocol modules that are allowed to mutate debt state.
 * - Consumers should depend on this interface instead of broader legacy lending-engine interfaces.
 * - Implementations are expected to treat ledger writes as the debt SSOT and handle view/cache updates separately.
 */
interface ILendingEngineDebtWrite {
    /**
     * @notice Records a borrow for `user` in `asset`.
     * @dev Reverts if:
     *      - the caller is not authorized to originate debt writes
     *      - `user` or `asset` is invalid
     *      - `amount` is zero or otherwise rejected by the implementation
     *      - the implementation rejects the resulting ledger or valuation update
     *
     * Security:
     * - Intended for trusted protocol modules such as VaultCore or orchestration layers.
     * - `collateralAdded` and `termDays` are advisory inputs whose semantics are implementation-defined.
     *
     * @param user Borrower address whose debt will increase.
     * @param asset Debt asset address.
     * @param amount Borrow amount in token base units.
     * @param collateralAdded Advisory collateral metadata passed through by higher-level flows.
     * @param termDays Loan term hint in days.
     */
    function borrow(
        address user,
        address asset,
        uint256 amount,
        uint256 collateralAdded,
        uint16 termDays
    ) external;

    /**
     * @notice Records a repayment for `user` in `asset`.
     * @dev Reverts if:
     *      - the caller is not authorized to reduce debt
     *      - `user` or `asset` is invalid
     *      - `amount` is zero, exceeds the allowed reduction, or otherwise violates implementation rules
     *      - the implementation rejects the resulting ledger or valuation update
     *
     * Security:
     * - Intended for trusted repay and settlement paths.
     * - Implementations may differentiate between ordinary repay and settlement-manager initiated repay flows.
     *
     * @param user Borrower address whose debt will decrease.
     * @param asset Debt asset address.
     * @param amount Repay amount in token base units.
     */
    function repay(address user, address asset, uint256 amount) external;

    /**
     * @notice Force-reduces `user` debt in `asset`, typically for liquidation or administrative settlement.
     * @dev Reverts if:
     *      - the caller is not authorized for forced debt reduction
     *      - `user` or `asset` is invalid
     *      - `amount` is zero or otherwise rejected by the implementation
     *      - the implementation rejects the liquidation or force-reduction transition
     *
     * Security:
     * - Intended for trusted liquidation executors or equivalent protocol modules.
     * - Consumers must not assume that the full requested `amount` is always applied; exact semantics are
     *   implementation-defined.
     *
     * @param user Borrower address whose debt will be force-reduced.
     * @param asset Debt asset address.
     * @param amount Requested reduction amount in token base units.
     */
    function forceReduceDebt(
        address user,
        address asset,
        uint256 amount
    ) external;
}

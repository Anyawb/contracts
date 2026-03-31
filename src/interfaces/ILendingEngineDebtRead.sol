// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILendingEngineDebtRead
 * @notice Narrow read-only debt-ledger interface for debt, valuation, and liquidation consumers.
 * @dev Reverts if:
 *      - protocol implementations receive an invalid registry context or zero-address subject/asset input
 *      - protocol implementations cannot satisfy the requested debt or valuation read
 *
 * Security:
 * - Read-only surface for view modules, valuation helpers, and risk checks.
 * - Callers should depend on this interface instead of broader lending-engine write surfaces.
 * - Value-returning methods are protocol-defined valuation reads and must not be assumed to equal token units unless
 *   explicitly documented by the implementation.
 */
interface ILendingEngineDebtRead {
    /**
     * @notice Returns the current debt balance for `user` in `asset` base units.
     * @dev Reverts if:
     *      - the protocol implementation rejects an invalid `user` or `asset`
     *      - the underlying debt-ledger read cannot be resolved
     *
     * Security:
     * - Pure read path; does not mutate debt state.
     * - Intended for valuation, liquidation, and UI consumers that need the ledger SSOT.
     *
     * @param user Borrower address being queried.
     * @param asset Debt asset address being queried.
     * @return debt Current debt amount in token base units.
     */
    function getDebt(
        address user,
        address asset
    ) external view returns (uint256 debt);

    /**
     * @notice Returns the protocol-wide outstanding debt for `asset` in token base units.
     * @dev Reverts if:
     *      - the protocol implementation rejects an invalid `asset`
     *      - the underlying total-debt read cannot be resolved
     *
     * Security:
     * - Pure read path for system debt aggregation.
     * - Consumers should treat this as the debt-ledger authority for the queried asset.
     *
     * @param asset Debt asset address being queried.
     * @return totalDebt Total outstanding debt for `asset` in token base units.
     */
    function getTotalDebtByAsset(
        address asset
    ) external view returns (uint256 totalDebt);

    /**
     * @notice Returns the cached total debt value for `user` in the implementation's valuation unit.
     * @dev Reverts if:
     *      - the protocol implementation rejects an invalid `user`
     *      - the cached valuation read cannot be resolved
     *
     * Security:
     * - Read-only valuation helper.
     * - The returned unit is implementation-defined and may depend on protocol pricing SSOT.
     *
     * @param user Borrower address being queried.
     * @return totalValue Cached total debt value for `user`.
     */
    function getUserTotalDebtValue(
        address user
    ) external view returns (uint256 totalValue);

    /**
     * @notice Returns the cached protocol-wide total debt value in the implementation's valuation unit.
     * @dev Reverts if:
     *      - the protocol implementation cannot resolve the cached system valuation
     *
     * Security:
     * - Read-only aggregation helper.
     * - The returned unit is implementation-defined and typically follows the protocol valuation SSOT.
     *
     * @return totalValue Cached system-wide debt valuation.
     */
    function getTotalDebtValue() external view returns (uint256 totalValue);

    /**
     * @notice Returns the list of assets for which `user` currently has tracked debt.
     * @dev Reverts if:
     *      - the protocol implementation rejects an invalid `user`
     *      - the debt-asset enumeration cannot be resolved
     *
     * Security:
     * - Read-only enumeration helper.
     * - Ordering is implementation-defined and should not be assumed stable across mutations.
     *
     * @param user Borrower address being queried.
     * @return assets Asset list associated with the user's non-zero debt positions.
     */
    function getUserDebtAssets(
        address user
    ) external view returns (address[] memory assets);

    /**
     * @notice Estimates the expected interest for adding `amount` debt of `asset` to `user`.
     * @dev Reverts if:
     *      - the protocol implementation rejects an invalid `asset`
     *      - the expected-interest model cannot be evaluated
     *
     * Security:
     * - Read-only estimation helper.
     * - Return semantics are implementation-defined and MUST NOT be treated as settled interest without confirming the
     *   implementation's pricing and term model.
     *
     * @param user Borrower address used by the implementation's rate model.
     * @param asset Debt asset address being evaluated.
     * @param amount Principal amount in token base units.
     * @return interest Estimated interest amount in token base units.
     */
    function calculateExpectedInterest(
        address user,
        address asset,
        uint256 amount
    ) external view returns (uint256 interest);

    /**
     * @notice Returns the amount of `asset` debt that can currently be reduced for `user`.
     * @dev Reverts if:
     *      - the protocol implementation rejects an invalid `user` or `asset`
     *      - the reducible-debt computation cannot be resolved
     *
     * Security:
     * - Read-only liquidation and settlement helper.
     * - Consumers should use this value as an upper bound defined by the implementation's current ledger rules.
     *
     * @param user Borrower address being queried.
     * @param asset Debt asset address being queried.
     * @return reducibleAmount Amount of debt that the implementation currently permits to reduce.
     */
    function getReducibleDebtAmount(
        address user,
        address asset
    ) external view returns (uint256 reducibleAmount);

    /**
     * @notice Returns the valuation of `user`'s debt in `asset` using the implementation's pricing rules.
     * @dev Reverts if:
     *      - the protocol implementation rejects an invalid `user` or `asset`
     *      - the valuation path cannot be resolved
     *
     * Security:
     * - Read-only valuation helper.
     * - The returned unit is implementation-defined and typically depends on the protocol oracle SSOT.
     *
     * @param user Borrower address being queried.
     * @param asset Debt asset address being valued.
     * @return value Debt valuation for `user` and `asset`.
     */
    function calculateDebtValue(
        address user,
        address asset
    ) external view returns (uint256 value);
}
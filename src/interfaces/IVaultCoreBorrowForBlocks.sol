// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IVaultCoreBorrowForBlocks
 * @notice Minimal VaultCore debt-write bridge for blocks-only flows.
 * @dev Reverts if:
 *      - the implementation rejects an unauthorized caller or unsupported blocks-only term configuration
 *      - borrower, asset, or amount inputs are invalid for the underlying VaultCore implementation
 *      - downstream debt-booking or repayment logic reverts while servicing the request
 *
 * Security:
 * - Narrow write bridge intended for the blocks-only coordinator rather than general-purpose integrations.
 * - Debt state remains owned by VaultCore; callers must treat this interface as a privileged adapter into that SSOT.
 */
interface IVaultCoreBorrowForBlocks {
    /**
     * @notice Books a blocks-only borrow for `borrower` in VaultCore.
     * @dev Reverts if:
     *      - the caller is not authorized by the implementation
     *      - `borrower` or `asset` is invalid
     *      - `amount == 0` or `termBlocks` violates implementation-defined product constraints
     *      - the underlying debt-booking logic reverts
     *
     * Security:
     * - Privileged debt-creation hook.
     * - The implementation defines all collateral, risk, and accounting invariants for the borrow.
     *
     * @param borrower Borrower whose debt position is increased.
     * @param asset Debt asset address.
     * @param amount Principal amount in token base units.
     * @param termBlocks Borrow term measured in blocks.
     */
    function borrowForBlocks(
        address borrower,
        address asset,
        uint256 amount,
        uint256 termBlocks
    ) external;

    /**
     * @notice Reduces a blocks-only debt position for `borrower` in VaultCore.
     * @dev Reverts if:
     *      - the caller is not authorized by the implementation
     *      - `borrower` or `asset` is invalid
     *      - `amount == 0` or exceeds what the implementation permits to repay
     *      - the underlying repayment logic reverts
     *
     * Security:
     * - Privileged debt-reduction hook.
     * - Settlement completeness must be confirmed against the downstream debt ledger rather than inferred from the
     *   requested repayment amount alone.
     *
     * @param borrower Borrower whose debt position is reduced.
     * @param asset Debt asset address.
     * @param amount Repayment amount in token base units.
     */
    function repayForBlocks(
        address borrower,
        address asset,
        uint256 amount
    ) external;
}

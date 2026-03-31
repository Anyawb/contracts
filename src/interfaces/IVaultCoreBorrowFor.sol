// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IVaultCoreBorrowFor
 * @notice Minimal VaultCore borrow surface used by settlement and matching flows.
 * @dev Reverts if:
 *      - the implementation rejects an unauthorized caller
 *      - `borrower` or `asset` is zero
 *      - `amount` or `termDays` is invalid under VaultCore rules
 *
 * Security:
 * - Write-capable dependency that should only be used by trusted settlement or orchestration modules.
 * - This interface intentionally exposes only the borrow entrypoint needed by upstream libraries.
 */
interface IVaultCoreBorrowFor {
    /**
     * @notice Borrows `amount` of `asset` for `borrower` under the provided term.
     * @dev Reverts if:
     *      - the implementation rejects an unauthorized caller
     *      - `borrower` or `asset` is zero
     *      - `amount` is zero or exceeds implementation limits
     *      - `termDays` is invalid for the selected product
     *
     * Security:
     * - Mutates borrower debt state in VaultCore.
     * - Callers must ensure upstream checks and accounting have already completed.
     *
     * @param borrower Borrower receiving the debt position.
     * @param asset Borrowed asset address.
     * @param amount Borrow amount in token decimals.
     * @param termDays Loan term in days interpreted by the VaultCore implementation.
     */
    function borrowFor(
        address borrower,
        address asset,
        uint256 amount,
        uint16 termDays
    ) external;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SettlementReserveLib
 * @notice Lightweight library for reserving, cancelling, and consuming lender funds (state-only; no transfers).
 * @dev Storage MUST be declared in the caller contract (e.g., `mapping(bytes32 => LendReserve)`), and this library
 *      only reads/writes that storage.
 *
 * Reverts if:
 * - (none; see per-function notes)
 *
 * Security:
 * - Stateless library; does not perform external calls.
 */
library SettlementReserveLib {
    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/
    struct LendReserve {
        address lender; // Lender address
        address asset; // Reserved asset (ERC20)
        uint256 amount; // Reserved amount (token decimals)
        bool active; // Whether this reserve record is active
    }

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    /// @notice Thrown when an input address is zero.
    error SettlementReserveLib__ZeroAddress();
    /// @notice Thrown when an input amount is zero or otherwise invalid for the operation.
    error SettlementReserveLib__InvalidAmount();
    /// @notice Thrown when attempting to reserve an intentHash that is already active.
    error SettlementReserveLib__AlreadyReserved();
    /// @notice Thrown when the reserve record is missing or inactive.
    error SettlementReserveLib__NotActive();
    /// @notice Thrown when the caller/lender check fails for the reserve record.
    error SettlementReserveLib__NotOwner();

    /*━━━━━━━━━━━━━━━ API ━━━━━━━━━━━━━━━*/

    /**
     * @notice Record a reserve for lender funds for a given intent hash (state-only; no token transfer).
     * @dev Reverts if:
     *      - lender == address(0) or asset == address(0) (SettlementReserveLib__ZeroAddress)
     *      - amount == 0 (SettlementReserveLib__InvalidAmount)
     *      - reserves[intentHash] is already active (SettlementReserveLib__AlreadyReserved)
     *
     * Security:
     * - No external calls; storage-only.
     * - Caller is responsible for performing the actual token movement BEFORE recording the reserve, if required.
     *
     * @param reserves Reserve mapping stored in the caller contract (storage).
     * @param lender Lender address.
     * @param asset Reserved asset (ERC20).
     * @param amount Reserved amount (token decimals).
     * @param intentHash Unique intent identifier (offchain/decentralized order hash).
     */
    function reserve(
        mapping(bytes32 => LendReserve) storage reserves,
        address lender,
        address asset,
        uint256 amount,
        bytes32 intentHash
    ) internal {
        if (lender == address(0) || asset == address(0))
            revert SettlementReserveLib__ZeroAddress();
        if (amount == 0) revert SettlementReserveLib__InvalidAmount();
        LendReserve storage slot = reserves[intentHash];
        if (slot.active) revert SettlementReserveLib__AlreadyReserved();

        slot.lender = lender;
        slot.asset = asset;
        slot.amount = amount;
        slot.active = true;
    }

    /**
     * @notice Cancel an existing reserve and delete the record (caller must be the original lender).
     * @dev Reverts if:
     *      - reserves[intentHash] is not active (SettlementReserveLib__NotActive)
     *      - caller != slot.lender (SettlementReserveLib__NotOwner)
     *
     * Security:
     * - No external calls; storage-only.
     *
     * @param reserves Reserve mapping stored in the caller contract (storage).
     * @param intentHash Unique intent identifier.
     * @param caller Address asserted as the cancellation caller (passed by the entrypoint).
     * @return asset Reserved asset (ERC20).
     * @return amount Reserved amount (token decimals).
     */
    function cancel(
        mapping(bytes32 => LendReserve) storage reserves,
        bytes32 intentHash,
        address caller
    ) internal returns (address asset, uint256 amount) {
        LendReserve storage slot = reserves[intentHash];
        if (!slot.active) revert SettlementReserveLib__NotActive();
        if (slot.lender != caller) revert SettlementReserveLib__NotOwner();
        asset = slot.asset;
        amount = slot.amount;
        delete reserves[intentHash];
    }

    /**
     * @notice Consume a reserve on match finalization and delete the record.
     * @dev Reverts if:
     *      - reserves[intentHash] is not active (SettlementReserveLib__NotActive)
     *      - expectedLender != address(0) and slot.lender != expectedLender (SettlementReserveLib__NotOwner)
     *
     * Security:
     * - No external calls; storage-only.
     * - This method only checks the lender constraint; caller SHOULD apply additional authorization at the entrypoint.
     *
     * @param reserves Reserve mapping stored in the caller contract (storage).
     * @param intentHash Unique intent identifier.
     * @param expectedLender Optional lender constraint (set to address(0) to skip).
     * @return lender Stored lender address.
     * @return asset Reserved asset (ERC20).
     * @return amount Reserved amount (token decimals).
     */
    function consume(
        mapping(bytes32 => LendReserve) storage reserves,
        bytes32 intentHash,
        address expectedLender
    ) internal returns (address lender, address asset, uint256 amount) {
        LendReserve storage slot = reserves[intentHash];
        if (!slot.active) revert SettlementReserveLib__NotActive();
        if (expectedLender != address(0) && slot.lender != expectedLender)
            revert SettlementReserveLib__NotOwner();
        lender = slot.lender;
        asset = slot.asset;
        amount = slot.amount;
        delete reserves[intentHash];
    }

    /**
     * @notice Consume up to `maxAmount` from a reserve, supporting partial consumption and writing back the remainder.
     * @dev Reverts if:
     *      - maxAmount == 0 (SettlementReserveLib__InvalidAmount)
     *      - reserves[intentHash] is not active (SettlementReserveLib__NotActive)
     *      - expectedLender != address(0) and slot.lender != expectedLender (SettlementReserveLib__NotOwner)
     *
     * Security:
     * - No external calls; storage-only.
     * - Caller SHOULD apply additional authorization at the entrypoint.
     *
     * @param reserves Reserve mapping stored in the caller contract (storage).
     * @param intentHash Unique intent identifier.
     * @param expectedLender Optional lender constraint (set to address(0) to skip).
     * @param maxAmount Maximum amount to consume (token decimals).
     * @return lender Stored lender address.
     * @return asset Reserved asset (ERC20).
     * @return used Amount actually consumed (token decimals).
     * @return remaining Remaining reserved amount (token decimals). Zero means the record was deleted.
     */
    function consumeUpTo(
        mapping(bytes32 => LendReserve) storage reserves,
        bytes32 intentHash,
        address expectedLender,
        uint256 maxAmount
    )
        internal
        returns (address lender, address asset, uint256 used, uint256 remaining)
    {
        if (maxAmount == 0) revert SettlementReserveLib__InvalidAmount();
        LendReserve storage slot = reserves[intentHash];
        if (!slot.active) revert SettlementReserveLib__NotActive();
        if (expectedLender != address(0) && slot.lender != expectedLender)
            revert SettlementReserveLib__NotOwner();
        lender = slot.lender;
        asset = slot.asset;
        if (slot.amount <= maxAmount) {
            used = slot.amount;
            remaining = 0;
            delete reserves[intentHash];
        } else {
            used = maxAmount;
            remaining = slot.amount - maxAmount;
            slot.amount = remaining;
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LoanEvents
 * @notice Canonical guarantee/loan-related events shared across Vault modules.
 * @dev This is an event-only interface (SSOT for event signatures).
 *
 * Rationale:
 * - Contracts can `is LoanEvents` to include event ABIs without re-declaring them.
 * - Offchain indexers can rely on stable signatures across modules.
 */
interface LoanEvents {
    /**
     * @notice Emitted when a guarantee amount is locked.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by the guarantee ledger/manager after it updates state
     *
     * @param user User address
     * @param asset Guarantee asset address
     * @param amount Locked amount (token decimals)
     * @param timestamp Emission timestamp (seconds)
     */
    event GuaranteeLocked(address indexed user, address indexed asset, uint256 amount, uint256 timestamp);

    /**
     * @notice Emitted when a guarantee amount is released.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by the guarantee ledger/manager after it updates state
     *
     * @param user User address
     * @param asset Guarantee asset address
     * @param amount Released amount (token decimals)
     * @param timestamp Emission timestamp (seconds)
     */
    event GuaranteeReleased(address indexed user, address indexed asset, uint256 amount, uint256 timestamp);

    /**
     * @notice Emitted when a guarantee amount is forfeited (e.g., penalty/fee distribution).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Emitted by the guarantee ledger/manager after it updates state
     *
     * @param user User address
     * @param asset Guarantee asset address
     * @param amount Forfeited amount (token decimals)
     * @param feeReceiver Receiver of the forfeited funds
     * @param timestamp Emission timestamp (seconds)
     */
    event GuaranteeForfeited(
        address indexed user,
        address indexed asset,
        uint256 amount,
        address indexed feeReceiver,
        uint256 timestamp
    );
}
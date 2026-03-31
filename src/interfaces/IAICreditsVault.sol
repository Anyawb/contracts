// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAICreditsVault
 * @notice Minimal external interface for AICreditsVault, the onchain AI credits SSOT.
 * @dev Reverts if:
 *      - implementations reject invalid tenant, token, user, or idempotency inputs
 *      - privileged settlement calls are made without the required governance/operator role
 *      - payment or settlement invariants fail for the requested operation
 *
 * Security:
 * - High-frequency usage accounting remains offchain; this interface only exposes auditable onchain balances and
 *   batch settlement primitives.
 * - Governance/config writes are resolved through Registry + AccessControlManager in the reference implementation.
 */
interface IAICreditsVault {
    /**
     * @notice Returns the stored credit balance for `user` within `tenantId`.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only balance lookup.
     * - Returned credits are natural-number protocol units, not ERC-20 decimals.
     *
     * @param tenantId Tenant namespace for the balance lookup.
     * @param user User address whose balance is queried.
     * @return balance Stored credit balance for `(tenantId, user)`.
     */
    function creditsBalance(
        bytes32 tenantId,
        address user
    ) external view returns (uint256 balance);

    /**
     * @notice Purchases credits for the caller using `payToken`.
     * @dev Reverts if:
     *      - `payToken` is invalid
     *      - `credits` or `clientOrderId` is invalid for the implementation
     *      - the `(tenantId, caller, clientOrderId)` idempotency key is already used
     *      - the configured unit price is missing or `payAmount` does not exactly match the expected payment
     *      - payment token transfer fails
     *
     * Security:
     * - Write path guarded by exact-payment and idempotency checks.
     * - Implementations typically credit balances only after payment transfer succeeds.
     *
     * @param tenantId Tenant namespace receiving the purchased credits.
     * @param payToken ERC-20 payment token.
     * @param payAmount Exact payment amount in token base units.
     * @param credits Number of credits to add to the caller balance.
     * @param clientOrderId Caller-supplied idempotency key.
     */
    function buyCredits(
        bytes32 tenantId,
        address payToken,
        uint256 payAmount,
        uint256 credits,
        bytes32 clientOrderId
    ) external;

    /**
     * @notice Applies an operator-managed batch of offchain credit deductions.
     * @dev Reverts if:
     *      - the caller lacks the implementation's settlement role
     *      - `settlementBatchId` is invalid or already applied
     *      - `users` is empty or length-mismatched with `creditsUsed`
     *      - any user entry is invalid or has insufficient balance for the requested deduction
     *
     * Security:
     * - Batch idempotency is expected to be enforced before iteration.
     * - Implementations commonly treat `merkleRoot` as an informational audit anchor, not a proof verified onchain.
     *
     * @param tenantId Tenant namespace whose balances are being settled.
     * @param settlementBatchId Unique settlement idempotency key.
     * @param merkleRoot Informational commitment to the offchain settlement payload.
     * @param users Users whose balances will be decremented.
     * @param creditsUsed Credits to deduct from each aligned user.
     */
    function settleBatch(
        bytes32 tenantId,
        bytes32 settlementBatchId,
        bytes32 merkleRoot,
        address[] calldata users,
        uint256[] calldata creditsUsed
    ) external;
}

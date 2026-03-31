// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title HealthEvents
 * @notice SSOT for health-status push failure observability events across Vault modules.
 * @dev Reverts if: (never)
 *
 * Security:
 * - Event-only interface: declares canonical health-push failure observability events.
 * - Health pushes are best-effort; failures MUST remain observable and MUST NOT revert the main ledger flow.
 * - Off-chain retry and audit systems rely on these stable event signatures.
 */
// solhint-disable-next-line interface-starts-with-i
interface HealthEvents {
    /**
     * @notice Emitted when a best-effort HealthView push fails (for offchain retry/alerting).
     * @dev Event only.
     *
     * @param user Target user address.
     * @param healthView HealthView contract address (may be zero if not configured).
     * @param totalCollateral Total collateral value used for the push (semantics depend on module).
     * @param totalDebt Total debt value used for the push (semantics depend on module).
     * @param reason Raw revert data or a descriptive bytes payload.
     */
    event HealthPushFailed(
        address indexed user,
        address indexed healthView,
        uint256 totalCollateral,
        uint256 totalDebt,
        bytes reason
    );
}

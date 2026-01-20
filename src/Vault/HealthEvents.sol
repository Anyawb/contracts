// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title HealthEvents
 * @notice SSOT for health-status push failure observability events across Vault modules.
 * @dev Architecture-Guide alignment:
 * - Health push is best-effort; failures MUST be observable and must not revert the main ledger flow.
 * - Offchain retry/audit systems rely on a stable, canonical event signature.
 */
interface HealthEvents {
    /**
     * @notice Emitted when a best-effort HealthView push fails (for offchain retry/alerting).
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


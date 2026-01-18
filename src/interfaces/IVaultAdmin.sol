// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IVaultAdmin
 * @notice Minimal governance entrypoint for Vault-level parameter dispatch.
 * @dev Architecture intent:
 * - VaultAdmin is intentionally small and only exposes narrowly-scoped governance setters.
 * - Most parameters should be managed by their dedicated SSOT modules (e.g., config managers).
 */
interface IVaultAdmin {
    /* ============ Governance Functions ============ */
    /**
     * @notice Set the minimum health factor (bps).
     * @dev Reverts if:
     *      - caller is not authorized (implementation enforces ActionKeys.ACTION_SET_PARAMETER)
     *      - hf is outside the allowed range (implementation-defined)
     *      - downstream SSOT module reverts (e.g., LiquidationConfigManager)
     *
     * Security:
     * - Governance-only function (role-gated via ACM in the implementation).
     *
     * @param hf New minimum health factor in basis points (bps, 10000 = 100%)
     */
    function setMinHealthFactor(uint256 hf) external;
} 
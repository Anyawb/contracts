// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CacheEvents
 * @notice SSOT for cache/view push failure observability events across Vault modules.
 * @dev Architecture-Guide alignment:
 * - Cache/view pushes are best-effort; failures MUST be observable and must not revert the main ledger flow.
 * - Offchain retry/audit systems rely on a stable, canonical event signature.
 */
interface CacheEvents {
    /**
     * @notice Emitted when a best-effort cache/view update fails (for offchain retry/alerting).
     * @param user Target user address
     * @param asset Asset address used as the cache key (can be 0 for user-scoped pushes)
     * @param viewAddr Target view contract address (may be zero if view not configured)
     * @param collateral Collateral amount attempted to push (token decimals / value semantics depend on module)
     * @param debt Debt amount attempted to push (token decimals / value semantics depend on module)
     * @param reason Raw revert data or a descriptive bytes payload
     */
    event CacheUpdateFailed(
        address indexed user,
        address indexed asset,
        address viewAddr,
        uint256 collateral,
        uint256 debt,
        bytes reason
    );
}


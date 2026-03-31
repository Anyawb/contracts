// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CacheEvents
 * @notice SSOT for cache/view push failure observability events across Vault modules.
 * @dev Reverts if: (never)
 *
 * Security:
 * - Event-only interface: declares canonical observability events and performs no state changes.
 * - Cache/view pushes are best-effort; failures MUST remain observable and MUST NOT revert the main ledger flow.
 * - Off-chain retry and audit systems rely on these stable event signatures.
 */
// solhint-disable-next-line interface-starts-with-i
interface CacheEvents {
    /**
     * @notice Emitted when a best-effort cache/view update fails (for offchain retry/alerting).
     * @dev Event only.
     *
     * @param user Target user address.
     * @param asset Asset address used as the cache key. May be zero for user-scoped pushes.
     * @param viewAddr Target view contract address. May be zero if the view is not configured.
     * @param collateral Collateral amount attempted to push. Unit semantics depend on the emitting module.
     * @param debt Debt amount attempted to push. Unit semantics depend on the emitting module.
     * @param reason Raw revert data or an encoded failure payload.
     */
    event CacheUpdateFailed(
        address indexed user,
        address indexed asset,
        address viewAddr,
        uint256 collateral,
        uint256 debt,
        bytes reason
    );

    /**
     * @notice Emitted when a best-effort cache/view update fails with concurrency context.
     * @dev Event only. Includes concurrency metadata for idempotent retry and replay analysis.
     *
     * @param user Target user address.
     * @param asset Asset address used as the cache key. May be zero for user-scoped pushes.
     * @param requestId Idempotency key used for replay detection.
     * @param viewAddr Target view contract address. May be zero if the view is not configured.
     * @param collateral Collateral amount attempted to push. Unit semantics depend on the emitting module.
     * @param debt Debt amount attempted to push. Unit semantics depend on the emitting module.
     * @param reason Raw revert data or an encoded failure payload.
     * @param seq Monotonic sequence number. Zero means unused.
     * @param nextVersion Expected next version. Zero means auto-increment mode.
     */
    event CacheUpdateFailedWithContext(
        address indexed user,
        address indexed asset,
        bytes32 indexed requestId,
        address viewAddr,
        uint256 collateral,
        uint256 debt,
        bytes reason,
        uint64 seq,
        uint64 nextVersion
    );
}

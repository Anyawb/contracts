// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ICacheRefreshable
 * @notice Unified interface for contracts that maintain an internal module-address cache (A-class cache).
 * @dev Implementations refresh their internal cached addresses from the authoritative Registry.
 */
interface ICacheRefreshable {
    /**
     * @notice Refresh the internal module-address cache.
     * @dev Reverts if:
     *      - caller is not the CacheMaintenanceManager (or equivalent governance-gated entrypoint)
     *      - required Registry module resolution fails
     *
     * Security:
     * - MUST be restricted to a single operational entrypoint (e.g., CacheMaintenanceManager).
     */
    function refreshModuleCache() external;
}

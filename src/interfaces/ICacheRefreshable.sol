// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICacheRefreshable
/// @notice Unified interface for contracts that maintain an internal module-address cache.
/// @dev Implementations should refresh their internal cache timestamps/entries from the authoritative Registry.
interface ICacheRefreshable {
    /// @notice Refresh internal module cache.
    /// @dev Intended to be called by a governance-gated CacheMaintenanceManager (best-effort, auditable).
    function refreshModuleCache() external;
}


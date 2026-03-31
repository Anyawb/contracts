// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IRWATokenRegistry
 * @notice Interface for the whitelist of RWA assets that may participate in lending flows.
 * @dev Reverts if:
 *      - protocol implementations reject the query because registry state or access policy is invalid
 *
 * Security:
 * - Read-only allowlist surface for RWA-eligible token membership.
 * - This interface does not expose governance mutation; callers should not assume a write path exists.
 */
interface IRWATokenRegistry {
    /**
     * @notice Returns whether `token` is currently allowed.
     * @dev Reverts if:
     *      - the implementation rejects the query because registry state is invalid
     *      - the implementation restricts token-membership reads under its access policy
     *
     * Security:
     * - Read-only membership probe.
     * - Callers should treat `false` as the only safe negative signal and must not assume that unknown assets
     *   revert.
     *
     * @param token Token address being queried.
     * @return allowed Whether `token` is currently allowed.
     */
    function isAllowed(address token) external view returns (bool allowed);
}

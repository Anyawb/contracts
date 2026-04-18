// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAuthorityWhitelistAdmin
 * @notice Governance/configuration interface for authority-name whitelists.
 * @dev Reverts if:
 *      - the caller is not authorized to mutate authority whitelist state
 *      - the provided authority name or registry update is invalid for the requested operation
 *      - the implementation rejects the requested whitelist transition
 *
 * Security:
 * - Intended for governance or other privileged operator paths only.
 * - Callers should depend on {IAuthorityWhitelistRead} for ordinary checks and reserve this interface for mutation.
 */
interface IAuthorityWhitelistAdmin {
    /**
     * @notice Adds `name` to the authority whitelist.
     * @dev Reverts if:
     *      - the caller is not authorized for whitelist additions
     *      - `name` is empty, malformed, or otherwise rejected by the implementation
     *      - `name` is already whitelisted
     *
     * Security:
     * - Governance write path for authority-name onboarding.
     * - Matching semantics are implementation-defined, including case sensitivity and normalization.
     *
     * @param name Authority or institution name to add.
     */
    function addAuthority(string calldata name) external;

    /**
     * @notice Removes `name` from the authority whitelist.
     * @dev Reverts if:
     *      - the caller is not authorized for whitelist removals
     *      - `name` is empty, malformed, or otherwise rejected by the implementation
     *      - `name` is not currently whitelisted
     *
     * Security:
     * - Governance write path for authority-name removal.
     *
     * @param name Authority or institution name to remove.
     */
    function removeAuthority(string calldata name) external;

    /**
     * @notice Returns the registry used by the whitelist implementation.
     * @dev Reverts if:
     *      - the implementation rejects the query because its registry state is invalid
     *      - the implementation restricts registry metadata access
     *
     * Security:
     * - Read-only metadata helper exposed on the admin surface for governance tooling.
     *
     * @return registryAddr Registry address used by the whitelist implementation.
     */
    function getRegistry() external view returns (address registryAddr);

    /**
     * @notice Updates the registry used by the whitelist implementation.
     * @dev Reverts if:
     *      - the caller is not authorized for parameter changes
     *      - `newRegistryAddr` is invalid or rejected by the implementation
     *
     * Security:
     * - Governance-only dependency-management hook.
     * - Changing the registry changes how future role checks and module resolution behave.
     *
     * @param newRegistryAddr New registry address.
     */
    function setRegistry(address newRegistryAddr) external;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAuthorityWhitelistRead
 * @notice Read-only interface for authority-name whitelist checks.
 * @dev Reverts if:
 *      - protocol implementations reject the query because registry state or access policy is invalid
 *
 * Security:
 * - Read-only surface for subject-level authority-name membership checks.
 * - Callers should use this interface when they only need whitelist verification, not governance mutation.
 */
interface IAuthorityWhitelistRead {
    /**
     * @notice Returns whether `name` currently passes authority whitelist validation.
     * @dev Reverts if:
     *      - the implementation rejects the query because registry state is invalid
     *      - the implementation restricts authority-name reads under its access policy
     *
     * Security:
     * - Read-only membership probe.
     * - Matching semantics, including case sensitivity and normalization, are implementation-defined.
     *
     * @param name Authority, institution, or subject name being queried.
     * @return whitelisted Whether `name` is currently whitelisted.
     */
    function check(
        string calldata name
    ) external view returns (bool whitelisted);
}

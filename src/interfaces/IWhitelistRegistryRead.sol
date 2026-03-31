// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IWhitelistRegistryRead
 * @notice Narrow read surface for the centralized account whitelist registry.
 * @dev Reverts if:
 *      - the implementation rejects the query because registry state is invalid
 *      - the implementation restricts reads under its access policy
 *
 * Security:
 * - Reserved for centralized account-membership checks only; asset and authority allowlists belong to their own
 *   dedicated interfaces.
 * - This surface intentionally excludes governance mutation so downstream consumers depend only on the minimum
 *   membership-read capability.
 */
interface IWhitelistRegistryRead {
    /*━━━━━━━━━━━━━━━ Reads ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns whether `account` is currently whitelisted.
     * @dev Reverts if:
     *      - the implementation rejects the query because registry state is invalid
     *      - the implementation restricts membership reads under its access policy
     *
     * Security:
     * - Read-only membership probe for account-registration workflows.
     * - Callers should treat `false` as the only safe negative signal and should not depend on unknown accounts
     *   reverting.
     *
     * @param account Account address to check.
     * @return whitelisted Whether `account` is currently whitelisted.
     */
    function isWhitelisted(
        address account
    ) external view returns (bool whitelisted);
}

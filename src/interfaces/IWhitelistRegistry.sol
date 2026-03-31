// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IWhitelistRegistryRead} from "./IWhitelistRegistryRead.sol";

/**
 * @title IWhitelistRegistry
 * @notice Legacy compatibility alias for the centralized account whitelist registry.
 * @dev Reverts if:
 *      - see inherited {IWhitelistRegistryRead} semantics
 *
 * Security:
 * - Compatibility aggregation layer retained for legacy callers.
 * - Prefer {IWhitelistRegistryRead} for new consumers so the narrow read-only dependency remains explicit.
 */
interface IWhitelistRegistry is IWhitelistRegistryRead {
    /*━━━━━━━━━━━━━━━ Compatibility Reads ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns whether `account` is currently whitelisted.
     * @dev Reverts if:
     *      - see {IWhitelistRegistryRead.isWhitelisted}
     *
     * Security:
     * - Read-only compatibility alias for legacy consumers that still import {IWhitelistRegistry}.
     *
     * @param account Account address to check.
     * @return whitelisted Whether `account` is currently whitelisted.
     */
    function isWhitelisted(
        address account
    ) external view override returns (bool whitelisted);
}

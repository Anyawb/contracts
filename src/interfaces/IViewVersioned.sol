// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IViewVersioned
 * @notice Standardized versioning surface for upgradeable View modules.
 * @dev Reverts if:
 *      - the implementation cannot resolve proxy/implementation metadata
 *
 * Security:
 * - Read-only metadata surface for upgrade-aware integrations.
 * - `apiVersion` tracks external API compatibility for integrators.
 * - `schemaVersion` tracks cached/output schema compatibility for structs, events, and encoding.
 * - `implementation` returns the implementation address when called through a proxy and may fall back to
 *   `address(this)` otherwise.
 */
interface IViewVersioned {
    /**
     * @notice Returns version metadata for the current view module.
     * @dev Reverts if:
     *      - the implementation cannot resolve one or more version fields
     *
     * Security:
     * - Read-only upgrade metadata helper.
     *
     * @return apiVersion External API compatibility version.
     * @return schemaVersion Output schema compatibility version.
     * @return implementation Current implementation address or `address(this)` for non-proxied deployments.
     */
    function getVersionInfo()
        external
        view
        returns (
            uint256 apiVersion,
            uint256 schemaVersion,
            address implementation
        );
}

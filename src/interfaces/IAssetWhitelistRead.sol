// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAssetWhitelistRead
 * @notice Read-only interface for protocol asset allowlists.
 * @dev Reverts if:
 *      - protocol implementations reject invalid index or registry queries
 *      - protocol implementations gate registry metadata access behind additional checks
 *
 * Security:
 * - Use this interface in business and view modules that only need asset whitelist checks.
 * - Callers should prefer this interface over broader governance-capable whitelist surfaces.
 * - In stage-1 blocks-only flows, this interface is the on-chain asset admission SSOT used by
 *   {BlocksOnlyCoordinator}; passing this check is necessary before any blocks-only match can finalize.
 */
interface IAssetWhitelistRead {
    /**
     * @notice Returns whether `asset` is currently allowlisted.
     * @dev Reverts if:
     *      - (none expected; protocol implementations typically return `false` for unknown assets)
     *
     * Security:
     * - Read-only membership probe.
     * - Callers should treat `false` as the sole negative signal and must not assume a revert for unknown assets.
     * - For current blocks-only onboarding, `true` means the asset passes the global admission gate, but it does
     *   not by itself mean the asset has been fully listed in front-end directories, off-chain matching config, or
     *   monitoring pipelines.
     *
     * @param asset Asset address being queried.
     * @return allowed Whether `asset` is currently allowlisted.
     */
    function isAssetAllowed(address asset) external view returns (bool allowed);

    /**
     * @notice Returns the current in-memory list of allowlisted assets.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only enumeration helper.
     * - Ordering is implementation-defined and may change after removals or batch updates.
     *
     * @return assets Asset list currently considered allowlisted.
     */
    function getAllowedAssets() external view returns (address[] memory assets);

    /**
     * @notice Returns the number of allowlisted assets.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only enumeration helper.
     *
     * @return count Number of currently allowlisted assets.
     */
    function getAssetCount() external view returns (uint256 count);

    /**
     * @notice Returns the allowlisted asset stored at `index`.
     * @dev Reverts if:
     *      - `index` is out of bounds for the implementation's current asset list
     *
     * Security:
     * - Read-only enumeration helper.
     * - Consumers should not assume insertion-stable ordering.
     *
     * @param index Zero-based index into the implementation's allowlist set.
     * @return asset Asset address stored at `index`.
     */
    function getAssetAtIndex(
        uint256 index
    ) external view returns (address asset);

    /**
     * @notice Returns the registry used by the whitelist implementation.
     * @dev Reverts if:
     *      - the implementation rejects the query because its registry state is invalid
     *      - the implementation restricts registry metadata access
     *
     * Security:
     * - Read-only metadata helper.
     * - Callers should not assume this function is permissionless across all implementations.
     *
     * @return registryAddr Registry address used by the whitelist implementation.
     */
    function getRegistry() external view returns (address registryAddr);
}

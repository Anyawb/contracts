// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAssetWhitelist
/// @notice Asset whitelist interface for supported collateral/settlement assets.
/// @dev Implements allowlist reads and governance-gated allowlist writes.
interface IAssetWhitelist {
    /**
     * @notice Check whether an asset is allowed by the whitelist.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @param asset Asset address to query.
     * @return allowed True if the asset is allowed.
     */
    function isAssetAllowed(address asset) external view returns (bool allowed);

    /**
     * @notice Get the full list of allowed assets.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only.
     *
     * @return assets Array of allowed asset addresses.
     */
    function getAllowedAssets() external view returns (address[] memory assets);

    /**
     * @notice Add an asset to the allowlist.
     * @dev Reverts if:
     *      - implementation-defined (e.g. caller not authorized, asset is zero, asset already allowed)
     *
     * Security:
     * - Governance/role-gated in the implementation (see ActionKeys + ACM).
     *
     * @param asset Asset address to add.
     */
    function addAllowedAsset(address asset) external;

    /**
     * @notice Remove an asset from the allowlist.
     * @dev Reverts if:
     *      - implementation-defined (e.g. caller not authorized, asset is zero, asset not allowed)
     *
     * Security:
     * - Governance/role-gated in the implementation (see ActionKeys + ACM).
     *
     * @param asset Asset address to remove.
     */
    function removeAllowedAsset(address asset) external;

    /**
     * @notice Batch add assets to the allowlist.
     * @dev Reverts if:
     *      - implementation-defined (e.g. caller not authorized, empty array, any asset is zero)
     *
     * Security:
     * - Governance/role-gated in the implementation (see ActionKeys + ACM).
     *
     * @param assets Asset addresses to add.
     */
    function batchAddAllowedAssets(address[] calldata assets) external;

    /**
     * @notice Batch remove assets from the allowlist.
     * @dev Reverts if:
     *      - implementation-defined (e.g. caller not authorized, empty array, any asset is zero)
     *
     * Security:
     * - Governance/role-gated in the implementation (see ActionKeys + ACM).
     *
     * @param assets Asset addresses to remove.
     */
    function batchRemoveAllowedAssets(address[] calldata assets) external;
} 
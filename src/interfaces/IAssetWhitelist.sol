// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAssetWhitelistRead} from "./IAssetWhitelistRead.sol";
import {IAssetWhitelistAdmin} from "./IAssetWhitelistAdmin.sol";

/**
 * @title IAssetWhitelist
 * @notice Legacy umbrella interface for subject-level protocol asset allowlists.
 * @dev Reverts if:
 *      - see inherited {IAssetWhitelistRead} and {IAssetWhitelistAdmin} semantics
 *
 * Security:
 * - Compatibility-only aggregation layer.
 * - Prefer {IAssetWhitelistRead} for ordinary checks and {IAssetWhitelistAdmin} for governance paths.
 * - Current blocks-only integrations should reason about this surface as a compatibility wrapper around the global
 *   asset admission gate, not as a dedicated blocks-only product registry.
 */
interface IAssetWhitelist is IAssetWhitelistRead, IAssetWhitelistAdmin {
    /**
     * @notice Returns whether `asset` is currently allowlisted.
     * @dev Reverts if:
     *      - see {IAssetWhitelistRead.isAssetAllowed}
     *
     * Security:
     * - Read-only compatibility alias for the narrow whitelist read surface.
     *
     * @param asset Asset address to query.
     * @return allowed Whether `asset` is currently allowlisted.
     */
    function isAssetAllowed(
        address asset
    ) external view override returns (bool allowed);

    /**
     * @notice Returns the full list of currently allowlisted assets.
     * @dev Reverts if:
     *      - see {IAssetWhitelistRead.getAllowedAssets}
     *
     * Security:
     * - Read-only compatibility alias for the narrow whitelist read surface.
     *
     * @return assets Asset list currently considered allowlisted.
     */
    function getAllowedAssets()
        external
        view
        override
        returns (address[] memory assets);

    /**
     * @notice Returns the number of currently allowlisted assets.
     * @dev Reverts if:
     *      - see {IAssetWhitelistRead.getAssetCount}
     *
     * Security:
     * - Read-only compatibility alias for the narrow whitelist read surface.
     *
     * @return count Number of currently allowlisted assets.
     */
    function getAssetCount() external view override returns (uint256 count);

    /**
     * @notice Returns the allowlisted asset stored at `index`.
     * @dev Reverts if:
     *      - see {IAssetWhitelistRead.getAssetAtIndex}
     *
     * Security:
     * - Read-only compatibility alias for the narrow whitelist read surface.
     *
     * @param index Index inside the allowlist set.
     * @return asset Asset address stored at `index`.
     */
    function getAssetAtIndex(
        uint256 index
    ) external view override returns (address asset);

    /**
     * @notice Returns the registry used by the whitelist implementation.
     * @dev Reverts if:
     *      - see {IAssetWhitelistRead.getRegistry}
     *
     * Security:
     * - Read-only metadata helper exposed for compatibility.
     *
     * @return registryAddr Registry address used by the whitelist implementation.
     */
    function getRegistry()
        external
        view
        override
        returns (address registryAddr);

    /**
     * @notice Adds `asset` to the allowlist.
     * @dev Reverts if:
     *      - see {IAssetWhitelistAdmin.addAllowedAsset}
     *
     * Security:
     * - Governance compatibility alias for the narrow whitelist admin surface.
     *
     * @param asset Asset address to add.
     */
    function addAllowedAsset(address asset) external override;

    /**
     * @notice Removes `asset` from the allowlist.
     * @dev Reverts if:
     *      - see {IAssetWhitelistAdmin.removeAllowedAsset}
     *
     * Security:
     * - Governance compatibility alias for the narrow whitelist admin surface.
     *
     * @param asset Asset address to remove.
     */
    function removeAllowedAsset(address asset) external override;

    /**
     * @notice Adds multiple assets to the allowlist.
     * @dev Reverts if:
     *      - see {IAssetWhitelistAdmin.batchAddAllowedAssets}
     *
     * Security:
     * - Governance compatibility alias for the narrow whitelist admin surface.
     *
     * @param assets Asset addresses to add.
     */
    function batchAddAllowedAssets(address[] calldata assets) external override;

    /**
     * @notice Removes multiple assets from the allowlist.
     * @dev Reverts if:
     *      - see {IAssetWhitelistAdmin.batchRemoveAllowedAssets}
     *
     * Security:
     * - Governance compatibility alias for the narrow whitelist admin surface.
     *
     * @param assets Asset addresses to remove.
     */
    function batchRemoveAllowedAssets(
        address[] calldata assets
    ) external override;

    /**
     * @notice Refreshes bookkeeping metadata for an allowlisted asset.
     * @dev Reverts if:
     *      - see {IAssetWhitelistAdmin.updateAssetInfo}
     *
     * Security:
     * - Governance compatibility alias for the narrow whitelist admin surface.
     *
     * @param asset Asset address.
     */
    function updateAssetInfo(address asset) external override;

    /**
     * @notice Updates the registry used for governance resolution.
     * @dev Reverts if:
     *      - see {IAssetWhitelistAdmin.setRegistry}
     *
     * Security:
     * - Governance compatibility alias for the narrow whitelist admin surface.
     *
     * @param newRegistryAddr New Registry address.
     */
    function setRegistry(address newRegistryAddr) external override;
}

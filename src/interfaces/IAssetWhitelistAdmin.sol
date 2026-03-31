// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAssetWhitelistAdmin
 * @notice Governance/configuration interface for protocol asset allowlists.
 * @dev Reverts if:
 *      - the caller is not authorized to mutate whitelist state
 *      - asset inputs are zero, duplicated, empty, or otherwise invalid for the requested operation
 *      - the implementation rejects the requested allowlist state transition or registry update
 *
 * Security:
 * - Intended for governance or other privileged operator paths only.
 * - Callers should use this surface only for allowlist management, while ordinary consumers should depend on
 *   {IAssetWhitelistRead}.
 * - In stage-1 blocks-only rollout, governance uses this surface to manage the chain-side asset admission gate, but
 *   product listing still requires coordinated off-chain directory and integration updates.
 */
interface IAssetWhitelistAdmin {
    /**
     * @notice Adds `asset` to the allowlist.
     * @dev Reverts if:
     *      - the caller is not authorized for whitelist adds
     *      - `asset` is invalid
     *      - `asset` is already allowlisted or otherwise rejected by the implementation
     *
     * Security:
     * - Governance write path for a single asset onboarding.
     * - For current blocks-only flows, adding an asset here is a prerequisite for eligibility, not a complete
     *   product-launch workflow.
     *
     * @param asset Asset address to add.
     */
    function addAllowedAsset(address asset) external;

    /**
     * @notice Removes `asset` from the allowlist.
     * @dev Reverts if:
     *      - the caller is not authorized for whitelist removals
     *      - `asset` is invalid
     *      - `asset` is not allowlisted or otherwise rejected by the implementation
     *
     * Security:
     * - Governance write path for a single asset removal.
     * - Removing an asset here immediately removes the chain-side admission basis relied on by current blocks-only
     *   finalization.
     *
     * @param asset Asset address to remove.
     */
    function removeAllowedAsset(address asset) external;

    /**
     * @notice Adds multiple assets aligned to `assets`.
     * @dev Reverts if:
     *      - the caller is not authorized for whitelist adds
     *      - `assets` is empty or contains invalid elements
     *      - the implementation rejects the batch request
     *
     * Security:
     * - Batch governance onboarding helper.
     * - Implementations may treat already-allowlisted entries idempotently or may reject them; callers must follow the
     *   concrete implementation semantics.
     *
     * @param assets Asset list to add.
     */
    function batchAddAllowedAssets(address[] calldata assets) external;

    /**
     * @notice Removes multiple assets aligned to `assets`.
     * @dev Reverts if:
     *      - the caller is not authorized for whitelist removals
     *      - `assets` is empty or contains invalid elements
     *      - the implementation rejects the batch request
     *
     * Security:
     * - Batch governance removal helper.
     * - Implementations may treat already-removed entries idempotently or may reject them; callers must follow the
     *   concrete implementation semantics.
     *
     * @param assets Asset list to remove.
     */
    function batchRemoveAllowedAssets(address[] calldata assets) external;

    /**
     * @notice Refreshes implementation-specific metadata for an allowlisted asset.
     * @dev Reverts if:
     *      - the caller is not authorized for parameter changes
     *      - `asset` is invalid or not in the required state for metadata refresh
     *
     * Security:
     * - Governance bookkeeping hook.
     * - Semantics are implementation-defined and may not affect allowlist membership directly.
     *
     * @param asset Asset address whose metadata should be refreshed.
     */
    function updateAssetInfo(address asset) external;

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

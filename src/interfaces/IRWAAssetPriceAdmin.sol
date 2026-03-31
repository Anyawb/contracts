// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IRWAAssetPriceAdmin
 * @notice Governance/configuration interface for RWA-scoped authoritative price sources.
 * @dev Reverts if:
 *      - the caller is not authorized to mutate RWA price state or parameters
 *      - assets, prices, block references, or parameters are malformed for the requested mutation
 *      - the implementation rejects unsupported assets or invalid configuration values
 *
 * Security:
 * - Intended for governance, trusted updaters, or RWA-specific operator modules only.
 * - These writes define the authoritative RWA price surface consumed by protocol valuation and risk logic.
 */
interface IRWAAssetPriceAdmin {
    /**
     * @notice Stores a new authoritative price for `token`.
     * @dev Reverts if:
     *      - the caller is not authorized to update RWA prices
     *      - `token` is invalid or unsupported
     *      - `price` or `blockNumber` is rejected by the implementation
     *
     * Security:
     * - Single-asset authoritative write path.
     * - `blockNumber` is an informational freshness anchor whose exact semantics are implementation-defined.
     *
     * @param token RWA asset address whose price is being updated.
     * @param price New authoritative price for `token`.
     * @param blockNumber Block reference associated with the quote.
     */
    function updatePrice(
        address token,
        uint256 price,
        uint256 blockNumber
    ) external;

    /**
     * @notice Stores new authoritative prices aligned to `tokens`.
     * @dev Reverts if:
     *      - the caller is not authorized to update RWA prices
     *      - array lengths mismatch or any element is invalid
     *      - any token, price, or block reference is rejected by the implementation
     *
     * Security:
     * - Batch authoritative write path.
     * - Implementations commonly fail atomically if any element is invalid.
     *
     * @param tokens Asset list being updated.
     * @param prices Price list aligned to `tokens`.
     * @param blockNumbers Block-reference list aligned to `tokens`.
     */
    function updatePrices(
        address[] calldata tokens,
        uint256[] calldata prices,
        uint256[] calldata blockNumbers
    ) external;

    /**
     * @notice Configures a supported RWA asset and its freshness metadata.
     * @dev Reverts if:
     *      - the caller is not authorized for parameter changes
     *      - `token` is invalid
     *      - `decimals`, `maxPriceAge`, or other metadata is rejected by the implementation
     *
     * Security:
     * - Governance write path for onboarding and parameter management.
     * - `assetType` and `description` are descriptive metadata and do not replace access control.
     *
     * @param token RWA asset address being configured.
     * @param assetType Governance-defined asset classification label.
     * @param decimals Price scale used by returned quotes.
     * @param maxPriceAge Maximum allowed staleness under the implementation's semantics.
     * @param description Human-readable description for `token`.
     */
    function configureAsset(
        address token,
        string calldata assetType,
        uint8 decimals,
        uint256 maxPriceAge,
        string calldata description
    ) external;

    /**
     * @notice Activates or deactivates a configured RWA asset.
     * @dev Reverts if:
     *      - the caller is not authorized for parameter changes
     *      - `token` is invalid or rejected by the implementation
     *
     * Security:
     * - Governance activation toggle.
     * - Deactivation commonly disables authoritative reads without deleting historical configuration.
     *
     * @param token RWA asset address being updated.
     * @param isActive Whether the asset should be active for authoritative reads.
     */
    function setAssetActive(address token, bool isActive) external;

    /**
     * @notice Updates a named implementation parameter.
     * @dev Reverts if:
     *      - the caller is not authorized for parameter changes
     *      - `paramName` is unknown or rejected by the implementation
     *      - `newValue` violates implementation constraints
     *
     * Security:
     * - Governance parameter-management hook.
     * - Consumers must treat supported parameter names and semantics as implementation-defined.
     *
     * @param paramName Parameter name being updated.
     * @param newValue New value for `paramName`.
     */
    function updateParameter(
        string calldata paramName,
        uint256 newValue
    ) external;
}
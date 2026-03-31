// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPriceOracleAdmin
 * @notice Governance and updater write interface for the protocol's authoritative onchain price source.
 * @dev Reverts if:
 *      - the caller is not authorized by the implementation's governance or updater roles
 *      - assets, prices, or block references are malformed for the requested mutation
 *      - the implementation rejects unsupported assets or invalid configuration updates
 *
 * Security:
 * - Intended for governance, keepers, or updater modules only.
 * - Freshness configuration is block-based and should be expressed via `maxPriceAgeBlocks`.
 * - Price writes define the authoritative onchain quote consumed by protocol valuation paths.
 */
interface IPriceOracleAdmin {
    /**
     * @notice Stores a new price quote for `asset`.
     * @dev Reverts if:
     *      - the caller is not authorized to update prices
     *      - `asset` is invalid or unsupported
     *      - `price` or `blockNumber` is rejected by the implementation
     *
     * Security:
     * - Authoritative write path for a single asset quote.
     * - `blockNumber` is an informational freshness anchor and is expected to follow block-based semantics.
     *
     * @param asset Asset address whose price is being updated.
     * @param price New price in the implementation's canonical price unit.
     * @param blockNumber Block reference associated with the quote.
     */
    function updatePrice(
        address asset,
        uint256 price,
        uint256 blockNumber
    ) external;

    /**
     * @notice Stores new price quotes aligned to `assets`.
     * @dev Reverts if:
     *      - the caller is not authorized to update prices
     *      - array lengths mismatch or any element is invalid
     *      - any asset, price, or block reference is rejected by the implementation
     *
     * Security:
     * - Batch authoritative write path.
     * - Implementations commonly fail atomically if any entry is invalid.
     *
     * @param assets Asset list being updated.
     * @param prices Price list aligned to `assets`.
     * @param blockNumbers Block-reference list aligned to `assets`.
     */
    function updatePrices(
        address[] calldata assets,
        uint256[] calldata prices,
        uint256[] calldata blockNumbers
    ) external;

    /**
     * @notice Configures oracle metadata and freshness rules for `asset`.
     * @dev Reverts if:
     *      - the caller is not authorized for parameter changes
     *      - `asset` is invalid
     *      - `assetDecimals` or `maxPriceAgeBlocks` is rejected by the implementation
     *      - the implementation cannot derive or validate required token metadata
     *
     * Security:
     * - Governance write path for onboarding and parameter management.
     * - `assetDecimals` describes token scaling, while `maxPriceAgeBlocks` is the block-based freshness SSOT.
     *
     * @param asset Asset address being configured.
    * @param sourceId Offchain source identifier used by updater infrastructure.
     * @param assetDecimals Token decimals used for valuation scaling.
     * @param maxPriceAgeBlocks Maximum allowed price staleness in blocks.
     */
    function configureAsset(
        address asset,
        string calldata sourceId,
        uint256 assetDecimals,
        uint256 maxPriceAgeBlocks
    ) external;

    /**
     * @notice Activates or deactivates a configured `asset`.
     * @dev Reverts if:
     *      - the caller is not authorized for parameter changes
     *      - `asset` is invalid or rejected by the implementation
     *
     * Security:
     * - Governance activation toggle.
     * - Deactivation commonly disables authoritative reads without deleting historical configuration.
     *
     * @param asset Asset address being updated.
     * @param isActive Whether the asset should be active for authoritative reads.
     */
    function setAssetActive(address asset, bool isActive) external;
}
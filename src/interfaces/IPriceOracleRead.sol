// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPriceOracleRead
 * @notice Read-only interface for the protocol's authoritative onchain price source.
 * @dev Reverts if:
 *      - protocol implementations reject unsupported, inactive, stale, or malformed price records
 *      - protocol implementations reject invalid asset inputs for the requested read
 *
 * Security:
 * - Preferred dependency for view modules and valuation consumers.
 * - Freshness is block-based: implementations are expected to enforce `maxPriceAgeBlocks`, not wall-clock seconds.
 * - For the protocol's current valuation SSOT, canonical implementations are expected to return `price` in the
 *   asset's valuation unit and `assetDecimals` as the shared amount/price/value scaling basis.
 */
interface IPriceOracleRead {
    /// @notice Canonical stored price record returned by authoritative oracle implementations.
    /// @param price Asset price in the implementation's canonical valuation unit.
    /// @param blockNumber Informational block reference attached to the stored quote.
    /// @param assetDecimals Token decimals used when converting token base units into value.
    /// @param isValid Whether the stored record is marked valid by the implementation.
    struct PriceData {
        uint256 price;
        uint256 blockNumber;
        uint256 assetDecimals;
        bool isValid;
    }

    /// @notice Governance-controlled asset configuration for oracle reads.
    /// @param sourceId Offchain source identifier used by updater infrastructure.
    /// @param assetDecimals Token decimals used for valuation scaling.
    /// @param isActive Whether the asset is currently enabled for authoritative reads.
    /// @param maxPriceAgeBlocks Maximum allowed staleness expressed in blocks.
    struct AssetConfig {
        string sourceId;
        uint256 assetDecimals;
        bool isActive;
        uint256 maxPriceAgeBlocks;
    }

    /**
     * @notice Returns the latest non-stale price tuple for `asset`.
     * @dev Reverts if:
     *      - the implementation rejects an invalid or unsupported `asset`
     *      - the stored price is missing, invalid, or stale under `maxPriceAgeBlocks`
     *      - the implementation detects an invalid update block reference
     *
     * Security:
     * - Authoritative read for consumers that require freshness enforcement.
     * - Implementations are expected to apply block-based staleness checks before returning.
     *
     * @param asset Asset address being queried.
     * @return price Latest price for `asset` in the implementation's canonical valuation unit.
     * @return blockNumber Informational block reference attached to the stored quote.
     * @return assetDecimals Token decimals used for valuation scaling.
     */
    function getPrice(
        address asset
    )
        external
        view
        returns (uint256 price, uint256 blockNumber, uint256 assetDecimals);

    /**
     * @notice Returns the raw stored {PriceData} record for `asset`.
     * @dev Reverts if:
     *      - the implementation rejects an invalid or unsupported `asset`
     *      - the stored record is missing or invalid
     *
     * Security:
     * - Raw read helper for consumers that need the stored record and may apply their own freshness policy.
     * - Implementations may return a valid record even when separate freshness checks would mark it stale.
     *
     * @param asset Asset address being queried.
     * @return priceData Stored price record for `asset`.
     */
    function getPriceData(
        address asset
    ) external view returns (PriceData memory priceData);

    /**
     * @notice Returns the update block used for freshness evaluation of `asset`.
     * @dev Reverts if:
     *      - the implementation rejects an invalid or unsupported `asset`
     *      - the stored price record is missing or invalid
     *
     * Security:
     * - Read-only freshness helper.
     * - The returned value is expected to be compared against `block.number`, not timestamps.
     *
     * @param asset Asset address being queried.
     * @return updateBlock Stored update block for `asset`.
     */
    function getPriceUpdateBlock(
        address asset
    ) external view returns (uint256 updateBlock);

    /**
     * @notice Returns update blocks aligned to `assets`.
     * @dev Reverts if:
     *      - any asset input is invalid or rejected by the implementation
     *      - any referenced price record is missing or invalid
     *
     * Security:
     * - Batch freshness helper.
     * - Implementations commonly fail atomically if any element is invalid.
     *
     * @param assets Asset list being queried.
     * @return updateBlocks Update blocks aligned to `assets`.
     */
    function getPriceUpdateBlocks(
        address[] calldata assets
    ) external view returns (uint256[] memory updateBlocks);

    /**
     * @notice Returns the latest non-stale price tuples aligned to `assets`.
     * @dev Reverts if:
     *      - any asset input is invalid or rejected by the implementation
     *      - any referenced price record is missing, invalid, or stale
     *      - any referenced update block is malformed
     *
     * Security:
     * - Batch authoritative read with freshness enforcement.
     * - Implementations commonly fail atomically if any element is invalid.
     *
     * @param assets Asset list being queried.
     * @return prices Prices aligned to `assets`.
     * @return blockNumbers Informational block references aligned to `assets`.
     * @return assetDecimalsArray Token decimals aligned to `assets`.
     */
    function getPrices(
        address[] calldata assets
    )
        external
        view
        returns (
            uint256[] memory prices,
            uint256[] memory blockNumbers,
            uint256[] memory assetDecimalsArray
        );

    /**
     * @notice Returns whether `asset` currently has a usable price under the implementation's rules.
     * @dev Reverts if:
     *      - (none expected for protocol implementations; invalid states should typically return `false`)
     *
     * Security:
     * - Best-effort validity probe.
     * - Callers should treat `false` as the only safe negative signal and should not infer the exact failure cause.
     *
     * @param asset Asset address being queried.
     * @return isValid Whether the implementation considers the stored price usable right now.
     */
    function isPriceValid(address asset) external view returns (bool isValid);

    /**
     * @notice Returns the configured offchain source identifier for `asset`.
     * @dev Reverts if:
     *      - the implementation rejects an invalid or unsupported `asset`
     *
     * Security:
     * - Read-only metadata helper used by updater and observability tooling.
     *
     * @param asset Asset address being queried.
     * @return sourceId Offchain source identifier configured for `asset`.
     */
    function getAssetSourceId(
        address asset
    ) external view returns (string memory sourceId);

    /**
     * @notice Returns the governance configuration for `asset`.
     * @dev Reverts if:
     *      - the implementation rejects an invalid `asset`
     *
     * Security:
     * - Read-only metadata helper.
     * - `maxPriceAgeBlocks` is the SSOT for freshness windows and should be interpreted in blocks.
     *
     * @param asset Asset address being queried.
     * @return config Governance-controlled oracle configuration for `asset`.
     */
    function getAssetConfig(
        address asset
    ) external view returns (AssetConfig memory config);

    /**
     * @notice Returns the list of assets tracked by the oracle implementation.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only enumeration helper.
     * - Returned entries may include assets that are currently inactive, depending on implementation semantics.
     *
     * @return assets Asset list tracked by the implementation.
     */
    function getSupportedAssets()
        external
        view
        returns (address[] memory assets);

    /**
     * @notice Returns the number of assets tracked by the oracle implementation.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only enumeration helper.
     *
     * @return count Number of tracked assets.
     */
    function getAssetCount() external view returns (uint256 count);
}

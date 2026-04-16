// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPriceOracleRead} from "./IPriceOracleRead.sol";
import {IPriceOracleAdmin} from "./IPriceOracleAdmin.sol";

/**
 * @title IPriceOracle
 * @notice Legacy umbrella interface for querying and administering per-asset prices.
 * @dev Reverts if:
 *      - see inherited {IPriceOracleRead} and {IPriceOracleAdmin} semantics
 *
 * Security:
 * - Compatibility-oriented aggregation layer retained for callers that still depend on a combined oracle surface.
 * - New integrations should prefer the narrow read/admin split so authorization boundaries remain explicit.
 * - Freshness semantics are block-based rather than timestamp-based.
 */
interface IPriceOracle is IPriceOracleRead, IPriceOracleAdmin {
    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when attempting to add an already-supported asset (reserved for future use).
    error PriceOracle__AssetAlreadySupported();
    /// @dev Reverts when an asset is not supported/active.
    error PriceOracle__AssetNotSupported();
    /// @dev Reverts when a stored price is stale per `maxPriceAgeBlocks`.
    error PriceOracle__StalePrice();
    /// @dev Reverts when a stored price is missing or invalid.
    error PriceOracle__InvalidPrice();
    /// @dev Reverts when a block number is invalid (e.g., future or decreasing).
    error PriceOracle__InvalidBlockNumber();
    /// @dev Reverts when a caller is unauthorized (reserved for future use).
    error PriceOracle__Unauthorized();
    /// @dev Reverts when token decimals cannot be determined or configured.
    error PriceOracle__AssetDecimalsNotConfigured();
    /// @dev Reverts when configured token decimals are invalid for safe scaling.
    error PriceOracle__InvalidAssetDecimals(uint256 decimals);

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when a price is updated.
     * @dev Event only. Emitted by PriceOracle; `blockNumber` is an informational source marker.
     */
    event PriceUpdated(
        address indexed asset,
        uint256 price,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when an asset config is updated.
     * @dev Event only.
     */
    event AssetConfigUpdated(
        address indexed asset,
        string sourceId,
        bool isActive
    );

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns the latest stored price for `asset` if active and not stale (by block number).
     * @dev Reverts if:
     *      - asset is zero (ZeroAddress)
     *      - asset is not active (PriceOracle__AssetNotSupported)
     *      - stored price is missing/invalid (PriceOracle__InvalidPrice)
     *      - stored update block is in the future or missing (PriceOracle__InvalidBlockNumber)
     *      - stored price is stale per maxPriceAgeBlocks (PriceOracle__StalePrice)
     *
     * Security:
     * - View-only
     * - Returns stored values; callers MUST apply their own oracle-health policy as needed
     * @param asset Asset address.
    * @return price Price in the asset's canonical valuation unit.
     * @return blockNumber Informational block number associated with the quoted price.
     * @return assetDecimals Token decimals used for valuation scaling (NOT price precision).
     */
    function getPrice(
        address asset
    )
        external
        view
        override
        returns (uint256 price, uint256 blockNumber, uint256 assetDecimals);

    /**
     * @notice Returns the raw stored {PriceData} for `asset` (does not enforce staleness).
     * @dev Reverts if:
     *      - asset is zero (ZeroAddress)
     *      - asset is not active (PriceOracle__AssetNotSupported)
     *      - stored price is missing/invalid (PriceOracle__InvalidPrice)
     *
     * Security:
     * - View-only
     * - Does NOT enforce staleness; callers must enforce freshness if required
     * @param asset Asset address.
     * @return priceData Stored price data.
     */
    function getPriceData(
        address asset
    ) external view override returns (PriceData memory priceData);

    /**
     * @notice Returns the block number when the latest stored price for `asset` was updated.
     * @dev Implementations MUST define whether this reverts for inactive/uninitialized assets. The reference
     *      implementation ({PriceOracle}) reverts for unsupported assets and missing/invalid prices.
     *      Reverts in PriceOracle if:
     *      - asset is zero (ZeroAddress)
     *      - asset is not active (PriceOracle__AssetNotSupported)
     *      - stored price is missing/invalid (PriceOracle__InvalidPrice)
     *
     * Security:
     * - View-only
     * @param asset Asset address.
     * @return updateBlock Block number at which the latest price was stored.
     */
    function getPriceUpdateBlock(
        address asset
    ) external view override returns (uint256 updateBlock);

    /**
     * @notice Batch-returns update blocks aligned to `assets`.
     * @dev The reference implementation ({PriceOracle}) reverts atomically if any asset is invalid.
     *      Reverts in PriceOracle if any asset:
     *      - is zero (ZeroAddress)
     *      - is not active (PriceOracle__AssetNotSupported)
     *      - has missing/invalid price (PriceOracle__InvalidPrice)
     *
     * Security:
     * - View-only
     * @param assets Asset address list.
     * @return updateBlocks Update block numbers aligned to `assets`.
     */
    function getPriceUpdateBlocks(
        address[] calldata assets
    ) external view override returns (uint256[] memory updateBlocks);

    /**
     * @notice Batch-returns latest stored prices if all assets are active and not stale (by block number).
     * @dev Reverts if any asset:
     *      - is zero (ZeroAddress)
     *      - is not active (PriceOracle__AssetNotSupported)
     *      - has missing/invalid price (PriceOracle__InvalidPrice)
     *      - has invalid update block (PriceOracle__InvalidBlockNumber)
     *      - is stale per maxPriceAgeBlocks (PriceOracle__StalePrice)
     *
     * Security:
     * - View-only
     * @param assets Asset address list.
    * @return prices Prices in each asset's canonical valuation unit.
     * @return blockNumbers Informational block numbers.
     * @return assetDecimalsArray Token decimals used for valuation scaling.
     */
    function getPrices(
        address[] calldata assets
    )
        external
        view
        override
        returns (
            uint256[] memory prices,
            uint256[] memory blockNumbers,
            uint256[] memory assetDecimalsArray
        );

    /**
     * @notice Returns whether the stored price is currently usable (by block-number staleness rules).
     * @dev Reverts if:
     *      - (none; best-effort)
     *
     * Security:
     * - View-only
     * - Best-effort: returns false for invalid/unknown states
     * @param asset Asset address.
     * @return isValid True if active, initialized, and not stale.
     */
    function isPriceValid(
        address asset
    ) external view override returns (bool isValid);

    /**
    * @notice Returns the configured offchain source identifier for `asset`.
     * @dev Reverts if:
     *      - asset is zero (ZeroAddress)
     *      - asset is not active (PriceOracle__AssetNotSupported)
     *
     * Security:
     * - View-only
     * @param asset Asset address.
     * @return sourceId Offchain source identifier.
     */
    function getAssetSourceId(
        address asset
    ) external view override returns (string memory sourceId);

    /**
     * @notice Returns the asset configuration for `asset`.
     * @dev Reverts if:
     *      - asset is zero (ZeroAddress)
     *
     * Security:
     * - View-only
     * @param asset Asset address.
     * @return config Asset config.
     */
    function getAssetConfig(
        address asset
    ) external view override returns (AssetConfig memory config);

    /**
     * @notice Returns the list of supported assets.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * @return assets Supported assets list.
     */
    function getSupportedAssets()
        external
        view
        override
        returns (address[] memory assets);

    /**
     * @notice Returns the number of supported assets.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * @return count Asset count.
     */
    function getAssetCount() external view override returns (uint256 count);

    /*━━━━━━━━━━━━━━━ ADMIN FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Updates the stored price for `asset` (role-gated in implementations).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_UPDATE_PRICE (via ACM.requireRole)
     *      - asset is zero (ZeroAddress)
     *      - asset is not active (PriceOracle__AssetNotSupported)
     *      - price is zero (PriceOracle__InvalidPrice)
     *      - blockNumber is invalid (PriceOracle__InvalidBlockNumber)
     *      - asset decimals are missing/invalid
     *        (PriceOracle__AssetDecimalsNotConfigured / PriceOracle__InvalidAssetDecimals)
     *
     * Security:
     * - Role-gated (ACTION_UPDATE_PRICE)
     * @param asset Asset address.
    * @param price Price in the asset's canonical valuation unit.
     * @param blockNumber Informational block number associated with the quoted price.
     */
    function updatePrice(
        address asset,
        uint256 price,
        uint256 blockNumber
    ) external override;

    /**
     * @notice Batch-updates stored prices (role-gated in implementations).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_UPDATE_PRICE (via ACM.requireRole)
     *      - array lengths mismatch (AmountMismatch)
     *      - any asset is zero (ZeroAddress)
     *      - any asset is not active (PriceOracle__AssetNotSupported)
     *      - any price is zero (PriceOracle__InvalidPrice)
     *      - any blockNumber is invalid (PriceOracle__InvalidBlockNumber)
     *      - any asset decimals are missing/invalid
     *        (PriceOracle__AssetDecimalsNotConfigured / PriceOracle__InvalidAssetDecimals)
     *
     * Security:
     * - Role-gated (ACTION_UPDATE_PRICE)
     * @param assets Asset list.
    * @param prices Price list in each asset's canonical valuation unit.
     * @param blockNumbers Informational block number list.
     */
    function updatePrices(
        address[] calldata assets,
        uint256[] calldata prices,
        uint256[] calldata blockNumbers
    ) external override;

    /**
     * @notice Configures an asset for this oracle (governance-only in implementations).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     *      - asset is zero (ZeroAddress)
     *      - asset decimals are missing or invalid
     *        (PriceOracle__AssetDecimalsNotConfigured / PriceOracle__InvalidAssetDecimals)
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     * @param asset Asset address.
     * @param sourceId Offchain source identifier.
     * @param assetDecimals Token decimals used for valuation scaling.
     * @param maxPriceAgeBlocks Max allowed staleness in blocks.
     */
    function configureAsset(
        address asset,
        string calldata sourceId,
        uint256 assetDecimals,
        uint256 maxPriceAgeBlocks
    ) external override;

    /**
     * @notice Activate or deactivate an asset (governance-only in implementations).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract)
     *      - caller lacks ACTION_SET_PARAMETER (via ACM.requireRole)
     *      - asset is zero (ZeroAddress)
     *
     * Security:
     * - Role-gated (ACTION_SET_PARAMETER)
     *
     * @param asset Asset address.
     * @param isActive True to activate, false to deactivate.
     */
    function setAssetActive(address asset, bool isActive) external override;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IRWAAssetPriceRead} from "./IRWAAssetPriceRead.sol";
import {IRWAAssetPriceAdmin} from "./IRWAAssetPriceAdmin.sol";

/**
 * @title IRWAPriceOracle
 * @notice Legacy umbrella interface for RWA-scoped authoritative price sources.
 * @dev Reverts if:
 *      - see inherited {IRWAAssetPriceRead} and {IRWAAssetPriceAdmin} semantics
 *
 * Security:
 * - Compatibility-oriented aggregation layer retained for callers that still depend on a combined RWA price surface.
 * - Prefer {IRWAAssetPriceRead} for read consumers and {IRWAAssetPriceAdmin} for governance or updater callers.
 */
interface IRWAPriceOracle is IRWAAssetPriceRead, IRWAAssetPriceAdmin {
    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Emitted when an RWA asset price is updated.
     * @dev Event only.
     * @param token Asset address.
     * @param price Latest USD price.
     * @param blockNumber Update block number.
     */
    event PriceUpdated(
        address indexed token,
        uint256 price,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when RWA asset configuration is updated.
     * @dev Event only.
     * @param token Asset address.
     * @param isActive Whether the asset is active.
     * @param maxPriceAge Maximum allowed price age.
     */
    event RWAAssetConfigUpdated(
        address indexed token,
        bool isActive,
        uint256 maxPriceAge
    );

    /**
     * @notice Emitted when an oracle parameter is updated.
     * @dev Event only.
     * @param paramName Parameter name.
     * @param oldValue Previous value.
     * @param newValue New value.
     */
    event RWAParameterUpdated(
        string indexed paramName,
        uint256 oldValue,
        uint256 newValue
    );

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when a required address parameter is zero.
    error RWAPriceOracle__ZeroAddress();

    /// @dev Reverts when the requested RWA asset is not supported.
    error RWAPriceOracle__AssetNotSupported();

    /// @dev Reverts when the supplied or stored price is invalid.
    error RWAPriceOracle__InvalidPrice();

    /// @dev Reverts when the stored price is stale under the implementation's freshness rules.
    error RWAPriceOracle__StalePrice();

    /// @dev Reverts when the caller is not authorized to perform the operation.
    error RWAPriceOracle__Unauthorized();

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns the USD price for `token`.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceRead.getPriceUSD}
     *
     * Security:
     * - Read-only compatibility alias for the narrow RWA price read surface.
     *
     * @param token Target asset address.
     * @return price Current USD price.
     * @return decimals Price decimals.
     */
    function getPriceUSD(
        address token
    ) external view override returns (uint256 price, uint8 decimals);

    /**
     * @notice Returns the full price data struct for `token`.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceRead.getPriceData}
     *
     * Security:
     * - Read-only compatibility alias for the narrow RWA price read surface.
     *
     * @param token Target asset address.
     * @return priceData Price data struct.
     */
    function getPriceData(
        address token
    ) external view override returns (RWAPriceData memory priceData);

    /**
     * @notice Batch-returns USD prices for multiple RWA assets.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceRead.getPricesUSD}
     *
     * Security:
     * - Read-only compatibility alias for the narrow RWA price read surface.
     *
     * @param tokens Asset addresses.
     * @return prices Prices aligned with `tokens`.
     * @return decimalsArray Decimals aligned with `tokens`.
     */
    function getPricesUSD(
        address[] calldata tokens
    )
        external
        view
        override
        returns (uint256[] memory prices, uint8[] memory decimalsArray);

    /**
     * @notice Returns whether the stored price for `token` is valid.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceRead.isPriceValid}
     *
     * Security:
     * - Read-only compatibility alias for the narrow RWA price read surface.
     *
     * @param token Asset address.
     * @return isValid Whether the price is valid.
     */
    function isPriceValid(
        address token
    ) external view override returns (bool isValid);

    /**
     * @notice Returns the configuration for `token`.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceRead.getAssetConfig}
     *
     * Security:
     * - Read-only compatibility alias for the narrow RWA price read surface.
     *
     * @param token Asset address.
     * @return config Asset configuration struct.
     */
    function getAssetConfig(
        address token
    ) external view override returns (RWAAssetConfig memory config);

    /**
     * @notice Returns the list of supported RWA assets.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceRead.getSupportedAssets}
     *
     * Security:
     * - Read-only compatibility alias for the narrow RWA price read surface.
     *
     * @return tokens Supported asset addresses.
     */
    function getSupportedAssets()
        external
        view
        override
        returns (address[] memory tokens);

    /**
     * @notice Returns the number of supported RWA assets.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceRead.getAssetCount}
     *
     * Security:
     * - Read-only compatibility alias for the narrow RWA price read surface.
     *
     * @return count Supported asset count.
     */
    function getAssetCount() external view override returns (uint256 count);

    /*━━━━━━━━━━━━━━━ Admin Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Updates the price of `token`.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceAdmin.updatePrice}
     *
     * Security:
     * - Governance compatibility alias for the narrow RWA price admin surface.
     *
     * @param token Asset address.
     * @param price USD price, typically with 8 decimals.
     * @param blockNumber Price block number.
     */
    function updatePrice(
        address token,
        uint256 price,
        uint256 blockNumber
    ) external override;

    /**
     * @notice Batch-updates prices for multiple RWA assets.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceAdmin.updatePrices}
     *
     * Security:
     * - Governance compatibility alias for the narrow RWA price admin surface.
     *
     * @param tokens Asset addresses.
     * @param prices Price values aligned with `tokens`.
     * @param blockNumbers Price block numbers aligned with `tokens`.
     */
    function updatePrices(
        address[] calldata tokens,
        uint256[] calldata prices,
        uint256[] calldata blockNumbers
    ) external override;

    /**
     * @notice Configures a supported RWA asset.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceAdmin.configureAsset}
     *
     * Security:
     * - Governance compatibility alias for the narrow RWA price admin surface.
     *
     * @param token Asset address.
     * @param assetType Asset type.
     * @param decimals Asset decimals.
     * @param maxPriceAge Maximum allowed price age.
     * @param description Asset description.
     */
    function configureAsset(
        address token,
        string calldata assetType,
        uint8 decimals,
        uint256 maxPriceAge,
        string calldata description
    ) external override;

    /**
     * @notice Activates or deactivates a configured RWA asset.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceAdmin.setAssetActive}
     *
     * Security:
     * - Governance compatibility alias for the narrow RWA price admin surface.
     *
     * @param token Asset address.
     * @param isActive Whether the asset should be active.
     */
    function setAssetActive(address token, bool isActive) external override;

    /**
     * @notice Updates an oracle parameter.
     * @dev Reverts if:
     *      - see {IRWAAssetPriceAdmin.updateParameter}
     *
     * Security:
     * - Governance compatibility alias for the narrow RWA price admin surface.
     *
     * @param paramName Parameter name.
     * @param newValue New value.
     */
    function updateParameter(
        string calldata paramName,
        uint256 newValue
    ) external override;
}

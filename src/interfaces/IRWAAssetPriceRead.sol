// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IRWAAssetPriceRead
 * @notice Read-only interface for RWA-scoped authoritative price sources.
 * @dev Reverts if:
 *      - protocol implementations reject invalid or unsupported RWA assets
 *      - stored RWA price data is missing, invalid, or stale under implementation-defined freshness rules
 *
 * Security:
 * - Use this interface for consumers that only need RWA price reads, not administration.
 * - Freshness semantics are implementation-defined in this family and are exposed through configuration metadata.
 * - `decimals` describes the returned price scale, not necessarily the underlying token decimals.
 */
interface IRWAAssetPriceRead {
    /// @notice Canonical stored RWA price record returned by RWA price implementations.
    /// @param price Asset price in the implementation's canonical unit.
    /// @param blockNumber Informational block reference attached to the quote.
    /// @param decimals Price scale used by `price`.
    /// @param isValid Whether the stored record is marked valid.
    /// @param assetType Governance-defined asset classification label.
    struct RWAPriceData {
        uint256 price;
        uint256 blockNumber;
        uint8 decimals;
        bool isValid;
        string assetType;
    }

    /// @notice Governance-controlled configuration for an RWA asset price route.
    /// @param assetType Governance-defined asset classification label.
    /// @param decimals Price scale used for returned quotes.
    /// @param isActive Whether the asset is active for authoritative reads.
    /// @param maxPriceAge Maximum allowed staleness under the implementation's semantics.
    /// @param description Human-readable asset description.
    struct RWAAssetConfig {
        string assetType;
        uint8 decimals;
        bool isActive;
        uint256 maxPriceAge;
        string description;
    }

    /**
     * @notice Returns the authoritative USD price for `token`.
     * @dev Reverts if:
     *      - the implementation rejects an invalid or unsupported `token`
     *      - the stored price is missing, invalid, or stale
     *
     * Security:
     * - Authoritative single-asset read for RWA valuations.
     * - Callers must use the returned `decimals` when scaling `price`.
     *
     * @param token RWA asset address being queried.
     * @return price Latest authoritative USD price for `token`.
     * @return decimals Price scale used by `price`.
     */

    function getPriceUSD(
        address token
    ) external view returns (uint256 price, uint8 decimals);

    function getPriceData(
        address token
    ) external view returns (RWAPriceData memory priceData);

    function getPricesUSD(
        address[] calldata tokens
    )
        external
        view
        returns (uint256[] memory prices, uint8[] memory decimalsArray);

    /**
     * @notice Returns whether `token` currently has a usable RWA price.
     * @dev Reverts if:
     *      - (none expected; implementations typically return `false` for invalid states)
     *
     * Security:
     * - Best-effort validity probe.
     * - Callers should not infer the exact failure cause from a `false` result.
     *
     * @param token RWA asset address being queried.
     * @return isValid Whether the implementation considers the current price usable.
     */
    function isPriceValid(address token) external view returns (bool isValid);

    function getAssetConfig(
        address token
    ) external view returns (RWAAssetConfig memory config);

    function getSupportedAssets()
        external
        view
        returns (address[] memory tokens);

    function getAssetCount() external view returns (uint256 count);
}

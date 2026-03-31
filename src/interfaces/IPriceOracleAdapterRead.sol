// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPriceOracleAdapterRead
 * @notice Read-only interface for external or heterogeneous oracle adapters.
 * @dev Reverts if:
 *      - protocol implementations reject invalid assets or unsupported oracle routes
 *      - the selected adapter cannot return a usable normalized price output
 *
 * Security:
 * - Use this interface when callers only need standardized adapter outputs.
 * - Adapter reads may normalize heterogeneous sources into a common tuple, but freshness and validity remain
 *   implementation-defined.
 * - `oracleType` is descriptive routing metadata and must not be treated as an authorization primitive.
 */
interface IPriceOracleAdapterRead {
    /// @notice Normalized adapter price record for heterogeneous oracle sources.
    /// @param price Normalized price output in the implementation's canonical unit.
    /// @param blockNumber Informational block reference attached to the quote.
    /// @param assetDecimals Token decimals used for valuation scaling.
    /// @param isValid Whether the adapter considers the record valid.
    /// @param oracleType Adapter type label used to route or describe the source.
    struct PriceData {
        uint256 price;
        uint256 blockNumber;
        uint256 assetDecimals;
        bool isValid;
        string oracleType;
    }

    /**
     * @notice Returns the normalized price tuple for `asset` from the configured adapter route.
     * @dev Reverts if:
     *      - the implementation rejects an invalid `asset`
     *      - no supported oracle route is configured for `asset`
     *      - the adapter cannot supply a usable normalized price
     *
     * Security:
     * - Read-only adapter facade.
     * - Consumers should still honor the implementation's validity and freshness semantics.
     *
     * @param asset Asset address being queried.
     * @return price Normalized price for `asset`.
     * @return blockNumber Informational block reference attached to the quote.
     * @return assetDecimals Token decimals used for valuation scaling.
     */
    function getPrice(
        address asset
    )
        external
        view
        returns (uint256 price, uint256 blockNumber, uint256 assetDecimals);

    /**
     * @notice Returns the normalized adapter record for `asset`.
     * @dev Reverts if:
     *      - the implementation rejects an invalid `asset`
     *      - no supported oracle route is configured for `asset`
     *      - the adapter cannot supply a normalized record
     *
     * Security:
     * - Read-only adapter metadata helper.
     * - `oracleType` reveals routing metadata but not implementation-specific trust guarantees.
     *
     * @param asset Asset address being queried.
     * @return priceData Normalized adapter record for `asset`.
     */
    function getPriceData(
        address asset
    ) external view returns (PriceData memory priceData);

    /**
     * @notice Returns normalized price tuples aligned to `assets`.
     * @dev Reverts if:
     *      - any asset input is invalid or unsupported
     *      - any configured adapter route cannot supply a usable price
     *
     * Security:
     * - Batch adapter read.
     * - Implementations commonly fail atomically if any element is invalid.
     *
     * @param assets Asset list being queried.
     * @return prices Normalized prices aligned to `assets`.
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
     * @notice Returns whether `asset` currently has a valid adapter-backed price.
     * @dev Reverts if:
     *      - (none expected; implementations typically return `false` for invalid states)
     *
     * Security:
     * - Best-effort validity probe.
     * - Callers should not infer the exact adapter failure reason from a `false` return.
     *
     * @param asset Asset address being queried.
     * @return isValid Whether a configured adapter route currently yields a valid price for `asset`.
     */
    function isPriceValid(address asset) external view returns (bool isValid);

    /**
     * @notice Returns the list of oracle type labels supported by the adapter layer.
     * @dev Reverts if:
     *      - (none expected)
     *
     * Security:
     * - Read-only metadata helper for routing and observability.
     *
     * @return oracleTypes Supported oracle type labels.
     */
    function getSupportedOracleTypes()
        external
        view
        returns (string[] memory oracleTypes);

    /**
     * @notice Returns whether `oracleType` is supported by the adapter layer.
     * @dev Reverts if:
     *      - (none expected; implementations typically return `false` for unknown labels)
     *
     * Security:
     * - Read-only routing helper.
     *
     * @param oracleType Oracle type label being queried.
     * @return isSupported Whether `oracleType` is recognized by the adapter layer.
     */
    function isOracleTypeSupported(
        string calldata oracleType
    ) external view returns (bool isSupported);

    /**
     * @notice Returns the configured oracle type label for `asset`.
     * @dev Reverts if:
     *      - the implementation rejects an invalid `asset`
     *      - no oracle route is configured for `asset`
     *
     * Security:
     * - Read-only routing helper.
     * - The returned label is descriptive metadata used to explain which adapter family serves `asset`.
     *
     * @param asset Asset address being queried.
     * @return oracleType Oracle type label configured for `asset`.
     */
    function getAssetOracleType(
        address asset
    ) external view returns (string memory oracleType);
}
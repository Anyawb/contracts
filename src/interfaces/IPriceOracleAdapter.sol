// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPriceOracleAdapter
/// @notice Oracle adapter interface for unified price access across multiple oracle types.
/// @dev Designed to align with docs/SmartContractStandard.md naming and error conventions.
interface IPriceOracleAdapter {
    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    
    /// @dev Reverts when an oracle type is not supported.
    error PriceOracleAdapter__UnsupportedOracle();
    /// @dev Reverts when an oracle address is invalid (e.g., zero or non-contract).
    error PriceOracleAdapter__InvalidOracleAddress();
    /// @dev Reverts when an oracle call fails.
    error PriceOracleAdapter__OracleCallFailed();

    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/

    /// @notice Price data structure.
    struct PriceData {
        /// @notice Price in USD-8 (e.g., $1.00 = 100000000).
        uint256 price;
        /// @notice Informational block number associated with the quoted price.
        uint256 blockNumber;
        /// @notice Token decimals used for valuation scaling (NOT price precision).
        uint256 assetDecimals;
        /// @notice Whether the returned price is valid.
        bool isValid;
        /// @notice Oracle type identifier (e.g., "chainlink", "uniswap", "redstone").
        string oracleType;
    }

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/
    
    /// @notice Emitted when an oracle call is performed.
    /// @dev Emission semantics are implementation-defined; may be emitted on best-effort calls.
    event OracleCall(address indexed asset, address indexed oracle, string oracleType, bool success);

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the latest price for an asset.
     * @dev Reverts if:
     *      - asset is zero (implementation-defined)
     *      - oracle type is unsupported (PriceOracleAdapter__UnsupportedOracle)
     *      - oracle address is invalid (PriceOracleAdapter__InvalidOracleAddress)
     *      - oracle call fails (PriceOracleAdapter__OracleCallFailed)
     *
     * Security:
     * - View-only
     *
     * @param asset Asset address.
     * @return price Price in USD-8 (e.g., $1.00 = 100000000).
     * @return blockNumber Informational block number associated with the quoted price.
     * @return assetDecimals Token decimals used for valuation scaling (NOT price precision).
     */
    function getPrice(address asset) external view returns (uint256 price, uint256 blockNumber, uint256 assetDecimals);

    /**
     * @notice Get full price data for an asset.
     * @dev Reverts if:
     *      - asset is zero (implementation-defined)
     *      - oracle type is unsupported (PriceOracleAdapter__UnsupportedOracle)
     *      - oracle address is invalid (PriceOracleAdapter__InvalidOracleAddress)
     *      - oracle call fails (PriceOracleAdapter__OracleCallFailed)
     *
     * Security:
     * - View-only
     *
     * @param asset Asset address.
     * @return priceData Price data struct.
     */
    function getPriceData(address asset) external view returns (PriceData memory priceData);

    /**
     * @notice Batch get prices for multiple assets.
     * @dev Reverts if:
     *      - any asset is zero (implementation-defined)
     *      - any oracle type is unsupported (PriceOracleAdapter__UnsupportedOracle)
     *      - any oracle address is invalid (PriceOracleAdapter__InvalidOracleAddress)
     *      - any oracle call fails (PriceOracleAdapter__OracleCallFailed)
     *
     * Security:
     * - View-only
     *
     * @param assets Asset address list.
     * @return prices Price list in USD-8.
     * @return blockNumbers Informational block number list.
     * @return assetDecimalsArray Token decimals used for valuation scaling (NOT price precision).
     */
    function getPrices(address[] calldata assets) external view returns (
        uint256[] memory prices,
        uint256[] memory blockNumbers,
        uint256[] memory assetDecimalsArray
    );

    /**
     * @notice Check whether the price is valid (non-zero and not stale).
     * @dev Reverts if:
     *      - (none; best-effort)
     *
     * Security:
     * - View-only
     * - Best-effort: returns false on invalid/unknown states
     *
     * @param asset Asset address.
     * @return isValid True if valid, otherwise false.
     */
    function isPriceValid(address asset) external view returns (bool isValid);

    /**
     * @notice Get supported oracle types.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @return oracleTypes Supported oracle type identifiers.
     */
    function getSupportedOracleTypes() external view returns (string[] memory oracleTypes);

    /**
     * @notice Check whether an oracle type is supported.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @param oracleType Oracle type identifier.
     * @return isSupported True if supported, otherwise false.
     */
    function isOracleTypeSupported(string calldata oracleType) external view returns (bool isSupported);

    /**
     * @notice Get the oracle type configured for an asset.
     * @dev Reverts if:
     *      - asset is zero (implementation-defined)
     *      - oracle type is not configured (implementation-defined)
     *
     * Security:
     * - View-only
     *
     * @param asset Asset address.
     * @return oracleType Oracle type identifier.
     */
    function getAssetOracleType(address asset) external view returns (string memory oracleType);

    /*━━━━━━━━━━━━━━━ ADMIN FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Register an oracle implementation (governance-only in implementations).
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - oracleType is unsupported (PriceOracleAdapter__UnsupportedOracle)
     *      - oracleAddress is invalid (PriceOracleAdapter__InvalidOracleAddress)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param oracleType Oracle type identifier.
     * @param oracleAddress Oracle address.
     */
    function registerOracle(string calldata oracleType, address oracleAddress) external;

    /**
     * @notice Configure oracle type for an asset (governance-only in implementations).
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - asset is zero (implementation-defined)
     *      - oracleType is unsupported (PriceOracleAdapter__UnsupportedOracle)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param asset Asset address.
     * @param oracleType Oracle type identifier.
     */
    function configureAssetOracle(address asset, string calldata oracleType) external;

    /**
     * @notice Batch configure oracle types for assets (governance-only in implementations).
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - array lengths mismatch (implementation-defined)
     *      - any asset is zero (implementation-defined)
     *      - any oracleType is unsupported (PriceOracleAdapter__UnsupportedOracle)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param assets Asset address list.
     * @param oracleTypes Oracle type identifiers aligned to `assets`.
     */
    function configureAssetOracles(
        address[] calldata assets,
        string[] calldata oracleTypes
    ) external;
}

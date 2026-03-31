// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// SafeMath removed in OZ v5; Solidity 0.8+ enforces overflow checks
import {IPriceOracleRead} from "../interfaces/IPriceOracleRead.sol";
import {IPriceOracleAdapterRead} from "../interfaces/IPriceOracleAdapterRead.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title GracefulDegradation
 * @notice Library for best-effort asset valuation with fallback strategies.
 * @dev Tolerates oracle failures by returning conservative values, cached values, or stablecoin face-value logic.
 *      Cache usage:
 *      - View functions read cache only (no writes).
 *      - Use {getAssetValueWithFallback} for read-only pricing.
 *      Decimals validation:
 *      - Minimum decimals: 6 (supports common stablecoins).
 *      - Maximum decimals: 18 (ERC-20 standard).
 *      Price precision:
 *      - Price units depend on the underlying oracle and MUST NOT be assumed 1e18.
 */
library GracefulDegradation {
    /*━━━━━━━━━━━━━━━ CONSTANTS ━━━━━━━━━━━━━━━*/
    /// @notice Default maximum staleness in blocks (chain-dependent).
    uint256 private constant MAX_PRICE_AGE_BLOCKS = 300;

    /// @notice Minimum supported decimals (prevents unit mismatch).
    /// @dev Set to 6 to support common stablecoins (e.g., USDC/USDT).
    uint256 private constant MIN_DECIMALS = 6;

    /// @notice Maximum supported decimals.
    uint256 private constant MAX_DECIMALS = 18;

    /// @notice Stablecoin price tolerance (bps, default 1%).
    uint256 private constant STABLECOIN_TOLERANCE = 100;

    /// @notice Minimum historical price points for reasonableness checks.
    uint256 private constant MIN_HISTORICAL_PRICES = 3;

    /// @notice Maximum reasonable price (backward-compatible constant).
    uint256 internal constant MAX_REASONABLE_PRICE = 1e12;

    /*━━━━━━━━━━━━━━━ SEMANTIC CONSTANTS ━━━━━━━━━━━━━━━*/
    /// @notice $1.00 in protocol USD-8 precision.
    uint256 private constant ONE_USD = 1e8;

    /// @notice Basis-point divisor (100% = 10_000 bps).
    uint256 private constant BASIS_POINT_DIVISOR = 10000;

    /// @notice 100% in basis points.
    uint256 private constant BASIS_POINT_100_PERCENT = 10000;

    /// @notice Default maximum reasonable price (1e12).
    uint256 private constant DEFAULT_MAX_REASONABLE_PRICE = 1e12;

    /// @notice Default conservative valuation ratio (50%).
    uint256 private constant DEFAULT_CONSERVATIVE_RATIO = 5000;

    /// @notice Default price update threshold (blocks; chain-dependent).
    uint256 private constant DEFAULT_PRICE_UPDATE_THRESHOLD = 300;

    /// @notice Default max price multiplier (150%).
    uint256 private constant DEFAULT_MAX_PRICE_MULTIPLIER = 15000;

    /// @notice Default min price multiplier (50%).
    uint256 private constant DEFAULT_MIN_PRICE_MULTIPLIER = 5000;

    /// @notice Default retry configuration.
    uint256 private constant DEFAULT_MAX_RETRY_COUNT = 1;
    uint256 private constant DEFAULT_RETRY_DELAY = 0; // Immediate retry.
    uint256 private constant DEFAULT_MAX_GAS_LIMIT = 500000; // 500k gas.

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when a zero oracle address is supplied.
    error GracefulDegradation__InvalidPriceOracleAddress();

    /// @dev Reverts when a zero asset address is supplied.
    error GracefulDegradation__InvalidAssetAddress();

    /// @dev Reverts when a zero amount input is not allowed.
    error GracefulDegradation__AmountMustBeGreaterThanZero();

    /// @dev Reverts when an exponent exceeds the library safe bound.
    /// @param exponent Requested exponent.
    /// @param maxExponent Maximum supported exponent.
    error GracefulDegradation__ExponentTooHigh(
        uint256 exponent,
        uint256 maxExponent
    );

    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/
    /// @notice Price retrieval result.
    struct PriceResult {
        /// @notice Computed value.
        uint256 value;
        /// @notice Price update block (block.number).
        uint256 updateBlock;
        /// @notice Price age in blocks.
        uint256 ageBlocks;
        /// @notice Whether the result is considered valid.
        bool isValid;
        /// @notice Whether a fallback strategy was used.
        bool usedFallback;
        /// @notice Reason string for the outcome.
        string reason;
    }

    /// @notice Degradation configuration (backward-compatible).
    struct DegradationConfig {
        uint256 conservativeRatio; // Conservative ratio (bps, default 50%).
        bool useStablecoinFaceValue; // Whether to use face value for stablecoins.
        bool enablePriceCache; // Whether price cache is enabled.
        address settlementToken; // Settlement token address.
        PriceValidationConfig priceValidation; // Price validation config.
        StablecoinConfig stablecoinConfig; // Primary stablecoin config.
        StablecoinConfig[] additionalStablecoinConfigs; // Additional stablecoin configs.
        RetryConfig retryConfig; // Retry config.
    }

    /// @notice Price validation configuration.
    struct PriceValidationConfig {
        uint256 maxPriceMultiplier; // Max multiplier vs historical price (bps).
        uint256 minPriceMultiplier; // Min multiplier vs historical price (bps).
        uint256 priceUpdateThreshold; // Price update threshold (blocks).
        uint256 maxPriceAgeBlocks; // Max price age in blocks.
        uint256 maxReasonablePrice; // Max reasonable price (dynamic).
        bool enableHistoricalValidation; // Whether historical validation is enabled.
    }
    /// @notice Stablecoin validation configuration.
    struct StablecoinConfig {
        address stablecoin; // Stablecoin address.
        bool isWhitelisted; // Whether whitelisted.
        bool enableDepegDetection; // Whether to detect depeg.
        uint256 expectedPrice; // Expected price (oracle precision, protocol uses USD-8).
        uint256 tolerance; // Tolerance (bps).
        uint256 assetDecimals; // Token decimals used for fallback valuation.
    }

    /// @notice Price cache entry.
    struct PriceCache {
        uint256 price;
        uint256 updateBlock;
        uint256 assetDecimals;
        bool isValid;
    }

    /// @notice Retry configuration.
    struct RetryConfig {
        uint256 maxRetryCount; // Max retry count.
        uint256 retryDelay; // Retry delay (blocks; informational).
        uint256 maxGasLimit; // Max gas limit.
        bool enableRetry; // Whether retry is enabled.
        bool retryOnNetworkError; // Retry on network error.
        bool retryOnTimeout; // Retry on timeout.
    }

    /// @notice Cache storage used by calling contracts.
    struct CacheStorage {
        mapping(address => PriceCache) priceCache;
        mapping(address => uint256) nonces;
    }

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/
    // Note: Libraries do not emit events; events should be emitted by calling contracts.

    /*━━━━━━━━━━━━━━━ CORE FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get asset value with graceful degradation (cache read only).
     * @dev Reverts if:
     *      - (none; best-effort, oracle failures are caught and return fallback values)
     *      - (does not revert for invalid inputs; see fallback semantics)
     *
     * Security:
     * - View-only; MUST NOT mutate cache storage
     * - Best-effort: failures return fallback values and set result.usedFallback = true
     * - updateBlock == 0 indicates unknown update block (oracle query failed)
     *
     * @param priceOracleAddr Price oracle address.
     * @param assetAddr Asset address.
     * @param amountValue Asset amount (token decimals).
     * @param config Degradation configuration.
     * @param cacheStorage Cache storage (read-only).
     * @return result Price retrieval result (value units depend on oracle price precision).
     */
    function getAssetValueWithFallback(
        address priceOracleAddr,
        address assetAddr,
        uint256 amountValue,
        DegradationConfig memory config,
        CacheStorage storage cacheStorage
    ) internal view returns (PriceResult memory result) {
        if (amountValue == 0) {
            result.value = 0;
            result.isValid = true;
            result.reason = "Zero amount";
            result.usedFallback = false;
            result.updateBlock = 0;
            result.ageBlocks = 0;
            return result;
        }

        // Best-effort input guards (never revert).
        if (priceOracleAddr == address(0)) {
            return
                _applyFallbackStrategy(
                    priceOracleAddr,
                    assetAddr,
                    amountValue,
                    "Invalid price oracle address",
                    config
                );
        }
        if (assetAddr == address(0)) {
            return
                _applyFallbackStrategy(
                    priceOracleAddr,
                    assetAddr,
                    amountValue,
                    "Invalid asset address",
                    config
                );
        }

        // Use retry helper to fetch price.
        (
            uint256 price,
            ,
            uint256 assetDecimals,
            bool success,
            string memory errorReason
        ) = _getPriceWithRetry(priceOracleAddr, assetAddr, config.retryConfig);

        if (!success) {
            // Handle price fetch failure.
            if (config.enablePriceCache) {
                PriceCache memory cachedPrice = _getCachedPrice(
                    assetAddr,
                    cacheStorage
                );
                if (
                    cachedPrice.isValid &&
                    !_isCacheExpired(
                        cachedPrice.updateBlock,
                        config.priceValidation.maxPriceAgeBlocks
                    )
                ) {
                    uint256 cachedCalculatedValue = calculateAssetValue(
                        amountValue,
                        cachedPrice.price,
                        cachedPrice.assetDecimals
                    );
                    if (cachedCalculatedValue > 0) {
                        result.value = cachedCalculatedValue;
                        result.isValid = true;
                        result.reason = string(
                            abi.encodePacked(
                                "Used cache after retry: ",
                                errorReason
                            )
                        );
                        result.usedFallback = true;
                        result.updateBlock = cachedPrice.updateBlock;
                        result.ageBlocks = (cachedPrice.updateBlock > 0 &&
                            cachedPrice.updateBlock <= block.number)
                            ? (block.number - cachedPrice.updateBlock)
                            : 0;
                        return result;
                    }
                }
            }

            // Apply fallback strategy.
            return
                _applyFallbackStrategy(
                    priceOracleAddr,
                    assetAddr,
                    amountValue,
                    string(
                        abi.encodePacked(
                            "Price oracle retry failed: ",
                            errorReason
                        )
                    ),
                    config
                );
        }

        // Validate decimals (min precision guard).
        if (!validateDecimals(assetDecimals)) {
            return
                _applyFallbackStrategy(
                    priceOracleAddr,
                    assetAddr,
                    amountValue,
                    "Invalid decimals",
                    config
                );
        }

        // Validate asset decimals reasonableness.
        if (!validateAssetDecimals(assetAddr, assetDecimals)) {
            return
                _applyFallbackStrategy(
                    priceOracleAddr,
                    assetAddr,
                    amountValue,
                    "Invalid asset decimals",
                    config
                );
        }

        // Validate price non-zero.
        if (price == 0) {
            return
                _applyFallbackStrategy(
                    priceOracleAddr,
                    assetAddr,
                    amountValue,
                    "Zero price",
                    config
                );
        }

        // NOTE: staleness is enforced by the authoritative read boundary itself (see {IPriceOracleRead.getPrice}).
        // This library does not re-implement age checks or rely on wall-clock time.
        uint256 updateBlock = _tryGetUpdateBlock(priceOracleAddr, assetAddr);
        uint256 ageBlocks = (updateBlock > 0 && updateBlock <= block.number)
            ? (block.number - updateBlock)
            : 0;

        // Validate price reasonableness (dynamic rules).
        if (
            !validatePriceReasonableness(
                price,
                assetAddr,
                config.priceValidation,
                cacheStorage
            )
        ) {
            return
                _applyFallbackStrategy(
                    priceOracleAddr,
                    assetAddr,
                    amountValue,
                    "Unreasonable price",
                    config
                );
        }

        (
            bool hasStablecoinConfig,
            StablecoinConfig memory matchedStablecoinConfig
        ) = _findStablecoinConfig(assetAddr, config);
        if (
            hasStablecoinConfig &&
            matchedStablecoinConfig.enableDepegDetection
        ) {
            if (
                !validateStablecoinPrice(
                    price,
                    matchedStablecoinConfig.expectedPrice,
                    matchedStablecoinConfig.tolerance
                )
            ) {
                return
                    _buildConservativeFallback(
                        amountValue,
                        "Stablecoin depeg detected",
                        config.conservativeRatio
                    );
            }
        }

        // Compute value (safe arithmetic).
        uint256 calculatedValue = calculateAssetValue(
            amountValue,
            price,
            assetDecimals
        );
        if (calculatedValue == 0) {
            // Best-effort: allow 0 value (rounding) without reverting; mark as valid.
            // Downstream callers may treat 0 as acceptable for tiny amounts.
            result.value = 0;
            result.isValid = true;
            result.reason = "Price calc ok: rounded to 0";
            result.usedFallback = false;
            result.updateBlock = updateBlock;
            result.ageBlocks = ageBlocks;
            return result;
        }

        // Note: cache writes are performed only in non-view functions.

        // Successful price computation.
        result.value = calculatedValue;
        result.isValid = true;
        result.reason = "Price calculation successful";
        result.usedFallback = false;
        result.updateBlock = updateBlock;
        result.ageBlocks = ageBlocks;
    }

    /**
     * @notice Get asset value with graceful degradation (backward-compatible overload).
     * @dev Reverts if:
     *      - (none; best-effort, oracle failures are caught and return fallback values)
     *      - (does not revert for invalid inputs; see fallback semantics)
     *
     * Security:
     * - View-only; does not write cache
     * - Best-effort: failures return fallback values and set result.usedFallback = true
     *
     * @param priceOracleAddr Price oracle address.
     * @param assetAddr Asset address.
     * @param amountValue Asset amount (token decimals).
     * @param config Degradation configuration.
     * @return result Price retrieval result (value units depend on oracle price precision).
     */
    function getAssetValueWithFallback(
        address priceOracleAddr,
        address assetAddr,
        uint256 amountValue,
        DegradationConfig memory config
    ) internal view returns (PriceResult memory result) {
        if (amountValue == 0) {
            result.value = 0;
            result.isValid = true;
            result.reason = "Zero amount";
            result.usedFallback = false;
            result.updateBlock = 0;
            result.ageBlocks = 0;
            return result;
        }

        // Best-effort input guards (never revert).
        if (priceOracleAddr == address(0)) {
            return
                _applyFallbackStrategy(
                    priceOracleAddr,
                    assetAddr,
                    amountValue,
                    "Invalid price oracle address",
                    config
                );
        }
        if (assetAddr == address(0)) {
            return
                _applyFallbackStrategy(
                    priceOracleAddr,
                    assetAddr,
                    amountValue,
                    "Invalid asset address",
                    config
                );
        }

        // Try the onchain oracle directly (staleness is enforced by the oracle contract).
        try IPriceOracleRead(priceOracleAddr).getPrice(assetAddr) returns (
            uint256 price,
            uint256 /* sourceTimestamp */,
            uint256 assetDecimals
        ) {
            // Validate decimals (min precision guard).
            if (!validateDecimals(assetDecimals)) {
                return
                    _applyFallbackStrategy(
                        priceOracleAddr,
                        assetAddr,
                        amountValue,
                        "Invalid decimals",
                        config
                    );
            }

            // Validate asset decimals reasonableness.
            if (!validateAssetDecimals(assetAddr, assetDecimals)) {
                return
                    _applyFallbackStrategy(
                        priceOracleAddr,
                        assetAddr,
                        amountValue,
                        "Invalid asset decimals",
                        config
                    );
            }

            // Validate price non-zero.
            if (price == 0) {
                return
                    _applyFallbackStrategy(
                        priceOracleAddr,
                        assetAddr,
                        amountValue,
                        "Zero price",
                        config
                    );
            }

            uint256 updateBlock = _tryGetUpdateBlock(
                priceOracleAddr,
                assetAddr
            );
            uint256 ageBlocks = (updateBlock > 0 && updateBlock <= block.number)
                ? (block.number - updateBlock)
                : 0;

            // Validate price reasonableness (simple check; no cache).
            if (price > config.priceValidation.maxReasonablePrice) {
                return
                    _applyFallbackStrategy(
                        priceOracleAddr,
                        assetAddr,
                        amountValue,
                        "Unreasonable price",
                        config
                    );
            }

            (
                bool hasStablecoinConfig,
                StablecoinConfig memory matchedStablecoinConfig
            ) = _findStablecoinConfig(assetAddr, config);
            if (
                hasStablecoinConfig &&
                matchedStablecoinConfig.enableDepegDetection
            ) {
                if (
                    !validateStablecoinPrice(
                        price,
                        matchedStablecoinConfig.expectedPrice,
                        matchedStablecoinConfig.tolerance
                    )
                ) {
                    return
                        _buildConservativeFallback(
                            amountValue,
                            "Stablecoin depeg detected",
                            config.conservativeRatio
                        );
                }
            }

            // Compute value (safe arithmetic).
            uint256 calculatedValue = calculateAssetValue(
                amountValue,
                price,
                assetDecimals
            );

            // Successful price computation.
            result.value = calculatedValue;
            result.isValid = true;
            result.reason = "Price calculation successful";
            result.usedFallback = false;
            result.updateBlock = updateBlock;
            result.ageBlocks = ageBlocks;
        } catch Error(string memory reason) {
            // Handle revert with reason.
            return
                _applyFallbackStrategy(
                    priceOracleAddr,
                    assetAddr,
                    amountValue,
                    string(abi.encodePacked("Price oracle error: ", reason)),
                    config
                );
        } catch (bytes memory lowLevelData) {
            // Handle low-level error (panic/custom error).
            string memory errorMessage = _decodeLowLevelError(lowLevelData);
            return
                _applyFallbackStrategy(
                    priceOracleAddr,
                    assetAddr,
                    amountValue,
                    string(
                        abi.encodePacked(
                            "Price oracle low-level error: ",
                            errorMessage
                        )
                    ),
                    config
                );
        }
    }

    /**
     * @notice Check price oracle health (config-aware).
     * @dev Reverts if:
     *      - (none; best-effort, oracle errors are caught and returned in details)
     *
     * Security:
     * - View-only
     * - Best-effort: returns (false, <reason>) on oracle failure
     *
     * @param priceOracleAddr Price oracle address.
     * @param assetAddr Asset address.
     * @param config Price validation config.
     * @param cacheStorage Cache storage (read-only).
     * @return isHealthy True if healthy, otherwise false.
     * @return details Human-readable details (non-empty on failure).
     */
    function checkPriceOracleHealth(
        address priceOracleAddr,
        address assetAddr,
        PriceValidationConfig memory config,
        CacheStorage storage cacheStorage
    ) internal view returns (bool isHealthy, string memory details) {
        try IPriceOracleRead(priceOracleAddr).getPrice(assetAddr) returns (
            uint256 price,
            uint256 /* sourceTimestamp */,
            uint256 assetDecimals
        ) {
            if (price == 0) {
                return (false, "Zero price returned");
            }
            if (
                !validatePriceReasonableness(
                    price,
                    assetAddr,
                    config,
                    cacheStorage
                )
            ) {
                return (false, "Unreasonable price");
            }
            if (!validateDecimals(assetDecimals)) {
                return (false, "Invalid decimals");
            }
            return (true, "Healthy");
        } catch Error(string memory reason) {
            return (
                false,
                string(abi.encodePacked("Price oracle error: ", reason))
            );
        } catch (bytes memory lowLevelData) {
            string memory errorMessage = _decodeLowLevelError(lowLevelData);
            return (
                false,
                string(
                    abi.encodePacked(
                        "Price oracle low-level error: ",
                        errorMessage
                    )
                )
            );
        }
    }

    /**
     * @notice Check price oracle health (legacy overload).
     * @dev Reverts if:
     *      - (none; best-effort, oracle errors are caught and returned in details)
     *
     * Security:
     * - View-only
     * - Best-effort: returns (false, <reason>) on oracle failure
     *
     * @param priceOracleAddr Price oracle address.
     * @param assetAddr Asset address.
     * @return isHealthy True if healthy, otherwise false.
     * @return details Human-readable details (non-empty on failure).
     */
    function checkPriceOracleHealth(
        address priceOracleAddr,
        address assetAddr
    ) internal view returns (bool isHealthy, string memory details) {
        // Legacy path: simple checks without cache use.
        try IPriceOracleRead(priceOracleAddr).getPrice(assetAddr) returns (
            uint256 price,
            uint256 /* sourceTimestamp */,
            uint256 assetDecimals
        ) {
            if (price == 0) {
                return (false, "Zero price returned");
            }
            if (!validateDecimals(assetDecimals)) {
                return (false, "Invalid decimals");
            }
            return (true, "Healthy");
        } catch Error(string memory reason) {
            return (
                false,
                string(abi.encodePacked("Price oracle error: ", reason))
            );
        } catch (bytes memory lowLevelData) {
            string memory errorMessage = _decodeLowLevelError(lowLevelData);
            return (
                false,
                string(
                    abi.encodePacked(
                        "Price oracle low-level error: ",
                        errorMessage
                    )
                )
            );
        }
    }

    /*━━━━━━━━━━━━━━━ ADDED SAFETY HELPERS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate decimals range.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @param decimalsValue Token decimals value.
     * @return isValid True if within [MIN_DECIMALS, MAX_DECIMALS].
     */
    function validateDecimals(
        uint256 decimalsValue
    ) internal pure returns (bool isValid) {
        // Enforce minimum decimals to avoid unit mismatch.
        if (decimalsValue < MIN_DECIMALS) {
            return false;
        }

        // Enforce maximum decimals (ERC-20 standard).
        if (decimalsValue > MAX_DECIMALS) {
            return false;
        }

        return true;
    }

    /**
     * @notice Validate decimals and return error details.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @param decimalsValue Token decimals value.
     * @return isValid True if valid.
     * @return errorMessage Error message if invalid; empty string on success.
     */
    function validateDecimalsWithError(
        uint256 decimalsValue
    ) internal pure returns (bool isValid, string memory errorMessage) {
        if (decimalsValue < MIN_DECIMALS) {
            return (
                false,
                string(
                    abi.encodePacked(
                        "Decimals too low: ",
                        _uint256ToString(decimalsValue),
                        " (minimum: ",
                        _uint256ToString(MIN_DECIMALS),
                        ")"
                    )
                )
            );
        }

        if (decimalsValue > MAX_DECIMALS) {
            return (
                false,
                string(
                    abi.encodePacked(
                        "Decimals too high: ",
                        _uint256ToString(decimalsValue),
                        " (maximum: ",
                        _uint256ToString(MAX_DECIMALS),
                        ")"
                    )
                )
            );
        }

        return (true, "");
    }

    /**
     * @notice Validate asset decimals reasonableness.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @param assetAddr Asset address (may be used for asset-specific rules).
     * @param decimalsValue Token decimals value.
     * @return isValid True if reasonable.
     */
    function validateAssetDecimals(
        address assetAddr,
        uint256 decimalsValue
    ) internal pure returns (bool isValid) {
        // Basic decimals validation.
        if (!validateDecimals(decimalsValue)) {
            return false;
        }

        // Optional: add asset-specific rules (e.g., stablecoins at 6 decimals).

        // Ensure asset address is non-zero.
        if (assetAddr == address(0)) {
            return false;
        }

        // Optional: add asset-specific decimals validation (e.g., stablecoins).

        return true;
    }

    /**
     * @notice Safe exponentiation with overflow guard.
     * @dev Reverts if:
     *      - {GracefulDegradation__ExponentTooHigh} if exponent exceeds MAX_DECIMALS
     *
     * Security:
     * - Pure function
     *
     * @param base Base value.
     * @param exponent Exponent.
     * @return result Power result.
     */
    function safePow(
        uint256 base,
        uint256 exponent
    ) internal pure returns (uint256 result) {
        if (exponent > MAX_DECIMALS) {
            revert GracefulDegradation__ExponentTooHigh(exponent, MAX_DECIMALS);
        }

        if (exponent == 0) {
            return 1;
        }

        result = 1;
        uint256 currentBase = base;
        uint256 currentExponent = exponent;

        while (currentExponent > 0) {
            if (currentExponent & 1 == 1) {
                result = result * currentBase;
            }
            currentExponent = currentExponent >> 1;
            if (currentExponent > 0) {
                currentBase = currentBase * currentBase;
            }
        }

        return result;
    }

    /**
     * @notice Validate price reasonableness (dynamic checks).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * - Best-effort: returns false if historical price is missing or out of range
     *
     * @param currentPriceValue Current price (oracle precision).
     * @param assetAddr Asset address.
     * @param config Price validation config.
     * @param cacheStorage Cache storage (read-only).
     * @return isValid True if reasonable.
     */
    function validatePriceReasonableness(
        uint256 currentPriceValue,
        address assetAddr,
        PriceValidationConfig memory config,
        CacheStorage storage cacheStorage
    ) internal view returns (bool isValid) {
        // Basic check: price must be non-zero.
        if (currentPriceValue == 0) {
            return false;
        }

        // Check max reasonable price.
        if (currentPriceValue > config.maxReasonablePrice) {
            return false;
        }

        // Optionally validate against historical price.
        if (config.enableHistoricalValidation) {
            uint256 historicalPrice = getHistoricalPrice(
                assetAddr,
                cacheStorage
            );
            if (historicalPrice > 0) {
                uint256 maxPrice = (historicalPrice *
                    config.maxPriceMultiplier) / BASIS_POINT_DIVISOR;
                uint256 minPrice = (historicalPrice *
                    config.minPriceMultiplier) / BASIS_POINT_DIVISOR;

                if (
                    currentPriceValue < minPrice || currentPriceValue > maxPrice
                ) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * @notice Safely compute asset value.
     * @dev Reverts if:
     *      - (none; returns 0 on invalid decimals or overflow guards)
     *
     * Security:
     * - Pure function
     * - Best-effort: returns 0 when decimals are invalid or scaling overflows
     *
     * @param amountValue Asset amount (token decimals).
     * @param priceValue Price (oracle precision).
     * @param decimalsValue Token decimals.
     * @return calculatedValue Computed value (price precision * amount scaled by decimals).
     */
    function calculateAssetValue(
        uint256 amountValue,
        uint256 priceValue,
        uint256 decimalsValue
    ) internal pure returns (uint256 calculatedValue) {
        // Best-effort: never revert in valuation helpers.
        if (!validateDecimals(decimalsValue)) return 0;
        uint256 priceMultiplier = safePow(10, decimalsValue);
        if (priceMultiplier == 0) return 0;
        // Use mulDiv to avoid overflow in amountValue * priceValue.
        calculatedValue = Math.mulDiv(amountValue, priceValue, priceMultiplier);
        return calculatedValue;
    }

    /**
     * @notice Validate stablecoin price vs expected value.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
    * @param actualPriceValue Observed price from the oracle path.
     * @param expectedPriceValue Expected price (oracle precision).
     * @param toleranceValue Tolerance in bps (1e4 = 100%).
     * @return isValid True if within tolerance.
     */
    function validateStablecoinPrice(
        uint256 actualPriceValue,
        uint256 expectedPriceValue,
        uint256 toleranceValue
    ) internal pure returns (bool isValid) {
        // Expected price must be non-zero.
        if (expectedPriceValue == 0) {
            return false;
        }

        // Tolerance must not exceed 100%.
        if (toleranceValue > BASIS_POINT_100_PERCENT) {
            return false;
        }

        // Check price within tolerance bounds.
        uint256 minPrice = (expectedPriceValue *
            (BASIS_POINT_100_PERCENT - toleranceValue)) / BASIS_POINT_DIVISOR;
        uint256 maxPrice = (expectedPriceValue *
            (BASIS_POINT_100_PERCENT + toleranceValue)) / BASIS_POINT_DIVISOR;

        return actualPriceValue >= minPrice && actualPriceValue <= maxPrice;
    }

    /**
     * @notice Get historical price from cache (best-effort).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     * - Best-effort: returns 0 if cache is missing or invalid
     *
     * @param assetAddr Asset address.
     * @param cacheStorage Cache storage (read-only).
     * @return historicalPrice Historical price (0 if unavailable).
     */
    function getHistoricalPrice(
        address assetAddr,
        CacheStorage storage cacheStorage
    ) internal view returns (uint256 historicalPrice) {
        // Try to read historical price from cache.
        PriceCache memory cachedPrice = _getCachedPrice(
            assetAddr,
            cacheStorage
        );
        if (cachedPrice.isValid) {
            return cachedPrice.price;
        }

        // No cache: return 0.
        return 0;
    }

    /**
     * @notice Get cached price.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @param assetAddr Asset address.
     * @param cacheStorage Cache storage (read-only).
     * @return cachedPrice Cached price entry (isValid indicates usability).
     */
    function _getCachedPrice(
        address assetAddr,
        CacheStorage storage cacheStorage
    ) internal view returns (PriceCache memory cachedPrice) {
        return cacheStorage.priceCache[assetAddr];
    }

    /// @dev Best-effort read of the oracle's update block. Returns 0 on failure.
    function _tryGetUpdateBlock(
        address priceOracleAddr,
        address assetAddr
    ) internal view returns (uint256 updateBlock) {
        try
            IPriceOracleRead(priceOracleAddr).getPriceUpdateBlock(assetAddr)
        returns (uint256 b) {
            return b;
        } catch {
            return 0;
        }
    }

    /**
     * @notice Check whether cache entry is expired.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @param updateBlockValue Update block number.
     * @param maxAgeBlocks Maximum age in blocks.
     * @return isExpired True if expired.
     */
    function _isCacheExpired(
        uint256 updateBlockValue,
        uint256 maxAgeBlocks
    ) internal view returns (bool isExpired) {
        if (updateBlockValue == 0 || updateBlockValue > block.number)
            return true;
        return (block.number - updateBlockValue) > maxAgeBlocks;
    }

    /*━━━━━━━━━━━━━━━ INTERNAL FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Apply fallback strategy (legacy config).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     * - Best-effort: always returns a value, even on invalid inputs
     *
     * @param assetAddr Asset address.
     * @param amountValue Asset amount (token decimals).
     * @param reason Fallback reason.
     * @param config Degradation config.
     * @return result Fallback result (value may be conservative).
     */
    function _applyFallbackStrategy(
        address priceOracleAddr,
        address assetAddr,
        uint256 amountValue,
        string memory reason,
        DegradationConfig memory config
    ) internal view returns (PriceResult memory result) {
        if (config.useStablecoinFaceValue) {
            (
                bool hasStablecoinConfig,
                StablecoinConfig memory matchedStablecoinConfig
            ) = _findStablecoinConfig(assetAddr, config);
            if (hasStablecoinConfig && matchedStablecoinConfig.isWhitelisted) {
                uint256 stablecoinDecimals = matchedStablecoinConfig
                    .assetDecimals;
                if (stablecoinDecimals == 0) {
                    stablecoinDecimals = _tryGetAssetDecimals(
                        priceOracleAddr,
                        assetAddr
                    );
                }

                if (validateDecimals(stablecoinDecimals)) {
                    uint256 stablecoinValue = calculateAssetValue(
                        amountValue,
                        matchedStablecoinConfig.expectedPrice,
                        stablecoinDecimals
                    );
                    return _buildFallbackResult(stablecoinValue, reason);
                }
            }
        }

        return
            _buildConservativeFallback(
                amountValue,
                reason,
                config.conservativeRatio
            );
    }

    function _buildConservativeFallback(
        uint256 amountValue,
        string memory reason,
        uint256 conservativeRatio
    ) internal pure returns (PriceResult memory result) {
        uint256 fallbackValue =
            (amountValue * conservativeRatio) / BASIS_POINT_DIVISOR;
        return _buildFallbackResult(fallbackValue, reason);
    }

    function _buildFallbackResult(
        uint256 fallbackValue,
        string memory reason
    ) internal pure returns (PriceResult memory result) {
        result.value = fallbackValue;
        result.isValid = true;
        result.reason = reason;
        result.usedFallback = true;
        result.updateBlock = 0;
        result.ageBlocks = 0;
        return result;
    }

    function _findStablecoinConfig(
        address assetAddr,
        DegradationConfig memory config
    ) internal pure returns (bool found, StablecoinConfig memory matchedConfig) {
        if (
            config.stablecoinConfig.isWhitelisted &&
            config.stablecoinConfig.stablecoin == assetAddr
        ) {
            return (true, config.stablecoinConfig);
        }

        uint256 additionalLength = config.additionalStablecoinConfigs.length;
        for (uint256 i = 0; i < additionalLength; i++) {
            StablecoinConfig memory candidate = config
                .additionalStablecoinConfigs[i];
            if (candidate.isWhitelisted && candidate.stablecoin == assetAddr) {
                return (true, candidate);
            }
        }

        return (false, matchedConfig);
    }

    function _tryGetAssetDecimals(
        address priceOracleAddr,
        address assetAddr
    ) internal view returns (uint256 assetDecimals) {
        if (priceOracleAddr == address(0) || assetAddr == address(0)) {
            return 0;
        }

        try IPriceOracleRead(priceOracleAddr).getAssetConfig(assetAddr) returns (
            IPriceOracleRead.AssetConfig memory assetConfig
        ) {
            return assetConfig.assetDecimals;
        } catch {
            return 0;
        }
    }

    /**
     * @notice Create default degradation config (legacy).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @param settlementTokenAddr Settlement token address.
     * @return config Default config.
     */
    function createDefaultConfig(
        address settlementTokenAddr
    ) internal pure returns (DegradationConfig memory config) {
        config.conservativeRatio = DEFAULT_CONSERVATIVE_RATIO; // 50%.
        config.useStablecoinFaceValue = true;
        config.enablePriceCache = false; // Default: cache writes disabled.
        config.settlementToken = settlementTokenAddr;

        // Default price validation config.
        config
            .priceValidation
            .maxPriceMultiplier = DEFAULT_MAX_PRICE_MULTIPLIER; // 150%.
        config
            .priceValidation
            .minPriceMultiplier = DEFAULT_MIN_PRICE_MULTIPLIER; // 50%.
        config
            .priceValidation
            .priceUpdateThreshold = DEFAULT_PRICE_UPDATE_THRESHOLD; // block-based; chain-dependent.
        config.priceValidation.maxPriceAgeBlocks = MAX_PRICE_AGE_BLOCKS;
        config
            .priceValidation
            .maxReasonablePrice = DEFAULT_MAX_REASONABLE_PRICE; // Default cap.
        config.priceValidation.enableHistoricalValidation = false; // Disabled by default.

        // Default stablecoin config.
        config.stablecoinConfig.stablecoin = settlementTokenAddr;
        config.stablecoinConfig.expectedPrice = ONE_USD; // 1 USD.
        config.stablecoinConfig.tolerance = STABLECOIN_TOLERANCE;
        config.stablecoinConfig.isWhitelisted = true;
        config.stablecoinConfig.enableDepegDetection = false;
        config.stablecoinConfig.assetDecimals = 0;

        // Default retry config.
        config.retryConfig = createDefaultRetryConfig();
    }

    function createDefaultConfigWithStablecoins(
        address settlementTokenAddr,
        StablecoinConfig[] memory additionalStablecoinConfigs
    ) internal pure returns (DegradationConfig memory config) {
        config = createDefaultConfig(settlementTokenAddr);
        config.additionalStablecoinConfigs = additionalStablecoinConfigs;
    }

    /**
     * @notice Create price validation config.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @param maxPriceMultiplierValue Max price multiplier (bps).
     * @param minPriceMultiplierValue Min price multiplier (bps).
     * @param maxReasonablePriceValue Max reasonable price (oracle precision).
     * @return config Price validation config.
     */
    function createPriceValidationConfig(
        uint256 maxPriceMultiplierValue,
        uint256 minPriceMultiplierValue,
        uint256 maxReasonablePriceValue
    ) internal pure returns (PriceValidationConfig memory config) {
        config.maxPriceMultiplier = maxPriceMultiplierValue;
        config.minPriceMultiplier = minPriceMultiplierValue;
        config.priceUpdateThreshold = DEFAULT_PRICE_UPDATE_THRESHOLD; // block-based; chain-dependent.
        config.maxPriceAgeBlocks = MAX_PRICE_AGE_BLOCKS;
        config.maxReasonablePrice = maxReasonablePriceValue;
        config.enableHistoricalValidation = false; // Disabled by default.
    }

    /**
     * @notice Create stablecoin config.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @param stablecoinAddr Stablecoin address.
     * @param expectedPriceValue Expected price (oracle precision).
     * @param toleranceValue Tolerance (bps).
     * @return config Stablecoin config.
     */
    function createStablecoinConfig(
        address stablecoinAddr,
        uint256 expectedPriceValue,
        uint256 toleranceValue
    ) internal pure returns (StablecoinConfig memory config) {
        return
            createStablecoinConfig(
                stablecoinAddr,
                expectedPriceValue,
                toleranceValue,
                0
            );
    }

    function createStablecoinConfig(
        address stablecoinAddr,
        uint256 expectedPriceValue,
        uint256 toleranceValue,
        uint256 assetDecimalsValue
    ) internal pure returns (StablecoinConfig memory config) {
        config.stablecoin = stablecoinAddr;
        config.expectedPrice = expectedPriceValue;
        config.tolerance = toleranceValue;
        config.isWhitelisted = true;
        config.enableDepegDetection = true;
        config.assetDecimals = assetDecimalsValue;
    }

    /**
     * @notice Clear price cache for an asset.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Writes cache storage
     *
     * @param assetAddr Asset address.
     * @param cacheStorage Cache storage (writes enabled).
     */
    function clearPriceCache(
        address assetAddr,
        CacheStorage storage cacheStorage
    ) internal {
        delete cacheStorage.priceCache[assetAddr];
    }

    /**
     * @notice Check whether a valid cache entry exists.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @param assetAddr Asset address.
     * @param cacheStorage Cache storage (read-only).
     * @return exists True if valid cache exists.
     */
    function hasValidCache(
        address assetAddr,
        CacheStorage storage cacheStorage
    ) internal view returns (bool exists) {
        PriceCache memory cachedPrice = _getCachedPrice(
            assetAddr,
            cacheStorage
        );
        return
            cachedPrice.isValid &&
            !_isCacheExpired(cachedPrice.updateBlock, MAX_PRICE_AGE_BLOCKS);
    }

    /**
     * @notice Get cached price info.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @param assetAddr Asset address.
     * @param cacheStorage Cache storage (read-only).
     * @return price Cached price (oracle precision).
     * @return updateBlock Update block number (block.number).
     * @return assetDecimals Asset decimals (for valuation scaling).
     * @return isValid Whether cache entry is valid.
     */
    function getCachedPriceInfo(
        address assetAddr,
        CacheStorage storage cacheStorage
    )
        internal
        view
        returns (
            uint256 price,
            uint256 updateBlock,
            uint256 assetDecimals,
            bool isValid
        )
    {
        PriceCache memory cachedPrice = _getCachedPrice(
            assetAddr,
            cacheStorage
        );
        return (
            cachedPrice.price,
            cachedPrice.updateBlock,
            cachedPrice.assetDecimals,
            cachedPrice.isValid
        );
    }

    /**
     * @notice Get nonce (replay protection).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only
     *
     * @param signerAddr Signer address.
     * @param cacheStorage Cache storage (read-only).
     * @return nonce Current nonce.
     */
    function _getNonce(
        address signerAddr,
        CacheStorage storage cacheStorage
    ) internal view returns (uint256 nonce) {
        return cacheStorage.nonces[signerAddr];
    }

    /**
     * @notice Increment nonce (replay protection).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Writes cache storage
     *
     * @param signerAddr Signer address.
     * @param cacheStorage Cache storage (writes enabled).
     */
    function _incrementNonce(
        address signerAddr,
        CacheStorage storage cacheStorage
    ) internal {
        cacheStorage.nonces[signerAddr]++;
    }

    /**
     * @notice Decode low-level error data into a string.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     * - Best-effort: returns a hex-encoded string if decoding fails
     *
     * @param lowLevelData Low-level error data.
     * @return errorMessage Decoded error message.
     */
    function _decodeLowLevelError(
        bytes memory lowLevelData
    ) internal pure returns (string memory errorMessage) {
        if (lowLevelData.length == 0) {
            return "Unknown low-level error";
        }

        // Check for panic selector.
        if (lowLevelData.length >= 4) {
            bytes4 panicSelector = bytes4(0x4e487b71); // panic(uint256) selector.
            bytes4 dataSelector;
            // solhint-disable-next-line no-inline-assembly
            assembly {
                dataSelector := mload(add(lowLevelData, 4))
            }

            if (dataSelector == panicSelector && lowLevelData.length >= 36) {
                // Decode panic code.
                uint256 panicCode;
                // solhint-disable-next-line no-inline-assembly
                assembly {
                    panicCode := mload(add(lowLevelData, 36))
                }
                return
                    string(
                        abi.encodePacked(
                            "Panic error: ",
                            _getPanicDescription(panicCode)
                        )
                    );
            }
        }

        // Attempt to decode Error(string).
        if (lowLevelData.length >= 4) {
            bytes4 errorSelector = bytes4(0x08c379a0); // Error(string) selector.
            bytes4 dataSelector;
            // solhint-disable-next-line no-inline-assembly
            assembly {
                dataSelector := mload(add(lowLevelData, 4))
            }

            if (dataSelector == errorSelector && lowLevelData.length >= 68) {
                // Decode string error.
                uint256 stringLength;
                // solhint-disable-next-line no-inline-assembly
                assembly {
                    stringLength := mload(add(lowLevelData, 36))
                }

                if (
                    stringLength > 0 && lowLevelData.length >= 68 + stringLength
                ) {
                    bytes memory stringData = new bytes(stringLength);
                    for (uint256 i = 0; i < stringLength; i++) {
                        stringData[i] = lowLevelData[68 + i];
                    }
                    return string(stringData);
                }
            }
        }

        // Fallback: return hex-encoded data.
        return
            string(
                abi.encodePacked(
                    "Low-level error: 0x",
                    _bytesToHex(lowLevelData)
                )
            );
    }

    /**
     * @notice Get panic error description.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @param panicCode Panic code.
     * @return description Human-readable description.
     */
    function _getPanicDescription(
        uint256 panicCode
    ) internal pure returns (string memory description) {
        if (panicCode == 0x00) return "Generic panic";
        if (panicCode == 0x01) return "Assertion failed";
        if (panicCode == 0x11) return "Arithmetic overflow/underflow";
        if (panicCode == 0x12) return "Division by zero";
        if (panicCode == 0x21) return "Invalid enum value";
        if (panicCode == 0x22) return "Invalid storage byte array";
        if (panicCode == 0x31) return "Pop on empty array";
        if (panicCode == 0x32) return "Array index out of bounds";
        if (panicCode == 0x41) return "Out of memory";
        if (panicCode == 0x51) return "Uninitialized function pointer";
        return
            string(
                abi.encodePacked(
                    "Unknown panic code: ",
                    _uint256ToString(panicCode)
                )
            );
    }

    /**
     * @notice Convert bytes to hex string.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @param data Byte array.
     * @return hexString Hex string.
     */
    function _bytesToHex(
        bytes memory data
    ) internal pure returns (string memory hexString) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory result = new bytes(data.length * 2);

        for (uint256 i = 0; i < data.length; i++) {
            result[i * 2] = hexChars[uint8(data[i]) / 16];
            result[i * 2 + 1] = hexChars[uint8(data[i]) % 16];
        }

        return string(result);
    }

    /**
     * @notice Convert uint256 to string.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @param value uint256 value.
     * @return stringValue String value.
     */
    function _uint256ToString(
        uint256 value
    ) internal pure returns (string memory stringValue) {
        if (value == 0) {
            return "0";
        }

        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }

        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }

        return string(buffer);
    }

    /**
     * @notice Cache price (non-view only).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Writes cache storage
     *
     * @param assetAddr Asset address.
     * @param priceValue Price value (oracle precision).
     * @param updateBlockValue Update block number.
     * @param decimalsValue Asset decimals.
     * @param cacheStorage Cache storage (writes enabled).
     */
    function cachePrice(
        address assetAddr,
        uint256 priceValue,
        uint256 updateBlockValue,
        uint256 decimalsValue,
        CacheStorage storage cacheStorage
    ) internal {
        cacheStorage.priceCache[assetAddr] = PriceCache({
            price: priceValue,
            updateBlock: updateBlockValue,
            assetDecimals: decimalsValue,
            isValid: true
        });
    }

    /*━━━━━━━━━━━━━━━ RETRY HELPERS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Create default retry config.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @return config Default retry config.
     */
    function createDefaultRetryConfig()
        internal
        pure
        returns (RetryConfig memory config)
    {
        return
            RetryConfig({
                enableRetry: true,
                maxRetryCount: DEFAULT_MAX_RETRY_COUNT,
                retryDelay: DEFAULT_RETRY_DELAY,
                maxGasLimit: DEFAULT_MAX_GAS_LIMIT,
                retryOnNetworkError: true,
                retryOnTimeout: true
            });
    }

    /**
     * @notice Check whether retry should be attempted.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @param errorReason Error reason string.
     * @param retryConfig Retry config.
     * @return shouldRetry True if retry should be attempted.
     */
    function _shouldRetry(
        string memory errorReason,
        RetryConfig memory retryConfig
    ) internal pure returns (bool shouldRetry) {
        if (!retryConfig.enableRetry) {
            return false;
        }

        // Network-related error checks.
        if (retryConfig.retryOnNetworkError) {
            if (
                _containsString(errorReason, "network") ||
                _containsString(errorReason, "timeout") ||
                _containsString(errorReason, "connection") ||
                _containsString(errorReason, "temporary")
            ) {
                return true;
            }
        }

        // Timeout-related error checks.
        if (retryConfig.retryOnTimeout) {
            if (
                _containsString(errorReason, "timeout") ||
                _containsString(errorReason, "gas") ||
                _containsString(errorReason, "execution")
            ) {
                return true;
            }
        }

        return false;
    }

    /**
     * @notice Check whether a string contains a substring.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     *
     * @param source Source string.
     * @param search Search substring.
     * @return contains True if contains.
     */
    function _containsString(
        string memory source,
        string memory search
    ) internal pure returns (bool contains) {
        bytes memory sourceBytes = bytes(source);
        bytes memory searchBytes = bytes(search);

        if (searchBytes.length > sourceBytes.length) {
            return false;
        }

        for (uint256 i = 0; i <= sourceBytes.length - searchBytes.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < searchBytes.length; j++) {
                if (sourceBytes[i + j] != searchBytes[j]) {
                    found = false;
                    break;
                }
            }
            if (found) {
                return true;
            }
        }

        return false;
    }

    /**
     * @notice Fetch price with retry logic.
     * @dev Reverts if:
     *      - (none; returns success=false on failure)
     *
     * Security:
     * - View-only
     * - Best-effort: does not bubble oracle errors; returns success=false and errorReason
     *
     * @param priceOracleAddr Price oracle address.
     * @param assetAddr Asset address.
     * @param retryConfig Retry config.
     * @return price Price value (oracle precision).
     * @return sourceBlockNumber Source blockNumber (informational).
     * @return assetDecimals Asset decimals (for valuation scaling).
     * @return success True if successful.
     * @return errorReason Error reason string.
     */
    function _getPriceWithRetry(
        address priceOracleAddr,
        address assetAddr,
        RetryConfig memory retryConfig
    )
        internal
        view
        returns (
            uint256 price,
            uint256 sourceBlockNumber,
            uint256 assetDecimals,
            bool success,
            string memory errorReason
        )
    {
        uint256 retryCount = 0;

        while (retryCount <= retryConfig.maxRetryCount) {
            // Enforce gas guard.
            if (gasleft() < retryConfig.maxGasLimit) {
                return (0, 0, 0, false, "Insufficient gas for retry");
            }

            try
                IPriceOracleAdapterRead(priceOracleAddr).getPrice(assetAddr)
            returns (uint256 p, uint256 sourceBlock, uint256 dAsset) {
                return (p, sourceBlock, dAsset, true, "");
            } catch Error(string memory reason) {
                errorReason = reason;

                // Check whether to retry.
                if (
                    retryCount < retryConfig.maxRetryCount &&
                    _shouldRetry(reason, retryConfig)
                ) {
                    retryCount++;
                    // Note: view function cannot delay; retries happen immediately.
                    continue;
                }

                return (0, 0, 0, false, reason);
            } catch (bytes memory lowLevelData) {
                string memory decodedError = _decodeLowLevelError(lowLevelData);
                errorReason = decodedError;

                // Check whether to retry.
                if (
                    retryCount < retryConfig.maxRetryCount &&
                    _shouldRetry(decodedError, retryConfig)
                ) {
                    retryCount++;
                    continue;
                }

                return (0, 0, 0, false, decodedError);
            }
        }

        return (0, 0, 0, false, "Max retry count exceeded");
    }
}

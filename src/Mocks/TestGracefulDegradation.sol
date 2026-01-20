// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/GracefulDegradation.sol";

contract TestGracefulDegradation {
    using GracefulDegradation for *;

    GracefulDegradation.CacheStorage private cacheStorage;

    function getAssetValueWithFallback(
        address priceOracle,
        address asset,
        uint256 amount,
        GracefulDegradation.DegradationConfig memory config
    ) external view returns (GracefulDegradation.PriceResult memory) {
        return GracefulDegradation.getAssetValueWithFallback(priceOracle, asset, amount, config);
    }

    function validateDecimals(uint256 decimals) external pure returns (bool) {
        return GracefulDegradation.validateDecimals(decimals);
    }

    function validateDecimalsWithError(uint256 decimals) external pure returns (bool, string memory) {
        return GracefulDegradation.validateDecimalsWithError(decimals);
    }

    function validateAssetDecimals(address asset, uint256 decimals) external pure returns (bool) {
        return GracefulDegradation.validateAssetDecimals(asset, decimals);
    }

    function validatePriceReasonableness(
        uint256 currentPrice,
        address asset,
        GracefulDegradation.PriceValidationConfig memory config
    ) external view returns (bool) {
        return GracefulDegradation.validatePriceReasonableness(currentPrice, asset, config, cacheStorage);
    }

    function calculateAssetValue(
        uint256 amount,
        uint256 price,
        uint256 decimals
    ) external pure returns (uint256) {
        return GracefulDegradation.calculateAssetValue(amount, price, decimals);
    }

    function validateStablecoinPrice(
        address stablecoin,
        uint256 expectedPrice,
        uint256 tolerance
    ) external pure returns (bool) {
        return GracefulDegradation.validateStablecoinPrice(stablecoin, expectedPrice, tolerance);
    }

    function createDefaultConfig(address settlementToken) external pure returns (GracefulDegradation.DegradationConfig memory) {
        return GracefulDegradation.createDefaultConfig(settlementToken);
    }

    function createPriceValidationConfig(
        uint256 maxPriceMultiplier,
        uint256 minPriceMultiplier,
        uint256 maxReasonablePrice
    ) external pure returns (GracefulDegradation.PriceValidationConfig memory) {
        return GracefulDegradation.createPriceValidationConfig(maxPriceMultiplier, minPriceMultiplier, maxReasonablePrice);
    }

    function createStablecoinConfig(
        address stablecoin,
        uint256 expectedPrice,
        uint256 tolerance
    ) external pure returns (GracefulDegradation.StablecoinConfig memory) {
        return GracefulDegradation.createStablecoinConfig(stablecoin, expectedPrice, tolerance);
    }

    function MIN_DECIMALS() external pure returns (uint256) {
        return 6;
    }

    function MAX_DECIMALS() external pure returns (uint256) {
        return 18;
    }
}


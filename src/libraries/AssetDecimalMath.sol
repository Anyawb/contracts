// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DivisionByZero} from "../errors/StandardErrors.sol";

/// @notice Reverts when a decimal exponent exceeds the largest safe pow10 exponent for uint256.
error AssetDecimalMath__ExponentTooHigh(uint8 exponent, uint8 maxExponent);

/**
 * @title AssetDecimalMath
 * @notice Stateless helpers for value scaling and asset-decimal based valuation.
 * @dev Reverts if:
 *      - a requested decimal exponent exceeds the largest safe `10 ** exponent` bound for uint256
 *      - `priceUsd == 0` in {calcAmountFromValue}
 *      - arithmetic overflows in Solidity checked math
 *
 * Security:
 * - Pure library: no storage reads/writes and no external calls.
 * - This library intentionally contains only math/scale logic and no protocol policy.
 */
library AssetDecimalMath {
    /// @dev Largest safe exponent such that `10 ** exponent` fits within uint256.
    uint8 internal constant MAX_DECIMALS = 77;

    /**
     * @notice Rescales an integer value from `fromDecimals` precision to `toDecimals` precision.
     * @param value Raw integer value.
     * @param fromDecimals Current decimal precision of `value`.
     * @param toDecimals Target decimal precision.
     * @return rescaledValue `value` represented in `toDecimals` precision.
     */
    function rescale(
        uint256 value,
        uint8 fromDecimals,
        uint8 toDecimals
    ) internal pure returns (uint256 rescaledValue) {
        return rescaleDown(value, fromDecimals, toDecimals);
    }

    /**
     * @notice Rescales an integer value and rounds down when precision is reduced.
     * @param value Raw integer value.
     * @param fromDecimals Current decimal precision of `value`.
     * @param toDecimals Target decimal precision.
     * @return rescaledValue `value` represented in `toDecimals` precision.
     */
    function rescaleDown(
        uint256 value,
        uint8 fromDecimals,
        uint8 toDecimals
    ) internal pure returns (uint256 rescaledValue) {
        if (value == 0 || fromDecimals == toDecimals) return value;
        if (fromDecimals < toDecimals) {
            return value * _pow10(uint8(toDecimals - fromDecimals));
        }
        return value / _pow10(uint8(fromDecimals - toDecimals));
    }

    /**
     * @notice Rescales an integer value and rounds up when precision is reduced.
     * @param value Raw integer value.
     * @param fromDecimals Current decimal precision of `value`.
     * @param toDecimals Target decimal precision.
     * @return rescaledValue `value` represented in `toDecimals` precision.
     */
    function rescaleUp(
        uint256 value,
        uint8 fromDecimals,
        uint8 toDecimals
    ) internal pure returns (uint256 rescaledValue) {
        if (value == 0 || fromDecimals == toDecimals) return value;
        if (fromDecimals < toDecimals) {
            return value * _pow10(uint8(toDecimals - fromDecimals));
        }

        uint256 factor = _pow10(uint8(fromDecimals - toDecimals));
        return Math.mulDiv(value, 1, factor, Math.Rounding.Ceil);
    }

    /**
     * @notice Calculates USD value from token base units and asset-scaled price.
     * @param amountBaseUnits Token amount in base units.
     * @param priceUsd Price expressed in the asset's value precision.
     * @param assetDecimals Token decimals / value precision.
     * @return valueUsd Value in the same precision as `assetDecimals`.
     */
    function calcValue(
        uint256 amountBaseUnits,
        uint256 priceUsd,
        uint8 assetDecimals
    ) internal pure returns (uint256 valueUsd) {
        if (amountBaseUnits == 0 || priceUsd == 0) return 0;
        return Math.mulDiv(amountBaseUnits, priceUsd, _pow10(assetDecimals));
    }

    /**
     * @notice Calculates token base units from USD value and asset-scaled price.
     * @param valueUsd Value in asset-scaled precision.
     * @param priceUsd Price expressed in the asset's value precision.
     * @param assetDecimals Token decimals / value precision.
     * @return amountBaseUnits Token amount in base units.
     */
    function calcAmountFromValue(
        uint256 valueUsd,
        uint256 priceUsd,
        uint8 assetDecimals
    ) internal pure returns (uint256 amountBaseUnits) {
        if (valueUsd == 0) return 0;
        if (priceUsd == 0) revert DivisionByZero();
        return Math.mulDiv(valueUsd, _pow10(assetDecimals), priceUsd);
    }

    /**
     * @notice Alias of {rescale} for value semantics.
     * @param valueUsd Value to normalize.
     * @param valueDecimals Current precision of `valueUsd`.
     * @param targetDecimals Target precision.
     * @return normalizedValue Value represented in `targetDecimals` precision.
     */
    function normalizeValue(
        uint256 valueUsd,
        uint8 valueDecimals,
        uint8 targetDecimals
    ) internal pure returns (uint256 normalizedValue) {
        return normalizeValueDown(valueUsd, valueDecimals, targetDecimals);
    }

    /**
     * @notice Alias of {rescaleDown} for value semantics.
     * @param valueUsd Value to normalize.
     * @param valueDecimals Current precision of `valueUsd`.
     * @param targetDecimals Target precision.
     * @return normalizedValue Value represented in `targetDecimals` precision.
     */
    function normalizeValueDown(
        uint256 valueUsd,
        uint8 valueDecimals,
        uint8 targetDecimals
    ) internal pure returns (uint256 normalizedValue) {
        return rescaleDown(valueUsd, valueDecimals, targetDecimals);
    }

    /**
     * @notice Alias of {rescaleUp} for value semantics.
     * @param valueUsd Value to normalize.
     * @param valueDecimals Current precision of `valueUsd`.
     * @param targetDecimals Target precision.
     * @return normalizedValue Value represented in `targetDecimals` precision.
     */
    function normalizeValueUp(
        uint256 valueUsd,
        uint8 valueDecimals,
        uint8 targetDecimals
    ) internal pure returns (uint256 normalizedValue) {
        return rescaleUp(valueUsd, valueDecimals, targetDecimals);
    }

    function _pow10(uint8 exponent) private pure returns (uint256 result) {
        if (exponent > MAX_DECIMALS) {
            revert AssetDecimalMath__ExponentTooHigh(exponent, MAX_DECIMALS);
        }
        return 10 ** uint256(exponent);
    }
}

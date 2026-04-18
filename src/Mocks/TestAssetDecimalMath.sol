// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AssetDecimalMath} from "../libraries/AssetDecimalMath.sol";

/// @notice Test harness for exercising AssetDecimalMath from Hardhat tests.
contract TestAssetDecimalMath {
    function rescale(
        uint256 value,
        uint8 fromDecimals,
        uint8 toDecimals
    ) external pure returns (uint256) {
        return AssetDecimalMath.rescale(value, fromDecimals, toDecimals);
    }

    function rescaleDown(
        uint256 value,
        uint8 fromDecimals,
        uint8 toDecimals
    ) external pure returns (uint256) {
        return AssetDecimalMath.rescaleDown(value, fromDecimals, toDecimals);
    }

    function rescaleUp(
        uint256 value,
        uint8 fromDecimals,
        uint8 toDecimals
    ) external pure returns (uint256) {
        return AssetDecimalMath.rescaleUp(value, fromDecimals, toDecimals);
    }

    function calcValue(
        uint256 amountBaseUnits,
        uint256 priceUsd,
        uint8 assetDecimals
    ) external pure returns (uint256) {
        return
            AssetDecimalMath.calcValue(
                amountBaseUnits,
                priceUsd,
                assetDecimals
            );
    }

    function calcAmountFromValue(
        uint256 valueUsd,
        uint256 priceUsd,
        uint8 assetDecimals
    ) external pure returns (uint256) {
        return
            AssetDecimalMath.calcAmountFromValue(
                valueUsd,
                priceUsd,
                assetDecimals
            );
    }

    function normalizeValue(
        uint256 valueUsd,
        uint8 valueDecimals,
        uint8 targetDecimals
    ) external pure returns (uint256) {
        return
            AssetDecimalMath.normalizeValue(
                valueUsd,
                valueDecimals,
                targetDecimals
            );
    }

    function normalizeValueDown(
        uint256 valueUsd,
        uint8 valueDecimals,
        uint8 targetDecimals
    ) external pure returns (uint256) {
        return
            AssetDecimalMath.normalizeValueDown(
                valueUsd,
                valueDecimals,
                targetDecimals
            );
    }

    function normalizeValueUp(
        uint256 valueUsd,
        uint8 valueDecimals,
        uint8 targetDecimals
    ) external pure returns (uint256) {
        return
            AssetDecimalMath.normalizeValueUp(
                valueUsd,
                valueDecimals,
                targetDecimals
            );
    }
}

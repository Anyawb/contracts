// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LiquidationValidationLibrary
 * @notice Provides shared validation helpers and canonical liquidation revert reasons.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - Pure library: no storage reads, writes, or external calls.
 * - Validation helpers are intended to be used at module entry points to keep revert behavior consistent.
 * - Solidity ^0.8.x overflow and underflow checks apply.
 */
library LiquidationValidationLibrary {
    /*━━━━━━━━━━━━━━━ Custom Errors ━━━━━━━━━━━━━━━*/

    /// @dev Reverts when an address argument is address(0). Used by address-validation helpers.
    error ZeroAddress();

    /// @dev Reverts when an amount argument is zero. Used by amount-validation helpers.
    error ZeroAmount();

    /// @dev Reverts when a value falls outside the allowed inclusive range. Used by range-validation helpers.
    error InvalidRange();

    /// @dev Reverts when a module key is bytes32(0) or otherwise invalid for validation paths. Used by module-key validators.
    error InvalidModuleKey(bytes32 moduleKey);

    /// @dev Reverts when paired arrays have different lengths. Used by array-validation helpers.
    error ArrayLengthMismatch(
        uint256 expectedLengthValue,
        uint256 actualLengthValue
    );

    /// @dev Reverts when a batch size exceeds the configured maximum. Used by batch-size validators.
    error InvalidBatchSize(uint256 batchSizeValue, uint256 maxSizeValue);

    /// @dev Reverts when a named parameter violates its allowed bound. Used by parameter-validation helpers.
    error InvalidParameter(string parameterName, uint256 parameterValue);

    /// @dev Reverts when a required price value is zero. Used by price-validation helpers.
    error PriceCannotBeZero();

    /// @dev Reverts when a required record does not exist. Used by record-validation helpers.
    error RecordNotFound();

    /// @dev Reverts when creating a record that already exists. Used by record-validation helpers.
    error RecordAlreadyExists();

    /// @dev Reverts when required statistics data is missing. Used by stats-validation helpers.
    error StatsNotFound();

    /// @dev Reverts when guarantee amount is insufficient for the requested operation. Used by sufficiency validators.
    error InsufficientGuarantee();

    /// @dev Reverts when debt amount is insufficient for the requested operation. Used by sufficiency validators.
    error InsufficientDebt();

    /// @dev Reverts when collateral amount is insufficient for the requested operation. Used by sufficiency validators.
    error InsufficientCollateral();

    /*━━━━━━━━━━━━━━━ Address Validation Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate address is not zero.
     * @dev Reverts if:
     *      - targetAddr is zero address
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param targetAddr Address to validate
     */
    function validateAddress(address targetAddr) internal pure {
        if (targetAddr == address(0)) revert ZeroAddress();
    }

    /**
     * @notice Validate address is not zero (with optional error message parameter for compatibility).
     * @dev Reverts if:
     *      - targetAddr is zero address
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param targetAddr Address to validate
     */
    function validateAddress(
        address targetAddr,
        string memory /* errorMessage */
    ) internal pure {
        if (targetAddr == address(0)) revert ZeroAddress();
    }

    /**
     * @notice Check if address is zero.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param targetAddr Address to check
     * @return isZeroFlag True if address is zero, false otherwise
     */
    function isZeroAddress(
        address targetAddr
    ) internal pure returns (bool isZeroFlag) {
        return targetAddr == address(0);
    }

    /*━━━━━━━━━━━━━━━ Amount Validation Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate amount is not zero.
     * @dev Reverts if:
     *      - amountValue is zero
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param amountValue Amount to validate (token decimals, must be > 0)
     */
    function validateAmount(uint256 amountValue) internal pure {
        if (amountValue == 0) revert ZeroAmount();
    }

    /**
     * @notice Validate amount is not zero (with optional error message parameter for compatibility).
     * @dev Reverts if:
     *      - amountValue is zero
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param amountValue Amount to validate (token decimals, must be > 0)
     */
    function validateAmount(
        uint256 amountValue,
        string memory /* errorMessage */
    ) internal pure {
        if (amountValue == 0) revert ZeroAmount();
    }

    /**
     * @notice Check if amount is zero.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param amountValue Amount to check (token decimals)
     * @return isZeroFlag True if amount is zero, false otherwise
     */
    function isZeroAmount(
        uint256 amountValue
    ) internal pure returns (bool isZeroFlag) {
        return amountValue == 0;
    }

    /*━━━━━━━━━━━━━━━ Range Validation Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate value is within specified range [minValueInput, maxValueInput].
     * @dev Reverts if:
     *      - valueToValidate < minValueInput
     *      - valueToValidate > maxValueInput
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param valueToValidate Value to validate (unit depends on context)
     * @param minValueInput Minimum allowed value (inclusive)
     * @param maxValueInput Maximum allowed value (inclusive)
     */
    function validateRange(
        uint256 valueToValidate,
        uint256 minValueInput,
        uint256 maxValueInput
    ) internal pure {
        if (valueToValidate < minValueInput || valueToValidate > maxValueInput)
            revert InvalidRange();
    }

    /**
     * @notice Validate value is within specified range (with optional error message parameter for compatibility).
     * @dev Reverts if:
     *      - valueToValidate < minValueInput
     *      - valueToValidate > maxValueInput
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param valueToValidate Value to validate (unit depends on context)
     * @param minValueInput Minimum allowed value (inclusive)
     * @param maxValueInput Maximum allowed value (inclusive)
     */
    function validateRange(
        uint256 valueToValidate,
        uint256 minValueInput,
        uint256 maxValueInput,
        string memory /* errorMessage */
    ) internal pure {
        if (valueToValidate < minValueInput || valueToValidate > maxValueInput)
            revert InvalidRange();
    }

    /**
     * @notice Validate parameter value does not exceed maximum allowed value.
     * @dev Reverts if:
     *      - parameterValue > maxValueInput
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param parameterValue Parameter value to validate (unit depends on context)
     * @param maxValueInput Maximum allowed value (inclusive)
     * @param parameterNameString Parameter name identifier (for error reporting)
     */
    function validateParameter(
        uint256 parameterValue,
        uint256 maxValueInput,
        string memory parameterNameString
    ) internal pure {
        if (parameterValue > maxValueInput)
            revert InvalidParameter(parameterNameString, parameterValue);
    }

    /*━━━━━━━━━━━━━━━ Array Validation Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate two address arrays have matching lengths.
     * @dev Reverts if:
     *      - addressArray1.length != addressArray2.length
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param addressArray1 First address array
     * @param addressArray2 Second address array
     */
    function validateArrayLength(
        address[] memory addressArray1,
        address[] memory addressArray2
    ) internal pure {
        if (addressArray1.length != addressArray2.length) {
            revert ArrayLengthMismatch(
                addressArray1.length,
                addressArray2.length
            );
        }
    }

    /**
     * @notice Validate address array and uint256 array have matching lengths.
     * @dev Reverts if:
     *      - addressArray1.length != uintArray2.length
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param addressArray1 Address array
     * @param uintArray2 Uint256 array
     */
    function validateArrayLength(
        address[] memory addressArray1,
        uint256[] memory uintArray2
    ) internal pure {
        if (addressArray1.length != uintArray2.length) {
            revert ArrayLengthMismatch(addressArray1.length, uintArray2.length);
        }
    }

    /**
     * @notice Validate bytes32 array and uint256 array have matching lengths.
     * @dev Reverts if:
     *      - bytes32Array1.length != uintArray2.length
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param bytes32Array1 Bytes32 array
     * @param uintArray2 Uint256 array
     */
    function validateArrayLength(
        bytes32[] memory bytes32Array1,
        uint256[] memory uintArray2
    ) internal pure {
        if (bytes32Array1.length != uintArray2.length) {
            revert ArrayLengthMismatch(bytes32Array1.length, uintArray2.length);
        }
    }

    /**
     * @notice Validate two uint256 arrays have matching lengths.
     * @dev Reverts if:
     *      - uintArray1.length != uintArray2.length
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param uintArray1 First uint256 array
     * @param uintArray2 Second uint256 array
     */
    function validateArrayLength(
        uint256[] memory uintArray1,
        uint256[] memory uintArray2
    ) internal pure {
        if (uintArray1.length != uintArray2.length) {
            revert ArrayLengthMismatch(uintArray1.length, uintArray2.length);
        }
    }

    /**
     * @notice Validate bytes32 array and address array have matching lengths.
     * @dev Reverts if:
     *      - bytes32Array1.length != addressArray2.length
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param bytes32Array1 Bytes32 array
     * @param addressArray2 Address array
     */
    function validateArrayLength(
        bytes32[] memory bytes32Array1,
        address[] memory addressArray2
    ) internal pure {
        if (bytes32Array1.length != addressArray2.length) {
            revert ArrayLengthMismatch(
                bytes32Array1.length,
                addressArray2.length
            );
        }
    }

    /**
     * @notice Validate address array and bool array have matching lengths.
     * @dev Reverts if:
     *      - addressArray1.length != boolArray2.length
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param addressArray1 Address array
     * @param boolArray2 Bool array
     */
    function validateArrayLength(
        address[] memory addressArray1,
        bool[] memory boolArray2
    ) internal pure {
        if (addressArray1.length != boolArray2.length) {
            revert ArrayLengthMismatch(addressArray1.length, boolArray2.length);
        }
    }

    /**
     * @notice Batch validate all addresses in array are non-zero.
     * @dev Reverts if:
     *      - any address in addressArray is zero address
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param addressArray Array of addresses to validate
     */
    function validateAddresses(address[] memory addressArray) internal pure {
        for (uint256 i = 0; i < addressArray.length; i++) {
            if (addressArray[i] == address(0)) revert ZeroAddress();
        }
    }

    /*━━━━━━━━━━━━━━━ Module Key Validation Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate module key is not empty.
     * @dev Reverts if:
     *      - moduleKeyInput is bytes32(0)
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param moduleKeyInput Module key identifier to validate
     */
    function validateModuleKey(bytes32 moduleKeyInput) internal pure {
        if (moduleKeyInput == bytes32(0))
            revert InvalidModuleKey(moduleKeyInput);
    }

    /*━━━━━━━━━━━━━━━ Batch Size Validation Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate batch size is within valid range (0 < batchSizeValue <= maxSizeValue).
     * @dev Reverts if:
     *      - batchSizeValue is zero
     *      - batchSizeValue > maxSizeValue
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param batchSizeValue Batch size to validate (count, must be > 0 and <= maxSizeValue)
     * @param maxSizeValue Maximum allowed batch size (count)
     */
    function validateBatchSize(
        uint256 batchSizeValue,
        uint256 maxSizeValue
    ) internal pure {
        if (batchSizeValue == 0 || batchSizeValue > maxSizeValue) {
            revert InvalidBatchSize(batchSizeValue, maxSizeValue);
        }
    }

    /**
     * @notice Validate batch size is not zero.
     * @dev Reverts if:
     *      - batchSizeValue is zero
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param batchSizeValue Batch size to validate (count, must be > 0)
     */
    function validateBatchSize(uint256 batchSizeValue) internal pure {
        if (batchSizeValue == 0) revert InvalidBatchSize(batchSizeValue, 0);
    }

    /*━━━━━━━━━━━━━━━ Price Validation Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate price is not zero.
     * @dev Reverts if:
     *      - priceValue is zero
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param priceValue Price to validate (scaled by 1e18, must be > 0)
     */
    function validatePrice(uint256 priceValue) internal pure {
        if (priceValue == 0) revert PriceCannotBeZero();
    }

    /*━━━━━━━━━━━━━━━ Record Validation Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate record exists.
     * @dev Reverts if:
     *      - existsFlag is false
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param existsFlag Boolean flag indicating whether record exists
     */
    function validateRecordExists(bool existsFlag) internal pure {
        if (!existsFlag) revert RecordNotFound();
    }

    /**
     * @notice Validate record does not exist.
     * @dev Reverts if:
     *      - existsFlag is true
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param existsFlag Boolean flag indicating whether record exists
     */
    function validateRecordNotExists(bool existsFlag) internal pure {
        if (existsFlag) revert RecordAlreadyExists();
    }

    /*━━━━━━━━━━━━━━━ Stats Validation Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate stats exist.
     * @dev Reverts if:
     *      - existsFlag is false
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param existsFlag Boolean flag indicating whether stats exist
     */
    function validateStatsExists(bool existsFlag) internal pure {
        if (!existsFlag) revert StatsNotFound();
    }

    /*━━━━━━━━━━━━━━━ Sufficiency Validation Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate available guarantee amount is sufficient for required amount.
     * @dev Reverts if:
     *      - availableAmount < requiredAmount
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param availableAmount Available guarantee amount (token decimals)
     * @param requiredAmount Required guarantee amount (token decimals)
     */
    function validateSufficientGuarantee(
        uint256 availableAmount,
        uint256 requiredAmount
    ) internal pure {
        if (availableAmount < requiredAmount) revert InsufficientGuarantee();
    }

    /**
     * @notice Validate available debt amount is sufficient for required amount.
     * @dev Reverts if:
     *      - availableAmount < requiredAmount
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param availableAmount Available debt amount (token decimals)
     * @param requiredAmount Required debt amount (token decimals)
     */
    function validateSufficientDebt(
        uint256 availableAmount,
        uint256 requiredAmount
    ) internal pure {
        if (availableAmount < requiredAmount) revert InsufficientDebt();
    }

    /**
     * @notice Validate available collateral amount is sufficient for required amount.
     * @dev Reverts if:
     *      - availableAmount < requiredAmount
     *
     * Security:
     * - Pure function (no state access or external calls)
     *
     * @param availableAmount Available collateral amount (token decimals)
     * @param requiredAmount Required collateral amount (token decimals)
     */
    function validateSufficientCollateral(
        uint256 availableAmount,
        uint256 requiredAmount
    ) internal pure {
        if (availableAmount < requiredAmount) revert InsufficientCollateral();
    }

    /*━━━━━━━━━━━━━━━ Composite Validation Functions ━━━━━━━━━━━━━━━*/

    /**
     * @notice Validate all liquidation parameters (user, asset, amount, liquidator).
     * @dev Reverts if:
     *      - userAddr is zero address
     *      - assetAddr is zero address
     *      - amountValue is zero
     *      - liquidatorAddr is zero address
     *
     * Security:
     * - Pure function (no state access or external calls)
     * - Validates all critical liquidation parameters in one call
     *
     * @param userAddr Address of the user being liquidated
     * @param assetAddr Address of the asset being liquidated
     * @param amountValue Liquidation amount (token decimals, must be > 0)
     * @param liquidatorAddr Address of the liquidator
     */
    function validateLiquidationParameters(
        address userAddr,
        address assetAddr,
        uint256 amountValue,
        address liquidatorAddr
    ) internal pure {
        validateAddress(userAddr, "User");
        validateAddress(assetAddr, "Asset");
        validateAmount(amountValue, "Amount");
        validateAddress(liquidatorAddr, "Liquidator");
    }

    /**
     * @notice Validate all batch liquidation parameters (arrays and liquidator).
     * @dev Reverts if:
     *      - liquidatorAddr is zero address
     *      - array lengths mismatch (userAddrs vs assetAddrs, userAddrs vs amountValues)
     *      - any address in userAddrs is zero address
     *      - any address in assetAddrs is zero address
     *
     * Security:
     * - Pure function (no state access or external calls)
     * - Validates all critical batch liquidation parameters in one call
     *
     * @param userAddrs Array of user addresses being liquidated
     * @param assetAddrs Array of asset addresses (one per liquidation)
     * @param amountValues Array of liquidation amounts (token decimals, one per liquidation)
     * @param liquidatorAddr Address of the liquidator
     */
    function validateBatchLiquidationParameters(
        address[] memory userAddrs,
        address[] memory assetAddrs,
        uint256[] memory amountValues,
        address liquidatorAddr
    ) internal pure {
        validateAddress(liquidatorAddr, "Liquidator");
        validateArrayLength(userAddrs, assetAddrs);
        validateArrayLength(userAddrs, amountValues);
        validateAddresses(userAddrs);
        validateAddresses(assetAddrs);
    }
}

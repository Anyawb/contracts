// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title 清算验证库
 * @title Liquidation Validation Library
 * @author RWA Lending Platform
 * @notice 提供通用的验证函数和错误定义，整合所有清算模块中重复的验证逻辑
 * @notice Provides common validation functions and error definitions, integrates all repeated validation logic from liquidation modules
 * @dev 提供标准化的验证函数，确保一致性和安全性
 * @dev Provides standardized validation functions to ensure consistency and security
 */
library LiquidationValidationLibrary {
    /* ============ Custom Errors ============ */
    
    /**
     * @notice 零地址错误 - 当地址为零地址时触发
     * @notice Zero address error - Triggered when address is zero
     */
    error ZeroAddress();
    
    /**
     * @notice 零金额错误 - 当金额为零时触发
     * @notice Zero amount error - Triggered when amount is zero
     */
    error ZeroAmount();
    
    /**
     * @notice 无效范围错误 - 当值超出有效范围时触发
     * @notice Invalid range error - Triggered when value is out of valid range
     */
    error InvalidRange();
    
    /**
     * @notice 无效模块键值错误 - 当模块键值为空时触发
     * @notice Invalid module key error - Triggered when module key is empty
     * @param moduleKey 模块键值 Module key
     */
    error InvalidModuleKey(bytes32 moduleKey);
    
    /**
     * @notice 数组长度不匹配错误 - 当数组长度不匹配时触发
     * @notice Array length mismatch error - Triggered when array lengths don't match
     * @param expectedLengthValue 期望长度 Expected length
     * @param actualLengthValue 实际长度 Actual length
     */
    error ArrayLengthMismatch(uint256 expectedLengthValue, uint256 actualLengthValue);
    
    /**
     * @notice 批量大小无效错误 - 当批量大小超出限制时触发
     * @notice Invalid batch size error - Triggered when batch size exceeds limit
     * @param batchSizeValue 批量大小 Batch size
     * @param maxSizeValue 最大大小 Maximum size
     */
    error InvalidBatchSize(uint256 batchSizeValue, uint256 maxSizeValue);
    
    /**
     * @notice 无效参数错误 - 当参数无效时触发
     * @notice Invalid parameter error - Triggered when parameter is invalid
     * @param parameterName 参数名称 Parameter name
     * @param parameterValue 参数值 Parameter value
     */
    error InvalidParameter(string parameterName, uint256 parameterValue);
    
    /**
     * @notice 价格为零错误 - 当价格为0时触发
     * @notice Price cannot be zero error - Triggered when price is zero
     */
    error PriceCannotBeZero();
    
    /**
     * @notice 记录不存在错误 - 当记录不存在时触发
     * @notice Record not found error - Triggered when record doesn't exist
     */
    error RecordNotFound();
    
    /**
     * @notice 记录已存在错误 - 当记录已存在时触发
     * @notice Record already exists error - Triggered when record already exists
     */
    error RecordAlreadyExists();
    
    /**
     * @notice 统计不存在错误 - 当统计不存在时触发
     * @notice Stats not found error - Triggered when stats don't exist
     */
    error StatsNotFound();
    
    /**
     * @notice 保证金不足错误 - 当保证金不足时触发
     * @notice Insufficient guarantee error - Triggered when guarantee is insufficient
     */
    error InsufficientGuarantee();
    
    /**
     * @notice 债务不足错误 - 当债务不足时触发
     * @notice Insufficient debt error - Triggered when debt is insufficient
     */
    error InsufficientDebt();
    
    /**
     * @notice 抵押物不足错误 - 当抵押物不足时触发
     * @notice Insufficient collateral error - Triggered when collateral is insufficient
     */
    error InsufficientCollateral();

    /* ============ Address Validation Functions ============ */
    
    /**
     * @notice 验证地址 - 检查地址是否为零地址
     * @notice Validate address - Check if address is zero
     * @param targetAddr 要验证的地址 Address to validate
     */
    function validateAddress(address targetAddr) internal pure {
        if (targetAddr == address(0)) revert ZeroAddress();
    }
    
    /**
     * @notice 验证地址并返回错误信息 - 检查地址是否为零地址
     * @notice Validate address with error message - Check if address is zero
     * @param targetAddr 要验证的地址 Address to validate
     */
    function validateAddress(address targetAddr, string memory /* errorMessage */) internal pure {
        if (targetAddr == address(0)) revert ZeroAddress();
    }
    
    /**
     * @notice 检查是否为零地址 - 内联函数，减少调用开销
     * @notice Check if zero address - Inline function to reduce call overhead
     * @param targetAddr 要检查的地址 Address to check
     * @return isZeroFlag 是否为零地址 Whether it's zero address
     */
    function isZeroAddress(address targetAddr) internal pure returns (bool isZeroFlag) {
        return targetAddr == address(0);
    }

    /* ============ Amount Validation Functions ============ */
    
    /**
     * @notice 验证金额 - 检查金额是否为零
     * @notice Validate amount - Check if amount is zero
     * @param amountValue 要验证的金额 Amount to validate
     */
    function validateAmount(uint256 amountValue) internal pure {
        if (amountValue == 0) revert ZeroAmount();
    }
    
    /**
     * @notice 验证金额并返回错误信息 - 检查金额是否为零
     * @notice Validate amount with error message - Check if amount is zero
     * @param amountValue 要验证的金额 Amount to validate
     */
    function validateAmount(uint256 amountValue, string memory /* errorMessage */) internal pure {
        if (amountValue == 0) revert ZeroAmount();
    }
    
    /**
     * @notice 检查是否为零金额 - 内联函数，减少调用开销
     * @notice Check if zero amount - Inline function to reduce call overhead
     * @param amountValue 要检查的金额 Amount to check
     * @return isZeroFlag 是否为零金额 Whether it's zero amount
     */
    function isZeroAmount(uint256 amountValue) internal pure returns (bool isZeroFlag) {
        return amountValue == 0;
    }

    /* ============ Range Validation Functions ============ */
    
    /**
     * @notice 验证范围 - 检查值是否在指定范围内
     * @notice Validate range - Check if value is within specified range
     * @param valueToValidate 要验证的值 Value to validate
     * @param minValueInput 最小值 Minimum value
     * @param maxValueInput 最大值 Maximum value
     */
    function validateRange(uint256 valueToValidate, uint256 minValueInput, uint256 maxValueInput) internal pure {
        if (valueToValidate < minValueInput || valueToValidate > maxValueInput) revert InvalidRange();
    }
    
    /**
     * @notice 验证范围并返回错误信息 - 检查值是否在指定范围内
     * @notice Validate range with error message - Check if value is within specified range
     * @param valueToValidate 要验证的值 Value to validate
     * @param minValueInput 最小值 Minimum value
     * @param maxValueInput 最大值 Maximum value
     */
    function validateRange(uint256 valueToValidate, uint256 minValueInput, uint256 maxValueInput, string memory /* errorMessage */) internal pure {
        if (valueToValidate < minValueInput || valueToValidate > maxValueInput) revert InvalidRange();
    }
    
    /**
     * @notice 验证参数 - 检查参数是否在有效范围内
     * @notice Validate parameter - Check if parameter is within valid range
     * @param parameterValue 参数值 Parameter value
     * @param maxValueInput 最大值 Maximum value
     * @param parameterNameString 参数名称 Parameter name
     */
    function validateParameter(uint256 parameterValue, uint256 maxValueInput, string memory parameterNameString) internal pure {
        if (parameterValue > maxValueInput) revert InvalidParameter(parameterNameString, parameterValue);
    }

    /* ============ Array Validation Functions ============ */
    
    /**
     * @notice 验证数组长度 - 检查数组长度是否匹配
     * @notice Validate array length - Check if array lengths match
     * @param addressArray1 第一个数组 First array
     * @param addressArray2 第二个数组 Second array
     */
    function validateArrayLength(address[] memory addressArray1, address[] memory addressArray2) internal pure {
        if (addressArray1.length != addressArray2.length) revert ArrayLengthMismatch(addressArray1.length, addressArray2.length);
    }
    
    /**
     * @notice 验证数组长度 - 检查数组长度是否匹配
     * @notice Validate array length - Check if array lengths match
     * @param addressArray1 第一个数组 First array
     * @param uintArray2 第二个数组 Second array
     */
    function validateArrayLength(address[] memory addressArray1, uint256[] memory uintArray2) internal pure {
        if (addressArray1.length != uintArray2.length) revert ArrayLengthMismatch(addressArray1.length, uintArray2.length);
    }
    
    /**
     * @notice 验证数组长度 - 检查数组长度是否匹配
     * @notice Validate array length - Check if array lengths match
     * @param bytes32Array1 第一个数组 First array
     * @param uintArray2 第二个数组 Second array
     */
    function validateArrayLength(bytes32[] memory bytes32Array1, uint256[] memory uintArray2) internal pure {
        if (bytes32Array1.length != uintArray2.length) revert ArrayLengthMismatch(bytes32Array1.length, uintArray2.length);
    }
    
    /**
     * @notice 验证数组长度 - 检查数组长度是否匹配
     * @notice Validate array length - Check if array lengths match
     * @param uintArray1 第一个数组 First array
     * @param uintArray2 第二个数组 Second array
     */
    function validateArrayLength(uint256[] memory uintArray1, uint256[] memory uintArray2) internal pure {
        if (uintArray1.length != uintArray2.length) revert ArrayLengthMismatch(uintArray1.length, uintArray2.length);
    }
    
    /**
     * @notice 验证数组长度 - 检查数组长度是否匹配
     * @notice Validate array length - Check if array lengths match
     * @param bytes32Array1 第一个数组 First array
     * @param addressArray2 第二个数组 Second array
     */
    function validateArrayLength(bytes32[] memory bytes32Array1, address[] memory addressArray2) internal pure {
        if (bytes32Array1.length != addressArray2.length) revert ArrayLengthMismatch(bytes32Array1.length, addressArray2.length);
    }
    
    /**
     * @notice 验证数组长度 - 检查数组长度是否匹配
     * @notice Validate array length - Check if array lengths match
     * @param addressArray1 第一个数组 First array
     * @param boolArray2 第二个数组 Second array
     */
    function validateArrayLength(address[] memory addressArray1, bool[] memory boolArray2) internal pure {
        if (addressArray1.length != boolArray2.length) revert ArrayLengthMismatch(addressArray1.length, boolArray2.length);
    }
    
    /**
     * @notice 批量验证地址 - 检查地址数组中的所有地址是否有效
     * @notice Batch validate addresses - Check if all addresses in array are valid
     * @param addressArray 地址数组 Array of addresses
     */
    function validateAddresses(address[] memory addressArray) internal pure {
        for (uint256 i = 0; i < addressArray.length; i++) {
            if (addressArray[i] == address(0)) revert ZeroAddress();
        }
    }

    /* ============ Module Key Validation Functions ============ */
    
    /**
     * @notice 验证模块键值 - 检查模块键值是否有效
     * @notice Validate module key - Check if module key is valid
     * @param moduleKeyInput 模块键值 Module key
     */
    function validateModuleKey(bytes32 moduleKeyInput) internal pure {
        if (moduleKeyInput == bytes32(0)) revert InvalidModuleKey(moduleKeyInput);
    }

    /* ============ Batch Size Validation Functions ============ */
    
    /**
     * @notice 验证批量大小 - 检查批量大小是否在有效范围内
     * @notice Validate batch size - Check if batch size is within valid range
     * @param batchSizeValue 批量大小 Batch size
     * @param maxSizeValue 最大大小 Maximum size
     */
    function validateBatchSize(uint256 batchSizeValue, uint256 maxSizeValue) internal pure {
        if (batchSizeValue == 0 || batchSizeValue > maxSizeValue) revert InvalidBatchSize(batchSizeValue, maxSizeValue);
    }
    
    /**
     * @notice 验证批量大小 - 检查批量大小是否在有效范围内
     * @notice Validate batch size - Check if batch size is within valid range
     * @param batchSizeValue 批量大小 Batch size
     */
    function validateBatchSize(uint256 batchSizeValue) internal pure {
        if (batchSizeValue == 0) revert InvalidBatchSize(batchSizeValue, 0);
    }

    /* ============ Price Validation Functions ============ */
    
    /**
     * @notice 验证价格 - 检查价格是否为零
     * @notice Validate price - Check if price is zero
     * @param priceValue 价格 Price
     */
    function validatePrice(uint256 priceValue) internal pure {
        if (priceValue == 0) revert PriceCannotBeZero();
    }

    /* ============ Record Validation Functions ============ */
    
    /**
     * @notice 验证记录存在 - 检查记录是否存在
     * @notice Validate record exists - Check if record exists
     * @param existsFlag 是否存在 Whether exists
     */
    function validateRecordExists(bool existsFlag) internal pure {
        if (!existsFlag) revert RecordNotFound();
    }
    
    /**
     * @notice 验证记录不存在 - 检查记录是否不存在
     * @notice Validate record not exists - Check if record doesn't exist
     * @param existsFlag 是否存在 Whether exists
     */
    function validateRecordNotExists(bool existsFlag) internal pure {
        if (existsFlag) revert RecordAlreadyExists();
    }

    /* ============ Stats Validation Functions ============ */
    
    /**
     * @notice 验证统计存在 - 检查统计是否存在
     * @notice Validate stats exists - Check if stats exist
     * @param existsFlag 是否存在 Whether exists
     */
    function validateStatsExists(bool existsFlag) internal pure {
        if (!existsFlag) revert StatsNotFound();
    }

    /* ============ Sufficiency Validation Functions ============ */
    
    /**
     * @notice 验证保证金充足 - 检查保证金是否充足
     * @notice Validate sufficient guarantee - Check if guarantee is sufficient
     * @param availableAmount 可用数量 Available amount
     * @param requiredAmount 需要数量 Required amount
     */
    function validateSufficientGuarantee(uint256 availableAmount, uint256 requiredAmount) internal pure {
        if (availableAmount < requiredAmount) revert InsufficientGuarantee();
    }
    
    /**
     * @notice 验证债务充足 - 检查债务是否充足
     * @notice Validate sufficient debt - Check if debt is sufficient
     * @param availableAmount 可用数量 Available amount
     * @param requiredAmount 需要数量 Required amount
     */
    function validateSufficientDebt(uint256 availableAmount, uint256 requiredAmount) internal pure {
        if (availableAmount < requiredAmount) revert InsufficientDebt();
    }
    
    /**
     * @notice 验证抵押物充足 - 检查抵押物是否充足
     * @notice Validate sufficient collateral - Check if collateral is sufficient
     * @param availableAmount 可用数量 Available amount
     * @param requiredAmount 需要数量 Required amount
     */
    function validateSufficientCollateral(uint256 availableAmount, uint256 requiredAmount) internal pure {
        if (availableAmount < requiredAmount) revert InsufficientCollateral();
    }

    /* ============ Composite Validation Functions ============ */
    
    /**
     * @notice 验证清算参数 - 验证清算相关的所有参数
     * @notice Validate liquidation parameters - Validate all liquidation-related parameters
     * @param userAddr 用户地址 User address
     * @param assetAddr 资产地址 Asset address
     * @param amountValue 数量 Amount
     * @param liquidatorAddr 清算人地址 Liquidator address
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
     * @notice 验证批量清算参数 - 验证批量清算相关的所有参数
     * @notice Validate batch liquidation parameters - Validate all batch liquidation-related parameters
     * @param userAddrs 用户地址数组 Array of user addresses
     * @param assetAddrs 资产地址数组 Array of asset addresses
     * @param amountValues 数量数组 Array of amounts
     * @param liquidatorAddr 清算人地址 Liquidator address
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
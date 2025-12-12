// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LiquidationValidationLibrary.sol";

/**
 * @title 清算工具库
 * @title Liquidation Utility Library
 * @author RWA Lending Platform
 * @notice 提供通用的工具函数，整合所有清算模块中重复的工具函数
 * @notice Provides common utility functions, integrates all repeated utility functions from liquidation modules
 * @dev 提供标准化的工具函数，确保一致性和可复用性
 * @dev Provides standardized utility functions to ensure consistency and reusability
 */
library LiquidationUtilityLibrary {
    using LiquidationValidationLibrary for *;

    /* ============ Constants ============ */
    
    /**
     * @notice 最大Gas限制 - 最大Gas限制
     * @notice Maximum gas limit - Maximum gas limit
     */
    uint256 public constant MAX_GAS_LIMIT = 30_000_000;
    
    /**
     * @notice 默认Gas限制 - 默认Gas限制
     * @notice Default gas limit - Default gas limit
     */
    uint256 public constant DEFAULT_GAS_LIMIT = 5_000_000;
    


    /* ============ Gas Optimization Functions ============ */
    
    /**
     * @notice 优化Gas使用 - 优化Gas使用
     * @notice Optimize gas usage - Optimize gas usage
     * @param gasLimitValue Gas限制 Gas limit
     * @return optimizedGasLimitValue 优化后的Gas限制 Optimized gas limit
     */
    function optimizeGasUsage(uint256 gasLimitValue) internal pure returns (uint256 optimizedGasLimitValue) {
        if (gasLimitValue > MAX_GAS_LIMIT) {
            optimizedGasLimitValue = MAX_GAS_LIMIT;
        } else if (gasLimitValue == 0) {
            optimizedGasLimitValue = DEFAULT_GAS_LIMIT;
        } else {
            optimizedGasLimitValue = gasLimitValue;
        }
    }

    /**
     * @notice 计算Gas成本 - 计算Gas成本
     * @notice Calculate gas cost - Calculate gas cost
     * @param gasUsedValue 使用的Gas Used gas
     * @param gasPriceValue Gas价格 Gas price
     * @return costValue Gas成本 Gas cost
     */
    function calculateGasCost(uint256 gasUsedValue, uint256 gasPriceValue) internal pure returns (uint256 costValue) {
        costValue = gasUsedValue * gasPriceValue;
    }

    /**
     * @notice 估算Gas使用量 - 估算Gas使用量
     * @notice Estimate gas usage - Estimate gas usage
     * @param operationTypeString 操作类型 Operation type
     * @param batchSizeValue 批量大小 Batch size
     * @return estimatedGasValue 估算Gas使用量 Estimated gas usage
     */
    function estimateGasUsage(string memory operationTypeString, uint256 batchSizeValue) internal pure returns (uint256 estimatedGasValue) {
        if (keccak256(abi.encodePacked(operationTypeString)) == keccak256(abi.encodePacked("transfer"))) {
            estimatedGasValue = 21000 + (batchSizeValue * 5000);
        } else if (keccak256(abi.encodePacked(operationTypeString)) == keccak256(abi.encodePacked("approve"))) {
            estimatedGasValue = 46000 + (batchSizeValue * 3000);
        } else if (keccak256(abi.encodePacked(operationTypeString)) == keccak256(abi.encodePacked("batch"))) {
            estimatedGasValue = 100000 + (batchSizeValue * 10000);
        } else {
            estimatedGasValue = 50000 + (batchSizeValue * 5000);
        }
        
        if (estimatedGasValue > MAX_GAS_LIMIT) {
            estimatedGasValue = MAX_GAS_LIMIT;
        }
    }

    /* ============ Array Utility Functions ============ */
    
    /**
     * @notice 查找数组中的元素 - 查找数组中的元素
     * @notice Find element in array - Find element in array
     * @param addressArray 数组 Array
     * @param targetElement 元素 Element
     * @return indexValue 索引 Index
     * @return foundFlag 是否找到 Whether found
     */
    function findInArray(
        address[] memory addressArray,
        address targetElement
    ) internal pure returns (uint256 indexValue, bool foundFlag) {
        for (uint256 i = 0; i < addressArray.length; i++) {
            if (addressArray[i] == targetElement) {
                return (i, true);
            }
        }
        return (0, false);
    }

    /**
     * @notice 查找数组中的元素 - 查找数组中的元素
     * @notice Find element in array - Find element in array
     * @param uintArray 数组 Array
     * @param targetElement 元素 Element
     * @return indexValue 索引 Index
     * @return foundFlag 是否找到 Whether found
     */
    function findInArray(
        uint256[] memory uintArray,
        uint256 targetElement
    ) internal pure returns (uint256 indexValue, bool foundFlag) {
        for (uint256 i = 0; i < uintArray.length; i++) {
            if (uintArray[i] == targetElement) {
                return (i, true);
            }
        }
        return (0, false);
    }

    /**
     * @notice 查找数组中的元素 - 查找数组中的元素
     * @notice Find element in array - Find element in array
     * @param bytes32Array 数组 Array
     * @param targetElement 元素 Element
     * @return indexValue 索引 Index
     * @return foundFlag 是否找到 Whether found
     */
    function findInArray(
        bytes32[] memory bytes32Array,
        bytes32 targetElement
    ) internal pure returns (uint256 indexValue, bool foundFlag) {
        for (uint256 i = 0; i < bytes32Array.length; i++) {
            if (bytes32Array[i] == targetElement) {
                return (i, true);
            }
        }
        return (0, false);
    }

    /**
     * @notice 移除数组中的元素 - 移除数组中的元素
     * @notice Remove element from array - Remove element from array
     * @param addressArray 数组 Array
     * @param targetIndex 索引 Index
     * @return newAddressArray 新数组 New array
     */
    function removeFromArray(
        address[] memory addressArray,
        uint256 targetIndex
    ) internal pure returns (address[] memory newAddressArray) {
        if (targetIndex >= addressArray.length) return addressArray;
        
        newAddressArray = new address[](addressArray.length - 1);
        uint256 newIndexValue = 0;
        
        for (uint256 i = 0; i < addressArray.length; i++) {
            if (i != targetIndex) {
                newAddressArray[newIndexValue] = addressArray[i];
                newIndexValue++;
            }
        }
    }

    /**
     * @notice 移除数组中的元素 - 移除数组中的元素
     * @notice Remove element from array - Remove element from array
     * @param uintArray 数组 Array
     * @param targetIndex 索引 Index
     * @return newUintArray 新数组 New array
     */
    function removeFromArray(
        uint256[] memory uintArray,
        uint256 targetIndex
    ) internal pure returns (uint256[] memory newUintArray) {
        if (targetIndex >= uintArray.length) return uintArray;
        
        newUintArray = new uint256[](uintArray.length - 1);
        uint256 newIndexValue = 0;
        
        for (uint256 i = 0; i < uintArray.length; i++) {
            if (i != targetIndex) {
                newUintArray[newIndexValue] = uintArray[i];
                newIndexValue++;
            }
        }
    }

    /**
     * @notice 移除数组中的元素 - 移除数组中的元素
     * @notice Remove element from array - Remove element from array
     * @param bytes32Array 数组 Array
     * @param targetIndex 索引 Index
     * @return newBytes32Array 新数组 New array
     */
    function removeFromArray(
        bytes32[] memory bytes32Array,
        uint256 targetIndex
    ) internal pure returns (bytes32[] memory newBytes32Array) {
        if (targetIndex >= bytes32Array.length) return bytes32Array;
        
        newBytes32Array = new bytes32[](bytes32Array.length - 1);
        uint256 newIndexValue = 0;
        
        for (uint256 i = 0; i < bytes32Array.length; i++) {
            if (i != targetIndex) {
                newBytes32Array[newIndexValue] = bytes32Array[i];
                newIndexValue++;
            }
        }
    }

    /**
     * @notice 合并数组 - 合并数组
     * @notice Merge arrays - Merge arrays
     * @param addressArray1 数组1 Array 1
     * @param addressArray2 数组2 Array 2
     * @return mergedAddressArray 合并后的数组 Merged array
     */
    function mergeArrays(
        address[] memory addressArray1,
        address[] memory addressArray2
    ) internal pure returns (address[] memory mergedAddressArray) {
        mergedAddressArray = new address[](addressArray1.length + addressArray2.length);
        
        for (uint256 i = 0; i < addressArray1.length; i++) {
            mergedAddressArray[i] = addressArray1[i];
        }
        
        for (uint256 i = 0; i < addressArray2.length; i++) {
            mergedAddressArray[addressArray1.length + i] = addressArray2[i];
        }
    }

    /**
     * @notice 合并数组 - 合并数组
     * @notice Merge arrays - Merge arrays
     * @param uintArray1 数组1 Array 1
     * @param uintArray2 数组2 Array 2
     * @return mergedUintArray 合并后的数组 Merged array
     */
    function mergeArrays(
        uint256[] memory uintArray1,
        uint256[] memory uintArray2
    ) internal pure returns (uint256[] memory mergedUintArray) {
        mergedUintArray = new uint256[](uintArray1.length + uintArray2.length);
        
        for (uint256 i = 0; i < uintArray1.length; i++) {
            mergedUintArray[i] = uintArray1[i];
        }
        
        for (uint256 i = 0; i < uintArray2.length; i++) {
            mergedUintArray[uintArray1.length + i] = uintArray2[i];
        }
    }

    /* ============ String Utility Functions ============ */
    
    /**
     * @notice 比较字符串 - 比较字符串
     * @notice Compare strings - Compare strings
     * @param stringA 字符串A String A
     * @param stringB 字符串B String B
     * @return equalFlag 是否相等 Whether equal
     */
    function compareStrings(
        string memory stringA,
        string memory stringB
    ) internal pure returns (bool equalFlag) {
        return keccak256(abi.encodePacked(stringA)) == keccak256(abi.encodePacked(stringB));
    }

    /**
     * @notice 连接字符串 - 连接字符串
     * @notice Concatenate strings - Concatenate strings
     * @param stringA 字符串A String A
     * @param stringB 字符串B String B
     * @return resultString 连接结果 Concatenation result
     */
    function concatenateStrings(
        string memory stringA,
        string memory stringB
    ) internal pure returns (string memory resultString) {
        return string(abi.encodePacked(stringA, stringB));
    }

    /**
     * @notice 字符串长度 - 字符串长度
     * @notice String length - String length
     * @param inputString 字符串 String
     * @return lengthValue 长度 Length
     */
    function stringLength(string memory inputString) internal pure returns (uint256 lengthValue) {
        lengthValue = bytes(inputString).length;
    }

    /* ============ Bytes Utility Functions ============ */
    
    /**
     * @notice 比较字节数组 - 比较字节数组
     * @notice Compare bytes arrays - Compare bytes arrays
     * @param bytesA 字节数组A Bytes array A
     * @param bytesB 字节数组B Bytes array B
     * @return equalFlag 是否相等 Whether equal
     */
    function compareBytes(
        bytes memory bytesA,
        bytes memory bytesB
    ) internal pure returns (bool equalFlag) {
        if (bytesA.length != bytesB.length) return false;
        
        for (uint256 i = 0; i < bytesA.length; i++) {
            if (bytesA[i] != bytesB[i]) return false;
        }
        
        return true;
    }

    /**
     * @notice 连接字节数组 - 连接字节数组
     * @notice Concatenate bytes arrays - Concatenate bytes arrays
     * @param bytesA 字节数组A Bytes array A
     * @param bytesB 字节数组B Bytes array B
     * @return resultBytes 连接结果 Concatenation result
     */
    function concatenateBytes(
        bytes memory bytesA,
        bytes memory bytesB
    ) internal pure returns (bytes memory resultBytes) {
        resultBytes = new bytes(bytesA.length + bytesB.length);
        
        for (uint256 i = 0; i < bytesA.length; i++) {
            resultBytes[i] = bytesA[i];
        }
        
        for (uint256 i = 0; i < bytesB.length; i++) {
            resultBytes[bytesA.length + i] = bytesB[i];
        }
    }

    /**
     * @notice 字节数组长度 - 字节数组长度
     * @notice Bytes array length - Bytes array length
     * @param inputBytes 字节数组 Bytes array
     * @return lengthValue 长度 Length
     */
    function bytesLength(bytes memory inputBytes) internal pure returns (uint256 lengthValue) {
        lengthValue = inputBytes.length;
    }

    /* ============ Math Utility Functions ============ */
    
    /**
     * @notice 最小值 - 最小值
     * @notice Minimum value - Minimum value
     * @param valueA 值A Value A
     * @param valueB 值B Value B
     * @return minValue 最小值 Minimum value
     */
    function min(uint256 valueA, uint256 valueB) internal pure returns (uint256 minValue) {
        return valueA < valueB ? valueA : valueB;
    }

    /**
     * @notice 最大值 - 最大值
     * @notice Maximum value - Maximum value
     * @param valueA 值A Value A
     * @param valueB 值B Value B
     * @return maxValue 最大值 Maximum value
     */
    function max(uint256 valueA, uint256 valueB) internal pure returns (uint256 maxValue) {
        return valueA > valueB ? valueA : valueB;
    }

    /**
     * @notice 绝对值 - 绝对值
     * @notice Absolute value - Absolute value
     * @param inputValue 值 Value
     * @return absValue 绝对值 Absolute value
     */
    function abs(int256 inputValue) internal pure returns (uint256 absValue) {
        return inputValue < 0 ? uint256(-inputValue) : uint256(inputValue);
    }

    /**
     * @notice 平均值 - 平均值
     * @notice Average value - Average value
     * @param valueA 值A Value A
     * @param valueB 值B Value B
     * @return avgValue 平均值 Average value
     */
    function average(uint256 valueA, uint256 valueB) internal pure returns (uint256 avgValue) {
        return (valueA + valueB) / 2;
    }

    /**
     * @notice 百分比计算 - 百分比计算
     * @notice Percentage calculation - Percentage calculation
     * @param inputValue 值 Value
     * @param percentageValue 百分比 Percentage
     * @return resultValue 结果 Result
     */
    function calculatePercentage(uint256 inputValue, uint256 percentageValue) internal pure returns (uint256 resultValue) {
        resultValue = (inputValue * percentageValue) / 100;
    }

    /* ============ Time Utility Functions ============ */
    
    /**
     * @notice 获取当前时间戳 - 获取当前时间戳
     * @notice Get current timestamp - Get current timestamp
     * @return currentTimestamp 时间戳 Timestamp
     */
    function getCurrentTimestamp() internal view returns (uint256 currentTimestamp) {
        currentTimestamp = block.timestamp;
    }

    /**
     * @notice 检查是否过期 - 检查是否过期
     * @notice Check if expired - Check if expired
     * @param timestampValue 时间戳 Timestamp
     * @param durationValue 持续时间 Duration
     * @return expiredFlag 是否过期 Whether expired
     */
    function isExpired(uint256 timestampValue, uint256 durationValue) internal view returns (bool expiredFlag) {
        expiredFlag = block.timestamp > (timestampValue + durationValue);
    }

    /**
     * @notice 计算剩余时间 - 计算剩余时间
     * @notice Calculate remaining time - Calculate remaining time
     * @param startTimeValue 开始时间 Start time
     * @param durationValue 持续时间 Duration
     * @return remainingTimeValue 剩余时间 Remaining time
     */
    function calculateRemainingTime(uint256 startTimeValue, uint256 durationValue) internal view returns (uint256 remainingTimeValue) {
        uint256 endTimeValue = startTimeValue + durationValue;
        if (block.timestamp >= endTimeValue) {
            remainingTimeValue = 0;
        } else {
            remainingTimeValue = endTimeValue - block.timestamp;
        }
    }

    /* ============ Address Utility Functions ============ */
    
    /**
     * @notice 检查是否为合约地址 - 检查是否为合约地址
     * @notice Check if contract address - Check if contract address
     * @param targetAddr 地址 Address
     * @return isContractFlag 是否为合约地址 Whether contract address
     */
    function isContract(address targetAddr) internal view returns (bool isContractFlag) {
        uint256 sizeValue;
        assembly {
            sizeValue := extcodesize(targetAddr)
        }
        return sizeValue > 0;
    }

    /**
     * @notice 生成地址哈希 - 生成地址哈希
     * @notice Generate address hash - Generate address hash
     * @param targetAddr 地址 Address
     * @return hashValue 哈希 Hash
     */
    function generateAddressHash(address targetAddr) internal pure returns (bytes32 hashValue) {
        hashValue = keccak256(abi.encodePacked(targetAddr));
    }

    /* ============ Hash Utility Functions ============ */
    
    /**
     * @notice 生成字符串哈希 - 生成字符串哈希
     * @notice Generate string hash - Generate string hash
     * @param inputString 字符串 String
     * @return hashValue 哈希 Hash
     */
    function generateStringHash(string memory inputString) internal pure returns (bytes32 hashValue) {
        hashValue = keccak256(abi.encodePacked(inputString));
    }

    /**
     * @notice 生成多参数哈希 - 生成多参数哈希
     * @notice Generate multi-parameter hash - Generate multi-parameter hash
     * @param paramBytes 参数 Parameters
     * @return hashValue 哈希 Hash
     */
    function generateMultiParamHash(bytes memory paramBytes) internal pure returns (bytes32 hashValue) {
        hashValue = keccak256(paramBytes);
    }

    /**
     * @notice 生成时间戳哈希 - 生成时间戳哈希
     * @notice Generate timestamp hash - Generate timestamp hash
     * @param timestampValue 时间戳 Timestamp
     * @return hashValue 哈希 Hash
     */
    function generateTimestampHash(uint256 timestampValue) internal pure returns (bytes32 hashValue) {
        hashValue = keccak256(abi.encodePacked(timestampValue));
    }

    /* ============ Validation Utility Functions ============ */
    
    /**
     * @notice 验证地址范围 - 验证地址范围
     * @notice Validate address range - Validate address range
     * @param targetAddr 地址 Address
     * @param minAddrValue 最小地址 Minimum address
     * @param maxAddrValue 最大地址 Maximum address
     * @return validFlag 是否有效 Whether valid
     */
    function validateAddressRange(
        address targetAddr,
        address minAddrValue,
        address maxAddrValue
    ) internal pure returns (bool validFlag) {
        validFlag = targetAddr >= minAddrValue && targetAddr <= maxAddrValue;
    }

    /**
     * @notice 验证金额范围 - 验证金额范围
     * @notice Validate amount range - Validate amount range
     * @param amountValue 金额 Amount
     * @param minAmountValue 最小金额 Minimum amount
     * @param maxAmountValue 最大金额 Maximum amount
     * @return validFlag 是否有效 Whether valid
     */
    function validateAmountRange(
        uint256 amountValue,
        uint256 minAmountValue,
        uint256 maxAmountValue
    ) internal pure returns (bool validFlag) {
        validFlag = amountValue >= minAmountValue && amountValue <= maxAmountValue;
    }

    /**
     * @notice 验证时间范围 - 验证时间范围
     * @notice Validate time range - Validate time range
     * @param timeValue 时间 Time
     * @param minTimeValue 最小时间 Minimum time
     * @param maxTimeValue 最大时间 Maximum time
     * @return validFlag 是否有效 Whether valid
     */
    function validateTimeRange(
        uint256 timeValue,
        uint256 minTimeValue,
        uint256 maxTimeValue
    ) internal pure returns (bool validFlag) {
        validFlag = timeValue >= minTimeValue && timeValue <= maxTimeValue;
    }
} 
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ZeroAddress, AmountIsZero, InvalidHealthFactor, InvalidLTV } from "../errors/StandardErrors.sol";

/// @title VaultUtils
/// @notice 提供通用的验证和工具函数，供所有模块使用
/// @dev 这是一个纯工具库，不包含状态变量，所有函数都是 pure 或 view
library VaultUtils {
    
    /* ============ Constants ============ */
    /// @notice 最小有效健康因子（100% = 10000 bps）
    uint256 internal constant MIN_VALID_HF_BPS = 10000;
    
    /// @notice 最大有效 LTV（100% = 10000 bps）
    uint256 internal constant MAX_VALID_LTV_BPS = 10000;
    
    /// @notice 默认最小健康因子（110% = 11000 bps）
    uint256 internal constant DEFAULT_MIN_HF_BPS = 11000;

    /* ============ Validation Functions ============ */
    
    /// @notice 验证地址不为零地址
    /// @param addr 待验证的地址
    function validateAddress(address addr) internal pure {
        if (addr == address(0)) revert ZeroAddress();
    }

    /// @notice 验证金额大于零
    /// @param amount 待验证的金额
    function validateAmount(uint256 amount) internal pure {
        if (amount == 0) revert AmountIsZero();
    }

    /// @notice 验证健康因子在有效范围内
    /// @param hf 健康因子值（基点）
    /// @dev 健康因子必须在 100% (10000) 以上
    function validateHealthFactor(uint256 hf) internal pure {
        if (hf < MIN_VALID_HF_BPS) revert InvalidHealthFactor();
    }

    /// @notice 验证 LTV 在有效范围内
    /// @param ltv 贷款价值比（基点）
    /// @dev LTV 必须在 0-100% (0-10000) 范围内
    function validateLTV(uint256 ltv) internal pure {
        if (ltv > MAX_VALID_LTV_BPS) revert InvalidLTV();
    }

    /// @notice 验证参数不为零
    /// @param param 待验证的参数
    function validateNonZero(uint256 param, string memory /* paramName */) internal pure {
        if (param == 0) revert AmountIsZero();
    }

    /* ============ Module Address Utilities ============ */
    
    /// @notice 验证模块地址是否已设置
    /// @param moduleAddr 模块地址
    /// @return 是否已设置
    function isModuleConfigured(address moduleAddr) internal pure returns (bool) {
        return moduleAddr != address(0);
    }

    /// @notice 获取模块地址，如果未配置则回退到默认值
    /// @param moduleAddr 模块地址
    /// @param fallbackAddr 回退地址
    /// @return 有效的模块地址
    function getModuleAddress(address moduleAddr, address fallbackAddr) internal pure returns (address) {
        return moduleAddr != address(0) ? moduleAddr : fallbackAddr;
    }

    /// @notice 安全获取模块地址，如果未配置则回退到默认值
    /// @param moduleAddr 模块地址
    /// @param fallbackAddr 回退地址
    /// @return 有效的模块地址
    function getModuleAddressSafe(
        address moduleAddr, 
        address fallbackAddr, 
        string memory /* moduleName */
    ) internal pure returns (address) {
        address result = getModuleAddress(moduleAddr, fallbackAddr);
        if (result == address(0)) {
            revert ZeroAddress();
        }
        return result;
    }

    /* ============ Math Utilities ============ */
    
    /// @notice 计算百分比（basis points）- 已迁移到 VaultMath 库
    /// @param amount 基础金额
    /// @param bps 基点（1% = 100 bps）
    /// @return 计算结果
    /// @dev 请使用 VaultMath.percentageMul() 替代此函数
    function calculateBps(uint256 amount, uint256 bps) internal pure returns (uint256) {
        return (amount * bps) / 10000;
    }

    /// @notice 计算 LTV（贷款价值比）- 已迁移到 VaultMath 库
    /// @param debt 债务金额
    /// @param collateral 抵押物价值
    /// @return ltv 贷款价值比（basis points）
    /// @dev 请使用 VaultMath.calculateLTV() 替代此函数
    function calculateLTV(uint256 debt, uint256 collateral) internal pure returns (uint256 ltv) {
        if (collateral == 0) return 0;
        return (debt * 10000) / collateral;
    }

    /// @notice 计算健康因子 - 已迁移到 VaultMath 库
    /// @param collateral 抵押物价值
    /// @param debt 债务金额
    /// @param bonusBps 奖励基点
    /// @return 健康因子（basis points）
    /// @dev 请使用 VaultMath.calculateHealthFactor() 替代此函数
    function calculateHealthFactor(uint256 collateral, uint256 debt, uint256 bonusBps) internal pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        return (collateral * (10000 + bonusBps)) / debt;
    }

    /// @notice 计算最小健康因子 - 已迁移到 VaultMath 库
    /// @param collateral 抵押物价值
    /// @param debt 债务金额
    /// @return 最小健康因子
    /// @dev 请使用 VaultMath.calculateHealthFactor() 替代此函数
    function calculateMinHealthFactor(uint256 collateral, uint256 debt) internal pure returns (uint256) {
        return calculateHealthFactor(collateral, debt, 0);
    }

    /* ============ Comparison Utilities ============ */
    
    /// @notice 检查是否大于零
    /// @param value 待检查的值
    /// @return 是否大于零
    function isGreaterThanZero(uint256 value) internal pure returns (bool) {
        return value > 0;
    }

    /// @notice 检查是否为零
    /// @param value 待检查的值
    /// @return 是否为零
    function isZero(uint256 value) internal pure returns (bool) {
        return value == 0;
    }

    /// @notice 检查地址是否为零地址
    /// @param addr 待检查的地址
    /// @return 是否为零地址
    function isZeroAddress(address addr) internal pure returns (bool) {
        return addr == address(0);
    }

    /* ============ Array Utilities ============ */
    
    /// @notice 检查数组长度是否相等
    /// @param arr1 第一个数组
    /// @param arr2 第二个数组
    /// @return 是否相等
    function arraysEqualLength(address[] memory arr1, address[] memory arr2) internal pure returns (bool) {
        return arr1.length == arr2.length;
    }

    /// @notice 检查数组长度是否相等
    /// @param arr1 第一个数组
    /// @param arr2 第二个数组
    /// @return 是否相等
    function arraysEqualLength(uint256[] memory arr1, uint256[] memory arr2) internal pure returns (bool) {
        return arr1.length == arr2.length;
    }

    /// @notice 验证数组不为空
    /// @param arr 待验证的数组
    function validateNonEmptyArray(address[] memory arr) internal pure {
        if (arr.length == 0) revert AmountIsZero();
    }

    /// @notice 验证数组不为空
    /// @param arr 待验证的数组
    function validateNonEmptyArray(uint256[] memory arr) internal pure {
        if (arr.length == 0) revert AmountIsZero();
    }
} 
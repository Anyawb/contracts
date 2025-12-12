// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { LiquidationTypes } from "../Vault/liquidation/types/LiquidationTypes.sol";

/// @title ILiquidationRecordManager
/// @notice 清算记录管理器接口，负责清算记录和事件管理
/// @dev 提供清算记录存储、事件发出、记录开关管理等功能
interface ILiquidationRecordManager {
    /* ============ Record Management Functions ============ */
    /// @notice 记录清算操作
    /// @param user 用户地址
    function recordLiquidation(address user) external;

    /// @notice 发出清算事件
    /// @param user 用户地址
    /// @param collateralAsset 抵押资产地址
    /// @param debtAsset 债务资产地址
    /// @param result 清算结果
    /// @param liquidator 清算人地址
    function emitLiquidationEvents(
        address user,
        address collateralAsset,
        address debtAsset,
        LiquidationTypes.LiquidationResult calldata result,
        address liquidator
    ) external;

    /* ============ Query Functions ============ */
    /// @notice 获取用户清算次数
    /// @param user 用户地址
    /// @return count 清算次数
    function getUserLiquidationCount(address user) external view returns (uint256 count);

    /// @notice 获取用户清算时间戳
    /// @param user 用户地址
    /// @return timestamps 时间戳数组
    function getUserLiquidationTimestamps(address user) external view returns (uint256[] memory timestamps);

    /// @notice 获取用户指定索引的清算时间戳
    /// @param user 用户地址
    /// @param index 索引
    /// @return timestamp 时间戳
    function getUserLiquidationTimestampAtIndex(address user, uint256 index) external view returns (uint256 timestamp);

    /// @notice 检查记录功能是否启用
    /// @return enabled 是否启用
    function isRecordEnabled() external view returns (bool enabled);

    /* ============ Admin Functions ============ */
    /// @notice 更新清算记录开关
    /// @param newEnabled 新的开关状态
    function updateLiquidationRecordEnabled(bool newEnabled) external;

    /// @notice 清除用户清算记录
    /// @param user 用户地址
    function clearUserLiquidationRecords(address user) external;

    /// @notice 清除所有清算记录
    function clearAllLiquidationRecords() external;

    /* ============ Module Management Functions ============ */
    /// @notice 获取模块地址
    /// @param moduleKey 模块键
    /// @return moduleAddress 模块地址
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress);
} 
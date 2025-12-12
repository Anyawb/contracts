// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILiquidationEventsView
/// @notice 仅用于接收业务侧（清算）推送并转发到统一 DataPush 流的 View 接口
/// @dev 与查询接口 `ILiquidationView` 解耦，避免强制实现大量只读函数
interface ILiquidationEventsView {
    /// @notice 单笔清算完成后的推送（供链下与缓存消费）
    /// @param user 被清算用户
    /// @param collateralAsset 被扣押的抵押资产
    /// @param debtAsset 被偿还的债务资产
    /// @param collateralAmount 抵押扣押数量
    /// @param debtAmount 债务清偿数量
    /// @param liquidator 清算人
    /// @param bonus 实得清算奖励
    /// @param timestamp 区块时间戳
    function pushLiquidationUpdate(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        uint256 timestamp
    ) external;

    /// @notice 批量清算完成后的推送（批量聚合）
    /// @param users 被清算用户数组
    /// @param collateralAssets 抵押资产数组
    /// @param debtAssets 债务资产数组
    /// @param collateralAmounts 抵押扣押数量数组
    /// @param debtAmounts 债务清偿数量数组
    /// @param liquidator 清算人
    /// @param bonuses 奖励数组
    /// @param timestamp 区块时间戳
    function pushBatchLiquidationUpdate(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        address liquidator,
        uint256[] calldata bonuses,
        uint256 timestamp
    ) external;
}



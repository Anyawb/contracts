// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILiquidationEventsView } from "../interfaces/ILiquidationEventsView.sol";

/// @title MockLiquidationEventsView
/// @notice 清算事件视图的Mock实现，用于测试
contract MockLiquidationEventsView is ILiquidationEventsView {
    // 清算事件记录
    mapping(address => uint256) private _userLiquidationCount;
    mapping(address => uint256) private _liquidatorTotalBonus;
    uint256 private _totalLiquidations;
    
    // 事件
    event MockLiquidationEventPushed(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        uint256 timestamp
    );

    event MockBatchLiquidationEventPushed(
        address[] users,
        address[] collateralAssets,
        address[] debtAssets,
        uint256[] collateralAmounts,
        uint256[] debtAmounts,
        address liquidator,
        uint256[] bonuses,
        uint256 timestamp
    );

    /// @notice 推送单笔清算更新
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
    ) external override {
        _userLiquidationCount[user]++;
        _liquidatorTotalBonus[liquidator] += bonus;
        _totalLiquidations++;
        
        emit MockLiquidationEventPushed(
            user,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            liquidator,
            bonus,
            timestamp
        );
    }

    /// @notice 推送批量清算更新
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
    ) external override {
        for (uint256 i = 0; i < users.length; i++) {
            _userLiquidationCount[users[i]]++;
            _liquidatorTotalBonus[liquidator] += bonuses[i];
            _totalLiquidations++;
        }
        
        emit MockBatchLiquidationEventPushed(
            users,
            collateralAssets,
            debtAssets,
            collateralAmounts,
            debtAmounts,
            liquidator,
            bonuses,
            timestamp
        );
    }

    function pushLiquidationPayout(
        address,
        address,
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) external override {
        // no-op for mock
    }

    // 测试辅助函数
    /// @notice 获取用户清算次数
    /// @param user 用户地址
    /// @return 清算次数
    function getUserLiquidationCount(address user) external view returns (uint256) {
        return _userLiquidationCount[user];
    }

    /// @notice 获取清算人总奖励
    /// @param liquidator 清算人地址
    /// @return 总奖励
    function getLiquidatorTotalBonus(address liquidator) external view returns (uint256) {
        return _liquidatorTotalBonus[liquidator];
    }

    /// @notice 获取总清算次数
    /// @return 总清算次数
    function getTotalLiquidations() external view returns (uint256) {
        return _totalLiquidations;
    }
}

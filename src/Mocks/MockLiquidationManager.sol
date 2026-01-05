// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILiquidationManager } from "../interfaces/ILiquidationManager.sol";

/// @title MockLiquidationManager
/// @notice 清算管理器的Mock实现，用于测试
contract MockLiquidationManager is ILiquidationManager {
    // 清算配置
    uint256 private _liquidationBonusRate = 500; // 5% 清算奖励
    uint256 private _liquidationThreshold = 11000; // 110% 清算阈值
    
    // 清算统计
    mapping(address => uint256) private _userLiquidationCount;
    mapping(address => uint256) private _liquidatorTotalBonus;
    uint256 private _totalLiquidations;
    
    // 事件
    event MockLiquidationExecuted(
        address indexed liquidator,
        address indexed user,
        address indexed collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus,
        uint256 timestamp
    );

    /// @notice 执行清算操作（Mock：不改账本，只做输入校验与事件/计数）
    /// @dev bonus 为可选透传；若传 0 则按 debtAmount * rate 计算
    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external override {
        require(targetUser != address(0), "Invalid user address");
        require(collateralAsset != address(0), "Invalid collateral asset");
        require(debtAsset != address(0), "Invalid debt asset");
        require(collateralAmount > 0, "Invalid collateral amount");
        require(debtAmount > 0, "Invalid debt amount");
        
        // 计算/透传清算奖励
        if (bonus == 0) {
            bonus = (debtAmount * _liquidationBonusRate) / 10000;
        }
        
        // 更新统计
        _userLiquidationCount[targetUser]++;
        _liquidatorTotalBonus[msg.sender] += bonus;
        _totalLiquidations++;
        
        // 发出事件
        emit MockLiquidationExecuted(
            msg.sender,
            targetUser,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            bonus,
            block.timestamp
        );
    }

    /// @notice 批量清算操作
    /// @param targetUsers 被清算用户地址数组
    /// @param collateralAssets 抵押资产地址数组
    /// @param debtAssets 债务资产地址数组
    /// @param collateralAmounts 清算抵押物数量数组
    /// @param debtAmounts 清算债务数量数组
    /// @param bonuses 清算奖励数组（可为 0，表示按默认公式计算）
    function batchLiquidate(
        address[] calldata targetUsers,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        uint256[] calldata bonuses
    ) external override {
        require(
            targetUsers.length == collateralAssets.length &&
            targetUsers.length == debtAssets.length &&
            targetUsers.length == collateralAmounts.length &&
            targetUsers.length == debtAmounts.length &&
            targetUsers.length == bonuses.length,
            "Length mismatch"
        );
        for (uint256 i = 0; i < targetUsers.length; i++) {
            uint256 b = bonuses[i];
            if (b == 0) {
                b = (debtAmounts[i] * _liquidationBonusRate) / 10000;
            }
            // 复用单笔逻辑（不调用 external 以避免 msg.sender 变化）
            require(targetUsers[i] != address(0), "Invalid user address");
            require(collateralAssets[i] != address(0), "Invalid collateral asset");
            require(debtAssets[i] != address(0), "Invalid debt asset");
            require(collateralAmounts[i] > 0, "Invalid collateral amount");
            require(debtAmounts[i] > 0, "Invalid debt amount");

            _userLiquidationCount[targetUsers[i]]++;
            _liquidatorTotalBonus[msg.sender] += b;
            _totalLiquidations++;

            emit MockLiquidationExecuted(
                msg.sender,
                targetUsers[i],
                collateralAssets[i],
                debtAssets[i],
                collateralAmounts[i],
                debtAmounts[i],
                b,
                block.timestamp
            );
        }
    }

    // 测试辅助函数
    /// @notice 设置清算奖励比例
    /// @param bonusRate 新的奖励比例
    function setLiquidationBonusRate(uint256 bonusRate) external {
        _liquidationBonusRate = bonusRate;
    }

    /// @notice 设置清算阈值
    /// @param threshold 新的清算阈值
    function setLiquidationThreshold(uint256 threshold) external {
        _liquidationThreshold = threshold;
    }

    /// @notice 获取用户清算次数
    /// @param user 用户地址
    /// @return count 清算次数
    function getUserLiquidationCount(address user) external view returns (uint256 count) {
        return _userLiquidationCount[user];
    }

    /// @notice 获取清算人总奖励
    /// @param liquidator 清算人地址
    /// @return totalBonus 总奖励
    function getLiquidatorTotalBonus(address liquidator) external view returns (uint256 totalBonus) {
        return _liquidatorTotalBonus[liquidator];
    }

    /// @notice 获取总清算次数
    /// @return totalLiquidations 总清算次数
    function getTotalLiquidations() external view returns (uint256 totalLiquidations) {
        return _totalLiquidations;
    }
}

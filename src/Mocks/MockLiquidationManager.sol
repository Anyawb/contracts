// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILiquidationManager } from "../interfaces/ILiquidationManager.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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

    /// @notice 执行清算操作
    /// @param user 被清算用户地址
    /// @param collateralAsset 抵押资产地址
    /// @param debtAsset 债务资产地址
    /// @param collateralAmount 清算抵押物数量
    /// @param debtAmount 清算债务数量
    /// @return bonus 清算奖励金额
    function liquidate(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external override returns (uint256 bonus) {
        require(user != address(0), "Invalid user address");
        require(collateralAsset != address(0), "Invalid collateral asset");
        require(debtAsset != address(0), "Invalid debt asset");
        require(collateralAmount > 0, "Invalid collateral amount");
        require(debtAmount > 0, "Invalid debt amount");
        
        // 计算清算奖励
        bonus = (debtAmount * _liquidationBonusRate) / 10000;
        
        // 更新统计
        _userLiquidationCount[user]++;
        _liquidatorTotalBonus[msg.sender] += bonus;
        _totalLiquidations++;
        
        // 发出事件
        emit MockLiquidationExecuted(
            msg.sender,
            user,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            bonus,
            block.timestamp
        );
        
        // 发出标准事件
        emit LiquidationExecuted(
            msg.sender,
            user,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            bonus,
            block.timestamp
        );
        
        return bonus;
    }

    /// @notice 批量清算操作
    /// @param users 被清算用户地址数组
    /// @param collateralAssets 抵押资产地址数组
    /// @param debtAssets 债务资产地址数组
    /// @param collateralAmounts 清算抵押物数量数组
    /// @param debtAmounts 清算债务数量数组
    /// @return bonuses 清算奖励金额数组
    function batchLiquidate(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts
    ) external override returns (uint256[] memory bonuses) {
        require(
            users.length == collateralAssets.length &&
            users.length == debtAssets.length &&
            users.length == collateralAmounts.length &&
            users.length == debtAmounts.length,
            "Length mismatch"
        );
        
        bonuses = new uint256[](users.length);
        
        for (uint256 i = 0; i < users.length; i++) {
            bonuses[i] = this.liquidate(
                users[i],
                collateralAssets[i],
                debtAssets[i],
                collateralAmounts[i],
                debtAmounts[i]
            );
        }
        
        return bonuses;
    }

    /// @notice 检查用户是否可被清算
    /// @param user 用户地址
    /// @return liquidatable 是否可被清算
    function isLiquidatable(address user) external pure override returns (bool liquidatable) {
        // 使用参数以满足NatSpec与静态检查
        user;
        // Mock实现：总是返回true，表示用户可被清算
        return true;
    }

    /// @notice 获取用户清算风险评分
    /// @param user 用户地址
    /// @return riskScore 风险评分
    function getLiquidationRiskScore(address user) external pure override returns (uint256 riskScore) {
        user;
        // Mock实现：返回固定风险评分
        return 75; // 75% 风险
    }

    /// @notice 获取用户健康因子
    /// @param user 用户地址
    /// @return healthFactor 健康因子
    function getUserHealthFactor(address user) external pure override returns (uint256 healthFactor) {
        user;
        // Mock实现：返回低于清算阈值的健康因子
        return 9000; // 90% 健康因子，低于110%阈值
    }

    /// @notice 扣押用户抵押物
    /// @param user 被清算用户地址
    /// @param asset 抵押资产地址
    /// @param amount 扣押数量
    /// @param liquidator 清算人地址
    /// @return seizedAmount 实际扣押数量
    function seizeCollateral(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external override returns (uint256 seizedAmount) {
        require(user != address(0), "Invalid user address");
        require(asset != address(0), "Invalid asset address");
        require(amount > 0, "Invalid amount");
        require(liquidator != address(0), "Invalid liquidator address");
        
        // Mock实现：直接返回请求的金额
        seizedAmount = amount;
        
        // 发出事件
        emit MockLiquidationExecuted(
            liquidator,
            user,
            asset,
            address(0), // debtAsset
            seizedAmount,
            0, // debtAmount
            0, // bonus
            block.timestamp
        );
        
        return seizedAmount;
    }

    /// @notice 减少用户债务
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 减少数量
    /// @param liquidator 清算人地址
    /// @return reducedAmount 实际减少数量
    function reduceDebt(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) external override returns (uint256 reducedAmount) {
        require(user != address(0), "Invalid user address");
        require(asset != address(0), "Invalid asset address");
        require(amount > 0, "Invalid amount");
        require(liquidator != address(0), "Invalid liquidator address");
        
        // Mock实现：直接返回请求的金额
        reducedAmount = amount;
        
        // 发出事件
        emit MockLiquidationExecuted(
            liquidator,
            user,
            address(0), // collateralAsset
            asset,
            0, // collateralAmount
            reducedAmount,
            0, // bonus
            block.timestamp
        );
        
        return reducedAmount;
    }

    /// @notice 获取清算奖励比例
    /// @return bonusRate 清算奖励比例
    function getLiquidationBonusRate() external view override returns (uint256 bonusRate) {
        return _liquidationBonusRate;
    }

    /// @notice 获取清算阈值
    /// @return threshold 清算阈值
    function getLiquidationThreshold() external view returns (uint256 threshold) {
        return _liquidationThreshold;
    }

    /// @notice 计算清算奖励
    /// @param amount 清算金额
    /// @return bonus 清算奖励
    function calculateLiquidationBonus(uint256 amount) external view override returns (uint256 bonus) {
        return (amount * _liquidationBonusRate) / 10000;
    }

    /// @notice 获取用户可清算的抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return seizableAmount 可清算数量
    function getSeizableCollateralAmount(address user, address asset) external pure override returns (uint256 seizableAmount) {
        user; asset;
        // Mock实现：返回固定值
        return 1000000000000000000; // 1 token
    }

    /// @notice 获取用户可清算的债务数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return reducibleAmount 可清算数量
    function getReducibleDebtAmount(address user, address asset) external pure override returns (uint256 reducibleAmount) {
        user; asset;
        // Mock实现：返回固定值
        return 800000000000000000; // 0.8 token
    }

    /// @notice 没收用户保证金（清算时）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param feeReceiver 费用接收者
    /// @return forfeitedAmount 没收数量
    function forfeitGuarantee(
        address user,
        address asset,
        address feeReceiver
    ) external pure override returns (uint256 forfeitedAmount) {
        require(user != address(0), "Invalid user address");
        require(asset != address(0), "Invalid asset address");
        require(feeReceiver != address(0), "Invalid fee receiver");
        
        // Mock实现：返回固定没收金额
        forfeitedAmount = 100000000000000000; // 0.1 token
        
        return forfeitedAmount;
    }

    /// @notice 转移清算抵押物
    /// @param asset 资产地址
    /// @param amount 数量
    /// @param liquidator 清算人地址
    function transferLiquidationCollateral(
        address asset,
        uint256 amount,
        address liquidator
    ) external override {
        require(asset != address(0), "Invalid asset address");
        require(amount > 0, "Invalid amount");
        require(liquidator != address(0), "Invalid liquidator address");
        
        // Mock实现：发出转移事件
        emit MockLiquidationExecuted(
            address(this),
            address(0), // user
            asset,
            address(0), // debtAsset
            amount,
            0, // debtAmount
            0, // bonus
            block.timestamp
        );
    }

    /// @notice 批量扣押抵押物
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 数量数组
    /// @param liquidator 清算人地址
    /// @return seizedAmounts 实际扣押数量数组
    function batchSeizeCollateral(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) external pure override returns (uint256[] memory seizedAmounts) {
        require(user != address(0), "Invalid user address");
        require(liquidator != address(0), "Invalid liquidator address");
        require(assets.length == amounts.length, "Length mismatch");
        
        seizedAmounts = new uint256[](assets.length);
        
        for (uint256 i = 0; i < assets.length; i++) {
            // 视图环境下，返回请求值作为占位
            seizedAmounts[i] = amounts[i];
        }
        
        return seizedAmounts;
    }

    /// @notice 批量减少债务
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 数量数组
    /// @param liquidator 清算人地址
    /// @return reducedAmounts 实际减少数量数组
    function batchReduceDebt(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) external override returns (uint256[] memory reducedAmounts) {
        require(user != address(0), "Invalid user address");
        require(liquidator != address(0), "Invalid liquidator address");
        require(assets.length == amounts.length, "Length mismatch");
        
        reducedAmounts = new uint256[](assets.length);
        
        for (uint256 i = 0; i < assets.length; i++) {
            reducedAmounts[i] = this.reduceDebt(user, assets[i], amounts[i], liquidator);
        }
        
        return reducedAmounts;
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

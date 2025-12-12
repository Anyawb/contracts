// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILiquidationView } from "../interfaces/ILiquidationView.sol";

/// @title MockLiquidationView
/// @notice 清算查询的Mock实现，用于测试
contract MockLiquidationView is ILiquidationView {
    // 用户清算状态映射
    mapping(address => bool) private _userLiquidatableStatus;
    mapping(address => uint256) private _userRiskScores;
    mapping(address => uint256) private _userHealthFactors;
    mapping(address => mapping(address => uint256)) private _userSeizableAmounts;
    mapping(address => mapping(address => uint256)) private _userReducibleDebtAmounts;
    
    // 事件
    event MockLiquidationViewUpdated(
        address indexed user,
        bool liquidatable,
        uint256 riskScore,
        uint256 healthFactor,
        uint256 timestamp
    );

    /// @notice 检查用户是否可被清算
    /// @param user 用户地址
    /// @return liquidatable 是否可被清算
    function isLiquidatable(address user) external view override returns (bool liquidatable) {
        return _userLiquidatableStatus[user];
    }

    /// @notice 获取用户清算风险评分
    /// @param user 用户地址
    /// @return riskScore 风险评分
    function getLiquidationRiskScore(address user) external view override returns (uint256 riskScore) {
        return _userRiskScores[user];
    }

    /// @notice 获取用户健康因子
    /// @param user 用户地址
    /// @return healthFactor 健康因子
    function getUserHealthFactor(address user) external view override returns (uint256 healthFactor) {
        return _userHealthFactors[user];
    }

    /// @notice 批量检查用户是否可被清算
    /// @param users 用户地址数组
    /// @return liquidatable 是否可被清算数组
    function batchIsLiquidatable(address[] calldata users) external view override returns (bool[] memory liquidatable) {
        liquidatable = new bool[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            liquidatable[i] = _userLiquidatableStatus[users[i]];
        }
        return liquidatable;
    }

    /// @notice 批量获取用户清算风险评分
    /// @param users 用户地址数组
    /// @return riskScores 风险评分数组
    function batchGetLiquidationRiskScores(address[] calldata users) external view override returns (uint256[] memory riskScores) {
        riskScores = new uint256[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            riskScores[i] = _userRiskScores[users[i]];
        }
        return riskScores;
    }

    /// @notice 批量获取用户健康因子
    /// @param users 用户地址数组
    /// @return healthFactors 健康因子数组
    function batchGetUserHealthFactors(address[] calldata users) external view override returns (uint256[] memory healthFactors) {
        healthFactors = new uint256[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            healthFactors[i] = _userHealthFactors[users[i]];
        }
        return healthFactors;
    }

    /// @notice 获取用户可清算的抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return seizableAmount 可清算数量
    function getSeizableCollateralAmount(address user, address asset) external view override returns (uint256 seizableAmount) {
        return _userSeizableAmounts[user][asset];
    }

    /// @notice 获取用户可清算的债务数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return reducibleAmount 可清算数量
    function getReducibleDebtAmount(address user, address asset) external view override returns (uint256 reducibleAmount) {
        return _userReducibleDebtAmounts[user][asset];
    }

    /// @notice 获取用户所有可清算的抵押物
    /// @return assets 资产地址数组
    /// @return amounts 数量数组
    function getSeizableCollaterals(address) external pure override returns (address[] memory assets, uint256[] memory amounts) {
        // Mock实现：返回空数组
        return (new address[](0), new uint256[](0));
    }

    /// @notice 计算抵押物价值
    /// @param amount 数量
    /// @return value 价值
    function calculateCollateralValue(address, uint256 amount) external pure override returns (uint256 value) {
        // Mock实现：1:1比例
        return amount;
    }

    /// @notice 获取用户总抵押物价值
    /// @return totalValue 总价值
    function getUserTotalCollateralValue(address) external pure override returns (uint256 totalValue) {
        // Mock实现：返回固定值
        return 1000000000000000000; // 1 token
    }

    /// @notice 获取用户所有可清算的债务
    /// @return assets 资产地址数组
    /// @return amounts 数量数组
    function getReducibleDebts(address) external pure override returns (address[] memory assets, uint256[] memory amounts) {
        // Mock实现：返回空数组
        return (new address[](0), new uint256[](0));
    }

    /// @notice 计算债务价值
    /// @param amount 数量
    /// @return value 价值
    function calculateDebtValue(address, uint256 amount) external pure override returns (uint256 value) {
        // Mock实现：1:1比例
        return amount;
    }

    /// @notice 获取用户总债务价值
    /// @return totalValue 总价值
    function getUserTotalDebtValue(address) external pure override returns (uint256 totalValue) {
        // Mock实现：返回固定值
        return 800000000000000000; // 0.8 token
    }

    /// @notice 预览清算效果
    /// @param debtAmount 清算债务数量
    /// @return bonus 清算奖励
    /// @return newHealthFactor 清算后健康因子
    /// @return newRiskScore 清算后风险评分
    /// @return slippageImpact Flash Loan滑点影响
    function previewLiquidation(
        address,
        address,
        address,
        uint256,
        uint256 debtAmount,
        bool
    ) external pure override returns (
        uint256 bonus,
        uint256 newHealthFactor,
        uint256 newRiskScore,
        uint256 slippageImpact
    ) {
        // Mock实现：返回固定值
        bonus = (debtAmount * 500) / 10000; // 5% 奖励
        newHealthFactor = 12000; // 120% 健康因子
        newRiskScore = 50; // 50% 风险评分
        slippageImpact = 0; // 无滑点影响
        return (bonus, newHealthFactor, newRiskScore, slippageImpact);
    }

    /// @notice 批量预览清算效果
    /// @param users 用户地址数组
    /// @param collateralAssets 抵押资产地址数组
    /// @param debtAssets 债务资产地址数组
    /// @param collateralAmounts 清算抵押物数量数组
    /// @param debtAmounts 清算债务数量数组
    /// @param simulateFlashLoan 是否模拟Flash Loan影响数组
    /// @return bonuses 清算奖励数组
    /// @return newHealthFactors 清算后健康因子数组
    /// @return newRiskScores 清算后风险评分数组
    /// @return slippageImpacts Flash Loan滑点影响数组
    function batchPreviewLiquidation(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        bool[] calldata simulateFlashLoan
    ) external pure override returns (
        uint256[] memory bonuses,
        uint256[] memory newHealthFactors,
        uint256[] memory newRiskScores,
        uint256[] memory slippageImpacts
    ) {
        require(
            users.length == collateralAssets.length &&
            users.length == debtAssets.length &&
            users.length == collateralAmounts.length &&
            users.length == debtAmounts.length &&
            users.length == simulateFlashLoan.length,
            "Length mismatch"
        );
        
        bonuses = new uint256[](users.length);
        newHealthFactors = new uint256[](users.length);
        newRiskScores = new uint256[](users.length);
        slippageImpacts = new uint256[](users.length);
        
        for (uint256 i = 0; i < users.length; i++) {
            bonuses[i] = (debtAmounts[i] * 500) / 10000; // 5% 奖励
            newHealthFactors[i] = 12000; // 120% 健康因子
            newRiskScores[i] = 50; // 50% 风险评分
            slippageImpacts[i] = 0; // 无滑点影响
        }
        
        return (bonuses, newHealthFactors, newRiskScores, slippageImpacts);
    }

    /// @notice 获取用户完整的风险评估
    /// @param user 用户地址
    /// @return liquidatable 是否可被清算
    /// @return riskScore 风险评分
    /// @return healthFactor 健康因子
    /// @return riskLevel 风险等级
    /// @return safetyMargin 安全边际
    function getUserRiskAssessment(address user) external view override returns (
        bool liquidatable,
        uint256 riskScore,
        uint256 healthFactor,
        uint256 riskLevel,
        uint256 safetyMargin
    ) {
        liquidatable = _userLiquidatableStatus[user];
        riskScore = _userRiskScores[user];
        healthFactor = _userHealthFactors[user];
        riskLevel = riskScore > 75 ? 3 : (riskScore > 50 ? 2 : 1); // 风险等级：1=低，2=中，3=高
        safetyMargin = healthFactor > 15000 ? 5000 : (healthFactor > 12000 ? 2000 : 0); // 安全边际
        return (liquidatable, riskScore, healthFactor, riskLevel, safetyMargin);
    }

    /// @notice 批量获取用户风险评估
    /// @param users 用户地址数组
    /// @return liquidatable 是否可被清算数组
    /// @return riskScores 风险评分数组
    /// @return healthFactors 健康因子数组
    /// @return riskLevels 风险等级数组
    /// @return safetyMargins 安全边际数组
    function batchGetUserRiskAssessments(address[] calldata users) external view override returns (
        bool[] memory liquidatable,
        uint256[] memory riskScores,
        uint256[] memory healthFactors,
        uint256[] memory riskLevels,
        uint256[] memory safetyMargins
    ) {
        liquidatable = new bool[](users.length);
        riskScores = new uint256[](users.length);
        healthFactors = new uint256[](users.length);
        riskLevels = new uint256[](users.length);
        safetyMargins = new uint256[](users.length);
        
        for (uint256 i = 0; i < users.length; i++) {
            liquidatable[i] = _userLiquidatableStatus[users[i]];
            riskScores[i] = _userRiskScores[users[i]];
            healthFactors[i] = _userHealthFactors[users[i]];
            riskLevels[i] = riskScores[i] > 75 ? 3 : (riskScores[i] > 50 ? 2 : 1);
            safetyMargins[i] = healthFactors[i] > 15000 ? 5000 : (healthFactors[i] > 12000 ? 2000 : 0);
        }
        
        return (liquidatable, riskScores, healthFactors, riskLevels, safetyMargins);
    }

    /// @notice 获取清算奖励比例
    /// @return bonusRate 清算奖励比例（basis points）
    function getLiquidationBonusRate() external pure override returns (uint256 bonusRate) {
        return 500; // 5%
    }

    /// @notice 获取清算阈值
    /// @return threshold 清算阈值（basis points）
    function getLiquidationThreshold() external pure override returns (uint256 threshold) {
        return 11000; // 110%
    }

    /// @notice 计算清算奖励
    /// @param amount 清算金额
    /// @return bonus 清算奖励
    function calculateLiquidationBonus(uint256 amount) external pure override returns (uint256 bonus) {
        return (amount * 500) / 10000; // 5% 奖励
    }

    /// @notice 批量获取用户可清算的抵押物数量
    /// @param users 用户地址数组
    /// @param assets 资产地址数组
    /// @return seizableAmounts 可清算数量数组
    function batchGetSeizableCollateralAmounts(address[] calldata users, address[] calldata assets) external view returns (uint256[] memory seizableAmounts) {
        require(users.length == assets.length, "Length mismatch");
        seizableAmounts = new uint256[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            seizableAmounts[i] = _userSeizableAmounts[users[i]][assets[i]];
        }
        return seizableAmounts;
    }

    /// @notice 批量获取用户可清算的债务数量
    /// @param users 用户地址数组
    /// @param assets 资产地址数组
    /// @return reducibleAmounts 可清算数量数组
    function batchGetReducibleDebtAmounts(address[] calldata users, address[] calldata assets) external view returns (uint256[] memory reducibleAmounts) {
        require(users.length == assets.length, "Length mismatch");
        reducibleAmounts = new uint256[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            reducibleAmounts[i] = _userReducibleDebtAmounts[users[i]][assets[i]];
        }
        return reducibleAmounts;
    }

    /// @notice 获取用户清算统计
    /// @return liquidationCount 清算次数
    /// @return totalLiquidatedAmount 总清算金额
    /// @return lastLiquidationTime 最后清算时间
    function getUserLiquidationStats(address) external view returns (
        uint256 liquidationCount,
        uint256 totalLiquidatedAmount,
        uint256 lastLiquidationTime
    ) {
        // Mock实现：返回固定值
        liquidationCount = 1;
        totalLiquidatedAmount = 1000000000000000000; // 1 token
        lastLiquidationTime = block.timestamp;
        return (liquidationCount, totalLiquidatedAmount, lastLiquidationTime);
    }

    /// @notice 获取清算市场概览
    /// @return totalLiquidatableUsers 总可清算用户数
    /// @return totalLiquidatableValue 总可清算价值
    /// @return averageRiskScore 平均风险评分
    function getLiquidationMarketOverview() external pure returns (
        uint256 totalLiquidatableUsers,
        uint256 totalLiquidatableValue,
        uint256 averageRiskScore
    ) {
        // Mock实现：返回固定值
        totalLiquidatableUsers = 10;
        totalLiquidatableValue = 10000000000000000000; // 10 tokens
        averageRiskScore = 75; // 75% 风险
        return (totalLiquidatableUsers, totalLiquidatableValue, averageRiskScore);
    }

    /// @notice 获取清算趋势
    /// @return dailyLiquidations 日清算次数
    /// @return weeklyLiquidations 周清算次数
    /// @return monthlyLiquidations 月清算次数
    function getLiquidationTrends() external pure returns (
        uint256 dailyLiquidations,
        uint256 weeklyLiquidations,
        uint256 monthlyLiquidations
    ) {
        // Mock实现：返回固定值
        dailyLiquidations = 5;
        weeklyLiquidations = 35;
        monthlyLiquidations = 150;
        return (dailyLiquidations, weeklyLiquidations, monthlyLiquidations);
    }

    // 测试辅助函数
    /// @notice 设置用户清算状态
    /// @param user 用户地址
    /// @param liquidatable 是否可被清算
    /// @param riskScore 风险评分
    /// @param healthFactor 健康因子
    function setUserLiquidationStatus(
        address user,
        bool liquidatable,
        uint256 riskScore,
        uint256 healthFactor
    ) external {
        _userLiquidatableStatus[user] = liquidatable;
        _userRiskScores[user] = riskScore;
        _userHealthFactors[user] = healthFactor;
        
        emit MockLiquidationViewUpdated(
            user,
            liquidatable,
            riskScore,
            healthFactor,
            block.timestamp
        );
    }

    /// @notice 设置用户可清算的抵押物数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 可清算数量
    function setUserSeizableAmount(address user, address asset, uint256 amount) external {
        _userSeizableAmounts[user][asset] = amount;
    }

    /// @notice 设置用户可清算的债务数量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 可清算数量
    function setUserReducibleDebtAmount(address user, address asset, uint256 amount) external {
        _userReducibleDebtAmounts[user][asset] = amount;
    }

    /// @notice 批量设置用户清算状态
    /// @param users 用户地址数组
    /// @param liquidatable 是否可被清算数组
    /// @param riskScores 风险评分数组
    /// @param healthFactors 健康因子数组
    function batchSetUserLiquidationStatus(
        address[] calldata users,
        bool[] calldata liquidatable,
        uint256[] calldata riskScores,
        uint256[] calldata healthFactors
    ) external {
        require(
            users.length == liquidatable.length &&
            users.length == riskScores.length &&
            users.length == healthFactors.length,
            "Length mismatch"
        );
        
        for (uint256 i = 0; i < users.length; i++) {
            _userLiquidatableStatus[users[i]] = liquidatable[i];
            _userRiskScores[users[i]] = riskScores[i];
            _userHealthFactors[users[i]] = healthFactors[i];
            
            emit MockLiquidationViewUpdated(
                users[i],
                liquidatable[i],
                riskScores[i],
                healthFactors[i],
                block.timestamp
            );
        }
    }

    /// @notice 重置用户清算状态
    /// @param user 用户地址
    function resetUserLiquidationStatus(address user) external {
        _userLiquidatableStatus[user] = false;
        _userRiskScores[user] = 0;
        _userHealthFactors[user] = 20000; // 200% 健康因子
        _userSeizableAmounts[user][address(0)] = 0;
        _userReducibleDebtAmounts[user][address(0)] = 0;
    }

    /// @notice 获取用户清算状态
    /// @param user 用户地址
    /// @return liquidatable 是否可被清算
    /// @return riskScore 风险评分
    /// @return healthFactor 健康因子
    function getUserLiquidationStatus(address user) external view returns (
        bool liquidatable,
        uint256 riskScore,
        uint256 healthFactor
    ) {
        return (
            _userLiquidatableStatus[user],
            _userRiskScores[user],
            _userHealthFactors[user]
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILendingEngineBasic } from "../interfaces/ILendingEngineBasic.sol";

/// @title BadLendingEngine
/// @dev recordBorrow 总是 revert("LE fail")，供负面测试使用。
contract BadLendingEngine is ILendingEngineBasic {
    function borrow(address user, address asset, uint256 amount, uint256 collateralAdded, uint16 termDays) external pure {
        user; asset; amount; collateralAdded; termDays; // silence unused parameters
        revert("LE fail");
    }

    function repay(address user, address asset, uint256 amount) external pure {
        user; asset; amount; // silence unused parameters
    }

    function forceReduceDebt(address user, address asset, uint256 amount) external pure {
        user; asset; amount; // silence unused parameters
    }

    function getDebt(address user, address asset) external pure returns (uint256 debt) {
        user; asset; // silence unused parameters
        return 0;
    }

    function getTotalDebtByAsset(address asset) external pure returns (uint256 totalDebt) {
        asset; // silence unused parameter
        return 0;
    }

    function getUserTotalDebtValue(address user) external pure returns (uint256 totalValue) {
        user; // silence unused parameter
        return 0;
    }

    function getTotalDebtValue() external pure returns (uint256 totalValue) {
        return 0;
    }

    function getUserDebtAssets(address user) external pure returns (address[] memory assets) {
        user; // silence unused parameter
        return new address[](0);
    }

    function calculateExpectedInterest(address user, address asset, uint256 amount) external pure returns (uint256 interest) {
        user; asset; amount; // silence unused parameters
        return 0;
    }

    // ===== Add stubs to satisfy interface =====
    function getReducibleDebtAmount(address user, address asset) external pure returns (uint256 reducibleAmount) {
        user; asset; return 0;
    }

    function calculateDebtValue(address user, address asset) external pure returns (uint256 value) {
        user; asset; return 0;
    }

    function calculateOptimalLiquidation(
        address user,
        uint256 maxDebtReduction,
        uint256 maxCollateralReduction
    ) external pure returns (
        uint256 debtReduction,
        uint256 collateralReduction,
        uint256 healthFactor
    ) {
        user; maxDebtReduction; maxCollateralReduction; return (0, 0, 0);
    }

    function previewLiquidationState(
        address user,
        uint256 debtReduction,
        uint256 collateralReduction
    ) external pure returns (
        uint256 newHealthFactor,
        uint256 newRiskScore,
        uint256 newRiskLevel
    ) {
        user; debtReduction; collateralReduction; return (0, 0, 0);
    }

    function getUserHealthFactor(address user) external pure returns (uint256 healthFactor) {
        user; return 0;
    }

    function getUserRiskScore(address user) external pure returns (uint256 riskScore) {
        user; return 0;
    }

    function getHighRiskUsers(uint256 riskThreshold, uint256 limit) external pure returns (address[] memory users, uint256[] memory riskScores) {
        riskThreshold; limit; return (new address[](0), new uint256[](0));
    }

    function getLiquidatableUsers(uint256 healthFactorThreshold, uint256 limit) external pure returns (address[] memory users, uint256[] memory healthFactors) {
        healthFactorThreshold; limit; return (new address[](0), new uint256[](0));
    }

    function calculateOptimalLiquidationPath(address user, uint256 targetHealthFactor) external pure returns (address[] memory liquidationSteps, uint256 totalDebtReduction, uint256 totalCollateralReduction) {
        user; targetHealthFactor; return (new address[](0), 0, 0);
    }

    function optimizeLiquidationStrategy(address user, uint256 targetHealthFactor) external pure returns (bytes memory strategy) {
        user; targetHealthFactor; return "";
    }
} 
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./LiquidationConfigManager.sol";

import "../libraries/LiquidationViewLibrary.sol";
import { LiquidationBase } from "../types/LiquidationBase.sol";
// NOTE: Calculator is intentionally kept as a slim read-only module base.
// It does not implement a governance/module-management interface (those live in LiquidationConfigManager).
import { VaultMath } from "../../VaultMath.sol";

/// @title LiquidationCalculator
/// @notice Base class for liquidation calculator: provides read-only calculation and preview functionality for liquidation
/// @dev Abstract base class: provides liquidation bonus calculation, health factor calculation, asset value calculation, liquidation result preview, and other read-only calculation capabilities
/// @dev Module positioning: serves as an abstract base class for other liquidation modules to inherit, providing unified calculation and preview functionality (read-only, does not participate in writes)
/// @dev If registration in Registry is needed, use KEY_LIQUIDATION_CALCULATOR as the module key
/// @dev Design principles:
///     - Read-only calculations: all functions are view, do not modify on-chain state, 0 gas queries
///     - Config & module cache: inherited from LiquidationConfigManager (centralizes governance + module cache management)
///     - Registry integration: inherited from LiquidationConfigManager (all module addresses resolved via Registry; no hardcoding)
/// @dev Integration with liquidation flow:
///     - Subclasses inherit calculation and preview capabilities
///     - Preview functionality: provides liquidation result preview for frontend/bots to evaluate liquidation impact
/// @dev Architecture requirements:
///     - Calculator stays read-only & minimal; governance/module-cache live in ConfigManager; write paths never go through this module.
/// @dev Naming conventions (following Architecture-Guide.md §852-879):
///     - Private state variables: _ + camelCase (e.g., _registryAddr, _baseStorage, _moduleCache)
///     - Public variables: camelCase + Var (e.g., registryAddrVar, liquidationBonusRateVar)
///     - Constants: UPPER_SNAKE_CASE (e.g., CACHE_MAX_AGE)
///     - Error names: PascalCase with __ prefix (module-specific errors should live in the module that throws them)
abstract contract LiquidationCalculator is LiquidationConfigManager
{
    using LiquidationBase for *;
    using VaultMath for uint256;

    /* ============ Core Calculation Functions ============ */
    
    /**
     * @notice Calculate liquidation bonus
     * @param seizedAmount Amount of seized collateral
     * @param reducedAmount Amount of reduced debt
     * @return bonus Liquidation bonus amount
     */
    function calculateLiquidationBonus(
        uint256 seizedAmount,
        uint256 reducedAmount
    ) external view returns (uint256 bonus) {
        // Calculate liquidation bonus using LiquidationViewLibrary
        return LiquidationViewLibrary.calculateLiquidationBonus(
            seizedAmount,
            reducedAmount,
            liquidationBonusRateVar
        );
    }

    /**
     * @notice Calculate liquidation threshold
     * @param collateralValue Collateral value
     * @param debtValue Debt value
     * @return threshold Liquidation threshold (collateral value × liquidation threshold ratio / debt value)
     */
    function calculateLiquidationThreshold(
        uint256 collateralValue,
        uint256 debtValue
    ) external view returns (uint256 threshold) {
        if (debtValue == 0) {
            return 0;
        }
        
        // Liquidation threshold = (collateral value * liquidation threshold ratio) / debt value
        threshold = (collateralValue * liquidationThresholdVar) / debtValue;
    }

    /**
     * @notice Calculate health factor
     * @param collateralValue Collateral value
     * @param debtValue Debt value
     * @return healthFactor Health factor
     */
    function calculateHealthFactor(
        uint256 collateralValue,
        uint256 debtValue
    ) external view returns (uint256 healthFactor) {
        return LiquidationViewLibrary.calculateHealthFactor(
            collateralValue,
            debtValue,
            liquidationThresholdVar * 1e16 // Convert to standard precision
        );
    }

    /**
     * @notice Calculate risk score
     * @param healthFactor Health factor
     * @param collateralDiversity Collateral diversity
     * @return riskScore Risk score
     */
    function calculateRiskScore(
        uint256 healthFactor,
        uint256 collateralDiversity
    ) external pure returns (uint256 riskScore) {
        return LiquidationViewLibrary.calculateRiskScore(healthFactor, collateralDiversity);
    }

    /* ============ Preview Functions ============ */
    
    /**
     * @notice Preview liquidation result
     * @param user User address
     * @param collateralAsset Collateral asset address
     * @param debtAsset Debt asset address
     * @param collateralAmount Amount of collateral to liquidate
     * @param debtAmount Amount of debt to liquidate
     * @return bonus Liquidation bonus
     * @return newHealthFactor New health factor after liquidation
     * @return newRiskScore New risk score after liquidation
     */
    function previewLiquidationResult(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external view returns (
        uint256 bonus,
        uint256 newHealthFactor,
        uint256 newRiskScore
    ) {
        // Preview liquidation result using LiquidationViewLibrary
        (bonus, newHealthFactor, newRiskScore, ) = LiquidationViewLibrary.previewLiquidation(
            user,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            false, // Do not simulate Flash Loan
            _baseStorage,
            _moduleCache
        );
    }

    /**
     * @notice Preview Flash Loan impact on liquidation
     * @dev Reverts if:
     *      - user is zero address
     *
     * @param user User address
     * @param collateralAsset Collateral asset address
     * @param debtAsset Debt asset address
     * @param collateralAmount Amount of collateral to liquidate
     * @param debtAmount Amount of debt to liquidate
     * @return impact Flash Loan impact (value change)
     */
    function previewFlashLoanImpact(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external view returns (uint256 impact) {
        // Validate user address
        LiquidationBase.validateAddress(user, "User");
        
        return LiquidationViewLibrary._calculateFlashLoanImpact(
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            _baseStorage
        );
    }
    /**
     * @notice Batch calculate user risk scores
     * @param users Array of user addresses
     * @return riskScores Array of risk scores
     */
    function batchCalculateUserRiskScores(
        address[] calldata users
    ) external view returns (uint256[] memory riskScores) {
        return LiquidationViewLibrary.batchGetLiquidationRiskScores(users, _moduleCache);
    }
} 
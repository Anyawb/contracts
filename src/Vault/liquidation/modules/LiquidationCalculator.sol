// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LiquidationConfigManager} from "./LiquidationConfigManager.sol";

import {ILendingEngineBasic} from "../../../interfaces/ILendingEngineBasic.sol";
import {IPositionViewValuation} from "../../../interfaces/IPositionViewValuation.sol";
import {LiquidationRiskLib} from "../libraries/LiquidationRiskLib.sol";
import {LiquidationRiskQueryLib} from "../libraries/LiquidationRiskQueryLib.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ZeroAddress} from "../../../errors/StandardErrors.sol";
import {Registry} from "../../../registry/Registry.sol";

/// @title LiquidationCalculator
/// @notice Base class for liquidation calculator.
/// @dev Provides read-only calculations and best-effort previews for liquidation.
/// @dev Module positioning: abstract base class for other liquidation modules to inherit; read-only only.
/// @dev If registration in Registry is needed, use KEY_LIQUIDATION_CALCULATOR as the module key
/// @dev Design principles:
///     - Read-only calculations: all functions are view, do not modify on-chain state, 0 gas queries
///     - Config & module cache: inherited from LiquidationConfigManager
///     - Registry integration: inherited from LiquidationConfigManager (no hardcoding)
/// @dev Integration with liquidation flow:
///     - Subclasses inherit calculation and preview capabilities
///     - Preview functionality: provides liquidation result preview for frontend/bots to evaluate liquidation impact
/// @dev Architecture requirements:
///     - Calculator stays read-only & minimal
///     - Governance/module-cache live in ConfigManager; write paths never go through this module
/// @dev Naming conventions (following Architecture-Guide.md §852-879):
///     - Private state variables: _ + camelCase (e.g., _registryAddr, _moduleCache)
///     - Public variables: camelCase + Var (e.g., registryAddrVar, liquidationBonusRateVar)
///     - Constants: UPPER_SNAKE_CASE (e.g., CACHE_MAX_AGE)
///     - Error names: PascalCase with __ prefix (module-specific errors should live in the module that throws them)
abstract contract LiquidationCalculator is LiquidationConfigManager
{
    // NOTE:
    // - Calculator is intentionally kept as a slim read-only module base.
    // - It does not implement governance/module-management entrypoints (those live in LiquidationConfigManager).

    /* ============ Core Calculation Functions ============ */
    
    /**
     * @notice Calculate liquidation bonus amount for a seizure.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only function (no state changes)
     * - Uses `liquidationBonusRateVar` (bps) from ConfigManager (SSOT)
     *
     * @param seizedAmount Amount of seized collateral (token decimals)
     * @param reducedAmount Amount of reduced debt (token decimals, unused; kept for interface compatibility)
     * @return bonus Liquidation bonus amount (token decimals)
     */
    function calculateLiquidationBonus(
        uint256 seizedAmount,
        uint256 reducedAmount
    ) external view returns (uint256 bonus) {
        reducedAmount; // unused (bonus is based on seized collateral amount)
        // bps: 10_000 = 100%
        return (seizedAmount * liquidationBonusRateVar) / 10_000;
    }

    /**
     * @notice Calculate the minimum required collateral value to stay above liquidation threshold.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - View-only function (no state changes)
     * - Uses `liquidationThresholdVar` (bps) from ConfigManager (SSOT)
     *
     * @param collateralValue Current collateral value (settlement token denominated, 1e18-scaled)
     * @param debtValue Current debt value (settlement token denominated, 1e18-scaled)
     * @return threshold Required collateral value (settlement token denominated, 1e18-scaled)
     */
    function calculateLiquidationThreshold(
        uint256 collateralValue,
        uint256 debtValue
    ) external view returns (uint256 threshold) {
        collateralValue; // not required for threshold computation (kept for interface compatibility)
        // requiredCollateralValue = debtValue * thresholdBps / 10_000
        return (debtValue * liquidationThresholdVar) / 10_000;
    }

    /**
     * @notice Calculate health factor (bps) from collateral and debt values.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function (no state changes)
     *
     * @param collateralValue Total collateral value (settlement token denominated, 1e18-scaled)
     * @param debtValue Total debt value (settlement token denominated, 1e18-scaled)
     * @return healthFactor Health factor in bps (10_000 = 100%, type(uint256).max if debtValue == 0)
     */
    function calculateHealthFactor(
        uint256 collateralValue,
        uint256 debtValue
    ) external pure returns (uint256 healthFactor) {
        return LiquidationRiskLib.calculateHealthFactor(collateralValue, debtValue);
    }

    /**
     * @notice Calculate liquidation risk score from health factor.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function (no state access, no external calls)
     *
     * @param healthFactor Health factor in bps (10_000 = 100%, type(uint256).max if debt == 0)
     * @param collateralDiversity Collateral diversity (unused; kept for interface compatibility)
     * @return riskScore Risk score (0-100, where 100 = highest risk)
     */
    function calculateRiskScore(
        uint256 healthFactor,
        uint256 collateralDiversity
    ) external pure returns (uint256 riskScore) {
        collateralDiversity; // unused (risk is derived from health factor only in this calculator)

        // Mapping: lower HF => higher risk score (0-100)
        if (healthFactor == type(uint256).max) return 0;
        if (healthFactor < 10_000) return 100;
        if (healthFactor < 10_500) return 80;
        if (healthFactor < 11_000) return 60;
        if (healthFactor < 12_000) return 40;
        return 20;
    }

    /* ============ Preview Functions ============ */
    
    /**
     * @notice Preview liquidation result (best-effort approximation).
     * @dev Reverts if:
     *      - user is zero address
     *      - collateralAsset is zero address
     *      - debtAsset is zero address
     *
     * Security:
     * - View-only function (no state changes)
     * - Architecture alignment: does NOT access oracle directly; uses LendingEngine/PositionView valuation interfaces
     * - Best-effort: returns (0,0,0) if required modules are not registered or calls fail
     *
     * @param user User address
     * @param collateralAsset Collateral asset address
     * @param debtAsset Debt asset address
     * @param collateralAmount Amount of collateral to liquidate (token decimals)
     * @param debtAmount Amount of debt to liquidate (token decimals)
     * @return bonus Liquidation bonus (token decimals)
     * @return newHealthFactor New health factor after liquidation (bps, 10_000 = 100%)
     * @return newRiskScore New risk score after liquidation (0-100)
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
        if (user == address(0) || collateralAsset == address(0) || debtAsset == address(0)) revert ZeroAddress();

        // 1) Bonus (amount-based; seized collateral amount is the base)
        bonus = (collateralAmount * liquidationBonusRateVar) / 10_000;

        // 2) Get current totals (settlement token denominated, 1e18-scaled)
        (uint256 totalCollateralValue, uint256 totalDebtValue) = LiquidationRiskQueryLib.getUserValues(
            user,
            _registryAddr,
            _moduleCache,
            CACHE_MAX_AGE
        );

        // If we cannot resolve totals, return default zeros (best-effort).
        if (totalCollateralValue == 0 && totalDebtValue == 0) {
            return (bonus, 0, 0);
        }

        // 3) Estimate seized collateral value via PositionView valuation.
        uint256 seizedCollateralValue = 0;
        address positionView = Registry(_registryAddr).getModule(ModuleKeys.KEY_POSITION_VIEW);
        if (positionView != address(0)) {
            try
                IPositionViewValuation(positionView).getAssetValue(collateralAsset, collateralAmount)
            returns (uint256 v) {
                seizedCollateralValue = v;
            } catch {
                seizedCollateralValue = 0;
            }
        }

        // 4) Estimate reduced debt value via per-asset unit price derived from LendingEngine.
        uint256 reducedDebtValue = 0;
        address lendingEngine = Registry(_registryAddr).getModule(ModuleKeys.KEY_LE);
        if (lendingEngine != address(0)) {
            uint256 currentDebtAmount = 0;
            uint256 currentDebtValue = 0;
            try ILendingEngineBasic(lendingEngine).getDebt(user, debtAsset) returns (uint256 amt) {
                currentDebtAmount = amt;
            } catch {
                currentDebtAmount = 0;
            }
            try ILendingEngineBasic(lendingEngine).calculateDebtValue(user, debtAsset) returns (uint256 v) {
                currentDebtValue = v;
            } catch {
                currentDebtValue = 0;
            }
            if (currentDebtAmount != 0 && currentDebtValue != 0) {
                // unitPrice = value / amount (settlement token denominated per debt token unit)
                uint256 unitPrice = currentDebtValue / currentDebtAmount;
                reducedDebtValue = unitPrice * debtAmount;
                if (reducedDebtValue > currentDebtValue) reducedDebtValue = currentDebtValue;
            }
        }

        // 5) Compute new totals (clamped).
        uint256 newCollateralValue =
            totalCollateralValue > seizedCollateralValue ? totalCollateralValue - seizedCollateralValue : 0;
        uint256 newDebtValue = totalDebtValue > reducedDebtValue ? totalDebtValue - reducedDebtValue : 0;

        newHealthFactor = LiquidationRiskLib.calculateHealthFactor(newCollateralValue, newDebtValue);
        newRiskScore = LiquidationRiskLib.calculateLiquidationRiskScore(newCollateralValue, newDebtValue);
    }

    /**
     * @notice Preview Flash Loan impact on liquidation
     * @dev Reverts if:
     *      - user is zero address
     *      - collateralAsset is zero address
     *      - debtAsset is zero address
     *
     * Security:
     * - Pure function (no state changes)
     * - Architecture alignment: does NOT access oracle; uses amount-based approximation only
     *
     * @param user User address
     * @param collateralAsset Collateral asset address
     * @param debtAsset Debt asset address
     * @param collateralAmount Amount of collateral to liquidate
     * @param debtAmount Amount of debt to liquidate
     * @return impact Flash Loan impact (token decimals, approximation)
     */
    function previewFlashLoanImpact(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external pure returns (uint256 impact) {
        if (user == address(0) || collateralAsset == address(0) || debtAsset == address(0)) revert ZeroAddress();

        // NOTE: amount-based approximation (50 bps baseline if total > 0).
        uint256 totalAmount = collateralAmount + debtAmount;
        if (totalAmount == 0) return 0;
        uint256 marketImpactBps = 50;
        return (totalAmount * marketImpactBps) / 10_000;
    }
    /**
     * @notice Batch calculate user risk scores
     * @param users Array of user addresses
     * @return riskScores Array of risk scores
     */
    function batchCalculateUserRiskScores(
        address[] calldata users
    ) external view returns (uint256[] memory riskScores) {
        uint256 length = users.length;
        riskScores = new uint256[](length);

        for (uint256 i = 0; i < length;) {
            address u = users[i];
            if (u != address(0)) {
                (uint256 collateralValue, uint256 debtValue) = LiquidationRiskQueryLib.getUserValues(
                    u,
                    _registryAddr,
                    _moduleCache,
                    CACHE_MAX_AGE
                );
                riskScores[i] = LiquidationRiskLib.calculateLiquidationRiskScore(collateralValue, debtValue);
            }
            unchecked { ++i; }
        }
    }
} 
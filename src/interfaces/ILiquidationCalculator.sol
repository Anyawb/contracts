// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationCalculator
 * @notice Liquidation calculator interface - read-only calculations and previews (does not include governance/module management/oracle degradation strategies)
 */
interface ILiquidationCalculator {
    /* ============ Pure / View Calculations ============ */

    /**
     * @notice Calculate liquidation bonus
     * @param seizedAmount Amount of seized collateral
     * @param reducedAmount Amount of reduced debt
     * @return bonus Liquidation bonus amount
     */
    function calculateLiquidationBonus(uint256 seizedAmount, uint256 reducedAmount) external view returns (uint256 bonus);

    /**
     * @notice Calculate liquidation threshold
     * @param collateralValue Collateral value
     * @param debtValue Debt value
     * @return threshold Liquidation threshold
     */
    function calculateLiquidationThreshold(uint256 collateralValue, uint256 debtValue) external view returns (uint256 threshold);

    /**
     * @notice Calculate health factor
     * @param collateralValue Collateral value
     * @param debtValue Debt value
     * @return healthFactor Health factor
     */
    function calculateHealthFactor(uint256 collateralValue, uint256 debtValue) external view returns (uint256 healthFactor);

    /**
     * @notice Calculate risk score
     * @param healthFactor Health factor
     * @param collateralDiversity Collateral diversity
     * @return riskScore Risk score
     */
    function calculateRiskScore(uint256 healthFactor, uint256 collateralDiversity) external pure returns (uint256 riskScore);

    /* ============ Previews ============ */

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
    ) external view returns (uint256 bonus, uint256 newHealthFactor, uint256 newRiskScore);

    /**
     * @notice Preview Flash Loan impact on liquidation
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
    ) external view returns (uint256 impact);

    /**
     * @notice Batch calculate user risk scores
     * @param users Array of user addresses
     * @return riskScores Array of risk scores
     */
    function batchCalculateUserRiskScores(address[] calldata users) external view returns (uint256[] memory riskScores);
} 
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationRiskManager
 * @notice Liquidation risk assessment manager interface, responsible for liquidation risk assessment and threshold management
 * @dev Liquidation risk assessment functionality split from VaultLendingEngine
 */
interface ILiquidationRiskManager {
    /* ============ Events ============ */
    /**
     * @notice Liquidation threshold updated event
     * @param oldThreshold Old liquidation threshold
     * @param newThreshold New liquidation threshold
     * @param timestamp Update timestamp (in seconds)
     */
    event LiquidationThresholdUpdated(
        uint256 oldThreshold,
        uint256 newThreshold,
        uint256 timestamp
    );

    /* ============ Risk Assessment Functions ============ */
    /**
     * @notice Check if user is liquidatable
     * @param user User address
     * @return liquidatable Whether the user is liquidatable
     */
    function isLiquidatable(address user) external view returns (bool liquidatable);

    /**
     * @notice Check if specified collateral and debt levels are liquidatable
     * @param user User address
     * @param collateral Collateral value
     * @param debt Debt value
     * @param asset Asset address
     * @return liquidatable Whether the position is liquidatable
     */
    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address asset
    ) external view returns (bool liquidatable);

    /**
     * @notice Get user liquidation risk score
     * @param user User address
     * @return riskScore Risk score (0-100)
     */
    function getLiquidationRiskScore(address user) external view returns (uint256 riskScore);

    /**
     * @notice Calculate risk score for specified collateral and debt levels
     * @param collateral Collateral value
     * @param debt Debt value
     * @return riskScore Risk score (0-100)
     */
    function calculateLiquidationRiskScore(
        uint256 collateral,
        uint256 debt
    ) external pure returns (uint256 riskScore);

    /**
     * @notice Get user risk assessment result
     * @param user User address
     * @return liquidatable Whether the user is liquidatable
     * @return riskScore Risk score (0-100)
     * @return healthFactor Health factor (in basis points)
     * @return riskLevel Risk level (0-4)
     * @return safetyMargin Safety margin (in basis points)
     */
    function getUserRiskAssessment(address user) external view returns (
        bool liquidatable,
        uint256 riskScore,
        uint256 healthFactor,
        uint256 riskLevel,
        uint256 safetyMargin
    );

    /* ============ Threshold Management Functions ============ */
    /**
     * @notice Get liquidation threshold
     * @return threshold Liquidation threshold (in basis points)
     */
    function getLiquidationThreshold() external view returns (uint256 threshold);

    /**
     * @notice Update liquidation threshold
     * @param newThreshold New liquidation threshold (in basis points)
     */
    function updateLiquidationThreshold(uint256 newThreshold) external;

    /**
     * @notice Get minimum health factor
     * @return minHealthFactor Minimum health factor (in basis points)
     */
    function getMinHealthFactor() external view returns (uint256 minHealthFactor);

    /**
     * @notice Update minimum health factor
     * @param newMinHealthFactor New minimum health factor (in basis points)
     */
    function updateMinHealthFactor(uint256 newMinHealthFactor) external;

    /* ============ Batch Query Functions ============ */
    /**
     * @notice Batch check if users are liquidatable
     * @param users Array of user addresses
     * @return liquidatableFlags Array of liquidatable flags
     */
    function batchIsLiquidatable(
        address[] calldata users
    ) external view returns (bool[] memory liquidatableFlags);

    /**
     * @notice Batch get user risk scores
     * @param users Array of user addresses
     * @return riskScores Array of risk scores
     */
    function batchGetLiquidationRiskScores(
        address[] calldata users
    ) external view returns (uint256[] memory riskScores);

    /* ============ Preview Functions moved to View contract ============ */
} 
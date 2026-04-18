// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationRiskRead
 * @notice Narrow read-only interface for liquidation risk queries and threshold reads.
 * @dev Reverts if:
 *      - protocol implementations reject invalid user, asset, or batch inputs
 *      - protocol implementations cannot resolve required cached or registry-backed risk dependencies
 *
 * Security:
 * - Use this interface for view modules and read-path consumers.
 * - Governance/config writes stay on dedicated config interfaces instead of being mixed into every consumer
 *   dependency.
 */
interface ILiquidationRiskRead {
    /**
     * @notice Check if a user is liquidatable based on cached health factor.
     * @dev Reverts if:
     *      - `user` is invalid
     *      - the implementation cannot resolve the health-factor dependency required for the check
     *
     * Security:
     * - Read-only risk probe.
     * - Implementations may safely return `false` if the underlying cache is invalid instead of reverting.
     *
     * @param user User address.
     * @return liquidatable True if liquidatable, otherwise false.
     */
    function isLiquidatable(
        address user
    ) external view returns (bool liquidatable);

    /**
     * @notice Check if a position is liquidatable using provided collateral/debt values.
     * @dev Reverts if:
     *      - `user` or `asset` is invalid
     *      - the implementation rejects the supplied valuation inputs
     *
     * Security:
     * - Read-only pure/view-style threshold probe.
     * - `collateral` and `debt` must already be expressed in the shared 18-decimal system valuation unit,
     *   or in another same-unit pair explicitly normalized by the caller before invocation.
     *
     * @param user User address.
     * @param collateral Collateral value, normalized to the same unit as `debt`.
     * @param debt Debt value, normalized to the same unit as `collateral`.
     * @param asset Asset address.
     * @return liquidatable True if liquidatable, otherwise false.
     */
    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address asset
    ) external view returns (bool liquidatable);

    /**
     * @notice Get a user's liquidation risk score.
     * @dev Reverts if:
     *      - `user` is invalid
     *      - the implementation cannot resolve the collateral/debt data needed for scoring
     *
     * Security:
     * - Read-only aggregation helper.
     * - Score range and derivation are implementation-defined beyond the documented 0-100 convention.
     *
     * @param user User address.
     * @return riskScore Risk score in [0,100] (0 = lowest risk, 100 = highest).
     */
    function getLiquidationRiskScore(
        address user
    ) external view returns (uint256 riskScore);

    /**
     * @notice Calculate liquidation risk score for given collateral/debt values.
     * @dev Reverts if:
     *      - the implementation rejects the supplied valuation inputs
     *
     * Security:
     * - Pure/view helper that does not mutate protocol state.
     * - `collateral` and `debt` must already be expressed in the shared 18-decimal system valuation unit,
     *   or in another same-unit pair explicitly normalized by the caller before invocation.
     *
     * @param collateral Collateral value, normalized to the same unit as `debt`.
     * @param debt Debt value, normalized to the same unit as `collateral`.
     * @return riskScore Risk score in [0,100] (0 = lowest risk, 100 = highest).
     */
    function calculateLiquidationRiskScore(
        uint256 collateral,
        uint256 debt
    ) external pure returns (uint256 riskScore);

    /**
     * @notice Get a comprehensive liquidation risk assessment for a user.
     * @dev Reverts if:
     *      - `user` is invalid
     *      - the implementation cannot resolve one or more dependencies required for the assessment
     *
     * Security:
     * - Read-only aggregation helper.
     * - Returned factors are implementation-defined but expected to share the documented bps/value semantics.
     *
     * @param user User address.
     * @return liquidatable True if liquidatable, otherwise false.
     * @return riskScore Risk score in [0,100].
     * @return healthFactor Health factor in bps (10_000 = 100%, 0 if invalid).
     * @return riskLevel Risk level (0-4).
     * @return safetyMargin Safety margin in bps.
     */
    function getUserRiskAssessment(
        address user
    )
        external
        view
        returns (
            bool liquidatable,
            uint256 riskScore,
            uint256 healthFactor,
            uint256 riskLevel,
            uint256 safetyMargin
        );

    /**
     * @notice Get liquidation threshold.
     * @dev Reverts if:
     *      - the implementation cannot resolve the configured threshold value
     *
     * Security:
     * - Read-only configuration helper.
     *
     * @return threshold Liquidation threshold (bps, 10_000 = 100%).
     */
    function getLiquidationThreshold()
        external
        view
        returns (uint256 threshold);

    /**
     * @notice Get minimum health factor.
     * @dev Reverts if:
     *      - the implementation cannot resolve the configured minimum health factor
     *
     * Security:
     * - Read-only configuration helper.
     *
     * @return minHealthFactor Minimum health factor (bps, 10_000 = 100%).
     */
    function getMinHealthFactor()
        external
        view
        returns (uint256 minHealthFactor);

    /**
     * @notice Get maximum LTV.
     * @dev Reverts if:
     *      - the implementation cannot resolve the configured maximum LTV
     *
     * Security:
     * - Read-only configuration helper.
     *
     * @return maxLtvBps Maximum LTV (bps, 10_000 = 100%).
     */
    function getMaxLtvBps() external view returns (uint256 maxLtvBps);

    /**
     * @notice Batch check liquidatability for multiple users.
     * @dev Reverts if:
     *      - the batch exceeds implementation limits
     *      - the implementation cannot resolve dependencies needed for one or more entries
     *
     * Security:
     * - Read-only batch helper.
     * - Implementations may skip zero-address entries or treat them as `false`.
     * - Callers should not rely on reverts for malformed batch members.
     * - Revert behavior for malformed entries is implementation-specific unless documented otherwise.
     *
     * @param users Array of user addresses.
     * @return liquidatableFlags Array of liquidatable flags.
     */
    function batchIsLiquidatable(
        address[] calldata users
    ) external view returns (bool[] memory liquidatableFlags);

    /**
     * @notice Batch get liquidation risk scores for multiple users.
     * @dev Reverts if:
     *      - the batch exceeds implementation limits
     *      - the implementation cannot resolve dependencies needed for one or more entries
     *
     * Security:
     * - Read-only batch helper.
     * - Implementations may return a default score for skipped or malformed entries instead of reverting.
     *
     * @param users Array of user addresses.
     * @return riskScores Array of risk scores (0-100).
     */
    function batchGetLiquidationRiskScores(
        address[] calldata users
    ) external view returns (uint256[] memory riskScores);
}

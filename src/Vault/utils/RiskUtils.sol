// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RiskUtils
 * @notice Stateless risk-scoring and risk-derivation helpers (pure functions).
 * @dev Reverts if:
 *      - arithmetic overflows or underflows in pure math operations (Solidity ^0.8.x)
 *
 * Security:
 * - Pure library: no storage reads/writes, no external calls.
 * - Solidity ^0.8.x overflow/underflow checks apply (operations revert on overflow).
 *
 * @custom:security-contact security@example.com
 */
library RiskUtils {
    /*━━━━━━━━━━━━━━━ Risk Scoring Lookup Tables ━━━━━━━━━━━━━━━*/
    /**
     * @notice Get health-factor thresholds used for risk scoring.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure lookup only.
     *
     * @return arr Thresholds in bps, sorted descending: [12000, 11000, 10500, 10000, 9500].
     */
    function getRiskScoreThresholds()
        internal
        pure
        returns (uint256[] memory arr)
    {
        arr = new uint256[](5);
        arr[0] = 12000; // 120% - lowest risk threshold
        arr[1] = 11000; // 110% - low risk threshold
        arr[2] = 10500; // 105% - medium risk threshold
        arr[3] = 10000; // 100% - high risk threshold
        arr[4] = 9500; // 95%  - critical risk threshold
    }

    /**
     * @notice Get risk-score values mapped to the thresholds.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure math only.
     *
     * @return arr Scores, ascending: [0, 20, 40, 60, 80, 100].
     */
    function getRiskScoreValues() internal pure returns (uint256[] memory arr) {
        arr = new uint256[](6);
        arr[0] = 0; // 120%+    - lowest risk
        arr[1] = 20; // 110-120% - low risk
        arr[2] = 40; // 105-110% - medium risk
        arr[3] = 60; // 100-105% - high risk
        arr[4] = 80; // 95-100%  - critical risk
        arr[5] = 100; // <95%     - liquidation risk
    }

    /**
     * @notice Compute a simplified risk score from a health factor.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure logic only; relies on fixed threshold tables.
     *
     * @param healthFactorBps Health factor in bps (e.g., 12000 = 120%).
     * @return riskScore Risk score in [0..100], where 0 = lowest risk, 100 = highest risk.
     */
    function calculateSimpleRiskScore(
        uint256 healthFactorBps
    ) internal pure returns (uint256 riskScore) {
        uint256[] memory thresholds = getRiskScoreThresholds();
        uint256[] memory values = getRiskScoreValues();
        for (uint256 i = 0; i < thresholds.length; i++) {
            if (healthFactorBps >= thresholds[i]) {
                return values[i];
            }
        }
        return values[values.length - 1];
    }

    /**
     * @notice Compute the safety margin above a threshold, in bps.
     * @dev Reverts if:
     *      - subtraction underflows (Solidity ^0.8.x), though guarded by the comparison.
     *
     * Security:
     * - Pure math only.
     *
     * @param healthFactorBps Health factor in bps.
     * @param thresholdBps Threshold in bps.
     * @return safetyMarginBps max(healthFactorBps - thresholdBps, 0).
     */
    function calculateSafetyMargin(
        uint256 healthFactorBps,
        uint256 thresholdBps
    ) internal pure returns (uint256 safetyMarginBps) {
        if (healthFactorBps <= thresholdBps) return 0;
        return healthFactorBps - thresholdBps;
    }

    /**
     * @notice Compute LTV as bps (debt / collateral).
     * @dev Reverts if:
     *      - debt * 10_000 overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param debt Total debt value (any unit; must match collateral unit).
     * @param collateral Total collateral value (same unit as debt).
     * @return ltvBps Basis points where 10_000 = 100%; returns 0 if collateral == 0.
     */
    function calculateLTV(
        uint256 debt,
        uint256 collateral
    ) internal pure returns (uint256 ltvBps) {
        if (collateral == 0) return 0;
        return (debt * 10_000) / collateral;
    }

    /**
     * @notice Return whether a position is below the liquidation threshold.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure comparison only.
     *
     * @param healthFactorBps Health factor in bps.
     * @param liquidationThresholdBps Liquidation threshold in bps.
     * @return isRisky True if healthFactorBps < liquidationThresholdBps.
     */
    function isLiquidationRisky(
        uint256 healthFactorBps,
        uint256 liquidationThresholdBps
    ) internal pure returns (bool isRisky) {
        return healthFactorBps < liquidationThresholdBps;
    }

    /**
     * @notice Derive warning level from health factor and thresholds.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure comparison only.
     *
     * @param healthFactorBps Health factor in bps.
     * @param warningThresholdBps Warning threshold in bps.
     * @param liquidationThresholdBps Liquidation threshold in bps.
     * @return warningLevel 0 = NONE, 1 = WARNING, 2 = CRITICAL.
     */
    function getWarningLevel(
        uint256 healthFactorBps,
        uint256 warningThresholdBps,
        uint256 liquidationThresholdBps
    ) internal pure returns (uint8 warningLevel) {
        if (healthFactorBps >= warningThresholdBps) {
            return 0; // NONE
        } else if (healthFactorBps >= liquidationThresholdBps) {
            return 1; // WARNING
        } else {
            return 2; // CRITICAL
        }
    }

    /**
     * @notice Compute max additional borrowable amount given collateral and current debt.
     * @dev Reverts if:
     *      - collateral * maxLtvBps overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param collateral Total collateral value (any unit; must match currentDebt unit).
     * @param currentDebt Current debt value (same unit as collateral).
     * @param maxLtvBps Maximum LTV in bps (10_000 = 100%).
     * @return maxBorrowable Max additional debt allowed (same unit as collateral/currentDebt).
     */
    function calculateMaxBorrowable(
        uint256 collateral,
        uint256 currentDebt,
        uint256 maxLtvBps
    ) internal pure returns (uint256 maxBorrowable) {
        if (collateral == 0) return 0;

        uint256 maxDebt = (collateral * maxLtvBps) / 10_000;
        if (currentDebt >= maxDebt) return 0;

        return maxDebt - currentDebt;
    }
}

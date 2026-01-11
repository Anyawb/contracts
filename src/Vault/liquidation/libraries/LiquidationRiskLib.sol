// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VaultTypes} from "../../VaultTypes.sol";
import {VaultMath} from "../../VaultMath.sol";

/**
 * @title Liquidation Risk Library
 * @author RWA Lending Platform
 * @notice Provides pure calculation functions for liquidation risk assessment (health factor and risk score).
 * @dev Pure library functions for risk calculations used by LiquidationRiskManager and LiquidationRiskView.
 */
library LiquidationRiskLib {
    /**
     * @notice Calculate health factor from collateral and debt values.
     * @dev Reverts if:
     *      - None (pure function, no state changes or external calls)
     *
     * Security:
     * - Pure function (no state access or external calls)
     * - No arithmetic overflow risk (collateral and debt are bounded by system limits)
     *
     * @param collateral Total collateral value (settlement token denominated, scaled by 1e18)
     * @param debt Total debt value (settlement token denominated, scaled by 1e18)
     * @return healthFactor Health factor value (bps, scaled by 1e4, e.g., 10_000 = 100%).
     *         Returns type(uint256).max if debt is zero, returns 0 if collateral is zero.
     */
    function calculateHealthFactor(uint256 collateral, uint256 debt) internal pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        if (collateral == 0) return 0;
        return (collateral * VaultTypes.HUNDRED_PERCENT) / debt;
    }

    /**
     * @notice Calculate liquidation risk score based on loan-to-value ratio.
     * @dev Reverts if:
     *      - None (pure function, no state changes or external calls)
     *
     * Security:
     * - Pure function (no state access or external calls)
     * - Risk score is calculated from LTV ratio using fixed thresholds
     *
     * @param collateral Total collateral value (settlement token denominated, scaled by 1e18)
     * @param debt Total debt value (settlement token denominated, scaled by 1e18)
     * @return riskScore Liquidation risk score (0-100, where 100 = highest risk).
     *         Returns 0 if debt is zero, returns 100 if collateral is zero.
     *         Risk thresholds:
     *         - LTV >= 80% (8000 bps): 100
     *         - LTV >= 60% (6000 bps): 80
     *         - LTV >= 40% (4000 bps): 60
     *         - LTV >= 20% (2000 bps): 40
     *         - LTV < 20%: 20
     */
    function calculateLiquidationRiskScore(uint256 collateral, uint256 debt) internal pure returns (uint256) {
        if (debt == 0) return 0;
        if (collateral == 0) return 100;
        uint256 ltv = VaultMath.calculateLTV(debt, collateral);
        if (ltv >= 8000) return 100;
        if (ltv >= 6000) return 80;
        if (ltv >= 4000) return 60;
        if (ltv >= 2000) return 40;
        return 20;
    }
}



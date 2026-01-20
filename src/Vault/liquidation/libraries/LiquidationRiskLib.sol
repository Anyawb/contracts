// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { MathConstants } from "../../../constants/MathConstants.sol";
import { VaultMath } from "../../VaultMath.sol";

/**
 * @title Liquidation Risk Library
 * @author RWA Lending Platform
 * @notice Provides pure calculation functions for liquidation risk assessment (health factor and risk score).
 * @dev Security:
 * - Pure library: no storage reads/writes, no external calls.
 * - Solidity ^0.8.x overflow/underflow checks apply (operations revert on overflow).
 */
library LiquidationRiskLib {
    /**
     * @notice Calculate health factor from collateral and debt values.
     * @dev Reverts if:
     *      - collateral * 10_000 overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param collateral Total collateral value (settlement token denominated, 1e18 scaled).
     * @param debt Total debt value (settlement token denominated, 1e18 scaled).
     * @return healthFactorBps Health factor in bps (10_000 = 100%).
     *         Returns type(uint256).max if debt == 0; returns 0 if collateral == 0.
     */
    function calculateHealthFactor(uint256 collateral, uint256 debt) internal pure returns (uint256 healthFactorBps) {
        if (debt == 0) return type(uint256).max;
        if (collateral == 0) return 0;
        return (collateral * MathConstants.BPS) / debt;
    }

    /**
     * @notice Calculate liquidation risk score based on loan-to-value ratio.
     * @dev Reverts if:
     *      - VaultMath.calculateLTV reverts due to overflow (Solidity ^0.8.x)
     *
     * Security:
     * - Pure logic only; derives score from LTV thresholds.
     *
     * @param collateral Total collateral value (settlement token denominated, 1e18 scaled).
     * @param debt Total debt value (settlement token denominated, 1e18 scaled).
     * @return riskScore Risk score in [0..100] where 100 is the highest risk.
     *         Returns 0 if debt == 0; returns 100 if collateral == 0.
     *
     * Thresholds (by LTV bps):
     * - >= 8000: 100
     * - >= 6000: 80
     * - >= 4000: 60
     * - >= 2000: 40
     * - <  2000: 20
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



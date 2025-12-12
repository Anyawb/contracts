// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VaultTypes} from "../../VaultTypes.sol";
import {VaultMath} from "../../VaultMath.sol";

library LiquidationRiskLib {
    function calculateHealthFactor(uint256 collateral, uint256 debt) public pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        if (collateral == 0) return 0;
        return (collateral * VaultTypes.HUNDRED_PERCENT) / debt;
    }

    function calculateLiquidationRiskScore(uint256 collateral, uint256 debt) public pure returns (uint256) {
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



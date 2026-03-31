// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { MathConstants } from "../constants/MathConstants.sol";
import { DivisionByZero } from "../errors/StandardErrors.sol";

/**
 * @title VaultMath
 * @notice Stateless math helpers for the Vault domain (basis points = 1e4).
 * @dev Reverts if:
 *      - arithmetic overflows or underflows in pure math operations (Solidity ^0.8.x)
 *      - division inputs violate explicit guards such as {DivisionByZero}
 *
 * Security:
 * - Pure library: no storage reads/writes, no external calls.
 * - Solidity ^0.8.x overflow/underflow checks apply (operations revert on overflow).
 */
library VaultMath {
    /**
     * @notice Multiply a value by a basis-points rate (bps).
     * @dev Reverts if:
     *      - multiplication overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param value Base value (same unit as the return value).
     * @param bps Basis points where 10_000 = 100% (0 is allowed).
    * @return result Floor(value * bps / 10_000).
     */
    function percentageMul(uint256 value, uint256 bps)
        internal
        pure
        returns (uint256)
    {
        return (value * bps) / MathConstants.BPS;
    }

    /**
     * @notice Divide a value by a basis-points rate (bps).
     * @dev Reverts if:
     *      - bps == 0 (DivisionByZero)
     *      - multiplication overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param value Base value (same unit as the return value).
     * @param bps Basis points where 10_000 = 100% (must be non-zero).
     * @return result Floor(value * 10_000 / bps).
     */
    function percentageDiv(uint256 value, uint256 bps)
        internal
        pure
        returns (uint256)
    {
        if (bps == 0) revert DivisionByZero();
        return (value * MathConstants.BPS) / bps;
    }

    /**
     * @notice Compute health factor as bps (collateral / debt).
     * @dev Reverts if:
     *      - collateral * 10_000 overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param collateral Total collateral value (any unit; must match debt unit).
     * @param debt Total debt value (same unit as collateral).
    * @return healthFactorBps Basis points where 10_000 = 100%; returns max uint256 if debt == 0.
     */
    function calculateHealthFactor(uint256 collateral, uint256 debt)
        internal
        pure
        returns (uint256)
    {
        if (debt == 0) return type(uint256).max;
        return (collateral * MathConstants.BPS) / debt;
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
    function calculateLTV(uint256 debt, uint256 collateral)
        internal
        pure
        returns (uint256)
    {
        if (collateral == 0) return 0;
        return (debt * MathConstants.BPS) / collateral;
    }

    /**
     * @notice Compute liquidation bonus amount from a bps bonus rate.
     * @dev Reverts if:
     *      - multiplication overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param amount Base amount (same unit as the return value).
     * @param bonusBps Bonus rate in basis points (10_000 = 100%).
     * @return bonusAmount Floor(amount * bonusBps / 10_000).
     */
    function calculateLiquidationBonus(uint256 amount, uint256 bonusBps)
        internal
        pure
        returns (uint256)
    {
        return percentageMul(amount, bonusBps);
    }

    /**
     * @notice Compute fee amount from a bps fee rate.
     * @dev Reverts if:
     *      - multiplication overflows (Solidity ^0.8.x)
     *
     * Security:
     * - Pure math only.
     *
     * @param amount Base amount (same unit as the return value).
     * @param feeBps Fee rate in basis points (10_000 = 100%).
     * @return feeAmount Floor(amount * feeBps / 10_000).
     */
    function calculateFee(uint256 amount, uint256 feeBps)
        internal
        pure
        returns (uint256)
    {
        return percentageMul(amount, feeBps);
    }
} 
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MathConstants} from "../constants/MathConstants.sol";

/// @title HealthFactorLib
/// @notice Pure library for health factor calculations and threshold checks.
/// @dev Minimal API for high-frequency use in core and liquidation paths.
///      Convention: health factor and ratios are expressed in basis points (bps, 1e4).
library HealthFactorLib {
    /**
     * @notice Check whether the position is under the minimum health factor threshold.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     * - Best-effort: if totalDebt == 0, returns false
     *
     * @param totalCollateral Total collateral value (value units defined by caller; consistent with totalDebt).
     * @param totalDebt Total debt value (value units defined by caller; consistent with totalCollateral).
     * @param minHealthFactor Minimum health factor threshold in bps (1e4 = 100%).
     * @return undercollateralized True if below threshold and should be liquidatable.
     */
    function isUnderCollateralized(
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 minHealthFactor
    ) internal pure returns (bool undercollateralized) {
        if (totalDebt == 0) return false;
        unchecked {
            // collateral * 1e4 < debt * minHF is considered unhealthy
            return
                totalCollateral * MathConstants.BPS <
                totalDebt * minHealthFactor;
        }
    }

    /**
     * @notice Calculate the health factor in bps.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     * - Best-effort: if totalDebt == 0, returns max uint256
     *
     * @param totalCollateral Total collateral value (value units defined by caller; consistent with totalDebt).
     * @param totalDebt Total debt value (value units defined by caller; consistent with totalCollateral).
     * @return healthFactorBps Health factor in bps (1e4 = 100%).
     */
    function calcHealthFactor(
        uint256 totalCollateral,
        uint256 totalDebt
    ) internal pure returns (uint256) {
        if (totalDebt == 0) return type(uint256).max;
        return (totalCollateral * MathConstants.BPS) / totalDebt;
    }

    /**
     * @notice Calculate the loan-to-value ratio (LTV) in bps.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     * - Best-effort: if collateral == 0, returns 0
     *
     * @param debt Total debt value (value units defined by caller; consistent with collateral).
     * @param collateral Total collateral value (value units defined by caller; consistent with debt).
     * @return ltvBps LTV in bps (1e4 = 100%).
     */
    function calcLtv(
        uint256 debt,
        uint256 collateral
    ) internal pure returns (uint256) {
        if (collateral == 0) return 0;
        return (debt * MathConstants.BPS) / collateral;
    }

    /**
     * @notice Calculate effective collateral after excluding guarantee amount.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Pure function
     * - Best-effort: clamps to zero if guarantee exceeds collateral
     *
     * @param totalCollateral Total collateral amount/value.
     * @param guaranteeAmount Guarantee amount/value to exclude.
     * @return effective Effective collateral after exclusion.
     */
    function effectiveCollateral(
        uint256 totalCollateral,
        uint256 guaranteeAmount
    ) internal pure returns (uint256) {
        return
            totalCollateral > guaranteeAmount
                ? totalCollateral - guaranteeAmount
                : 0;
    }
}

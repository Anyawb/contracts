// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IStatisticsViewMinimal
 * @notice Minimal StatisticsView push surface used by business modules.
 * @dev Reverts if:
 *      - the implementation rejects an unauthorized caller
 *      - `user` is zero
 *      - any delta is invalid under the target accounting rules
 *
 * Security:
 * - Push-style write hook for trusted protocol modules only.
 * - Exposes the narrow user-statistics refresh path without importing the full StatisticsView surface.
 */
interface IStatisticsViewMinimal {
    /**
     * @notice Pushes user-level collateral and debt deltas into StatisticsView.
     * @dev Reverts if:
     *      - the implementation rejects an unauthorized caller
     *      - `user` is zero
     *      - the provided deltas violate target-module accounting checks
     *
     * Security:
     * - Mutates cached or derived user statistics in the target implementation.
     *
     * @param user User whose statistics should be refreshed.
     * @param collateralIn Collateral increase in the implementation's accounting unit.
     * @param collateralOut Collateral decrease in the implementation's accounting unit.
     * @param borrow Borrow increase in the implementation's accounting unit.
     * @param repay Repay decrease in the implementation's accounting unit.
     */
    function pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay
    ) external;
}

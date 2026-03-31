// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IStatisticsViewGuaranteeMinimal
 * @notice Minimal StatisticsView guarantee push surface used by business modules.
 * @dev Reverts if:
 *      - the implementation rejects an unauthorized caller
 *      - `user` or `asset` is zero
 *
 * Security:
 * - Push-style write hook intended for trusted protocol modules only.
 * - Exposes only the guarantee refresh path required by integrations.
 */
interface IStatisticsViewGuaranteeMinimal {
    /**
     * @notice Pushes a guarantee-state refresh for one user and asset.
     * @dev Reverts if:
     *      - the implementation rejects an unauthorized caller
     *      - `user` or `asset` is zero
     *      - guarantee state is otherwise invalid under StatisticsView rules
     *
     * Security:
     * - Mutates cached or derived statistics state in the target implementation.
     *
     * @param user User whose guarantee statistics should be refreshed.
     * @param asset Asset associated with the guarantee state.
     * @param guaranteeAmount Guarantee amount in asset token decimals.
     * @param isLocked Whether the guarantee is currently locked.
     */
    function pushGuaranteeUpdate(
        address user,
        address asset,
        uint256 guaranteeAmount,
        bool isLocked
    ) external;
}

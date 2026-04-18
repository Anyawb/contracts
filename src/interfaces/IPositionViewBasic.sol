// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPositionViewBasic
 * @notice Shared read-only subset for user position snapshots.
 */
interface IPositionViewBasic {
    function getUserPositionWithMeta(
        address user,
        address asset
    )
        external
        view
        returns (
            uint256 collateral,
            uint256 debt,
            bool isValid,
            uint256 blockNumber,
            uint64 version
        );
}

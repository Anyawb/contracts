// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IHealthViewBasic
 * @notice Shared read-only subset for health factor queries.
 */
interface IHealthViewBasic {
    function getUserHealthFactorWithMeta(
        address user
    )
        external
        view
        returns (uint256 healthFactor, bool isValid, uint256 blockNumber);
}

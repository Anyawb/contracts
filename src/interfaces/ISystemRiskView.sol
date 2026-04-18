// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISystemRiskView
 * @notice Shared read-only boundary for system-scoped risk parameters exposed by SystemRiskView.
 */
interface ISystemRiskView {
    function getLiquidationThreshold()
        external
        view
        returns (uint256 threshold);

    function getMinHealthFactor()
        external
        view
        returns (uint256 minHealthFactor);

    function getMaxLtvBps() external view returns (uint256 maxLtvBps);
}

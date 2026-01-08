// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationPayoutManager
 * @notice Interface for liquidation residual value distribution - read-only/configuration
 */
interface ILiquidationPayoutManager {
    struct PayoutRecipients {
        address platform;
        address reserve;
        address lenderCompensation;
    }

    /// @notice Distribution ratios (in basis points), sum should equal 10_000
    struct PayoutRates {
        uint256 platformBps;
        uint256 reserveBps;
        uint256 lenderBps;
        uint256 liquidatorBps;
    }

    /**
     * @notice Get current recipient address configuration
     * @return recipients Recipient address configuration struct
     */
    function getRecipients() external view returns (PayoutRecipients memory recipients);

    /**
     * @notice Get current distribution ratio configuration
     * @return rates Distribution ratio configuration struct (in basis points)
     */
    function getRates() external view returns (PayoutRates memory rates);

    /**
     * @notice Calculate distribution shares (integer distribution, remainder all goes to liquidator)
     * @param collateralAmount Amount of seized collateral
     * @return platformShare Platform share
     * @return reserveShare Risk reserve share
     * @return lenderShare Lender compensation share
     * @return liquidatorShare Liquidator share (including remainder)
     */
    function calculateShares(uint256 collateralAmount)
        external
        view
        returns (
            uint256 platformShare,
            uint256 reserveShare,
            uint256 lenderShare,
            uint256 liquidatorShare
        );
}

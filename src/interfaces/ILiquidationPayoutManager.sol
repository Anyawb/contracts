// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationPayoutManager
 * @notice SSOT interface for liquidation residual distribution configuration and share calculation.
 * @dev Reverts if:
 *      - caller is not authorized for configuration writes (implementation-defined; typically ACTION_SET_PARAMETER)
 *      - input validation fails (implementation-defined; e.g. zero recipients, invalid bps sum)
 *
 * Security:
 * - Configuration writes MUST be governance-gated in the implementation (e.g. `ActionKeys.ACTION_SET_PARAMETER`).
 * - Share calculation MUST be deterministic; rounding remainder SHOULD be assigned to the liquidator share
 *   to ensure the sum equals `collateralAmount`.
 */
interface ILiquidationPayoutManager {
    struct PayoutRecipients {
        address platform;
        address reserve;
        address lenderCompensation;
    }

    /**
     * @notice Distribution ratios (in basis points).
     * @dev Convention:
     * - Sum MUST equal \(10_000 = 100\%\) in the implementation.
     */
    struct PayoutRates {
        uint256 platformBps;
        uint256 reserveBps;
        uint256 lenderBps;
        uint256 liquidatorBps;
    }

    /**
     * @notice Get configured Registry address.
     * @dev Reverts if:
     *      - none
     *
     * @return registryAddr Registry address (module resolver SSOT)
     */
    function registryAddrVar() external view returns (address registryAddr);

    /**
     * @notice Get current recipient configuration.
     * @dev Reverts if:
     *      - none
     *
     * @return recipients Recipient addresses (platform/reserve/lenderCompensation)
     */
    function getRecipients() external view returns (PayoutRecipients memory recipients);

    /**
     * @notice Get current distribution ratio configuration.
     * @dev Reverts if:
     *      - none
     *
     * @return rates Distribution ratios in bps (\(1e4 = 100\%\))
     */
    function getRates() external view returns (PayoutRates memory rates);

    /**
     * @notice Calculate distribution shares for a seized `collateralAmount`.
     * @dev Reverts if:
     *      - none (pure/view math in implementation)
     *
     * Security:
     * - Deterministic integer math; rounding remainder SHOULD be assigned to liquidatorShare so that:
     *   `platformShare + reserveShare + lenderShare + liquidatorShare == collateralAmount`.
     *
     * @param collateralAmount Seized collateral amount (token native decimals)
     * @return platformShare Platform share (token native decimals)
     * @return reserveShare Reserve share (token native decimals)
     * @return lenderShare Lender-compensation share (token native decimals)
     * @return liquidatorShare Liquidator share (token native decimals; includes remainder)
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

    /**
     * @notice Update recipients and rates.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined; typically ACTION_SET_PARAMETER)
     *      - any recipient is zero (implementation-defined)
     *      - rates sum is not \(10_000\) bps (implementation-defined)
     *
     * Security:
     * - Governance-gated in implementation.
     *
     * @param recipients New recipient addresses
     * @param rates New distribution ratios in bps (\(1e4 = 100\%\))
     */
    function updateConfig(PayoutRecipients calldata recipients, PayoutRates calldata rates) external;

    /**
     * @notice Update recipients only (rates unchanged).
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined; typically ACTION_SET_PARAMETER)
     *      - any recipient is zero (implementation-defined)
     *
     * Security:
     * - Governance-gated in implementation.
     *
     * @param recipients New recipient addresses
     */
    function updateRecipients(PayoutRecipients calldata recipients) external;

    /**
     * @notice Update rates only (recipients unchanged).
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined; typically ACTION_SET_PARAMETER)
     *      - rates sum is not \(10_000\) bps (implementation-defined)
     *
     * Security:
     * - Governance-gated in implementation.
     *
     * @param rates New distribution ratios in bps (\(1e4 = 100\%\))
     */
    function updateRates(PayoutRates calldata rates) external;
}

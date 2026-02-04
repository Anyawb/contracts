// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILendingEngineBasic
 * @notice Debt-ledger SSOT interface (KEY_LE): multi-asset debt writes and debt/valuation reads.
 * @dev Reverts if:
 *      - caller is not authorized (implementation-defined; typically onlyVaultCore / role-gated)
 *
 * Security:
 * - Role-gated / onlyVaultCore in the implementation
 *
 * Architecture:
 * - ORDER_ENGINE handles order lifecycle side-effects (e.g. LoanNFT minting, DataPush events).
 * - KEY_LE tracks debt balances and valuation, called via VaultCore.borrowFor/repayFor and liquidation paths.
 */
interface ILendingEngineBasic {
    /**
     * @notice Record a borrow for a user on a given debt asset.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined; typically onlyVaultCore/role-gated)
     *
     * Security:
     * - Role-gated / onlyVaultCore in implementation.
     *
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @param amount Borrow amount (token decimals of `asset`).
     * @param collateralAdded Placeholder: accompanying collateral delta (implementation-defined).
     * @param termDays Placeholder: term length in days (implementation-defined).
     */
    function borrow(address user, address asset, uint256 amount, uint256 collateralAdded, uint16 termDays) external;

    /**
     * @notice Record a repayment for a user on a given debt asset.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined; typically onlyVaultCore/role-gated)
     *
     * Security:
     * - Role-gated / onlyVaultCore in implementation.
     *
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @param amount Repay amount (token decimals of `asset`).
     */
    function repay(address user, address asset, uint256 amount) external;

    /**
     * @notice Get current debt balance for a user on an asset.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @param user User address.
     * @param asset Debt asset address.
     * @return debt Debt amount (token decimals of `asset`).
     */
    function getDebt(address user, address asset) external view returns (uint256 debt);

    /**
     * @notice Get total debt for a given asset across the system.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @param asset Debt asset address.
     * @return totalDebt Total debt amount (token decimals of `asset`).
     */
    function getTotalDebtByAsset(address asset) external view returns (uint256 totalDebt);

    /**
     * @notice Get user's total debt value (USD-8 value).
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @param user User address.
     * @return totalValue Debt value in USD-8.
     */
    function getUserTotalDebtValue(address user) external view returns (uint256 totalValue);

    /**
     * @notice Get system total debt value (USD-8 value).
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @return totalValue Debt value in USD-8.
     */
    function getTotalDebtValue() external view returns (uint256 totalValue);

    /**
     * @notice Get list of debt assets for a user.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @param user User address.
     * @return assets Array of debt asset addresses.
     */
    function getUserDebtAssets(address user) external view returns (address[] memory assets);

    /**
     * @notice Force reduce user debt (liquidation path).
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined; typically ACTION_LIQUIDATE)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param user User address.
     * @param asset Debt asset address.
     * @param amount Debt amount to reduce (token decimals of `asset`).
     */
    function forceReduceDebt(address user, address asset, uint256 amount) external;

    /**
     * @notice Calculate expected interest for a hypothetical borrow.
     * @dev Reverts if:
     *      - none (implementation-defined)
     *
     * Security:
     * - View only
     *
     * @param user User address.
     * @param asset Debt asset address.
     * @param amount Borrow amount (token decimals of `asset`).
     * @return interest Estimated interest amount (token decimals; implementation-defined).
     */
    function calculateExpectedInterest(address user, address asset, uint256 amount)
        external
        view
        returns (uint256 interest);

    /*━━━━━━━━━━━━━━━ LIQUIDATION RELATED FUNCTIONS ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Get reducible (liquidatable) debt amount for a user on an asset.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @param user User address.
     * @param asset Debt asset address.
     * @return reducibleAmount Reducible debt amount (token decimals of `asset`).
     */
    function getReducibleDebtAmount(address user, address asset) external view returns (uint256 reducibleAmount);

    /**
     * @notice Calculate debt value for a user on an asset (USD-8 value).
     * @dev Reverts if:
     *      - none (implementation-defined)
     *
     * Security:
     * - View only
     *
     * @param user User address.
     * @param asset Debt asset address.
     * @return value Debt value in USD-8.
     */
    function calculateDebtValue(address user, address asset) external view returns (uint256 value);

} 
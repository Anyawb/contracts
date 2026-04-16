// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILendingEngineDebtRead } from "./ILendingEngineDebtRead.sol";
import { ILendingEngineDebtWrite } from "./ILendingEngineDebtWrite.sol";

/**
 * @title ILendingEngineBasic
 * @notice Debt-ledger SSOT interface (KEY_LE): multi-asset debt writes and debt/valuation reads.
 * @dev Reverts if:
 *      - see inherited {ILendingEngineDebtRead} / {ILendingEngineDebtWrite} semantics
 *
 * Security:
 * - Compatibility-oriented aggregation layer for legacy callers.
 * - New consumers should prefer {ILendingEngineDebtRead} and {ILendingEngineDebtWrite} so read/write boundaries remain
 *   explicit.
 *
 * Architecture:
 * - ORDER_ENGINE handles order lifecycle side-effects (e.g. LoanNFT minting, DataPush events).
 * - KEY_LE tracks debt balances and valuation, called via VaultCore.borrowFor/repayFor and liquidation paths.
 */
interface ILendingEngineBasic is ILendingEngineDebtRead, ILendingEngineDebtWrite {
     /**
      * @notice Record a borrow for a user on a given debt asset.
      * @dev Reverts if:
          *      - see {ILendingEngineDebtWrite.borrow}
      *
      * Security:
          * - Compatibility alias for the narrow debt-write surface.
      *
      * @param user Borrower address.
      * @param asset Debt asset address.
      * @param amount Borrow amount (token decimals of `asset`).
      * @param collateralAdded Placeholder: accompanying collateral delta (implementation-defined).
      * @param termDays Placeholder: term length in days (implementation-defined).
      */
    function borrow(
        address user,
        address asset,
        uint256 amount,
        uint256 collateralAdded,
        uint16 termDays
    ) external;

     /**
      * @notice Record a repayment for a user on a given debt asset.
      * @dev Reverts if:
          *      - see {ILendingEngineDebtWrite.repay}
      *
      * Security:
          * - Compatibility alias for the narrow debt-write surface.
      *
      * @param user Borrower address.
      * @param asset Debt asset address.
      * @param amount Repay amount (token decimals of `asset`).
      */
    function repay(address user, address asset, uint256 amount) external;

     /**
      * @notice Get current debt balance for a user on an asset.
      * @dev Reverts if:
          *      - see {ILendingEngineDebtRead.getDebt}
      *
      * Security:
          * - Compatibility alias for the narrow debt-read surface.
      *
      * @param user User address.
      * @param asset Debt asset address.
      * @return debt Debt amount (token decimals of `asset`).
      */
    function getDebt(
        address user,
        address asset
    ) external view returns (uint256 debt);

     /**
      * @notice Get total debt for a given asset across the system.
      * @dev Reverts if:
          *      - see {ILendingEngineDebtRead.getTotalDebtByAsset}
      *
      * Security:
          * - Compatibility alias for the narrow debt-read surface.
      *
      * @param asset Debt asset address.
      * @return totalDebt Total debt amount (token decimals of `asset`).
      */
    function getTotalDebtByAsset(
        address asset
    ) external view returns (uint256 totalDebt);

    /**
    * @notice Get user's total debt value in the normalized system valuation unit.
      * @dev Reverts if:
          *      - see {ILendingEngineDebtRead.getUserTotalDebtValue}
      *
      * Security:
          * - Compatibility alias for the narrow debt-read surface.
      *
      * @param user User address.
    * @return totalValue Debt value normalized to 18 decimals.
      */
    function getUserTotalDebtValue(
        address user
    ) external view returns (uint256 totalValue);

    /**
     * @notice Get user's best-effort total debt value in the normalized system valuation unit.
     * @dev Reverts if:
     *      - see {ILendingEngineDebtRead.getUserTotalDebtValueBestEffort}
     *
     * Security:
     *      - Compatibility alias for the narrow debt-read surface.
     *
     * @param user User address.
     * @return totalValue Debt value normalized to 18 decimals.
     */
    function getUserTotalDebtValueBestEffort(
        address user
    ) external view returns (uint256 totalValue);

    /**
     * @notice Get user's strict total debt value in the normalized system valuation unit.
     * @dev Reverts if:
     *      - see {ILendingEngineDebtRead.getUserTotalDebtValueStrict}
     *
     * Security:
     *      - Compatibility alias for the narrow debt-read surface.
     *
     * @param user User address.
     * @return totalValue Debt value normalized to 18 decimals.
     */
    function getUserTotalDebtValueStrict(
        address user
    ) external view returns (uint256 totalValue);

    /**
    * @notice Get system total debt value in the normalized system valuation unit.
      * @dev Reverts if:
          *      - see {ILendingEngineDebtRead.getTotalDebtValue}
      *
      * Security:
          * - Compatibility alias for the narrow debt-read surface.
      *
    * @return totalValue Debt value normalized to 18 decimals.
      */
    function getTotalDebtValue() external view returns (uint256 totalValue);

     /**
      * @notice Get list of debt assets for a user.
      * @dev Reverts if:
          *      - see {ILendingEngineDebtRead.getUserDebtAssets}
      *
      * Security:
          * - Compatibility alias for the narrow debt-read surface.
      *
      * @param user User address.
      * @return assets Array of debt asset addresses.
      */
    function getUserDebtAssets(
        address user
    ) external view returns (address[] memory assets);

     /**
      * @notice Force reduce user debt (liquidation path).
      * @dev Reverts if:
          *      - see {ILendingEngineDebtWrite.forceReduceDebt}
      *
      * Security:
          * - Compatibility alias for the narrow debt-write surface.
      *
      * @param user User address.
      * @param asset Debt asset address.
      * @param amount Debt amount to reduce (token decimals of `asset`).
      */
    function forceReduceDebt(
        address user,
        address asset,
        uint256 amount
    ) external;

    /**
     * @notice Calculate expected interest for a hypothetical borrow.
     * @dev Reverts if:
        *      - see implementation-specific valuation/oracle requirements
     *
     * Security:
        * - Read-only helper retained for legacy integrations.
     *
     * @param user User address.
     * @param asset Debt asset address.
     * @param amount Borrow amount (token decimals of `asset`).
     * @return interest Estimated interest amount (token decimals; implementation-defined).
     */
    function calculateExpectedInterest(
        address user,
        address asset,
        uint256 amount
    ) external view returns (uint256 interest);

    /*━━━━━━━━━━━━━━━ LIQUIDATION RELATED FUNCTIONS ━━━━━━━━━━━━━━━*/

     /**
      * @notice Get reducible (liquidatable) debt amount for a user on an asset.
      * @dev Reverts if:
          *      - see {ILendingEngineDebtRead.getReducibleDebtAmount}
      *
      * Security:
          * - Compatibility alias for the narrow debt-read surface.
      *
      * @param user User address.
      * @param asset Debt asset address.
      * @return reducibleAmount Reducible debt amount (token decimals of `asset`).
      */
    function getReducibleDebtAmount(
        address user,
        address asset
    ) external view returns (uint256 reducibleAmount);

    /**
    * @notice Calculate debt value for a user on an asset in the normalized system valuation unit.
     * @dev Reverts if:
        *      - see implementation-specific valuation/oracle requirements
     *
     * Security:
        * - Read-only helper retained for legacy integrations.
     *
     * @param user User address.
     * @param asset Debt asset address.
    * @return value Debt value normalized to 18 decimals.
     */
    function calculateDebtValue(
        address user,
        address asset
    ) external view returns (uint256 value);

    /**
     * @notice Calculate best-effort debt value for a user on an asset in the normalized system valuation unit.
     * @dev Reverts if:
     *      - see {ILendingEngineDebtRead.calculateDebtValueBestEffort}
     *
     * Security:
     *      - Read-only helper retained for compatibility and non-decision consumers.
     *
     * @param user User address.
     * @param asset Debt asset address.
     * @return value Debt value normalized to 18 decimals.
     */
    function calculateDebtValueBestEffort(
        address user,
        address asset
    ) external view returns (uint256 value);

    /**
     * @notice Calculate strict debt value for a user on an asset in the normalized system valuation unit.
     * @dev Reverts if:
     *      - see {ILendingEngineDebtRead.calculateDebtValueStrict}
     *
     * Security:
     *      - Read-only helper for automated fail-closed decisions.
     *
     * @param user User address.
     * @param asset Debt asset address.
     * @return value Debt value normalized to 18 decimals.
     */
    function calculateDebtValueStrict(
        address user,
        address asset
    ) external view returns (uint256 value);
}

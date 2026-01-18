// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISettlementManager
 * @notice Settlement SSOT write interface: routes repay/settlement and keeper-triggered settlement/liquidation.
 * @dev Reverts if:
 *      - caller is not authorized (implementation-defined; typically onlyVaultCore / role-gated)
 *      - input validation fails (implementation-defined)
 *
 * Security:
 * - User entry is typically onlyVaultCore (VaultCore is the user-facing SSOT)
 * - Keeper entry is typically role-gated (e.g. ACTION_LIQUIDATE)
 */
interface ISettlementManager {
    /**
     * @notice Repay and settle a position (may release collateral; may trigger liquidation branch if needed).
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined; typically onlyVaultCore)
     *      - `user` is zero
     *      - `debtAsset` is zero
     *      - `repayAmount` is zero
     *      - `orderId` is invalid or does not match (`user`, `debtAsset`) in ORDER_ENGINE (implementation-defined)
     *
     * Security:
     * - Role-gated / onlyVaultCore in implementation
     *
     * @param user Borrower/repayer address
     * @param debtAsset Debt asset address
     * @param repayAmount Repay amount (token decimals of `debtAsset`)
     * @param orderId Order/position id (SSOT; ORDER_ENGINE-generated)
     */
    function repayAndSettle(address user, address debtAsset, uint256 repayAmount, uint256 orderId) external;

    /**
     * @notice Keeper-triggered settlement/liquidation entrypoint.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined; typically role-gated)
     *      - `orderId` is invalid or not liquidatable (implementation-defined)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param orderId Order/position id (SSOT; ORDER_ENGINE-generated)
     */
    function settleOrLiquidate(uint256 orderId) external;

    /**
     * @notice Whether strict full-repay auto-release mode is enabled.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     */
    function requireFullRepayRelease() external view returns (bool);

    /**
     * @notice Set strict full-repay auto-release mode.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined; typically governance role)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param enabled True to enable strict mode
     */
    function setRequireFullRepayRelease(bool enabled) external;
}


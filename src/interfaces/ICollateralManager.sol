// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ICollateralManager
 * @notice Multi-asset collateral ledger + custody interface (SSOT for collateral accounting and transfers).
 * @dev Reverts if:
 *      - caller is not authorized (implementation-defined; typically onlyVaultRouter / role-gated)
 *      - input validation fails (implementation-defined; zero addresses/amounts)
 *
 * Security:
 * - User-path writes are typically routed via VaultCore -> VaultRouter -> CollateralManager (onlyVaultRouter)
 * - Seizure/exit paths are typically role-gated (e.g. ACTION_LIQUIDATE) and/or restricted callers
 */
interface ICollateralManager {
    /**
     * @notice Deposit collateral for a user.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - `user` is zero
     *      - `asset` is zero
     *      - `amount` is zero
     *
     * Security:
     * - Routed entry (typically onlyVaultRouter)
     *
     * @param user User address
     * @param asset Collateral asset address
     * @param amount Amount to deposit (token decimals of `asset`)
     */
    function depositCollateral(address user, address asset, uint256 amount) external;

    /**
     * @notice Withdraw collateral for a user.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - `user` is zero
     *      - `asset` is zero
     *      - `amount` is zero
     *      - user has insufficient collateral (implementation-defined)
     *
     * Security:
     * - Routed entry (typically onlyVaultRouter)
     *
     * @param user User address
     * @param asset Collateral asset address
     * @param amount Amount to withdraw (token decimals of `asset`)
     */
    function withdrawCollateral(address user, address asset, uint256 amount) external;

    /**
     * @notice Unified collateral exit: update ledger and transfer ERC20 collateral to `receiver`.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - `user` is zero
     *      - `asset` is zero
     *      - `receiver` is zero
     *      - `amount` is zero
     *      - user has insufficient collateral (implementation-defined)
     *      - ERC20 transfer fails (implementation-defined)
     *
     * Security:
     * - If `receiver == user`, this is a user withdraw / settlement release path
     *   (typically onlyVaultRouter/SettlementManager).
     * - If `receiver != user`, this is a seizure/liquidation path (typically role-gated).
     *
     * @param user User whose collateral balance is reduced
     * @param asset Collateral asset address
     * @param amount Amount to reduce and transfer (token decimals of `asset`)
     * @param receiver Recipient of the real ERC20 transfer
     */
    function withdrawCollateralTo(address user, address asset, uint256 amount, address receiver) external;

    /**
     * @notice Seize collateral for liquidation (reduce ledger and transfer collateral to liquidator).
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined; typically liquidation role)
     *      - `targetUser` is zero
     *      - `collateralAsset` is zero
     *      - `liquidator` is zero
     *      - `collateralAmount` is zero
     *      - user has insufficient collateral (implementation-defined)
     *      - ERC20 transfer fails (implementation-defined)
     *
     * Security:
     * - Role-gated in implementation (liquidation path)
     *
     * @param targetUser Target user whose collateral is seized
     * @param collateralAsset Collateral asset address
     * @param collateralAmount Amount seized (token decimals of `collateralAsset`)
     * @param liquidator Liquidator/receiver address
     */
    function seizeCollateralForLiquidation(
        address targetUser,
        address collateralAsset,
        uint256 collateralAmount,
        address liquidator
    ) external;

    /**
     * @notice Get a user's collateral balance for an asset.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @param user User address
     * @param asset Collateral asset address
     * @return balance Collateral balance (token decimals of `asset`)
     */
    function getCollateral(address user, address asset) external view returns (uint256 balance);

    /**
     * @notice Get total collateral for an asset across the system.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @param asset Collateral asset address
     * @return total Total collateral (token decimals of `asset`)
     */
    function getTotalCollateralByAsset(address asset) external view returns (uint256 total);

    /**
     * @notice Get list of collateral assets for a user.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @param user User address
     * @return assets Array of collateral asset addresses
     */
    function getUserCollateralAssets(address user) external view returns (address[] memory assets);

} 
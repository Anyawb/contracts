// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationManager
 * @notice Liquidation executor interface: direct ledger writes + best-effort single-point View push.
 * @dev Reverts if:
 *      - caller is not authorized (implementation-defined; typically role-gated / onlySettlementManager for SM path)
 *      - input validation fails (implementation-defined; zero addresses/amounts, array mismatch)
 *
 * Security:
 * - Liquidation must write directly to ledger SSOT modules (CollateralManager + KEY_LE)
 *   and MUST NOT rely on View writes.
 * - View push is best-effort; failures must not revert ledger writes.
 * - Current blocks-only maturity enforcement reaches this interface through {BlocksOnlyCoordinator} after upstream
 *   role checks and collateral/debt selection logic have already been resolved.
 */
interface ILiquidationManager {
    /**
     * @notice Execute a single liquidation.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - `targetUser` is zero
     *      - `collateralAsset` is zero
     *      - `debtAsset` is zero
     *      - `collateralAmount` is zero
     *      - `debtAmount` is zero
     *
     * Security:
     * - Direct ledger writes: CollateralManager.withdrawCollateralTo + KEY_LE.forceReduceDebt
     * - Best-effort View push (LiquidatorView.pushLiquidationUpdate); must not revert ledger writes
     * - Callers in the current blocks-only path should only invoke this after the dedicated coordinator has decided
     *   that collateral release is not available and liquidation is required.
     *
     * @param targetUser Liquidated user address
     * @param collateralAsset Seized collateral asset address
     * @param debtAsset Debt asset address reduced/settled
     * @param collateralAmount Collateral amount seized (token decimals of `collateralAsset`)
     * @param debtAmount Debt amount reduced (token decimals of `debtAsset`)
     * @param bonus Optional bonus value passed through for reporting (token decimals / implementation-defined)
     */
    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external;

    /**
     * @notice Execute liquidation on behalf of a keeper via SettlementManager, preserving the original liquidator.
     * @dev Reverts if:
     *      - caller is not the registered SettlementManager (implementation-defined)
     *      - inputs are invalid (implementation-defined)
     *
     * Security:
     * - Preserves `liquidator == keeper msg.sender` semantics when SettlementManager routes the liquidation
     * - Primarily preserves legacy SettlementManager attribution; current blocks-only maturity enforcement does not
     *   rely on SettlementManager as its orchestration entrypoint.
     *
     * @param liquidator Original keeper address to attribute payouts and events to
     * @param targetUser Liquidated user address
     * @param collateralAsset Seized collateral asset address
     * @param debtAsset Debt asset address reduced/settled
     * @param collateralAmount Collateral amount seized (token decimals of `collateralAsset`)
     * @param debtAmount Debt amount reduced (token decimals of `debtAsset`)
     * @param bonus Optional bonus value passed through for reporting (token decimals / implementation-defined)
     */
    function liquidateFromSettlementManager(
        address liquidator,
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external;

    /**
     * @notice Execute batch liquidation (direct ledger writes + single-point batch View push).
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - arrays mismatch (implementation-defined)
     *      - batch size exceeds safety cap (implementation-defined)
     *
     * Security:
     * - Direct ledger writes per item; View push is best-effort and must not revert ledger writes
     * - Batch callers must ensure each item has already passed upstream product-specific authorization and eligibility
     *   checks before invoking liquidation fan-out.
     */
    function batchLiquidate(
        address[] calldata targetUsers,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        uint256[] calldata bonuses
    ) external;
}

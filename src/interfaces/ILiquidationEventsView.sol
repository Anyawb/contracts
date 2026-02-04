// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ILiquidationEventsView
 * @notice Single-point liquidation push interface for forwarding to the unified DataPush stream.
 * @dev Reverts if:
 *      - implementation denies the caller (typically restricted to Registry.KEY_LIQUIDATION_MANAGER and/or
 *        Registry.KEY_LIQUIDATION_PAYOUT_MANAGER)
 *      - implementation requires Registry/config to be set and it is not (implementation-defined)
 *
 * Security:
 * - Implementations MUST restrict push entrypoints to authorized business modules.
 * - Implementations MUST be view-layer only (emit events / cache), and MUST NOT perform ledger writes.
 *
 * Architecture:
 * - Liquidation data pushes are single-sourced here to avoid duplicate `_emitData` emissions in business modules.
 */
interface ILiquidationEventsView {
    /**
     * @notice Push a single liquidation update.
     * @dev Reverts if:
     *      - implementation denies the caller (e.g. not the registered LiquidationManager)
     *
     * Security:
     * - Restricted to authorized liquidation business modules in the implementation.
     *
     * @param user Liquidated user address
     * @param collateralAsset Collateral asset seized (ERC20)
     * @param debtAsset Debt asset reduced/settled (ERC20)
     * @param collateralAmount Collateral amount seized (token native decimals)
     * @param debtAmount Debt amount reduced (token native decimals)
     * @param liquidator Keeper/liquidator address (attribution)
     * @param bonus Liquidation bonus for reporting (units implementation-defined; typically token native decimals)
     * @param blockNumber Block number (best-effort; typically `block.number`)
     */
    function pushLiquidationUpdate(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus,
        uint256 blockNumber
    ) external;

    /**
     * @notice Push a batch liquidation update.
     * @dev Reverts if:
     *      - implementation denies the caller
     *      - array lengths mismatch (implementation-defined)
     *
     * Security:
     * - Restricted to authorized liquidation business modules in the implementation.
     *
     * @param users Liquidated users array
     * @param collateralAssets Collateral assets array
     * @param debtAssets Debt assets array
     * @param collateralAmounts Collateral amounts array (token native decimals)
     * @param debtAmounts Debt amounts array (token native decimals)
     * @param liquidator Keeper/liquidator address (attribution)
     * @param bonuses Bonus array (units implementation-defined)
     * @param blockNumber Block number (best-effort; typically `block.number`)
     */
    function pushBatchLiquidationUpdate(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        address liquidator,
        uint256[] calldata bonuses,
        uint256 blockNumber
    ) external;

    /**
     * @notice Push liquidation payout distribution results.
     * @dev Reverts if:
     *      - implementation denies the caller (typically liquidation manager or payout manager only)
     *
     * Security:
     * - Restricted to authorized liquidation/payout modules in the implementation.
     *
     * @param user Liquidated user address
     * @param collateralAsset Collateral asset being distributed (ERC20)
     * @param platform Platform recipient address
     * @param reserve Reserve recipient address
     * @param lender Lender-compensation recipient address
     * @param liquidator Liquidator/keeper recipient address
     * @param platformShare Platform share (token native decimals)
     * @param reserveShare Reserve share (token native decimals)
     * @param lenderShare Lender-compensation share (token native decimals)
     * @param liquidatorShare Liquidator share (token native decimals; includes remainder)
     * @param blockNumber Block number (best-effort; typically `block.number`)
     */
    function pushLiquidationPayout(
        address user,
        address collateralAsset,
        address platform,
        address reserve,
        address lender,
        address liquidator,
        uint256 platformShare,
        uint256 reserveShare,
        uint256 lenderShare,
        uint256 liquidatorShare,
        uint256 blockNumber
    ) external;
}



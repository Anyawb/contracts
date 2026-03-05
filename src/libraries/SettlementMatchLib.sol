// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IAssetWhitelist } from "../interfaces/IAssetWhitelist.sol";
import { IOrderEngine } from "../interfaces/IOrderEngine.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { IFeeRouter } from "../interfaces/IFeeRouter.sol";
import { ILenderPoolVault } from "../interfaces/ILenderPoolVault.sol";
import { TermBlocksLib } from "./TermBlocksLib.sol";

/**
 * @dev Minimal VaultCore interface for typed calls.
 */
interface IVaultCoreBorrowFor {
    function borrowFor(address borrower, address asset, uint256 amount, uint16 termDays) external;
}

/**
 * @title SettlementMatchLib
 * @notice Atomic settlement orchestration for funding + accounting + order creation.
 * @dev This library is intended to be called by a trusted orchestration entrypoint (e.g., VaultBusinessLogic).
 *
 * Reverts if:
 * - (none; see per-function notes)
 *
 * Security:
 * - Stateless library; external calls occur in helpers and entrypoints.
 */
library SettlementMatchLib {
    using SafeERC20 for IERC20;

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    /// @notice Thrown when an input address is zero.
    error SettlementMatchLib__ZeroAddress();
    /// @notice Thrown when an input amount is zero or otherwise invalid for the operation.
    error SettlementMatchLib__InvalidAmount();
    /// @notice Thrown when the provided asset is not allowed by the AssetWhitelist module (when enabled).
    error SettlementMatchLib__AssetNotAllowed();
    /// @notice Thrown when a collateral top-up is attempted during matching (forbidden in strict architecture).
    error SettlementMatchLib__CollateralTopUpNotSupported();

    /*━━━━━━━━━━━━━━━ TIME AXIS (SSOT: blocks) ━━━━━━━━━━━━━━━*/
    /// @dev NOTE (Time-Dependency-Refactor):
    /// - We avoid any onchain "days->blocks" arithmetic.
    /// - `termDays` is a legacy bucket identifier; mapping to blocks is explicit via {TermBlocksLib}.

    /*━━━━━━━━━━━━━━━ INTERNAL HELPERS ━━━━━━━━━━━━━━━*/
    function _requireRole(address registry, bytes32 actionKey, address user) private view {
        if (registry == address(0)) revert SettlementMatchLib__ZeroAddress();
        address acmAddr = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    function _checkAssetWhitelist(address registry, address asset) private view {
        address assetWhitelistAddr = IRegistry(registry).getModule(ModuleKeys.KEY_ASSET_WHITELIST);
        if (assetWhitelistAddr != address(0) && !IAssetWhitelist(assetWhitelistAddr).isAssetAllowed(asset)) {
            revert SettlementMatchLib__AssetNotAllowed();
        }
    }

    /*━━━━━━━━━━━━━━━ API ━━━━━━━━━━━━━━━*/
    /**
     * @notice Finalize a matched loan atomically (fund borrower + write debt + create the loan order).
     * @dev Reverts if:
     *      - registry == address(0) (SettlementMatchLib__ZeroAddress)
     *      - borrower == address(0) (SettlementMatchLib__ZeroAddress)
     *      - lender == address(0) (SettlementMatchLib__ZeroAddress)
     *      - borrowAsset == address(0) (SettlementMatchLib__ZeroAddress)
     *      - amount == 0 (SettlementMatchLib__InvalidAmount)
     *      - borrowAsset is not whitelisted (SettlementMatchLib__AssetNotAllowed)
     *      - caller (the orchestration contract) lacks ACTION_ORDER_CREATE (via ACM.requireRole)
     *      - collateralAsset != address(0) or collateralAmount != 0 (SettlementMatchLib__CollateralTopUpNotSupported)
     *      - any downstream module call reverts (Registry/Pool/VaultCore/LendingEngine/ERC20)
     *
     * Security:
     * - Role-gated via AccessControlManager (ACTION_ORDER_CREATE) for the orchestration entrypoint.
     * - Collateral top-up during matching is forbidden (strict architecture).
     * - Performs multiple external calls; caller SHOULD enforce reentrancy protection at the entrypoint.
     *
     * @param registry Registry address (module resolver).
     * @param borrower Borrower address.
     * @param lender Lender address.
     * @param collateralAsset Collateral asset address (MUST be zero for strict architecture).
     * @param collateralAmount Collateral amount (MUST be zero for strict architecture).
     * @param borrowAsset Borrow asset (pool asset; ERC20).
     * @param amount Borrow principal amount (token decimals).
     * @param termDays Term length (days).
     * @param rateBps Interest rate (bps; 1 bps = 1e-4).
     * @return orderId Created loan order id (from LendingEngine).
     */
    function finalizeAtomic(
        address registry,
        address borrower,
        address lender,
        address collateralAsset,
        uint256 collateralAmount,
        address borrowAsset,
        uint256 amount,
        uint16 termDays,
        uint256 rateBps
    ) internal returns (uint256 orderId) {
        if (registry == address(0) || borrower == address(0) || lender == address(0) || borrowAsset == address(0)) {
            revert SettlementMatchLib__ZeroAddress();
        }
        if (amount == 0) revert SettlementMatchLib__InvalidAmount();

        // 1) Asset whitelist + permissions.
        _checkAssetWhitelist(registry, borrowAsset);
        // NOTE: `address(this)` ensures the role check is enforced for the orchestration entrypoint contract
        // (e.g., VaultBusinessLogic), not the external EOA caller. This matches the "only grant the
        // orchestrator long-lived privileges" model.
        _requireRole(registry, ActionKeys.ACTION_ORDER_CREATE, address(this));

        // 2) Collateral top-up during match is NOT supported.
        // Strict architecture: collateral MUST be deposited beforehand via:
        // VaultCore.deposit -> VaultRouter.processUserOperation -> CollateralManager.depositCollateral
        if (collateralAsset != address(0) || collateralAmount != 0) {
            revert SettlementMatchLib__CollateralTopUpNotSupported();
        }

        // 3) Pull funds from the lender pool vault to this contract, then forward to the borrower.
        address pool = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_LENDER_POOL_VAULT);
        ILenderPoolVault(pool).transferOut(borrowAsset, address(this), amount);
        IERC20(borrowAsset).safeTransfer(borrower, amount);

        // 4) Write debt via the canonical VaultCore entrypoint (hits onlyVaultCore in the implementation).
        address vaultCore = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
        IVaultCoreBorrowFor(vaultCore).borrowFor(borrower, borrowAsset, amount, termDays);

        // 5) Create the loan order. LoanNFT + Reward + DataPush are handled by LendingEngine.
        IOrderEngine.LoanOrder memory order = IOrderEngine.LoanOrder({
            principal: amount,
            rate: rateBps,
            // SSOT (time refactor): term is measured in blocks, not seconds.
            term: TermBlocksLib.termDaysToBlocks(termDays),
            borrower: borrower,
            lender: lender,
            asset: borrowAsset,
            startTimestamp: 0,
            maturity: 0,
            repaidAmount: 0
        });
        address orderEngine = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        orderId = IOrderEngine(orderEngine).createLoanOrder(order);
    }

    /**
     * @notice Finalize a matched loan atomically and distribute borrow fees (borrower receives net amount).
     * @dev Reverts if:
     *      - registry == address(0) (SettlementMatchLib__ZeroAddress)
     *      - borrower == address(0) (SettlementMatchLib__ZeroAddress)
     *      - lender == address(0) (SettlementMatchLib__ZeroAddress)
     *      - borrowAsset == address(0) (SettlementMatchLib__ZeroAddress)
     *      - amount == 0 (SettlementMatchLib__InvalidAmount)
     *      - borrowAsset is not whitelisted (SettlementMatchLib__AssetNotAllowed)
     *      - caller (the orchestration contract) lacks ACTION_ORDER_CREATE (via ACM.requireRole)
     *      - collateralAsset != address(0) or collateralAmount != 0 (SettlementMatchLib__CollateralTopUpNotSupported)
     *      - FeeRouter distribution reverts / ERC20 transfer/approve fails / any downstream module call reverts
     *
     * Security:
     * - Role-gated via AccessControlManager (ACTION_ORDER_CREATE) for the orchestration entrypoint.
     * - Collateral top-up during matching is forbidden (strict architecture).
     * - Performs multiple external calls; caller SHOULD enforce reentrancy protection at the entrypoint.
     *
     * @param registry Registry address (module resolver).
     * @param borrower Borrower address.
     * @param lender Lender address.
     * @param collateralAsset Collateral asset address (MUST be zero for strict architecture).
     * @param collateralAmount Collateral amount (MUST be zero for strict architecture).
     * @param borrowAsset Borrow asset (pool asset; ERC20).
     * @param amount Borrow principal amount (token decimals).
     * @param termDays Term length (days).
     * @param rateBps Interest rate (bps; 1 bps = 1e-4).
     * @return orderId Created loan order id (from LendingEngine).
     */
    function finalizeAtomicFull(
        address registry,
        address borrower,
        address lender,
        address collateralAsset,
        uint256 collateralAmount,
        address borrowAsset,
        uint256 amount,
        uint16 termDays,
        uint256 rateBps
    ) internal returns (uint256 orderId) {
        if (registry == address(0) || borrower == address(0) || lender == address(0) || borrowAsset == address(0)) {
            revert SettlementMatchLib__ZeroAddress();
        }
        if (amount == 0) revert SettlementMatchLib__InvalidAmount();

        // 1) Asset whitelist + permissions.
        _checkAssetWhitelist(registry, borrowAsset);
        _requireRole(registry, ActionKeys.ACTION_ORDER_CREATE, address(this));

        // 2) Collateral top-up during match is NOT supported (strict architecture).
        if (collateralAsset != address(0) || collateralAmount != 0) {
            revert SettlementMatchLib__CollateralTopUpNotSupported();
        }

        // 3) Pull funds from the lender pool vault to this contract.
        address pool = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_LENDER_POOL_VAULT);
        ILenderPoolVault(pool).transferOut(borrowAsset, address(this), amount);

        // 4) Write debt via the canonical VaultCore entrypoint.
        address vaultCore = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
        IVaultCoreBorrowFor(vaultCore).borrowFor(borrower, borrowAsset, amount, termDays);

        // 5) Create the loan order. LoanNFT + Reward + DataPush are handled by LendingEngine.
        IOrderEngine.LoanOrder memory order = IOrderEngine.LoanOrder({
            principal: amount,
            rate: rateBps,
            // SSOT (time refactor): term is measured in blocks, not seconds.
            term: TermBlocksLib.termDaysToBlocks(termDays),
            borrower: borrower,
            lender: lender,
            asset: borrowAsset,
            startTimestamp: 0,
            maturity: 0,
            repaidAmount: 0
        });
        address orderEngine = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        orderId = IOrderEngine(orderEngine).createLoanOrder(order);

        // 6) Distribute borrow fees (FeeRouter pulls from msg.sender and refunds any remaining to msg.sender).
        // Use balance-delta as the SSOT net amount to avoid rounding drift across fee implementations.
        address feeRouter = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_FR);
        uint256 balBefore = IERC20(borrowAsset).balanceOf(address(this));
        // Approve FeeRouter to pull the requested amount for this distribution.
        IERC20(borrowAsset).forceApprove(feeRouter, amount);
        IFeeRouter(feeRouter).distributeNormal(borrowAsset, amount);

        // 7) Forward the net amount to the borrower: net = refundedRemaining computed via balance-delta.
        // FeeRouter behavior: transferFrom(msg.sender, amount) then transfer remaining back to msg.sender.
        // Therefore: balAfter = balBefore - amount + remaining => remaining = balAfter + amount - balBefore.
        uint256 balAfter = IERC20(borrowAsset).balanceOf(address(this));
        uint256 netAmount = balAfter + amount - balBefore;
        if (netAmount > 0) {
            IERC20(borrowAsset).safeTransfer(borrower, netAmount);
        }
    }
}



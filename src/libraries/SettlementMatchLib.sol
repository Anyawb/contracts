// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IAssetWhitelist } from "../interfaces/IAssetWhitelist.sol";
import { ICollateralManager } from "../interfaces/ICollateralManager.sol";
import { ILendingEngine } from "../interfaces/ILendingEngine.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { IFeeRouter } from "../interfaces/IFeeRouter.sol";

/// @title SettlementMatchLib
/// @notice 资金拨付与账本/订单落地的一体化原子流程（由业务层调用）
library SettlementMatchLib {
    using SafeERC20 for IERC20;

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    error Settlement__ZeroAddress();
    error Settlement__InvalidAmount();
    error Settlement__AssetNotAllowed();

    /*━━━━━━━━━━━━━━━ INTERNAL HELPERS ━━━━━━━━━━━━━━━*/
    function _requireRole(address registry, bytes32 actionKey, address user) private view {
        if (registry == address(0)) revert Settlement__ZeroAddress();
        address acmAddr = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    function _checkAssetWhitelist(address registry, address asset) private view {
        address wl = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_ASSET_WHITELIST);
        if (wl != address(0) && !IAssetWhitelist(wl).isAssetAllowed(asset)) revert Settlement__AssetNotAllowed();
    }

    /*━━━━━━━━━━━━━━━ API ━━━━━━━━━━━━━━━*/
    /// @notice 仅执行账本+订单（保留旧行为：直接将金额拨付给借款人，不扣除借款费）
    /// @notice 原子完成：抵押（可选）→ 放款拨付 → 债务记账 → 订单落地（LoanNFT+Reward+DataPush）
    /// @param registry Registry地址
    /// @param borrower 借款人
    /// @param lender 出借人
    /// @param collateralAsset 抵押资产（可为零地址，表示已预先抵押）
    /// @param collateralAmount 抵押数量
    /// @param borrowAsset 借款资产（资金池资产）
    /// @param amount 借款金额
    /// @param termDays 借款期限（天）
    /// @param rateBps 利率（bps）
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
            revert Settlement__ZeroAddress();
        }
        if (amount == 0) revert Settlement__InvalidAmount();

        // 1) 白名单与权限（撮合入口需具备订单创建专用权限，用于 createLoanOrder）
        _checkAssetWhitelist(registry, borrowAsset);
        // 注意：这里使用 address(this) 确保校验的是撮合/编排入口合约自身（如 VaultBusinessLogic），
        // 而不是外部发起者 EOA，符合“仅授予撮合入口”的长期权限形态。
        _requireRole(registry, ActionKeys.ACTION_ORDER_CREATE, address(this));

        // 2) 可选：补充抵押
        if (collateralAsset != address(0) && collateralAmount > 0) {
            address cm = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_CM);
            // 由业务层确保资产已在本合约持有；这里直接转存到 CollateralManager
            IERC20(collateralAsset).forceApprove(cm, collateralAmount);
            ICollateralManager(cm).depositCollateral(borrower, collateralAsset, collateralAmount);
        }

        // 3) 资金拨付：从业务层合约余额划转给借款人（出借人资金应已先入池）
        IERC20(borrowAsset).safeTransfer(borrower, amount);

        // 4) 债务记账：通过 VaultCore 统一入口写入账本（命中 onlyVaultCore）
        address vaultCore = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
        // 调用 VaultCoreRefactored.borrowFor(borrower, asset, amount, termDays)
        (bool ok, bytes memory ret) = vaultCore.call(abi.encodeWithSignature(
            "borrowFor(address,address,uint256,uint16)",
            borrower,
            borrowAsset,
            amount,
            termDays
        ));
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }

        // 5) 订单落地：LoanNFT + Reward + DataPush 由 core/LendingEngine 统一完成
        ILendingEngine.LoanOrder memory order = ILendingEngine.LoanOrder({
            principal: amount,
            rate: rateBps,
            term: uint256(termDays) * 1 days,
            borrower: borrower,
            lender: lender,
            asset: borrowAsset,
            startTimestamp: 0,
            maturity: 0,
            repaidAmount: 0
        });
        address orderEngine = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        orderId = ILendingEngine(orderEngine).createLoanOrder(order);
    }

    /// @notice 完整编排：账本写入 → 创建订单 → 借款手续费分发 → 借方收取净额
    /// @dev 与 UserFlow 对齐：借方实际收到净额；事件/推送统一由 LendingEngine 负责
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
            revert Settlement__ZeroAddress();
        }
        if (amount == 0) revert Settlement__InvalidAmount();

        // 1) 白名单与权限
        _checkAssetWhitelist(registry, borrowAsset);
        _requireRole(registry, ActionKeys.ACTION_ORDER_CREATE, address(this));

        // 2) 可选抵押
        if (collateralAsset != address(0) && collateralAmount > 0) {
            address cm = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_CM);
            IERC20(collateralAsset).forceApprove(cm, collateralAmount);
            ICollateralManager(cm).depositCollateral(borrower, collateralAsset, collateralAmount);
        }

        // 3) 账本写入（统一 VaultCore 入口）
        address vaultCore = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
        (bool ok, bytes memory ret) = vaultCore.call(abi.encodeWithSignature(
            "borrowFor(address,address,uint256,uint16)",
            borrower,
            borrowAsset,
            amount,
            termDays
        ));
        if (!ok) {
            assembly { revert(add(ret, 0x20), mload(ret)) }
        }

        // 4) 创建订单（由 LendingEngine 统一发 LOAN_* + NFT + Reward + DataPush）
        ILendingEngine.LoanOrder memory order = ILendingEngine.LoanOrder({
            principal: amount,
            rate: rateBps,
            term: uint256(termDays) * 1 days,
            borrower: borrower,
            lender: lender,
            asset: borrowAsset,
            startTimestamp: 0,
            maturity: 0,
            repaidAmount: 0
        });
        address orderEngine = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_ORDER_ENGINE);
        orderId = ILendingEngine(orderEngine).createLoanOrder(order);

        // 5) 借款手续费分发（FeeRouter 从 msg.sender 拉取，再返还剩余给 msg.sender）
        address feeRouter = IRegistry(registry).getModuleOrRevert(ModuleKeys.KEY_FR);
        // 先授权 FeeRouter 可拉取本次金额
        IERC20(borrowAsset).forceApprove(feeRouter, amount);
        IFeeRouter(feeRouter).distributeNormal(borrowAsset, amount);

        // 6) 将净额转给借方：净额 = amount - platform - eco
        uint256 platformBps = IFeeRouter(feeRouter).getPlatformFeeBps();
        uint256 ecoBps = IFeeRouter(feeRouter).getEcosystemFeeBps();
        uint256 platformAmt = (amount * platformBps) / 1e4;
        uint256 ecoAmt = (amount * ecoBps) / 1e4;
        uint256 netAmount = amount - platformAmt - ecoAmt;
        if (netAmount > 0) {
            IERC20(borrowAsset).safeTransfer(borrower, netAmount);
        }
    }
}



// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ViewConstants } from "../../view/ViewConstants.sol";

import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { ILiquidationEventsView } from "../../../interfaces/ILiquidationEventsView.sol";
import { ILiquidationManager } from "../../../interfaces/ILiquidationManager.sol";
import { ZeroAddress, AmountIsZero, ArrayLengthMismatch, EmptyArray } from "../../../errors/StandardErrors.sol";

/// @title LiquidationManager
/// @notice 方案A 唯一清算入口：写入直达账本（CM 托管抵押 + LE 托管债务），并在成功后单点推送到 LiquidatorView
/// @dev 不再写链上清算记录/统计/奖励子模块；链下通过 DataPush 事件聚合统计（架构指南口径）
contract LiquidationManager is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILiquidationManager
{
    /// @notice Registry 地址（公开变量遵循 *Var 命名）
    address public registryAddrVar;

    /// @notice 推送失败事件（链下重试/告警）
    /// @param user 目标用户
    /// @param asset 关联资产（此处使用 collateralAsset 作为索引资产）
    /// @param viewAddr 视图合约地址（可能为 0）
    /// @param collateral 本次推送的抵押数量
    /// @param debt 本次推送的债务数量
    /// @param reason 失败原因（revert data，如有）
    event CacheUpdateFailed(address indexed user, address indexed asset, address viewAddr, uint256 collateral, uint256 debt, bytes reason);

    error LiquidationManager__BatchTooLarge(uint256 provided, uint256 max);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        registryAddrVar = initialRegistryAddr;
    }

    /* ============ Core (Direct Ledger) ============ */

    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external override whenNotPaused nonReentrant {
        if (targetUser == address(0) || collateralAsset == address(0) || debtAsset == address(0)) revert ZeroAddress();
        if (collateralAmount == 0 || debtAmount == 0) revert AmountIsZero();

        _requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender);

        address cm = Registry(registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_CM);
        address le = Registry(registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_LE);

        // 1) 扣押抵押（方案A：CM 作为资金池，扣押并将真实抵押资产直接转给清算人）
        ICollateralManager(cm).withdrawCollateralTo(targetUser, collateralAsset, collateralAmount, msg.sender);

        // 2) 清算减债（LE 内部校验 ACTION_LIQUIDATE；注意 caller = 本合约地址，因此部署时需授予本合约 ACTION_LIQUIDATE）
        ILendingEngineBasic(le).forceReduceDebt(targetUser, debtAsset, debtAmount);

        // 3) 单点推送（最佳努力：失败不回滚，发事件供链下重试）
        _pushSingle(targetUser, collateralAsset, debtAsset, collateralAmount, debtAmount, msg.sender, bonus);
    }

    function batchLiquidate(
        address[] calldata targetUsers,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        uint256[] calldata bonuses
    ) external override whenNotPaused nonReentrant {
        uint256 len = targetUsers.length;
        if (len == 0) revert EmptyArray();
        if (
            len != collateralAssets.length ||
            len != debtAssets.length ||
            len != collateralAmounts.length ||
            len != debtAmounts.length ||
            len != bonuses.length
        ) {
            revert ArrayLengthMismatch(len, collateralAssets.length);
        }
        if (len > ViewConstants.MAX_BATCH_SIZE) revert LiquidationManager__BatchTooLarge(len, ViewConstants.MAX_BATCH_SIZE);

        _requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender);

        address cm = Registry(registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_CM);
        address le = Registry(registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_LE);

        for (uint256 i = 0; i < len; ) {
            address u = targetUsers[i];
            address cAsset = collateralAssets[i];
            address dAsset = debtAssets[i];
            uint256 cAmt = collateralAmounts[i];
            uint256 dAmt = debtAmounts[i];

            if (u == address(0) || cAsset == address(0) || dAsset == address(0)) revert ZeroAddress();
            if (cAmt == 0 || dAmt == 0) revert AmountIsZero();

            ICollateralManager(cm).withdrawCollateralTo(u, cAsset, cAmt, msg.sender);
            ILendingEngineBasic(le).forceReduceDebt(u, dAsset, dAmt);

            unchecked { ++i; }
        }

        _pushBatch(
            targetUsers,
            collateralAssets,
            debtAssets,
            collateralAmounts,
            debtAmounts,
            msg.sender,
            bonuses
        );
    }

    /* ============ Admin ============ */

    function pause() external {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        _pause();
    }

    function unpause() external {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        _unpause();
    }

    /* ============ UUPS ============ */

    function _authorizeUpgrade(address newImplementation) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    /* ============ Internal helpers ============ */

    function _requireRole(bytes32 actionKey, address caller) internal view {
        address acmAddr = Registry(registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, caller);
    }

    function _pushSingle(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        address liquidator,
        uint256 bonus
    ) internal {
        // Note: use getModule (non-revert) so ledger writes do not fail when view is missing.
        address viewAddr = Registry(registryAddrVar).getModule(ModuleKeys.KEY_LIQUIDATION_VIEW);
        if (viewAddr == address(0) || viewAddr.code.length == 0) {
            emit CacheUpdateFailed(user, collateralAsset, viewAddr, collateralAmount, debtAmount, bytes("view unavailable"));
            return;
        }

        try ILiquidationEventsView(viewAddr).pushLiquidationUpdate(
            user,
            collateralAsset,
            debtAsset,
            collateralAmount,
            debtAmount,
            liquidator,
            bonus,
            block.timestamp
        ) {
            // ok
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(user, collateralAsset, viewAddr, collateralAmount, debtAmount, reason);
        }
    }

    function _pushBatch(
        address[] calldata users,
        address[] calldata collateralAssets,
        address[] calldata debtAssets,
        uint256[] calldata collateralAmounts,
        uint256[] calldata debtAmounts,
        address liquidator,
        uint256[] calldata bonuses
    ) internal {
        address viewAddr = Registry(registryAddrVar).getModule(ModuleKeys.KEY_LIQUIDATION_VIEW);
        if (viewAddr == address(0) || viewAddr.code.length == 0) {
            // emit first item as representative payload (best effort)
            emit CacheUpdateFailed(
                users[0],
                collateralAssets[0],
                viewAddr,
                collateralAmounts[0],
                debtAmounts[0],
                bytes("view unavailable")
            );
            return;
        }

        try ILiquidationEventsView(viewAddr).pushBatchLiquidationUpdate(
            users,
            collateralAssets,
            debtAssets,
            collateralAmounts,
            debtAmounts,
            liquidator,
            bonuses,
            block.timestamp
        ) {
            // ok
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(
                users[0],
                collateralAssets[0],
                viewAddr,
                collateralAmounts[0],
                debtAmounts[0],
                reason
            );
        }
    }
}


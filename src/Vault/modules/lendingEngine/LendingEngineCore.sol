// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { IRewardManager } from "../../../interfaces/IRewardManager.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { IVaultView } from "../../../interfaces/IVaultView.sol";
import { HealthFactorLib } from "../../../libraries/HealthFactorLib.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { Registry } from "../../../registry/Registry.sol";
import { LendingEngineStorage } from "./LendingEngineStorage.sol";
import { LendingEngineAccounting } from "./LendingEngineAccounting.sol";

/// @notice Minimal interface to resolve VaultView through VaultCore
interface IVaultCoreMinimal {
    function viewContractAddrVar() external view returns (address);
}

/// @notice Minimal interface for HealthView
interface IHealthViewMinimal {
    function pushRiskStatus(address user, uint256 healthFactorBps, uint256 minHealthFactorBps, bool undercollateralized, uint256 timestamp) external;
}

/// @notice Core orchestration helpers for VaultLendingEngine
library LendingEngineCore {
    using LendingEngineStorage for LendingEngineStorage.Layout;
    using LendingEngineAccounting for LendingEngineStorage.Layout;

    /// @notice 缓存推送失败事件，用于链下重试
    event CacheUpdateFailed(address indexed user, address indexed asset, address viewAddr, uint256 collateral, uint256 debt, bytes reason);
    /// @notice 健康状态推送失败事件（与指南一致，便于链下监控）
    event HealthPushFailed(address indexed user, address indexed healthView, uint256 totalCollateral, uint256 totalDebt, bytes reason);

    /// @notice 借款主流程（账本落账 + View/Health 推送 + 奖励）
    function borrow(LendingEngineStorage.Layout storage s, address user, address asset, uint256 amount) internal {
        s.recordBorrow(user, asset, amount);
        _pushUserPositionToView(s, user, asset);
        _pushHealthStatus(s, user);
        _notifyRewardManager(s, user, amount);
    }

    /// @notice 还款主流程
    function repay(LendingEngineStorage.Layout storage s, address user, address asset, uint256 amount) internal {
        s.recordRepay(user, asset, amount);
        _pushUserPositionToView(s, user, asset);
        _pushHealthStatus(s, user);
        _notifyRewardManager(s, user, amount);
    }

    /// @notice 清算减债主流程
    function forceReduceDebt(LendingEngineStorage.Layout storage s, address user, address asset, uint256 amount) internal {
        _requireRole(s, ActionKeys.ACTION_LIQUIDATE, msg.sender);
        s.recordForceReduceDebt(user, asset, amount);
        _pushUserPositionToView(s, user, asset);
        _pushHealthStatus(s, user);
    }

    /// @notice 获取模块地址（带缓存）
    function _getModuleAddress(LendingEngineStorage.Layout storage s, bytes32 moduleKey) internal view returns (address) {
        return Registry(s._registryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 权限校验内部函数
    function _requireRole(LendingEngineStorage.Layout storage s, bytes32 actionKey, address user) internal view {
        address acmAddr = _getModuleAddress(s, ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /// @notice 奖励通知（最佳努力，不影响主流程）
    function _notifyRewardManager(LendingEngineStorage.Layout storage s, address user, uint256 amount) internal {
        address rewardManager;
        try Registry(s._registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_V1) returns (address addr) {
            rewardManager = addr;
        } catch {
            return;
        }

        try IRewardManager(rewardManager).onLoanEvent(user, amount, 0, true) {
            // ignore
        } catch {
            // ignore reward failure
        }
    }

    /// @notice 推送用户仓位到 View 缓存
    function _pushUserPositionToView(LendingEngineStorage.Layout storage s, address user, address asset) internal {
        address cm = _getModuleAddress(s, ModuleKeys.KEY_CM);
        address viewAddr = _resolveVaultViewAddr(s);

        uint256 collateral;
        uint256 debt = s._userDebt[user][asset];

        // 依赖缺失时直接记录事件并返回，留给链下重试
        if (cm == address(0) || viewAddr == address(0)) {
            emit CacheUpdateFailed(user, asset, viewAddr, collateral, debt, bytes("view or cm unavailable"));
            return;
        }
        if (cm.code.length == 0 || viewAddr.code.length == 0) {
            emit CacheUpdateFailed(user, asset, viewAddr, collateral, debt, bytes("view or cm no code"));
            return;
        }

        // 尝试读取账本，失败则发事件并返回
        try ICollateralManager(cm).getCollateral(user, asset) returns (uint256 c) {
            collateral = c;
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(user, asset, viewAddr, collateral, debt, reason);
            return;
        }

        // 尝试推送到 View，失败记录事件，不阻断主流程
        try IVaultView(viewAddr).pushUserPositionUpdate(user, asset, collateral, debt) {
            // success
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(user, asset, viewAddr, collateral, debt, reason);
        }
    }

    /// @notice 解析当前有效的 VaultView 地址（通过 Registry -> VaultCore）
    function _resolveVaultViewAddr(LendingEngineStorage.Layout storage s) internal view returns (address) {
        address vaultCore = _getModuleAddress(s, ModuleKeys.KEY_VAULT_CORE);
        require(vaultCore != address(0), "vaultCore zero in resolveView");
        address viewAddr = IVaultCoreMinimal(vaultCore).viewContractAddrVar();
        require(viewAddr != address(0), "viewContractAddrVar returned zero");
        return viewAddr;
    }

    /// @notice 汇总用户总抵押与总债务，并推送健康状态到 HealthView
    function _pushHealthStatus(LendingEngineStorage.Layout storage s, address user) internal {
        address cm = _getModuleAddress(s, ModuleKeys.KEY_CM);
        address lrm = _getModuleAddress(s, ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        address hv = _getModuleAddress(s, ModuleKeys.KEY_HEALTH_VIEW);

        // 缺失依赖时发事件并返回（最佳努力，不阻断账本）
        if (cm == address(0) || lrm == address(0) || hv == address(0)) {
            emit CacheUpdateFailed(user, address(0), hv, 0, s._userTotalDebtValue[user], bytes("health push deps missing"));
            emit HealthPushFailed(user, hv, 0, s._userTotalDebtValue[user], bytes("health push deps missing"));
            return;
        }
        if (cm.code.length == 0 || hv.code.length == 0 || lrm.code.length == 0) {
            emit CacheUpdateFailed(user, address(0), hv, 0, s._userTotalDebtValue[user], bytes("health push code missing"));
            emit HealthPushFailed(user, hv, 0, s._userTotalDebtValue[user], bytes("health push code missing"));
            return;
        }

        uint256 totalDebt = s._userTotalDebtValue[user];
        uint256 totalCollateral = 0;
        try ICollateralManager(cm).getUserTotalCollateralValue(user) returns (uint256 v) {
            totalCollateral = v;
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(user, address(0), hv, totalCollateral, totalDebt, reason);
            emit HealthPushFailed(user, hv, totalCollateral, totalDebt, reason);
            return;
        }

        if (user == address(0)) {
            emit CacheUpdateFailed(user, address(0), hv, totalCollateral, totalDebt, bytes("user zero in pushHealthStatus"));
            emit HealthPushFailed(user, hv, totalCollateral, totalDebt, bytes("user zero in pushHealthStatus"));
            return;
        }

        uint256 minHFBps = ILiquidationRiskManager(lrm).getMinHealthFactor();
        bool under = HealthFactorLib.isUnderCollateralized(totalCollateral, totalDebt, minHFBps);
        uint256 hfBps = HealthFactorLib.calcHealthFactor(totalCollateral, totalDebt);

        if (totalDebt > 0 && hfBps > type(uint256).max / 2) {
            emit CacheUpdateFailed(user, address(0), hv, totalCollateral, totalDebt, bytes("hfBps overflow risk"));
            emit HealthPushFailed(user, hv, totalCollateral, totalDebt, bytes("hfBps overflow risk"));
            return;
        }

        // 最佳努力推送 HealthView，失败发事件不回滚
        try IHealthViewMinimal(hv).pushRiskStatus(user, hfBps, minHFBps, under, block.timestamp) {
            // success
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(user, address(0), hv, totalCollateral, totalDebt, reason);
            emit HealthPushFailed(user, hv, totalCollateral, totalDebt, reason);
        }
    }
}


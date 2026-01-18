// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ICollateralManager } from "../../../interfaces/ICollateralManager.sol";
import { HealthFactorLib } from "../../../libraries/HealthFactorLib.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { IPositionView } from "../../../interfaces/IPositionView.sol";
import { IPositionViewValuation } from "../../../interfaces/IPositionViewValuation.sol";
import { IVaultCoreDataPush } from "../../../interfaces/IVaultCoreDataPush.sol";
import { IVaultCoreMinimal } from "../../../interfaces/IVaultCoreMinimal.sol";
import { Registry } from "../../../registry/Registry.sol";
import { LendingEngineStorage } from "./LendingEngineStorage.sol";
import { LendingEngineAccounting } from "./LendingEngineAccounting.sol";

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
    /// @param termDays 借款期限（天），用于 Reward 模块的 duration 计算；0 表示未知/不计分
    function borrow(
        LendingEngineStorage.Layout storage s,
        address user,
        address asset,
        uint256 amount,
        uint16 termDays
    ) internal {
        termDays; // silence unused (Reward is handled by ORDER_ENGINE only)
        s.recordBorrow(user, asset, amount);
        // IMPORTANT (Architecture-Guide):
        // - Stats is delta-based (multi-asset compatible) and MUST NOT depend on View cache freshness.
        // - Time-travel (or long gaps) can expire PositionView cache; relying on absolute snapshots can miss debt deltas.
        // Therefore we push the debt delta directly (collateral delta is 0 here).
        _pushDebtDeltaToView(s, user, asset, _toInt(amount));
        _pushHealthStatus(s, user);
        // Reward:
        // - VaultLendingEngine 不具备 “按期/足额还清” 的订单语义（maturity/outcome），不能安全地触发积分释放/扣罚。
        // - 积分系统唯一路径以 ORDER_ENGINE(core/LendingEngine) 落账后的回调为准（见 Architecture-Guide）。
    }

    /// @notice 还款主流程
    function repay(LendingEngineStorage.Layout storage s, address user, address asset, uint256 amount) internal {
        s.recordRepay(user, asset, amount);
        // Push debt delta (repay reduces principal debt).
        _pushDebtDeltaToView(s, user, asset, -_toInt(amount));
        _pushHealthStatus(s, user);
        // Reward: 同上（VaultLendingEngine 不触发 RewardManager）。
    }

    /// @notice 清算减债主流程
    function forceReduceDebt(LendingEngineStorage.Layout storage s, address user, address asset, uint256 amount) internal {
        _requireRole(s, ActionKeys.ACTION_LIQUIDATE, msg.sender);
        s.recordForceReduceDebt(user, asset, amount);
        _pushDebtDeltaToView(s, user, asset, -_toInt(amount));
        _pushHealthStatus(s, user);
    }

    /// @notice 获取模块地址（严格模式：缺失则 revert）
    function _getModuleAddress(LendingEngineStorage.Layout storage s, bytes32 moduleKey) internal view returns (address) {
        return Registry(s._registryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 获取模块地址（宽松模式：缺失/registry 异常则返回 0）
    /// @dev 用于 View/Cache 推送链路，遵循“best effort，不阻断账本”
    function _getModuleAddressOrZero(LendingEngineStorage.Layout storage s, bytes32 moduleKey) internal view returns (address) {
        // registryAddr 未配置或不是合约时，直接返回 0
        if (s._registryAddr == address(0) || s._registryAddr.code.length == 0) return address(0);
        // 架构指南要求：统一通过 Registry.getModuleOrRevert(KEY_VAULT_CORE) 解析 View 地址；
        // 但在“推送链路”中必须 best-effort：因此用 try/catch 吃掉 revert 并返回 0。
        try Registry(s._registryAddr).getModuleOrRevert(moduleKey) returns (address addr) {
            return addr;
        } catch {
            return address(0);
        }
    }

    /// @notice 权限校验内部函数
    function _requireRole(LendingEngineStorage.Layout storage s, bytes32 actionKey, address user) internal view {
        address acmAddr = _getModuleAddress(s, ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    // NOTE: _notifyRewardManager 已移除。Reward 仅由 ORDER_ENGINE(core/LendingEngine) 触发。

    /// @notice Push debt delta to View (via VaultCore -> VaultRouter -> PositionView).
    /// @dev This keeps both PositionView and StatisticsView consistent in a delta-based (multi-asset) manner,
    ///      and does NOT depend on PositionView cache freshness (CACHE_DURATION).
    function _pushDebtDeltaToView(
        LendingEngineStorage.Layout storage s,
        address user,
        address asset,
        int256 debtDelta
    ) internal {
        address vaultCore = _getModuleAddressOrZero(s, ModuleKeys.KEY_VAULT_CORE);
        address viewAddr = address(0);
        if (vaultCore != address(0) && vaultCore.code.length != 0) {
            try IVaultCoreMinimal(vaultCore).viewContractAddrVar() returns (address v) {
                viewAddr = v;
            } catch {
                // best effort
            }
        }

        if (vaultCore == address(0) || vaultCore.code.length == 0) {
            emit CacheUpdateFailed(user, asset, viewAddr, 0, s._userDebt[user][asset], bytes("vaultCore unavailable"));
            return;
        }

        uint64 nextVersion = _getNextVersion(s, user, asset);
        try IVaultCoreDataPush(vaultCore).pushUserPositionUpdateDelta(user, asset, int256(0), debtDelta, bytes32(0), 0, nextVersion) {
            // ok
        } catch (bytes memory reason) {
            // Best-effort: never block ledger.
            emit CacheUpdateFailed(user, asset, viewAddr, 0, s._userDebt[user][asset], reason);
        }
    }

    function _getNextVersion(
        LendingEngineStorage.Layout storage s,
        address user,
        address asset
    ) internal view returns (uint64) {
        // View 推送链路：PositionView 缺失时不回滚（best effort）
        address positionView = _getModuleAddressOrZero(s, ModuleKeys.KEY_POSITION_VIEW);
        if (positionView == address(0) || positionView.code.length == 0) return 0;
        try IPositionView(positionView).getPositionVersion(user, asset) returns (uint64 version) {
            unchecked {
                return version + 1;
            }
        } catch {
            return 0;
        }
    }

    function _toInt(uint256 value) internal pure returns (int256) {
        if (value > uint256(type(int256).max)) revert("amount overflow int256");
        return int256(value);
    }

    /// @notice 汇总用户总抵押与总债务，并推送健康状态到 HealthView
    function _pushHealthStatus(LendingEngineStorage.Layout storage s, address user) internal {
        // 健康推送属于 View/缓存链路：必须 best-effort，不阻断账本
        address lrm = _getModuleAddressOrZero(s, ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        address hv = _getModuleAddressOrZero(s, ModuleKeys.KEY_HEALTH_VIEW);
        address pv = _getModuleAddressOrZero(s, ModuleKeys.KEY_POSITION_VIEW);

        uint256 totalDebt = s._userTotalDebtValue[user];

        // 缺失依赖时发事件并返回（最佳努力）
        if (pv == address(0) || lrm == address(0) || hv == address(0) || pv.code.length == 0 || hv.code.length == 0 || lrm.code.length == 0) {
            emit CacheUpdateFailed(user, address(0), hv, 0, totalDebt, bytes("health push deps missing"));
            emit HealthPushFailed(user, hv, 0, totalDebt, bytes("health push deps missing"));
            return;
        }

        uint256 totalCollateral = 0;
        try IPositionViewValuation(pv).getUserTotalCollateralValue(user) returns (uint256 v) {
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

        uint256 minHFBps;
        try ILiquidationRiskManager(lrm).getMinHealthFactor() returns (uint256 v) {
            minHFBps = v;
        } catch (bytes memory reason) {
            emit CacheUpdateFailed(user, address(0), hv, totalCollateral, totalDebt, reason);
            emit HealthPushFailed(user, hv, totalCollateral, totalDebt, reason);
            return;
        }

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


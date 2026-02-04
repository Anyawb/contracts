// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { HealthFactorLib } from "../../../libraries/HealthFactorLib.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { IPositionView } from "../../../interfaces/IPositionView.sol";
import { IPositionViewValuation } from "../../../interfaces/IPositionViewValuation.sol";
import { IVaultCoreDataPush } from "../../../interfaces/IVaultCoreDataPush.sol";
import { IVaultCoreMinimal } from "../../../interfaces/IVaultCoreMinimal.sol";
import { Registry } from "../../../registry/Registry.sol";
import { CacheEvents } from "../../CacheEvents.sol";
import { HealthEvents } from "../../HealthEvents.sol";
import { LendingEngineStorage } from "./LendingEngineStorage.sol";
import { LendingEngineAccounting } from "./LendingEngineAccounting.sol";

/// @notice Minimal interface for HealthView
interface IHealthViewMinimal {
    function pushRiskStatus(
        address user,
        uint256 healthFactorBps,
        uint256 minHealthFactorBps,
        bool undercollateralized,
        uint256 blockNumber
    ) external;
}

/// @notice Core orchestration helpers for VaultLendingEngine
library LendingEngineCore {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/
    /// @notice Amount cannot be represented as int256.
    error LendingEngineCore__AmountOverflowInt256();

    using LendingEngineStorage for LendingEngineStorage.Layout;
    using LendingEngineAccounting for LendingEngineStorage.Layout;

    // NOTE: CacheUpdateFailed is declared in CacheEvents (SSOT) and is emitted via the qualified name
    // `CacheEvents.CacheUpdateFailed(...)` below. Libraries cannot inherit interfaces.
    // NOTE: HealthPushFailed is declared in HealthEvents (SSOT) and is emitted via the qualified name
    // `HealthEvents.HealthPushFailed(...)` below. Libraries cannot inherit interfaces.

    /**
     * @notice Borrow orchestration: record debt, then best-effort push View/Health updates.
     * @dev Reverts if:
     *      - underlying accounting reverts (e.g., AmountIsZero / ZeroAddress) (propagated)
     *      - amount cannot be represented as int256 (LendingEngineCore__AmountOverflowInt256)
     *
     * Security:
     * - Ledger SSOT: debt is recorded first; cache pushes are best-effort and must not block the ledger.
     * - Reward is NOT triggered here. Reward SSOT is ORDER_ENGINE (core/LendingEngine) callbacks after settlement.
     *
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @param amount Borrow amount (token decimals).
     * @param termDays Loan term in days (used by higher-level flows; 0 = unknown / do-not-score).
     */
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
        // - Time-travel (or long gaps) can expire PositionView cache.
        // - Relying on absolute snapshots can miss debt deltas.
        // Therefore we push the debt delta directly (collateral delta is 0 here).
        _pushDebtDeltaToView(s, user, asset, _toInt(amount));
        _pushHealthStatus(s, user);
    }

    /**
     * @notice Repay orchestration: record repayment, then best-effort push View/Health updates.
     * @dev Reverts if:
     *      - underlying accounting reverts (e.g., Overpay / AmountIsZero / ZeroAddress) (propagated)
     *      - amount cannot be represented as int256 (LendingEngineCore__AmountOverflowInt256)
     *
     * Security:
     * - Ledger SSOT: repayment is recorded first; cache pushes are best-effort and must not block the ledger.
     * - Reward is NOT triggered here. Reward SSOT is ORDER_ENGINE (core/LendingEngine) callbacks after settlement.
     *
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @param amount Repay amount (token decimals).
     */
    function repay(LendingEngineStorage.Layout storage s, address user, address asset, uint256 amount) internal {
        s.recordRepay(user, asset, amount);
        // Push debt delta (repay reduces principal debt).
        _pushDebtDeltaToView(s, user, asset, -_toInt(amount));
        _pushHealthStatus(s, user);
    }

    /**
     * @notice Liquidation orchestration: record forced debt reduction, then best-effort push View/Health updates.
     * @dev Reverts if:
     *      - caller lacks ACTION_LIQUIDATE (via ACM.requireRole) (propagated)
     *      - underlying accounting reverts (e.g., AmountIsZero / ZeroAddress) (propagated)
     *      - amount cannot be represented as int256 (LendingEngineCore__AmountOverflowInt256)
     *
     * Security:
     * - Role-gated by ACTION_LIQUIDATE (ledger write path).
     * - Cache pushes are best-effort and must not block the ledger.
     *
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     * @param asset Debt asset address.
     * @param amount Debt reduction amount (token decimals).
     */
    function forceReduceDebt(
        LendingEngineStorage.Layout storage s,
        address user,
        address asset,
        uint256 amount
    ) internal {
        _requireRole(s, ActionKeys.ACTION_LIQUIDATE, msg.sender);
        s.recordForceReduceDebt(user, asset, amount);
        _pushDebtDeltaToView(s, user, asset, -_toInt(amount));
        _pushHealthStatus(s, user);
    }

    /**
     * @notice Resolve a module address via Registry (strict).
     * @dev Reverts if:
     *      - Registry.getModuleOrRevert(moduleKey) reverts (propagated)
     *
     * Security:
     * - SSOT: module address resolution MUST come from Registry.
     * - Use this strict variant for ledger-critical dependencies (authorization, invariants).
     *
     * @param s LendingEngine storage layout.
     * @param moduleKey Registry module key.
     * @return Module address.
     */
    function _getModuleAddress(
        LendingEngineStorage.Layout storage s,
        bytes32 moduleKey
    ) internal view returns (address) {
        return Registry(s._registryAddr).getModuleOrRevert(moduleKey);
    }

    /**
     * @notice Resolve a module address via Registry (best-effort; returns 0 on failure).
     * @dev Reverts if:
     *      - (none) - this function must not revert (best-effort)
     *
     * Security:
     * - Best-effort: used ONLY for View/Cache/observability push paths.
     * - Must not block the ledger on misconfiguration.
     *
     * @param s LendingEngine storage layout.
     * @param moduleKey Registry module key.
     * @return Module address, or address(0) if missing/unavailable.
     */
    function _getModuleAddressOrZero(
        LendingEngineStorage.Layout storage s,
        bytes32 moduleKey
    ) internal view returns (address) {
        // If Registry is not configured or not a contract, return 0.
        if (s._registryAddr == address(0) || s._registryAddr.code.length == 0) return address(0);
        // Architecture-Guide: runtime SSOT uses `Registry.getModuleOrRevert`.
        // For push paths we must be best-effort: swallow reverts and return 0.
        try Registry(s._registryAddr).getModuleOrRevert(moduleKey) returns (address addr) {
            return addr;
        } catch {
            return address(0);
        }
    }

    /**
     * @notice Require an ACM role via Registry -> AccessControlManager (strict).
     * @dev Reverts if:
     *      - KEY_ACCESS_CONTROL is not registered (propagated)
     *      - ACM.requireRole(actionKey, user) reverts (propagated)
     *
     * Security:
     * - Authorization SSOT is AccessControlManager (ACM).
     *
     * @param s LendingEngine storage layout.
     * @param actionKey Action key (bytes32, see ActionKeys).
     * @param user Address to check.
     */
    function _requireRole(LendingEngineStorage.Layout storage s, bytes32 actionKey, address user) internal view {
        address acmAddr = _getModuleAddress(s, ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

 

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
                // Best-effort: ignore view address resolution failure.
                user; // silence empty block
            }
        }

        if (vaultCore == address(0) || vaultCore.code.length == 0) {
            emit CacheEvents.CacheUpdateFailed(
                user,
                asset,
                viewAddr,
                0,
                s._userDebt[user][asset],
                bytes("vaultCore unavailable")
            );
            return;
        }

        uint64 nextVersion = _getNextVersion(s, user, asset);
        try IVaultCoreDataPush(vaultCore).pushUserPositionUpdateDelta(
            user,
            asset,
            int256(0),
            debtDelta,
            bytes32(0),
            0,
            nextVersion
        ) {
            // Best-effort: ignore push success value.
            user; // silence empty block
        } catch (bytes memory reason) {
            // Best-effort: never block ledger.
            emit CacheEvents.CacheUpdateFailed(
                user,
                asset,
                viewAddr,
                0,
                s._userDebt[user][asset],
                reason
            );
        }
    }

    function _getNextVersion(
        LendingEngineStorage.Layout storage s,
        address user,
        address asset
    ) internal view returns (uint64) {
        // View push path: best-effort; do not revert if PositionView is missing.
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
        if (value > uint256(type(int256).max)) revert LendingEngineCore__AmountOverflowInt256();
        return int256(value);
    }

    /**
     * @notice Aggregate collateral/debt and best-effort push health status to HealthView.
     * @dev Reverts if:
     *      - (none) - this function must not revert (best-effort)
     *
     * Security:
     * - Best-effort push: failures emit `CacheUpdateFailed` and `HealthPushFailed` and DO NOT revert.
     * - Reads collateral from PositionView valuation and risk thresholds from LiquidationRiskManager.
     *
     * @param s LendingEngine storage layout.
     * @param user Borrower address.
     */
    function _pushHealthStatus(LendingEngineStorage.Layout storage s, address user) internal {
        // Health push is a View/Cache path: best-effort, never block the ledger.
        address lrm = _getModuleAddressOrZero(s, ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        address hv = _getModuleAddressOrZero(s, ModuleKeys.KEY_HEALTH_VIEW);
        address pv = _getModuleAddressOrZero(s, ModuleKeys.KEY_POSITION_VIEW);

        uint256 totalDebt = s._userTotalDebtValue[user];

        // Missing deps => emit events and return (best-effort).
        if (
            pv == address(0) ||
            lrm == address(0) ||
            hv == address(0) ||
            pv.code.length == 0 ||
            hv.code.length == 0 ||
            lrm.code.length == 0
        ) {
            emit CacheEvents.CacheUpdateFailed(user, address(0), hv, 0, totalDebt, bytes("health push deps missing"));
            emit HealthEvents.HealthPushFailed(user, hv, 0, totalDebt, bytes("health push deps missing"));
            return;
        }

        uint256 totalCollateral = 0;
        try IPositionViewValuation(pv).getUserTotalCollateralValue(user) returns (uint256 v) {
            totalCollateral = v;
        } catch (bytes memory reason) {
            emit CacheEvents.CacheUpdateFailed(user, address(0), hv, totalCollateral, totalDebt, reason);
            emit HealthEvents.HealthPushFailed(user, hv, totalCollateral, totalDebt, reason);
            return;
        }

        if (user == address(0)) {
            emit CacheEvents.CacheUpdateFailed(
                user,
                address(0),
                hv,
                totalCollateral,
                totalDebt,
                bytes("user zero in pushHealthStatus")
            );
            emit HealthEvents.HealthPushFailed(
                user,
                hv,
                totalCollateral,
                totalDebt,
                bytes("user zero in pushHealthStatus")
            );
            return;
        }

        uint256 minHFBps;
        try ILiquidationRiskManager(lrm).getMinHealthFactor() returns (uint256 v) {
            minHFBps = v;
        } catch (bytes memory reason) {
            emit CacheEvents.CacheUpdateFailed(user, address(0), hv, totalCollateral, totalDebt, reason);
            emit HealthEvents.HealthPushFailed(user, hv, totalCollateral, totalDebt, reason);
            return;
        }

        bool under = HealthFactorLib.isUnderCollateralized(totalCollateral, totalDebt, minHFBps);
        uint256 hfBps = HealthFactorLib.calcHealthFactor(totalCollateral, totalDebt);

        if (totalDebt > 0 && hfBps > type(uint256).max / 2) {
            emit CacheEvents.CacheUpdateFailed(
                user,
                address(0),
                hv,
                totalCollateral,
                totalDebt,
                bytes("hfBps overflow risk")
            );
            emit HealthEvents.HealthPushFailed(
                user,
                hv,
                totalCollateral,
                totalDebt,
                bytes("hfBps overflow risk")
            );
            return;
        }

        // Best-effort: push to HealthView; failures emit events and do NOT revert.
        // NOTE (Time-Dependency-Refactor): `blockNumber` is the field name in the HealthView push API.
        // Semantics in this repo: treat it as a time-axis marker (blockNumber), NOT unix time.
        uint256 blockNumber = block.number;
        try IHealthViewMinimal(hv).pushRiskStatus(user, hfBps, minHFBps, under, blockNumber) {
            user; // silence empty block
        } catch (bytes memory reason) {
            emit CacheEvents.CacheUpdateFailed(user, address(0), hv, totalCollateral, totalDebt, reason);
            emit HealthEvents.HealthPushFailed(user, hv, totalCollateral, totalDebt, reason);
        }
    }
}


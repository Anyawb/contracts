// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ModuleCache } from "./ModuleCache.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ILendingEngineBasic } from "../../../interfaces/ILendingEngineBasic.sol";
import { IPositionViewValuation } from "../../../interfaces/IPositionViewValuation.sol";
import { Registry } from "../../../registry/Registry.sol";

/**
 * @title Liquidation Risk Query Library
 * @author RWA Lending Platform
 * @notice Provides module resolution and user value aggregation functions for liquidation risk assessment.
 * @dev View-only library for querying user collateral/debt values from ledger modules (LendingEngine + PositionView).
 * @dev Architecture alignment: intentionally does NOT access oracle or implement graceful degradation;
 *      valuation (incl. GD) must be centralized in LendingEngine/PositionView.
 */
library LiquidationRiskQueryLib {
    using ModuleCache for ModuleCache.ModuleCacheStorage;

    /**
     * @notice Get module address from cache or Registry (view-only, graceful fallback).
     * @dev Reverts if:
     *      - None (view function, returns address(0) if module not found or registry is zero)
     *
     * Security:
     * - View function (read-only)
     * - Graceful degradation: falls back to Registry if cache is stale or missing
     * - Safe time rollback handling: treats cache as valid if block.timestamp < cached timestamp
     *
     * @param registryAddr Registry contract address (for fallback resolution)
     * @param moduleCache Module cache storage reference
     * @param key Module key identifier
     * @param maxCacheAge Maximum cache age in seconds (0 = cache always valid)
     * @return moduleAddr Module address (address(0) if not found)
     */
    function _getModuleView(
        address registryAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        bytes32 key,
        uint256 maxCacheAge
    ) private view returns (address moduleAddr) {
        // 1) Prefer cache if present and not stale.
        moduleAddr = moduleCache.moduleAddresses[key];
        uint256 ts = moduleCache.cacheTimestamps[key];
        if (moduleAddr != address(0) && ts != 0) {
            // If maxCacheAge == 0, treat cache as always valid.
            if (maxCacheAge == 0) return moduleAddr;
            // Safe time rollback handling: if time goes backwards, treat cache as valid to avoid underflow.
            // solhint-disable-next-line not-rely-on-time
            if (block.timestamp < ts) return moduleAddr;
            // solhint-disable-next-line not-rely-on-time
            if (block.timestamp - ts <= maxCacheAge) return moduleAddr;
        }

        // 2) Fallback to Registry (view-only) to avoid reverting due to cache staleness.
        if (registryAddr == address(0)) return address(0);
        moduleAddr = Registry(registryAddr).getModule(key);
    }

    /**
     * @notice Get user's aggregated collateral and debt values from ledger modules.
     * @dev Reverts if:
     *      - None (view function, gracefully handles module failures by returning zeros)
     *
     * Security:
     * - View function (read-only)
     * - Graceful degradation: returns (0, 0) if modules are not registered or calls fail
     * - Architecture alignment: does NOT access oracle or implement graceful degradation;
     *   valuation (incl. GD) must be centralized in LendingEngine/PositionView
     * - Uses try-catch to handle external call failures gracefully
     *
     * @param user User address to query
     * @param registryAddr Registry contract address for module resolution
     * @param moduleCache Module cache storage reference
     * @param maxCacheAge Maximum cache age in seconds (0 = cache always valid)
     * @return collateralValue Total collateral value (settlement token denominated, scaled by 1e18, 0 if query fails)
     * @return debtValue Total debt value (settlement token denominated, scaled by 1e18, 0 if query fails)
     */
    function getUserValues(
        address user,
        address registryAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        uint256 maxCacheAge
    ) internal view returns (uint256 collateralValue, uint256 debtValue) {
        address lendingEngine = _getModuleView(registryAddr, moduleCache, ModuleKeys.KEY_LE, maxCacheAge);
        address positionView = _getModuleView(registryAddr, moduleCache, ModuleKeys.KEY_POSITION_VIEW, maxCacheAge);

        if (lendingEngine == address(0) || positionView == address(0)) return (0, 0);

        // debt value (settlement token denominated; produced by LE valuation)
        try ILendingEngineBasic(lendingEngine).getUserTotalDebtValue(user) returns (uint256 v) {
            debtValue = v;
        } catch {
            debtValue = 0;
        }

        // collateral value (settlement token denominated; produced by PositionView valuation)
        try IPositionViewValuation(positionView).getUserTotalCollateralValue(user) returns (uint256 v) {
            collateralValue = v;
        } catch {
            collateralValue = 0;
        }
    }
}



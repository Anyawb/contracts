// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ModuleCache } from "./ModuleCache.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ILendingEngineDebtRead } from "../../../interfaces/ILendingEngineDebtRead.sol";
import { IPositionViewValuation } from "../../../interfaces/IPositionViewValuation.sol";
import { Registry } from "../../../registry/Registry.sol";

/**
 * @title LiquidationRiskQueryLib
 * @notice Provides best-effort liquidation risk queries and module resolution helpers.
 * @dev Reverts if:
 *      - see individual functions
 *
 * Security:
 * - View-only library for querying ledger modules (LendingEngine and PositionView).
 * - Uses try/catch to avoid reverting callers on downstream module failures.
 * - Does not access oracles or implement graceful degradation logic; valuation remains centralized in LendingEngine and PositionView.
 */
library LiquidationRiskQueryLib {
    using ModuleCache for ModuleCache.ModuleCacheStorage;

    /**
     * @notice Get module address from cache or Registry (view-only, graceful fallback).
     * @dev Reverts if:
     *      - none (returns address(0) on missing modules)
     *
     * Security:
     * - View function (read-only).
     * - Best-effort: falls back to Registry if cache is stale or missing.
     * - Time-Dependency-Refactor SSOT: cache staleness is block-based (block.number), and rollback is irrelevant.
     *
     * @param registryAddr Registry contract address (for fallback resolution)
     * @param moduleCache Module cache storage reference
     * @param key Module key identifier
     * @param maxCacheAge Maximum cache age in blocks (0 = cache always valid)
    * @return moduleAddr Module address, or address(0) if the module is missing.
     */
    function _getModuleView(
        address registryAddr,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        bytes32 key,
        uint256 maxCacheAge
    ) private view returns (address moduleAddr) {
        // 1) Prefer cache if present and not stale.
        moduleAddr = moduleCache.moduleAddresses[key];
        uint256 cacheBlock = moduleCache.cacheBlocks[key];
        if (moduleAddr != address(0) && cacheBlock != 0) {
            // If maxCacheAge == 0, treat cache as always valid.
            if (maxCacheAge == 0) return moduleAddr;
            // block.number is monotonic; treat cache as valid if within age blocks.
            if (block.number - cacheBlock <= maxCacheAge) return moduleAddr;
        }

        // 2) Fallback to Registry (view-only) to avoid reverting due to cache staleness.
        if (registryAddr == address(0)) return address(0);
        moduleAddr = Registry(registryAddr).getModule(key);
    }

    /**
     * @notice Get user's aggregated collateral and debt values from ledger modules.
     * @dev Reverts if:
     *      - none (returns zeros on missing modules or call failures)
     *
     * Security:
     * - View function (read-only).
     * - Best-effort: returns (0, 0) if modules are not registered or calls fail.
    * - Does not access oracles or implement graceful degradation logic.
     * - Uses try/catch to handle external call failures gracefully.
     *
     * @param user User address to query
     * @param registryAddr Registry contract address for module resolution
     * @param moduleCache Module cache storage reference
 * @param maxCacheAge Maximum cache age in blocks (0 = cache always valid)
    * @return collateralValue Total collateral value in the shared 18-decimal system valuation unit, or 0 if the query fails.
    * @return debtValue Total debt value in the shared 18-decimal system valuation unit, or 0 if the query fails.
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

        // debt value for automatic risk decisions must come from the strict oracle-backed route.
        try ILendingEngineDebtRead(lendingEngine).getUserTotalDebtValueStrict(user) returns (uint256 v) {
            debtValue = v;
        } catch {
            debtValue = 0;
        }

        // collateral value (shared 18-decimal system valuation unit; produced by PositionView valuation)
        try IPositionViewValuation(positionView).getUserTotalCollateralValue(user) returns (uint256 v) {
            collateralValue = v;
        } catch {
            collateralValue = 0;
        }
    }
}



// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ModuleCache.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";

library LiquidationRiskQueryLib {
    using ModuleCache for ModuleCache.ModuleCacheStorage;

    /**
     * @notice Get user's aggregated collateral/debt values.
     * @dev Architecture alignment:
     * - This library intentionally does NOT access the oracle or implement graceful degradation.
     * - Valuation (incl. GD) must be centralized in LendingEngine; this function only reads aggregated values
     *   from ledger modules (CollateralManager + LendingEngine).
     */
    function getUserValues(
        address user,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        uint256 maxCacheAge
    ) internal view returns (uint256 collateralValue, uint256 debtValue) {
        address lendingEngine = ModuleCache.get(moduleCache, ModuleKeys.KEY_LE, maxCacheAge);
        address collateralManager = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, maxCacheAge);

        if (lendingEngine == address(0) || collateralManager == address(0)) return (0, 0);

        // debt value (settlement token denominated; produced by LE valuation)
        (bool dsuccess, bytes memory ddata) =
            lendingEngine.staticcall(abi.encodeWithSignature("getUserTotalDebtValue(address)", user));
        if (dsuccess && ddata.length >= 32) {
            debtValue = abi.decode(ddata, (uint256));
        } else {
            debtValue = 0;
        }

        // collateral value (settlement token denominated; produced by CM valuation)
        (bool csuccess, bytes memory cdata) =
            collateralManager.staticcall(abi.encodeWithSignature("getUserTotalCollateralValue(address)", user));
        if (csuccess && cdata.length >= 32) {
            collateralValue = abi.decode(cdata, (uint256));
        } else {
            collateralValue = 0;
        }
    }
}



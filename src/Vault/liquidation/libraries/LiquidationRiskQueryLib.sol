// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ModuleCache.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";
import { Registry } from "../../../registry/Registry.sol";

library LiquidationRiskQueryLib {
    using ModuleCache for ModuleCache.ModuleCacheStorage;

    function getUserValuesWithFallback(
        address user,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        uint256 maxCacheAge,
        address priceOracle,
        address settlementToken
    ) internal view returns (uint256 collateralValue, uint256 debtValue) {
        address lendingEngine = ModuleCache.get(moduleCache, ModuleKeys.KEY_LE, maxCacheAge);
        address collateralManager = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, maxCacheAge);

        if (lendingEngine == address(0) || collateralManager == address(0)) return (0, 0);

        // debt
        (bool dsuccess, bytes memory ddata) = lendingEngine.staticcall(abi.encodeWithSignature("getUserTotalDebtValue(address)", user));
        if (!dsuccess || ddata.length < 32) return (0, 0);
        debtValue = abi.decode(ddata, (uint256));

        // collateral with graceful degradation
        collateralValue = getUserTotalCollateralValueWithFallback(user, moduleCache, maxCacheAge, priceOracle, settlementToken);
    }

    function getUserTotalCollateralValueWithFallback(
        address user,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        uint256 maxCacheAge,
        address priceOracle,
        address settlementToken
    ) internal view returns (uint256 totalValue) {
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(settlementToken);

        address[] memory assets = getUserCollateralAssets(user, moduleCache, maxCacheAge);
        uint256 length = assets.length;
        for (uint256 i = 0; i < length;) {
            address asset = assets[i];
            uint256 amount = getUserCollateralAmount(user, asset, moduleCache, maxCacheAge);
            if (amount > 0) {
                GracefulDegradation.PriceResult memory result = 
                    GracefulDegradation.getAssetValueWithFallback(priceOracle, asset, amount, config);
                totalValue += result.value;
            }
            unchecked { ++i; }
        }
    }

    function getUserCollateralAssets(
        address user,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        uint256 maxCacheAge
    ) internal view returns (address[] memory) {
        address collateralManager = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, maxCacheAge);
        if (collateralManager == address(0)) return new address[](0);
        (bool success, bytes memory data) = collateralManager.staticcall(abi.encodeWithSignature("getUserCollateralAssets(address)", user));
        if (!success || data.length == 0) return new address[](0);
        return abi.decode(data, (address[]));
    }

    function getUserCollateralAmount(
        address user,
        address asset,
        ModuleCache.ModuleCacheStorage storage moduleCache,
        uint256 maxCacheAge
    ) internal view returns (uint256) {
        address collateralManager = ModuleCache.get(moduleCache, ModuleKeys.KEY_CM, maxCacheAge);
        if (collateralManager == address(0)) return 0;
        (bool success, bytes memory data) = collateralManager.staticcall(abi.encodeWithSignature("getCollateral(address,address)", user, asset));
        if (!success || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function checkPriceOracleHealth(
        address priceOracle,
        address asset
    ) internal view returns (bool isHealthy, string memory details) {
        return GracefulDegradation.checkPriceOracleHealth(priceOracle, asset);
    }
}



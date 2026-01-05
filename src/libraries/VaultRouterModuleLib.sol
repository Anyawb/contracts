// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { GracefulDegradation } from "./GracefulDegradation.sol";

/// @title VaultRouterModuleLib
/// @notice VaultRouter 模块管理库，提取模块缓存和健康检查逻辑
/// @dev 提供模块地址缓存管理和健康检查功能
library VaultRouterModuleLib {
    /// @notice 模块缓存结构
    struct ModuleCache {
        address cachedCMAddr;
        address cachedLEAddr;
        uint256 lastCacheUpdate;
    }

    /// @notice 获取并更新模块地址缓存
    /// @param cache 缓存结构（通过 storage 引用修改）
    /// @param registryAddr Registry 合约地址
    /// @param cacheExpiryTime 缓存过期时间（秒）
    /// @return cm CollateralManager 地址
    /// @return le LendingEngine 地址
    /// @dev 如果缓存过期，重新获取模块地址
    function getCachedModules(
        ModuleCache storage cache,
        address registryAddr,
        uint256 cacheExpiryTime
    ) internal returns (address cm, address le) {
        // 如果缓存过期，重新获取
        if (block.timestamp > cache.lastCacheUpdate + cacheExpiryTime) {
            cache.cachedCMAddr = Registry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
            cache.cachedLEAddr = Registry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
            cache.lastCacheUpdate = block.timestamp;
        }
        return (cache.cachedCMAddr, cache.cachedLEAddr);
    }

    /// @notice 强制更新模块缓存
    /// @param cache 缓存结构（通过 storage 引用修改）
    /// @param registryAddr Registry 合约地址
    function forceUpdateCache(
        ModuleCache storage cache,
        address registryAddr
    ) internal {
        cache.cachedCMAddr = Registry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        cache.cachedLEAddr = Registry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        cache.lastCacheUpdate = block.timestamp;
    }

    /// @notice 检查模块健康状态
    /// @param module 模块地址
    /// @param moduleName 模块名称
    /// @param priceOracleAddr 价格预言机地址（用于特殊检查）
    /// @return isHealthy 是否健康
    /// @return details 详细信息
    function checkModuleHealth(
        address module,
        string memory moduleName,
        address priceOracleAddr
    ) internal view returns (bool isHealthy, string memory details) {
        if (module == address(0)) {
            return (false, string(abi.encodePacked("Module not configured: ", moduleName)));
        }
        
        // 检查模块是否有代码
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(module)
        }
        
        if (codeSize == 0) {
            return (false, string(abi.encodePacked("Module has no code: ", moduleName)));
        }
        
        // 检查价格预言机健康状态
        if (module == priceOracleAddr) {
            return GracefulDegradation.checkPriceOracleHealth(priceOracleAddr, address(0));
        }
        
        return (true, string(abi.encodePacked("Module is healthy: ", moduleName)));
    }
}






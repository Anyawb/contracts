# PriceOracle 价格预言机使用指南

## 概述

PriceOracle 是一个基于 Coingecko API 的多资产价格预言机系统，为 RWA 借贷平台提供实时、可靠的价格数据。本指南将详细介绍如何集成和使用预言机系统。

## 系统架构

```
┌─────────────────┐    ┌─────────────────────┐    ┌─────────────────┐
│   CoinGecko     │    │  CoinGeckoPrice     │    │   PriceOracle   │
│     API         │◄──►│    Updater          │◄──►│                 │
└─────────────────┘    └─────────────────────┘    └─────────────────┘
                                │                           │
                                ▼                           ▼
                       ┌─────────────────┐    ┌─────────────────────┐
                       │ValuationOracle  │    │   其他合约         │
                       │   Adapter       │    │ (借贷引擎、清算等)  │
                       └─────────────────┘    └─────────────────────┘
```

## 合约地址

部署完成后，您需要记录以下合约地址：

```typescript
// 主要合约地址
const PRICE_ORACLE_ADDRESS = "0x...";           // PriceOracle 主合约
const COINGECKO_UPDATER_ADDRESS = "0x...";      // CoinGecko 价格更新器
const VALUATION_ADAPTER_ADDRESS = "0x...";      // 估值适配器
const ACM_ADDRESS = "0x...";                    // 访问控制管理器
```

## 1. 基础集成

### 1.1 导入接口

```typescript
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { ICoinGeckoPriceUpdater } from "../interfaces/ICoinGeckoPriceUpdater.sol";
import { IValuationOracleAdapter } from "../interfaces/IValuationOracleAdapter.sol";
```

### 1.2 合约实例化

```typescript
// 使用 ethers.js
const priceOracle = IPriceOracle__factory.connect(PRICE_ORACLE_ADDRESS, signer);
const coinGeckoUpdater = ICoinGeckoPriceUpdater__factory.connect(COINGECKO_UPDATER_ADDRESS, signer);
const valuationAdapter = IValuationOracleAdapter__factory.connect(VALUATION_ADAPTER_ADDRESS, signer);
```

## 2. 资产配置

### 2.1 添加新资产

```typescript
/**
 * 配置新资产到预言机系统
 * @param asset 资产合约地址
 * @param coingeckoId CoinGecko API 中的资产ID
 * @param decimals 资产精度
 * @param maxPriceAge 最大价格年龄（秒）
 */
async function configureAsset(
    asset: string,
    coingeckoId: string,
    decimals: number,
    maxPriceAge: number = 3600
) {
    // 需要 SET_PARAMETER 权限
    const tx = await priceOracle.configureAsset(
        asset,
        coingeckoId,
        decimals,
        maxPriceAge
    );
    await tx.wait();
    
    console.log(`资产 ${asset} 配置成功`);
}
```

### 2.2 配置示例

```typescript
// 配置 USDC
await configureAsset(
    "0xA0b86a33E6441b8c4C8C8C8C8C8C8C8C8C8C8C8", // USDC 地址
    "usd-coin",
    6,
    3600 // 1小时过期
);

// 配置 WETH
await configureAsset(
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH 地址
    "weth",
    18,
    3600
);
```

## 3. 价格查询

### 3.1 单个资产价格查询

```typescript
/**
 * 获取单个资产价格
 * @param asset 资产地址
 * @returns {price, timestamp, decimals}
 */
async function getAssetPrice(asset: string) {
    try {
        const [price, timestamp, decimals] = await priceOracle.getPrice(asset);
        
        return {
            price: price.toString(),
            timestamp: timestamp.toString(),
            decimals: decimals.toString(),
            priceUSD: ethers.formatUnits(price, decimals)
        };
    } catch (error) {
        console.error(`获取资产 ${asset} 价格失败:`, error);
        throw error;
    }
}
```

### 3.2 批量价格查询

```typescript
/**
 * 批量获取多个资产价格
 * @param assets 资产地址数组
 * @returns {prices, timestamps, decimals}
 */
async function getAssetPrices(assets: string[]) {
    try {
        const [prices, timestamps, decimals] = await priceOracle.getPrices(assets);
        
        return assets.map((asset, index) => ({
            asset,
            price: prices[index].toString(),
            timestamp: timestamps[index].toString(),
            decimals: decimals[index].toString(),
            priceUSD: ethers.formatUnits(prices[index], decimals[index])
        }));
    } catch (error) {
        console.error("批量获取价格失败:", error);
        throw error;
    }
}
```

### 3.3 价格有效性检查

```typescript
/**
 * 检查价格是否有效
 * @param asset 资产地址
 * @returns 价格是否有效
 */
async function isPriceValid(asset: string): Promise<boolean> {
    try {
        return await priceOracle.isPriceValid(asset);
    } catch (error) {
        console.error(`检查资产 ${asset} 价格有效性失败:`, error);
        return false;
    }
}
```

## 4. 价格更新

### 4.1 手动更新价格

```typescript
/**
 * 手动更新资产价格
 * @param asset 资产地址
 * @param price 新价格（8位精度）
 * @param timestamp 价格时间戳
 */
async function updateAssetPrice(
    asset: string,
    price: bigint,
    timestamp: number
) {
    // 需要 UPDATE_PRICE 权限
    const tx = await priceOracle.updatePrice(asset, price, timestamp);
    await tx.wait();
    
    console.log(`资产 ${asset} 价格更新成功`);
}
```

### 4.2 批量更新价格

```typescript
/**
 * 批量更新多个资产价格
 * @param assets 资产地址数组
 * @param prices 价格数组
 * @param timestamps 时间戳数组
 */
async function updateAssetPrices(
    assets: string[],
    prices: bigint[],
    timestamps: number[]
) {
    // 需要 UPDATE_PRICE 权限
    const tx = await priceOracle.updatePrices(assets, prices, timestamps);
    await tx.wait();
    
    console.log("批量价格更新成功");
}
```

### 4.3 使用 CoinGecko 更新器

```typescript
/**
 * 通过 CoinGecko 更新器更新价格
 * @param asset 资产地址
 * @param price 新价格
 * @param timestamp 时间戳
 */
async function updateViaCoinGecko(
    asset: string,
    price: bigint,
    timestamp: number
) {
    // CoinGecko 更新器会自动配置资产（如果未配置）
    const tx = await coinGeckoUpdater.updateAssetPrice(asset, price, timestamp);
    await tx.wait();
    
    console.log(`通过 CoinGecko 更新器更新 ${asset} 价格成功`);
}
```

## 5. 使用 ValuationOracleAdapter

### 5.1 基础价格查询

```typescript
/**
 * 通过适配器获取价格
 * @param asset 资产地址
 * @returns {price, timestamp}
 */
async function getPriceViaAdapter(asset: string) {
    try {
        const [price, timestamp] = await valuationAdapter.getAssetPrice(asset);
        
        return {
            price: price.toString(),
            timestamp: timestamp.toString()
        };
    } catch (error) {
        console.error(`通过适配器获取 ${asset} 价格失败:`, error);
        throw error;
    }
}
```

### 5.2 批量查询

```typescript
/**
 * 通过适配器批量获取价格
 * @param assets 资产地址数组
 * @returns {prices, timestamps}
 */
async function getPricesViaAdapter(assets: string[]) {
    try {
        const [prices, timestamps] = await valuationAdapter.getAssetPrices(assets);
        
        return assets.map((asset, index) => ({
            asset,
            price: prices[index].toString(),
            timestamp: timestamps[index].toString()
        }));
    } catch (error) {
        console.error("通过适配器批量获取价格失败:", error);
        throw error;
    }
}
```

## 6. 错误处理

### 6.1 常见错误类型

```typescript
// 错误类型定义
enum PriceOracleErrors {
    ASSET_NOT_SUPPORTED = "PriceOracle__AssetNotSupported",
    STALE_PRICE = "PriceOracle__StalePrice",
    INVALID_PRICE = "PriceOracle__InvalidPrice",
    ZERO_ADDRESS = "ZeroAddress",
    UNAUTHORIZED = "PriceOracle__Unauthorized"
}

// 错误处理函数
async function handlePriceOracleError(error: any, asset: string) {
    if (error.message.includes(PriceOracleErrors.ASSET_NOT_SUPPORTED)) {
        console.error(`资产 ${asset} 未在预言机中配置`);
        // 可以尝试自动配置资产
        await tryConfigureAsset(asset);
    } else if (error.message.includes(PriceOracleErrors.STALE_PRICE)) {
        console.error(`资产 ${asset} 价格已过期`);
        // 可以尝试更新价格
        await tryUpdatePrice(asset);
    } else if (error.message.includes(PriceOracleErrors.INVALID_PRICE)) {
        console.error(`资产 ${asset} 价格无效`);
    } else if (error.message.includes(PriceOracleErrors.UNAUTHORIZED)) {
        console.error("权限不足，需要相应角色");
    } else {
        console.error("未知错误:", error);
    }
}
```

### 6.2 重试机制

```typescript
/**
 * 带重试的价格查询
 * @param asset 资产地址
 * @param maxRetries 最大重试次数
 * @returns 价格数据
 */
async function getPriceWithRetry(asset: string, maxRetries: number = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await getAssetPrice(asset);
        } catch (error) {
            console.warn(`第 ${i + 1} 次尝试失败:`, error);
            
            if (i === maxRetries - 1) {
                throw error;
            }
            
            // 等待后重试
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
}
```

## 7. 实际应用示例

### 7.1 借贷合约集成

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IPriceOracle } from "../interfaces/IPriceOracle.sol";

contract LendingContract {
    IPriceOracle public priceOracle;
    
    constructor(address _priceOracle) {
        priceOracle = IPriceOracle(_priceOracle);
    }
    
    /**
     * 计算抵押品价值
     * @param asset 资产地址
     * @param amount 资产数量
     * @return 价值（USD，8位精度）
     */
    function calculateCollateralValue(address asset, uint256 amount) 
        external 
        view 
        returns (uint256) 
    {
        (uint256 price, , uint256 decimals) = priceOracle.getPrice(asset);
        
        // 计算价值：amount * price / 10^decimals
        return (amount * price) / (10 ** decimals);
    }
    
    /**
     * 检查清算条件
     * @param collateralAsset 抵押品资产
     * @param collateralAmount 抵押品数量
     * @param debtAmount 债务金额
     * @return 是否需要清算
     */
    function shouldLiquidate(
        address collateralAsset,
        uint256 collateralAmount,
        uint256 debtAmount
    ) external view returns (bool) {
        uint256 collateralValue = this.calculateCollateralValue(collateralAsset, collateralAmount);
        
        // 假设清算阈值为 150%
        uint256 liquidationThreshold = (debtAmount * 150) / 100;
        
        return collateralValue < liquidationThreshold;
    }
}
```

### 7.2 前端集成示例

```typescript
// React Hook 示例
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';

export function usePriceOracle(assetAddress: string) {
    const [price, setPrice] = useState<string>('0');
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string>('');

    useEffect(() => {
        let mounted = true;

        async function fetchPrice() {
            try {
                setLoading(true);
                setError('');

                const priceData = await getAssetPrice(assetAddress);
                
                if (mounted) {
                    setPrice(priceData.priceUSD);
                }
            } catch (err) {
                if (mounted) {
                    setError(err.message);
                }
            } finally {
                if (mounted) {
                    setLoading(false);
                }
            }
        }

        fetchPrice();

        // 每30秒更新一次价格
        const interval = setInterval(fetchPrice, 30000);

        return () => {
            mounted = false;
            clearInterval(interval);
        };
    }, [assetAddress]);

    return { price, loading, error };
}

// 使用示例
function AssetPriceDisplay({ assetAddress }: { assetAddress: string }) {
    const { price, loading, error } = usePriceOracle(assetAddress);

    if (loading) return <div>加载中...</div>;
    if (error) return <div>错误: {error}</div>;

    return <div>价格: ${price}</div>;
}
```

## 8. 监控和维护

### 8.1 价格监控

```typescript
/**
 * 监控价格变化
 * @param assets 要监控的资产列表
 * @param callback 价格变化回调
 */
function monitorPrices(assets: string[], callback: (asset: string, price: string) => void) {
    const interval = setInterval(async () => {
        for (const asset of assets) {
            try {
                const priceData = await getAssetPrice(asset);
                callback(asset, priceData.priceUSD);
            } catch (error) {
                console.error(`监控资产 ${asset} 失败:`, error);
            }
        }
    }, 30000); // 每30秒检查一次

    return () => clearInterval(interval);
}

// 使用示例
const stopMonitoring = monitorPrices(
    ['0x...', '0x...'], // USDC, WETH
    (asset, price) => {
        console.log(`${asset}: $${price}`);
        // 发送通知或更新UI
    }
);
```

### 8.2 健康检查

```typescript
/**
 * 检查预言机系统健康状态
 * @returns 健康状态报告
 */
async function checkOracleHealth() {
    const report = {
        timestamp: Date.now(),
        status: 'healthy',
        issues: [] as string[],
        assets: {} as Record<string, any>
    };

    try {
        // 获取支持的资产列表
        const supportedAssets = await priceOracle.getSupportedAssets();
        
        for (const asset of supportedAssets) {
            try {
                const isValid = await priceOracle.isPriceValid(asset);
                const [price, timestamp] = await priceOracle.getPrice(asset);
                
                report.assets[asset] = {
                    isValid,
                    price: price.toString(),
                    timestamp: timestamp.toString(),
                    age: Date.now() / 1000 - Number(timestamp)
                };

                if (!isValid) {
                    report.issues.push(`资产 ${asset} 价格无效`);
                    report.status = 'warning';
                }
            } catch (error) {
                report.issues.push(`资产 ${asset} 查询失败: ${error.message}`);
                report.status = 'error';
            }
        }
    } catch (error) {
        report.issues.push(`系统检查失败: ${error.message}`);
        report.status = 'error';
    }

    return report;
}
```

## 9. 最佳实践

### 9.1 性能优化

1. **缓存价格数据**：避免频繁查询相同资产的价格
2. **批量操作**：使用批量查询和更新函数
3. **异步处理**：在非关键路径上使用异步价格更新

### 9.2 安全考虑

1. **权限验证**：确保只有授权用户才能更新价格
2. **价格验证**：检查价格是否在合理范围内
3. **错误处理**：妥善处理价格查询失败的情况

### 9.3 监控建议

1. **价格偏差监控**：监控价格变化幅度
2. **更新频率监控**：确保价格及时更新
3. **错误率监控**：跟踪价格查询失败率

## 10. 故障排除

### 10.1 常见问题

**Q: 价格查询返回 "AssetNotSupported" 错误**
A: 检查资产是否已在预言机中配置，使用 `configureAsset` 函数添加资产。

**Q: 价格查询返回 "StalePrice" 错误**
A: 价格已过期，需要更新价格或调整 `maxPriceAge` 参数。

**Q: 权限不足错误**
A: 确保调用者具有相应的角色权限（UPDATE_PRICE, SET_PARAMETER 等）。

### 10.2 调试技巧

```typescript
// 启用详细日志
const DEBUG = true;

function log(...args: any[]) {
    if (DEBUG) {
        console.log('[PriceOracle]', ...args);
    }
}

// 在价格查询函数中添加日志
async function getAssetPriceWithLog(asset: string) {
    log(`查询资产 ${asset} 价格`);
    
    try {
        const result = await getAssetPrice(asset);
        log(`查询成功:`, result);
        return result;
    } catch (error) {
        log(`查询失败:`, error);
        throw error;
    }
}
```

## 总结

PriceOracle 系统提供了完整的价格预言机解决方案，通过本指南，您可以：

1. ✅ 正确集成预言机到您的应用中
2. ✅ 配置和管理支持的资产
3. ✅ 查询和更新价格数据
4. ✅ 处理各种错误情况
5. ✅ 监控和维护系统健康

如有任何问题，请参考合约源码或联系开发团队。

---

**版本**: 1.0.0  
**最后更新**: 2024年12月  
**维护者**: RWA Lending Platform Team 
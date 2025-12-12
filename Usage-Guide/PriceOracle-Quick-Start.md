# PriceOracle 快速开始指南

## 🚀 5分钟快速上手

### 1. 基础设置

```typescript
import { ethers } from 'ethers';
import { IPriceOracle__factory } from '../types/contracts/core';

// 合约地址（部署后替换）
const PRICE_ORACLE_ADDRESS = "0x...";
const signer = await ethers.getSigner();

// 创建合约实例
const priceOracle = IPriceOracle__factory.connect(PRICE_ORACLE_ADDRESS, signer);
```

### 2. 配置资产（一次性操作）

```typescript
// 配置 USDC
await priceOracle.configureAsset(
    "0xA0b86a33E6441b8c4C8C8C8C8C8C8C8C8C8C8C8", // USDC 地址
    "usd-coin",                                    // CoinGecko ID
    6,                                             // 精度
    3600                                           // 1小时过期
);
```

### 3. 查询价格

```typescript
// 获取价格
const [price, timestamp, decimals] = await priceOracle.getPrice(assetAddress);
const priceUSD = ethers.formatUnits(price, decimals);
console.log(`价格: $${priceUSD}`);
```

### 4. 更新价格

```typescript
// 更新价格（需要 UPDATE_PRICE 权限）
const price = ethers.parseUnits("1.00", 8); // $1.00
const timestamp = Math.floor(Date.now() / 1000);
await priceOracle.updatePrice(assetAddress, price, timestamp);
```

## 📋 常用代码片段

### 价格查询函数

```typescript
async function getPrice(asset: string) {
    try {
        const [price, timestamp, decimals] = await priceOracle.getPrice(asset);
        return {
            price: ethers.formatUnits(price, decimals),
            timestamp: Number(timestamp),
            rawPrice: price
        };
    } catch (error) {
        console.error('价格查询失败:', error);
        throw error;
    }
}
```

### 批量查询

```typescript
async function getPrices(assets: string[]) {
    const [prices, timestamps, decimals] = await priceOracle.getPrices(assets);
    return assets.map((asset, i) => ({
        asset,
        price: ethers.formatUnits(prices[i], decimals[i]),
        timestamp: Number(timestamps[i])
    }));
}
```

### 价格有效性检查

```typescript
async function checkPriceValid(asset: string) {
    return await priceOracle.isPriceValid(asset);
}
```

## ⚠️ 常见错误处理

```typescript
async function safeGetPrice(asset: string) {
    try {
        return await getPrice(asset);
    } catch (error) {
        if (error.message.includes('AssetNotSupported')) {
            console.error('资产未配置，请先配置资产');
        } else if (error.message.includes('StalePrice')) {
            console.error('价格已过期，需要更新');
        } else {
            console.error('未知错误:', error);
        }
        throw error;
    }
}
```

## 🔧 权限设置

确保调用者具有相应权限：

```typescript
// 设置权限（需要管理员权限）
const UPDATE_PRICE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('UPDATE_PRICE'));
const SET_PARAMETER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));

await acm.grantRole(UPDATE_PRICE_ROLE, updaterAddress);
await acm.grantRole(SET_PARAMETER_ROLE, adminAddress);
```

## 📊 监控示例

```typescript
// 简单价格监控
function monitorPrice(asset: string, callback: (price: string) => void) {
    return setInterval(async () => {
        try {
            const priceData = await getPrice(asset);
            callback(priceData.price);
        } catch (error) {
            console.error('监控失败:', error);
        }
    }, 30000); // 30秒
}

// 使用
const stopMonitoring = monitorPrice(assetAddress, (price) => {
    console.log(`当前价格: $${price}`);
});
```

## 🎯 实际应用示例

### 借贷合约集成

```solidity
contract SimpleLending {
    IPriceOracle public oracle;
    
    function getCollateralValue(address asset, uint256 amount) 
        external view returns (uint256) 
    {
        (uint256 price, , uint256 decimals) = oracle.getPrice(asset);
        return (amount * price) / (10 ** decimals);
    }
}
```

### 前端集成

```typescript
// React Hook
function usePrice(asset: string) {
    const [price, setPrice] = useState('0');
    
    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                const data = await getPrice(asset);
                setPrice(data.price);
            } catch (error) {
                console.error('获取价格失败:', error);
            }
        }, 30000);
        
        return () => clearInterval(interval);
    }, [asset]);
    
    return price;
}
```

## 📞 需要帮助？

- 📖 完整文档：查看 `PriceOracle-Usage-Guide.md`
- 🧪 测试示例：查看 `test/core/PriceOracle.test.ts`
- 🔍 合约源码：查看 `contracts/core/PriceOracle.sol`

---

**快速开始完成！** 🎉 现在您可以开始使用 PriceOracle 了！ 
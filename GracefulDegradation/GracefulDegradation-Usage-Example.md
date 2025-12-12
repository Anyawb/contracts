# GracefulDegradation 库使用指南

## 🎯 概述

`GracefulDegradation` 库提供了一个统一的优雅降级解决方案，用于处理价格预言机失败时的备用策略。这个库可以在所有 Vault 合约中复用，减少代码重复并降低 Gas 费用。

## 📦 库文件位置

```
contracts/libraries/GracefulDegradation.sol
```

## 🚀 使用方法

### 1. 在合约中导入库

```solidity
import { GracefulDegradation } from "../../libraries/GracefulDegradation.sol";

contract CollateralManager {
    using GracefulDegradation for *;
    
    // 你的合约代码...
}
```

### 2. 创建降级配置

```solidity
// 创建默认配置
GracefulDegradation.DegradationConfig memory config = 
    GracefulDegradation.createDefaultConfig(settlementToken);

// 或者自定义配置
GracefulDegradation.DegradationConfig memory customConfig = GracefulDegradation.DegradationConfig({
    conservativeRatio: 6000,        // 60% 保守估值
    useStablecoinFaceValue: true,   // 稳定币使用面值
    enablePriceCache: false,        // 暂时禁用缓存
    settlementToken: settlementToken
});
```

### 3. 使用库函数获取资产价值

```solidity
function getUserAssetValue(address user, address asset) external view returns (uint256 value) {
    if (user == address(0)) revert ZeroAddress();
    if (asset == address(0)) revert ZeroAddress();
    
    uint256 amount = _userCollateral[user][asset];
    if (amount == 0) return 0;
    
    // 创建降级配置
    GracefulDegradation.DegradationConfig memory config = 
        GracefulDegradation.createDefaultConfig(settlementToken);
    
    // 使用库函数获取价值（带优雅降级）
    GracefulDegradation.PriceResult memory result = 
        GracefulDegradation.getAssetValueWithFallback(priceOracle, asset, amount, config);
    
    // 发出相应的事件
    if (result.usedFallback) {
        emit GracefulDegradation(asset, result.reason, result.value, true);
    } else {
        emit PriceOracleHealthCheck(asset, true, result.reason);
    }
    
    return result.value;
}
```

### 4. 检查价格预言机健康状态

```solidity
function checkPriceOracleHealth(address asset) external view returns (bool isHealthy, string memory details) {
    if (asset == address(0)) revert ZeroAddress();
    return GracefulDegradation.checkPriceOracleHealth(priceOracle, asset);
}
```

## 🎨 降级策略

### 策略1：稳定币面值
- 如果资产是结算币，使用面值（1:1）
- 适用于 USDT、USDC 等稳定币

### 策略2：保守估值
- 使用配置的保守比例（默认50%）
- 防止过度乐观的估值

### 策略3：价格缓存（未来实现）
- 缓存最后一次有效价格
- 在价格预言机失败时使用缓存

## 📊 Gas 费用对比

| 方案 | Gas 费用 | 代码复用性 | 维护难度 |
|------|----------|------------|----------|
| 库文件 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 抽象合约 | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| 重复代码 | ⭐⭐ | ⭐ | ⭐⭐ |

## 🔧 配置选项

### DegradationConfig 结构

```solidity
struct DegradationConfig {
    uint256 conservativeRatio;    // 保守估值比例（基点）
    bool useStablecoinFaceValue;  // 是否对稳定币使用面值
    bool enablePriceCache;        // 是否启用价格缓存
    address settlementToken;      // 结算币地址
}
```

### 默认配置

```solidity
conservativeRatio = 5000;        // 50%
useStablecoinFaceValue = true;   // 启用
enablePriceCache = false;        // 暂时禁用
settlementToken = settlementToken;
```

## 🛡️ 安全特性

1. **价格验证**：检查零价格、过期价格、异常高价
2. **精度验证**：确保精度参数在合理范围内
3. **溢出保护**：防止计算溢出
4. **保守估值**：使用保守的降级策略

## 📝 事件处理

库函数本身不发出事件，事件应该在调用合约中发出：

```solidity
// 在调用合约中定义事件
event GracefulDegradation(address indexed asset, string reason, uint256 fallbackValue, bool usedFallback);
event PriceOracleHealthCheck(address indexed asset, bool isHealthy, string details);

// 在库函数调用后发出事件
if (result.usedFallback) {
    emit GracefulDegradation(asset, result.reason, result.value, true);
} else {
    emit PriceOracleHealthCheck(asset, true, result.reason);
}
```

## 🚀 迁移指南

### 从现有代码迁移

1. **导入库**：
   ```solidity
   import { GracefulDegradation } from "../../libraries/GracefulDegradation.sol";
   ```

2. **替换价格获取逻辑**：
   ```solidity
   // 旧代码
   try IPriceOracle(priceOracle).getPrice(asset) returns (uint256 price, uint256 timestamp, uint256 decimals) {
       // 复杂的验证逻辑...
   } catch {
       return 0;
   }
   
   // 新代码
   GracefulDegradation.DegradationConfig memory config = 
       GracefulDegradation.createDefaultConfig(settlementToken);
   GracefulDegradation.PriceResult memory result = 
       GracefulDegradation.getAssetValueWithFallback(priceOracle, asset, amount, config);
   ```

3. **添加事件处理**：
   ```solidity
   if (result.usedFallback) {
       emit GracefulDegradation(asset, result.reason, result.value, true);
   }
   ```

## 📈 性能优化

1. **Gas 优化**：库代码只部署一次，所有合约共享
2. **代码复用**：减少重复代码，降低维护成本
3. **统一策略**：所有 Vault 使用相同的降级策略
4. **易于升级**：只需升级库文件即可影响所有合约

## 🔮 未来扩展

1. **价格缓存**：实现价格缓存机制
2. **多预言机**：支持多个价格预言机
3. **动态配置**：支持运行时配置更新
4. **机器学习**：集成 ML 模型进行价格预测

---

**注意**：这个库设计为纯函数，不存储状态，确保 Gas 效率和安全性。 
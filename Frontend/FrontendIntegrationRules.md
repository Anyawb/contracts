# 🚀 RWA 借贷平台前端集成规则文档

> 最后更新：2025-08-13  
> 本文档定义了前端与智能合约交互的标准规则和最佳实践
> 
> **核心原则**：采用方式1 - 直接调用多个合约，实现 Gas 费用优化、架构清晰、灵活性高的前端集成方案

---

## 📋 目录

1. [概述](#概述)
2. [架构设计原则](#架构设计原则)
3. [核心合约调用指南](#核心合约调用指南)
4. [Reward 系统集成](#reward-系统集成)
5. [用户操作流程](#用户操作流程)
6. [错误处理](#错误处理)
7. [安全最佳实践](#安全最佳实践)
8. [测试指南](#测试指南)
9. [性能优化](#性能优化)

---

## 🎯 概述

本平台采用**方式1：直接调用多个合约**的架构设计，支持多资产借贷，集成了基于 Coingecko API 的价格预言机系统和完整的积分奖励系统。前端需要遵循以下规则来确保安全、高效的交互。

### 🏆 核心特性

- ✅ **Gas 费用优化**：直接调用合约，减少中间层开销
- ✅ **架构清晰**：每个合约职责明确，便于维护和升级
- ✅ **灵活性高**：用户可以根据需要选择调用哪些功能
- ✅ **调试友好**：问题定位更容易，错误处理更精确
- ✅ **多资产支持**：支持多种 ERC20 代币作为抵押物和债务
- ✅ **实时价格**：基于 Coingecko API 的实时价格更新
- ✅ **安全转账**：使用 SafeERC20 确保转账安全
- ✅ **资产白名单**：动态资产管理，支持治理控制
- ✅ **健康因子**：实时监控用户借贷健康状态
- ✅ **积分奖励系统**：完整的用户激励和特权管理
- ✅ **服务配置管理**：灵活的服务等级和价格配置

---

## 🏗️ 架构设计原则

### 健康因子路径迁移与废弃说明

背景
- 架构已切换为“库直调 + 业务侧推送 + View 缓存”的双架构方案。健康因子由业务/清算模块计算，并推送到 HealthView 缓存；前端仅读取缓存与阈值进行展示与判断。

废弃项（前端不得再使用）
- IHealthFactorCalculator 及其相关调用
- 模块键 KEY_HF_CALC 的解析与注入

替代路径（请按以下方式实现）
- 读取健康因子：HealthView.getUserHealthFactor(user) → (hfBps, isValid)
- 批量读取：HealthView.batchGetHealthFactors(users) → (hfBps[], validFlags[])
- 读取阈值：LiquidationRiskManager.getMinHealthFactor() → minHFBps
- 判断风险：hfBps < minHFBps → undercollateralized
- 仅在 oraclePriced=true 的资产/产品上启用上述流程

迁移提示
- 将文档/代码中“直接调用计算器（如 IHealthFactorCalculator）”的示例，统一替换为对 HealthView 与 LiquidationRiskManager 的读取。
- 如有使用 `vaultView.getHealthFactor(user)` 的示例，改为 `healthView.getUserHealthFactor(user)`；批量改为 `healthView.batchGetHealthFactors(users)`。

参考代码（服务层）
```ts
export async function fetchUserRisk(user: string) {
  const [hfBps, isValid] = await healthView.getUserHealthFactor(user);
  const minHFBps = await liquidationRiskManager.getMinHealthFactor();
  const under = hfBps < minHFBps;
  return { hfBps, minHFBps, under, isValid };
}
```

事件驱动（推荐）
- 订阅 DataPushed：RISK_STATUS_UPDATE / RISK_STATUS_UPDATE_BATCH，增量更新 UI；无事件时再短期轮询 HealthView。

### 方式1：直接调用多个合约（推荐）

#### 🎯 设计理念

我们采用**直接调用多个合约**的方式，而不是通过统一的聚合合约。这种方式具有以下优势：

1. **Gas 费用优化**：减少中间层调用，降低 gas 消耗
2. **架构清晰**：每个合约职责明确，便于维护和升级
3. **灵活性高**：用户可以根据需要选择调用哪些功能
4. **调试友好**：问题定位更容易，错误处理更精确

#### 📋 合约调用策略

```typescript
// 前端封装统一的API
class RwaLendingAPI {
  private contracts: {
    vaultCore: Contract;
    vaultView: Contract;
    rewardConsumption: Contract;
    priceOracle: Contract;
    assetWhitelist: Contract;
  };

  constructor(contractAddresses: ContractAddresses, signer: Signer) {
    this.contracts = {
      vaultCore: new Contract(contractAddresses.vaultCore, VAULT_CORE_ABI, signer),
      vaultView: new Contract(contractAddresses.vaultView, VAULT_VIEW_ABI, signer),
      rewardConsumption: new Contract(contractAddresses.rewardConsumption, REWARD_CONSUMPTION_ABI, signer),
      priceOracle: new Contract(contractAddresses.priceOracle, PRICE_ORACLE_ABI, signer),
      assetWhitelist: new Contract(contractAddresses.assetWhitelist, ASSET_WHITELIST_ABI, signer)
    };
  }

  // 批量查询优化
  async getUserInfo(userAddress: string) {
    const [balance, privilege, consumptions, healthFactor] = await Promise.all([
      this.contracts.rewardConsumption.getUserBalance(userAddress),
      this.contracts.rewardConsumption.getUserPrivilege(userAddress),
      this.contracts.rewardConsumption.getUserConsumptions(userAddress),
      this.contracts.vaultView.getHealthFactor(userAddress)
    ]);

    return { balance, privilege, consumptions, healthFactor };
  }

  // 积分消费
  async consumePoints(serviceType: number, level: number) {
    return await this.contracts.rewardConsumption.consumePointsForService(serviceType, level);
  }
}
```

#### 🔄 批量查询优化

在 `RewardConsumption` 合约中添加批量查询功能：

```solidity
function getUserRewardInfo(address user) external view returns (
    uint256 balance,
    UserPrivilege memory privilege,
    ConsumptionRecord[] memory consumptions
) {
    return (
        rewardToken.balanceOf(user),
        rewardCore.getUserPrivilege(user),
        rewardCore.getUserConsumptions(user)
    );
}
```

#### 📊 合约职责分工

| 合约名称 | 主要职责 | 调用频率 | Gas 优化策略 |
|---------|---------|---------|-------------|
| `VaultCore` | 核心业务操作 | 高 | 批量操作，减少调用次数 |
| `VaultView` | 查询和预览 | 高 | 缓存结果，批量查询 |
| `RewardConsumption` | 积分消费 | 中 | 批量消费，减少交易次数 |
| `PriceOracle` | 价格查询 | 高 | 缓存价格，批量更新 |
| `AssetWhitelist` | 资产验证 | 中 | 本地缓存白名单 |

---

## 🏦 多资产支持

### 资产类型

1. **抵押资产**：用户存入的 ERC20 代币
2. **债务资产**：用户借出的 ERC20 代币
3. **结算币**：用于价值计算的基准货币（通常为 USDT/USDC）

### 资产配置

```typescript
interface AssetConfig {
  address: string;           // 资产合约地址
  coingeckoId: string;       // Coingecko 资产 ID
  decimals: number;          // 资产精度
  isActive: boolean;         // 是否激活
  maxPriceAge: number;       // 最大价格年龄（秒）
}
```

### 支持的资产列表

前端应定期查询以下接口获取支持的资产：

```solidity
// 获取支持的资产列表
function getSupportedAssets() external view returns (address[] memory assets);

// 获取资产配置
function getAssetConfig(address asset) external view returns (AssetConfig memory config);
```

---

## 🔧 核心合约调用指南

### 📋 合约地址配置

```typescript
interface ContractAddresses {
  // 核心业务合约
  vaultCore: string;           // 核心业务逻辑
  vaultView: string;           // 查询和预览功能
  vaultStorage: string;        // 存储和配置
  
  // 模块化合约
  collateralManager: string;   // 抵押物管理
  lendingEngine: string;       // 借贷引擎
  healthFactorCalculator: string; // 健康因子计算
  
  // 奖励系统合约
  rewardConsumption: string;   // 积分消费管理
  rewardManager: string;       // 积分管理
  rewardPoints: string;        // 积分代币
  
  // 基础设施合约
  priceOracle: string;         // 价格预言机
  assetWhitelist: string;      // 资产白名单
  feeRouter: string;           // 费用路由
  
  // 治理合约
  accessControlManager: string; // 权限管理
  registry: string;            // 注册表
}
```

### 🎯 核心合约功能映射

#### 1. VaultCore - 核心业务操作

```typescript
class VaultCoreAPI {
  constructor(contract: Contract) {
    this.contract = contract;
  }

  // 基础操作
  async deposit(asset: string, amount: string) {
    return await this.contract.deposit(asset, amount);
  }

  async withdraw(asset: string, amount: string) {
    return await this.contract.withdraw(asset, amount);
  }

  async borrow(asset: string, amount: string) {
    return await this.contract.borrow(asset, amount);
  }

  async repay(asset: string, amount: string) {
    return await this.contract.repay(asset, amount);
  }

  // 复合操作
  async depositAndBorrow(
    collateralAsset: string,
    collateralAmount: string,
    borrowAsset: string,
    borrowAmount: string
  ) {
    return await this.contract.depositAndBorrow(
      collateralAsset,
      collateralAmount,
      borrowAsset,
      borrowAmount
    );
  }

  async repayAndWithdraw(
    repayAsset: string,
    repayAmount: string,
    withdrawAsset: string,
    withdrawAmount: string
  ) {
    return await this.contract.repayAndWithdraw(
      repayAsset,
      repayAmount,
      withdrawAsset,
      withdrawAmount
    );
  }

  // 批量操作
  async batchDeposit(assets: string[], amounts: string[]) {
    return await this.contract.batchDeposit(assets, amounts);
  }

  async batchBorrow(assets: string[], amounts: string[]) {
    return await this.contract.batchBorrow(assets, amounts);
  }

  async batchRepay(assets: string[], amounts: string[]) {
    return await this.contract.batchRepay(assets, amounts);
  }

  async batchWithdraw(assets: string[], amounts: string[]) {
    return await this.contract.batchWithdraw(assets, amounts);
  }
}
```

#### 2. VaultView - 查询和预览

```typescript
class VaultViewAPI {
  constructor(contract: Contract) {
    this.contract = contract;
  }

  // 用户状态查询
  async getUserPosition(user: string) {
    return await this.contract.getUserPosition(user);
  }

  async getUserStats(user: string) {
    return await this.contract.getUserStats(user);
  }

  async getHealthFactor(user: string) {
    return await this.contract.getHealthFactor(user);
  }

  async getUserTotalCollateral(user: string) {
    return await this.contract.getUserTotalCollateral(user);
  }

  async getUserTotalDebt(user: string) {
    return await this.contract.getUserTotalDebt(user);
  }

  // 资产状态查询
  async getAssetPrice(asset: string) {
    return await this.contract.getAssetPrice(asset);
  }

  async getTotalCollateral(asset: string) {
    return await this.contract.getTotalCollateral(asset);
  }

  async getTotalDebt(asset: string) {
    return await this.contract.getTotalDebt(asset);
  }

  // 系统状态查询
  async getVaultCap() {
    return await this.contract.getVaultCap();
  }

  async getVaultCapRemaining() {
    return await this.contract.getVaultCapRemaining();
  }

  async getMinHealthFactor() {
    return await this.contract.getMinHealthFactor();
  }

  // 预览功能
  async previewBorrow(user: string, asset: string, amount: string) {
    return await this.contract.previewBorrow(user, asset, amount);
  }

  async previewRepay(user: string, asset: string, amount: string) {
    return await this.contract.previewRepay(user, asset, amount);
  }

  async previewWithdraw(user: string, asset: string, amount: string) {
    return await this.contract.previewWithdraw(user, asset, amount);
  }

  async previewDeposit(user: string, asset: string, amount: string) {
    return await this.contract.previewDeposit(user, asset, amount);
  }
}
```

#### 3. RewardConsumption - 积分消费管理

```typescript
class RewardConsumptionAPI {
  constructor(contract: Contract) {
    this.contract = contract;
  }

  // 积分消费
  async consumePointsForService(serviceType: number, level: number) {
    return await this.contract.consumePointsForService(serviceType, level);
  }

  // 批量消费
  async batchConsumePoints(
    users: string[],
    serviceTypes: number[],
    levels: number[]
  ) {
    return await this.contract.batchConsumePoints(users, serviceTypes, levels);
  }

  // 用户信息查询
  async getUserBalance(user: string) {
    return await this.contract.getUserBalance(user);
  }

  async getUserPrivilege(user: string) {
    return await this.contract.getUserPrivilege(user);
  }

  async getUserConsumptions(user: string) {
    return await this.contract.getUserConsumptions(user);
  }

  async getUserLastConsumption(user: string, serviceType: number) {
    return await this.contract.getUserLastConsumption(user, serviceType);
  }

  // 服务配置查询
  async getServiceConfig(serviceType: number, level: number) {
    return await this.contract.getServiceConfig(serviceType, level);
  }

  async getServiceUsage(serviceType: number) {
    return await this.contract.getServiceUsage(serviceType);
  }

  // 服务升级
  async upgradeServiceLevel(serviceType: number, newLevel: number) {
    return await this.contract.upgradeServiceLevel(serviceType, newLevel);
  }
}
```

#### 4. PriceOracle - 价格预言机

```typescript
class PriceOracleAPI {
  constructor(contract: Contract) {
    this.contract = contract;
  }

  // 单个价格查询
  async getPrice(asset: string) {
    return await this.contract.getPrice(asset);
  }

  // 批量价格查询
  async getPrices(assets: string[]) {
    return await this.contract.getPrices(assets);
  }

  // 价格有效性检查
  async isPriceValid(asset: string) {
    return await this.contract.isPriceValid(asset);
  }

  // 获取价格时间戳
  async getPriceTimestamp(asset: string) {
    return await this.contract.getPriceTimestamp(asset);
  }
}
```

#### 5. AssetWhitelist - 资产白名单

```typescript
class AssetWhitelistAPI {
  constructor(contract: Contract) {
    this.contract = contract;
  }

  // 检查资产是否在白名单中
  async isAssetAllowed(asset: string) {
    return await this.contract.isAssetAllowed(asset);
  }

  // 获取所有支持的资产
  async getSupportedAssets() {
    return await this.contract.getSupportedAssets();
  }

  // 获取资产配置
  async getAssetConfig(asset: string) {
    return await this.contract.getAssetConfig(asset);
  }
}
```

### 🔄 批量查询优化

```typescript
// 优化前：多次单独调用
const getUserInfo = async (user: string) => {
  const balance = await rewardConsumption.getUserBalance(user);
  const privilege = await rewardConsumption.getUserPrivilege(user);
  const consumptions = await rewardConsumption.getUserConsumptions(user);
  const healthFactor = await vaultView.getHealthFactor(user);
  
  return { balance, privilege, consumptions, healthFactor };
};

// 优化后：并行调用
const getUserInfoOptimized = async (user: string) => {
  const [balance, privilege, consumptions, healthFactor] = await Promise.all([
    rewardConsumption.getUserBalance(user),
    rewardConsumption.getUserPrivilege(user),
    rewardConsumption.getUserConsumptions(user),
    vaultView.getHealthFactor(user)
  ]);
  
  return { balance, privilege, consumptions, healthFactor };
};
```

### 📊 合约调用频率优化

| 操作类型 | 调用频率 | 优化策略 | 缓存策略 |
|---------|---------|---------|---------|
| 价格查询 | 高频 | 批量查询 | 5分钟缓存 |
| 用户状态 | 高频 | 并行查询 | 1分钟缓存 |
| 积分查询 | 中频 | 批量查询 | 30秒缓存 |
| 业务操作 | 低频 | 单次调用 | 实时更新 |
| 配置查询 | 低频 | 本地缓存 | 1小时缓存 |

---

## 🔮 价格预言机集成

### 预言机接口

```solidity
interface IPriceOracle {
  function getPrice(address asset) external view returns (uint256 price, uint256 timestamp, uint256 decimals);
  function getPrices(address[] calldata assets) external view returns (uint256[] memory prices, uint256[] memory timestamps, uint256[] memory decimalsArray);
  function isPriceValid(address asset) external view returns (bool isValid);
}
```

### 价格更新机制

- **更新频率**：每分钟从 Coingecko API 获取价格
- **价格精度**：8 位小数（如 1 USDT = 100000000）
- **有效性检查**：价格年龄不超过 1 小时
- **批量更新**：支持批量更新多个资产价格

### 前端价格处理

```typescript
// 获取资产价格
const getAssetPrice = async (assetAddress: string) => {
  try {
    const [price, timestamp, decimals] = await priceOracle.getPrice(assetAddress);
    return {
      price: price.toString(),
      timestamp: timestamp.toNumber(),
      decimals: decimals.toNumber(),
      isValid: await priceOracle.isPriceValid(assetAddress)
    };
  } catch (error) {
    console.error('Failed to get price:', error);
    return null;
  }
};

// 批量获取价格
const getBatchPrices = async (assetAddresses: string[]) => {
  try {
    const [prices, timestamps, decimalsArray] = await priceOracle.getPrices(assetAddresses);
    return assetAddresses.map((asset, index) => ({
      asset,
      price: prices[index].toString(),
      timestamp: timestamps[index].toNumber(),
      decimals: decimalsArray[index].toNumber()
    }));
  } catch (error) {
    console.error('Failed to get batch prices:', error);
    return [];
  }
};
```

---

## 🔧 核心合约接口

### 1. 抵押管理 (CollateralManager)

```solidity
// 存入抵押物
function depositCollateral(address user, address asset, uint256 amount) external;

// 提取抵押物
function withdrawCollateral(address user, address asset, uint256 amount) external;

// 查询用户抵押余额
function getCollateral(address user, address asset) external view returns (uint256 amount);

// 查询用户总抵押价值
function getUserTotalCollateralValue(address user) external view returns (uint256 totalValue);

// 查询用户指定资产价值
function getUserAssetValue(address user, address asset) external view returns (uint256 value);
```

### 2. 借贷引擎 (LendingEngine)

```solidity
// 借款
function borrow(address user, address asset, uint256 amount, uint256 collateralAdded, uint16 termDays) external;

// 还款
function repay(address user, address asset, uint256 amount) external;

// 查询用户债务
function getDebt(address user, address asset) external view returns (uint256 debt);

// 查询用户总债务价值
function getUserTotalDebtValue(address user) external view returns (uint256 totalValue);

// 查询用户指定资产债务价值
function getUserDebtValue(address user, address asset) external view returns (uint256 value);
```

### 3. 主合约 (CollateralVault)

```solidity
// 存入抵押物
function deposit(address asset, uint256 amount) external;

// 提取抵押物
function withdraw(address asset, uint256 amount) external;

// 借款
function borrow(address asset, uint256 amount) external;

// 还款
function repay(address asset, uint256 amount) external;

// 复合操作：存入并借款
function depositAndBorrow(address collateralAsset, uint256 collateralAmount, address borrowAsset, uint256 borrowAmount) external;

// 复合操作：还款并提取
function repayAndWithdraw(address repayAsset, uint256 repayAmount, address withdrawAsset, uint256 withdrawAmount) external;
```

### 4. 保证金管理 (GuaranteeFundManager)

```solidity
// 查询用户指定资产的锁定保证金
function getLockedGuarantee(address user, address asset) external view returns (uint256 amount);

// 查询指定资产的总保证金
function getTotalGuaranteeByAsset(address asset) external view returns (uint256 totalAmount);

// 查询用户所有保证金资产列表
function getUserGuaranteeAssets(address user) external pure returns (address[] memory assets);

// 批量锁定保证金（仅 VaultCore 可调用）
function batchLockGuarantees(address user, address[] calldata assets, uint256[] calldata amounts) external;

// 批量释放保证金（仅 VaultCore 可调用）
function batchReleaseGuarantees(address user, address[] calldata assets, uint256[] calldata amounts) external;

// 没收用户保证金（仅 VaultCore 可调用）
function forfeitGuarantee(address user, address asset, address feeReceiver) external;
```

---

## 🛡️ 优雅降级监控集成

### 系统概述

优雅降级监控是 RWA 借贷平台的核心健康管理模块，用于监控和管理系统中各个模块的健康状态。当某个模块出现问题时，系统不会完全崩溃，而是使用备用策略继续运行。

#### 核心特性

- 🔍 **健康状态监控**：实时监控各个模块的健康状态
- 📊 **降级事件记录**：记录系统降级事件和原因
- 📈 **统计分析**：提供降级趋势和统计信息
- 📚 **历史记录**：保存降级历史用于分析
- ⚠️ **风险预警**：及时发现模块异常并告警

### 核心合约

```typescript
interface GracefulDegradationContracts {
  gracefulDegradationMonitor: string;  // 优雅降级监控合约
  healthView: string;                  // 健康视图合约
  systemView: string;                  // 系统视图合约
}
```

### 1. 优雅降级监控器 (GracefulDegradationMonitor)

#### 获取降级统计信息

```typescript
const getDegradationStats = async () => {
  try {
    const gracefulDegradationMonitor = new ethers.Contract(
      gracefulDegradationMonitorAddress,
      GRACEFUL_DEGRADATION_MONITOR_ABI,
      provider
    );

    const stats = await gracefulDegradationMonitor.getGracefulDegradationStats();
    
    return {
      totalDegradations: stats.totalDegradations.toString(),
      lastDegradationTime: stats.lastDegradationTime.toNumber(),
      lastDegradedModule: stats.lastDegradedModule,
      lastDegradationReason: stats.lastDegradationReason,
      fallbackValueUsed: stats.fallbackValueUsed.toString(),
      totalFallbackValue: stats.totalFallbackValue.toString(),
      averageFallbackValue: stats.averageFallbackValue.toString()
    };
  } catch (error) {
    console.error('Failed to get degradation stats:', error);
    throw error;
  }
};
```

#### 检查模块健康状态

```typescript
const checkModuleHealth = async (moduleAddress: string) => {
  try {
    const gracefulDegradationMonitor = new ethers.Contract(
      gracefulDegradationMonitorAddress,
      GRACEFUL_DEGRADATION_MONITOR_ABI,
      provider
    );

    const healthStatus = await gracefulDegradationMonitor.getModuleHealthStatus(moduleAddress);
    
    return {
      module: healthStatus.module,
      isHealthy: healthStatus.isHealthy,
      details: healthStatus.details,
      lastCheckTime: healthStatus.lastCheckTime.toNumber(),
      consecutiveFailures: healthStatus.consecutiveFailures.toNumber(),
      totalChecks: healthStatus.totalChecks.toNumber(),
      successRate: healthStatus.successRate.toNumber()
    };
  } catch (error) {
    console.error('Failed to check module health:', error);
    throw error;
  }
};
```

#### 获取降级历史记录

```typescript
const getDegradationHistory = async (limit: number = 10) => {
  try {
    const gracefulDegradationMonitor = new ethers.Contract(
      gracefulDegradationMonitorAddress,
      GRACEFUL_DEGRADATION_MONITOR_ABI,
      provider
    );

    const history = await gracefulDegradationMonitor.getSystemDegradationHistory(limit);
    
    return history.map(event => ({
      module: event.module,
      reason: event.reason,
      fallbackValue: event.fallbackValue.toString(),
      usedFallback: event.usedFallback,
      timestamp: event.timestamp.toNumber(),
      blockNumber: event.blockNumber.toNumber()
    }));
  } catch (error) {
    console.error('Failed to get degradation history:', error);
    throw error;
  }
};
```

#### 获取降级趋势分析

```typescript
const getDegradationTrends = async () => {
  try {
    const gracefulDegradationMonitor = new ethers.Contract(
      gracefulDegradationMonitorAddress,
      GRACEFUL_DEGRADATION_MONITOR_ABI,
      provider
    );

    const trends = await gracefulDegradationMonitor.getSystemDegradationTrends();
    
    return {
      totalEvents: trends.totalEvents.toString(),
      recentEvents: trends.recentEvents.toString(),
      mostFrequentModule: trends.mostFrequentModule,
      averageFallbackValue: trends.averageFallbackValue.toString()
    };
  } catch (error) {
    console.error('Failed to get degradation trends:', error);
    throw error;
  }
};
```

### 2. 健康视图集成 (HealthView)

#### 获取健康状态监控数据

```typescript
const getHealthViewData = async () => {
  try {
    const healthView = new ethers.Contract(
      healthViewAddress,
      HEALTH_VIEW_ABI,
      provider
    );

    const [degradationStats, moduleHealth, degradationHistory, trends] = await Promise.all([
      healthView.getGracefulDegradationStats(),
      healthView.getModuleHealthStatus(criticalModuleAddress),
      healthView.getSystemDegradationHistory(10),
      healthView.getSystemDegradationTrends()
    ]);

    return {
      degradationStats,
      moduleHealth,
      degradationHistory,
      trends
    };
  } catch (error) {
    console.error('Failed to get health view data:', error);
    throw error;
  }
};
```

### 3. 系统视图集成 (SystemView)

#### 获取系统健康状态

```typescript
const getSystemHealthStatus = async () => {
  try {
    const systemView = new ethers.Contract(
      systemViewAddress,
      SYSTEM_VIEW_ABI,
      provider
    );

    const [degradationStats, moduleHealth, degradationHistory] = await Promise.all([
      systemView.getGracefulDegradationStats(),
      systemView.getModuleHealthStatus(criticalModuleAddress),
      systemView.getSystemDegradationHistory(10)
    ]);

    return {
      degradationStats,
      moduleHealth,
      degradationHistory
    };
  } catch (error) {
    console.error('Failed to get system health status:', error);
    throw error;
  }
};
```

### 4. 前端集成最佳实践

#### 优雅降级监控 Hook

```typescript
const useGracefulDegradation = () => {
  const [stats, setStats] = useState<GracefulDegradationStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const healthView = useContract('HealthView');

  const fetchStats = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await healthView.getGracefulDegradationStats();
      setStats(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const checkModuleHealth = async (moduleAddress: string) => {
    try {
      const healthStatus = await healthView.getModuleHealthStatus(moduleAddress);
      return healthStatus;
    } catch (err) {
      throw new Error(`健康检查失败: ${err.message}`);
    }
  };

  const getDegradationHistory = async (limit: number = 10) => {
    try {
      return await healthView.getSystemDegradationHistory(limit);
    } catch (err) {
      throw new Error(`获取历史记录失败: ${err.message}`);
    }
  };

  const getDegradationTrends = async () => {
    try {
      return await healthView.getSystemDegradationTrends();
    } catch (err) {
      throw new Error(`获取趋势分析失败: ${err.message}`);
    }
  };

  useEffect(() => {
    fetchStats();
    // 每5分钟刷新一次
    const interval = setInterval(fetchStats, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return {
    stats,
    isLoading,
    error,
    checkModuleHealth,
    getDegradationHistory,
    getDegradationTrends,
    refreshStats: fetchStats,
  };
};
```

#### 健康状态监控组件

```typescript
const SystemHealthMonitor: React.FC<SystemHealthMonitorProps> = ({
  criticalModules,
  onModuleUnhealthy,
}) => {
  const { stats, checkModuleHealth, isLoading } = useGracefulDegradation();
  const [moduleHealth, setModuleHealth] = useState<Record<string, boolean>>({});

  const checkAllModules = async () => {
    const healthStatus: Record<string, boolean> = {};
    
    for (const module of criticalModules) {
      try {
        const status = await checkModuleHealth(module);
        healthStatus[module] = status.isHealthy;
        
        if (!status.isHealthy && onModuleUnhealthy) {
          onModuleUnhealthy(module, status.details);
        }
      } catch (error) {
        healthStatus[module] = false;
        console.error(`检查模块 ${module} 健康状态失败:`, error);
      }
    }
    
    setModuleHealth(healthStatus);
  };

  useEffect(() => {
    checkAllModules();
    // 每30秒检查一次
    const interval = setInterval(checkAllModules, 30 * 1000);
    return () => clearInterval(interval);
  }, [criticalModules]);

  if (isLoading) {
    return <div>正在检查系统健康状态...</div>;
  }

  return (
    <div className="system-health-monitor">
      <h3>系统健康状态</h3>
      
      {stats && (
        <div className="stats-summary">
          <p>总降级次数: {stats.totalDegradations}</p>
          <p>最后降级时间: {new Date(stats.lastDegradationTime * 1000).toLocaleString()}</p>
          <p>平均降级值: {stats.averageFallbackValue}</p>
        </div>
      )}
      
      <div className="module-health">
        <h4>关键模块状态</h4>
        {criticalModules.map(module => (
          <div key={module} className={`module-status ${moduleHealth[module] ? 'healthy' : 'unhealthy'}`}>
            <span>{module}</span>
            <span>{moduleHealth[module] ? '✅ 健康' : '❌ 异常'}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
```

### 5. 与其他模块的集成

#### 与价格预言机集成

```typescript
const usePriceOracleWithDegradation = () => {
  const { recordDegradationEvent } = useGracefulDegradation();
  
  const getPriceWithFallback = async (asset: string) => {
    try {
      const price = await priceOracle.getPrice(asset);
      return price;
    } catch (error) {
      // 记录降级事件
      await recordDegradationEvent(
        priceOracle.address,
        'Price oracle timeout',
        getFallbackPrice(asset),
        true
      );
      return getFallbackPrice(asset);
    }
  };
  
  return { getPriceWithFallback };
};
```

#### 与清算引擎集成

```typescript
const useLiquidationEngineWithDegradation = () => {
  const { recordDegradationEvent } = useGracefulDegradation();
  
  const liquidateWithFallback = async (user: string) => {
    try {
      await liquidationEngine.liquidate(user);
      return { success: true };
    } catch (error) {
      // 记录降级事件
      await recordDegradationEvent(
        liquidationEngine.address,
        'Liquidation failed',
        0,
        false
      );
      
      // 使用备用清算策略
      return await emergencyLiquidation(user);
    }
  };
  
  return { liquidateWithFallback };
};
```

### 6. 错误处理和重试机制

#### 优雅降级错误处理

```typescript
const useGracefulDegradationWithErrorHandling = () => {
  const { checkModuleHealth } = useGracefulDegradation();
  
  const safeCheckModuleHealth = async (moduleAddress: string) => {
    try {
      return await checkModuleHealth(moduleAddress);
    } catch (error) {
      console.error('健康检查失败:', error);
      // 返回默认健康状态
      return {
        isHealthy: false,
        details: '健康检查失败',
        lastCheckTime: Date.now(),
        consecutiveFailures: 1,
        totalChecks: 1,
        successRate: 0,
      };
    }
  };
  
  return { safeCheckModuleHealth };
};
```

#### 缓存策略

```typescript
const useCachedHealthData = () => {
  const [cachedData, setCachedData] = useState<Record<string, any>>({});
  const { checkModuleHealth } = useGracefulDegradation();
  
  const getCachedHealthStatus = async (moduleAddress: string) => {
    const cacheKey = `health_${moduleAddress}`;
    const cached = cachedData[cacheKey];
    
    // 如果缓存时间小于5分钟，使用缓存数据
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
      return cached.data;
    }
    
    // 获取新数据并缓存
    const healthStatus = await checkModuleHealth(moduleAddress);
    setCachedData(prev => ({
      ...prev,
      [cacheKey]: {
        data: healthStatus,
        timestamp: Date.now(),
      },
    }));
    
    return healthStatus;
  };
  
  return { getCachedHealthStatus };
};
```

### 7. 监控指标和告警

#### 关键监控指标

```typescript
const GRACEFUL_DEGRADATION_METRICS = {
  // 降级频率
  DEGRADATION_FREQUENCY: 'degradation_frequency',
  
  // 模块健康率
  MODULE_HEALTH_RATE: 'module_health_rate',
  
  // 平均降级值
  AVERAGE_FALLBACK_VALUE: 'average_fallback_value',
  
  // 最频繁降级模块
  MOST_FREQUENT_DEGRADED_MODULE: 'most_frequent_degraded_module',
  
  // 连续失败次数
  CONSECUTIVE_FAILURES: 'consecutive_failures',
  
  // 成功率
  SUCCESS_RATE: 'success_rate',
};
```

#### 告警阈值配置

```typescript
const DEGRADATION_ALERT_THRESHOLDS = {
  // 24小时内超过10次降级
  HIGH_DEGRADATION_FREQUENCY: 10,
  
  // 模块健康率低于80%
  MODULE_HEALTH_RATE: 0.8,
  
  // 连续失败超过3次
  CONSECUTIVE_FAILURES: 3,
  
  // 平均降级值过高
  HIGH_AVERAGE_FALLBACK_VALUE: 1000,
};
```

#### 告警处理

```typescript
const useDegradationAlerts = () => {
  const { stats } = useGracefulDegradation();
  
  useEffect(() => {
    if (stats) {
      const recentDegradations = stats.totalDegradations;
      
      if (recentDegradations > DEGRADATION_ALERT_THRESHOLDS.HIGH_DEGRADATION_FREQUENCY) {
        sendAlert({
          level: 'high',
          message: `系统降级频率过高: ${recentDegradations} 次`,
          category: 'degradation',
        });
      } else if (recentDegradations > 5) {
        sendAlert({
          level: 'medium',
          message: `系统降级次数增加: ${recentDegradations} 次`,
          category: 'degradation',
        });
      }
    }
  }, [stats]);
};
```

---

## 🎁 Reward 系统集成

### 系统概述

Reward 系统是一个完整的用户激励和特权管理系统，包括：

1. **积分奖励**：用户通过借贷活动获得积分
2. **服务消费**：用户使用积分购买特权服务
3. **服务配置**：管理员配置各种服务的价格和功能
4. **用户等级**：基于积分和行为的用户等级系统

### 核心合约

```typescript
interface RewardContracts {
  rewardManager: string;        // 积分管理合约
  rewardPoints: string;         // 积分代币合约
  rewardConsumption: string;    // 积分消费合约
  serviceConfigs: {             // 服务配置合约
    featureUnlock: string;      // 功能解锁服务
    governanceAccess: string;   // 治理访问服务
    priorityService: string;    // 优先服务
    advancedAnalytics: string;  // 高级分析服务
    testnetFeatures: string;    // 测试网功能
  };
}
```

### 1. 积分管理 (RewardManager)

#### 获取用户积分信息

```typescript
const getUserRewardInfo = async (userAddress: string) => {
  try {
    const rewardManager = new ethers.Contract(
      rewardManagerAddress,
      REWARD_MANAGER_ABI,
      provider
    );

    const [points, level, lastUpdateTime] = await Promise.all([
      rewardManager.getUserPoints(userAddress),
      rewardManager.getUserLevel(userAddress),
      rewardManager.getUserLastUpdateTime(userAddress)
    ]);

    return {
      points: points.toString(),
      level: level.toNumber(),
      lastUpdateTime: lastUpdateTime.toNumber()
    };
  } catch (error) {
    console.error('Failed to get user reward info:', error);
    throw error;
  }
};
```

#### 获取奖励参数

```typescript
const getRewardParameters = async () => {
  try {
    const rewardManager = new ethers.Contract(
      rewardManagerAddress,
      REWARD_MANAGER_ABI,
      provider
    );

    const [
      basePointPerHundredUsd,
      durationPointPerDay,
      earlyRepayBonus,
      basePointPerEth
    ] = await Promise.all([
      rewardManager.basePointPerHundredUsd(),
      rewardManager.durationPointPerDay(),
      rewardManager.earlyRepayBonus(),
      rewardManager.basePointPerEth()
    ]);

    return {
      basePointPerHundredUsd: basePointPerHundredUsd.toString(),
      durationPointPerDay: durationPointPerDay.toString(),
      earlyRepayBonus: earlyRepayBonus.toString(),
      basePointPerEth: basePointPerEth.toString()
    };
  } catch (error) {
    console.error('Failed to get reward parameters:', error);
    throw error;
  }
};
```

#### 计算预期积分

```typescript
const calculateExpectedReward = async (
  userAddress: string,
  operation: 'deposit' | 'borrow' | 'repay',
  amount: string,
  asset: string
) => {
  try {
    const rewardManager = new ethers.Contract(
      rewardManagerAddress,
      REWARD_MANAGER_ABI,
      provider
    );

    // 获取资产价格
    const priceOracle = new ethers.Contract(
      priceOracleAddress,
      PRICE_ORACLE_ABI,
      provider
    );
    const [price] = await priceOracle.getPrice(asset);
    
    // 计算预期积分
    const expectedPoints = await rewardManager.calculateExpectedReward(
      userAddress,
      operation,
      amount,
      price
    );

    return expectedPoints.toString();
  } catch (error) {
    console.error('Failed to calculate expected reward:', error);
    throw error;
  }
};
```

### 2. 积分代币 (RewardPoints)

#### 查询积分余额

```typescript
const getPointsBalance = async (userAddress: string) => {
  try {
    const rewardPoints = new ethers.Contract(
      rewardPointsAddress,
      REWARD_POINTS_ABI,
      provider
    );

    const balance = await rewardPoints.balanceOf(userAddress);
    return balance.toString();
  } catch (error) {
    console.error('Failed to get points balance:', error);
    throw error;
  }
};
```

#### 查询积分历史

```typescript
const getPointsHistory = async (userAddress: string) => {
  try {
    const rewardPoints = new ethers.Contract(
      rewardPointsAddress,
      REWARD_POINTS_ABI,
      provider
    );

    // 获取积分铸造事件
    const mintFilter = rewardPoints.filters.Transfer(
      ethers.constants.AddressZero,
      userAddress
    );
    const mintEvents = await rewardPoints.queryFilter(mintFilter);

    // 获取积分消费事件
    const burnFilter = rewardPoints.filters.Transfer(
      userAddress,
      ethers.constants.AddressZero
    );
    const burnEvents = await rewardPoints.queryFilter(burnFilter);

    return {
      mints: mintEvents.map(event => ({
        amount: event.args?.value.toString(),
        timestamp: event.blockNumber
      })),
      burns: burnEvents.map(event => ({
        amount: event.args?.value.toString(),
        timestamp: event.blockNumber
      }))
    };
  } catch (error) {
    console.error('Failed to get points history:', error);
    throw error;
  }
};
```

### 3. 服务配置管理

#### 获取服务配置

```typescript
const getServiceConfig = async (serviceType: number, level: number) => {
  try {
    // 根据服务类型获取对应的配置合约
    const serviceConfigAddress = getServiceConfigAddress(serviceType);
    const serviceConfig = new ethers.Contract(
      serviceConfigAddress,
      SERVICE_CONFIG_ABI,
      provider
    );

    const config = await serviceConfig.getConfig(level);
    
    return {
      price: config.price.toString(),
      duration: config.duration.toString(),
      isActive: config.isActive,
      level: config.level.toNumber(),
      description: config.description
    };
  } catch (error) {
    console.error('Failed to get service config:', error);
    throw error;
  }
};

const getServiceConfigAddress = (serviceType: number) => {
  const serviceConfigs = {
    0: '0x...', // FeatureUnlock
    1: '0x...', // GovernanceAccess
    2: '0x...', // PriorityService
    3: '0x...', // AdvancedAnalytics
    4: '0x...'  // TestnetFeatures
  };
  return serviceConfigs[serviceType];
};
```

#### 获取所有服务配置

```typescript
const getAllServiceConfigs = async () => {
  try {
    const serviceTypes = [0, 1, 2, 3, 4]; // 所有服务类型
    const levels = [0, 1, 2, 3]; // 所有等级

    const allConfigs = {};

    for (const serviceType of serviceTypes) {
      allConfigs[serviceType] = {};
      
      for (const level of levels) {
        const config = await getServiceConfig(serviceType, level);
        allConfigs[serviceType][level] = config;
      }
    }

    return allConfigs;
  } catch (error) {
    console.error('Failed to get all service configs:', error);
    throw error;
  }
};
```

### 4. 积分消费 (RewardConsumption)

#### 消费服务

```typescript
const consumeService = async (
  serviceType: number,
  level: number,
  points: string
) => {
  try {
    const rewardConsumption = new ethers.Contract(
      rewardConsumptionAddress,
      REWARD_CONSUMPTION_ABI,
      signer
    );

    // 检查积分余额
    const balance = await getPointsBalance(userAddress);
    if (ethers.BigNumber.from(balance).lt(points)) {
      throw new Error('Insufficient points');
    }

    // 执行消费
    const tx = await rewardConsumption.consumeService(serviceType, level, points);
    const receipt = await tx.wait();

    // 监听消费事件
    const consumeEvent = receipt.events?.find(e => e.event === 'ServiceConsumed');
    console.log('Service consumed:', consumeEvent?.args);

    return receipt;
  } catch (error) {
    console.error('Failed to consume service:', error);
    throw error;
  }
};
```

#### 查询用户特权

```typescript
const getUserPrivileges = async (userAddress: string) => {
  try {
    const rewardConsumption = new ethers.Contract(
      rewardConsumptionAddress,
      REWARD_CONSUMPTION_ABI,
      provider
    );

    const serviceTypes = [0, 1, 2, 3, 4];
    const privileges = {};

    for (const serviceType of serviceTypes) {
      const privilege = await rewardConsumption.getUserPrivilege(
        userAddress,
        serviceType
      );
      
      privileges[serviceType] = {
        level: privilege.level.toNumber(),
        isActive: privilege.isActive,
        expirationTime: privilege.expirationTime.toNumber()
      };
    }

    return privileges;
  } catch (error) {
    console.error('Failed to get user privileges:', error);
    throw error;
  }
};
```

#### 查询消费记录

```typescript
const getConsumptionRecords = async (userAddress: string) => {
  try {
    const rewardConsumption = new ethers.Contract(
      rewardConsumptionAddress,
      REWARD_CONSUMPTION_ABI,
      provider
    );

    const records = await rewardConsumption.getUserConsumptions(userAddress);
    
    return records.map(record => ({
      points: record.points.toString(),
      timestamp: record.timestamp.toNumber(),
      serviceType: record.serviceType.toNumber(),
      serviceLevel: record.serviceLevel.toNumber(),
      isActive: record.isActive,
      expirationTime: record.expirationTime.toNumber()
    }));
  } catch (error) {
    console.error('Failed to get consumption records:', error);
    throw error;
  }
};
```

### 5. 服务类型和等级

```typescript
enum ServiceType {
  FeatureUnlock = 0,      // 功能解锁服务
  GovernanceAccess = 1,   // 治理访问服务
  PriorityService = 2,    // 优先服务
  AdvancedAnalytics = 3,  // 高级分析服务
  TestnetFeatures = 4     // 测试网功能
}

enum ServiceLevel {
  Basic = 0,      // 基础等级
  Standard = 1,   // 标准等级
  Premium = 2,    // 高级等级
  VIP = 3         // VIP等级
}

const getServiceTypeName = (serviceType: number) => {
  const names = {
    0: 'Feature Unlock',
    1: 'Governance Access',
    2: 'Priority Service',
    3: 'Advanced Analytics',
    4: 'Testnet Features'
  };
  return names[serviceType] || 'Unknown';
};

const getServiceLevelName = (level: number) => {
  const names = {
    0: 'Basic',
    1: 'Standard',
    2: 'Premium',
    3: 'VIP'
  };
  return names[level] || 'Unknown';
};
```

### 6. 用户操作流程

#### 查看积分和特权

```typescript
const getUserRewardDashboard = async (userAddress: string) => {
  try {
    const [rewardInfo, pointsBalance, privileges, consumptionRecords] = await Promise.all([
      getUserRewardInfo(userAddress),
      getPointsBalance(userAddress),
      getUserPrivileges(userAddress),
      getConsumptionRecords(userAddress)
    ]);

    return {
      rewardInfo,
      pointsBalance,
      privileges,
      consumptionRecords,
      // 计算可用服务
      availableServices: calculateAvailableServices(privileges, pointsBalance)
    };
  } catch (error) {
    console.error('Failed to get reward dashboard:', error);
    throw error;
  }
};

const calculateAvailableServices = (privileges: any, pointsBalance: string) => {
  const availableServices = [];
  
  // 遍历所有服务类型和等级
  for (let serviceType = 0; serviceType < 5; serviceType++) {
    for (let level = 0; level < 4; level++) {
      const config = await getServiceConfig(serviceType, level);
      
      if (config.isActive && ethers.BigNumber.from(pointsBalance).gte(config.price)) {
        availableServices.push({
          serviceType,
          level,
          serviceName: getServiceTypeName(serviceType),
          levelName: getServiceLevelName(level),
          price: config.price,
          description: config.description
        });
      }
    }
  }
  
  return availableServices;
};
```

#### 购买服务

```typescript
const purchaseService = async (
  serviceType: number,
  level: number
) => {
  try {
    // 1. 获取服务配置
    const config = await getServiceConfig(serviceType, level);
    
    if (!config.isActive) {
      throw new Error('Service is not active');
    }

    // 2. 检查积分余额
    const balance = await getPointsBalance(userAddress);
    if (ethers.BigNumber.from(balance).lt(config.price)) {
      throw new Error('Insufficient points');
    }

    // 3. 消费服务
    const receipt = await consumeService(serviceType, level, config.price);

    // 4. 更新用户界面
    await updateUserInterface();

    return {
      success: true,
      receipt,
      serviceType,
      level,
      pointsSpent: config.price,
      duration: config.duration
    };
  } catch (error) {
    console.error('Failed to purchase service:', error);
    throw error;
  }
};
```

### 7. 事件监听

```typescript
const setupRewardEventListeners = () => {
  // 监听积分奖励事件
  rewardManager.on('RewardEarned', (user, points, reason, timestamp) => {
    console.log('Reward earned:', {
      user,
      points: points.toString(),
      reason,
      timestamp: timestamp.toString()
    });
  });

  // 监听用户等级更新事件
  rewardManager.on('UserLevelUpdated', (actionKey, user, oldLevel, newLevel, updatedBy, timestamp) => {
    console.log('User level updated:', {
      user,
      oldLevel: oldLevel.toNumber(),
      newLevel: newLevel.toNumber(),
      updatedBy,
      timestamp: timestamp.toString()
    });
  });

  // 监听服务消费事件
  rewardConsumption.on('ServiceConsumed', (user, serviceType, level, points, timestamp) => {
    console.log('Service consumed:', {
      user,
      serviceType: serviceType.toNumber(),
      level: level.toNumber(),
      points: points.toString(),
      timestamp: timestamp.toString()
    });
  });

  // 监听服务配置更新事件
  rewardConsumption.on('ServiceConfigUpdated', (serviceType, level, price, duration) => {
    console.log('Service config updated:', {
      serviceType: serviceType.toNumber(),
      level: level.toNumber(),
      price: price.toString(),
      duration: duration.toString()
    });
  });

  // 监听用户特权更新事件
  rewardConsumption.on('UserPrivilegeUpdated', (user, serviceType, level, granted) => {
    console.log('User privilege updated:', {
      user,
      serviceType: serviceType.toNumber(),
      level: level.toNumber(),
      granted
    });
  });
};
```

### 8. 错误处理

```typescript
enum RewardErrors {
  INSUFFICIENT_POINTS = 'InsufficientPoints',
  SERVICE_NOT_ACTIVE = 'ServiceNotActive',
  INVALID_SERVICE_TYPE = 'InvalidServiceType',
  INVALID_SERVICE_LEVEL = 'InvalidServiceLevel',
  PRIVILEGE_EXPIRED = 'PrivilegeExpired',
  COOLDOWN_NOT_MET = 'CooldownNotMet'
}

const handleRewardError = (error: any) => {
  if (error.code === 'CALL_EXCEPTION') {
    const errorData = error.data;
    const decodedError = decodeRevertError(errorData);
    
    switch (decodedError.errorName) {
      case RewardErrors.INSUFFICIENT_POINTS:
        return 'Insufficient points for this service';
      case RewardErrors.SERVICE_NOT_ACTIVE:
        return 'Service is not currently active';
      case RewardErrors.INVALID_SERVICE_TYPE:
        return 'Invalid service type';
      case RewardErrors.INVALID_SERVICE_LEVEL:
        return 'Invalid service level';
      case RewardErrors.PRIVILEGE_EXPIRED:
        return 'Service privilege has expired';
      case RewardErrors.COOLDOWN_NOT_MET:
        return 'Service cooldown period not met';
      default:
        return 'Reward operation failed';
    }
  }
  
  return error.message || 'Unknown reward error';
};
```

---

## 👤 用户操作流程

### 1. 存入抵押物

```typescript
const depositCollateral = async (assetAddress: string, amount: string) => {
  try {
    // 1. 验证资产是否在白名单中
    const isAllowed = await assetWhitelist.isAssetAllowed(assetAddress);
    if (!isAllowed) {
      throw new Error('Asset not allowed');
    }

    // 2. 获取用户授权
    const tokenContract = new ethers.Contract(assetAddress, ERC20_ABI, signer);
    const allowance = await tokenContract.allowance(userAddress, vaultAddress);
    
    if (allowance.lt(amount)) {
      const approveTx = await tokenContract.approve(vaultAddress, amount);
      await approveTx.wait();
    }

    // 3. 执行存入操作
    const vaultContract = new ethers.Contract(vaultAddress, VAULT_ABI, signer);
    const tx = await vaultContract.deposit(assetAddress, amount);
    const receipt = await tx.wait();

    // 4. 监听事件
    const depositEvent = receipt.events?.find(e => e.event === 'Deposit');
    console.log('Deposit successful:', depositEvent?.args);

    return receipt;
  } catch (error) {
    console.error('Deposit failed:', error);
    throw error;
  }
};
```

### 2. 借款

```typescript
const borrowAsset = async (assetAddress: string, amount: string) => {
  try {
    // 1. 验证资产是否在白名单中
    const isAllowed = await assetWhitelist.isAssetAllowed(assetAddress);
    if (!isAllowed) {
      throw new Error('Asset not allowed');
    }

    // 2. 检查健康因子
    const healthFactor = await calculateHealthFactor(userAddress);
    if (healthFactor < minHealthFactor) {
      throw new Error('Health factor too low');
    }

    // 3. 执行借款操作
    const vaultContract = new ethers.Contract(vaultAddress, VAULT_ABI, signer);
    const tx = await vaultContract.borrow(assetAddress, amount);
    const receipt = await tx.wait();

    // 4. 监听事件
    const borrowEvent = receipt.events?.find(e => e.event === 'Borrow');
    console.log('Borrow successful:', borrowEvent?.args);

    return receipt;
  } catch (error) {
    console.error('Borrow failed:', error);
    throw error;
  }
};
```

### 5. 保证金查询

```typescript
// 查询用户保证金信息
const getGuaranteeInfo = async (userAddress: string, assetAddress: string) => {
  try {
    const guaranteeManager = new ethers.Contract(
      guaranteeManagerAddress,
      GUARANTEE_MANAGER_ABI,
      provider
    );

    const [lockedAmount, totalByAsset, userAssets] = await Promise.all([
      guaranteeManager.getLockedGuarantee(userAddress, assetAddress),
      guaranteeManager.getTotalGuaranteeByAsset(assetAddress),
      guaranteeManager.getUserGuaranteeAssets(userAddress)
    ]);

    return {
      lockedAmount: lockedAmount.toString(),
      totalByAsset: totalByAsset.toString(),
      userAssets: userAssets
    };
  } catch (error) {
    console.error('Failed to get guarantee info:', error);
    throw error;
  }
};

// 查询用户所有保证金
const getUserAllGuarantees = async (userAddress: string) => {
  try {
    const guaranteeManager = new ethers.Contract(
      guaranteeManagerAddress,
      GUARANTEE_MANAGER_ABI,
      provider
    );

    const userAssets = await guaranteeManager.getUserGuaranteeAssets(userAddress);
    const guarantees = await Promise.all(
      userAssets.map(async (asset: string) => {
        const amount = await guaranteeManager.getLockedGuarantee(userAddress, asset);
        return {
          asset,
          amount: amount.toString()
        };
      })
    );

    return guarantees;
  } catch (error) {
    console.error('Failed to get user guarantees:', error);
    throw error;
  }
};
```

### 3. 还款

```typescript
const repayAsset = async (assetAddress: string, amount: string) => {
  try {
    // 1. 验证资产是否在白名单中
    const isAllowed = await assetWhitelist.isAssetAllowed(assetAddress);
    if (!isAllowed) {
      throw new Error('Asset not allowed');
    }

    // 2. 获取用户授权
    const tokenContract = new ethers.Contract(assetAddress, ERC20_ABI, signer);
    const allowance = await tokenContract.allowance(userAddress, vaultAddress);
    
    if (allowance.lt(amount)) {
      const approveTx = await tokenContract.approve(vaultAddress, amount);
      await approveTx.wait();
    }

    // 3. 执行还款操作
    const vaultContract = new ethers.Contract(vaultAddress, VAULT_ABI, signer);
    const tx = await vaultContract.repay(assetAddress, amount);
    const receipt = await tx.wait();

    // 4. 监听事件
    const repayEvent = receipt.events?.find(e => e.event === 'Repay');
    console.log('Repay successful:', repayEvent?.args);

    return receipt;
  } catch (error) {
    console.error('Repay failed:', error);
    throw error;
  }
};
```

### 4. 复合操作

```typescript
// 存入并借款
const depositAndBorrow = async (
  collateralAsset: string,
  collateralAmount: string,
  borrowAsset: string,
  borrowAmount: string
) => {
  try {
    // 1. 验证两个资产都在白名单中
    const [collateralAllowed, borrowAllowed] = await Promise.all([
      assetWhitelist.isAssetAllowed(collateralAsset),
      assetWhitelist.isAssetAllowed(borrowAsset)
    ]);

    if (!collateralAllowed || !borrowAllowed) {
      throw new Error('Asset not allowed');
    }

    // 2. 获取抵押资产授权
    const collateralToken = new ethers.Contract(collateralAsset, ERC20_ABI, signer);
    const allowance = await collateralToken.allowance(userAddress, vaultAddress);
    
    if (allowance.lt(collateralAmount)) {
      const approveTx = await collateralToken.approve(vaultAddress, collateralAmount);
      await approveTx.wait();
    }

    // 3. 执行复合操作
    const vaultContract = new ethers.Contract(vaultAddress, VAULT_ABI, signer);
    const tx = await vaultContract.depositAndBorrow(
      collateralAsset,
      collateralAmount,
      borrowAsset,
      borrowAmount
    );
    const receipt = await tx.wait();

    return receipt;
  } catch (error) {
    console.error('Deposit and borrow failed:', error);
    throw error;
  }
};
```

---

## ⚠️ 错误处理

### 常见错误类型

```typescript
enum VaultErrors {
  AMOUNT_IS_ZERO = 'AmountIsZero',
  INSUFFICIENT_COLLATERAL = 'InsufficientCollateral',
  HEALTH_FACTOR_TOO_LOW = 'HealthFactorTooLow',
  ASSET_NOT_ALLOWED = 'AssetNotAllowed',
  PRICE_ORACLE_ASSET_NOT_SUPPORTED = 'PriceOracle__AssetNotSupported',
  PRICE_ORACLE_STALE_PRICE = 'PriceOracle__StalePrice',
  PRICE_ORACLE_INVALID_PRICE = 'PriceOracle__InvalidPrice',
  EXTERNAL_MODULE_REVERTED = 'ExternalModuleRevertedRaw'
}
```

### 错误处理函数

```typescript
const handleVaultError = (error: any) => {
  if (error.code === 'CALL_EXCEPTION') {
    // 解析 revert 错误
    const errorData = error.data;
    const decodedError = decodeRevertError(errorData);
    
    switch (decodedError.errorName) {
      case VaultErrors.AMOUNT_IS_ZERO:
        return 'Amount cannot be zero';
      case VaultErrors.INSUFFICIENT_COLLATERAL:
        return 'Insufficient collateral';
      case VaultErrors.HEALTH_FACTOR_TOO_LOW:
        return 'Health factor too low';
      case VaultErrors.ASSET_NOT_ALLOWED:
        return 'Asset not allowed';
      case VaultErrors.PRICE_ORACLE_ASSET_NOT_SUPPORTED:
        return 'Asset not supported by price oracle';
      case VaultErrors.PRICE_ORACLE_STALE_PRICE:
        return 'Price data is stale';
      case VaultErrors.PRICE_ORACLE_INVALID_PRICE:
        return 'Invalid price data';
      default:
        return 'Transaction failed';
    }
  }
  
  return error.message || 'Unknown error';
};

const decodeRevertError = (errorData: string) => {
  // 实现错误解码逻辑
  // 这里需要根据具体的错误格式来实现
  return { errorName: 'Unknown', errorArgs: [] };
};
```

---

## 🔒 安全最佳实践

### 1. 输入验证

```typescript
const validateInputs = (assetAddress: string, amount: string) => {
  // 验证地址格式
  if (!ethers.utils.isAddress(assetAddress)) {
    throw new Error('Invalid asset address');
  }

  // 验证金额格式
  if (!amount || amount === '0') {
    throw new Error('Amount must be greater than 0');
  }

  // 验证金额精度
  const amountBN = ethers.BigNumber.from(amount);
  if (amountBN.isZero()) {
    throw new Error('Amount cannot be zero');
  }
};
```

### 2. 价格验证

```typescript
const validatePrice = async (assetAddress: string) => {
  const priceData = await getAssetPrice(assetAddress);
  
  if (!priceData || !priceData.isValid) {
    throw new Error('Invalid or stale price data');
  }
  
  // 检查价格是否在合理范围内
  const price = parseFloat(priceData.price) / Math.pow(10, priceData.decimals);
  if (price <= 0 || price > 1000000) { // 假设最大价格为 1,000,000
    throw new Error('Price out of reasonable range');
  }
  
  return priceData;
};
```

### 3. 健康因子监控

```typescript
const monitorHealthFactor = async (userAddress: string) => {
  const healthFactor = await calculateHealthFactor(userAddress);
  const minHealthFactor = await vaultContract.minHealthFactor();
  
  if (healthFactor < minHealthFactor) {
    console.warn('Health factor below minimum:', healthFactor.toString());
    return false;
  }
  
  return true;
};
```

### 4. 交易确认

```typescript
const waitForTransaction = async (tx: any, confirmations: number = 1) => {
  try {
    const receipt = await tx.wait(confirmations);
    
    // 验证交易状态
    if (receipt.status === 0) {
      throw new Error('Transaction failed');
    }
    
    return receipt;
  } catch (error) {
    console.error('Transaction failed:', error);
    throw error;
  }
};
```

---

## 🧪 测试指南

### 1. 单元测试

```typescript
describe('Vault Integration', () => {
  it('should deposit collateral successfully', async () => {
    const assetAddress = '0x...'; // 测试资产地址
    const amount = ethers.utils.parseEther('100');
    
    const tx = await vaultContract.deposit(assetAddress, amount);
    const receipt = await tx.wait();
    
    expect(receipt.status).to.equal(1);
    
    const depositEvent = receipt.events?.find(e => e.event === 'Deposit');
    expect(depositEvent).to.not.be.undefined;
    expect(depositEvent.args.user).to.equal(userAddress);
    expect(depositEvent.args.asset).to.equal(assetAddress);
    expect(depositEvent.args.amount).to.equal(amount);
  });
});
```

### 2. 集成测试

```typescript
describe('Multi-Asset Operations', () => {
  it('should handle multiple assets correctly', async () => {
    const assets = ['0x...', '0x...', '0x...']; // 测试资产列表
    
    for (const asset of assets) {
      // 验证资产是否支持
      const isSupported = await priceOracle.isPriceValid(asset);
      expect(isSupported).to.be.true;
      
      // 测试存入操作
      const amount = ethers.utils.parseEther('10');
      const tx = await vaultContract.deposit(asset, amount);
      await tx.wait();
      
      // 验证余额
      const balance = await collateralManager.getCollateral(userAddress, asset);
      expect(balance).to.equal(amount);
    }
  });
});
```

### 3. 压力测试

```typescript
describe('Price Oracle Stress Test', () => {
  it('should handle price updates correctly', async () => {
    const assets = await priceOracle.getSupportedAssets();
    
    // 批量获取价格
    const prices = await priceOracle.getPrices(assets);
    
    expect(prices.prices.length).to.equal(assets.length);
    expect(prices.timestamps.length).to.equal(assets.length);
    
    // 验证价格有效性
    for (let i = 0; i < assets.length; i++) {
      const isValid = await priceOracle.isPriceValid(assets[i]);
      expect(isValid).to.be.true;
    }
  });
});
```

---

## 📊 监控和日志

### 1. 事件监听

```typescript
const setupEventListeners = () => {
  // 监听价格更新事件
  priceOracle.on('PriceUpdated', (asset, price, timestamp) => {
    console.log('Price updated:', {
      asset,
      price: price.toString(),
      timestamp: timestamp.toString()
    });
  });
  
  // 监听用户操作事件
  vaultContract.on('Deposit', (user, asset, amount) => {
    console.log('User deposited:', {
      user,
      asset,
      amount: amount.toString()
    });
  });
  
  vaultContract.on('Borrow', (user, asset, amount) => {
    console.log('User borrowed:', {
      user,
      asset,
      amount: amount.toString()
    });
  });
  
  // 监听保证金相关事件
  guaranteeManager.on('GuaranteeLocked', (user, asset, amount, timestamp) => {
    console.log('Guarantee locked:', {
      user,
      asset,
      amount: amount.toString(),
      timestamp: timestamp.toString()
    });
  });
  
  guaranteeManager.on('GuaranteeReleased', (user, asset, amount, timestamp) => {
    console.log('Guarantee released:', {
      user,
      asset,
      amount: amount.toString(),
      timestamp: timestamp.toString()
    });
  });
  
  guaranteeManager.on('GuaranteeForfeited', (user, asset, amount, feeReceiver, timestamp) => {
    console.log('Guarantee forfeited:', {
      user,
      asset,
      amount: amount.toString(),
      feeReceiver,
      timestamp: timestamp.toString()
    });
  });
  
  // 监听标准化动作事件
  vaultContract.on('ActionExecuted', (actionKey, actionString, caller, timestamp) => {
    console.log('Action executed:', {
      actionKey,
      actionString,
      caller,
      timestamp: timestamp.toString()
    });
  });
};
```

### 2. 性能监控

```typescript
const monitorPerformance = async () => {
  const startTime = Date.now();
  
  try {
    await performOperation();
    const endTime = Date.now();
    console.log(`Operation completed in ${endTime - startTime}ms`);
  } catch (error) {
    console.error('Operation failed:', error);
  }
};
```

---

## 🔄 更新日志

### v3.0.0 (2025-01-27) - 架构重构版本
- ✅ **采用方式1架构**：直接调用多个合约，优化 Gas 费用
- ✅ **架构清晰化**：每个合约职责明确，便于维护和升级
- ✅ **灵活性提升**：用户可以根据需要选择调用哪些功能
- ✅ **调试友好**：问题定位更容易，错误处理更精确
- ✅ **批量查询优化**：实现并行查询和缓存策略
- ✅ **性能监控**：添加性能跟踪和错误处理优化
- ✅ **Gas 费用优化**：减少中间层调用，降低 gas 消耗

### v2.2.0 (2025-01-27)
- ✅ 集成完整的 Reward 积分奖励系统
- ✅ 添加积分管理、消费、特权管理功能
- ✅ 实现服务配置管理系统
- ✅ 支持 5 种服务类型和 4 个等级
- ✅ 添加积分历史查询和用户等级系统
- ✅ 实现服务购买和特权验证功能
- ✅ 更新前端集成规则以支持 Reward 系统

### v2.1.0 (2025-01-27)
- ✅ 集成保证金管理系统
- ✅ 添加保证金查询接口
- ✅ 实现标准化动作事件监听
- ✅ 支持保证金锁定、释放、没收事件
- ✅ 更新前端集成规则以支持保证金操作

### v2.0.0 (2025-01-27)
- ✅ 添加多资产支持
- ✅ 集成 Coingecko 价格预言机
- ✅ 更新所有合约接口以支持资产参数
- ✅ 添加资产白名单管理
- ✅ 实现实时价格计算
- ✅ 更新事件定义以支持多资产

### v1.0.0 (2024-12-XX)
- ✅ 基础借贷功能
- ✅ 单资产支持
- ✅ 基础安全机制

---

## ⚡ 性能优化

### 🚀 Gas 费用优化策略

#### 1. 批量操作优化

```typescript
// 优化前：多次单独调用
const depositMultipleAssets = async (assets: string[], amounts: string[]) => {
  for (let i = 0; i < assets.length; i++) {
    await vaultCore.deposit(assets[i], amounts[i]);
  }
};

// 优化后：批量调用
const depositMultipleAssetsOptimized = async (assets: string[], amounts: string[]) => {
  await vaultCore.batchDeposit(assets, amounts);
};
```

#### 2. 并行查询优化

```typescript
// 优化前：串行查询
const getUserDashboard = async (user: string) => {
  const balance = await rewardConsumption.getUserBalance(user);
  const privilege = await rewardConsumption.getUserPrivilege(user);
  const healthFactor = await vaultView.getHealthFactor(user);
  const totalCollateral = await vaultView.getUserTotalCollateral(user);
  
  return { balance, privilege, healthFactor, totalCollateral };
};

// 优化后：并行查询
const getUserDashboardOptimized = async (user: string) => {
  const [balance, privilege, healthFactor, totalCollateral] = await Promise.all([
    rewardConsumption.getUserBalance(user),
    rewardConsumption.getUserPrivilege(user),
    vaultView.getHealthFactor(user),
    vaultView.getUserTotalCollateral(user)
  ]);
  
  return { balance, privilege, healthFactor, totalCollateral };
};
```

#### 3. 缓存策略

```typescript
class CacheManager {
  private cache = new Map<string, { data: any; timestamp: number; ttl: number }>();

  set(key: string, data: any, ttl: number = 60000) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }

  get(key: string) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    if (Date.now() - item.timestamp > item.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return item.data;
  }

  clear() {
    this.cache.clear();
  }
}

// 使用缓存优化价格查询
const priceCache = new CacheManager();

const getAssetPriceWithCache = async (asset: string) => {
  const cacheKey = `price_${asset}`;
  const cached = priceCache.get(cacheKey);
  
  if (cached) {
    return cached;
  }
  
  const price = await priceOracle.getPrice(asset);
  priceCache.set(cacheKey, price, 300000); // 5分钟缓存
  
  return price;
};
```

### 📊 性能监控

```typescript
class PerformanceMonitor {
  private metrics: Map<string, number[]> = new Map();

  trackOperation(operation: string, duration: number) {
    if (!this.metrics.has(operation)) {
      this.metrics.set(operation, []);
    }
    
    this.metrics.get(operation)!.push(duration);
    
    // 只保留最近100次记录
    if (this.metrics.get(operation)!.length > 100) {
      this.metrics.get(operation)!.shift();
    }
  }

  getAverageDuration(operation: string): number {
    const durations = this.metrics.get(operation) || [];
    if (durations.length === 0) return 0;
    
    return durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  }

  getSlowestOperations(): Array<{ operation: string; avgDuration: number }> {
    const results = [];
    
    for (const [operation, durations] of this.metrics.entries()) {
      const avgDuration = this.getAverageDuration(operation);
      results.push({ operation, avgDuration });
    }
    
    return results.sort((a, b) => b.avgDuration - a.avgDuration);
  }
}

// 使用性能监控
const performanceMonitor = new PerformanceMonitor();

const trackOperation = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
  const startTime = Date.now();
  
  try {
    const result = await fn();
    const duration = Date.now() - startTime;
    performanceMonitor.trackOperation(operation, duration);
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    performanceMonitor.trackOperation(`${operation}_error`, duration);
    throw error;
  }
};
```

### 🔧 错误处理优化

```typescript
class ErrorHandler {
  private static instance: ErrorHandler;
  private errorCounts = new Map<string, number>();

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  handleError(error: any, context: string) {
    const errorKey = `${context}_${error.code || 'unknown'}`;
    const count = this.errorCounts.get(errorKey) || 0;
    this.errorCounts.set(errorKey, count + 1);

    // 记录错误
    console.error(`Error in ${context}:`, error);
    
    // 如果错误频率过高，暂停相关操作
    if (count > 10) {
      console.warn(`High error frequency in ${context}, consider pausing operations`);
    }

    return this.getUserFriendlyMessage(error);
  }

  private getUserFriendlyMessage(error: any): string {
    if (error.code === 'CALL_EXCEPTION') {
      return 'Transaction failed. Please check your input and try again.';
    }
    
    if (error.code === 'INSUFFICIENT_FUNDS') {
      return 'Insufficient funds for transaction.';
    }
    
    if (error.code === 'UNPREDICTABLE_GAS_LIMIT') {
      return 'Transaction may fail. Please check your parameters.';
    }
    
    return 'An unexpected error occurred. Please try again.';
  }
}
```

### 🎯 最佳实践总结

#### ✅ 推荐做法

1. **使用批量操作**：优先使用 `batchDeposit`、`batchBorrow` 等批量函数
2. **并行查询**：使用 `Promise.all` 并行执行多个查询
3. **合理缓存**：对频繁查询的数据进行适当缓存
4. **错误重试**：对网络错误实现指数退避重试机制
5. **性能监控**：跟踪关键操作的执行时间

#### ❌ 避免做法

1. **避免串行调用**：不要在一个循环中串行调用合约函数
2. **避免过度查询**：不要频繁查询不经常变化的数据
3. **避免大数组**：批量操作时避免传递过大的数组
4. **避免忽略错误**：始终处理合约调用的错误情况

---

## 📞 技术支持

如有问题，请联系：
- 📧 Email: support@example.com
- 💬 Discord: #technical-support
- 📖 文档: https://docs.example.com

---

*本文档将随着平台功能的更新而持续更新。请定期检查最新版本。* 
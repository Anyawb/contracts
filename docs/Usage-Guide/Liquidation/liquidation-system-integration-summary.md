# 清算系统测试集成总结

## 🔗 References（口径来源与关联文档）

- **Architecture**: [`docs/Architecture-Guide.md`](../../Architecture-Guide.md)
- **Terminology**: [`docs/Architecture-Liquidation-DirectLedger-Terminology.md`](../../Architecture-Liquidation-DirectLedger-Terminology.md)
- **Related**
  - 完整清算逻辑（端到端口径）：[`liquidation-complete-logic.md`](./liquidation-complete-logic.md)
  - 清算机制与调用链（概要）：[`Liquidation-Mechanism-Logic.md`](./Liquidation-Mechanism-Logic.md)
  - 清算积分惩罚/奖励（可选扩展）：[`liquidation-reward-penalty.md`](./liquidation-reward-penalty.md)

## 概述

本文档总结了 RWA 借贷平台清算系统的架构、实现和测试集成情况。已对齐《Architecture-Guide》：清算写路径直达账本层 `CollateralManager.withdrawCollateralTo` 与 `LendingEngine.forceReduceDebt`，不经 View 转发；事件/DataPush 由 `LiquidatorView.pushLiquidationUpdate/Batch` 单点触发（best-effort）；风控与只读聚合在 `LiquidationRiskManager`/`LiquidationView`。

## 清算系统架构

### 核心模块

清算系统采用“编排入口 + 账本直达 + 单点事件/只读”的分层：

| 模块 | 功能 | 位置/说明 |
|------|------|-----------|
| **LiquidationManager** | 清算编排唯一入口（`KEY_LIQUIDATION_MANAGER`），调用账本层 `CollateralManager.withdrawCollateralTo` 与 `LendingEngine.forceReduceDebt`，不经 View 转发 | `src/Vault/liquidation/modules/LiquidationManager.sol` |
| **CollateralManager** | 抵押物账本层，内部做权限/余额校验；接受 `ACTION_LIQUIDATE` | `src/Vault/accounting/CollateralManager.sol` |
| **LendingEngine** | 债务账本层，内部做权限/onlyVaultCore 校验；估值与优雅降级仅此处发生 | `src/Vault/lending/VaultLendingEngine*.sol` |
| **LiquidationRiskManager** | 健康因子/阈值/风险聚合与缓存，只读 | `src/Vault/liquidation/modules/LiquidationRiskManager.sol` |
| **LiquidationView** | 只读聚合，直接代理 `CollateralManager`/`LendingEngine` 估值与批量查询，不参与写入 | `src/Vault/view/modules/LiquidationView.sol` |
| **LiquidatorView** | 事件/DataPush 单点入口，账本写入成功后由编排入口触发 `pushLiquidationUpdate/Batch` | `src/Vault/view/modules/LiquidatorView.sol` |
| **StatisticsView（可选）** | 全局/清算人统计的只读聚合 | `src/Vault/view/StatisticsView.sol` |

### 核心库

| 库 | 功能 | 位置 |
|------|------|------|
| **LiquidationCoreOperations** | 清算核心操作逻辑 | `src/Vault/liquidation/libraries/LiquidationCoreOperations.sol` |
| **LiquidationRiskLib** | 风险评估计算 | `src/Vault/liquidation/libraries/LiquidationRiskLib.sol` |
| **LiquidationValidationLibrary** | 参数验证 | `src/Vault/liquidation/libraries/LiquidationValidationLibrary.sol` |
| **LiquidationTokenLibrary** | 代币操作 | `src/Vault/liquidation/libraries/LiquidationTokenLibrary.sol` |
| **LiquidationEventLibrary** | 事件管理 | `src/Vault/liquidation/libraries/LiquidationEventLibrary.sol` |

### 类型定义

清算系统使用 `LiquidationTypes`/统一库定义阈值与事件常量。阈值与奖励范围由治理配置，事件由 `LiquidatorView` 单点推送。

## 清算流程

### 1. 清算触发条件

清算系统通过以下条件判断用户是否可被清算：

```solidity
// 健康因子计算
healthFactor = (抵押物价值 × 10000) / 债务价值

// 清算条件
isLiquidatable = healthFactor < liquidationThreshold
```

**默认阈值**：
- 清算阈值：105% (10,500 bps)
- 最小健康因子：105% (10,500 bps)
- 健康因子 < 105% 时，用户可被清算

### 2. 清算执行流程

清算操作通过 `LiquidationManager.liquidate()`（唯一入口）执行，流程如下（直达账本版本）：

```
1. 权限验证
   └─> 账本层 `CollateralManager`/`LendingEngine` 内部使用 `ACM.requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender)`（或 onlyVaultCore + ActionKey）校验

2. 风险评估
   └─> 检查用户是否可被清算（健康因子 < 阈值）
   └─> 验证清算金额是否有效

3. 扣押抵押物
   └─> 直接调用 `CollateralManager.withdrawCollateralTo(user, collateralAsset, collateralAmount, liquidatorOrReceiver)` 扣押并转移

4. 减少债务
   └─> 直接调用 `LendingEngine.forceReduceDebt`（或等效接口）减少债务

5. 奖励/惩罚/统计（当前实现：链下口径或可选扩展）
   └─> `LiquidationManager` 本身不在链上做“残值分配/平台收入/风险池/出借人补偿/清算人奖励结算”
   └─> 统计与报表由链下消费 `LiquidatorView` 单点 DataPush 聚合（或后续引入独立扩展模块）

7. 事件/DataPush
   └─> 写入成功后由编排入口调用 `LiquidatorView.pushLiquidationUpdate/Batch` 单点推送（链下统一消费）
```

### 3. 核心函数接口

#### LiquidationManager

```solidity
/// @notice 执行清算操作
/// @param targetUser 被清算用户地址
/// @param collateralAsset 抵押资产地址
/// @param debtAsset 债务资产地址
/// @param collateralAmount 清算抵押物数量
/// @param debtAmount 清算债务数量
/// @return bonus 清算奖励金额
function liquidate(
    address targetUser,
    address collateralAsset,
    address debtAsset,
    uint256 collateralAmount,
    uint256 debtAmount
) external returns (uint256 bonus);

/// @notice 批量清算操作
function batchLiquidate(
    address[] calldata targetUsers,
    address[] calldata collateralAssets,
    address[] calldata debtAssets,
    uint256[] calldata collateralAmounts,
    uint256[] calldata debtAmounts
) external returns (uint256[] memory bonuses);
```

#### LiquidationRiskManager

```solidity
/// @notice 检查用户是否可被清算
/// @param user 用户地址
/// @return liquidatable 是否可被清算
function isLiquidatable(address user) external view returns (bool liquidatable);

/// @notice 获取用户清算风险评分
/// @param user 用户地址
/// @return riskScore 风险评分 (0-100)
function getLiquidationRiskScore(address user) external view returns (uint256 riskScore);

/// @notice 获取用户健康因子
/// @param user 用户地址
/// @return healthFactor 健康因子（basis points）
function getUserHealthFactor(address user) external view returns (uint256 healthFactor);

/// @notice 获取用户风险评估结果
/// @param user 用户地址
/// @return liquidatable 是否可被清算
/// @return riskScore 风险评分 (0-100)
/// @return healthFactor 健康因子（basis points）
/// @return riskLevel 风险等级 (0-4)
/// @return safetyMargin 安全边际（basis points）
function getUserRiskAssessment(address user) external view returns (
    bool liquidatable,
    uint256 riskScore,
    uint256 healthFactor,
    uint256 riskLevel,
    uint256 safetyMargin
);
```

## 清算参数配置

### 默认配置

| 参数 | 默认值 | 范围 | 说明 |
|------|--------|------|------|
| **清算阈值** | 10,500 bps (105%) | 10,000 - 15,000 bps | 健康因子低于此值时触发清算 |
| **清算奖励** | 1,000 bps (10%) | 500 - 2,000 bps | 清算人获得的奖励比例 |
| **最小健康因子** | 10,500 bps (105%) | 10,000 - 15,000 bps | 系统要求的最小健康因子 |

### 残值分配比例

清算后的残值按以下比例分配：

| 接收方 | 比例 | 说明 |
|--------|------|------|
| **平台收入** | 3% | 平台运营收入 |
| **风险准备金** | 2% | 系统风险准备金 |
| **出借人补偿** | 17% | 补偿出借人损失 |
| **清算人奖励** | 78% | 清算人获得的奖励 |

## 权限控制

清算系统使用 `AccessControlManager` 进行权限管理，校验放在账本层：

| 权限 | ActionKey | 说明 |
|------|-----------|------|
| **执行清算** | `ACTION_LIQUIDATE` | 账本层 `CollateralManager`/`LendingEngine` 校验 |
| **设置参数** | `ACTION_SET_PARAMETER` | 更新阈值/奖励等治理参数 |
| **升级模块** | `ACTION_UPGRADE_MODULE` | 升级相关模块 |
| **账本唯一入口** | `onlyVaultCore` | `LendingEngine` 拒绝非 Core 的写入 |

## 事件/DataPush

事件单点推送：账本写入成功后，编排入口调用 `LiquidatorView.pushLiquidationUpdate/Batch`，链下统一消费。

### LiquidatorView（示意载荷）

```solidity
// 单笔
LIQUIDATION_UPDATE(
    user,
    collateralAsset,
    debtAsset,
    collateralAmount,
    debtAmount,
    liquidator,
    bonus,
    block.timestamp
)

// 批量
LIQUIDATION_BATCH_UPDATE(
    users[],
    collateralAssets[],
    debtAssets[],
    collateralAmounts[],
    debtAmounts[],
    liquidator,
    bonuses[],
    block.timestamp
)
```

阈值/参数更新事件可由治理模块单独发出，但不替代清算写路径的单点推送。

## 测试集成

### 测试文件位置

清算系统的测试集成重点校验“账本直达 + 单点事件”：

- `test/Vault/liquidation/*`（示例）- 清算写入直达账本、权限校验
- `test/Vault/view/LiquidatorView*` - 事件/DataPush 单点推送
- `test/Vault/view/LiquidationView*` - 只读聚合/批量查询

### 测试覆盖范围

#### 1. 清算风险评估测试

**测试目标**：
- 验证清算风险评估功能
- 测试健康因子计算
- 验证清算阈值判断

**测试内容**：
```typescript
// 检查用户是否可被清算
const isLiquidatable = await liquidationRiskManager.isLiquidatable(userAddress);

// 获取用户健康因子
const healthFactor = await liquidationRiskManager.getUserHealthFactor(userAddress);

// 获取用户风险评分
const riskScore = await liquidationRiskManager.getLiquidationRiskScore(userAddress);

// 获取完整风险评估
const assessment = await liquidationRiskManager.getUserRiskAssessment(userAddress);
```

#### 2. 清算执行测试

**测试目标**：
- 验证清算执行流程（直达账本）
- 测试抵押物扣押与债务减少触达 `CollateralManager`/`LendingEngine`
- 验证单点事件/DataPush 触发

**测试内容**：
```typescript
// 执行清算操作（编排入口 → 账本层）
const liquidationTx = await liquidationManager.liquidate(
    targetUser,
    collateralAsset,
    debtAsset,
    collateralAmount,
    debtAmount
);

const receipt = await liquidationTx.wait();

// 验证账本写入（示例：查看 CollateralManager/LendingEngine 状态或事件）
// 验证单点推送事件来自 LiquidatorView
const pushed = receipt.logs.find(log => log.address === liquidatorView && log.topics[0] === LIQUIDATION_UPDATE_TOPIC);

// 验证清算后状态
const newHealthFactor = await liquidationRiskManager.getUserHealthFactor(targetUser);
const isStillLiquidatable = await liquidationRiskManager.isLiquidatable(targetUser);
```

#### 3. 批量清算测试

**测试目标**：
- 验证批量清算功能
- 测试批量风险评估
- 验证批量操作性能

**测试内容**：
```typescript
// 批量清算
const bonuses = await liquidationManager.batchLiquidate(
    targetUsers,
    collateralAssets,
    debtAssets,
    collateralAmounts,
    debtAmounts
);

// 批量风险评估
const liquidatableFlags = await liquidationRiskManager.batchIsLiquidatable(users);
const healthFactors = await liquidationRiskManager.batchGetUserHealthFactors(users);
```

#### 4. 边界条件测试

**测试目标**：
- 验证健康用户不可被清算
- 测试高风险用户清算
- 验证清算阈值边界

**测试内容**：
```typescript
// 健康用户（健康因子 > 110%）
const healthyUserHF = 20000; // 200%
const isHealthyLiquidatable = await liquidationRiskManager.isLiquidatable(healthyUser);

// 高风险用户（健康因子 < 105%）
const riskyUserHF = 9000; // 90%
const isRiskyLiquidatable = await liquidationRiskManager.isLiquidatable(riskyUser);
```

## 部署配置

### Registry 模块键

清算系统在 Registry 中注册的关键模块键（对齐直达账本）：

| 模块键 | 模块名称 | 说明 |
|--------|----------|------|
| `KEY_LIQUIDATION_MANAGER` | LiquidationManager | 清算编排入口 |
| `KEY_CM` | CollateralManager | 抵押物账本层 |
| `KEY_LE` | LendingEngine | 债务账本层（含估值/降级） |
| `KEY_LIQUIDATION_RISK_MANAGER` | LiquidationRiskManager | 风险/阈值只读 |
| `KEY_LIQUIDATION_VIEW` | LiquidationView | 只读聚合（代理 CM/LE） |
| `KEY_LIQUIDATOR_VIEW` | LiquidatorView | 事件/DataPush 单点入口 |

### 初始化参数

```typescript
// LiquidationManager 初始化（绑定 Registry/ACM）
await liquidationManager.initialize(registryAddress, accessControlAddress);

// LiquidatorView 初始化（事件单点）
await liquidatorView.initialize(registryAddress);

// LiquidationRiskManager 初始化（只读缓存参数）
await liquidationRiskManager.initialize(
    registryAddress,
    accessControlAddress,
    maxCacheDuration,
    maxBatchSize
);
```

## 使用示例

### 1. 检查用户是否可被清算

```typescript
import { ILiquidationRiskManager } from '../types/contracts';

const liquidationRiskManager = await ethers.getContractAt(
    'ILiquidationRiskManager',
    liquidationRiskManagerAddress
);

// 检查单个用户
const isLiquidatable = await liquidationRiskManager.isLiquidatable(userAddress);

// 获取完整风险评估
const assessment = await liquidationRiskManager.getUserRiskAssessment(userAddress);
console.log('可清算:', assessment.liquidatable);
console.log('健康因子:', assessment.healthFactor.toString());
console.log('风险评分:', assessment.riskScore.toString());
console.log('风险等级:', assessment.riskLevel.toString());
```

### 2. 执行清算操作（直达账本）

```typescript
import { ILiquidationManager } from '../types/contracts';

const liquidationManager = await ethers.getContractAt(
    'ILiquidationManager',
    liquidationManagerAddress
);

// 检查权限
const hasPermission = await accessControlManager.hasRole(
    ActionKeys.ACTION_LIQUIDATE,
    liquidatorAddress
);

if (!hasPermission) {
    throw new Error('清算人没有清算权限');
}

// 执行清算
const tx = await liquidationManager.liquidate(
    targetUser,
    collateralAsset,
    debtAsset,
    collateralAmount,
    debtAmount
);

const receipt = await tx.wait();
console.log('清算成功，Gas 使用:', receipt.gasUsed.toString());
```

### 3. 批量清算（单点事件）

```typescript
// 批量清算多个用户
const bonuses = await liquidationManager.batchLiquidate(
    [user1, user2, user3],
    [collateralAsset1, collateralAsset2, collateralAsset3],
    [debtAsset1, debtAsset2, debtAsset3],
    [amount1, amount2, amount3],
    [debtAmount1, debtAmount2, debtAmount3]
);

console.log('清算奖励:', bonuses.map(b => b.toString()));
```

### 4. 监控清算风险（只读）

```typescript
// 批量检查用户清算风险
const users = [user1, user2, user3];
const liquidatableFlags = await liquidationRiskManager.batchIsLiquidatable(users);
const healthFactors = await liquidationRiskManager.batchGetUserHealthFactors(users);

users.forEach((user, index) => {
    console.log(`用户 ${user}:`);
    console.log(`  可清算: ${liquidatableFlags[index]}`);
    console.log(`  健康因子: ${healthFactors[index].toString()}`);
});
```

## 性能优化

### 1. 模块缓存

通过 `ModuleCache` 缓存 Registry 模块地址（例：`KEY_CM`/`KEY_LE`/`KEY_LIQUIDATOR_VIEW`），减少查询。

### 2. 健康因子缓存

`LiquidationRiskManager` 缓存健康因子与风险状态，避免重复估值（估值仍由 `LendingEngine` 提供）。

### 3. 批量操作

系统提供批量操作接口，减少 Gas 消耗：

- `batchLiquidate()` - 批量清算
- `batchIsLiquidatable()` - 批量风险评估
- `batchGetUserHealthFactors()` - 批量获取健康因子

## 安全特性

### 1. 重入与暂停

账本写入路径使用 `ReentrancyGuard`/`Pausable`（位于 CollateralManager/LendingEngine 或入口层）防护。

### 2. 权限验证

写路径在账本层校验 `ACTION_LIQUIDATE`（或 onlyVaultCore + ActionKey）；View 层不放行写入。

### 3. 参数验证

入口层与账本层对地址、金额等进行校验；估值健康检查仅在 `LendingEngine` 估值路径。

## 升级机制

清算系统支持 UUPS 升级模式：

```solidity
function _authorizeUpgrade(address newImplementation) 
    internal 
    view 
    override 
    onlyRole(ACTION_UPGRADE_MODULE) 
{
    // 升级授权逻辑
}
```

## 监控和统计

### 1. 清算记录/统计

记录与统计由只读视图（如 `StatisticsView`/`LiquidationView`/`LiquidatorView`）聚合，链下消费 `pushLiquidationUpdate/Batch` 进行落库；账本层不重复发事件。

## 最佳实践

### 1. 清算前检查

```typescript
// 1. 检查用户是否可被清算
const isLiquidatable = await liquidationRiskManager.isLiquidatable(user);

if (!isLiquidatable) {
    throw new Error('用户不可被清算');
}

// 2. 获取可清算金额（只读路径，经 LiquidationView / 账本只读接口）
const seizableAmount = await liquidationView.getSeizableCollateralAmount(user, asset);
const reducibleAmount = await liquidationView.getReducibleDebtAmount(user, asset);

// 3. 验证清算金额
if (collateralAmount > seizableAmount || debtAmount > reducibleAmount) {
    throw new Error('清算金额超过可清算范围');
}
```

### 2. 事件监听

```typescript
// 监听 LiquidatorView 单点推送事件/DataPush
liquidatorView.on('LIQUIDATION_UPDATE', (user, collateralAsset, debtAsset, collateralAmount, debtAmount, liquidator, bonus, ts) => {
    console.log(`清算执行: ${user} 被 ${liquidator} 清算`);
    console.log(`抵押物: ${collateralAmount}, 债务: ${debtAmount}, 奖励: ${bonus}`);
});

// 监听阈值更新事件（治理/只读）
liquidationRiskManager.on('LiquidationThresholdUpdated', (oldThreshold, newThreshold, timestamp) => {
    console.log(`清算阈值更新: ${oldThreshold} -> ${newThreshold}`);
});
```

### 3. 错误处理

```typescript
try {
    const tx = await liquidationManager.liquidate(...);
    await tx.wait();
} catch (error: any) {
    if (error.message.includes('Not liquidatable')) {
        console.error('用户不可被清算');
    } else if (error.message.includes('Insufficient permission')) {
        console.error('权限不足');
    } else {
        console.error('清算失败:', error.message);
    }
}
```

## 故障排除

### 常见问题

#### Q1: 清算失败 - "Not liquidatable"

**原因**：用户健康因子高于清算阈值

**解决方案**：
```typescript
// 检查用户健康因子
const healthFactor = await liquidationRiskManager.getUserHealthFactor(user);
const threshold = await liquidationRiskManager.getLiquidationThreshold();

console.log(`健康因子: ${healthFactor}, 阈值: ${threshold}`);

// 健康因子必须低于阈值才能清算
if (healthFactor >= threshold) {
    console.log('用户健康因子过高，不可清算');
}
```

#### Q2: 清算失败 - "Insufficient permission"

**原因**：清算人没有 `ACTION_LIQUIDATE` 权限

**解决方案**：
```typescript
// 授予清算权限
await accessControlManager.grantRole(
    ActionKeys.ACTION_LIQUIDATE,
    liquidatorAddress
);
```

#### Q3: 清算金额超过可清算范围

**原因**：清算金额超过用户可清算的抵押物或债务

**解决方案**：
```typescript
// 查询可清算金额（只读路径）
const seizableAmount = await liquidationView.getSeizableCollateralAmount(user, asset);
const reducibleAmount = await liquidationView.getReducibleDebtAmount(user, asset);

// 使用实际可清算金额
const actualCollateralAmount = collateralAmount > seizableAmount 
    ? seizableAmount 
    : collateralAmount;
const actualDebtAmount = debtAmount > reducibleAmount 
    ? reducibleAmount 
    : debtAmount;
```

## 总结

清算系统是 RWA 借贷平台的核心风险管理组件，具有以下特点：

1. **模块化设计**：功能分离，易于维护和升级
2. **完善的权限控制**：基于 AccessControlManager 的细粒度权限管理
3. **灵活的参数配置**：支持动态调整清算阈值和奖励
4. **高效的批量操作**：优化 Gas 消耗和性能
5. **完善的监控统计**：记录所有清算活动和统计信息
6. **安全可靠**：重入保护、暂停功能、参数验证等多重安全机制

清算系统已经过完整的测试验证，可以安全地用于生产环境。

---

**版本**: 2.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

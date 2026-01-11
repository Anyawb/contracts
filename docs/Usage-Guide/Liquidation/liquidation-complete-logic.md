# 完整清算逻辑（与当前架构口径对齐：SettlementManager 统一入口）

## 🔗 References（口径来源与关联文档）

- **Architecture**: [`docs/Architecture-Guide.md`](../../Architecture-Guide.md)
- **Terminology**: [`docs/Architecture-Liquidation-DirectLedger-Terminology.md`](../../Architecture-Liquidation-DirectLedger-Terminology.md)
- **Related**
  - 清算机制与调用链（概要）：[`Liquidation-Mechanism-Logic.md`](./Liquidation-Mechanism-Logic.md)
  - 清算积分惩罚/奖励（可选扩展）：[`liquidation-reward-penalty.md`](./liquidation-reward-penalty.md)

## 📋 **概述**

本文档对齐 `docs/Architecture-Guide.md` 的口径：**写入口统一收敛到 `SettlementManager`**（按时还款/提前还款/到期未还/抵押价值过低触发的被动清算），其内部在需要时进入清算分支并直达账本（`ICollateralManager.withdrawCollateralTo`、`ILendingEngineBasic.forceReduceDebt`），事件/DataPush 由 `LiquidatorView.pushLiquidationUpdate/Batch` 单点触发；健康与风险缓存由 `HealthView/LiquidationRiskManager` 提供，预言机访问与优雅降级仅在 `VaultLendingEngine` 估值路径中发生。

## 🔄 **完整清算流程**

### 1. **借贷场景**
```
用户抵押 RWAToken价值100USDC
         ↓
借出 USDC 稳定币95USDC 时间5天
         ↓
5天时间到，借出方没有还款
         ↓
✅ 触发处置流程（由 Keeper 调用统一入口）
```

### 2. **清算分支执行（SettlementManager 内部进入）**
```
扣押价值95USDC的RWAToken
         ↓
减少95USDC债务
         ↓
计算残值：100USDC - 95USDC = 5USDC
         ↓
残值分配处理
```

### 3. **残值分配（可选：配置 `LiquidationPayoutManager` 后生效）**
```
5USDC残值分配（示例）：
┌──────────────┬───────────────┬────────────┬────────────┐
│  平台收入     │ 风险准备金池    │ 出借人补偿    │ 清算人奖励    │
│    3%        │     2%        │   17%      │   78%      │
│  0.15USDC    │  0.1USDC      │ 0.85USDC   │ 3.9USDC    │
└──────────────┴───────────────┴────────────┴────────────┘
> 说明：当启用 `LiquidationPayoutManager` 时，实际分配由其根据基点配置计算；整数分配后所有余数（除不尽部分）归清算人。
```

## 🏗️ **技术实现**

### **核心模块（职责对齐）**

1. **SettlementManager** - **唯一对外写入口（SSOT）**：统一承接还款结算与被动清算（到期未还/价值过低）
2. **LiquidationManager** - 清算执行器：仅在 `SettlementManager` 进入清算分支时调用（可承接清算参数校验/事件聚合/残值分配路由等）
3. **CollateralManager（CM）** - 抵押托管者（真实资产池/资金池），提供 `withdrawCollateralTo` 供清算扣押/结算释放（扣减账本 + 真实转账）
4. **VaultLendingEngine（LE / ILendingEngineBasic）** - 债务账本写入：`repay` / `forceReduceDebt`（并在账本变更后推送 VaultRouter/HealthView）
5. **LiquidatorView** - 事件/DataPush 单点入口 + 清算只读查询
6. **LiquidationRiskManager / HealthView** - 风险与健康只读聚合/缓存（不参与写入）

### **关于“残值/分配/奖励”的实现边界（重要）**

被动清算分支的核心写路径只包含（直达账本）：

- `CM.withdrawCollateralTo(user, collateralAsset, collateralAmount, liquidatorOrReceiver)`
- `LE.forceReduceDebt(user, debtAsset, debtAmount)`
- 写入成功后 best-effort 调用 `LiquidatorView.pushLiquidationUpdate/Batch`

因此：

- **残值计算/分配是否发生**取决于是否启用并配置 `LiquidationPayoutManager`
  - 未启用：仅发生扣押/减债与清算事件推送，不进行平台/准备金/出借人/清算人分配
  - 已启用：在清算分支内按配置进行平台/准备金/出借人/清算人分配，并由 `LiquidatorView` 进行单点推送（best-effort）

如需残值分配/补偿/清算奖励结算，应作为独立扩展模块另行设计并实现（避免把复杂分润逻辑塞进清算写路径）。

## 📊 **清算示例**

### **场景：用户违约清算**

#### **初始状态**
- 抵押物：RWAToken价值100USDC
- 债务：USDC 95USDC
- 健康因子：105.26% (100/95 * 100)

#### **清算触发**
- 健康因子低于阈值（105%）
- Keeper 触发处置（进入统一入口，内部决定是否走清算分支）

#### **清算执行**
1. **扣押抵押物**：`CM.withdrawCollateralTo(...)` 扣减抵押并将真实抵押资产转给清算人
2. **减少债务**：`LE.forceReduceDebt(...)` 直接减债
3. **事件/DataPush**：仅 `LiquidatorView.pushLiquidationUpdate/Batch` 单点推送（best-effort）

#### **最终结果**
- 用户：失去抵押物，债务清零
- 清算人：收到被扣押的抵押资产（链上真实转账）
- “残值/分润/补偿”仅在启用 `LiquidationPayoutManager` 时发生；否则不自动结算（仅扣押/减债/事件推送）

## 🔧 **配置参数**

### **清算阈值**
```solidity
DEFAULT_LIQUIDATION_THRESHOLD = 10_500; // 105%
MIN_LIQUIDATION_THRESHOLD = 10_000;     // 100%
MAX_LIQUIDATION_THRESHOLD = 15_000;     // 150%
```

### **残值分配比例（由 LiquidationPayoutManager 配置，合计 10_000 bps）**
```solidity
platformBps       = 300;   // 3%
reserveBps        = 200;   // 2%
lenderBps         = 1_700; // 17%
liquidatorBps     = 7_800; // 78%
// 余数：整数分配后的剩余全部归清算人
```

## 📈 **优势分析**

### **1. 风险控制**
- 自动清算机制防止坏账累积
- 风险准备金池提供额外保障
- 出借人补偿机制保护投资者

### **2. 激励机制**
- 清算人奖励鼓励及时清算
- 平台收入支持持续运营
- 风险准备金增强系统稳定性

### **3. 透明度**
- 完整的清算记录
- 详细的残值分配
- 实时清算预览

### **4. 可扩展性**
- 模块化设计
- 参数可配置
- 支持升级

## 🚀 **使用指南**

### **清算人操作**
```solidity
// 只读检查（0 gas）：通过 LiquidationRiskManager/LiquidatorView/HealthView 查询是否可清算、可扣押数量等
// 写入执行：SettlementManager 为唯一对外入口（其内部进入清算分支）
// settlementManager.settleOrLiquidate(orderId);
```

### **管理员配置**
```solidity
// 当前 LiquidationManager 不包含“残值分配/平台收入/风险池/补偿池”配置项（属于未来可选扩展）
```

## 📝 **事件记录**

### **清算执行事件**
```solidity
event LiquidationExecuted(
    address indexed liquidator,
    address indexed user,
    address indexed collateralAsset,
    address debtAsset,
    uint256 collateralAmount,
    uint256 debtAmount,
    uint256 bonus,
    uint256 timestamp
);
```

### **残值分配事件（可选）**

当启用 `LiquidationPayoutManager` 时，清算分支会产生“平台/准备金/出借人/清算人”分配的链上转账，并可通过 `LiquidatorView` 的单点推送事件/DataPush 供链下消费与对账。

## 🔒 **安全考虑**

1. **权限控制**：只有授权的清算人可以执行清算
2. **重入保护**：使用ReentrancyGuard防止重入攻击
3. **暂停机制**：紧急情况下可暂停所有清算操作
4. **参数验证**：所有输入参数都经过严格验证
5. **事件记录**：完整的操作记录便于审计

## 📊 **监控指标**

1. **清算频率**：单位时间内的清算次数
2. **残值分配**：各方的收益分配情况
3. **风险准备金**：风险池的累积情况
4. **清算效率**：清算的及时性和有效性
5. **用户损失**：被清算用户的损失统计

---

*本文档描述了完整的清算逻辑实现，确保系统的风险控制和各方利益的平衡。* 
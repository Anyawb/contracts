# View 模块架构验收报告（最终）

> 依据：`docs/Architecture-Guide.md` 与 `docs/Usage-Guide/ARCH-VIEW-ALIGNMENT-WORKGUIDE.md`  
> 范围：`src/Vault/view/modules/*.sol`  
> 目标：逐模块验证 **权限口径 / Meta 输出 / Batch 口径 / DataPush** 对齐情况

---

## 口径说明

- **权限口径**：对外权限失败统一 `MissingRole()`；用户维度遵循 Scheme U（self allowed / non-self VIEW_USER_DATA 或 ADMIN）
- **Meta 输出**：B 类缓存读取必须包含 `isValid + blockNumber`（必要时含 `version`）
- **Batch 口径**：统一使用 `EmptyArray` / `BatchTooLarge(len,max)` / `ArrayLengthMismatch(len1,len2)`
- **DataPush**：所有 push* 写入口必须使用 `DataPushLibrary._emitData(...)` + `DataPushTypes`

---

## A. 核心 View

### `PositionView.sol`
- 权限口径：✅ Scheme U + `MissingRole()`
- Meta 输出：✅ `getUserPositionWithMeta`（含 `isValid/blockNumber/version`）
- Batch 口径：✅ `EmptyArray/BatchTooLarge/ArrayLengthMismatch`
- DataPush：✅ `DATA_TYPE_USER_POSITION_UPDATE`

### `UserView.sol`
- 权限口径：✅ Scheme U + `MissingRole()`
- Meta 输出：✅ 聚合层透传（含 meta）
- Batch 口径：✅ `BatchTooLarge/ArrayLengthMismatch`
- DataPush：N/A（只读 façade）

### `HealthView.sol`
- 权限口径：✅ 读接口默认公开；写入口 `MissingRole()`
- Meta 输出：✅ `getUserHealthFactorWithMeta` / batch 带 `isValid/blockNumber`
- Batch 口径：✅ `EmptyArray/BatchTooLarge/ArrayLengthMismatch`
- DataPush：✅ `DATA_TYPE_RISK_STATUS(_BATCH)` / `DATA_TYPE_MODULE_HEALTH`

### `StatisticsView.sol`
- 权限口径：✅ 系统口径 `MissingRole()`（admin or system data/status）
- Meta 输出：✅ 全局/用户/保证金/快照均带 `isValid/blockNumber`
- Batch 口径：N/A
- DataPush：✅ `DATA_TYPE_USER_STATS_UPDATE` / `DATA_TYPE_STATS_SNAPSHOT_RECORDED`

### `ViewCache.sol`
- 权限口径：✅ system-only + `MissingRole()`（AccessControlLibrary）
- Meta 输出：✅ 系统快照含 `isValid`（时间 + 显式标志）
- Batch 口径：✅ `EmptyArray/BatchTooLarge`
- DataPush：✅ `DATA_TYPE_SYSTEM_STATUS`

### `AccessControlView.sol`
- 权限口径：✅ Scheme U + `MissingRole()`
- Meta 输出：✅ 权限读取带 `isValid/blockNumber`
- Batch 口径：N/A
- DataPush：✅ `DATA_TYPE_PERMISSION_BIT_UPDATE` / `DATA_TYPE_PERMISSION_LEVEL_UPDATE`

### `BatchView.sol`
- 权限口径：✅ Scheme U batch + `MissingRole()`
- Meta 输出：✅ 聚合输出包含 meta（如 HealthFactorItem 含 isValid/blockNumber）
- Batch 口径：✅ `EmptyArray/BatchTooLarge`
- DataPush：N/A

### `RegistryView.sol`
- 权限口径：✅ admin gate `MissingRole()`
- Meta 输出：N/A
- Batch 口径：✅ `BatchTooLarge`
- DataPush：N/A

### `SystemView.sol`
- 权限口径：✅ system-only `MissingRole()`
- Meta 输出：N/A（路由/发现性）
- Batch 口径：N/A
- DataPush：N/A

---

## B. 扩展 View

### `FeeRouterView.sol`
- 权限口径：✅ Scheme U / admin gate `MissingRole()`
- Meta 输出：✅ user/system 读取含 `blockNumber/isValid`
- Batch 口径：✅ `EmptyArray/BatchTooLarge/ArrayLengthMismatch`
- DataPush：✅ `DATA_TYPE_USER_FEE` / `DATA_TYPE_GLOBAL_FEE_STATS` / `DATA_TYPE_FEE_ROUTER_SYSTEM_CONFIG_UPDATED`

### `LendingEngineView.sol`
- 权限口径：✅ Scheme U + ops/admin `MissingRole()`
- Meta 输出：N/A
- Batch 口径：N/A
- DataPush：N/A

### `ModuleHealthView.sol`
- 权限口径：✅ system-only + `MissingRole()`
- Meta 输出：✅ `getModuleHealthStatus` / `WithMeta` 均带 `blockNumber/isValid`
- Batch 口径：N/A
- DataPush：✅ 通过 HealthView 写入（`DATA_TYPE_MODULE_HEALTH`）

### `EventHistoryManager.sol`
- 权限口径：✅ `ACTION_MANAGE_EVENT_HISTORY` → `MissingRole()`
- Meta 输出：N/A
- Batch 口径：N/A
- DataPush：✅ `DATA_TYPE_HISTORY`

### `DashboardView.sol`
- 权限口径：✅ system/price gate `MissingRole()`
- Meta 输出：✅ 透传下游 meta
- Batch 口径：✅ `BatchTooLarge`
- DataPush：N/A

### `CacheOptimizedView.sol`
- 权限口径：✅ system gate `MissingRole()`
- Meta 输出：✅ 透传下游 meta
- Batch 口径：✅ `EmptyArray/BatchTooLarge/ArrayLengthMismatch`
- DataPush：N/A

### `PreviewView.sol`
- 权限口径：✅ Scheme U + `MissingRole()`
- Meta 输出：N/A
- Batch 口径：N/A
- DataPush：N/A

### `ValuationOracleView.sol`
- 权限口径：✅ price gate `MissingRole()`
- Meta 输出：部分接口为 price+blockNumber（非 B 类缓存）
- 说明（SSOT）：健康检查接口通过 `GracefulDegradation.checkPriceOracleHealth(...)` 实现，不要求 `PriceOracle` 提供额外 health 方法；
  且 `IPriceOracleRead.getPrice()` 的第三个返回值语义为 **token decimals（assetDecimals）**，用于 amount→value 估值换算（不是 price 精度）。
- Batch 口径：✅ `EmptyArray/BatchTooLarge`
- DataPush：N/A

---

## C. 风险/清算相关 View

### `RiskView.sol`
- 权限口径：✅ Scheme U + `MissingRole()`
- Meta 输出：依赖 HealthView meta
- Batch 口径：✅ `BatchTooLarge`
- DataPush：N/A

### `LiquidationRiskView.sol`
- 权限口径：✅ Scheme U + `MissingRole()`
- Meta 输出：依赖 HealthView meta
- Batch 口径：✅ `EmptyArray/BatchTooLarge`
- DataPush：N/A

### `SystemRiskView.sol`
- 权限口径：✅ admin gate `MissingRole()`
- Meta 输出：N/A（system-only）
- Batch 口径：N/A
- DataPush：N/A

### `LiquidatorView.sol`
- 权限口径：✅ system/risk/liquidation gate `MissingRole()`
- Meta 输出：涉及 cache 的读均有 meta
- Batch 口径：✅ `BatchTooLarge/EmptyArray/ArrayLengthMismatch`
- DataPush：✅ `DATA_TYPE_LIQUIDATION_*`

---

## 总体验收结论

- **权限失败口径**：已统一为 `MissingRole()`  
- **B 类缓存 Meta 输出**：已全覆盖（含 `ModuleHealthView.getModuleHealthStatus`）  
- **Batch 口径**：已统一为标准错误  
- **DataPush**：push* 模块均使用 `DataPushLibrary + DataPushTypes`  

> 该报告可作为本次 View 架构对齐的存档版本。

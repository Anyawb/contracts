## Cache 架构与运维指南（A/B/C 分类版）

> 目的：把本仓库所有“缓存相关点”按统一口径梳理清楚，便于审计、运维、排障与后续演进。
>
> 本指南与 `docs/Architecture-Guide.md` 的核心原则保持一致：**写入不经 View**、**事件驱动**、**View 层缓存做加速**、**推送失败不链上重试（事件 + 链下重放）**。

### 0. 术语与范围

- **SSOT**：Single Source Of Truth，权威来源（账本/资金/状态的最终真相）。
- **Cache（缓存）**：非权威、可过期/可重建/可被覆盖的数据层，用于加速查询或降低 gas / RPC 次数。
- **本指南的“缓存点”**：包括但不限于
  - 模块地址缓存（从 Registry 解析出的地址在合约内暂存）
  - View 层业务快照缓存（Position/Health/Stats/ACL/Fees 等 0-gas 查询）
  - 业务模块内部缓存（价格降级缓存、奖励积分缓存、域分隔符缓存等）

---

## 1) A/B/C 分类：我们统一什么，不统一什么

### A 类：模块地址缓存（Module Address Cache）✅ **统一入口**

**定义**：缓存对象是“从 Registry 解析出的模块地址”（如 CM/LE/HealthView 等）。  
**风险**：模块升级/地址变更后，旧缓存可能导致调用失败或短时间使用旧地址。  
**目标**：统一为 **单入口 + best-effort + 审计** 的治理运维动作。

**统一方案（已落地）**
- 统一接口：`ICacheRefreshable.refreshModuleCache()`
- 统一入口：`CacheMaintenanceManager.batchRefresh(address[] targets)`
- 统一权限：`refreshModuleCache()` **仅允许 CacheMaintenanceManager 调用**（目标合约侧校验 `Registry.KEY_CACHE_MAINTENANCE_MANAGER`）
- 统一审计：维护器逐 target emit `CacheRefreshAttempted(target, ok, reason)`

### B 类：View 业务数据缓存（Business Snapshot Cache）❌ **不统一刷新入口**

**定义**：Position/Health/Stats/ACL/FeeView/RewardView 等 “View 层快照缓存”。  
**权威来源**：账本（CM/LE/SettlementManager 等）+ 业务推送事件/快照。  
**正确做法（Architecture-Guide 主线）**：
- 写入成功后由业务模块 **push** 到 View
- View 读接口返回 `(value, isValid)` 或 `struct.isValid` + `timestamp`
- 推送失败：**不回滚主流程**，发失败事件（如 `CacheUpdateFailed/HealthPushFailed/RewardViewPushFailed/...`），链下人工/脚本重放
- 并发与幂等：`nextVersion`（严格）+ `requestId/seq`（可选）

### C 类：业务内部缓存 / 工具缓存（Internal / Utility Cache）❌ **不统一入口**

**定义**：Reward 内部 address cache、积分计算缓存、GracefulDegradation 的价格缓存、Registry 签名域分隔符缓存等。  
这类缓存语义强、形态多，强行纳入统一 refresh 会扩大权限面、混淆语义，违背“职责分离”。

---

## 2) 统一入口（A 类）已落地的合约与接口

### 2.1 A 类总表（模块地址缓存）

| 文件 | 缓存字段 | TTL/失效判定 | 写入者 | 权限 | 失败/重试 | 是否应实现 `ICacheRefreshable` |
|---|---|---|---|---|---|---|
| `src/interfaces/ICacheRefreshable.sol` | N/A（接口） | N/A | N/A | N/A | N/A | N/A |
| `src/registry/CacheMaintenanceManager.sol` | N/A（维护器自身不缓存模块地址） | N/A | 治理脚本调用 `batchRefresh` | `ACTION_SET_PARAMETER` | best-effort + `CacheRefreshAttempted` 审计 | N/A |
| `src/Vault/VaultRouter.sol` | `_cachedCMAddr/_cachedLEAddr/_lastCacheUpdate` | `CACHE_EXPIRY_TIME = 1 hours`（过期时自动更新） | `refreshModuleCache()`/内部 `_getCachedModules()` | `refreshModuleCache()` 仅维护器 | 失败即 revert（但维护器 best-effort 会吞掉并记录 reason） | ✅（已实现） |
| `src/Vault/liquidation/modules/LiquidationRiskManager.sol` | `_moduleCache.moduleAddresses[key]` + `cacheTimestamps[key]` | `maxCacheDurationVar`（stale 时 read-path fallback Registry） | `refreshModuleCache()` 内部 `_tryCacheModule` | `refreshModuleCache()` 仅维护器 | best-effort：缺模块/不可用不 revert | ✅（已实现） |
| `src/constants/ModuleKeys.sol` | N/A（Key 定义） | N/A | N/A | N/A | N/A | N/A（但 A 类依赖 `KEY_CACHE_MAINTENANCE_MANAGER`） |

> 备注：`src/libraries/VaultRouterModuleLib.sol` 也实现了“CM/LE 地址缓存结构”，但它是**库**（非合约），不参与 A 类统一入口；VaultRouter 当前使用自身缓存字段即可。

---

## 3) View 业务缓存（B 类）：推送、幂等、有效性与失败事件

### 3.1 B 类总表（View 层业务缓存/快照）

| 文件 | 缓存字段（核心） | TTL/失效判定 | 写入者（谁 push） | 权限（写/读） | 失败/重试路径 | 是否应实现 `ICacheRefreshable` |
|---|---|---|---|---|---|---|
| `src/Vault/view/modules/PositionView.sol` | `_collateralCache/_debtCache/_cacheTimestamps` + `version/seq/requestId` | `ViewConstants.CACHE_DURATION`；失效读回退账本 | CM/LE/VaultCore/VBL/VaultRouter（`onlyBusinessContract`） | 写：`ACTION_VIEW_PUSH`；读：view | 账本读失败 emit `CacheUpdateFailed`；链下重放；链上 admin `retryUserPositionUpdate` | ❌ |
| `src/Vault/view/modules/HealthView.sol` | `_healthFactorCache/_cacheTimestamps`；`_moduleHealth` | `ViewConstants.CACHE_DURATION`（user）；模块健康为“lastCheck+failures” | 风控/账本模块 push | 写：`ACTION_VIEW_PUSH`；模块健康：`ACTION_VIEW_SYSTEM_STATUS`/ADMIN；读：view | 失败建议按 `HealthPushFailed`（见 `LendingEngineCore`）+链下重试 | ❌ |
| `src/Vault/view/modules/StatisticsView.sol` | `_globalSnapshot/_userSnapshots/_userStatsVersion/_userGuarantees` 等 | 无统一 TTL（以快照 `timestamp` 为准） | 业务模块推送（系统统计/降级统计） | 写：系统状态/管理员 role；读：view | 以事件/快照覆盖为主；可链下重推 | ❌ |
| `src/Vault/view/modules/AccessControlView.sol` | `_userPermissionsCache/_userPermissionLevelCache/_cacheTimestamps[user]` | `ViewConstants.CACHE_DURATION` | AccessControlManager（`onlyACM`） | 写：onlyACM；读：本人或 ADMIN | 依赖 ACM 再 push；无统一重试入口 | ❌ |
| `src/Vault/view/modules/ViewCache.sol` | `_systemStatusCache[asset]` + `isValid` + `timestamp` | `CACHE_DURATION` + `struct.isValid` | 具备 `ACTION_VIEW_SYSTEM_DATA` 的写入方 | 写：`ACTION_VIEW_SYSTEM_DATA`；清理：`ACTION_ADMIN` | 可重复覆盖/清理，无链上重试模型 | ❌ |
| `src/Vault/view/modules/FeeRouterView.sol` | `_userFeeStatistics/_userDynamicFees/_globalFeeStatistics/_systemConfig/_lastSyncTimestamp` | 无 TTL；`SYNC_INTERVAL` 用于“同步节奏/观测” | FeeRouter（`onlyFeeRouter`） | 写：onlyFeeRouter；读：本人/ADMIN（部分系统数据 onlyAdmin） | 失败主要来自上游未推送；可由 FeeRouter 再推 | ❌ |
| `src/Vault/view/modules/RewardView.sol` | `_userSummary/_activities/_consumptions/_systemStats` | 无 TTL（镜像聚合） | RewardManagerCore/RewardConsumption（`onlyWriter`） | 写：onlyWriter；读：本人或 VIEW_USER_DATA/ADMIN；系统榜单 onlyOps | 推送失败：见 `RewardViewPushFailed`（RewardModuleBase）；链上提供 `retryPush*`（ADMIN） | ❌ |
| `src/Vault/view/modules/ModuleHealthView.sol` | `_moduleHealth[module]`（健康状态快照） | 无 TTL（按 `lastCheckTime`） | `checkAndPushModuleHealth()` 自身检查 + push 到 HealthView | 仅系统健康 viewer 可检查/读 | 失败一般为 Registry/HealthView 不可用；链下可复查 | ❌ |

### 3.2 B 类“推送失败事件”归口（供链下队列）

| 事件 | 触发方（文件） | 语义 | 链下处理建议 |
|---|---|---|---|
| `CacheUpdateFailed(user, asset, viewAddr, collateral, debt, reason)` | `src/Vault/modules/lendingEngine/LendingEngineCore.sol`（library）/`PositionView.sol` 等 | View 推送失败（不回滚账本） | 入队；重试前重读账本；必要时走 admin 重推入口 |
| `HealthPushFailed(user, healthView, totalCollateral, totalDebt, reason)` | `src/Vault/modules/lendingEngine/LendingEngineCore.sol` | 健康状态推送失败 | 入队；通常由 keeper/脚本重推 `HealthView.pushRiskStatus` |
| `ViewCachePushFailed(user, asset, reason)` | `src/Vault/modules/CollateralManager.sol` | CM → VaultCore → VaultRouter/PositionView 的 push delta 失败 | 入队；检查 VaultCore/PositionView 权限与可用性；再重推 |
| `RewardViewPushFailed(user, rewardView, op, payload, reason)` | `src/Reward/internal/RewardModuleBase.sol` | RewardView 推送失败（best-effort） | 入队；人工判断后调用 RewardView 的 `retryPush*`（ADMIN） |

---

## 4) 业务内部/工具缓存（C 类）

### 4.1 C 类总表（内部缓存/工具缓存）

| 文件 | 缓存字段（核心） | TTL/失效判定 | 写入者 | 权限 | 失败/重试路径 | 是否应实现 `ICacheRefreshable` |
|---|---|---|---|---|---|---|
| `src/registry/RegistrySignatureManager.sol` | `_domainSeparatorValue/_cachedChainId` | chainId 变化时 view 侧临时重算；可调用内部更新缓存 | 合约自身 | owner/upgradeAdmin 体系 | 无“运维刷新”必要 | ❌ |
| `src/core/CoinGeckoPriceUpdater.sol` | 无“模块地址/权限地址缓存”（统一从 Registry 解析 ACM/模块）；内部仅保留业务必要状态（如 `_lastValidPrice`） | N/A | 合约自身 | `ActionKeys` 权限体系（每次从 Registry 解析 ACM） | 无统一失败模型 | ❌ |
| `src/Reward/RewardManagerCore.sol` | `_pointCache[user]` + `_cacheExpirationTime` | `_cacheExpirationTime`（默认 1h） | RMCore 业务逻辑内部 | 治理通过 RewardManager 调参 | 非推送失败模型 | ❌ |
| `src/Reward/internal/RewardModuleBase.sol` | `_cachedRewardViewAddr/_cachedRewardViewTs` | `RV_CACHE_TTL = 1 hours` | Reward 模块内部 | internal | 推送失败 emit `RewardViewPushFailed` | ❌ |
| `src/Reward/BaseServiceConfig.sol` | 无本地 ACM 地址缓存（权限统一从 Registry 解析） | N/A | N/A | `ACTION_SET_PARAMETER/ACTION_UPGRADE_MODULE` 等 | N/A | ❌ |
| `src/libraries/GracefulDegradation.sol` & `src/monitor/GracefulDegradation.sol` | `CacheStorage.priceCache[asset]` | `maxPriceAge` + `PriceCache.isValid` | 调用方在 non-view 路径写入 | 取决于调用合约 | 降级回退 + 监控事件 | ❌ |
| `src/Vault/FeeRouter.sol` | `_feeCache[token][feeType]` | 无 TTL（手动清理） | FeeRouter 业务逻辑 | `clearFeeCache`: `ACTION_SET_PARAMETER` | 清理/重算由业务治理决定 | ❌ |
| `[REMOVED] src/Vault/liquidation/libraries/LiquidationRiskCacheLib.sol` | 旧 risk cache helper（无统一 TTL/失败模型） | N/A | N/A | N/A | N/A | N/A |
| `src/libraries/VaultRouterModuleLib.sol` | `ModuleCache{cachedCMAddr,cachedLEAddr,lastCacheUpdate}` | `cacheExpiryTime` | 供调用方使用 | internal | N/A | ❌（库，不实现接口） |

---

## 5) 全仓“缓存相关文件索引”（用于审计与补齐）

> 说明：该索引来自对 `src/` 的关键词扫描（cache/缓存/ttl/expiry 等）。  
> 其中部分文件仅“引用缓存概念/调用 View/发事件”，不一定持有实际缓存存储；仍保留在清单中便于审计。

### 5.1 A 类（模块地址缓存，统一入口）
- `src/interfaces/ICacheRefreshable.sol`
- `src/registry/CacheMaintenanceManager.sol`
- `src/Vault/VaultRouter.sol`
- `src/Vault/liquidation/modules/LiquidationRiskManager.sol`
- `src/constants/ModuleKeys.sol`（含 `KEY_CACHE_MAINTENANCE_MANAGER`）

### 5.2 B 类（View 业务缓存 / 推送失败与链下重试）
- `src/Vault/view/modules/PositionView.sol`
- `src/Vault/view/modules/HealthView.sol`
- `src/Vault/view/modules/StatisticsView.sol`
- `src/Vault/view/modules/ViewCache.sol`
- `src/Vault/view/modules/AccessControlView.sol`
- `src/Vault/view/modules/FeeRouterView.sol`
- `src/Vault/view/modules/RewardView.sol`
- `src/Vault/view/modules/ModuleHealthView.sol`
- `src/Vault/modules/lendingEngine/LendingEngineCore.sol`（推送失败事件 + best-effort 推送实现）
- `src/Vault/modules/CollateralManager.sol`（push delta 失败事件 `ViewCachePushFailed`）
- `src/Vault/view/modules/LiquidatorView.sol`（清算 DataPush 单点推送）
- 其它 View 门面/聚合器（不持久化缓存）：`SystemView/DashboardView/CacheOptimizedView/PreviewView/UserView/BatchView/LendingEngineView/RegistryView/RiskView/LiquidationRiskView/...`

### 5.3 C 类（业务内部缓存/工具缓存）
- `src/registry/RegistrySignatureManager.sol`（domain separator cache）
- `src/Reward/RewardManagerCore.sol`（PointCache）
- `src/Reward/internal/RewardModuleBase.sol`（RewardView address cache + PushFailed 事件）
- `src/libraries/GracefulDegradation.sol` / `src/monitor/GracefulDegradation.sol`（PriceCache）
- `src/Vault/FeeRouter.sol`（feeCache）
- `[REMOVED] src/Vault/liquidation/libraries/LiquidationRiskCacheLib.sol`（旧 risk cache helper，已移除）

### 5.4 全量清单表（逐文件、可审计）

> 口径：以“是否持久化缓存状态”为主；纯门面/纯 view 转发也在表内（标注为“无持久化缓存”）。

| 文件 | Class | 缓存字段（核心） | TTL/失效判定 | 写入者 | 权限（写/读） | 失败/重试路径 | A 类？ | 应实现 `ICacheRefreshable`？ |
|---|---:|---|---|---|---|---|---:|---|
| `src/Vault/VaultRouter.sol` | A | `_cachedCMAddr/_cachedLEAddr/_lastCacheUpdate` | `CACHE_EXPIRY_TIME`（过期自动更新） | 合约自身 | 写：仅维护器；读：内部/公开 view | 维护器 best-effort + 事件审计 | ✅ | ✅ |
| `src/Vault/liquidation/modules/LiquidationRiskManager.sol` | A | `_moduleCache.moduleAddresses[]` + `cacheTimestamps[]` | `maxCacheDurationVar`；stale 读路径 fallback | 合约自身 | 写：仅维护器；读：业务/视图查询 | best-effort，不阻断；维护器可审计 | ✅ | ✅ |
| `src/registry/CacheMaintenanceManager.sol` | A-ops | N/A（维护器不缓存） | N/A | 治理脚本 | `ACTION_SET_PARAMETER` | `CacheRefreshAttempted/BatchCompleted` | ✅（入口） | N/A |
| `src/interfaces/ICacheRefreshable.sol` | A-meta | N/A | N/A | N/A | N/A | N/A | ✅（规范） | N/A |
| `src/constants/ModuleKeys.sol` | A-meta | N/A | N/A | N/A | N/A | N/A | ✅（依赖 `KEY_CACHE_MAINTENANCE_MANAGER`） | N/A |
| `src/libraries/VaultRouterModuleLib.sol` | C (library) | `ModuleCache{cachedCMAddr,cachedLEAddr,lastCacheUpdate}` | `cacheExpiryTime` | 调用方 | internal | N/A | （同类语义） | ❌（库） |
| `src/Vault/view/modules/PositionView.sol` | B | user/asset 快照：collateral/debt + `timestamp/isValid` + `version/seq` | `ViewConstants.CACHE_DURATION` + `isValid` | CM/LE/VaultCore（推送） | 写：`ACTION_VIEW_PUSH`；读：view | 推送失败事件 + 链下重试 + admin retry | ❌ | ❌ |
| `src/Vault/view/modules/HealthView.sol` | B | user HF 缓存 + `cacheTimestamps`；模块健康快照 | user: `CACHE_DURATION`；模块健康按 `lastCheckTime` | 风控/引擎推送；健康检查由系统模块 push | 写：`ACTION_VIEW_PUSH`/系统状态；读：view | `HealthPushFailed`（上游）+ 链下重试 | ❌ | ❌ |
| `src/Vault/view/modules/StatisticsView.sol` | B | 系统/用户统计快照（带 `timestamp/lastUpdateTime`） | 以快照时间为准（无统一 TTL） | 统计写入方（系统模块） | 写：系统状态类 role；读：view | 失败按事件/链下补推 | ❌ | ❌ |
| `src/Vault/view/modules/FeeRouterView.sol` | B | 用户/全局 fee 统计镜像；`_lastSyncTimestamp`（观测） | 无 TTL；`SYNC_INTERVAL` 仅用于节奏/观测 | FeeRouter | 写：onlyFeeRouter；读：用户/ADMIN/系统 viewer | 上游再推/链下补推 | ❌ | ❌ |
| `src/Vault/view/modules/RewardView.sol` | B | 奖励聚合镜像（用户摘要/活动/系统榜单） | 无 TTL（镜像聚合） | Reward 模块 writer | 写：onlyWriter；读：用户/ADMIN/ops | `RewardViewPushFailed` + 链下重试/ADMIN retry | ❌ | ❌ |
| `src/Vault/view/modules/AccessControlView.sol` | B | 用户权限快照 + `cacheTimestamps[user]` | `ViewConstants.CACHE_DURATION` | ACM | 写：onlyACM；读：本人/ADMIN | ACM 再 push/链下补推 | ❌ | ❌ |
| `src/Vault/view/modules/ViewCache.sol` | B | 系统状态缓存（`isValid/timestamp`） | `CACHE_DURATION` + `isValid` | 系统写入方 | 写：`ACTION_VIEW_SYSTEM_DATA`；清理：ADMIN | 可重复覆盖/清理 | ❌ | ❌ |
| `src/Vault/modules/lendingEngine/LendingEngineCore.sol` | B (push impl) | 无持久化缓存；负责 push Position/Health | N/A | 业务主流程内部 | N/A | `CacheUpdateFailed/HealthPushFailed` + 链下重试 | ❌ | ❌ |
| `src/Vault/modules/CollateralManager.sol` | B (push impl) | 无持久化 view 缓存；负责 push delta | N/A | 业务主流程内部 | N/A | `ViewCachePushFailed` + 链下重试 | ❌ | ❌ |
| `src/Vault/FeeRouter.sol` | C | `_feeCache[token][feeType]`（费用累积缓存） | 无 TTL（治理清理） | FeeRouter 业务逻辑 | `ACTION_SET_PARAMETER` 可清理 | 业务治理决定重算/清理 | ❌ | ❌ |
| `src/Reward/RewardManagerCore.sol` | C | `_pointCache[user]` | `_cacheExpirationTime`（如 1h） | RMCore | 治理调参；业务内部写 | 非推送失败模型 | ❌ | ❌ |
| `src/Reward/internal/RewardModuleBase.sol` | C | `_cachedRewardViewAddr/_cachedRewardViewTs` | `RV_CACHE_TTL`（如 1h） | Reward 模块内部 | internal | 推送失败 emit `RewardViewPushFailed` | ❌ | ❌ |
| `src/registry/RegistrySignatureManager.sol` | C | `_domainSeparatorValue/_cachedChainId` | chainId 变化时动态重算 | 合约自身 | 管理员升级体系 | 无运维刷新必要 | ❌ | ❌ |
| `src/core/CoinGeckoPriceUpdater.sol` | C（业务内部） | `_lastValidPrice/_lastUpdateTime/_updateFailureCount`（业务内“最近值/状态”，不属于模块地址缓存） | 由业务流程覆盖更新 | 合约自身 | 内部写；外部写入口需 `ACTION_*` | N/A | ❌ | ❌ |
| `src/libraries/GracefulDegradation.sol` | C | `priceCache[asset]` | `maxPriceAge` + `isValid` | 调用方写入 | 取决于调用合约 | 降级回退 + 监控 | ❌ | ❌ |
| `src/monitor/GracefulDegradation.sol` | C | 同上（监控侧读取/写入） | 同上 | 监控模块 | 系统状态/监控权限 | 降级统计 + 事件 | ❌ | ❌ |
| `src/Reward/BaseServiceConfig.sol` | None（无缓存） | N/A | N/A | N/A | N/A | N/A | ❌ | ❌ |
| `[REMOVED] src/Vault/liquidation/libraries/LiquidationRiskCacheLib.sol` | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| `src/Vault/view/modules/SystemView.sol` | None（门面） | `_viewCache` 存储字段保留（存储布局兼容）；getter 动态从 Registry 读 | N/A（动态读取，无 stale 风险） | initialize | 读：system viewer；写：无 | N/A | ❌ | ❌ |
| `src/Vault/view/modules/RegistryView.sol` | None（门面） | 无持久化缓存（实时从 Registry 枚举/分页） | N/A | N/A | 读：view | N/A | ❌ | ❌ |
| `src/Vault/view/modules/ValuationOracleView.sol` | None（门面） | 无持久化缓存（best-effort 调 Oracle） | N/A | N/A | 读：`ACTION_VIEW_SYSTEM_DATA` | best-effort 返回 0/false | ❌ | ❌ |
| `src/Vault/view/modules/RiskView.sol` | None（门面） | 无持久化缓存（读取 HealthView 缓存） | 依赖 HealthView TTL | N/A | 读：开放（内部再读 Role 依赖） | HealthView invalid 时回退默认 | ❌ | ❌ |
| `src/Vault/view/modules/LiquidationRiskView.sol` | None（门面） | 无持久化缓存（读取 HealthView cacheTimestamp） | 依赖 HealthView TTL | N/A | 读：`ACTION_VIEW_RISK_DATA`/本人 | N/A | ❌ | ❌ |
| `src/Vault/view/modules/LendingEngineView.sol` | None（门面） | 无持久化缓存（读核心引擎 view adapter） | N/A | N/A | 读：view | N/A | ❌ | ❌ |
| `src/Vault/view/modules/BatchView.sol` | None（门面） | 无持久化缓存（批量聚合调用） | N/A | N/A | 读：按 actionKey 分流 | N/A | ❌ | ❌ |
| `src/Vault/view/modules/DashboardView.sol` | None（门面） | 无持久化缓存（封装 Position/Health/Stats） | 依赖下游 TTL | N/A | 读：`ACTION_VIEW_*` | N/A | ❌ | ❌ |
| `src/Vault/view/modules/CacheOptimizedView.sol` | None（门面） | 无持久化缓存（封装 Position/Health/Stats） | 依赖下游 TTL | N/A | 读：`ACTION_VIEW_*` | N/A | ❌ | ❌ |
| `src/Vault/view/modules/UserView.sol` | None（门面） | 无持久化缓存（委托到 Health/Position/Preview） | 依赖下游 TTL | N/A | 读：按接口约束/role | N/A | ❌ | ❌ |
| `src/Vault/view/modules/PreviewView.sol` | None（门面） | 无持久化缓存（只读估算） | N/A | N/A | 读：本人或 VIEW_USER_DATA/ADMIN | N/A | ❌ | ❌ |
| `src/Vault/view/modules/LiquidatorView.sol` | None（门面） | 无持久化缓存（清算统计迁移链下，链上占位） | N/A | N/A | 读：system viewer/用户权限 | N/A | ❌ | ❌ |
| `src/Vault/view/modules/EventHistoryManager.sol` | None（事件桥） | 无持久化缓存（只 emit `HistoryRecorded`） | N/A | 业务模块调用 `recordEvent` | 写：`ACTION_MANAGE_EVENT_HISTORY`；读：链下索引 | N/A | ❌ | ❌ |

---

## 6) 实施检查清单（推荐）

### A 类统一入口检查
- [ ] 所有“模块地址缓存”的合约实现 `ICacheRefreshable.refreshModuleCache()`
- [ ] `refreshModuleCache()` 仅允许 `Registry.KEY_CACHE_MAINTENANCE_MANAGER` 调用
- [ ] 治理脚本只调用 `CacheMaintenanceManager.batchRefresh()`，不再直调各合约刷新函数
- [ ] 维护器逐 target 记录 `CacheRefreshAttempted`，链下可告警/审计

### B 类推送与重试检查
- [ ] 推送失败不回滚账本主流程（best-effort）
- [ ] 推送失败发事件（至少包含 user/viewAddr/payload/reason）
- [ ] 关键缓存读接口返回 `isValid` 或等价标识
- [ ] 并发场景：优先使用 `nextVersion` + 可选 `requestId/seq`


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
- View 读接口返回 `(value, isValid)` 或 `struct.isValid` + `blockNumber`
- 推送失败：**不回滚主流程**，发失败事件（如 `CacheUpdateFailed/HealthPushFailed/RewardViewPushFailed/...`），链下人工/脚本重放
- 并发与幂等：`nextVersion`（严格）+ `requestId/seq`（可选）

### C 类：业务内部缓存 / 工具缓存（Internal / Utility Cache）❌ **不统一入口**

**定义**：Reward 内部 address cache、积分计算缓存、GracefulDegradation 的价格缓存、Registry 签名域分隔符缓存等。  
这类缓存语义强、形态多，强行纳入统一 refresh 会扩大权限面、混淆语义，违背“职责分离”。

### D 类：链下索引 / 数据库读模型（Off-chain Index + DB Read Model）✅ **统一接口契约（分页/幂等/重组）**

**定义**：链下“浏览器能力”层。它不是链上 cache，而是通过 **链上事件/日志** 派生出的可查询数据库（用于历史/搜索/跨用户聚合/排行榜/审计）。

**为什么要单列（以及为什么前端不该直扫 RPC）**：
- 链上 View 擅长“当前状态 + meta（isValid/blockNumber/version）”，但不适合做长历史范围的检索。
- 区块浏览器能力（按地址查历史、按订单查全生命周期、全局筛选）必须依赖链下索引与数据库二级索引。

**与本仓库 A/B/C 的关系**：
- A 类（模块地址缓存）与 B 类（View 快照缓存）解决的是“降低链上读成本 / 减少 RPC 次数”。
- D 类解决的是“把链上不可直接高效查询的历史与聚合问题”迁移到链下，用分页 API 提供给前端/运营。
- B 类推送失败事件（如 `CacheUpdateFailed*`）应作为 D 类队列/重试系统的输入信号之一（可观测 → 可重放）。

**统一要求（接口契约）**：
1) **天然幂等键**：每条链上日志以 `(chainId, txHash, logIndex)` 唯一。
  - 该键应直接映射为链下幂等 key（参见 SaaS 指南中的 `chain:{chainId}:{txHash}:log-{logIndex}` 口径）。
2) **重组（reorg）处理**：
  - 索引表应至少存 `blockNumber + blockHash`，并支持把“未最终确定”的窗口内事件标记为 `PENDING/CONFIRMED/REORGED`。
3) **分页规范**：
  - 时间序列/历史查询建议优先 cursor（按 `timestamp` 或 `(blockNumber, logIndex)` 游标）而不是无限 offset。
  - 若使用 offset，必须限制 `limit` 上限（建议 ≤ 100），并对大查询做服务端索引与速率限制。
4) **权限与多租户**：
  - D 类 API 是 SaaS 面向前端/运营的主要入口，必须走租户隔离（`tenant_id`）与权限控制（与链上 `VIEW_*_DATA` 口径一致）。

#### D.1 命名对齐（建议默认值，可直接落地）

> 目标：让“索引器 / API / 前端”三方只靠命名就能对齐，不再出现一堆 `history/records/list` 的口径分叉。

**表命名（PostgreSQL / Prisma）**
- `chain_sync_cursors`：索引进度（每条链/每个 cursorName 一行）
- `chain_events`：原始事实表（按 `(chainId, txHash, logIndex)` 幂等写入）
- `loan_orders`：派生读模型（给前端分页/筛选/列表用）

**幂等键命名**
- `chainEventId = "c{chainId}:{txHash}:log-{logIndex}"`

**游标命名（cursorName）**
- `vault_router_datapushed`
- `loan_nft_transfers`
- `lending_engine_loan_order_created`

**API 路由命名（当前后端已落地；统一挂在 `/api` 下）**
- `/api/portfolio/*`：用户仓位快照/历史（offset 分页）
- `/api/rewards/*`：积分余额/账本/AI 使用记录
- `/api/ai-credits/balance`：AI Credits 余额
- `/api/cache-retry/*`：View cache 重试入口
- `/api/contracts/*`：合约配置/ABI（JWT）

> 说明：`/api/explorer/*`（链上事件浏览器能力）当前**尚未落地**，需要新增索引器与读模型后再加。

**分页约束（统一口径）**
- `limit`：1–100（默认 50）
- `cursor`：不透明字符串（建议 base64 编码的 `(blockNumber, logIndex)` 或时间戳）
- 返回：`{ items, pageSize, nextCursor }`

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


---

## 3) View 业务缓存（B 类）：推送、幂等、有效性与失败事件

### 3.1 B 类总表（View 层业务缓存/快照）

| 文件 | 缓存字段（核心） | TTL/失效判定 | 写入者（谁 push） | 权限（写/读） | 失败/重试路径 | 是否应实现 `ICacheRefreshable` |
|---|---|---|---|---|---|---|
| `src/Vault/view/modules/PositionView.sol` | `_collateralCache/_debtCache/_cacheTimestamps` + `version/seq/requestId` | `ViewConstants.CACHE_DURATION`；失效读回退账本 | CM/LE/VaultCore/VBL/VaultRouter（`onlyBusinessContract`） | 写：`ACTION_VIEW_PUSH`；读：view | 账本读失败 emit `CacheUpdateFailed`；链下重放；链上 admin `retryUserPositionUpdate` | ❌ |
| `src/Vault/view/modules/HealthView.sol` | `_healthFactorCache/_cacheTimestamps`；`_moduleHealth` | `ViewConstants.CACHE_DURATION`（user）；模块健康为“lastCheck+failures” | 风控/账本模块 push | 写：`ACTION_VIEW_PUSH`；模块健康：`ACTION_VIEW_SYSTEM_STATUS`/ADMIN；读：view | 失败建议按 `HealthPushFailed`（见 `LendingEngineCore`）+链下重试 | ❌ |
| `src/Vault/view/modules/StatisticsView.sol` | `_globalSnapshot/_userSnapshots/_userStatsVersion/_userGuarantees` 等 | 无统一 TTL（以快照 `blockNumber` 为准） | 业务模块推送（系统统计/降级统计） | 写：系统状态/管理员 role；读：view | 以事件/快照覆盖为主；可链下重推 | ❌ |
| `src/Vault/view/modules/AccessControlView.sol` | `_userPermissionsCache/_userPermissionLevelCache/_cacheTimestamps[user]` | `ViewConstants.CACHE_DURATION` | AccessControlManager（`onlyACM`） | 写：onlyACM；读：本人或 ADMIN | 依赖 ACM 再 push；无统一重试入口 | ❌ |
| `src/Vault/view/modules/ViewCache.sol` | `_systemStatusCache[asset]` + `isValid` + `blockNumber` | `CACHE_DURATION` + `struct.isValid` | 具备 `ACTION_VIEW_SYSTEM_DATA` 的写入方 | 写：`ACTION_VIEW_SYSTEM_DATA`；清理：`ACTION_ADMIN` | 可重复覆盖/清理，无链上重试模型 | ❌ |
| `src/Vault/view/modules/FeeRouterView.sol` | `_userFeeStatistics/_userDynamicFees/_globalFeeStatistics/_systemConfig/_lastSyncBlock` | 无 TTL；`SYNC_INTERVAL` 用于“同步节奏/观测” | FeeRouter（`onlyFeeRouter`） | 写：onlyFeeRouter；读：本人/ADMIN（部分系统数据 onlyAdmin） | 失败主要来自上游未推送；可由 FeeRouter 再推 | ❌ |
| `src/Vault/view/modules/RewardView.sol` | `_userSummary/_activities/_consumptions/_systemStats` | 无 TTL（镜像聚合） | RewardManagerCore/EasyConsumption/EasyRecycleDistributor 等（`onlyWriter`） | 写：onlyWriter；读：本人或 VIEW_USER_DATA/ADMIN；系统榜单 onlyOps | 推送失败：见 `RewardViewPushFailed`（RewardModuleBase）；链上提供 `retryPush*`（ADMIN） | ❌ |
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
| `src/libraries/GracefulDegradation.sol` | `CacheStorage.priceCache[asset]` | `maxPriceAge` + `PriceCache.isValid` | 调用方在 non-view 路径写入 | 取决于调用合约 | 降级回退 + 监控事件 | ❌ |
| `src/Vault/FeeRouter.sol` | `_feeCache[token][feeType]` | 无 TTL（手动清理） | FeeRouter 业务逻辑 | `clearFeeCache`: `ACTION_SET_PARAMETER` | 清理/重算由业务治理决定 | ❌ |
| `[REMOVED] src/Vault/liquidation/libraries/LiquidationRiskCacheLib.sol` | 旧 risk cache helper（无统一 TTL/失败模型） | N/A | N/A | N/A | N/A | N/A |

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
- `src/libraries/GracefulDegradation.sol`（PriceCache）
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
| `src/Vault/view/modules/PositionView.sol` | B | user/asset 快照：collateral/debt + `blockNumber/isValid` + `version/seq` | `ViewConstants.CACHE_DURATION` + `isValid` | CM/LE/VaultCore（推送） | 写：`ACTION_VIEW_PUSH`；读：view | 推送失败事件 + 链下重试 + admin retry | ❌ | ❌ |
| `src/Vault/view/modules/HealthView.sol` | B | user HF 缓存 + `cacheTimestamps`；模块健康快照 | user: `CACHE_DURATION`；模块健康按 `lastCheckTime` | 风控/引擎推送；健康检查由系统模块 push | 写：`ACTION_VIEW_PUSH`/系统状态；读：view | `HealthPushFailed`（上游）+ 链下重试 | ❌ | ❌ |
| `src/Vault/view/modules/StatisticsView.sol` | B | 系统/用户统计快照（带 `blockNumber/lastUpdateTime`） | 以快照时间为准（无统一 TTL） | 统计写入方（系统模块） | 写：系统状态类 role；读：view | 失败按事件/链下补推 | ❌ | ❌ |
| `src/Vault/view/modules/FeeRouterView.sol` | B | 用户/全局 fee 统计镜像；`_lastSyncBlock`（观测） | 无 TTL；`SYNC_INTERVAL` 仅用于节奏/观测 | FeeRouter | 写：onlyFeeRouter；读：用户/ADMIN/系统 viewer | 上游再推/链下补推 | ❌ | ❌ |
| `src/Vault/view/modules/RewardView.sol` | B | 奖励聚合镜像（用户摘要/活动/系统榜单） | 无 TTL（镜像聚合） | Reward 模块 writer | 写：onlyWriter；读：用户/ADMIN/ops | `RewardViewPushFailed` + 链下重试/ADMIN retry | ❌ | ❌ |
| `src/Vault/view/modules/AccessControlView.sol` | B | 用户权限快照 + `cacheTimestamps[user]` | `ViewConstants.CACHE_DURATION` | ACM | 写：onlyACM；读：本人/ADMIN | ACM 再 push/链下补推 | ❌ | ❌ |
| `src/Vault/view/modules/ViewCache.sol` | B | 系统状态缓存（`isValid/blockNumber`） | `CACHE_DURATION` + `isValid` | 系统写入方 | 写：`ACTION_VIEW_SYSTEM_DATA`；清理：ADMIN | 可重复覆盖/清理 | ❌ | ❌ |
| `src/Vault/modules/lendingEngine/LendingEngineCore.sol` | B (push impl) | 无持久化缓存；负责 push Position/Health | N/A | 业务主流程内部 | N/A | `CacheUpdateFailed/HealthPushFailed` + 链下重试 | ❌ | ❌ |
| `src/Vault/modules/CollateralManager.sol` | B (push impl) | 无持久化 view 缓存；负责 push delta | N/A | 业务主流程内部 | N/A | `ViewCachePushFailed` + 链下重试 | ❌ | ❌ |
| `src/Vault/FeeRouter.sol` | C | `_feeCache[token][feeType]`（费用累积缓存） | 无 TTL（治理清理） | FeeRouter 业务逻辑 | `ACTION_SET_PARAMETER` 可清理 | 业务治理决定重算/清理 | ❌ | ❌ |
| `src/Reward/RewardManagerCore.sol` | C | `_pointCache[user]` | `_cacheExpirationTime`（如 1h） | RMCore | 治理调参；业务内部写 | 非推送失败模型 | ❌ | ❌ |
| `src/Reward/internal/RewardModuleBase.sol` | C | `_cachedRewardViewAddr/_cachedRewardViewTs` | `RV_CACHE_TTL`（如 1h） | Reward 模块内部 | internal | 推送失败 emit `RewardViewPushFailed` | ❌ | ❌ |
| `src/registry/RegistrySignatureManager.sol` | C | `_domainSeparatorValue/_cachedChainId` | chainId 变化时动态重算 | 合约自身 | 管理员升级体系 | 无运维刷新必要 | ❌ | ❌ |
| `src/core/CoinGeckoPriceUpdater.sol` | C（业务内部） | `_lastValidPrice/_lastUpdateTime/_updateFailureCount`（业务内“最近值/状态”，不属于模块地址缓存） | 由业务流程覆盖更新 | 合约自身 | 内部写；外部写入口需 `ACTION_*` | N/A | ❌ | ❌ |
| `src/libraries/GracefulDegradation.sol` | C | `priceCache[asset]` | `maxPriceAge` + `isValid` | 调用方写入 | 取决于调用合约 | 降级回退 + 监控 | ❌ | ❌ |
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

---

## 统一验收清单（同款模板）

- [ ] View 读路径：Registry 能解析到正确的 View 地址（含 `LOAN_NFT_VIEW` 等），且 `apiVersion()/schemaVersion()` 预检通过
- [ ] 浏览器直读：前端对所有 View 返回的 `isValid/blockNumber/version` 做降级展示（不会 silent wrong）
- [ ] 分页边界：所有批量/分页接口遵守链上 `MAX_BATCH_SIZE`（默认 100），超限会分片或拒绝
- [ ] 后端读模型：历史/搜索 API 走 DB，具备 cursor 分页与必要索引（不扫 RPC）
- [ ] 幂等与重试：链上事件写库按 `(chainId, txHash, logIndex)` 幂等；失败可观测并可重放
- [ ] 权限与多租户：Scheme U/系统权限边界清晰；后端 API 做租户隔离与鉴权（不能靠 `eth_call from` 冒充）

## 上线前统一 Checklist（DB/Redis/Feature Flag/Routes/Pagination/Idempotency/Reorg）

- [ ] DB 就绪：迁移已跑完；关键表/索引存在；读写账号最小权限；RLS/tenant 规则（如有）已启用
- [ ] Redis 就绪：连接/ACL/TTL 策略明确；幂等锁前缀包含 `tenantId`；监控命中率与容量
- [ ] Feature Flag：新读路径（View/Explorer API）有开关；支持按租户/环境灰度；默认关闭可回退
- [ ] 生效路由：`/api/portfolio/*`、`/api/rewards/*`、`/api/ai-credits/balance`、`/api/cache-retry/*`、`/api/contracts/*` 已注册并纳入鉴权/限流（含相应开关）
- [ ] 分页边界：`limit` 默认/上限固定；`cursor/offset` 越界返回空列表而非 500；排序稳定（按 `(blockNumber, logIndex)`）
- [ ] 幂等键约定：跨服务透传 `X-Idempotency-Key`；链上事件幂等键格式固定为 `chain:c{chainId}:{txHash}:log-{logIndex}`
- [ ] 重组窗口约定：明确 `finalityDepth`（如 64 blocks）与状态（`PENDING/CONFIRMED/REORGED`）；窗口内数据可回滚重算


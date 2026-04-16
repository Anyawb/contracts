## StatisticsView 严格 B+（Snapshot + 单入口编排器）实施清单

> 目标：让 Statistics 链路**完全对齐** `docs/Architecture-Guide.md` 与 `docs/Usage-Guide/ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 的 MUST 语义：
> **可观测、可重放、可去重、抗并发覆盖、不会卡主流程**，并让链下重试“简单且不易错”。
>
> 本清单落地 **B+（Snapshot + 单入口编排）**：
> - 写入语义从 **delta** 改为 **权威快照 snapshot**
> - `seq/requestId/nextVersion` 的生成与推送收敛到 **唯一链上入口**（`StatisticsPushManager`）
> - 链下重试入口为 **重算快照后再推**（不重放 delta）

---

### 0. 术语与关键约束（MUST）

- **SSOT（Single Source of Truth）**：账本权威状态来自 `CollateralManager` 与 `LendingEngine`（以及 `GuaranteeFundManager`）。
- **B 类缓存**：`StatisticsView` 仅是加速层缓存；push 失败不允许阻断账本写路径。
- **Key 维度**
  - **user stats key**：`(user)`（collateralTotal + debtTotal）
  - **guarantee key**：`(user, asset)`（userBalance + totalByAsset）
- **事件口径（SSOT）**：失败统一 `CacheEvents.CacheUpdateFailedWithContext`（含 `requestId/seq/nextVersion`）。

---

### 1. 合约侧改造点（B+ 三个核心）

#### 1.1 核心 1：Statistics 写入语义从 delta 改为 snapshot

在 `StatisticsView` 新增/主推：

- `pushUserStatsSnapshot(user, collateralValue, debtValue, requestId, seq, nextVersion)`
  - 内部以 `newSnapshot - oldSnapshot` 更新系统聚合：
    - `global.totalCollateral`
    - `global.totalDebt`
    - `activeUsers`
  - 成功后 emit `DataPushed(DATA_TYPE_USER_STATS_UPDATE, payload)`，payload 可解码对账

- `pushGuaranteeSnapshot(user, asset, userBalance, totalByAsset, requestId, seq, nextVersion)`
  - `CacheUpdateFailedWithContext` 的 `(collateral, debt)` 字段在该类失败中承载 `(userBalance, totalByAsset)`，用于稳定重放

并提供 pusher 专用版本读取（role-gated）：

- `getUserStatsVersionForPusher(user)`
- `getGuaranteeVersionForPusher(user, asset)`

> 备注：delta 入口（`pushUserStatsUpdate` / `pushGuaranteeUpdate`）可保留作兼容，但 B+ 链路中必须停止调用，避免“delta + snapshot”双写导致重复累加。

#### 1.2 核心 2：单一链上入口编排器（防止多模块 seq 冲突）

新增模块 `StatisticsPushManager`（建议 Registry key：`ModuleKeys.KEY_STATS_PUSH_MANAGER`）：

- **唯一调用者**：只有它会调用 `StatisticsView.push*Snapshot(...)`
- **生成上下文（MUST）**
  - `seq`：对每个 key 单调递增
    - user stats：`seq[user]++`
    - guarantee：`seq[user][asset]++`
  - `requestId`：与 seq 绑定（确定性）
  - `nextVersion`：读取 `StatisticsView` 当前版本后 `+1`
- **读 SSOT 快照（MUST）**
  - collateralTotal（**USD value**）：调用 `PositionView.getUserTotalCollateralValue(user)`（估值 SSOT，跨资产聚合前必须显式归一化）
  - debtTotal（**USD value**）：调用 `LendingEngine.getUserTotalDebtValue(user)`（估值 SSOT，跨资产聚合前必须显式归一化）
  - guarantee：`GuaranteeFundManager.getLockedGuarantee/getTotalGuaranteeByAsset`
- **try/catch push（MUST）**
  - 成功：由 `StatisticsView` 发 `DataPushed`
  - 失败：编排器统一 emit `CacheUpdateFailedWithContext(...)`（包含 snapshot payload + requestId/seq/nextVersion）
- **best-effort（MUST）**：notify/retry 均不应 revert 上游账本流程

#### 1.3 核心 3：重试入口做成“重算快照后再推”

编排器提供运维/机器人可用的重试函数（role-gated）：

- `retryUserStats(user)`：重算 SSOT 快照 → 读版本 → `nextVersion+1` → push snapshot
- `retryGuarantee(user, asset)`：重算 SSOT 快照 → push snapshot

这严格符合架构指南：“链下重试应先重新读取最新账本，确认一致或可接受才推送”。

---

### 2. 调用方改造（写模块只做 best-effort notify）

目标：让调用方**不再复制** `seq/requestId/nextVersion` 与 `try/catch + 失败事件`。

- `CollateralManager`：每次 collateral 账本写入成功后调用：
  - `StatisticsPushManager.notifyUserStats(user)`（best-effort）
- `VaultLendingEngine`：每次 debt 账本写入成功后调用：
  - `StatisticsPushManager.notifyUserStats(user)`（best-effort）
- `GuaranteeFundManager`：每次 guarantee SSOT 余额变化后调用：
  - `StatisticsPushManager.notifyGuarantee(user, asset)`（best-effort）
- `VaultRouter`：不得再直接推 Stats（避免双写）

---

### 3. Registry/权限/部署清单（必须按顺序）

#### 3.1 Registry 绑定（SSOT）

- `ModuleKeys.KEY_STATS` → `StatisticsView`
- `ModuleKeys.KEY_STATS_PUSH_MANAGER` → `StatisticsPushManager`

#### 3.2 权限（MUST）

- 给 `StatisticsPushManager` 授权：
  - `ActionKeys.ACTION_VIEW_PRICE_DATA`（用于读取 `PositionView` 的估值快照）
- 给 keeper/后端重试服务地址授权：
  - `ActionKeys.ACTION_VIEW_PUSH`（用于调用 `StatisticsPushManager.retry*`）

> 若权限缺失：编排器会 emit `CacheUpdateFailedWithContext` 并返回，不会卡主流程，但链路无法自愈。

---

### 4. 链下重试闭环（offchain MUST）

#### 4.1 监听与入队

监听：
- `CacheEvents.CacheUpdateFailedWithContext`

入队字段：
- `user`, `asset`, `viewAddr`
- `requestId`, `seq`, `nextVersion`
- `collateral`, `debt`（在 B+ 中这是“期望写入的 snapshot”）
- `reason`

#### 4.2 重试策略（推荐默认）

不要直接“重放 delta”。使用编排器重算快照：

- user stats：调用 `StatisticsPushManager.retryUserStats(user)`
- guarantee：调用 `StatisticsPushManager.retryGuarantee(user, asset)`

---

### 5. 验收（必须可跑通）

#### 5.1 正常路径

- 任一会改变 collateral/debt 的 SSOT 写路径后：
  - `StatisticsView.getGlobalStatisticsWithMeta().lastUpdateTime` 单调推进
  - 观察到 `DataPushed(DATA_TYPE_USER_STATS_UPDATE, payload)`，payload 可解码且与快照一致

#### 5.2 失败与自愈

- 制造一次 push 失败（例如撤销 `StatisticsPushManager` 的 `ACTION_VIEW_PRICE_DATA`，使其无法读取估值快照）：
  - 必须出现 `CacheUpdateFailedWithContext`
  - 恢复权限后调用 `retryUserStats/retryGuarantee` 可自愈（出现新的 `DataPushed`）

---

## 附录：对照验收表（Architecture-Guide + ARCH-VIEW-ALIGNMENT-WORKGUIDE + 本清单）

> 说明：本表用于“逐条验收”Stats 链路是否满足三份 SSOT 文档的要求，并给出**具体文件+行号**证据。  
> 图例：✅ 通过；⚠️ 待确认/依赖部署；<span style="color:red">❌ 未通过</span>。

| 规范级别 | 条目（要求） | 证据（文件:行） | 状态 | 差异/备注（如未通过，给出修复方向） |
|---|---|---|---|---|
| MUST | **B 类缓存对外读取必须带有效性信息**（至少 `isValid + blockNumber`；并发敏感建议含 `version`） | `src/Vault/view/modules/StatisticsView.sol:260-273`（global meta）；`src/Vault/view/modules/StatisticsView.sol:339-359`（user meta） | ✅ | - |
| MUST | **用户维度读取遵循 Scheme U**（self 放行；non-self 需 `ActionKeys.ACTION_VIEW_USER_DATA` / `ActionKeys.ACTION_ADMIN`；失败 `MissingRole()`） | `src/Vault/view/modules/StatisticsView.sol:200-207`（`onlyUserOrViewer`）；`src/Vault/view/modules/StatisticsView.sol:339-379`（user-scoped reads） | ✅ | - |
| MUST | **UUPS + 初始化安全**（实现合约禁用 initializer；proxy initializer 做 registry 校验；保留 storage gap） | `src/Vault/view/modules/StatisticsView.sol:208-241`（constructor+initialize）；`src/Vault/view/modules/StatisticsView.sol:156-158`（`__gap`） | ✅ | - |
| MUST | **View 模块统一版本信息入口 `getVersionInfo()`** | `src/Vault/view/ViewVersioned.sol:15-28`（`getVersionInfo`）；`src/Vault/view/modules/StatisticsView.sol:31`（继承 `ViewVersioned`） | ✅ | - |
| MUST | **DataPush 统一常量口径**（优先 `DataPushTypes`） | `src/constants/DataPushTypes.sol:115-121`（stats types）；`src/Vault/view/modules/StatisticsView.sol:1064-1077`（emit `DATA_TYPE_GUARANTEE_STATS_UPDATE`）；`src/Vault/view/modules/StatisticsView.sol:1079-1085`（emit `DATA_TYPE_USER_STATS_UPDATE`） | ✅ | - |
| MUST | **失败可观测：push 失败必须能被链下捕捉并重试**（`CacheUpdateFailedWithContext` 含 requestId/seq/nextVersion） | `src/Vault/CacheEvents.sol:43-53`（事件 SSOT）；`src/Vault/modules/StatisticsPushManager.sol:135-189`（失败 emit with context） | ✅ | - |
| MUST | **并发控制：`nextVersion` 严格乐观并发**（`incoming == current + 1`） | `src/Vault/view/modules/StatisticsView.sol:670-685`（user snapshot strict）；`src/Vault/view/modules/StatisticsView.sol:1044-1047`（guarantee snapshot strict） | ✅ | - |
| MUST | **幂等/顺序：支持 `requestId`（O(1) lastApplied）与 `seq`（可选但一致策略）** | `src/Vault/view/modules/StatisticsView.sol:814-837`（user snapshot idempotency + seq）；`src/Vault/view/modules/StatisticsView.sol:1028-1052`（guarantee snapshot idempotency + seq） | ✅ | - |
| MUST | **写入语义：B+ 主路径应使用 snapshot（而非 delta）** | `src/Vault/view/modules/StatisticsView.sol:645-685`（`pushUserStatsSnapshot`）；`src/Vault/view/modules/StatisticsView.sol:986-1077`（`pushGuaranteeSnapshot`） | ✅ | - |
| SHOULD | **B+ 链路中应停止调用 delta 入口**（避免 delta+snapshot 双写重复累加） | delta 入口仍存在：`src/Vault/view/modules/StatisticsView.sol:626-643`（`pushUserStatsUpdate`）；`src/Vault/view/modules/StatisticsView.sol:935-984`（`pushGuaranteeUpdate`） | ⚠️ | 允许保留兼容，但需要确保“生产调用方”只走 `StatisticsPushManager` → `push*Snapshot`。 |
| MUST | **单入口编排器存在且为唯一生成上下文来源**（`seq/requestId/nextVersion` 统一生成） | `src/constants/ModuleKeys.sol:62-67`（`KEY_STATS_PUSH_MANAGER`）；`src/Vault/modules/StatisticsPushManager.sol:44-58`（设计目标）；`src/Vault/modules/StatisticsPushManager.sol:141-174`（生成 seq/requestId/nextVersion） | ✅ | - |
| MUST | **编排器 best-effort：notify/retry 不得阻断上游写路径** | `src/Vault/modules/StatisticsPushManager.sol:92-113`（notify 接口）；`src/Vault/modules/StatisticsPushManager.sol:135-189`（失败 return，不 revert） | ✅ | - |
| MUST | **调用方改造：CM/LE/GFM 写入成功后只做 notify（best-effort）** | `src/Vault/modules/CollateralManager.sol:262-268`（notifyUserStats）；`src/Vault/modules/VaultLendingEngine.sol:189-195`（notifyUserStats）；`src/Vault/modules/GuaranteeFundManager.sol:240-246`（notifyGuarantee） | ✅ | - |
| MUST | **保证金 key 维度为 (user,asset)**（meta 不得被“同 asset 的别的用户更新”污染） | `src/Vault/view/modules/StatisticsView.sol:117-123`（`_guaranteeLastUpdate[user][asset]`）；`src/Vault/view/modules/StatisticsView.sol:1167-1177`（user-guarantee meta blockNumber） | ✅ | - |
| MUST | **本地 e2e 验收脚本不得依赖已不存在的 ABI（避免 selector not recognized）** | `scripts/e2e/e2e-localhost-statisticsview-acceptance.ts:106-216`（仅使用 `getGlobalStatisticsWithMeta` + `StatisticsPushManager.retry*`） | ✅ | - |
| SHOULD | **验收应覆盖“失败→自愈”闭环**（撤销权限触发 `CacheUpdateFailedWithContext`，恢复后 retry 成功） | 本清单：`docs/Usage-Guide/StatisticsView-Strict-B-Push-Pipeline-Implementation-Checklist.md:140-145`（要求）；当前脚本未覆盖“撤权→失败事件”分支 | ⚠️ | 建议在 `e2e-localhost-statisticsview-acceptance.ts` 补一段：临时撤销 `StatisticsPushManager` 的 `ActionKeys.ACTION_VIEW_PRICE_DATA`（或将 `POSITION_VIEW` registry key 指向 0 地址以模拟依赖缺失）→ 断言 `CacheUpdateFailedWithContext` → 恢复后 retry 再断言 `DataPushed`。 |
| SHOULD | **删除/标记 legacy helper，避免新代码误用旧 delta 推送路径** | `src/libraries/VaultBusinessLogicLibrary.sol:18-37`（legacy stats interfaces）；`src/libraries/VaultBusinessLogicLibrary.sol:172-234`（`safeUpdateStats/safeUpdateGuarantee` 直接调用 delta push） | ⚠️ | 建议：明确标记 `DEPRECATED` 并在注释中指向 `StatisticsPushManager.notify*/retry*`；或在业务合约中完全移除引用，防回归。 |
| MUST | **统计口径（SSOT）：collateral/debt 必须是跨资产统一的 value** | `src/Vault/modules/StatisticsPushManager.sol`：`_readUserTotalsValue统一 VALUE()` 通过 `PositionView.getUserTotalCollateralValue(user)` + `LendingEngine.getUserTotalDebtValue(user)` 推送 snapshot；`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`：Value Unit SSOT | ✅ | 已统一为 value SSOT；禁止再以 token base units 做跨资产累加，消费前必须显式归一化。 |
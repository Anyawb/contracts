# View 系统全面对齐《Architecture-Guide》改造工作指南（临时）

> 位置：`docs/Usage-Guide/ARCH-VIEW-ALIGNMENT-WORKGUIDE.md`  
> 状态：**临时工作文档**（当 View 系统全部改造完成并验收通过后删除）  
> 目标：让 `src/Vault/view/` 的实现**完全符合** `docs/Architecture-Guide.md` 对 View 系统的职责、权限、缓存、推送、幂等/并发与 DataPush 规范。

---

## 0.0 术语与规范级别（工程口径）

本文件是对 `docs/Architecture-Guide.md` 的**工程化拆解**，用于落地与验收；当本文件与架构指南描述不一致时，**以 `docs/Architecture-Guide.md` 为 SSOT**。

### 规范级别（强制语义）
- **MUST**：必须满足；不满足即视为“未对齐完成/不可验收”。
- **MUST NOT**：明确禁止；出现即视为“架构违背”。
- **SHOULD**：强烈建议；若不满足必须给出理由与替代实现，并在验收记录中说明。
- **MAY**：可选；按需求启用，但启用后必须满足相应约束。

### 术语（用于避免口径漂移）
- **SSOT**：Single Source of Truth，唯一真实来源（本项目以 `docs/Architecture-Guide.md` 为架构 SSOT）。
- **View（视图层）**：只读/聚合/缓存与事件驱动快照更新的加速层；**不承载账本权威写入**。
- **push\***：由业务模块/路由器在账本写入成功后触发的“快照推送”入口；必须遵循 best-effort + DataPush 可观测性。
- **B 类缓存**：业务快照缓存（如 Position/Health/Statistics/AccessControl 等）；对外读取必须返回缓存有效性信息。

---

## 0. 统一目标与硬约束

### 0.1 设计目标（MUST）
- **只读/聚合/缓存（MUST）**：View 层只做查询/聚合/缓存；**账本写入不经 View**。（✅ 已确认）
- **事件驱动（MUST）**：所有 push\* 写路径必须触发统一 DataPush（`DataPushLibrary._emitData(...)`），便于链下消费/重放/审计。（✅ 已确认）
- **B 类缓存可验证（MUST）**：所有 B 类缓存对外读取必须返回足够的有效性信息（至少 `isValid` + `blockNumber`；并发敏感场景应包含 `version`）。（✅ 已确认）
- **推送失败可观测（MUST）**：push\* 必须 best-effort；失败不得链上循环重试，必须通过事件告警 + 链下重试闭环。（✅ 已确认）
- **并发与幂等（MUST）**：关键缓存入口必须支持乐观并发控制（`nextVersion`）与幂等重放（`requestId`，必要时 `seq`）。（✅ 已确认）
- **职责边界（MUST）**：`SystemView` 仅作为统一入口/元信息路由；资产/价格/奖励/清算等查询应引导到专属 View。（✅ 已确认）
- **可升级与版本化（MUST）**：所有 `src/Vault/view/modules/*.sol` 满足 UUPS + `__gap`，并暴露统一版本信息 `getVersionInfo()`。（✅ 已确认）

### 0.2 明确禁止（MUST NOT）
- **MUST NOT**：把任何“账本权威状态”迁移进 View（View 是加速层，不是账本）。（✅ 已确认）
- **MUST NOT**：为 B/C 类缓存引入“统一刷新入口”（仅允许 A 类地址缓存存在统一刷新/维护入口）。（✅ 已确认）

---

## 1. View 模块清单与 Registry Key（对齐基准）

以 `docs/Architecture-Guide.md` 为唯一对照基准（SSOT）。

### 1.1 A) 核心 View（建议部署）
- `PositionView.sol`（✅ 已确认）
- `UserView.sol`（✅ 已确认）
- `HealthView.sol`（✅ 已确认）
- `StatisticsView.sol`（✅ 已确认）
- `ViewCache.sol`（✅ 已确认）
- `AccessControlView.sol`（✅ 已确认）
- `BatchView.sol`（✅ 已确认）
- `RegistryView.sol`（✅ 已确认）
- `SystemView.sol`（✅ 已确认）

### 1.2 B) 专属/扩展 View（建议部署）
- `DashboardView.sol`（✅ 已确认）
- `PreviewView.sol`（✅ 已确认）
- `RiskView.sol`（✅ 已确认）
- `ValuationOracleView.sol`（✅ 已确认）
- `FeeRouterView.sol`（✅ 已确认）
- `LendingEngineView.sol`（✅ 已确认）
- `ModuleHealthView.sol`（✅ 已确认）
- `EventHistoryManager.sol`（✅ 已确认）
- `CacheOptimizedView.sol`（✅ 已确认，仓库已有实现；作为批量门面/性能优化可选启用）

#### 1.2.1 前端“账户全景/资产面板”建议优先启用的扩展 View
下面这些对“让前端充分展示账户情况”最关键（按优先级从高到低）：
- **`DashboardView`**：把 `PositionView + HealthView + StatisticsView (+ Price)` 拼成单次/少量 RPC 的聚合输出，适合账户首页与资产面板。
- **`CacheOptimizedView`**（虽不在 1.2 清单，但仓库已有实现）：提供常用批量查询的轻量门面（如批量仓位/批量健康因子），对前端列表页性能非常友好。
- **`RiskView`**：给出 `liquidatable / warningLevel` 等前端直用的风险标签（减少前端重复计算与阈值分歧）。
- **`PreviewView`**：前端做操作前预估（deposit/withdraw/borrow/repay 的 HF/LTV/maxBorrowable）最依赖它；并且它天然是只读门面，符合架构。
- **`ValuationOracleView`**：批量价格与健康检查（对资产估值与展示“价格是否有效/是否降级”很关键）。
  - **实现口径（SSOT）**：健康检查必须走 `libraries/GracefulDegradation.checkPriceOracleHealth(priceOracle, asset)`，
    **不得**要求 `PriceOracle`（或任何 oracle 实现）提供 bespoke 的 `checkPriceOracleHealth` 方法（避免接口分叉）。
- **`FeeRouterView`**：若前端要展示用户手续费/费率/VIP 折扣/支持币种等，必须启用；否则可暂缓。
- **`LendingEngineView`**：若前端需要订单/撮合/重试次数/失败费用等“订单视角”的细节页，则启用；只做基础借贷的前端可暂缓。
- **`EventHistoryManager`**：链下索引更关键；前端若要做“链上最近操作记录”可以依赖它的事件流，但通常由后端/索引服务消费再提供给前端。
- **`ModuleHealthView`**：更多是运维/监控；前端一般不需要直接展示，除非你们要在 UI 里暴露系统组件健康状态。

### 1.3 C) 清算风险补充
- `LiquidatorView.sol`（✅ 已确认；Registry key 统一为 `ModuleKeys.KEY_LIQUIDATION_VIEW`，并兼容别名 `liquidatorView/liquidationView`）
- `SystemRiskView.sol`（✅ 已确认；system-scoped risk：仅全局阈值/系统参数（不得含 `user/users[]`）；按策略 2 收敛后推进停用 `LiquidationRiskView`）

### 1.4 文档术语统一（MUST）
- 清算相关 View 的对外命名在文档与代码中保持一致（以仓库现状为准）。（✅ 已确认：`LiquidatorView` 对应 Registry `KEY_LIQUIDATION_VIEW`，避免 “Liquidator vs Liquidation” 双口径漂移）

---

## 2. 全局统一规范（本次改造的“工程公约”）

### 2.1 权限（ActionKeys）口径（MUST）（✅ 已确认：已按代码现状收敛）
目标：相同敏感级别的数据，在所有 View 模块中使用一致的读权限策略；默认策略应与架构指南保持一致，避免“同类数据不同 gate”。

#### 2.1.1 权限分层（MUST，按架构指南主线落地）
- **用户私域数据（MUST）**：用户本人可读；非本人读需具备 `ACTION_VIEW_USER_DATA` 或 admin（按模块约束）。（✅ 已确认）
- **system-scoped risk（SystemRiskView，MUST 边界 + SSOT 风格读策略）**：
  - **边界（MUST）**：只承载全局阈值/系统参数；**不得**包含任何 `user/users[]` 维度接口（否则应按 Scheme U 归类为用户私域数据）。（✅ 已确认）
  - **读权限（MUST，已启用 gate）**：只读入口需 `ACTION_VIEW_RISK_DATA`（或 `ACTION_ADMIN` 旁路），无权限失败 `revert MissingRole()`。（✅ 已确认）
- **用户私域风险数据（MUST）**：以 `RiskView` 为承载，按 Scheme U（self 允许；non-self 仅 `ACTION_VIEW_USER_DATA`/`ACTION_ADMIN`；失败 `MissingRole()`）。（✅ 已确认）
- **健康因子只读（MUST，Scheme U 收口）**：`HealthView.getUserHealthFactorWithMeta/isUserLiquidatableWithMeta` 按 Scheme U；
  `batchGetHealthFactorsWithMeta(users)` 视为 users[] 枚举能力（无 self-bypass），需 `ACTION_VIEW_USER_DATA`/`ACTION_ADMIN`。（✅ 已确认）
- **价格数据（MUST）**：统一使用 `ACTION_VIEW_PRICE_DATA`（不得与 systemData 混用）。（✅ 已确认）
- **系统状态/运维数据（MUST）**：`ACTION_VIEW_SYSTEM_STATUS` / `ACTION_VIEW_SYSTEM_DATA`（区分“状态健康/运维”与“统计聚合”）。（✅ 已确认）
- **写入推送权限（MUST）**：push\* 写入口必须受控（`ACTION_VIEW_PUSH` 或等效 onlyXXX），仅允许被授权业务模块/路由器/核心入口调用。（✅ 已确认：各 View 的 push 入口均有 writer gate/role gate）
- **升级权限（MUST）**：`ACTION_ADMIN` 或 `ACTION_UPGRADE_MODULE`（与仓库既有安全标准一致）。（✅ 已确认）

**验收（MUST）**：同一类数据在不同 View 中不得出现 gate 口径分叉（例如同类价格读取出现不同 ActionKey / 有的公开有的 gate）。

### 2.2 DataPush（集中常量口径，MUST）（✅ 已确认：DataPushLibrary + DataPushTypes 已统一使用）
- **MUST**：所有 push\* 写路径必须调用 `DataPushLibrary._emitData(dataTypeHash, payload)`。
- **MUST**：`dataTypeHash` 必须来自“集中常量口径”：
  - **SHOULD（推荐默认）**：统一引用 `DataPushTypes.*`；
  - **MAY（迁移期）**：合约内 `bytes32 constant DATA_TYPE_... = keccak256("UPPER_SNAKE_CASE")`，但必须保证全局不重复/不冲突；新增类型 **SHOULD** 先进入 `DataPushTypes` 再被引用。
- **MUST**：批量 push（如存在）必须遵循 `ViewConstants.MAX_BATCH_SIZE` 校验（长度不合法必须 revert 或按既定错误风格处理，且全仓口径一致）。

**验收（MUST）**：对每个 push\* 入口，能在链上观察到对应 `DataPushed`（或等效）事件；并能用 `dataTypeHash` 唯一定位其语义。

### 2.3 B 类缓存输出形态（MUST）（✅ 已确认：主干 View 已按 meta 输出收口）
凡是维护缓存的模块（如 `PositionView/HealthView/StatisticsView/AccessControlView/FeeRouterView/RewardView/ViewCache`），对外读取接口必须提供：
- **有效性**：`isValid`（或明确的 `needsSync` / `validUntil` 等）
- **区块号**：`blockNumber`（或 `lastUpdateTime`）
- **可选：版本**：对并发敏感的 key（如 `(user, asset)`）提供 `version`

> 兼容说明（当前口径）：不再保留缺少 `blockNumber` 的 legacy getter；所有对外读取应统一返回
> `isValid + blockNumber (+ version)` 的 canonical `*WithMeta`（或等价）接口。

> 规则：Facade 类（如 `UserView/SystemView/CacheOptimizedView/DashboardView`）即使自己不存缓存，也应把下游模块的 `isValid/blockNumber` 透传或组合后输出，避免丢信息。

### 2.4 推送失败与链下重试（MUST）（✅ 已确认：已具备可自动化验收覆盖）
实现目标：对所有 best-effort push 点做到**可观测、可重放、可去重**（链下可形成稳定重试闭环）。
- **MUST**：push 失败必须发出失败事件（架构指南所述 `CacheUpdateFailed` / `CacheUpdateFailedWithContext` / `HealthPushFailed` 或等效事件），payload 必须足以定位与重放，至少包含：
  - key：`user/asset/view`（或等价的唯一 key）
  - snapshot：期望写入的数据快照（用于链下对账/重放）
  - reason：失败原因 bytes（来自 revert reason/custom error 编码）
  - context：`requestId/seq/nextVersion`（若该入口支持并发幂等字段）
- **MUST**：链下监听失败事件进入重试队列；同一 key 必须去重/节流，避免并发轰击。
- **MUST NOT**：链上循环重试（避免 gas 暴涨与重复失败）。

> 注意：推送失败的发起方通常是业务模块或路由器；View 模块自身如果做外部 staticcall 组合，也要 best-effort。
>
> ✅ 已补齐可自动化验收覆盖（核心链路）：
> - `PositionView`: 账本读取失败 emit `CacheUpdateFailedWithContext`，且 `retryUserPositionUpdate` 在账本仍失败时 best-effort 返回（不 revert）
>   - `test/Vault/view/PositionView.cache-validity.test.blockNumber`
> - `StatisticsPushManager`: 依赖缺失/权限缺失等内部失败 emit `CacheUpdateFailedWithContext`（best-effort），并可通过修复配置后 retry 自愈
>   - `test/StatisticsPushManager.usd8.snapshot.test.blockNumber`

### 2.5 并发/幂等（MUST）（✅ 已确认：PositionView/StatisticsView 已实现 nextVersion + requestId + seq）
对关键缓存写入入口，统一采用：
- `nextVersion`：  
  - `0` 表示合约自增（兼容/弱并发保证）；  
  - `!=0` 表示严格乐观并发：必须等于 `current+1`。
- `requestId`（推荐）：
  - 不做无限 mapping 累积；只存每个 key 的 `lastAppliedRequestId`（O(1)）。
  - 当发生重放：若 `nextVersion == currentVersion && requestId == lastAppliedRequestId` 则幂等忽略（不写、不 revert）。
- `seq`（MAY，可选增强）：单调递增序列，用于辅助链下排序与链上拒绝乱序。
  - **MUST**：若某模块启用 `seq` 约束，必须在模块内采用**单一一致策略**（“拒绝 revert”或“幂等忽略”二选一）并在 NatSpec/文档中写明；不得同模块内不同入口策略不一致。
  - **SHOULD（推荐默认）**：`seq <= currentSeq` 直接 revert（更易发现乱序与上游 bug）；若选择忽略必须给出理由并补齐链下告警。

---

## 3. 分阶段改造顺序（建议执行顺序）

### Phase 1：建立“统一口径”与全局标准
- 统一 `ActionKeys` 使用口径（尤其是 Price/Risk/User/SystemData 的边界）。
- 统一 DataPush 的“集中常量口径”：所有 `push*` 写路径调用 `DataPushLibrary._emitData(...)`，`dataTypeHash` 推荐统一收敛到 `DataPushTypes`；迁移期可使用合约内 `keccak256("UPPER_SNAKE_CASE")` 常量，但必须避免跨模块重复/冲突定义。
- 统一 B 类缓存输出：所有缓存读取暴露 `isValid/blockNumber`（必要时含 `version`），Facade 必须透传或组合后输出，避免丢失有效性信息。
- 统一“聚合门面/Facade 的 meta 透传接口”：`DashboardView` / `CacheOptimizedView` / `UserView` 等所有聚合门面**必须**提供 `*WithMeta` 版本接口，并在实现中优先调用下游专属 View 的 `*WithMeta`；若处于迁移期下游尚无该接口，允许 best-effort 回退（旧接口 + blockNumber/version 拼装），但不得对外丢失或隐藏有效性信息（至少可反推出 `isValid/blockNumber/(version)`）。
> 状态：✅ 已确认（Phase 1 的关键“口径层”已在主干实现中落地；见 §2.1~§2.3）

### Phase 2：修正职责边界（按 Architecture-Guide）
**目标（MUST）**：把“统一入口/门面”与“权威实现/缓存写入”彻底解耦，确保所有读路径对外呈现稳定、可发现、可迁移的入口。

**交付物（MUST）**
- `SystemView`：
  - **MUST**：只保留“路由/元信息/发现性 helper”（如 registry/getModule/模块枚举或等效能力）；不得维护业务缓存与业务数据存储。
  - **MUST**：对“资产/价格/奖励/清算”等请求提供可发现的跳转提示（返回目标模块地址/模块 key/路由信息），不得依赖 revert 文本作为唯一提示。
- `UserView`：
  - **MUST**：变为纯 façade：把仓位/健康/风险/奖励/统计等读取委托到专属 View（或账本只读接口）并组合输出。
  - **MUST**：对外输出不得丢失下游有效性信息（`isValid/blockNumber/(version)` 必须透传或组合后输出）。
- `CacheOptimizedView` / `DashboardView`（及所有聚合门面）：
  - **MUST**：只做聚合/批量转发；不得新增任何缓存写入（不得新增 push\* 入口与任何状态写入）。

**退出条件（MUST，可验收）**
- 对外入口可发现性：
  - `SystemView` 对任意模块 key/模块名（按现有实现能力）均能返回**可用地址或可消费的路由信息**（前端/SDK 可直接用于下一跳调用）。
- 职责边界可证明：
  - `SystemView`、`UserView`、`DashboardView/CacheOptimizedView` 不存在任何“账本写入”与“业务缓存写入”（代码审阅 + 静态检查：不存在对关键缓存映射的写入/不存在 push\* 写入函数）。
- 组合输出不丢信息：
  - 任一 façade 输出若依赖下游缓存，必须包含（或可反推出）下游 `isValid/blockNumber/(version)`；在脚本中可被断言（见 §5.1）。

### Phase 3：缓存可靠性与可观测性增强
**目标（MUST）**：best-effort push 的所有关键路径做到“可观测、可重放、可去重、抗并发覆盖”。
> 状态：✅ 已确认（Position/Statistics 的 strict 并发 + 幂等/顺序 + 失败事件已落地；其余模块持续按 §2.4 防回归）

**交付物（MUST）**
- 并发/幂等：
  - **MUST**：关键缓存写入入口（至少 `PositionView`、`StatisticsView`；以及任何会在高频路径被并发推送的缓存）支持 `nextVersion` 严格并发。
  - **SHOULD**：支持 `requestId`（O(1) lastAppliedRequestId）以实现幂等重放；如启用 `seq`，必须遵循 §2.5 的一致策略。
- 推送失败：
- **MUST**：push 失败路径发出失败事件（`CacheUpdateFailed`/`CacheUpdateFailedWithContext`/`HealthPushFailed` 或等效），payload 满足 §2.4 的可重放要求。
  - **MUST**：业务交易路径不得链上循环重试；失败闭环由链下重试完成。
- offchain 聚合类 View（如清算榜单/统计类）：
  - **SHOULD**：对“链下为权威来源”的输出，接口层必须提供 staleness/版本化信息（例如 `blockNumber`/`isValid`/`schemaVersion`），以便链下/前端识别新鲜度。

**退出条件（MUST，可验收）**
- 版本单调性：
  - 在脚本中对同一 key 连续 push：`version` 单调递增；错误 `nextVersion` 必须 revert；同 `requestId` 重放必须幂等（不改 version、数据不变）。
- 可观测性：
  - 每个关键 push\* 成功路径均能观察到 `DataPushed`；失败路径能观察到失败事件，并包含可用于链下重放的信息（key + snapshot + reason + context）。

> ✅ 已补齐验收用例（可直接运行/断言）：
> - `PositionView`：`test/Vault/view/PositionView.cache-validity.test.blockNumber`（nextVersion / requestId 幂等 / seq 乱序 / DataPushed）
> - 本地脚本：`scripts/tests/phase3-positionview-acceptance.blockNumber`（Phase 3 退出条件最小断言集）

### Phase 4：清理兼容债务与统一文档术语
**目标（MUST）**：消除“同一语义多入口/多命名/多口径”导致的集成分叉，使前端/SDK/链下索引只有一条稳定路径。
> 状态：⚠️ 待确认（属于持续清理项：需逐条核对 legacy getter/命名与脚本/前端配置是否仍存在分叉）

**交付物（MUST）**
- **MUST**：清理重复/冲突的 legacy getter 与过期命名；如必须保留兼容入口，需在文档中标为 deprecated 并给出替代入口（以架构指南为准）。
- **MUST**：清算相关 View 的对外命名在文档/代码/前端/脚本中完全一致（避免“同模块不同名字/同名字不同模块”）。
- **SHOULD**：把“可选增强策略”（如风险 gate）明确归档到一处（避免散落多处导致实施口径不一致）。

**退出条件（MUST，可验收）**
- 文档与实现一致：
  - `docs/Architecture-Guide.md` 与 `src/Vault/view/` 的模块命名/职责描述一致；脚本与前端配置引用同一命名体系。
- 入口收敛：
  - 对同一语义的查询/推送，仓库内不再存在多个“看起来都能用”的入口（或存在时已明确 deprecated 且有替代路径）。

**Deprecated Map（old → new，MUST 维护）**
> 目的：把“旧入口/旧术语”显式收口到一处；任何旧名只允许出现在本表与“兼容说明”中，禁止出现在“推荐路径/集成示例”里。
>
> 规则：old 项若仍保留在代码中，必须 `DEPRECATED/@deprecated` 标注并给出 new 替代；old 项若已移除/会 revert，脚本/前端/SDK 不得依赖其 revert 文本做集成。

| Old（禁止作为推荐路径） | New（canonical，推荐路径） | 说明 / 删除条件 |
|---|---|---|
| `LiquidationView`（旧称呼/旧文档口径） | `LiquidatorView`（Registry `KEY_LIQUIDATION_VIEW`；SystemView `routeLiquidation()`） | 统一只写 `LiquidatorView`；如历史内容必须提及旧称呼，只能放在“兼容说明/本表”。 |
| `getUserPosition(user, asset)`（legacy） | `PositionView.getUserPositionWithMeta(user, asset)`（或 `UserView.getUserPositionWithMeta` 透传） | 新接口必须包含 `isValid/blockNumber/version` 等 meta，避免“缓存新鲜度口径”分叉。 |
| `isUserCacheValid(...)`（legacy） | `PositionView.getUserCacheStatusWithMeta(...)` | 旧口径不再作为推荐路径；若保留兼容入口，必须显式标注 deprecated。 |
| `batchGetUserPositions(...)`（legacy） | `PositionView.batchGetUserPositionsWithMeta(...)` / `CacheOptimizedView.batchGetUserPositionsWithMeta(...)` | users[] 枚举能力需遵循 batch 权限口径；统一使用 meta 输出。 |

**Phase 4 验证清单（MUST，可机械执行）**
- **双写法收敛（必须为 0）**：
  - `rg -n "LiquidatorView\\s*/\\s*LiquidationView|LiquidationView \\(LiquidatorView\\)" docs scripts frontend-config src`
- **旧术语出现位置受控**（只允许出现在“兼容说明/Deprecated Map/历史文件名”等非推荐语境）：
  - `rg -n "\\bLiquidationView\\b" docs scripts frontend-config src`
  - 期望结果：若有命中，必须满足以下任一条件：
    - 位于本节 **Deprecated Map** 或明确标注“兼容说明/legacy”的段落
    - 指代历史文件名/历史测试名（例如 `LiquidationViewForward.test.blockNumber`）而非对外推荐入口
    - 代码注释中已明确 `DEPRECATED` 并指向 canonical 替代路径
- **推荐路径唯一**：
  - 对外文档/集成示例中，清算只读入口只允许出现：`LiquidatorView`（以及 `SystemView.routeLiquidation()` 作为路由提示）；不得出现 `LiquidationView` 作为同义名。

> 当上述验证清单全部满足（尤其“双写法为 0”且旧术语只出现在本节/兼容说明中），即可将本节状态从 `⚠️ 待确认` 更新为 `✅ 已确认`。

---

## 4. 逐模块对齐清单（验收标准）

> 下面每一项都要能在代码中点对点对应 Architecture-Guide 的要求；缺一项视为“未对齐完成”。

### 4.1 `SystemView`（✅ 已确认）
- **脚本**：`scripts/e2e/e2e-localhost-systemview-routing.ts`
- **MUST**：仅路由/元信息门面；不缓存、不维护业务数据。
- **MUST**：提供可发现的“专属 View 地址/模块 key 引导”（不得依赖 revert string 作为唯一提示）。
- **MUST**：权限使用符合系统级数据读取的统一口径。

**验证（MUST，可验收）**
- **返回字段**：对外只读输出必须能让前端/SDK 下一跳可执行（例如返回 module address / moduleKey / registryAddr 等；按现有接口为准）。
- **事件**：不得存在 push\* 写路径与 DataPush（`SystemView` 不应是业务数据 DataPush 的发起点）。
- **脚本断言**：
  - 调用 `SystemView` 的模块解析/枚举接口，返回地址非零且与 Registry 解析一致；
  - 对“资产/价格/奖励/清算”类入口：不得依赖 revert 文本（要么返回路由信息，要么返回明确可消费的跳转信息）。

### 4.2 `PositionView`（✅ 已确认）
- **脚本**：`scripts/tests/phase3-positionview-acceptance.ts`
- **MUST**：提供 `(user, asset)` 缓存读取 + `isValid/blockNumber/version`。
- **MUST**：写入入口具备 `nextVersion` 严格并发；支持 `requestId/seq` 幂等/顺序（按现状实现为准，但对外接口必须一致）。
- **MUST**：在链上/链下可观测：缓存写入事件 + DataPush 一致。

**验证（MUST，可验收）**
- **返回字段**：读取接口必须包含（或可直接读到）：
  - `collateral/debt`（或等效仓位快照字段）
  - `isValid` + `blockNumber` + `version`
- **事件**：
  - 成功 push 后必须出现 `DataPushed`（来自 `DataPushLibrary._emitData`），payload 能被链下解码为与写入快照一致。
- **脚本断言**：
  - 读 `currentVersion` → push(`nextVersion=current+1`) → 读回 `version` 递增、字段一致；
  - push 错误 `nextVersion` 必须 revert；
  - 重放同 `requestId` 必须幂等（不重复写、不递增 version）。

### 4.3 `HealthView`（✅ 已确认）
- **脚本**：`scripts/tests/view-schemeu-smoke-local.ts`
- **MUST**：健康因子缓存读取返回 `isValid` + `blockNumber`。
- **MUST**：批量接口受 `MAX_BATCH_SIZE` 限制；读权限按 Scheme U：
  - 单用户：self 放行；non-self 需 `ACTION_VIEW_USER_DATA`/`ACTION_ADMIN`
  - users[] 批量：无 self-bypass，需 `ACTION_VIEW_USER_DATA`/`ACTION_ADMIN`
- **MAY**：模块健康缓存（与 `ModuleHealthView` 推送对齐）。

**验证（MUST，可验收）**
- **返回字段**：`getUserHealthFactorWithMeta/batchGetHealthFactorsWithMeta` 返回值必须包含：
  - 健康因子数值（如 hfBps 或等效字段）
  - `isValid` + `blockNumber`
- **权限**：默认读路径必须可被任意调用者 `eth_call`（不强制 `ACTION_VIEW_RISK_DATA`）。
- **事件**：成功 push 风险状态后应出现 `DataPushed`；失败则必须有失败事件（见 §2.4）。
- **脚本断言**：
  - push 更新后读取值变化、blockNumber 单调推进；
  - 批量接口长度 > `MAX_BATCH_SIZE` 必须按统一错误口径失败；
  - 用无权限账号读取（默认策略下）不应 revert。

### 4.4 `StatisticsView`（✅ 已确认：Strict B+ 单入口编排器 + USD-8 已落地）
- **脚本**：`scripts/e2e/e2e-localhost-statisticsview-acceptance.ts`
- **MUST**：系统级聚合缓存对外只读（0 gas）。
- **MUST**：用户统计写入入口具备 `nextVersion`（严格）并发控制。
- **MUST**：保证金聚合/活跃用户等口径与文档一致。

#### 4.4.1 Value Unit SSOT（USD-8，必须统一）

> 背景：Stats/风险/HF/LTV/清算等模块需要跨资产聚合。若把不同资产的 **amount（token base units）** 直接相加，会在数学上失真。  
> 因此本仓库把 **value 输出口径** 统一收敛为：**USD value with 8 decimals（USD-8）**。

**换算公式（SSOT）**：

\[
\text{valueUSD8}=\frac{\text{amount(token base units)}\times\text{price(USD-8 per 1 token)}}{10^{\text{assetDecimals}}}
\]

**关键防分叉说明（必须落到注释/接口）**：

- `price` 固定为 **USD-8**（例如 $1.00 = `100000000`）。
- `assetDecimals` 必须是**资产自身 decimals**（用于把 token base units 归一为 “1 token”）。
- 当前 `IPriceOracleRead.getPrice(asset)` 第三个返回值在实现/调用方中被用作 `assetDecimals`（用于上述除数），**不是** “price 的精度”。（price 精度固定为 USD-8）

#### 4.4.2 系统性校验清单（Value 口径统一：接口注释 / 文档 / 写入来源 / 前端解码）

> 目标：把“value=USD-8”的口径从隐含推导变成显式 SSOT，避免新贡献者按“settlement token units / price decimals=8”等误解导致口径分叉。

**A. 接口注释/命名（必须修正为 USD-8）**

- `src/interfaces/IPriceOracle.sol`
  - **要求**：明确 `price` 为 USD-8；`decimals` 为 `assetDecimals`（用于换算），不是 price 精度。
- `src/interfaces/IPriceOracleAdapter.sol`
  - **要求**：同上。
- `src/interfaces/IPositionViewValuation.sol`
  - **要求**：把 “settlement token units” 全部改为 **USD-8 value**。
- `src/Vault/view/modules/PositionView.sol`
  - **要求**：`getUserTotalCollateralValue/getTotalCollateralValue/getAssetValue` 的 NatSpec 返回值单位统一写为 **USD-8 value**；
    并在注释中点明其换算使用 `valueUSD8 = amount * price / 10**assetDecimals`。

**B. 文档 SSOT（必须只保留一个口径）**

- `docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`
  - **要求**：明确 Value Unit SSOT=USD-8，并固化换算公式（见本节 4.4.1）。
- `docs/CollateralValuation-Migration-Plan.md`
  - **要求**：将“settlement token units”等表述统一为 **USD-8**，并指向 Value Unit SSOT（避免多处重复口径）。

**C. StatisticsPushManager 的读数来源（必须从 amount 改为 USD-8 value）**

> 目标：Stats snapshot 必须 push USD-8 value（与 `StatisticsView` 注释、HF/LTV 数学前提一致）。  
> **已落地（2026-01-30）**：StatsPushManager 已改为读取估值 SSOT（USD-8），不再对多资产 token amount 做数学上无意义的累加。

- `src/Vault/modules/StatisticsPushManager.sol`
  - **已实现**：
    - `collateralValueUSD8`：通过 `KEY_POSITION_VIEW → IPositionViewValuation.getUserTotalCollateralValue(user)` 读取（USD-8）。
    - `debtValueUSD8`：通过 `KEY_LE → ILendingEngineBasic.getUserTotalDebtValue(user)` 读取（USD-8）。
    - `push`：仍沿用 `StatisticsView.pushUserStatsSnapshot` 的 “global - old + new” 聚合逻辑（输入为 USD-8 snapshot）。
  - **权限/部署注意（必须）**：
  - `StatisticsPushManager` 需要具备 `ActionKeys.ACTION_VIEW_PRICE_DATA`，否则会在读取 `PositionView` 估值时触发 `MissingRole()` 并走 `CacheUpdateFailedWithContext`（best-effort）。
    - 本仓库已在部署脚本中补齐该授权（`scripts/deploy/deploylocal.blockNumber` / `scripts/deploy/deploy-arbitrum*.blockNumber`）。

**E. 落地状态与变更摘要（本节对应）**

- **已落地（✅）**：Value Unit SSOT（USD-8）+ StatsPushManager 推送 USD-8 snapshot
  - **核心改动**：`StatisticsPushManager` 从 “amount 累加” 改为 “USD-8 估值 SSOT”（PositionView + LendingEngine）。
  - **写入口收敛（Scheme B / Strict B+）**：`StatisticsView.push*` 写入口仅允许 `StatisticsPushManager` 或 `ACTION_ADMIN`（避免旁路写导致口径漂移）。
  - **部署/权限**：给 `StatisticsPushManager` 授权 `ACTION_VIEW_PRICE_DATA`；重试服务地址授权 `ACTION_VIEW_PUSH`。
  - **测试/验收**：
    - 单测：`test/StatisticsPushManager.usd8.snapshot.test.blockNumber`（USD-8 snapshot 推送 + 写入口权限）
    - e2e：`scripts/e2e/e2e-localhost-statisticsview-acceptance.blockNumber`（retry 路径 + 版本/seq 断言）

**D. 前端/索引解码与展示（必须标注 USD-8）**

- `DataPushed(DATA_TYPE_USER_STATS_UPDATE, payload)`：
  - **要求**：`UserSnapshot.collateral/debt` 与 `GlobalSnapshot.totalCollateral/totalDebt` 统一解释为 **USD-8 value**。
  - **展示**：UI 将其作为 “USD 值（8 decimals）” 展示；不要当作 token amount，也不要当作 settlement token base units。
- 建议在前端 schema map/decoder 文档中注明：`USER_STATS_UPDATE` 的 value 字段单位为 USD-8（避免解析端二次口径分叉）。

**验证（MUST，可验收）**
- **返回字段**：系统级/用户级统计读取必须包含 `blockNumber/lastUpdateTime`（或等效字段），并可用于判断新鲜度。
- **事件**：成功写入统计快照后应出现 `DataPushed`（类型按实现集中常量口径）。
- **脚本断言**：
  - 写入后读取聚合值变化正确，`lastUpdateTime` 单调推进；
  - 并发版本规则与 PositionView 同类断言（错误版本 revert、重放幂等如启用 requestId）。

> 实施清单（严格 B+：Snapshot + 单入口编排器 + retry）：  
> [`docs/Usage-Guide/StatisticsView-Strict-B-Push-Pipeline-Implementation-Checklist.md`](../../../docs/Usage-Guide/StatisticsView-Strict-B-Push-Pipeline-Implementation-Checklist.md)

### 4.5 `ViewCache`（✅ 已确认）
- **脚本**：`scripts/tests/viewcache-smoke-local.ts`
- **MUST**：仅系统级快照缓存；读返回 `isValid/blockNumber`。
- **MUST**：写入口权限为系统级推送/管理员（按统一口径）。
- **MUST**：DataPush 遵循“集中常量口径”（推荐 `DataPushTypes`；迁移期允许合约内 keccak 常量，但必须全局无重复/无冲突）。

**验证（MUST，可验收）**
- **返回字段**：系统快照读取必须包含 `isValid/blockNumber`（或等效 staleness 表达）。
- **权限**：写入口必须被 gate（系统级推送权限/管理员）；无权限写入必须 revert。
- **事件**：成功写入后应出现 `DataPushed`（可被链下消费/索引）。
- **脚本断言**：
  - 无权限账号调用写入口 revert；
  - 有权限写入后 `isValid=true` 且 blockNumber 更新。

### 4.6 `AccessControlView`（✅ 已确认）
- **脚本**：`scripts/e2e/e2e-localhost-accesscontrolview-acceptance.ts`
- **MUST**：只缓存权限位/权限级别；对外读取统一返回 `isValid/blockNumber`（B 类缓存）。
- **MUST**：DataPush type 遵循“集中常量口径”（推荐 `DataPushTypes`；迁移期允许合约内 keccak 常量，但必须全局无重复/无冲突）。

**验证（MUST，可验收）**
- **返回字段**：权限读取必须包含缓存有效性信息（`isValid/blockNumber` 或等效）。
- **事件**：权限更新 push 后必须出现 `DataPushed`（权限位/权限级别各自的 type）。
- **脚本断言**：
  - push 后立即可读，且 `isValid` 正确；
  - 过期后 `isValid` 变为 false（按缓存窗口/实现逻辑）。

### 4.7 `UserView`（重点）（✅ 已确认）
- **脚本**：`scripts/e2e/e2e-localhost-userview-acceptance.ts`
- **MUST**：纯 façade：把仓位、健康、风险、奖励、统计等委托到专属 View。
- **MUST**：不得存在“asset=0 代表总量”的占位实现；总量/估值必须调用权威接口或返回明确的“不可用 + 原因”。
- **MUST**：对外接口要透传下游的 `isValid/blockNumber`，避免丢失缓存有效性信息。

**验证（MUST，可验收）**
- **返回字段**：聚合输出必须同时包含业务数据与其有效性信息（至少 `isValid/blockNumber`，并发敏感场景含 `version`）。
- **职责边界**：不得在 `UserView` 内新增任何业务缓存写入与 push\* 写入口。
- **脚本断言**：
  - 通过 `UserView` 获取的聚合结果与下游专属 View 读取结果一致（数值一致、有效性信息一致或可解释地组合一致）。

### 4.8 `ValuationOracleView`（重点：权限一致性）（✅ 已确认：统一 ACTION_VIEW_PRICE_DATA gate）
- **脚本**：`scripts/e2e/e2e-localhost-valuationoracleview-acceptance.ts`
- **MUST**：价格读取权限必须与 `BatchView` 等模块对齐（统一 `ACTION_VIEW_PRICE_DATA` 或架构指南明确的 price 权限）。
- **MUST**：批量价格接口限制 `MAX_BATCH_SIZE`，并在失败时 best-effort 返回默认值（按现状可保留）。
- **MUST（Architecture-Guide SSOT）**：oracle 健康检查（`checkPriceOracleHealth/batchCheckPriceOracleHealth`）必须通过
  `GracefulDegradation.checkPriceOracleHealth(...)` 实现；不得对 oracle 合约增加/依赖额外 health 方法。
- **SHOULD**：对 UI/运维暴露的健康检查 details 使用稳定、可断言的原因字符串（例如 `Zero address` / `Asset not supported` / `oracle call failed`），避免把低级 revert 解码字符串作为对外语义。

**验证（MUST，可验收）**
- **权限**：无 `ACTION_VIEW_PRICE_DATA` 的调用者读取价格必须 revert（若该模块按 gate 策略实现）；同类价格读取在其它 View 中不得出现不同 ActionKey。
- **批量限制**：超限必须按统一错误口径失败；失败路径 best-effort 行为必须可被脚本覆盖（按现状定义）。
- **脚本断言**：
  - 同一资产价格在 `ValuationOracleView` 与批量聚合入口（如 `BatchView`）的权限 gate 与返回语义一致。

### 4.9 `FeeRouterView`（✅ 已确认：writer=FeeRouter 单点推送 + DataPushTypes）
- **脚本**：`scripts/e2e/e2e-localhost-feerouterview-acceptance.ts`
- **MUST**：push 入口只允许 FeeRouter（Registry SSOT）。
- **MUST**：读接口提供 staleness/有效性信息（至少基于 `_lastSyncBlockNumber` + `SYNC_INTERVAL` 给出 `isValid/needsSync` 或 blockNumber）。
- **MUST**：DataPush type 遵循“集中常量口径”（推荐 `DataPushTypes`；迁移期允许合约内 keccak 常量，但必须全局无重复/无冲突）。

**验证（MUST，可验收）**
- **权限**：非 FeeRouter 地址调用 push 必须 revert；FeeRouter 调用成功后可读快照更新。
- **返回字段**：读取必须包含 staleness/有效性表达（`blockNumber/isValid/needsSync` 等，按实现为准）。
- **事件**：成功 push 后应出现 `DataPushed`。
- **脚本断言**：
  - 用非 FeeRouter 地址 push revert；
  - push 后读取到的新 blockNumber 与 staleness 逻辑一致。

### 4.10 `LiquidatorView`（✅ 已确认：Registry=KEY_LIQUIDATION_VIEW + DataPushTypes）
- **脚本**：`scripts/e2e/e2e-localhost-liquidatorview-acceptance.ts`
- **MUST**：只读 + DataPush 单点推送（清算事件/赔付/榜单等以链下聚合为主）。
- **MUST**：权限口径（清算数据 vs 风险数据 vs 用户私域）统一，不得混用。

**验证（MUST，可验收）**
- **单点推送**：清算相关 DataPush 必须由单一权威入口发起（按架构指南：由 `LiquidatorView.push*` 单点触发），避免多点重复发事件。
- **返回字段**：若存在链下权威聚合输出，应提供 staleness/版本信息以识别新鲜度。
- **脚本断言**：
  - 通过清算写路径触发后，观察到 `LiquidatorView.push*` 的 DataPush 事件；
  - 不同清算/风控输出的读权限与 ActionKey 使用一致（不得混用 system/price/user/risk）。

### 4.11 `BatchView` / `CacheOptimizedView` / `DashboardView`（✅ 已确认：门面/聚合层不新增 push 入口）
- **脚本**：`scripts/e2e/e2e-localhost-batch-advanced-10-users.ts`
- **MUST**：只做聚合/批量转发，不引入缓存写入。
- **MUST**：统一 batch 限制与错误类型；权限口径与各专属 view 一致。

**验证（MUST，可验收）**
- **职责边界**：不得存在任何 push\* 写入口与状态写入（代码审阅 + 静态检查）。
- **批量限制**：所有批量入口必须校验 `MAX_BATCH_SIZE`；超限失败口径在全仓一致。
- **权限一致性**：聚合/批量入口不得绕过下游权限；同类数据读取使用同一 ActionKey。
- **脚本断言**：
  - 批量长度超限时一致失败；
  - 对同一数据，批量入口与专属 View 的返回与权限行为一致。

### 4.12 `LendingEngineView`（✅ 已确认）
- **脚本**：`scripts/tests/lendingengine-smoke-local.ts`
- **MUST**：只读；不得存在任何 push\* 写入口与业务状态写入（除 UUPS/initializer）。
- **MUST**：订单/用户私域查询必须遵循“用户私域权限口径”（不允许把订单细节/失败费用/重试次数等暴露给任意 caller）。
- **MUST**：运维/系统级诊断查询必须遵循系统权限口径（如 `ACTION_VIEW_SYSTEM_DATA` 或 admin）。
- **MUST**：失败口径统一：无权限访问必须 `revert MissingRole()`（避免 revert string/自定义 Unauthorized 分叉）。

**验证（MUST，可验收）**
- **职责边界**：ABI 中不存在 `push*`；除 `initialize/upgradeTo*` 外无非 `view/pure` 外部函数。
- **权限**：
  - `getLoanOrder(orderId)`：仅订单相关方（borrower/lender）可读；或 ops/admin（具备 `VIEW_USER_DATA` 或 admin）可读；否则 `MissingRole()`
  - `LoanNFTView.getUserLoanCount(user)` / `LendingEngineView.canAccessLoanOrder(orderId,user)`：仅 `user` 本人或 ops/admin 可读，否则 `MissingRole()`
  - `getFailedFeeAmount(orderId)` / `getNftRetryCount(orderId)` / `isMatchEngine(account)` / `getRegistryFromEngine()`：仅 ops/admin 可读，否则 `MissingRole()`
- **脚本断言**：
  - 用 `unauthorized` 调用上述接口全部 revert 且 selector 为 `MissingRole()`
  - `borrower` 能读取自身订单；`outsider` 不能读取（除非授予 ops 角色）

### 4.13 `PreviewView`（✅ 已确认）
- **脚本**：`scripts/e2e/e2e-localhost-previewview-acceptance.ts`
- **MUST**：只读预览门面；不得存在任何 push\* 写入口与业务状态写入。
- **MUST**：用户私域口径：仅允许 `user` 本人或具备 `ACTION_VIEW_USER_DATA`/admin 的 caller 调用预览（失败必须 `MissingRole()`）。
- **MUST**：不得绕过下游专属 View 的权限策略：当 `PositionView` 对仓位读取施加 `VIEW_USER_DATA` gate 时，`PreviewView` 的实现必须保证：
  - 外部 caller 的权限校验发生在 PreviewView 入口（按上条）
  - 模块间调用不会被误拦（部署脚本需为 `PreviewView` 合约地址授予 `VIEW_USER_DATA`，仅用于内部调用；外部 caller 仍需通过入口校验）

**验证（MUST，可验收）**
- **权限**：
  - `unauthorized` 调用 `previewDeposit/previewWithdraw/previewBorrow/previewRepay`（目标 user 不是自己）必须 `MissingRole()`
  - `user` 本人调用同接口必须成功
- **输入校验**：asset=0 等非法输入必须按实现 revert（如 `PreviewView__InvalidInput()`）
- **脚本断言**：
  - `unauthorized` 调用 preview 系列接口 selector 为 `MissingRole()`
  - `user` 自己调用成功，返回值格式稳定（hfAfter/newHF/newLTV 等）

### 4.14 `RewardView`（✅ 已确认）
- **脚本**：`scripts/e2e/e2e-localhost-reward-edgecases.ts`
- **MUST**：作为 Reward 系统对外的只读聚合与缓存加速层，外部消费者（前端/索引/机器人）应仅依赖 `RewardView` 的只读接口，不应直接调用 `RewardManagerCore` 的查询接口（除“协议内硬约束校验”入口外）。
- **MUST**：写入口（`push*`）必须严格白名单（writer allowlist），仅允许架构指南指定的写入方调用（当前口径：`RewardManagerCore` / `RewardAccrualManager` / `EasyConsumption` / `EasyRecycleDistributor` / `EasyEmissionController` / `EasyEmissionConfig` / `EasyStaking`）。
- **MUST**：所有写入口必须触发统一 DataPush：`DataPushLibrary._emitData(...)`，`dataTypeHash` 使用集中常量口径（推荐 `DataPushTypes`）。
- **MUST**：作为 B 类缓存模块，对外读取必须返回缓存有效性信息：至少 `isValid` + `blockNumber`（并发敏感时附带 `version`）。不得仅返回业务字段而缺失有效性元信息（Facade 也不得丢失）。
- **MUST**：对外权限策略必须遵循“用户私域口径”：用户本人可读；非本人读需具备 `ACTION_VIEW_USER_DATA` 或 admin，失败必须 `MissingRole()`（不得 revert string / 自定义 Unauthorized 分叉）。
- **MUST**：分区注释与 NatSpec 需对齐架构指南模板（`@dev Reverts if:` / `Security:` / 单位说明），并采用统一分区分隔符（禁止 `/* ============ */` / `// ============` 风格）。

**验证（MUST，可验收）**
- **写入口权限**：
  - 非 writer（例如既不是 `RewardManagerCore`/`RewardAccrualManager`，也不是 `EasyConsumption/EasyRecycleDistributor` 等白名单模块）调用任意 `push*` 必须 revert（推荐 `RewardView__UnauthorizedWriter()` 或等效）。
- **DataPush 可观测性**：
  - 任意一次成功 `pushEasyMinted/pushEasyBurned/pushPenaltyLedger/pushUserLevel/pushEarnState/pushSystemStats`，必须能观察到对应的 `DataPushed` 事件，且 `dataTypeHash` 与架构指南/常量表一致。
- **B 类缓存有效性输出**：
  - `getUserRewardSummary`（或等效对外主查询）返回值必须包含 `isValid/blockNumber`（至少可判断新鲜度/是否需要链下重试），并在脚本中可被断言。
- **读权限**：
  - `unauthorized` 查询非本人 `RewardView` 私域数据必须 `MissingRole()`；
  - `user` 查询自身数据必须成功。

### 4.15 `ModuleHealthView`（✅ 已确认）
- **脚本**：`scripts/e2e/e2e-localhost-modulehealthview-acceptance.ts`
- **MUST**：定位为“运维/监控扩展 View”，只做轻量检查 + 缓存 + 推送，不得承担账本写入或业务缓存权威写入。
- **MUST**：对外权限口径属于系统状态/运维数据：读取与触发检查必须使用 `ACTION_VIEW_SYSTEM_STATUS`（或 admin），失败必须 `MissingRole()`。
- **MUST（SSOT 对齐：Architecture-Guide + 本文件测试矩阵）**：模块健康结果的统一 DataPush **由 `HealthView.pushModuleHealth` 单点发出**
  （`DataPushTypes.DATA_TYPE_MODULE_HEALTH`），以避免链下重复消费同一语义的 DataPush。
  - **MUST NOT**：`ModuleHealthView` 不得 emit `DataPushTypes.DATA_TYPE_MODULE_HEALTH`（否则会出现“双发同类型但语义相同”的重复消费风险）。
  - **SHOULD**：`ModuleHealthView` 至少 emit `ModuleHealthChecked`（或等效事件）用于可观测性；如确需 DataPush，可新增一个**不同语义/不同 type** 的 `MODULE_HEALTH_CHECKED` 类 type（避免与结果型 DataPush 冲突）。
- **MUST**：作为缓存模块（B 类缓存/运维缓存），对外读取必须返回缓存有效性信息：至少 `isValid` + `blockNumber`（并明确有效期口径，例如 TTL/窗口），不得仅返回“最后检查时间”而缺失有效性判断。
- **MUST**：批量接口（若存在/将来新增）必须遵循 `ViewConstants.MAX_BATCH_SIZE` 并采用统一错误口径。
- **MUST**：分区注释与 NatSpec 需对齐架构指南模板，并采用统一分区分隔符（禁止 `/* ============ */` / `// ============` 风格）。

**验证（MUST，可验收）**
- **权限**：
  - `unauthorized` 调用 `checkAndPushModuleHealth` / `getModuleHealthStatus` / `checkModuleHealth`（按实现）必须 `MissingRole()`；
  - `operator`（具备 `ACTION_VIEW_SYSTEM_STATUS`）调用必须成功。
- **DataPush 可观测性**：
  - 成功执行一次检查/推送后，必须能观察到：
    - `ModuleHealthChecked`（或等效事件）；以及
    - 由 **`HealthView`** 发出的 `DataPushed(DataPushTypes.DATA_TYPE_MODULE_HEALTH, payload)`（结果型单点 DataPush）。
- **缓存有效性**：
  - 读取模块健康缓存必须返回 `blockNumber` 与 `isValid`（或等效 staleness 表达），并可在脚本中断言其随推送单调更新。

### 4.16 `EventHistoryManager`（✅ 已确认）
- **脚本**：`scripts/e2e/e2e-localhost-eventhistorymanager-acceptance.ts`
- **MUST**：定位为“轻量桩件”：不持久化链上存储，仅发事件供链下索引消费；不得引入链上历史存储或复杂查询。
- **MUST**：写入口必须受控（建议使用 `ACTION_MANAGE_EVENT_HISTORY` 或等效 actionKey），失败必须按统一口径处理（避免 revert string）。
- **MUST**：写入口必须触发统一 DataPush：`DataPushLibrary._emitData(...)`，`dataTypeHash` 使用集中常量口径（推荐 `DataPushTypes`）。
- **MUST**：UUPS + `__gap` + 统一版本信息（`getVersionInfo()` 语义由 `ViewVersioned` 提供）必须保留，便于链下定位实现与 schema 变更。
- **MUST**：分区注释与 NatSpec 需对齐架构指南模板，并采用统一分区分隔符（禁止 `/* ============ */` / `// ============` 风格）。

**验证（MUST，可验收）**
- **职责边界**：
  - 合约不应新增任何历史持久化存储；除 `initialize/upgrade` 外，不应包含会写入持久状态的业务逻辑（仅发事件 + DataPush）。
- **权限**：
  - 非授权模块调用 `recordEvent` 必须 revert（按实现 actionKey gate）。
- **可观测性**：
  - 成功调用 `recordEvent` 后，必须同时观察到 `HistoryRecorded` 与 `DataPushed`，且 `DataPushed` 的 payload 能 ABI 解码回 `eventType/user/asset/amount/extraData`（按实现口径）。

---

## 5. 完工验收（Definition of Done）
- View 模块清单与文档完全一致（名称、职责、部署建议）。
- 权限口径一致：同类数据在所有 View 的 actionKey 使用一致。
- 所有 B 类缓存都暴露 `isValid/blockNumber`（Facade 不丢信息）。
- 统一 DataPush：所有 push\* 写路径调用 `DataPushLibrary._emitData(...)`，且 `dataTypeHash` 遵循“集中常量口径”（推荐 `DataPushTypes`；迁移期允许合约内 keccak 常量但必须全局无重复/无冲突）。
- 关键缓存具备并发/幂等（至少 Position/Stats 级别）。
- SystemView 从“硬失败提示”转为“路由/引导”方式（可被前端/SDK 直接消费）。
- 批量错误口径统一：所有批量入口超限必须 `revert BatchTooLarge(length,max)`；空数组必须 `revert EmptyArray()`（全仓一致）。
- 无权限失败口径统一：对外的权限校验失败应统一 `revert MissingRole()`（避免 revert string/各模块自定义 Unauthorized 分叉）。
- 本临时文档删除：`docs/Usage-Guide/ARCH-VIEW-ALIGNMENT-WORKGUIDE.md`。

### 5.1 测试与验收（本地链模拟，参考 `scripts/tests` 与 `scripts/e2e`）
目标：在**本地链**上用“真实交易 + 推送/事件/批量查询”把 View 系统的关键承诺全部跑通，确保改造不是“代码看起来对齐”，而是行为对齐。

#### 5.1.1 通用前置条件（Checklist）
- **环境（MUST）**
  - 本地开发链已部署最新合约（以仓库现有脚本为准），Registry/模块键已正确注册到目标 View 合约地址。
  - 准备至少 3 类测试账户：`admin`（具备管理员/升级/推送能力）、`operator`（具备必要的 push 权限或被授权模块身份）、`user`（普通用户）；另备 `unauthorized`（无任何权限）。
  - 能从交易回执中抓取事件并断言：
    - `DataPushed`（由 `DataPushLibrary._emitData(...)` 发出）
  - 失败事件（`CacheUpdateFailed` / `CacheUpdateFailedWithContext` / `HealthPushFailed` 或等效事件）
- **常量（MUST）**
  - 批量接口统一以 `ViewConstants.MAX_BATCH_SIZE` 作为上限（超限行为口径一致）。

#### 5.1.2 测试用例矩阵（与 §4.x 一一对应）
说明：本矩阵用于 `scripts/tests/*` 的冒烟/断言层；每个用例都必须能在本地链复现并自动断言。
> 状态：⚠️ 易漂移（当接口/权限/路由发生变更时，必须同步更新本矩阵；以仓库现有 `scripts/e2e/*-acceptance.blockNumber` 的可运行结果为准）

##### 4.1 `SystemView`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-systemview-routing.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| SV-01 路由/发现性（route\*，SSOT=Registry） | Registry 已注册各 View 模块；caller 具备 `ACTION_VIEW_SYSTEM_DATA`（即 `keccak256("VIEW_SYSTEM_DATA")`）（✅ 已确认） | 调用 `routeStatistics/routeReward/routeLiquidation/routeRisk/routeUser/routePosition/routeBatch/routeDashboard/routePreview` 以及 `routePrice()` | 无 `DataPushed` | `RouteInfo(moduleKey,moduleAddr)`；`routePrice` 返回 `RouteHint(primaryRoute,fallbackRoute)` | `moduleKey == keccak256("...")` 且 `moduleAddr == Registry.getModuleOrRevert(moduleKey)`；地址非零；`getVersionInfo()` 可读用于定位实现 |
| SV-02 权限 gate（统一 MissingRole） | `unauthorized` 不具备 `ACTION_VIEW_SYSTEM_DATA`（即 `keccak256("VIEW_SYSTEM_DATA")`）（✅ 已确认） | `unauthorized` 调用任一 `route*()` / `getModuleOptional(bytes32)` | 无 | N/A | 必须 `revert MissingRole()`（断言 selector，不依赖 revert string） |
| SV-03 模块查询 API（getModule/getNamedModule） | 同 SV-01 | 调用 `getModule(bytes32)` / `getModuleOptional(bytes32)`；调用 `getNamedModule(string)` / `getNamedModuleOptional(string)` | 无 | 返回 module address | `getModuleOptional` 未注册返回 `0x0`；`getModule` 未注册 revert；`getNamedModule` 支持标准映射（`ModuleKeys.getModuleKeyFromString`）+ legacy `keccak256(name)` fallback |
| SV-04 Deprecated getters（允许 revert，但禁止作为集成路径） | 无 | 调用 `getAssetPrice/getTotalCollateral/getTotalDebt/getRewardSystemView/getGuaranteeSystemView` | 无 | N/A | 允许 revert（兼容债务）；但必须证明 route\* API 可用，且脚本/前端/SDK 不依赖 revert 文本做集成 |
| SV-05 无业务写入职责边界（静态合规） | 无 | 对 ABI/源代码做静态检查 | 无 | N/A | 除 `initialize/upgrade` 外不应存在非 `view/pure` 的 external/public；不得出现 `push*` 写入口 |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-systemview-routing.blockNumber --network localhost`
- 该脚本会先执行统一 `runViewPreflight(...)`（SystemView routes ↔ Registry 对齐 + VersionInfo 可观测），再覆盖本矩阵的 `MissingRole()` 断言与 route\* 对齐断言。

##### 4.2 `PositionView`（测试矩阵）
- **脚本**：`scripts/tests/phase3-positionview-acceptance.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| PV-01 读取快照与有效性（推荐 Meta API） | caller 具备 `VIEW_USER_DATA`；准备 `(user,asset)` | 调用 `getUserPositionWithMeta(user, asset)`（兼容：`getUserPositionWithValidity`） | 无（仅读） | `collateral/debt/isValid/blockNumber/version` | 字段齐全；`blockNumber` 为该 `(user,asset)` 最近一次写入缓存的区块号；`version` 可读 |
| PV-02 严格并发 nextVersion（CAS） | caller 是业务模块（`VaultRouter/CM/LE/...`）且具备 `ACTION_VIEW_PUSH`；可读 currentVersion | `v0 = getPositionVersion(user,asset)` → 调用 `pushUserPositionUpdate(user,asset,collateral,debt,requestId,seq,nextVersion=v0+1)` → 再读 meta | 必须 `DataPushed(DATA_TYPE_USER_POSITION_UPDATE, payload)` | 同 PV-01 | `version == v0+1`；payload 可 ABI 解码为 `(user,asset,collateral,debt)` 且与写入一致 |
| PV-03 错误版本必须失败 | 同 PV-02 | 使用错误 `nextVersion`（例如 `nextVersion=currentVersion` 且 `requestId` 不同）调用 push | 无成功 `DataPushed` | N/A | 必须 `revert PositionView__StaleVersion(uint64,uint64)`（脚本断言 selector，不依赖 revert string）；不得静默覆盖 |
| PV-04 幂等重放 requestId（version-bound, O(1)） | 同 PV-02 | 成功 push 后，重放同一笔：`requestId` 不变，`nextVersion==currentVersion`，payload 相同（`seq` 可任意） | 必须 emit `IdempotentRequestIgnored`；不得 emit `DataPushed` | 同 PV-01 | `version` 不变；数据不变；无重复写入副作用 |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-positionview-acceptance.blockNumber --network localhost`
- 覆盖：`MissingRole()` 读 gate、`nextVersion` 并发、`requestId` 幂等、`seq` 顺序、`DataPushed(DATA_TYPE_USER_POSITION_UPDATE)` payload 解码、以及 `(user,asset)` 有效性独立性（TTL=5m）。

##### 4.3 `HealthView`（测试矩阵）
- **脚本**：`scripts/tests/view-schemeu-smoke-local.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| HV-01 只读查询（Scheme U + meta 输出） | `user` 与 `outsider`；另备 `ops/admin`（具备 `VIEW_USER_DATA` 或 `ADMIN`） | `getUserHealthFactorWithMeta(user)` / `isUserLiquidatableWithMeta(user)` / `batchGetHealthFactorsWithMeta(users)` | 无（仅读） | `(healthFactor,isValid,blockNumber)`；batch 返回数组 | self read 必须成功；non-self outsider 必须 `revert MissingRole()`；ops/admin 代查必须成功；batch(users[]) 无 self-bypass（caller 必须 ops/admin） |
| HV-02 push 更新后可读（writer=ACTION_VIEW_PUSH） | `VaultRouter`（或 keeper）具备 `ACTION_VIEW_PUSH`；读取方为 `user` 本人或 ops/admin | `pushRiskStatus(user,hf,minHF,flag,blockNumber)`（或 batch）→ 再读 | 必须 `DataPushed(DATA_TYPE_RISK_STATUS, payload)` | 同 HV-01 | push 后 `healthFactor` 更新、`blockNumber` 单调（blockNumber=0 时归一为 block.number）；payload 可 ABI 解码为 `(user,hf,minHF,flag,blockNumber)` |
| HV-03 批量边界（统一错误口径） | 有 users 数组 | 调用 `batchGetHealthFactorsWithMeta(users)`：空数组 / 长度 `MAX_BATCH_SIZE+1` | 无 | N/A | 空数组必须 `revert EmptyArray()`；超限必须 `revert BatchTooLarge(len,max)`（脚本断言 selector，不依赖 revert string） |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-healthview-acceptance.blockNumber --network localhost`
- 覆盖：读侧 `MissingRole()` gate、push 写入 `MissingRole()` gate、`DataPushed(DATA_TYPE_RISK_STATUS/_BATCH)` payload 解码、`EmptyArray/BatchTooLarge` 统一错误口径、TTL 过期行为（CACHE_DURATION=5m）。

##### 4.4 `StatisticsView`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-statisticsview-acceptance.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| ST-01 系统聚合只读（含 meta） | 无 | `getGlobalStatisticsWithMeta()` | 无（仅读） | `GlobalStatistics{totalUsers,activeUsers,totalCollateral,totalDebt,lastUpdateTime}` + `(isValid,blockNumber)` | 字段齐全；`lastUpdateTime == meta.blockNumber`；无需权限 gate |
| ST-02 推送后单调推进（user stats；Strict B+ 推荐路径） | caller 具备 `ACTION_VIEW_PUSH`（调用编排器 retry）；Registry 已绑定 `KEY_STATS_PUSH_MANAGER`；且 `StatisticsPushManager` 已被授予 `ACTION_VIEW_PRICE_DATA` | 调用 `StatisticsPushManager.retryUserStats(user)` → 再读 `getGlobalStatisticsWithMeta()` | 必须 `DataPushed(DATA_TYPE_USER_STATS_UPDATE, payload)`（由 `StatisticsView` 发出） | 同 ST-01 | `lastUpdateTime` 单调；payload 可 ABI 解码并匹配 `(user,version,requestId,seq,UserSnapshot,GlobalSnapshot)`；并且 `collateral/debt` 口径为 USD-8 snapshot |
| ST-03 并发/幂等（nextVersion + requestId + seq） | caller 为 `ACTION_ADMIN` 或 StatsPushManager（Registry `KEY_STATS_PUSH_MANAGER`）（✅ 已确认） | 直接调用 `StatisticsView.pushUserStatsSnapshot(...)`：错误 `nextVersion`、同 `requestId` 重放、乱序 `seq` | `IdempotentRequestIgnored`（重放） | 同 ST-01 | 错误版本必须 `revert StatisticsView__StaleUserStatsVersion(uint64,uint64)`；重放不得 emit `DataPushed` 且版本不变；乱序必须 `revert StatisticsView__OutOfOrderSeq(uint64,uint64)` |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-statisticsview-acceptance.blockNumber --network localhost`
- 覆盖：ST-01~ST-03（含 `DataPushed(DATA_TYPE_USER_STATS_UPDATE)` 解码、`nextVersion` 并发、`requestId` 幂等、`seq` 顺序）。

##### 4.5 `ViewCache`（测试矩阵）
- **脚本**：`scripts/tests/viewcache-smoke-local.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| VC-01 职责边界（系统级缓存，写入口明确） | 无 | 仅做静态检查：ABI 中不得出现 `push*`；写入口仅允许 `setSystemStatus/clearSystemCache`（按实现命名） | N/A | N/A | 不得存在额外写入口；读接口不得触发 `DataPushed`；仅写入口会 `DataPushed` |
| VC-02 初始化与 Registry 合法性 | 无 | `initialize(0)`；`initialize(EOA)`；未初始化时调用写入口 | 无 | N/A | 必须 `ZeroAddress/NotAContract`（按实现）；未初始化写入口必须失败（`onlyValidRegistry` 生效） |
| VC-03 写权限 gate | `unauthorized` 无权限；`admin` 具备 `ACTION_ADMIN`；`operator` 具备 `ACTION_VIEW_SYSTEM_DATA` | `unauthorized` 调用 `setSystemStatus/clearSystemCache`；`operator` 调用 `setSystemStatus`；`admin` 调用 `clearSystemCache` | 写成功时 `CacheUpdated` + `DataPushed`；失败无成功事件 | N/A | `unauthorized` 必须 `MissingRole()`；`operator/admin` 分别成功；权限口径不得分叉 |
| VC-04 输入与 batch 边界 | 无 | `setSystemStatus(asset=0,...)`；`batchGetSystemStatus([])`；`batchGetSystemStatus(len>MAX_BATCH_SIZE)` | 无 | N/A | 必须按统一错误口径失败（如 `ViewCache__InvalidCacheData` / `EmptyArray` / `BatchTooLarge`） |
| VC-05 TTL/staleness 语义 | `operator` 有写权限 | 写入 → 立即读；推进时间跨过 `CACHE_DURATION` 再读；clear 后再读 | 写入/clear 时 `CacheUpdated` + `DataPushed` | `SystemStatusCache{...blockNumber,isValid}` + `isValid` | 写入后 `isValid=true`；过期后 `isValid=false`（即使 struct.isValid=true）；clear 后 `isValid=false` 且缓存字段清空 |
| VC-06 DataPushed schema/可解码性 | `operator/admin` 有权限 | `setSystemStatus` 与 `clearSystemCache` 各成功一次，抓取 `DataPushed` | 必须 `DataPushed(DATA_TYPE_SYSTEM_STATUS, payload)` | N/A（事件 payload 可解码） | `dataTypeHash == DataPushTypes.DATA_TYPE_SYSTEM_STATUS`；payload 可 ABI 解码为 `(asset,totalCollateral,totalDebt,utilizationRate,blockNumber)` 且与写入一致；`blockNumber` 与写入块时间一致（单调推进） |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-viewcache-acceptance.blockNumber --network localhost`
- 覆盖：VC-01~VC-06（写权限 gate、TTL/validity、`DataPushed(DATA_TYPE_SYSTEM_STATUS)` payload 可解码）。

##### 4.6 `AccessControlView`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-accesscontrolview-acceptance.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| ACV-01 push 后立即可读 | 有权限更新来源 | push 权限位/等级（按实现）→ 读取 | `DataPushed` | 权限值 + `isValid/blockNumber`（或等效） | push 后读到新值；`isValid` 正确 |
| ACV-02 过期行为（如有） | 缓存有过期窗口 | 推进时间跨过 `CACHE_DURATION`（按测试工具能力）→ 读取 | 无（仅读） | 同 ACV-01 | 过期后 `isValid=false`（或等效 staleness） |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-accesscontrolview-acceptance.blockNumber --network localhost`
- 覆盖：ACV-01~ACV-02（push→读一致性、validity/TTL 语义、失败口径不分叉）。

##### 4.7 `UserView`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-userview-acceptance.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| UV-01 façade 不丢有效性 | 下游 View 已有数据 | 调用 `UserView` 聚合读取接口（按实现） | 无（仅读） | 业务数据 + 下游 `isValid/blockNumber/(version)` 的透传/组合 | `UserView` 输出与下游一致或可解释地组合一致；有效性信息不丢 |
| UV-02 无业务写入 | 无 | 扫描/调用 `UserView` 入口（按实现） | 无 `DataPushed` | N/A | `UserView` 不存在 push\* 写入口/状态写入（代码审阅 + 静态检查） |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-userview-acceptance.blockNumber --network localhost`
- 覆盖：UV-01~UV-02（聚合一致性 + meta 透传、职责边界、Scheme U 读口径）。

##### 4.8 `ValuationOracleView`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-valuationoracleview-acceptance.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| VOV-01 价格读权限一致性 | `unauthorized` 无 price 权限（若该模块 gate） | `unauthorized` 调用价格读取接口（按实现） | 无 | N/A | 必须 revert（与 `BatchView` 等同类入口一致） |
| VOV-02 批量上限 | assets 数组 | 调用批量价格接口，长度 > `MAX_BATCH_SIZE` | 无 | N/A | 必须按统一口径失败 |
| VOV-03 best-effort 行为（如实现） | 预言机可模拟失败 | 触发失败路径（按现状可保留） | 可能有事件（按实现） | 允许默认值/降级输出（按实现） | 行为与实现约定一致且可脚本断言 |
| VOV-04 健康检查（SSOT=GracefulDegradation） | `PriceOracle` 已配置资产与价格；或模拟失败/未配置 | 调用 `checkPriceOracleHealth/batchCheckPriceOracleHealth` | 无（仅读） | `(healthy, details, blockNumber)` / batch arrays | 健康时返回 `Healthy`；未配置返回 `Asset not supported`；oracle 失败返回 `oracle call failed`；且不要求 oracle 合约实现 bespoke health 方法 |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-valuationoracleview-acceptance.blockNumber --network localhost`
- 覆盖：VOV-01~VOV-03（与 BatchView 权限一致性、batch 边界、best-effort 语义）。

##### 4.9 `FeeRouterView`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-feerouterview-acceptance.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| FRV-01 push 权限（仅 FeeRouter） | `unauthorized` 非 FeeRouter | `unauthorized` 调用 push 入口 | 无 | N/A | 必须 revert |
| FRV-02 staleness 输出 | FeeRouter 可 push | FeeRouter push → 读取 | `DataPushed` | `blockNumber/isValid/needsSync`（按实现） | staleness 逻辑一致；blockNumber 单调推进 |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-feerouterview-acceptance.blockNumber --network localhost`
- 覆盖：FRV-01~FRV-02（only-writer push、staleness/validity、DataPushed payload 解码）。

##### 4.10 `LiquidatorView` / `SystemRiskView`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-liquidatorview-acceptance.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| LQ-01 单点 DataPush | 清算写路径可触发 | 触发清算流程（按仓库现有脚本/测试骨架） | 观察到由 `LiquidatorView.push*` 发出的 `DataPushed` | 输出如含聚合应带 staleness/版本（按实现） | DataPush 发起点唯一（不得多点重复发）；权限口径不混用 |
| SRV-01 system risk 读权限 gate（已启用） | `unauthorized` 无 `ACTION_VIEW_RISK_DATA`；另备 `operator` 具备 `ACTION_VIEW_RISK_DATA` | `unauthorized` 调用 `SystemRiskView` 的 system-only getter（如 `get*Threshold/getMinHealthFactor`） | 无（仅读） | N/A | `unauthorized` 必须 `revert MissingRole()`（断言 selector） |
| SRV-02 system risk 读权限（VIEW_RISK_DATA / ADMIN） | `operator` 具备 `ACTION_VIEW_RISK_DATA`；或 `admin` 具备 `ACTION_ADMIN` | `operator/admin` 调用上述 getter | 无（仅读） | 返回阈值/参数（按实现） | 调用必须成功（✅ 已确认） |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-liquidatorview-acceptance.blockNumber --network localhost`
- `pnpm -s hardhat run scripts/tests/view-schemeu-smoke-local.blockNumber --network localhost`
- 覆盖：LQ-01（单点 DataPush + writer gating）与 SRV-01~SRV-02（system risk gate + 成功读）。

##### 4.11 `BatchView` / `CacheOptimizedView` / `DashboardView`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-batch-advanced-10-users.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| BV-01 职责边界（无写入） | 无 | 调用聚合/批量读取接口（按实现） | 无 `DataPushed` | 聚合输出（按实现） | 不存在 push\* 写入口/状态写入（代码审阅 + 静态检查） |
| BV-02 批量上限一致 | 准备批量参数 | 调用任一批量入口，长度 > `MAX_BATCH_SIZE` | 无 | N/A | 必须按统一口径失败 |
| BV-03 权限一致性 | 有下游需 gate 的数据 | 用 `unauthorized` 调用批量入口读取该类数据 | 无 | N/A | 不得绕过下游 gate；行为与专属 View 一致 |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-batch-aggregators-acceptance.blockNumber --network localhost`
- 覆盖：BV-01~BV-03（无写入边界、batch 边界统一、权限不绕过下游）。

##### 4.12 `LendingEngineView`（测试矩阵）
- **脚本**：`scripts/tests/lendingengine-smoke-local.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| LEV-01 职责边界（只读、无 push\*） | 无 | 对 ABI/源代码做静态检查；并在运行时枚举外部函数 selector（按测试骨架能力） | 无 `DataPushed` | N/A | ABI 中不存在 `push*`；除 `initialize/upgradeTo*` 外不存在 non-view 外部函数；不得写入业务状态 |
| LEV-02 订单私域：相关方可读 | 存在可查询的 `orderId`，并已知 `borrower/lender/outsider` | `borrower` 调用 `getLoanOrder(orderId)`；`lender` 调用同接口 | 无 | `LoanOrder`（按实现） | `borrower` 与 `lender` 均成功；返回值与账本一致（如可对照 LendingEngine/LoanNFT 的只读口径） |
| LEV-03 订单私域：非相关方必须拒绝（MissingRole） | 同 LEV-02，`outsider` 无任何角色 | `outsider` 调用 `getLoanOrder(orderId)` | 无 | N/A | 必须 `revert MissingRole()`（断言 selector，不依赖 revert string） |
| LEV-04 用户统计私域：仅本人或 ops/admin | `user` 存在订单；准备 `unauthorized` 与 `ops`（具备 `VIEW_USER_DATA` 或 admin） | `user` 调用 `LoanNFTView.getUserLoanCount(user)`；`unauthorized` 调用 `LoanNFTView.getUserLoanCount(user)`；`ops` 调用 `LoanNFTView.getUserLoanCount(user)` | 无 | `count`（按实现） | `user/ops` 成功；`unauthorized` 必须 `MissingRole()`；同时 `LendingEngineView.canAccessLoanOrder(orderId,user)` 同样口径 |
| LEV-05 运维/诊断只允许 ops/admin | `orderId` 可用；准备 `ops/admin` 与 `unauthorized/outsider` | 调用 `getFailedFeeAmount(orderId)` / `getNftRetryCount(orderId)` / `isMatchEngine(account)` / `getRegistryFromEngine()` | 无 | N/A（或返回值按实现） | `ops/admin` 成功；其余 caller 必须 `MissingRole()`；不得出现 revert string / 自定义 Unauthorized 分叉 |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-lendingengineview-acceptance.blockNumber --network localhost`
- 覆盖：LEV-01~LEV-05（职责边界、相关方可读、ops/admin 运维只读、MissingRole 统一）。

##### 4.13 `PreviewView`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-previewview-acceptance.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| PRV-01 职责边界（只读、无 push\*） | 无 | 对 ABI/源代码做静态检查；对所有外部函数做 `eth_call` | 无 `DataPushed` | N/A | ABI 中不存在 `push*`；除 `initialize/upgradeTo*` 外无 non-view 外部函数；不得写入业务状态 |
| PRV-02 私域入口校验：非本人必须 MissingRole | `userA/userB` 两个普通用户；`unauthorized` 无角色 | 用 `unauthorized` 调用 `previewDeposit(userA,...)`、`previewWithdraw(userA,...)`、`previewBorrow(userA,...)`、`previewRepay(userA,...)`（目标 user≠caller） | 无 | N/A | 必须 `revert MissingRole()`（断言 selector），且在 PreviewView 入口发生（不得依赖下游 revert） |
| PRV-03 私域入口校验：本人允许 | `userA` 存在可预览场景（余额/仓位/订单等按实现） | `userA` 调用上述 preview 系列（目标 user=userA） | 无 | 至少包含 `hfAfter/newHF/newLTV`（按实现） | 调用成功；返回结构稳定（字段存在且单位符合文档约定） |
| PRV-04 ops/admin 可代查 | `ops` 具备 `ACTION_VIEW_USER_DATA` 或 admin | `ops` 调用 preview 系列，目标 user 为 `userA` | 无 | 同 PRV-03 | 调用成功；行为与 `userA` 自查一致（除“caller==user”相关分支外） |
| PRV-05 输入校验（非法输入） | 无 | asset=0 / amount=0 / orderId=0 等非法输入（按实现覆盖）调用 preview 系列 | 无 | N/A | 必须按实现 revert（例如 `PreviewView__InvalidInput()`）；不得静默返回 0 值误导 |
| PRV-06 不绕过下游权限（内部调用通行，外部仍 gate） | 部署脚本已为 `PreviewView` 合约地址授予下游所需角色（如 `VIEW_USER_DATA`），仅用于内部模块间调用 | 外部 `unauthorized` 调用 PreviewView（目标非本人）；以及外部 `userA` 自查 | 无 | N/A / 同 PRV-03 | 外部 `unauthorized` 仍必须 `MissingRole()`；证明“内部 grant 不会导致外部绕过” |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-previewview-acceptance.blockNumber --network localhost`
- 覆盖：PRV-01~PRV-06（私域 gate、ops/admin 代查、输入校验、职责边界）。

##### 4.14 `RewardView`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-reward-edgecases.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| RV-01 写入口白名单（writer allowlist） | `RewardManagerCore` 与 Easy 系列 writer 已部署；`unauthorized` 非 writer | `unauthorized` 调用任一 `push*`（`pushEasyMinted/pushEasyBurned/pushPenaltyLedger/pushUserLevel/pushEarnState/pushSystemStats`） | 无成功 `DataPushed` | N/A | 必须 revert（推荐 `RewardView__UnauthorizedWriter()` 或等效）；不得用 `MissingRole()` 混淆读权限与写白名单 |
| RV-02 写入成功必须 DataPush（type 统一） | 调用方为 writer（例如 `RewardManagerCore` / `RewardAccrualManager` / `EasyConsumption` 等） | 逐个调用上述 `push*`（每次至少 1 个有效样本） | 必须 `DataPushed(dataTypeHash,payload)` | N/A | 每个 push 成功都必须观察到 `DataPushed`；`dataTypeHash` 必须来自集中常量口径（推荐 `DataPushTypes.*`），且语义可唯一定位 |
| RV-03 私域读权限：非本人必须 MissingRole | `userA/userB`；`unauthorized` 无 `ACTION_VIEW_USER_DATA` | `unauthorized` 读取 `userA` 的 Reward 私域主查询（如 `getUserRewardSummary(userA)`） | 无 | N/A | 必须 `revert MissingRole()`（断言 selector） |
| RV-04 私域读权限：本人/ops 可读 | `userA`；`ops/admin` 具备 `ACTION_VIEW_USER_DATA` 或 admin | `userA` 读取自身；`ops` 读取 `userA` | 无 | 返回值必须包含 `isValid/blockNumber`（并发敏感时含 `version`） | 均成功；有效性信息不缺失（Facade 也不得丢失） |
| RV-05 B 类缓存有效性：blockNumber 单调 & isValid 语义正确 | 已至少 push 一次；可推进时间（按测试工具能力） | `writer` push → 读 `getUserRewardSummary`（或等效）→ 再次 push → 再读 | `DataPushed`（push 时） | `isValid/blockNumber` | blockNumber 单调推进；`isValid` 与缓存窗口/实现一致（过期后变 false 或等效表达），且可脚本断言 |
| RV-06 只读聚合职责边界（读不触发 DataPush） | 无 | 仅调用所有对外只读查询（含 batch/聚合如存在） | 无 `DataPushed` | 查询输出（按实现） | 读路径不应触发任何 push/状态写入；若发现事件，视为职责边界违规 |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-rewardview-acceptance.blockNumber --network localhost`
- 覆盖：RV-01~RV-06（writer allowlist、DataPushed、私域读 gate、meta/validity、职责边界）。

##### 4.15 `ModuleHealthView`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-modulehealthview-acceptance.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| MHV-00 Registry guard（优先级高于权限） | `ModuleHealthView` 未初始化 / registry 被置为非合约地址 | 调用 `checkAndPushModuleHealth/getModuleHealthStatus/getModuleHealthStatusWithMeta/checkModuleHealth`（任意 caller） | 无 | N/A | 必须 `revert ZeroAddress()` 或 `revert NotAContract(registry)`；不得误报为 `MissingRole()` |
| MHV-01 权限：读与触发检查均为 system-status（统一 MissingRole） | registry 有效；`operator` 具备 `ACTION_VIEW_SYSTEM_STATUS`；`unauthorized` 无该角色且非 admin | `unauthorized` 调用 `checkAndPushModuleHealth/getModuleHealthStatus/getModuleHealthStatusWithMeta/checkModuleHealth` | 无 | N/A | 必须 `revert MissingRole()`（断言 selector，不依赖 revert string） |
| MHV-02 admin 旁路允许（system-status 等价） | registry 有效；`admin` 具备 `ACTION_ADMIN` 但不具备 `ACTION_VIEW_SYSTEM_STATUS` | `admin` 调用 `checkAndPushModuleHealth/getModuleHealthStatus/getModuleHealthStatusWithMeta/checkModuleHealth` | 视操作而定（仅 push 有事件） | N/A | 必须成功（证明 gate 为 `system-status OR admin`）；不得强依赖双角色 |
| MHV-03 checkAndPush 成功：可观测 + 双端缓存写入 | registry 已注册 `KEY_HEALTH_VIEW`；并已为 `ModuleHealthView` 地址授予 `ACTION_VIEW_SYSTEM_STATUS`（用于向 `HealthView.pushModuleHealth` 写入） | `operator` 调用 `checkAndPushModuleHealth(moduleWithCode)` | 必须出现 `ModuleHealthChecked`；必须出现由 **`HealthView`** 发出的 `DataPushed(DATA_TYPE_MODULE_HEALTH, payload)`；且 `HealthView` 侧应出现 `ModuleHealthCached`（按实现） | N/A | `ModuleHealthView.getModuleHealthStatus(module)` 中 `isHealthy=true`、`lastCheckTime>0`、`totalChecks` 递增；`HealthView.getModuleHealth(module)` 同步为健康状态 |
| MHV-04 checkAndPush：无代码地址判定为 unhealthy | 同 MHV-03；`moduleNoCode` 为 EOA/无 code 的地址 | `operator` 调用 `checkAndPushModuleHealth(moduleNoCode)` | 同 MHV-03 | N/A | `isHealthy=false`；`detailsHash` 为“no code”语义；`failures`（或等效字段）为非 0（按实现） |
| MHV-05 DataPush schema 可脚本断言（payload 可解码 + 类型口径集中） | 同 MHV-03 | 监听 **`HealthView`** 的 `DataPushed`，对 `dataTypeHash` 与 `payload` 做解码断言 | `DataPushed` | N/A | `dataTypeHash == DataPushTypes.DATA_TYPE_MODULE_HEALTH`；`payload` 必须能 ABI 解码为实现约定的 schema（推荐固定为 `(module,isHealthy,detailsHash,failures,blockNumber)`）。不得出现同一 `dataTypeHash` 多种 payload schema（避免链下消费歧义） |
| MHV-06 缓存有效性（Meta API）与 TTL 边界 | 已执行至少一次 `checkAndPushModuleHealth(module)`；可推进时间（按测试工具能力） | 调用 `getModuleHealthStatusWithMeta(module)`；推进时间到 `CACHE_DURATION` 边界再读 | 无（仅读） | `blockNumber/isValid` + `ModuleHealthStatus` | `blockNumber == status.lastCheckTime`；刚推送后 `isValid=true`；推进到 `CACHE_DURATION+1` 后 `isValid=false`（TTL 口径与 `ViewConstants.CACHE_DURATION` 一致） |
| MHV-07 zero-module 行为一致性（push revert / view 返回） | registry 有效；caller 为 `operator/admin` | `checkAndPushModuleHealth(0x0)`；`checkModuleHealth(0x0)`；`getModuleHealthStatusWithMeta(0x0)` | 无（revert 的不应有事件） | `checkModuleHealth` 返回 `(bool,string)`；Meta 返回 `blockNumber/isValid` | `checkAndPushModuleHealth(0x0)` 必须 `revert ZeroAddress()`；`checkModuleHealth(0x0)` 必须返回 `false`（并给出可断言的 details 文本/等效）；`blockNumber==0` 且 `isValid=false` |
| MHV-08 依赖缺失：Registry 未注册 `KEY_HEALTH_VIEW` 必须硬失败 | registry 有效但 `KEY_HEALTH_VIEW` 缺失/为 0 | `operator` 调用 `checkAndPushModuleHealth(module)` | 无成功事件 | N/A | 必须 revert（来自 `Registry.getModuleOrRevert`）；且不得留下本地缓存写入（回滚后 `lastCheckTime==0`） |
| MHV-09 HealthView 拒绝写入时的回滚语义 | registry 有效且 `KEY_HEALTH_VIEW` 已注册；但 **未**为 `ModuleHealthView` 地址授予 `ACTION_VIEW_SYSTEM_STATUS`（HealthView 侧会拒绝） | `operator` 调用 `checkAndPushModuleHealth(module)` | 无成功事件 | N/A | 必须 revert（HealthView 授权错误）；并且 `ModuleHealthView` 本地缓存不应被部分写入（回滚验证） |
| MHV-10 只读职责边界（读不触发 DataPush/不写缓存） | registry 有效；caller 为 `operator/admin` | 仅调用 `getModuleHealthStatus/getModuleHealthStatusWithMeta/checkModuleHealth` | 无 `DataPushed` / 无 `ModuleHealthChecked` | N/A | 读路径不得触发任何事件与状态写入（可通过事件计数/快照对比断言） |
| MHV-11 版本与升级权限（可选但推荐覆盖） | registry 有效；准备 `admin` 与 `unauthorized` | `unauthorized` 尝试升级；读取 `getVersionInfo()` | 无 | `VersionInfo(apiVersion,schemaVersion,implementation)` | 升级必须要求 `ACTION_ADMIN`；`getVersionInfo()` 可用且字段齐全（便于链下定位 schema 变更） |
| MHV-12 统计字段一致性（totalChecks/successRate/lastCheckTime） | registry 有效；caller 为 `operator/admin` | 对同一 module 重复 `checkAndPushModuleHealth`；对多个 module 分别执行 | push 路径同 MHV-03 | N/A | `totalChecks` 对每个 module 独立递增；`lastCheckTime` 单调不减；`successRate` 按实现的累计口径可被确定性断言（至少覆盖 “全成功/全失败/混合” 三类） |
| MHV-13 批量边界（若未来新增 batch） | 模块提供批量读取/检查接口（当前可能不存在；未来新增时必须补齐） | 长度 0 / 长度 > `MAX_BATCH_SIZE` 调用 batch 接口 | 无 | N/A | 空数组必须 `revert EmptyArray()`；超限必须 `revert BatchTooLarge(len,max)`（与全仓口径一致） |
| MHV-14 职责边界（轻量检查，不写业务账本） | 无 | 代码审阅 + 运行时调用 `checkAndPushModuleHealth` | 除缓存/推送相关事件外不应有业务写事件 | N/A | 仅允许：本地健康缓存写入 + 对 `HealthView` 的 module-health cache 写入 + `DataPushed`；不得出现任何账本权威写入或“业务缓存权威写入” |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-modulehealthview-acceptance.blockNumber --network localhost`
- 覆盖：MHV-00~MHV-12（registry guard、MissingRole、push 可观测、TTL/validity、DataPushed 解码、回滚语义）。

##### 4.16 `EventHistoryManager`（测试矩阵）
- **脚本**：`scripts/e2e/e2e-localhost-eventhistorymanager-acceptance.ts`
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| EHM-01 职责边界（无链上历史存储） | 无 | 对源码做静态检查（state var/映射/数组）；运行时记录 `recordEvent` 前后 gas 与 storage 行为（按测试框架能力） | N/A | N/A | 不应新增任何持久化历史存储；除 UUPS/initializer 外不应写入业务状态（仅发事件 + DataPush） |
| EHM-02 写入口权限 gate | `unauthorized` 无 `ACTION_MANAGE_EVENT_HISTORY`；准备 `operator/admin` 有权限 | `unauthorized` 调用 `recordEvent(...)` | 无成功事件 | N/A | 必须 revert（按实现 gate）；不得 revert string；错误需可脚本断言（selector/自定义 error） |
| EHM-03 成功记录：HistoryRecorded + DataPushed 双事件 | `operator/admin` 有权限；准备一组样本参数（`eventType/user/asset/amount/extraData`） | 调用 `recordEvent(...)` | 必须同时出现 `HistoryRecorded` 与 `DataPushed` | N/A（事件 payload 可解码） | `DataPushed.payload` 必须能 ABI 解码回 `eventType/user/asset/amount/extraData`（按实现 schema），且与 `HistoryRecorded` 一致 |
| EHM-04 DataPush type 常量口径 | 同 EHM-03 | 连续调用多次 `recordEvent(...)`，覆盖不同 eventType | 每次均有 `DataPushed` | N/A | `dataTypeHash` 必须来自集中常量口径（推荐 `DataPushTypes.*`），且类型语义稳定（便于链下索引统一消费） |
| EHM-05 版本信息可观测（升级定位） | 合约部署完成 | 调用 `getVersionInfo()`（由 `ViewVersioned` 提供） | 无 | `VersionInfo` | 返回字段齐全，便于链下定位实现与 schema 变更；UUPS + `__gap` 保持不变 |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-eventhistorymanager-acceptance.blockNumber --network localhost`
- 覆盖：EHM-01~EHM-05（权限 gate、HistoryRecorded+DataPushed、payload 可解码、版本信息可观测）。

#### 5.1.3 e2e 场景矩阵（覆盖多模块联动）
| 场景 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| E2E-01 多用户资金流回放 | N 用户、资产配置完成 | deposit/borrow/repay/withdraw 交错执行；每步后用 `DashboardView/CacheOptimizedView/BatchView` 批量拉取 | `DataPushed` 连续可观测 | Position/Health/Stats 的有效性字段齐全 | 每步数据一致；有效性信息不丢；批量接口稳定 |
| E2E-02 推送失败模拟与链下重试 | 可制造 view 地址缺失/推送失败 | 故意触发 push 失败 → 监听失败事件 → 链下重试 push | 失败事件 + 重试成功的 `DataPushed` | 重试后 `isValid=true`、blockNumber 更新 | 失败可观测且可重放；无链上循环重试 |
| E2E-03 批量边界与性能 | 可生成大数组 | 接近 `MAX_BATCH_SIZE` 的批量调用 + 超限调用 | 成功/失败事件口径一致 | 返回稳定 | 不 OOG；超限一致失败 |

#### 5.1.4 验收证据（Artifacts，MUST）
每次验收运行必须输出/保存（脚本日志或文件均可）：
- 模块地址快照（Registry keys → addr）
- 关键 View 的 `getVersionInfo()`（api/schema/implementation）
- `DataPushed` 按 `dataTypeHash` 的计数统计（推荐以 `DataPushTypes` 作为统计口径）
- 失败事件计数与重试成功率（若启用失败模拟）

---

## Appendix A — Scheme U（用户私域读权限）对齐追踪清单（2026-01-24）

> 目的：把“需要改哪些文件/测试”的可执行清单固化在本 Workguide 底部，便于对齐推进与验收闭环。
>
> Scheme U（用户私域读权限）规则（MUST）：
> - self read：`msg.sender == user` **必须允许**（不要求任何 role）
> - non-self read：caller 必须具备 `ACTION_VIEW_USER_DATA` **或** `ACTION_ADMIN`
> - batch user reads：**不得 self-bypass**，必须 `ACTION_VIEW_USER_DATA` 或 `ACTION_ADMIN`
> - 无权限失败：对外入口必须统一 `revert MissingRole()`（避免自定义 Unauthorized / revert string 分叉）

### A.-1 已落地状态与变更摘要（2026-01-30）

- **已落地（✅）**：Scheme U 的“self 放行 / non-self 需 VIEW_USER_DATA 或 ADMIN / batch 无 self-bypass / 失败 MissingRole()”已在主干 user-dimensional view 中收口
  - **代表性合约**：`UserView`（façade）、`PositionView`、`FeeRouterView`、`RewardView`、`LiquidatorView`、`StatisticsView` 等均已使用 `MissingRole()` 作为统一失败口径，并遵循 self/non-self/batch 规则（以各自 `onlyAuthorizedFor` / `onlyUserDim` / `onlyUserDimBatch` 等 gate 为准）。
  - **测试覆盖（示例）**：对应 View 的 unit tests 与 localhost acceptance 脚本已包含“self 成功 / non-self outsider 失败 / batch 无 self-bypass”的权限矩阵断言（详见本附录 A.2）。

> 备注：本次（2026-01-30）主要变更聚焦于 **Statistics（USD-8 + Strict B+ 单入口写入）**，Scheme U 本身属于“此前已完成并已验证”的对齐项；此处补齐的是 Workguide 的 SSOT 记录与可追溯摘要。

### A.0 适用范围与例外（与 `docs/Architecture-Guide.md` 保持一致）

#### A.0.1 适用范围（MUST）
- **仅适用于 user-dimensional view（用户维度 view）**：对外提供“按用户维度返回数据”的 View 接口（例如 `getUser*` / `*WithMeta(user, ...)` / 接收 `user` 或 `users[]` 参数的只读接口）。
- **非用户维度不适用**：系统级/全局快照、模块注册查询、纯计算等接口不在 Scheme U 范围内，勿强行套用（避免把 system-scoped 接口错误改成 user-data gate）。

#### A.0.2 更新：`HealthView` 健康因子读取已按 Scheme U 收口（当前口径）
- `HealthView.getUserHealthFactorWithMeta/isUserLiquidatableWithMeta`：按 Scheme U（self 放行；non-self 需 `ACTION_VIEW_USER_DATA`/`ACTION_ADMIN`，失败 `MissingRole()`）。
- `HealthView.batchGetHealthFactorsWithMeta(users)`：users[] 枚举能力（无 self-bypass），需 `ACTION_VIEW_USER_DATA`/`ACTION_ADMIN`。
- 说明：该变更用于隐私强化与统一用户维度读权限；任何前端/脚本/测试中“默认公开可读”的假设都必须移除并同步更新断言。

### A.0.3 本附录涉及文件（汇总清单）

#### 合约（A.1 覆盖：核心 user-dimensional view）
- `src/Vault/view/modules/FeeRouterView.sol`
- `src/Vault/view/modules/PositionView.sol`
- `src/Vault/view/modules/RewardView.sol`
- `src/Vault/view/modules/AccessControlView.sol`
- `src/Vault/view/modules/LiquidatorView.sol`
- `src/Vault/view/modules/UserView.sol`（façade/聚合层）
- `src/Vault/view/modules/DashboardView.sol`（façade/聚合层）
- `src/Vault/view/modules/CacheOptimizedView.sol`（façade/聚合层）

#### 合约（补充：用户维度接口，但此前未列入）
- `src/Vault/view/modules/PreviewView.sol`（preview 类 user read）
- `src/Vault/view/modules/LendingEngineView.sol`（订单/借贷用户维度读）
- `src/Vault/view/modules/StatisticsView.sol`（用户快照/统计 read）
- `src/Vault/view/modules/ValuationOracleView.sol`（用户权限查询 read）
- `src/Vault/view/modules/SystemView.sol`（含 `user` 维度接口；SystemView 内部应避免绕过 Scheme U）

#### 合约（附录 B 已单列讨论的风险相关模块/路由模块）
- `src/Vault/view/modules/RiskView.sol`（B.2/B.3/B.4，✅ 已按 Scheme U 实现）
- `src/Vault/view/modules/LiquidationRiskView.sol`（B.2/B.3/B.4，兼容期，system-only 接口已移除）
- `src/Vault/view/modules/SystemRiskView.sol`（B.3/B.4/B.6，✅ 已落地：system-only，`ACTION_VIEW_RISK_DATA` gate）
- `src/Vault/view/modules/HealthView.sol`（B.1/B.4，健康因子 canonical，✅ 已按 Scheme U 收口）
- `src/Vault/view/modules/BatchView.sol`（B.5，✅ 已按 Scheme U batch 实现）
- `src/Vault/view/modules/SystemView.sol`（B.5，路由，✅ `routeSystemRisk()` 已实现）

#### 单元测试（A.2.1 覆盖）
- `test/Vault/view/FeeRouterView.test.blockNumber`
- `test/Vault/view/PositionView.cache-validity.test.blockNumber`
- `test/Vault/view/AccessControlView.test.blockNumber`
- `test/Vault/view/modules/LiquidatorView.test.blockNumber`

#### e2e / acceptance（A.2.2 覆盖）
- `scripts/e2e/e2e-localhost-feerouterview-acceptance.blockNumber`
- `scripts/e2e/e2e-localhost-positionview-acceptance.blockNumber`
- `scripts/e2e/e2e-localhost-liquidatorview-acceptance.blockNumber`
- `scripts/e2e/e2e-localhost-rewardview-acceptance.blockNumber`

### A.1 合约文件（需要修改）

#### A.1.1 MUST 修复（✅ 已确认：历史冲突已修复）
- `src/Vault/view/modules/FeeRouterView.sol`
  - **历史问题（已修复）**：self 读曾被强制要求 `VIEW_USER_DATA`；non-self 曾只允许 admin；且无权限使用自定义 Unauthorized。
  - **已落地改法（✅）**：`onlyAuthorizedFor(user)` 已按 Scheme U 收口；对外无权限统一 `MissingRole()`。
- `src/Vault/view/modules/PositionView.sol`
  - **历史问题（已修复）**：所有 user-scoped read 曾强制 `VIEW_USER_DATA`（self 也不例外）；batch 也同样如此；与 Scheme U 冲突。
  - **已落地改法（✅）**：单用户入口按 Scheme U；batch(users[]) 入口按 Scheme U batch（no self-bypass，ops/admin）。
- `src/Vault/view/modules/RewardView.sol`
  - **历史问题（已修复）**：non-self 曾未纳入 admin（`ACTION_ADMIN`）旁路。
  - **已落地改法（✅）**：non-self 允许 `VIEW_USER_DATA` 或 admin；失败 `MissingRole()`。
- `src/Vault/view/modules/AccessControlView.sol`
  - **历史问题（已修复）**：读权限与错误口径曾不符合 Scheme U。
  - **已落地改法（✅）**：user-scoped reads 已按 Scheme U；失败统一 `MissingRole()`。
- `src/Vault/view/modules/LiquidatorView.sol`
  - **历史问题（已修复）**：self 曾被强制要求 role；non-self 曾额外要求 admin；与 Scheme U 冲突。
  - **已落地改法（✅）**：`_checkUserAccess` 已按 Scheme U；失败统一 `MissingRole()`。

#### A.1.2 SHOULD 修复（若决定把聚合门面也纳入“用户私域”口径）
> 注：这些是 façade/聚合层。如果合约地址被授予下游所需 role（常见于跨模块 staticcall），但入口未做 Scheme U gate，会产生“任何人都能借 façade 代查他人”的风险。
- `src/Vault/view/modules/UserView.sol`（建议为所有 user-scoped 入口补 Scheme U gate；batch 入口按 batch 规则）
- `src/Vault/view/modules/DashboardView.sol`（user 参数入口建议补 Scheme U gate，避免“self 也要 role”）
- `src/Vault/view/modules/CacheOptimizedView.sol`（同上）

### A.2 测试与验收脚本（需要同步修改/补齐）

#### A.2.1 单元测试（Hardhat）
- `test/Vault/view/FeeRouterView.test.blockNumber`
  - **需要改**：self-read 不应需要 `VIEW_USER_DATA`；补齐 ops/admin/non-self/outsider 的权限矩阵；无权限断言改为 `MissingRole()`。
- `test/Vault/view/PositionView.cache-validity.test.blockNumber`
  - **需要改**：移除/改写“任何地址都可以免费查询他人仓位”的断言；改为 Scheme U（self allowed; non-self outsider -> `MissingRole()`）。
- `test/Vault/view/AccessControlView.test.blockNumber`
  - **需要改**：无权限断言统一为 `MissingRole()`，并按 Scheme U 补齐 admin/ops 行为。
- `test/Vault/view/modules/LiquidatorView.test.blockNumber`
  - **需要改**：self user-scoped reads 不应强制 `VIEW_USER_DATA`；补齐 ops/admin/non-self/outsider 的权限矩阵；无权限断言 `MissingRole()`。
- **风险/系统风险收敛相关（新增/已改）**
  - `test/Vault/view/HealthView.test.blockNumber`
    - **新增口径（已更新）**：`getUserHealthFactorWithMeta/isUserLiquidatableWithMeta` 按 Scheme U；
      `batchGetHealthFactorsWithMeta(users)` 无 self-bypass，需 `VIEW_USER_DATA`/`ACTION_ADMIN`。
    - **保留 gate**：`push*` 仍需 `ACTION_VIEW_PUSH`；系统健康相关仍需 `ACTION_VIEW_SYSTEM_STATUS`/`ACTION_ADMIN`。
  - `test/Vault/view/RiskView.test.blockNumber`
    - **改为 Scheme U**：self read 允许；non-self 需 `VIEW_USER_DATA`/`ACTION_ADMIN`；`batchGetRiskAssessments` 无 self-bypass。
    - **无权限断言**：统一 `MissingRole()`。
  - `test/Vault/view/LiquidationRiskView.test.blockNumber`
    - **改为 Scheme U**：self read 允许；non-self 需 `VIEW_USER_DATA`/`ACTION_ADMIN`；batch 无 self-bypass。
    - **无权限断言**：`MissingRole()`（来自 view 合约自身）。
  - `test/Vault/view/BatchView.test.blockNumber`
    - **改为 Scheme U batch**：`batchGetHealthFactorsWithMeta/batchGetRiskAssessments` 需 `VIEW_USER_DATA`/`ACTION_ADMIN`。
    - **无权限断言**：`MissingRole()`（来自 BatchView）。
  - `test/Vault/view/SystemView.test.blockNumber`
    - **新增**：`routeSystemRisk()` 路由一致性断言（moduleKey + Registry 解析一致）。

#### A.2.2 e2e（localhost acceptance）
- `scripts/e2e/e2e-localhost-feerouterview-acceptance.blockNumber`
  - **需要补/改**：增加 Scheme U 权限矩阵断言（self 无 role 成功；ops/admin 代查成功；outsider non-self 必须 `MissingRole()`）。
- `scripts/e2e/e2e-localhost-positionview-acceptance.blockNumber`
  - **需要改**：更新“PositionView 读必须 VIEW_USER_DATA”的断言为 Scheme U + batch 规则。
- `scripts/e2e/e2e-localhost-liquidatorview-acceptance.blockNumber`
  - **需要改**：更新 self/non-self 行为与 `MissingRole()` 断言，使其符合 Scheme U（self 无 role 成功；ops/admin 代查成功；outsider non-self 失败）。
- `scripts/e2e/e2e-localhost-rewardview-acceptance.blockNumber`
  - **需要补**：补充 admin（仅 `ACTION_ADMIN`）对 Reward 私域数据的代查用例（若当前未覆盖）。
- **风险/系统风险收敛相关（新增/已改）**
  - `scripts/e2e/e2e-localhost-healthview-acceptance.blockNumber`
    - **改为公开只读**：`getUserHealthFactorWithMeta/batchGetHealthFactorsWithMeta` 不应要求 role；保留 push 入口 `ACTION_VIEW_PUSH` gate 断言。
  - `scripts/e2e/e2e-localhost-batch-aggregators-acceptance.blockNumber`
    - **改为 Scheme U batch**：`BatchView.batchGetHealthFactorsWithMeta/batchGetRiskAssessments` 需 `VIEW_USER_DATA`/`ACTION_ADMIN`，并保持 batch 无 self-bypass。
    - **RiskView 自身**：self read 允许；non-self 需 `VIEW_USER_DATA`/`ACTION_ADMIN`；batch 无 self-bypass。
  - `scripts/e2e/e2e-localhost-systemview-routing.blockNumber`
    - **新增**：`routeSystemRisk()` 与 Registry 一致性校验（moduleKey + address）。
  - `scripts/e2e/utils/view-preflight.blockNumber` / `scripts/e2e/utils/view-scan.blockNumber`
    - **新增**：`SYSTEM_RISK_VIEW` 路由预检与版本扫描入口。

---

## Appendix B — 方案：将“系统风险数据”收敛到单一 `SystemRiskView`（✅ 已落地）

> 背景：已明确 **`RiskView` 属于用户私域数据**（应遵循 Scheme U）。此前仓库存在若干“系统级/批量枚举/全局风险参数”的读接口分散在多个 View 合约中（并且与 user-scoped 的 self-bypass 语义混在一起）。  
> 目标：把**系统风险数据（system-scoped risk）**集中到一个 View 合约中，做到边界清晰、权限统一、部署与运维更可控。  
> **状态（✅ 已落地）**：SystemRiskView 已实现、部署、注册并测试；RiskView 与 BatchView 已按 Scheme U 收口；路由与文档已对齐。

### B.1 定义：以“接口形态”划分 system-scoped vs user-dimensional（与架构指南对齐）

> 核心原则（MUST）：**是否属于 user-private（Scheme U）不是看“数据叫不叫 risk”，而是看接口是否以 `user/users[]` 为维度返回数据**。  
> 只要接口接收 `user` 或 `users[]`，就是 user-dimensional view（Scheme U 范围）；反之才可能是 system-scoped（SystemRiskView 范围）。

- **System Risk（system-scoped risk，SystemRiskView 承载）**：
  - **定义**：不以 `user/users[]` 为维度的系统级风险只读接口（例如全局阈值、系统级风险参数/配置、系统开关、系统级风险快照）。
  - **典型特征**：无 `user/users[]` 入参；返回全局阈值（如 liquidation threshold / minHF）或系统级参数。
  - **读权限（已启用 gate）**：
    - `ActionKeys.ACTION_VIEW_RISK_DATA`（或 `ActionKeys.ACTION_ADMIN` 旁路），无权限失败 `revert MissingRole()`。

- **User Risk（user-dimensional risk，RiskView 承载）**：
  - **定义**：以 `user` 或 `users[]` 为维度返回的风险输出（包含 batch 枚举能力）。
  - **权限（MUST）**：按 Scheme U：
    - self read：`msg.sender == user` 放行；
    - non-self：仅 `ACTION_VIEW_USER_DATA` 或 `ACTION_ADMIN`；
    - batch users[]：**不得 self-bypass**，必须 `ACTION_VIEW_USER_DATA` 或 `ACTION_ADMIN`；
    - 无权限失败：统一 `revert MissingRole()`。

- **特别说明（已更新）：HealthView 健康因子读取已按 Scheme U 收口（当前口径）**
  - `HealthView.getUserHealthFactorWithMeta/isUserLiquidatableWithMeta`：Scheme U（self 放行；non-self 需 `VIEW_USER_DATA`/`ACTION_ADMIN`）。
  - `HealthView.batchGetHealthFactorsWithMeta(users)`：users[] 枚举能力（无 self-bypass；ops/admin only）。

### B.2 现状盘点：当前“系统风险数据”分散在哪

#### B.2.1 `src/Vault/view/modules/LiquidationRiskView.sol`（包含 system + user 两套语义）
当前实现把多类接口混在同一合约内，并使用了两套 gate（`onlyRiskViewerSystem/onlyRiskViewerFor`）。为避免读者误解，按“现状 vs 目标（架构指南口径）”对照如下：

- **A) user-dimensional batch（`users[]` 枚举能力）**
  - **现状**：这些接口位于 `onlyRiskViewerSystem` 下，使用 `ACTION_VIEW_RISK_DATA` gate：
    - `batchIsLiquidatable(address[] users)`
    - `batchGetUserHealthFactors(address[] users)`
    - `batchGetLiquidationRiskScores(address[] users)`
  - **目标（MUST，Scheme U batch）**：凡接收 `users[]` 的只读接口都属于 user-dimensional batch，**不得 self-bypass**，必须 `ACTION_VIEW_USER_DATA` 或 `ACTION_ADMIN`，无权限统一 `revert MissingRole()`。
    - 归宿：优先迁移到 `RiskView.batch*`（或由 `BatchView` 聚合调用 `RiskView.batch*`，但 BatchView 入口同样必须按 Scheme U batch 做 gate）。

- **B) user-dimensional single（`user` 单用户维度）**
  - **现状**：`onlyRiskViewerFor(user)` 允许 self-bypass；但 non-self 使用 `ACTION_VIEW_RISK_DATA`：
    - `isLiquidatable(user)`（及 overload）
    - `getLiquidationRiskScore(user)`
    - `getUserHealthFactorWithMeta(user)`
    - `getHealthFactorCacheWithBlock(user)`
    - `getHealthFactorCache(user)`
  - **目标（MUST，Scheme U）**：self 允许；non-self 必须 `ACTION_VIEW_USER_DATA` 或 `ACTION_ADMIN`；无权限统一 `revert MissingRole()`。
    - 归宿：`isLiquidatable/getLiquidationRiskScore/...` 这类“用户私域风险输出”迁移到 `RiskView`（见 B.4）。
    - **注意**：其中健康因子相关读取（`getUserHealthFactorWithMeta/batchGetHealthFactorsWithMeta/isUserLiquidatableWithMeta` 等）应优先归并到 `HealthView` 的 canonical 只读接口（当前为 Scheme U 收口；见 A.0.2）。

- **C) system-only（无 `user/users[]` 的全局阈值/系统参数）**
  - **现状**：已从 `LiquidationRiskView` 移除 system-only 接口（`getLiquidationThreshold/getMinHealthFactor`）。
  - **目标（SSOT 风格，推荐）**：仅由 `SystemRiskView` 承载 system-only 的全局阈值/系统参数入口；
    - 默认公开只读；如未来启用可选增强（MAY），才加 `ACTION_VIEW_RISK_DATA` gate（失败 `MissingRole()`）。

#### B.2.2 `src/Vault/view/modules/RiskView.sol`（当前全部按 risk-role gate）
- `batchGetRiskAssessments(address[] users)`：**users[] 枚举能力**（按架构指南应视为 user-dimensional batch → Scheme U batch 规则）
- `getUserRiskAssessment(user)` / `calculateHealthFactorExcludingGuarantee(user,asset)`：**user 维度风险**（应按 Scheme U 落地）

### B.3 推荐方案（可执行、与架构指南不打架）：拆分为 2 个 View，并以 “HealthView / Scheme U / system-only” 三分法收敛

#### B.3.1 新增模块：`SystemRiskView.sol`（专收 system risk）（✅ 已落地）
- **职责（MUST）**：仅承载 system-scoped（system-only）的风险只读接口：
  - 全局风险参数/阈值读取（threshold/minHF/maxLTV 等）
  - 系统级风险配置/系统级快照（若存在且不以 user/users[] 为维度）
- **明确禁止（MUST NOT）**：不得承载任何 `user/users[]` 维度的接口（避免与 Scheme U 冲突）。（✅ 已确认：实现中无 user/users[] 接口）
- **读权限（✅ 已启用 gate）**：
  - **当前实现**：已启用 `ActionKeys.ACTION_VIEW_RISK_DATA` gate（或 `ActionKeys.ACTION_ADMIN` 旁路），无权限失败 `revert MissingRole()`。
  - **实现位置**：`src/Vault/view/modules/SystemRiskView.sol` 的 `onlyRiskViewerOrAdmin` modifier。
- **ModuleKeys（✅ 已添加）**：`ModuleKeys.KEY_SYSTEM_RISK_VIEW = keccak256("SYSTEM_RISK_VIEW")` 已定义（`src/constants/ModuleKeys.sol`）。
- **路由（✅ 已实现）**：`SystemView.routeSystemRisk()` 已实现并测试（`scripts/e2e/e2e-localhost-systemview-routing.blockNumber`）。

#### B.3.2 保留/重定位：`RiskView.sol`（变为 user-private risk view）（✅ 已落地）
- **职责**：只保留 “用户私域风险” 的单用户接口（以及与 Scheme U 一致的代查语义）。
- **权限（✅ 已按 Scheme U 实现）**：按 Scheme U（self 允许；non-self 仅 `ACTION_VIEW_USER_DATA`/`ACTION_ADMIN`；失败 `MissingRole()`）
  - **实现位置**：`src/Vault/view/modules/RiskView.sol` 的 `onlyUserOrViewer`（单用户）与 `onlyUserBatchViewer`（batch）modifiers。
- **注意**：这里的“risk”虽然在数据意义上属于风险，但已定性为用户私域，因此权限应收敛到 **user-data 维度**，而不是 `ACTION_VIEW_RISK_DATA`。（✅ 已确认：RiskView 使用 `ACTION_VIEW_USER_DATA`，而非 `ACTION_VIEW_RISK_DATA`）

#### B.3.3 `LiquidationRiskView.sol` 的处置（与架构指南一致的实施顺序）
> `docs/Architecture-Guide.md` 当前仍将 `LiquidationRiskView` 定位为“清算风险只读补充（兼容/扩展）”。  
> 因此若目标是“严格符合架构指南文件”，推荐的执行顺序是：

- **步骤 1（MUST）**：先完成能力分流（见 B.4），并把 `LiquidationRiskView` 在文档/注释层标记为 **DEPRECATED（不再作为推荐对外入口）**。
- **步骤 2（MAY）**：当你们决定“确实要停部署/删除”时，先更新 `docs/Architecture-Guide.md`（SSOT）的模块清单与描述，再进行停止部署/停止注册/删除代码（避免再次出现“文档≠实现”的漂移）。

### B.4 “提取/迁移清单”（按架构指南口径分流：system-only → SystemRiskView；user/users[] → RiskView；健康因子 → HealthView）

> 目标：把风险相关只读能力按职责与权限口径收敛到三个明确归宿，避免“同类数据不同 gate / 同一语义多入口”。

- **迁移到 `SystemRiskView.sol`（system-only；读权限已启用 gate：`ACTION_VIEW_RISK_DATA` / `ACTION_ADMIN`）（✅ 已落地）**
  - **已实现接口**（`src/Vault/view/modules/SystemRiskView.sol`）：
    - `getLiquidationThreshold()`：清算阈值（system-only）
    - `getMinHealthFactor()`：最小健康因子（system-only）
    - `getMaxLtvBps()`：最大 LTV（bps，system-only）
  - **已从 `LiquidationRiskView.sol` 移除**：system-only 接口已迁移，不再在 LiquidationRiskView 中暴露。
  - **边界确认**：所有接口均无 `user/users[]` 参数，符合 system-only 定义。

- **迁移到 `RiskView.sol`（user-dimensional，Scheme U）（✅ 已落地）**
  - **已实现接口**（`src/Vault/view/modules/RiskView.sol`）：
    - `getUserRiskAssessment(user)`：用户风险评估（Scheme U：self 放行；non-self ops/admin）
    - `calculateHealthFactorExcludingGuarantee(user, asset)`：排除保证金的健康因子计算（Scheme U）
    - `batchGetRiskAssessments(users)`：批量风险评估（Scheme U batch：不得 self-bypass，必须 ops/admin）
  - **权限实现确认**：所有 user-dimensional 接口均按 Scheme U 实现（`onlyUserOrViewer` / `onlyUserBatchViewer`）。
  - **LiquidationRiskView 分流状态**：`LiquidationRiskView` 仍保留部分 user-dimensional 接口（兼容期），但已按 Scheme U 收口；推荐调用方迁移到 `RiskView`。

- **迁移/归并到 `HealthView`（Scheme U 收口）（✅ 已落地）**
  - **已实现接口**（`src/Vault/view/modules/HealthView.sol`）：
    - `getUserHealthFactorWithMeta(user)`：用户健康因子（Scheme U：self 放行；non-self ops/admin）
    - `isUserLiquidatableWithMeta(user)`：用户是否可清算（Scheme U）
    - `batchGetHealthFactorsWithMeta(users)`：批量健康因子（Scheme U batch：不得 self-bypass，必须 ops/admin）
  - **权限实现确认**：所有健康因子相关读取已按 Scheme U 收口（见 Appendix A.0.2）。

### B.5 受影响的路由/聚合模块（✅ 已同步改动）
- **`SystemView`（✅ 已实现）**
  - `routeSystemRisk()`：已实现，返回 `KEY_SYSTEM_RISK_VIEW` 的地址（system-only 风险入口；按系统路由既有口径 gate：`ACTION_VIEW_SYSTEM_DATA`）。
  - `routeRisk()`：已实现，指向 user-dimensional risk 的 `KEY_RISK_VIEW`（Scheme U）。
  - **测试覆盖**：`scripts/e2e/e2e-localhost-systemview-routing.blockNumber` 已覆盖路由一致性断言。
- **`BatchView`（✅ 已实现）**
  - 通过 `ModuleKeys.KEY_RISK_VIEW` 解析 risk view，调用 `RiskView.batchGetRiskAssessments`。
  - **权限确认**：BatchView 的 `batchGetRiskAssessments` 入口已按 Scheme U batch 规则 gate（`onlyUserBatchViewer`：不得 self-bypass，必须 `VIEW_USER_DATA`/`ADMIN`）。
  - **测试覆盖**：`scripts/e2e/e2e-localhost-batch-aggregators-acceptance.blockNumber` 已覆盖 Scheme U batch 断言。

### B.6 部署/配置/测试（✅ 已落地 Checklist）
- **ModuleKeys（✅ 已添加）**
  - `KEY_SYSTEM_RISK_VIEW = keccak256("SYSTEM_RISK_VIEW")` 已定义（`src/constants/ModuleKeys.sol`）。
- **deploy 脚本（✅ 已更新）**
  - `SystemRiskView` 已部署并注册到 Registry（key=`KEY_SYSTEM_RISK_VIEW`）。
    - 部署脚本：`scripts/deploy/deploylocal.blockNumber`、`scripts/deploy/deploy-arbitrum.blockNumber`、`scripts/deploy/deploy-arbitrum-sepolia.blockNumber`。
    - Registry 绑定：已在 `phaseBBindRegistry` 中注册。
  - `LiquidationRiskView`：
    - **当前状态**：继续部署/注册（兼容期），但 system-only 接口已移除，权威入口为 `SystemRiskView`。
    - **文档对齐**：`docs/Architecture-Guide.md` 已明确 `LiquidationRiskView` 为“兼容/扩展”，system-only 参数入口为 `SystemRiskView`。
- **frontend-config（✅ 已更新）**
  - `SystemRiskView` 地址已包含在部署输出（`scripts/deployments/localhost.json`）。
  - 风险相关调用方推荐路径：
    - `SystemRiskView`：system-only 风险参数（`ACTION_VIEW_RISK_DATA` gate）
    - `RiskView`：user-dimensional risk（Scheme U）
    - `HealthView`：健康因子（Scheme U 收口）
- **tests/e2e（✅ 已覆盖）**
  - `SystemRiskView`：
    - **权限测试**：`scripts/tests/view-schemeu-smoke-local.blockNumber` 覆盖 `ACTION_VIEW_RISK_DATA` gate 与 `MissingRole()` 断言。
    - **路由测试**：`scripts/e2e/e2e-localhost-systemview-routing.blockNumber` 覆盖 `routeSystemRisk()` 路由一致性。
  - `RiskView`：
    - **Scheme U 测试**：`scripts/e2e/e2e-localhost-batch-aggregators-acceptance.blockNumber` 覆盖 self-read / non-self / batch 权限矩阵。
  - `HealthView`：
    - **Scheme U 测试**：`scripts/e2e/e2e-localhost-healthview-acceptance.blockNumber` 覆盖 Scheme U 读 + push gate。
  - `BatchView`：
    - **Scheme U batch 测试**：`scripts/e2e/e2e-localhost-batch-aggregators-acceptance.blockNumber` 覆盖 batch 无 self-bypass 断言。

### B.7 风险与边界（✅ 已落地，边界已明确）
- **权限分叉风险（✅ 已规避）**：
  - `SystemRiskView`（system-only，`ACTION_VIEW_RISK_DATA` gate）与 `RiskView`（user-private，Scheme U）命名与路由已清晰区分。
  - `SystemView.routeSystemRisk()` 与 `SystemView.routeRisk()` 分别指向不同模块，避免前端误用。
- **Batch 能力的敏感性（✅ 已按架构指南实现）**：
  - 所有 `users[]` 枚举能力均按 Scheme U batch 实现（`VIEW_USER_DATA/ADMIN`，无 self-bypass）。
  - `SystemRiskView` 不包含任何 `users[]` 接口，避免口径冲突。
  - `BatchView.batchGetRiskAssessments` 调用 `RiskView.batchGetRiskAssessments`，权限 gate 在 BatchView 入口层（Scheme U batch）。
- **健康因子的一致性（✅ 已收敛）**：
  - 健康因子读取以 `HealthView` 为 canonical（Scheme U 收口）。
  - `RiskView` 通过 `HealthView` 读取健康因子（不重复暴露），避免权限分叉。
- **迁移策略（✅ 第一阶段已完成）**：
  - **第一阶段（✅ 已完成）**：`SystemRiskView` + `RiskView` 分流已完成，路由/测试已对齐；`LiquidationRiskView` 在文档中已明确为“兼容/扩展”，system-only 接口已移除。
  - **第二阶段（MAY，待决策）**：如确要停部署/删除 `LiquidationRiskView`，需先更新 `docs/Architecture-Guide.md`（SSOT）再执行清理，避免文档与实现漂移。


1) §2.1.1 system-scoped risk 的“可选增强（MAY）”读 gate（⚠️ 待确认）
位置：L101
内容：如果未来把 system-scoped risk 视为敏感数据，可对 SystemRiskView 增加 ACTION_VIEW_RISK_DATA gate。
为什么是 ⚠️
这是 策略分叉点（是否公开读）。当前默认策略是“公开只读”，而“可选增强”尚未启用，因此无法标 ✅。
如何消除（两种方案二选一）
方案 A（推荐，最小维护成本）：明确“永远公开只读”，删除 MAY 描述或改成“NOT IN SCOPE / MUST NOT gate”。→ 变 ✅
方案 B（启用 gate）：实现并测试 SystemRiskView 的 ACTION_VIEW_RISK_DATA gate（无权限 MissingRole()），并更新 e2e/文档。→ 变 ✅
验收标准：
A：文档不再存在“可选增强”分支，且 SystemRiskView getter 任意 caller 可 eth_call 成功。
B：无权限 caller 必须 MissingRole()；有 ACTION_VIEW_RISK_DATA 必须成功；并在 e2e 覆盖。

2) §2.4 推送失败与链下重试（⚠️ 持续核查）
位置：L132
内容：核心链路已落地，但标注为“需防回归”。
为什么是 ⚠️
这是工程上最容易回归的跨模块约束：新增/改动 push 点时很容易漏掉失败事件或 payload 不完整。要变 ✅ 必须把“防回归”变成可自动化验收。
如何消除（推荐做法）
增加一个 统一的 e2e/测试矩阵覆盖：对每个关键 best-effort push 点都能稳定触发失败并断言：
必须出现 CacheUpdateFailedWithContext（或约定的失败事件）
包含 key + snapshot + reason + requestId/seq/nextVersion（若该入口支持）
把 Workguide 中“核心链路已落地”的描述改为 ✅，并附带“已由哪些脚本/测试覆盖”。
验收标准：
本地可跑脚本覆盖至少：Position/Statistics/（如适用：Health push failure）等，且 CI 能跑通。

3) Phase 4：清理兼容债务与统一文档术语（⚠️ 待确认）
位置：L214
内容：这是持续清理项：legacy getter/命名/脚本/前端配置可能仍分叉。
为什么是 ⚠️
要变 ✅ 必须真的做到“唯一入口/唯一命名体系”，并确认脚本/前端/文档都不再引用旧入口。
如何消除（执行清单，SSOT 以本文 L217 的 `### Phase 4` 与 `docs/Architecture-Guide.md` 为准）
全仓检索并处理（**MUST**）：
- **deprecated getters（按 Architecture-Guide 的 SV-04）**：
  - 重点核对并迁移/隔离：`getAssetPrice/getTotalCollateral/getTotalDebt/getRewardSystemView/getGuaranteeSystemView`（以及同语义的旧别名/旧门面）
  - 允许保留为“兼容债务”（可 `revert`），但**禁止**作为脚本/前端/SDK 的集成路径（也不得依赖 `revert` 文本做路由提示）
- **旧命名/旧 key/旧 view 名称**：
  - 重点关注会造成“同一模块不同名字 / 同一名字不同模块”的分叉（例如文档/脚本仍出现 legacy 术语 `LiquidationView`（应统一为 `LiquidatorView`）、旧 `stats push` 入口、旧 `ModuleKeys` 名称）
  - 以 `docs/Architecture-Guide.md` 的模块清单与职责分组（A 核心 / B 可选）作为 canonical 命名与推荐入口
- **脚本/前端配置引用清理**：
  - `scripts/deploy/**`、`scripts/e2e/**`、`scripts/tests/**`：不得继续部署/注册/调用已 deprecated 的入口（除非在“兼容测试/兼容说明”用例中显式注明）
  - `frontend-config/**` 与 deployments 映射（如 `contracts-*.blockNumber`、`registry-service.blockNumber`、`deployments/*.json`）：地址映射与调用方必须迁移到 canonical View/Router（不得保留“看起来也能用”的旧地址字段）
- **文档术语与推荐路径统一**：
  - 文档中所有“推荐路径/集成指南/调用示例”必须只指向 canonical 入口；旧入口只能出现在“兼容说明 / 迁移附录（Deprecated Map）”
  - 建议维护一张“Deprecated Map（old → new）”表：每个旧入口给出替代接口、迁移原因、删除条件（何时可删）
对保留的兼容入口（**MUST**）：
- 统一在代码注释中标记 `DEPRECATED`（或 `@deprecated`）并给出替代路径；必要时直接 `revert`（兼容债务允许存在，但禁止被误用为推荐路径）。
验收标准（可机械核查，**MUST**）：
- `docs/**`、`scripts/**`、`frontend-config/**` 中不再出现旧入口作为“推荐/默认路径”；若出现，只能位于“兼容说明 / Deprecated Map”，且同时给出替代入口。
- “同语义多入口”不再存在：对同一语义的查询/推送在仓库中只能有一条 canonical 路径；若保留兼容入口，必须明确 deprecated 且无任何调用方依赖。

4) §5.1.2 测试矩阵“易漂移”（⚠️ 易漂移）
位置：L562
内容：提醒接口/权限/路由变更要同步矩阵，以 e2e 可运行结果为准。
为什么是 ⚠️
这是“单一事实来源（SSOT）”问题：当接口/权限/路由变化时，如果 **实现**、**e2e acceptance 脚本** 与 **§5.1.2 矩阵** 的断言点重复描述，就会出现三处需要同步更新，极易漂移。
要变 ✅，必须把矩阵从“人工维护的长表格”收口成**可自动核查**的形态，并强制做到“矩阵每个模块都被至少一个可运行脚本覆盖”。

如何消除（两种方案，二选一；推荐 A）
- 方案 A（推荐，最低维护成本）：把矩阵收口为“脚本清单 + 覆盖点（Coverage Points）”
  - 做法：
    - §5.1.2 每个 `##### 4.x ...（测试矩阵）` 必须包含一段 `**自动化脚本（推荐，可直接验收）**`，并给出 **唯一主脚本路径**（通常为 `scripts/e2e/e2e-localhost-*-acceptance.blockNumber`）。
    - 矩阵表格只保留 **关键承诺/覆盖点**（例如：权限口径、DataPushed 可观测、BatchTooLarge/EmptyArray、payload 可解码），避免把“具体字段/参数/错误字符串”等细节重复写在矩阵中。
  - 优点：漂移面最小；以脚本可运行结果为准；新增/改动断言只需改脚本 + 覆盖点。
  - 缺点：矩阵不再是“完整规格书”，需要读脚本看细节断言。
- 方案 B（增强，适合 CI 收口）：保留矩阵细节，但增加“自动校验”
  - 做法：
    - 新增一个自检脚本（例如 `scripts/tests/view-matrix-selfcheck.blockNumber`）：
      - 解析本文件中 `##### 4.x` 小节，抽取 `pnpm -s hardhat run scripts/e2e/...` 的脚本路径；
      - 校验脚本文件真实存在；
      - 校验 `scripts/e2e/README.md` 中同编号条目存在（避免矩阵/README 漂移）。
    - 将自检加入 CI 或本地 preflight。
  - 优点：矩阵仍可作为“规格+断言目录”，并且漂移可被自动发现。
  - 缺点：需要维护自检脚本与解析规则。


方案 2（推荐，当前无 CI 时优先）：本地节点部署 + e2e/smoke 作为“可模拟的 CI”
- 目标：先把“行为对齐”跑实（可重复、一键、严格断言），再把同一条命令平移到 CI（不在现在就投入 CI 稳定性工程）。
- 推荐入口（单命令）：
  - **production-like smoke runner**（本地节点）：`pnpm -s run test:smoke:prodlike:localhost`
  - **CI 风格的可重复 fresh（自动起节点）**：`pnpm -s run test:smoke:prodlike:localhost:autonode`
- 推荐跑法（两档，覆盖“确定性回归”与“最贴近真实”）：
  - **确定性回归（fresh，接近未来 CI）**：
    - `MODE=fresh RUN_DEPLOY=1 RUN_GRANT=1 RUN_PRECONFIG=1 pnpm -s run test:smoke:prodlike:localhost`
  - **最贴近真实（dirty，不自动补环境，暴露缺口）**：
    - `MODE=dirty RUN_DEPLOY=0 RUN_GRANT=0 RUN_PRECONFIG=0 pnpm -s run test:smoke:prodlike:localhost`
- 与 §5.1.2 的关系（避免漂移）：
  - §5.1.2 的每个 `##### 4.x` 必须绑定至少一个“可运行脚本路径”（e2e acceptance 或 smoke step）。
  - 以 `scripts/e2e/README.md` 与 `scripts/tests/README.md` 的 runner 约定作为“运行规范 SSOT”；矩阵只保留覆盖点，不重复细节断言。
- 推荐补强（无需 CI 也能强约束）：
  - 增加一个本地自检：`scripts/tests/view-matrix-selfcheck.blockNumber`（检查：矩阵→脚本路径存在、README 提及、每个 4.x 至少有一个脚本）。

验证清单（MUST，可机械执行）
- **覆盖完整性（本文件）**：
  - 列出矩阵小节：`rg -n "^##### 4\\.[0-9]+ " docs/Usage-Guide/ARCH-VIEW-ALIGNMENT-WORKGUIDE.md`
  - 列出脚本引用：`rg -n "pnpm -s hardhat run scripts/e2e/.*--network localhost" docs/Usage-Guide/ARCH-VIEW-ALIGNMENT-WORKGUIDE.md`
  - 期望：两者数量一致；且每个 `##### 4.x` 至少对应一个脚本行。
- **脚本存在性**：
  - 对上一步列出的每个 `scripts/e2e/*.blockNumber` 路径：文件必须存在（可由 review/CI 检查；方案 B 则由自检脚本自动检查）。
- **行为真实性（以可运行结果为准）**：
  - 运行矩阵引用的脚本（至少核心集合：SystemView/PositionView/HealthView/StatisticsView/Batch aggregators/LiquidatorView 等），全部通过。

验收标准（变 ✅ 的条件）
- §5.1.2 矩阵中**每个模块**都存在至少一个“可直接运行的验收脚本路径”，且脚本能跑通。
- 当接口/权限/路由变更时，PR 必须同时更新：对应 `scripts/e2e/*-acceptance.blockNumber` + §5.1.2 的覆盖点（或自检通过）；否则视为“矩阵已漂移”。

5) Appendix B：SystemRiskView 收敛方案（✅ 已落地）
位置：L956（原 L876）
内容：SystemRiskView 收敛方案已全部落地，所有迁移动作已完成并验收。
状态：✅ 已落地
**落地完成项（验收通过）**：
- ✅ `SystemRiskView` 已实现、部署、注册（system-only 接口，`ACTION_VIEW_RISK_DATA` gate）
- ✅ `RiskView` 已按 Scheme U 实现（user-private，self-read allowed，non-self requires `VIEW_USER_DATA`/`ADMIN`）
- ✅ `BatchView` 已按 Scheme U batch 实现（users[] 枚举无 self-bypass，必须 `VIEW_USER_DATA`/`ADMIN`）
- ✅ `HealthView` 已按 Scheme U 收口（健康因子读取，self/non-self/batch 规则一致）
- ✅ `SystemView.routeSystemRisk()` 已实现并测试（路由一致性断言通过）
- ✅ ModuleKeys、部署脚本、测试脚本已全部对齐
- ✅ 文档已更新（`docs/Architecture-Guide.md` 已明确 SystemRiskView 为 system-only 权威入口）

**验收标准（已满足）**：
- ✅ SystemRiskView system-only（无 user/users[] 接口）
- ✅ RiskView user-private（Scheme U 实现）
- ✅ BatchView users[] 不绕过 Scheme U（batch 无 self-bypass）
- ✅ 部署/路由/测试全对齐（所有脚本可运行并通过）
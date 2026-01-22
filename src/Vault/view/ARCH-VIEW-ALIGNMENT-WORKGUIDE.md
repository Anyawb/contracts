# View 系统全面对齐《Architecture-Guide》改造工作指南（临时）

> 位置：`src/Vault/view/ARCH-VIEW-ALIGNMENT-WORKGUIDE.md`  
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
- **只读/聚合/缓存（MUST）**：View 层只做查询/聚合/缓存；**账本写入不经 View**。
- **事件驱动（MUST）**：所有 push\* 写路径必须触发统一 DataPush（`DataPushLibrary._emitData(...)`），便于链下消费/重放/审计。
- **B 类缓存可验证（MUST）**：所有 B 类缓存对外读取必须返回足够的有效性信息（至少 `isValid` + `timestamp`；并发敏感场景应包含 `version`）。
- **推送失败可观测（MUST）**：push\* 必须 best-effort；失败不得链上循环重试，必须通过事件告警 + 链下重试闭环。
- **并发与幂等（MUST）**：关键缓存入口必须支持乐观并发控制（`nextVersion`）与幂等重放（`requestId`，必要时 `seq`）。
- **职责边界（MUST）**：`SystemView` 仅作为统一入口/元信息路由；资产/价格/奖励/清算等查询应引导到专属 View。
- **可升级与版本化（MUST）**：所有 `src/Vault/view/modules/*.sol` 满足 UUPS + `__gap`，并暴露统一版本信息 `getVersionInfo()`。

### 0.2 明确禁止（MUST NOT）
- **MUST NOT**：把任何“账本权威状态”迁移进 View（View 是加速层，不是账本）。
- **MUST NOT**：为 B/C 类缓存引入“统一刷新入口”（仅允许 A 类地址缓存存在统一刷新/维护入口）。

---

## 1. View 模块清单与 Registry Key（对齐基准）

以 `docs/Architecture-Guide.md` 为唯一对照基准（SSOT）。

### 1.1 A) 核心 View（建议部署）
- `PositionView.sol`
- `UserView.sol`
- `HealthView.sol`
- `StatisticsView.sol`
- `ViewCache.sol`
- `AccessControlView.sol`
- `BatchView.sol`
- `RegistryView.sol`
- `SystemView.sol`

### 1.2 B) 专属/扩展 View（可选）
- `DashboardView.sol`
- `PreviewView.sol`
- `RiskView.sol`
- `ValuationOracleView.sol`
- `FeeRouterView.sol`
- `LendingEngineView.sol`
- `ModuleHealthView.sol`
- `EventHistoryManager.sol`

#### 1.2.1 前端“账户全景/资产面板”建议优先启用的扩展 View
下面这些对“让前端充分展示账户情况”最关键（按优先级从高到低）：
- **`DashboardView`**：把 `PositionView + HealthView + StatisticsView (+ Price)` 拼成单次/少量 RPC 的聚合输出，适合账户首页与资产面板。
- **`CacheOptimizedView`**（虽不在 1.2 清单，但仓库已有实现）：提供常用批量查询的轻量门面（如批量仓位/批量健康因子），对前端列表页性能非常友好。
- **`RiskView`**：给出 `liquidatable / warningLevel` 等前端直用的风险标签（减少前端重复计算与阈值分歧）。
- **`PreviewView`**：前端做操作前预估（deposit/withdraw/borrow/repay 的 HF/LTV/maxBorrowable）最依赖它；并且它天然是只读门面，符合架构。
- **`ValuationOracleView`**：批量价格与健康检查（对资产估值与展示“价格是否有效/是否降级”很关键）。
- **`FeeRouterView`**：若前端要展示用户手续费/费率/VIP 折扣/支持币种等，必须启用；否则可暂缓。
- **`LendingEngineView`**：若前端需要订单/撮合/重试次数/失败费用等“订单视角”的细节页，则启用；只做基础借贷的前端可暂缓。
- **`EventHistoryManager`**：链下索引更关键；前端若要做“链上最近操作记录”可以依赖它的事件流，但通常由后端/索引服务消费再提供给前端。
- **`ModuleHealthView`**：更多是运维/监控；前端一般不需要直接展示，除非你们要在 UI 里暴露系统组件健康状态。

### 1.3 C) 清算风险补充
- `LiquidatorView.sol`
- `LiquidationRiskView.sol`

### 1.4 文档术语统一（MUST）
- 清算相关 View 的对外命名在文档与代码中保持一致（以仓库现状为准）。

---

## 2. 全局统一规范（本次改造的“工程公约”）

### 2.1 权限（ActionKeys）口径（MUST）
目标：相同敏感级别的数据，在所有 View 模块中使用一致的读权限策略；默认策略应与架构指南保持一致，避免“同类数据不同 gate”。

#### 2.1.1 权限分层（MUST，按架构指南主线落地）
- **用户私域数据（MUST）**：用户本人可读；非本人读需具备 `ACTION_VIEW_USER_DATA` 或 admin（按模块约束）。
- **风险聚合数据（MUST）**：默认使用 `ACTION_VIEW_RISK_DATA`（或更细分 liquidation 权限），适用于 `RiskView/LiquidationRiskView` 等更敏感输出。
- **健康因子只读（MUST，默认公开）**：`HealthView.getUserHealthFactor/batchGetHealthFactors` 默认保持公开只读（不强制 `ACTION_VIEW_RISK_DATA`），以服务任意前端/机器人 `eth_call`。
- **价格数据（MUST）**：统一使用 `ACTION_VIEW_PRICE_DATA`（不得与 systemData 混用）。
- **系统状态/运维数据（MUST）**：`ACTION_VIEW_SYSTEM_STATUS` / `ACTION_VIEW_SYSTEM_DATA`（区分“状态健康/运维”与“统计聚合”）。
- **写入推送权限（MUST）**：push\* 写入口必须受控（`ACTION_VIEW_PUSH` 或等效 onlyXXX），仅允许被授权业务模块/路由器/核心入口调用。
- **升级权限（MUST）**：`ACTION_ADMIN` 或 `ACTION_UPGRADE_MODULE`（与仓库既有安全标准一致）。

**验收（MUST）**：同一类数据在不同 View 中不得出现 gate 口径分叉（例如同类价格读取出现不同 ActionKey / 有的公开有的 gate）。

### 2.2 DataPush（集中常量口径，MUST）
- **MUST**：所有 push\* 写路径必须调用 `DataPushLibrary._emitData(dataTypeHash, payload)`。
- **MUST**：`dataTypeHash` 必须来自“集中常量口径”：
  - **SHOULD（推荐默认）**：统一引用 `DataPushTypes.*`；
  - **MAY（迁移期）**：合约内 `bytes32 constant DATA_TYPE_... = keccak256("UPPER_SNAKE_CASE")`，但必须保证全局不重复/不冲突；新增类型 **SHOULD** 先进入 `DataPushTypes` 再被引用。
- **MUST**：批量 push（如存在）必须遵循 `ViewConstants.MAX_BATCH_SIZE` 校验（长度不合法必须 revert 或按既定错误风格处理，且全仓口径一致）。

**验收（MUST）**：对每个 push\* 入口，能在链上观察到对应 `DataPushed`（或等效）事件；并能用 `dataTypeHash` 唯一定位其语义。

### 2.3 B 类缓存输出形态（MUST）
凡是维护缓存的模块（如 `PositionView/HealthView/StatisticsView/AccessControlView/FeeRouterView/RewardView/ViewCache`），对外读取接口必须提供：
- **有效性**：`isValid`（或明确的 `needsSync` / `validUntil` 等）
- **时间戳**：`timestamp`（或 `lastUpdateTime`）
- **可选：版本**：对并发敏感的 key（如 `(user, asset)`）提供 `version`

> 规则：Facade 类（如 `UserView/SystemView/CacheOptimizedView/DashboardView`）即使自己不存缓存，也应把下游模块的 `isValid/timestamp` 透传或组合后输出，避免丢信息。

### 2.4 推送失败与链下重试（MUST）
实现目标：对所有 best-effort push 点做到**可观测、可重放、可去重**（链下可形成稳定重试闭环）。
- **MUST**：push 失败必须发出失败事件（架构指南所述 `CacheUpdateFailed` / `HealthPushFailed` 或等效事件），payload 必须足以定位与重放，至少包含：
  - key：`user/asset/view`（或等价的唯一 key）
  - snapshot：期望写入的数据快照（用于链下对账/重放）
  - reason：失败原因 bytes（来自 revert reason/custom error 编码）
  - context：`requestId/seq/nextVersion`（若该入口支持并发幂等字段）
- **MUST**：链下监听失败事件进入重试队列；同一 key 必须去重/节流，避免并发轰击。
- **MUST NOT**：链上循环重试（避免 gas 暴涨与重复失败）。

> 注意：推送失败的发起方通常是业务模块或路由器；View 模块自身如果做外部 staticcall 组合，也要 best-effort。

### 2.5 并发/幂等（MUST）
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
- 统一 B 类缓存输出：所有缓存读取暴露 `isValid/timestamp`（必要时含 `version`），Facade 必须透传或组合后输出，避免丢失有效性信息。
- 统一“聚合门面/Facade 的 meta 透传接口”：`DashboardView` / `CacheOptimizedView` / `UserView` 等所有聚合门面**必须**提供 `*WithMeta` 版本接口，并在实现中优先调用下游专属 View 的 `*WithMeta`；若处于迁移期下游尚无该接口，允许 best-effort 回退（旧接口 + timestamp/version 拼装），但不得对外丢失或隐藏有效性信息（至少可反推出 `isValid/timestamp/(version)`）。

### Phase 2：修正职责边界（按 Architecture-Guide）
**目标（MUST）**：把“统一入口/门面”与“权威实现/缓存写入”彻底解耦，确保所有读路径对外呈现稳定、可发现、可迁移的入口。

**交付物（MUST）**
- `SystemView`：
  - **MUST**：只保留“路由/元信息/发现性 helper”（如 registry/getModule/模块枚举或等效能力）；不得维护业务缓存与业务数据存储。
  - **MUST**：对“资产/价格/奖励/清算”等请求提供可发现的跳转提示（返回目标模块地址/模块 key/路由信息），不得依赖 revert 文本作为唯一提示。
- `UserView`：
  - **MUST**：变为纯 façade：把仓位/健康/风险/奖励/统计等读取委托到专属 View（或账本只读接口）并组合输出。
  - **MUST**：对外输出不得丢失下游有效性信息（`isValid/timestamp/(version)` 必须透传或组合后输出）。
- `CacheOptimizedView` / `DashboardView`（及所有聚合门面）：
  - **MUST**：只做聚合/批量转发；不得新增任何缓存写入（不得新增 push\* 入口与任何状态写入）。

**退出条件（MUST，可验收）**
- 对外入口可发现性：
  - `SystemView` 对任意模块 key/模块名（按现有实现能力）均能返回**可用地址或可消费的路由信息**（前端/SDK 可直接用于下一跳调用）。
- 职责边界可证明：
  - `SystemView`、`UserView`、`DashboardView/CacheOptimizedView` 不存在任何“账本写入”与“业务缓存写入”（代码审阅 + 静态检查：不存在对关键缓存映射的写入/不存在 push\* 写入函数）。
- 组合输出不丢信息：
  - 任一 façade 输出若依赖下游缓存，必须包含（或可反推出）下游 `isValid/timestamp/(version)`；在脚本中可被断言（见 §5.1）。

### Phase 3：缓存可靠性与可观测性增强
**目标（MUST）**：best-effort push 的所有关键路径做到“可观测、可重放、可去重、抗并发覆盖”。

**交付物（MUST）**
- 并发/幂等：
  - **MUST**：关键缓存写入入口（至少 `PositionView`、`StatisticsView`；以及任何会在高频路径被并发推送的缓存）支持 `nextVersion` 严格并发。
  - **SHOULD**：支持 `requestId`（O(1) lastAppliedRequestId）以实现幂等重放；如启用 `seq`，必须遵循 §2.5 的一致策略。
- 推送失败：
  - **MUST**：push 失败路径发出失败事件（`CacheUpdateFailed`/`HealthPushFailed` 或等效），payload 满足 §2.4 的可重放要求。
  - **MUST**：业务交易路径不得链上循环重试；失败闭环由链下重试完成。
- offchain 聚合类 View（如清算榜单/统计类）：
  - **SHOULD**：对“链下为权威来源”的输出，接口层必须提供 staleness/版本化信息（例如 `timestamp`/`isValid`/`schemaVersion`），以便链下/前端识别新鲜度。

**退出条件（MUST，可验收）**
- 版本单调性：
  - 在脚本中对同一 key 连续 push：`version` 单调递增；错误 `nextVersion` 必须 revert；同 `requestId` 重放必须幂等（不改 version、数据不变）。
- 可观测性：
  - 每个关键 push\* 成功路径均能观察到 `DataPushed`；失败路径能观察到失败事件，并包含可用于链下重放的信息（key + snapshot + reason + context）。

> ✅ 已补齐验收用例（可直接运行/断言）：
> - `PositionView`：`test/Vault/view/PositionView.cache-validity.test.ts`（nextVersion / requestId 幂等 / seq 乱序 / DataPushed）
> - 本地脚本：`scripts/tests/phase3-positionview-acceptance.ts`（Phase 3 退出条件最小断言集）

### Phase 4：清理兼容债务与统一文档术语
**目标（MUST）**：消除“同一语义多入口/多命名/多口径”导致的集成分叉，使前端/SDK/链下索引只有一条稳定路径。

**交付物（MUST）**
- **MUST**：清理重复/冲突的 legacy getter 与过期命名；如必须保留兼容入口，需在文档中标为 deprecated 并给出替代入口（以架构指南为准）。
- **MUST**：清算相关 View 的对外命名在文档/代码/前端/脚本中完全一致（避免“同模块不同名字/同名字不同模块”）。
- **SHOULD**：把“可选增强策略”（如风险 gate）明确归档到一处（避免散落多处导致实施口径不一致）。

**退出条件（MUST，可验收）**
- 文档与实现一致：
  - `docs/Architecture-Guide.md` 与 `src/Vault/view/` 的模块命名/职责描述一致；脚本与前端配置引用同一命名体系。
- 入口收敛：
  - 对同一语义的查询/推送，仓库内不再存在多个“看起来都能用”的入口（或存在时已明确 deprecated 且有替代路径）。

---

## 4. 逐模块对齐清单（验收标准）

> 下面每一项都要能在代码中点对点对应 Architecture-Guide 的要求；缺一项视为“未对齐完成”。

### 4.1 `SystemView`
- **MUST**：仅路由/元信息门面；不缓存、不维护业务数据。
- **MUST**：提供可发现的“专属 View 地址/模块 key 引导”（不得依赖 revert string 作为唯一提示）。
- **MUST**：权限使用符合系统级数据读取的统一口径。

**验证（MUST，可验收）**
- **返回字段**：对外只读输出必须能让前端/SDK 下一跳可执行（例如返回 module address / moduleKey / registryAddr 等；按现有接口为准）。
- **事件**：不得存在 push\* 写路径与 DataPush（`SystemView` 不应是业务数据 DataPush 的发起点）。
- **脚本断言**：
  - 调用 `SystemView` 的模块解析/枚举接口，返回地址非零且与 Registry 解析一致；
  - 对“资产/价格/奖励/清算”类入口：不得依赖 revert 文本（要么返回路由信息，要么返回明确可消费的跳转信息）。

### 4.2 `PositionView`
- **MUST**：提供 `(user, asset)` 缓存读取 + `isValid/timestamp/version`。
- **MUST**：写入入口具备 `nextVersion` 严格并发；支持 `requestId/seq` 幂等/顺序（按现状实现为准，但对外接口必须一致）。
- **MUST**：在链上/链下可观测：缓存写入事件 + DataPush 一致。

**验证（MUST，可验收）**
- **返回字段**：读取接口必须包含（或可直接读到）：
  - `collateral/debt`（或等效仓位快照字段）
  - `isValid` + `timestamp` + `version`
- **事件**：
  - 成功 push 后必须出现 `DataPushed`（来自 `DataPushLibrary._emitData`），payload 能被链下解码为与写入快照一致。
- **脚本断言**：
  - 读 `currentVersion` → push(`nextVersion=current+1`) → 读回 `version` 递增、字段一致；
  - push 错误 `nextVersion` 必须 revert；
  - 重放同 `requestId` 必须幂等（不重复写、不递增 version）。

### 4.3 `HealthView`
- **MUST**：健康因子缓存读取返回 `isValid` + `timestamp`。
- **MUST**：批量接口受 `MAX_BATCH_SIZE` 限制；读权限策略按架构指南主线（默认公开只读；如要加 gate 属于 **MAY** 的增强策略）。
- **MAY**：模块健康缓存（与 `ModuleHealthView` 推送对齐）。

**验证（MUST，可验收）**
- **返回字段**：`getUserHealthFactor/batchGetHealthFactors` 返回值必须包含：
  - 健康因子数值（如 hfBps 或等效字段）
  - `isValid` + `timestamp`
- **权限**：默认读路径必须可被任意调用者 `eth_call`（不强制 `ACTION_VIEW_RISK_DATA`）。
- **事件**：成功 push 风险状态后应出现 `DataPushed`；失败则必须有失败事件（见 §2.4）。
- **脚本断言**：
  - push 更新后读取值变化、timestamp 单调推进；
  - 批量接口长度 > `MAX_BATCH_SIZE` 必须按统一错误口径失败；
  - 用无权限账号读取（默认策略下）不应 revert。

### 4.4 `StatisticsView`
- **MUST**：系统级聚合缓存对外只读（0 gas）。
- **MUST**：用户统计写入入口具备 `nextVersion`（严格）并发控制。
- **MUST**：保证金聚合/活跃用户等口径与文档一致。

**验证（MUST，可验收）**
- **返回字段**：系统级/用户级统计读取必须包含 `timestamp/lastUpdateTime`（或等效字段），并可用于判断新鲜度。
- **事件**：成功写入统计快照后应出现 `DataPushed`（类型按实现集中常量口径）。
- **脚本断言**：
  - 写入后读取聚合值变化正确，`lastUpdateTime` 单调推进；
  - 并发版本规则与 PositionView 同类断言（错误版本 revert、重放幂等如启用 requestId）。

### 4.5 `ViewCache`
- **MUST**：仅系统级快照缓存；读返回 `isValid/timestamp`。
- **MUST**：写入口权限为系统级推送/管理员（按统一口径）。
- **MUST**：DataPush 遵循“集中常量口径”（推荐 `DataPushTypes`；迁移期允许合约内 keccak 常量，但必须全局无重复/无冲突）。

**验证（MUST，可验收）**
- **返回字段**：系统快照读取必须包含 `isValid/timestamp`（或等效 staleness 表达）。
- **权限**：写入口必须被 gate（系统级推送权限/管理员）；无权限写入必须 revert。
- **事件**：成功写入后应出现 `DataPushed`（可被链下消费/索引）。
- **脚本断言**：
  - 无权限账号调用写入口 revert；
  - 有权限写入后 `isValid=true` 且 timestamp 更新。

### 4.6 `AccessControlView`
- **MUST**：只缓存权限位/权限级别；读返回 `isValid/timestamp`（或至少 isValid）。
- **MUST**：DataPush type 遵循“集中常量口径”（推荐 `DataPushTypes`；迁移期允许合约内 keccak 常量，但必须全局无重复/无冲突）。

**验证（MUST，可验收）**
- **返回字段**：权限读取必须包含缓存有效性信息（`isValid/timestamp` 或等效）。
- **事件**：权限更新 push 后必须出现 `DataPushed`（权限位/权限级别各自的 type）。
- **脚本断言**：
  - push 后立即可读，且 `isValid` 正确；
  - 过期后 `isValid` 变为 false（按缓存窗口/实现逻辑）。

### 4.7 `UserView`（重点）
- **MUST**：纯 façade：把仓位、健康、风险、奖励、统计等委托到专属 View。
- **MUST**：不得存在“asset=0 代表总量”的占位实现；总量/估值必须调用权威接口或返回明确的“不可用 + 原因”。
- **MUST**：对外接口要透传下游的 `isValid/timestamp`，避免丢失缓存有效性信息。

**验证（MUST，可验收）**
- **返回字段**：聚合输出必须同时包含业务数据与其有效性信息（至少 `isValid/timestamp`，并发敏感场景含 `version`）。
- **职责边界**：不得在 `UserView` 内新增任何业务缓存写入与 push\* 写入口。
- **脚本断言**：
  - 通过 `UserView` 获取的聚合结果与下游专属 View 读取结果一致（数值一致、有效性信息一致或可解释地组合一致）。

### 4.8 `ValuationOracleView`（重点：权限一致性）
- **MUST**：价格读取权限必须与 `BatchView` 等模块对齐（统一 `ACTION_VIEW_PRICE_DATA` 或架构指南明确的 price 权限）。
- **MUST**：批量价格接口限制 `MAX_BATCH_SIZE`，并在失败时 best-effort 返回默认值（按现状可保留）。

**验证（MUST，可验收）**
- **权限**：无 `ACTION_VIEW_PRICE_DATA` 的调用者读取价格必须 revert（若该模块按 gate 策略实现）；同类价格读取在其它 View 中不得出现不同 ActionKey。
- **批量限制**：超限必须按统一错误口径失败；失败路径 best-effort 行为必须可被脚本覆盖（按现状定义）。
- **脚本断言**：
  - 同一资产价格在 `ValuationOracleView` 与批量聚合入口（如 `BatchView`）的权限 gate 与返回语义一致。

### 4.9 `FeeRouterView`
- **MUST**：push 入口只允许 FeeRouter（Registry SSOT）。
- **MUST**：读接口提供 staleness/有效性信息（至少基于 `_lastSyncTimestamp` + `SYNC_INTERVAL` 给出 `isValid/needsSync` 或 timestamp）。
- **MUST**：DataPush type 遵循“集中常量口径”（推荐 `DataPushTypes`；迁移期允许合约内 keccak 常量，但必须全局无重复/无冲突）。

**验证（MUST，可验收）**
- **权限**：非 FeeRouter 地址调用 push 必须 revert；FeeRouter 调用成功后可读快照更新。
- **返回字段**：读取必须包含 staleness/有效性表达（`timestamp/isValid/needsSync` 等，按实现为准）。
- **事件**：成功 push 后应出现 `DataPushed`。
- **脚本断言**：
  - 用非 FeeRouter 地址 push revert；
  - push 后读取到的新 timestamp 与 staleness 逻辑一致。

### 4.10 `LiquidatorView` `
- **MUST**：只读 + DataPush 单点推送（清算事件/赔付/榜单等以链下聚合为主）。
- **MUST**：权限口径（清算数据 vs 风险数据 vs 用户私域）统一，不得混用。

**验证（MUST，可验收）**
- **单点推送**：清算相关 DataPush 必须由单一权威入口发起（按架构指南：由 `LiquidatorView.push*` 单点触发），避免多点重复发事件。
- **返回字段**：若存在链下权威聚合输出，应提供 staleness/版本信息以识别新鲜度。
- **脚本断言**：
  - 通过清算写路径触发后，观察到 `LiquidatorView.push*` 的 DataPush 事件；
  - 不同清算/风控输出的读权限与 ActionKey 使用一致（不得混用 system/price/user/risk）。

### 4.11 `BatchView` / `CacheOptimizedView` / `DashboardView`
- **MUST**：只做聚合/批量转发，不引入缓存写入。
- **MUST**：统一 batch 限制与错误类型；权限口径与各专属 view 一致。

**验证（MUST，可验收）**
- **职责边界**：不得存在任何 push\* 写入口与状态写入（代码审阅 + 静态检查）。
- **批量限制**：所有批量入口必须校验 `MAX_BATCH_SIZE`；超限失败口径在全仓一致。
- **权限一致性**：聚合/批量入口不得绕过下游权限；同类数据读取使用同一 ActionKey。
- **脚本断言**：
  - 批量长度超限时一致失败；
  - 对同一数据，批量入口与专属 View 的返回与权限行为一致。

### 4.12 `LendingEngineView`
- **MUST**：只读；不得存在任何 push\* 写入口与业务状态写入（除 UUPS/initializer）。
- **MUST**：订单/用户私域查询必须遵循“用户私域权限口径”（不允许把订单细节/失败费用/重试次数等暴露给任意 caller）。
- **MUST**：运维/系统级诊断查询必须遵循系统权限口径（如 `ACTION_VIEW_SYSTEM_DATA` 或 admin）。
- **MUST**：失败口径统一：无权限访问必须 `revert MissingRole()`（避免 revert string/自定义 Unauthorized 分叉）。

**验证（MUST，可验收）**
- **职责边界**：ABI 中不存在 `push*`；除 `initialize/upgradeTo*` 外无非 `view/pure` 外部函数。
- **权限**：
  - `getLoanOrder(orderId)`：仅订单相关方（borrower/lender）可读；或 ops/admin（具备 `VIEW_USER_DATA` 或 admin）可读；否则 `MissingRole()`
  - `getUserLoanCount(user)` / `canAccessLoanOrder(orderId,user)`：仅 `user` 本人或 ops/admin 可读，否则 `MissingRole()`
  - `getFailedFeeAmount(orderId)` / `getNftRetryCount(orderId)` / `isMatchEngine(account)` / `getRegistryFromEngine()`：仅 ops/admin 可读，否则 `MissingRole()`
- **脚本断言**：
  - 用 `unauthorized` 调用上述接口全部 revert 且 selector 为 `MissingRole()`
  - `borrower` 能读取自身订单；`outsider` 不能读取（除非授予 ops 角色）

### 4.13 `PreviewView`
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

### 4.14 `RewardView`
- **MUST**：作为 Reward 系统对外的只读聚合与缓存加速层，外部消费者（前端/索引/机器人）应仅依赖 `RewardView` 的只读接口，不应直接调用 `RewardManagerCore/RewardCore` 的查询接口（除“协议内硬约束校验”入口外）。
- **MUST**：写入口（`push*`）必须严格白名单（writer allowlist），仅允许架构指南指定的写入方（当前口径：`RewardManagerCore` / `RewardConsumption`）调用。
- **MUST**：所有写入口必须触发统一 DataPush：`DataPushLibrary._emitData(...)`，`dataTypeHash` 使用集中常量口径（推荐 `DataPushTypes`）。
- **MUST**：作为 B 类缓存模块，对外读取必须返回缓存有效性信息：至少 `isValid` + `timestamp`（并发敏感时附带 `version`）。不得仅返回业务字段而缺失有效性元信息（Facade 也不得丢失）。
- **MUST**：对外权限策略必须遵循“用户私域口径”：用户本人可读；非本人读需具备 `ACTION_VIEW_USER_DATA` 或 admin，失败必须 `MissingRole()`（不得 revert string / 自定义 Unauthorized 分叉）。
- **MUST**：分区注释与 NatSpec 需对齐架构指南模板（`@dev Reverts if:` / `Security:` / 单位说明），并采用统一分区分隔符（禁止 `/* ============ */` / `// ============` 风格）。

**验证（MUST，可验收）**
- **写入口权限**：
  - 非 writer（既不是 `RewardManagerCore` 也不是 `RewardConsumption`）调用任意 `push*` 必须 revert（推荐 `RewardView__UnauthorizedWriter()` 或等效）。
- **DataPush 可观测性**：
  - 任意一次成功 `pushRewardEarned/pushPointsBurned/pushPenaltyLedger/pushUserLevel/pushUserPrivilege/pushSystemStats`，必须能观察到对应的 `DataPushed` 事件，且 `dataTypeHash` 与架构指南/常量表一致。
- **B 类缓存有效性输出**：
  - `getUserRewardSummary`（或等效对外主查询）返回值必须包含 `isValid/timestamp`（至少可判断新鲜度/是否需要链下重试），并在脚本中可被断言。
- **读权限**：
  - `unauthorized` 查询非本人 `RewardView` 私域数据必须 `MissingRole()`；
  - `user` 查询自身数据必须成功。

### 4.15 `ModuleHealthView`
- **MUST**：定位为“运维/监控扩展 View”，只做轻量检查 + 缓存 + 推送，不得承担账本写入或业务缓存权威写入。
- **MUST**：对外权限口径属于系统状态/运维数据：读取与触发检查必须使用 `ACTION_VIEW_SYSTEM_STATUS`（或 admin），失败必须 `MissingRole()`。
- **MUST**：检查/推送路径必须触发统一 DataPush：`DataPushLibrary._emitData(...)`，`dataTypeHash` 使用集中常量口径（推荐 `DataPushTypes`）。
- **MUST**：作为缓存模块（B 类缓存/运维缓存），对外读取必须返回缓存有效性信息：至少 `isValid` + `timestamp`（并明确有效期口径，例如 TTL/窗口），不得仅返回“最后检查时间”而缺失有效性判断。
- **MUST**：批量接口（若存在/将来新增）必须遵循 `ViewConstants.MAX_BATCH_SIZE` 并采用统一错误口径。
- **MUST**：分区注释与 NatSpec 需对齐架构指南模板，并采用统一分区分隔符（禁止 `/* ============ */` / `// ============` 风格）。

**验证（MUST，可验收）**
- **权限**：
  - `unauthorized` 调用 `checkAndPushModuleHealth` / `getModuleHealthStatus` / `checkModuleHealth`（按实现）必须 `MissingRole()`；
  - `operator`（具备 `ACTION_VIEW_SYSTEM_STATUS`）调用必须成功。
- **DataPush 可观测性**：
  - 成功执行一次检查/推送后，必须能观察到对应 `DataPushed`（且 `dataTypeHash` 语义可唯一定位为“MODULE_HEALTH_*”或等效类型）。
- **缓存有效性**：
  - 读取模块健康缓存必须返回 `timestamp` 与 `isValid`（或等效 staleness 表达），并可在脚本中断言其随推送单调更新。

### 4.16 `EventHistoryManager`
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
- 所有 B 类缓存都暴露 `isValid/timestamp`（Facade 不丢信息）。
- 统一 DataPush：所有 push\* 写路径调用 `DataPushLibrary._emitData(...)`，且 `dataTypeHash` 遵循“集中常量口径”（推荐 `DataPushTypes`；迁移期允许合约内 keccak 常量但必须全局无重复/无冲突）。
- 关键缓存具备并发/幂等（至少 Position/Stats 级别）。
- SystemView 从“硬失败提示”转为“路由/引导”方式（可被前端/SDK 直接消费）。
- 批量错误口径统一：所有批量入口超限必须 `revert BatchTooLarge(length,max)`；空数组必须 `revert EmptyArray()`（全仓一致）。
- 无权限失败口径统一：对外的权限校验失败应统一 `revert MissingRole()`（避免 revert string/各模块自定义 Unauthorized 分叉）。
- 本临时文档删除：`src/Vault/view/ARCH-VIEW-ALIGNMENT-WORKGUIDE.md`。

### 5.1 测试与验收（本地链模拟，参考 `scripts/tests` 与 `scripts/e2e`）
目标：在**本地链**上用“真实交易 + 推送/事件/批量查询”把 View 系统的关键承诺全部跑通，确保改造不是“代码看起来对齐”，而是行为对齐。

#### 5.1.1 通用前置条件（Checklist）
- **环境（MUST）**
  - 本地开发链已部署最新合约（以仓库现有脚本为准），Registry/模块键已正确注册到目标 View 合约地址。
  - 准备至少 3 类测试账户：`admin`（具备管理员/升级/推送能力）、`operator`（具备必要的 push 权限或被授权模块身份）、`user`（普通用户）；另备 `unauthorized`（无任何权限）。
  - 能从交易回执中抓取事件并断言：
    - `DataPushed`（由 `DataPushLibrary._emitData(...)` 发出）
    - 失败事件（`CacheUpdateFailed` / `HealthPushFailed` 或等效事件）
- **常量（MUST）**
  - 批量接口统一以 `ViewConstants.MAX_BATCH_SIZE` 作为上限（超限行为口径一致）。

#### 5.1.2 测试用例矩阵（与 §4.x 一一对应）
说明：本矩阵用于 `scripts/tests/*` 的冒烟/断言层；每个用例都必须能在本地链复现并自动断言。

##### 4.1 `SystemView`（测试矩阵）
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| SV-01 路由/发现性（route\*，SSOT=Registry） | Registry 已注册各 View 模块；caller 具备 `VIEW_SYSTEM_DATA` | 调用 `routeStatistics/routeReward/routeLiquidation/routeRisk/routeUser/routePosition/routeBatch/routeDashboard/routePreview` 以及 `routePrice()` | 无 `DataPushed` | `RouteInfo(moduleKey,moduleAddr)`；`routePrice` 返回 `RouteHint(primaryRoute,fallbackRoute)` | `moduleKey == keccak256("...")` 且 `moduleAddr == Registry.getModuleOrRevert(moduleKey)`；地址非零；`getVersionInfo()` 可读用于定位实现 |
| SV-02 权限 gate（统一 MissingRole） | `unauthorized` 不具备 `VIEW_SYSTEM_DATA` | `unauthorized` 调用任一 `route*()` / `getModuleOptional(bytes32)` | 无 | N/A | 必须 `revert MissingRole()`（断言 selector，不依赖 revert string） |
| SV-03 模块查询 API（getModule/getNamedModule） | 同 SV-01 | 调用 `getModule(bytes32)` / `getModuleOptional(bytes32)`；调用 `getNamedModule(string)` / `getNamedModuleOptional(string)` | 无 | 返回 module address | `getModuleOptional` 未注册返回 `0x0`；`getModule` 未注册 revert；`getNamedModule` 支持标准映射（`ModuleKeys.getModuleKeyFromString`）+ legacy `keccak256(name)` fallback |
| SV-04 Deprecated getters（允许 revert，但禁止作为集成路径） | 无 | 调用 `getAssetPrice/getTotalCollateral/getTotalDebt/getRewardSystemView/getGuaranteeSystemView` | 无 | N/A | 允许 revert（兼容债务）；但必须证明 route\* API 可用，且脚本/前端/SDK 不依赖 revert 文本做集成 |
| SV-05 无业务写入职责边界（静态合规） | 无 | 对 ABI/源代码做静态检查 | 无 | N/A | 除 `initialize/upgrade` 外不应存在非 `view/pure` 的 external/public；不得出现 `push*` 写入口 |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-systemview-routing.ts --network localhost`
- 该脚本会先执行统一 `runViewPreflight(...)`（SystemView routes ↔ Registry 对齐 + VersionInfo 可观测），再覆盖本矩阵的 `MissingRole()` 断言与 route\* 对齐断言。

##### 4.2 `PositionView`（测试矩阵）
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| PV-01 读取快照与有效性（推荐 Meta API） | caller 具备 `VIEW_USER_DATA`；准备 `(user,asset)` | 调用 `getUserPositionWithMeta(user, asset)`（兼容：`getUserPositionWithValidity`） | 无（仅读） | `collateral/debt/isValid/timestamp/version` | 字段齐全；`timestamp` 为该 `(user,asset)` 最近一次写入缓存的时间；`version` 可读 |
| PV-02 严格并发 nextVersion（CAS） | caller 是业务模块（`VaultRouter/CM/LE/...`）且具备 `ACTION_VIEW_PUSH`；可读 currentVersion | `v0 = getPositionVersion(user,asset)` → 调用 `pushUserPositionUpdate(user,asset,collateral,debt,requestId,seq,nextVersion=v0+1)` → 再读 meta | 必须 `DataPushed(DATA_TYPE_USER_POSITION_UPDATE, payload)` | 同 PV-01 | `version == v0+1`；payload 可 ABI 解码为 `(user,asset,collateral,debt)` 且与写入一致 |
| PV-03 错误版本必须失败 | 同 PV-02 | 使用错误 `nextVersion`（例如 `nextVersion=currentVersion` 且 `requestId` 不同）调用 push | 无成功 `DataPushed` | N/A | 必须 `revert PositionView__StaleVersion(uint64,uint64)`（脚本断言 selector，不依赖 revert string）；不得静默覆盖 |
| PV-04 幂等重放 requestId（version-bound, O(1)） | 同 PV-02 | 成功 push 后，重放同一笔：`requestId` 不变，`nextVersion==currentVersion`，payload 相同（`seq` 可任意） | 必须 emit `IdempotentRequestIgnored`；不得 emit `DataPushed` | 同 PV-01 | `version` 不变；数据不变；无重复写入副作用 |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-positionview-acceptance.ts --network localhost`
- 覆盖：`MissingRole()` 读 gate、`nextVersion` 并发、`requestId` 幂等、`seq` 顺序、`DataPushed(DATA_TYPE_USER_POSITION_UPDATE)` payload 解码、以及 `(user,asset)` 有效性独立性（TTL=5m）。

##### 4.3 `HealthView`（测试矩阵）
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| HV-01 只读查询（risk gate + meta 输出） | caller 具备 `VIEW_RISK_DATA`；另备 `unauthorized`（无该角色） | `getUserHealthFactor(user)` / `getUserHealthFactorWithMeta(user)` / `batchGetHealthFactors(users)` | 无（仅读） | `(healthFactor,isValid,timestamp)`；batch 返回数组 | 无权限必须 `revert MissingRole()`；有权限时：未缓存返回 `(0,false,0)`；`WithMeta` 必须与 canonical 输出一致 |
| HV-02 push 更新后可读（writer=ACTION_VIEW_PUSH） | `VaultRouter`（或 keeper）具备 `ACTION_VIEW_PUSH`；caller 具备 `VIEW_RISK_DATA` | `pushRiskStatus(user,hf,minHF,flag,ts)`（或 batch）→ 再读 | 必须 `DataPushed(DATA_TYPE_RISK_STATUS, payload)` | 同 HV-01 | push 后 `healthFactor` 更新、`timestamp` 单调（ts=0 时归一为 block.timestamp）；payload 可 ABI 解码为 `(user,hf,minHF,flag,ts)` |
| HV-03 批量边界（统一错误口径） | 有 users 数组 | 调用 `batchGetHealthFactors(users)`：空数组 / 长度 `MAX_BATCH_SIZE+1` | 无 | N/A | 空数组必须 `revert EmptyArray()`；超限必须 `revert BatchTooLarge(len,max)`（脚本断言 selector，不依赖 revert string） |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-healthview-acceptance.ts --network localhost`
- 覆盖：读侧 `MissingRole()` gate、push 写入 `MissingRole()` gate、`DataPushed(DATA_TYPE_RISK_STATUS/_BATCH)` payload 解码、`EmptyArray/BatchTooLarge` 统一错误口径、TTL 过期行为（CACHE_DURATION=5m）。

##### 4.4 `StatisticsView`（测试矩阵）
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| ST-01 系统聚合只读（含 meta） | 无 | `getGlobalStatistics()` / `getGlobalStatisticsWithMeta()` | 无（仅读） | `GlobalStatistics{totalUsers,activeUsers,totalCollateral,totalDebt,lastUpdateTime}` + `(isValid,timestamp)` | 字段齐全；`lastUpdateTime == meta.timestamp`；无需权限 gate |
| ST-02 推送后单调推进（user stats） | caller 具备 `ACTION_ADMIN` 或 `VIEW_SYSTEM_DATA` | `pushUserStatsUpdate(user,collIn,collOut,borrow,repay,requestId,seq,nextVersion)` → 再读 `getGlobalStatistics()` | 必须 `DataPushed(DATA_TYPE_USER_STATS_UPDATE, payload)` | 同 ST-01 | 总量按增量变化；`lastUpdateTime` 单调；payload 可 ABI 解码并匹配 `(user,version,requestId,seq,UserSnapshot,GlobalSnapshot)` |
| ST-03 并发/幂等（nextVersion + requestId + seq） | 写入口支持 `nextVersion/requestId/seq` | 错误 `nextVersion`、同 `requestId` 重放、乱序 `seq` | `IdempotentRequestIgnored`（重放） | 同 ST-01 | 错误版本必须 `revert StatisticsView__StaleUserStatsVersion(uint64,uint64)`；重放不得 emit `DataPushed` 且版本不变；乱序必须 `revert StatisticsView__OutOfOrderSeq(uint64,uint64)` |

**自动化脚本（推荐，可直接验收）**
- `pnpm -s hardhat run scripts/e2e/e2e-localhost-statisticsview-acceptance.ts --network localhost`
- 覆盖：ST-01~ST-03（含 `DataPushed(DATA_TYPE_USER_STATS_UPDATE)` 解码、`nextVersion` 并发、`requestId` 幂等、`seq` 顺序）。

##### 4.5 `ViewCache`（测试矩阵）
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| VC-01 读返回 staleness | 无 | 调用系统快照读取接口（按实现） | 无（仅读） | `isValid/timestamp`（或等效） | 字段齐全；`timestamp` 合理 |
| VC-02 写入口权限 | `unauthorized` 无权限 | 用 `unauthorized` 调用写入口（按实现） | 无 | N/A | 必须 revert |
| VC-03 写入后可观测 | `admin/operator` 有权限 | 写入 → 读取 | `DataPushed` | 同 VC-01 | `isValid=true`；timestamp 更新；事件可观测 |

##### 4.6 `AccessControlView`（测试矩阵）
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| ACV-01 push 后立即可读 | 有权限更新来源 | push 权限位/等级（按实现）→ 读取 | `DataPushed` | 权限值 + `isValid/timestamp`（或等效） | push 后读到新值；`isValid` 正确 |
| ACV-02 过期行为（如有） | 缓存有过期窗口 | 推进时间跨过 `CACHE_DURATION`（按测试工具能力）→ 读取 | 无（仅读） | 同 ACV-01 | 过期后 `isValid=false`（或等效 staleness） |

##### 4.7 `UserView`（测试矩阵）
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| UV-01 façade 不丢有效性 | 下游 View 已有数据 | 调用 `UserView` 聚合读取接口（按实现） | 无（仅读） | 业务数据 + 下游 `isValid/timestamp/(version)` 的透传/组合 | `UserView` 输出与下游一致或可解释地组合一致；有效性信息不丢 |
| UV-02 无业务写入 | 无 | 扫描/调用 `UserView` 入口（按实现） | 无 `DataPushed` | N/A | `UserView` 不存在 push\* 写入口/状态写入（代码审阅 + 静态检查） |

##### 4.8 `ValuationOracleView`（测试矩阵）
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| VOV-01 价格读权限一致性 | `unauthorized` 无 price 权限（若该模块 gate） | `unauthorized` 调用价格读取接口（按实现） | 无 | N/A | 必须 revert（与 `BatchView` 等同类入口一致） |
| VOV-02 批量上限 | assets 数组 | 调用批量价格接口，长度 > `MAX_BATCH_SIZE` | 无 | N/A | 必须按统一口径失败 |
| VOV-03 best-effort 行为（如实现） | 预言机可模拟失败 | 触发失败路径（按现状可保留） | 可能有事件（按实现） | 允许默认值/降级输出（按实现） | 行为与实现约定一致且可脚本断言 |

##### 4.9 `FeeRouterView`（测试矩阵）
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| FRV-01 push 权限（仅 FeeRouter） | `unauthorized` 非 FeeRouter | `unauthorized` 调用 push 入口 | 无 | N/A | 必须 revert |
| FRV-02 staleness 输出 | FeeRouter 可 push | FeeRouter push → 读取 | `DataPushed` | `timestamp/isValid/needsSync`（按实现） | staleness 逻辑一致；timestamp 单调推进 |

##### 4.10 `LiquidatorView` / `LiquidationRiskView`（测试矩阵）
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| LQ-01 单点 DataPush | 清算写路径可触发 | 触发清算流程（按仓库现有脚本/测试骨架） | 观察到由 `LiquidatorView.push*` 发出的 `DataPushed` | 输出如含聚合应带 staleness/版本（按实现） | DataPush 发起点唯一（不得多点重复发）；权限口径不混用 |

##### 4.11 `BatchView` / `CacheOptimizedView` / `DashboardView`（测试矩阵）
| 用例 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| BV-01 职责边界（无写入） | 无 | 调用聚合/批量读取接口（按实现） | 无 `DataPushed` | 聚合输出（按实现） | 不存在 push\* 写入口/状态写入（代码审阅 + 静态检查） |
| BV-02 批量上限一致 | 准备批量参数 | 调用任一批量入口，长度 > `MAX_BATCH_SIZE` | 无 | N/A | 必须按统一口径失败 |
| BV-03 权限一致性 | 有下游需 gate 的数据 | 用 `unauthorized` 调用批量入口读取该类数据 | 无 | N/A | 不得绕过下游 gate；行为与专属 View 一致 |

#### 5.1.3 e2e 场景矩阵（覆盖多模块联动）
| 场景 | 前置条件 | 操作 | 期望事件 | 期望返回字段 | 断言 |
|---|---|---|---|---|---|
| E2E-01 多用户资金流回放 | N 用户、资产配置完成 | deposit/borrow/repay/withdraw 交错执行；每步后用 `DashboardView/CacheOptimizedView/BatchView` 批量拉取 | `DataPushed` 连续可观测 | Position/Health/Stats 的有效性字段齐全 | 每步数据一致；有效性信息不丢；批量接口稳定 |
| E2E-02 推送失败模拟与链下重试 | 可制造 view 地址缺失/推送失败 | 故意触发 push 失败 → 监听失败事件 → 链下重试 push | 失败事件 + 重试成功的 `DataPushed` | 重试后 `isValid=true`、timestamp 更新 | 失败可观测且可重放；无链上循环重试 |
| E2E-03 批量边界与性能 | 可生成大数组 | 接近 `MAX_BATCH_SIZE` 的批量调用 + 超限调用 | 成功/失败事件口径一致 | 返回稳定 | 不 OOG；超限一致失败 |

#### 5.1.4 验收证据（Artifacts，MUST）
每次验收运行必须输出/保存（脚本日志或文件均可）：
- 模块地址快照（Registry keys → addr）
- 关键 View 的 `getVersionInfo()`（api/schema/implementation）
- `DataPushed` 按 `dataTypeHash` 的计数统计（推荐以 `DataPushTypes` 作为统计口径）
- 失败事件计数与重试成功率（若启用失败模拟）


# 平台监控体系实施指南（Protocol / View / Reward / Liquidation）

> 目标：把“资金安全 + 清算链路 + View/Stats 一致性 + Reward/EasyToken + DataPush 事件完整性 + RPC/索引器稳定性”变成**可量化、可告警、可追溯、可演练**的线上监控硬闸。
>
> 本文是**可执行落地版**：你可以按步骤逐项实施，并在 Grafana/Prometheus/Alertmanager/Loki/Tempo（OTel）上得到可用结果。

## 相关文档（建议先读一遍）

- [scripts/e2e/README.md](../../scripts/e2e/README.md)：Release Gate、严格模式、常见坑位与排障口径
- [docs/Usage-Guide/Frontend-Modification-Guide.md](Frontend-Modification-Guide.md)：前端 View/Registry 对齐、meta 降级展示约束
- [docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md](SaaS-Backend-Implementation-Guide.md)：幂等、对账、指标清单与后台作业模型
- [docs/Usage-Guide/Funds-Flow-Architecture-Guide.md](Funds-Flow-Architecture-Guide.md)：资金链 SSOT（托管者/唯一入口/费用路由/清算/保证金扩展流）
- [docs/Usage-Guide/WhitelistSystem.md](WhitelistSystem.md)：白名单实现、测试网上线执行清单、人工验收 checklist

---

## 0. 范围与权威边界（SSOT）

### 0.1 SSOT 分层（必须统一）

- **链上 SSOT（权威）**：
  - 资金与仓位：`CollateralManager` / `VaultLendingEngine` / `SettlementManager`
  - 清算：`LiquidationManager` / `LiquidationRiskManager`
  - Reward：`IERC20(Registry[KEY_EASY_TOKEN]).balanceOf(user)`、`RewardManagerCore`、`RewardAccrualManager`（通过 `RewardView` 读取）
  - DataPush：`RewardView.DataPushed`、`CollateralManager.DataPushed` 等事件流
  - AI Credits：`AICreditsVault.creditsBalance(tenantId, user)`

- **链下（派生/镜像/加速层）**：
  - 索引器（Ponder）：链上事件 → DB 镜像（不可逆写）
  - SaaS 后端：幂等、复式账本、AI 高频扣次、对账与审计（链上为准）

> 关键原则：任何“余额/总量/等级/欠分”类口径对不齐时，**链上为准**；链下只负责暴露“差异、延迟、缺失”的监控信号与自动修复入口。

### 0.2 监控分级（P0/P1）

- **P0（资金安全级）**：必须告警、必须值班响应（分钟级）
  - 清算链路不可用/大面积 revert
  - Oracle stale/fallback（导致估值/健康度口径不可信）
  - View invalid / selector mismatch / 路由错位
  - Reward/EasyToken 铸币/扣费异常或对账差异超阈值
  - RPC 不可用、索引器明显落后

- **P1（稳定性/一致性级）**：告警但可工作时段处理（小时级）
  - 索引 lag 轻微增大
  - 对账轻微差异
  - 幂等命中率异常偏高（可能是重试风暴）

---

## 1. 你已经有的“强信号”（来自 Release Gate 与 E2E 日志）

本仓库的 Release Gate 与 `scripts/e2e/logs/**` 已经固化了大量真实故障模式：

### 1.1 Fork/RPC 崩溃 → 级联故障

典型表现：
- 上游 RPC `missing trie node`（`eth_getStorageAt` 带 blockNumber）会导致 Hardhat fork 节点直接崩溃；后续 E2E 大面积 `ECONNREFUSED`。
- Hardhat/EDR 的 HH604（storage overrides）会导致 fork node 启动失败。
- `UND_ERR_HEADERS_TIMEOUT` / `HeadersTimeoutError` 常见于 fork/RPC 响应变慢或节点假死。

监控意义：这不是“业务失败”，而是**基础设施失败**，必须在业务层错误出现之前就告警。

### 1.2 Oracle stale/fallback 会制造 100x 误导

已知规律：大幅 time-travel 后 oracle stale → graceful fallback → totals 口径被误当作 USD-8，出现 ~100x 缩小。

监控意义：必须监控“价格是否有效/是否过期”（例如 `PriceOracle.isPriceValid` + `age/maxAge`），并要求前端/后端对降级状态显式展示与降级策略。

### 1.3 Reward/DataPush：同 tx 内可能多条 push

监控意义：事件完整性校验要以“同 tx 最后一条 push”代表最终状态；诊断时要先 dump 同 tx 全量 push。

---

## 2. 可观测性技术栈与落地形态（推荐）

推荐统一 Observability Stack：

- **Prometheus**：指标采集与告警表达式
- **Alertmanager**：告警路由（Slack/Email/飞书等）
- **Grafana**：看板与告警可视化
- **Loki + Promtail**：结构化日志检索
- **Tempo + OpenTelemetry（OTel）**：分布式追踪（前端→后端→RPC→DB→索引器）

> 注：如需云厂商托管，可在此基础上增加 CloudWatch 镜像，但不要只依赖 CloudWatch 作为主监控。

---

## 3. 统一命名与关联键（必须先定）

### 3.1 统一标签（Prometheus）

所有服务暴露的指标必须带这些最少标签（可通过 relabel 自动补齐）：

- `environment`：`prod|staging|dev`
- `service`：如 `lending-backend|lending-frontend|ponder-indexer|view-sentinel`
- `component`：`backend|frontend|indexer|canary`
- `chain_id`：`42161|421614`（Arbitrum/Arbitrum Sepolia）
- `network`：`arbitrum|arbitrumSepolia`
- `tenant`：多租户隔离维度（至少后端必须有）

### 3.2 统一关联键（Logs/Traces）

日志必须包含（JSON 字段名建议如下）：

- `traceId`：链路追踪主键（OTel Trace ID）
- `requestId`：HTTP 请求级 ID（可与 traceId 相同或派生）
- `idempotencyKey`：幂等 key（跨服务透传）
- `chainId` / `txHash` / `logIndex`
- `user`（地址）/ `orderId` / `asset`

这样你就能实现：**从告警 → 指标 → 日志 → Trace → 对应链上 txHash/事件** 一跳定位。

---

## 4. 必须实施的监控域（按系统分层）

### 4.1 基础设施与 RPC（P0）

**要监控什么**

1) RPC 失败率与错误码（尤其是 `-32000 missing trie node`）
2) RPC 延迟 p95/p99（按 method 分维度）
3) fork-node / 本地节点进程是否存活、是否频繁重启

**建议指标（示例命名）**

- `rpc_requests_total{rpc,method,outcome}`
- `rpc_errors_total{rpc,method,code}`
- `rpc_latency_ms_bucket{rpc,method}`
- `rpc_last_success_timestamp{rpc}`

**告警建议**

- `RpcHardDown`：5 分钟内无成功请求（critical）
- `RpcMissingTrieNode`：`rpc_errors_total{code="-32000"}` 上升（warning→critical）
- `RpcLatencyP99High`：p99 > 阈值（warning）

### 4.2 Oracle（价格）与估值可靠性（P0）

**要监控什么**

- 按资产的“价格是否有效”（不 revert 的健康检查）与“距离过期还有多少 blocks”
- keeper 是否持续在写入价格（PriceUpdated 事件/写入事务是否失败）
- 清算前刷新（stale-price keeper）是否在业务窗口内稳定成功（这个环节失败频率通常最高）
- 冷启 / 刚部署后的短窗口“oracle warming 动态”（首次刷价前可能 `valid=false price=0 block=0`）是否能快速收敛
- 链下 publish status 是否与链上 `PriceUpdated` 事实一致

**来自本次 core-e2e 日志的已验证现象**

- 在脚本刚启动时会出现 `price=0 block=0 valid=false`，直到完成 `configureAsset + updatePrice` 后才进入可用状态。

结论：线上不能把“刚部署/刚启动 keeper 尚未首刷”的短窗口直接当作事故；但一旦超过预期窗口仍未首刷，就必须升格为 P0。

**链上口径（必须以合约为准）**

- `PriceOracle.isPriceValid(asset) -> bool`：不 revert 的健康检查；任何未知/异常状态均返回 `false`
- `PriceOracle.getPriceUpdateBlock(asset)`：最后一次写入发生的链上 block（用于计算 staleness）
- `PriceOracle.getAssetConfig(asset).maxPriceAgeBlocks`：每个资产允许的最大过期 blocks

> 说明：`IPriceOracleRead.getPrice(asset)` 对应的严格读路径会在 stale/invalid 时 revert；线上监控更推荐用 `isPriceValid` 做 canary，因为它不回滚、可批量、可持续轮询。

**建议指标**

- `oracle_price_valid{asset}`（0/1；来自 `isPriceValid`）
- `oracle_price_age_blocks{asset}`（`headBlock - getPriceUpdateBlock(asset)`）
- `oracle_max_price_age_blocks{asset}`（来自 `getAssetConfig(asset).maxPriceAgeBlocks`）
- `oracle_price_age_ratio{asset}`（`age/maxAge`，用于统一阈值）
- `oracle_price_updates_total{asset,outcome}`（outcome: `ok|reverted`；ok 来自 `PriceUpdated` 事件，reverted 来自 keeper 事务失败日志/指标）
- `oracle_publish_status{asset,status}`（status: `ok|missing|lagging|reverted`；来自链下发布作业）
- `oracle_publish_lag_seconds{asset}`（链下最新成功 publish 距当前的延迟）

**建议新增：oracle warming 指标（部署窗口抑制 + 持续异常升级）**

- `oracle_is_warming{asset}`（0/1；建议逻辑：`oracle_price_valid==0` 且距离 `view_sentinel_start_time_seconds` 在 warming 窗口内）
- `oracle_warming_consecutive_scans{asset}`（gauge；连续多少次扫描都 `oracle_price_valid==0`）
- `oracle_last_update_timestamp_seconds{asset}`（最后一次观测到 updateBlock 变化的时间戳；用于 KeeperRefreshDown）

**清算前刷新（stale-price keeper）专用指标（强烈建议）**

- `keeper_price_refresh_attempts_total{asset,outcome,reason}`
- `keeper_price_refresh_latency_ms_bucket{asset}`
- `keeper_last_success_timestamp{asset}`

**告警建议**

- `OracleWarming`：`oracle_is_warming == 1`（info）
- `OraclePriceInvalidPersistent`：warming 窗口后仍 `oracle_price_valid==0`（critical）
- `OraclePriceInvalid`：`oracle_price_valid == 0` 且非 warming（critical）
- `OracleStaleApproaching`：`oracle_price_age_ratio > 0.8`（warning）
- `OracleStaleHard`：`oracle_price_age_ratio >= 1`（critical）
- `KeeperRefreshDown`：`time() - oracle_last_update_timestamp_seconds{asset} > T` 或 `keeper_last_success_timestamp` 超阈值（critical）

**前端/后端配合要求（强制）**

- 任何展示 USD-8 totals 的页面：只要 detect 到“价格无效/过期”（链上 `isPriceValid=false` 或后端同等口径），必须展示“价格过期/已降级”，并禁用“用 totals 推导交易决策”的 UI。
- 任何展示价格健康状态的页面：都必须联合显示“链上最终价状态 + 链下 publish status”，不能只展示其中一侧。

> 参考验收脚本：[scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts](../../scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts)。这个 E2E 明确了：价格 stale 时 View 必须不能返回“正向可交易的估值”，并且 keeper 刷新后必须恢复。

### 4.3 View 系统一致性与缓存（P0）

**要监控什么**

- `Registry → SystemView` 路由对齐（selector/versionInfo）
- 关键 View 的 meta：`isValid/blockNumber/version`
- ViewCache 的 block lag 与 batch 边界
- 冷启 / 刚部署后的短窗口“warming 动态”（`isValid=false & block=0`）是否能快速自愈

**来自本次 core-e2e 日志的已验证现象（必须纳入线上告警抑制）**

- 在严格 ViewScan 的第一次扫描中，`HealthView.getUserHealthFactorWithMeta` 与 `ViewCache.getSystemStatus` 可能返回 `isValid=false block=0`。
- 随着后续真实交互/状态写入（deposit / finalizeMatch 等），同一批测试里 HealthView 会恢复为 `isValid=true`。

结论：`block=0 & isValid=false` 在“启动后短窗口”更像是缓存/模块未 warm-up 的零块 meta，而不是路由错位；线上 `view-sentinel` 需要显式区分 `warming` 与 `persistent invalid`。

**建议指标**

- `view_is_valid{view}`（0/1）
- `view_block_lag{view}`（head - meta.blockNumber）
- `view_selector_mismatch_total{view}`
- `view_scan_fail_total{view,reason}`

**建议必须覆盖的 View 合约（按 Registry key，线上至少这些）**

- `SYSTEM_VIEW`：系统级只读聚合入口（路由错位会直接影响全站读）
- `VIEW_CACHE`：系统状态缓存（冷启 `block=0/isValid=false` 需要 warming 口径）
- `HEALTH_VIEW`：用户健康度/清算前置读（P0）
- `POSITION_VIEW`：仓位缓存 SSOT（前端 0-gas 读路径核心）
- `VAULT_STATISTICS`：统计口径（跨资产聚合，依赖 oracle）
- `LOAN_FLOW_VIEW`：借贷流统计（USD-8 SSOT）
- `LIQUIDATION_VIEW`：清算 DataPush/事件单点（链下对账与告警入口）
- `REWARD_VIEW`：Reward/EasyToken 镜像与 DataPush（best-effort，必须监控 push failed）
- `FEE_ROUTER_VIEW`：费用路由镜像（费用链路可观测入口）

**建议新增：warming 指标（用于告警抑制与升级）**

- `view_meta_block_number{view}`（直接记录 meta.blockNumber；`0` 表示未 warm-up）
- `view_is_warming{view}`（0/1；建议逻辑：`meta.blockNumber==0 && meta.isValid==false`，且距离 `view_sentinel_start_time_seconds` 在 warming 窗口内）
- `view_warming_consecutive_scans{view}`（gauge；连续多少次扫描都处于 `block=0 & isValid=false`）
- `view_last_valid_timestamp_seconds{view}`（最后一次 `isValid=true && block>0` 的时间戳；用于“多久没恢复”）
- `view_sentinel_start_time_seconds{}`（进程启动时间；用于在 PromQL 中表达 warming 窗口）

**告警建议**

- `ViewWarming`：`view_is_warming == 1`（info，避免误报）
- `ViewInvalidPersistent`：warming 窗口后仍 `block=0 & isValid=false`（critical）
- `ViewInvalid`：`view_is_valid == 0` 且非 warming（critical）
- `ViewLagHigh`：`view_block_lag > N`（warning→critical）
- `SelectorMismatch`：`view_selector_mismatch_total` 增长（critical）

**测试网观察重点：View 返回结构是否被稳定消费**

- 在 Arbitrum Sepolia 阶段，优先把“谁在消费 View 返回结构”跑通：前端页面、后端脚本、indexer decoder、监控 canary 必须都至少完成一轮真实读调用。
- 对所有返回 tuple/struct 的关键 View，显式检查三件事：字段顺序是否与当前 ABI 一致、`isValid/blockNumber/version` 语义是否被正确消费、链下 decoder 是否出现 `decode_error` 或字段错位。
- 若某个 View 当前存在 `struct packing` warning，但该 struct 已进入生产返回值，就不要为了清 warning 重排字段；测试网阶段应优先观察“现有消费者是否稳定”，而不是先做 breaking change。
- 建议把 `frontend_view_read_total{outcome="decode_error"}`、`view_selector_mismatch_total{view}`、脚本侧 decode failure 日志作为测试网放量前的阻断信号。

### 4.4 清算链路（P0）

**要监控什么**

- 可清算仓位是否堆积（backlog）
- 清算执行是否成功、是否 revert 激增
- 清算相关的资金池（payout/guarantee fund）是否异常净流出

**建议指标（来源：索引器 + 周期扫描）**

- `liquidations_executed_total{outcome}`
- `liquidation_tx_reverted_total{reason}`
- `liquidation_backlog_positions{asset}`

**告警建议**

- `LiquidationBacklogGrowing`：backlog 持续增长（critical）
- `LiquidationRevertStorm`：revert rate 超阈值（critical）

### 4.5 Reward / EasyToken / DataPush（P0）

**要监控什么**

#### 4.5.1 EasyToken 铸造与消费：必须“全覆盖”的监控目标

你要覆盖的不是“RewardView 上的一个数字”，而是 **EasyToken 的真实铸造/转移/销毁** 与 **RewardView 的镜像事件** 两条线：

1) **所有 EasyToken 铸造（mint）是否发生、发生给了谁、量是多少**
2) **所有 EasyToken 消费（consume）是否发生、是否按 75/15/10 正确拆分（burn/team/eco）、是否有资金滞留**
3) **RewardView/DataPush 镜像是否完整**（注意：RewardView push 是 best-effort，失败不回滚）

#### 4.5.2 链上事实（SSOT）与关键不变量

**铸造（Mint）链路**

- Token 合约：[src/Token/EasyToken.sol](../../src/Token/EasyToken.sol)
  - `mint(to, amount)` 由 `MINTER_ROLE` 控制
  - 事件：`EasyMinted(to, amount)`（这是“铸造已发生”的最强信号）

**消费（Consume）链路（每次固定 1 Easy = 1e18）**

- [src/Reward/EasyConsumption.sol](../../src/Reward/EasyConsumption.sol)
  - `consumeEasiMCall(user)` / `consumeStrategyApiCall(user)`
  - 每次固定转走 `_SPEND_AMOUNT = 1e18` 到 recycle distributor
- [src/Reward/EasyRecycleDistributor.sol](../../src/Reward/EasyRecycleDistributor.sol)
  - `handleEasyIncome(payer, amount, spendType)`：按 75/15/10 拆分
    - burn：`EasyToken.burn(address(this), 75%)` → 事件 `EasyBurned(from, amount)`
    - transfer：`teamRecipient` 15%，`ecoRecipient` 10%

**关键不变量（用于告警/对账）**

- 每次消费（链上真实发生）应满足：
  - `Transfer(user -> recycle, 1e18)`
  - `EasyBurned(recycle, 0.75e18)`
  - `Transfer(recycle -> team, 0.15e18)` 与 `Transfer(recycle -> eco, 0.10e18)`
- 如果 `EasyConsumption` 已 `transferFrom` 成功，但 recycle 侧未执行拆分（如 Registry 配置错误导致 `handleEasyIncome` 直接 `return`），那么 recycle 合约的 Easy 余额会持续上升 —— 这是资金链路级别的 P0 信号。

#### 4.5.3 RewardView / DataPush：镜像口径（用于链下同步与前端展示）

DataPush 类型定义在：[src/constants/DataPushTypes.sol](../../src/constants/DataPushTypes.sol)

- `DATA_TYPE_EASY_MINTED`：payload = `abi.encode(borrower, lender, totalMinted, borrowerShare, lenderShare, orderId, amountUsd8, blockNumber)`
- `DATA_TYPE_EASY_SPENT`：payload = `abi.encode(user, spendType, amount, blockNumber)`（amount 期望为 `1e18`）
- `DATA_TYPE_EASY_RECYCLED_SPLIT`：payload = `abi.encode(payer, amount, burnAmount, teamAmount, ecoAmount, spendType, blockNumber)`

**注意：RewardView push 是 best-effort**

- 任何 push 失败不会回滚业务交易，会改为在链上发出：
  - `RewardViewPushFailed(user, rewardView, op, payload, reason)`（见 [src/Reward/internal/RewardModuleBase.sol](../../src/Reward/internal/RewardModuleBase.sol)）
- 因此，“只看 DataPushed”会漏报真实发生的 mint/consume；“只看 token 事件”又会漏掉链下镜像同步问题。必须双轨监控。

#### 4.5.4 建议指标（索引器 + 对账作业 + keeper/后端）

**链上真实事件（最强信号）**

- `easy_minted_events_total{to}`：从 `EasyToken.EasyMinted` 统计
- `easy_burned_events_total{from}`：从 `EasyToken.EasyBurned` 统计
- `easy_total_supply{}`：周期读取 `totalSupply()`（用于趋势/异常检测）

**消费拆分（强烈建议做 tx 级对账指标）**

- `easy_consume_tx_total{spend_type,outcome}`（outcome: `ok|split_mismatch|missing_split|reverted`）
- `easy_consume_split_mismatch_total{reason}`（例如 `burn!=75%`、`team!=15%`、`eco!=10%`、`amount!=1e18`）
- `easy_recycle_balance{}`：recycle distributor 的 `IERC20(Easy).balanceOf(recycle)`（持续上升即异常）

**RewardView/DataPush 镜像**

- `rewardview_push_failed_total{op}`：从 `RewardViewPushFailed.op` 统计
- `datapushed_index_rate_5m{data_type}`：`EASY_MINTED/EASY_SPENT/EASY_RECYCLED_SPLIT`
- `datapushed_decode_error_total{data_type}`

**链上/链下对账（小时级作业）**

- `easy_recon_diff_absolute{dimension}`（dimension 可用：`by_user|by_tenant|global`）
- `easy_recon_issues_total{issue}`（issue 例：`mint_missing_datapush`、`spent_missing_split`、`spent_missing_datapush`、`recycle_balance_growing`）

#### 4.5.5 告警建议（把“铸造/消费”拆开）

- `EasyMintSpike`：`easy_minted_events_total` 在短窗内暴增（warning→critical）
- `EasyBurnSpike`：`easy_burned_events_total` 在短窗内暴增（warning→critical）
- `EasySpendSplitMismatch`：`easy_consume_split_mismatch_total > 0`（critical）
- `EasyRecycleBalanceGrowing`：`easy_recycle_balance` 5–10 分钟持续上升（critical）
- `RewardViewPushFailed`：`rewardview_push_failed_total` 增长（warning→critical，取决于持续时间与覆盖面）
- `EasyDatapushMissing`：业务窗口内 `datapushed_index_rate_5m{data_type="EASY_SPENT"} == 0` 但 consume API 有请求量（warning→critical）

#### 4.5.6 最小可用对账（建议先做这 3 条）

1) `EasyMinted` 事件总量 ≈ `EASY_MINTED` DataPushed 解码出的 `totalMinted` 汇总（允许极短延迟；不允许长期缺失）
2) 每笔 `EASY_SPENT`（或 consume tx）都必须对应一笔 `EASY_RECYCLED_SPLIT`（同 tx 或同块内；缺失即 P0）
3) recycle distributor 的 Easy 余额不应长期增长（长期增长=拆分未执行或资金滞留）

#### 4.5.7 测试网观察重点：DataPush / 监控 / 事件解析是否依赖文本或常量

- 测试网阶段要把 `DataPushTypes`、事件签名、payload schema 当成**稳定兼容面**观察，而不是只看事件有没有发出来。
- 对消费方逐项确认：前端、indexer、监控告警、报表脚本是否直接依赖 `dataTypeHash`、事件签名、payload 解码顺序，或者依赖链上文本原因字段做字符串匹配。
- 对 `RewardViewPushFailed`、`DegradationStorage` 详情文本、`StatisticsPushManager` 失败原因等可观测文案，优先检查链下系统是否按“完整字符串”告警；若是，后续任何缩短文案都应视为迁移项，而不是纯优化。
- 对 `DataPushTypes` / module key / push kind 常量，测试网阶段应重点检查“常量哈希值是否被脚本硬编码、索引器映射是否完整、未知类型是否能优雅降级”，不要在未完成链下同步前修改原字符串。
- 建议至少补三类指标或日志核对：
  - `datapushed_decode_error_total{data_type}` 是否为 0；
  - 未识别 `dataTypeHash` 的原始日志是否被保留；
  - 告警系统是否基于 code/hash 工作，而不是仅基于长文本做精确匹配。

### 4.6 前端监控（RUM / Wallet / 读路径降级）（P1，涉及交易阻断时按 P0）

当前文档前面已经零散提到“前端要展示降级状态、要上报 RUM”，但如果不单独成节，落地时很容易只做链上/后端监控，遗漏真实用户侧故障。

**要监控什么**

1) 关键只读路径是否可用：`Registry` 解析、`SystemView` / `HealthView` / `PositionView` / `StatisticsView` / `RewardView` 读取失败率与 p95/p99
2) 钱包交互是否异常：连接失败、签名拒绝、链错误、用户发送后长时间不确认
3) UI 是否进入“降级展示”但没有被上报：例如 `view.isValid=false`、oracle stale、后端返回 degraded 标志
4) API / RPC 依赖是否劣化：前端到后端 API、前端直连 RPC、钱包 Provider 失败率
5) 关键页面是否因错误进入“空白/假成功/假可交易”状态

**建议指标**

- `frontend_view_read_total{view,outcome}`（outcome: `ok|reverted|timeout|decode_error|invalid_meta`）
- `frontend_view_read_latency_ms_bucket{view}`
- `frontend_registry_resolve_total{key,outcome}`
- `frontend_api_requests_total{route,method,status_class}`
- `frontend_api_latency_ms_bucket{route,method}`
- `frontend_wallet_action_total{action,outcome,wallet}`（action: `connect|switch_chain|sign|send_tx`）
- `frontend_tx_lifecycle_total{entrypoint,stage,outcome}`（stage: `prepared|signed|submitted|mined|reverted|timeout`）
- `frontend_chain_mismatch_total{expected_chain,actual_chain}`
- `ui_degraded_total{reason,screen}`
- `ui_error_boundary_total{screen,error_type}`

**告警建议**

- `FrontendViewReadFailureSpike`：关键 view 的 `frontend_view_read_total{outcome!="ok"}` 在 5–10 分钟内突增（warning）
- `FrontendDegradedStateSpike`：`ui_degraded_total` 在主路径页面持续增长（warning→critical）
- `FrontendTxConfirmTimeout`：`frontend_tx_lifecycle_total{stage="timeout"}` 增长（critical，尤其是 deposit/withdraw/repay/liquidate）
- `FrontendChainMismatchSpike`：`frontend_chain_mismatch_total` 异常升高（warning）
- `FrontendBlankScreenOrBoundary`：`ui_error_boundary_total` 在主路径页面短窗内暴增（critical）

**实施要求（强制）**

- 前端只负责暴露“用户看到的故障”和“客户端依赖异常”，不得把本地缓存/展示值当作资金 SSOT。
- 所有前端埋点至少带：`traceId`、`requestId`、`chainId`、`wallet`、`screen`、`view`、`txHash`、`reason`。
- 对 `isValid=false`、oracle stale、selector mismatch、后端 degraded 的 UI 提示，必须与埋点同时落地；不能只提示不记录。
- 推荐接入 Browser RUM + 错误聚合（如 Sentry）并通过 OTel/日志管道把 `traceId` 串到后端。

#### 4.6.1 白名单 / Registry 准入监控（前端必须接入）

对当前平台来说，白名单不是“后台治理细节”，而是前端会直接遇到的交易阻断条件。前端必须把这一层作为独立监控面，而不能把所有失败都归类为通用 RPC 失败或通用交易 revert。

**前端要监控什么**

1) `Registry` 对 `WHITELIST_REGISTRY`、`ASSET_WHITELIST`、`AUTHORITY_WHITELIST` 的解析是否成功。
2) `IAssetWhitelistRead.isAssetAllowed(asset)` 的读取是否成功，以及返回值是否与页面预期一致。
3) 用户发起真实路径操作后，是否出现 `AssetNotAllowed` 一类的准入拒绝信号。
4) 白名单治理事件是否被前端或索引层正确消费，例如新增资产后页面是否仍展示“不可用资产”。
5) 测试网阶段是否出现“Registry 已切换，但前端走真实路径仍被旧白名单拒绝”的现象。

**建议指标**

- `frontend_registry_resolve_total{key,outcome}`
- `frontend_whitelist_read_total{type,outcome}`
  说明：`type` 推荐至少包含 `asset_allowed`、`registry_binding`、`account_whitelisted`
- `frontend_whitelist_gate_total{asset,outcome,screen}`
  说明：`outcome` 推荐至少包含 `allowed`、`rejected`、`resolve_failed`、`decode_error`
- `frontend_tx_lifecycle_total{entrypoint,stage,outcome}`
  说明：对最终 revert 且原因为白名单拒绝的交易，应单独打上 whitelist 相关 reason
- `datapushed_decode_error_total{data_type}`
  说明：对白名单相关 DataPush，重点观察 `ASSET_WHITELIST_ADDED`、`ASSET_WHITELIST_REMOVED`、`ASSET_WHITELIST_BATCH_ADDED`、`ASSET_WHITELIST_BATCH_REMOVED`

**推荐落地表：白名单监控指标命名对照表**

| 指标名 | 生产者 | 触发时机 | 必备标签 | 用途 |
| --- | --- | --- | --- | --- |
| `frontend_registry_resolve_total` | 前端 | 调用 `Registry.getModule*` 解析白名单模块时 | `key,outcome,screen,chain_id` | 发现 Registry 绑定失败、ABI/地址错配 |
| `frontend_whitelist_read_total` | 前端 | 调用 `isAssetAllowed` / `isWhitelisted` 等只读函数时 | `type,outcome,screen,chain_id` | 统计白名单只读失败率与解码失败率 |
| `frontend_whitelist_gate_total` | 前端 | 前端根据白名单结果决定允许/阻止用户继续操作时 | `asset,outcome,screen,chain_id` | 识别页面级准入阻断是否异常升高 |
| `frontend_tx_lifecycle_total` | 前端 | 用户提交交易全生命周期 | `entrypoint,stage,outcome,chain_id` | 对白名单相关 revert 做归因 |
| `frontend_api_requests_total` | 前端 | 前端访问后端 API 时 | `route,method,status_class` | 区分是准入读失败还是通用 API 故障 |
| `datapushed_events_total` | 索引器 / 事件解码层 | 处理白名单相关 DataPush 时 | `emitter,data_type,chain_id` | 统计 `ASSET_WHITELIST_*` 事件是否连续产出 |
| `datapushed_decode_error_total` | 索引器 / 前端解码层 | 解码白名单相关 DataPush 失败时 | `data_type,emitter,chain_id` | 发现 DataPush schema 或 decoder 漂移 |
| `registry_module_address_info` | view-sentinel / canary | 周期扫描 Registry 时 | `key,address,chain_id` | 快速确认当前绑定地址 |
| `registry_module_address_change_total` | view-sentinel / canary | 发现白名单模块地址变化时 | `key,chain_id` | 监控治理/运维热更 |
| `registry_key_missing_total` | view-sentinel / canary | 关键白名单模块键解析失败时 | `key,chain_id` | 直接告警模块缺失 |
| `canary_whitelist_behavior_total` | canary / 后端探测作业 | 使用 allowlisted / non-allowlisted 资产做行为探测时 | `asset,expected,outcome,entrypoint` | 识别“读到 allowed 但真实路径仍拒绝”的错配 |

**最小标签规范（建议统一）**

- 前端指标至少带：`chain_id`、`screen`、`outcome`
- 索引器指标至少带：`data_type`、`emitter`、`chain_id`
- canary 指标至少带：`asset`、`expected`、`outcome`、`entrypoint`

**推荐 outcome 枚举（尽量统一）**

- `ok`
- `rejected`
- `resolve_failed`
- `decode_error`
- `timeout`
- `reverted`
- `mismatch`

前后端如果统一采用这套 outcome 枚举，后续 Grafana 和 Alertmanager 规则可以复用，不需要为白名单单独再拆一套字段体系。

**建议告警**

- `FrontendWhitelistResolveFailure`：`frontend_registry_resolve_total{key=~"WHITELIST_REGISTRY|ASSET_WHITELIST|AUTHORITY_WHITELIST",outcome!="ok"}` 短窗内增长（critical）
- `FrontendWhitelistReadFailureSpike`：`frontend_whitelist_read_total{outcome!="ok"}` 明显上升（warning→critical）
- `FrontendWhitelistRejectSpike`：白名单相关页面的 `frontend_whitelist_gate_total{outcome="rejected"}` 异常抬升（warning）
- `FrontendWhitelistDatapushDecodeError`：`datapushed_decode_error_total{data_type=~"ASSET_WHITELIST_.*"}` 增长（critical）
- `FrontendWhitelistMismatch`：前端先读到 `isAssetAllowed(asset)=true`，但真实交易或 canary 调用仍持续出现 `AssetNotAllowed`（critical）

**前端展示要求（强制）**

- 不要把白名单拒绝显示成泛化的“交易失败”或“网络繁忙”。
- 对资产未准入场景，必须显式展示“资产未进入协议白名单”或等价语义。
- 对 Registry 解析失败场景，必须显式展示“协议配置读取失败”，而不是继续展示可能过期的本地缓存结果。
- 对测试网上线阶段，建议把 [`docs/Usage-Guide/WhitelistSystem.md`](WhitelistSystem.md) 中的“人工验收 checklist”作为前端联调清单的一部分，至少逐项覆盖 Registry 绑定、`isAssetAllowed`、治理事件消费、失败信号四类检查。

**测试网观察重点：签名相关链路是否存在链下 / 链上不一致**

- 在测试网阶段，钱包签名链路要单独做一轮观测，不要只看交易发送是否成功；重点检查 `sign`、`submit`、`verify` 三段是否使用同一套 domain、chainId、verifyingContract 和 typed data schema。
- 若某条业务链路依赖 EIP-712 或 ERC-1271，必须记录：签名请求参数、钱包返回结果、链上验证 revert/false 的原因分类，以及不同钱包/浏览器组合下的差异。
- 对任何未来可能调整字段顺序或 type string 的签名结构，测试网阶段优先验证“当前 signer / matcher / backend / contract 是否完全一致”；在没有确证一致之前，不应为了 gas warning 修改签名结构定义。
- 建议增加或重点查看以下前端/后端埋点：
  - `frontend_wallet_action_total{action="sign",outcome}`；
  - `frontend_tx_lifecycle_total{stage="signed",outcome}` 与 `submitted|mined|reverted` 的关联；
  - 后端或 canary 侧的 `invalid_signature` / `digest_mismatch` / `wrong_chain_id` / `erc1271_rejected` 计数。

### 4.7 后端监控（API / Worker / Tx Submitter / 对账作业）（P0/P1）

当前文档已经覆盖了索引器、view-sentinel、Reward 对账，但还缺少“通用 SaaS 后端”这一层的统一监控面：API 是否在报错、作业是否积压、交易提交器是否卡住、幂等是否失效，这些都需要独立定义。

**要监控什么**

1) API 可用性：各路由的请求量、错误率、延迟、租户维度热点
2) 后台作业可用性：索引补偿、force-sync、retry-push、reconciliation、keeper/cron 是否成功执行
3) 交易提交链路：准备交易、广播、确认、替换、revert、长时间 pending
4) 幂等与队列健康：幂等命中率、冲突率、死信队列、重复消费、重试风暴
5) 依赖健康：RPC、DB、Redis、消息队列、第三方 AI / 通知服务

**建议指标**

- `api_requests_total{route,method,status_class,tenant}`
- `api_latency_ms_bucket{route,method,status_class}`
- `job_runs_total{job,outcome}`（outcome: `ok|failed|timeout|skipped`）
- `job_duration_ms_bucket{job}`
- `job_backlog{job}` / `job_oldest_age_seconds{job}`
- `tx_submit_total{entrypoint,outcome}`（outcome: `ok|reverted|timeout|replaced|dropped`）
- `tx_confirmation_latency_seconds_bucket{entrypoint}`
- `tx_pending_total{entrypoint}`
- `idempotency_hits_total{route}` / `idempotency_conflicts_total{route}`
- `queue_messages_ready{queue}` / `queue_dead_letter_total{queue}`
- `dependency_health{dependency}`（0/1；dependency: `rpc|db|redis|indexer|ai_provider`）

**告警建议**

- `BackendApi5xxHigh`：关键 API 的 5xx 比例超过阈值（critical）
- `WorkerBacklogGrowing`：`job_backlog` 或 `job_oldest_age_seconds` 持续上升（warning→critical）
- `TxSubmitRevertStorm`：`tx_submit_total{outcome="reverted"}` 短窗内暴增（critical）
- `TxConfirmationStuck`：`tx_pending_total` 升高且 `tx_confirmation_latency_seconds_bucket` 明显右移（critical）
- `IdempotencyStorm`：`idempotency_conflicts_total` 或重复命中率异常飙升（warning）
- `DependencyHealthDown`：任一核心依赖 `dependency_health == 0` 持续超过阈值（critical）

**实施要求（强制）**

- 后端日志必须至少带：`traceId`、`requestId`、`idempotencyKey`、`tenant`、`chainId`、`user`、`txHash`、`job`、`queue`。
- 后端可以作为“服务状态”的权威来源，但不能覆盖链上 SSOT；一旦与链上不一致，只能暴露 `recon_diff` 与修复动作，不能静默改写口径。
- 提交链上交易的服务必须区分：`submitted`、`mined`、`confirmed`、`reverted`、`dropped/replaced`，不能只记录“调用成功”。
- 所有定时作业都必须有“开始/结束/失败/重试”指标；没有结果指标的 cron，线上等于不可观测。

---

## 5. 实施步骤（按优先级，建议 1–2 周落地）

### Step 1（Day 1-2）：统一日志与 Trace 透传（所有服务）

1) 后端：
- 所有请求生成/提取 `traceId` 与 `X-Request-Id`
- 强制透传 `X-Idempotency-Key`
- 结构化日志（JSON）必须写入 `traceId/requestId/idempotencyKey/tenant/chainId/txHash`

2) 前端：
- 对关键读路径（Registry 解析、SystemView 路由、RewardView/StatisticsView）上报 RUM：失败率/耗时
- 发生 `isValid=false` 或 oracle 无效/过期（例如后端判定 `isPriceValid=false`）时，上报 `ui_degraded_total{reason}`

### Step 2（Day 2-4）：补齐 Prometheus 指标端点与 scrape

- 后端：暴露 `/metrics`
- 前端：暴露 `/api/metrics`（已存在则复用）
- 索引器：新增一个轻量 `/metrics`

Step 2 验收清单（建议照此过一遍）：

1) Indexer `/metrics` 已上线并可被 Prometheus 抓取：
- 环境变量至少配置：`INDEXER_RPC_URL`、`INDEXER_DEPLOYMENTS_PATH`（或等价地址配置）、`INDEXER_HTTP_PORT`
- 启动你的 indexer/metrics 服务（不限定语言/框架），确保能对外提供 `GET /metrics`（Prometheus text format）

2) Prometheus 已新增 scrape job（见 Step 2.1.3）且带统一 labels：`service/component/environment/chain_id/tenant`

3) 面板所需指标在 `/metrics` 中出现且有值（见 Step 2.1.5）：
- `funds_flow_txs_total{flow,op,outcome}`（本实现默认 `outcome="ok"`）
- `fee_distributed_events_total{token,fee_type}` / `fee_distributed_amount_total{token,fee_type}`

4) 指标与链头同步性可观测：`chain_indexer_lag_blocks` 不应持续上升

索引器建议至少暴露这些“链上事件计数器”（用于 Protocol Safety 的资金链全链路面板）：

- `funds_flow_txs_total{flow,op,outcome}`
- `funds_flow_amount_total{flow,op,asset}`（可选）
- `fee_distributed_events_total{token,fee_type}` / `fee_distributed_amount_total{token,fee_type}`
- `guarantee_events_total{op,asset}`

Prometheus 侧增加 scrape job，并统一 label：`service/component/environment/chain_id/tenant`。

#### Step 2.1：Indexer `/metrics` 完整参考实现（打通 `funds_flow_*` / `fee_distributed_*`）

> 目标：给索引器加一个“轻量可运行”的 `/metrics` 服务，直接把链上 SSOT 事件（含 DataPush）聚合成 Prometheus 指标：
> - `funds_flow_txs_total{flow,op,outcome}`
> - `funds_flow_amount_total{flow,op,asset}`（可选，但这里给出实现）
> - `fee_distributed_events_total{token,fee_type}` / `fee_distributed_amount_total{token,fee_type}`
>
> 说明：本小节只覆盖 `funds_flow_*` 与 `fee_distributed_*` 的打通；`guarantee_events_total{op,asset}` 属于扩展流（Guarantee Flow），建议按相同模式另起一个小节实现。
>
> 设计约束（务必理解）：
> - **reverted 交易不会产生事件**，因此仅靠链上 logs 无法 100% 统计 `outcome="reverted"`。
>   - 本实现默认只产出 `outcome="ok"`。
>   - 如必须统计 reverted：需要额外做 tx 级扫描（按 method selector 拉取 tx receipt 并判定 status），或由后端提交器/keeper 记录 `reverted_total`。
> - 事件来源尽量用 **DataPushed（统一事件流）**，必要时用 SSOT 业务事件补齐。

##### 2.1.1 事件 → 指标映射（本实现口径）

| 资金流 | `flow` | `op` | 事件来源（SSOT） | 金额字段（写入 `funds_flow_amount_total`） |
|---|---|---|---|---|
| 抵押存入 | `collateral` | `deposit` | `DataPushed(DATA_TYPE_DEPOSIT_PROCESSED)`（由 `CollateralManager` 发出） | `amount` |
| 抵押取出 | `collateral` | `withdraw` | `DataPushed(DATA_TYPE_WITHDRAW_PROCESSED)`（由 `CollateralManager` 发出） | `amount` |
| 出借预留 | `reserve` | `reserve` | `DataPushed(DATA_TYPE_RESERVE_FOR_LENDING)`（由 `VaultBusinessLogic` 发出） | `amount` |
| 取消预留 | `reserve` | `cancel` | `DataPushed(DATA_TYPE_CANCEL_RESERVE)`（由 `VaultBusinessLogic` 发出） | `amount` |
| 消耗预留 | `reserve` | `consume` | `DataPushed(DATA_TYPE_RESERVE_CONSUMED)`（由 `VaultBusinessLogic` 发出） | `amount` |
| 撮合落地 | `match` | `finalize` | `DataPushed(DATA_TYPE_LOAN_CREATED)`（由 `LendingEngine` 发出；`finalizeMatch` 已不再 emit 自己的 match 事件） | `principal` |
| 还款结算 | `settlement` | `repayAndSettle` | `DataPushed(DATA_TYPE_REPAY_AND_SETTLE)`（由 `SettlementManager` 发出） | `repayAmount` |
| 清算触发 | `liquidation` | `settleOrLiquidate` | `DataPushed(DATA_TYPE_LIQUIDATION_UPDATE)`（由 `LiquidatorView` 发出；由清算模块写入） | `debtAmount`（可选；更推荐只看 txs_total） |
| 清算分配 | `liquidation` | `payoutExecuted` | `DataPushed(DATA_TYPE_LIQUIDATION_PAYOUT)`（由 `LiquidatorView` 发出；推荐）或 `LiquidationManager.PayoutExecuted`（fallback） | `platformShare+reserveShare+lenderShare+liquidatorShare` |
| 费用分配 | N/A | N/A | `DataPushed(DATA_TYPE_FEE_DISTRIBUTED)`（由 `FeeRouter` 发出） | `platformAmt+ecoAmt` 写入 `fee_distributed_amount_total` |

其中 DataPushTypes 常量可在合约里查到（本仓库）：`src/constants/DataPushTypes.sol`。

##### 2.1.2 运行方式（最小）

假设你用 Node.js（推荐 v20+）+ TypeScript（ts-node）+ ethers v6：

- 启动：`GET /metrics`
- 配置：通过环境变量指定 RPC、合约地址、确认深度等

环境变量（建议默认值）：

- `INDEXER_RPC_URL`：必填，例如 `http://127.0.0.1:8545`
- `INDEXER_HTTP_HOST`：默认 `0.0.0.0`
- `INDEXER_HTTP_PORT`：默认 `9102`
- `INDEXER_CONFIRMATIONS`：默认 `2`（确认深度；越大越稳，延迟越高）
- `INDEXER_POLL_INTERVAL_MS`：默认 `5000`
- `INDEXER_MAX_BLOCKS_PER_SCAN`：默认 `2000`（每次扫描最大区间）
- `INDEXER_START_BLOCK`：可选（首次启动从某个 block 开始）
- `INDEXER_STATE_PATH`：默认 `.indexer-state/metrics-indexer.json`（用于断点续扫与少量去重）

合约地址输入方式（二选一）：

1) （推荐）直接读部署产物 JSON：
   - `INDEXER_DEPLOYMENTS_PATH=deployments/localhost.json`（本仓库已有）
2) 或者你也可以把地址写死在配置文件/环境变量里（本文不展开）。

##### 2.1.3 Prometheus scrape 示例

```yaml
scrape_configs:
  - job_name: "ponder-indexer" # 或 metrics-indexer
    metrics_path: /metrics
    static_configs:
      - targets: ["indexer:9102"]
        labels:
          service: "ponder-indexer"
          component: "indexer"
          environment: "staging"
          chain_id: "42161"
```

##### 2.1.4 实现结构（伪代码级别；按本节清单实现即可）

这里不贴“整段可运行代码”，因为这是指南：目标是让读者一眼看懂“应该监听什么、如何组织实现”。

实现 `/metrics` 时只需要把两件事做对：

1) **监听全量的 `DataPushed(dataTypeHash,payload)`**（不要只挑你当前用到的几个类型；view 系统必须全量监听）
2) **把其中少数关键类型 decode 成业务维度**（用于 `funds_flow_*` / `fee_distributed_*` 的 labels 与金额汇总）

###### 2.1.4.1 统一监听的事件（必须）

- 事件签名：`IDataPush.DataPushed(bytes32 indexed dataTypeHash, bytes payload)`
- dataTypeHash 的稳定来源：见 `src/constants/DataPushTypes.sol`（以合约常量为准）
  - 注意：常量名与 `keccak256("...")` 的字符串在个别类型上并不完全同名（历史兼容/表达习惯），例如：
    - `DATA_TYPE_SYSTEM_STATUS` 对应 `keccak256("SYSTEM_STATUS_CACHE")`
    - `DATA_TYPE_HISTORY` 对应 `keccak256("EVENT_HISTORY")`
    - `DATA_TYPE_HEALTH_FACTOR` 对应 `keccak256("HEALTH_FACTOR_UPDATE")`
    - `DATA_TYPE_RISK_STATUS` / `DATA_TYPE_RISK_STATUS_BATCH` 对应 `keccak256("RISK_STATUS_UPDATE" / "RISK_STATUS_UPDATE_BATCH")`

###### 2.1.4.2 必须监听的合约地址（必须全量）

**A. 资金链/费用（用于 `funds_flow_*` / `fee_distributed_*`）**

- `CollateralManager`
- `VaultBusinessLogic`
- `LendingEngine`
- `SettlementManager`
- `FeeRouter`
- `LiquidationManager`（建议保留：部分落地会同时 emit 业务事件）

**B. Guarantee Flow（扩展流）**

- `GuaranteeFundManager`

**C. View 系统（必须全量监听；本指南此前不全面，这里补全）**

以下合约都在 `src/Vault/view/modules/` 下；即使其中部分合约当前版本没有 emit `DataPushed`，也建议全量监听，避免升级后“漏掉新 DataPushTypes”：

- `AccessControlView`
- `BatchView`
- `CacheOptimizedView`
- `DashboardView`
- `EventHistoryManager`
- `FeeRouterView`
- `HealthView`
- `LendingEngineView`
- `LiquidationRiskView`
- `LiquidatorView`
- `LoanFlowView`
- `LoanNFTView`
- `ModuleHealthView`
- `PositionView`
- `PreviewView`
- `RegistryView`
- `RewardView`
- `RiskView`
- `StatisticsView`
- `SystemRiskView`
- `SystemView`
- `UserView`
- `ValuationOracleView`
- `ViewCache`

###### 2.1.4.3 你需要“明确实现”的 DataPushTypes（按模块分组）

建议实现时分两层：

- **L1（必做）**：只按 `dataTypeHash` 做计数/速率（不强制 decode payload）
- **L2（只对关键类型做 decode）**：把 payload 解出关键字段，落到 `funds_flow_*` / `fee_distributed_*` 的 label

**（L2）资金链 + 费用（打通 `funds_flow_*` / `fee_distributed_*`）**

- `DEPOSIT_PROCESSED`（emitter: `CollateralManager`）
  - payload：`abi.encode(user, asset, amount, blockNumber)`
  - 指标：`funds_flow_txs_total{flow="collateral",op="deposit",outcome="ok"} += 1`
  - 可选金额：`funds_flow_amount_total{flow="collateral",op="deposit",asset} += amount`
- `WITHDRAW_PROCESSED`（emitter: `CollateralManager`）
  - payload：`abi.encode(user, asset, amount, blockNumber)`
- `RESERVE_FOR_LENDING`（emitter: `VaultBusinessLogic`）
  - payload：`abi.encode(lendIntentHash, lenderSigner, asset, amount, blockNumber)`
- `CANCEL_RESERVE`（emitter: `VaultBusinessLogic`）
  - payload：`abi.encode(lendIntentHash, lenderSigner, asset, amount, blockNumber)`
- `RESERVE_CONSUMED`（emitter: `VaultBusinessLogic`）
  - payload：`abi.encode(lendIntentHash, lenderSigner, asset, amount, blockNumber)`
- `LOAN_CREATED`（emitter: `LendingEngine`；撮合落地 SSOT）
  - payload：`abi.encode(engine, orderId, borrower, lender, principal, asset, tokenId, blockNumber)`
- `REPAY_AND_SETTLE`（emitter: `SettlementManager`）
  - payload：`abi.encode(user, debtAsset, repayAmount, orderId, releasedAllCollateral, blockNumber)`
- `LIQUIDATION_UPDATE`（emitter: `LiquidatorView`；清算触发/归因）
  - payload：`abi.encode(user, collateralAsset, debtAsset, collateralAmount, debtAmount, liquidator, bonus, blockNumber)`
  - 指标建议：主要用于 `funds_flow_txs_total{flow="liquidation",op="settleOrLiquidate"...}` 的“有没有在动”
- `LIQUIDATION_PAYOUT`（emitter: `LiquidatorView`；清算分配）
  - payload：`abi.encode(user, collateralAsset, platform, reserve, lender, liquidator, platformShare, reserveShare, lenderShare, liquidatorShare, blockNumber)`
  - 指标：`funds_flow_txs_total{flow="liquidation",op="payoutExecuted",outcome="ok"} += 1`
  - 可选金额：对 `collateralAsset` 把 shares 求和写入 `funds_flow_amount_total`
- `FEE_DISTRIBUTED`（emitter: `FeeRouter`）
  - payload：`abi.encode(token, platformAmt, ecoAmt, remaining, feeType, totalAmount, pusher, blockNumber)`
  - 指标：
    - `fee_distributed_events_total{token,fee_type} += 1`
    - `fee_distributed_amount_total{token,fee_type} += (platformAmt + ecoAmt)`
  - `fee_type` 建议：对已知常量做映射（见 `src/constants/FeeTypes.sol`），未知值直接保留 bytes32 hex

**（L1 必做）View 系统 DataPushTypes（全量监听，不要漏）**

这些类型主要用于“有没有在 push / 是否断流 / 是否异常降级”等面板；一般不要求你把每个 payload 全解出来，至少要做到：

- 计数：`datapushed_events_total{emitter,data_type}`
- 速率：`datapushed_index_rate_5m{emitter,data_type}`（或用 PromQL `rate(datapushed_events_total[5m])`）

当前仓库中，view 系统已存在的关键 DataPushTypes 包括（按 emitter 归类）：

- `ViewCache`
  - `SYSTEM_STATUS`（string: `SYSTEM_STATUS_CACHE`）：`abi.encode(asset, totalCollateral, totalDebt, utilizationRate, updateBlock)`
- `HealthView`
  - `HEALTH_FACTOR`（string: `HEALTH_FACTOR_UPDATE`）：`abi.encode(user, healthFactorBps)`
  - `RISK_STATUS`（string: `RISK_STATUS_UPDATE`）：`abi.encode(user, healthFactorBps, minHFBps, undercollateralized, blockNumber)`
  - `RISK_STATUS_BATCH`（string: `RISK_STATUS_UPDATE_BATCH`）：`abi.encode(users, healthFactorsBps, minHFsBps, underFlags, blockNumber)`
  - `MODULE_HEALTH`：`abi.encode(module, isHealthy, detailsHash, consecutiveFailures, blockNumber)`
  - 备注：`ModuleHealthView` 本身 **不** emit `MODULE_HEALTH`（由 `HealthView.pushModuleHealth` emit）
  - 口径提示：当 `healthFactorBps == type(uint256).max` 时，语义是“∞（无债务）”，不是一个可比较的巨大数值。
    - 监控/面板展示建议把该值映射为 `+Inf/∞`（或显示为 `null` 并附带标签），避免出现“健康因子爆表”的误导。
- `PositionView`
  - `USER_POSITION_UPDATE`：`abi.encode(user, asset, collateral, debt)`
- `StatisticsView`
  - `USER_STATS_UPDATE`：`abi.encode(user, version, requestId, seq, userSnapshotStruct, globalSnapshotStruct)`
  - `GUARANTEE_STATS_UPDATE`：用于 guarantee 统计 cache（多种 overload，建议用 ABI 直接 decode）
  - `STATS_SNAPSHOT_RECORDED`：`abi.encode(user, blockNumber, version, seq)`
  - `DEGRADATION_STATS_UPDATE`：`abi.encode(gracefulDegradationStatsStruct)`
  - 口径提示：`StatisticsView` 的 totals 是 **USD-8 的整数**。
    - 对账/告警要以 raw 整数为准，避免直接用格式化小数做严格字符串比较（例如 `1004.99999999` 这类展示层浮点/格式化痕迹）。
    - 若需要“人类可读”展示，建议统一用 `usd8 / 1e8` 且设置合理容差（尤其是跨模块求和/转换时）。
- `FeeRouterView`
  - `USER_FEE`：`abi.encode(user, feeType, feeAmount, personalFeeBps)`
  - `GLOBAL_FEE_STATS`：`abi.encode(totalDistributions, totalAmountDistributed)`
  - `FEE_ROUTER_SYSTEM_CONFIG_UPDATED`：`abi.encode(platformTreasury, ecosystemVault, platformFeeBps, ecosystemFeeBps, supportedTokens[])`
  - `FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED`：`abi.encode(token, feeType, amount)`
- `AccessControlView`
  - `PERMISSION_BIT_UPDATE`：`abi.encode(user, actionKey, hasPermission)`
  - `PERMISSION_LEVEL_UPDATE`：`abi.encode(user, permissionLevelEnum)`
- `UserView`
  - `USER_VIEW_INITIALIZED`：`abi.encode(registryAddr, blockNumber)`
- `EventHistoryManager`
  - `HISTORY`（string: `EVENT_HISTORY`）：`abi.encode(eventType, user, asset, amount, extraData)`
- `LoanFlowView`
  - `LOAN_FLOW_UPDATED`：`abi.encode(user, borrowDeltaUsd8, repayDeltaUsd8, nextVersion, requestId, seq, blockNumber)`
- `LiquidatorView`
  - `LIQUIDATION_UPDATE` / `LIQUIDATION_BATCH_UPDATE` / `LIQUIDATION_PAYOUT`
- `RewardView`
  - `EASY_MINTED`：`abi.encode(borrower, lender, totalMinted, borrowerShare, lenderShare, orderId, amountUsd8, blockNumber)`
  - `REWARD_BURNED`：`abi.encode(user, amount, reason, blockNumber)`
  - `REWARD_LEVEL_UPDATED`：`abi.encode(user, newLevel, blockNumber)`
  - `REWARD_STATS_UPDATED`：`abi.encode(totalBatchOps, totalCachedRewards, blockNumber)`
  - `REWARD_PENALTY_LEDGER_UPDATED`：`abi.encode(user, pendingDebt, blockNumber)`
  - `REWARD_EARN_STATE_UPDATED`：`abi.encode(user, lockedEasy, eligibleLoanCount, onTimeRepayCount, blockNumber)`
    - 口径提示：同一笔 tx 内可能出现多条 `REWARD_PENALTY_LEDGER_UPDATED`（中间态 → 最终态）。
      事件完整性校验按“同 tx 最后一条 push”为最终态；诊断时要 dump 同 tx 全量 push。
  - `EASY_MINTED` / `EASY_SPENT` / `EASY_RECYCLED_SPLIT` / `EASY_STAKED` / `EASY_UNSTAKED` / `EASY_EMISSION_PARAMS_UPDATED`
  - 以及治理可观测类型：`REWARD_DYNAMIC_REWARD_PARAMS_UPDATED`、`REWARD_LEVEL_MULTIPLIER_UPDATED`（即使暂未用到也建议监听）

**（补全清单）View 模块 → DataPushTypes（当前版本）**

> 目的：让实现者“一眼看完不漏”。下面按合约文件逐个列出当前版本能在源码中找到的 `DataPushTypes.DATA_TYPE_*` 引用点。
>
> - 规则：即使某个模块当前没 push，也建议全量监听该模块地址（未来升级新增 DataPush 时不需要再改监听范围）

- `AccessControlView`：`DataPushTypes.DATA_TYPE_PERMISSION_BIT_UPDATE`、`DataPushTypes.DATA_TYPE_PERMISSION_LEVEL_UPDATE`
- `BatchView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
- `CacheOptimizedView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
- `DashboardView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
- `EventHistoryManager`：`DataPushTypes.DATA_TYPE_HISTORY`（string: `EVENT_HISTORY`）
- `FeeRouterView`：`DataPushTypes.DATA_TYPE_USER_FEE`、`DataPushTypes.DATA_TYPE_GLOBAL_FEE_STATS`、`DataPushTypes.DATA_TYPE_FEE_ROUTER_SYSTEM_CONFIG_UPDATED`、`DataPushTypes.DATA_TYPE_FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED`
- `HealthView`：`DataPushTypes.DATA_TYPE_HEALTH_FACTOR`（string: `HEALTH_FACTOR_UPDATE`）、`DataPushTypes.DATA_TYPE_RISK_STATUS`（string: `RISK_STATUS_UPDATE`）、`DataPushTypes.DATA_TYPE_RISK_STATUS_BATCH`（string: `RISK_STATUS_UPDATE_BATCH`）、`DataPushTypes.DATA_TYPE_MODULE_HEALTH`
- `LendingEngineView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
- `LiquidationRiskView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
- `LiquidatorView`：`DataPushTypes.DATA_TYPE_LIQUIDATION_UPDATE`、`DataPushTypes.DATA_TYPE_LIQUIDATION_BATCH_UPDATE`、`DataPushTypes.DATA_TYPE_LIQUIDATION_PAYOUT`
- `LoanFlowView`：`DataPushTypes.DATA_TYPE_LOAN_FLOW_UPDATED`
- `LoanNFTView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
  - 口径提示：`SettlementManager.settleOrLiquidate` / 清算模块并不会同步更新 `LoanNFT` 的 status。
    - 因此不要用 `LoanNFT.status == Repaid/Active` 作为“债务是否已结清/是否已清算”的唯一判断。
    - 监控与验收建议以 SSOT（`CollateralManager`/`VaultLendingEngine` 的 debt/collateral + `REPAY_AND_SETTLE` / `LIQUIDATION_UPDATE` DataPush）为准；LoanNFT 更适合做“可枚举资产/订单关联”的 UI 维度。
- `ModuleHealthView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用；且按设计不得 emit `DATA_TYPE_MODULE_HEALTH`）
- `PositionView`：`DataPushTypes.DATA_TYPE_USER_POSITION_UPDATE`
- `PreviewView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
- `RegistryView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
- `RewardView`：`DataPushTypes.DATA_TYPE_REWARD_BURNED`、`DataPushTypes.DATA_TYPE_REWARD_LEVEL_UPDATED`、`DataPushTypes.DATA_TYPE_REWARD_STATS_UPDATED`、`DataPushTypes.DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED`、`DataPushTypes.DATA_TYPE_REWARD_EARN_STATE_UPDATED`、`DataPushTypes.DATA_TYPE_EASY_MINTED`、`DataPushTypes.DATA_TYPE_EASY_SPENT`、`DataPushTypes.DATA_TYPE_EASY_RECYCLED_SPLIT`、`DataPushTypes.DATA_TYPE_EASY_STAKED`、`DataPushTypes.DATA_TYPE_EASY_UNSTAKED`、`DataPushTypes.DATA_TYPE_EASY_EMISSION_PARAMS_UPDATED`、`DataPushTypes.DATA_TYPE_REWARD_DYNAMIC_REWARD_PARAMS_UPDATED`、`DataPushTypes.DATA_TYPE_REWARD_LEVEL_MULTIPLIER_UPDATED`
- `RiskView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
- `StatisticsView`：`DataPushTypes.DATA_TYPE_DEGRADATION_STATS_UPDATE`、`DataPushTypes.DATA_TYPE_GUARANTEE_STATS_UPDATE`、`DataPushTypes.DATA_TYPE_USER_STATS_UPDATE`、`DataPushTypes.DATA_TYPE_STATS_SNAPSHOT_RECORDED`
- `SystemRiskView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
- `SystemView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
- `UserView`：`DataPushTypes.DATA_TYPE_USER_VIEW_INITIALIZED`
- `ValuationOracleView`：（当前版本未发现 `DataPushTypes.DATA_TYPE_*` 引用）
- `ViewCache`：`DataPushTypes.DATA_TYPE_SYSTEM_STATUS`（string: `SYSTEM_STATUS_CACHE`）

###### 2.1.4.4 极简实现提示（伪代码级别）

- 维护一个 `watchAddresses`（由部署配置或 Registry 解析得到），把上述 Core + View 全部加进去
- 扫 logs：`getLogs({ address: watchAddresses, topics: [topic(DataPushed), ...] })`
- 对每条 log：
  - `dataTypeHash = topics[1]`
  - `payload = abi.decode(bytes, log.data)`
  - L1：`datapushed_events_total{emitter,data_type} += 1`
  - L2：如果 `dataTypeHash` 属于资金链/费用关键类型，decode payload → 写 `funds_flow_*` / `fee_distributed_*`

> 提醒：同一个 dataType 可能由不同 emitter 发出（例如 view 与业务模块），建议 label 里保留 `emitter` 或 `module` 维度，避免排查时“只知道断了，但不知道哪个模块断”。

##### 2.1.5 验收（必须做到的 3 个检查）

1) `/metrics` 可访问：

```bash
curl -sS http://127.0.0.1:9102/metrics | head
```

2) 指标名出现且有值：

```bash
curl -sS http://127.0.0.1:9102/metrics | rg "^(funds_flow_txs_total|fee_distributed_events_total|chain_indexer_lag_blocks)"
```

3) Indexer lag 可观测：

- 运行中应满足：`chain_indexer_lag_blocks` 能收敛到一个较小区间（例如 < 100 blocks；具体阈值按链与 RPC 而定）
- 若 lag 持续上升：优先排查 RPC 延迟/错误码（见 4.1）


### Step 3（Day 3-6）：上线 canary（View + Oracle）

实现一个只读服务 `view-sentinel`：

- 每 60s：
  - 读取 `Registry`（强制）
  - 读取关键 View（建议至少覆盖这些 Registry keys；按实际部署裁剪）：
    - `SYSTEM_VIEW` / `VIEW_CACHE`
    - `HEALTH_VIEW` / `POSITION_VIEW`
    - `VAULT_STATISTICS` / `LOAN_FLOW_VIEW`
    - `LIQUIDATION_VIEW`
    - `REWARD_VIEW`
    - `FEE_ROUTER_VIEW`
  - 校验：`getVersionInfo` / meta（`isValid/blockNumber/version`）
  - 校验：oracle 是否有效（资产维度优先用 `PriceOracle.isPriceValid(asset)`），并记录 `age/maxAge` 进度
  - 扫描“资金链关键托管者”的链上余额（来自 [docs/Usage-Guide/Funds-Flow-Architecture-Guide.md](Funds-Flow-Architecture-Guide.md) 的 SSOT）：
    - `CollateralManager` / `LenderPoolVault` / `SettlementManager`
    - `FeeRouter` / `GuaranteeFundManager`
    - （如启用）`EasyRecycleDistributor`（Easy spend 资金滞留信号）
    - 扫描方式：`ERC20(asset).balanceOf(custodian)`（每个资产 1 次调用）
  - 上报指标

**把“建议指标名”落到 view-sentinel 的最小实现清单（建议直接照此暴露 /metrics）**

- View 扫描通用
  - `view_scan_duration_ms_bucket{view}`
  - `view_scan_fail_total{view,reason}`
  - `view_is_valid{view}`
  - `view_meta_block_number{view}`
  - `view_block_lag{view}`
  - `view_selector_mismatch_total{view}`
- 冷启 warming（本次 core-e2e 已验证必须存在）
  - `view_sentinel_start_time_seconds{}`
  - `view_is_warming{view}`
  - `view_warming_consecutive_scans{view}`
  - `view_last_valid_timestamp_seconds{view}`
- Oracle（见 4.2）
  - `oracle_price_valid{asset}`
  - `oracle_price_age_blocks{asset}`
  - `oracle_max_price_age_blocks{asset}`
  - `oracle_price_age_ratio{asset}`
  - `oracle_is_warming{asset}`
  - `oracle_warming_consecutive_scans{asset}`
  - `oracle_last_update_timestamp_seconds{asset}`

**建议新增：Registry 路由与地址变更（用于“路由错位/热更”快速定位）**

- `registry_module_address_info{key,address}`（gauge=1；key 为 Registry key 的字符串名）
- `registry_module_address_change_total{key}`
- `registry_key_missing_total{key}`

**建议新增：资金托管者余额（用于 Protocol Safety 全链路资金链主视图）**

- `funds_custody_balance{custodian,asset}`（ERC20 base units；custodian 建议值：`CollateralManager|LenderPoolVault|SettlementManager|FeeRouter|GuaranteeFundManager|EasyRecycleDistributor`）
- `funds_custody_balance_usd8{custodian,asset}`（可选；如果你已经在 sentinel 里做了 USD-8 换算）
- `funds_custody_balance_last_success_timestamp_seconds{custodian}`（用于判定扫描是否卡住）

### Step 4（Day 5-10）：对账作业（Reward + AI Credits + Ledger）

- 每小时：Reward 余额、AI Credits 对账（关键）
- 每日：事件完整性与复式平衡

对账作业输出：
- 指标：`recon_diff_absolute`、`reconciliation_issues_total{issue}`
- 自动修复入口：`force-sync` / `re-index` / `retry-push`

### Step 5（Day 7-14）：告警规则与看板

建议四张核心板：

- Protocol Safety（清算/资金/Oracle）
- Views & Cache（isValid/lag/selector/warming）
- Reward & DataPush（mint/spent/penalty/recon）
- RPC & Indexer（错误码/延迟/lag）

下面把前两张（与你当前关注最强相关）设计成“全面、简洁、实用”的可落地面板清单。

#### 5.1 仪表盘：Views & Cache（逐个 view 合约可观测）

目标：把“读路径是否可信”一眼看清；出现 `isValid=false/block=0/selector mismatch` 时能立刻定位到具体 view/具体原因。

**推荐布局（从上到下 10–14 个面板以内）**

1) 总览：关键 View 的可用性（单屏红绿）
- 指标：`min by(view) (view_is_valid{view=~"SYSTEM_VIEW|VIEW_CACHE|HEALTH_VIEW|POSITION_VIEW|VAULT_STATISTICS|LOAN_FLOW_VIEW|LIQUIDATION_VIEW|REWARD_VIEW|FEE_ROUTER_VIEW"})`

2) 冷启/缓存 warm-up 状态（避免误报）
- 指标：`max by(view) (view_is_warming)`、`max by(view) (view_warming_consecutive_scans)`、`time() - max by(view) (view_last_valid_timestamp_seconds)`

3) meta.blockNumber（直接看是否卡在 0）
- 指标：`max by(view) (view_meta_block_number)`

4) View lag（head - meta.blockNumber）
- 指标：`max by(view) (view_block_lag)`

5) selector/versionInfo mismatch（路由错位的硬信号）
- 指标：`increase(view_selector_mismatch_total[10m])`

6) 扫描耗时分位（能快速区分“链慢/RPC慢” vs “view 本身 revert”）
- 指标：`histogram_quantile(0.99, sum by(le,view) (rate(view_scan_duration_ms_bucket[5m])))`

7) 扫描失败原因 TopK（只保留 5–10 个 reason，避免信息噪音）
- 指标：`topk(10, increase(view_scan_fail_total[15m]))`

8) Registry 路由快照（“现在指到哪里”）
- 指标：`registry_module_address_info{key=~"KEY_SYSTEM_VIEW|KEY_VIEW_CACHE|KEY_HEALTH_VIEW|KEY_POSITION_VIEW|KEY_STATS|KEY_LOAN_FLOW_VIEW|KEY_LIQUIDATION_VIEW|KEY_REWARD_VIEW|KEY_FRV"}`
- 用途：直接在 Grafana 表格展示 `key → address`

9) Registry 地址变更计数（治理/运维改绑是否正在发生）
- 指标：`increase(registry_module_address_change_total[1h])`

（可选）10) View push failure（best-effort 推送失败不回滚，但必须可见）
- 建议索引器补指标：`view_push_failed_total{view,op}`（来源：各 view 的 `CacheUpdateFailed*`/`RewardViewPushFailed` 等事件）

**面板解释口径（避免误判）**

- `view_meta_block_number==0 && view_is_valid==0`：更倾向 warming；先看 `view_is_warming` 与 `view_warming_consecutive_scans`。
- `view_is_valid==0 && view_meta_block_number>0`：更倾向真实事故（路由错位/selector 不匹配/内部 revert）。

#### 5.2 仪表盘：Protocol Safety（清算/资金/Oracle + 资金链全链路）

目标：把“价格可靠性 + 清算可用性 + 资金托管者余额 + 关键写入口事件流”串成一条主视图，用最少面板覆盖全链路。

**A. Oracle（清算/估值前置条件）**

1) 价格有效性（按资产）
- 指标：`min by(asset) (oracle_price_valid)`

2) 过期比例（age/maxAge，一把尺子）
- 指标：`max by(asset) (oracle_price_age_ratio)`

3) keeper 刷价健康（最后成功时间）
- 指标：`time() - max by(asset) (oracle_last_update_timestamp_seconds)`（或 `keeper_last_success_timestamp`）

**B. 清算可用性（执行 + revert + backlog）**

4) 清算执行量（成功/失败）
- 指标：`sum by(outcome) (rate(liquidations_executed_total[5m]))`

5) revert storm（原因维度 TopK）
- 指标：`topk(10, rate(liquidation_tx_reverted_total[10m]))`

6) backlog（按资产/全局）
- 指标：`max(liquidation_backlog_positions)`

**C. 资金链托管者余额（全链路“资产在哪里”）**

7) CollateralManager 托管余额（按资产）
- 指标：`sum by(asset) (funds_custody_balance{custodian="CollateralManager"})`

8) LenderPoolVault 托管余额（按资产）
- 指标：`sum by(asset) (funds_custody_balance{custodian="LenderPoolVault"})`

9) SettlementManager in-flight 余额（按资产；正常应接近 0，长时间非 0 要追）
- 指标：`sum by(asset) (funds_custody_balance{custodian="SettlementManager"})`

10) FeeRouter 余额（按资产；区分 normal/distributePrepaid 的预存语义）
- 指标：`sum by(asset) (funds_custody_balance{custodian="FeeRouter"})`

11) GuaranteeFundManager 托管余额（按资产；保证金扩展流）
- 指标：`sum by(asset) (funds_custody_balance{custodian="GuaranteeFundManager"})`

（如启用）12) EasyRecycleDistributor 余额（Easy spend 滞留/拆分未执行信号）
- 指标：`funds_custody_balance{custodian="EasyRecycleDistributor",asset="EASY"}`

**D. 资金链写入口事件流（端到端“有没有在动”）**

这些面板建议来自“索引器事件计数器”（按 Funds Flow SSOT 的入口/事件单点统计），不要求 100% 精准金额，优先保证“有没有发生/是否异常中断”。

13) Deposit/Withdraw（Collateral Flow）
- 指标建议：`rate(funds_flow_txs_total{flow="collateral",op=~"deposit|withdraw",outcome="ok"}[5m])`

14) Reserve/Cancel + FinalizeMatch（Liquidity → Borrow Disbursement）
- 指标建议：`rate(funds_flow_txs_total{flow="reserve",op=~"reserve|cancel|consume",outcome="ok"}[5m])`、`rate(funds_flow_txs_total{flow="match",op="finalize",outcome="ok"}[5m])`

15) RepayAndSettle + CollateralReleased（Settlement Flow）
- 指标建议：`rate(funds_flow_txs_total{flow="settlement",op="repayAndSettle",outcome="ok"}[5m])`

16) Liquidation payout（Liquidation Flow）
- 指标建议：`rate(funds_flow_txs_total{flow="liquidation",op=~"settleOrLiquidate|payoutExecuted",outcome="ok"}[5m])`

17) FeeDistributed（Fee Flow，按 feeType）
- 指标建议：`sum by(fee_type) (rate(fee_distributed_events_total[5m]))`

**建议把“资金链事件指标名”也固化（来自 indexer；落地简单）**

- `funds_flow_txs_total{flow,op,outcome}`（outcome: `ok|reverted`；注意：`reverted` 仅靠事件无法直接统计，见 Step 2.1 的约束说明）
- `funds_flow_amount_total{flow,op,asset}`（可选；从事件/日志 decode 的 token base units 汇总）
- `fee_distributed_events_total{token,fee_type}` / `fee_distributed_amount_total{token,fee_type}`
- `guarantee_events_total{op,asset}`（op: `locked|released|forfeited`）

> 实用约束：不要在 Dashboard 上直接堆“每个函数一个 panel”。把它们归到四条资金流（Collateral/Liquidity/Settlement/Liquidation）+ Fee/Guarantee 两条扩展流，就能既全面又不臃肿。

---

## 6. 告警规则模板（PromQL 示例）

> 说明：以下 PromQL 使用的指标名是“推荐命名”。落地时你需要在 `view-sentinel` / 索引器 / 后端将这些指标暴露出来（或通过 relabel 映射到现有指标），再把表达式接入 Alertmanager。

### 6.1 RPC

```promql
(time() - max(rpc_last_success_timestamp)) > 300
```

```promql
increase(rpc_errors_total{code="-32000"}[10m]) > 0
```

### 6.2 Oracle

`OraclePriceInvalid`（非 warming 的无效价格）

```promql
min_over_time(oracle_price_valid[2m]) == 0 and max_over_time(oracle_is_warming[2m]) == 0
```

`OraclePriceInvalidPersistent`（warming 持续不恢复：连续 N 次仍无效，示例 N=3）

```promql
max_over_time(oracle_warming_consecutive_scans[10m]) >= 3
```

```promql
max_over_time(oracle_price_age_ratio[5m]) > 0.8
```

### 6.3 View Invalid

`ViewInvalid`（非 warming 的无效 view）

```promql
min_over_time(view_is_valid[2m]) == 0 and max_over_time(view_is_warming[2m]) == 0
```

`ViewInvalidPersistent`（warming 持续不恢复：连续 N 次仍 block=0，示例 N=3）

```promql
max_over_time(view_warming_consecutive_scans[5m]) >= 3
```

### 6.4 Indexer Lag

```promql
(chain_head_block - indexer_last_indexed_block) > 100
```

### 6.5 Reward 对账差异

```promql
max_over_time(reward_recon_diff_absolute[10m]) > 0.01
```

### 6.6 统一口径 Recording Rules + Alerts（把“易误导点”固化成机器可判定）

这一节的目标是：把“人容易看错/验收容易误判”的口径，变成可复用的 recording rules + alerts。

前提（非常重要）：

- 对 **warming 抑制**：需要 `view_is_warming` / `oracle_is_warming` 这类布尔指标（来自 `view-sentinel`）。
- 对 **MaxUint256 sentinel（∞ health factor）**：消费端/导出端必须显式暴露一个 `*_is_infinite` 指标（而不是把 `uint256.max` 当普通数字）。
- 对 **同 tx 多次 DataPush 取最后一条**：PromQL 无法在时间序列层面“重建 tx 内顺序”；必须由 indexer 在 ingest 阶段做“同 tx 去重/取最后一条”，并导出多推送可观测指标。

#### 6.6.1 Recording rules（模板）

```yaml
groups:
  - name: ssot-common.recording
    interval: 30s
    rules:
      # ---- Views / Oracle：统一 warming 抑制口径 ----
      - record: view:is_problem
        expr: (min_over_time(view_is_valid[2m]) == 0) and (max_over_time(view_is_warming[2m]) == 0)

      - record: oracle:is_problem
        expr: (min_over_time(oracle_price_valid[2m]) == 0) and (max_over_time(oracle_is_warming[2m]) == 0)

      # ---- View 读失败原因归一：MissingRole/SelectorMismatch 必须可见 ----
      # 约定：view-sentinel 将常见失败分类到 reason：missing_role | selector_mismatch | rpc | revert | unknown
      - record: view:scan_fail:rate5m
        expr: sum by(view, reason) (rate(view_scan_fail_total[5m]))

      - record: view:missing_role:rate5m
        expr: sum by(view) (rate(view_scan_fail_total{reason="missing_role"}[5m]))

      - record: view:selector_mismatch:rate5m
        expr: sum by(view) (rate(view_selector_mismatch_total[5m]))

      # ---- DataPush：事件流与“同 tx 多 push”健康度 ----
      # 约定：indexer 暴露 datapushed_events_total{data_type_hash, emitter}
      - record: datapush:events:rate5m
        expr: sum by(data_type_hash) (rate(datapushed_events_total[5m]))

      # 约定：indexer 在 ingest 阶段统计“同一 tx 内同一 data_type_hash 出现 >=2 次”的 tx 数
      # 并暴露：datapush_multi_push_txs_total{data_type_hash}
      # 同时暴露：datapush_txs_total{data_type_hash}（发生过该类型 push 的 tx 计数）
      - record: datapush:multi_push_ratio:rate5m
        expr: (sum by(data_type_hash) (rate(datapush_multi_push_txs_total[5m]))) / clamp_min(sum by(data_type_hash) (rate(datapush_txs_total[5m])), 1)

      # ---- Statistics / HealthFactor：∞ sentinel 必须单独导出 ----
      # 约定：导出端暴露 stats_global_health_factor_is_infinite（0/1）与 stats_global_total_debt_usd8（USD-8 整数）
      - record: stats:global_health_factor_infinite_and_debt_positive
        expr: (max_over_time(stats_global_health_factor_is_infinite[2m]) == 1) and (max_over_time(stats_global_total_debt_usd8[2m]) > 0)

      # 约定：对账侧同时导出 SSOT 口径 totals（同为 USD-8 整数），例如来自 indexer 的按模块聚合：ssot_global_total_debt_usd8
      - record: stats:global_total_debt_diff_usd8
        expr: abs(max_over_time(stats_global_total_debt_usd8[2m]) - max_over_time(ssot_global_total_debt_usd8[2m]))
```

#### 6.6.2 Alerts（模板）

```yaml
groups:
  - name: ssot-common.alerts
    interval: 30s
    rules:
      - alert: ViewInvalidNonWarming
        expr: view:is_problem == 1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "View invalid (non-warming)"
          description: "view={{ $labels.view }} isValid=0 且非 warming；优先排查 Registry 路由/selector mismatch/内部 revert。"

      - alert: OraclePriceInvalidNonWarming
        expr: oracle:is_problem == 1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Oracle invalid (non-warming)"
          description: "asset={{ $labels.asset }} priceValid=0 且非 warming；按 P0 排查 keeper/权限/价格过期。"

      # MissingRole 属于“读路径权限/路由配置”问题：不会自动恢复，必须显眼。
      - alert: ViewMissingRoleDetected
        expr: increase(view_scan_fail_total{reason="missing_role"}[10m]) > 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "View read blocked by MissingRole"
          description: "view={{ $labels.view }} 在过去 10m 出现 MissingRole；检查 view-sentinel 使用的调用者地址与 ACM/Registry 角色配置。"

      - alert: ViewSelectorMismatchSpiking
        expr: increase(view_selector_mismatch_total[10m]) > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "View selector/versionInfo mismatch"
          description: "view={{ $labels.view }} selector mismatch 增长；高度怀疑 Registry 路由错位/升级不一致。"

      # 同 tx 多 push 并不一定是 bug（有些类型可能设计如此），但“比例突然飙升”通常意味着重复推送/重放逻辑异常。
      - alert: DataPushMultiPushRatioHigh
        expr: max_over_time(datapush:multi_push_ratio:rate5m[10m]) > 0.2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High multi-push ratio for DataPush type"
          description: "data_type_hash={{ $labels.data_type_hash }} 同 tx 多次 push 比例异常；确认 ingest 逻辑仍按‘同 tx 取最后一条’落库。"

      # ∞ health factor 的正确语义：debt == 0。若 debt>0 仍 ∞，通常是 sentinel 处理/解码/口径错误。
      - alert: HealthFactorInfiniteButDebtPositive
        expr: stats:global_health_factor_infinite_and_debt_positive == 1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "HealthFactor is infinite but debt > 0"
          description: "全局 debt>0 但 healthFactor=∞；检查 MaxUint256 sentinel 映射与 stats 导出逻辑。"

      # 统计 totals 的对账口径：以 USD-8 整数比较，并设置容差（阈值需按业务规模调整）。
      - alert: StatsTotalDebtReconcileDiffHigh
        expr: max_over_time(stats:global_total_debt_diff_usd8[10m]) > 100000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Statistics totals differ from SSOT (debt)"
          description: "USD-8 整数 diff 过大；先排查 oracle validity/graceful degradation、同 tx 多 push 处理、以及展示层格式化导致的误判。"

      # （可选）CI/E2E Gate：把“是否 clean pass”也做成 Prometheus 告警
      # 约定：CI 跑完 advanced batch + quantify 后，把结果 push 到 Pushgateway（或你现有的 metrics 汇聚服务）。
      # 推荐暴露：e2e_clean_pass{suite="advanced"}=1/0、e2e_order_details_err_total{suite="advanced"}、e2e_artifacts_ok{suite="advanced"}=1/0。
      - alert: E2EAdvancedBatchNotCleanPass
        expr: max_over_time(e2e_clean_pass{suite="advanced"}[6h]) == 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "E2E advanced batch is not a clean pass"
          description: "advanced batch 最近一次验收不是 clean pass；优先看 orderDetailsErrTotal / artifacts ok=false / checkpoint_pre_extras_after_all_repaid。"
```

> 口径提醒（避免误用）：
> - `StatisticsView` totals 是 **USD-8 整数**，不要把格式化后的小数串当成严格对账依据。
> - 不要在告警里用 `LoanNFT.status` 作为“债务是否清零/是否清算完成”的 SSOT。

---

## 7. 事故执行入口

监控相关的第一响应 Runbook 已迁移到 [docs/Usage-Guide/runbook/README.md](runbook/README.md)。

统一入口：

- RPC / fork 节点异常：看 runbook 第 7.1 节
- Oracle stale / invalid：看 runbook 第 7.2 节
- View invalid / selector mismatch：看 runbook 第 7.3 节
- Reward 对账、拆分异常、镜像缺失：看 runbook 第 7.4 到 7.6 节

本文从这里开始只保留可观测性设计、指标和告警口径，不再重复维护第一响应步骤。

---

## 8. 与 Release Gate 的联动（上线前硬闸）

上线前必须满足：

- P0 告警规则启用且通知链路已通
- `view-sentinel` 运行 ≥ 24h，`view_is_valid==1`
- Oracle `oracle_price_valid==1` 且 `oracle_price_age_ratio` 长时间处于安全区间
- `chain_indexer_lag_blocks` 低于阈值
- Reward/AI Credits 对账作业已跑通并可追溯

---

## 9. 最小可用落地（MVP）建议

3 天内先跑起来：

1) RPC + View + Oracle 三类 P0 告警
2) Reward/AI Credits 对账指标（每小时）
3) 清算 backlog（需要 index/扫描支撑）

---

## 10. 附录：建议纳入“可观测性证据”的产物

- E2E 的 `manifest.json`（失败脚本分类、耗时分布）
- fork-node stderr（missing trie node / HH604 / panic）
- 对账报告（Reward、AI Credits、Ledger 平衡、事件完整性）

# 链下 View 一致性消费 / 重试 / 审计设计（配合 Phase 0-4）

本文档用于**链下设计与落地**，基于以下链上与文档约定：
- `docs/Cache-Push-Manual-Retry.md`：缓存推送失败的手动重试方案（事件 → 队列 → 人工/脚本重推）
- `docs/Architecture-Concurrent-Update-Plan.md`：并发更新改进路线（Phase 0-4）
- `docs/Architecture-all.md`：全局系统的“indexer / worker / ledger / 观测”组织方式
- `docs/FRONTEND_CONTRACTS_INTEGRATION.md`：前端与合约集成、以及 `CacheUpdateFailed` 前端配合建议

目标：把 **Phase 4（高一致消费与审计）** 与 **Phase 0/1（链下节流/顺序消费）** 在链下落成可执行的工程方案，并明确前端如何接入。

---

## 1. 范围与边界

### 1.1 关注对象
- **链上写入 View 的“推送路径”事件**：由 `VaultRouter` 发出的推送事件（含 `requestId/seq`）
- **链上推送失败事件**：`CacheUpdateFailed`、`HealthPushFailed`
- **链下消费结果与审计**：apply 日志、拒写原因统计、重试状态机、告警

### 1.2 不在本设计范围
- 业务账本（CollateralManager / LendingEngine 等）的核心一致性：链上已经保证
- 前端直接执行 admin 重试：**禁止**（前端仅调用后端 API，由后端鉴权后执行）

---

## 2. 关键语义（必须统一口径）

### 2.1 `nextVersion`（严格）与链下意义
- 链上 `PositionView`/`StatisticsView` 实现了严格规则：当 `nextVersion != 0` 时必须满足 `nextVersion == currentVersion + 1`，否则 revert。
- 链下的“强一致消费器”不负责“纠正版本”，只负责：
  - **有序消费并落库（materialized view）**
  - 对 `StaleVersion/OutOfOrderSeq/InvalidDelta` 等拒写进行**记录与告警**
  - 对失败事件产生**可重试任务**（重读账本后再推）

### 2.2 `requestId`（版本绑定 O(1) 幂等）与链下意义
- 链上仅记录 `(user, asset) -> lastAppliedRequestId`，用于同版本重放的幂等忽略（不 SSTORE、不会重复写缓存）。
- 链下必须实现自己的幂等与去重（不可依赖链上 storage）：
  - **事件入库幂等键**：推荐 `(chainId, txHash, logIndex)` 或 `(blockNumber, logIndex)`（如有最终性保障）
  - **作业幂等键**：推荐 `job_id`（UUID）+ `(user, asset, view)` 租约锁
  - `requestId` 用于跨系统追踪（UI/日志/审计），并可作为“业务去重键”的补充维度

### 2.3 `seq`（可选严格递增）与链下意义
- 链上可对 `seq` 做严格递增校验（非递增 revert），同时对同 `requestId` 的重放应优先按幂等忽略处理。
- 链下消费建议：**默认用 `(blockNumber, logIndex)` 排序**；如果业务侧能保证 `seq` 全局或 per-key 单调，则可用于更强的乱序检测与告警。

---

## 3. 链下组件拆分（建议最小可用 → 完整）

### 3.1 组件清单
- **Chain Indexer（EVM Logs）**
  - 订阅并解析 `VaultRouter` 事件与 `CacheUpdateFailed/HealthPushFailed`
  - 写入 `chain_events`（append-only）并可选发布到消息队列（Kafka/Redis Stream）
- **Strong-Consistency Consumer（Phase 4）**
  - 按序消费 `chain_events`，写入 apply 日志
  - 维护物化视图（DB cache mirror）用于前端快速查询/聚合
- **Cache Retry Worker（Manual-Retry）**
  - 监听 `CacheUpdateFailed` → 生成 `cache_retry_jobs`
  - 支持人工触发/自动小次数重试（指数退避）
  - 重试前重读账本（链上读 CM/LE 或直接调用链上 `retryUserPositionUpdate`）
- **Ops/Admin API**
  - 查询队列、审计、触发重试、批量重试、ignore/deadletter
  - 严格鉴权与审计记录
- **Frontend Integration**
  - 用户侧提示与状态展示
  - 运营/管理员控制台：队列处理、重试与审计

### 3.2 最小可用（MVP）
- Indexer → `chain_events`
- Retry Worker → `cache_retry_jobs`（人工重试为主）
- 前端仅展示“缓存更新失败已排队”提示（无需强一致物化视图）

### 3.3 完整形态（推荐）
- Strong-Consistency Consumer 落地物化视图 + apply log
- 告警面板 + 指标
- 前端可展示“缓存状态/版本/最后同步时间/失败原因摘要”，并提供“申请重试”

---

## 4. 数据模型（Postgres/Timescale 适用）

### 4.1 `chain_events`（append-only）
用于保存链上事件原始信息与解析后的字段，建议包含：
- `id` (bigserial pk)
- `chain_id` (int)
- `block_number` (bigint)
- `tx_hash` (text)
- `log_index` (int)
- `contract_address` (text)
- `event_name` (text)
- `topic0` (text)
- `payload` (jsonb) — 完整解析参数（包含 user/asset/requestId/seq 等）
- `request_id` (text/null) — 若事件含 requestId 可冗余存一份（便于检索）
- `created_at` (timestamptz)

唯一索引建议：
- `unique(chain_id, tx_hash, log_index)`

### 4.2 `view_apply_log`（Phase 4：apply 审计日志）
记录链下“消费与落库”的全过程，推荐：
- `id` (uuid pk)
- `chain_id`, `block_number`, `tx_hash`, `log_index`
- `event_name`
- `view_kind` (enum: position/user/risk/statistics/asset_stats/health/unknown)
- `key_user` (address/null), `key_asset` (address/null)
- `request_id` (bytes32 hex/null), `seq` (bigint/null)
- `apply_status` (enum: applied/ignored/duplicate/rejected/error)
- `reject_code` (text/null) — 例如 `stale_version/out_of_order_seq/invalid_delta/reorg_conflict/...`
- `reject_detail` (jsonb/null)
- `observed_at` (timestamptz)

唯一索引建议：
- `unique(chain_id, tx_hash, log_index)`（与 chain_events 对齐）

### 4.3 `position_cache_mirror`（物化视图：可选，但推荐）
用于前端“免 RPC”展示，以及风控/运营聚合：
- `user` (address)
- `asset` (address)
- `collateral` (numeric)
- `debt` (numeric)
- `version` (bigint)
- `last_request_id` (text/null)
- `last_seq` (bigint/null)
- `last_chain_block` (bigint)
- `last_chain_tx` (text)
- `last_updated_at` (timestamptz)

主键：
- `primary key(user, asset)`

### 4.4 `cache_retry_jobs / cache_retry_audit / cache_retry_deadletters`

直接采用 `docs/Cache-Push-Manual-Retry.md` 的表结构建议，并补充两点落地约束：
- **唯一键/幂等**：建议强制唯一 `(chain_id, tx_hash, log_index)`（或 `(user, asset, view, block_number, log_index)`）避免重复入队。
- **与 Phase3/nextVersion 对齐**：重试成功的“完成标志”应以 **链上 `UserPositionCachedV2` 事件**（含 version）作为最终确认信号，而不是仅以“发起了重试交易”作为成功。

---

## 5. 事件清单与消费优先级（链下应订阅哪些事件）

### 5.1 作为“写入发生”的权威信号（推荐）
优先订阅 `PositionView` 的：
- `UserPositionCachedV2(user, asset, collateral, debt, version, ts)`
- `IdempotentRequestIgnored(user, asset, requestId, seq)`（用于监控重复重放与链下队列健康）

原因：
- `UserPositionCachedV2` 是链上缓存真实写入后的事件，包含 **version** 与最终值，链下物化视图可以直接按事件落库。
- `VaultRouter` 的 `UserPositionPushed/UserPositionDeltaPushed` 更像“请求已发起/路由已调用”的轨迹事件，**不等价于已写入成功**（写入可能在下游 revert）。

### 5.2 用于“可观测/追踪/链下重放输入”的辅助信号（建议订阅）
订阅 `VaultRouter`：
- `UserPositionPushed(...)` / `UserPositionDeltaPushed(...)`（均携带 `requestId/seq`）
- `AssetStatsPushed(...)`（如需要链下做统计镜像）

用途：
- 将 `requestId/seq` 与 `UserPositionCachedV2.version` 关联，形成可审计链路。
- 若未来要做“链下强一致 replay（在链上拒写时自动重试）”，router 事件可作为输入候选。

### 5.3 失败/告警事件（必须订阅）
订阅：
- `CacheUpdateFailed(user, asset, viewAddr, collateral, debt, reason)`
- `HealthPushFailed(user, healthView, totalCollateral, totalDebt, reason)`（如存在）

用途：
- 生成 `cache_retry_jobs`
- 做告警与 UI 提示（用户侧“缓存可能陈旧”）

### 5.4 事件 ABI 字段对照表（source-of-truth：合约源码）

**说明：**
- **topic0** = `keccak256("EventName(type1,type2,...)")`（canonical signature）
- **topics[1..]** 依次对应 `indexed` 参数（顺序与事件参数顺序一致）
- **data** 中为所有非 `indexed` 参数的 ABI 编码拼接
- 同名事件（例如 `CacheUpdateFailed`）可能在多个合约中出现：链下入库必须保留 `contract_address`，并用 `(chain_id, tx_hash, log_index)` 去重。

#### PositionView 事件

| 合约 | Event | Canonical Signature | Indexed（topics） | 非 indexed（data） | 链下建议 |
|:---|:---|:---|:---|:---|:---|
| `PositionView`<br/>`src/Vault/view/modules/PositionView.sol` | `UserPositionCached` | `UserPositionCached(address,address,uint256,uint256,uint256)` | `user: address`<br/>`asset: address` | `collateral: uint256`<br/>`debt: uint256`<br/>`ts: uint256` | **旧事件**；建议优先用 `UserPositionCachedV2`（含 version）落库。 |
| `PositionView` | `UserPositionCachedV2` | `UserPositionCachedV2(address,address,uint256,uint256,uint64,uint256)` | `user: address`<br/>`asset: address` | `collateral: uint256`<br/>`debt: uint256`<br/>`version: uint64`<br/>`ts: uint256` | **权威写入成功信号**：物化视图按该事件 upsert，并用 `version` 做单调校验。 |
| `PositionView` | `IdempotentRequestIgnored` | `IdempotentRequestIgnored(address,address,bytes32,uint64)` | `user: address`<br/>`asset: address`<br/>`requestId: bytes32` | `seq: uint64` | 用于监控重复重放/队列健康；链下可与 `requestId/seq` 关联审计。 |
| `PositionView` | `CacheUpdateFailed` | `CacheUpdateFailed(address,address,address,uint256,uint256,bytes)` | `user: address`<br/>`asset: address` | `viewAddr: address`<br/>`collateral: uint256`<br/>`debt: uint256`<br/>`reason: bytes` | 失败入队来源之一（同名事件也在其他模块出现）；`reason` 建议枚举化/截断展示。 |

#### VaultRouter 事件

| 合约 | Event | Canonical Signature | Indexed（topics） | 非 indexed（data） | 链下建议 |
|:---|:---|:---|:---|:---|:---|
| `VaultRouter`<br/>`src/Vault/VaultRouter.sol` | `UserPositionPushed` | `UserPositionPushed(address,address,uint256,uint256,uint256,bytes32,uint64)` | `user: address`<br/>`asset: address` | `collateral: uint256`<br/>`debt: uint256`<br/>`timestamp: uint256`<br/>`requestId: bytes32`<br/>`seq: uint64` | **路由轨迹事件**（请求已发起/已路由），不等价"写入成功"；用于链下追踪输入与重放线索。 |
| `VaultRouter` | `UserPositionDeltaPushed` | `UserPositionDeltaPushed(address,address,int256,int256,uint256,bytes32,uint64)` | `user: address`<br/>`asset: address` | `collateralDelta: int256`<br/>`debtDelta: int256`<br/>`timestamp: uint256`<br/>`requestId: bytes32`<br/>`seq: uint64` | 同上；若链下要构建"delta 重放"，需配合 strict `nextVersion` 策略与审计。 |
| `VaultRouter` | `AssetStatsPushed` | `AssetStatsPushed(address,uint256,uint256,uint256,uint256,bytes32,uint64)` | `asset: address` | `totalCollateral: uint256`<br/>`totalDebt: uint256`<br/>`price: uint256`<br/>`timestamp: uint256`<br/>`requestId: bytes32`<br/>`seq: uint64` | 可用于统计镜像；同样属于"路由轨迹"而非最终写入确认。 |
| `VaultRouter` | `UserPositionUpdated`<br/>（legacy） | `UserPositionUpdated(address,address,uint256,uint256,uint256)` | `user: address`<br/>`asset: address` | `collateral: uint256`<br/>`debt: uint256`<br/>`timestamp: uint256` | 兼容旧版：可不订阅；若订阅应标记为 legacy。 |

#### LendingEngineCore 事件

| 合约 | Event | Canonical Signature | Indexed（topics） | 非 indexed（data） | 链下建议 |
|:---|:---|:---|:---|:---|:---|
| `LendingEngineCore`<br/>`src/Vault/modules/lendingEngine/LendingEngineCore.sol` | `CacheUpdateFailed` | `CacheUpdateFailed(address,address,address,uint256,uint256,bytes)` | `user: address`<br/>`asset: address` | `viewAddr: address`<br/>`collateral: uint256`<br/>`debt: uint256`<br/>`reason: bytes` | 失败入队来源之一；与 `PositionView.CacheUpdateFailed` ABI 相同，用 `contract_address` 区分来源。 |
| `LendingEngineCore` | `HealthPushFailed` | `HealthPushFailed(address,address,uint256,uint256,bytes)` | `user: address`<br/>`healthView: address` | `totalCollateral: uint256`<br/>`totalDebt: uint256`<br/>`reason: bytes` | 健康推送失败监控/重试来源；通常用于告警与运维排查。 |

#### LiquidationDebtManager 事件

| 合约 | Event | Canonical Signature | Indexed（topics） | 非 indexed（data） | 链下建议 |
|:---|:---|:---|:---|:---|:---|
| `LiquidationDebtManager`<br/>`src/Vault/liquidation/modules/LiquidationDebtManager.sol` | `CacheUpdateFailed` | `CacheUpdateFailed(address,address,address,uint256,uint256,bytes)` | `user: address`<br/>`asset: address` | `viewAddr: address`<br/>`collateral: uint256`<br/>`debt: uint256`<br/>`reason: bytes` | 清算路径失败入队来源之一；同名同 ABI。 |

#### StatisticsView 事件

| 合约 | Event | Canonical Signature | Indexed（topics） | 非 indexed（data） | 链下建议 |
|:---|:---|:---|:---|:---|:---|
| `StatisticsView`<br/>`src/Vault/view/modules/StatisticsView.sol` | `DegradationStatsCached` | `DegradationStatsCached(uint256,uint256,address,bytes32,uint256,uint256,uint256,uint256)` | `lastDegradedModule: address`<br/>`reasonHash: bytes32` | `totalDegradations: uint256`<br/>`lastDegradationTime: uint256`<br/>`fallbackValueUsed: uint256`<br/>`totalFallbackValue: uint256`<br/>`averageFallbackValue: uint256`<br/>`timestamp: uint256` | 系统级降级统计：用于链下监控与运营面板聚合；可与 `DegradationMonitor` 的链下指标汇总对齐。 |

#### ViewCache 事件

| 合约 | Event | Canonical Signature | Indexed（topics） | 非 indexed（data） | 链下建议 |
|:---|:---|:---|:---|:---|:---|
| `ViewCache`<br/>`src/Vault/view/modules/ViewCache.sol` | `CacheUpdated` | `CacheUpdated(address,address,uint256)` | `asset: address`<br/>`updater: address` | `timestamp: uint256` | 系统级快照写入成功信号；链下如维护系统快照镜像可直接以该事件为准。 |

#### AccessControlView 事件

| 合约 | Event | Canonical Signature | Indexed（topics） | 非 indexed（data） | 链下建议 |
|:---|:---|:---|:---|:---|:---|
| `AccessControlView`<br/>`src/Vault/view/modules/AccessControlView.sol` | `PermissionDataUpdated` | `PermissionDataUpdated(address,bytes32,bool,uint256)` | `user: address`<br/>`actionKey: bytes32` | `hasPermission: bool`<br/>`timestamp: uint256` | 权限位变更事件：链下可用于权限变更审计与前端权限提示。 |
| `AccessControlView` | `PermissionLevelUpdated` | `PermissionLevelUpdated(address,uint8,uint256)` | `user: address` | `newLevel: uint8`<br/>`timestamp: uint256` | 用户权限级别变更：链下按需建立用户权限级别镜像。 |

#### FeeRouterView 事件

| 合约 | Event | Canonical Signature | Indexed（topics） | 非 indexed（data） | 链下建议 |
|:---|:---|:---|:---|:---|:---|
| `FeeRouterView`<br/>`src/Vault/view/modules/FeeRouterView.sol` | `DataSynced` | `DataSynced(address,uint256)` | `caller: address` | `timestamp: uint256` | 数据同步轨迹事件：用于链下同步任务观测。 |
| `FeeRouterView` | `UserDataPushed` | `UserDataPushed(address,string,uint256)` | `user: address` | `dataType: string`<br/>`timestamp: uint256` | 标注为 DEPRECATED（源码注释）；链下优先使用统一 `DataPush` 事件体系（如有）。 |
| `FeeRouterView` | `SystemDataPushed` | `SystemDataPushed(address,string,uint256)` | `pusher: address` | `dataType: string`<br/>`timestamp: uint256` | 标注为 DEPRECATED（源码注释）；同上。 |

#### ModuleHealthView 事件

| 合约 | Event | Canonical Signature | Indexed（topics） | 非 indexed（data） | 链下建议 |
|:---|:---|:---|:---|:---|:---|
| `ModuleHealthView`<br/>`src/Vault/view/modules/ModuleHealthView.sol` | `ModuleHealthChecked` | `ModuleHealthChecked(address,bool,uint32)` | `module: address` | `isHealthy: bool`<br/>`failures: uint32` | 模块健康检查轨迹事件：链下可用于健康面板与告警。 |

#### HealthView 事件

| 合约 | Event | Canonical Signature | Indexed（topics） | 非 indexed（data） | 链下建议 |
|:---|:---|:---|:---|:---|:---|
| `HealthView`<br/>`src/Vault/view/modules/HealthView.sol` | `HealthFactorCached` | `HealthFactorCached(address,uint256,uint256)` | `user: address` | `healthFactor: uint256`<br/>`timestamp: uint256` | 用户健康因子缓存写入：链下可用于风控快照/回放。 |
| `HealthView` | `ModuleHealthCached` | `ModuleHealthCached(address,bool,bytes32,uint32,uint256)` | `module: address` | `isHealthy: bool`<br/>`detailsHash: bytes32`<br/>`failures: uint32`<br/>`timestamp: uint256` | 模块健康缓存：与 `ModuleHealthView` 的检查轨迹形成闭环。 |

#### EventHistoryManager 事件

| 合约 | Event | Canonical Signature | Indexed（topics） | 非 indexed（data） | 链下建议 |
|:---|:---|:---|:---|:---|:---|
| `EventHistoryManager`<br/>`src/Vault/view/modules/EventHistoryManager.sol` | `HistoryRecorded` | `HistoryRecorded(bytes32,address,address,uint256,bytes,uint256)` | `eventType: bytes32`<br/>`user: address`<br/>`asset: address` | `amount: uint256`<br/>`extraData: bytes`<br/>`timestamp: uint256` | 轻量归档事件：链下可用于统一业务事件流入库（但该合约本身不做持久化）。 |

#### 其他 View Modules（无事件 / 纯读）

说明：以下模块在当前源码中 **未定义 `event`**（通过 `src/Vault/view/modules/` 全量扫描确认）。链下如果仅做事件索引，可忽略；如果做“读路径缓存镜像”，可直接通过定时 RPC/索引数据源补齐。

| 模块（源码） | 事件 | 备注 |
|:---|:---|:---|
| `BatchView`<br/>`src/Vault/view/modules/BatchView.sol` | 无 | 纯读聚合/批量查询。 |
| `CacheOptimizedView`<br/>`src/Vault/view/modules/CacheOptimizedView.sol` | 无 | 纯读优化视图。 |
| `DashboardView`<br/>`src/Vault/view/modules/DashboardView.sol` | 无 | 纯读聚合视图。 |
| `LendingEngineView`<br/>`src/Vault/view/modules/LendingEngineView.sol` | 无 | 纯读视图。 |
| `LiquidationRiskView`<br/>`src/Vault/view/modules/LiquidationRiskView.sol` | 无 | 纯读风险视图。 |
| `LiquidatorView`<br/>`src/Vault/view/modules/LiquidatorView.sol` | 无 | 纯读/清算相关查询视图。 |
| `PreviewView`<br/>`src/Vault/view/modules/PreviewView.sol` | 无 | 纯读预览视图。 |
| `RegistryView`<br/>`src/Vault/view/modules/RegistryView.sol` | 无 | 纯读注册表视图。 |
| `RewardView`<br/>`src/Vault/view/modules/RewardView.sol` | 无 | 纯读奖励视图。 |
| `RiskView`<br/>`src/Vault/view/modules/RiskView.sol` | 无 | 纯读风险评估视图。 |
| `SystemView`<br/>`src/Vault/view/modules/SystemView.sol` | 无 | 纯读系统状态视图。 |
| `UserView`<br/>`src/Vault/view/modules/UserView.sol` | 无 | 纯读用户聚合视图（内部读取 PositionView 等）。 |
| `ValuationOracleView`<br/>`src/Vault/view/modules/ValuationOracleView.sol` | 无 | 纯读估值/预言机视图。 |

---

## 6. Strong-Consistency Consumer（Phase 4）落地方案

### 6.1 消费顺序与幂等（必须）
- **顺序**：按 `(block_number ASC, log_index ASC)` 消费（同链同确认深度内）
- **幂等**：对每条事件写入 `view_apply_log` 前先用 `unique(chain_id, tx_hash, log_index)` 判重
- **重组/reorg**（如使用 L2 也建议做最低限度支持）：
  - 对未达“最终确认深度”的事件视为 provisional，可在 `view_apply_log.reject_code = reorg_rollback` 标记并回滚物化视图（或采用“确认后再写物化视图”的策略）
  - 最简单策略：只在 `N confirmations` 后写 `position_cache_mirror`，在此之前仅写 `chain_events/view_apply_log`

### 6.2 物化视图更新逻辑（以 PositionView 事件为准）
当收到 `UserPositionCachedV2(user, asset, collateral, debt, version, ts)`：
- upsert `position_cache_mirror(user, asset)`：
  - 若 `incoming.version <= current.version`：标为 `ignored/duplicate`（理论上不应出现；出现则告警）
  - 否则更新 collateral/debt/version/last_chain_* 等字段

### 6.3 版本/幂等可观测指标（建议）
- `position_cache_mirror.version` 的单调性：按 `(user, asset)` 统计版本是否出现回退/跳跃（跳跃在 strict nextVersion 下理论不应发生）
- `IdempotentRequestIgnored` 事件计数：观察链下重复提交/重试策略是否健康

---

## 7. Cache Retry Worker（Manual-Retry）落地方案

### 7.1 入队（从失败事件生成作业）
触发源：`CacheUpdateFailed` / `HealthPushFailed`

入队字段建议（最小集）：
- `chain_id, block_number, tx_hash, log_index`
- `user, asset, view_addr`
- `reason_raw`（bytes → hex/base64）、`reason_code`（可选：枚举映射）
- `status=pending`, `attempts=0`, `next_available_at=now()`

幂等键：`unique(chain_id, tx_hash, log_index)`

### 7.2 重试执行（建议默认路径）
默认建议调用链上 admin 入口：
- `PositionView.retryUserPositionUpdate(user, asset)`

理由：
- 该入口会“重读账本（CM/LE）→ 写缓存 → 发出 `UserPositionCachedV2`”
- 链下不用自己计算 delta/版本，减少复杂度与覆盖风险

### 7.3 重试前置检查（必须）
- **租约锁**：对 `(user, asset, view)` 抢锁（Redis/DB row lock），避免并发重试
- **冷却时间**：`now() >= next_available_at` 才允许执行
- **模块缓存/升级窗口**：如遇 `ModuleCacheExpired` 或依赖缺失，先引导运维执行 `PositionView.refreshModuleCache()`/`VaultRouter.refreshModuleCache()` 再重试

### 7.4 成功判定（必须用链上事件确认）
- 发起重试 tx **不等于成功**
- 以链上 `UserPositionCachedV2(user, asset, ...)` 到达并被 consumer 落库为成功信号：
  - worker 可轮询链上/或订阅 indexer 回调，匹配 `(user, asset, block>=retry_tx_block)` 的 `UserPositionCachedV2`
  - 成功后将 job 标为 `succeeded`

### 7.5 失败处理与死信
- `attempts += 1`，写 `cache_retry_audit`
- `next_available_at = now() + backoff(attempts)`（指数退避）
- 连续失败达到阈值 → `deadletter` 并告警（需人工介入）

---

## 8. Ops/Admin API（后端对前端/运维暴露）

### 8.1 用户侧（只读/申请重试）
参考 `docs/FRONTEND_CONTRACTS_INTEGRATION.md` 建议：
- `POST /cache-retry/request`
  - body：`{ user, asset, viewAddr, chainId, blockNumber, txHash, logIndex }`
  - 行为：幂等写入/更新 `cache_retry_jobs`（若已存在则返回已有状态）
- `GET /cache-retry/status?user=&asset=`
  - 返回：队列状态、最近失败原因摘要、attempts、next_available_at、最近一次成功时间（若有）

### 8.2 运维侧（管理员）
- `GET /ops/cache-retry/jobs?status=pending&limit=...`
- `POST /ops/cache-retry/retry`（支持 dry-run / force）
- `POST /ops/cache-retry/bulk-retry`
- `POST /ops/cache-retry/ignore`
- `POST /ops/cache-retry/deadletter/replay`

必须：
- 鉴权（RBAC/ACL）
- 审计（`cache_retry_audit` 写入 actor/note/before-after）
- 速率限制与并发限制（避免重试风暴）

---

## 9. 前端实施建议（用户侧 + 管理员侧）

### 9.1 用户侧提示（必须）
当 `GET /cache-retry/status` 表示存在未清理失败记录时：
- 在仓位/资产卡显示：
  - **“缓存更新失败，已排队人工处理”**
  - 最近失败时间、原因摘要（bytes reason 截断 + 枚举映射）
  - “缓存可能陈旧”的视觉标识（badge/tooltip）

### 9.2 “申请重试”按钮（可选但推荐）
- 点击调用 `POST /cache-retry/request`
- 前端不直接调用链上 admin 函数
- UI 显示状态机：queued → retrying → succeeded/deadletter
- 建议通过 WebSocket/SSE 推送状态变化（降低轮询）

### 9.3 管理员控制台（推荐）
- 队列列表：按 view/asset/user 聚合、支持搜索 `requestId/txHash`
- 一键重试/批量重试（带 dry-run）
- 死信查看与导出
- 关键指标面板：失败率、平均修复时间、积压长度

---

## 10. 监控与告警（Phase 4 的必交付）

### 10.1 指标
- `cache_update_failed_total{view,asset}`：失败事件计数
- `cache_retry_attempts_total{view}`：重试次数
- `cache_retry_succeeded_total` / `deadletter_total`
- `queue_depth{status}` / `queue_age_p95`
- `positionview_idempotent_ignored_total`：`IdempotentRequestIgnored` 计数（反映重复重放）
- `apply_rejected_total{reject_code}`：consumer 端拒写/异常统计

### 10.2 告警建议
- 某 view/asset 在 5min 内失败率突增
- 死信率超过阈值
- 队列 age 超过 SLA（如 30min/2h）
- `apply_rejected_total{stale_version|out_of_order_seq}` 异常升高（可能重试策略或并发热点问题）

---

## 11. 安全与权限

### 11.1 最小权限原则
- 用户侧 API 只能查询自己地址相关作业
- `retryUserPositionUpdate/refreshModuleCache` 的签名账户只由后端/运维持有（硬件钱包/多签更佳）

### 11.2 审计与合规
- 所有重试动作必须写 `cache_retry_audit`
- `reason_raw` 属于敏感原始数据，前端展示需枚举化/截断
- AI/Agent：只读队列与审计（禁止自动触发重试）

---

## 12. 落地清单（按 Phase 对齐）

### Phase 0/1（链下顺序/租约）——需要链下实现的交付
- [ ] indexer：稳定写入 `chain_events`（去重、顺序、确认深度）
- [ ] retry worker：实现租约锁 + backoff + 审计
- [ ] 前端：展示失败提示 + 状态查询

### Phase 4（高一致消费与审计）——当前主要“未实现部分”
- [ ] strong-consistency consumer：`view_apply_log` + `position_cache_mirror`
- [ ] 指标与告警：失败/拒写/重复重放/队列 SLA
- [ ] 管理员控制台：队列处理与审计可视化



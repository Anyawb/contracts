# 缓存推送失败的手动重试方案（设计指引）

## 背景与目标
- 在清算/借还流程中，View/Health 推送可能因依赖合约不可用或链上异常失败。
- 不采用链上自动重试（避免 Gas 暴涨与重复失败）；改为“事件告警 + 链下人工重推”。
- 目标：保障可观测性、可追溯性、可手动修复，不阻断主流程。

## 链上事件（已实现）
- 推送失败时 emit：  
  `event CacheUpdateFailed(address indexed user, address indexed asset, address viewAddr, uint256 collateral, uint256 debt, bytes reason);`
- 健康推送失败补充事件：  
  `event HealthPushFailed(address indexed user, address indexed healthView, uint256 totalCollateral, uint256 totalDebt, bytes reason);`（最佳努力不回滚，用于链下重试/告警）。
- 触发点：`VaultLendingEngine`/`LiquidationDebtManager` 推送 View 失败（依赖缺失/无代码/revert/账本读取失败）以及 `PositionView` guarded 读取失败。
- 载荷：user、asset、viewAddr（可能为 0）、尝试写入的 collateral/debt、revert reason(bytes)。主流程不回滚。

## 链下处理流程
1) 监听 `CacheUpdateFailed`，写入重试队列（含 tx hash、block time、payload，键建议 `(user, asset, view, blockNumber, logIndex)` 保证幂等）。
2) 队列记录状态机：pending/queued/retried/deadletter/ignored，记录最后一次尝试时间与尝试次数。
3) 运维/值班人工确认失败原因（依赖合约下线、升级中、数据权限等），reason 枚举化便于统计。
4) 重试策略（手动触发为主，低风险场景可配置小次数自动 + 指数退避）：
   - 重试前重新读取最新账本（collateral/debt），避免旧值覆盖新状态；链上入口可用 `PositionView.retryUserPositionUpdate(user, asset)`（admin）。
   - 若最新值与事件值不一致则标记“放弃/过期”，必要时人工确认后再推送。
   - 对同一 `(user, asset, view)` 加租约/行级锁，最小间隔限流，防多 worker 并发重放。
   - 若 view 合约版本已变更，需显式确认（防旧逻辑写入）。
5) 连续 N 次失败转入“死亡信箱”并告警，需进一步人工排查；死信记录保留原因分类，支持批量导出与 dry-run 重放。

## 前端提示（用户可见）
- 当用户存在未清理的 `CacheUpdateFailed` 记录时，在账户概览显示：
  - “缓存更新失败，已排队人工处理”
  - 最近失败时间、原因摘要（映射自 reason 枚举）与预计处理 SLA/状态
  - 若已重试成功，清除提示或展示“已恢复时间”

## 治理/维护入口（已实现 & 建议）
- 链上：`PositionView.retryUserPositionUpdate(user, asset)`（admin），刷新模块缓存→读取 CM/LE 最新账本→写缓存→ emit `UserPositionCached`；失败再 emit `CacheUpdateFailed`，幂等。
- 链上：`VaultView.refreshModuleCache()`（admin）/`PositionView.refreshModuleCache()`（admin）在模块地址变更后手动刷新 1h 模块缓存；否则推送入口遇到缓存过期或未初始化会 `ModuleCacheExpired` 直接拒绝，避免误用旧地址。推送入口自身也会在缓存失效时自动刷新一次，但建议变更后主动刷新以减少首次调用失败。
- 链下：提供脚本/API 封装上述入口，鉴权与审计（操作者、输入、输出、理由），避免循环重试。

## 修改方案更改为
- **强一致 + 事件打点**：清算/借还路径的视图推送失败会回滚主交易；缓存视图读取失败以 `CacheUpdateFailed` 打点，主流程可继续。
- **1h 模块缓存 + 自动刷新**：推送白名单基于 1h 模块缓存（CM/LE/VBL），失效时自动刷新；模块升级后应由 admin 主动 `refreshModuleCache`。
- **链下重试**：保持“事件告警 + 人工/脚本重推”模式，重推前重读账本，避免旧值覆盖。

## 观测与审计要点
- 监控指标：`CacheUpdateFailed` 事件数、按视图合约/资产/用户分布，重试成功率，平均修复时间，队列长度/年龄分布，死信率。
- 结构化日志：携带 requestId/user/view/asset/attempt，方便关联告警。
- 测试/演练：覆盖依赖合约下线、链上 revert/拥塞、账本状态变化导致重试放弃、多 worker 并发、死信回放。
- 变更风险：增加事件日志体积，可能影响少量 Gas；主流程保持不回滚（除非治理要求 “失败即回滚”）。

## 接口与表结构（示例，可按实际栈微调）

### 表设计（Postgres/Timescale 适用）
- `cache_retry_jobs`
  - `tenant_id` (text) — 多租户隔离必填
  - `id` (uuid, pk)
  - `user` (address) / `user_id` (int/uuid 可选) — 用户标识需与上游一致
  - `asset` (address)
  - `view` (address)
  - `collateral`, `debt` (numeric/decimal)
  - `reason_code` (int/enum) — 枚举化 reason
  - `reason_raw` (bytea/jsonb) — 原始 bytes/字符串
  - `request_id` (uuid/null)
  - `block_number` (bigint)
  - `log_index` (int)
  - `tx_hash` (text)
  - `status` (enum: pending/queued/retried/succeeded/ignored/deadletter)
  - `attempts` (int)
  - `last_attempt_at` (timestamptz)
  - `next_available_at` (timestamptz) — 限流/冷却
  - `created_at`, `updated_at`
  - 索引：`(user, asset, view, block_number, log_index)` 唯一；按 `status`/`next_available_at` 索引；可加 `(view, status)`。

- `cache_retry_audit`
  - `id` (uuid, pk)
  - `job_id` (uuid fk)
  - `action` (enum: enqueue, retry, succeed, ignore, deadletter)
  - `actor` (text) — 人员或服务标识
  - `note` (text/jsonb) — 输入参数、比对结果摘要
  - `tenant_id`, `request_id`, `user_id`（或地址） — 保持三键对齐便于跨层追溯
  - `created_at`

- `cache_retry_deadletters`
  - `job_id` (uuid fk)
  - `tenant_id`, `request_id`, `user_id` — 持续保留追溯键
  - `final_reason_code` (enum)
  - `final_reason_raw` (jsonb)
  - `created_at`

### API / CLI 接口（示例）
- `GET /ops/cache-retry/jobs?status=pending&limit=100` — 只读查看队列
- `POST /ops/cache-retry/retry` — 手动触发重试
  - body: `{job_id, force?:bool, dry_run?:bool}`
  - 行为：抢 `(user,asset,view)` 锁；读最新账本；若与事件值不一致且未 force 则返回 `409/expired`；dry_run 仅返回将要推送的 payload 与对比结果。
- `POST /ops/cache-retry/bulk-retry` — 批量重试（可按 view/asset/status 过滤，强制限制单次上限）
- `POST /ops/cache-retry/ignore` — 将 job 标记为 ignored（需 note）
- `POST /ops/cache-retry/deadletter/replay` — 从死信批量重放（需 dry_run，支持分页）
- `GET /ops/cache-retry/metrics` — 队列长度、年龄分布、成功/失败率
- API 入参/查询参数默认要求 `tenant_id`，建议附带 `request_id` 与 `user_id/user_address` 以便快速定位。

### 与 AI 层的边界与集成要求
- AI/LLM/Agent 仅可**读取**队列状态与审计日志用于观测，不得直接触发重试或修改状态（避免自动化误写链上）。
- 若 AI 需要辅助判断（如生成原因摘要或优先级排序），只消费 `cache_retry_jobs`/`cache_retry_audit` 的只读视图或复制表，并返回“建议”供人工确认。
- 前端/Agent 展示的原因摘要需使用枚举化 `reason_code` 映射，避免展示未经审计的 raw bytes；跨租户/多空间要在查询层强制 `tenant_id` 过滤。
- 不得将链上 payload（collateral/debt/raw reason）传入外部 LLM 服务；若用本地模型，需符合合规与数据分类要求（敏感字段可脱敏后输入）。

### Worker/并发控制
- 消费 pending/queued 任务时对 `(user, asset, view)` 申请租约（如 Redis/DB 行锁），租约过期时间 > 单次重试最长耗时。
- 重试成功或失败均写 `cache_retry_audit`，并释放租约；连续失败超阈值落死信。
- 对接链上推送时，推送请求携带 `idempotency_key = job_id`，避免重复提交。***


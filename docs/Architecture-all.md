# 总体说明（摘要）

下面把你的系统按 **前端** / **后端** / **AI（认知层）** / **API（契约层）** 四个部分做统一、详细的工程化设计，并把 Solana + Arbitrum 智能合约 的链上交互与链下账务、对账、审计、回填完整整合进来。每个部分我会列出：职责、技术栈/语言、主要组件、关键数据/表/对象、交互流程、安全与测试要点。最后给出**逐步执行顺序（含迁移/上线）**和关键监控/回滚策略。

为便于阅读，我用中文且尽量具体到可以落地的组件与接口定义。

## 一、总体架构概览（文本图）

```
用户（Web/Mobile） ⇄ 前端（Rust + Wallet adapters @ Vercel） ⇄ API Gateway（Vercel Edge/Functions） ⇄ 后端服务群（Rust 服务 @ Vercel + Rust 账务引擎）
后端与链交互：Chain Indexer（solana / arbitrum） + On-chain Relayer / Tx Submitter → 智能合约（Solana programs / Arbitrum L2 contracts）
AI 层：向量库（Milvus/Pinecone）、RAG 层（memory_records）、Agent Orchestrator（Python/Rust）、仿真服务（Rust）（独立部署，AI 使用 PostgreSQL 主库 + Redis + 向量库）
存储：Supabase Postgres（主账/bf_*，Timescale 扩展用于时序）+ Supabase Storage（archives）；AI 数据存储：PostgreSQL（AI 主库）+ Redis（缓存/队列）+ 向量库（Milvus/Pinecone）
消息总线：Kafka（事件流）；观察：OpenTelemetry / Prometheus / Grafana
```

## 二、前端（Frontend）—— 用户界面与用户交互层

### 1. 职责与目标

- 提供安全的钱包连通、签名交互、交易预览与提交、借贷/抵押/赎回/积分管理 UI
- 展示行为金融指标（情绪指数、仿真结果、策略建议）并提供 AI 聊天/建议面板
- 支持多租户（按组织白标）、多网络（Solana、Arbitrum）切换

### 2. 技术栈 / 语言

- **框架**：Rust（Yew / Leptos / Dioxus，支持 SSR/CSR 混合）
- **类型**：Rust（强类型系统）
- **UI**：Rust UI 框架（如 Yew 组件库、Leptos UI）或 WebAssembly + 现代 CSS；设计系统（tokens）
- **钱包 / 链适配**：
  - Solana：Rust Solana SDK（`solana-sdk`、`solana-client`）与钱包适配器（Rust 实现）
  - Arbitrum（EVM）：Rust Web3 库（`ethers-rs`、`alloy-rs`）与钱包连接
- **通信**：Rust HTTP 客户端（`reqwest`、`ureq`）+ GraphQL 客户端（`graphql_client`）+ WebSocket（`tokio-tungstenite`，实时推送）
- **测试**：Rust 测试框架（`cargo test`）+ 集成测试 + Playwright（E2E）
- **部署/托管**：Vercel（Edge/SSR，静态资源 CDN；环境变量托管）
- **国际化(i18n)**：Rust i18n 库（`fluent`、`i18n-embed` 等，支持中文/英文）

### 3. 主要组件与结构

- **Layout / Multi-tenant theme loader**（读取 `tenant_id`，加载主题/brand）
- **WalletPanel**（连接/网络切换/签名请求/nonce 显示）
- **Borrow/Lend Flow UI**（输入、模拟、预览、签名）
- **Transaction Queue / Status Center**（本地 tx queue，optimistic UI）
- **AI Agent Chat**（右侧可折叠，向后端 chat API 发送消息，显示建议/策略）
- **BF Dashboard**（情绪指数、因子图、仿真结果、回测指标）
- **Admin Console**（回填工具 / 对账面板 / 修复请求）

### 4. 与链的交互（前端侧）

所有链上操作仅 **构建交易数据并请求用户钱包签名**；实际序列化与提交可在前端直接发给 RPC，也可经后端 relayer（取决安全策略）。

**提交选项**：

- 直接前端签名并提交 RPC（适合用户自己付费 gas）
- 对需要平台代付/托管的操作，前端签名后把签名发给后端 relayer（后端持有 tx submit rights）
- 显示交易详情时必须展示 `request_id`、`nonce`、预估 gas、手续费 token、回滚说明

### 5. 安全要点

- 不在前端持有用户私钥；仅请求签名
- 强制使用 HTTPS + CSP + Subresource Integrity
- 前端对所有敏感操作启用 2FA / WebAuthn（可选）和操作确认弹窗
- 对 relayer 模式，前端必须展示"事务由平台替你提交"并明确费用

### 6. 可观测 & 测试

- 前端注入 OpenTelemetry traces（trace 分派 `request_id`）
- 自动化测试覆盖关键 flows（借贷、赎回、签名、回滚）
- Playwright 跨链 E2E（模拟 Solana/Arbitrum 钱包）

## 三、后端（Backend）—— 服务、账务、链桥与对账

### 总体职责

提供业务 API、进行链下核算与双边账务、处理链上回调/事件、对账/回填、管理 relayer、调度 AI 作业

### 1. 技术栈 / 语言（按职能划分）

- **API 层、业务逻辑**：Rust — 易部署、并发好、生态成熟、内存安全
- **账务核心**（强一致性、数值安全）：Rust — deterministic decimal math (no float), high performance
- **链 Indexer / Relayer**：Rust（Indexer 推荐 Rust for Solana high perf；Arbitrum indexer 同样使用 Rust）
- **DB**：Supabase Postgres（`bf_*` 主库，Timescale 扩展做时序/分析）；AI 侧使用 PostgreSQL（AI 主库）+ Redis + 向量库（Milvus/Pinecone）
- **消息**：Kafka（事件流）
- **缓存**：Redis Cluster
- **向量**：Milvus（AI embeddings）
- **运行/托管**：Vercel（Serverless/Edge Functions + Cron/Queues）；必要的长跑链节点与 worker 可自托管（Rust）

### 2. 服务划分（微服务）

- **api-gateway**（Auth、速率限制、`request_id` 注入）
- **user-service**（用户、KYC、权限）
- **ledger-service**（Rust）：双边账写入、幂等检查、逆向 entry 生成、CHECK constraints enforcement（交易级事务）
- **reward-service**（积分域，Rust）：积分发放/消耗镜像写入 `platform_ledger` 链接
- **bf-service**（行为金融层，Rust）：模型管理、仿真触发、`bf_events` 管理
- **chain-indexer-solana**（Rust）：监听 Solana program logs, parse events, write to `chain_events` 表 + Kafka
- **chain-indexer-arbitrum**（Rust）：监听 Arbitrum L2 transactions / logs via archive node or indexer, write events
- **relayer-service**（Rust，安全）：接受签名或未签名 txs，提交给对应链 RPC（带防重放/nonce manager）
- **reconciliation-service**（Rust）：三维配对对账（`request_id` + `tenant_id` + `user_id`），生成差错 report 与修复建议
- **admin-tools**（Rust CLI）：回填脚本、archive、migration helpers
- **cache-retry tooling**（运维脚本/小服务，可与 admin-tools 并列）：监听 `CacheUpdateFailed` 事件入队、人工触发重试、死信导出/重放、审计记录；与链上事件携带的 `request_id`/`block_number`/`log_index` 对齐，重试前必读最新账本，保证幂等与不覆盖新状态。

### 3. 链上/链下一致性模式

**事件流架构**：链事件（indexer）与业务事件（`bf_events` / ledger writes）均流入 Kafka，`reconciliation-service` 联合扫描。

**两类事务**：

- **仅链上变更**（用户直接签发） → indexer 捕获，生成 `chain_event` -> match 到 `request_id`（若前端包含 `request_id` 在 tx metadata） -> 写入 ledger（append-only）
- **链下触发并上链**（平台发起，例如抵押清算） → 后端创建 tx payload -> 前端或 relayer 签名 -> 后端/relayer 提交 -> indexer 捕获回执并与原 `request_id` 关联 -> ledger 写入

### 4. Ledger 写入流程（关键）

- 写前必查 `ledger_entries` 中是否存在相同 (`tenant_id`, `request_id`)：若存在且 checksum 相同 => 幂等返回。若存在但 checksum 不同 => 报错并写 `bf_events` `status=conflict`
- Ledger 写入由 Rust `ledger-service` 通过 DB 事务完成，保证 debit + credit = 0；若涉及链上 tx，写入包含 `chain_tx_hash` 与 `chain_block` metadata
- 所有写入同时 publish 到 Kafka topic `ledger.events` 用于 downstream audit/analytics

### 5. Chain Indexer 具体功能

- **Solana Indexer (Rust)**：订阅 RPC 升级（或使用 Solana blockstream），解析 program logs（Anchor/Sealevel 格式），抽取 events（借入、还款、liquidation、reward），写入 `chain_events` 表并 push 到 Kafka。解析要能读出 tx 内的 `request_id`（建议在 tx instruction data 或 memo program 中携带 `request_id`）
- **Arbitrum Indexer (Rust)**：订阅 L2 blocks / logs，通过 archive node 或者使用 TheGraph-like indexer，解析 events（ERC20 transfers, custom events）并同样写 `chain_events`

### 6. Reconciliation / 回填 / 修复

- 定期 job（Vercel Cron / Queue 触发，或自托管 Rust worker）运行对账：按 (`request_id`, `tenant_id`, `user_id`) 聚合 `chain_events` 与 `ledger_entries`
- **差错类别**：`missing_ledger` (chain 有事件但 ledger 无), `missing_chain` (ledger 有但 chain 无 — 可能平台内部记账), `mismatch_amount`, `duplicate_entries`
- **修复策略**：自动生成 compensating ledger entry（逆向 entry）并写 `bf_events`(recording repair)；对于链上无法撤销的行为，生成补偿支付或人工工单
- 回填工具需支持 dry-run、preview、批量 limit、并行并 log 每次操作 `request_id`

### 7. 安全与运维

- 所有后端服务鉴权用 mTLS + JWT（短期）/OAuth2。关键服务（relayer、`ledger-service`）仅允许内网访问并受 Vault 管理的密钥控制
- 严格 Audit trail：所有写 DB 操作写入 `audit_log`（actor, `request_id`, before/after snapshot, `tx_id`）
- 数据备份：Postgres WAL streaming + periodic logical backups到 S3（加密）

### 8. 测试

- Unit tests（Rust） + Integration tests （local chain nodes: Solana localnet、Arbitrum Goerli）
- Property-based tests for ledger invariants（debit+credit=0 always）
- Chaos tests：模拟 indexer 延迟、chain reorg（对 Arbitrum）、fork handling（Solana 根变更）

## 四、AI 层（认知层、仿真、Agent）

### 1. 总体职责

提供 RAG 支持（用 `memory_records` 做证据链）、情绪指数构建、行为金融模型的参数估计/校准、仿真与策略生成、AI agent 交互界面（聊天助手 + 自动化 agent）

### 2. 技术栈 / 语言

- **Orchestrator / Service**：Python（FastAPI）或 Rust（若需高并发）
- **数据存储**：PostgreSQL（AI 主库）+ Redis（缓存/任务队列）+ 向量库（Milvus 或 Pinecone）
- **大模型接入**：使用外部 LLM（或内部私有模型）via OpenAI-like API / local LLM（如果离线需）
- **向量搜索**：Milvus 或 Pinecone（根据你已有选型）
- **Embedding jobs**：Python（Celery/Kafka workers）进行批量嵌入
- **仿真核心**：Rust（高性能数值、保证 deterministic）或 Python（便捷但慢，可作控制面）
- **数据科学 / 回测**：Jupyter + Python (pandas, numpy, statsmodels) for offline calibration

### 3. 主要模块

- **Memory Layer Connector**：同步 `memory_records` 与向量库（保持 `vector_id` 存在 `bf_feature_vectors`）
- **RAG Service**：给 LLM 提供 context（来自 `memory_records` + `bf_snapshots` + `chain_events`）并生成解释性文本或 policy suggestions
- **Sentiment Engine**：定时 job 根据 `ingest_jobs`、news、social streams 生成 `bf_sentiment_indices`（存表并 publish）
- **Model Manager**：管理 `bf_models`、`bf_parameters`、`schema_version`，支持 A/B 版本与参数网格实验
- **Simulation Engine**：读取 model + params + `market_series` （外部 market data），运行 agent-based 仿真，输出 `bf_simulations.run_outputs` 指针
- **Agent Orchestrator**：处理用户/管理员的 AI 请求（例如"帮我找出高风险借贷组合"），会调用 RAG + simulation + ledger hooks，并返回决策建议或发起修复操作（需要严格权限）

### 4. 数据流（示例）

1. Ingest job 把新闻/社媒嵌入到 `memory_records` 与向量库；embedding job 写 `bf_feature_vectors` 指针
2. Sentiment Engine 基于 `memory_records` + market data 计算情绪指标，写 `bf_sentiment_indices`（Timescale）
3. 用户在前端请求 AI 策略 -> API 调用 RAG Service -> RAG 检索相关 `memory_records`, `bf_parameters`, `bf_sentiment_indices` -> LLM 生成建议
4. 若需要执行策略，AI 发起 `bf_event`（`request_id`）触发后端仿真与 ledger 操作（需人工或管理员授权）

### 5. 可解释性 / 审计

- 所有 AI 输出要附 evidence list（引用 `memory_record_id` 列表）
- 模型 / 参数变更写入 `bf_parameters` 并产生 `bf_snapshots`（可回放）
- Agent actions 必须包括 `created_by`（`agent_id`）与 human approver（若自动发起资金操作）

### 6. 性能与可靠性

- Embedding batch jobs 并行化，使用 Kafka 分发数据给 worker
- LLM 请求熔断、速率限制、缓存（对重复 prompt）
- 关键 AI Ops 有 dry-run 模式，并且唯一 `request_id` 贯穿以便审计

## 五、API 层（契约、端点、消息）

### 1. API 网关责任

鉴权（OAuth2 / JWT）、速率限制、`request_id` 注入、多租户路由（Vercel Edge/Functions，按 tenant 路由到 Supabase Postgres 分片或限流），OpenAPI 规范发布

### 2. 主要 REST / GraphQL 端点（示意，OpenAPI 可扩展）

#### 身份与租户

- `POST /auth/login`（issue JWT）
- `GET /tenants/{tenant_id}/config`（返回主题/权限/limits）

#### 链交互

- `POST /chain/tx/prepare` → 返回 tx payload + `request_id`（平台/前端可签名）
- `POST /chain/tx/submit` → 提交 signed tx（若 relayer 模式），返回 `tx_hash`
- `GET /chain/tx/{tx_hash}` → 查询链上状态

#### 业务（借贷）

- `POST /api/v1/loans/borrow {amount, asset, collateral, request_id, wallet_address}` → 返回 `tx_payload` 或 success queue id
- `POST /api/v1/loans/repay`
- `GET /api/v1/loans/{loan_id}`

#### 行为金融（UBFM）

- `POST /api/v1/bf/models/{model_id}/run {request_id, param_overrides, dataset_refs}` → 返回 `simulation_id`
- `GET /api/v1/bf/simulations/{id}/status`
- `GET /api/v1/bf/sentiment?asset=AAPL&period=1d`

#### Ledger / 对账

- `POST /api/v1/ledger/post {request_id, tenant_id, entries[]}` → `ledger-service` 写入（幂等）
- `GET /api/v1/ledger/entries?request_id=...`
- `POST /api/v1/reconcile/run {since, tenant_id}` → 触发对账 job（返回 `job_id`）

#### AI / Agent

- `POST /api/v1/ai/chat {request_id, tenant_id, user_id, prompt, context_refs[]}` → 返回 `message_id` + content + `evidence_refs`
- `POST /api/v1/ai/action/authorize` -> 人工批准 agent 发起的账务/链上操作

#### Admin / Repair

- `POST /admin/repair {request_id, tenant_id, op_type, target_ids, dry_run}`
- `GET /admin/audit/{request_id}`

### 3. WebSocket / Event Stream

- `/ws/txs`：实时交易状态更新（`tx_hash`、`request_id`、status）
- `/ws/reconcile`：对账 job progress

### 4. Contracts for payloads (关键字段)

所有重要请求必须包含 `request_id`（UUID v4）、`tenant_id`、`created_by`、`signing_metadata`（若上链）

**Ledger entry 格式示意**：

```json
{
  "request_id": "uuid",
  "tenant_id": "uuid",
  "entries": [
    {"account_id":"...","debit":12345,"credit":0,"currency":"USDC"},
    {"account_id":"...","debit":0,"credit":12345,"currency":"USDC"}
  ],
  "metadata": {"chain_tx_hash":"0x...", "simulation_id":"..."}
}
```

### 5. 安全与流控

- Rate limits per tenant & per user
- Sensitive endpoints (`ledger.post`, `admin.repair`, `ai.action.authorize`) require ACL + 2FA approvail

## 六、链上智能合约集成细节

（待补充）

### 6.x 缓存推送失败的手动重试方案（链上事件 + 链下重推）

- **链上事件**：`CacheUpdateFailed(address indexed user, address indexed asset, address viewAddr, uint256 collateral, uint256 debt, bytes reason)`  
  - 触发点：`VaultLendingEngine`、`LiquidationDebtManager` 在推送 View 失败（模块缺失/无代码/调用 revert/账本读取失败）时 emit，主流程不再回滚。  
  - 载荷：user、asset、viewAddr（可能为 0）、尝试写入的 collateral/debt、revert reason（原始 bytes）。
  - HealthView 推送失败补充事件：`HealthPushFailed(address indexed user, address indexed healthView, uint256 totalCollateral, uint256 totalDebt, bytes reason)`（便于链下重试/告警，最佳努力不回滚）。
- **链上重试入口**：`PositionView.retryUserPositionUpdate(user, asset)`（仅 admin）  
  - 行为：刷新模块缓存 → 直接读取 CM/LE 最新账本 → 写入缓存并再 emit `UserPositionCached`；若读取仍失败，会再次 emit `CacheUpdateFailed` 并返回，保证幂等。  
  - 使用场景：链下监听到事件后，由运维/值班账户触发手动重推。
- **链下后端/运维配合**：  
  - 监听 `CacheUpdateFailed` → 入重试队列（含 tx_hash / block_number / log_index / request_id 等）→ 值班或自动策略调用 `retryUserPositionUpdate`。  
  - 队列表建议：`cache_retry_jobs`（唯一键 `(user, asset, view, block_number, log_index)`，含 status/attempts/next_available_at/reason_raw/request_id/tx_hash），`cache_retry_audit`，`cache_retry_deadletters`。  
  - 告警：按 view/asset/user 聚合事件数、重试成功率、死信率。
- **前端配合**：  
  - 当某用户/资产存在未处理的失败记录时，提示“缓存更新失败，已排队人工处理”，展示最近失败时间/原因。  
  - 可选“申请重试”按钮，调用后端 API（前端不直接持有 admin 角色）。  
- **设计取舍**：业务流程保持可用性，缓存同步失败不再阻断；一致性通过链下重试与人工兜底，重试时读取最新账本保证幂等、不覆盖新状态。

## 七、数据模型/数据库整合要点（回顾与补充）

已前面 `bf_*` 设计为基础，补充 `chain_events`、`chain_tx_meta`、`tenant_shard_map` 表

- **`chain_events` 字段建议**：`id`, `object_id`, `tenant_id`, `chain`, `tx_hash`, `log_index`, `event_type`, `payload(jsonb)`, `request_id`, `created_at`
- **`ledger_entries` 增加字段**：`chain_tx_hash`, `chain_block_number`, `chain_confirmations`
- **`cache_retry_jobs`**：缓存推送失败队列表，唯一键 `(user, asset, view, block_number, log_index)`，含 `status/attempts/next_available_at/reason_code/reason_raw/request_id/tx_hash` 等。
- **`cache_retry_audit`**：记录 enqueue/retry/succeed/ignore/deadletter 操作与操作者、输入、输出摘要。
- **`cache_retry_deadletters`**：存多次失败后归档的原因/原始载荷，支持批量导出与重放。
- **AI 层边界（与重试队列交互）**：AI/Agent 仅可读队列与审计数据用于分析/排序，输出“建议”由人工确认；禁止直接改写队列表或发起链上重试。跨租户查询必须强制 `tenant_id` 过滤，敏感 payload 不得传入外部 LLM。
- **三键贯穿（`request_id` / `tenant_id` / `user_id`）**：所有链上事件、队列表、审计表、API 入参与监控/告警都需显式携带并过滤这三项；若用户以地址表示，应有 `user_id` ↔ address 映射。对账与幂等依赖三键对齐，缺任意键均视为不合规。
- **账务字段补充（防篡改/零差校验）**：
  - `domain`：账务域（如 reward / cash / platform），用于路由与核算隔离。
  - `checksum`：分录级零差校验哈希（含 amount/direction/account_id 等），对账作业需复算验证。
  - `prev_entry_hash`：哈希链，防篡改；按 `tenant_id` 或账本分片串联。
  - `sequence`：分录序号/行号，防乱序，便于一请求多分录的排序与重建。

## 八、执行顺序（详细分步，按周划分，可根据资源并行化）

假设你有 4 个开发团队并行（前端、后端、AI、智能合约/链）。下面给出一个可执行的 10 周路线（可并行缩短/延长）。

### 准备期（Week 0）

- 完成详细 RFC（含本设计），确认技术栈、人员分配、SLA
- 建立 Vercel 项目环境（dev/staging/prod）与 Supabase 项目（Postgres + Timescale 扩展），配置 Kafka（托管，如 Confluent Cloud）、Redis（托管），启动 Milvus 或接通 Pinecone，准备 Supabase Storage bucket
- 准备 localchain 工具（Solana localnet, Arbitrum testnet / local node）

### Phase 1：基础设施与 schema（Week 1–2）

- **后端**：创建 `bf_*` 表、ledger schema、`chain_events` 表（提供 migration scripts；运行在 Supabase Postgres/Timescale）
- **DevOps**：配置 Kafka（托管）、Redis（托管）、Milvus 或 Pinecone；完成 Supabase migration pipeline；Vercel 环境变量/密钥注入
- **Chain team**：部署智能合约到 testnet（Solana devnet, Arbitrum Goerli），设计事件格式（必须包含 `request_id`，可选 `user_id`/address，`tenant_id` 如适用）
- **API**：实现基础 auth + gateway，定义 OpenAPI 初版
- **三键基线**：迁移脚本与初版 API 约定所有写请求必须携带 `request_id` / `tenant_id` / `user_id`（或 address+映射）；幂等唯一索引方案在此阶段确定。

**交付物**：DB migration scripts、testnet contracts、API spec（v0）

### Phase 2：Indexer + Relayer + Ledger 基础（Week 3–4）

- **Chain indexer**：实现 Solana & Arbitrum indexer，写入 `chain_events` -> Kafka
- **Relayer**：实现 tx submit + nonce manager（测试 env）
- **Ledger-service（Rust）**：实现写入、幂等检测、debit+credit 校验、publish `ledger.events`
- **Reconciliation-service**：实现最小版对账 job（report）
- **幂等键统一（后端落地）**：
  - Kafka/链事件 schema 固定 `{request_id, tenant_id, user_id}`，消费侧按三键去重；缺键拒绝/告警。
  - Relayer / tx submit 使用 `idempotency_key = request_id`（或 `tenant_id:request_id`），无 key 拒绝。
  - Ledger-service 唯一索引统一 `(tenant_id, user_id, request_id, operation_type)`；多分录场景需增 `entry_type`/`line_no` 防冲突；平台侧无 user 时 `user_id=NULL` 但保留其余键。
  - 对账/Reconciliation 以三键对齐链上事件、ledger、明细（如 ai_usage_detail）。
  - Indexer 回写 `chain_events` 保留 `tx_hash, log_index` 仅作补充，不替代三键。
  - 账务字段落地：`domain`、`checksum`（分录哈希）、`prev_entry_hash`（哈希链）、`sequence`（行号）写入 `ledger_entries`/`platform_ledger`/`reward_ledger`；Ledger-service 写入时生成并校验零差（同一 request 内 debit=credit），并串联哈希链。

**交付物**：indexers、`ledger-service` 可在 staging 执行 end-to-end（chain tx -> indexer -> ledger match）

### Phase 3：前端基础 + Wallet 集成（Week 4–5）

- **前端**：实现 WalletPanel、Borrow/Lend flow UI stub（与 mock API 交互）
- **前端/chain**：实现 `tx.prepare` -> wallet.sign -> `tx.submit` 流程（支持 memo `request_id`，并携带 tenant/user 标识到链上 metadata）
- **E2E**：模拟用户签名并检测 indexer 捕获 event
- **三键校验**：E2E 需验证前端→链→indexer→ledger 全链路三键不丢失。

**交付物**：可在 devnet 完整走通一次借贷 tx

### Phase 4：AI 层初始（Week 5–7）

- **Memory connector**：嵌入 pipeline + Milvus 保存，`bf_feature_vectors` 互联
- **Sentiment Engine**：从 sample `ingest_jobs` 生成 `bf_sentiment_indices`（Timescale）
- **RAG/Agent**：实现简单 chat endpoint，返回 evidence refs 与 LLM 输出（dry run 模式）
- **Simulation engine**：实现 baseline仿真，用 `bf_models`/`params` 执行 1 次 run 并产出 `bf_simulations`
- **数据隔离/幂等传递**：若 AI/向量写入由业务请求触发，三键随 metadata/字段入库；强制 `tenant_id` + `user_id` 过滤，敏感 payload 不出网。

**交付物**：AI chat + sentiment index basic pipeline

### Phase 5：完整业务流与对账（Week 7–8）

- **后端**：挂起 ledger post on `chain_event`（自动或人工触发），security hardening
- **Reconciliation**：生成差异报告并实现自动逆向 entry（dry-run + manual approve）
- **前端**：实现交易队列、tx 状态追踪、AI agent 在 UI 的嵌入
- **重试/缓存与幂等**：接入 `cache_retry_jobs/audit/deadletters`，保证三键写入；对账覆盖链上、ledger、AI 明细与重试队列一致性。

**交付物**：完整链上/链下写入与对账闭环（staging）

### Phase 6：灰度+监控（Week 9）

- **Shadow writer**：并行写入旧表与新 `bf_*` 表并比对一周（或 N 天）
- **监控**：Prometheus + Grafana dashboards（ledger write latency, chain lag, indexer lag, reconciliation failures）
- **SLO 设置 & 演练**：故障注入（indexer 延迟，DB 锁）并验证回滚路径；监控/告警必须包含三键维度（按 tenant/user/request 聚合与下钻），缺键视为告警；增加账务完整性监控（checksum/hash 链校验失败告警，debit/credit 零差异常告警）。

**交付物**：灰度报告、修复清单

### Phase 7：上线 & 运营（Week 10）

- 切换写路径（feature flag），启用 full auditing
- 运行 24/7 监控，开启 alert（对账失败、ledger mismatch、replayer errors）
- 定期审计：每日 integrity check job, 每周 manual review
- 上线验收：抽样核对三键贯穿（链上事件 ↔ 链下 ledger ↔ cache retry / audit / AI 只读视图），发现缺键视为阻断项。

## 九、测试计划（概要）

- **单元测试**（每服务）
- **集成测试**（chain indexer + ledger + db）
- **合约测试**（Anchor / Hardhat）
- **Property tests** for ledger invariants
- **E2E**（Playwright）覆盖主要 UI flows
- **Security tests**：密钥轮换、Vault 敏感字段测试、pen-test

## 十、监控、告警与 SLO（要点）

- **关键 SLO**：ledger write latency < 200ms（avg），indexer lag < 5s（devnet）或 < 30s（mainnet），reconciliation job completion < 20m/day
- **告警**：未对账 > threshold, chain reorg detected, relayer fail rate > X%
- **审计 retention**：`audit_log` 保留至少 2 年（加密存储），`bf_snapshots` 长期保留（7 年或按合规）

## 十一、回滚与补偿策略（要点）

- **不做删除**：所有修复通过 compensating ledger entries（逆向条目）实现
- **feature flag**：写路径可通过开关回退到旧 writer
- **数据回滚**：若 migration 错误，用 logical backup + replay event 恢复（避免 drop）

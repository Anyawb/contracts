# AI Credits（按次计费）— 链上购买 + 链下扣次 + 多租户对账（统一规范）

> 适用场景：单模型、单价（1 次 = 1 积分）、AI 调用失败必退款（不扣次）；积分可通过 USDC/USDT 购买次数包；前端为多租户（tenant）。
>
> 目标：**不牺牲 AI 使用体验**（每次调用不要求链上交易/签名），同时保持**链上可审计凭证（B：链上余额）**与**链下幂等扣费**一致。

> 配套入口文档（前端与合约集成总览）：`docs/FRONTEND_CONTRACTS_INTEGRATION.md`

---

## 0) 术语与 SSOT

- **Credit**：一次 AI 调用的计费单位。本文约定 **1 Credit = 1 次调用**。
- **Points**：项目积分代币 `RewardPoints`（ERC20, 18 decimals）。
- **SSOT（Source of Truth）**：
  - **链上 SSOT（余额凭证）**：`AICreditsVault.creditsBalance(tenantId, user)`（链上余额，B）
  - **链下 SSOT（实时可用/用量）**：后端 `usage_ledger`（用于高频扣次、并发、失败退款、幂等）
  - **最终一致性**：链下实时扣次；链上通过 **批量结算**（batch settle）周期性扣减链上余额并发事件用于审计。

---

## 1) 全局不变量（必须满足）

### 1.1 幂等不变量

- **购买幂等**：同一个 `clientOrderId`（同一 tenant、同一 user）最多生效一次。
- **请求幂等**：同一个 `requestId`（同一 tenant、同一 user）最多扣 1 次；失败必退款，不允许“扣了不退”。
- **结算幂等**：同一个 `settlementBatchId` 只允许在链上结算一次。

### 1.2 对账恒等式（UI/审计必须使用）

对任意 `(tenantId, user)`：

- **链下实时口径**：
  - `availableRealtime = creditsPurchasedOnchain - creditsSettledOnchain - creditsReservedOrChargedOffchain + creditsRefundedOffchain`
  - 实现上建议直接由后端给出 `availableRealtime`，前端不在本地自行推导（避免并发/延迟误差）。

- **链上可审计口径**（最终一致）：
  - `creditsBalanceOnchain` 将在批量结算后逐步逼近 `availableRealtime`。

---

## 2) 链上合约：AICreditsVault（购买次数包 + 链上余额 B）

> 设计目标：**链上维护 creditsBalance（B）**；购买时接收 USDC/USDT；高频扣次不在链上发生，改为链下扣次 + 链上批量结算。

### 2.1 核心存储（建议）

- `mapping(bytes32 tenantId => mapping(address user => uint256 creditsBalance))`
  - 单位：**credits（uint256）**，建议使用“自然数”（1 = 1 次），避免 1e18 换算错误
- `mapping(bytes32 tenantId => mapping(address user => mapping(bytes32 clientOrderId => bool used)))`
  - 购买幂等
- `mapping(bytes32 settlementBatchId => bool applied)`
  - 结算幂等

### 2.2 核心事件（建议）

- `event CreditsPurchased(bytes32 indexed tenantId, address indexed buyer, address indexed payToken, uint256 payAmount, uint256 credits, bytes32 clientOrderId, uint256 ts)`
- `event CreditsSettled(bytes32 indexed tenantId, bytes32 indexed settlementBatchId, uint256 userCount, uint256 totalCredits, bytes32 merkleRoot, uint256 ts)`
- `event CreditsDeducted(bytes32 indexed tenantId, address indexed user, uint256 credits, bytes32 settlementBatchId)`
- `event CreditsRefunded(bytes32 indexed tenantId, address indexed user, uint256 credits, bytes32 reasonCode, uint256 ts)`（可选，仅用于“链上强退款/纠错”）

> 注意：本文的“失败必退款”发生在链下；链上退款事件主要用于运营纠错/强制补偿。

### 2.3 核心接口（建议）

> 以下是接口“形态规范”（不是你仓库现有合约）。你可以新建合约实现它，并通过 Registry 注册地址供前端解析。

```solidity
interface IAICreditsVault {
  function creditsBalance(bytes32 tenantId, address user) external view returns (uint256);

  // 购买：需要用户对 payToken 先 approve（USDT 多数无 permit）
  function buyCredits(
    bytes32 tenantId,
    address payToken,
    uint256 payAmount,
    uint256 credits,
    bytes32 clientOrderId
  ) external;

  // 批量结算：仅 operator/keeper 可调用，将链下已成功的调用批量扣减链上余额（最终一致）
  function settleBatch(
    bytes32 tenantId,
    bytes32 settlementBatchId,
    bytes32 merkleRoot,
    address[] calldata users,
    uint256[] calldata creditsUsed
  ) external;
}
```

### 2.4 定价（你当前设定）

- 计费：**1 次 = 1 credit**
- 售价：建议配置为 `pricePerCredit`（按 token 区分 USDC/USDT），例如 1 USDC 买 1 credit
- 若你不需要动态定价，可将价格固定写死在合约或在部署时一次性配置。

---

## 3) 链下系统：usage ledger（高频扣次、并发、失败必退款）

### 3.1 数据库表结构（推荐最小集合）

#### `tenants`
- `tenant_id (pk)`：bytes32/uuid（与链上 tenantId 一致）
- `chain_id`
- `registry_address`

#### `credit_purchases`
链上购买的镜像（用于对账/展示；可由索引服务从事件 `CreditsPurchased` 回填）
- `tenant_id`
- `user_address`
- `client_order_id`（幂等键，bytes32/uuid）
- `tx_hash`
- `pay_token`
- `pay_amount`
- `credits`
- `status`：`PENDING|CONFIRMED|REORGED`
- `block_number`
- `created_at`

#### `ai_requests`
高频幂等扣次的权威请求表（每次 AI 调用对应一条）。

- `tenant_id`
- `user_address`
- `request_id`（幂等键；建议 UUIDv7 / ULID；服务端必须强制唯一）
- `status`：`RESERVED|SUCCEEDED|FAILED|REFUNDED`
- `reserved_at`
- `finished_at`
- `refund_at`
- `failure_code`（可选：`MODEL_ERROR|TIMEOUT|USER_CANCEL|RATE_LIMIT|POLICY_BLOCK|INTERNAL_ERROR`）
- `failure_detail`（可选，短文本）
- `model`（固定也建议记录，便于未来扩展）
- `metadata_json`（可选：traceId、prompt hash 等；不要存用户敏感明文）

索引建议：
- `unique(tenant_id, user_address, request_id)`
- `index(tenant_id, user_address, reserved_at)`

#### `credit_balances`
链下实时余额表（用于极低延迟扣次 + 并发控制）。

- `tenant_id`
- `user_address`
- `available_credits`（int/bigint）
- `updated_at`

索引建议：
- `unique(tenant_id, user_address)`

#### `credit_settlement_batches`
链下批量结算批次（用于把“已成功的调用”批量扣减链上 creditsBalance，实现最终一致）。

- `tenant_id`
- `settlement_batch_id`（幂等键；bytes32/uuid；与链上同名）
- `range_start_ts` / `range_end_ts`（本批覆盖的请求时间窗）
- `status`：`CREATED|SUBMITTED|CONFIRMED|FAILED`
- `merkle_root`（可选，如果链上用 merkle；否则可以为空）
- `tx_hash`（链上提交后填）
- `total_users`
- `total_credits`
- `created_at`
- `confirmed_at`

索引建议：
- `unique(tenant_id, settlement_batch_id)`

#### `credit_settlement_items`
批次内明细（每个 user 的扣减聚合）。

- `tenant_id`
- `settlement_batch_id`
- `user_address`
- `credits_used`

索引建议：
- `unique(tenant_id, settlement_batch_id, user_address)`

---

## 4) 幂等键（ID）规范（端到端必须一致）

### 4.1 clientOrderId（购买幂等）
- 由前端生成（UUID/ULID），下单时传入链上 `buyCredits(..., clientOrderId)`。
- 后端索引服务应以 `(tenantId, user, clientOrderId)` 作为**购买幂等键**。

### 4.2 requestId（调用幂等）
- 由前端在发起 AI 请求前生成（UUIDv7/ULID，推荐可排序）。
- 后端以 `(tenantId, user, requestId)` 做唯一键；**重复请求必须返回同一结果/同一最终状态**，绝不重复扣次。

### 4.3 settlementBatchId（结算幂等）
- 由后端生成（UUID/ULID 或 keccak256(batch payload)）。
- 链上 `settleBatch` 必须拒绝重复的 `settlementBatchId`（`applied=true` 即 revert）。

---

## 5) 链下调用状态机（失败必退款）

> 你要求“失败必退 1 次”，因此状态机必须严格实现：只要不是 SUCCEEDED，就最终变为 REFUNDED（或从 RESERVED 回滚）。

### 5.1 状态流转

- `RESERVED`：已扣减链下 `available_credits` 1 次（或冻结 1 次），允许开始调用模型。
- `SUCCEEDED`：模型调用成功；本次扣次生效，进入可结算队列。
- `FAILED`：模型调用失败（任何原因）。
- `REFUNDED`：失败退款完成（链下 `available_credits +1`），并记录 `refund_at`。

约束：
- `RESERVED -> SUCCEEDED` 或 `RESERVED -> FAILED -> REFUNDED`
- 不允许从 `SUCCEEDED` 退款（除非人工纠错，另走“运营补偿”流程）

### 5.2 并发控制（必须）

扣次必须使用数据库原子条件更新，避免并发下扣成负数：
- `UPDATE credit_balances SET available_credits = available_credits - 1 WHERE tenant_id=? AND user_address=? AND available_credits >= 1`
- 影响行数为 0 ⇒ 返回 `INSUFFICIENT_CREDITS`

然后插入 `ai_requests`（唯一键 requestId）；若插入冲突，必须读出已有记录并返回幂等结果。

---

## 6) 后端 API（多租户版本，强一致幂等）

### 6.1 购买次数包（链上）

前端流程：
1) `approve(payToken, AICreditsVault, payAmount)`（USDT/USDC）
2) `buyCredits(tenantId, payToken, payAmount, credits, clientOrderId)`
3) 等待 1~N confirmations（按你业务风控要求）

后端索引服务：
- 监听 `CreditsPurchased`（或从链上读取交易回执）写入 `credit_purchases`，并把链下 `available_credits += credits`。
- 处理 reorg：`REORGED` 时回滚对应 credits（或重新拉链上 SSOT 对齐）。

### 6.2 AI 调用（高频，链下）

`POST /v1/tenants/{tenantId}/ai/run`

请求体：
- `requestId`（必填）
- `input`（你的 prompt/参数）

返回：
- `requestId`
- `status`：`SUCCEEDED|FAILED|INSUFFICIENT_CREDITS`
- `remainingCreditsRealtime`（可选，但强烈建议返回，方便 UI 立即刷新）
- `result`（成功时）
- `error`（失败时）

幂等规则：
- 如果 `(tenantId,user,requestId)` 已存在：
  - 返回该 request 的最终状态与结果（或同一失败原因）
  - 不再次扣次

### 6.3 余额查询（前端展示）

`GET /v1/tenants/{tenantId}/credits/me`

返回建议字段：
- `availableRealtime`（链下实时可用次数）
- `purchasedOnchainTotal`（链上累计购买次数，可由索引服务提供）
- `settledOnchainTotal`（链上累计结算扣减次数，可由索引服务提供）
- `pendingReserved`（当前 RESERVED 未完成数，可选）
- `lastSyncedBlock`（索引同步高度）

---

## 7) 链上批量结算（把链下成功调用“最终扣减”到链上）

### 7.1 为什么需要结算
链下扣次保证体验，但链上 `creditsBalance`（B）需要最终反映“已使用”，用于：
- 审计：链上余额可核对
- 防欺诈：链下被攻击/篡改时链上仍可追溯
- 跨系统一致性：多租户运营报表一致

### 7.2 批次生成规则（建议）
- 每隔 X 分钟/小时生成一个 batch：
  - 聚合所有 `SUCCEEDED` 且未结算的 `ai_requests`
  - 按 user 汇总为 `creditsUsed[user]`
  - 生成 `settlementBatchId`（UUID 或 payload hash）

### 7.3 settleBatch 的最小安全约束（建议）
- onlyRole（operator/keeper）
- `applied[settlementBatchId]` 防重放
- 对每个 user：`creditsBalance[tenantId][user] >= creditsUsed`，不足则 revert 或记录为坏账（建议 revert，保持一致）

---

## 8) 前端（多租户）展示与对账口径（统一）

### 8.1 前端只信两类口径
- **实时可用**：后端 `availableRealtime`（来自链下 usage ledger）
- **可审计购买/结算**：链上事件（`CreditsPurchased` / `CreditsSettled` / `CreditsDeducted`）或后端索引聚合

不要用：
- “钱包里 USDC 余额变化”推导买了多少次（会受其他转账/合约操作影响，dirty state 下尤其不可靠）

### 8.2 多租户键
所有前端请求都必须显式携带：
- `tenantId`（路由参数或 header）
- 当前连接钱包地址（user）
- 当前链 `chainId`

前端启动时对每个 tenant/chain 建议做一次“模块快照”：
- 从 `Registry` 解析 `AICreditsVault` 地址（SSOT）
- 缓存 `{tenantId, chainId, registry, aiCreditsVaultAddr, blockNumber}`，并监听 `ModuleAddressUpdated`（如有）

### 8.3 用户页面建议展示
- 剩余次数（实时）：`availableRealtime`
- 累计购买次数（审计）：`purchasedOnchainTotal`
- 累计使用次数（审计）：`settledOnchainTotal`（或链下已成功次数）
- 最近调用记录：分页展示 `ai_requests`（含 requestId、时间、成功/失败、失败已退款标记）

---

## 9) 与现有 Reward 系统的关系（重要）

你仓库现有 `RewardPoints`：
- 只有 `MINTER_ROLE` 可以 `mintPoints/burnPoints`（见 `src/Token/RewardPoints.sol`）
- 因此不适合让普通用户“直接 burn 自己的 points”来按次扣费（用户无法调用 `burnPoints`）

结论：
- **AI 次数包售卖（USDC/USDT）不应依赖用户自行 burn RewardPoints**
- 应用新的 `AICreditsVault` 作为“次数包 SSOT（B）”，并通过事件/余额实现审计
- `RewardView` / `RewardConsumption` 仍可继续用于你已有的“服务购买/等级/借贷奖励”体系，两者互不冲突

---

## 10) 最小实现清单（按优先级）

- **P0（必须）**
  - 后端：`credit_balances` + `ai_requests`（幂等/并发/失败必退款）
  - 合约：`AICreditsVault.buyCredits` + `creditsBalance` + `settleBatch`
  - 索引：监听 `CreditsPurchased` 更新链下余额（或前端轮询后端确认）

- **P1（强烈建议）**
  - 批量结算：周期性 `settleBatch`
  - 前端：展示 requestId 历史、失败退款状态、链上购买记录

- **P2（可选增强）**
  - merkle 结算（减少 calldata）
  - 链上强退款/纠错（`CreditsRefunded`）

---

## 11) ID 编码与“端到端一致”规则（强制）

你要求幂等贯穿端到端，因此 **clientOrderId / requestId / settlementBatchId** 必须做到：
- 前端生成 → 后端原样保存与透传 → 上链按同一 bytes32 值记录 → 索引服务按同一值反查

### 11.1 推荐的传输格式（统一）

- **HTTP / DB / 日志**：使用 `0x` 开头的 **32 字节 hex 字符串**（bytes32），例如：`0xabc...`（长度 66）
- **链上**：参数类型使用 `bytes32`

### 11.2 从 UUID/ULID 生成 bytes32（推荐做法）

由于链上参数是 `bytes32`，而 UUID/ULID 是字符串，推荐统一采用：

\[
idBytes32 = keccak256(utf8Bytes(idString))
\]

约束：
- `idString` 必须包含业务域前缀，避免跨域碰撞，例如：
  - `AI:REQUEST:{tenantId}:{user}:{uuid}`
  - `AI:ORDER:{tenantId}:{user}:{uuid}`
  - `AI:SETTLE:{tenantId}:{uuid}`
- 前端与后端必须使用**同一拼接规则**与 **UTF-8** 编码

这样：
- 前端可先生成 `uuid`，再算出 `bytes32` 传给后端/链上
- 后端无需“反解” UUID，只需以 bytes32 作为幂等键（最稳）

---

## 12) 后端幂等扣次：参考伪代码（必须严格实现）

### 12.1 预扣（reserve）+ 幂等

输入：`tenantId, user, requestIdBytes32`

1) 尝试插入请求（若已存在则直接返回已有结果）：
- `INSERT ai_requests(tenant_id,user_address,request_id,status,reserved_at) VALUES (...,'RESERVED',now())`
- 若冲突（unique key），`SELECT * FROM ai_requests ...` 并返回（幂等）

2) 原子扣减余额（并发安全）：
- `UPDATE credit_balances SET available_credits = available_credits - 1 WHERE tenant_id=? AND user_address=? AND available_credits >= 1`
- 影响行数为 0：
  - `UPDATE ai_requests SET status='FAILED', failure_code='INSUFFICIENT_CREDITS', finished_at=now() WHERE ...`
  - 返回 `INSUFFICIENT_CREDITS`

> 关键：**先占 requestId，再扣余额**，可以避免“同 requestId 并发”导致重复扣。

### 12.2 成功结算（succeed）

- `UPDATE ai_requests SET status='SUCCEEDED', finished_at=now() WHERE ... AND status='RESERVED'`
- 若影响行数为 0，说明已完成/已退款，直接按幂等返回当前状态

### 12.3 失败必退款（fail → refund）

失败发生时：
- `UPDATE ai_requests SET status='FAILED', failure_code=?, failure_detail=?, finished_at=now() WHERE ... AND status='RESERVED'`
- 然后执行退款（幂等）：
  - `UPDATE ai_requests SET status='REFUNDED', refund_at=now() WHERE ... AND status='FAILED'`
  - 若成功更新，则 `UPDATE credit_balances SET available_credits = available_credits + 1 WHERE ...`

> 关键：退款必须是**幂等**的，确保重试不会多加回。

---

## 13) 链上结算（settleBatch）与链下余额的最终一致性

### 13.1 链下余额的来源（两条腿）

链下 `available_credits` 的变化来源只有两类：
- **购买确认（CreditsPurchased 确认后）**：`+credits`
- **AI 请求链下扣次/退款**：`-1 / +1`

链上 `creditsBalance` 的变化来源只有两类：
- **buyCredits**：`+credits`
- **settleBatch**：按用户聚合 `-creditsUsed`

这保证了：
- 链下是“体验层实时余额”
- 链上是“审计层最终余额”

### 13.2 结算窗口与延迟提示（前端）

因为链上按批结算，链上 `creditsBalance` 可能**短时高于**链下实时可用次数（尚未结算的成功调用还没反映到链上）。

UI 建议：
- 主展示使用 `availableRealtime`（链下）
- 同时展示 `lastSyncedBlock` / “链上余额可能有延迟（批量结算）”

---

## 14) 多租户落地（前端/后端一致）

### 14.1 Tenant 的最小 SSOT

每个 tenant 至少需要：
- `tenantId`（bytes32）
- `chainId`
- `registryAddress`（SSOT）

前端/后端都必须通过 Registry 解析：
- `AICreditsVault` 地址（以及你需要的 View 地址）

### 14.2 不允许“跨 tenant 混用幂等键”

所有唯一约束都必须包含 `tenantId`：
- `unique(tenant_id, user_address, request_id)`
- `unique(tenant_id, user_address, client_order_id)`
- `unique(tenant_id, settlement_batch_id)`

否则会出现“tenant A 的 requestId 抢占 tenant B”的灾难性幂等碰撞。

---

## 15) 稳定币购买注意事项（USDC/USDT）

- **USDT 通常没有 permit**：前端一般需要 `approve + buyCredits` 两步
- **USDC 在不同链/版本 permit 支持不一致**：不要假设一定可用
- `payAmount` 的 decimals 要按 token 实际 decimals 处理（USDC/USDT 通常是 6）
- 价格固定（你设定无租户差价）时，建议合约直接校验：
  - `credits == payAmount / pricePerCredit`（或反向校验），避免前端传参作弊


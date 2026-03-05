# SaaS 后端实施计划指南（统一幂等 + 多租户 + 双边账本）

> **文档定位**：本文档是 RWA Lending Platform 链下 SaaS 后端的**权威实施总纲**。
> 它基于对现有 `contracts/` 链上架构（`docs/Architecture-Guide.md`、`docs/FRONTEND_CONTRACTS_INTEGRATION.md`）、
> 链上 Reward 系统（`docs/Usage-Guide/Reward-Best-Practices-Guide.md`、`docs/Usage-Guide/AI-Credits-Billing-Guide.md`）、
> 以及 `easifi-monorepo-wt/` 先行系统（`api-server` + `ai-services`）的完整审计而编写。
>
> **核心策略**：**在现有 `easifi-monorepo-wt/` 代码库上原地修正**，而非从零搭建新系统。
> 现有代码库已包含复式记账引擎（1,454 行）、AI 服务全套（67 个服务文件）、多租户中间件、
> 用量计费、配额管控等完整能力。问题出在幂等口径分叉和账本表缺 `tenant_id` 两个具体点上，
> 修这两个点比推倒重来快 3 倍。
>
> **核心目标**：在 2.5–3 周内完成修正并部署，**统一幂等 Key 规范**，修复账本隔离漏洞，
> 新增链上事件索引（Ponder）和 Stripe 计费，杜绝"多服务幂等口径分叉"问题。

---

## 目录

1. [先行系统问题诊断（教训总结）](#1-先行系统问题诊断教训总结)
2. [统一幂等 Key 规范（SSOT，最高优先级）](#2-统一幂等-key-规范ssot最高优先级)
3. [多租户架构设计](#3-多租户架构设计)
4. [双边账本与复式记账统一（链上 SSOT + 链下镜像）](#4-双边账本与复式记账统一)
5. [整体技术架构（基于现有系统修正）](#5-整体技术架构基于现有系统修正)
6. [修正策略与选型理由（保留现有系统 + 定点修正）](#6-修正策略与选型理由保留现有系统--定点修正)
7. [分阶段实施计划（3 周，基于现有系统原地修正）](#7-分阶段实施计划3-周基于现有系统原地修正)
8. [区块链集成层](#8-区块链集成层)
9. [AI 服务修正（原地改动，非迁移）](#9-ai-服务修正原地改动非迁移)
10. [AWS 部署架构](#10-aws-部署架构)
11. [CI/CD 与监控](#11-cicd-与监控)
12. [对账与审计](#12-对账与审计)
13. [风险与回退策略](#13-风险与回退策略)
14. [前后端并行实施计划](#14-前后端并行实施计划)

---

## 1. 先行系统问题诊断（教训总结）

> 以下分析基于对 `easifi-monorepo-wt/api-server` 和 `easifi-monorepo-wt/ai-services` 源码的完整审计。

### 1.1 已确认的幂等性分叉问题

| 子系统 | 幂等 Key 格式 | 存储层 | 问题 |
|--------|-------------|--------|------|
| `api-server` LedgerService | `entryId`（自由格式，如 `reward:consume:{userId}:{requestId}`） | PostgreSQL `ledger_entries.entry_id` UNIQUE | Key 构造规则分散在各 usecase 中，无统一 registry |
| `api-server` IdempotencyKeyRegistry | `requestId`（仅格式校验，Phase 2 未实现） | **无持久化**（仅 log） | 只做了 `requestId.length <= 128` 校验，Redis/DB 检查标注 TODO |
| `api-server` RewardLedger | `(userId, requestId)` 隐式去重（INSERT ON CONFLICT） | PostgreSQL `reward_ledger` | 依赖 DB 约束捕获 `23505`，但没有显式幂等 key 字段 |
| `ai-services` UsageLedger | `(tenant_id, request_id, category)` | PostgreSQL `usage_idempotency` 表 | 独立表，与 api-server 的 `ledger_entries.entry_id` 完全脱节 |
| `ai-services` IdempotencyService | `idemp:agg:{symbol}:{ts}:{sourceModel}:{signalType}` | Redis（TTL 7d） | 仅用于信号去重，与账本无关 |
| `ai-services` EmbeddingQueue | `idemp:embed:q:{idempotencyKey}` | Redis NX | 仅用于队列去重 |

**核心问题**：五种不同的幂等机制、三种不同的存储层、零统一规范。当 `ai-services` 通过 `aiGrantClient` 调用 `api-server` 的 `/api/rewards/ai/grant` 时：

```
ai-services 生成 requestId (格式 A)
    → HTTP POST → api-server 收到 requestId
    → api-server 构造 entryId = `reward:consume:${userId}:${requestId}` (格式 B)
    → LedgerService 以 entryId 做幂等检查

问题场景：
1. ai-services 重试时若生成新 requestId → api-server 认为是新请求 → 重复扣费
2. ai-services 使用相同 requestId 但 payload 微调 → IDEMPOTENT_CONFLICT
3. 对账时两侧 key 无法直接关联 → 对账失败
```

### 1.2 多租户与账本的隔离漏洞

| 表 | 是否有 `tenant_id` | 风险 |
|----|-------------------|------|
| `accounts` | **无** | 跨租户共享同一账户空间，`user:123` 在租户 A 和 B 指向同一行 |
| `ledger_entries` | **无** | 复式分录没有租户维度，跨租户对账不可行 |
| `reward_ledger` | 有 | 但与 `accounts` 脱节，对账时需手动关联 |
| `platform_ledger` | 有 | 平台账户 `platform_pool` 是全局的，多租户共享 |
| `ai_usage_detail` | 有 | 但 `requestId` 格式与 `api-server` 不统一 |

**核心问题**：`accounts` 表的主键是 `(account_id, currency)`，缺少 `tenant_id` 维度。多租户环境下 `user:123` 的“奖励通证余额”（目标态对应 Registry[KEY_EASY_TOKEN] 指向的奖励通证，即 EasyToken）会在所有租户间共享——这是数据隔离的致命漏洞。

### 1.3 教训总结（必须在本次修正中解决）

1. **幂等 Key 必须有统一的生成规则和校验规范**——不能让每个 usecase/service 自行构造
2. **账本核心表必须包含 `tenant_id`**——否则多租户隔离形同虚设
3. **跨服务调用的幂等 Key 必须端到端透传**——不能在中间转换格式
4. **幂等检查必须在事务开头**——不能依赖事后捕获 DB 约束异常
5. **IdempotencyKeyRegistry Phase 2 不能再拖**——必须从 Day 1 实现

---

## 2. 统一幂等 Key 规范（SSOT，最高优先级）

> **本节是整个实施计划中最重要的部分**。所有服务、所有层级必须遵循同一套规范。

### 2.1 幂等 Key 格式定义（强制）

```
IdempotencyKey = {domain}:{entity}:{scope}:{nonce}

其中：
- domain    ∈ { ledger, reward, usage, ai, billing, chain }
- entity    = 业务实体标识（如 userId, tenantId, orderId）
- scope     = 操作范围/类型（如 consume, grant, deposit, embed）
- nonce     = 唯一因子（如 requestId, txHash, timestamp+random）

长度限制：≤ 128 字符
字符集：  [A-Za-z0-9:_\-.]
```

**示例**：

| 业务场景 | 幂等 Key | 说明 |
|---------|---------|------|
| 用户消费积分 | `reward:u123:consume:req-abc123` | 用户 123 的消费请求 |
| AI 用量记录 | `usage:t-default:u123:llm:req-abc123` | 租户 default、用户 123 的 LLM 用量 |
| 链上事件索引 | `chain:arb42161:tx-0xabc:log-5` | Arbitrum 链上交易 0xabc 的第 5 条日志 |
| 计费对账 | `billing:t-default:2026-02:stmt-001` | 租户 default 2026 年 2 月账单 |
| 链上积分兑换 | `chain:arb42161:exchange:tx-0xdef:u123` | 用户 123 的链上兑换交易 |

### 2.2 幂等 Key 注册表（统一实现）

```typescript
// easifi-monorepo-wt/packages/shared/src/idempotency/IdempotencyKey.ts
// 新增共享包，api-server 和 ai-services 共同引用

/**
 * 统一幂等 Key 生成器（SSOT）
 * 
 * 所有服务/模块必须通过本类生成幂等 Key，禁止自行拼接字符串。
 * 
 * 设计原则：
 * 1. Key 格式在编译期确定（TypeScript 类型约束）
 * 2. 验证在构造期完成（fail fast）
 * 3. 序列化格式唯一（确保跨服务可比较）
 */

const KEY_PATTERN = /^[A-Za-z0-9:_\-.]{1,128}$/;
const DOMAINS = ['ledger', 'reward', 'usage', 'ai', 'billing', 'chain'] as const;
type Domain = typeof DOMAINS[number];

export class IdempotencyKey {
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  /** 从结构化参数构建 Key（推荐） */
  static build(domain: Domain, ...parts: string[]): IdempotencyKey {
    const raw = [domain, ...parts].join(':');
    return IdempotencyKey.parse(raw);
  }

  /** 从字符串解析 Key（用于反序列化/跨服务接收） */
  static parse(raw: string): IdempotencyKey {
    if (!raw || !KEY_PATTERN.test(raw)) {
      throw new IdempotencyKeyError(`Invalid idempotency key: ${raw?.slice(0, 20)}`);
    }
    const domain = raw.split(':')[0];
    if (!DOMAINS.includes(domain as Domain)) {
      throw new IdempotencyKeyError(`Unknown domain: ${domain}`);
    }
    return new IdempotencyKey(raw);
  }

  /** 提取 domain 部分 */
  get domain(): Domain {
    return this.value.split(':')[0] as Domain;
  }

  toString(): string {
    return this.value;
  }

  /** 用于 Map/Set 的 key */
  [Symbol.toPrimitive](): string {
    return this.value;
  }
}

export class IdempotencyKeyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'IdempotencyKeyError';
  }
}

// ===== 业务场景工厂方法（推荐入口） =====

export const IdempotencyKeys = {
  /** 积分消费 */
  rewardConsume: (userId: string | number, requestId: string) =>
    IdempotencyKey.build('reward', `u${userId}`, 'consume', requestId),

  /** 积分发放 */
  rewardGrant: (userId: string | number, requestId: string) =>
    IdempotencyKey.build('reward', `u${userId}`, 'grant', requestId),

  /** AI 用量记录 */
  aiUsage: (tenantId: string, userId: string | number, category: string, requestId: string) =>
    IdempotencyKey.build('usage', `t-${tenantId}`, `u${userId}`, category, requestId),

  /** 链上事件索引 */
  chainEvent: (chainId: number, txHash: string, logIndex: number) =>
    IdempotencyKey.build('chain', `c${chainId}`, txHash, `log-${logIndex}`),

  /** 链上积分兑换 */
  chainExchange: (chainId: number, txHash: string, userId: string | number) =>
    IdempotencyKey.build('chain', `c${chainId}`, 'exchange', txHash, `u${userId}`),

  /** 复式记账分录 */
  ledgerEntry: (debitAccount: string, creditAccount: string, requestId: string) =>
    IdempotencyKey.build('ledger', debitAccount, creditAccount, requestId),

  /** 计费账单 */
  billingStatement: (tenantId: string, period: string, statementId: string) =>
    IdempotencyKey.build('billing', `t-${tenantId}`, period, statementId),
} as const;
```

### 2.3 幂等检查层（三级防御）

```
Level 1: Redis CAS（毫秒级，挡掉 99% 重复请求）
    ↓ 未命中
Level 2: PostgreSQL SELECT（事务内，权威判定）
    ↓ 未命中
Level 3: DB UNIQUE CONSTRAINT（最后防线，捕获并发写入）
```

```typescript
// easifi-monorepo-wt/packages/shared/src/idempotency/IdempotencyGuard.ts

export class IdempotencyGuard {
  constructor(
    private redis: RedisClient,
    private config: { ttlSeconds: number; prefix: string }
  ) {}

  /**
   * 三级幂等检查
   * 
   * @returns 
   *   - { status: 'new' }         → 首次请求，继续处理
   *   - { status: 'duplicate' }   → 重复请求，返回缓存结果
   *   - { status: 'processing' }  → 正在处理中，等待或拒绝
   */
  async check(key: IdempotencyKey): Promise<IdempotencyCheckResult> {
    const redisKey = `${this.config.prefix}:${key.value}`;

    // Level 1: Redis NX（原子性设置，防止并发进入）
    const acquired = await this.redis.set(redisKey, 'processing', {
      NX: true,
      EX: this.config.ttlSeconds,
    });

    if (!acquired) {
      // Key 已存在，检查状态
      const status = await this.redis.get(redisKey);
      if (status === 'completed') {
        return { status: 'duplicate' };
      }
      return { status: 'processing' };
    }

    return { status: 'new', release: () => this.complete(key) };
  }

  /** 标记为已完成（成功路径） */
  async complete(key: IdempotencyKey): Promise<void> {
    const redisKey = `${this.config.prefix}:${key.value}`;
    await this.redis.set(redisKey, 'completed', { EX: this.config.ttlSeconds });
  }

  /** 标记为失败（释放锁，允许重试） */
  async fail(key: IdempotencyKey): Promise<void> {
    const redisKey = `${this.config.prefix}:${key.value}`;
    await this.redis.del(redisKey);
  }
}

type IdempotencyCheckResult =
  | { status: 'new'; release: () => Promise<void> }
  | { status: 'duplicate' }
  | { status: 'processing' };
```

### 2.4 跨服务幂等 Key 透传规范（强制）

```
HTTP Header: X-Idempotency-Key: {IdempotencyKey.value}
HTTP Header: X-Request-Id: {traceId}  （可观测性，不用于幂等）

规则：
1. 调用方生成 IdempotencyKey，通过 X-Idempotency-Key 传递
2. 被调用方不得修改/重新生成 Key
3. 被调用方使用收到的 Key 做幂等检查
4. 重试时必须使用相同的 Key（这是幂等的定义）
5. payload 变化但 Key 相同 → 返回 409 IDEMPOTENT_CONFLICT
```

```
ai-services 生成: IdempotencyKeys.aiUsage('default', '123', 'llm', 'req-abc')
    → HTTP POST /api/rewards/ai/grant
    → Header: X-Idempotency-Key: usage:t-default:u123:llm:req-abc
    → api-server 收到: 直接使用 "usage:t-default:u123:llm:req-abc" 作为 entryId
    → LedgerService.postDoubleEntry({ entryId: "usage:t-default:u123:llm:req-abc", ... })

重试：
    → 使用完全相同的 Header → api-server 检测到重复 → 返回 200 { isIdempotentHit: true }
```

---

## 3. 多租户架构设计

### 3.1 租户隔离策略

**选择**：Shared Database, Schema-Per-Tenant（Row Level Security）

| 层级 | 隔离方式 | 实现 |
|------|---------|------|
| HTTP 层 | `X-Tenant-ID` Header + JWT claim | 中间件注入 |
| 应用层 | AsyncLocalStorage 上下文 | 全链路透传 |
| 数据库层 | PostgreSQL RLS | `SET app.tenant_id` |
| 缓存层 | Redis key 前缀 | `{tenantId}:key` |
| 链上层 | 租户→钱包映射表 | `tenant_wallets` |

### 3.2 核心数据模型（修正先行系统的隔离漏洞）

```sql
-- ====== 租户管理 ======

CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,                    -- 如 'acme-corp'
  display_name  TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free',        -- free | pro | enterprise
  status        TEXT NOT NULL DEFAULT 'active',      -- active | suspended | archived
  settings      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ====== 账户表（修正：加入 tenant_id） ======

CREATE TABLE accounts (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  account_id    TEXT NOT NULL,
  currency      TEXT NOT NULL,
  balance       NUMERIC(38,18) NOT NULL DEFAULT 0,
  reserved      NUMERIC(38,18) NOT NULL DEFAULT 0,
  version       BIGINT NOT NULL DEFAULT 0,             -- 乐观锁（替代 sequence）
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, account_id, currency)
);

-- RLS 策略
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_accounts ON accounts
  USING (tenant_id = current_setting('app.tenant_id', true));

-- ====== 账本分录表（修正：加入 tenant_id + 统一幂等 Key） ======

CREATE TABLE ledger_entries (
  id                BIGSERIAL,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  idempotency_key   TEXT NOT NULL,                     -- 统一幂等 Key（SSOT）
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  debit_account     TEXT NOT NULL,
  credit_account    TEXT NOT NULL,
  amount            NUMERIC(38,18) NOT NULL,
  currency          TEXT NOT NULL,
  balance_after_debit   NUMERIC(38,18),
  balance_after_credit  NUMERIC(38,18),
  status            TEXT NOT NULL DEFAULT 'posted',
  source            TEXT,
  metadata          JSONB,
  trace_id          TEXT,
  created_by        TEXT,
  PRIMARY KEY (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key)                  -- 租户内幂等唯一
) PARTITION BY LIST (tenant_id);

-- 默认分区（小规模租户共享）
CREATE TABLE ledger_entries_default PARTITION OF ledger_entries DEFAULT;

-- RLS 策略
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ledger ON ledger_entries
  USING (tenant_id = current_setting('app.tenant_id', true));

-- ====== 统一幂等注册表（跨服务权威来源） ======

CREATE TABLE idempotency_registry (
  tenant_id       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  domain          TEXT NOT NULL,                        -- ledger|reward|usage|ai|billing|chain
  status          TEXT NOT NULL DEFAULT 'processing',   -- processing|completed|failed
  payload_hash    TEXT,                                 -- SHA-256 of request payload
  result          JSONB,                                -- 缓存的响应结果
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  PRIMARY KEY (tenant_id, idempotency_key)
);

-- 自动清理过期记录
CREATE INDEX idx_idempotency_expires ON idempotency_registry (expires_at)
  WHERE status = 'completed';

-- ====== 用量明细表（与 ai-services 统一） ======

CREATE TABLE usage_detail (
  id              BIGSERIAL,
  tenant_id       TEXT NOT NULL,
  user_id         TEXT,
  idempotency_key TEXT NOT NULL,                        -- 统一幂等 Key
  category        TEXT NOT NULL,                        -- embedding|llm|vector_search|ingestion
  service         TEXT NOT NULL,
  model           TEXT,
  provider        TEXT,
  tokens_used     DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
  points_charged  NUMERIC(38,18) NOT NULL DEFAULT 0,
  metadata        JSONB,
  trace_id        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key)                   -- 租户内幂等唯一
) PARTITION BY RANGE (created_at);

-- 月度分区（自动创建）
CREATE TABLE usage_detail_2026_02 PARTITION OF usage_detail
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
```

### 3.3 账户命名规范（租户内唯一，强制）

```
用户账户:    user:{userId}
平台收入:    platform:income
平台支出:    platform:expense  
FX 资金池:   fx_pool:{currency_pair}
AI Credits:  ai_credits:{userId}
保证金池:    guarantee_pool
手续费池:    fee_pool
```

> **关键修正**：先行系统中 `platform_pool` 是全局共享的（无 tenant_id），导致多租户时平台收入混账。
> 新系统中所有账户操作都在 `tenant_id` 分区内执行，通过 RLS 自动隔离。

---

## 4. 双边账本与复式记账统一

> **重要架构变更**：链上 Reward 系统现已完备（详见 `docs/Usage-Guide/Reward-Best-Practices-Guide.md`），
> 包含完整的 Earn/Spend/View 三层架构、per-order 幂等、penalty ledger（负余额追踪）、
> 以及通过 `RewardView.DataPushed` 的统一事件流。
> 
> 链下账本的角色因此发生根本性转变：**从"唯一 SSOT"变为"链上 SSOT 的镜像 + 高频 AI 计费层"**。

### 4.0 SSOT 分层架构（链上 vs 链下权威边界，强制）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       SSOT 权威分层                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Layer 1: 链上 SSOT（B，权威来源，不可篡改）                              │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Reward Token（ERC20；SSOT = Registry[KEY_EASY_TOKEN]）           │  │
│  │    → balanceOf(user): 奖励通证余额（EasyToken）                   │  │
│  │    → totalSupply(): 全网奖励通证总量（同上）                       │  │
│  │                                                                   │  │
│  │  RewardManagerCore（Earn 核心账本）                                │  │
│  │    → _lockedPoints[user]: 已锁定（虚拟，未铸币）                   │  │
│  │    → _lockedPointsByOrderId[orderId]: per-order 锁定（幂等 SSOT）│  │
│  │    → _penaltyLedger[user]: 负余额/欠分账本（SSOT）                │  │
│  │    → _userLevels[user]: 用户等级 1-5（SSOT）                      │  │
│  │                                                                   │  │
│  │  EasyConsumption + EasyRecycleDistributor（按次消费）              │  │
│  │    → 扣减用户 EasyToken 余额（ERC20 balance 为最终结果）           │  │
│  │    → 观测事件：DataPushed(EASY_SPENT / EASY_RECYCLED_SPLIT)        │  │
│  │                                                                   │  │
│  │  AICreditsVault（AI 额度 SSOT）                                   │  │
│  │    → creditsBalance(tenantId, user): 链上审计余额（B）             │  │
│  │    → _usedClientOrderId: 购买/兑换幂等（SSOT）                    │  │
│  │    → _appliedSettlementBatch: 结算幂等（SSOT）                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Layer 2: 链下镜像 + 高频计费层（派生，非权威）                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  PostgreSQL ledger_entries（复式记账镜像）                         │  │
│  │    → 镜像链上 Mint/Burn/Deposit/Fee 事件为链下复式分录             │  │
│  │    → 幂等 Key: chain:c{chainId}:tx-{hash}:log-{idx}              │  │
│  │    → 用于：多租户聚合报表 / 跨链对账 / BI 分析                    │  │
│  │                                                                   │  │
│  │  PostgreSQL credit_balances + ai_requests（AI 高频计费）           │  │
│  │    → 链下实时扣次（每次 AI 调用 -1）                               │  │
│  │    → 失败必退款（+1）                                              │  │
│  │    → 幂等 Key: usage:t-{tenantId}:u{userId}:{category}:{reqId}    │  │
│  │    → 定期 settleBatch 到链上 AICreditsVault（最终一致）            │  │
│  │                                                                   │  │
│  │  Redis（缓存 + 幂等锁）                                           │  │
│  │    → credits_balance:{tenantId}:{userId}: 实时可用额度（低延迟）   │  │
│  │    → 幂等 Level 1 防御层                                          │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  数据流向：链上事件 → Ponder 索引 → 链下镜像（单向派生，不可逆写）       │
│  对账方向：链下 → 链上（链上为准，链下必须对齐）                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**关键规则（强制）**：

| 数据类型 | SSOT | 链下角色 | 对账方向 |
|---------|------|---------|---------|
| 奖励通证余额 | `IERC20(Registry[KEY_EASY_TOKEN]).balanceOf(user)` | 镜像（Ponder 索引奖励通证 `Transfer` 的 mint/burn） | 链下 → 链上 |
| 锁定点数 | `RewardManagerCore._lockedPoints[user]` | 镜像（`DataPushed: REWARD_EARNED`） | 链下 → 链上 |
| 负余额/欠分 | `RewardManagerCore._penaltyLedger[user]` | 镜像（`DataPushed: REWARD_PENALTY_LEDGER_UPDATED`） | 链下 → 链上 |
| 用户等级 | `RewardManagerCore._userLevels[user]` | 镜像（`DataPushed: REWARD_LEVEL_UPDATED`） | 链下 → 链上 |
| Easy 消费观测 | `RewardView.DataPushed(EASY_SPENT / EASY_RECYCLED_SPLIT)` | 镜像（用于分析/对账辅助；最终以 ERC20 balance 为准） | 链下 → 链上 |
| AI Credits 审计余额 | `AICreditsVault.creditsBalance(tenantId, user)` | 镜像 + 高频扣次层 | 链下 → 链上 |
| AI 用量明细 | 链下 `ai_requests` 表 | **链下原生** | 链上← 批量结算 |
| 抵押/手续费 | `CollateralManager / FeeRouter` | 镜像（Ponder 索引） | 链下 → 链上 |
| Stripe 计费 | 链下 `billing_subscriptions` | **链下原生** | 无链上对应 |

### 4.1 链上 Reward 会计模型（按 `Reward-Best-Practices-Guide.md` 对齐）

> 以下模型已在链上完整实现，链下只需**镜像**，不需要重新实现。

#### 4.1.1 Earn 路径（积分发放）会计分录

```
触发源：OrderEngine 在债务账本落账成功后回调 RewardManager（闸门 1: 先落账再触发）

Borrow（outcome = 0，锁定，不铸币）:
  链上：_lockedPoints[user] += 1e18 × levelMultiplierBps / 10000
        _lockedPointsByOrderId[orderId] = points（per-order 幂等）
  链下：INSERT ledger_entries (
          idempotency_key = 'chain:c{chainId}:tx-{hash}:log-{idx}',
          debit_account = 'system:locked_pool',
          credit_account = 'user:{userId}:locked',
          amount = lockedPoints,
          status = 'locked'  -- 不是 'posted'，因为还没铸币
        )

RepayOnTimeFull（outcome = 1，释放 + 铸币）:
  链上：释放 _lockedPoints → 扣除 _penaltyLedger 欠分 → 由 EasyEmissionController 发放奖励通证（对 EasyToken mint）
        DataPushed(EASY_MINTED, ...)
  链下：INSERT ledger_entries (
          idempotency_key = 'chain:c{chainId}:tx-{hash}:log-{idx}',
          debit_account = 'platform:reward_pool',   -- 平台奖励池（借方）
          credit_account = 'user:{userId}',          -- 用户余额（贷方）
          amount = toMint,
          status = 'posted'
        )
        -- 若有欠分抵扣，额外记录:
        INSERT ledger_entries (
          debit_account = 'user:{userId}:penalty',
          credit_account = 'platform:penalty_recovery',
          amount = deducted,
          source = 'penalty_deduction'
        )

RepayEarlyFull（outcome = 2，不发放、不处罚）:
  链上：释放 _lockedPoints，无铸币/销毁
  链下：UPDATE ledger_entries SET status='cancelled' 
        WHERE idempotency_key = 原 borrow 的 lock 分录 key

RepayLateFull（outcome = 3，处罚）:
  链上：释放 _lockedPoints → 计算罚分 → try burn → 失败则记入 _penaltyLedger
        RewardView.DataPushed(REWARD_BURNED 或 REWARD_PENALTY_LEDGER_UPDATED)
  链下：INSERT ledger_entries (
          debit_account = 'user:{userId}',           -- 用户被罚
          credit_account = 'platform:penalty_pool',   -- 罚款池
          amount = penalty,
          source = 'late_penalty'
        )
```

#### 4.1.2 Spend 路径（积分消费）会计分录

```
EasiM / Strategy API 按次消费（每次 1 Easy）:
  链上：EasyConsumption.consumeEasiMCall(...)
    → 扣减用户 EasyToken（SSOT=Registry[KEY_EASY_TOKEN]）
    → EasyRecycleDistributor 回收并按 75/15/10 分配（burn/team/eco）
    → RewardView.DataPushed(EASY_SPENT / EASY_RECYCLED_SPLIT)
  链下：INSERT ledger_entries (
      idempotency_key = 'chain:c{chainId}:tx-{hash}:log-{idx}',
      debit_account = 'user:{userId}',
      credit_account = 'platform:easy_spent',
      amount = 1e18,
      source = 'easy_consumption'
    )
```

#### 4.1.3 链上幂等机制（已内建，链下不需要重新实现）

| 链上操作 | 幂等机制 | 链下对应 |
|---------|---------|---------|
| `onLoanEventByOrder(orderId)` | `_lockedPointsByOrderId[orderId] != 0 → return` | Ponder 索引天然幂等（同一 event 只处理一次） |
| `buyCredits(clientOrderId)` | `_usedClientOrderId[tenantId][user][clientOrderId]` | 同上 |
| `settleBatch(settlementBatchId)` | `_appliedSettlementBatch[settlementBatchId]` | 链下以 `settlement_batch_id` 做幂等 |

### 4.2 链下复式记账流程（镜像 + 高频计费）

> **定位**：链下复式记账有两个职责：
> 1. **镜像链上事件**为链下分录（通过 Ponder 索引 `DataPushed` 事件）
> 2. **处理链下原生计费**（AI 高频扣次、Stripe 订阅）

#### 4.2.1 镜像分录流程（Ponder → PostgreSQL）

```
Ponder 索引服务（自动，无需手动触发）:
  RewardView.DataPushed(dataTypeHash, payload)
    │
    ├── REWARD_EARNED → INSERT ledger_entries (platform:reward_pool → user)
    ├── REWARD_BURNED → INSERT ledger_entries (user → platform:burn_pool)
    ├── REWARD_PENALTY_LEDGER_UPDATED → UPDATE penalty_mirror_table
    ├── REWARD_LEVEL_UPDATED → UPDATE user_level_cache
    ├── REWARD_PRIVILEGE_UPDATED → UPDATE user_privilege_cache
    ├── REWARD_DYNAMIC_REWARD_PARAMS_UPDATED → UPDATE config_cache
    └── REWARD_LEVEL_MULTIPLIER_UPDATED → UPDATE config_cache

每条链上事件的幂等 Key = chain:c{chainId}:tx-{txHash}:log-{logIndex}
Ponder 天然保证：同一 (block, txIndex, logIndex) 只处理一次
```

#### 4.2.2 链下原生计费流程（AI Credits 高频扣次）

```
                    ┌──────────────────────────────────────────┐
                    │         统一幂等检查（事务前）            │
                    │  Redis CAS → DB SELECT → 若重复则短路返回 │
                    └──────────────────────┬───────────────────┘
                                           │ status = 'new'
                    ┌──────────────────────▼───────────────────┐
                    │             BEGIN TRANSACTION             │
                    │                                          │
                    │  1. SET app.tenant_id = ?                │
                    │  2. INSERT idempotency_registry (Level 2)│
                    │  3. INSERT ai_requests (RESERVED)        │
                    │  4. UPDATE credit_balances               │
                    │     SET available_credits -= 1            │
                    │     WHERE available_credits >= 1          │
                    │     → 影响行数 = 0 ? INSUFFICIENT_CREDITS│
                    │                                          │
                    │             COMMIT                       │
                    └──────────────────────┬───────────────────┘
                                           │
                    ┌──────────────────────▼───────────────────┐
                    │  转发到 ai-services 处理请求              │
                    │    → 成功: UPDATE status='SUCCEEDED'      │
                    │    → 失败: UPDATE status='FAILED'         │
                    │             → REFUND: credits += 1        │
                    └──────────────────────┬───────────────────┘
                                           │
                    ┌──────────────────────▼───────────────────┐
                    │  Redis: mark completed + cache result    │
                    │  Metrics: record latency + outcome       │
                    └──────────────────────────────────────────┘

状态机（严格，不可跳跃）:
  RESERVED → SUCCEEDED（扣次生效，进入可结算队列）
  RESERVED → FAILED → REFUNDED（链下退回 1 credit）
  不允许从 SUCCEEDED 退款（除运营纠错另走人工流程）
```

#### 4.2.3 批量结算（链下 → 链上最终一致）

```
定期任务（每 1-6 小时，可配置）:
  1. 聚合 ai_requests WHERE status='SUCCEEDED' AND NOT settled
     → GROUP BY (tenant_id, user_address) → SUM(credits_used)
  2. 生成 settlementBatchId（UUID 或 keccak256(payload)）
  3. 调用链上 AICreditsVault.settleBatch(tenantId, settlementBatchId, merkleRoot, users, creditsUsed)
     → 链上幂等：同一 settlementBatchId 只生效一次
     → 链上校验：每个 user 的 creditsBalance >= creditsUsed
  4. 确认后更新链下：
     INSERT credit_settlement_batches (status='CONFIRMED', tx_hash=...)
     UPDATE ai_requests SET settled=true WHERE request_id IN (本批次)

对账恒等式（必须满足）:
  ∀ (tenantId, user):
    AICreditsVault.creditsBalance(tenantId, user)
    == credit_balances.available_credits
       + SUM(ai_requests WHERE status='SUCCEEDED' AND NOT settled)
       - SUM(ai_requests WHERE status='RESERVED')
```

### 4.3 完整链上/链下事件映射表

> 链下系统**必须**订阅 `RewardView.DataPushed(bytes32 indexed dataTypeHash, bytes payload)` 作为唯一事件源（SSOT）。
> **禁止**直接订阅 `RewardEvents.sol` 中的 legacy 事件（仅 debug 用途）。

| dataTypeHash | 链上触发模块 | payload schema | 链下处理 | 链下幂等 Key |
|---|---|---|---|---|
| `REWARD_EARNED` | `RewardManagerCore` (on-time repay mint) | `(address user, uint256 amount, string reason, uint256 blockNumber)` | INSERT `ledger_entries`（platform:reward_pool → user） | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `REWARD_BURNED` | `RewardManagerCore` (penalty burn) | `(address user, uint256 amount, string reason, uint256 blockNumber)` | INSERT `ledger_entries`（user → platform:burn_pool） | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `EASY_SPENT` | `RewardView` (from EasyConsumption) | `(address user, uint8 spendType, uint256 amount, uint256 blockNumber)` | INSERT `ledger_entries`（user → platform:recycle_pool） | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `EASY_RECYCLED_SPLIT` | `RewardView` (from EasyRecycleDistributor) | `(address payer, uint256 amount, uint256 burnAmount, uint256 teamAmount, uint256 ecoAmount, uint8 spendType, uint256 blockNumber)` | INSERT `ledger_entries`（recycle_pool → burn/team/eco） | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `REWARD_LEVEL_UPDATED` | `RewardManagerCore` | `(address user, uint8 level, uint256 blockNumber)` | UPDATE `user_reward_cache.level` | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `REWARD_PENALTY_LEDGER_UPDATED` | `RewardManagerCore` | `(address user, uint256 pendingDebt, uint256 blockNumber)` | UPDATE `user_reward_cache.penalty_debt` | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `REWARD_STATS_UPDATED` | `RewardView` (aggregation) | `(uint256 totalBatchOps, uint256 totalCachedRewards, uint256 blockNumber)` | UPDATE `system_stats_cache` | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `REWARD_DYNAMIC_REWARD_PARAMS_UPDATED` | `RewardManagerCore` | `(uint256 threshold, uint256 multiplierBps, uint256 blockNumber)` | UPDATE `config_cache.dynamic_params` | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `REWARD_LEVEL_MULTIPLIER_UPDATED` | `RewardManagerCore` | `(uint8 level, uint256 multiplierBps, uint256 blockNumber)` | UPDATE `config_cache.level_multipliers` | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `CreditsPurchased`（AICreditsVault 原生事件） | `AICreditsVault` | `(tenantId, buyer, payToken, payAmount, credits, clientOrderId, blockNumber)` | UPDATE `credit_balances` + INSERT `credit_purchases` | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `CreditsSettled`（AICreditsVault 原生事件） | `AICreditsVault` | `(tenantId, settlementBatchId, userCount, totalCredits, merkleRoot, blockNumber)` | UPDATE `credit_settlement_batches` status | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `DEPOSIT_PROCESSED` | `CollateralManager` (via VaultRouter DataPushed) | `(address user, address asset, uint256 amount, uint256 blockNumber)` | INSERT `ledger_entries`（user → collateral_pool） | `chain:c{chainId}:tx-{hash}:log-{idx}` |
| `FeeDistributed` | `FeeRouter` | `(address token, uint256 amount, ...)` | INSERT `ledger_entries`（多腿分账） | `chain:c{chainId}:tx-{hash}:log-{idx}` |

### 4.4 链下数据库表结构扩展（镜像 + AI 计费，对齐 AI-Credits-Billing-Guide）

> 以下表结构是对第 3 节核心模型的**补充**，专门用于 AI Credits 高频计费和链上事件镜像。

```sql
-- ====== AI Credits 高频计费（链下原生，对齐 AI-Credits-Billing-Guide.md） ======

-- 链下实时余额（低延迟扣次 + 并发控制）
CREATE TABLE credit_balances (
  tenant_id       TEXT NOT NULL,
  user_address    TEXT NOT NULL,
  available_credits BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_address)
);

-- AI 请求（高频幂等扣次的权威请求表）
CREATE TABLE ai_requests (
  tenant_id       TEXT NOT NULL,
  user_address    TEXT NOT NULL,
  request_id      TEXT NOT NULL,               -- UUIDv7/ULID
  status          TEXT NOT NULL DEFAULT 'RESERVED',  -- RESERVED|SUCCEEDED|FAILED|REFUNDED
  reserved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  refund_at       TIMESTAMPTZ,
  failure_code    TEXT,                         -- MODEL_ERROR|TIMEOUT|INSUFFICIENT_CREDITS|...
  model           TEXT,
  metadata        JSONB,
  idempotency_key TEXT NOT NULL,               -- 统一幂等 Key（如 usage:t-{tenantId}:u{userId}:llm:{requestId}）
  settled         BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (tenant_id, user_address, request_id),
  UNIQUE (tenant_id, idempotency_key)
);

-- 链上购买镜像（由 Ponder 索引 CreditsPurchased 事件回填）
CREATE TABLE credit_purchases (
  tenant_id       TEXT NOT NULL,
  user_address    TEXT NOT NULL,
  client_order_id TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  pay_token       TEXT NOT NULL,
  pay_amount      NUMERIC(38,18) NOT NULL,
  credits         BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'CONFIRMED', -- PENDING|CONFIRMED|REORGED
  block_number    BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_address, client_order_id)
);

-- 批量结算批次
CREATE TABLE credit_settlement_batches (
  tenant_id           TEXT NOT NULL,
  settlement_batch_id TEXT NOT NULL,
  range_start_ts      TIMESTAMPTZ,
  range_end_ts        TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'CREATED', -- CREATED|SUBMITTED|CONFIRMED|FAILED
  merkle_root         TEXT,
  tx_hash             TEXT,
  total_users         INT NOT NULL DEFAULT 0,
  total_credits       BIGINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at        TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, settlement_batch_id)
);

-- ====== 链上事件镜像缓存（用于快速查询，非 SSOT） ======

CREATE TABLE user_reward_cache (
  tenant_id       TEXT NOT NULL,
  user_address    TEXT NOT NULL,
  rlp_balance     NUMERIC(38,18) NOT NULL DEFAULT 0,   -- 镜像奖励通证余额（SSOT=Registry[KEY_EASY_TOKEN]；字段名 rlp_balance 为历史命名）
  locked_points   NUMERIC(38,18) NOT NULL DEFAULT 0,   -- 镜像 _lockedPoints
  penalty_debt    NUMERIC(38,18) NOT NULL DEFAULT 0,   -- 镜像 _penaltyLedger
  user_level      SMALLINT NOT NULL DEFAULT 1,          -- 镜像 _userLevels
  privileges      TEXT,                                 -- 镜像 packed privileges
  last_sync_block BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_address)
);

-- RLS 策略（与第 3 节一致）
ALTER TABLE credit_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_credits ON credit_balances
  USING (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE ai_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ai_requests ON ai_requests
  USING (tenant_id = current_setting('app.tenant_id', true));
```

### 4.5 链上/链下职责边界总结（速查表）

| 功能 | 链上负责 | 链下负责 | 禁止 |
|------|---------|---------|------|
| **奖励通证铸造/销毁（EasyToken）** | RewardManagerCore → Reward Token（Registry[KEY_EASY_TOKEN]） | 镜像为 ledger_entries | 链下不得直接修改奖励通证余额 |
| **积分锁定/释放** | RewardManagerCore per-order | 镜像 REWARD_EARNED/BURNED | 链下不得维护独立锁定状态 |
| **负余额/欠分** | RewardManagerCore._penaltyLedger | 镜像 PENALTY_LEDGER_UPDATED | 链下不得维护独立 penalty 账本 |
| **按次消费（Easy）** | EasyConsumption + EasyRecycleDistributor | 镜像 EASY_SPENT/EASY_RECYCLED_SPLIT | 链下不得维护独立消费记录 |
| **AI Credits 购买** | AICreditsVault.buyCredits | 索引 CreditsPurchased → credit_purchases | — |
| **AI 高频扣次** | **不在链上** | ai_requests + credit_balances | 禁止每次 AI 调用上链 burn 奖励通证（目标态 EasyToken；legacy: RLP） |
| **AI 批量结算** | AICreditsVault.settleBatch | 生成 batch → 提交链上 | — |
| **对账** | 链上为准 | 链下 → 链上对齐 | 链下余额不得高于链上余额 |

---

## 5. 整体技术架构（基于现有系统修正）

> **关键决策**：保留并修正 `easifi-monorepo-wt/api-server` 和 `easifi-monorepo-wt/ai-services`，
> 新增 `packages/shared`（统一幂等层）和 `ponder-indexer`（链上事件索引）。

### 5.0 Monorepo 目录结构（修正后）

```
easifi-monorepo-wt/
├── api-server/                    # 【保留 + 修正】主 API 服务
│   ├── src/
│   │   ├── lib/
│   │   │   └── idempotency.ts     # 【重写】替换为统一 IdempotencyGuard
│   │   ├── middleware/
│   │   │   └── tenantDbSession.ts  # 【保留】RLS 中间件（无需改动）
│   │   ├── services/
│   │   │   ├── ledger/
│   │   │   │   └── LedgerService.ts # 【修正】加 tenant_id + 统一幂等 Key
│   │   │   └── billing/
│   │   │       └── billingStatementService.ts # 【修正】从统一 usage_detail 聚合
│   │   ├── usecases/
│   │   │   └── reward/
│   │   │       └── ConsumeEasyWithPlatformMirror.ts # 【修正】替换幂等 Key
│   │   └── routes/
│   │       └── stripe.ts           # 【新增】Stripe Webhook 处理
│   └── prisma/
│       └── schema.prisma           # 【修正】accounts + ledger_entries 加 tenant_id
│
├── ai-services/                   # 【保留 + 修正】AI 服务
│   ├── src/
│   │   ├── services/
│   │   │   ├── idempotencyService.ts      # 【修正】替换为统一 IdempotencyKey
│   │   │   ├── quota/
│   │   │   │   └── usageLedger.ts         # 【修正】替换 usage_idempotency → 统一注册表
│   │   │   └── rewards/
│   │   │       └── aiGrantClient.ts       # 【修正】X-Idempotency-Key Header
│   │   └── ...（其余服务保持不变）
│   └── migrations/
│
├── packages/                      # 【新增】共享包
│   └── shared/
│       └── src/
│           └── idempotency/
│               ├── IdempotencyKey.ts      # 统一幂等 Key 生成器
│               └── IdempotencyGuard.ts    # 三级防御检查
│
├── ponder-indexer/                # 【新增】链上事件索引
│   ├── ponder.config.ts
│   ├── ponder.schema.ts
│   └── src/
│       └── index.ts
│
└── infrastructure/                # 【新增】部署配置
    ├── docker-compose.yml
    ├── docker-compose.production.yml
    └── terraform/                  # 或 CDK
```

### 5.1 架构图（修正后）

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户 / 前端                              │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   AWS ALB / CloudFront │  CDN + 负载均衡 + WAF
                    └───────────┬───────────┘
                                │
           ┌────────────────────┼────────────────────┐
           │                    │                    │
    ┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
    │ api-server  │     │ api-server  │     │ api-server  │
    │（现有+修正）│     │（现有+修正）│     │（现有+修正）│
    │  PM2 / ECS  │     │  PM2 / ECS  │     │  PM2 / ECS  │
    └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
           │                    │                    │
           └─────────┬──────────┼──────────┬─────────┘
                     │          │          │
              ┌──────▼──┐  ┌───▼──────┐  ┌▼─────────────┐
              │  Redis   │  │PostgreSQL│  │ ai-services   │
              │ 缓存/锁  │  │ 主库/账本│  │（现有+修正）  │
              │ElastiCache│  │  RDS     │  │  ECS Task    │
              └──────────┘  └──────────┘  └──────────────┘
                                │
                         ┌──────▼──────┐
                         │   Ponder    │     【新增】链上索引
                         │  ECS Task   │
                         └──────┬──────┘
                                │
                         ┌──────▼──────┐
                         │  Arbitrum   │
                         │  RPC Node   │
                         └─────────────┘
```

### 5.2 技术选型

| 层级 | 选型 | 理由 |
|------|------|------|
| **SaaS 应用层** | **现有 `api-server`（Express + Prisma）** | 已有完整的路由/中间件/账本，修正即可上线 |
| **AI 服务层** | **现有 `ai-services`** | 67 个服务文件、RAG/Embedding/向量搜索、Worker 全部保留 |
| **统一幂等层** | **新增 `packages/shared`** | api-server 和 ai-services 共同引用，消除幂等分叉 |
| **链上索引** | **新增 Ponder** | TypeScript；EVM 原生；比 The Graph 快 10x |
| **数据库** | PostgreSQL 16 | RLS；分区表；JSONB；现有系统已用 |
| **缓存** | Redis 7 | 幂等锁；余额缓存；限流；现有系统已用 |
| **ORM** | Prisma | 类型安全；迁移管理；现有系统已用 |
| **计费** | **新增 Stripe 集成** | 订阅/Webhook/发票；在 api-server 中新增路由 |
| **区块链交互** | ethers.js v6 | 与 contracts/ 共享 TypeChain/ABI |

---

## 6. 修正策略与选型理由（保留现有系统 + 定点修正）

### 6.1 为什么不推倒重来？

| 维度 | 推倒重来（新项目） | 原地修正（本方案） |
|------|------------------|------------------|
| **已有代码复用率** | 0%（全部重写） | ~80%（只改幂等 + 账本隔离） |
| **预计工期** | 5–6 周 | **2.5–3 周** |
| **风险** | 高（新架构未经验证） | 低（核心业务逻辑已验证） |
| **AI 服务** | 需整体迁移（67 个文件） | **零迁移**（原地可用） |
| **账本引擎** | 需重写（~1,454 行） | **仅修正 2 个点**（tenant_id + 幂等 Key） |
| **中间件/鉴权** | 需重写 | **直接复用** |

### 6.2 现有系统已具备的能力（无需重写）

| 能力 | 现有位置 | 状态 |
|------|---------|------|
| 复式记账引擎 | `api-server/src/services/ledger/LedgerService.ts` | ✅ 核心逻辑完整，修正 tenant_id 即可 |
| 多租户 RLS 中间件 | `api-server/src/middleware/tenantDbSession.ts` | ✅ 可直接复用 |
| 租户隔离中间件 | `api-server/src/middleware/tenantIsolation.ts` | ✅ 可直接复用 |
| 租户配额管控 | `api-server/src/middleware/tenantQuota.ts` | ✅ 可直接复用 |
| JWT 鉴权 | `api-server/src/middleware/` | ✅ 可直接复用 |
| Easy 消费（含平台镜像） | `api-server/src/usecases/reward/ConsumeEasyWithPlatformMirror.ts` | ⚠️ 需修正幂等 Key |
| 计费账单 | `api-server/src/services/billing/billingStatementService.ts` | ⚠️ 需从统一 usage_detail 聚合 |
| RAG/Embedding/向量搜索 | `ai-services/src/services/` (67 个文件) | ✅ 可直接复用 |
| AI 用量记录 | `ai-services/src/services/quota/usageLedger.ts` | ⚠️ 需替换幂等表 |
| 向量配额限流 | `ai-services/src/services/quota/vectorQuotaGuard.ts` | ✅ Redis key 加租户前缀即可 |
| 后台 Worker（Redis Stream） | `ai-services/src/workers/` | ✅ 可直接复用 |
| 数据采集器 | `ai-services/src/collectors/` | ✅ 可直接复用 |
| 成本预测 | `ai-services/src/services/forecasting/costForecastService.ts` | ✅ 可直接复用 |

### 6.3 需要新增的组件

| 组件 | 用途 | 实现方式 |
|------|------|---------|
| **`packages/shared`** | 统一幂等 Key + Guard | 新建 npm workspace 包，api-server 和 ai-services 共同引用 |
| **Ponder 索引服务** | 链上 EVM 事件索引 | `npm create ponder@latest ponder-indexer`；TypeScript；支持 Arbitrum |
| **Stripe 路由** | 订阅计费 + Webhook | 在 api-server 中新增 `src/routes/stripe.ts` |
| **Admin Dashboard** | 租户/用量/链上数据管理 | 后期可用 React Admin 或轻量 UI，初期用 API + 脚本 |

### 6.4 Ponder（链上索引层，新增）

| 属性 | 值 |
|------|---|
| 仓库 | https://github.com/ponder-sh/ponder |
| Stars | ~1,000+ |
| 语言 | TypeScript |
| 许可 | MIT |

**核心能力**：
- 原生 EVM 事件索引（支持 Arbitrum）
- 比 The Graph 快 10x（冷启动 37s）
- 端到端类型安全（与 TypeChain 一致）
- PostgreSQL 存储（可共享主库）
- 自托管（Docker/ECS/EKS）

**与 contracts/ 的对接**：
- 直接复用 TypeChain ABI（零转换成本）
- 配置 `DataPushed` 事件索引即可消费所有业务数据
- 支持多合约、多网络配置

### 6.5 BoxyHQ SaaS Starter Kit（后期企业 SSO，备选）

| 属性 | 值 |
|------|---|
| 仓库 | https://github.com/boxyhq/saas-starter-kit |
| Stars | 4,700 |
| 能力 | SAML SSO / SCIM / 企业身份管理 |

**定位**：Phase 3/4 按需引入，不影响初期上线。

---

## 7. 分阶段实施计划（3 周，基于现有系统原地修正）

> **策略**：不新建项目骨架，直接在 `easifi-monorepo-wt/` 中修改。
> 每个 Phase 都标注了**要改哪个文件**和**改什么**，确保可执行。

### Phase 1: 统一幂等层 + 账本隔离修正（Day 1–5）

| 日 | 任务 | 涉及文件/操作 | 产出 |
|----|------|--------------|------|
| D1 | **创建 `packages/shared` 共享包** | 新建 `packages/shared/package.json`、`tsconfig.json`；写入 `src/idempotency/IdempotencyKey.ts` + `IdempotencyGuard.ts`（本文第 2 节代码）；在根 `package.json` 添加 workspace 配置 | `IdempotencyKey` + `IdempotencyGuard` 模块可用 |
| D2 | **修正 `accounts` 表加 `tenant_id`** | `api-server/prisma/schema.prisma`：修改 `Account` model 主键为 `(tenant_id, account_id, currency)`；新建 migration：`npx prisma migrate dev --name add_tenant_id_to_accounts` | Prisma migration 可执行 |
| D2 | **修正 `ledger_entries` 表加 `tenant_id` + 统一幂等 Key** | `api-server/prisma/schema.prisma`：修改 `LedgerEntry` model 添加 `tenant_id` + `idempotency_key` 字段，UNIQUE 改为 `(tenant_id, idempotency_key)` | 账本隔离修正完成 |
| D3 | **新建 `idempotency_registry` 表 + `tenants` 表** | `api-server/prisma/schema.prisma`：新增 `Tenant` 和 `IdempotencyRegistry` model（本文第 3.2 节 Schema） | 统一幂等注册表可用 |
| D3 | **新建 RLS 策略** | 手写 SQL migration（Prisma raw SQL）：对 `accounts`、`ledger_entries` 启用 RLS，策略 `USING (tenant_id = current_setting('app.tenant_id', true))` | RLS 隔离生效 |
| D4 | **重写 `api-server/src/lib/idempotency.ts`** | 废弃旧的 `IdempotencyKeyRegistry`（仅格式校验），替换为 `import { IdempotencyGuard, IdempotencyKeys } from '@shared/idempotency'` + 三级防御实现 | 幂等检查从 Day 1 生效 |
| D4 | **修正 `LedgerService.ts`** | `api-server/src/services/ledger/LedgerService.ts`：① `postDoubleEntryWithClient` 参数加 `tenantId`；② `entry_id` 替换为 `idempotency_key`（来自 `IdempotencyKey.value`）；③ 事务开头加 `SET app.tenant_id` | 复式记账租户隔离生效 |
| D5 | **修正 `ConsumeEasyWithPlatformMirror.ts`** | `api-server/src/usecases/reward/`：① `entryId` 替换为 `IdempotencyKeys.rewardConsume(userId, requestId).value`；② 去掉 `catch 23505` 逻辑，改为事务前 `IdempotencyGuard.check()` | Easy 消费幂等修正完成 |
| D5 | **单测覆盖** | 新增/修改 `api-server/tests/idempotency.test.ts`、`api-server/tests/ledger-tenant.test.ts` | 所有修正项测试通过 |

**验收标准**：
- [ ] `IdempotencyKey.build()` 编译期类型校验通过
- [ ] 同一 `idempotency_key` 的两次 POST 请求，第二次返回 `{ isIdempotentHit: true }`
- [ ] 不同 tenant 的 `user:123` 指向不同的 `accounts` 行
- [ ] RLS 策略通过：租户 A 无法读取租户 B 的 `ledger_entries`
- [ ] 旧的 `IdempotencyKeyRegistry` 已无任何引用

### Phase 2: ai-services 幂等统一 + Ponder 链上索引 + Stripe（Day 6–12）

| 日 | 任务 | 涉及文件/操作 | 产出 |
|----|------|--------------|------|
| D6 | **修正 `aiGrantClient.ts` 跨服务调用** | `ai-services/src/services/rewards/aiGrantClient.ts`：① 引入 `@shared/idempotency`；② HTTP POST Header 加 `X-Idempotency-Key: IdempotencyKeys.aiUsage(tenantId, userId, category, requestId).value`；③ 去掉自行构造 requestId 的逻辑 | 跨服务幂等 Key 透传 |
| D6 | **修正 `usageLedger.ts` 幂等机制** | `ai-services/src/services/quota/usageLedger.ts`：① 用 `IdempotencyKeys.aiUsage(...)` 替换旧的 `(tenant_id, request_id, category)` 组合键；② 用 `idempotency_registry` 表替代 `usage_idempotency` 表 | ai-services 幂等统一 |
| D7 | **修正 `idempotencyService.ts`** | `ai-services/src/services/idempotencyService.ts`：① Redis key 格式改为统一 `IdempotencyKey.value`；② 保留 TTL 机制但与 DB 层对齐 | 信号去重也统一 |
| D7 | **api-server 接收端适配** | `api-server/src/routes/rewards.ts`（或对应 controller）：① 从 `X-Idempotency-Key` Header 读取 key；② 直接用于 `LedgerService.postDoubleEntry()` 的 `idempotencyKey` 参数 | api-server 侧接收统一 |
| D8 | **初始化 Ponder 索引服务** | 在 monorepo 根目录：`npm create ponder@latest ponder-indexer`；配置 `ponder.config.ts`（本文第 8.1 节）；连接 Arbitrum RPC | Ponder 冷启动成功 |
| D9 | **实现 `DataPushed` 事件索引** | `ponder-indexer/src/index.ts`：实现 DEPOSIT_PROCESSED、REWARD_EARNED 等事件的索引函数（本文第 8.2 节） | PostgreSQL 可查询链上事件 |
| D10 | **新增 Stripe 路由** | `api-server/src/routes/stripe.ts`（新增）：① Stripe 产品/价格配置；② Webhook 处理（`subscription.created/updated/deleted`）；③ 幂等处理（Stripe event ID 作为 `IdempotencyKeys.billingStatement(...)` 的 nonce） | 订阅计费可用 |
| D11 | **AI Credits 余额同步** | `api-server/src/services/` 新增 `chainSync.ts`：链上 `AICreditsVault.creditsBalance()` → Redis `credits_balance:{tenantId}:{userId}`；定时同步（cron job） | 按次扣费可用 |
| D12 | **集成测试** | 新增/修改 e2e 测试：链上事件 → Ponder 索引 → 账本记录 → 对账验证；跨服务幂等 Key 端到端 | E2E 测试通过 |

**验收标准**：
- [ ] `ai-services` 到 `api-server` 的 grant 请求使用统一 `X-Idempotency-Key` Header
- [ ] 同一 AI 请求重试不产生重复扣费（端到端验证）
- [ ] `usage_idempotency` 表不再有新写入（已切换到 `idempotency_registry`）
- [ ] 链上 `DataPushed` 事件在 10s 内出现在 PostgreSQL
- [ ] Stripe Webhook 重试不产生重复订阅记录
- [ ] AI Credits 消费后 `usage_detail` 与 Redis 余额一致

### Phase 3: AWS 部署 + 生产加固（Day 13–21）

| 日 | 任务 | 涉及文件/操作 | 产出 |
|----|------|--------------|------|
| D13-14 | **Docker 化所有服务** | 新建/更新各服务 `Dockerfile`：`api-server/Dockerfile`、`ai-services/Dockerfile`、`ponder-indexer/Dockerfile`；新建 `infrastructure/docker-compose.yml`（dev 环境）+ `docker-compose.production.yml` | `docker-compose up` 一键启动 |
| D15-16 | **AWS 基础设施** | 新建 `infrastructure/terraform/`：ECS Fargate（api-server × 2 + ai-services × 1 + Ponder × 1）、RDS PostgreSQL、ElastiCache Redis、ALB、安全组 | Terraform apply 可执行 |
| D17-18 | **CI/CD Pipeline** | `.github/workflows/deploy.yml`：test → build → push ECR → ECS rolling deploy（本文第 11.1 节） | Push to main 自动部署 |
| D19 | **监控 + 告警** | CloudWatch Metrics + Dashboard；幂等命中率、账本延迟、索引器落后、对账差异等告警规则（本文第 11.2 节） | Dashboard 可观测 |
| D20 | **安全加固** | WAF 配置；Secrets Manager 管理 DB/Redis/Stripe/RPC 密钥；VPC 内网通信；安全组最小权限 | 安全审计通过 |
| D21 | **对账脚本 + 灰度发布 + 回退预案** | 新增 `scripts/recon/` 对账脚本（本文第 12 节）；ECS 蓝绿部署配置；数据库 migration 回退方案 | 生产就绪 |

**验收标准**：
- [ ] 2 个 ECS Task 同时处理请求，幂等无冲突
- [ ] RDS 故障转移后服务自动恢复
- [ ] 链上/链下对账差异 < 0.01%
- [ ] P99 延迟 < 500ms（非 AI 请求）
- [ ] Admin 可按租户维度查看用量和计费

### 工期对比

| 方案 | 总工期 | 原因 |
|------|--------|------|
| ~~推倒重来（Open SaaS）~~ | ~~4–5 周~~ | ~~需重新搭建全部业务逻辑~~ |
| **原地修正（本方案）** | **2.5–3 周** | 只修幂等 + 隔离 + 新增 Ponder/Stripe |

---

## 8. 区块链集成层

### 8.0 当前落地情况（基于 `lending-backend` / `lending-frontend`）

本节的“目标态”描述了 **链下索引 + 数据库 + 分页 API**（浏览器能力）的理想形态。
在你们当前的实现中（本机目录：`/Volumes/AI-hosts/EasiFi-workspace/lending-backend`、`/Volumes/AI-hosts/EasiFi-workspace/lending-frontend`），已经能看到以下**最小闭环能力**：

1) **数据库 + 读模型表**（Prisma）：
- 后端已包含 `PortfolioPosition/PortfolioAsset/PortfolioSummary` 等读模型，用于承载“用户维度的仓位快照与历史”。

2) **分页/查询 API**（Explorer-like 的必要条件之一）：
- 后端已提供 `GET /api/portfolio/history?user&limit&offset` 等分页接口（DB 查询）。
- 前端已在 `src/lib/portfolio/fetchers.ts` 使用上述接口（positions/history/refresh），说明“DB + 分页 API”的通路已打通。

3) **链上 → 链下同步的可运行形态（cron/worker 雏形）**：
- 后端已存在链上同步服务（如 `src/services/chainSync.ts`），可用 ethers provider 读取链上数据并写入 Redis/DB。
- 这证明：你们已经具备在后端进程中接入 RPC、做限流、做周期性同步的基础设施。

4) **失败可观测 + 手动/异步重试入口**（与本仓库的 B 类 View cache 失败事件闭环一致）：
- 后端已存在 `cache-retry` 相关路由（如 `POST /api/cache-retry/request`、`GET /api/cache-retry/status`），用于把“需要重试的链上视图/缓存更新”入队。

> 结论：当前实现已经具备“**浏览器能力的底座**”（DB + API + 分页 + 基础链上读取/同步 + 重试入口）。
> 若要把能力从“快照缓存/人工触发 refresh”为主，升级到“**自动化事件索引（explorer 级）**”，需要补齐事件消费与 reorg 处理（见 8.3）。

### 8.0.1 推荐的分工（前端直连 View vs 后端读模型 API）

- **强一致、用户自查（钱包直连）**：仍建议优先走链上 View（带 `isValid/blockNumber/version`），例如 Position/Health、LoanNFTView 枚举 + `getLoanOrder(orderId)`。
- **历史/搜索/跨用户聚合**：必须走后端读模型 API（分页），避免前端 RPC 扫链与速率限制。

### 8.0.1.1 View 系统“浏览器直读”时，后端需要补齐什么？（以 `LoanNFTView.sol` 为例）

你提到的“浏览器直接可查看”，本质是 **RPC `eth_call` 直读链上 View 合约**。
`src/Vault/view/modules/LoanNFTView.sol` 这类模块已经把“用户订单枚举”做成了分页接口（`offset/limit` + `MAX_BATCH_SIZE` 上限），前端可以直接调用。

**当前 lending-backend 里没有 `/api/view/*` 这类 View 代理路由**，所以现状是：用户侧“强一致自查”全部走前端钱包直连 View。
后端要补齐的内容主要不是“再做一套同样的查询”，而是把 **可选的代理/限流/审计能力**补齐，并且把安全边界说清楚：

#### A) 推荐默认：前端钱包直连 View（最简单、最符合链上权限语义）

- 用户私域读取（Scheme U）：前端用用户自己的 provider/signer 直连 `LoanNFTView.getUserLoansPaginated(user, offset, limit)`。
- 前端展示时必须处理 meta：`isValid/blockNumber/version`（或同等字段）用于降级提示。

#### B) 可选：后端加一层“View Read Gateway”（只读代理），解决 RPC 速率/审计/SSR

若你们希望把“读链上 View”也纳入后端日志、统一速率限制或 SSR，需要注意两件事：

1) **`eth_call` 的 `from` 可被伪造**：节点允许任意设置 `from`，它不是签名，不等于“用户已授权”。
   - 这意味着：后端如果提供 `/api/view/*?user=0xVictim` 这类接口，而不做强鉴权，攻击者可以把 `from=user` 伪造为 Victim，从而绕过 Scheme U 的“self-read”门槛。
2) 因此后端代理用户私域数据时必须二选一（推荐第 1 个）：
   - **方案 1（推荐）**：只对“已认证为该地址的用户”开放代理读取（例如 SIWE / 钱包签名登录后绑定 session），并强制 `req.userAddress === query.user`。
   - **方案 2（更保守）**：后端不代理任何 Scheme U 用户私域 View，只代理 system-level View（后端 own signer 持有 `VIEW_SYSTEM_DATA/VIEW_PRICE_DATA/...`）。用户私域仍走前端直连。

#### C) 后端代理读取的最小实现要点（TypeScript / ethers v6）

以“后端代理用户读取自己的 LoanNFT 列表”为例：

- 参数校验：`limit` 必须在 `1..100`（与链上 `ViewConstants.MAX_BATCH_SIZE` 对齐），`offset` 允许越界但要返回空列表。
- 鉴权：必须保证请求方确实是 `user`（否则禁止）。
- 调用方式：`eth_call` 时把 `from` 设置为 `user`，以满足 `LoanNFTView.onlyAuthorizedUser(user)` 的 self-read 语义。

示例（伪代码，重点看 `from` 与鉴权约束）：

```ts
import { ethers } from "ethers";

async function getUserLoansViaViewGateway(params: {
  provider: ethers.JsonRpcProvider;
  loanNftViewAddr: string;
  user: string;
  offset: bigint;
  limit: bigint;
  authUserAddress: string; // 从登录态/签名会话得到
}) {
  if (params.authUserAddress.toLowerCase() !== params.user.toLowerCase()) {
    throw new Error("FORBIDDEN_ADDRESS_MISMATCH");
  }
  if (params.limit <= 0n || params.limit > 100n) {
    throw new Error("INVALID_LIMIT");
  }

  const loanNftView = new ethers.Contract(params.loanNftViewAddr, LOAN_NFT_VIEW_ABI, params.provider);

  // 关键：eth_call 使用 from=user（这不是签名，所以必须配合上面的鉴权）
  return loanNftView.getUserLoansPaginated(params.user, params.offset, params.limit, { from: params.user });
}
```

#### D) 什么时候必须走后端读模型（Explorer API），不要试图用 View 解决？

- 历史查询、跨用户聚合：当前走 `/api/portfolio/history` 与 `/api/rewards/ai-usage` 等现有接口；若需要“浏览器级”检索能力，再新增 `/api/explorer/*`。
- View 合约只负责“当前状态/快照”（带 meta），不负责“海量历史/复杂筛选”。

### 8.0.2 事件索引的最小可行落地（两种路线）

你们目前的后端形态更接近“API Server + DB + cron/worker”。在此基础上补齐索引层，有两条可选路线：

- **路线 A：Ponder 独立索引器（推荐，目标态）**
  - 单独进程订阅/回放链上 logs，写入 PostgreSQL 的 `chain_events/*` 与派生表。
  - 与 API Server 解耦：索引器只写库，API 只读库（外加必要的鉴权与多租户隔离）。

- **路线 B：先在后端内嵌一个 indexer worker（过渡方案）**
  - 延续 `chainSync.ts` 的风格，新增 `services/indexer/*`：按区间拉 `getLogs`，并将 `(chainId, txHash, logIndex)` 作为天然幂等键写库。
  - 优点：落地快；缺点：与 API 进程耦合更强，后续要拆分。

### 8.0.3 目标态（直接可用，无过渡）：后端全量接管 View 数据

你要求“**能直接用、不做过渡、按当前后端情况落地**”，因此这里给出**唯一推荐方案**：

**在 lending-backend 内部常驻两类任务**，并与现有路由体系/幂等体系完全一致：

1) **Indexer（事件索引）**：负责历史与时间线（浏览器能力）
- 输入：链上日志（`DataPushed`、`LoanNFT Transfer`、关键业务事件）
- 输出：`chain_events` + 派生读模型（如 `loan_orders`）
- 幂等：`(chainId, txHash, logIndex)` 唯一；冲突即幂等命中

2) **Snapshotter（View 快照）**：负责当前态与 meta
- 输入：链上 View 合约（Position/Health/LoanNFT/Reward/Fee/Stats/...）
- 输出：`view_snapshots`（最新快照）+ 现有 `portfolio_*` 读模型
- 触发：定时 + 事件驱动（DataPushed 触发局部刷新）

#### 8.0.3.1 数据源范围（全量 View 模块）

- **用户维度**：`PositionView`、`HealthView`、`LoanNFTView`、`RewardView`、`FeeRouterView`、`AccessControlView`
- **系统维度**：`StatisticsView`、`ViewCache`、`ModuleHealthView`、`SystemView`、`RegistryView`、`ValuationOracleView`
- **门面聚合**（可选但建议保留）：`DashboardView`、`CacheOptimizedView`、`UserView`、`BatchView`

#### 8.0.3.2 存储结构（与现有 DB 风格一致）

**A. 事件事实表（历史/审计）**
- `chain_events`：已在 §8.3.1 设计（`chainId/txHash/logIndex` 幂等）

**B. View 最新快照表（当前态）**

建议新增通用快照表（避免每个 View 都建一张表）：

```
view_snapshots
  chain_id        int
  view_name       varchar(64)
  scope           varchar(32)  -- user|asset|system|module
  subject         varchar(128) -- user addr / asset addr / module key
  payload         jsonb
  is_valid        boolean
  block_number    int
  version         int
  updated_at      timestamp
  UNIQUE (chain_id, view_name, scope, subject)
```

**C. 业务读模型表（前端高频用）**

保留现有 `portfolio_*` 表作为“高频读模型”，并增加：
- `loan_orders`（已在 §8.3.1 设计，来自 LoanNFT/LoanOrder 组合）
- 需要时再补 `reward_user_summary` / `fee_user_summary`（从 `view_snapshots` 聚合）

#### 8.0.3.3 路由与鉴权（遵循现有 /api 体系）

**现有路由保持不变**（前端已依赖）：
- `/api/portfolio/*`、`/api/rewards/*`、`/api/ai-credits/balance`、`/api/cache-retry/*`

**新增路由（Explorer 能力，必须实现）**：

```
src/routes/explorer/chain-events.ts
src/routes/explorer/loan-orders.ts
```

- `GET /api/explorer/loan-orders?user=0x..&role=borrower|lender|owner&limit=50&cursor=...`
- `GET /api/explorer/loan-orders/:orderId`
- `GET /api/explorer/loan-orders/:orderId/events?limit=100&cursor=...`
- `GET /api/explorer/chain-events?user=0x..&eventName=...&limit=100&cursor=...`

**鉴权规则**：
- 用户私域：沿用 `requireAuth`，强制 `req.user.addr === query.user`（防止 “from 伪造”）
- 管理/运维：沿用 admin/service 角色或 `x-service-token`

#### 8.0.3.4 幂等与重组处理（与后端现状一致）

- **事件幂等**：`chain_events` 唯一键 `(chainId, txHash, logIndex)`
- **请求幂等**：沿用 `src/lib/idempotency.ts` + `@easifi/shared`；写入类 API 支持 `X-Idempotency-Key`
- **reorg**：`chain_events.status` 标记 `PENDING/CONFIRMED/REORGED`，保留 `blockHash`，`finalityDepth` 由配置决定
> 现状补充：`X-Idempotency-Key` 已在 `/api/rewards/ai-usage/report` 生效，其它写入路由需按同口径接入。

#### 8.0.3.5 与前端调用的最终形态

- **当前态**：直接读 `/api/portfolio/*`（由 View Snapshotter 保持最新）
- **历史/时间线**：走 `/api/explorer/*`（由 Indexer 提供）
- **余额与账本**：继续走 `/api/rewards/*` 与 `/api/ai-credits/balance`

### 8.1 Ponder 配置示例

> 重要：本文档上游历史沿用了 `easifi-monorepo-wt/ponder-indexer` 的“目标态命名”。
> 但你们当前实际后端仓库是 `lending-backend`（本机路径：`/Volumes/AI-hosts/EasiFi-workspace/lending-backend`），且默认启动入口为 `pnpm dev → src/index.ts → src/server.ts`。
> 本节将给出与 **当前后端目录结构/启动方式完全对齐** 的可执行落地步骤：
> - 先用 **后端内嵌 indexer worker**（最快落地、可直接复用 Prisma/Express）
> - 再可选升级为 **独立 ponder-indexer 进程**（目标态，解耦写库/读库）

### 8.1.1 本地可执行：启动依赖（Postgres/Redis）

在 `lending-backend/` 下：

```bash
cd /Volumes/AI-hosts/EasiFi-workspace/lending-backend

# 仅启动本章需要的依赖（DB + Redis）
POSTGRES_USER=rwa POSTGRES_PASSWORD=rwa_password POSTGRES_DB=rwa_local \
  docker compose up -d postgres redis

# 可选：查看容器状态
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | sed -n '1,10p'
```

### 8.1.2 本地可执行：后端启动命令（与真实入口对齐）

后端真实启动脚本来自 `lending-backend/package.json`：
- 开发：`pnpm dev`（nodemon + ts-node，入口 `src/index.ts`）
- 生产：`pnpm build && pnpm start`（入口 `dist/index.js`）

```bash
cd /Volumes/AI-hosts/EasiFi-workspace/lending-backend
pnpm install

# 本地 .env（示例，仅列出与本章强相关项）
cat > .env <<'EOF'
NODE_ENV=development
PORT=8000

# DB / Redis
DATABASE_URL=postgresql://rwa:rwa_password@localhost:5432/rwa_local?schema=public
REDIS_URL=redis://127.0.0.1:6379

# 路由开关（注意：Portfolio 路由在当前后端是按开关启用的）
USE_TS_ROUTES=true
ENABLE_PORTFOLIO_ROUTES=true

# 链上 RPC（当前后端已使用这两个名字：chainSync.ts 会读取 ARBITRUM_RPC_URL 或 CHAIN_RPC_URL）
CHAIN_RPC_URL=http://127.0.0.1:18545

# （示例）AI Credits Vault（若你们要跑 credits 同步）
# AI_CREDITS_VAULT_ADDRESS=0x...
EOF

# Prisma：按当前仓库约定执行（若已有迁移）
pnpm exec prisma migrate deploy
pnpm exec prisma generate

pnpm dev
```

> 路由挂载口径（与 `src/server.ts` 一致）：所有业务路由挂在 `/api/*`。
> 示例：Portfolio API 实际路径为 `/api/portfolio/positions`、`/api/portfolio/history`。

```typescript
// 目标态：独立 indexer 进程（可选升级）
// 建议目录（与当前 lending-backend 对齐）：
//   /Volumes/AI-hosts/EasiFi-workspace/lending-backend/indexer/ponder/
// 说明：lending-backend 目前不是 pnpm workspace（无 pnpm-workspace.yaml），因此独立 indexer 最简单的方式是“单独目录 + 单独 package.json”。

// lending-backend/indexer/ponder/ponder.config.ts
import { createConfig, http } from "ponder";

// 直接复用 contracts/ 的 ABI（TypeChain 生成）
import { VaultRouterAbi } from "../contracts/typechain-types/VaultRouter";
import { RewardViewAbi } from "../contracts/typechain-types/RewardView";
import { CollateralManagerAbi } from "../contracts/typechain-types/CollateralManager";

export default createConfig({
  networks: {
    arbitrum: {
      chainId: 42161,
      transport: http(process.env.ARBITRUM_RPC_URL!),
    },
    arbitrumSepolia: {
      chainId: 421614,
      transport: http(process.env.ARBITRUM_SEPOLIA_RPC_URL!),
    },
  },
  contracts: {
    // DataPushed 是统一事件入口
    VaultRouter: {
      network: "arbitrum",
      abi: VaultRouterAbi,
      address: process.env.VAULT_ROUTER_ADDRESS! as `0x${string}`,
      startBlock: Number(process.env.START_BLOCK || 0),
    },
    RewardView: {
      network: "arbitrum",
      abi: RewardViewAbi,
      address: process.env.REWARD_VIEW_ADDRESS! as `0x${string}`,
      startBlock: Number(process.env.START_BLOCK || 0),
    },
  },
});
```

### 8.2 事件索引函数

```typescript
// lending-backend/indexer/ponder/src/index.ts
import { ponder } from "ponder:registry";
import { keccak256, toUtf8Bytes, AbiCoder } from "ethers";
import { IdempotencyKeys } from "@shared/idempotency";

// DataPushed 统一事件处理
ponder.on("VaultRouter:DataPushed", async ({ event, context }) => {
  const { dataTypeHash, payload } = event.args;
  const chainId = context.network.chainId;
  const txHash = event.transaction.hash;
  const logIndex = event.log.logIndex;

  // 幂等 Key：每条链上日志全局唯一
  const idemKey = IdempotencyKeys.chainEvent(chainId, txHash, logIndex);

  // 按 dataTypeHash 分发处理
  const decoder = new AbiCoder();

  const DEPOSIT = keccak256(toUtf8Bytes("DEPOSIT_PROCESSED"));
  const REWARD_EARNED = keccak256(toUtf8Bytes("REWARD_EARNED"));

  if (dataTypeHash === DEPOSIT) {
    const [user, asset, amount, blockNumber] = decoder.decode(
      ["address", "address", "uint256", "uint256"],
      payload
    );
    await context.db.ChainEvent.create({
      id: idemKey.value,
      data: {
        chainId,
        txHash,
        logIndex,
        eventType: "DEPOSIT_PROCESSED",
        user: user.toLowerCase(),
        asset: asset.toLowerCase(),
        amount: amount.toString(),
        blockNumber: Number(blockNumber),
        indexedAt: new Date(),
      },
    });
  }

  if (dataTypeHash === REWARD_EARNED) {
    const [user, amount, reason, ts] = decoder.decode(
      ["address", "uint256", "string", "uint256"],
      payload
    );
    await context.db.ChainEvent.create({
      id: idemKey.value,
      data: {
        chainId,
        txHash,
        logIndex,
        eventType: "REWARD_EARNED",
        user: user.toLowerCase(),
        amount: amount.toString(),
        reason,
        blockNumber: Number(event.block.number),
        indexedAt: new Date(),
      },
    });
  }
});
```

### 8.3 与当前 `lending-backend` 完全对齐的“内嵌 Indexer Worker”（推荐先做，能直接跑通）

目标：在不引入新进程/新技术栈的前提下，先把“浏览器能力三件套”跑通：
**链上日志 → PostgreSQL（读模型表）→ 分页 API（当前为 `/api/portfolio/*` 等路由，`/api/explorer/*` 仍为未来扩展）**。

#### 8.3.1 建议新增的表结构（Prisma 模型，最小可用）

你们当前 DB 已使用 Prisma（见 `prisma/schema.prisma`），推荐新增以下 3 个模型：

```prisma
// prisma/schema.prisma（建议新增，字段可按需要扩展）

model ChainSyncCursor {
  id                Int      @id @default(autoincrement())
  chainId            Int
  cursorName         String   @db.VarChar(64) // e.g. "vault_router_datapushed"
  lastProcessedBlock Int
  updatedAt          DateTime @updatedAt

  @@unique([chainId, cursorName])
  @@map("chain_sync_cursors")
}

model ChainEvent {
  // 天然幂等键：同一条 log 全局唯一
  // 建议格式："c{chainId}:{txHash}:log-{logIndex}"
  id         String   @id @db.VarChar(128)
  chainId    Int
  blockNumber Int
  blockHash  String   @db.VarChar(66)
  txHash     String   @db.VarChar(66)
  logIndex   Int
  address    String   @db.VarChar(42)
  topic0     String   @db.VarChar(66)
  eventName  String   @db.VarChar(64)
  argsJson   Json
  indexedAt  DateTime @default(now())
  status     String   @default("CONFIRMED") @db.VarChar(16) // PENDING|CONFIRMED|REORGED

  // 常用筛选列（可选，但强烈建议）
  userAddress String? @db.VarChar(42)
  asset       String? @db.VarChar(42)
  orderId     String? @db.VarChar(78) // uint256 as string

  @@index([chainId, blockNumber])
  @@index([chainId, userAddress])
  @@index([chainId, orderId])
  @@index([txHash])
  @@map("chain_events")
}

model LoanOrderReadModel {
  // orderId 作为字符串（uint256）
  orderId        String   @id @db.VarChar(78)
  chainId        Int

  borrower       String?  @db.VarChar(42)
  lender         String?  @db.VarChar(42)
  // 当前 LoanNFT 持有人（注意：你们的 E2E 已验证 transfer 会改变枚举 owner）
  nftOwner       String?  @db.VarChar(42)
  tokenId        String?  @db.VarChar(78)
  status         String?  @db.VarChar(32)

  createdBlock   Int?
  updatedBlock   Int?
  updatedAt      DateTime @updatedAt

  @@index([chainId, borrower])
  @@index([chainId, lender])
  @@index([chainId, nftOwner])
  @@map("loan_orders")
}
```

迁移命令（可直接执行）：

```bash
cd /Volumes/AI-hosts/EasiFi-workspace/lending-backend

# 生成迁移 + 更新 client
pnpm exec prisma migrate dev --name add_chain_events_and_loan_orders
pnpm exec prisma generate
```

#### 8.3.2 建议新增的 indexer 目录结构（与后端现有入口对齐）

后端当前以 `src/` 为 TS 主入口（`pnpm dev` 直接跑 `src/index.ts`），建议把内嵌 indexer 放在：

```
lending-backend/
  src/
    indexer/
      cursor.ts              # 读写 ChainSyncCursor
      idempotency.ts         # chainId/txHash/logIndex → id
      vaultRouterIndexer.ts  # getLogs + decode DataPushed
      loanIndexer.ts         # 从 ChainEvent 派生 LoanOrderReadModel
      run.ts                 # CLI 入口（可被 cron/pm2 调用）
```

并在 `lending-backend/package.json` 增加可执行脚本（命名建议）：

```json
{
  "scripts": {
    "indexer:run": "pnpm exec ts-node src/indexer/run.ts"
  }
}
```

执行示例：

```bash
cd /Volumes/AI-hosts/EasiFi-workspace/lending-backend

# 从某个区块开始回放（示例）；实际可用 cursor 自动续跑
CHAIN_RPC_URL=http://127.0.0.1:18545 \
DATABASE_URL=postgresql://rwa:rwa_password@localhost:5432/rwa_local?schema=public \
pnpm -s indexer:run -- --chainId 421614 --fromBlock 0 --toBlock latest
```

> 注意：即便你们未来升级为独立 Ponder 进程，上述目录结构与表设计仍然有用：
> - `ChainEvent` 作为“原始事实表”（审计/对账/重放）
> - `LoanOrderReadModel` 作为“前端友好表”（分页/筛选）

#### 8.3.3 API 路由命名（以 lending-backend 为准）

当前后端所有路由都挂在 `/api`（见 `src/server.ts`），分为“已落地”与“需新增”两组：

**已落地：Portfolio（开关：`ENABLE_PORTFOLIO_ROUTES=true`）**
- `GET /api/portfolio/positions?user=0x..`
- `GET /api/portfolio/summary?user=0x..`
- `GET /api/portfolio/history?user=0x..&limit=50&offset=0`（offset 分页，limit 默认 ≤ 100）
- `POST /api/portfolio/positions/refresh`

**已落地：Rewards（开关：`FEATURE_REWARD_ROUTES` / `ENABLE_REWARD_ROUTES`）**
- `POST /api/rewards/ai-usage`（用户查询，JWT）
- `POST /api/rewards/ai-usage/report`（内部上报）
  - 读取 `X-Idempotency-Key`（可选），当前实际幂等依赖 `requestId` + `(tenant_id, request_id)` 唯一索引
  - `requestId` 格式：`^[A-Za-z0-9:_-]{1,64}$`
- `POST /api/rewards/balance`、`POST /api/rewards/ledger`

**已落地：AI Credits**
- `GET /api/ai-credits/balance?tenantId=&user=0x..`（JWT 可选，支持 query user）

**已落地：Cache Retry**
- `POST /api/cache-retry/request`、`POST /api/cache/retry`、`GET /api/cache-retry/status?user=0x..&asset=0x..`

**已落地：Contracts 配置（JWT）**
- `GET /api/contracts/config`
- `GET /api/contracts/:contractName/abi`

**需新增：Explorer（链上历史/时间线）**
- `GET /api/explorer/loan-orders?user=0x..&role=borrower|lender|owner&limit=50&cursor=...`
- `GET /api/explorer/loan-orders/:orderId`
- `GET /api/explorer/loan-orders/:orderId/events?limit=100&cursor=...`
- `GET /api/explorer/chain-events?user=0x..&eventName=...&limit=100&cursor=...`

#### 8.3.4 与前端集成要点（避免 RPC 扫链）

- “当前状态/强一致”仍建议走链上 View（带 `isValid/blockNumber/version`），并由后端 Snapshotter 回写到 `/api/portfolio/*`。
- “历史/搜索/跨用户聚合”统一走 `/api/explorer/*`（由 Indexer 提供）；在 explorer 路由落地前，可暂用 `/api/portfolio/history` 与 `/api/rewards/ai-usage` 兜底。
- 前端可复用现有 `NEXT_PUBLIC_API_URL` 约定（见前端 `src/lib/portfolio/fetchers.ts` 用法）。

---

## 9. AI 服务修正（原地改动，非迁移）

### 9.1 修正清单

> `ai-services` 的核心能力（RAG/Embedding/向量搜索/Worker）全部保留，只修改幂等和跨服务通信相关的文件。

| 模块 | 文件路径 | 改动方式 |
|------|---------|---------|
| QA Service | `ai-services/src/services/qaService.ts` | **不改**（零修改） |
| Embedding Service | `ai-services/src/services/embeddingService.ts` | **不改**（零修改） |
| Vector Query | `ai-services/src/services/vectorQueryService.ts` | **不改**（零修改） |
| Usage Ledger | `ai-services/src/services/quota/usageLedger.ts` | **修改**：`import { IdempotencyKeys } from '@shared/idempotency'`；`usage_idempotency` 表查询替换为 `idempotency_registry` |
| Quota Guard | `ai-services/src/services/quota/vectorQuotaGuard.ts` | **微调**：Redis key 加 `{tenantId}:` 前缀（约 3 行改动） |
| AI Grant Client | `ai-services/src/services/rewards/aiGrantClient.ts` | **修改**：HTTP Header 加 `X-Idempotency-Key`；去掉自行构造 requestId 逻辑 |
| Idempotency Service | `ai-services/src/services/idempotencyService.ts` | **修改**：Redis key 格式改为 `IdempotencyKey.value` |
| Workers | `ai-services/src/workers/*` | **不改**（零修改） |
| Collectors | `ai-services/src/collectors/*` | **不改**（零修改） |

### 9.2 统一 AI 请求计费流程（修正后）

```
用户请求 → api-server → 幂等检查（IdempotencyGuard，三级防御）
    → Redis: DECRBY credits_balance:{tenantId}:{userId} 1
    → 余额 < 0 ? → 拒绝（余额不足）
    → 转发到 ai-services（携带 X-Idempotency-Key + X-Tenant-ID）
    → ai-services 处理请求（原有逻辑不变）
    → 成功 → 写入 usage_detail（使用统一 IdempotencyKey，替代旧 usage_idempotency）
    → 失败 → Redis: INCRBY 退回余额 + IdempotencyGuard.fail()

与先行系统的差异：
    旧: ai-services 自行构造 requestId → api-server 拼接成 entryId → 两侧 key 不一致
    新: ai-services 用 IdempotencyKeys.aiUsage() 生成 → Header 透传 → api-server 直接使用

定期对账（每小时）：
    链上: AICreditsVault.creditsBalance(tenantId, user)
    链下: SUM(usage_detail.points_charged) WHERE tenant_id = ?
    差异: |链上 - 链下| > threshold → 告警
```

---

## 10. AWS 部署架构

### 10.1 推荐架构（初期，$100–200/月）

```yaml
# easifi-monorepo-wt/infrastructure/docker-compose.production.yml

services:
  api-server:                          # 现有 api-server（修正后）
    image: ${ECR_REPO}/api-server:latest
    build:
      context: ../api-server
    deploy:
      replicas: 2
    environment:
      - DATABASE_URL=postgresql://...
      - REDIS_URL=redis://...
      - STRIPE_SECRET_KEY=${STRIPE_SECRET}
    ports:
      - "3000:3000"

  ponder-indexer:                      # 新增：链上事件索引
    image: ${ECR_REPO}/ponder-indexer:latest
    build:
      context: ../ponder-indexer
    deploy:
      replicas: 1
    environment:
      - DATABASE_URL=postgresql://...
      - ARBITRUM_RPC_URL=${ARBITRUM_RPC_URL}

  ai-services:                         # 现有 ai-services（修正后）
    image: ${ECR_REPO}/ai-services:latest
    build:
      context: ../ai-services
    deploy:
      replicas: 1
    environment:
      - DATABASE_URL=postgresql://...
      - REDIS_URL=redis://...
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - API_SERVER_URL=http://api-server:3000
```

### 10.2 AWS 资源清单

| 服务 | 规格 | 月费（估算） |
|------|------|------------|
| ECS Fargate（api-server × 2） | 0.5 vCPU, 1GB | ~$30 |
| ECS Fargate（ponder-indexer × 1） | 0.25 vCPU, 512MB | ~$10 |
| ECS Fargate（ai-services × 1） | 0.5 vCPU, 1GB | ~$15 |
| RDS PostgreSQL | db.t4g.micro | ~$15 |
| ElastiCache Redis | cache.t4g.micro | ~$13 |
| ALB | 标准 | ~$20 |
| CloudWatch | 基础 | ~$5 |
| S3（备份/日志） | 标准 | ~$2 |
| **总计** | | **~$110/月** |

---

## 11. CI/CD 与监控

### 11.1 GitHub Actions Pipeline

```yaml
# .github/workflows/deploy.yml
name: Deploy to AWS
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: test
          POSTGRES_PASSWORD: test
      redis:
        image: redis:7
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run test:idempotency   # 幂等层单测（必须通过）
      - run: npm run test:ledger         # 账本单测
      - run: npm run test:integration    # 集成测试

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
      - uses: aws-actions/amazon-ecr-login@v2
      - run: docker build -t $ECR_REPO/saas-api:$GITHUB_SHA .
      - run: docker push $ECR_REPO/saas-api:$GITHUB_SHA
      - run: aws ecs update-service --force-new-deployment
```

### 11.2 必须监控的指标

| 指标 | 告警阈值 | 说明 |
|------|---------|------|
| `idempotency_hits_total` | 无（信息类） | 幂等命中率，过高可能有重试风暴 |
| `idempotency_conflicts_total` | > 10/min | payload 不匹配的冲突，说明 Key 生成有 bug |
| `ledger_entry_latency_p99` | > 200ms | 账本写入延迟 |
| `chain_indexer_lag_blocks` | > 100 blocks | Ponder 索引落后 |
| `recon_diff_absolute` | > 0.01 | 链上/链下对账差异 |
| `credits_balance_negative` | > 0 | 余额透支，说明扣费与同步有竞态 |

---

## 12. 对账与审计

> **核心原则**：链上为 SSOT（B），链下必须对齐链上。对账方向永远是 **链下 → 链上**。

### 12.1 五维对账模型（对齐链上完善的 Reward 系统）

```
维度 1: 奖励通证余额对账（每小时；legacy 字段名 rlp_balance）
  ∀ (tenant, user):
     user_reward_cache.rlp_balance == IERC20(Registry[KEY_EASY_TOKEN]).balanceOf(user)
  
  偏差处理：以链上为准，重新同步链下缓存
  触发方式：Ponder 索引奖励通证 `Transfer` 的 mint/burn 事件

维度 2: Reward 账本对账（每 6 小时）
  ∀ (tenant, user):
    user_reward_cache.locked_points == RewardManagerCore._lockedPoints[user]（通过 RewardView 读取）
    user_reward_cache.penalty_debt == RewardManagerCore._penaltyLedger[user]（通过 RewardView 读取）
    user_reward_cache.user_level == RewardManagerCore._userLevels[user]（通过 RewardView 读取）
  
  偏差处理：以链上 RewardView 为准，重新同步
  补偿机制：若链下遗漏 DataPushed 事件，检查 RewardViewPushFailed 事件并重试

维度 3: AI Credits 对账（每小时，关键）
  ∀ (tenant, user):
    AICreditsVault.creditsBalance(tenant, user)      -- 链上审计余额 (B)
    == credit_balances.available_credits              -- 链下实时余额
       + SUM(ai_requests WHERE status='SUCCEEDED' AND NOT settled)  -- 已用未结算
       - SUM(ai_requests WHERE status='RESERVED')    -- 占用中

  偏差处理：
    |差异| < 阈值 (5%) → 记录 warning
    |差异| >= 阈值 → 告警 + 暂停新扣次 + 人工审查
    链上余额 < 链下可用余额 → 紧急停止扣次（防止透支）

维度 4: 复式平衡校验（每日）
  ∀ tenant: SUM(所有链下 ledger_entries 借方) == SUM(所有链下 ledger_entries 贷方)
  ∀ (tenant, account, currency): 
    accounts.balance == initial_balance + SUM(credits) - SUM(debits)

维度 5: 链上事件完整性校验（每日）
  链上: COUNT(DataPushed events WHERE dataTypeHash IN REWARD_*) for block range
  链下: COUNT(ledger_entries WHERE source='chain_event') for same block range
  
  偏差处理：若链下 < 链上，说明有遗漏事件 → 触发 Ponder re-index
  补充检查：RewardViewPushFailed 事件数量 → 若 > 0，触发链下重试逻辑
```

### 12.2 AI Credits 批量结算对账（特别流程）

```
结算前检查（每批次）:
  ∀ user in batch:
    AICreditsVault.creditsBalance(tenantId, user) >= creditsUsed[user]
    若不满足 → 该批次不提交，标记为 FAILED，告警

结算后验证:
  1. 链上 CreditsSettled 事件确认（tx receipt）
  2. 链下更新 credit_settlement_batches status = 'CONFIRMED'
  3. 验证: AICreditsVault.creditsBalance(tenantId, user) 
           == 结算前余额 - creditsUsed[user]
  4. 若验证失败 → 告警 + 暂停后续结算

Reorg 处理:
  如果已确认的结算批次被 reorg 回滚：
  → 链下标记 status = 'REORGED'
  → 重新生成结算批次并提交
  → 监控 block confirmations 数量（建议 ≥ 20 blocks for Arbitrum）
```

### 12.3 对账脚本入口

```bash
# ===== 运行全量对账（五维） =====
npm run recon:full

# ===== 逐维度对账 =====

# 维度 1: 奖励通证余额（legacy 脚本名：recon:rlp）
npm run recon:rlp -- --chain-id=42161

# 维度 2: Reward 账本（locked/penalty/level）
npm run recon:reward -- --chain-id=42161

# 维度 3: AI Credits（链上 vs 链下）
npm run recon:credits -- --tenant=acme-corp

# 维度 4: 复式平衡
npm run recon:ledger-balance -- --tenant=acme-corp

# 维度 5: 事件完整性
npm run recon:events -- --chain-id=42161 --from-block=1000000 --to-block=latest

# ===== 特定操作 =====

# 指定租户全量对账
npm run recon:tenant -- --tenant=acme-corp

# 查看对账报告
npm run recon:report -- --date=2026-02-11

# 强制 re-sync 链上状态到链下
npm run recon:force-sync -- --tenant=acme-corp --user=0x1234...
```

---

## 13. 风险与回退策略

### 13.1 关键风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| Ponder 索引服务宕机 | 中 | 链上事件镜像延迟，链下 ledger_entries 滞后 | 自动重启 + 告警；冷启动快（37s）；链上 SSOT 不受影响 |
| RPC 节点不可用 | 低-中 | 链上查询/对账失败 | 配置多个 RPC 端点（Alchemy + Infura）；链下 AI 扣次不受影响 |
| RewardView push 失败 | 中 | 链下遗漏 DataPushed 事件 | 监控 `RewardViewPushFailed` 事件 → 链下重试；链上 SSOT 不受影响 |
| 链下/链上 AI Credits 不一致 | 低-中 | 用户可能透支或无法使用 | 每小时对账（维度 3）；差异超 5% 暂停扣次 |
| settleBatch Reorg | 低 | 链上结算回滚，链下状态不一致 | 监控 block confirmations ≥ 20；Reorg 检测 → 重新结算 |
| PostgreSQL 故障 | 低 | AI 扣次不可用（链上功能不受影响） | RDS Multi-AZ + 自动故障转移 |
| Redis 故障 | 低 | 幂等 Level 1 失效；AI Credits 实时余额不可用 | ElastiCache 副本；Level 2/3 仍然工作；fallback 到 DB 直查 |
| Stripe Webhook 丢失 | 低 | 订阅状态不一致 | Stripe 自动重试 + 定期轮询同步 |
| 链上 MINTER_ROLE 泄露 | 极低 | 奖励通证（目标态 EasyToken）被非授权铸造 | MINTER_ROLE 单持有人（EasyEmissionController）；setSoleMinter 硬收口；burn 由独立 BURNER_ROLE 承担 |
| 幂等 Key 冲突（hash 碰撞） | 极低 | 请求被错误拒绝 | 128 字符 key + payload hash 双重校验 |

### 13.2 回退策略

```
如果修正后出现回归 Bug：
  → Prisma migration 支持 rollback（npx prisma migrate resolve）
  → 旧代码分支保留为 `pre-idempotency-fix` tag，可随时切回
  → 幂等层在 packages/shared/ 中独立，可灰度切换（feature flag）

如果 Ponder 性能不足：
  → 回退到自建 ethers.js + WebSocket 监听（现有系统已有经验）
  → 幂等 Key 格式不变（chain:c{chainId}:tx-{hash}:log-{idx}）

如果多租户 RLS 性能瓶颈：
  → 升级到 Schema-Per-Tenant（每个租户独立 schema）
  → 或 Database-Per-Tenant（大客户独享实例）
  → 账本 API 不变，只改底层路由

如果 DB migration 风险太大（生产数据多）：
  → 先在新列写入（双写），旧列保留
  → 观察 1 周后切换读取路径
  → 确认无问题后再删旧列（渐进式 migration）
```

---

## 14. 前后端并行实施计划

> **核心思路**：后端的 Phase 1-2 修正（幂等/账本/Ponder）与前端的 P0-P2 修改（View 迁移/Meta/Reward/签名）
> 之间**大部分互不依赖**。前端链上交互不需要等后端 API。真正需要联调的只有 Phase 3 的最后一周。
> 合理错位后，总工期 21 天（后端主导），比串行方案节省约 3 周。
>
> **关联文档**：前端侧并行计划见 `docs/Usage-Guide/Frontend-Modification-Guide.md` 第 17 节。

### 14.1 并行时间线总览

```
后端 Phase 1 (Day 1-5)        后端 Phase 2 (Day 6-12)       后端 Phase 3 (Day 13-21)
┌─────────────────────┐  ┌──────────────────────────┐  ┌─────────────────────────┐
│ 幂等层 + 账本隔离修正 │  │ ai-services 修正          │  │ AWS 部署 + 生产加固       │
│ packages/shared      │  │ Ponder 链上索引            │  │ Docker + CI/CD            │
│ LedgerService 修正   │  │ Stripe 路由                │  │ 对账脚本                  │
│ RLS 策略             │  │ AI Credits 余额同步        │  │ 灰度发布 + E2E 联调       │
└─────────────────────┘  └──────────────────────────┘  └─────────────────────────┘
         ↕ 无依赖               ↕ 部分依赖                    ↕ 联调
┌─────────────────────┐  ┌──────────────────────────┐  ┌─────────────────────────┐
│ 前端 P0 (Day 1-5)    │  │ 前端 P1 + P2 (Day 6-12)  │  │ 前端 P3 + 联调 (Day 13-18)│
│ ① moduleKeys 重写    │  │ ⑤ Reward 系统适配         │  │ ⑨ authFetch 幂等 Header   │
│ ② registryResolver  │  │ ⑥ blockTime ETA 映射      │  │ ⑩ Stripe 订阅 UI          │
│ ③ View 层接口迁移    │  │ ⑦ DataPushed 事件监听     │  │ ⑪ AI Credits 余额页面     │
│ ④ Meta 降级组件      │  │ ⑧ EIP-712 签名工具        │  │ ⑫ E2E 联调测试            │
│   + ABI 更新         │  │   + contractErrors 工具   │  │   + 多租户验证             │
└─────────────────────┘  └──────────────────────────┘  └─────────────────────────┘
```

### 14.2 后端各阶段的前端依赖分析

| 后端阶段 | 前端需要等待？ | 原因 |
|---------|-------------|------|
| Phase 1: 幂等层 + RLS | **否** | 前端此阶段只做链上交互（View 迁移），不调用后端 API |
| Phase 2: ai-services + Ponder | **少量** | AI Credits 余额查询 API 需要 Day 11 就绪 |
| Phase 2: Stripe 路由 | **否** | 前端先用 Mock，Stripe 路由在 Day 12 前就绪即可 |
| Phase 3: 部署 + 联调 | **是** | E2E 联调需要后端全部就绪 |

### 14.3 后端需要在关键节点提供的交付物

#### Day 5 交付物（Phase 1 完成时）

```
✅ packages/shared 发布（IdempotencyKey + IdempotencyGuard）
✅ api-server LedgerService 修正完成
✅ Prisma migration 跑通（tenant_id + idempotency_key + RLS）
✅ 幂等层单元测试通过
```

> 前端此时不需要任何后端产出。

#### Day 8 交付物（Phase 2 启动后第 3 天）

> **这是并行实施中最关键的交付物**——后端需要提供 API 接口契约（OpenAPI spec 或文档），
> 前端用此契约写 Mock 先行开发，无需等待后端实现完毕。

```
必须提供的 API 接口契约（不必实现完毕，只要接口定义 + 响应格式）：

  GET  /api/ai-credits/balance?tenantId=
       → { available: number, onChainAudit: number, reserved: number, isAligned: boolean }

  POST /api/ai/generate
       Headers: X-Idempotency-Key, X-Tenant-ID, Authorization
       Body: { prompt: string, requestId: string }
       → { result: string, tokensUsed: number } | 402 Insufficient Credits

  POST /api/stripe/create-checkout-session
       Body: { priceId: string }
       → { sessionId: string }

  GET  /api/stripe/subscriptions
       → { plan: string, status: string, currentPeriodEnd: string }

  POST /api/cache-retry/request
       Body: { user: string, asset: string, viewAddr: string, blockNumber: number, logIndex: number }
       → { queued: boolean }

  GET  /api/cache-retry/status?user=&asset=
       → { status: string, lastRetry: string, attempts: number }
```

#### Day 12 交付物（Phase 2 完成时）

```
✅ ai-services 修正完成（IdempotencyKey 对齐 + 余额同步）
✅ Ponder 索引跑通（本地 → Sepolia 链上事件→ 链下同步）
✅ Stripe Webhook 路由就绪
✅ chainSync.ts 就绪（链上/链下 AI Credits 余额对齐）
✅ 接口契约全部实现（前端可切换到真实 API）
```

### 14.4 协同检查点

| 时间 | 检查点 | 后端动作 | 前端动作 |
|------|--------|---------|---------|
| **Day 1** | 项目启动 | 开始 packages/shared + 幂等层修正 | 拿到最新 ABI，开始 View 层迁移 |
| **Day 5** | Phase 1 验收 | 幂等层 + 账本隔离通过单元测试 | P0 完成，localhost 链上读路径跑通 |
| **Day 8** | API 契约交付 | 提供 API 接口文档/OpenAPI spec | 拿到接口文档，用 Mock 先行开发 |
| **Day 12** | Phase 2 验收 | ai-services + Ponder + Stripe 就绪 | P1/P2 完成，开始联调 |
| **Day 15** | E2E 联调 | 配合联调，修复对接问题 | 前端 → 后端 → 链上全链路 |
| **Day 18** | 全部验收 | 全部功能完成 | 所有修改完成 |
| **Day 21** | 灰度发布 | AWS 部署，灰度发布，监控 | 配合灰度验证 |

### 14.5 风险控制：并行实施的潜在风险

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| Day 8 接口契约延迟 | 中 | 前端 P3 开发延迟 | 前端持续使用 Mock + 链上直接调用 |
| 幂等 Key 格式前后端不一致 | 低 | 请求被拒绝 | Day 1 统一确认 `IdempotencyKey` 格式；共用 `packages/shared` |
| Ponder 索引延迟 | 中 | 链下数据滞后，AI Credits 余额不同步 | 前端降级到链上直接读 `AICreditsVault.creditsBalance()` |
| Stripe Webhook 集成问题 | 低 | 订阅状态不更新 | 前端轮询 `GET /api/stripe/subscriptions` 兜底 |
| E2E 联调发现大量 Bug | 高 | 延误发布 | 预留 Day 15-18 四天联调；关键路径优先修 |

### 14.6 Git 分支策略（前后端并行）

```
main
  ├── fix/unified-idempotency          # 后端修正主分支
  │     ├── Day 1-5: 幂等层 + 账本隔离
  │     ├── Day 6-12: ai-services + Ponder + Stripe
  │     └── Day 13-21: 部署 + 加固
  │
  └── feat/frontend-view-migration     # 前端修改主分支
        ├── Day 1-5: P0（View 迁移 + Meta + Registry）
        ├── Day 6-12: P1+P2（Reward + ETA + 签名 + 事件）
        └── Day 13-18: P3 + 联调

合并策略：
  1. Day 5: 后端 Phase 1 验收通过 → merge 到 main
  2. Day 5: 前端 P0 验收通过 → merge 到 main
  3. Day 12: 后端 Phase 2 + 前端 P1/P2 → 分别 merge 到 main
  4. Day 18: 前端 P3 + E2E 联调通过 → merge 到 main
  5. Day 21: 后端 Phase 3 灰度验证 → merge 到 main → 发布
```

### 14.7 并行实施 Checklist（项目经理用）

```
Phase 1 (Day 1-5):
  □ 后端: packages/shared 发布
  □ 后端: LedgerService 修正 + 单元测试
  □ 后端: Prisma migration 跑通
  □ 前端: moduleKeys 重写 + registryResolver 修正
  □ 前端: VaultViewService → View 层迁移
  □ 前端: Meta 降级组件 + metaHelpers
  □ 前端: ABI 文件更新
  □ 检查点: 各自 localhost 验证通过

Phase 2 (Day 6-12):
  □ 后端: ai-services 修正（幂等 Key + 余额同步）
  □ 后端: Ponder 索引跑通
  □ 后端: Stripe Webhook 路由
  □ 后端: Day 8 提供 API 接口契约 ⚠️ 关键交付物
  □ 前端: rewardStore 重构 → RewardView
  □ 前端: blockTime ETA 映射
  □ 前端: DataPushed 事件监听
  □ 前端: EIP-712 签名工具
  □ 前端: contractErrors 解码器
  □ 检查点: 前端可切换到后端真实 API

Phase 3 (Day 13-18/21):
  □ 前端: authFetch 加 X-Idempotency-Key + X-Tenant-ID
  □ 前端: Stripe 订阅 UI
  □ 前端: AI Credits 余额页面（切换到真实 API）
  □ 联调: 幂等 Key 端到端透传
  □ 联调: 多租户数据隔离
  □ 联调: 链上/链下 AI Credits 对齐
  □ 联调: Stripe Checkout 全流程
  □ 后端: AWS 部署 + Docker
  □ 后端: CI/CD + 监控
  □ 后端: 对账脚本
  □ 最终: 灰度发布 + 生产验证
```

---

## 附录 A: 原地修正清单（逐文件改动指引）

> 以下是需要改动的所有文件，按优先级排列。**未列出的文件 = 零修改，保持原样。**

| 优先级 | 文件路径 | 改动类型 | 改动内容 |
|--------|---------|---------|---------|
| **P0** | `api-server/src/lib/idempotency.ts` | **重写** | 废弃 `IdempotencyKeyRegistry`，替换为 `import { IdempotencyGuard } from '@shared/idempotency'` + 三级防御 |
| **P0** | `api-server/src/services/ledger/LedgerService.ts` | **修正** | ① 参数加 `tenantId`；② `entry_id` → `idempotency_key`；③ 事务内 `SET app.tenant_id` |
| **P0** | `api-server/src/usecases/reward/ConsumeEasyWithPlatformMirror.ts` | **修正** | ① `entryId` → `IdempotencyKeys.rewardConsume(userId, requestId).value`；② 去掉 `catch 23505` |
| **P0** | `api-server/prisma/schema.prisma` | **修正** | `Account`: PK → `(tenant_id, account_id, currency)`；`LedgerEntry`: 加 `tenant_id` + `idempotency_key`，UNIQUE → `(tenant_id, idempotency_key)` |
| **P0** | `api-server/prisma/migrations/` | **新增** | `add_tenant_id_to_accounts`、`add_idempotency_registry`、`enable_rls` |
| **P1** | `ai-services/src/services/rewards/aiGrantClient.ts` | **修正** | Header 加 `X-Idempotency-Key`；去掉自行构造 requestId |
| **P1** | `ai-services/src/services/quota/usageLedger.ts` | **修正** | 幂等 key → `IdempotencyKeys.aiUsage(...)`；表 → `idempotency_registry` |
| **P1** | `ai-services/src/services/idempotencyService.ts` | **修正** | Redis key 格式 → `IdempotencyKey.value` |
| **P2** | `ai-services/src/services/quota/vectorQuotaGuard.ts` | **微调** | Redis key 加 `{tenantId}:` 前缀（~3 行） |
| **P2** | `api-server/src/services/billing/billingStatementService.ts` | **修正** | 从统一 `usage_detail` 聚合（替代分散查询） |
| **P2** | `api-server/src/routes/stripe.ts` | **新增** | Stripe Webhook 处理路由 |
| **P3** | `api-server/src/services/pricing/pricingEngine.ts` | **不改** | 原样保留 |
| **新增** | `packages/shared/src/idempotency/IdempotencyKey.ts` | **新建** | 统一幂等 Key 生成器（本文第 2.2 节） |
| **新增** | `packages/shared/src/idempotency/IdempotencyGuard.ts` | **新建** | 三级防御检查（本文第 2.3 节） |
| **新增** | `ponder-indexer/` | **新建** | 链上事件索引服务（本文第 8 节） |
| **新增** | `infrastructure/` | **新建** | Docker/Terraform 部署配置 |

## 附录 B: 零修改模块清单（直接保留，不动一行）

> 以下模块在本次修正中**完全不需要改动**，确认它们的稳定性。

**ai-services（零修改）：**
- `ai-services/src/services/embeddingService.ts` — 文本向量化
- `ai-services/src/services/vectorQueryService.ts` — 向量检索
- `ai-services/src/services/qaService.ts` / `enhancedQAService.ts` — RAG 问答
- `ai-services/src/services/federatedQueryService.ts` — 联邦查询
- `ai-services/src/services/tenantCollectionResolver.ts` — 租户向量集合解析
- `ai-services/src/services/forecasting/costForecastService.ts` — 成本预测
- `ai-services/src/collectors/*` — 数据采集器
- `ai-services/src/workers/*` — 后台 Worker（Redis Stream）
- `ai-services/src/pipelines/*` — 数据处理管线
- `ai-services/src/processors/*` — 数据处理器

**api-server（零修改）：**
- `api-server/src/middleware/tenantDbSession.ts` — RLS 中间件（已正确）
- `api-server/src/middleware/tenantIsolation.ts` — 租户隔离中间件
- `api-server/src/middleware/tenantQuota.ts` — 租户配额中间件
- `api-server/src/services/pricing/pricingEngine.ts` — 定价引擎
- `api-server/src/routes/` — 大部分现有路由（除 rewards 端点需适配 X-Idempotency-Key）

## 附录 C: 快速启动命令

```bash
# ===== Day 1: 在现有 monorepo 中创建共享包 =====
cd easifi-monorepo-wt

# 1. 启用 npm workspaces（如未启用）
# 在根 package.json 中添加：
#   "workspaces": ["api-server", "ai-services", "packages/*", "ponder-indexer"]

# 2. 创建共享幂等包
mkdir -p packages/shared/src/idempotency
cd packages/shared
npm init -y
# 写入 IdempotencyKey.ts, IdempotencyGuard.ts（本文第 2.2、2.3 节）

# 3. 在 api-server 和 ai-services 中引用共享包
cd ../../api-server
npm install @shared/idempotency@workspace:*

cd ../ai-services
npm install @shared/idempotency@workspace:*

# ===== Day 2-3: 数据库修正 =====
cd ../api-server

# 4. 创建数据库 migration（修正 accounts + ledger_entries）
npx prisma migrate dev --name add_tenant_id_to_core_tables

# 5. 创建 RLS 策略（手写 SQL migration）
npx prisma migrate dev --name enable_rls_policies

# ===== Day 8: 初始化 Ponder =====
cd ..

# 6. 创建 Ponder 索引服务
npm create ponder@latest ponder-indexer
# 配置 ponder.config.ts（本文第 8.1 节）

# ===== 本地开发 =====

# 7. 启动本地依赖
docker-compose up -d postgres redis

# 8. 启动各服务
cd api-server && npm run dev        # API 服务（修正后）
cd ../ai-services && npm run dev    # AI 服务（修正后）
cd ../ponder-indexer && npm run dev  # Ponder 索引（新增）

# ===== 测试 =====

# 9. 运行修正相关测试
cd ../api-server
npm run test:idempotency    # 幂等层单测
npm run test:ledger         # 账本隔离单测
npm run test:integration    # 跨服务集成测试

# ===== 部署前检查 =====

# 10. 检查旧幂等代码是否已全部替换
grep -r "IdempotencyKeyRegistry" api-server/src/  # 应该无结果
grep -r "usage_idempotency" ai-services/src/      # 应该无结果
grep -r "catch.*23505" api-server/src/             # 应该无结果

# ===== 部署 =====

# 11. Docker 构建 + 推送
docker-compose -f infrastructure/docker-compose.production.yml build
docker-compose -f infrastructure/docker-compose.production.yml push

# 12. AWS 部署
cd infrastructure/terraform
terraform plan
terraform apply
```

## 附录 D: Git 分支策略

```
main                          # 生产分支（不直接修改）
  └── fix/unified-idempotency # 本次修正的主分支
       ├── Day 1-5: 幂等层 + 账本隔离
       ├── Day 6-12: ai-services 修正 + Ponder + Stripe
       └── Day 13-21: 部署 + 加固

建议工作流：
  1. 从 main 创建 fix/unified-idempotency
  2. 修正前先打 tag: git tag pre-idempotency-fix（回退锚点）
  3. 每个 Phase 完成后 merge 到 main（附带验收测试结果）
  4. 生产部署后删除修正分支
```

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

---

> **文档维护说明**：本文档为实施阶段的活文档，**基于对现有 `easifi-monorepo-wt/` 系统的原地修正**。
> 随着实施进展，请及时更新各阶段验收状态和架构决策变更。
>
> **版本历史**：
> - v3.1（2026-02-11）：新增第 14 节"前后端并行实施计划"——与前端 Frontend-Modification-Guide 第 17 节对齐
> - v3.0（2026-02-11）：第 4 节重写——基于链上完善的 Reward 系统建立 SSOT 分层架构（链上 SSOT + 链下镜像）；
>   新增链上会计模型（Earn/Spend/AI Credits 对照 `Reward-Best-Practices-Guide.md`）；
>   第 12 节升级为五维对账模型；第 13 节补充链上相关风险
> - v2.0（2026-02-11）：从"基于 Open SaaS 新建"改为"基于现有系统原地修正"，工期从 4 周缩短至 2.5–3 周
> - v1.0（2026-02-11）：初版，基于 Open SaaS 新建方案（已废弃）
>
> 关联文档：
> - `docs/Architecture-Guide.md`（链上架构 SSOT）
> - `docs/FRONTEND_CONTRACTS_INTEGRATION.md`（前端集成 SSOT）
> - `docs/Usage-Guide/Reward-Best-Practices-Guide.md`（Reward 最优实践 SSOT）
> - `docs/Usage-Guide/AI-Credits-Billing-Guide.md`（AI Credits 计费 SSOT）

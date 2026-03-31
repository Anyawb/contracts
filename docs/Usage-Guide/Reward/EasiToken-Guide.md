# Easy（平台唯一治理与生态通证）使用指南（Earn/Spend/View + Staking/Governance）

> 适用范围：本仓库 Reward 子系统（Earn/Spend/View + EasyEmission/EasyConsumption/EasyRecycle + EasyStaking/CrossChainGovernance）。
>
> 目标态口径：**平台唯一通证 = Easy（`EasyToken`）**，不引入第二套奖励资产。
>
> 相关架构 SSOT：`docs/Architecture-Guide.md`（Reward 章节、View 权限方案、block 口径）。

---

## 0) 一句话结论（先读这个）

- **Easy（`EasyToken`）是唯一通证（18 decimals）**：用于借贷激励（Earn）、生态支付（Spend）、治理（Stake→Vote）。
- **借贷挖矿发币按白皮书公式执行**：借贷“完成/结清”触发铸币，基于**净借款额**（扣除借款侧 0.3% = 30 bps 手续费）计算，奖励 **借贷双方 50/50**。
- **EasiM/API 外调按次支付 1 Easy**：支付进入回收模块，按 75/15/10 自动销毁与分配。
- **治理投票权 SSOT = stEASY（`EasyStaking` 产生的 `ERC20Votes`）**：`CrossChainGovernance` 读取 `getPastVotes`；用户 stake 时自动 self-delegate。

---

## 1) 名词与资产边界（必须对齐）

### 1.1 Easy / EasyToken

- **合约**：`src/Token/EasyToken.sol`
- **标准**：Upgradeable ERC20 + Pausable + Permit + Votes（`ERC20Votes`）
- **精度**：`decimals() = 18`
- **资产归属**：链上余额归属到用户钱包地址
- **权限模型（重要）**：
  - 铸造/销毁由 `MINTER_ROLE` 控制
  - 目标态建议将 `MINTER_ROLE` 收敛为单一持有人（避免多铸造源漂移）

### 1.2 治理投票权（SSOT：stEASY 投票）

- **质押合约**：`src/Governance/EasyStaking.sol`
- **治理合约**：`src/Governance/CrossChainGovernance.sol`
- **SSOT**：治理读取的 `IVotes` token 来自 Registry（目标态为 `KEY_EASY_STAKING`）。
- **重要语义**：
  - 用户需要 stake 才有投票权（`EasyStaking` 会在首次 stake 时自动 self-delegate）
  - 投票权快照使用 `getPastVotes(voter, snapshotBlock)`（block 口径）

### 1.3 AI Credits（按次计费单位）

- **链上 SSOT（审计余额）**：`AICreditsVault.creditsBalance(tenantId, user)`
- **链下 SSOT（实时扣次/退款/幂等）**：`usage ledger`
- **归属维度**：`(tenantId, user wallet address)`（多租户隔离在 credits 层）

> 参考：`docs/Usage-Guide/AI-Credits-Billing-Guide.md`

---

## 2) Easy 如何获得（Earn：借贷“完成/结清”后触发）

### 2.1 触发时机（强约束：先落账，再触发）

Reward 的写入口 SSOT：

- 由 **`OrderEngine (Registry[KEY_ORDER_ENGINE])` 在 debt ledger 成功更新后**回调 Reward
- 非 `KEY_ORDER_ENGINE` 调用 Reward 写入口必须 revert（避免双入口/双语义）

> 架构 SSOT：`docs/Architecture-Guide.md` → Reward 章节 → “方案 B（KEY_ORDER_ENGINE + 按订单入口优先）”

### 2.2 推荐主路径（按订单维度，含 lender/asset）

推荐入口（SSOT）：

- `RewardManager.onLoanEventByOrderWithLender(borrower, lender, asset, orderId, amount, maturityBlock, outcome)`
  - `maturity` 语义为 **`maturityBlock`（到期区块高度）**，不是 timestamp
  - `outcome`：`0=Borrow, 1=RepayOnTimeFull, 2=RepayEarlyFull, 3=RepayLateFull`
  - 该入口会同步触发：
    - `RewardManagerCore`（锁定/扣罚/欠分账本等保留机制）
    - `EasyEmissionController`（按白皮书公式铸 Easy，并按 borrower/lender 50/50 分配）

### 2.3 发币规则（白皮书 SSOT）

- **发币触发**：每笔借贷完成（结清）自动铸币发行，平分给借贷双方
- **手续费口径**：平台总费率为 **0.6%**（借款侧 0.3% + 还款侧 0.3%）；mint 口径以“净借款额”（借款侧扣费后）计算
- **最低额度**：单笔借贷额最低 1000U
- **两阶段公式**：
  - 红利期：累计借贷总额 < 1 亿 U：每 1000U → 10 Easy（双方各 5）
  - 通缩期：累计借贷总额 ≥ 1 亿 U：
    - 单笔新增发行数量 = 借贷额度 ÷ 100 ÷ (1 + 10⁻⁷ × 留存Easy总数)
  - 其中“留存Easy总数”采用链上可观测单一口径（见 2.4）
### 2.4 “留存 Easy 总数”口径（白皮书 SSOT）

- 白皮书原文为“链上留存 Easy 总数”。目标态采用 **`EasyToken.totalSupply()`** 对应的留存数量口径。
- 工程实现通常会把 `totalSupply` 换算为“以 1 Easy 为单位的整数 token 数”（例如 `totalSupply / 1e18`），以匹配白皮书公式里的“总数”。

---

## 3) Easy 如何使用（Spend：按次支付）

### 3.1 按次支付（白皮书 SSOT）

- **EasiM 调用**：每次支付 1 Easy
- **策略 API 外调**：每次支付 1 Easy
- 链上入口（SSOT）：`src/Reward/EasyConsumption.sol`
- 分配比例：75/15/10（销毁/团队/生态）。

可观测性 SSOT：消费/回收相关的链下订阅一律使用 `RewardView.DataPushed(...)`；当前主类型是 `DATA_TYPE_EASY_SPENT` 与 `DATA_TYPE_EASY_RECYCLED_SPLIT`，不要只过滤 `DATA_TYPE_REWARD_*`。

### 3.2 Easy 与 AI Credits 的关系

- AI Credits 是独立的按次计费单位（见 `docs/Usage-Guide/AI-Credits-Billing-Guide.md`）。

---

## 4) 治理：质押 Easy → stEASY 投票（白皮书 SSOT）

### 4.1 核心规则

- **投票权 token**：`stEASY`（`EasyStaking` 的 `ERC20Votes`）
- **快照口径**：治理合约使用 `getPastVotes(voter, snapshotBlock)`（block 口径）
- **委托激活**：`EasyStaking.stake` 会在首次 stake 时自动 self-delegate

### 4.2 设计取舍（必须知情）

- **优点**：治理权与质押绑定，更符合白皮书“持有并质押 Easy 才能投票”的口径
- **代价**：引入 staking 模块与质押状态；需要确保 Registry SSOT 与缓存一致（见 4.3）

### 4.3 CrossChainGovernance 的 SSOT 绑定（Scheme B：缓存 + 强约束）

- `CrossChainGovernance` 的 **唯一治理 token SSOT** 是 `Registry[KEY_EASY_STAKING]`（也就是 stEASY 合约地址）
- 初始化口径：`CrossChainGovernance.initialize(admin, registry)`（registry 必填）
- 合约内部会缓存 `governanceToken`，但在 `createProposal/vote` 等关键路径会强校验 `governanceToken == Registry[KEY_EASY_STAKING]`
- 当 Registry 更新 `KEY_EASY_STAKING` 后，需调用 `CrossChainGovernance.syncGovernanceTokenFromRegistry()` 刷新缓存；否则关键路径会 revert（防止使用 stale token）

---

## 5) 前端/链下对接（只读与事件流）

### 5.1 Reward 侧只读与订阅

- 只读入口：统一走 `RewardView`
- 订阅入口：统一订阅 `RewardView.DataPushed(dataTypeHash, payload)`，同时覆盖 `DATA_TYPE_REWARD_*` 与 `DATA_TYPE_EASY_*`

> 参考：`docs/Usage-Guide/Reward/Reward-Best-Practices-Guide.md`

### 5.2 stEASY（治理投票权）只读（IVotes / ERC20Votes）

- 只读 token 地址 SSOT：`Registry[KEY_EASY_STAKING]`
- 余额：`stEASY.balanceOf(user)`
- 当前投票权（需已 delegate）：`stEASY.getVotes(user)`
- 历史快照投票权：`stEASY.getPastVotes(user, blockNumber)`
- 历史总供给快照（用于 quorum）：`stEASY.getPastTotalSupply(blockNumber)`

---

## 6) 运维与安全注意事项（必须）

- **Registry 是模块地址 SSOT**：Reward/GovernanceGate/FeatureRegistry/Token 等模块地址必须通过 Registry 绑定与解析，避免 stale 指针
- **EasyToken 权限 SSOT（非 localhost）**：
  - `MINTER_ROLE` 仅授予 `EasyEmissionController`（发行）
  - `BURNER_ROLE` 仅授予 `RewardAccrualManager`（扣罚 burn 优先、否则记账）与 `EasyRecycleDistributor`（消费回收 burn）
  - `RewardManagerCore` 不应持有遗留 `BURNER_ROLE`；部署脚本应在发现时主动撤销
- **时间口径统一 blocks**：到期、窗口、治理快照等一律按 blocks；前端用平均出块时间做 ETA 展示
- **多租户边界**：Easy 不隔离 tenant；如产品需要隔离，必须在 credits/链下归因层实现

### 6.1 异常余额恢复（EasyRecycleDistributor）

- 正常情况下，Easy spend 只能通过 `EasyConsumption` 进入 `EasyRecycleDistributor.handleEasyIncome(...)`。
- 若发生异常直转，`EasyRecycleDistributor.settleOutstandingEasyBalance()` 是唯一恢复口。
- 恢复口不会改变分账规则，仍严格执行 75/15/10（burn/team/eco）。
- 上线前应至少验证一次该恢复路径，避免异常余额永久滞留在 recycle 合约。

---

## 7) 常见问题（FAQ）

### Q1：为什么我持有 stEASY，但 `getVotes` 还是 0？

`ERC20Votes` 默认需要用户 **delegate** 才会把余额计入投票权。一般情况下 `EasyStaking.stake` 会在首次 stake 时自动 self-delegate；如仍为 0，请检查是否已 delegate：

- `stEASY.delegate(self)`（自委托）或 delegate 给代表地址

### Q2：为什么 `getPastVotes` 会 revert？

`getPastVotes(account, timepoint)` 要求 `timepoint` 必须是“已出块的历史区块”。不要用当前区块号；建议用提案 `startBlock - 1` 做快照。


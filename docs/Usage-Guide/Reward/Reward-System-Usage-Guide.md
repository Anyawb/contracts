# Reward 系统使用说明

> 最后更新：2026-03-04  
> 本文档提供 Reward（EasyToken-only）奖励系统的完整使用指南

---

## 📋 目录

1. [系统概述](#系统概述)
2. [SSOT：EasyToken 语义与命名规范（并入）](#ssot-easytoken-语义与命名规范并入)
3. [部署后配置](#部署后配置)
4. [管理员操作](#管理员操作)
5. [用户操作](#用户操作)
6. [前端集成](#前端集成)
7. [API 参考](#api-参考)
8. [故障排除](#故障排除)

---

## 🎯 系统概述

Reward 系统是一个完整的用户激励和特权管理系统，通过奖励机制激励用户参与平台活动，并提供基于通证余额的特权服务。

> 重要口径（与 `docs/Usage-Guide/Reward/EasiToken-Guide.md` 对齐）：本文所称奖励通证均指 **Easy（`EasyToken`）**。
> 奖励通证地址 SSOT：`Registry[KEY_EASY_TOKEN]`。

### 核心组件（按现行实现）

- **RewardManager（Earn gateway）**：**借贷触发的奖励写入口门面 + 参数治理入口**（仅供 `OrderEngine` 落账后回调触发奖励（Easy）；治理权限走 ACM）
- **RewardManagerCore（Earn core）**：**Earn 侧核心**（借款锁定/还款释放、等级/统计；惩罚执行委托给 `RewardAccrualManager`；向 `RewardView` 推送）
- **RewardAccrualManager（Penalty SSOT）**：**扣罚与欠账账本单一事实来源**（优先 burn Easy；余额不足则记入 penalty ledger；统一向 `RewardView` 推送）
- **RewardView**：**统一只读 + 统一 DataPush**（前端/链下查询与订阅的推荐入口；链下统一订阅 `DataPushed`，并覆盖 `DATA_TYPE_REWARD_*` 与 `DATA_TYPE_EASY_*`）
- **RewardConfig**：**Reward 域治理写入口聚合**（EarnConfig / FeatureRegistry / GovernanceGate 等）
- **GovernanceGate**：**治理资格门控 SSOT**（`minLevel + stEASY votes`；这里的 level 指 `ServiceLevel`，由治理/运维写入）
- **FeatureRegistry**：**功能开关门控 SSOT**（`featureKey -> (enabled, minLevel, uri)`）
- **奖励通证（SSOT）**：`Registry[KEY_EASY_TOKEN]` 指向的 **EasyToken（Easy）**。
- **EasyToken**：生态通证（ERC20Votes，18 decimals；`mint*` 由 `MINTER_ROLE` 控制；`burn*` 由 `BURNER_ROLE` 控制）
- **EasyEmissionConfig / EasyEmissionController**：Easy 发行参数 SSOT + 发行控制器（按订单还款完成时发放 Easy）
- **EasyConsumption / EasyRecycleDistributor**：EasiM/Strategy API 按次消耗入口 + 75/15/10 回收分配
- **EasyStaking**：质押 Easy 获得投票权（stEASY / IVotes），并推送 `RewardView`

> 重要：**前端/链下只读查询统一从 `RewardView` 读取**（或透传），**不要直接依赖 `RewardManagerCore` 的事件/存储/查询接口**；写入路径严格遵循“落账后触发”。  
> 说明：`RewardManagerCore` 不提供面向前端/链下的只读接口；协议内校验（如 `LendingEngine` 期限门槛）统一走 `RewardView.getUserLevelForBorrowCheck`。

### ✅ 最佳实践与边界（强烈推荐先读）

为了避免把“Reward 奖励通证（目标态=Easy）”与“AI 按次计费（credits）”混用，本仓库提供了更清晰的口径文档：

- **Reward 最佳实践（本仓库推荐口径）**：`docs/Usage-Guide/Reward/Reward-Best-Practices-Guide.md`
  - 结论摘要：目标态为**单通证 Easy**；Earn 以订单维度（orderId）为主；只读统一走 `RewardView`；Reward 不做 tenant 差异化。
- **AI Credits 计费规范（1 次 = 1 credit）**：`docs/Usage-Guide/AI-Credits-Billing-Guide.md`
  - 关键边界：AI 调用**不应**通过逐次 burn “奖励通证（SSOT：Registry[KEY_EASY_TOKEN]）” 扣费；应使用 `AICreditsVault + 链下 usage ledger`（高频扣次、失败必退款、批量结算上链审计）。
- **上线/合并验收标准（E2E / Smoke / CI）**：`docs/Test-Guide/release-acceptance-standard.md`
  - 最短本地闸门（E2E strict）：`npx hardhat run scripts/e2e/e2e-localhost-full-with-views.ts --network localhost`
  - 最短 CI（real-chain read-path）：`bash scripts/tests/ci-realchain-template.sh`
- **Easy 通证与消费（EasiToken Guide）**：`docs/Usage-Guide/Reward/EasiToken-Guide.md`

### 唯一路径（强约束，和合约一致）

1. **落账**：`LendingEngine (OrderEngine)` 在 borrow/repay 业务链路中驱动 debt ledger（`KEY_LE`）成功更新后，才触发 Reward 回调（“先落账，再触发 Reward”）。  
2. **奖励入口（推荐主路径，按订单维度）**：`LendingEngine (OrderEngine)` 调用 `RewardManager.onLoanEventByOrder(user, orderId, amount, maturity, outcome)`（按订单锁定/释放/扣罚；其中 `maturity` 语义为 `maturityBlock`，到期区块高度）。  
  - **Easy 发行入口**：若上游能提供 `lender + asset`，使用 `RewardManager.onLoanEventByOrderWithLender(...)`（在任意“结清足额” repay outcome 下触发发行；并按白皮书门槛/口径计算）。
3. **核心处理**：`RewardManager` 转发到 `RewardManagerCore.onLoanEventByOrder*`（外部直接调会被拒绝并 `revert RewardManagerCore__UseRewardManagerEntry()`；不会再保留 no-op 或兼容审计事件）  
4. **只读聚合与推送**：  
   - **发放（Earn）侧**：`RewardManagerCore` 调用 `RewardView.push*`（writer 白名单）→ `RewardView` 统一发出 `DataPushed(dataTypeHash,payload)`  
  - **按次消耗（Spend/Recycle）侧**：`EasyConsumption` / `EasyRecycleDistributor` 调用 `RewardView.push*`（writer 白名单）→ `RewardView` 统一发出 `DataPushed(dataTypeHash,payload)`

### Earn 状态统一观测（新增硬约束）

- `RewardView.getUserEarnStateWithMeta(user)` 是 Earn 账本状态的统一只读入口，返回：
  - `lockedEasy`
  - `eligibleLoanCount`
  - `onTimeRepayCount`
- `RewardManagerCore` 在 borrow / repay 关键分支上必须 best-effort 推送上述状态到 `RewardView`，避免前端和链下回退读取内部存储。
- 前端/链下不要直接依赖 `RewardManagerCore` 内部状态变量或历史遗留 getter。

### Recycle 异常余额恢复（新增运维约束）

- 正常消费主路径仍然必须是：`EasyConsumption -> EasyRecycleDistributor.handleEasyIncome(...)`。
- 如果用户误把 Easy 直接转到 `EasyRecycleDistributor`，运维应调用 `settleOutstandingEasyBalance()` 做恢复结算。
- 恢复结算仍走统一 75/15/10（burn/team/eco），不得手工转账或旁路 burn。

### 等级体系（两条口径并存）

当前实现中 **Reward 域存在两套等级口径**，用途不同，务必区分：

#### A) ServiceLevel（治理/功能门控）

`ServiceLevel` 仅用于 **GovernanceGate / FeatureRegistry** 的门控，不承载任何“付费权益/订阅/价格体系”。

- **Basic** (0)
- **Standard** (1)
- **Premium** (2)
- **VIP** (3)

#### B) Reward Level（Earn/Borrow 等级，1-5）

`RewardManagerCore` 维护的用户等级范围是 **1-5**，用于：

- Borrow 长期限门槛（见下文“期限门槛”）
- Earn 侧锁定 Easy 的等级倍数（`EarnConfig.getLevelMultiplierBps`）
- 由 `LoanFlowView`（USD-8 SSOT）驱动的自动升级（非治理）

自动升级当前使用以下门槛（USD-8 SSOT + 订单计数）：

- Level 2：借款量 ≥ 10k U，合格借款 ≥ 3，按期 ≥ 1
- Level 3：借款量 ≥ 50k U，合格借款 ≥ 10，按期 ≥ 5
- Level 4：借款量 ≥ 100k U，合格借款 ≥ 20，按期 ≥ 10
- Level 5：借款量 ≥ 500k U，合格借款 ≥ 50，按期 ≥ 30

> 注意：Reward Level 与 ServiceLevel 不等价，治理门控只看 ServiceLevel（0-3）。

#### GovernanceAccess 门控（SSOT，合约级硬约束）

统一治理方案下（见 `docs/Usage-Guide/Governance-FeatureRegistry-SSOT-Design.md`）：

- 治理参与（`createProposal` / `vote`）以 `GovernanceGate` 为 **链上 SSOT** 做硬门控。
- 当前 Gate 的默认 policy（实现默认值）为：
  - **仅 VIP（ServiceLevel.VIP）可 propose/vote**
  - 可叠加 **EasyStaking 投票权（IVotes.getPastVotes 快照）阈值**（口径 A：`proposal.startBlock - 1`）
  - Gate 启用时若 `votesToken` 为零地址，将直接判定为 **不合格**（防止错误配置）

#### 治理投票权（SSOT：EasyStaking / IVotes，集成必读）

> 本小节用于把“投票权 token / 快照口径 / 委托激活 / CrossChainGovernance 绑定口径”一次讲清楚，避免集成时出现“有余额但投票权为 0”的常见误解。

- **投票权 token（SSOT）**：`EasyStaking (stEASY)`（`ERC20Votes` / `IVotes`）。
- **快照口径（block）**：
  - `GovernanceGate` / `CrossChainGovernance` 都基于 `IVotes.getPastVotes(user, snapshotBlock)`。
  - 推荐 `snapshotBlock = proposal.startBlock - 1`（避免同区块快照限制与边界条件）。
- **委托激活（非常重要）**：
  - `ERC20Votes` 默认采用“委托激活”模型；EasyStaking 在 `stake` 时会自动 self-delegate（若尚未 delegate）。
  - 若用户自行 delegate 给其他地址，投票权将按委托地址计。
- **CrossChainGovernance 的 SSOT 绑定（Scheme B：缓存 + 强约束）**：
  - 初始化口径：`CrossChainGovernance.initialize(admin, registry)`（registry 必填）。
  - `CrossChainGovernance` 的**唯一治理 token SSOT** 是 `Registry[KEY_EASY_STAKING]`（stEASY）。
  - 合约内部会缓存 `governanceToken`，但在 `createProposal/vote` 等关键路径会强校验一致性；若 Registry 更新了 `KEY_EASY_STAKING` 且未同步缓存，关键路径会 revert（防止使用 stale token）。
  - 运维要求：Registry 更新 `KEY_EASY_STAKING` 后，应调用 `CrossChainGovernance.syncGovernanceTokenFromRegistry()` 刷新缓存。

### Easy 奖励规则与期限门槛（现行）

- **奖励通证精度（SSOT）**：`Registry[KEY_EASY_TOKEN]` 指向的 `EasyToken` 的 `decimals() = 18`，因此当前“1 Easy（最小单位口径）”在链上表示为 `1e18`。
- **锁定-释放（当前链上基线）**：
  - **Order-based（推荐口径）**：
    - **Borrow**：`RewardManagerCore` 按订单维度锁定 Easy。
      - 基线：`1 Easy * levelMultiplierBps / 10000`（`EarnConfig.getLevelMultiplierBps`）
      - 可选动态奖励：若 `EarnConfig.getDynamicRewardParams` 启用且 `easyAmount >= thresholdEasy`，追加 `easyAmount * multiplierBps / 10000`
      - 本金不足 `1000 USDC`（6 decimals）直接不计分/不锁定
    - **RepayOnTimeFull**：释放锁定并抵扣欠分账本，计入按期履约次数（RMCore **不 mint**）
    - **RepayEarlyFull**：锁定作废，不发放、不处罚
    - **RepayLateFull**：锁定作废，按 `latePenaltyBps` 扣罚（不足则进入欠分账本）
  - **Easy 发行**：由 `EasyEmissionController` 处理（RMCore 不直接 mint）。
- **提前/逾期扣罚**（仅针对“结清足额”的 repay outcome）：
  - **提前还款**：不发放、不处罚（order-based 直接跳过；V1 逻辑也不处罚）
  - **逾期还款**：按 `latePenaltyBps` 扣罚（默认 500 = 5%）
  - **余额不足**：若 burn 失败，扣罚累积到**欠分账本**（`penaltyLedger`），后续发放时会先抵扣欠分再铸币
- **清算扣罚**（与资金链解耦的 Reward 边界）：
  - 触发方：`GuaranteeFundManager` 在 default 结果确定后调用 `RewardManager.applyLiquidationPenalty(user)`。
  - 权限：仅允许 `Registry[KEY_GUARANTEE_FUND]` 调用。
  - 计量口径：由 `RewardManagerCore` 在 Reward 域内部按 `lockedEasy[user] * liquidationPenaltyBps / 10000` 计算，默认 `liquidationPenaltyBps = 500`。
  - 重要约束：不得把保证金币种金额或清算资金金额直接当作 Easy 扣罚值；Reward 单位必须在 Reward 域内换算与落账。
  - 失败语义：该调用为 best-effort，失败不会回滚保证金没收；链下应结合 GuaranteeFundManager 事件与 RewardView 观测补偿/告警。
- **Easy 发行（EasyEmissionController）**：
  - 触发条件：`RepayOnTimeFull / RepayEarlyFull / RepayLateFull`（任意“结清足额”）
  - 门槛：借款金额折算为 USD-8 后 **≥ 1000U**（白皮书基线）
  - 费率：发行基于 **净借款额**（先扣借款侧 0.3% = 30 bps 费用；平台总费率为 0.6%，还款侧另计 0.3%）
  - 分配：borrower/lender **50/50**
  - 价格来源：`PriceOracle`（若价格不可用则跳过发行）
- **期限白名单（链上硬约束）**：`LendingEngine (OrderEngine)` 仅允许 `5/10/15/30/60/90/180/360` 天。
  - 链上判定是 **block-based**：订单的 `term/maturity` 以“区块数/区块高度”口径存储与校验（不是秒时间戳）。
  - 前端可用“天（days）”做 UX 输入，但必须按合约口径转换/对齐（见下方 `TermGuard.ts` 注释）。
  - **借贷形式（Borrow modes，按现行实现）**：
    - **A) 白名单期限借贷（主路径 / Order-based / legacy day buckets）**：用户选择期限 `5/10/15/30/60/90/180/360` 天；上链与风控判断一律按 block 口径（`termBlocks` / `maturityBlock`）。
      - **legacy 1 区块确认偏移（仅用于 day-bucket 产品的 maturity 消歧）**：若产品仍保留旧的确认偏移口径，则对外构造 `maturityBlock` 时可额外 **+1 区块确认**：`maturityBlock = openBlock + termBlocks + 1`。
        - 含义：借贷形成后（borrow 至少被 1 个区块确认）才进入同一套 `block.number >= maturityBlock` 的结算/清算边界检查轴；避免“形成区块=0 确认”带来的边界歧义。
        - 注意：这不是新增一种“1 区块期限”的借贷产品；它只服务于 day-bucket 产品的边界兼容语义。
    - **B) blocks-only 即时产品（新增设计 / 待合约实施）**：协议新增一条独立产品线，期限不再通过 `termDays` 桶表达，而是直接使用显式 `termBlocks`。
      - 首个产品选项为 **`termBlocks = 1`**，即“借贷形成后下一个区块即成熟”。
      - 该产品的 `maturityBlock` 语义应保持最小惊讶原则：**`maturityBlock = openBlock + 1`**，不得再叠加上述 day-bucket 的 `+1 confirmation offset`，否则会把“1 block 产品”变成实际 2 blocks 才成熟。
      - 该产品的设计目标是让撮合、清算、Reward 发放、后续 AMM/RFQ/RWA 自动交易都直接消费显式 blocks duration，而不是复用 `5/10/15/...` 天数桶。
      - 对应的 lender 约束也应采用显式 blocks 范围（例如 `minTermBlocks = 1`、`maxTermBlocks = 1`），不要把 `minTermDays/maxTermDays` 里的数值 `1` 误解为“1 block 产品”。
      - 当 `block.number >= maturityBlock` 时，该产品即可进入既有的“结算 / 清算 / Reward outcome”判定轴；因此只要风控与价格条件满足，1 block 产品会天然更快完成清算与 EasiToken 发放闭环。
- **期限门槛（链上硬约束）**：当期限为 `90/180/360` 天时，`LendingEngine (OrderEngine)` 会读取 `RewardView.getUserLevelForBorrowCheck(borrower)`（从 `Registry.getModuleOrRevert(ModuleKeys.KEY_REWARD_VIEW)` 解析），要求 **Reward Level ≥ 4**。
  - 说明：`RewardView.getUserLevelForBorrowCheck` 是**协议内校验入口**（内部再透传读取 `RewardManagerCore` 的等级），其 caller gate **必须与真实调用方对齐**：
    - **必须允许**：`KEY_ORDER_ENGINE`（OrderEngine）
    - **禁止**：其它任意地址（应 `revert MissingRole()`）
  - 若 caller gate 口径与调用方不一致，会导致创建长周期订单直接 revert（属于功能性 bug）。架构级 SSOT 见 `docs/Architecture-Guide.md` Reward 章节 “BorrowCheck 读路径”。
- **按期窗口（现行实现细节）**：
  - **时间口径（强约束）**：任何门槛/窗口/到期语义一律使用 **block 口径**（见 `docs/Architecture-Guide.md` “时间依赖改造原则”）。
  - “是否按期且足额还清”的权威判定发生在 `LendingEngine (OrderEngine)`（当前固定 `_ON_TIME_WINDOW_BLOCKS = 7200` blocks）。
    - 解释：在约 \(12s/block\) 基线下，`7200` blocks \(\approx\) 24h；该“24h”仅用于理解/展示，不作为链上门槛语义。

> 注意（重要一致性）：**当前链上实现已强制“本金 < 1000 USDC 不计分/不锁定”**（`RewardManagerCore` 在 `onLoanEventByOrder` 中直接 return）。如果你需要不同的门槛，请同时更新合约与测试，并同步前后端说明。

### 部署后硬检查（建议作为放行前必跑）

- `pnpm -s run checks:reward-monitor:registry-bindings`
- `pnpm -s run checks:reward-monitor:role-bindings`
- `pnpm exec hardhat test test/Reward/EasyEconomics.integration.test.ts`

上述检查必须共同证明：
- `MINTER_ROLE` 仅在 `EasyEmissionController`
- `BURNER_ROLE` 仅在 `RewardAccrualManager` 与 `EasyRecycleDistributor`
- `RewardManagerCore` 不持有遗留 `BURNER_ROLE`
- recycle 异常余额恢复路径可按统一 75/15/10 成功结算

---

## SSOT：EasyToken 语义与命名规范（并入）

> 本节只保留目标态规范。历史 `points/积分` 口径不再作为正文叙事，若旧材料里仍出现该命名，统一视为 Easy 数量的历史遗留别名。

### 1. 资产与单位

- Reward 域唯一资产 SSOT：`Registry[KEY_EASY_TOKEN]`
- 资产语义统一为 `EasyToken`
- 单位统一为 Easy 最小单位（18 decimals）

### 2. 对外命名规范

- 对外 surface 必须使用 `easy*` 或明确 `amount` + NatSpec 单位说明
- 推荐命名：`easyAmount`、`easySpent`、`easyBurned`、`lockedEasy`、`pendingEasyDebt`
- 禁止新增任何业务语义的 `points*` / `积分*` 字段、事件参数或 getter 名称

### 3. 边界与职责

- 所有 Reward 相关地址都必须从 `Registry` 解析，禁止硬编码或兼容 fallback
- Reward 域只负责 Easy 的发行、消费、回收、扣罚与只读聚合
- AI Credits 计费与结算不属于 Reward 域，按 [docs/Usage-Guide/AI-Credits-Billing-Guide.md](docs/Usage-Guide/AI-Credits-Billing-Guide.md) 执行

### 4. PR 检查清单

- [ ] 对外 surface 是否只使用 `easy*` 或有明确单位说明的 `amount`
- [ ] 奖励通证地址是否全部来自 `Registry[KEY_EASY_TOKEN]`
- [ ] NatSpec 是否明确写明 Easy 的 18 decimals 单位
- [ ] 是否误改了 bps、checkpoints 或其它非 Reward 语义字段

## ⚙️ 部署后配置

### 1. 初始化系统（UUPS + Registry 版）

部署完成后，按以下顺序初始化系统（实现合约 → 代理 → initialize）：

```typescript
// 1) 部署并初始化奖励通证（SSOT：Registry[KEY_EASY_TOKEN]）
const EasyToken = await ethers.getContractFactory('EasyToken');
const implToken = await EasyToken.deploy();
const proxy = await ethers.getContractFactory('ERC1967Proxy');
const easyToken = EasyToken.attach((await (await proxy.deploy(
  await implToken.getAddress(),
  implToken.interface.encodeFunctionData('initialize', [admin])
)).getAddress()));

// 2) 部署并初始化 RewardManagerCore（registry）
const RewardManagerCore = await ethers.getContractFactory('RewardManagerCore');
const implRMCore = await RewardManagerCore.deploy();
const rmCore = RewardManagerCore.attach((await (await proxy.deploy(
  await implRMCore.getAddress(),
  implRMCore.interface.encodeFunctionData('initialize', [registry])
)).getAddress()));

// 3) 部署并初始化 RewardAccrualManager（registry）
const RewardAccrualManager = await ethers.getContractFactory('RewardAccrualManager');
const implRAM = await RewardAccrualManager.deploy();
const rewardAccrualManager = RewardAccrualManager.attach((await (await proxy.deploy(
  await implRAM.getAddress(),
  implRAM.interface.encodeFunctionData('initialize', [registry])
)).getAddress()));

// 4) 部署并初始化 RewardManager（registry）
const RewardManager = await ethers.getContractFactory('RewardManager');
const implRM = await RewardManager.deploy();
const rm = RewardManager.attach((await (await proxy.deploy(
  await implRM.getAddress(),
  implRM.interface.encodeFunctionData('initialize', [registry])
)).getAddress()));

// 5) 部署并初始化 RewardView（registry）
const RewardView = await ethers.getContractFactory('RewardView');
const implView = await RewardView.deploy();
const rewardView = RewardView.attach((await (await proxy.deploy(
  await implView.getAddress(),
  implView.interface.encodeFunctionData('initialize', [registry])
)).getAddress()));

// 6) 在 Registry 中设置 Reward 主模块键
//    - KEY_RM -> RewardManager
//    - KEY_REWARD_MANAGER_CORE -> RewardManagerCore
//    - KEY_REWARD_ACCRUAL_MANAGER -> RewardAccrualManager
//    - KEY_REWARD_VIEW -> RewardView

// 7) 部署并初始化 RewardConfig / EarnConfig / FeatureRegistry / GovernanceGate
//    - RewardConfig.initialize(registry)
//    - EarnConfig.initialize(registry)
//    - FeatureRegistry.initialize(registry)
//    - GovernanceGate.initialize(registry)
//    并在 Registry 中设置 KEY_REWARD_CONFIG / KEY_REWARD_EARN_CONFIG / KEY_FEATURE_REGISTRY / KEY_GOVERNANCE_GATE

// 8) 部署并初始化 EasyEmissionConfig / EasyEmissionController / EasyConsumption / EasyRecycleDistributor / EasyStaking
//    - EasyEmissionConfig.initialize(registry)
//    - EasyEmissionController.initialize(registry)
//    - EasyConsumption.initialize(registry)
//    - EasyRecycleDistributor.initialize(registry, teamRecipient, ecoRecipient)
//    - EasyStaking.initialize(registry)
//    并在 Registry 中设置 KEY_EASY_TOKEN / KEY_EASY_EMISSION_CONFIG / KEY_EASY_EMISSION_CONTROLLER /
//    KEY_EASY_CONSUMPTION / KEY_EASY_RECYCLE_DISTRIBUTOR / KEY_EASY_STAKING
```

### 2. 配置权限（ACM 角色）

```typescript
// 授予必要的权限（基于 ActionKeys）
const SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
const UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
const CONSUME_EASY = ethers.keccak256(ethers.toUtf8Bytes('CONSUME_EASY'));

await acm.grantRole(SET_PARAMETER, governanceAddress);
await acm.grantRole(UPGRADE_MODULE, governanceAddress);
await acm.grantRole(CONSUME_EASY, operatorAddress); // 可选：允许后台/服务端代用户消耗 Easy

// 可选：运营/后台读取其他用户的 RewardView 数据（否则仅本人可查）
const VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
await acm.grantRole(VIEW_USER_DATA, operatorAddress);
```

### 3. 配置奖励参数（按现行接口）

```typescript
// Earn 侧参数（治理入口：RewardManager -> RewardConfig -> EarnConfig）
// 设置等级倍数（BPS，10000=1x，level 范围 1..5）
await rewardManager.setLevelMultiplier(2, 11000);
await rewardManager.setLevelMultiplier(3, 12500);

// 设置动态奖励（multiplierBps=0 表示关闭）
await rewardManager.setDynamicRewardParams(
  ethers.parseUnits('1000', 18), // thresholdEasy
  12000                           // multiplierBps (1.2x)
);

// Easy 发行参数（SSOT：EasyEmissionConfig）
await easyEmissionConfig.setEmissionParams(
  100_000_000n * 10n ** 8n,       // thresholdUsd8
  ethers.parseUnits('10', 18),    // mintPer1000Usd
  1,                               // kNum
  10_000_000                       // kDen
);
```

### 4. 配置奖励通证角色（必须）

目标态：奖励通证就是 `EasyToken`，并且 `Registry[KEY_EASY_TOKEN]` 绑定到该地址。

- **发行（mint）**：仅 `EasyEmissionController`（推荐 `setSoleMinter`）
- **销毁（burn，用于扣罚/消费/回收）**：`RewardManagerCore` + `EasyRecycleDistributor`

```typescript
const MINTER_ROLE = await easyToken.MINTER_ROLE();
const BURNER_ROLE = await easyToken.BURNER_ROLE();

// 1) 发行单点（推荐：硬收口）
await easyToken.setSoleMinter(await easyEmissionController.getAddress());

// 2) 扣罚/回收 burn
await easyToken.grantRole(BURNER_ROLE, await rewardAccrualManager.getAddress());
await easyToken.grantRole(BURNER_ROLE, await easyRecycleDistributor.getAddress());
```

### 5. （可选）上线后进一步收紧权限面

上线后建议把 `DEFAULT_ADMIN_ROLE` 交给 Guardian（多签/Timelock），并移除 deployer 的 admin，避免单点。

---

## 👨‍💼 管理员操作（按现行实现）

### 1. 管理奖励参数（建议默认值）

```typescript
// 更新 Earn 侧参数
const updateEarnParams = async () => {
  const rewardManager = new ethers.Contract(
    rewardManagerAddress,
    REWARD_MANAGER_ABI,
    signer
  );

  // 等级倍数（BPS）
  await rewardManager.setLevelMultiplier(2, 11000);
  await rewardManager.setLevelMultiplier(3, 12500);

  // 动态奖励（可选，multiplierBps=0 表示关闭）
  await rewardManager.setDynamicRewardParams(
    ethers.parseUnits('1000', 18),
    12000
  );
};

// 更新 Easy 发行参数（EasyEmissionConfig）
const updateEasyEmissionParams = async () => {
  const easyEmissionConfig = new ethers.Contract(
    easyEmissionConfigAddress,
    EASY_EMISSION_CONFIG_ABI,
    signer
  );

  await easyEmissionConfig.setEmissionParams(
    100_000_000n * 10n ** 8n,
    ethers.parseUnits('10', 18),
    1,
    10_000_000
  );
};
```

### 2. 管理用户等级

```typescript
// 手动更新用户等级
const updateUserLevel = async (userAddress: string, newLevel: number) => {
  const rewardManager = new ethers.Contract(
    rewardManagerAddress,
    REWARD_MANAGER_ABI,
    signer
  );

  await rewardManager.updateUserLevel(userAddress, newLevel);
};

// 说明：暂不提供批量更新接口，请逐个调用 updateUserLevel
// 等级范围：1..5（Reward Level）
```

### 3. 系统监控（统计与地址）

```typescript
// 获取系统统计信息（RewardView + EasyToken）
const getSystemStats = async () => {
  const rewardManager = new ethers.Contract(
    rewardManagerAddress,
    REWARD_MANAGER_ABI,
    provider
  );
  // 奖励通证 SSOT：Registry[KEY_EASY_TOKEN]。
  const easyTokenAddress = await registry.getModule(ModuleKeys.KEY_EASY_TOKEN);
  const easyToken = new ethers.Contract(
    easyTokenAddress,
    ERC20_ABI, // 任何标准 ERC20 ABI 即可
    provider
  );

  // 注意：系统级统计为 ops-only（需要 VIEW_SYSTEM_DATA / ADMIN）。
  const [totalSupply, stats] = await Promise.all([
    easyToken.totalSupply(),
    rewardView.getSystemRewardStatsWithMeta()
  ]);

  const [totalBatchOps, totalCachedRewards, activeUsers, cacheBlock, isValid] = stats;
  return {
    totalEasy: totalSupply.toString(),
    totalBatchOps: Number(totalBatchOps),
    totalCachedRewards: Number(totalCachedRewards),
    activeUsers: Number(activeUsers),
    cacheBlock: Number(cacheBlock),
    isValid: Boolean(isValid),
  };
};
```

---

## 👤 用户操作（按期释放模型）

### 1. 查看奖励通证信息（EasyToken）

```typescript
// 获取用户奖励通证仪表板
const getUserDashboard = async (userAddress: string) => {
  // 推荐：统一从 RewardView 查询（只读聚合）
  const [bal, summary, easyEarned, activities] = await Promise.all([
    rewardView.getUserBalanceWithMeta(userAddress),
    rewardView.getUserRewardSummaryWithMeta(userAddress),
    rewardView.getUserEasyEarnedWithMeta(userAddress),
    rewardView.getUserRecentActivitiesWithMeta(userAddress, 0, 0, 20),
  ]);

  return {
    balance: bal[0].toString(),
    balanceMeta: { cacheBlock: Number(bal[1]), isValid: Boolean(bal[2]) },
    summary: {
      totalBurned: summary[0],
      pendingPenalty: summary[1],
      level: summary[2],
      lastActivity: summary[3],
      cacheBlock: summary[4],
      isValid: summary[5],
    },
    easyEarned: easyEarned[0].toString(),
    easyEarnedMeta: { cacheBlock: Number(easyEarned[1]), isValid: Boolean(easyEarned[2]) },
    recentActivities: activities[0],
    recentActivitiesMeta: { cacheBlock: Number(activities[1]), isValid: Boolean(activities[2]) },
  };
};
```

#### Dashboard 字段口径说明

- `balance`：当前钱包中的 EasyToken 余额，对应 `EasyToken.balanceOf(user)` 的 View 透传。
- `easyEarned`：累计净发放给该用户的 Easy 数量，主发奖路径由 `EasyEmissionController -> RewardView.pushEasyMinted(...)` 写入，单调不减。
- `summary.pendingPenalty`：待抵扣 penalty 账本；后续奖励会优先抵扣该值，因此“本次奖励发放”不一定等于“钱包净增”。
- `summary.totalBurned`：累计已实际 burn 的 Easy。
- `summary`：当前只承载 `totalBurned`、`pendingPenalty`、`level`、`lastActivity` 等摘要字段；累计发放主指标统一读取 `easyEarned`。

### 2. 按次消耗 Easy（EasiM / Strategy API）

当前实现的“消费”仅包含 **按次消耗 1 Easy** 并进入 `EasyRecycleDistributor` 做 75/15/10 分配与回收。

```typescript
// 1) 用户授权（transferFrom 到 recycle distributor）
await easyToken.approve(easyConsumptionAddress, ethers.parseUnits('1', 18));

// 2) 调用按次消耗（如果 caller != user，需要 ACTION_CONSUME_EASY）
await easyConsumption.consumeEasiMCall(userAddress);
// 或
await easyConsumption.consumeStrategyApiCall(userAddress);
```

### 4. 奖励历史查询（监听 View 层统一 DataPush）

```typescript
// 获取奖励历史
const getRewardHistory = async (userAddress: string) => {
  // 推荐：监听 RewardView 统一 DataPushed 事件：
  // EASY_MINTED / EASY_SPENT / EASY_RECYCLED_SPLIT / REWARD_BURNED /
  // REWARD_PENALTY_LEDGER_UPDATED / REWARD_LEVEL_UPDATED / EASY_STAKED / EASY_UNSTAKED /
  // EASY_EMISSION_PARAMS_UPDATED / REWARD_DYNAMIC_REWARD_PARAMS_UPDATED / REWARD_LEVEL_MULTIPLIER_UPDATED
  const filter = rewardView.filters.DataPushed(DataPushTypes.DATA_TYPE_EASY_MINTED);
  const events = await rewardView.queryFilter(filter);

  return events.map(event => ({
    // payload 解码见“前端集成：统一 DataPushed 订阅”
    dataType: event.args?.dataTypeHash,
    payload: event.args?.payload,
    blockNumber: event.blockNumber,
  }));
};
```

#### DataPush 观测语义（2026-03 补充）

- `RewardView.DataPushed(...)` 是 **统一推荐订阅入口**；当前实现会同时产出 `DATA_TYPE_REWARD_*` 与 `DATA_TYPE_EASY_*`，而它的写入在协议主链路里仍属于 **best-effort 可观测层**。
- 也就是说：Reward 主账本/主流程成功，并不等于每次都一定能看到对应的 `RewardView.DataPushed`；当 push 失败时，排障与监控必须同时检查 `RewardViewPushFailed(...)` 或等价失败留痕，而不是只盯 `DataPushed`。
- 同一笔交易里，可能出现多条相同 `dataTypeHash` 的 push，尤其是 `REWARD_PENALTY_LEDGER_UPDATED`。常见情形是同 tx 里先写入欠分，再被后续逻辑抵扣或清零。
- 因此链下解码/严格断言时必须遵守：
  - 先收集该 tx 的全部同类型 push；
  - 逐条解码打印关键字段；
  - 以 **最后一条 push** 作为最终落库状态；
  - 若最后状态仍与 `RewardView` read 不一致，再判定为真实错误。

---

## 🖥️ 前端集成

### 1. 初始化 Reward 读接口（RewardView）

```typescript
class RewardSystem {
  private rewardView: Contract;

  constructor(rewardViewAddress: string, providerOrSigner: any) {
    this.rewardView = new Contract(rewardViewAddress, REWARD_VIEW_ABI, providerOrSigner);
  }

  async getUserDashboard(userAddress: string) {
    const [bal, summary, earned, spent] = await Promise.all([
      this.rewardView.getUserBalanceWithMeta(userAddress),
      this.rewardView.getUserRewardSummaryWithMeta(userAddress),
      this.rewardView.getUserEasyEarnedWithMeta(userAddress),
      this.rewardView.getUserEasySpentWithMeta(userAddress),
    ]);

    return {
      balance: bal[0].toString(),
      balanceMeta: { cacheBlock: Number(bal[1]), isValid: Boolean(bal[2]) },
      summary,
      easyEarned: earned[0].toString(),
      earnedMeta: { cacheBlock: Number(earned[1]), isValid: Boolean(earned[2]) },
      easySpent: spent[0].toString(),
      spentMeta: { cacheBlock: Number(spent[1]), isValid: Boolean(spent[2]) },
    };
  }
}
```

### 2. React Hook 示例

```typescript
// useReward.ts
import { useState, useEffect } from 'react';
import { useContract, useProvider, useSigner } from 'wagmi';

export const useReward = (userAddress: string) => {
  const [rewardData, setRewardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const provider = useProvider();
  const { data: signer } = useSigner();

  const rewardView = useContract({
    address: rewardViewAddress,
    abi: REWARD_VIEW_ABI,
    signerOrProvider: provider
  });

  useEffect(() => {
    const fetchRewardData = async () => {
      try {
        setLoading(true);
        
        const [bal, summary, earned] = await Promise.all([
          rewardView.getUserBalanceWithMeta(userAddress),
          rewardView.getUserRewardSummaryWithMeta(userAddress),
          rewardView.getUserEasyEarnedWithMeta(userAddress),
        ]);

        setRewardData({
          balance: bal[0].toString(),
          balanceMeta: { cacheBlock: Number(bal[1]), isValid: Boolean(bal[2]) },
          summary,
          easyEarned: earned[0].toString(),
          earnedMeta: { cacheBlock: Number(earned[1]), isValid: Boolean(earned[2]) },
        });
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    };

    if (userAddress) {
      fetchRewardData();
    }
  }, [userAddress]);

  return {
    rewardData,
    loading,
    error
  };
};
```

### 3. UI 组件示例

```typescript
// RewardDashboard.tsx
import React from 'react';
import { useReward } from './useReward';

export const RewardDashboard: React.FC<{ userAddress: string }> = ({ userAddress }) => {
  const { rewardData, loading, error } = useReward(userAddress);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!rewardData) return <div>No data</div>;

  return (
    <div className="reward-dashboard">
      <h2>Reward Dashboard</h2>
      
      <div className="reward-stats">
        <div className="stat">
          <label>Easy Balance:</label>
          <span>{ethers.formatEther(rewardData.balance)}</span>
        </div>
        <div className="stat">
          <label>Easy Earned:</label>
          <span>{ethers.formatEther(rewardData.easyEarned)}</span>
        </div>
        <div className="stat">
          <label>User Level:</label>
          <span>{rewardData.summary.level}</span>
        </div>
      </div>

      <div className="privileges">
        <h3>Active Privileges</h3>
        {/* 如需功能门控，请走 FeatureRegistry + ServiceLevel（不再有服务订阅/过期特权模型） */}
      </div>

      {/* 按次消耗入口由 EasyConsumption 承担，不在此处展开 */}
    </div>
  );
};
```

### 3. 期限白名单与等级校验工具（TermGuard.ts）

```typescript
// TermGuard.ts —— 前端可复用的期限与等级校验工具
// 注意（SSOT 对齐）：
// - 合约内部对 term/maturity 的判定是 block-based（区块口径）
// - 前端可用 termDays 作为 UX 输入（5/10/15/.../360）
// - 上链时必须按合约口径转换/对齐（例如使用与合约一致的“days -> blocks”映射/常量），不要在前端/后端自行引入另一套“秒时间戳”语义
// - **借贷形式（Borrow modes）**：
//   - 白名单期限借贷（主路径 / Order-based）：期限为 5/10/15/.../360 天，链上按 block 口径存储与校验。
//   - blocks-only 即时产品（新增设计）：例如 1 block 产品，直接使用显式 termBlocks，不复用 termDays 桶。
export const ALLOWED_TERMS_DAYS = [5, 10, 15, 30, 60, 90, 180, 360] as const;
export type AllowedTerm = typeof ALLOWED_TERMS_DAYS[number];

export const BLOCKS_ONLY_TERM_OPTIONS = [1n] as const;
export type BlocksOnlyTerm = typeof BLOCKS_ONLY_TERM_OPTIONS[number];

export type BorrowProductMode = 'day-bucket' | 'blocks-only';

export const MIN_LEVEL_FOR_LONG_TERMS = 4; // 90/180/360 天的最低等级

// legacy day-bucket 产品可选的 maturity 确认偏移；仅用于兼容旧边界语义。
export const LEGACY_MATURITY_CONFIRMATION_BLOCKS = 1n;

export function computeMaturityBlock(
  openBlock: bigint,
  termBlocks: bigint,
  mode: BorrowProductMode
): bigint {
  if (mode === 'blocks-only') {
    return openBlock + termBlocks;
  }
  return openBlock + termBlocks + LEGACY_MATURITY_CONFIRMATION_BLOCKS;
}

export function isAllowedTerm(termDays: number): termDays is AllowedTerm {
  return (ALLOWED_TERMS_DAYS as readonly number[]).includes(termDays);
}

export function isAllowedBlocksOnlyTerm(termBlocks: bigint): termBlocks is BlocksOnlyTerm {
  return (BLOCKS_ONLY_TERM_OPTIONS as readonly bigint[]).includes(termBlocks);
}

export function canBorrowTerm(userLevel: number, termDays: AllowedTerm): {
  allowed: boolean;
  reason?: string;
  requiredLevel?: number;
} {
  if (!isAllowedTerm(termDays)) {
    return { allowed: false, reason: 'Term not in whitelist' };
  }
  if (termDays >= 90 && userLevel < MIN_LEVEL_FOR_LONG_TERMS) {
    return {
      allowed: false,
      reason: 'Level too low for long-term borrowing',
      requiredLevel: MIN_LEVEL_FOR_LONG_TERMS,
    };
  }
  return { allowed: true };
}

export function ensureEligibleAmount(amountUSDC: bigint, minEligibleAmountUSDC: bigint = 1000n): {
  eligible: boolean;
  reason?: string;
} {
  if (amountUSDC < minEligibleAmountUSDC) {
    return { eligible: false, reason: 'Amount below 1000 USDC — no Easy reward (no lock)' };
  }
  return { eligible: true };
}
```

用法示例：

```typescript
import { canBorrowTerm, ensureEligibleAmount } from './TermGuard';

export async function preSubmitBorrowCheck(userLevel: number, termDays: number, amountUSDC: bigint) {
  const termCheck = canBorrowTerm(userLevel, termDays as any);
  if (!termCheck.allowed) {
    throw new Error(termCheck.reason + (termCheck.requiredLevel ? `, need level ≥ ${termCheck.requiredLevel}` : ''));
  }

  const amtCheck = ensureEligibleAmount(amountUSDC);
  if (!amtCheck.eligible) {
    // 允许借款，但提示：本次不产生 Easy 锁定/奖励
    console.warn(amtCheck.reason);
  }
}
```

---

## 📚 API 参考

### RewardManager 主要方法（按现行）

```typescript
// 推荐：订单维度入口（orderId）
function onLoanEventByOrder(address user, uint256 orderId, uint256 amount, uint256 maturity, uint8 outcome) external;

// 订单维度入口（含 lender/asset，触发 EasyEmissionController）
function onLoanEventByOrderWithLender(
  address borrower,
  address lender,
  address asset,
  uint256 orderId,
  uint256 amount,
  uint256 maturity,
  uint8 outcome
) external;

// 等级与动态奖励参数
function setLevelMultiplier(uint8 level, uint256 newMultiplier) external;
function setDynamicRewardParams(uint256 newThreshold, uint256 newMultiplier) external;

// 惩罚与窗口
function setLatePenaltyBps(uint256 lateBps) external;

// 清算惩罚（仅 KEY_GUARANTEE_FUND）
function quoteLiquidationPenalty(address user) external view returns (uint256);
function applyLiquidationPenalty(address user) external;
function setLiquidationPenaltyBps(uint256 liquidationBps) external;

// 缓存与等级管理
function updateUserLevel(address user, uint8 newLevel) external;
```

> 说明：`RewardManager` 的只读查询接口已移除，前端/链下查询请统一使用 `RewardView`。

### 奖励通证（SSOT：Registry[KEY_EASY_TOKEN]；EasyToken）主要方法（代币层）

```typescript
// 查询余额
function balanceOf(address account) external view returns (uint256);

// 查询总供应量
function totalSupply() external view returns (uint256);

// 查询授权额度
function allowance(address owner, address spender) external view returns (uint256);
```

### EasyConsumption 主要方法（按现行）

```typescript
function consumeEasiMCall(address user) external;
function consumeStrategyApiCall(address user) external;
```

### RewardView（推荐只读入口）

```typescript
// 用户汇总（带 meta：cacheBlock + isValid）
function getUserRewardSummaryWithMeta(address user)
  external
  view
  returns (
    uint256 totalBurned,
    uint256 pendingPenalty,
    uint8 level,
    uint256 lastActivity,
    uint256 cacheBlock,
    bool isValid
  );

// 注意：主奖励累计请读 getUserEasyEarnedWithMeta(user)。

// 用户余额（奖励通证 balanceOf 的 best-effort 透传 + meta）
function getUserBalanceWithMeta(address user) external view returns (uint256 balance, uint256 cacheBlock, bool isValid);

// 最近活动（本地缓存扫描 + meta）
function getUserRecentActivitiesWithMeta(address user, uint256 fromBlock, uint256 toBlock, uint256 limit)
  external
  view
  returns (tuple(uint8 kind,uint256 amount,uint256 blockNumber)[] out, uint256 cacheBlock, bool isValid);

// Earn/Stake/Spend 观测（RewardView 本地缓存 + meta）
function getUserEasyEarnedWithMeta(address user) external view returns (uint256 easyEarned, uint256 cacheBlock, bool isValid);
function getUserEasyStakedWithMeta(address user) external view returns (uint256 easyStaked, uint256 cacheBlock, bool isValid);
function getUserEasySpentWithMeta(address user) external view returns (uint256 easySpent, uint256 cacheBlock, bool isValid);

// 系统统计 / TopN（ops-only，带 meta）
function getSystemRewardStatsWithMeta() external view returns (uint256 totalBatchOps, uint256 totalCachedRewards, uint256 activeUsers, uint256 cacheBlock, bool isValid);
function getTopEarnersWithMeta() external view returns (address[] addrs, uint256[] amounts, uint256 cacheBlock, bool isValid);

// Easy 发行/消费统计（ops-only，带 meta）
function getEasyEmissionParamsWithMeta() external view returns (uint256 thresholdUsd8, uint256 mintPer1000Usd, uint256 kNum, uint256 kDen, uint256 cacheBlock, bool isValid);
function getEasySpendStatsWithMeta() external view returns (uint256 totalSpent, uint256 totalRecycled, uint256 totalBurned, uint256 totalTeam, uint256 totalEco, uint256 cacheBlock, bool isValid);

// EarnConfig 观测（带 meta）
function getDynamicRewardParamsWithMeta() external view returns (uint256 thresholdEasy, uint256 multiplierBps, uint256 cacheBlock, bool isValid);
function getLevelMultiplierWithMeta(uint8 level) external view returns (uint256 multiplierBps, uint256 cacheBlock, bool isValid);
```

---

## 🔧 故障排除

### 常见问题

#### 1. 借款后“未见发放 Easy”（锁定模型下的常见误解）

**现象**: 用户借款成功后，余额未增加。

**解决方案**:
```typescript
// 按现行规则：借款只锁定 Easy（账本锁定，不 mint）。
// Easy mint 由 EasyEmissionController 在“结清足额”时触发（RepayOnTimeFull/EarlyFull/LateFull）。
// 请检查：
// 1) EasyEmissionController/EasyEmissionConfig 是否已注册到 Registry（KEY_EASY_EMISSION_*）
// 2) 借款金额折算为 USD-8 后是否 >= 1000U（PriceOracle 可用、价格非 0）
// 3) RewardView 是否收到 DataPushed(EASY_MINTED)
```

#### 2. 服务购买失败

**问题**: 调用 `EasyConsumption.consumeEasiMCall/consumeStrategyApiCall` 失败

**解决方案**:
- 确认用户已对 `EasyConsumption` 做 `approve`（额度至少 `1e18`）。
- 若由后台/服务端代扣（`caller != user`），确认 caller 拥有 `CONSUME_EASY`（`ActionKeys.ACTION_CONSUME_EASY`）角色。

#### 3. 权限错误

**问题**: 管理员操作时出现权限错误

**解决方案**:
```typescript
// 检查用户权限
const hasRole = await acm.hasRole(SET_PARAMETER_ROLE, userAddress);
if (!hasRole) {
  console.error('User does not have SET_PARAMETER role');
  return;
}

// 授予权限
await acm.grantRole(SET_PARAMETER_ROLE, userAddress);
```

#### 4. 事件监听失败

**问题**: 前端无法监听到 Reward 事件

**解决方案**:
```typescript
// 确保正确设置事件监听器
const setupEventListeners = () => {
  // 推荐：统一订阅 RewardView 的 DataPushed（EASY_* / REWARD_*）
  rewardView.on('DataPushed', (dataTypeHash, payload) => {
    if (dataTypeHash === DataPushTypes.DATA_TYPE_EASY_MINTED) {
      // payload = abi.encode(borrower, lender, totalMinted, borrowerShare, lenderShare, orderId, amountUsd8, blockNumber)
    } else if (dataTypeHash === DataPushTypes.DATA_TYPE_REWARD_BURNED) {
      // payload = abi.encode(user, amount, reason, blockNumber)
    } else if (dataTypeHash === DataPushTypes.DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED) {
      // payload = abi.encode(user, pendingDebt, blockNumber)
    }
  });
};

// 在组件卸载时清理监听器
useEffect(() => {
  setupEventListeners();
  
  return () => {
    rewardView.removeAllListeners();
  };
}, []);
```

补充排障规则：

- 如果主流程成功但前端/链下没有等到 `RewardView.DataPushed`，不要立刻把它判成“奖励没执行”。
- 先检查：
  - `RewardViewPushFailed` 是否留痕；
  - `getUserEasyEarnedWithMeta`、`getUserRewardSummaryWithMeta`、`getUserBalanceWithMeta` 等最终只读结果是否已经更新；
  - 同 tx 内是否出现了多条相同类型的 push（例如 `DATA_TYPE_REWARD_*` 或 `DATA_TYPE_EASY_*`），而你的监听器只消费了第一条。

#### 5. strict E2E 下 penalty / earned 状态“看起来不一致”

**高频根因**：把 `RewardView.DataPushed` 的首条事件当成最终状态，或者把 `summary` 摘要字段错当作主发奖累计。

**正确排障顺序**：

- 主发奖累计优先读 `getUserEasyEarnedWithMeta(user)`；
- 不要再从 `summary` 推导累计发放，`summary` 只用于 burned / penalty / level / activity 摘要；
- penalty 相关严格对比时，以同 tx 最后一条 `REWARD_PENALTY_LEDGER_UPDATED` 为准；
- 若 `DataPushed` 缺失，但账本与只读结果正确，应优先按“best-effort push 失败”处理，而不是按“主流程失败”处理。

### 调试工具（按现行模块）

#### 1. 检查合约状态

```typescript
const debugContractState = async () => {
  const [managerAddress, managerCoreAddress, easyTokenAddress] = await Promise.all([
    registry.getModule(ModuleKeys.KEY_REWARD_MANAGER),
    registry.getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE),
    registry.getModule(ModuleKeys.KEY_EASY_TOKEN),
  ]);

  console.log('Contract addresses:', {
    manager: managerAddress,
    easyToken: easyTokenAddress,
    managerCore: managerCoreAddress
  });
};
```

#### 2. 检查用户状态

```typescript
const debugUserState = async (userAddress: string) => {
  const easyTokenAddress = await registry.getModule(ModuleKeys.KEY_EASY_TOKEN);
  const easyToken = new ethers.Contract(easyTokenAddress, ERC20_ABI, provider);
  const [easyBal, levelMeta] = await Promise.all([
    easyToken.balanceOf(userAddress),
    rewardView.getUserRewardSummaryWithMeta(userAddress)
  ]);
  const level = levelMeta[3];

  console.log('User state:', {
    easy: easyBal.toString(),
    level: Number(level)
  });
};
```

---

## 📞 技术支持

如有问题，请联系：
- 📧 Email: support@example.com
- 💬 Discord: #reward-support
- 📖 文档: https://docs.example.com/reward

---

*本文档将随着 Reward 系统的更新而持续更新。请定期检查最新版本。* 
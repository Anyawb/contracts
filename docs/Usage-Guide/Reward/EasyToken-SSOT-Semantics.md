# SSOT：EasyToken 语义与命名规范（Reward 域）

> 目的：在 **EasyToken-only** 目标态下，统一 Easy 数量的语义与命名，不再让历史 `points` 口径进入当前实现说明。

## 1. 术语与范围

### 1.1 SSOT（Single Source of Truth）定义

- **奖励通证（Reward Token）唯一 SSOT**：`Registry[KEY_EASY_TOKEN]` 解析得到的 `EasyToken` 合约地址。
- 本文中出现的 **easy** / **EasyToken** / **reward token** 语义均指向同一资产：`EasyToken`。

### 1.2 历史命名边界

- Reward 域不存在独立的第二奖励资产
- 旧材料里的 `points/积分` 仅代表历史命名，不再作为当前设计口径
- 当前文档、代码、测试、事件与 API 统一使用 Easy / EasyToken 语义

## 2. EasyToken 的资产语义（统一口径）

### 2.1 基本语义

- `EasyToken` 是 **ERC20 奖励通证**（资产语义）。
- 当前实现不得再新增任何业务语义的 `points*` 命名；残留旧名应视为待清理对象，而不是兼容口径。

### 2.2 单位与精度

- **默认精度**：18 decimals（与当前合约/文档口径一致）。
- 凡涉及数量的字段/参数，应在注释中明确：
  - `easyAmount` / `easySpent` / `easyBurned` 等均为 **EasyToken 最小单位（18 decimals）**。

## 3. 命名规范（强制）

> 原则：**对外 surface（ABI/事件/结构体字段）优先使用 `easy*` 前缀**；内部局部变量可用 `amount`，但不得暴露历史 `points*` 业务命名。

### 3.1 强制范围：对外接口 / 事件 / ABI

以下位置 **必须** 使用 `easy*` 前缀（或等价明确 EasyToken 的命名）：

- 外部函数的参数名（Solidity ABI 可读部分）
- 事件参数名
- `struct` 字段名（尤其是返回给 view / 供 offchain 消费的结构）
- 对外 view 的 getter 返回值命名

#### 3.1.1 推荐字段/参数命名

- `easyAmount`：泛指某次操作涉及的 EasyToken 数量
- `easySpent`：表示“消耗的 EasyToken 数量”（如按次支付/回收扣费）
- `easyBurned`：表示“burn 的 EasyToken 数量”
- `lockedEasy`：锁定额度（以 EasyToken 最小单位计量；通常为账本锁定/额度锁定，不代表已发生 mint）
- `pendingEasyDebt`：欠分/罚分账本（仍是 EasyToken 计量）

#### 3.1.2 推荐对外命名

- `easySpent`
- `easyBurned`
- `easyCost`
- `PenaltyApplied(..., easyAmount, ...)`

> 注：如果某处对外 API 不想绑定特定 token，也可采用 `amount`，但必须在接口/事件的 NatSpec 中写清：单位为 `EasyToken`（并且 SSOT 来自 `Registry[KEY_EASY_TOKEN]`）。在 EasyToken-only 阶段，默认优先 `easy*`。

### 3.2 允许范围：内部局部变量（实现细节）

内部实现中允许使用更通用的命名：

- `amount` / `burnAmount` / `spentAmount`

但满足以下约束：

- 只要该变量会出现在 **外部接口/事件/struct 字段/ABI 可见参数名** 中，就必须升级为 `easy*`。
- 不得在对外 surface 中出现 `points*` 作为业务语义（否则属于“误读风险源”）。

## 4. 数据流与职责边界（SSOT 约束）

### 4.1 SSOT：地址解析

- 所有需要奖励通证地址的地方，必须通过：`Registry[KEY_EASY_TOKEN]` 获取。
- 禁止：硬编码地址、从旧模块 key 推导、或通过“兼容 fallback”读取历史 key。

### 4.2 统一口径账户（Role / Account Semantics）

> 目的：明确“谁可以 mint / 谁负责 burn”的链上权责口径，避免 E2E/脚本用错 caller 导致误读或权限漂移。

- **MINTER_ROLE（唯一铸造者）**：应收口为 `Registry[KEY_EASY_EMISSION_CONTROLLER]`（`EasyToken.setSoleMinter(...)`）。
- **BURNER_ROLE（独立销毁者）**：应授予 `Registry[KEY_REWARD_ACCRUAL_MANAGER]` 与 `Registry[KEY_EASY_RECYCLE_DISTRIBUTOR]`。
  - `RewardAccrualManager`：用于扣罚 burn 优先、否则记账到 penalty ledger 的路径。
  - `EasyRecycleDistributor`：用于消费回收 burn 路径。
- E2E/脚本如需做“业务口径”的调用，caller 应尽量模拟对应模块地址（而不是任意 EOA）；仅在“测试兜底铸造”场景下允许直接以 minter 身份 mint。

### 4.3 SSOT：计费边界

Reward 域只负责 Easy 的发行、按次消耗与回收分配；AI 调用计费与结算请以 `docs/Usage-Guide/AI-Credits-Billing-Guide.md` 为准。

### 4.4 SSOT：RewardView 读模型语义

> 目的：统一前端、产品、测试对 `RewardView` 各个字段的解释，避免把“累计发放”、“当前持仓”、“待抵扣 penalty”混成同一个数。

- `getUserBalanceWithMeta(user).balance`
  - 语义：**当前钱包 Easy 余额**。
  - 来源：`EasyToken.balanceOf(user)` 的 best-effort 透传。
  - 用途：余额展示、消费前校验、钱包资产面板。

- `getUserEasyEarnedWithMeta(user).easyEarned`
  - 语义：**累计净发放到该用户的 Easy 数量**。
  - 当前实现口径：主发奖路径 `EasyEmissionController -> RewardView.pushEasyMinted(...)` 写入该字段。
  - 特性：单调不减；它表示“累计被发放过多少”，不是“当前还剩多少”。

- `getUserRewardSummaryWithMeta(user).pendingPenalty`
  - 语义：**待抵扣的 Easy 欠账/罚分账本**。
  - 当前实现口径：由 `RewardAccrualManager` 维护；后续奖励会先抵扣该值，再体现在钱包余额上。
  - 用途：消费前校验、风险提示、可用余额计算。

- `getUserRewardSummaryWithMeta(user).totalBurned`
  - 语义：**累计已实际 burn 的 Easy 数量**。
  - 用途：链上扣罚/消费/回收 burn 的累计观测，不等于 pendingPenalty。

- `totalEarned`
  - 语义：**已退出对外 ABI 的历史口径字段**。
  - 当前实现口径：已不再作为 `getUserRewardSummaryWithMeta(...)` 的公开返回值；链上仅保留升级安全所需的历史 storage 槽位，不再作为读模型输出。
  - 结论：产品、前端、脚本、E2E、链下索引均不得再读取或推导该字段；累计主发奖口径统一使用 `getUserEasyEarnedWithMeta(user).easyEarned`。

- 推荐展示口径
  - `walletEasyBalance = getUserBalanceWithMeta(user).balance`
  - `lifetimeEasyEarned = getUserEasyEarnedWithMeta(user).easyEarned`
  - `pendingPenalty = getUserRewardSummaryWithMeta(user).pendingPenalty`
  - `availableEasyBalance = max(walletEasyBalance - pendingPenalty, 0)`

- 产品约束
  - 钱包净增不一定等于本次奖励发放，因为奖励会先抵扣 `pendingPenalty`。
  - 奖励累计主指标只允许使用 `easyEarned`；`totalEarned` 不再暴露给前端与脚本。

## 5. 事件与 offchain 解析约定

### 5.1 事件字段的资产语义

- 所有 reward 相关事件中出现的 `easy*` 字段，均表示 **EasyToken 数量**。
- 链下索引/后端落库的列名建议：
  - `easy_spent` / `easy_burned` / `pending_easy_debt`

### 5.2 兼容性声明（避免误解）

- `getUserRewardSummaryWithMeta(user)` 当前公开返回：`(totalBurned, pendingPenalty, level, lastActivity, blockNumber, isValid)`。
- 历史 `REWARD_EARNED` 观测口径已退出活跃源码路径；奖励发放观测统一使用 `EASY_MINTED`，状态读取统一使用 `easyEarned`、`pendingPenalty`、`earnState`。

- 链下索引与后端落库应统一使用 Easy 语义字段名。
- 若发现旧事件或旧 ABI 仍暴露业务语义 `points*`，应视为迁移债务并尽快移除。

## 6. PR 检查清单（强制）

变更涉及 Reward 域（Earn/Spend/扣罚/回收）、View 数据推送时：

- [ ] 是否所有对外 surface（函数参数名/事件参数名/struct 字段名）都使用 `easy*` 表示 EasyToken 数量？
- [ ] 是否仍有历史 `points*` 暴露为业务语义（需要改为 `easy*`）？
- [ ] 是否所有奖励通证地址都来自 `Registry[KEY_EASY_TOKEN]`？
- [ ] 是否在 NatSpec 明确单位为 18 decimals 的 EasyToken 最小单位？
- [ ] 是否误改了 `basis points (bps)` / `checkpoints` 等非 Reward 语义字段？（不应修改）
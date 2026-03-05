# SSOT：EasyToken 语义与命名规范（Reward 域）

> 目的：在 **EasyToken-only** 目标态下，统一“奖励通证数量”的语义与命名，避免历史 `points` 词根导致的误读。

## 1. 术语与范围

### 1.1 SSOT（Single Source of Truth）定义

- **奖励通证（Reward Token）唯一 SSOT**：`Registry[KEY_EASY_TOKEN]` 解析得到的 `EasyToken` 合约地址。
- 本文中出现的 **easy** / **EasyToken** / **reward token** 语义均指向同一资产：`EasyToken`。

### 1.2 本文覆盖的“points”

本文只约束 **业务语义 points**（即“奖励通证数量 / 消耗 / 汇率”这类）。

重要澄清：Reward 域 **不存在** 独立的 “points 资产/积分币”。
- 业务语义 `points` 只是历史命名，其含义 **始终等价于 EasyToken 数量**（18 decimals，SSOT 为 `Registry[KEY_EASY_TOKEN]`）。

本文不涵盖以下非业务 points：

- 金融比例术语：**basis points（bps）**（例如 `multiplierBps`、`feeBps`、注释中的 “basis points”）。
- 英文表达：`A points to B`（表示“指向/映射”，不是积分）。
- 治理/技术术语：`checkpoints`（OpenZeppelin Votes 相关）。
- 数据/风控语义：price “points”（历史价格点位/采样点，例如 `minimum historical price points`），不是奖励通证。
- 风险评分语义：risk “penalty points”（用于风险分扣减/评分，不是 EasyToken 数量）。

## 2. EasyToken 的资产语义（统一口径）

### 2.1 基本语义

- `EasyToken` 是 **ERC20 奖励通证**（资产语义）。
- 在 Reward 域内，历史遗留字段名可能仍叫 `points`，但其资产语义必须解释为 **EasyToken 数量**（不是另一种积分/计分资产）。

### 2.2 单位与精度

- **默认精度**：18 decimals（与当前合约/文档口径一致）。
- 凡涉及数量的字段/参数，应在注释中明确：
  - `easyAmount` / `easySpent` / `easyBurned` 等均为 **EasyToken 最小单位（18 decimals）**。

## 3. 命名规范（强制）

> 原则：**对外 surface（ABI/事件/结构体字段）优先使用 `easy*` 前缀**；内部局部变量可用 `amount`，但不得把“业务语义 points”暴露为 `points*`。

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

#### 3.1.2 典型对照（从 points → easy）

- `pointsSpent` → `easySpent`
- `pointsBurned` → `easyBurned`
- `pointsCost` → `easyCost`
- `PenaltyApplied(..., points, ...)` → `PenaltyApplied(..., easyAmount, ...)`

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

### 4.2 SSOT：计费边界

Reward 域只负责 Easy 的发行、按次消耗与回收分配；AI 调用计费与结算请以 `docs/Usage-Guide/AI-Credits-Billing-Guide.md` 为准。

## 5. 事件与 offchain 解析约定

### 5.1 事件字段的资产语义

- 所有 reward 相关事件中出现的 `easy*` 字段，均表示 **EasyToken 数量**。
- 链下索引/后端落库的列名建议：
  - `easy_spent` / `easy_burned` / `pending_easy_debt`

### 5.2 兼容性声明（避免误解）

- 如果历史事件/ABI 参数名仍存在 `points`（未完成重命名时），链下必须将其解释为 **EasyToken 数量**。
- 但目标态：对外 surface 不再暴露 `points*`（业务语义）。

## 6. PR 检查清单（强制）

变更涉及 Reward 域（Earn/Spend/扣罚/回收）、View 数据推送时：

- [ ] 是否所有对外 surface（函数参数名/事件参数名/struct 字段名）都使用 `easy*` 表示 EasyToken 数量？
- [ ] 是否仍有 `points*` 暴露为业务语义（需要改为 `easy*`）？
- [ ] 是否所有奖励通证地址都来自 `Registry[KEY_EASY_TOKEN]`？
- [ ] 是否在 NatSpec 明确单位为 18 decimals 的 EasyToken 最小单位？
- [ ] 是否误改了 `basis points (bps)` / `A points to B` / `checkpoints` 等非业务 points？（不应修改）
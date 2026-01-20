## 目标

这份文档用于**统一团队沟通口径**，避免在实现与评审中把“方案A/方案B”叫乱。本文以 `docs/Architecture-Guide.md` 的主线为准，将清算与抵押托管的目标架构统一表述为：

- **清算写入直达账本（Direct-to-Ledger）**
- **清算事件/DataPush 单点（LiquidatorView 单点推送）**
- **清算对外写入口唯一（`KEY_SETTLEMENT_MANAGER`）**

> 建议：在 PR、测试用例、脚本与讨论中，尽量使用“直达账本清算架构 / 旧路径（Legacy）”这两个词，而不是“方案A/方案B”。

---

## 统一命名：用“架构特征”替代“方案A/方案B”

### 推荐术语（对外/对内统一）

- **目标架构（Direct-to-Ledger / 直达账本）**  
  写入直接调用账本模块（`CollateralManager` / `LendingEngine`），不经 View 转发；清算完成后只由 `LiquidatorView` 做 DataPush。

- **旧路径（Legacy / 旧模块族 / 旧清算族）**  
  指历史遗留的“第二入口”“经 View/业务层转发写入”“旧 key 绑定”“旧清算模块族（如 LCM/LiquidationViewLibrary 等；其中 `LiquidationViewLibrary` 已移除）”等，与目标架构的职责边界冲突或重复。

### 术语映射（把“方案A/方案B”翻译成文档一致的说法）

| 你任务里的叫法 | 建议统一叫法 | 核心特征（用于验收） |
|---|---|---|
| 方案A（目标） | **直达账本清算架构（Direct-to-Ledger）** | `KEY_SETTLEMENT_MANAGER` 编排 → `KEY_CM` 扣押 → `KEY_LE` 减债 → `LiquidatorView.push*` 单点 DataPush |
| 方案B / 旧模块族 | **旧路径（Legacy）** | 任意“第二入口”、任意“VBL 托管抵押假设”、任意“LM 自己 emit DataPush/事件双发”、任意“旧 key/旧模块仍被依赖” |

---

## 目标架构（直达账本）的一句话定义（建议复制到 PR/评审）

**清算由 `SettlementManager`（`KEY_SETTLEMENT_MANAGER`）作为唯一对外写入口承接；在清算分支中写入操作只直达账本模块 `CollateralManager` 与 `LendingEngine`，写入成功后仅由 `LiquidatorView.pushLiquidationUpdate/Batch` 进行单点 DataPush；任何 View 不承载写入转发，任何业务层不保留第二清算入口。**

---

## 目标架构：模块职责与调用链（对齐 Architecture-Guide）

### 写路径（清算）

- **对外写入口（SSOT）**：`Registry.KEY_SETTLEMENT_MANAGER` → `SettlementManager`
- **清算执行器（内部）**：`Registry.KEY_LIQUIDATION_MANAGER` → `LiquidationManager`（可选：供 SettlementManager 在清算分支内部调用）
- **扣押抵押（直达账本）**：`Registry.KEY_CM` → `ICollateralManager.withdrawCollateral(...)`（或等价的“扣押/转出”写入口）
- **减少债务（直达账本）**：`Registry.KEY_LE` → `ILendingEngineBasic.forceReduceDebt(...)`（或 `VaultLendingEngine.forceReduceDebt`）
- **单点推送**：`Registry.KEY_LIQUIDATION_VIEW` → `LiquidatorView.pushLiquidationUpdate/Batch`

> 关键原则：**LM 不直接 `_emitData`**，避免事件双发、链下重复消费；View 层不做写入放行。

### 写路径（deposit/withdraw 托管）

- 用户侧：**用户 approve 的对象是 `CollateralManager`（CM）**
- 路由：`VaultCore` → `VaultRouter.processUserOperation` → `CollateralManager.depositCollateral/withdrawCollateral`
- 账本不变量：**CM 内部账本应与真实 ERC20 余额一致**（详见下文建议 #2）

### 权限（强约束）

- 写入权限在账本模块内部校验：`CollateralManager` / `LendingEngine` 内部执行 `ACM.requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender)` 或等效校验。
- 任何“未授权直接调用 `CM.withdraw*` / `LE.forceReduceDebt`”必须回滚（应写成测试用例的硬门槛）。

---

## 旧路径（Legacy）范围定义：哪些必须删/禁用/断开依赖

下面这些被统一归类为“旧路径（Legacy）”，在目标架构下应**删除、revert 禁用、或彻底断开 Registry/key 依赖**（以实际代码为准）：

- **第二清算入口**：例如 `VaultBusinessLogic.liquidate`（或任何 VBL 内清算执行入口）
- **旧清算模块族**：例如 `LiquidationCollateralManager` / `LiquidationRewardDistributor` / `LiquidationViewLibrary` 等（以及它们的绑定、脚本部署与测试依赖）
- **旧 key 依赖**：例如 `KEY_LIQUIDATION_COLLATERAL_MANAGER` 等与目标架构冲突/重复的模块键
- **“VBL 托管抵押”假设**：任何仍在业务层执行 `safeTransferFrom/safeTransfer` 来托管抵押 token 的路径

验收口径建议：

- Registry 中 **`KEY_SETTLEMENT_MANAGER` 只指向一个合约地址**（目标为 `SettlementManager`）。
- `LiquidationManager` 成功路径只触发一次 `LiquidatorView.push*`；链下只订阅 `DataPushed`（或统一事件）即可重建状态。

---

## 建议的 4 点优化/补强（推荐写进实现与测试要求）

### 建议 #1：统一“扣押/提现”写入口语义，减少接口分裂

当前文档示例使用 `ICollateralManager.withdrawCollateral(user, asset, amount)` 来表达“扣押抵押”。如果你需要“把 token 转给清算人/接收者”，建议优先考虑把语义统一为：

- **一个写入口**覆盖两种场景：提现（receiver=user）与扣押（receiver=liquidator/receiver），例如 `withdrawCollateralTo(user, asset, amount, receiver)`

目标：减少 `withdraw` / `seize` 两套接口并存导致的边界差异与测试遗漏。

### 建议 #2：明确“账本=真实余额”的资产约束或按实际到账记账

若允许 fee-on-transfer / rebasing / 非标准 ERC20：

- deposit 记账应使用 `balanceAfter - balanceBefore`，避免“账本大于真实余额”的坏状态；或
- 在资产白名单策略中明确**禁用**此类 token（更简单、更可控）。

无论选哪条路，都应在单测里覆盖并固化为协议约束。

### 建议 #3：`LiquidatorView` 推送建议“最佳努力不回滚”，并提供可观测失败信号

目标：避免“缓存/推送层问题”放大为“资金层不可用”。

- 账本写入成功后再调用 `LiquidatorView.push*`
- 若 push 失败：建议不回滚清算写入（最佳努力），同时发出一个轻量失败事件供链下告警与补推（失败事件不等同 DataPush）

### 建议 #4：入口唯一性要做到“不可误用”，避免旧入口回流

一旦决定 `SettlementManager` 为唯一对外清算/结算入口：

- `Registry.KEY_SETTLEMENT_MANAGER` 只绑定 `SettlementManager`
- 任何 VBL 内残留清算入口要么删除，要么明确 `revert`（并配套测试），防止运维误配产生“双入口 + 权限分叉”

---

## 推荐在任务列表中的落地表达（替换“方案A/方案B”）

你原 10 项任务可以统一改写为以下口径（用于 README/PR 描述）：

- **锁定目标架构**：直达账本清算 + CM 托管 + 清算入口唯一 + LiquidatorView 单点推送；定义“旧路径（Legacy）”清单与下线策略
- **CM 托管与账本一致性**：所有抵押 token 的转入/转出均在 CM 内完成，确保账本与余额一致；补齐清算扣押/转出语义
- **入口链路统一**：deposit/withdraw 统一走 `VaultCore → VaultRouter → CM`，用户 approve CM；业务层移除任何抵押托管转账
- **LM 清算编排统一**：扣押调用 CM、减债调用 LE，成功后仅 LiquidatorView 推送，失败策略与“最佳努力推送”一致
- **权限与角色统一**：账本模块内部校验 `ACTION_LIQUIDATE`，部署脚本只给 LM 必要授权，View 写入白名单严格收敛
- **旧路径下线**：删除/禁用第二入口与旧模块族/旧 key 依赖，确保无模块仍依赖“VBL 托管抵押”假设
- **测试与脚本/文档更新**：以“直达账本 + 单点推送 + 权限在账本”作为验收主线更新测试与部署脚本，并在对接文档里明确 approve 对象与资产去向


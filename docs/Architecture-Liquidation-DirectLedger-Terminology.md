## 目标

这份文档用于**统一团队沟通口径**，避免在实现与评审中把“方案A/方案B”叫乱。本文以 `docs/Architecture-Guide.md` 的主线为准，将清算与抵押模块边界的目标架构统一表述为：

- **清算写入直达账本（Direct-to-Ledger）**
- **清算事件/DataPush 单点（LiquidatorView 单点推送）**
- **清算对外写入口按产品线区分（legacy / 通用订单是 `KEY_SETTLEMENT_MANAGER`；blocks-only 是 `KEY_BLOCKS_ONLY_COORDINATOR`）**

> 建议：在 PR、测试用例、脚本与讨论中，尽量使用“直达账本清算架构 / 旧路径（Legacy）”这两个词，而不是“方案A/方案B”。

---

## 统一命名：用“架构特征”替代“方案A/方案B”

### 推荐术语（对外/对内统一）

- **目标架构（Direct-to-Ledger / 直达账本）**  
  写入直接调用账本模块（`CollateralManager` / `LendingEngine`），不经 View 转发；清算完成后只由 `LiquidatorView` 做 DataPush。

- **旧路径（Legacy / 旧模块族 / 旧清算族）**  
  指历史遗留的“第二入口”“经 View/业务层转发写入”“旧 key 绑定”“旧清算模块族（如 LCM/LiquidationViewLibrary 等；其中 `LiquidationViewLibrary` 已移除）”等，与目标架构的职责边界冲突或重复。

### 术语映射（把“方案A/方案B”翻译成文档一致的说法）

| 你任务里的叫法   | 建议统一叫法                             | 核心特征（用于验收）                                                                                                  |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 方案A（目标）    | **直达账本清算架构（Direct-to-Ledger）** | 清算写入直达账本（CM/LE），且清算事件/DataPush 仅保留单点推送（LiquidatorView）                                       |
| 方案B / 旧模块族 | **旧路径（Legacy）**                     | 任意“第二入口”、任意“资金链/资产流动/调用顺序复述”、任意“LM 自己 emit DataPush/事件双发”、任意“旧 key/旧模块仍被依赖” |

---

## 目标架构（直达账本）的一句话定义（建议复制到 PR/评审）

本文件只定义“术语与验收特征”，不复述清算资金链/调用链细节。

- 清算对外写入口按产品线区分：legacy / 通用订单使用 `SettlementManager`（`KEY_SETTLEMENT_MANAGER`）；blocks-only 使用 `BlocksOnlyCoordinator`（`KEY_BLOCKS_ONLY_COORDINATOR`）
- 写入直达账本：账本写入仅发生在 `CollateralManager` / `LendingEngine`
- 单点推送：仅保留 `LiquidatorView.push*` 的 DataPush 入口

资金链视角的完整说明以 Funds-Flow 为 SSOT：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`。

---

## 目标架构：模块职责（对齐 Architecture-Guide）

本节只保留模块职责边界，不复述“谁调用谁/按什么顺序”的串联式调用链。

- **对外写入口（SSOT，按产品线区分）**：legacy / 通用订单使用 `SettlementManager`（`KEY_SETTLEMENT_MANAGER`）；blocks-only 使用 `BlocksOnlyCoordinator`（`KEY_BLOCKS_ONLY_COORDINATOR`）
- **清算执行器（可选内部模块）**：`LiquidationManager`（`KEY_LIQUIDATION_MANAGER`）
- **抵押账本（写入在此发生）**：`CollateralManager`（`KEY_CM`）
- **债务账本（写入在此发生）**：`LendingEngine` / `VaultLendingEngine`（`KEY_LE`）
- **清算单点推送**：`LiquidatorView`（`KEY_LIQUIDATION_VIEW`）

> 关键原则：**LM 不直接 `_emitData`**，避免事件双发、链下重复消费；View 层不做写入放行。

### deposit/withdraw 资金链（SSOT）

deposit/withdraw 的资金链口径不在此文维护，请直接参考 Funds-Flow SSOT：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`。

### 权限（强约束）

- 写入权限在账本模块内部校验：`CollateralManager` / `LendingEngine` 内部执行 `ACM.requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender)` 或等效校验。
- 任何“未授权直接调用 `CM.withdraw*` / `LE.forceReduceDebt`”必须回滚（应写成测试用例的硬门槛）。

---

## 旧路径（Legacy）范围定义：哪些必须删/禁用/断开依赖

下面这些被统一归类为“旧路径（Legacy）”，在目标架构下应**删除、revert 禁用、或彻底断开 Registry/key 依赖**（以实际代码为准）：

- **第二清算入口**：例如 `VaultBusinessLogic.liquidate`（或任何 VBL 内清算执行入口）
- **旧清算模块族**：例如 `LiquidationCollateralManager` / `LiquidationRewardDistributor` / `LiquidationViewLibrary` 等（以及它们的绑定、脚本部署与测试依赖）
- **旧 key 依赖**：例如 `KEY_LIQUIDATION_COLLATERAL_MANAGER` 等与目标架构冲突/重复的模块键
- **资金链口径复述**：任何在非 Funds-Flow SSOT 文档中复述“资产流动/转账细节/调用顺序”的说明都属于旧口径，应删除并改为引用 Funds-Flow SSOT

验收口径建议：

- Registry 中 **`KEY_SETTLEMENT_MANAGER` 只指向一个合约地址**（目标为 `SettlementManager`）。
- `LiquidationManager` 成功路径只触发一次 `LiquidatorView.push*`；链下只订阅 `DataPushed`（或统一事件）即可重建状态。

---

## 建议的 2 点优化/补强（推荐写进实现与测试要求）

### 建议 #1：`LiquidatorView` 推送建议“最佳努力不回滚”，并提供可观测失败信号

目标：避免“缓存/推送层问题”放大为“资金层不可用”。

- 账本写入成功后再调用 `LiquidatorView.push*`
- 若 push 失败：建议不回滚清算写入（最佳努力），同时发出一个轻量失败事件供链下告警与补推（失败事件不等同 DataPush）

### 建议 #2：入口唯一性要做到“不可误用”，避免旧入口回流

一旦决定 `SettlementManager` 为唯一对外清算/结算入口：

- `Registry.KEY_SETTLEMENT_MANAGER` 只绑定 `SettlementManager`
- 任何 VBL 内残留清算入口要么删除，要么明确 `revert`（并配套测试），防止运维误配产生“双入口 + 权限分叉”

---

## 推荐在任务列表中的落地表达（替换“方案A/方案B”）

你原 10 项任务可以统一改写为以下口径（用于 README/PR 描述）：

- **锁定目标架构**：直达账本清算 + 按产品线区分对外入口 + LiquidatorView 单点推送；定义“旧路径（Legacy）”清单与下线策略
- **入口链路统一**：清算/结算写入口收敛到 `SettlementManager`；旧入口删除或 `revert` 并配套测试
- **权限与角色统一**：账本模块内部校验 `ACTION_LIQUIDATE`（或等效校验），覆盖“未授权必回滚”的测试硬门槛
- **旧路径下线**：删除/禁用第二入口与旧模块族/旧 key 依赖
- **文档治理**：任何资金链/资产流动/调用顺序叙事统一引用 Funds-Flow SSOT

# RWA借贷清算机制逻辑说明（与当前实现对齐）

## 🔗 References（口径来源与关联文档）

- **Architecture**: [`docs/Architecture-Guide.md`](../../Architecture-Guide.md)
- **资金链 SSOT（托管者/资产去向/内部调用串联）**: [`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](../Funds-Flow-Architecture-Guide.md)
- **Terminology**: [`docs/Architecture-Liquidation-DirectLedger-Terminology.md`](../../Architecture-Liquidation-DirectLedger-Terminology.md)
- **Related**
  - 完整清算逻辑（端到端口径）：[`liquidation-complete-logic.md`](./liquidation-complete-logic.md)
  - 清算积分惩罚/奖励（可选扩展）：[`liquidation-reward-penalty.md`](./liquidation-reward-penalty.md)

## 📋 概述

本文档对齐当前代码与 `docs/Architecture-Guide.md`，但**不复述资金链/托管者/资产去向/内部调用顺序**。

- **按产品线区分写入口**：legacy / 通用订单的结算与处置收敛到 `SettlementManager`；blocks-only 订单的到期收尾收敛到 `BlocksOnlyCoordinator`。
- **事件/DataPush 单点**：写入成功后由 `LiquidatorView.push*` 进行 best-effort 推送（不应放大为资金层不可用）。
- **风控只读聚合**：`HealthView` / `LiquidationRiskManager` 只读聚合与缓存；写入口不承担只读门面。
- **预言机与优雅降级**：预言机访问与降级逻辑收敛在 `VaultLendingEngine` 的估值路径。

## ✅ 职责边界（当前实现）

- **编排层（SettlementManager）**：legacy / 通用订单的对外写入口；内部根据状态机选择“结算（还款/提前还款）”或“清算（被动清算）”分支。
- **BlocksOnlyCoordinator**：blocks-only 产品线的对外写入口；内部根据 debt 与 maturity 状态选择“settle”或“liquidate”分支。
- **清算执行器（LiquidationManager）**：供上游产品线入口在清算分支内部调用；不作为对外默认入口使用。
- **账本层（CollateralManager / VaultLendingEngine）**：执行状态变更并在内部校验权限；LE 负责估值与降级。
- **视图层（LiquidatorView / HealthView / LiquidationRiskManager）**：只读、缓存、推送；不代写账本、不放行写权限。

## 🧭 入口收敛与验收点

- keeper/机器人应只依赖“所属产品线的唯一对外写入口”触发处置；避免同一产品线出现多入口而导致权限/参数/对账口径分叉。
- 任何涉及“谁持币/钱怎么走/先后顺序”的描述，一律引用 Funds-Flow SSOT。

## ⚙️ 参数与配置说明（当前实现口径）

- **清算阈值/健康因子**：以 `HealthView`/`LiquidationRiskManager` 的只读聚合口径为准（对外 0 gas 查询）。
- **bonus**：当前口径为“用于事件/链下统计展示”，默认由合约内部给出（实现可演进）；链上不自动结算“奖励”。

## 🧩 执行器入口（兼容/测试/应急）

- `LiquidationManager.liquidate/batchLiquidate(...)` 保留为 **显式参数执行器入口**（role-gated），用于测试/应急/手工处置；**不应**作为 keeper 常态主入口（避免参数计算/权限/资金链口径分叉）。

## 🧭 迁移提示（避免旧路径回流）

- 不再使用 `VaultBusinessLogic` 作为清算编排入口（清算入口已下线并 revert）。
- 不再依赖 `LiquidationCollateralManager/LiquidationDebtManager/LiquidationRewardDistributor/LiquidationViewLibrary` 等旧模块族（其中 `LiquidationViewLibrary` 已移除；应保持不部署/不注册）。

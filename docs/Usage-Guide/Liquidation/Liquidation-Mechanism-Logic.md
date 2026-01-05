# RWA借贷清算机制逻辑说明（与当前实现对齐）

## 🔗 References（口径来源与关联文档）

- **Architecture**: [`docs/Architecture-Guide.md`](../../Architecture-Guide.md)
- **Terminology**: [`docs/Architecture-Liquidation-DirectLedger-Terminology.md`](../../Architecture-Liquidation-DirectLedger-Terminology.md)
- **Related**
  - 完整清算逻辑（端到端口径）：[`liquidation-complete-logic.md`](./liquidation-complete-logic.md)
  - 清算积分惩罚/奖励（可选扩展）：[`liquidation-reward-penalty.md`](./liquidation-reward-penalty.md)

## 📋 概述

本文档对齐当前代码与 `docs/Architecture-Guide.md`：

- **清算写路径（直达账本）**：`LiquidationManager` 为唯一入口，写入直达 `CollateralManager`（扣押抵押）与 `VaultLendingEngine`（减少债务），不经 View 转发写入。
- **事件/DataPush 单点**：账本写入成功后，统一由 `LiquidatorView.pushLiquidationUpdate/Batch` 触发（best-effort，不回滚账本写入）。
- **风控只读聚合**：`HealthView` / `LiquidationRiskManager` 提供健康因子与风险聚合；只读查询统一走 View/风险模块，不在写入口做“只读门面”。
- **预言机与优雅降级**：仅在 `VaultLendingEngine` 的估值路径中访问预言机并执行降级逻辑。

## 🏗️ 系统架构（对齐当前实现）

```
清算系统（直达账本 + 单点推送）
├── Registry
│   ├── KEY_LIQUIDATION_MANAGER → LiquidationManager（清算唯一入口）
│   ├── KEY_CM → CollateralManager（扣押抵押：withdrawCollateralTo）
│   ├── KEY_LE → VaultLendingEngine（减债：forceReduceDebt）
│   ├── KEY_LIQUIDATION_VIEW → LiquidatorView（只读 + DataPush 单点）
│   ├── KEY_HEALTH_VIEW → HealthView（风险缓存/推送）
│   └── KEY_LIQUIDATION_RISK_MANAGER → LiquidationRiskManager（风险聚合只读/缓存）
└── 写路径
    └── LiquidationManager → (CM.withdrawCollateralTo, LE.forceReduceDebt) → LiquidatorView.push*
```

## ✅ 职责边界（当前实现）

- **编排层（LiquidationManager）**：仅做参数检查、权限校验与调用账本写入口；不承担只读聚合。
- **账本层（CollateralManager / VaultLendingEngine）**：执行状态变更并在内部校验权限（例如 `ACTION_LIQUIDATE`）；LE 负责估值与降级。
- **视图层（LiquidatorView / HealthView / LiquidationRiskManager）**：只读、缓存、推送；不代写账本、不放行写权限。

## 🔁 清算写路径（与当前实现一致）

1) Keeper/机器人通过只读模块确认可清算，并在链下计算 `collateralAmount/debtAmount/bonus`。  
2) 调用 `LiquidationManager.liquidate(targetUser, collateralAsset, debtAsset, collateralAmount, debtAmount, bonus)`。  
3) `LiquidationManager` 直达账本：
   - `KEY_CM → withdrawCollateralTo(targetUser, collateralAsset, collateralAmount, liquidatorOrReceiver)`
   - `KEY_LE → forceReduceDebt(targetUser, debtAsset, debtAmount)`
4) 成功后 best-effort：`LiquidatorView.pushLiquidationUpdate/Batch` 单点推送。  
5) 账本变更后，`VaultLendingEngine` 会推送 `VaultRouter`/`HealthView` 更新缓存（与架构指南保持一致）。  

## ⚙️ 参数与配置说明（当前实现口径）

- **清算阈值/健康因子**：以 `HealthView`/`LiquidationRiskManager` 的只读聚合口径为准（对外 0 gas 查询）。
- **bonus**：由执行者（keeper/机器人）传入，当前用于事件/链下统计口径；链上不自动结算“奖励”。

## 🧭 迁移提示（避免旧路径回流）

- 不再使用 `VaultBusinessLogic` 作为清算编排入口（清算入口已下线并 revert）。
- 不再依赖 `LiquidationCollateralManager/LiquidationDebtManager/LiquidationRewardDistributor/LiquidationViewLibrary` 等旧模块族（应保持不部署/不注册）。
# 完整清算逻辑（与当前架构口径对齐：按产品线区分入口）

## 🔗 References（口径来源与关联文档）

- **Architecture**: [`docs/Architecture-Guide.md`](../../Architecture-Guide.md)
- **资金链 SSOT（托管者/资产去向/内部调用串联）**: [`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](../Funds-Flow-Architecture-Guide.md)
- **Terminology**: [`docs/Architecture-Liquidation-DirectLedger-Terminology.md`](../../Architecture-Liquidation-DirectLedger-Terminology.md)
- **Related**
  - 清算机制与调用链（概要）：[`Liquidation-Mechanism-Logic.md`](./Liquidation-Mechanism-Logic.md)
  - 清算积分惩罚/奖励（可选扩展）：[`liquidation-reward-penalty.md`](./liquidation-reward-penalty.md)

## 📋 **概述**

本文档对齐 `docs/Architecture-Guide.md` 的口径：**写入口按产品线区分**。legacy / 通用订单由 `SettlementManager` 承接按时还款、提前还款、到期未还与抵押价值过低触发的被动清算；blocks-only 订单由 `BlocksOnlyCoordinator` 承接到期后的 settle-or-liquidate。两条产品线在需要时都会进入直达账本的处置路径（`ICollateralManager.withdrawCollateralTo`、`ILendingEngineBasic.forceReduceDebt`），事件/DataPush 由各自模块或 `LiquidatorView` 单点触发；健康与风险缓存由 `HealthView/LiquidationRiskManager` 提供，预言机访问与优雅降级仅在 `VaultLendingEngine` 估值路径中发生。

> 约束：本文不复述任何资金链、托管者、资产去向、分配比例或内部调用顺序。上述口径统一以 Funds-Flow SSOT 为准。

## 🏗️ **技术实现（仅职责对齐，不含资金链叙事）**

### **核心模块（职责对齐）**

1. **SettlementManager** - legacy / 通用订单的对外写入口（SSOT）：统一承接还款结算与被动清算（到期未还/价值过低）
2. **BlocksOnlyCoordinator** - blocks-only 产品线的对外写入口（SSOT）：统一承接 finalize、repay 与 maturity settle-or-liquidate
3. **LiquidationManager** - 清算执行器：供 `SettlementManager` 或 `BlocksOnlyCoordinator` 在清算分支内部调用（可承接清算参数校验/事件聚合/残值分配路由等）
4. **CollateralManager（CM）** - 抵押相关账本与资产操作模块（托管者/资产去向口径见 Funds-Flow SSOT）
5. **VaultLendingEngine（LE / ILendingEngineBasic）** - 债务账本写入（并在账本变更后推送 VaultRouter/HealthView）
6. **LiquidatorView** - legacy / 通用清算的事件/DataPush 单点入口 + 清算只读查询
7. **LiquidationRiskManager / HealthView** - 风险与健康只读聚合/缓存（不参与写入）

### **资金链与对账口径（仅引用）**

清算相关的资金链、托管关系、资产去向、残值分配语义与内部调用顺序，统一以 Funds-Flow SSOT 为准：[`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](../Funds-Flow-Architecture-Guide.md)（Default → Liquidation）。

## SettlementManager 全面整改总纲（SSOT）

> 本文档是“SettlementManager 统一结算/清算写入口”整改的 **Single Source of Truth**。  
> 与清算相关的其它指南（收款地址/白名单/阈值/奖励惩罚等）如有冲突，**以本文为准**。

---

### References

- 架构总口径：[`docs/Architecture-Guide.md`](../../Architecture-Guide.md)（已补充 `SettlementManager` 章节）
- 清算机制与调用链：[`Liquidation-Mechanism-Logic.md`](./Liquidation-Mechanism-Logic.md)
- 完整处置逻辑：[`liquidation-complete-logic.md`](./liquidation-complete-logic.md)
- 残值分配收款地址：[`Liquidation-Payout-Address-Guide.md`](./Liquidation-Payout-Address-Guide.md)
- 清算收款与白名单：[`Liquidation-Recipient-Whitelist-Plan.md`](./Liquidation-Recipient-Whitelist-Plan.md)
- 双轨治理：[`docs/Usage-Guide/Governance-Dual-Track-Guide.md`](../Governance-Dual-Track-Guide.md)

---

## 1) 目标与最终口径（你们要达成的“唯一正确答案”）

- **唯一对外写入口**：所有“按时还款 / 提前还款 / 到期未还处置 / 抵押价值过低触发的被动清算”均由 `SettlementManager` 统一承接。
- **仓位主键（SSOT 定义）**：本项目中“仓位主键”**统一定义为 `orderId`**，由 `core/LendingEngine.createLoanOrder(...)` 生成并在全链路（结算、清算、白名单动态解析、链下索引）中复用。  
  - 历史文档里的“旧称/旧口径”一律视为 `orderId`，后续不再使用旧称以避免歧义。
- **职责拆分**：
  - `SettlementManager`：对外入口 + 状态机分支（结算 vs 清算）
  - `LiquidationManager`：可选“清算执行器”（仅供 SettlementManager 在清算分支内部调用；不再作为对外唯一入口）
  - `CollateralManager`（CM）：抵押托管/划转（真实资产池/资金池）
  - `LendingEngine`（LE）：债务账本更新（repay/forceReduceDebt）+ 估值路径优雅降级
  - `FeeRouter`：费用类资金统一路由到 `platformTreasury`（推荐合约金库）
  - `LiquidatorView`：清算相关事件/DataPush 单点推送（best-effort）

---

## 2) 统一入口的对外接口（建议定稿）

> 说明：接口命名/参数以“可审计 + 可复现”为目标；本项目统一使用 `orderId` 作为关系白名单与风控判定的主键。

### 2.1 用户入口：还款结算

- `repayAndSettle(user, debtAsset, repayAmount, orderId)`（推荐）
  - 由 B（borrower）发起
  - `SettlementManager` 在单交易内完成：
    - `LE.repay(...)`（减债）
    - 若满足释放条件：`CM.withdrawCollateralTo(..., borrowerAddr)`（抵押直接回 B 钱包）
    - 若触发被动清算条件：进入清算分支（见 §3.2）

### 2.2 Keeper/系统入口：到期/风险处置

- `settleOrLiquidate(orderId)`（推荐）
  - 由 keeper/机器人发起（或由系统任务触发）
  - `SettlementManager` 读取仓位/订单状态（到期、健康因子、价格降级后的估值等）决定：
    - 走“结算分支”：释放抵押回 B
    - 走“清算分支”：扣押抵押/减债/（可选）残值分配

---

## 3) 状态机分支与资金去向（权威）

### 3.1 结算分支（按时还款 / 提前还款）

- **减债**：`LE.repay(...)`
- **抵押返还**：`CM.withdrawCollateralTo(..., borrowerAddr)`（抵押直接回 B 钱包）
- **费用/罚金**（若存在）：
  - 费用类资金统一通过 `FeeRouter` 路由
  - `FeeRouter.platformTreasury` 推荐配置为 **合约金库地址（PlatformFeeVault）**

### 3.2 清算分支（到期未还 / 价值过低触发的被动清算）

- **扣押抵押**：`CM.withdrawCollateralTo(..., receiver)`（receiver 由清算分支决定）
- **强制减债**：`LE.forceReduceDebt(...)`（或等效强制路径）
- **事件/DataPush 单点**：`LiquidatorView.pushLiquidationUpdate/Batch`（best-effort）
- **残值分配（可选）**：
  - 启用 `LiquidationPayoutManager` 后，根据 `platform/reserve/lender/liquidator` bps 配置路由份额
  - 平台/准备金推荐进入 **合约金库地址**（非 EOA/多签）
  - lender recipient 由 `SettlementManager` 动态解析为 A（current lender）

---

## 4) 白名单与收款规则（与 A/B 关系一致）

> 关键原则：不维护“静态地址白名单列表”覆盖 A/B；使用“关系白名单”（按 `orderId` 动态解析）。

- **Borrower（B）**：仅可接收自己仓位的抵押返还（结算分支）
- **Lender（A）**：在清算分支中作为出借人补偿/抵押归属方之一（按启用的分配策略）
- **PlatformFeeVault（合约金库）**：固定唯一地址，只接收平台费（以及可选的清算平台份额）
- **ReserveFundVault（可选合约金库）**：固定唯一地址，只接收准备金份额
- **Liquidator（keeper）**：默认 `recipient == msg.sender`（最强约束）；如需更复杂分发，建议进入 `LiquidatorRewardVault` 合约

---

## 5) 模块键（Registry）与配置项（落地必备）

### 5.1 新增模块键

- `KEY_SETTLEMENT_MANAGER` → `SettlementManager`

### 5.2 既有关键模块键（必须正确）

- `KEY_CM`（CollateralManager）
- `KEY_LE`（LendingEngine / VaultLendingEngine）
- `KEY_LIQUIDATION_MANAGER`（LiquidationManager，作为执行器）
- `KEY_LIQUIDATION_VIEW`（LiquidatorView）
- `KEY_LIQUIDATION_PAYOUT_MANAGER`（LiquidationPayoutManager，可选启用）
- `KEY_FR`（FeeRouter，费用路由）

---

## 6) 迁移策略（从旧路径到单一入口）

### 6.1 文档口径（已完成）

- `docs/Architecture-Guide.md` 已改为 `SettlementManager` SSOT
- `docs/Usage-Guide/Liquidation/*` 已逐步对齐（机制/完整逻辑/阈值/奖励惩罚/收款白名单等）

### 6.2 合约落地（建议执行顺序）

1. **新增 `SettlementManager` 合约**（仅实现最小可用的入口与分支，内部调用现有 CM/LE/LiquidationManager）
2. **Registry 增加 `KEY_SETTLEMENT_MANAGER` 并注册**
3. **改 `VaultCore.repay`**：从直调 `LE.repay` 改为调用 `SettlementManager.repayAndSettle`
4. **对外“清算入口”收敛**：
   - keeper/机器人由调用 `LiquidationManager.liquidate(...)` 改为调用 `SettlementManager.settleOrLiquidate(orderId)`
5. （可选）启用 `LiquidationPayoutManager`，并将平台/准备金接收者指向合约金库

---

## 7) 测试与验收清单（必须覆盖）

- **还款（按时）**：`repayAndSettle` 后债务降低，抵押可按规则返还到 B 钱包
- **提前还款**：结算分支正确，罚金/费用走 FeeRouter（若启用）
- **到期未还**：`settleOrLiquidate` 进入清算分支，扣押抵押 + 强制减债成功
- **价值过低**：在价格降级/预言机异常场景下仍能判定并进入清算分支（口径与 `GracefulDegradation` 对齐）
- **事件单点推送**：清算事件只由 `LiquidatorView` 单点推送（best-effort，不影响账本写入）
- **白名单安全**：A/B 动态解析正确；平台/准备金必须进入合约金库；liquidator recipient 约束生效
- **权限**：只有允许的调用者可触发 `settleOrLiquidate`；治理参数改动走 `ACTION_SET_PARAMETER`（建议迁移至 Timelock）


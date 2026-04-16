# 清算机制逻辑说明（按当前代码对齐）

## References

- Architecture: [`docs/Architecture-Guide.md`](../../Architecture-Guide.md)
- 资金链 SSOT: [`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](../Funds-Flow-Architecture-Guide.md)
- 完整端到端逻辑: [`liquidation-complete-logic.md`](./liquidation-complete-logic.md)
- Reward 惩罚边界: [`liquidation-reward-penalty.md`](./liquidation-reward-penalty.md)

## 概述

当前实现的清算机制是“按产品线分入口、按账本分职责”，不是由单一模块从触发到分账全部包办。

- legacy / 通用订单：用户还款与 keeper 处置都收敛到 `SettlementManager`
- blocks-only 产品线：建单、还款、到期 settle-or-liquidate 都收敛到 `BlocksOnlyCoordinator`
- 真正执行 seize collateral 与 reduce debt 的共享执行器是 `LiquidationManager`
- 风险判定来自 `LiquidationRiskManager / HealthView`
- 清算观测面的单点是 `LiquidatorView`

> 本文不描述资金链、托管者、资产去向、分配比例或内部调用顺序；这些内容统一以 Funds-Flow SSOT 为准。

## 模块职责

### SettlementManager

- legacy / 通用订单的统一结算与被动清算入口
- `repayAndSettle(user, debtAsset, repayAmount, orderId)` 只能由 `VaultCore` 调用
- `settleOrLiquidate(orderId)` 只能由持有 `ACTION_LIQUIDATE` 的 keeper / bot 调用
- 内部负责：
  - 还款结算编排
  - overdue / risk-liquidatable 判断
  - collateral 选择与 liquidation 参数估算
  - 主路径失败时的 fallback 直达账本清算

### BlocksOnlyCoordinator

- blocks-only 产品线的统一入口
- 当前实现只接受：
  - `termBlocks = 1`
  - `rateBps = 0`
  - `lender = Registry[KEY_LENDER_POOL_VAULT]`
- maturity 之后根据 debt 状态进入两类 blocks-only maturity close：debt-free 时返还 borrower collateral，未还清时把 collateral 交付给 lender；两类结果都属于显式 close，而不是再沿用“settled / liquidated”混合业务名。
- 它不会把 maturity 公开入口再转回 `SettlementManager`

### LiquidationManager

- 共享清算执行器，不是用户或 keeper 的默认主入口
- 接收上游已选好的：
  - `targetUser`
  - `collateralAsset`
  - `debtAsset`
  - `collateralAmount`
  - `debtAmount`
- 负责三件事：
  - 调用 `LiquidationPayoutManager.calculateShares(...)`
  - 通过 `CollateralManager.withdrawCollateralTo(...)` 分发 collateral
  - 通过 `VaultLendingEngine.forceReduceDebt(...)` 减少 debt

### LiquidationRiskManager / HealthView

- 只读风控聚合，不直接参与清算写入
- `isLiquidatable(user)` 依赖 `HealthView.getUserHealthFactorWithMeta(user)`
- 当 health cache 无效时，`isLiquidatable(user)` 会安全返回 `false`

### LiquidatorView

- 清算相关 DataPush / payout push 的单点观测面
- 它不是账本 SSOT，也不参与权限放行写账本

## 触发条件

### legacy / 通用订单

`SettlementManager.settleOrLiquidate(orderId)` 进入清算分支的条件是：

- `block.number > ord.maturity` 且 debt 仍大于 0，或
- `LiquidationRiskManager.isLiquidatable(targetUser)` 为 true

因此，legacy / 通用路径并不要求“必须先到期再清算”；只要风险模块认定可清算，就能进入被动清算分支。

### blocks-only 产品线

`BlocksOnlyCoordinator.settleOrLiquidateBlocks(orderId)` 的前提是：

- `block.number >= order.maturityBlock`

这里完全是 block-based 语义，不是 timestamp。

## collateral 选择规则

`SettlementManager` 与 `BlocksOnlyCoordinator` 当前都遵循同一条硬规则：

- 如果候选 collateral 中至少有一个资产拿到了可用 valuation，就只能在这些 valued candidates 中比较
- 只有当全部候选都拿不到可用 valuation 时，才允许退回 raw balance 比较
- 不允许把 valuation 值与 raw balance 混在同一轮 winner selection 中比较

此外，若 debt valuation 读失败，则 liquidation collateral amount 会退回为“所选资产的整笔余额”，不会因为估值失败而直接中断清算。

## legacy / 通用订单主路径

### 1. 还款结算

入口：`SettlementManager.repayAndSettle(...)`

- 权威 full-repay 判定来自 ORDER_ENGINE：
  - `getLoanOrderForView(orderId)`
  - `getOrderTotalDueForView(orderId)`
- 如果用户 debt asset 全部清零，会自动释放全部 tracked collateral 给 borrower
- 如果启用了 `requireFullRepayRelease`，则在仍有 debt 未清零时直接 revert
- 若满足早偿 guarantee 条件，还会尝试调用 ERGM 的 `settleEarlyRepayment(...)`

### 2. keeper 处置

入口：`SettlementManager.settleOrLiquidate(orderId)`

- borrower 不能自己作为 liquidator 触发自己
- 会先按 guarantee/default 逻辑尝试触发 `EarlyRepaymentGuaranteeManager.processDefault(...)`
- 然后计算 reducible debt、挑选 collateral、估算 collateralAmount
- 主路径调用 `LiquidationManager.liquidateFromSettlementManager(...)`
- 如主路径失败，`SettlementManager` 会直接执行 fallback：
  - 按 `LiquidationPayoutManager` 分账
  - 直接 `forceReduceDebt`
  - best-effort 推送 `LiquidatorView`

## blocks-only 产品线主路径

### 1. finalizeMatchBlocks

- principal 从 `LenderPoolVault` 转出并发给 borrower
- debt 通过 `VaultCore / VaultLendingEngine` 记账
- 本地 order 会记录 `startBlock`、`maturityBlock`、`status = ACTIVE`

### 2. repayBlocks

- 只能由 borrower 调用
- repay token 直接转给 `order.lender`
- debt 是否清零仍以 `VaultLendingEngine` 为准
- 本地 `repaidPrincipal` 只是辅助记录，不是债务权威来源

### 3. settleOrLiquidateBlocks

- maturity 后若 `remainingDebt == 0` 或本地状态已是 `REPAID`，则释放全部 collateral，并把显式状态推进到 `CLOSED + BLOCKS_MATURITY_CLOSE + RETURNED_TO_BORROWER`
- 否则执行 maturity delivery，把绑定 collateral 交付给 lender，并把显式状态推进到 `CLOSED + BLOCKS_MATURITY_CLOSE + DELIVERED_TO_LENDER`
- blocks-only 会同时发自己的 `DATA_TYPE_BLOCKS_ONLY_*` 事件；这些事件只能证明写路径发生，终态仍需回读 `BlocksOnlyView.getBlocksOnlyOrderState(orderId)`

## 观测与失败语义

- 清算账本写入成功，不要求 `LiquidatorView` push 一定成功
- `LiquidationManager` 对 `LiquidatorView` 的推送是 best-effort
- `SettlementManager` fallback 路径对 `LiquidatorView` 的推送也是 best-effort
- blocks-only 的产品线 DataPush 与通用 liquidation DataPush 可以并存，链下应按事件类型分别消费

## 与 Reward 的边界

- `SettlementManager` 的清算路径当前不会直接调用 Reward penalty 入口
- Reward 清算惩罚由 `GuaranteeFundManager` 在 default / forfeiture 成功后 best-effort 触发
- Reward 惩罚的记账单位是 Easy，不属于 liquidation 资金链

## 当前实现最容易误判的点

1. legacy / 通用订单与 blocks-only 的 keeper 入口不同，不能混用。
2. full repay 不能只看本地累计还款；通用订单必须看 ORDER_ENGINE 的 total due。
3. `LiquidatorView` 是观测面，不是账本 SSOT。
4. `bonus` 当前只是清算观测字段，不参与账本计算。
5. `SettlementManager` 不会直接触发 Reward 清算罚分。

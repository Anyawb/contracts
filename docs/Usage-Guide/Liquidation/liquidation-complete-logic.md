# 完整清算逻辑（按当前代码对齐）

## 🔗 References

- **Architecture**: [`docs/Architecture-Guide.md`](../../Architecture-Guide.md)
- **资金链 SSOT（托管者 / 资产去向 / 分账顺序）**: [`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](../Funds-Flow-Architecture-Guide.md)
- **Terminology**: [`docs/Architecture-Liquidation-DirectLedger-Terminology.md`](../../Architecture-Liquidation-DirectLedger-Terminology.md)
- **Related**
  - 清算机制概要：[`Liquidation-Mechanism-Logic.md`](./Liquidation-Mechanism-Logic.md)
  - 清算 Reward 扣罚边界：[`liquidation-reward-penalty.md`](./liquidation-reward-penalty.md)

## 📋 概述

当前实现不是“单一清算入口包办全部路径”，而是**按产品线分入口、按账本分职责**：

1. **legacy / 通用订单**：
  - 用户还款结算入口是 `SettlementManager.repayAndSettle(...)`
  - keeper 被动清算入口是 `SettlementManager.settleOrLiquidate(orderId)`
2. **blocks-only 产品线**：
  - 建单/放款入口是 `BlocksOnlyCoordinator.finalizeMatchBlocks(...)`
  - 借款人还款入口是 `BlocksOnlyCoordinator.repayBlocks(...)`
  - 到期处理入口是 `BlocksOnlyCoordinator.settleOrLiquidateBlocks(orderId)`
3. **真正的清算执行器**：
  - `LiquidationManager` 负责直达账本执行：扣 collateral、减 debt、按 `LiquidationPayoutManager` 做残值分配，并 best-effort 推送 `LiquidatorView`
4. **只读 / 观测面**：
  - `LiquidatorView` 是清算事件与 DataPush 单点
  - `LiquidationRiskManager / HealthView` 负责风险判定与缓存，不直接参与写账本

> 约束：本文不复述资金链、托管者、资产去向、平台/准备金/补偿/清算人分配比例。该部分统一以 Funds-Flow SSOT 为准。

## 🏗️ 模块职责与 SSOT

### 1. SettlementManager

- **legacy / 通用订单的结算与被动清算写入口 SSOT**
- `repayAndSettle(...)` 只能由 `VaultCore` 调用
- `settleOrLiquidate(orderId)` 只能由持有 `ACTION_LIQUIDATE` 的 keeper / bot 调用
- 对 blocks-only 来说，它不是主公开入口；blocks-only 到期路径已经独立到 `BlocksOnlyCoordinator`

### 2. BlocksOnlyCoordinator

- **blocks-only 产品线写入口 SSOT**
- 当前实现只接受：
  - `termBlocks = 1`
  - `rateBps = 0`
  - `lender = Registry[KEY_LENDER_POOL_VAULT]`
- 到期后会进入 blocks-only maturity close，不经过 `SettlementManager` 主入口；显式终态要么是 `CLOSED + BLOCKS_MATURITY_CLOSE + RETURNED_TO_BORROWER`，要么是 `CLOSED + BLOCKS_MATURITY_CLOSE + DELIVERED_TO_LENDER`

### 3. LiquidationManager

- **共享清算执行器**
- 输入已经是上游编排好的参数：`targetUser / collateralAsset / debtAsset / collateralAmount / debtAmount`
- 核心动作只有两类：
  - `CollateralManager.withdrawCollateralTo(...)`
  - `VaultLendingEngine.forceReduceDebt(...)`
- 残值分配由 `LiquidationPayoutManager` 决定
- 对 `LiquidatorView` 的推送是 **best-effort**，失败不回滚账本写入

### 4. VaultLendingEngine

- **债务账本 SSOT**
- `SettlementManager` 与 `LiquidationManager` 都会写它
- 清算侧真正减少债务使用 `forceReduceDebt(...)`
- 健康 / 统计相关 push 仍是 best-effort，不能把 View 成功当成账本成功的前提

### 5. LiquidatorView

- **清算事件 / DataPush 单点**
- 授权写入方是：
  - `Registry[KEY_LIQUIDATION_MANAGER]`
  - `Registry[KEY_SETTLEMENT_MANAGER]`
  - payout push 还允许 `Registry[KEY_LIQUIDATION_PAYOUT_MANAGER]`
- 它不是账本 SSOT，只是观测面

## 关键判定权威

### 1. legacy / 通用订单是否 fully repaid

`SettlementManager.repayAndSettle(...)` 虽然负责编排还款结算，但“订单是否已经还清”的权威读口径是：

- `ORDER_ENGINE.getLoanOrderForView(orderId)`
- `ORDER_ENGINE.getOrderTotalDueForView(orderId)`

文档上不能把本地 `repaidAmount` 或任何缓存值当作 full repayment 的唯一 SSOT。

### 2. 是否进入 legacy 清算分支

`SettlementManager.settleOrLiquidate(orderId)` 进入清算分支的条件是二选一：

- **overdue**：`block.number > ord.maturity` 且当前 debt 仍大于 0
- **riskLiquidatable**：`LiquidationRiskManager.isLiquidatable(targetUser)` 为 true

也就是说，legacy / 通用路径并不要求“先到期再清算”；只要风险模块判定可清算，也能提前进入被动清算分支。

### 3. blocks-only 是否允许到期处理

`BlocksOnlyCoordinator.settleOrLiquidateBlocks(orderId)` 必须满足：

- `block.number >= order.maturityBlock`

这里完全是 **block-based** 语义，不是 timestamp。

### 4. collateral 选择规则

`SettlementManager` 与 `BlocksOnlyCoordinator` 当前都遵循同一个规则：

- 如果候选 collateral 中**至少有一个**资产能拿到可用 valuation，则**只能在这些 valued candidates 里比较**
- 只有当所有候选都没有可用 valuation 时，才允许退回 raw balance 比较
- 不允许把“某些资产按 valuation、某些资产按 raw balance”混在同一轮 winner selection 中比较

这是当前代码里显式防止跨资产比较漂移的硬约束。

## 主路径一：legacy / 通用订单还款结算

入口：`SettlementManager.repayAndSettle(user, debtAsset, repayAmount, orderId)`

### 调用与权限

- 只能由 `VaultCore` 调用
- 会先交叉验证：
  - `orderId` 是否属于 `user`
  - `order.asset` 是否等于 `debtAsset`

### 实际流程

1. `SettlementManager` 先授权 `ORDER_ENGINE` 从自己这里拉走本次 repay token
2. 调用 `ORDER_ENGINE.repay(orderId, repayAmount)`
3. 清除授权，并校验 pull amount 是否与预期一致
4. 再读取：
  - 最新 `LoanOrder`
  - `getOrderTotalDueForView(orderId)`
  - `VaultLendingEngine.getDebt(user, debtAsset)`
5. 如果用户已经没有任何 debt asset，则自动释放全部 collateral 给 borrower
6. 如果启用了 `requireFullRepayRelease` 且仍有 debt asset 未清零，则直接 revert `DebtNotCleared`
7. 若满足“订单已 fully repaid 且当前 debtAsset 已清零”，还会按条件尝试触发 `EarlyRepaymentGuaranteeManager.settleEarlyRepayment(...)`

### 当前实现的几个重要点

- collateral 自动释放是**按债务账本是否清零**判定，不依赖 valuation cache
- `RepayAndSettleProcessed` 与 `DATA_TYPE_REPAY_AND_SETTLE` 由 `SettlementManager` 直接发出
- `CollateralReleased` 与 `DATA_TYPE_COLLATERAL_RELEASED` 也由 `SettlementManager` 直接发出

## 主路径二：legacy / 通用订单 keeper 清算

入口：`SettlementManager.settleOrLiquidate(orderId)`

### 调用与权限

- 只能由持有 `ACTION_LIQUIDATE` 的 keeper / bot 调用
- borrower 不能自己作为 liquidator 调自己，代码会直接 revert

### 实际流程

1. 从 `ORDER_ENGINE` 读取 order
2. 根据以下条件判断是否可清算：
  - overdue，或
  - `LiquidationRiskManager.isLiquidatable(targetUser)` 为 true
3. 若有启用中的 ERGM guarantee，会先尝试 `processDefault(targetUser, debtAsset)`
4. 读取：
  - `totalDebt`
  - `reducibleDebtAmount`
  - optional `calculateDebtValue(...)`
5. 在 borrower 当前 collateral 中选出单一 liquidation collateral
6. 估算 `collateralAmount`
  - 若 valuation 不可用，则直接用整笔 selected balance
  - 若 valuation 可用，则按目标 debt value 线性估算并向上取整
7. 尝试调用 `LiquidationManager.liquidateFromSettlementManager(...)`
8. 如果上一步失败，则 `SettlementManager` 自己走 fallback：
  - 直接按 `LiquidationPayoutManager` 分账
  - 直接 `forceReduceDebt`
  - 自己 best-effort 推 `LiquidatorView`

### 当前实现的几个重要点

- legacy 清算默认 bonus 目前写死为 `0`，只作为观测字段，不影响账本写入
- `SettlementManager` 当前**不会直接触发 Reward penalty**；Reward 清算惩罚是另一条边界，需要由保证金 / GuaranteeFund 路径单独触发
- `LoanNFT` 校验是 best-effort，不会阻断主清算流程

## 主路径三：blocks-only 产品线

### A. finalizeMatchBlocks

入口：`BlocksOnlyCoordinator.finalizeMatchBlocks(params)`

- 只能由 `Registry[KEY_VAULT_BUSINESS_LOGIC]` 调用
- 当前产品限制：
  - `termBlocks = 1`
  - `rateBps = 0`
- principal 从 `LenderPoolVault` 转出，再发给 borrower
- debt 通过 `VaultCore.borrowForBlocks(...)` 记账
- coordinator 本地会记录：
  - `startBlock`
  - `maturityBlock = startBlock + termBlocks`
  - `status = ACTIVE`

### B. repayBlocks

入口：`BlocksOnlyCoordinator.repayBlocks(orderId, repayAmount)`

- 只能由 order.borrower 调用
- repay token 会直接转给 order.lender
- 再调用 `VaultCore.repayForBlocks(...)`
- `remainingDebt` 仍以 `VaultLendingEngine.getDebt(...)` 为准
- 本地 `repaidPrincipal` 只是辅助记录，不是 debt SSOT

### C. settleOrLiquidateBlocks

入口：`BlocksOnlyCoordinator.settleOrLiquidateBlocks(orderId)`

- 只能由持有 `ACTION_LIQUIDATE` 的 keeper / bot 调用
- 只有成熟后才能进入：`block.number >= maturityBlock`

#### 分支 1：maturity close with borrower return

满足以下其一即进入 borrower-return close：

- `remainingDebt == 0`
- 本地状态已是 `REPAID`

然后：

- 释放 borrower 全部 tracked collateral
- 显式状态推进到 `CLOSED + BLOCKS_MATURITY_CLOSE + RETURNED_TO_BORROWER`
- 写入 `closeBlock`
- 发出 `BlocksOnlyOrderSettled` 与 `DATA_TYPE_BLOCKS_ONLY_SETTLED`

#### 分支 2：maturity close with lender delivery

若 maturity 后仍有 remainingDebt：

- 直接把 order-bound collateral 交付给 lender
- 本地把 `repaidPrincipal` 归一到 `principal`，确保 remainingDebt 收敛为 0
- 显式状态推进到 `CLOSED + BLOCKS_MATURITY_CLOSE + DELIVERED_TO_LENDER`
- 写入 `closeBlock`
- 发出 `BlocksOnlyOrderDelivered` 与 `DATA_TYPE_BLOCKS_ONLY_DELIVERED`

### 当前实现的几个重要点

- blocks-only 的公开 maturity 入口不是 `SettlementManager`
- blocks-only maturity close 不走 `LiquidationManager.liquidate(...)`；其 lender-delivery 分支由 `BlocksOnlyCoordinator` 直接完成
- blocks-only 自己会发产品线专属 `DATA_TYPE_BLOCKS_ONLY_*`，链下应按 trade-close / settled / delivered 三类终态分别消费

## LiquidationManager 的执行边界

`LiquidationManager` 当前只做三件事：

1. 通过 `LiquidationPayoutManager.calculateShares(...)` 决定 collateral 的分配份额
2. 通过 `CollateralManager.withdrawCollateralTo(...)` 把 seized collateral 发往对应收款方
3. 通过 `VaultLendingEngine.forceReduceDebt(...)` 直接减少 debt

它有两个入口：

- `liquidate(...)`
  - 供手工、测试、应急、blocks-only 上游编排使用
- `liquidateFromSettlementManager(...)`
  - 只允许 `SettlementManager` 调用
  - 用来保留 legacy keeper 地址，让 liquidator attribution 与 liquidatorShare 正确落在 keeper 身上

> 重要：`bonus` 目前只是观测字段，不参与账本计算。

## LiquidatorView 与 DataPush

### 单点原则

当前代码明确把 `LiquidatorView` 作为 liquidation update / payout 的单点 push surface：

- `pushLiquidationUpdate(...)`
- `pushBatchLiquidationUpdate(...)`
- `pushLiquidationPayout(...)`

### writer gate

- liquidation update：只允许 `LIQUIDATION_MANAGER` 或 `SETTLEMENT_MANAGER`
- payout push：还额外允许 `LIQUIDATION_PAYOUT_MANAGER`

### 观测语义

- 它只是观测面，不是账本 SSOT
- push payload 里 `bonus`、`share` 等字段保留 writer 原始 token-native 单位
- 不能把 `LiquidatorView` 成功与否当成清算账本成功与否的判断条件

## 当前实现下的几个容易误判的点

1. **SettlementManager 不会直接打 Reward 惩罚**
  - 当前 `settleOrLiquidate(orderId)` 的清算路径不直接调用 Reward 模块
  - Reward 清算惩罚要通过保证金 / GuaranteeFund 相关路径单独触发

2. **legacy 与 blocks-only 的 keeper 入口不同**
  - legacy / 通用订单：`SettlementManager.settleOrLiquidate(orderId)`
  - blocks-only：`BlocksOnlyCoordinator.settleOrLiquidateBlocks(orderId)`

3. **full repay 判定不能只看本地累计还款**
  - 通用订单看 `ORDER_ENGINE.getOrderTotalDueForView(orderId)`
  - blocks-only 看 `VaultLendingEngine.getDebt(...)`

4. **collateral 选择不能混比 valuation 和 raw balance**
  - 一旦存在可用 valuation，只能在 valued candidates 里挑 winner

5. **清算 view push 是 best-effort**
  - 无论是 `LiquidationManager` 主路径，还是 `SettlementManager` fallback 路径，push 失败都不应回滚已经成功的账本写入

## 资金链与分账口径（仅引用）

清算相关的托管者、资产去向、平台 / 准备金 / lender compensation / liquidator 分账口径，统一以 Funds-Flow SSOT 为准：[`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](../Funds-Flow-Architecture-Guide.md)。

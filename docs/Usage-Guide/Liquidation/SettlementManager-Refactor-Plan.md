# SettlementManager 现状与收敛说明

## 概述

这份文档不再把 SettlementManager 当作“待实施的重构计划”，而是直接说明当前已经落地的状态。现在的正确口径是：

- `SettlementManager` 已经是 legacy / 通用订单的统一结算与清算入口
- `BlocksOnlyCoordinator` 仍是 blocks-only 产品线的独立入口
- `LiquidationManager` 是共享执行器，不是对外唯一 orchestrator
- 资金链、托管者、资产去向与分账顺序仍以 Funds-Flow SSOT 为准

## 当前已经落地的内容

以下事项在当前代码中已经完成，不应再写成 future work：

1. `KEY_SETTLEMENT_MANAGER` 已定义并接入 Registry。
2. `SettlementManager` 已提供 `repayAndSettle(...)` 与 `settleOrLiquidate(...)`。
3. `VaultCore.repay(...)` 已切到 `SettlementManager.repayAndSettle(...)`。
4. legacy / 通用订单的 keeper 入口已收敛到 `SettlementManager.settleOrLiquidate(orderId)`。

这意味着“新增 SettlementManager”“把 repay 改接 SettlementManager”“新增 registry key”都不再是计划项，而是已完成现状。

## 当前模块边界

### SettlementManager

负责：

- legacy / 通用订单的还款结算编排
- 到期或风险触发后的 settle-or-liquidate 分支选择
- 在需要时调用 shared liquidation 执行路径

它是 orchestrator，不是所有细节的最终账本承载者。

### BlocksOnlyCoordinator

负责 blocks-only 产品线的：

- finalize
- repay
- settle-or-liquidate

它不应被文档误写成 SettlementManager 的一个内部别名，也不应把 blocks-only keeper 路径并入 legacy 入口描述里。

### LiquidationManager

负责 direct-ledger liquidation 执行。

当前语义是“共享执行器”，不是“所有产品线都必须直接调用的唯一 public liquidation 入口”。

### LiquidatorView

负责 liquidation 相关只读聚合与 best-effort DataPush。它不是账本 SSOT，也不应承担主清算成功与否的决定权。

## 当前入口口径

### 用户还款

legacy / 通用订单：

- `VaultCore.repay(...)`
- 内部编排到 `SettlementManager.repayAndSettle(...)`

### keeper 触发处置

legacy / 通用订单：

- `SettlementManager.settleOrLiquidate(orderId)`

blocks-only：

- `BlocksOnlyCoordinator.settleOrLiquidateBlocks(orderId)`

这两个入口并存，是当前架构的设计结果，不是文档遗漏。

## 订单状态判断边界

SettlementManager 不应在本地复制一套“是否 fully repaid”的业务公式。当前更稳妥的口径仍然是：

- 订单级应还金额与完成状态，应继续收敛在 OrderEngine / LendingEngine 提供的权威查询上
- Settlement/guarantee 侧不要自行扩散同一套公式的副本

否则未来 total due 公式演进时，SettlementManager 与 guarantee 分支会先发生语义漂移。

## 与收款地址控制的关系

旧版本文档把 recipient whitelist 计划揉进了 SettlementManager 收敛说明里，这会制造误解。当前更准确的表述应该是：

- borrower collateral release 由结算路径直接释放给 borrower
- 固定 payout recipients 由 `LiquidationPayoutManager` 配置
- liquidator recipient 由实际调用路径决定

并不存在一个已经完成落地的、由 SettlementManager 统一托管的独立 recipient whitelist 子系统。

## 当前还值得跟进的事项

当前剩余工作重点，不再是“做不做 SettlementManager 收敛”，而是以下几类清理：

1. runbook、脚本和文档中移除“未来计划式”表述。
2. 继续统一链下观测口径，尤其是 legacy 与 blocks-only 的入口差异。
3. 保持 `LiquidationPayoutManager`、Reward penalty、threshold 读取等周边文档与当前实现同步。
4. 在后续公式演进中，继续避免把应还金额判断逻辑复制到多个模块。

## 验收关注点

如果要验证当前 SettlementManager 收敛是否成立，应关注这些事实：

1. 用户 repay 是否经由 SettlementManager 进入结算分支。
2. keeper 对 legacy / 通用订单的处置是否经由 `settleOrLiquidate(orderId)`。
3. blocks-only 是否仍然走 `BlocksOnlyCoordinator` 独立路径。
4. liquidation 写入成功后，DataPush 是否仍由 `LiquidatorView` best-effort 触发。
5. Reward penalty 是否仍然是 guarantee/default 之后的副作用，而不是 SettlementManager 主路径硬依赖。

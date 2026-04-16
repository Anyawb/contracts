# LiquidationCollateralManager 优雅降级报告（归档说明）

## 归档结论

`LiquidationCollateralManager` 已经不是当前清算实现里的活跃模块。把“优雅降级”继续写成它的运行时职责，会误导读者去找一个现在并不承担主路径责任的模块。

当前正确口径是：

- collateral 扣押与 debt reduce 的主写路径已经收敛到 `SettlementManager` / `BlocksOnlyCoordinator` 调度下的现有账本模块
- 估值降级不在旧的 `LiquidationCollateralManager` 中执行
- 只读估值和清算预览相关的 best-effort 行为，分散在 `VaultLendingEngine`、`SettlementManager`、`BlocksOnlyCoordinator` 与 `LiquidatorView` 的当前实现里

## 当前实现中“优雅降级”真正发生在哪里

### 1. 风险判断阶段

`LiquidationRiskManager.isLiquidatable(user)` 依赖 `HealthView` 缓存：

- 如果缓存有效，则按 `healthFactor < liquidationThreshold` 判断
- 如果缓存无效，则直接返回 `false`

这是一种当前仍在使用的保守降级语义。

### 2. collateral 候选选择阶段

无论是 `SettlementManager` 还是 `BlocksOnlyCoordinator`，当前都遵循“优先使用估值成功的 collateral 候选”这一思路：

- 能拿到 valuation 的资产优先进入选择
- valuation 失败或返回 0 的资产，不应被当作可靠的估值依据

这部分不是旧 `LiquidationCollateralManager` 的职责，而是当前清算编排路径的职责。

### 3. payout / DataPush 阶段

`LiquidatorView` 当前承担的是 liquidation 的只读聚合与 best-effort 推送职责：

- 可以做估值辅助
- 可以为链下提供统一 push 口径
- 但不是账本写入 SSOT

因此，它的失败或降级也不应回滚主账本写路径。

## 不应再保留的旧口径

以下说法如果还出现在其他文档里，应视为过时：

1. “LiquidationCollateralManager 负责当前清算估值降级”。
2. “CollateralManager 内部有一套独立的 graceful degradation 事件与策略”。
3. “清算写入先经过 LiquidationCollateralManager 再进入账本”。

这些说法都不符合当前代码。

## 当前应如何理解模块边界

- `SettlementManager`：legacy / 通用订单的清算编排与入口。
- `BlocksOnlyCoordinator`：blocks-only 产品线的到期收尾编排（trade-close / maturity delivery）。
- `LiquidationManager`：共享 direct-ledger 清算执行器。
- `VaultLendingEngine`：估值和 debt 相关核心能力的承载者之一。
- `LiquidatorView`：只读聚合与 best-effort DataPush。

旧的 `LiquidationCollateralManager` 只应被视为历史设计痕迹，而不是现行 runbook 或测试入口。

## 对运维与文档维护的建议

1. 后续 runbook 不要再把 `LiquidationCollateralManager` 当成排查入口。
2. 如需分析“为什么这次 liquidation 没放行”，应先看 `HealthView` 缓存有效性和当前估值结果，而不是寻找旧模块的降级开关。
3. 如需分析“为什么分账或 push 缺失”，应分别检查主账本写入与 `LiquidatorView` 的 best-effort 推送，而不是把两者混成一个模块职责。

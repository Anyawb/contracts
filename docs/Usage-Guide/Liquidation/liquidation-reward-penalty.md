# 清算 Reward 惩罚口径（与当前实现对齐）

## 概述

本文只说明 Reward 与 liquidation/default 的边界，不复述清算资金链。当前代码中的核心事实只有三条：

1. 清算或 default 的资金处置完成后，`GuaranteeFundManager` 会 best-effort 调用 `RewardManager.applyLiquidationPenalty(user)`。
2. `SettlementManager` 不直接写 Reward 惩罚；它只负责把业务流程推进到 guarantee/default 结果已经确定的阶段。
3. 欠分账本与抵扣口径由 `RewardAccrualManager` 统一维护，Reward 惩罚失败不会回滚资金链。

## 当前调用链

默认接线路径是：

- `EarlyRepaymentGuaranteeManager.processDefault(...)`
- `GuaranteeFundManager.forfeitPartialWithRewardPenalty(...)`
- `GuaranteeFundManager._tryApplyLiquidationRewardPenalty(...)`
- `RewardManager.applyLiquidationPenalty(user)`

这条链路表达的是“先完成 guarantee/default 资金结果，再附加 Reward 惩罚”。Reward 不是保证金托管或清算分账的 SSOT。

## Reward 侧当前口径

- 处罚单位是 Easy，而不是 guarantee asset amount。
- 当前处罚值按 `lockedEasy[user] * liquidationPenaltyBps / 10000` 计算。
- `liquidationPenaltyBps` 默认值是 500，也就是 5%。
- `RewardManager.applyLiquidationPenalty(user)` 只允许 `Registry[KEY_GUARANTEE_FUND]` 调用。
- 处罚实际落账由 `RewardManagerCore` 和 `RewardAccrualManager` 完成。
- 如果可扣 Easy 不足，剩余部分进入 pending penalty debt，后续 Reward 入账时优先抵扣。

## 为什么 SettlementManager 不直接调用 Reward

这是当前架构里一个很重要的边界：

- `SettlementManager` 负责 legacy / 通用订单的结算与清算编排。
- `GuaranteeFundManager` 负责 guarantee fund 的托管与没收。
- Reward 惩罚是“结果已经确定后的副作用”，不应该阻断资金落账。

因此，Reward penalty 被放在 `GuaranteeFundManager` 里做 best-effort 触发，而不是放进 SettlementManager 的主路径里做强一致依赖。

## 失败语义

`GuaranteeFundManager._tryApplyLiquidationRewardPenalty(...)` 使用 try/catch：

- 如果 RewardManager 地址缺失或不可用，会发出 `RewardLiquidationPenaltyApplyFailed`
- 如果 Reward 调用成功且处罚值大于 0，会发出 `RewardLiquidationPenaltyApplied`
- 如果 Reward 调用 revert，也只记录失败事件，不回滚 guarantee forfeiture

这意味着链下运维和索引侧必须把 Reward penalty 视为“可补偿、可告警、非阻断”的后处理步骤。

## 查询口径

如果链下需要查看用户是否存在待抵扣欠分，可以读取 RewardView：

```solidity
(uint256 totalBurned, uint256 pendingPenalty, uint8 level, uint256 lastActivity, uint256 blockNumber, bool isValid) =
    rewardView.getUserRewardSummaryWithMeta(user);
```

其中 `pendingPenalty` 是当前 RewardView 聚合出来的欠分字段。

如果需要预估本次清算会罚多少 Easy，应优先读取：

```solidity
uint256 easyAmount = rewardManager.quoteLiquidationPenalty(user);
```

## 与清算主流程的边界

以下内容不属于本文档的定义范围：

1. collateral 如何扣押和分配。
2. debt 如何 reduce / settle。
3. liquidation payout 的 platform / reserve / lender / liquidator 分账。
4. keeper 入口和执行顺序。

这些都属于 liquidation 资金链与编排语义，应以 Funds-Flow SSOT、SettlementManager、BlocksOnlyCoordinator 和 LiquidationManager 的文档为准。

## 当前实现下的集成建议

1. 如果你在做 keeper 或链下流程，不要假设 Reward penalty 成功是清算成功的前置条件。
2. 如果你在做对账，应同时监听 guarantee forfeiture 与 `RewardLiquidationPenaltyApplied/Failed`。
3. 如果你在扩展 Reward 入账路径，要确保新增路径也会走 `RewardAccrualManager.offsetPenaltyOnReward(...)`，否则 pending penalty 口径会失真。
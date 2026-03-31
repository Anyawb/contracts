# Reward 最佳实践指南（目标态：单通证 EasyToken）

> 适用范围：本仓库当前 Reward/Easy 模块（RewardManager/RewardManagerCore/RewardConfig/EarnConfig/RewardView + EasyConsumption/EasyRecycleDistributor/EasyEmission*）。
>
> 本指南只描述“当前存在且应长期维护”的主路径：Reward 域以 `EasyToken` 为唯一资产口径；消费按次扣费走 `EasyConsumption`；不包含任何服务价格体系、时长权益、升级或资产转换等机制。

---

## 1) SSOT（Single Source of Truth）

- 资产 SSOT：`Registry[KEY_EASY_TOKEN]` 指向的 `EasyToken`（18 decimals）。
- 模块地址 SSOT：统一从 `Registry[KEY_*]` 解析。
- 配置写入口 SSOT：`RewardConfig`（写入 `EarnConfig` / `FeatureRegistry` / `GovernanceGate`）。
- 只读与链下订阅 SSOT：统一从 `RewardView` 读取与订阅 `RewardView.DataPushed(...)`；当前实现会产出 `DATA_TYPE_REWARD_*` 与 `DATA_TYPE_EASY_*` 两组类型，链下不要只过滤 `REWARD_*`。
- 观测失败留痕：`RewardView.DataPushed` 属于统一观测入口，但主链路中的 push 仍是 best-effort；监控与排障不能只盯 `DataPushed`，还必须同时关注 `RewardViewPushFailed` 一类失败留痕。

---

## 2) Earn（发放）主路径

- 触发点：在订单落账成功后，由 `OrderEngine` 调用 `RewardManager.onLoanEventByOrderWithLender(...)`。
- Caller gate：`RewardManager` 必须仅允许 `Registry[KEY_ORDER_ENGINE]` 调用相关写入口。
- 核心结算：`RewardManagerCore` 负责订单维度的锁定/释放/扣罚等账本语义，并 best-effort 推送可观测性到 `RewardView`。
- 时间口径：所有窗口/到期/门槛判断使用 `block.number`（不使用 timestamp）。

---

## 3) Spend（消耗）主路径：按次 1 Easy

- 入口：
  - `EasyConsumption.consumeEasiMCall(user)`
  - `EasyConsumption.consumeStrategyApiCall(user)`
- 扣费单位：每次固定扣 `1e18` Easy。
- 分配比例：75/15/10（销毁/团队/生态）。
- 异常恢复：若 recycle 合约误收到直接转入的 Easy，只能通过 `EasyRecycleDistributor.settleOutstandingEasyBalance()` 走同一 75/15/10 结算，不允许旁路 burn/手工转账。

---

## 4) Penalty 边界与清算对接

- 逾期扣罚与清算扣罚都属于 Reward 域账本语义，不能改变资金链 SSOT。
- 清算场景下，`GuaranteeFundManager` 只能作为触发方调用 `RewardManager.applyLiquidationPenalty(user)`；Easy 扣罚数量必须由 `RewardManagerCore` 按 `lockedEasy[user] * liquidationPenaltyBps / 10000` 自行计算。
- 不要把保证金币种金额、抵押品金额、债务金额直接映射成 Easy 扣罚值；跨域金额换算会破坏 Reward 单位语义。
- `applyLiquidationPenalty` 是 best-effort 集成点：Reward 失败不应回滚 default 资金结算，但必须保留可观测事件并由链下告警。
- 所有 penalty 最终都应统一落到 `RewardAccrualManager`，确保 burn 与 `pendingPenalty` 欠分账本口径一致。

---

## 5) 治理与功能门控

- Feature 开关与门槛：用 `FeatureRegistry` 表达“是否启用/最低等级/元数据”。
- 治理参与门控：用 `GovernanceGate` 表达“是否允许 propose/vote”（等级 + `IVotes` 快照阈值）。
- ServiceLevel（治理/功能门控）通过 `RewardConfig` 的显式治理动作写入。
- Reward Level（1-5，借贷/Earn 等级）当前由 `RewardManagerCore` 基于 `LoanFlowView` 的 USD-8 借款量、合格借款数、按期还款数自动升级；治理侧仍可通过 `RewardManager.updateUserLevel` 做显式覆写。

---

## 6) 工程约束与验收（建议 PR 必跑）

- `pnpm -s run compile`
- `pnpm -s run checks:reward-monitor:config-events`
- `pnpm -s run checks:reward-monitor:breakglass`
- `pnpm -s run checks:reward-monitor:registry-bindings`
- `pnpm -s run checks:reward-monitor:role-bindings`
- `pnpm exec hardhat test test/Reward/EasyEconomics.integration.test.ts`

- 约束要点：
  - 前端/链下读取统一走 `RewardView`，写模块不提供面向外部的查询 API。
  - 链下解码 `RewardView.DataPushed` 时，同一笔 tx 内若出现多条同类型 push，必须以最后一条作为最终状态，不要把第一条中间态当成最终结果。
  - 所有消费必须通过 `EasyConsumption` → `EasyRecycleDistributor`，确保 75/15/10 口径不被绕开。
  - `RewardManagerCore` 只能经 `RewardManager` 进入；任何直接写调用都应显式 revert，不允许 no-op 兼容。
  - `RewardManagerCore` 不持有 `BURNER_ROLE`；Penalty burn 与欠账 SSOT 固定为 `RewardAccrualManager`。
  - 奖励累计展示优先使用 `getUserEasyEarnedWithMeta(user)`；`getUserRewardSummaryWithMeta(user)` 仅用于 burned / penalty / level 摘要。
  - 避免在 Reward 域引入任何“价格/时长/升级/资产转换”的二级状态机与配置来源。

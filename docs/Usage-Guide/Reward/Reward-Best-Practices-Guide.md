# Reward 最佳实践指南（目标态：单通证 EasyToken）

> 适用范围：本仓库当前 Reward/Easy 模块（RewardManager/RewardManagerCore/RewardConfig/EarnConfig/RewardView + EasyConsumption/EasyRecycleDistributor/EasyEmission*）。
>
> 本指南只描述“当前存在且应长期维护”的主路径：Reward 域以 `EasyToken` 为唯一资产口径；消费按次扣费走 `EasyConsumption`；不包含任何服务价格体系、时长权益、升级或资产转换等机制。

---

## 1) SSOT（Single Source of Truth）

- 资产 SSOT：`Registry[KEY_EASY_TOKEN]` 指向的 `EasyToken`（18 decimals）。
- 模块地址 SSOT：统一从 `Registry[KEY_*]` 解析。
- 配置写入口 SSOT：`RewardConfig`（写入 `EarnConfig` / `FeatureRegistry` / `GovernanceGate`）。
- 只读与链下订阅 SSOT：统一从 `RewardView` 读取与订阅 `RewardView.DataPushed(DATA_TYPE_REWARD_*)`。

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
- 资金流：用户转入 `EasyRecycleDistributor`，由其执行 75/15/10（销毁/团队/生态）分配。

---

## 4) 治理与功能门控

- Feature 开关与门槛：用 `FeatureRegistry` 表达“是否启用/最低等级/元数据”。
- 治理参与门控：用 `GovernanceGate` 表达“是否允许 propose/vote”（等级 + `IVotes` 快照阈值）。
- 用户等级写入：通过 `RewardConfig` 的显式治理动作写入（不依赖任何“购买/时长/自动到期”的权益模型）。

---

## 5) 工程约束与验收（建议 PR 必跑）

- `pnpm -s run compile`
- `pnpm -s run checks:reward-monitor:config-events`
- `pnpm -s run checks:reward-monitor:breakglass`
- `pnpm -s run checks:reward-monitor:registry-bindings`

- 约束要点：
  - 前端/链下读取统一走 `RewardView`，写模块不提供面向外部的查询 API。
  - 所有消费必须通过 `EasyConsumption` → `EasyRecycleDistributor`，确保 75/15/10 口径不被绕开。
  - 避免在 Reward 域引入任何“价格/时长/升级/资产转换”的二级状态机与配置来源。

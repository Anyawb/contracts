# 清算积分惩罚与奖励口径（与当前实现对齐）

## 🔗 References（口径来源与关联文档）

- **Architecture**: [`docs/Architecture-Guide.md`](../../Architecture-Guide.md)
- **资金链 SSOT（托管者/资产去向/内部调用串联）**: [`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](../Funds-Flow-Architecture-Guide.md)
- **Terminology**: [`docs/Architecture-Liquidation-DirectLedger-Terminology.md`](../../Architecture-Liquidation-DirectLedger-Terminology.md)
- **Related**
  - 清算机制（职责边界版）：[`Liquidation-Mechanism-Logic.md`](./Liquidation-Mechanism-Logic.md)
  - 清算端到端职责对齐：[`liquidation-complete-logic.md`](./liquidation-complete-logic.md)

## 📋 概述

本文档只讨论“积分惩罚/奖励（Reward）”在清算场景下的现行口径与集成边界，明确以下三点：

1) **当前实现已在 default 保证金没收完成后，由 `GuaranteeFundManager` 默认接线触发 Reward 清算惩罚**；该调用是 best-effort，不影响资金链账本落账。
2) Reward 主线写入口仍由借/还等订单事件在落账后触发（例如 `RewardManager.onLoanEventByOrder*`）；清算场景新增的是 GFM 专用 penalty 入口，而不是复用订单事件入口。
3) **欠分账本 SSOT 已迁移到 `RewardAccrualManager`**，所有“惩罚扣减/欠分抵扣”均由其统一执行。

> 术语说明（避免误解）：本文所称“积分”在资产语义上等同于奖励通证 / EasyToken（SSOT = `Registry[KEY_EASY_TOKEN]`）。

> 约束：本文不描述任何清算资金链、托管者、资产去向、分配比例或清算内部调用顺序；上述内容统一以 Funds-Flow SSOT 为准。

## ✅ 当前实现口径（Reward 侧）

- 清算结果的资金链/对账口径属于 Funds-Flow SSOT 范畴；Reward 侧不参与清算资产结算。
- Reward 系统负责在“借/还”等业务事件后，根据事件类型做积分增减或状态更新；清算惩罚通过独立的 GFM 专用入口接线。
- 当前默认接线路径：`EarlyRepaymentGuaranteeManager.processDefault` → `GuaranteeFundManager.forfeitPartialWithRewardPenalty` → `RewardManager.applyLiquidationPenalty(user)`。
- 清算惩罚写入口已存在：
    - `RewardManager.quoteLiquidationPenalty(user)`：按当前 `lockedEasy[user]` 与 `liquidationPenaltyBps` 预估将要处罚的 Easy 数量。
    - `RewardManager.applyLiquidationPenalty(user)`（**仅允许 `Registry[KEY_GUARANTEE_FUND]` 调用**，内部转调 `RewardManagerCore.applyLiquidationPenaltyByCurrentLock`）。
- 当前计量口径：`liquidationPenaltyEasy = lockedEasy[user] * liquidationPenaltyBps / 10000`，默认 `liquidationPenaltyBps = 500`。
- 重要边界：GFM 不传“保证金币种金额”给 Reward 作为罚分值；Reward 单位只能由 Reward 域内部按 Easy 口径计算。
- 欠分抵扣已统一为“所有 Reward 入账”，由 `RewardAccrualManager.offsetPenaltyOnReward` 在入账前执行（目前由 `RewardManagerCore` 解锁路径与 `EasyEmissionController` 铸币路径触发）。

## 🧩 现行实现：清算惩罚（Penalty）

当前产品口径已经收敛为以下约束：

- **触发时机**：default / liquidation 结果已经确定、保证金没收已成功之后。
- **触发方**：`GuaranteeFundManager`，用于表达“资金链已完成，Reward 跟随处罚”。
- **输入**：仅输入 `user`；不从资金链携带任何 guarantee asset amount。
- **输出**：对用户 Easy 执行扣减；若余额不足，记入“欠分账本”，并在后续 Reward 入账时优先抵扣。
- **失败语义**：Reward 调用失败不回滚保证金没收，链下需根据 GFM 事件进行补偿/告警。

### 接口口径（与当前实现对应）

```solidity
function quoteLiquidationPenalty(address user) external view returns (uint256 easyAmount) {
    return rewardManagerCore.quoteLiquidationPenalty(user);
}

function applyLiquidationPenalty(address user) external {
    // 仅允许 Registry[KEY_GUARANTEE_FUND] 调用
    _requireOnlyGuaranteeFund();
    rewardManagerCore.applyLiquidationPenaltyByCurrentLock(user, msg.sender);
}
```

```solidity
function applyLiquidationPenaltyByCurrentLock(address user, address executor)
    external
    returns (uint256 easyAmount)
{
    _requireOnlyRewardManager();
    easyAmount = quoteLiquidationPenalty(user);
    rewardAccrualManager.applyPenaltyFromGateway(user, easyAmount, executor);
}
```

```solidity
// 口径对齐当前实现：所有 Reward 入账前统一抵扣欠分
function offsetPenaltyOnReward(address user, uint256 newlyEarned) internal returns (uint256 netEarned) {
    return rewardAccrualManager.offsetPenaltyOnReward(user, newlyEarned, "PenaltyOffsetOnReward");
}
```

## 🔎 查询与对接

- 查询用户欠分：RewardView summary 的 meta 字段（例如 `pendingPenalty`）可作为聚合口径。

```solidity
// pendingPenalty 即“欠分账本”的可视化聚合字段（示例）
(,, uint256 pendingPenalty,,,,) = rewardView.getUserRewardSummaryWithMeta(user);
```

- 清算侧集成：当前实现由 **GuaranteeFundManager（Registry[KEY_GUARANTEE_FUND]）** 在“清算结果已确定”后调用 `RewardManager.applyLiquidationPenalty(user)`。
    - 清算资金链/托管/内部顺序仍以 Funds-Flow SSOT 为准；Reward 仅消费“结果已确定”这一事实，不定义清算过程。
    - 若链下需要预估罚分，可先读取 `RewardManager.quoteLiquidationPenalty(user)` 或 `RewardView` 中的锁定积分聚合数据。

## 🔖 Reason 口径（链下索引/对账建议）

- `LiquidationPenaltyByGFM`：清算惩罚（由 GFM 触发）
- `LateRepayPenalty`：逾期足额还款惩罚
- `PenaltyOffsetOnUnlock`：按期足额还款释放锁定积分时的欠分抵扣
- `PenaltyOffsetOnReward`：其他 Reward 入账时的欠分抵扣（例如 EasyEmissionController 铸币路径）

## 🛠️ 可选改进（如需进一步降低误解/提升可观测性）

- **入口语义更明确**：当前已采用清算域专用入口 `applyLiquidationPenalty`；若未来再拆更多 penalty 类型，应继续保持“一个业务语义对应一个入口”。
- **惩罚来源区分**：将“逾期扣罚”和“清算扣罚”的 reason/actionKey 做区分，方便链上追踪和运营统计。
- **欠分抵扣范围可扩展**：当前已覆盖“所有 Reward 入账”抵扣；如需新增新的奖励入账路径，需确保调用 `RewardAccrualManager.offsetPenaltyOnReward`。
- **失败补偿能力**：如果需要更强的运维可追踪性，可为 penaltyLedger 的 DataPush 追加 ops-only 的 retry 接口。
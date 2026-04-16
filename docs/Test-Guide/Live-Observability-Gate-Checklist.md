# Live Observability Gate 清单

> 本文档专门回答一个问题：当前哪些 live 脚本必须继续对事件 / DataPush 硬失败，以及为什么这些脚本不能按 runtime-first 降成 notice。

> blocks-only 术语与状态映射词典统一以 [pre-launch-comprehensive-testing-requirements.md](pre-launch-comprehensive-testing-requirements.md) 第 5 章 Gate 9 的“词典约束（blocks-only）”为准。

---

## 1. 文档目的

在当前仓库里，live 脚本已经分成两类：

1. `runtime-first` 业务脚本
2. `observability gate` 观测脚本

前者的目标是验证账本、仓位、清算、结算等链上 runtime 是否正确，因此事件缺失通常只能记为 notice。

后者的目标不是“业务有没有执行”，而是“链下统一消费入口是否仍然完整可用”。这类脚本如果发现事件或 `DataPushed` 缺失，必须继续 hard fail，因为：

1. 后端索引器、投影表、活动流、重放队列本来就是靠这些事件驱动。
2. 单看 runtime 成功，不能证明链下消费入口没有断。
3. 一旦把这类脚本降成 notice，release gate 会把“链上成功但链下失明”的故障误判成绿色。

---

## 2. 判定规则

某个 live 脚本应继续保持 strict observability gate，至少要满足下面任一条件：

1. 脚本目标本身就是验证事件总线 / `DataPushed` / retry / replay / 对账输入是否完整。
2. 脚本在 release gate 中承担“链下建表、索引、活动流、审计证据是否可复原”的职责，而不是只看链上最终状态。
3. 脚本验证的是显式 push-path writer，例如 `RewardView.retryPushPenaltyLedger`、`FeeRouter.setDynamicFee`、`GuaranteeFundManager` guarantee 事件对账，这些入口的价值就在于“有无正确发出事件”。

反过来，如果脚本主要验证的是：

1. 债务是否减少
2. 仓位是否关闭
3. 清算是否完成
4. blocks-only runtime 是否进入到期收尾（maturity closeout）/ 到期交付收尾（maturity delivery closeout），并可区分交易收尾（trade closeout）

那它就应该优先属于 `runtime-first`，不该再让 `DataPushed` 缺失直接盖掉业务成功结果。

---

## 3. 当前保留 Strict 的脚本族

> 说明：网络入口脚本通常只是共享脚本的薄包装。本文按“共享脚本族”列出，网络 wrapper 默认继承同一严格语义。

| 脚本族 | 网络入口 | 必须 strict 的观测对象 | 对应链下表 / 索引器输入 | 为什么不能降成 notice |
| --- | --- | --- | --- | --- |
| [scripts/tests/live-test/configure-dynamic-fee.ts](../../scripts/tests/live-test/configure-dynamic-fee.ts) | [scripts/tests/live-test/networks/arbitrum-sepolia/configure-dynamic-fee.ts](../../scripts/tests/live-test/networks/arbitrum-sepolia/configure-dynamic-fee.ts), [scripts/tests/live-test/networks/bnb-testnet/configure-dynamic-fee.ts](../../scripts/tests/live-test/networks/bnb-testnet/configure-dynamic-fee.ts) | `DYNAMIC_FEE_UPDATED` DataPushed | `chain_events` | 这个脚本不是在验 fee 数学结果，而是在验“治理写入后，动态费配置是否成功进入统一 DataPush 总线”。只看链上 `getDynamicFee(...)` 成功，不足以证明索引器、前端配置流、事件 decoder 仍然可用。 |
| [scripts/tests/live-test/live-fee-prepaid-gate.ts](../../scripts/tests/live-test/live-fee-prepaid-gate.ts) | [scripts/tests/live-test/networks/arbitrum-sepolia/live-fee-prepaid-gate.ts](../../scripts/tests/live-test/networks/arbitrum-sepolia/live-fee-prepaid-gate.ts), [scripts/tests/live-test/networks/bnb-testnet/live-fee-prepaid-gate.ts](../../scripts/tests/live-test/networks/bnb-testnet/live-fee-prepaid-gate.ts) | `FeeDistributed` 事件、`FEE_DISTRIBUTED` DataPushed、`FeeRouterView.USER_FEE` DataPushed | `chain_events`、`ledger_entries`、`fee_distributions` | prepaid gate 的目标是验证 FeeRouter 到 FeeRouterView 的完整 attribution 链。余额守恒只能说明钱分对了，不能说明后端费用明细表、用户费用镜像、活动流输入仍然完整。 |
| [scripts/tests/live-test/live-fee-remaining-gate.ts](../../scripts/tests/live-test/live-fee-remaining-gate.ts) | [scripts/tests/live-test/networks/arbitrum-sepolia/live-fee-remaining-gate.ts](../../scripts/tests/live-test/networks/arbitrum-sepolia/live-fee-remaining-gate.ts), [scripts/tests/live-test/networks/bnb-testnet/live-fee-remaining-gate.ts](../../scripts/tests/live-test/networks/bnb-testnet/live-fee-remaining-gate.ts) | `FeeDistributed` 事件、`FEE_DISTRIBUTED` DataPushed、`FeeRouterView.USER_FEE` DataPushed | `chain_events`、`ledger_entries`、`fee_distributions` | remaining gate 要证明 refund / feeType / user 归因都能被链下重建。若把事件缺失降成 notice，链下 fee ledger 断流会被误放行。 |
| [scripts/tests/live-test/live-fee-dynamic-gate.ts](../../scripts/tests/live-test/live-fee-dynamic-gate.ts) | [scripts/tests/live-test/networks/arbitrum-sepolia/live-fee-dynamic-gate.ts](../../scripts/tests/live-test/networks/arbitrum-sepolia/live-fee-dynamic-gate.ts), [scripts/tests/live-test/networks/bnb-testnet/live-fee-dynamic-gate.ts](../../scripts/tests/live-test/networks/bnb-testnet/live-fee-dynamic-gate.ts) | `DYNAMIC_FEE_UPDATED` DataPushed、`FEE_DISTRIBUTED` DataPushed、`FeeRouterView.USER_FEE` DataPushed | `chain_events`、`ledger_entries`、`fee_distributions` | dynamic gate 同时覆盖“配置写入观测”和“分发后镜像归因”。它本质上是 fee 域 observability 闸门，而不是纯资金脚本。 |
| [scripts/tests/live-test/live-guarantee-events-datapush.ts](../../scripts/tests/live-test/live-guarantee-events-datapush.ts) | [scripts/tests/live-test/live-guarantee-events-datapush-arbitrum-sepolia.ts](../../scripts/tests/live-test/live-guarantee-events-datapush-arbitrum-sepolia.ts), [scripts/tests/live-test/networks/arbitrum-sepolia/live-guarantee-events-datapush.ts](../../scripts/tests/live-test/networks/arbitrum-sepolia/live-guarantee-events-datapush.ts), [scripts/tests/live-test/networks/bnb-testnet/live-guarantee-events-datapush.ts](../../scripts/tests/live-test/networks/bnb-testnet/live-guarantee-events-datapush.ts) | `GuaranteeLocked/Released/Forfeited` 事件与对应 `GUARANTEE_*` DataPushed 的全量对账 | `chain_events`、`ledger_entries` | guarantee 这类链下事实表需要历史事件才能建表；只看“guarantee 最终归零”无法恢复 early repay / default 过程，更无法证明事件与 push 总量一致。这个脚本就是 guarantee 域对账闸门。 |
| [scripts/tests/live-test/live-reward-multi-borrower-stress.ts](../../scripts/tests/live-test/live-reward-multi-borrower-stress.ts) | [scripts/tests/live-test/networks/arbitrum-sepolia/live-reward-multi-borrower-stress.ts](../../scripts/tests/live-test/networks/arbitrum-sepolia/live-reward-multi-borrower-stress.ts), [scripts/tests/live-test/networks/bnb-testnet/live-reward-multi-borrower-stress.ts](../../scripts/tests/live-test/networks/bnb-testnet/live-reward-multi-borrower-stress.ts) | `RewardView.DataPushed(EASY_MINTED/EASY_SPENT/EASY_RECYCLED_SPLIT)` | `chain_events`、`ledger_entries`、`reward_user_cache` | 这个脚本不是只看 borrower 的 Easy 余额是否变化，而是在压测多借款人情况下 RewardView push-path 是否持续产出可解码事件。若降成 notice，会丢失 reward 索引流是否健康的证据。 |
| [scripts/tests/live-test/live-reward-penalty-recycle-recovery.ts](../../scripts/tests/live-test/live-reward-penalty-recycle-recovery.ts) | [scripts/tests/live-test/networks/arbitrum-sepolia/live-reward-penalty-recycle-recovery.ts](../../scripts/tests/live-test/networks/arbitrum-sepolia/live-reward-penalty-recycle-recovery.ts), [scripts/tests/live-test/networks/bnb-testnet/live-reward-penalty-recycle-recovery.ts](../../scripts/tests/live-test/networks/bnb-testnet/live-reward-penalty-recycle-recovery.ts) | `REWARD_PENALTY_LEDGER_UPDATED` 与 `EASY_RECYCLED_SPLIT` | `chain_events`、`reward_user_cache`、`cache_retry_queue` | 这两个分支验证的是显式 recovery / retry writer。入口价值本身就在于“能否正确重放 push”；如果事件不存在，这条恢复链路就等于坏了，不能用 runtime 正常来代替。 |
| [scripts/tests/live-test/live-platform-observability-evidence.ts](../../scripts/tests/live-test/live-platform-observability-evidence.ts) | [scripts/tests/live-test/networks/arbitrum-sepolia/live-platform-observability-evidence.ts](../../scripts/tests/live-test/networks/arbitrum-sepolia/live-platform-observability-evidence.ts), [scripts/tests/live-test/networks/bnb-testnet/live-platform-observability-evidence.ts](../../scripts/tests/live-test/networks/bnb-testnet/live-platform-observability-evidence.ts) | normal repay 与 guarantee-default 路径上的 RewardView / LiquidatorView / guarantee 事件证据 | `chain_events`、`ledger_entries`、`reward_user_cache`、`liquidation_records` | 该层专门回答“平台主流程在链下是否也能被完整重建”。它保留 strict，是为了给 release evidence 提供跨域事件总线证据。 |

---

## 4. 混合型脚本（当前仍保留部分 Strict 子断言）

以下脚本已经从原来的混合形态拆层，文档上单独说明它们的职责边界：

| 脚本族 | 网络入口 | 当前职责 | 说明 |
| --- | --- | --- | --- |
| [scripts/tests/live-test/live-platform-runtime-baseline.ts](../../scripts/tests/live-test/live-platform-runtime-baseline.ts) | [scripts/tests/live-test/networks/arbitrum-sepolia/live-platform-runtime-baseline.ts](../../scripts/tests/live-test/networks/arbitrum-sepolia/live-platform-runtime-baseline.ts), [scripts/tests/live-test/networks/bnb-testnet/live-platform-runtime-baseline.ts](../../scripts/tests/live-test/networks/bnb-testnet/live-platform-runtime-baseline.ts) | runtime-first | 只把 borrow / repay / guarantee-default / penalty state / debt 结果作为硬验收，事件缺失默认降为 notice。 |
| [scripts/tests/live-test/live-platform-observability-evidence.ts](../../scripts/tests/live-test/live-platform-observability-evidence.ts) | [scripts/tests/live-test/networks/arbitrum-sepolia/live-platform-observability-evidence.ts](../../scripts/tests/live-test/networks/arbitrum-sepolia/live-platform-observability-evidence.ts), [scripts/tests/live-test/networks/bnb-testnet/live-platform-observability-evidence.ts](../../scripts/tests/live-test/networks/bnb-testnet/live-platform-observability-evidence.ts) | strict observability gate | 专门保留跨 Reward / Guarantee / Liquidation 域的事件硬断言。 |
| [scripts/tests/live-test/live-platform-baseline.ts](../../scripts/tests/live-test/live-platform-baseline.ts) | [scripts/tests/live-test/networks/arbitrum-sepolia/live-platform-baseline.ts](../../scripts/tests/live-test/networks/arbitrum-sepolia/live-platform-baseline.ts), [scripts/tests/live-test/networks/bnb-testnet/live-platform-baseline.ts](../../scripts/tests/live-test/networks/bnb-testnet/live-platform-baseline.ts) | composite wrapper | 默认串行运行 `runtime` 和 `observability` 两层，作为完整平台基线入口。 |

---

## 5. Shared Helper 约束

当前有两个共享 helper 承担 strict 语义，它们的调用者默认继承 observability gate 口径：

1. [scripts/tests/live-test/_feeLiveUtils.ts](../../scripts/tests/live-test/_feeLiveUtils.ts)
   - `assertFeeDistributionReceiptAttribution(...)` 会严格要求 `FeeDistributed`、`FEE_DISTRIBUTED`、以及条件满足时的 `FeeRouterView.USER_FEE` push。
   - 只要脚本调用这个 helper，它就不再是“只看余额”的脚本，而是 fee 事件归因脚本。

2. [scripts/tests/live-test/_rewardLive.ts](../../scripts/tests/live-test/_rewardLive.ts)
   - `requireRewardViewPush(...)` 明确把“缺少 RewardView DataPushed(type)”视为失败。
   - 调用它的脚本，本质上就在验证 Reward push bus / replay bus，而不是单看 Reward runtime 状态。

---

## 6. 当前不在 Strict 清单中的脚本

以下脚本族当前不应被列为 strict observability gate：

1. `live-liquidation*.ts`
2. `live-liquidation-fallback.ts`
3. `live-batch-liquidation-pressure.ts`
4. `live-blocks-only-liquidation*.ts`
5. `live-fee-accounting.ts`

这些脚本当前已经按 runtime-first 或结果优先处理：

1. 主验收目标是债务、仓位、close 状态、余额守恒、清算后结果。
2. 事件与 DataPush 仍然会被记录和校验，但缺失默认不再盖掉业务成功结果。

---

## 7. 维护规则

后续新增或修改 live 脚本时，必须先在 PR 中回答这两个问题：

1. 这个脚本是在验证 runtime 成功，还是在验证链下事件入口是否健康？
2. 如果事件缺失但 runtime 正常，发布流程到底应该判绿还是判红？

只有答案明确是“判红”的脚本，才应该继续被加入本清单。
# Fork RewardView Penalty Replay 演示验证纪要

## 1. 验证目标

本纪要用于单独归档本次 fork 环境下 RewardView penalty replay 演示的输入、执行结果与结论，回答三个问题：

1. fork E2E 是否已经稳定产出可用于 replay 的失败证据。
2. replay 脚本是否能基于 artifact 正确识别候选并区分 dry-run / 实际执行。
3. 当主账本与 RewardView 镜像已经重新一致时，补偿脚本是否会安全地 no-op，而不是错误覆盖状态。

## 2. 验证环境

- 工作区：`/Volumes/AI-hosts/contracts`
- 运行网络：fork localhost，RPC `http://127.0.0.1:18545`
- 运行链 ID：`421614`
- replay 模式：artifact-driven
- 相关链上补偿入口：`RewardView.retryPushPenaltyLedger(user, pendingDebt, blockNumber)`

说明：本次验证刻意采用 artifact-driven，而不是依赖宽窗口 `eth_getLogs`。原因是共享 fork RPC 在回放阶段存在日志窗口限制、节点状态漂移与偶发缺块问题；artifact 已保存 replay 所需的 `user`、`blockNumber` 与失败载荷，更适合作为稳定演示输入。

## 3. 输入证据

### 3.1 源 artifact

本次 replay 演示直接使用下列 fork E2E 产物作为输入：

- `scripts/e2e/artifacts/rewardview-acceptance.1773553569314.json`

该 artifact 中记录的关键字段如下：

- `rewardExtendedChecks.missingRewardViewBestEffort.afterCacheRollover.txHash`
  - `0xfe02895065479e76369435929bf96067fa89225ed6b8bd0915ce6aaeb28741e2`
- `user`
  - `0x7120122BdF2b35fC3f79fe8d89576b5458C9b4eA`
- `blockNumber`
  - `249409196`
- `penaltyDebtAfter`
  - `15`
- `rewardViewPushFailedCount`
  - `1`
- `lastFailureReason`
  - `0x7265776172645669657720756e617661696c61626c65`
  - 可解读为 `rewardView unavailable`

这说明 fork E2E 已经完整覆盖到“主流程已成功推进，但 RewardView penalty ledger 推送在 best-effort 路径失败”的目标场景，且 artifact 已具备 replay 所需最小输入。

### 3.2 执行命令

先执行 dry-run：

```bash
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
REWARDVIEW_REPLAY_DRY_RUN=1 \
REWARDVIEW_REPLAY_ARTIFACT=scripts/e2e/artifacts/rewardview-acceptance.1773553569314.json \
pnpm -s run e2e:rewardview-penalty-replay
```

再执行一次实际 replay：

```bash
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
REWARDVIEW_REPLAY_ARTIFACT=scripts/e2e/artifacts/rewardview-acceptance.1773553569314.json \
pnpm -s run e2e:rewardview-penalty-replay
```

## 4. 输出结果

### 4.1 Dry-run 报告

产物：

- `scripts/e2e/artifacts/rewardview-penalty-replay.1773553774288.json`

关键结果：

- `dryRun = true`
- `candidates = 1`
- 候选来源：artifact
- 候选执行结果：
  - `replayed = false`
  - `skippedReason = "already-aligned"`
  - `authoritativePenalty = "0"`
  - `mirroredPenaltyBefore = "0"`
  - `payloadPenalty = "15"`

解释：脚本正确识别出 1 个可审查候选，但在真正写链前发现主账本 penalty 与 RewardView 镜像 penalty 已经一致，因此没有执行写入。

### 4.2 实际 replay 报告

产物：

- `scripts/e2e/artifacts/rewardview-penalty-replay.1773553778405.json`

关键结果：

- `dryRun = false`
- `candidates = 1`
- 候选来源：artifact
- 候选执行结果：
  - `replayed = false`
  - `skippedReason = "already-aligned"`
  - `authoritativePenalty = "0"`
  - `mirroredPenaltyBefore = "0"`
  - `payloadPenalty = "15"`

解释：真实执行阶段与 dry-run 的判断完全一致，没有因为切换到“可写模式”而错误触发补偿覆盖，这证明 replay 工具在 no-op 判定上具备幂等保护。

## 5. 验证结论

### 5.1 已验证通过的点

1. fork E2E 已能稳定产出 replay-ready 的 RewardView penalty failure artifact。
2. replay 脚本已能直接从 artifact 提取 `user + blockNumber + payloadPenalty`，不依赖宽范围日志扫描。
3. replay 脚本 dry-run 与实际执行对同一输入得到一致判断，说明判定逻辑稳定。
4. 当主账本与镜像已对齐时，脚本会返回 `already-aligned` 并安全跳过，不会把旧 payload 强写回去。
5. 本次演示验证了“补偿工具可安全执行”的运维目标，即便最终结果是 no-op，也能证明工具没有误写链上状态。

### 5.2 本次没有覆盖到的点

1. 本次没有观测到 `replayed = true` 的真实补偿写入样本。
2. 因为共享 fork 节点会随时间推进或漂移，导致在 replay 时刻该候选已经恢复为对齐状态，所以最终落在了合法 no-op 分支。

这不构成失败，但意味着本次纪要证明的是“识别正确、跳过正确、不会误写”，而不是“链上确实完成了一次补偿写入”。

## 6. 风险与口径

- `already-aligned` 应被视为成功的安全结果，而不是补偿失败。
- `payloadPenalty = 15` 但 `authoritativePenalty = 0` / `mirroredPenaltyBefore = 0`，说明 artifact 中的失败载荷来自更早时刻；脚本没有盲信旧载荷，而是优先相信 replay 当下的真实链上账本状态。
- 这正是补偿脚本必须存在的保护：如果直接把旧 payload 重放回链上，会有覆盖新状态的风险。

## 7. 审计视角下的最终结论

从“输入完整性、候选识别、dry-run/实跑一致性、链上安全性”四个维度看，本次 fork replay 演示已完成预期验证：

- 输入完整：artifact 已携带 replay 所需关键信息。
- 输出可解释：dry-run 与实跑都明确产出 `already-aligned`。
- 行为安全：脚本拒绝对已对齐状态做多余写入。
- 结论成立：RewardView penalty replay 工具已满足 fork 环境下的演示性验证目标。

若后续还需要补一份“真实发生 `replayed=true`”的样本纪要，应在隔离 fork 或固定快照环境中冻结失败后的账本状态，再立即执行 replay，以避免共享节点状态漂移把候选自然推进到 `already-aligned`。
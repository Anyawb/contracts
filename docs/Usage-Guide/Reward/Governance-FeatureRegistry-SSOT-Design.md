# 治理 + FeatureRegistry + GovernanceGate（SSOT 统一落地）

> 目标读者：合约开发 / 前端 / 审计 / 运维
> 
> 范围：当前仓库实现（Registry 作为模块地址 SSOT；RewardConfig 作为治理写入口 SSOT；`block.number` 作为时间轴；无订阅体系）

---

## 0) 一句话结论

- FeatureRegistry：治理配置“功能语义”（featureKey → minLevel/enabled/metadata）的链上 SSOT。
- GovernanceGate：治理资格门控（minLevel + IVotes 快照投票权阈值）的链上 SSOT。
- RewardConfig：唯一治理写入口（SSOT），统一写 FeatureRegistry / GovernanceGate / EarnConfig。

---

## 1) 关键术语（必须统一）

- **Registry**：模块地址 SSOT（所有模块地址统一从 `Registry[KEY_*]` 解析）。
- **RewardConfig**：Reward 域治理写入口 SSOT（FeatureRegistry/GovernanceGate/EarnConfig 的治理写都通过它）。
- **EasyToken**：平台唯一资产通证 Easy；地址 SSOT 为 `Registry[KEY_EASY_TOKEN]`（18 decimals）。
- **stEASY / EasyStaking**：治理投票权 token（IVotes）；地址 SSOT 为 `Registry[KEY_EASY_STAKING]`。
- **Guardian**：运维止血主体（pause/unpause/紧急禁用等）。
- **GovernanceGuardian**：治理否决主体（veto）。建议与 Guardian 同一个多签，但概念上要区分。

---

## 2) 架构概览（数据流）

```mermaid
flowchart TD
  U[用户] -->|stake + delegate| ST[stEASY (IVotes)]
  OPS[治理/运维/多签] -->|ACTION_SET_PARAMETER| RCFG[RewardConfig SSOT]

  RCFG -->|setFeature/batchSetFeatures| FR[FeatureRegistry SSOT]
  RCFG -->|setGovernanceGateParams| GG[GovernanceGate SSOT]
  RCFG -->|pushUserGovernanceAccess| GG

  GOV[CrossChainGovernance] -->|create/vote 门控| GG
  GOV -->|veto guardian from Registry| REG[Registry]

  REG -->|解析模块地址| RCFG
  REG -->|解析模块地址| GG
  REG -->|解析模块地址| FR
```

---

## 3) Registry / ModuleKeys（SSOT keys）

需要稳定存在的 keys：

- `KEY_FEATURE_REGISTRY`：FeatureRegistry 模块地址
- `KEY_GOVERNANCE_GATE`：GovernanceGate 模块地址
- `KEY_GOVERNANCE_GUARDIAN`：GovernanceGuardian 地址（可作为“模块地址”存储即可）

约束：guardian 可迁移（仅需更新 Registry key，不需要升级治理合约）。

---

## 4) FeatureRegistry（链上“功能语义”SSOT）

### 4.1 职责

- 只负责表达：哪些 feature 存在、最低等级、是否启用、以及元数据（name/uri）。
- 不负责扣费/消费/权限执行；业务执行方（前端/路由/模块）应读取它作为门控配置来源。

### 4.2 写权限（SSOT）

- 默认仅允许 `Registry[KEY_REWARD_CONFIG]` 写入。
- break-glass：允许 `ACTION_REWARD_CONFIG_EMERGENCY`（可撤销）。

---

## 5) GovernanceGate（治理资格门控 SSOT）

### 5.1 门控维度（与当前实现一致）

- `minLevelToVote / minLevelToPropose`：用户等级门槛（`RewardTypes.ServiceLevel`）。
- `minVotesToVote / minVotesToPropose`：投票权阈值（来自 `IVotes(votesToken).getPastVotes(user, snapshotBlock)`）。

### 5.2 用户状态（无订阅/无过期）

- 当前实现**仅存储 `userLevel`**，不存任何“到期/过期”字段。
- 用户等级写入来自 `RewardConfig.pushUserGovernanceAccess(user, level)`（治理/运维决定口径）。

> 说明：RewardManagerCore 内部也有“1-5 等级系统”（协议激励/风控维度）。它与 GovernanceGate 的 `ServiceLevel(Basic..VIP)` 不是同一个枚举；如需联动，推荐由链下 job/多签按既定规则把内部等级映射成 ServiceLevel，再通过 RewardConfig 写入 GovernanceGate。

### 5.3 快照口径（policy A）

- 在 `vote` 场景，`snapshotBlock` 必须使用 `proposal.startBlock - 1`。
- 若 gate 启用，`votesToken == address(0)` 必须 fail-closed（返回 `REASON_VOTES_TOKEN_ZERO`）。

---

## 6) CrossChainGovernance 集成点（Gate + veto）

### 6.1 create/vote 门控

- createProposal/vote 入口调用 `GovernanceGate.isEligibleToPropose/isEligibleToVote`。
- 若不通过，应 revert（reason 可作为 revert data 或事件输出，便于前端与监控提示）。

### 6.2 foundation veto

- veto 主体地址从 `Registry[KEY_GOVERNANCE_GUARDIAN]` 读取，便于迁移。

---

## 7) 运维建议（最小可执行）

- 上线前：明确 `votesToken`（stEASY）配置与委托激活路径（`delegate(self)`），否则快照投票权可能为 0。
- 上线后：把 `ACTION_REWARD_CONFIG_EMERGENCY` 只授予极少数 break-glass 实体，并在 runbook 中写清楚启用/撤销流程。


### 7.1 Gate 集成点（create/vote）

#### createProposal

在 `createProposal(...)` 入口加入：

- 从 `CrossChainGovernance.registry`（可选）解析 `Registry[KEY_GOVERNANCE_GATE]`
  - 若 `CrossChainGovernance.registry == address(0)`：认为未启用 gate/veto 集成（向后兼容）
  - 若解析到 gate 为零地址：**跳过门控**（向后兼容）
- 取 `snapshotBlock = block.number - 1`（提案创建时，用上一块快照）
- 调用 `GovernanceGate.isEligibleToPropose(msg.sender, snapshotBlock, governanceToken)`  
  不通过则 revert（reason 进入 revert data，便于前端展示）

> 与当前实现完全一致的兼容行为（非常关键）：  
> - **若 gate 未配置（解析到 0）**：`createProposal` 退回到 legacy 逻辑，要求 `msg.sender` 具备 `GOVERNANCE_ROLE`（`AccessControlUpgradeable`）。

#### vote

在 `vote(proposalId, option)` 入口加入：

- `snapshotBlock = proposal.startBlock - 1`（口径 A）
- 若 gate 未绑定则跳过（向后兼容）
- gate 不通过则 revert
- 若 proposal 已 `canceled`（或 vetoed）则 revert

> 当前实现额外明确：proposal.canceled 会直接 `revert CrossChainGovernance__ProposalCanceled()`。

### 7.2 foundation veto（guardian）

新增 `vetoProposal(uint256 proposalId)`（当前实现语义）：

- guardian 地址从 `Registry[KEY_GOVERNANCE_GUARDIAN]` 读取（其中 Registry 地址来自 `CrossChainGovernance.registry`）
- 仅 guardian 可调用
- 将提案标记为 `canceled = true`（或新增 `vetoed`，但“复用 canceled”更轻量）
- emit `ProposalVetoed(proposalId, guardian, blockNumber)`

并确保：

- `executeProposal(...)` / `executeCrossChainProposal(...)` 对 `canceled == true` 直接拒绝

### 7.3 兼容性要求（必须）

- `CrossChainGovernance.registry` 是必填（SSOT）。未配置应直接 revert（避免治理在错误 SSOT 下运行）
- 绑定了 Registry 但没有绑定 `KEY_GOVERNANCE_GATE`：create/vote 不做门控（保留“无 gate 也可运行”的降级能力）
- guardian 未配置或为 0：veto 不可用（当前实现：`CrossChainGovernance__GuardianNotSet()`）

### 7.4 quorum（法定人数）计算（必须：禁止硬编码）

**绝对禁止**在治理里硬编码 `totalSupply` 之类的常量来计算 quorum。

推荐口径：

- 治理 token 固定为 EasyStaking (stEASY, IVotes)，并通过 `Registry[KEY_EASY_STAKING]` 作为唯一 SSOT
- 在 `createProposal` 时用 `snapshotBlock = block.number - 1`
- 读取 `IVotes(governanceToken).getPastTotalSupply(snapshotBlock)` 作为 base supply
- `quorum = baseSupply * quorumBPS / 10_000`

---

## 8) RewardConfig 变更（配置写入口 SSOT）

RewardConfig 作为“写入口 SSOT”，增加面向新模块的 wrapper（治理执行 action 会调用这些 wrapper）：

- `setFeature(...)` / `batchSetFeatures(...)` → 转发到 `FeatureRegistry`
- `setGovernanceGateParams(...)` → 转发到 `GovernanceGate`（enabled、minLevel、thresholds）

**注意**：

- FeatureRegistry/Gate 的写权限应锁死为 RewardConfig（通过 Registry 解析比对 `msg.sender`）
- 允许 break-glass 时，应与现有 RewardConfig 的紧急权限口径一致（`ACTION_REWARD_CONFIG_EMERGENCY`）

---

## 10) 测试计划（unit + E2E + smoke）

### 10.1 Unit tests（推荐新增）

1. `test/Reward/FeatureRegistry.test.ts`
   - `setFeature` / `batchSetFeatures` 行为
   - pagination：`listFeatureKeys(offset, limit)`
   - 写权限：只有 RewardConfig；break-glass 可选
2. `test/Governance/GovernanceGate.test.ts`
   - level / expiration / enabled / threshold
   - `getPastVotes` 快照口径（startBlock-1）
   - `votesToken == 0` 与阈值为 0 的边界行为
3. `test/Governance/CrossChainGovernance.veto.test.ts`
   - guardian 从 Registry 读取
   - veto 后不能 execute
   - gate 未绑定时向后兼容

### 10.2 E2E（localhost）

场景（最小闭环）：

- 运维/治理通过 `RewardConfig.pushUserGovernanceAccess(user, level)` 写入用户等级
- 用户持有 stEASY，并 `delegate(self)` 激活投票权快照（ERC20Votes）
- 满足门槛：create proposal + vote 成功
- 不满足门槛（非 VIP 或 stEASY 投票权不足）：create/vote revert（reason 可读）
- guardian 调用 veto：proposal 被取消，execute revert

### 10.3 Smoke

建议新增 `scripts/tests/governance-smoke-local.ts`（或在现有 smoke 中按 env 开关运行）：

- 部署后绑定 Gate + guardian
- 一条“可通过”的 create/vote + 一条“不可通过”的 revert
- veto 基本路径

---

## 11) 部署 / 运维检查清单

1. 部署 `FeatureRegistry`，绑定 `KEY_FEATURE_REGISTRY`
2. 部署 `GovernanceGate`，绑定 `KEY_GOVERNANCE_GATE`
3. 设置 `KEY_GOVERNANCE_GUARDIAN = foundation wallet`
4. 给 RewardConfig 授权写 FeatureRegistry / Gate（或让模块内部通过 Registry 校验 `msg.sender == RewardConfig`）
5. 配置 CrossChainGovernance：
  - `governanceToken = EasyStaking(stEASY)`（IVotes）
   - 调用 `CrossChainGovernance.setRegistry(registry)`（否则 gate/veto 不启用）
   - 确认 gate/veto 逻辑启用（Registry keys 已绑定）

---

## 12) 风险与注意事项

- **guardian 私钥安全**：veto 属于强权力，需要冷钱包/多签/严格操作流程。
- **快照一致性**：必须使用 `proposal.startBlock - 1`，否则可出现“先锁后投票”的口径不一致。
- **可回滚性**：Gate 需要 `enabled` 总开关，遇到线上紧急情况可快速放行以恢复治理可用性（同时依赖 veto 控制风险）。

---

## 13) 双轨治理（上线运维 SSOT：Guardian 轨 + Timelock 轨）

> 本节整合自已归档并删除的 `Governance-Dual-Track-Guide.md`，并以本文件为准。

### 13.1 目标与原则

你们当前约束是：**早期上线阶段可能没有 Timelock/Multisig**，但必须具备“分钟级止血”的能力。目标：

- **快速止血**：异常发生后，尽快暂停关键入口，阻断风险扩散。
- **最小攻击面**：减少高权限入口与可被误用的治理接口，降低被滥用/误操作概率。
- **架构一致**：写路径遵循既有 SSOT（Registry/RewardConfig 等），只读统一入口与事件订阅口径不被破坏。
- **可演进**：后续上 Timelock 时，尽量只迁移权限归属与执行流程，不大改业务合约。

### 13.2 双轨模型（方案 3）

- **Guardian 轨（紧急操作）**：用于止血动作（Pause/Unpause/紧急禁用），并且——**若启用 `CrossChainGovernance + GovernanceGuardian`——也包含治理提案 `veto`（执行前否决）**。特点：快、权限隔离、可追责。
- **Timelock 轨（非紧急治理）**：用于可预告/可审查的动作（升级、参数修改）。特点：慢、可审计、抗误操作。

> 早期没有 Timelock 时：用“**双人确认 + 延迟执行脚本**”模拟慢治理；Guardian 轨先落地，保证上线可止血。

### 13.3 角色与权限边界（上线可执行）

建议角色：

- **Guardian（强烈建议多签）**：紧急暂停/恢复（止血）；必要时执行“最小治理”以恢复安全运行；若启用 veto，则同一多签也可作为 GovernanceGuardian。
- **Keeper（可选）**：监控异常并触发“紧急暂停”交易（自动或半自动）；原则：**只能 Pause，不能 Unpause**。
- **Operator（运营）**：只读查询、运行脚本、维护监控；不应持有高危写权限。
- **Deployer（部署者）**：仅部署期使用；部署后尽量清理/撤销高权限。

权限边界（按模块）：

- **Reward 写路径（业务触发）**：`RewardManager.onLoanEventByOrder*` 仅允许 `OrderEngine/LendingEngine` 等协议内模块调用；不应被脚本/前端直接调用（除测试）。
- **Reward 只读路径（前端/链下）**：统一走 `RewardView` + 订阅 `DataPushed(...)`，并覆盖 `DATA_TYPE_REWARD_*` 与 `DATA_TYPE_EASY_*`。
- **紧急止血（Guardian 轨）**：
  - 借贷暂停/恢复：`LendingEngine.pause/unpause`（通过 ACM 的 `ACTION_PAUSE_SYSTEM/ACTION_UNPAUSE_SYSTEM`）
  - 奖励通证暂停/恢复：`EasyToken.pause/unpause`（SSOT：`Registry[KEY_EASY_TOKEN]`；权限为 `DEFAULT_ADMIN_ROLE`）
  - 治理提案否决：`CrossChainGovernance.vetoProposal`（地址 SSOT：`Registry[KEY_GOVERNANCE_GUARDIAN]`）
- **非紧急治理（未来 Timelock 轨）**：
  - UUPS 升级：`ActionKeys.ACTION_UPGRADE_MODULE`
  - 参数修改：`ActionKeys.ACTION_SET_PARAMETER`

### 13.4 借贷 + Easy 奖励紧急操作入口

借贷系统与 Easy 奖励系统的紧急暂停 / 恢复步骤，已统一迁移到 [docs/Usage-Guide/runbook/README.md](runbook/README.md)。

对应入口：

- 借贷 + Easy 奖励紧急止血：看 runbook 第 8 节
- 事故第一响应与链路判定：看 runbook 第 7 节

本文这里仅保留治理边界与权限模型，不再重复维护可直接执行的操作步骤。

### 13.5 非紧急治理（无 Timelock 过渡期流程）

在没有 Timelock 的早期，建议把所有非紧急变更都当作“需要审查”的变更：

- 变更提案模板（写到 PR/Notion）：目标、风险、回滚、执行窗口
- 双人确认
- 延迟执行（模拟 timelock 冷静期）
- 执行后验证（链上读数 + 事件 + 前端冒烟）

### 13.6 迁移到 Timelock（目标态）

推荐分两步迁移：

1. **先把升级/改参迁移到 Timelock**：将 `ACTION_SET_PARAMETER/ACTION_UPGRADE_MODULE` 的执行主体迁移到 Timelock。
2. **保留 Guardian 的 Pause 权限**（不走 Timelock）：Pause 永远 bypass Timelock；Unpause 可以更严格（例如 timelock 或 multisig+延迟）。

### 13.7 监控与审计（最小集）

- 订阅 pause/unpause（关键模块）并告警
- 订阅关键模块 `ActionExecuted`（谁在什么时候做了什么）
- Reward 订阅 `RewardView.DataPushed(...)`，监控 `DATA_TYPE_REWARD_*` 与 `DATA_TYPE_EASY_*` 的异常峰值（突增/突降）

---

## 附录 A：历史文档归档说明

此前的 Dual-Track 治理文档已并入当前 SSOT。为满足 runbook 集中化要求，附录内原有的可执行暂停 / 恢复 / 事故处理步骤不再保留全文。

归档原则：

- 治理模型、权限边界、迁移策略：以本文正文为准
- 具体执行步骤、事故响应、紧急暂停：统一以 [docs/Usage-Guide/runbook/README.md](runbook/README.md) 为准

如果后续需要保留审计用途的历史版本，建议放入单独的 archive 目录，并确保不再包含可直接照抄执行的 runbook 内容。


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

- **Reward 写路径（业务触发）**：`RewardManager.onLoanEvent*` 仅允许 `OrderEngine/LendingEngine` 等协议内模块调用；不应被脚本/前端直接调用（除测试）。
- **Reward 只读路径（前端/链下）**：统一走 `RewardView` + 订阅 `DataPushed(DATA_TYPE_REWARD_*)`。
- **紧急止血（Guardian 轨）**：
  - 借贷暂停/恢复：`LendingEngine.pause/unpause`（通过 ACM 的 `ACTION_PAUSE_SYSTEM/ACTION_UNPAUSE_SYSTEM`）
  - 奖励通证暂停/恢复：`EasyToken.pause/unpause`（SSOT：`Registry[KEY_EASY_TOKEN]`；权限为 `DEFAULT_ADMIN_ROLE`）
  - 治理提案否决：`CrossChainGovernance.vetoProposal`（地址 SSOT：`Registry[KEY_GOVERNANCE_GUARDIAN]`）
- **非紧急治理（未来 Timelock 轨）**：
  - UUPS 升级：`ActionKeys.ACTION_UPGRADE_MODULE`
  - 参数修改：`ActionKeys.ACTION_SET_PARAMETER`

### 13.4 借贷 + 积分：一键紧急暂停 Runbook（可照抄执行）

核心原则：**先暂停最外层入口，再暂停内层模块**；暂停要快，恢复要严格。

1) 强制从 Registry 解析地址（任何一个失败都不要继续）：

- `le = Registry.getModuleOrRevert(ModuleKeys.KEY_LE)`（借贷核心）
- `easyToken = Registry.getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN)`（奖励通证：EasyToken）
- `fr = Registry.getModuleOrRevert(ModuleKeys.KEY_FR)`（如部署了）
- `vaultCore = Registry.getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE)`，`vaultRouter = VaultCore(vaultCore).viewContractAddrVar()`（用户入口）

2) 建议暂停范围（默认）：

- **必须暂停**：VaultRouter + LendingEngine + EasyToken（`Registry[KEY_EASY_TOKEN]`）
- **建议一起暂停**：FeeRouter（如存在）
- **可选**：LoanNFT（按风险偏好）

3) 暂停执行顺序（从外到内）：

1. `VaultRouter.pause()`
2. `LendingEngine.pause()`
3. `FeeRouter.pause()`（如存在）
4. `LoanNFT.pause()`（如选择）
5. `easyToken.pause()`

4) 恢复（Unpause）顺序（从内到外，更严格）：

1. `easyToken.unpause()`
2. `LoanNFT.unpause()`（如之前暂停）
3. `FeeRouter.unpause()`（如之前暂停）
4. `LendingEngine.unpause()`
5. `VaultRouter.unpause()`

> 原则：unpause 需要更严格流程（原因复盘 + 修复已生效 + 双人确认 + 冒烟测试通过）。

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
- Reward 订阅 `RewardView.DataPushed(DATA_TYPE_REWARD_*)`，监控异常峰值（突增/突降）

---

## 附录 A：Dual-Track 历史全文归档（已迁移，避免信息丢失）

> 说明：本附录为已删除的 `docs/Usage-Guide/Governance-Dual-Track-Guide.md` 的全文归档。  
> “应当怎么做”的口径以本文（SSOT）为准；附录用于审计/回溯/对照。

### 原文开始

# 双轨权限治理指南（已整合入治理 SSOT）

> 最后更新：2025-12-30  
> 适用范围：**RWA 借贷平台早期上线阶段**（团队规模小、暂无 Timelock/Multisig 治理体系，但需要可快速止血的链上紧急操作）  
> 架构基线：严格遵循 `docs/Architecture-Guide.md`（唯一路径、RewardView 只读统一入口、DataPushed 统一订阅）  
> 本文档定位：历史/入口文档。**最新且唯一的治理指南 SSOT** 已统一到：`docs/Usage-Guide/Reward/Governance-FeatureRegistry-SSOT-Design.md`（包含 Guardian 轨 + Timelock 轨 + gate/veto/FeatureRegistry/GovernanceGate 全量落地说明）。

---

## 📋 目录

1. [目标与原则](#目标与原则)
2. [双轨权限模型（方案 3）](#双轨权限模型方案-3)
3. [角色与权限矩阵（上线可执行）](#角色与权限矩阵上线可执行)
4. [上线前/上线当天配置步骤（最小可用）](#上线前上线当天配置步骤最小可用)
5. [紧急操作（Guardian 轨）：自动/半自动暂停方案](#紧急操作guardian-轨自动半自动暂停方案)
   - [借贷 + 积分：一键紧急暂停 Runbook（可照抄执行）](#借贷--积分一键紧急暂停-runbook可照抄执行)
6. [非紧急治理（未来 Timelock 轨）：早期流程与迁移路线](#非紧急治理未来-timelock-轨早期流程与迁移路线)
7. [监控与审计（强烈建议）](#监控与审计强烈建议)
8. [常见问题与排错](#常见问题与排错)

---

## 🎯 目标与原则

你们当前的约束是：**没有 Timelock/Multisig**，但希望尽快上线且发生异常时能“立即止血”。  
本指南的目标是实现：

- **快速止血**：发现问题后可在分钟级完成暂停（尽量自动化，但不牺牲过多安全性）。
- **最小攻击面**：尽量减少“高权限入口”和“可被误用的治理接口”，降低被滥用/误操作的概率。
- **架构一致**：写路径严格遵守 `LendingEngine → RewardManager → RewardManagerCore`；只读统一走 `RewardView`；链下订阅统一走 `DataPushed`。
- **可演进**：后续上 Timelock 时无需大改业务合约，只迁移权限归属与执行流程。

---

## 🛡️ 双轨权限模型（方案 3）

### 核心结论（推荐）

- **Guardian 轨（紧急操作）**：用于“止血类”动作（Pause/Unpause/紧急禁用）。特点：**快、权限隔离、可追责**。此外，**若启用 `CrossChainGovernance + GovernanceGuardian`，Guardian 轨也包含对治理提案的 `veto`（执行前否决）**。
- **Timelock 轨（非紧急治理）**：用于“可预告/可审查”的治理动作（升级、参数修改）。特点：**慢、可审计、抗误操作**。

> 早期没有 Timelock 时：用“**双人确认 + 延迟执行脚本**”模拟慢治理；Guardian 轨先落地，保证上线可止血。

---

## 👥 角色与权限矩阵（上线可执行）

### 角色定义（建议）

- **Guardian（强烈建议用多签地址）**
  - 职责：紧急暂停/恢复（止血）；必要时进行“最小治理”以恢复系统安全运行。
  - 建议：至少 2 人共同控制（2/2 或 2/3）。
- **Keeper（可选，自动化机器人）**
  - 职责：监控异常并触发“紧急暂停”交易（自动或半自动）。
  - 原则：**权限必须隔离**；优先让 Keeper 只能 Pause，不能 Unpause。
- **Operator（运营）**
  - 职责：只读查询、运行脚本、维护监控，不应持有高危写权限。
- **Deployer（部署者）**
  - 职责：仅用于部署阶段，部署完成后应尽量清理/撤销高权限。

### 权限边界（按模块划分）

#### A) Reward 写路径（业务触发）
- **全局唯一入口**：`RewardManager.onLoanEvent(address,uint256,uint256,bool)`  
  - 调用者：仅 `LendingEngine`（落账后触发）
  - 备注：不应在任何脚本/前端里直接调用该入口（除测试/回放环境）。

#### B) Reward 只读路径（前端/链下）
- **统一只读入口**：`RewardView`（包含 `getUserRewardSummaryWithMeta/getUserBalanceWithMeta/getUserConsumptionsWithMeta/...`）  
  - 订阅：统一订阅 `DataPushed + DATA_TYPE_REWARD_*`

#### C) 紧急止血（Guardian 轨，必须具备）

> 你提出“暂停范围包含积分系统和借贷，尤其是借贷”。  
> 因此 Guardian 轨需要同时具备 **借贷暂停** 与 **积分暂停** 的能力（且执行顺序明确）。

##### C1) 借贷系统暂停/恢复（优先级最高）

- **LendingEngine 暂停/恢复**
  - `LendingEngine.pause()` / `LendingEngine.unpause()`
  - 权限：通过 ACM 校验 `ActionKeys.ACTION_PAUSE_SYSTEM` / `ActionKeys.ACTION_UNPAUSE_SYSTEM`
  - 说明：这是“借贷止血”的第一道闸门；适用于发现借贷路径漏洞、订单/还款异常、外部依赖异常等场景。

> 注意：你们仓库内存在两个 `LendingEngine` 合约（`src/core/LendingEngine.sol` 与 `src/Vault/LendingEngine.sol`），两者都包含 `pause/unpause`，部署时以实际 Registry 映射为准。
>
> **结论**：不要按文件名判断“主入口”，而是**始终通过 Registry 的 `ModuleKeys.KEY_LE` 解析当前生效的 LendingEngine 地址**。

##### C2) 奖励通证暂停/恢复

- **奖励通证暂停/恢复（SSOT：Registry[KEY_EASY_TOKEN]）**
  - `EasyToken.pause()` / `EasyToken.unpause()`
  - 说明：暂停后 `mint/burn` 也会被阻止，从而间接阻止“发放/扣罚/消费”等依赖铸销的路径。

> 注意：紧急止血以 `EasyToken.pause` 为主（足够覆盖绝大多数风险扩散场景）。

#### D) 非紧急治理（未来 Timelock 轨）
- UUPS 升级：各模块的 `_authorizeUpgrade` 受 `ActionKeys.ACTION_UPGRADE_MODULE` 等权限控制（通过 ACM）。
- 参数修改：通常由 `ActionKeys.ACTION_SET_PARAMETER` 控制（通过 ACM）。

---

## ⚙️ 上线前/上线当天配置步骤（最小可用）

> 目标：在“无 Timelock”的前提下，让系统具备**可快速暂停**的能力，并把高权限集中到 Guardian，降低单点风险。

### 1) 确定 Guardian 地址（建议：多签）

- **最低要求**：2 人分别持有签名权（2/2 或 2/3）。
- **早期可行替代**（不推荐长期使用）：一个冷钱包 + 一个热钱包（仍需双人确认）。

### 2) 奖励通证（SSOT：Registry[KEY_EASY_TOKEN]）权限归属（紧急止血的核心）

奖励通证地址的 SSOT 是 `Registry[KEY_EASY_TOKEN]`。

该通证使用 OpenZeppelin `AccessControl`（与 ACM 不同），关键是：

- `DEFAULT_ADMIN_ROLE`：可授予/撤销角色 + 可 `pause/unpause`
- `MINTER_ROLE`：可 `mint`（建议仅 `EasyEmissionController`）
- `BURNER_ROLE`：可 `burn`（扣罚/回收/消费，典型为 `RewardManagerCore` 与 `EasyRecycleDistributor`）

**建议的目标状态（上线后）**：

- **Guardian** 拥有：`DEFAULT_ADMIN_ROLE`（可 pause/unpause，可调整角色）
- **EasyEmissionController** 拥有：`MINTER_ROLE`（发行单点；可选 `setSoleMinter` 硬收口）
- **RewardManagerCore / EasyRecycleDistributor** 拥有：`BURNER_ROLE`（扣罚/消费/回收）
- **Deployer**：上线后撤销其 `DEFAULT_ADMIN_ROLE`（降低单点风险）

示例（ethers v6）：

```typescript
// Reward token roles (KEY_EASY_TOKEN -> EasyToken)
const DEFAULT_ADMIN_ROLE = await rewardToken.DEFAULT_ADMIN_ROLE();
const MINTER_ROLE = await rewardToken.MINTER_ROLE();
const BURNER_ROLE = await rewardToken.BURNER_ROLE();

// 1) 给发行模块铸币权限（推荐：唯一 minter）
await rewardToken.grantRole(MINTER_ROLE, easyEmissionControllerAddress);

// 2) 把 DEFAULT_ADMIN_ROLE 交给 Guardian（紧急止血 + 角色管理）
await rewardToken.grantRole(DEFAULT_ADMIN_ROLE, guardianAddress);

// 3) 给扣罚/回收模块 burn 权限
await rewardToken.grantRole(BURNER_ROLE, rewardManagerCoreAddress);
await rewardToken.grantRole(BURNER_ROLE, easyRecycleDistributorAddress);

// 3) 可选：撤销 deployer 的 admin（上线后强烈建议）
// await rewardToken.revokeRole(DEFAULT_ADMIN_ROLE, deployerAddress);
```

### 3) ACM 权限（参数/升级）早期最小化

你们早期没有 Timelock，建议把 ACM 的高危权限也尽量集中到 Guardian：

- **必须**（治理类）：`ActionKeys.ACTION_SET_PARAMETER`、`ActionKeys.ACTION_UPGRADE_MODULE`
- **紧急类（系统级）**：`ActionKeys.ACTION_PAUSE_SYSTEM`、`ActionKeys.ACTION_UNPAUSE_SYSTEM`（如果你们的 ACM 实现/脚本会使用）
- **只读类**：`ActionKeys.ACTION_VIEW_USER_DATA` 等可授予给 Operator（用于后台/监控查询）

> 注意：RewardView 的“查他人数据”会校验 `ACTION_VIEW_USER_DATA`（否则默认只允许本人查询）。

---

## 🚨 紧急操作（Guardian 轨）：自动/半自动暂停方案

### 推荐策略（从安全到自动化强度）

#### 方案 G1（更稳，推荐默认）：Keeper 告警 + Guardian 手动一键 Pause
- Keeper 只负责：告警、生成交易 calldata、推送到你们的签名工具
- Guardian 执行：**借贷 + 积分 一键暂停**（见下方 Runbook，可在多签里合并成一个批处理交易）
- 优点：误报不至于直接 DoS；Keeper 私钥泄露不会直接停机
- 缺点：不是“全自动”，但仍可做到分钟级

#### 方案 G2（更快，更自动）：Keeper 自动 Pause（但不能 Unpause）
- Keeper 拥有 pause 权限（必须隔离，且只允许 pause）
- Guardian 保留 unpause 权限（或更严格流程）
- 优点：最快止血
- 缺点：Keeper 被攻破会造成 DoS（不停暂停）

> 你们早期“尽快上线”的现实建议：先落地 G1，上线稳定后再评估是否升级到 G2。

### 借贷 + 积分：一键紧急暂停 Runbook（可照抄执行）

> 目标：在分钟级完成“借贷 + 积分”止血，同时确保**地址解析正确**、**权限明确**、**验证可复现**。  
> 核心原则：**先暂停最外层入口，再暂停内层模块**；暂停要快，恢复要严格。

#### 0) 你需要准备的输入（执行前 1 分钟确认）

- `registry`：当前网络 Registry 地址（从 `deployments/*.json` 或你们的部署记录获取）
- `guardianSigner`：Guardian 多签/签名人
- （可选）`keeperSigner`：如采用 G2 自动 pause，用 Keeper 执行“仅 pause 的模块”

#### 1) 从 Registry 解析“需要 pause 的模块地址”（强制步骤）

**必须解析并记录以下地址**（任何一个解析失败都不要盲目继续）：

- **LendingEngine（借贷止血核心）**
  - `le = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_LE)`
- **奖励通证（止血核心；EasyToken）**
  - `rewardToken = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN)`
- **FeeRouter（建议一起暂停，避免分发/计费继续跑）**
  - `fr = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_FR)`（若你们未部署该模块则会 revert）
- **LoanNFT（可选，是否暂停取决于你们对 NFT 铸/转/销的风险评估）**
  - `loanNFT = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_LOAN_NFT)`（若未部署会 revert）
- **VaultRouter（强烈建议暂停：用户最外层交互入口）**
  - `vaultCore = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE)`
  - `vaultRouter = IVaultCoreMinimal(vaultCore).viewContractAddrVar()`

> 解释：`ModuleKeys` 刻意不提供 `KEY_VAULT_ROUTER`，以避免“多来源地址”导致配置错误；VaultRouter 的权威来源是 `VaultCore.viewContractAddrVar()`。

#### 2) 建议的暂停范围（默认推荐）

- **必须暂停（上线默认）**
  - `VaultRouter` + `LendingEngine` + `EasyToken`（`Registry[KEY_EASY_TOKEN]`）
- **强烈建议一起暂停**
  - `FeeRouter`（如果部署了）
- **可选暂停（按你们风险偏好）**
  - `LoanNFT`

#### 3) 建议的暂停执行顺序（从外到内）

1. `VaultRouter.pause()`（阻断用户交互入口）
2. `LendingEngine.pause()`（阻断借贷/订单核心路径）
3. `FeeRouter.pause()`（若存在；阻断分发/计费继续跑）
4. `LoanNFT.pause()`（若选择；阻断 NFT 相关敏感操作）
5. `EasyToken.pause()`（阻断奖励通证铸/销，从而阻断发放/扣罚/消费链路）

> 说明：如果你们使用多签（推荐），建议把 1~5 合并成一个批处理交易（同一笔交易内按顺序执行），避免“只暂停了一半”的窗口期。

#### 4) 暂停后验证清单（必须逐项打钩）

- `VaultRouter.paused() == true`
- `LendingEngine.paused() == true`
- `EasyToken.paused() == true`
- （如包含）`FeeRouter.paused() == true`
- （如包含）`LoanNFT.paused() == true`
- 事件审计（建议）
  - 关键模块 `ActionExecuted` / `DataPushed(DATA_TYPE_*_PAUSED)` 是否产生

#### 5) 恢复（Unpause）建议顺序（从内到外，且更严格）

1. `EasyToken.unpause()`（先恢复奖励通证底座）
2. `LoanNFT.unpause()`（如之前暂停）
3. `FeeRouter.unpause()`（如之前暂停）
4. `LendingEngine.unpause()`（恢复借贷核心）
5. `VaultRouter.unpause()`（最后恢复用户入口）

> 原则：**unpause 比 pause 更严格**。至少需要：原因复盘 + 修复已部署/禁用路径已生效 + 双人确认 + 冒烟测试通过。

#### 6) 权限要求矩阵（执行失败时第一时间排查）

- `VaultRouter.pause/unpause`：
  - 需要 ACM：`ActionKeys.ACTION_PAUSE_SYSTEM / ACTIONKeys.ACTION_UNPAUSE_SYSTEM`
- `LendingEngine.pause/unpause`：
  - 需要 ACM：`ActionKeys.ACTION_PAUSE_SYSTEM / ActionKeys.ACTION_UNPAUSE_SYSTEM`
- `FeeRouter.pause/unpause`：
  - 需要 ACM：`ActionKeys.ACTION_PAUSE_SYSTEM / ActionKeys.ACTION_UNPAUSE_SYSTEM`
- `LoanNFT.pause/unpause`：
  - 当前合约要求的是 `ActionKeys.ACTION_SET_PARAMETER`（`GOVERNANCE_ROLE_VALUE`）
  - 注意：这是“更大”的权限面；后续若要更严格隔离，建议把 LoanNFT 的 pause 权限切换为 `ACTION_PAUSE_SYSTEM`（需要合约升级）
- `EasyToken.pause/unpause`：
  - 需要 `DEFAULT_ADMIN_ROLE`（OpenZeppelin AccessControl；SSOT：`Registry[KEY_EASY_TOKEN]`）

> 兼容 G2（Keeper 自动 pause）：Keeper 只授予 `ACTION_PAUSE_SYSTEM`，不授予 `ACTION_UNPAUSE_SYSTEM`；`DEFAULT_ADMIN_ROLE` 不建议授予 Keeper。

### 关于“自动暂停”的现实约束（重要）

- `LendingEngine.pause()` 的权限来自 ACM（ActionKeys），因此更容易实现“Keeper 自动 pause（但不能 unpause）”：
  - 给 Keeper 授予 `ACTION_PAUSE_SYSTEM`，但不授予 `ACTION_UNPAUSE_SYSTEM`。
- `EasyToken.pause()` 需要 `DEFAULT_ADMIN_ROLE`（OpenZeppelin AccessControl；SSOT：`Registry[KEY_EASY_TOKEN]`），这是高权限：
  - **不建议**把该角色直接交给 Keeper（被攻破会带来更大权限面）。
  - 早期上线建议：Keeper 触发告警 + Guardian 执行 `EasyToken.pause()`。
  - 如确需“EasyToken 也可自动 pause 且不具备 unpause 权限”，建议后续升级引入独立 `PAUSER_ROLE`（仅能 pause），避免把 `DEFAULT_ADMIN_ROLE` 暴露给机器人。

---

## 🧭 非紧急治理（未来 Timelock 轨）：早期流程与迁移路线

### 早期（无 Timelock）建议流程：双人确认 + 延迟执行脚本

把所有非紧急变更都当成“需要审查”的变更：

- **变更提案模板**（建议写到 PR/Notion）：
  - 变更目标：哪个模块/哪个函数/参数旧值→新值
  - 风险分析：对借贷/奖励/消费/前端的影响
  - 回滚方案：失败怎么回退（包括 pause 的使用）
  - 执行窗口：建议低峰期
- **双人确认**：两人都 review
- **延迟执行**：至少等待 X 小时再执行（模拟 timelock 的“冷静期”）
- **执行后验证**：链上读数 + 事件 + 前端冒烟测试

### 未来迁移到 Timelock（目标态）

当你们准备上 Timelock 时，建议分两步迁移，避免一次性切换导致失控：

1. **先把“升级/参数”迁移到 Timelock**  
   - 将 `ACTION_SET_PARAMETER/ACTION_UPGRADE_MODULE` 的执行主体迁移到 Timelock
2. **保留 Guardian 的 Pause 权限**（bypass Timelock）  
   - Pause 永远不走 Timelock（借贷平台的共识做法）
   - Unpause 可要求更严格（例如 timelock 或 multisig+延迟）

> 目标：Timelock 管治理，Guardian 管止血。两者权限边界清晰、不互相污染。

---

## 📡 监控与审计（强烈建议）

### 必订阅事件（Reward 相关）

- `RewardView.DataPushed`：
  - `DATA_TYPE_REWARD_EARNED`
  - `DATA_TYPE_REWARD_BURNED`
  - `DATA_TYPE_REWARD_LEVEL_UPDATED`
  - `DATA_TYPE_REWARD_PRIVILEGE_UPDATED`
  - `DATA_TYPE_REWARD_STATS_UPDATED`
- `EasyToken.PauseStatusChanged`（pause/unpause；目标态=EasyToken 的 `PauseStatusChanged`）
- 关键模块的 `ActionExecuted`（用于审计“谁在什么时候做了什么”）

### 告警建议（最小集）

- pause/unpause 发生时立即告警（Slack/Telegram）
- EasyToken mint/burn 失败率异常
- RewardView `DataPushed` 异常峰值（突增/突降）

---

## 🔧 常见问题与排错

### 1) 为什么 pause 后消费/发放都失败了？

因为 rewardToken pause 会阻止 `mint/burn`，而发放/扣罚/消费通常依赖铸/销，这是“止血优先”的设计取舍。

### 2) 没有 Timelock 会不会不安全？

会更“依赖流程纪律”。因此本指南强调：

- **把高权限集中到 Guardian（最好多签）**
- **把 unpause 与升级/改参视为更严格流程**
- 后续尽快迁移到 Timelock（尤其是升级/参数）

### 3) 前端查不到别人数据？

默认 `RewardView` 仅允许本人查询；运营/后台需要被授予 `ActionKeys.ACTION_VIEW_USER_DATA`（通过 ACM）。

### 原文结束


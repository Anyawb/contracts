# 双轨权限治理指南（Guardian 紧急止血 + Timelock 未来治理）

> 最后更新：2025-12-30  
> 适用范围：**RWA 借贷平台早期上线阶段**（团队规模小、暂无 Timelock/Multisig 治理体系，但需要可快速止血的链上紧急操作）  
> 架构基线：严格遵循 `docs/Architecture-Guide.md`（唯一路径、RewardView 只读统一入口、DataPushed 统一订阅）  
> 本文档定位：**唯一治理指南入口（Single Source of Truth）**；后续治理演进（Timelock/Multisig）也在本文档内追加，不再维护第二份“标准治理指南”。

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

- **Guardian 轨（紧急操作）**：用于“止血类”动作（Pause/Unpause/紧急禁用）。特点：**快、权限隔离、可追责**。
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
- **统一只读入口**：`RewardView`（包含 `getUserRewardSummary/getUserBalance/getUserConsumptions/...`）  
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

##### C2) 积分系统暂停/恢复

- **RewardPoints 暂停/恢复**
  - `RewardPoints.pause()` / `RewardPoints.unpause()`
  - 说明：暂停后 `mintPoints/burnPoints` 也会被阻止，从而间接阻止“发放/扣罚/消费”等依赖铸销的路径。

> 注意：目前 RewardConsumption/RewardCore 本身没有独立 Pausable；紧急止血以 `RewardPoints.pause` 为主（足够覆盖绝大多数风险扩散场景）。

#### D) 非紧急治理（未来 Timelock 轨）
- UUPS 升级：各模块的 `_authorizeUpgrade` 受 `ActionKeys.ACTION_UPGRADE_MODULE` 等权限控制（通过 ACM）。
- 参数修改：通常由 `ActionKeys.ACTION_SET_PARAMETER` 控制（通过 ACM）。

---

## ⚙️ 上线前/上线当天配置步骤（最小可用）

> 目标：在“无 Timelock”的前提下，让系统具备**可快速暂停**的能力，并把高权限集中到 Guardian，降低单点风险。

### 1) 确定 Guardian 地址（建议：多签）

- **最低要求**：2 人分别持有签名权（2/2 或 2/3）。
- **早期可行替代**（不推荐长期使用）：一个冷钱包 + 一个热钱包（仍需双人确认）。

### 2) RewardPoints 权限归属（紧急止血的核心）

`RewardPoints` 使用 OpenZeppelin `AccessControl`（与 ACM 不同），关键是：

- `DEFAULT_ADMIN_ROLE`：可授予/撤销角色 + 可 `pause/unpause`
- `MINTER_ROLE`：可 `mintPoints/burnPoints`

**建议的目标状态（上线后）**：

- **Guardian** 拥有：`DEFAULT_ADMIN_ROLE`（可 pause/unpause，可调整角色）
- **RewardManagerCore** 拥有：`MINTER_ROLE`（仅用于 mint/burn）
- **Deployer**：上线后撤销其 `DEFAULT_ADMIN_ROLE`（降低单点风险）

示例（ethers v6）：

```typescript
// RewardPoints roles
const DEFAULT_ADMIN_ROLE = await rewardPoints.DEFAULT_ADMIN_ROLE();
const MINTER_ROLE = await rewardPoints.MINTER_ROLE();

// 1) 给 RMCore 铸/销权限（业务必须）
await rewardPoints.grantRole(MINTER_ROLE, rewardManagerCoreAddress);

// 2) 把 DEFAULT_ADMIN_ROLE 交给 Guardian（紧急止血 + 角色管理）
await rewardPoints.grantRole(DEFAULT_ADMIN_ROLE, guardianAddress);

// 3) 可选：撤销 deployer 的 admin（上线后强烈建议）
// await rewardPoints.revokeRole(DEFAULT_ADMIN_ROLE, deployerAddress);
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
- **RewardPoints（积分止血核心）**
  - `rp = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_REWARD_POINTS)`
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
  - `VaultRouter` + `LendingEngine` + `RewardPoints`
- **强烈建议一起暂停**
  - `FeeRouter`（如果部署了）
- **可选暂停（按你们风险偏好）**
  - `LoanNFT`

#### 3) 建议的暂停执行顺序（从外到内）

1. `VaultRouter.pause()`（阻断用户交互入口）
2. `LendingEngine.pause()`（阻断借贷/订单核心路径）
3. `FeeRouter.pause()`（若存在；阻断分发/计费继续跑）
4. `LoanNFT.pause()`（若选择；阻断 NFT 相关敏感操作）
5. `RewardPoints.pause()`（阻断积分铸/销，从而阻断发放/扣罚/消费链路）

> 说明：如果你们使用多签（推荐），建议把 1~5 合并成一个批处理交易（同一笔交易内按顺序执行），避免“只暂停了一半”的窗口期。

#### 4) 暂停后验证清单（必须逐项打钩）

- `VaultRouter.paused() == true`
- `LendingEngine.paused() == true`
- `RewardPoints.paused() == true`
- （如包含）`FeeRouter.paused() == true`
- （如包含）`LoanNFT.paused() == true`
- 事件审计（建议）
  - 关键模块 `ActionExecuted` / `DataPushed(DATA_TYPE_*_PAUSED)` 是否产生

#### 5) 恢复（Unpause）建议顺序（从内到外，且更严格）

1. `RewardPoints.unpause()`（先恢复积分底座）
2. `LoanNFT.unpause()`（如之前暂停）
3. `FeeRouter.unpause()`（如之前暂停）
4. `LendingEngine.unpause()`（恢复借贷核心）
5. `VaultRouter.unpause()`（最后恢复用户入口）

> 原则：**unpause 比 pause 更严格**。至少需要：原因复盘 + 修复已部署/禁用路径已生效 + 双人确认 + 冒烟测试通过。

#### 6) 权限要求矩阵（执行失败时第一时间排查）

- `VaultRouter.pause/unpause`：
  - 需要 ACM：`ActionKeys.ACTION_PAUSE_SYSTEM / ACTION_UNPAUSE_SYSTEM`
- `LendingEngine.pause/unpause`：
  - 需要 ACM：`ActionKeys.ACTION_PAUSE_SYSTEM / ACTION_UNPAUSE_SYSTEM`
- `FeeRouter.pause/unpause`：
  - 需要 ACM：`ActionKeys.ACTION_PAUSE_SYSTEM / ACTION_UNPAUSE_SYSTEM`
- `LoanNFT.pause/unpause`：
  - 当前合约要求的是 `ActionKeys.ACTION_SET_PARAMETER`（`GOVERNANCE_ROLE_VALUE`）
  - 注意：这是“更大”的权限面；后续若要更严格隔离，建议把 LoanNFT 的 pause 权限切换为 `ACTION_PAUSE_SYSTEM`（需要合约升级）
- `RewardPoints.pause/unpause`：
  - 需要 `DEFAULT_ADMIN_ROLE`（OpenZeppelin AccessControl）

> 兼容 G2（Keeper 自动 pause）：Keeper 只授予 `ACTION_PAUSE_SYSTEM`，不授予 `ACTION_UNPAUSE_SYSTEM`；`DEFAULT_ADMIN_ROLE` 不建议授予 Keeper。

### 关于“自动暂停”的现实约束（重要）

- `LendingEngine.pause()` 的权限来自 ACM（ActionKeys），因此更容易实现“Keeper 自动 pause（但不能 unpause）”：
  - 给 Keeper 授予 `ACTION_PAUSE_SYSTEM`，但不授予 `ACTION_UNPAUSE_SYSTEM`。
- `RewardPoints.pause()` 需要 `DEFAULT_ADMIN_ROLE`（OpenZeppelin AccessControl），这是高权限：
  - **不建议**把该角色直接交给 Keeper（被攻破会带来更大权限面）。
  - 早期上线建议：Keeper 触发告警 + Guardian 执行 `RewardPoints.pause()`。
  - 如确需“RewardPoints 也可自动 pause 且不具备 unpause 权限”，建议后续升级引入独立 `PAUSER_ROLE`（仅能 pause），避免把 `DEFAULT_ADMIN_ROLE` 暴露给机器人。

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
- `RewardPoints.PauseStatusChanged`（pause/unpause）
- 关键模块的 `ActionExecuted`（用于审计“谁在什么时候做了什么”）

### 告警建议（最小集）

- pause/unpause 发生时立即告警（Slack/Telegram）
- RewardPoints mint/burn 失败率异常
- RewardView `DataPushed` 异常峰值（突增/突降）

---

## 🔧 常见问题与排错

### 1) 为什么 pause 后消费/发放都失败了？

因为 `RewardPoints` pause 会阻止 `mintPoints/burnPoints`，而发放/扣罚/消费通常依赖铸/销积分，这是“止血优先”的设计取舍。

### 2) 没有 Timelock 会不会不安全？

会更“依赖流程纪律”。因此本指南强调：

- **把高权限集中到 Guardian（最好多签）**
- **把 unpause 与升级/改参视为更严格流程**
- 后续尽快迁移到 Timelock（尤其是升级/参数）

### 3) 前端查不到别人数据？

默认 `RewardView` 仅允许本人查询；运营/后台需要被授予 `ActionKeys.ACTION_VIEW_USER_DATA`（通过 ACM）。



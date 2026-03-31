# Reward 配置写路径 vs 升级路径指南

> 适用范围：`src/Reward/*` 与 `src/Reward/configs/*`  
> 目标：避免把“配置治理写入”与“合约实现升级”混为一谈，防止出现双入口、错权限、错运维流程。

---

## 1. 一句话结论

- **配置写路径（参数变更）**：Reward 域已移除历史的“服务价格体系与资产转换”机制；治理写入口以 `RewardManager` 与 `RewardConfig` 为主，并由 Registry 解析目标模块。
- **升级路径（实现替换）**：统一走各模块自己的 **UUPS** 代理升级入口（每个模块各自 `_authorizeUpgrade` 鉴权）。
- **Registry 角色**：模块地址的唯一 SSOT；配置与升级都依赖 Registry 解析，但两条路径职责不同。

---

## 2. 两条路径的职责边界

### A) 配置写路径（业务参数治理）

用于修改：
- Earn 侧参数（`setDynamicRewardParams`、`setLevelMultiplier`）
- RewardManagerCore 内部治理参数（例如 `setLatePenaltyBps`、`updateUserLevel`）
- FeatureRegistry 特性开关与最小等级
- GovernanceGate 门控参数

推荐链路：
1. Earn 参数：`RewardManager`（role-gated） -> `RewardConfig`（`Registry[KEY_REWARD_CONFIG]`） -> `EarnConfig`（`Registry[REWARD_EARN_CONFIG]`）
2. FeatureRegistry / GovernanceGate：直接调用 `RewardConfig`（role-gated） -> 目标模块（`KEY_FEATURE_REGISTRY` / `KEY_GOVERNANCE_GATE`）
3. RewardManagerCore 参数：调用 `RewardManager`（role-gated） -> `RewardManagerCore`

设计目的：
- 保证配置写入口单一（SSOT）
- 避免直接调用各子模块导致口径漂移
- 方便审计、脚本与测试统一

### B) 升级路径（实现升级治理）

用于替换实现逻辑（不直接改变业务参数）：
- 例如升级 `RewardConfig`、`RewardManager`、`RewardManagerCore`、`EarnConfig`、`FeatureRegistry`、`GovernanceGate` 等实现

推荐链路：
1. 对目标代理执行 `upgradeTo` / `upgradeToAndCall`
2. 由目标实现中的 `_authorizeUpgrade` 校验 `ACTION_UPGRADE_MODULE`
3. 升级后继续通过 Registry/原有入口运行

设计目的：
- 每个模块独立升级与回滚
- 权限明确、边界清晰
- 避免把参数治理入口误当升级入口

---

## 3. 常见误区（必须避免）

- 误区 1：以为 “都走 RewardConfig 升级”  
  - 实际：`RewardConfig` 是配置治理聚合器，不是全局代理升级器。

- 误区 2：直接对 `EarnConfig` 做常态写入
  - 实际：默认必须由 `RewardConfig` 写入（SSOT）；仅在 break-glass 场景（`ACTION_REWARD_CONFIG_EMERGENCY`）允许旁路写，且应可撤销。

- 误区 3：在 Reward 域重新引入历史服务体系语义
  - 实际：Reward 域只保留 `EasyConsumption` 的按次消耗路径；不要在 Reward 域重新引入任何“价格/时长/升级/资产转换”的二级状态机。

- 误区 4：把“升级权限”和“业务写权限”混用  
  - 实际：`ACTION_SET_PARAMETER` 与 `ACTION_UPGRADE_MODULE` 分离治理。

---

## 4. 代码落点速查（当前仓库）

### 配置写路径关键落点

- `src/Reward/RewardManager.sol`
  - `setDynamicRewardParams(...)` / `setLevelMultiplier(...)`：转发到 `RewardConfig` 后写入 `EarnConfig`
  - `setLatePenaltyBps(...)` / `updateUserLevel(...)`：直接写入 `RewardManagerCore`

- `src/Reward/RewardConfig.sol`
  - `setDynamicRewardParams(...)` / `setLevelMultiplier(...)` -> `EarnConfig`
  - `setFeature(...)` / `batchSetFeatures(...)` -> `FeatureRegistry`
  - `setGovernanceGateParams(...)` -> `GovernanceGate`

- `src/Reward/configs/EarnConfig.sol`
  - `_requireEarnConfigWriter(...)` 强约束：
    - 默认只允许 `Registry[KEY_REWARD_CONFIG]`
    - 或 break-glass：`ACTION_REWARD_CONFIG_EMERGENCY`

### 升级路径关键落点

- 独立实现 `_authorizeUpgrade(...)` 的模块：
  - `src/Reward/RewardConfig.sol`
  - `src/Reward/RewardManager.sol`
  - `src/Reward/RewardManagerCore.sol`
  - `src/Reward/configs/EarnConfig.sol`
  - （如存在）`src/Reward/FeatureRegistry.sol` / `src/Governance/GovernanceGate.sol` 也应各自实现 `_authorizeUpgrade(...)`

---

## 5. 一致性检查清单（Review/审计可直接用）

- [ ] 配置写是否只通过 `RewardConfig` 聚合（无旁路直写）
- [ ] `RewardConfig` 是否仅从 Registry 解析服务模块地址（无内部第二映射）
- [ ] 是否未引入任何“二级配置来源”或重复的 Registry 更新入口
- [ ] 升级是否只通过 UUPS 路径，且 `_authorizeUpgrade` 使用 `ACTION_UPGRADE_MODULE`
- [ ] 是否未把参数治理角色与升级角色混用

---

## 6. 本仓库当前状态（针对 `src/Reward` 的核对结论）

截至当前代码，`src/Reward` 在“配置写路径 vs 升级路径”上**总体符合**本指南：

- Earn 参数治理写入口已收敛到 `RewardManager -> RewardConfig -> EarnConfig`（SSOT）
- `EarnConfig` 默认仅允许 `RewardConfig` 写入；保留可撤销的 break-glass 角色兜底
- 历史服务体系相关模块与语义已移除
- 升级路径为各模块 UUPS + `ACTION_UPGRADE_MODULE` 鉴权

> 备注：该结论仅针对“写路径与升级路径边界”维度；不等同于覆盖 Reward 全量业务规则审计。

---

## 7. 自动化检查脚本（防 PR 回归）

为防止后续 PR 引入“旁路写入口/路径漂移/角色回退”，建议将以下命令作为 Reward 相关改动的必跑项：

```bash
pnpm -s run compile
pnpm -s run checks:reward-monitor:config-events
pnpm -s run checks:reward-monitor:breakglass
pnpm -s run checks:reward-monitor:registry-bindings
pnpm -s run checks:reward-monitor:role-bindings
pnpm exec hardhat test test/Reward/EasyEconomics.integration.test.ts
```

---

## 8. EasyToken-only 口径全量清理方案（当前要求）

目标：保持 Reward 域对外说明与实现都只使用 Easy 语义，不再把历史 points 迁移信息当成运行口径。

### 8.1 清理范围

- 合约对外 surface：移除 `ACTION_CONSUME_POINTS`，仅保留 `ACTION_CONSUME_EASY`
- Reward 域注释与内部命名：统一为 Easy/EasyToken 语义
- Smoke / E2E / docs：对外描述统一为 Easy

### 8.2 当前基线要求

- **ActionKeys**
  - 移除 `ACTION_CONSUME_POINTS` 与 `consumePoints` 映射，固定数组移位
  - 更新 ActionKeys 数量常量
- **Reward 域注释与命名**
  - Reward/Earn/Spend/Recycle 文档与对外注释只保留 Easy 语义
  - RewardView 统一承接 Earn 状态、消费状态、回收状态的对外可观测口径
- **Smoke / Docs 口径**
  - 权限指南奖励动作固定为 `ACTION_CONSUME_EASY`
  - 部署/放行文档必须包含 role-bindings 与 recycle 恢复结算检查

### 8.3 触达文件清单

- `src/constants/ActionKeys.sol`
- `src/Reward/RewardManagerCore.sol`
- `src/Reward/internal/RewardModuleBase.sol`
- `src/Reward/configs/EarnConfig.sol`
- `src/Vault/view/modules/RewardView.sol`
- `scripts/tests/reward-smoke-local.ts`
- `docs/Usage-Guide/permission-management-guide.md`
- `docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md`

### 8.4 验证建议（手动/CI）

- 搜索 Reward 相关文档与接口：不应再把 `points/积分` 当成当前业务资产口径
- Reward 检查组合：通过 config-events、breakglass、registry-bindings、role-bindings
- Reward 集成测试：覆盖 Easy 发行、消费、回收与 recycle 异常余额恢复路径


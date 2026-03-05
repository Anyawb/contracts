# Reward 子系统对齐 WhitePaper（Easy 代币经济模型）Checklist（目标态：单通证 Easy）

> 目标：以 `docs/WhitePaper.md` 为唯一对外口径（SSOT）。本文是工程落地 checklist，不是白皮书正文。
>
> 本仓库已将 Reward 域收敛为：
> - 资产只有 `EasyToken`（`Registry[KEY_EASY_TOKEN]`）
> - 消耗只有按次扣费：`EasyConsumption` → `EasyRecycleDistributor(75/15/10)`
> - 治理门控用 `GovernanceGate`（等级 + `IVotes`），功能门控用 `FeatureRegistry`

---

## 1) 范围与原则

- 单通证原则：Reward 域不应再出现“积分/点数/第二资产”的对外口径；所有金额语义以 Easy（18 decimals）表达。
- SSOT 原则：
  - 模块地址从 `Registry` 解析。
  - 配置写入口由 `RewardConfig` 统一聚合。
  - 只读与链下订阅统一走 `RewardView`。
- 时间口径：涉及窗口/到期/门槛判断统一用 `block.number`。

---

## 2) WhitePaper 核心点对齐检查

### 2.1 Easy 代币身份

- [ ] `EasyToken` 为 ERC20（18 decimals），且作为平台唯一通证口径。
- [ ] 关键写路径引用的资产地址必须来自 `Registry[KEY_EASY_TOKEN]`。

### 2.2 发行触发（借贷完成后铸造发放）

- [ ] 发放入口由订单落账后触发（`RewardManager.onLoanEventByOrderWithLender(...)`）。
- [ ] 发放由 `EasyEmissionController`（如启用）执行 mint 与分配（borrower/lender）。
- [ ] 任何发放失败都不应破坏核心借贷落账流程（Reward 侧 best-effort 推送可观测性）。

### 2.3 发行数量公式（红利期 / 通缩期）

- [ ] 发行公式参数存在唯一配置来源（建议通过 `RewardConfig` 写入到 `EasyEmissionConfig`）。
- [ ] “累计借贷总额”“留存 Easy 总数”等依赖项在链上有唯一可观测定义（避免重复统计导致分叉）。

### 2.4 消耗（按次 1 Easy）

- [ ] `EasyConsumption.consumeEasiMCall(user)` 每次扣 `1e18` Easy。
- [ ] `EasyConsumption.consumeStrategyApiCall(user)` 每次扣 `1e18` Easy。

### 2.5 回收与销毁/分配（75/15/10）

- [ ] 收入必须进入 `EasyRecycleDistributor` 并即时结算。
- [ ] 比例为：75% burn，15% team，10% ecosystem（remainder 吸收舍入误差）。

### 2.6 治理（质押与投票权）

- [ ] 治理投票权读取的 token/votingPower SSOT 清晰（例如 `IVotes` + 质押模块）。
- [ ] `GovernanceGate` 仅做门控（等级 + 快照阈值），不承载经济状态机。

---

## 3) 工程侧验收与防回归

- [ ] `pnpm -s run compile` 通过
- [ ] `pnpm -s run checks:reward-monitor:config-events` 通过
- [ ] `pnpm -s run checks:reward-monitor:breakglass` 通过
- [ ] `pnpm -s run checks:reward-monitor:registry-bindings` 通过
- [ ] `RewardView` 为唯一对外只读入口；写模块不暴露面向外部的查询 API。
- [ ] Spend 主路径只能是 `EasyConsumption` → `EasyRecycleDistributor`；不得旁路成“直接 burn”。


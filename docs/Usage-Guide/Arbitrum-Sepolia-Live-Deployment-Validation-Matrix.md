# Arbitrum Sepolia Live Deployment Validation Matrix

## 1. 目标

这份矩阵只回答三件事：

1. 合约能否真实部署到 Arbitrum Sepolia。
2. 部署产物、地址文件、Registry wiring、基础读面是否在真链上成立。
3. reward 与 funds-flow 的 live-safe 子集是否已经接入默认 live gate，而不是只存在于 localhost 或 fork。

固定口径：

- `fork/localhost` 负责复杂行为证明。
- `live` 负责真实部署证明与真链读面证明。
- 两层都通过，才算“Arbitrum Sepolia 真链可部署验证完成”。

标准执行步骤已经迁移到 [docs/Usage-Guide/runbook/README.md](runbook/README.md)。本文只保留矩阵、边界和通过标准，不再维护单独的 live 执行 runbook。

---

## 2. 默认门禁分层

### 2.1 fork 主门禁

推荐命令：

```bash
pnpm -s run e2e:pre-release
```

覆盖内容：

- compile
- Registry invariant
- golden path
- stress
- full strict E2E
- core localhost E2E
- 报表与 deep-dive audit

说明：这是主行为证明层，不能被 live smoke 替代。

### 2.2 live 默认门禁

推荐命令：

```bash
pnpm -s run e2e:pre-release:arbitrum-sepolia-live
```

等价入口：

```bash
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-pre-release.ts --arbitrum-sepolia-live
```

live 模式固定策略：

- 先执行 `scripts/deploy/deploy-arbitrum-sepolia.ts`
- 再执行 `compile`
- 再执行 `test/Registry.invariant.test.ts`
- 再执行默认 live-safe smoke 集合
- 固定注入 `READ_ONLY=1 ENABLE_WRITE=0`
- 不执行 localhost/fork 专用 core E2E
- 所有 smoke 日志写入 `scripts/e2e/logs/live-smoke-*`

---

## 3. 默认 live-safe smoke 集合

### 3.1 基础读面 smoke

| 类别 | 脚本 | 目标 |
| --- | --- | --- |
| Registry / whitelist | `scripts/tests/whitelist-registry-smoke-local.ts` | 验证 WhitelistRegistry / Registry 基础 wiring |
| View / Scheme U | `scripts/tests/view-schemeu-smoke-local.ts` | 验证视图路由、Scheme U、只读入口 |
| View cache | `scripts/tests/viewcache-smoke-local.ts` | 验证 ViewCache 读面与缓存可观测性 |
| LendingEngine | `scripts/tests/lendingengine-smoke-local.ts` | 验证订单/债务读面与 Registry 绑定 |

### 3.2 reward live-safe 子集

| 脚本 | 模式 | 目标 |
| --- | --- | --- |
| `scripts/tests/reward-smoke-local.ts` | `READ_ONLY=1` | 验证 RewardManager / RewardView / EasyToken / EasyRecycleDistributor 的真链 wiring、缓存读面、动态参数和铸币角色绑定 |

read-only 通过标准：

- RewardManager / RewardView / EasyToken 有代码
- RewardView 持有的 Registry 与本次部署 Registry 一致
- `getUserRewardSummaryWithMeta` 与 `getUserEasyEarnedWithMeta` 可读
- `getDynamicRewardParamsWithMeta` 与 `getLevelMultiplierWithMeta(1)` 可读
- EasyToken `MINTER_ROLE` 与 EasyEmissionController 绑定关系可读
- 如果绑定了 EasyRecycleDistributor，则 recipients 非零地址

### 3.3 funds-flow live-safe 子集

| 脚本 | 模式 | 目标 |
| --- | --- | --- |
| `scripts/tests/funds-flow-smoke-create-order.ts` | `READ_ONLY=1` | 验证 create-order 场景的 live-safe 读面入口 |
| `scripts/tests/funds-flow-smoke-conservation.ts` | `READ_ONLY=1` | 验证资金守恒 smoke 的只读入口 |
| `scripts/tests/funds-flow-smoke-local.ts` | `READ_ONLY=1` | 验证 VaultCore / SettlementManager / ACM / Funds Flow 模块 wiring |
| `scripts/tests/funds-flow-invariants-suite.ts` | `READ_ONLY=1` | 验证 invariants suite 的 live-safe 只读入口与模块解析 |

read-only 通过标准：

- VaultCore / SettlementManager / OrderEngine / LendingEngine / CollateralManager / FeeRouter / LenderPoolVault / Liquidation 相关模块都能从 Registry 正确解析
- 关键合约地址上有代码
- 关键 view/selectors 能正常读取
- 脚本不依赖 `hardhat_impersonateAccount`、`evm_snapshot`、`hardhat_mine`

---

## 4. 推荐命令矩阵

### 4.1 完整发布前顺序

```bash
pnpm -s run compile
pnpm -s test test/Registry.invariant.test.ts
pnpm -s run e2e:pre-release
pnpm -s run e2e:pre-release:arbitrum-sepolia-live
```

### 4.2 只跑默认 live 门禁

```bash
pnpm -s run e2e:pre-release:arbitrum-sepolia-live
```

### 4.3 已部署情况下跳过 deploy

```bash
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-pre-release.ts --arbitrum-sepolia-live --skip-deploy
```

适用场景：

- 你确认 `scripts/deployments/arbitrum-sepolia.json` 是最新结果。
- `Registry` 对应地址在 Arbitrum Sepolia 上有 code。
- 这份产物来自上一轮已通过默认 live-safe smoke 的真链部署。
- 只想复跑 invariant 与 live-safe smoke。

### 4.4 单跑 reward live-safe smoke

```bash
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/reward-smoke-local.ts --network arbitrumSepolia
```

### 4.5 单跑 funds-flow live-safe smoke

```bash
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-create-order.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-conservation.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-local.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-invariants-suite.ts --network arbitrumSepolia
```

---

## 5. Live 执行入口

live deploy、skip-deploy 复跑、验收与产物固化步骤，已经统一迁移到 [docs/Usage-Guide/runbook/README.md](runbook/README.md)。

本矩阵文档只保留：

- live gate 分层与覆盖范围
- 默认 live-safe smoke 集合
- 发布判定标准与非目标边界

执行时请直接使用统一 runbook：

- live deploy 基线：看 runbook 第 5.4 节
- live skip-deploy 复跑：看 runbook 第 5.5 节
- 最终发布判定：看 runbook 第 6 节

---

## 6. 发布判定标准

### 6.1 达到“真链可部署”最低标准

必须同时满足：

1. `pnpm -s run e2e:pre-release` 通过。
2. `pnpm -s run e2e:pre-release:arbitrum-sepolia-live` 通过。
3. live deploy 产物文件与 Registry 地址解析一致。
4. 默认 live-safe 集合全部通过。

### 6.2 达到“live 扩展门禁已接入”标准

必须同时满足：

1. live gate 默认包含 reward live-safe 子集。
2. live gate 默认包含 funds-flow live-safe 子集。
3. 这些脚本在 `READ_ONLY=1 ENABLE_WRITE=0` 下可以直接运行。
4. 这些脚本不依赖 Hardhat 专用 RPC。

---

## 6. 非目标与边界

下面这些仍然主要由 fork/localhost 负责，不纳入默认 live gate：

- 多用户重写入压力场景
- 时间推进与快照回滚
- attack suite
- liquidation stress
- 需要 impersonate / setBalance / hardhat_mine 的复杂流程

如果后续需要“真链最小写入 smoke”，应单独实现 idempotent 的 live-write suite，而不是直接把 localhost E2E 搬到 live。

---

## 7. 执行与故障处理入口

以下内容已迁移到统一 Runbook：

- live deploy 基线步骤
- live skip-deploy 复跑
- live 失败排查
- 当前默认发布链路

请直接查看 [docs/Usage-Guide/runbook/README.md](runbook/README.md)：

- 第 5.4 节：live deploy 基线
- 第 5.5 节：live skip-deploy 复跑
- 第 6 节：发布前最终判定
- 第 7 节：事故第一响应

# BNB Testnet Fork Runbook

## 0. 网络边界

这本 runbook 只覆盖 BNB Testnet fork，边界固定如下：

- 这里只写“BNB profile 映射到 localhost fork”这条执行模型，以及 fork case 的判定标准。
- 这里不是 BNB 真链 live 手册；真链 live、fresh borrower 补资与统一 sweep，请看 `BNB-Testnet-Live-Runbook.md`。
- 这里也不是 Arbitrum fork 手册；Arbitrum fork 仍走总 runbook 里的 Arbitrum pre-release 入口。
- 本文件里的 `localhost` 仅表示本地 fork node 执行面，不表示默认 localhost 部署线；业务语义仍然是 BNB Testnet profile。

## 1. 目标

这份 runbook 只回答一件事：如何把当前 BNB Testnet live wrapper 放到本地 Hardhat fork 上执行，并且明确区分三件事：

1. fork 能不能启动。
2. 单个 fork case 有没有通过。
3. 整套 BNB fork gate 是否真的通过。

当前仓库里，BNB fork 自动化入口已经存在，但截至这次审查，只有 `preflight` 和 `warmup` 有明确通过日志；还没有发现同一轮目录下同时包含 `preflight + warmup + platform-baseline + release-gates` 全部通过的证据。
当前状态已更新：2026-04-03 这一轮已经拿到同一轮目录下 `prepare-runtime-roles + preflight + warmup + platform-baseline + release-gates` 全部通过的完整证据，可作为当前 BNB fork 资金链 gate 已打通的基线样本。

## 2. 当前入口与目录

当前唯一标准入口：

```bash
pnpm -s run test:live:fork:bnb-testnet
```

单项入口：

```bash
pnpm -s run test:live:platform-baseline:fork:bnb-testnet
pnpm -s run test:live:release-gates:fork:bnb-testnet
```

对应脚本：

- `scripts/tests/fork-test/networks/bnb-testnet/live-fork.autonode.ts`
- `scripts/tests/fork-test/networks/bnb-testnet/prepare-runtime-roles.ts`

被调用的正式 live wrapper 仍然在：

- `scripts/tests/live-test/networks/bnb-testnet/`

日志目录统一落在：

- `scripts/tests/logs/bnb-live-fork-<timestamp>/`

## 3. 成功执行所需条件

### 3.1 RPC 条件

BNB fork 不能依赖普通公共 RPC。当前必须满足：

1. 上游 RPC 支持 fork 读取历史状态。
2. 上游 RPC 不会在 Hardhat fork 读取历史块时持续报 `missing trie node`。
3. 最好是私有 archive-like RPC。

推荐放在本地 `.env` 中的变量：

```bash
BNB_FORK_UPSTREAM_RPC_URL=https://...
```

兼容回退顺序：

1. `BNB_FORK_UPSTREAM_RPC_URL`
2. `BNB_TESTNET_RPC_URL`
3. `BSC_TESTNET_RPC_URL`
4. `BSC_TESTNET_URL`
5. `BNB_TESTNET_URL`

### 3.2 本地环境条件

执行前建议至少保证：

```bash
pnpm -s run compile
```

同时需要：

1. `scripts/deployments/bnb-testnet/core.json` 存在且可读。
2. `deployments/mock-assets.bnb-testnet.json` 存在且可读。
3. `.env` 已包含 BNB 私有 RPC。
4. 当前终端能读取 `.env`，推荐执行：

```bash
set -a && source .env && set +a
```

### 3.3 runner 当前隐含前提

当前 runner 已经内建以下能力，所以不需要手工重复做：

1. 自动起本地 Hardhat fork node。
2. 自动选取随机端口，避免和旧的 `18546` 残留节点串端口。
3. fork 就绪后自动 `evm_mine` 一块，绕过 BNB historical-block 调用问题。
4. 自动执行 `prepare-runtime-roles.ts`。
5. 自动把 `LIVE_NETWORK_ALIAS=bnbTestnet` 注入 localhost 执行环境。
6. 自动把 BNB/BSC RPC 变量改指向本地 fork。

## 4. 当前 fork 执行模型

当前 BNB fork 不是把脚本直接跑在 `--network bnbTestnet` 上，而是：

1. 先启动本地 fork node。
2. 再用 `--network localhost` 执行脚本。
3. 通过 `BNB_LIVE_ALLOW_LOCAL_FORK=1` 和 `LIVE_NETWORK_ALIAS=bnbTestnet`，让 wrapper 在 localhost 上按 BNB profile 取地址和 mock asset pack。

所以判断一轮 fork 是否“口径正确”，必须同时满足：

1. 日志里出现 `ForkRpc=http://127.0.0.1:<port>`。
2. 业务脚本日志里 `Registry` 指向 BNB 部署地址，而不是 localhost 部署地址。
3. `MockAssetPack` 指向 `deployments/mock-assets.bnb-testnet.json`。

## 5. 标准执行方式

### 5.1 跑整套入口

```bash
set -a && source .env && set +a && \
pnpm -s run test:live:fork:bnb-testnet
```

默认 case 顺序：

1. `preflight`
2. `warmup`
3. `platform-baseline`
4. `release-gates`

### 5.2 只跑单项 case

只跑 preflight：

```bash
set -a && source .env && set +a && \
BNB_FORK_AUTONODE_CASES=preflight \
pnpm -s run test:live:fork:bnb-testnet
```

只跑 warmup：

```bash
set -a && source .env && set +a && \
BNB_FORK_AUTONODE_CASES=warmup \
pnpm -s run test:live:fork:bnb-testnet
```

只跑 platform baseline：

```bash
set -a && source .env && set +a && \
pnpm -s run test:live:platform-baseline:fork:bnb-testnet
```

只跑 release gates：

```bash
set -a && source .env && set +a && \
pnpm -s run test:live:release-gates:fork:bnb-testnet
```

## 6. runtime roles 与资金准备

当前 fork 要跑通，不只要 fork node 正常，还需要补链上权限与 relayer 余额。

`prepare-runtime-roles.ts` 当前已经会做两类事：

1. impersonate ACM owner，给 relayer / viewer / borrower / lender 授权。
2. impersonate mock asset deployer，给 relayer 预注资 mUSDC 和 mWBNB。

当前默认补齐的核心角色包括：

1. `ActionKeys.ACTION_VIEW_PRICE_DATA`
2. `ActionKeys.ACTION_VIEW_USER_DATA`
3. `ActionKeys.ACTION_VIEW_RISK_DATA`
4. `ActionKeys.ACTION_VIEW_SYSTEM_DATA`
5. `ActionKeys.ACTION_VIEW_SYSTEM_STATUS`
6. `ActionKeys.ACTION_LIQUIDATE`
7. `ActionKeys.ACTION_DEPOSIT`
8. `ActionKeys.ACTION_VIEW_PUSH`
9. `UPDATE_PRICE`
10. `SET_PARAMETER`

如果未来再遇到新的 `MissingRole()`，先看 `00-prepare-runtime-roles.log` 是否真的把目标地址和目标角色都打进去了，再决定是否要扩展默认角色集合。

## 7. 如何判断这轮 fork 真的通过

### 7.1 单个 case 通过的标准

以单个目录为准。比如：

- `scripts/tests/logs/bnb-live-fork-20260402135701495/`

对应 case 日志中必须出现明确成功标记，例如：

1. `✅ live-preflight-localhost PASSED`
2. `✅ live-warmup-localhost PASSED`

仅仅命令退出 0，不足以认定通过；必须以 step log 中的明确 `PASSED` 为准。

### 7.2 整套 fork 通过的标准

只有同时满足下面四个文件都存在并分别通过，才能说这轮 BNB fork 全通过：

1. `00-prepare-runtime-roles.log`
2. `01-preflight.log`
3. `02-warmup.log`
4. `03-platform-baseline.log`
5. `04-release-gates.log`

并且 runner 总日志中还要出现：

```text
✅ BNB live fork autonode PASSED
```

如果目录里只有 `00-prepare-runtime-roles.log` 和 `01-warmup.log`，那只能说明 warmup 单项通过，不能说明整套 fork gate 通过。

## 8. 当前已验证证据

### 8.1 当前可复核的完整通过样本

本轮最终通过目录：

- `scripts/tests/logs/bnb-live-fork-20260403134109220/`

同一轮目录下已经包含完整 5 份 step 日志：

1. `00-prepare-runtime-roles.log`
2. `01-preflight.log`
3. `02-warmup.log`
4. `03-platform-baseline.log`
5. `04-release-gates.log`

runner 总日志结论为：

```text
✅ BNB live fork autonode PASSED
```

其中关键信号包括：

1. `ForkRpc=http://127.0.0.1:<port>`，确认脚本运行在本地 fork node 上。
2. `Registry=0xC876B046F139C95DC513F4665a507830536eD116`，确认业务地址仍指向 BNB profile，而不是 localhost 部署线。
3. `MockAssetPack=/Volumes/AI-hosts/contracts/deployments/mock-assets.bnb-testnet.json`，确认资产包口径正确。

release gates 内部 5 个子阶段在同一轮中全部通过：

1. `platform runtime baseline`
2. `platform observability evidence`
3. `fee prepaid gate`
4. `fee remaining gate`
5. `fee dynamic gate`

对应 release gates 汇总日志：

- `scripts/tests/logs/live-release-gates-bnbTestnet-via-localhost-20260403135603353/`

### 8.2 已知失败历史

同一批次中也保留了明确失败证据，说明当前 fork 是“逐步收敛后打通”的，不是第一次就稳定：

- `scripts/tests/logs/bnb-live-fork-20260402135701495/02-warmup.log`

这个历史失败点是：

1. 当时 `prepare-runtime-roles` 还没有给 relayer 补 `UPDATE_PRICE`。
2. warmup 因 `Price update required for mUSDC, but relayer lacks UPDATE_PRICE` 失败。

所以后续再看 warmup 是否通过时，不要只看某一轮成功日志，也要确认角色准备脚本版本已经包含 `UPDATE_PRICE` 和 `SET_PARAMETER`。

### 8.3 本轮修复后的新增结论

这轮完整打通前，最近一次失败点在：

- `scripts/tests/logs/bnb-live-fork-20260403132526136/03-platform-baseline.log`

失败根因不是 fork 基础设施，而是脚本代码缺陷：

1. `live-platform-baseline.ts` 在 liquidation 分支调用了 `findRewardViewPush(...)`。
2. 文件顶部漏导入该 helper。
3. 结果在 guarantee-default 路径上抛出 `ReferenceError: findRewardViewPush is not defined`。

修复后重跑，`platform-baseline` 与 `release-gates` 在同一轮目录中都已通过。这意味着当前 BNB fork 的剩余风险重点不再是“入口边界混用”，而是 live helper 变更后是否同步更新各脚本导入列表。

## 9. 当前结论

截至 2026-04-03，本 runbook 可以升级为以下结论：

1. BNB fork 基础设施已打通。
2. runtime role 补齐与 mock 资金注入已打通。
3. `preflight`、`warmup`、`platform-baseline`、`release-gates` 已在同一轮目录中完整通过。
4. 当前已经有证据支持“BNB fork 全套通过”和“BNB fork 的 release gates 已验证通过”这两个结论。
5. 当前需要继续关注的风险点，转为 live helper 变更后的脚本同步导入完整性，而不是 fork runner 本身的网络边界问题。

## 10. 日志里还存在的非阻断缺陷

即使当前 `preflight` / `warmup` 已通过，日志里仍有几类需要明确记录的残余问题。

### 10.1 preflight 仍有 stale price 警告

在：

- `scripts/tests/logs/bnb-live-fork-20260402135701495/01-preflight.log`

仍能看到：

1. `PriceOracle__StalePrice()`
2. `Neither PriceOracle nor ValuationOracleView produced a readable borrow-asset price`
3. `Neither PriceOracle nor ValuationOracleView produced a readable collateral price`

这说明 preflight 目前是以“允许冷缓存 / stale cache 提示但不硬失败”的口径通过，不是价格读面已经完全干净。

### 10.2 Reward / Health / Position 在 warmup 前仍是冷态

在 warmup 的 `before-flow` 观测里还能看到：

1. `borrower.reward ... valid=false`
2. `lender.reward ... valid=false`
3. `borrower.health ... valid=false`
4. 两条 position 初始也是 `valid=false`

这本身不构成失败，因为 warmup 的职责之一就是把这些读面写热；但它说明 fork 启动后的初始状态并不适合直接拿来当最终 gate 证据。

### 10.3 warmup 通过后，lender.reward 仍未写热

在：

- `scripts/tests/logs/bnb-live-fork-20260402142547158/01-warmup.log`

`after-borrow` 和 `after-repay` 里，borrower 的 reward 已经变成 `valid=true`，但 lender 仍然是：

1. `block=0`
2. `valid=false`
3. `easyValid=false`

这意味着当前 warmup 主要写热了 borrower 路径，lender 侧 reward cache 还没有被同一条最小借贷流程充分覆盖。它不是本轮 warmup 的阻断错误，但应视为后续 baseline / observability gate 的潜在风险。

### 10.4 preflight README 口径已过时

当前仓库中的部分 fork README 仍把 BNB fork 描述成“伪装成 chainId=97 并用 `--network bnbTestnet` 执行 wrapper”。

但当前 runner 实际做法已经是：

1. 本地 Hardhat node 运行在默认本地链环境。
2. 业务脚本通过 `--network localhost` 执行。
3. 再通过 `LIVE_NETWORK_ALIAS=bnbTestnet` 映射到 BNB profile。

后续如果要看文档与实现是否一致，应以本 runbook 和当前 runner 源码为准。

## 11. 后续维护建议

当前不再需要把 runbook 的目标设为“先证明整套 gate 真通过”，因为这一步已经完成。后续更合理的维护顺序是：

1. live helper 发生修改后，优先跑 `pnpm exec tsc -p tsconfig.scripts.json --noEmit`。
2. 如果改动触及 `live-platform-baseline.ts`、`live-release-gates.ts` 或 reward/fee helper，优先重跑 `test:live:platform-baseline:fork:bnb-testnet`。
3. 只有当 baseline 或单项 gate 有改动时，再补跑整套 `test:live:fork:bnb-testnet` 收集新的完整样本目录。

建议保留这轮通过目录作为后续回归对照：

- `scripts/tests/logs/bnb-live-fork-20260403134109220/`
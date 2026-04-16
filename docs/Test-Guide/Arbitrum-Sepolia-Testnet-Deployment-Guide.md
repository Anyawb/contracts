# Arbitrum Sepolia 测试链部署指南

## 1. 目标

这份指南统一三件事：

1. 上 Arbitrum Sepolia 测试网之前必须完成哪些准备和验证。
2. localhost、fork、真实测试网三套环境各自该跑什么，不该跑什么。
3. 如何按稳定顺序复跑，避免把 localhost 和 fork 混在同一条流水线里。

固定口径：

- fork 是行为验证主路径。
- localhost 是确定性复现和严格 E2E 主路径。
- real-chain 只读 smoke 是上测试网前的最后外部环境确认。
- 不要把主钱包私钥直接用于测试链部署、E2E 或 CI。
- fork-only 脚本绝不能在默认 localhost 1337 上直接跑。

若流程中引用 blocks-only 状态语义，术语与状态映射统一以 [pre-launch-comprehensive-testing-requirements.md](pre-launch-comprehensive-testing-requirements.md) 第 5 章 Gate 9 的“词典约束（blocks-only）”为准。

标准执行步骤、事故处置和紧急止血已经集中迁移到 [docs/Usage-Guide/runbook/README.md](runbook/README.md)。本文只保留背景、边界、准备项和通过标准，不再维护第二套可照抄执行步骤。

---

## 2. 网络边界

先记住这张表。后面所有命令都围绕它展开。

| 环境 | RPC | chainId | 用途 | 典型命令 |
| --- | --- | --- | --- | --- |
| localhost | http://127.0.0.1:8545 | 1337 | 本地 fresh node、部署、本地 smoke、本地严格 E2E | `pnpm -s run node` |
| fork localhost | http://127.0.0.1:18545 | 421614 | Arbitrum Sepolia fork 行为验证、fork-only E2E | `hardhat node --port 18545` |
| arbitrumSepolia | 远程 RPC | 421614 | 真实测试网只读 smoke、真实部署 | `--network arbitrumSepolia` |

硬规则：

- `scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts` 只能跑在 Arbitrum fork 上。
- `deploy:localhost`、`grant-required-roles-local.ts`、localhost E2E，必须共享同一个 `LOCALHOST_RPC_URL`。
- 只要切换了节点端口或重启了 fresh node，就必须重新 deploy，不能复用旧地址假设。
- 不要把下面这种串联命令当成稳定口径：先跑 localhost 脚本，再直接追加 fork-only 脚本。

```bash
pnpm hardhat run scripts/e2e/e2e-localhost-blocks-only-rollout-smoke.ts --network localhost && \
pnpm hardhat run scripts/e2e/e2e-localhost-full-with-views.ts --network localhost && \
pnpm hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost && \
pnpm hardhat run scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts --network localhost
```

原因：最后一条即便写着 `--network localhost`，也要求它背后的 `LOCALHOST_RPC_URL` 指向 fork 节点，而不是默认 8545/1337。

推荐习惯：

- localhost 流程固定在一个终端组里跑。
- fork 流程固定在另一个终端组里跑。
- 真实测试网流程只用 `--network arbitrumSepolia`，不要复用 localhost 命令。

---

## 3. 环境准备

### 3.1 推荐 RPC Provider

推荐优先使用 Alchemy 的 Arbitrum Sepolia 专用 RPC。

原因：

- 对 fork 场景更稳定。
- 比公共 RPC 更不容易遇到限流、超时或历史状态读取失败。
- 本仓库的 fork pre-release 和 fork-only stale-price keeper 都对上游 RPC 稳定性敏感。

备选：

- dRPC
- QuickNode
- Tenderly
- Infura
- PublicNode

Alchemy 获取方式：

1. 打开 https://www.alchemy.com/rpc-api
2. 创建 app
3. Network 选择 Arbitrum Sepolia
4. 从 dashboard 复制 HTTPS RPC URL

典型地址：

```bash
https://arb-sepolia.g.alchemy.com/v2/<ALCHEMY_API_KEY>
```

建议导出：

```bash
export ARBITRUM_SEPOLIA_RPC_URL="https://arb-sepolia.g.alchemy.com/v2/<ALCHEMY_API_KEY>"
export ARBITRUM_SEPOLIA_URL="$ARBITRUM_SEPOLIA_RPC_URL"
```

### 3.2 专用测试钱包

测试链、fork、CI 都应使用专用测试钱包，而不是主钱包。

要求：

- 不与主钱包复用私钥。
- 只放少量测试币。
- 私钥只放在本地环境变量、密码管理器或 CI secret。
- 不要写入仓库、README、脚本或提交记录。

本地生成测试钱包：

```bash
node -e 'const { Wallet } = require("ethers"); const w = Wallet.createRandom(); console.log(JSON.stringify({ address: w.address, privateKey: w.privateKey, mnemonic: w.mnemonic?.phrase || null }, null, 2));'
```

### 3.3 测试币

fork 不需要测试币。

只有下面场景需要：

- 真实 Arbitrum Sepolia 部署
- 真实链写路径 smoke
- 任何会真实发交易的 `--network arbitrumSepolia` 命令

推荐 faucet 顺序：

1. Arbitrum Sepolia ETH
2. Ethereum Sepolia ETH
3. 如有需要再桥接到 Arbitrum Sepolia

常用入口：

- Chainlink Faucet: https://faucets.chain.link/arbitrum-sepolia
- Alchemy Faucet: https://www.alchemy.com/faucets/arbitrum-sepolia
- QuickNode Faucet: https://faucet.quicknode.com/arbitrum/sepolia

---

## 4. 上测试网前必须完成的验证清单

下面这份清单是当前仓库在上 Arbitrum Sepolia 之前的推荐硬门槛。没有全部通过，不建议直接做真实测试网写入或部署。

### 4.1 基础门槛

- `pnpm -s run compile`
- `pnpm -s run test:invariant`
- 至少跑一轮 localhost smoke 或 prodlike smoke
- 关键 localhost 严格 E2E 通过
- 关键 fork 行为 E2E 通过
- 最新报告重新生成并通过 deep-dive audit
- 真实测试网只读 smoke 通过

### 4.2 当前推荐必跑项

最小上线前通过线：

1. 编译与不变式
2. localhost smoke
3. localhost `blocks-only-rollout-smoke`
4. localhost `full-with-views`
5. localhost `batch-advanced-10-users`
6. fork `stale-price-keeper`
7. 量化与明细报告重算
8. deep-dive audit
9. real-chain read-only smoke

### 4.3 验收产物

至少保留以下产物：

- `scripts/e2e/artifacts/*.json`
- `scripts/e2e/doc/E2E-Details-Latest.md`
- `scripts/e2e/doc/E2E-Quantification-Latest.md`
- `scripts/e2e/doc/E2E-Deep-Dive-Latest.md`

如果这些报告没有随最新一轮 artifacts 重建，就不要把结果当作有效验收结论。

---

## 5. 标准执行入口

从本节开始的所有标准执行步骤已经迁移到 [docs/Usage-Guide/runbook/README.md](runbook/README.md)。

使用方式：

- 要跑 localhost fresh 基线：看 runbook 第 5.1 节
- 要跑 localhost dirty 复跑：看 runbook 第 5.2 节
- 要跑 fork pre-release：看 runbook 第 5.3 节
- 要跑 live deploy / skip-deploy 验收：看 runbook 第 5.4 和 5.5 节
- 要做事故处置或紧急止血：看 runbook 第 7 和第 8 节

本文继续只作为环境边界、准备项和通过线说明，不再保留第二套可直接执行的命令链。

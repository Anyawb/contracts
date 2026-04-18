# EVM Testnet 部署、Baseline 与前端对接指南

## 1. 目标

这份指南统一当前仓库在 EVM 测试网的部署、baseline、前端对接和发布后验证口径，覆盖两条链：

1. BNB Testnet
2. Arbitrum Sepolia

统一原则：

1. deploy output 负责地址事实。
2. baseline 负责版本锚点、编译器和 implementation provenance。
3. manifest 和前端 release 文件必须引用同一份 baseline。
4. 前端和外部集成只消费同步流程生成的稳定文件，不自行拼装地址。

## 2. 关键文件

### BNB Testnet

部署事实源：

1. scripts/deployments/bnb-testnet/core.json
2. scripts/deployments/bnb-testnet/manifest.json
3. scripts/deployments/bnb-testnet/mock-suite.json
4. scripts/deployments/bnb-testnet/baseline.json
5. scripts/deployments/bnb-testnet/history

前端事实源：

1. frontend-config/networks/bnb-testnet.ts
2. frontend-config/networks/bnb-testnet.release.json
3. frontend-config/contracts-bnb-testnet.ts
4. frontend-config/moduleKeys.ts
5. frontend-config/contractErrors.ts

### Arbitrum Sepolia

部署事实源：

1. scripts/deployments/arbitrum-sepolia.json
2. scripts/deployments/arbitrum-sepolia.manifest.json
3. scripts/deployments/arbitrum-sepolia.mock-suite.json
4. scripts/deployments/arbitrum-sepolia.baseline.json

前端事实源：

1. frontend-config/networks/arbitrum-sepolia.ts
2. frontend-config/networks/arbitrum-sepolia.release.json
3. frontend-config/contracts-arbitrum-sepolia.ts
4. frontend-config/moduleKeys.ts
5. frontend-config/contractErrors.ts

## 3. Baseline 规则

通用规则：

1. 每个网络都必须同时保留 deploy output、manifest、baseline、前端 release 文件。
2. baseline 是发布取证和回滚锚点，deploy output 不是。
3. 同步流程每次都应刷新 baseline，并让 manifest 和 frontend release 指向同一份 baseline。
4. 旧 release 不应只靠 git 状态追溯，必须保留历史 baseline 或归档 baseline。

当前 canonical baseline：

1. scripts/deployments/bnb-testnet/baseline.json
2. scripts/deployments/arbitrum-sepolia.baseline.json

BNB Testnet 额外保留历史 baseline：

1. scripts/deployments/bnb-testnet/history/<releaseId>.baseline.json

当前 BNB audit-only 默认 reference baseline：

1. scripts/deployments/bnb-testnet/history/bnb-testnet-20260414011126528.baseline.json

关闭默认 reference baseline：

```bash
RELEASE_SYNC_DISABLE_DEFAULT_REFERENCE_BASELINE=1 \
pnpm -s run deploy:sync-and-verify:bnb-testnet:audit-only
```

改用其他历史 baseline：

```bash
RELEASE_SYNC_REFERENCE_BASELINE_FILE=scripts/deployments/bnb-testnet/history/<releaseId>.baseline.json \
pnpm -s run deploy:sync-and-verify:bnb-testnet:audit-only
```

## 4. 首次部署流程

### BNB Testnet

统一入口：

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet
```

该入口负责：

1. compile、typecheck、e2e:typecheck
2. deploy preflight
3. deploy 或 upgrade
4. 刷新 core.json、manifest.json、mock-suite.json、baseline.json
5. 归档 history/<releaseId>.baseline.json
6. 刷新 bnb-testnet.ts、bnb-testnet.release.json、moduleKeys、contractErrors、ABI 文档
7. 审计 Registry、frontend config、implementation、critical roles
8. 跑 fork
9. 跑 gate 9
10. gate 9 通过后跑 gate 10

最小验收物：

1. scripts/deployments/bnb-testnet/core.json
2. scripts/deployments/bnb-testnet/manifest.json
3. scripts/deployments/bnb-testnet/mock-suite.json
4. scripts/deployments/bnb-testnet/baseline.json
5. scripts/deployments/bnb-testnet/history/<releaseId>.baseline.json
6. frontend-config/networks/bnb-testnet.ts
7. frontend-config/networks/bnb-testnet.release.json

### Arbitrum Sepolia

统一入口：

```bash
pnpm -s run deploy:sync-release:arbitrum-sepolia
```

最小验收物：

1. scripts/deployments/arbitrum-sepolia.json
2. scripts/deployments/arbitrum-sepolia.manifest.json
3. scripts/deployments/arbitrum-sepolia.mock-suite.json
4. scripts/deployments/arbitrum-sepolia.baseline.json
5. frontend-config/networks/arbitrum-sepolia.ts
6. frontend-config/networks/arbitrum-sepolia.release.json

## 5. 后续升级流程

### BNB Testnet

完整升级继续使用：

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet
```

只做链上对账：

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet:audit-only
```

对账并补关键角色：

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet:audit-repair-roles
```

升级后必须确认：

1. baseline.json 已重写为新的 releaseId。
2. history 目录已新增同 releaseId 的归档副本。
3. bnb-testnet.ts 和 bnb-testnet.release.json 的 releaseId 与 baseline 一致。
4. manifest.json 与前端 release 文件引用同一份 baseline。

### Arbitrum Sepolia

完整升级继续使用：

```bash
pnpm -s run deploy:sync-release:arbitrum-sepolia
```

升级后必须确认：

1. arbitrum-sepolia.baseline.json 已更新为当前 release。
2. arbitrum-sepolia.ts 和 arbitrum-sepolia.release.json 的 releaseId 与 baseline 一致。
3. arbitrum-sepolia.manifest.json 与前端 release 文件引用同一份 baseline。

## 6. 前端连接规则

前端或外部系统不要自己拼接地址，应直接消费同步入口生成的文件。

BNB Testnet：

1. TypeScript 前端读取 frontend-config/networks/bnb-testnet.ts。
2. 非 TS 或跨仓库集成读取 frontend-config/networks/bnb-testnet.release.json。
3. 若需要发布取证和 provenance，读取 scripts/deployments/bnb-testnet/baseline.json。

Arbitrum Sepolia：

1. TypeScript 前端读取 frontend-config/networks/arbitrum-sepolia.ts。
2. 非 TS 或跨仓库集成读取 frontend-config/networks/arbitrum-sepolia.release.json。
3. 若需要发布取证和 provenance，读取 scripts/deployments/arbitrum-sepolia.baseline.json。

通用约束：

1. 地址读 contracts。
2. release 元数据读 releaseId、generatedAt、sourceFiles。
3. Registry key 读 contracts.<ContractName>.registryKey。
4. 不要分别读取 deploy output 和前端地址表后再手工比对；应只消费一个统一生成的前端 release 文件。

## 7. BNB fork、gate 9、gate 10

标准顺序：

1. fork
2. gate 9
3. gate 10

单独 fork：

```bash
pnpm -s run test:live:release-gates:fork:bnb-testnet
```

单独 gate 9：

```bash
pnpm -s run test:live:release-gate9:bnb-testnet
```

单独 gate 10：

```bash
pnpm -s run test:live:release-gate10:bnb-testnet
```

完整 Layer-A 严格 live：

```bash
pnpm -s run test:live:release-gates:bnb-testnet:layer-a
```

## 8. 阻断条件

以下任一出现，直接阻断后续 fork 或 live：

1. 对应网络的 deploy output 缺失或地址不完整。
2. manifest 缺失，或未指向同一份 baseline。
3. mock-suite 缺失或不可消费。
4. 前端网络配置与 deploy output 不一致。
5. implementation hash 与当前 artifacts 不一致，且 reference baseline 也无法解释。
6. 关键 runtime roles 缺失。
7. BNB gate 9 未通过却继续执行 gate 10。

## 9. 推荐日常命令

BNB 标准同步与验证：

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet
```

BNB 只做对账：

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet:audit-only
```

BNB 对账并补角色：

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet:audit-repair-roles
```

Arbitrum 标准同步：

```bash
pnpm -s run deploy:sync-release:arbitrum-sepolia
```

baseline 完整性检查：

```bash
pnpm -s run checks:deploy-baselines
```

## 10. 相关文档

1. scripts/deploy/README.md
2. docs/Usage-Guide/runbook/README.md
3. docs/Usage-Guide/runbook/BNB-Testnet-Live-Runbook.md
4. docs/Usage-Guide/runbook/BNB-Testnet-Fork-Runbook.md
5. docs/Usage-Guide/Arbitrum-Sepolia-Testnet-Deployment-Guide.md
6. docs/Usage-Guide/runbook/Arbitrum-Sepolia-Live-Platform-Baseline-Runbook.md
7. docs/Usage-Guide/runbook/Arbitrum-Sepolia-Mock-Assets-Runbook.md

## 11. 部署补充（2026-04-17）

本次 BNB 同步部署实战新增以下约束，避免“部署成功但 baseline/审计不同步”导致流程中断。

### 11.1 reference baseline 缺项会阻断 implementation audit

现象：

1. deploy 主流程已完成并生成新 releaseId。
2. implementation hash audit 阶段报错，提示 reference baseline 缺少新合约条目（例如 `LiquidatorView`、`OrderStateStoreV2`）。

处理：

1. 不要直接关闭全部审计。
2. 使用包含完整条目的历史 baseline 作为 reference baseline 重跑：

```bash
RELEASE_SYNC_REFERENCE_BASELINE_FILE=scripts/deployments/bnb-testnet/history/<releaseId>.baseline.json \
pnpm -s run deploy:sync-and-verify:bnb-testnet
```

### 11.2 非代理合约 implementationAddress 必须与审计格式一致

现象：

1. reference baseline 中非代理合约 `implementationAddress` 为 `null`。
2. implementation audit 期望零地址 `0x0000000000000000000000000000000000000000`，导致 unresolved failures。

处理：

1. 对于 `isProxy=false` 的合约，baseline 中 `implementationAddress` 统一使用零地址。
2. 本次确认至少包含以下条目：
	1. `SettlementToken`
	2. `CacheMaintenanceManager`

### 11.3 同步完成判定（必须同时满足）

1. `scripts/deployments/bnb-testnet/baseline.json` 已刷新为当次 releaseId。
2. `scripts/deployments/bnb-testnet/history/<releaseId>.baseline.json` 已归档。
3. `scripts/deployments/bnb-testnet/manifest.json` 与 `frontend-config/networks/bnb-testnet.release.json` 引用同一 releaseId。
4. reference baseline implementation audit 结果 `unresolved=0`。

### 11.4 与业务失败分离判定

1. 如果 `summary.json` 显示 deploy/build/audit 已通过，但 `09-fork.log` 失败，应先归类为 fork/live 基础设施问题（例如上游 RPC 429、fork 节点超时），不要误判为 baseline 未同步。
2. baseline 同步问题与 live 用例问题要分开排查，避免在同一轮里混淆根因。

### 11.5 单模块升级也必须做“地址一致 + 语义一致”双探针

仅看到 deploy 成功，不代表 live 用例可用。至少要做两类探针：

1. 地址一致：`baseline.contracts.<Module>.address`、`Registry[KEY_*]`、proxy implementation slot 三者一致。
2. 语义一致：模块 `apiVersion/schemaVersion` 与当前用例预期一致，关键接口可调用。

以 `LENDING_ENGINE_VIEW` 为例，live fee accounting 的关键断言依赖：

1. `apiVersion=2`
2. `schemaVersion=1`
3. `getOrderStateSnapshot(orderId)` 可用

如果地址一致但语义不一致（例如仍为 `apiVersion=1`），应优先判定为“模块版本未升级到位”，而不是 registry 映射错误。

### 11.6 BNB 单模块升级（LendingEngineView）推荐闭环

当需要只升级单个 view 模块时，按以下顺序执行：

1. 只升级目标模块：

```bash
pnpm -s exec hardhat run scripts/deploy/upgrade-lending-engine-view-bnb-testnet.ts --network bnbTestnet
```

2. 不重跑 deploy/fork/live，仅重建与审计 baseline/manifest/frontend 一致性：

```bash
RELEASE_SYNC_SKIP_BUILD=1 \
RELEASE_SYNC_SKIP_DEPLOY=1 \
RELEASE_SYNC_SKIP_FORK=1 \
RELEASE_SYNC_SKIP_LIVE=1 \
RELEASE_SYNC_REFERENCE_BASELINE_FILE=scripts/deployments/bnb-testnet/history/<newReleaseId>.baseline.json \
pnpm -s run deploy:sync-and-verify:bnb-testnet
```

3. 通过标准：

1. `summary.status=passed`
2. reference baseline implementation audit `unresolved=0`
3. `checks:deploy-baselines` 返回双网络 `OK`

### 11.7 防失误清单（升级后立即核对）

每次升级（尤其是单模块升级）结束后，必须逐项确认：

1. `scripts/deployments/bnb-testnet/baseline.json` 中目标模块 `implementationAddress` 已更新为新实现。
2. `scripts/deployments/bnb-testnet/history/<releaseId>.baseline.json` 已归档且与当前 baseline 的目标模块实现一致。
3. `scripts/deployments/bnb-testnet/manifest.json` 与 `frontend-config/networks/bnb-testnet.release.json` 的 `releaseId` 与 baseline 一致。
4. 关键 view 模块版本满足用例预期（例如 `LENDING_ENGINE_VIEW api=2 schema=1`）。
5. 升级后先跑目标 live 用例（例如 `live-fee-accounting`），再进入后续全量流程。

### 11.8 仅校验 view 模块版本仍不够：必须补下游 view-adapter 能力探针

本次 BNB live-fee-accounting 的实战结论：

1. `LENDING_ENGINE_VIEW` 已升级到 `apiVersion=2`，地址与 implementation 也一致。
2. 但 `getOrderStateSnapshot(orderId)` 仍可空 revert。
3. 根因在下游 `ORDER_ENGINE` 的 view-adapter 能力不完整：`getOrderStatusForView(orderId)` 对真实订单 revert，而 `getLoanOrderForView`、`getOrderTotalDueForView` 可调用。

因此发布前必须增加 adapter 能力探针（至少一笔真实订单）：

1. `ORDER_ENGINE.getLoanOrderForView(orderId)`
2. `ORDER_ENGINE.getOrderTotalDueForView(orderId)`
3. `ORDER_ENGINE.getOrderStatusForView(orderId)`

判定规则：

1. 以上三项任一失败，视为“语义不一致”，禁止将本轮升级判定为可放行。
2. 禁止仅依据 `apiVersion/schemaVersion` 或 implementation 地址放行。
3. 遇到该场景应优先修复/升级 `ORDER_ENGINE`（或其兼容层），而不是重复调整 registry 映射。
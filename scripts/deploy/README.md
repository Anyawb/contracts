# 智能合约部署与升级指南

## 概述

本目录不仅包含部署脚本，也包含升级后必须执行的同步、审计和上线前验证入口。

从当前仓库状态看，单次部署成功并不自动等于以下内容都已经完成：

1. core deploy output 已更新。
2. manifest 与 mock-suite 已刷新。
3. 前端网络配置已同步。
4. module keys、contract errors、ABI 已同步生成。
5. 链上 Registry 路由与 deploy output 已对齐。
6. implementation hash 与本地 artifact 已对齐。
7. live 所需角色已补齐。
8. fork、gate 9、gate 10 已按顺序通过。

因此，部署或升级完成后，必须继续执行“统一同步与审计入口”。

## 当前支持的网络与入口

### Localhost

1. 部署入口：[scripts/deploy/deploylocal.ts](deploylocal.ts)
2. 输出文件：[scripts/deployments/localhost.json](../deployments/localhost.json)

### Arbitrum Sepolia

1. 部署入口：[scripts/deploy/networks/arbitrum-sepolia/deploy.ts](networks/arbitrum-sepolia/deploy.ts)
2. preflight：[scripts/deploy/deploy-preflight.ts](deploy-preflight.ts)
3. 主要输出：
  [scripts/deployments/arbitrum-sepolia.json](../deployments/arbitrum-sepolia.json)
  [scripts/deployments/arbitrum-sepolia.manifest.json](../deployments/arbitrum-sepolia.manifest.json)
  [scripts/deployments/arbitrum-sepolia.mock-suite.json](../deployments/arbitrum-sepolia.mock-suite.json)

### BNB Testnet

1. 部署 wrapper：[scripts/deploy/deploy-bnb-testnet.ts](deploy-bnb-testnet.ts)
2. 核心部署脚本：[scripts/deploy/deploy-bnb-testnet-core.ts](deploy-bnb-testnet-core.ts)
3. 网络入口：[scripts/deploy/networks/bnb-testnet/deploy.ts](networks/bnb-testnet/deploy.ts)
4. preflight：[scripts/deploy/deploy-preflight.ts](deploy-preflight.ts)
5. 统一同步与审计入口：[scripts/deploy/sync-and-verify-bnb-testnet.ts](sync-and-verify-bnb-testnet.ts)

## 升级或部署后的强制要求

任何合约变更后，必须按下面顺序执行，不允许只跑其中一部分就视为完成。

### 1. 部署或升级合约

BNB Testnet：

```bash
pnpm -s run deploy:preflight:bnb-testnet
pnpm -s run deploy:bnb-testnet
```

### 2. 刷新部署产物

升级后必须刷新以下文件：

1. [scripts/deployments/bnb-testnet/core.json](../deployments/bnb-testnet/core.json)
2. [scripts/deployments/bnb-testnet/manifest.json](../deployments/bnb-testnet/manifest.json)
3. [scripts/deployments/bnb-testnet/baseline.json](../deployments/bnb-testnet/baseline.json)
4. [scripts/deployments/bnb-testnet/history](../deployments/bnb-testnet/history)
5. [scripts/deployments/bnb-testnet/mock-suite.json](../deployments/bnb-testnet/mock-suite.json)

其中：

1. `core.json` 只表示当前地址映射，不足以单独承担部署基线。
2. `baseline.json` 才是稳定部署基线，必须包含 releaseId、git commit、dirty 状态、compiler/build-info 锚点，以及 proxy -> implementation 快照。
3. `manifest.json` 和前端 release 产物应引用同一个 `baseline.json`，而不是各自独立漂移。
4. 每次同步还必须额外归档一份按 releaseId 命名的历史副本到 [scripts/deployments/bnb-testnet/history](../deployments/bnb-testnet/history)，否则下次刷新会覆盖掉上一次 release 的 baseline。
5. Arbitrum Sepolia 同样必须刷新 [scripts/deployments/arbitrum-sepolia.baseline.json](../deployments/arbitrum-sepolia.baseline.json)，不能只保留 [scripts/deployments/arbitrum-sepolia.json](../deployments/arbitrum-sepolia.json)。

### 3. 重新生成消费侧文件

升级后必须重新生成或刷新：

1. [frontend-config/networks/bnb-testnet.ts](../../frontend-config/networks/bnb-testnet.ts)
2. [frontend-config/networks/bnb-testnet.release.json](../../frontend-config/networks/bnb-testnet.release.json)
3. [frontend-config/contracts-bnb-testnet.ts](../../frontend-config/contracts-bnb-testnet.ts)
4. [frontend-config/moduleKeys.ts](../../frontend-config/moduleKeys.ts)
5. [frontend-config/contractErrors.ts](../../frontend-config/contractErrors.ts)
6. 必要 ABI 文档与 ABI 产物

对应命令：

```bash
pnpm -s run generate:module-keys
pnpm -s run generate:contract-errors
pnpm -s run docs:abi
```

### 4. 自动对账与阻断

升级后必须自动执行以下审计，任何关键差异直接阻断：

1. 链上 Registry 对 deploy output。
2. frontend config 对 deploy output。
3. implementation hash 对本地 artifact。
4. 关键运行时角色是否齐全。

不允许继续推进的情况包括：

1. deploy output 与链上 Registry 漂移。
2. frontend network config 与 deploy output 漂移。
3. 关键代理 implementation 与本地编译产物不匹配。
4. relayer、updater 或关键模块缺角色。

## 统一同步与审计入口

BNB Testnet 已新增统一入口：

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet
```

只做链上对账、不重新 build/deploy/fork/live 时，可使用：

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet:audit-only
```

如果要在 audit-only 过程中顺手把 relayer/updater/viewer 的关键角色补齐，可使用：

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet:audit-repair-roles
```

当前默认 reference baseline 已固定回退到最接近已确认 release 的历史归档：

```bash
scripts/deployments/bnb-testnet/history/bnb-testnet-20260414011126528.baseline.json
```

如果不想使用这份默认 reference baseline，可显式关闭：

```bash
RELEASE_SYNC_DISABLE_DEFAULT_REFERENCE_BASELINE=1 \
pnpm -s run deploy:sync-and-verify:bnb-testnet:audit-only
```

如果当前 checkout 已经继续演进，而链上仍停留在旧 release，可额外提供历史 baseline：

```bash
RELEASE_SYNC_REFERENCE_BASELINE_FILE=scripts/deployments/bnb-testnet/history/<releaseId>.baseline.json \
pnpm -s run deploy:sync-and-verify:bnb-testnet:audit-only
```

这不会放松正常发布校验；它只是在 audit-only 模式下，把“当前 artifacts 漂移”与“链上实际偏差”区分开来。若链上 runtime / implementation 命中 reference baseline，脚本会把这些失败解释为历史 release 命中，而不是直接把整次审计判为不可解释失败。

该入口按顺序执行：

1. compile、typecheck、e2e:typecheck
2. deploy preflight
3. deploy 或 upgrade
4. 刷新 `core.json`、`manifest.json`、`mock-suite.json`
5. 重新生成 `bnb-testnet.ts`、module keys、contract errors、ABI 文档
6. 自动对账链上 Registry、deploy output、frontend config、implementation hash
7. 自动检查关键角色
8. 自动运行 OrderEngine 实现一致性专项审计
9. 自动运行 live role readiness 专项审计
10. 自动跑 fork
11. 自动跑 gate 9
12. gate 9 通过后自动跑 gate 10

## 前端读取方式

前端不要自己去拼接或猜测本次升级结果，统一读取同步入口生成的稳定产物：

1. 构建期或代码内静态导入：[frontend-config/networks/bnb-testnet.ts](../../frontend-config/networks/bnb-testnet.ts)
2. 非 TypeScript 消费方、配置中心或 CI 分发优先读取：[frontend-config/networks/bnb-testnet.release.json](../../frontend-config/networks/bnb-testnet.release.json)
3. 部署取证、CI 归档、回滚锚点优先读取：[scripts/deployments/bnb-testnet/baseline.json](../deployments/bnb-testnet/baseline.json)
4. 地址读取用 `contracts`
5. 版本/发布时间/事实源读取用 `releaseId`、`generatedAt`、`sourceFiles`
6. 若需要知道某个地址对应哪个 Registry key，读取 `contracts.<ContractName>.registryKey`

推荐约束：

1. 前端页面运行时只消费一次同步入口生成的单一文件，不要分别读取 `core.json` 和前端地址表再自行比对。
2. 如果前端仓库是通过子模块或 CI 拉取本仓库产物，优先分发 `bnb-testnet.release.json`，因为它比纯地址表多了版本锚点。
3. 若当前前端直接 import TS 配置，则使用 `DEPLOYMENT_METADATA` + `CONTRACT_ADDRESSES` 作为统一入口，不再只读裸地址对象。

dry-run 入口：

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet:dry-run
```

用途：

1. 只验证编排与命令链条。
2. 不真正发起链上部署或 live 执行。

baseline 完整性检查：

```bash
pnpm -s run checks:deploy-baselines
```

该检查会阻断以下情况：

1. 已存在 `core.json`，但缺少配套 `baseline.json`。
2. `manifest.json` 或前端 release 产物没有引用同一个 `baseline.json`。
3. `baseline.json` 缺少 `git.commit`、compiler/build-info、或 proxy implementation 快照。

## 环境变量与协作要求

### 必需环境变量

至少需要：

1. `BNB_TESTNET_RPC_URL` 或 `BSC_TESTNET_RPC_URL`
2. `PRIVATE_KEY`

如需更精细角色区分，可额外设置：

1. `RELAYER_PRIVATE_KEY`
2. `UPDATER_PRIVATE_KEY`
3. `RELAYER_ADDRESS`
4. `UPDATER_ADDRESS`
5. `VIEWER_PRIVATE_KEY`
6. `VIEWER_ADDRESS`

### 推荐 live 严格参数

统一入口默认会使用或继承以下关键参数：

1. `LIVE_FAIL_ON_MISSING_RUNTIME_ROLES=1`
2. `LIVE_STRICT_FEE_ROUTER_GATE=1`
3. `LIVE_STRICT_BLOCKS_ONLY_DATAPUSH=1`
4. `LIVE_STRICT_BLOCKS_ONLY_PREMATURITY=0`

### 需要配合的角色

#### 协议研发

1. 明确本次升级涉及哪些代理、模块、Registry key。
2. 明确是否引入新 initializer / reinitializer。
3. 明确 rollback 是否允许以及限制条件。

#### 部署负责人

1. 执行 deploy 或 upgrade。
2. 确认 deploy output 与链上 Registry 一致。
3. 确认 implementation hash 与本地 artifact 一致。

#### 前端 / 集成方

1. 同步最新地址表。
2. 同步 module keys、ABI、错误码。
3. 确认读模型、事件、DataPush 语义没有沿用旧版本假设。

#### QA / 测试

1. 验证 fork。
2. 验证 gate 9。
3. gate 9 通过后验证 gate 10。

## 重要事实源说明

当前仓库中，BNB Testnet 的 live / fork 默认读取：

1. [scripts/deployments/bnb-testnet/core.json](../deployments/bnb-testnet/core.json)

不是读取前端网络配置作为唯一事实源。

但用于确认“这批地址对应哪次源码/哪套编译参数/哪些 implementation”的稳定事实源，应该是：

1. [scripts/deployments/bnb-testnet/baseline.json](../deployments/bnb-testnet/baseline.json)

这意味着：

1. `frontend-config/networks/bnb-testnet.ts` 过期，不会自动改变 live 读取地址。
2. 但它一旦过期，就会误导前端和人工排查，因此仍然必须同步。
3. `core.json` 如果没有配套 `baseline.json`，只能说明“现在指向哪里”，不能说明“它是从哪次源码和哪套 artifacts 生成的”。

## 不允许继续推进的条件

以下任一出现，直接阻断，不允许继续 fork/live：

1. `core.json` 缺失或不完整。
2. `manifest.json` 缺失或 `contracts` 为空。
3. `baseline.json` 缺失，或缺少 `git.commit`、compiler/build-info、implementation 快照。
4. `mock-suite.json` 为空或不可消费。
5. frontend network config 与 deploy output 不一致。
6. Registry key 与 deploy output 不一致。
7. implementation hash 与本地 artifact 不一致。
8. 关键角色缺失。
9. fork 未在当前 deploy output 基线上运行。
10. gate 9 未通过却继续进入 gate 10。

## 推荐日常命令

### 标准执行

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet
```

### 只验证编排

```bash
pnpm -s run deploy:sync-and-verify:bnb-testnet:dry-run
```

### 单独部署

```bash
pnpm -s run deploy:bnb-testnet
```

### 单独 fork

```bash
pnpm -s run test:live:release-gates:fork:bnb-testnet
```

### 单独完整 live Layer-A

```bash
pnpm -s run test:live:release-gates:bnb-testnet:layer-a
```

### 单独 gate 9

```bash
pnpm -s run test:live:release-gate9:bnb-testnet
```

### 单独 gate 10

```bash
pnpm -s run test:live:release-gate10:bnb-testnet
```

## 相关文档

1. [docs/Test-Guide/README.md](../../docs/Test-Guide/README.md)
2. [docs/Test-Guide/pre-launch-comprehensive-testing-requirements.md](../../docs/Test-Guide/pre-launch-comprehensive-testing-requirements.md)
3. [scripts/deploy/deploy-preflight.ts](deploy-preflight.ts)
4. [scripts/debug/audit-order-engine-deployment-consistency.ts](../debug/audit-order-engine-deployment-consistency.ts)
5. [scripts/tools/repair-registry-from-deploy-output.ts](../tools/repair-registry-from-deploy-output.ts)

## 结论

部署或升级不是一个“发完交易就结束”的动作，而是一条完整流水线：

1. 升级合约。
2. 刷新产物。
3. 生成消费侧文件。
4. 做链上与本地一致性审计。
5. 补齐角色。
6. 按顺序跑 fork、gate 9、gate 10。
7. 任一关键差异直接阻断。

当前仓库已经有统一入口承担这条流水线，但后续仍应继续加强自动化覆盖面，尤其是 manifest、mock-suite 和更全面的 implementation 审计。
# 智能合约部署脚本 (Smart Contract Deployment Scripts)

本目录包含 RWA Lending Platform 智能合约系统的部署脚本，支持部署到本地网络、Arbitrum Sepolia 测试网和 Arbitrum 主网。

## 📁 文件结构

```
scripts/deploy/
├── deploylocal.ts              # 本地网络部署脚本
├── deploy-arbitrum-sepolia.ts  # Arbitrum Sepolia 测试网部署脚本
├── deploy-arbitrum.ts          # Arbitrum 主网部署脚本
└── README.md                   # 本文档
```

## 🎯 脚本概览

### 1. deploylocal.ts - 本地网络部署

**用途**：在本地 Hardhat 网络部署完整的智能合约系统

**特点**：
- 每次部署前自动清理缓存和旧配置
- 使用 Mock 代币（MockUSDC）进行测试
- MIN_DELAY 设置为 60 秒（方便调试）
- 自动为本地管理员授予所有必要权限

**输出文件**：
- `scripts/deployments/localhost.json` - 部署地址记录
- `frontend-config/contracts-localhost.ts` - 前端配置文件

**运行方式**：
```bash
# 启动本地 Hardhat 节点
npm run node

# 在另一个终端运行部署脚本
npx hardhat run scripts/deploy/deploylocal.ts --network localhost
```

---

### 2. deploy-arbitrum-sepolia.ts - Arbitrum Sepolia 测试网部署

**用途**：部署到 Arbitrum Sepolia 测试网

**特点**：
- 环境检查和余额验证
- 自动备份钱包资产信息
- MIN_DELAY 设置为 2 天
- 从配置文件读取真实代币地址（不使用 Mock）
- 完整的预言机系统配置
- 奖励系统完整部署

**网络配置**：
- Chain ID: `421614`
- RPC URL: `https://sepolia-rollup.arbitrum.io/rpc`
- Explorer: `https://sepolia.arbiscan.io`

**输出文件**：
- `scripts/deployments/arbitrum-sepolia.json` - 部署地址记录
- `frontend-config/contracts-arbitrum-sepolia.ts` - 前端配置文件

**环境变量要求**：
```bash
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc  # 必需，推荐显式设置
PRIVATE_KEY=your_private_key                                    # 必需
ARBISCAN_API_KEY=your_api_key                                   # 可选（用于验证）
```

**运行方式**：
```bash
pnpm -s exec hardhat run scripts/deploy/deploy-arbitrum-sepolia.ts --network arbitrumSepolia
```

**推荐执行顺序**：
1. 准备一个专用的 Arbitrum Sepolia deployer，不要混用 localhost 或 fork 账户。
2. 为该地址充值足够测试 ETH，建议至少保留 `0.02 ETH`，脚本最低会检查 `0.01 ETH`。
3. 显式设置 `ARBITRUM_SEPOLIA_RPC_URL`，避免依赖本地 shell 的历史残留变量。
4. 首次建立真链基线时，必须直接运行部署，不要使用 `--skip-deploy`。
5. 部署成功后立刻执行 live-safe smoke，确认本轮产物可作为后续复跑基线。

**首次真链部署命令**：
```bash
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
PRIVATE_KEY=your_private_key \
pnpm -s exec hardhat run scripts/deploy/deploy-arbitrum-sepolia.ts --network arbitrumSepolia
```

**推荐的部署后验收命令**：
```bash
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
PRIVATE_KEY=your_private_key \
pnpm -s run e2e:pre-release:arbitrum-sepolia-live
```

**何时允许使用 `--skip-deploy`**：
- 仅当 `scripts/deployments/arbitrum-sepolia.json` 是刚刚通过 live 验收生成的最新产物。
- 仅当该产物中的 `Registry` 在 Arbitrum Sepolia 上 `getCode != 0x`。
- 仅当你只是想复跑 invariant 和 live-safe smoke，而不是重新建立部署基线。

**复跑 live gate（跳过重新部署）**：
```bash
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
PRIVATE_KEY=your_private_key \
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-pre-release.ts --arbitrum-sepolia-live --skip-deploy
```

---

### 3. deploy-arbitrum.ts - Arbitrum 主网部署

**用途**：部署到 Arbitrum 主网

**特点**：
- 严格的环境检查（余额要求 0.1 ETH）
- MIN_DELAY 设置为 7 天（更保守）
- 从配置文件读取真实代币地址
- 完整的系统部署（52+ 个合约）
- 主网级别的安全配置

**网络配置**：
- Chain ID: `42161`
- RPC URL: `https://arb1.arbitrum.io/rpc`
- Explorer: `https://arbiscan.io`

**输出文件**：
- `scripts/deployments/arbitrum.json` - 部署地址记录
- `frontend-config/contracts-arbitrum.ts` - 前端配置文件

**环境变量要求**：
```bash
PRIVATE_KEY=your_private_key          # 必需
ARBISCAN_API_KEY=your_api_key        # 可选（用于验证）
```

**运行方式**：
```bash
npx hardhat run scripts/deploy/deploy-arbitrum.ts --network arbitrum
```

---

## 🏗️ 部署架构

所有部署脚本遵循相同的架构模式，部署顺序如下：

### 阶段 1: Registry 核心模块（Scheme A）
1. **Registry** - 主注册表合约（UUPS 可升级，单一入口/单一 Proxy）
2. **RegistryDynamicModuleKey** - 动态模块键注册表（可选，独立存储/独立升级）

### 阶段 2: 访问控制与白名单
6. **AccessControlManager** - 权限管理（非升级合约）
7. **AssetWhitelist** - 资产白名单
8. **AuthorityWhitelist** - 授权机构白名单

### 阶段 3: 预言机系统
9. **PriceOracle** - 价格预言机
10. **PriceUpdater** - 统一价格更新器
11. 配置资产（从配置文件读取）

补充说明（2026-03-23）：
- deploy 脚本和文档主名已统一为 PriceUpdater / PRICE_UPDATER
- 为保持链上 Registry hash 稳定，部署脚本实际写入的 raw key 仍是 COINGECKO_PRICE_UPDATER
- 因此部署日志会优先显示 PRICE_UPDATER，必要时附带 compat raw: COINGECKO_PRICE_UPDATER

### 阶段 4: 费用路由
12. **FeeRouter** - 费用路由
13. **FeeRouterView** - 费用路由视图

### 阶段 5: Vault 核心系统
14. **CollateralManager** - 抵押品管理器
15. **LendingEngine** - 借贷引擎
16. **LiquidationRiskManager** - 清算风险管理器（需要链接库）
17. **VaultBusinessLogic** - Vault 业务逻辑
18. **VaultRouter** - Vault 视图（临时部署用于初始化）
19. **VaultCore** - Vault 核心
20. **VaultLendingEngine** - Vault 借贷引擎
21. **EarlyRepaymentGuaranteeManager** - 提前还款保证金管理器
22. **GuaranteeFundManager** - 担保基金管理器

### 阶段 6: 视图模块
24. **HealthView** - 健康度视图
25. **RegistryView** - 注册表视图
26. **StatisticsView** - 统计视图
27. **PositionView** - 持仓视图
28. **PreviewView** - 预览视图
29. **DashboardView** - 仪表板视图
30. **UserView** - 用户视图
31. **AccessControlView** - 访问控制视图
32. **CacheOptimizedView** - 缓存优化视图
33. **LendingEngineView** - 借贷引擎视图
34. **RiskView** - 风险视图
35. **ViewCache** - 视图缓存
36. **EventHistoryManager** - 事件历史管理器
37. **ValuationOracleView** - 估值预言机视图
38. **LiquidatorView** - 清算视图
39. **BatchView** - 批量视图

### 阶段 7: 监控模块
40. **DegradationCore** - 降级核心
41. **DegradationStorage** - 降级存储
42. **ModuleHealthView** - 模块健康视图
43. **DegradationMonitor** - 降级监控器

### 阶段 8: 奖励系统
44. **EasyToken** - 奖励通证（唯一通证）
45. **RewardManagerCore** - 奖励管理核心
46. **RewardManager** - 奖励管理器
47. **RewardAccrualManager** - 惩罚账本与扣减 SSOT
48. **RewardConfig** - 奖励参数配置
49. **EarnConfig** - Earn 参数配置（Registry key: `REWARD_EARN_CONFIG`）
50. **EasyEmissionConfig** - Easy 发放参数配置
51. **EasyEmissionController** - Easy 唯一 mint 路径
52. **EasyConsumption** - Easy 消费入口
53. **EasyRecycleDistributor** - Easy 回收/75-15-10 分配与补结算路径
54. **FeatureRegistry** - Reward 功能语义注册表
55. **RewardView** - Reward 统一读模型 / DataPush 镜像面

### 阶段 9: 其他模块
56. **LoanNFT** - 贷款 NFT
57. **MockUSDC** - Mock USDC（仅本地网络）

### 阶段 10: 模块注册
- 将所有已部署的模块注册到 Registry
- 设置动态模块键注册表
- 绑定关键模块（LIQUIDATION_MANAGER, HEALTH_VIEW 等）

### 阶段 11: 权限配置
- 为部署者授予必要的权限
- 配置 EasyToken 的唯一 mint / burn 角色
- 确保 `EasyEmissionController` 为 sole minter
- 确保仅 `RewardAccrualManager` 与 `EasyRecycleDistributor` 持有 `BURNER_ROLE`
- 撤销 `RewardManagerCore` 的历史 `BURNER_ROLE`
- 配置预言机系统权限

### 阶段 12: 前端配置生成
- 生成前端配置文件（TypeScript）
- 包含所有合约地址和网络配置

---

## 🔧 部署配置

### 网络特定配置

| 配置项 | 本地网络 | Arbitrum Sepolia | Arbitrum 主网 |
|--------|---------|------------------|---------------|
| MIN_DELAY | 60 秒 | 2 天 | 7 天 |
| 代币来源 | MockUSDC | 配置文件 | 配置文件 |
| 余额要求 | 无 | 0.01 ETH | 0.1 ETH |
| 环境检查 | 无 | 完整检查 | 完整检查 |
| 备份功能 | 无 | 有 | 无 |

### 资产配置文件

测试网和主网部署需要资产配置文件：

**Arbitrum Sepolia**: `scripts/assets.arbitrum-sepolia.json`
```json
{
  "network": "arbitrum-sepolia",
  "chainId": 421614,
  "assets": [
    {
      "address": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      "sourceId": "usd-coin",
      "decimals": 6,
      "maxPriceAge": 3600,
      "active": true
    }
  ]
}
```

**Arbitrum**: `scripts/assets.arbitrum.json`
```json
{
  "network": "arbitrum",
  "chainId": 42161,
  "assets": [
    {
      "address": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      "sourceId": "usd-coin",
      "decimals": 6,
      "maxPriceAge": 3600,
      "active": true
    }
  ]
}
```

---

## 📋 部署前准备

### 1. 环境变量配置

创建 `.env` 文件（参考 `.env.template`）：

```bash
# 必需
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
PRIVATE_KEY=your_private_key_here

# 可选（用于合约验证）
ARBISCAN_API_KEY=your_arbiscan_api_key

# 兼容旧变量名，仅在未设置 ARBITRUM_SEPOLIA_RPC_URL 时作为回退
ARBITRUM_SEPOLIA_URL=

# 本地网络可选
LOCAL_ADMIN_ADDRESS=your_local_admin_address
```

补充说明：

- 当前 Hardhat 配置优先读取 `ARBITRUM_SEPOLIA_RPC_URL`，其次才回退到 `ARBITRUM_SEPOLIA_URL`。
- `PRIVATE_KEY` 必须是去掉 `0x` 前缀后的十六进制私钥，且对应地址需要有足够的 Arbitrum Sepolia 测试 ETH。
- `ARBISCAN_API_KEY` 不是部署必需项，但如果后续要执行 `hardhat verify`，建议一开始就配置好。

### 2. 安装依赖

```bash
pnpm install
```

### 3. 编译合约

```bash
pnpm -s run compile
```

### 4. 配置 Hardhat 网络

确保 `hardhat.config.ts` 中配置了正确的网络：

```typescript
networks: {
  localhost: {
    url: "http://127.0.0.1:8545"
  },
  arbitrumSepolia: {
    url: process.env.ARBITRUM_SEPOLIA_RPC_URL || process.env.ARBITRUM_SEPOLIA_URL || "",
    chainId: 421614,
    accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
  },
  arbitrum: {
    url: process.env.ARBITRUM_RPC_URL || process.env.ARBITRUM_URL || "",
    chainId: 42161,
    accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
  }
}
```

注意：Hardhat 网络名是 `arbitrumSepolia`，不是 `arbitrum-sepolia`。命令行里写错网络名会直接导致部署命令失败。

---

## 🧪 Arbitrum Sepolia 部署执行入口

标准化部署 Runbook 已迁移到 [docs/Usage-Guide/runbook/README.md](../../docs/Usage-Guide/runbook/README.md)。

这里不再维护第二套真链部署 / live 验收步骤。统一入口如下：

- live deploy 基线：看 runbook 第 5.4 节
- live skip-deploy 复跑：看 runbook 第 5.5 节
- 发布前最终判定：看 runbook 第 6 节

本 README 继续保留脚本说明、部署架构、配置要求和单项命令索引。

### 常用单项命令

```bash
# 仅部署
pnpm -s exec hardhat run scripts/deploy/deploy-arbitrum-sepolia.ts --network arbitrumSepolia

# 部署后先跑 Reward 绑定/角色检查
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
LOCALHOST_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
pnpm -s run checks:reward-monitor:registry-bindings

ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
LOCALHOST_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
pnpm -s run checks:reward-monitor:role-bindings

# 单跑 reward live-safe smoke
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/reward-smoke-local.ts --network arbitrumSepolia

# 单跑 funds-flow live-safe smoke
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-create-order.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-conservation.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-local.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-invariants-suite.ts --network arbitrumSepolia
```

Reward 子系统当前建议的最小放行集：

```bash
pnpm -s run compile
pnpm exec hardhat test test/Reward/EasyEconomics.integration.test.ts

ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
LOCALHOST_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
pnpm -s run checks:reward-monitor:config-events

ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
LOCALHOST_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
pnpm -s run checks:reward-monitor:breakglass

ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
LOCALHOST_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
pnpm -s run checks:reward-monitor:registry-bindings

ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
LOCALHOST_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
pnpm -s run checks:reward-monitor:role-bindings

READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/reward-smoke-local.ts --network arbitrumSepolia
```

说明：`RewardManagerCore` 不再允许直接作为 Easy burn 路径；部署标准以 `EasyEmissionController` 唯一 mint、`RewardAccrualManager + EasyRecycleDistributor` 唯一 burn 为准。

---

## 🚀 快速开始

### 本地开发部署

```bash
# 1. 启动本地节点（终端 1）
npm run node

# 2. 部署合约（终端 2）
npx hardhat run scripts/deploy/deploylocal.ts --network localhost
```

### 测试网部署

测试网部署与 live-safe 验收的标准步骤已经迁移到 [docs/Usage-Guide/runbook/README.md](../../docs/Usage-Guide/runbook/README.md)。

这里不再重复维护首轮 deploy、skip-deploy 复跑和验收顺序。

### 主网部署

```bash
# ⚠️ 主网部署前请仔细检查所有配置
# 1. 确保环境变量已配置
# 2. 确保账户有足够的 ETH（至少 0.1 ETH）
# 3. 检查所有配置是否正确
# 4. 运行部署脚本
npx hardhat run scripts/deploy/deploy-arbitrum.ts --network arbitrum
```

---

## 📊 部署输出

### 部署地址文件

部署完成后，会在 `scripts/deployments/` 目录生成 JSON 文件：

```json
{
  "Registry": "0x...",
  // "RegistryCore": REMOVED (Scheme A: no compat proxies)
  "AccessControlManager": "0x...",
  ...
}
```

### 前端配置文件

同时会在 `frontend-config/` 目录生成 TypeScript 配置文件：

```typescript
export const CONTRACT_ADDRESSES = {
  Registry: '0x...',
  // RegistryCore: REMOVED (Scheme A: no compat proxies)
  ...
};

export const NETWORK_CONFIG = {
  chainId: 421614,
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  explorer: 'https://sepolia.arbiscan.io',
  name: 'arbitrum-sepolia'
};
```

---

## 🔍 部署验证

### 检查部署状态

```bash
# 查看部署地址文件
cat scripts/deployments/localhost.json

# 查看前端配置
cat frontend-config/contracts-localhost.ts
```

### 验证合约

```bash
# 验证单个合约（需要 API Key）
npx hardhat verify --network arbitrumSepolia <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS>
```

### 测试部署

部署完成后，可以运行测试脚本验证：

```bash
npm test
```

---

## ⚠️ 注意事项

### 本地网络

- 每次重启本地节点后，需要重新部署
- 本地部署会自动清理旧配置
- MockUSDC 会自动部署用于测试

### 测试网

- 确保账户有足够的测试 ETH（至少 0.01 ETH）
- 部署前会自动检查网络连接和余额
- 会自动备份钱包资产信息
- 需要配置资产文件（`assets.arbitrum-sepolia.json`）
- 首次建立真链基线时不要使用 `--skip-deploy`
- 只有 live gate 验收通过的 `scripts/deployments/arbitrum-sepolia.json` 才能作为后续复跑基线

### 主网

- ⚠️ **主网部署不可逆，请仔细检查所有配置**
- 确保账户有足够的 ETH（至少 0.1 ETH）
- MIN_DELAY 设置为 7 天，更保守
- 需要配置资产文件（`assets.arbitrum.json`）
- 建议先在测试网完整测试后再部署主网

### 通用注意事项

1. **私钥安全**：永远不要将私钥提交到版本控制系统
2. **Gas 费用**：部署大量合约需要较多 Gas，确保账户余额充足
3. **网络延迟**：部署过程可能需要较长时间，请耐心等待
4. **错误处理**：如果部署失败，检查错误信息并修复后重新运行
5. **增量部署**：脚本支持增量部署，已部署的合约不会重复部署

---

## 🔄 增量部署

所有部署脚本支持增量部署：

- 如果合约已部署，脚本会跳过该合约
- 只部署缺失的合约
- 已部署的合约地址会从部署文件中读取

**重新部署单个合约**：

如果需要重新部署某个合约，可以：
1. 从部署文件中删除该合约的地址
2. 重新运行部署脚本

---

## 🛠️ 故障排除

### 常见问题

**1. 编译错误**
```bash
# 清理缓存并重新编译
npm run clean
npm run compile
```

**2. 网络连接失败**
- 检查 RPC URL 是否正确
- 检查网络连接
- 尝试使用其他 RPC 端点

**3. 余额不足**
- 检查账户余额
- 测试网可以通过水龙头获取测试 ETH

**4. 权限错误**
- 检查私钥是否正确
- 检查账户是否有部署权限

**5. 合约验证失败**
- 检查构造函数参数是否正确
- 确保使用了正确的编译器版本

---

## 📚 相关文档

- [架构指南](../docs/Architecture-Guide.md)
- [Registry 系统](../docs/registry-deployment.md)
- [部署工具指南](../docs/cleanup-tools-guide.md)
- [环境变量配置](../docs/environment-variables.md)

---

## 🔗 相关脚本

- `scripts/utils/configure-assets.ts` - 资产配置工具
- `scripts/utils/deploymentUtils.ts` - 部署工具函数
- `scripts/utils/saveAddress.ts` - 地址保存工具

---

## 📝 更新日志

### 最新更新

- ✅ 统一了所有部署脚本的结构
- ✅ 添加了完整的模块注册逻辑
- ✅ 支持动态模块键注册表
- ✅ 自动生成前端配置文件
- ✅ 完善了权限配置流程

---

## 📞 支持

如有问题，请参考：
- [项目 README](../../README.md)
- [智能合约标准](../docs/SmartContractStandard.md)
- [测试文件标准](../docs/test-file-standards.md)

---

## 📄 许可证

MIT License

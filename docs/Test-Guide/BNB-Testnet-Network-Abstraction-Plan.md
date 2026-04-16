# BNB 测试网目录骨架与网络抽象方案

## 目标

- 在不立即重写整套 live test 的前提下，先把网络抽象层搭起来。
- 让 Arbitrum Sepolia 继续可用，同时为 BNB 测试网接入预留稳定骨架。
- 把“共享逻辑”和“网络差异”拆开，避免继续堆积 `-arbitrum-sepolia` 风格的横向复制文件。

## 适用范围

- `hardhat.config.ts`
- `package.json`
- `scripts/deploy/`
- `scripts/deployments/`
- `scripts/tests/live-test/`
- `scripts/tests/tools/`
- `deployments/`
- `frontend-config/`
- `docs/Usage-Guide/runbook/`

## 当前问题

当前仓库的链差异主要不在 Solidity 协议层，而在脚本与配置层：

- 网络名耦合：大量脚本直接写死 `arbitrumSepolia`。
- 文件名耦合：大量 live 脚本采用 `*-arbitrum-sepolia.ts`。
- 输出路径耦合：deploy output、asset pack、frontend config、runbook 都跟 Arbitrum Sepolia 强绑定。
- runner 耦合：`run-single-live-with-sweep.sh`、`run-cross-live-matrix-with-sweep.sh` 默认路径和默认网络都只认识 Arbitrum Sepolia。

这类结构继续横向复制到 BNB 测试网，短期能跑，但后续会出现三个问题：

- 同一类测试需要维护两到三份脚本。
- 地址文件、资产包、部署清单的命名会越来越散。
- 新增第三条链时，需要再复制一整层脚本和命令。

## 目标结构

建议采用“共享逻辑保留原位，网络差异下沉到 profile 和 network 子目录”的方式。

这里有一个明确结论：

- Arbitrum Sepolia 和 BNB 相关文件夹应该分开。
- 但 `hardhat.config.ts` 不建议拆成根目录下多份并列配置文件。

也就是说，目录层面按链拆开，Hardhat 入口层面保持单文件统一管理。

推荐骨架如下：

```text
scripts/
  config/
    networks/
      arbitrum-sepolia.ts
      bnb-testnet.ts
    profiles/
      live.ts
      deploy.ts
      assets.ts
  deploy/
    shared/
      deploy-core.ts
      deploy-mock-assets.ts
      export-rwa-price-catalog.ts
    networks/
      arbitrum-sepolia/
        deploy.ts
        post-deploy.ts
      bnb-testnet/
        deploy.ts
        post-deploy.ts
  deployments/
    arbitrum-sepolia/
      core.json
      manifest.json
      mock-suite.json
    bnb-testnet/
      core.json
      manifest.json
      mock-suite.json
    localhost/
      core.json
      manifest.json
  tests/
    live-test/
      shared/
        _networkRetry.ts
        _mockLiveUtils.ts
        _fundsFlowLive.ts
        _rewardLive.ts
        _freshBorrowerManager.ts
      scenarios/
        live-platform-baseline.ts
        live-preflight.ts
        live-liquidation.ts
        live-release-gates.ts
        live-reward-lender-view.ts
      networks/
        arbitrum-sepolia/
          profile.ts
          env.ts
          live-platform-baseline.ts
          live-preflight.ts
          live-liquidation.ts
          live-release-gates.ts
        bnb-testnet/
          profile.ts
          env.ts
          live-platform-baseline.ts
          live-preflight.ts
          live-liquidation.ts
          live-release-gates.ts
    tools/
      shared/
        live-test-cases.ts
        network-profile.ts
      run-single-live-with-sweep.sh
      run-cross-live-matrix-with-sweep.sh
deployments/
  assets/
    arbitrum-sepolia/
      assets.json
      assets.mock.json
      mock-assets.json
      rwa-price-catalog.json
    bnb-testnet/
      assets.json
      assets.mock.json
      mock-assets.json
      rwa-price-catalog.json
frontend-config/
  networks/
    arbitrum-sepolia.ts
    bnb-testnet.ts
docs/
  Usage-Guide/
    runbook/
      arbitrum-sepolia/
        live-platform-baseline.md
        mock-assets.md
      bnb-testnet/
        live-platform-baseline.md
        mock-assets.md
```

      ## 目录拆分的明确要求

      你这次补 BNB 时，建议直接按链拆目录，不要继续与 Arbitrum Sepolia 混放在同一层文件名里。

      推荐最少拆开下面几块：

      - `scripts/deploy/networks/arbitrum-sepolia/`
      - `scripts/deploy/networks/bnb-testnet/`
      - `scripts/tests/live-test/networks/arbitrum-sepolia/`
      - `scripts/tests/live-test/networks/bnb-testnet/`
      - `scripts/deployments/arbitrum-sepolia/`
      - `scripts/deployments/bnb-testnet/`
      - `deployments/assets/arbitrum-sepolia/`
      - `deployments/assets/bnb-testnet/`
      - `frontend-config/networks/arbitrum-sepolia.ts`
      - `frontend-config/networks/bnb-testnet.ts`
      - `docs/Usage-Guide/runbook/arbitrum-sepolia/`
      - `docs/Usage-Guide/runbook/bnb-testnet/`

      这样做的结果是：

      - 一眼能看出哪一套文件属于哪条链。
      - deploy output、asset pack、runbook、frontend config 都能自然对齐。
      - BNB 后续如果拆成 `bnb-mainnet` 或 `opbnb-testnet`，可以直接平移扩展。

## 目录拆分原则

### 1. `shared` 只放不依赖具体链名的逻辑

包括：

- 通用重试
- 通用 sweep
- 通用断言
- 通用 borrower/funder 辅助
- 通用 reward/funds-flow/liquidation 校验器

这类文件不应该出现 `arbitrumSepolia`、`bnbTestnet` 这样的硬编码网络判断，最多只接受一个 network profile。

### 2. `networks/<slug>/` 只放网络特有输入

包括：

- chainId
- hardhat network key
- 默认 RPC 环境变量名
- gas 费策略
- block explorer 配置
- deploy output 路径
- asset 文件路径
- mock asset pack 路径
- frontend config 输出路径
- live test 风控阈值和超时

### 3. `scenarios/` 表示测试语义，不表示网络

例如：

- `live-platform-baseline.ts`
- `live-release-gates.ts`
- `live-liquidation.ts`

这些文件的职责是定义“测什么”，不要定义“在哪条链测”。

### 4. `networks/<slug>/<scenario>.ts` 只做薄包装

网络入口文件只负责三件事：

- 载入对应 `profile`
- 调用共享 scenario
- 注入本链需要的 env/path/defaults

也就是说，BNB 测试网新增时，理想状态不是复制一整份逻辑，而是复制一层很薄的 wrapper。

## 命名规范

建议统一三套命名：

- Hardhat network key：`arbitrumSepolia`、`bnbTestnet`
- 文件 slug：`arbitrum-sepolia`、`bnb-testnet`
- 目录名：与文件 slug 保持一致

建议不要直接把目录命名成 `bsc`，因为未来可能还有：

- BNB Smart Chain Testnet
- BNB Mainnet
- opBNB Testnet
- opBNB Mainnet

如果现在先用 `bnb-testnet`，以后再加 `bnb-mainnet`、`opbnb-testnet` 会更顺。

## 配置拆分方案

### 一层：基础网络配置

建议新增：

- `scripts/config/networks/arbitrum-sepolia.ts`
- `scripts/config/networks/bnb-testnet.ts`

每个文件只描述网络事实，不描述业务流程。

建议字段：

```ts
export interface NetworkConfig {
  key: string;
  slug: string;
  chainId: number;
  rpcEnv: string;
  explorerBaseUrl?: string;
  nativeSymbol: string;
  defaultConfirmations: number;
  gasMode: "eip1559" | "legacy";
}
```

BNB 测试网第一版建议：

- `key`: `bnbTestnet`
- `slug`: `bnb-testnet`
- `chainId`: `97`
- `gasMode`: 优先按实际 RPC 能力决定，先预留为配置项，不写死在脚本里

### 二层：部署配置

建议新增：

- `scripts/config/profiles/deploy.ts`

负责把网络事实映射到部署输出路径：

```ts
export interface DeployProfile {
  deployScriptEntry: string;
  deployOutputFile: string;
  manifestFile: string;
  mockSuiteFile?: string;
  frontendConfigFile?: string;
  assetsFile: string;
  mockAssetsFile?: string;
  rwaPriceCatalogFile?: string;
}
```

### 三层：live test 配置

建议新增：

- `scripts/config/profiles/live.ts`

职责：

- 统一 live runner 默认路径
- 定义 sweep 行为
- 定义 scenario 允许跳过项
- 定义链上等待、重试、节流参数

建议字段：

```ts
export interface LiveTestProfile {
  networkKey: string;
  networkSlug: string;
  deployOutputFile: string;
  assetsFile: string;
  mockAssetsFile?: string;
  freshBorrowerSweepEnabled: boolean;
  defaultTimeoutMs: number;
  retryCount: number;
  retryBackoffMs: number;
  scenarioAllowlist?: string[];
}
```

### 四层：资产与地址配置

建议把现在散落的：

- `deployments/assets.arbitrum-sepolia.json`
- `deployments/assets.arbitrum-sepolia.mock.json`
- `deployments/mock-assets.arbitrum-sepolia.json`

逐步收敛为：

```text
deployments/assets/arbitrum-sepolia/assets.json
deployments/assets/arbitrum-sepolia/assets.mock.json
deployments/assets/arbitrum-sepolia/mock-assets.json
deployments/assets/arbitrum-sepolia/rwa-price-catalog.json

deployments/assets/bnb-testnet/assets.json
deployments/assets/bnb-testnet/assets.mock.json
deployments/assets/bnb-testnet/mock-assets.json
deployments/assets/bnb-testnet/rwa-price-catalog.json
```

这样做的好处是 runner 不再需要拼接一堆特例文件名，而只需要知道 network slug。

## `hardhat.config.ts` 是否需要拆开

结论先说：

- 推荐保留一个根目录下的 `hardhat.config.ts`。
- 不推荐在根目录放两份或多份 `hardhat.*.config.ts` 作为长期方案。

### 推荐方案：一个 `hardhat.config.ts`，统一挂多条链

这是更稳的做法，原因有三点：

- Hardhat 本来就是按一个配置文件管理多 network。
- 你的编译器版本、paths、etherscan、solidity optimizer、typechain 行为，本质上应该是全仓统一的，而不是按链分叉。
- deploy 和 live test 的差异，主要应该由 `networks/<slug>.ts` 和 `profiles/*.ts` 决定，而不是让 Hardhat 根配置分叉。

推荐理解方式：

- `hardhat.config.ts` 负责“这个仓库怎么编译、怎么识别网络、怎么加载插件”。
- `scripts/config/networks/*.ts` 负责“某条链的 RPC、chainId、gas、浏览器、环境变量名”。
- `scripts/config/profiles/*.ts` 负责“某条链的 deploy/live 路径和行为默认值”。

也就是说，`hardhat.config.ts` 是统一入口，链差异从它外面注入，而不是复制多个 Hardhat 根配置。

### 可以拆成多份吗

可以，但只适合临时过渡，不适合作为最终结构。

比如下面这种：

- `hardhat.config.ts`
- `hardhat.bnb-testnet.config.ts`
- `hardhat.arbitrum-sepolia.config.ts`

技术上是可行的，但长期问题很明显：

- 插件配置容易漂移。
- 编译器和路径设置容易出现一边改了另一边忘记改。
- package.json 和 CI 命令会变复杂。
- 以后第三条链进来时，又要再复制一份。

所以如果只是为了快速验证 BNB 能否接入，短期分文件可以应急；但如果目标是仓库长期维护，应该收敛回单一 `hardhat.config.ts`。

### 什么时候才建议拆多份 Hardhat 配置

只有在下面这类情况才值得考虑：

- 两条链需要完全不同的 Solidity 编译目标。
- 两条链需要完全不同的插件集。
- 两条链需要完全不同的 source paths 或 artifact paths。

你当前这个仓库不属于这种情况。你现在面对的是多链部署和多链 live test，不是两套互相独立的 Hardhat 工程。

### 最终建议

建议固定成下面这个原则：

- 根目录只有一个 `hardhat.config.ts`。
- 按链分目录。
- 按链拆 network config 和 runtime profile。
- 不按链复制 Hardhat 根配置。

## 对现有脚本的落地改法

### 1. `hardhat.config.ts`

目标：

- 新增 `bnbTestnet` network
- 把 RPC、账户、gas 相关配置抽到 network config 读取层

建议结果：

- `hardhat.config.ts` 只保留 Hardhat 所需结构
- 网络事实从 `scripts/config/networks/*.ts` 导入

### 2. `package.json`

不要继续新增一排排：

- `test:live:dryrun:arbitrum-sepolia`
- `test:live:dryrun:bnb-testnet`
- `test:live:dryrun:opbnb-testnet`

建议改成两层命令：

```text
test:live -- --network arbitrumSepolia --scenario release-gates
test:live -- --network bnbTestnet --scenario release-gates
deploy:network -- --network bnbTestnet
```

也就是：

- 脚本名表达动作
- 参数表达网络

### 3. `scripts/tests/tools/run-single-live-with-sweep.sh`

现状问题：

- 默认文件路径和默认 network 都是 Arbitrum Sepolia

目标改法：

- 只接收 `--network`
- 通过 `network-profile.ts` 解析对应 deploy/assets/mock-assets 路径
- runner 本身不再认识具体文件名

### 4. `scripts/tests/live-test/`

建议从“按链命名文件”转为“共享场景 + 网络入口”结构。

第一阶段不要求一次性迁完，可按下面方式平滑过渡：

- 保留现有 `live-*-arbitrum-sepolia.ts`
- 新增 `shared/`、`scenarios/`、`networks/bnb-testnet/`
- 新网络先只走新结构
- Arbitrum Sepolia 后续逐步迁入新结构

这可以避免一次性大迁移导致 live 流程失稳。

## BNB 测试网第一版最小骨架

第一阶段建议先只补下面这些文件：

```text
docs/BNB-Testnet-Network-Abstraction-Plan.md

scripts/config/networks/bnb-testnet.ts
scripts/config/profiles/deploy.ts
scripts/config/profiles/live.ts

scripts/deploy/networks/bnb-testnet/deploy.ts

scripts/tests/live-test/networks/bnb-testnet/profile.ts
scripts/tests/live-test/networks/bnb-testnet/live-preflight.ts
scripts/tests/live-test/networks/bnb-testnet/live-platform-baseline.ts

scripts/deployments/bnb-testnet/core.json
scripts/deployments/bnb-testnet/manifest.json

deployments/assets/bnb-testnet/assets.json
deployments/assets/bnb-testnet/assets.mock.json
deployments/assets/bnb-testnet/mock-assets.json

frontend-config/networks/bnb-testnet.ts

docs/Usage-Guide/runbook/bnb-testnet/live-platform-baseline.md
```

这一版先不追求覆盖所有 live case，只追求三件事：

- 网络能配起来
- 部署输出能收敛到统一目录
- 最核心的 preflight/baseline 能跑

## 迁移顺序

### Phase 1：先抽配置，不动场景逻辑

- 增加 `scripts/config/networks/`
- 增加 `scripts/config/profiles/`
- 给 runner 增加 network profile 读取能力
- 新增 `bnbTestnet` 到 `hardhat.config.ts`

### Phase 2：给 BNB 测试网铺最小入口

- 增加 deploy wrapper
- 增加 preflight/baseline wrapper
- 增加 assets 与 deployment 目录
- 增加 runbook

### Phase 3：把 Arbitrum Sepolia 渐进迁入同一抽象层

- 把 `*-arbitrum-sepolia.ts` 逐步迁到 `scenarios/` + `networks/arbitrum-sepolia/`
- runner 完全从 profile 读取路径
- `package.json` 从“按链写死脚本名”切到“按动作 + 参数”

### Phase 4：扩展更多链

完成上述抽象后，再加：

- `bnb-mainnet`
- `opbnb-testnet`
- `opbnb-mainnet`

成本会明显下降。

## 关键决策

### 决策一：BNB 测试网默认指向 BNB Smart Chain Testnet

第一版默认采用：

- hardhat key：`bnbTestnet`
- slug：`bnb-testnet`
- chainId：`97`

如果后续真实目标改为 opBNB Testnet，不建议复用同一 slug，而是单独建立：

- hardhat key：`opbnbTestnet`
- slug：`opbnb-testnet`

### 决策二：优先改“入口层”，不立刻改“协议层”

原因：

- Solidity 协议层大体是 EVM 通用的
- 当前真正阻碍多链的是脚本、路径、命名和运行约定

### 决策三：不建议一次性重命名所有历史文件

原因：

- live 脚本当前已形成可运行基线
- 大规模重命名会影响排障与历史命令
- 适合采用“双轨迁移”，先让新网络走新结构，再把旧网络逐步归并

## 建议的下一步

如果要把这份方案进入可执行阶段，推荐下一步按下面顺序落：

1. 先补 `scripts/config/networks/bnb-testnet.ts` 与 profile 读取层。
2. 再改 `hardhat.config.ts`，把 `bnbTestnet` 配进去。
3. 然后改 `run-single-live-with-sweep.sh`，让它从 network profile 自动解析路径。
4. 最后补 BNB 测试网的 preflight 和 baseline 两个最小 live wrapper。

## 结论

BNB 测试网接入不应该继续走“复制一套 `-arbitrum-sepolia` 文件”的路线，而应该从现在开始建立：

- 统一 network config
- 统一 deploy/live profile
- 统一 assets/deployments 目录
- 场景与网络分离的 live-test 结构

这样做的结果是：

- 现在能接 BNB 测试网
- 后面还能平滑扩展 BNB 主网或 opBNB
- 不会继续放大当前脚本层的命名和路径耦合
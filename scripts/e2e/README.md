# E2E 测试脚本说明

本目录包含完整的端到端（End-to-End）测试脚本，用于在本地 Hardhat 节点上验证业务逻辑和 View 层功能。

## ✅ Strict 模式（默认开启）

从 2026-01 起，**推荐把 E2E 当作“部署前的最后一道闸”**：只要 View/Stats 与账本（SSOT）出现不一致，就应立即失败，避免把“推送链路未接好/权限缺失/缓存逻辑缺口”带到测试网或 Arbitrum 主网。

- **默认行为**：`strict=true`（即大多数 View/Stats 不一致会直接抛错退出，而不是仅打印 ⚠️）
- **关闭 strict**：显式设置 `E2E_STRICT_VIEWS=0`

> SSOT 不变：账本仍由 `CollateralManager` / `VaultLendingEngine`（以及 `SettlementManager` 的 repay/settle/liquidation 语义）作为最终真相。  
> strict 只是把“缓存/视图层是否正确跟随账本更新”变成 **可自动验收** 的硬指标。

### Strict 相关环境变量（统一约定）

- **`E2E_STRICT_VIEWS`**（默认开启）
  - `E2E_STRICT_VIEWS=0`：关闭严格校验（回退为 best-effort，允许打印 ⚠️ 继续跑）
  - 其它值/不设置：开启严格校验
- **`E2E_STRICT_DATAPUSH`**（默认关闭）
  - `E2E_STRICT_DATAPUSH=1`：DataPush 关键事件缺失即失败（仅对带 key-event 检查的脚本生效）
- **`E2E_ALLOW_DIRTY_STATE=1`**（仅在需要时使用）
  - 允许在“非干净状态”（已有历史仓位/债务）下跑严格 E2E（更贴近 testnet/mainnet）
- **`E2E_VIEW_STRICT`**（默认随 `E2E_STRICT_VIEWS`）
  - 仅用于 **ViewScan**（启动阶段扫描所有 View 模块）强制失败策略；
  - 说明：未显式传 `strict` 的脚本会默认采用 `E2E_VIEW_STRICT`，其默认值与 `E2E_STRICT_VIEWS` 一致；如需放宽，可显式设置 `E2E_VIEW_STRICT=0` 或 `E2E_STRICT_VIEWS=0`。

### localhost / fork 常用环境变量（推荐组合）

下面这组变量是当前仓库在 localhost 和 Arbitrum Sepolia fork 下最常用、也最稳定的运行口径。

- **`LOCALHOST_RPC_URL`**
  - 用途：指定 deploy / rebind / E2E 统一连接的本地节点。
  - 重要：必须在部署和测试时保持一致；不要让 deploy 指向 `:18545`，而 E2E 还连着默认 `:8545`。
  - 推荐：`LOCALHOST_RPC_URL=http://127.0.0.1:18545`
- **`DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI=1`**
  - 用途：规避 fork / 大批量脚本里 Hardhat 侧偶发的 `UND_ERR_HEADERS_TIMEOUT`。
  - 建议：所有 fork pre-release、full strict run、advanced batch 都显式带上。
- **`E2E_EVM_TIMEOUT_MS=120000`**
  - 用途：放宽 EVM/RPC 扩展超时，避免 batch / fork 长路径在 localhost 上误超时。
  - 建议：fork pre-release 和 full strict run 默认使用 `120000`。
- **`E2E_STRICT_DATAPUSH=1`**
  - 用途：关键 DataPush 缺失即失败。
  - 建议：作为 release gate 或 CI fork gate 开启。
- **`E2E_STRICT_REWARD=1`**
  - 用途：Reward 相关关键行为缺失即失败。
  - 建议：作为 release gate 或 CI fork gate 开启。
- **`E2E_INCLUDE_FORK=1`**
  - 用途：让 `run-all-e2e.ts` 把 fork-only 脚本也纳入执行。
  - 注意：仅在你明确希望跑 fork-only E2E 时开启；`run-pre-release.ts --fork-arbitrum-sepolia` 会自动带上。

推荐组合：手工 localhost 全量严格回归

```bash
DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI=1 \
E2E_EVM_TIMEOUT_MS=120000 \
E2E_STRICT_VIEWS=1 \
E2E_VIEW_STRICT=1 \
E2E_STRICT_DATAPUSH=1 \
E2E_STRICT_REWARD=1 \
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-all-e2e.ts --network localhost
```

推荐组合：手工跑 blocks-only 独立 smoke

```bash
DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI=1 \
E2E_EVM_TIMEOUT_MS=120000 \
E2E_STRICT_DATAPUSH=1 \
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-blocks-only-rollout-smoke.ts --network localhost
```

- 当前 blocks-only 独立 smoke 已提升为更接近发布前 gate 的口径：
  - keeper 角色预检：keeper signer 必须具备 `ACTION_LIQUIDATE`
  - 模块角色预检：`BlocksOnlyCoordinator` 必须具备 `ACTION_LIQUIDATE` + `VIEW_RISK_DATA`
  - 未授权预检：非 keeper 对 `settleOrLiquidateBlocks` 的静态调用必须 `revert MissingRole()`
  - DataPush 强校验：`BLOCKS_ONLY_MATCH_FINALIZED / REPAID / SETTLED / LIQUIDATED` 的 payload 必须可 ABI 解码并与 orderId、actor、blockNumber、collateral/debt 数值一致

推荐组合：手工跑 advanced batch

```bash
DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI=1 \
E2E_EVM_TIMEOUT_MS=120000 \
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
```

## 多 RWA 矩阵

当前 `e2e:multi-stablecoin:localhost` 已升级为“多 RWA collateral × 多稳定币 borrow”矩阵；为了不破坏旧入口，脚本名保留不变，同时增加别名 `e2e:multi-rwa-matrix:localhost`。

推荐命令：

```bash
MULTI_COLLATERAL_SYMBOLS="RWAGOLD,RWABOND,RWARE,RWAINV" \
MULTI_STABLECOIN_SYMBOLS="mUSDC,mUSDT,mHKD,mSGD" \
pnpm -s run e2e:multi-rwa-matrix:localhost
```

说明：

1. 未显式传 `MULTI_COLLATERAL_SYMBOLS` / `MULTI_RWA_SYMBOLS` 时，脚本会自动选取 mock asset pack 中全部 `rwa-token`
2. 价格初始化现在统一读取 `bootstrapPriceUsd8`，兼容旧 pack 里的 `defaultPriceUsd8`
3. 脚本会为矩阵组合补足独立 borrower/lender signer，避免同一 debt asset 复用旧仓位污染断言
4. 这个脚本仍然是 localhost 严格 E2E，不承担 live mock 的 backend publish 状态校验；后者请看 runbook 和 `scripts/tests/live-test/*`

## 🚦 上线前测试流程（Release Gate）

> 目标：把“资金安全 + 权限封闭 + View/Stats 一致性 + 关键异常路径”变成可重复、可自动化的上线前硬闸。

### 1) 基础构建 + 不变式测试

```bash
pnpm -s run compile
pnpm -s run test:invariant
```

- 产物：基础编译通过，Registry 映射一致性不变式稳定。

### 2) 黄金路径 + 关键异常（严格视图）

```bash
E2E_STRICT_VIEWS=1 E2E_VIEW_STRICT=1 \
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-release-golden.ts --network localhost
```

- 覆盖：完整业务流、关键异常（权限/重放/批量边界/回退路由）。
- 输出：`scripts/e2e/logs/e2e-run-<timestamp>/` + `manifest.json`。
- 说明：当前 golden 集还会单独纳入 `e2e-localhost-blocks-only-rollout-smoke.ts`，用于补足 blocks-only keeper / DataPush gate。

### 3) 全量严格 E2E + DataPush/Reward 强校验

```bash
E2E_STRICT_VIEWS=1 E2E_VIEW_STRICT=1 E2E_STRICT_DATAPUSH=1 E2E_STRICT_REWARD=1 \
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-all-e2e.ts --network localhost
```

- 目标：视图与账本一致性 + DataPushed/Reward 关键事件完整性。

### 3.1) Reward 全量 gate（当前推荐命令集）

```bash
pnpm -s run compile
pnpm exec hardhat test test/Reward/EasyEconomics.integration.test.ts

LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s run checks:reward-monitor:config-events
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s run checks:reward-monitor:breakglass
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s run checks:reward-monitor:registry-bindings
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s run checks:reward-monitor:role-bindings

E2E_STRICT_VIEWS=1 E2E_VIEW_STRICT=1 E2E_STRICT_DATAPUSH=1 E2E_STRICT_REWARD=1 \
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
pnpm -s run e2e:pre-release:localhost
```

- 说明：这组命令会覆盖 Reward 经济学、配置/角色/Registry 绑定、RewardView 观测面，以及 pre-release runner 内的 Reward 专项脚本。
- 重要：`e2e:pre-release:localhost` 不会自动执行 `deploy:localhost` 或 `grant-required-roles-local.ts`。如果你在 fresh localhost 节点上直接运行它，脚本会拿旧地址去读空链，最终表现为 `Registry has no bytecode` / `could not decode result data (0x)` 这类统一失败。
- 标准命令集 A：fresh 基线（新起节点、重新部署、重新 grant）

```bash
pnpm -s run node
LOCALHOST_RPC_URL=http://127.0.0.1:8545 pnpm -s run deploy:localhost
LOCALHOST_RPC_URL=http://127.0.0.1:8545 pnpm -s exec hardhat run scripts/tests/grant-required-roles-local.ts --network localhost
LOCALHOST_RPC_URL=http://127.0.0.1:8545 pnpm -s run e2e:pre-release:localhost
```

- 标准命令集 B：一般 dirty 复跑（同一条未重启 localhost，复用现有部署和角色）

```bash
pnpm -s run compile
LOCALHOST_RPC_URL=http://127.0.0.1:8545 pnpm -s run e2e:pre-release:localhost
```

- dirty 复跑前提：同一条 localhost 链还活着，`deployments/localhost.json` 里的地址仍然指向当前节点上已有 bytecode 的合约，且 `grant-required-roles-local.ts` 已经跑过。
- 只要你重启了 localhost、切换了端口、或怀疑链状态已经不可信，就不要继续用 dirty 复跑，直接回到 fresh 基线。

### 3.2) localhost dirty / fresh 规则

从 2026-03 起，`e2e-localhost-full-with-views.ts` 的 `StatisticsView` 严格断言已经改为“按当前用户快照校验”，不再把 `StatisticsView(global)` 误当成当前 borrower 的局部账本。

这意味着：

- `full-with-views` 现在应理解为“当前用户链路一致性检查”，不是“全局系统必须归零检查”。
- 在 dirty localhost 上，如果前序脚本留下别的用户仓位或债务，`StatisticsView(global)` 仍然可能显示非零 `totalCollateral/totalDebt`，这本身是正确现象，不代表当前脚本失败。
- 只要 `StatisticsView(user)`、`PositionView`、`UserView`、`DashboardView` 与当前测试用户账本一致，就应认为 `full-with-views` 通过。

当前推荐分类：

- 允许 dirty chain：`e2e-localhost-full-with-views.ts`
- 允许 dirty chain，但会显著改变系统状态：`e2e-localhost-batch-advanced-10-users.ts`、`scripts/tests/funds-flow-invariants-suite.ts`
- 建议 fresh chain：`deploy:localhost` 之后的整轮 localhost 基线验收、任何你希望把“全局统计必须接近空链”也当成信号的检查

理解规则：

- 如果你的目标是“确认当前用户的一条完整业务链路是否正确”，可以在 dirty chain 上跑 `full-with-views`。
- 如果你的目标是“确认整条系统在 fresh 部署后是否无历史残留”，必须单独起 fresh node，再跑对应脚本，不能复用前面已经跑过 batch / funds-flow 的同一条链。

前后端配合边界：

- 这次修复不需要前后端联动改接口，也不要求前端改合约调用。
- 需要统一的只是语义认知：`StatisticsView(global)` 是系统聚合视图，`StatisticsView(user)` / `UserView` / `PositionView` 才适合做当前用户的一致性校验。
- 如果前端页面要展示“当前用户是否与账本一致”，应优先使用用户维度视图，不要把全局 totals 当作当前用户资产。

### 4) 报告与量化

```bash
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/quantify-latest-e2e-details.ts
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/quantify-latest-batch-artifacts.ts
```

- 输出：`scripts/e2e/doc/E2E-Details-Latest.md` + `scripts/e2e/doc/E2E-Quantification-Latest.md`。

### 5) 价格/清算压力测试（独立于 batch-advanced）

```bash
E2E_STRICT_VIEWS=1 E2E_VIEW_STRICT=1 \
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-price-liquidation-stress.ts --network localhost
```

- 输出：`scripts/e2e/artifacts/price-liquidation-stress.<timestamp>.json`
- 同步更新：`scripts/e2e/doc/Stress-Report-Latest.json`

这个场景当前会同时产出两层结果：

1. 原始 artifact：保留逐单 liquidation 明细、pricePath、reward / collateral 快照，适合排查单笔异常。
2. latest 汇总 JSON：保留 release gate 更关心的汇总指标，适合快速判断这轮 stress 是否健康。

`multi-asset-crash` 汇总里当前至少应关注：

- `orders / skipped / liquidated`
- `fallbackLiquidations / zeroValuations`
- `principalUsdMin / principalUsdMax`
- `liquidationThreshold`
- `deepenedCrashRounds`
- `riskSamples`

说明：

- `deepenedCrashRounds` 表示固定 crash ppm 不足以把任何 borrower 打进清算区间时，脚本额外做了多少轮自适应加深。
- `riskSamples` 是 crash 后采样的 borrower 风险快照，里面同时保留 cached HF 与 live collateral/debt/liquidatable 判断，用来区分“缓存假阴性”和“场景本身压得不够深”。
- 当前默认 `collateralAssetMode=settlement`、`collateralRatioPpm=3000000` 时，multi-asset crash 很可能需要依赖这个自适应加深，不能再只看固定 shock/crash 配置是否够狠。

### 6) 深度审计（价格/清算、权限/升级、奖励/DataPush、多资产一致性）

```bash
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/audit-latest-deep-dive.ts
```

- 校验：
  - 价格/清算路径在 batch-advanced 中已覆盖并留痕
  - RewardView DataPushed 覆盖关键类型（Easy minted/spent、Penalty ledger、Earn state）
  - 多资产订单（ma-usdc/ma-alt）与资产地址分离
  - attack-suite 无 ABI/selector 失配

### 7) 角色/权限/注册一致性检查（建议）

```bash
pnpm -s run checks:roles
pnpm -s run checks:registry
pnpm -s run checks:cache-gates
```

### ✅ 一键执行（推荐）

默认使用 **Arbitrum Sepolia fork**：启动 fork 节点 → 部署 → 全量 E2E → 报告 → 深度审计。

fork RPC 可通过 `ARBITRUM_SEPOLIA_RPC_URL`（兼容 `ARBITRUM_SEPOLIA_URL`）覆盖；建议在本机 `.env` 里配置（该值不会入库）。

> 重要：部分公共 RPC 在读取“最近历史区块状态”时可能返回 `missing trie node`（例如 `eth_getStorageAt` 带 blockNumber），这会导致 Hardhat fork 节点在运行中直接崩溃，进而让后续 E2E 全部出现 `ECONNREFUSED`。
> 如遇到该问题，请更换 fork RPC（推荐 `https://arbitrum-sepolia.drpc.org`，或使用 Alchemy/Infura/QuickNode 等 provider）。

```bash
ARBITRUM_SEPOLIA_RPC_URL=<your_arbitrum_sepolia_rpc_url> pnpm -s run e2e:pre-release
```

推荐在 fork-heavy 环境或 CI 中显式补齐超时相关变量：

```bash
DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI=1 \
E2E_EVM_TIMEOUT_MS=120000 \
E2E_STRICT_VIEWS=1 \
E2E_VIEW_STRICT=1 \
E2E_STRICT_DATAPUSH=1 \
E2E_STRICT_REWARD=1 \
ARBITRUM_SEPOLIA_RPC_URL=<your_arbitrum_sepolia_rpc_url> \
ARBITRUM_SEPOLIA_URL=<your_arbitrum_sepolia_rpc_url> \
pnpm -s run e2e:pre-release
```

- `run-pre-release.ts --fork-arbitrum-sepolia` 会自己启动 fork node，并把 `LOCALHOST_RPC_URL` 指到该 fork node。
- 手工分步执行时，`LOCALHOST_RPC_URL` 仍然要由你自己显式传递给 deploy 与各个 E2E 脚本。

### 🤖 CI / 验收口径

当前仓库以现有脚本化方案为准，不再额外维护一套独立的 CI 配置入口。

- fork / localhost 的发布前回归：继续使用本 README 中的 `pnpm -s run e2e:pre-release`、`run-all-e2e.ts`、blocks-only / advanced batch 组合
- 真实链只读验收与 CI 模板：以 `scripts/tests/README.md` 和 `bash scripts/tests/ci-realchain-template.sh` 为准
- 若团队后续需要接 CI 平台，应优先复用 `scripts/tests/README.md` 中已经整理好的 real-chain / smoke 约束，而不是额外维护一套独立 workflow 口径

### localhost fork 下的 signer 说明

- 当部署脚本或 E2E 以 `--network localhost` 或 `--network hardhat` 运行时，实际发送交易的账户来自 `ethers.getSigners()` 返回的本地 signer。
- 这意味着 fork 模式下即使目标链是 Arbitrum Sepolia，脚本也不会直接使用 `PRIVATE_KEY` 去构造 signer；`PRIVATE_KEY` 只用于真实远程网络（例如 `arbitrumSepolia`）部署。
- 因此 fork 回归时需要确认的是本地 signer 在 fork 节点上的原生币余额是否足够支付 gas，而不是误以为脚本会直接拿线上私钥账户发交易。

### 🛰️ 新增：Arbitrum Sepolia 真链模式（live）

> 目标：**不启动本地 fork**，直接在 `--network arbitrumSepolia` 上进行“部署/对齐 + 真链友好验收”。
>
> 重要现实：绝大多数 `e2e-localhost-*` 脚本默认假设“可写、可 grant role、可 time-travel/mine、可 impersonate、状态干净”，
> 在真实链上要么**跑不通**，要么会引入**不可控状态变化**（消耗 gas、污染权限/白名单/价格、制造订单/仓位）。
>
> 因此 live 模式默认执行的是：`compile + invariant + 关键 smoke（READ_ONLY=1 ENABLE_WRITE=0）`。
> 这更接近“上线前最后闸门”的真实约束，也更稳定。

运行方式（推荐用专用脚本）：

```bash
# 需要：ARBITRUM_SEPOLIA_RPC_URL + PRIVATE_KEY（用于部署/签名读取）
pnpm -s run e2e:pre-release:arbitrum-sepolia-live
```

如需 **不部署，只验收现有部署**（跳过 deploy step）：

```bash
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-pre-release.ts --arbitrum-sepolia-live --skip-deploy
```

或手动传 flag：

```bash
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-pre-release.ts --arbitrum-sepolia-live
```

live 模式会：

- `Deploy (arbitrumSepolia live)`：执行 `scripts/deploy/deploy-arbitrum-sepolia.ts`（脚本内部按 `scripts/deployments/arbitrum-sepolia.json` 做 best-effort 的增量/幂等部署）
- `Compile` + `Invariant Tests`：仍然在本地 Hardhat 环境运行（不依赖远程 RPC）
- `Live Smoke`：跑一组真链可用的只读 smoke 子集（默认 `READ_ONLY=1 ENABLE_WRITE=0`），用于验证
  - Registry / SystemView 路由对齐
  - 关键 View 的 role gate / selector 对齐（避免 ABI/部署错位）
  - ViewCache 的 batch 边界与只读读取
  - LendingEngine/Oracle/FeeRouter 等核心读取路径可用

> 提示：live 模式默认**不会**跑 `Full Strict E2E / Golden / Stress / Reports / Deep Dive Audit`，
> 因为这些步骤目前高度依赖 localhost/fork 的可控环境；若强行在真链跑，历史上容易出现“跑不通/跑一半挂/链上状态被污染”。

## ✅ 核心 E2E（强制覆盖）与失败信息

## 🧭 观测口径与诊断：常见坑位（2026-03 修复）

本节把近期在 E2E/日志分析中发现的“口径/观测/命名”问题与修复方式固化下来，避免后续在 fork/localhost 的可控环境里被误导。

### 1) `StatisticsView` totals 量级异常（常见表现：~100x 缩小）

**现象**：在执行大幅 `mineToBlock(...)` time-travel 后，`StatisticsView` 的 `totalCollateral/totalDebt`（脚本打印为 USD-8）可能突然变成诸如 `10` / `19.999...`，与期望 `1000` / `1999.999...` 相差约 100 倍。

**根因**（高概率）：oracle 在 time-travel 后变 stale，估值路径触发 `GracefulDegradation` 的 fallback；fallback 返回的值往往是“资产 token decimals”的金额口径，被上层当作“USD-8”显示时就会出现数量级错配。

**修复/规约**：任何脚本在做“绝对时间跳跃”（如直接跳到 maturity 附近或跨越多天区块）后，都要显式刷新该资产价格。

- 推荐做法：在 jump 后追加一次 `PriceOracle.updatePrice(asset, priceUsd8, nowBlock)`。
- 经验规则：
  - 如果你的脚本依赖 `StatisticsPushManager` / `PositionView` / `VaultLendingEngine` 的估值（USD-8），那就必须确保 oracle 不会 stale。
  - fork/live 上一般会有 keeper 持续刷新价格，但 fork 环境依然可能因为测试脚本“跳得太远”而超过 `maxPriceAgeBlocks`，因此 fork E2E 仍需要覆盖并处理 stale 情况。

**其他补救方式（建议做成产品级防线）**：

- **后端/合约侧（系统策略）**
  - 把“oracle stale”当作明确的系统状态：在关键 read path（例如估值、健康度、风险）返回结构中暴露 `isStale` / `priceAge` / `usedFallback` 之类的 meta（哪怕只是 view 层拼出来的 meta），让上层不会把 fallback 值当成正常 USD-8。
  - 如果某些路径必须保证 USD-8 口径（例如 `StatisticsView` snapshot），可考虑在 push 前强制校验 `usedFallback==false`，否则：
    - 要么 revert（更严格，但会影响链上可用性），
    - 要么 push 一个“stale 标记 + 上次可信值”（不改 totals，只改 meta）。
  - keeper 侧：对每个资产配置“最大允许 priceAge”，并在接近阈值时提前刷新，避免进入 fallback。

- **前端侧（展示与交互）**
  - 不要盲信 totals 的数值：
    - 如果检测到 `usedFallback/isStale`，UI 必须显示“价格过期/已降级”的显著提示，并避免把该值用于交易决策展示（例如可借额度/清算阈值）。
    - 对用户资产/债务展示采用“数值 + 口径标签”（USD-8 vs token-decimals），并在降级时显式切换文案。
  - 对 `StatisticsView` 这种聚合指标，建议增加“数据更新时间/区块高度”显示，避免用户误解为实时。

- **监控/告警（最有效的补救）**
  - 监控 priceAge（按资产维度）：当 `priceAgeBlocks` 接近 `maxPriceAgeBlocks` 的某个比例阈值（例如 80%）就告警。
  - 监控 fallback 使用率：如果系统开始频繁走 fallback（或 totals 出现数量级突变），应立即告警并关联到“keeper 刷新是否正常”。
  - 监控 `StatisticsView` totals 的异常跳变：例如同一资产池在短时间内 totals 变化超过合理区间。

### 2) `[Order] ... n/a`（订单打印字段错配）

**现象**：E2E 日志里出现 `[Order] ... n/a` 或关键字段打印为空，导致排障时误以为链上订单异常。

**根因**：脚本按错误的字段名解构订单结构体（例如误用 `collateralAsset/borrowAsset/termDays` 等），而链上 `IOrderEngine.LoanOrder` 的实际字段为：

- `principal`
- `rate`（bps）
- `term`（blocks）
- `asset`
- `startTimestamp`（实际是 start block）
- `maturity`（实际是 maturity block）
- `repaidAmount`

**修复/规约**：日志打印与后续 view 查询必须以 `order.asset` 为准（尤其是 `PositionView/UserView` 的资产参数）。

### 3) `failedFee` 的语义（避免误导）

**误解风险**：`failedFee` 容易被理解为“失败标志/失败次数”。

**实际语义**：它是 `LendingEngine` 在 `_distributeFeeWithFallback` 捕获到 FeeRouter 分发失败时累加的“累计失败分发手续费”，计量单位是 **订单资产 token decimals**。

**规约**：日志输出时应明确口径：

- `failedFeeAccruedAsset`：按订单资产 decimals 格式化后的数值
- `failedFeeAccruedRaw`：原始累加值（便于对账）

### 4) Reward/DataPush：同一笔 tx 内可能出现多条同类型 push

**现象**：严格断言 DataPush 与 View 状态时可能“误报”，尤其是 reward penalty ledger。

**根因**：同一笔交易里可能出现多条同类型 DataPush（例如 penalty ledger 先写入 pendingDebt，再在同 tx 内清零）。

**修复/规约**：

- 诊断必须先 `filter()` 收集同 tx 的全部 push 并逐条解码打印（包含 tx/hash、block、orderId、user、payload 关键字段）。
- 严格对比以“最后一条 push”代表最终落库状态；若仍不一致，继续抛错（不要静默放过）。

### 5) Advanced batch checkpoints：`pre-extras` 不是脚本最终态

**误导风险**：advanced batch 脚本里会先跑完“主业务流（创建/撮合/还款/结清）”，然后再跑一组 **extras**（取消预留、stale price 负路径、withdraw、keeper liquidation demo、EasyToken guide 等）。

因此：

- `Checkpoint (pre-extras)` 只能代表“主业务流完成后的状态”，**不代表脚本最终态**。
- extras 里可能会引入新的 active order / debt / collateral 变化（尤其是 liquidation demo），所以 end-of-script 的 totals 允许不为 0。

**在 artifacts 中的对应字段**（见 `scripts/e2e/artifacts/batch-advanced-10-users.*.json`）：

- `checkpoints.checkpoint_pre_extras_after_all_repaid`：主业务流完成后的严格断言点（推荐用于“SSOT 还款结清一致性”验收）
- `checkpoints.final_after_all_repaid`：历史兼容别名（语义同上，保留是为了不破坏旧工具）
- `checkpoints.final_end_of_script`：extras 跑完后的 end-of-script totals（当前脚本已做严格一致性检查；若 extras 本身故意留下活动仓位/债务，则 totals 允许非 0，但 **ledger delta 与 stats delta 必须口径一致**）

**2026-03 本次修复补充**：

- advanced batch 里的 `post-extras` 统计差异曾经不是协议侧 bug，而是脚本自身把“全局 StatisticsView totals”与“仅主 borrower 子集求和”混在一起比较。
- 具体根因：extra 的 “User Withdraw (Deposit -> Withdraw)” 演示路径里，用户先存入再只提走一部分，残留 collateral 被 `StatisticsView` 全局统计到，但 borrower 子集汇总没有统计到。
- 当前脚本已修复为：
  - extra withdraw 场景在断言后清理剩余 collateral；
  - `post-extras` checkpoint 不再只是 informational，而是对 `ledger delta -> toUsd8 -> stats delta` 做真实断言。

### 6) VLE 债务总值读取：必须按 fresh valuation read 理解

**现象**：如果把 `VaultLendingEngine.getUserTotalDebtValue(user)` 当成“旧缓存总值回显”接口，容易在 `SettlementManager` 清债释放抵押、`StatisticsPushManager` 推送快照、以及严格 E2E 的 totals 对比中出现语义漂移。

**当前 SSOT 口径**：

- `VaultLendingEngine.getUserTotalDebtValue(user)` 的对外语义必须视为 **fresh valuation read**。
- 它应基于“当前用户债务资产集合 + 当前 oracle 价格语义”逐资产重算，并返回 **USD-8** 总债务价值。
- 调用方不得假定它只是某个内部缓存字段的直返；内部即使为了性能维护缓存，也不能把对外读接口降级成 stale mirror。

**E2E/脚本侧规约**：

- 只要脚本在校验 `SettlementManager` 全债清零、`StatisticsPushManager` 快照、或 `UserView/PositionView` 的 totals，就必须按上述 fresh valuation 语义理解 `getUserTotalDebtValue(user)`。
- 若脚本做了大幅 time-travel，还要先刷新价格，避免 stale oracle 让“fresh valuation”退化成 fallback 值（见上文 stale price 章节）。

### 7) artifacts 里出现 `ok=false/error` 不能当作“干净通过”

advanced batch artifacts 会把 LoanNFTView 的枚举结果与 `LendingEngineView.getLoanOrder(orderId)` 的读取结果一起落盘（用于发现 MissingRole/selector mismatch/部署错位等问题）。

- 当 artifacts 里存在 `orderDetailsError`（例如 `return data: 0x94235922` = `MissingRole()`）时：
  - 这说明“某些 view 读取路径并未对齐/角色不足”，**不应被当作 clean pass**。
  - 脚本会在日志里打印 `=== OrderDetails summary ===` 的总量汇总，确保该问题不会被淹没。

**失败策略（默认推荐开启）**：

- `E2E_FAIL_ON_ORDER_DETAILS_ERROR`（默认：开启）
  - 不设置 / 设为非 `0`：只要出现 `orderDetailsError` 就设置非 0 退出码（同时仍写 artifacts，便于排障）
  - `E2E_FAIL_ON_ORDER_DETAILS_ERROR=0`：仅打印 ⚠️，允许继续当作 best-effort（不推荐）

**如需打印完整 order details**（可能很长）：

- `E2E_PRINT_ORDER_DETAILS=1`：打印 ok 与 error 的明细
- `E2E_PRINT_ORDER_DETAILS_MAX`：默认 10；设为 `0` 表示不截断

### 8) 日志检索小技巧

默认 workspace 搜索可能会排除 `scripts/e2e/logs/**`。如果用 VS Code 工具检索 verify 日志，请确保开启“包含被忽略文件”（例如 `grep_search(..., includeIgnoredFiles: true)`）。

### 9) 如何验证是否已修复（两种方式）

#### A) Fork Arbitrum Sepolia 到本地再跑（推荐，不需要私钥）

特点：使用真实 Arbitrum Sepolia 的链状态作为 fork 源，但执行环境仍是本地 Hardhat，可稳定复现并覆盖“stale/keeper 断更”类问题。

```bash
# 1) 确保端口空闲（fork node 默认使用 18545）
lsof -nP -iTCP:18545 -sTCP:LISTEN || true

# 2) 跑 fork pre-release（默认 fork 源：https://arbitrum-sepolia.drpc.org）
pnpm -s exec ts-node --project ./tsconfig.scripts.json \
  scripts/e2e/tools/run-pre-release.ts \
  --fork-arbitrum-sepolia \
  --skip-compile --skip-invariant --skip-golden --skip-stress --skip-reports --skip-audit
```

- 如需更换 fork 源：`ARBITRUM_SEPOLIA_RPC_URL=<your_rpc> ...`
- 如需换端口（避免 EADDRINUSE）：追加 `--fork-port 18546`

#### B) 直接跑真链 smoke（需要 RPC + PRIVATE_KEY）

特点：不依赖 Hardhat fork，不会使用 hardhat-only RPC；用于验证“路由/权限 gate/selector 对齐 + 只读读取路径”是否正常。

```bash
ARBITRUM_SEPOLIA_RPC_URL=<your_rpc> PRIVATE_KEY=<your_key> \
pnpm -s exec ts-node --project ./tsconfig.scripts.json \
  scripts/e2e/tools/run-pre-release.ts \
  --arbitrum-sepolia-live --skip-deploy --skip-compile --skip-invariant
```

说明：该模式默认会设置 `READ_ONLY=1 ENABLE_WRITE=0` 跑 live smoke 子集；没有 `PRIVATE_KEY` 时 Hardhat `arbitrumSepolia` 网络没有 signer，smoke 脚本会因拿不到 signer 而失败。

你可以把下列 4 个脚本视为“核心 E2E 用例”（通常建议在 fork/localhost 可控链上跑）：

- `scripts/e2e/e2e-localhost-batch-10-users.ts`
- `scripts/e2e/e2e-localhost-batch-advanced-10-users.ts`
- `scripts/e2e/e2e-localhost-liquidation-reward-penalty.ts`
- `scripts/e2e/e2e-localhost-price-liquidation-stress.ts`
- `scripts/e2e/e2e-localhost-rewardmanager-governance.ts`

`run-pre-release.ts` 的行为：

- 当你正常跑 `Full Strict E2E` 时，它会枚举并执行所有 `scripts/e2e/e2e-*.ts`（其中包含上述 4 个脚本）
- 当你显式 `--skip-full` 时，为防止关键用例被跳过，runner 会自动进入 **Core E2E (required)** 分支并逐个执行上述 4 个脚本
- `e2e-localhost-liquidation-reward-penalty.ts` 现在用于验证：
  - `settleOrLiquidate(orderId)` 与 `RewardManager.applyLiquidationPenalty(user)` 已经语义拆分：清算交易只验证 liquidation 主链路；Reward 惩罚由独立交易验证
  - `KEY_REWARD_VIEW` 不可用时的 best-effort 降级：主链不回滚、账本正确、链下可恢复；`RewardViewPushFailed` 在缓存 rollover 后作为强观测断言
  - `scripts/e2e/tools/replay-rewardview-penalty-failures.ts` 可对这类 `PENALTY_LEDGER` 失败做演示性补偿验证；推荐在 fork 上优先使用 artifact-driven 模式，避免共享 fork RPC 对大范围 `eth_getLogs` 的限制
- `e2e-localhost-price-liquidation-stress.ts` 现在除了原始 artifact，还会固定刷新 `scripts/e2e/doc/Stress-Report-Latest.json`：
  - 原始 artifact 用于逐单排查 liquidation / collateral / reward 细节
  - latest 汇总用于 gate 级别判断 stress 是否稳定
  - `multi-asset-crash` 场景会显式输出 `liquidationThreshold`、`deepenedCrashRounds`、`riskSamples`
  - 如果你看到 `deepenedCrashRounds > 0`，这不是自动失败；它表示脚本识别到“固定 crash 配置不足”，并通过自适应加深把场景继续压到可清算区间
  - 如果 `riskSamples` 显示 cached HF 仍然安全、但 live collateral/debt 已经接近或进入 liquidatable，这通常说明是 cache warmth 问题，不应误判为业务主链路失败
- runner 会 **全跑完再汇总**（便于一次性看到全部失败点），并保证输出：
  - 失败分类（常见原因：RPC 断连 / MissingRole / selector mismatch / hardhat\_\* RPC 依赖等）
  - 末尾 120 行 combined 输出（stdout+stderr）
  - 完整日志文件路径：`scripts/e2e/logs/core-e2e-<timestamp>/*.log`

> 注意：这些脚本以 `e2e-localhost-*` 命名，默认假设 **localhost/fork** 环境（多 signer、可写、可 mine/snapshot/impersonate）。

## 🆕 2026-03 链式扩展要求（localhost gate 已纳入）

以下链路现在应被视为 localhost pre-release 的硬验收范围：

- `reserve/finalizeMatch -> repay -> Easy mint -> RewardView/DataPush`
- `early repay -> ERGM/GFM custody settle -> RewardView/DataPush`
- `settleOrLiquidate/default` 与 `RewardManager.applyLiquidationPenalty` 的拆分语义
- `RewardView unavailable -> best-effort continue + backend reconciliation/retry`

规约：

- localhost 脚本仍按 **Arbitrum Sepolia 的模块连接与角色口径** 编写，不允许为了本地通过而引入与测试网部署不一致的旁路。
- 若脚本需要 hardhat-only 能力（`hardhat_mine` / `impersonate` / `setBalance` / `snapshot`），必须明确标注为 localhost/fork-only，不得误接入 live smoke。
- RewardView / DataPushed 属于观测镜像层，不是主账本 SSOT。若链上 RewardView 地址缓存尚未 rollover，localhost gate 的降级断言应优先验证：
  - 主流程未回滚
  - Reward / penalty / guarantee 主账本正确
  - 失败留痕在缓存 rollover 后可观测
  - 链下可依据真实账本与 `RewardViewPushFailed` 完成补偿、重试和读模型修复
- 量化与审计脚本应把以下信号视为一等输出：
  - `REWARD_PENALTY_LEDGER_UPDATED`
  - `REWARD_BURNED`
  - `REWARD_EARN_STATE_UPDATED`
  - guarantee 相关 checkpoint / flow 统计
  - `RewardViewPushFailed`
- 对报告的解释必须区分两类情况：
  - `expectedDegradeCoverage > 0 && unexpectedRewardViewPushFailed = 0`：这是预期的降级覆盖，不应按业务 WARN 处理
  - `unexpectedRewardViewPushFailed > 0`：这才表示真实残留异常，需要继续排查/补偿
    > 如果你强制在真链 live 上跑，runner 会直接报错说明原因（而不是静默跳过）。

> 可复现建议：脚本会打印 `forkHead` 以便追溯本次 fork 的大致高度。你也可以通过 `HARDHAT_FORK_BLOCK_NUMBER` 固定 fork 起点（见下文）。

如需沿用传统的“外部自建 localhost 节点 + 仅跑 gate（不自动启动 fork）”方式：

```bash
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s run e2e:pre-release:localhost
```

前提顺序必须完整：

```bash
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s run deploy:localhost
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s exec hardhat run scripts/tests/grant-required-roles-local.ts --network localhost
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s run e2e:pre-release:localhost
```

否则 `frontend-config/contracts-localhost.ts` / `deployments/localhost.json` 里的地址会指向旧部署，而当前外部节点上并没有对应 bytecode，导致整组 localhost E2E 统一失败。

可选跳过：`--skip-compile`、`--skip-invariant`、`--skip-golden`、`--skip-full`、`--skip-reports`、`--skip-audit`、`--skip-stress`。

### RewardView penalty replay 演示

当 fork E2E 的 artifact 已经记录了 `rewardExtendedChecks.missingRewardViewBestEffort.afterCacheRollover`，可以直接用 artifact 驱动 replay，无需再让补偿脚本去 fork 节点上宽范围扫日志：

```bash
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
REWARDVIEW_REPLAY_DRY_RUN=1 \
REWARDVIEW_REPLAY_ARTIFACT=scripts/e2e/artifacts/rewardview-acceptance.<timestamp>.json \
pnpm -s run e2e:rewardview-penalty-replay

LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
REWARDVIEW_REPLAY_ARTIFACT=scripts/e2e/artifacts/rewardview-acceptance.<timestamp>.json \
pnpm -s run e2e:rewardview-penalty-replay
```

说明：

- artifact 现在会记录 replay 所需的 `user` 与 `blockNumber`，因此补偿脚本可以直接构造 `RewardView.retryPushPenaltyLedger(user, pendingDebt, blockNumber)`。
- `dryRun=true` 时只判断是否存在候选与是否应 replay，不会写链。
- `replayed=true`：说明镜像确实落后于主账本，脚本完成了一次补偿写入。
- `replayed=false` 且 `skippedReason=already-aligned`：说明在执行补偿前主账本与 RewardView 镜像已经一致，这是合法的安全 no-op，不应误判为失败。
- `replayed=false` 且 `skippedReason=stale-payload`：说明 artifact 里的失败载荷已不是当前账本最新状态，补偿脚本会拒绝覆盖新状态。

本次 fork 演示的独立验证纪要见：`docs/Test-Guide/fork-rewardview-penalty-replay-validation.md`。

## 🧷 Arbitrum Fork E2E（keeper impersonate + 相对 staleness）

> 目标：用 **Arbitrum fork** 的链环境来跑关键负路径，尤其是“价格过期（stale）→ keeper 刷新 → 恢复估值/风险读取”的行为。
>
> 设计原则：
>
> - **fork + impersonate keeper**：写价/刷新价由“keeper 地址”执行，而不是 deployer。
> - **相对 staleness**：只基于 `maxPriceAgeBlocks` 推进区块数（而不是 `mineToBlock(maturity+1)` 这种 Hardhat-only 的绝对时间技巧）。
> - **Arbitrum 现实**：在真实链上 keeper 会持续刷新；测试要覆盖“如果 keeper 断更，风险关键路径如何表现”。

### 0) 前置要求（必须满足）

- 你需要启动一个 **Hardhat fork node**（因为脚本依赖 `hardhat_impersonateAccount` / `hardhat_setBalance`）。
- 你需要在该 fork 链上执行一次 `deploy:localhost`，确保 `frontend-config/contracts-localhost.ts` 指向 fork 链上的新部署地址。
- 运行时 RPC 仍然通过 `LOCALHOST_RPC_URL` 指向你的 fork node。

> 说明：`frontend-config/contracts-localhost.ts` 内的 `NETWORK_CONFIG.chainId` 是 localhost 模板值（1337），
> fork 场景请以运行时 provider 返回的 `chainId` 为准（脚本会读 `ethers.provider.getNetwork()`）。

> 重要结论：**大多数现有 `e2e-localhost-*` 脚本不需要修改**，只要把“节点”换成 fork node（同一个 `LOCALHOST_RPC_URL`），
> 再跑一次 `deploy:localhost` 让地址对齐，就能在 Arbitrum fork 环境里复用整套 gate。

### 1) 启动 Arbitrum fork 节点（示例）

任选 Arbitrum Mainnet 或 Arbitrum Sepolia 的 RPC：

```bash
# 推荐：通过环境变量配置 `networks.hardhat.forking` 来启动 fork。
# （避免 `hardhat node --fork ...` 触发 hardhat_reset 路径，进而踩到 Hardhat/EDR 的 HH604 限制）

# 例：fork Arbitrum Sepolia
HARDHAT_FORK_URL=${ARBITRUM_SEPOLIA_RPC_URL:-https://arbitrum-sepolia.drpc.org} \
HARDHAT_FORK_CHAIN_ID=421614 \
HARDHAT_FORK_BLOCK_NUMBER=247756551 \
pnpm -s exec hardhat node --port 18545

# 例：fork Arbitrum Mainnet
# HARDHAT_FORK_URL=<your_arbitrum_rpc_url> HARDHAT_FORK_CHAIN_ID=42161 pnpm -s exec hardhat node --port 18545
```

> 提示：`HARDHAT_FORK_BLOCK_NUMBER` 建议固定，保证回归可重复（但仍依赖 provider 能稳定提供对应区块状态）。
>
> - 上面 `247756551` 是示例值（来自一次 `--fork-arbitrum-sepolia` 运行时打印的 `forkHead`）。你可以把它替换为你本次运行打印出来的最新 `forkHead`。
> - 注意区分：fork 源链的 pin 高度（这里的 `HARDHAT_FORK_BLOCK_NUMBER`）与本地 fork 链在部署/跑脚本后增长到的区块高度不是一回事。

### 2) 在 fork 链上部署本地协议栈

```bash
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s run deploy:localhost
```

### 3) 运行 fork E2E：stale → keeper refresh

脚本：[scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts](scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts)

```bash
E2E_STRICT_VIEWS=1 E2E_VIEW_STRICT=1 \
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
E2E_KEEPER_ADDRESS=0x000000000000000000000000000000000000BEEF \
pnpm -s exec hardhat run scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts --network localhost
```

- 断言：
  - `PriceOracle.getPrice(asset)` 在 stale 时必须 revert `PriceOracle__StalePrice()`。
  - 估值/风险读取在 stale 时 **不得返回正值**（允许 revert 或降级为 0，二者都被记录进 artifact）。
  - keeper 刷新价格后，估值/风险读取必须恢复为正值。

### 4) `run-all-e2e.ts` 的 fork 脚本收录规则

为避免 fork-only 脚本影响现有 localhost gate：

- 默认：`scripts/e2e/tools/run-all-e2e.ts` 会 **跳过文件名包含 `-fork-` 或 `.fork.` 的脚本**。
- 如需在全量执行中包含 fork 脚本：

```bash
E2E_INCLUDE_FORK=1 \
LOCALHOST_RPC_URL=http://127.0.0.1:18545 \
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-all-e2e.ts --network localhost --include-fork
```

## 📊 Artifacts 量化（最新 batch 对比）

> 目的：把 batch E2E 产生的 artifacts 变成“可回归的量化仪表盘”，用于快速回答：
>
> - 这次跑的是不是同一条链（RPC/chainId/block）？
> - orders/orderIds 是否连贯（是否有跳号/缺失/重复）？
> - View push（DataPushed）大致发生了哪些类型、数量是否异常？

### 量化脚本

- 脚本：scripts/e2e/quantify-latest-batch-artifacts.ts
- 输入：自动读取 scripts/e2e/artifacts/ 下最新的：
  - batch-10-users.\*.json
  - batch-advanced-10-users.\*.json
- 输出：scripts/e2e/doc/E2E-Quantification-Latest.md（覆盖更新）

### 如何运行

1. 先跑两个 batch（产出 artifacts）

`LOCALHOST_RPC_URL` 必须与 deploy / E2E 指向同一条 localhost 链。

```bash
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s exec hardhat e2e:batch-10-users --network localhost
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s exec hardhat e2e:batch-advanced --network localhost
```

2. 再跑量化（不需要 RPC；只读 artifacts 文件）

```bash
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/quantify-latest-batch-artifacts.ts
```

### 如何解读（重点字段）

- **rpcUrl / chainId / block**
  - 两套 artifacts 若不是同一条链，后续所有对比都不可信（典型症状：地址存在但 getCode=0x）。
- **orders / orderIds / missingOrderIds**
  - `missingOrderIds` 非空通常表示：某些场景分支被跳过、创建失败但流程继续、或 ID 分配并非严格递增。
  - advanced artifacts 若包含 `orders[]`，报告会额外列出按 orderId 排序的订单列表，便于快速定位“跳号点”。
- **DataPushed breakdown**
  - 报告同时输出 top5 与 all typeHash（按次数降序）。
  - 注意：这是“事件可观测性统计”，并不能在无“期望清单”的情况下严格证明“全部推送完毕”；它更适合用来发现 **回归/异常漂移**（例如某些 typeHash 突然消失或暴涨）。
- **typeHash diff（advanced vs basic）**
  - 显示 advanced 相对 basic 的新增/缺失 typeHash（逐行列出）。
  - 这不等价于“推送不完整”，因为两套 batch 覆盖的业务路径不同；但它是定位“为什么前端某类数据没更新”的第一入口。

## 🧭 全量 E2E 同一 RPC + 详细报告（推荐）

> 目标：所有 E2E 脚本 **统一走同一条 RPC**，并生成“可用于排查问题”的详细汇总报告（不做两份 batch 对比）。

### 1) 一键运行全部 E2E（同一 RPC）

```bash
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-all-e2e.ts --network localhost
```

如需 DataPush 关键事件缺失即失败：

```bash
E2E_STRICT_DATAPUSH=1 LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-all-e2e.ts --network localhost
```

- 日志目录：`scripts/e2e/logs/e2e-run-<timestamp>/`
- 清单文件：`scripts/e2e/logs/e2e-run-<timestamp>/manifest.json`
- 默认不中断（收集所有脚本结果）。如需失败即停：追加 `--fail-fast`

### 2) 生成“详细情况”汇总报告（不对比）

```bash
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/quantify-latest-e2e-details.ts
```

- 输出：`scripts/e2e/doc/E2E-Details-Latest.md`
- 报告聚合：
  - 最新一次 run 的脚本状态与日志路径（若存在 manifest）
  - 每个 artifacts 前缀的最新 JSON 元数据（chainId/rpc/block/orders/checkpoints/dataPushed 等）
  - 便于定位“某个测试是否产出可追踪证据”以及“具体输出路径”

## ✅ View 相关 E2E 验收要求（MUST）

> 目标：把“路由/权限/回退/版本信息”等 **跨 View 的一致性承诺**变成可重复、可自动化的硬指标；避免“脚本只测业务 happy path，但部署/路由/回退已悄悄漂移”。

### 1) 统一 Preflight（所有 View acceptance 脚本必须执行）

- **统一入口**：`scripts/e2e/utils/view-preflight.ts` 的 `runViewPreflight(...)`
- **执行时机**：每个 `e2e-localhost-*-acceptance.ts` 的 `main()` 开头必须调用一次（在任何业务断言之前）
- **Preflight 必须做到**：
  - **SystemView ↔ Registry 对齐**（硬失败）
    - 对所有 `SystemView.route*()` 返回的 `moduleKey/moduleAddr`：必须与 `Registry.getModuleOrRevert(key)` 完全一致
    - 必须打印路由表（至少包含：Statistics/Reward/Liquidation/Risk/User/Position/Batch/Dashboard/Preview/Price）
  - **实现地址与版本信息可观测**（用于升级定位）
    - 对每个路由出来的 View：打印 `getVersionInfo()` 的 `apiVersion/schemaVersion/implementation`
  - **routePrice fallback 一致性（PRICE_ORACLE）**
    - `routePrice.primary` 必须是 `VALUATION_ORACLE_VIEW`，`fallback` 必须是 `PRICE_ORACLE`（两者地址都要与 Registry 对齐）
    - 对同一资产（脚本一般用 `MockUSDC`）：
      - `ValuationOracleView.getAssetPrice(asset)` 与 `PriceOracle.getPrice(asset)` 的 `(price,blockNumber)` 必须一致（`isValid` 不影响一致性校验）
      - 若 `PriceOracle.getPrice(asset)` 因“未配置/不支持” revert，则按 best-effort 语义视为 `(0,0)`，并要求 `ValuationOracleView` 返回也为 `(0,0)`（避免语义分叉）
  - **角色前置（硬失败）**
    - 运行 preflight 的 admin/deployer 必须具备：`VIEW_SYSTEM_DATA`、`VIEW_PRICE_DATA`、`VIEW_RISK_DATA`、`VIEW_USER_DATA`（避免脚本靠临时 grant 混过）

### 1.1) View 扫描工具（ViewScan）

- **用途**：在 acceptance 启动阶段扫描 View 模块 ABI/路由/版本信息（用于快速发现“代理指向旧实现 / ABI 不匹配 / 缺模块注册”等硬错误）。
- **实现**：`scripts/e2e/utils/view-scan.ts`
- **说明**：ViewScan 主要作为 “preflight 的内部能力/工具库”；不要把它当作单独的验收脚本入口。

### 2) 严格失败策略（避免“假阳性”）

- **ABI/部署不匹配必须硬失败**
  - 如果出现 `function selector was not recognized`（通常代表代理指向旧实现/ABI 不一致），必须直接失败并提示重新 `compile + deploy:localhost`
- **不依赖 revert 文本**
  - 对“必须 revert”的断言：优先断言 custom error selector/参数（如 `BatchTooLarge(length,max)`）；不要依赖 revert string

### 3) 各脚本的专属验收（与 Preflight 叠加）

- Preflight 只负责“跨模块一致性与可观测性”；每个模块的 acceptance 脚本仍需覆盖其章节要求（如 `nextVersion/requestId/seq/DataPushed/TTL` 等）。

### 4) 聚合器 ↔ 专属 View 的权限完全一致（更严 MUST）

- **目标**：对“同一类数据”，外部调用者无论走“聚合器入口”还是“专属 View 入口”，**权限行为必须完全一致**（同 ActionKey、同 revert 类型/selector）。
- **规则**：
  - **同类数据 → 同一 ActionKey**：
    - price：统一 `VIEW_PRICE_DATA`
    - risk：统一 `VIEW_RISK_DATA`（healthFactor / riskAssessment 等）
    - user：统一 `VIEW_USER_DATA`（仓位/用户私域聚合等）
    - system：统一 `VIEW_SYSTEM_DATA`
  - **聚合器不得绕过下游权限**：
    - 当专属 View 对某类数据要求 `requireRole(X)` 时，聚合器对同类数据也必须要求 `requireRole(X)`；反之亦然
  - **验收口径（硬指标）**：
    - 无权限 caller 调用“聚合器入口”和“专属 View 入口”都必须 `revert MissingRole()`（selector 一致）
    - 有权限 caller 两边都必须成功且返回一致
  - **实现注意**：
    - 当下游专属 View 增加只读鉴权后，为保证模块间调用不被误拦，部署脚本必须为聚合器模块地址授予必要的只读角色（但聚合器仍需对外部 caller 做鉴权）

## 脚本列表

### 1. `e2e-localhost-run.ts`

**基础业务流测试**

- 测试简单的 deposit → borrow → repay 流程
- 验证核心业务逻辑（VaultCore, CollateralManager, VaultLendingEngine）
- 适合做 SSOT/资金链路 smoke test（**不做严格 View/Stats 断言**）

### 2. `e2e-localhost-orderflow.ts`

**订单引擎流程测试**

- 测试订单创建和还款流程
- 验证 `core/LendingEngine`（ORDER_ENGINE）的 `createLoanOrder` 和 `repay` 功能
- 验证 LoanNFT 的铸造和状态更新
- 适合做 ORDER_ENGINE/签名/LoanNFT 的 smoke test（**不做严格 View/Stats 断言**）

### 3. `e2e-localhost-matchflow.ts`

**撮合/结算流程测试**

- 测试完整的撮合流程：`reserveForLending` → `finalizeMatch` → `repay`
- 验证 EIP-712 签名验证
- 验证 `VaultBusinessLogic` 的撮合编排功能
- 验证 LoanNFT 的铸造
- 适合做 matchflow 的 smoke test（**不做严格 View/Stats 断言**）

### 4. `e2e-localhost-full-with-views.ts` ⭐ **推荐**

**完整业务流 + View 层验证**

- 包含所有业务操作：deposit → borrow → repay → matchflow
- **在每个步骤后验证 View 层数据**：
  - `PositionView`: 用户持仓（抵押物和债务）
  - `HealthView`: 健康因子
  - `UserView`: 用户视图聚合
  - `RiskView`: 风险评估
  - `StatisticsView`: 全局统计数据
  - `DashboardView`: 前端友好的聚合视图
  - `RewardView`: 奖励查询
- 验证 View 层缓存是否正确更新
- 验证多个 View 模块的数据一致性
- **Reward 严格断言（新增）**：
  - 通过 `EasyToken.balanceOf` 与 `RewardView.getUserEasyEarnedWithMeta` 做 **delta/单调断言**（不依赖“链是否干净”）
  - 通过 `RewardView.getUserEarnStateWithMeta` 观察 `lockedEasy / eligibleLoanCount / onTimeRepayCount` 是否按还款链路推进
  - 当脚本使用的借款本金 < `MIN_ELIGIBLE_PRINCIPAL(1000e6)` 时，要求 **delta 必须为 0**，且 repay tx 中 **不得出现** `DataPushed(DATA_TYPE_EASY_MINTED, ...)`
- **Artifacts 输出（新增）**：
  - 运行结束会写入 `scripts/e2e/artifacts/full-with-views.<blockNumber>.json`
  - 包含模块地址快照、`RewardView.getVersionInfo()`、以及 RewardView `DataPushed` 按 `dataTypeHash` 的计数统计（含 `REWARD_EARN_STATE_UPDATED`）

### 4.1 `e2e-localhost-reward-privacy.ts` ⭐

**Reward 隐私 + Read-Gate 专项验收**

- 覆盖场景：
  - **隐私读取**：RewardView 的用户数据仅允许 **本人** 或 **运营团队（VIEW_USER_DATA）** 读取
  - **协议内读取**：`RewardView.getUserLevelForBorrowCheck` 仅允许 `ORDER_ENGINE` 调用（用于链上 borrow 门槛校验）
  - **Read-Gate**：`RewardManagerCore.get*` 查询接口禁止 EOA 直连（必须通过 RewardView）
  - **Easy 语义**：按期还款发放；提前还款不发放；逾期还款触发惩罚（默认 `latePenaltyBps=500`）

### 4.2 `e2e-localhost-systemview-routing.ts` ⭐

**SystemView 路由/发现性 + “不依赖 revert 文本”专项验收**

- 覆盖场景：
  - `SystemView.route*()` 必须返回可消费的 `moduleKey/moduleAddr`（前端/SDK 可下一跳直连专属 View）
  - `route*()` 返回地址必须与 `Registry.getModuleOrRevert(key)` 一致
  - `VIEW_SYSTEM_DATA` 统一口径权限：无权限调用者对 `SystemView.getModule* / route*` 必须被 gate 拦截
  - 旧 getter 已删除；ABI 中不应存在历史读入口

### 4.3 `e2e-localhost-positionview-acceptance.ts` ⭐

**PositionView（ARCH 4.2）专项验收：version/nextVersion/requestId/seq/DataPush + (user,asset) validity**

- 覆盖场景：
  - 读取 `getUserPositionWithMeta()` 必须返回 `collateral/debt + isValid + blockNumber + version`
  - `nextVersion` 严格并发：`currentVersion -> push(nextVersion=current+1) -> version 递增`；错误版本必须 revert
  - `requestId` 幂等：同 `requestId` 且 `nextVersion==currentVersion` 的重放应被忽略（不递增、不重复 DataPushed）
  - `seq` 顺序：非幂等场景下 `seq` 必须严格递增，否则 revert
  - 可观测性：成功 push 必须出现 `DataPushed(USER_POSITION_UPDATE, payload)` 且 payload 可解码与写入一致
  - (user,asset) 缓存有效性：一个资产的 push 不应给另一个资产“续命”

### 4.4 `e2e-localhost-healthview-acceptance.ts` ⭐

**HealthView（ARCH 4.3）专项验收：Scheme U 读收口 + batch 限制 + push gate + DataPushed + blockNumber/validity**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.3）：
  - **Scheme U 读权限（非公开）**：
    - `getUserHealthFactorWithMeta(user)`：self 放行；non-self 需 `VIEW_USER_DATA/ADMIN`（否则 `MissingRole()`）
    - `batchGetHealthFactorsWithMeta(users)`：users[] 枚举能力，无 self-bypass，需 `VIEW_USER_DATA/ADMIN`
  - **push 入口权限**：`pushRiskStatus/pushBatchRiskStatus` 必须 `ACTION_VIEW_PUSH` gate；无权限必须 `MissingRole()`
  - **DataPushed 可观测性**：成功 push 后必须出现 `DataPushed(DATA_TYPE_RISK_STATUS/_BATCH, payload)` 且 payload 可 ABI 解码
  - **批量边界**：`batchGetHealthFactorsWithMeta` 空数组必须 `revert EmptyArray()`；超限必须 `revert BatchTooLarge(len,max)`
  - **缓存有效性**：读取返回 `isValid/blockNumber`；TTL 过期后（CACHE_DURATION=5m）`isValid=false`（blockNumber 不变）

### 4.5 `e2e-localhost-viewcache-acceptance.ts` ⭐

**ViewCache（ARCH 4.5）专项验收：系统级快照 isValid/blockNumber + 写入口 gate + DataPushed**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.5）：
  - 读 `getSystemStatus(asset)` 必须返回 `blockNumber` 且可用于判断 `isValid`
  - 无权限账号调用 `setSystemStatus` 必须 revert
  - 有权限写入后 `isValid=true` 且 blockNumber 更新，并出现 `DataPushed(SYSTEM_STATUS_CACHE, payload)`

### 4.6 `e2e-localhost-accesscontrolview-acceptance.ts` ⭐

**AccessControlView（ARCH 4.6）专项验收：onlyACM push + DataPushed(type/payload) + 读带有效性 + TTL 过期**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.6）：
  - 只能由 `AccessControlManager` 推送缓存（EOA 调用 `push*` 必须 revert）
  - 权限位/权限级别更新后必须出现 `DataPushed`，且 `dataTypeHash` 分别为 `PERMISSION_BIT_UPDATE` / `PERMISSION_LEVEL_UPDATE`，payload 可 ABI 解码
  - push 后立即可读：`getUserPermissionWithMeta/getUserPermissionLevelWithMeta` 返回 `isValid=true` 且 `blockNumber` 合理
  - 超过 TTL 后 `isValid` 变为 false（值与 blockNumber 保留）

### 4.7 `e2e-localhost-userview-acceptance.ts` ⭐

**UserView（ARCH 4.7）专项验收：纯 façade + meta 透传 + 聚合一致性 + 禁止 asset=0 总量语义**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.7）：
  - `UserView` 不得包含任何 `push*` 写入口（脚本从 ABI 扫描并硬失败）
  - `getUserTotalsWithMeta/getUserTotalCollateral/getUserTotalDebt` 必须从 `StatisticsView` 权威快照读取（不允许通过 `asset=0` 占位实现）
  - `getUserStatsWithMeta` 的数值与 meta 必须与 `PositionView.getUserPositionWithMeta` / `HealthView.getUserHealthFactorWithMeta` 一致
  - TTL 过期后，`UserView` 透传的 `isValid` 必须随下游变为 false

### 4.8 `e2e-localhost-valuationoracleview-acceptance.ts` ⭐

**ValuationOracleView（ARCH 4.8）专项验收：价格读取权限一致性（与 BatchView 对齐）+ batch 限制 + best-effort**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.8）：
  - 无 `VIEW_PRICE_DATA` 的调用者：`ValuationOracleView.getAssetPrice` 与 `BatchView.batchGetAssetPrices` 必须一致 revert
  - 有权限调用者：同一资产价格在 `ValuationOracleView` 与 `BatchView` 的返回语义一致（至少 price 一致）
  - 超过 `MAX_BATCH_SIZE` 必须按统一口径失败（脚本不依赖 revert 文本，但要求确实失败）
  - 未配置资产的 best-effort 返回可被脚本覆盖（默认 price=0 允许）

### 4.9 `e2e-localhost-feerouterview-acceptance.ts` ⭐

**FeeRouterView（ARCH 4.9）专项验收：only FeeRouter push + staleness/validity + DataPushed**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.9）：
  - 非 FeeRouter 地址调用任意 `push*` 必须 revert（writer SSOT：`FEE_ROUTER`）
  - FeeRouter 调用 `pushGlobalStatsUpdate` 后：
    - `getSyncStatus()` 返回 `lastSyncBlock == tx block.number`
    - `needsSync=false` 且 `isValid=true`
    - 必须出现 `DataPushed(GLOBAL_FEE_STATS, payload)`，payload 可 ABI 解码
  - 超过 `SYNC_INTERVAL` 后 `needsSync=true` 且 `isValid=false`（`lastSyncBlock` 不变）

### 4.10 `e2e-localhost-liquidatorview-acceptance.ts` ⭐

**LiquidatorView（ARCH 4.10）专项验收：单点 push + DataPushed + 权限口径不混用**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.10）：
  - **单点推送（writer gating）**：
    - 非 `LIQUIDATION_MANAGER` 调用 `pushLiquidationUpdate/pushBatchLiquidationUpdate` 必须 `revert InvalidCaller()`
    - 非 `LIQUIDATION_MANAGER`/`LIQUIDATION_PAYOUT_MANAGER` 调用 `pushLiquidationPayout` 必须 `revert InvalidCaller()`
  - **事件（DataPushed）**：
    - `pushLiquidationUpdate` 成功后必须出现 `DataPushed(LIQUIDATION_UPDATE, payload)` 且 payload 可 ABI 解码并匹配入参
    - `pushLiquidationPayout` 成功后必须出现 `DataPushed(LIQUIDATION_PAYOUT, payload)`
  - **权限口径一致（不得混用 system/risk/user/liquidation）**：
    - system 读接口：需 `VIEW_SYSTEM_DATA`
    - risk 读接口：需 `VIEW_RISK_DATA`
    - user 私域：需 `VIEW_USER_DATA`（非本人需 admin）
    - liquidation 读接口：需 `VIEW_LIQUIDATION_DATA`
  - **新鲜度字段（placeholder 一致性）**：
    - 对返回的 `lastLiquidationBlock/blocksSinceLastLiquidation` 做基本一致性断言（0 → 0）

### 4.11 `e2e-localhost-batch-aggregators-acceptance.ts` ⭐

**BatchView / CacheOptimizedView / DashboardView（ARCH 4.11）专项验收：只聚合不写入 + batch 限制统一 + 权限不绕过**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.11）：
  - **职责边界（静态合规）**：
    - 断言三者 ABI 中不存在任何 `push*` 写入口
    - 断言除 UUPS/initializer 必要入口外，ABI 中不存在其他非 `view/pure` 的外部函数（防“偷偷写状态”回归）
  - **批量限制（统一错误类型）**：
    - 对 101 长度数组/limit 触发超限，必须统一 `revert BatchTooLarge(101, 100)`
  - **权限一致性（不得绕过下游）**：
    - 对 price 数据：`BatchView.batchGetAssetPrices` 与 `ValuationOracleView.getAssetPrices` 对无权限 caller 均 `revert MissingRole()`
  - **返回一致性**：
    - `BatchView.batchGetAssetPrices([asset])` 与 `ValuationOracleView.getAssetPrices([asset])` 返回价格一致
    - `DashboardView.getUserAssetBreakdownWithMeta` 的 PositionView meta 字段与 `PositionView.getUserPositionWithMeta` 一致

### 4.12 `e2e-localhost-lendingengineview-acceptance.ts` ⭐

**LendingEngineView（ARCH 4.12）专项验收：订单私域/运维查询的权限口径统一 + 无 push 写入口**

- 覆盖场景：
  - ABI 不存在 `push*` 写入口
  - `getLoanOrder`：仅订单相关方（borrower/lender）或 ops（`VIEW_USER_DATA`）可读；其它 caller `MissingRole()`
  - 运维接口（如 `getFailedFeeAmount`）：仅 ops（`VIEW_SYSTEM_DATA`）可读；其它 caller `MissingRole()`

### 4.13 `e2e-localhost-previewview-acceptance.ts` ⭐

**PreviewView（ARCH 4.13）专项验收：只读预览门面 + 用户私域权限（MissingRole 统一）**

- 覆盖场景：
  - ABI 不存在 `push*` 写入口
  - 非本人调用 preview 系列接口必须 `MissingRole()`
  - 本人调用可成功
  - 输入校验（asset=0）按实现 revert（`PreviewView__InvalidInput()`）

### 4.14 `e2e-localhost-modulehealthview-acceptance.ts` ⭐

**ModuleHealthView（ARCH 4.15）专项验收：运维/监控扩展 View + DataPush(MODULE_HEALTH) + 缓存 meta（isValid/blockNumber）**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.15）：
  - `unauthorized` 调用 `checkAndPushModuleHealth/getModuleHealthStatus/getModuleHealthStatusWithMeta/checkModuleHealth` 必须 `MissingRole()`
  - `operator`（具备 `ACTION_VIEW_SYSTEM_STATUS`）调用 `checkAndPushModuleHealth` 必须成功
  - 成功后必须出现 `DataPushed(MODULE_HEALTH, payload)` 且 payload 可 ABI 解码
  - `getModuleHealthStatusWithMeta` 返回 `blockNumber/isValid`，TTL 过期后 `isValid=false`（blockNumber 不变）

### 4.15 `e2e-localhost-eventhistorymanager-acceptance.ts` ⭐

**EventHistoryManager（ARCH 4.16）专项验收：events-only + recordEvent 权限 gate + DataPushed(EVENT_HISTORY) 可解码**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.16）：
  - 无权限账号调用 `recordEvent` 必须 `MissingRole()`
  - 有权限账号调用 `recordEvent` 必须成功
  - 成功后必须同时观察到 `HistoryRecorded` 与 `DataPushed(EVENT_HISTORY, payload)`
  - `DataPushed` 的 payload 必须可 ABI 解码回 `eventType/user/asset/amount/extraData`

### 4.16 `e2e-localhost-rewardview-acceptance.ts` ⭐

**RewardView（ARCH 4.14）专项验收：写入口白名单 + DataPushed + 用户私域读权限（Scheme U）+ B 类缓存有效性**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.14）：
  - **写入口白名单**：非 writer 调用任意 `push*` 必须 revert
  - **DataPush 可观测性**：关键写入（含 `pushEasyMinted/pushEasySpent/pushEasyRecycledSplit/pushEarnState` 以及 reward/penalty/system 侧的 `push*`）成功必须出现 `DataPushed`，且 `dataTypeHash` 来自集中常量口径（`DataPushTypes`）
  - **用户私域读权限（Scheme U）**：非本人读取 Reward 私域数据必须 `MissingRole()`；本人/ops/admin 可读
  - **B 类缓存有效性**：`getUserEasyEarnedWithMeta` 与 `getUserEarnStateWithMeta` 返回值必须包含 `blockNumber/isValid`；blockNumber 单调推进；过期后 `isValid=false`

### 4.17 `e2e-localhost-rewardmanager-governance.ts` ⭐

**RewardManager 治理/权限路径验收（入口收紧 + GFM 惩罚 SSOT）**

- 覆盖场景：
  - **入口收紧**：非 `ORDER_ENGINE` 调用 `onLoanEventByOrder` 必须 `MissingRole()`
  - **惩罚入口**：非 `GUARANTEE_FUND` 调用 `applyPenalty` 必须 `MissingRole()`
  - **审计事件**：`applyPenalty` 成功后必须出现 `PenaltyApplied` 与 `ActionExecuted`
  - **欠 Easy 账本**：`applyPenalty`（用户可用 Easy 不足）应增加 `RewardView.pendingPenalty`

### 4.18 `e2e-localhost-statisticsview-acceptance.ts` ⭐

**StatisticsView（ARCH 4.4）专项验收：系统聚合只读 + push 后单调推进 + 并发/幂等（nextVersion/requestId/seq）**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 4.4）：
  - **系统聚合只读**：`getGlobalStatistics/getGlobalStatisticsWithMeta` 返回 `totalUsers/activeUsers/totalCollateral/totalDebt/lastUpdateBlock` + `(isValid,blockNumber)`
  - **推送后单调推进**：`pushUserStatsUpdate` 后总量按增量变化，`lastUpdateBlock` 单调；必须出现 `DataPushed(DATA_TYPE_USER_STATS_UPDATE, payload)`
  - **并发/幂等**：错误 `nextVersion` 必须 `revert StatisticsView__StaleUserStatsVersion`；同 `requestId` 重放不得 emit `DataPushed` 且版本不变；乱序 `seq` 必须 `revert StatisticsView__OutOfOrderSeq`

### 4.19 `e2e-localhost-liquidation-reward-penalty.ts` ⭐

**清算 → Reward 惩罚（语义拆分）端到端验收**

- 覆盖场景：
  - **清算交易**：`SettlementManager.settleOrLiquidate(orderId)` 成功后可观测 `LIQUIDATION_*` DataPush（可选严格）；同时**不应**出现 `RewardView.DataPushed(REWARD_BURNED/REWARD_PENALTY_LEDGER_UPDATED)`
  - **惩罚交易**：由 `GuaranteeFundManager` 作为 caller 调用 `RewardManager.applyLiquidationPenalty(user)`；脚本先创建独立 Reward lock，再用 `quoteLiquidationPenalty(user)` 作为期望值，断言 `RewardAccrualManager.getPenaltyDebt(user)` 精确增量，并可观测 `RewardView.DataPushed(REWARD_BURNED|REWARD_PENALTY_LEDGER_UPDATED)`
- strict 开关：
  - `E2E_STRICT_DATAPUSH=1`：清算 tx 必须出现 `LIQUIDATION_*` push
  - `E2E_STRICT_REWARD=1`：清算 tx 必须“无 reward push”，惩罚 tx 必须“有 reward push”

### 5. `e2e-localhost-batch-10-users.ts`

**10 用户批量撮合借贷（5 组 borrower+lender）+ 总数验收**

- 使用 10 个 signer，每 2 个一组：borrower deposit 抵押、lender reserve 资金、deployer finalizeMatch
- 分两次做总数一致性验收：
  - **撮合完成后**：校验 `Ledger(sum)` 与 `StatisticsView(total)` 的 `totalCollateral/totalDebt` 等于期望值
  - **全部还清后**：校验 `totalDebt == 0`
- Phase3 可观测性：在关键 checkpoint 显式输出一个“样本 borrower”的：
  - `PositionView.getPositionVersion(user, asset)`（version）
  - `PositionView.getUserPosition(user, asset)`（col/debt，便于对照）
  - `PositionView.getVersionInfo()` / `StatisticsView.getVersionInfo()`（apiVersion/schemaVersion/implementation，用于升级后快速识别版本）
- ViewScan（新增）：启动阶段从 Registry 扫描全部 View 模块并调用 `getVersionInfo()` + 少量只读 sanity-call。
  - 默认 best-effort（只打印告警不失败）
  - 可选严格模式：`E2E_VIEW_STRICT=1`（任何 View 扫描失败将直接终止脚本）
- Reward（新增）：按 `Architecture-Guide.md` 的唯一路径（LE 落账后触发）对 **EasyToken/RewardView** 做最小端到端断言：
  - 输出 **人类可读 Easy**（`EasyToken.decimals()`）与 raw 值
  - eligible repay：应可观测 `DataPushed(DATA_TYPE_EASY_MINTED, ...)`，且 `EasyToken.balanceOf` 增加（并确保 `RewardView.getUserEasyEarnedWithMeta` 单调不减）
  - eligible repay 后，`RewardView.getUserEarnStateWithMeta` 应同步反映 Earn 侧状态推进
  - ineligible repay：不应出现 `DataPushed(DATA_TYPE_EASY_MINTED, ...)`，且 `EasyToken.balanceOf` 不应增加
- Read-gate（补强）：EOA 直连 `RewardManagerCore.get*` 必须失败；写入口直连 `onLoanEventByOrder` / `onLoanEventByOrderWithLender` 必须以 `RewardManagerCore__UseRewardManagerEntry` 或权限错误被拦截
- Artifacts（新增）：运行结束写入 `scripts/e2e/artifacts/batch-10-users.<blockNumber>.json`，包含模块快照、`RewardView.getVersionInfo()`、以及 `DataPushed` 按 `dataTypeHash` 的计数统计
- “样本 borrower”可配置：
  - **env**：`E2E_SAMPLE_BORROWER_INDEX=0..4`（默认 0）
  - **task/argv**：`npx hardhat e2e:batch-10-users --sample-borrower-index 0..4`（task 定义在 `scripts/tasks/e2e-batch-10-users.ts`，并已在 `hardhat.config.ts` 引入）

### 6. `e2e-localhost-attack-suite.ts` ⭐

**安全攻击场景测试套件：权限提升/重入/升级攻击防御验证**

- 覆盖场景：
  - **Registry owner-only 调用**：非 owner 调用 `setModule` 必须 revert
  - **AccessControl 权限提升尝试**：非 admin 尝试 `grantRole` 必须 revert
  - **VaultCore/VBL 受限入口点**：非授权调用者尝试 `borrowFor/repayFor/processUserOperation/depositCollateral/liquidate` 必须 revert
  - **Oracle 操纵尝试**：非授权调用者尝试 `updatePrice/configureAsset/setAssetActive` 必须 revert
  - **LiquidationManager admin 调用**：非 admin 尝试 `pause/unpause` 必须 revert
  - **UUPS 升级攻击尝试**：对关键 UUPS 合约尝试非法升级必须 revert
  - **重入攻击防御**：通过恶意 view callback 尝试重入必须被防御

### 7. `e2e-localhost-feerouter.ts`

**FeeRouter 业务逻辑 E2E 测试：费率初始化/费用分发/动态费率/权限控制**

- 覆盖场景：
  - **费率初始化正确性**：验证费率配置与读取一致性
  - **费用分发功能**：验证费用正确分发到 Treasury/EcoVault 等目标地址
  - **动态费率设置**：验证费率动态更新与生效
  - **权限控制验证**：验证费率设置权限控制
  - **批量费用分发**：验证批量场景下的费用分发正确性
  - **费用统计功能**：验证费用统计数据的准确性
  - **大金额处理**：验证大金额场景下的费用计算正确性
  - **事件验证**：验证费用相关事件的正确触发

### 8. `e2e-localhost-scenario-matrix.ts` ⭐

**E2E 场景矩阵（ARCH 5.1.3）：多用户资金流回放 + 推送失败模拟 + 批量边界**

- 覆盖场景（对应 `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 5.1.3）：
  - **E2E-01 多用户资金流回放**：N 用户 deposit/borrow/repay/withdraw 交错执行；每步后用 `DashboardView/CacheOptimizedView/BatchView` 批量拉取；验证数据一致性与有效性信息不丢
  - **E2E-02 推送失败模拟与链下重试**：故意触发 push 失败 → 监听失败事件 → 链下重试 push；验证失败可观测且可重放；无链上循环重试
  - **E2E-03 批量边界与性能**：接近 `MAX_BATCH_SIZE` 的批量调用 + 超限调用；验证不 OOG；超限一致失败
  - **验收证据输出**：模块地址快照、关键 View 的 `getVersionInfo()`、`DataPushed` 按 `dataTypeHash` 计数统计、失败事件计数

### 9. `e2e-localhost.ts`

**基础 E2E 流程测试（简化版）**

- 测试简单的 deposit → borrow → repay 流程
- 验证核心业务逻辑（VaultCore, CollateralManager, VaultLendingEngine）
- 适合做快速 smoke test（**不做严格 View/Stats 断言**）

### 10. `e2e-localhost-batch-advanced-10-users.ts` ⭐

**高级批量测试：部分还款 / 逾期还款 / 多 lender 拆单 + 每步 View 断言**

- 10 个 signer：5 个 borrower + 5 个 lender
- 覆盖场景：
  - **部分还款**：同一笔订单分两次 repay，并断言每次后 `PositionView/UserView` 与账本一致
  - **逾期还款**：`evm_increaseTime` 快进到超过到期日后再 repay
  - **多 lender 拆单**：将 500 拆成两笔 250/250（两笔订单），分别由不同 lender 出借（更贴近真实“拆单”）
  - **EarlyRepaymentGuarantee（保证金：lock → early settle）**：覆盖 `EarlyRepaymentGuaranteeManager` + `GuaranteeFundManager` 的联动路径（锁定 → 提前结算分配）
  - **边界/负例补强**（新增）：
    - 资产白名单移除后 `reserveForLending` 必须 revert
    - `PreviewView` LTV 边界（just-above-max）只做预览校验，不依赖 revert
    - `SystemView` 路由一致性（Registry ↔ route\* 对齐）
  - **风险更新自然触发**（新增）：
    - 通过真实借贷/还款/清算路径触发 `HealthView.pushRiskStatus`（LendingEngineCore 内部）
    - 严格模式下要求 `HealthView` cache 已更新（`isValid=true` 且 `blockNumber>0`）
- 每一步都断言（strict 模式下为硬失败）：
  - `PositionView.getUserPosition` == `UserView.getUserPosition` == `CollateralManager/VaultLendingEngine`（账本）
  - `RiskView.getUserRiskAssessment` 可正常调用（不对语义做强约束）
- Phase3 可观测性：在关键 checkpoint 显式输出一个“样本 borrower”的 `PositionView` version（用于观察严格 `nextVersion` 的单调递增写入）
- 同时在启动阶段输出关键 View 的 `getVersionInfo()`（apiVersion/schemaVersion/implementation），便于定位升级影响
- ViewScan（新增）：同上
  - 默认：随 strict 策略（本脚本中 strict 默认开启）
  - 关闭 strict：`E2E_STRICT_VIEWS=0`
- Reward（升级为严格一致性）：
  - 通过 `EasyToken.decimals()` 输出 **人类可读 Easy** 与 raw 值
  - 通过 `EasyToken.balanceOf` 与 `RewardView.getUserEasyEarnedWithMeta` 做 **delta/单调断言**：
    - 若本金 \(\ge 1000e6\)（eligible），按期全额还款应可观测 `DataPushed(DATA_TYPE_EASY_MINTED, ...)`，且 Easy 余额增加
    - 若本金 \(< 1000e6\)（ineligible），不应出现 `DataPushed(DATA_TYPE_EASY_MINTED, ...)`，且 Easy 余额不应增加
  - Read-gate（补强）：EOA 直连 `RewardManagerCore.get*` 必须按 selector 失败（不得绕过 RewardView）
- **Artifacts 输出（新增）**：
  - 运行结束会写入 `scripts/e2e/artifacts/batch-advanced-10-users.<blockNumber>.json`
  - 包含模块地址快照、`RewardView.getVersionInfo()`、以及全链路 `DataPushed` 按 `dataTypeHash` 的计数统计（含 reward/system/liquidation 等）
- “样本 borrower”可配置：
  - **env**：`E2E_SAMPLE_BORROWER_INDEX=0..4`（默认 0）
  - **task/argv**：`npx hardhat e2e:batch-advanced --sample-borrower-index 0..4`（task 定义在 `scripts/tasks/e2e-batch-advanced.ts`，并已在 `hardhat.config.ts` 引入）

## 网络兼容性（任何链）

> 目标：同一套 E2E 文档能在 **本地链 / devnet / testnet / fork** 上复用。
> 关键点：不同脚本对“链能力”的依赖不同。

### 链能力要求（按强度排序）

1. **只读能力（任何链）**

- 只依赖 `eth_call`、事件查询、只读 View 接口
- 适合：多数 _acceptance_ / _routing_ / _view_ 验收脚本

2. **可写能力（devnet/testnet）**

- 需要真实交易 + 角色授予 + 可用资金（faucet 或 mint）
- 适合：基础业务流、撮合流程、Reward/Stats 等落账

3. **可控时间/快照能力（本地链/可控 devnet）**

- 需要 `evm_snapshot` / `evm_revert` / `hardhat_mine` / `evm_increaseTime`
- 适合：逾期/TTL/缓存失效/性能矩阵等需要“时间跳转”的脚本

### 运行前检查（任何链通用）

- **Registry 完整性**：目标链必须已部署并注册所有模块（`Registry.getModuleOrRevert` 不应抛 `ModuleNotRegistered`）
- **权限**：运行账号必须具备 View/Stats 所需的只读角色（`runViewPreflight` 会检查）
- **资产/价格**：目标链上的结算资产必须可用（已入白名单且价格可读）

> 如果你希望“哪条链都能跑”，建议先跑只读/acceptance 脚本；
> 需要写入或时间跳转的脚本，要求链本身支持对应能力。

## 运行方式（通用）

> 适用于任何已在 `hardhat.config.ts` 配置过的网络。

### 快速命令参考（针对批量测试）

#### 完整流程（3 个终端窗口）

**终端 1：启动本地 Hardhat 节点（仅 localhost）**

```bash
pnpm -s run node
```

或者使用完整命令：

```bash
hardhat node --hostname 127.0.0.1 --port 8545
```

**终端 2：部署合约（根据网络选择）**

```bash
pnpm -s run deploy:localhost
```

或者使用完整命令：

```bash
pnpm -s hardhat run scripts/deploy/deploylocal.ts --network localhost
```

> 非 localhost 网络请使用对应的部署脚本/流程（确保 Registry 模块已完整注册）。

**终端 3：运行 E2E 测试**

> 推荐说明（避免“静默失败”）：
>
> - 本仓库当前没有 `e2e:localhost:batch-advanced-10-users` 这类 `package.json scripts`。
> - 如果你误用 `pnpm -s e2e:...`，可能出现 **exit code=254 且几乎无输出**。
> - 正确方式：用 `npx hardhat run ... --network localhost`（或等价的 `pnpm exec hardhat run ...`）。

运行 `e2e-localhost-batch-10-users.ts`：

```bash
npx hardhat run scripts/e2e/e2e-localhost-batch-10-users.ts --network <network>
```

运行 `e2e-localhost-batch-advanced-10-users.ts`：

```bash
npx hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network <network>
```

> 说明：两份 batch 脚本默认会在末尾串行执行 Reward 专项脚本（RewardView acceptance / privacy+read-gate / edgecases / break-glass）。  
> 如需加速排障可跳过：`E2E_SKIP_REWARD_SUITES=1 npx hardhat run ...`

运行 `e2e-localhost-degradationmonitor-trends-acceptance.ts`（验证 DegradationMonitor 趋势在 analytics 未配置时不再返回全 0）：

```bash
npx hardhat run scripts/e2e/e2e-localhost-degradationmonitor-trends-acceptance.ts --network <network>
```

运行 `e2e-localhost-rewardconfig-breakglass.ts`（验证 RewardConfig “break-glass” 紧急写入权限：有权限可直连写入，撤销后必须 revert，但常规写入路径仍可用，最后恢复权限）：

```bash
npx hardhat run scripts/e2e/e2e-localhost-rewardconfig-breakglass.ts --network <network>
```

运行 `scripts/tests/funds-flow-invariants-suite.ts`（资金链 invariants suite，新增 RewardConfig break-glass 强约束预检查；并修复 guarantee “隐性耦合”导致的非 guarantee 场景失败）：

- **默认推荐（不跑 guarantee-extension）**：基线禁用 guarantee，避免 `finalizeMatch` 额外要求 borrower 对 `GuaranteeFundManager` 的 allowance

```bash
RUN_GUARANTEE_EXTENSION=0 npx hardhat run scripts/tests/funds-flow-invariants-suite.ts --network <network>
```

- **需要跑 guarantee-extension 时**：显式开启，按 suite 自己的 guarantee 流程单独启用/验证

```bash
RUN_GUARANTEE_EXTENSION=1 npx hardhat run scripts/tests/funds-flow-invariants-suite.ts --network <network>
```

> 说明：
>
> - suite 内部会用 `evm_snapshot/evm_revert` 包裹用例，避免污染链状态。
> - `break-glass` 预检查对齐 `e2e-localhost-rewardconfig-breakglass.ts` 的强约束：撤销 `ACTION_REWARD_CONFIG_EMERGENCY` 后 **direct call** 必须 revert，但通过 `RewardConfig.setServiceCooldown(FeatureUnlock, ...)` 的 SSOT 路径仍必须成功并真实修改 `FeatureUnlockConfig.getCooldown()`。

### 前置条件

1. **启动本地 Hardhat 节点（仅 localhost）**：

```bash
pnpm -s run node
```

或者使用完整命令：

```bash
hardhat node --hostname 127.0.0.1 --port 8545
LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s run deploy:localhost
```

2. **部署合约**（在另一个终端，按网络选择）：

```bash
pnpm -s run deploy:localhost
```

> 如果使用非默认端口（如 `:18545`），请在部署/对齐/测试时统一设置 `LOCALHOST_RPC_URL`。
> 或者使用完整命令：

```bash
hardhat run scripts/deploy/deploylocal.ts --network localhost
```

### 运行测试脚本

3. **Registry 对齐预处理（推荐）**：运行全量 E2E 前先对齐 Registry 与配置。

```bash
npx hardhat run scripts/e2e/utils/registry-rebind-from-config.ts --network <network>
```

4. **Registry 对齐验收（必须）**：全量 E2E 结束后输出对齐表并确认 `mismatches=0`。

```bash
npx hardhat run scripts/e2e/utils/registry-alignment-report.ts --network <network>
```

#### 全量 E2E 一键命令（推荐）

```bash
npx hardhat run scripts/e2e/utils/registry-rebind-from-config.ts --network <network> && for f in scripts/e2e/*.ts; do echo "\n=== Running $f ==="; npx hardhat run "$f" --network <network> || exit $?; done && npx hardhat run scripts/e2e/utils/registry-alignment-report.ts --network <network>
```

或使用 `pnpm exec` 版本：

```bash
pnpm -s exec hardhat run scripts/e2e/utils/registry-rebind-from-config.ts --network <network> && for f in scripts/e2e/*.ts; do echo "\n=== Running $f ==="; pnpm -s exec hardhat run "$f" --network <network> || exit $?; done && pnpm -s exec hardhat run scripts/e2e/utils/registry-alignment-report.ts --network <network>
```

### CI 运行建议（基于 Hardhat 本地链）

> 目标：CI 依托 **Hardhat 本地链** 跑 smoke/E2E，保持“可重复、可定位、可审计”。

**推荐顺序**：

1. 启动本地 Hardhat 节点
2. 部署 `deploylocal.ts`
3. Registry 对齐（rebind）
4. 运行 E2E 脚本（可全量或选定子集）
5. 输出 Registry 对齐报告

**示例（bash）**：

```bash
# 1) 启动 node（后台）
pnpm -s run node > /tmp/hardhat-node.log 2>&1 &

# 2) 部署
pnpm -s exec hardhat run scripts/deploy/deploylocal.ts --network localhost

# 3) Registry 对齐
pnpm -s exec hardhat run scripts/e2e/utils/registry-rebind-from-config.ts --network localhost

# 4) 运行 E2E（全量）
for f in scripts/e2e/*.ts; do
  echo "\n=== Running $f ==="
  pnpm -s exec hardhat run "$f" --network localhost || exit $?
done

# 5) 对齐报告
pnpm -s exec hardhat run scripts/e2e/utils/registry-alignment-report.ts --network localhost
```

**更贴近 CI 的 smoke runner（推荐）**：

- 入口：`pnpm -s run test:smoke:prodlike:localhost`
- 自动起临时节点（CI 友好）：`pnpm -s run test:smoke:prodlike:localhost:autonode`
- 方案 A/B/C/D 与开关请见：`scripts/tests/README.md`

**常用环境变量**：

- `E2E_STRICT_VIEWS=0`：关闭严格 View 校验（仅临时排障）
- `E2E_ALLOW_DIRTY_STATE=1`：允许非干净链状态（更贴近 testnet/mainnet）

> 提示：CI 中建议保留 `hardhat-node` 日志（如上例写入 `/tmp/hardhat-node.log`），便于定位 ABI/部署不匹配或权限缺失问题。

#### 基础业务流测试

```bash
npx hardhat run scripts/e2e/e2e-localhost-run.ts --network <network>
```

#### 订单引擎流程测试

```bash
npx hardhat run scripts/e2e/e2e-localhost-orderflow.ts --network <network>
```

#### 撮合流程测试

```bash
npx hardhat run scripts/e2e/e2e-localhost-matchflow.ts --network <network>
```

#### 完整测试（推荐）⭐

```bash
npx hardhat run scripts/e2e/e2e-localhost-full-with-views.ts --network <network>
```

#### Reward 隐私 + Read-Gate 专项验收 ⭐

```bash
npx hardhat run scripts/e2e/e2e-localhost-reward-privacy.ts --network <network>
```

#### SystemView 路由/发现性专项验收 ⭐

```bash
npx hardhat run scripts/e2e/e2e-localhost-systemview-routing.ts --network <network>
```

#### PositionView（ARCH 4.2）专项验收 ⭐

```bash
npx hardhat run scripts/e2e/e2e-localhost-positionview-acceptance.ts --network <network>
```

#### HealthView（ARCH 4.3）专项验收 ⭐

```bash
npx hardhat run scripts/e2e/e2e-localhost-healthview-acceptance.ts --network <network>
```

#### RewardView（ARCH 4.14）专项验收 ⭐

```bash
npx hardhat run scripts/e2e/e2e-localhost-rewardview-acceptance.ts --network <network>
```

#### RewardManager 治理/权限专项验收 ⭐

```bash
npx hardhat run scripts/e2e/e2e-localhost-rewardmanager-governance.ts --network <network>
```

#### StatisticsView（ARCH 4.4）专项验收 ⭐

```bash
npx hardhat run scripts/e2e/e2e-localhost-statisticsview-acceptance.ts --network <network>
```

#### 清算 → Reward 惩罚（语义拆分）⭐

```bash
pnpm -s exec hardhat e2e:liquidation-reward-penalty --network <network>
```

或直接运行脚本：

```bash
npx hardhat run scripts/e2e/e2e-localhost-liquidation-reward-penalty.ts --network <network>
```

#### Reward Edge Cases（多订单/partial repay/提前-按期-逾期/penaltyLedger）⭐

```bash
npx hardhat e2e:reward-edgecases --network <network>
```

- 脚本：`scripts/e2e/e2e-localhost-reward-edgecases.ts`
- 覆盖场景：
  - **多订单场景**：同一用户创建多个订单，验证 Easy / EarnState 累计与隔离正确性
  - **部分还款**：同一订单分多次还款，验证部分还款不会错误提前 mint Easy，且 penaltyLedger 更新正确
  - **提前/按期/逾期还款**：验证不同还款时机的 Easy 语义（提前不发放、按期按规则发放、逾期进入 penalty ledger / burn 路径）
  - **penaltyLedger 更新**：验证逾期还款后 penaltyDebt 的正确记录与查询
  - **DataPushed 可观测性**：验证 Reward 相关 push 操作覆盖 `EASY_MINTED / REWARD_PENALTY_LEDGER_UPDATED / REWARD_EARN_STATE_UPDATED` 等当前口径

**本次回归总结（常见失败点与修复）**

- **Read-gate（selector 校验）**：在部分 provider/实现路径下，未授权 EOA 读取 `RewardManagerCore` 可能出现 **revert 但无 revert data**（`data=0x`），导致“按 selector 精确断言”误判失败。
  - 修复策略：read-gate 检查允许 `no-data revert` 作为“已被 gate 拦截”的通过条件（仅限该检查）。
- **场景隔离（全局参数污染）**：`Earn formula (3b)` 会修改全局奖励参数（level multiplier / dynamic params），若后续场景依赖固定基数（如 late penalty 5% of 1 point），需要在场景开始前把参数归一化回确定值。
  - 修复策略：在 late penalty 场景前显式设置 `setLevelMultiplier(1,1x)`、`setDynamicRewardParams(off)`、`setLatePenaltyBps(500)`。

#### 10 用户批量撮合借贷（推荐用于压测/一致性验收）

```bash
npx hardhat run scripts/e2e/e2e-localhost-batch-10-users.ts --network <network>
```

##### 可配置：选择一个 “样本 borrower” 打印 PositionView.version（Phase3 可观测性）

- **env 方式（兼容旧用法）**：

```bash
E2E_SAMPLE_BORROWER_INDEX=2 npx hardhat run scripts/e2e/e2e-localhost-batch-10-users.ts --network <network>
```

- **argv/task 方式（推荐）**：

```bash
pnpm -s exec hardhat e2e:batch-10-users --network <network> --sample-borrower-index 2
```

#### 安全攻击场景测试套件 ⭐

```bash
npx hardhat run scripts/e2e/e2e-localhost-attack-suite.ts --network <network>
```

#### FeeRouter 业务逻辑 E2E 测试

```bash
npx hardhat run scripts/e2e/e2e-localhost-feerouter.ts --network <network>
```

#### E2E 场景矩阵（ARCH 5.1.3）⭐

```bash
npx hardhat run scripts/e2e/e2e-localhost-scenario-matrix.ts --network <network>
```

#### 基础 E2E 流程测试（简化版）

```bash
npx hardhat run scripts/e2e/e2e-localhost.ts --network <network>
```

#### 高级批量测试（部分还款/逾期/拆单 + 每步 View 断言）⭐

```bash
npx hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network <network>
```

##### Strict 模式相关（本脚本默认开启）

- **默认（推荐）**：严格校验（任何 View/Stats 与账本不一致会直接失败）

```bash
npx hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network <network>
```

- **关闭 strict（仅用于临时排障）**：

```bash
E2E_STRICT_VIEWS=0 npx hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network <network>
```

- **允许 dirty state（更贴近 testnet/mainnet）**：

```bash
E2E_ALLOW_DIRTY_STATE=1 npx hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network <network>
```

##### 可配置：选择一个 “样本 borrower” 打印 PositionView.version / getPositionVersion（Phase3 可观测性）

- **env 方式（仍然支持）**：

```bash
E2E_SAMPLE_BORROWER_INDEX=2 npx hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network <network>
```

- **argv/task 方式（推荐）**：
  - task 定义在 `scripts/tasks/e2e-batch-advanced.ts`
  - 已在 `hardhat.config.ts` 引入（只要用 hardhat 运行即可生效）

```bash
pnpm -s exec hardhat e2e:batch-advanced --network <network> --sample-borrower-index 2
```

## 输出说明

### Artifacts（验收证据 JSON）

部分严格 E2E 脚本会把验收证据落盘到 `scripts/e2e/artifacts/`，用于 CI/回归对比：

- 模块地址快照（Registry keys → addr）
- 关键 View 的 `getVersionInfo()`（api/schema/implementation）
- `DataPushed` 按 `dataTypeHash` 的计数统计（与 `DataPushTypes` 口径对齐）

### `e2e-localhost-full-with-views.ts` 输出示例

```
=== E2E Full Test with View Layer Verification ===

📋 View Modules:
  PositionView: 0x...
  HealthView: 0x...
  ...

=== Step 1: Borrower Deposits Collateral ===
✅ Deposit completed. Collateral: 1000.0

📊 View Layer Verification [After Deposit]:
  PositionView: collateral=1000.0, debt=0.0
  HealthView: healthFactor=0, isValid=false
  UserView: collateral=1000.0, debt=0.0
  RiskView: healthFactor=10000, riskLevel=N/A
  StatisticsView: totalUsers=0, totalCollateral=0.0, totalDebt=0.0
  DashboardView: totalCollateral=1000.0, totalDebt=0.0, healthFactor=0
  RewardView: easyEarned=0, level=0

...
```

## 验证内容

### 业务逻辑验证

- ✅ 抵押物存入和提取
- ✅ 直接借款和还款（通过 VaultCore）
- ✅ 撮合流程（资金保留 → 撮合落地 → 还款）
- ✅ LoanNFT 的铸造和状态更新
- ✅ 订单引擎的订单创建和还款
- ✅ EarlyRepaymentGuarantee（保证金 lock → 提前结算）联动路径（ERGM + GFM）

### View 层验证

- ✅ **PositionView**: 验证抵押物和债务数据是否正确缓存
- ✅ **HealthView**: 验证健康因子查询（注意：某些情况下可能需要推送更新）
- ✅ **UserView**: 验证用户视图聚合数据
- ✅ **RiskView**: 验证风险评估数据
- ✅ **StatisticsView**: 验证全局统计数据（注意：可能需要触发统计更新）
- ✅ **DashboardView**: 验证前端友好的聚合视图
- ✅ **RewardView**: 验证奖励数据查询

## 注意事项

1. **StatisticsView 的全局统计（重要）**：在严格模式下，我们把 `StatisticsView.totalCollateral/totalDebt` 作为“推送链路是否正确”的硬指标。
   - 如果在 E2E 中出现 `totalDebt/totalCollateral` 长期为 0 或与账本不一致，通常表示：Stats push 权限缺失 / push 路径未覆盖 / 逻辑被 try/catch 吞掉。

2. **缓存过期与 time travel**：`ViewConstants.CACHE_DURATION = 5 minutes`。如果脚本使用 `evm_increaseTime` 快进超过该阈值，PositionView 的缓存会变为 `isValid=false`。
   - 严格模式下应确保 Stats/PositionView 的更新路径不会依赖“缓存是否仍然有效”（否则会出现“漏计/残留”的假阴性）。

3. **View 层缓存更新**：View 层的缓存更新是"尽力而为"的，如果缓存更新失败，不会影响主业务逻辑。脚本会捕获并显示这些错误。

4. **权限设置**：脚本会自动设置所需的权限，但确保部署脚本正确配置了所有模块的 Registry 绑定。

5. **资产白名单和价格**：脚本会自动将 USDC 添加到资产白名单并设置价格。

6. **Registry 对齐检查（E2E 必须项）**：全量 E2E 结束后，必须核对 Registry 的所有模块地址与 `frontend-config/contracts-localhost.ts` 一致。
   - 目的：避免测试脚本临时写入导致 Registry 漂移（尤其是 `VAULT_BUSINESS_LOGIC`）。
   - 建议流程：先执行 `scripts/e2e/utils/registry-rebind-from-config.ts` 纠偏，再运行全量 E2E，最后运行 `scripts/e2e/utils/registry-alignment-report.ts` 输出对齐表。

## 故障排查

### 问题：View 层查询返回错误

- 检查 View 模块是否正确部署并注册到 Registry
- 检查调用者是否有正确的权限（某些 View 查询需要特定角色）

### 问题：业务操作失败

- 检查权限是否正确授予
- 检查资产是否在白名单中
- 检查价格预言机是否已设置价格
- 检查用户余额是否充足

### 问题：撮合流程失败

- 检查 EIP-712 签名是否正确
- 检查资金是否已正确保留
- 检查意向是否过期或已匹配

### 问题：`ModuleNotRegistered(...)`

- 目标链的 Registry 缺少关键模块（部署脚本过旧或网络未升级）
- 解决方式：
  - 本地链：重新部署最新 `deploylocal.ts`
  - 远程链：确认该链已升级并完成 Registry 模块注册（仅 rebind 无法补齐缺失模块）

### 问题：`function selector was not recognized`（常见于 View 预检）

- 通常是 **链不一致** 或 **模块地址错误**（SystemView route 指向了非目标合约）
- 解决方式：
  - 确认部署、rebind、E2E 全部使用同一条 RPC（例如都设置 `LOCALHOST_RPC_URL=http://127.0.0.1:18545`）
  - 本地链建议重新 `deploy:localhost` 后再跑 E2E

## 本次跑通经验（可复用）

1. **RPC 一致性是第一优先级**

- 如果 `deploy` 在 `:8545`，而 `E2E` 在 `:18545`，会出现 `ModuleNotRegistered` 或 View ABI 不匹配。
- 做法：部署、rebind、E2E 三者都显式设置 `LOCALHOST_RPC_URL`。

2. **`ModuleNotRegistered(0x3e93...)` 对应 `LOAN_NFT_VIEW`**

- 这是 `keccak256("LOAN_NFT_VIEW")`。
- 解决方案：确保该模块已部署并注册到 Registry；必要时先 `deploy:localhost`。

3. **Registry rebind 需要同一 RPC**

- `registry-rebind-from-config.ts` 读取的是 `frontend-config/contracts-localhost.ts`，但 RPC 由 `LOCALHOST_RPC_URL` 决定。
- 如果 rebind 运行在另一条链，`updated=0` 并不代表当前链已对齐。

## 扩展建议

1. **添加更多业务场景**：
   - 多资产操作
   - 清算流程
   - （已覆盖）早偿保证金流程：`EarlyRepaymentGuarantee (lock → early settle)`

2. **添加更多 View 层验证**：
   - 批量查询验证
   - 缓存失效验证
   - 数据一致性验证

3. **添加性能测试**：
   - Gas 消耗统计
   - 查询响应时间

4. **添加错误场景测试**：
   - 权限不足
   - 余额不足
   - 过期意向

# Arbitrum Sepolia Live Platform Baseline Runbook

## 网络边界

这本 runbook 只覆盖 Arbitrum Sepolia 真链 live，边界固定如下：

- 这里只写 `arbitrumSepolia` 远程网络上的 live runtime、observability、release gate 与 mock-suite 放行口径。
- 如果目标是先部署 / 重建 Arbitrum mock 资产与 mock-suite 基线，先跳到 `Arbitrum-Sepolia-Mock-Assets-Runbook.md`，不要把那部分步骤混进本文件。
- 如果目标是 BNB 真链 live，跳到 `BNB-Testnet-Live-Runbook.md`。
- 如果目标是 BNB fork，跳到 `BNB-Testnet-Fork-Runbook.md`。
- 本文件中出现的 `*-arbitrum-sepolia.ts`、`--network arbitrumSepolia` 和 `arbitrum-sepolia` package 命令，都是 Arbitrum 专用入口，不应被当成通用 live 模板。

## 文档分工

从 2026-03-30 起，文档分工固定如下：

1. [scripts/tests/live-test/README.md](../../../scripts/tests/live-test/README.md) 只保留“本次运行总结”和当前正式放行结论。
2. 本 runbook 承接 README 其余内容，作为长期维护的操作口径、证据索引、脚本矩阵与发布说明。
3. 如后续继续补测、调整 runner、更新环境变量或扩展 live gate，优先更新本 runbook，而不是重新把 README 堆回成长文档。

## 可直接发团队的放行结论文案

以下文案可直接发给团队：

Arbitrum Sepolia mock-suite 本轮正式放行已经闭环。我们先以正式口径在链上预配置了 dynamic fee，将 `LIVE_DYNAMIC_FEE_TEST` 针对 `mUSDC` 固定为 `200 bps`，对应交易哈希为 `0x88976ac93f72ba7cd9c2a53ccd86108582a621557ea7dccdb17c0bfbd6782db3`，没有使用 `ALLOW_DYNAMIC_FEE_WRITE=1` 这类测试期 break-glass 开关。随后按严格默认值重新执行 round2 acceptance，结果目录为 [scripts/tests/logs/manual-round2-acceptance-20260330183626](../../../scripts/tests/logs/manual-round2-acceptance-20260330183626)。其中 [08-release-gates.log](../../../scripts/tests/logs/manual-round2-acceptance-20260330183626/08-release-gates.log) 已确认 platform baseline、fee prepaid、fee remaining、fee dynamic 四个 release gate 全部通过；[00-dryrun.log](../../../scripts/tests/logs/manual-round2-acceptance-20260330183626/00-dryrun.log) 已确认严格口径下 `distributeDynamic.staticCall` 通过；[04-batch-liquidation-pressure.log](../../../scripts/tests/logs/manual-round2-acceptance-20260330183626/04-batch-liquidation-pressure.log) 已确认 batch liquidation / batch risk-query 压测通过；[99-sweep.log](../../../scripts/tests/logs/manual-round2-acceptance-20260330183626/99-sweep.log) 已确认 fresh borrower 统一回流完成。

本轮还补齐了此前两个 release blocker 级缺口：一是 [live-batch-liquidation-pressure-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-batch-liquidation-pressure-arbitrum-sepolia.ts) 对 batch liquidation 与 batch risk-query 的真实网络压测证据；二是 [live-guarantee-events-datapush-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-guarantee-events-datapush-arbitrum-sepolia.ts) 对 guarantee 事件与 DataPush 的全量对账证据。至此，当前 mock-suite 发布范围内的主资金链、fee gate、guarantee、单笔 liquidation、batch liquidation、view consistency、ops extension、easy staking 都已有真实网络正向证据，可以按“正式放行已闭环”对外表述。当前剩余风险仅为 Arbitrum Sepolia RPC 抖动等非功能性环境风险，不构成协议逻辑阻断项。

## 本次正式闭环证据

### 2026-03-30 严格口径闭环

1. dynamic fee 链上正式预配置脚本：[configure-dynamic-fee-arbitrum-sepolia.ts](../../../scripts/tests/live-test/configure-dynamic-fee-arbitrum-sepolia.ts)
2. dynamic fee 链上交易哈希：`0x88976ac93f72ba7cd9c2a53ccd86108582a621557ea7dccdb17c0bfbd6782db3`
3. 严格 round2 复验目录：[scripts/tests/logs/manual-round2-acceptance-20260330183626](../../../scripts/tests/logs/manual-round2-acceptance-20260330183626)
4. 严格 dry-run 证据：[00-dryrun.log](../../../scripts/tests/logs/manual-round2-acceptance-20260330183626/00-dryrun.log)
5. 严格 release-gates 证据：[08-release-gates.log](../../../scripts/tests/logs/manual-round2-acceptance-20260330183626/08-release-gates.log)
6. batch liquidation 压测证据：[04-batch-liquidation-pressure.log](../../../scripts/tests/logs/manual-round2-acceptance-20260330183626/04-batch-liquidation-pressure.log)
7. fresh borrower sweep 证据：[99-sweep.log](../../../scripts/tests/logs/manual-round2-acceptance-20260330183626/99-sweep.log)

### 本轮新增闭环点

1. [live-batch-liquidation-pressure-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-batch-liquidation-pressure-arbitrum-sepolia.ts) 已补齐 `batchIsLiquidatable`、`batchGetLiquidationRiskScores`、`LiquidationManager.batchLiquidate(...)`、`LIQUIDATION_BATCH_UPDATE` DataPush 与 payout push 数量对齐。
2. [live-guarantee-events-datapush-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-guarantee-events-datapush-arbitrum-sepolia.ts) 已补齐 early repay 与 default 两条路径上的 `GuaranteeLocked/Released/Forfeited` 事件和 DataPush 全量对账。
3. guarantee preview 对账口径已收敛为“事件 + DataPush + 余额守恒”，不再要求 block-sensitive preview 与真实执行逐最小单位相等。

## 放行判断

- `正式放行已闭环`：当前 mock-suite 发布范围内，主资金链、fee gate、guarantee、单笔 liquidation、batch liquidation、view consistency、ops extension、easy staking 已具备真实网络正向证据。
- `严格口径成立`：本轮结论建立在链上正式预配置 dynamic fee 之后的严格复验上，不依赖 `ALLOW_DYNAMIC_FEE_WRITE=1`。
- `残余风险为非功能性`：Arbitrum Sepolia RPC 仍可能出现 `HeadersTimeoutError`、`ECONNRESET` 等抖动；这属于 provider 风险，不是协议功能缺口。
- `原生币残差口径已明确`：sweep 后剩余的少量原生币差额应视为真实 gas 消耗、relayer 保底金与 dust，而不是“未执行回流”。

## 角色规则

必须保持四类角色分离：

1. borrower：每条写链分支都使用 fresh borrower，避免历史 guarantee、debt、allowance 污染。
2. lender：稳定出资方，不与 borrower 混用。
3. relayer：负责 finalizeMatch、risk push、settleOrLiquidate、recycle settlement 等执行动作。
4. viewer：只做 view/read 路径观察，不承担业务成功判定。

## Fresh Borrower 与 Sweep 纪律

Arbitrum Sepolia 的 write-mode live 测试应固定按“每轮生成一次 fresh mnemonic”的方式执行，而不是长期复用某个 borrower 私钥。

执行规则：

1. 每次新的 full-live 或 acceptance 批次，重新生成一次 `LIVE_FRESH_BORROWER_MNEMONIC`。
2. `LIVE_FRESH_BORROWER_STATE_FILE` 必须对应“本轮独立”的状态文件，不要混用旧轮次记录。
3. 优先使用带 `trap cleanup` 的 batch runner，让 fresh borrower 与 relayer sponsor top-up 在收尾阶段自动回流。
4. 如必须单跑某个写链脚本，也必须使用带 `EXIT cleanup` 的 wrapper/runner（例如 [scripts/tests/tools/run-single-live-with-sweep.sh](../../../scripts/tests/tools/run-single-live-with-sweep.sh)），不要再手工补跑 sweep。
5. 后续继续补测时，应沿用同一个带 sweep 的 runner，避免新增“彻底拿不回”的 fresh borrower / relayer 挂账。

## 判定与状态定义

### 覆盖状态

| 状态 | 含义 | 上线口径 |
| --- | --- | --- |
| `FULL` | 已有 live-test 直接触发该章节核心写入口，且至少覆盖主要 happy path | 可以作为上线前基础覆盖的一部分 |
| `PARTIAL` | 只覆盖子路径、只读观测、准备动作，或只覆盖了 happy path 的一部分 | 不能单独作为上线充分证据 |
| `INDIRECT` | 没有直接测该入口，但通过别的主流程顺带经过了部分逻辑 | 只能作为辅助证据 |
| `NONE` | 当前 live-test 未覆盖 | 若属于核心资金流，应优先补齐 |

### 执行确认

| 执行确认 | 含义 |
| --- | --- |
| `本轮通过` | 已有当前文档明确记录的最近一轮真实成功日志 |
| `历史通过` | 曾有历史成功记录，但不是本轮重新确认 |
| `未确认` | 当前只有脚本存在或理论覆盖，不应直接宣称已通过 |

## 推荐执行顺序

### 1. 先做 dry-run

```bash
set -a && source .env && set +a && pnpm -s run test:live:dryrun:arbitrum-sepolia
```

### 2. 先跑平台 runtime 基线

```bash
set -a && source .env && set +a && pnpm -s run test:live:platform-runtime-baseline:arbitrum-sepolia
```

### 3. 再补平台 observability 证据

```bash
set -a && source .env && set +a && pnpm -s run test:live:platform-observability-evidence:arbitrum-sepolia
```

### 4. 上线前跑统一 release gate

```bash
set -a && source .env && set +a && pnpm -s run test:live:release-gates:arbitrum-sepolia
```

release-gates 当前结构固定为：

1. platform runtime baseline
2. platform observability evidence
3. fee prepaid gate
4. fee remaining gate
5. fee dynamic gate

如需按域单独跑总入口，当前统一命令面为：

```bash
pnpm -s run test:live:fee-baseline:arbitrum-sepolia
pnpm -s run test:live:reward-baseline:arbitrum-sepolia
pnpm -s run test:live:guarantee-baseline:arbitrum-sepolia
```

如需执行“多笔交叉 live”而且确保 fresh borrower 原生 ETH 在收尾阶段自动回流，使用 [scripts/tests/tools/run-cross-live-matrix-with-sweep.sh](../../../scripts/tests/tools/run-cross-live-matrix-with-sweep.sh)。这个 runner 已固定在 `EXIT` 时调用 [sweep-fresh-borrowers.ts](../../../scripts/tests/live-test/sweep-fresh-borrowers.ts)，不会把 sweep 留给人工补跑。

## 标准环境

最常见的是 Arbitrum Sepolia mock-suite live：

```bash
set -a && source .env && set +a && \
export REGISTRY_ADDRESS=0x4A9c29B1f1C591f7A24A49F68aA5ef1e9a39FABC \
DEPLOY_OUTPUT_FILE=scripts/deployments/arbitrum-sepolia.mock-suite.json \
LIVE_USE_MOCK_ASSET_PACK=1 \
LIVE_PRICE_MODE=bootstrap \
MOCK_ASSET_PACK_OUTPUT=deployments/mock-assets.arbitrum-sepolia.json \
ASSETS_FILE=deployments/assets.arbitrum-sepolia.mock.json \
SETTLEMENT_TOKEN_ADDRESS=0xC4e3316C9091224D653a685E19BdaBF2bABd2db7 \
SETTLEMENT_TOKEN_DECIMALS=6
```

如需直接跑 release gates，通常补：

```bash
LIVE_FRESH_BORROWER_NATIVE_ETH=0.0003 \
ALLOW_LIQUIDATION_MANAGER_PAUSE=1
```

仅当你明确接受 break-glass 验证时，才显式追加：

```bash
ALLOW_DYNAMIC_FEE_WRITE=1
```

但当前正式放行证据不再依赖这一开关。

## Fresh Borrower 自动补资与统一 Sweep

当前 Arbitrum Sepolia live 脚本已经默认启用以下机制，不再要求每次手工提供 `LIVE_FRESH_BORROWER_STATE_FILE`：

1. fresh borrower 会优先使用本地可恢复钱包池，而不是一次性随机钱包。
2. 如果没有显式配置 `LIVE_FRESH_BORROWER_MNEMONIC` / `LIVE_FRESH_BORROWER_PHRASE`，脚本会在 `scripts/tests/logs/fresh-borrowers/arbitrum-sepolia/` 下自动创建本地 recovery seed 与 state 文件。
3. fresh borrower 所需原生 ETH 会优先从 relayer / lender / viewer / updater 中可用 sponsor 自动补齐。
4. 无论脚本成功还是失败，只要进程正常结束或走到失败退出路径，都会自动执行 fresh borrower sweep，把残余原生 ETH 与 mock ERC20 余额尽量回流到记录的 refundAddress / sponsor。

推荐保留的环境变量：

```bash
LIVE_FRESH_BORROWER_NATIVE_ETH=0.0003
LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH=0.00005
LIVE_RELAYER_NATIVE_TARGET_ETH=0.0003
LIVE_FRESH_BORROWER_SWEEP_ERC20=1
```

统一口径：单轮只保留一次 sweep，且只在退出清理阶段触发（`EXIT cleanup`）。

不要在流程中额外插入手工 sweep 命令，以免出现重复 sweep、证据混淆和状态文件重复消费。

如果当前 relayer 原生 ETH 明显不足，可先补 relayer 再跑 live：

```bash
set -a && source .env && set +a && \
DEBUG_NATIVE_MIN_ETH=0.005 \
DEBUG_NATIVE_SPONSOR_RESERVE_ETH=0.0002 \
pnpm -s exec hardhat run scripts/debug/fund-live-native.ts --network arbitrumSepolia
```

## 低成本预演策略

如果目标是先尽量不花测试币，再决定是否进入真实 live gate，推荐固定走 3 层：

1. localhost / fork 写路径演练：先验证脚本逻辑本身。
2. 真实网络零写入预演：执行 [live-release-dryrun-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-release-dryrun-arbitrum-sepolia.ts)。
3. 真实网络最小 write-mode：仅在 dry-run 无 blocker 后，再跑 [live-release-gates-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-release-gates-arbitrum-sepolia.ts)。

## Deploy Closure 发布清单摘要

当前 deploy closure 审计基线来自 [audit-deploy-closure-arbitrum-sepolia.ts](../../../scripts/tools/audit-deploy-closure-arbitrum-sepolia.ts) 对 mock-suite 的链上结果。当前主要结论不是“地址漂移仍有问题”，而是“地址闭环已完成，剩余工作主要是 live 证据分层”。

### P0 已闭环

1. 资金主路径模块：`VaultCore`、`VaultBusinessLogic`、`VaultLendingEngine`、`CollateralManager`、`SettlementManager`、`LenderPoolVault`、`GuaranteeFundManager`、`EarlyRepaymentGuaranteeManager`、`ORDER_ENGINE`。
2. fee / liquidation / blocks-only 主路径模块：`FeeRouter`、`FeeRouterView`、`LiquidationManager`、`LiquidationPayoutManager`、`LiquidationRiskView`、`LiquidatorView`、`BlocksOnlyCoordinator`、`BlocksOnlyView`。
3. 读面与 facade 主模块：`RegistryView`、`SystemView`、`PositionView`、`HealthView`、`StatisticsView`、`LoanFlowView`、`DashboardView`、`UserView`、`CacheOptimizedView`、`AccessControlView`、`LendingEngineView`、`EventHistoryManager`、`ModuleHealthView`、`BatchView`、`ValuationOracleView`。
4. reward / governance 主模块：`RewardManager`、`RewardManagerCore`、`RewardAccrualManager`、`RewardConfig`、`EarnConfig`、`RewardView`、`EasyToken`、`EasyEmissionConfig`、`EasyEmissionController`、`EasyConsumption`、`EasyRecycleDistributor`、`FeatureRegistry`。
5. 本轮补齐的扩展模块：`RegistryDynamicModuleKey`、`CacheMaintenanceManager`、`DegradationCore`、`DegradationStorage`、`DegradationMonitor`、`AICreditsVault`、`EasyStaking`。

### P1 仅间接覆盖

1. `Registry`：当前主要通过 registry route 与 preflight 断言间接覆盖。
2. `VaultRouter`：当前主要通过 deposit、withdraw、repay、platform baseline 间接覆盖。
3. `GovernanceGuardian`：当前 Registry 绑定的是 EOA-style 地址，已由 ops-extension live 脚本验证绑定存在且无 code。

## 当前关键 live-test 脚本

| 脚本 | 执行确认 | 目标 | 当前应重点关注的断言 |
| --- | --- | --- | --- |
| [live-release-dryrun-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-release-dryrun-arbitrum-sepolia.ts) | `本轮通过` | 零写入预演 | 资产、权限、route、staticCall readiness |
| [live-release-gates-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-release-gates-arbitrum-sepolia.ts) | `本轮通过` | 统一发布入口 | 顺序执行 platform runtime、platform observability 与 3 个 fee gate，并产生日志与汇总 |
| [live-platform-runtime-baseline-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-platform-runtime-baseline-arbitrum-sepolia.ts) | `本轮通过` | 平台 runtime 基线 | normal borrow/repay + Easy 闭环 + guarantee default -> liquidation 的 runtime truth |
| [live-platform-observability-evidence-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-platform-observability-evidence-arbitrum-sepolia.ts) | `本轮通过` | 平台 observability 证据 | 对 runtime 主路径补齐 DataPushed / mirror / downstream evidence |
| [live-liquidation-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-liquidation-arbitrum-sepolia.ts) | `本轮通过` | legacy / 通用订单清算 | overdue、刷价、settleOrLiquidate、payout、风险前后态 |
| [live-batch-liquidation-pressure-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-batch-liquidation-pressure-arbitrum-sepolia.ts) | `本轮通过` | batch liquidation / batch risk-query 压测 | batch query、batchLiquidate、batch update、payout push 数量对齐 |
| [live-liquidation-fallback-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-liquidation-fallback-arbitrum-sepolia.ts) | `本轮通过` | fallback 清算 | fallback activation、payout、debt delta |
| [live-blocks-only-liquidation.ts](../../../scripts/tests/live-test/networks/arbitrum-sepolia/live-blocks-only-liquidation.ts) | `本轮通过` | blocks-only 收尾 | repayBlocks、trade-close、maturity delivery、runtime/DataPush |
| [live-fee-baseline-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-fee-baseline-arbitrum-sepolia.ts) | `新增入口` | fee 总入口 | runtime accounting + observability fee gates |
| [live-reward-baseline-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-reward-baseline-arbitrum-sepolia.ts) | `新增入口` | reward 总入口 | runtime reward/view path + observability stress/recycle evidence |
| [live-guarantee-baseline-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-guarantee-baseline-arbitrum-sepolia.ts) | `新增入口` | guarantee 总入口 | runtime guarantee flow + observability events/DataPush evidence |
| [live-guarantee-flow-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-guarantee-flow-arbitrum-sepolia.ts) | `本轮通过` | guarantee happy path | lock、early settle、FeeRouterView / LoanFlowView 联测 |
| [live-guarantee-events-datapush-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-guarantee-events-datapush-arbitrum-sepolia.ts) | `本轮通过` | guarantee 事件 / DataPush 全量对账 | early repay 与 default 两条路径的事件和 DataPush 对账 |
| [live-fee-accounting-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-fee-accounting-arbitrum-sepolia.ts) | `本轮通过` | 常规分账数学核对 | custody 守恒与 FeeRouterView 同步 |
| [live-fee-prepaid-gate-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-fee-prepaid-gate-arbitrum-sepolia.ts) | `本轮通过` | prepaid fee gate | distributePrepaid、余额回零、用户镜像 |
| [live-fee-remaining-gate-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-fee-remaining-gate-arbitrum-sepolia.ts) | `本轮通过` | remaining refund gate | 平台费、生态费、caller refund、镜像 |
| [live-fee-dynamic-gate-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-fee-dynamic-gate-arbitrum-sepolia.ts) | `本轮通过` | dynamic fee gate | setDynamicFee、distributeDynamic、镜像与守恒 |
| [live-view-consistency-gate-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-view-consistency-gate-arbitrum-sepolia.ts) | `本轮通过` | 统一 view 发布门禁 | PositionView、HealthView、StatisticsView、LoanFlowView、FeeRouterView、SystemRiskView |
| [live-ops-extension-modules-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-ops-extension-modules-arbitrum-sepolia.ts) | `本轮通过` | ops-extension 证据 | RegistryDynamicModuleKey、Degradation*、AICreditsVault、GovernanceGuardian |
| [live-easy-staking-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-easy-staking-arbitrum-sepolia.ts) | `本轮通过` | EasyStaking 证据 | stake、non-transferable revert、unstake |

## 多笔交叉 live 入口

针对你关心的单笔 liquidation、batch liquidation、view consistency、ops extension、easy staking 与 reward 交叉回放，当前统一入口为 [scripts/tests/tools/run-cross-live-matrix-with-sweep.sh](../../../scripts/tests/tools/run-cross-live-matrix-with-sweep.sh)。

该 runner 固定顺序执行：

1. `live-view-consistency-gate-arbitrum-sepolia.ts`
2. `live-platform-runtime-baseline-arbitrum-sepolia.ts`
3. `live-view-reward-loanflow-boundary-arbitrum-sepolia.ts`
4. `live-reward-config-governance-arbitrum-sepolia.ts`
5. `live-ops-extension-modules-arbitrum-sepolia.ts`
6. `live-easy-staking-arbitrum-sepolia.ts`
7. `live-batch-liquidation-pressure-arbitrum-sepolia.ts`
8. `seed-liquidatable-order-arbitrum-sepolia.ts`
9. `live-liquidation-arbitrum-sepolia.ts`
10. `sweep-fresh-borrowers.ts` 作为 `trap cleanup` 强制收尾

因此，这条入口满足两件事：

1. 这些模块不再只是各自单跑，而是放进同一轮 fresh borrower / relayer 预算下做交叉 live 回放。
2. 无论中途成功还是失败，都会在退出时执行原生 ETH 回流。

## Reward 是否已有 live 测试

有，但要区分“已有 live”与“是否已经多笔交叉”。

当前 reward live 覆盖包括：

1. [live-platform-runtime-baseline-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-platform-runtime-baseline-arbitrum-sepolia.ts)：覆盖 normal repay 后 `EASY_MINTED`、`EASY_SPENT`、`EASY_RECYCLED_SPLIT`，以及 guarantee default -> liquidation -> reward penalty/burn 正向链路的 runtime 主验收。
2. [live-platform-observability-evidence-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-platform-observability-evidence-arbitrum-sepolia.ts)：对上述 runtime 主路径补齐 DataPushed / mirror / 事件证据。
3. [live-view-reward-loanflow-boundary-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-view-reward-loanflow-boundary-arbitrum-sepolia.ts)：覆盖 RewardView 读面、LoanFlowView 边界与 borrow/repay 后的 reward 读面推进。
4. [live-reward-config-governance-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-reward-config-governance-arbitrum-sepolia.ts)：覆盖 reward 治理 caller gate 与幂等 no-op 写回。
5. [live-easy-staking-arbitrum-sepolia.ts](../../../scripts/tests/live-test/live-easy-staking-arbitrum-sepolia.ts)：覆盖 repay 后拿到 EASY，再走 stake / unstake 闭环。

但在你这次要求之前，reward 侧还没有一个把上述路径和 single liquidation、batch liquidation、view consistency、ops extension 放进同一轮 runner 的多笔交叉入口。现在这部分已经由 [scripts/tests/tools/run-cross-live-matrix-with-sweep.sh](../../../scripts/tests/tools/run-cross-live-matrix-with-sweep.sh) 补上。

## View 联测口径

如果主资金链测试通过，以下 View 应同步作为发布门禁的一部分：

1. Deposit 后：`PositionView`、`HealthView`、`ViewCache`
2. Finalize Match 后：`PositionView`、`LoanFlowView`、`RewardView`、`FeeRouterView`
3. Repay / Settle 后：`PositionView`、`HealthView`、`LoanFlowView`、`FeeRouterView`、`RewardView`
4. Guarantee 后：`FeeRouterView`、`RewardView`
5. Liquidation 后：`LiquidatorView`、`PositionView`、`FeeRouterView`、`RewardView`、`LiquidationRiskView`

如果主交易成功、事件正确、余额和 debt 变化正确，但某个 cold view 没立即 valid，应优先视为读面延迟，而不是直接判定主资金链失败。

## 当前仍需保守看待的风险

1. 手工单跑脚本或覆盖环境变量时，仍可能退回宽松语义，因此发布证据应优先使用 batch runner 输出。
2. 如果未来有人显式设置 `ALLOW_DYNAMIC_FEE_WRITE=1`，应把该轮结果降级理解为 break-glass 验证，而不是正式放行证据。
3. blocks-only、keeper 刷价、更复杂 collateral 组合和更细 negative 权限矩阵仍未覆盖到主放行闭环里。
4. 部署脚本仍存在软失败继续执行语义，因此“部署脚本跑完”不等于“所有部署目标都已成功上线”；发布判断必须同时核对 deploy output、Registry 绑定和 live 证据。
5. 如果 relayer 自身原生 ETH 已低于 fresh borrower sponsor reserve，脚本虽然会自动做 native top-up 与回流，但仍可能在首笔 sponsor 补资前失败；遇到这种情况先执行上面的 `fund-live-native.ts` 补资命令，再重跑域入口或 release gate。

## 推荐的域入口重跑顺序

当目标是先验证 fee / reward / guarantee 三个总入口，并且避免 fresh borrower 原生币残留持续吞掉 sponsor 预算，推荐顺序固定为：

```bash
set -a && source .env && set +a

DEBUG_NATIVE_MIN_ETH=0.005 DEBUG_NATIVE_SPONSOR_RESERVE_ETH=0.0002 \
pnpm -s exec hardhat run scripts/debug/fund-live-native.ts --network arbitrumSepolia

pnpm -s run test:live:fee-baseline:arbitrum-sepolia
pnpm -s run test:live:reward-baseline:arbitrum-sepolia
pnpm -s run test:live:guarantee-baseline:arbitrum-sepolia
```

这一组命令的测试内容分别是：

1. fee baseline：runtime accounting + observability fee gates。
2. reward baseline：runtime reward / view path + observability multi-borrower stress / recycle evidence。
3. guarantee baseline：runtime guarantee flow + observability guarantee events / DataPush evidence。
4. sweep 由 runner 的 `EXIT cleanup` 自动执行并落盘，不再要求手工补跑。

如果要记录单轮执行产物，建议额外设置：

```bash
LIVE_FRESH_BORROWER_STATE_FILE="$PWD/scripts/tests/logs/fresh-borrowers/arbitrum-sepolia/manual-state.json"
```

即使不设置，脚本也会自动使用默认 recovery/state 文件；这里显式设置的目的只是让单轮证据更容易归档。

## 后续增强 backlog

| 优先级 | backlog | 原因 |
| --- | --- | --- |
| `P1` | repay 分类矩阵 | normal repay 与 guarantee early repay 已覆盖，但 early / on-time / late 三类时间窗口尚未拆开 |
| `P1` | cancelReserve / withdraw negative 边界 | 重复调用、越权、超额提取等负向仍未锁死 |
| `P1` | Reward 治理与读面之外的专项负例 | 还缺更细 caller gate、no-op、break-glass 边界 |
| `P2` | view push 失败重试 / stale cache 恢复 / negative smoke | 稳态增强项，覆盖 `ViewCache`、`SystemRiskView`、`ModuleHealthView` |

## 失败时怎么看

排查顺序建议固定如下：

1. 先确认 dry-run 是否已通过，再决定是否进入 write-mode。
2. 检查 relayer 是否缺 `ActionKeys.ACTION_LIQUIDATE`、`ActionKeys.ACTION_VIEW_PUSH`、`ActionKeys.ACTION_ADMIN` 等角色。
3. 检查 fresh borrower 与 relayer 是否拥有足够原生 gas，且本轮 state file 是否正确。
4. 检查 reward、guarantee、liquidation 关键事件是否真实落链。
5. 最后才排查二级 view 镜像是否失真。

当前环境下已经被日志确认成立的关键前置包括：

1. relayer 具备 `ActionKeys.ACTION_VIEW_PRICE_DATA`、`ActionKeys.ACTION_LIQUIDATE`、`ActionKeys.ACTION_DEPOSIT`、`ActionKeys.ACTION_VIEW_SYSTEM_DATA`、`ActionKeys.ACTION_VIEW_PUSH`
2. `SettlementManager` 的 repay 侧已不再依赖额外的 `ActionKeys.ACTION_REPAY` / `ActionKeys.ACTION_VIEW_SYSTEM_DATA` 运行时补授权；keeper 触发的 `settleOrLiquidate` 路径仍需 `ActionKeys.ACTION_LIQUIDATE`，其余只读角色按调用链实际需求补齐
3. dynamic fee 默认不再依赖 runner 临时写入
4. `RWAGOLD` 当前有可读链上最终价格，preflight 未阻断

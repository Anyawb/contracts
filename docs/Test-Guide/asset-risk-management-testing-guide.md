# 资产设计与风险管理改动测试指南

## 1. 目标与范围

本文件不是重新定义测试要求，而是把 [pre-launch-comprehensive-testing-requirements.md](pre-launch-comprehensive-testing-requirements.md) 第 14 章里和资产设计、风险管理、strict valuation、shortfall 相关的要求，映射到当前仓库已经存在的可执行测试入口。

当前这份专项指南只覆盖以下变更主题：

1. Tier-1 自动决策资产与 Tier-2 参考价资产的边界。
2. 自动借贷、自动清算、自动结算必须严格依赖 `PriceOracle.getPrice(...)`。
3. no-price close path 仍然必须按真实 debt ledger 收口，不能被 fallback valuation 污染。
4. liquidation 后 residual debt 必须进入显式 shortfall ledger，不能被隐式吞没。
5. live 与 fork 上的价格刷新、keeper 路由、Liquidation fallback、Registry 路由必须可观测且可审计。

当前明确不纳入本文件放行范围的内容：

1. blocks-only 专项用例。
2. rewards、fee、ops extension 的独立产品验收。
3. 与当前 strict valuation / shortfall 改动无直接关系的通用 view smoke。

这点必须写清楚，因为当前 full release gates 仍然包含 blocks-only。现阶段如果只想确认这轮资产设计与风险管理改动，不应把 full release gates 的全部结果当成唯一结论。

若文中需要引用 blocks-only 状态术语或 gate 9 结果，词典与状态映射以 [pre-launch-comprehensive-testing-requirements.md](pre-launch-comprehensive-testing-requirements.md) 第 5 章 Gate 9 的“词典约束（blocks-only）”为准（交易收尾 / 到期收尾 / 到期交付收尾三分法）。

## 2. 使用方式

先把本文件当成“落地矩阵”，再把 [pre-launch-comprehensive-testing-requirements.md](pre-launch-comprehensive-testing-requirements.md) 当成“上线阻断标准”。

推荐顺序如下：

1. 先跑合约层锚点，确认 strict / best-effort 拆分和 shortfall 账本没有回退。
2. 再跑 localhost E2E，确认视图、risk、liquidation、fallback observability 没有漂移。
3. 再跑 fork，确认真实 deploy output、角色、价格刷新和 live wrapper 在 fork 上仍成立。
4. 最后跑 live preflight 和本范围内的 live liquidation 子集。

建议命令：

```bash
pnpm -s run compile
pnpm -s run typecheck
pnpm -s run e2e:typecheck

pnpm -s exec hardhat test test/core/PriceOracle.new.test.ts
pnpm -s exec hardhat test test/Vault/VaultLendingEngine.refactor.test.ts
pnpm -s exec hardhat test test/Vault/liquidation/SettlementManager.settleOrLiquidate.test.ts
pnpm -s exec hardhat test test/Vault/liquidation/SettlementManager.repayAndSettle.test.ts
pnpm -s exec hardhat test test/FundsFlow.liquidation.authority-path.test.ts
```

## 3. 合约层锚点

虽然本轮重点是 E2E、fork、live，但下面这些测试必须先绿，因为它们直接定义了风险边界的合约级事实。

| 变更主题 | 必跑文件 | 当前锚点 |
| --- | --- | --- |
| stale price fail-closed | `test/core/PriceOracle.new.test.ts` | 验证 `PriceOracle.getPrice` 在 stale 情况下直接报 `PriceOracle__StalePrice` |
| strict / best-effort debt valuation 拆分 | `test/Vault/VaultLendingEngine.refactor.test.ts` | 同时覆盖 `calculateDebtValueStrict` / `calculateDebtValueBestEffort` 与 total debt strict / best-effort 读口 |
| shortfall 显式账本与 strict debt valuation | `test/Vault/liquidation/SettlementManager.settleOrLiquidate.test.ts` | 覆盖显式 shortfall ledger、`hasActiveShortfall`、strict debt valuation unavailable 直接 revert |
| no-price close path 基线 | `test/Vault/liquidation/SettlementManager.repayAndSettle.test.ts` | 覆盖 `repayAndSettle` 的 SSOT、订单终态阻断、pull mismatch 防 stranded funds |
| liquidation 主路径 / fallback 路径语义一致 | `test/FundsFlow.liquidation.authority-path.test.ts` | 覆盖 `LiquidationManagerFallbackActivated` 与主路径 / fallback 路径 `LiquidatorView` payload 对齐 |

这些文件先不过，再跑 E2E、fork、live 的价值不大，因为上层失败很可能只是合约边界已经回退。

## 4. Requirement 到当前入口的映射

下面只列和当前变更最相关的 requirement。更完整的阻断标准仍以 [pre-launch-comprehensive-testing-requirements.md](pre-launch-comprehensive-testing-requirements.md) 为准。

| Requirement | 当前主要入口 | 当前状态 |
| --- | --- | --- |
| `RWA-ORA-STALE-02` | `scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts`、`scripts/tests/live-test/networks/bnb-testnet/live-preflight.ts` | 已有可执行入口 |
| `RWA-ORA-TIER-02` | `test/Vault/liquidation/SettlementManager.settleOrLiquidate.test.ts`、`scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts`、`scripts/tests/live-test/networks/bnb-testnet/live-liquidation-fallback.ts` | 已有合约层和 fork/live 入口 |
| `RWA-ORA-TIER-03` | `test/FundsFlow.liquidation.authority-path.test.ts`、`scripts/tests/live-test/networks/bnb-testnet/live-liquidation-registry-preflight.ts`、`scripts/tests/live-test/networks/bnb-testnet/live-lending-engine-view.ts` | 已有架构边界检查 |
| `RWA-ORA-TIER-05` | `test/Vault/VaultLendingEngine.refactor.test.ts`、`test/Vault/liquidation/SettlementManager.settleOrLiquidate.test.ts` | 已有合约层检查，E2E/live 还需补强专门断言 |
| `RWA-SHORTFALL-01` | `test/Vault/liquidation/SettlementManager.settleOrLiquidate.test.ts` | 合约层已覆盖，E2E/live 仍缺 dedicated 脚本 |
| `RWA-SHORTFALL-02` | `test/Vault/liquidation/SettlementManager.settleOrLiquidate.test.ts` | 合约层已覆盖，E2E/live 仍缺 fallback 吞账专项 |
| `RWA-SHORTFALL-03` | 现有 live 里仅有 guarantee / penalty / recovery 边界片段，没有 shortfall ledger 全链路专项 | 需要补新脚本 |
| `RWA-SHORTFALL-04` | `test/Vault/liquidation/SettlementManager.settleOrLiquidate.test.ts` | 合约层已覆盖，live 还未把 order status / ledger / DataPush 同交易对齐做成专项 |
| `RWA-REC-01` / `RWA-REC-03` | 当前有文档要求，但没有单独的 RWA reconciliation 脚本矩阵 | 需要补新脚本和 runbook |
| `RWA-SETTLE-01` / `RWA-SETTLE-03` | 当前有 close-path 和 liquidation path 测试，但缺“链下失败回执”专项 | 需要补新脚本和模拟器 |

## 5. Localhost E2E 子集

### 5.1 当前应优先跑的脚本

| 入口 | 作用 | 对应 requirement |
| --- | --- | --- |
| `scripts/e2e/e2e-localhost-batch-advanced-10-users.ts` | 当前 localhost 最接近“资产 + 风控 + strict 视图 + liquidation”综合验收的脚本。包含 strict view 校验、stale price negative、keeper liquidation SSOT、risk / health / DataPush 一致性。 | `RWA-ORA-STALE-01`、`RWA-ORA-STALE-03`、`RWA-ORA-TIER-03` |
| `scripts/e2e/e2e-localhost-price-liquidation-stress.ts` | 用价格冲击、多借款人、多轮波动验证 liquidation risk 与 observability，在风险边界修改后很适合作为回归压力入口。 | stale price、risk shock、liquidation threshold 漂移 |
| `scripts/e2e/e2e-localhost-liquidation-path-parity.ts` | 复用 live liquidation fallback case，在 localhost 上验证主路径和 fallback 路径保持一致语义。 | `RWA-ORA-TIER-02`、`RWA-ORA-TIER-03` |
| `scripts/e2e/e2e-localhost-liquidation-reward-penalty.ts` | 验证 liquidation 同交易里的 `LIQUIDATION_*` DataPushed、reward penalty ledger 推送与 penalty debt delta。 | liquidation observability、post-liquidation accounting |
| `scripts/tests/smoke-productionlike-local.ts` | 当前本地“接近上线配置”的 smoke 入口，用于确认 registry wiring、价格路由、角色和主资金链没有被这轮改动打断。 | prodlike baseline |

推荐命令：

```bash
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
pnpm -s run e2e:price-liquidation-stress
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-liquidation-path-parity.ts --network localhost
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-liquidation-reward-penalty.ts --network localhost
pnpm -s run test:smoke:prodlike:localhost
```

### 5.2 当前 E2E 需要特别注意的事实

1. `scripts/e2e/tools/run-all-e2e.ts` 默认不会执行 fork-only 脚本。只有显式加 `--include-fork` 或设置 `E2E_INCLUDE_FORK=1` 才会把 `e2e-fork-*` 纳入。
2. `e2e-localhost-batch-advanced-10-users.ts` 已经内置 stale price negative 和 keeper liquidation SSOT，因此它是这轮最值得优先看的 localhost 总控脚本。
3. 当前 localhost E2E 还没有 dedicated shortfall ledger 脚本。也就是说，显式 shortfall 现在主要还是靠合约层测试证明，没有在 E2E 层单独固化成回归入口。

## 6. Fork 子集

### 6.1 Arbitrum stale price / keeper 入口

`scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts` 是当前最直接对应 `RWA-ORA-STALE-02` 和 `RWA-ORA-TIER-02` 的 fork E2E。

它当前负责验证：

1. fork 上 `PriceOracle.getPrice(...)` 真正因为 stale 数据而 revert。
2. keeper / updater 刷价后，价格读口恢复可读。
3. 价格刷新和 reward 相关读口不会在 fork 场景下静默漂移。

推荐命令：

```bash
pnpm -s exec hardhat run scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts --network localhost
```

前提是本地 `localhost` 实际跑的是 Arbitrum 或 Arbitrum Sepolia fork，而不是普通本地链。

### 6.2 BNB live-on-fork 入口

`scripts/tests/fork-test/networks/bnb-testnet/live-fork.autonode.ts` 不是另一套测试逻辑，而是把 BNB live wrapper 跑在本地 Hardhat fork 上。当前可选 case 有：

1. `preflight`
2. `warmup`
3. `platform-baseline`
4. `guarantee-baseline`
5. `release-gates`
6. `settlement-role-bridge`

如果只看当前资产设计与风险管理范围，推荐先跑下面这个子集，而不是直接跑 full release-gates：

```bash
BNB_FORK_AUTONODE_CASES=preflight,platform-baseline,guarantee-baseline,settlement-role-bridge \
ts-node --project ./tsconfig.scripts.json scripts/tests/fork-test/networks/bnb-testnet/live-fork.autonode.ts
```

原因有两个：

1. fork 的 `release-gates` 会把 full live release gates 一并带上，其中仍然包含 blocks-only。
2. 当前用户明确把 blocks-only 排除在这轮工作范围之外，所以不能把 fork release-gates 的 gate 9 失败直接当成这轮资产 / 风控改动失败。

只有在 blocks-only 一并纳入后，才建议重新把下面的总命令作为完整结论：

```bash
pnpm -s run test:live:release-gates:fork:bnb-testnet
```

### 6.3 fork 判读规则

fork 结果必须按下面规则解释：

1. `missing trie node`、`headers timeout`、`unsupported RPC` 这类错误先归类为基础设施问题。
2. 只有在 deploy output、Registry、角色和价格读口都已对齐后，业务断言失败才算协议问题。
3. fork 失败不能单独证明 live 会失败，但它可以提前暴露“真实网络配置 + 当前脚本”的不兼容点。

## 7. Live 子集

### 7.1 当前范围内优先跑的 live 入口

| 入口 | 作用 | 是否建议当前范围使用 |
| --- | --- | --- |
| `scripts/tests/live-test/networks/bnb-testnet/live-asset-precheck.ts` | 确认 live 资产配置和 mock asset pack / deploy output 没漂移 | 是 |
| `scripts/tests/live-test/networks/bnb-testnet/live-preflight.ts` | live 读路径最低健康度检查，可通过 `LIVE_PREFLIGHT_STRICT_ORACLE=1` 把 oracle 问题直接升级为失败 | 是 |
| `scripts/tests/live-test/networks/bnb-testnet/live-platform-baseline.ts` | 平台主路径基线，含 domain preflight | 是 |
| `scripts/tests/live-test/networks/bnb-testnet/live-lending-engine-view.ts` | strict debt / view 路由兼容性检查 | 是 |
| `scripts/tests/live-test/networks/bnb-testnet/live-liquidation.ts` | 当前 live liquidation 主路径基线，覆盖 risk readiness、价格刷新、debt delta、DataPush、fallback observability | 是 |
| `scripts/tests/live-test/networks/bnb-testnet/live-liquidation-fallback.ts` | 验证 `LiquidationManagerFallbackActivated`、fallback payout 和 fallback 路径 observability | 是 |
| `scripts/tests/live-test/networks/bnb-testnet/live-liquidation-registry-preflight.ts` | 验证 SystemView route、LiquidationRiskView registry、LiquidationView / RiskView 注册边界 | 是 |
| `scripts/tests/live-test/networks/bnb-testnet/live-view-consistency-gate.ts` | 验证 live 视图一致性、system risk 读口和缓存成熟度 | 是 |
| `scripts/tests/live-test/networks/bnb-testnet/live-release-gates.ts` | full layer-A 总门，包含 blocks-only gate 9 | 暂不作为本轮唯一结论 |
| `scripts/tests/live-test/networks/bnb-testnet/live-release-gates-layer-b.ts` | 架构专项门，含 liquidation registry preflight，也含 blocks-only architecture | 暂不作为本轮唯一结论 |

推荐命令：

```bash
pnpm -s run test:live:preflight:bnb-testnet
pnpm -s run test:live:platform-baseline:bnb-testnet
pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-lending-engine-view.ts --network bnbTestnet
pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-liquidation.ts --network bnbTestnet
pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-liquidation-fallback.ts --network bnbTestnet
pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-liquidation-registry-preflight.ts --network bnbTestnet
pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/live-view-consistency-gate.ts --network bnbTestnet
```

### 7.2 当前 live 已经能证明什么

当前 live liquidation 相关脚本已经能证明：

1. 真实网络上 `LiquidationRiskView`、`LiquidationView`、`SettlementManager`、`LiquidationManager` 的路由没有明显漂移。
2. liquidation 前后的 debt delta、reducible debt、DataPush 和 payout 事件能对上。
3. fallback 路径被触发时，会留下显式 `LiquidationManagerFallbackActivated` 事件和 fallback payout 证据。
4. live preflight 可以把 oracle 读口不健康、reward cache 冷、view cache 冷显式暴露出来。

### 7.3 当前 live 还不能证明什么

当前 live 子集仍然没有 dedicated 覆盖以下内容：

1. 显式 shortfall ledger 在 live 上的打开、查询、收口和历史保留。
2. Tier-2 参考价资产被错误纳入自动授信 / 自动清算时的 live fail-closed。
3. `repayAndSettle` 在 oracle failure / fallback state 下仍能按 debt ledger 收口的 live 回归。
4. 链上状态成功但链下 settlement 回执失败时的 live strict 阻断。

## 8. 当前缺口与下一步补脚本清单

这部分不是“可选优化”，而是当前 strict valuation / shortfall 设计要继续补齐的专项入口。

### 8.1 必补的 localhost / fork / live 脚本

| 缺口 | 建议新增入口 | 目的 |
| --- | --- | --- |
| shortfall ledger 的 E2E 回归缺失 | `scripts/e2e/e2e-localhost-shortfall-ledger.ts` | 把 `RWA-SHORTFALL-01/02/04` 从合约层延伸到 localhost 交易级断言 |
| shortfall live 回归缺失 | `scripts/tests/live-test/networks/bnb-testnet/live-shortfall-ledger.ts` | 在真实网络上验证 `getShortfallLedger`、`hasActiveShortfall`、status / DataPush 同交易对齐 |
| no-price close path live 缺失 | `scripts/tests/live-test/networks/bnb-testnet/live-no-price-close-path.ts` | 覆盖 `repayAndSettle` 在 strict price unavailable 时仍按 debt ledger 收口 |
| Tier-2 参考价资产误入自动决策缺失 | `scripts/e2e/e2e-localhost-tier-boundary.ts` | 明确把 Tier-2 资产错误放入 borrow / liquidate / settle 路径时 fail closed |
| reconciliation / settlement failure 缺失 | `scripts/tests/live-test/networks/bnb-testnet/live-rwa-reconciliation.ts` | 把 `RWA-REC-*` 和 `RWA-SETTLE-*` 从文档要求变成可执行回归 |

### 8.2 在这些脚本补出来之前，当前结论应该如何写

当前可以写的结论应当是：

1. strict valuation 边界和 liquidation 主路径 / fallback 路径已有合约层、localhost、fork、live 的基础回归。
2. explicit shortfall ledger 目前主要由合约层保证，E2E/live 还没有完整收口脚本。
3. 因为本轮显式排除了 blocks-only，所以 full release-gates 只能作为补充信息，不能作为本轮唯一放行标准。

## 9. 本轮建议保留的放行证据

至少保留下列日志或产物目录：

1. localhost E2E 日志目录，尤其是 `e2e-localhost-batch-advanced-10-users` 和 `e2e-localhost-price-liquidation-stress`。
2. fork autonode 日志目录，包含 fork node 日志和 case 日志。
3. live preflight、live liquidation、live liquidation fallback、live liquidation registry preflight 的运行日志。
4. 若本轮仍附带跑了 full release-gates，需要单独注明其中 blocks-only 不计入当前范围。

## 10. 结论

当前仓库已经具备一条可以落地执行的资产设计 / 风险管理改动回归链路：

1. 合约层负责证明 strict valuation、no-price close path、shortfall ledger 语义本身没有退化。
2. localhost E2E 负责证明视图、risk、liquidation、fallback observability 没有漂移。
3. fork 负责把 live wrapper 放到真实部署配置上提前验一遍。
4. live 负责确认价格刷新、registry route、liquidation 主路径 / fallback 路径在真实网络上仍然可观测。

当前真正还缺的是 shortfall ledger 的 E2E/live 专项脚本，以及 Tier-2 / reconciliation / settlement failure 的专门运行入口。
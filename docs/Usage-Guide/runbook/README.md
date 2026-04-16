# 项目交接 Runbook

## 0. 边界总览

这套 runbook 现在按“通用索引 + 网络专用执行册”分层维护，边界固定如下：

- 本文件只负责总索引、环境分层和进入哪本 runbook 的判断，不承载两条链各自的细节步骤。
- Arbitrum 相关执行册只覆盖 Arbitrum Sepolia：
	- mock 资产与 mock-suite 重建，看 `Arbitrum-Sepolia-Mock-Assets-Runbook.md`
	- live runtime / observability / release gate，看 `Arbitrum-Sepolia-Live-Platform-Baseline-Runbook.md`
- BNB 相关执行册只覆盖 BNB Testnet：
	- 真链 live、fresh borrower 补资与统一 sweep，看 `BNB-Testnet-Live-Runbook.md`
	- 本地 fork、runtime role 准备与 fork case 判定，看 `BNB-Testnet-Fork-Runbook.md`
- 如果某个步骤必须同时提到两条链，本文件只写“去哪本 runbook”，不再在这里维护第二套可执行命令。

## 1. 文档定位

这份文档是当前仓库唯一的标准化执行 Runbook。

使用规则：

- 所有可照抄执行的发布前验证、真实测试网部署、事故处置、紧急止血步骤，只保留在本文件。
- 其他指南、矩阵、设计文档只保留背景、边界、架构说明和指向本 Runbook 的入口，不再重复维护第二套执行步骤。
- 新同事接手项目时，先读本文件，再按文末“配套参考文档”补读细节说明。
- 如果目标是“在 Arbitrum Sepolia 上先部署一整套 mock 资产，再用 override 方式重建协议基线”，直接转到 `docs/Usage-Guide/runbook/Arbitrum-Sepolia-Mock-Assets-Runbook.md`。
- 如果目标是执行当前标准的 live 主资金链门禁，直接转到 `docs/Usage-Guide/runbook/Arbitrum-Sepolia-Live-Platform-Baseline-Runbook.md`。
- 如果目标是把同样的双层 live 门禁推进到 BNB Testnet，并确保 fresh borrower 自动补资与统一 sweep，直接转到 `docs/Usage-Guide/runbook/BNB-Testnet-Live-Runbook.md`。
- BNB guarantee flow 当前已验证“双阶段严格”稳定通过样式（age=10 连续 5 次全过）；可接受“初始链路直接收敛、未触发 `LoanFlowRetry` 也通过”的结果形态，详见 `BNB-Testnet-Live-Runbook.md` 的对应章节。
- 如果 BNB 真链出现 `SSOT_DEPLOYMENT_MISMATCH` 或 `SettlementManager -> ORDER_ENGINE` 桥接不一致，先在 `BNB-Testnet-Live-Runbook.md` 的“部署侧修复（ORDER_ENGINE / SETTLEMENT_MANAGER）”章节执行修复，再按“审计 -> guarantee baseline -> release-gates”顺序重跑。
- 如果目标是基于 BNB Testnet 私有 RPC 启本地 fork、补齐 runtime roles、执行 fork preflight / warmup / baseline / release-gates，并按日志判断这轮 fork 是否真的通过，直接转到 `docs/Usage-Guide/runbook/BNB-Testnet-Fork-Runbook.md`。当前可直接引用的完整通过样本为 `scripts/tests/logs/bnb-live-fork-20260403134109220/`，结论见 `BNB-Testnet-Fork-Runbook.md` 的“当前已验证证据 / 当前结论”。
- 如果目标是标准化复现 `LIVE_PRICE_MODE=backend-required` 的 missing-final-price 阻断，请直接使用 `pnpm -s run demo:backend-required:block:localhost` 或 `pnpm -s run demo:backend-required:block:fork`，并参考 `docs/Usage-Guide/runbook/Arbitrum-Sepolia-Mock-Assets-Runbook.md` 中的“标准复现实验入口”章节。

---

## 2. 适用范围

本 Runbook 索引当前统一分流四类操作：

1. localhost 严格回归
2. Arbitrum Sepolia fork pre-release
3. Arbitrum Sepolia live deploy / live-safe 验收
4. BNB Testnet live / fork 验收与事故第一响应

### 2.1 当前 BNB fork 状态

- 截至 2026-04-03，BNB fork 已拿到同一轮目录下 `prepare-runtime-roles + preflight + warmup + platform-baseline + release-gates` 全部通过的完整证据。
- 当前推荐把 `scripts/tests/logs/bnb-live-fork-20260403134109220/` 作为 fork 回归对照目录，把 `scripts/tests/logs/live-release-gates-bnbTestnet-via-localhost-20260403135603353/` 作为 release gates 子阶段汇总目录。
- 这说明 BNB fork 资金链 gate 已打通，可以继续进入 BNB 真链 live 验证；但 fork 通过不等于 live 可跳过，真链仍需按 `BNB-Testnet-Live-Runbook.md` 单独执行 preflight、baseline 和 release gates。

固定口径：

- localhost 负责确定性复现与严格 E2E。
- fork 负责发布前主行为证明。
- live 负责真实部署证明与真链读面证明。
- 事故处置时，以链上事实和 Registry 解析结果为准，不以缓存视图或格式化展示文本为唯一依据。

---

## 3. 网络边界

这里的“边界”只描述环境层，不替代链专用 runbook 的执行细节。

| 环境 | RPC | chainId | 用途 | 典型入口 |
| --- | --- | --- | --- | --- |
| localhost | http://127.0.0.1:8545 | 1337 | fresh node、本地部署、本地 smoke、本地严格 E2E | pnpm -s run node |
| fork localhost | http://127.0.0.1:18545 | 421614 | Arbitrum Sepolia fork 行为验证、fork-only E2E | pnpm -s run e2e:pre-release |
| arbitrumSepolia | 远程 RPC | 421614 | 真实测试网部署、live-safe smoke | pnpm -s run e2e:pre-release:arbitrum-sepolia-live |
| bnbTestnet | 远程 RPC | 97 | BNB 真链 live baseline / release gates | 见 `BNB-Testnet-Live-Runbook.md` |
| bnb fork localhost | runner 随机端口 | 1337 | BNB Testnet fork baseline / release gates | 见 `BNB-Testnet-Fork-Runbook.md` |

硬规则：

- fork-only 脚本不能直接跑在默认 localhost 1337 上。
- deploy、grant 和 E2E 必须共享同一个 LOCALHOST_RPC_URL。
- 只要重启 fresh node、切换端口或重新拉起 fork，就必须重新判断是否还能复用当前地址文件。
- 不要把 localhost 和 fork-only 步骤串在一条未经隔离的命令链里混跑。
- 不要在本文件里把 Arbitrum 的 live/fork 命令当成 BNB 的默认模板；两条链的运行入口已经拆分到各自 runbook。

---

## 4. 执行前检查

### 4.1 通用前置

- pnpm -s run compile
- pnpm -s run test:invariant
- 确认 deployments 地址文件与目标链一致
- 确认不会把主钱包私钥用于 fork、localhost 或 CI

### 4.2 live 额外前置

- ARBITRUM_SEPOLIA_RPC_URL 指向团队认可的 RPC
- 私钥默认保存在仓库根目录本地 .env，不写入仓库，也不要临时粘贴到命令历史里
- PRIVATE_KEY 对应的是专用测试钱包；如果要跑双钱包 warmup，BORROWER_PRIVATE_KEY 和 LENDER_PRIVATE_KEY 也应在本地 .env 中维护
- hardhat.config.ts 已通过 dotenv/config 自动读取本地 .env；直接在 shell 中运行 ts-node 编排脚本前，先执行 set -a && source .env && set +a，避免当前终端拿不到私钥变量
- deployer 地址在 Arbitrum Sepolia 上有足够 ETH
- scripts/deployments/arbitrum-sepolia.json 不是来源不明的旧产物

---

## 5. 标准执行流程

### 5.1 localhost fresh 基线

适用：首次本地验收、切换 fresh node 后重跑、需要验证系统“接近空链”基线。

终端 A：

```bash
pnpm -s run node
```

终端 B：

```bash
export DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI=1
export E2E_EVM_TIMEOUT_MS=120000
export E2E_STRICT_VIEWS=1
export E2E_VIEW_STRICT=1
export E2E_STRICT_DATAPUSH=1
export E2E_STRICT_REWARD=1
export LOCALHOST_RPC_URL="http://127.0.0.1:8545"

pnpm -s run compile
pnpm -s run test:invariant
LOCALHOST_RPC_URL=http://127.0.0.1:8545 pnpm -s run deploy:localhost
LOCALHOST_RPC_URL=http://127.0.0.1:8545 pnpm -s exec hardhat run scripts/tests/grant-required-roles-local.ts --network localhost
pnpm -s run test:smoke:prodlike:localhost
LOCALHOST_RPC_URL=http://127.0.0.1:8545 pnpm -s exec hardhat run scripts/e2e/e2e-localhost-blocks-only-rollout-smoke.ts --network localhost
LOCALHOST_RPC_URL=http://127.0.0.1:8545 pnpm -s exec hardhat run scripts/e2e/e2e-localhost-full-with-views.ts --network localhost
LOCALHOST_RPC_URL=http://127.0.0.1:8545 pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/quantify-latest-e2e-details.ts
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/quantify-latest-batch-artifacts.ts
pnpm -s run e2e:audit-deep-dive
```

通过标准：

- smoke 通过
- blocks-only、full-with-views、batch-advanced 全部通过
- latest reports 成功重写
- deep-dive audit 返回 0

### 5.2 localhost 一般 dirty 复跑

适用：同一条 localhost 链未重启，只想复跑 pre-release 或当前用户链路验证。

```bash
pnpm -s run compile
LOCALHOST_RPC_URL=http://127.0.0.1:8545 pnpm -s run e2e:pre-release:localhost
```

dirty 复跑前提：

- 仍然是同一条 localhost 链，没有重启、没有切端口
- deployments/localhost.json 中的地址在当前链上仍有 bytecode
- grant-required-roles-local.ts 已经在这条链上执行过

dirty / fresh 规则：

- full-with-views 现在是“当前用户一致性检查”
- dirty 链上 StatisticsView(global) 非零是允许的，只要 StatisticsView(user)、UserView、PositionView 与当前用户账本一致即可
- 如果目标是验证 fresh 部署后的全局零状态，不要复用 dirty 链，直接回到 5.1

### 5.3 fork pre-release

适用：发布前主行为证明。

推荐一键入口：

```bash
export ARBITRUM_SEPOLIA_RPC_URL="https://arb-sepolia.g.alchemy.com/v2/<ALCHEMY_API_KEY>"
export ARBITRUM_SEPOLIA_URL="$ARBITRUM_SEPOLIA_RPC_URL"
export DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI=1
export E2E_EVM_TIMEOUT_MS=120000
export E2E_STRICT_VIEWS=1
export E2E_VIEW_STRICT=1
export E2E_STRICT_DATAPUSH=1
export E2E_STRICT_REWARD=1

pnpm -s run e2e:pre-release
```

手工复跑 fork-only 问题时：

终端 A：

```bash
export ARBITRUM_SEPOLIA_RPC_URL="https://arb-sepolia.g.alchemy.com/v2/<ALCHEMY_API_KEY>"
export DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI=1
export HARDHAT_FORK_URL="$ARBITRUM_SEPOLIA_RPC_URL"
export HARDHAT_FORK_CHAIN_ID=421614
export HARDHAT_FORK_BLOCK_NUMBER="<OPTIONAL_PINNED_BLOCK>"

pnpm -s exec hardhat node --hostname 127.0.0.1 --port 18545
```

终端 B：

```bash
export DO_NOT_SET_THIS_ENV_VAR____IS_HARDHAT_CI=1
export E2E_EVM_TIMEOUT_MS=120000
export E2E_STRICT_VIEWS=1
export E2E_VIEW_STRICT=1
export E2E_STRICT_DATAPUSH=1
export E2E_STRICT_REWARD=1
export LOCALHOST_RPC_URL="http://127.0.0.1:18545"

LOCALHOST_RPC_URL=http://127.0.0.1:18545 pnpm -s run deploy:localhost
E2E_STRICT_VIEWS=1 E2E_VIEW_STRICT=1 LOCALHOST_RPC_URL=http://127.0.0.1:18545 E2E_KEEPER_ADDRESS=0x000000000000000000000000000000000000BEEF pnpm -s exec hardhat run scripts/e2e/e2e-fork-arbitrum-stale-price-keeper.ts --network localhost
```

通过标准：

- pnpm -s run e2e:pre-release 通过
- fork-only 脚本不再出现 chainId=1337 / Registry has no bytecode / could not decode result data (0x)

### 5.4 live deploy 基线

适用：首次在 Arbitrum Sepolia 建立真实部署基线。

```bash
pnpm -s run compile

ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
PRIVATE_KEY=<real_deployer_key> \
pnpm -s run e2e:pre-release:arbitrum-sepolia-live
```

执行要求：

- 必须真实执行 scripts/deploy/deploy-arbitrum-sepolia.ts
- 必须生成新的 scripts/deployments/arbitrum-sepolia.json
- 必须在同一轮里完成 compile、Registry invariant、live preflight 和默认 live-safe smoke

SettlementToken 覆盖规则：

- 默认仍按资产配置中的 `usd-coin` 作为 SettlementToken。
- 如果测试要改用别的可获得测试币，部署前可显式设置 `SETTLEMENT_TOKEN_ADDRESS=<token>`。
- 如果这个 token 已经在当前资产配置文件里，部署脚本会直接复用该配置；如果不在配置文件里，还必须同时提供 `SETTLEMENT_TOKEN_DECIMALS=<n>`。
- 可选附加覆盖：`SETTLEMENT_TOKEN_SOURCE_ID`、`SETTLEMENT_TOKEN_MAX_PRICE_AGE`、`SETTLEMENT_TOKEN_ACTIVE`。
- 兼容旧变量：`SETTLEMENT_TOKEN_COINGECKO_ID` 仍可使用，但新脚本优先读取 `SETTLEMENT_TOKEN_SOURCE_ID`。
- 这套覆盖只改变“本次部署使用哪个 SettlementToken”；如果你复用的是已经部署完成的现网实例，不能假设仅靠 env 就会把链上旧实例切到新 token。

示例：

```bash
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
PRIVATE_KEY=<real_deployer_key> \
SETTLEMENT_TOKEN_ADDRESS=<faucet_token_address> \
SETTLEMENT_TOKEN_DECIMALS=6 \
SETTLEMENT_TOKEN_SOURCE_ID=usd-coin \
pnpm -s run e2e:pre-release:arbitrum-sepolia-live
```

远端单 signer 约束：

- 在 arbitrumSepolia 这类远端网络上，Hardhat 运行时通常只暴露一个 signer，也就是 deployer。
- live-safe smoke 如果只是 read-only 校验，不允许假设一定存在 keeper、user 等额外 signer；脚本必须在进入只读早退分支前就兼容单 signer。
- 需要 keeper/user 语义但又是只读 smoke 时，允许回退复用 deployer 作为占位账户；真正写链场景不能这样偷换，必须显式提供角色账户。

smoke 脚本要求：

- read-only smoke 可以验证真实链部署、Registry 绑定、权限边界和只读读面，但不能替代 localhost / fork 的可写行为证明。
- 当前 live gate 会先跑独立 preflight，再跑扩展 live-safe smoke；preflight 负责暴露 oracle 可读性、RewardView 缓存冷热、ViewCache 有效位等状态，默认以告警为主，不会替代通过/失败判定的主 smoke 集。
- 当前 live gate 的价格语义应统一理解为：preflight 不只看链上 oracle 可读性，还应结合链下 publish status 判断价格链路是否真的健康。
- 当前扩展 live-safe smoke 除原有 whitelist/viewcache/lending/reward/funds-flow 只读集合外，还纳入 RewardView read-only acceptance、RewardSpend read-only acceptance，以及 live-read-pressure 读压测统计。
- 看到 `✅ [revert MissingRole] ...` 这类日志时，语义是“未授权路径按预期被拒绝”，这是权限烟雾测试通过，不是失败。
- 如果日志出现 `[skip]`，必须确认它对应的是 runbook 允许跳过的写链步骤，而不是因为依赖缺失、地址为零或脚本自身异常导致的假跳过。
- 如果 preflight 输出 warning，必须按语义解读：它表示“真实链当前状态存在冷缓存或弱可读性”，不是 runner 自身故障；只有显式开启 `LIVE_PREFLIGHT_STRICT_*` 时，这些项才升级为硬失败。
- 后续价格系统统一后，`chain readable but publish status missing/lagging` 不应再被当成“完全通过”，而应被归类为价格链路未完全闭合。

通过标准：

1. 真 deploy 成功
2. Registry 在 Arbitrum Sepolia 上 getCode != 0x
3. 默认 live-safe gate 全绿

日志位置规则：

- live gate 的日志基目录固定在 `scripts/e2e/logs/`
- 但每次运行不会覆盖到同一个固定目录，而是写入新的时间戳目录：`scripts/e2e/logs/live-smoke-<timestamp>/`
- 也就是说，“位置前缀”固定，“最终目录名”每次都会变

本次 fresh live deploy + live gate 成功运行的实际日志目录示例：

- `scripts/e2e/logs/live-smoke-20260320132527817/`
- 关键日志：`scripts/e2e/logs/live-smoke-20260320132527817/live-preflight-arbitrum-sepolia.log`
- 关键日志：`scripts/e2e/logs/live-smoke-20260320132527817/seed-mock-asset-prices.log`
- 关键日志：`scripts/e2e/logs/live-smoke-20260320132527817/live-prime-viewcache-arbitrum-sepolia.log`
- 关键日志：`scripts/e2e/logs/live-smoke-20260320132527817/live-read-pressure.log`

### 5.5 live skip-deploy 复跑

适用：上一轮已通过 live deploy 基线，只想复跑 invariant 与 live-safe smoke。

```bash
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc \
PRIVATE_KEY=<real_deployer_key> \
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/e2e/tools/run-pre-release.ts --arbitrum-sepolia-live --skip-deploy
```

仅当以下条件同时满足时允许使用：

- 当前地址文件来自上一轮已验收通过的 live deploy
- Registry 地址在真链上仍有 code
- chainId 与目标网络一致

建议：

- 用 skip-deploy 复跑扩展 live-safe gate 时，优先查看 `scripts/e2e/logs/live-smoke-*/live-preflight-arbitrum-sepolia.log`，确认 warning 是否仍停留在已知范围内。
- 如果你要找“最近一次” live gate 的整套日志，不要假设目录名固定；应在 `scripts/e2e/logs/` 下按最新的 `live-smoke-<timestamp>/` 目录查找。
- 当前已知 warning 基线包括：`PriceOracle.getPrice(asset)` 在 live 上可能 revert、`ValuationOracleView` 可能返回 `0/0/invalid`、RewardView/ViewCache/HealthView 在 fresh live 状态下可能保持 cold cache。

---

## 6. 发布前最终判定

最低通过线：

1. pnpm -s run e2e:pre-release 通过
2. pnpm -s run e2e:pre-release:arbitrum-sepolia-live 通过
3. latest 报告和 deep-dive audit 已按最新产物重建
4. live deploy 产物与 Registry 解析一致

不允许的表述：

- 只通过 fork，就宣称“真链可部署已验证完成”
- 只通过 live 只读 smoke，就宣称“复杂行为已完成证明”

---

## 7. 事故第一响应

### 7.1 RpcMissingTrieNode / fork node 崩溃

1. 判定为 RPC / 基础设施事故
2. 切换备用 RPC，必要时更换 forkBlockNumber
3. 验证 rpc_last_success_timestamp 恢复

### 7.2 OraclePriceInvalid / OracleStaleHard

1. 先区分 warming 还是事故
2. 若非 warming，按 P0 调查
3. 监控侧以 PriceOracle.isPriceValid(asset) 为不回滚口径
4. keeper 刷新价格，必要时逐项检查 UPDATE_PRICE 权限、asset active、price 非零、blockNumber 不倒退、assetDecimals 已配置
5. 恢复验证：oracle_price_valid==1 且 oracle_price_age_ratio 回到安全区间

### 7.3 ViewInvalid / SelectorMismatch

1. 先区分 warming 还是路由/实现错位
2. warming 场景先检查 ViewCache、索引器、推送链路是否刚启动
3. 若连续多次仍 block=0 / isValid=0，按 P0 处理
4. 立即阻断前端错误展示，并排查 Registry 绑定、selector、versionInfo mismatch

### 7.4 Reward 对账差异

1. 以链上为准，先检查 ERC20 balance 与 RewardView
2. 再做 re-index / force-sync / retry-push

### 7.5 EasySpendSplitMismatch / EasyRecycleBalanceGrowing

1. 判定为资金流拆分异常，按 P0 处理
2. 先看链上事实：Transfer、EasyBurned、recycle->team、recycle->eco
3. 检查 Registry 的 KEY_EASY_CONSUMPTION 是否错位
4. 临时止损：暂停扣费入口或降级为仅展示
5. 恢复验证：easy_recycle_balance 不再持续上升，且新 consume 都有完整拆分

### 7.6 RewardViewPushFailed

1. 先区分业务是否真实发生，还是仅镜像缺失
2. 若真实发生但 push 失败，以链上事件为准做链下补偿
3. 若 rewardView unavailable，检查 KEY_REWARD_VIEW 与路由绑定
4. 恢复验证：rewardview_push_failed_total 停止增长，DataPush 流恢复稳定

---

## 8. 借贷 + Easy 奖励紧急止血

### 8.1 执行前输入

- registry：当前网络 Registry 地址
- guardianSigner：Guardian 多签或签名人
- keeperSigner：仅当采用自动 pause 策略时才需要

### 8.2 强制地址解析

任何一个解析失败都不要继续：

- le = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_LE)
- easyToken = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_EASY_TOKEN)
- fr = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_FR)
- vaultCore = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE)
- vaultRouter = IVaultCoreMinimal(vaultCore).viewContractAddrVar()

### 8.3 默认暂停范围

- 必须暂停：VaultRouter、LendingEngine、EasyToken
- 强烈建议一起暂停：FeeRouter
- 可选：LoanNFT

### 8.4 Pause 顺序

1. VaultRouter.pause()
2. LendingEngine.pause()
3. FeeRouter.pause()
4. LoanNFT.pause()
5. EasyToken.pause()

### 8.5 Unpause 顺序

1. EasyToken.unpause()
2. LoanNFT.unpause()
3. FeeRouter.unpause()
4. LendingEngine.unpause()
5. VaultRouter.unpause()

unpause 前必须满足：

- 原因已定位
- 修复已生效
- 双人确认完成
- 冒烟测试通过

### 8.6 暂停后验证

- VaultRouter.paused() == true
- LendingEngine.paused() == true
- EasyToken.paused() == true
- 如包含 FeeRouter / LoanNFT，也必须逐项验证 paused() == true
- 检查关键 ActionExecuted / DataPushed 是否留痕

---

## 9. 新同事接手顺序

建议按这个顺序阅读：

1. 先读本 Runbook
2. 再看部署边界与环境说明：../Arbitrum-Sepolia-Testnet-Deployment-Guide.md
3. 再看 live 验收矩阵：../Arbitrum-Sepolia-Live-Deployment-Validation-Matrix.md
4. 再看脚本执行说明：../../../scripts/e2e/README.md 和 ../../../scripts/tests/README.md
5. 最后按需要查看专项设计文档

配套参考文档：

- ../Arbitrum-Sepolia-Testnet-Deployment-Guide.md
- ../Arbitrum-Sepolia-Live-Deployment-Validation-Matrix.md
- ../../../scripts/e2e/README.md
- ../../../scripts/tests/README.md
- ../../../scripts/deploy/README.md
- ../Monitoring-Observability-Implementation-Guide.md
- ../Reward/Governance-FeatureRegistry-SSOT-Design.md
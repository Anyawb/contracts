# Arbitrum Sepolia Mock Assets Runbook

## 1. 这份文档是不是 runbook

是。

原因很简单：这份文档不是讲概念，也不是做架构说明，而是给运维/开发直接照抄执行的一套步骤，目标是完成三件事：

1. 部署一组可控的 mock 资产到 Arbitrum Sepolia
2. 用新的 override 方式把协议从部署开始绑定到新的 mock SettlementToken
3. 把 mock BTC / mock ETH / RWA 资产一并接进协议并完成价格点火

如果未来你再补一份“为什么这么设计、哪些模块依赖 SettlementToken、mock 资产与真实测试币的区别”，那份更像 usage guide；这份是 runbook。

---

## 2. 适用场景

适用于以下情况：

1. 你不想继续受限于当前 Arbitrum Sepolia 上已经绑定的某个第三方测试币地址
2. 你希望自己部署一整套可控资产，并让协议从第一天开始绑定这套资产
3. 你希望后续做真实 deposit / borrow / repay / liquidation / reward 点火时，不再依赖外部 faucet 是否给到某个指定 token

这份 runbook 的默认资产包包括：

1. Mock USDC
2. Mock USDT
3. Mock HKD
4. Mock SGD
5. Mock BTC
6. Mock ETH
7. RWA Gold
8. RWA Bond
9. RWA Real Estate
10. RWA Invoice

默认将 Mock USDC 作为 SettlementToken。

如果你想让本次实例改用别的稳定币作为系统级 SettlementToken，而不是默认的 `mUSDC`，可以在不提供自定义资产包文件的情况下直接设置：

```bash
MOCK_SETTLEMENT_TOKEN_SYMBOL="mUSDT"
```

当前默认资产包支持的稳定币 symbol 有：

1. `mUSDC`
2. `mUSDT`
3. `mHKD`
4. `mSGD`

注意：

1. 默认资产包里可以同时存在多种稳定币
2. 但同一个部署实例里仍然只能有一个 `settlementToken=true`
3. 其他稳定币继续作为可借贷资产存在，不会因为不是 SettlementToken 就被排除

---

## 3. 前置条件

执行前确认：

1. `ARBITRUM_SEPOLIA_RPC_URL` 已设置
2. 私钥默认保存在仓库根目录本地 `.env`；`PRIVATE_KEY`、`BORROWER_PRIVATE_KEY`、`LENDER_PRIVATE_KEY` 都应优先维护在那里，不要依赖临时命令行粘贴
3. `PRIVATE_KEY` 已设置，且该地址在 Arbitrum Sepolia 上有足够 ETH
4. 如果当前步骤是通过 shell 直接调用 `ts-node` 编排脚本，先执行 `set -a && source .env && set +a`，确保当前终端拿到本地 `.env` 里的钱包变量；通过 Hardhat 入口执行时，`hardhat.config.ts` 会自动读取 `.env`
5. 当前仓库已经 compile 通过
6. 如果当前 RPC 是 Arbitrum Sepolia 免费档或受限档，liquidation 相关脚本必须把 `LIQUIDATION_SEARCH_CHUNK_BLOCKS` 控制在 `9` 以内；这是前置条件，不是可选调优项。超过后出现的 `eth_getLogs` / `block range` / `Free tier` / `Upgrade to PAYG` 报错，优先判断为 provider 限额，而不是 liquidation 业务断言失败
7. 当 `LIQUIDATION_SEARCH_CHUNK_BLOCKS=9` 时，不要再把候选订单扫描理解成“9 单订单限制”。现在脚本会按 9-block 窗口分配候选预算，优先用“小窗口 + 小批量”的方式回退搜索。默认建议理解为：每个窗口只拿少量最近订单，而不是在单个窗口里尽量塞满全部候选
8. 如果你怀疑最近订单过多导致 fallback 过慢，优先调小这两个参数，而不是盲目扩大 lookback：
  - `LIQUIDATION_SEARCH_MAX_WINDOWS`：最多扫描多少个区块窗口
  - `LIQUIDATION_SEARCH_MAX_ORDERS_PER_WINDOW`：每个窗口最多保留多少笔订单
9. 在免费 RPC 下，建议默认从下面这组参数开始：

```bash
LIQUIDATION_SEARCH_CHUNK_BLOCKS=9
LIQUIDATION_SEARCH_MAX_WINDOWS=12
LIQUIDATION_SEARCH_MAX_ORDERS_PER_WINDOW=2
```

10. 上面这组配置意味着 fallback 最多只会从最近 `12` 个窗口里抽取 `24` 笔候选订单；如果当前实例最近订单密度很高，不要先把总候选拉回 `80` 甚至更大，先确认这 `24` 笔是否已经足够覆盖你要的 mock-suite 最近活动区间
11. 如果当前实例没有现成可 liquidate 的真实订单，不要继续盲调 `LIQUIDATION_SEARCH_LOOKBACK_BLOCKS` 或把候选数重新拉大；优先运行 `scripts/tests/live-test/seed-liquidatable-order-arbitrum-sepolia.ts` 生成一笔新的可用订单，或者直接使用已经接入自动 seed 的 runner
12. 使用 seed 脚本生成的订单时，通常还需要同时设置：

```bash
LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER=1
```

13. 不要把固定的旧 `LIQUIDATION_ORDER_ID` 长期写死在 `.env` 里。当前 mock-suite live runner 已经会在下面两个 case 开始前自动执行 `seed-liquidatable-order-arbitrum-sepolia.ts`，然后把本次输出的订单 id 注入到 case 环境里：

```bash
live-liquidation-arbitrum-sepolia
live-liquidation-fallback-arbitrum-sepolia
```

14. 只有在你手工单跑 liquidation 脚本、或要复用某个刚刚 seed 出来的订单时，才需要显式传入：

```bash
LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER=1
LIQUIDATION_SEARCH_CHUNK_BLOCKS=9
LIQUIDATION_SEARCH_MAX_WINDOWS=12
LIQUIDATION_SEARCH_MAX_ORDERS_PER_WINDOW=2
```
15. 如果你在自定义 full-live 批次里包含 `live-read-pressure.ts`，要把它视为远程网络只读脚本处理，不要因为遗漏 `READ_ONLY=1` / `ENABLE_WRITE=0` 而把它误判为写路径失败
16. mock-suite 直跑单脚本或自定义 full-live 批次时，live-test 入口现在默认优先读取 `scripts/deployments/arbitrum-sepolia.mock-suite.json`；前提是本次目标确实是 mock-suite 线，不要再混用旧的 `arbitrum-sepolia.json`
17. 任何需要 fresh borrower 写链的 live case，现在建议每轮测试开始前临时生成一套新的 `LIVE_FRESH_BORROWER_MNEMONIC`，并同时设置一份“本轮独立”的 `LIVE_FRESH_BORROWER_STATE_FILE`；不要长期复用固定 borrower，也不要把不同轮次的新 mnemonic 复用到同一个旧 state file 上
18. 推荐做法不是手工维护长期固定的 fresh borrower 私钥，而是：每轮 live 开始前由 Node 临时生成一套新的 12 词 mnemonic，本轮 fresh borrower 从这套 mnemonic 派生，批次结束后再自动 sweep 回 sponsor
19. 任何包含 `approve -> deposit -> finalizeMatch -> approve -> repay` cleanup 的 write-mode live case，都不要依赖过低的默认 fresh borrower 原生币预算。当前 Arbitrum Sepolia 实测建议把 `LIVE_FRESH_BORROWER_NATIVE_ETH` 直接设到 `0.0003` 以上，再开始 full-live 或单脚本回归
20. 如果主断言已经通过，但 cleanup repay 在发送交易阶段报 `insufficient funds for gas * price + value`，优先判断为 fresh borrower sponsor 原生币预算不足；这类错误不应直接归因为 `VaultCore.repay(...)` 或 `SettlementManager.repayAndSettle(...)` 的业务失败

建议先跑：

```bash
pnpm -s run compile
```

### 每轮 full-live 的 fresh borrower 标准命令

Arbitrum Sepolia mock-suite 现在推荐固定用下面这一条命令启动 full-live。它会同时做 4 件事：

1. 载入本地 `.env`
2. 让 `run-full-live-rerun.js` 自动生成一套新的 12 词 `LIVE_FRESH_BORROWER_MNEMONIC`
3. 让 `run-full-live-rerun.js` 自动为本轮创建独立的 `LIVE_FRESH_BORROWER_STATE_FILE`
4. 执行 `run-full-live-rerun.js`，并在批次结束后自动 sweep 剩余原生币

```bash
set -a && source .env && set +a && \
export LIVE_FRESH_BORROWER_NATIVE_ETH="0.0003" && \
export REGISTRY_ADDRESS=0xaE0455077051c9ca532D4B63DD9B35BafAA1B352 \
DEPLOY_OUTPUT_FILE=scripts/deployments/arbitrum-sepolia.mock-suite.json \
LIVE_USE_MOCK_ASSET_PACK=1 \
LIVE_PRICE_MODE=bootstrap \
MOCK_ASSET_PACK_OUTPUT=deployments/mock-assets.arbitrum-sepolia.json \
ASSETS_FILE=deployments/assets.arbitrum-sepolia.mock.json \
SETTLEMENT_TOKEN_ADDRESS=0x2767e0d87d9889Aeb447A3851aA455A51Bf67035 \
SETTLEMENT_TOKEN_DECIMALS=6 \
ALLOW_LIQUIDATION_MANAGER_PAUSE=1 \
ALLOW_DYNAMIC_FEE_WRITE=1 && \
node scripts/tests/tools/run-full-live-rerun.js
```

执行约束：

1. 每轮新的 full-live 都会由 runner 自动重新生成一次 mnemonic。
2. 每轮新的 full-live 都会由 runner 自动使用新的 state file 路径。
3. 不要把上一轮的 mnemonic 留给下一轮继续复用。
4. 如果你只跑单个 write-mode live 脚本，也建议用 [scripts/tests/tools/run-live-script-with-sweep.js](scripts/tests/tools/run-live-script-with-sweep.js) 这类按轮生成 fresh 配置且内置 `EXIT cleanup` 的 wrapper，再执行对应脚本。
5. 统一口径：单轮只保留一次 sweep，且只在退出清理阶段触发；不要再手工补跑 sweep。
6. 以 runner 生成的 sweep 日志作为回流证据，不再额外追加手工 sweep 日志。

### liquidation case 的自动 seed 行为

当前两个批量 runner 都已经内置 liquidation seed：

1. [scripts/tests/tools/run-live-items-individually.js](scripts/tests/tools/run-live-items-individually.js)
2. [scripts/tests/tools/run-full-live-rerun.js](scripts/tests/tools/run-full-live-rerun.js)

它们会在下面两个 case 开始前自动执行一次 `seed-liquidatable-order-arbitrum-sepolia.ts`：

1. `live-liquidation-arbitrum-sepolia`
2. `live-liquidation-fallback-arbitrum-sepolia`

自动 seed 完成后，runner 会把下面三个环境变量仅注入到对应 case：

```bash
LIQUIDATION_ORDER_ID=<seed 输出的 orderId>
LIQUIDATION_FALLBACK_ORDER_ID=<同一个 orderId>
LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER=1
```

这意味着：

1. 批量 rerun 默认不再依赖 `.env` 里的旧 `LIQUIDATION_ORDER_ID`
2. 过期 orderId 不会再把 liquidation case 直接带进 `ZeroAddress` 黑盒 revert
3. 如果 auto-seed 自己失败，summary 里会先出现对应的 seed 失败，再跳过目标 liquidation case

### 手工单跑 seeded liquidation

如果你想手工单跑某一条 liquidation case，推荐先手工 seed 一次，再复制输出里的 orderId：

```bash
REGISTRY_ADDRESS=<registry> \
SETTLEMENT_TOKEN_ADDRESS=<settlement> \
LIVE_FRESH_BORROWER_NATIVE_ETH=0.0003 \
LIVE_AUTO_GRANT_RUNTIME_ROLES=1 \
ALLOW_DYNAMIC_FEE_WRITE=1 \
node scripts/tests/tools/run-live-script-with-sweep.js \
  --label seed-liquidatable-order-arbitrum-sepolia \
  --command 'pnpm -s exec hardhat run scripts/tests/live-test/seed-liquidatable-order-arbitrum-sepolia.ts --network arbitrumSepolia' \
  --network arbitrumSepolia
```

成功后会在日志里输出：

```bash
SEEDED_LIQUIDATION_ORDER_ID=<orderId>
SEEDED_LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER=1
```

然后把它传给目标 case：

```bash
REGISTRY_ADDRESS=<registry> \
SETTLEMENT_TOKEN_ADDRESS=<settlement> \
LIVE_FRESH_BORROWER_NATIVE_ETH=0.0003 \
LIVE_AUTO_GRANT_RUNTIME_ROLES=1 \
ALLOW_DYNAMIC_FEE_WRITE=1 \
LIQUIDATION_ORDER_ID=<orderId> \
LIQUIDATION_FALLBACK_ORDER_ID=<orderId> \
LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER=1 \
node scripts/tests/tools/run-live-script-with-sweep.js \
  --label live-liquidation-arbitrum-sepolia \
  --command 'pnpm -s exec hardhat run scripts/tests/live-test/live-liquidation-arbitrum-sepolia.ts --network arbitrumSepolia' \
  --network arbitrumSepolia
```

---

## 4. 第一步：部署 mock 资产包

直接执行：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
pnpm -s run deploy:mock-assets:arbitrum-sepolia
```

执行结果会生成两个文件：

1. `deployments/mock-assets.arbitrum-sepolia.json`
2. `deployments/assets.arbitrum-sepolia.mock.json`

含义分别是：

1. 第一个文件保存 mock 资产部署结果、SettlementToken 地址、bootstrap 价格以及 RWA 价格目录元数据
2. 第二个文件是协议部署可直接消费的资产配置文件

默认 SettlementToken 是 `mUSDC`。

如果你想自定义资产包，而不是用默认的 6 个 mock 币 + 4 个 RWA 币，可以准备一个 JSON 文件，然后在部署时传：

```bash
MOCK_ASSET_PACK_FILE="<path-to-json>" \
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
pnpm -s run deploy:mock-assets:arbitrum-sepolia
```

自定义 JSON 的 `assets` 项结构如下：

```json
{
  "assets": [
    {
      "id": "mock-usdc",
      "name": "Mock USDC",
      "symbol": "mUSDC",
      "kind": "mock-erc20",
      "decimals": 6,
      "initialSupply": "1000000000",
      "sourceId": "mock-usdc",
      "maxPriceAge": 3600,
      "active": true,
      "bootstrapPriceValue": "1",
      "sourceProvider": "bootstrap-manual",
      "pricingCurrency": "USD",
      "fallbackPolicy": "bootstrap-only",
      "launchPriceRequired": false,
      "settlementToken": true
    }
  ]
}
```

规则：

1. `kind` 只能是 `mock-erc20` 或 `rwa-token`
2. 必须且只能有一个 `settlementToken=true`
3. `bootstrapPriceValue` 是 bootstrap / live warmup 阶段使用的价格字符串，属于字段名；单位仍是普通十进制美元值，实际写链时会按目标资产 `assetDecimals` 解释，不需要自己手写 8 位精度
4. 可选的 `sourceProvider`、`sourceTicker`、`pricingCurrency`、`quoteToUsdPair`、`updateCadence`、`staleAfterSeconds`、`fallbackPolicy`、`launchPriceRequired` 会写入资产包 JSON，供 runbook、后端 price job 和 price catalog 读取

当前仓库内置了一份 Google Finance 口径的可改模板，可直接作为自定义 asset pack 起点：

1. `deployments/mock-assets.google-finance.template.json`
2. 默认 RWA ticker 模板：
  - `RWAGOLD -> GLD:NYSEARCA`
  - `RWABOND -> IEF:NASDAQ`
  - `RWARE -> VNQ:NYSEARCA`
  - `RWAINV -> MINT:NYSEARCA`
3. 当前默认 `quoteToUsdPair=USD/USD`，表示 collector 读取到的原始计价已是 USD，无需额外 FX 换算

---

## 5. 第二步：用 override 方式重新部署协议

拿第一步生成的 `deployments/assets.arbitrum-sepolia.mock.json`，把协议部署切换到这套资产配置。

执行：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
FRESH_DEPLOY=1 \
ASSETS_FILE="deployments/assets.arbitrum-sepolia.mock.json" \
SETTLEMENT_TOKEN_ADDRESS="<mUSDC_address>" \
SETTLEMENT_TOKEN_DECIMALS=6 \
pnpm -s run e2e:pre-release:arbitrum-sepolia-live
```

这里的 `<mUSDC_address>` 可以直接从 `deployments/mock-assets.arbitrum-sepolia.json` 里的 `settlementToken` 字段读取。

这一步现在具备两个关键行为：

1. `SETTLEMENT_TOKEN_ADDRESS` 会让部署脚本从一开始就绑定新的 mock USDC，而不是默认 `usd-coin`
2. `ASSETS_FILE` 中的全部资产现在会自动进入 PriceOracle、AssetWhitelist 和 FeeRouter，不再只处理 SettlementToken
3. `DEPLOY_OUTPUT_FILE` 让这套 mock-suite 使用独立的部署输出文件，不会复用或污染默认的 `arbitrum-sepolia.json`
4. `FRESH_DEPLOY=1` 会忽略已有 deploy output 缓存，真正重新部署一套新合约，而不是沿用旧代理地址

也就是说，这次部署结束后：

1. mock USDC 是协议的 SettlementToken
2. mock BTC / mock ETH / RWA 资产已经被协议识别为可用资产

---

## 6. 第三步：给 mock 资产批量点价格

协议部署完成后，立即执行价格点火：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
AUTO_GRANT_UPDATE_PRICE=1 \
pnpm -s run seed:mock-asset-prices:arbitrum-sepolia
```

当前默认行为是：

1. 正常路径优先调用 `PriceUpdater.updateAssetPrice`
2. 只有在显式设置 `SEED_ALLOW_DIRECT_PRICE_ORACLE=1` 时，才会降级为 `PriceOracle.updatePrice`
3. `AUTO_GRANT_UPDATE_PRICE=1` 只是在当前 deployer 同时是 ACM owner 时，允许脚本自动补 `UPDATE_PRICE`

如果你要把 mock-assets JSON 同步导出给后端 price catalog / publish job，可在 seed 之后执行：

```bash
pnpm -s run export:rwa-price-catalog:arbitrum-sepolia
```

默认输出：

1. `deployments/rwa-price-catalog.arbitrum-sepolia.json`
2. 其中包含最小 `rwaAssetCatalog` 与 `oraclePublishJobs` 两段 payload
3. 顶层包含显式 `schemaVersion` / `targetPriceUnit` / `defaultWriteTarget`
4. 资产级主键统一使用 `assetId + symbol + address + updaterAssetId`
5. `publishMode` 会按 `launchPriceRequired` 映射为 `backend-required` 或 `bootstrap`

如果要显式走 break-glass 路径：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
REGISTRY_ADDRESS="<registry>" \
AUTO_GRANT_UPDATE_PRICE=1 \
SEED_ALLOW_DIRECT_PRICE_ORACLE=1 \
pnpm -s run seed:mock-asset-prices:arbitrum-sepolia
```

---

## 7. 第四步：先做零成本预演

如果你的目标是“在真正花测试币之前，先把这套 live 脚本尽量测透”，正确方法不是直接上 Arbitrum Sepolia 跑 write-mode，而是把测试拆成 3 层：

1. localhost 写路径演练：完全不花测试币，可以真实执行 warmup、liquidation、fee gate。
2. Arbitrum Sepolia fork 写路径演练：仍然不花测试币，但更接近真实链上状态。
3. Arbitrum Sepolia 真链零写入预演：只跑只读脚本和 `staticCall`，提前暴露权限、订单、价格、费率、余额问题。

这 3 层里，真正“零成本且尽量接近 live”的最佳组合是：

1. 先跑 fork 演练验证脚本逻辑会不会真的写坏
2. 再跑真链 dry-run 验证当前线上状态是否满足脚本前提
3. 最后才决定要不要进入真实 write-mode

### 7.1 localhost / fork 写路径演练

这一步完全不花 Arbitrum Sepolia 测试币，但可以把 write-path 尽量跑真。

已有脚本：

1. `pnpm -s run demo:backend-required:block:localhost`
2. `pnpm -s run demo:backend-required:block:fork`

此外，如果你要重点验证“新增 release gates 本身”，建议优先在 fork 或 localhost 上跑各单脚本，原因是：

1. 可以真实写状态
2. 不消耗真实测试币
3. 失败可以反复回放
4. 可以安全验证 pause / fallback / dynamic fee 临时配置这类敏感路径

### 7.2 真链零写入 dry-run

仓库现在已经补了一个专门的零写入入口：

```bash
pnpm -s run test:live:dryrun:arbitrum-sepolia
```

它会做：

1. 跑 `live-asset-precheck-arbitrum-sepolia.ts`
2. 跑 `live-preflight-arbitrum-sepolia.ts`
3. 用 `staticCall` 验证 liquidation gate 当前是否具备执行前提
4. 用 `staticCall` 验证 fee gate 当前是否具备执行前提
5. 输出 relayer 的关键角色 readiness
6. 落日志到 `scripts/tests/logs/live-release-dryrun-<network>-<timestamp>/`

它不会做：

1. 不会补价
2. 不会 pause 合约
3. 不会真实转 token
4. 不会真实执行 liquidation / fee 分账

所以这一步特别适合回答：

1. 当前 live 实例是不是已经具备执行条件
2. 缺的是角色、余额、FeeRouter 余额、动态费配置，还是 overdue 订单
3. 现在进入 write-mode 是否大概率只会白白消耗测试币

推荐先执行：

```bash
set -a && source .env && set +a

pnpm -s run test:live:dryrun:arbitrum-sepolia
```

推荐把 `LIQUIDATION_ORDER_ID` 直接写进仓库根目录本地 `.env`，不要每次都内联写到命令行里。

标准写法：

```bash
LIQUIDATION_ORDER_ID=17
```

要求：

1. 必须是纯数字 orderId，不要加引号
2. 不要写成 `#17`
3. 不要填交易 hash
4. 必须对应当前实例里一笔已经 overdue 的真实订单

如果你连 `LIQUIDATION_ORDER_ID` 都还没有，那么 dry-run 也会明确告诉你 liquidation gate 目前只是“缺前置订单”，而不是直接浪费一次真链尝试。

---

## 8. 第五步：再做 live-test 前置检查

在 mock 资产部署、协议 fresh deploy、价格 seed 完成后，不要直接进入资金写路径 gate，先做前置检查。

推荐顺序分两种：

1. 如果你是在复验一个已经部署好的 mock-suite 实例，先 dry-run / precheck / preflight，再跑标准 live 主入口
2. 如果你是从零 fresh deploy，一条龙流程里可以直接把标准 live 主入口放在第二步核心位，因为它本身就包含 deploy + live preflight + core smoke

复验已有实例时，推荐顺序：

1. 资产与价格前置检查
2. 协议 view / cache / reward / health 前置检查
3. 再进入统一 release gates

执行：

```bash
pnpm -s exec hardhat run scripts/tests/live-test/live-asset-precheck-arbitrum-sepolia.ts --network arbitrumSepolia

pnpm -s exec hardhat run scripts/tests/live-test/live-preflight-arbitrum-sepolia.ts --network arbitrumSepolia
```

这两步主要回答：

1. 资产白名单、FeeRouter、Oracle、UpdatePrice 路径是不是可用
2. RewardView、ViewCache、HealthView、PositionView 等关键读面是不是健康
3. 当前实例是否适合继续做真实资金流 live gate

---

## 9. 第六步：执行统一 live 发布入口

现在仓库已经把新增的 5 个关键 gate 串成一个统一入口：

```bash
pnpm -s run test:live:release-gates:arbitrum-sepolia
```

这个入口会顺序执行：

1. `live-platform-runtime-baseline-arbitrum-sepolia.ts`
2. `live-platform-observability-evidence-arbitrum-sepolia.ts`
3. `live-fee-prepaid-gate-arbitrum-sepolia.ts`
4. `live-fee-remaining-gate-arbitrum-sepolia.ts`
5. `live-fee-dynamic-gate-arbitrum-sepolia.ts`

输出行为：

1. 每个 gate 独立执行
2. 每一步输出写入 `scripts/tests/logs/live-release-gates-<network>-<timestamp>/`
3. 末尾打印 PASS / FAIL 汇总

默认使用：

```bash
LIVE_RELEASE_NETWORK=arbitrumSepolia
LIVE_RELEASE_CONTINUE_ON_ERROR=0
```

当前 Arbitrum Sepolia mock-suite 的已验证通过样例日志目录为：

1. `scripts/tests/logs/live-release-gates-arbitrumSepolia-20260322134539195/`
2. 该目录对应 5 个 gate 全绿
3. 这轮修复的重点不是补一条新的写路径，而是把 gate 断言重新对齐到链上真实语义：
  - legacy overdue liquidation 对齐 `SettlementManager` 的实际 fallback 行为
  - fallback liquidation 的 pause / restore 改成幂等
  - fee gate 兼容 `relayer == platformTreasury == ecosystemVault` 的地址重合场景

如果你不想一次性跑完整 release gate，也可以按域使用新的总入口：

```bash
pnpm -s run test:live:platform-runtime-baseline:arbitrum-sepolia
pnpm -s run test:live:platform-observability-evidence:arbitrum-sepolia
pnpm -s run test:live:fee-baseline:arbitrum-sepolia
pnpm -s run test:live:reward-baseline:arbitrum-sepolia
pnpm -s run test:live:guarantee-baseline:arbitrum-sepolia
```

如果你希望失败后继续把剩余 gate 也跑完，便于一次性收集完整失败面，可改成：

```bash
LIVE_RELEASE_CONTINUE_ON_ERROR=1 \
pnpm -s run test:live:release-gates:arbitrum-sepolia
```

---

## 10. 第七步：按 gate 准备环境变量

### 10.1 liquidation 相关

非本地网络执行 unified release gates 时，legacy liquidation 和 fallback liquidation 默认不会为你现建一笔 36,000 block 后才 overdue 的 legacy 订单。

因此你需要提供：

```bash
LIQUIDATION_ORDER_ID=17
```

要求：

1. 该订单必须已经 overdue
2. 该订单对应 borrower 必须仍有可 reducer 的债务
3. `.env` 里必须写纯数字，不要加引号
4. 这个值不是脚本自动生成的，而是你为当前实例挑选好的现有 orderId
5. keeper signer 必须具备 `ActionKeys.ACTION_LIQUIDATE`
6. keeper signer 还需要具备 `ActionKeys.ACTION_UPDATE_PRICE`，因为脚本会在清算前按 runbook 刷新债务资产和可处分抵押价格

如果你在 Arbitrum Sepolia 上直跑 liquidation 相关脚本，还要额外控制日志扫描窗口；这里默认沿用前置条件里的免费档 RPC 口径。

当前 runbook 默认约束：

1. 免费档 RPC 单次 `eth_getLogs` 查询不要超过 `9` 个 blocks
2. 建议直接把下面这个值写进本地 `.env`

```bash
LIQUIDATION_SEARCH_CHUNK_BLOCKS=9
```

3. 如果仍然看到 `eth_getLogs` / `block range` / `Free tier` / `Upgrade to PAYG`，优先判断为 RPC provider 限额，不要先怀疑 liquidation gate 本身
4. 如果换成更高配的 RPC，可以再放大该值；但在 runbook 默认口径里，先按 `9` 保守执行

如果要执行 fallback gate，在非本地网络还必须显式允许 pause `LiquidationManager`：

```bash
ALLOW_LIQUIDATION_MANAGER_PAUSE=1
```

这一步只应该在你确认当前实例是 mock/live 测试实例、并允许短暂 pause `LiquidationManager` 的前提下执行。

### 10.2 fee gate 相关

常用可选变量：

```bash
FEE_PREPAID_AMOUNT_UNITS="50"
FEE_PREPAID_TYPE_NAME="LIQUIDATION_PLATFORM_SHARE"

FEE_REMAINING_AMOUNT_UNITS="100"

FEE_DYNAMIC_AMOUNT_UNITS="100"
FEE_DYNAMIC_TYPE_NAME="LIVE_DYNAMIC_FEE_TEST"
FEE_DYNAMIC_BPS="200"
```

dynamic fee gate 有两种模式：

1. 链上该 `feeType` 已经存在动态费配置：直接消费现有配置
2. 链上该 `feeType` 尚未配置：需要显式允许临时写入再恢复

对应开关：

```bash
ALLOW_DYNAMIC_FEE_WRITE=1
```

只有当 relayer 同时具备 `SET_PARAMETER`，并且你接受脚本在测试后自动恢复原值时，才应该打开这个开关。

---

## 11. 第八步：推荐的三步执行法

从执行顺序上，这份 runbook 现在统一按 3 步理解，不再把所有 live 脚本混在一个阶段里。

### 第 1 步：先在本地把写路径跑通

目标不是“证明 Sepolia 已经 ready”，而是先用最低成本把写路径逻辑本身跑通。

这一阶段的目标：

1. 不花 Arbitrum Sepolia 测试币
2. 先确认脚本编排、角色补齐、价格 seed、资金流主链路没有明显自毁问题
3. 把 liquidation / fee / funds-flow / reward 的高风险写路径先在 localhost 或 fork 上回放一遍

推荐入口：

```bash
set -a && source .env && set +a

pnpm -s run compile

pnpm -s run demo:backend-required:block:localhost

pnpm -s run demo:backend-required:block:fork
```

如果你当前重点是“正式上链前先把多资产写路径跑透”，再补一轮 localhost 多资产可写回归：

1. 逐个 token 跑 `funds-flow-invariants-suite.ts`
2. 不要求单次 combined run 串完全部 token
3. 以“逐个资产可独立跑通”为本地验收口径

这一阶段如果已经暴露出：

1. 角色缺失
2. 脚本前置状态不成立
3. 订单选择逻辑不稳定
4. mock 资产余额或 signer 复用有问题

那就先修本地或 fork，不要直接推进到真链。

### 第 2 步：再在 live 链上跑核心内容

这一步才是 Arbitrum Sepolia live 的标准主线，但它的定位应该是“核心内容 live 验证”，不是“全目录全量回归”。

推荐顺序：

1. 真链 dry-run
2. live asset precheck
3. live preflight
4. 标准 mock-suite live 主入口

推荐命令骨架：

```bash
set -a && source .env && set +a

pnpm -s run test:live:dryrun:arbitrum-sepolia

pnpm -s exec hardhat run scripts/tests/live-test/live-asset-precheck-arbitrum-sepolia.ts --network arbitrumSepolia

pnpm -s exec hardhat run scripts/tests/live-test/live-preflight-arbitrum-sepolia.ts --network arbitrumSepolia

DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
LIVE_USE_MOCK_ASSET_PACK=1 \
LIVE_PRICE_MODE=bootstrap \
pnpm -s run e2e:pre-release:arbitrum-sepolia-live
```

这一步回答的是：

1. 当前 mock-suite live 主线是不是能真实跑通
2. 当前 settlement / collateral 选择是不是对齐到 `mUSDC + RWAGOLD`
3. 当前 Registry、price publish、whitelist、view/cache/readiness 是否足够支持核心 smoke

但这一步不应该被理解成：

1. 已经把 [scripts/tests/live-test](scripts/tests/live-test) 目录全部跑完
2. 已经把 liquidation / reward 全部分支都验收完
3. 已经覆盖全部专项 gate

当前最准确口径就是：这一步是“live 链上跑核心内容”。

### 第 3 步：最后再把专项脚本全部跑通

只有在前两步都稳定后，才进入这一阶段。

这一步的目标才是专项补齐，也就是把目录里那些不会被标准 live 主入口自动覆盖的脚本逐步补完。

推荐先从高风险专项开始：

1. 统一 release gates
2. blocks-only closeout
3. reward 总入口
4. guarantee 总入口 / facade / registry routes / consistency 专项

建议顺序：

```bash
set -a && source .env && set +a

ALLOW_LIQUIDATION_MANAGER_PAUSE=1 \
ALLOW_DYNAMIC_FEE_WRITE=1 \
pnpm -s run test:live:release-gates:arbitrum-sepolia

pnpm -s exec hardhat run scripts/tests/live-test/networks/arbitrum-sepolia/live-blocks-only-liquidation.ts --network arbitrumSepolia

pnpm -s run test:live:reward-baseline:arbitrum-sepolia

pnpm -s run test:live:guarantee-baseline:arbitrum-sepolia
```

继续补齐时，按失败点单独回放对应脚本，不要每次都重跑全集。

例如：

```bash
pnpm -s exec hardhat run scripts/tests/live-test/live-liquidation-fallback-arbitrum-sepolia.ts --network arbitrumSepolia

pnpm -s exec hardhat run scripts/tests/live-test/live-fee-dynamic-gate-arbitrum-sepolia.ts --network arbitrumSepolia

pnpm -s exec hardhat run scripts/tests/live-test/live-view-reward-loanflow-boundary-arbitrum-sepolia.ts --network arbitrumSepolia
```

所以整个执行顺序的唯一推荐主线现在应该记成：

1. 第一步，本地先跑通
2. 第二步，live 链上跑核心内容
3. 第三步，再把全部专项逐步跑通

当前这套 live-test 的口径也要按这个三分法理解：

1. 第一步解决“脚本和主链路本身能不能写”
2. 第二步解决“真实链上核心主线能不能过”
3. 第三步才解决“目录内专项是否逐项补齐”

---

## 12. 与 RWA live/mock 总纲的关系

这份 runbook 只回答“怎么执行”。

如果你当前的问题是：

1. RWA 价格为什么要先从 Google Finance 采集
2. 为什么链上仍然通过 PriceOracle / PriceUpdater 写价
3. 多稳定币借款和 RWA 抵押为什么不会把估值系统拆成多份
4. live mock 阶段和测试网上线阶段为什么不能继续共用 defaultPriceValue
5. 后端 price job 与缓存 read model 应该怎么配合

请以 [RWA-Price-System-Guide.md](../RWA-Price-System-Guide.md) 为 SSOT。

当前 runbook 的价格 seed 步骤应理解为：

1. bootstrap 启动工具
2. 人工应急补价工具

而不是完整的长期价格系统。

在后续统一链路下，正常价格路径应收敛为：

1. 链下价格采集
2. 按目标资产 `assetDecimals` 归一化成链上价格
3. 统一调用 `PriceUpdater.updateAssetPrice`
4. 统一由 `PriceOracle` 存储
5. preflight 与消费方同时检查链上最终价和链下发布状态

默认读取：

1. `deployments/mock-assets.arbitrum-sepolia.json`
2. 当前 `REGISTRY_ADDRESS`；如果未显式提供，则回退到默认 deploy output

作用：

1. 从 mock 资产部署结果里读取每个资产的 `bootstrapPriceValue`
2. 给 deployer 自动补 `UPDATE_PRICE`（仅当 deployer 同时是 ACM owner 且设置了 `AUTO_GRANT_UPDATE_PRICE=1`）
3. 默认通过 `PriceUpdater.updateAssetPrice` 发布全部 mock 资产 bootstrap 价格
4. 仅在 `SEED_ALLOW_DIRECT_PRICE_ORACLE=1` 时，使用 `PriceOracle.updatePrice` 作为 break-glass 回退

如果你想显式指定文件或 registry，可以这样：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
REGISTRY_ADDRESS="<registry>" \
MOCK_ASSET_PACK_OUTPUT="deployments/mock-assets.arbitrum-sepolia.json" \
AUTO_GRANT_UPDATE_PRICE=1 \
pnpm -s run seed:mock-asset-prices:arbitrum-sepolia
```

---

## 13. 补充：live 检查详解

先做只读 precheck：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
ASSETS_FILE="deployments/assets.arbitrum-sepolia.mock.json" \
SETTLEMENT_TOKEN_ADDRESS="<mUSDC_address>" \
SETTLEMENT_TOKEN_DECIMALS=6 \
pnpm -s exec hardhat run scripts/tests/live-test/live-asset-precheck-arbitrum-sepolia.ts --network arbitrumSepolia
```

你应该重点看：

1. `SelectedSettlementToken` 是否和 `CurrentSettlementToken` 对齐
2. `PriceUpdater` 是否有地址，`UpdaterConfigured=true` 是否成立
3. `PublishRoute` 是否是 `PriceUpdater.updateAssetPrice`
4. `LivePriceMode` 是否符合当前目标：`bootstrap` 允许缺价时自动补 bootstrap 价，`backend-required` 则要求链上最终价已先到位
5. `AllowDirectPriceOracle` 是否只是你明确开启 break-glass 时才为 `true`
6. `ViewerHasUpdatePriceRole`、`AutoGrantUpdatePrice` 是否满足你后续 write-mode 预期
7. settlement / borrow / collateral 三段里是否都有 `whitelist=true`、`feeSupported=true`、`cfgActive=true`，且在 `backend-required` 模式下 borrow/collateral 必须 `oracleReadable=true`

precheck 末尾的结论口径改成这样理解：

1. `[Ready] Unified live price publish path is available through PriceUpdater.updateAssetPrice.` 表示正常发布链路可用
2. `[Warning] PriceUpdater is not available. Live warmup would fall back to PriceOracle.updatePrice.` 表示你现在处在 break-glass 模式，不应把它当长期方案
3. `[Blocker] PriceUpdater is not available and ALLOW_DIRECT_PRICE_ORACLE is not enabled.` 表示 write-mode warmup 不应该继续
4. `[Warning] Current relayer does not have UPDATE_PRICE.` 表示你要么先授予角色，要么确认当前运行身份具备 ACM owner 并设置 `AUTO_GRANT_UPDATE_PRICE=1`
5. `[Warning] Missing on-chain final price ... bootstrap mode allows warmup to auto-publish from bootstrap hints.` 表示当前仍可做 live-mock 启动，但不应把这当成 launch-ready 结果
6. `[Blocker] Missing on-chain final price ... backend-required mode will fail warmup until backend publish succeeds.` 表示当前应先让 backend collector/writer 完成发布，再继续 write-mode

当前 live warmup 的模式开关：

```bash
LIVE_PRICE_MODE=bootstrap
LIVE_PRICE_MODE=backend-required
```

## 14. 标准复现实验入口

这一组入口专门用于复现同一个阻断语义：

1. 链上缺少最终价
2. 当前模式是 `LIVE_PRICE_MODE=backend-required`
3. warmup 不允许再自动从 `bootstrapPriceValue` 补价
4. 预期失败文案固定为：

```text
Missing on-chain final price for <symbol>. LIVE_PRICE_MODE=backend-required blocks automatic bootstrap publication.
```

### 14.1 localhost fresh-state demo

用途：

1. 在一条全新 localhost 链上，完整拉起部署、角色、mock asset pack 和阻断态准备
2. 适合做最小可重复演示，不依赖远程 RPC

入口：

```bash
pnpm -s run demo:backend-required:block:localhost
```

可选覆盖：

```bash
COLLATERAL_SYMBOL=RWAGOLD \
BLOCK_DEMO_NODE_PORT=19545 \
pnpm -s run demo:backend-required:block:localhost
```

执行内容：

1. 自动启动一条独立 localhost 节点
2. 执行 `deploy:localhost`
3. 执行 `grant-required-roles-local.ts`
4. 执行 `deploy-mock-asset-pack.ts`
5. 执行 `prepare-backend-required-block-local.ts`
6. 以 `LIVE_PRICE_MODE=backend-required` 运行 live warmup，并断言它因缺最终价而失败

日志输出目录：

1. `scripts/tests/logs/backend-required-block-<timestamp>/`

重点日志：

1. `05-live-warmup-backend-required.log`

### 14.2 Arbitrum Sepolia fork demo

用途：

1. 把同一阻断语义放到 Arbitrum Sepolia fork 上验证
2. 对齐 live/mock 真实资产选择逻辑，同时避免直接在远程链上做写入实验

前置：

1. 设置 `ARBITRUM_SEPOLIA_RPC_URL` 或 `ARBITRUM_SEPOLIA_URL`

入口：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
pnpm -s run demo:backend-required:block:fork
```

可选覆盖：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
HARDHAT_FORK_BLOCK_NUMBER=<pinned_block> \
COLLATERAL_SYMBOL=RWAGOLD \
BLOCK_DEMO_FORK_NODE_PORT=19546 \
pnpm -s run demo:backend-required:block:fork
```

执行内容：

1. 自动启动 Arbitrum Sepolia fork 节点
2. 在 fork 上执行 `deploy:localhost`
3. 执行 `grant-required-roles-local.ts`
4. 执行 `deploy-mock-asset-pack.ts`
5. 执行 `prepare-backend-required-block-local.ts`
6. 以 `LIVE_PRICE_MODE=backend-required` 运行 live warmup，并断言它因缺最终价而失败

日志输出目录：

1. `scripts/tests/logs/backend-required-block-fork-<timestamp>/`

重点日志：

1. `fork-node.log`
2. `05-live-warmup-backend-required.log`

### 14.3 这组实验的使用边界

这两套 demo 都是“阻断复现”，不是“放行验收”。

判断标准：

1. 如果脚本最终成功退出，表示它成功复现并断言了阻断
2. 如果 warmup 直接成功，说明当前环境已经有最终价或准备脚本没有进入预期缺价态，这应被视为 demo 失败
3. 如果 warmup 失败，但失败文案不是固定的 missing-final-price blocker，也应被视为 demo 失败

### 14.4 live mock-suite 的真实对齐说明

当前 `e2e:pre-release:arbitrum-sepolia-live` 在 mock-suite 场景下会自动做两件事：

1. 当 `DEPLOY_OUTPUT_FILE` 命名中包含 `mock`，或显式设置 `LIVE_USE_MOCK_ASSET_PACK=1` 时，自动注入：
  - `ASSETS_FILE=deployments/assets.arbitrum-sepolia.mock.json`
  - `MOCK_ASSET_PACK_OUTPUT=deployments/mock-assets.arbitrum-sepolia.json`
  - `SETTLEMENT_TOKEN_ADDRESS=<mock-pack settlementToken>`
  - `SETTLEMENT_TOKEN_DECIMALS=<mock-pack settlement decimals>`
2. 在这种 mock-suite 场景下，如果没有显式指定 `FRESH_DEPLOY=1`，默认补 `LIVE_SKIP_DEPLOY=1`，先复验当前 mock-suite deploy output 和链上 Registry / 核心模块是否可读，再继续跑 live preflight 和 live-safe smoke

也就是说当前默认行为已经改成：

1. mock-suite 标准入口优先复验已有实例，不强制 fresh deploy
2. 只有你显式传 `FRESH_DEPLOY=1` 时，才会真正重新部署一套新合约
3. 如果你只是想复验已有 mock-suite，这样可以避免因为 deployer 原生 ETH 不足而把 pre-release 主入口直接卡死

这意味着 live gate 里的 settlement token 对齐现在是“真实重绑 + 校验”，而不是仅仅把 warning 静音。

#### 按当前 .env 的只读核对结果

当前根目录 `.env` 里，和资产选择直接相关、且已显式设置的只有：

1. `COLLATERAL_SYMBOL=RWAGOLD`
2. `LIQUIDATION_ORDER_ID=17`

当前 `.env` 没有显式覆盖以下资产选择变量：

1. `SETTLEMENT_TOKEN_ADDRESS`
2. `ASSETS_FILE`
3. `MOCK_ASSET_PACK_OUTPUT`
4. `DEPLOY_OUTPUT_FILE`
5. `LIVE_USE_MOCK_ASSET_PACK`
6. `BORROW_SYMBOL`
7. `BORROW_ASSET_ADDRESS`
8. `COLLATERAL_ASSET_ADDRESS`

这意味着按你当前 `.env` 单独看：

1. collateral 会明确选到 `RWAGOLD`
2. settlement 不会被 `.env` 改写，仍取当前所选 mock asset pack 的 `settlementToken`
3. 在 Arbitrum Sepolia mock-suite 线上，这个 `settlementToken` 默认就是 `deployments/mock-assets.arbitrum-sepolia.json` 里的 `mUSDC`

因此，只要本次执行明确落在 Arbitrum Sepolia mock-suite 线，最终选中的资产组合就是：

1. collateral = `RWAGOLD`
2. settlement = `mUSDC`

这个核对过程只依赖 `.env` 中是否存在相关变量，不需要回显私钥。

#### Arbitrum Sepolia mock-suite live 标准命令

推荐把下面这条命令作为标准入口：

```bash
set -a && source .env && set +a && \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
LIVE_USE_MOCK_ASSET_PACK=1 \
LIVE_SKIP_DEPLOY=1 \
LIVE_PRICE_MODE=bootstrap \
pnpm -s run e2e:pre-release:arbitrum-sepolia-live
```

这条命令的目的很明确：

1. 先从根目录 `.env` 读取 RPC、私钥和 `LIQUIDATION_ORDER_ID` 等运行参数
2. 用 `DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json"` 强制走 mock-suite 这条部署输出线
3. 用 `LIVE_USE_MOCK_ASSET_PACK=1` 明确要求 live 流程自动绑定：
  - `deployments/assets.arbitrum-sepolia.mock.json`
  - `deployments/mock-assets.arbitrum-sepolia.json`
  - mock pack 里的 settlement token 和 decimals
4. 用 `LIVE_SKIP_DEPLOY=1` 明确告诉主入口：当前目标是复验已有 mock-suite，而不是 fresh redeploy
5. 用 `LIVE_PRICE_MODE=bootstrap` 把当前目标固定为“先跑通真实 RWA token 流程”，而不是先卡在 backend-required 缺最终价上

在这条标准命令下，如果你继续保持当前 `.env`：

1. collateral 会落到 `RWAGOLD`
2. settlement 会落到 `mUSDC`
3. 不需要手动再写一遍 `ASSETS_FILE`、`MOCK_ASSET_PACK_OUTPUT`、`SETTLEMENT_TOKEN_ADDRESS`、`SETTLEMENT_TOKEN_DECIMALS`

如果你后面要做的是“只重跑 live gate，不重新走整套 pre-release 编排”，再单独使用 `test:live:release-gates:arbitrum-sepolia`。但当前推荐仍然是以上面这条 `e2e:pre-release:arbitrum-sepolia-live` 作为 mock-suite live 标准入口，因为它更不容易把 Registry、assets file 和 settlement token 跑偏。

#### 2026-03-22 标准测试命令

按当前 runbook，Arbitrum Sepolia mock-suite 建议固定用下面 5 步：

```bash
set -a && source .env && set +a && \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
LIVE_USE_MOCK_ASSET_PACK=1 \
LIVE_PRICE_MODE=bootstrap \
MOCK_ASSET_PACK_OUTPUT="deployments/mock-assets.arbitrum-sepolia.json" \
ASSETS_FILE="deployments/assets.arbitrum-sepolia.mock.json" \
REGISTRY_ADDRESS="$(node -e 'process.stdout.write(require("./scripts/deployments/arbitrum-sepolia.mock-suite.json").Registry)')" \
SETTLEMENT_TOKEN_ADDRESS="$(node -e 'process.stdout.write(require("./deployments/mock-assets.arbitrum-sepolia.json").settlementToken)')" \
SETTLEMENT_TOKEN_DECIMALS="$(node -e 'const m=require("./deployments/mock-assets.arbitrum-sepolia.json"); process.stdout.write(String(m.settlementTokenDecimals ?? m.settlementTokenMeta?.decimals ?? 6))')" \
pnpm -s run test:live:dryrun:arbitrum-sepolia

set -a && source .env && set +a && \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
LIVE_USE_MOCK_ASSET_PACK=1 \
LIVE_PRICE_MODE=bootstrap \
MOCK_ASSET_PACK_OUTPUT="deployments/mock-assets.arbitrum-sepolia.json" \
ASSETS_FILE="deployments/assets.arbitrum-sepolia.mock.json" \
REGISTRY_ADDRESS="$(node -e 'process.stdout.write(require("./scripts/deployments/arbitrum-sepolia.mock-suite.json").Registry)')" \
SETTLEMENT_TOKEN_ADDRESS="$(node -e 'process.stdout.write(require("./deployments/mock-assets.arbitrum-sepolia.json").settlementToken)')" \
SETTLEMENT_TOKEN_DECIMALS="$(node -e 'const m=require("./deployments/mock-assets.arbitrum-sepolia.json"); process.stdout.write(String(m.settlementTokenDecimals ?? m.settlementTokenMeta?.decimals ?? 6))')" \
pnpm -s exec hardhat run scripts/tests/live-test/live-asset-precheck-arbitrum-sepolia.ts --network arbitrumSepolia

set -a && source .env && set +a && \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
LIVE_USE_MOCK_ASSET_PACK=1 \
LIVE_PRICE_MODE=bootstrap \
MOCK_ASSET_PACK_OUTPUT="deployments/mock-assets.arbitrum-sepolia.json" \
ASSETS_FILE="deployments/assets.arbitrum-sepolia.mock.json" \
REGISTRY_ADDRESS="$(node -e 'process.stdout.write(require("./scripts/deployments/arbitrum-sepolia.mock-suite.json").Registry)')" \
SETTLEMENT_TOKEN_ADDRESS="$(node -e 'process.stdout.write(require("./deployments/mock-assets.arbitrum-sepolia.json").settlementToken)')" \
SETTLEMENT_TOKEN_DECIMALS="$(node -e 'const m=require("./deployments/mock-assets.arbitrum-sepolia.json"); process.stdout.write(String(m.settlementTokenDecimals ?? m.settlementTokenMeta?.decimals ?? 6))')" \
pnpm -s exec hardhat run scripts/tests/live-test/live-preflight-arbitrum-sepolia.ts --network arbitrumSepolia

set -a && source .env && set +a && \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
LIVE_USE_MOCK_ASSET_PACK=1 \
LIVE_SKIP_DEPLOY=1 \
LIVE_PRICE_MODE=bootstrap \
pnpm -s run e2e:pre-release:arbitrum-sepolia-live

set -a && source .env && set +a && \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
LIVE_USE_MOCK_ASSET_PACK=1 \
LIVE_PRICE_MODE=bootstrap \
MOCK_ASSET_PACK_OUTPUT="deployments/mock-assets.arbitrum-sepolia.json" \
ASSETS_FILE="deployments/assets.arbitrum-sepolia.mock.json" \
REGISTRY_ADDRESS="$(node -e 'process.stdout.write(require("./scripts/deployments/arbitrum-sepolia.mock-suite.json").Registry)')" \
SETTLEMENT_TOKEN_ADDRESS="$(node -e 'process.stdout.write(require("./deployments/mock-assets.arbitrum-sepolia.json").settlementToken)')" \
SETTLEMENT_TOKEN_DECIMALS="$(node -e 'const m=require("./deployments/mock-assets.arbitrum-sepolia.json"); process.stdout.write(String(m.settlementTokenDecimals ?? m.settlementTokenMeta?.decimals ?? 6))')" \
ALLOW_LIQUIDATION_MANAGER_PAUSE=1 \
ALLOW_DYNAMIC_FEE_WRITE=1 \
pnpm -s run test:live:release-gates:arbitrum-sepolia
```

如果你确实要 fresh redeploy，而不是复验已有实例，再显式改成：

```bash
set -a && source .env && set +a && \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
LIVE_USE_MOCK_ASSET_PACK=1 \
FRESH_DEPLOY=1 \
LIVE_PRICE_MODE=bootstrap \
pnpm -s run e2e:pre-release:arbitrum-sepolia-live
```

#### 当前 mock-suite live 角色基线

对于当前健康实例 `Registry=0xaE0455077051c9ca532D4B63DD9B35BafAA1B352`，2026-03-21 实测通过的角色基线如下：

1. `SettlementManager` 的 repay 侧当前不再依赖 `ActionKeys.ACTION_REPAY`；若执行 keeper 触发的 `settleOrLiquidate`，仍需 `ActionKeys.ACTION_LIQUIDATE`，并按调用链补齐 `ActionKeys.ACTION_VIEW_RISK_DATA` / 其他必要只读角色。
2. `BlocksOnlyCoordinator` 必须有 `ActionKeys.ACTION_LIQUIDATE`、`ActionKeys.ACTION_VIEW_RISK_DATA`
3. `LiquidationManager` 必须有 `ActionKeys.ACTION_LIQUIDATE`、`ActionKeys.ACTION_DEPOSIT`
4. `GuaranteeFundManager` 必须有 `ActionKeys.ACTION_DEPOSIT`
5. `VaultBusinessLogic` 必须有 `ActionKeys.ACTION_ORDER_CREATE`、`ActionKeys.ACTION_DEPOSIT`
6. `LendingEngine` 必须有 `ActionKeys.ACTION_BORROW`
7. 当前用于 live 脚本的 relayer `0x381fE833cceac267AB0e41d17373D9e16e7118a7` 还需要有 `ActionKeys.ACTION_LIQUIDATE`、`ActionKeys.ACTION_DEPOSIT`
8. 如果 full-live / release-gates 里出现 seed liquidatable order、keeper settle 或 liquidation fallback 相关失败，先检查运行脚本的 relayer 是否真的具备 `ActionKeys.ACTION_LIQUIDATE`；不要只看模块角色完整就默认外部 keeper/relayer 也已经有权限

推荐用下面这条命令做一次只读审计：

```bash
REGISTRY_ADDRESS="0xaE0455077051c9ca532D4B63DD9B35BafAA1B352" \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
pnpm -s exec hardhat run scripts/debug/audit-live-sepolia-runtime.ts --network arbitrumSepolia
```

如果审计输出里 relayer 或 `GuaranteeFundManager` 仍缺角色，再把 `APPLY=1` 加上让 ACM owner 直接补齐：

```bash
APPLY=1 \
REGISTRY_ADDRESS="0xaE0455077051c9ca532D4B63DD9B35BafAA1B352" \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
pnpm -s exec hardhat run scripts/debug/audit-live-sepolia-runtime.ts --network arbitrumSepolia
```

#### 如果 finalizeMatch 被 active guarantee 卡住

当前 mock-suite live 已经验证过一种真实链上污染：

1. borrower 在同一个 borrow asset 上已经有 active guarantee
2. 这时 `finalizeMatch` 不是 ABI 漂移，也不是 selector 错配，而是会命中 `GuaranteeAlreadyProcessed()`
3. 共享脚本现在会直接把它报成 active guarantee，不再显示 `Unknown selector: 0xd609fb20`

标准排查命令：

```bash
REGISTRY_ADDRESS="0xaE0455077051c9ca532D4B63DD9B35BafAA1B352" \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
pnpm -s exec hardhat run scripts/debug/resolve-live-guarantee.ts --network arbitrumSepolia
```

这条命令会打印：

1. borrower 当前 debt asset 列表
2. active guarantee 的 `guaranteeId`、`locked`、`principal`、`maturityTime`
3. 候选 order 列表，以及脚本自动选中的 `ChosenOrder`

如果输出已经明确选中了正确的 order，可以直接用 repay 模式清理这条污染状态：

```bash
GUARANTEE_RESOLVE_MODE=repay \
REGISTRY_ADDRESS="0xaE0455077051c9ca532D4B63DD9B35BafAA1B352" \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
pnpm -s exec hardhat run scripts/debug/resolve-live-guarantee.ts --network arbitrumSepolia
```

2026-03-21 在健康实例上的实测结果是：

1. active guarantee `guaranteeId=1`
2. 对应 `orderId=0`
3. 执行 `GUARANTEE_RESOLVE_MODE=repay` 后，`After.activeGuarantee=false`、`After.guaranteeId=0`、`After.locked=0`、`After.debtAssets=<none>`、`After.debtAmount=0`

因此，如果后面再遇到 finalize 相关 live 脚本被 active guarantee 卡住，先不要重部署，也不要先怀疑 ABI；优先按这条排查/清理路径处理。

### 14.5 测试网想跑真实 RWA token，应该选哪条 settlement token 线

先把两条线分清楚：

1. live stack 线：Registry 来自 `scripts/deployments/arbitrum-sepolia.json`，settlement token 是当前实例绑定的外部 USDC 类地址
2. mock-suite 线：Registry 来自 `scripts/deployments/arbitrum-sepolia.mock-suite.json`，settlement token 是你这次 mock-suite fresh deploy 时一并部署并绑定的 mock settlement token

如果你的目标是“测试网阶段先把真实 RWA token 合约、真实价格发布流程、真实资金流 gate 跑起来”，当前更接近这个目标的是 mock-suite 线。

原因：

1. 你可以把整套 RWA token 和 settlement token 一起部署、一起写入资产包、一起做 whitelist / oracle / fee / updater 对齐，环境是一致的
2. 你能稳定复现 `deposit -> finalizeMatch -> liquidation / fee gate`，不会反复被外部测试币余额、外部 token 权限或旧实例漂移打断
3. 对“RWA token 本身能不能在测试网真实跑起来”这个问题，决定性因素是资产包、价格发布、白名单、FeeRouter、清算链路，而不是 settlement token 一定得先换成外部 USDC

但这条线的边界也要写清楚：

1. 它更接近“完整可控的 RWA 测试环境”
2. 它不等于“最接近生产 settlement 条件”，因为结算币仍是 mock settlement token

如果你的目标改成“优先验证外部 USDC 类 settlement token 的兼容性、资金准备方式和运营约束”，那才更应该选 live stack 线。

当前推荐口径：

1. 第一阶段，优先用 mock-suite 线把真实 RWA token 流程跑通
2. 第二阶段，再把同一批 live gates 收敛到 live stack 线，补做外部 settlement token 兼容性验证

语义：

1. `bootstrap`：borrow/collateral 没有链上最终价时，允许脚本按 `bootstrapPriceValue` 自动补价�值语义按资产 `assetDecimals` 解释）
2. `backend-required`：borrow/collateral 没有链上最终价时直接 fail，不允许自动补 bootstrap 价
3. `FORCE_PRICE_UPDATE=1` 仍然保留人工强制覆盖能力，属于显式操作，不是默认自动补价

再做 ignition dry-run：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
ASSETS_FILE="deployments/assets.arbitrum-sepolia.mock.json" \
SETTLEMENT_TOKEN_ADDRESS="<mUSDC_address>" \
SETTLEMENT_TOKEN_DECIMALS=6 \
ALLOW_SINGLE_PARTY=0 \
BORROW_AMOUNT_UNITS=1200 \
```

如果 dry-run 没问题，再执行真实最小点火。这里先把成功所需因素写清楚：

1. `BORROWER_PRIVATE_KEY` 和 `LENDER_PRIVATE_KEY` 必须是两个不同地址。当前链上实测表明，即使脚本层设置了 `ALLOW_SINGLE_PARTY=1`，同地址 borrower/lender 仍然会在 `finalizeMatch` 阶段失败。
2. lender 地址必须同时有两样东西：
  - 足够支付 gas 的 Arbitrum Sepolia ETH
  - 足够的 mock `mUSDC` 用于 `reserveForLending`
3. `VIEWER_ADDRESS` 最好指向有 `ActionKeys.ACTION_VIEW_SYSTEM_DATA` / `ActionKeys.ACTION_VIEW_USER_DATA` / `ActionKeys.ACTION_VIEW_PRICE_DATA` 的 deployer/ops 地址，否则 preflight 里的部分 view 读数可能不是协议真实状态，而是权限导致的假冷。
4. 不要把所有 read 都机械地绑定到 `VIEWER_ADDRESS`。当前 live 脚本里，用户维度的 facade/read 适合用 viewer 身份，但 `ValuationOracleView.getAssetPrice(...)` 这类系统价读如果 isolated call 能过、脚本里却直接 revert，优先检查 read caller 选型是否错误；实测应优先用 relayer/ops signer，而不是把 valuation path 也强绑到 viewer。
5. 如果目标是验证 `RewardView` 的 borrower 缓存真的被写热，`BORROW_AMOUNT_UNITS` 不能低于 `1000`。当前实现里 `RewardManagerCore` 对 `< 1000e6` 的借款会直接跳过 reward lock / earn-state 处理。
6. `RewardView` 的“lender 奖励”不要拿出资 EOA 直接判断。当前订单里的 `order.lender` 是 `LenderPoolVault`，不是出资 EOA，本次脚本里 lender EOA 的 reward 读数保持冷并不代表 Reward 主链路失败。

已验证可跑通并且能写热 borrower `RewardView` 的真实参数是：

1. `REGISTRY_ADDRESS=0xAae35E1D828f2531038e75684dd6A0a133125dDC`
2. `SETTLEMENT_TOKEN_ADDRESS=0x2767e0d87d9889Aeb447A3851aA455A51Bf67035`
3. `COLLATERAL_SYMBOL=RWAGOLD`
4. `VIEWER_ADDRESS=0x381fE833cceac267AB0e41d17373D9e16e7118a7`
5. `COLLATERAL_AMOUNT_UNITS=10`
6. `BORROW_AMOUNT_UNITS=1200`
7. `TERM_DAYS=5`
8. `RATE_BPS=1000`

对应命令示例：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
BORROWER_PRIVATE_KEY="<borrower_private_key>" \
LENDER_PRIVATE_KEY="<lender_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<mUSDC_address>" \
SETTLEMENT_TOKEN_DECIMALS=6 \
SETTLEMENT_TOKEN_SOURCE_ID="mock-usdc" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
ENABLE_WRITE=1 \
ALLOW_SINGLE_PARTY=0 \
COLLATERAL_AMOUNT_UNITS=10 \
BORROW_AMOUNT_UNITS=1200 \
TERM_DAYS=5 \
RATE_BPS=1000 \
pnpm -s exec hardhat run scripts/tests/live-test/live-warmup-arbitrum-sepolia.ts --network arbitrumSepolia
```

当前已验证通过的一组实参是：

1. `REGISTRY_ADDRESS=0xAae35E1D828f2531038e75684dd6A0a133125dDC`
2. `SETTLEMENT_TOKEN_ADDRESS=0x2767e0d87d9889Aeb447A3851aA455A51Bf67035`
3. `COLLATERAL_SYMBOL=RWAGOLD`
4. borrower / lender 为两个不同地址
5. `BORROW_AMOUNT_UNITS >= 1000`
6. 默认 `live-warmup-arbitrum-sepolia.ts` 现在会在借还链路成功后继续执行一次显式 `ViewCache` prime；如需只跑借还主链路，可加 `PRIME_VIEW_CACHE=0`。

### 上线前 `.env` 配置表

下面这张表按“每次重部署后应该重新确认”和“通常可以跨部署复用”两组来整理，避免把临时可用值误当成永久固定值。

#### 1. 部署后必变

这些变量和“这一次部署出来的实例”强相关。只要你重部署、切换 Registry、切换 mock asset pack、或者改用另一组测试资产，就应该重新确认。

| 变量 | 是否建议显式写入 `.env` | 什么时候必须更新 | 用途 |
|---|---|---|---|
| `REGISTRY_ADDRESS` | 建议 | 每次重部署后 | live 脚本和 preflight 的根入口，所有模块都从这里解析 |
| `SETTLEMENT_TOKEN_ADDRESS` | 建议 | mock-suite 重新部署后 settlement token 变了 | 指定本次资金链使用的结算资产 |
| `LIQUIDATION_ORDER_ID` | 建议 | 切换实例、重建 Registry、或更换待清算订单时 | 非本地 liquidation / fallback gate 使用的 overdue 真实订单 id；写到 `.env` 时必须是纯数字，例如 `17` |
| `LIQUIDATION_SEARCH_CHUNK_BLOCKS` | 建议 | 切换 RPC 提供商，或直跑 liquidation / full-live 回归时 | liquidation 脚本扫描 `LoanOrderCreated` 日志时的单次区块窗口；Arbitrum Sepolia 免费档 RPC 建议固定为 `9`，避免 `eth_getLogs` block range 限额 |
| `COLLATERAL_ASSET_ADDRESS` | 可选 | 改用另一种抵押资产时 | 直接按地址指定 collateral |
| `COLLATERAL_SYMBOL` | 可选 | 改用另一种抵押资产时 | 按 symbol 选择 collateral；和上一项二选一即可 |
| `COLLATERAL_SOURCE_ID` | 可选 | 按 sourceId 选资产时 | 备用资产选择方式 |
| `COLLATERAL_COINGECKO_ID` | 兼容旧名 | 仅旧脚本/旧命令 | 向后兼容别名 |
| `MOCK_ASSET_PACK_OUTPUT` | 可选 | 切换 mock asset pack 文件时 | 指向新的 mock asset pack JSON |
| `SETTLEMENT_PRICE_VALUE` | 可选 | 需要覆盖默认价格 seed 时 | 覆盖 settlement 的价格提示 |
| `COLLATERAL_PRICE_VALUE` | 可选 | 需要覆盖默认价格 seed 时 | 覆盖 collateral 的价格提示 |
| `ALLOW_DIRECT_PRICE_ORACLE` | 仅 break-glass 时 | live warmup 需要绕过 updater 时 | 允许 `_mockLiveIgnition.ts` 直接写 `PriceOracle.updatePrice` |
| `SEED_ALLOW_DIRECT_PRICE_ORACLE` | 仅 break-glass 时 | seed 脚本需要绕过 updater 时 | 允许 `seed-mock-asset-prices.ts` 直接写 `PriceOracle.updatePrice` |
| `AUTO_GRANT_UPDATE_PRICE` | 按需 | 当前 relayer/deployer 缺 `UPDATE_PRICE`，且它同时是 ACM owner 时 | 自动补 `UPDATE_PRICE` 角色 |
| `DEPLOY_OUTPUT_FILE` | 部署时建议 | 切换新的 deploy output 文件时 | 决定部署脚本写哪份输出 |
| `FRESH_DEPLOY` | 部署时按需 | 需要强制全新部署时 | 避免复用旧 deploy output |
| `PAYOUT_PLATFORM_ADDR` | 按需 | payout 接收地址变更时 | 清算/平台收益接收方 |
| `PAYOUT_RESERVE_ADDR` | 按需 | payout 接收地址变更时 | reserve 接收方 |
| `PAYOUT_LENDER_ADDR` | 按需 | payout 接收地址变更时 | lender compensation 接收方 |

#### 2. 通常可复用

这些变量更像“操作钱包 / 运行身份 / 流程开关”。如果你继续沿用同一批测试网钱包和同一套操作方式，通常不需要因为合约重部署自动改掉。

这些钱包变量的标准存放位置就是仓库根目录本地 `.env`。runbook 里的内联 `VAR=... command` 只是演示写法，不是要求把私钥明文重复敲进命令行历史。

| 变量 | 通常是否可复用 | 什么时候需要改 | 用途 |
|---|---|---|---|
| `ARBITRUM_SEPOLIA_RPC_URL` | 是 | 换 RPC 提供商时 | 连接测试网 |
| `PRIVATE_KEY` | 是 | 换 deployer/relayer/ops 钱包时 | 默认 signer，很多写操作都走它 |
| `BORROWER_PRIVATE_KEY` | 是 | 换 borrower 钱包时 | warmup 中 borrower 身份 |
| `LENDER_PRIVATE_KEY` | 是 | 换 lender 钱包时 | warmup 中 lender 身份 |
| `VIEWER_ADDRESS` | 通常是 | 换 viewer/ops 钱包，或该地址不再有读权限时 | 用哪个地址身份去读带权限的 view |
| `ENABLE_WRITE` | 是 | 切换 dry-run / write 模式时 | 是否真正发交易 |
| `ALLOW_SINGLE_PARTY` | 是 | 当前成功路径应固定为 `0` | 控制 borrower/lender 是否允许同地址 |
| `PRIME_VIEW_CACHE` | 是 | 想跳过或启用 ViewCache prime 时 | 完整 warmup 后是否继续显式 prime ViewCache |
| `BORROW_AMOUNT_UNITS` | 是 | 调整 warmup 档位时 | 当前若想验证 borrower `RewardView` 缓存，建议 `>= 1000`，实测用 `1200` |
| `COLLATERAL_AMOUNT_UNITS` | 是 | 调整 warmup 档位时 | 抵押量 |
| `MULTI_COLLATERAL_SYMBOLS` | 是 | 想顺序跑多种 RWA collateral 时 | 逗号分隔的抵押资产 symbol 列表，和 `MULTI_STABLECOIN_SYMBOLS` 做组合矩阵 |
| `TERM_DAYS` | 是 | 调整测试订单期限时 | borrow intent 参数 |
| `RATE_BPS` | 是 | 调整测试利率时 | borrow intent 参数 |
| `LIVE_PREFLIGHT_STRICT_ORACLE` | 是 | 想把 oracle 问题升级为 hard fail 时 | preflight 严格模式 |
| `LIVE_PREFLIGHT_STRICT_REWARD_CACHE` | 是 | 想把 RewardView 冷缓存升级为 hard fail 时 | preflight 严格模式 |
| `LIVE_PREFLIGHT_STRICT_VIEW_CACHE` | 是 | 想把 ViewCache 冷缓存升级为 hard fail 时 | preflight 严格模式 |
| `ARBISCAN_API_KEY` | 是 | 换账号时 | 部署验证辅助，不影响主流程 |

#### 3. 上线前推荐最小 `.env`

如果目标是“测试网上线前完成完整 warmup + preflight”，建议至少确认下面这些键：

```env
ARBITRUM_SEPOLIA_RPC_URL=...
PRIVATE_KEY=...
BORROWER_PRIVATE_KEY=...
LENDER_PRIVATE_KEY=...
REGISTRY_ADDRESS=...
SETTLEMENT_TOKEN_ADDRESS=...
LIQUIDATION_SEARCH_CHUNK_BLOCKS=9
COLLATERAL_SYMBOL=RWAGOLD
VIEWER_ADDRESS=...
ENABLE_WRITE=1
ALLOW_SINGLE_PARTY=0
BORROW_AMOUNT_UNITS=1200
PRIME_VIEW_CACHE=1
LIVE_PREFLIGHT_STRICT_VIEW_CACHE=1
AUTO_GRANT_UPDATE_PRICE=1
```

#### 4. 使用原则

1. 每次重部署后，先重新确认 `REGISTRY_ADDRESS`、`SETTLEMENT_TOKEN_ADDRESS`、抵押资产选择，不要默认沿用旧值。
2. 如果操作钱包没变，`PRIVATE_KEY`、`BORROWER_PRIVATE_KEY`、`LENDER_PRIVATE_KEY`、`VIEWER_ADDRESS` 通常可以复用；默认就保存在本地 `.env`，不要因为 runbook 示例用了内联 env 就误以为必须手工重填。
3. `VIEWER_ADDRESS` 不是部署产物地址，而是“读者身份地址”；只要该 EOA 在新部署后仍保有足够的 VIEW 权限，它就不需要因为重部署自动变更。
4. `BORROWER_PRIVATE_KEY` 和 `LENDER_PRIVATE_KEY` 必须对应两个不同地址，而且 `LENDER_PRIVATE_KEY` 对应钱包需要有少量 Arbitrum Sepolia ETH 用于 `approve` 与 `reserveForLending`。
5. 当你直接执行非 Hardhat 包裹的 shell/ts-node 步骤时，先在当前终端执行 `set -a && source .env && set +a`；否则脚本会表现成“私钥缺失”，但根因只是当前 shell 没加载本地 `.env`。

这一步已经在链上真实执行成功，完成了：

1. `VaultCore.deposit(collateralAsset, amount)`
2. `VaultBusinessLogic.reserveForLending(lenderSigner, settlementToken, amount, lendIntentHash)`
3. `VaultBusinessLogic.finalizeMatch(...)`
4. `VaultCore.repay(orderId, settlementToken, amount)`

注意：`scripts/deploy/deploy-arbitrum-sepolia.ts` 现在会自动补齐这条点火链路必需的角色，不需要再手工修：

1. `VaultBusinessLogic -> ORDER_CREATE`
2. `VaultBusinessLogic -> DEPOSIT`
3. `LendingEngine -> BORROW`

点火完成后建议立刻再跑一次 preflight：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<mUSDC_address>" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
pnpm -s exec hardhat run scripts/tests/live-test/live-preflight-arbitrum-sepolia.ts --network arbitrumSepolia
```

当前链上实测结论：

1. `PositionView`/订单创建/还款主链路已经打通。
2. borrower 的 `RewardView` 会在 `BORROW_AMOUNT_UNITS >= 1000` 的双地址成功路径上变热；`500 mUSDC` 这一档不会触发 reward lock / earn-state 写入。
3. `RewardDynamicParamsCache` 和 `RewardLevel1Cache` 仍然是冷的，这不是借还款失败，而是因为当前链路没有触发治理侧 `pushDynamicRewardParams` / `pushLevelMultiplier` writer。
4. `HealthView` 当前不会自动变热。根因不是业务路径失败，而是当前 live mock-suite Registry 上的 `LendingEngine` 没有 `ActionKeys.ACTION_VIEW_PUSH`，也没有 `ActionKeys.ACTION_VIEW_RISK_DATA`，因此 `LendingEngineCore._pushHealthStatus(...)` 的 best-effort 推送会被吞掉。
5. `ViewCache` 当前不会因为 `deposit -> reserve -> finalizeMatch -> repay` 自动变热。根因是当前借还款主链路没有调用 `ViewCache.setSystemStatus(...)`，所以它应被视为显式 prime / keeper 维护路径，而不是这条最小资金链的自动副产物。
6. 当前 runbook 对 `ViewCache` 的推荐做法是两段式：先跑双地址 1200 mUSDC warmup 写热 `RewardView/HealthView`，再跑内置或独立的 `ViewCache` prime，把 settlement leg 与 collateral leg 的系统快照显式写入缓存。
7. 当前 live mock-suite 还需要把 fee/view 修复的两条新结论纳入操作习惯：
  - `FeeRouter` 实配地址可能出现 `relayer == platformTreasury == ecosystemVault`。看到单地址净变化为 `0` 不代表 fee 没分出去，要以唯一地址集合守恒和 `FeeRouterView` 镜像为准。
  - 任何会创建 borrower 写链的新 live case，都应走共享的 sponsor-aware fresh borrower 逻辑，而不是默认复用 `.env` 里的 borrower。这样能同时避开残留 guarantee / debt 污染，以及 relayer 单点 gas 不足导致的随机失败。

本轮 Arbitrum Sepolia mock-assets 实测已确认：

1. `live-fee-accounting-arbitrum-sepolia.ts`
2. `live-fee-remaining-gate-arbitrum-sepolia.ts`
3. `live-fee-prepaid-gate-arbitrum-sepolia.ts`
4. `live-fee-dynamic-gate-arbitrum-sepolia.ts`
5. `live-view-consistency-gate-arbitrum-sepolia.ts`

都已经按上述约束修正并可通过，后续 runbook 执行时应把它们视为 fee/view 回归门禁，而不是可选 smoke。

```bash
set -a && source .env && set +a

REGISTRY_ADDRESS=0xAae35E1D828f2531038e75684dd6A0a133125dDC \
SETTLEMENT_TOKEN_ADDRESS=0x2767e0d87d9889Aeb447A3851aA455A51Bf67035 \
COLLATERAL_SYMBOL=RWAGOLD \
pnpm -s exec hardhat run scripts/tests/live-test/live-prime-viewcache-arbitrum-sepolia.ts --network arbitrumSepolia
```

### 四稳定币 warmup / preflight 示例

这里的四组命令是同一套 live mock-suite 下的四种 `borrowAsset` 模板，不要求你为每个稳定币重新部署一套实例。系统级 `SettlementToken` 仍保持当前实例自己的配置，但 warmup 的借贷链路会按 `BORROW_*` 环境变量切换到具体稳定币。

建议的 borrow 口径：

| Borrow symbol | `BORROW_SYMBOL` | `BORROW_SOURCE_ID` | `BORROW_ASSET_DECIMALS` | 默认价格口径 |
|---|---|---|---|---|
| mUSDC | `mUSDC` | `mock-usdc` | `6` | `1.0 USD` |
| mUSDT | `mUSDT` | `mock-usdt` | `6` | `1.0 USD` |
| mHKD | `mHKD` | `mock-hkd` | `18` | `0.128 USD` |
| mSGD | `mSGD` | `mock-sgd` | `18` | `0.74 USD` |

如果你的 `deployments/mock-assets.arbitrum-sepolia.json` 还没更新到四稳定币版本，可以显式传：

1. `BORROW_ASSET_ADDRESS`
2. `BORROW_SYMBOL`
3. `BORROW_ASSET_DECIMALS`
4. `BORROW_PRICE_VALUE`
5. `BORROW_SOURCE_ID`

兼容说明：旧变量 `BORROW_COINGECKO_ID`、`COLLATERAL_COINGECKO_ID`、`SETTLEMENT_TOKEN_COINGECKO_ID` 仍可用，但新的 live 脚本优先读取对应的 `*_SOURCE_ID`。

#### 1. mUSDC borrowAsset

warmup：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
BORROWER_PRIVATE_KEY="<borrower_private_key>" \
LENDER_PRIVATE_KEY="<lender_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<system_settlement_token_address>" \
BORROW_ASSET_ADDRESS="<mUSDC_address>" \
BORROW_SYMBOL="mUSDC" \
BORROW_ASSET_DECIMALS=6 \
BORROW_PRICE_VALUE="1" \
BORROW_SOURCE_ID="mock-usdc" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
ENABLE_WRITE=1 \
ALLOW_SINGLE_PARTY=0 \
COLLATERAL_AMOUNT_UNITS=10 \
BORROW_AMOUNT_UNITS=1200 \
TERM_DAYS=5 \
RATE_BPS=1000 \
pnpm -s exec hardhat run scripts/tests/live-test/live-warmup-arbitrum-sepolia.ts --network arbitrumSepolia
```

preflight：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<system_settlement_token_address>" \
BORROW_ASSET_ADDRESS="<mUSDC_address>" \
BORROW_SYMBOL="mUSDC" \
BORROW_ASSET_DECIMALS=6 \
BORROW_PRICE_VALUE="1" \
BORROW_SOURCE_ID="mock-usdc" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
pnpm -s exec hardhat run scripts/tests/live-test/live-preflight-arbitrum-sepolia.ts --network arbitrumSepolia
```

#### 2. mUSDT borrowAsset

warmup：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
BORROWER_PRIVATE_KEY="<borrower_private_key>" \
LENDER_PRIVATE_KEY="<lender_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<system_settlement_token_address>" \
BORROW_ASSET_ADDRESS="<mUSDT_address>" \
BORROW_SYMBOL="mUSDT" \
BORROW_ASSET_DECIMALS=6 \
BORROW_PRICE_VALUE="1" \
BORROW_SOURCE_ID="mock-usdt" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
ENABLE_WRITE=1 \
ALLOW_SINGLE_PARTY=0 \
COLLATERAL_AMOUNT_UNITS=10 \
BORROW_AMOUNT_UNITS=1200 \
TERM_DAYS=5 \
RATE_BPS=1000 \
pnpm -s exec hardhat run scripts/tests/live-test/live-warmup-arbitrum-sepolia.ts --network arbitrumSepolia
```

preflight：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<system_settlement_token_address>" \
BORROW_ASSET_ADDRESS="<mUSDT_address>" \
BORROW_SYMBOL="mUSDT" \
BORROW_ASSET_DECIMALS=6 \
BORROW_PRICE_VALUE="1" \
BORROW_SOURCE_ID="mock-usdt" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
pnpm -s exec hardhat run scripts/tests/live-test/live-preflight-arbitrum-sepolia.ts --network arbitrumSepolia
```

#### 3. mHKD borrowAsset

warmup：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
BORROWER_PRIVATE_KEY="<borrower_private_key>" \
LENDER_PRIVATE_KEY="<lender_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<system_settlement_token_address>" \
BORROW_ASSET_ADDRESS="<mHKD_address>" \
BORROW_SYMBOL="mHKD" \
BORROW_ASSET_DECIMALS=18 \
BORROW_PRICE_VALUE="0.128" \
BORROW_SOURCE_ID="mock-hkd" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
ENABLE_WRITE=1 \
ALLOW_SINGLE_PARTY=0 \
COLLATERAL_AMOUNT_UNITS=10 \
BORROW_AMOUNT_UNITS=1200 \
TERM_DAYS=5 \
RATE_BPS=1000 \
pnpm -s exec hardhat run scripts/tests/live-test/live-warmup-arbitrum-sepolia.ts --network arbitrumSepolia
```

preflight：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<system_settlement_token_address>" \
BORROW_ASSET_ADDRESS="<mHKD_address>" \
BORROW_SYMBOL="mHKD" \
BORROW_ASSET_DECIMALS=18 \
BORROW_PRICE_VALUE="0.128" \
BORROW_SOURCE_ID="mock-hkd" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
pnpm -s exec hardhat run scripts/tests/live-test/live-preflight-arbitrum-sepolia.ts --network arbitrumSepolia
```

#### 4. mSGD borrowAsset

warmup：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
BORROWER_PRIVATE_KEY="<borrower_private_key>" \
LENDER_PRIVATE_KEY="<lender_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<system_settlement_token_address>" \
BORROW_ASSET_ADDRESS="<mSGD_address>" \
BORROW_SYMBOL="mSGD" \
BORROW_ASSET_DECIMALS=18 \
BORROW_PRICE_VALUE="0.74" \
BORROW_SOURCE_ID="mock-sgd" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
ENABLE_WRITE=1 \
ALLOW_SINGLE_PARTY=0 \
COLLATERAL_AMOUNT_UNITS=10 \
BORROW_AMOUNT_UNITS=1200 \
TERM_DAYS=5 \
RATE_BPS=1000 \
pnpm -s exec hardhat run scripts/tests/live-test/live-warmup-arbitrum-sepolia.ts --network arbitrumSepolia
```

preflight：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<system_settlement_token_address>" \
BORROW_ASSET_ADDRESS="<mSGD_address>" \
BORROW_SYMBOL="mSGD" \
BORROW_ASSET_DECIMALS=18 \
BORROW_PRICE_VALUE="0.74" \
BORROW_SOURCE_ID="mock-sgd" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
pnpm -s exec hardhat run scripts/tests/live-test/live-preflight-arbitrum-sepolia.ts --network arbitrumSepolia
```

如果你要一次顺序跑完四个 borrowAsset，可以直接执行：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
BORROWER_PRIVATE_KEY="<borrower_private_key>" \
LENDER_PRIVATE_KEY="<lender_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<system_settlement_token_address>" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
ENABLE_WRITE=1 \
ALLOW_SINGLE_PARTY=0 \
pnpm -s run test:smoke:multi-stablecoin:arbitrum-sepolia-live
```

如果你要按“多稳定币 x 多 RWA collateral”跑组合矩阵，可以直接再加：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
BORROWER_PRIVATE_KEY="<borrower_private_key>" \
LENDER_PRIVATE_KEY="<lender_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<system_settlement_token_address>" \
MULTI_STABLECOIN_SYMBOLS="mUSDC,mUSDT,mHKD,mSGD" \
MULTI_COLLATERAL_SYMBOLS="RWAGOLD,RWABOND,RWARE,RWAINV" \
VIEWER_ADDRESS="<viewer_address>" \
ENABLE_WRITE=1 \
ALLOW_SINGLE_PARTY=0 \
pnpm -s run test:smoke:multi-stablecoin:arbitrum-sepolia-live
```

这条命令会按 `borrowAsset x collateralAsset` 组合顺序执行 warmup，并在 `PRIME_VIEW_CACHE != 0` 时对每一组组合追加一次 ViewCache prime。

## 15. 补充：localhost 多资产可写回归

如果你的目标是“正式上 Arbitrum Sepolia mock-suite live 之前，先把 write-path 在本地尽可能跑满”，当前推荐固定走下面这条 localhost 口径。

这一步的定位不是替代真链 live，而是把最贵、最容易反复失败的写路径先在本地真实回放掉。

当前已经实际验证过的范围包括：

1. `funds-flow-smoke-local.ts` 的 keeper-path 可写演练，最终达到 `settleOrLiquidate would succeed (staticCall)`
2. `funds-flow-invariants-suite.ts` 的单资产可写全路径
3. 多资产逐个可写全路径，已通过：
  - `USDC`
  - `mUSDC`
  - `mUSDT`
  - `mHKD`
  - `mSGD`
  - `mBTC`
  - `mETH`
  - `RWAGOLD`
  - `RWABOND`
  - `RWARE`
  - `RWAINV`

推荐步骤：

1. 起一条 fresh localhost 链，不要复用脏链
2. 部署 localhost 协议实例
3. 补角色、部署 mock asset pack、准备 whitelist / oracle / fee gate
4. seed mock asset prices
5. 先跑 keeper-path smoke
6. 再逐个跑多资产 invariants

推荐命令骨架：

```bash
LOCALHOST_RPC_URL="http://127.0.0.1:18547" \
pnpm -s run deploy:localhost

LOCALHOST_RPC_URL="http://127.0.0.1:18547" \
pnpm -s exec hardhat run scripts/tests/grant-required-roles-local.ts --network localhost

LOCALHOST_RPC_URL="http://127.0.0.1:18547" \
pnpm -s exec hardhat run scripts/deploy/deploy-mock-asset-pack.ts --network localhost

LOCALHOST_RPC_URL="http://127.0.0.1:18547" \
pnpm -s exec hardhat run scripts/tests/live-test/prepare-live-gates-localhost.ts --network localhost

LOCALHOST_RPC_URL="http://127.0.0.1:18547" \
AUTO_GRANT_UPDATE_PRICE=1 \
SEED_ALLOW_DIRECT_PRICE_ORACLE=1 \
pnpm -s exec hardhat run scripts/deploy/seed-mock-asset-prices.ts --network localhost

LOCALHOST_RPC_URL="http://127.0.0.1:18547" \
READ_ONLY=0 \
ENABLE_WRITE=1 \
STRICT_TX=1 \
ORDER_ID=0 \
pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-local.ts --network localhost

LOCALHOST_RPC_URL="http://127.0.0.1:18547" \
READ_ONLY=0 \
ENABLE_WRITE=1 \
E2E_ALLOW_DIRTY_STATE=1 \
ALLOW_SIGNER_REUSE=1 \
TOKENS="0x9E545E3C0baAB3E08CdfD552C960A1050f373042,0x2767e0d87d9889Aeb447A3851aA455A51Bf67035" \
pnpm -s exec hardhat run scripts/tests/funds-flow-invariants-suite.ts --network localhost
```

说明：

1. `LOCALHOST_RPC_URL` 可以切到任意 fresh 端口，例如 `18545`、`18546`、`18547`
2. `prepare-live-gates-localhost.ts` 会把 protocol settlement token、mock pack 资产、FeeRouter 支持和 oracle 配置一起补齐
3. `seed-mock-asset-prices.ts` 现在会额外补 protocol-bound settlement token 的价格，不再只 seed mock pack 里显式列出的 token
4. `ALLOW_SIGNER_REUSE=1` 是多资产长链路回归时的推荐值，否则 signer 很容易在同一条链上被耗尽

边界也要写清楚：

1. 当前“把所有 token 放进一次 monolithic invariants 串跑”的 combined run 还存在跨用例污染，首次稳定暴露在 `mBTC` guarantee extension 清理断言上
2. 这个问题当前更像测试编排问题，不是单个 token 自身跑不通，因为 `mBTC` 单独跑已经通过
3. 因此正式上 Sepolia 前，推荐口径是“localhost 逐个资产全写路径通过”即可，不必强求单次 combined run 把所有 token 连续串完

---

## 16. 一条龙复制版

如果你要从零开始重新做一套 mock-suite，并且严格按“本地先跑通 -> live 跑核心内容 -> 最后补专项”的顺序执行，可以按下面顺序整段执行。把占位符替换成你的 RPC 和私钥即可。

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
pnpm -s run compile

ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
pnpm -s run deploy:mock-assets:arbitrum-sepolia

pnpm -s run demo:backend-required:block:localhost

ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
pnpm -s run demo:backend-required:block:fork

ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" \
LIVE_USE_MOCK_ASSET_PACK=1 \
LIVE_PRICE_MODE=bootstrap \
pnpm -s run e2e:pre-release:arbitrum-sepolia-live

ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
BORROWER_PRIVATE_KEY="<borrower_private_key>" \
LENDER_PRIVATE_KEY="<lender_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<mUSDC_address>" \
SETTLEMENT_TOKEN_DECIMALS=6 \
SETTLEMENT_TOKEN_SOURCE_ID="mock-usdc" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
ENABLE_WRITE=1 \
ALLOW_SINGLE_PARTY=0 \
COLLATERAL_AMOUNT_UNITS=10 \
BORROW_AMOUNT_UNITS=1200 \
TERM_DAYS=5 \
RATE_BPS=1000 \
pnpm -s exec hardhat run scripts/tests/live-test/live-warmup-arbitrum-sepolia.ts --network arbitrumSepolia

set -a && source .env && set +a && ALLOW_LIQUIDATION_MANAGER_PAUSE=1 ALLOW_DYNAMIC_FEE_WRITE=1 pnpm -s run test:live:release-gates:arbitrum-sepolia

set -a && source .env && set +a && pnpm -s exec hardhat run scripts/tests/live-test/networks/arbitrum-sepolia/live-blocks-only-liquidation.ts --network arbitrumSepolia
```

其中：

1. `<mUSDC_address>` 从 `deployments/mock-assets.arbitrum-sepolia.json` 的 `settlementToken` 读取
2. `<registry>` 从 `scripts/deployments/arbitrum-sepolia.mock-suite.json` 的 `Registry` 读取
3. 如果你不是从零 fresh deploy，而是在复验已有实例，就把 `test:live:dryrun:arbitrum-sepolia`、`live-asset-precheck-arbitrum-sepolia.ts`、`live-preflight-arbitrum-sepolia.ts` 插到标准 live 主入口之前

日志位置：

1. live mock-suite 相关日志的基目录固定在 `scripts/e2e/logs/`
2. 每次运行都会创建新的时间戳目录，模式为 `scripts/e2e/logs/live-smoke-<timestamp>/`，不会持续写入同一个固定目录
3. 如果你要回看“这一次”的完整日志，应该记录当次生成的时间戳目录名，而不是只记一个文件名

本次成功运行的实际日志地址示例：

1. `scripts/e2e/logs/live-smoke-20260320132527817/`
2. `scripts/e2e/logs/live-smoke-20260320132527817/live-preflight-arbitrum-sepolia.log`
3. `scripts/e2e/logs/live-smoke-20260320132527817/seed-mock-asset-prices.log`
4. `scripts/e2e/logs/live-smoke-20260320132527817/live-prime-viewcache-arbitrum-sepolia.log`
5. `scripts/e2e/logs/live-smoke-20260320132527817/live-read-pressure.log`
6. `scripts/e2e/logs/live-smoke-20260320132527817/funds-flow-smoke-local.log`

---

## 17. 常见口径

### 17.1 为什么这里是 runbook，不是普通 usage guide

因为它解决的是“怎么执行”而不是“为什么存在”。

如果一句话区分：

1. runbook：给操作人员照着跑
2. usage guide：给开发/产品理解功能和接口边界

这份文档明显属于前者。

### 17.2 为什么还需要价格点火脚本

因为 mock 资产不依赖真实外部价格源，部署完只有配置，没有价格记录。

如果不先 seed：

1. `PriceOracle.getPrice` 可能仍然不可读
2. `ValuationOracleView` 可能继续返回 `0/0/false`
3. 后续 health / reward / view cache 很难正常点火

再补一条当前实测口径：

1. seed price 只能保证价格相关 view 变为可读，不等于 `RewardView`、`HealthView`、`ViewCache` 会一起变热。
2. 默认 seed 路径是 `PriceUpdater.updateAssetPrice`；`PriceOracle.updatePrice` 只应被理解为 break-glass。
3. `RewardView` 取决于 reward writer 是否被触发，以及借款额是否跨过最小门槛。
4. `HealthView` 取决于 `LendingEngine -> HealthView` 的角色是否完整。
5. `ViewCache` 取决于是否额外执行系统状态 prime，而不是价格 seed 本身。

### 17.3 为什么协议部署阶段要自动 whitelist 全部资产

因为你的目标已经不是“只验证单 settlement token”，而是“让 mock BTC / mock ETH / RWA 真正可测”。

只配 PriceOracle 不够；没有 AssetWhitelist，业务路径还是会把这些资产挡掉。

---

## 18. 产物清单

本次流程相关的核心文件：

1. `scripts/deploy/deploy-mock-asset-pack.ts`
2. `scripts/deploy/seed-mock-asset-prices.ts`
3. `deployments/mock-assets.arbitrum-sepolia.json`
4. `deployments/assets.arbitrum-sepolia.mock.json`
5. `scripts/deploy/deploy-arbitrum-sepolia.ts`

---

## 19. 推荐执行顺序

把这份 runbook 的执行顺序只记成下面 3 句话即可：

1. 第一步，本地先跑通写路径
2. 第二步，live 链上只跑核心内容
3. 第三步，再把专项脚本全部补齐

对应命令骨架：

```bash
pnpm -s run compile

ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
pnpm -s run deploy:mock-assets:arbitrum-sepolia

pnpm -s run demo:backend-required:block:localhost

ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
pnpm -s run demo:backend-required:block:fork

set -a && source .env && set +a && DEPLOY_OUTPUT_FILE="arbitrum-sepolia.mock-suite.json" LIVE_USE_MOCK_ASSET_PACK=1 LIVE_PRICE_MODE=bootstrap pnpm -s run e2e:pre-release:arbitrum-sepolia-live

set -a && source .env && set +a && ALLOW_LIQUIDATION_MANAGER_PAUSE=1 ALLOW_DYNAMIC_FEE_WRITE=1 pnpm -s run test:live:release-gates:arbitrum-sepolia
```

如果你是在复验已有实例，而不是从零 fresh deploy，再额外插入：

```bash
set -a && source .env && set +a && pnpm -s run test:live:dryrun:arbitrum-sepolia

set -a && source .env && set +a && pnpm -s exec hardhat run scripts/tests/live-test/live-asset-precheck-arbitrum-sepolia.ts --network arbitrumSepolia

set -a && source .env && set +a && pnpm -s exec hardhat run scripts/tests/live-test/live-preflight-arbitrum-sepolia.ts --network arbitrumSepolia
```

如果你只记一个判断标准，也只记这个：

1. localhost / fork 通过，才进入 live
2. live 核心内容通过，才进入专项补齐
3. 专项补齐完成，才可以说“这轮目录级测试基本跑完”
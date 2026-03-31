# 多稳定币使用指南（SSOT）

## 1. 目的

本文档定义本系统接入多种稳定币时的统一口径。

适用范围：

1. USD 稳定币：mUSDC、mUSDT
2. 非 USD 稳定币：mHKD、mSGD
3. 借款资产、还款资产、mock 资产包、预发版测试、live warmup

本文是多稳定币使用方式的 SSOT。若与其他零散说明冲突，以本文为准；若与总体架构冲突，以 [docs/Architecture-Guide.md](docs/Architecture-Guide.md) 和 [docs/Usage-Guide/Funds-Flow-Architecture-Guide.md](docs/Usage-Guide/Funds-Flow-Architecture-Guide.md) 的资金链与估值原则为上位约束。

## 2. 核心结论

### 2.1 本系统不是“单稳定币业务系统”

资金链主路径按具体资产运行，而不是按唯一 SettlementToken 运行。

也就是说：

1. reserveForLending 使用的是具体 asset
2. finalizeMatch 校验的是 borrowAsset
3. repay 使用的是 debtAsset
4. CollateralManager 和 VaultLendingEngine 的账本都是多资产账本

因此，从业务资产角度，本系统可以支持多种稳定币并行存在。

### 2.2 本系统当前仍然是“单估值基准系统”

系统内跨资产聚合的 value 口径仍然必须统一。

当前统一口径为：

1. Value Unit SSOT = USD-8
2. Statistics、Health、Liquidation、ViewCache、System Risk 等聚合视图必须回到同一个估值基准
3. 一个部署实例内只能有一个系统级 SettlementToken 配置，用作系统参考基准与兼容旧接口

这意味着：

1. 可以有很多稳定币资产
2. 但不能把一个实例改成“多个并列 SettlementToken 共同充当系统基准”

## 3. 正确的多稳定币接入方式

### 3.1 资产层

支持多稳定币作为可借贷资产。

推荐资产集合：

1. mUSDC
2. mUSDT
3. mHKD
4. mSGD

这些资产都应该：

1. 进入 AssetWhitelist
2. 进入 PriceOracle
3. 进入 FeeRouter 支持集
4. 能作为 reserveForLending 的 asset
5. 能作为 borrowIntent.borrowAsset
6. 能作为 repay 的 debtAsset

### 3.2 系统基准层

每个部署实例保留一个唯一的 SettlementToken。

它的作用是：

1. 提供系统级兼容基准
2. 作为部分旧接口和 view 的默认基准币
3. 作为 graceful degradation 的默认主稳定币

但它不应被误解为：

1. 唯一允许借款的稳定币
2. 唯一允许 reserve 的稳定币
3. 唯一允许 repay 的稳定币

## 4. SSOT 口径

### 4.1 amount SSOT

账本数量一律按 token base units 记账。

权威来源：

1. 抵押：CollateralManager
2. 债务：VaultLendingEngine
3. 订单：OrderEngine

### 4.2 value SSOT

跨资产聚合值一律按 USD-8 输出。

公式口径与 [docs/Usage-Guide/Funds-Flow-Architecture-Guide.md](docs/Usage-Guide/Funds-Flow-Architecture-Guide.md) 一致：

$$
valueUSD8 = amountBaseUnits \times priceUSD8 / 10^{assetDecimals}
$$

因此：

1. mUSDC、mUSDT 的 price 应接近 1.0 USD
2. mHKD 的 price 应是 HKDUSD 汇率，而不是机械地写成 1.0 USD
3. mSGD 的 price 应是 SGDUSD 汇率，而不是机械地写成 1.0 USD

### 4.3 稳定币语义 SSOT

稳定币分两类：

1. USD peg：mUSDC、mUSDT
2. Non-USD peg：mHKD、mSGD

这两类都属于“稳定币资产”，但在估值上不能共用同一个 1 USD face value 假设。

## 5. 部署与使用模式

### 5.1 推荐模式：单实例单 SettlementToken，多稳定币资产共存

每个实例：

1. 选一个 SettlementToken 作为系统基准币
2. 同时部署并注册多种稳定币资产
3. 借贷主链路允许具体订单选择不同的 borrowAsset

例如：

1. 实例 A：SettlementToken = mUSDC
   同时支持 mUSDT、mHKD、mSGD 作为可借贷资产
2. 实例 B：SettlementToken = mHKD
   同时支持 mUSDC、mUSDT、mSGD 作为可借贷资产

### 5.2 不推荐模式：试图让一个实例同时拥有多个系统基准币

不推荐原因：

1. StatisticsView/HealthView/Liquidation/ViewCache 都依赖统一聚合价值口径
2. 当前架构文档与实现都默认存在单一系统基准
3. 直接并列多个 SettlementToken 会把估值、风控、清算和 view 缓存一起复杂化

## 6. 稳定币 fallback 规则

### 6.1 可接受的 fallback

1. 对 USD peg 稳定币，可在明确配置时使用 1 USD face value 作为 fallback
2. 对非 USD peg 稳定币，不得默认按 1 USD face value 估值

### 6.2 对 mHKD 和 mSGD 的要求

1. 必须提供到 USD-8 的价格映射
2. 推荐由 PriceOracle 正常喂价
3. 如果进入 fallback，必须使用各自 peg 对应的 USD 参考价，而不是复用 1 USD

## 7. mock 资产包约定

默认 mock 资产包应至少包含：

1. mUSDC
2. mUSDT
3. mHKD
4. mSGD

默认行为：

1. 同一份 asset pack 中可以同时存在多稳定币
2. 但只能有一个被标记为 settlementToken=true
3. 其余稳定币是可借贷资产，不是系统基准币

## 8. 对接步骤

### 第一步：准备资产包

资产包必须同时定义：

1. 多个稳定币资产
2. 各自 decimals
3. 各自 defaultPriceUsd8
4. 其中唯一一个 settlementToken=true

### 第二步：部署实例

部署实例时：

1. 选择一个 SettlementToken symbol
2. 其余稳定币继续保留在资产列表里
3. 完成 PriceOracle、Whitelist、FeeRouter 注册

### 第三步：价格喂数

必须为所有稳定币写入价格：

1. mUSDC ≈ 1.0 USD
2. mUSDT ≈ 1.0 USD
3. mHKD ≈ HKDUSD
4. mSGD ≈ SGDUSD

### 第四步：业务验证

至少分别验证：

1. 用 mUSDC 做 borrowAsset 的链路
2. 用 mUSDT 做 borrowAsset 的链路
3. 用 mHKD 做 borrowAsset 的链路
4. 用 mSGD 做 borrowAsset 的链路
5. 统一 preflight 下的 Statistics/Health/Position 视图是否仍按 USD-8 一致输出

### 第五步：localhost 最小可运行序列

如果要在本地链直接验证四类稳定币的 borrow/repay 与 USD-8 聚合估值，可按下面顺序执行：

```bash
pnpm -s hardhat node --hostname 127.0.0.1 --port 8545
pnpm -s run deploy:localhost
pnpm -s exec hardhat run scripts/deploy/deploy-mock-asset-pack.ts --network localhost
pnpm -s run test:smoke:multi-stablecoin:localhost
```

默认脚本会循环验证：

1. mUSDC
2. mUSDT
3. mHKD
4. mSGD

可选环境变量：

```bash
MULTI_STABLECOIN_SYMBOLS="mUSDC,mHKD" \
MOCK_ASSET_PACK_OUTPUT="deployments/mock-assets.localhost.json" \
pnpm -s run test:smoke:multi-stablecoin:localhost
```

该 smoke 会自动：

1. 将资产接入 AssetWhitelist / PriceOracle / FeeRouter
2. 逐个稳定币执行 deposit collateral -> reserveForLending -> finalizeMatch -> repay
3. 校验 borrowAsset 维度的 PositionView debt
4. 校验 `VaultLendingEngine.getUserTotalDebtValue(user)` 的 USD-8 聚合债务在还款后清零

### 第六步：fork 最小可运行序列

如果要在 Arbitrum Sepolia fork 上复用同一条多稳定币 smoke，可直接执行：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
pnpm -s run test:smoke:multi-stablecoin:fork
```

默认行为：

1. 自动在 `127.0.0.1:18545` 拉起 fork 节点
2. 对 fork 链执行 `deploy:localhost`
3. 在 fork 链部署默认 mock asset pack
4. 在 fork 链执行 `test:smoke:multi-stablecoin:localhost`
5. 把 fork 节点日志与每一步输出写入 `scripts/tests/logs/multi-stablecoin-fork-<timestamp>/`

可选环境变量：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
SMOKE_FORK_NODE_HOST="127.0.0.1" \
SMOKE_FORK_NODE_PORT=18545 \
HARDHAT_FORK_BLOCK_NUMBER="<optional_block>" \
pnpm -s run test:smoke:multi-stablecoin:fork
```

### 第七步：live 多 borrowAsset warmup / smoke

live mock-suite 下，系统级 `SettlementToken` 不需要因为 borrowAsset 改成 `mUSDT`、`mHKD`、`mSGD` 就一起切换。当前 live 脚本已经支持通过 `BORROW_*` 环境变量单独指定这次资金链实际使用的借款资产。

单资产 warmup 模板：

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc>" \
PRIVATE_KEY="<your_private_key>" \
BORROWER_PRIVATE_KEY="<borrower_private_key>" \
LENDER_PRIVATE_KEY="<lender_private_key>" \
REGISTRY_ADDRESS="<registry>" \
SETTLEMENT_TOKEN_ADDRESS="<system_settlement_token_address>" \
BORROW_ASSET_ADDRESS="<borrow_asset_address>" \
BORROW_SYMBOL="mUSDT" \
BORROW_ASSET_DECIMALS=6 \
BORROW_PRICE_UNITS_8="1" \
BORROW_SOURCE_ID="mock-usdt" \
COLLATERAL_SYMBOL="RWAGOLD" \
VIEWER_ADDRESS="<viewer_address>" \
ENABLE_WRITE=1 \
ALLOW_SINGLE_PARTY=0 \
pnpm -s exec hardhat run scripts/tests/live-test/live-warmup-arbitrum-sepolia.ts --network arbitrumSepolia
```

兼容说明：旧变量 `BORROW_COINGECKO_ID` 仍可继续使用，但新脚本优先读取 `BORROW_SOURCE_ID`。

多稳定币顺序 smoke：

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

如果当前 `deployments/mock-assets.arbitrum-sepolia.json` 还是旧版本、缺少 `mUSDT` / `mHKD` / `mSGD`，可显式传：

```bash
MULTI_STABLECOIN_ASSETS="mUSDC:<addr>:6:1:mock-usdc,mUSDT:<addr>:6:1:mock-usdt,mHKD:<addr>:18:0.128:mock-hkd,mSGD:<addr>:18:0.74:mock-sgd" \
pnpm -s run test:smoke:multi-stablecoin:arbitrum-sepolia-live
```

## 9. 当前仓库改造边界

本仓库当前应优先做以下改造：

1. 扩充 mock 资产包，加入多稳定币
2. 允许部署时选择本次实例唯一 SettlementToken
3. 保持借贷主链路继续按具体 asset 运作
4. 保持系统聚合 value 继续按 USD-8 统一输出

本轮不应直接做的高风险改造：

1. 把 SettlementToken 改成链上数组并让所有模块并列读取
2. 把 Health/Statistics/Liquidation 改成多本位币聚合
3. 在未统一 value SSOT 前，把 mHKD/mSGD 简单当 1 USD 资产处理

## 10. 最终口径

一句话总结：

本系统的多稳定币方案应是“多稳定币资产并存，单实例保留一个系统级 SettlementToken，所有跨资产聚合继续统一到 USD-8”。

这才同时符合：

1. [docs/Architecture-Guide.md](docs/Architecture-Guide.md)
2. [docs/Usage-Guide/Funds-Flow-Architecture-Guide.md](docs/Usage-Guide/Funds-Flow-Architecture-Guide.md)
3. 当前资金链与账本实现

### 10.1 RWA 与多稳定币的关系

多稳定币文档解决的是 debt side 语义，不直接定义 RWA 价格来源。

当 borrower 用 RWA 抵押并借稳定币时：

1. RWA collateral 只维护一份 USD-8 价格
2. 稳定币 debt side 各自维护到 USD-8 的价格
3. Health / Liquidation / Statistics 仍然在统一 USD-8 口径下比较

不要为同一个 RWA 资产分别维护：

1. gold-usdc price
2. gold-usdt price
3. gold-hkd price
4. gold-sgd price

系统内真正需要多份价格的是稳定币本身的 USD 映射，而不是同一份 RWA 的多稳定币分身估值。

### 10.2 与 Google Finance 来源的边界

如果 RWA 价格来源来自 Google Finance：

1. Google Finance 负责提供链下原始报价
2. 后端负责把原始报价归一化成 USD-8
3. PriceOracle 负责存储链上统一价格

也就是说：

1. 多稳定币文档不承担价格采集实现
2. RWA 价格采集与发布的 SSOT 见 [RWA-Price-System-Guide.md](RWA-Price-System-Guide.md)

### 10.3 最终结论

1. 一个实例里可以并存多种稳定币资产。
2. 一个实例里只能有一个系统级 SettlementToken。
3. 非 USD peg 稳定币必须按各自对 USD 汇率估值，不能统一按 1 USD 处理。
4. 借贷主路径应该按具体 borrowAsset / debtAsset 运行，而不是强行回退到 SettlementToken。
5. RWA collateral 的价格来源可以不同，但写链后必须统一回到 USD-8，不能按稳定币种类再分叉一套估值。
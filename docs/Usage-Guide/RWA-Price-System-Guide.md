# RWA 价格体系指南（SSOT）

## 1. 目标

本文档定义 RWA 资产价格体系在以下三个阶段的统一口径：

1. localhost / fork 集成验证
2. Arbitrum Sepolia live 阶段 mock 资产联调
3. 测试网上线与正式运行阶段的价格发布与消费

测试只是这套价格体系中的一个阶段，不是本文档的唯一目标。

本文解决六个问题：

1. RWA 价格从哪里来
2. 所有资产如何收敛到同一条发布链路
3. RWA 价格如何映射到多稳定币估值体系
4. 后端在价格体系中承担哪些职责
5. 前端、preflight、缓存、监控应该消费什么事实
6. live、launch、正式运行时如何避免口径漂移

如果其他文档与本文冲突，以本文为准；如果与总体资金链或估值公式冲突，以上位文档 [docs/Architecture-Guide.md](docs/Architecture-Guide.md) 与 [docs/Usage-Guide/Multi-Stablecoin-Usage-Guide.md](docs/Usage-Guide/Multi-Stablecoin-Usage-Guide.md) 为准。

> 范围边界：本文不定义订单生命周期 closed-state、订单终态展示或前端/后端如何判定订单是否结束；这些规则统一以 Funds-Flow 与用户维度 View 策略文档为准。当前跨文档主线也不把 blocks-only 作为默认价格消费方单独展开。

---

## 2. 当前仓库现状

基于当前仓库实现，已经确认以下事实：

1. 链上并不会直接从 Google Finance 拉取价格。
2. 当前链上存在两个写价入口：`PriceOracle.updatePrice` 与 `PriceUpdater.updateAssetPrice`。
3. `scripts/deploy/deploy-mock-asset-pack.ts` 当前资产包的主字段已经是 `bootstrapPriceValue`；`defaultPriceValue` 只作为兼容旧数据的回退字段。
4. `scripts/tests/live-test/live-smoke-multi-stablecoin-arbitrum-sepolia.ts` 已支持按 borrowAsset 切换 `mUSDC`、`mUSDT`、`mHKD`、`mSGD` 做 live smoke。
5. live 工具当前优先读取 `bootstrapPriceValue`，只在兼容旧资产包时回退到 `bootstrapPriceUsd8 / defaultPriceValue / defaultPriceUsd8`。
6. 当前“正常写价路径”并未完全统一到 `PriceUpdater.updateAssetPrice`：
   - `seed-mock-asset-prices.ts` 默认走 `PriceUpdater.updateAssetPrice`，但在 `SEED_ALLOW_DIRECT_PRICE_ORACLE=1` 时会直接调用 `PriceOracle.updatePrice`。
   - `scripts/tests/live-test/_fundsFlowLive.ts` 优先尝试 updater；当 updater 缺失、允许直写、或需要 repair `PriceOracle` 可读性时，仍会直接调用 `PriceOracle.updatePrice`。
   - 因此，当前仓库里 `PriceOracle.updatePrice` 不只是“紧急文档语义上的占位符”，而是仍被若干常规脚本显式使用的活动路径。

因此，当前实现处于“部分收敛”状态：价格最终仍统一落到 `PriceOracle`，但发布入口、bootstrap/repair 策略、以及 live 脚本的写链路径还没有完全收敛成单一路径。

---

## 3. 统一设计原则

### 3.1 价格来源与链上写价分离

必须区分两层：

1. price source：Google Finance、CoinGecko 或其他许可链下来源
2. price writer：后端 keeper / relayer，通过协议允许的写价入口把标准化价格写入链上

补充说明：当前实现已经统一为 `src/core/PriceUpdater.sol` / `PriceUpdater` 合约名；Registry 底层仍保留历史哈希输入，仅用于兼容既有链上键值，不代表价格来源被限定为 CoinGecko。

链上只接受已经按目标资产 `assetDecimals` 标准化后的结果，不承担网页抓取、HTML 解析、货币换算、重试退避等职责。

### 3.2 所有资产收敛到同一条链路

目标态上，所有资产都应收敛成以下单一路径：

1. 链下价格采集
2. 按目标资产 `assetDecimals` 归一化成链上价格格式
3. 统一调用 `PriceUpdater.updateAssetPrice`
4. 统一由 `PriceOracle` 存储
5. 前端、preflight、缓存都只认链上最终价和链下发布状态

但就当前仓库实现而言，这个目标尚未完全落地：

1. `PriceUpdater.updateAssetPrice` 已经是推荐主路径，也是 `seed-mock-asset-prices.ts` 的默认路径。
2. `PriceOracle.updatePrice` 仍被 live/bootstrap/repair 逻辑显式使用，当前不能把它写成“仅存在但不再被正常脚本调用”。
3. 因此，当前正确口径应是：
   - **目标态**：统一走 `PriceUpdater.updateAssetPrice`
   - **当前态**：`PriceUpdater.updateAssetPrice` 与 `PriceOracle.updatePrice` 并存，后者仍承担 bootstrap、repair、以及部分直写 fallback 职责

### 3.2.1 自动决策价格依赖矩阵（当前落地口径）

本轮实现已经把“价格可展示”和“价格可驱动自动决策”明确拆开。文档与前后端必须统一按下面的矩阵理解：

1. legacy / 通用订单的自动风险判断、自动清算、自动结算、shortfall sizing，只接受 strict authoritative oracle price。
2. 对应实现口径是：自动路径使用 `IPriceOracleRead.getPrice(...)` 驱动的 strict valuation；失败时应 fail-closed，而不是 silently fallback。
3. best-effort / fallback price 只保留给 UI、诊断、缓存、观测、链下对账或兼容读场景，不得驱动自动 debt reduction。
4. 资产运营上应继续按两层理解：Tier-1 可自动估值并参与自动决策；Tier-2 只允许展示参考价，不允许进入自动清算/自动放贷决策。
5. 本轮文档收敛先以 legacy / 通用订单为准；blocks-only 的价格依赖口径后续单独统一整理。

### 3.3 RWA 资产与稳定币资产分层

必须区分两类资产：

1. borrowAsset / debtAsset：`mUSDC`、`mUSDT`、`mHKD`、`mSGD`
2. collateralAsset：`RWAGOLD`、`RWABOND`、`RWARE`、`RWAINV` 以及后续新增 RWA 资产

RWA 不是稳定币，但其估值必须映射回统一 USD 语义，再由多稳定币借贷链路消费；精度遵循各资产自身 `assetDecimals`，跨资产消费前显式归一化。

### 3.4 单实例仍是单系统基准币

即使 live 阶段允许多个稳定币 borrowAsset 并行存在，也不能把一个实例改成多个系统级 SettlementToken。

系统级 SettlementToken 仍然只有一个；其他稳定币是可借贷资产，不是系统基准币。

### 3.5 bootstrap 与正式价格系统必须拆层

live 阶段和正式运行阶段不能复用同一套价格语义：

1. bootstrap：当前主字段应是 `bootstrapPriceValue`；旧资产包仍可能回退到 `defaultPriceValue`，两者的值语义都按资产 `assetDecimals` 解释
2. 正常运行：必须由链下价格作业提供权威写价
3. 如果价格缺失，应该阻止需要估值的链路进入“伪成功”状态

---

## 4. 资产分层模型

建议把价格体系中的资产分成三层。

### 4.1 Layer A：结算稳定币层

资产示例：

1. `mUSDC`
2. `mUSDT`
3. `mHKD`
4. `mSGD`

职责：

1. 作为 borrowAsset / debtAsset / repayAsset
2. 提供多稳定币业务验证面
3. 为 RWA 抵押借贷提供计价落点

### 4.2 Layer B：RWA collateral 层

资产示例：

1. `RWAGOLD`
2. `RWABOND`
3. `RWARE`
4. `RWAINV`
5. 后续新增的股票、ETF、商品、收益权类资产

职责：

1. 作为 collateralAsset
2. 测试价格波动对健康度、清算、统计视图的影响
3. 验证不同稳定币借款路径下的统一 USD 语义估值，以及跨资产归一化逻辑

### 4.3 Layer C：price descriptor 层

每个 RWA 资产除了 token metadata，还要维护一份链下 price descriptor：

1. symbol
2. displayName
3. sourceProvider
4. sourceTicker
5. pricingCurrency
6. quoteToUsdPair
7. updateCadence
8. staleAfterSeconds
9. fallbackPolicy
10. bootstrapPriceValue�语义为按资产 `assetDecimals` 缩放的 bootstrap price）

这份描述信息不应强塞进链上合约存储；应该由链下 price catalog 管理，并在部署资产包时导出给脚本使用。

---

## 5. 统一价格链路

目标态推荐采用下面这条标准管线：

1. collector 读取原始行情
2. normalizer 将原始行情按目标资产 `assetDecimals` 统一换算成链上价格
3. publisher 调用 `PriceUpdater.updateAssetPrice`
4. `PriceOracle` 存储最终价格
5. indexer / cache worker 读取 `PriceUpdated` 事件并更新链下发布状态
6. 前端、preflight、缓存、监控消费“链上最终价 + 链下发布状态”

当前实现补充口径：

1. 最终价格存储 SSOT 仍然是 `PriceOracle`。
2. `PriceUpdater.updateAssetPrice` 已承担主要推荐写入口，但不是唯一活动入口。
3. 直接 `PriceOracle.updatePrice` 仍被脚本用于 bootstrap、repair、以及在缺失 updater 或显式允许直写时的 fallback。
4. 因此，链下与运维不应假设“看到 `PriceUpdated` 就一定来自 updater 路径”，而应把 `PriceOracle` 视为最终存储层，把具体写入来源视为当前阶段可并存的实现细节。

### 5.1 为什么不能直接把 Google Finance 映射成 sourceId

当前仓库里的 `sourceId` 只是链上配置里的字符串标签，不代表合约真的会去请求 CoinGecko。

因此对于 RWA 价格体系：

1. 可以继续保留 `sourceId` 字段作为链上的 `oracleAssetKey`
2. 链下实际数据源可以是 Google Finance、CoinGecko 或其他 provider
3. 真正的 source provider 应该由链下 catalog 管理，而不是由链上字段直接表达

建议链下映射：

1. `oracleAssetKey = mock-rwa-gold`
2. `sourceProvider = google-finance`
3. `sourceTicker = 你们约定的可审计 ticker`

### 5.2 非 USD 资产的换算方式

如果 source 提供的不是 USD 报价，而是本币报价，则必须先换算：

1. 资产原始价 = `assetPriceInQuote`
2. 汇率价 = `quoteCurrencyToUsd`
3. 链上写价 = `assetPriceInQuote × quoteCurrencyToUsd`

写入链上的最终结果必须始终符合该资产的 `assetDecimals` 口径。

### 5.3 推荐的链下表结构

建议后端至少维护三张表：

1. `rwa_asset_catalog`
2. `rwa_price_snapshots`
3. `oracle_publish_jobs`

最小字段建议：

1. `rwa_asset_catalog`
   `assetSymbol, assetAddress, oracleAssetKey, sourceProvider, sourceTicker, pricingCurrency, isMock, isLiveMock, isLaunchToken`
2. `rwa_price_snapshots`
   `oracleAssetKey, rawPrice, rawCurrency, fxToUsd, normalizedPrice, normalizedPriceDecimals, collectedAt, sourceVersion`
3. `oracle_publish_jobs`
   `oracleAssetKey, targetChainId, targetRegistry, targetOracle, publishBlock, publishedPrice, publishedPriceDecimals, status, idempotencyKey`

---

## 6. 多稳定币映射规则

### 6.1 Value SSOT 不变

无论借款资产是 `mUSDC`、`mUSDT`、`mHKD` 还是 `mSGD`，RWA 抵押物都只维护一份链上 USD 价格语义；具体精度由该资产 `assetDecimals` 决定。

不要为同一个 RWA 资产分别维护：

1. `gold-usdc price`
2. `gold-usdt price`
3. `gold-hkd price`
4. `gold-sgd price`

链上只保留 `gold/usd` 这一份价格语义即可；若字段名仍写作 `value`，调用方也必须按资产 `assetDecimals` 解释。

### 6.2 稳定币借款路径的正确解释

例如 borrower 用 `RWAGOLD` 抵押，借 `mHKD`：

1. `RWAGOLD` 在 `PriceOracle` 中的价值遵循自身 `assetDecimals` 的 USD 价格语义
2. `mHKD` 在 `PriceOracle` 中的价值是 HKDUSD 对应的 USD 价格语义，精度按其 `assetDecimals`
3. `Health` / `Liquidation` / `Statistics` 做跨资产比较前，仍必须先统一归一化到同一目标精度

因此，多稳定币指南与 RWA 价格体系指南的边界是：

1. 多稳定币文档定义 debt side 的估值语义
2. 本文定义 RWA collateral side 的价格来源、发布路径与消费规则

### 6.3 推荐映射表

| RWA Symbol | 主来源 | 原始计价币种 | 链上写价 | 推荐 borrowAsset smoke |
|---|---|---|---|---|
| RWAGOLD | Gold spot / ETF proxy | USD | 按该资产 `assetDecimals` 缩放的 USD price | mUSDC, mHKD |
| RWABOND | Bond ETF / treasury proxy | USD | 按该资产 `assetDecimals` 缩放的 USD price | mUSDC, mUSDT |
| RWARE | REIT / real-estate proxy | USD | 按该资产 `assetDecimals` 缩放的 USD price | mUSDT, mSGD |
| RWAINV | Invoice / receivable basket proxy | USD 或本币 | 按该资产 `assetDecimals` 缩放的 USD price | mUSDC, mSGD |

---

## 7. 三阶段落地模式

### 7.1 阶段一：localhost / fork

目的：验证逻辑，不验证真实行情源。

规则：

1. 允许 `bootstrapPriceValue`
2. 当前允许脚本直接写价到 `PriceOracle.updatePrice`，也允许经 `PriceUpdater.updateAssetPrice` 写价
3. 允许使用静态 FX 值

验收点：

1. `PositionView` / `HealthView` / `StatisticsView` 跟随价格更新变化
2. 多稳定币 borrow/repay 流程可跑通
3. RWA collateral 的健康度和清算门槛符合预期

### 7.2 阶段二：Arbitrum Sepolia live mock

目的：验证接近真实运营的链路，但仍使用 mock token。

规则：

1. token 是 mock 的
2. 价格源优先来自链下 collector，但当前 live 工具仍保留 bootstrap / repair 直写链上路径
3. `bootstrapPriceValue` 只用于 bootstrap 或 writer 故障时的短时人工兜底，其值语义按资产 `assetDecimals` 解释

验收点：

1. `live-asset-precheck` 能确认所有资产已进 whitelist / feeRouter / oracle config
2. `live-warmup` 能打通 `deposit -> reserve -> finalizeMatch -> repay`
3. `PriceUpdated` 事件与链下 publish status 可对账
4. preflight 能识别 stale price、missing price、cache cold、writer 权限缺失

### 7.3 阶段三：launch / 正式运行

目的：让测试网或正式运行阶段都使用同一套价格体系，而不是继续依赖 mock 默认值。

规则：

1. 可交易 token 不一定继续使用当前 mock asset pack
2. 价格必须由链下 writer 作业持续写入
3. `bootstrapPriceValue` 不再作为自动兜底写价来源
4. 如果没有有效价格，相关借贷和风控链路应按严格预检处理

验收点：

1. 价格缺失时 preflight 直接 fail，不允许 silent fallback
2. keeper / backend 能自动续写价格
3. 前端和后端能区分 `isLiveMock`、`isLaunchToken`、`publishStatus`

---

## 8. 后端职责设计

建议把后端拆成四个作业。

### 8.1 price-collector

职责：

1. 从 Google Finance、CoinGecko 或其许可镜像拉取原始行情
2. 记录 source timestamp、raw currency、raw price
3. 产出标准化快照

### 8.2 fx-normalizer

职责：

1. 处理 HKD、SGD 等非 USD 稳定币的 USD 映射
2. 处理非 USD 计价 RWA 的美元换算
3. 统一输出 `normalizedPrice` + `normalizedPriceDecimals`

### 8.3 oracle-publisher

职责：

1. 读取最新 `normalizedPrice`
2. 用统一幂等键发链上更新交易
3. 目标态正常路径统一调用 `PriceUpdater.updateAssetPrice`
4. 发布成功后落库 `publish status`

当前实现备注：在进入目标态之前，运维脚本与 live repair 工具仍可能直接走 `PriceOracle.updatePrice`，所以发布作业与 runbook 需要明确区分“推荐主路径”和“当前兼容路径”。

统一幂等键建议：

1. `chain:c421614:{txHash}:log-{logIndex}` 用于事件落库
2. `price:rwa:{oracleAssetKey}:{collectedAt}` 用于发布任务

### 8.4 live-preflight-checker

职责：

1. 检查 asset config 是否存在
2. 检查 block freshness
3. 检查价格是否为 0
4. 检查 `PriceUpdated` 最近一次落库是否成功
5. 检查 warmup 目标资产是否与当前 `Registry` / `SettlementToken` 对齐

---

## 9. 缓存与读模型职责

### 9.1 链上缓存不保存原始 source 值

链上缓存和 View 模块只应该面对：

1. `normalizedPrice`
2. `updateBlock`
3. `isValid / stale` 状态

不要把 source ticker、原始币种、原始小数精度塞入 `ViewCache` 或其他链上缓存。

### 9.2 链下缓存分两类

1. source cache：保存原始行情抓取结果
2. publish cache：保存写链结果与链上回读结果

推荐最小缓存键：

1. `price-source:{oracleAssetKey}`
2. `price-publish:{chainId}:{oracleAssetKey}`
3. `preflight:{registry}:{asset}`

### 9.3 统一消费规则

本文要求所有消费方统一遵循：

1. 前端读取链上最终价 + 链下 publish status
2. preflight 读取链上最终价 + 链下 publish status
3. 缓存与读模型以 `PriceUpdated` 为链上事实，以 publish job 为链下事实
4. 不允许某一侧单独依赖 raw source 或 `bootstrapPriceValue` 直接做业务判断

补充：这里的“链上最终价”指 `PriceOracle` 当前可读出的最终状态，不强行要求发布入口已经唯一化。

---

## 10. 对当前脚本的改造建议

### 10.1 deploy-mock-asset-pack.ts

当前问题：

1. 当前主字段已经是 `bootstrapPriceValue`，但仍需兼容读取旧的 `defaultPriceValue`
2. `sourceId` 名称过于误导

建议：

1. 保留 `bootstrapPriceValue` 语义，但按资产 `assetDecimals` 解释
2. 增加可选字段 `sourceProvider`、`sourceTicker`、`pricingCurrency`、`launchPriceRequired`
3. 不要求链上消费这些字段，但要写入 `mock-assets.*.json` 供后端与 runbook 读取

### 10.2 seed-mock-asset-prices.ts

当前定位应明确为：

1. bootstrap seeder
2. 紧急人工回填工具

当前代码补充：

1. 默认写链路径是 `PriceUpdater.updateAssetPrice`
2. 设置 `SEED_ALLOW_DIRECT_PRICE_ORACLE=1` 时会直接调用 `PriceOracle.updatePrice`

不应继续被描述成正式价格系统。

### 10.3 _mockLiveIgnition.ts

建议在 live 阶段新增模式开关：

1. `LIVE_PRICE_MODE=bootstrap`
2. `LIVE_PRICE_MODE=backend-required`

语义：

1. bootstrap 模式允许在链上无价时按 env/bootstrap 值临时写价
2. backend-required 模式下，如果链上价格不可读则直接失败，不再自动补价

当前实现补充：live 相关工具实际已经优先消费 `bootstrapPriceValue`，并在需要时通过 updater 或直接 `PriceOracle.updatePrice` 进行 repair；文档应继续把这部分描述为“当前兼容实现”，而不是“已经完成统一收敛”。

---

## 11. 推荐实施顺序

### 第一步：补 price catalog

为每个 RWA 资产补齐：

1. `sourceProvider`
2. `sourceTicker`
3. `pricingCurrency`
4. `fallbackPolicy`
5. `bootstrapPriceValue`
6. `launchPriceRequired`

### 第二步：接入后端 price jobs

至少先打通：

1. collector
2. normalizer
3. publisher

### 第三步：把 live mock 切成两种模式

1. bootstrap live
2. backend-required live

### 第四步：对四稳定币逐一做 RWA borrow smoke

建议矩阵：

1. `RWAGOLD × mUSDC`
2. `RWAGOLD × mHKD`
3. `RWABOND × mUSDT`
4. `RWARE × mSGD`

### 第五步：上线前切换到 launch token

要求：

1. 替换资产地址
2. 保留同一套 `oracleAssetKey` 语义或建立新映射
3. 关闭 bootstrap 自动补价
4. preflight 启用严格价格检查

---

## 12. 最小验收清单

- [ ] 每个 RWA 资产都能从 price catalog 映射到 source provider
- [ ] 每个稳定币都已在 `PriceOracle` 中注册并按自身 `assetDecimals` 写入正确价格
- [ ] `live-asset-precheck` 能识别 RWA 与 borrowAsset 的 whitelist / fee / oracle 状态
- [ ] `live-warmup` 在双地址模式下可稳定跑通
- [ ] 后端 publisher 写链后，链下索引能用 txHash + logIndex 对账
- [ ] launch / 正式运行模式下关闭自动 bootstrap 补价
- [ ] stale price、missing price、publish failed 都有告警与阻断策略

---

## 13. 与现有文档的关系

1. 多稳定币估值规则：见 [docs/Usage-Guide/Multi-Stablecoin-Usage-Guide.md](docs/Usage-Guide/Multi-Stablecoin-Usage-Guide.md)
2. PriceOracle 使用方式：见 [docs/Usage-Guide/PriceOracle-Guide.md](docs/Usage-Guide/PriceOracle-Guide.md)
3. live mock 执行步骤：见 [docs/Usage-Guide/runbook/Arbitrum-Sepolia-Mock-Assets-Runbook.md](docs/Usage-Guide/runbook/Arbitrum-Sepolia-Mock-Assets-Runbook.md)
4. 后端落地与幂等：见 [docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md](docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md)
5. 缓存与读模型：见 [docs/Usage-Guide/Cache-Architecture-Guide.md](docs/Usage-Guide/Cache-Architecture-Guide.md)
6. 总架构入口：见 [docs/Architecture-Guide.md](docs/Architecture-Guide.md)

---

## 14. 最终口径

一句话总结：

1. Google Finance / CoinGecko / 其他 provider 都只是链下价格来源。
2. 链上始终只接收按目标资产 `assetDecimals` 归一化后的价格。
3. 当前最终存储 SSOT 是 `PriceOracle`，但发布入口尚未完全唯一化；`PriceUpdater.updateAssetPrice` 是推荐主路径，`PriceOracle.updatePrice` 仍是当前代码中的活动兼容路径。
4. 前端、preflight、缓存、监控都应以链上最终价和链下发布状态为准，而不是依赖某一种特定写链入口。
5. `bootstrapPriceValue` 是当前 mock/live bootstrap 的主字段；`defaultPriceValue` 仅作旧数据兼容，不应再写成当前主语义。
6. bootstrap 价格只是价格体系中的辅助阶段，不是正式运行的权威来源。
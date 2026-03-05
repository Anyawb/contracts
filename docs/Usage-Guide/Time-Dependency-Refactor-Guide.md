# 时间依赖改造指南（避免 `block.number` 以外的时间轴）

> 适用范围：本文档说明在本仓库中，**如何改造“基于时间”的链上逻辑**，以避免在安全关键决策中依赖秒级时间。
>
> 背景动机：秒级时间在协议允许范围内会受到出块者（矿工/验证者）影响。把它作为严格门槛用于资金流转、预言机有效性、
> 清算、权限边界等，会扩大攻击面，并在网络波动/出块异常时引入误判（false positive/negative）。

---

## 目标

- 移除安全关键路径对秒级时间的依赖。
- 在可行情况下，把“过期/有效性”统一为**基于区块高度**的规则（`block.number`）。
- 尽量保持接口稳定，但优先使用**显式的链上新鲜度信号**（例如更新区块 `updateBlock`），而不是隐式的秒级时间差计算。
- 与代码规范/静态检查保持一致（`solhint` 的 `not-rely-on-time`），且不使用 `solhint-disable` 这类行内屏蔽注释。

---

## 本项目决策（强约束）：链上统一采用 Block 门槛（不使用秒级时间）

你可以把它理解为“**只在链下使用墙钟时间**；链上只使用区块高度/epoch/round 的单调性”。

### 统一规则（必须遵守）

- **链上 gate/门槛只允许**：`block.number` / epoch / round id / 单调序列（monotonic seq）
  - 适用：清算触发门槛、价格新鲜度门槛、deadline/到期、cooldown、限频等
- **链上代码中避免出现秒级时间**（即使是“非敏感/仅观测”位置也不建议保留，避免团队与集成侧混淆语义）
  - 如果现有 ABI/事件字段名仍叫 `blockNumber`（历史遗留），也必须在文档与前端侧明确：**该字段不是门槛语义，不得用于资金动作判断**

### 为什么要“连非敏感位置也统一”

- 避免出现“某处用秒、某处用块”的混合口径，导致：
  - 工程实现误用（把观测字段误当门槛）
  - 前端/keeper/风控系统误判（把 blockNumber 当 deadline）
  - 审计与回归测试成本上升（同一语义多实现、多边界）

---

## 墙钟时间对齐（方案 1）：链上用 block 门槛，链下做 ETA 映射与调度（推荐且已选用）

### 链上（合约）统一口径

- 只存/只校验：
  - `maturityBlock`（到期区块）
  - `deadlineBlock`（截止区块）
  - `maxAgeBlocks`（最大新鲜度/缓存年龄）
- **只输出 block 口径的 meta（推荐作为 SSOT 返回值/事件字段）**：
  - `updateBlock`：该数据/快照“写入或最后更新”发生的区块高度（链上写入路径设置为 `block.number`）
  - `ageBlocks`：不作为存储字段（避免重复），由读侧按 `ageBlocks = currentBlock - updateBlock` 计算
  - `isValid`：缓存/快照是否可用（不等于“门槛已满足”，仅表示“数据新鲜度/可用性”）
- 任何“是否到期/是否过期/是否可清算/是否允许动作”的判断都必须基于 `block.number`（或 round/epoch 单调性），**不得**使用秒差比较。
- **禁止链上输出“墙钟语义字段”**：
  - 禁止输出 `timestamp/secondsSince/daysSince/hoursSince` 等字段（即使只是观测）
  - UI 需要“约 X 分钟/天”只能通过链下 ETA 映射估算（见下文 & `docs/FRONTEND_CONTRACTS_INTEGRATION.md`）

### 链下（前端 / keeper / 服务）统一口径

- 用当前链的“平均出块时间”估算墙钟 ETA：
  - `ETA = now + (deadlineBlock - currentBlock) * avgBlockTimeSeconds`
- 用 blocks 计算“年龄/剩余”并映射为展示值（估计）：
  - `ageBlocks = currentBlock - updateBlock`
  - `ageSecondsApprox = ageBlocks * avgBlockTimeSeconds`
- keeper 的“计算机时间/NTP 时间”**只用于调度**（什么时候发交易），不用于链上判定。

### 命名规范（强制；避免前端/keeper 误用）

- **门槛语义字段必须用**：`...Block` / `...Blocks`
  - 例：`deadlineBlock`、`maturityBlock`、`maxAgeBlocks`、`cooldownBlocks`、`executeAfterBlock`
- **观测/元数据字段必须用**：`updateBlock` / `cacheBlock` / `blockNumber`
  - 其中 `blockNumber` 若为历史遗留字段名，必须在 NatSpec/文档标注为“观测字段（emission marker）”，不得参与门槛判断
- **禁止使用**：`timestamp` / `daysSince` / `hoursSince` 等“墙钟语义命名”
- **事件/返回值建议（新接口统一按此设计）**：
  - 事件尽量携带 `blockNumber`（或 `updateBlock`），不要用 `ts`/`timestamp`
  - 若历史遗留事件仍带 `ts`：必须视为“仅用于链下索引/展示的观测字段”，不得作为任何链上门槛或 keeper 触发条件的语义来源

### 优缺点（务必写清楚给产品/运营/用户）

- **优点**：安全边界硬、实现简单、审计清晰（门槛不可被出块者通过秒级时间漂移卡边界）。
- **缺点**：墙钟时间是估计值；极端拥堵/停摆会漂移（但这反映了链本身的可用性：墙钟再精准也无法强制链出块）。

### 前端配合落点（必须同步）

- 前端需要做的 “ETA 映射/展示/提示/keeper 调度约定” 已写入：
  - `docs/FRONTEND_CONTRACTS_INTEGRATION.md`（新增：Block-based deadline & ETA 映射章节）

---

## 威胁模型（为什么秒级时间有风险）

秒级时间在协议规则允许的范围内可被出块者调整，这意味着：

- “新鲜度窗口”可能被人为满足或破坏。
- “冷却期在某时间轴到期”的门槛可能被提前/延后触发（在允许漂移范围内）。
- 任何形如 `require(block.timestamp - X <= Y)` 的门槛都会在一定程度上变得可操控（在协议允许的漂移范围内）。

当该判断影响到以下结果时风险尤为突出：

- 清算/抵押品检查
- 价格有效性与资产估值
- 保护资金安全的限速/限频机制
- 治理/升级窗口

---

## 分级：哪些必须改，哪些可以保留

### MUST：必须改（安全关键）

任何使用秒级时间来决定用户是否可以：

- 发生资金动作（withdraw/repay/settle 等）
- 被清算或不被清算
- 被判定为健康/不健康
- 通过“新鲜度条件”绕过检查

### SHOULD：建议改（工程/运营风险高）

- 用于链上决策路径的缓存过期判断
- 在**写状态交易**中用“重试延迟/超时”来改变分支选择

### CAN：可以保留（非关键/观测用途）

- 本项目建议 **也不要保留** 秒级时间（即使只是观测/事件），统一以 `block.number` 作为“时间轴”。
- 若历史遗留字段名仍为 `blockNumber`，必须明确其仅为“观测字段”，不得参与任何资金动作门槛判断（前端按 ETA 映射与提示语义处理）。

---

## 推荐改造模式

### 模式 A： “秒级年龄” → “区块年龄”（推荐用于链上过期/新鲜度）

把下面这种做法：

- `maxAgeSeconds` + `block.number - t`

替换为：

- `maxAgeBlocks` + `block.number - updateBlock`

好处：

- `block.number` 不像秒级时间那样具有可调空间。
- 避免 L2 sequencer 秒级时间与真实墙钟时间的漂移导致误判。

代价：

- “区块数 → 秒数”的换算与链的平均出块时间相关，治理侧必须按链配置合适的 `maxAgeBlocks`。

### 模式 B：在预言机边界强制过期（推荐用于估值流水线）

不要在每个调用方重复实现“过期检查”。

改为：

- 由预言机合约本身强制过期，并用明确的错误（例如 `StalePrice`）revert
- 调用方把预言机失败视为“降级估值路径”（best-effort），而不是再做一遍 blockNumber 检查

这样可以把“过期语义”单点化（SSOT），更易审计与一致性验证。

### 模式 C：使用明确的 epoch/round id（当数据源支持时）

如果你接入 Chainlink / TWAP / 其他 adapter：

- 优先使用数据源返回的 `roundId`、`updatedAt` 等信息
- 存储并检查**round/epoch 的单调性**（monotonicity）

即便如此，也应避免在链上使用“秒级时间差”作为资金动作门槛。

### 模式 D：用单调性约束替代墙钟时间约束

如果输入里带有 blockNumber（例如链下报价块高），不要用它与 `block.number` 进行比较。

改为：

- 强制单调性：新 blockNumber 必须 `>= previousBlockNumber`
- 过期/新鲜度依赖 update block（区块高度）

这样既能防止 blockNumber 回退带来的问题，又避免了秒级时间差计算。

---

## 本仓库 SSOT：预言机过期语义的迁移方案

本仓库已将核心价格存储的“过期判断”迁移为基于区块高度的口径：

### `IPriceOracle`

- `AssetConfig.maxPriceAge` → `AssetConfig.maxPriceAgeBlocks`
- `PriceData.blockNumber` 保留为**信息字段**（链下报价块高），不用于过期判断
- 增加显式 update block API：
  - `getPriceUpdateBlock(asset)`
  - `getPriceUpdateBlocks(assets)`

### `src/core/PriceOracle.sol`

- 在写入时存储 `_lastUpdateBlock[asset] = block.number`
- 以区块数强制过期：
  - 当 `block.number - lastUpdateBlock > maxPriceAgeBlocks` 时视为 stale
- 保留 `updatePrice/updatePrices` 的 `blockNumber` 参数，但仅作为：
  - 单调性约束（初始化后不得回退）
  - 不与 `block.number` 做比较

### `src/libraries/GracefulDegradation.sol`

- 移除所有基于 `block.number` 以外时间轴的过期判断
- 使用预言机边界（`IPriceOracle.getPrice`）作为过期门槛
- 缓存改为存储 `updateBlock`（而不是 blockNumber）
- 缓存过期判断改为：
  - `block.number - updateBlock > maxAgeBlocks`
- best-effort 读取 `updateBlock`（`IPriceOracle.getPriceUpdateBlock(asset)`）：
  - 失败返回 `0`，视为 unknown

---

## 迁移清单：其他任何“时间相关模块”应如何改

### Step 1：盘点

搜索关键字：

- **全仓直搜（你要求的 `blockNumber` 入口，命中最多）**
  - `blockNumber`
  - `block.number`
- **本仓库“时间门槛/时间窗”典型形态（由 `block.number` 命中反推）**
  - 缓存/TTL：`block.number - bn <= ...`
    - 相关常量/字段（本仓库现有命名）：`ViewConstants.CACHE_DURATION`、`_CACHE_DURATION`、`SYNC_INTERVAL`、`CACHE_MAX_AGE`、`cacheTimestamp`、`cacheTimestamps`
  - 过期：`block.number > expireAt`（见 `SettlementIntentLib`）
  - “提前/按时窗口”：`block.number + ... < ord.maturity`（见 `LendingEngine` / `SettlementManager`）
  - Timelock/治理延迟：`executeAfter = block.number + minDelay`（见 `Registry`）
  - 升级窗口：`_upgradeEnabledUntil = block.number + UPGRADE_WINDOW`（见 `DegradationMonitor`）
- **Solidity 时间字面量（本仓库确实存在）**
  - `... / 1 days`
  - `... <= 5 minutes`（以及 `seconds/minutes/hours/days/weeks` 这类后缀）
  - `... days / 2 seconds` / `... hours / 2 seconds`（典型“隐含每块 X 秒”的 seconds→blocks 换算；**禁止**，必须迁移为显式 `...Blocks` 配置）
- **本仓库实际出现的 `*blockNumber*` 标识符（建议直接搜这些，能快速定位到“时间语义字段”）**
  - `positionBlockNumber`, `healthBlockNumber`
  - `_cacheBlockNumbers`, `_userCacheBlockNumbers`, `_systemCacheBlockNumber`, `_systemCacheBlockNumbers`
  - `cacheBlockNumber`, `cacheBlockNumbers`
  - `_lastSyncBlockNumber`, `lastSyncBlockNumber`
  - `startBlockNumber`
  - `PriceOracle__InvalidBlockNumber`, `CoinGeckoPriceUpdater__InvalidBlockNumber`
- **测试/脚本里的“时间推进/取链上时间”（本仓库命中项）**
  - 时间推进：`evm_increaseTime`（通常配合 `evm_mine`）
  - OZ helpers：`time.increase` / `time.increaseTo`
- 读区块号：`getBlock(...).number` / `latestBlock.number`
- **补充：本仓库实际出现的“窗口/到期语义命名”（用于排查非 `blockNumber` 字段的时间门槛）**
  - `expireAt`, `maturity`, `_lockedMaturity`, `_lockedMaturityByOrderId`
  - `_cooldown`, `_initializeCooldown`, `setCooldown`, `getCooldown`
  - `cacheExpiryTime`, `_CACHE_EXPIRY_TIME`

### Step 1A：全仓 `timestamp` 命中文件清单（共 185 个）

以下为本次全仓扫描 `timestamp` 的**完整文件列表**（相对仓库根目录）。统一以任务清单形式标记：

- [x] `docs/Usage-Guide/PriceOracle-Guide.md`
- [x] `src/core/CoinGeckoPriceUpdater.sol`
- [x] `src/Vault/view/modules/AccessControlView.sol`
- [x] `src/Vault/liquidation/modules/SettlementManager.sol`
- [x] `src/Vault/liquidation/modules/LiquidationRiskManager.sol`
- [x] `src/interfaces/IPriceOracle.sol`
- [x] `src/Vault/view/modules/DashboardView.sol`
- [x] `src/Vault/view/modules/UserView.sol`
- [x] `src/Vault/view/modules/RiskView.sol`
- [x] `src/Vault/view/modules/ValuationOracleView.sol`
- [x] `src/core/PriceOracle.sol`
- [x] `src/interfaces/IRWAPriceOracle.sol`
- [x] `src/interfaces/IPositionView.sol`
- [x] `src/interfaces/IVaultRouter.sol`
- [x] `src/Vault/view/modules/ModuleHealthView.sol`
- [x] `src/Vault/modules/lendingEngine/LendingEngineCore.sol`
- [x] `src/Vault/view/modules/StatisticsView.sol`
- [x] `src/interfaces/ILiquidationRiskManager.sol`
- [x] `src/Vault/view/modules/RewardView.sol`
- [x] `src/Vault/view/modules/EventHistoryManager.sol`
- [x] `src/Vault/view/modules/PreviewView.sol`
- [x] `src/Vault/view/modules/CacheOptimizedView.sol`
- [x] `src/Vault/SystemEvents.sol`
- [x] `src/interfaces/IResidualAllocation.sol`
- [x] `src/interfaces/IEarlyRepaymentGuaranteeManager.sol`
- [x] `src/interfaces/IPriceOracleAdapter.sol`
- [x] `src/Vault/view/modules/HealthView.sol`
- [x] `src/Vault/view/modules/PositionView.sol`
- [x] `src/Vault/view/modules/FeeRouterView.sol`
- [x] `src/Reward/configs/TestnetFeaturesConfig.sol`
- [x] `src/Governance/CrossChainGovernance.sol`
- [x] `src/Token/EasyToken.sol`（奖励通证；SSOT = `Registry[KEY_EASY_TOKEN]`）
- [x] `src/Reward/RewardManagerCore.sol`
- [x] `src/Mocks/MockLiquidationEventsView.sol`
- [x] `src/interfaces/ILiquidationEventsView.sol`
- [x] `src/libraries/EventLibrary.sol`
- [x] `src/Mocks/MockCollateralManager.sol`
- [x] `src/Mocks/MockLiquidationManager.sol`
- [x] `src/Mocks/MockLendingEngineBasic.sol`
- [x] `src/Mocks/MockStatisticsView.sol`
- [x] `src/Mocks/BatchViewMocks.sol`
- [x] `src/Mocks/MockUserViewDeps.sol`
- [x] `src/Mocks/MockPositionViewRoleGated.sol`
- [x] `src/Mocks/MockPositionView.sol`
- [x] `scripts/deploy/deploy-arbitrum-sepolia.ts`
- [x] `scripts/e2e/e2e-localhost-batch-10-users.ts`
- [x] `scripts/e2e/e2e-localhost-reward-edgecases.ts`
- [x] `scripts/e2e/e2e-localhost-batch-advanced-10-users.ts`
- [x] `scripts/e2e/e2e-localhost-attack-suite.ts`
- [x] `scripts/tests/funds-flow-invariants-suite.ts`
- [x] `scripts/tests/funds-flow-smoke-local.ts`
- [x] `scripts/tests/funds-flow-smoke-conservation.ts`
- [x] `src/Vault/view/modules/LendingEngineView.sol`
- [x] `src/strategies/RWAAutoLeveragedStrategy.sol` (canonical; Token/ copy removed)
- [x] `src/Mocks/MockAccessControlManager.sol`
- [x] `src/monitor/DegradationMonitor.sol`
- [x] `src/monitor/DegradationStorage.sol`
- [x] `src/monitor/DegradationCore.sol`
- [x] `src/Reward/RewardManager.sol`
- [x] `src/Vault/liquidation/modules/LiquidationConfigManager.sol`
- [x] `src/Vault/modules/VaultBusinessLogic.sol`
- [x] `test/Vault/view/modules/RewardView.test.ts`
- [x] `scripts/tests/deploy-gold-silver.ts`
- [x] `test/Vault/view/FeeRouterView.test.ts`
- [x] `test/Vault/VaultLendingEngine.refactor.test.ts`
- [x] `test/Vault/liquidation/LiquidationRiskManager.graceful-degradation.test.ts`
- [x] `test/Vault/view/BatchView.test.ts`
- [x] `src/registry/RegistryStorageLibrary.sol`
- [x] `test/Vault/modules/GuaranteeFundManager.test.ts`
- [x] `test/Vault/view/ViewCache.test.ts`
- [x] `scripts/e2e/e2e-localhost-liquidatorview-acceptance.ts`
- [x] `test/Vault/view/LiquidationRiskView.test.ts`
- [x] `test/Vault/view/modules/EventHistoryManager.test.ts`
- [x] `scripts/e2e/e2e-localhost-run.ts`
- [x] `src/registry/Registry.sol`
- [x] `src/Vault/view/modules/LiquidationRiskView.sol`
- [x] `src/Mocks/MockPriceOracle.sol`
- [x] `test/Vault/view/DashboardView.test.ts`
- [x] `scripts/tests/lendingengine-smoke-local.ts`
- [x] `scripts/tests/preconfig-strict-smoke-local.ts`
- [x] `src/Mocks/RegistryStorageTestHelper.sol`
- [x] `test/StatisticsView.comprehensive.test.ts`
- [x] `src/access/AssetWhitelist.sol`
- [x] `scripts/e2e/utils/view-scan.ts`
- [x] `test/Registry.test.ts`
- [x] `src/Vault/VaultRouter.sol`
- [x] `test/VaultRouter.concurrent-update-phase0.test.ts`
- [x] `test/Vault/view/ValuationOracleView.test.ts`
- [x] `src/Mocks/MockStatisticsViewUserSnapshot.sol`
- [x] `src/Mocks/RegistryStorageDelegator.sol`
- [x] `src/Vault/modules/CollateralManager.sol`
- [x] `scripts/tests/viewcache-smoke-local.ts`
- [x] `src/Vault/view/modules/ViewCache.sol`
- [x] `src/Vault/view/README.md`
- [x] `frontend-config/registry-service.ts`
- [x] `test/Vault/VaultLendingEngine.dual-entry.test.ts`
- [x] `test/Vault/view/modules/ModuleHealthView.test.ts`
- [x] `src/Mocks/MockRWAPriceOracle.sol`
- [x] `scripts/tests/funds-flow-smoke-create-order.ts`
- [x] `scripts/trace-deposit.ts`
- [x] `test/fixed-tests/VaultStatisticsFixed.test.ts`
- [x] `scripts/e2e/e2e-localhost-batch-aggregators-acceptance.ts`
- [x] `scripts/e2e/e2e-localhost-statisticsview-acceptance.ts`
- [x] `test/core/PriceOracle.new.test.ts`
- [x] `test/core/CoinGeckoPriceUpdater.test.ts`
- [x] `test/Vault/view/HealthView.test.ts`
- [x] `src/Mocks/RegistryStorageLibraryHarness.sol`
- [x] `scripts/e2e/e2e-localhost-scenario-matrix.ts`
- [x] `test/Vault/view/UserView.test.ts`
- [x] `scripts/e2e/e2e-localhost-viewcache-acceptance.ts`
- [x] `src/Mocks/MockGracefulDegradationMonitor.sol`
- [x] `src/interfaces/IRegistry.sol`
- [x] `src/Reward/RewardEvents.sol`
- [x] `src/Reward/RewardTypes.sol`
- [x] `scripts/e2e/e2e-localhost-eventhistorymanager-acceptance.ts`
- [x] `scripts/e2e/e2e-localhost-modulehealthview-acceptance.ts`
- [x] `test/Vault/liquidation/Liquidation.failure-scenarios.test.ts`
- [x] `src/Vault/view/modules/LiquidatorView.sol`
- [x] `src/Vault/liquidation/modules/LiquidationConfigModule.sol`
- [x] `src/Vault/modules/EarlyRepaymentGuaranteeManager.sol`
- [x] `src/core/LoanEvents.sol`
- [x] `test/EarlyRepaymentGuaranteeManager.test.ts`
- [x] `scripts/e2e/e2e-localhost-feerouterview-acceptance.ts`
- [x] `scripts/e2e/e2e-localhost-orderflow.ts`
- [x] `scripts/e2e/e2e-localhost-healthview-acceptance.ts`
- [x] `docs/FRONTEND_CONTRACTS_INTEGRATION.md`
- [x] `scripts/e2e/e2e-localhost-matchflow.ts`
- [x] `scripts/e2e/e2e-localhost-full-with-views.ts`
- [x] `scripts/e2e/e2e-localhost-reward-privacy.ts`
- [x] `scripts/e2e/e2e-localhost-rewardview-acceptance.ts`
- [x] `scripts/e2e/README.md`
- [x] `docs/PlatformLogic.md`
- [x] `src/Vault/view/modules/BatchView.sol`
- [x] `docs/Test-Guide/lending-engine-testing-guide.md`
- [x] `docs/Test-Guide/vaultview-testing-guide.md`
- [x] `docs/Usage-Guide/Reward-System-Usage-Guide.md`
- [x] `docs/Usage-Guide/User-Dimensional-View-Read-Policy-Guide.md`
- [x] `docs/SmartContractStandard.md`
- [x] `docs/Usage-Guide/Lending-Guide.md`
- [x] `docs/Usage-Guide/Liquidation/liquidation-reward-penalty.md`
- [x] `docs/Usage-Guide/Liquidation/Liquidation-Threshold-Guide.md`
- [x] `src/Vault/README.md`
- [x] `scripts/e2e/utils/view-preflight.ts`
- [x] `scripts/e2e/utils/systemview-route-assert.ts`
- [x] `scripts/e2e/e2e-localhost-valuationoracleview-acceptance.ts`
- [x] `test/Vault/view/CacheOptimizedView.test.ts`
- [x] `test/Vault/view/RiskView.test.ts`
- [x] `src/Vault/view/VIEW-AUDIT-FIXES.md`
- [x] `docs/GuaranteeFundImplementation.md`
- [x] `test/StatisticsView.guarantee-aggregation.test.ts`
- [x] `docs/Test-Guide/view-layer-testing-guide.md`
- [x] `src/Mocks/MockRiskViewDeps.sol`
- [x] `scripts/debug-deposit-path.ts`
- [x] `src/Mocks/HealthViewMocks.sol`
- [x] `scripts/utils/saveAddress.ts`
- [x] `scripts/e2e/e2e-localhost-positionview-acceptance.ts`
- [x] `docs/Usage-Guide/Audit-Grade-NatSpec-Guide.md`
- [x] `scripts/e2e/e2e-localhost-accesscontrolview-acceptance.ts`
- [x] `src/Mocks/MockVaultCoreView.sol`
- [x] `src/Mocks/MockVaultRouter.sol`
- [x] `docs/Usage-Guide/Registry-Guide.md`
- [x] `test/Registry-History-Buffer.test.ts`
- [x] `docs/Offchain-View-Consumer-Retry-Audit-Design.md`
- [x] `docs/Cache-Push-Manual-Retry.md`
- [x] `docs/Usage-Guide/Liquidation/liquidation-complete-logic.md`
- [x] `deployments/addresses.arbitrum-sepolia.json`
- [x] `src/Mocks/MockRewardViewDeps.sol`
- [x] `src/Mocks/MockEventsView.sol`
- [x] `scripts/utils/README.md`
- [x] `scripts/utils/verificationUtils.ts`
- [x] `scripts/utils/logger.ts`
- [x] `scripts/utils/deploymentUtils.ts`
- [x] `scripts/manual-tests/test_interface.js`
- [x] `docs/test-file-standards.md`

Step 1 盘点 checklist（time/hash：not-rely-on-time）
缓存 TTL / View 快照有效性 / 同步间隔（cache TTL）
Vault View 模块（大量是 CACHE_DURATION / SYNC_INTERVAL / blockNumber 有效性判断）
src/Vault/view/modules/AccessControlView.sol: 153, 180, 295
src/Vault/view/modules/EventHistoryManager.sol: 116
src/Vault/view/modules/FeeRouterView.sol: 247, 283, 284, 286, 312, 314, 359, 360, 387, 407, 958, 962
src/Vault/view/modules/HealthView.sol: 192, 193, 222, 270, 309, 457
src/Vault/view/modules/LendingEngineView.sol: 290
src/Vault/view/modules/LiquidationRiskView.sol: 331
src/Vault/view/modules/LiquidatorView.sol: 1446 (同一行有 2 个命中：1446:43 / 1446:71)
src/Vault/view/modules/ModuleHealthView.sol: 177, 314
src/Vault/view/modules/PositionView.sol: 526, 527, 530, 531, 575, 576, 579, 580, 602, 603, 606, 607, 648, 649, 652, 653, 903, 919, 961
src/Vault/view/modules/RewardView.sol: 507, 1658, 1659, 1663
src/Vault/view/modules/RiskView.sol: 229
src/Vault/view/modules/StatisticsView.sol: 249, 473, 507, 727, 730, 762, 763, 820, 821, 845, 846, 921, 1008, 1085, 1337
src/Vault/view/modules/UserView.sol: 189, 198
src/Vault/view/modules/ValuationOracleView.sol: 457
src/Vault/view/modules/ViewCache.sol: 161, 195, 258
ts 命名收敛（src/Vault/view/**）
- 说明：统一将局部变量/参数名 `ts` 改为 `blockNumber`（语义仍为区块号）
- 变更文件：`RewardView.sol`、`FeeRouterView.sol`、`PositionView.sol`、`HealthView.sol`、`CacheOptimizedView.sol`、
  `UserView.sol`、`StatisticsView.sol`、`ModuleHealthView.sol`、`RiskView.sol`、`ValuationOracleView.sol`、`DashboardView.sol`
- 结果：`src/Vault/view/**` 下不再存在独立的 `ts` 命名；范围过滤字段也统一为 block 口径命名（例如 `fromBlock/toBlock`），避免误读为 timestamp 秒
清算域的模块地址/依赖缓存（同样是 TTL）
src/Vault/liquidation/libraries/ModuleCache.sol: 234, 237, 281, 283, 290, 593, 597, 644, 648
src/Vault/liquidation/libraries/LiquidationRiskQueryLib.sol: 54, 55
src/Vault/liquidation/modules/LiquidationConfigManager.sol: 284, 428, 449, 515, 529, 609, 621, 622
src/Vault/liquidation/modules/LiquidationConfigModule.sol: 77, 108, 138
src/Vault/liquidation/modules/LiquidationRiskManager.sol: 220, 290, 298, 318, 355, 634, 726, 831, 832
通用 TTL 工具
src/Vault/utils/SystemUtils.sol: 204, 224, 227
Timelock / 治理延迟 / 升级窗口（timelock / upgrade window）
Registry timelock
src/registry/Registry.sol: 599, 619, 879, 914, 972 (同一行 2 个命中：972:13 / 972:97), 1028, 1068
跨链治理/窗口
src/Governance/CrossChainGovernance.sol: 168, 204 (同一行 2 个命中：204:13 / 204:53), 220, 247, 252, 438, 442
降级/升级窗口
src/monitor/DegradationMonitor.sol: 285, 335, 497, 519, 531
src/monitor/DegradationCore.sol: 231, 253, 261, 262
src/monitor/DegradationStorage.sol: 233, 280, 297, 315, 317
贷款到期 / 还款窗口 / “提前/按时”判定（maturity / repayment window）
核心放款/还款状态机
src/core/LendingEngine.sol: 317, 345, 366, 395, 403, 432, 486, 532, 557, 647, 653, 662, 681, 884, 890, 917, 923, 1002
清算结算（含 maturity window 分支）
src/Vault/liquidation/modules/SettlementManager.sol: 343, 363, 378, 446
src/Vault/liquidation/modules/LiquidationManager.sol: 492, 523, 611, 650
LoanNFT 侧的时间字段/逻辑（生命周期区块号）
src/core/LoanNFT.sol: 163, 197, 205, 228, 236, 305, 318, 347, 356, 385, 394, 424, 434, 614, 662, 672
Vault 内 lending engine 模块
src/Vault/modules/lendingEngine/LendingEngineAccounting.sol: 58, 102, 149
src/Vault/modules/lendingEngine/LendingEngineCore.sol: 369
src/Vault/modules/VaultLendingEngine.sol: 360, 731, 765, 799, 831, 876
Vault 核心入口/路由（通常是把 blockNumber 作为参数/事件字段传递）
src/Vault/VaultCore.sol: 208, 237, 363, 469
src/Vault/VaultRouter.sol: 247
意向单过期（intent expire）
src/libraries/SettlementIntentLib.sol: 215
预言机/价格更新新鲜度与更新间隔（oracle freshness / update interval）
CoinGecko 更新器（interval / lastUpdateTime）
src/core/CoinGeckoPriceUpdater.sol: 237, 271, 281, 293, 333, 375, 412, 450, 473, 481, 504, 512, 541, 545, 578, 607, 661, 725, 736, 743, 768, 776, 780, 803, 862, 871, 914, 921, 925, 930, 961, 969, 973, 1027
PriceOracle（blockNumber / stale 判定相关）
src/core/PriceOracle.sol: 142, 433, 466, 497, 549, 612, 717
RWA 价格预言机 mock
src/Mocks/MockRWAPriceOracle.sol: 28, 30
降级监控 mock（通常也会读时间）
src/Mocks/MockGracefulDegradationMonitor.sol: 44, 54
Reward / 配置窗口（RewardConfig / EarnConfig）
src/Reward（业务奖励模块）
src/Reward/internal/RewardModuleBase.sol: 90, 96, 106, 111, 119, 124, 132, 137, 145, 150, 158, 163, 171, 176
src/Reward/RewardConfig.sol: 77, 139, 164, 183, 199, 215, 231, 289, 297, 321
src/Reward/RewardManager.sol: 156, 163
src/Reward/RewardManagerCore.sol: 220, 269, 291, 312, 322, 330, 354, 372, 393, 457, 468, 477, 512, 537, 567, 590, 601, 610, 632, 647, 661, 704, 741, 781, 819, 838, 862, 1010, 1016, 1018, 1060, 1091, 1093
src/Reward/EasyConsumption.sol
src/Reward/EasyEmissionConfig.sol
src/Reward/EasyEmissionController.sol
src/Reward/EasyRecycleDistributor.sol
src/Reward/EasyStaking.sol
EasyToken / 策略（时间相关业务逻辑；奖励通证 SSOT = `Registry[KEY_EASY_TOKEN]`）
src/Token/EasyToken.sol
src/strategies/RWAAutoLeveragedStrategy.sol: 242, 281, 282, 290, 310, 350, 367, 398, 399
src/Reward/configs/EarnConfig.sol
白名单/权限窗口（whitelist / authority window）
src/access/AssetWhitelist.sol: 173, 261, 309, 366, 428, 496, 538, 603
src/AuthorityWhitelist.sol: 69, 86, 104, 139, 147, 182
费用/路由相关（通常用于“同步/观测”但仍是时间依赖命中）
src/Vault/FeeRouter.sol: 282, 499, 541, 582, 614, 652, 680, 701, 719, 749, 775, 1064
src/Vault/VaultAdmin.sol: 116

### Step 2：选择适用模式

- 过期/有效性 → 模式 A 或 B
- 冷却期/归属期窗口 → 优先 `block.number` 或确定性 epoch 计数器
- 超时/重试延迟 → 尽量移除，或迁移到链下调度（offchain scheduler）

#### Step 2A：按“Step 1 盘点命中类型”选择模式（SSOT 决策表）

> 本表用于把你在 Step 1 盘点出来的命中点**快速归类 → 选模式 → 决定是否允许保留为观测字段**。
> 约束：本项目目标是 **链上门槛不依赖 `block.number` 以外时间轴**；即便需要墙钟时间展示，也应迁移到链下 ETA 映射。

| 盘点类型（来自 Step 1） | 推荐模式 | 是否允许保留为观测字段 | 落地要点（简写） |
| --- | --- | --- | --- |
| **缓存 TTL / View 快照有效性 / 同步间隔**（`CACHE_DURATION` / `SYNC_INTERVAL` / `isValid`） | **A**（秒→块） | **谨慎允许**：仅观测，不得做门槛 | 把 `ts` 改为 `updateBlock`；把 `CACHE_DURATION`/`SYNC_INTERVAL` 改为 `...Blocks`；Validity 用 `block.number - updateBlock`。 |
| **清算域的模块地址/依赖缓存 TTL**（`ModuleCache` / `LiquidationRiskQueryLib` 等） | **A**（秒→块） | **不建议保留**（清算域应最硬） | 清算/风险判定必须 block-based；缓存 aging 改为 blocks；必要时引入 epoch/seq（C/D）但不要秒差门槛。 |
| **Timelock / 治理延迟 / 升级窗口**（`Registry` / `CrossChainGovernance` / `DegradationMonitor`） | **A**（秒→块）或 **C**（epoch/round） | **允许**：对外展示用（前端/服务） | 链上存 `executeAfterBlock`/`enabledUntilBlock`；链下用平均出块时间做 ETA 展示；不要在链上保留 `executeAfterTimestamp` 门槛。 |

补充（DegradationMonitor 趋势“最近窗口”的口径）：
- `DegradationMonitor.getSystemDegradationTrends().recentEvents` 的 “recent window” 以 **blocks** 表示，并与 view 层缓存语义对齐：
  - 默认窗口：`ViewConstants.CACHE_DURATION_BLOCKS`
  - 这是链无关的 Strategy A（不要用 seconds/minutes/days）。
| **贷款到期 / 还款窗口 / 提前-按时判定**（`maturity` / `ON_TIME_WINDOW`） | **A**（秒→块）+（可选）**D**（单调性） | **谨慎允许**：若 ABI 历史字段名叫 `blockNumber/maturity` | 把 `maturity` 改为 `maturityBlock`；窗口改为 `windowBlocks`；任何 “+window < maturity” 全部以块计算；如外部仍传入 blockNumber，仅做**单调不回退**约束（D），不得与 `block.number` 比较。 |
| **意向单过期**（`expireAt`） | **A**（秒→块）或 **D**（单调性/序列号） | **不建议保留**（门槛语义） | 把 `expireAt`（blockNumber）迁移为 `expireBlock`；或改为 seq/nonce + 链下调度（D + offchain）。 |
| **预言机/价格新鲜度与更新间隔**（`PriceOracle` / `CoinGeckoPriceUpdater`） | **B**（边界强制过期）+ **A**（updateBlock/ageBlocks）+（可选）**D**（单调 blockNumber） | **允许**：仅作为“数据源观测字段” | SSOT 放在 `IPriceOracle.getPrice`（B）；链上缓存写入存 `lastUpdateBlock`（A）；如仍保留 `PriceData.blockNumber`/`updatePrice(..., blockNumber)`，只能做单调性约束（D），不得秒差门槛。 |
| **Reward / 冷却期 / feature unlock / service config**（`cooldown` 等） | **A**（秒→块）或 **C**（epoch） | **允许**：用于 UI/审计展示 | 若本质是“窗口/周期”，优先 epoch（C）；否则用 `cooldownBlocks`/`unlockBlock`（A）；避免在核心资金路径用 blockNumber。 |

---

### Reward 域时间口径（SSOT，强制）

> 本节用于把 Reward 的“时间口径”与全局约束对齐，避免出现“文档写秒、实现按块”的分叉。

- **统一结论**：Reward 相关的门槛/窗口/到期语义一律使用 block 口径（`termBlocks / maturityBlock / windowBlocks`），不得使用秒级时间或“秒差比较”。
- **按订单回调参数 `maturity` 的语义**：
  - ABI/参数名可能仍叫 `maturity`（历史遗留），但在本仓库实现中其含义是 **`maturityBlock`（到期区块高度）**，不是 unix timestamp。
  - 参见：`src/core/LendingEngine.sol` 对 `LoanOrder.maturity` 的注释，以及 `SettlementManager` 的 `ord.maturity is a maturityBlock` 注释。
  - 注意：如发现接口注释仍写“秒时间戳”（例如 `src/interfaces/IRewardManager.sol` 的 `@param maturity` 描述），应视为 **legacy 文档错误**，需要同步修正以避免外部集成误用。
- **按期窗口（ON_TIME_WINDOW）**：
  - 链上 SSOT 应为 `ON_TIME_WINDOW_BLOCKS`（或同语义变量，例如 `_onTimeWindowBlocks`），其值**必须以“显式 blocks”形式进入链上**（初始化/治理配置）。
  - 文档里允许给“理解/展示用”的近似说明（例如“在某条链上 24h \(\approx\) N blocks（仅用于理解/展示）”），但**不得**把该近似写成合约内的默认常量或 `24 hours / 2 seconds` 这类换算表达式。
- **termDays 的处理（策略 A，对齐全仓口径）**：
  - **链上不做 `days → blocks` 换算**（禁止 `termDays * BLOCKS_PER_DAY`、禁止 `X days / Y seconds`）。
  - 若 UX 需要 `termDays` 输入：链下（前端/keeper/部署脚本）将其映射为 `termBlocks`（或 `termId`），并把 **`termBlocks` 作为唯一门槛语义参数** 传入合约。
  - 链上如需白名单：配置合约存储“允许的 `termBlocks` 集合/范围”，业务合约仅做 membership/range 校验；不要在业务合约里引入任何“每块多少秒/每天多少块”的假设。

---

## ✅ termBlocks SSOT 完整迁移：Matchflow / Intent / Guarantee（本次文档重点）

> 本节把“时间依赖改造”的结论落到 **撮合放款（matchflow）** 这条安全关键资金链：  
> **链上不再接受/推导 termDays→blocks；termBlocks 由链下显式给出，并贯穿意向签名、撮合、放款入账、保证金锁定。**

### 0) 术语与单一事实来源（SSOT）

- **termDays（legacy）**：
  - 仅允许作为 **UX 输入 / 旧 ABI 兼容字段**存在（bucket id / 历史字段名）。
  - termBlocks 方案语义中不再允许链上推导 `termBlocks`，更不得出现 `termDays * BLOCKS_PER_DAY` 这类隐含换算。
- **termBlocks（SSOT）**：
  - 唯一允许进入链上门槛/账本/订单/保证金的期限输入。
  - 时间轴：`block.number`。
- **expireAt（legacy 字段名；语义已迁移）**：
  - 在本仓库所有 intent 相关语义中，`expireAt` 的真实含义是 **expireBlock**：当 `block.number > expireAt` 视为过期。
  - **不是** unix timestamp；前端展示到期时间只能做 ETA 映射（见本文“墙钟时间对齐（方案 1）”）。

### 1) 链下必须显式计算 termBlocks（禁止链上换算）

链下（前端 / keeper / 撮合服务 / 部署脚本）必须内置一张**显式映射表**（“termDays bucket → termBlocks”），并且：

- **必须**与链上 `src/libraries/TermBlocksLib.sol` 的映射一致（否则会出现：签名/撮合可复现性丢失、利息/到期窗口偏差、保证金 maturity 偏差）。
- **必须**作为“网络配置（per-chain）”显式管理（SSOT 必须可追溯、可复现）。

> 你提出的“每天校正”是合理需求：如果链的平均出块时间长期漂移，固定 `termBlocks` 会导致长周期（如 360d）出现显著偏差。
> 本仓库的硬约束是：**链上门槛仍只使用 `block.number`**；但允许链下用“观测到的平均出块时间”对 `termBlocks` 做周期性校正。

#### 推荐（支持按日校正）：链下发布 “TermBlocks 映射快照” 作为 SSOT

- **做法**：
  - 每天（或每 N 小时）由撮合服务/keeper 计算一份当日映射：`termDays(bucket) -> termBlocks`
  - 前端/UI 只从该 SSOT 源拉取映射（不要各自计算），然后把 `termBlocks` 写入并签名到 `BorrowIntentBlocks/LendIntentBlocks` 里
- **为什么这不会破坏链上确定性**：
  - `termBlocks` 本身已经被签进 intent；链上只消费 intent 中的 `termBlocks`（以及匹配约束）
  - 映射的“按日变化”只影响**新签名的意向单**；旧单仍按签名时的 `termBlocks` 执行
- **必须写清楚的工程约束**（避免出现“同一 termDays 两边算出来不一致导致撮合失败”）：
  - borrower 与 lenderSigner 必须使用同一份映射快照（同一 SSOT 源 / 同一版本）
  - 如果不同客户端使用不同校正算法，最坏情况不是“被攻击”，而是 **intent 无法被匹配**（min/maxTermBlocks 不满足）

#### 校正算法（链下）建议（仅供实现；链上禁止）

- 用最近 \(M\) 个区块的均值/EMA 估计 `avgBlockTimeSeconds`
- 目标：让“名义 termDays”尽量接近墙钟天数：
  - `termBlocks = round(termDays * 86400 / avgBlockTimeSeconds)`
- 仍需保持“允许 bucket 集合”不变（只校正 blocks 数值），并对 `termBlocks` 设置上下限（避免异常网络导致跳变）

#### 对外展示口径（前端/keeper 必须一致）

- **链上确定值（可审计、不可歧义）**：
  - `termBlocks`、`maturityBlock = startBlock + termBlocks`、`expireAt`（语义为 expireBlock）
- **前端展示值（仅 ETA，必须标注“估计”）**：
  - `ETA ≈ now + (maturityBlock - currentBlock) * avgBlockTimeSeconds`
  - 以及“剩余 blocks”：`blocksLeft = maturityBlock - currentBlock`（确定值，推荐与 ETA 并行展示）

#### Baseline（兼容/测试用）映射：来自 `TermBlocksLib.termDaysToBlocks`

> 说明：下表是 **代码仓库当前的 baseline 映射**（例如 legacy bucket 或本地测试可参考）。  
> 在 termBlocks SSOT 方案中，**真正的 SSOT 是链下发布的 termBlocks 快照**（按日校正/按版本统一），而不是本表常量。

| termDays（bucket） | termBlocks（SSOT） |
| --- | ---: |
| 5 | 36,000 |
| 10 | 72,000 |
| 15 | 108,000 |
| 30 | 216,000 |
| 60 | 432,000 |
| 90 | 648,000 |
| 180 | 1,296,000 |
| 360 | 2,592,000 |

> 注意：
> - UI 可继续展示 “5/10/15/30/…” 天作为用户输入（bucket），但**签名与链上交互必须以 `termBlocks` 为准**。
> - “到期时间/剩余天数”只能按 blocks→ETA 映射展示，并明确为估计值。

### 2) termBlocks Intent（EIP-712）结构与哈希：BorrowIntentBlocks / LendIntentBlocks

termBlocks intent 的 struct 与 type string 已在 `src/libraries/SettlementIntentLib.sol` 定义（**字段顺序是强约束**）：

- **BorrowIntentBlocks**：包含 `termBlocks`
- **LendIntentBlocks**：包含 `minTermBlocks/maxTermBlocks`

并提供哈希函数：

- `hashBorrowIntentBlocks(BorrowIntentBlocks)`
- `hashLendIntentBlocks(LendIntentBlocks)`

关键约束：

- **verifyingContract**（EIP-712 域分离）必须使用**撮合入口合约**（例如 `VaultBusinessLogic`）的地址，而不是 library 地址。
- `expireAt` 字段名保留是为了签名兼容，但语义必须当作 **expireBlock**。

### 3) termBlocks 撮合入口与资金链路（从 termDays → termBlocks）

迁移目标是把 matchflow 的 SSOT 从：

- legacy：`finalizeMatch(BorrowIntent{termDays}, LendIntent{min/maxTermDays})`  

迁移为：

- termBlocks 方案：撮合入口使用包含 `termBlocks` 的 intent 结构（`BorrowIntentBlocks/LendIntentBlocks`），并以 block 口径完成期限与到期语义传递。

并且在原子 finalize 过程中（以 blocks 为时间轴 SSOT）：

- 订单创建/记账使用 `termBlocks`
- 借款账本写入使用接收 `termBlocks` 的入口（例如 `borrowForWithTermBlocks(..., termBlocks)`；legacy `borrowFor(..., termDays)` 仅用于兼容）

### 4) termBlocks Guarantee（提前还款保证金）锁定：termBlocks 贯穿 maturity

保证金记录的 `startTime/maturityTime` 是 legacy 字段名，但语义已是 `startBlock/maturityBlock`。

迁移目标：

- legacy：`EarlyRepaymentGuaranteeManager.lockGuaranteeRecord(..., termDays)`（内部再映射 termBlocks）
- termBlocks 方案：保证金锁定入口应接收 `termBlocks`（不再链上换算）

并且 maturity 计算 SSOT 为：

- `maturityBlock = startBlock + termBlocks`

### 5) 迁移验收（必须满足）

- **链上**：
  - 关键资金链路不出现 `termDays * ...` 或任何 days/seconds→blocks 推导
  - `termBlocks` 进入：intent hash / match finalize / 借款入账 / guarantee maturity
- **链下（前端/keeper）**：
  - 明确持有 `termDays bucket → termBlocks` 映射（显式表）
  - termBlocks intent 全量签名与复现（BorrowIntentBlocks / LendIntentBlocks）
  - 所有“到期/过期/有效性”展示以 blocks + ETA 映射为准（`expireAt` 视为 expireBlock）

| **白名单/权限窗口**（`AssetWhitelist` / `AuthorityWhitelist`） | **A**（秒→块） | **不建议保留**（边界清晰） | 任何 allowlist gate 应 block-based（或 epoch）；如果是“治理生效延迟”，按 timelock 类处理（A/C）。 |
| **费用/路由相关（同步/观测）**（`FeeRouter` / `FeeRouterView`） | **C**（epoch/round）或 **A**（syncBlocks） | **允许**：观测字段 | 若需要“按周期结算/统计”，用 epoch（C）；若只是“多久刷新一次”，用 blocks（A）。 |

#### Step 2B：统一规则（关于“是否允许保留为观测字段”）

- **严禁**：任何影响资金动作/清算/估值门槛的逻辑，使用 `block.number` 以外时间轴或 “秒差比较”。
- **允许但必须标注为观测字段**（legacy/兼容场景）：ABI/事件/返回值里仍叫 `blockNumber` 的字段，只能表示“观测时间/链下报价时间/缓存写入时点”，不得作为门槛；并优先补充 block 口径字段（例如 `updateBlock` / `blockNumber` / `...Block`）。
- **推荐落点**：统一把门槛语义迁移为 `...Block` / `...Blocks`；前端与 keeper 用 ETA 映射展示与调度（见本文“墙钟时间对齐（方案 1）”）。

#### Step 2C：逐文件执行记录（把 Step 1 清单落成可执行“一行一条”）

> 字段说明：
>
> - **语义**：这个文件里“时间”是在表达什么（TTL/到期/治理窗口/新鲜度/冷却期/仅事件观测等）
> - **门槛/观测**：是否参与链上 gate（资金/清算/估值/权限等）；若不是 gate，必须显式标为观测字段
> - **模式**：A/B/C/D（见 Step 2A）
> - **SSOT（权威判定位置）**：最终“是否过期/是否可执行/是否按期”等由哪个合约/函数裁决（避免多处重复实现）
> - **新增字段名（建议）**：改造落地时优先采用的字段命名（用于 Step 3 汇总）
>
> 注意：这里的 **A/B/C/D** 是“时间改造模式”，与 `docs/Architecture-Guide.md` 里“缓存分类 A/B/C”不是同一套含义。

执行状态标记（合约层面）：

- `[x] ✅ DONE`：未发现**可执行代码**使用非 `block.number` 时间轴作为门槛；关键口径已迁移为 block-based（`block.number` / `...Block(s)`）。
- `[ ] TODO`：仍存在非 `block.number` 时间轴（含 cache TTL/同步间隔/事件时间轴等）或仍以“秒”作为链上门槛语义，需要按本文规则迁移为 blocks/epoch/seq。
- 注：极少数文件仅在**注释**中提到秒级时间，不构成时间门槛依赖，但建议后续也清理以保持口径统一。

#### PR Checklist（可直接粘贴到 PR 描述）

> 说明：这里的 checkbox 与下方“分组表格”的 `状态` 一致；`[x]` 表示已满足“链上门槛不依赖非 `block.number` 时间轴”的合约层标准。

##### 1) 抵押物资金链（Collateral Flow）

- [x] ✅ DONE `src/Vault/VaultCore.sol`
  - 为什么在这里改：这是用户入口与对外事件/参数的**口径源头**；先把对外 `blockNumber` 语义收敛为“观测字段”，并优先并行输出 `blockNumber/updateBlock`，下游才好统一跟随。
- [x] ✅ DONE `src/Vault/VaultRouter.sol`
  - 为什么在这里改：路由/转发层通常只做透传；紧跟 `VaultCore` 调整，能保证外部调用与事件时间轴在整个 Vault 入口链路上保持一致。
- [x] ✅ DONE `src/Vault/modules/CollateralManager.sol`
  - 为什么在这里改：这是抵押账本写入与相关事件的 SSOT；在入口口径确定后，把内部与事件的时间轴字段统一为 block 口径，避免出现“入口已改、账本仍按秒”的割裂。
- [x] ✅ DONE `src/Vault/view/modules/ViewCache.sol`
  - 为什么在这里改：它是多个 View 共享的 system-level 快照缓存与有效性判定基座；先把 TTL/isValid 统一为 blocks，后续各 View 基本只需对齐 meta 字段名。
- [x] ✅ DONE `src/Vault/view/modules/PositionView.sol`
  - 为什么在这里改：PositionView 依赖 `ViewCache` 的有效性口径，且仓位 SSOT 在账本模块；放在最后改可直接复用 blocks TTL，并把输出 meta 与上游 `blockNumber/updateBlock` 对齐。

##### 2) 出借资金资金链（Reserve Flow）

- [x] ✅ DONE `src/libraries/SettlementIntentLib.sol`
  - 为什么在这里改：intent 的过期/有效性是**门槛语义的底层校验点**；先把 `expireAt/expiry` 统一迁移为 `expireBlock/...Blocks`，上层业务只做复用不再自行“秒差比较”。
- [x] ✅ DONE `src/Vault/modules/VaultBusinessLogic.sol`
  - 为什么在这里改：业务层通常负责 reserve/cancel/finalize 的 gate；在 lib 口径定型后再改这里，可一次性把所有 deadline/expiry 语义切到 blocks（并避免重复实现校验）。

##### 3) 撮合放款资金链（Finalize Match / Borrow Disbursement）

- [x] ✅ DONE `src/core/LendingEngine.sol`
  - 为什么在这里改：已完成（此处作为执行顺序占位），maturity/window 属于资金门槛 SSOT；后续模块一律消费其 `...Block(s)` 口径。
- [x] ✅ DONE `src/core/LoanNFT.sol`
  - 为什么在这里改：已完成（此处作为执行顺序占位），NFT 生命周期字段需与 `LendingEngine/SettlementManager` 的 block-based 判定一致，避免“metadata 口径”误导上层。
- [x] ✅ DONE `src/Vault/modules/VaultBusinessLogic.sol`（含 finalize/match 路径）
  - 为什么在这里改：与 Reserve Flow 同文件；本次已把 `finalizeMatch` 的 intent expiry 门槛统一为 blocks（复用 `SettlementIntentLib`），并修复撮合落单时 term 的秒/块混用（`SettlementMatchLib` 统一为 blocks）。

##### 4) 还款/结算资金链（Repay → Settle）

- [x] ✅ DONE `src/Vault/liquidation/modules/SettlementManager.sol`
  - 为什么在这里改：已完成（此处作为执行顺序占位），其编排依赖 maturity/window 门槛；必须与 `LendingEngine` 的 block 口径一致。
- [x] ✅ DONE `src/core/LendingEngine.sol`
  - 为什么在这里改：已完成（此处作为执行顺序占位），按期/逾期判定 SSOT 在 `LendingEngine`，vault 内所有 repay/settle gate 都应消费 blocks 口径。
- [x] ✅ DONE `src/Vault/modules/lendingEngine/LendingEngineCore.sol`
  - 为什么在这里改：先改内部 core（最底层窗口/到期辅助），为外层 vault wrapper 提供稳定的 `...Block(s)` 接口与字段。
- [x] ✅ DONE `src/Vault/modules/lendingEngine/LendingEngineAccounting.sol`
  - 为什么在这里改：会计/计息路径通常复用 core 的口径与字段；紧跟 core 修改可避免出现“一半用秒、一半用块”的混用。
- [x] ✅ DONE `src/Vault/modules/VaultLendingEngine.sol`
  - 为什么在这里改：外层模块多为组合/对外入口；放在 core/accounting 之后改能直接对齐内部 blocks 口径，减少接口反复调整。

##### 5) 提前还款保证金（Extension Flow）

- [x] ✅ DONE `src/Vault/modules/GuaranteeFundManager.sol`
  - 为什么在这里改：资金池/结算口径是更底层的门槛/支撑；先统一窗口与事件时间轴为 blocks，上层保证金流程才能稳定复用。
- [x] ✅ DONE `src/Vault/modules/EarlyRepaymentGuaranteeManager.sol`
  - 为什么在这里改：该流程往往依赖资金池与窗口判定；在 FundManager 完成 block-based 后改这里更线性、改动面更可控。

##### 6) 违约清算（Default → Liquidation）

- [x] ✅ DONE `src/Vault/liquidation/libraries/ModuleCache.sol`
  - 为什么在这里改：清算域依赖缓存（模块地址/依赖解析）属于最硬门槛；先把 TTL/aging 改成 blocks，避免上层风控/执行各自实现一套。
- [x] ✅ DONE `src/Vault/liquidation/modules/LiquidationConfigModule.sol`
  - 为什么在这里改：配置模块定义参数与窗口语义（被 manager/风控读取）；先把字段迁移为 `...Block(s)`，避免上层读取到“秒口径配置”。
- [x] ✅ DONE `src/Vault/liquidation/modules/LiquidationConfigManager.sol`
  - 为什么在这里改：配置生效延迟/窗口属于门槛语义，且被风控/执行引用；先在 manager 落定 block-based gate（如 `executeAfterBlock`）可减少扩散改动。
- [x] ✅ DONE `src/Vault/liquidation/libraries/LiquidationRiskQueryLib.sol`
  - 为什么在这里改：风险查询库承载“新鲜度/缓存”判定的共用逻辑；在 config 与 module cache 口径统一后，把查询逻辑全面切到 blocks，RiskManager 只做 SSOT 编排。
- [x] ✅ DONE `src/Vault/liquidation/modules/LiquidationRiskManager.sol`
  - 为什么在这里改：风控判定依赖（配置 + 模块缓存 + 风险查询库）；上述上游口径统一后，再把风险 SSOT 全面切到 blocks。
- [x] ✅ DONE `src/Vault/liquidation/modules/LiquidationManager.sol`
  - 为什么在这里改：执行清算依赖风险判定 SSOT；先改 RiskManager 可确保 LiquidationManager 只消费 block-based 结果，不引入秒差门槛。
- [x] ✅ DONE `src/Vault/view/modules/LiquidatorView.sol`
  - 为什么在这里改：View 侧仅观测/缓存时间轴，必须跟随清算域上游事件/推送口径（优先输出 `blockNumber/updateBlock`）。

##### 7) 费用与分账（Fee Flow）

- [x] ✅ DONE `src/Vault/FeeRouter.sol`
  - 为什么在这里改：费用分发/结算属于 SSOT（可能存在周期/同步门槛）；先定 epoch 或 syncBlocks 口径，下游 View 只做镜像与 meta 输出。
- [x] ✅ DONE `src/Vault/view/modules/FeeRouterView.sol`
  - 为什么在这里改：FeeRouterView 以 View 缓存/同步为主；依赖上游 FeeRouter 的字段与事件口径，放后面改可避免重复对齐。

##### 附：跨段共用/治理与降级（建议并行处理）

- [x] ✅ DONE `src/Vault/utils/SystemUtils.sol`
  - 为什么在这里改：通用 TTL/时间差工具是全局“依赖收敛点”；先补齐 blocks 版本（并逐步淘汰 ts 版本），其他模块改造才能复用而不是复制。
- [x] `src/core/PriceOracle.sol`
  - 为什么在这里改：已完成（此处作为执行顺序占位），预言机新鲜度门槛应集中在 SSOT（`getPrice`）并以 blocks 表达。
- [x] `src/core/CoinGeckoPriceUpdater.sol`
  - 为什么在这里改：已完成（此处作为执行顺序占位），updater 的 interval/lastUpdate 口径与 oracle freshness 保持一致（blocks）。
- [x] ✅ DONE `src/registry/Registry.sol`
  - 为什么在这里改：治理 timelock/升级窗口是门槛语义，且被其他系统模块引用；先切到 `executeAfterBlock/...Blocks` 可避免全局混用秒。
- [x] ✅ DONE `src/Governance/CrossChainGovernance.sol`
  - 为什么在这里改：跨链治理窗口与 Registry 类似，属于门槛语义；与 Registry 同期改能统一治理口径（blocks/epoch）。
- [x] ✅ DONE `src/monitor/DegradationMonitor.sol`
  - 为什么在这里改：降级/升级窗口会影响系统策略选择，属于门槛；应在核心监控合约先完成 block-based 化。
- [x] ✅ DONE `src/monitor/DegradationCore.sol`
  - 为什么在这里改：Core/Storage 往往是 Monitor 的数据与判定支撑；随 Monitor 一并改可保证存储字段与判定口径一致。
- [x] ✅ DONE `src/monitor/DegradationStorage.sol`
  - 为什么在这里改：存储层字段一旦定型会向外扩散；在 monitor/core 完成 blocks 口径后再收口到 storage，避免二次迁移。
- [x] ✅ DONE `src/Vault/view/modules/AccessControlView.sol`
  - 为什么在这里改：View 缓存 TTL/有效性仅观测；在 `ViewCache` blocks 口径确定后，把权限快照的 meta 字段与 isValid 统一为 blocks。
- [x] ✅ DONE `src/Vault/view/modules/EventHistoryManager.sol`
  - 为什么在这里改：事件/推送时间轴属于观测层；应跟随上游统一输出 `blockNumber`，避免 keeper/UI 用 blockNumber 做隐式门槛。
- [x] ✅ DONE `src/Vault/view/modules/HealthView.sol`
  - 为什么在这里改：健康/风险快照有效性属于观测层 TTL；改为 blocks 后，任何门槛仍以风控/账本 SSOT 为准。
- [x] ✅ DONE `src/Vault/view/modules/LendingEngineView.sol`
  - 为什么在这里改：聚合只读 view 的缓存 meta 应与 `LendingEngine` 的 block 口径一致；通常只需替换 TTL 判定工具即可。
- [x] ✅ DONE `src/Vault/view/modules/LiquidationRiskView.sol`
  - 为什么在这里改：清算风险 view 仅观测；必须跟随清算域（RiskManager/ModuleCache）输出 updateBlock/ageBlocks。
- [x] ✅ DONE `src/Vault/view/modules/ModuleHealthView.sol`
  - 为什么在这里改：模块健康检查的缓存/同步属于观测层，改 blocks 可避免秒差门槛被误用。
- [x] ✅ DONE `src/Vault/view/modules/RiskView.sol`
  - 为什么在这里改：RiskView 多为派生只读；在 Health/Position 等 view 完成 blocks meta 后再改这里最省对齐成本。
- [x] ✅ DONE `src/Vault/view/modules/StatisticsView.sol`
  - 为什么在这里改：系统统计快照 TTL 属于观测；建议在 ViewCache/工具与上游数据口径稳定后再统一替换为 blocks（必要时可升级为 epoch）。
- [x] ✅ DONE `src/Vault/view/modules/UserView.sol`
  - 为什么在这里改：用户维度聚合通常依赖多个 view/cache；放在后面改可直接复用已统一的 blocks TTL/meta。
- [x] ✅ DONE `src/Vault/view/modules/ValuationOracleView.sol`
  - 为什么在这里改：ValuationOracleView 只是门面（门槛在 oracle SSOT）；在 PriceOracle blocks 口径确定后，这里只需同步 meta 输出口径。
- [x] ✅ DONE `src/Reward/configs/*.sol`
  - 为什么在这里改：配置窗口/feature unlock 属于门槛语义；在 blocks/epoch 口径确定后统一迁移最不容易漏（并避免 config 与执行层口径不一致）。
- [x] ✅ DONE `src/Reward/*`
  - 为什么在这里改：奖励冷却/窗口属于奖励域门槛；建议在 configs 完成 blocks/epoch 口径后整体迁移，避免配置与执行不一致。
- [x] ✅ DONE `src/Token/EasyToken.sol`（奖励通证；SSOT = `Registry[KEY_EASY_TOKEN]`）
  - 为什么在这里改：点数/策略通常被 Reward 逻辑调用；放在 Reward 之后改可直接对齐 reward 域的 blocks/epoch 口径。
- [x] ✅ DONE `src/strategies/RWAAutoLeveragedStrategy.sol`
  - 为什么在这里改：策略时间窗口若用于 gate 必须 block-based；在 Reward/配置口径定型后改策略更少返工。Token/ 副本已删除（不符合架构指南）。
- [x] ✅ DONE `src/access/AssetWhitelist.sol`
  - 为什么在这里改：白名单生效窗口是门槛语义；与其他治理/配置窗口口径一致（blocks/epoch）后迁移更易统一审计。
- [x] ✅ DONE `src/AuthorityWhitelist.sol`
  - 为什么在这里改：同白名单窗口，属于权限门槛；统一 blocks 口径可避免链上权限出现“秒差门槛”。
- [x] ✅ DONE `src/Vault/VaultAdmin.sol`
  - 为什么在这里改：admin/运维窗口（若存在）属于门槛语义；建议在治理/窗口体系完成 blocks 迁移后再收口到 admin 层。
- [x] ✅ DONE `src/Mocks/MockRWAPriceOracle.sol`
  - 为什么在这里改：mock 需跟随真实 oracle 的 blocks 口径，否则测试会误导（例如仍用 blockNumber 造成假阳性/假阴性）。
- [x] ✅ DONE `src/Mocks/MockGracefulDegradationMonitor.sol`
  - 为什么在这里改：同上，mock 应复刻 Degradation 体系的 block-based 判定口径，确保测试覆盖真实门槛。

#### Step 2C（按执行顺序 1～7 分组的合约层状态表）

##### 1) 抵押物资金链（Collateral Flow）

| 状态 | 文件 | 语义 | 门槛/观测 | 模式 | SSOT（权威判定位置） | 新增/替换字段名（建议） |
| --- | --- | --- | --- | --- | --- | --- |
| [ ] TODO | `src/Vault/VaultCore.sol` | 用户入口/事件参数携带时间 | **观测**（不得 gate） | **A** | 账本与结算模块 | 对外事件/参数：`blockNumber -> blockNumber`（或保留旧名但语义改为观测并并行输出 block） |
| [ ] TODO | `src/Vault/VaultRouter.sol` | 路由/事件参数时间轴；兼容 getter blockNumber | **观测**（不得 gate） | **A** | `VaultRouter`（仅转发/推送） | `blockNumber -> blockNumber`；兼容 getter 的 `blockNumber` 返回 `block.number` 或加 `blockNumber` 并行输出 |
| [ ] TODO | `src/Vault/modules/CollateralManager.sol` | 抵押物事件/推送时间轴口径 | **观测**（不得 gate） | **A** | 抵押账本写入 SSOT（CM/LE） | 事件/推送字段：`blockNumber -> blockNumber`（或并行输出 `blockNumber`） |
| [ ] TODO | `src/Vault/view/modules/PositionView.sol` | 仓位快照缓存 TTL/isValid | **观测**（仓位 SSOT 在账本） | **A** | `CollateralManager` + `LendingEngine`（账本 SSOT） | `positionTimestamp -> positionUpdateBlock`；`CACHE_DURATION -> ...BLOCKS` |
| [ ] TODO | `src/Vault/view/modules/ViewCache.sol` | system-level 快照 TTL/isValid | **观测** | **A** | `ViewCache`（只读缓存） | `_systemCacheTimestamp -> _systemCacheUpdateBlock` |

##### 2) 出借资金资金链（Reserve Flow）

| 状态 | 文件 | 语义 | 门槛/观测 | 模式 | SSOT（权威判定位置） | 新增/替换字段名（建议） |
| --- | --- | --- | --- | --- | --- | --- |
| [ ] TODO | `src/Vault/modules/VaultBusinessLogic.sol` | reserve/cancel/finalize 的时间语义（expiry/deadline 等） | **门槛** | **A/D** | `VaultBusinessLogic` + libs（意向/撮合 SSOT） | `expireAt -> expireBlock`（或 seq）；移除秒差门槛 |
| [ ] TODO | `src/libraries/SettlementIntentLib.sol` | intent 过期（expireAt） | **门槛** | **A**（或 D） | `SettlementIntentLib`（校验） | `expireAt -> expireBlock`（推荐） |

##### 3) 撮合放款资金链（Finalize Match / Borrow Disbursement）

| 状态 | 文件 | 语义 | 门槛/观测 | 模式 | SSOT（权威判定位置） | 新增/替换字段名（建议） |
| --- | --- | --- | --- | --- | --- | --- |
| [x] ✅ DONE | `src/core/LendingEngine.sol` | maturity / 按时窗口 / 提前-逾期判定 | **门槛** | **A**（+可选 D） | `LendingEngine`（判定 SSOT） | `maturity -> maturityBlock`；`ON_TIME_WINDOW -> ON_TIME_WINDOW_BLOCKS`；（注：注释仍提及非 `block.number` 时间轴，建议后续清理） |
| [x] ✅ DONE | `src/core/LoanNFT.sol` | 生命周期时间字段（到期/元数据） | **谨慎**：若参与 gate=门槛；否则=观测 | **A**（+可选 D） | gate 以 `LendingEngine/SettlementManager` 为准 | `maturity -> maturityBlock`；观测字段可保留 `blockNumber` 但必须并行输出 `blockNumber` |
| [ ] TODO | `src/Vault/modules/VaultBusinessLogic.sol` | finalize/match 分支的 deadline/expiry 语义 | **门槛** | **A/D** | `VaultBusinessLogic` + libs（撮合 SSOT） | `deadline -> deadlineBlock`；必要时用 nonce/seq（D） |

##### 4) 还款/结算资金链（Repay → Settle）

| 状态 | 文件 | 语义 | 门槛/观测 | 模式 | SSOT（权威判定位置） | 新增/替换字段名（建议） |
| --- | --- | --- | --- | --- | --- | --- |
| [x] ✅ DONE | `src/Vault/liquidation/modules/SettlementManager.sol` | repay/settle 分支依赖 maturity window | **门槛** | **A** | `SettlementManager`（编排 SSOT）+ `LendingEngine`（判定 SSOT） | 所有比较改为 `block.number` vs `maturityBlock` |
| [ ] TODO | `src/Vault/modules/VaultLendingEngine.sol` | vault 内 LE 估值/判定窗口 | **门槛** | **A** | `VaultLendingEngine`（估值路径） | `maturityBlock` / `maxAgeBlocks` |
| [ ] TODO | `src/Vault/modules/lendingEngine/LendingEngineCore.sol` | LE 核心逻辑窗口/到期判定辅助 | **门槛/支撑** | **A** | `LendingEngine` | `...Block` |
| [ ] TODO | `src/Vault/modules/lendingEngine/LendingEngineAccounting.sol` | 会计路径里若有窗口/限频 | **门槛/支撑** | **A** | `VaultLendingEngine` | `...Blocks` |

##### 5) 提前还款保证金（Extension Flow）

| 状态 | 文件 | 语义 | 门槛/观测 | 模式 | SSOT（权威判定位置） | 新增/替换字段名（建议） |
| --- | --- | --- | --- | --- | --- | --- |
| [ ] TODO | `src/Vault/modules/EarlyRepaymentGuaranteeManager.sol` | guarantee window/cooldown/到期语义（若存在） | **门槛** | **A/C** | `EarlyRepaymentGuaranteeManager` | `...Seconds -> ...Blocks`（或 epoch） |
| [ ] TODO | `src/Vault/modules/GuaranteeFundManager.sol` | guarantee settlement/窗口/事件时间轴 | **门槛/观测** | **A/C** | `GuaranteeFundManager` | 事件/门槛统一 block-based；避免保留非 `block.number` 时间轴 |

##### 6) 违约清算（Default → Liquidation）

| 状态 | 文件 | 语义 | 门槛/观测 | 模式 | SSOT（权威判定位置） | 新增/替换字段名（建议） |
| --- | --- | --- | --- | --- | --- | --- |
| [ ] TODO | `src/Vault/liquidation/modules/LiquidationManager.sol` | 清算执行窗口/触发条件 | **门槛** | **A** | `LiquidationManager`（执行） | `...Timestamp -> ...Block` |
| [ ] TODO | `src/Vault/liquidation/modules/LiquidationRiskManager.sol` | 风控判定/缓存 aging | **门槛** | **A** | `LiquidationRiskManager` | `lastUpdateBlock` / `maxAgeBlocks` |
| [ ] TODO | `src/Vault/liquidation/libraries/LiquidationRiskQueryLib.sol` | 清算风险查询中“新鲜度/缓存” | **门槛** | **A** | `LiquidationRiskManager`（风控 SSOT） | `...Timestamp -> ...UpdateBlock` |
| [ ] TODO | `src/Vault/liquidation/libraries/ModuleCache.sol` | 清算域模块地址/依赖缓存 TTL | **门槛**（清算域最硬） | **A** | `ModuleCache` / 调用方（如 LRM） | `lastUpdateTimestamp -> lastUpdateBlock`；`CACHE_MAX_AGE -> CACHE_MAX_AGE_BLOCKS` |
| [ ] TODO | `src/Vault/liquidation/modules/LiquidationConfigManager.sol` | 清算参数配置生效窗口/缓存 | **门槛** | **A**（或 C） | `LiquidationConfigManager` | `executeAfterBlock` / `enabledUntilBlock` 或 `epoch` |
| [ ] TODO | `src/Vault/liquidation/modules/LiquidationConfigModule.sol` | 清算配置模块窗口/生效时点 | **门槛** | **A**（或 C） | `LiquidationConfigManager` | `...Block` / `...Blocks` |
| [ ] TODO | `src/Vault/view/modules/LiquidatorView.sol` | 清算事件/榜单“观测时间轴”与缓存 | **观测**（写入不经 View） | **A** | `SettlementManager`/`LiquidationManager`（写）→ `LiquidatorView.push*`（单点推送） | 事件 `ts -> blockNumber`（或保留 `blockNumber` 但标注观测并并行输出 `blockNumber`） |

##### 7) 费用与分账（Fee Flow）

| 状态 | 文件 | 语义 | 门槛/观测 | 模式 | SSOT（权威判定位置） | 新增/替换字段名（建议） |
| --- | --- | --- | --- | --- | --- | --- |
| [ ] TODO | `src/Vault/FeeRouter.sol` | fee 结算周期/同步间隔 | **门槛/观测（视具体逻辑）** | **C**（周期）或 **A**（间隔） | `FeeRouter`（分发 SSOT） | 周期：`epoch`；间隔：`syncBlocks` |
| [ ] TODO | `src/Vault/view/modules/FeeRouterView.sol` | View 侧 fee 镜像缓存 TTL/同步间隔 | **观测** | **A**（或 C，若按周期结算） | `FeeRouter`（写）→ `FeeRouterView`（读） | `lastSyncTimestamp -> lastSyncBlock`；`SYNC_INTERVAL -> SYNC_INTERVAL_BLOCKS` |

##### 附：跨段共用/治理与降级（不计入 1～7，但建议同步）

| 状态 | 文件 | 语义 | 门槛/观测 | 模式 | SSOT（权威判定位置） | 新增/替换字段名（建议） |
| --- | --- | --- | --- | --- | --- | --- |
| [ ] TODO | `src/Vault/utils/SystemUtils.sol` | 通用 TTL/时间差工具 | **支撑性**（被门槛逻辑引用时等同门槛） | **A** | 被调用方（各模块） | 工具函数改为 `ageBlocks(updateBlock)` / `isExpiredBlocks(...)`（移除 ts 版本） |
| [ ] TODO | `src/registry/Registry.sol` | timelock / 治理延迟 / 升级执行窗口 | **门槛** | **A**（或 C） | `Registry.executeModuleUpgrade`/相关 gate | `executeAfterTimestamp -> executeAfterBlock`；`minDelaySeconds -> minDelayBlocks` |
| [ ] TODO | `src/Governance/CrossChainGovernance.sol` | 跨链治理窗口/延迟 | **门槛** | **A**（或 C） | `CrossChainGovernance` 的执行 gate | `executeAfterBlock` / `enabledUntilBlock` 或 `epoch` |
| [ ] TODO | `src/monitor/DegradationMonitor.sol` | 降级/升级窗口 | **门槛**（影响估值/降级策略） | **A**（或 C） | `DegradationMonitor`/`DegradationCore` | `upgradeEnabledUntil -> upgradeEnabledUntilBlock` |
| [ ] TODO | `src/monitor/DegradationCore.sol` | 降级统计/事件/可能的窗口判定 | **门槛/支撑** | **A** | `DegradationCore`（系统统计 SSOT） | `...Timestamp -> ...UpdateBlock` |
| [ ] TODO | `src/monitor/DegradationStorage.sol` | 降级相关持久化字段（含窗口） | **门槛/支撑** | **A** | `DegradationMonitor/Core` | 存储字段统一 `...Block` |
| [x] ✅ DONE | `src/core/PriceOracle.sol` | price freshness/stale 判定 | **门槛** | **B + A**（+可选 D） | `IPriceOracle.getPrice`（B） | `PriceData.blockNumber -> PriceData.updateBlock`；`maxPriceAgeSeconds -> maxPriceAgeBlocks`；可保留 `blockNumber` 仅观测 |
| [x] ✅ DONE | `src/core/CoinGeckoPriceUpdater.sol` | updater interval/lastUpdate | **门槛/支撑**（影响数据更新节奏） | **A**（+可选 D） | `PriceOracle`/updater | `lastUpdateTime -> lastUpdateBlock`；`minUpdateIntervalSeconds -> ...Blocks` |
| [ ] TODO | `src/Vault/view/modules/AccessControlView.sol` | View 权限快照 TTL（isValid） | **观测**（不得 gate） | **A** | `AccessControlView.get*WithMeta` / `isValid` | `_cacheTimestamps[user] -> _cacheUpdateBlocks[user]`；`CACHE_DURATION -> CACHE_DURATION_BLOCKS` |
| [ ] TODO | `src/Vault/view/modules/EventHistoryManager.sol` | 事件/推送的“观测时间轴” | **观测** | **A** | Event/DataPush 订阅侧（链下） | 事件中的 `ts` 优先改为 `blockNumber`（或 `updateBlock`） |
| [ ] TODO | `src/Vault/view/modules/HealthView.sol` | 风险状态快照 TTL/有效性 | **观测**（结果可被 UI/keeper 用，但 gate 不得依赖 TTL） | **A** | 风控/账本层计算（如 `LendingEngine` / `LiquidationRiskManager`） | `healthTimestamp -> healthUpdateBlock`；`CACHE_DURATION -> ...BLOCKS` |
| [ ] TODO | `src/Vault/view/modules/LendingEngineView.sol` | LE 只读聚合/缓存有效性 | **观测** | **A** | `LendingEngine`（账本 SSOT） | `cacheTimestamp -> cacheUpdateBlock` |
| [ ] TODO | `src/Vault/view/modules/LiquidationRiskView.sol` | 风险只读视图缓存/有效性 | **观测**（清算判定 SSOT 不在 view） | **A** | `LiquidationRiskManager`（风控 SSOT） | `cacheTimestamp -> cacheUpdateBlock` |
| [ ] TODO | `src/Vault/view/modules/ModuleHealthView.sol` | 模块健康检查的缓存/同步 | **观测** | **A** | `ModuleHealthView`（只读） | `lastUpdateTimestamp -> lastUpdateBlock` |
| [ ] TODO | `src/Vault/view/modules/RiskView.sol` | 风险派生只读（基于 Health/Position） | **观测** | **A** | `HealthView`/`PositionView`（读） | 若需要 meta：`updateBlock` 输出 |
| [ ] TODO | `src/Vault/view/modules/StatisticsView.sol` | 系统统计快照 TTL/isValid | **观测** | **A**（或 C：按 epoch 统计） | `StatisticsView`（聚合 SSOT） | `_systemCacheTimestamp -> _systemCacheUpdateBlock`；`CACHE_DURATION -> ...BLOCKS` |
| [ ] TODO | `src/Vault/view/modules/UserView.sol` | 用户维度聚合缓存 TTL | **观测** | **A** | `UserView`（只读聚合） | `cacheTimestamp -> cacheUpdateBlock` |
| [ ] TODO | `src/Vault/view/modules/ValuationOracleView.sol` | 价格只读门面/缓存 meta | **观测**（门槛 SSOT 在 oracle） | **B + A** | `IPriceOracle.getPrice`（B） | `lastUpdateBlock`/`ageBlocks` 输出 |
| [ ] TODO | `src/Reward/configs/EarnConfig.sol` | earn 配置窗口（如解锁/冷却等按实现） | **门槛**（但非资金安全关键；仍需一致口径） | **A**（或 C） | EarnConfig | `...At -> ...Block`；`...Seconds -> ...Blocks`；周期类用 `epoch` |
| [ ] TODO | `src/Reward/*`（RewardConfig/RewardManager/RewardManagerCore/Easy* 等） | 奖励冷却/窗口/锁定期 | **门槛**（奖励域） | **A**（或 C） | `RewardManagerCore.onLoanEvent*`（SSOT） | `cooldown -> cooldownBlocks`；周期类 `epoch`；仅观测字段可并行输出 `blockNumber` |
| [ ] TODO | `src/Token/EasyToken.sol` | 策略/奖励通证时间相关 | **支撑/门槛（取决于是否用于 gate）** | **A** | Reward SSOT（奖励通证 SSOT = `Registry[KEY_EASY_TOKEN]`） | `...Block(s)` |
| [ ] TODO | `src/strategies/RWAAutoLeveragedStrategy.sol` | 策略时间窗口/冷却（若有） | **门槛**（策略域） | **A** | 策略合约 | `...Blocks` |
| [ ] TODO | `src/access/AssetWhitelist.sol` | allowlist 生效窗口 | **门槛** | **A** | `AssetWhitelist` gate | `enabledAfter -> enabledAfterBlock`；`disabledAfter -> disabledAfterBlock` |
| [ ] TODO | `src/AuthorityWhitelist.sol` | authority 生效窗口 | **门槛** | **A** | `AuthorityWhitelist` gate | 同上 `...Block` |
| [ ] TODO | `src/Vault/VaultAdmin.sol` | admin/运维窗口（若有） | **门槛** | **A** | `VaultAdmin` | `...Block` |
| [ ] TODO | `src/Mocks/MockRWAPriceOracle.sol` | mock blockNumber/更新 | **观测/测试支撑** | **A/D** | 测试口径 | 同步引入 `updateBlock` 输出 |
| [ ] TODO | `src/Mocks/MockGracefulDegradationMonitor.sol` | mock 时间读取 | **观测/测试支撑** | **A** | 测试口径 | 用 `block.number` 替代 |

### Step 3：接口与存储变更表（从 Step 2C 汇总，直接指导改合约）

| 语义域（来自 Step 2A） | SSOT（权威判定位置） | 存储变更（示例字段） | 接口/事件变更（示例） | 兼容策略（必须写清楚） |
| --- | --- | --- | --- | --- |
| 缓存 TTL / View 快照有效性 / 同步间隔 | 各 View `get*WithMeta` 的 `isValid`（仅观测） | `cacheBlockNumber -> cacheUpdateBlock`；`CACHE_DURATION -> CACHE_DURATION_BLOCKS`；`SYNC_INTERVAL -> SYNC_INTERVAL_BLOCKS` | `...WithMeta` 返回并行输出 `updateBlock`（或 `blockNumber`） | 旧字段名仍叫 `blockNumber` 的：保留但标注“观测字段”，不得用于 gate；推荐并行新增 `updateBlock` |
| 清算域模块地址/依赖缓存 TTL | `LiquidationRiskManager` / `ModuleCache`（门槛） | `lastUpdateBlockNumber -> lastUpdateBlock`；`CACHE_MAX_AGE -> ...BLOCKS` | 清算风险查询接口 meta 返回 `lastUpdateBlock/ageBlocks` | **不建议保留 blockNumber**（清算域最硬）；若必须兼容，仅做观测字段并并行 block |
| Timelock / 治理延迟 / 升级窗口 | `Registry` / 治理合约 gate（门槛） | `executeAfterBlockNumber -> executeAfterBlock`；`minDelaySeconds -> minDelayBlocks`；`enabledUntilBlockNumber -> enabledUntilBlock` | 对外 getter 增加 `getExecuteAfterBlock(...)` | 若历史事件里有 `blockNumber`：允许保留为观测，并并行输出 `executeAfterBlock`；链上 gate 一律用 block |
| 贷款到期 / 还款窗口 / 提前-按时判定 | `LendingEngine`（判定 SSOT）+ `SettlementManager`（编排 SSOT） | `maturity -> maturityBlock`；`ON_TIME_WINDOW -> ON_TIME_WINDOW_BLOCKS`；相关窗口 `...Seconds -> ...Blocks` | 任何对外暴露 maturity 的接口：并行输出 `maturityBlock`（必要时保留旧 `maturity/blockNumber` 字段为观测） | 如果外部仍传入 blockNumber：只允许 **D 单调不回退**约束；不得与 `block.number` 比较 |
| 意向单过期 | `SettlementIntentLib`（门槛） | `expireAt -> expireBlock` | 校验函数改为 `require(block.number <= expireBlock)` | 不建议保留 blockNumber 语义；如兼容旧 ABI，保留字段名但语义改为“观测/链下调度提示”，并新增 `expireBlock` |
| 预言机/价格新鲜度与更新间隔 | `IPriceOracle.getPrice`（B：集中裁决） | `PriceData.blockNumber -> PriceData.updateBlock`；`maxPriceAgeSeconds -> maxPriceAgeBlocks`；`lastUpdateBlock` | `getPrice` 返回 `updateBlock`（或 `ageBlocks`）作为明确新鲜度信号 | 若必须保留 `blockNumber`：仅观测字段；若 `updatePrice(..., blockNumber)` 存在：只做 **D 单调性**检查 |
| Reward / cooldown / feature unlock / service config | `RewardManagerCore` + 各 config 合约（门槛） | `cooldownSeconds -> cooldownBlocks`；`unlockAt -> unlockBlock`；周期类用 `epoch` | 对外展示接口可返回 `unlockBlock` + 链下 ETA | 允许保留 `blockNumber` 仅观测，用于 UI/审计，但不得影响资金路径 |
| 白名单/权限窗口 | `AssetWhitelist`/`AuthorityWhitelist` gate（门槛） | `enabledAfter -> enabledAfterBlock`；`validUntil -> validUntilBlock` | 校验逻辑改为 block-based；对外 getter 输出 block 字段 | 不建议保留 blockNumber 门槛；如历史事件有 blockNumber，仅观测并并行 block |
| 费用/路由相关（同步/观测） | `FeeRouter`（分发/统计 SSOT） | 周期：`epoch`；间隔：`syncBlocks` | 事件/只读 view 输出 `epoch` 或 `lastSyncBlock` | blockNumber 若存在，仅观测；周期统计优先 epoch，避免秒差 |

### Step 4：改测试

避免依赖：

- `evm_increaseTime` or “wait seconds”

优先使用：

- `hardhat_mine` / advancing blocks
- assertions on block-based age

### Step 5：按链配置默认值

需要记录并可治理配置的内容：

- 平均出块时间（参考值）
- 推荐的 `maxPriceAgeBlocks`

快速换算示例：

- 1 hour on a ~12s chain: `3600 / 12 ≈ 300 blocks`
- 5 minutes on a ~2s chain: `300 / 2 = 150 blocks`

注意：

- 上述换算**只允许存在于链下**（部署脚本/配置/前端展示），用于给治理/运营一个“初始建议值”。
- **禁止**把这种换算写进 Solidity（尤其是 `X days / Y seconds` 这类表达式），链上只接收/存储显式 `...Blocks` 配置。

治理侧应把这些视为起点，而不是硬编码常量。

---

## 执行顺序（按 `docs/Usage-Guide/Funds-Flow-Architecture-Guide.md` 的章节顺序逐段改造）

> 目的：把“时间依赖改造”按资金链 SSOT 的真实路径拆解，避免遗漏关键入口或出现多口径并存。
>
> 做法：每一段都遵循同一套规则——**链上门槛只用 block**、**接口/事件里若有 blockNumber 字段一律视为观测字段**、**前端用 ETA 映射**。

### 0) 先做全局盘点（对应 Funds-Flow：SSOT 原则与估值口径）

- 搜索并清单化（必须落到 PR checklist）：`block.number` / `blockNumber` 算术 / `deadline/expiry/cooldown/maturity/maxAge`
- 对每个命中点标注其所在资金链段落（见下方 1～9），防止“改一半”。

### 1) 抵押物资金链（Collateral Flow）

- 目标：deposit/withdraw 的任何 guard 不依赖非 `block.number` 时间轴；若存在观测字段，统一按 block 语义处理或明确为观测字段。
- 主要文件（Funds-Flow 已列出落点）：
  - `src/Vault/VaultCore.sol`
  - `src/Vault/VaultRouter.sol`
  - `src/Vault/modules/CollateralManager.sol`
  - 相关 View/事件推送：`src/Vault/view/modules/PositionView.sol`、`src/Vault/view/modules/CacheOptimizedView.sol`、`src/Vault/view/modules/ViewCache.sol`（以 Funds-Flow §1.3 为准）
  - DataPush/类型常量（若事件 payload 含 ts 字段需统一口径）：`src/libraries/DataPushLibrary.sol`、`src/constants/DataPushTypes.sol`

### 2) 出借资金资金链（Reserve Flow）

- 目标：reserve/cancel 的“有效性窗口/去重/过期”统一改为 blocks 或单调序列（不要秒差门槛）。
- 主要文件：
  - `src/Vault/modules/VaultBusinessLogic.sol`
  - `src/libraries/SettlementReserveLib.sol`
  - `src/libraries/SettlementIntentLib.sol`
  - `src/Vault/modules/LenderPoolVault.sol`

### 3) 撮合放款资金链（Finalize Match / Borrow Disbursement）

- 目标：撮合意向的“deadline/validUntil/expiry”统一为 `deadlineBlock`（或 round/seq），链下以 ETA 展示与调度。
- 主要文件：
  - `src/Vault/modules/VaultBusinessLogic.sol`（`finalizeMatch`）
  - `src/libraries/SettlementMatchLib.sol`
  - `src/core/LendingEngine.sol`（order 创建/状态机里如存在时间门槛，必须按 block 改造）
  - `src/core/LoanNFT.sol`（若 NFT 状态/奖励 outcome 依赖时间窗口，必须按 block 改造）

### 4) 还款/结算资金链（Repay → Settle）

- 目标：“按时/提前/逾期”的判定语义统一迁移为 block-based（例如 `maturityBlock ± windowBlocks`），并确保 `SettlementManager` / `ORDER_ENGINE` 不出现秒差门槛。
- 主要文件：
  - `src/Vault/VaultCore.sol`（用户入口）
  - `src/Vault/liquidation/modules/SettlementManager.sol`（SSOT）
  - `src/core/LendingEngine.sol`（订单语义判定 SSOT）

### 5) 提前还款保证金（Extension Flow）

- 目标：保证金 record 中涉及 maturity/penaltyDays/窗口的部分改为 blocks/epoch（避免墙钟时间分支）。
- 主要文件：
  - `src/Vault/modules/GuaranteeFundManager.sol`
  - `src/Vault/modules/EarlyRepaymentGuaranteeManager.sol`

### 6) 违约清算（Default → Liquidation）

- 目标：可清算判定窗口、清算触发条件全部改为 block-based；清算域不允许出现非 `block.number` 时间轴的门槛判断。
- 主要文件：
  - `src/Vault/liquidation/modules/SettlementManager.sol`
  - `src/Vault/liquidation/modules/LiquidationManager.sol`
  - `src/Vault/liquidation/modules/LiquidationRiskManager.sol` / `LiquidationRiskQueryLib.sol`
  - `src/Vault/liquidation/modules/LiquidationPayoutManager.sol`（若 payout/epoch 逻辑存在窗口，必须按 block 改造）
  - `src/Vault/view/modules/LiquidatorView.sol`（清算观测/推送字段的“时间轴”口径统一为 block）

### 7) 费用与分账（Fee Flow）

- 目标：FeeRouter 的分发与统计不依赖非 `block.number` 时间轴做门槛；若需要“周期统计”，优先用 epoch/round/seq。
- 主要文件：
  - `src/Vault/FeeRouter.sol`
  - `src/Vault/view/modules/FeeRouterView.sol`

### 8) 最小验收清单（每段必过）

- 增补一条“时间语义验收”：
  - repo 中不应再出现用于门槛判断的非 `block.number` 时间轴
  - deadline/maturity/maxAge 全部以 blocks 表达
  - 前端展示全部从 block → ETA 映射（并明确提示 ETA 为估计值）

### 9) 本地一键 Smoke（回归基准）

- 在每段改完后跑一遍（或至少在整条资金链改完后跑一遍）：
  - `scripts/tests/funds-flow-smoke-local.ts`
  - 重点检查：keeper 入口、清算判定、价格过期/降级路径在 block-based 口径下仍可用

## Solhint 策略（不使用行内 disable）

推荐做法：

- 对影响资金动作的模块，把 `solhint` 的 `not-rely-on-time` 作为**硬禁止**。
- 按本项目决策：尽量做到 **全仓库链上代码不出现非 `block.number` 时间轴**（包括观测/事件），统一用 `block.number` 做“时间轴”。
- 不在代码里使用 `// solhint-disable-*`。

如果 `solhint` 仍然对“仅用于事件的非 `block.number` 时间轴”报错，建议改为：

- 发 `block.number`（优先），或
- 把时间轴发射逻辑迁到专门的 “view/monitoring” 模块，并在配置中排除。

---

## 实用示例

### 示例 1：过期判断改造

旧写法：

- **秒级门槛（禁止）**：
  - `if (block.timestamp - lastUpdateTs > maxAgeSeconds) revert Stale();`
  - 或任何等价的 “秒差比较” 作为资金/估值/清算/权限门槛。

新写法：

- **block 门槛（策略 A）**：
  - `if (block.number - lastUpdateBlock > maxAgeBlocks) revert Stale();`
  - 其中 `lastUpdateBlock` 必须由链上写入路径在更新时设置为 `block.number`（SSOT），而不是由链下传入的“报价 blockNumber”去和 `block.number` 做比较。

### 示例 2：缓存过期改造

旧缓存结构：

- `{ price, blockNumber, decimals, isValid }`

新缓存结构：

- `{ price, updateBlock, decimals, isValid }`

过期判断：

- `expired = updateBlock == 0 || updateBlock > block.number || (block.number - updateBlock > maxAgeBlocks)`

### 示例 3：移除 “隐含每块 X 秒” 的 seconds→blocks 换算（策略 A）

旧写法（禁止）：

- `durationBlocks = 30 days / 2 seconds;`
- `cooldownBlocks = 1 hours / 2 seconds;`

新写法（推荐）：

- 合约只接收显式 blocks 值：
  - `initialize(..., durationBlocks, cooldownBlocks)` 或 `setDuration(durationBlocks)`
- “30 days / 1 hour”等墙钟语义只存在于链下：
  - 部署脚本/配置文件按网络写入 `durationBlocks/cooldownBlocks`
  - 前端展示用 ETA 映射（本文“墙钟时间对齐（方案 1）”）

---

## 备注与局限

- `block.number` 仍然是时间的代理指标，并非精确墙钟时间。
  本指南的安全目标是：把安全关键门槛从**可被出块者小幅操控的秒级时间**上移除。
- 对出块模式特殊的 L2，治理侧需要更谨慎地调 `maxAgeBlocks`。
- 如果业务确实需要墙钟时间，通常正确做法是：
  - 链下调度 + 链上单调性/不可回退约束，或
  - 引入可信时间预言机（会增加信任假设，除非必要一般不建议）。

---

## 执行清单：按策略 A 清除“隐含每块 X 秒”的 `/ 2 seconds` 写法（按影响面优先级）

> 目标：全仓 Solidity 不再出现 `X days / Y seconds`、`X hours / Y seconds` 这类 **seconds→blocks 隐含换算**。
> 链上仍然只使用 `block.number` 做门槛，但 **门槛参数必须是显式 `...Blocks` 配置**（由部署/治理写入），而不是在 Solidity 里从“墙钟时间”推导。

### 优先级 P0（治理/升级/全局门槛：最硬、最该先改）

- **Registry 最大 timelock 延迟上限（MAX_DELAY / MAX_MIN_DELAY_BLOCKS）**
  - **命中**：`src/registry/Registry.sol`、`src/registry/RegistryStorageLibrary.sol`
  - **风险**：把 `7 days / 2 seconds` 固化为 blocks，等价于把“每块多少秒”的假设写死在治理边界里。
  - **推荐改法（A）**：
    - 链上只保存/校验 `minDelayBlocks` 与 `maxDelayBlocks`（均为显式 blocks）。
    - `maxDelayBlocks` 作为部署/治理参数写入（或由治理模块/配置合约提供），避免硬编码秒换算。

- **升级窗口（upgrade window）**
  - **命中**：`src/monitor/DegradationMonitor.sol`
  - **推荐改法（A）**：把窗口改为显式 `upgradeWindowBlocks`（初始化/治理设置），禁止 `24 hours / 2 seconds`。

### 优先级 P1（Reward 门槛参数：高频业务路径/对外集成影响大）

- **Reward configs 默认 duration/cooldown**
- **命中**：`src/Reward/configs/*`
  - **推荐改法（A）**：
    - 初始化阶段不再用 `30 days / 2 seconds` 写默认值；
    - 改为：初始化只绑定 Registry；随后由部署脚本/治理调用显式 setter 写入 `durationBlocks/cooldownBlocks`（或在 initialize 中直接传入 blocks）。

- **RewardManagerCore 的默认缓存 TTL/按期窗口**
  - **命中**：`src/Reward/RewardManagerCore.sol`
  - **推荐改法（A）**：默认值由部署/治理显式传入（或 post-init setter 写入），禁止 `1 hours / 2 seconds`、`1 days / 2 seconds`。

### 优先级 P2（缓存/观测/策略参数：不直接影响资金门槛，但会污染口径）

- **RewardModuleBase 的 RewardView 地址缓存 TTL**
  - **命中**：`src/Reward/internal/RewardModuleBase.sol`
  - **推荐改法（A）**：TTL 变为可配置 `rewardViewCacheTtlBlocks`（显式 blocks，部署/治理设置），避免常量里出现 seconds 换算。

- **策略模块的 cooldownPeriod**
  - **命中**：`src/strategies/RWAAutoLeveragedStrategy.sol`
  - **推荐改法（A）**：cooldown 统一使用显式 `cooldownBlocks` 参数/配置，不在合约里推导。

### 落地顺序（建议）

- **阶段 1（P0）**：先改 Registry/DegradationMonitor，把“治理与升级窗口”从隐含换算中解耦。
- **阶段 2（P1）**：改 Reward configs + RewardManagerCore，把对外可见/可治理的 blocks 参数显式化；同步更新部署脚本与测试期望。
- **阶段 3（P2）**：改缓存 TTL/策略类参数，统一口径并减少误用。

---

## ✅ 本次整改清单（落实追踪，SSOT：block-based）

> 目标：把本文 “禁止秒级时间 / 禁止墙钟语义命名 / 禁止链上隐含 days→blocks 换算” 落到可执行的全仓改动。
> 本清单以“必须落地”为准；如必须保留 legacy 字段名（ABI 兼容），必须在 NatSpec/文档里标注其 **语义为 blockNumber/updateBlock（仅观测）**。

### P0（必须：链上不得存在隐含 days→blocks 换算）

- [x] **清除撮合放款的隐含换算**：`SettlementMatchLib` 不再用 `termDays * BLOCKS_PER_DAY` 推导 `term`，改为显式 bucket→blocks 映射（SSOT）。
  - 变更：新增 `src/libraries/TermBlocksLib.sol`；`src/libraries/SettlementMatchLib.sol` 使用该映射。
- [x] **清除提前还款保证金的隐含换算**：`EarlyRepaymentGuaranteeManager` 不再用 `termDays * _BLOCKS_PER_DAY` 推导 `maturityTime`。
  - 变更：`record.maturityTime = startBlock + termBlocks`（termBlocks 来自显式 bucket→blocks 映射）。
  - 同时：将 `earlyRepayPenaltyDays` 语义明确为 `penaltyBlocks`（legacy 字段名保留）。
- [x] **治理模块不再链上用“天”乘以 blocks-per-day**：`CrossChainGovernance` 的默认值改为显式 blocks 常量（不再 `N * _BLOCKS_PER_DAY`）。

### P1（必须：禁止墙钟语义命名残留，尤其是对外输出/SSOT 相关）

- [x] **View 常量去墙钟单位**：移除 `ViewConstants.CACHE_DURATION = 5 minutes`，仅保留 `CACHE_DURATION_BLOCKS`。
- [x] **LiquidatorView 禁止 `daysSince.../last...Time`**：
  - 已改为 blocks 口径（例如 `blocksSinceLastLiquidation` / `lastLiquidationBlock`），并同步更新 e2e + tests。
  - 同步更新：`scripts/e2e/e2e-localhost-liquidatorview-acceptance.ts`、`test/Vault/view/modules/LiquidatorView.test.ts`。
- [x] **RewardView / FeeRouterView 等 view-meta 禁止 `...Timestamp`**：
  - 已将对外 meta 字段/局部变量命名统一为 `...Block/...UpdateBlock`（legacy 字段名保留处均按 blockNumber 语义标注）。
  - 代表性变更：`RewardView._systemCacheTimestamp -> _systemCacheUpdateBlock`；`FeeRouterView.getSyncStatus()` 返回 `lastSyncBlock`。

### P2（必须：DataPush/事件 schema 文档禁止 `ts/timestamp` 语义）

- [x] **`src/constants/DataPushTypes.sol` payload 注释**：已将 `uint256 ts` 统一改为 `uint256 blockNumber`（或 `updateBlock`），避免下游把它当墙钟时间。
- [x] **RewardModuleBase 推送消费记录**：已将内部 `ts` 参数命名/注释改为 `blockNumber`，并确保向 RewardView/DataPush 推送的最后一项是 blockNumber 语义。

### 文档同步（必须）

- [x] **修复误导性示例**：`docs/Usage-Guide/PriceOracle-Guide.md` 已移除 `priceData.timestamp`；改为 `priceData.blockNumber`（信息字段）并提示 `getPriceUpdateBlock`（新鲜度 SSOT）。


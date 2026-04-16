# 前后端统一建表 SSOT

## 1. 文档目的

本文档用于统一前端、后端、索引器、数据平台在“建表 / 建读模型 / 定字段 / 对齐合约模块”时的单一事实来源（SSOT）。

目标只有四个：

1. 统一哪些链上合约是写入真相，哪些只是只读镜像。
2. 统一前端该读哪些 View，后端该订阅哪些事件，数据库该落哪些表。
3. 统一字段口径，包括金额单位、时间单位、主键、幂等键、版本字段、有效性字段。
4. 统一前后端共享的模块键、产品键、数据表结构，避免重复建模和口径漂移。

本文是对以下文档中与“建表”和“数据消费”直接相关内容的收敛：

1. [Architecture-Guide.md](Architecture-Guide.md)
2. [Usage-Guide/Funds-Flow-Architecture-Guide.md](Usage-Guide/Funds-Flow-Architecture-Guide.md)
3. [Usage-Guide/Cache-Architecture-Guide.md](Usage-Guide/Cache-Architecture-Guide.md)
4. [Usage-Guide/SaaS-Backend-Implementation-Guide.md](Usage-Guide/SaaS-Backend-Implementation-Guide.md)
5. [Usage-Guide/Frontend-Modification-Guide.md](Usage-Guide/Frontend-Modification-Guide.md)
6. [Usage-Guide/Blocks-Only-Product-Guide.md](Usage-Guide/Blocks-Only-Product-Guide.md)
7. [Usage-Guide/WhitelistSystem.md](Usage-Guide/WhitelistSystem.md)
8. [Usage-Guide/Registry-Guide.md](Usage-Guide/Registry-Guide.md)
9. [Usage-Guide/Live-Observability-Gate-Checklist.md](Usage-Guide/Live-Observability-Gate-Checklist.md)

> 补充约束：任何需要把 `DataPushed` / 业务事件作为建表输入的 live release 脚本，其 strict / notice 分层应以 [Usage-Guide/Live-Observability-Gate-Checklist.md](Usage-Guide/Live-Observability-Gate-Checklist.md) 为准。
>
> 文档分工补充：
> 1. 本文负责定义“表应该叫什么、字段应该表达什么、链上哪个模块负责这个表”。
> 2. [Usage-Guide/SaaS-Backend-Implementation-Guide.md](Usage-Guide/SaaS-Backend-Implementation-Guide.md) 负责定义“后端如何用 Prisma / migration / indexer 去实现这些表”。
> 3. 若两文档发生重叠，本文件负责定义口径，SaaS 文档负责定义实现细节。

---

## 2. 总体原则

### 2.1 四层 SSOT

前后端统一建表时，必须先区分四层：

1. 链上写入 SSOT
2. 链上读取 SSOT
3. 链下事实表 SSOT
4. 链下读模型 SSOT

#### 2.1.1 链上写入 SSOT

真实状态写入只能认以下模块，不认任何 View：

1. `VaultCore`
2. `SettlementManager`
3. `BlocksOnlyCoordinator`
4. `CollateralManager`
5. `VaultLendingEngine`
6. `OrderEngine`（core/LendingEngine）
7. `LenderPoolVault`
8. `FeeRouter`
9. `LiquidationManager`
10. `LiquidationPayoutManager`
11. `RewardManagerCore / RewardAccrualManager / EasyToken / AICreditsVault`

#### 2.1.2 链上读取 SSOT

前端当前态读取必须认专属 View，不再从旧路由层或业务写模块拼数据：

1. `PositionView`
2. `HealthView`
3. `StatisticsView`
4. `LoanFlowView`
5. `RewardView`
6. `FeeRouterView`
7. `LiquidatorView`
8. `BlocksOnlyView`
9. `SystemView`
10. `RegistryView`
11. `BatchView`
12. `UserView`
13. `DashboardView`
14. `ValuationOracleView`
15. `ModuleHealthView`
16. `ViewCache`

#### 2.1.3 链下事实表 SSOT

后端若要做历史、审计、对账、搜索、榜单，必须先落事件事实表，不允许直接靠前端 RPC 扫描代替。

链下事实层最小集合：

1. `chain_sync_cursors`
2. `chain_events`
3. `ledger_entries`
4. `accounts`
5. `idempotency_registry`

#### 2.1.4 链下读模型 SSOT

前端列表页、BI 报表、后台聚合页，应该读派生表，不应该重新聚合链上日志：

1. `loan_orders`
2. `user_positions_current`
3. `user_health_current`
4. `system_statistics_current`
5. `loan_flow_user_current`
6. `loan_flow_global_current`
7. `reward_user_cache`
8. `fee_distributions`
9. `liquidation_records`
10. `blocks_only_orders`
11. `assets`
12. `asset_whitelist_snapshots`
13. `price_snapshots`
14. `module_health_snapshots`
15. `cache_retry_queue`

### 2.2 单位口径必须统一

所有字段必须先区分 `amount` 与 `value`：

1. `amount`：token base units，按资产原始 decimals 存储。
2. `value`：统一是 USD value，但**精度跟随资产原生 `assetDecimals`**；若要跨资产聚合，必须额外存储或推导归一化目标精度。

禁止：

1. 在同一字段里混存 token amount 和 USD 值。
2. 在跨资产聚合表里继续存 token amount 作为主展示值。
3. 把 `price` 精度误写成可变口径。

推荐字段后缀：

1. `amountRaw` 或 `amount`
2. `valueUsd`
3. `priceUsd`
4. `assetDecimals`

### 2.3 时间口径必须统一

协议的门槛、到期、缓存新鲜度、blocks-only 生命周期，统一以 block 语义为主。

必须遵守：

1. 业务门槛字段用 `blockNumber`、`openBlock`、`maturityBlock`、`closeBlock`、`updatedBlock`。
2. `timestamp` 只作为观测或索引排序字段，不作为链上业务门槛 SSOT。
3. blocks-only 产品只认 `termBlocks`，不认 `termDays`。

### 2.4 幂等键必须统一

链下系统统一按以下规则做幂等：

1. 链上事件幂等键：`chain:c{chainId}:tx-{txHash}:log-{logIndex}`
2. 链下业务幂等键：`{domain}:{entity}:{scope}:{nonce}`
3. 多租户账表唯一键必须包含 `tenant_id`

禁止继续使用多套 requestId 规则并行存在。

### 2.5 Registry 是模块地址唯一来源

前后端必须共享同一份 module keys，不允许：

1. 前端手写一套字符串 key
2. 后端再手写一套 bytes32 常量解释
3. 文档再使用第三套命名

权威来源：

1. [src/constants/ModuleKeys.sol](src/constants/ModuleKeys.sol)
2. [frontend-config/moduleKeys.ts](frontend-config/moduleKeys.ts)

---

## 3. 前后端必须共享的模块键与合约映射

> 本节是“建表前的模块目录”。任何数据表字段设计、索引任务设计、前端 hook 设计，都必须先落到本表中对应的模块。

### 3.1 核心写路径模块

| Registry Key | 合约 / 模块 | 职责 | 是否写入真相 |
| --- | --- | --- | --- |
| `KEY_VAULT_CORE` | `VaultCore` | 用户统一写入口 | 是 |
| `KEY_SETTLEMENT_MANAGER` | `SettlementManager` | legacy / 通用订单统一还款结算入口 | 是 |
| `KEY_BLOCKS_ONLY_COORDINATOR` | `BlocksOnlyCoordinator` | blocks-only 产品专属写入口 | 是 |
| `KEY_VAULT_BUSINESS_LOGIC` | `VaultBusinessLogic` | reserve / finalizeMatch 业务编排 | 是 |
| `KEY_CM` | `CollateralManager` | 抵押账本与托管 | 是 |
| `KEY_LE` | `VaultLendingEngine` | 债务账本 | 是 |
| `KEY_ORDER_ENGINE` | `core/LendingEngine` | orderId SSOT / LoanOrder | 是 |
| `KEY_LENDER_POOL_VAULT` | `LenderPoolVault` | 出借资金托管池 | 是 |
| `KEY_FR` | `FeeRouter` | 费用分账 | 是 |
| `KEY_LIQUIDATION_MANAGER` | `LiquidationManager` | 清算主执行器 | 是 |
| `KEY_LIQUIDATION_PAYOUT_MANAGER` | `LiquidationPayoutManager` | 清算残值分配 | 是 |
| `KEY_RM` | `RewardManager` | Reward 写入口门面 | 部分 |
| `KEY_REWARD_MANAGER_CORE` | `RewardManagerCore` | 奖励核心账本逻辑 | 是 |
| `KEY_REWARD_ACCRUAL_MANAGER` | `RewardAccrualManager` | 惩罚与应计处理 | 是 |
| `KEY_EASY_TOKEN` | `EasyToken` | 奖励通证真实余额 | 是 |
| `KEY_AI_CREDITS_VAULT` | `AICreditsVault` | AI Credits 链上余额与购买结算 | 是 |

### 3.2 前端当前态读取模块

| Registry Key | View 合约 | 主要用途 | 是否为镜像层 |
| --- | --- | --- | --- |
| `KEY_POSITION_VIEW` | `PositionView` | 用户仓位与仓位版本元数据 | 是 |
| `KEY_HEALTH_VIEW` | `HealthView` | 健康因子与风险态 | 是 |
| `KEY_STATS` | `StatisticsView` | 系统统计聚合 | 是 |
| `KEY_LOAN_FLOW_VIEW` | `LoanFlowView` | 协议借还流量聚合 | 是 |
| `KEY_REWARD_VIEW` | `RewardView` | 奖励读面与 DataPush | 是 |
| `KEY_FRV` | `FeeRouterView` | 费用镜像读面 | 是 |
| `KEY_LIQUIDATION_VIEW` | `LiquidatorView` | 清算只读与 DataPush 单点 | 是 |
| `KEY_BLOCKS_ONLY_VIEW` | `BlocksOnlyView` | blocks-only 订单读面 | 是 |
| `KEY_VIEW_CACHE` | `ViewCache` | 系统级快照缓存 | 是 |
| `KEY_SYSTEM_VIEW` | `SystemView` | 门面 / 路由 / 元信息 | 是 |
| `KEY_REGISTRY_VIEW` | `RegistryView` | 模块枚举与反查 | 是 |
| `KEY_BATCH_VIEW` | `BatchView` | 批量读面 | 是 |
| `KEY_USER_VIEW` | `UserView` | 用户聚合读面 | 是 |
| `KEY_DASHBOARD_VIEW` | `DashboardView` | 仪表盘聚合 | 是 |
| `KEY_VALUATION_ORACLE_VIEW` | `ValuationOracleView` | 价格读面 | 是 |
| `KEY_MODULE_HEALTH_VIEW` | `ModuleHealthView` | 模块健康观测 | 是 |

### 3.3 白名单、权限与价格模块

| Registry Key | 合约 / 模块 | 说明 |
| --- | --- | --- |
| `KEY_ACCESS_CONTROL` | `AccessControlManager` | 权限控制单一来源 |
| `KEY_ASSET_WHITELIST` | `AssetWhitelist` | 资产准入 SSOT |
| `KEY_WHITELIST_REGISTRY` | `WhitelistRegistry` | 地址白名单能力 |
| `KEY_AUTHORITY_WHITELIST` | `AuthorityWhitelist` | 机构白名单 |
| `KEY_PRICE_ORACLE` | `PriceOracle` | 链上价格存储 |
| `KEY_PRICE_UPDATER` | `PriceUpdater` | 链上价格写入口 |
| `KEY_STATS_PUSH_MANAGER` | `StatisticsPushManager` | Statistics 推送单入口 |
| `KEY_LOAN_FLOW_PUSH_MANAGER` | `LoanFlowPushManager` | LoanFlow 推送单入口 |
| `KEY_CACHE_MAINTENANCE_MANAGER` | `CacheMaintenanceManager` | A 类缓存维护器 |

### 3.4 三个必须锁死的命名约束

1. `KEY_STATS` 的 Registry 字符串是 `VAULT_STATISTICS`，不得额外创造 `STATISTICS_VIEW` 作为 canonical key。
2. `KEY_PRICE_UPDATER` 的业务命名统一叫 `PRICE_UPDATER`，但链上兼容 raw key 仍是 `COINGECKO_PRICE_UPDATER`。
3. `KEY_LIQUIDATION_VIEW` 对应的对外命名统一是 `LiquidatorView`，不要再混用 `LiquidationView` 作为正式名。

---

## 4. 统一建表清单

> 后端实现规则：本节是表名与字段语义的权威来源。若后端使用 Prisma，则 model 命名可以按工程习惯调整，但真实表名、字段语义、主键和幂等规则必须与本节保持一致。对应实现草案见 [Usage-Guide/SaaS-Backend-Implementation-Guide.md](Usage-Guide/SaaS-Backend-Implementation-Guide.md) 第 8.3.1 节。

本节按“必须建”和“建议建”分组。

### 4.1 必须建的基础表

#### 4.1.1 `registry_modules`

用途：保存某链当前 Registry 模块快照，作为前后端共享配置与核验表。

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `moduleKeyName` | text | 例如 `KEY_POSITION_VIEW` |
| `moduleKeyHash` | text | bytes32 hash |
| `moduleName` | text | 例如 `PositionView` |
| `moduleAddress` | text | 当前地址 |
| `source` | text | `registry` / `fallback` |
| `apiVersion` | int nullable | View 版本 |
| `schemaVersion` | int nullable | View schema 版本 |
| `updatedBlock` | int nullable | 最近确认块 |
| `updatedAt` | timestamptz | 索引时间 |

主键建议：

1. `chainId + moduleKeyName`

#### 4.1.2 `chain_sync_cursors`

用途：记录每条链、每类索引任务的同步进度。

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint / serial | 自增 ID |
| `chainId` | int | 链 ID |
| `cursorName` | text | 如 `vault_router_datapushed` |
| `lastProcessedBlock` | int | 最近处理块 |
| `updatedAt` | timestamptz | 更新时间 |

唯一键建议：

1. `chainId + cursorName`

#### 4.1.3 `chain_events`

用途：全量链上事件事实表，所有读模型和重放流程的基础输入。

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text | 建议值 `c{chainId}:{txHash}:log-{logIndex}` |
| `chainId` | int | 链 ID |
| `blockNumber` | int | 区块高度 |
| `blockHash` | text | 区块哈希 |
| `txHash` | text | 交易哈希 |
| `logIndex` | int | 日志索引 |
| `address` | text | 事件发出合约 |
| `topic0` | text | 事件主题 |
| `eventName` | text | 事件名 |
| `argsJson` | jsonb | 原始参数 |
| `status` | text | `PENDING` / `CONFIRMED` / `REORGED` |
| `userAddress` | text nullable | 常用筛选列 |
| `asset` | text nullable | 常用筛选列 |
| `orderId` | text nullable | 常用筛选列 |
| `indexedAt` | timestamptz | 写入时间 |

主键建议：

1. `id`

唯一性规则：

1. `chainId + txHash + logIndex` 全局唯一

#### 4.1.4 `accounts`

用途：链下复式记账账户表。

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tenantId` | text | 租户 ID |
| `accountId` | text | 账户 ID，如 `user:0x...` / `platform:reward_pool` |
| `currency` | text | 资产或记账币种 |
| `balance` | numeric / bigint | 当前余额 |
| `accountType` | text | 用户 / 平台 / 池子 / 系统账户 |
| `updatedAt` | timestamptz | 更新时间 |

主键建议：

1. `tenantId + accountId + currency`

#### 4.1.5 `ledger_entries`

用途：链下复式记账分录表，是对账与审计主表。

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint / serial | 自增 ID |
| `tenantId` | text | 租户 ID |
| `idempotencyKey` | text | 统一幂等键 |
| `source` | text | `chain_event` / `api` / `settlement` / `reward` 等 |
| `entryType` | text | `deposit` / `fee` / `reward_mint` / `reward_burn` 等 |
| `debitAccountId` | text | 借方账户 |
| `creditAccountId` | text | 贷方账户 |
| `currency` | text | 资产或记账币种 |
| `amount` | numeric / bigint | 原始金额 |
| `amountUsd` | numeric / bigint nullable | 统一估值（原始 value 整数） |
| `chainId` | int nullable | 链 ID |
| `txHash` | text nullable | 关联交易 |
| `logIndex` | int nullable | 关联日志 |
| `orderId` | text nullable | 订单 ID |
| `userAddress` | text nullable | 关联用户 |
| `assetAddress` | text nullable | 关联资产 |
| `status` | text | `posted` / `cancelled` / `reorged` |
| `metadata` | jsonb | 补充上下文 |
| `createdAt` | timestamptz | 创建时间 |

唯一键建议：

1. `tenantId + idempotencyKey`

#### 4.1.6 `idempotency_registry`

用途：统一跨服务幂等检查表。

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tenantId` | text | 租户 ID |
| `idempotencyKey` | text | 幂等键 |
| `domain` | text | `chain` / `reward` / `usage` / `billing` |
| `requestHash` | text nullable | 请求摘要 |
| `status` | text | `PROCESSING` / `SUCCEEDED` / `FAILED` |
| `responseJson` | jsonb nullable | 缓存响应 |
| `createdAt` | timestamptz | 创建时间 |
| `updatedAt` | timestamptz | 更新时间 |

唯一键建议：

1. `tenantId + idempotencyKey`

### 4.2 必须建的业务表

#### 4.2.1 `loan_orders`

用途：订单读模型表，承接 legacy / 通用订单生命周期。

来源：

1. `OrderEngine`
2. `LoanNFT`
3. `SettlementManager`
4. `LiquidationManager`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `orderId` | text | uint256 字符串 |
| `chainId` | int | 链 ID |
| `borrower` | text nullable | 借款人 |
| `lender` | text nullable | 出借方，当前口径通常为 `LenderPoolVault` |
| `nftOwner` | text nullable | NFT 当前持有人 |
| `tokenId` | text nullable | LoanNFT tokenId |
| `assetAddress` | text nullable | 借款资产 |
| `principalAmount` | numeric / bigint nullable | 借款本金 |
| `principalValueUsd` | numeric / bigint nullable | 本金估值（原始 value 整数） |
| `termDays` | int nullable | legacy 字段 |
| `termBlocks` | int nullable | blocks 期限 |
| `openBlock` | int nullable | 开仓区块 |
| `maturityBlock` | int nullable | 到期区块 |
| `closeBlock` | int nullable | 关闭区块 |
| `status` | text nullable | 当前状态 |
| `createdBlock` | int nullable | 创建块 |
| `updatedBlock` | int nullable | 更新块 |
| `updatedAt` | timestamptz | 更新时间 |

主键建议：

1. `orderId`

#### 4.2.2 `blocks_only_orders`

用途：blocks-only 产品专属读模型表。

来源：

1. `BlocksOnlyCoordinator`
2. `BlocksOnlyView`
3. 分页来源推荐直接使用 `BlocksOnlyView.getBorrowerOrdersPaginated(...)` / `getSystemOrdersPaginated(...)`，两者当前返回三层状态对象（`runtime + lifecycle + closeReason + shortfallStatus + collateralDisposition + hasLoss`），不再是纯 runtime 列表。

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `orderId` | text | 订单 ID |
| `chainId` | int | 链 ID |
| `borrower` | text | 借款人 |
| `lender` | text | 当前固定应为 `LenderPoolVault` |
| `assetAddress` | text | 借款资产 |
| `principalAmount` | numeric / bigint | 本金 |
| `principalValueUsd` | numeric / bigint nullable | 本金估值（原始 value 整数） |
| `termBlocks` | int | 唯一期限字段 |
| `rateBps` | int | 当前首版应为 0 |
| `openBlock` | int | 开仓块 |
| `maturityBlock` | int | 到期块 |
| `closeBlock` | int nullable | 关闭块 |
| `status` | text nullable | 兼容层主生命周期状态；不得单独承担终态解释，未来应收敛为 coarse lifecycle，而不是混合 `SETTLED` / `TRADE_CLOSED` / `LIQUIDATED_WITH_SHORTFALL` |
| `closeReason` | text nullable | 第一层显式 close reason，如 full repay、trade close、maturity borrower refund、maturity lender delivery、liquidation with loss |
| `shortfallStatus` | text nullable | 第二层 shortfall 子状态；blocks-only 目标态应显式为 `NONE`，而不是通过 `remainingDebt` 反推 |
| `collateralDispositionStatus` | text nullable | 第三层 collateral custody/disposition 状态，如 coordinator custody、returned to borrower、delivered to lender |
| `hasLoss` | boolean | 是否存在 unresolved loss 或 write-off 型 loss；不得通过 `status` 名称推断 |
| `remainingDebt` | numeric / bigint | 运行时剩余债务 |
| `isMatured` | boolean | 是否到期 |
| `isClosed` | boolean | 是否关闭 |
| `canCloseTrade` | boolean | 是否可走 debt-free trade-close 路径 |
| `canSettleOrLiquidate` | boolean | 是否可走 maturity-gated settle/liquidate 路径 |
| `schemaVersion` | int nullable | 当前 BlocksOnlyView schema 版本；现行为 `2` |
| `lastObservedBlock` | int | 最近观测块 |
| `updatedAt` | timestamptz | 更新时间 |

主键建议：

1. `chainId + orderId`

补充口径：

1. `blocks_only_orders` 负责承接 one-block / blocks-only 订单 runtime truth，不负责保存前端最终文案。
2. 前端若需展示“状态同步中”，应基于链上写事件已到达、但 `blocks_only_orders` 尚未收敛到最新 runtime 的事实来推导，而不是额外持久化一份 UI 文案字段。
3. `status + closeReason + shortfallStatus + collateralDispositionStatus + remainingDebt + lastObservedBlock` 才是 one-block 页面订单终态展示的最小事实集合；`status` 单独使用会丢失业务原因与资产去向。
4. 在 `termBlocks = 1` 下，还款后的下一次读面可能同时出现 `isMatured = true` 与 `canCloseTrade = true`；前后端不得把这两者视为互斥。
5. `hasLoss = true` 时，即使 `remainingDebt == 0`，也不得把该订单展示成 clean close；必须结合 `shortfallStatus` 或 write-off 事实给出独立文案。
6. 分页接口升级后，适配层应统一从 `item.runtime.*` 读取列表字段，例如 `item.runtime.orderId` / `item.runtime.status` / `item.runtime.remainingDebt`。
7. 固定映射示例：`lifecycle = REPAID` 且 `closeReason = NONE` 时应展示为“债务已清但仍未关闭（debt-free open）”；仅当 `lifecycle = CLOSED` 且 `closeReason` 为 `BLOCKS_TRADE_CLOSE` 或 `BLOCKS_MATURITY_CLOSE` 时才展示为已收尾。

#### 4.2.3 `assets`

用途：资产元数据总表。

来源：

1. `AssetWhitelist`
2. `PriceOracle`
3. 部署资产配置
4. RWA 价格目录

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `assetAddress` | text | 资产地址 |
| `symbol` | text nullable | 代币符号 |
| `name` | text nullable | 代币名称 |
| `assetDecimals` | int nullable | decimals |
| `isAllowed` | boolean | 是否进入 `AssetWhitelist` |
| `isSettlementToken` | boolean | 是否结算币 |
| `isBlocksOnlyEnabled` | boolean | 是否已接入 blocks-only 产品目录 |
| `sourceProvider` | text nullable | 价格来源商 |
| `sourceId` | text nullable | 统一 source id |
| `bootstrapPriceUsd` | numeric / bigint nullable | 启动价（字段名可兼容保留） |
| `active` | boolean | 是否启用 |
| `updatedBlock` | int nullable | 最近更新块 |
| `updatedAt` | timestamptz | 更新时间 |

主键建议：

1. `chainId + assetAddress`

#### 4.2.4 `asset_whitelist_snapshots`

用途：资产准入历史表。

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `assetAddress` | text | 资产地址 |
| `isAllowed` | boolean | 是否允许 |
| `sourceTxHash` | text nullable | 来源交易 |
| `sourceLogIndex` | int nullable | 来源日志 |
| `updatedBlock` | int | 更新块 |
| `updatedAt` | timestamptz | 更新时间 |

### 4.3 建议建的当前态缓存表

#### 4.3.1 `user_positions_current`

用途：前端用户仓位当前态表。

来源：

1. `PositionView`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `userAddress` | text | 用户地址 |
| `assetAddress` | text | 资产地址 |
| `collateralAmount` | numeric / bigint | 抵押数量 |
| `debtAmount` | numeric / bigint | 债务数量 |
| `collateralValueUsd` | numeric / bigint nullable | 抵押估值（原始 value 整数） |
| `debtValueUsd` | numeric / bigint nullable | 债务估值（原始 value 整数） |
| `isValid` | boolean | 缓存是否有效 |
| `blockNumber` | int nullable | 快照块 |
| `version` | bigint nullable | 并发版本 |
| `requestId` | text nullable | 推送请求 ID |
| `seq` | bigint nullable | 推送序号 |
| `updatedAt` | timestamptz | 更新时间 |

主键建议：

1. `chainId + userAddress + assetAddress`

#### 4.3.2 `user_positions_history`

用途：仓位历史快照表。

建议字段：

1. 在 `user_positions_current` 基础上增加 `sourceTxHash`、`sourceLogIndex`、`snapshotType`

#### 4.3.3 `user_health_current`

用途：用户风控当前态。

来源：

1. `HealthView`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `userAddress` | text | 用户地址 |
| `healthFactor` | numeric / bigint nullable | 健康因子 |
| `collateralValueUsd` | numeric / bigint nullable | 抵押估值（原始 value 整数） |
| `debtValueUsd` | numeric / bigint nullable | 债务估值（原始 value 整数） |
| `riskLevel` | text nullable | 风险等级 |
| `isLiquidatable` | boolean nullable | 是否可清算 |
| `isValid` | boolean | 是否有效 |
| `blockNumber` | int nullable | 快照块 |
| `updatedAt` | timestamptz | 更新时间 |

主键建议：

1. `chainId + userAddress`

#### 4.3.4 `system_statistics_current`

用途：协议统计面板表。

来源：

1. `StatisticsView`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `activeUsers` | bigint nullable | 活跃用户数 |
| `totalCollateralUsd` | numeric / bigint nullable | 全局抵押估值（原始 value 整数） |
| `totalDebtUsd` | numeric / bigint nullable | 全局债务估值（原始 value 整数） |
| `totalGuaranteeUsd` | numeric / bigint nullable | 全局保证金估值（原始 value 整数） |
| `lastUpdateBlock` | int nullable | 最近更新块 |
| `isValid` | boolean nullable | 是否有效 |
| `updatedAt` | timestamptz | 更新时间 |

主键建议：

1. `chainId`

#### 4.3.5 `loan_flow_user_current`

用途：用户借还流量镜像。

来源：

1. `LoanFlowView`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `userAddress` | text | 用户地址 |
| `borrowVolumeUsd` | numeric / bigint nullable | 借款总量（原始 value 整数） |
| `repayVolumeUsd` | numeric / bigint nullable | 还款总量（原始 value 整数） |
| `borrowCount` | bigint nullable | 借款次数 |
| `repayCount` | bigint nullable | 还款次数 |
| `lastUpdateBlock` | int nullable | 最近更新块 |
| `updatedAt` | timestamptz | 更新时间 |

主键建议：

1. `chainId + userAddress`

#### 4.3.6 `loan_flow_global_current`

用途：全局借还统计镜像。

主键建议：

1. `chainId`

#### 4.3.7 `reward_user_cache`

用途：奖励页面与风控等级页面当前态。

来源：

1. `RewardView`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `userAddress` | text | 用户地址 |
| `level` | int nullable | Reward Level |
| `lockedEasy` | numeric / bigint nullable | 锁定 Easy |
| `pendingPenaltyDebt` | numeric / bigint nullable | 待抵扣罚分 |
| `eligibleLoanCount` | bigint nullable | 可计奖 loan 数 |
| `onTimeRepayCount` | bigint nullable | 按时还款数 |
| `totalEasyEarned` | numeric / bigint nullable | 累计奖励 |
| `lastUpdateBlock` | int nullable | 最近更新块 |
| `updatedAt` | timestamptz | 更新时间 |

主键建议：

1. `chainId + userAddress`

#### 4.3.8 `fee_distributions`

用途：费用拆分明细表。

来源：

1. `FeeRouter`
2. `FeeRouterView`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `txHash` | text | 交易哈希 |
| `logIndex` | int | 日志索引 |
| `tokenAddress` | text | 费用币种 |
| `totalAmount` | numeric / bigint | 总费用 |
| `platformAmount` | numeric / bigint nullable | 平台分成 |
| `ecosystemAmount` | numeric / bigint nullable | 生态分成 |
| `otherAmount` | numeric / bigint nullable | 其他分成 |
| `relatedOrderId` | text nullable | 关联订单 |
| `blockNumber` | int | 块号 |
| `createdAt` | timestamptz | 索引时间 |

唯一键建议：

1. `chainId + txHash + logIndex`

#### 4.3.9 `liquidation_records`

用途：清算明细表。

来源：

1. `LiquidationManager`
2. `LiquidationPayoutManager`
3. `LiquidatorView`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `liquidationId` | text | 可用 txHash 或业务 ID |
| `orderId` | text nullable | 关联订单 |
| `userAddress` | text nullable | 被清算人 |
| `liquidator` | text nullable | 清算执行人 |
| `debtAsset` | text nullable | 债务资产 |
| `collateralAsset` | text nullable | 抵押资产 |
| `repaidAmount` | numeric / bigint nullable | 偿还额 |
| `seizedAmount` | numeric / bigint nullable | 扣押额 |
| `penaltyAmount` | numeric / bigint nullable | 惩罚额 |
| `payoutAmount` | numeric / bigint nullable | 残值分配额 |
| `blockNumber` | int | 清算块 |
| `txHash` | text | 交易哈希 |
| `logIndex` | int | 日志索引 |
| `createdAt` | timestamptz | 创建时间 |

#### 4.3.10 `price_snapshots`

用途：价格最终态镜像表。

来源：

1. `PriceOracle`
2. `ValuationOracleView`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `assetAddress` | text | 资产地址 |
| `priceUsd` | numeric / bigint | 价格（原始整数，精度由 `assetDecimals` 解释） |
| `assetDecimals` | int nullable | decimals |
| `isValid` | boolean nullable | 是否有效 |
| `blockNumber` | int nullable | 最近价格块 |
| `publishStatus` | text nullable | 链下发布状态，如 `PENDING` / `SYNCING` / `PUBLISHED` / `STALE` / `FAILED` |
| `publishStatusReason` | text nullable | 发布状态或降级原因 |
| `publishStatusUpdatedAt` | timestamptz nullable | 发布状态最近更新时间 |
| `updatedAt` | timestamptz | 更新时间 |

主键建议：

1. `chainId + assetAddress`

补充口径：

1. `price_snapshots` 是前后端联合判断价格可展示性的最小读模型，不能只存链上 `priceUsd` 而缺少 `publishStatus` 与 `assetDecimals`。
2. one-block 页面必须联合消费“链上最终价状态 + 链下 publish status”；仅凭 `priceUsd` 或 `isValid` 不足以稳定区分“价格待同步”和“价格过期”。
3. 推荐前端推导规则：
	- `isValid = false` 且 `blockNumber` 为空或为 0，同时 `publishStatus` 未完成：展示“价格待同步”
	- `isValid = false` 且后端/价格系统给出 stale 诊断，或 `publishStatus = STALE`：展示“价格过期”
	- `isValid = true` 且 `publishStatus = PUBLISHED`：展示“价格正常”

#### 4.3.11 `module_health_snapshots`

用途：模块健康状态表。

来源：

1. `ModuleHealthView`
2. `HealthView`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chainId` | int | 链 ID |
| `moduleAddress` | text | 模块地址 |
| `moduleKeyName` | text nullable | 模块键名 |
| `isHealthy` | boolean | 是否健康 |
| `lastCheckTime` | bigint / int nullable | 最近检查时间或块 |
| `totalChecks` | bigint nullable | 总检查次数 |
| `failureCount` | bigint nullable | 失败次数 |
| `lastReason` | text nullable | 最近失败原因 |
| `updatedAt` | timestamptz | 更新时间 |

### 4.4 必须建的 AI Credits 表

#### 4.4.1 `credit_balances`

用途：AI Credits 高频实时余额表。

#### 4.4.2 `ai_requests`

用途：AI 请求幂等扣次权威表。

建议字段必须包含：

1. `tenantId`
2. `userAddress`
3. `requestId`
4. `idempotencyKey`
5. `status`
6. `model`
7. `metadata`
8. `settled`
9. `reservedAt`
10. `finishedAt`
11. `refundAt`

#### 4.4.3 `credit_purchases`

用途：链上购买镜像表，对应 `AICreditsVault.CreditsPurchased`。

### 4.5 必须建的失败重试表

#### `cache_retry_queue`

用途：缓存推送失败事件的链下重放队列。

来源事件：

1. `CacheUpdateFailed`
2. `CacheUpdateFailedWithContext`
3. `HealthPushFailed`
4. `RewardViewPushFailed`
5. `ViewCachePushFailed`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint / serial | 自增 ID |
| `chainId` | int | 链 ID |
| `sourceEventId` | text | 对应 `chain_events.id` |
| `moduleName` | text | 来源模块 |
| `userAddress` | text nullable | 关联用户 |
| `assetAddress` | text nullable | 关联资产 |
| `requestId` | text nullable | 推送请求 ID |
| `seq` | bigint nullable | 推送序号 |
| `payloadJson` | jsonb | 原始载荷 |
| `retryStatus` | text | `PENDING` / `RETRYING` / `SUCCEEDED` / `DEAD_LETTER` |
| `retryCount` | int | 已重试次数 |
| `lastError` | text nullable | 最近错误 |
| `nextRetryAt` | timestamptz nullable | 下次重试时间 |
| `createdAt` | timestamptz | 创建时间 |
| `updatedAt` | timestamptz | 更新时间 |

---

## 5. 事件到表的统一映射

### 5.1 Reward 域

Reward 域链下系统应优先订阅 `RewardView.DataPushed`，但必须明确：这仍然是镜像流，不是主账本真相。

| 事件 / DataType | 来源合约 | 链下落表 |
| --- | --- | --- |
| `EASY_MINTED` | `RewardView` | `ledger_entries` |
| `REWARD_BURNED` | `RewardView` | `ledger_entries` |
| `EASY_SPENT` | `RewardView` | `ledger_entries` |
| `EASY_RECYCLED_SPLIT` | `RewardView` | `ledger_entries` |
| `REWARD_LEVEL_UPDATED` | `RewardView` | `reward_user_cache` |
| `REWARD_EARN_STATE_UPDATED` | `RewardView` | `reward_user_cache` |
| `REWARD_PENALTY_LEDGER_UPDATED` | `RewardView` | `reward_user_cache` |
| `REWARD_STATS_UPDATED` | `RewardView` | `system_statistics_current` 或系统缓存表 |

### 5.2 资金链与抵押域

| 事件 / DataType | 来源合约 | 链下落表 |
| --- | --- | --- |
| `DEPOSIT_PROCESSED` | `CollateralManager` / `VaultRouter DataPushed` | `ledger_entries` |
| `WITHDRAW_PROCESSED` | 抵押路径相关事件 | `ledger_entries` |
| `RESERVE_FOR_LENDING` | `VaultBusinessLogic` | `ledger_entries` |
| `CANCEL_RESERVE` | `VaultBusinessLogic` | `ledger_entries` |
| `RESERVE_CONSUMED` | `VaultBusinessLogic` | `ledger_entries` |
| `FeeDistributed` | `FeeRouter` | `ledger_entries`、`fee_distributions` |
| `LOAN_FLOW_UPDATED` | `LoanFlowView` | `loan_flow_user_current` / `loan_flow_global_current` |

### 5.3 清算域

| 事件 / DataType | 来源合约 | 链下落表 |
| --- | --- | --- |
| 清算执行事件 | `LiquidationManager` | `liquidation_records` |
| 残值分配事件 | `LiquidationPayoutManager` | `ledger_entries`、`liquidation_records` |
| 清算镜像推送 | `LiquidatorView` | `liquidation_records` |

### 5.4 Blocks-Only 域

| 事件 / DataType | 来源合约 | 链下落表 |
| --- | --- | --- |
| `BlocksOnlyMatchFinalized` | `BlocksOnlyCoordinator` | `blocks_only_orders`、`chain_events` |
| `BlocksOnlyRepaymentRecorded` | `BlocksOnlyCoordinator` | `blocks_only_orders`、`ledger_entries` |
| `BlocksOnlyOrderTradeClosed` | `BlocksOnlyCoordinator` | `blocks_only_orders`、`ledger_entries` |
| `BlocksOnlyOrderSettled` | `BlocksOnlyCoordinator` | `blocks_only_orders`、`ledger_entries` |
| `BlocksOnlyOrderDelivered` | `BlocksOnlyCoordinator` | `blocks_only_orders`、`ledger_entries` |
| `DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED / REPAID / TRADE_CLOSED / SETTLED / DELIVERED` | blocks-only DataPush | `blocks_only_orders` 或对应明细表 |
| `DATA_TYPE_BLOCKS_ONLY_LIQUIDATED` | blocks-only DataPush | 兼容保留哈希常量，当前路径不再发出 |

### 5.5 AI Credits 域

| 事件 / DataType | 来源合约 | 链下落表 |
| --- | --- | --- |
| `CreditsPurchased` | `AICreditsVault` | `credit_purchases`、`credit_balances` |
| `CreditsSettled` | `AICreditsVault` | 结算批次表 / `credit_balances` |

---

## 6. 前端字段消费统一要求

### 6.1 前端只读当前态时必须消费这些元字段

任何 View 读面返回结构，只要存在以下字段，前端必须统一处理，不允许忽略：

1. `isValid`
2. `blockNumber`
3. `version`
4. `requestId`
5. `seq`

前端展示规则：

1. `isValid = false` 时必须展示“缓存未就绪 / 数据可能回退到账本 / 正在同步”之类状态。
2. `blockNumber` 用于展示新鲜度，但不自行解释为时间门槛。
3. `version / requestId / seq` 用于调试、链下比对和重试诊断。

### 6.1.1 one-block / blocks-only 页面展示补充规则

one-block 页面必须把“订单状态”和“价格状态”视为两类独立事实，不允许混成一个前端状态字段：

1. 订单状态主来源：`BlocksOnlyView` / `blocks_only_orders`
2. 价格状态主来源：`ValuationOracleView` + `price_snapshots`
3. 价格 freshness / 过期裁决主来源：`PriceOracle` / 后端 preflight / publish status

推荐前端展示推导：

1. 当订单写事件已确认，但 `blocks_only_orders.status`、`remainingDebt`、`canCloseTrade`、`canSettleOrLiquidate` 仍未收敛到预期 runtime 时，展示“状态同步中”。
2. 当 `price_snapshots.isValid = false` 且 `publishStatus` 仍是 `PENDING` / `SYNCING` / 空值时，展示“价格待同步”。
3. 当 `price_snapshots.publishStatus = STALE`，或后端显式给出 `PriceOracle__StalePrice` / `isPriceValid=false` 等 stale 诊断时，展示“价格过期”。
4. 任何依赖估值、健康度或可清算判断的按钮，都必须同时看订单状态与价格状态；不能仅凭 `blocks_only_orders.canCloseTrade = true` 或 `canSettleOrLiquidate = true` 就放开操作。

### 6.2 前端禁止自己推导的内容

前端禁止做以下推导：

1. 从多个合约返回值自行拼完整仓位真相，绕开 `PositionView`
2. 自行用秒数计算 blocks-only maturity
3. 自行把 `termDays = 1` 解释成 `termBlocks = 1`
4. 自行把镜像层延迟解释成主账本失败

### 6.3 前端与后端共享的字段命名建议

建议前后端统一使用以下后缀：

1. `...Amount` 表示 token base units
2. `...ValueUsd` 表示估值
3. `...Block` 表示单点区块
4. `...Blocks` 表示区块数量
5. `isValid` 表示缓存有效性
6. `updatedAt` 表示数据库时间
7. `updatedBlock` 表示链上状态最近块

---

## 7. 字段级最小清单

本节是落地时的最小字段验收单。

### 7.1 所有链上读模型表必须至少具备

1. `chainId`
2. 业务主键
3. `updatedAt`
4. `updatedBlock` 或 `blockNumber`
5. 原始金额字段
6. 如涉及跨资产聚合，则必须有 `...Usd` 数值字段与对应的 decimals/归一化目标精度字段

### 7.2 所有事件派生表必须至少具备

1. `txHash`
2. `logIndex`
3. `blockNumber`
4. `chainId`
5. 事件源地址
6. 幂等键

### 7.3 所有多租户账表必须至少具备

1. `tenantId`
2. `idempotencyKey`
3. `createdAt`
4. `updatedAt`

### 7.4 所有 blocks-only 相关表必须至少具备

1. `termBlocks`
2. `openBlock`
3. `maturityBlock`
4. `closeBlock`
5. `status`
6. `remainingDebt`
7. `isMatured`
8. `isClosed`
9. `canCloseTrade`
10. `canSettleOrLiquidate`

### 7.5 所有价格相关表必须至少具备

1. `assetAddress`
2. `priceUsd`
3. `assetDecimals`
4. `blockNumber`
5. `isValid`
6. `publishStatus`

### 7.6 所有仓位与健康表必须至少具备

1. `userAddress`
2. `assetAddress`（如按资产维度）
3. `collateralAmount`
4. `debtAmount`
5. `collateralValueUsd`
6. `debtValueUsd`
7. `isValid`
8. `blockNumber`

---

## 8. 实施顺序建议

推荐实施顺序：

1. 先统一前后端 module keys 与 Registry 映射。
2. 先建基础表：`registry_modules`、`chain_sync_cursors`、`chain_events`、`accounts`、`ledger_entries`、`idempotency_registry`。
3. 再建核心读模型：`loan_orders`、`assets`、`user_positions_current`、`user_health_current`、`system_statistics_current`、`reward_user_cache`、`blocks_only_orders`。
4. 再建 AI Credits 与 cache retry 表。
5. 最后统一前端类型、后端 DTO、索引器 mapping 与运营报表。

---

## 9. 最终结论

前后端统一建表时，必须收敛到下面这句话：

1. 写入真相认账本与资金合约。
2. 当前态展示认专属 View。
3. 历史与审计认 `chain_events`。
4. 账务与余额认 `ledger_entries + accounts`。
5. 多租户隔离认 `tenant_id + idempotency_key`。
6. 跨资产估值一律先归一化到业务明确指定的目标精度，不能默认认固定 8 位。
7. blocks-only 一律认 `termBlocks + maturityBlock`。
8. Registry 与 module keys 是前后端共享的唯一模块目录。

如果后续新增业务线、前端页面或链下报表，必须先把它挂到本文件某个模块和某张表上，再开始开发。
# EVM 关键事件字典

## 1. 目的

本文档定义当前 EVM 合约仓库对前端、后端、索引器、运维团队需要稳定暴露的关键事件口径。

目标不是穷举所有 Solidity `event`，而是明确：

1. 哪些事件是对接层必须消费的关键事件。
2. 哪些事件是业务权威事实。
3. 哪些事件只是观测、缓存或调试用途。
4. 链下索引应优先依赖哪一层事件流。

## 2. 权威来源

当前关键来源分为三层：

1. 合约源码中的 `event` 定义。
2. `DataPushed(bytes32 indexed dataTypeHash, bytes payload)` 统一事件总线。
3. 已经与代码路径对齐的架构文档与 Funds-Flow 文档。

当前默认规则：

1. 面向索引器和后端投影的统一消费入口，优先使用 `DataPushed`。
2. 面向部署治理和模块升级审计，优先使用 Registry 事件。
3. 面向观测、缓存失败、自愈补偿，使用失败类事件。
4. 如某业务模块同时发“模块专属事件”和 `DataPushed`，链下主消费口径优先 `DataPushed`，模块专属事件作为辅助审计依据。

## 3. 关键事件分层

### 3.1 统一索引总线

| 事件/数据类型 | 来源 | 语义 | 权威性 |
|---|---|---|---|
| `DataPushed(dataTypeHash, payload)` | `IDataPush` / 各业务模块 | 统一链下消费入口，按 `dataTypeHash` 解码具体业务载荷 | 高 |
| `DEPOSIT_PROCESSED` | 抵押主路径 | 用户完成抵押入金后的统一投影事件 | 高 |
| `WITHDRAW_PROCESSED` | 抵押主路径 | 用户完成抵押提取后的统一投影事件 | 高 |
| `RESERVE_FOR_LENDING` | Reserve 主路径 | 资金预留成功后的统一投影事件 | 高 |
| `RESERVE_CONSUMED` | 撮合放款主路径 | reserve 被消耗并进入放款路径 | 高 |
| `FEE_DISTRIBUTED` | FeeRouter | 费用分发结果 | 高 |
| `REPAY_AND_SETTLE` | 还款/结算主路径 | 用户还款并触发结算 | 高 |
| `COLLATERAL_RELEASED` | 还款/结算主路径 | 抵押释放结果 | 高 |
| `LOAN_CREATED` | 借款主路径 | 订单化借款或放款落账结果 | 高 |
| `LOAN_REPAID` | 还款主路径 | 债务清偿结果 | 高 |
| `LOAN_FLOW_UPDATED` | LoanFlow 推送链路 | 贷款流视图更新 | 中 |
| `GUARANTEE_LOCKED` | 保证金主路径 | 保证金锁定结果 | 高 |
| `GUARANTEE_RELEASED` | 保证金主路径 | 保证金释放结果 | 高 |
| `GUARANTEE_FORFEITED` | 保证金主路径 | 保证金没收结果 | 高 |
| `EASY_MINTED` | Reward 主路径 | 奖励代币发放镜像事件 | 中 |
| `REWARD_PENALTY_LEDGER_UPDATED` | Reward 主路径 | 奖励惩罚台账更新 | 中 |

说明：

1. 以上数据类型名称来自当前仓库已对齐的业务文档与实现口径。
2. 索引器应按 `dataTypeHash` 建立解码表，而不是零散订阅多个业务模块 ABI。
3. 业务投影和对账系统优先消费这层事件。

### 3.2 模块专属业务事件

| 事件 | 来源 | 语义 | 建议用途 |
|---|---|---|---|
| `DepositProcessed` | `CollateralManager` | 抵押存入成功 | 审计、调试、与 `DEPOSIT_PROCESSED` 交叉核对 |
| `WithdrawProcessed` | `CollateralManager` | 抵押提取成功 | 审计、调试、与 `WITHDRAW_PROCESSED` 交叉核对 |
| `LendReserveCreated` | `VaultBusinessLogic` | reserve 创建成功 | reserve 级审计与排障 |
| `LendReserveConsumed` | `VaultBusinessLogic` | reserve 被 consume | 撮合链路审计 |
| `FeeDistributed` | `FeeRouter` | 费用分配执行结果 | 费用归集和会计核对 |
| `GuaranteeLocked` | `EarlyRepaymentGuaranteeManager` / `GuaranteeFundManager` 相关链路 | 保证金锁定 | 保证金审计 |
| `EarlyRepaymentProcessed` | `EarlyRepaymentGuaranteeManager` | 提前还款保证金结算 | 保证金与提前还款核对 |
| `GuaranteeForfeited` | 保证金链路 | 保证金没收 | 违约/清算补充核对 |
| `EasyMinted` | `EasyEmissionController` | Easy 发放 | 奖励核对 |
| `PenaltyApplied` | `RewardAccrualManager` / `RewardManager` | 奖励惩罚落账 | 奖励惩罚链路审计 |

默认规则：

1. 这层事件可被索引器消费，但不应替代 `DataPushed` 作为统一入口。
2. 若专属事件与 `DataPushed` 同时存在，`DataPushed` 优先承担统一投影职责。
3. 专属事件主要用于链路排障、审计追踪、字段交叉验证。

### 3.3 部署与治理事件

| 事件 | 来源 | 语义 | 建议用途 |
|---|---|---|---|
| `RegistryInitialized` | `RegistryEvents` | Registry 初始化完成 | 部署验收 |
| `ModuleChanged` | `RegistryEvents` | 某模块地址直接变更 | 升级监控 |
| `ModuleUpgradeScheduled` | `RegistryEvents` | 模块升级已排期 | 发布窗口监控 |
| `ModuleUpgraded` | `RegistryEvents` | 模块升级执行完成 | 版本切换确认 |
| `ModuleUpgradeCancelled` | `RegistryEvents` | 模块升级取消 | 变更审计 |
| `BatchModuleChanged` | `RegistryEvents` | 批量模块变更 | 批量部署审计 |
| `ModuleKeyRegistered` | `RegistryEvents` | 动态模块键注册 | Registry 生态扩展审计 |
| `ModuleKeyUnregistered` | `RegistryEvents` | 动态模块键注销 | Registry 生态扩展审计 |
| `AdminChanged` | `RegistryEvents` | 管理员变更 | 治理审计 |
| `UpgradeAdminChanged` | `RegistryEvents` | 升级管理员变更 | 治理审计 |
| `EmergencyActionExecuted` | `RegistryEvents` | 紧急动作执行 | 高优先级告警 |

### 3.4 失败与补偿事件

| 事件 | 来源 | 语义 | 处理规则 |
|---|---|---|---|
| `RewardViewPushFailed` | `RewardModuleBase` | Reward 镜像推送失败 | 不代表主账本失败；链下应补偿或重试 |
| `HealthPushFailed` | Health 推送链路 | Health 镜像推送失败 | 不代表主账本失败；需要补偿 |
| `CacheRefreshAttempted` | `CacheMaintenanceManager` | 缓存刷新尝试结果 | 用于 cache 维护告警 |
| `PriceUpdateFailed` | `PriceUpdater` | 价格发布失败 | 需要区分数据源失败与权限配置失败 |
| `PriceValidationFailed` | `PriceUpdater` | 价格校验失败 | 需要风控与预警跟进 |

默认规则：

1. 失败类事件默认是“观测失败”或“镜像失败”信号，不直接等价于业务主账本失败。
2. 链下消费方收到这类事件时，应优先走补偿、重试、回源链上读取，而不是直接把订单置为业务失败。

## 4. 索引与消费建议

### 4.1 前端

前端默认应：

1. 直接读 View 模块或后端 Query Service。
2. 不直接依赖零散模块事件拼业务状态。
3. 如需活动流或异步状态感知，优先依赖后端基于 `DataPushed` 聚合后的投影结果。

### 4.2 后端

后端默认应：

1. 使用 `DataPushed` 作为统一业务事件总线。
2. 使用 Registry 事件监控升级、变更、模块漂移。
3. 使用失败类事件驱动补偿任务、重试任务和人工告警。

### 4.3 索引器

索引器默认应：

1. 主订阅 `DataPushed`。
2. 辅助订阅 Registry 事件、关键模块专属事件、失败类事件。
3. 为每个关键 `dataTypeHash` 建立固定 schema 与版本说明。

## 5. 兼容规则

事件字典更新必须遵守：

1. 新增事件或新增 `dataTypeHash` 可以增量发布，但必须补文档。
2. 变更既有 payload schema 时，必须同步给出兼容策略。
3. 如移除旧事件或停用旧 schema，必须给出迁移窗口和停用说明。
4. 不允许前端、后端、索引器各自维护不同事件解释口径。

## 6. 当前范围说明

本文档是现阶段 EVM 对接的稳定事件字典初版，重点覆盖：

1. 资金主路径。
2. 保证金主路径。
3. 奖励镜像主路径。
4. Registry/升级治理主路径。
5. 推送失败与补偿主路径。

未纳入本版的模块专属低频事件，可在后续版本补充，但不影响当前前后端与索引层的统一对接。
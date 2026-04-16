# 前端钱包直连迁移上线 Checklist

本清单用于把“前端签名 + 后端命令执行”迁移到“前端钱包直接调用链上入口”时的工程化联调与上线验收。

> 当前这份上线清单只覆盖 legacy / 通用订单、AI Credits 与对应的主读面。blocks-only 暂不作为当前默认联调、默认产物要求或默认放行项；若后续按“成交即终局”的 trade-like 交割重做，会单独整理迁移清单。

适用边界：

- 前端仓负责钱包写交易、链上主读、错误解码、灰度开关与用户交互。
- 后端仓负责报价、签名中继、索引、历史、审计、reconciliation 与 keeper 控制面。
- 运维仓负责产物分发、配置漂移、canary、监控、告警、发布证据与回滚。

关联文档：

- [../FRONTEND_CONTRACTS_INTEGRATION.md](../FRONTEND_CONTRACTS_INTEGRATION.md)
- [SaaS-Backend-Implementation-Guide.md](SaaS-Backend-Implementation-Guide.md)
- [Monitoring-Observability-Implementation-Guide.md](Monitoring-Observability-Implementation-Guide.md)
- [Platform-Security-Acceptance-Checklist.md](Platform-Security-Acceptance-Checklist.md)
- [Cross-Repo-Contract-Artifact-Connection-Guide.md](Cross-Repo-Contract-Artifact-Connection-Guide.md)

## 前端仓

### 合约产物与配置

- [ ] 已同步最新 ABI / TypeChain，至少覆盖 `VaultCore`、`VaultBusinessLogic`、`SettlementManager`、`AICreditsVault`、`PositionView`、`HealthView`、`RewardView`、`StatisticsView`。
- [ ] ABI 中包含 custom error 定义，前端错误识别不依赖 revert string。
- [ ] 已同步最新 `frontend-config/moduleKeys.ts`，并确认包含 `KEY_VAULT_BUSINESS_LOGIC`。
- [ ] 启动 preflight 会逐个校验关键 Registry key 是否可解析，缺项时显式阻断写交易。
- [ ] 地址解析以 Registry 为 SSOT，本地地址表只作冷启动兜底。

### 写交易接入

- [ ] `deposit(...)` 的 spender 固定解析为 `KEY_CM`。
- [ ] `repay(...)` 的 spender 固定解析为 `KEY_VAULT_CORE`。
- [ ] 普通成交默认走 `VaultBusinessLogic.finalizeMatch(...)`。
- [ ] `finalizeMatch(...)` 的参数编码严格按链上 tuple 顺序组装：`BorrowIntent` / `LendIntent[]` / `sigBorrower` / `sigLenders[]`。
- [ ] `expireAt` 已按 `expireBlock` 处理，不再按 unix timestamp 解释。
- [ ] 已处理 `sigLenders.length !== lendIntents.length` 的本地预校验，避免无意义上链 revert。
- [ ] 已实现 borrower / lender 双边签名收集、reserve 校验、链 ID 校验、pause 校验、allowance 校验、余额校验。

### 费用展示口径

前端在“钱包直连”模式下必须把三类成本拆开展示，不能混成一个“手续费”：

- `Gas fee`：原生链币支付的网络费，谁发交易谁承担。
- `Protocol fee`：协议业务费，通常从借款资产或还款资产里结算，不等于 native gas。
- `Platform execution cost`：平台或 keeper 代发、兜底、补偿推送、清算等后台交易成本；默认不直接展示给普通用户，但前端文案要避免误导为“用户必付”。

前端统一展示规则：

- `approve`、`deposit`、`reserve`、`repay` 默认按“用户钱包支付 gas”展示。
- `finalize` 在钱包直连模式下，若前端让用户自己广播，则按“用户钱包支付 gas”展示；若当前租户仍走后端代发/兜底，则展示为“你不支付这笔 gas，但仍会承担协议业务费”。
- `finalize` 和 `repay` 的协议费，不要写成“链上 gas”；应明确写成“从成交金额/还款金额中结算”。
- BNB 主链前端可以直接展示原生币区间；Arbitrum 主链除了 execution gas，还受 L1 data fee 影响，更适合展示“预计总费用区间”。

#### 用户费用与平台费用判定表

| 动作 | 默认发起方 | 用户是否支付 gas | 是否有协议业务费 | 平台是否承担后台 gas | 前端提示重点 |
| --- | --- | --- | --- | --- | --- |
| `approve` | 用户钱包 | 是 | 否 | 否 | 只提示网络费，不提示平台费 |
| `deposit` | 用户钱包 | 是 | 否 | 否 | 只提示网络费，不提示平台费 |
| `reserve` | 用户钱包（lender） | 是 | 否 | 否 | 只提示网络费，不提示平台费 |
| `finalize` | 用户钱包或后端代发 | 直连模式下通常是；代发模式下通常否 | 是，借款侧平台费从借款资产中结算 | 代发模式下是 | 必须把“gas 支付方”和“协议费承担方”拆开写 |
| `repay` | 用户钱包 | 是 | 是，还款侧平台费从还款资产中结算 | 否；若后续有补偿推送则由平台承担 | 不要把 repay fee 写成 native gas |

#### BNB 主链展示表

假设口径：常见 gas price 约 `0.05-0.2 gwei`；下表用于前端展示和产品口径，不等于测试/运维脚本里的 sponsor 预算。测试里出现的 `0.00528 BNB`、`0.01 BNB` 属于保守补资阈值，不是单次真实用户消耗。

| 动作 | 典型 gas 区间 | 用户侧预计费用 | 平台侧预计费用 | 协议业务费口径 | 建议前端展示文案 |
| --- | --- | --- | --- | --- | --- |
| `approve` | `45k-65k` | 约 `0.000002-0.000013 BNB` | `0` | 无 | `预计网络费很低，通常小于 0.00002 BNB。` |
| `deposit` | `140k-220k` | 约 `0.000007-0.000044 BNB` | `0` | 无 | `你将支付一笔存入抵押的链上网络费，通常在 0.00001-0.00005 BNB。` |
| `reserve` | `180k-300k` | 约 `0.000009-0.000060 BNB` | `0` | 无 | `你将支付一笔挂出资金的链上网络费，通常在 0.00001-0.00006 BNB。` |
| `finalize` | `380k-650k` | 用户直连时约 `0.000019-0.000130 BNB` | 代发模式下约 `0.000019-0.000130 BNB` 由平台承担 | 借款侧平台费，当前口径按借款本金约 `0.3%` 从借款资产中结算 | `成交时会产生平台撮合费；若当前模式为平台代发，你通常不支付这笔成交 gas。` |
| `repay` | `170k-320k` | 约 `0.000009-0.000064 BNB` | 若有后台补偿推送，额外后台成本通常不向用户展示 | 还款侧平台费，当前口径按还款金额约 `0.3%` 从还款资产中结算 | `你将支付还款网络费；另有协议还款费从还款资产中结算，不额外扣 BNB。` |

BNB 主链面向用户的推荐短文案：

- `approve`：`授权交易需要一笔极小的 BNB 网络费。`
- `deposit`：`存入抵押会消耗少量 BNB 作为网络费。`
- `reserve`：`挂出资金会消耗少量 BNB 作为网络费。`
- `finalize`：`成交会结算平台撮合费；若当前为平台代发模式，这笔成交 gas 由平台承担。`
- `repay`：`还款会消耗少量 BNB 网络费；还款手续费从还款资产中结算。`

#### Arbitrum 主链展示表

说明：Arbitrum 的用户感知费用由 execution gas 和 L1 data fee 共同组成，波动通常比 BNB 主链更明显；前端建议展示“预计总费用区间”，不要只展示 gas units。

| 动作 | 典型 execution gas 区间 | 用户侧预计总费用 | 平台侧预计费用 | 协议业务费口径 | 建议前端展示文案 |
| --- | --- | --- | --- | --- | --- |
| `approve` | `45k-65k` | 约 `0.000003-0.000020 ETH` | `0` | 无 | `授权交易会产生一笔小额网络费，最终价格受 Arbitrum L1 data fee 影响。` |
| `deposit` | `140k-220k` | 约 `0.000008-0.000060 ETH` | `0` | 无 | `存入抵押会产生一笔网络费，通常在 0.00001-0.00006 ETH。` |
| `reserve` | `180k-300k` | 约 `0.000010-0.000080 ETH` | `0` | 无 | `挂出资金会产生一笔网络费，最终价格会随 Arbitrum 数据费波动。` |
| `finalize` | `380k-650k` | 用户直连时约 `0.000030-0.000150 ETH` | 代发模式下约 `0.000030-0.000150 ETH` 由平台承担 | 借款侧平台费，当前口径按借款本金约 `0.3%` 从借款资产中结算 | `成交会结算平台撮合费；若由平台代发，你通常不支付这笔成交网络费。` |
| `repay` | `170k-320k` | 约 `0.000010-0.000090 ETH` | 若有后台补偿推送，额外后台成本通常不向用户展示 | 还款侧平台费，当前口径按还款金额约 `0.3%` 从还款资产中结算 | `还款会产生一笔网络费；还款手续费从还款资产中结算，不额外扣 ETH。` |

Arbitrum 主链面向用户的推荐短文案：

- `approve`：`授权交易需要一笔小额网络费，最终金额取决于 Arbitrum 当前数据费。`
- `deposit`：`存入抵押预计会产生少量网络费。`
- `reserve`：`挂出资金预计会产生少量网络费。`
- `finalize`：`成交会结算平台撮合费；如由平台代发，则这笔成交 gas 不由你支付。`
- `repay`：`还款会产生网络费；协议还款费从还款资产中结算。`

#### 实现检查项

- [ ] 前端费用弹窗已把 `gas fee`、`protocol fee`、`platform-paid execution` 分三行展示。
- [ ] `finalize` 页面已支持按租户/网络切换两种模式：`用户自付 gas` 与 `平台代发 gas`。
- [ ] `repay` 页面明确写出“还款手续费从还款资产中结算，不额外扣 native gas 以外的链币”。
- [ ] BNB 主链页面不把 sponsor/warmup 预算值当成用户实际花费展示。
- [ ] Arbitrum 主链页面对费用展示使用“预计总费用区间”，并附带 `最终费用受 L1 data fee 影响` 的说明。

### 事件、错误码与收敛

- [ ] 前端知道 `VaultBusinessLogic.finalizeMatch(...)` 成功后不会发独立的 `MatchFinalized` 事件，成功判定依赖 `tx receipt + downstream 事件 + 主读面收敛`。
- [ ] 已订阅或消费关键事件：`LendReserveConsumed`、`RepayAndSettleProcessed`、`CollateralReleased`、`CreditsPurchased`。
- [ ] legacy / 通用订单已额外订阅或消费 `LiquidationShortfallOpened`、`LiquidationShortfallRecoveryApplied`、`LiquidationShortfallStatusChanged`，不会把 shortfall 压平成普通 liquidated。
- [ ] 对 `SettlementIntentLib__InvalidSignature`、`SettlementIntentLib__IntentExpired`、`SettlementIntentLib__AlreadyMatched`、`VaultBusinessLogic__AssetMismatch`、`VaultBusinessLogic__InsufficientReservedSum`、`VaultBusinessLogic__InsufficientCollateral`、`SettlementManager__NotLiquidatable`、`ZeroAddress`、`InvalidCaller` 建立了 UX 分类。
- [ ] legacy / 通用订单前端已按 `lifecycle + shortfallStatus + collateralDisposition` 展示终态，不会再依赖旧混合枚举名或“debt 看起来为 0”推导订单已完全收尾。
- [ ] blocks-only 前端已按 `BlocksOnlyView.getBlocksOnlyOrderState(orderId)` 展示 `ACTIVE / REPAID / CLOSED`，并能区分 `BLOCKS_TRADE_CLOSE` 与 `BLOCKS_MATURITY_CLOSE`。
- [ ] 所有当前主线使用的 `blockNumber` 字段都按区块轴解释，不当成 wall-clock timestamp。
- [ ] 提交后会刷新 `PositionView` / `HealthView` / `RewardView` / `StatisticsView`，而不是只本地乐观更新。

### 联调与灰度

- [ ] 至少跑通一轮真实钱包联调：deposit -> finalizeMatch -> repay -> 当前态收敛。
- [ ] 至少跑通一轮错误联调：签名过期、reserve 不足、错误 spender、provider 超时、replacement tx。
- [ ] 已接入前端 direct-write 指标：submitted、mined、confirmed、reverted、dropped/replaced、userRejected、viewConvergenceLag。
- [ ] 已准备 feature flag，可按钱包白名单 / 租户 / 网络灰度启用。

## 后端仓

### 职责收缩

- [ ] 普通用户主流程不再由后端默认广播 `finalizeMatch(...)`。
- [ ] 若保留代发能力，已做成独立兜底模式，并且有独立审计和告警。
- [ ] keeper / liquidation / 运营交易与普通用户交易在代码、凭据、告警上完全隔离。

### 共享契约

- [ ] 后端与前端使用同一套 ABI / TypeChain 版本，不再各自维护旧接口快照。
- [ ] 后端与前端使用同一份 `frontend-config/moduleKeys.ts` 或由其派生的兼容产物，不维护第三套 key 字符串。
- [ ] 对 `KEY_VAULT_BUSINESS_LOGIC` 做启动前存在性校验，缺失直接阻断联调。

### 索引、事件与错误分类

- [ ] Indexer 已订阅关键业务事件，不把 `DataPushed` 当唯一事实来源。
- [ ] 对 `LendReserveConsumed`、`RepayAndSettleProcessed`、`CreditsPurchased` 的字段落库已固定，不再写“以当前 ABI 为准”式模糊适配。
- [ ] 链上事件落库按 `(chainId, txHash, logIndex)` 幂等。
- [ ] 后端 reconciliation 能区分“交易成功但事件未落库”“事件已落库但读模型未更新”“前端显示仍未收敛”。
- [ ] 后端错误分类与前端保持同一份 selector -> 语义映射，避免两端对同一 revert 给出不同结论。

### 联调与观测

- [ ] 对前端钱包直连新增 `post_write_reconciliation_seconds`、`event_lag_seconds`、`read_model_lag_seconds`、`tx_revert_by_selector_total` 等指标。
- [ ] 对签名中继、报价 API、撮合 API、keeper API 已配置鉴权、速率限制、幂等和审计。
- [ ] 已跑通一次端到端链路：前端提交交易 -> 后端观测 txHash -> 事件落库 -> read model 收敛 -> API 可见。

## 运维仓

### 产物与发布物管理

- [ ] 每次协议变更后都会重新生成并发布 ABI / TypeChain / `moduleKeys.ts` 产物。
- [ ] 发布物带版本号、commit SHA、生成时间和校验摘要。
- [ ] `moduleKeys.ts` 的产物检查明确包含当前主线所需 key，不允许静默缺失。

### 运行前校验

- [ ] 发布前执行 Registry key drift 检查、模块地址 drift 检查、角色 drift 检查。
- [ ] 发布前执行 canary：preflight、platform runtime baseline、reward baseline、withdraw/cancel-reserve 或等价低副作用写 canary。
- [ ] 发布前确认关键 dashboard 已就绪：前端直连、后端收敛、RPC、事件落库、keeper、安全告警。

### 灰度与回滚

- [ ] 灰度方案定义了白名单范围、观察窗、推进条件、回滚条件。
- [ ] 可以独立关闭前端直连写交易而保留链上主读与后端审计。
- [ ] 回滚包包含旧版 ABI、旧版前端配置、旧版 feature flag、旧版告警路由。

### 证据归档

- [ ] 已留存一次真实联调证据：交易哈希、事件截图、主读收敛截图、告警状态、Registry 解析结果。
- [ ] 已留存一次异常联调证据：至少包含一条 custom error 解码、一条 provider 失败、一条回滚或降级记录。

## 最终放行条件

- [ ] 前端仓、后端仓、运维仓三方阻断项全部清零。
- [ ] 共享产物版本一致：ABI / TypeChain / moduleKeys / 地址表 checksum 一致。
- [ ] 钱包直连灰度与安全验收结论一致，没有“功能可开但安全未签字”的分叉状态。
- [ ] 若仍存在例外项，已写明风险接受人、限制范围、补救时间。
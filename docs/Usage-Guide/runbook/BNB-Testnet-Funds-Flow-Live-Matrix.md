# BNB Testnet Funds-Flow Live Matrix

## 0. 目的

这份矩阵只回答一件事：在 BNB Testnet 真链上，资金链相关模块分别由哪些 live 脚本提供证据、此前缺口是什么、现在是否构成上线阻断项。

适用范围：

1. `scripts/tests/live-test/networks/bnb-testnet/` 下的资金链 live 入口。
2. `test:live:release-gates:bnb-testnet:strict` 的最终放行门禁。
3. 只覆盖资金链主路径与与其直接相关的观测镜像，不覆盖纯治理、纯读优化或 fork-only 工具脚本。

## 1. 统一门禁映射

当前 BNB 全资金链 release gate 已纳入以下十步：

1. `platform full baseline`
2. `fee full baseline`
3. `reward full baseline`
4. `guarantee full baseline`
5. `reserve cancel restore`
6. `withdraw collateral`
7. `lending engine view ssot`
8. `legacy liquidation funds-chain`
9. `blocks-only funds-chain`
10. `ops extension modules`

### 1.1 Gate 分层策略（严格 + 准确）

为避免“门禁越严格、误报越多”的问题，当前建议把 gate 分成两层执行：

1. Layer-A（Correctness Strict，默认放行门）
2. Layer-B（Architecture Strict，专项一致性门）

Layer-A 原则：

1. 以协议正确性不变量为阻断条件。
2. 允许已知、可解释的终态差异。
3. 未知状态迁移或未知资金变化直接失败。

Layer-B 原则：

1. 强制架构路径唯一性（例如 reserve 必须钱包扣款进 pool）。
2. 仅在隔离账户、隔离状态下执行，避免共享 testnet 状态污染。

十项 gate 的分层映射：

| Gate | Layer-A（默认放行） | Layer-B（专项一致性） |
| --- | --- | --- |
| platform full baseline | 主链路状态迁移、资金守恒、权限正确 | 核心写路由不可漂移 |
| fee full baseline | 分账守恒、publish-ready 严格化 | 分账参数与治理口径一致 |
| reward full baseline | reward/penalty/recycle 链路正确 | 奖励模型参数与版本一致 |
| guarantee full baseline | guarantee 生命周期与边界分支正确 | 担保策略与架构口径一致 |
| reserve cancel restore | 已知终态集合内严格校验（未知终态 fail） | 强制 transfer 单一路径 |
| withdraw collateral | 提现权限与余额一致 | 风控参数与边界一致 |
| lending engine view ssot | 写后读一致、字段不漂移 | 读模型契约兼容一致 |
| legacy liquidation funds-chain | 清算执行与分配正确 | 清算策略参数一致 |
| blocks-only funds-chain | term/状态机/DataPush 严格校验 | 产品特定约束强一致 |
| ops extension modules | 未授权调用必须失败 | 运维职责边界与治理一致 |

Blocks-only 补充说明（pre-maturity guard）：

1. Layer-A：共享 testnet 条件下，若 finalize 后已成熟导致 pre-maturity guard 无法验证，允许 `notice+skip`，但成熟态状态机与对齐断言必须继续严格通过。
2. Layer-B：对 pre-maturity guard 采用硬失败策略，无法验证即 FAIL。
3. 推荐执行开关：Layer-A `LIVE_STRICT_BLOCKS_ONLY_PREMATURITY=0`，Layer-B `LIVE_STRICT_BLOCKS_ONLY_PREMATURITY=1`。

## 2. 模块矩阵

| 模块 / 资金链职责 | BNB live 证据 | 之前缺口 | 当前结论 | 是否阻断上线 |
| ----------------- | ------------- | -------- | -------- | ------------ |
| `VaultCore` / `VaultRouter` 用户写入口与路由收口 | `live-platform-baseline`、`live-withdraw-collateral` | 之前只有平台主链路覆盖，提现路径未进入统一 gate | 现已由平台基线 + 提现脚本共同覆盖 | 是 |
| `CollateralManager` 抵押托管与出金 | `live-platform-baseline`、`live-withdraw-collateral`、`live-liquidation`、`live-blocks-only-liquidation` | 之前未把提现与两条收尾路径同时纳入统一 gate | 现已覆盖 deposit / withdraw / liquidation / blocks-only 收尾释放 | 是 |
| `VaultBusinessLogic` reserve / finalize 编排 | `live-platform-baseline`、`live-guarantee-flow`、`live-cancel-reserve` | 之前 `cancelReserve` 只单独存在，不在放行门禁 | 现已纳入统一 gate | 是 |
| `LenderPoolVault` 出借资金托管 | `live-platform-baseline`、`live-cancel-reserve`、`live-lending-engine-view` | 之前缺少统一门禁对 reserve cancel restore 与 lender SSOT 的绑定 | 现已用 reserve / lender-view 双证据覆盖 | 是 |
| `SettlementManager` repay / settle / keeper liquidation 入口 | `live-platform-baseline`、`live-guarantee-baseline`、`live-liquidation` | 之前 release gate 未包含独立 legacy liquidation | 现已纳入统一 gate | 是 |
| `ORDER_ENGINE` (`LendingEngine`) 订单 SSOT | `live-platform-baseline`、`live-guarantee-flow`、`live-lending-engine-view`、`debug:audit-order-engine-deployment-consistency:bnb-testnet` | 之前统一放行没有强制保留桥接审计与 read-side SSOT 证据 | 现已要求部署审计 + live 读证据同时通过 | 是 |
| `VaultLendingEngine` 债务账本 | `live-platform-baseline`、`live-guarantee-flow`、`live-liquidation`、`live-blocks-only-liquidation` | 之前 blocks-only 与 legacy 没有同时进入统一门禁 | 现已按两条产品线分别覆盖 | 是 |
| `FeeRouter` 费用分账 SSOT | `live-fee-baseline`、`live-platform-baseline` | 之前 gate 只有 fee 子门，不足以和平台主链路一起形成全资金链证据 | 现已纳入统一 gate，且 strict 要求 `LIVE_STRICT_FEE_ROUTER_GATE=1` | 是 |
| `FeeRouterView` 费用观测镜像 | `live-fee-baseline` | 之前默认允许 publish-ready 不严格 | 现已在 strict 模式要求 publish-ready，不再只记 notice | 是 |
| `GuaranteeFundManager` 保证金托管 | `live-guarantee-baseline`、`live-platform-baseline` | 之前保证金域未纳入统一 gate | 现已纳入统一 gate | 是 |
| `EarlyRepaymentGuaranteeManager` 早还/违约语义层 | `live-guarantee-baseline`、`live-platform-baseline` | 之前缺少统一门禁覆盖 guarantee runtime + observability | 现已纳入统一 gate | 是 |
| `RewardManager` / `RewardAccrualManager` 惩罚与 reward 写路径 | `live-reward-baseline`、`live-platform-baseline` | 之前 reward 只单独跑，不阻断最终放行 | 现已纳入统一 gate | 是 |
| `RewardView` 奖励观测镜像 | `live-reward-baseline` | 之前 reward observability 失败不一定进入最终门禁 | 现已作为统一 gate 的独立步骤 | 是 |
| `LiquidationManager` / `LiquidationPayoutManager` / `LiquidatorView` legacy 清算执行与残值分配 | `live-liquidation`、`live-platform-baseline` | 之前没有单独 legacy liquidation gate | 现已纳入统一 gate | 是 |
| `BlocksOnlyCoordinator` blocks-only 产品线收尾（trade closeout / maturity closeout） | `live-blocks-only-liquidation` | 之前 blocks-only 路径完全不在 release gates | 现已纳入统一 gate | 是 |
| `VaultRouter.pause/unpause` 权限门禁 | `live-ops-extension-modules` | 之前仅文档声明，不在统一 gate 验证 | 现已纳入统一 gate（权限门禁 staticCall） | 是 |
| `FeeRouter.batchDistribute` 批量费用入口门禁 | `live-ops-extension-modules` | 之前无 bnb live 命中 | 现已纳入统一 gate（权限门禁 staticCall） | 是 |
| `GuaranteeFundManager.releaseGuarantee/forfeitGuarantee` 直入口门禁 | `live-ops-extension-modules` | 之前无 bnb live 命中 | 现已纳入统一 gate（onlyVaultCore 直入口防护） | 是 |
| `LendingEngineView` 读侧 SSOT 与访问控制 | `live-lending-engine-view` | 之前读侧 lender 映射与 access control 不是最终放行项 | 现已纳入统一 gate | 是 |
| reserve 状态机 (`reserve` / `consume` / `cancel`) | `live-platform-baseline`、`live-cancel-reserve` | 之前只覆盖 reserve consume，未强制覆盖 cancel restore | 现已纳入统一 gate | 是 |
| withdraw 路径 | `live-withdraw-collateral` | 之前有脚本但不在最终门禁 | 现已纳入统一 gate | 是 |

## 3. 仍不纳入最终阻断门禁的项

以下项目仍建议持续保留，但不放入“全资金链最终放行”阻断门禁：

| 项目 | 现状 | 结论 |
| ---- | ---- | ---- |
| `VaultRouter.pause/unpause` 真链熔断演练（真实写入） | 当前统一 gate 只覆盖权限门禁 staticCall，不执行 destructive 真暂停 | 共享 testnet 上执行真实 pause 仍建议人工演练，不放入日常自动 gate |
| `live-event-history-manager` | 偏事件历史写入验证 | 对资金链有辅助价值，但不是主账本最终性证据 |
| `live-batch-liquidation-pressure` | 偏压力 / 批量场景 | 建议作为扩展回归，不作为每轮放行硬门槛 |
| `live-read-pressure` / facade consistency | 偏读面稳健性 | 对发布质量重要，但不是资金链放行的第一阻断面 |

## 4. 审计口径说明

阅读这份矩阵时，应遵守以下口径：

1. “有 live 脚本” 不等于 “已进入最终放行门禁”。
2. 只有同时进入 strict release gate，才算最终放行证据的一部分。
3. 对 `FeeRouterView` / `RewardView` / `LiquidatorView` 这类 best-effort 镜像，最终放行要求是“观测链路有独立 strict 证据”，不是把它们与主账本混写为同一结果。
4. 对 BNB Testnet，任何 `deployment-ssot-mismatch` 都优先归类为部署口径错误，不应被网络重试掩盖。

## 5. fork 私有 RPC 配置与执行口径（BNB）

虽然本矩阵聚焦真链 live，但在执行 fork 对照测试时，必须统一使用私有 fork RPC，避免公共池噪声干扰结论。

推荐 `.env`：

```bash
# 常规 testnet RPC（给 live 或其他脚本使用）
BNB_TESTNET_RPC_URL=https://...
BSC_TESTNET_RPC_URL=https://...

# fork 专用私有 RPC（archive + sticky）
BNB_FORK_UPSTREAM_RPC_URL=https://...
```

推荐 fork 对照执行：

```bash
set -a && source .env && set +a
BNB_FORK_AUTONODE_CASES=preflight pnpm -s run test:live:fork:bnb-testnet
BNB_FORK_AUTONODE_CASES=warmup pnpm -s run test:live:fork:bnb-testnet
pnpm -s run test:live:platform-baseline:fork:bnb-testnet
pnpm -s run test:live:release-gates:fork:bnb-testnet
```

执行判定：

1. 若出现 `missing trie node`，应归类为 RPC/infra 问题，不得直接归因协议回归。
2. 若 fork 与 live 结果不一致，需在报告里拆分“协议断言差异”与“RPC 基础设施差异”。
3. fork-only 绿色结果不能替代本矩阵中的 live 放行证据。
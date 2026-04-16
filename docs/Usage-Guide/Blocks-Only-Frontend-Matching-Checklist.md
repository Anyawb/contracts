# Blocks-Only 前端与撮合一页式集成清单

> 本页只回答一件事：当前仓库状态下，前端、撮合服务、keeper/后端在接入 blocks-only 时，哪些事实可以直接依赖，哪些动作必须额外完成。

## 1. 现在能直接依赖的链上事实

- blocks-only 的期限字段只有 `termBlocks`，不要再把 `termDays` 解释成 blocks-only 期限。
- 当前唯一已实现的 blocks-only 产品约束是 `termBlocks = 1`、`rateBps = 0`、`lender = LenderPoolVault`。
- 当前链上资产准入以全局 `AssetWhitelist` 为准；未进入 allowlist 的资产不能进入 blocks-only finalize。
- 当前写入口最小闭环是 `VaultBusinessLogic.finalizeMatchBlocks(...)` → `BlocksOnlyCoordinator.finalizeMatchBlocks(...)` → `VaultCore.borrowForBlocks(...)` / `repayForBlocks(...)`。
- 当前只读入口是 `BlocksOnlyView`，应优先读取其运行时字段 `remainingDebt`、`isMatured`、`isClosed`、`canCloseTrade`、`canSettleOrLiquidate`。
- 上述 runtime 字段是**当前 ABI 现状**，不是未来状态 SSOT 的终局形态；前后端新接入应为 `closeReason`、`shortfallStatus`、`collateralDispositionStatus` 预留展示与存储位，避免继续把单一 `status/isClosed` 当成终态真相。
- 当前 debt-free 订单可直接通过 `BlocksOnlyCoordinator.closeRepaidTradeBlocks(...)` 关闭，不需要额外等待 maturity。
- 当前 maturity 后的 `settleOrLiquidateBlocks(...)` 是 permissionless 收尾入口；keeper 是推荐执行角色，不是权限前置条件。

## 1A. 当前已落地的收尾方案

- blocks-only 继续保留当前借贷壳与账本桥接，但 `BlocksOnlyCoordinator` 内的交易式关闭入口已经落地，用于“交易已成功、仅需完成订单收尾”的路径。
- 其语义已经是当前事实：只要 blocks-only 订单的交易结果已经在链上成立，且 `remainingDebt = 0`、订单仍未关闭，就允许直接收尾，不再要求额外等待 maturity。
- `settleOrLiquidateBlocks(...)` 继续保留，代表 maturity 后的到期收尾语义；trade closeout 不会去修改借贷主体系的通用 `settleBlocksIfRepaid` / `liquidateBlocks` 方向。

## 2. 前端必须做的事

- 产品展示把 blocks-only 作为独立产品线，不要折叠进 legacy day-bucket 下拉框。
- 借贷签名使用 `BorrowIntentBlocks` / `LendIntentBlocks`，并保证字段顺序与 `SettlementIntentLib` 完全一致。
- `expireAt` 在 blocks-only intent 里的真实语义是 `expireBlock`，不是 unix timestamp。
- `termBlocks` 来自链下快照或产品目录，不要自行按秒、按天、按平均区块时间推导。
- 展示 maturity 时按 `openBlock + termBlocks` 理解；对 `1 block` 产品不要再叠加 legacy `+1 confirmation offset`。
- 订单详情、borrower 列表、系统列表优先读 `BlocksOnlyView`，不要在前端本地重算 debt/maturity 状态当作权威结果。
- 资产选择器只把 `AssetWhitelist` 当作链上准入信号，不要把“已 allowlist”直接展示成“blocks-only 已上线”。

## 2A. 前端针对交易式关闭入口的改造点

- 前端状态机要把“已还款 / 债务归零”和“已达到 maturity”拆开，不要继续把 `isMatured = true` 当作交易完成后唯一可收尾前提。
- 前端对 blocks-only 主路径的按钮与状态文案应优先围绕“交易完成并可关闭”建模，而不是继续沿用“等待 maturity 后到期收尾”的借贷语义。
- 前端应提供一条专门的交易收尾（trade closeout）成功态，例如“Trade Filled / Ready To Close / Closed”，不要把这类订单统一展示为 legacy 借贷语义下的“待收尾”或“待交付”。
- 对 blocks-only 主路径，不要把 `canSettleOrLiquidate` 当成唯一前端按钮门槛；交易收尾（trade closeout）应以 `canCloseTrade` 或等价静态调用结果为准。
- 新 UI 状态模型应从一开始按“三层读面”设计：主生命周期、close reason、collateral disposition 分开渲染；即使当前链上还没补齐字段，也不要再把 `TRADE_CLOSED` / `SETTLED` 这类旧枚举名硬编码成顶层业务状态。

## 3. 撮合服务必须做的事

- 统一发布同一版本的 `termBlocks` 快照或 `blocksOnlyProducts` 目录，borrower 与 lender 必须使用同一版本签名。
- 把 `snapshotId` 或等价版本信息绑定进 `salt`，保证签名材料可审计、可复现。
- 撮合时直接按 `termBlocks`、`minTermBlocks`、`maxTermBlocks` 匹配，不要回退到 `termDays`。
- 在链下目录中把资产上架与链上 allowlist 分开建模：allowlist 是必要条件，不是充分条件。
- 当治理移除 allowlist 资产时，撮合侧应立即停止该资产的新 blocks-only 匹配与报价。
- 撮合侧要把 blocks-only 主路径视作“成交后快速关闭的 trade-like 产品”，不要继续把 maturity 当作成交后唯一状态推进器。

## 4. keeper / 后端必须做的事

- 当前 blocks-only maturity 收尾入口是 `BlocksOnlyCoordinator.settleOrLiquidateBlocks(...)`，不是 `SettlementManager.settleOrLiquidate(orderId)`。
- keeper 执行前无需额外角色门槛；但生产运维仍建议由受控 keeper 地址触发以便审计与重试治理。
- 如果 blocks-only 路径进入 maturity 且仍有剩余交割额，当前实现会直接把 order-bound collateral 交付给 lender；不再走通用 `LiquidationManager` 执行语义。
- 价格、风控、失败重试与监控仍应沿用既有 keeper/后端体系，但触发边界应以 blocks-only coordinator 的订单状态为准。

## 4A. keeper / 后端针对交易式关闭入口的执行口径


- keeper / 后端应把 blocks-only 主路径拆成两类：
	1. `remainingDebt = 0` 的交易式关闭路径；
	2. 仍需 maturity 判定的到期收尾路径。
- keeper 不应继续把“等待 maturity”作为 blocks-only 主路径的统一轮询目标；主轮询目标应优先转为“交易结果是否已落账、订单是否已具备 close readiness”。
- 对交易式关闭路径，后端与 keeper 应优先消费账本与 runtime 收敛结果，例如 `remainingDebt = 0`、订单未关闭、close static call 可通过；不要把当前块是否达到 `maturityBlock` 当成唯一 readiness 条件。

## 5. 绝对不要自行假设的内容

- 不要假设当前已经存在独立 blocks-only 产品注册合约或独立 blocks-only whitelist 合约。
- 不要假设当前允许任意 `termBlocks > 1`。
- 不要假设当前 blocks-only 会复用 legacy `SettlementManager` 作为主要 maturity 收尾入口。
- 不要假设当前 blocks-only 会接入 legacy Reward 或 `EarlyRepaymentGuaranteeManager`。
- 不要假设当前 `BlocksOnlyView` 是完全公开读接口。
- 不要把 `settleOrLiquidateBlocks(...)` 误当成 trade-like 主路径的唯一收尾入口；当前 debt-free 订单应优先考虑 `closeRepaidTradeBlocks(...)`。
- 不要假设当前的交易式关闭入口会去修改借贷主体系的通用结算 / 借贷处置语义；该入口只属于 `BlocksOnlyCoordinator` 的独立产品分支。

## 6. 交叉参考

- 前端改造细节：见 [Frontend-Modification-Guide.md](Frontend-Modification-Guide.md)
- 前端与合约连接细节：见 [../FRONTEND_CONTRACTS_INTEGRATION.md](../FRONTEND_CONTRACTS_INTEGRATION.md)
- 后端/keeper 实施细节：见 [SaaS-Backend-Implementation-Guide.md](SaaS-Backend-Implementation-Guide.md)
- 产品边界与现状/目标区分：见 [Blocks-Only-Product-Guide.md](Blocks-Only-Product-Guide.md)

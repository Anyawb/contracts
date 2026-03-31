# Blocks-Only 前端与撮合一页式集成清单

> 本页只回答一件事：当前仓库状态下，前端、撮合服务、keeper/后端在接入 blocks-only 时，哪些事实可以直接依赖，哪些动作必须额外完成。

## 1. 现在能直接依赖的链上事实

- blocks-only 的期限字段只有 `termBlocks`，不要再把 `termDays` 解释成 blocks-only 期限。
- 当前唯一已实现的 blocks-only 产品约束是 `termBlocks = 1`、`rateBps = 0`、`lender = LenderPoolVault`。
- 当前链上资产准入以全局 `AssetWhitelist` 为准；未进入 allowlist 的资产不能进入 blocks-only finalize。
- 当前写入口最小闭环是 `VaultBusinessLogic.finalizeMatchBlocks(...)` → `BlocksOnlyCoordinator.finalizeMatchBlocks(...)` → `VaultCore.borrowForBlocks(...)` / `repayForBlocks(...)`。
- 当前只读入口是 `BlocksOnlyView`，应优先读取其运行时字段 `remainingDebt`、`isMatured`、`isClosed`、`canSettleOrLiquidate`。
- 当前 maturity 后的收尾不是公开权限；`settleOrLiquidateBlocks(...)` 仍要求调用方具备 `ACTION_LIQUIDATE`。

## 2. 前端必须做的事

- 产品展示把 blocks-only 作为独立产品线，不要折叠进 legacy day-bucket 下拉框。
- 借贷签名使用 `BorrowIntentBlocks` / `LendIntentBlocks`，并保证字段顺序与 `SettlementIntentLib` 完全一致。
- `expireAt` 在 blocks-only intent 里的真实语义是 `expireBlock`，不是 unix timestamp。
- `termBlocks` 来自链下快照或产品目录，不要自行按秒、按天、按平均区块时间推导。
- 展示 maturity 时按 `openBlock + termBlocks` 理解；对 `1 block` 产品不要再叠加 legacy `+1 confirmation offset`。
- 订单详情、borrower 列表、系统列表优先读 `BlocksOnlyView`，不要在前端本地重算 debt/maturity 状态当作权威结果。
- 资产选择器只把 `AssetWhitelist` 当作链上准入信号，不要把“已 allowlist”直接展示成“blocks-only 已上线”。

## 3. 撮合服务必须做的事

- 统一发布同一版本的 `termBlocks` 快照或 `blocksOnlyProducts` 目录，borrower 与 lender 必须使用同一版本签名。
- 把 `snapshotId` 或等价版本信息绑定进 `salt`，保证签名材料可审计、可复现。
- 撮合时直接按 `termBlocks`、`minTermBlocks`、`maxTermBlocks` 匹配，不要回退到 `termDays`。
- 在链下目录中把资产上架与链上 allowlist 分开建模：allowlist 是必要条件，不是充分条件。
- 当治理移除 allowlist 资产时，撮合侧应立即停止该资产的新 blocks-only 匹配与报价。

## 4. keeper / 后端必须做的事

- 当前 blocks-only maturity 收尾入口是 `BlocksOnlyCoordinator.settleOrLiquidateBlocks(...)`，不是 `SettlementManager.settleOrLiquidate(orderId)`。
- keeper 执行前先确认自身具备 `ACTION_LIQUIDATE`；不要把普通用户地址当作清算触发方。
- 如果 blocks-only 路径决定进入清算，会复用下游 `LiquidationManager`、`CollateralManager`、`LendingEngine`；这些是共享执行模块，不是 blocks-only 专属公共入口。
- 价格、风控、失败重试与监控仍应沿用既有 keeper/后端体系，但触发边界应以 blocks-only coordinator 的订单状态为准。

## 5. 绝对不要自行假设的内容

- 不要假设当前已经存在独立 blocks-only 产品注册合约或独立 blocks-only whitelist 合约。
- 不要假设当前允许任意 `termBlocks > 1`。
- 不要假设当前 blocks-only 会复用 legacy `SettlementManager` 作为主要 maturity 收尾入口。
- 不要假设当前 blocks-only 会接入 legacy Reward 或 `EarlyRepaymentGuaranteeManager`。
- 不要假设当前 `BlocksOnlyView` 是完全公开读接口。

## 6. 交叉参考

- 前端改造细节：见 [Frontend-Modification-Guide.md](Frontend-Modification-Guide.md)
- 前端与合约连接细节：见 [../FRONTEND_CONTRACTS_INTEGRATION.md](../FRONTEND_CONTRACTS_INTEGRATION.md)
- 后端/keeper 实施细节：见 [SaaS-Backend-Implementation-Guide.md](SaaS-Backend-Implementation-Guide.md)
- 产品边界与现状/目标区分：见 [Blocks-Only-Product-Guide.md](Blocks-Only-Product-Guide.md)

用户使用流程文档（User Flow）

🎯 目标简介

平台支持自由借贷匹配，用户可以作为借方或贷方参与撮合与结算；链上会自动完成记账、清算与（如有）奖励等过程。

> 重要（资金链 SSOT）：本文只描述“用户做什么/看到什么”。所有链上资金链路、入口收口、费用分账与清算口径，统一以 `docs/Usage-Guide/Funds-Flow-Architecture-Guide.md` 为准，避免多处重复导致口径漂移。

> 当前本文的用户主叙事同时覆盖 legacy / 通用订单与 blocks-only，但两条产品线的终态语义不同。blocks-only 已是“成交即终局”的 trade-like 交割：还清后会先进入 debt-free 但仍 open 的 `REPAID`，随后再由 trade close 或 maturity close 进入 `CLOSED`。

🧭 用户流程总览（不复述链上资金链细节）

- 借方：准备抵押资产与借款资产的 `approve`（如需）→ 提交借款意向/发起借款 → 借款成功后可在前端查看仓位与到期信息。
- 贷方：准备出借资产的 `approve`（如需）→ 提交出借意向 → 撮合成功后获得对应债权/订单信息。
- 还款：先 `approve(VaultCore, amount)`，再调用 `VaultCore.repay(orderId, debtAsset, amount)`；结算与抵押释放由链上统一编排。
- 订单状态展示：订单是否 closed / terminal 必须读取显式状态口径；不要从 `repaidAmount`、debt ledger 归零或其它账本副作用反推“订单已结束”。
- 风险：当健康因子低于阈值时仓位可能被清算（细节见 Funds-Flow §6）。
  - 对 legacy / 通用订单，若抵押不足以覆盖全部债务，当前实现会把剩余债务记为显式 shortfall，而不是隐式吞没；前端/客服文案应展示为“已清算，但仍有剩余债务待处理”。

💰 链上落地与资金链（SSOT，只引用不复述）

- 权威资金链路：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`
  - 撮合放款（Match → Borrow Disbursement）：Funds-Flow §3
  - 还款/结算（Repay → Settle → Release Collateral）：Funds-Flow §4
  - 违约清算（Default → Liquidation）：Funds-Flow §6
  - 费用与分账（Fee Flow）：Funds-Flow §7
- 平台手续费口径（SSOT）：借款侧 0.3% + 还款侧 0.3%（总计 0.6%）。
- 按期窗口口径（时间 SSOT=blocks）：链上以 `_ON_TIME_WINDOW_BLOCKS` 判定；“≈24h”仅为理解换算。
- 前端交互/调用示例：`docs/FRONTEND_CONTRACTS_INTEGRATION.md`
- legacy / 通用订单是否彻底收尾，必须以显式 `lifecycle + shortfallStatus + collateralDisposition` 为准；blocks-only 是否彻底收尾，则必须以 `BlocksOnlyView.getBlocksOnlyOrderState(orderId)` 为准，不能从 `remainingDebt == 0` 反推。
- blocks-only 文案必须固定区分“债务已清但仍未关闭（debt-free open）”与“已完成交易收尾/到期收尾/到期交付收尾（trade closeout / maturity closeout / maturity delivery closeout）”。
触发行为	借方奖励	贷方奖励

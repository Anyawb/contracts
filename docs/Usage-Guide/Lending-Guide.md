# RWA 借贷平台借款/贷款使用指南（已收敛到 Funds-Flow SSOT）

> 说明：为避免“资金链/入口/费用分账/清算口径”在多份文档中重复并产生漂移，本文件不再维护借款/撮合/还款的链上流程细节。
>
> **唯一权威口径（SSOT）**：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`

> 当前这组借贷指南的主叙事同时覆盖 legacy / 通用订单与 blocks-only，但 blocks-only 已改为 trade-like 交割单独建模；涉及 blocks-only 的终态与 keeper 收敛，请直接看 Funds-Flow 文档中的 blocks-only 状态机说明。

## 你应该看哪里（SSOT）

- **资金链与结算口径（唯一权威）**：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`
- **legacy / 通用订单 strict 清算与 shortfall 口径**：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md` §4.2 / §6.2
- **用户视角（只讲用户做什么/看到什么）**：`docs/Usage-Guide/UserFlow.md`
- **前端交互与调用示例（approve/入口/参数）**：`docs/FRONTEND_CONTRACTS_INTEGRATION.md`

## 仍需保留的范围

- 本文件仅保留为“导航页”，用于聚合上述 SSOT 链接；不再复述任何链上资金链路、伪代码或 sequence diagram。
- 当前 shortfall、strict/best-effort 估值拆分，以及 legacy / blocks-only 的显式三层状态语义，均已收敛到 Funds-Flow 文档中维护。

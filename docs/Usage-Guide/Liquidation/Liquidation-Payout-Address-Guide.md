# 清算残值分配配置（收款地址/参数：运维与部署用）

> ⚠️ 约束：本文件只说明“部署/运维侧如何配置收款地址与参数”，不定义任何资金链、托管者、资产去向、分配含义或内部调用顺序。相关语义统一以资金链 SSOT 为准：[`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](../Funds-Flow-Architecture-Guide.md)（Default → Liquidation 章节）。

> 按产品线区分入口与模块边界的整改总纲仍以：[`SettlementManager-Refactor-Plan.md`](./SettlementManager-Refactor-Plan.md) 为准。

## 1) 适用范围

- 适用于配置 `LiquidationPayoutManager`（Registry: `KEY_LIQUIDATION_PAYOUT_MANAGER`）的 recipients/rates 等参数。
- 该模块的“钱从哪来、转给谁、何时触发、如何对账”的口径不在此文维护，避免与 Funds-Flow SSOT 漂移。

## 2) 环境变量（部署脚本读取）

部署脚本可读取以下 env（不同网络脚本通用；命名以实际脚本实现为准）：

- `PAYOUT_PLATFORM_ADDR`：平台侧收款地址（建议为合约金库地址）
- `PAYOUT_RESERVE_ADDR`：准备金侧收款地址（建议为合约金库地址，可选）
- `PAYOUT_LENDER_ADDR`：出借人侧收款地址（可为路由合约或其它受控地址；语义以 Funds-Flow SSOT 为准）

> 注意：若未提供 env，脚本可能回退为 deployer 地址；该回退仅适用于本地/演示环境，不应作为上链长期配置。

## 3) 推荐落地步骤（主网/测试网）

1) 准备地址：按 Funds-Flow SSOT 与治理要求确定各收款地址（建议为合约金库/受控合约）。
2) 配置 env 并部署：使用 `deploylocal.ts` / `deploy-arbitrum.ts` / `deploy-arbitrum-sepolia.ts`（或对应网络脚本）部署并在 Registry 注册 `KEY_LIQUIDATION_PAYOUT_MANAGER`。
3) 权限与调整：后续如需更新收款地址或参数，必须由具备 `ACTION_SET_PARAMETER`（或等效治理权限）的角色调用模块的配置入口（例如 `updateRecipients` / `updateRates`）。

## 4) 与前端/链下的对齐

- 前端/链下索引若需要读取 recipients/rates，建议通过 Registry 解析模块地址后读取，避免硬编码。
- “如何解读这些 recipients/rates”不在本文维护，统一以 Funds-Flow SSOT 为准。

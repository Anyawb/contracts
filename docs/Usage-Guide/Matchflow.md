# Matchflow（撮合/结算）说明（已收敛到 Funds-Flow SSOT）

> 说明：为避免撮合/结算资金链在多处重复并与实现漂移，本文件不再维护“撮合落地步骤、依赖 keys/权限清单、资金净额计算”等流程细节。
>
> **唯一权威口径（SSOT）**：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`

## 你应该看哪里（SSOT）

- **撮合放款 / 原子落地（唯一权威）**：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`（Match → Borrow Disbursement）
- **还款/结算入口与编排（唯一权威）**：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`（Repay → Settle）
- **前端/脚本调用示例**：`docs/FRONTEND_CONTRACTS_INTEGRATION.md`

## 本地 E2E（仅作为运行入口提示）

- 脚本：`scripts/e2e/e2e-localhost-matchflow.ts`
- 运行：`npx --yes hardhat run scripts/e2e/e2e-localhost-matchflow.ts --network localhost`

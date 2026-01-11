# 资金链架构指南（SSOT，供逐段完善）

## 目标与范围

本文档只描述“资金链（Money Flow）”的 **权威口径（SSOT）**，用于：

- 明确资金/抵押物在链上的**托管者**是谁（哪个合约持币）
- 明确每条资金流的**唯一写入口**与**最终去向**
- 避免出现“多入口/多分账口径/权限分叉”导致的对账困难

> 本文不替代 `docs/Architecture-Guide.md`，而是把其中“资金链相关段落”抽出来，按资金流重排，方便你逐段补齐与维护。

## SSOT 原则（必须遵守）

- **唯一对外写入口（结算/清算）**：`SettlementManager`（`KEY_SETTLEMENT_MANAGER`）
- **借贷账本（债务）**：`LendingEngine` / `VaultLendingEngine`（`KEY_LE`）
- **抵押账本（真实抵押托管）**：`CollateralManager`（`KEY_CM`）
- **出借资金托管（线上流动性池）**：`LenderPoolVault`（`KEY_LENDER_POOL_VAULT`）
- **费用类资金统一路由**：`FeeRouter`（平台费/罚金/手续费等统一从这里分发）
- **清算残值分配 SSOT**：`LiquidationPayoutManager`（`KEY_LIQUIDATION_PAYOUT_MANAGER`）
- **事件/DataPush 单点（清算）**：`LiquidatorView`（`KEY_LIQUIDATION_VIEW`）

## 架构指南原文入口（建议先读）

- `docs/Architecture-Guide.md`
  - “端到端数据流（简述）”
  - “资金与抵押物去向（权威路径，必须遵守）”
  - “统一结算/清算写入口（SettlementManager）（新增，SSOT）”
  - “清算写入直达账本（专章）”
  - “清算残值分配模块（专章）”

---

## 1) 抵押物资金链（Collateral Flow）

### 1.1 存入抵押（Deposit）

- **发起方**：用户
- **入口（权威写路径）**：`VaultCore.deposit(asset, amount)` → `VaultRouter.processUserOperation(..., ACTION_DEPOSIT, ...)` → `CollateralManager.depositCollateral(user, asset, amount)`
- **真实资金去向（托管者）**：`CollateralManager` 持有 ERC20
- **权威账本**：`CollateralManager` 内部余额/资产列表
- **前端 approve**：`ERC20(asset).approve(CollateralManager, amount)`（spender 是 `CollateralManager`，不是 `VaultCore/VaultRouter`）
- **观测**：`CollateralManager.DepositProcessed` + `DataPushed(DEPOSIT_PROCESSED, ...)`（用于 UI/链下对账）

### 1.2 取回抵押（Withdraw）

- **发起方**：用户
- **入口（权威写路径）**：`VaultCore.withdraw(asset, amount)` → `VaultRouter.processUserOperation(..., ACTION_WITHDRAW, ...)` → `CollateralManager.withdrawCollateral(user, asset, amount)`
- **真实资金去向**：从 `CollateralManager` 转出到用户
- **前端 approve**：通常不需要（由 `CollateralManager` 直接 `transfer` 给用户/receiver）

> TODO：补齐“权限/白名单/暂停”边界（应以 CollateralManager/VaultCore 的实现与 `ActionKeys` 为准）。

---

## 2) 出借资金资金链（Lender Liquidity / Reserve Flow）

### 2.1 出借人入池（Reserve for Lending）

- **发起方**：出借人签名者 `lenderSigner`（EOA 或 ERC-1271）
- **入口（权威写路径）**：`VaultBusinessLogic.reserveForLending(lenderSigner, asset, amount, lendHash)` → `Registry(KEY_LENDER_POOL_VAULT)` → `LenderPoolVault`
- **真实资金去向（托管者）**：`lenderSigner → LenderPoolVault`（由 `VaultBusinessLogic` 执行 `transferFrom(lenderSigner → pool)`）
- **前端 approve**：`ERC20(asset).approve(VaultBusinessLogic, amount)`（spender 是 `VaultBusinessLogic`，不是资金池）
- **SSOT 口径**：
  - `lendIntent.lenderSigner` 表示 **签名者/资金提供者**
  - `LoanOrder.lender` 字段 **不写 signer**，上线口径固定为 **`LenderPoolVault` 地址**

### 2.2 出借人撤回（Cancel Reserve）

- **入口（权威写路径）**：`VaultBusinessLogic.cancelReserve(lendHash)` → `Registry(KEY_LENDER_POOL_VAULT)` → `LenderPoolVault.transferOut(asset, lenderSigner, amount)`
- **真实资金去向**：`LenderPoolVault → lenderSigner`（资金池直出）

> TODO：补齐 `lendHash` 的防重放/状态机口径与事件（以 VBL/签名验证模块为准）。

---

## 3) 撮合放款资金链（Match → Borrow Disbursement）

### 3.1 成交落地（Finalize Match）

- **发起方**：撮合者/keeper/业务编排方（依部署权限而定）
- **入口（SSOT）**：`VaultBusinessLogic.finalizeMatch(borrowIntent, lendIntents, sigBorrower, sigLenders)`（校验签名/消耗 reserve）
- **关键步骤（资金相关，按当前实现）**
  - **出金（资金来源）**：`LenderPoolVault.transferOut(borrowAsset, VaultBusinessLogic, amount)`（先拨付到撮合合约，短暂停留）
  - **手续费路由**：撮合合约 `approve(FeeRouter)` 后调用 `FeeRouter.distributeNormal(borrowAsset, amount)`（FeeRouter 从撮合合约拉取并分发）
  - **净额发放**：撮合合约将净额 `transfer` 给 borrower（净额 = amount - platformFee - ecoFee）
  - **账本落地/订单**：通过 `VaultCore.borrowFor(...)` 写入借贷账本，再由 `ORDER_ENGINE(LendingEngine).createLoanOrder` 创建 `orderId`（并铸造 `LoanNFT`）
  - **关键口径**：`LoanOrder.lender` 固定写 `LenderPoolVault` 地址（资金池），不写 `lenderSigner`

> TODO：补齐“借款净额/手续费扣除顺序”“FeeRouter recipients/rates”“ORDER_ENGINE 权限/LoanNFT MINTER 映射”等。

---

## 4) 还款/结算资金链（Repay → Settle → Release Collateral）

### 4.1 唯一入口（SSOT）

- **发起方**：用户
- **入口（SSOT）**：`VaultCore.repay(orderId, debtAsset, amount)` → `Registry(KEY_SETTLEMENT_MANAGER)` → `SettlementManager.repayAndSettle(user, debtAsset, amount, orderId)`
- **核心原则**：还款不再直达 `LendingEngine`，必须统一进入 `SettlementManager`，避免 “repay vs settle vs liquidate” 分叉。
- **前端 approve**：`ERC20(debtAsset).approve(VaultCore, amount)`（spender 是 `VaultCore`，VaultCore 会转入 SettlementManager）

### 4.2 正常结算（按时/提前）

在同一条链路内完成：

- **债务记账**：`LendingEngine.repay(...)`
- **抵押释放/返还**：`CollateralManager.withdrawCollateralTo(..., borrower)`（抵押直接回 borrower 钱包，无需二次 withdraw）
- **费用/罚金（如有）**：统一走 `FeeRouter` 路由到 `platformTreasury` 等接收方

> TODO：补齐“订单状态机（按时/提前/逾期）”判定口径与精确条件（以 LendingEngine/SettlementManager 实现为准）。

---

## 5) 违约清算资金链（Default → Liquidation）

### 5.1 默认入口（keeper 推荐）

- **入口（默认/推荐，SSOT）**：`SettlementManager.settleOrLiquidate(orderId)`
- **权限**：调用者必须具备 `ActionKeys.ACTION_LIQUIDATE`（keeper/机器人）
- **备注**：`LiquidationManager.liquidate/batchLiquidate` 仅保留为 role-gated 的“显式参数执行器入口”（测试/应急），不应作为常态入口。

### 5.2 清算写入（直达账本）

两种等价实现（其一即可）：

- `SettlementManager → LiquidationManager → CollateralManager.withdrawCollateralTo(...)` + `LendingEngine.forceReduceDebt(...)`
- 或 `SettlementManager → CollateralManager.withdrawCollateralTo(...)` + `LendingEngine.forceReduceDebt(...)`

### 5.3 残值分配（SSOT）

- `LiquidationPayoutManager` 提供 recipients/rates 与 shares 计算
- 实际转账由执行器通过 `CollateralManager.withdrawCollateralTo` 完成（payout 模块不直接转账）

### 5.4 事件/DataPush 单点（链下对账/重试）

- **单点推送**：`LiquidatorView.pushLiquidationUpdate/Batch`
- **推送失败可观测**：执行器发 `CacheUpdateFailed`（供链下重试/告警）

> TODO：补齐清算“receiver/liquidatorOrReceiver”的精确口径，以及与 `FeeRouter`/平台金库的关系（若部分收益以费用类资金处理）。

---

## 6) 费用与分账资金链（Fee Flow）

- **范围**：平台费/罚金/手续费等“费用类资金”
- **SSOT**：所有费用类资金 **必须** 通过 `FeeRouter` 统一路由与分发
- **建议**：`FeeRouter.platformTreasury` 优先配置为“合约金库地址”（降低人为变数）

> TODO：补齐 FeeRouter 的 recipients/rates 配置接口、变更权限（`ACTION_SET_PARAMETER` 等）与前端只读镜像（`FeeRouterView`）对接口径。

---

## 7) 最小验收清单（你逐段完善时建议每段都过一遍）

- **入口唯一性**
  - repay：只允许 `VaultCore → SettlementManager.repayAndSettle`
  - liquidation：默认只允许 `SettlementManager.settleOrLiquidate`（LM 仅应急）
- **托管者明确**
  - 抵押 token 的真实余额必须在 `CollateralManager`
  - 出借资金真实余额必须在 `LenderPoolVault`
- **账本/估值分离**
  - 估值与优雅降级只在 `VaultLendingEngine/PositionView` 估值路径内发生（清算域不直接访问 oracle）
- **费用统一口径**
  - 任何手续费/罚金都走 `FeeRouter`
- **DataPush 单点**
  - 清算相关 DataPush 仅由 `LiquidatorView` 单点发出

---

## 8) 本地一键 Smoke（部署连线/入口/权限/精准报错）

> 目的：在“还未跑完整撮合/借款”的情况下，也能快速验证 **Registry 注册、入口地址解析、keeper 权限门槛**，并把常见的 `unrecognized custom error` 解码成可操作的修复建议。

### 8.1 前置条件

```bash
# A) 启动本地链（单独终端）
pnpm -s run node

# B) 部署并注册模块（另一终端）
pnpm -s run deploy:localhost
```

### 8.2 一条命令运行（推荐）

```bash
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-local.ts" --network localhost
```

可选环境变量：
- `ORDER_ID`：用于测试 `SettlementManager.settleOrLiquidate(orderId)` 的目标订单（默认 `1`）
- `REGISTRY_ADDR`：手动指定 Registry 地址（默认使用 `frontend-config/contracts-localhost.ts`）

示例：

```bash
ORDER_ID=1 pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-local.ts" --network localhost
```

### 8.3 你会得到什么输出

- **部署检查（DeployCheck）**：
  - Registry / VaultCore / SettlementManager / ACM 是否有 code
  - Registry 是否已注册 `VAULT_CORE` / `SETTLEMENT_MANAGER` / `ACCESS_CONTROL`
  - `VaultCore.viewContractAddrVar()` 是否为 0（用于检查 View 是否正确绑定）

- **keeper 入口检查（SSOT）**：
  - 对 `SettlementManager.settleOrLiquidate(orderId)` 做 `staticCall`
  - 若回滚为 `MissingRole()`：脚本会明确提示需要授予 **`ActionKeys.ACTION_LIQUIDATE`（keccak256("LIQUIDATE")）**
  - 若回滚为 `SettlementManager__NotLiquidatable()`：提示该订单目前不满足可清算条件（或 orderId 不存在/不正确）



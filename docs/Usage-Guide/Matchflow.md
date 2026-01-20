# Matchflow（撮合/结算）最佳入口与本地 E2E 验证

本文件说明当前代码中**撮合/撮合落地（match/settlement）**的最佳入口合约与函数、依赖的 Registry Key/权限、以及本地 Hardhat 节点下的可复现实测脚本。

## 最佳入口（推荐）

### 合约
- `src/Vault/modules/VaultBusinessLogic.sol`（模块：`VAULT_BUSINESS_LOGIC`）

### 对外入口函数
- `reserveForLending(lender, asset, amount, lendIntentHash)`
  - **用途**：出借人先把资金转入 `VaultBusinessLogic` 托管池（撮合前置条件）
- `cancelReserve(lendIntentHash)`
  - **用途**：撮合前撤回已保留资金
- `finalizeMatch(borrowIntent, lendIntents, sigBorrower, sigLenders)`
  - **用途**：**撮合落地的一站式入口**（校验 EIP-712 意向签名 → 消耗资金保留 → 账本记账 → 创建订单/NFT/推送 → 手续费分发 → 借方收取净额）

## 关键依赖（Registry Keys）

`finalizeMatch` 内部会通过 `SettlementMatchLib` 读取并调用：
- **`COLLATERAL_MANAGER`**：抵押管理模块（注意：仅允许 `VaultRouter` 调用写入接口）
- **`VAULT_CORE`**：账本写入入口（撮合路径调用 `borrowFor(...)`）
- **`LENDING_ENGINE`**：账本引擎（必须是 `VaultLendingEngine`，实现 `ILendingEngineBasic`）
- **`ORDER_ENGINE`**：订单引擎（必须是 `core/LendingEngine`，负责 `createLoanOrder/repay`，并触发 `LoanNFT/Reward/DataPush`）
- **`FEE_ROUTER`**：手续费分发（`FeeRouter.distributeNormal`）
- **`LOAN_NFT`**：贷款 NFT（由 `ORDER_ENGINE` 调用铸造/更新状态）
- **`ACCESS_CONTROL_MANAGER`**、**`ASSET_WHITELIST`**、**`PRICE_ORACLE`**：权限/白名单/价格依赖

> **重要**：请确保 `scripts/deploy/deploylocal.ts` 中的 key 绑定是：
> - `LENDING_ENGINE -> VaultLendingEngine`
> - `ORDER_ENGINE -> core/LendingEngine`

## 关键权限（AccessControlManager roles）

撮合落地会用到的权限（最小集合）：
- **给 `VaultBusinessLogic` 合约地址**
  - `ACTION_ORDER_CREATE`：允许撮合入口创建订单（`ORDER_ENGINE.createLoanOrder` 的权限检查使用 `address(this)`）
  - `ACTION_DEPOSIT`：允许撮合入口调用 `FeeRouter.distributeNormal` 分发借款手续费
- **给 `ORDER_ENGINE` 合约地址**
  - `ACTION_BORROW`：`LoanNFT` 的 `mintLoanCertificate/updateLoanStatus` 需要（LoanNFT 的 MINTER_ROLE 映射到 `ACTION_BORROW`）
- **给借款人（EOA）**
  - `ACTION_REPAY`：允许其调用 `ORDER_ENGINE.repay(orderId, repayAmount)`（还款走订单引擎路径）

另外需要：
- `FeeRouter.addSupportedToken(token)` 需要 `ACTION_SET_PARAMETER`（一般由部署者持有）
- `AssetWhitelist.addAllowedAsset(token)`、`PriceOracle.updatePrice(...)` 也需要对应权限（本地脚本会自动授予部署者）

## 业务前置条件（非常重要）

### 抵押物写入必须走 VaultCore/VaultRouter
`CollateralManager` 写入接口带 `onlyVaultRouter`，因此撮合合约不应直接调用 `depositCollateral`。

推荐路径：
- 借款人在撮合前通过 `VaultCore.deposit(asset, amount)` 完成抵押写入；
- `finalizeMatch` 只做**抵押充足性校验**，不再补充抵押写入。

### 撮合路径的账本写入入口：VaultCore.borrowFor
撮合库会调用 `VaultCore.borrowFor(borrower, asset, amount, termDays)` 写入账本（内部转发给 `LENDING_ENGINE` / `VaultLendingEngine`）。

## 本地 E2E 验证（已跑通）

### 脚本
- `scripts/e2e/e2e-localhost-matchflow.ts`

### 脚本覆盖流程
- borrower：存抵押（`VaultCore.deposit`）
- lender：资金入池（`VaultBusinessLogic.reserveForLending`）
- match：撮合落地（`VaultBusinessLogic.finalizeMatch`，带 EIP-712 签名）
- order：`ORDER_ENGINE.createLoanOrder` 自动铸造 `LoanNFT`
- repay：borrower 调用 `ORDER_ENGINE.repay`

### 运行方式

1) 部署本地合约（会写入 `frontend-config/contracts-localhost.ts`）：

```bash
cd /Volumes/AI-hosts/contracts
npm run deploy:localhost
```

2) 运行撮合 E2E：

```bash
cd /Volumes/AI-hosts/contracts
npx --yes hardhat run scripts/e2e/e2e-localhost-matchflow.ts --network localhost
```

正常输出示例（关键字段）：
- `orderId ...`
- `LoanNFT tokenId ...`
- `LoanNFT status after repay 1n`
- `Matchflow E2E completed`



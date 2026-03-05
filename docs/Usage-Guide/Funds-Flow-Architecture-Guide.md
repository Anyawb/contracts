# 资金链架构指南（SSOT，供逐段完善）

## 目标与范围

本文档只描述“资金链（Money Flow）”的 **权威口径（SSOT）**，用于：

- 明确资金/抵押物在链上的**托管者**是谁（哪个合约持币）
- 明确每条资金流的**唯一写入口**与**最终去向**
- 避免出现“多入口/多分账口径/权限分叉”导致的对账困难

> 本文不替代 `docs/Architecture-Guide.md`，而是把其中“资金链相关段落”抽出来，按资金流重排，方便你逐段补齐与维护。

## SSOT 原则（必须遵守）

- **唯一对外写入口（结算/清算）**：`SettlementManager`（`KEY_SETTLEMENT_MANAGER`）
- **借贷账本（债务，debt ledger）**：`VaultLendingEngine`（`KEY_LE`）
- **订单引擎（orderId SSOT）**：`core/LendingEngine`（文件：`src/core/LendingEngine.sol`，Registry `KEY_ORDER_ENGINE`）
- **抵押账本（真实抵押托管）**：`CollateralManager`（`KEY_CM`）
- **出借资金托管（线上流动性池）**：`LenderPoolVault`（`KEY_LENDER_POOL_VAULT`）
- **费用类资金统一路由**：`FeeRouter`（平台费/罚金/手续费等统一从这里分发）
- **清算残值分配 SSOT**：`LiquidationPayoutManager`（`KEY_LIQUIDATION_PAYOUT_MANAGER`）
- **事件/DataPush 单点（清算）**：`LiquidatorView`（`KEY_LIQUIDATION_VIEW`）

## 估值口径（Value Unit SSOT：USD-8）

本仓库中存在两类“数量”：

- **amount（账本 SSOT）**：token base units（按各资产自身 decimals 记账），权威来源是 `CollateralManager` 与 `VaultLendingEngine`。
- **value（估值输出 SSOT）**：**USD value with 8 decimals（USD-8）**。任何跨资产聚合（Statistics/风险/LTV/HF/清算参数）都必须先统一到 USD-8。

### USD-8 换算公式（隐含但必须固化为 SSOT）

系统当前隐含的换算公式为：

\[
\text{valueUSD8}=\frac{\text{amount(token base units)}\times\text{price(USD-8 per 1 token)}}{10^{\text{assetDecimals}}}
\]

关键说明（避免口径分叉）：

- `price` 的单位是 **USD-8 per 1 token**（例如 $1.00 记为 `100000000`）。
- `assetDecimals` 是**资产自身 decimals**（用于把 token base units 归一到 “1 token”）。
- **注意**：当前 `IPriceOracle.getPrice(asset)` 的返回值里 `decimals` 在实现中被用作 `assetDecimals`（用于上述除数），**不是**“price 的精度”。price 的精度固定为 USD-8。

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
- **前端集成（approve/调用示例）**：统一见 `docs/FRONTEND_CONTRACTS_INTEGRATION.md`（避免多处重复导致口径漂移）
- **观测**：`CollateralManager.DepositProcessed` + `DataPushed(DEPOSIT_PROCESSED, ...)`（用于 UI/链下对账）

**代码落点（便于对齐/审计/前端集成）**

- **入口：`VaultCore.deposit(asset, amount)`**
  - 文件：`src/Vault/VaultCore.sol`
  - 行为：将请求转发给 `VaultRouter.processUserOperation(msg.sender, ACTION_DEPOSIT, asset, amount, ts)`（用户写入口只在 `VaultCore`；路由职责在 `VaultRouter`）
  - 关联接口（前端/类型生成）：`src/interfaces/IVaultCore.sol`
- **路由：`VaultRouter.processUserOperation(..., ACTION_DEPOSIT, ...)`**
  - 文件：`src/Vault/VaultRouter.sol`
  - 行为：当 `operationType == ActionKeys.ACTION_DEPOSIT` 时调用 `ICollateralManager(cm).depositCollateral(user, asset, amount)`
- **托管者/权威账本：`CollateralManager.depositCollateral(user, asset, amount)`**
  - 文件：`src/Vault/modules/CollateralManager.sol`
  - 真实资金入池：`CollateralManager` 通过 `transferFrom(user -> CollateralManager)` 拉取 ERC20（用户需提前 approve CM 为 spender）
  - 权威账本：`_userCollateral[user][asset]`、`_userAssets[user]`、`_totalCollateralByAsset[asset]`
- **观测事件：`DepositProcessed`**
  - 定义/emit：`src/Vault/modules/CollateralManager.sol`（`event DepositProcessed(...)`）
- **统一 DataPush：`DataPushed(DEPOSIT_PROCESSED, payload)`**
  - 常量：`src/constants/DataPushTypes.sol`（`DATA_TYPE_DEPOSIT_PROCESSED = keccak256("DEPOSIT_PROCESSED")`）
  - emit helper：`src/libraries/DataPushLibrary.sol`（`DataPushLibrary._emitData(...)` / `event DataPushed(...)`）
  - 接口约束：`src/interfaces/IDataPush.sol`

> ✅ **结论（已对齐代码实现）**：`deposit/withdraw` 的权威写路径已统一为 `VaultCore.deposit/withdraw → VaultRouter.processUserOperation → CollateralManager.depositCollateral/withdrawCollateral`。`VaultRouter.processUserOperation` 仅允许 `VaultCore` 调用（用户不应直接调用 `VaultRouter`）；`CollateralManager.depositCollateral/withdrawCollateral` **仅允许 `VaultRouter` 调用（onlyVaultRouter）**，以避免绕过路由侧校验与审计入口。

### 1.3 （补充）仓位缓存/事件推送链路（不改变资金去向，但影响前端读与链下对账）

> 本节不描述资金去向，只描述“仓位缓存更新（View）”的权威链路与可观测事件，避免出现“读错合约/订阅错事件”导致的对账与 UI 异常。

#### 1.3.1 角色与职责（严格架构）

- **VaultCore（用户写入口 SSOT）**：用户写入口只在 `VaultCore`（deposit/withdraw/repay）；借款不提供 direct user `VaultCore.borrow`，由撮合/订单化路径编排；账本写入不经 View。
- **VaultRouter（slim router）**：
  - 仅负责 `processUserOperation` 的 deposit/withdraw 路由；
  - 仅负责接收来自 `VaultCore` 的 `push*` 推送，并转发到 View 模块（例如 `PositionView`）；
  - 不再提供任何查询接口/缓存/测试模式（这些已全部迁移到 View 模块）。
- **PositionView（仓位缓存 SSOT）**：用户抵押/债务缓存与 0-gas 查询入口（带 TTL 与回退到账本的有效性标识）。

#### 1.3.2 仓位推送链路（SSOT，best-effort）

写入账本成功后（例如 **债务账本 `VaultLendingEngine`（`KEY_LE`）** 的 borrowFor/repay/forceReduceDebt、或抵押账本 `CollateralManager` 的抵押变化），业务模块会走如下链路更新 View：

`业务/账本模块（如 VaultLendingEngine / CollateralManager / SettlementManager） → VaultCore.pushUserPositionUpdate* / pushUserPositionUpdateDelta* → VaultRouter.push* → PositionView.push*`

关键点：

- **VaultRouter.push\*** 只允许 **VaultCore** 调用（onlyVaultCore），用于收敛权限与入口。
- **PositionView.push\*** 需要写入者具备 `ActionKeys.ACTION_VIEW_PUSH`（由 ACM 管理），并且 `PositionView` 会解析 `VaultCore.viewContractAddrVar()` 以识别 VaultRouter（避免重复 key）。
- **best-effort 原则**：推送失败不应阻断账本写入；失败应通过事件可观测并由链下重试（详见 `docs/Architecture-Guide.md` 缓存推送失败与手动重试章节）。

#### 1.3.3 建议订阅/对账的事件（按“唯一来源”）

- **路由层（VaultRouter）**：
  - `VaultAction(action, user, amount1, amount2, asset, blockNumber)`：仅用于 deposit/withdraw 路由的可观测记录
  - `UserPositionPushed(user, asset, collateral, debt, blockNumber, requestId, seq)`：全量仓位推送（forward 到 PositionView）
  - `UserPositionDeltaPushed(user, asset, collateralDelta, debtDelta, blockNumber, requestId, seq)`：增量仓位推送（forward 到 PositionView；同时 best-effort 推动统计）
  - `ModuleCacheRefreshed(blockNumber)`：A 类模块地址缓存刷新（仅 `CacheMaintenanceManager` 可调用）
- **缓存层（PositionView）**：
  - `UserPositionCachedWithVersion(user, asset, collateral, debt, version, blockNumber)`：仓位缓存落地（带版本，推荐对账订阅）
  - `CacheUpdateFailed(...)` / `IdempotentRequestIgnored(...)`：推送失败与幂等重放观测

> ✅ 结论：**前端/链下的“仓位读取”应以 `PositionView` 为准；不要从 `VaultRouter` 读取任何仓位数据（已不再提供查询）。**

### 1.2 取回抵押（Withdraw）

- **发起方**：用户
- **入口（权威写路径）**：`VaultCore.withdraw(asset, amount)` → `VaultRouter.processUserOperation(..., ACTION_WITHDRAW, ...)` → `CollateralManager.withdrawCollateral(user, asset, amount)`
- **真实资金去向**：从 `CollateralManager` 转出到用户
- **前端集成（approve/调用示例）**：统一见 `docs/FRONTEND_CONTRACTS_INTEGRATION.md`（避免多处重复导致口径漂移）

#### 权限 / 白名单 / 暂停边界（以代码实现为准，严格对齐 `docs/Architecture-Guide.md`）

- **VaultCore（用户入口 SSOT，最小校验）**
  - **参数校验**：`asset != address(0)`，`amount != 0`
  - **重入保护**：用户写入口为 `nonReentrant`（例如 `deposit/withdraw/repay` 及 batch 入口）
  - **注意**：`VaultCore` **不承担**资产白名单校验与暂停校验（这是刻意的“极简入口/权威入口”设计）；但对“模块编排/回调类入口”（如 `borrowFor/repayFor/push*`）会做 caller 限制（`onlyBusinessModule/onlyOrderEngine`），避免被非模块调用。

- **VaultRouter（路由层：暂停 + 白名单 + 入口权限的收敛点）**
  - **暂停（Pausable）**：`processUserOperation` 带 `whenNotPaused`；暂停/恢复入口为 `VaultRouter.pause()` / `VaultRouter.unpause()`，分别要求调用者具备 `ActionKeys.ACTION_PAUSE_SYSTEM` / `ActionKeys.ACTION_UNPAUSE_SYSTEM`
  - **入口权限（禁止用户绕过 VaultCore）**：`processUserOperation` 带 `onlyVaultCore`，只允许 Registry 中 `ModuleKeys.KEY_VAULT_CORE` 对应地址调用；用户**不应**直接调用 `VaultRouter`
  - **资产白名单（AssetWhitelist）**：`processUserOperation` 内部 `_validateAsset(asset)` 会校验：
    - `asset != address(0)`
    - `IAssetWhitelist(_assetWhitelistAddr).isAssetAllowed(asset) == true`（否则回滚 `AssetNotAllowed()`）
  - **金额校验**：`amount != 0`（否则回滚 `AmountIsZero()`）
  - **可用操作集合**：只支持 `ActionKeys.ACTION_DEPOSIT` / `ActionKeys.ACTION_WITHDRAW`，否则回滚 `VaultRouter__UnsupportedOperation(operationType)`

- **CollateralManager（账本 + 托管：余额校验 + 真正转账的权威执行点）**
  - **入口权限（强制 onlyVaultRouter）**：`depositCollateral/withdrawCollateral` 带 `onlyVaultRouter`，只允许从 `VaultCore.viewContractAddrVar()` 解析出来的 `VaultRouter` 调用（防止绕过路由层的暂停/白名单等 guard）
  - **余额/有效性校验**（在 `_withdrawCollateralTo` 内部完成）：
    - `user != address(0)`，`asset != address(0)`，`amount != 0`
    - `userCollateral[user][asset] >= amount`（否则回滚 `CollateralManager__InsufficientCollateral()`）
  - **真实转账**：账本扣减后，`IERC20(asset).safeTransfer(receiver, amount)` 将真实资金从 `CollateralManager` 转给用户（提现路径 `receiver == user`）

> ✅ 总结：**用户提现的权限门槛不是 ACM 角色**，而是“必须走 `VaultCore → VaultRouter` 权威路径”；暂停和资产白名单在 `VaultRouter` 统一收敛，真实转账与余额校验在 `CollateralManager` 权威执行。  
> 🔎 相关代码：`src/Vault/VaultCore.sol`（`withdraw`），`src/Vault/VaultRouter.sol`（`processUserOperation`/`pause`/`unpause`/`_validateAsset`），`src/Vault/modules/CollateralManager.sol`（`withdrawCollateral`/`_withdrawCollateralTo`）。

---

## 2) 出借资金资金链（Lender Liquidity / Reserve Flow）

### 2.1 出借人入池（Reserve for Lending）

- **发起方**：出借人签名者 `lenderSigner`（EOA 或 ERC-1271）
- **入口（权威写路径）**：`VaultBusinessLogic.reserveForLending(lenderSigner, asset, amount, lendIntentHash)`（内部通过 `Registry(KEY_LENDER_POOL_VAULT)` 解析资金池地址）
- **真实资金去向（托管者）**：`lenderSigner → LenderPoolVault`（由 `VaultBusinessLogic` 执行 `transferFrom(lenderSigner → pool)`）
- **前端集成（approve/调用示例）**：统一见 `docs/FRONTEND_CONTRACTS_INTEGRATION.md`（避免多处重复导致口径漂移）
- **SSOT 口径**：
  - `lendIntent.lenderSigner` 表示 **签名者/资金提供者**
  - `LoanOrder.lender` 字段 **不写 signer**，上线口径固定为 **`LenderPoolVault` 地址**

### 2.2 出借人撤回（Cancel Reserve）

- **入口（权威写路径）**：`VaultBusinessLogic.cancelReserve(lendIntentHash)` → `Registry(KEY_LENDER_POOL_VAULT)` → `LenderPoolVault.transferOut(asset, lenderSigner, amount)`
- **真实资金去向**：`LenderPoolVault → lenderSigner`（资金池直出）

#### `lendIntentHash` 防重放 / 状态机 / 事件（以代码实现为准，严格对齐 `docs/Architecture-Guide.md`）

- **哈希语义（SSOT）**：`lendIntentHash` 应与 `SettlementIntentLib.hashLendIntent(lendIntent)` 一致（即出借意向的 EIP-712 结构哈希）。
- **发起方约束（防第三方锁仓）**：`reserveForLending(lenderSigner, ...)` 要求 `msg.sender == lenderSigner`，避免第三方利用“已 approve”替他人锁仓。
- **基础有效性**：`lendIntentHash != 0`
- **状态机（on-chain 最小账本）**：
  - reserve：同一 `lendIntentHash` 只能 reserve 一次（重复会回滚 `SettlementReserveLib__AlreadyReserved`）。
  - cancel：仅原 `lenderSigner` 可撤回（否则回滚 `SettlementReserveLib__NotOwner`）；不存在则回滚 `SettlementReserveLib__NotActive`。
  - consume（撮合消耗）：在 `finalizeMatch` 中对 `lendIntentHash` 做 `consume`（要求 lenderSigner 匹配），并在撮合落地后将该 intent 标记为 matched（避免重放）。
- **可观测事件 / DataPush（用于链下对账/告警/重放）**：
  - `VaultBusinessLogic.LendReserveCreated/Cancelled/Consumed`
  - `DataPushed(RESERVE_FOR_LENDING / CANCEL_RESERVE / RESERVE_CONSUMED, payload)`

#### 代码落点（相关合约 / 库 / 接口路径，后续逐个文件修复用）

- **权威入口（Reserve/Cancel/Finalize）**：`src/Vault/modules/VaultBusinessLogic.sol`
  - `reserveForLending(lenderSigner, asset, amount, lendIntentHash)`
  - `cancelReserve(lendIntentHash)`
  - `finalizeMatch(borrowIntent, lendIntents, sigBorrower, sigLenders)`（此处才做 EIP-712/1271 签名校验，并消耗 reserve）
- **出借资金保留账本（状态机 / 防重放基础）**：`src/libraries/SettlementReserveLib.sol`
  - `reserve(...)` / `cancel(...)` / `consume(...)` / `consumeUpTo(...)`
- **意向哈希与签名校验（EIP-712 + ERC-1271）**：`src/libraries/SettlementIntentLib.sol`
  - `LendIntent.lenderSigner` 语义（signer/funder）
  - `hashLendIntent(...)`、`verifySignature(...)`、`validateOpen(...)`
- **资金池托管与受限出金**：`src/Vault/modules/LenderPoolVault.sol`
  - `transferOut(asset, to, amount)`（仅允许 `Registry.KEY_VAULT_BUSINESS_LOGIC` 调用）
  - `deposit(asset, amount)`（资金方可直接入金；当前 reserveForLending 走的是 `transferFrom(lenderSigner → pool)`）
- **资金池接口**：`src/interfaces/ILenderPoolVault.sol`
- **撮合原子落地（从资金池拨付 + 账本写入 + 订单创建/费用）**：`src/libraries/SettlementMatchLib.sol`
  - `finalizeAtomic(...)` / `finalizeAtomicFull(...)`（内部 `LenderPoolVault.transferOut`；并通过 `VaultCore.borrowFor(...)` 写入账本）
- **模块键（资金池/业务逻辑等）**：`src/constants/ModuleKeys.sol`（`KEY_LENDER_POOL_VAULT`、`KEY_VAULT_BUSINESS_LOGIC`、`KEY_VAULT_CORE`、`KEY_ORDER_ENGINE`）
- **资产白名单（Reserve 时校验）**：`src/access/AssetWhitelist.sol` + `src/interfaces/IAssetWhitelist.sol`

---

## 3) 撮合放款资金链（Match → Borrow Disbursement）

### 3.1 成交落地（Finalize Match）

- **发起方**：撮合者/keeper/业务编排方（依部署权限而定）
- **入口（SSOT）**：`VaultBusinessLogic.finalizeMatch(borrowIntent, lendIntents, sigBorrower, sigLenders)`（校验签名/消耗 reserve）
- **关键步骤（资金/账本/订单，SSOT，严格对齐架构指南与代码）**
  - **(A) 验签 + 防重放（意向层）**
    - borrower 与 lenderSigner（EOA/ERC-1271）签名在 `VaultBusinessLogic.finalizeMatch` 内校验（EIP-712）
    - 对每个 `lendIntentHash = SettlementIntentLib.hashLendIntent(lendIntent)` 执行 reserve consume（要求 lenderSigner 匹配），并发出 `LendReserveConsumed` + `DataPushed(RESERVE_CONSUMED, ...)`
  - **(B) 抵押约束（严格架构：撮合不补抵押）**
    - 撮合成交**不允许**在落地时“补充抵押/代存抵押”
    - 抵押必须提前由 borrower 走权威路径：`VaultCore.deposit → VaultRouter.processUserOperation → CollateralManager.depositCollateral`
  - **(C) 出金与费用（资金来源/去向 SSOT）**
    - **资金来源**：`LenderPoolVault`（线上流动性池，托管者）
    - **拨付顺序（原子）**：
      1) `LenderPoolVault.transferOut(borrowAsset, VaultBusinessLogic, amount)`：将成交金额拨付到撮合合约（只在本交易中短暂停留）
      2) `VaultBusinessLogic.approve(FeeRouter, amount)` → `FeeRouter.distributeNormal(borrowAsset, amount)`：
         - FeeRouter 从撮合合约拉取 `amount`，按配置分发到 `platformTreasury/ecosystemVault`，并将 **remaining** 返还给撮合合约
        - 经济口径：总费率按白皮书记为“借/贷双方各承担千分之三”，链上实现为 **借款侧** 计入 FeeRouter 分发（不做链上双向结算）
      3) 撮合合约将 FeeRouter 返还的 **remaining（即净额）** 转给 borrower（净额以“真实返还结果”为准，避免按 bps 复算造成舍入漂移）
  - **(D) 账本落地与订单创建（写入不经 View）**
    - 债务账本写入：通过 `VaultCore.borrowFor(borrower, borrowAsset, amount, termDays)` 统一入口触达 **`VaultLendingEngine`（`KEY_LE`，`ILendingEngineBasic`）**（`onlyVaultCore`）
    - 订单创建：`ORDER_ENGINE(LendingEngine).createLoanOrder(order)` 创建 `orderId`，并由 `LoanNFT`/`LendingEngine` 发出 `LOAN_*`/NFT/DataPush 等事件
    - （best-effort，协议统计缓存）`ORDER_ENGINE` 在创建订单成功后调用 `LoanFlowPushManager.notifyBorrow(borrower, asset, principal, orderId)`，
      由其计算 **USD-8** 并推送 `LoanFlowView`（并发出 `DataPushed(LOAN_FLOW_UPDATED, ...)`；失败不回滚主流程，链下按 `CacheUpdateFailedWithContext` 重试）
  - **关键口径（必须）**：`LoanOrder.lender` 固定写 `LenderPoolVault` 地址（资金池），不写 `lenderSigner`

#### 权限 / 白名单 / 暂停边界（撮合落地）

- **VaultBusinessLogic.finalizeMatch**
  - `whenNotPaused` + `nonReentrant`
  - 会校验 borrower/lender 的签名与过期（EIP-712 + ERC-1271），并消耗 reserve（防重放）
- **SettlementMatchLib.finalizeAtomicFull（撮合原子落地）**
  - 会校验借款资产在 `AssetWhitelist` 中允许
  - 会要求撮合入口具备 `ActionKeys.ACTION_ORDER_CREATE`（用于 createLoanOrder 鉴权）
  - 会强制“撮合不补抵押”：传入的 `collateralAsset/collateralAmount` 只允许为 `0/0`（否则回滚 `Settlement__CollateralTopUpNotSupported`）
- **FeeRouter.distributeNormal**
  - 要求 borrowAsset 已被配置为 supported token（否则回滚 `FeeRouter__TokenNotSupported`）
  - 要求撮合入口具备 `ActionKeys.ACTION_DEPOSIT`（费用分发鉴权）

#### 代码落点（相关合约 / 库 / 接口路径）

- **撮合入口（验签/consume reserve/观测）**：`src/Vault/modules/VaultBusinessLogic.sol`（`finalizeMatch`）
  - 说明：该入口主要负责 **EIP-712/1271 验签**、**consume reserve**，并发出 `LendReserveConsumed` + `DataPushed(RESERVE_CONSUMED, ...)` 等“reserve 维度”的可观测事件；
    **订单创建 / LoanNFT / LOAN_* / DataPush(LOAN_CREATED 等)** 由 `ORDER_ENGINE(LendingEngine)`/`LoanNFT` 作为 SSOT 发出。
- **意向哈希/验签库（EIP-712/1271）**：`src/libraries/SettlementIntentLib.sol`
- **reserve 状态机库（reserve/cancel/consume）**：`src/libraries/SettlementReserveLib.sol`
- **撮合原子落地（拨付/费用/账本/订单）**：`src/libraries/SettlementMatchLib.sol`（`finalizeAtomicFull`）
- **资金池托管（资金来源）**：`src/Vault/modules/LenderPoolVault.sol` + `src/interfaces/ILenderPoolVault.sol`
- **费用路由（platform/ecosystem 分发）**：`src/Vault/FeeRouter.sol` + `src/interfaces/IFeeRouter.sol`
- **统一写入口（账本写入）**：`src/Vault/VaultCore.sol`（`borrowFor`）
- **订单引擎/订单结构（LoanOrder.lender 口径）**：`src/core/LendingEngine.sol`（ORDER_ENGINE） + `src/interfaces/IOrderEngine.sol`（最小接口） + `src/interfaces/IOrderEngineViewAdapter.sol`（只读适配）
- **NFT（铸造/状态事件）**：`src/core/LoanNFT.sol`

---

## 4) 还款/结算资金链（Repay → Settle → Release Collateral）

### 4.1 唯一入口（SSOT）

- **发起方**：用户
- **入口（SSOT）**：`VaultCore.repay(orderId, debtAsset, amount)` → `Registry(KEY_SETTLEMENT_MANAGER)` → `SettlementManager.repayAndSettle(user, debtAsset, amount, orderId)`
- **核心原则**：用户还款入口不直达账本（`VaultLendingEngine`）/订单引擎（`ORDER_ENGINE`），必须统一进入 `SettlementManager`，避免 “repay vs settle vs liquidate” 分叉。
- **前端集成（approve/调用示例）**：统一见 `docs/FRONTEND_CONTRACTS_INTEGRATION.md`（避免多处重复导致口径漂移）

### 4.2 正常结算（按时/提前）

在同一条链路内完成：

- **债务记账（orderId SSOT）**：`ORDER_ENGINE(LendingEngine).repay(orderId, repayAmount)`（由 `SettlementManager` 作为调用方触发；资金已由 `VaultCore` 先转入 `SettlementManager`）
- （best-effort，协议统计缓存）`ORDER_ENGINE` 在 `repay` 成功后调用 `LoanFlowPushManager.notifyRepay(borrower, asset, repayAmount, orderId, repaidAmountAfter)`，
  由其计算 **USD-8** 并推送 `LoanFlowView`（`DataPushed(LOAN_FLOW_UPDATED, ...)`；失败不回滚主流程）
- **抵押释放/返还（当前实现口径）**：当 `VaultLendingEngine.getUserTotalDebtValue(user) == 0` 时，`SettlementManager` 会遍历用户的抵押资产列表，并逐一调用 `CollateralManager.withdrawCollateralTo(user, asset, bal, user)` 将抵押直接返还到 borrower 钱包（无需二次 withdraw）
- **费用/罚金（如有）**：统一走 `FeeRouter` 路由到 `platformTreasury` 等接收方

#### “按时/提前/逾期”判定口径（以代码实现为准）

- **判定位置（SSOT）**：订单维度的 on-time/early/late 判定目前发生在 `ORDER_ENGINE(LendingEngine).repay` 内（用于奖励 outcome / NFT 更新等），`SettlementManager.repayAndSettle` 本身不依赖该判定做分支（其“释放抵押”当前仅取决于用户总债务是否归零）。
- **判定窗口（当前实现，时间口径 SSOT=blocks）**：`ON_TIME_WINDOW_BLOCKS = 7200` blocks（\(\approx\) 24h，仅用于理解/展示；链上判定以 blocks 为准）
  - **按时（on-time）**：`nowBlock + windowBlocks >= maturityBlock` 且 `nowBlock <= maturityBlock + windowBlocks`
  - **提前（early）**：`nowBlock + windowBlocks < maturityBlock`（仅在“足额还清”时用于 outcome）
  - **逾期（late）**：不满足上述 on-time 且已足额还清（仅在“足额还清”时用于 outcome）

#### 权限 / 白名单 / 暂停边界（还款/结算链路）

- **VaultCore.repay（用户入口 SSOT）**
  - `nonReentrant`
  - 将 debtAsset 从 user `transferFrom` 到 `SettlementManager`（用户需 `approve(VaultCore)`）
- **SettlementManager.repayAndSettle（结算入口 SSOT）**
  - `onlyVaultCore` + `whenNotPaused` + `nonReentrant`
  - **依赖 ORDER_ENGINE 的权限门槛**：
    - `SettlementManager` 需要具备 `ActionKeys.ACTION_REPAY`（才能调用 `ORDER_ENGINE.repay`）
    - `SettlementManager` 需要具备 `ActionKeys.ACTION_VIEW_SYSTEM_DATA`（才能读取 `ORDER_ENGINE.getLoanOrderForView(orderId)` 做 orderId/user/asset cross-check）
- **CollateralManager.withdrawCollateralTo（抵押返还）**
  - 允许 `SettlementManager` 作为 authorized collateral exit caller（`receiver == user` 场景）

#### 观测（事件 / DataPush，链下对账与运维重放）

- **SettlementManager（结算侧）**
  - `RepayAndSettleProcessed(user, debtAsset, repayAmount, orderId, releasedAllCollateral, ts)`
  - `CollateralReleased(user, collateralAsset, collateralAmount, ts)`（每个资产释放都会 emit）
  - `DataPushed(REPAY_AND_SETTLE, abi.encode(...))`
  - `DataPushed(COLLATERAL_RELEASED, abi.encode(...))`
- **OrderEngine（订单侧）**
  - `DataPushed(LOAN_CREATED, ...)` / `DataPushed(LOAN_REPAID, ...)`
  - `DataPushed(LOAN_FLOW_UPDATED, ...)`（由 `LoanFlowView` 发出；写入由 `LoanFlowPushManager` best-effort 推送）
  - （若足额还清）NFT 状态更新相关事件/DataPush

#### 代码落点（相关合约 / 接口路径，后续逐个文件修复用）

- **用户入口（SSOT）**：`src/Vault/VaultCore.sol`（`repay(orderId, asset, amount)`）
- **结算入口（SSOT）**：`src/Vault/liquidation/modules/SettlementManager.sol`（`repayAndSettle` / `settleOrLiquidate`）
- **订单引擎（orderId SSOT）**：`src/core/LendingEngine.sol`（`repay` / `getLoanOrderForView` / ON_TIME_WINDOW 判定）
- **债务账本（用户总债务价值，USD-8）**：`src/interfaces/ILendingEngineBasic.sol`（`getUserTotalDebtValue` 等；实现为 Registry `KEY_LE` 指向的引擎；注意这是 **USD-8 value**，不是 token base units）
- **当前默认实现（截至 commit `ec7a417`）**：`KEY_LE` → `src/Vault/modules/VaultLendingEngine.sol`（contract: `VaultLendingEngine`）
- **抵押返还（真实转账）**：`src/Vault/modules/CollateralManager.sol`（`withdrawCollateralTo`）
- **费用路由（如有）**：`src/Vault/FeeRouter.sol`
- **模块键**：`src/constants/ModuleKeys.sol`（`KEY_SETTLEMENT_MANAGER` / `KEY_ORDER_ENGINE` / `KEY_LE` / `KEY_CM`）
- **接口**：
  - `src/interfaces/ISettlementManager.sol`
  - `src/interfaces/ICollateralManager.sol`
  - `src/interfaces/IOrderEngineViewAdapter.sol`（SettlementManager 读取订单做 cross-check）
  - `src/interfaces/IOrderEngineRepayAdapter.sol`（SettlementManager 调用 ORDER_ENGINE 的 `repay(orderId, amount)`）

---

## 5) 提前还款保证金资金链（Extension Flow）

> 本节为“资金链的扩展路径（Extension Flow）”，用于提前还款保证金机制的对账与口径统一。  
> 该机制不应改变主资金链 SSOT（`repay` 仍必须走 `VaultCore → SettlementManager`），但会引入额外的“保证金托管/分配”资金流。

> 分层声明（与 `docs/Architecture-Guide.md` 对齐）：本节属于 **实现级 SSOT/对账口径**（模块键、事件/DataPush、代码落点），用于把“保证金如何托管/如何分配/如何观测”讲清楚；**不修改** 架构指南中对“主资金链唯一入口/职责边界”的定义。

### 5.1 触发条件 / 开关（何时启用）

- **启用条件（建议）**：按产品/资产/功能开关启用（例如仅某些借款资产或某类订单启用）。
- **模块前置（必须）**：
  - Registry 必须注册：`KEY_GUARANTEE_FUND`（`GuaranteeFundManager`）与 `KEY_EARLY_REPAYMENT_GUARANTEE`（`EarlyRepaymentGuaranteeManager`）
  - **平台费路由（实现口径）**：保证金相关的 `platformFee` 视为“费用类资金”，由 `GuaranteeFundManager` 先转入 `FeeRouter`，再通过 `FeeRouter.distributePrepaid` 分发到平台金库/生态金库。
  - **权限要求（必须）**：`GuaranteeFundManager` 调用 `FeeRouter.distributePrepaid` 需具备 `ActionKeys.ACTION_DEPOSIT`（ACM 授权）。
  - `platformFeeReceiver` 仅作为历史配置字段保留（不再作为实际转账接收方）。
- **注意（SSOT 边界）**：
  - “提前/按时/逾期”等**订单语义判定的 SSOT** 以 `ORDER_ENGINE(LendingEngine)` 为准（当前在 `ORDER_ENGINE.repay(...)` 过程中完成判定，用于奖励 outcome / NFT 更新等）。
  - `SettlementManager` 作为 **主资金链唯一对外写入口（SSOT）**，在 `repayAndSettle` 中以订单状态/判定结果为依据触发保证金处理。
  - 保证金模块只负责**托管与分账执行**，不参与订单语义判定，避免 SSOT 分叉。

### 5.2 托管者 SSOT（保证金由谁持币）

- **保证金真实托管者（SSOT）**：`GuaranteeFundManager`  
  - 保证金余额账本：`user → asset → amount`（链上托管余额与对账事件均以该合约为准）
- **保证金记录/规则（非托管，语义层）**：`EarlyRepaymentGuaranteeManager`  
  - 维护 `guaranteeId` 与 `principal/promisedInterest/maturity/penaltyDays/lender/asset` 等语义信息
  - **不执行真实转账**（真实转账由 `GuaranteeFundManager` 统一执行）

### 5.3 入口 SSOT（谁能触发锁定 / 分配 / 没收）

- **锁定（借款发生时，权威路径 / 与架构指南一致）**：由 `VaultBusinessLogic` 作为“资金/抵押/保证金联动”的业务编排者完成两步（缺一不可）（**当前代码实现：借款时的保证金锁定编排由 `VaultBusinessLogic` 执行，而非 `VaultCore`**）：
  - **(A) 托管入金（真实资金移动）**：`GuaranteeFundManager.lockGuarantee(borrower, asset, promisedInterest)`  
    将保证金从 borrower 转入 `GuaranteeFundManager` 托管
  - **(B) 语义记账（语义层记录）**：`EarlyRepaymentGuaranteeManager.lockGuaranteeRecord(borrower, lender, asset, principal, promisedInterest, termDays)`  
    写入 guarantee record（用于后续提前还款/违约的分配依据）
  - **入口收敛（重要）**：链上不应允许任意模块/EOA 直接触发保证金锁定；应收敛到业务编排层（`VaultBusinessLogic`）以避免入口分叉与对账口径漂移。
- **提前还款结算（分配，权威入口）**：`VaultCore` 发起还款后，必须进入 `SettlementManager` 的统一结算入口；当该笔还款被判定为“提前还款（early）”（判定 SSOT 以 `ORDER_ENGINE(LendingEngine)` 为准）且满足开关时触发保证金分账：  
  - `VaultCore → SettlementManager.repayAndSettle(...) → EarlyRepaymentGuaranteeManager.settleEarlyRepayment(borrower, asset, actualRepayAmount)`  
  - `EarlyRepaymentGuaranteeManager` 内部调用 `GuaranteeFundManager.settleEarlyRepayment(...)` 执行真实“三路分发”
- **违约处理（没收，权威入口）**：同样由 `SettlementManager` 在其“到期未还/违约处置/被动清算”等分支中触发保证金处理：  
  - `SettlementManager → EarlyRepaymentGuaranteeManager.processDefault(borrower, asset)`  
  - 当前实现：`EarlyRepaymentGuaranteeManager` 调用 `GuaranteeFundManager.forfeitPartial(...)`  
  - 若未来需要“多接收人分配（平台/准备金/补偿池等）”，应改为走 `GuaranteeFundManager.settleDefault(...)`（数组分配）。

### 5.4 资金去向（提前还款三方分配 / 违约没收）

- **提前还款（Early Repay）**：保证金（通常为 `promisedInterest` 口径）按结果拆分为：
  - **refundToBorrower**：返还 borrower
  - **penaltyToLender**：支付 lender 的罚金/补偿
  - **platformFee**：平台手续费（实现为 **先转入 `FeeRouter`，再 `distributePrepaid` 分发**；feeType = `FEE_TYPE_EARLY_REPAYMENT_PLATFORM`）
  - **一致性约束（SSOT）**：三项之和必须等于 `GuaranteeFundManager` 中该用户该资产的托管余额，否则应回滚（避免对账漂移）。
- **违约（Default）**：
  - 当前实现：没收金额为 `promisedInterest`，并转给 lender（可按产品规则调整）。

### 5.5 对账事件 / DataPush（唯一来源）

- **真实资金移动（托管/释放/没收）的唯一来源**：`GuaranteeFundManager`
  - events：`GuaranteeLocked` / `GuaranteeReleased` / `GuaranteeForfeited`
  - DataPush：`GUARANTEE_LOCKED` / `GUARANTEE_RELEASED` / `GUARANTEE_FORFEITED`（以及 batch 版本）
- **语义层“保证金记录/提前还款处理结果”的来源**：`EarlyRepaymentGuaranteeManager`
  - events：`GuaranteeLocked(guaranteeId, ...)` / `EarlyRepaymentProcessed(...)` / `GuaranteeForfeited(guaranteeId, ...)`

### 5.6 代码落点（相关合约 / 接口路径）

- **托管者 SSOT（真实资金移动）**：`src/Vault/modules/GuaranteeFundManager.sol`（`lockGuarantee` / `settleEarlyRepayment` / `forfeitPartial` / `settleDefault`）
- **语义层（guarantee record + 分配规则）**：`src/Vault/modules/EarlyRepaymentGuaranteeManager.sol`（`lockGuaranteeRecord` / `settleEarlyRepayment` / `processDefault`）
- **接口**：`src/interfaces/IEarlyRepaymentGuaranteeManager.sol`
- **模块键**：`src/constants/ModuleKeys.sol`（`KEY_GUARANTEE_FUND` / `KEY_EARLY_REPAYMENT_GUARANTEE`）

---

## 6) 违约清算资金链（Default → Liquidation）

### 6.1 默认入口（keeper 推荐）

- **入口（默认/推荐，SSOT）**：`SettlementManager.settleOrLiquidate(orderId)`
- **权限**：调用者必须具备 `ActionKeys.ACTION_LIQUIDATE`（keeper/机器人）
- **备注**：`LiquidationManager.liquidate/batchLiquidate` 仅保留为 role-gated 的“显式参数执行器入口”（测试/应急），不应作为常态入口。

### 6.2 清算写入（直达账本）

- **推荐/当前实现（SSOT）**：
  - `SettlementManager.settleOrLiquidate(orderId)` 计算清算参数
  - → `LiquidationManager.liquidateFromSettlementManager(liquidator=keeper, ...)`
  - → `CollateralManager.withdrawCollateralTo(user, collateralAsset, share, receiver)`（按 residual shares 分配）
  - → `ILendingEngineBasic(KEY_LE).forceReduceDebt(user, debtAsset, debtAmount)`（直写债务账本；当前实现为 `VaultLendingEngine`）
- **保留入口**：`LiquidationManager.liquidate/batchLiquidate` 仅作为“显式参数执行器”（测试/应急），不建议作为常态 keeper 入口。

### 6.3 残值分配（SSOT）

- **SSOT 配置**：`LiquidationPayoutManager`（recipients/rates/shares 计算；整数分配，舍入余量归 liquidator）
- **执行（真实转账）**：`LiquidationManager` 调用 `CollateralManager.withdrawCollateralTo` 按份额转给：
  - `FeeRouter`（平台份额，随后由 `FeeRouter.distributePrepaid` 分发；feeType = `FEE_TYPE_LIQUIDATION_PLATFORM`）
  - `recipients.reserve`（风险准备金/生态金库）
  - `recipients.lenderCompensation`（出借人补偿池/地址）
  - `liquidator`（keeper；默认也承接舍入余量）

### 6.4 事件/DataPush 单点（链下对账/重试）

- **单点推送（DataPush）**：`LiquidationManager` → `LiquidatorView`
  - `pushLiquidationUpdate(...)` / `pushBatchLiquidationUpdate(...)`
  - `pushLiquidationPayout(...)`（记录实际分配结果）
- **推送失败可观测**：`LiquidationManager.CacheUpdateFailed`（View push best-effort；失败不回滚账本写入，链下可重试/告警）
- **receiver / liquidator 精确口径**
  - `liquidator`：**触发 `SettlementManager.settleOrLiquidate` 的 keeper**（`msg.sender`），会被透传到 `LiquidationManager`，并作为 `liquidatorShare` 的接收者，同时写入 `PayoutExecuted`/DataPush 事件中
  - `receiver`：每笔 `withdrawCollateralTo` 的接收者为 `LiquidationPayoutManager.getRecipients()` 返回的 `platform/reserve/lenderCompensation` + `liquidator`
- **与 FeeRouter 的关系（当前实现口径）**：清算平台份额 **先进入 `FeeRouter` 再分发**；`recipients.platform` 仅用于配置/展示，真实转账由 `FeeRouter` 完成。
- **权限要求（必须）**：`LiquidationManager` 调用 `FeeRouter.distributePrepaid` 需具备 `ActionKeys.ACTION_DEPOSIT`（ACM 授权）。

#### 代码落点（相关合约 / 接口路径，后续逐个文件修复用）

- **keeper 入口（SSOT）**：`src/Vault/liquidation/modules/SettlementManager.sol`（`settleOrLiquidate(orderId)`）
- **清算执行器（直写账本）**：`src/Vault/liquidation/modules/LiquidationManager.sol`（`liquidateFromSettlementManager` / `_distributeCollateral` / `CacheUpdateFailed` / `PayoutExecuted`）
- **残值分配 SSOT**：`src/Vault/liquidation/modules/LiquidationPayoutManager.sol`（`getRecipients` / `getRates` / `calculateShares` / `updateConfig` / `updateRecipients` / `updateRates`）
- **抵押托管/转出**：`src/Vault/modules/CollateralManager.sol`（`withdrawCollateralTo`）
- **债务账本（清算减债）**：`src/interfaces/ILendingEngineBasic.sol`（`forceReduceDebt` / `getDebt` / `getReducibleDebtAmount` / `calculateDebtValue`）
- **清算 DataPush 单点 View**：`src/Vault/view/modules/LiquidatorView.sol`（`pushLiquidationUpdate` / `pushLiquidationPayout`）
- **模块键/类型**：`src/constants/ModuleKeys.sol`、`src/constants/DataPushTypes.sol`
- **接口**：`src/interfaces/ILiquidationManager.sol`、`src/interfaces/ILiquidationPayoutManager.sol`、`src/interfaces/ILiquidationEventsView.sol`

---

## 7) 费用与分账资金链（Fee Flow）

- **范围**：平台费/生态费/撮合费/手续费/（可选）罚金中的“平台/生态份额”等一切 **费用类资金**
- **SSOT**：所有费用类资金 **必须** 通过 `FeeRouter` 统一路由与分发（避免不同模块各自转账导致口径漂移）
- **建议**：`FeeRouter.platformTreasury` 优先配置为**合约金库地址**（降低人为变数；参数变更仅走治理权限）

### 7.1 费用分发（权威口径）

- **入口**（由业务模块触发，不对用户开放）：
  - 常规费率：`FeeRouter.distributeNormal(token, amount)`
  - 动态费率：`FeeRouter.distributeDynamic(token, amount, feeType)`
  - 预存分发：`FeeRouter.distributePrepaid(token, amount, feeType, payer)`（用于清算/保证金等“已在 FeeRouter 托管”的资金）
  - 批量分发：`FeeRouter.batchDistribute(token, amounts[], feeTypes[])`
- **分发语义（当前实现）**：
  - `distributeNormal/distributeDynamic/batchDistribute`：`FeeRouter` 会从 **调用者** `transferFrom(msg.sender, FeeRouter, totalAmount)` 拉取费用金额（因此调用者需提前 `approve(FeeRouter)`）
  - `distributePrepaid`：费用金额已在 `FeeRouter` 托管，直接按平台/生态比例分发（不会再 `transferFrom`）
  - 将 `platformAmt` 转给 `platformTreasury`，将 `ecoAmt` 转给 `ecosystemVault`
  - `remaining`（即 `amount - platformAmt - ecoAmt`）**返还给调用者**（通常是资金池/编排合约）
- **token 白名单**：只有 `supportedTokens` 内的 token 才允许分发，否则 `TokenNotSupported`（上线前必须把 settlementToken 等加入支持列表）

### 7.1.1 费用口径与对账建议（借/贷归因）

- **经济口径**：平台总费率为 **千分之六**，其中借款侧与还款侧各计 **千分之三**
- **链上实现**：借款侧费用通过 `FeeRouter.distributeNormal` 收口；还款侧费用通过 `LendingEngine.repay` 内置的费率收口
- **可选对账增强**：若需链上可审计的“借/贷分开统计”，可将借款/还款分别走 `distributeDynamic(token, amount, feeType)` 并使用不同 `feeType` 标识

### 7.2 配置（recipients / rates）与权限边界

- **配置入口（治理 SSOT）**：均为 `onlyRole(ActionKeys.ACTION_SET_PARAMETER)`
  - `setFeeConfig(platformBps, ecoBps)`：设置平台/生态费率（`platformBps + ecoBps < 10_000`）
  - `setTreasury(platformTreasury, ecosystemVault)`：设置两类金库接收方
  - `setDynamicFee(token, feeType, feeBps)`：设置 token+feeType 的动态费率（实现中对叠加约束有额外限制）
  - `addSupportedToken(token)` / `removeSupportedToken(token)`：维护支持 token 列表
  - `clearFeeCache(token, feeType)`：清理缓存（运维/治理工具）
- **分发入口权限**：
  - `distributeNormal/distributeDynamic/distributePrepaid/batchDistribute`：调用者需具备 `ActionKeys.ACTION_DEPOSIT`（例如 `VaultBusinessLogic` / `GuaranteeFundManager` / `LiquidationManager`）
- **暂停边界**：
  - `pause/unpause`：`onlyRole(ActionKeys.ACTION_PAUSE_SYSTEM / ACTION_UNPAUSE_SYSTEM)`；分发逻辑内部受 `whenNotPaused` 保护

### 7.3 观测（事件 / DataPush / 只读镜像）

- **链上事件（FeeRouter）**：`FeeDistributed`、`FeeConfigUpdated`、`PlatformTreasuryUpdated`、`EcosystemVaultUpdated`、`TreasuryUpdated`（聚合兼容事件）、`TokenSupported`、`FeeStatisticsUpdated`、`BatchFeeDistributed` 等
- **DataPush（标准化 payload）**：`FEE_DISTRIBUTED`、`BATCH_FEE_DISTRIBUTED`、`FEE_CONFIG_UPDATED`、`TREASURY_UPDATED`、`TOKEN_SUPPORTED`、`DYNAMIC_FEE_UPDATED`、`FEE_CACHE_CLEARED`、`PAUSE_STATUS_UPDATED`
- **FeeRouterView（只读镜像）**：
  - 由 `FeeRouter` **主动 push** 更新（best-effort，不回滚主流程）
  - 查询权限：用户只能读自己的数据（`ACTION_VIEW_USER_DATA`），管理员可读全局（`ACTION_ADMIN`）
  - push 权限：仅允许 `Registry.KEY_FR` 指向的 FeeRouter 调用（`onlyFeeRouter`）
  - **唯一解析口径（SSOT）**：链上业务模块解析 view 地址 **必须** 通过 `Registry.KEY_VAULT_CORE → VaultCore.viewContractAddrVar()`；不允许再引入其它 Registry key 作为“回退来源”，避免多来源漂移

#### 代码落点（相关合约 / 接口路径，后续逐个文件修复用）

- **费用路由（SSOT）**：`src/Vault/FeeRouter.sol`
- **只读镜像（view/cache）**：`src/Vault/view/modules/FeeRouterView.sol`
- **接口**：`src/interfaces/IFeeRouter.sol`、`src/interfaces/IFeeRouterView.sol`
- **模块键**：`src/constants/ModuleKeys.sol`（`KEY_FR` / `KEY_VAULT_CORE` → `viewContractAddrVar()`；`KEY_FRV` 仅用于“独立注册 view 合约”的运维/工具侧读取，不应作为链上解析来源）
- **DataPush 类型**：`src/constants/DataPushTypes.sol`
- **权限 ActionKeys**：`src/constants/ActionKeys.sol`（`ACTION_SET_PARAMETER` / `ACTION_DEPOSIT` / `ACTION_PAUSE_SYSTEM` / `ACTION_UNPAUSE_SYSTEM`）

---

## 8) 最小验收清单（你逐段完善时建议每段都过一遍）

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

## 9) 本地一键 Smoke（部署连线/入口/权限/精准报错）

> 目的：在“还未跑完整撮合/借款”的情况下，也能快速验证 **Registry 注册、入口地址解析、keeper 权限门槛**，并把常见的 `unrecognized custom error` 解码成可操作的修复建议。

### 9.1 前置条件

```bash
# A) 启动本地链（单独终端）
pnpm -s run node

# B) 部署并注册模块（另一终端）
pnpm -s run deploy:localhost
```

### 9.2 一条命令运行（推荐）

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

### 9.2.1 生成最小订单（让 smoke 可通过）

如果当前链上没有有效 `orderId`，可先运行最小订单脚本创建一笔可清算订单（自动快进到逾期）：

```bash
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-create-order.ts" --network localhost
```

脚本会输出可直接用于 smoke 的 `ORDER_ID` 命令。

### 9.3 你会得到什么输出

- **部署检查（DeployCheck）**：
  - Registry / VaultCore / SettlementManager / ACM 是否有 code
  - Registry 是否已注册 `VAULT_CORE` / `SETTLEMENT_MANAGER` / `ACCESS_CONTROL_MANAGER`
  - 若 `ACCESS_CONTROL_MANAGER` 缺失会给出绑定修复提示
  - `VaultCore.viewContractAddrVar()` 是否为 0（用于检查 View 是否正确绑定）

- **keeper 入口检查（SSOT）**：
  - 对 `SettlementManager.settleOrLiquidate(orderId)` 做 `staticCall`
  - 若回滚为 `MissingRole()`：脚本会明确提示需要授予 **`ActionKeys.ACTION_LIQUIDATE`（keccak256("LIQUIDATE")）**
  - 若回滚为 `SettlementManager__NotLiquidatable()`：提示该订单目前不满足可清算条件（或 orderId 不存在/不正确）
  - **约束**：keeper/liquidator 必须与 borrower 不同；若相同，`LiquidationManager` 路径会触发 `CollateralManager__UnauthorizedAccess()`
  - 本地默认会尝试自动授予 `ACTION_LIQUIDATE` 给 keeper（部署者为 admin 时）
  - 若未配置 `ACCESS_CONTROL_MANAGER` 或自动授予失败，会直接报错退出
  - 增加 **Preflight 诊断**：
    - 订单读取（从 OrderEngine 以 SettlementManager 身份模拟调用）
    - 债务/可清算数量/债务价值（VaultLendingEngine / `KEY_LE`）
    - 风险清算判定（LiquidationRiskManager）
    - 抵押品资产与估值（CollateralManager + PositionView）



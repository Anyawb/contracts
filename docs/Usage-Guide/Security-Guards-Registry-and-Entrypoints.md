# Security Guards: Registry `code.length` + Entrypoint Tightening (SSOT)

> 目标：把“资金链/账本链路”的安全收口做成可复用的**工程级规范**，避免模块升级、误配置或权限漂移导致的资金/账本风险。
>
> 本文是 **工程落地指南**（偏“怎么写/怎么测/怎么验收”）。架构口径以 `docs/Architecture-Guide.md` 为 SSOT；如有不一致，优先修订本文与实现。

## 0) 范围、威胁模型与不变量（必读）

### 范围（本文覆盖）

- 任何依赖 `Registry` 解析模块地址、并在关键路径发起跨模块调用的合约（写模块/入口编排/View 推送方）。
- 资金链/账本链路（抵押、债务、清算、费用、保证金、结算）相关的**写入入口**与**跨模块调用**。

### 不在本文展开（仅给出指针）

- 价格/预言机与优雅降级：见 `docs/Architecture-Guide.md` 的 “Graceful Degradation / PriceOracle” 章节。
- 代币安全（approve/transferFrom/fee-on-transfer）：以各模块实现与测试为准。
- 具体清算分润与 recipients/rates：以架构指南 “清算执行流程 / LiquidationPayoutManager（SSOT）” 为准。

### 威胁模型（本文要解决的“典型事故”）

- **误配置/漂移**：`registry` 写成 EOA/0 地址/自毁地址，导致关键路径不可预期 revert 或 silent failure。
- **模块升级后的 stale cache**：模块地址被替换后，调用方继续使用旧缓存地址，引发调用失败或错误路由。
- **入口扩散**：账本写入口被多处合约/EOA 直接调用（即使有 role），导致审计面扩大、参数校验分叉、资金去向口径不一致。
- **best-effort 被误写成 strict**：View/Cache/监控推送失败阻断主交易，导致“写入不经 View”原则被破坏。
- **并发/重放覆盖**：View 快照推送乱序/重复写，造成缓存与账本不一致且难以复现。

### 核心不变量（审计/评审时按此逐条核对）

- **I1（Registry）**：关键路径下使用的 Registry 地址必须为合约（`code.length > 0`）。
- **I2（SSOT 入口）**：资金/账本的“强制写”（清算/强制减债/结算）入口必须收敛到 SSOT 模块；role 不能替代入口收敛。
- **I3（best-effort）**：任何 View/缓存/统计/监控推送失败不得回滚主交易，必须可观测（事件）且可重放（链下重试）。
- **I4（并发/幂等）**：B 类 View 快照推送必须具备版本控制与幂等策略（`nextVersion`/`requestId`/`seq`），避免乱序覆盖。
- **I5（View 地址解析 SSOT）**：链上模块解析 View 地址必须统一走 `Registry.KEY_VAULT_CORE → VaultCore.viewContractAddrVar()`；禁止多来源回退解析，避免口径漂移与安全边界扩大。

---

## 1) Registry Guard：`onlyValidRegistry` 必须同时校验 `code.length > 0`

### Why

- **避免误配置**：Registry 地址被写成 EOA / 0 地址 / 自毁合约地址。
- **避免 silent failure**：后续 `Registry(registryAddr).getModuleOrRevert(...)` 会在低层调用时失败，错误不直观，且可能在关键路径触发。
- **统一安全语义**：把“Registry 必须是合约”变成工程级硬约束。

### 标准写法（推荐）

- 统一使用 `StandardErrors.NotAContract(address)`（SSOT：`src/errors/StandardErrors.sol`）。
- **错误语义必须分离（重要）**：
  - `registry == address(0)`：必须 revert `ZeroAddress()`（或模块内等价的 `*__ZeroAddress()`），用于明确“未配置/被清空”。
  - `registry.code.length == 0`：必须 revert `NotAContract(registry)`，用于明确“配置了但不是合约（EOA/自毁/空地址）”。
  - **禁止**：把 `code.length == 0` 也用 `ZeroAddress()`（或 `*__ZeroAddress()`）去 revert，否则链上排障与告警聚类会被污染，且不符合本文档对 `NotAContract` 的统一语义。
- **注意（best-effort 例外）**：对“业务 best-effort 推送路径”不使用 strict guard；best-effort 路径应自行做 `addr == 0 || addr.code.length == 0` 分支并吞掉 revert（见第 5 节）。

```solidity
import { ZeroAddress, NotAContract } from "../errors/StandardErrors.sol";

modifier onlyValidRegistry() {
    if (_registryAddr == address(0)) revert ZeroAddress();
    if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
    _;
}
```

### 常见变体（必须注意）

- **库式 storage layout**：如果合约的“权威 registry 地址”在 storage layout（例如 `LendingEngineStorage.Layout`）中，`onlyValidRegistry` 应该使用 layout 内的地址（避免出现 `_registryAddr` 与 `layout._registryAddr` 不一致）。
- **升级/替换的“后置动作”**：模块替换后（Registry set/execute upgrade），若系统存在 A 类“模块地址缓存”，必须触发统一刷新入口（见架构指南的 A 类策略，以及第 3 节的验收点）。

---

## 2) 清算/强制写入口：executor + role 双保险（Entry Tightening）

### Why

- **角色（role）不是入口收敛的替代品**：如果任意 EOA 拿到 `ACTION_LIQUIDATE`，就能绕过“清算执行器模块”直接写账本，会造成：
  - 参数校验/资金去向/事件单点推送口径分叉
  - 审计面扩大（任何持权地址都是潜在写入口）
- **最佳实践（与架构指南一致）**：
  - 写入口必须收敛到产品线对应的 SSOT 模块（例如 legacy / 通用订单走 `SettlementManager`，blocks-only 走 `BlocksOnlyCoordinator`；清算执行器 `LiquidationManager` 不应被泛化成默认 keeper 入口）。
  - 在账本层再做 role gate（双保险），但 role 仅作为“第二道门”，不是“入口扩散”的理由。

### 标准写法（示例：LendingEngine.forceReduceDebt）

要求同时满足：

- **onlyLiquidationExecutor**：`msg.sender` 必须是 `Registry(KEY_LIQUIDATION_MANAGER)` 或 `Registry(KEY_SETTLEMENT_MANAGER)`
- **ACM.requireRole(ACTION_LIQUIDATE, msg.sender)**：账本层再做权限校验（双保险）

```solidity
modifier onlyLiquidationExecutor() {
    address lm = _getModuleAddress(ModuleKeys.KEY_LIQUIDATION_MANAGER);
    address sm = _getModuleAddressOrZero(ModuleKeys.KEY_SETTLEMENT_MANAGER);
    if (msg.sender != lm && (sm == address(0) || msg.sender != sm)) revert OnlyLiquidationExecutor();
    _;
}

function forceReduceDebt(...) external onlyValidRegistry onlyLiquidationExecutor {
    ACM.requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender);
    // ledger write...
}
```

### 测试要求（必测）

- `forceReduceDebt`：
  - 非 executor 调用必须 revert（即使有 role）
  - executor 调用但缺 role 必须 revert
  - executor + role 调用成功，且 push/事件为 best-effort

---

## 3) 模块地址缓存（A 类缓存）：必须走统一刷新入口（best-effort + 审计）

> SSOT：见 `docs/Architecture-Guide.md` “缓存分类（A/B/C）”与 “`ICacheRefreshable.refreshModuleCache()` + `CacheMaintenanceManager.batchRefresh()`”。

### Why

- **模块升级是常态**：升级/换址后的“短时间 stale”是可预期风险；A 类缓存必须具备可控、可审计的刷新路径。
- **避免权限面扩大**：A 类缓存统一刷新入口应由运维/治理模块统一触发，而不是散落在各个业务模块、也不是允许任意 EOA 直接刷新关键缓存。

### 标准要求（落地口径）

- **实现侧**：
  - 存在 A 类缓存的合约应实现 `ICacheRefreshable.refreshModuleCache()`（或等价接口）。
  - 刷新逻辑应从 Registry 重新解析模块地址；刷新过程应**best-effort**（单个模块失败不阻断批量），并具备事件可观测性（供链下告警/回放）。
- **运维侧**：
  - 模块替换/升级后，治理脚本必须包含 `CacheMaintenanceManager.batchRefresh()`（或等价批量刷新）的后置步骤。

### 测试要求（必测）

- 模块替换后：
  - 未刷新：调用方使用 stale cache 时应“可预期失败”（revert/事件），不能出现 silent wrong route。
  - 已刷新：调用方应解析到新模块地址并正常工作。

---

## 4) View 地址解析 SSOT：仅通过 `KEY_VAULT_CORE → VaultCore.viewContractAddrVar()`

> SSOT：见 `docs/Architecture-Guide.md` 的 “View 解析口径（SSOT，避免多来源漂移）”。

### Why

- **避免多来源回退**：一旦引入“多个 registry key / 常量地址 / 额外门面合约”作为回退来源，就会产生：
  - 升级/换址时口径不一致（不同模块解析到不同 view）
  - 安全边界扩大（更多依赖点与更多潜在误配置）
  - 排障困难（同一交易内不同路径指向不同 view）

### 标准要求（落地口径）

- **链上业务模块**如需解析 view 地址，必须统一按以下路径：
  - `Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE) → VaultCore.viewContractAddrVar()`
- **禁止**：
  - 新增或复用其它 Registry key 作为“view 地址回退来源”
  - 在模块内 hardcode view 地址或写入可变 view 地址存储（除非是 `VaultCore` 这类架构定义的单一持有者）

### 测试要求（必测）

- 模块升级或 view 换址后：
  - 所有依赖 view 的模块应通过同一路径解析到新地址（无分叉、无旧地址残留）。

---

## 5) Best-effort 跨模块调用（Push/Observability 必须不阻断账本）

### 强约束（来自 Architecture-Guide）

- **账本/资金写入成功优先**：任何 View/Cache/Health/统计推送失败都不得回滚主交易。
- 推送失败必须发事件（例如 `CacheUpdateFailed` / `HealthPushFailed`），供链下告警与人工重放。

### strict vs best-effort 边界（必须明确，审计口径）

- **best-effort 仅适用于**：View/缓存/统计/监控/可观测性推送（“加速层/镜像层”），失败只影响“可用性/可观测性”，不得影响账本/资金正确性。
- **必须 strict 的外部调用**：任何会导致 **真实资金/抵押转移**、**账本写入**、**结算交割**、**托管资金 custody** 的跨模块调用；失败必须回滚，防止“状态已变更但资金未结算/账本未落地”的灾难性不一致。
- **允许 best-effort 的外部调用**：仅当其语义是“非权威副作用/可降级”，并且失败路径具备**可观测事件**（便于链下告警/补偿）时。
- **典型例子（本仓库现状，均为正确实现，不要求修改）**：
  - `src/core/LendingEngine.sol`：对 `FeeRouter.distributeNormal(...)` 采用 `try/catch` best-effort，失败时记录失败金额并发出 `FeeDistributionFailed` / `MODULE_HEALTH` / `USER_DEGRADATION`，**不阻断 repay 主流程**（费用路由属于可降级副作用，而非账本 SSOT）。
  - `src/Vault/liquidation/modules/SettlementManager.sol`：调用 `CollateralManager/LendingEngine/LiquidationManager` 属于 **结算/清算账本写链路**，必须 strict；仅对 LoanNFT 等“可选校验/只读验证”采用 best-effort（避免 NFT/只读依赖 DoS 主流程）。
  - `src/Vault/modules/EarlyRepaymentGuaranteeManager.sol`：调用 `GuaranteeFundManager` 执行保证金资金托管/分配（custody SSOT），失败会包装为 `ExternalModuleRevertedRaw(...)` 并 **回滚**，这是必须的 strict 行为。

### 标准模式

- best-effort 解析依赖：
  - `addr == 0 || addr.code.length == 0`：直接发失败事件并 return
  - 外部调用：`try/catch` 捕获 revert data，发失败事件并 return

### 并发/幂等（B 类 View 快照缓存必须有，强烈建议默认启用）

> SSOT：见 `docs/Architecture-Guide.md` “并发与幂等：`nextVersion`（严格）+ `requestId/seq`（可选，推荐）”。

- **问题**：同一 `(user, asset)` 的推送可能并发、乱序、或被链下重放；没有版本控制会导致 View 缓存被旧数据覆盖。
- **要求**：
  - `nextVersion != 0` 时：View 侧要求 `nextVersion == currentVersion + 1`（严格乐观并发），不满足则 revert；上游应重读版本后重试（链下重试同理）。
  - 幂等建议：重放同一条推送复用同一个 `requestId`；View 侧可维护 `lastAppliedRequestId` 做 O(1) 幂等忽略。

---

## 6) 推广范围：资金链模块清单（建议按优先级推进）

### P0（账本与资金直接写模块）

- `src/Vault/modules/VaultLendingEngine.sol`（债务账本）
- `src/Vault/modules/CollateralManager.sol`（抵押账本+托管）
- `src/Vault/FeeRouter.sol`（费用资金路由）
- `src/Vault/modules/LenderPoolVault.sol`（资金池托管与受限出金；资金链细节见 Funds-Flow SSOT）
- `src/Vault/modules/GuaranteeFundManager.sol` / `EarlyRepaymentGuaranteeManager.sol`（保证金相关）
- `src/Vault/liquidation/modules/SettlementManager.sol`（legacy / 通用订单的统一结算/清算写入口 SSOT：还款结算/到期处置/被动清算）
- `src/blocks-only/BlocksOnlyCoordinator.sol`（blocks-only 产品线的独立收尾入口 SSOT：finalize / repay / maturity settle-or-liquidate）
- `src/Vault/liquidation/modules/LiquidationManager.sol`（清算执行器：抵押扣押/债务强制减记/事件推送 best-effort）
- `src/Vault/liquidation/modules/LiquidationPayoutManager.sol`（清算分润 recipients/rates SSOT：份额计算与接收者配置）
- `src/core/LoanNFT.sol`（订单/凭证 NFT：资金链关键副作用模块）
- `src/core/LendingEngine.sol`（订单/撮合/放款落地：资金链关键模块之一；资金链细节见 Funds-Flow SSOT）
- `src/core/PriceOracle.sol`（价格权威源：资金链与风控关键依赖）

### P1（编排与入口）

- `src/Vault/VaultCore.sol`（用户权威入口 SSOT：deposit/withdraw/borrrow/repay/推送门面）
- `src/Vault/VaultRouter.sol`（deposit/withdraw 路由 + push）
- `src/Vault/modules/VaultBusinessLogic.sol`（撮合/资金池编排）
- `src/Vault/VaultAdmin.sol`（治理入口）
- `src/registry/Registry.sol`（模块地址与升级 SSOT：误配置/升级将直接影响资金链正确性）
- `src/registry/CacheMaintenanceManager.sol`（A 类缓存统一刷新入口：best-effort + 审计事件）
- `src/access/AccessControlManager.sol`（权限 SSOT：ACTION\_\* 角色控制资金链/清算入口）
- `src/access/AssetWhitelist.sol`（资产白名单：影响抵押/借贷可用资产范围与资金链安全）

### P2（只读/View/监控）

- `src/Vault/view/modules/*`（默认也应具备 registry code.length guard；但注意不要把 best-effort push 误写成 strict guard）
- `src/Vault/liquidation/modules/LiquidationRiskManager.sol`（风控聚合只读：清算阈值/健康读取/可清算判断）
- `src/monitor/*`（监控/降级：只读与告警辅助；注意 best-effort 与可观测性）

---

## 7) 本仓库落地状态（记录）

- Registry `code.length guard`：已在部分资金链模块落地，并作为后续收口基线持续推广。
- 清算入口双保险（executor + role）：已在 `VaultLendingEngine.forceReduceDebt` 落地。

---

## 8) 验收（测试命令集合 + 一键脚本）

### 代码评审/审计 checklist（建议复制到 PR 描述）

- **Registry 安全**：
  - 关键路径下是否统一 `onlyValidRegistry`（含 `code.length`）？
  - best-effort push 是否避免 strict guard，并对 `addr==0 || code.length==0` 做分支处理？
  - `src/constants/ModuleKeys.sol` 变更后，是否重新运行正式生成链 `pnpm -s run generate:module-keys`，并确认 `frontend-config/moduleKeys.ts` 没有漏掉多行声明的 key？
- **入口收敛**：
  - 是否存在“EOA 直接写账本”的入口（即使有 role）？如有，是否能收敛到 `SettlementManager`/执行器模块？
  - 强制写入口是否具备 executor gate + role gate？
- **缓存安全（对齐架构 A/B/C）**：
  - A 类缓存：是否实现统一刷新接口，并在升级后通过批量入口触发刷新？
  - B 类缓存：推送是否 best-effort + 失败事件；是否具备 `nextVersion/requestId/seq` 并发/幂等策略？
  - C 类缓存：是否避免纳入“统一刷新入口”，以免扩大权限面？
- **View 地址解析 SSOT**：
  - 链上模块是否统一通过 `KEY_VAULT_CORE → VaultCore.viewContractAddrVar()` 解析 view 地址，且没有“多来源回退解析”？
- **可观测性**：
  - 推送失败事件是否携带足够 payload（用户、资产、目标 view、期望写入值、reason）用于链下重放？
  - 是否明确区分 strict vs best-effort：账本/资金/custody/结算交割必须 strict；View/统计/监控推送必须 best-effort 且可观测？
  - 钱包直连写入口是否已经同步最新 ABI / TypeChain / custom errors，并明确 `finalizeMatch(...)` 成功后没有独立成交成功事件，不能靠不存在的事件做收敛判断？

### 前端钱包直连附加发布门禁

如果本次发布包含“前端钱包直接调用链上入口”，除了上面的通用守卫，还必须额外满足：

- 共享 ABI / TypeChain / `frontend-config/moduleKeys.ts` 必须视为同一批制品发布，不允许只发 ABI 不发 key，或只发 key 不发 errors。
- `KEY_VAULT_BUSINESS_LOGIC`、`KEY_BLOCKS_ONLY_COORDINATOR`、`KEY_BLOCKS_ONLY_VIEW` 缺任意一项，都应直接阻断联调或发布。
- `VaultBusinessLogic.finalizeMatch(...)` / `finalizeMatchBlocks(...)` 的 tuple 顺序必须以前链上 canonical struct 为准，不能在 SDK/BFF 里重新包装后改序。
- keeper / liquidation 路径仍应保持后端或运营域隔离；不要因为钱包直连发布就把 `settleOrLiquidate(...)` 一并暴露到普通用户前端。
- 详细联调步骤、灰度、回滚和三仓签字要求，统一参见 [Frontend-Wallet-Direct-Migration-Launch-Checklist.md](Frontend-Wallet-Direct-Migration-Launch-Checklist.md)。

### 推荐一键脚本

- **全量验收（包含 P0/P1/P2 相关编译 + 关键测试）**：
  - `pnpm -s run checks:funds-guards`

### 手动拆分（排障用）

- **编译**：
  - `pnpm -s run compile`
- **P0（账本/资金直写）定向测试**：
  - `pnpm -s test test/CollateralManager.security.test.ts test/Vault/modules/CollateralManager.liquidation-access.test.ts test/core/FeeRouter.test.ts test/core/LoanNFT.test.ts test/core/PriceOracle.new.test.ts`
- **P1（入口编排）定向测试**：
  - `pnpm -s test test/VaultRouter.test.ts test/Vault/modules/VaultBusinessLogic.test.ts`
- **P2（View/监控）定向测试**：
  - `pnpm -s test test/Vault/view test/Vault/view/modules test/core/PriceUpdater.test.ts`
- **ModuleKeys 产物校验**：
  - `pnpm -s run generate:module-keys`
  - `rg -n "KEY_BLOCKS_ONLY_COORDINATOR|KEY_BLOCKS_ONLY_VIEW" frontend-config/moduleKeys.ts`

# 🚀 架构统一要求指南

## 📋 概述

本文档定义了RWA借贷平台从链上缓存架构迁移到**双架构设计**的统一要求和实施标准。

### **架构迁移目标**

```
旧架构：用户操作 → 业务合约 → 链上缓存 → 5分钟后过期 → View层查询
新架构：用户操作 → 业务合约 → 双架构支持 → 数据库实时收集 + View层免费查询
```

### **双架构设计核心原则**

- ✅ **事件驱动架构** - 所有操作通过事件记录，支持数据库收集和AI分析
- ✅ **View层缓存架构** - 提供快速免费查询，所有查询函数使用view（0 gas）
- ✅ **实时数据流** - 数据库实时收集和处理事件数据
- ✅ **AI友好** - 完整事件历史便于智能分析
- ✅ **Gas优化** - 查询免费，只在数据更新时支付Gas
- ✅ **统一事件库** - 避免重复定义，节省Gas
- ✅ **统一功能库** - 模块访问、权限控制、View接口统一管理
- ✅ **严格命名规范** - 遵循 SmartContractStandard.md 中“3.2 模块与动作常量规范（ModuleKeys / ActionKeys）”与“3.3 Solidity 命名规范”两节的约定

---

## 🏗️ 双架构设计标准

### **完整的数据流**

```
用户操作 → VaultCore → View层 → 双架构处理 → 数据库收集 + 免费查询
     ↓         ↓         ↓         ↓         ↓
   简洁入口   统一处理   事件驱动   缓存更新   实时响应
```

### **双架构核心组件**

- **事件驱动层**：发出标准化事件，支持数据库收集和AI分析
- **View层缓存**：提供快速免费查询，所有查询函数使用view（0 gas）
- **数据推送接口**：业务模块推送数据更新到View层缓存
- **系统级缓存快照 (ViewCache.sol)**：集中存储按资产聚合的系统总量数据，减少冗余映射，支持批量查询
- **查询接口**：前端通过view函数免费查询缓存数据

### 📚 核心库与使用边界（SSOT）

- **HealthFactorLib**：健康因子计算与阈值判定（`calcHealthFactor`/`isUnderCollateralized`），保持 bps 口径统一。
- **ViewAccessLib**：仅用于 `view` 读权限判断（0 gas、无事件），所有 View 模块优先使用。
- **AccessControlLibrary**：用于**非 view 写路径**的权限检查与审计事件（内部依赖 `ModuleAccessLibrary` + `EventLibrary`）。
- **ModuleAccessLibrary**：Registry 模块解析与访问审计事件（供 `AccessControlLibrary` 等内部使用）。
- **EventLibrary**：权限/模块访问等统一事件定义（避免重复事件定义）。
- **DataPushLibrary**：统一 DataPush 事件发射（参见“Unified DataPush Interface”章节）。
- **ProxyIntrospectionLib**：代理实现地址自省工具（用于升级场景的实现地址定位）。

**库选择指南（必须遵循）**

- **view 只读函数**：使用 `ViewAccessLib`（不发事件、不改状态）。
- **写入/可变更函数**：使用 `AccessControlLibrary`（带事件审计）。
- **例外说明**：`ViewCache` 存在写路径，因此使用 `AccessControlLibrary`。

### 缓存：分类、统一策略与指南入口（必读）

> 结论：**只统一 A 类（模块地址缓存刷新）**；B/C 类不做“统一刷新入口”，只按事件推送/幂等/有效性标识的规范对齐。

- **缓存分类（A/B/C）**
  - **A 类：模块地址缓存（Module Address Cache）**
    - 典型：`VaultRouter` / `LiquidationRiskManager` 内部缓存从 `Registry` 解析出来的模块地址
    - 风险：模块升级/换址后短时间 stale，可能导致调用失败或读到旧地址
    - **统一策略（已落地）**：`ICacheRefreshable.refreshModuleCache()` + `CacheMaintenanceManager.batchRefresh()`（单入口 + best-effort + 审计）
  - **B 类：View 业务快照缓存（Business Snapshot Cache）**
    - 典型：`PositionView/HealthView/StatisticsView/AccessControlView/...`
    - **策略**：写入成功后由业务模块 best-effort push；失败发事件 + 链下重试；读接口提供 `isValid/blockNumber` 等有效性标识
  - **C 类：业务内部缓存/工具缓存（Internal / Utility Cache）**
    - 典型：`RewardManagerCore` 的 reward/等级内部缓存（协议内用途）、`GracefulDegradation` 的价格缓存、`RegistrySignatureManager` 的 domain separator 缓存等
    - **策略**：不纳入统一刷新入口（语义差异大、权限面扩大、不利于审计）

- **团队快速入口（请把这些当“缓存/推送/入口安全总目录”）**
  - **缓存全量盘点表（A/B/C + 字段/TTL/写入者/权限/失败重试）**：[`docs/Usage-Guide/Cache-Architecture-Guide.md`](Usage-Guide/Cache-Architecture-Guide.md)
  - **RWA 价格体系总纲（来源 / 归一化 / 发布 / 消费）**：[`docs/Usage-Guide/RWA-Price-System-Guide.md`](Usage-Guide/RWA-Price-System-Guide.md)
  - **缓存推送失败与人工重试（运维手册）**：[`docs/Cache-Push-Manual-Retry.md`](Cache-Push-Manual-Retry.md)
  - **资金链安全收口（Registry Guard + Entrypoint 收敛 + best-effort 边界）**：[`docs/Usage-Guide/Security-Guards-Registry-and-Entrypoints.md`](Usage-Guide/Security-Guards-Registry-and-Entrypoints.md)
  - **白名单系统与测试网上线口径（资产准入 / 地址白名单 / Registry 注册 / 运维注意事项）**：[`docs/Usage-Guide/WhitelistSystem.md`](Usage-Guide/WhitelistSystem.md)

### 缓存推送失败与手动重试（新增要求 & 已实施）

- 推送失败不做链上自动重试，避免 gas 暴涨/重复失败；采用“事件告警 + 链下人工重放”。
- 在推送 try/catch 中发事件 `CacheUpdateFailed(...)` 或 **`CacheUpdateFailedWithContext(...)`**；当 view 地址解析为零也要触发，payload 建议携带期望写入的数值。
- **`CacheUpdateFailedWithContext`** 必须覆盖 `requestId/seq/nextVersion` 上下文，便于链下重放与并发诊断；`CacheUpdateFailed` 可保留作兼容。
- 健康推送失败补充事件：`HealthPushFailed(address user, address healthView, uint256 totalCollateral, uint256 totalDebt, bytes reason)`（最佳努力不回滚，用于链下重试/告警）。
- 链下监听事件写入重试队列（含 tx hash、block time、payload）；人工核查原因后重放：先重新读取最新账本，数据一致或可接受才推送，可设置最小间隔/去重，同一 (user, asset, view) 避免并发轰击。
- 链下重试同一 (user, asset, view) 连续多次失败时，将该条目标记为“死亡信箱”并告警，链上不再尝试；重试成功后清理队列/提示。
- 可选治理/运维入口：提供只读脚本或工具函数 `retryPush(user, asset)` 单次读取最新账本再推送，不做链上循环；注意权限与调用成本。

### 并发与幂等：`nextVersion`（严格）+ `requestId/seq`（可选，推荐）

- **背景**：View 层缓存是“事件驱动 + 最佳努力推送”的加速层，同一 `(user, asset)` 可能在同一高度或短时间内被不同入口/模块并发推送；必须通过乐观并发与幂等避免“覆盖/乱序/重复写”。
- **版本字段**：`PositionView`/`StatisticsView` 等维护单调递增的 `version`（按 key 维度，如 `(user, asset)` 或 `user`）。
- **`nextVersion` 定义**：本次推送“期望写入的下一版本号”。
  - 上游推荐做法：先调用 `getPositionVersion(user, asset)` 读取 `currentVersion`，再计算 `nextVersion = currentVersion + 1` 后透传。
  - 兼容模式：若上游无法读取版本（或不希望做并发控制），可传 `nextVersion = 0`，由合约侧自增（但并发冲突检测会弱一些）。
- **严格乐观并发（推荐默认）**：当 `nextVersion != 0` 时，合约会要求 `nextVersion == currentVersion + 1`，否则 revert（上游应重读版本后重试）。
- **幂等键（推荐：版本绑定 O(1)）**：`requestId` 用作链上幂等键，但不做全量“已处理 mapping”累积；合约内仅为每个 `(user, asset)` 记录 `lastAppliedRequestId`（O(1) 存储）。当 `nextVersion!=0` 且发生重放时，若 `nextVersion == currentVersion` 且 `requestId == lastAppliedRequestId`，则幂等忽略（不重复写缓存）。`seq` 可作为可选的“严格递增序列”约束，辅助链下排序与链上拒绝乱序；对同一 `requestId` 的重放应优先按幂等忽略处理。`nextVersion==0`（自增模式）下不提供强幂等保证；如确有需求可再引入 ring buffer（仅缓存最近 N 个 requestId）作为增强。
- **链下重试建议**：重放同一条推送时复用同一个 `requestId`；若遇到版本冲突（revert），应先重读最新版本与账本，再生成新的 `nextVersion` 发起重试（避免盲目重放导致持续失败）。

### **所有核心功能分层职责（写入不经 View）**

- **用户状态管理**：UserView.sol（双架构支持）
- **系统状态管理**：SystemView.sol（双架构支持，作为统一入口/元信息路由；资产、价格、奖励、清算等查询均提示前端跳转到对应专属 View）
- **统计聚合（迁移完成）**：StatisticsView.sol（承接活跃用户、全局抵押/债务、保证金聚合；业务入口统一推送）
- **系统级缓存快照**：ViewCache.sol（仅系统级数据缓存）
- **权限控制**：AccessControlView.sol（双架构支持）
- **清算只读/风控**：LiquidationRiskManager + LiquidatorView（仅只读与风控聚合，写入直达账本，不经 View）
- **奖励管理（Reward）**：通过 RewardManager 集成（双架构支持，落账后触发；奖励单位语义统一为 EasyToken）
- **批量操作**：BatchView.sol（双架构支持）

### **View 模块清单（按职责分组，补全 `src/Vault/view/modules/` 现状）**

> 说明：以下为“查询/缓存/事件聚合”视图层模块。**写入账本不经 View**；业务模块写入成功后，以“推送快照/发事件”为主更新 View 层缓存。

#### **A) 核心 View（建议部署，前端/机器人常用）**

- **PositionView.sol**：用户仓位查询 + 缓存（`getUserPositionWithMeta/getUserCacheStatusWithMeta/batchGetUserPositionsWithMeta` 等）
- **UserView.sol**：用户维度只读聚合与便捷查询（与 Position/Health/Reward 等模块协作）
- **HealthView.sol**：健康因子/风险状态缓存与批量读取（写路径由风控/账本模块推送）
- **StatisticsView.sol**：系统级统计聚合缓存（活跃用户/全局抵押债务/保证金聚合/降级统计等）
- **LoanFlowView.sol**：协议层 loan-flow 统计缓存（per-user/global 的 borrow+repay volume/count；**Value Unit SSOT 遵循 Units & Conversions SSOT：价格/估值按资产原生 decimals 解释，跨资产聚合前必须显式归一化**；写入由 `LoanFlowPushManager` best-effort 推送）
- **ViewCache.sol**：系统级快照缓存（按资产聚合的系统状态，支持批量读取）
- **AccessControlView.sol**：权限只读查询（权限缓存、权限级别等）
- **BatchView.sol**：批量查询聚合（价格/健康/模块健康等批量接口）
- **RegistryView.sol**：Registry 模块键枚举/反查/分页（便于前端发现模块地址）
- **SystemView.sol**：统一入口/元信息路由（保留 registry/getModule 等少量 helper，遇到资产/价格/奖励/清算等请求时提示前端跳转到对应专属 View）

#### **B) 专属/扩展 View（可选部署，用于提升前端体验或运维能力）**

- **DashboardView.sol**：前端仪表盘聚合视图（聚合 Position/Health/奖励/活跃度等，减少 RPC 次数）
- **PreviewView.sol**：预览类查询门面（deposit/withdraw/borrow/repay 的预估接口；可作为前端入口，但权威实现以 UserView/PositionView 为准）
- **RiskView.sol**：风险评估视图（基于 HealthView 缓存与派生计算，提供 liquidatable/warningLevel 等）
- **ValuationOracleView.sol**：价格/预言机只读门面（封装 `PriceOracle` 的价格读取；**健康检查走 `GracefulDegradation.checkPriceOracleHealth(...)`**，不要求 oracle 合约实现额外 health 方法；**目标口径**遵循 **Units & Conversions SSOT**：迁移完成后价格与估值按资产原生 decimals 解释，并显式暴露 `assetDecimals` 用于 ERC-20 amount→value 换算。注意：当前实现和部分消费侧仍保留 统一 value 语义/历史字段，不能把这里的目标描述误读成“当前已全量落地”。正常写价链路应统一为“链下采集/按资产 decimals 归一化 -> PriceUpdater.updateAssetPrice -> PriceOracle 存储”）
- **FeeRouterView.sol**：费用数据只读镜像（由 FeeRouter 推送更新，支持低成本查询）
- **LendingEngineView.sol**：借贷引擎只读查询适配层（订单/重试/访问控制等运维与前端查询）
- **ModuleHealthView.sol**：模块健康检查与缓存（轻量检查 + 结果集中推送到 HealthView/供链下监控）
- **EventHistoryManager.sol**：事件历史“轻量桩件”（不持久化，仅发事件/DataPush，供链下归档与兼容旧模块）

#### **C) 清算风险相关的只读补充**

- **LiquidatorView.sol**：清算数据权威只读入口（清算相关指标、榜单、DataPush 单点推送）
- **SystemRiskView.sol**：system-scoped risk（仅全局阈值/系统参数，只读；**不得**包含任何 `user/users[]` 维度接口；阈值/最小健康因子等以此为权威入口）
  - 默认（推荐）：公开只读，便于任意前端/机器人 `eth_call` 获取阈值/参数
  - 可选增强（MAY）：若未来将 system-scoped risk 视为敏感数据，可对只读入口增加 `ActionKeys.ACTION_VIEW_RISK_DATA` gate（无权限 `revert MissingRole()`）
- **LiquidationRiskView.sol**：清算风险只读视图（批量计算/缓存读取等接口；与 LiquidationRiskManager/HealthView/RiskView 能力存在重叠，主要用于兼容/扩展；system-only 风险参数接口已移除，权威入口为 `SystemRiskView`）

---

## ⏱️ 时间依赖改造原则（重要）

> 本节给出架构级口径：**链上“门槛/窗口/有效性”不得依赖秒级时间**。需要墙钟时间展示时，统一交给链下做 ETA 映射与调度。
>
> **详细执行清单与改造模式决策表（SSOT）**：[`docs/Usage-Guide/Time-Dependency-Refactor-Guide.md`](Usage-Guide/Time-Dependency-Refactor-Guide.md)

### 核心规则（必须遵守）

- **严禁**：任何影响资金动作/清算/估值门槛的逻辑，使用秒级时间或“秒差比较”。
- **允许但必须标注为观测字段**：ABI/事件/返回值里仍叫 `blockNumber` 的字段，只能表示“观测时间/数据源时间/缓存写入时点”，不得作为门槛；并优先补充 `...Block` / `...Blocks` 口径字段。
- **推荐落点**：门槛语义统一迁移为 `...Block` / `...Blocks`；前端与 keeper 用“平均出块时间”做 ETA 展示与调度（链上不保留 `executeAfterTimestamp` / `expireAtTimestamp` 等门槛字段）。

### A/B/C/D：时间改造模式（简表）

> 注意：这里的 **A/B/C/D** 是“时间依赖改造模式”，与本文上文“缓存分类 A/B/C”不是同一套字母含义。

- **A（秒→块）**：把 `CACHE_DURATION / SYNC_INTERVAL / cooldown / maturity / expireAt` 等“秒窗口”迁移为 `...Blocks`，并用 `block.number - updateBlock` 做 age/validity 判定。
- **B（边界强制过期：集中 SSOT）**：将“过期/新鲜度”的权威判断集中在单一入口（典型：`IPriceOracleRead.getPrice`），调用方只接受结果，不在各处复制 blockNumber 门槛逻辑。
- **C（epoch/round）**：对“按周期结算/按轮次统计/治理窗口”等，更适合用单调 epoch/round 计数器表达，而不是用秒差。
- **D（单调性：兼容）**：当外部仍传入 `blockNumber`（历史 ABI/事件/跨系统对接）时，只允许做**单调不回退**约束（或改为 `seq/nonce`），不得与 `block.number` 做门槛比较。

### 测试与运维口径（简述）

- 测试中避免 `evm_increaseTime`；优先 `hardhat_mine` / advancing blocks，并断言 block-based age/validity。
- 链下调度（keeper/服务）基于 block 高度与平均出块时间估算 ETA；链上仅保存 block/epoch/seq 口径。

---

## 📝 双架构合约设计标准

### 统一的 View 地址解析策略（重要）

- 使用 KEY_VAULT_CORE 动态解析 View 地址，理由：单一真实来源、与现有权限和分发一致、避免新增 Key 并保持体系内聚。

```solidity
function _resolveVaultRouterAddr() internal view returns (address) {
    address vaultCore = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
    return IVaultCoreMinimal(vaultCore).viewContractAddrVar();
}
```

### **1. VaultCore - 极简入口合约 ✅ 已完成**

#### **实际实现（已对齐最新落账路径与 Getter）**

```solidity
contract VaultCore is Initializable, UUPSUpgradeable {
    address private _registryAddr;
    address private _viewContractAddr;

    /// @notice 显式暴露 Registry 地址
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    /// @notice 获取 View 层合约地址
    /// @dev 供各业务/清算模块解析 VaultRouter 地址使用
    function viewContractAddrVar() external view returns (address) {
        return _viewContractAddr;
    }

    // ============ 用户操作（传送数据至 View 层）============
    /// @notice 存款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 存款金额
    /// @dev 极简实现：只验证基础参数，传送数据至View层
    function deposit(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultRouter(_viewContractAddr).processUserOperation(msg.sender, ActionKeys.ACTION_DEPOSIT, asset, amount, block.number);
    }

    /// @notice 借款（资金拨付/订单创建）的主路径不在 VaultCore 内完成（SSOT）
    /// @dev 资金链 SSOT（详见 docs/Usage-Guide/Funds-Flow-Architecture-Guide.md）：
    ///      - 撮合放款：VaultBusinessLogic.finalizeMatch(...) 负责资金拨付/费用路由；
    ///      - 债务账本写入：通过 VaultCore.borrowFor(...) 统一入口触达 VaultLendingEngine(KEY_LE)；
    ///      - 订单创建与 orderId SSOT：由 OrderEngine(KEY_ORDER_ENGINE, core/LendingEngine) 创建订单并在落账成功后回调 RewardManager（Reward SSOT）。
    ///      因此：不要把 KEY_LE 当作“对外推荐直连写入口”，否则会绕开 orderId/Reward 等后置编排。
    ///
    /// @notice 借款账本写入（仅业务模块调用，撮合落地 SSOT）
    /// @param borrower 借款人
    /// @param asset 债务资产
    /// @param amount 借款金额
    /// @param termDays 借款期限（天）
    /// @dev 极简实现：VaultCore 仅作为“统一账本写入口”，不承担资金拨付/订单创建/奖励触发编排。
    function borrowFor(address borrower, address asset, uint256 amount, uint16 termDays) external onlyBusinessModule {
        require(borrower != address(0), "Borrower must be set");
        require(amount > 0, "Amount must be positive");
        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(lendingEngine).borrow(borrower, asset, amount, 0, termDays);
    }

    /// @notice 还款操作 - 统一结算入口（结算/清算二合一）
    /// @param orderId 订单/债务 ID（SSOT）
    /// @param asset 资产地址
    /// @param amount 还款金额
    /// @dev 当前实现：VaultCore 先将资产转入 SettlementManager，再按 orderId 调用 repayAndSettle，统一覆盖还款/结算口径
    function repay(uint256 orderId, address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        address settlementManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_SETTLEMENT_MANAGER);
      IERC20(asset).safeTransferFrom(msg.sender, settlementManager, amount);
      ISettlementManager(settlementManager).repayAndSettle(msg.sender, asset, amount, orderId);
    }

    /// @notice 提款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 提款金额
    /// @dev 极简实现：只验证基础参数，传送数据至View层
    function withdraw(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultRouter(_viewContractAddr).processUserOperation(msg.sender, ActionKeys.ACTION_WITHDRAW, asset, amount, block.number);
    }

    // ============ Registry 基础升级能力 ============ ✅ 已完成
    /// @notice 升级模块 - Registry基础升级能力
    /// @param moduleKey 模块键
    /// @param newAddress 新模块地址
    /// @dev 保留Registry升级能力，支持模块动态升级
    function upgradeModule(bytes32 moduleKey, address newAddress) external onlyAdmin {
        Registry(_registryAddr).setModuleWithReplaceFlag(moduleKey, newAddress, true);
    }

    /// @notice 执行模块升级 - Registry基础升级能力
    /// @param moduleKey 模块键
    /// @dev 保留Registry升级能力，支持模块升级执行
    function executeModuleUpgrade(bytes32 moduleKey) external onlyAdmin {
        Registry(_registryAddr).executeModuleUpgrade(moduleKey);
    }

    // ============ 基础传送合约地址的能力 ============ ✅ 已完成
    /// @notice 获取模块地址 - 基础传送合约地址能力
    /// @param moduleKey 模块键
    /// @return moduleAddress 模块地址
    /// @dev 保留基础传送合约地址能力，支持动态模块访问（主要供链外/工具侧便利调用）。
    ///      ⚠️ SSOT 说明：
    ///      - **模块地址解析的唯一真实来源永远是 Registry**（`Registry.getModule*`）。
    ///      - **链上模块不应把 VaultCore 当成“地址解析门面”依赖**；模块内部应直接使用其持有的 `_registryAddr`
    ///        调用 `Registry(_registryAddr).getModuleOrRevert(...)`，避免引入额外依赖层与升级耦合。
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 获取Registry地址 - 基础传送合约地址能力
    /// @return registryAddress Registry地址
    /// @dev 保留基础传送合约地址能力（主要供链外/工具侧获取 Registry 地址作为“低摩擦桥接”）。
    function getRegistry() external view returns (address registryAddress) {
        return _registryAddr;
    }
}
```

#### **命名与常量规范说明**

- ✅ **ActionKeys 常量**：使用带下划线的 UPPER_SNAKE_CASE 命名，如 `ActionKeys.ACTION_DEPOSIT`、`ActionKeys.ACTION_WITHDRAW`
- ✅ **私有变量**：使用下划线前缀，如 `_registryAddr`、`_viewContractAddr`
- ✅ **公开函数返回值**：使用命名返回参数，如 `returns (address moduleAddress)`
- ✅ **类型**：ActionKeys 常量为 `bytes32 constant` 类型，符合 `SmartContractStandard.md` 中“3.2 模块与动作常量规范（ModuleKeys / ActionKeys）”的约定

#### **✅ 已成功移除的功能**

- ❌ 复杂的权限验证逻辑
- ❌ 重复的事件发出
- ❌ 业务逻辑委托
- ❌ 在 `VaultCore` 内部做资产白名单验证
- ❌ 暂停/恢复功能
- ❌ 复杂的库调用

#### **✅ 已成功保留的功能**

- ✅ 用户操作传送（4个函数）
- ✅ Registry 升级能力
- ✅ 基础传送合约地址能力
- ✅ 必要的管理员权限验证

### **2. VaultRouter - 路由协调器 ✅ 已完成**

> ⚠️ **架构演进说明**：根据"写入不经 View"和职责分离原则，`VaultRouter` 不再承担业务查询职责，也不再作为业务数据缓存聚合面。用户/订单/风险等查询已迁移到独立的 View 模块；`VaultRouter` 仅保留路由器自身所需的少量基础设施只读接口与缓存维护能力。详见[架构演进历史](#架构演进历史)。

> 📌 **白名单口径补充**：白名单系统的实现、部署、Registry 注册和测试网上线注意事项，以 [`docs/Usage-Guide/WhitelistSystem.md`](Usage-Guide/WhitelistSystem.md) 为准。当前 `VaultRouter` 会缓存初始化时传入的 `AssetWhitelist` 地址，因此单纯替换 `Registry` 中的 `KEY_ASSET_WHITELIST`，不能直接等价为“所有调用方都会自动切换到新白名单模块”。

> 📌 **监控口径补充**：白名单与 Registry 准入相关的前端监控指标、告警和 DataPush 观测要求，以 [`docs/Usage-Guide/Monitoring-Observability-Implementation-Guide.md`](Usage-Guide/Monitoring-Observability-Implementation-Guide.md) 中的“4.6.1 白名单 / Registry 准入监控”为准。

#### **当前状态（符合架构原则）**

```solidity
contract VaultRouter is OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable {
  address private _registryAddr;
  address private _assetWhitelistAddr;

    // ============ 模块地址缓存（仅用于路由）========== ✅ 已实现
    address private _cachedCMAddr;
    /// @dev 时间口径 SSOT：缓存新鲜度/过期一律用 block 口径（避免 seconds 口径造成歧义）
    uint256 private _lastCacheUpdateBlock;
  address private _feeRouterViewAddr;
  /// @dev 链上门槛语义以 blocks 为准
  uint256 private constant _CACHE_EXPIRY_BLOCKS = 3600;

  function initialize(
    address initialRegistry,
    address initialAssetWhitelist,
    address initialPriceOracle,
    address initialSettlementToken,
    address initialOwner
  ) external initializer {
    _registryAddr = initialRegistry;
    _assetWhitelistAddr = initialAssetWhitelist;
    initialPriceOracle;
    initialSettlementToken;
    __Ownable_init(initialOwner);
  }

  function _validateAsset(address asset) internal view {
    if (!IAssetWhitelistRead(_assetWhitelistAddr).isAssetAllowed(asset)) {
      revert AssetNotAllowed();
    }
  }

    // ============ 用户操作路由 ============ ✅ 已实现
    function processUserOperation(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount,
        uint256 blockNumber
    ) external override nonReentrant whenNotPaused onlyValidRegistry onlyVaultCore {
        _validateAsset(asset);
        // 仅路由 deposit/withdraw 到 CollateralManager
        // borrow/repay 由 VaultCore 直接调用 LendingEngine（符合"写入不经 View"原则）
        if (operationType == ActionKeys.ACTION_DEPOSIT) {
            ICollateralManager(cm).depositCollateral(user, asset, amount);
        } else if (operationType == ActionKeys.ACTION_WITHDRAW) {
            ICollateralManager(cm).withdrawCollateral(user, asset, amount);
        } else {
            revert VaultRouter__UnsupportedOperation(operationType);
        }
        emit VaultAction(operationType, user, amount, 0, asset, blockNumber);
    }

    // ============ 数据推送接口（事件驱动架构）========== ✅ 已实现
    // 严格口径：VaultRouter 只接受来自 VaultCore 的 push*（onlyVaultCore），并转发到 View 模块（如 PositionView）。
    // 为避免接口漂移，push* 统一使用 “上下文 + version” 的单一签名（requestId/seq/nextVersion）。
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external override onlyValidRegistry onlyVaultCore {
        IPositionView(pv).pushUserPositionUpdate(user, asset, collateral, debt, requestId, seq, nextVersion);
        emit UserPositionPushed(user, asset, collateral, debt, block.number, requestId, seq);
    }

    function pushAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) external override onlyValidRegistry onlyVaultCore {
        emit AssetStatsPushed(asset, totalCollateral, totalDebt, price, block.number, requestId, seq);
    }

    // ============ 向后兼容查询（直接查询账本，无缓存）========== ✅ 已实现
    function getUserCollateral(address user, address asset)
        external
        view
        onlyValidRegistry
        returns (uint256 collateral, bool isValid, uint256 blockNumber)
    {
        // 直接查询 CollateralManager，不维护缓存
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        collateral = ICollateralManager(cm).getCollateral(user, asset);
        isValid = true;
        blockNumber = block.number;
    }
}
```

#### **✅ 已完全实现的功能**

- [x] 用户操作路由（deposit/withdraw 路由到 CollateralManager）
- [x] 数据推送接口（接收业务模块推送，发出事件）
- [x] 事件驱动架构（发出标准化事件，支持数据库收集）
- [x] 模块地址缓存（仅用于路由，block 口径 TTL：`CACHE_EXPIRY_BLOCKS`，约等于 1 小时仅用于理解/展示）
- [x] 权限控制（onlyVaultCore、onlyBusinessModule）
- [x] 安全保护（ReentrancyGuard、Pausable）
- [x] 向后兼容查询（getUserCollateral，直接查询账本）

#### **❌ 已移除的功能（已迁移到独立 View 模块）**

- [x] ~~View层业务数据缓存~~ → 已迁移到 `PositionView.sol`
- [x] ~~getUserPosition~~ → 已迁移到 `PositionView.getUserPositionWithMeta()`
- [x] ~~getUserDebt~~ → 已迁移到 `PositionView.sol`
- [x] ~~isUserCacheValid~~ → 已迁移到 `PositionView.getUserCacheStatusWithMeta()`
- [x] ~~batchGetUserPositions~~ → 已迁移到 `PositionView.sol` / `CacheOptimizedView.sol`
- [x] ~~缓存管理功能~~ → 已迁移到 `PositionView.sol`

#### **📝 查询功能位置**

所有查询功能现在由独立的 View 模块提供：

- **用户仓位查询**：`PositionView.getUserPositionWithMeta()` / `UserView.getUserPositionWithMeta()`
- **缓存有效性**：`PositionView.getUserCacheStatusWithMeta()`
- **批量查询**：`PositionView.batchGetUserPositionsWithMeta()` / `CacheOptimizedView.batchGetUserPositionsWithMeta()`
- **健康因子查询**：`HealthView.getUserHealthFactorWithMeta()`（当前按 Scheme U 收口：self 放行；non-self 需 `ActionKeys.ACTION_VIEW_USER_DATA` / `ActionKeys.ACTION_ADMIN`；batch 无 self-bypass）
- **统计聚合查询**：`StatisticsView.*`

### **3. AccessControlView - 双架构权限控制 ✅ 完全实现**

#### **实际实现（150行，完全符合标准）**

```solidity
contract AccessControlView is Initializable, UUPSUpgradeable {

    // ============ View层缓存数据 ============ ✅ 已实现
    mapping(address => mapping(bytes32 => bool)) private _userPermissionsCache;
    mapping(address => IAccessControlManager.PermissionLevel) private _userPermissionLevelCache;
    mapping(address => uint256) private _cacheTimestamps;
    uint256 private constant CACHE_DURATION = ViewConstants.CACHE_DURATION;

    // ============ 数据推送接口（事件驱动架构）========== ✅ 已实现
    function pushPermissionUpdate(
        address user,
        bytes32 actionKey,
        bool hasPermission
    ) external onlyValidRegistry onlyACM {
        _userPermissionsCache[user][actionKey] = hasPermission;
        _cacheTimestamps[user] = block.number;
        emit PermissionDataUpdated(user, actionKey, hasPermission, block.number);
        // 统一数据推送
        DataPushLibrary._emitData(DATA_TYPE_PERMISSION_BIT_UPDATE, abi.encode(user, actionKey, hasPermission));
    }

    function pushPermissionLevelUpdate(
        address user,
        IAccessControlManager.PermissionLevel newLevel
    ) external onlyValidRegistry onlyACM {
        _userPermissionLevelCache[user] = newLevel;
        _cacheTimestamps[user] = block.number;
        emit PermissionLevelUpdated(user, newLevel, block.number);
        // 统一数据推送
        DataPushLibrary._emitData(DATA_TYPE_PERMISSION_LEVEL_UPDATE, abi.encode(user, newLevel));
    }

    // ============ 查询接口（免费查询）========== ✅ 已实现
    function getUserPermissionWithMeta(address user, bytes32 actionKey)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (bool hasPermission, bool isValid, uint256 blockNumber)
    {
        blockNumber = _cacheTimestamps[user];
        hasPermission = _userPermissionsCache[user][actionKey];
        isValid = _isCacheValid(blockNumber);
    }

    function isUserAdminWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (bool isAdmin, bool isValid, uint256 blockNumber)
    {
        blockNumber = _cacheTimestamps[user];
        isAdmin = _userPermissionsCache[user][ActionKeys.ACTION_ADMIN];
        isValid = _isCacheValid(blockNumber);
    }

    function getUserPermissionLevelWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (IAccessControlManager.PermissionLevel level, bool isValid, uint256 blockNumber)
    {
        blockNumber = _cacheTimestamps[user];
        level = _userPermissionLevelCache[user];
        isValid = _isCacheValid(blockNumber);
    }

    // ============ 事件定义 ============ ✅ 已实现
    event PermissionDataUpdated(address indexed user, bytes32 indexed actionKey, bool hasPermission, uint256 blockNumber);
    event PermissionLevelUpdated(address indexed user, IAccessControlManager.PermissionLevel newLevel, uint256 blockNumber);

    // ============ 统一数据推送常量 ============ ✅ 已实现
    bytes32 public constant DATA_TYPE_PERMISSION_BIT_UPDATE = keccak256("PERMISSION_BIT_UPDATE");
    bytes32 public constant DATA_TYPE_PERMISSION_LEVEL_UPDATE = keccak256("PERMISSION_LEVEL_UPDATE");
}
```

#### **✅ 已完全实现的功能**

- [x] View层缓存数据（用户权限缓存、权限级别缓存、时间戳缓存）
- [x] 数据推送接口（权限位更新、权限级别更新）
- [x] 免费查询接口（3个 view 函数，0 gas，统一 meta 输出）
- [x] 事件驱动架构（2个事件 + 统一数据推送）
- [x] 统一事件库使用（DataPushLibrary）
- [x] 权限验证（onlyACM、onlyAuthorizedFor）
- [x] 缓存有效性检查（\_isCacheValid）
- [x] 命名规范（完全符合标准）
- [x] 错误处理（AccessControlView\_\_ZeroAddress、MissingRole）
- [x] 合约升级支持（UUPS）

### **4. 业务模块 - 纯业务逻辑 ✅ CollateralManager 已完成**

#### **CollateralManager - 抵押管理（实际实现，已完成）**

- 通过 Registry + KEY_VAULT_CORE 动态解析 View 地址，避免地址漂移。
- 统一数据推送常量化：`DEPOSIT_PROCESSED`、`WITHDRAW_PROCESSED`、`BATCH_*`。
- 存储变量遵循规范：私有 `_camelCase`；对外需查询提供 `view` 兼容接口。
- 兼容查询接口（账本只读）全部可用：`getCollateral`、`getTotalCollateralByAsset`、`getUserCollateralAssets`（**不再**提供任何“估值”接口）。
- 升级授权与权限校验统一采用自定义错误，避免字符串 `require`。

  solidity
  // 关键片段：统一的 View 地址解析策略（重要）
  function \_resolveVaultRouterAddr() internal view returns (address) {
  address vaultCore = Registry(\_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
  return IVaultCoreMinimal(vaultCore).viewContractAddrVar();
  }

// 数据推送：常量化类型，统一链下订阅
bytes32 internal constant DATA_TYPE_DEPOSIT_PROCESSED = keccak256("DEPOSIT_PROCESSED");
bytes32 internal constant DATA_TYPE_WITHDRAW_PROCESSED = keccak256("WITHDRAW_PROCESSED");
bytes32 internal constant DATA_TYPE_BATCH_DEPOSIT_PROCESSED = keccak256("BATCH_DEPOSIT_PROCESSED");
bytes32 internal constant DATA_TYPE_BATCH_WITHDRAW_PROCESSED = keccak256("BATCH_WITHDRAW_PROCESSED");

// 账本只读查询接口：保持可用（供向后兼容或系统态统计使用）
function getCollateral(address user, address asset) external view returns (uint256) {
return \_userCollateral[user][asset];
}

#### **LendingEngine - 借贷逻辑（目标）**

solidity
contract LendingEngine {
address public registryAddrVar;

    function processBorrow(address user, address asset, uint256 amount) external onlyVaultRouter {
        // 纯业务逻辑：处理借贷
        _processBorrow(user, asset, amount);

        // 更新 View 层缓存
        IVaultRouter(viewContractAddrVar).pushUserPositionUpdate(user, asset, currentCollateral, newDebt);

        // 发出事件
        emit BorrowProcessed(user, asset, amount, block.number);
    }

}

---

## 💰 双架构Gas成本分析

### **查询成本对比**

| 查询类型     | 双架构方案       | 纯事件驱动        | 传统缓存         |
| ------------ | ---------------- | ----------------- | ---------------- |
| **单次查询** | **0 gas** (view) | **0 gas** (view)  | **0 gas** (view) |
| **批量查询** | **0 gas** (view) | **0 gas** (view)  | **0 gas** (view) |
| **响应速度** | **极快** (缓存)  | **较慢** (跨合约) | **快** (缓存)    |

### **更新成本对比**

| 更新类型     | 双架构方案 | 纯事件驱动 | 传统缓存   |
| ------------ | ---------- | ---------- | ---------- |
| **权限更新** | 21,000 gas | 1,000 gas  | 21,000 gas |
| **位置更新** | 25,000 gas | 1,000 gas  | 25,000 gas |
| **状态更新** | 15,000 gas | 1,000 gas  | 15,000 gas |

### **总体成本分析**

| 场景         | 双架构方案 | 纯事件驱动 | 传统缓存 |
| ------------ | ---------- | ---------- | -------- |
| **高频查询** | **最优**   | 中等       | 中等     |
| **低频更新** | **最优**   | 最优       | 最差     |
| **用户体验** | **最优**   | 中等       | 最优     |
| **AI分析**   | **最优**   | **最优**   | 最差     |

---

## 风险与预言机实现路径（健康因子 / 优雅降级 / 预言机）

### 1) 健康因子（Health Factor）实现与业务路径

- 定位与职责
  - 健康因子属于账本+视图域的组合能力：**抵押估值来自 `PositionView`（读取 CM 账本 + 预言机）**，债务估值来自 `LendingEngine`；聚合/缓存由 View 层负责，供前端与机器人免费查询。
  - 业务层 `VaultBusinessLogic` 不再计算健康因子或推送健康事件，避免重复与噪音（迁移自业务层 → LE + View 层）。
- 推送与缓存
  - 统一由风险相关模块（如 `LendingEngine`、`LiquidationRiskManager` 等）在账本/风控计算后调用 `HealthView.pushRiskStatus(user, hfBps, minHFBps, under, ts)` 推送。
  - 可批量推送：`HealthView.pushRiskStatusBatch(...)`；前端读取 `getUserHealthFactorWithMeta` 或 `batchGetHealthFactorsWithMeta`，0 gas 查询。
  - 读权限策略（当前口径：Scheme U 收口，非公开）：
    - **单用户读取（Scheme U）**：`HealthView.getUserHealthFactorWithMeta(user)` / `HealthView.isUserLiquidatableWithMeta(user)`
      - self read：`msg.sender == user` 允许（无需 role）
      - non-self：caller 必须具备 `ActionKeys.ACTION_VIEW_USER_DATA` 或 `ActionKeys.ACTION_ADMIN`（否则 `revert MissingRole()`）
    - **批量读取（users[]，枚举能力，无 self-bypass）**：`HealthView.batchGetHealthFactorsWithMeta(users)`
      - caller 必须具备 `ActionKeys.ACTION_VIEW_USER_DATA` 或 `ActionKeys.ACTION_ADMIN`（否则 `revert MissingRole()`）
    - **说明**：该策略用于隐私强化与统一用户维度读权限；如需恢复“公开只读”，必须同步更新：前端调用方、链下机器人假设、以及相关测试断言。
- 计算口径
  - 使用 `libraries/HealthFactorLib.sol`：
    - `isUnderCollateralized(totalCollateral, totalDebt, minHFBps)` 进行阈值判定（推荐主路径，避免除法）；
    - `calcHealthFactor(totalCollateral, totalDebt)` 仅在需要具体数值时计算（单位 bps）。

### 2) 预言机路径（Price Oracle）与优雅降级（Graceful Degradation）

- **价格体系架构 SSOT**：完整的来源、归一化、发布、前端消费、preflight、缓存、监控口径统一见 [`docs/Usage-Guide/RWA-Price-System-Guide.md`](Usage-Guide/RWA-Price-System-Guide.md)。本节只保留借贷架构需要知道的核心约束。
- **统一发布链路（目标态）**：所有资产价格都应按“链下价格采集 -> 按该资产 `assetDecimals` 归一化为链上 price 口径 -> `PriceUpdater.updateAssetPrice` -> `PriceOracle` 存储”运行；`PriceOracle.updatePrice` 仅保留 break-glass / admin / emergency 用途。注意：当前仓库仍存在固定 统一 value 的存储/脚本/字段约定，迁移实施必须以 `docs/Usage-Guide/Units-And-Conversions-SSOT.md` 的当前现状与迁移矩阵为准。
- **统一消费链路**：前端、preflight、缓存、监控都只认“链上最终价 + 链下发布状态”，不得直接使用 raw source price 或 bootstrap 默认值做正式业务判断。

#### 资产价格使用分层（新增，强约束）

- **Tier-1：受支持自动估值资产（auto-valued）**
  - 只有这类资产允许进入自动放贷、自动清算、自动释放抵押、健康因子/清算阈值判断、自动结算等**会改变风险敞口或债务状态**的决策入口。
  - 进入 Tier-1 的最低前提是：`PriceOracle` 对该资产已启用且配置正确、`PriceOracle.getPrice(asset)` 在当前决策时点可直接成功返回 fresh price、价格精度/映射口径与该资产的链下目录一致。
  - 对 Tier-1 资产，调用方必须把 `PriceOracle.getPrice(asset)` 视为严格依赖边界；只要主价格读取失败、过期、精度异常或映射异常，就必须 fail closed，而不是把风险外移给 fallback。

- **Tier-2：参考价展示资产（reference-price-only）**
  - 这类资产可以暴露参考价、保守估值、诊断信息、运营看板、对账提示或人工处置辅助信息。
  - 这类资产**禁止**参与自动放贷额度、自动清算资格、自动 close factor、自动 seize amount、自动释放抵押、自动债务收口等决策。
  - `GracefulDegradation` 返回的 fallback value、缓存值、保守估值默认只属于 Tier-2 输入，除非上层入口显式声明“只读展示/诊断用途”。

- **动态降级规则**
  - 即使某资产在静态配置上属于 Tier-1，只要本次调用实际落到了 fallback / cached fallback / reference-only price，就必须在本次决策中临时降级为 Tier-2。
  - 降级后的结果是：只允许继续展示、记录事件、生成告警、保留人工处置上下文；不允许继续自动撮合、放贷、清算或关闭债务。

- **入口矩阵约束**
  - 所有借贷/清算/结算入口都必须在实现文档和测试中标注：它们到底是**严格依赖 `PriceOracle.getPrice`**，还是只允许读 `GracefulDegradation` 作为展示/诊断 fallback。
  - 不允许出现“代码里 silent fallback，但文档里默认当成权威估值”的灰区。

#### 自动决策入口价格依赖矩阵（新增，SSOT）

| 入口 / 模块 | 业务语义 | 目标价格边界 | `GracefulDegradation` 允许范围 | 当前代码事实 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `VaultBusinessLogic.finalizeMatch(...)` | legacy / 通用订单放款撮合，创建新债务敞口 | 若放款准入、LTV、抵押有效性依赖估值，则必须严格依赖 `PriceOracle.getPrice` | 只允许展示报价、preflight 提示、链下诊断 | 下游债务估值仍会进入 `VaultLendingEngine/LendingEngineValuation`，后者当前使用 `GracefulDegradation.getAssetValueWithFallback(...)` | 目标态应为 strict；当前实现不能宣称 strict |
| `VaultBusinessLogic.finalizeMatchBlocks(...)` | blocks-only 放款撮合，创建新债务敞口 | 同上，任何自动放款决策都必须 strict | 只允许展示/诊断 | 同样落入下游账本估值路径；strict 与 best-effort 尚未拆分 | 目标态应为 strict；当前实现不能宣称 strict |
| `VaultCore.borrowFor(...)` / `VaultCore.borrowForBlocks(...)` | 内部债务写入口 | 自身不应重新做 fallback 决策；若调用方不能证明 strict price，则必须回滚 | 不允许把 fallback 作为放款成功依据 | 账本更新后的估值/缓存更新仍可能走 GD fallback | 需要把自动决策估值与 best-effort 估值拆分 |
| `VaultCore.repay(...)` -> `SettlementManager.repayAndSettle(...)` | 用户还款与按债务账本释放抵押 | **无价格依赖**；是否释放抵押只看债务是否真实归零 | 仅允许用于展示收据、诊断日志 | 当前实现按 debt ledger truth 释放 collateral，而不是按 valuation cache 释放 | 这是正确方向；应继续保持“no-price close path” |
| `BlocksOnlyCoordinator.repayBlocks(...)` | blocks-only 用户还款 | **无价格依赖**；只依赖实际 repayment 与订单本地剩余交割额 | 仅允许展示/诊断 | `remainingDebt` 仅保留字段名兼容，业务语义应视为 order-local remaining settlement amount | 这是正确方向；不得再引入估值 close path |
| `BlocksOnlyCoordinator.closeRepaidTradeBlocks(...)` | blocks-only 已完成交割的 trade-like 收尾 | **无价格依赖**；前提是 `remainingDebt == 0` | 仅允许展示/诊断 | 当前与目标态一致：纯 debt-free close | 这是正确方向；不得要求 fallback 估值来“证明已清” |
| `SettlementManager.settleOrLiquidate(...)` | keeper 自动结算 / 自动清算（legacy / 通用订单） | 对 debt valuation、collateral 选择、seize sizing 都必须 strict `getPrice`；任一资产拿不到 strict price 就必须 fail closed 并转 shortfall/manual | 只允许记录事件、告警和人工处置上下文 | `calculateDebtValue(...)` 当前会吃 GD fallback；`PositionView.getAssetValue(...)` 失败后会退回 raw balance 选 collateral；fallback 分支仍可直接 `forceReduceDebt` | 当前实现与目标态不一致，必须整改 |
| `BlocksOnlyCoordinator.settleOrLiquidateBlocks(...)` | blocks-only 到期收尾（maturity closeout，保留旧 ABI 名称；“交割收尾”仅作同义注释） | **无价格依赖**；只依赖订单本地剩余交割额与预先绑定的成交 collateral | 仅允许展示/诊断 | 目标态不再做自动清算 sizing / seize / shortfall；若 `remainingDebt == 0` 则返还 collateral 给 borrower，否则进入到期交付收尾（maturity delivery closeout）并将绑定 collateral 交付给 lender | blocks-only 必须从通用借贷处置语义剥离 |
| `LiquidationManager.liquidate(...)` / `batchLiquidate(...)` / `liquidateFromSettlementManager(...)` | 显式参数清算执行器 | 执行器本身不应发现价格；只执行上游已经在 strict 模式下算好的 `coveredDebt` / `collateralAmount` | 不适用；执行器不应自行消费展示 fallback | 当前模块不直接读价格，但会忠实执行上游传入的 fallback-derived 参数 | 需要在上游加 strict-proof / shortfall handoff，执行器保持 price-agnostic |
| `PositionView.getAssetValue(...)` / `getUserTotalCollateralValue(...)` | collateral 风险只读估值 | 直接读 `PriceOracle.getPrice`；失败即返回 0 / skip，不做 GD fallback | 不需要读 GD fallback | 当前 collateral 侧 view 读是 strict-or-zero | 可作为 strict collateral read 基础，但调用方必须把 0 当成不可自动决策 |
| `VaultLendingEngine.calculateDebtValue(...)` / `updateUserTotalDebtValue(...)` | debt 风险估值与聚合 | 必须拆成 strict 自动决策口径 与 best-effort 展示口径 两条 API | 只允许 best-effort 版本暴露 GD fallback | 当前 debt valuation 主路径直接使用 `GracefulDegradation.getAssetValueWithFallback(...)` | 这是当前最大的边界泄漏点，必须先拆口径再谈 strict keeper |

- **矩阵解释 1：无价格依赖入口必须保持无价格依赖**
  - 还款、debt-free close、按真实还款释放抵押，本质上是“真实资金到账 + 真实债务归零”的账本事件，不应再被 fallback/reference price 污染。

- **矩阵解释 2：自动清算入口必须先拿到 strict proof，再进入执行器**
  - `SettlementManager` 与 `BlocksOnlyCoordinator` 这类 keeper 入口不能一边声称自己是“自动风险处置”，一边在 strict price 缺失时继续用 fallback/reference/balance heuristic 完成 seize 与减债。

- **矩阵解释 3：必须拆分 strict 与 best-effort API，而不是复用同一个 valuation helper**
  - 目标态至少要有两套显式接口：
    - `calculateDebtValueStrict(...)` / `getAssetValueStrict(...)`：自动授信、自动清算、自动 settle 决策专用。
    - `calculateDebtValueBestEffort(...)` / `getAssetValueBestEffort(...)`：前端展示、运维看板、故障诊断、人工处置专用。
  - 自动决策路径禁止直接调用带 fallback 语义的 best-effort 版本。

#### blocks-only 统一术语与代码映射标准（新增，三域统一）

- blocks-only 主叙事统一采用三分法：
  - 交易收尾（trade closeout）
  - 到期收尾（maturity closeout）
  - 到期交付收尾（maturity delivery closeout）
- “交割收尾”只允许作为同义注释出现，不作为主术语，不单独承载断言口径。
- 统一代码映射标准（文档、测试、脚本必须一致）：

| 主术语 | 统一代码入口/分支 | 统一状态与处置语义 |
| --- | --- | --- |
| 交易收尾（trade closeout） | `BlocksOnlyCoordinator.closeRepaidTradeBlocks(orderId)` | `remainingDebt == 0` 的 debt-free trade-like 关闭；兼容投影应落在 `BLOCKS_TRADE_CLOSE + RETURNED_TO_BORROWER` |
| 到期收尾（maturity closeout） | `BlocksOnlyCoordinator.settleOrLiquidateBlocks(orderId)`（ABI 历史命名保留） | maturity 后关闭总入口：`remainingDebt == 0` 时 borrower refund；`remainingDebt > 0` 时进入到期交付收尾 |
| 到期交付收尾（maturity delivery closeout） | `settleOrLiquidateBlocks(orderId)` 的 `remainingDebt > 0` 分支 | 订单绑定 collateral 交付给 lender；兼容回退 `SETTLED` 在该分支投影到 `BLOCKS_MATURITY_CLOSE + DELIVERED_TO_LENDER` |

#### blocks-only 兼容回退映射约束（新增，避免语义漂移）

- 当 `ORDER_STATE_STORE` 暂不可用、读口退回到 legacy/compat projection 时，`SETTLED` 兼容映射必须绑定真实到期收尾结果：
  - debt-free maturity closeout（borrower-return）映射为 `BLOCKS_MATURITY_CLOSE + RETURNED_TO_BORROWER`。
  - maturity delivery closeout（lender-delivery）映射为 `BLOCKS_MATURITY_CLOSE + DELIVERED_TO_LENDER`。
  - `TRADE_CLOSED`（trade closeout）映射为 `BLOCKS_TRADE_CLOSE + RETURNED_TO_BORROWER`。
- 禁止“`SETTLED` 一律映射到 lender-delivery”的兼容简化，这会把 debt-free maturity closeout 误报为 borrower 损失。
- 文档、测试、脚本三处口径必须一致：
  - 文档按上述映射描述。
  - 测试需覆盖 `SETTLED` 在兼容回退下的双分支投影（debt-free borrower-return / maturity-delivery lender-delivery）。
  - live/fork 脚本不得再把 maturity delivery 断言写成 `LIQUIDATED` 或 borrower-return 语义。

- 统一库
  - 唯一实现位于 `src/libraries/GracefulDegradation.sol`，提供完整的价格获取、重试、价格/精度/合理性校验、稳定币面值与脱锚检测、缓存（非 view 写入）与保守估值回退等能力。
 关键口径（避免 “decimals 只是 amount 缩放” 的误解）
  - `IPriceOracleRead.getPrice(asset)` 返回 `(price, blockNumber, assetDecimals)`：
    - **目标状态**：`price` 按该资产 `assetDecimals` 缩放的美元价格
    - **当前状态**：仓库主路径仍有多处把 `price/value` 当成固定 统一 value 使用，`assetDecimals` 已参与 amount→value 换算，但 price precision 迁移尚未完成
    - `assetDecimals`：**token decimals**，在目标 SSOT 中同时决定 amount / price / value 的缩放基准：
      $$
      valueUsd = \frac{amount(token\ base\ units) \times priceUsd}{10^{assetDecimals}}
      $$
      **注意**：迁移完成后，这里的 `assetDecimals` 既参与 amount→value 换算，也决定 price/value 的精度；当前实现仍处于从“price 固定 8 位”向该目标迁移的过程中。
  - 统一口径 SSOT（建议所有新代码/文档引用）：`docs/Usage-Guide/Units-And-Conversions-SSOT.md`
- 估值调用位置
  - 只在 `VaultLendingEngine` 的估值路径中使用（如计算用户/系统债务价值、`calculateDebtValue`、`getUserTotalDebtValue` 等）。
  - `VaultLendingEngine.getUserTotalDebtValue(user)` 的对外语义应视为 **fresh valuation read**：读取当前用户债务资产集合，按当前 oracle 口径逐资产重算；若业务要跨资产汇总或比较，必须先显式归一化到同一目标精度，调用方不得把它当成“仅返回旧缓存总值”的接口。
  - 业务层不再做预言机健康检查与降级处理；避免重复事件与分叉逻辑。
- 典型调用
  - `getAssetValueWithFallback(priceOracle, asset, amount, DegradationConfig)`（view，只读缓存）；
  - 健康检查：`checkPriceOracleHealth(...)`（带/不带缓存配置两版）。
- 降级策略
  - 失败/过期/精度异常/价格不合理/稳定币脱锚时，返回 `PriceResult{ usedFallback=true, reason=..., value=... }`；上层（LE）可据此发事件或写系统统计（`DegradationCore` 提供系统级统计/事件）。

#### 2.1) 降级监控模块（DegradationMonitor/Core/Storage）写路径 SSOT（推荐）

> 目标：把“降级事件记录”的写路径收敛为单入口（协调器），避免脚本/模块绕过导致口径漂移或权限误配。

- **写入口（协调器，SSOT）**：`DegradationMonitor`
  - 对外写接口：`recordDegradationEvent(...)`（admin）与 `recordDegradationEventFromPriceOracle(...)`（仅 `Registry[KEY_PRICE_ORACLE]`）
  - 职责：协调写入 Core（聚合统计）与 Storage（ring-buffer 历史），并提供只读聚合查询。

- **子模块写入权限（强约束，推荐默认）**
  - `DegradationCore.adminRecordDegradation(...)` 与 `DegradationStorage.addEventToCircularBuffer(...)` 允许：
    - **`msg.sender == Registry[KEY_DEGRADATION_MONITOR]`**（单入口协调器）
    - 或 caller 具备 `ActionKeys.ACTION_ADMIN`（保留 legacy/运维直写能力）
  - 说明：这允许 `DegradationMonitor` 作为写入协调器**开箱即用**，而无需给 Monitor 合约授予 `ACTION_ADMIN`（避免过权）。

- **只读聚合**
  - `getSystemDegradationTrends()`：analytics 未配置时（本仓库默认），采用 **方案 A（read-time）** 从 `DegradationStorage` ring-buffer 计算 `recentEvents/mostFrequentModule`，并优先从 `DegradationCore` 读取 `totalEvents/averageFallbackValue`（生命周期口径）。
  - `recentEvents` 的窗口以 blocks 表示：默认 `ViewConstants.CACHE_DURATION_BLOCKS`（链无关；不要用 seconds）。

### 3) 端到端数据流（简述）

本文件不再维护借款/还款/清算/费用等“资金链串联细节”，避免与资金链 SSOT 文档口径漂移。

- 资金链唯一权威：[`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](Usage-Guide/Funds-Flow-Architecture-Guide.md)
- 前端对接口径（入口/approve/查询）：[`docs/FRONTEND_CONTRACTS_INTEGRATION.md`](FRONTEND_CONTRACTS_INTEGRATION.md)

### 4) 关键约束与最佳实践

- 健康因子与风险推送统一在 LE + View 层；业务层不再保留。
- 预言机访问与优雅降级仅在 LE 估值路径；避免业务层重复检查。
- 统一走 `VaultCore` → `LendingEngine` 的账本入口（`onlyVaultCore`），消除双入口与权限不一致；撮合/结算路径通过 `VaultCore.borrowFor(...)` 触达账本层。

---

### 清算模块实际实施（修订：直达账本 + 风控只读/聚合 + 单点推送）

- 写入直达账本：
  - 编排入口按产品线区分：legacy / 通用订单由 **`SettlementManager`** 触发（Registry 绑定 `KEY_SETTLEMENT_MANAGER`）；blocks-only 订单由 **`BlocksOnlyCoordinator`** 触发（Registry 绑定 `KEY_BLOCKS_ONLY_COORDINATOR`）。
  - 清算分支在需要时直达账本模块写入；资金链与调用顺序以 Funds-Flow SSOT 为准。
  - 事件单点推送：账本变更成功后，由 `LiquidatorView.pushLiquidationUpdate/Batch` 统一对外。

- 单点推送与统一事件：
  - 写入成功后由 `LiquidatorView` 触发 DataPush：
    - `LIQUIDATION_UPDATE(user, collateralAsset, debtAsset, collateralAmount, debtAmount, liquidator, bonus, ts)`
    - `LIQUIDATION_BATCH_UPDATE(users[], collateralAssets[], debtAssets[], collateralAmounts[], debtAmounts[], liquidator, bonuses[], ts)`
  - `LiquidationManager` 不再直接 `_emitData`，避免事件双发与链下重复消费。

- 只读与风控合并（去重）：
  - `LiquidationRiskManager` 提供健康因子与风控聚合；
  - 清算只读查询（由 View/Library 层聚合，不参与写入），包含：
    - 抵押清算：`getSeizableCollateralAmount`、`getSeizableCollaterals`（读取 `KEY_CM` 账本）；`calculateCollateralValue`/`getUserTotalCollateralValue`（读取 `KEY_POSITION_VIEW → IPositionViewValuation.getAssetValue/getUserTotalCollateralValue`），及批量版本；
    - 清算人/系统统计：`getLiquidatorProfitView`、`getGlobalLiquidationView`、`getLiquidatorLeaderboard`、`getLiquidatorTempDebt`、`getLiquidatorProfitRate`；
    - 分析占位（保留）：`getLiquidatorEfficiencyRanking`、`getLiquidationTrends`（先用全局视图占位）。

- 用户级清算统计（接入中）：
  - 预留接口：`getUserLiquidationStats`、`batchGetLiquidationStats`（当前占位返回默认值）。
  - 后续将对接 `LiquidationRecordManager`/`LiquidationProfitStatsManager` 聚合真实用户级统计（总清算次数/价值/最后时间）。

- 命名与权限：
  - 遵循 §3.3 命名规范：公共变量 `registryAddrVar`/`viewContractAddrVar`；私有 `_registryAddr`；UPPER_SNAKE 事件常量；过去时态事件名；`__` 前缀错误名。
  - 写入权限在账本模块内校验：`CollateralManager` 与 `LendingEngine` 使用 `ACM.requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender)` 或等效机制；
  - View 层仅做只读/缓存/事件聚合，不持有“写入放行”权限。

- Gas 与缓存：
  - 直达账本避免二跳转发，减少一次外部调用与 ABI 编码开销；
  - 风控与只读聚合继续复用缓存（HealthView/LiquidationRiskManager），降低链上重算成本。

## 当前已采纳链路（方案 B）与职责边界

### 业务流程（SSOT）

本总纲不再维护“撮合放款 / 还款结算 / 费用分发”等资金链串联细节，避免与资金链 SSOT 文档口径漂移。

- 资金链唯一权威：[`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](Usage-Guide/Funds-Flow-Architecture-Guide.md)
- 前端集成与写入入口：[`docs/FRONTEND_CONTRACTS_INTEGRATION.md`](FRONTEND_CONTRACTS_INTEGRATION.md)

### 职责边界

- **VaultBusinessLogic（不再作为清算编排入口）**：
  - 代币转入/转出；抵押与保证金联动；唯一奖励触发；批量编排
  - 写入口必须收敛到“统一结算/清算入口”（见下节 `SettlementManager`），避免 repay/liquidate/settle 分叉
- **VaultCoreRefactored**：
  - 作为用户入口的权威收敛点：对外仅暴露 deposit/withdraw/repay（repay/settle SSOT 为 `SettlementManager`）
  - 借款不提供 direct user entry；借款账本写入只允许通过 `borrowFor(...)` 由撮合/结算编排路径触达（见上文与资金链 SSOT）
  - 不做代币二次转账（避免与业务层重复）
- **SettlementManager（新增，唯一写入口）**：
  - **唯一权威写入口（SSOT）**：统一承接 **按时还款结算 / 提前还款结算 / 到期未还处置 / 抵押价值过低触发的被动清算**
  - 内部根据状态机决定进入结算或清算分支；资金链与调用顺序以 Funds-Flow SSOT 为准
  - 订单终态的主 SSOT 现在是 `OrderStateStoreV2`（`KEY_ORDER_STATE_STORE`），按 `(productType, orderId)` 记录第一层主生命周期、`closeReason`、第二层 `shortfallStatus` 与第三层 `collateralDisposition`。`ORDER_ENGINE / LoanNFT.LoanStatus` 与 `BlocksOnlyCoordinator.BlocksOnlyOrderStatus` 仅保留为兼容镜像或旧读面来源，禁止再把它们当作唯一权威状态机。
  - `repayAndSettle(...)` 在进入还款主路径前必须先拒绝任何终态订单（至少包括 `Repaid` / `Liquidated` / `Defaulted`），避免用户侧还款路径继续落到已关闭订单上。
  - `repayAndSettle` 中“全量返还抵押”和“提前还款保证金结算”是两个独立判定：前者仍以“用户所有债务资产已清空”为准，后者应以“当前 order 已 fully repaid 且当前 debtAsset 已无账本债务”为准，避免把保证金结算错误绑定到全账户清仓
  - 其中“当前 order 已 fully repaid”的唯一权威来源必须是 `ORDER_ENGINE.getOrderTotalDueForView(orderId)`；`SettlementManager` 不得在业务侧复制 totalDue 公式自行判定。
  - 对外接口建议以 “one entry” 命名：`repayAndSettle(...)` / `settleOrLiquidate(...)` / `executeLiquidation(...)`（其中任意一种对外暴露即可，保持唯一入口）
- **LendingEngine**：
  - 借/还/强制减债的账本更新；估值路径内的优雅降级
  - 账本变更后：`VaultRouter.pushUserPositionUpdate` + `HealthView.pushRiskStatus` + 最佳努力触发 `RewardManager.onLoanEventByOrder*`
  - `onlyVaultCore`：拒绝任何非 Core 的账本写入
- **View 层**：
  - `VaultRouter`：仓位缓存与事件/DataPush；聚合查询 0 gas
  - `HealthView`：健康因子/风险状态缓存与事件/DataPush
  - `LendingEngineView`：对 loan 订单暴露 `getLoanOrder(...)`、`getOrderStatus(orderId)` 与新的 `getOrderStateSnapshot(orderId)`；`BlocksOnlyView` 对 blocks-only 暴露 `getBlocksOnlyOrderState(orderId)`。前端、脚本和链下消费者应优先消费这些显式快照口，而不是再根据 `repaidAmount`、debt ledger 是否归零、`remainingDebt == 0` 或旧 mixed enum 去推断 closed。

### 资金链口径（SSOT）

本文件不重复描述“借款/撮合放款/还款/费用分发/保证金扩展流/残值分配”等资金链细节。

- 资金链唯一权威：[`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](Usage-Guide/Funds-Flow-Architecture-Guide.md)
- 清算残值分配与收款地址配置：[`docs/Usage-Guide/Liquidation/Liquidation-Payout-Address-Guide.md`](Usage-Guide/Liquidation/Liquidation-Payout-Address-Guide.md)
- 前端集成口径（接口/approve/查询）：[`docs/FRONTEND_CONTRACTS_INTEGRATION.md`](FRONTEND_CONTRACTS_INTEGRATION.md)

### 配置要点

- Registry 必须正确指向：`KEY_VAULT_CORE`、`KEY_LE`、`KEY_CM`、`KEY_HEALTH_VIEW`、`KEY_RM`、`KEY_SETTLEMENT_MANAGER`、`KEY_ORDER_STATE_STORE`
- `LendingEngine.onlyVaultCore` 校验的 Core 地址与实际 Core 部署一致
- `LendingEngine` 配置 `priceOracle`、`settlementToken` 正确，以启用优雅降级

---

## 统一结算/清算写入口（按产品线区分）（新增，SSOT）

### 目标

- 将 **按时还款、提前还款、到期未还、抵押价值过低导致的被动清算** 统一收敛到一个对外写入口，避免“repay 与 liquidate 分叉、资金去向分叉、权限分叉”。

### 实施总纲（强烈建议先读）

> 为避免实现与文档口径分叉，`SettlementManager` 的完整整改路径（模块键、接口建议、迁移步骤、测试清单）已整理为 SSOT 总纲文档：
>
> - [`docs/Usage-Guide/Liquidation/SettlementManager-Refactor-Plan.md`](../Usage-Guide/Liquidation/SettlementManager-Refactor-Plan.md)

### 统一入口（建议）

- `repayAndSettle(user, debtAsset, repayAmount, orderId)`：用户 B 发起还款后，**必经 SettlementManager**，由其完成结算或清算的账本写入（资金链与调用顺序见 Funds-Flow SSOT）。
  - `SettlementManager` 对 `ORDER_ENGINE` 的代扣授权应保持“一次调用一次授权”：调用 `repay(orderId, repayAmount)` 前按本次金额授权，成功后立即清零，避免在结算合约上残留可复用 allowance。
  - 由该入口触发的保证金结算/违约处理（`EarlyRepaymentGuaranteeManager.settleEarlyRepayment/processDefault`）必须仅接受 `Registry[KEY_SETTLEMENT_MANAGER]` 调用，不允许保留 `VaultCore` 直通旁路。
- `settleOrLiquidate(orderId)`（可选）：keeper/机器人触发的 legacy / 通用订单“到期/风控检查后处置”入口（内部自动判定结算或清算，并计算清算参数；`orderId` 为仓位主键）。blocks-only 订单不应默认复用这里的 keeper 入口，而应走 `BlocksOnlyCoordinator.settleOrLiquidateBlocks(orderId)`；但对 blocks-only 而言，该入口的目标语义应收敛为“maturity 后的产品到期收尾（maturity closeout）”，不是继续复用通用处置执行器做 debt-ledger 清算。若订单已经债务归零且只需 trade-like 收尾，则应走 `BlocksOnlyCoordinator.closeRepaidTradeBlocks(orderId)`。

### 状态机分支（概念口径）

本节不复述资金链细节（如费用/罚金/残值分配）。

- 资金链唯一权威：[`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](Usage-Guide/Funds-Flow-Architecture-Guide.md)
- 实现整改与测试清单：[`docs/Usage-Guide/Liquidation/SettlementManager-Refactor-Plan.md`](Usage-Guide/Liquidation/SettlementManager-Refactor-Plan.md)

### 与 LiquidationManager 的关系（回答你的问题）

- **“统一走 LiquidationManager”不太符合语义**：LiquidationManager 更适合作为“违约处置/强制清算执行器”，而不是把正常还款也当作 liquidation。
- 推荐结构（B）：**SettlementManager 为 keeper/用户侧的默认对外入口**；`LiquidationManager` 作为其内部的“清算执行器模块”（直达账本 + 单点事件推送）。
  - 兼容：在具备 `ActionKeys.ACTION_LIQUIDATE` 权限时，仍允许直接调用 `LiquidationManager.liquidate/batchLiquidate` 做“显式参数清算”（测试/应急），但不建议作为常态入口。
  - 一致性约束：即使使用显式执行器入口，也必须维持与 keeper 主路径一致的“borrower 不能自清算”语义（`liquidator != targetUser`）。

---

## 清算写入直达账本（专章）

### 目标

- 将清算写入统一直达账本层（`CollateralManager`/`LendingEngine`），由账本模块内部进行权限校验与状态更新；View 仅承担只读/缓存/聚合与事件/DataPush。

### 设计

- 入口方：legacy / 通用订单由 **`Registry.KEY_SETTLEMENT_MANAGER` 指向 `SettlementManager`**；blocks-only 订单由 **`Registry.KEY_BLOCKS_ONLY_COORDINATOR` 指向 `BlocksOnlyCoordinator`**。当各自进入终态处置分支时：
  - 账本写入只发生在账本模块（CM/LE）；View 不承载写入转发。
  - legacy / 通用订单可继续保留“清算执行器模块（LiquidationManager）”作为内部执行器；但 blocks-only 不应再把 maturity 收尾实现成对通用借贷处置执行器的包装。
  - 对外入口必须保持唯一。

本节不复述具体函数名、参数与资金/抵押去向。完整资金链与实现细节以以下文档为准：

- 资金链唯一权威：[`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](Usage-Guide/Funds-Flow-Architecture-Guide.md)
- 实现整改与测试清单：[`docs/Usage-Guide/Liquidation/SettlementManager-Refactor-Plan.md`](Usage-Guide/Liquidation/SettlementManager-Refactor-Plan.md)

### 与前端/服务的集成

- 前端查询读取 `LiquidationRiskManager`/`LiquidatorView` 与 `StatisticsView`；写路径统一由 `SettlementManager` 承接（其内部在清算分支直达账本或调用 `LiquidationManager` 清算执行器）。
- **前端校验**：清算入口调用方（keeper/liquidator）必须与 borrower 不同；前端/服务端需显式拦截 `keeper == borrower`，否则会触发 `CollateralManager__UnauthorizedAccess()`。
- 地址解析建议：
  - 只读入口：通过 `KEY_VAULT_CORE → viewContractAddrVar()` 解析 View 地址；
  - 写入入口：legacy / 通用订单通过 Registry 获取 `KEY_SETTLEMENT_MANAGER`；blocks-only 订单通过 Registry 获取 `KEY_BLOCKS_ONLY_COORDINATOR`；清算执行器与账本模块地址通过 Registry 获取 `KEY_LIQUIDATION_MANAGER`/`KEY_CM`/`KEY_LE`。

### 生产 keeper 清算流程（更具体的落地方案）

- **收尾入口按产品线与生命周期划分**：legacy / 通用订单由 keeper 调用 `SettlementManager.settleOrLiquidate(orderId)`；blocks-only debt-free trade-like 订单可由任意调用方执行 `BlocksOnlyCoordinator.closeRepaidTradeBlocks(orderId)`；blocks-only maturity-gated 到期收尾仍由 keeper 调用 `BlocksOnlyCoordinator.settleOrLiquidateBlocks(orderId)`。
  - 对 blocks-only，`settleOrLiquidateBlocks(orderId)` 这个 ABI 名称仅为兼容保留；业务语义必须视为“maturity 后按产品约定完成到期收尾（maturity closeout）”。其中 `remainingDebt > 0` 分支属于到期交付收尾（maturity delivery closeout），“交割收尾”仅作同义注释。
  - blocks-only 的 maturity 收尾只允许消费订单创建时已经绑定的 collateral asset / collateral amount；不得再在运行时遍历 borrower 全量 collateral 做候选挑选、估值比较、bonus sizing 或 shortfall 推导。
- **价格刷新硬步骤**（链上不自动刷新）：
  - 对订单涉及的 collateral/debt 资产读取 `PriceOracle.getPriceUpdateBlock` 或 `getAssetConfig`。
  - 若 `block.number - updateBlock > maxPriceAgeBlocks`：先调用价格更新器刷新，再执行清算。
  - 刷新失败直接跳过本单并告警，避免估值为 0 引发 `SettlementManager__NoCollateral`。
- **清算估值边界**：
  - 只有 Tier-1 自动估值资产允许参与自动清算资格判断、可扣押数量计算和自动 debt reduction。
  - 若本次清算中 collateral 或 debt 资产只能拿到 fallback/reference price，则该笔清算必须转入“显式人工处置/显式 shortfall 处置”路径，不能继续按自动估值清算成交。
- **角色要求**：keeper EOA 需 `ActionKeys.ACTION_LIQUIDATE`；`SettlementManager` 需至少具备 `ActionKeys.ACTION_LIQUIDATE` 与 `ActionKeys.ACTION_VIEW_RISK_DATA`；其 repay 侧访问 `ORDER_ENGINE.repay/getLoanOrderForView/getOrderTotalDueForView` 已由 `ORDER_ENGINE` 显式信任 `Registry[KEY_SETTLEMENT_MANAGER]`，不再依赖额外的 `REPAY` / `ActionKeys.ACTION_VIEW_SYSTEM_DATA` 运行时补授权；`BlocksOnlyCoordinator` 的 `settleOrLiquidateBlocks(...)` 与 `closeRepaidTradeBlocks(...)` 在当前实现均为 permissionless 收尾入口，不要求 liquidation role；`LiquidationManager` 需 `ActionKeys.ACTION_LIQUIDATE` 与 `ActionKeys.ACTION_DEPOSIT`。当前 `LiquidationManager` 实现本身不直接读取估值/风险 View，也不依赖通用 view role 来向 `LiquidatorView` 推送事件。

### 三层终态模型与 shortfall 显式账（新增，强约束）

- **禁止继续依赖“价格大致合理 + forceReduceDebt 后账面归零”来表示清算完成**。
- 当前代码已经把订单终态拆成三层，并以 `src/interfaces/IOrderStateStoreV2.sol` / `src/core/OrderStateStoreV2.sol` 作为主 SSOT：
  - **第一层：主生命周期 + 显式 close reason**。当前枚举为 `ACTIVE`、`REPAID`、`LIQUIDATED`、`DEFAULTED`、`CLOSED`，关闭原因为 `FULL_REPAY`、`KEEPER_LIQUIDATION`、`MATURITY_DEFAULT`、`BLOCKS_TRADE_CLOSE`、`BLOCKS_MATURITY_CLOSE`。
  - **第二层：shortfall 子状态机**。直接复用 `IShortfallLedger.ShortfallStatus`。loan 的 liquidation/default 可进入 `ACTIVE`、`RESOLVED`、`WRITTEN_OFF` 等阶段；后续 recovery / write-off 只允许改这一层。
  - **第三层：collateral custody / disposition 状态**。当前枚举为 `NONE`、`COORDINATOR_CUSTODY`、`RETURNED_TO_BORROWER`、`DELIVERED_TO_LENDER`、`SEIZED_AND_DISTRIBUTED`，用于显式描述 collateral 去向。

- **当前实现与产品线语义的对应关系**：
  - loan 创建时由 `LendingEngine` 初始化 `LOAN + ACTIVE`；全额还款时写成 `REPAID + FULL_REPAY`。
  - loan 在 `SettlementManager` 的 keeper liquidation / maturity default 分支中，第一层分别写成 `LIQUIDATED` / `DEFAULTED`，`closeReason` 写成 `KEEPER_LIQUIDATION` / `MATURITY_DEFAULT`，第三层写成 `SEIZED_AND_DISTRIBUTED`；若存在 residual debt，则第二层写 `ACTIVE` 并由 shortfall ledger 继续收口。
  - blocks-only 创建时由 `BlocksOnlyCoordinator` 初始化 `BLOCKS_ONLY + ACTIVE + COORDINATOR_CUSTODY`。
  - blocks-only 在 `repayBlocks(...)` 把 order-local remaining settlement amount 还到 0 之后，会先进入 `REPAID`，但此时仍未终局关闭，collateral 继续保持 `COORDINATOR_CUSTODY`。
  - blocks-only 的 `closeRepaidTradeBlocks(...)` 才是 trade-like 的显式终局关闭：第一层写 `CLOSED`，`closeReason = BLOCKS_TRADE_CLOSE`，第三层写 `RETURNED_TO_BORROWER`。
  - blocks-only 的 `settleOrLiquidateBlocks(...)` 现在只是保留旧 ABI 名称的 maturity 收尾入口，不再代表通用借贷处置语义：若 `remainingDebt == 0`，写 `CLOSED + BLOCKS_MATURITY_CLOSE + RETURNED_TO_BORROWER`；若 maturity 时仍有未付余额，则写 `CLOSED + BLOCKS_MATURITY_CLOSE + DELIVERED_TO_LENDER`。当前正式写路径不会为 blocks-only 打开 shortfall 子状态机，第二层保持 `NONE`。

- **兼容面说明**：
  - `ILoanNFT.LoanStatus` 仍包含 `LiquidatedWithShortfall` / `DefaultedWithShortfall`，`IBlocksOnlyCoordinator.BlocksOnlyOrderStatus` 仍包含 `SETTLED`、`TRADE_CLOSED`、`LIQUIDATED_WITH_SHORTFALL` 等旧值；这些仅用于兼容旧写面、旧事件或 fallback 读面，不能再当作主状态机设计目标。
  - 新增读写接口、事件、视图和测试都应以 `OrderStateStoreV2` 的三层结构为准。

- **账本约束**
  - `forceReduceDebt` 只允许减少已经被真实偿付、真实没收或真实补偿覆盖的那部分 debt；不得把“基于参考价猜测应该能覆盖”的部分直接减到 0。
  - loan 的主生命周期可以已经进入 `LIQUIDATED` / `DEFAULTED` 终态，而第二层 shortfall 仍处于 `ACTIVE` / `RECOVERY_PENDING` / `WRITTEN_OFF`；这表示“业务处置已完成，但损失处理仍未 clean 收口”。因此，legacy `LoanStatus == Liquidated` 不再等价于“clean close”。
  - `syncLoanShortfallState(orderId, createdBlockHint, shortfallStatus)` 禁止通过 shortfall-only 路径补建 `ACTIVE` 生命周期；但当 `ORDER_ENGINE` 已报告 `Liquidated*` / `Defaulted*` 且 `LOAN` 状态缺失时，必须允许做终态补偿回填，避免临时 store 不可用导致长期状态空洞。
  - 只有在 `remainingDebt == 0` 且第二层不存在未决损失时，读面、对账与统计才可以把该订单标成 clean close；`WRITTEN_OFF` 是 loss terminal，不是 clean terminal。
  - 对于 blocks-only 当前 trade-like 路径，第二层必须显式暴露为 `NONE`，而不是靠 `remainingDebt == 0` 去推断“肯定没有损失分支”；是否 borrower refund 还是 lender delivery 由第一层 `closeReason` 与第三层 `collateralDisposition` 共同决定。

- **允许的 shortfall 收口路径**
  - 当前实现支持三类链上收口入口：
    - 显式入口：`SettlementManager.applyShortfallRecovery(...)` 与 `SettlementManager.setShortfallStatus(... WRITTEN_OFF ...)`。
    - 默认自动入口：`SettlementManager.settleOrLiquidate(...)` 在 default 分支收到 `EarlyRepaymentGuaranteeManager.processDefault(...)` 的实际罚没金额后，会自动按 `RecoverySource.GUARANTEE_FUND` 冲减同单 shortfall（上限为 `remainingDebt`）。
    - 受信自动上报入口：治理可通过 `SettlementManager.setShortfallRecoveryReporter(...)` 绑定 reporter 与 `RecoverySource`，供准备金/补偿池/链下自动化流程在“真实吸收已发生”后直接上报 recovery，无需再走人工账务脚本。
  - 若未来接入保证金/担保基金、准备金/补偿池或链下回款吸收，必须先有真实资金事实，再通过显式链上 recovery / write-off 入口落账；不得仅因这些模块存在就默认视为已吸收。
  - governance write-off / bad-debt absorb 必须保留独立事件与审计轨迹，不得伪装成真实回款。

- **观测与对账要求**
  - View/事件层必须能区分“business terminal reached”“loss 已 resolved / written off”“collateral 已返还还是已交付”。
  - 对账、监控、运营 runbook 不得把 shortfall 仓位混入已正常结清仓位，也不得把 collateral delivered-to-lender 与 borrower refund 这两种完全不同的收尾方式压缩成同一个 closed 标记。

#### 当前接口与读面（SSOT）

- **当前已经落地的接口**
  - 状态主存储：`src/interfaces/IOrderStateStoreV2.sol`
  - loan 快照读口：`LendingEngineView.getOrderStateSnapshot(orderId)`
  - blocks-only 快照读口：`BlocksOnlyView.getBlocksOnlyOrderState(orderId)`
  - 用户维度 loan 枚举兼容口：`LoanNFTView.getUserLoansPaginated(...)`，其状态字段会优先消费 `OrderStateStoreV2` 再回退到 legacy `LoanNFT` 元数据。

- **当前写路径衔接**
  - `LendingEngine.createLoanOrder(...)` / `BlocksOnlyCoordinator.finalizeMatchBlocks(...)` 负责初始化主状态。
  - `LendingEngine.repay(...)` 与 `BlocksOnlyCoordinator.repayBlocks(...)` 负责把已清债但尚未完成最终 close 的订单推进到 `REPAID`。
  - `SettlementManager` 的 loan 终局分支与 `BlocksOnlyCoordinator` 的 blocks-only close 分支负责原子写入第一层与第三层状态。
  - shortfall recovery / write-off 仍通过 `SettlementManager.applyShortfallRecovery(...)` 与 `SettlementManager.setShortfallStatus(...)` 收口，并同步回写 `OrderStateStoreV2` 的第二层。

- **写路径约束**
  - `forceReduceDebt(...)` 的输入必须收敛为 `coveredDebt`，不得再把 `requestedDebtReduction` 直接当成“应该能覆盖的债”。
  - 若 `requestedDebtReduction > coveredDebt`，同一交易内必须：
    - 只对 `coveredDebt` 调用 `forceReduceDebt(...)`；
    - 对差额写入 shortfall ledger；
    - 写入第一层主生命周期与 `closeReason`；
    - 发出 `LiquidationShortfallOpened` 事件。

- **读路径约束**
  - 任何声称“closed-clean / fully settled / fully liquidated”的 view、统计、DataPush、前端聚合，都必须同时读取：
    - 第一层 `OrderStateStoreV2.lifecycle`
    - 第一层 `closeReason`
    - 第二层 `OrderStateStoreV2.shortfallStatus`，必要时再结合 `ShortfallLedger.remainingDebt`
    - 第三层 `OrderStateStoreV2.collateralDisposition`
  - 不允许仅凭 legacy `LoanStatus != Active`、旧 mixed enum、`debt == 0`、`remainingDebt == 0` 或 `isClosed == true` 就把仓位视作 clean close。

- **治理与恢复约束**
  - `applyShortfallRecovery(...)` 只能用于真实 recovery 已发生的金额。
  - governance write-off 必须走 `RecoverySource.GOVERNANCE_WRITE_OFF` 并留下 `evidenceHash`；不得复用普通 recovery event 假装是真实回款。
  - `ShortfallStatus.RESOLVED` 仅适用于真实回收使 `remainingDebt == 0` 的场景；`ShortfallStatus.WRITTEN_OFF` 仅适用于显式核销吸收场景。两者都不得反向改写第一层主生命周期。

### 测试要求（修订）

- 用例覆盖：
  - 非授权直接调用 `CollateralManager.withdrawCollateral` 与 `LendingEngine.forceReduceDebt` 必须回滚（权限校验在账本层）。
  - 通过 `LiquidationManager` 发起时，账本写入成功且 `LiquidatorView.push*` 被触发；
  - 不依赖具体清算算法；仅验证路由、权限与单点事件/DataPush 原则。
- 参考：将 `LiquidatorViewForward` 测试替换为 `LiquidationDirectLedger.test.ts` 骨架。

### 迁移与兼容

- 若历史代码为"经 View 转发写入"，应迁移到"直达账本"：
  - 清算写入改为直接调用 `KEY_CM/KEY_LE`；
  - 事件/DataPush 保持由 `LiquidatorView.push*` 单点触发；
  - 保留只读 Aggregation 在 `LiquidationRiskManager`/`LiquidatorView`。

---

## 清算残值分配模块（专章）

本总纲不再复述残值分配 recipients/rates、默认比例、地址策略与部署细节，避免与实现级 SSOT 文档口径漂移。

- 实现与配置 SSOT：[`docs/Usage-Guide/Liquidation/Liquidation-Payout-Address-Guide.md`](Usage-Guide/Liquidation/Liquidation-Payout-Address-Guide.md)
- 资金链视角（与结算/清算入口关系）：[`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](Usage-Guide/Funds-Flow-Architecture-Guide.md)

---

## 测试与 CI 要求（方案 B 对应）

### 单测断言更新（最小改动）

- 去除：业务层健康相关事件或健康推送的断言（业务层已不再负责）
- 增加：
  - `LendingEngine.borrow/repay/forceReduceDebt` 后，`VaultRouter.pushUserPositionUpdate` 被调用（可断言事件或 View 缓存）
  - `HealthView.pushRiskStatus` 被调用（断言 `HealthFactorCached` 或 DataPush 中的 `RISK_STATUS_UPDATE` 负载）
  - 优雅降级路径：当价格过期/失败时，账本估值仍成功，且降级事件/统计可见（如 `VaultLendingEngineGracefulDegradation` 或系统级统计）

### 回归用例清单

- 借/还/存/取 与批量路径：账本只由 LE 写入；奖励仅一次触发；无重复事件
- 健康因子：账本变更后 HealthView 缓存更新；阈值 **SSOT** 为 `KEY_LIQUIDATION_CONFIG_MANAGER → LiquidationConfigModule`（`LiquidationRiskManager` 对外透传读取）
- 预言机异常：GD 生效且不阻断业务；估值结果合理（保守或缓存）
- 权限：`onlyVaultCore`、ACM 角色、Registry 模块解析

### CI（建议配置）

- 持续集成应包含：
  - `npm ci && npm run lint`（或 `pnpm`）
  - `npm run build`（类型检查）
  - `npx hardhat test --network hardhat`（单元/集成全跑）
  - 可选：`slither` 或 `hardhat analyze` 安全静态检查

示例（GitHub Actions）

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npx hardhat test --network hardhat
```

### 统计模块迁移说明（重要）

- 阶段一（当前）：保留 `KEY_STATS`（**Registry 注册键标签为 `VAULT_STATISTICS`**），并将其映射到 `StatisticsView`。
  - `StatisticsView` 作为 **B 类缓存** 承接“全局统计/用户统计/保证金统计”的状态存储，并提供只读聚合（`getGlobalStatisticsWithMeta` / `getGlobalSnapshotWithMeta`）。
  - **写入口径（Scheme B / Strict B+）**：`StatisticsView` 的 `push*` 写入口必须收敛为 **单一链上入口编排器** `StatisticsPushManager`（或 `ACTION_ADMIN` 紧急旁路），避免多写入口导致版本/seq 冲突与口径漂移。
  - **单位口径（Value Unit SSOT）**：`collateral/debt` 的估值必须遵循 Units & Conversions SSOT，即按各资产原生 decimals 解释；若需要跨资产聚合，必须先统一归一化到业务明确指定的目标精度，再由 `StatisticsPushManager` 推送 snapshot。
  - **读取语义（Debt Value）**：这里的 `LendingEngine.getUserTotalDebtValue(user)` 指的是“按当前账本 + 当前价格语义实时重算后的用户总债务价值”。内部即使维护缓存，也不得把对外读接口降级成“直接返回旧缓存镜像”，否则 `SettlementManager` 的全债清零判定与 `StatisticsPushManager` 的 snapshot 口径会漂移。
- 活跃用户计数规则：严格以“仓位>0（collateral>0 或 debt>0）”为活跃判定。
- 兼容性：为便于平滑迁移，`StatisticsView` 暴露与旧接口兼容的 `updateUserStats`/`updateGuaranteeStats`，内部转调新 `push*` 接口。
- 阶段二（后续）：统一地址解析到 `KEY_VAULT_CORE -> viewContractAddrVar()`，逐步去除对 `KEY_STATS` 的依赖；清理 `VaultStatistics.sol` 与 `IVaultStatistics.sol` 遗留。

---

## 🔧 双架构命名与常量规范

### **必须遵循的命名与常量规范（参见 SmartContractStandard.md 的“3.2 模块与动作常量规范（ModuleKeys / ActionKeys）”与“3.3 Solidity 命名规范”）**

```solidity
// 私有状态变量：_ + camelCase
address private _registryAddr;
mapping(address => mapping(bytes32 => bool)) private _userPermissionsCache;

// 显式 getter：使用 Var / AddrVar 后缀暴露底层存储值
function registryAddrVar() external view returns (address registryAddress);
function feeRouterViewAddrVar() external view returns (address feeRouterViewAddr);

// 地址语义变量：camelCase + Addr
address registryAddr;
address viewContractAddr;

// 函数参数：camelCase，语义化前缀
function initialize(address initialRegistryAddr)
function pushPermissionUpdate(address user, bytes32 actionKey, bool hasPermission)
function getUserPermissionWithMeta(address user, bytes32 actionKey)

// 事件名：PascalCase，过去时态
event PermissionDataUpdated(address indexed user, bytes32 indexed actionKey, bool hasPermission, uint256 blockNumber);
event UserOperation(address indexed user, bytes32 indexed operationType, address asset, uint256 amount, uint256 blockNumber);

// 错误名：优先使用自定义 error；权限失败建议统一 MissingRole()
error AccessControlView__ZeroAddress();
error MissingRole();
```

---

## 📝 NatSpec 注释规范（必须）

## 参考文件：/Volumes/AI-hosts/contracts/docs/Usage-Guide/Audit-Grade-NatSpec-Guide.md

## Unified DataPush Interface

### Why

链下监控、数据湖、向量数据库等组件需要统一的事件格式，避免碎片化解析逻辑。

### Interface

```
interface IDataPush {
    event DataPushed(bytes32 indexed dataTypeHash, bytes payload);
    function pushData(bytes32 dataTypeHash, bytes calldata payload) external;
}
```

- `dataTypeHash` 为 **keccak256("UPPER_SNAKE_CASE")** 常量。
- `payload` 使用 ABI 编码的结构体，结构体定义在各业务模块中。

### Library Usage

```
import { DataPushLibrary } from "contracts/libraries/DataPushLibrary.sol";
bytes32 constant DATA_TYPE_EXAMPLE = keccak256("EXAMPLE");
...
DataPushLibrary._emitData(DATA_TYPE_EXAMPLE, abi.encode(param1, param2));
```

### Migration Plan

1. 为所有 push\* 函数增加 `DataPushLibrary._emitData(...)` 调用；旧事件保留并加注 `// DEPRECATED`。
2. 前端 / Off-chain 服务仅订阅 `DataPushed`。

### Live 验收分层规则

- live 脚本必须先区分目标：若脚本目标是验证资金落账、仓位迁移、清算结果、还款结果等业务成功语义，则应采用 runtime-first；若脚本目标是验证事件总线、DataPush 完整性、链下投影输入、retry/replay 入口，则应作为 observability gate 保持严格事件断言。
- runtime-first 脚本中，`DataPushed` 缺失、延迟、或 payload 与 runtime 短暂不一致，默认记为 notice，不应直接覆盖已经成立的账本 / runtime 断言结果。
- observability gate 脚本中，事件与 DataPush 缺失应继续 hard fail，因为脚本本身就是在验证链下消费入口是否可用。
- 具体脚本清单与逐项理由，见 [Usage-Guide/Live-Observability-Gate-Checklist.md](Usage-Guide/Live-Observability-Gate-Checklist.md)。
- 当前仓库下的经验分类：
- `live-liquidation.ts`、`live-liquidation-arbitrum-sepolia.ts`、`live-liquidation-fallback.ts`、`live-batch-liquidation-pressure.ts`、`live-blocks-only-liquidation*.ts` 属于业务结果优先脚本，`DataPushed` 更适合作为 notice / attribution。
- `live-fee-*gate.ts`、`configure-dynamic-fee.ts`、`live-guarantee-events-datapush-arbitrum-sepolia.ts`、reward push / retry / recycle 专项脚本，属于 observability gate 或 push-path 专项脚本，事件存在性应继续作为硬断言。

### View 层实现一致性（整体描述）

- **目标**：确保所有 View 模块在“只读/缓存/聚合 + 统一 DataPush + 可升级”三个维度与本指南一致，便于前端/机器人统一接入、链下统一订阅、以及后续安全升级。
- **最小实现基线（必须）**：
  - **UUPS 安全基线**：实现合约包含 `constructor { _disableInitializers(); }`，并保留 `uint256[50] __gap;`；`_authorizeUpgrade` 做权限校验与零地址检查。
  - **版本化基线（C+B）**：所有 `src/Vault/view/modules/*.sol` 必须暴露统一版本信息入口：
    - `getVersionInfo() -> (apiVersion, schemaVersion, implementation)`
    - `apiVersion` 表达对外 API 语义版本；`schemaVersion` 表达缓存/输出结构版本（字段/编码/解释变化时递增）
    - `implementation` 用于链下定位当前实现地址（代理场景下可直接识别实现）
    - **关键模块可采用 A 策略**：保留旧事件/旧入口并新增语义化的 companion 事件或接口以平滑迁移（例如 `PositionView` 的 `UserPositionCachedWithVersion` / `*AtBlock` / `*WithBlockMeta`）
  - **统一 DataPush**：所有 `push*` 写路径必须调用 `DataPushLibrary._emitData(...)`；`dataTypeHash` 使用 **集中常量**（`DataPushTypes` / `keccak256("UPPER_SNAKE_CASE")`），避免散落重复定义。
  - **批量限制**：所有批量查询/批量推送统一使用 `ViewConstants.MAX_BATCH_SIZE` 并在入口校验长度，避免 RPC/执行失败。
  - **错误风格**：优先使用自定义 error（例如 `ContractName__Xxx`）或 `StandardErrors`，避免字符串 `require/revert`（更省 gas、链下更易解码）。
- **读权限策略（原则）**：
  - **默认推荐**：关键查询接口保持 0 gas 可读以服务前端/机器人。
  - **可选增强**：出于隐私/商业策略可对部分只读接口加 role gate，但应在实施前评估对前端/机器人 `eth_call` 的影响（详见“健康因子”章节中的读权限策略说明）。

### 用户维度 View：统一读权限（方案 U，强制）

> 目标：将“所有用户维度 view”统一为**真正面向用户的读接口**，避免出现“用户读取自己数据也必须先拿只读角色”的割裂体验；同时为 ops/admin 保留可审计的非本人读取通道。

#### 定义（适用范围）

- **用户维度 view（User-dimensional view）**：对外提供“按用户维度返回数据”的 View 接口（例如 `getUser*` / `*WithMeta(user, ...)` / 接收 `user` 或 `users[]` 参数的只读接口）。
- **非用户维度**：系统级/全局快照、模块注册查询、纯计算等不在本规则范围内。

#### 统一规则（必须）

- **Self read 必须允许**：当目标用户为 `user` 时，`msg.sender == user` 必须允许读取，无需任何角色。
- **Non-self read 必须受控**：当 `msg.sender != user` 时，必须具备：
  - `ActionKeys.ACTION_VIEW_USER_DATA` **或**
  - `ActionKeys.ACTION_ADMIN`
    否则必须 `revert MissingRole()`（断言 selector，不依赖 revert string）。
- **Batch user reads（涉及 users[]）必须更严格**：批量读取通常视为“枚举能力”，不得提供 self-bypass；应要求 `ActionKeys.ACTION_VIEW_USER_DATA` 或 `ActionKeys.ACTION_ADMIN`。

#### 实施指南（SSOT）

- 详细的实现模板、迁移步骤、批量口径、以及验收用例清单见：
  - [`docs/Usage-Guide/User-Dimensional-View-Read-Policy-Guide.md`](Usage-Guide/User-Dimensional-View-Read-Policy-Guide.md)

## Reward 模块架构与路径

### 📚 术语（Reward）

> 术语补充（避免误解）：Reward 域当前只使用 **Easy（`EasyToken`）** 作为奖励通证，所有奖励数量、消费数量和扣罚数量都以 Easy 语义表达。

### 目标

- 严格以“落账后触发”为准：仅当账本在 `LendingEngine` 成功更新后，才触发奖励计算/发放。
- 只读与写入分层：
  - `RewardManager/RewardManagerCore` 负责 Earn 侧计算与发放编排（锁定/释放/等级等），并在需要时**委托** `RewardAccrualManager` 做扣罚与欠账处理。
  - `RewardAccrualManager` 负责 **Penalty SSOT**：优先 burn Easy，若余额不足则累积到 penalty ledger，并统一推送 `RewardView`。
  - `RewardView` 负责只读聚合与统一 DataPush（链下订阅与前端查询入口）。
- 口径隔离：**Reward 口径（reward-qualified）** 与 **协议口径（protocol loan flow）** 必须分离；协议层的 borrow+repay volume/count 应读取 `LoanFlowView`（SSOT），其 value 语义遵循 Units & Conversions SSOT，跨资产消费前必须显式归一化，`RewardView` 不承载协议借贷统计字段。
- 统一功能库：Reward 模块的模块访问/权限校验/RewardView best-effort 推送统一由 `RewardModuleBase` 提供，避免业务合约重复实现。

### 方案 B（推荐默认）：`KEY_ORDER_ENGINE` + 按订单入口优先（运行稳定性闸门）

> 本节用于将 Reward 的“入口、顺序与文档口径”锁死为可回归验证的约束，避免出现“奖励与账本分叉 / 入口误配 / 双 SSOT 漂移”。

#### 运行稳定性闸门（必须全部满足）

1. **闸门 1：严格保证“先落账，再触发 Reward”**
   - `OrderEngine` 只能在 ledger（`LendingEngine` / debt ledger）成功更新之后调用 `RewardManager`。
   - 失败语义必须明确：要么整笔回滚；要么把 `RewardView.push*` 视为 best-effort（允许 push 失败不阻塞主流程），但禁止出现“Reward 核心写成功而 ledger 写失败”的分叉。
2. **闸门 2：Reward 写入口只允许 `KEY_ORDER_ENGINE`（单入口收敛）**

- `RewardManager.onLoanEventByOrder*` 写入口 caller gate 只认 `Registry[KEY_ORDER_ENGINE]`，明确拒绝其它模块（包括 `KEY_LE`）直连。
- blocks-only 若需要在 trade delivery 完成后发放 Easy，必须走 **产品专用的窄入口**，不能伪装成 `RewardManager.onLoanEventByOrder*` 调用去绕过 `KEY_ORDER_ENGINE` caller gate。

3. **闸门 3：文档 SSOT 必须收敛到一致**

- 本章（架构 SSOT）必须与合约实现/部署脚本一致：legacy / 通用订单上，`KEY_ORDER_ENGINE` 为唯一 Reward 写入口；blocks-only 若存在独立 Easy 发放路径，必须在文档与实现中显式标注为“产品专用交割完成入口”，不得混淆为 `RewardManager` 主写入口。

4. **闸门 4：用测试把入口与顺序锁死**
   - 非 `KEY_ORDER_ENGINE` 调用写入口必 revert；并覆盖“落账失败时不应产生 Reward 侧状态变化”。

### 职责分工（建议统一口径）

- **RewardManager（Earn gateway）**：借贷触发的奖励写入口门面 + 参数治理入口（**仅 `KEY_ORDER_ENGINE` 可调用写入口**；治理权限走 ACM）。
- **RewardManagerCore（Earn core）**：Earn 侧核心（锁定/释放/等级统计；向 `RewardView` 推送 Earn/Level 等可观测数据；扣罚/欠账不作为 SSOT）。
- **RewardAccrualManager（Penalty SSOT）**：扣罚执行与 penalty ledger SSOT（burn 优先；不足则记账；并向 `RewardView` 推送 `REWARD_BURNED` / `REWARD_PENALTY_LEDGER_UPDATED`）。
- **RewardView**：统一只读 + 统一 DataPush（链下订阅与前端查询入口；writer 白名单严格限制）。
- **EasyEmissionController（Easy 发行）**：按订单完成后发放 Easy（borrower/lender 50/50），并推送 `RewardView`。
- **EasyEmissionConfig（Easy 参数）**：Easy 发行参数 SSOT（阈值/系数），参数更新会推送 `RewardView`。
- **EasyConsumption（Easy 消耗）**：EasiM/Strategy API 按次消耗入口（每次 1 Easy），并推送 `RewardView`。
- **EasyRecycleDistributor（Easy 回收/分配）**：Easy 消耗后的 75/15/10 分配（burn/team/eco）+ 推送 `RewardView`。
- **EasyStaking（治理质押）**：质押 Easy 获得投票权（1:1），并推送 `RewardView`。

### 唯一路径（强约束）

1. 业务编排：`VaultBusinessLogic` 完成业务流程（不触发奖励）。
2. 账本落账：`OrderEngine` 完成 borrow/repay 并驱动 ledger（`LendingEngine`）成功更新。
3. Reward 触发（方案 B，推荐默认）：由 `OrderEngine`（Registry `KEY_ORDER_ENGINE`）在“落账成功之后”回调 `RewardManager`：
   - **推荐主路径（按订单维度）**：`IRewardManagerByOrder.onLoanEventByOrder(user, orderId, amount, maturity, outcome)`
     - **时间口径 SSOT**：`maturity` 语义为 `maturityBlock`（到期区块高度，legacy 参数名保留）。
     - outcome: 0=Borrow,1=RepayOnTimeFull,2=RepayEarlyFull,3=RepayLateFull
   - **Easy 发行（按订单 + lender）**：`onLoanEventByOrderWithLender(borrower, lender, asset, orderId, amount, maturity, outcome)`
     - 当 `outcome` 为任意“结清足额”（`RepayOnTimeFull/RepayEarlyFull/RepayLateFull`）且满足白皮书门槛/口径时触发 Easy 发行。
     - `RewardManager` 同步触发 `RewardManagerCore`（Earn 侧）与 `EasyEmissionController`（Easy 发行）。
4. 锁定/扣罚/欠账（SSOT 对齐当前实现）：

- **锁定/释放（Earn 侧）**：`RewardManager` → `RewardManagerCore` 负责 borrow 锁定与 repay 释放等 Earn 侧状态更新，并推送 `RewardView`。
- **扣罚与欠账（Penalty SSOT）**：由 `RewardAccrualManager` 统一执行：
  - 优先尝试 `EasyToken.burn(user, amount)`（需要 `BURNER_ROLE`）。
  - 若 burn 失败（余额不足等），则累积到 penalty ledger（欠账），并推送 `REWARD_PENALTY_LEDGER_UPDATED`。
- **清算惩罚边界（必须）**：liquidation/default 场景的 Reward penalty 不走 `KEY_ORDER_ENGINE` 主写入口；当前实现是在资金链结果已确定后，由 `GuaranteeFundManager` 独立调用 `RewardManager.applyLiquidationPenalty(user)`，且该调用是 best-effort，不得反向影响资金链账本落账。
- **Penalty 抵扣**：在任意奖励入账前统一调用 `RewardAccrualManager.offsetPenaltyOnReward(...)` 抵扣欠账，确保“先还欠账再入账”的统一口径。
- **重要变化（SSOT）**：`RewardManagerCore` 的 penalty ledger 存储位仅为兼容保留（不再作为 SSOT）；Penalty SSOT 以 `RewardAccrualManager` 为准。
- **blocks-only Easy 发放边界（新增，强约束）**：blocks-only 不是 `ORDER_ENGINE` 订单，不应复用 legacy 的 borrow/on-time/early/late Reward outcome。若 blocks-only 交割完成后要发放 Easy，必须由 `BlocksOnlyCoordinator` 在主账本 / 主状态成功收尾之后，以产品专用窄入口 best-effort 触发 `EasyEmissionController`；该路径不得写入 `RewardManagerCore` 的 borrow/repay earn 状态，也不得要求 `KEY_ORDER_ENGINE` caller gate 放宽到 blocks-only。

5. 只读与 DataPush：由 `RewardView` 内部统一 `DataPushLibrary._emitData(...)`：
   - **发放（Earn）侧**：`RewardManagerCore` 调用 `RewardView.push*`（writer 白名单）

- **Penalty（Penalty SSOT）侧**：`RewardAccrualManager` 调用 `RewardView.push*`（writer 白名单）
- **消费（Spend）侧**：`EasyConsumption` / `EasyRecycleDistributor` 调用 `RewardView.push*`（writer 白名单）
- **Easy 侧**：`EasyEmissionController` / `EasyEmissionConfig` / `EasyConsumption` / `EasyRecycleDistributor` / `EasyStaking` 调用 `RewardView.push*`（writer 白名单）
- `REWARD_BURNED` / `REWARD_LEVEL_UPDATED` / `REWARD_STATS_UPDATED` / `REWARD_PENALTY_LEDGER_UPDATED` / `REWARD_EARN_STATE_UPDATED`。
- `EASY_MINTED` / `EASY_SPENT` / `EASY_RECYCLED_SPLIT` / `EASY_STAKED` / `EASY_UNSTAKED` / `EASY_EMISSION_PARAMS_UPDATED`。

### 权限与边界

- `RewardManager.onLoanEventByOrder(user, orderId, amount, maturity, outcome)`：仅允许 `KEY_ORDER_ENGINE` 调用（推荐入口）。
- `RewardManager.onLoanEventByOrderWithLender(borrower, lender, asset, orderId, amount, maturity, outcome)`：仅允许 `KEY_ORDER_ENGINE` 调用（推荐入口；提供 lender/asset 给 Easy 发行等模块）。
- `RewardView` 写入白名单（以合约 `onlyWriter` 为准）：`RewardManagerCore`、`RewardAccrualManager`、`EasyEmissionController`、`EasyEmissionConfig`、`EasyConsumption`、`EasyRecycleDistributor`、`EasyStaking`。
- 奖励通证地址 SSOT：`Registry[KEY_EASY_TOKEN]`（EasyToken）。
- `EasyToken` 权限：
  - `MINTER_ROLE`：仅 `EasyEmissionController`
  - `BURNER_ROLE`：`RewardAccrualManager`（扣罚 burn 优先、否则记账）与 `EasyRecycleDistributor`（消费回收 burn）
    - 严格部署标准：`RewardManagerCore` 不得持有 `BURNER_ROLE`；若历史网络存在遗留授权，部署/升级脚本必须主动撤销。

### 借款期限门槛校验（BorrowCheck）读路径（强约束）

> 背景：`OrderEngine` 在创建长周期订单（如 90/180/360 天）时需要读取用户等级做门槛校验。该读取属于**协议内强制校验**，不是面向前端/链下的通用查询入口。

- **接口**：`RewardManagerCore.getUserLevelForBorrowCheck(user)`
- **caller gate（必须对齐真实调用方，避免线上 revert）**：
  - **必须允许**：`Registry[KEY_ORDER_ENGINE]`（OrderEngine，推荐默认）
  - **禁止**：任意其它 caller（必须 `revert MissingRole()`）
- **镜像边界**：`RewardView.USER_LEVEL` 仅用于观测与镜像一致性，不是长周期借款准入的 canonical authority。
- **文档与测试要求**：
  - NatSpec 必须明确上述 caller gate（禁止只写 “KEY_LE only” 造成口径漂移）。
  - 测试必须锁死：`KEY_ORDER_ENGINE` 允许、其它地址拒绝。

### 按期窗口（实现口径）

- **时间口径（强约束）**：所有“窗口/门槛/到期”判断一律使用 **block 口径**（见本文“时间依赖改造原则”），不得使用秒级时间或“秒差比较”。
- “按期且足额还清”的权威判断发生在 `LendingEngine (OrderEngine)`，当前固定为 `_ON_TIME_WINDOW_BLOCKS`（实现基线：`7200` blocks）。
  - 解释：在约 \(12s/block\) 的基线下，`7200` blocks \(\approx\) 24h；**该“24h”仅用于理解/展示，不作为链上门槛语义**。
- Reward 侧不再持有独立的“按期窗口”配置；`RewardManager`/`RewardManagerCore` 仅消费 `outcome`（由 `LendingEngine` 按 `_ON_TIME_WINDOW_BLOCKS` 判定并传入）。

### 模块键（ModuleKeys）

- `KEY_RM`：RewardManager
- `KEY_REWARD_MANAGER_CORE`：RewardManagerCore
- `KEY_REWARD_ACCRUAL_MANAGER`：RewardAccrualManager（Penalty SSOT：penalty ledger + burn 优先）
- `KEY_REWARD_VIEW`：RewardView（新增，只读视图 + 统一 DataPush）
- `KEY_EASY_TOKEN`：EasyToken
- `KEY_EASY_EMISSION_CONFIG`：EasyEmissionConfig
- `KEY_EASY_EMISSION_CONTROLLER`：EasyEmissionController
- `KEY_EASY_CONSUMPTION`：EasyConsumption
- `KEY_EASY_RECYCLE_DISTRIBUTOR`：EasyRecycleDistributor
- `KEY_EASY_STAKING`：EasyStaking（治理投票权 token）

### 前端/链下对接

- 订阅 `DataPushed` 事件，过滤 `DATA_TYPE_REWARD_*` + `DATA_TYPE_EASY_*`（含 `REWARD_PENALTY_LEDGER_UPDATED`）。
- 说明：`penalty ledger`（欠账账本，SSOT=`RewardAccrualManager`）更新使用独立 `REWARD_PENALTY_LEDGER_UPDATED`，避免与 `REWARD_STATS_UPDATED`（系统统计）复用导致 payload 冲突。
- 仅访问 `RewardView` 只读接口：
  - `getUserRewardSummaryWithMeta(user)`
  - `getUserRecentActivitiesWithMeta(user, fromBlock, toBlock, limit)`（分页/窗口，block 口径）
  - `getSystemRewardStatsWithMeta()`
  - `getTopEarnersWithMeta()`
  - `getUserEarnStateWithMeta(user)`（`lockedEasy / eligibleLoanCount / onTimeRepayCount` 的统一只读入口）
  - `getEasyEmissionParamsWithMeta()` / `getUserEasySpentWithMeta(user)` / `getUserEasyStakedWithMeta(user)`（Easy 观测）
  - **禁止/不要**在前端/链下直接调用 `RewardManagerCore` 的 `getUserLevel/getRewardParameters/getUserCache/...` 等查询接口：这些接口仅为协议内硬约束（例如 `LendingEngine` 的长周期期限门槛）与 `RewardView` 透传保留，视为 **DEPRECATED for external consumers**。

### 重要差异

- 不再从 `VaultBusinessLogic` 触发奖励；批量库（`VaultBusinessLogicLibrary`）完全移除奖励相关逻辑。
- 所有奖励以 `OrderEngine` 在 **ledger 落账成功后** 的唯一入口触发（`KEY_ORDER_ENGINE`），保证状态一致性。
- liquidation/default 的 Reward penalty 属于例外边界：它不是 `OrderEngine` 奖励主路径的一部分，而是由 `GuaranteeFundManager` 在资金链结果确定后追加的独立 Reward 写调用。

### 入口收紧（强制规范，必须遵守）

- **推荐唯一路径（按订单维度）**：`OrderEngine` 在成功落账后调用 `RewardManager.onLoanEventByOrder(user, orderId, amount, maturity, outcome)`，再由 RM 调用 `RewardManagerCore.onLoanEventByOrder` 实现“多订单独立锁定/结算”。
- 本金门槛：`RewardManagerCore` 已在 `onLoanEventByOrder` 强制 `amount < 1000 USDC` 不计分/不锁定；如需调整，请同步修改合约与测试并更新说明。
- `RewardManagerCore.onLoanEventByOrder` 不再接受外部直接调用：
  - 调用白名单仅限 `RewardManager`；否则将触发自定义错误 `RewardManagerCore__UseRewardManagerEntry`；
  - 不再保留 no-op 兼容或 `DeprecatedDirectEntryAttempt` 审计事件，避免“误调但未失败”的假成功语义；
- `EasyRecycleDistributor` 保留唯一恢复口：`settleOutstandingEasyBalance()`。
  - 仅用于处理“用户误把 Easy 直接转入 recycle 合约”这类异常余额；
  - 恢复时仍必须走统一 75/15/10（burn/team/eco）结算，不允许旁路 burn 或人工挪账。

### 迁移说明（对脚本/测试的影响）

- 任何直接调用 `RewardManagerCore.onLoanEventByOrder` 的脚本或测试都会失败（非 `RewardManager` 会被拒绝）。请统一改为：`OrderEngine → RewardManager → RewardManagerCore` 路径（推荐走按订单入口：`onLoanEventByOrder`）。
- 测试改动：新增断言“直接调用 RMCore 将 revert（`RewardManagerCore__UseRewardManagerEntry`）”。
- 前端/服务端仅订阅 `DataPushed` 事件，并同时覆盖 `DATA_TYPE_REWARD_*` 与 `DATA_TYPE_EASY_*`，不再依赖旧的链下解析路径。

---

## ✅ 双架构质量门禁

### **代码质量检查**

- [x] 无编译警告（VaultCore）
- [x] 无linter错误（VaultCore）
- [x] 100% NatSpec覆盖（VaultCore）
- [x] 代码简洁清晰（VaultCore）
- [x] 双架构逻辑清晰分离（VaultCore）

### **安全检查**

- [x] 权限验证正确（VaultCore）
- [x] 无重入风险（VaultCore）
- [x] 数据来源验证（VaultCore）
- [x] 升级机制安全（VaultCore）
- [ ] 缓存数据一致性（VaultRouter）

### **性能验证**

```bash
# 性能指标验证
查询响应时间: _____ (目标: < 100ms)
更新操作Gas: _____ (目标: < 25,000)
批量查询Gas: _____ (目标: 0 gas)
事件发出Gas: _____ (目标: < 1,000)
```

---

## 🎉 双架构总结

通过双架构设计，我们实现了：

### **1. 事件驱动架构优势**

- ✅ **完整事件历史** - 支持数据库收集和AI分析
- ✅ **实时数据流** - 事件立即触发数据库更新
- ✅ **AI友好** - 完整事件历史便于智能分析
- ✅ **Gas优化** - 事件发出成本可控

### **2. View层缓存架构优势**

- ✅ **免费查询** - 所有查询函数使用view（0 gas）
- ✅ **快速响应** - 缓存查询响应速度快
- ✅ **用户体验好** - 查询响应时间 < 100ms
- ✅ **数据一致性** - 通过推送机制保持数据同步
  - 📌 **缓存细节总目录（A/B/C 分类与全量表）**：[`docs/Usage-Guide/Cache-Architecture-Guide.md`](Usage-Guide/Cache-Architecture-Guide.md)

### **3. 双架构协同优势**

- ✅ **最佳性能** - 查询免费快速，更新成本可控
- ✅ **完整功能** - 既支持实时查询，又支持AI分析
- ✅ **灵活扩展** - 可以根据需求调整缓存策略
- ✅ **成本平衡** - 在性能和成本之间找到最佳平衡点

### **4. 实施要点**

1. **事件驱动层** - 负责数据收集和AI分析
2. **View层缓存** - 负责快速免费查询
3. **数据推送接口** - 连接两个架构层
4. **统一事件库** - 确保事件格式一致
5. **严格命名规范** - 遵循项目标准

### **5. 当前进度**

- ✅ **VaultCore 简化完成** - 142行，完全符合双架构标准
- ✅ **VaultRouter 双架构完全完成** - 优化后约500行，100%完成度，包含所有优化功能
- ✅ **AccessControlView 权限控制完成** - 150行，100%完成度，完整的双架构权限控制
- ✅ **CollateralManager 重构完成** - 450行，从1005行简化55%，实现纯业务逻辑
- 🔄 **业务模块重构进行中** - 继续重构其他模块

这样的双架构设计既满足了事件驱动架构的要求，又保持了查询的高性能，是一个完美的平衡方案！

---

## RegistryDynamicModuleKey（动态模块键）设计备注与气味点

### 角色与职责

- 作为 Registry 的“动态键名注册器”，解决静态 `ModuleKeys` 无法覆盖新增模块的可扩展问题。
- 提供按人类可读名称（规范化后）→ 动态 `moduleKey` 的映射能力；并暴露 `nameHash → moduleKey` 直接查表，供前端低开销解析。

### 关键路径（前端地址解析）

1. 前端对名称进行本地规范化（trim + lowercase + 校验字符集 `[a-z0-9_-]`，长度 3~50）。
2. 计算 `nameHash = keccak256(normalizedName)`。
3. 调用 `RegistryDynamicModuleKey.getNameHashToModuleKey(nameHash)` 拿 `moduleKey`。
4. 调用 `Registry.getModuleOrRevert(moduleKey)` 获取目标合约地址。

以上路径减少了在链上进行字符串处理的成本，事件监听侧也可以用 `ModuleKeyRegistered(moduleKey, nameHash, registrant)` 直接反查。

### Gas 与体积优化（已实施）

- 生成键：使用常量盐 + `abi.encodePacked`，避免拼接歧义并降低 gas/字节码。
- 规范化与校验：合并为单次遍历 `_normalizeAndValidate`，一次完成 trim/小写/校验；移除冗余双重循环。
- 事件精简：`ModuleKeyRegistered` 去除 `blockNumber` 与动态字符串 `name`；`ModuleKeyUnregistered` 去除 `blockNumber`、保留 `name` 便于链下快速消费。
- 错误参数收敛：移除动态 `string` 参数与冗余 `caller` 参数，失败路径更省 gas。
- 循环优化：缓存长度、`unchecked` 自增；`_removeFromList` 私有化以便内联。
- 清理未用导入与未用函数，减小字节码。

### 架构约束与边界

- 不承担地址解析到具体业务模块的职责；地址解析与升级执行留给 `Registry`（唯一真实来源）。
- 不承担 View 层缓存或数据推送；仅做键注册、撤销与查询。
- 权限：区分注册管理员与系统管理员；对外部写路径已启用 `nonReentrant`。

### 氣味点与建议

- 若未来事件订阅仅依赖 `nameHash` 与 `moduleKey`，可考虑进一步移除 `Unregistered` 事件中的 `name`，以统一事件载荷并进一步降 gas（需链下同步调整）。
- UUPS 可升级：如该合约已部署，避免移除父合约（如 `ReentrancyGuardUpgradeable`）以免存储布局破坏；如可重部署则可进一步裁剪无用父类以降体积。
- 前端应本地做规范化与 `nameHash` 计算，避免走 `getModuleKeyByName(name)` 字符串路径带来的额外开销与失败风险。

### 前端工具（已提供）

- 文件：`Frontend/src/utils/moduleKey.ts`
- 能力：
  - `normalizeModuleName(raw)`：按链上同规则规范化/校验名称；非法返回空串。
  - `computeNameHash(normalizedName)`：计算 `keccak256` 哈希（与链上兼容）。
  - `getNameHashFromRawName(raw)`：一站式获取 `nameHash`；非法返回 `null`。
  - `fetchModuleKeyByNameHash(contract, raw)`：通过 `nameHash` 走 mapping 取 `moduleKey`。

  ***

## 🧱 存储模式与布局策略（新增）

### 目标与原则

- **统一性**：同一“家族模块”共享同一份状态，避免多实现切换时的数据漂移。
- **可升级性**：全面采用 UUPS 升级范式，保留 `__gap`，兼容 OZ 工具链。
- **解耦性**：除共享状态的家族外，其它模块保持本地私有存储，降低耦合与升级半径。

### 双轨策略

1.  Registry 家族（共享状态，库式统一存储）

- **适用**：`Registry.sol`、`RegistryCore.sol`、`RegistryUpgradeManager.sol`、`RegistryAdmin.sol`、`RegistryQueryLibrary.sol`、`RegistryHistoryManager.sol`、`RegistrySignatureManager.sol` 等需要共享模块映射、治理、延迟、升级队列与历史的组件。
- **技术要点**：
  - 使用库式钻石存储：`RegistryStorage.layout()` 返回 `Layout`；固定槽位 `STORAGE_SLOT = keccak256("registry.storage.v1")`；多实现共用同一存储。
  - 统一初始化：`initializeRegistryStorage(admin_, minDelay_)`；版本管理：`storageVersion` + `upgradeStorageVersion(newVersion)`。
  - 安全校验：`validateStorageLayout()`；关键参数范围检查（如 `minDelay` 上界）。
  - 升级范式：合约实现用 UUPS（`UUPSUpgradeable`），保留 `uint256[50] __gap`。
- **迁移/校验清单**：
  - 迁移优先：保持 `STORAGE_SLOT` 不变，通过新实现提供 `migrateVxToVy()` 完成数据迁移；治理执行迁移后再切换实现。
  - 仅在“破坏性升级/完全重置”时才考虑改 `STORAGE_SLOT`（将丢失历史）。
  - 升级前后执行 `validateStorageLayout()`；对 `minDelay`、`admin` 等关键字段做健壮性断言。
  - 变更存储字段时，递增 `storageVersion`，并提供回放/备份脚本。

2.  View / 业务模块（独立状态，本地存储 + UUPS）

- **适用**：`VaultRouter`、`AccessControlView`、`StatisticsView`、`RewardView`、`LiquidatorView` 等 View；以及 `CollateralManager`、`LendingEngine`、`FeeRouter` 等业务模块与周边组件。
- **技术要点**：
  - 本地私有状态变量使用 `_camelCase`；需要暴露底层存储值时，优先通过显式 getter 使用 `*Var` / `*AddrVar` 后缀；保留 `__gap`。
  - 统一通过 `Registry.getModuleOrRevert(KEY_VAULT_CORE)` → `IVaultCoreMinimal.viewContractAddrVar()` 解析 View 地址。
  - 写入层推送到 View（事件驱动 + 缓存刷新），查询统一走 View（0 gas）。
  - 避免与 Registry 共用同一槽位，减少跨模块升级耦合。
- **迁移/校验清单**：
  - 升级只需保证本模块状态兼容（`__gap` 未破坏）；无需考虑 Registry 家族的共享状态。
  - 仅当需要横向共享时才考虑库式存储；默认保持本地存储。

### 模块映射建议

- **库式统一存储（共享状态）**：Registry 家族（上文列举）。
- **本地存储 + UUPS（独立状态）**：
- View 层：`VaultRouter`、`PositionView`、`UserView`、`HealthView`、`StatisticsView`、`LoanFlowView`、`ViewCache`、`AccessControlView`、`BatchView`、`RegistryView`、`SystemView`、`CacheOptimizedView`、`RewardView`、`LiquidatorView`，以及可选的 `DashboardView`、`PreviewView`、`RiskView`、`ValuationOracleView`、`FeeRouterView`、`LendingEngineView`、`ModuleHealthView`、`EventHistoryManager`、`LiquidationRiskView` 等。
- 业务层：`CollateralManager`、`LendingEngine`、`FeeRouter`、`PriceOracle`、清算各模块等。
- 动态键：`RegistryDynamicModuleKey`（其状态与 Registry 家族解耦，独立升级）。

### 为何匹配本指南架构

- 指南强调“Registry 作为唯一真实来源 + 模块化 + 升级治理 + View 层统一读”，Registry 家族用库式统一存储能最大化降低模块拆分后的状态漂移与迁移成本。
- View/业务模块主要承担读缓存和数据推送，强耦合共享存储的收益很小，采用本地存储 + UUPS 反而简单安全，且完全贴合“事件驱动 + View 0 gas 查询”的双架构主线。

### 实施要点与范式片段

- Registry 家族（示例要点）：
  - 固定槽位：`bytes32 internal constant STORAGE_SLOT = keccak256("registry.storage.v1");`
  - 访问方式：`RegistryStorage.Layout storage l = RegistryStorage.layout();`
  - 初始化：`RegistryStorage.initializeRegistryStorage(admin_, minDelay_);`
  - 版本/校验：`upgradeStorageVersion(newVersion)`、`validateStorageLayout();`
  - UUPS：实现合约继承 `UUPSUpgradeable`，并实现 `_authorizeUpgrade`。
- View/业务模块（示例要点）：
  - 状态变量：私有 `_stateVar`，公开 `stateVar` 或 `stateVarVar`（避免与 getter 冲突）。
  - 地址解析：通过 `KEY_VAULT_CORE → IVaultCoreMinimal.viewContractAddrVar()`。
  - 只读查询：全部 `view`；写入后推送事件 + 调用 View 刷新缓存。
  - 升级：UUPS + `uint256[__] __gap;`，不与 Registry 共槽位。

### 升级与安全基线

- 保持 `STORAGE_SLOT` 稳定；仅在需要"重置一切"时考虑改变。
- 严格的 `storageVersion` 递增与迁移脚本流程（含回滚预案与数据备份）。
- 在治理/关键写路径加入 `validateStorageLayout()` 与参数上界检查（如 `minDelay`）。
- 所有实现合约保留足量 `__gap`，避免未来变量插入破坏布局。

#### Ownership & Initialization 规范（强制）

> 一句话：**ACM/ActionKeys 负责“业务写权限”，Ownable 只负责“升级/紧急治理”，并且 owner 必须显式注入，禁止依赖 `msg.sender`。**

##### 默认规范（方案 A）

- 所有使用 `OwnableUpgradeable` 的可升级合约，其 `initialize(...)` **必须**显式接收 `address initialOwner`（或等价命名），并使用：
  - `__Ownable_init(initialOwner);`
- **禁止**：`__Ownable_init(msg.sender);`（OZ v5 迁移后此写法虽可编译，但会把“谁调用 initialize”误当成最终 owner，违背治理口径）
- `initialOwner` **必须**做零地址校验（`initialOwner != address(0)`），并用自定义错误或明确 revert 原因（与本指南 NatSpec “Reverts if” 口径一致）。

##### 威胁模型与防护要点（强制）

> 目标：明确“显式 `initialOwner`”并不引入新风险；真正的风险来自 **传错人 / 不校验 / 把 owner 暴露给不可信输入路径**。  
> 设计意图：把“最终 owner 是谁”从“谁调用 `initialize`”改为“部署者显式声明（可审计、可复现）”，并用合约与部署流程共同约束，降低误用与事故面。

**风险 1：`initialOwner` 传错（把 owner 交给攻击者 / 错误多签 / 错误 timelock）**

- **防护（合约，必须）**：
  - 强制 `initialOwner != address(0)`；优先使用自定义错误（如 `ZeroAddress()`）并在 NatSpec 写清楚 `reverts if initialOwner == address(0)`。
- **防护（部署/脚本，必须）**：
  - `initialOwner` 必须来自受控配置（按 `chainId` 分环境配置），**禁止**从前端、用户输入或不可信 calldata 透传。
  - 生产环境建议 **固定为 Timelock/Multisig 地址**；部署脚本必须在产物中落盘记录（链/合约名/实现&代理地址/`initialOwner`/tx hash），并在部署后做一次“读链断言”：`owner() == initialOwner`（失败则终止）。
  - 若需要人工确认流程，至少打印 `initialOwner` 与其角色（Timelock/Multisig）并让部署日志可回溯（便于审计复现）。

**风险 2：初始化抢跑（initializer 被他人先调用导致永久接管）**

- **防护（合约，必须）**：
  - 实现合约必须包含 `constructor { _disableInitializers(); }`（并在需要时用 `@custom:oz-upgrades-unsafe-allow constructor` 标注），防止对实现合约直接初始化。
- **防护（部署，必须）**：
  - 必须使用 `deployProxy(..., { initializer: "initialize(...)" })` 或等效“同交易初始化”方式，杜绝“先部署再 `initialize`”的窗口期。

**风险 3：工厂/路由/入口暴露 owner 入参（用户可指定 owner → 变相接管升级权）**

- **防护（架构约束）**：
  - 若合约属于“治理/系统入口”（类型 1），owner **必须固定为治理主体**（Timelock/Multisig/治理入口合约），**不提供**用户可控的 owner 入参。
  - 若确需可配置 owner（仅限测试/私有环境或受控工具），必须在工厂/入口侧做 **role-gated / allowlist**（例如仅治理地址可设置），并记录事件（如 `Deployed(proxy, initialOwner, ...)`）以便链上追踪与审计。
  - 任何“用户可达”的路径一律不应把 `initialOwner` 作为自由输入；最稳妥的做法是 **owner 固定为治理地址**，而不是由用户传入。

**风险 4：owner 与业务写权限混用（把 onlyOwner 当成业务权限）**

- **防护（口径）**：业务写权限统一走 `ACM.requireRole(ActionKeys..., msg.sender)` / `onlyRegistry`；owner 只用于升级/紧急治理。

**风险 5：初始化后“临时 owner”窗口（先用 msg.sender 再 transferOwnership）**

- **防护（规范，必须）**：
  - **禁止**把“临时 owner（部署者/脚本账户）→ `transferOwnership`”作为默认流程；这会引入脚本漏步骤/多签地址写错/中途停机等事故面，且可审计性差。
  - 必须显式 `initialOwner`，让“最终 owner 是谁”在初始化参数中一次性确定；需要迁移/过渡时，也应把过渡步骤写入明确的迁移脚本与审计产物，而不是依赖人工补操作。

##### owner 语义分型（必须写入 NatSpec）

为避免“谁是 owner/谁能升级/谁能紧急操作”口径分叉，合约必须明确其 owner 语义属于以下两类之一，并在 NatSpec `@notice/@dev` 中写清楚：

**类型 1：系统入口 / 治理合约（例如 Registry、VaultRouter 等）**

- **owner = 最终治理主体**（建议 Timelock / Multisig）
- `initialize(..., address initialOwner)` → `__Ownable_init(initialOwner)`
- 写权限：通常再叠加 ACM/ActionKeys（若存在业务写入口），但 owner 不应被当作业务写权限的唯一来源

**类型 2：内部模块合约（强调“唯一入口 Registry 调用”）**

- **业务写权限**：继续使用 `onlyRegistry` / `ACM.requireRole(ActionKeys..., msg.sender)`（符合本指南“写入口 SSOT/唯一入口”的主线）
- **升级/紧急权限（owner）**：必须二选一，并在合约 NatSpec 中声明采用哪一种（默认/例外）
  - **默认（推荐）**：owner 仍然是最终治理主体（Timelock/Multisig），方便治理直接升级/暂停模块
  - **例外（仅当你们要强制“升级/暂停也必须经由 Registry 单一入口”时启用）**：owner = `Registry`（或治理入口合约）

##### 参考实现片段（建议统一模板）

```solidity
function initialize(/* ... */, address initialOwner) external initializer {
    if (initialOwner == address(0)) revert ZeroAddress();
    __Ownable_init(initialOwner);
    // __UUPSUpgradeable_init(); / __Pausable_init(); / ...
}
```

##### 可执行检查规则（CI/本地强制）

> 目标：把“owner 初始化口径”变成可机器验证的约束，避免靠人工 review。

1. **编译级校验（必须）**

```bash
pnpm -s run compile
```

2. **禁止项扫描（必须为 0 结果）**

```bash
# 禁止：依赖 msg.sender 作为 owner 来源
rg "__Ownable_init\\(msg\\.sender\\)" src -g"*.sol"
```

3. **必要项抽样（必须可检出）**

```bash
# 至少应能在 OwnableUpgradeable 合约里检出显式 owner 注入（按需改为你的参数名）
rg "__Ownable_init\\(\\s*initialOwner\\s*\\)" src -g"*.sol"
```

4. **零地址校验（必须可检出/或由 lint 规则覆盖）**

```bash
# 允许自定义错误/不同参数名；至少应存在对 owner 入参的非零校验
rg "initialOwner\\s*==\\s*address\\(0\\)" src -g"*.sol"
```

5. **实现合约禁止被初始化（建议强制）**

```bash
# 建议：所有可升级实现合约都应在 constructor 中禁用 initializer
rg "_disableInitializers\\(\\)" src -g"*.sol"
```

---

## 📜 架构演进历史

### VaultRouter 职责演进

#### 阶段 1：早期设计

**设计目标**：VaultRouter 作为"双架构智能协调器"，包含所有功能：

- ✅ 用户操作路由
- ✅ View 层业务数据缓存（`_userCollateral`, `_userDebt`, `_cacheTimestamps`）
- ✅ 查询接口（`getUserPositionWithMeta`, `getUserCacheStatusWithMeta`, `batchGetUserPositionsWithMeta` 等）
- ✅ 数据推送接口

**问题**：

- ❌ 违反了"写入不经 View"原则（`processUserOperation` 会触发业务模块写入）
- ❌ 职责混合（路由 + 查询 + 缓存），违反单一职责原则
- ❌ 合约复杂度高，难以维护和扩展

#### 阶段 2：当前实现

**设计目标**：职责分离，符合"写入不经 View"原则：

- ✅ VaultRouter：只写不读（路由 + 数据推送）
- ✅ View 模块：只读不写（查询 + 缓存）

**迁移内容**：

- ✅ 查询功能迁移到独立 View 模块：
  - `getUserPosition` → `PositionView.getUserPositionWithMeta()`
  - `getUserDebt` → `PositionView.getUserPositionWithMeta()` (返回 debt)
  - `isUserCacheValid` → `PositionView.getUserCacheStatusWithMeta()`
  - `batchGetUserPositions` → `PositionView.batchGetUserPositionsWithMeta()` / `CacheOptimizedView.batchGetUserPositionsWithMeta()`
- ✅ 业务数据缓存迁移到 `PositionView.sol`
- ✅ VaultRouter 仅保留路由和数据推送功能

**优势**：

- ✅ 符合"写入不经 View"原则（账本写入直达账本模块）
- ✅ 职责清晰分离（路由 vs 查询）
- ✅ 模块化设计，便于维护和扩展
- ✅ 查询功能独立，可独立升级和优化

**当前状态**：

- ✅ VaultRouter：路由协调器（`processUserOperation`, `pushUserPositionUpdate`, `pushAssetStatsUpdate`）
- ✅ PositionView：用户仓位查询 + 缓存
- ✅ UserView：用户数据查询
- ✅ HealthView：健康因子查询
- ✅ StatisticsView：统计聚合查询

**参考文档**：

- `docs/FRONTEND_CONTRACTS_INTEGRATION.md` - 准确描述当前架构
- `docs/Architecture-Analysis.md`（“14. 权限和安全性问题”章节）- 验证架构一致性
- `docs/Usage-Guide/Liquidation/SettlementManager-Refactor-Plan.md` - SettlementManager 全面整改总纲（SSOT：按产品线区分入口、迁移步骤、测试清单）

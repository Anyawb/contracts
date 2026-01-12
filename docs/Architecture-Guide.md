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
- ✅ **严格命名规范** - 遵循SmartContractStandard.md第127行开始的命名约定

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

### 缓存：分类、统一策略与指南入口（必读）

> 结论：**只统一 A 类（模块地址缓存刷新）**；B/C 类不做“统一刷新入口”，只按事件推送/幂等/有效性标识的规范对齐。

- **缓存分类（A/B/C）**
  - **A 类：模块地址缓存（Module Address Cache）**  
    - 典型：`VaultRouter` / `LiquidationRiskManager` 内部缓存从 `Registry` 解析出来的模块地址  
    - 风险：模块升级/换址后短时间 stale，可能导致调用失败或读到旧地址  
    - **统一策略（已落地）**：`ICacheRefreshable.refreshModuleCache()` + `CacheMaintenanceManager.batchRefresh()`（单入口 + best-effort + 审计）
  - **B 类：View 业务快照缓存（Business Snapshot Cache）**  
    - 典型：`PositionView/HealthView/StatisticsView/AccessControlView/...`  
    - **策略**：写入成功后由业务模块 best-effort push；失败发事件 + 链下重试；读接口提供 `isValid/timestamp` 等有效性标识
  - **C 类：业务内部缓存/工具缓存（Internal / Utility Cache）**  
    - 典型：`RewardManagerCore` 的积分缓存、`GracefulDegradation` 的价格缓存、`RegistrySignatureManager` 的 domain separator 缓存等  
    - **策略**：不纳入统一刷新入口（语义差异大、权限面扩大、不利于审计）

- **团队快速入口（请把这两个当“缓存总目录”）**
  - **缓存全量盘点表（A/B/C + 字段/TTL/写入者/权限/失败重试）**：[`docs/Usage-Guide/Cache-Architecture-Guide.md`](Usage-Guide/Cache-Architecture-Guide.md)
  - **缓存推送失败与人工重试（运维手册）**：[`docs/Cache-Push-Manual-Retry.md`](Cache-Push-Manual-Retry.md)

### 缓存推送失败与手动重试（新增要求 & 已实施）
- 推送失败不做链上自动重试，避免 gas 暴涨/重复失败；采用“事件告警 + 链下人工重放”。
- 在推送 try/catch 中发事件 `CacheUpdateFailed(address user, address asset, address view, uint256 collateral, uint256 debt, bytes reason)`；当 view 地址解析为零也要触发，payload 建议携带期望写入的数值。
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
- **清算只读/风控**：LiquidationRiskManager + LiquidationView（仅只读与风控聚合，写入直达账本，不经 View）
- **积分管理（Reward）**：通过 RewardManager 集成（双架构支持，落账后触发）
- **批量操作**：BatchView.sol（双架构支持）

### **View 模块清单（按职责分组，补全 `src/Vault/view/modules/` 现状）**
> 说明：以下为“查询/缓存/事件聚合”视图层模块。**写入账本不经 View**；业务模块写入成功后，以“推送快照/发事件”为主更新 View 层缓存。

#### **A) 核心 View（建议部署，前端/机器人常用）**
- **PositionView.sol**：用户仓位查询 + 缓存（`getUserPosition/isUserCacheValid/batchGetUserPositions` 等）
- **UserView.sol**：用户维度只读聚合与便捷查询（与 Position/Health/Reward 等模块协作）
- **HealthView.sol**：健康因子/风险状态缓存与批量读取（写路径由风控/账本模块推送）
- **StatisticsView.sol**：系统级统计聚合缓存（活跃用户/全局抵押债务/保证金聚合/降级统计等）
- **ViewCache.sol**：系统级快照缓存（按资产聚合的系统状态，支持批量读取）
- **AccessControlView.sol**：权限只读查询（权限缓存、权限级别等）
- **BatchView.sol**：批量查询聚合（价格/健康/模块健康等批量接口）
- **RegistryView.sol**：Registry 模块键枚举/反查/分页（便于前端发现模块地址）
- **SystemView.sol**：统一入口/元信息路由（保留 registry/getModule 等少量 helper，遇到资产/价格/奖励/清算等请求时提示前端跳转到对应专属 View）

#### **B) 专属/扩展 View（可选部署，用于提升前端体验或运维能力）**
- **DashboardView.sol**：前端仪表盘聚合视图（聚合 Position/Health/奖励/活跃度等，减少 RPC 次数）
- **PreviewView.sol**：预览类查询门面（deposit/withdraw/borrow/repay 的预估接口；可作为前端入口，但权威实现以 UserView/PositionView 为准）
- **RiskView.sol**：风险评估视图（基于 HealthView 缓存与派生计算，提供 liquidatable/warningLevel 等）
- **ValuationOracleView.sol**：价格/预言机查询视图（封装 PriceOracle，提供批量价格、健康检查、审计事件）
- **FeeRouterView.sol**：费用数据只读镜像（由 FeeRouter 推送更新，支持低成本查询）
- **LendingEngineView.sol**：借贷引擎只读查询适配层（订单/重试/访问控制等运维与前端查询）
- **ModuleHealthView.sol**：模块健康检查与缓存（轻量检查 + 结果集中推送到 HealthView/供链下监控）
- **EventHistoryManager.sol**：事件历史“轻量桩件”（不持久化，仅发事件/DataPush，供链下归档与兼容旧模块）

#### **C) 清算风险相关的只读补充**
- **LiquidatorView.sol**：清算数据权威只读入口（清算相关指标、榜单、DataPush 单点推送）
- **LiquidationRiskView.sol**：清算风险只读视图（批量计算/缓存读取等接口；与 LiquidationRiskManager/HealthView/RiskView 能力存在重叠，主要用于兼容/扩展）

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
        IVaultRouter(_viewContractAddr).processUserOperation(msg.sender, ActionKeys.ACTION_DEPOSIT, asset, amount, block.timestamp);
    }
    
    /// @notice 借款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 借款金额
    /// @dev 极简实现：直接调用借贷引擎进行账本写入，遵循单一入口
    function borrow(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(lendingEngine).borrow(msg.sender, asset, amount, 0, 0);
    }
    
    /// @notice 还款操作 - 统一结算入口（结算/清算二合一）
    /// @param asset 资产地址
    /// @param amount 还款金额
    /// @dev 目标架构：还款不再直达 LendingEngine，而是统一进入 SettlementManager（包含：按时还款结算、提前还款结算、以及必要时的被动清算/强制处置）
    function repay(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        address settlementManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_SETTLEMENT_MANAGER);
        ISettlementManager(settlementManager).repayAndSettle(msg.sender, asset, amount);
    }
    
    /// @notice 提款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 提款金额
    /// @dev 极简实现：只验证基础参数，传送数据至View层
    function withdraw(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultRouter(_viewContractAddr).processUserOperation(msg.sender, ActionKeys.ACTION_WITHDRAW, asset, amount, block.timestamp);
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
    /// @dev 保留基础传送合约地址能力，支持动态模块访问
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }
    
    /// @notice 获取Registry地址 - 基础传送合约地址能力
    /// @return registryAddress Registry地址
    /// @dev 保留基础传送合约地址能力
    function getRegistry() external view returns (address registryAddress) {
        return _registryAddr;
    }
}
```

#### **命名规范说明**
- ✅ **ActionKeys 常量**：使用带下划线的 UPPER_SNAKE_CASE 命名，如 `ActionKeys.ACTION_DEPOSIT`、`ActionKeys.ACTION_WITHDRAW`
- ✅ **私有变量**：使用下划线前缀，如 `_registryAddr`、`_viewContractAddr`
- ✅ **公开函数返回值**：使用命名返回参数，如 `returns (address moduleAddress)`
- ✅ **类型**：ActionKeys 常量为 `bytes32 constant` 类型，符合 `SmartContractStandard.md` 第131行的命名规范

#### **✅ 已成功移除的功能**
- ❌ 复杂的权限验证逻辑
- ❌ 重复的事件发出
- ❌ 业务逻辑委托
- ❌ 资产白名单验证
- ❌ 暂停/恢复功能
- ❌ 复杂的库调用

#### **✅ 已成功保留的功能**
- ✅ 用户操作传送（4个函数）
- ✅ Registry 升级能力
- ✅ 基础传送合约地址能力
- ✅ 必要的管理员权限验证

### **2. VaultRouter - 路由协调器 ✅ 已完成**

> ⚠️ **架构演进说明**：从 2025-08 起，根据"写入不经 View"和职责分离原则，`VaultRouter` 不再承担任何读操作，也不再缓存业务数据。所有查询功能已迁移到独立的 View 模块（`PositionView`、`UserView`、`HealthView` 等）。详见[架构演进历史](#架构演进历史)。

#### **当前状态（符合架构原则）**
```solidity
contract VaultRouter is ReentrancyGuard, Pausable {
    address private immutable _registryAddr;
    address private immutable _assetWhitelistAddr;
    address private immutable _priceOracleAddr;
    address private immutable _settlementTokenAddr;
    
    // ============ 模块地址缓存（仅用于路由）========== ✅ 已实现
    address private _cachedCMAddr;
    address private _cachedLEAddr;
    uint256 private _lastCacheUpdate;
    uint256 private constant CACHE_EXPIRY_TIME = 1 hours;
    
    // ============ 用户操作路由 ============ ✅ 已实现
    function processUserOperation(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount,
        uint256 timestamp
    ) external override nonReentrant whenNotPaused onlyValidRegistry onlyVaultCore {
        // 仅路由 deposit/withdraw 到 CollateralManager
        // borrow/repay 由 VaultCore 直接调用 LendingEngine（符合"写入不经 View"原则）
        if (operationType == ActionKeys.ACTION_DEPOSIT) {
            ICollateralManager(cm).depositCollateral(user, asset, amount);
        } else if (operationType == ActionKeys.ACTION_WITHDRAW) {
            ICollateralManager(cm).withdrawCollateral(user, asset, amount);
        } else {
            revert VaultRouter__UnsupportedOperation(operationType);
        }
        emit VaultAction(operationType, user, amount, 0, asset, timestamp);
    }
    
    // ============ 数据推送接口（事件驱动架构）========== ✅ 已实现
    function pushUserPositionUpdate(address user, address asset, uint256 collateral, uint256 debt)
        external override onlyValidRegistry onlyBusinessModule
    {
        // 轻量实现：仅发出事件，不维护缓存
        emit UserPositionPushed(user, asset, collateral, debt, block.timestamp);
    }
    
    function pushAssetStatsUpdate(address asset, uint256 totalCollateral, uint256 totalDebt, uint256 price)
        external override onlyValidRegistry onlyBusinessModule
    {
        // 轻量实现：仅发出事件，不维护缓存
        emit AssetStatsPushed(asset, totalCollateral, totalDebt, price, block.timestamp);
    }
    
    // ============ 向后兼容查询（直接查询账本，无缓存）========== ✅ 已实现
    function getUserCollateral(address user, address asset) external view onlyValidRegistry returns (uint256) {
        // 直接查询 CollateralManager，不维护缓存
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        return ICollateralManager(cm).getCollateral(user, asset);
    }
}
```

#### **✅ 已完全实现的功能**
- [x] 用户操作路由（deposit/withdraw 路由到 CollateralManager）
- [x] 数据推送接口（接收业务模块推送，发出事件）
- [x] 事件驱动架构（发出标准化事件，支持数据库收集）
- [x] 模块地址缓存（仅用于路由，1小时有效期）
- [x] 权限控制（onlyVaultCore、onlyBusinessModule）
- [x] 安全保护（ReentrancyGuard、Pausable）
- [x] 向后兼容查询（getUserCollateral，直接查询账本）

#### **❌ 已移除的功能（已迁移到独立 View 模块）**
- [x] ~~View层业务数据缓存~~ → 已迁移到 `PositionView.sol`
- [x] ~~getUserPosition~~ → 已迁移到 `PositionView.sol`
- [x] ~~getUserDebt~~ → 已迁移到 `PositionView.sol`
- [x] ~~isUserCacheValid~~ → 已迁移到 `PositionView.sol`
- [x] ~~batchGetUserPositions~~ → 已迁移到 `PositionView.sol` / `CacheOptimizedView.sol`
- [x] ~~缓存管理功能~~ → 已迁移到 `PositionView.sol`

#### **📝 查询功能位置**
所有查询功能现在由独立的 View 模块提供：
- **用户仓位查询**：`PositionView.getUserPosition()` / `UserView.getUserPosition()`
- **缓存有效性**：`PositionView.isUserCacheValid()`
- **批量查询**：`PositionView.batchGetUserPositions()` / `CacheOptimizedView.batchGetUserPositions()`
- **健康因子查询**：`HealthView.getUserHealthFactor()`
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
        _cacheTimestamps[user] = block.timestamp;
        emit PermissionDataUpdated(user, actionKey, hasPermission, block.timestamp);
        // 统一数据推送
        DataPushLibrary._emitData(DATA_TYPE_PERMISSION_BIT_UPDATE, abi.encode(user, actionKey, hasPermission));
    }
    
    function pushPermissionLevelUpdate(
        address user,
        IAccessControlManager.PermissionLevel newLevel
    ) external onlyValidRegistry onlyACM {
        _userPermissionLevelCache[user] = newLevel;
        _cacheTimestamps[user] = block.timestamp;
        emit PermissionLevelUpdated(user, newLevel, block.timestamp);
        // 统一数据推送
        DataPushLibrary._emitData(DATA_TYPE_PERMISSION_LEVEL_UPDATE, abi.encode(user, newLevel));
    }
    
    // ============ 查询接口（免费查询）========== ✅ 已实现
    function getUserPermission(address user, bytes32 actionKey) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (bool hasPermission, bool isValid) {
        hasPermission = _userPermissionsCache[user][actionKey];
        isValid = _isCacheValid(_cacheTimestamps[user]);
    }
    
    function isUserAdmin(address user) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (bool isAdmin, bool isValid) {
        isAdmin = _userPermissionsCache[user][ActionKeys.ACTION_ADMIN];
        isValid = _isCacheValid(_cacheTimestamps[user]);
    }
    
    function getUserPermissionLevel(address user) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (IAccessControlManager.PermissionLevel level, bool isValid) {
        level = _userPermissionLevelCache[user];
        isValid = _isCacheValid(_cacheTimestamps[user]);
    }
    
    // ============ 事件定义 ============ ✅ 已实现
    event PermissionDataUpdated(address indexed user, bytes32 indexed actionKey, bool hasPermission, uint256 timestamp);
    event PermissionLevelUpdated(address indexed user, IAccessControlManager.PermissionLevel newLevel, uint256 timestamp);
    
    // ============ 统一数据推送常量 ============ ✅ 已实现
    bytes32 public constant DATA_TYPE_PERMISSION_BIT_UPDATE = keccak256("PERMISSION_BIT_UPDATE");
    bytes32 public constant DATA_TYPE_PERMISSION_LEVEL_UPDATE = keccak256("PERMISSION_LEVEL_UPDATE");
}
```

#### **✅ 已完全实现的功能**
- [x] View层缓存数据（用户权限缓存、权限级别缓存、时间戳缓存）
- [x] 数据推送接口（权限位更新、权限级别更新）
- [x] 免费查询接口（3个view函数，0 gas）
- [x] 事件驱动架构（2个事件 + 统一数据推送）
- [x] 统一事件库使用（DataPushLibrary）
- [x] 权限验证（onlyACM、onlyAuthorizedFor）
- [x] 缓存有效性检查（_isCacheValid）
- [x] 命名规范（完全符合标准）
- [x] 错误处理（AccessControlView__ZeroAddress、AccessControlView__Unauthorized）
- [x] 合约升级支持（UUPS）
```

### **4. 业务模块 - 纯业务逻辑 ✅ CollateralManager 已完成**

#### **CollateralManager - 抵押管理（实际实现，已完成）**
- 通过 Registry + KEY_VAULT_CORE 动态解析 View 地址，避免地址漂移。
- 统一数据推送常量化：`DEPOSIT_PROCESSED`、`WITHDRAW_PROCESSED`、`BATCH_*`。
- 存储变量遵循规范：私有 `_camelCase`；对外需查询提供 `view` 兼容接口。
- 兼容查询接口（账本只读）全部可用：`getCollateral`、`getTotalCollateralByAsset`、`getUserCollateralAssets`（**不再**提供任何“估值”接口）。
- 升级授权与权限校验统一采用自定义错误，避免字符串 `require`。
```solidity
// 关键片段：统一的 View 地址解析策略（重要）
function _resolveVaultRouterAddr() internal view returns (address) {
    address vaultCore = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
    return IVaultCoreMinimal(vaultCore).viewContractAddrVar();
}

// 数据推送：常量化类型，统一链下订阅
bytes32 internal constant DATA_TYPE_DEPOSIT_PROCESSED = keccak256("DEPOSIT_PROCESSED");
bytes32 internal constant DATA_TYPE_WITHDRAW_PROCESSED = keccak256("WITHDRAW_PROCESSED");
bytes32 internal constant DATA_TYPE_BATCH_DEPOSIT_PROCESSED = keccak256("BATCH_DEPOSIT_PROCESSED");
bytes32 internal constant DATA_TYPE_BATCH_WITHDRAW_PROCESSED = keccak256("BATCH_WITHDRAW_PROCESSED");

// 账本只读查询接口：保持可用（供向后兼容或系统态统计使用）
function getCollateral(address user, address asset) external view returns (uint256) {
    return _userCollateral[user][asset];
}
```

#### **LendingEngine - 借贷逻辑（目标）**
```solidity
contract LendingEngine {
    address public registryAddrVar;
    
    function processBorrow(address user, address asset, uint256 amount) external onlyVaultRouter {
        // 纯业务逻辑：处理借贷
        _processBorrow(user, asset, amount);
        
        // 更新 View 层缓存
        IVaultRouter(viewContractAddrVar).pushUserPositionUpdate(user, asset, currentCollateral, newDebt);
        
        // 发出事件
        emit BorrowProcessed(user, asset, amount, block.timestamp);
    }
}
```

---

## 💰 双架构Gas成本分析

### **查询成本对比**
| 查询类型 | 双架构方案 | 纯事件驱动 | 传统缓存 |
|----------|------------|------------|----------|
| **单次查询** | **0 gas** (view) | **0 gas** (view) | **0 gas** (view) |
| **批量查询** | **0 gas** (view) | **0 gas** (view) | **0 gas** (view) |
| **响应速度** | **极快** (缓存) | **较慢** (跨合约) | **快** (缓存) |

### **更新成本对比**
| 更新类型 | 双架构方案 | 纯事件驱动 | 传统缓存 |
|----------|------------|------------|----------|
| **权限更新** | 21,000 gas | 1,000 gas | 21,000 gas |
| **位置更新** | 25,000 gas | 1,000 gas | 25,000 gas |
| **状态更新** | 15,000 gas | 1,000 gas | 15,000 gas |

### **总体成本分析**
| 场景 | 双架构方案 | 纯事件驱动 | 传统缓存 |
|------|------------|------------|----------|
| **高频查询** | **最优** | 中等 | 中等 |
| **低频更新** | **最优** | 最优 | 最差 |
| **用户体验** | **最优** | 中等 | 最优 |
| **AI分析** | **最优** | **最优** | 最差 |

---

## 🎯 双架构实施指南

### **Phase 1: VaultCore 简化 ✅ 已完成**
- [x] 移除复杂的权限验证逻辑
- [x] 移除重复的事件发出
- [x] 移除业务逻辑委托
- [x] 保留 Registry 升级能力
- [x] 保留基础传送合约地址能力
- [x] 保留传送数据至 View 层能力

### **Phase 2: VaultRouter 双架构增强 ✅ 完全完成**
- [x] 实现用户操作处理函数
- [x] 实现模块分发逻辑
- [x] 实现View层缓存数据存储
- [x] 实现数据推送接口（事件驱动）
- [x] 实现免费查询接口（view函数）
- [x] 实现统一事件发出
- [x] 基础缓存管理
- [x] 基础批量查询功能
- [x] 优化模块分发性能（模块地址缓存）
- [x] 增强批量查询功能（健康因子、价格批量查询）
- [x] 添加缓存统计功能（缓存统计、过期缓存清理）

### **Phase 3: 业务模块双架构优化 ✅ 已完成（CollateralManager）**
- ✅ CollateralManager 重构完成 - 从1005行简化到 ~450行，实现纯业务逻辑
- ✅ 实现数据推送到 View 层缓存（统一常量化 DataPush）
- ✅ 简化模块访问逻辑（通过 KEY_VAULT_CORE 动态解析 View 地址）
- ✅ 统一事件发出格式（DataPushLibrary + 业务事件）
- ✅ 实现 View 层数据更新（pushUserPositionUpdate）

### **Phase 4: 双架构完善 🔄 待开始**
- [ ] 统一事件库使用
- [ ] 数据库实时收集
- [ ] AI 分析友好格式
- [ ] 完整事件历史记录
- [ ] View层缓存优化

---

## 风险与预言机实现路径（健康因子 / 优雅降级 / 预言机）

### 1) 健康因子（Health Factor）实现与业务路径
- 定位与职责
  - 健康因子属于账本+视图域的组合能力：**抵押估值来自 `PositionView`（读取 CM 账本 + 预言机）**，债务估值来自 `LendingEngine`；聚合/缓存由 View 层负责，供前端与机器人免费查询。
  - 业务层 `VaultBusinessLogic` 不再计算健康因子或推送健康事件，避免重复与噪音（迁移自业务层 → LE + View 层）。
- 推送与缓存
  - 统一由风险相关模块（如 `LendingEngine`、`LiquidationRiskManager` 等）在账本/风控计算后调用 `HealthView.pushRiskStatus(user, hfBps, minHFBps, under, ts)` 推送。
  - 可批量推送：`HealthView.pushRiskStatusBatch(...)`；前端读取 `getUserHealthFactor` 或 `batchGetHealthFactors`，0 gas 查询。
  - 读权限策略（默认公开，推荐暂不加 Role Gate）：
    - **默认（当前推荐 & 与本指南主线一致）**：`HealthView.getUserHealthFactor/batchGetHealthFactors` 保持公开只读（不强制 `ACTION_VIEW_RISK_DATA`），便于任意前端/机器人直接 `eth_call` 免费查询缓存。
    - **可选增强（暂不实施）**：若出于隐私/商业策略，希望“风险数据仅授权调用者可读”，可在上述只读接口上增加 `ACM.requireRole(ActionKeys.ACTION_VIEW_RISK_DATA, msg.sender)` 或等效 gate。
    - **影响说明（启用可选增强前必须评估）**：
      - 前端/机器人将必须使用“已授予 `VIEW_RISK_DATA` 的地址”发起 `eth_call`，否则查询会 revert；这会改变既有集成假设与可用性（尤其是公开页面/无需登录的钱包）。
      - 需要同步更新：前端权限提示、服务端代理/签名查询方案、以及相关测试用例（例如批量查询与风控机器人）。
- 计算口径
  - 使用 `libraries/HealthFactorLib.sol`：
    - `isUnderCollateralized(totalCollateral, totalDebt, minHFBps)` 进行阈值判定（推荐主路径，避免除法）；
    - `calcHealthFactor(totalCollateral, totalDebt)` 仅在需要具体数值时计算（单位 bps）。

### 2) 预言机路径（Price Oracle）与优雅降级（Graceful Degradation）
- 统一库
  - 由 `libraries/GracefulDegradation.sol` 提供完整的价格获取、重试、价格/精度/合理性校验、稳定币面值与脱锚检测、缓存（非 view 写入）与保守估值回退等能力。
- 估值调用位置
  - 只在 `VaultLendingEngine` 的估值路径中使用（如计算用户/系统债务价值、`calculateDebtValue`、`getUserTotalDebtValue` 等）。
  - 业务层不再做预言机健康检查与降级处理；避免重复事件与分叉逻辑。
- 典型调用
  - `getAssetValueWithFallback(priceOracle, asset, amount, DegradationConfig)`（view，只读缓存）；
  - `getAssetValueWithFallbackAndCache(...)`（non-view，允许写入缓存）；
  - 健康检查：`checkPriceOracleHealth(...)`（带/不带缓存配置两版）。
- 降级策略
  - 失败/过期/精度异常/价格不合理/稳定币脱锚时，返回 `PriceResult{ usedFallback=true, reason=..., value=... }`；上层（LE）可据此发事件或写系统统计（`DegradationCore` 提供系统级统计/事件）。

### 3) 端到端数据流（简述）
- 用户操作 → `VaultCore` → 业务编排 `VaultBusinessLogic`（转入/转出、抵押/保证金、奖励/撮合） → **统一结算/清算入口 `SettlementManager`**（还款/提前还款/到期处置/被动清算） → （内部）`LendingEngine` 更新债务账本 + `CollateralManager` 执行抵押释放/划转 → 写入成功后推送 `VaultRouter.pushUserPositionUpdate`（抵押来自 CM，债务来自 LE）与 `HealthView.pushRiskStatus` → 前端/机器人 0 gas 查询 View 层缓存。

- （撮合放款补充，资金链 SSOT）
  - 出借意向签名：`LendIntent.lenderSigner` 表示**签名者/资金提供者**（EOA 或 ERC-1271 合约钱包）。
  - 订单落地口径：`LoanOrder.lender` **固定写入** `LenderPoolVault`（资金池合约地址），**不允许**写入 EOA/多签出借人地址（签名者 ≠ lender 字段）。

### 4) 关键约束与最佳实践
- 健康因子与风险推送统一在 LE + View 层；业务层不再保留。
- 预言机访问与优雅降级仅在 LE 估值路径；避免业务层重复检查。
- 统一走 `VaultCore` → `LendingEngine` 的账本入口（`onlyVaultCore`），消除双入口与权限不一致；撮合/结算路径通过 `VaultCore.borrowFor(...)` 触达账本层。

---

### 清算模块实际实施（修订：直达账本 + 风控只读/聚合 + 单点推送）

- 写入直达账本：
  - 编排入口由 **`SettlementManager`** 触发（Registry 绑定 `KEY_SETTLEMENT_MANAGER`，**唯一对外写入口**）；当进入“被动清算/强制处置”分支时，由其内部调用 `LiquidationManager`（清算执行器）或直接直达账本执行扣押/减债。
  - 扣押抵押：直接调用 `KEY_CM → ICollateralManager.withdrawCollateralTo(user, collateralAsset, collateralAmount, liquidatorOrReceiver)`（扣减账本 + 真实转账）。
  - 减少债务：直接调用 `KEY_LE → ILendingEngineBasic.forceReduceDebt(user, asset, amount)`（或 `VaultLendingEngine.forceReduceDebt`）。
  - 事件单点推送：账本变更成功后，调用 `KEY_LIQUIDATION_VIEW → LiquidatorView.pushLiquidationUpdate/Batch`，链下统一消费。

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

### 业务流程（用户 → 账本 → 视图）
```
用户操作 → VaultCoreRefactored → VaultBusinessLogic（资金/抵押/保证金/奖励）
         → VaultCoreRefactored 统一调用 LendingEngine（borrow/repay）写账本
         → LendingEngine 推送 VaultRouter.pushUserPositionUpdate（仓位缓存）
         → LendingEngine 计算并推送 HealthView.pushRiskStatus（健康缓存）
         → 前端/机器人从 View 层免费查询
```

### 职责边界
- **VaultBusinessLogic（不再作为清算编排入口）**：
  - 代币转入/转出；抵押与保证金联动；唯一奖励触发；批量编排
  - 写入口必须收敛到“统一结算/清算入口”（见下节 `SettlementManager`），避免 repay/liquidate/settle 分叉
- **VaultCoreRefactored**：
  - 作为用户入口的转调者：借款可直达 `LendingEngine.borrow`；还款/结算必须统一进入 `SettlementManager`（见下节）
  - 不做代币二次转账（避免与业务层重复）
- **SettlementManager（新增，唯一写入口）**：
  - **唯一权威写入口（SSOT）**：统一承接 **按时还款结算 / 提前还款结算 / 到期未还处置 / 抵押价值过低触发的被动清算**
  - 内部根据状态机决定：
    - 正常结算：调用 `LendingEngine.repay` + 调用 `CollateralManager.withdrawCollateralTo` 将抵押直接返还给 B（borrower）
    - 被动清算：调用 `LiquidationManager`（或直接走 CM/LE 直达账本）对抵押进行扣押/划转，并在需要时触发残值分配模块
  - 对外接口建议以 “one entry” 命名：`repayAndSettle(...)` / `settleOrLiquidate(...)` / `executeLiquidation(...)`（其中任意一种对外暴露即可，保持唯一入口）
- **LendingEngine**：
  - 借/还/强制减债的账本更新；估值路径内的优雅降级
  - 账本变更后：`VaultRouter.pushUserPositionUpdate` + `HealthView.pushRiskStatus` + 最佳努力触发 `RewardManager.onLoanEvent`
  - `onlyVaultCore`：拒绝任何非 Core 的账本写入
- **View 层**：
  - `VaultRouter`：仓位缓存与事件/DataPush；聚合查询 0 gas
  - `HealthView`：健康因子/风险状态缓存与事件/DataPush

### 资金与抵押物去向（权威路径，必须遵守）

> 目的：把“钱/抵押物最终到谁”写成架构级口径（SSOT），避免仅在清算模块内描述而导致整体链路不完整。

- **出借资金托管（线上流动性池，SSOT）**
  - 线上流动性统一托管于 `LenderPoolVault`（Registry `KEY_LENDER_POOL_VAULT`），而非由 `VaultBusinessLogic` 自持余额，也不是把“真实出借人 EOA/多签”写入 `LoanOrder.lender`。
  - 出借人准备金（reserve）权威路径：`EOA/1271 lenderSigner` 先 `approve(VaultBusinessLogic)` → `VaultBusinessLogic.reserveForLending(lenderSigner, asset, amount, lendHash)`：
    - `VaultBusinessLogic` 将资金 `transferFrom(lenderSigner → LenderPoolVault)` 入池；
    - 同时记录 `lendHash` 的 reserve 状态（仅记录状态，防重放/可撤回）。
  - 撤回 reserve（未成交前）：`VaultBusinessLogic.cancelReserve(lendHash)` → `LenderPoolVault.transferOut(asset, lenderSigner, amount)` 返还。

- **撮合放款（borrow）与订单落地（SSOT）**
  - 成交落地权威路径：`VaultBusinessLogic.finalizeMatch(borrowIntent, lendIntents, sigBorrower, sigLenders)`：
    - 验签：`borrower` 与每个 `lendIntent.lenderSigner`（EOA 或 ERC-1271）；
    - 消耗 reserve：按 `lendHash` consume，对应 lenderSigner 必须匹配（防篡改/防重放）；
    - 放款：通过 `SettlementMatchLib.finalizeAtomicFull` 从 `LenderPoolVault.transferOut` 出金；
    - 手续费：通过 `FeeRouter.distributeNormal` 统一路由；
    - 订单：调用 `ORDER_ENGINE(LendingEngine).createLoanOrder` 创建 `orderId` 并铸造 `LoanNFT`；
    - **关键口径**：订单的 `LoanOrder.lender` 必须为 `LenderPoolVault` 地址（资金池），而非 `lenderSigner`。
  - 权限/配置要点（测试与部署必须满足）：
    - `VaultBusinessLogic` 需要 `ACTION_ORDER_CREATE`（创建订单）；
    - `VaultBusinessLogic` 需要 `ACTION_DEPOSIT`（调用 `FeeRouter.distributeNormal`）；
    - `ORDER_ENGINE` 需要 `ACTION_BORROW`（`LoanNFT` 的 MINTER 权限映射到 `ACTION_BORROW`）；
    - `FeeRouter` 需要将 `settlementToken` 标记为 supported token（否则 `TokenNotSupported`）。

- **抵押物托管（统一资金池）**
  - 抵押物（含多品类 RWA）由 `CollateralManager` 作为托管者持有（真实资产池/资金池）。
  - `deposit/withdraw` 的权威写路径为：`VaultCore/VaultRouter → CollateralManager.depositCollateral/withdrawCollateral`（用户自己提取）。
- **还款（repay）与“抵押释放/返还”的权威路径（修订：统一结算入口）**
  - **唯一权威写入口**：`VaultCore.repay(orderId, asset, amount) → SettlementManager.repayAndSettle(user, asset, amount, orderId)`（`orderId` 为仓位主键，SSOT）。
  - `SettlementManager` 在同一条链路内完成：
    - `LendingEngine.repay(...)`（更新债务账本）
    - 基于风控/到期/订单状态机决定：
      - **按时还款/提前还款**：调用 `CollateralManager.withdrawCollateralTo(user, collateralAsset, amount, user)` 将抵押直接返还到 **B（borrower）** 钱包（无需用户二次 `withdraw`）
      - **到期未还/价值过低**：转入被动清算分支（见下文“清算（违约）时抵押去向”与 `SettlementManager` 章节）
- **清算（违约）时抵押去向（修订：统一结算入口）**
  - **默认入口**：keeper/机器人应通过 `SettlementManager.settleOrLiquidate(orderId)` 触发处置，由其在满足触发条件时进入清算分支（避免“参数计算/权限/资金去向”分叉）。
  - **兼容/执行器入口（可选，role-gated）**：`LiquidationManager.liquidate/batchLiquidate` 仍可作为“显式参数的清算执行器入口”保留，
    仅供测试/应急/手工清算使用（需要 `ACTION_LIQUIDATE`），不建议作为常态 keeper/前端入口。
  - 清算扣押/划转的权威写路径为（两种实现等价其一即可）：
    - `SettlementManager → LiquidationManager → CollateralManager.withdrawCollateralTo(...)`（保持 LiquidationManager 作为清算执行器）
    - 或 `SettlementManager → CollateralManager.withdrawCollateralTo(...)`（直达账本，不经过 LiquidationManager）
  - 并在需要时由残值分配模块进一步路由到平台/准备金/出借人/清算人等接收方。
- **平台费/罚金/手续费等“费用类资金”的权威去向**
  - 费用类资金（如平台费、生态费、罚金中平台份额等）应通过 `FeeRouter` 进行统一路由与分发；前端/链下只读镜像由 `FeeRouterView` 提供。
  - 为降低“人为变数”，推荐将 `FeeRouter` 的 `platformTreasury` 配置为**合约金库地址**（而非 EOA/多签），并通过治理权限（通常为 `ACTION_SET_PARAMETER` / `ACTION_UPGRADE_MODULE`，建议迁移到 Timelock 轨）进行变更。

### 配置要点
- Registry 必须正确指向：`KEY_VAULT_CORE`、`KEY_LE`、`KEY_CM`、`KEY_HEALTH_VIEW`、`KEY_RM`、`KEY_SETTLEMENT_MANAGER`
- `LendingEngine.onlyVaultCore` 校验的 Core 地址与实际 Core 部署一致
- `LendingEngine` 配置 `priceOracle`、`settlementToken` 正确，以启用优雅降级

---

## 统一结算/清算写入口（SettlementManager）（新增，SSOT）

### 目标
- 将 **按时还款、提前还款、到期未还、抵押价值过低导致的被动清算** 统一收敛到一个对外写入口，避免“repay 与 liquidate 分叉、资金去向分叉、权限分叉”。

### 实施总纲（强烈建议先读）
> 为避免实现与文档口径分叉，`SettlementManager` 的完整整改路径（模块键、接口建议、迁移步骤、测试清单）已整理为 SSOT 总纲文档：
>
> - [`docs/Usage-Guide/Liquidation/SettlementManager-Refactor-Plan.md`](../Usage-Guide/Liquidation/SettlementManager-Refactor-Plan.md)

### 统一入口（建议）
- `repayAndSettle(user, debtAsset, repayAmount, orderId)`：用户 B 发起还款后，**必经 SettlementManager**，由其完成减债与抵押释放/处置（`orderId` 为仓位主键）。
- `settleOrLiquidate(orderId)`（可选）：keeper/机器人触发的“到期/风控检查后处置”入口（内部自动判定结算或清算，并计算清算参数；`orderId` 为仓位主键）。

### 状态机分支（概念口径）
- **提前还款/按时还款**：
  - 记账：`LendingEngine.repay(...)`
  - 释放抵押：`CollateralManager.withdrawCollateralTo(..., borrowerAddr)`（抵押直接回 B 钱包）
  - 费用/罚金：走 `FeeRouter` 统一路由到 `platformTreasury`（推荐配置为合约金库地址）
- **拖欠/价值过低（被动清算）**：
  - 扣押抵押：`CollateralManager.withdrawCollateralTo(..., receiver)`（receiver 由清算分支决定）
  - 减少债务：`LendingEngine.forceReduceDebt(...)`（或等效强制减债路径）
  - 事件单点推送：仍由 `LiquidatorView.pushLiquidationUpdate/Batch` 作为链下消费的单点入口
  - 残值分配：如启用 `LiquidationPayoutManager`，则按比例路由到平台/准备金/出借人/清算人等

### 与 LiquidationManager 的关系（回答你的问题）
- **“统一走 LiquidationManager”不太符合语义**：LiquidationManager 更适合作为“违约处置/强制清算执行器”，而不是把正常还款也当作 liquidation。
- 推荐结构（B）：**SettlementManager 为 keeper/用户侧的默认对外入口**；`LiquidationManager` 作为其内部的“清算执行器模块”（直达账本 + 单点事件推送）。
  - 兼容：在具备 `ACTION_LIQUIDATE` 权限时，仍允许直接调用 `LiquidationManager.liquidate/batchLiquidate` 做“显式参数清算”（测试/应急），但不建议作为常态入口。


---

## 清算写入直达账本（专章）

### 目标
- 将清算写入（扣押抵押物、减少债务）统一直达账本层（`CollateralManager`/`LendingEngine`），由账本模块内部进行权限校验与状态更新；View 仅承担只读/缓存/聚合与事件/DataPush。

### 设计
- 入口方：**`Registry.KEY_SETTLEMENT_MANAGER` 指向 `SettlementManager`（唯一对外写入口）**。当进入清算分支时：
  - `SettlementManager` 可调用 `Registry.KEY_LIQUIDATION_MANAGER → LiquidationManager` 作为清算执行器（推荐保留以承接清算参数校验/事件推送的聚合），或
  - `SettlementManager` 也可直接直达账本调用 `KEY_CM/KEY_LE` 完成扣押/减债（与“直达账本”原则一致）。
- 路由：
  - 扣押抵押：`KEY_CM → ICollateralManager.withdrawCollateralTo(user, collateralAsset, collateralAmount, liquidatorOrReceiver)`。
  - 减少债务：`KEY_LE → ILendingEngineBasic.forceReduceDebt(user, asset, amount)` 或 `VaultLendingEngine.forceReduceDebt`。
- 权限：由被调账本模块在内部进行 `ACM.requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender)` 等校验；不通过 View 放行写入。
- 事件与 DataPush：清算完成后，由 `LiquidatorView.pushLiquidationUpdate/Batch` 单点推送；View 层不承载写入转发。

### 与前端/服务的集成
- 前端查询读取 `LiquidationRiskManager`/`LiquidatorView` 与 `StatisticsView`；写路径统一由 `SettlementManager` 承接（其内部在清算分支直达账本或调用 `LiquidationManager` 清算执行器）。
- 地址解析建议：
  - 只读入口：通过 `KEY_VAULT_CORE → viewContractAddrVar()` 解析 View 地址；
  - 写入入口：通过 Registry 获取 `KEY_SETTLEMENT_MANAGER`（唯一对外写入口）；清算执行器与账本模块地址通过 Registry 获取 `KEY_LIQUIDATION_MANAGER`/`KEY_CM`/`KEY_LE`。

### 测试要求（修订）
- 用例覆盖：
  - 非授权直接调用 `CollateralManager.withdrawCollateral` 与 `LendingEngine.forceReduceDebt` 必须回滚（权限校验在账本层）。
  - 通过 `LiquidationManager` 发起时，账本写入成功且 `LiquidatorView.push*` 被触发；
  - 不依赖具体清算算法；仅验证路由、权限与单点事件/DataPush 原则。
- 参考：将 `LiquidationViewForward` 测试替换为 `LiquidationDirectLedger.test.ts` 骨架。

### 迁移与兼容
- 若历史代码为"经 View 转发写入"，应迁移到"直达账本"：
  - 清算写入改为直接调用 `KEY_CM/KEY_LE`；
  - 事件/DataPush 保持由 `LiquidatorView.push*` 单点触发；
  - 保留只读 Aggregation 在 `LiquidationRiskManager`/`LiquidationView`。

---

## 清算残值分配模块（专章）

### 目标
- 清算执行后，抵押物残值（抵押物价值 - 债务价值）需要按比例分配给多个角色：平台、风险准备金、出借人补偿、清算人奖励。
- 通过独立的 `LiquidationPayoutManager` 模块实现可治理的分配配置，符合"清算逻辑内聚、配置可治理"的架构原则。

### 设计
- **模块定位**：`Registry.KEY_LIQUIDATION_PAYOUT_MANAGER` 指向 `LiquidationPayoutManager`，作为清算残值分配的配置与执行模块。
- **分配角色与默认比例**：
  - 平台（platform）：默认 3% (300 bps) 用于运营/手续费
  - 准备金（reserve）：默认 2% (200 bps) 用于风险准备金/保险金
  - 出借人补偿（lender compensation）：默认 17% (1700 bps)，应支付给当前实际出借人
  - 清算人（liquidator）：默认 78% (7800 bps)，并接收整数除不尽的余数
  - 比例总和需为 10,000 bps，可在部署后由有 `ACTION_SET_PARAMETER` 权限的角色调整
- **地址配置策略**：
  - **方案 A（与本仓资金池口径一致，推荐）**：平台/准备金使用固定金库地址；出借人补偿地址设置为 `LenderPoolVault`（按本指南口径 `LoanOrder.lender` 固定为资金池地址），由资金池在协议内再进行份额/记账归属（或作为后续扩展的路由入口）。
  - **方案 B（出借人前置路由）**：平台/准备金同上；出借人补偿设置为"路由/分发合约"（该合约可根据 `orderId`/仓位关系把补偿再分发给实际出借人/份额持有人）。
  - **方案 C（仅用于本地/快速演示）**：平台/准备金/出借人补偿都用部署者地址占位，便于本地或测试链快速跑通；上线前必须替换为方案 A/B。
- **治理与升级**：
  - 收款地址与比例可通过 `updateRates` / `updateRecipients` 由 `ACTION_SET_PARAMETER` 角色调整
  - 通过 Registry 解析模块地址，前端读取自动生成的 `frontend-config/contracts-*.ts`
- **事件与 DataPush**：
  - 分配事件已通过 `LiquidatorView` 以 DataPush 形式上链，便于前端/离线服务消费

### 与清算流程的集成
- 清算执行流程：`SettlementManager` 进入清算分支 → 调用 `LiquidationManager`（执行器）→
  直达账本执行：扣押/划转抵押（`CM.withdrawCollateralTo`）与减少债务（`LE.forceReduceDebt`）→
  使用 `LiquidationPayoutManager`（SSOT）读取 recipients/rates 并计算 shares →
  由执行器将抵押按份额路由到平台/准备金/出借人补偿接收者/清算人。
- 残值/份额计算：在当前实现中以“被扣押的抵押数量（collateralAmount）”作为分配基数，
  份额计算由 `LiquidationPayoutManager.calculateShares` 提供，整数除不尽的余数归清算人。
- 分配执行：由清算执行器（`LiquidationManager`，或未来可由 `SettlementManager` 直达账本）调用
  `CollateralManager.withdrawCollateralTo` 完成实际转账；`LiquidationPayoutManager` 作为配置/计算模块不直接转账。

### 部署与配置
- **环境变量**（三网脚本均可用）：
  - `PAYOUT_PLATFORM_ADDR`：平台收款地址（建议多签）
  - `PAYOUT_RESERVE_ADDR`：准备金收款地址（建议多签）
  - `PAYOUT_LENDER_ADDR`：出借人补偿地址（方案 A 可留空，方案 B 填路由合约地址）
- **部署脚本**：`deploylocal.ts` / `deploy-arbitrum.ts` / `deploy-arbitrum-sepolia.ts` 会读取上述 env，部署 `LiquidationPayoutManager` 并在 Registry 注册 `KEY_LIQUIDATION_PAYOUT_MANAGER`
- **默认行为**：若未提供 env，脚本会回退为 deployer 地址（仅适合本地/演示）

### 详细实施指南
> 📖 **详细配置说明、推荐落地步骤、方案选择建议等，请参考**：[`docs/Usage-Guide/Liquidation/Liquidation-Payout-Address-Guide.md`](../Usage-Guide/Liquidation/Liquidation-Payout-Address-Guide.md)

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
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npx hardhat test --network hardhat
```



### 统计模块迁移说明（重要）
- 阶段一（当前）：保留 `KEY_STATS`，并将其映射到 `StatisticsView`。`StatisticsView` 在 View 层承接“全局统计”的状态存储与写接口（`pushUserStatsUpdate`、`pushGuaranteeUpdate`、`recordSnapshot`），提供只读聚合（`getGlobalSnapshot`）。
- 活跃用户计数规则：严格以“仓位>0（collateral>0 或 debt>0）”为活跃判定。
- 兼容性：为便于平滑迁移，`StatisticsView` 暴露与旧接口兼容的 `updateUserStats`/`updateGuaranteeStats`，内部转调新 `push*` 接口。
- 阶段二（后续）：统一地址解析到 `KEY_VAULT_CORE -> viewContractAddrVar()`，逐步去除对 `KEY_STATS` 的依赖；清理 `VaultStatistics.sol` 与 `IVaultStatistics.sol` 遗留。

---

## 📊 双架构优化效果

### **代码量对比**
| 功能 | 当前行数 | 双架构行数 | 变化比例 | 状态 |
|------|----------|------------|----------|------|
| **VaultCore** | 299 行 | **142 行** | **52%** | ✅ 已完成 |
| **VaultRouter** | 200+ 行 | **442 行** | **+121%** | 🔄 进行中 |
| **AccessControlView** | 407 行 | ~350 行 | **14%** | 🔄 待实现 |

### **Gas 消耗对比**
| 操作 | 当前 Gas | 双架构 Gas | 节省比例 | 状态 |
|------|----------|------------|----------|------|
| **查询操作** | ~2,000 gas | **0 gas** | **100%** | ✅ 已实现 |
| **权限更新** | ~50,000 gas | ~21,000 gas | **58%** | 🔄 待实现 |
| **位置更新** | ~50,000 gas | ~25,000 gas | **50%** | 🔄 待实现 |
| **模块升级** | ~30,000 gas | ~20,000 gas | **33%** | ✅ 已实现 |

### **用户体验对比**
| 指标 | 双架构方案 | 纯事件驱动 | 传统缓存 | 状态 |
|------|------------|------------|----------|------|
| **查询响应时间** | **< 100ms** | ~500ms | **< 100ms** | ✅ 已实现 |
| **数据实时性** | **实时** | **实时** | 5分钟延迟 | 🔄 进行中 |
| **查询成本** | **免费** | **免费** | **免费** | ✅ 已实现 |
| **AI分析支持** | **完整** | **完整** | 部分支持 | 🔄 待实现 |

---

## 🔧 双架构命名规范要求

### **必须遵循的命名规范（SmartContractStandard.md第127行）**
```solidity
// 私有状态变量：_ + camelCase
address private _registryAddr;
mapping(address => mapping(bytes32 => bool)) private _userPermissionsCache;

// 公共状态变量：camelCase + Var（避免与getter冲突）
address public registryAddrVar;
bool public isActiveVar;

// 不可变变量：camelCase + Addr
address public immutable vaultManagerAddr;

// 函数参数：camelCase，语义化前缀
function initialize(address initialRegistryAddr)
function pushPermissionUpdate(address user, bytes32 actionKey, bool hasPermission)
function getUserPermission(address user, bytes32 actionKey)

// 事件名：PascalCase，过去时态
event PermissionDataUpdated(address indexed user, bytes32 indexed actionKey, bool hasPermission, uint256 timestamp);
event UserOperation(address indexed user, bytes32 indexed operationType, address asset, uint256 amount, uint256 timestamp);

// 错误名：PascalCase with __ 前缀
error AccessControlView__ZeroAddress();
error AccessControlView__UnauthorizedAccess();
```

---

## 📝 NatSpec 注释规范（必须）

> 目标：让所有对外接口（尤其是写入入口）的“语义、回滚条件、安全属性、参数单位”可被链下与审计工具直接消费，避免口径分叉。

### 适用范围
- **必须**：所有 `public/external` 的函数与错误/事件（尤其是会写状态、转账、升级、权限校验、跨模块调用的入口）。
- **建议**：关键 `internal` 逻辑（状态机分支、金额计算、精度/单位转换、外部调用封装）。

### 统一模板（推荐顺序，禁止乱序）
> 说明：`@dev` 中的 “Reverts if / Security” 采用固定小节标题，便于团队与工具一致解析。

```solidity
/**
 * @notice <一句话说明：做什么、对谁/哪条路径生效>
 * @dev Reverts if:
 *      - <回滚条件 1>
 *      - <回滚条件 2>
 *
 * Security:
 * - <安全属性 1：例如 Non-reentrant>
 * - <安全属性 2：例如 Signature is single-use / onlyVaultCore / role-gated>
 *
 * @param <name> <参数语义 + 单位/精度/取值范围（如 6 decimals / bps / seconds）>
 * @return <name> <返回值语义 + 单位/精度（如有）>
 */
```

### 写法要求（强制）
- **`@notice`**：必须是“可对外公开的业务语义”，避免实现细节；用一句话讲清楚“做什么 + 影响对象/路径”。
- **`@dev`**
  - **Reverts if**：列出**所有可预期的回滚原因**（含权限、签名、白名单、状态机不匹配、金额/精度、过期、重复使用等）。  
    - 每条用 `- ` 开头；条件尽量与代码中的 `error`/`revert` 保持同名或同义，避免“文档写 A、代码回滚 B”。
  - **Security**：显式标注本函数依赖的安全属性/假设（如 `nonReentrant`、`onlyVaultCore`、`ACM.requireRole(...)`、签名单次使用、nonce/uid 绑定、跨模块调用边界等）。
- **`@param/@return`**：必须写清楚**单位与精度**（例如 USDT 6 decimals、bps=1e4、时间=seconds、价格精度等）；涉及“内部 ID / 外部地址”的必须区分含义（如 `uid` vs `user`）。
- **一致性**：注释中的“唯一入口/权威路径/SSOT”描述必须与本指南其它章节一致；不一致时以本指南为准并立即修订注释或章节说明。

### 检测方式（强制）
> 目标：把“注释规范 + 关键风格约束”变成可重复、可自动化的检查步骤，避免靠人工肉眼抽查。

#### 1) 编译级校验（必须）
- **目的**：确保 NatSpec/代码改动不会引入语法、依赖、类型问题。

```bash
pnpm -s run compile
```

#### 2) 单文件/目录级 Solhint（必须）
- **目的**：强制 `NatSpec` 结构化输出、禁止全局 import、限制行宽、禁止 `require/revert("...")` 等不一致模式。
- **推荐**：改动某个文件时先跑单文件；合并前对目标目录跑一次。

```bash
# 单文件检查
pnpm -s exec solhint "src/Vault/liquidation/modules/LiquidationManager.sol"

# 目录检查（示例：liquidation libraries）
pnpm -s exec solhint "src/Vault/liquidation/libraries/*.sol"
```

#### 2.1) Solhint 规则分层（推荐：安全/一致性必过 + Gas 持续优化 + 文档不刷屏）
> 背景：Solhint 新版本会引入更多“建议型”规则。为避免信噪比过低，本项目将规则分为三档。

- **A. 安全/一致性（必须为 error）**：阻断合并/上线，确保链上安全与一致性。
  - 示例：`avoid-tx-origin`、`avoid-low-level-calls`、`reentrancy`、`no-inline-assembly`、`not-rely-on-time`、`gas-custom-errors`、`no-global-import`、`max-line-length`、`compiler-version`。
- **B. Gas 优化（建议为 warn，持续可见）**：不影响功能正确性，但能在现有框架下持续降低 gas。
  - 示例：`gas-increment-by-one`（循环 `++i`）、`gas-strict-inequalities`（用严格不等）、`gas-indexed-events`（合理增加 indexed）。
- **C. 文档/可读性（建议按需启用）**：避免大量文档告警淹没真正问题；建议在“文档完善阶段”再启用。
  - 示例：`use-natspec`、`function-max-lines`。

#### 2.2) “极致 gas/审计模式”（可选）
> 目标：在不阻塞日常开发的前提下，提供一次性“更严格”的检查入口，用于上线前/审计前集中清理。

- **推荐方式**：在仓库中保留一份更严格的 solhint 配置（例如 `.solhint.perfection.json`），将 **B 类 gas 规则提升为 error**，并按需打开 **C 类文档规则**。
- **运行示例**：

```bash
pnpm -s exec solhint --config ".solhint.perfection.json" "src/Vault/liquidation/libraries/*.sol"
```

#### 3) 关键路径测试（必须，至少选一条“最贴近改动”的用例集）
- **目的**：验证回滚条件/原子性/权限/事件等行为与 NatSpec 描述一致。

```bash
# 示例：清算相关 failure & edge scenarios
pnpm -s exec hardhat test "test/Vault/liquidation/Liquidation.failure-scenarios.test.ts"
```

#### 4) 允许的“最小范围规则豁免”（仅用于通过工具误报/缓存场景）
> 原则：**能重构消除就不要 disable**；必须 disable 时，**只对单行**使用 `solhint-disable-next-line`，并说明理由。

- **`not-rely-on-time`**：业务决策不得依赖时间；但“写入/上报时间戳”属于可接受的审计信息记录。

```solidity
// solhint-disable-next-line not-rely-on-time
record.timestamp = block.timestamp;
```

- **`no-inline-assembly`**：默认禁止内联汇编；仅在“无法用 Solidity 等价实现且可审计”的极少数场景允许。

```solidity
// solhint-disable-next-line no-inline-assembly
assembly {
    // ... minimal, well-audited assembly ...
}
```

### 示例：带签名授权的 USDT 代存（标准样式）
```solidity
/**
 * @notice Deposit USDT on behalf of a user.
 * @dev Reverts if:
 *      - token != USDT
 *      - signature is invalid
 *      - uid is not bound
 *
 * Security:
 * - Non-reentrant
 * - Signature is single-use
 *
 * @param uid Internal user identifier
 * @param amount Amount of USDT to deposit (6 decimals)
 * @param signature Backend-signed authorization
 */
function deposit(
    uint256 uid,
    uint256 amount,
    bytes calldata signature
) external nonReentrant {
    // ...
}
```

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
* `dataTypeHash` 为 **keccak256("UPPER_SNAKE_CASE")** 常量。  
* `payload` 使用 ABI 编码的结构体，结构体定义在各业务模块中。

### Library Usage
```
import { DataPushLibrary } from "contracts/libraries/DataPushLibrary.sol";
bytes32 constant DATA_TYPE_EXAMPLE = keccak256("EXAMPLE");
...
DataPushLibrary._emitData(DATA_TYPE_EXAMPLE, abi.encode(param1, param2));
```

### Migration Plan
1. 为所有 push* 函数增加 `DataPushLibrary._emitData(...)` 调用；旧事件保留并加注 `// DEPRECATED`。  
2. 前端 / Off-chain 服务仅订阅 `DataPushed`。

### View 层实现一致性（整体描述）
- **目标**：确保所有 View 模块在“只读/缓存/聚合 + 统一 DataPush + 可升级”三个维度与本指南一致，便于前端/机器人统一接入、链下统一订阅、以及后续安全升级。
- **最小实现基线（必须）**：
  - **UUPS 安全基线**：实现合约包含 `constructor { _disableInitializers(); }`，并保留 `uint256[50] __gap;`；`_authorizeUpgrade` 做权限校验与零地址检查。
  - **版本化基线（C+B）**：所有 `src/Vault/view/modules/*.sol` 必须暴露统一版本信息入口：
    - `getVersionInfo() -> (apiVersion, schemaVersion, implementation)`
    - `apiVersion` 表达对外 API 语义版本；`schemaVersion` 表达缓存/输出结构版本（字段/编码/解释变化时递增）
    - `implementation` 用于链下定位当前实现地址（代理场景下可直接识别实现）
    - **关键模块可采用 A 策略**：保留旧事件/旧入口并新增 `*V2/*V3` 事件或接口以平滑迁移（例如 `PositionView` 的 `UserPositionCachedV2`）
  - **统一 DataPush**：所有 `push*` 写路径必须调用 `DataPushLibrary._emitData(...)`；`dataTypeHash` 使用 **集中常量**（`DataPushTypes` / `keccak256("UPPER_SNAKE_CASE")`），避免散落重复定义。
  - **批量限制**：所有批量查询/批量推送统一使用 `ViewConstants.MAX_BATCH_SIZE` 并在入口校验长度，避免 RPC/执行失败。
  - **错误风格**：优先使用自定义 error（例如 `ContractName__Xxx`）或 `StandardErrors`，避免字符串 `require/revert`（更省 gas、链下更易解码）。
- **读权限策略（原则）**：
  - **默认推荐**：关键查询接口保持 0 gas 可读以服务前端/机器人。
  - **可选增强**：出于隐私/商业策略可对部分只读接口加 role gate，但应在实施前评估对前端/机器人 `eth_call` 的影响（详见“健康因子”章节中的读权限策略说明）。

## Reward 模块架构与路径

### 目标
- 严格以“落账后触发”为准：仅当账本在 `LendingEngine` 成功更新后，才触发积分计算/发放。
- 只读与写入分层：`RewardManager/RewardManagerCore` 负责计算、发放与扣减；`RewardView` 负责只读缓存与统一 DataPush。

### 职责分工（建议统一口径）
- **RewardManager（Earn gateway）**：借贷触发的奖励写入口门面 + 参数治理入口（仅 `KEY_LE` 可调用写入口；治理权限走 ACM）。
- **RewardManagerCore（Earn core）**：发放与惩罚核心（锁定/释放/欠分账本/等级统计；向 `RewardView` 推送）。
- **RewardConsumption（Spend gateway）**：用户消费对外入口（对外入口 + 批量入口；转发到 `RewardCore`；在 `RewardView.onlyWriter` 白名单内，负责消费侧推送）。
- **RewardCore（Spend core）**：消费核心（服务购买/升级、消费记录、特权状态；业务逻辑核心，不推荐作为对外统一入口）。
- **RewardView**：统一只读 + 统一 DataPush（链下订阅与前端查询入口；writer 白名单严格限制）。

### 唯一路径（强约束）
1. 业务编排：`VaultBusinessLogic` 完成业务流程（不触发奖励）。
2. 账本落账：`LendingEngine` 在 borrow/repay 成功后触发：
   - `IRewardManager.onLoanEvent(address user, uint256 amount, uint256 duration, bool flag)`
   - **现行语义**：`flag` 在 `LendingEngine` 内部计算为 `isOnTimeAndFullyRepaid`（按期且足额还清）。历史上该参数名为 `hfHighEnough`，请以当前调用方语义为准。
3. 积分计算/发放：`RewardManager` → `RewardManagerCore`：
   - **当前链上基线**：borrow（`duration>0`）锁定 1 积分；repay（`duration=0 && flag=true`）释放锁定积分并铸币；否则走提前/逾期扣罚（不足则记入 `penaltyLedger`）。
   - **可配置/可演进部分**：`RewardManagerCore.calculateExamplePoints(...)` 保留公式/参数（等级倍数、动态奖励、bonusBps 等）用于模拟与后续升级，但当前 `onLoanEvent` 主路径采用固定 1 积分的锁定-释放模型。
   - 先用积分抵扣欠分账本 `penaltyLedger`（若存在），剩余部分通过 `RewardPoints.mintPoints` 发放。
4. 只读与 DataPush：由 `RewardView` 内部统一 `DataPushLibrary._emitData(...)`：
   - **发放（Earn）侧**：`RewardManagerCore` 调用 `RewardView.push*`（writer 白名单）
   - **消费（Spend）侧**：`RewardConsumption` 调用 `RewardView.push*`（writer 白名单）
   - 说明：历史表述曾写为“`RewardManagerCore/RewardCore` 成功后调用 `RewardView.push*`”；现已按 `RewardView.onlyWriter` 白名单修正为：**消费侧由 `RewardConsumption` 推送**，避免读者误解。
  - `REWARD_EARNED` / `REWARD_BURNED` / `REWARD_LEVEL_UPDATED` / `REWARD_PRIVILEGE_UPDATED` / `REWARD_STATS_UPDATED` / `REWARD_PENALTY_LEDGER_UPDATED`。

### 权限与边界
- `RewardManager.onLoanEvent(address,int256,int256)`：**已移除**（统一入口，避免语义不确定）。
- `RewardManager.onLoanEvent(address,uint256,uint256,bool)`：仅允许 `KEY_LE` 调用（标准入口）。
- `RewardView` 写入白名单：仅 `RewardManagerCore` 与 `RewardConsumption`。查询对外 0 gas。
- `RewardPoints` 的 mint/burn 仅授予 `RewardManagerCore`，外部消费通过 `RewardCore/RewardConsumption` 路径进行。

### 按期窗口（实现口径）
- “按期且足额还清”的权威判断发生在 `LendingEngine`，当前固定 `ON_TIME_WINDOW = 24 hours`。
- `RewardManager.setOnTimeWindow(...)` 当前用于惩罚路径中“提前/逾期”的窗口判定，并不改变 `LendingEngine` 的按期判断。

### 模块键（ModuleKeys）
- `KEY_RM`：RewardManager
- `KEY_REWARD_MANAGER_CORE`：RewardManagerCore
- `KEY_REWARD_CONSUMPTION`：RewardConsumption
- `KEY_REWARD_VIEW`：RewardView（新增，只读视图 + 统一 DataPush）

### 前端/链下对接
- 订阅 `DataPushed` 事件，过滤上述 `DATA_TYPE_REWARD_*`（含 `REWARD_PENALTY_LEDGER_UPDATED`）。
- 说明：`penaltyLedger`（欠分账本）更新使用独立 `REWARD_PENALTY_LEDGER_UPDATED`，避免与 `REWARD_STATS_UPDATED`（系统统计）复用导致 payload 冲突。
- 仅访问 `RewardView` 只读接口：
  - `getUserRewardSummary(user)`
  - `getUserRecentActivities(user, fromTs, toTs, limit)`（分页/窗口）
  - `getSystemRewardStats()`
  - `getTopEarners()`
  - **禁止/不要**在前端/链下直接调用 `RewardManagerCore` 的 `getUserLevel/getRewardParameters/getUserCache/...` 等查询接口：这些接口仅为协议内硬约束（例如 `LendingEngine` 的长周期期限门槛）与 `RewardView` 透传保留，视为 **DEPRECATED for external consumers**。

### 重要差异
- 不再从 `VaultBusinessLogic` 触发奖励；批量库（`VaultBusinessLogicLibrary`）完全移除奖励相关逻辑。
- 所有奖励以 `LendingEngine` 落账后的唯一入口触发，保证状态一致性。

### 入口收紧（强制规范，必须遵守）
- 唯一路径：`LendingEngine` 成功落账后调用 `RewardManager.onLoanEvent(address,uint256,uint256,bool)`，再由 RM 调用 `RewardManagerCore`。
- **V2 按订单路径**：若上游已对接订单级回调，可调用 `RewardManager.onLoanEventV2(user, orderId, amount, maturity, outcome)`（outcome: 0=Borrow,1=RepayOnTimeFull,2=RepayEarlyFull,3=RepayLateFull），RM 再转发至 `RewardManagerCore.onLoanEventV2` 实现“多订单独立锁定/结算”。
- 本金门槛：`RewardManagerCore` 已在 `onLoanEvent / onLoanEventV2` 强制 `amount < 1000 USDC` 不计分/不锁定；如需调整，请同步修改合约与测试并更新说明。
- `RewardManagerCore.onLoanEvent` 与 `onBatchLoanEvents` 不再接受外部直接调用：
  - 调用白名单仅限 `RewardManager`；否则将触发自定义错误 `RewardManagerCore__UseRewardManagerEntry`；
  - 同时发出 `DeprecatedDirectEntryAttempt(caller,timestamp)` 事件用于链下审计迁移；
  - 旧入口 `RewardManager.onLoanEvent(address,int256,int256)`：**已移除**，全局入口统一为 `RewardManager.onLoanEvent(address,uint256,uint256,bool)`。

### 迁移说明（对脚本/测试的影响）
- 任何直接调用 `RewardManagerCore.onLoanEvent` 的脚本或测试都会失败。请统一改为：`LendingEngine → RewardManager → RewardManagerCore` 路径。
- 测试改动：新增断言“直接调用 RMCore 将 revert（`RewardManagerCore__UseRewardManagerEntry`）”。
- 前端/服务端仅订阅 `DataPushed` 事件，过滤 `DATA_TYPE_REWARD_*`，不再依赖旧的链下解析路径。

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
1) 前端对名称进行本地规范化（trim + lowercase + 校验字符集 `[a-z0-9_-]`，长度 3~50）。
2) 计算 `nameHash = keccak256(normalizedName)`。
3) 调用 `RegistryDynamicModuleKey.getNameHashToModuleKey(nameHash)` 拿 `moduleKey`。
4) 调用 `Registry.getModuleOrRevert(moduleKey)` 获取目标合约地址。

以上路径减少了在链上进行字符串处理的成本，事件监听侧也可以用 `ModuleKeyRegistered(moduleKey, nameHash, registrant)` 直接反查。

### Gas 与体积优化（已实施）
- 生成键：使用常量盐 + `abi.encodePacked`，避免拼接歧义并降低 gas/字节码。
- 规范化与校验：合并为单次遍历 `_normalizeAndValidate`，一次完成 trim/小写/校验；移除冗余双重循环。
- 事件精简：`ModuleKeyRegistered` 去除 `timestamp` 与动态字符串 `name`；`ModuleKeyUnregistered` 去除 `timestamp`、保留 `name` 便于链下快速消费。
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
 
 ---
 
 ## 🧱 存储模式与布局策略（新增）
 
 ### 目标与原则
 - **统一性**：同一“家族模块”共享同一份状态，避免多实现切换时的数据漂移。
 - **可升级性**：全面采用 UUPS 升级范式，保留 `__gap`，兼容 OZ 工具链。
 - **解耦性**：除共享状态的家族外，其它模块保持本地私有存储，降低耦合与升级半径。
 
 ### 双轨策略
 1) Registry 家族（共享状态，库式统一存储）
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
 
 2) View / 业务模块（独立状态，本地存储 + UUPS）
 - **适用**：`VaultRouter`、`AccessControlView`、`StatisticsView`、`RewardView`、`LiquidatorView` 等 View；以及 `CollateralManager`、`LendingEngine`、`FeeRouter` 等业务模块与周边组件。
 - **技术要点**：
   - 本地私有状态变量（命名 `_camelCase`），公开变量以 `camelCaseVar` 命名，保留 `__gap`。
   - 统一通过 `Registry.getModuleOrRevert(KEY_VAULT_CORE)` → `IVaultCoreMinimal.viewContractAddrVar()` 解析 View 地址。
   - 写入层推送到 View（事件驱动 + 缓存刷新），查询统一走 View（0 gas）。
   - 避免与 Registry 共用同一槽位，减少跨模块升级耦合。
 - **迁移/校验清单**：
   - 升级只需保证本模块状态兼容（`__gap` 未破坏）；无需考虑 Registry 家族的共享状态。
   - 仅当需要横向共享时才考虑库式存储；默认保持本地存储。
 
 ### 模块映射建议
 - **库式统一存储（共享状态）**：Registry 家族（上文列举）。
 - **本地存储 + UUPS（独立状态）**：
   - View 层：`VaultRouter`、`PositionView`、`UserView`、`HealthView`、`StatisticsView`、`ViewCache`、`AccessControlView`、`BatchView`、`RegistryView`、`SystemView`、`CacheOptimizedView`、`RewardView`、`LiquidatorView`，以及可选的 `DashboardView`、`PreviewView`、`RiskView`、`ValuationOracleView`、`FeeRouterView`、`LendingEngineView`、`ModuleHealthView`、`EventHistoryManager`、`LiquidationRiskView` 等。
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

1) **编译级校验（必须）**
```bash
pnpm -s run compile
```

2) **禁止项扫描（必须为 0 结果）**
```bash
# 禁止：依赖 msg.sender 作为 owner 来源
rg "__Ownable_init\\(msg\\.sender\\)" src -g"*.sol"
```

3) **必要项抽样（必须可检出）**
```bash
# 至少应能在 OwnableUpgradeable 合约里检出显式 owner 注入（按需改为你的参数名）
rg "__Ownable_init\\(\\s*initialOwner\\s*\\)" src -g"*.sol"
```

4) **零地址校验（必须可检出/或由 lint 规则覆盖）**
```bash
# 允许自定义错误/不同参数名；至少应存在对 owner 入参的非零校验
rg "initialOwner\\s*==\\s*address\\(0\\)" src -g"*.sol"
```

5) **实现合约禁止被初始化（建议强制）**
```bash
# 建议：所有可升级实现合约都应在 constructor 中禁用 initializer
rg "_disableInitializers\\(\\)" src -g"*.sol"
```

---

## 📜 架构演进历史

### VaultRouter 职责演进（2025-08）

#### 阶段 1：初始设计（2025-08 之前）
**设计目标**：VaultRouter 作为"双架构智能协调器"，包含所有功能：
- ✅ 用户操作路由
- ✅ View 层业务数据缓存（`_userCollateral`, `_userDebt`, `_cacheTimestamps`）
- ✅ 查询接口（`getUserPosition`, `isUserCacheValid`, `batchGetUserPositions` 等）
- ✅ 数据推送接口

**问题**：
- ❌ 违反了"写入不经 View"原则（`processUserOperation` 会触发业务模块写入）
- ❌ 职责混合（路由 + 查询 + 缓存），违反单一职责原则
- ❌ 合约复杂度高，难以维护和扩展

#### 阶段 2：架构演进（2025-08 起）
**设计目标**：职责分离，符合"写入不经 View"原则：
- ✅ VaultRouter：只写不读（路由 + 数据推送）
- ✅ View 模块：只读不写（查询 + 缓存）

**迁移内容**：
- ✅ 查询功能迁移到独立 View 模块：
  - `getUserPosition` → `PositionView.getUserPosition()`
  - `getUserDebt` → `PositionView.getUserPosition()` (返回 debt)
  - `isUserCacheValid` → `PositionView.isUserCacheValid()`
  - `batchGetUserPositions` → `PositionView.batchGetUserPositions()` / `CacheOptimizedView.batchGetUserPositions()`
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
- `docs/FRONTEND_CONTRACTS_INTEGRATION.md`（2025-08版本）- 准确描述当前架构
- `docs/Architecture-Analysis.md`（第702-704行）- 验证架构一致性
- `docs/Usage-Guide/Liquidation/SettlementManager-Refactor-Plan.md` - SettlementManager 全面整改总纲（SSOT：统一写入口、迁移步骤、测试清单）
# RWA 借贷平台核心逻辑说明 v3.0

> 最后更新：2025-12  
> 基于当前智能合约实际实现，包含双架构设计（事件驱动 + View层缓存）、ACM 权限管理、真实资金流转、撮合结算、保证金系统、资产白名单、SafeERC20 等最新特性13

---

## 📋 目录

1. [系统架构总览](#1-系统架构总览)
2. [权限管理系统](#2-权限管理系统)
3. [核心合约模块](#3-核心合约模块)
4. [真实资金流转逻辑](#4-真实资金流转逻辑)
5. [资产白名单管理](#5-资产白名单管理)
6. [借贷业务流程](#6-借贷业务流程)
7. [清算机制](#7-清算机制)
8. [预言机系统](#8-预言机系统)
9. [费用与分账](#9-费用与分账)
10. [安全特性](#10-安全特性)
11. [升级与治理](#11-升级与治理)

---

## 1. 系统架构总览

### 1.1 双架构设计

RWA 借贷平台采用**双架构设计**，结合事件驱动架构和 View 层缓存架构：

- **事件驱动架构**：所有操作通过事件记录，支持数据库收集和 AI 分析
- **View 层缓存架构**：提供快速免费查询，所有查询函数使用 view（0 gas）
- **实时数据流**：数据库实时收集和处理事件数据
- **Gas 优化**：查询免费，只在数据更新时支付 Gas

### 1.2 核心模块架构

```mermaid
graph TB
    subgraph "用户层"
        User[用户]
        Keeper[Keeper Bot]
    end
    
    subgraph "入口层（极简）"
        VaultCore[VaultCore<br/>极简入口]
    end
    
    subgraph "View层（双架构协调器）"
        VaultView[VaultView<br/>双架构智能协调器]
    end
    
    subgraph "业务逻辑层"
        VaultBusinessLogic[VaultBusinessLogic<br/>业务逻辑模块]
        SettlementMatchLib[SettlementMatchLib<br/>撮合结算库]
    end
    
    subgraph "账本层"
        CollateralManager[CollateralManager<br/>抵押物管理]
        LendingEngine[LendingEngine<br/>借贷引擎/订单管理]
    end
    
    subgraph "功能模块层"
        GuaranteeFundManager[GuaranteeFundManager<br/>保证金管理]
        EarlyRepaymentGM[EarlyRepaymentGM<br/>提前还款保证金]
        LiquidationManager[LiquidationManager<br/>清算管理]
        FeeRouter[FeeRouter<br/>费用路由]
        RewardManager[RewardManager<br/>奖励管理]
    end
    
    subgraph "基础设施层"
        AssetWhitelist[AssetWhitelist<br/>资产白名单]
        PriceOracle[PriceOracle<br/>价格预言机]
        StatisticsView[StatisticsView<br/>统计视图]
        HealthView[HealthView<br/>健康因子视图]
    end
    
    subgraph "权限管理层"
        ACM[AccessControlManager<br/>统一权限控制]
        ActionKeys[ActionKeys<br/>44个动作键]
        ModuleKeys[ModuleKeys<br/>模块键]
    end
    
    subgraph "治理层"
        Registry[Registry<br/>模块注册中心]
        VaultAdmin[VaultAdmin<br/>治理入口]
    end
    
    User --> VaultCore
    VaultCore --> VaultView
    VaultView --> VaultBusinessLogic
    VaultBusinessLogic --> SettlementMatchLib
    VaultBusinessLogic --> CollateralManager
    VaultBusinessLogic --> LendingEngine
    VaultBusinessLogic --> GuaranteeFundManager
    VaultBusinessLogic --> EarlyRepaymentGM
    LendingEngine --> CollateralManager
    LendingEngine --> FeeRouter
    LendingEngine --> RewardManager
    VaultView --> StatisticsView
    VaultView --> HealthView
    VaultBusinessLogic --> AssetWhitelist
    VaultBusinessLogic --> PriceOracle
    VaultCore --> ACM
    VaultBusinessLogic --> ACM
    Registry --> ModuleKeys
    Registry --> ActionKeys
    ACM --> Registry
```

### 1.3 模块职责分工

| 模块 | 职责 | 状态 | 特性 |
|------|------|------|------|
| **VaultCore** | 极简入口，传送数据至 View 层 | ✅ 已实现 | 双架构设计、极简实现、Registry 升级能力 |
| **VaultView** | 双架构智能协调器 | ✅ 已实现 | 事件驱动、View 层缓存、模块分发、免费查询 |
| **VaultBusinessLogic** | 业务逻辑模块 | ✅ 已实现 | 真实资金流转、撮合结算、SafeERC20、批量操作 |
| **SettlementMatchLib** | 撮合结算库 | ✅ 已实现 | 原子化操作、订单落地、保证金锁定 |
| **CollateralManager** | 抵押物管理，记录用户余额 | ✅ 已实现 | 真实 token 转账、事件记录 |
| **LendingEngine** | 借贷引擎，管理贷款订单 | ✅ 已实现 | 订单生命周期、SafeERC20、费用分配、LoanNFT |
| **GuaranteeFundManager** | 保证金基金管理 | ✅ 已实现 | 资金托管、三方分发、批量操作 |
| **EarlyRepaymentGM** | 提前还款保证金管理 | ✅ 已实现 | 记录管理、规则计算、早偿结算 |
| **LiquidationManager** | 清算管理 | ✅ 已实现 | 模块化清算、风险评估、奖励分配 |
| **AssetWhitelist** | 资产白名单管理 | ✅ 已实现 | 治理控制、批量操作 |
| **FeeRouter** | 费用路由与分配 | ✅ 已实现 | 多币种支持、暂停机制 |
| **RewardManager** | 积分奖励管理 | ✅ 已实现 | 动态积分、惩罚机制 |
| **PriceOracle** | 价格预言机 | ✅ 已实现 | 多预言机支持、缓存机制、优雅降级 |
| **StatisticsView** | 统计视图 | ✅ 已实现 | 数据聚合、保证金统计、活跃用户统计 |
| **HealthView** | 健康因子视图 | ✅ 已实现 | 健康因子缓存、风险状态推送 |
| **AccessControlManager** | 统一权限控制中心 | ✅ 已实现 | 多级权限、角色管理、权限缓存、批量操作 |
| **Registry** | 模块注册中心 | ✅ 已实现 | 延时升级、模块管理、Registry 家族 |
| **VaultAdmin** | 极简治理入口 | ✅ 已实现 | 健康因子下发、升级鉴权 |
| **ModuleKeys** | 模块常量库 | ✅ 已实现 | 模块标识、字符串映射、类型安全 |
| **ActionKeys** | 动作常量库 | ✅ 已实现 | **44个**标准化动作、权限分发、事件追踪 |
| **VaultTypes** | 事件和数据结构 | ✅ 已实现 | 标准化事件、数据结构定义 |
| **VaultMath** | 数学计算库 | ✅ 已实现 | 统一数学计算、健康因子、LTV、百分比计算 |

---

## 2. 权限管理系统

### 2.1 ACM 架构设计

#### 🎯 **设计理念**
RWA 借贷平台采用**统一的权限控制中心**架构，所有模块通过 `AccessControlManager` (ACM) 进行权限验证，确保：

- **统一管理**: 所有权限集中在 ACM 中管理
- **模块化设计**: 每个模块独立但通过 ACM 协调
- **标准化接口**: 使用 ActionKeys 和 VaultTypes 提供标准化接口
- **安全审计**: 完整的事件记录和权限追踪
- **灵活扩展**: 支持多级权限和角色管理

#### 🔧 **核心组件**
```solidity
// 权限级别枚举
enum PermissionLevel {
    NONE,       // 0: 无权限
    VIEWER,     // 1: 只读权限
    OPERATOR,   // 2: 操作权限
    KEEPER,     // 3: Keeper权限
    ADMIN,      // 4: 管理员权限
    OWNER       // 5: 所有者权限
}

// 角色定义（基于 ActionKeys）
bytes32 public constant MINTER_ROLE = ActionKeys.ACTION_BORROW;
bytes32 public constant GOVERNANCE_ROLE = ActionKeys.ACTION_SET_PARAMETER;
bytes32 public constant OPERATOR_ROLE = ActionKeys.ACTION_DEPOSIT;
```

### 2.2 多级权限系统

#### 📊 **权限级别说明**

| 级别 | 名称 | 描述 | 典型用途 | 权限范围 |
|------|------|------|----------|----------|
| 0 | NONE | 无权限 | 普通用户 | 仅查询公开数据 |
| 1 | VIEWER | 只读权限 | 审计员、分析师 | 查看内部数据（需拥有查看相关角色） |
| 2 | OPERATOR | 操作权限 | 业务操作员 | 执行基本业务操作（需拥有业务相关角色） |
| 4 | ADMIN | 管理员权限 | 系统管理员 | 系统参数管理（需拥有管理相关角色） |

**注意**: 当前实现中，KEEPER 和 OWNER 权限级别未在 PermissionLevel 枚举中实现。Keeper 功能通过独立的 `_keeper` 地址和 `onlyKeeper` 修饰符实现，Owner 功能通过 `_owner` 地址和 `onlyOwner` 修饰符实现。

#### 🔒 **权限级别说明**

当前实现采用**基于角色的权限系统**，权限级别根据账户拥有的角色动态推断：

**权限级别推断规则**:
- 拥有 `ACTION_SET_PARAMETER` 或 `ACTION_UPGRADE_MODULE` 角色 → `ADMIN`
- 拥有 `ACTION_DEPOSIT` 或 `ACTION_BORROW` 等业务角色 → `OPERATOR`
- 拥有 `ACTION_VIEW` 等查看角色 → `VIEWER`
- 无任何角色 → `NONE`

**注意**: 当前实现不支持直接设置权限级别，也不支持 OWNER 和 KEEPER 权限级别。如需更高级别的权限控制，应通过授予相应的角色来实现。

### 2.3 角色管理系统

#### 🎯 **ActionKeys 角色定义**
ACM 使用 `ActionKeys` 库中定义的 **44 个**标准化动作作为角色标识符：

```solidity
// 基础业务动作
bytes32 public constant ACTION_DEPOSIT = keccak256("DEPOSIT");
bytes32 public constant ACTION_BORROW = keccak256("BORROW");
bytes32 public constant ACTION_REPAY = keccak256("REPAY");
bytes32 public constant ACTION_WITHDRAW = keccak256("WITHDRAW");
bytes32 public constant ACTION_LIQUIDATE = keccak256("LIQUIDATE");

// 系统管理动作
bytes32 public constant ACTION_SET_PARAMETER = keccak256("SET_PARAMETER");
bytes32 public constant ACTION_UPGRADE_MODULE = keccak256("UPGRADE_MODULE");
bytes32 public constant ACTION_PAUSE_SYSTEM = keccak256("PAUSE_SYSTEM");
bytes32 public constant ACTION_UNPAUSE_SYSTEM = keccak256("UNPAUSE_SYSTEM");

// 权限管理动作
bytes32 public constant ACTION_GRANT_ROLE = keccak256("GRANT_ROLE");
bytes32 public constant ACTION_REVOKE_ROLE = keccak256("REVOKE_ROLE");
```

#### 🔧 **角色使用模式**
```solidity
contract LoanNFT {
    // 使用 ActionKeys 定义角色
    bytes32 public constant MINTER_ROLE = ActionKeys.ACTION_BORROW;
    bytes32 public constant GOVERNANCE_ROLE = ActionKeys.ACTION_SET_PARAMETER;
    
    IAccessControlManager public acm;
    
    // 权限验证
    function mintLoanCertificate(address to, LoanMetadata calldata data) external {
        acm.requireRole(MINTER_ROLE, msg.sender);
        // ... 业务逻辑
    }
    
    // 权限检查
    function isMinter(address account) external view returns (bool) {
        return acm.hasRole(MINTER_ROLE, account);
    }
}
```

### 2.4 权限级别推断机制

#### ⚡ **动态推断特性**
- **基于角色**: 权限级别根据账户拥有的角色动态推断
- **优先级**: ADMIN > OPERATOR > VIEWER > NONE
- **简化设计**: 当前实现采用简化架构，权限级别由角色自动推断，不直接设置

#### 🔧 **权限推断实现**
```solidity
function getUserPermission(address user) external view returns (PermissionLevel level) {
    if (user == address(0)) return PermissionLevel.NONE;
    
    // 检查是否拥有管理员角色
    if (hasRole(ActionKeys.ACTION_SET_PARAMETER, user) || 
        hasRole(ActionKeys.ACTION_UPGRADE_MODULE, user)) {
        return PermissionLevel.ADMIN;
    }
    
    // 检查是否拥有操作员角色
    if (hasRole(ActionKeys.ACTION_DEPOSIT, user) || 
        hasRole(ActionKeys.ACTION_BORROW, user)) {
        return PermissionLevel.OPERATOR;
    }
    
    // 检查是否拥有查看者角色
    if (hasRole(ActionKeys.ACTION_VIEW, user)) {
        return PermissionLevel.VIEWER;
    }
    
    return PermissionLevel.NONE;
}
```

**注意**: 当前实现中，权限级别是根据角色动态推断的，不支持直接设置权限级别。如需更细粒度的权限控制，应通过授予/撤销相应的 ActionKeys 角色来实现。

### 2.5 事件记录系统

#### 📝 **标准化事件**
```solidity
// 权限变更事件
event PermissionUpdated(address indexed user, PermissionLevel oldLevel, PermissionLevel newLevel, uint256 timestamp);

// 角色变更事件
event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

// 动作执行事件
event ActionExecuted(bytes32 indexed actionKey, string actionName, address indexed executor, uint256 timestamp);
```

#### 🔧 **事件使用**
```solidity
// 记录标准化动作
emit VaultTypes.ActionExecuted(
    ActionKeys.ACTION_DEPOSIT,
    ActionKeys.getActionKeyString(ActionKeys.ACTION_DEPOSIT),
    msg.sender,
    block.timestamp
);
```

---

## 3. 核心合约模块

### 3.1 VaultCore（极简入口）

#### 📋 **核心功能**
- **极简入口**：双架构设计的极简入口合约
- **数据传送**：将用户操作传送至 View 层处理
- **Registry 升级**：支持 Registry 模块升级能力
- **地址暴露**：暴露 Registry 和 View 合约地址

#### 🔧 **主要函数**
```solidity
// 用户操作（传送数据至 View 层）
function deposit(address asset, uint256 amount) external
function withdraw(address asset, uint256 amount) external
function borrow(address asset, uint256 amount) external
function repay(address asset, uint256 amount) external

// Registry 基础升级能力
function upgradeModule(bytes32 moduleKey, address newAddress) external onlyAdmin
function executeModuleUpgrade(bytes32 moduleKey) external onlyAdmin

// 基础查询
function registryAddrVar() external view returns (address)
function getRegistry() external view returns (address)
function getModule(bytes32 moduleKey) external view returns (address)
```

#### 🛡️ **设计特点**
- **极简实现**：移除复杂逻辑（权限验证、业务委托、资产白名单验证、暂停/恢复）
- **双架构支持**：遵循双架构设计，只负责传送数据
- **可升级**：支持 UUPS 升级模式

### 3.2 VaultView（双架构智能协调器）

#### 📋 **核心功能**
- **双架构协调**：事件驱动 + View 层缓存
- **用户操作处理**：接收 VaultCore 传送的操作，分发到相应模块
- **View 层缓存**：提供快速免费查询（0 gas）
- **数据推送**：统一数据推送接口，支持数据库收集

#### 🔧 **主要函数**
```solidity
// 用户操作处理（由 VaultCore 调用）
function processUserOperation(
    address user,
    bytes32 operationType,
    address asset,
    uint256 amount,
    uint256 timestamp
) external onlyAuthorizedContract

// 数据推送接口（由业务模块调用）
function pushUserPositionUpdate(
    address user,
    address asset,
    uint256 collateral,
    uint256 debt
) external onlyBusinessContract

function pushSystemStateUpdate(
    address asset,
    uint256 totalCollateral,
    uint256 totalDebt
) external onlyBusinessContract

// 查询接口（免费查询，0 gas）
function getUserPosition(address user, address asset) external view 
    returns (uint256 collateral, uint256 debt)
function getUserCollateral(address user, address asset) external view returns (uint256)
function getUserDebt(address user, address asset) external view returns (uint256)
function isUserCacheValid(address user) external view returns (bool)
// 注意：健康因子查询已移至 HealthView 模块

// 批量查询
function batchGetUserPositions(address[] calldata users, address[] calldata assets) 
    external view returns (UserPosition[] memory)
function batchGetAssetPrices(address[] calldata assets) external view returns (uint256[] memory)
// 注意：健康因子批量查询已移至 HealthView 模块

// 缓存管理
function clearExpiredCache(address user) external onlyAdmin
function getCacheStats() external view returns (uint256, uint256, uint256, uint256)
function refreshModuleCache() external onlyAdmin
```

#### 🛡️ **设计特点**
- **模块地址缓存**：1小时有效期，减少 Registry 查询
- **View 层缓存**：5分钟有效期，提供快速查询
- **事件驱动**：统一事件发出，支持数据库收集
- **数据推送**：使用 DataPushLibrary 统一推送

### 3.3 VaultBusinessLogic（业务逻辑模块）

#### 📋 **核心功能**
- **真实资金流转**：处理代币转入/转出
- **撮合结算**：通过 SettlementMatchLib 进行原子化撮合
- **保证金管理**：集成保证金锁定和释放
- **批量操作**：支持批量业务操作

#### 🔧 **主要函数**
```solidity
// 基础业务操作
function deposit(address user, address asset, uint256 amount) external
function withdraw(address user, address asset, uint256 amount) external
function borrow(address user, address asset, uint256 amount) external
function repay(address user, address asset, uint256 amount) external

// 带利率的借款（通过撮合结算）
function borrowWithRate(
    address user,
    address lender,
    address asset,
    uint256 amount,
    uint256 annualRateBps,
    uint16 termDays
) external

// 显式关单还款（触发早偿结算）
function repayWithStop(address user, address asset, uint256 amount, bool stop) external

// 撮合结算（完整流程）
function finalizeMatch(
    SettlementIntentLib.BorrowIntent calldata borrowIntent,
    SettlementIntentLib.LendIntent[] calldata lendIntents,
    bytes calldata sigBorrower,
    bytes[] calldata sigLenders
) external

// 出借资金保留
function reserveForLending(
    address lender,
    address asset,
    uint256 amount,
    bytes32 lendIntentHash
) external

// 取消资金保留
function cancelReserve(bytes32 lendIntentHash) external
```

#### 🛡️ **设计特点**
- **撮合结算**：使用 SettlementMatchLib 进行原子化操作
- **保证金集成**：自动锁定和释放保证金
- **SafeERC20**：所有 ERC20 操作使用安全转账
- **ReentrancyGuard**：防止重入攻击

### 3.4 LendingEngine（借贷引擎/订单管理）

#### 📋 **核心功能**
- **订单生命周期管理**：创建、还款、状态更新
- **LoanNFT 集成**：每个订单对应一个 NFT
- **费用分配**：自动计算和分配还款手续费
- **优雅降级**：价格预言机异常时的降级处理

#### 🔧 **主要函数**
```solidity
// 订单创建（由 SettlementMatchLib 调用，需要 ACTION_ORDER_CREATE 权限）
function createLoanOrder(LoanOrder calldata order) external returns (uint256 orderId)
// LoanOrder 结构体包含：principal, rate, term, borrower, lender, asset, startTimestamp, maturity, repaidAmount

// 还款处理（需要 ACTION_REPAY 权限）
function repay(uint256 orderId, uint256 repayAmount) external

// 查询功能
function getLoanOrder(uint256 orderId) external view returns (LoanOrder memory)
function getUserOrders(address user) external view returns (uint256[] memory)
function calculateExpectedInterest(address user, address asset, uint256 amount) 
    external view returns (uint256)
```

#### 🛡️ **设计特点**
- **onlyVaultCore**：仅 VaultCore 可调用账本写入
- **LoanNFT**：每个订单对应一个 NFT，便于追踪
- **费用分配**：自动计算还款手续费并分配给 FeeRouter
- **优雅降级**：集成 GracefulDegradation 库处理价格异常

### 3.5 VaultAdmin（极简治理入口）

#### 📋 **核心功能**
- **参数下发**：最小健康因子路由至 LiquidationRiskManager
- **升级鉴权**：自身 UUPS 升级授权
- **只读**：Registry 地址查询

#### 🔧 **主要函数**
```solidity
// 参数下发（唯一写路径）
function setMinHealthFactor(uint256 hfBps) external

// 升级鉴权（UUPS）
function _authorizeUpgrade(address newImplementation) internal override

// 基础查询
function getRegistryAddr() external view returns (address)
```

### 3.6 CollateralManager（抵押物管理）

#### 📋 **核心功能**
- **用户余额管理**：记录每个用户的抵押物余额
- **真实 token 转账**：支持强制清算时的真实转账
- **动态代币配置**：支持更换抵押代币

#### 🔧 **主要函数**
```solidity
// 核心业务逻辑（由 VaultView 调用）
function processDeposit(address user, address asset, uint256 amount) external onlyVaultView
function processWithdraw(address user, address asset, uint256 amount) external onlyVaultView

// 兼容性接口（重定向到核心函数）
function depositCollateral(address user, address asset, uint256 amount) external onlyVaultView
function withdrawCollateral(address user, address asset, uint256 amount) external onlyVaultView

// 批量操作
function batchProcessDeposit(address user, address[] calldata assets, uint256[] calldata amounts) external onlyVaultView
function batchProcessWithdraw(address user, address[] calldata assets, uint256[] calldata amounts) external onlyVaultView

// 查询功能
function getCollateral(address user, address asset) external view returns (uint256)
function getTotalCollateralByAsset(address asset) external view returns (uint256)
function getUserCollateralAssets(address user) external view returns (address[] memory)
function getUserTotalCollateralValue(address user) external view returns (uint256)
```

### 3.7 AssetWhitelist（资产白名单）

#### 📋 **核心功能**
- **资产白名单管理**：控制哪些 ERC20 资产可以交易
- **治理权限控制**：仅治理地址可修改白名单
- **批量操作支持**：高效的批量添加/移除

#### 🔧 **主要函数**
```solidity
// 检查资产是否允许
function isAssetAllowed(address asset) external view returns (bool)

// 添加资产到白名单（需要 ACTION_ADD_WHITELIST 权限）
function addAllowedAsset(address asset) external

// 从白名单移除资产（需要 ACTION_REMOVE_WHITELIST 权限）
function removeAllowedAsset(address asset) external

// 批量添加资产（需要 ACTION_ADD_WHITELIST 权限）
function batchAddAllowedAssets(address[] calldata assets) external

// 批量移除资产（需要 ACTION_REMOVE_WHITELIST 权限）
function batchRemoveAllowedAssets(address[] calldata assets) external

// 获取所有支持的资产
function getAllowedAssets() external view returns (address[] memory)

// 获取资产详细信息
function getAssetInfo(address asset) external view returns (AssetInfo memory)
```

### 3.8 AccessControlManager（统一权限控制中心）

#### 📋 **核心功能**
- **多级权限管理**：支持从 NONE 到 OWNER 的 6 级权限
- **角色管理系统**：基于 ActionKeys 的标准化角色管理
- **权限缓存机制**：提高权限查询效率
- **批量操作支持**：支持批量权限设置和查询
- **事件记录系统**：完整的权限变更审计

#### 🔧 **主要函数**
```solidity
// 权限级别查询（动态推断）
function getUserPermission(address user) external view returns (PermissionLevel)
// 注意：权限级别根据角色动态推断，不支持直接设置

// 角色管理
function grantRole(bytes32 role, address account) external onlyOwner
function revokeRole(bytes32 role, address account) external onlyOwner
function hasRole(bytes32 role, address account) external view returns (bool)
function requireRole(bytes32 role, address caller) external view

// Keeper 管理
function setKeeper(address newKeeper) external onlyOwner
function getKeeper() external view returns (address)

// 紧急暂停
function emergencyPause(string memory reason) external onlyKeeper
function emergencyUnpause() external onlyKeeper
```

### 3.9 CrossChainGovernance（跨链治理）

#### 📋 **核心功能**
- **提案管理**：创建、投票、执行治理提案
- **跨链支持**：支持多链治理投票
- **时间锁机制**：防止恶意提案执行

#### 🔧 **主要函数**
```solidity
// 提案管理（需要 GOVERNANCE_ROLE 权限）
function createProposal(
    string calldata description,
    bytes[] calldata actions,
    address[] calldata targets,
    uint256 votingPeriod
) external returns (uint256 proposalId)

// 投票
function castVote(uint256 proposalId, VoteOption option) external

// 执行提案（需要 EXECUTOR_ROLE 权限）
function executeProposal(uint256 proposalId) external

// 跨链投票
function receiveCrossChainVote(
    uint256 proposalId,
    uint256 chainId,
    uint256 forVotes,
    uint256 againstVotes,
    uint256 abstainVotes,
    bytes calldata signature
) external

// 查询功能
function getProposalState(uint256 proposalId) external view returns (ProposalState)
function getProposal(uint256 proposalId) external view returns (Proposal memory)
```

### 3.10 Registry（模块注册中心）

#### 📋 **核心功能**
- **模块地址映射**：维护 `key => address` 映射关系
- **延时升级机制**：支持三步升级流程
- **模块管理**：提供模块注册、更新、查询功能

#### 🔧 **主要函数**
```solidity
// 模块查询
function getModule(bytes32 key) external view returns (address)
function getModuleOrRevert(bytes32 key) external view returns (address)

// 模块管理（通过 RegistryCore 模块）
function setModule(bytes32 key, address module) external
function setModuleWithReplaceFlag(bytes32 key, address module, bool replace) external

// 延时升级（通过 RegistryUpgradeManager 模块）
function scheduleUpgrade(bytes32 key, address newModule, uint256 delay) external
function executeModuleUpgrade(bytes32 key) external
function cancelUpgrade(bytes32 key) external

// 治理管理（通过 RegistryAdmin 模块）
function setAdmin(address newAdmin) external
function acceptAdmin() external
```

### 3.11 ModuleKeys & ActionKeys（常量库）

#### 📋 **核心功能**
- **模块标识**：提供所有模块的唯一标识常量
- **动作标识**：提供所有系统动作的唯一标识常量
- **字符串映射**：支持常量与字符串的双向映射
- **类型安全**：严格的错误处理和类型检查

#### 🔧 **主要常量**
```solidity
// ModuleKeys 示例
bytes32 constant KEY_VAULT_CORE = keccak256("vaultCore");
bytes32 constant KEY_COLLATERAL_MANAGER = keccak256("collateralManager");
bytes32 constant KEY_LENDING_ENGINE = keccak256("lendingEngine");
bytes32 constant KEY_ACCESS_CONTROL_MANAGER = keccak256("accessControlManager");
bytes32 constant KEY_REGISTRY = keccak256("registry");

// ActionKeys 示例
bytes32 constant ACTION_CLAIM_REWARD = keccak256("claimReward");
bytes32 constant ACTION_UPDATE_PRICE = keccak256("updatePrice");
bytes32 constant ACTION_LIQUIDATE = keccak256("liquidate");
bytes32 constant ACTION_PAUSE = keccak256("pause");
bytes32 constant ACTION_UNPAUSE = keccak256("unpause");
```

#### 🔧 **映射函数**
```solidity
// ModuleKeys 映射函数
function getModuleKeyFromString(string memory name) external pure returns (bytes32)
function getModuleKeyString(bytes32 key) external pure returns (string memory)

// ActionKeys 映射函数
function getActionKeyFromString(string memory name) external pure returns (bytes32)
function getActionKeyString(bytes32 key) external pure returns (string memory)
```

---

## 4. 真实资金流转逻辑

### 4.1 双架构数据流

```
用户操作 → VaultCore（极简入口）→ VaultView（双架构协调器）
         → VaultBusinessLogic（业务逻辑）→ SettlementMatchLib（撮合结算）
         → LendingEngine（账本写入）→ View 层缓存更新 + 事件推送
         → 数据库收集 + 免费查询
```

### 4.2 资金流转架构（双架构设计）

```mermaid
sequenceDiagram
    participant User as 用户
    participant VaultCore as VaultCore<br/>极简入口
    participant VaultView as VaultView<br/>双架构协调器
    participant VaultBL as VaultBusinessLogic<br/>业务逻辑
    participant Settlement as SettlementMatchLib<br/>撮合结算
    participant CM as CollateralManager<br/>抵押物管理
    participant LE as LendingEngine<br/>借贷引擎
    participant GFM as GuaranteeFundManager<br/>保证金管理
    participant ERGM as EarlyRepaymentGM<br/>早偿保证金
    participant Token as ERC20 Token

    Note over User,Token: 借款流程（带保证金，通过撮合结算）
    User->>VaultBusinessLogic: finalizeMatch(borrowIntent, lendIntents, sigs)
    VaultBusinessLogic->>Settlement: finalizeAtomicFull(...)
    Settlement->>CM: depositCollateral(可选)
    Settlement->>Token: safeTransfer(user, amount)
    Settlement->>LE: createLoanOrder(...)
    LE->>LE: mintLoanNFT(...)
    Settlement->>ERGM: lockGuaranteeRecord(...)
    Settlement->>GFM: lockGuarantee(user, asset, interest)
    LE->>VaultView: pushUserPositionUpdate(...)
    VaultView->>VaultView: 更新缓存 + 事件推送
    VaultBusinessLogic-->>User: 完成借款

    Note over User,Token: 基础借款流程（无利率）
    User->>VaultCore: borrow(asset, amount)
    VaultCore->>VaultView: processUserOperation("BORROW", ...)
    VaultView->>VaultBL: 分发到业务逻辑模块
    VaultBL->>Token: safeTransfer(user, amount)
    VaultBL-->>User: 完成借款

    Note over User,Token: 还款流程
    User->>VaultCore: repay(asset, amount)
    VaultCore->>VaultView: processUserOperation("REPAY", ...)
    VaultView->>VaultBL: 分发到业务逻辑模块
    VaultBL->>Token: safeTransferFrom(user, VaultBL, amount)
    VaultBL->>LE: repay(user, asset, amount)
    VaultBL-->>User: 完成还款

    Note over User,Token: 提取抵押物流程
    User->>VaultCore: withdraw(asset, amount)
    VaultCore->>VaultView: processUserOperation("WITHDRAW", ...)
    VaultView->>VaultBL: 分发到业务逻辑模块
    VaultBL->>CM: withdrawCollateral(user, asset, amount)
    VaultBL->>Token: safeTransfer(user, amount)
    VaultBL-->>User: 完成提取
```

### 4.3 模块化调用机制

#### 🔧 **动态模块调用**
```solidity
import { ModuleKeys } from "contracts/constants/ModuleKeys.sol";
import { Registry } from "contracts/registry/Registry.sol";

// 通过 Registry 获取模块地址
address collateralManager = Registry(_registryAddr).getModuleOrRevert(
    ModuleKeys.KEY_CM
);

// 使用接口进行调用
try ICollateralManager(collateralManager).depositCollateral(user, asset, amount) {
    // 成功处理
} catch (bytes memory lowLevelData) {
    // 错误处理
    emit VaultTypes.ExternalModuleReverted("CollateralManager", lowLevelData, block.timestamp);
    revert ExternalModuleRevertedRaw("CollateralManager", lowLevelData);
}
```

### 4.4 SafeERC20 安全特性

#### 🛡️ **安全优势**
- **防止假成功**：处理返回 `false` 的非标准 ERC20
- **防止假失败**：处理 `revert` 的非标准 ERC20
- **统一接口**：所有 ERC20 操作使用相同接口

#### 🔧 **使用示例**
```solidity
// 安全转账
IERC20(token).safeTransfer(to, amount);

// 安全授权转账
IERC20(token).safeTransferFrom(from, to, amount);

// 安全授权
IERC20(token).safeApprove(spender, amount);
```

### 4.5 资产白名单验证

#### 🔍 **验证流程**
```solidity
function _checkAssetWhitelist(address asset) internal view {
    address assetWhitelist = _getModuleAddress(ModuleKeys.KEY_ASSET_WHITELIST);
    if (assetWhitelist != address(0)) {
        if (!IAssetWhitelist(assetWhitelist).isAssetAllowed(asset)) {
            revert AssetNotAllowed();
        }
    }
}
```

---

## 5. 资产白名单管理

### 5.1 白名单机制设计

#### 🎯 **设计目标**
- **安全性**：防止恶意资产进入系统
- **灵活性**：支持动态添加/移除资产
- **效率性**：快速查询资产是否允许

#### 🔧 **实现方式**
```solidity
contract AssetWhitelist is Initializable, UUPSUpgradeable, IAssetWhitelist, IRegistryUpgradeEvents {
    /// @notice Registry合约地址
    address private _registryAddr;
    
    /// @notice 资产白名单映射
    mapping(address => bool) private _allowedAssets;
    
    /// @notice 支持的资产地址列表
    address[] private _assetList;
    
    /// @notice 资产索引映射：asset → index（优化数组操作）
    mapping(address => uint256) private _assetIndex;
    
    /// @notice 资产数量计数器
    uint256 private _assetCount;
    
    /// @notice 资产详细信息映射
    mapping(address => AssetInfo) private _assetInfo;
    
    struct AssetInfo {
        bool isActive;
        uint256 addedAt;
        address addedBy;
        uint256 lastUpdated;
        uint256 updateCount;
    }
    
    function isAssetAllowed(address asset) external view returns (bool) {
        return _allowedAssets[asset];
    }
    
    function addAllowedAsset(address asset) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        if (_allowedAssets[asset]) revert AmountIsZero(); // 已存在
        
        _allowedAssets[asset] = true;
        _assetList.push(asset);
        _assetIndex[asset] = _assetList.length - 1;
        _assetCount++;
        
        _assetInfo[asset] = AssetInfo({
            isActive: true,
            addedAt: block.timestamp,
            addedBy: msg.sender,
            lastUpdated: block.timestamp,
            updateCount: 1
        });
        
        emit AssetAdded(ActionKeys.ACTION_ADD_WHITELIST, asset, msg.sender, block.timestamp);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_ADD_WHITELIST,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_ADD_WHITELIST),
            msg.sender,
            block.timestamp
        );
    }
}
```

### 5.2 批量操作优化

#### ⚡ **批量添加**
```solidity
function batchAddAllowedAssets(address[] calldata assets) external onlyValidRegistry {
    _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
    if (assets.length == 0) revert AmountIsZero();
    
    uint256 addedCount = 0;
    for (uint256 i = 0; i < assets.length; i++) {
        address asset = assets[i];
        if (asset != address(0) && !_allowedAssets[asset]) {
            _allowedAssets[asset] = true;
            _assetList.push(asset);
            _assetIndex[asset] = _assetList.length - 1;
            _assetCount++;
            
            _assetInfo[asset] = AssetInfo({
                isActive: true,
                addedAt: block.timestamp,
                addedBy: msg.sender,
                lastUpdated: block.timestamp,
                updateCount: 1
            });
            
            addedCount++;
        }
    }
    
    emit AssetsBatchAdded(
        ActionKeys.ACTION_ADD_WHITELIST,
        assets,
        msg.sender,
        addedCount,
        assets.length
    );
    
    // 记录标准化动作事件
    emit VaultTypes.ActionExecuted(
        ActionKeys.ACTION_ADD_WHITELIST,
        ActionKeys.getActionKeyString(ActionKeys.ACTION_ADD_WHITELIST),
        msg.sender,
        block.timestamp
    );
}
```

#### ⚡ **批量移除**
```solidity
function batchRemoveAllowedAssets(address[] calldata assets) external onlyValidRegistry {
    _requireRole(ActionKeys.ACTION_REMOVE_WHITELIST, msg.sender);
    if (assets.length == 0) revert AmountIsZero();
    
    uint256 removedCount = 0;
    for (uint256 i = 0; i < assets.length; i++) {
        address asset = assets[i];
        if (asset != address(0) && _allowedAssets[asset]) {
            _allowedAssets[asset] = false;
            _assetCount--;
            
            // 更新资产信息
            _assetInfo[asset].isActive = false;
            _assetInfo[asset].lastUpdated = block.timestamp;
            _assetInfo[asset].updateCount++;
            
            // 从数组中移除（优化实现）
            uint256 index = _assetIndex[asset];
            if (index < _assetList.length - 1) {
                address lastAsset = _assetList[_assetList.length - 1];
                _assetList[index] = lastAsset;
                _assetIndex[lastAsset] = index;
            }
            _assetList.pop();
            delete _assetIndex[asset];
            
            removedCount++;
        }
    }
    
    emit AssetsBatchRemoved(
        ActionKeys.ACTION_REMOVE_WHITELIST,
        assets,
        msg.sender,
        removedCount,
        assets.length
    );
    
    // 记录标准化动作事件
    emit VaultTypes.ActionExecuted(
        ActionKeys.ACTION_REMOVE_WHITELIST,
        ActionKeys.getActionKeyString(ActionKeys.ACTION_REMOVE_WHITELIST),
        msg.sender,
        block.timestamp
    );
}
```

### 5.3 资产信息管理

#### 📊 **资产详细信息**
系统维护每个资产的详细信息，包括：
- **isActive**：资产是否激活
- **addedAt**：添加时间戳
- **addedBy**：添加者地址
- **lastUpdated**：最后更新时间戳
- **updateCount**：更新次数

#### 🔧 **查询功能**
```solidity
// 获取资产详细信息
function getAssetInfo(address asset) external view returns (AssetInfo memory)

// 获取支持的资产数量
function getAssetCount() external view returns (uint256)

// 根据索引获取资产地址
function getAssetAtIndex(uint256 index) external view returns (address)

// 获取所有支持的资产
function getAllowedAssets() external view returns (address[] memory)
```

#### 🔧 **资产信息更新**
```solidity
// 更新资产信息（需要 ACTION_SET_PARAMETER 权限）
function updateAssetInfo(address asset) external onlyValidRegistry {
    _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
    if (asset == address(0)) revert ZeroAddress();
    if (!_allowedAssets[asset]) revert AmountIsZero();
    
    _assetInfo[asset].lastUpdated = block.timestamp;
    _assetInfo[asset].updateCount++;
    
    emit AssetInfoUpdated(
        ActionKeys.ACTION_SET_PARAMETER,
        asset,
        msg.sender,
        block.timestamp
    );
}
```

### 5.4 优化特性

#### ⚡ **数组操作优化**
- **索引映射**：使用 `_assetIndex` 映射实现 O(1) 的资产查找
- **高效移除**：批量移除时使用交换最后一个元素的方式，避免数组遍历
- **计数器**：使用 `_assetCount` 计数器快速获取资产数量

#### 🛡️ **安全特性**
- **Registry 集成**：通过 Registry 获取 ACM 进行权限验证
- **标准化事件**：所有操作都发出 `VaultTypes.ActionExecuted` 事件
- **错误处理**：使用自定义错误 `ZeroAddress` 和 `AmountIsZero`
- **UUPS 升级**：支持可升级合约模式

---

## 6. 借贷业务流程

### 6.1 撮合结算机制

系统采用**撮合结算**机制，通过 `SettlementMatchLib` 实现原子化操作：

#### 📋 **撮合流程**

1. **意向提交**：借款方和出借方提交意向（BorrowIntent / LendIntent）
2. **资金保留**：出借方资金先进入保留池（LendReserve）
3. **撮合匹配**：系统匹配借款意向和出借意向
4. **原子结算**：通过 `SettlementMatchLib.finalizeAtomicFull` 一次性完成：
   - 抵押物存入（可选）
   - 债务记账（通过 VaultCore.borrowFor）
   - 订单创建（通过 KEY_ORDER_ENGINE 模块，包含 LoanNFT + Reward + DataPush）
   - 借款手续费分发（FeeRouter.distributeNormal）
   - 净额转账给借款人（净额 = 借款金额 - 平台费 - 生态费）
   
   **注意**：`finalizeAtomicFull` 不包含保证金锁定，需要在业务层单独处理（如需要）

#### 🔧 **核心函数**

```solidity
// 撮合结算（完整流程，需要 sigBorrower 参数）
function finalizeMatch(
    SettlementIntentLib.BorrowIntent calldata borrowIntent,
    SettlementIntentLib.LendIntent[] calldata lendIntents,
    bytes calldata sigBorrower,
    bytes[] calldata sigLenders
) external

// 原子化结算（由 SettlementMatchLib 提供，不包含保证金锁定）
function finalizeAtomic(
    address registry,
    address borrower,
    address lender,
    address collateralAsset,
    uint256 collateralAmount,
    address borrowAsset,
    uint256 amount,
    uint16 termDays,
    uint256 rateBps
) internal returns (uint256 orderId)

// 完整编排（包含手续费分发和净额转账）
function finalizeAtomicFull(
    address registry,
    address borrower,
    address lender,
    address collateralAsset,
    uint256 collateralAmount,
    address borrowAsset,
    uint256 amount,
    uint16 termDays,
    uint256 rateBps
) internal returns (uint256 orderId)
```

### 6.2 借款流程（带保证金）

#### 📋 **完整流程**

```mermaid
sequenceDiagram
    participant User as 用户
    participant VaultCore as VaultCore
    participant VaultView as VaultView
    participant VaultBL as VaultBusinessLogic
    participant Settlement as SettlementMatchLib
    participant CM as CollateralManager
    participant LE as LendingEngine
    participant ERGM as EarlyRepaymentGM
    participant GFM as GuaranteeFundManager
    participant Token as ERC20 Token

    User->>VaultBusinessLogic: borrowWithRate(user, lender, asset, amount, rate, term)
    VaultBusinessLogic->>Settlement: finalizeAtomic(...)
    
    alt 有抵押物
        Settlement->>CM: depositCollateral(...)
    end
    
    Settlement->>VaultCore: borrowFor(borrower, asset, amount, termDays)
    Settlement->>OrderEngine: createLoanOrder(order)
    Note over OrderEngine: LoanNFT + Reward + DataPush 由 LendingEngine 统一完成
    
    Note over Settlement: 注意：保证金锁定不在 finalizeAtomic 中，<br/>应在业务层单独处理（如需要）
    
    LE->>VaultView: pushUserPositionUpdate(...)
    VaultView->>VaultView: 更新缓存 + 事件推送
    
    VaultBusinessLogic-->>User: 完成借款
```

#### 🔧 **关键步骤**

1. **用户发起借款**：调用 `VaultBusinessLogic.borrowWithRate()` 或 `finalizeMatch()`，传入利率和期限
2. **撮合结算**：通过 `SettlementMatchLib.finalizeAtomic()` 或 `finalizeAtomicFull()` 原子化执行：
   - 可选：存入抵押物（CollateralManager.depositCollateral）
   - 资金拨付给借款人（从业务层合约余额划转）
   - 债务记账（通过 VaultCore.borrowFor 写入账本）
   - 订单创建（通过 KEY_ORDER_ENGINE 模块调用 createLoanOrder）
   - LoanNFT 铸造、Reward 奖励、DataPush 推送（由 LendingEngine 统一完成）
   - **finalizeAtomicFull 额外步骤**：借款手续费分发（FeeRouter.distributeNormal）和净额转账
3. **保证金锁定**（如需要）：应在业务层单独处理，不在 finalizeAtomic 中
4. **缓存更新**：LendingEngine 推送仓位更新到 VaultView
5. **事件推送**：VaultView 更新缓存并发出事件

### 6.3 还款流程（早偿结算）

#### 📋 **完整流程**

```mermaid
sequenceDiagram
    participant User as 用户
    participant VaultCore as VaultCore
    participant VaultView as VaultView
    participant VaultBL as VaultBusinessLogic
    participant LE as LendingEngine
    participant ERGM as EarlyRepaymentGM
    participant GFM as GuaranteeFundManager
    participant Token as ERC20 Token

    User->>VaultBusinessLogic: repayWithStop(user, asset, amount, stop=true)
    VaultBusinessLogic->>Token: safeTransferFrom(user, VaultBusinessLogic, amount)
    Note over VaultBusinessLogic: 账本更新由 VaultCore → LendingEngine 统一触发
    Note over VaultBusinessLogic: LendingEngine.repay(orderId, repayAmount) 需要 orderId
    
    alt stop=true 或 债务=0
        VaultBL->>ERGM: settleEarlyRepayment(user, asset, amount)
        ERGM->>ERGM: 计算早偿结果（罚金/返还/平台费）
        ERGM->>GFM: settleEarlyRepayment(user, asset, lender, platform, refund, penalty, fee)
        GFM->>Token: safeTransfer(user, refund)
        GFM->>Token: safeTransfer(lender, penalty)
        GFM->>Token: safeTransfer(platform, fee)
    end
    
    LE->>VaultView: pushUserPositionUpdate(...)
    VaultView->>VaultView: 更新缓存 + 事件推送
    
    VaultBusinessLogic-->>User: 完成还款
```

#### 🔧 **关键步骤**

1. **用户发起还款**：调用 `VaultBusinessLogic.repayWithStop()`，设置 `stop=true` 触发早偿结算
2. **代币转入**：从用户转入还款金额到 VaultBusinessLogic 合约
3. **债务记账**：账本更新由 VaultCore → LendingEngine 统一触发（需要 orderId）
4. **早偿结算**（如果 `stop=true`）：
   - VaultBusinessLogic 调用 `EarlyRepaymentGM.settleEarlyRepayment(user, asset, amount)`
   - EarlyRepaymentGM 计算早偿结果（罚金/返还/平台费）
   - EarlyRepaymentGM 调用 `GuaranteeFundManager.settleEarlyRepayment()` 进行一次性三路分发：
     - 返还给借款方（refundToBorrower）
     - 罚金给贷款方（penaltyToLender）
     - 平台手续费给平台（platformFee）
5. **缓存更新**：LendingEngine 推送仓位更新到 VaultView
6. **事件推送**：VaultView 更新缓存并发出事件

### 6.4 保证金系统集成

#### 📋 **保证金流程**

保证金系统在借款和还款流程中集成：

1. **借款时**（如需要保证金）：
   - `EarlyRepaymentGM.lockGuaranteeRecord()` - 记录保证金信息（不转账，仅 VaultCore 可调用）
   - `GuaranteeFundManager.lockGuarantee()` - 真实锁定资金（从用户转入托管池，仅 VaultCore 可调用）
   - **注意**：`SettlementMatchLib.finalizeAtomic()` 和 `finalizeAtomicFull()` 不包含保证金锁定，需要在业务层单独处理

2. **还款时**（早偿结算）：
   - `EarlyRepaymentGM.settleEarlyRepayment(user, asset, amount)` - 计算并关闭记录（仅 VaultCore 可调用）
   - `GuaranteeFundManager.settleEarlyRepayment(user, asset, lender, platform, refund, penalty, fee)` - 三路分发（仅 VaultCore 可调用）：
     - 返还给借款方（refundToBorrower）
     - 罚金给贷款方（penaltyToLender）
     - 平台手续费给平台（platformFee）

3. **清算时**（违约）：
   - `EarlyRepaymentGM.processDefault()` - 处理违约
   - `GuaranteeFundManager.forfeitGuarantee()` - 没收保证金给费用接收者

**权限说明**：
- 保证金相关函数仅 `VaultCore` 可调用（通过 `onlyVaultCore` 修饰符）
- 业务层需要通过 VaultCore 间接调用，或由 VaultCore 统一编排

详见 [保证金系统实现文档](./GuaranteeFundImplementation.md)

---

## 7. 清算机制

### 7.1 健康因子计算

#### 📋 **计算公式**
```
健康因子 = (抵押物价值 × 清算阈值) / 债务价值
```

#### 🔧 **实现代码**
```solidity
// 清算系统中使用 LiquidationViewLibrary 计算健康因子（包含清算阈值）
function calculateHealthFactor(
    uint256 totalCollateralValue,
    uint256 totalDebtValue,
    uint256 liquidationThreshold
) internal pure returns (uint256 healthFactor) {
    if (totalDebtValue == 0) {
        return 1e20; // MAX_HEALTH_FACTOR
    }
    // 健康因子 = (总抵押物价值 * 清算阈值) / 总债务价值
    healthFactor = (totalCollateralValue * liquidationThreshold) / totalDebtValue;
}
```

> **注意**：
> - 清算系统使用 `LiquidationViewLibrary.calculateHealthFactor()`，该函数包含清算阈值参数
> - `VaultMath.calculateHealthFactor()` 是简化版本，不包含清算阈值，主要用于基础计算
> - VaultMath 库的详细功能和使用标准请参考 [第17章 VaultMath 数学计算标准](#17-vaultmath-数学计算标准)

### 7.2 清算触发条件

#### ⚠️ **清算条件**
- 健康因子 < 最小健康因子阈值
- 用户有债务且抵押物不足

#### 🔧 **清算检查**
```solidity
function isLiquidatable(address user) external view returns (bool) {
    uint256 healthFactor = getUserHealthFactor(user);
    return healthFactor < minHealthFactor;
}
```

### 7.3 清算执行流程（模块化清算系统）

#### 📋 **清算步骤**
`LiquidationCoreOperations.executeLiquidation()` 执行的核心步骤：
1. **抵押物扣押**：通过 `LiquidationCollateralManager` 扣押用户抵押物
2. **债务减少**：通过 `LiquidationDebtManager` 强制减少用户债务
3. **奖励计算**：计算清算奖励金额

**完整的清算流程还包括**：
- **清算检查**：`LiquidationRiskManager` 验证用户是否可清算（健康因子 < 清算阈值，默认 105%）
- **风险评估**：计算清算风险和奖励
- **奖励分配**：`LiquidationRewardDistributor` 分配清算残值（平台 3%，风险储备 2%，贷款方 17%，清算人 78%）
- **保证金没收**：`LiquidationGuaranteeManager` 处理保证金没收（如果适用）

#### 🔧 **清算实现（LiquidationManager）**
```solidity
function liquidate(
    address targetUser,
    address collateralAsset,
    address debtAsset,
    uint256 collateralAmount,
    uint256 debtAmount
) external override whenNotPaused nonReentrant onlyLiquidator 
    returns (uint256 bonus) 
{
    // 真实落地清算：扣押 → 减债 → 奖励计算 → 事件
    bonus = LiquidationCoreOperations.executeLiquidation(
        targetUser,
        collateralAsset,
        debtAsset,
        collateralAmount,
        debtAmount,
        msg.sender,
        liquidationConfigStorage,
        _moduleCache,
        _userCollateralSeizureRecords,
        _userTotalLiquidationAmount,
        _liquidatorCollateralStats
    );

    // 单点推送：仅通过 KEY_LIQUIDATION_VIEW（LiquidatorView）
    _pushLiquidationEvent(
        targetUser, collateralAsset, debtAsset, 
        collateralAmount, debtAmount, msg.sender, bonus
    );
}
```

**清算系统架构**：
- **LiquidationManager**：清算入口和协调器
- **LiquidationRiskManager**：风险评估和健康因子检查
- **LiquidationCollateralManager**：抵押物扣押管理
- **LiquidationDebtManager**：债务减少管理
- **LiquidationRewardManager**：奖励计算和分配
- **LiquidationGuaranteeManager**：保证金没收管理

详见 [清算系统集成总结文档](./liquidation-system-integration-summary.md)

---

## 8. 预言机系统

### 8.1 PriceOracle 概述

PriceOracle 是一个基于 CoinGecko API 的多资产价格预言机系统，为平台提供实时、可靠的价格数据服务。

#### 📋 **核心功能**
- **多资产支持**：支持多种 ERC20 资产价格查询
- **价格更新**：支持手动和批量价格更新
- **价格验证**：价格有效性和时效性检查（通过 `maxPriceAge` 配置）
- **优雅降级**：集成 GracefulDegradation 库处理价格异常
- **权限控制**：基于 AccessControlManager 的细粒度权限管理
- **可升级性**：使用 UUPS 代理模式，支持合约升级

#### 🔧 **核心接口**
```solidity
interface IPriceOracle {
    // 价格查询
    function getPrice(address asset) external view returns (uint256 price, uint256 timestamp, uint256 decimals);
    function getPrices(address[] calldata assets) external view returns (uint256[] memory prices, uint256[] memory timestamps, uint256[] memory decimalsArray);
    function isPriceValid(address asset) external view returns (bool);
    
    // 资产配置
    function configureAsset(address asset, string calldata coingeckoId, uint256 decimals, uint256 maxPriceAge) external;
    function getAssetConfig(address asset) external view returns (AssetConfig memory);
    
    // 价格更新（需要 ACTION_UPDATE_PRICE 权限）
    function updatePrice(address asset, uint256 price, uint256 timestamp) external;
    function updatePrices(address[] calldata assets, uint256[] calldata prices, uint256[] calldata timestamps) external;
}
```

#### 📊 **数据结构**
```solidity
struct PriceData {
    uint256 price;        // 价格（8位精度）
    uint256 timestamp;    // 价格更新时间戳
    uint256 decimals;     // 价格精度
    bool isValid;         // 价格是否有效
}

struct AssetConfig {
    string coingeckoId;   // CoinGecko 资产 ID
    uint256 decimals;     // 资产精度
    bool isActive;        // 资产是否激活
    uint256 maxPriceAge;  // 最大价格年龄（秒）
}
```

### 8.2 价格缓存机制

#### ⚡ **缓存策略**
- **时间缓存**：价格在指定时间内有效（通过 `maxPriceAge` 配置）
- **价格验证**：检查价格有效性和时效性
- **优雅降级**：集成 GracefulDegradation 库处理价格异常

> **详细说明**：关于 PriceOracle 的完整架构设计、使用指南、集成示例和最佳实践，请参考 [PriceOracle 使用指南](../Usage-Guide/PriceOracle-Guide.md)。

---

## 9. 费用与分账

### 9.1 费用结构

#### 💰 **费用类型**
- **存款费用**：存入抵押物时收取（通过 `chargeDepositFee` 计算）
- **借款费用**：借款时收取（通过 `chargeBorrowFee` 计算）
- **其他费用**：通过 `distributeNormal` 或 `distributeDynamic` 分配，使用 `feeType` 参数区分类型（如还款费用、清算费用等）

#### 🔧 **费用计算**
```solidity
// 使用 VaultMath 库进行统一费用计算
function chargeDepositFee(address user, uint256 amount) external view returns (uint256 fee) {
    return _calculateFee(amount);  // 使用总费率（platformFeeBps + ecosystemFeeBps）
}

function chargeBorrowFee(address user, uint256 amount) external view returns (uint256 fee) {
    return _calculateFee(amount);  // 使用总费率（platformFeeBps + ecosystemFeeBps）
}

function _calculateFee(uint256 amount) internal view returns (uint256 fee) {
    uint256 totalFeeBps = _platformFeeBps + _ecosystemFeeBps;
    return VaultMath.calculateFee(amount, totalFeeBps);
}
```

### 9.2 费用分配（FeeRouter）

#### 📊 **分配比例**
- **平台费用**：`platformFeeBps`（基点，可配置）
- **生态费用**：`ecosystemFeeBps`（基点，可配置）
- **剩余金额**：返还给调用者（通常是资金池或引擎）
- **约束**：`platformFeeBps + ecosystemFeeBps < 10000`（必须小于 100%）

#### 🔧 **分配实现**
```solidity
function _distribute(address token, uint256 amount, bytes32 feeType) internal whenNotPaused {
    (uint256 platformAmt, uint256 ecoAmt, uint256 remaining) = 
        _calculateDistribution(amount, _platformFeeBps, _ecosystemFeeBps);
    _executeFeeDistribution(token, platformAmt, ecoAmt, remaining, feeType, amount);
}

function _calculateDistribution(
    uint256 amount,
    uint256 platformBps,
    uint256 ecoBps
) internal pure returns (uint256 platformAmt, uint256 ecoAmt, uint256 remaining) {
    platformAmt = VaultMath.calculateFee(amount, platformBps);
    ecoAmt = VaultMath.calculateFee(amount, ecoBps);
    remaining = amount - platformAmt - ecoAmt;
}

function _executeFeeDistribution(
    address token,
    uint256 platformAmt,
    uint256 ecoAmt,
    uint256 remaining,
    bytes32 feeType,
    uint256 totalAmount
) internal {
    // 先从调用者地址拉取全部费用金额（需要调用者预先 approve 给本合约）
    if (totalAmount > 0) {
        IERC20Upgradeable(token).safeTransferFrom(msg.sender, address(this), totalAmount);
    }
    
    // 分发费用
    if (platformAmt > 0) {
        IERC20Upgradeable(token).safeTransfer(_platformTreasury, platformAmt);
    }
    if (ecoAmt > 0) {
        IERC20Upgradeable(token).safeTransfer(_ecosystemVault, ecoAmt);
    }
    if (remaining > 0) {
        // 剩余金额返还给调用者（通常是资金池/编排合约）
        IERC20Upgradeable(token).safeTransfer(msg.sender, remaining);
    }
    
    // 更新统计和缓存
    _feeStatistics[token][feeType] += totalAmount;
    emit FeeDistributed(token, platformAmt, ecoAmt);
}
```

---

## 10. 安全特性

### 10.1 重入攻击防护

#### 🛡️ **防护机制**
- **ReentrancyGuardUpgradeable**：使用 OpenZeppelin 的可升级重入保护
- **状态更新顺序**：遵循 CEI（Checks-Effects-Interactions）模式，先检查条件，再更新状态，最后调用外部函数
- **函数修饰符**：所有可能改变状态的外部函数使用 `nonReentrant` 修饰符

#### 🔧 **实现示例**
```solidity
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

contract VaultBusinessLogic is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardUpgradeable,
    PausableUpgradeable 
{
    function reserveForLending(
        address lender,
        address asset,
        uint256 amount,
        bytes32 lendIntentHash
    ) external whenNotPaused nonReentrant {
        // 1. 检查条件（Checks）
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        
        // 2. 更新状态（Effects）
        _lendReserves.reserve(lender, asset, amount, lendIntentHash);
        
        // 3. 外部调用（Interactions）
        IERC20(asset).safeTransferFrom(lender, address(this), amount);
    }
}
```

### 10.2 权限控制

#### 🔐 **权限系统架构**
系统使用 `AccessControlManager` 进行统一的权限管理，基于 `ActionKeys` 实现细粒度权限控制。

**权限级别**（`PermissionLevel` 枚举）：
- **NONE**：无权限
- **VIEWER**：查看权限（查询系统数据、用户数据等）
- **OPERATOR**：操作权限（设置参数、升级模块、暂停系统等）
- **ADMIN**：管理员权限（最高权限）

**核心权限动作**（`ActionKeys`）：
- `ACTION_ADMIN`：管理员权限
- `ACTION_SET_PARAMETER`：设置参数权限
- `ACTION_UPGRADE_MODULE`：升级模块权限
- `ACTION_PAUSE_SYSTEM`：暂停系统权限
- `ACTION_UNPAUSE_SYSTEM`：恢复系统权限
- `ACTION_DEPOSIT`、`ACTION_BORROW`、`ACTION_REPAY` 等：业务操作权限

#### 🔧 **权限实现**
```solidity
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";

contract VaultBusinessLogic {
    address private _registryAddr;
    
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }
    
    modifier onlyRole(bytes32 actionKey) {
        _requireRole(actionKey, msg.sender);
        _;
    }
    
    function configureAsset(address asset, uint256 maxLTV) external onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        // 需要 ACTION_SET_PARAMETER 权限
    }
}
```

### 10.3 紧急暂停

#### 🚨 **暂停机制**
- **全局暂停**：通过 `PausableUpgradeable` 暂停所有业务操作
- **权限控制**：暂停/恢复操作需要相应的 `ActionKeys` 权限
- **紧急恢复**：紧急情况下快速恢复系统运行

#### 🔧 **暂停实现**
```solidity
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";

contract VaultBusinessLogic is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardUpgradeable,
    PausableUpgradeable 
{
    function pause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_PAUSE_SYSTEM, msg.sender);
        _pause();
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_PAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_PAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );
    }
    
    function unpause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UNPAUSE_SYSTEM, msg.sender);
        _unpause();
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UNPAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UNPAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );
    }
    
    modifier whenNotPaused() {
        require(!paused(), "Contract is paused");
        _;
    }
}
```

---

## 11. 升级与治理

### 11.1 UUPS 升级模式

#### 🔄 **升级机制**
- **实现合约升级**：升级业务逻辑而不影响存储
- **代理合约不变**：用户地址保持不变
- **数据安全**：升级过程中数据不丢失
- **权限控制**：通过 `AccessControlManager` 验证 `ACTION_UPGRADE_MODULE` 权限

#### 🔧 **升级实现**
```solidity
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";

contract VaultBusinessLogic is UUPSUpgradeable {
    address private _registryAddr;
    
    function _authorizeUpgrade(address newImplementation) internal override {
        // 通过 Registry 获取 AccessControlManager 并验证权限
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // 记录升级动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }
}
```

### 11.2 模块化升级（Registry 系统）

#### 🧩 **升级流程**
系统通过 `Registry` 统一管理模块升级，支持两种升级方式：

1. **立即升级**：直接设置新模块地址（首次部署或紧急情况）
2. **延时升级**：计划升级 → 等待延时 → 执行升级（推荐方式，提供安全缓冲）

#### 🔧 **Registry 升级管理**
```solidity
import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";

// 立即升级（首次部署或紧急替换）
function setModule(bytes32 key, address moduleAddr) external onlyOwner whenNotPaused {
    // 直接设置模块地址，无延时
}

// 延时升级流程（推荐）
// 1. 计划升级
function scheduleModuleUpgrade(bytes32 key, address newAddr) external onlyOwner whenNotPaused {
    // 创建升级计划，设置执行时间（当前时间 + minDelay）
    // 升级计划存储在 pendingUpgrades 映射中
}

// 2. 执行升级（延时到期后）
function executeModuleUpgrade(bytes32 key) external onlyOwner nonReentrant whenNotPaused {
    // 检查延时是否到期
    // 执行升级，更新模块地址
    // 记录升级历史
}

// 3. 取消升级（可选）
function cancelModuleUpgrade(bytes32 key) external onlyOwner whenNotPaused {
    // 取消待执行的升级计划
}
```

#### 📊 **升级特性**
- **延时保护**：通过 `minDelay` 设置最小延时时间，防止恶意升级
- **升级历史**：记录所有模块升级历史（最多保留 100 条）
- **批量升级**：支持批量设置多个模块地址
- **权限控制**：只有 `owner` 可以执行升级操作

### 11.3 跨链治理投票

#### 🗳️ **投票机制**
系统使用 `CrossChainGovernance` 合约实现跨链治理，支持多链投票聚合。

**提案状态**：
- `Pending`：待投票
- `Active`：投票中
- `Succeeded`：投票成功
- `Executed`：已执行
- `Defeated`：投票失败
- `Expired`：已过期

**投票选项**：
- `Against`：反对
- `For`：赞成
- `Abstain`：弃权

#### 🔧 **治理实现**
```solidity
contract CrossChainGovernance is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    
    struct Proposal {
        uint256 proposalId;
        address proposer;
        string description;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 startTime;
        uint256 endTime;
        uint256 executionTime;
        bool executed;
        bool canceled;
        ProposalState state;
        uint256 quorum;
        uint256 chainId;
        bytes[] actions;      // 执行动作数组
        address[] targets;    // 目标合约数组
    }
    
    // 创建提案（需要 GOVERNANCE_ROLE 权限）
    function createProposal(
        string calldata description,
        bytes[] calldata actions,
        address[] calldata targets,
        uint256 votingPeriod
    ) external onlyRole(GOVERNANCE_ROLE) returns (uint256 proposalId);
    
    // 投票
    function vote(uint256 proposalId, VoteOption option) external;
    
    // 执行提案（需要 EXECUTOR_ROLE 权限，投票通过后需等待 executionDelay）
    function executeProposal(uint256 proposalId) external onlyRole(EXECUTOR_ROLE) nonReentrant;
    
    // 接收跨链投票
    function receiveCrossChainVote(
        uint256 proposalId,
        uint256 chainId,
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes,
        uint256 totalWeight,
        address validator,
        bytes calldata signature
    ) external onlyRole(EXECUTOR_ROLE) nonReentrant;
}
```

#### 🔄 **升级提案示例**
```solidity
// 创建模块升级提案
bytes[] memory actions = new bytes[](1);
actions[0] = abi.encodeWithSignature(
    "scheduleModuleUpgrade(bytes32,address)",
    ModuleKeys.KEY_VAULT_BUSINESS_LOGIC,
    newImplementationAddress
);

address[] memory targets = new address[](1);
targets[0] = registryAddress;

uint256 proposalId = governance.createProposal(
    "Upgrade VaultBusinessLogic to v2.0",
    actions,
    targets,
    7 days  // 投票期7天
);

// 投票通过后，执行提案
governance.executeProposal(proposalId);

// 延时到期后，执行升级
registry.executeModuleUpgrade(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC);
```

---

## 📊 总结

### 🎯 **核心优势**
- **统一权限管理**：通过 ACM 实现集中化权限控制
- **模块化架构**：高内聚、低耦合的模块设计
- **真实资金流转**：使用 SafeERC20 确保资金安全
- **资产白名单**：严格控制可交易资产
- **健康因子监控**：实时风险监控和清算机制
- **可升级性**：支持 UUPS 升级和模块化升级
- **安全防护**：多重安全机制保护用户资金

### 🔧 **技术栈**
- **Solidity 0.8.20**：智能合约开发
- **OpenZeppelin**：安全合约库
- **UUPS 升级模式**：合约升级
- **模块化架构**：微服务设计
- **接口驱动**：解耦设计
- **ACM 权限系统**：统一权限控制
- **ActionKeys**：标准化动作管理

### 📈 **性能指标**
- **Gas 优化**：批量操作减少 30% Gas 消耗
- **查询效率**：VaultView 提供高效查询接口
- **权限缓存**：ACM 权限缓存提高查询效率
- **升级安全**：模块化升级不影响用户资金
- **错误处理**：统一的错误处理和事件机制


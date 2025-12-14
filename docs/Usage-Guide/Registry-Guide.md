# Registry 系统使用指南

## 📋 目录

1. [系统概述](#系统概述)
2. [核心功能](#核心功能)
3. [模块注册与管理](#模块注册与管理)
4. [升级流程](#升级流程)
5. [查询功能](#查询功能)
6. [权限管理](#权限管理)
7. [使用示例](#使用示例)
8. [最佳实践](#最佳实践)
9. [常见问题](#常见问题)

---

## 系统概述

### 什么是 Registry？

Registry 是平台的**模块地址注册中心**，负责统一管理所有功能模块的合约地址。它提供了：

- **模块地址映射**：通过 `bytes32` 键值对存储和查询模块地址
- **升级管理**：支持延时升级和立即升级两种模式
- **权限控制**：集成 AccessControlManager 进行权限验证
- **历史记录**：记录所有模块升级历史（最多保留 100 条）

### 架构设计

Registry 采用**模块化架构**，将功能委托给专门的子模块：

```
Registry (主入口)
├── RegistryCore (核心功能：模块注册、查询)
├── RegistryUpgradeManager (升级管理：延时升级、历史记录)
├── RegistryAdmin (治理管理：暂停、所有权转移)
└── RegistrySignatureManager (签名授权：EIP-712 签名升级)
```

### 核心优势

- ✅ **统一入口**：所有模块通过 Registry 获取其他模块地址
- ✅ **安全升级**：支持延时升级，防止恶意操作
- ✅ **向后兼容**：保持接口稳定，支持渐进式升级
- ✅ **可追溯性**：完整记录升级历史，便于审计

---

## 核心功能

### 1. 模块地址管理

Registry 使用 `bytes32` 类型的模块键（ModuleKey）来标识不同的模块。所有模块键定义在 `ModuleKeys` 库中。

**常用模块键示例**：
```solidity
import { ModuleKeys } from "../constants/ModuleKeys.sol";

// 核心业务模块
ModuleKeys.KEY_VAULT_CORE           // VaultCore 模块
ModuleKeys.KEY_ORDER_ENGINE         // LendingEngine 模块
ModuleKeys.KEY_CM                   // CollateralManager 模块

// 权限控制模块
ModuleKeys.KEY_ACCESS_CONTROL       // AccessControlManager 模块
ModuleKeys.KEY_ASSET_WHITELIST      // AssetWhitelist 模块

// 业务支持模块
ModuleKeys.KEY_FR                   // FeeRouter 模块
ModuleKeys.KEY_RM                   // RewardManager 模块
ModuleKeys.KEY_PRICE_ORACLE         // PriceOracle 模块
```

### 2. 升级模式

Registry 支持两种升级模式：

#### 立即升级（首次部署或紧急情况）
- **适用场景**：首次注册模块、紧急修复漏洞
- **特点**：无延时，立即生效
- **函数**：`setModule()`, `setModuleWithReplaceFlag()`

#### 延时升级（推荐方式）
- **适用场景**：常规功能升级、安全更新
- **特点**：需要等待 `minDelay` 时间后才能执行
- **流程**：`scheduleModuleUpgrade()` → 等待延时 → `executeModuleUpgrade()`

---

## 模块注册与管理

### 注册新模块

#### 方式一：立即注册（首次部署）

```solidity
import { IRegistry } from "../interfaces/IRegistry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";

// 获取 Registry 实例
IRegistry registry = IRegistry(registryAddress);

// 注册新模块（首次部署，不允许替换）
registry.setModule(ModuleKeys.KEY_VAULT_CORE, vaultCoreAddress);

// 或使用带替换标志的版本
registry.setModuleWithReplaceFlag(
    ModuleKeys.KEY_ORDER_ENGINE,
    lendingEngineAddress,
    true  // allowReplace = true 允许替换已存在的模块
);
```

#### 方式二：批量注册

```solidity
bytes32[] memory keys = new bytes32[](3);
address[] memory addresses = new address[](3);

keys[0] = ModuleKeys.KEY_VAULT_CORE;
addresses[0] = vaultCoreAddress;

keys[1] = ModuleKeys.KEY_ORDER_ENGINE;
addresses[1] = lendingEngineAddress;

keys[2] = ModuleKeys.KEY_CM;
addresses[2] = collateralManagerAddress;

// 批量注册（默认不触发单个事件，节省 gas）
registry.setModules(keys, addresses);

// 或批量注册并返回变更状态
(uint256 changedCount, bytes32[] memory changedKeys) = 
    registry.setModulesWithStatus(keys, addresses);
```

### 查询模块地址

#### 基础查询（返回 0 地址如果未注册）

```solidity
address moduleAddr = registry.getModule(ModuleKeys.KEY_VAULT_CORE);
if (moduleAddr == address(0)) {
    // 模块未注册
}
```

#### 安全查询（未注册则回滚）

```solidity
// 推荐使用：如果模块未注册，函数会 revert
address moduleAddr = registry.getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
```

#### 检查模块是否已注册

```solidity
bool isRegistered = registry.isModuleRegistered(ModuleKeys.KEY_VAULT_CORE);
```

### 在合约中使用 Registry

所有模块合约都应该通过 Registry 获取其他模块地址：

```solidity
import { IRegistry } from "../interfaces/IRegistry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";

contract MyModule {
    address private _registryAddr;
    
    constructor(address registryAddr) {
        _registryAddr = registryAddr;
    }
    
    // 获取其他模块地址
    function _getAccessControlManager() internal view returns (IAccessControlManager) {
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        return IAccessControlManager(acmAddr);
    }
    
    // 使用模块
    function someFunction() external {
        IAccessControlManager acm = _getAccessControlManager();
        acm.requireRole(ActionKeys.ACTION_DEPOSIT, msg.sender);
        // ... 业务逻辑
    }
}
```

---

## 升级流程

### 延时升级流程（推荐）

延时升级提供了安全缓冲期，防止恶意或错误的升级操作。

#### 步骤 1：计划升级

```solidity
// 计划将 VaultCore 升级到新地址
registry.scheduleModuleUpgrade(
    ModuleKeys.KEY_VAULT_CORE,
    newVaultCoreAddress
);

// 查询升级计划
(address newAddr, uint256 executeAfter, bool hasPending) = 
    registry.getPendingUpgrade(ModuleKeys.KEY_VAULT_CORE);
    
// executeAfter 是执行时间戳（当前时间 + minDelay）
// 在 executeAfter 之前无法执行升级
```

#### 步骤 2：等待延时

```solidity
// 检查升级是否准备就绪
bool isReady = registry.isUpgradeReady(ModuleKeys.KEY_VAULT_CORE);
// isReady = true 表示可以执行升级
```

#### 步骤 3：执行升级

```solidity
// 延时到期后，执行升级
registry.executeModuleUpgrade(ModuleKeys.KEY_VAULT_CORE);
```

#### 步骤 4：取消升级（可选）

如果在延时期间发现问题，可以取消升级：

```solidity
registry.cancelModuleUpgrade(ModuleKeys.KEY_VAULT_CORE);
```

### 立即升级（紧急情况）

```solidity
// 立即升级模块（无延时）
registry.setModuleWithReplaceFlag(
    ModuleKeys.KEY_VAULT_CORE,
    newVaultCoreAddress,
    true  // allowReplace = true
);
```

### 升级历史查询

Registry 会记录所有模块的升级历史（最多保留 100 条）：

```solidity
// 获取升级历史数量
uint256 historyCount = registry.getUpgradeHistoryCount(ModuleKeys.KEY_VAULT_CORE);

// 获取特定索引的升级历史
(address oldAddr, address newAddr, uint256 timestamp, address executor) = 
    registry.getUpgradeHistory(ModuleKeys.KEY_VAULT_CORE, 0);  // 获取第一条历史

// 获取所有升级历史（返回编码后的数据）
bytes memory allHistory = registry.getAllUpgradeHistory(ModuleKeys.KEY_VAULT_CORE);
```

---

## 查询功能

### 基础查询

```solidity
// 获取模块地址
address moduleAddr = registry.getModule(ModuleKeys.KEY_VAULT_CORE);

// 获取模块地址（未注册则回滚）
address moduleAddr = registry.getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);

// 检查模块是否已注册
bool isRegistered = registry.isModuleRegistered(ModuleKeys.KEY_VAULT_CORE);
```

### 升级相关查询

```solidity
// 获取待升级信息
(address newAddr, uint256 executeAfter, bool hasPending) = 
    registry.getPendingUpgrade(ModuleKeys.KEY_VAULT_CORE);

// 检查升级是否准备就绪
bool isReady = registry.isUpgradeReady(ModuleKeys.KEY_VAULT_CORE);

// 获取升级历史数量
uint256 count = registry.getUpgradeHistoryCount(ModuleKeys.KEY_VAULT_CORE);

// 获取特定升级历史
(address oldAddr, address newAddr, uint256 timestamp, address executor) = 
    registry.getUpgradeHistory(ModuleKeys.KEY_VAULT_CORE, index);
```

### 系统状态查询

```solidity
// 获取当前延时窗口
uint256 delay = registry.minDelay();

// 获取最大延时窗口
uint256 maxDelay = registry.MAX_DELAY();

// 检查系统是否已暂停
bool paused = registry.isPaused();

// 获取治理地址
address admin = registry.getAdmin();

// 获取待接管地址
address pendingAdmin = registry.getPendingAdmin();

// 检查地址是否为治理地址
bool isAdmin = registry.isAdmin(address);

// 获取存储版本
uint256 version = registry.getStorageVersion();

// 检查是否已初始化
bool initialized = registry.isInitialized();
```

---

## 权限管理

### 权限要求

Registry 的主要操作需要以下权限：

| 操作 | 所需权限 | 说明 |
|------|----------|------|
| `setModule()` | `onlyOwner` | 注册或更新模块地址 |
| `scheduleModuleUpgrade()` | `onlyOwner` | 计划模块升级 |
| `executeModuleUpgrade()` | `onlyOwner` | 执行模块升级 |
| `cancelModuleUpgrade()` | `onlyOwner` | 取消升级计划 |
| `pause()` | `onlyOwner` | 暂停系统 |
| `unpause()` | `onlyOwner` | 恢复系统 |
| `setMinDelay()` | `onlyOwner` | 设置延时窗口 |
| `setPendingAdmin()` | `onlyOwner` | 设置待接管地址 |
| `acceptAdmin()` | `pendingAdmin` | 接受治理权转移 |

### 升级管理员

Registry 支持三种升级授权方式：

1. **Owner**：Registry 的所有者
2. **Upgrade Admin**：专门的升级管理员
3. **Emergency Admin**：紧急管理员

```solidity
// 获取升级管理员
address upgradeAdmin = registry.getUpgradeAdmin();

// 获取紧急管理员
address emergencyAdmin = registry.getEmergencyAdmin();
```

---

## 使用示例

### 示例 1：完整的模块注册流程

```solidity
// 1. 部署新模块
VaultCore newVaultCore = new VaultCore();
newVaultCore.initialize(registryAddress, ...);

// 2. 注册到 Registry
IRegistry registry = IRegistry(registryAddress);
registry.setModule(ModuleKeys.KEY_VAULT_CORE, address(newVaultCore));

// 3. 验证注册
address registeredAddr = registry.getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
require(registeredAddr == address(newVaultCore), "Registration failed");
```

### 示例 2：延时升级流程

```solidity
// 1. 部署新版本
VaultCoreV2 newVaultCore = new VaultCoreV2();
newVaultCore.initialize(registryAddress, ...);

// 2. 计划升级（需要等待 minDelay 时间）
registry.scheduleModuleUpgrade(
    ModuleKeys.KEY_VAULT_CORE,
    address(newVaultCore)
);

// 3. 等待延时（在链下或通过脚本监控）
// 可以通过 getPendingUpgrade 查询执行时间

// 4. 延时到期后执行升级
require(registry.isUpgradeReady(ModuleKeys.KEY_VAULT_CORE), "Not ready");
registry.executeModuleUpgrade(ModuleKeys.KEY_VAULT_CORE);

// 5. 验证升级
address newAddr = registry.getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
require(newAddr == address(newVaultCore), "Upgrade failed");
```

### 示例 3：在业务模块中使用 Registry

```solidity
import { IRegistry } from "../interfaces/IRegistry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IFeeRouter } from "../interfaces/IFeeRouter.sol";

contract VaultBusinessLogic {
    address private _registryAddr;
    
    constructor(address registryAddr) {
        _registryAddr = registryAddr;
    }
    
    // 获取 AccessControlManager
    function _getACM() internal view returns (IAccessControlManager) {
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_ACCESS_CONTROL
        );
        return IAccessControlManager(acmAddr);
    }
    
    // 获取 FeeRouter
    function _getFeeRouter() internal view returns (IFeeRouter) {
        address feeRouterAddr = IRegistry(_registryAddr).getModuleOrRevert(
            ModuleKeys.KEY_FR
        );
        return IFeeRouter(feeRouterAddr);
    }
    
    // 业务函数示例
    function deposit(address asset, uint256 amount) external {
        // 1. 权限验证
        IAccessControlManager acm = _getACM();
        acm.requireRole(ActionKeys.ACTION_DEPOSIT, msg.sender);
        
        // 2. 业务逻辑
        // ...
        
        // 3. 调用其他模块
        IFeeRouter feeRouter = _getFeeRouter();
        feeRouter.chargeDepositFee(msg.sender, amount);
    }
}
```

### 示例 4：批量模块注册

```solidity
// 准备模块键和地址数组
bytes32[] memory keys = new bytes32[](5);
address[] memory addresses = new address[](5);

keys[0] = ModuleKeys.KEY_VAULT_CORE;
addresses[0] = vaultCoreAddress;

keys[1] = ModuleKeys.KEY_ORDER_ENGINE;
addresses[1] = lendingEngineAddress;

keys[2] = ModuleKeys.KEY_CM;
addresses[2] = collateralManagerAddress;

keys[3] = ModuleKeys.KEY_FR;
addresses[3] = feeRouterAddress;

keys[4] = ModuleKeys.KEY_ACCESS_CONTROL;
addresses[4] = accessControlManagerAddress;

// 批量注册
registry.setModules(keys, addresses);

// 验证注册
for (uint256 i = 0; i < keys.length; i++) {
    address registered = registry.getModuleOrRevert(keys[i]);
    require(registered == addresses[i], "Registration failed");
}
```

### 示例 5：升级历史追踪

```solidity
// 获取模块的升级历史
bytes32 moduleKey = ModuleKeys.KEY_VAULT_CORE;
uint256 historyCount = registry.getUpgradeHistoryCount(moduleKey);

console.log("Upgrade history count:", historyCount);

// 遍历所有历史记录
for (uint256 i = 0; i < historyCount; i++) {
    (
        address oldAddr,
        address newAddr,
        uint256 timestamp,
        address executor
    ) = registry.getUpgradeHistory(moduleKey, i);
    
    console.log("Upgrade #%d:", i);
    console.log("  Old Address:", oldAddr);
    console.log("  New Address:", newAddr);
    console.log("  Timestamp:", timestamp);
    console.log("  Executor:", executor);
}
```

---

## 最佳实践

### 1. 使用 `getModuleOrRevert()` 而非 `getModule()`

```solidity
// ✅ 推荐：明确失败，避免空指针
address moduleAddr = registry.getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);

// ❌ 不推荐：需要手动检查零地址
address moduleAddr = registry.getModule(ModuleKeys.KEY_VAULT_CORE);
if (moduleAddr == address(0)) {
    revert("Module not registered");
}
```

### 2. 优先使用延时升级

```solidity
// ✅ 推荐：延时升级提供安全缓冲
registry.scheduleModuleUpgrade(moduleKey, newAddress);
// 等待 minDelay 后
registry.executeModuleUpgrade(moduleKey);

// ⚠️ 谨慎使用：立即升级仅用于紧急情况
registry.setModuleWithReplaceFlag(moduleKey, newAddress, true);
```

### 3. 在合约初始化时验证 Registry

```solidity
constructor(address registryAddr) {
    require(registryAddr != address(0), "Invalid registry");
    require(IRegistry(registryAddr).isInitialized(), "Registry not initialized");
    _registryAddr = registryAddr;
}
```

### 4. 使用辅助函数封装模块获取

```solidity
// ✅ 推荐：封装模块获取逻辑
function _getModule(bytes32 moduleKey) internal view returns (address) {
    return IRegistry(_registryAddr).getModuleOrRevert(moduleKey);
}

function _getAccessControlManager() internal view returns (IAccessControlManager) {
    return IAccessControlManager(_getModule(ModuleKeys.KEY_ACCESS_CONTROL));
}
```

### 5. 批量操作时检查数组长度

```solidity
bytes32[] memory keys = ...;
address[] memory addresses = ...;

require(keys.length == addresses.length, "Array length mismatch");
require(keys.length <= 50, "Batch size too large");  // Registry 限制

registry.setModules(keys, addresses);
```

### 6. 升级前验证新模块地址

```solidity
// 验证新模块地址
require(newModuleAddress != address(0), "Invalid address");
require(newModuleAddress.isContract(), "Not a contract");

// 验证接口兼容性（如果可能）
// ...

// 计划升级
registry.scheduleModuleUpgrade(moduleKey, newModuleAddress);
```

### 7. 监控升级计划

```solidity
// 定期检查升级计划状态
(address newAddr, uint256 executeAfter, bool hasPending) = 
    registry.getPendingUpgrade(moduleKey);

if (hasPending) {
    if (block.timestamp >= executeAfter) {
        // 可以执行升级
        registry.executeModuleUpgrade(moduleKey);
    } else {
        // 还需要等待
        uint256 remaining = executeAfter - block.timestamp;
        console.log("Upgrade pending, remaining:", remaining);
    }
}
```

---

## 常见问题

### Q1: 如何获取 Registry 地址？

Registry 地址通常在系统部署时确定，并存储在配置文件中。各模块合约在初始化时接收 Registry 地址。

```solidity
// 在部署脚本中
Registry registry = new Registry();
registry.initialize(minDelay, upgradeAdmin, emergencyAdmin);

// 在模块初始化时
VaultCore vaultCore = new VaultCore();
vaultCore.initialize(address(registry), ...);
```

### Q2: 模块键在哪里定义？

所有模块键定义在 `src/constants/ModuleKeys.sol` 中。使用 `ModuleKeys.KEY_XXX` 访问。

```solidity
import { ModuleKeys } from "../constants/ModuleKeys.sol";

bytes32 key = ModuleKeys.KEY_VAULT_CORE;
```

### Q3: 延时升级的延时时间是多少？

延时时间由 `minDelay` 参数决定，在 Registry 初始化时设置。可以通过 `registry.minDelay()` 查询当前延时。

```solidity
uint256 currentDelay = registry.minDelay();
```

### Q4: 可以取消已执行的升级吗？

不可以。升级一旦执行就无法撤销。如果需要回退，需要再次升级到旧版本。

### Q5: 升级历史记录会永久保存吗？

不会。Registry 使用环形缓冲策略，最多保留 100 条升级历史。超过限制后，最旧的记录会被覆盖。

### Q6: 如何检查模块是否已注册？

使用 `isModuleRegistered()` 函数：

```solidity
bool isRegistered = registry.isModuleRegistered(ModuleKeys.KEY_VAULT_CORE);
```

### Q7: 批量注册有数量限制吗？

是的。Registry 限制批量操作最多 50 个模块。超过限制会导致交易失败。

### Q8: 系统暂停时可以进行升级吗？

不可以。系统暂停时（`isPaused() == true`），所有模块注册和升级操作都会被阻止。需要先调用 `unpause()` 恢复系统。

### Q9: 如何转移 Registry 所有权？

使用 `transferOwnership()` 函数：

```solidity
// 方式一：直接转移
registry.transferOwnership(newOwner);

// 方式二：两步转移（更安全）
registry.setPendingAdmin(newOwner);
// 新 owner 调用
registry.acceptAdmin();
```

### Q10: 如何查询所有已注册的模块？

Registry 不提供直接查询所有模块的接口（为了节省 gas）。如果需要，可以通过事件日志查询，或使用专门的 View 合约。

---

## 相关文档

- [PlatformLogic.md](../docs/PlatformLogic.md) - 平台核心逻辑文档
- [Architecture-Guide.md](../docs/Architecture-Guide.md) - 架构设计文档
- [Registry-Split-Summary.md](../docs/Registry-Split-Summary.md) - Registry 拆分说明
- [RegistryUpgradeFlow.md](../docs/RegistryUpgradeFlow.md) - 升级流程文档

---

**文档版本**: v1.0  
**最后更新**: 2025年1月  
**维护者**: AI Assistant


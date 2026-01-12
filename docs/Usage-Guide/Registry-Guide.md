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
- **治理权限**：使用 `Ownable`（以及可选的 `upgradeAdmin / emergencyAdmin`）执行治理级操作（模块变更、暂停、升级）
- **历史记录**：记录所有模块升级历史（最多保留 100 条）

### 架构设计

Registry 采用**方向 A（最贴合架构指南）**：源码拆分为多个文件/模块，但**运行时只有一个可升级入口（一个 Proxy）**，其它“模块”作为库/内部实现/或同一 Proxy 的不同实现版本来共享 `RegistryStorage`。

```
Registry (UUPS Proxy, 唯一入口/唯一状态)
└── Registry implementation (源码拆分：RegistryCore/RegistryQuery/RegistryStorage/RegistryEvents/…)
    ├── Core：模块注册/查询（读写 modules mapping）
    ├── Upgrade：延时升级队列/执行/历史（写 pendingUpgrades/history）
    ├── Governance：pause/admin/owner 口径一致化
    └── (Optional) DynamicModuleKey：动态模块键注册器（独立合约，独立存储）
```

#### 为什么必须是“单一 Proxy 入口”

- `docs/Architecture-Guide.md`（“存储模式与布局策略”）对 Registry 家族的要求是：**家族共享状态**（modules/pendingUpgrades/history/admin/minDelay 等必须是同一份状态）。
- 即使多个合约都使用同一个 `STORAGE_SLOT = keccak256("registry.storage.v1")`，**它们的存储仍然是“各自合约实例”的独立存储**。  
  只有当这些“模块”代码通过 **同一 Proxy 的 delegatecall 语义**执行（或本身就是 library/internal 代码）时，才会写入同一份 storage（同一份 RegistryStorage）。

因此：**线上部署推荐且默认只部署一个 `Registry`（UUPS Proxy）**；其余 “Registry 家族模块” 仅用于源码组织、内部复用、或升级时的实现版本演进。

#### 关于 “Registry 家族模块” 的定位（重要）

- `src/registry/*.sol` 下的 `RegistryCore/RegistryUpgradeManager/RegistryAdmin/RegistrySignatureManager/...` 在方向 A 中应理解为：
  - **代码模块（source modules）**：用于拆分职责、复用逻辑、降低单文件复杂度；
  - **共享存储（shared state）**：通过 `RegistryStorage.layout()` 访问同一份 Layout（同一 Proxy 的 storage）；
  - **不推荐作为独立 Proxy/独立合约部署**：否则它们写的是“自己的 storage”，不会影响主 `Registry` 的 modules/pendingUpgrades/history。

> 例外：`RegistryDynamicModuleKey` 属于“动态键注册器”，架构指南明确允许它与 Registry 家族解耦、独立存储、独立升级——它可以作为独立 Proxy 部署（按需启用）。

---

## 部署模型（方向 A）

### 必须部署（生产默认）
- `Registry`：**唯一 Proxy（UUPS）**，持有 `RegistryStorage` 的唯一状态。

### 可选部署（按需启用）
- `RegistryDynamicModuleKey`：动态模块键注册器（独立合约、独立存储、独立升级）。用于解决静态 `ModuleKeys` 无法覆盖新增模块的问题。

### 兼容/历史模块（不推荐线上单独部署）
仓库中仍保留若干 “Registry family compat modules” 以兼容旧脚本/测试或做过渡期实验。但在方向 A 下：
- 它们**不应该作为独立 Proxy 部署去“分担主 Registry 的职责”**（否则不共享 storage，状态会漂移）。
- 若确需部署（仅测试/兼容），必须明确：这些合约维护的是**它们自己合约实例的状态**，不会自动影响主 `Registry`。

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
ModuleKeys.KEY_LE                   // LendingEngine（账本引擎）模块（常用）
ModuleKeys.KEY_ORDER_ENGINE         // OrderEngine（订单引擎，按需）模块
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

Registry 同时存在两类“升级/变更”，容易混淆，必须区分：

- **A. Proxy 实现升级（UUPS upgrade）**：升级 `Registry` 的实现合约（逻辑升级），不会改变 `modules` 映射内容本身。  
- **B. 模块地址变更（moduleKey → address）**：变更模块地址映射（属于治理操作/系统配置变更），可立即或延时执行。

下面的“立即/延时升级”指的是 **B 类（模块地址变更）**。

#### 立即升级（首次部署或紧急情况）
- **适用场景**：首次注册模块、紧急修复漏洞
- **特点**：无延时，立即生效
- **函数**：`setModule()`, `setModuleWithReplaceFlag()`

#### 延时升级（推荐方式）
- **适用场景**：常规功能升级、安全更新
- **特点**：需要等待 `minDelay` 时间后才能执行
- **流程**：`scheduleModuleUpgrade()` → 等待延时 → `executeModuleUpgrade()`

> 说明：Proxy 实现升级（A 类）走 OpenZeppelin Upgrades（UUPS）流程；模块地址变更（B 类）走 `Registry` 自己的 timelock 队列。

---

## 模块注册与管理

### 注册新模块

#### 方式一：立即注册（首次部署）

```solidity
import { IRegistry } from "../interfaces/IRegistry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";

// 获取 Registry 实例
IRegistry registry = IRegistry(registryAddress);

// 注册新模块（首次部署：建议明确禁止替换，防止误覆盖）
registry.setModuleWithReplaceFlag(ModuleKeys.KEY_VAULT_CORE, vaultCoreAddress, false);

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

### OpenZeppelin v5 / UUPS 迁移计划（Phase 0c）

> 目标：让 **Registry 家族** 与 **部署脚本** 严格对齐 `docs/Architecture-Guide.md` 的升级范式：  
> - Registry 家族：**UUPSUpgradeable + 共享存储（RegistryStorage）**  
> - 部署脚本：`deployProxy(...)` **默认 `kind: "uups"`**，仅在确有需要时单点覆写

#### 1) 部署脚本严格化（默认 UUPS）

- **改动点**：将 `scripts/deploy/deploylocal.ts` / `deploy-arbitrum.ts` / `deploy-arbitrum-sepolia.ts` 的 `deployProxy(...)` helper 默认行为固化为：
  - `opts.kind ??= "uups"`（或等价：`{ kind: "uups", ...opts }`）
- **回滚/例外策略**：如果确实存在 **非 UUPS** 的可升级合约，可在单点调用覆盖：
  - `deployProxy("X", args, { kind: "transparent" })`

#### 2) deploylocal initializer 形式化核对（脚本审计前移）

- **新增脚本**：`scripts/checks/audit-deploylocal-initializers.ts`
- **检查规则**（逐一形式化核对 `deploylocal.ts` 中所有 `deployProxy(...)` 调用点）：
  - initializer **必须存在于 ABI**
    - 若存在重载，必须显式写 signature（例如：`{ initializer: "initialize(address)" }`）
  - initializer **入参数量必须与 args 数量一致**
  - 若 `initializer: false`：
    - `deployProxy` 的 args 必须为 `[]`
    - 并且脚本后续必须显式调用一次 `initialize(...)`（延迟初始化必须可追踪）
- **运行方式**：
  - `pnpm -s hardhat clean && pnpm -s hardhat compile`
  - `pnpm -s run checks:audit-deploylocal-initializers`
- **验收标准**：输出报告中 **FAIL = 0**（否则进程以非 0 退出，阻断脚本审计/CI）

#### 3) Registry 家族 “缺少 UUPS” 问题（必须修复）

当部署脚本默认 `kind: "uups"` 后，如果某个 Registry 家族合约 **没有继承 `UUPSUpgradeable`**，OZ Upgrades 会直接报：
`Implementation is missing a public upgradeTo(...) / upgradeToAndCall(...)`（error-008）。

对照当前仓库实现，`src/registry` 里以下合约 **缺少 `UUPSUpgradeable`**（应按架构指南补齐）：

- `src/registry/RegistryUpgradeManager.sol`
- `src/registry/RegistryAdmin.sol`
- `src/registry/RegistryBatchManager.sol`
- `src/registry/RegistryHistoryManager.sol`

**推荐修复范式（对每个合约一致化）**：
- `import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";`
- `contract X is Initializable, OwnableUpgradeable, UUPSUpgradeable, ...`
- `initialize(...)` 中调用 `__UUPSUpgradeable_init();`
- 实现 `_authorizeUpgrade(address newImplementation)`：
  - 按 `docs/Architecture-Guide.md` 的治理口径做权限校验（owner / timelock / multisig / registry 入口策略）
  - `newImplementation != address(0)` 且 `newImplementation.code.length > 0`
- 保留 `constructor { _disableInitializers(); }` 与 `uint256[50] __gap;`

> 注意：`CacheMaintenanceManager.sol` 是 **非可升级合约**（constructor + immutable），不应改成 UUPS，也不应走 proxy 部署。

#### 4) 回归验证清单（建议合并前必跑）

- `pnpm -s run compile`
- `pnpm -s run checks:audit-deploylocal-initializers`
- `pnpm -s run deploy:localhost`（要求不再出现 error-008；所有“必须模块”都应成功部署）
- `pnpm -s test test/Registry*.test.ts`（或至少跑 Registry 相关用例集）

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
bool isAdmin = registry.isAdmin(someAddress);

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
| `cancelModuleUpgrade()` | `onlyOwner` 或 `emergencyAdmin` | 取消升级计划（紧急通道允许 emergencyAdmin） |
| `pause()` | `onlyOwner` 或 `emergencyAdmin` | 暂停系统（紧急通道允许 emergencyAdmin） |
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
    // 建议在生产代码中使用自定义 error（更省 gas / 更易解码），此处仅示例
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
if (newModuleAddress.code.length == 0) revert NotAContract(newModuleAddress);

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

Registry 地址通常在系统部署时确定，并存储在部署产物/前端配置文件中。业务模块在初始化时接收 Registry 地址（或在 VaultCore 中作为公开变量/只读函数暴露，供链下读取）。

```solidity
// 说明：生产环境通常通过 OZ Upgrades 部署 UUPS Proxy 并在同交易初始化。
// Registry.initialize(minDelaySeconds, upgradeAdmin, emergencyAdmin, initialOwner)

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

一般不可以。系统暂停时（`isPaused() == true`），`setModule / scheduleModuleUpgrade / executeModuleUpgrade / cancelModuleUpgrade` 等治理入口默认都会被阻止（`whenNotPaused`）。需要先调用 `unpause()` 恢复系统后再执行常规操作。

> 例外：部分**紧急恢复类**入口可能被设计为“允许在 paused 状态下执行”（例如先 pause 再执行紧急撤销/恢复），以降低事故窗口；具体以 `Registry.sol` 实现为准，并建议在部署/运维手册中单独列出。

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

生产推荐使用 **专门的 View 合约（如 `RegistryView`）** 或事件日志做枚举/分页查询，避免把“遍历所有 keys”逻辑放到主 `Registry` 的稳定 API 中。

> 说明：主 `Registry` 可能包含少量 **tests/compat** 的辅助查询函数（例如返回已注册 key 列表），但不建议依赖其作为前端/索引器的长期稳定接口。

---

## 相关文档

- [PlatformLogic.md](../PlatformLogic.md) - 平台核心逻辑文档
- [Architecture-Guide.md](../Architecture-Guide.md) - 架构设计文档
- [Registry-Split-Summary.md](../Registry-Split-Summary.md) - Registry 拆分说明
- [RegistryUpgradeFlow.md](../RegistryUpgradeFlow.md) - 升级流程文档
- [Storage-Migration-Guide.md](./Storage-Migration-Guide.md) - 存储迁移指南（存储布局升级）

---

**文档版本**: v1.1  
**最后更新**: 2026年1月  
**维护者**: AI Assistant（按 `docs/Architecture-Guide.md` 方向 A 口径修订）


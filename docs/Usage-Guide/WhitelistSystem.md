# RWA 借贷平台白名单系统使用指南

## 概述

本白名单系统为 RWA 借贷平台提供了安全、透明、可扩展的访问控制机制。系统采用链上智能合约管理，通过 Registry 模块化架构实现，确保所有操作透明可追溯，符合 DeFi 的去中心化原则。

## 架构设计

### 核心组件

1. **IWhitelistRegistry.sol** - 白名单接口定义（`src/interfaces/IWhitelistRegistry.sol`）
2. **VaultAccess.sol** - 提供白名单检查功能的访问控制基类（`src/Vault/VaultAccess.sol`）
3. **Registry.sol** - 模块注册表，管理所有模块包括白名单（`src/registry/Registry.sol`）
4. **VaultCore.sol** - 核心金库合约，集成白名单检查（`src/Vault/VaultCore.sol`）

### 系统架构

系统采用 **Registry 模块化架构**，白名单模块通过 `ModuleKeys.KEY_WHITELIST_REGISTRY` 在 Registry 中注册和管理。

```
Registry (模块注册表)
  └── KEY_WHITELIST_REGISTRY → WhitelistRegistry 实现合约
       └── 实现 IWhitelistRegistry 接口
            └── isWhitelisted(address) → bool
```

### 工作流程

```
用户申请 → KYC/AML验证 → 管理员审核 → 实现 WhitelistRegistry → 注册到 Registry → 协议交互权限
```

## 接口定义

### IWhitelistRegistry 接口

```solidity
interface IWhitelistRegistry {
    /// @notice 检查地址是否在白名单中
    /// @param account 待检查的地址
    /// @return 是否在白名单中
    function isWhitelisted(address account) external view returns (bool);
}
```

**注意**：当前接口只定义了 `isWhitelisted` 方法。具体的添加、移除等管理功能需要在实现合约中自行定义。

## 部署指南

### 1. 实现 WhitelistRegistry 合约

您需要实现一个符合 `IWhitelistRegistry` 接口的合约。可以参考 `MockWhitelistRegistry.sol` 作为基础：

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IWhitelistRegistry } from "../interfaces/IWhitelistRegistry.sol";

contract WhitelistRegistry is IWhitelistRegistry {
    mapping(address => bool) private _whitelist;
    
    // 添加管理功能（需要根据实际需求实现）
    function addAddress(address account) external {
        // 实现添加逻辑
        _whitelist[account] = true;
    }
    
    function removeAddress(address account) external {
        // 实现移除逻辑
        _whitelist[account] = false;
    }
    
    // 实现接口方法
    function isWhitelisted(address account) external view override returns (bool) {
        return _whitelist[account];
    }
}
```

### 2. 部署 WhitelistRegistry

```javascript
const WhitelistRegistry = await ethers.getContractFactory("WhitelistRegistry");
const whitelistRegistry = await WhitelistRegistry.deploy();
await whitelistRegistry.waitForDeployment();
const whitelistRegistryAddress = await whitelistRegistry.getAddress();
```

### 3. 注册到 Registry

```javascript
const Registry = await ethers.getContractFactory("Registry");
const registry = Registry.attach(registryAddress);

// 使用 ModuleKeys.KEY_WHITELIST_REGISTRY 注册
const { ModuleKeys } = require("./constants/ModuleKeys");
const moduleKey = ModuleKeys.KEY_WHITELIST_REGISTRY;

await registry.setModule(moduleKey, whitelistRegistryAddress);
```

### 4. 部署 VaultCore（如果尚未部署）

```javascript
const VaultCore = await ethers.getContractFactory("VaultCore");
const vaultCore = await VaultCore.deploy();
await vaultCore.waitForDeployment();

// 初始化 VaultCore
const registryAddress = "..."; // Registry 地址
const viewContractAddress = "..."; // View 层合约地址
await vaultCore.initialize(registryAddress, viewContractAddress);
```

## 使用指南

### 查询操作

#### 通过 VaultAccess 检查白名单状态

```javascript
// VaultAccess 继承类（如 VaultCore）可以直接调用
const vaultAccess = await ethers.getContractAt("VaultAccess", vaultAddress);

// 检查单个地址
const isWhitelisted = await vaultAccess.isWhitelisted(userAddress);

// 获取白名单注册表地址
const whitelistRegistryAddr = await vaultAccess.getWhitelistRegistry();
```

#### 直接查询 WhitelistRegistry

```javascript
const whitelistRegistry = await ethers.getContractAt(
    "IWhitelistRegistry", 
    whitelistRegistryAddress
);

// 检查地址是否在白名单中
const isWhitelisted = await whitelistRegistry.isWhitelisted(userAddress);
```

#### 通过 Registry 获取 WhitelistRegistry 地址

```javascript
const Registry = await ethers.getContractAt("Registry", registryAddress);
const { ModuleKeys } = require("./constants/ModuleKeys");

const whitelistRegistryAddr = await Registry.getModuleOrRevert(
    ModuleKeys.KEY_WHITELIST_REGISTRY
);
```

### 管理员操作

**注意**：当前 `IWhitelistRegistry` 接口只定义了查询方法。添加、移除等管理功能需要在您的 `WhitelistRegistry` 实现合约中自行定义。

如果您的实现合约包含管理功能，可以这样调用：

```javascript
// 假设您的实现合约有这些方法
const whitelistRegistry = await ethers.getContractAt(
    "WhitelistRegistry", 
    whitelistRegistryAddress
);

// 添加地址（如果实现合约有此方法）
// await whitelistRegistry.addAddress(userAddress);

// 移除地址（如果实现合约有此方法）
// await whitelistRegistry.removeAddress(userAddress);
```

### 用户操作

#### 与协议交互（通过 VaultCore）

```javascript
const vaultCore = await ethers.getContractAt("VaultCore", vaultCoreAddress);

// 存款（需要白名单权限，由业务逻辑层检查）
await vaultCore.deposit(assetAddress, amount);

// 借款（需要白名单权限，由业务逻辑层检查）
await vaultCore.borrow(assetAddress, amount);

// 还款（需要白名单权限，由业务逻辑层检查）
await vaultCore.repay(orderId, assetAddress, amount);

// 提款（需要白名单权限，由业务逻辑层检查）
await vaultCore.withdraw(assetAddress, amount);
```

## 权限控制

### 使用 onlyWhitelisted 修饰符

如果您的合约继承自 `VaultAccess`，可以使用 `onlyWhitelisted` 修饰符：

```solidity
import { VaultAccess } from "../Vault/VaultAccess.sol";

contract MyContract is VaultAccess {
    function restrictedFunction() external onlyWhitelisted {
        // 只有白名单地址可以调用此函数
    }
}
```

### 手动检查白名单

```solidity
import { VaultAccess } from "../Vault/VaultAccess.sol";

contract MyContract is VaultAccess {
    function checkUser() external view returns (bool) {
        return isWhitelisted(msg.sender);
    }
}
```

## 安全特性

### 1. 访问控制

- **模块化架构**: 通过 Registry 统一管理，支持模块升级
- **接口标准化**: 使用 `IWhitelistRegistry` 接口，确保兼容性
- **零地址检查**: 系统中有 `ZeroAddress` 错误定义，防止零地址操作

### 2. 错误处理

系统定义了标准错误：

```solidity
error NotWhitelisted();  // 地址不在白名单中
error ZeroAddress();      // 零地址错误
```

### 3. 模块化设计

- **Registry 集成**: 白名单通过 Registry 模块化架构管理
- **可升级性**: 支持通过 Registry 升级白名单实现
- **解耦设计**: 业务逻辑与白名单实现解耦，便于维护

## 相关白名单系统

系统还包含其他类型的白名单：

### AssetWhitelist（资产白名单）

管理允许作为抵押品的资产地址：

- **位置**: `src/access/AssetWhitelist.sol`
- **模块键**: `ModuleKeys.KEY_ASSET_WHITELIST`
- **功能**: 管理允许的资产地址列表

### AuthorityWhitelist（权威机构白名单）

管理认证机构名称：

- **位置**: `src/AuthorityWhitelist.sol`
- **模块键**: `ModuleKeys.KEY_AUTHORITY_WHITELIST`
- **功能**: 管理认证机构名称白名单

## 最佳实践

### 1. 实现 WhitelistRegistry

- **权限控制**: 实现添加/移除功能时，使用 `AccessControlManager` 进行权限管理
- **事件记录**: 记录所有白名单变更操作，便于审计
- **批量操作**: 考虑实现批量添加/移除功能，提高效率

### 2. 权限管理

- **AccessControlManager**: 使用系统的 `AccessControlManager` 进行权限管理
- **ActionKeys**: 使用 `ActionKeys.ACTION_ADD_WHITELIST` 和 `ActionKeys.ACTION_REMOVE_WHITELIST` 定义权限
- **多签钱包**: 考虑将关键权限分配给多签钱包

### 3. 监控和审计

- **事件监控**: 监控白名单变更事件
- **Registry 事件**: 监控 Registry 中的模块注册和升级事件
- **定期审查**: 定期审查白名单状态

## 故障排除

### 常见问题

#### 1. "Not whitelisted" 错误

**原因**: 用户地址不在白名单中

**解决方案**: 
- 检查地址是否正确
- 确认 WhitelistRegistry 实现合约中该地址已被添加
- 检查 Registry 中是否正确注册了 WhitelistRegistry 模块

#### 2. "ZeroAddress" 错误

**原因**: Registry 地址为零或 WhitelistRegistry 模块未注册

**解决方案**: 
- 确认 Registry 地址正确
- 确认 WhitelistRegistry 已注册到 Registry 的 `KEY_WHITELIST_REGISTRY` 键

#### 3. "ModuleNotRegistered" 错误

**原因**: `KEY_WHITELIST_REGISTRY` 模块未在 Registry 中注册

**解决方案**: 
```javascript
// 注册 WhitelistRegistry 到 Registry
await registry.setModule(ModuleKeys.KEY_WHITELIST_REGISTRY, whitelistRegistryAddress);
```

## 升级指南

### 升级 WhitelistRegistry 实现

1. **部署新版本**: 部署新版本的 `WhitelistRegistry` 实现合约
2. **保持接口兼容**: 确保新版本实现 `IWhitelistRegistry` 接口
3. **通过 Registry 升级**: 使用 Registry 的升级机制更新模块地址

```javascript
// 方式1: 立即升级（紧急情况）
await registry.setModuleWithReplaceFlag(
    ModuleKeys.KEY_WHITELIST_REGISTRY,
    newWhitelistRegistryAddress,
    true
);

// 方式2: 延时升级（推荐）
await registry.scheduleModuleUpgrade(
    ModuleKeys.KEY_WHITELIST_REGISTRY,
    newWhitelistRegistryAddress,
    delayTime
);

// 等待延时后执行
await registry.executeModuleUpgrade(ModuleKeys.KEY_WHITELIST_REGISTRY);
```

### 接口兼容性

确保新版本保持与 `IWhitelistRegistry` 接口的兼容性：

- ✅ `isWhitelisted(address)` 方法签名必须保持不变
- ✅ 返回值类型必须保持一致
- ⚠️ 可以添加新的管理方法，但不应该修改接口方法

## 成本分析

### Gas 费用估算

- **查询操作** (`isWhitelisted`): 免费（view 函数）
- **添加/移除地址**: 取决于实现合约的具体逻辑，通常 ~30,000 - 50,000 gas
- **批量操作**: 取决于实现，通常比单个操作更高效

### 优化建议

- 使用批量操作减少交易次数
- 在 Gas 价格较低时进行批量操作
- 考虑使用 Layer 2 解决方案降低费用
- 优化实现合约的存储结构

## 合规性考虑

### 监管要求

- **KYC/AML**: 确保白名单中的地址已完成必要的身份验证
- **制裁筛查**: 定期检查地址是否在制裁名单中
- **数据保护**: 遵循相关数据保护法规

### 审计要求

- **操作日志**: 在实现合约中记录所有白名单操作的完整记录
- **访问控制**: 使用 `AccessControlManager` 记录所有管理员的访问和操作
- **定期报告**: 向监管机构提交定期报告

## 示例实现

### 简单的 WhitelistRegistry 实现

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IWhitelistRegistry } from "../interfaces/IWhitelistRegistry.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";

contract WhitelistRegistry is Initializable, UUPSUpgradeable, IWhitelistRegistry {
    address private _registryAddr;
    mapping(address => bool) private _whitelist;
    
    event AddressAdded(address indexed account, address indexed operator);
    event AddressRemoved(address indexed account, address indexed operator);
    
    function initialize(address registryAddr) external initializer {
        __UUPSUpgradeable_init();
        _registryAddr = registryAddr;
    }
    
    function isWhitelisted(address account) external view override returns (bool) {
        return _whitelist[account];
    }
    
    function addAddress(address account) external {
        _requireRole(ActionKeys.ACTION_ADD_WHITELIST, msg.sender);
        require(account != address(0), "Zero address");
        require(!_whitelist[account], "Already whitelisted");
        _whitelist[account] = true;
        emit AddressAdded(account, msg.sender);
    }
    
    function removeAddress(address account) external {
        _requireRole(ActionKeys.ACTION_REMOVE_WHITELIST, msg.sender);
        require(_whitelist[account], "Not whitelisted");
        _whitelist[account] = false;
        emit AddressRemoved(account, msg.sender);
    }
    
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }
    
    function _authorizeUpgrade(address) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }
}
```

## 技术支持

如有技术问题，请联系开发团队或查看项目文档。

---

**注意**: 
1. 当前系统只定义了 `IWhitelistRegistry` 接口，您需要自行实现 `WhitelistRegistry` 合约
2. 可以参考 `MockWhitelistRegistry.sol` 作为实现参考
3. 本系统设计用于生产环境，请在使用前进行充分的安全测试和审计
4. 确保实现合约符合 `IWhitelistRegistry` 接口规范

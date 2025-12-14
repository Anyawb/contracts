# RWA 借贷平台权限管理使用指南

> 本文档基于当前系统实现编写，涵盖 AccessControlManager 权限系统的完整使用指南。

## 📋 目录

1. [系统概述](#系统概述)
2. [核心组件](#核心组件)
3. [ActionKeys 权限键](#actionkeys-权限键)
4. [权限管理操作](#权限管理操作)
5. [权限验证机制](#权限验证机制)
6. [部署后权限配置](#部署后权限配置)
7. [常见使用场景](#常见使用场景)
8. [最佳实践](#最佳实践)
9. [故障排除](#故障排除)

---

## 系统概述

### 架构设计

RWA 借贷平台采用基于 **ActionKeys** 的细粒度权限管理系统：

- **AccessControlManager**：统一的权限控制中心
- **ActionKeys**：标准化的动作标识符（44 个预定义动作）
- **Registry 集成**：通过 Registry 获取 ACM 地址
- **Owner 模式**：只有 Owner 可以授予/撤销权限

### 权限级别

系统定义了 4 个权限级别（从高到低）：

| 级别 | 说明 | 典型权限 |
|------|------|---------|
| **ADMIN** | 管理员权限 | `ACTION_ADMIN` |
| **OPERATOR** | 操作员权限 | `ACTION_SET_PARAMETER`, `ACTION_UPGRADE_MODULE` 等 |
| **VIEWER** | 查看权限 | `ACTION_VIEW_*` 系列 |
| **NONE** | 无权限 | 无任何权限 |

---

## 核心组件

### AccessControlManager

**位置**：`src/access/AccessControlManager.sol`

**特性**：
- 非升级合约（构造函数接收 owner）
- Owner 模式：只有 owner 可以授予/撤销角色
- 紧急暂停功能
- Keeper 管理
- 权限级别查询

**核心接口**：

```solidity
interface IAccessControlManager {
    // 权限验证
    function requireRole(bytes32 role, address caller) external view;
    function hasRole(bytes32 role, address caller) external view returns (bool);
    
    // 角色管理（仅 Owner）
    function grantRole(bytes32 role, address account) external;
    function revokeRole(bytes32 role, address account) external;
    
    // 查询功能
    function getAccountRoles(address account) external view returns (bytes32[] memory);
    function getRoleAccounts(bytes32 role) external view returns (address[] memory);
    function getUserPermission(address account) external view returns (PermissionLevel);
}
```

### ActionKeys

**位置**：`src/constants/ActionKeys.sol`

**定义**：44 个标准化的动作键，用于权限验证和事件记录。

---

## ActionKeys 权限键

### 基础业务动作

| ActionKey | 说明 | 使用场景 |
|-----------|------|---------|
| `ACTION_DEPOSIT` | 存入抵押物 | VaultCore.deposit() |
| `ACTION_BORROW` | 借款 | VaultCore.borrow() |
| `ACTION_REPAY` | 还款 | VaultCore.repay() |
| `ACTION_WITHDRAW` | 提取抵押物 | VaultCore.withdraw() |
| `ACTION_ORDER_CREATE` | 创建订单 | LendingEngine.createLoanOrder() |
| `ACTION_LIQUIDATE` | 清算 | 清算操作 |
| `ACTION_LIQUIDATE_PARTIAL` | 部分清算 | 部分清算操作 |
| `ACTION_LIQUIDATE_GUARANTEE` | 没收保证金 | 保证金没收 |

### 批量操作动作

| ActionKey | 说明 |
|-----------|------|
| `ACTION_BATCH_DEPOSIT` | 批量存入 |
| `ACTION_BATCH_BORROW` | 批量借款 |
| `ACTION_BATCH_REPAY` | 批量还款 |
| `ACTION_BATCH_WITHDRAW` | 批量提取 |

### 奖励系统动作

| ActionKey | 说明 |
|-----------|------|
| `ACTION_CLAIM_REWARD` | 领取奖励 |
| `ACTION_CONSUME_POINTS` | 消费积分 |
| `ACTION_UPGRADE_SERVICE` | 升级服务 |

### 系统管理动作

| ActionKey | 说明 | 权限级别 |
|-----------|------|---------|
| `ACTION_SET_PARAMETER` | 设置参数 | OPERATOR |
| `ACTION_UPGRADE_MODULE` | 升级模块 | OPERATOR |
| `ACTION_PAUSE_SYSTEM` | 暂停系统 | OPERATOR |
| `ACTION_UNPAUSE_SYSTEM` | 恢复系统 | OPERATOR |
| `ACTION_UPDATE_PRICE` | 更新价格 | OPERATOR |
| `ACTION_ADMIN` | 管理员权限 | ADMIN |
| `ACTION_EMERGENCY_SET_PARAMETER` | 紧急设置参数 | ADMIN |
| `ACTION_SET_UPGRADE_ADMIN` | 设置升级管理员 | ADMIN |

### 权限管理动作

| ActionKey | 说明 |
|-----------|------|
| `ACTION_GRANT_ROLE` | 授予角色 |
| `ACTION_REVOKE_ROLE` | 撤销角色 |
| `ACTION_ADD_WHITELIST` | 添加白名单 |
| `ACTION_REMOVE_WHITELIST` | 移除白名单 |

### 数据查看动作

| ActionKey | 说明 |
|-----------|------|
| `ACTION_VIEW_USER_DATA` | 查看用户数据 |
| `ACTION_VIEW_SYSTEM_DATA` | 查看系统数据 |
| `ACTION_VIEW_RISK_DATA` | 查看风险数据 |
| `ACTION_VIEW_LIQUIDATION_DATA` | 查看清算数据 |
| `ACTION_VIEW_CACHE_DATA` | 查看缓存数据 |
| `ACTION_VIEW_PRICE_DATA` | 查看价格数据 |
| `ACTION_VIEW_DEGRADATION_DATA` | 查看降级数据 |
| `ACTION_VIEW_SYSTEM_STATUS` | 查看系统状态 |

### 治理动作

| ActionKey | 说明 |
|-----------|------|
| `ACTION_CREATE_PROPOSAL` | 创建提案 |
| `ACTION_VOTE` | 投票 |
| `ACTION_EXECUTE_PROPOSAL` | 执行提案 |
| `ACTION_CROSS_CHAIN_VOTE` | 跨链投票 |

### 测试网功能动作

| ActionKey | 说明 |
|-----------|------|
| `ACTION_TESTNET_CONFIG` | 测试网配置 |
| `ACTION_TESTNET_ACTIVATE` | 测试网激活 |
| `ACTION_TESTNET_PAUSE` | 测试网暂停 |

---

## 权限管理操作

### 授予权限

**前提条件**：必须是 AccessControlManager 的 Owner

```solidity
import { IAccessControlManager } from "./interfaces/IAccessControlManager.sol";
import { ActionKeys } from "./constants/ActionKeys.sol";

IAccessControlManager acm = IAccessControlManager(acmAddress);

// 授予单个权限
await acm.grantRole(ActionKeys.ACTION_SET_PARAMETER, targetAddress);

// 授予多个权限
bytes32[] memory roles = [
    ActionKeys.ACTION_SET_PARAMETER,
    ActionKeys.ACTION_UPGRADE_MODULE,
    ActionKeys.ACTION_PAUSE_SYSTEM
];

for (uint256 i = 0; i < roles.length; i++) {
    await acm.grantRole(roles[i], targetAddress);
}
```

### 撤销权限

```solidity
// 撤销单个权限
await acm.revokeRole(ActionKeys.ACTION_SET_PARAMETER, targetAddress);
```

### 查询权限

```solidity
// 检查是否拥有权限
bool hasPermission = await acm.hasRole(ActionKeys.ACTION_SET_PARAMETER, userAddress);

// 获取账户的所有权限
bytes32[] memory roles = await acm.getAccountRoles(userAddress);

// 获取权限的所有账户
address[] memory accounts = await acm.getRoleAccounts(ActionKeys.ACTION_SET_PARAMETER);

// 获取权限级别
PermissionLevel level = await acm.getUserPermission(userAddress);
```

---

## 权限验证机制

### 在合约中使用权限验证

#### 方式 1：直接调用 ACM

```solidity
import { IAccessControlManager } from "./interfaces/IAccessControlManager.sol";
import { ActionKeys } from "./constants/ActionKeys.sol";
import { Registry } from "./registry/Registry.sol";
import { ModuleKeys } from "./constants/ModuleKeys.sol";

contract MyContract {
    address private _registryAddr;
    
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModule(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }
    
    function updateParameter(uint256 newValue) external {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        // 执行更新逻辑
    }
}
```

#### 方式 2：使用 AccessControlLibrary

```solidity
import { AccessControlLibrary } from "./libraries/AccessControlLibrary.sol";
import { ActionKeys } from "./constants/ActionKeys.sol";

contract MyContract {
    address private _registryAddr;
    
    function updateParameter(uint256 newValue) external {
        AccessControlLibrary.requireRole(
            _registryAddr,
            ActionKeys.ACTION_SET_PARAMETER,
            msg.sender,
            msg.sender
        );
        // 执行更新逻辑
    }
}
```

#### 方式 3：使用修饰符

```solidity
import { IAccessControlManager } from "./interfaces/IAccessControlManager.sol";
import { ActionKeys } from "./constants/ActionKeys.sol";

contract MyContract {
    address private _acmAddr;
    
    modifier onlyRole(bytes32 role) {
        IAccessControlManager(_acmAddr).requireRole(role, msg.sender);
        _;
    }
    
    function updateParameter(uint256 newValue) 
        external 
        onlyRole(ActionKeys.ACTION_SET_PARAMETER) 
    {
        // 执行更新逻辑
    }
}
```

---

## 部署后权限配置

### 最小权限配置清单

部署完成后，需要立即配置以下权限：

```typescript
import { ActionKeys } from "./constants/ActionKeys.sol";

// 1. 为部署者授予管理员权限（临时，用于初始配置）
await acm.grantRole(ActionKeys.ACTION_ADMIN, deployerAddress);

// 2. 为治理地址授予管理权限
const governanceAddress = "0x..."; // 多签或 Timelock 地址
await acm.grantRole(ActionKeys.ACTION_SET_PARAMETER, governanceAddress);
await acm.grantRole(ActionKeys.ACTION_UPGRADE_MODULE, governanceAddress);
await acm.grantRole(ActionKeys.ACTION_PAUSE_SYSTEM, governanceAddress);
await acm.grantRole(ActionKeys.ACTION_UNPAUSE_SYSTEM, governanceAddress);

// 3. 为价格更新器授予更新价格权限
const priceUpdaterAddress = deployed.CoinGeckoPriceUpdater;
await acm.grantRole(ActionKeys.ACTION_UPDATE_PRICE, priceUpdaterAddress);

// 4. 为 Reward 模块授予积分铸造权限
const rewardManagerAddress = deployed.RewardManagerCore;
const rewardPointsAddress = deployed.RewardPoints;
const MINTER_ROLE = await rewardPoints.MINTER_ROLE();
await rewardPoints.grantRole(MINTER_ROLE, rewardManagerAddress);

// 5. 为部署者授予白名单管理权限（用于初始资产配置）
await acm.grantRole(ActionKeys.ACTION_ADD_WHITELIST, deployerAddress);
```

### 完整部署脚本示例

参考 `scripts/deploy/deploylocal.ts`、`deploy-arbitrum-sepolia.ts` 或 `deploy-arbitrum.ts` 中的权限配置部分。

---

## 常见使用场景

### 场景 1：用户操作（无需权限）

用户的基础操作（存款、借款、还款、提取）通常不需要特殊权限，由 VaultCore 直接处理：

```solidity
// 用户直接调用，无需权限验证
vaultCore.deposit(assetAddress, amount);
vaultCore.borrow(assetAddress, amount);
```

### 场景 2：管理员配置参数

```solidity
// 需要 ACTION_SET_PARAMETER 权限
contract PriceOracle {
    function configureAsset(
        address asset,
        string memory coingeckoId,
        uint8 decimals,
        uint256 maxPriceAge
    ) external {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        // 配置资产
    }
}
```

### 场景 3：价格更新（自动化）

```solidity
// CoinGeckoPriceUpdater 需要 ACTION_UPDATE_PRICE 权限
contract CoinGeckoPriceUpdater {
    function updatePrices(address[] calldata assets) external {
        _requireRole(ActionKeys.ACTION_UPDATE_PRICE, msg.sender);
        // 更新价格
    }
}
```

### 场景 4：系统暂停/恢复

```solidity
// 需要 ACTION_PAUSE_SYSTEM / ACTION_UNPAUSE_SYSTEM 权限
contract Registry {
    function pause() external {
        _requireRole(ActionKeys.ACTION_PAUSE_SYSTEM, msg.sender);
        _pause();
    }
    
    function unpause() external {
        _requireRole(ActionKeys.ACTION_UNPAUSE_SYSTEM, msg.sender);
        _unpause();
    }
}
```

### 场景 5：合约升级

```solidity
// 需要 ACTION_UPGRADE_MODULE 权限
contract VaultCore is UUPSUpgradeable {
    function _authorizeUpgrade(address newImplementation) 
        internal 
        override 
    {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }
}
```

### 场景 6：查看权限验证

```solidity
// 某些敏感查询可能需要 VIEW 权限
contract VaultView {
    function getUserPrivateData(address user) 
        external 
        view 
        returns (PrivateData memory) 
    {
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        // 返回数据
    }
}
```

---

## 最佳实践

### 1. 最小权限原则

只授予必要的权限，避免过度授权：

```typescript
// ✅ 正确：只授予需要的权限
await acm.grantRole(ActionKeys.ACTION_UPDATE_PRICE, priceUpdaterAddress);

// ❌ 错误：授予过多权限
await acm.grantRole(ActionKeys.ACTION_ADMIN, priceUpdaterAddress);
```

### 2. 使用治理地址

管理权限应授予治理地址（多签或 Timelock），而非个人地址：

```typescript
// ✅ 正确：使用治理地址
const governanceAddress = "0x..."; // 多签地址
await acm.grantRole(ActionKeys.ACTION_SET_PARAMETER, governanceAddress);

// ❌ 错误：使用个人地址
await acm.grantRole(ActionKeys.ACTION_SET_PARAMETER, deployerAddress);
```

### 3. 权限分离

不同功能使用不同的权限键：

```solidity
// ✅ 正确：使用特定权限
_requireRole(ActionKeys.ACTION_UPDATE_PRICE, msg.sender);

// ❌ 错误：使用通用权限
_requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
```

### 4. 定期审查权限

定期检查权限配置，撤销不必要的权限：

```typescript
// 查询所有权限
const roles = await acm.getAccountRoles(accountAddress);

// 撤销不需要的权限
for (const role of roles) {
    if (!isNeeded(role)) {
        await acm.revokeRole(role, accountAddress);
    }
}
```

### 5. 使用事件监控

监听权限变更事件：

```typescript
// 监听权限授予事件
acm.on("RoleGranted", (role, account, grantedBy) => {
    console.log(`Role ${role} granted to ${account} by ${grantedBy}`);
});

// 监听权限撤销事件
acm.on("RoleRevoked", (role, account, revokedBy) => {
    console.log(`Role ${role} revoked from ${account} by ${revokedBy}`);
});
```

---

## 故障排除

### 问题 1：权限验证失败

**症状**：调用函数时返回 `MissingRole` 错误

**排查步骤**：
1. 检查账户是否拥有所需权限：
   ```typescript
   const hasRole = await acm.hasRole(ActionKeys.ACTION_SET_PARAMETER, userAddress);
   ```

2. 检查 ACM 地址是否正确：
   ```typescript
   const acmAddr = await registry.getModule(ModuleKeys.KEY_ACCESS_CONTROL);
   ```

3. 检查是否为 Owner（Owner 可以授予权限）：
   ```typescript
   const owner = await acm.owner();
   ```

**解决方案**：
```typescript
// 授予缺失的权限
await acm.grantRole(ActionKeys.ACTION_SET_PARAMETER, userAddress);
```

### 问题 2：无法授予权限

**症状**：调用 `grantRole` 时返回 `OnlyOwnerAllowed` 错误

**原因**：只有 Owner 可以授予权限

**解决方案**：
1. 使用 Owner 账户调用
2. 或先转移 Owner 权限（如果支持）

### 问题 3：权限级别不正确

**症状**：`getUserPermission` 返回的级别不符合预期

**排查**：
```typescript
// 检查账户的所有权限
const roles = await acm.getAccountRoles(userAddress);

// 检查权限级别计算逻辑
const level = await acm.getUserPermission(userAddress);
```

**说明**：权限级别按以下优先级计算：
1. 拥有 `ACTION_ADMIN` → ADMIN
2. 拥有管理权限（SET_PARAMETER, UPGRADE_MODULE 等）→ OPERATOR
3. 拥有查看权限（VIEW_*）→ VIEWER
4. 其他 → NONE

### 问题 4：紧急暂停后无法操作

**症状**：系统暂停后，所有操作都被阻止

**解决方案**：
```typescript
// 检查暂停状态
const isPaused = await acm.getContractStatus();

// 恢复系统（需要 Owner 权限）
if (isPaused) {
    await acm.emergencyUnpause();
}
```

---

## 相关文档

- [AccessControlManager 合约](../src/access/AccessControlManager.sol)
- [ActionKeys 常量](../src/constants/ActionKeys.sol)
- [Registry 系统文档](../docs/registry-deployment.md)
- [部署脚本](../scripts/deploy/README.md)

---

## 更新日志

- **2025-01-XX**：根据当前系统实现重写文档
- 移除了过时的双架构和撮合流程相关内容
- 更新为基于 AccessControlManager 的实际实现
- 添加了完整的 ActionKeys 列表和使用示例

---

## 许可证

MIT License

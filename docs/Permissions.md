# RWA 借贷平台权限管理系统文档

> **适用范围**: 本仓库内所有基于 **AccessControlManager (ACM)** 的可升级合约
> 
> **核心组件**:
> - `access/AccessControlManager.sol` - 统一权限控制中心
> - `constants/ActionKeys.sol` - 标准化动作标识符
> - `constants/ModuleKeys.sol` - 模块标识符
> - `Vault/VaultTypes.sol` - 事件和数据结构定义
>
> **文档目标**: 统一权限管理逻辑，说明多级权限系统、角色管理、升级权限及最佳实践

---

## 目录

1. [权限系统架构](#权限系统架构)
2. [多级权限系统](#多级权限系统)
3. [角色管理系统](#角色管理系统)
4. [模块权限设置](#模块权限设置)
5. [最佳实践](#最佳实践)
6. [常见问题解决](#常见问题解决)
7. [代码示例](#代码示例)

---

## 权限系统架构

### 核心设计理念

RWA 借贷平台采用**统一的权限控制中心**架构，所有模块通过 `AccessControlManager` (ACM) 进行权限验证，确保：

- **统一管理**: 所有权限集中在 ACM 中管理
- **模块化设计**: 每个模块独立但通过 ACM 协调
- **标准化接口**: 使用 ActionKeys 和 VaultTypes 提供标准化接口
- **安全审计**: 完整的事件记录和权限追踪
- **灵活扩展**: 支持多级权限和角色管理

### 架构组件

```solidity
// 核心组件关系
AccessControlManager (ACM)
├── PermissionLevel (多级权限)
├── ActionKeys (标准化动作)
├── ModuleKeys (模块标识)
└── VaultTypes (事件定义)

// 业务模块
LoanNFT, LendingEngine, FeeRouter, Vault, Reward...
└── 通过 ACM 进行权限验证
```

---

## 多级权限系统

### PermissionLevel 枚举

```solidity
enum PermissionLevel {
    NONE,       // 0: 无权限
    VIEWER,     // 1: 只读权限
    OPERATOR,   // 2: 操作权限
    KEEPER,     // 3: Keeper权限
    ADMIN,      // 4: 管理员权限
    OWNER       // 5: 所有者权限
}
```

### 权限级别说明

| 级别 | 名称 | 描述 | 典型用途 | 权限范围 |
|------|------|------|----------|----------|
| 0 | NONE | 无权限 | 普通用户 | 仅查询公开数据 |
| 1 | VIEWER | 只读权限 | 审计员、分析师 | 查看内部数据 |
| 2 | OPERATOR | 操作权限 | 业务操作员 | 执行基本业务操作 |
| 3 | KEEPER | Keeper权限 | 自动化机器人 | 执行自动化操作 |
| 4 | ADMIN | 管理员权限 | 系统管理员 | 系统参数管理 |
| 5 | OWNER | 所有者权限 | 治理委员会 | 最高权限，包括角色管理 |

### 权限转换规则

```solidity
// 权限转换限制
function _isValidPermissionTransition(PermissionLevel oldLevel, PermissionLevel newLevel) internal pure returns (bool) {
    // 不允许直接从 NONE 跳级到 OWNER
    if (oldLevel < PermissionLevel.ADMIN && newLevel == PermissionLevel.OWNER) {
        return false;
    }
    // 不允许从 KEEPER 直接跳级到 OWNER
    if (oldLevel == PermissionLevel.KEEPER && newLevel == PermissionLevel.OWNER) {
        return false;
    }
    return true;
}
```

**转换路径**:
- `NONE` → `ADMIN` → `OWNER` ✅
- `NONE` → `OWNER` ❌
- `KEEPER` → `OWNER` ❌

---

## 角色管理系统

### ActionKeys 角色定义

ACM 使用 `ActionKeys` 库中定义的标准化动作作为角色标识符：

#### 基础业务动作（现行）
```solidity
bytes32 public constant ACTION_DEPOSIT       = keccak256("DEPOSIT");
bytes32 public constant ACTION_ORDER_CREATE  = keccak256("ORDER_CREATE"); // 订单创建专用鉴权
bytes32 public constant ACTION_BORROW        = keccak256("BORROW");       // 借款动作语义/事件标识（不用于鉴权）
bytes32 public constant ACTION_REPAY         = keccak256("REPAY");
bytes32 public constant ACTION_WITHDRAW      = keccak256("WITHDRAW");
bytes32 public constant ACTION_LIQUIDATE     = keccak256("LIQUIDATE");
bytes32 public constant ACTION_LIQUIDATE_PARTIAL = keccak256("LIQUIDATE_PARTIAL");
```

#### 系统管理动作
```solidity
bytes32 public constant ACTION_SET_PARAMETER = keccak256("SET_PARAMETER");
bytes32 public constant ACTION_UPGRADE_MODULE = keccak256("UPGRADE_MODULE");
bytes32 public constant ACTION_PAUSE_SYSTEM = keccak256("PAUSE_SYSTEM");
bytes32 public constant ACTION_UNPAUSE_SYSTEM = keccak256("UNPAUSE_SYSTEM");
bytes32 public constant ACTION_UPDATE_PRICE = keccak256("UPDATE_PRICE");
```

#### 权限管理动作
```solidity
bytes32 public constant ACTION_GRANT_ROLE = keccak256("GRANT_ROLE");
bytes32 public constant ACTION_REVOKE_ROLE = keccak256("REVOKE_ROLE");
bytes32 public constant ACTION_ADD_WHITELIST = keccak256("ADD_WHITELIST");
bytes32 public constant ACTION_REMOVE_WHITELIST = keccak256("REMOVE_WHITELIST");
```

#### 治理动作
```solidity
bytes32 public constant ACTION_CREATE_PROPOSAL = keccak256("CREATE_PROPOSAL");
bytes32 public constant ACTION_VOTE = keccak256("VOTE");
bytes32 public constant ACTION_EXECUTE_PROPOSAL = keccak256("EXECUTE_PROPOSAL");
bytes32 public constant ACTION_CROSS_CHAIN_VOTE = keccak256("CROSS_CHAIN_VOTE");
```

### 角色使用模式

#### 在合约中定义角色（示例）
```solidity
contract LoanNFT {
    // 使用 ActionKeys 定义角色
    // 业务注：LoanNFT 铸造权限与借款动作语义绑定仍采用 ACTION_BORROW（事件/语义一致性），
    // 但“创建订单”的执行权限应使用 ACTION_ORDER_CREATE 由订单引擎在外部层面控制。
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

#### 角色管理函数
```solidity
// 授予角色
function grantRole(bytes32 role, address account) external {
    acm.requireRole(GOVERNANCE_ROLE, msg.sender);
    acm.grantRole(role, account);
}

// 撤销角色
function revokeRole(bytes32 role, address account) external {
    acm.requireRole(GOVERNANCE_ROLE, msg.sender);
    acm.revokeRole(role, account);
}
```

---

## 模块权限设置

### 部署流程

#### 1. 部署 ACM
```typescript
const ACMFactory = await ethers.getContractFactory('AccessControlManager');
const acm = await ACMFactory.connect(governance).deploy(governance.address);
await acm.waitForDeployment();
```

#### 2. 部署业务合约
```typescript
const LoanNFTFactory = await ethers.getContractFactory('LoanNFT');
const loanNFT = await upgrades.deployProxy(
    LoanNFTFactory,
    ['Loan Certificate', 'LOAN', 'https://api.example.com/loan/', registry.address, acm.address],
    { kind: 'uups' }
);
await loanNFT.waitForDeployment();
```

#### 3. 设置角色权限
```typescript
// 为 governance 授予角色（节选）
await acm.connect(governance).grantRole(GOVERNANCE_ROLE, governance.address);
// 订单创建执行权（长期形态）：仅授予撮合/编排入口
await acm.connect(governance).grantRole(ActionKeys.ACTION_ORDER_CREATE, vblAddress);
// 借款动作语义无需授权给外部地址（不用于鉴权）
```

#### 4. 为业务合约授予权限（关键步骤！）
```typescript
// 为业务合约授予 OWNER 权限，使其能够调用 ACM 的角色管理函数
await acm.connect(governance).setUserPermission(loanNFT.address, 4); // ADMIN
await acm.connect(governance).setUserPermission(loanNFT.address, 5); // OWNER
```

### 权限设置检查清单

- [ ] 部署 ACM 合约
- [ ] 部署业务合约
- [ ] 为 governance 授予必要角色
- [ ] 为业务合约授予 OWNER 权限
- [ ] 验证权限设置正确性
- [ ] 测试角色管理功能

---

## 最佳实践

### 1. 合约设计原则

#### 权限验证函数
```solidity
contract MyRWAContract {
    IAccessControlManager public acm;
    
    // 使用 ActionKeys 定义角色
    bytes32 public constant OPERATOR_ROLE = ActionKeys.ACTION_DEPOSIT;
    bytes32 public constant GOVERNANCE_ROLE = ActionKeys.ACTION_SET_PARAMETER;
    
    // 权限验证函数
    function requireOperatorRole() internal view {
        acm.requireRole(OPERATOR_ROLE, msg.sender);
    }
    
    function requireGovernanceRole() internal view {
        acm.requireRole(GOVERNANCE_ROLE, msg.sender);
    }
    
    // 业务函数
    function deposit(address token, uint256 amount) external {
        requireOperatorRole();
        // ... 业务逻辑
    }
    
    function setParameter(uint256 newValue) external {
        requireGovernanceRole();
        // ... 参数设置逻辑
    }
}
```

#### 事件记录
```solidity
// 记录标准化动作
emit VaultTypes.ActionExecuted(
    ActionKeys.ACTION_DEPOSIT,
    ActionKeys.getActionKeyString(ActionKeys.ACTION_DEPOSIT),
    msg.sender,
    block.timestamp
);

// 记录业务特定事件
emit DepositExecuted(msg.sender, token, amount, block.timestamp);
```

### 2. 错误处理

#### 使用标准错误
```solidity
// 在 StandardErrors.sol 中定义
error MissingRole();
error InsufficientPermission();
error InvalidRole();
error ZeroAddress();

// 在合约中使用
function grantRole(address user) external {
    if (user == address(0)) revert ZeroAddress();
    if (!acm.hasRole(GOVERNANCE_ROLE, msg.sender)) revert InsufficientPermission();
    // ... 授权逻辑
}
```

### 3. 测试策略

#### 权限测试
```typescript
describe('权限管理测试', function () {
    it('应正确设置初始权限', async function () {
        const { contract, acm, governance, alice } = await deployFixture();
        
        // 验证 governance 权限
        expect(await contract.isGovernance(governance.address)).to.be.true;
        expect(await contract.isOperator(governance.address)).to.be.true;
        
        // 验证 alice 权限
        expect(await contract.isOperator(alice.address)).to.be.true;
        expect(await contract.isGovernance(alice.address)).to.be.false;
    });
    
    it('非授权用户应无法执行操作', async function () {
        const { contract, bob } = await deployFixture();
        
        await expect(
            contract.connect(bob).deposit(token.address, amount)
        ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
});
```

### 4. 安全考虑

#### 权限最小化原则
- 只授予必要的权限
- 定期审查权限设置
- 使用多签钱包管理关键权限

#### 升级安全
```solidity
function _authorizeUpgrade(address newImplementation) internal override {
    acm.requireRole(GOVERNANCE_ROLE, msg.sender);
    // 升级逻辑由 UUPSUpgradeable 处理
}
```

---

## 常见问题解决

### 1. InsufficientPermission 错误

**问题**: 合约调用 ACM 函数时出现 `InsufficientPermission` 错误

**原因**: 合约没有足够的权限级别

**解决方案**:
```typescript
// 为合约授予 OWNER 权限
await acm.connect(governance).setUserPermission(contract.address, 4); // ADMIN
await acm.connect(governance).setUserPermission(contract.address, 5); // OWNER
```

### 2. InvalidPermissionLevelTransition 错误

**问题**: 设置权限时出现 `InvalidPermissionLevelTransition` 错误

**原因**: 违反了权限转换规则

**解决方案**:
```typescript
// 逐步升级权限
await acm.connect(governance).setUserPermission(contract.address, 4); // 先设为 ADMIN
await acm.connect(governance).setUserPermission(contract.address, 5); // 再设为 OWNER
```

### 3. MissingRole 错误

**问题**: 用户执行操作时出现 `MissingRole` 错误

**原因**: 用户没有必要的角色

**解决方案**:
```typescript
// 为用户授予角色
await acm.connect(governance).grantRole(ROLE_HASH, user.address);
```

### 4. 角色哈希不匹配

**问题**: 角色验证失败

**原因**: 角色哈希计算方式不一致

**解决方案**:
```typescript
// 使用 ActionKeys 中定义的角色
const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('BORROW'));
const GOVERNANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
```

---

## 代码示例

### 完整的 RWA 合约示例

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IAccessControlManager } from "./interfaces/IAccessControlManager.sol";
import { ActionKeys } from "./constants/ActionKeys.sol";
import { VaultTypes } from "./Vault/VaultTypes.sol";
import { ZeroAddress } from "./errors/StandardErrors.sol";

contract RWALendingContract is Initializable, UUPSUpgradeable {
    IAccessControlManager public acm;
    
    // 角色定义
    bytes32 public constant OPERATOR_ROLE = ActionKeys.ACTION_DEPOSIT;
    bytes32 public constant GOVERNANCE_ROLE = ActionKeys.ACTION_SET_PARAMETER;
    
    // 状态变量
    uint256 public maxLoanAmount;
    uint256 public interestRate;
    
    // 事件
    event LoanCreated(address indexed borrower, uint256 amount, uint256 timestamp);
    event ParameterUpdated(string param, uint256 oldValue, uint256 newValue, uint256 timestamp);
    
    function initialize(
        address acmAddr,
        uint256 _maxLoanAmount,
        uint256 _interestRate
    ) external initializer {
        if (acmAddr == address(0)) revert ZeroAddress();
        
        acm = IAccessControlManager(acmAddr);
        maxLoanAmount = _maxLoanAmount;
        interestRate = _interestRate;
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            "initialize",
            msg.sender,
            block.timestamp
        );
    }
    
    // 权限验证函数
    function requireOperatorRole() internal view {
        acm.requireRole(OPERATOR_ROLE, msg.sender);
    }
    
    function requireGovernanceRole() internal view {
        acm.requireRole(GOVERNANCE_ROLE, msg.sender);
    }
    
    // 业务函数
    function createLoan(uint256 amount) external {
        requireOperatorRole();
        if (amount > maxLoanAmount) revert("Amount exceeds maximum");
        
        // 业务逻辑
        emit LoanCreated(msg.sender, amount, block.timestamp);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            "createLoan",
            msg.sender,
            block.timestamp
        );
    }
    
    function setMaxLoanAmount(uint256 newAmount) external {
        requireGovernanceRole();
        
        uint256 oldAmount = maxLoanAmount;
        maxLoanAmount = newAmount;
        
        emit ParameterUpdated("maxLoanAmount", oldAmount, newAmount, block.timestamp);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            "setMaxLoanAmount",
            msg.sender,
            block.timestamp
        );
    }
    
    function setInterestRate(uint256 newRate) external {
        requireGovernanceRole();
        
        uint256 oldRate = interestRate;
        interestRate = newRate;
        
        emit ParameterUpdated("interestRate", oldRate, newRate, block.timestamp);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            "setInterestRate",
            msg.sender,
            block.timestamp
        );
    }
    
    // 查询函数
    function isOperator(address account) external view returns (bool) {
        return acm.hasRole(OPERATOR_ROLE, account);
    }
    
    function isGovernance(address account) external view returns (bool) {
        return acm.hasRole(GOVERNANCE_ROLE, account);
    }
    
    // 升级函数
    function _authorizeUpgrade(address newImplementation) internal override {
        requireGovernanceRole();
    }
}
```

### 部署脚本示例

```typescript
import { ethers, upgrades } from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    
    // 1. 部署 ACM
    const ACMFactory = await ethers.getContractFactory("AccessControlManager");
    const acm = await ACMFactory.connect(deployer).deploy(deployer.address);
    await acm.waitForDeployment();
    
    // 2. 部署 RWA 合约
    const RWAFactory = await ethers.getContractFactory("RWALendingContract");
    const rwaContract = await upgrades.deployProxy(
        RWAFactory,
        [acm.address, ethers.parseEther("1000000"), 500], // 100万最大贷款，5%利率
        { kind: "uups" }
    );
    await rwaContract.waitForDeployment();
    
    // 3. 设置权限
    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
    const GOVERNANCE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));
    
    // 为 deployer 授予角色
    await acm.connect(deployer).grantRole(GOVERNANCE_ROLE, deployer.address);
    await acm.connect(deployer).grantRole(OPERATOR_ROLE, deployer.address);
    
    // 为 RWA 合约授予权限
    await acm.connect(deployer).setUserPermission(rwaContract.address, 4); // ADMIN
    await acm.connect(deployer).setUserPermission(rwaContract.address, 5); // OWNER
    
    console.log("部署完成！");
    console.log("ACM:", await acm.getAddress());
    console.log("RWA Contract:", await rwaContract.getAddress());
}

main().catch(console.error);
```

---

## 总结

RWA 借贷平台的权限管理系统提供了：

1. **统一的权限控制**: 通过 ACM 统一管理所有权限
2. **模块化设计**: 每个模块独立管理自己的权限
3. **标准化接口**: 使用 ActionKeys 和 VaultTypes 提供标准化接口
4. **安全审计**: 完整的事件记录和权限追踪
5. **灵活扩展**: 支持多级权限和角色管理
6. **安全升级**: 支持 UUPS 升级模式

遵循本指南，可以确保 RWA 借贷合约的安全性、可维护性和可扩展性。

---

> **文档版本**: v2.0  
> **最近更新**: 2025-01-27  
> **适用项目**: RWA 借贷平台  
> **维护者**: 开发团队 
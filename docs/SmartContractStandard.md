# RWA 借贷平台智能合约开发规范

## 1. 引言

本文档旨在为 RWA 借贷平台的智能合约开发提供一套统一、安全、高效的规范。所有合约开发者都必须遵循此规范，以确保代码的质量、可维护性和安全性。

## 2. 核心原则

-   **安全第一**: 安全是最高优先级。所有设计和实现都必须优先考虑安全性。
-   **代码清晰**: 代码应易于阅读和理解。清晰性优于技巧性。
-   **模块化设计**: 功能应解耦，每个合约专注于一个核心职责。
-   **Gas 效率**: 在不牺牲安全和清晰度的前提下，优化 Gas 消耗。

## 3. 文件结构与命名

### 3.1. 项目目录结构

项目采用标准的 Hardhat 目录结构。

```
contracts/
├─ constants/                   # 常量库（ModuleKeys / ActionKeys）
│  ├─ ModuleKeys.sol           # 模块 KEY_ 常量及映射函数
│  └─ ActionKeys.sol           # 动作 ACTION_ 常量及映射函数
├─ Vault/                      # 核心业务 Vault 合约聚合层
│  ├─ VaultMath.sol            # 统一数学计算库
├─ registry/                    # Timelock 模块注册中心
│  └─ Registry.sol              # schedule / execute / cancel 模块地址
├─ vault/                       # 对外路由层
│  └─ VaultRouter.sol           # 调度 CollateralManager、LendingEngine 等模块
├─ Vault/                      # 核心业务 Vault 合约聚合层
│  ├─ CollateralVault.sol          # 聚合调用路由，面向前端暴露 API
│  ├─ CollateralVaultStorage.sol   # 所有存储变量（upgrade-safe）
│  ├─ CollateralVaultAccess.sol    # 权限修饰符集合
│  ├─ CollateralVaultTypes.sol     # 错误、事件、常量
│  ├─ VaultMath.sol                # 统一数学计算库
│  ├─ CollateralVaultView.sol      # 只读接口聚合
│  └─ modules/                     # 具体业务子模块
│     ├─ CollateralManager.sol        # 抵押资产管理
│     ├─ LendingEngine.sol            # 借贷账本
│     ├─ HealthFactorCalculator.sol   # HF 计算/清算判定
│     ├─ StatisticsView.sol           # 统计视图（替代 VaultStatistics）
│     └─ ValuationOracleAdapter.sol   # 价格预言机适配
│  └─ IAccessControlManager.sol # requireRole / hasRole 接口
├─ mocks/                       # 单元 / 集成测试用 Mock 合约
│  ├─ MockCollateralManager.sol # 模拟抵押管理
│  ├─ MockLendingEngine.sol     # 模拟借贷引擎
│  └─ MockAccessControlManager.sol # 可配置角色的 Mock
└─ Libraries/                    # 工具库
```

#### 3.1.1 模块功能说明

| 模块 | 主要职责 | 关键交互 |
|------|----------|----------|
| **CollateralManager** | 1. 用户存 / 取抵押品<br/>2. 调用 PriceOracle 获取实时价格<br/>3. 校验 `minCollateralValue`（最小抵押价值）<br/>4. 计算并上报手续费至 FeeRouter | • PriceOracle<br/>• FeeRouter<br/>• Vault / LendingPool |
| **LoanFactory** | 1. 根据借贷条款部署 Loan 合约（proxy / clone）<br/>2. 校验参数合法性（借款人、额度、期限） | • MatchEngine<br/>• CollateralManager<br/>• LoanManager |
| **LoanManager** | 1. 铸造并管理 Loan NFT（ERC-721）<br/>2. 记录 Loan 条款与状态<br/>3. 提供查询、批量过滤接口 | • LoanFactory<br/>• LendingPool<br/>• LiquidationEngine |
| **LendingPool** | 1. 承接 USDT 等稳定币流动性<br/>2. 根据 Loan 条款放款并收息<br/>3. 扣除还款手续费并分发 | • LoanManager<br/>• RewardManager<br/>• FeeRouter |
| **LiquidationEngine** | 1. 监控贷款健康度（与 Oracle / CollateralManager 协作）<br/>2. 触发违约清算逻辑<br/>3. 分配清算所得资产 | • LoanManager<br/>• CollateralManager<br/>• LendingPool |
| **RewardManager** | 1. 依据借贷 / 清算行为发放平台积分<br/>2. 积分可接入 DAO 治理、费用折扣、空投等<br/>3. 提供可升级的奖励规则接口 | • LendingPool<br/>• Governance |
| **MatchEngine** | 1. 链下 / 混合模式撮合投资者与借款人<br/>2. 调用 LoanFactory & CollateralManager 完成撮配<br/>3. 输出撮合报告供链上验证 | • LoanFactory<br/>• CollateralManager |
| **ModuleKeys** | 提供全局 `bytes32` 模块常量，避免硬编码，支持字符串映射 | • Registry<br/>• VaultRouter |
| **ActionKeys** | 提供全局 `bytes32` 动作常量，用于权限分发和事件追踪 | • Registry<br/>• VaultRouter |
| **Registry** | 1. `key => address` 模块地址映射<br/>2. 延时升级三步：`schedule / cancel / execute`<br/>3. 仅 Timelock / DAO 拥有者可操作 | • VaultRouter<br/>• Governance |
| **VaultRouter** | 1. 统一入口，校验权限并路由至具体模块<br/>2. 触发标准化事件 `VaultAction`<br/>3. 支持 pause / upgrade 跟随 Router 合约 | • Registry<br/>• AccessControlManager |
| **AccessControlManager** | 1. 集中角色管理 (`requireRole / hasRole`)<br/>2. 支持角色动态增删、事件通知 | • 全链路调用者（VaultRouter / 模块） |
| **CollateralVault** | 1. 对外 API：`depositAndBorrow / repayAndWithdraw`<br/>2. 聚合子模块 & 权限校验<br/>3. 触发统一事件 | • CollateralManager<br/>• LendingEngine<br/>• HealthFactorCalculator |
| **CollateralManager** | 管理用户抵押物 & 限额；与 Oracle 交互 | • CollateralVault<br/>• Registry |
| **LendingEngine** | 记录债务余额 & 利息；处理借款/还款 | • CollateralVault |
| **HealthFactorCalculator** | 计算 HF、决定清算条件 | • CollateralVault<br/>• CollateralManager |
| **StatisticsView** | 统计写入(push*)与只读查询 | • CollateralVault |
| **ValuationOracleAdapter** | 多预言机聚合价格 | • CollateralManager |

### 3.2. 模块与动作常量库（ModuleKeys / ActionKeys）

为实现高可维护性、可扩展性和类型安全，平台将所有全局常量分为两大类：

- **ModuleKeys**：所有模块唯一标识（如 `KEY_VAULT_CORE`、`KEY_ACCESS_CONTROL_MANAGER`），用于动态注册、查找、权限校验等。
- **ActionKeys**：所有系统动作唯一标识（如 `ACTION_CLAIM_REWARD`、`ACTION_UPDATE_PRICE`），用于权限分发、事件追踪等。

#### 3.2.1 设计原则
- **常量命名**：`KEY_XXX` / `ACTION_XXX`，类型为 `bytes32 constant`。
- **字符串映射**：所有 key 均支持 lowerCamelCase 字符串与 bytes32 常量的双向映射。
- **错误处理**：未知字符串严格 revert，防止隐性错误。
- **版本化扩展**：预留 `KEY_XXX_V2` 等常量，便于平滑升级。

#### 3.2.2 典型用法
```solidity
import { ModuleKeys } from "contracts/constants/ModuleKeys.sol";
import { ActionKeys } from "contracts/constants/ActionKeys.sol";

// 动态查找模块
address registry = IVaultStorage(vaultStorage).getNamedModule(
    ModuleKeys.getModuleKeyFromString("registry")
);

// 动作权限分发
if (actionKey == ActionKeys.ACTION_CLAIM_REWARD) {
    // 处理积分领取逻辑
}

// 模块注册
IVaultStorage(vaultStorage).registerModule(
    ModuleKeys.getModuleKeyString(ModuleKeys.KEY_COLLATERAL_MANAGER),
    collateralManagerAddress
);
```

#### 3.2.3 映射函数
- `getModuleKeyFromString(string memory name) returns (bytes32)`
- `getModuleKeyString(bytes32 key) returns (string memory)`
- `getActionKeyFromString(string memory name) returns (bytes32)`
- `getActionKeyString(bytes32 key) returns (string memory)`

所有映射函数遇到未知字符串/常量时，均会 revert，保证类型安全。

#### 3.2.4 测试要求
- 覆盖所有 key 的正向/逆向映射
- 覆盖所有 revert 分支
- 类型安全校验
- 版本化常量测试

#### 3.2.5 历史兼容说明
> **注意**：`Constants.sol` 已废弃，所有新开发必须使用 `ModuleKeys.sol` 和 `ActionKeys.sol`。

### 3.3. 命名约定与规范

#### 3.3.1. 基础命名规则

| 类型 | 命名规范 | 示例 | 说明 |
|------|----------|------|------|
| **合约名** | PascalCase | `VaultManager.sol` | 类名风格 |
| **接口名** | I + PascalCase | `IVaultManager.sol` | 接口标识 |
| **函数名** | camelCase | `registerVault` | 动词开头 |
| **事件名** | PascalCase，过去时态 | `VaultCreated` | 描述已发生动作 |
| **枚举名** | PascalCase | `VaultStatus` | 类型名风格 |
| **错误类型** | PascalCase with `__` 前缀 | `VaultManager__NotOwner` | 合约名__错误描述 |
| **常量** | 全大写 + `_` | `TIMELOCK_DELAY` | 编译时常量 |
| **模块常量** | KEY_ + 全大写 | `KEY_VAULT_CORE` | 模块标识常量 |
| **动作常量** | ACTION_ + 全大写 | `ACTION_CLAIM_REWARD` | 动作标识常量 |
| **私有状态变量** | `_` + camelCase | `_owner`, `_vaultRegistry` | 私有属性标识 |
| **公共状态变量** | camelCase + `Var` | `totalLiquidityVar`, `pausedVar` | 避免与getter冲突 |
| **不可变变量** | camelCase + `Addr` | `rwaTokenAddr`, `vaultManagerAddr` | 地址类型变量 |
| **函数参数** | camelCase，语义化 | `initialOwner`, `targetVault` | 描述参数用途 |
| **函数内部变量** | camelCase | `newRate`, `totalAmount` | 局部变量 |
| **Struct字段** | camelCase | `vault`, `isActive`, `createdAt` | 与变量命名一致 |

#### 3.3.2. 特殊命名规则

1. **Getter函数与状态变量**
   ```solidity
   // ✅ 推荐 - 状态变量添加后缀
   address public immutable vaultManagerAddr;
   function vaultManager() external view returns (address) {
       return vaultManagerAddr;
   }
   ```

2. **地址类型变量**
   ```solidity
   // ✅ 推荐 - 地址类型添加Addr后缀
   address public immutable rwaTokenAddr;
   address private _ownerAddr;
   ```

3. **参数命名规则**
   ```solidity
   // 构造函数参数 - 使用 initial 前缀
   constructor(
       address initialRwaToken,
       address initialVaultManager
   )

   // 初始化函数参数 - 使用 initial 前缀
   function initialize(
       address initialRwaToken,
       address initialVaultManager
   )

   // setter函数参数 - 使用 new 前缀
   function setVaultManager(address newVaultManager)

   // 业务函数参数 - 使用描述性前缀
   function deposit(uint256 depositAmount)
   function withdraw(uint256 withdrawAmount)
   function liquidate(address targetUser, uint256 debtAmount)
   ```

4. **接口实现参数命名**
   ```solidity
   // 接口定义
   interface IVault {
       function initialize(address rwaToken, address vaultManager) external;
   }

   // ✅ 推荐 - 实现时使用明确的前缀
   contract Vault is IVault {
       function initialize(
           address initialRwaToken,
           address initialVaultManager
       ) external override {
           // 实现逻辑
       }
   }

   // ❌ 避免 - 与状态变量同名
   contract Vault is IVault {
       function initialize(
           address rwaToken,  // 与状态变量冲突
           address vaultManager  // 与状态变量冲突
       ) external override {
           // 实现逻辑
       }
   }
   ```

#### 3.3.3. 变量命名规范（避免遮蔽）

**成熟解决方案（推荐做法）**

| 层级 | 命名规范 | 示例 | 说明 |
|------|----------|------|------|
| 私有状态变量 | `_` + camelCase | `_owner`, `_vaultRegistry` | 私有属性标识 |
| 公共状态变量 | camelCase | `totalLiquidity`, `paused` | 公共属性 |
| 不可变变量 | camelCase | `rwaToken`, `vaultManager` | 构造函数设置 |
| 常量 | 全大写 + `_` | `TIMELOCK_DELAY` | 编译时常量 |
| 函数参数 | camelCase，语义化 | `newOwner`, `newVault` | 避免与状态变量同名 |
| 函数内部变量 | camelCase | `newRate`, `totalAmount` | 局部变量 |
| Struct字段 | camelCase | `vault`, `isActive`, `createdAt` | 与变量命名一致 |
| 保留名禁止使用 | 避免使用 `block`, `msg`, `tx`, `gas`, `address` | - | - |

**规范示例：**

```solidity
// ❌ 不推荐 - 变量遮蔽
address public owner;
function setOwner(address owner) public { 
    owner = owner; // 遮蔽警告
}

// ✅ 推荐 - 清晰命名
address private _owner;
function setOwner(address newOwner) public { 
    _owner = newOwner; // 无遮蔽
}

// ❌ 不推荐 - 参数与状态变量同名
IERC20 public immutable rwaToken;
function initialize(address rwaToken) external { ... }

// ✅ 推荐 - 语义化参数名
IERC20 public immutable rwaToken;
function initialize(address newRwaToken) external { ... }
```

#### 3.3.4. 状态变量命名详细规则

```solidity
// 私有状态变量 - 使用 _ 前缀
address private _owner;
mapping(address => bool) private _registrars;
uint256 private _totalVaults;

// 公共状态变量 - 不加前缀，但避免与函数参数重复
address public vaultManager;
uint256 public totalLiquidity;
bool public paused;

// 不可变变量 - 不加前缀
address public immutable whitelistRegistry;
IERC20 public immutable rwaToken;

// 常量 - 全大写
uint256 public constant TIMELOCK_DELAY = 2 days;
uint256 public constant COLLATERAL_FACTOR = 70;
```

#### 3.3.5. 函数参数命名最佳实践

```solidity
// ✅ 推荐 - 语义化参数名
function registerVault(address newVault, address newToken) external { ... }
function setOwner(address newOwner) external { ... }
function updateCollateralFactor(uint256 newFactor) external { ... }

// ❌ 避免 - 与状态变量同名
function setOwner(address owner) external { ... } // 与 _owner 冲突
function setVault(address vault) external { ... } // 与 _vault 冲突

// ✅ 推荐 - 接口实现时保持一致性
interface IVault {
    function initialize(address rwaToken, address vaultManager) external;
}

contract CollateralVault is IVault {
    // 参数名与接口保持一致
    function initialize(address rwaToken, address vaultManager) external override {
        // 实现逻辑
    }
}
```

#### 3.3.6. 错误和事件引用规范

为了提高代码的可读性和可维护性，错误和事件的引用应遵循以下规范：

1. **错误引用规范**
```solidity
// ❌ 避免 - 直接引用错误
revert CollateralVault__NotVaultManager();
revert HealthFactorCalculator__InvalidParameter("param", value);

// ✅ 推荐 - 使用完整的接口名称引用错误
revert ICollateralVaultErrors.CollateralVault__NotVaultManager();
revert ICollateralVaultErrors.HealthFactorCalculator__InvalidParameter("param", value);
```

2. **事件引用规范**
```solidity
// ❌ 避免 - 直接引用事件
emit UserStatusChanged(user, true, healthFactor, block.timestamp);
emit PriceDeviationDetected(oldPrice, newPrice, block.timestamp);

// ✅ 推荐 - 使用完整的接口名称引用事件
emit ICollateralVaultEvents.UserStatusChanged(user, true, healthFactor, block.timestamp);
emit ICollateralVaultEvents.PriceDeviationDetected(oldPrice, newPrice, block.timestamp);
```

3. **错误和事件接口组织**
```solidity
// ✅ 推荐 - 将错误定义在专门的接口中
interface ICollateralVaultErrors {
    error CollateralVault__NotVaultManager();
    error HealthFactorCalculator__InvalidParameter(string param, uint256 value);
    // ... 其他错误定义
}

// ✅ 推荐 - 将事件定义在专门的接口中
interface ICollateralVaultEvents {
    event UserStatusChanged(address user, bool status, uint256 healthFactor, uint256 timestamp);
    event PriceDeviationDetected(uint256 oldPrice, uint256 newPrice, uint256 timestamp);
    // ... 其他事件定义
}

// ✅ 推荐 - 在合约中继承错误和事件接口
contract HealthFactorCalculator is ICollateralVaultErrors, ICollateralVaultEvents {
    // ... 合约实现
}
```

4. **错误和事件命名空间管理**
- 错误和事件应该按照功能模块进行分组
- 使用清晰的前缀来区分不同模块的错误和事件
- 在一个模块内保持命名的一致性

5. **优点**
- 提高代码的可读性和可维护性
- 避免命名冲突
- 更好地追踪错误和事件的来源
- 符合 Solidity 最佳实践
- 便于代码审计和问题排查

### 3.4. 自动检测工具配置

#### 3.4.1. Solhint 配置

**安装 Solhint：**
```bash
npm install -g solhint
```

**创建配置文件 `.solhint.json`：**
```json
{
  "extends": "solhint:recommended",
  "rules": {
    "no-shadowed-variables": "error",
    "var-name-mixedcase": "error",
    "func-name-mixedcase": "error",
    "compiler-version": ["error", "^0.8.20"],
    "avoid-sha3": "warn",
    "avoid-low-level-calls": "warn",
    "no-unused-vars": "warn",
    "func-visibility": "warn",
    "state-visibility": "warn"
  }
}
```

**检查代码：**
```bash
solhint contracts/**/*.sol
```

**输出示例：**
```
contracts/VaultManager.sol
  58:21  error  "owner" is shadowing the state variable  no-shadowed-variables
  125:15  warning  Function state mutability can be restricted to pure  func-visibility
```

#### 3.4.2. Slither 配置

**安装 Slither：**
```bash
pip3 install slither-analyzer
```

**检查代码：**
```bash
slither contracts/ --exclude naming-convention
```

#### 3.4.3. CI/CD 集成

**GitHub Actions 示例：**
```yaml
name: Solidity Linting
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      - name: Install Solhint
        run: npm install -g solhint
      - name: Run Solhint
        run: solhint contracts/**/*.sol
```

### 3.5. 团队命名规范手册

#### 3.5.1. 命名约定检查清单

在代码审查时，检查以下项目：

- [ ] 合约名使用 PascalCase（如 `CollateralVault`）
- [ ] 接口名以 `I` 开头（如 `ICollateralManager`）
- [ ] 公共状态变量使用 camelCase（如 `loanAmount`）
- [ ] 私有状态变量使用 `_` 前缀（如 `_collateralRatio`）
- [ ] 函数参数不与状态变量同名（避免遮蔽）
- [ ] 常量使用全大写（如 `MAX_BPS`）
- [ ] 事件名使用过去时态（如 `OwnershipTransferred`）
- [ ] 错误类型使用 PascalCase 命名（如 `NotAuthorized()`）
- [ ] 避免使用保留字作为变量名（如 `address`, `block`, `data`）

#### 3.5.2. 常见命名问题及解决方案

| 问题类型     | 问题描述                         | 解决方案                                       |
|--------------|----------------------------------|------------------------------------------------|
| 变量遮蔽     | 函数参数与状态变量同名           | 使用语义化参数名，如 `newOwner` 或 `_owner`    |
| 未使用参数   | 接口实现中不需要的参数           | 注释掉参数名：如 `address /*user*/`            |
| 函数可见性   | 可加 `pure`/`view` 但未加        | 添加适当的可见性修饰符                        |
| 重复声明     | 继承链上同名函数未 override      | 明确使用 `override` 并确保签名一致            |
| 错误类型命名 | 错误类型使用 `__` 前缀不规范     | 改为 PascalCase，如 `ZeroAddress()`            |
| 常量命名     | 常量未大写或未使用下划线         | 使用全大写 + 下划线，如 `MAX_SUPPLY`           |
| 私有变量命名 | 私有变量无前缀或不易识别         | 使用 `_` 前缀提高可读性，如 `_interestRate`   |

### 命名统一改动记录（Phase 3）

| 原变量名     | 新变量名     | 文件名                              | 说明 |
|--------------|--------------|-------------------------------------|------|
| __gap        | _gap__       | contracts/Vault/CollateralVault.sol | 保持 slot 不动，仅改名 |
| hfCalculator | _hfCalculator| 同上                                | 避免遮蔽 |
| valuationOracle | _valuationOracle | 同上                            | 避免遮蔽 |

#### 3.5.3. 代码审查模板

```markdown
## 命名规范检查

### 基础命名
- [ ] 合约名：PascalCase ✅
- [ ] 接口名：I + PascalCase ✅
- [ ] 函数名：camelCase ✅
- [ ] 事件名：PascalCase + 过去时态 ✅

### 变量命名
- [ ] 公共状态变量：camelCase ✅
- [ ] 私有状态变量：_ 前缀 ✅
- [ ] 函数参数：无遮蔽 ✅
- [ ] 常量：全大写 ✅

### 错误命名
- [ ] 错误类型：PascalCase ✅

### 工具检查
- [ ] Solhint 通过 ✅
- [ ] Slither 通过 ✅
- [ ] 编译无警告 ✅

```

### 3.6. 进阶工具推荐

| 工具 | 功能 | 推荐原因 |
|------|------|----------|
| Solhint | 语法+命名+结构检查 | 支持 CI/CD，社区主流 |
| Slither | 安全分析工具 | 会检测 shadowing、dead code、reentrancy |
| Foundry + Forgefmt | 代码格式化 | 配合 Solhint 保持统一格式 |
| VS Code Solidity 插件 | 本地开发时自动高亮提示 | 有 Solhint 配置支持 |

## 4. 代码风格与布局

### 4.1. Solidity 版本
所有合约必须使用固定的编译器版本，以防止编译器 bug 带来的风险。
```solidity
pragma solidity ^0.8.20;
```

### 4.2. 合约布局顺序
合约内部代码应遵循以下顺序，以提高可读性：
1.  State Variables (状态变量)
2.  Events (事件)
3.  Modifiers (修饰符)
4.  Constructor (构造函数)
5.  External/Public Functions (外部/公共函数，按管理、核心、视图等功能分组)
6.  Internal Functions (内部函数)
7.  Private Functions (私有函数)

### 4.3. NatSpec 注释
所有 `public` 和 `external` 函数、以及所有合约都必须包含完整的 NatSpec 注释。
```solidity
/// @title VaultManager（极致安全版）
/// @author Your Name
/// @notice 管理 RWA Token 对应的金库
/// @dev 详细说明实现细节
contract VaultManager is IVaultManager, ReentrancyGuard, Pausable {
    // ...
}

/// @notice 注册一个新的金库
/// @param rwaToken RWA 代币地址
/// @param vault 金库合约地址
function registerVault(address rwaToken, address vault) external {
    // ...
}
```

- 使用 `/// @notice` 和 `/// @dev` 写清楚函数说明；
- 写好单元测试；
- 使用 `slither` 或 `hardhat analyze` 工具检查安全性；
- 确保符合 Solidity 0.8.x 最佳实践（如 Custom Error、immutable、unchecked 块等）

## 5. 核心安全模式 (Aave 级别)

### 5.1. Reentrancy Guard (防重入)
所有可能与外部合约交互并改变状态的函数都必须使用 `nonReentrant` 修饰符。
```solidity
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract MyContract is ReentrancyGuard {
    function criticalAction() external nonReentrant {
        // ...
    }
}
```

### 5.2. Checks-Effects-Interactions (CEI) 模式
**强制要求**：所有函数必须遵循 CEI 模式，先检查条件，然后更新自身状态，最后才与外部合约交互。

-   **错误示例**:
    ```solidity
    function withdraw(uint256 amount) external {
        // Interaction
        require(token.transfer(msg.sender, amount), "Transfer failed");
        // Effect
        balance[msg.sender] -= amount;
    }
    ```
-   **正确示例**:
    ```solidity
    function withdraw(uint256 amount) external {
        // Check
        require(balance[msg.sender] >= amount, "Insufficient balance");
        // Effect
        balance[msg.sender] -= amount;
        // Interaction
        require(token.transfer(msg.sender, amount), "Transfer failed");
    }
    ```

### 5.3. 访问控制
-   **分层权限**: 使用 `Owner` 和 `Operator` (或 `Registrar`) 两种角色。`Owner` 拥有最高权限，`Operator` 负责日常操作。
-   **修饰符**: 使用 `onlyOwner` 和 `onlyOperator` 修饰符进行权限控制。
-   **时间锁 (Timelock)**: **强烈建议**为所有关键的 `onlyOwner` 管理功能（如升级合约、修改关键参数）添加时间锁机制，为社区提供反应时间。

### 5.4. Pausable 紧急暂停
所有核心合约都应继承 `Pausable`，为应对紧急情况提供 "暂停开关"。
```solidity
import "@openzeppelin/contracts/utils/Pausable.sol";

contract MyContract is Pausable {
    function criticalAction() external whenNotPaused {
        // ...
    }

    function pause() external onlyOwner {
        _pause();
    }
}
```

### 5.5. 价格预言机安全
-   **强制检查**: 与预言机交互时，必须进行多重检查。
-   **永不回退到默认值**: 如果预言机调用失败，**必须** `revert`，绝不能使用默认值或旧价格。

    ```solidity
    function _getCollateralValue(address user) internal view returns (uint256) {
        // ...
        try priceOracle.getPrice(address(rwaToken)) returns (uint256 price) {
            // 1. 检查价格是否为零
            require(price > 0, "Oracle: Invalid price");
            // 2. 检查价格是否过时
            require(block.timestamp - priceOracle.lastUpdateTime() < PRICE_TIMEOUT, "Oracle: Stale price");
            // 3. (可选) 检查价格波动是否在合理范围内
            
            return (collateralAmount * price) / 1e8;
        } catch {
            revert("Oracle: Failed to get price");
        }
    }
    ```

### 5.6. 输入验证
-   所有接受外部输入的函数都必须对参数进行验证（如地址不能为零、数值在合理范围内）。
-   创建 `validAmount` 等可复用的修饰符。

### 5.7. 安全数学与 VaultMath 标准

#### 5.7.1. 基础安全要求
-   使用 Solidity `^0.8.0` 版本以上，利用其内置的溢出/下溢检查。
-   对于复杂的数学运算（如利息计算），需要添加额外的边界检查。

#### 5.7.2. VaultMath 统一数学计算标准

**设计原则：**
- **单一职责**：VaultMath 作为唯一的数学计算库
- **统一标准**：所有数学计算都使用 VaultMath 库
- **向后兼容**：VaultUtils 的数学函数保留但标记为已迁移
- **类型安全**：使用 Solidity 原生类型，避免精度损失

**核心功能：**
```solidity
library VaultMath {
    // 健康因子计算
    function calculateHealthFactor(uint256 collateral, uint256 debt) internal pure returns (uint256)
    
    // 贷款价值比计算
    function calculateLTV(uint256 debt, uint256 collateral) internal pure returns (uint256)
    
    // 百分比计算
    function percentageMul(uint256 value, uint256 percentage) internal pure returns (uint256)
    function percentageDiv(uint256 value, uint256 percentage) internal pure returns (uint256)
    
    // 债务和抵押计算
    function calculateMaxDebt(uint256 collateral, uint256 maxLTV) internal pure returns (uint256)
    function calculateMinCollateral(uint256 debt, uint256 maxLTV) internal pure returns (uint256)
    
    // 奖励和费用计算
    function calculateBonus(uint256 amount, uint256 bonus) internal pure returns (uint256)
    function calculateFee(uint256 amount, uint256 feeRate) internal pure returns (uint256)
}
```

**使用标准：**
```solidity
// ✅ 正确：使用 VaultMath 库
import { VaultMath } from "../VaultMath.sol";

function calculateUserHealthFactor(uint256 collateral, uint256 debt) internal pure returns (uint256) {
    return VaultMath.calculateHealthFactor(collateral, debt);
}

function calculateUserLTV(uint256 debt, uint256 collateral) internal pure returns (uint256) {
    return VaultMath.calculateLTV(debt, collateral);
}

function calculateFee(uint256 amount, uint256 feeRate) internal pure returns (uint256) {
    return VaultMath.calculateFee(amount, feeRate);
}
```

**❌ 避免做法：**
```solidity
// ❌ 错误：重复实现数学计算
function calculateHealthFactor(uint256 collateral, uint256 debt) internal pure returns (uint256) {
    if (debt == 0) return type(uint256).max;
    return (collateral * 10000) / debt;
}

// ❌ 错误：使用 VaultUtils 的数学函数（已迁移）
function calculateLTV(uint256 debt, uint256 collateral) internal pure returns (uint256) {
    return VaultUtils.calculateLTV(debt, collateral); // 已迁移到 VaultMath
}
```

**精度标准：**
- **健康因子**：以 basis points (bps) 为单位，10000 = 100%
- **LTV**：以 basis points (bps) 为单位，10000 = 100%
- **费用率**：以 basis points (bps) 为单位，100 = 1%
- **奖励率**：以 basis points (bps) 为单位，100 = 1%

## 6. 清算机制安全
-   **部分清算**: 必须支持部分清算，而不是一次性清算全部债务。这可以降低市场冲击和清算者的资金门槛。
-   **清算金额验证**: `liquidate` 函数必须验证 `debtToRepay` 金额的有效性。

## 7. 事件与错误处理
-   **详细事件**: 所有关键状态变更都必须发出包含详细信息的事件，并对关键参数（如 `user` 地址）进行 `indexed`。
-   **自定义错误**: 优先使用自定义错误而不是 `require` 字符串，以节省 Gas 并提供更清晰的错误信息。

    ```solidity
    error InvalidAmount(uint256 amount);
    if (amount == 0) {
        revert InvalidAmount(amount);
    }
    ```

## 8. 测试与审计
├── 8.1. 测试环境配置
├── 8.2. 合约方法调用标准
├── 8.3. 测试分类标准
├── 8.4. 测试文件结构标准
├── 8.5. 性能优化标准
├── 8.6. 最佳实践总结
├── 8.7. 脚本系统开发标准 ← 新增
├── 8.8. 环境验证
└── 8.9. 审计流程

### 8.1. 测试环境配置

#### 8.1.1. 技术栈标准
- **测试框架**: TypeScript + CommonJS + Hardhat + Ethers v6
- **测试覆盖率**: 核心合约的测试覆盖率目标为 **100%**
- **测试类型**: 必须覆盖单元测试、集成测试、安全场景测试（重入、预言机失败、数学溢出）和模糊测试

#### 8.1.2. 测试环境清理与"最后一个测试失败"问题解决

**问题描述**
在 Mocha/Hardhat 测试环境中，经常出现"最后一个测试失败"或测试套件异常挂起的问题，特别是在清理文件或修改测试环境后。这通常是由于测试环境没有正确清理，导致最后一个测试受到前面测试的影响。

**根本原因**
1. **测试环境未正确清理** - 合约实例、网络状态等资源未释放
2. **异步操作未完成** - 某些异步操作在测试结束后仍在运行
3. **内存泄漏** - 测试合约实例没有正确清理
4. **网络状态污染** - Hardhat 网络状态在测试间累积

**解决方案**

##### 8.1.2.1. Mocha 配置优化
在 `hardhat.config.ts` 中添加关键配置：

```typescript
mocha: {
  timeout: 40000,
  require: ['ts-node/register'],
  reporter: 'spec',
  slow: 1000,
  bail: false,
  // 添加这些关键设置来解决"最后一个测试失败"问题
  asyncOnly: false, // 允许同步测试
  reporterOptions: {
    verbose: true,
    showDiff: true,
  },
},
```

**注意**: 不要在 Hardhat 的 mocha 配置中添加 `exit: true`，因为 Hardhat 不支持该参数。

#### 8.1.3. ESM 导入修正
**❌ 错误写法：**
```typescript
import { ethers } from "hardhat";
```

**✅ 正确写法：**
```typescript
import hardhat from "hardhat";
const { ethers } = hardhat;
```

#### 8.1.4. 常量定义标准
```typescript
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ONE_ETH = ethers.parseUnits("1", 18);
const ONE_USD = ethers.parseUnits("1", 6);
```

### 8.1.5. ActionKeys/ModuleKeys 大小写敏感性与一致性要求

- **所有 ActionKeys/ModuleKeys 的字符串输入必须为小写**，如 'deposit'，'borrow'，'repay' 等。
- 合约实现严格区分大小写，只有小写字符串会被接受并映射为有效的 bytes32 key。
- 任何非小写（如 'Deposit'、'DEPOSIT'）都会被拒绝，并抛出明确的错误（revert reason: 'Unknown action name'）。
- 测试用例已覆盖所有常见场景，包括：
  - 小写字符串能正常通过，返回有效 key。
  - 大写/混合大小写字符串会被拒绝，且 revert 消息与断言完全一致。
- **最佳实践**：团队开发、脚本、前端等所有调用方，务必统一使用小写字符串，避免因大小写导致的权限或事件追踪异常。
- 相关测试文件：`test/constants/ActionKeys.test.ts`、`test/constants/ModuleKeys.test.ts`、`test/constants/ConstantsIntegration.test.ts` 均已实现严格验证。

#### 问题总结与解决方案汇总

- **问题1：ActionKeys/ModuleKeys 大小写敏感性**
  - 现象：'deposit' 能通过，'Deposit'/'DEPOSIT' 被拒绝。
  - 解决：合约和测试用例均已严格区分大小写，revert 消息为 'Unknown action name'。

- **问题2：Key 数量、顺序、内容、映射、唯一性**
  - 现象：历史上 key 数量或顺序不一致导致测试失败。
  - 解决：测试合约动态生成 key 数组，所有 key 唯一且顺序与库保持同步，已100%通过。

- **问题3：TypeScript 严格模式下数组类型推断**
  - 现象：`const arr: any[] = []` 在 strict 下被推断为 never[]，导致类型报错。
  - 解决：统一用 `new Array<string>()` 明确类型初始化，彻底避免 never[] 问题。

- **问题4：工厂类型导入与 TypeChain 兼容性**
  - 现象：找不到 `__factory` 文件或类型错误。
  - 解决：确保合约被 import，清理 artifacts/cache/types，重新编译，且只用具体工厂文件导入。

- **问题5：测试用例与合约实现断言不一致**
  - 现象：revert 消息或断言与合约实现不一致导致测试失败。
  - 解决：所有测试用例已与合约实现完全对齐，断言消息严格一致。

> 以上所有问题已在主干分支彻底修复，相关测试全部通过。后续如有新增 key 或变更，务必同步更新测试合约与用例。

+### 8.1.6. TypeScript 编译告警处理与 Mocha 用例命名规范
+
+#### 8.1.6.1. TypeScript 编译告警处理
+
+- **保持严格模式**：在 `tsconfig.json` 中永久启用 `"strict": true`，CI 在第一时间捕获潜在类型问题。
+- **优先修复警告**：能够通过完善类型、显式断言等方式消除的告警，应立即修复，而非掩盖。
+- **必要时使用 `@ts-expect-error`**：仅在确有业务/测试场景必须暂时绕过类型检查（例如 Stub、Mock、或尚未生成的合约类型）时使用，并**注明原因**。
+
+  ```typescript
+  // @ts-expect-error CollateralVault stub – method not typed
+  await vault.connect(alice).deposit(await collateralToken.getAddress(), amount);
+  ```
+
+  > 禁止使用 `@ts-ignore`。`@ts-expect-error` 会在类型问题消失时提示移除，维护成本更低。
+
+#### 8.1.6.2. Mocha 用例命名冲突与解决
+
+- **保证用例标题唯一**：`describe` / `it` 标题在整个仓库范围内必须保持唯一，避免 Mocha 统计阶段出现"✔ 通过但仍报 1) 失败"混淆。
+- **命名规范**：推荐使用 `模块名 – 功能描述` 的格式，例如 `ModuleKeys – 常量库设计原则`。
+- **冲突临时处理**：如需暂时保留重名用例，可使用 `describe.skip` 或 `it.skip` 跳过，待重构后再启用。
+- **重命名示例**：原 `ModuleKeys.test.ts` 已重命名为 `ModuleKeysDesign.test.ts`，彻底消除冲突。
+
+> 遵循以上规范，可显著减少 TypeScript 编译干扰与 Mocha 统计异常，确保 CI 流程稳定。

### 8.2. 合约方法调用标准

#### 8.2.1. 参数补全规则
所有合约方法调用必须补全所有必需参数：

```typescript
// ✅ 正确：补全 asset 参数
await vault.getUserPosition(user.address, ZERO_ADDRESS);
await vault.getHealthFactor(user.address, ZERO_ADDRESS);
await vault.getTotalCollateral(ZERO_ADDRESS);
await vault.getTotalDebt(ZERO_ADDRESS);

// ✅ 正确：补全所有参数
await vault.previewBorrow(user.address, ZERO_ADDRESS, collateralAmount, 0, borrowAmount);
await vault.previewDeposit(ZERO_ADDRESS, depositAmount);
```

#### 8.2.2. 精度处理标准
```typescript
// ✅ 正确：使用 ethers.parseUnits
const depositAmount = ethers.parseUnits("100", 18);
const borrowAmount = ethers.parseUnits("50", 6);

// ✅ 正确：BigInt 比较
expect(result).to.equal(0n);
expect(result).to.be.gt(ethers.parseUnits("1", 18));
```

#### 8.2.3. 错误处理标准
```typescript
// ✅ 正确：使用 .revertedWith
await expect(
  vault.connect(alice).borrow(ZERO_ADDRESS, invalidAmount)
).to.be.revertedWith("Insufficient collateral");

// ✅ 正确：使用 .reverted
await expect(
  vault.connect(alice).unauthorizedFunction()
).to.be.reverted;
```

### 8.3. 测试分类标准

#### 8.3.1. 权限控制测试
```typescript
describe("权限控制测试", function () {
  it("外部账户不应能直接调用关键函数", async function () {
    const { vault, alice } = await deployFixture();
    
    await expect(
      vault.connect(alice).adminOnlyFunction()
    ).to.be.revertedWith("Only admin allowed");
  });
  
  it("view 函数应不受权限限制", async function () {
    const { vault, alice } = await deployFixture();
    
    // view 函数应该可以正常调用
    const result = await vault.connect(alice).getUserPosition(alice.address, ZERO_ADDRESS);
    expect(result).to.be.defined;
  });
});
```

#### 8.3.2. 边界条件测试
```typescript
describe("边界条件测试", function () {
  it("零抵押时健康因子应为最大值", async function () {
    const { vault, alice } = await deployFixture();
    
    const hf = await vault.getHealthFactor(alice.address, ZERO_ADDRESS);
    expect(hf).to.equal(ethers.MaxUint256);
  });
  
  it("大额存款和借款应正常工作", async function () {
    const { vault, alice } = await deployFixture();
    
    const largeAmount = ethers.parseUnits("1000000", 18);
    await vault.connect(alice).deposit(ZERO_ADDRESS, largeAmount);
    
    const position = await vault.getUserPosition(alice.address, ZERO_ADDRESS);
    expect(position.collateral).to.equal(largeAmount);
  });
});
```

#### 8.3.3. 集成测试
```typescript
describe("集成测试", function () {
  it("完整借贷流程", async function () {
    const { vault, alice } = await deployFixture();
    
    // 1. 存款
    const depositAmount = ethers.parseUnits("100", 18);
    await vault.connect(alice).deposit(ZERO_ADDRESS, depositAmount);
    
    // 2. 借款
    const borrowAmount = ethers.parseUnits("30", 6);
    await vault.connect(alice).borrow(ZERO_ADDRESS, borrowAmount);
    
    // 3. 验证状态
    const position = await vault.getUserPosition(alice.address, ZERO_ADDRESS);
    expect(position.collateral).to.equal(depositAmount);
    expect(position.debt).to.equal(borrowAmount);
    
    // 4. 验证健康因子
    const hf = await vault.getHealthFactor(alice.address, ZERO_ADDRESS);
    expect(hf).to.be.gt(Number(ethers.parseUnits("1", 18)));
  });
});
```

### 8.4. 测试文件结构标准

#### 8.4.1. 标准测试文件模板与 TypeScript/ESLint 最佳实践

##### 8.4.1.1. 基础测试模板
```typescript


export default config;
/**
 * 模块描述
 * 
 * 测试目标:
 * - 功能点1
 * - 功能点2
 * - 功能点3
 */
describe('ContractName – 测试模块', function () {
  async function deployFixture() {
    // 部署测试环境
    const [governance, alice, bob]: SignerWithAddress[] = await ethers.getSigners();
    
    // 部署合约
    const vaultFactory = (await ethers.getContractFactory('CollateralVault')) as CollateralVault__factory;
    const vault = await vaultFactory.deploy();
    await vault.waitForDeployment();
    
    return { vault, governance, alice, bob };
  }

  it('应正确执行功能', async function () {
    const { vault, alice } = await deployFixture();
    
    // 测试逻辑
    const result = await vault.someFunction(alice.address, ZERO_ADDRESS);
    expect(result).to.equal(expectedValue);
  });
});
```

##### 8.4.1.2. TypeScript 类型安全最佳实践

**问题诊断与解决方案**

###### 问题1: `any` 类型使用
```typescript
// ❌ 错误做法
private priceUpdater: any;
private priceOracle: any;

// ✅ 正确做法 - 使用生成的合约类型
import type { 
  CoinGeckoPriceUpdater,
  PriceOracle
} from '../types';

class CoinGeckoKeeper {
  private priceUpdater!: CoinGeckoPriceUpdater;
  private priceOracle!: PriceOracle;
}
```

###### 问题2: 交易收据类型
```typescript
// ❌ 错误做法
const receipt = await tx.wait() as any;

// ✅ 正确做法 - 使用 ethers 类型
import type { ContractTransactionReceipt } from 'ethers';

const receipt = await tx.wait();
if (receipt) {
  // 处理收据
  this.listenToEvents(receipt);
}

private async listenToEvents(receipt: ContractTransactionReceipt) {
  // 类型安全的事件处理
}
```

###### 问题3: 合约实例类型转换
```typescript
// ❌ 错误做法
this.priceUpdater = PriceUpdater.attach(priceUpdaterAddress);

// ✅ 正确做法 - 使用类型断言
this.priceUpdater = PriceUpdater.attach(priceUpdaterAddress) as CoinGeckoPriceUpdater;
this.priceOracle = PriceOracle.attach(priceOracleAddress) as PriceOracle;
```

##### 8.4.1.3. ESLint 规范遵循
ESLint 仍会提示单双引号、any 等风格问题，属于样式层面，功能不受影响，可后续统一 npm run lint:ts --fix 批量处理。
若将来需要在脚本里继续使用顶层 await，保持 module: 'ESNext' 即可；否则请改为 async function main() { … } 并在结尾调用。
.addresses.json 请确保在前序部署流程正确生成并包含 assetWhitelist、acm 等地址。

导入规范：
// ✅ 推荐做法 - 使用 require 导入 hardhat
const hre = require('hardhat');
const { ethers } = hre;
const { upgrades } = hre;

// ✅ 推荐做法 - 其他模块使用 ES Module 导入
import fs from 'fs';
import path from 'path';

// ❌ 不推荐做法 - 不要直接从 hardhat 导入 ethers
import { ethers } from 'hardhat';

引号规范：
// ✅ 正确做法 - 使用单引号
import fs from 'fs';
console.log('正确消息');

// ❌ 错误做法 - 不使用双引号
import fs from "fs";
console.log("错误消息");

未使用变量处理：
// ✅ 正确做法 - 使用下划线前缀
const { deployer, _governance, _admin } = await ethers.getSigners();

// ❌ 错误做法 - 未使用变量没有下划线前缀
const { deployer, governance, admin } = await ethers.getSigners();

项目配置：
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import '@openzeppelin/hardhat-upgrades';
import '@nomicfoundation/hardhat-chai-matchers';
import '@nomicfoundation/hardhat-ethers';
import 'dotenv/config';

// 添加类型声明
declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    ethers: typeof import('@nomicfoundation/hardhat-ethers').ethers;
    upgrades: typeof import('@openzeppelin/hardhat-upgrades').upgrades;
  }
}

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: {
        enabled: true,
        runs: 800,
      },
      viaIR: true,
    },
  },
  // ... 其他配置
};

export default config;

**缩进规范**
```typescript
// ❌ 错误做法 - 缩进不一致
switch (command) {
  case 'update':
    if (args.length < 4) {
      console.log('用法错误');
    }
    break;
}

// ✅ 正确做法 - 统一缩进
switch (command) {
case 'update':
  if (args.length < 4) {
    console.log('用法错误');
  }
  break;
}
```

**未使用变量处理**
```typescript
// ❌ 错误做法 - 未使用变量警告
const { vault, governance, alice, bob } = await deployFixture();
// 只使用了 vault 和 alice

// ✅ 正确做法 - 使用下划线前缀
const { vault, _governance, alice, _bob } = await deployFixture();
```

**异步函数处理：
// ✅ 推荐做法 - 使用 async 函数包装
async function main() {
  // 部署逻辑
}

// 调用主函数
main().catch((error) => {
  console.error('部署过程中出错:', error);
  process.exit(1);
});

// ❌ 不推荐做法 - 直接使用顶层 await
await deployContracts();

**错误处理：
// ✅ 推荐做法 - 使用 try-catch 并提供详细错误信息
try {
  await deployContracts();
} catch (error) {
  console.error('❌ 部署失败 Deployment failed:', error);
  throw error;
}

// ❌ 错误做法 - 没有错误处理
await deployContracts();

**注释规范：
/**
 * 函数说明 - 中英文对照
 * Function description - English translation
 * @param name 参数说明 Parameter description
 */
async function deployContract(name: string): Promise<string> {
  // 实现逻辑
}

##### 8.4.1.4. Hardhat 与 TypeScript 适配

**项目配置要求**

1. **tsconfig.json 配置**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "strict": true,
    "skipLibCheck": true,
    "noImplicitAny": false,
    "types": [
      "node",
      "chai",
      "mocha",
      "hardhat",
      "@openzeppelin/hardhat-upgrades",
      "@nomicfoundation/hardhat-chai-matchers"
    ]
  },
  "include": ["test/**/*", "scripts/**/*", "types/**/*", "hardhat.config.ts"],
  "exclude": ["node_modules"]
}
```

2. **hardhat.config.ts 配置**
```typescript
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import '@openzeppelin/hardhat-upgrades';
import '@nomicfoundation/hardhat-chai-matchers';
import '@nomicfoundation/hardhat-ethers';
import 'dotenv/config';

// 添加 Hardhat Runtime 类型扩展
declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    ethers: typeof import('@nomicfoundation/hardhat-ethers').ethers;
    upgrades: typeof import('@openzeppelin/hardhat-upgrades').upgrades;
  }
}

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: {
        enabled: true,
        runs: 800,
      },
      viaIR: true, // 启用 viaIR 解决 Stack too deep 错误
    },
  },
  networks: {
    hardhat: {
      chainId: 1337,
    },
    // 其他网络配置...
  },
  // 其他配置项...
};

export default config;
```

3. **关键依赖说明**

项目已经在 package.json 中包含了所需依赖:
```json
{
  "devDependencies": {
    "@nomicfoundation/hardhat-chai-matchers": "^2.0.0",
    "@nomicfoundation/hardhat-ethers": "^3.0.9",
    "@nomicfoundation/hardhat-toolbox": "^5.0.0",
    "@openzeppelin/hardhat-upgrades": "^3.9.0",
    "@typescript-eslint/eslint-plugin": "^6.21.0",
    "@typescript-eslint/parser": "^6.21.0",
    "typescript": "^5.8.3"
  }
}
```

4. **使用说明**

a. TypeScript 脚本编写
```typescript
// 使用 require 导入 hardhat
const hre = require('hardhat');
const { ethers } = hre;
const { upgrades } = hre;

// 其他模块使用 ES Module 导入
import fs from 'fs';
import path from 'path';
```

b. 合约交互
```typescript
// 使用 ethers 获取合约工厂
const factory = await ethers.getContractFactory('ContractName');

// 部署可升级合约
const proxy = await upgrades.deployProxy(factory, [...args]);
await proxy.waitForDeployment();
```

c. 类型检查
- 使用 TypeScript 生成的合约类型
- 避免使用 `any` 类型
- 必要时使用类型断言

d. 脚本执行
```bash
# 使用 ts-node 运行 TypeScript 脚本
npx hardhat run scripts/your-script.ts

# 指定网络
npx hardhat run scripts/your-script.ts --network arbitrum-sepolia
```

5. **验证标准**

验证脚本代码质量时，需要满足以下标准：

- ✅ **TypeScript 编译**：无错误，允许必要的警告
- ✅ **ESLint 检查**：无错误，警告数量最小化
- ✅ **类型安全**：消除所有 `any` 类型使用
- ✅ **错误处理**：标准化错误处理流程
- ✅ **代码质量**：符合项目编码规范

示例验证流程：
```bash
# TypeScript 编译检查
npx tsc --noEmit

# ESLint 检查
npx eslint scripts/ --format=compact

# 运行测试
npm test
```

# 1. 合约大小分析（您之前遇到的问题）
npx hardhat size-contracts

# 2. Gas 报告（正确的用法）
REPORT_GAS=true npx hardhat test

# 3. 其他有用的命令
npx hardhat compile          # 编译合约
npx hardhat test            # 运行测试
npx hardhat coverage        # 覆盖率测试
npx hardhat solhint         # 代码质量检查
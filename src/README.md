# 智能合约源代码目录 (Smart Contract Source Code)

本目录包含 RWA Lending Platform（现实世界资产借贷平台）的完整智能合约源代码。系统采用模块化架构设计，通过 Registry 系统实现统一的模块管理和升级能力。

## 📁 目录结构

```
src/
├── access/                    # 访问控制模块
├── constants/                 # 常量定义（ModuleKeys, ActionKeys等）
├── core/                      # 核心业务合约
├── errors/                    # 标准错误定义
├── Governance/                # 治理模块
├── interfaces/                # 接口定义
├── libraries/                # 共享库文件
├── Mocks/                    # 测试用 Mock 合约
├── monitor/                  # 系统监控模块
├── registry/                 # Registry 模块注册系统
├── Reward/                   # 奖励系统
├── strategies/               # 策略合约
├── Token/                    # 代币合约
├── utils/                    # 工具库
└── Vault/                    # 金库系统（核心业务逻辑）
```

---

## 🏗️ 架构概览

### 核心设计原则

1. **模块化架构**：所有功能模块通过 Registry 系统统一管理
2. **可升级性**：使用 UUPS 代理模式，支持合约升级
3. **权限控制**：统一的 AccessControlManager 权限管理
4. **标准化**：使用 ModuleKeys 和 ActionKeys 进行标准化标识
5. **事件驱动**：统一的事件系统，支持链下数据收集和分析

### 系统层次

```
┌─────────────────────────────────────────┐
│         Registry (模块注册中心)          │
│  统一管理所有模块地址和升级流程            │
└─────────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
┌───────▼──────┐ ┌──▼──────┐ ┌──▼──────┐
│   Vault      │ │  Reward │ │  Core   │
│  (金库系统)   │ │ (奖励)  │ │ (核心)  │
└──────────────┘ └─────────┘ └─────────┘
```

---

## 📦 主要模块

### 1. Registry 系统 (`registry/`)

**核心功能**：模块注册中心，统一管理所有模块地址

**主要合约**：
- `Registry.sol` - 主注册表入口
- `RegistryCore.sol` - 核心业务逻辑
- `RegistryUpgradeManager.sol` - 升级管理器
- `RegistryAdmin.sol` - 治理管理员
- `RegistryDynamicModuleKey.sol` - 动态模块键注册表

**关键特性**：
- 模块地址映射管理
- UUPS 可升级支持
- Timelock 延迟升级
- 升级历史记录
- 批量操作支持

**使用示例**：
```solidity
import { Registry } from "./registry/Registry.sol";
import { ModuleKeys } from "./constants/ModuleKeys.sol";

Registry registry = Registry(registryAddress);
address vaultCore = registry.getModule(ModuleKeys.KEY_VAULT_CORE);
```

---

### 2. Vault 系统 (`Vault/`)

**核心功能**：金库系统，管理抵押物、借贷、还款等核心业务逻辑

**主要合约**：

#### 核心合约
- `VaultCore.sol` - 核心业务入口，处理用户操作
- `VaultRouter.sol` - 查询接口，提供所有 view 函数
- `VaultStorage.sol` - 存储合约，管理配置和模块地址
- `VaultRouter.sol` - 路由合约，分发请求到对应模块

#### 业务模块 (`modules/`)
- `CollateralManager.sol` - 抵押物管理
- `VaultLendingEngine.sol` - 借贷引擎
- `VaultBusinessLogic.sol` - 业务逻辑
- `EarlyRepaymentGuaranteeManager.sol` - 提前还款保证金
- `GuaranteeFundManager.sol` - 担保基金管理

#### 清算模块 (`liquidation/`)
- `LiquidationManager.sol` - 清算管理器
- `LiquidationRiskManager.sol` - 清算风险管理
- `LiquidationCalculator.sol` - 清算计算器
- `LiquidationRewardManager.sol` - 清算奖励管理
- 等 13+ 个清算相关模块

#### 视图模块 (`view/modules/`)
- `HealthView.sol` - 健康度视图
- `StatisticsView.sol` - 统计视图
- `UserView.sol` - 用户视图
- `PositionView.sol` - 持仓视图
- `RiskView.sol` - 风险视图
- 等 20+ 个视图模块

#### 工具库
- `VaultMath.sol` - 数学计算库
- `VaultUtils.sol` - 工具函数库
- `VaultTypes.sol` - 类型定义

**详细文档**：参见 [Vault/README.md](./Vault/README.md)

---

### 3. Reward 系统 (`Reward/`)

**核心功能**：奖励积分系统，管理用户积分、消费和特权

**主要合约**：
- `RewardPoints.sol` - 奖励积分代币（ERC20）
- `RewardCore.sol` - 奖励核心逻辑
- `RewardManager.sol` - 奖励管理器
- `RewardManagerCore.sol` - 奖励管理核心
- `RewardConfig.sol` - 奖励配置
- `RewardConsumption.sol` - 奖励消费

**服务配置** (`configs/`)：
- `AdvancedAnalyticsConfig.sol` - 高级数据分析配置
- `FeatureUnlockConfig.sol` - 功能解锁配置
- `GovernanceAccessConfig.sol` - 治理访问配置
- `PriorityServiceConfig.sol` - 优先服务配置
- `TestnetFeaturesConfig.sol` - 测试网功能配置

**关键特性**：
- 积分奖励和消费
- 用户特权管理
- 服务配置管理
- 批量操作支持

---

### 4. Core 模块 (`core/`)

**核心功能**：核心业务合约

**主要合约**：
- `PriceOracle.sol` - 价格预言机
  - 支持多资产价格查询
  - CoinGecko 价格集成
  - 价格时效性验证
  
- `CoinGeckoPriceUpdater.sol` - CoinGecko 价格更新器
  - 批量价格更新
  - 价格数据验证

- `FeeRouter.sol` - 手续费路由
  - 统一手续费管理
  - 多资产手续费配置

- `LendingEngine.sol` - 借贷引擎
  - 贷款订单管理
  - 生命周期管理

- `LoanNFT.sol` - 贷款 NFT
  - ERC-721 标准
  - 灵魂绑定代币支持
  - 贷款凭证管理

- `LoanEvents.sol` - 贷款事件定义

---

### 5. Access 控制 (`access/`)

**核心功能**：访问控制和权限管理

**主要合约**：
- `AccessControlManager.sol` - 访问控制管理器
  - 统一权限管理
  - 角色和权限映射
  
- `AccessControlCore.sol` - 访问控制核心逻辑
- `AccessControlLibrary.sol` - 访问控制库
- `AssetWhitelist.sol` - 资产白名单
- `AuthorityWhitelist.sol` - 授权机构白名单

**关键特性**：
- 基于 ActionKeys 的权限控制
- 细粒度权限管理
- 白名单管理

---

### 6. Monitor 模块 (`monitor/`)

**核心功能**：系统监控和降级管理

**主要合约**：
- `DegradationCore.sol` - 降级核心
- `DegradationMonitor.sol` - 降级监控器
- `DegradationStorage.sol` - 降级存储
- `GracefulDegradation.sol` - 优雅降级库

**关键特性**：
- 模块健康监控
- 优雅降级机制
- 系统状态追踪

---

### 7. Constants (`constants/`)

**核心功能**：系统常量和配置

**主要文件**：
- `ModuleKeys.sol` - 模块键常量
  - 所有模块的 bytes32 标识符
  - 用于 Registry 模块映射
  
- `ActionKeys.sol` - 动作键常量
  - 所有操作的 bytes32 标识符
  - 用于权限验证和事件记录
  
- `BaseServiceConfig.sol` - 服务配置基类
- `DataPushTypes.sol` - 数据推送类型
- `DataPushLibrary.sol` - 数据推送库

**使用示例**：
```solidity
import { ModuleKeys } from "./constants/ModuleKeys.sol";
import { ActionKeys } from "./constants/ActionKeys.sol";

bytes32 vaultKey = ModuleKeys.KEY_VAULT_CORE;
bytes32 depositAction = ActionKeys.ACTION_DEPOSIT;
```

---

### 8. Interfaces (`interfaces/`)

**核心功能**：所有合约的接口定义

**主要接口**：
- `IRegistry.sol` - Registry 接口
- `IVaultCore.sol` - Vault 核心接口
- `IVaultRouter.sol` - Vault 视图接口
- `IAccessControlManager.sol` - 访问控制接口
- `IPriceOracle.sol` - 价格预言机接口
- `ILendingEngine.sol` - 借贷引擎接口
- `IRewardManager.sol` - 奖励管理接口
- 等 50+ 个接口定义

**设计原则**：
- 所有公共合约都有对应的接口
- 接口优先设计，便于测试和集成
- 支持接口升级和扩展

---

### 9. Libraries (`libraries/`)

**核心功能**：共享库函数

**主要库**：
- `VaultBusinessLogicLibrary.sol` - Vault 业务逻辑库
- `HealthFactorLib.sol` - 健康因子计算库
- `EventLibrary.sol` - 事件库
- `RegistryQueryLibrary.sol` - Registry 查询库
- `RegistryStorageLibrary.sol` - Registry 存储库
- `ModuleAccessLibrary.sol` - 模块访问库
- `ViewAccessLib.sol` - 视图访问库
- `SettlementIntentLib.sol` - 结算意图库
- 等 15+ 个共享库

---

### 10. Errors (`errors/`)

**核心功能**：标准错误定义

**主要文件**：
- `StandardErrors.sol` - 标准错误集合
  - `ZeroAddress` - 零地址错误
  - `AmountIsZero` - 金额为零错误
  - `InsufficientBalance` - 余额不足错误
  - `InvalidHealthFactor` - 无效健康因子错误
  - 等 30+ 个标准错误

**使用示例**：
```solidity
import { ZeroAddress, AmountIsZero } from "./errors/StandardErrors.sol";

if (addr == address(0)) revert ZeroAddress();
if (amount == 0) revert AmountIsZero();
```

---

### 11. Utils (`utils/`)

**核心功能**：工具函数库

**主要文件**：
- `VaultUtils.sol` - Vault 工具函数
- `TokenUtils.sol` - 代币工具函数
- `RiskUtils.sol` - 风险工具函数

---

### 12. Governance (`Governance/`)

**核心功能**：治理模块

**主要合约**：
- `CrossChainGovernance.sol` - 跨链治理

---

### 13. Strategies (`strategies/`)

**核心功能**：策略合约

**主要合约**：
- `RWAAutoLeveragedStrategy.sol` - RWA 自动杠杆策略

---

### 14. Token (`Token/`)

**核心功能**：代币合约

**主要合约**：
- `RewardPoints.sol` - 奖励积分代币
- `RWAToken.sol` - RWA 代币
- `RWAAutoLeveragedStrategy.sol` - RWA 自动杠杆策略

---

### 15. Mocks (`Mocks/`)

**核心功能**：测试用 Mock 合约

**包含**：34+ 个 Mock 合约，用于测试和开发

---

## 🔑 关键概念

### ModuleKeys（模块键）

所有模块通过 `ModuleKeys` 在 Registry 中注册：

```solidity
bytes32 KEY_VAULT_CORE = keccak256("VAULT_CORE");
bytes32 KEY_PRICE_ORACLE = keccak256("PRICE_ORACLE");
bytes32 KEY_REWARD_CORE = keccak256("REWARD_CORE");
```

### ActionKeys（动作键）

所有操作通过 `ActionKeys` 进行权限验证：

```solidity
bytes32 ACTION_DEPOSIT = keccak256("DEPOSIT");
bytes32 ACTION_BORROW = keccak256("BORROW");
bytes32 ACTION_REPAY = keccak256("REPAY");
```

### Registry 集成

所有模块都通过 Registry 获取其他模块地址：

```solidity
Registry registry = Registry(registryAddress);
address priceOracle = registry.getModule(ModuleKeys.KEY_PRICE_ORACLE);
IPriceOracle oracle = IPriceOracle(priceOracle);
```

### 权限控制

所有操作都通过 AccessControlManager 进行权限验证：

```solidity
IAccessControlManager acm = IAccessControlManager(acmAddress);
acm.requireRole(ActionKeys.ACTION_DEPOSIT, msg.sender);
```

---

## 📋 合约分类

### 按功能分类

| 类别 | 合约数量 | 主要功能 |
|------|---------|---------|
| **Registry** | 10+ | 模块注册和管理 |
| **Vault** | 70+ | 金库业务逻辑 |
| **Reward** | 10+ | 奖励系统 |
| **Core** | 6 | 核心业务合约 |
| **Access** | 5 | 访问控制 |
| **Monitor** | 4 | 系统监控 |
| **Interfaces** | 50+ | 接口定义 |
| **Libraries** | 15+ | 共享库 |
| **Mocks** | 34+ | 测试合约 |

### 按升级模式分类

| 模式 | 合约 | 说明 |
|------|------|------|
| **UUPS** | Registry, VaultCore, RewardCore 等 | 可升级代理合约 |
| **Regular** | AccessControlManager | 普通合约（不可升级） |
| **Library** | VaultMath, EventLibrary 等 | 库合约（无状态） |

---

## 🔧 开发指南

### 添加新模块

1. **创建合约文件**
```solidity
// src/core/MyModule.sol
contract MyModule is Initializable, UUPSUpgradeable {
    // 实现逻辑
}
```

2. **添加 ModuleKey**
```solidity
// src/constants/ModuleKeys.sol
bytes32 constant KEY_MY_MODULE = keccak256("MY_MODULE");
```

3. **添加 ActionKey**（如需要）
```solidity
// src/constants/ActionKeys.sol
bytes32 constant ACTION_MY_ACTION = keccak256("MY_ACTION");
```

4. **创建接口**
```solidity
// src/interfaces/IMyModule.sol
interface IMyModule {
    // 接口定义
}
```

5. **注册到 Registry**
```typescript
// 在部署脚本中
await registry.setModule(ModuleKeys.KEY_MY_MODULE, myModuleAddress);
```

### 使用标准错误

```solidity
import { ZeroAddress, AmountIsZero } from "../errors/StandardErrors.sol";

function myFunction(address addr, uint256 amount) external {
    if (addr == address(0)) revert ZeroAddress();
    if (amount == 0) revert AmountIsZero();
    // ...
}
```

### 使用 VaultMath 库

```solidity
import { VaultMath } from "../Vault/VaultMath.sol";

uint256 healthFactor = VaultMath.calculateHealthFactor(collateral, debt);
uint256 ltv = VaultMath.calculateLTV(debt, collateral);
```

---

## 🧪 测试

### Mock 合约

所有 Mock 合约位于 `Mocks/` 目录，用于：
- 单元测试
- 集成测试
- 本地开发

### 测试文件结构

测试文件应位于 `test/` 目录，与 `src/` 目录结构对应：

```
test/
├── Vault/
│   ├── VaultCore.test.ts
│   └── VaultRouter.test.ts
├── Reward/
│   └── RewardCore.test.ts
└── registry/
    └── Registry.test.ts
```

---

## 📚 相关文档

- [Vault 模块文档](./Vault/README.md)
- [Registry 系统文档](../docs/registry-deployment.md)
- [架构指南](../docs/Architecture-Guide.md)
- [智能合约标准](../docs/SmartContractStandard.md)
- [权限系统文档](../Usage-Guide/permission-management-guide.md)

---

## 🔒 安全考虑

### 安全特性

1. **重入保护**：所有外部调用都使用 ReentrancyGuard
2. **权限控制**：统一的 AccessControlManager
3. **暂停机制**：支持紧急暂停功能
4. **升级控制**：Timelock 延迟升级
5. **输入验证**：所有输入都进行验证

### 最佳实践

1. **使用标准错误**：统一错误处理
2. **使用库函数**：避免代码重复
3. **事件记录**：所有重要操作都发出事件
4. **接口优先**：使用接口而非具体实现
5. **模块化设计**：功能分离，便于维护

---

## 📊 代码统计

- **总合约数**：220+ 个 Solidity 文件
- **核心模块**：10+ 个主要模块
- **接口定义**：50+ 个接口
- **共享库**：15+ 个库文件
- **测试合约**：34+ 个 Mock 合约

---

## 🔄 版本信息

- **Solidity 版本**：^0.8.20
- **OpenZeppelin**：使用最新稳定版
- **网络支持**：所有 EVM 兼容网络
- **许可证**：MIT License

---

## 📞 支持

如有问题，请参考：
- [项目 README](../README.md)
- [部署指南](../scripts/deploy/README.md)
- [开发文档](../docs/)

---

## 📄 许可证

MIT License


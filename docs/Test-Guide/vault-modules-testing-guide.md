# Vault 模块测试指南

## 🎯 概述

本文档提供了 RWA 借贷平台 Vault 模块测试的完整指南。Vault 模块包括抵押管理、业务逻辑、保证金管理等核心业务模块，本文档基于 `test/Vault/modules/` 文件夹中的实际测试文件，详细说明了如何运行、理解和扩展 Vault 模块相关的测试。

## 📁 测试文件结构

Vault 模块的测试文件包括：

```
test/
├── VaultBusinessLogic.test.ts              # 业务逻辑测试
├── VaultBusinessLogic.stats-integration.test.ts  # 统计集成测试
├── CollateralManager.security.test.ts       # 抵押管理器安全测试
└── Vault/modules/
    ├── CollateralManagerOptimized.test.ts   # 抵押管理器优化测试
    ├── GuaranteeFundManager.test.ts         # 保证金管理器测试
    ├── ValuationOracleAdapter.test.ts       # 估值预言机适配器测试
    └── VaultBusinessLogic.test.ts           # 业务逻辑测试
```

## 🧪 测试分类

### 1. 业务逻辑测试

**文件**: `VaultBusinessLogic.test.ts`, `test/Vault/modules/VaultBusinessLogic.test.ts`

**测试目标**:
- 业务流程编排
- 资金流转验证
- 抵押与保证金联动
- 奖励触发机制
- 批量操作处理

**主要测试场景**:

```typescript
describe('VaultBusinessLogic – 业务逻辑测试', function () {
  it('应该正确执行存款流程', async function () {
    // 1. 用户存款
    await vaultBusinessLogic.deposit(asset, amount);
    
    // 2. 验证抵押增加
    const collateral = await collateralManager.getCollateral(user, asset);
    expect(collateral).to.equal(amount);
    
    // 3. 验证事件触发
    await expect(tx).to.emit(vaultBusinessLogic, 'DepositProcessed');
  });

  it('应该正确执行借款流程', async function () {
    // 1. 先存款作为抵押
    await vaultBusinessLogic.deposit(asset, collateralAmount);
    
    // 2. 借款
    await vaultBusinessLogic.borrow(asset, borrowAmount);
    
    // 3. 验证债务增加
    const debt = await lendingEngine.getDebt(user, asset);
    expect(debt).to.equal(borrowAmount);
  });

  it('应该正确触发奖励机制', async function () {
    // 1. 执行借款（落账）
    await vaultBusinessLogic.borrow(asset, amount);
    
    // 2. 验证奖励触发（由 LendingEngine 触发）
    const rewardBalance = await rewardPoints.balanceOf(user);
    expect(rewardBalance).to.be.gt(0);
  });
});
```

**运行命令**:
```bash
npx hardhat test test/VaultBusinessLogic.test.ts
npx hardhat test test/Vault/modules/VaultBusinessLogic.test.ts
```

### 2. 抵押管理器测试

**文件**: `CollateralManagerOptimized.test.ts`, `CollateralManager.security.test.ts`

**测试目标**:
- 抵押物存入和提取
- 抵押物价值计算
- 批量抵押操作
- 安全验证
- 权限控制

**主要测试场景**:

```typescript
describe('CollateralManager – 抵押管理器测试', function () {
  it('应该正确存入抵押物', async function () {
    await collateralManager.depositCollateral(user, asset, amount);
    const collateral = await collateralManager.getCollateral(user, asset);
    expect(collateral).to.equal(amount);
  });

  it('应该正确提取抵押物', async function () {
    // 先存入
    await collateralManager.depositCollateral(user, asset, amount);
    
    // 再提取
    await collateralManager.withdrawCollateral(user, asset, withdrawAmount);
    
    const collateral = await collateralManager.getCollateral(user, asset);
    expect(collateral).to.equal(amount - withdrawAmount);
  });

  it('应该正确计算抵押物价值', async function () {
    await collateralManager.depositCollateral(user, asset, amount);
    const value = await collateralManager.getCollateralValue(user, asset);
    const expectedValue = amount * price / 1e18;
    expect(value).to.equal(expectedValue);
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Vault/modules/CollateralManagerOptimized.test.ts
npx hardhat test test/CollateralManager.security.test.ts
```

### 3. 保证金管理器测试

**文件**: `GuaranteeFundManager.test.ts`

**测试目标**:
- 保证金存入和提取
- 保证金计算
- 保证金使用
- 保证金返还

**运行命令**:
```bash
npx hardhat test test/Vault/modules/GuaranteeFundManager.test.ts
```

### 4. 估值预言机适配器测试

**文件**: `ValuationOracleAdapter.test.ts`

**测试目标**:
- 资产估值功能
- 价格获取和验证
- 优雅降级处理
- 批量估值

**运行命令**:
```bash
npx hardhat test test/Vault/modules/ValuationOracleAdapter.test.ts
```

### 5. 统计集成测试

**文件**: `VaultBusinessLogic.stats-integration.test.ts`

**测试目标**:
- 统计数据更新
- 活跃用户统计
- 全局抵押/债务统计
- 统计视图集成

**运行命令**:
```bash
npx hardhat test test/VaultBusinessLogic.stats-integration.test.ts
```

## 🚀 运行测试

### 运行所有 Vault 模块测试

```bash
# 运行所有 Vault 模块测试
npx hardhat test test/Vault/modules/
npx hardhat test test/VaultBusinessLogic*.test.ts
```

### 运行特定测试文件

```bash
# 运行业务逻辑测试
npx hardhat test test/VaultBusinessLogic.test.ts

# 运行抵押管理器测试
npx hardhat test test/Vault/modules/CollateralManagerOptimized.test.ts

# 运行保证金管理器测试
npx hardhat test test/Vault/modules/GuaranteeFundManager.test.ts
```

### 运行特定测试用例

```bash
# 运行特定 describe 块
npx hardhat test test/VaultBusinessLogic.test.ts --grep "存款流程测试"

# 运行特定 it 测试
npx hardhat test test/VaultBusinessLogic.test.ts --grep "应该正确执行存款流程"
```

### 带 Gas 报告的测试

```bash
# 运行测试并生成 Gas 报告
REPORT_GAS=true npx hardhat test test/Vault/modules/
```

## 📊 测试覆盖范围

### 功能覆盖

| 功能模块 | 测试文件 | 覆盖度 |
|---------|---------|--------|
| **业务逻辑** | `VaultBusinessLogic.test.ts` | ✅ 完整 |
| **抵押管理** | `CollateralManagerOptimized.test.ts` | ✅ 完整 |
| **安全测试** | `CollateralManager.security.test.ts` | ✅ 完整 |
| **保证金管理** | `GuaranteeFundManager.test.ts` | ✅ 完整 |
| **估值适配器** | `ValuationOracleAdapter.test.ts` | ✅ 完整 |
| **统计集成** | `VaultBusinessLogic.stats-integration.test.ts` | ✅ 完整 |

### 测试场景覆盖

| 测试场景 | 测试文件 | 状态 |
|---------|---------|------|
| **存款流程** | `VaultBusinessLogic.test.ts` | ✅ |
| **借款流程** | `VaultBusinessLogic.test.ts` | ✅ |
| **还款流程** | `VaultBusinessLogic.test.ts` | ✅ |
| **提款流程** | `VaultBusinessLogic.test.ts` | ✅ |
| **抵押管理** | `CollateralManagerOptimized.test.ts` | ✅ |
| **保证金管理** | `GuaranteeFundManager.test.ts` | ✅ |
| **奖励触发** | `VaultBusinessLogic.test.ts` | ✅ |
| **批量操作** | 所有测试文件 | ✅ |
| **权限控制** | 所有测试文件 | ✅ |
| **安全验证** | `CollateralManager.security.test.ts` | ✅ |

## 🔧 测试环境设置

### 前置条件

1. **安装依赖**:
```bash
npm install
```

2. **编译合约**:
```bash
npx hardhat compile
```

### Mock 合约

测试使用以下 Mock 合约：

- `MockRegistry` - Registry 模拟
- `MockAccessControlManager` - 权限控制模拟
- `MockPriceOracle` - 价格预言机模拟
- `MockERC20` - ERC20 代币模拟

### 测试 Fixture

所有测试使用 `loadFixture` 来设置测试环境：

```typescript
async function deployFixture() {
  // 1. 部署基础合约
  const registry = await deployMockRegistry();
  const accessControlManager = await deployAccessControlManager();
  
  // 2. 部署业务模块
  const collateralManager = await deployCollateralManager();
  const lendingEngine = await deployLendingEngine();
  const vaultBusinessLogic = await deployVaultBusinessLogic();
  const guaranteeFundManager = await deployGuaranteeFundManager();
  
  // 3. 注册模块到 Registry
  await registry.setModule(KEY_CM, collateralManager.address);
  await registry.setModule(KEY_LE, lendingEngine.address);
  await registry.setModule(KEY_VAULT_BUSINESS_LOGIC, vaultBusinessLogic.address);
  await registry.setModule(KEY_GUARANTEE_FUND, guaranteeFundManager.address);
  
  // 4. 设置权限
  await accessControlManager.grantRole(ACTION_DEPOSIT, user.address);
  await accessControlManager.grantRole(ACTION_BORROW, user.address);
  
  // 5. 准备测试数据
  return { registry, collateralManager, lendingEngine, vaultBusinessLogic, ... };
}
```

## 📝 编写新测试

### 测试文件结构

```typescript
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('VaultModule – 新功能测试', function () {
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ONE_ETH = ethers.parseUnits('1', 18);
  
  let vaultModule: VaultModule;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  async function deployFixture() {
    const [ownerSigner, userSigner] = await ethers.getSigners();
    owner = ownerSigner;
    user = userSigner;

    // 部署合约
    const VaultModuleFactory = await ethers.getContractFactory('VaultModule');
    vaultModule = await VaultModuleFactory.deploy();
    await vaultModule.waitForDeployment();
    await vaultModule.initialize(registryAddress);

    return { vaultModule, owner, user };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    Object.assign(this, fixture);
  });

  describe('新功能测试', function () {
    it('应该正确执行新功能', async function () {
      const { vaultModule, user } = await loadFixture(deployFixture);
      
      // 执行操作
      const tx = await vaultModule.connect(user).newFunction(params);
      await tx.wait();
      
      // 验证结果
      expect(await vaultModule.getValue(user.address)).to.equal(expectedValue);
    });
  });
});
```

### 测试最佳实践

1. **使用 loadFixture**: 避免测试之间的状态污染
2. **清晰的测试描述**: 使用中文描述测试目标
3. **完整的断言**: 验证所有相关状态变化
4. **事件验证**: 验证重要事件的触发
5. **权限验证**: 测试所有权限边界
6. **安全测试**: 测试重入攻击、溢出等安全场景

## 🐛 调试测试

### 常见问题

#### 1. 测试失败 - "Insufficient collateral"

**原因**: 抵押物不足

**解决方案**:
```typescript
// 先存入足够的抵押物
await collateralManager.depositCollateral(user, asset, sufficientAmount);
// 然后再借款
await vaultBusinessLogic.borrow(asset, borrowAmount);
```

#### 2. 测试失败 - "Health factor too low"

**原因**: 健康因子过低

**解决方案**:
```typescript
// 增加抵押物或减少债务
await collateralManager.depositCollateral(user, asset, moreCollateral);
// 或
await vaultBusinessLogic.repay(asset, repayAmount);
```

### 调试技巧

1. **使用 console.log**:
```typescript
console.log('Collateral:', await collateralManager.getCollateral(user, asset));
console.log('Debt:', await lendingEngine.getDebt(user, asset));
console.log('Health factor:', await healthView.getUserHealthFactor(user));
```

2. **使用 hardhat console**:
```bash
npx hardhat console
```

3. **使用 --verbose 标志**:
```bash
npx hardhat test --verbose test/Vault/modules/
```

## 📈 测试性能

### 测试执行时间

| 测试文件 | 执行时间 | 测试用例数 |
|---------|---------|-----------|
| `VaultBusinessLogic.test.ts` | ~10-12s | 30+ |
| `CollateralManagerOptimized.test.ts` | ~8-10s | 25+ |
| `GuaranteeFundManager.test.ts` | ~6-8s | 15+ |
| `ValuationOracleAdapter.test.ts` | ~5-7s | 12+ |

### 优化建议

1. **使用并行测试**: Hardhat 默认并行运行测试
2. **减少不必要的部署**: 重用 Fixture
3. **优化 Mock 合约**: 简化 Mock 实现
4. **批量操作**: 使用批量接口减少交易数

## 🔍 测试覆盖率

### 查看覆盖率

```bash
# 运行测试并生成覆盖率报告
npx hardhat coverage

# 查看覆盖率报告
open coverage/index.html
```

### 覆盖率目标

- **语句覆盖率**: > 85%
- **分支覆盖率**: > 80%
- **函数覆盖率**: > 90%
- **行覆盖率**: > 85%

## 📚 相关文档

- [平台逻辑文档](../PlatformLogic.md) - 平台整体架构
- [架构指南](../Architecture-Guide.md) - 双架构设计说明
- [借贷使用指南](../Usage-Guide/Lending-Guide.md) - 借贷功能使用说明
- [智能合约标准](../SmartContractStandard.md) - 代码规范

## 🎯 总结

Vault 模块测试覆盖了以下关键方面：

1. ✅ **业务流程** - 完整的业务流程编排
2. ✅ **资金流转** - 资金流转的正确性
3. ✅ **抵押管理** - 抵押物的存入和提取
4. ✅ **保证金管理** - 保证金的计算和使用
5. ✅ **奖励机制** - 奖励的正确触发
6. ✅ **权限控制** - 细粒度的权限验证
7. ✅ **安全测试** - 安全漏洞防护
8. ✅ **批量操作** - 高效的批量接口
9. ✅ **统计集成** - 统计数据的正确更新
10. ✅ **边界条件** - 各种边界场景处理

所有测试都遵循最佳实践，使用 TypeScript 严格类型，确保代码质量和可维护性。

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

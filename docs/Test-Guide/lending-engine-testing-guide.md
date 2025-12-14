# LendingEngine 测试指南

## 🎯 概述

本文档提供了 RWA 借贷平台 LendingEngine 借贷引擎测试的完整指南。LendingEngine 是平台的核心业务模块，负责借贷账本管理、债务计算和奖励触发，本文档基于 `test/LendingEngine.test.ts` 及相关测试文件，详细说明了如何运行、理解和扩展 LendingEngine 相关的测试。

## 📁 测试文件位置

```
test/
└── LendingEngine.test.ts                   # LendingEngine 核心测试
```

## 🧪 测试分类

### 1. 初始化测试

**测试目标**:
- 验证 LendingEngine 合约的正确初始化
- 验证 Registry 地址设置
- 验证零地址和重复初始化的错误处理

**主要测试场景**:

```typescript
describe('初始化测试', function () {
  it('应该正确初始化 LendingEngine 合约', async function () {
    expect(await lendingEngine.registryAddrVar()).to.equal(registryAddress);
  });

  it('应该拒绝零地址初始化', async function () {
    await expect(lendingEngine.initialize(ZERO_ADDRESS))
      .to.be.revertedWithCustomError(lendingEngine, 'LendingEngine__ZeroAddress');
  });

  it('应该拒绝重复初始化', async function () {
    await expect(lendingEngine.initialize(registryAddress))
      .to.be.revertedWith('Initializable: contract is already initialized');
  });
});
```

**运行命令**:
```bash
npx hardhat test test/LendingEngine.test.ts --grep "初始化测试"
```

### 2. 权限控制测试

**测试目标**:
- 验证只有 VaultCore 可以调用账本写入函数
- 验证 `onlyVaultCore` 修饰符
- 验证权限错误处理

**主要测试场景**:

```typescript
describe('权限控制测试', function () {
  it('应该拒绝非 VaultCore 调用 borrow', async function () {
    await expect(
      lendingEngine.connect(unauthorized).borrow(user, asset, amount)
    ).to.be.revertedWithCustomError(lendingEngine, 'LendingEngine__Unauthorized');
  });

  it('应该允许 VaultCore 调用 borrow', async function () {
    await lendingEngine.connect(vaultCore).borrow(user, asset, amount);
    const debt = await lendingEngine.getDebt(user, asset);
    expect(debt).to.equal(amount);
  });
});
```

**运行命令**:
```bash
npx hardhat test test/LendingEngine.test.ts --grep "权限控制测试"
```

### 3. 事件记录测试

**测试目标**:
- 验证借贷事件的正确发出
- 验证还款事件的正确发出
- 验证事件参数的完整性

**主要测试场景**:

```typescript
describe('事件记录测试', function () {
  it('应该正确发出借款事件', async function () {
    await expect(
      lendingEngine.connect(vaultCore).borrow(user, asset, amount)
    ).to.emit(lendingEngine, 'Borrowed')
      .withArgs(user, asset, amount, anyValue);
  });

  it('应该正确发出还款事件', async function () {
    await expect(
      lendingEngine.connect(vaultCore).repay(user, asset, amount)
    ).to.emit(lendingEngine, 'Repaid')
      .withArgs(user, asset, amount, anyValue);
  });
});
```

**运行命令**:
```bash
npx hardhat test test/LendingEngine.test.ts --grep "事件记录测试"
```

### 4. 安全功能测试

**测试目标**:
- 验证重入攻击防护
- 验证溢出保护
- 验证零地址检查

**运行命令**:
```bash
npx hardhat test test/LendingEngine.test.ts --grep "安全功能测试"
```

### 5. 边界条件测试

**测试目标**:
- 验证最大数值的处理
- 验证零金额的处理
- 验证其他边界场景

**运行命令**:
```bash
npx hardhat test test/LendingEngine.test.ts --grep "边界条件测试"
```

### 6. 集成测试

**测试目标**:
- 验证与 CollateralManager 的集成
- 验证与 RewardManager 的集成
- 验证与 View 层的集成

**主要测试场景**:

```typescript
describe('集成测试', function () {
  it('应该正确触发奖励机制', async function () {
    // 执行借款（落账）
    await lendingEngine.connect(vaultCore).borrow(user, asset, amount, duration, hfHigh);
    
    // 验证奖励触发
    const rewardBalance = await rewardPoints.balanceOf(user);
    expect(rewardBalance).to.be.gt(0);
  });

  it('应该正确更新 View 层缓存', async function () {
    // 执行借款
    await lendingEngine.connect(vaultCore).borrow(user, asset, amount);
    
    // 验证 View 层缓存更新
    const [collateral, debt] = await vaultView.getUserPosition(user, asset);
    expect(debt).to.equal(amount);
  });
});
```

**运行命令**:
```bash
npx hardhat test test/LendingEngine.test.ts --grep "集成测试"
```

### 7. 升级功能测试

**测试目标**:
- 验证合约升级功能
- 验证升级后的兼容性
- 验证数据迁移

**运行命令**:
```bash
npx hardhat test test/LendingEngine.test.ts --grep "升级功能测试"
```

### 8. 错误处理测试

**测试目标**:
- 验证各种错误场景的处理
- 验证错误消息的正确性
- 验证错误恢复机制

**运行命令**:
```bash
npx hardhat test test/LendingEngine.test.ts --grep "错误处理测试"
```

## 🚀 运行测试

### 运行所有 LendingEngine 测试

```bash
# 运行所有 LendingEngine 测试
npx hardhat test test/LendingEngine.test.ts
```

### 运行特定测试套件

```bash
# 运行初始化测试
npx hardhat test test/LendingEngine.test.ts --grep "初始化测试"

# 运行权限控制测试
npx hardhat test test/LendingEngine.test.ts --grep "权限控制测试"

# 运行集成测试
npx hardhat test test/LendingEngine.test.ts --grep "集成测试"
```

### 运行特定测试用例

```bash
# 运行特定 it 测试
npx hardhat test test/LendingEngine.test.ts --grep "应该正确初始化 LendingEngine 合约"
```

### 带 Gas 报告的测试

```bash
# 运行测试并生成 Gas 报告
REPORT_GAS=true npx hardhat test test/LendingEngine.test.ts
```

## 📊 测试覆盖范围

### 功能覆盖

| 功能模块 | 测试文件 | 覆盖度 |
|---------|---------|--------|
| **初始化** | `LendingEngine.test.ts` | ✅ 完整 |
| **权限控制** | `LendingEngine.test.ts` | ✅ 完整 |
| **借贷功能** | `LendingEngine.test.ts` | ✅ 完整 |
| **还款功能** | `LendingEngine.test.ts` | ✅ 完整 |
| **事件记录** | `LendingEngine.test.ts` | ✅ 完整 |
| **安全功能** | `LendingEngine.test.ts` | ✅ 完整 |
| **集成测试** | `LendingEngine.test.ts` | ✅ 完整 |
| **升级功能** | `LendingEngine.test.ts` | ✅ 完整 |

### 测试场景覆盖

| 测试场景 | 测试文件 | 状态 |
|---------|---------|------|
| **初始化流程** | `LendingEngine.test.ts` | ✅ |
| **权限验证** | `LendingEngine.test.ts` | ✅ |
| **借贷操作** | `LendingEngine.test.ts` | ✅ |
| **还款操作** | `LendingEngine.test.ts` | ✅ |
| **事件验证** | `LendingEngine.test.ts` | ✅ |
| **安全验证** | `LendingEngine.test.ts` | ✅ |
| **集成验证** | `LendingEngine.test.ts` | ✅ |
| **边界条件** | `LendingEngine.test.ts` | ✅ |
| **错误处理** | `LendingEngine.test.ts` | ✅ |

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
- `MockCollateralManager` - 抵押物管理器模拟
- `MockRewardManager` - 奖励管理器模拟

### 测试 Fixture

所有测试使用 `loadFixture` 来设置测试环境：

```typescript
async function deployFixture() {
  // 1. 部署基础合约
  const registry = await deployMockRegistry();
  const accessControlManager = await deployAccessControlManager();
  const priceOracle = await deployMockPriceOracle();
  
  // 2. 部署 LendingEngine
  const LendingEngineFactory = await ethers.getContractFactory('LendingEngine');
  const lendingEngine = await LendingEngineFactory.deploy();
  await lendingEngine.waitForDeployment();
  await lendingEngine.initialize(registry.address);
  
  // 3. 注册模块到 Registry
  await registry.setModule(KEY_LE, lendingEngine.address);
  await registry.setModule(KEY_VAULT_CORE, vaultCore.address);
  await registry.setModule(KEY_PRICE_ORACLE, priceOracle.address);
  
  // 4. 设置权限
  await accessControlManager.grantRole(ACTION_BORROW, vaultCore.address);
  await accessControlManager.grantRole(ACTION_REPAY, vaultCore.address);
  
  // 5. 准备测试数据
  return { lendingEngine, registry, accessControlManager, priceOracle, ... };
}
```

## 📝 编写新测试

### 测试文件结构

```typescript
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('LendingEngine – 新功能测试', function () {
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ONE_ETH = ethers.parseUnits('1', 18);
  
  let lendingEngine: LendingEngine;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let vaultCore: SignerWithAddress;

  async function deployFixture() {
    const [ownerSigner, userSigner, vaultCoreSigner] = await ethers.getSigners();
    owner = ownerSigner;
    user = userSigner;
    vaultCore = vaultCoreSigner;

    // 部署 LendingEngine
    const LendingEngineFactory = await ethers.getContractFactory('LendingEngine');
    lendingEngine = await LendingEngineFactory.deploy();
    await lendingEngine.waitForDeployment();
    await lendingEngine.initialize(registryAddress);

    return { lendingEngine, owner, user, vaultCore };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    Object.assign(this, fixture);
  });

  describe('新功能测试', function () {
    it('应该正确执行新功能', async function () {
      const { lendingEngine, vaultCore, user } = await loadFixture(deployFixture);
      
      // 执行操作（必须通过 VaultCore）
      const tx = await lendingEngine.connect(vaultCore).newFunction(user.address, params);
      await tx.wait();
      
      // 验证结果
      expect(await lendingEngine.getValue(user.address)).to.equal(expectedValue);
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
6. **集成验证**: 验证与其他模块的集成

## 🐛 调试测试

### 常见问题

#### 1. 测试失败 - "Unauthorized"

**原因**: 调用者不是 VaultCore

**解决方案**:
```typescript
// 确保使用 VaultCore 调用
await lendingEngine.connect(vaultCore).borrow(user, asset, amount);
```

#### 2. 测试失败 - "Insufficient collateral"

**原因**: 抵押物不足

**解决方案**:
```typescript
// 先存入足够的抵押物
await collateralManager.depositCollateral(user, asset, sufficientAmount);
// 然后再借款
await lendingEngine.connect(vaultCore).borrow(user, asset, amount);
```

### 调试技巧

1. **使用 console.log**:
```typescript
console.log('User debt:', await lendingEngine.getDebt(user, asset));
console.log('Total debt:', await lendingEngine.getTotalDebt(asset));
```

2. **使用 hardhat console**:
```bash
npx hardhat console
```

3. **使用 --verbose 标志**:
```bash
npx hardhat test --verbose test/LendingEngine.test.ts
```

## 📈 测试性能

### 测试执行时间

| 测试文件 | 执行时间 | 测试用例数 |
|---------|---------|-----------|
| `LendingEngine.test.ts` | ~5-7s | 20+ |

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

- [借贷使用指南](../Usage-Guide/Lending-Guide.md) - 借贷功能使用说明
- [平台逻辑文档](../PlatformLogic.md) - 平台整体架构
- [架构指南](../Architecture-Guide.md) - 双架构设计说明
- [智能合约标准](../SmartContractStandard.md) - 代码规范

## 🎯 总结

LendingEngine 测试覆盖了以下关键方面：

1. ✅ **初始化流程** - 正确的合约初始化
2. ✅ **权限控制** - 细粒度的权限验证（onlyVaultCore）
3. ✅ **借贷功能** - 借贷账本管理
4. ✅ **还款功能** - 还款处理和债务减少
5. ✅ **事件记录** - 重要事件的正确触发
6. ✅ **安全功能** - 重入攻击防护和溢出保护
7. ✅ **集成测试** - 与其他模块的集成（Reward、View 层）
8. ✅ **边界条件** - 各种边界场景处理
9. ✅ **错误处理** - 完善的错误处理机制
10. ✅ **升级功能** - 合约升级和数据迁移

所有测试都遵循最佳实践，使用 TypeScript 严格类型，确保代码质量和可维护性。LendingEngine 是平台的核心账本模块，其测试覆盖了所有关键功能。

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

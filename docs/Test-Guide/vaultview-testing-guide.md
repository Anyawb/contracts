# VaultView 测试指南

## 🎯 概述

本文档提供了 RWA 借贷平台 VaultView 双架构智能协调器测试的完整指南。VaultView 是平台的核心组件，实现了事件驱动架构和 View 层缓存的结合，本文档基于 `test/VaultView.test.ts` 文件，详细说明了如何运行、理解和扩展 VaultView 相关的测试。

## 📁 测试文件位置

```
test/
└── VaultView.test.ts                    # VaultView 核心测试
```

## 🧪 测试分类

### 1. 初始化测试

**测试目标**:
- 验证 VaultView 合约的正确初始化
- 验证 Registry 地址设置
- 验证零地址和重复初始化的错误处理

**主要测试场景**:

```typescript
describe('初始化测试', function () {
  it('应该正确初始化 VaultView 合约', async function () {
    // 验证 Registry 地址正确设置
    expect(await vaultView.registryAddrVar()).to.equal(registryAddress);
  });

  it('应该拒绝零地址初始化', async function () {
    // 验证零地址初始化会被拒绝
    await expect(vaultView.initialize(ZERO_ADDRESS))
      .to.be.revertedWithCustomError(vaultView, 'VaultView__ZeroAddress');
  });

  it('应该拒绝重复初始化', async function () {
    // 验证重复初始化会被拒绝
    await expect(vaultView.initialize(registryAddress))
      .to.be.revertedWith('Initializable: contract is already initialized');
  });
});
```

**运行命令**:
```bash
npx hardhat test test/VaultView.test.ts --grep "初始化测试"
```

### 2. 权限控制测试

**测试目标**:
- 验证只有授权合约可以调用关键函数
- 验证 `processUserOperation` 的权限控制
- 验证 `pushUserPositionUpdate` 的权限控制

**主要测试场景**:

```typescript
describe('权限控制测试', function () {
  it('应该拒绝未授权合约调用 processUserOperation', async function () {
    // 只有 VaultCore 可以调用
    await expect(
      vaultView.connect(unauthorized).processUserOperation(...)
    ).to.be.revertedWithCustomError(vaultView, 'VaultView__UnauthorizedAccess');
  });

  it('应该拒绝未授权合约调用 pushUserPositionUpdate', async function () {
    // 只有业务模块可以调用
    await expect(
      vaultView.connect(unauthorized).pushUserPositionUpdate(...)
    ).to.be.revertedWithCustomError(vaultView, 'VaultView__UnauthorizedAccess');
  });
});
```

**运行命令**:
```bash
npx hardhat test test/VaultView.test.ts --grep "权限控制测试"
```

### 3. 免费查询接口测试

**测试目标**:
- 验证所有 view 函数（0 gas 查询）
- 验证用户位置查询功能
- 验证批量查询功能
- 验证缓存有效性检查

**主要测试场景**:

```typescript
describe('免费查询接口测试', function () {
  it('应该正确返回用户位置信息', async function () {
    const [collateral, debt] = await vaultView.getUserPosition(user, asset);
    expect(collateral).to.equal(expectedCollateral);
    expect(debt).to.equal(expectedDebt);
  });

  it('应该正确返回用户抵押数量', async function () {
    const collateral = await vaultView.getUserCollateral(user, asset);
    expect(collateral).to.equal(expectedCollateral);
  });

  it('应该正确返回用户债务数量', async function () {
    const debt = await vaultView.getUserDebt(user, asset);
    expect(debt).to.equal(expectedDebt);
  });

  it('应该正确检查用户缓存有效性', async function () {
    const isValid = await vaultView.isUserCacheValid(user);
    expect(isValid).to.be.a('boolean');
  });

  it('应该正确批量获取用户位置', async function () {
    const users = [user1, user2];
    const assets = [asset1, asset2];
    const positions = await vaultView.batchGetUserPositions(users, assets);
    expect(positions.length).to.equal(2);
  });

  it('应该拒绝长度不匹配的批量查询', async function () {
    const users = [user1];
    const assets = [asset1, asset2]; // 长度不匹配
    await expect(
      vaultView.batchGetUserPositions(users, assets)
    ).to.be.revertedWith('Arrays length mismatch');
  });
});
```

**运行命令**:
```bash
npx hardhat test test/VaultView.test.ts --grep "免费查询接口测试"
```

### 4. 事件测试

**测试目标**:
- 验证用户操作事件的正确发出
- 验证用户位置更新事件的正确发出
- 验证系统状态更新事件的正确发出

**主要测试场景**:

```typescript
describe('事件测试', function () {
  it('应该正确发出用户操作事件', async function () {
    await expect(
      vaultView.processUserOperation(user, operationType, asset, amount, timestamp)
    ).to.emit(vaultView, 'UserOperation')
      .withArgs(user, operationType, asset, amount, timestamp);
  });

  it('应该正确发出用户位置更新事件', async function () {
    await expect(
      vaultView.pushUserPositionUpdate(user, asset, collateral, debt)
    ).to.emit(vaultView, 'UserPositionUpdated')
      .withArgs(user, asset, collateral, debt, anyValue);
  });

  it('应该正确发出系统状态更新事件', async function () {
    await expect(
      vaultView.pushSystemStateUpdate(asset, totalCollateral, totalDebt)
    ).to.emit(vaultView, 'SystemStateUpdated')
      .withArgs(asset, totalCollateral, totalDebt, anyValue);
  });
});
```

**运行命令**:
```bash
npx hardhat test test/VaultView.test.ts --grep "事件测试"
```

### 5. 错误处理测试

**测试目标**:
- 验证零地址错误的处理
- 验证无效金额错误的处理
- 验证其他边界错误的处理

**主要测试场景**:

```typescript
describe('错误处理测试', function () {
  it('应该正确处理零地址错误', async function () {
    // 查询函数可能不检查零地址，但写入函数应该检查
    const result = await vaultView.getUserPosition(ZERO_ADDRESS, asset);
    // 验证返回默认值或正确处理
  });

  it('应该正确处理无效金额错误', async function () {
    // 在 processUserOperation 中检查金额
    await expect(
      vaultView.processUserOperation(user, operationType, asset, 0, timestamp)
    ).to.be.revertedWithCustomError(vaultView, 'VaultView__InvalidAmount');
  });
});
```

**运行命令**:
```bash
npx hardhat test test/VaultView.test.ts --grep "错误处理测试"
```

### 6. 边界条件测试

**测试目标**:
- 验证最大数值的处理
- 验证零金额的处理
- 验证其他边界场景

**主要测试场景**:

```typescript
describe('边界条件测试', function () {
  it('应该正确处理最大数值', async function () {
    const maxValue = ethers.MaxUint256;
    // 测试最大 uint256 值的处理
    const [collateral, debt] = await vaultView.getUserPosition(user, asset);
    // 验证不会溢出
  });

  it('应该正确处理零金额', async function () {
    // 测试零金额的处理
    const [collateral, debt] = await vaultView.getUserPosition(user, asset);
    expect(collateral).to.equal(0);
    expect(debt).to.equal(0);
  });
});
```

**运行命令**:
```bash
npx hardhat test test/VaultView.test.ts --grep "边界条件测试"
```

### 7. 缓存机制测试

**测试目标**:
- 验证缓存时间戳的管理
- 验证缓存有效期的检查
- 验证缓存更新机制

**主要测试场景**:

```typescript
describe('缓存机制测试', function () {
  it('应该正确管理缓存时间戳', async function () {
    const user = user1.address;
    const isValid = await vaultView.isUserCacheValid(user);
    // 初始状态缓存应该无效
    expect(isValid).to.be.false;
    
    // 更新缓存后应该有效
    await vaultView.pushUserPositionUpdate(user, asset, collateral, debt);
    const isValidAfter = await vaultView.isUserCacheValid(user);
    expect(isValidAfter).to.be.true;
  });
});
```

**运行命令**:
```bash
npx hardhat test test/VaultView.test.ts --grep "缓存机制测试"
```

## 🚀 运行测试

### 运行所有 VaultView 测试

```bash
# 运行所有 VaultView 测试
npx hardhat test test/VaultView.test.ts
```

### 运行特定测试套件

```bash
# 运行初始化测试
npx hardhat test test/VaultView.test.ts --grep "初始化测试"

# 运行权限控制测试
npx hardhat test test/VaultView.test.ts --grep "权限控制测试"

# 运行查询接口测试
npx hardhat test test/VaultView.test.ts --grep "免费查询接口测试"
```

### 运行特定测试用例

```bash
# 运行特定 it 测试
npx hardhat test test/VaultView.test.ts --grep "应该正确初始化 VaultView 合约"
```

### 带 Gas 报告的测试

```bash
# 运行测试并生成 Gas 报告
REPORT_GAS=true npx hardhat test test/VaultView.test.ts
```

## 📊 测试覆盖范围

### 功能覆盖

| 功能模块 | 测试文件 | 覆盖度 |
|---------|---------|--------|
| **初始化** | `VaultView.test.ts` | ✅ 完整 |
| **权限控制** | `VaultView.test.ts` | ✅ 完整 |
| **查询接口** | `VaultView.test.ts` | ✅ 完整 |
| **事件发出** | `VaultView.test.ts` | ✅ 完整 |
| **错误处理** | `VaultView.test.ts` | ✅ 完整 |
| **边界条件** | `VaultView.test.ts` | ✅ 完整 |
| **缓存机制** | `VaultView.test.ts` | ✅ 完整 |

### 测试场景覆盖

| 测试场景 | 测试文件 | 状态 |
|---------|---------|------|
| **初始化流程** | `VaultView.test.ts` | ✅ |
| **权限验证** | `VaultView.test.ts` | ✅ |
| **查询功能** | `VaultView.test.ts` | ✅ |
| **批量查询** | `VaultView.test.ts` | ✅ |
| **事件验证** | `VaultView.test.ts` | ✅ |
| **错误处理** | `VaultView.test.ts` | ✅ |
| **边界条件** | `VaultView.test.ts` | ✅ |
| **缓存管理** | `VaultView.test.ts` | ✅ |

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
- `MockCollateralManager` - 抵押物管理器模拟
- `MockLendingEngineBasic` - 借贷引擎模拟
- `MockPriceOracle` - 价格预言机模拟
- `MockHealthFactorCalculator` - 健康因子计算器模拟

### 测试 Fixture

所有测试使用 `loadFixture` 来设置测试环境：

```typescript
async function deployFixture() {
  // 1. 部署基础合约
  const registry = await deployRegistry();
  
  // 2. 部署 Mock 合约
  const mockAccessControlManager = await deployMockAccessControlManager();
  const mockCollateralManager = await deployMockCollateralManager();
  const mockLendingEngine = await deployMockLendingEngine();
  
  // 3. 部署 VaultView
  const vaultView = await deployVaultView();
  await vaultView.initialize(registry.address);
  
  // 4. 注册模块到 Registry
  await registry.setModule(KEY_VAULT_CORE, vaultCore.address);
  await registry.setModule(KEY_CM, mockCollateralManager.address);
  await registry.setModule(KEY_LE, mockLendingEngine.address);
  
  // 5. 准备测试数据
  return { vaultView, registry, mocks, signers };
}
```

## 📝 编写新测试

### 测试文件结构

```typescript
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('VaultView – 新功能测试', function () {
  // 测试常量
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ONE_ETH = ethers.parseUnits('1', 18);
  
  // 测试变量
  let vaultView: VaultView;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  // 部署 Fixture
  async function deployFixture() {
    const [ownerSigner, userSigner] = await ethers.getSigners();
    owner = ownerSigner;
    user = userSigner;

    // 部署合约
    const VaultViewFactory = await ethers.getContractFactory('VaultView');
    vaultView = await VaultViewFactory.deploy();
    await vaultView.waitForDeployment();
    await vaultView.initialize(registryAddress);

    return { vaultView, owner, user };
  }

  // 测试用例
  describe('新功能测试', function () {
    it('应该正确执行新功能', async function () {
      const { vaultView, owner, user } = await loadFixture(deployFixture);
      
      // 执行操作
      const tx = await vaultView.connect(owner).newFunction();
      await tx.wait();
      
      // 验证结果
      expect(await vaultView.someValue()).to.equal(expectedValue);
    });
  });
});
```

### 测试最佳实践

1. **使用 loadFixture**: 避免测试之间的状态污染
2. **清晰的测试描述**: 使用中文描述测试目标
3. **完整的断言**: 验证所有相关状态变化
4. **事件验证**: 验证重要事件的触发
5. **错误处理**: 测试错误场景和边界条件
6. **Gas 优化**: 在测试中考虑 Gas 消耗

## 🐛 调试测试

### 常见问题

#### 1. 测试失败 - "UnauthorizedAccess"

**原因**: 调用者没有权限

**解决方案**:
```typescript
// 确保使用正确的调用者
await vaultView.connect(vaultCore).processUserOperation(...);
```

#### 2. 测试失败 - "ZeroAddress"

**原因**: 使用了零地址

**解决方案**:
```typescript
// 使用有效的地址
const testAsset = ethers.Wallet.createRandom().address;
```

#### 3. 测试失败 - "Module not found"

**原因**: Registry 中未注册模块

**解决方案**:
```typescript
// 确保在 deployFixture 中注册所有必需的模块
await registry.setModule(KEY_VAULT_CORE, vaultCore.address);
```

### 调试技巧

1. **使用 console.log**:
```typescript
console.log('Debug value:', await vaultView.getValue());
```

2. **使用 hardhat console**:
```bash
npx hardhat console
```

3. **使用 --verbose 标志**:
```bash
npx hardhat test --verbose test/VaultView.test.ts
```

4. **使用 --grep 过滤**:
```bash
npx hardhat test --grep "特定测试"
```

## 📈 测试性能

### 测试执行时间

| 测试文件 | 执行时间 | 测试用例数 |
|---------|---------|-----------|
| `VaultView.test.ts` | ~3-5s | 20+ |

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

- **语句覆盖率**: > 80%
- **分支覆盖率**: > 75%
- **函数覆盖率**: > 85%
- **行覆盖率**: > 80%

## 📚 相关文档

- [架构指南](../Architecture-Guide.md) - 双架构设计说明
- [平台逻辑文档](../PlatformLogic.md) - 平台整体架构
- [智能合约标准](../SmartContractStandard.md) - 代码规范

## 🎯 总结

VaultView 测试覆盖了以下关键方面：

1. ✅ **初始化流程** - 正确的合约初始化
2. ✅ **权限控制** - 细粒度的权限验证
3. ✅ **查询功能** - 0 gas 免费查询接口
4. ✅ **批量查询** - 高效的批量查询功能
5. ✅ **事件验证** - 重要事件的正确触发
6. ✅ **错误处理** - 完善的错误处理机制
7. ✅ **边界条件** - 各种边界场景处理
8. ✅ **缓存机制** - 缓存管理和有效性检查

所有测试都遵循最佳实践，使用 TypeScript 严格类型，确保代码质量和可维护性。

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

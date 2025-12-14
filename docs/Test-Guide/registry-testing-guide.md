# Registry 测试指南

## 🎯 概述

本文档提供了 RWA 借贷平台 Registry 模块注册中心测试的完整指南。Registry 是平台的核心基础设施，负责管理所有模块的注册、升级和查询，本文档基于 `test/Registry.test.ts` 及相关测试文件，详细说明了如何运行、理解和扩展 Registry 相关的测试。

## 📁 测试文件结构

Registry 系统的测试文件包括：

```
test/
├── Registry.test.ts                          # Registry 核心功能测试
├── Registry-Admin-Events.test.ts             # 管理员事件测试
├── Registry-Emergency-Admin.test.ts         # 紧急管理员测试
├── Registry-Gas-Optimization.test.ts        # Gas 优化测试
├── Registry-History-Buffer.test.ts          # 历史记录缓冲区测试
├── RegistryAdmin.security.test.ts           # RegistryAdmin 安全测试
├── RegistryDynamicModuleKey.test.ts         # 动态模块键测试
├── RegistrySignatureManager.test.ts         # 签名管理器测试
└── RegistryUpgradeManager.test.ts           # 升级管理器测试
```

## 🧪 测试分类

### 1. 核心功能测试

**文件**: `Registry.test.ts`

**测试目标**:
- 初始化与升级功能验证
- 权限管理与同步验证
- 模块注册与查询功能
- 延迟升级流程测试
- 暂停状态管理测试
- 升级历史记录测试
- 批量操作与边界条件测试
- 错误处理与安全验证

**主要测试场景**:

```typescript
describe('Registry – 核心功能测试', function () {
  // 初始化测试
  describe('初始化测试', function () {
    it('Registry – 应该正确初始化合约', async function () {
      expect(await registry.owner()).to.equal(owner.address);
      expect(await registry.paused()).to.be.false;
      expect(await registry.minDelay()).to.equal(TEST_MIN_DELAY);
    });

    it('Registry – 应该拒绝重复初始化', async function () {
      await expect(registry.initialize(TEST_MIN_DELAY))
        .to.be.revertedWith('Initializable: contract is already initialized');
    });

    it('Registry – 应该拒绝过大的延迟时间', async function () {
      // 验证延迟时间上限
    });
  });

  // 权限管理测试
  describe('权限管理测试', function () {
    it('Registry – 应该正确设置升级管理员', async function () {
      await registry.setUpgradeAdmin(admin.address);
      expect(await registry.upgradeAdmin()).to.equal(admin.address);
    });

    it('Registry – 应该正确设置紧急管理员', async function () {
      await registry.setEmergencyAdmin(emergencyAdmin.address);
      expect(await registry.emergencyAdmin()).to.equal(emergencyAdmin.address);
    });
  });

  // 模块注册测试
  describe('模块注册与查询测试', function () {
    it('Registry – 应该正确设置单个模块', async function () {
      await registry.setModule(KEY_LE, mockLendingEngine.address);
      expect(await registry.getModule(KEY_LE)).to.equal(mockLendingEngine.address);
    });

    it('Registry – 应该正确批量设置模块', async function () {
      const keys = [KEY_LE, KEY_CM];
      const addresses = [mockLendingEngine.address, mockCollateralManager.address];
      await registry.setModules(keys, addresses);
    });
  });

  // 延迟升级测试
  describe('延迟升级流程测试', function () {
    it('Registry – 应该正确排期模块升级', async function () {
      await registry.scheduleModuleUpgrade(KEY_LE, newModuleAddress, delay);
      const [pendingAddr, executeAfter] = await registry.getPendingUpgrade(KEY_LE);
      expect(pendingAddr).to.equal(newModuleAddress);
    });

    it('Registry – 应该正确执行模块升级', async function () {
      await registry.scheduleModuleUpgrade(KEY_LE, newModuleAddress, delay);
      await time.increase(delay + 1);
      await registry.executeModuleUpgrade(KEY_LE);
      expect(await registry.getModule(KEY_LE)).to.equal(newModuleAddress);
    });
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Registry.test.ts
```

### 2. 管理员事件测试

**文件**: `Registry-Admin-Events.test.ts`

**测试目标**:
- 管理员变更事件的正确发出
- 权限转移事件的验证
- 事件参数的完整性

**运行命令**:
```bash
npx hardhat test test/Registry-Admin-Events.test.ts
```

### 3. 紧急管理员测试

**文件**: `Registry-Emergency-Admin.test.ts`

**测试目标**:
- 紧急管理员权限验证
- 紧急暂停功能
- 紧急恢复功能
- 紧急情况下的模块操作

**运行命令**:
```bash
npx hardhat test test/Registry-Emergency-Admin.test.ts
```

### 4. Gas 优化测试

**文件**: `Registry-Gas-Optimization.test.ts`

**测试目标**:
- 批量操作的 Gas 消耗
- 单个操作 vs 批量操作的对比
- Gas 优化效果验证

**运行命令**:
```bash
npx hardhat test test/Registry-Gas-Optimization.test.ts
```

### 5. 历史记录缓冲区测试

**文件**: `Registry-History-Buffer.test.ts`

**测试目标**:
- 升级历史记录的正确存储
- 历史记录缓冲区的管理
- 历史记录的查询功能

**运行命令**:
```bash
npx hardhat test test/Registry-History-Buffer.test.ts
```

### 6. RegistryAdmin 安全测试

**文件**: `RegistryAdmin.security.test.ts`

**测试目标**:
- 权限控制验证
- 重入攻击防护
- 零地址检查
- 边界条件处理

**运行命令**:
```bash
npx hardhat test test/RegistryAdmin.security.test.ts
```

### 7. 动态模块键测试

**文件**: `RegistryDynamicModuleKey.test.ts`

**测试目标**:
- 动态模块键的注册
- 动态模块键的查询
- 名称规范化
- 哈希计算

**运行命令**:
```bash
npx hardhat test test/RegistryDynamicModuleKey.test.ts
```

### 8. 签名管理器测试

**文件**: `RegistrySignatureManager.test.ts`

**测试目标**:
- 签名验证功能
- 多签支持
- 签名撤销

**运行命令**:
```bash
npx hardhat test test/RegistrySignatureManager.test.ts
```

### 9. 升级管理器测试

**文件**: `RegistryUpgradeManager.test.ts`

**测试目标**:
- 升级计划管理
- 升级执行流程
- 升级取消功能
- 升级历史记录

**运行命令**:
```bash
npx hardhat test test/RegistryUpgradeManager.test.ts
```

## 🚀 运行测试

### 运行所有 Registry 测试

```bash
# 运行所有 Registry 相关测试
npx hardhat test test/Registry*.test.ts

# 运行所有 RegistryAdmin 相关测试
npx hardhat test test/RegistryAdmin*.test.ts
```

### 运行特定测试文件

```bash
# 运行核心功能测试
npx hardhat test test/Registry.test.ts

# 运行紧急管理员测试
npx hardhat test test/Registry-Emergency-Admin.test.ts

# 运行 Gas 优化测试
npx hardhat test test/Registry-Gas-Optimization.test.ts
```

### 运行特定测试用例

```bash
# 运行特定 describe 块
npx hardhat test test/Registry.test.ts --grep "模块注册与查询测试"

# 运行特定 it 测试
npx hardhat test test/Registry.test.ts --grep "应该正确设置单个模块"
```

### 带 Gas 报告的测试

```bash
# 运行测试并生成 Gas 报告
REPORT_GAS=true npx hardhat test test/Registry*.test.ts
```

## 📊 测试覆盖范围

### 功能覆盖

| 功能模块 | 测试文件 | 覆盖度 |
|---------|---------|--------|
| **核心功能** | `Registry.test.ts` | ✅ 完整 |
| **权限管理** | `Registry.test.ts` | ✅ 完整 |
| **模块注册** | `Registry.test.ts` | ✅ 完整 |
| **延迟升级** | `Registry.test.ts` | ✅ 完整 |
| **暂停管理** | `Registry.test.ts` | ✅ 完整 |
| **管理员事件** | `Registry-Admin-Events.test.ts` | ✅ 完整 |
| **紧急管理** | `Registry-Emergency-Admin.test.ts` | ✅ 完整 |
| **Gas 优化** | `Registry-Gas-Optimization.test.ts` | ✅ 完整 |
| **历史记录** | `Registry-History-Buffer.test.ts` | ✅ 完整 |
| **安全测试** | `RegistryAdmin.security.test.ts` | ✅ 完整 |
| **动态模块键** | `RegistryDynamicModuleKey.test.ts` | ✅ 完整 |
| **签名管理** | `RegistrySignatureManager.test.ts` | ✅ 完整 |
| **升级管理** | `RegistryUpgradeManager.test.ts` | ✅ 完整 |

### 测试场景覆盖

| 测试场景 | 测试文件 | 状态 |
|---------|---------|------|
| **初始化流程** | `Registry.test.ts` | ✅ |
| **权限控制** | `Registry.test.ts` | ✅ |
| **模块注册** | `Registry.test.ts` | ✅ |
| **批量操作** | `Registry.test.ts` | ✅ |
| **延迟升级** | `Registry.test.ts` | ✅ |
| **暂停恢复** | `Registry.test.ts` | ✅ |
| **事件验证** | `Registry-Admin-Events.test.ts` | ✅ |
| **紧急情况** | `Registry-Emergency-Admin.test.ts` | ✅ |
| **Gas 优化** | `Registry-Gas-Optimization.test.ts` | ✅ |
| **历史记录** | `Registry-History-Buffer.test.ts` | ✅ |
| **安全验证** | `RegistryAdmin.security.test.ts` | ✅ |
| **动态键** | `RegistryDynamicModuleKey.test.ts` | ✅ |

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

- `MockLendingEngineConcrete` - 借贷引擎模拟
- `MockCollateralManager` - 抵押物管理器模拟
- `MockPriceOracle` - 价格预言机模拟

### 测试 Fixture

所有测试使用 `loadFixture` 来设置测试环境：

```typescript
async function deployTestEnvironment() {
  // 1. 部署 Registry 实现合约
  const RegistryFactory = await ethers.getContractFactory('Registry');
  registryImplementation = await RegistryFactory.deploy();
  
  // 2. 部署代理合约
  const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
  const initData = registryImplementation.interface.encodeFunctionData('initialize', [TEST_MIN_DELAY]);
  registryProxy = await ProxyFactory.deploy(registryImplementation.target, initData);
  
  // 3. 通过代理访问 Registry
  registry = registryImplementation.attach(registryProxy.target) as Registry;
  
  // 4. 部署 Mock 合约
  mockLendingEngine = await deployMockLendingEngine();
  mockCollateralManager = await deployMockCollateralManager();
  mockPriceOracle = await deployMockPriceOracle();
  
  return { registry, mocks, signers };
}
```

## 📝 编写新测试

### 测试文件结构

```typescript
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { time } from '@nomicfoundation/hardhat-network-helpers';

describe('Registry – 新功能测试', function () {
  const TEST_MIN_DELAY = 1 * 60 * 60; // 1 hour
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  
  let registry: Registry;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;

  async function deployFixture() {
    const [ownerSigner, adminSigner] = await ethers.getSigners();
    owner = ownerSigner;
    admin = adminSigner;

    // 部署 Registry
    const RegistryFactory = await ethers.getContractFactory('Registry');
    const implementation = await RegistryFactory.deploy();
    const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const initData = implementation.interface.encodeFunctionData('initialize', [TEST_MIN_DELAY]);
    const proxy = await ProxyFactory.deploy(implementation.target, initData);
    registry = implementation.attach(proxy.target) as Registry;

    return { registry, owner, admin };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    Object.assign(this, fixture);
  });

  describe('新功能测试', function () {
    it('应该正确执行新功能', async function () {
      const { registry, owner } = await loadFixture(deployFixture);
      
      // 执行操作
      const tx = await registry.connect(owner).newFunction();
      await tx.wait();
      
      // 验证结果
      expect(await registry.someValue()).to.equal(expectedValue);
    });
  });
});
```

### 测试最佳实践

1. **使用 loadFixture**: 避免测试之间的状态污染
2. **清晰的测试描述**: 使用中文描述测试目标
3. **完整的断言**: 验证所有相关状态变化
4. **事件验证**: 验证重要事件的触发
5. **时间控制**: 使用 `time.increase()` 测试延迟升级
6. **权限验证**: 测试所有权限边界

## 🐛 调试测试

### 常见问题

#### 1. 测试失败 - "DelayTooLong"

**原因**: 延迟时间超过上限

**解决方案**:
```typescript
// 使用合理的延迟时间
const TEST_MIN_DELAY = 1 * 60 * 60; // 1 hour
```

#### 2. 测试失败 - "ModuleAlreadyRegistered"

**原因**: 模块已注册

**解决方案**:
```typescript
// 使用 setModuleWithReplaceFlag 允许替换
await registry.setModuleWithReplaceFlag(KEY_LE, newAddress, true);
```

#### 3. 测试失败 - "UpgradeNotReady"

**原因**: 延迟时间未到

**解决方案**:
```typescript
// 增加时间
await time.increase(delay + 1);
await registry.executeModuleUpgrade(KEY_LE);
```

### 调试技巧

1. **使用 console.log**:
```typescript
console.log('Module address:', await registry.getModule(KEY_LE));
```

2. **使用 hardhat console**:
```bash
npx hardhat console
```

3. **使用 --verbose 标志**:
```bash
npx hardhat test --verbose test/Registry.test.ts
```

## 📈 测试性能

### 测试执行时间

| 测试文件 | 执行时间 | 测试用例数 |
|---------|---------|-----------|
| `Registry.test.ts` | ~8-10s | 30+ |
| `Registry-Emergency-Admin.test.ts` | ~3-5s | 10+ |
| `Registry-Gas-Optimization.test.ts` | ~5-7s | 15+ |
| `RegistryDynamicModuleKey.test.ts` | ~4-6s | 12+ |

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

- [Registry 使用指南](../Usage-Guide/Registry-Guide.md) - Registry 使用说明
- [架构指南](../Architecture-Guide.md) - 系统架构说明
- [智能合约标准](../SmartContractStandard.md) - 代码规范

## 🎯 总结

Registry 测试覆盖了以下关键方面：

1. ✅ **核心功能** - 模块注册、查询、升级
2. ✅ **权限管理** - 细粒度的权限控制
3. ✅ **延迟升级** - 安全的升级流程
4. ✅ **暂停管理** - 紧急情况处理
5. ✅ **批量操作** - 高效的批量接口
6. ✅ **事件验证** - 重要事件的正确触发
7. ✅ **错误处理** - 完善的错误处理机制
8. ✅ **安全测试** - 安全漏洞防护
9. ✅ **Gas 优化** - 性能优化验证
10. ✅ **历史记录** - 完整的升级历史

所有测试都遵循最佳实践，使用 TypeScript 严格类型，确保代码质量和可维护性。

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

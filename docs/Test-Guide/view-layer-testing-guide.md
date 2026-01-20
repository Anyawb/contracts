# View 层测试指南

## 🎯 概述

本文档提供了 RWA 借贷平台 View 层测试的完整指南。View 层是双架构设计的重要组成部分，提供 0 gas 免费查询接口和缓存管理，本文档基于 `test/Vault/view/` 文件夹中的实际测试文件，详细说明了如何运行、理解和扩展 View 层相关的测试。

## 📁 测试文件结构

View 层的测试文件位于 `test/Vault/view/` 目录下：

```
test/Vault/view/
├── AccessControlView.test.ts                # 权限控制视图测试
├── BatchView.test.ts                        # 批量查询视图测试
├── CacheOptimizedView.test.ts               # 缓存优化视图测试
├── ContractLevelUserIsolation.test.ts       # 合约级用户隔离测试
├── LiquidationViewForward.test.ts           # 清算视图转发测试
├── RiskView.test.ts                         # 风险视图测试
├── SystemView.test.ts                       # 系统视图测试
├── UserView.test.ts                         # 用户视图测试
└── modules/
    ├── LiquidatorView.test.ts               # 清算人视图测试
    └── PreviewView.test.ts                  # 预览视图测试
```

## 🧪 测试分类

### 1. 用户视图测试

**文件**: `UserView.test.ts`

**测试目标**:
- 用户状态查询
- 用户位置查询
- 用户缓存管理
- 批量用户查询

**运行命令**:
```bash
npx hardhat test test/Vault/view/UserView.test.ts
```

### 2. 系统视图测试

**文件**: `SystemView.test.ts`

**测试目标**:
- 系统状态查询
- 全局统计查询
- 系统配置查询
- 系统缓存管理

**运行命令**:
```bash
npx hardhat test test/Vault/view/SystemView.test.ts
```

### 3. 权限控制视图测试

**文件**: `AccessControlView.test.ts`

**测试目标**:
- 权限查询功能
- 权限缓存管理
- 权限级别查询
- 批量权限查询

**运行命令**:
```bash
npx hardhat test test/Vault/view/AccessControlView.test.ts
```

### 4. 批量查询视图测试

**文件**: `BatchView.test.ts`

**测试目标**:
- 批量用户查询
- 批量资产查询
- 批量位置查询
- 数据一致性验证

**主要测试场景**:

```typescript
describe('BatchView – 批量查询视图测试', function () {
  it('应该正确批量获取用户位置', async function () {
    const users = [user1.address, user2.address, user3.address];
    const assets = [asset1, asset2, asset3];
    const positions = await batchView.batchGetUserPositions(users, assets);
    expect(positions.length).to.equal(3);
  });

  it('应该正确批量获取健康因子', async function () {
    const users = [user1.address, user2.address];
    const healthFactors = await batchView.batchGetHealthFactors(users);
    expect(healthFactors.length).to.equal(2);
  });

  it('应该验证数据一致性', async function () {
    // 验证批量查询结果与单个查询结果一致
    const batchResult = await batchView.batchGetUserPositions([user1.address], [asset1]);
    const singleResult = await userView.getUserPosition(user1.address, asset1);
    expect(batchResult[0].collateral).to.equal(singleResult.collateral);
    expect(batchResult[0].debt).to.equal(singleResult.debt);
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Vault/view/BatchView.test.ts
```

### 5. 缓存优化视图测试

**文件**: `CacheOptimizedView.test.ts`

**测试目标**:
- 缓存策略验证
- 缓存命中率测试
- 缓存失效机制
- 缓存性能优化

**运行命令**:
```bash
npx hardhat test test/Vault/view/CacheOptimizedView.test.ts
```

### 6. 风险视图测试

**文件**: `RiskView.test.ts`

**测试目标**:
- 风险状态查询
- 健康因子查询
- 风险指标计算
- 批量风险查询

**运行命令**:
```bash
npx hardhat test test/Vault/view/RiskView.test.ts
```

### 7. 清算人视图测试

**文件**: `modules/LiquidatorView.test.ts`

**测试目标**:
- 清算人收益查询
- 清算统计查询
- 清算人排行榜
- 清算历史查询

**运行命令**:
```bash
npx hardhat test test/Vault/view/modules/LiquidatorView.test.ts
```

### 8. 预览视图测试

**文件**: `modules/PreviewView.test.ts`

**测试目标**:
- 操作预览功能
- 费用预览
- 结果预览
- 批量预览

**运行命令**:
```bash
npx hardhat test test/Vault/view/modules/PreviewView.test.ts
```

### 9. 合约级用户隔离测试

**文件**: `ContractLevelUserIsolation.test.ts`

**测试目标**:
- 用户数据隔离
- 权限隔离验证
- 状态隔离测试
- 安全边界验证

**运行命令**:
```bash
npx hardhat test test/Vault/view/ContractLevelUserIsolation.test.ts
```

### 10. 清算视图转发测试

**文件**: `LiquidationViewForward.test.ts`

**测试目标**:
- 清算操作转发
- 权限验证
- 地址解析
- 参数传递

**运行命令**:
```bash
npx hardhat test test/Vault/view/LiquidationViewForward.test.ts
```

## 🚀 运行测试

### 运行所有 View 层测试

```bash
# 运行所有 View 层测试
npx hardhat test test/Vault/view/
```

### 运行特定测试文件

```bash
# 运行用户视图测试
npx hardhat test test/Vault/view/UserView.test.ts

# 运行批量查询测试
npx hardhat test test/Vault/view/BatchView.test.ts

# 运行权限控制视图测试
npx hardhat test test/Vault/view/AccessControlView.test.ts
```

### 运行特定测试用例

```bash
# 运行特定 describe 块
npx hardhat test test/Vault/view/BatchView.test.ts --grep "批量查询测试"

# 运行特定 it 测试
npx hardhat test test/Vault/view/BatchView.test.ts --grep "应该正确批量获取用户位置"
```

### 带 Gas 报告的测试

```bash
# 运行测试并生成 Gas 报告（View 层查询应该是 0 gas）
REPORT_GAS=true npx hardhat test test/Vault/view/
```

## 📊 测试覆盖范围

### 功能覆盖

| 功能模块 | 测试文件 | 覆盖度 |
|---------|---------|--------|
| **用户视图** | `UserView.test.ts` | ✅ 完整 |
| **系统视图** | `SystemView.test.ts` | ✅ 完整 |
| **权限视图** | `AccessControlView.test.ts` | ✅ 完整 |
| **批量查询** | `BatchView.test.ts` | ✅ 完整 |
| **缓存优化** | `CacheOptimizedView.test.ts` | ✅ 完整 |
| **风险视图** | `RiskView.test.ts` | ✅ 完整 |
| **清算人视图** | `modules/LiquidatorView.test.ts` | ✅ 完整 |
| **预览视图** | `modules/PreviewView.test.ts` | ✅ 完整 |
| **用户隔离** | `ContractLevelUserIsolation.test.ts` | ✅ 完整 |
| **视图转发** | `LiquidationViewForward.test.ts` | ✅ 完整 |

### 测试场景覆盖

| 测试场景 | 测试文件 | 状态 |
|---------|---------|------|
| **查询功能** | 所有测试文件 | ✅ |
| **批量查询** | `BatchView.test.ts` | ✅ |
| **缓存管理** | `CacheOptimizedView.test.ts` | ✅ |
| **数据一致性** | `BatchView.test.ts` | ✅ |
| **权限验证** | `AccessControlView.test.ts` | ✅ |
| **用户隔离** | `ContractLevelUserIsolation.test.ts` | ✅ |
| **视图转发** | `LiquidationViewForward.test.ts` | ✅ |
| **边界条件** | 所有测试文件 | ✅ |
| **错误处理** | 所有测试文件 | ✅ |

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
- `MockLendingEngine` - 借贷引擎模拟

### 测试 Fixture

所有测试使用 `loadFixture` 来设置测试环境：

```typescript
async function deployFixture() {
  // 1. 部署基础合约
  const registry = await deployMockRegistry();
  
  // 2. 部署 View 层合约
  const userView = await deployUserView();
  const systemView = await deploySystemView();
  const batchView = await deployBatchView();
  
  // 3. 初始化 View 层合约
  await userView.initialize(registry.address);
  await systemView.initialize(registry.address);
  await batchView.initialize(registry.address);
  
  // 4. 注册模块到 Registry
  await registry.setModule(KEY_VAULT_CORE, vaultCore.address);
  await registry.setModule(KEY_CM, collateralManager.address);
  await registry.setModule(KEY_LE, lendingEngine.address);
  
  // 5. 准备测试数据
  return { userView, systemView, batchView, registry, ... };
}
```

## 📝 编写新测试

### 测试文件结构

```typescript
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('ViewModule – 新功能测试', function () {
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  
  let viewModule: ViewModule;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  async function deployFixture() {
    const [ownerSigner, userSigner] = await ethers.getSigners();
    owner = ownerSigner;
    user = userSigner;

    // 部署 View 层合约
    const ViewModuleFactory = await ethers.getContractFactory('ViewModule');
    viewModule = await ViewModuleFactory.deploy();
    await viewModule.waitForDeployment();
    await viewModule.initialize(registryAddress);

    return { viewModule, owner, user };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    Object.assign(this, fixture);
  });

  describe('新功能测试', function () {
    it('应该正确执行新功能', async function () {
      const { viewModule, user } = await loadFixture(deployFixture);
      
      // 执行查询（0 gas）
      const result = await viewModule.getUserData(user.address);
      
      // 验证结果
      expect(result).to.equal(expectedValue);
    });
  });
});
```

### 测试最佳实践

1. **使用 loadFixture**: 避免测试之间的状态污染
2. **清晰的测试描述**: 使用中文描述测试目标
3. **完整的断言**: 验证所有相关状态变化
4. **0 gas 验证**: 确保所有 view 函数确实是 0 gas
5. **缓存验证**: 验证缓存机制的正确性
6. **数据一致性**: 验证批量查询与单个查询的一致性

## 🐛 调试测试

### 常见问题

#### 1. 测试失败 - "Cache not valid"

**原因**: 缓存已过期

**解决方案**:
```typescript
// 先更新缓存
await viewModule.pushDataUpdate(user, data);
// 然后查询
const result = await viewModule.getUserData(user);
```

#### 2. 测试失败 - "Data inconsistency"

**原因**: 批量查询结果与单个查询不一致

**解决方案**:
```typescript
// 验证数据一致性
const batchResult = await batchView.batchGetUserPositions([user], [asset]);
const singleResult = await userView.getUserPosition(user, asset);
expect(batchResult[0].collateral).to.equal(singleResult.collateral);
```

### 调试技巧

1. **使用 console.log**:
```typescript
console.log('User data:', await viewModule.getUserData(user.address));
console.log('Cache valid:', await viewModule.isCacheValid(user.address));
```

2. **使用 hardhat console**:
```bash
npx hardhat console
```

3. **使用 --verbose 标志**:
```bash
npx hardhat test --verbose test/Vault/view/
```

## 📈 测试性能

### 测试执行时间

| 测试文件 | 执行时间 | 测试用例数 |
|---------|---------|-----------|
| `UserView.test.ts` | ~3-5s | 15+ |
| `BatchView.test.ts` | ~5-7s | 20+ |
| `AccessControlView.test.ts` | ~4-6s | 12+ |
| `CacheOptimizedView.test.ts` | ~6-8s | 18+ |
| `RiskView.test.ts` | ~4-6s | 10+ |

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

- [架构指南](../Architecture-Guide.md) - 双架构设计说明
- [VaultRouter 测试指南](./vaultview-testing-guide.md) - VaultRouter 测试说明
- [智能合约标准](../SmartContractStandard.md) - 代码规范

## 🎯 总结

View 层测试覆盖了以下关键方面：

1. ✅ **查询功能** - 0 gas 免费查询接口
2. ✅ **批量查询** - 高效的批量查询功能
3. ✅ **缓存管理** - 缓存策略和失效机制
4. ✅ **数据一致性** - 批量查询与单个查询的一致性
5. ✅ **权限验证** - 权限查询和缓存
6. ✅ **用户隔离** - 合约级用户数据隔离
7. ✅ **视图转发** - 清算操作的视图转发
8. ✅ **边界条件** - 各种边界场景处理
9. ✅ **错误处理** - 完善的错误处理机制
10. ✅ **性能优化** - 缓存优化和性能提升

所有测试都遵循最佳实践，使用 TypeScript 严格类型，确保代码质量和可维护性。View 层的所有查询函数都应该是 0 gas，这是双架构设计的核心优势。

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

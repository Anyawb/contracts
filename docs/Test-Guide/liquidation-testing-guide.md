# 清算系统测试指南

## 🎯 概述

本文档提供了 RWA 借贷平台清算系统测试的完整指南。清算系统是平台风险管理的核心组件，本文档基于 `test/Vault/liquidation/` 文件夹中的实际测试文件，详细说明了如何运行、理解和扩展清算相关的测试。

## 📁 测试文件结构

清算系统的测试文件位于 `test/Vault/liquidation/` 目录下：

```
test/Vault/liquidation/
├── Liquidation.e2e.test.ts                          # 端到端清算测试
├── LiquidationRiskManagerRegistry.test.ts           # Registry 集成测试
├── LiquidationCollateralManager.test.ts             # 抵押物管理器测试
├── LiquidationCollateralManagerDynamicModuleKey.test.ts  # 动态模块键测试
├── LiquidationRiskManager.graceful-degradation.test.ts   # 优雅降级测试
├── LiquidationDebtManager.test.ts                   # 债务管理器测试
└── LiquidationGuaranteeManager.registry.test.ts     # 保证金管理器测试

test/Vault/view/
├── LiquidationViewForward.test.ts                   # 视图转发测试
└── modules/
    └── LiquidatorView.test.ts                        # 清算人视图测试
```

## 🧪 测试分类

### 1. 端到端测试 (E2E)

**文件**: `Liquidation.e2e.test.ts`

**测试目标**:
- 完整的清算流程验证
- Registry 模块装配
- 用户抵押 → 设置债务 → 执行清算
- 状态一致性验证

**主要测试场景**:

```typescript
describe('Liquidation - E2E', function () {
  // 清算端到端测试
  it('应该执行清算端到端并减少用户债务同时扣押抵押物', async function () {
    // 1. 设置用户抵押和债务
    // 2. 执行清算操作
    // 3. 验证债务减少
    // 4. 验证抵押物扣押
    // 5. 验证事件触发
  });

  // 权限控制测试
  it('应该拒绝非清算人调用清算功能', async function () {
    // 验证只有具有 ACTION_LIQUIDATE 权限的地址才能执行清算
  });

  // 边界条件测试
  it('应该处理最大数量清算', async function () {
    // 测试大额清算场景
  });

  // 批量清算测试
  it('应该执行批量清算操作', async function () {
    // 测试批量清算多个用户
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Vault/liquidation/Liquidation.e2e.test.ts
```

### 2. Registry 集成测试

**文件**: `LiquidationRiskManagerRegistry.test.ts`

**测试目标**:
- Registry 模块注册和获取
- 模块升级流程
- 命名规范合规性
- 错误处理

**主要测试场景**:

```typescript
describe("LiquidationRiskManager Registry Upgrade", function () {
  // Registry 集成测试
  describe("Registry Integration", function () {
    it("should initialize with Registry address", async function () {
      // 验证初始化时正确设置 Registry 地址
    });

    it("should get module from Registry", async function () {
      // 验证从 Registry 获取模块地址
    });
  });

  // 升级流程测试
  describe("Upgrade Flow", function () {
    it("should schedule module upgrade", async function () {
      // 测试模块升级计划
    });

    it("should get pending upgrade info", async function () {
      // 测试获取待升级信息
    });

    it("should cancel module upgrade", async function () {
      // 测试取消升级
    });
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Vault/liquidation/LiquidationRiskManagerRegistry.test.ts
```

### 3. 抵押物管理器测试

**文件**: `LiquidationCollateralManager.test.ts`

**测试目标**:
- 抵押物扣押功能
- 批量清算操作
- 抵押物转移和记录管理
- 查询功能和批量查询
- 权限控制和访问管理
- 升级功能和 Registry 集成
- 紧急暂停和恢复功能
- 错误处理和边界条件
- 优雅降级和价格预言机集成

**主要测试场景**:

```typescript
describe('LiquidationCollateralManager – 清算抵押物管理器测试', function () {
  // 初始化测试
  describe('初始化测试', function () {
    it('应该正确初始化代理合约', async function () {
      // 验证代理合约初始化
    });
  });

  // 核心功能测试
  describe('抵押物扣押测试', function () {
    it('应该正确扣押用户抵押物', async function () {
      // 测试扣押功能
    });

    it('应该正确转移抵押物给清算人', async function () {
      // 测试转移功能
    });
  });

  // 批量操作测试
  describe('批量操作测试', function () {
    it('应该正确执行批量扣押', async function () {
      // 测试批量扣押
    });
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Vault/liquidation/LiquidationCollateralManager.test.ts
```

### 4. 债务管理器测试

**文件**: `LiquidationDebtManager.test.ts`

**测试目标**:
- 债务减少功能
- 清算积分奖励功能
- 清算惩罚积分功能
- 批量债务减少

**主要测试场景**:

```typescript
describe("LiquidationDebtManager - 新增积分功能", function () {
  // 清算积分奖励功能
  describe("清算积分奖励功能", function () {
    it("应该正确计算清算人奖励积分", async function () {
      const debtValue = ethers.parseEther("100");
      const expectedReward = debtValue * 500n / 10000n; // 5%
      const rewardPoints = await liquidationDebtManager.calculateLiquidationReward(debtValue);
      expect(rewardPoints).to.equal(expectedReward);
    });

    it("应该正确计算清算惩罚积分", async function () {
      // 测试惩罚积分计算
    });
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Vault/liquidation/LiquidationDebtManager.test.ts
```

### 5. 优雅降级测试

**文件**: `LiquidationRiskManager.graceful-degradation.test.ts`

**测试目标**:
- 价格预言机正常情况下的功能
- 价格预言机失败时的降级策略
- 健康因子计算降级事件
- 价格预言机健康检查功能

**主要测试场景**:

```typescript
describe("LiquidationRiskManager - Graceful Degradation", function () {
  it("应该处理价格预言机正常情况", async function () {
    // 测试正常价格获取
  });

  it("应该处理价格预言机失败情况", async function () {
    // 测试价格预言机失败时的降级策略
  });

  it("应该触发健康因子计算降级事件", async function () {
    // 测试降级事件触发
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Vault/liquidation/LiquidationRiskManager.graceful-degradation.test.ts
```

### 6. 视图转发测试

**文件**: `LiquidationViewForward.test.ts`

**测试目标**:
- LiquidationManager → VaultRouter 写路径转发
- 权限校验（onlyLiquidationManager）
- 地址解析和调用参数传递
- 不变式验证（无直接状态写入在 View）

**主要测试场景**:

```typescript
describe('VaultRouter – Liquidation forward path (skeleton)', function () {
  it('forwardSeizeCollateral: should route to CollateralManager.withdrawCollateral', async function () {
    // 测试抵押物扣押转发
  });

  it('forwardReduceDebt: should route to LendingEngine.forceReduceDebt', async function () {
    // 测试债务减少转发
  });

  it('should revert if caller is not Registry->KEY_LIQUIDATION_MANAGER', async function () {
    // 测试权限验证
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Vault/view/LiquidationViewForward.test.ts
```

### 7. 清算人视图测试

**文件**: `LiquidatorView.test.ts`

**测试目标**:
- 清算人收益监控查询功能
- 权限控制验证
- 边界条件处理
- 集成测试场景
- 安全场景测试

**主要测试场景**:

```typescript
describe('LiquidatorView – 合约功能测试', function () {
  it('应该正确获取清算人收益统计', async function () {
    // 测试收益统计查询
  });

  it('应该正确获取全局清算统计', async function () {
    // 测试全局统计查询
  });

  it('应该正确获取清算人排行榜', async function () {
    // 测试排行榜查询
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Vault/view/modules/LiquidatorView.test.ts
```

## 🚀 运行测试

### 运行所有清算测试

```bash
# 运行所有清算相关测试
npx hardhat test test/Vault/liquidation/

# 运行所有视图相关测试
npx hardhat test test/Vault/view/
```

### 运行特定测试文件

```bash
# 运行端到端测试
npx hardhat test test/Vault/liquidation/Liquidation.e2e.test.ts

# 运行抵押物管理器测试
npx hardhat test test/Vault/liquidation/LiquidationCollateralManager.test.ts

# 运行债务管理器测试
npx hardhat test test/Vault/liquidation/LiquidationDebtManager.test.ts
```

### 运行特定测试用例

```bash
# 运行特定 describe 块
npx hardhat test test/Vault/liquidation/Liquidation.e2e.test.ts --grep "清算端到端测试"

# 运行特定 it 测试
npx hardhat test test/Vault/liquidation/Liquidation.e2e.test.ts --grep "应该执行清算端到端"
```

### 带 Gas 报告的测试

```bash
# 运行测试并生成 Gas 报告
REPORT_GAS=true npx hardhat test test/Vault/liquidation/
```

## 📊 测试覆盖范围

### 功能覆盖

| 功能模块 | 测试文件 | 覆盖度 |
|---------|---------|--------|
| **清算执行** | `Liquidation.e2e.test.ts` | ✅ 完整 |
| **风险评估** | `LiquidationRiskManagerRegistry.test.ts` | ✅ 完整 |
| **抵押物管理** | `LiquidationCollateralManager.test.ts` | ✅ 完整 |
| **债务管理** | `LiquidationDebtManager.test.ts` | ✅ 完整 |
| **优雅降级** | `LiquidationRiskManager.graceful-degradation.test.ts` | ✅ 完整 |
| **视图转发** | `LiquidationViewForward.test.ts` | ✅ 完整 |
| **清算人视图** | `LiquidatorView.test.ts` | ✅ 完整 |
| **动态模块键** | `LiquidationCollateralManagerDynamicModuleKey.test.ts` | ✅ 完整 |
| **保证金管理** | `LiquidationGuaranteeManager.registry.test.ts` | ✅ 完整 |

### 测试场景覆盖

| 测试场景 | 测试文件 | 状态 |
|---------|---------|------|
| **端到端清算流程** | `Liquidation.e2e.test.ts` | ✅ |
| **权限控制** | 所有测试文件 | ✅ |
| **边界条件** | `Liquidation.e2e.test.ts` | ✅ |
| **批量操作** | `Liquidation.e2e.test.ts` | ✅ |
| **事件验证** | `Liquidation.e2e.test.ts` | ✅ |
| **Registry 集成** | `LiquidationRiskManagerRegistry.test.ts` | ✅ |
| **模块升级** | `LiquidationRiskManagerRegistry.test.ts` | ✅ |
| **优雅降级** | `LiquidationRiskManager.graceful-degradation.test.ts` | ✅ |
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

3. **配置环境变量** (如需要):
```bash
# .env 文件
PRIVATE_KEY=your_private_key
ARBISCAN_API_KEY=your_api_key
```

### Mock 合约

测试使用以下 Mock 合约：

- `MockRegistry` - Registry 模拟
- `MockCollateralManager` - 抵押物管理器模拟
- `MockLendingEngineBasic` - 借贷引擎模拟
- `MockLiquidationManager` - 清算管理器模拟
- `MockLiquidationView` - 清算视图模拟
- `MockAccessControlManager` - 权限控制模拟
- `MockPriceOracle` - 价格预言机模拟
- `MockERC20` - ERC20 代币模拟

### 测试 Fixture

所有测试使用 `loadFixture` 来设置测试环境：

```typescript
async function deployFixture() {
  // 1. 部署基础合约
  // 2. 部署 Mock 合约
  // 3. 注册模块到 Registry
  // 4. 设置权限
  // 5. 准备测试数据
  return { contracts, signers, testData };
}
```

## 📝 编写新测试

### 测试文件结构

```typescript
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('Your Test Suite', function () {
  // 测试常量
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  
  // 测试变量
  let contract: Contract;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  // 部署 Fixture
  async function deployFixture() {
    const [ownerSigner, userSigner] = await ethers.getSigners();
    owner = ownerSigner;
    user = userSigner;

    // 部署合约
    const ContractFactory = await ethers.getContractFactory('YourContract');
    contract = await ContractFactory.deploy();
    await contract.waitForDeployment();

    return { contract, owner, user };
  }

  // 测试用例
  describe('功能测试', function () {
    it('应该正确执行功能', async function () {
      const { contract, owner, user } = await loadFixture(deployFixture);
      
      // 执行操作
      const tx = await contract.connect(owner).someFunction();
      await tx.wait();
      
      // 验证结果
      expect(await contract.someValue()).to.equal(expectedValue);
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

#### 1. 测试失败 - "Module not found"

**原因**: Registry 中未注册模块

**解决方案**:
```typescript
// 确保在 deployFixture 中注册所有必需的模块
await registry.setModule(KEY_LIQUIDATION_MANAGER, await liquidationManager.getAddress());
```

#### 2. 测试失败 - "Insufficient permission"

**原因**: 缺少必要的权限

**解决方案**:
```typescript
// 授予必要的权限
await accessControlManager.grantRole(
  ActionKeys.ACTION_LIQUIDATE,
  liquidatorAddress
);
```

#### 3. 测试失败 - "Zero address"

**原因**: 使用了零地址

**解决方案**:
```typescript
// 使用有效的地址
const testAsset = ethers.Wallet.createRandom().address;
```

### 调试技巧

1. **使用 console.log**:
```typescript
console.log('Debug value:', await contract.getValue());
```

2. **使用 hardhat console**:
```bash
npx hardhat console
```

3. **使用 --verbose 标志**:
```bash
npx hardhat test --verbose
```

4. **使用 --grep 过滤**:
```bash
npx hardhat test --grep "特定测试"
```

## 📈 测试性能

### 测试执行时间

| 测试文件 | 执行时间 | 测试用例数 |
|---------|---------|-----------|
| `Liquidation.e2e.test.ts` | ~5s | 10+ |
| `LiquidationCollateralManager.test.ts` | ~8s | 20+ |
| `LiquidationDebtManager.test.ts` | ~3s | 5+ |
| `LiquidationRiskManager.graceful-degradation.test.ts` | ~4s | 8+ |

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

- [清算系统集成总结](./liquidation-system-integration-summary.md) - 清算系统架构和实现
- [借贷使用指南](../Usage-Guide/Lending-Guide.md) - 借贷功能使用指南
- [权限管理指南](../Usage-Guide/permission-management-guide.md) - 权限系统说明

## 🎯 总结

清算系统测试覆盖了以下关键方面：

1. ✅ **端到端流程** - 完整的清算执行流程
2. ✅ **模块集成** - Registry 和模块间的集成
3. ✅ **权限控制** - 细粒度的权限验证
4. ✅ **边界条件** - 各种边界场景处理
5. ✅ **错误处理** - 完善的错误处理机制
6. ✅ **优雅降级** - 外部依赖失败时的降级策略
7. ✅ **事件验证** - 重要事件的正确触发
8. ✅ **批量操作** - 高效的批量清算功能

所有测试都遵循最佳实践，使用 TypeScript 严格类型，确保代码质量和可维护性。

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

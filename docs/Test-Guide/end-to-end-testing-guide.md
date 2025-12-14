# 端到端测试指南

## 🎯 概述

本文档提供了 RWA 借贷平台端到端 (E2E) 测试的完整指南。端到端测试验证完整的业务流程，包括用户路径、批量操作、风险监控、优雅降级等，本文档基于 `test/EndToEnd.UserPath.batch.risk.degradation.test.ts` 及相关测试文件，详细说明了如何运行、理解和扩展端到端测试。

## 📁 测试文件结构

端到端测试文件包括：

```
test/
├── EndToEnd.UserPath.batch.risk.degradation.test.ts  # 综合端到端测试
├── Reward/
│   ├── Reward.e2e.test.ts                           # Reward 端到端测试
│   ├── Settlement.e2e.test.ts                       # 撮合结算端到端测试
│   └── Settlement.Reward.e2e.test.ts                # 撮合+奖励端到端测试
└── Vault/liquidation/
    └── Liquidation.e2e.test.ts                      # 清算端到端测试
```

## 🧪 测试分类

### 1. 综合端到端测试

**文件**: `EndToEnd.UserPath.batch.risk.degradation.test.ts`

**测试目标**:
- 用户完整路径验证
- 批量操作测试
- 风险监控和健康因子
- 优雅降级功能
- 系统集成验证
- 性能和 Gas 优化

**主要测试场景**:

```typescript
describe('End-to-End – 用户路径 / 批量 / 风险 / 降级 / Gas', function () {
  describe('基础功能验证', function () {
    it('应该正确执行用户完整路径', async function () {
      // 1. 用户存款
      await vaultCore.deposit(asset, depositAmount);
      
      // 2. 用户借款
      await vaultCore.borrow(asset, borrowAmount);
      
      // 3. 用户还款
      await vaultCore.repay(asset, repayAmount);
      
      // 4. 用户提款
      await vaultCore.withdraw(asset, withdrawAmount);
      
      // 验证最终状态
      const collateral = await collateralManager.getCollateral(user, asset);
      const debt = await lendingEngine.getDebt(user, asset);
      expect(collateral).to.equal(expectedCollateral);
      expect(debt).to.equal(expectedDebt);
    });
  });

  describe('批量接口 – 通过业务逻辑模块', function () {
    it('应该正确执行批量存款', async function () {
      const assets = [asset1, asset2, asset3];
      const amounts = [amount1, amount2, amount3];
      await vaultBusinessLogic.batchDeposit(assets, amounts);
      
      // 验证所有资产都正确存入
      for (let i = 0; i < assets.length; i++) {
        const collateral = await collateralManager.getCollateral(user, assets[i]);
        expect(collateral).to.equal(amounts[i]);
      }
    });
  });

  describe('预言机异常 – 优雅降级不中断', function () {
    it('应该处理价格预言机失败', async function () {
      // 模拟价格预言机失败
      await mockPriceOracle.setShouldFail(true);
      
      // 业务操作应该继续，使用降级策略
      await vaultCore.borrow(asset, amount);
      
      // 验证使用了降级价格
      const priceResult = await priceOracle.getPriceWithFallback(asset);
      expect(priceResult.usedFallback).to.be.true;
    });
  });

  describe('风险监控与健康因子', function () {
    it('应该正确监控用户健康因子', async function () {
      // 设置用户抵押和债务
      await vaultCore.deposit(asset, collateralAmount);
      await vaultCore.borrow(asset, borrowAmount);
      
      // 查询健康因子
      const healthFactor = await healthView.getUserHealthFactor(user);
      expect(healthFactor).to.be.gt(0);
      
      // 验证风险状态
      const riskStatus = await riskView.getUserRiskStatus(user);
      expect(riskStatus.isUnderCollateralized).to.be.false;
    });
  });

  describe('系统集成验证', function () {
    it('应该正确集成所有模块', async function () {
      // 验证 Registry 模块注册
      const cmAddr = await registry.getModule(KEY_CM);
      const leAddr = await registry.getModule(KEY_LE);
      expect(cmAddr).to.not.equal(ZERO_ADDRESS);
      expect(leAddr).to.not.equal(ZERO_ADDRESS);
      
      // 验证模块间协作
      await vaultCore.deposit(asset, amount);
      const collateral = await collateralManager.getCollateral(user, asset);
      expect(collateral).to.equal(amount);
    });
  });

  describe('性能与Gas优化测试', function () {
    it('应该验证 Gas 消耗在合理范围内', async function () {
      const tx = await vaultCore.deposit(asset, amount);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed;
      
      // 验证 Gas 消耗
      expect(gasUsed).to.be.lt(MAX_GAS_LIMIT);
    });
  });
});
```

**运行命令**:
```bash
npx hardhat test test/EndToEnd.UserPath.batch.risk.degradation.test.ts
```

### 2. Reward 端到端测试

**文件**: `Reward/Reward.e2e.test.ts`

**测试目标**:
- LE 落账后触发奖励
- 积分计算和发放
- RewardView 数据推送
- 用户等级升级

**运行命令**:
```bash
npx hardhat test test/Reward/Reward.e2e.test.ts
```

### 3. 撮合结算端到端测试

**文件**: `Reward/Settlement.e2e.test.ts`, `Reward/Settlement.Reward.e2e.test.ts`

**测试目标**:
- 撮合结算完整流程
- 结算与奖励的集成
- 双架构设计验证

**运行命令**:
```bash
npx hardhat test test/Reward/Settlement.e2e.test.ts
npx hardhat test test/Reward/Settlement.Reward.e2e.test.ts
```

### 4. 清算端到端测试

**文件**: `Vault/liquidation/Liquidation.e2e.test.ts`

**测试目标**:
- 完整清算流程
- 抵押物扣押和债务减少
- 清算奖励和惩罚

**运行命令**:
```bash
npx hardhat test test/Vault/liquidation/Liquidation.e2e.test.ts
```

## 🚀 运行测试

### 运行所有端到端测试

```bash
# 运行所有端到端测试
npx hardhat test test/EndToEnd*.test.ts
npx hardhat test test/Reward/*.e2e.test.ts
npx hardhat test test/Vault/liquidation/*.e2e.test.ts
```

### 运行特定测试文件

```bash
# 运行综合端到端测试
npx hardhat test test/EndToEnd.UserPath.batch.risk.degradation.test.ts

# 运行 Reward 端到端测试
npx hardhat test test/Reward/Reward.e2e.test.ts

# 运行撮合结算测试
npx hardhat test test/Reward/Settlement.e2e.test.ts
```

### 运行特定测试用例

```bash
# 运行特定 describe 块
npx hardhat test test/EndToEnd.UserPath.batch.risk.degradation.test.ts --grep "用户完整路径"

# 运行特定 it 测试
npx hardhat test test/EndToEnd.UserPath.batch.risk.degradation.test.ts --grep "应该正确执行用户完整路径"
```

### 带 Gas 报告的测试

```bash
# 运行测试并生成 Gas 报告
REPORT_GAS=true npx hardhat test test/EndToEnd*.test.ts
```

## 📊 测试覆盖范围

### 功能覆盖

| 功能模块 | 测试文件 | 覆盖度 |
|---------|---------|--------|
| **用户完整路径** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ 完整 |
| **批量操作** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ 完整 |
| **风险监控** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ 完整 |
| **优雅降级** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ 完整 |
| **系统集成** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ 完整 |
| **性能优化** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ 完整 |
| **Reward 集成** | `Reward/Reward.e2e.test.ts` | ✅ 完整 |
| **撮合结算** | `Reward/Settlement.e2e.test.ts` | ✅ 完整 |
| **清算流程** | `Vault/liquidation/Liquidation.e2e.test.ts` | ✅ 完整 |

### 测试场景覆盖

| 测试场景 | 测试文件 | 状态 |
|---------|---------|------|
| **用户路径** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ |
| **批量操作** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ |
| **风险监控** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ |
| **优雅降级** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ |
| **系统集成** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ |
| **性能测试** | `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ✅ |
| **Reward 流程** | `Reward/Reward.e2e.test.ts` | ✅ |
| **撮合流程** | `Reward/Settlement.e2e.test.ts` | ✅ |
| **清算流程** | `Vault/liquidation/Liquidation.e2e.test.ts` | ✅ |

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

### 完整测试环境

端到端测试需要完整的系统环境：

- Registry 已部署并配置
- 所有核心模块已注册
- 权限已正确设置
- Mock 合约已部署

### 测试 Fixture

端到端测试使用完整的系统 Fixture：

```typescript
async function deployFullSystemFixture() {
  // 1. 部署 Registry
  const registry = await deployRegistry();
  
  // 2. 部署所有核心模块
  const vaultCore = await deployVaultCore();
  const vaultView = await deployVaultView();
  const collateralManager = await deployCollateralManager();
  const lendingEngine = await deployLendingEngine();
  const priceOracle = await deployPriceOracle();
  const rewardManager = await deployRewardManager();
  // ... 其他模块
  
  // 3. 注册所有模块到 Registry
  await registry.setModule(KEY_VAULT_CORE, vaultCore.address);
  await registry.setModule(KEY_VAULT_VIEW, vaultView.address);
  await registry.setModule(KEY_CM, collateralManager.address);
  await registry.setModule(KEY_LE, lendingEngine.address);
  // ... 其他模块
  
  // 4. 初始化所有模块
  await vaultCore.initialize(registry.address, vaultView.address);
  await vaultView.initialize(registry.address);
  // ... 其他初始化
  
  // 5. 设置权限
  await accessControlManager.grantRole(ACTION_DEPOSIT, user.address);
  await accessControlManager.grantRole(ACTION_BORROW, user.address);
  // ... 其他权限
  
  return { registry, vaultCore, vaultView, ... };
}
```

## 📝 编写新端到端测试

### 测试文件结构

```typescript
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('Feature E2E – 功能端到端测试', function () {
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ONE_ETH = ethers.parseUnits('1', 18);
  
  let system: FullSystem;
  let user: SignerWithAddress;

  async function deployFullSystemFixture() {
    // 部署完整系统
    const system = await deployCompleteSystem();
    return { system, user };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFullSystemFixture);
    Object.assign(this, fixture);
  });

  describe('完整流程测试', function () {
    it('应该正确执行完整业务流程', async function () {
      const { system, user } = await loadFixture(deployFullSystemFixture);
      
      // 执行完整流程
      // 1. 存款
      // 2. 借款
      // 3. 还款
      // 4. 提款
      
      // 验证最终状态
      // 验证所有事件
      // 验证统计数据
    });
  });
});
```

### 测试最佳实践

1. **完整流程**: 测试完整的业务流程
2. **状态验证**: 验证每个步骤的状态变化
3. **事件验证**: 验证所有重要事件
4. **集成验证**: 验证模块间的协作
5. **性能验证**: 验证 Gas 消耗和性能
6. **错误处理**: 测试错误场景和恢复

## 🐛 调试测试

### 常见问题

#### 1. 测试失败 - "Module not found"

**原因**: 模块未在 Registry 中注册

**解决方案**:
```typescript
// 确保所有模块都已注册
await registry.setModule(KEY_VAULT_CORE, vaultCore.address);
await registry.setModule(KEY_CM, collateralManager.address);
// ... 其他模块
```

#### 2. 测试失败 - "Insufficient balance"

**原因**: 测试账户余额不足

**解决方案**:
```typescript
// 为测试账户充值
await token.mint(user.address, sufficientAmount);
```

### 调试技巧

1. **使用 console.log**:
```typescript
console.log('User collateral:', await collateralManager.getCollateral(user, asset));
console.log('User debt:', await lendingEngine.getDebt(user, asset));
console.log('Health factor:', await healthView.getUserHealthFactor(user));
```

2. **使用 hardhat console**:
```bash
npx hardhat console
```

3. **使用 --verbose 标志**:
```bash
npx hardhat test --verbose test/EndToEnd*.test.ts
```

## 📈 测试性能

### 测试执行时间

| 测试文件 | 执行时间 | 测试用例数 |
|---------|---------|-----------|
| `EndToEnd.UserPath.batch.risk.degradation.test.ts` | ~30-40s | 50+ |
| `Reward/Reward.e2e.test.ts` | ~10-12s | 15+ |
| `Reward/Settlement.e2e.test.ts` | ~12-15s | 10+ |
| `Vault/liquidation/Liquidation.e2e.test.ts` | ~8-10s | 10+ |

### 优化建议

1. **使用并行测试**: Hardhat 默认并行运行测试
2. **减少不必要的部署**: 重用 Fixture
3. **优化测试顺序**: 先运行快速测试
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

- [VaultView 测试指南](./vaultview-testing-guide.md) - VaultView 测试说明
- [Reward 测试指南](./reward-testing-guide.md) - Reward 测试说明
- [清算系统测试指南](./liquidation-testing-guide.md) - 清算测试说明
- [架构指南](../Architecture-Guide.md) - 系统架构说明

## 🎯 总结

端到端测试覆盖了以下关键方面：

1. ✅ **完整流程** - 用户完整操作路径
2. ✅ **批量操作** - 高效的批量接口
3. ✅ **风险监控** - 健康因子和风险状态
4. ✅ **优雅降级** - 外部依赖失败时的降级
5. ✅ **系统集成** - 所有模块的协作
6. ✅ **性能优化** - Gas 消耗和性能验证
7. ✅ **Reward 集成** - 奖励系统的完整流程
8. ✅ **撮合结算** - 撮合和结算的完整流程
9. ✅ **清算流程** - 清算的完整执行流程
10. ✅ **边界条件** - 各种边界场景处理

所有测试都遵循最佳实践，使用 TypeScript 严格类型，确保代码质量和可维护性。端到端测试是验证系统整体功能的重要方式。

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

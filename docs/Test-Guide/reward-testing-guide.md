# Reward 测试指南

## 🎯 概述

本文档提供了 RWA 借贷平台 Reward 奖励系统测试的完整指南。Reward 系统是平台的核心激励机制，负责积分计算、发放、消费和等级管理，本文档基于 `test/Reward/` 文件夹中的实际测试文件，详细说明了如何运行、理解和扩展 Reward 相关的测试。

## 📁 测试文件结构

Reward 系统的测试文件位于 `test/Reward/` 目录下：

```
test/Reward/
├── Reward.e2e.test.ts                    # 端到端奖励测试
├── RewardManagerCore.test.ts             # 奖励管理器核心逻辑测试
├── RewardManagerIntegration.test.ts      # 奖励管理器集成测试
├── RewardConfig.test.ts                  # 奖励配置测试
├── RewardConsumption.integration.test.ts # 奖励消费集成测试
├── Settlement.e2e.test.ts                # 撮合结算端到端测试
├── Settlement.Reward.e2e.test.ts         # 撮合+奖励端到端测试
├── ServiceConfigs.test.ts                # 服务配置测试
├── PriorityServiceConfig.test.ts         # 优先服务配置测试
└── AdvancedAnalyticsConfig.test.ts       # 高级分析配置测试
```

## 🧪 测试分类

### 1. 端到端测试 (E2E)

**文件**: `Reward.e2e.test.ts`

**测试目标**:
- 完整的奖励流程验证（LE 落账后触发 → RM/Core → RewardView → DataPush）
- Registry 注册与模块键映射
- 积分计算和发放
- 用户等级管理
- 积分消费场景
- 惩罚机制

**主要测试场景**:

```typescript
describe('Reward E2E – 落账后触发 → RM/Core → RewardView → DataPush', function () {
  it('应在 LE 落账后触发积分发放，并在 RewardView 中可查询', async function () {
    // 1. LendingEngine 调用 RewardManager.onLoanEvent
    await rewardManager.connect(leCaller)['onLoanEvent(address,uint256,uint256,bool)'](
      user.address, amount, duration, hfHighEnough
    );
    
    // 2. 验证积分发放
    const balance = await rewardPoints.balanceOf(user.address);
    expect(balance).to.equal(expected);
    
    // 3. 验证 RewardView 聚合数据
    const summary = await rewardView.getUserRewardSummary(user.address);
    expect(summary[0]).to.equal(expected); // totalEarned
  });

  // 旧入口 onLoanEvent(address,int256,int256) 已移除：统一使用标准入口（uint 版本）

  it('直接调用 RMCore.onLoanEvent 应被拒绝', async function () {
    // 验证直接调用被拒绝
    await expect(
      rewardManagerCore.onLoanEvent(user.address, 1n, 0n, true)
    ).to.be.revertedWithCustomError(rewardManagerCore, 'RewardManagerCore__UseRewardManagerEntry');
  });

  it('惩罚路径：applyPenalty 扣减积分并在 RewardView 体现', async function () {
    // 1. 先发放积分
    // 2. 应用惩罚
    // 3. 验证积分扣减
    // 4. 验证 RewardView 更新
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Reward/Reward.e2e.test.ts
```

### 2. 积分计算逻辑测试

**文件**: `RewardManagerCore.test.ts`

**测试目标**:
- 积分计算公式验证
- 用户等级倍数测试
- 动态奖励测试
- 参数管理测试
- 边界条件测试

**主要测试场景**:

```typescript
describe('RewardManagerCore – 积分计算逻辑测试', function () {
  describe('积分计算逻辑', function () {
    it('应该正确计算基础积分', async function () {
      // 公式：basePoints = (amount/100)*(duration/5) * (baseUsd/1e18)
      const amount = 50000n;
      const duration = 5n;
      const expected = 500n; // (50000/100)*(5/5) = 500
      
      const result = await rewardManagerCore.calculateBasePoints(amount, duration);
      expect(result).to.equal(expected);
    });

    it('应该正确应用用户等级倍数', async function () {
      // 用户等级 2 = 1.1x 倍数
      const basePoints = 500n;
      const levelMultiplier = 11000; // 1.1x in BPS
      const expected = 550n; // 500 * 1.1
      
      const result = await rewardManagerCore.applyLevelMultiplier(basePoints, levelMultiplier);
      expect(result).to.equal(expected);
    });

    it('应该正确应用动态奖励', async function () {
      // 当积分超过阈值时应用动态倍数
      const totalPoints = 1500n; // 超过 1000 阈值
      const dynamicMultiplier = 12000; // 1.2x in BPS
      const expected = 1800n; // 1500 * 1.2
      
      const result = await rewardManagerCore.applyDynamicReward(totalPoints, dynamicMultiplier);
      expect(result).to.equal(expected);
    });
  });
});
```

**运行命令**:
```bash
npx hardhat test test/Reward/RewardManagerCore.test.ts
```

### 3. 奖励管理器集成测试

**文件**: `RewardManagerIntegration.test.ts`

**测试目标**:
- RewardManager 与 RewardManagerCore 的集成
- 权限控制验证
- 缓存机制测试
- 安全场景测试
- 完整流程测试

**运行命令**:
```bash
npx hardhat test test/Reward/RewardManagerIntegration.test.ts
```

### 4. 奖励配置测试

**文件**: `RewardConfig.test.ts`

**测试目标**:
- 配置查询功能
- 配置更新功能
- 权限控制
- 模块化架构验证

**运行命令**:
```bash
npx hardhat test test/Reward/RewardConfig.test.ts
```

### 5. 奖励消费集成测试

**文件**: `RewardConsumption.integration.test.ts`

**测试目标**:
- RewardConsumption ↔ RewardCore ↔ RewardPoints 集成
- 积分消费流程
- 消费权限验证

**运行命令**:
```bash
npx hardhat test test/Reward/RewardConsumption.integration.test.ts
```

### 6. 撮合结算端到端测试

**文件**: `Settlement.e2e.test.ts`, `Settlement.Reward.e2e.test.ts`

**测试目标**:
- 撮合结算完整流程
- 结算与奖励的集成
- 双架构设计验证

**运行命令**:
```bash
npx hardhat test test/Reward/Settlement.e2e.test.ts
npx hardhat test test/Reward/Settlement.Reward.e2e.test.ts
```

### 7. 服务配置测试

**文件**: `ServiceConfigs.test.ts`, `PriorityServiceConfig.test.ts`, `AdvancedAnalyticsConfig.test.ts`

**测试目标**:
- 服务配置管理
- 权限控制
- 配置查询和更新
- 边界条件处理

**运行命令**:
```bash
npx hardhat test test/Reward/ServiceConfigs.test.ts
npx hardhat test test/Reward/PriorityServiceConfig.test.ts
npx hardhat test test/Reward/AdvancedAnalyticsConfig.test.ts
```

## 🚀 运行测试

### 运行所有 Reward 测试

```bash
# 运行所有 Reward 相关测试
npx hardhat test test/Reward/
```

### 运行特定测试文件

```bash
# 运行端到端测试
npx hardhat test test/Reward/Reward.e2e.test.ts

# 运行积分计算测试
npx hardhat test test/Reward/RewardManagerCore.test.ts

# 运行集成测试
npx hardhat test test/Reward/RewardManagerIntegration.test.ts
```

### 运行特定测试用例

```bash
# 运行特定 describe 块
npx hardhat test test/Reward/Reward.e2e.test.ts --grep "积分计算详细测试"

# 运行特定 it 测试
npx hardhat test test/Reward/Reward.e2e.test.ts --grep "应在 LE 落账后触发积分发放"
```

### 带 Gas 报告的测试

```bash
# 运行测试并生成 Gas 报告
REPORT_GAS=true npx hardhat test test/Reward/
```

## 📊 测试覆盖范围

### 功能覆盖

| 功能模块 | 测试文件 | 覆盖度 |
|---------|---------|--------|
| **端到端流程** | `Reward.e2e.test.ts` | ✅ 完整 |
| **积分计算** | `RewardManagerCore.test.ts` | ✅ 完整 |
| **积分发放** | `Reward.e2e.test.ts` | ✅ 完整 |
| **积分消费** | `RewardConsumption.integration.test.ts` | ✅ 完整 |
| **用户等级** | `Reward.e2e.test.ts` | ✅ 完整 |
| **惩罚机制** | `Reward.e2e.test.ts` | ✅ 完整 |
| **配置管理** | `RewardConfig.test.ts` | ✅ 完整 |
| **服务配置** | `ServiceConfigs.test.ts` | ✅ 完整 |
| **撮合集成** | `Settlement.e2e.test.ts` | ✅ 完整 |

### 测试场景覆盖

| 测试场景 | 测试文件 | 状态 |
|---------|---------|------|
| **LE 落账触发** | `Reward.e2e.test.ts` | ✅ |
| **积分计算** | `RewardManagerCore.test.ts` | ✅ |
| **等级倍数** | `Reward.e2e.test.ts` | ✅ |
| **动态奖励** | `Reward.e2e.test.ts` | ✅ |
| **等级升级** | `Reward.e2e.test.ts` | ✅ |
| **积分消费** | `Reward.e2e.test.ts` | ✅ |
| **惩罚扣减** | `Reward.e2e.test.ts` | ✅ |
| **权限控制** | 所有测试文件 | ✅ |
| **边界条件** | 所有测试文件 | ✅ |
| **集成测试** | `RewardManagerIntegration.test.ts` | ✅ |

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
- `MockLendingEngine` - 借贷引擎模拟
- `MockAccessControlManager` - 权限控制模拟

### 测试 Fixture

所有测试使用 `loadFixture` 来设置测试环境：

```typescript
async function deployFixture() {
  // 1. 部署基础合约
  const registry = await deployMockRegistry();
  const accessControlManager = await deployAccessControlManager();
  
  // 2. 部署 Reward 相关合约
  const rewardPoints = await deployRewardPoints();
  const rewardManagerCore = await deployRewardManagerCore();
  const rewardManager = await deployRewardManager();
  const rewardView = await deployRewardView();
  
  // 3. 注册模块到 Registry
  await registry.setModule(KEY_LE, mockLendingEngine.address);
  await registry.setModule(KEY_RM, rewardManager.address);
  await registry.setModule(KEY_REWARD_MANAGER_CORE, rewardManagerCore.address);
  await registry.setModule(KEY_REWARD_VIEW, rewardView.address);
  
  // 4. 设置权限
  await accessControlManager.grantRole(ACTION_SET_PARAMETER, deployer.address);
  await rewardPoints.grantRole(MINTER_ROLE, rewardManagerCore.address);
  
  // 5. 设置配置
  await rewardManager.setLevelMultiplier(1, 10000); // 1.0x
  await rewardManager.setLevelMultiplier(2, 11000); // 1.1x
  
  return { registry, rewardPoints, rewardManager, rewardManagerCore, rewardView, ... };
}
```

## 📝 编写新测试

### 测试文件结构

```typescript
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('Reward – 新功能测试', function () {
  const ZERO_ADDRESS = ethers.ZeroAddress;
  const ONE_ETH = ethers.parseUnits('1', 18);
  
  let rewardManager: RewardManager;
  let rewardPoints: RewardPoints;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  async function deployFixture() {
    const [ownerSigner, userSigner] = await ethers.getSigners();
    owner = ownerSigner;
    user = userSigner;

    // 部署合约
    const RewardManagerFactory = await ethers.getContractFactory('RewardManager');
    rewardManager = await RewardManagerFactory.deploy();
    await rewardManager.waitForDeployment();

    return { rewardManager, rewardPoints, owner, user };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    Object.assign(this, fixture);
  });

  describe('新功能测试', function () {
    it('应该正确执行新功能', async function () {
      const { rewardManager, user } = await loadFixture(deployFixture);
      
      // 执行操作
      const tx = await rewardManager.newFunction(user.address, params);
      await tx.wait();
      
      // 验证结果
      expect(await rewardPoints.balanceOf(user.address)).to.equal(expected);
    });
  });
});
```

### 测试最佳实践

1. **使用 loadFixture**: 避免测试之间的状态污染
2. **清晰的测试描述**: 使用中文描述测试目标
3. **完整的断言**: 验证所有相关状态变化
4. **事件验证**: 验证重要事件的触发
5. **积分计算验证**: 验证积分计算公式的正确性
6. **权限验证**: 测试所有权限边界

## 🐛 调试测试

### 常见问题

#### 1. 测试失败 - "UseRewardManagerEntry"

**原因**: 直接调用了 RewardManagerCore，应该通过 RewardManager

**解决方案**:
```typescript
// 错误：直接调用 RewardManagerCore
await rewardManagerCore.onLoanEvent(...);

// 正确：通过 RewardManager 调用
await rewardManager.connect(leCaller)['onLoanEvent(address,uint256,uint256,bool)'](...);
```

#### 2. 测试失败 - "MissingRole"

**原因**: 缺少必要的权限

**解决方案**:
```typescript
// 授予必要的权限
await accessControlManager.grantRole(ACTION_SET_PARAMETER, deployer.address);
await rewardPoints.grantRole(MINTER_ROLE, rewardManagerCore.address);
```

#### 3. 测试失败 - "积分计算不正确"

**原因**: 积分计算公式理解错误

**解决方案**:
```typescript
// 验证计算公式
// basePoints = (amount/100)*(duration/5) * (baseUsd/1e18)
// 加上 bonus = basePoints * 1.05
const expected = calculateExpectedPoints(amount, duration, level, dynamic);
expect(actual).to.equal(expected);
```

### 调试技巧

1. **使用 console.log**:
```typescript
console.log('User balance:', await rewardPoints.balanceOf(user.address));
console.log('Summary:', await rewardView.getUserRewardSummary(user.address));
```

2. **使用 hardhat console**:
```bash
npx hardhat console
```

3. **使用 --verbose 标志**:
```bash
npx hardhat test --verbose test/Reward/Reward.e2e.test.ts
```

## 📈 测试性能

### 测试执行时间

| 测试文件 | 执行时间 | 测试用例数 |
|---------|---------|-----------|
| `Reward.e2e.test.ts` | ~8-10s | 15+ |
| `RewardManagerCore.test.ts` | ~5-7s | 20+ |
| `RewardManagerIntegration.test.ts` | ~6-8s | 25+ |
| `Settlement.e2e.test.ts` | ~10-12s | 10+ |

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
- [智能合约标准](../SmartContractStandard.md) - 代码规范

## 🎯 总结

Reward 系统测试覆盖了以下关键方面：

1. ✅ **端到端流程** - 完整的奖励发放流程
2. ✅ **积分计算** - 精确的积分计算公式
3. ✅ **用户等级** - 等级管理和倍数应用
4. ✅ **动态奖励** - 动态倍数机制
5. ✅ **积分消费** - 消费流程和权限
6. ✅ **惩罚机制** - 惩罚扣减和记录
7. ✅ **权限控制** - 细粒度的权限验证
8. ✅ **边界条件** - 各种边界场景处理
9. ✅ **集成测试** - 与其他模块的集成
10. ✅ **配置管理** - 灵活的配置系统

所有测试都遵循最佳实践，使用 TypeScript 严格类型，确保代码质量和可维护性。

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

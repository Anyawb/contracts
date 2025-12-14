# Core 模块测试指南

## 🎯 概述

本文档提供了 RWA 借贷平台 Core 核心模块测试的完整指南。Core 模块包括价格预言机、费用路由、借贷 NFT 等核心基础设施，本文档基于 `test/core/` 文件夹中的实际测试文件，详细说明了如何运行、理解和扩展 Core 模块相关的测试。

## 📁 测试文件结构

Core 模块的测试文件位于 `test/core/` 目录下：

```
test/core/
├── CoinGeckoPriceUpdater.test.ts           # CoinGecko 价格更新器测试
├── FeeRouter.test.ts                       # 费用路由测试
├── LoanNFT.test.ts                         # 借贷 NFT 测试
└── PriceOracle.new.test.ts                 # 价格预言机测试（新版本）
```

## 🧪 测试分类

### 1. 价格预言机测试

**文件**: `PriceOracle.new.test.ts`, `PriceOracle.graceful-degradation.test.ts`

**测试目标**:
- 价格获取功能
- 价格更新机制
- 优雅降级功能
- 价格验证和合理性检查
- 多资产价格管理

**主要测试场景**:

```typescript
describe('PriceOracle – 价格预言机测试', function () {
  it('应该正确获取资产价格', async function () {
    const price = await priceOracle.getPrice(assetAddress);
    expect(price).to.be.gt(0);
  });

  it('应该正确更新资产价格', async function () {
    const newPrice = ethers.parseUnits('100', 18);
    await priceOracle.updatePrice(assetAddress, newPrice);
    const price = await priceOracle.getPrice(assetAddress);
    expect(price).to.equal(newPrice);
  });

  it('应该处理价格预言机失败时的降级', async function () {
    // 模拟价格预言机失败
    await mockPriceOracle.setShouldFail(true);
    
    // 应该使用降级策略
    const price = await priceOracle.getPriceWithFallback(assetAddress);
    expect(price.usedFallback).to.be.true;
  });
});
```

**运行命令**:
```bash
npx hardhat test test/core/PriceOracle.new.test.ts
npx hardhat test test/PriceOracle.graceful-degradation.test.ts
```

### 2. CoinGecko 价格更新器测试

**文件**: `CoinGeckoPriceUpdater.test.ts`

**测试目标**:
- CoinGecko API 集成
- 价格更新机制
- 错误处理和重试
- 批量价格更新

**运行命令**:
```bash
npx hardhat test test/core/CoinGeckoPriceUpdater.test.ts
```

### 3. 费用路由测试

**文件**: `FeeRouter.test.ts`, `test/fixed-tests/FeeRouterFixed.test.ts`

**测试目标**:
- 费用计算和分发
- 多接收者费用路由
- 费用比例配置
- 批量费用处理

**主要测试场景**:

```typescript
describe('FeeRouter – 费用路由测试', function () {
  it('应该正确计算和分发费用', async function () {
    const amount = ethers.parseUnits('100', 18);
    const fee = await feeRouter.calculateFee(amount);
    
    await feeRouter.distributeFee(amount);
    
    // 验证费用分发到各个接收者
    const receiver1Balance = await token.balanceOf(receiver1.address);
    expect(receiver1Balance).to.equal(expectedAmount1);
  });

  it('应该正确处理批量费用分发', async function () {
    const amounts = [amount1, amount2, amount3];
    await feeRouter.distributeFeesBatch(amounts);
    
    // 验证所有费用都正确分发
  });
});
```

**运行命令**:
```bash
npx hardhat test test/core/FeeRouter.test.ts
npx hardhat test test/fixed-tests/FeeRouterFixed.test.ts
```

### 4. 借贷 NFT 测试

**文件**: `LoanNFT.test.ts`

**测试目标**:
- NFT 铸造功能
- NFT 转移和销毁
- NFT 元数据管理
- 批量操作

**主要测试场景**:

```typescript
describe('LoanNFT – 借贷 NFT 测试', function () {
  it('应该正确铸造借贷 NFT', async function () {
    const tokenId = await loanNFT.mint(user.address, loanData);
    expect(await loanNFT.ownerOf(tokenId)).to.equal(user.address);
  });

  it('应该正确转移 NFT', async function () {
    const tokenId = await loanNFT.mint(user1.address, loanData);
    await loanNFT.connect(user1).transferFrom(user1.address, user2.address, tokenId);
    expect(await loanNFT.ownerOf(tokenId)).to.equal(user2.address);
  });

  it('应该正确销毁 NFT', async function () {
    const tokenId = await loanNFT.mint(user.address, loanData);
    await loanNFT.burn(tokenId);
    await expect(loanNFT.ownerOf(tokenId)).to.be.reverted;
  });
});
```

**运行命令**:
```bash
npx hardhat test test/core/LoanNFT.test.ts
```

## 🚀 运行测试

### 运行所有 Core 模块测试

```bash
# 运行所有 Core 模块测试
npx hardhat test test/core/
```

### 运行特定测试文件

```bash
# 运行价格预言机测试
npx hardhat test test/core/PriceOracle.new.test.ts

# 运行费用路由测试
npx hardhat test test/core/FeeRouter.test.ts

# 运行借贷 NFT 测试
npx hardhat test test/core/LoanNFT.test.ts
```

### 运行特定测试用例

```bash
# 运行特定 describe 块
npx hardhat test test/core/PriceOracle.new.test.ts --grep "价格获取测试"

# 运行特定 it 测试
npx hardhat test test/core/FeeRouter.test.ts --grep "应该正确计算和分发费用"
```

### 带 Gas 报告的测试

```bash
# 运行测试并生成 Gas 报告
REPORT_GAS=true npx hardhat test test/core/
```

## 📊 测试覆盖范围

### 功能覆盖

| 功能模块 | 测试文件 | 覆盖度 |
|---------|---------|--------|
| **价格预言机** | `PriceOracle.new.test.ts` | ✅ 完整 |
| **优雅降级** | `PriceOracle.graceful-degradation.test.ts` | ✅ 完整 |
| **价格更新器** | `CoinGeckoPriceUpdater.test.ts` | ✅ 完整 |
| **费用路由** | `FeeRouter.test.ts` | ✅ 完整 |
| **借贷 NFT** | `LoanNFT.test.ts` | ✅ 完整 |

### 测试场景覆盖

| 测试场景 | 测试文件 | 状态 |
|---------|---------|------|
| **价格获取** | `PriceOracle.new.test.ts` | ✅ |
| **价格更新** | `PriceOracle.new.test.ts` | ✅ |
| **优雅降级** | `PriceOracle.graceful-degradation.test.ts` | ✅ |
| **费用计算** | `FeeRouter.test.ts` | ✅ |
| **费用分发** | `FeeRouter.test.ts` | ✅ |
| **NFT 铸造** | `LoanNFT.test.ts` | ✅ |
| **NFT 转移** | `LoanNFT.test.ts` | ✅ |
| **NFT 销毁** | `LoanNFT.test.ts` | ✅ |
| **批量操作** | 所有测试文件 | ✅ |
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

- `MockPriceOracle` - 价格预言机模拟
- `MockERC20` - ERC20 代币模拟
- `MockRegistry` - Registry 模拟

### 测试 Fixture

所有测试使用 `loadFixture` 来设置测试环境：

```typescript
async function deployFixture() {
  // 1. 部署基础合约
  const registry = await deployMockRegistry();
  
  // 2. 部署 Core 模块
  const priceOracle = await deployPriceOracle();
  const feeRouter = await deployFeeRouter();
  const loanNFT = await deployLoanNFT();
  
  // 3. 注册模块到 Registry
  await registry.setModule(KEY_PRICE_ORACLE, priceOracle.address);
  await registry.setModule(KEY_FEE_ROUTER, feeRouter.address);
  
  // 4. 准备测试数据
  return { priceOracle, feeRouter, loanNFT, registry, ... };
}
```

## 📝 编写新测试

### 测试文件结构

```typescript
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('CoreModule – 新功能测试', function () {
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ONE_ETH = ethers.parseUnits('1', 18);
  
  let coreModule: CoreModule;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  async function deployFixture() {
    const [ownerSigner, userSigner] = await ethers.getSigners();
    owner = ownerSigner;
    user = userSigner;

    // 部署合约
    const CoreModuleFactory = await ethers.getContractFactory('CoreModule');
    coreModule = await CoreModuleFactory.deploy();
    await coreModule.waitForDeployment();

    return { coreModule, owner, user };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    Object.assign(this, fixture);
  });

  describe('新功能测试', function () {
    it('应该正确执行新功能', async function () {
      const { coreModule, owner } = await loadFixture(deployFixture);
      
      // 执行操作
      const tx = await coreModule.connect(owner).newFunction();
      await tx.wait();
      
      // 验证结果
      expect(await coreModule.someValue()).to.equal(expectedValue);
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

#### 1. 测试失败 - "PriceOracle not available"

**原因**: 价格预言机未注册或未初始化

**解决方案**:
```typescript
// 确保价格预言机已注册
await registry.setModule(KEY_PRICE_ORACLE, priceOracle.address);
await priceOracle.initialize(registry.address);
```

#### 2. 测试失败 - "Fee calculation error"

**原因**: 费用计算参数错误

**解决方案**:
```typescript
// 验证费用参数
const fee = await feeRouter.calculateFee(amount);
expect(fee).to.be.gte(0);
expect(fee).to.be.lte(amount);
```

### 调试技巧

1. **使用 console.log**:
```typescript
console.log('Price:', await priceOracle.getPrice(assetAddress));
console.log('Fee:', await feeRouter.calculateFee(amount));
```

2. **使用 hardhat console**:
```bash
npx hardhat console
```

3. **使用 --verbose 标志**:
```bash
npx hardhat test --verbose test/core/
```

## 📈 测试性能

### 测试执行时间

| 测试文件 | 执行时间 | 测试用例数 |
|---------|---------|-----------|
| `PriceOracle.new.test.ts` | ~5-7s | 15+ |
| `FeeRouter.test.ts` | ~4-6s | 12+ |
| `LoanNFT.test.ts` | ~3-5s | 10+ |
| `CoinGeckoPriceUpdater.test.ts` | ~6-8s | 8+ |

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

- [价格预言机使用指南](../Usage-Guide/PriceOracle-Guide.md) - 价格预言机使用说明
- [架构指南](../Architecture-Guide.md) - 系统架构说明
- [智能合约标准](../SmartContractStandard.md) - 代码规范

## 🎯 总结

Core 模块测试覆盖了以下关键方面：

1. ✅ **价格管理** - 价格获取、更新和验证
2. ✅ **优雅降级** - 外部依赖失败时的降级策略
3. ✅ **费用路由** - 费用计算和分发
4. ✅ **NFT 管理** - NFT 铸造、转移和销毁
5. ✅ **批量操作** - 高效的批量接口
6. ✅ **错误处理** - 完善的错误处理机制
7. ✅ **边界条件** - 各种边界场景处理
8. ✅ **集成测试** - 与其他模块的集成

所有测试都遵循最佳实践，使用 TypeScript 严格类型，确保代码质量和可维护性。

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

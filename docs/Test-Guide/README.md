# 测试指南总览

## 📋 概述

本文档提供了 RWA 借贷平台所有测试指南的索引和总览。测试指南按照模块和功能分类，帮助开发者快速找到相关的测试文档。

## 📚 测试指南列表

0. **[上线/合并验收标准（E2E / Smoke / CI）](./release-acceptance-standard.md)**
   - 发布/合并前必须通过的闸门清单
   - 本地 E2E（strict）+ prod-like smoke runner + real-chain CI

### 核心架构测试

1. **[VaultRouter 测试指南](./vaultview-testing-guide.md)**
   - VaultRouter 双架构智能协调器测试
   - 事件驱动和 View 层缓存测试
   - 用户操作处理和模块分发测试

2. **[Registry 测试指南](./registry-testing-guide.md)**
   - Registry 模块注册中心测试
   - 模块注册、升级和查询测试
   - 权限管理和延迟升级测试

### 业务模块测试

3. **[清算系统测试指南](./liquidation-testing-guide.md)**
   - 清算端到端测试
   - 清算风险管理测试
   - 清算抵押物和债务管理测试

4. **[Reward 测试指南](./reward-testing-guide.md)**
   - 奖励系统端到端测试
   - 积分计算和发放测试
   - 用户等级和消费测试

5. **[Vault 模块测试指南](./vault-modules-testing-guide.md)**
   - 业务逻辑测试
   - 抵押管理器测试
   - 保证金管理器测试

### 基础设施测试

6. **[Core 模块测试指南](./core-modules-testing-guide.md)**
   - 价格预言机测试
   - 费用路由测试
   - 借贷 NFT 测试

7. **[View 层测试指南](./view-layer-testing-guide.md)**
   - 用户视图测试
   - 系统视图测试
   - 批量查询测试

8. **[端到端测试指南](./end-to-end-testing-guide.md)**
   - 综合端到端测试
   - 用户完整路径测试
   - 批量操作和风险监控测试

9. **[LendingEngine 测试指南](./lending-engine-testing-guide.md)**
   - 借贷引擎核心功能测试
   - 权限控制和集成测试

10. **[StatisticsView 测试指南](./statistics-view-testing-guide.md)**
    - 活跃用户统计测试
    - 保证金聚合测试
    - 数据迁移测试

## 🗂️ 测试文件分类

### 按模块分类

```
test/
├── VaultRouter.test.ts                    # VaultRouter 核心测试
├── Registry*.test.ts                    # Registry 相关测试
├── Vault/
│   ├── liquidation/                     # 清算模块测试
│   ├── modules/                          # Vault 业务模块测试
│   └── view/                            # View 层测试
├── Reward/                              # Reward 模块测试
├── core/                                # Core 模块测试
└── ...                                  # 其他测试
```

### 按测试类型分类

- **单元测试**: 单个合约或函数的测试
- **集成测试**: 多个模块协作的测试
- **端到端测试 (E2E)**: 完整业务流程的测试
- **安全测试**: 安全漏洞和攻击场景测试
- **性能测试**: Gas 消耗和性能优化测试

## 🚀 快速开始

### 运行所有测试

```bash
# 运行所有测试
npx hardhat test

# 运行特定目录的测试
npx hardhat test test/Vault/
npx hardhat test test/Reward/
npx hardhat test test/core/
```

### 运行特定测试文件

```bash
# 运行单个测试文件
npx hardhat test test/VaultRouter.test.ts
npx hardhat test test/Registry.test.ts
```

### 运行特定测试用例

```bash
# 使用 --grep 过滤测试
npx hardhat test --grep "应该正确初始化"
npx hardhat test test/VaultRouter.test.ts --grep "权限控制测试"
```

### 生成测试覆盖率

```bash
# 生成覆盖率报告
npx hardhat coverage

# 查看覆盖率报告
open coverage/index.html
```

## 📊 测试统计

### 测试文件数量

- **总测试文件数**: 70+
- **核心架构测试**: 10+
- **业务模块测试**: 30+
- **基础设施测试**: 20+
- **端到端测试**: 5+

### 测试覆盖范围

- **语句覆盖率**: > 80%
- **分支覆盖率**: > 75%
- **函数覆盖率**: > 85%
- **行覆盖率**: > 80%

## 🔧 测试工具和框架

### 主要工具

- **Hardhat**: 开发和测试框架
- **Chai**: 断言库
- **Ethers.js**: 以太坊交互库
- **@nomicfoundation/hardhat-network-helpers**: 测试辅助工具

### 测试模式

- **并行测试**: Hardhat 默认并行运行测试
- **快照测试**: 使用 `loadFixture` 进行状态快照
- **Gas 报告**: 使用 `REPORT_GAS=true` 生成 Gas 报告

## 📝 编写新测试

### 测试文件命名规范

- 单元测试: `{ContractName}.test.ts`
- 集成测试: `{ModuleName}.integration.test.ts`
- 端到端测试: `{FeatureName}.e2e.test.ts`
- 安全测试: `{ContractName}.security.test.ts`

### 测试结构模板

```typescript
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('ContractName – 功能描述', function () {
  // 测试常量
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  
  // 测试变量
  let contract: Contract;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  // 部署 Fixture
  async function deployFixture() {
    const [ownerSigner, userSigner] = await ethers.getSigners();
    // ... 部署合约
    return { contract, owner, user };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    Object.assign(this, fixture);
  });

  describe('功能测试', function () {
    it('应该正确执行功能', async function () {
      // 测试代码
    });
  });
});
```

## 🐛 常见问题

### 测试失败

1. **模块未注册**: 确保在 Fixture 中注册所有必需的模块
2. **权限不足**: 确保授予必要的权限
3. **零地址错误**: 使用有效的地址
4. **Gas 不足**: 增加 Gas limit 或优化测试

### 调试技巧

1. 使用 `console.log` 输出调试信息
2. 使用 `--verbose` 标志查看详细输出
3. 使用 `--grep` 过滤特定测试
4. 使用 Hardhat console 进行交互式调试

## 📚 相关文档

- [测试文件标准](../test-file-standards.md) - 测试文件编写规范
- [架构指南](../Architecture-Guide.md) - 系统架构说明
- [平台逻辑文档](../PlatformLogic.md) - 平台整体逻辑
- [智能合约标准](../SmartContractStandard.md) - 代码规范

## 🎯 测试最佳实践

1. **使用 loadFixture**: 避免测试之间的状态污染
2. **清晰的测试描述**: 使用中文描述测试目标
3. **完整的断言**: 验证所有相关状态变化
4. **事件验证**: 验证重要事件的触发
5. **错误处理**: 测试错误场景和边界条件
6. **Gas 优化**: 在测试中考虑 Gas 消耗
7. **并行测试**: 利用 Hardhat 的并行测试能力
8. **覆盖率目标**: 保持高测试覆盖率

## 📈 持续改进

### 测试质量指标

- **覆盖率**: 持续提高测试覆盖率
- **执行时间**: 优化测试执行时间
- **稳定性**: 减少测试失败率
- **可维护性**: 提高测试代码的可维护性

### 定期审查

- 定期审查测试覆盖率
- 更新过时的测试
- 添加新功能的测试
- 优化慢速测试

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

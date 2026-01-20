# StatisticsView 测试指南

## 🎯 概述

本文档提供了 RWA 借贷平台 StatisticsView 统计视图测试的完整指南。StatisticsView 负责系统级统计数据的聚合和查询，包括活跃用户、全局抵押/债务、保证金聚合等，本文档基于 `test/StatisticsView.*.test.ts` 文件，详细说明了如何运行、理解和扩展 StatisticsView 相关的测试。

## 📁 测试文件结构

StatisticsView 的测试文件包括：

```
test/
├── StatisticsView.active-users.test.ts          # 活跃用户统计测试
├── StatisticsView.guarantee-aggregation.test.ts  # 保证金聚合测试
├── StatisticsView.migration.test.ts              # 迁移测试
└── VaultStatistics.test.ts                       # Vault 统计测试
```

## 🧪 测试分类

### 1. 活跃用户统计测试

**文件**: `StatisticsView.active-users.test.ts`

**测试目标**:
- 活跃用户计数规则
- 活跃用户查询功能
- 活跃用户状态更新
- 批量活跃用户查询

**主要测试场景**:

```typescript
describe('StatisticsView – 活跃用户统计测试', function () {
  it('应该正确计算活跃用户数', async function () {
    // 活跃用户定义：collateral > 0 或 debt > 0
    await vaultCore.deposit(asset, amount);
    const activeUsers = await statisticsView.getActiveUserCount();
    expect(activeUsers).to.equal(1);
  });

  it('应该正确更新活跃用户状态', async function () {
    // 用户从非活跃变为活跃
    await vaultCore.deposit(asset, amount);
    const isActive = await statisticsView.isUserActive(user);
    expect(isActive).to.be.true;
    
    // 用户从活跃变为非活跃
    await vaultCore.withdraw(asset, amount);
    await vaultCore.repay(orderId, asset, debt);
    const isActiveAfter = await statisticsView.isUserActive(user);
    expect(isActiveAfter).to.be.false;
  });
});
```

**运行命令**:
```bash
npx hardhat test test/StatisticsView.active-users.test.ts
```

### 2. 保证金聚合测试

**文件**: `StatisticsView.guarantee-aggregation.test.ts`

**测试目标**:
- 保证金聚合计算
- 全局保证金统计
- 保证金分布查询

**运行命令**:
```bash
npx hardhat test test/StatisticsView.guarantee-aggregation.test.ts
```

### 3. 迁移测试

**文件**: `StatisticsView.migration.test.ts`

**测试目标**:
- 从旧统计系统迁移
- 数据兼容性验证
- 迁移后功能验证

**运行命令**:
```bash
npx hardhat test test/StatisticsView.migration.test.ts
```

### 4. Vault 统计测试

**文件**: `VaultStatistics.test.ts`

**测试目标**:
- Vault 统计功能
- 统计视图集成
- 统计数据更新

**运行命令**:
```bash
npx hardhat test test/VaultStatistics.test.ts
```

## 🚀 运行测试

### 运行所有 StatisticsView 测试

```bash
# 运行所有 StatisticsView 测试
npx hardhat test test/StatisticsView*.test.ts
npx hardhat test test/VaultStatistics.test.ts
```

### 运行特定测试文件

```bash
# 运行活跃用户统计测试
npx hardhat test test/StatisticsView.active-users.test.ts

# 运行保证金聚合测试
npx hardhat test test/StatisticsView.guarantee-aggregation.test.ts

# 运行迁移测试
npx hardhat test test/StatisticsView.migration.test.ts
```

## 📊 测试覆盖范围

### 功能覆盖

| 功能模块 | 测试文件 | 覆盖度 |
|---------|---------|--------|
| **活跃用户统计** | `StatisticsView.active-users.test.ts` | ✅ 完整 |
| **保证金聚合** | `StatisticsView.guarantee-aggregation.test.ts` | ✅ 完整 |
| **数据迁移** | `StatisticsView.migration.test.ts` | ✅ 完整 |
| **Vault 统计** | `VaultStatistics.test.ts` | ✅ 完整 |

## 📚 相关文档

- [架构指南](../Architecture-Guide.md) - 双架构设计说明
- [View 层测试指南](./view-layer-testing-guide.md) - View 层测试说明
- [智能合约标准](../SmartContractStandard.md) - 代码规范

## 🎯 总结

StatisticsView 测试覆盖了以下关键方面：

1. ✅ **活跃用户统计** - 准确的活跃用户计数
2. ✅ **保证金聚合** - 全局保证金统计
3. ✅ **数据迁移** - 平滑的数据迁移
4. ✅ **统计查询** - 高效的统计查询接口

所有测试都遵循最佳实践，使用 TypeScript 严格类型，确保代码质量和可维护性。

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

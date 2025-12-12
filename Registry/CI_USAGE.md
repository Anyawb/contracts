# Registry 系统 CI 使用说明

## 概述

本文档说明如何在 CI/CD 环境中正确使用和测试 Registry 系统。

## 环境要求

### 基础环境
- Node.js >= 18.0.0
- npm >= 8.0.0
- Hardhat >= 2.19.0
- Solidity >= 0.8.20

### 依赖安装
```bash
npm install
```

## 编译检查

### 1. 合约编译
```bash
npx hardhat compile
```

**检查要点：**
- 确保所有合约编译成功
- 检查是否有未使用的导入警告
- 验证事件定义与调用匹配

### 2. 类型检查
```bash
npx hardhat typechain
```

**检查要点：**
- 确保 TypeScript 类型定义生成成功
- 验证接口与实现的一致性

## 测试执行

### 1. 单元测试
```bash
# 运行所有测试
npm test

# 运行特定测试文件
npm test -- test/RegistryCore.test.ts

# 运行测试并生成覆盖率报告
npm run test:coverage
```

### 2. Gas 测试
```bash
# 运行 Gas 测试
npm run test:gas

# 检查批量操作的 Gas 消耗
npm run test:gas -- --grep "batch"
```

### 3. 安全测试
```bash
# 运行安全测试
npm run test:security

# 运行模糊测试
npm run test:fuzz
```

## 关键测试场景

### 1. 初始化测试
```bash
# 测试初始化功能
npm test -- --grep "initialize"
```

**验证内容：**
- `initialize` 成功设置 admin 和 minDelay
- 重复 `initialize` 调用 revert
- 触发 `RegistryInitialized` 事件

### 2. 权限测试
```bash
# 测试权限控制
npm test -- --grep "permission"
```

**验证内容：**
- 非 admin 调用写函数 revert
- admin 权限正确验证
- 权限升级流程正常

### 3. 批量操作测试
```bash
# 测试批量操作
npm test -- --grep "batch"
```

**验证内容：**
- 最大批量大小限制（20个模块）
- Gas 消耗在合理范围内
- 事件触发正确

### 4. 暂停功能测试
```bash
# 测试暂停功能
npm test -- --grep "pause"
```

**验证内容：**
- `pause()` 后写操作被阻止
- `acceptAdmin()` 在暂停状态下仍可执行
- `unpause()` 恢复正常功能

## 性能基准

### Gas 消耗基准
| 操作 | 预期 Gas 消耗 | 最大 Gas 消耗 |
|------|---------------|---------------|
| setModule | < 50,000 | 60,000 |
| setModules (5个模块) | < 150,000 | 200,000 |
| setModules (20个模块) | < 500,000 | 600,000 |
| pause/unpause | < 30,000 | 40,000 |

### 批量操作限制
- 最大批量大小：20个模块
- 最大数组长度：20个元素
- 单次交易 Gas 限制：30,000,000

## 错误处理

### 常见编译错误
1. **事件参数不匹配**
   - 检查 `RegistryEvents.sol` 中的事件定义
   - 确保调用参数数量正确

2. **类型转换错误**
   - 检查 `uint8` 与 `bool` 的转换
   - 验证 `address` 类型使用

3. **未使用变量警告**
   - 移除未使用的导入
   - 清理未使用的局部变量

### 测试失败处理
1. **权限测试失败**
   - 检查 `requireAdmin()` 实现
   - 验证 `RegistryStorage.isAdmin()` 函数

2. **事件测试失败**
   - 检查事件参数匹配
   - 验证事件触发时机

3. **Gas 测试失败**
   - 检查批量操作限制
   - 优化循环和数组操作

## 部署检查

### 1. 合约验证
```bash
# 验证合约字节码
npx hardhat verify --network mainnet <CONTRACT_ADDRESS>
```

### 2. 初始化检查
```bash
# 检查初始化状态
npx hardhat run scripts/check-initialization.ts --network mainnet
```

## 监控指标

### 关键指标
- 合约调用成功率
- Gas 消耗趋势
- 事件触发频率
- 权限验证失败次数

### 告警设置
- Gas 消耗超过阈值
- 权限验证失败
- 批量操作失败
- 事件触发异常

## 故障排除

### 1. 编译失败
```bash
# 清理缓存
npx hardhat clean

# 重新编译
npx hardhat compile
```

### 2. 测试失败
```bash
# 检查测试环境
npx hardhat test --verbose

# 运行单个测试
npx hardhat test test/RegistryCore.test.ts
```

### 3. Gas 测试失败
```bash
# 检查 Gas 配置
npx hardhat test --gas-report

# 优化 Gas 消耗
npm run optimize:gas
```

## 最佳实践

### 1. 代码质量
- 使用 ESLint 检查代码风格
- 运行 Prettier 格式化代码
- 检查 TypeScript 类型错误

### 2. 测试覆盖
- 单元测试覆盖率 > 90%
- 集成测试覆盖关键流程
- 安全测试覆盖所有边界情况

### 3. 文档维护
- 更新接口文档
- 维护测试文档
- 记录已知问题

## 联系信息

如有问题，请联系：
- 开发团队：dev@example.com
- 安全团队：security@example.com
- 运维团队：ops@example.com 
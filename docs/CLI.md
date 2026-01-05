# Contracts CLI 使用说明

## 🎯 概述

本 CLI 封装了 Hardhat 任务，便于在 `contracts` 包内执行常用链上操作。CLI 提供了 Registry 管理、模块同步、验证和迁移等功能。

## 📋 前置条件

### 环境变量配置

在项目根目录或 `contracts` 目录配置环境变量：

```bash
# .env 文件
RPC_URL=http://127.0.0.1:8545                    # 本地网络
ARBITRUM_SEPOLIA_RPC_URL=https://...             # Arbitrum Sepolia 测试网
PRIVATE_KEY=your_private_key                     # 部署者私钥
ARBISCAN_API_KEY=your_api_key                    # 区块浏览器 API 密钥（可选）
```

### 安装依赖

```bash
npm install
```

### 编译合约

```bash
npm run compile
```

## 🚀 使用方法

### 基本命令格式

```bash
# 在 contracts 目录下执行
npm run cli <command> [options]

# 或者直接使用 ts-node
npx ts-node scripts/cli.ts <command> [options]
```

### 查看帮助

```bash
# 查看所有可用命令
npm run cli -- --help

# 查看特定命令的帮助
npm run cli -- registry:check --help
```

## 📝 可用命令

### 1. registry:check - 检查 Registry 映射（只读）

检查 Registry 中已注册的模块映射，不修改任何状态。

**用法**:
```bash
npm run cli registry:check --networkName localhost
npm run cli registry:check --networkName arbitrum-sepolia
```

**选项**:
- `--networkName <name>`: 网络名称（localhost|arbitrum-sepolia），默认为 localhost

**示例**:
```bash
# 检查本地网络的 Registry 映射
npm run cli registry:check --networkName localhost

# 检查 Arbitrum Sepolia 测试网的 Registry 映射
npm run cli registry:check --networkName arbitrum-sepolia
```

**输出示例**:
```
VAULT_CORE       => 0x1234567890123456789012345678901234567890
VAULT_VIEW       => 0x2345678901234567890123456789012345678901
REWARD_VIEW      => 0x3456789012345678901234567890123456789012
LENDING_ENGINE   => 0x4567890123456789012345678901234567890123
```

---

### 2. registry:set - 设置单个模块映射

在 Registry 中设置或更新单个模块的地址映射。

**用法**:
```bash
npm run cli registry:set --module <MODULE_KEY> --address <ADDRESS> --networkName <NETWORK>
```

**选项**:
- `--module <UPPER_SNAKE>`: 模块键（必需），例如 `VAULT_VIEW`、`VAULT_CORE`
- `--address <0x...>`: 要设置的合约地址（必需）
- `--networkName <name>`: 网络名称（localhost|arbitrum-sepolia），默认为 localhost

**示例**:
```bash
# 在本地网络设置 VaultRouter 模块地址
npm run cli registry:set --module VAULT_VIEW --address 0x1234567890123456789012345678901234567890 --networkName localhost

# 在 Arbitrum Sepolia 设置 VaultCore 模块地址
npm run cli registry:set --module VAULT_CORE --address 0x2345678901234567890123456789012345678901 --networkName arbitrum-sepolia
```

**注意事项**:
- 需要部署者私钥（PRIVATE_KEY 环境变量）
- 需要相应的权限（ACTION_SET_PARAMETER 或管理员权限）
- 模块键必须使用大写蛇形命名（UPPER_SNAKE_CASE）

---

### 3. registry:sync - 批量同步部署文件到 Registry

从部署文件中批量同步模块映射到 Registry。

**用法**:
```bash
npm run cli registry:sync --networkName <NETWORK> [--only <KEYS>]
```

**选项**:
- `--networkName <name>`: 网络名称（localhost|arbitrum-sepolia），默认为 localhost
- `--only <CSV>`: 仅同步指定的模块键（可选），多个键用逗号分隔

**示例**:
```bash
# 同步所有模块到本地网络 Registry
npm run cli registry:sync --networkName localhost

# 仅同步指定的模块
npm run cli registry:sync --networkName localhost --only VAULT_CORE,VAULT_VIEW

# 同步到 Arbitrum Sepolia 测试网
npm run cli registry:sync --networkName arbitrum-sepolia
```

**工作原理**:
1. 读取对应网络的部署文件（`deployments/localhost.json` 或 `deployments/addresses.arbitrum-sepolia.json`）
2. 提取模块地址映射
3. 批量调用 Registry 的 `setModule` 方法
4. 验证设置结果

**注意事项**:
- 需要部署者私钥
- 需要相应的权限
- 会覆盖现有的模块映射

---

### 4. registry:verify:family - 验证 Registry 家族合约

验证 Registry 家族合约的存储布局和视图功能。

**用法**:
```bash
npm run cli registry:verify:family --deployFile <PATH>
```

**选项**:
- `--deployFile <path>`: 部署文件路径，默认为 `scripts/deployments/localhost.json`

**示例**:
```bash
# 验证本地部署的 Registry 家族合约
npm run cli registry:verify:family --deployFile scripts/deployments/localhost.json

# 验证 Arbitrum Sepolia 部署的合约
npm run cli registry:verify:family --deployFile deployments/addresses.arbitrum-sepolia.json
```

**验证内容**:
- Registry 合约的存储布局
- Registry 升级管理器的兼容性
- Registry 管理员的权限设置
- 模块注册和获取功能
- 升级流程的正确性

---

### 5. registry:migrate:min - 极简迁移（UUPS/存储版本）

执行 Registry 家族合约的最小化迁移，支持 UUPS 升级和存储版本更新。

**用法**:
```bash
npm run cli registry:migrate:min --registry <ADDRESS> [--newImpl <ADDRESS>] [--newStorageVersion <NUM>]
```

**选项**:
- `--registry <address>`: Registry 代理合约地址（必需）
- `--newImpl <address>`: 新实现合约地址（可选）
- `--newStorageVersion <num>`: 新存储版本号（可选）

**示例**:
```bash
# 仅更新存储版本
npm run cli registry:migrate:min --registry 0x1234567890123456789012345678901234567890 --newStorageVersion 2

# 升级实现并更新存储版本
npm run cli registry:migrate:min --registry 0x1234567890123456789012345678901234567890 --newImpl 0x2345678901234567890123456789012345678901 --newStorageVersion 2
```

**注意事项**:
- 需要治理权限（Timelock 或多签）
- 需要等待升级延迟时间（MIN_DELAY）
- 建议在测试网先验证迁移流程

---

## 🔧 高级用法

### 组合使用

```bash
# 1. 检查当前 Registry 状态
npm run cli registry:check --networkName localhost

# 2. 同步部署文件中的模块映射
npm run cli registry:sync --networkName localhost

# 3. 再次检查确认同步结果
npm run cli registry:check --networkName localhost

# 4. 验证 Registry 家族合约
npm run cli registry:verify:family --deployFile scripts/deployments/localhost.json
```

### 脚本化使用

创建脚本文件 `scripts/sync-registry.sh`:

```bash
#!/bin/bash
set -e

NETWORK=${1:-localhost}

echo "检查 Registry 状态..."
npm run cli registry:check --networkName $NETWORK

echo "同步模块映射..."
npm run cli registry:sync --networkName $NETWORK

echo "验证 Registry 家族合约..."
npm run cli registry:verify:family --deployFile scripts/deployments/$NETWORK.json

echo "完成！"
```

使用:
```bash
chmod +x scripts/sync-registry.sh
./scripts/sync-registry.sh localhost
```

---

## 📚 相关文档

- [Registry 系统文档](./registry-deployment.md) - Registry 系统详细说明
- [部署脚本 README](../scripts/deploy/README.md) - 部署脚本使用指南
- [任务脚本 README](../scripts/tasks/README.md) - Hardhat 任务说明

---

## 🐛 故障排除

### 常见问题

#### 1. "RPC_URL not set" 错误

**原因**: 未设置 RPC URL 环境变量

**解决方案**:
```bash
# 设置环境变量
export RPC_URL=http://127.0.0.1:8545

# 或使用 .env 文件
echo "RPC_URL=http://127.0.0.1:8545" >> .env
```

#### 2. "Registry address not found" 错误

**原因**: 部署文件中找不到 Registry 地址

**解决方案**:
- 检查部署文件路径是否正确
- 确认部署文件中包含 `Registry`、`registry` 或 `REGISTRY` 字段
- 确保已执行部署脚本

#### 3. "Insufficient permission" 错误

**原因**: 账户没有相应的权限

**解决方案**:
- 确认 PRIVATE_KEY 环境变量设置正确
- 检查账户是否具有 `ACTION_SET_PARAMETER` 或管理员权限
- 使用正确的部署者账户

#### 4. 命令未找到

**原因**: CLI 脚本路径或依赖问题

**解决方案**:
```bash
# 重新安装依赖
npm install

# 检查 CLI 脚本是否存在
ls -la scripts/cli.ts

# 直接使用 ts-node
npx ts-node scripts/cli.ts --help
```

---

## 🔄 扩展 CLI

### 添加新命令

在 `scripts/cli.ts` 中添加新命令：

```typescript
// 添加新命令
program
  .command('your:command')
  .description('Your command description')
  .option('--option <value>', 'Option description', 'default')
  .action((opts: { option: string }) => {
    hh(['your:hardhat:task', '--option', opts.option]);
  });
```

### 添加 Hardhat 任务

在 `scripts/tasks/` 目录下创建新的任务文件，然后在 `hardhat.config.ts` 中注册：

```typescript
// scripts/tasks/your-task.ts
import { task } from 'hardhat/config';

task('your:hardhat:task', 'Task description')
  .addParam('option', 'Option description')
  .setAction(async (args) => {
    // 任务逻辑
  });
```

---

## 📊 命令对比

| 功能 | CLI 命令 | Hardhat 任务 | 说明 |
|------|---------|-------------|------|
| 检查映射 | `registry:check` | `registry:check` | CLI 封装 Hardhat 任务 |
| 设置映射 | `registry:set` | `registry:set` | CLI 封装 Hardhat 任务 |
| 批量同步 | `registry:sync` | `registry:sync` | CLI 封装 Hardhat 任务 |
| 验证合约 | `registry:verify:family` | `registry:verify` | CLI 封装 Hardhat 任务 |
| 迁移合约 | `registry:migrate:min` | `registry:migrate` | CLI 封装 Hardhat 任务 |

**建议**: 优先使用 CLI 命令，因为它提供了更好的参数验证和错误处理。

---

## 🎯 最佳实践

1. **开发环境**: 使用 `localhost` 网络进行测试
2. **测试网**: 使用 `arbitrum-sepolia` 进行集成测试
3. **主网**: 谨慎操作，建议使用多签或 Timelock
4. **备份**: 在执行修改操作前，先使用 `registry:check` 备份当前状态
5. **验证**: 修改后使用 `registry:verify:family` 验证合约状态

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

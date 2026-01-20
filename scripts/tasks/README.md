# Hardhat 任务脚本 (Hardhat Task Scripts)

本目录包含用于管理和操作 Registry 系统以及通用工具的自定义 Hardhat 任务。这些任务提供了便捷的命令行接口来执行常见的开发和维护操作。

## 📁 文件结构

```
scripts/tasks/
├── registry-check.ts      # Registry 模块映射检查任务
├── registry-migrate.ts     # Registry 家族迁移任务
├── registry-set.ts        # 设置单个模块映射任务
├── registry-sync.ts       # 批量同步模块映射任务
├── registry-verify.ts     # Registry 家族验证任务
├── utils-tasks.ts         # 通用工具任务
└── README.md              # 本文档
```

## 🎯 任务概览

所有任务都在 `hardhat.config.ts` 中自动注册，可以通过 `npx hardhat <task-name>` 命令直接使用。

---

## 📋 Registry 管理任务

### 1. registry:check - 检查模块映射

**用途**：只读检查 Registry 中的关键模块映射

**功能**：
- 读取 Registry 中已注册的模块地址
- 不修改任何状态（只读操作）
- 支持多个网络

**使用方式**：
```bash
# 检查本地网络
npx hardhat registry:check --network localhost

# 检查 Arbitrum Sepolia 测试网
npx hardhat registry:check --network arbitrum-sepolia
```

**参数**：
- `--networkName` (可选): 网络名称，默认为 `localhost`
  - 可选值: `localhost` | `arbitrum-sepolia`

**检查的模块键**：
- `VAULT_CORE`
- `VAULT_VIEW`
- `REWARD_VIEW`
- `LENDING_ENGINE`

**输出示例**：
```
VAULT_CORE       => 0x1234...5678
VAULT_VIEW       => 0xabcd...ef01
REWARD_VIEW      => 0x9876...5432
LENDING_ENGINE   => 0xfedc...ba98
```

**环境变量**：
- `RPC_URL`: RPC 端点 URL（可选，会根据网络自动选择）

---

### 2. registry:set - 设置单个模块映射

**用途**：设置或更新 Registry 中的单个模块映射

**功能**：
- 设置单个模块的地址映射
- 自动检查是否已设置（避免重复设置）
- 支持所有网络

**使用方式**：
```bash
# 设置 VAULT_VIEW 模块
npx hardhat registry:set \
  --module VAULT_VIEW \
  --address 0x1234567890123456789012345678901234567890 \
  --network localhost
```

**参数**：
- `--module` (必需): 模块键名称（UPPER_SNAKE 格式），例如 `VAULT_VIEW`
- `--address` (必需): 目标合约地址（0x...）
- `--networkName` (可选): 网络名称，默认为 `localhost`

**示例**：
```bash
# 在本地网络设置 VaultCore
npx hardhat registry:set \
  --module VAULT_CORE \
  --address 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
  --networkName localhost

# 在测试网设置 RewardView
npx hardhat registry:set \
  --module REWARD_VIEW \
  --address 0x07882Ae1ecB7429a84f1D53048d35c4bB2056877 \
  --networkName arbitrum-sepolia
```

**环境变量**：
- `RPC_URL`: RPC 端点 URL
- `PRIVATE_KEY`: 部署者私钥（必需，用于签名交易）

**注意事项**：
- 需要 `ACTION_SET_PARAMETER` 权限才能设置模块
- 如果地址已设置且相同，任务会跳过并显示 `[ok]` 消息

---

### 3. registry:sync - 批量同步模块映射

**用途**：批量同步部署文件中的模块映射到 Registry

**功能**：
- 从部署文件读取合约地址
- 批量更新 Registry 中的模块映射
- 支持选择性同步（只同步指定的模块）
- 自动跳过已正确设置的模块

**使用方式**：
```bash
# 同步所有预定义的模块
npx hardhat registry:sync --network localhost

# 只同步指定的模块
npx hardhat registry:sync \
  --network localhost \
  --only VAULT_CORE,VAULT_VIEW
```

**参数**：
- `--networkName` (可选): 网络名称，默认为 `localhost`
- `--only` (可选): 逗号分隔的模块键列表，例如 `VAULT_CORE,VAULT_VIEW`

**支持的模块键**：
- `VAULT_CORE` → 从部署文件读取 `VaultCore`
- `VAULT_VIEW` → 从部署文件读取 `VaultRouter`
- `REWARD_VIEW` → 从部署文件读取 `RewardView`
- `LENDING_ENGINE` → 从部署文件读取 `LendingEngine`

**示例**：
```bash
# 同步所有模块到本地网络
npx hardhat registry:sync --networkName localhost

# 只同步 VaultCore 和 VaultRouter
npx hardhat registry:sync \
  --networkName localhost \
  --only VAULT_CORE,VAULT_VIEW
```

**环境变量**：
- `RPC_URL`: RPC 端点 URL
- `PRIVATE_KEY`: 部署者私钥（必需）

**工作流程**：
1. 从部署文件读取合约地址
2. 检查 Registry 中当前映射
3. 如果地址不同，执行 `setModule` 交易
4. 等待交易确认
5. 显示更新结果

---

### 4. registry:migrate - Registry 家族迁移

**用途**：执行 Registry 家族的最小化治理驱动迁移

**功能**：
- 升级 Registry 实现合约（UUPS）
- 升级存储版本
- 验证存储布局
- 支持增量迁移

**使用方式**：
```bash
# 升级实现合约
npx hardhat registry:migrate:min \
  --registry 0x1234...5678 \
  --newImpl 0xabcd...ef01 \
  --network localhost

# 升级存储版本
npx hardhat registry:migrate:min \
  --registry 0x1234...5678 \
  --newStorageVersion 2 \
  --network localhost

# 同时执行两者
npx hardhat registry:migrate:min \
  --registry 0x1234...5678 \
  --newImpl 0xabcd...ef01 \
  --newStorageVersion 2 \
  --network localhost
```

**参数**：
- `--registry` (必需): Registry 代理合约地址
- `--newImpl` (可选): 新的实现合约地址（用于 UUPS 升级）
- `--newStorageVersion` (可选): 新的存储版本号（整数）

**迁移流程**：
1. 如果提供了 `--newImpl`，执行 UUPS 升级
2. 验证存储布局（静态验证）
3. 显示当前存储版本
4. 如果提供了 `--newStorageVersion`，升级存储版本
5. 再次验证存储布局
6. 显示最终存储版本

**示例**：
```bash
# 只升级实现（不改变存储版本）
npx hardhat registry:migrate:min \
  --registry 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
  --newImpl 0xNewImplementationAddress \
  --network localhost

# 只升级存储版本（不升级实现）
npx hardhat registry:migrate:min \
  --registry 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
  --newStorageVersion 2 \
  --network localhost
```

**注意事项**：
- 需要相应的治理权限
- 升级前建议先验证存储布局兼容性
- 主网升级需要经过 Timelock 延迟

---

### 5. registry:verify - Registry 家族验证

**用途**：验证 Registry 家族的存储布局和基本视图

**功能**：
- 验证 Registry（Scheme A：单一入口）存储布局
- （可选）检查 RegistryDynamicModuleKey 基本状态
- 显示存储版本信息

**使用方式**：
```bash
# 验证本地部署
npx hardhat registry:verify:family \
  --deployFile scripts/deployments/localhost.json \
  --network localhost

# 验证测试网部署
npx hardhat registry:verify:family \
  --deployFile scripts/deployments/arbitrum-sepolia.json \
  --network arbitrum-sepolia
```

**参数**：
- `--deployFile` (可选): 部署 JSON 文件路径，默认为 `scripts/deployments/localhost.json`

**验证内容**：

1. **Registry**
   - 存储布局验证
   - 存储版本查询

2. **RegistryDynamicModuleKey**（如果存在）
   - registrationAdmin / systemAdmin 查询

**输出示例**：
```
Verifier: 0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6
Registry.storageVersion: 1
RegistryDynamicModuleKey.registrationAdmin: 0x...
RegistryDynamicModuleKey.systemAdmin: 0x...
Registry (Scheme A) verification completed.
```

---

## 🛠️ 工具任务

### 6. utils:deploy:contract - 部署单个合约

**用途**：使用部署工具部署单个合约

**功能**：
- 快速部署单个合约
- 支持构造函数参数
- 使用统一的部署工具函数

**使用方式**：
```bash
# 部署无参合约
npx hardhat utils:deploy:contract \
  --name MockERC20 \
  --network localhost

# 部署带参合约
npx hardhat utils:deploy:contract \
  --name MockERC20 \
  --args '["Token Name","SYMBOL",18]' \
  --network localhost
```

**参数**：
- `--name` (必需): 合约名称
- `--args` (可选): 构造函数参数（JSON 数组格式），默认为 `[]`

**示例**：
```bash
# 部署 MockERC20
npx hardhat utils:deploy:contract \
  --name MockERC20 \
  --args '["USD Coin","USDC",6]' \
  --network localhost
```

---

### 7. utils:verify:contract - 验证合约

**用途**：在区块浏览器上验证合约源代码

**功能**：
- 通过验证工具验证合约
- 支持构造函数参数
- 自动检测网络并选择对应的验证服务

**使用方式**：
```bash
# 验证无参合约
npx hardhat utils:verify:contract \
  --address 0x1234567890123456789012345678901234567890 \
  --network arbitrum-sepolia

# 验证带参合约
npx hardhat utils:verify:contract \
  --address 0x1234567890123456789012345678901234567890 \
  --ctor '["arg1","arg2",123]' \
  --network arbitrum-sepolia
```

**参数**：
- `--address` (必需): 合约地址
- `--ctor` (可选): 构造函数参数（JSON 数组格式），默认为 `[]`

**示例**：
```bash
# 验证 Registry 合约
npx hardhat utils:verify:contract \
  --address 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
  --ctor '[60,"0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6","0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6"]' \
  --network arbitrum-sepolia
```

**环境变量**：
- `ARBISCAN_API_KEY`: Arbiscan API 密钥（用于验证）

---

### 8. utils:module-keys - 生成模块键常量

**用途**：从前端模块键定义生成 TypeScript 常量文件

**功能**：
- 从 Solidity 常量生成 TypeScript 文件
- 用于前端集成
- 保持前后端模块键一致性

**使用方式**：
```bash
npx hardhat utils:module-keys
```

**输出**：
- 生成前端可用的模块键 TypeScript 文件

---

## 🔧 使用场景

### 场景 1: 检查部署状态

部署完成后，检查关键模块是否正确注册：

```bash
npx hardhat registry:check --network localhost
```

### 场景 2: 修复缺失的模块映射

如果某个模块未正确注册，可以手动设置：

```bash
npx hardhat registry:set \
  --module VAULT_VIEW \
  --address 0x998abeb3E57409262aE5b751f60747921B33613E \
  --network localhost
```

### 场景 3: 批量同步模块映射

从部署文件批量同步所有模块映射：

```bash
npx hardhat registry:sync --network localhost
```

### 场景 4: 升级 Registry

升级 Registry 实现合约：

```bash
npx hardhat registry:migrate:min \
  --registry 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 \
  --newImpl 0xNewImplementationAddress \
  --network localhost
```

### 场景 5: 验证部署

验证 Registry 家族的存储布局：

```bash
npx hardhat registry:verify:family \
  --deployFile scripts/deployments/localhost.json \
  --network localhost
```

---

## 📝 环境变量配置

### 必需环境变量

```bash
# 用于需要签名的任务（registry:set, registry:sync）
PRIVATE_KEY=your_private_key_here
```

### 可选环境变量

```bash
# RPC 端点（如果不使用默认值）
RPC_URL=http://127.0.0.1:8545
ARBITRUM_SEPOLIA_URL=https://sepolia-rollup.arbitrum.io/rpc

# 用于合约验证
ARBISCAN_API_KEY=your_arbiscan_api_key
```

---

## 🔍 任务注册

所有任务都在 `hardhat.config.ts` 中自动注册：

```typescript
import './scripts/tasks/registry-migrate';
import './scripts/tasks/registry-verify';
import './scripts/tasks/registry-check';
import './scripts/tasks/registry-set';
import './scripts/tasks/registry-sync';
import './scripts/tasks/utils-tasks';
```

因此可以直接通过 `npx hardhat <task-name>` 使用，无需额外配置。

---

## 📊 任务对比表

| 任务 | 网络支持 | 需要签名 | 修改状态 | 用途 |
|------|---------|---------|---------|------|
| `registry:check` | ✅ 所有 | ❌ | ❌ 只读 | 检查模块映射 |
| `registry:set` | ✅ 所有 | ✅ | ✅ | 设置单个模块 |
| `registry:sync` | ✅ 所有 | ✅ | ✅ | 批量同步模块 |
| `registry:migrate` | ✅ 所有 | ✅ | ✅ | 升级 Registry |
| `registry:verify` | ✅ 所有 | ❌ | ❌ 只读 | 验证存储布局 |
| `utils:deploy:contract` | ✅ 所有 | ✅ | ✅ | 部署单个合约 |
| `utils:verify:contract` | ✅ 所有 | ❌ | ❌ 只读 | 验证合约源码 |
| `utils:module-keys` | ❌ 本地 | ❌ | ✅ 文件 | 生成 TS 常量 |

---

## ⚠️ 注意事项

### 权限要求

- **registry:set** 和 **registry:sync**: 需要 `ACTION_SET_PARAMETER` 权限
- **registry:migrate**: 需要相应的升级权限（通过 Timelock）
- **utils:deploy:contract**: 需要部署者账户

### 网络配置

- 确保 `hardhat.config.ts` 中配置了正确的网络
- 本地网络需要先启动 Hardhat 节点：`npm run node`
- 测试网和主网需要配置 RPC URL 和私钥

### 部署文件路径

任务会自动从以下路径读取部署文件：
- 本地网络: `scripts/deployments/localhost.json`
- Arbitrum Sepolia: `scripts/deployments/addresses.arbitrum-sepolia.json`

### 模块键格式

所有模块键必须使用 **UPPER_SNAKE_CASE** 格式，例如：
- ✅ `VAULT_CORE`
- ✅ `REWARD_VIEW`
- ❌ `VaultCore` (错误)
- ❌ `vault-core` (错误)

---

## 🔄 工作流程示例

### 完整部署后验证流程

```bash
# 1. 部署合约
npx hardhat run scripts/deploy/deploylocal.ts --network localhost

# 2. 检查模块映射
npx hardhat registry:check --network localhost

# 3. 如果有缺失，批量同步
npx hardhat registry:sync --network localhost

# 4. 验证 Registry 家族
npx hardhat registry:verify:family \
  --deployFile scripts/deployments/localhost.json \
  --network localhost
```

### 修复单个模块映射

```bash
# 1. 检查当前状态
npx hardhat registry:check --network localhost

# 2. 设置正确的地址
npx hardhat registry:set \
  --module VAULT_VIEW \
  --address 0xCorrectAddress \
  --network localhost

# 3. 再次检查确认
npx hardhat registry:check --network localhost
```

---

## 🐛 故障排除

### 问题 1: "Deployments file not found"

**原因**：部署文件不存在或路径不正确

**解决**：
- 确保已运行部署脚本
- 检查部署文件路径是否正确
- 确认网络名称匹配

### 问题 2: "RPC_URL not set"

**原因**：未设置 RPC URL

**解决**：
- 设置环境变量 `RPC_URL`
- 或在 `hardhat.config.ts` 中配置网络 URL

### 问题 3: "PRIVATE_KEY not set"

**原因**：需要签名的任务缺少私钥

**解决**：
- 设置环境变量 `PRIVATE_KEY`
- 或在 `hardhat.config.ts` 中配置账户

### 问题 4: "Registry address not found"

**原因**：部署文件中没有 Registry 地址

**解决**：
- 检查部署文件格式
- 确保 Registry 已部署
- 检查键名是否正确（`Registry`、`registry` 或 `REGISTRY`）

---

## 📚 相关文档

- [Registry 系统文档](../docs/registry-deployment.md)
- [Registry 升级流程](../docs/RegistryUpgradeFlow.md)
- [部署脚本文档](./deploy/README.md)
- [CLI 文档](../docs/CLI.md)

---

## 🔗 相关工具

- `scripts/utils/deploymentUtils.ts` - 部署工具函数
- `scripts/utils/verificationUtils.ts` - 验证工具函数
- `scripts/utils/generateModuleKeys.ts` - 模块键生成工具

---

## 📝 开发指南

### 创建新任务

1. **创建任务文件**

```typescript
import { task, types } from 'hardhat/config';

task('my:task', 'My custom task description')
  .addParam('param1', 'Parameter 1 description')
  .addOptionalParam('param2', 'Optional parameter', 'default', types.string)
  .setAction(async (args, hre) => {
    const { param1, param2 } = args;
    // 任务逻辑
  });
```

2. **在 hardhat.config.ts 中注册**

```typescript
import './scripts/tasks/my-task';
```

3. **使用任务**

```bash
npx hardhat my:task --param1 value1 --param2 value2
```

### 最佳实践

1. **错误处理**：始终包含适当的错误处理
2. **参数验证**：验证输入参数的有效性
3. **日志输出**：提供清晰的日志信息
4. **只读优先**：如果可能，优先使用只读操作
5. **网络支持**：考虑支持多个网络

---

## 📄 许可证

MIT License


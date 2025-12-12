# 部署地址记录与管理系统

## 📋 概述

本系统提供统一的部署地址记录与管理功能，支持多网络部署、增量部署、地址验证和前端配置生成。

## 🏗️ 系统架构

### 核心组件

1. **AddressManager 类** - 主要的地址管理工具类
2. **便捷函数** - 简化常用操作的函数
3. **JSON 文件存储** - 结构化的地址记录文件
4. **前端配置生成** - 自动生成 TypeScript 配置文件

### 文件结构

```
scripts/
├── utils/
│   └── saveAddress.ts              # 地址管理工具
├── deploy/
│   └── deployRewardSystem.ts       # 示例部署脚本
└── deployments/
    ├── addresses.localhost.json    # 本地网络地址
    ├── addresses.arbitrum-sepolia.json  # Arbitrum Sepolia 地址
    ├── addresses.arbitrum.json     # Arbitrum 主网地址
    └── backups/                    # 备份文件目录
        └── addresses.*.backup-*.json

frontend-config/
├── contracts-localhost.ts          # 本地网络前端配置
├── contracts-arbitrum-sepolia.ts   # Arbitrum Sepolia 前端配置
└── contracts-arbitrum.ts           # Arbitrum 主网前端配置
```

## 🚀 快速开始

### 1. 基本使用

```typescript
import { AddressManager, NetworkConfig } from '../utils/saveAddress';

// 创建地址管理器
const addressManager = new AddressManager('arbitrum-sepolia');

// 保存部署地址
const contracts = {
  Registry: '0x1234...',
  VaultCore: '0x5678...',
  // ... 更多合约
};

const networkConfig: NetworkConfig = {
  name: 'arbitrum-sepolia',
  chainId: 421614,
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  explorer: 'https://sepolia.arbiscan.io'
};

addressManager.saveAddresses(
  contracts,
  networkConfig,
  deployerAddress,
  '1.0.0',
  'RwaLendingPlatform 部署'
);
```

### 2. 便捷函数使用

```typescript
import { 
  saveAddresses, 
  getAddress, 
  updateAddress, 
  hasAddress 
} from '../utils/saveAddress';

// 保存地址
saveAddresses('arbitrum-sepolia', contracts, networkConfig, deployer);

// 获取地址
const vaultAddress = getAddress('arbitrum-sepolia', 'VaultCore');

// 更新地址
updateAddress('arbitrum-sepolia', 'VaultCore', newAddress);

// 检查地址是否存在
if (hasAddress('arbitrum-sepolia', 'VaultCore')) {
  // 执行操作
}
```

## 📊 数据结构

### NetworkConfig 接口

```typescript
interface NetworkConfig {
  name: string;        // 网络名称
  chainId: number;     // 链 ID
  rpcUrl: string;      // RPC URL
  explorer: string;    // 区块浏览器 URL
}
```

### DeploymentRecord 接口

```typescript
interface DeploymentRecord {
  network: NetworkConfig;                    // 网络配置
  deployedAt: string;                        // 部署时间
  deployer: string;                          // 部署者地址
  contracts: { [key: string]: string };      // 合约地址映射
  version?: string;                          // 版本号
  description?: string;                      // 描述信息
}
```

### 示例 JSON 文件

```json
{
  "network": {
    "name": "arbitrum-sepolia",
    "chainId": 421614,
    "rpcUrl": "https://sepolia-rollup.arbitrum.io/rpc",
    "explorer": "https://sepolia.arbiscan.io"
  },
  "deployedAt": "2024-12-19T10:30:00.000Z",
  "deployer": "0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6",
  "version": "1.0.0",
  "description": "RwaLendingPlatform 部署",
  "contracts": {
    "Registry": "0x1234567890123456789012345678901234567890",
    "VaultCore": "0x2345678901234567890123456789012345678901",
    "RewardManager": "0x3456789012345678901234567890123456789012"
  }
}
```

## 🔧 API 参考

### AddressManager 类

#### 构造函数

```typescript
constructor(network: string, deploymentsDir?: string)
```

- `network`: 网络名称 (如 'localhost', 'arbitrum-sepolia')
- `deploymentsDir`: 部署文件目录 (默认: 'scripts/deployments')

#### 主要方法

##### saveAddresses()

```typescript
saveAddresses(
  contracts: { [key: string]: string },
  networkConfig: NetworkConfig,
  deployer: string,
  version?: string,
  description?: string
): void
```

保存完整的部署记录，包括网络配置、合约地址、部署信息等。

##### updateAddress()

```typescript
updateAddress(contractName: string, address: string): void
```

更新单个合约地址。

##### updateAddresses()

```typescript
updateAddresses(contracts: { [key: string]: string }): void
```

批量更新合约地址。

##### getAddress()

```typescript
getAddress(contractName: string): string
```

获取指定合约的地址。

##### getAllAddresses()

```typescript
getAllAddresses(): { [key: string]: string }
```

获取所有合约地址。

##### hasAddress()

```typescript
hasAddress(contractName: string): boolean
```

检查指定合约地址是否存在。

##### generateFrontendConfig()

```typescript
generateFrontendConfig(outputPath?: string): void
```

生成前端 TypeScript 配置文件。

##### generateSummary()

```typescript
generateSummary(): void
```

生成部署摘要报告。

##### cleanBackups()

```typescript
cleanBackups(daysToKeep?: number): void
```

清理旧的备份文件。

#### 静态方法

##### isValidAddress()

```typescript
static isValidAddress(address: string): boolean
```

验证地址格式是否有效。

### 便捷函数

#### saveAddresses()

```typescript
saveAddresses(
  network: string,
  contracts: { [key: string]: string },
  networkConfig: NetworkConfig,
  deployer: string,
  version?: string,
  description?: string
): void
```

#### getAddress()

```typescript
getAddress(network: string, contractName: string): string
```

#### getAllAddresses()

```typescript
getAllAddresses(network: string): { [key: string]: string }
```

#### hasAddress()

```typescript
hasAddress(network: string, contractName: string): boolean
```

#### updateAddress()

```typescript
updateAddress(network: string, contractName: string, address: string): void
```

#### generateFrontendConfig()

```typescript
generateFrontendConfig(network: string, outputPath?: string): void
```

#### generateSummary()

```typescript
generateSummary(network: string): void
```

## 📝 使用示例

### 1. 完整部署流程

```typescript
import { AddressManager, NetworkConfig } from '../utils/saveAddress';

async function deploySystem() {
  const networkConfig: NetworkConfig = {
    name: 'arbitrum-sepolia',
    chainId: 421614,
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorer: 'https://sepolia.arbiscan.io'
  };

  const addressManager = new AddressManager(networkConfig.name);
  const [deployer] = await ethers.getSigners();

  // 部署合约
  const registry = await deployProxy('Registry', [2 * 24 * 60 * 60]); // 2 days delay
  addressManager.updateAddress('Registry', await registry.getAddress());

  const vaultCore = await deployProxy('VaultCore', [deployer.address]);
  addressManager.updateAddress('VaultCore', await vaultCore.getAddress());

  // 保存完整记录
  const allAddresses = addressManager.getAllAddresses();
  addressManager.saveAddresses(
    allAddresses,
    networkConfig,
    deployer.address,
    '1.0.0',
    'RwaLendingPlatform 完整部署'
  );

  // 生成前端配置
  addressManager.generateFrontendConfig();

  // 显示摘要
  addressManager.generateSummary();
}
```

### 2. 增量部署

```typescript
async function incrementalDeploy() {
  const addressManager = new AddressManager('arbitrum-sepolia');

  // 检查现有部署
  const existingRecord = addressManager.loadDeploymentRecord();
  if (existingRecord) {
    console.log('发现现有部署，进行增量更新');
  }

  // 部署新合约
  const newContract = await deployProxy('NewContract', []);
  addressManager.updateAddress('NewContract', await newContract.getAddress());

  // 更新部署记录
  const allAddresses = addressManager.getAllAddresses();
  addressManager.saveAddresses(
    allAddresses,
    existingRecord?.network || networkConfig,
    deployer.address,
    '1.1.0',
    '增量部署 - 新增 NewContract'
  );
}
```

### 3. 在 Registry 中使用

```typescript
async function registerModules() {
  const addressManager = new AddressManager('arbitrum-sepolia');
  const registryAddress = addressManager.getAddress('Registry');
  const registry = await ethers.getContractAt('Registry', registryAddress);

  // 注册模块
  const modules = [
    'VaultCore',
    'RewardManager',
    'FeeRouter'
  ];

  for (const moduleName of modules) {
    const address = addressManager.getAddress(moduleName);
    await registry.setModule(moduleName, address);
    console.log(`✅ ${moduleName} 已注册到 Registry`);
  }
}
```

### 4. 前端使用

```typescript
// 前端配置文件 (自动生成)
import { CONTRACT_ADDRESSES, NETWORK_CONFIG } from './contracts-arbitrum-sepolia';

// 使用合约地址
const vaultCoreAddress = CONTRACT_ADDRESSES.VaultCore;
const rewardManagerAddress = CONTRACT_ADDRESSES.RewardManager;

// 使用网络配置
const chainId = NETWORK_CONFIG.chainId;
const rpcUrl = NETWORK_CONFIG.rpcUrl;
```

## 🔒 安全特性

### 1. 自动备份

- 每次保存前自动备份现有文件
- 备份文件包含时间戳
- 支持自动清理旧备份

### 2. 地址验证

- 验证地址格式 (0x + 40位十六进制)
- 检查地址是否为零地址
- 验证网络配置完整性

### 3. 错误处理

- 文件不存在时的优雅处理
- JSON 解析错误处理
- 网络配置验证

## 🛠️ 最佳实践

### 1. 部署脚本结构

```typescript
// 1. 导入工具
import { AddressManager } from '../utils/saveAddress';

// 2. 定义网络配置
const NETWORK_CONFIG: NetworkConfig = {
  name: 'arbitrum-sepolia',
  chainId: 421614,
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  explorer: 'https://sepolia.arbiscan.io'
};

// 3. 创建地址管理器
const addressManager = new AddressManager(NETWORK_CONFIG.name);

// 4. 按批次部署
await deployBatch1(addressManager);
await deployBatch2(addressManager);
// ...

// 5. 保存和生成配置
addressManager.generateFrontendConfig();
addressManager.generateSummary();
```

### 2. 错误处理

```typescript
try {
  const address = addressManager.getAddress('VaultCore');
  // 使用地址
} catch (error) {
  if (error.message.includes('not found')) {
    console.log('合约未部署，跳过操作');
  } else {
    throw error;
  }
}
```

### 3. 增量部署

```typescript
// 检查现有部署
const existingRecord = addressManager.loadDeploymentRecord();
if (existingRecord) {
  console.log('进行增量部署');
  // 只部署新合约
} else {
  console.log('进行完整部署');
  // 部署所有合约
}
```

## 📊 监控和维护

### 1. 部署摘要

```typescript
// 生成部署摘要
addressManager.generateSummary();
```

输出示例：
```
📊 部署摘要 Deployment Summary
==================================================
🌐 网络 Network: arbitrum-sepolia
🔗 Chain ID: 421614
📅 部署时间 Deployed: 2024-12-19T10:30:00.000Z
👤 部署者 Deployer: 0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6
📦 合约数量 Contracts: 45
🏷️ 版本 Version: 1.0.0
📝 描述 Description: RwaLendingPlatform 部署

📋 合约地址列表 Contract Addresses:
--------------------------------------------------
Registry: 0x1234567890123456789012345678901234567890
VaultCore: 0x2345678901234567890123456789012345678901
...
==================================================
```

### 2. 备份管理

```typescript
// 清理7天前的备份
addressManager.cleanBackups(7);
```

### 3. 前端配置生成

```typescript
// 生成前端配置文件
addressManager.generateFrontendConfig();
```

生成的文件位置：`frontend-config/contracts-{network}.ts`

## 🔄 版本控制

### 1. 版本号管理

- 使用语义化版本号 (SemVer)
- 主版本号：重大更新
- 次版本号：功能更新
- 修订号：Bug修复

### 2. 向后兼容

- 保持 JSON 结构向后兼容
- 新增字段使用可选属性
- 提供迁移脚本

### 3. 升级策略

```typescript
// 检查版本兼容性
const record = addressManager.loadDeploymentRecord();
if (record && record.version) {
  const currentVersion = record.version;
  const targetVersion = '1.1.0';
  
  if (needsMigration(currentVersion, targetVersion)) {
    await migrateAddresses(addressManager, currentVersion, targetVersion);
  }
}
```

## 🎯 总结

这个地址管理系统提供了：

1. **统一管理** - 所有网络和合约地址的统一管理
2. **自动化** - 自动备份、验证、配置生成
3. **安全性** - 地址验证、错误处理、备份机制
4. **易用性** - 便捷函数、清晰的API、详细文档
5. **可扩展性** - 支持多网络、增量部署、版本控制

通过这个系统，你可以轻松管理复杂的多网络部署，确保地址记录的一致性和可靠性。 
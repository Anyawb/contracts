# 工具函数库 (Utility Functions Library)

本目录包含用于部署、验证、配置和管理的各种工具函数。这些工具函数被部署脚本、任务脚本和其他自动化工具广泛使用。

## 📁 文件结构

```
scripts/utils/
├── configure-assets.ts      # 资产配置工具
├── decodeRevert.ts          # Revert 错误解码工具
├── deploymentUtils.ts       # 部署工具函数
├── generateModuleKeys.ts    # 模块键生成器
├── logger.ts                # 日志工具
├── saveAddress.ts           # 地址管理工具
├── verificationUtils.ts      # 合约验证工具
└── README.md                # 本文档
```

## 🎯 工具概览

| 工具文件 | 主要功能 | 使用场景 |
|---------|---------|---------|
| `configure-assets.ts` | 资产配置管理 | 部署时配置 PriceOracle 资产 |
| `decodeRevert.ts` | Revert 错误解码 | 调试和错误处理 |
| `deploymentUtils.ts` | 部署工具函数 | 合约部署和部署信息管理 |
| `generateModuleKeys.ts` | 模块键生成 | 生成前端模块键常量 |
| `logger.ts` | 日志输出 | 统一的日志和进度显示 |
| `saveAddress.ts` | 地址管理 | 部署地址记录和管理 |
| `verificationUtils.ts` | 合约验证 | 区块浏览器合约验证 |

---

## 📦 工具详情

### 1. configure-assets.ts - 资产配置工具

**用途**：加载和配置资产到 PriceOracle 合约

**主要功能**：
- 从配置文件加载资产配置
- 支持多级配置优先级
- 批量配置资产到 PriceOracle

**导出函数**：

#### `loadAssetsConfig(networkName: string, chainId: number): AssetConfigItem[]`

加载资产配置，按以下优先级：
1. `process.env.ASSETS_FILE` (环境变量指定)
2. `scripts/config/assets.<network>.json`
3. `scripts/config/assets.<chainId>.json`
4. `scripts/config/assets.default.json`

**参数**：
- `networkName`: 网络名称（如 `arbitrum-sepolia`）
- `chainId`: 链 ID（如 `421614`）

**返回**：资产配置数组

**示例**：
```typescript
import { loadAssetsConfig } from './utils/configure-assets';

const assets = loadAssetsConfig('arbitrum-sepolia', 421614);
// 返回: [{ address: '0x...', coingeckoId: 'usd-coin', decimals: 6, ... }]
```

#### `configureAssets(ethers: any, priceOracleAddress: string, assets: AssetConfigItem[]): Promise<void>`

将资产配置应用到 PriceOracle 合约。

**参数**：
- `ethers`: ethers 实例
- `priceOracleAddress`: PriceOracle 合约地址
- `assets`: 资产配置数组

**示例**：
```typescript
import { loadAssetsConfig, configureAssets } from './utils/configure-assets';

const assets = loadAssetsConfig('arbitrum-sepolia', 421614);
await configureAssets(ethers, priceOracleAddress, assets);
```

**接口定义**：
```typescript
interface AssetConfigItem {
  address: string;        // 代币合约地址
  coingeckoId: string;    // CoinGecko 资产 ID
  decimals: number;        // 小数位数
  maxPriceAge: number;    // 最大价格年龄（秒）
  active?: boolean;       // 是否激活
}
```

---

### 2. decodeRevert.ts - Revert 错误解码工具

**用途**：解码以太坊合约的 revert 错误信息，提供人类可读的错误消息

**主要功能**：
- 支持标准 `Error(string)` 格式
- 支持 `Panic(uint256)` 格式
- 支持自定义错误（需要 ABI）

**导出函数**：

#### `decodeRevert(data: string | null | undefined, iface?: Interface): string`

解码 revert 数据为人类可读的错误信息。

**参数**：
- `data`: revert 数据（十六进制字符串）
- `iface`: 可选的合约 ABI 接口（用于解码自定义错误）

**返回**：解码后的错误信息字符串

**示例**：
```typescript
import { decodeRevert } from './utils/decodeRevert';
import { Interface } from 'ethers';

// 解码标准错误
const error1 = decodeRevert('0x08c379a0...');
// 返回: "Error(string): Insufficient balance"

// 解码 Panic 错误
const error2 = decodeRevert('0x4e487b71...');
// 返回: "Panic(uint256): Arithmetic overflow/underflow (code: 17)"

// 解码自定义错误（需要 ABI）
const iface = new Interface(['error CustomError(uint256)']);
const error3 = decodeRevert('0x...', iface);
// 返回: "CustomError: CustomError(123)"
```

**支持的 Panic 代码**：
- `0x01`: Assertion failed
- `0x11`: Arithmetic overflow/underflow
- `0x12`: Division by zero
- `0x21`: Invalid enum value
- `0x22`: Storage byte array improperly encoded
- `0x31`: Pop on empty array
- `0x32`: Array index out of bounds
- `0x41`: Memory overflow
- `0x51`: Zero-initialized variable

---

### 3. deploymentUtils.ts - 部署工具函数

**用途**：提供合约部署和部署信息管理的工具函数

**主要功能**：
- 部署单个合约
- 批量部署合约
- 保存和加载部署信息
- 获取合约实例
- 验证部署配置

**导出函数**：

#### `deployContract(contractName: string, constructorArgs: unknown[] = [], shouldVerify: boolean = true): Promise<DeploymentInfo>`

部署单个合约并记录部署信息。

**参数**：
- `contractName`: 合约名称
- `constructorArgs`: 构造函数参数数组
- `shouldVerify`: 是否验证合约（默认 true）

**返回**：部署信息对象

**示例**：
```typescript
import { deployContract } from './utils/deploymentUtils';

const info = await deployContract('MockERC20', ['Token', 'TKN', 18]);
console.log(`Deployed at: ${info.address}`);
```

#### `deployContracts(config: DeploymentConfig): Promise<{ [key: string]: DeploymentInfo }>`

批量部署多个合约。

**参数**：
- `config`: 部署配置对象

**示例**：
```typescript
import { deployContracts } from './utils/deploymentUtils';

const results = await deployContracts({
  network: 'localhost',
  deployer: '0x...',
  contracts: {
    Token: {
      factory: 'MockERC20',
      args: ['Token', 'TKN', 18],
      verify: false
    }
  }
});
```

#### `loadDeploymentInfo(network: string): { [key: string]: DeploymentInfo }`

加载指定网络的部署信息。

#### `getContractInstance(contractName: string, address: string): Promise<Contract>`

获取已部署合约的实例。

#### `isContractDeployed(network: string, contractName: string): boolean`

检查合约是否已部署。

#### `getContractAddress(network: string, contractName: string): string | null`

获取合约地址。

**接口定义**：
```typescript
interface DeploymentInfo {
  name: string;
  address: string;
  constructorArgs?: unknown[];
  transactionHash: string;
  blockNumber: number;
  gasUsed: string;
  deployedAtMs: number;
}
```

---

### 4. generateModuleKeys.ts - 模块键生成器

**用途**：从 Solidity 合约自动生成前端的 TypeScript 模块键常量文件

**主要功能**：
- 生成模块键哈希值映射
- 生成 TypeScript 类型定义
- 生成验证函数
- 生成验证文件

**导出函数**：

#### `generateModuleKeysTS(): Promise<void>`

生成完整的模块键 TypeScript 文件。

**输出文件**：
- `frontend-config/moduleKeys.ts` - 模块键常量文件
- `frontend-config/moduleKeysValidation.ts` - 验证文件

**生成的模块键**：
- `KEY_CM`, `KEY_LE`, `KEY_HF_CALC`, `KEY_STATS`
- `KEY_VAULT_CONFIG`, `KEY_FR`, `KEY_RM`
- `KEY_REWARD_CORE`, `KEY_REWARD_CONFIG`, `KEY_REWARD_CONSUMPTION`
- `KEY_VALUATION_ORACLE`, `KEY_GUARANTEE_FUND`
- `KEY_ACCESS_CONTROL`, `KEY_ASSET_WHITELIST`, `KEY_AUTHORITY_WHITELIST`
- `KEY_REGISTRY`, `KEY_LOAN_NFT`, `KEY_REWARD_POINTS`
- `KEY_PRICE_ORACLE`, `KEY_COINGECKO_UPDATER`
- `KEY_VAULT_BUSINESS_LOGIC`
- `KEY_ADVANCED_ANALYTICS_CONFIG`, `KEY_PRIORITY_SERVICE_CONFIG`
- `KEY_FEATURE_UNLOCK_CONFIG`, `KEY_GOVERNANCE_ACCESS_CONFIG`
- `KEY_TESTNET_FEATURES_CONFIG`, `KEY_REWARD_MANAGER_V1`
- 等等...

**使用方式**：
```typescript
import { generateModuleKeysTS } from './utils/generateModuleKeys';

await generateModuleKeysTS();
```

**生成的 TypeScript 文件包含**：
- `ModuleKeys` 对象：模块键到哈希值的映射
- `MODULE_KEY_STRINGS` 数组：所有模块键字符串
- `ModuleKey` 类型：模块键类型定义
- `isValidModuleKey()`: 验证模块键是否有效
- `getModuleKeyHash()`: 获取模块键的哈希值
- `getModuleKeyFromHash()`: 从哈希值获取模块键
- `getAllModuleKeys()`: 获取所有模块键
- `getModuleKeyCount()`: 获取模块键总数

---

### 5. logger.ts - 日志工具

**用途**：提供统一的日志输出和进度显示功能

**主要功能**：
- 带时间戳的彩色日志
- Spinner 进度指示器
- 表格输出
- 进度条
- 线程安全的 Mutex 保护

**导出类**：

#### `Logger` (单例模式)

**方法**：

##### `getInstance(): Logger`

获取 Logger 单例实例。

##### `info(message: string): void`

输出信息日志（蓝色）。

##### `success(message: string): void`

输出成功日志（绿色）。

##### `warning(message: string): void`

输出警告日志（黄色）。

##### `error(message: string, error?: Error): void`

输出错误日志（红色）。

##### `startSpinner(id: string, message: string): Promise<void>`

启动一个 spinner。

##### `updateSpinner(id: string, message: string): Promise<void>`

更新 spinner 消息。

##### `stopSpinner(id: string, success: boolean, message?: string): Promise<void>`

停止 spinner。

##### `table<T>(data: T[], columns?: string[]): void`

输出表格数据。

##### `progressBar(current: number, total: number, label?: string): void`

显示进度条。

**示例**：
```typescript
import logger from './utils/logger';

// 基本日志
logger.info('开始部署...');
logger.success('部署成功');
logger.warning('警告信息');
logger.error('错误信息', error);

// Spinner
await logger.startSpinner('deploy', '部署合约中...');
// ... 执行操作
await logger.stopSpinner('deploy', true, '部署完成');

// 表格
logger.table([
  { name: 'Contract1', address: '0x...' },
  { name: 'Contract2', address: '0x...' }
], ['name', 'address']);

// 进度条
for (let i = 0; i <= 100; i++) {
  logger.progressBar(i, 100, '处理中');
  await sleep(100);
}
```

---

### 6. saveAddress.ts - 地址管理工具

**用途**：提供统一的部署地址记录与管理系统

**主要功能**：
- 保存和更新合约地址
- 支持代理和实现地址
- 地址验证
- 备份功能
- 前端配置生成
- 部署摘要生成

**导出类**：

#### `AddressManager`

**构造函数**：
```typescript
new AddressManager(
  network: string,
  networkInfo: NetworkInfo,
  baseDir?: string
)
```

**方法**：

##### `saveAddress(contractName: string, address: string, deployer: string, options?: {...}): void`

保存合约地址。

##### `updateAddress(contractName: string, newAddress: string, deployer: string, options?: {...}): void`

更新合约地址（自动创建备份）。

##### `getAddress(contractName: string): string`

获取合约地址。

##### `getProxyAddress(contractName: string): string | undefined`

获取代理地址。

##### `getImplementationAddress(contractName: string): string | undefined`

获取实现地址。

##### `hasAddress(contractName: string): boolean`

检查地址是否存在。

##### `getAllAddresses(): AddressConfig`

获取所有地址。

##### `createBackup(): void`

创建地址备份。

##### `validateAddresses(): { valid: boolean; errors: string[] }`

验证所有地址格式。

##### `generateFrontendConfig(outputDir?: string): void`

生成前端配置文件。

##### `generateSummary(): void`

生成部署摘要。

**便捷函数**：

##### `createAddressManager(network: string, networkInfo: NetworkInfo): AddressManager`

创建 AddressManager 实例。

##### `saveContractAddress(...): void`

保存合约地址的便捷函数。

##### `getContractAddress(...): string`

获取合约地址的便捷函数。

##### `validateDeployment(manager: AddressManager): boolean`

验证部署的便捷函数。

##### `generateDeploymentArtifacts(manager: AddressManager): void`

生成部署产物的便捷函数。

**示例**：
```typescript
import { createAddressManager } from './utils/saveAddress';

const manager = createAddressManager('localhost', {
  chainId: 1337,
  name: 'localhost',
  rpcUrl: 'http://127.0.0.1:8545',
  explorerUrl: 'http://127.0.0.1:8545'
});

// 保存地址
manager.saveAddress('Registry', '0x...', deployer.address, {
  proxyAddress: '0x...',
  implementationAddress: '0x...'
});

// 获取地址
const addr = manager.getAddress('Registry');

// 生成摘要
manager.generateSummary();
```

---

### 7. verificationUtils.ts - 合约验证工具

**用途**：在区块浏览器上验证合约源代码

**主要功能**：
- 验证单个合约
- 批量验证合约
- 保存验证信息
- 检查验证状态
- 生成验证报告

**导出函数**：

#### `verifyContract(config: VerificationConfig): Promise<boolean>`

验证单个合约。

**参数**：
```typescript
interface VerificationConfig {
  network: string;              // 网络名称
  contractAddress: string;       // 合约地址
  constructorArgs?: unknown[];   // 构造函数参数
  apiKey?: string;              // API 密钥（可选）
  apiUrl?: string;              // API URL（可选）
  verifiedAtMs?: number;        // 验证时间（可选）
}
```

**示例**：
```typescript
import { verifyContract } from './utils/verificationUtils';

const success = await verifyContract({
  network: 'arbitrum-sepolia',
  contractAddress: '0x1234...5678',
  constructorArgs: ['arg1', 'arg2', 123]
});
```

#### `verifyContracts(contracts: VerificationConfig[]): Promise<{ [address: string]: boolean }>`

批量验证多个合约。

**示例**：
```typescript
import { verifyContracts } from './utils/verificationUtils';

const results = await verifyContracts([
  { network: 'arbitrum-sepolia', contractAddress: '0x...' },
  { network: 'arbitrum-sepolia', contractAddress: '0x...' }
]);
```

#### `isContractVerified(network: string, address: string): boolean`

检查合约是否已验证。

#### `getVerificationInfo(network: string, address: string): VerificationConfig | null`

获取验证信息。

#### `generateVerificationReport(network: string): void`

生成验证报告。

#### `verifyDeploymentState(contractAddress: string, expectedFunctions?: string[]): Promise<boolean>`

验证部署后的合约状态。

**示例**：
```typescript
import { 
  verifyContract, 
  verifyContracts,
  generateVerificationReport 
} from './utils/verificationUtils';

// 验证单个合约
await verifyContract({
  network: 'arbitrum-sepolia',
  contractAddress: '0x...',
  constructorArgs: []
});

// 批量验证
const results = await verifyContracts([...]);

// 生成报告
generateVerificationReport('arbitrum-sepolia');
```

---

## 🔧 使用场景

### 场景 1: 部署时配置资产

```typescript
import { loadAssetsConfig, configureAssets } from './utils/configure-assets';

const assets = loadAssetsConfig('arbitrum-sepolia', 421614);
await configureAssets(ethers, priceOracleAddress, assets);
```

### 场景 2: 解码交易错误

```typescript
import { decodeRevert } from './utils/decodeRevert';

try {
  await contract.someFunction();
} catch (error: any) {
  const decoded = decodeRevert(error.data);
  console.log('错误:', decoded);
}
```

### 场景 3: 使用日志工具

```typescript
import logger from './utils/logger';

logger.info('开始部署');
await logger.startSpinner('deploy', '部署中...');
// ... 执行操作
await logger.stopSpinner('deploy', true, '完成');
```

### 场景 4: 管理部署地址

```typescript
import { createAddressManager } from './utils/saveAddress';

const manager = createAddressManager('localhost', networkInfo);
manager.saveAddress('Registry', address, deployer);
manager.generateSummary();
```

### 场景 5: 生成模块键文件

```typescript
import { generateModuleKeysTS } from './utils/generateModuleKeys';

await generateModuleKeysTS();
// 生成 frontend-config/moduleKeys.ts
```

### 场景 6: 验证合约

```typescript
import { verifyContract } from './utils/verificationUtils';

await verifyContract({
  network: 'arbitrum-sepolia',
  contractAddress: '0x...',
  constructorArgs: []
});
```

---

## 📝 最佳实践

### 1. 错误处理

```typescript
import { decodeRevert } from './utils/decodeRevert';

try {
  await contract.call();
} catch (error: any) {
  const decoded = decodeRevert(error.data);
  logger.error('交易失败', new Error(decoded));
}
```

### 2. 日志使用

```typescript
import logger from './utils/logger';

// 使用 spinner 显示长时间操作
await logger.startSpinner('task', '处理中...');
try {
  await longRunningTask();
  await logger.stopSpinner('task', true, '成功');
} catch (error) {
  await logger.stopSpinner('task', false, '失败');
  throw error;
}
```

### 3. 地址管理

```typescript
import { createAddressManager, validateDeployment } from './utils/saveAddress';

const manager = createAddressManager(network, networkInfo);

// 保存地址时包含代理信息
manager.saveAddress('VaultCore', address, deployer, {
  proxyAddress: proxyAddr,
  implementationAddress: implAddr
});

// 部署后验证
if (!validateDeployment(manager)) {
  throw new Error('部署验证失败');
}
```

### 4. 批量操作

```typescript
import { verifyContracts } from './utils/verificationUtils';

// 批量验证时添加延迟避免 API 限制
const contracts = [...];
const results = await verifyContracts(contracts);
```

---

## 🔗 工具间的协作

### 部署流程中的工具使用

```typescript
import logger from './utils/logger';
import { deployContract } from './utils/deploymentUtils';
import { createAddressManager } from './utils/saveAddress';
import { verifyContract } from './utils/verificationUtils';
import { configureAssets, loadAssetsConfig } from './utils/configure-assets';

// 1. 使用日志工具
logger.info('开始部署');

// 2. 部署合约
const info = await deployContract('PriceOracle', [registryAddress]);

// 3. 保存地址
const manager = createAddressManager('localhost', networkInfo);
manager.saveAddress('PriceOracle', info.address, deployer);

// 4. 配置资产
const assets = loadAssetsConfig('localhost', 1337);
await configureAssets(ethers, info.address, assets);

// 5. 验证合约
await verifyContract({
  network: 'localhost',
  contractAddress: info.address,
  constructorArgs: [registryAddress]
});

logger.success('部署完成');
```

---

## 📚 相关文档

- [部署脚本文档](../deploy/README.md)
- [任务脚本文档](../tasks/README.md)
- [PriceOracle 使用指南](../../Usage-Guide/PriceOracle-Guide.md)

---

## 🛠️ 开发指南

### 创建新工具函数

1. **创建工具文件**

```typescript
// scripts/utils/my-utility.ts
export function myUtilityFunction(param: string): string {
  // 实现逻辑
  return result;
}
```

2. **导出函数**

```typescript
export { myUtilityFunction };
```

3. **在其他脚本中使用**

```typescript
import { myUtilityFunction } from './utils/my-utility';

const result = myUtilityFunction('param');
```

### 工具函数设计原则

1. **单一职责**：每个函数只做一件事
2. **可复用性**：设计为可在多个场景使用
3. **错误处理**：包含适当的错误处理
4. **类型安全**：使用 TypeScript 类型定义
5. **文档注释**：添加清晰的 JSDoc 注释

---

## 📄 许可证

MIT License


# 测试账户配置指南

## 概述

本项目提供了完整的测试账户配置系统，支持在本地开发和测试环境中使用预配置的测试账户。

## 快速开始

### 1. 生成测试环境配置

运行以下命令来自动生成 `.env` 文件，包含所有 Hardhat 测试账户信息：

```bash
npx hardhat run scripts/setup-test-env.js
```

这个脚本会：
- 读取 `env.example` 文件
- 获取 Hardhat 的默认测试账户
- 自动更新所有测试账户的私钥和地址
- 创建 `.env` 文件

### 2. 验证配置

运行测试来验证配置是否正确：

```bash
npm test test/TestAccountsUsage.test.js
```

## 测试账户配置

### 环境变量格式

每个测试账户都有以下环境变量：

```bash
# 账户 0 (所有者/部署者)
TEST_ACCOUNT_0_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
TEST_ACCOUNT_0_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# 账户 1 (用户1)
TEST_ACCOUNT_1_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
TEST_ACCOUNT_1_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

# ... 更多账户
```

### 别名配置

为了方便使用，还提供了别名配置：

```bash
# 所有者账户别名
TEST_OWNER_PRIVATE_KEY=${TEST_ACCOUNT_0_PRIVATE_KEY}
TEST_OWNER_ADDRESS=${TEST_ACCOUNT_0_ADDRESS}

# 用户账户别名
TEST_USER1_PRIVATE_KEY=${TEST_ACCOUNT_1_PRIVATE_KEY}
TEST_USER1_ADDRESS=${TEST_ACCOUNT_1_ADDRESS}
```

## 使用方法

### 方法1: 使用 Hardhat 默认账户（推荐）

```javascript
const { ethers } = require('hardhat');

describe('合约测试', function () {
  let owner, user1, user2, user3;

  beforeEach(async function () {
    [owner, user1, user2, user3] = await ethers.getSigners();
  });

  it('应该能够部署合约', async function () {
    const Contract = await ethers.getContractFactory('MyContract');
    const contract = await Contract.deploy();
    await contract.waitForDeployment();
    
    console.log('合约地址:', await contract.getAddress());
  });
});
```

### 方法2: 从环境变量创建钱包

```javascript
const { ethers } = require('hardhat');
require('dotenv').config();

describe('环境变量账户测试', function () {
  let ownerWallet, user1Wallet;

  beforeEach(async function () {
    // 从环境变量创建钱包
    ownerWallet = new ethers.Wallet(
      process.env.TEST_ACCOUNT_0_PRIVATE_KEY, 
      ethers.provider
    );
    
    user1Wallet = new ethers.Wallet(
      process.env.TEST_ACCOUNT_1_PRIVATE_KEY, 
      ethers.provider
    );
  });

  it('应该能够使用环境变量账户', async function () {
    const Contract = await ethers.getContractFactory('MyContract');
    const contract = await Contract.connect(ownerWallet).deploy();
    await contract.waitForDeployment();
    
    console.log('使用环境变量账户部署的合约:', await contract.getAddress());
  });
});
```

### 方法3: 混合使用

```javascript
const { ethers } = require('hardhat');
require('dotenv').config();

describe('混合账户测试', function () {
  let owner, user1;
  let envOwner, envUser1;

  beforeEach(async function () {
    // Hardhat 默认账户
    [owner, user1] = await ethers.getSigners();
    
    // 环境变量账户
    envOwner = new ethers.Wallet(
      process.env.TEST_ACCOUNT_0_PRIVATE_KEY, 
      ethers.provider
    );
    
    envUser1 = new ethers.Wallet(
      process.env.TEST_ACCOUNT_1_PRIVATE_KEY, 
      ethers.provider
    );
  });

  it('两种方法应该产生相同的地址', async function () {
    expect(owner.address).to.equal(envOwner.address);
    expect(user1.address).to.equal(envUser1.address);
  });
});
```

## 账户余额管理

### 检查余额

```javascript
it('应该能够检查账户余额', async function () {
  const [owner, user1] = await ethers.getSigners();
  
  const ownerBalance = await ethers.provider.getBalance(owner.address);
  const user1Balance = await ethers.provider.getBalance(user1.address);
  
  console.log('所有者余额:', ethers.formatEther(ownerBalance), 'ETH');
  console.log('用户1余额:', ethers.formatEther(user1Balance), 'ETH');
});
```

### 转账操作

```javascript
it('应该能够进行转账', async function () {
  const [owner, user1] = await ethers.getSigners();
  
  const initialBalance = await ethers.provider.getBalance(user1.address);
  
  // 转账 1 ETH
  const tx = await owner.sendTransaction({
    to: user1.address,
    value: ethers.parseEther('1.0')
  });
  
  await tx.wait();
  
  const finalBalance = await ethers.provider.getBalance(user1.address);
  const balanceChange = finalBalance - initialBalance;
  
  console.log('转账金额:', ethers.formatEther(balanceChange), 'ETH');
});
```

## 安全注意事项

### ⚠️ 重要提醒

1. **仅用于测试**: 这些测试账户仅用于本地开发和测试，不要在生产环境中使用
2. **私钥安全**: 测试账户的私钥是公开的，不要用于存储真实资产
3. **环境变量**: 确保 `.env` 文件已添加到 `.gitignore` 中，避免意外提交
4. **网络隔离**: 测试时使用本地 Hardhat 网络或测试网络

### 最佳实践

1. **使用别名**: 在测试中使用有意义的别名，如 `owner`、`user1` 等
2. **余额检查**: 在测试前检查账户余额，确保有足够的 ETH 进行交易
3. **错误处理**: 添加适当的错误处理和断言
4. **清理**: 测试完成后清理状态，避免影响其他测试

## 故障排除

### 常见问题

1. **环境变量未加载**
   ```bash
   # 确保安装了 dotenv
   npm install dotenv
   
   # 在测试文件顶部添加
   require('dotenv').config();
   ```

2. **账户余额不足**
   ```javascript
   // 检查余额
   const balance = await ethers.provider.getBalance(account.address);
   if (balance < ethers.parseEther('0.1')) {
     console.log('账户余额不足，需要充值');
   }
   ```

3. **网络连接问题**
   ```javascript
   // 检查网络连接
   const network = await ethers.provider.getNetwork();
   console.log('当前网络:', network.name);
   ```

### 调试技巧

1. **启用详细日志**
   ```javascript
   // 在测试中启用详细日志
   console.log('账户地址:', account.address);
   console.log('账户余额:', ethers.formatEther(balance));
   ```

2. **使用 Hardhat 控制台**
   ```bash
   npx hardhat console
   ```

3. **检查环境变量**
   ```javascript
   console.log('环境变量状态:', {
     hasOwnerKey: !!process.env.TEST_ACCOUNT_0_PRIVATE_KEY,
     hasUser1Key: !!process.env.TEST_ACCOUNT_1_PRIVATE_KEY
   });
   ```

## 相关文件

- `env.example` - 环境变量模板
- `scripts/setup-test-env.js` - 自动配置脚本
- `test/TestAccountsUsage.test.js` - 使用示例测试
- `.gitignore` - 确保 `.env` 文件不被提交

## 更新日志

- **v1.0.0** - 初始版本，支持 20 个测试账户
- 添加了自动配置脚本
- 提供了完整的使用示例
- 包含了安全最佳实践指南 
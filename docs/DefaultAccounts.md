# Hardhat 默认账户使用指南

## 概述

这是最简单、最常用的测试账户方法。Hardhat 默认会创建 **20 个测试账户**，每个账户都有 **10000 ETH** 的测试余额。

## 🚀 快速开始

### 1. 获取默认账户

```javascript
const { ethers } = require("hardhat");

async function main() {
  // 获取所有默认测试账户
  const signers = await ethers.getSigners();
  console.log(`总共有 ${signers.length} 个默认测试账户`);
  
  // 解构获取常用账户
  const [owner, user1, user2, user3, user4, user5] = signers;
  
  console.log("账户分配:");
  console.log(`所有者: ${owner.address}`);
  console.log(`用户1: ${user1.address}`);
  console.log(`用户2: ${user2.address}`);
  console.log(`用户3: ${user3.address}`);
}
```

### 2. 使用账户部署合约

```javascript
// 使用所有者账户部署合约
const WhitelistRegistry = await ethers.getContractFactory("WhitelistRegistry");
const whitelistRegistry = await WhitelistRegistry.connect(owner).deploy(owner.address);
await whitelistRegistry.waitForDeployment();
```

### 3. 使用不同账户调用函数

```javascript
// 所有者添加用户到白名单
await whitelistRegistry.connect(owner).addAddress(user1.address);

// 用户1检查自己的白名单状态
const isWhitelisted = await whitelistRegistry.connect(user1).isWhitelisted(user1.address);

// 用户2尝试添加用户3（会被拒绝）
try {
  await whitelistRegistry.connect(user2).addAddress(user3.address);
} catch (error) {
  console.log("用户2没有权限添加地址");
}
```

## 📋 默认账户信息

Hardhat 默认账户的私钥是固定的：

| 账户索引 | 私钥 |
|---------|------|
| 0 (owner) | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| 1 (user1) | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| 2 (user2) | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |
| 3 (user3) | `0x7c852118e8d7e3bdfa4c9b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b` |
| 4 (user4) | `0x8d852118e8d7e3bdfa4c9b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b` |

## 💡 实际使用示例

### 部署和测试白名单系统

```javascript
const { ethers } = require("hardhat");

async function main() {
  // 获取测试账户
  const [owner, user1, user2, user3] = await ethers.getSigners();
  
  // 部署合约
  const WhitelistRegistry = await ethers.getContractFactory("WhitelistRegistry");
  const whitelistRegistry = await WhitelistRegistry.connect(owner).deploy(owner.address);
  await whitelistRegistry.waitForDeployment();
  
  // 添加用户到白名单
  await whitelistRegistry.connect(owner).addAddress(user1.address);
  await whitelistRegistry.connect(owner).addAddress(user2.address);
  
  // 检查白名单状态
  const user1Status = await whitelistRegistry.isWhitelisted(user1.address);
  const user3Status = await whitelistRegistry.isWhitelisted(user3.address);
  
  console.log(`用户1白名单状态: ${user1Status}`);
  console.log(`用户3白名单状态: ${user3Status}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
```

### 在测试中使用

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("WhitelistRegistry", function () {
  let whitelistRegistry;
  let owner, user1, user2, nonOwner;

  beforeEach(async function () {
    // 获取默认测试账户
    [owner, user1, user2, nonOwner] = await ethers.getSigners();
    
    // 部署合约
    const WhitelistRegistry = await ethers.getContractFactory("WhitelistRegistry");
    whitelistRegistry = await WhitelistRegistry.deploy(owner.address);
    await whitelistRegistry.waitForDeployment();
  });

  it("所有者应该能够添加地址", async function () {
    await whitelistRegistry.connect(owner).addAddress(user1.address);
    expect(await whitelistRegistry.isWhitelisted(user1.address)).to.be.true;
  });

  it("非所有者不应该能够添加地址", async function () {
    await expect(
      whitelistRegistry.connect(nonOwner).addAddress(user1.address)
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });
});
```

## 🛠️ 运行脚本

### 查看默认账户

```bash
npx hardhat run scripts/simple-test-accounts.js
```

### 运行测试

```bash
npx hardhat test test/SimpleWhitelist.test.js
```

## ✅ 优势

1. **简单易用**: 无需额外配置，开箱即用
2. **预配置余额**: 每个账户都有 10000 ETH
3. **固定私钥**: 便于调试和重现问题
4. **足够数量**: 20 个账户满足大多数测试需求
5. **无需管理**: 不需要手动创建或管理账户

## 🔧 常用模式

### 模式1: 基本解构

```javascript
const [owner, user1, user2, user3] = await ethers.getSigners();
```

### 模式2: 命名解构

```javascript
const signers = await ethers.getSigners();
const owner = signers[0];
const user1 = signers[1];
const user2 = signers[2];
```

### 模式3: 循环使用

```javascript
const signers = await ethers.getSigners();
for (let i = 0; i < signers.length; i++) {
  const signer = signers[i];
  console.log(`账户 ${i}: ${signer.address}`);
}
```

## 🚨 注意事项

1. **仅用于测试**: 这些账户仅用于开发和测试
2. **固定私钥**: 不要在生产环境中使用这些私钥
3. **本地网络**: 这些账户只在本地 Hardhat 网络中有效
4. **余额充足**: 每个账户都有足够的 ETH 进行测试

## 📚 相关文件

- `scripts/simple-test-accounts.js` - 查看默认账户的脚本
- `test/SimpleWhitelist.test.js` - 使用默认账户的测试文件

---

**总结**: 使用 `ethers.getSigners()` 获取默认账户是最简单、最推荐的方法！ 
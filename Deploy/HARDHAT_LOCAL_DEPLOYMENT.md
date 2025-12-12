# 🦊 Hardhat 本地钱包部署指南

## 🎯 概述

本指南详细说明如何使用 Hardhat 本地钱包部署 RWA Lending Platform 到 Arbitrum Sepolia 测试网。

## 🔧 环境准备

### **1. 安装依赖**
```bash
# 确保所有依赖已安装
npm install

# 编译合约
npm run compile
```

### **2. 配置环境变量**
```bash
# 复制环境变量模板
cp env.example .env

```

#### **必需配置**
```bash
# 测试钱包私钥（必需）
PRIVATE_KEY=0x你的测试私钥

# 可选但建议配置
ARBISCAN_API_KEY=你的Arbiscan_API密钥
REPORT_GAS=true
```

### **3. 获取测试币**
访问 [Arbitrum Sepolia Faucet](https://faucet.quicknode.com/arbitrum/sepolia) 获取测试 ETH

## 🚀 部署步骤

### **方法一：使用脚本运行器（推荐）**

#### **1. 检查环境**
```bash
# 检查环境配置
npm run script checks env

# 检查合约一致性
npm run script checks contract-consistency

# 运行所有检查
npm run script checks all
```

#### **2. 部署到 Arbitrum Sepolia**
```bash
# 一键部署到 Arbitrum Sepolia
npm run script deploy arbitrum-sepolia
```

#### **3. 查看部署结果**
```bash
# 查看部署记录
cat scripts/deployments/arbitrum-sepolia.json

# 查看前端配置
cat frontend-config/contracts-arbitrum-sepolia.ts
```

### **方法二：使用 Hardhat 命令**

#### **1. 直接使用 Hardhat**
```bash
# 部署到 Arbitrum Sepolia
npx hardhat run scripts/deploy/deploy-arbitrum-sepolia.ts --network arbitrum-sepolia
```

#### **2. 使用 ts-node**
```bash
# 使用 ts-node 运行
npx ts-node --project tsconfig.scripts.json scripts/deploy/deploy-arbitrum-sepolia.ts
```

## 🔍 部署验证

### **1. 检查部署状态**
```bash
# 查看部署记录
ls -la scripts/deployments/

# 查看备份文件
ls -la scripts/secrets/backups/
```

### **2. 验证合约**
```bash
# 在 Arbitrum Sepolia 浏览器中查看合约
# 访问: https://sepolia.arbiscan.io
# 输入合约地址进行验证
```

### **3. 测试合约功能**
```bash
# 运行集成测试
npm run script test integration

# 运行特定测试
npm test
```

## 📊 部署流程详解

### **部署顺序**
1. **Registry** - 全局模块注册表
2. **权限系统** - AccessControlManager, AssetWhitelist, AuthorityWhitelist
3. **预言机系统** - PriceOracle, CoinGeckoPriceUpdater
4. **奖励系统** - RewardPoints, RewardManagerCore, RewardManager
5. **Vault 系统** - 所有 Vault 相关模块
6. **模块注册** - 将所有模块注册到 Registry
7. **前端配置** - 生成前端配置文件

### **部署检查点**
- ✅ 环境变量检查
- ✅ 网络连接验证
- ✅ 钱包余额检查
- ✅ 合约编译检查
- ✅ 钱包资产备份
- ✅ 分步部署验证
- ✅ 模块注册确认
- ✅ 前端配置生成

## 🔒 安全注意事项

### **私钥安全**
- 🔒 使用测试钱包，不要使用主网钱包
- 🔒 不要将私钥提交到 Git 仓库
- 🔒 定期更换测试私钥
- 🔒 使用硬件钱包存储大额资产

### **部署安全**
- 🌐 先在测试网充分测试
- 🌐 部署前备份钱包资产
- 🌐 验证所有合约地址
- 🌐 检查合约权限设置

## 🛠️ 故障排除

### **常见问题**

#### **1. 网络连接失败**
```bash
# 检查 RPC URL
# 确保使用正确的 Arbitrum Sepolia RPC
# https://sepolia-rollup.arbitrum.io/rpc
```

#### **2. 余额不足**
```bash
# 访问 Arbitrum Sepolia Faucet 获取测试币
# https://faucet.quicknode.com/arbitrum/sepolia
```

#### **3. 合约编译失败**
```bash
# 重新编译合约
npm run compile

# 清理缓存
npx hardhat clean
```

#### **4. 部署中断**
```bash
# 查看部署记录
cat scripts/deployments/arbitrum-sepolia.json

# 重新运行部署（会跳过已部署的合约）
npm run script deploy arbitrum-sepolia
```

## 📈 部署后操作

### **1. 验证部署**
```bash
# 检查所有合约地址
cat scripts/deployments/arbitrum-sepolia.json

# 在浏览器中验证合约
# https://sepolia.arbiscan.io
```

### **2. 集成前端**
```bash
# 复制前端配置文件
cp frontend-config/contracts-arbitrum-sepolia.ts your-frontend-project/src/config/

# 在前端项目中使用
import { CONTRACT_ADDRESSES, NETWORK_CONFIG } from './config/contracts-arbitrum-sepolia';
```

### **3. 运行测试**
```bash
# 集成测试
npm run script test integration

# 单元测试
npm test

# 性能测试
npm run script utils performance-monitor
```

## 🎉 成功部署标志

部署成功后，你应该看到：

```bash
🎉 Arbitrum Sepolia 部署完成！
============================================================
📋 部署地址:
Registry: 0x...
AccessControlManager: 0x...
AssetWhitelist: 0x...
PriceOracle: 0x...
VaultCore: 0x...
...
============================================================
🌐 网络: arbitrum-sepolia
🔗 浏览器: https://sepolia.arbiscan.io
📄 配置文件: frontend-config/contracts-arbitrum-sepolia.ts
============================================================
```

## 🔗 有用链接

- [Arbitrum Sepolia Faucet](https://faucet.quicknode.com/arbitrum/sepolia)
- [Arbitrum Sepolia Explorer](https://sepolia.arbiscan.io)
- [Arbitrum 文档](https://developer.arbitrum.io/)
- [Hardhat 文档](https://hardhat.org/docs)

## 🎯 下一步

部署成功后，你可以：

1. **前端集成** - 将合约地址集成到前端项目
2. **功能测试** - 测试所有合约功能
3. **性能优化** - 优化 Gas 使用
4. **安全审计** - 进行安全审计
5. **主网部署** - 部署到 Arbitrum 主网

祝你部署顺利！🚀 
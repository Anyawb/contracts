# 前端与智能合约连接完整指南

## 🎯 概述

本指南详细说明如何将前端应用与 RWA Lending Platform 智能合约进行连接，包括测试网部署、合约调用和前端集成。

如果当前任务是接入 blocks-only 前端或撮合链路，先读 [Usage-Guide/Blocks-Only-Frontend-Matching-Checklist.md](Usage-Guide/Blocks-Only-Frontend-Matching-Checklist.md)，再回到本指南查具体 ABI、权限与调用细节。

### 统一价格消费规则（新增 SSOT）

价格相关前端逻辑必须统一遵循下面这条链路：

1. 链下价格采集
2. 统一归一化成 USD-8
3. 统一调用 `PriceUpdater.updateAssetPrice`
4. 统一由 `PriceOracle` 存储
5. 前端只认链上最终价和链下发布状态

这意味着：

1. 前端不得直接消费 Google Finance、CoinGecko 或其他 source 的 raw 值做业务判断
2. 前端不得把 `defaultPriceUsd8` 当成权威价格
3. 前端显示“价格可用”至少要同时满足：链上可读 + 链下 publish status 正常

## 📋 目录

1. [环境准备](#环境准备)
2. [智能合约部署流程](#智能合约部署流程)
3. [合约地址管理](#合约地址管理)
4. [前端集成方案](#前端集成方案)
5. [合约调用示例](#合约调用示例)
6. [测试和验证](#测试和验证)
7. [生产环境部署](#生产环境部署)
8. [模块键解码与前端配合](#模块键解码与前端配合)
9. [错误处理和调试](#错误处理和调试)
10. [CollateralManager（抵押账本）前端配合要点（2026-01）](#collateralmanager抵押账本前端配合要点2026-01)
11. [接口变更与迁移指南（2025-09）](#接口变更与迁移指南2025-09)
12. [缓存推送失败重试（CacheUpdateFailed）前端配合](#缓存推送失败重试cacheupdatefailed前端配合)
13. [资金链（Funds Flow / SSOT）前端配合（2026-01）](#资金链funds-flow--ssot前端配合2026-01)
14. [Block-based Deadline 与 ETA 映射（前端/keeper 必须遵守）](#block-based-deadline-与-eta-映射前端keeper-必须遵守)
15. [AI Credits 计费规范（按次计费：链上购买 + 链下扣次 + 多租户对账）](#ai-credits-计费规范按次计费链上购买--链下扣次--多租户对账)

## 🔧 环境准备

### 1. 环境变量配置

首先确保你的 `.env` 文件包含必要的配置：

```bash
# 网络配置
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc

# 部署账户
PRIVATE_KEY=your_private_key_here

# API Keys
ARBISCAN_API_KEY=your_arbiscan_api_key
ETHERSCAN_API_KEY=your_etherscan_api_key

# Gas 报告
REPORT_GAS=true
```

### 2. 检查环境配置

使用我们的脚本检查环境配置：

```bash
# 检查环境变量
npm run script checks env

# 检查合约一致性
npm run script checks contract-consistency

# 运行所有检查
npm run script checks all
```

### 3. 安全配置与钱包管理

#### 3.1. 环境变量安全配置

**创建环境变量文件**：

```bash
# 复制环境变量模板
cp env.example .env

# 编辑 .env 文件，填写真实值
# 注意：不要将 .env 文件提交到 Git 仓库
```

**环境变量模板**：
项目提供 `.env.template` 文件作为格式说明，包含：

- 网络 RPC URL 配置
- API 密钥配置
- 私钥配置（仅用于测试）
- Gas 报告配置
- 安全配置检查清单

#### 3.2. 钱包资产备份

**部署前备份钱包资产**：

```bash
# 备份指定网络的钱包资产
npm run script utils backup-wallet-assets --action backup --network arbitrum-sepolia

# 查看所有备份文件
npm run script utils backup-wallet-assets --action list
```

**备份功能特性**：

- ✅ 自动备份 ETH 余额
- ✅ 自动备份常见代币余额（USDC、WETH、ARB 等）
- ✅ 生成时间戳备份文件
- ✅ 支持多网络备份
- ✅ 防止意外转空钱包

**备份文件位置**：

```
scripts/secrets/backups/
├── wallet-backup-arbitrum-sepolia-2024-01-15T10-30-00-000Z.json
├── wallet-backup-arbitrum-sepolia-2024-01-15T11-45-00-000Z.json
└── ...
```

#### 3.3. 安全最佳实践

**私钥管理**：

- 🔒 使用测试钱包进行开发测试
- 🔒 主网私钥单独安全存储
- 🔒 定期更换私钥
- 🔒 使用硬件钱包存储大额资产

**环境隔离**：

- 🌐 测试网和主网使用不同钱包
- 🌐 开发环境和生产环境分离
- 🌐 定期清理测试环境

**备份策略**：

- 📁 定期备份钱包资产信息
- 📁 备份环境配置文件
- 📁 备份部署记录和合约地址
- 📁 使用加密存储敏感信息

**部署前检查清单**：

```bash
# 1. 检查环境配置
npm run script checks env

# 2. 备份钱包资产
npm run script utils backup-wallet-assets --action backup --network arbitrum-sepolia

# 3. 验证网络连接
npm run script utils network-config

# 4. 运行完整检查
npm run script checks all

# 5. 确认钱包余额充足
# 检查备份文件中的余额信息
```

## 🚀 智能合约部署流程

### 1. 部署顺序总览

由于合约系统高度模块化且存在复杂依赖关系，需要按照以下顺序分批部署：

#### 第一批：基础与注册中心

- **Registry**（全局模块注册表）
- **ModuleKeys**、**ActionKeys**（常量库，通常只需部署一次或直接用库）

#### 第二批：权限与白名单

- **AccessControlManager**（权限管理，建议用代理部署）
- **AssetWhitelist**（资产白名单，建议用代理部署）
- **AuthorityWhitelist**（如有需要）

#### 第三批：预言机与价格系统

- **PriceOracle**（价格预言机）
- **PriceUpdater**（价格更新器）
- **ValuationOracleView**（价格只读门面；健康检查走 `GracefulDegradation`，不要求 oracle 合约实现额外 health 方法）

#### 第四批：核心业务与奖励系统

- **FeeRouter**（手续费路由，建议用代理部署）
- **RewardToken**（奖励通证；SSOT = `Registry[KEY_EASY_TOKEN]`（EasyToken））
- **RewardManagerCore**、**RewardManager**（奖励管理，建议用代理部署）
- **RewardConfig**（治理写入口聚合，如需）
- **EarnConfig / EasyEmissionConfig / FeatureRegistry / GovernanceGate**（Reward 子模块；通过 Registry 解析）

#### 第五批：Vault 相关

- **CollateralManager**、**LendingEngine / VaultLendingEngine**、**HealthView**、**StatisticsView（替代 VaultStatistics）**、**GuaranteeFundManager**（均建议用代理部署）
- **VaultStorage**（需要前面所有模块的地址，建议用代理部署）
- **VaultBusinessLogic**（如有）
- **VaultCore**（需要 VaultStorage 和业务逻辑模块地址，建议用代理部署）
- **VaultRouter**、**VaultAdmin**（如有）

#### 第六批：其他模块

- **LoanNFT**、**RWAToken**、**Mock 合约**等

### 2. 详细部署步骤与依赖说明

#### 1. Registry

- 先部署 Registry，后续所有模块地址都注册到这里。

#### 2. 权限与白名单

- AccessControlManager、AssetWhitelist、AuthorityWhitelist（如有）都可以独立部署，但后续需要注册到 Registry。

#### 3. 预言机系统

- 先部署 PriceOracle，再部署 PriceUpdater，并初始化二者的互相关联。
- **ValuationOracleView** 依赖 `Registry(KEY_PRICE_ORACLE)`，作为前端/运维的价格只读门面；
  其 oracle 健康检查通过 `GracefulDegradation.checkPriceOracleHealth(...)` 实现（不要求 `PriceOracle` 提供额外 health 方法）。

#### 4. 奖励系统

- 先部署奖励通证（SSOT = `Registry[KEY_EASY_TOKEN]`（EasyToken）），再部署 RewardManagerCore、RewardManager。
- RewardManager/RewardManagerCore 均以 **Registry** 作为唯一依赖入口（`initialize(registry)`）：
  - RewardToken / RewardManagerCore 等模块地址通过 `Registry.getModuleOrRevert(ModuleKeys.*)` 解析（避免在构造/initialize 里传入多地址导致指针漂移）。
  - 部署后务必在 Registry 中绑定 `KEY_EASY_TOKEN`、`KEY_REWARD_MANAGER_CORE` 等必要模块，否则写路径会因 `ModuleNotRegistered` revert。
- RewardConfig（如启用）可用于聚合治理写入口；EarnConfig、EasyEmissionConfig 等参数模块建议先部署并注册到 Registry。

#### 5. Vault 相关

- 先部署 CollateralManager、LendingEngine/VaultLendingEngine、HealthView、StatisticsView（替代 VaultStatistics）、GuaranteeFundManager（这些都需要 Registry 地址）。
- 部署 VaultStorage 时，需要传入上述所有模块的地址，以及 RWA Token、结算Token地址。
- 部署 VaultBusinessLogic（如有）。
- 部署 VaultCore 时，需要 VaultStorage 和业务逻辑模块的地址。
- VaultRouter、VaultAdmin 依赖 VaultStorage。

#### 6. 其他

- LoanNFT、RWAToken 等可在主业务部署后部署。

### 3. 自动化部署脚本

#### 选择测试网络

推荐使用 **Arbitrum Sepolia** 测试网：

```bash
# 查看网络配置
npm run script utils network-config

# 验证网络连接
npm run script utils network-utils
```

#### 分批部署命令

```bash
# 1. 部署 Registry（注册表）
npm run script deploy registry

# 2. 部署 Oracle 系统
npm run script deploy oracle-system

# 3. 部署奖励配置模块
npm run script deploy reward-config-modules

# 4. 部署完整的 Vault 系统
npm run script deploy vault-system

# 5. 部署 Vault Router（可选）
npm run script deploy vault-router

# 6. 部署到 Arbitrum（一键部署）
npm run script deploy arbitrum
```

#### 一键部署（推荐）

使用我们的集成部署脚本：

```bash
# 部署到 Arbitrum Sepolia
npm run script deploy arbitrum

# 或者使用完整的 Vault 系统部署
npm run script deploy vault-system
```

### 4. 典型部署依赖关系图

```mermaid
graph TD
  Registry --> AccessControlManager
  Registry --> AssetWhitelist
  Registry --> PriceOracle
  Registry --> FeeRouter
  Registry --> RewardToken
  Registry --> RewardManagerCore
  Registry --> RewardManager
  Registry --> CollateralManager
  Registry --> LendingEngine
  Registry --> HealthView
  Registry --> StatisticsView
  Registry --> GuaranteeFundManager
  Registry --> VaultStorage
  Registry --> VaultCore
  Registry --> VaultBusinessLogic
  Registry --> VaultRouter
  Registry --> VaultAdmin
  PriceOracle --> PriceUpdater
  VaultStorage --> CollateralManager
  VaultStorage --> LendingEngine
  VaultStorage --> HealthView
  VaultStorage --> StatisticsView
  VaultStorage --> FeeRouter
  VaultStorage --> RewardManager
  VaultCore --> VaultStorage
  VaultCore --> VaultBusinessLogic
```

### 5. 部署最佳实践

#### 重要提醒

- 每部署一个合约，务必记录其地址，并及时注册到 Registry
- 部署 VaultStorage 时，务必确保所有依赖模块都已部署并地址可用
- 建议每批部署后，运行一次合约初始化和权限配置脚本
- 前端集成时，使用自动生成的合约地址配置文件

#### 环境检查

部署前请确保环境配置正确：

```bash
# 检查环境变量
npm run script checks check-env

# 检查合约一致性
npm run script checks check-contract-consistency

# 运行所有检查
npm run script checks all
```

## 📍 合约地址管理

### 1. 部署记录文件

部署完成后，合约地址会保存在以下文件中：

```bash
# 查看部署记录
cat scripts/deployments/vault-system.json
```

### 2. 地址格式示例

```json
{
  "Registry": "0x...",
  "AccessControlManager": "0x...",
  "AssetWhitelist": "0x...",
  "VaultStorage": "0x...",
  "VaultCore": "0x...",
  "VaultBusinessLogic": "0x...",
  "VaultAdmin": "0x...",
  "VaultRouter": "0x...",
  "VaultModules": "0x...",
  "StatisticsView": "0x..."
}
```

### 3. 前端地址配置

创建前端配置文件 `src/config/contracts.ts`：

```typescript
export const CONTRACT_ADDRESSES = {
  // 测试网地址
  arbitrumSepolia: {
    Registry: "0x...",
    VaultCore: "0x...",
    VaultStorage: "0x...",
    // ... 其他合约地址
  },
  // 主网地址
  arbitrum: {
    Registry: "0x...",
    VaultCore: "0x...",
    VaultStorage: "0x...",
    // ... 其他合约地址
  },
};

export const NETWORK_CONFIG = {
  arbitrumSepolia: {
    chainId: 421614,
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://sepolia.arbiscan.io",
  },
  arbitrum: {
    chainId: 42161,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
  },
};
```

## 🌐 前端集成方案

### 1. 使用 Ethers.js

```typescript
// src/utils/contracts.ts
import { ethers } from "ethers";
import { CONTRACT_ADDRESSES, NETWORK_CONFIG } from "../config/contracts";

export class ContractManager {
  private provider: ethers.Provider;
  private signer: ethers.Signer;
  private contracts: Record<string, ethers.Contract> = {};

  constructor(network: "arbitrumSepolia" | "arbitrum") {
    const config = NETWORK_CONFIG[network];
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
  }

  async connectWallet() {
    if (typeof window.ethereum !== "undefined") {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      this.signer = await this.provider.getSigner();
    } else {
      throw new Error("MetaMask not found");
    }
  }

  async getContract(contractName: string, address: string, abi: any[]) {
    if (!this.contracts[contractName]) {
      this.contracts[contractName] = new ethers.Contract(
        address,
        abi,
        this.signer || this.provider,
      );
    }
    return this.contracts[contractName];
  }

  async getVaultCore() {
    const address = CONTRACT_ADDRESSES.arbitrumSepolia.VaultCore;
    // 这里需要导入 VaultCore 的 ABI
    const abi = []; // 从 typechain-types 导入
    return this.getContract("VaultCore", address, abi);
  }
}
```

### 2. 使用 React Hooks（新增 RewardView 查询示例）

```typescript
// src/hooks/useContracts.ts
import { useState, useEffect } from "react";
import { ContractManager } from "../utils/contracts";

export function useContracts() {
  const [contractManager, setContractManager] =
    useState<ContractManager | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initContracts = async () => {
      try {
        const manager = new ContractManager("arbitrumSepolia");
        await manager.connectWallet();
        setContractManager(manager);
        setIsConnected(true);
      } catch (error) {
        console.error("Failed to connect contracts:", error);
      } finally {
        setLoading(false);
      }
    };

    initContracts();
  }, []);

  return { contractManager, isConnected, loading };
}
```

### 3. React 组件示例

```typescript
// src/components/VaultInterface.tsx
import React, { useState, useEffect } from 'react';
import { useContracts } from '../hooks/useContracts';

export function VaultInterface() {
  const { contractManager, isConnected, loading } = useContracts();
  const [vaultData, setVaultData] = useState(null);

  useEffect(() => {
    if (contractManager && isConnected) {
      loadVaultData();
    }
  }, [contractManager, isConnected]);

  const loadVaultData = async () => {
    try {
      const vaultCore = await contractManager!.getVaultCore();
      // 调用合约方法获取数据
      const data = await vaultCore.getVaultInfo();
      setVaultData(data);
    } catch (error) {
      console.error('Failed to load vault data:', error);
    }
  };

  if (loading) return <div>Loading...</div>;
  if (!isConnected) return <div>Please connect your wallet</div>;

  return (
    <div>
      <h2>Vault Interface</h2>
      {/* 显示 Vault 数据 */}
    </div>
  );
}
```

## 📞 合约调用示例

### 1. 读取数据

```typescript
// 获取 Vault 信息
async function getVaultInfo() {
  const vaultCore = await contractManager.getVaultCore();
  const info = await vaultCore.getVaultInfo();
  return info;
}

// 获取用户余额（RewardView）
async function getUserBalance(userAddress: string) {
  const rewardView = await contractManager.getRewardView();
  const [balance] = await rewardView.getUserBalanceWithMeta(userAddress);
  return balance;
}

// 获取健康因子（UserView）
async function getHealthFactor(userAddress: string) {
  const userView = await contractManager.getUserView();
  const [healthFactor] = await userView.getHealthFactor(userAddress);
  return healthFactor;
}

// ===== 新增：Reward 只读统一从 RewardView 查询 =====
import { RewardView__factory } from "@/types/factories";

async function getRewardView(provider: ethers.Provider, address: string) {
  return RewardView__factory.connect(address, provider);
}

// 查询用户汇总（唯一推荐入口：RewardView）
async function getUserRewardSummary(
  viewAddr: string,
  provider: ethers.Provider,
  user: string,
) {
  const rv = await getRewardView(provider, viewAddr);
  return rv.getUserRewardSummaryWithMeta(user);
}

// 查询最近活动（block 口径过滤）
async function getUserRecentActivities(
  viewAddr: string,
  provider: ethers.Provider,
  user: string,
  fromBlock: bigint,
  toBlock: bigint,
  limit: bigint,
) {
  const rv = await getRewardView(provider, viewAddr);
  return rv.getUserRecentActivitiesWithMeta(user, fromBlock, toBlock, limit);
}

// 查询用户消费记录
async function getUserEasySpent(
  viewAddr: string,
  provider: ethers.Provider,
  user: string,
) {
  const rv = await getRewardView(provider, viewAddr);
  return rv.getUserEasySpentWithMeta(user);
}
```

### 2. 写入操作

> ⚠️ 抵押类资产的 **approve spender** 通常是 `CollateralManager`。
> 即使你的入口是 `VaultCore/VaultRouter`，也不要把 spender 错配成 `VaultCore/VaultRouter`；否则存款会因 allowance 不足而 revert。
>
> 资金链（托管者/真实去向/内部调用串联）以 Funds-Flow 为唯一权威：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`。

```typescript
// 存款
async function deposit(asset: string, amount: bigint) {
  const vaultCore = await contractManager.getVaultCore();
  const tx = await vaultCore.deposit(asset, amount);
  await tx.wait();
  return tx;
}

// 取款
async function withdraw(asset: string, amount: bigint) {
  const vaultCore = await contractManager.getVaultCore();
  const tx = await vaultCore.withdraw(asset, amount);
  await tx.wait();
  return tx;
}

// 借款（SSOT：撮合/订单化路径）
//
// ⚠️ 当前架构已**移除** `VaultCore.borrow(asset, amount)`（直达账本会绕开 orderId/费用/Reward 编排）。
// 借款必须由撮合/keeper 走（推荐：订单化撮合主路径），并在内部完成债务账本写入与订单创建（orderId 为 SSOT，由 ORDER_ENGINE 生成/管理）。
// 资金链与内部调用串联请以 Funds-Flow 文档为唯一权威（本集成文档不复述）：
//   `docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`
//
// 前端通常只负责：
// - borrower/lenderSigner 的意向签名（EIP-712）
// - 展示撮合结果与 orderId
// - 还款时携带 orderId 调用 `VaultCore.repay(orderId, ...)`

/**
 * ===========================
 * termBlocks SSOT（按区块期限）撮合签名要点
 * ===========================
 *
 * 对齐文档：
 * - `docs/Usage-Guide/Time-Dependency-Refactor-Guide.md` 的 “termBlocks SSOT 完整迁移：Matchflow / Intent / Guarantee”
 *
 * 核心结论（必须）：
 * - termDays 仅可作为 UX bucket（legacy）；**签名与撮合必须使用 termBlocks**
 * - `expireAt` 字段名保留，但语义是 **expireBlock**（block.number），不是 unix timestamp
 * - EIP-712 verifyingContract 必须是 **VaultBusinessLogic 地址**（撮合入口），不是 library 地址
 *
 * EIP-712 结构体（字段顺序强约束；与 `SettlementIntentLib` 保持一致）：
 * - BorrowIntentBlocks: borrower, collateralAsset, collateralAmount, borrowAsset, amount, termBlocks, rateBps, expireAt, salt
 * - LendIntentBlocks: lenderSigner, asset, amount, minTermBlocks, maxTermBlocks, minRateBps, expireAt, salt
 *
 * 对齐 `SettlementIntentLib` 的 type string（用于 struct hash；必须一字不差）：
 * - BorrowIntentBlocks(address borrower,address collateralAsset,uint256 collateralAmount,address borrowAsset,uint256 amount,uint256 termBlocks,uint256 rateBps,uint256 expireAt,bytes32 salt)
 * - LendIntentBlocks(address lenderSigner,address asset,uint256 amount,uint256 minTermBlocks,uint256 maxTermBlocks,uint256 minRateBps,uint256 expireAt,bytes32 salt)
 *
 * termBlocks 显式映射（SSOT，示例；以链上 TermBlocksLib 为准）：
 * - 5d => 36000, 10d => 72000, 15d => 108000, 30d => 216000, 60d => 432000, 90d => 648000, 180d => 1296000, 360d => 2592000
 *
 * 重要（生产推荐）：
 * - termBlocks 的 SSOT 应来自链下 “TermBlocks 映射快照”（可按日校正、带版本），前端不要自行用“秒/天”推导。
 * - TermBlocksLib 的表仅作为 baseline/兼容参考；blocks-term intent 的 termBlocks 以快照为准，并被签名固化。
 */

// 可复制示例：ethers v6 生成 blocks-term digest 并签名（仅展示核心）
//
// import { ethers } from "ethers";
// const domain = {
//   name: "RwaLending",
//   version: "1",
//   chainId: await signer.provider!.getNetwork().then(n => n.chainId),
//   verifyingContract: vaultBusinessLogicAddr, // 关键：撮合入口
// };
//
// const types = {
//   BorrowIntentBlocks: [
//     { name: "borrower", type: "address" },
//     { name: "collateralAsset", type: "address" },
//     { name: "collateralAmount", type: "uint256" },
//     { name: "borrowAsset", type: "address" },
//     { name: "amount", type: "uint256" },
//     { name: "termBlocks", type: "uint256" },
//     { name: "rateBps", type: "uint256" },
//     { name: "expireAt", type: "uint256" }, // 语义：expireBlock
//     { name: "salt", type: "bytes32" },
//   ],
//   LendIntentBlocks: [
//     { name: "lenderSigner", type: "address" },
//     { name: "asset", type: "address" },
//     { name: "amount", type: "uint256" },
//     { name: "minTermBlocks", type: "uint256" },
//     { name: "maxTermBlocks", type: "uint256" },
//     { name: "minRateBps", type: "uint256" },
//     { name: "expireAt", type: "uint256" }, // 语义：expireBlock
//     { name: "salt", type: "bytes32" },
//   ],
// };
//
// 推荐：直接用 signTypedData（EIP-712 标准签名；合约侧 recover(digest, sig) 即可验证）
// const sigBorrower = await borrowerSigner.signTypedData(domain, types, borrowIntentBlocks);
//
// const sigLender = await lenderSigner.signTypedData(domain, types, lendIntentBlocks);
//
// 如需“可复现/可审计”的 digest（用于日志/排障/对账），再计算：
// const borrowDigest = ethers.TypedDataEncoder.hash(domain, types, borrowIntentBlocks);
// const lendDigest = ethers.TypedDataEncoder.hash(domain, types, lendIntentBlocks);
//
// ⚠️ reserve/cancel/consume 使用的是 “struct hash”（不是 digest）：
// - borrowStructHash = keccak256(abi.encode(typeHashBorrow, ...fields))
// - lendStructHash   = keccak256(abi.encode(typeHashLend, ...fields))
//
// ethers v6 可直接用 ABI 编码复现（示例：lendStructHash）：
// const typeHashLend = ethers.keccak256(ethers.toUtf8Bytes(
//   "LendIntentBlocks(address lenderSigner,address asset,uint256 amount,uint256 minTermBlocks,uint256 maxTermBlocks,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
// ));
// const lendStructHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
//   ["bytes32","address","address","uint256","uint256","uint256","uint256","uint256","bytes32"],
//   [typeHashLend, lendIntentBlocks.lenderSigner, lendIntentBlocks.asset, lendIntentBlocks.amount, lendIntentBlocks.minTermBlocks, lendIntentBlocks.maxTermBlocks, lendIntentBlocks.minRateBps, lendIntentBlocks.expireAt, lendIntentBlocks.salt]
// ));

// 还款/结算（legacy / 通用订单入口：SettlementManager 由 VaultCore 代为转入并调用）
async function repay(orderId: bigint, debtAsset: string, amount: bigint) {
  // 注意：repay 的 approve spender 是 VaultCore（VaultCore 会转入结算入口处理；资金链细节见 Funds-Flow SSOT）
  // await ERC20(debtAsset).approve(vaultCoreAddr, amount)
  const vaultCore = await contractManager.getVaultCore();
  const tx = await vaultCore.repay(orderId, debtAsset, amount);
  await tx.wait();
  return tx;
}

// 清算/处置（keeper/机器人入口，legacy / 通用订单 SSOT）
async function settleOrLiquidate(orderId: bigint) {
  // 这个 helper 只适用于 legacy / 通用 ORDER_ENGINE 订单。
  // 对 blocks-only 订单，keeper 默认入口应改为
  // BlocksOnlyCoordinator.settleOrLiquidateBlocks(orderId)。
  // 约束：调用者必须具备 ACTION_LIQUIDATE 权限；且 keeper/liquidator 必须与 borrower 不同（否则会因权限/接收者约束而被拒绝）
  //
  // ActionKey（与 src/constants/ActionKeys.sol 对齐）：
  //   bytes32 ACTION_LIQUIDATE = keccak256("LIQUIDATE")
  //
  // 推荐做法：先检查 role，再调用入口，避免链上无意义 revert。
  const provider = contractManager.provider; // 你们的 provider/Signer 管理方式不同的话，请按项目实际改造
  const keeperSigner = contractManager.signer; // keeper 钱包对应的 signer（机器人/多签执行器）

  const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATE"));

  // 通过 Registry 拿 SettlementManager 地址（避免写死地址）
  const registry = await contractManager.getRegistry();
  const settlementManagerAddr: string = await registry.getModule(
    ethers.keccak256(ethers.toUtf8Bytes("SETTLEMENT_MANAGER")),
  );
  if (!settlementManagerAddr || settlementManagerAddr === ethers.ZeroAddress) {
    throw new Error("Registry missing SETTLEMENT_MANAGER");
  }

  const acm = await contractManager.getAccessControlManager();
  const has = await acm.hasRole(
    ACTION_LIQUIDATE,
    await keeperSigner.getAddress(),
  );
  if (!has) {
    throw new Error(
      `MissingRole(): keeper lacks ACTION_LIQUIDATE (${ACTION_LIQUIDATE}). ` +
        `Ask admin to grant this role to keeper.`,
    );
  }

  const settlementManager = new ethers.Contract(
    settlementManagerAddr,
    ["function settleOrLiquidate(uint256 orderId) external"],
    keeperSigner,
  );
  const tx = await settlementManager.settleOrLiquidate(orderId);
  await tx.wait();
  return tx;
}
```

> 🧪 本地快速排障（推荐）：见 `docs/Usage-Guide/Funds-Flow-Architecture-Guide.md` 的 “本地一键 Smoke”。
> 它会检查 Registry 注册/连线，并对 `MissingRole()` / `SettlementManager__NotLiquidatable()` 做精准解码与修复提示。

### 3. 事件监听

```typescript
// 监听存款事件
async function listenToDepositEvents() {
  const vaultCore = await contractManager.getVaultCore();

  vaultCore.on("Deposit", (user, amount, blockNumber) => {
    console.log(`User ${user} deposited ${amount} at block ${blockNumber}`);
    // 更新 UI
  });
}

// 监听借款事件
async function listenToBorrowEvents() {
  const vaultCore = await contractManager.getVaultCore();

  vaultCore.on("Borrow", (user, amount, blockNumber) => {
    console.log(`User ${user} borrowed ${amount} at block ${blockNumber}`);
    // 更新 UI
  });
}
```

## 🧪 测试和验证

### 1. 使用我们的测试脚本

```bash
# 运行集成测试
npm run script test integration

# 测试 Oracle 系统
npm run script test oracle-system

# 运行健康因子统计
npm run script test health-factor-stats
```

### 2. 创建测试账户

```bash
# 创建测试账户
npm run script test create-accounts

# 查看测试账户使用示例
npm run script test test-accounts-usage
```

### 3. 前端测试

```typescript
// src/tests/contracts.test.ts
import { ContractManager } from "../utils/contracts";

describe("Contract Integration Tests", () => {
  let contractManager: ContractManager;

  beforeEach(async () => {
    contractManager = new ContractManager("arbitrumSepolia");
    await contractManager.connectWallet();
  });

  test("should connect to VaultCore contract", async () => {
    const vaultCore = await contractManager.getVaultCore();
    expect(vaultCore).toBeDefined();
  });

  test("should get vault info", async () => {
    const vaultCore = await contractManager.getVaultCore();
    const info = await vaultCore.getVaultInfo();
    expect(info).toBeDefined();
  });
});
```

## 🚀 生产环境部署

### 1. 主网部署

```bash
# 部署到 Arbitrum 主网
npm run script deploy arbitrum

# 验证合约
npm run script utils verification-utils
```

### 2. 前端生产配置

```typescript
// src/config/production.ts
export const PRODUCTION_CONFIG = {
  network: "arbitrum",
  rpcUrl: process.env.REACT_APP_ARBITRUM_RPC_URL,
  contracts: CONTRACT_ADDRESSES.arbitrum,
};
```

### 3. 监控和日志

```bash
# 运行性能监控
npm run script utils performance-monitor

# 运行监控工具
npm run script utils monitoring-utils
```

## 🔍 模块键解码与前端配合

### 1. 背景说明

为了优化 gas 成本，我们的智能合约在事件中直接使用 `bytes32` 格式的模块键，而不是转换为可读字符串。前端需要配合进行解码以提供友好的用户体验。

### 2. 模块键解码器

#### 2.1. 创建解码工具

```typescript
// utils/moduleKeyDecoder.ts
export class ModuleKeyDecoder {
  // 模块键映射表（与合约中的 ModuleKeys.sol 保持一致）
  private static readonly MODULE_KEYS = {
    "0x5641554c545f434f524500000000000000000000000000000000000000000000":
      "VAULT_CORE",
    "0x4c49515549444154494f4e5f4d414e4147455200000000000000000000000000":
      "LIQUIDATION_MANAGER",
    "0x50524943455f4f5241434c450000000000000000000000000000000000000000":
      "PRICE_ORACLE",
    "0x5245574152445f4d414e4147455200000000000000000000000000000000000000":
      "REWARD_MANAGER",
    "0x474f5645524e414e43455f4d414e414745520000000000000000000000000000":
      "GOVERNANCE_MANAGER",
    // 添加更多模块键...
  };

  /**
   * 将 bytes32 模块键转换为可读字符串
   */
  static decodeModuleKey(key: string): string {
    return (
      this.MODULE_KEYS[key.toLowerCase()] ||
      `UNKNOWN_MODULE_${key.slice(0, 10)}`
    );
  }

  /**
   * 批量解码模块键
   */
  static decodeModuleKeys(keys: string[]): string[] {
    return keys.map((key) => this.decodeModuleKey(key));
  }

  /**
   * 安全解码模块键，处理未知键
   */
  static safeDecodeModuleKey(key: string): { name: string; isKnown: boolean } {
    const name = this.decodeModuleKey(key);
    const isKnown = !name.startsWith("UNKNOWN_MODULE_");

    return {
      name: isKnown ? name : `未知模块 (${key.slice(0, 10)}...)`,
      isKnown,
    };
  }

  /**
   * 获取所有已知模块键
   */
  static getKnownModuleKeys(): string[] {
    return Object.values(this.MODULE_KEYS);
  }
}
```

### 4. 注册表解析优先策略与注意事项（强烈推荐）

> 前端地址解析应以 Registry 为“单一真实来源（SSoT）”，避免硬编码地址或从零散事件推断地址。以下为实践要点与与其它策略的对比说明。

#### 4.1 注册表解析（推荐方案）

- 核心思路：使用 `Registry.getModule(bytes32 key)`/`getModuleOrRevert` 解析模块地址，模块键使用与链上 `ModuleKeys.sol` 完全一致的 UPPER_SNAKE 字符串的 `keccak256` 值。
- 生成 KEY（前端示例）：

```typescript
import { keccak256, toUtf8Bytes } from "ethers";

// 通过 UPPER_SNAKE 生成 bytes32 模块键
const KEY_REWARD_MANAGER = keccak256(toUtf8Bytes("REWARD_MANAGER"));
const KEY_VAULT_CORE = keccak256(toUtf8Bytes("VAULT_CORE"));

// 解析模块地址
const rewardManagerAddr = await registry.getModule(KEY_REWARD_MANAGER);
const vaultCoreAddr = await registry.getModule(KEY_VAULT_CORE);
```

- 事件订阅：监听 `ModuleAddressUpdated`，发生变更时刷新前端缓存（参考上文 `useRegistryEvents`）。
- 建议在前端建立一个与后端一致的 KEY 生成工具（与后端 `scripts/deploy/moduleKeys.ts` 对齐）。

#### 4.2 与其它策略的对比

| 策略                                                       | 优点                                   | 缺点                     | 适用场景                  |
| ---------------------------------------------------------- | -------------------------------------- | ------------------------ | ------------------------- |
| 注册表解析（本方案）                                       | 动态、权威、可监听升级；与链上治理一致 | 需要维护 KEY 生成与解码  | 生产环境、长期维护        |
| 本地/构建时地址配置（如 `frontend-config/contracts-*.ts`） | 上手快、无需链上读取                   | 易过期；多环境管理成本高 | 开发期兜底、离线/灰度环境 |
| 事件推断地址（非注册表事件）                               | 可快速试验                             | 来源不统一、容易不完整   | 调研阶段，不建议上线      |

结论：前端应“以注册表解析为主”，地址配置文件可作为“冷启动兜底”。应用启动后以 Registry 地址解析结果覆盖本地配置。

#### 4.3 关键实现细节

- 与链上常量对齐：KEY 必须与 `contracts/constants/ModuleKeys.sol` 完全一致（UPPER_SNAKE → `keccak256(toUtf8Bytes(name))`），避免大小写或空格导致解析失败。
- 小写规范：事件监听时建议将 bytes32 转为小写字符串再比对（文档示例的解码器已处理）。
- 视图与只读入口：
  - `REWARD_VIEW`：统一 Reward 只读与 DataPush 入口，查询 0 gas；
  - `VAULT_CORE`：后续如需“由 Core 解析 View 地址”的路径，可通过 `KEY_VAULT_CORE → VaultCore.viewContractAddrVar()`；
  - `VAULT_STATISTICS (KEY_STATS)`：迁移阶段指向 `StatisticsView`（只读聚合）。不要使用 `STATISTICS_VIEW` 作为注册键（非 canonical）。
- 多环境与热更新：
  - 首屏可读取 `frontend-config/contracts-*.ts` 作为初值，随后立即用 Registry 解析结果更新状态；
  - 监听 `ModuleAddressUpdated` 保持前端地址热更新；
  - 本地开发若未部署 Mock，确保组件对缺失模块地址具备降级处理（例如隐藏相关功能）。

#### 4.4 前后端 KEY 对齐建议

- 后端已提供 `scripts/deploy/moduleKeys.ts`（集中 KEY 常量与 `key/keyOf` 工具），前端可创建等价的 `utils/moduleKeys.ts`：

```typescript
import { keccak256, toUtf8Bytes } from "ethers";

export const MODULE_KEYS = {
  REWARD_MANAGER: "REWARD_MANAGER",
  REWARD_VIEW: "REWARD_VIEW",
  VAULT_CORE: "VAULT_CORE",
  LENDING_ENGINE: "LENDING_ENGINE",
  // ... 按需补全，与后端保持一致
} as const;

export type ModuleKeyName = keyof typeof MODULE_KEYS;
export const key = (name: ModuleKeyName) =>
  keccak256(toUtf8Bytes(MODULE_KEYS[name]));
```

这样可以避免多处散落硬编码，确保与链上注册键一致。

#### 2.2. 性能优化版本

```typescript
// utils/moduleKeyDecoder.ts (带缓存)
export class ModuleKeyDecoder {
  private static readonly MODULE_KEYS = {
    // ... 模块键映射
  };

  private static cache = new Map<string, string>();

  static decodeModuleKey(key: string): string {
    const normalizedKey = key.toLowerCase();

    if (this.cache.has(normalizedKey)) {
      return this.cache.get(normalizedKey)!;
    }

    const result =
      this.MODULE_KEYS[normalizedKey] || `UNKNOWN_MODULE_${key.slice(0, 10)}`;
    this.cache.set(normalizedKey, result);

    return result;
  }

  /**
   * 清除缓存
   */
  static clearCache(): void {
    this.cache.clear();
  }
}
```

### 3. 事件监听和解码

#### 3.1. 创建事件监听器

```typescript
// hooks/useRegistryEvents.ts
import { ethers } from "ethers";
import { ModuleKeyDecoder } from "../utils/moduleKeyDecoder";

export const useRegistryEvents = (registryContract: ethers.Contract) => {
  const listenToModuleUpdates = (callback: (event: any) => void) => {
    registryContract.on(
      "ModuleAddressUpdated",
      (
        key: string,
        oldAddr: string,
        newAddr: string,
        blockNumber: number,
        event: any,
      ) => {
        // 解码模块键
        const moduleName = ModuleKeyDecoder.decodeModuleKey(key);

        const decodedEvent = {
          moduleKey: key,
          moduleName, // 解码后的可读名称
          oldAddress: oldAddr,
          newAddress: newAddr,
          blockNumber,
          transactionHash: event.transactionHash,
        };

        callback(decodedEvent);
      },
    );
  };

  const listenToBatchUpdates = (callback: (events: any[]) => void) => {
    registryContract.on(
      "BatchModuleChanged",
      (
        keys: string[],
        oldAddresses: string[],
        newAddresses: string[],
        executor: string,
        event: any,
      ) => {
        const decodedEvents = keys.map((key, index) => ({
          moduleKey: key,
          moduleName: ModuleKeyDecoder.decodeModuleKey(key),
          oldAddress: oldAddresses[index],
          newAddress: newAddresses[index],
          executor,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        }));

        callback(decodedEvents);
      },
    );
  };

  return { listenToModuleUpdates, listenToBatchUpdates };
};
```

#### 3.2. React 组件示例

```typescript
// components/ModuleUpdateHistory.tsx
import React, { useState, useEffect } from 'react';
import { useRegistryEvents } from '../hooks/useRegistryEvents';

interface ModuleUpdateEvent {
  moduleKey: string;
  moduleName: string;
  oldAddress: string;
  newAddress: string;
  blockNumber: number;
  transactionHash: string;
}

export const ModuleUpdateHistory: React.FC = () => {
  const [events, setEvents] = useState<ModuleUpdateEvent[]>([]);
  const { listenToModuleUpdates } = useRegistryEvents(registryContract);

  useEffect(() => {
    const handleModuleUpdate = (event: ModuleUpdateEvent) => {
      setEvents(prev => [event, ...prev]);
    };

    listenToModuleUpdates(handleModuleUpdate);
  }, []);

  return (
    <div>
      <h3>模块更新历史</h3>
      {events.map((event, index) => (
        <div key={index} className="event-card">
          <div className="module-name">
            <strong>{event.moduleName}</strong>
            <span className="module-key">({event.moduleKey.slice(0, 10)}...)</span>
          </div>
          <div className="address-change">
            <span className="old-addr">旧地址: {event.oldAddress}</span>
            <span className="arrow">→</span>
            <span className="new-addr">新地址: {event.newAddress}</span>
          </div>
          <div className="metadata">
            <span>区块: {event.blockNumber}</span>
            <a href={`https://arbiscan.io/tx/${event.transactionHash}`} target="_blank">
              查看交易
            </a>
          </div>
        </div>
      ))}
    </div>
  );
};
```

### 4. 配置管理

#### 4.1. 模块键配置文件

```typescript
// config/moduleKeys.ts
export const MODULE_KEYS_CONFIG = {
  // 从合约中提取的模块键映射
  VAULT_CORE:
    "0x5641554c545f434f524500000000000000000000000000000000000000000000",
  LIQUIDATION_MANAGER:
    "0x4c49515549444154494f4e5f4d414e4147455200000000000000000000000000",
  PRICE_ORACLE:
    "0x50524943455f4f5241434c450000000000000000000000000000000000000000",
  REWARD_MANAGER:
    "0x5245574152445f4d414e4147455200000000000000000000000000000000000000",
  GOVERNANCE_MANAGER:
    "0x474f5645524e414e43455f4d414e414745520000000000000000000000000000",
  // ... 更多模块键
} as const;

// 反向映射
export const MODULE_KEYS_REVERSE = Object.entries(MODULE_KEYS_CONFIG).reduce(
  (acc, [name, key]) => {
    acc[key.toLowerCase()] = name;
    return acc;
  },
  {} as Record<string, string>,
);
```

#### 4.2. 工具函数

```typescript
// utils/registryUtils.ts
export const registryUtils = {
  /**
   * 格式化模块地址显示
   */
  formatModuleAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  },

  /**
   * 检查地址是否为零地址
   */
  isZeroAddress(address: string): boolean {
    return address === "0x0000000000000000000000000000000000000000";
  },

  /**
   * 获取模块状态描述
   */
  getModuleStatus(oldAddr: string, newAddr: string): string {
    if (this.isZeroAddress(oldAddr)) return "新增模块";
    if (this.isZeroAddress(newAddr)) return "移除模块";
    return "更新模块";
  },

  /**
   * 验证模块键格式
   */
  isValidModuleKey(key: string): boolean {
    return /^0x[a-fA-F0-9]{64}$/.test(key);
  },
};
```

### 5. 错误处理和调试

#### 5.1. 错误处理

```typescript
// utils/moduleKeyDecoder.ts
export class ModuleKeyDecoder {
  // ... 现有代码 ...

  /**
   * 调试模式解码
   */
  static debugDecodeModuleKey(key: string): {
    name: string;
    originalKey: string;
    normalizedKey: string;
    isKnown: boolean;
    cacheHit: boolean;
  } {
    const normalizedKey = key.toLowerCase();
    const cacheHit = this.cache.has(normalizedKey);
    const name = this.decodeModuleKey(key);
    const isKnown = !name.startsWith("UNKNOWN_MODULE_");

    return {
      name,
      originalKey: key,
      normalizedKey,
      isKnown,
      cacheHit,
    };
  }
}
```

#### 5.2. 调试工具

```typescript
// utils/debugUtils.ts
export const debugUtils = {
  /**
   * 打印模块键解码信息
   */
  logModuleKeyDecode(key: string): void {
    const debug = ModuleKeyDecoder.debugDecodeModuleKey(key);
    console.log("Module Key Decode Debug:", debug);
  },

  /**
   * 验证模块键映射完整性
   */
  validateModuleKeyMapping(): void {
    const knownKeys = ModuleKeyDecoder.getKnownModuleKeys();
    console.log("Known Module Keys:", knownKeys);

    // 检查是否有重复的键
    const keySet = new Set(knownKeys);
    if (keySet.size !== knownKeys.length) {
      console.warn("Duplicate module keys detected!");
    }
  },
};
```

### 6. 最佳实践

#### 6.1. 性能优化

1. **使用缓存**：避免重复解码相同的模块键
2. **批量处理**：对于大量事件，使用批量解码
3. **懒加载**：只在需要时进行解码

#### 6.2. 用户体验

1. **显示原始键**：在界面上同时显示解码后的名称和原始键
2. **未知模块处理**：优雅处理未知的模块键
3. **加载状态**：在解码过程中显示加载状态

#### 6.3. 维护性

1. **同步更新**：当合约中的模块键发生变化时，及时更新前端映射
2. **版本管理**：为模块键映射添加版本控制
3. **自动化测试**：编写测试确保解码器正确工作

## 📝 最佳实践

### 1. 错误处理

```typescript
async function safeContractCall(contractCall: () => Promise<any>) {
  try {
    return await contractCall();
  } catch (error) {
    if (error.code === "ACTION_REJECTED") {
      throw new Error("Transaction was rejected by user");
    } else if (error.code === "INSUFFICIENT_FUNDS") {
      throw new Error("Insufficient funds for transaction");
    } else {
      throw new Error(`Contract call failed: ${error.message}`);
    }
  }
}
```

### 2. Gas 优化

```typescript
// 估算 Gas 费用
async function estimateGas(
  contract: ethers.Contract,
  method: string,
  ...args: any[]
) {
  try {
    const gasEstimate = await contract[method].estimateGas(...args);
    return gasEstimate;
  } catch (error) {
    console.error("Gas estimation failed:", error);
    throw error;
  }
}
```

### 3. 状态管理

```typescript
// 使用 React Context 管理合约状态
const ContractContext = React.createContext<ContractManager | null>(null);

export function ContractProvider({ children }: { children: React.ReactNode }) {
  const [contractManager, setContractManager] = useState<ContractManager | null>(null);

  useEffect(() => {
    const initContracts = async () => {
      const manager = new ContractManager('arbitrumSepolia');
      await manager.connectWallet();
      setContractManager(manager);
    };

    initContracts();
  }, []);

  return (
    <ContractContext.Provider value={contractManager}>
      {children}
    </ContractContext.Provider>
  );
}
```

## 🔗 相关资源

- [智能合约标准文档](./SmartContractStandard.md)
- [脚本系统升级报告](./SCRIPTS_SYSTEM_UPGRADE.md)
- [Hardhat 配置文档](https://hardhat.org/docs)
- [Ethers.js 文档](https://docs.ethers.org/)
- [Arbitrum 文档](https://developer.arbitrum.io/)
- [AI Credits 计费规范（按次计费）](./Usage-Guide/AI-Credits-Billing-Guide.md)

## 🎯 总结

通过以上步骤，你可以：

1. **部署智能合约**到测试网
2. **管理合约地址**和配置
3. **集成前端应用**与合约交互
4. **测试和验证**功能
5. **部署到生产环境**

使用我们的脚本系统可以大大简化部署和测试流程，提高开发效率！

---

**下一步建议**：

1. 先部署到 Arbitrum Sepolia 测试网
2. 使用我们的测试脚本验证功能
3. 开发前端界面并集成合约调用
4. 进行充分测试后部署到主网

## 🔄 VaultRouter 协调器接口（简化版 2025-08）

> ⚠️ 重要说明：根据 `docs/Architecture-Guide.md` 及视图模块拆分方案，从 2025-08 起 `VaultRouter` 不再承担任何读操作，也不再缓存业务数据。所有查询均由 `UserView`、`SystemView`、`AccessControlView`、`ViewCache` 等子模块提供。前端集成应遵循以下约定：

### 1. 只写不读

- `VaultRouter` 仅对外暴露 **4 个写入/路由函数**，全部为 `non-view` 调用：
  | 函数 | 调用方(合约) | 说明 |
  | --- | --- | --- |
  | `processUserOperation(user, operationType, asset, amount, blockNumber)` | 前端 → 业务合约（转发） | 用户发起的 DEPOSIT / BORROW / REPAY / WITHDRAW 操作由前端直接调用业务模块；同时业务模块应调用本函数写链上事件，供离线索引与监听。 |
  | `pushUserPositionUpdate(user, asset, collateral, debt)` | CollateralManager / LendingEngine | 业务模块更新完抵押/债务后推送最新快照；前端 **不会** 直接调用。 |
  | `HealthView.pushRiskStatus(user, hfBps, minHFBps, under, blockNumber)` | LendingEngine / LiquidationRiskManager 等 | 健康因子/风险状态推送；前端不调用（best-effort + 链下重试）。 |
  | `pushAssetStatsUpdate(asset, totalCollateral, totalDebt, price)` | VaultStatistics | 资产聚合数据推送；前端不调用。 |

### 2. 前端应调用的查询接口

- **用户数据**：`UserView` ⇒ `getUserPositionWithMeta`, `getHealthFactorWithMeta`, `getUserStats`, `previewBorrow/Deposit/...` 等。
- **系统数据（更新）**：
  - `ValuationOracleView` ⇒ `getAssetPrice/getAssetPrices/isPriceValid`（价格/预言机，返回 [price, blockNumber]）
  - `HealthView` ⇒ `getUserHealthFactorWithMeta/batchGetHealthFactors`；系统健康/降级读取由 `HealthView` 提供
  - `SystemRiskView` ⇒ `getLiquidationThreshold/getMinHealthFactor`（system-only 风险参数；**公开只读**）
  - `StatisticsView` ⇒ 全局统计聚合
  - `BatchView` ⇒ `batchGetAssetPrices/batchGetModuleHealth` 等批量查询
  - `RegistryView` ⇒ 模块键枚举/反查/分页
  - `SystemView` ⇒ **系统级只读聚合门面（推荐可选）**：用于“一次性系统总览查询/兼容旧调用”。对性能敏感或需要更细粒度数据时，仍建议直接调用上述专属 View。
- **清算数据（更新）**：`LiquidatorView` ⇒ `getLiquidatorProfitView`, `getGlobalLiquidationView`, `batchGetLiquidatorProfitViews`, `getLiquidatorLeaderboard`, `getLiquidatorTempDebt`, `getLiquidatorProfitRate`。
- **权限数据**：`AccessControlView` ⇒ `getUserPermissionWithMeta`, `getUserPermissionLevelWithMeta` 等。
- **系统级快照(可选)**：`ViewCache` ⇒ `getSystemStatus` / `batchGetSystemStatus`。
  （用户维度缓存已并入 `UserView`，前端无需单独调用 ViewCache 获取用户缓存。）

### 2.1 View 层与前端结合：方式、方法与 MUST 约束（2026-01）

> 目标：把 “View 层是前端读接口 SSOT” 这件事落到工程实践，避免出现：
>
> - 地址漂移（Registry 与 SystemView 路由不一致）
> - 权限口径不一致（同类数据走不同入口行为不同）
> - 批量接口超限/OOG
> - 缓存陈旧但 UI 无提示
> - push 失败不可观测、不可重试

#### 2.1.1 地址发现：Registry 为 SSOT，SystemView 为“可选路由表”（推荐组合）

- **推荐做法（启动时）**：
  - 用 `Registry.getModuleOrRevert(key)` 解析每个专属 View 的地址（SSOT）
  - 同时调用 `SystemView.route*()` 做一次 **Preflight 对齐校验**（路由表可消费、且与 Registry 完全一致）
  - 对每个 View 读取 `getVersionInfo()`（用于升级排障：api/schema/implementation）

> 仓库已提供可复用的“Preflight 参考实现”：`scripts/e2e/utils/view-preflight.ts`（前端/后端可按同思路实现）。

#### 2.1.2 权限（Read Gate）：前端必须按 `VIEW_*_DATA` 口径设计调用链

多数 View 读接口是 **role-gated** 的（典型错误为 `MissingRole()`）。你有两种可落地的集成方案：

- **方案 A（推荐）：前端 → 后端 Read Service（持有角色）→ 链上 View**
  - **优点**：用户无需链上授予权限；可统一做缓存、限流、批量合并、错误归一化；适配隐私/运维接口
  - **缺点**：需要额外的后端服务与密钥管理
  - **适用**：生产环境默认选项

- **方案 B：前端直连链上 View（为每个用户授予角色）**
  - **优点**：去中心化/无后端依赖
  - **缺点**：需要为每个用户地址单独 grant；用户换钱包/多端同步成本高；不适合大规模用户
  - **适用**：内部工具、少量白名单用户

#### 2.1.2.1 权限 Preflight（可复制；推荐前端/后端都实现）

目标：在发起大量 `eth_call` 之前，先判断“当前调用方（钱包或后端 Read Service）是否具备读取能力”，并把“权限缺失/缓存未就绪”的状态以产品语义展示给用户。

**推荐数据源：`AccessControlView`（权限缓存）**

- `AccessControlView` 提供 user-dim 权限缓存读取（Scheme U：self read 允许；非 self 需要 `VIEW_USER_DATA/ADMIN`）。
- 返回值包含 `isValid/blockNumber`（缓存 TTL 以 `ViewConstants.CACHE_DURATION` 为准），前端需按 meta 语义降级处理。

可复制代码（ethers v6 + TypeChain）：

```ts
import { AccessControlView__factory } from "@/types/factories";
import { ActionKeys } from "@/types/ActionKeys"; // 由类型生成或手工维护 bytes32 常量

export async function preflightPermissions(
  provider: any,
  accessControlViewAddr: string,
) {
  const signer = await provider.getSigner();
  const caller = await signer.getAddress();

  const acv = AccessControlView__factory.connect(
    accessControlViewAddr,
    provider,
  );

  // 只检查“当前调用方自己的权限位”：self-read 永远允许，不会因为 Scheme U 被拒绝。
  const [canViewUser, userMetaValid] = await Promise.all([
    acv.getUserPermissionWithMeta(caller, ActionKeys.ACTION_VIEW_USER_DATA),
    acv.getUserPermissionWithMeta(caller, ActionKeys.ACTION_VIEW_SYSTEM_DATA),
  ]);

  // 统一 meta 口径：isValid=false 视为“未知”，UI 应提示“权限缓存尚未就绪/可能延迟”
  return {
    caller,
    canViewUserData: canViewUser[0],
    canViewSystemData: userMetaValid[0],
    // 注意：tuple 为 (hasPermission, isValid, blockNumber)
    meta: {
      userData: { isValid: canViewUser[1], blockNumber: canViewUser[2] },
      systemData: { isValid: userMetaValid[1], blockNumber: userMetaValid[2] },
    },
  };
}
```

> 实操建议：
>
> - 若 `AccessControlView` meta `isValid=false`：先提示“权限缓存未就绪”，并在真正调用 View 时依然捕获 `MissingRole()` 做兜底。
> - 生产推荐走“方案 A（后端 Read Service）”：前端 preflight 只用于 UI 告知“当前钱包直连是否可用”，避免误导。

#### 2.1.2.2 价格 Preflight（新增，前端必须实现）

价格相关 UI 在放开借贷、健康度、LTV、清算提示之前，至少要检查两类状态：

1. 链上最终价是否可读、是否仍有效
2. 链下 publish status 是否为最新成功状态

推荐产品语义：

1. `chainPriceReadable=true` 且 `publishStatus=ok`：正常展示
2. `chainPriceReadable=true` 但 `publishStatus=missing|lagging`：展示“链上价格已写入，但链下发布状态未确认”
3. `chainPriceReadable=false`：直接禁止任何依赖价格的交易决策 UI

前端不应再把“链上能读到 price”单独当作价格系统完全健康的充分条件。

前端需要明确知道（并在 UI 中处理）以下只读权限键（见 `src/constants/ActionKeys.sol`）：

- `VIEW_USER_DATA`：用户私域（Position/User/Preview/RiskView（user-scope）等；Scheme U）
- `VIEW_RISK_DATA`：风险/健康的**系统级/运维侧**读权限（HealthView system APIs、Liquidation/Risk 运维视图等）
- `VIEW_PRICE_DATA`：价格（ValuationOracleView/BatchView prices 等）
- `VIEW_SYSTEM_DATA`：系统级信息（SystemView/RegistryView/RewardView system stats 等）
  > 说明：`SystemRiskView` 的 system-only 风险参数默认公开只读（不要求 `VIEW_RISK_DATA`）。
  > 说明：`RewardView.getSystemRewardStats*` 为 system-only 读取，需 `VIEW_SYSTEM_DATA` 或 `ACTION_ADMIN`。

> **强制要求**：同一类数据，无论走“聚合器入口”还是“专属 View 入口”，权限行为必须一致（见 `scripts/e2e/e2e-localhost-batch-aggregators-acceptance.ts` 的验收口径）。

#### 2.1.3 三类聚合器：Dashboard / CacheOptimized / Batch 的“分工”与前端推荐用法

- **DashboardView（UI 聚合 + meta）**
  - 适合：用户资产总览页、资产 breakdown 卡片、需要 `positionIsValid/blockNumber/version` 的 UI
  - 典型调用：`getUserOverviewWithMeta(user, trackedAssets[])`、`getUserAssetBreakdownWithMeta(user, assets[])`

- **CacheOptimizedView（批量 + 最少 RPC 次数）**
  - 适合：多用户/多资产列表页、监控面板、一次性拉取 `(user,asset)` 组合
  - 典型调用：`batchGetUserPositionsWithMeta(users[], assets[])`、`getSystemStats()`

- **BatchView（轻量 batch：risk/price/system-status）**
  - 适合：批量 healthFactor、批量风险评估（含 meta）、批量价格、模块健康/系统降级历史
  - 典型调用：`batchGetHealthFactors(users[])`、`batchGetRiskAssessments(users[])`、`batchGetAssetPrices(assets[])`

#### 2.1.4 有效性字段（meta）是“产品需求”：UI 必须展示/处理 `isValid/blockNumber/version`

对前端来说，`isValid/blockNumber/version` 不是“调试信息”，而是**是否可信/是否陈旧**的产品语义：

- **当 `isValid=false`**：
  - UI 必须提示“数据可能延迟/陈旧”，并显示 `blockNumber`（若有）用于用户判断
  - 不要静默把 0 值当成真实值（尤其是 price/healthFactor/统计总量）
- **当 `blockNumber` 不单调/为 0**：
  - 视为“不可用/未知”，UI 需降级（隐藏某些字段、提示需要刷新或等待索引）
- **当 `version` 存在**：
  - 可用于前端/后端做幂等去重、比对“是否读到了新快照”

> 说明：`PreviewView.preview*` 已透传 `PositionView` 的 `isValid/blockNumber/version`，请与 PositionView 的 meta 语义一致处理。
>
> 必须授权：`PreviewView` 合约地址在部署时**必须**授予 `ACTION_VIEW_USER_DATA`，用于其内部调用 `PositionView.getUserPositionWithMeta`。
> 否则外部调用 `preview*` 会因内部读权限失败而回滚（`MissingRole()`）。

> TTL/过期窗口以链上 `ViewConstants.CACHE_DURATION` 为准（当前为 5 minutes）；前端不要自行硬编码另一个 TTL。

##### View push 失败重试（`CacheUpdateFailedWithContext`，严格 B+（Snapshot + 单入口编排器））

> 适用对象：**后端 Read Service / 运维重试服务**（前端钱包通常不执行 push）。  
> 目标：做到 “失败可观测 → 可重放 → 版本冲突可自愈”，避免 View 缓存长期陈旧。

- **监听事件（MUST）**：`CacheEvents.CacheUpdateFailedWithContext`
  - 对于 `StatisticsView` 的 user-scope 推送：`asset == address(0)` 表示“user-scoped stats”。
  - **在严格 B+ 中**：`CacheUpdateFailedWithContext` 的 `(collateral, debt)` 字段承载“期望写入的 snapshot”（不是 delta）。
- **重试策略（推荐默认）**：
  - **不要重放 delta**。应调用单入口编排器 **重算 SSOT 快照后再推**：
    - `StatisticsPushManager.retryUserStats(user)`
    - `StatisticsPushManager.retryGuarantee(user, asset)`
  - 若失败原因包含 `StatisticsView__OutOfOrderSeq`：通常是上游乱序或并发 bug，优先告警人工处理（默认不自动重试）。
- **权限要求（部署必须配置）**：
  - 重试服务地址需要具备 `ActionKeys.ACTION_VIEW_PUSH`（用于调用 `StatisticsPushManager.retry*`）
  - `StatisticsPushManager` 合约地址需要具备 `ActionKeys.ACTION_VIEW_PRICE_DATA`（用于读取 `PositionView` 的 USD-8 估值快照；B+ 链路以 USD-8 作为 value unit SSOT）

> 实施清单与验收脚本建议见：  
> `docs/Usage-Guide/StatisticsView-Strict-B-Push-Pipeline-Implementation-Checklist.md`

**部署侧提醒（本地/生产都适用）**

- **Registry 绑定（SSOT）**：
  - `ModuleKeys.KEY_STATS` → `StatisticsView`
  - `ModuleKeys.KEY_STATS_PUSH_MANAGER` → `StatisticsPushManager`
- **前端/后端拿地址的方式**：
  - 若你们做后端 Read/Retry Service：建议用 `Registry.getModuleOrRevert(ModuleKeys.KEY_STATS_PUSH_MANAGER)` 获取编排器地址
  - 本地开发：`scripts/deploy/deploylocal.ts` 会输出到 `frontend-config/contracts-localhost.ts`（将来前端可以直接导入）

#### 2.1.4.1 前端 API 清单（meta-first，2026-01）

以下接口已按“user-dim 必须携带 meta”的严格口径统一，前端需按新返回值解包并展示/降级处理。

> ⚠️ ABI 强约束：下方列出的 struct 字段顺序即 ABI tuple 顺序。未来前端必须使用最新 ABI/TypeChain 重新生成类型；
> 严禁按旧字段顺序做手工 `abi.decode`/跨语言解码。

**UserView（用户维度）**

- `getUserPosition(user, asset)` → `(collateral, debt, isValid, blockNumber, version)`
- `getUserPositionService(user, asset)` → `(collateral, debt, isValid, blockNumber, version)`
- `getUserCollateral(user, asset)` → `(collateral, isValid, blockNumber, version)`
- `getUserDebt(user, asset)` → `(debt, isValid, blockNumber, version)`
- `getUserTotalCollateral(user)` → `(totalCollateral, isValid, blockNumber, version, seq)`
- `getUserTotalDebt(user)` → `(totalDebt, isValid, blockNumber, version, seq)`
- `getHealthFactor(user)` → `(healthFactor, isValid, blockNumber)`
- `getUserHealthFactor(user)` → `(healthFactor, isValid, blockNumber)`
- `getUserStats(user, asset)` → `(stats, isValid, blockNumber)`
- `previewBorrow/previewDeposit/previewRepay/previewWithdraw(...)` →
  `(newHF, newLTV, maxBorrowable, positionIsValid, positionBlockNumber, positionVersion)`

**DashboardView（用户聚合）**

- `getUserOverview(user, assets[])` →
  `(overview, positionValidFlags[], positionBlockNumbers[], positionVersions[], healthBlockNumber)`
- `getUserAssetBreakdown(user, assets[])` → `UserAssetOverviewMeta[]`（每项包含 `positionIsValid/positionBlockNumber/positionVersion`）

**CacheOptimizedView（批量用户维度）**

- `batchGetUserPositions(users[], assets[])` → `UserPositionItemMeta[]`
- `getUserSummary(user, assets[])` →
  `(summary, positionValidFlags[], positionBlockNumbers[], positionVersions[], healthBlockNumber)`

**RiskView（用户维度风险评估）**

- `getUserRiskAssessment(user)` → `RiskAssessmentWithMeta`
- `batchGetRiskAssessments(users[])` → `RiskAssessmentWithMeta[]`
- `RiskAssessmentWithMeta` 字段（顺序固定）：
  - `liquidatable`：`bool`（当 `isValid=true` 且 `healthFactor < 10_000` 时为 true）
  - `isValid`：`bool`（来自 `HealthView` cache validity）
  - `warningLevel`：`uint8`（枚举：`NONE=0`、`WARNING=1`、`CRITICAL=2`）
  - `healthFactor`：`uint256`（bps；`10_000=100%`；当 `isValid=false` 时为 best-effort fallback）
  - `blockNumber`：`uint256`（`HealthView` cache block；`0` 视为未知/不可用）

**BatchView（轻量 batch：risk / system-status）**

- `batchGetRiskAssessments(users[])` → `RiskItem[]`
- `batchGetModuleHealth(modules[])` → `ModuleHealthItem[]`
- `RiskItem` 字段（顺序固定）：
  - `user`：`address`
  - `liquidatable`：`bool`
  - `isValid`：`bool`
  - `warningLevel`：`uint8`（同 RiskView 的枚举含义）
  - `healthFactor`：`uint256`（bps；`10_000=100%`）
  - `blockNumber`：`uint256`（来自 RiskView/HealthView 的 meta）
- `ModuleHealthItem` 字段（顺序固定）：
  - `module`：`address`
  - `lastCheckTime`：`uint32`
  - `consecutiveFailures`：`uint32`
  - `isHealthy`：`bool`
  - `isValid`：`bool`
  - `detailsHash`：`bytes32`（诊断摘要，供 UI/监控展示或链下映射）
  - `blockNumber`：`uint256`（模块健康快照区块；`0` 视为未知/不可用）

**LiquidatorView（用户维度）**

- `getUserLiquidationStats(user)` → `(stats, blockNumber, isValid)`
- `batchGetLiquidationStats(users[])` → `(stats[], blockNumber, isValid)`
- `getSeizableCollateralAmount(user, asset)` → `(amount, blockNumber, isValid)`
- `getSeizableCollaterals(user)` → `(assets[], amounts[], blockNumber, isValid)`
- `getUserTotalCollateralValue(user)` → `(totalValue, blockNumber, isValid)`

**RewardView（用户维度）**

- `getUserBalanceWithMeta(user)` → `(balance, cacheBlock, isValid)`
- `getUserRewardSummaryWithMeta(user)` → `(totalBurned, pendingPenalty, level, lastActivity, blockNumber, isValid)`
- `getUserEarnStateWithMeta(user)` → `(lockedEasy, eligibleLoanCount, onTimeRepayCount, blockNumber, isValid)`
- `getUserEasyEarnedWithMeta(user)` → `(easyEarned, blockNumber, isValid)`
- `getUserEasyStakedWithMeta(user)` → `(easyStaked, blockNumber, isValid)`
- `getUserEasySpentWithMeta(user)` → `(easySpent, blockNumber, isValid)`
- `getUserRecentActivitiesWithMeta(user, fromBlock, toBlock, limit)` → `(activities[], cacheBlock, isValid)`

**Reward 前端配合（必做）**

- 展示口径建议：
  - `walletEasyBalance = getUserBalanceWithMeta(user).balance`
  - `pendingPenalty = getUserRewardSummaryWithMeta(user).pendingPenalty`
  - `availableEasyBalance = max(walletEasyBalance - pendingPenalty, 0)`（用于“可消费”展示）
- 关键语义：当存在 `pendingPenalty` 时，后续奖励入账会先抵扣欠分，再增加钱包 Easy 余额；因此“本次赚取”不一定等于“钱包净增”。
- 事件联动（推荐最小集合）：
  - 订阅 `EASY_MINTED`、`REWARD_BURNED`、`REWARD_PENALTY_LEDGER_UPDATED`、`REWARD_EARN_STATE_UPDATED`、`EASY_SPENT`、`EASY_RECYCLED_SPLIT`
  - 收到事件后刷新 `getUserBalanceWithMeta` + `getUserRewardSummaryWithMeta`，不要只本地累加/相减
- 写前校验（消费前）：
  - 必须先读 `availableEasyBalance`，不足则前端直接拦截并提示“存在待抵扣 penalty 或余额不足”
  - 交易前再做一次 quick-refresh，降低并发下 UI 误判
- 本地环境排障（dev/qa）：
  - 若奖励写路径报 `ModuleNotRegistered(REWARD_EARN_CONFIG)`，优先检查 Registry 是否绑定了 `REWARD_EARN_CONFIG -> EarnConfig`
  - 该项缺失会导致奖励参数写入（如 level multiplier / dynamic params）失败，进而影响前端联调结果

**治理投票权（stEASY / Gate / CrossChainGovernance）前端配合（集成必读）**

> 目标：把“投票权 token / 委托激活 / gate 资格判断 / CrossChainGovernance SSOT 绑定”一次讲清楚，避免出现“有余额但投票权为 0”或“绑定漂移导致治理交易 revert”。

- **投票权 token（SSOT）**：`EasyStaking (stEASY)`（`ERC20Votes` / `IVotes`）。
- **委托激活（非常重要）**：`ERC20Votes` 需要 delegate 才会产生 checkpoints；因此可能出现 `balanceOf > 0` 但 `getVotes/getPastVotes == 0`。
  - 前端建议在用户进入治理页时检查 `stEASY.getVotes(user)`，若为 0 则引导执行一次 `stEASY.delegate(user)`（自委托）。
- **Gate 资格判断（UI/预检建议）**：
  - 从 Registry 解析 `GOVERNANCE_GATE` 地址（若未绑定则表示“未启用 gate 门控”）。
  - 调用 `GovernanceGate.isEligibleToPropose/ isEligibleToVote(user, snapshotBlock, votesToken)`：
    - `snapshotBlock` 建议用 `currentBlock - 1`（或与提案快照对齐：`proposal.startBlock - 1`）
    - `votesToken` 使用 stEASY 地址（`Registry[KEY_EASY_STAKING]`）
- **CrossChainGovernance 的 SSOT 绑定（Scheme B：缓存 + 强约束）**：
  - `CrossChainGovernance` 初始化口径：`initialize(admin, registry)`（registry 必填）
  - 治理 token 的唯一 SSOT 是 `Registry[KEY_EASY_STAKING]`
  - 合约内部会缓存 `governanceToken`，但关键路径会强校验一致性；若 Registry 更新了 `KEY_EASY_STAKING` 且未同步缓存，`createProposal/vote` 会 revert
  - 运维要求：Registry 更新 `KEY_EASY_STAKING` 后，应调用 `CrossChainGovernance.syncGovernanceTokenFromRegistry()` 刷新缓存

**AICreditsVault（AI Credits SSOT）**

- Registry key：`AI_CREDITS_VAULT`（`keccak256("AI_CREDITS_VAULT")`）
- 余额只读：`creditsBalance(tenantId, user)`（单位：credit，1=1次）
- 链上购买/充值入口：`buyCredits(...)`（以当前 AICreditsVault 合约实现为准）

**LoanFlowView（协议借贷流量，USD-8 SSOT）**

- `getUserLoanFlowWithMeta(user)` → `(borrowVolumeUsd8, repayVolumeUsd8, borrowCount, repayCount, version, seq, lastAppliedRequestId, isValid, blockNumber)`
  - 口径：**protocol-level** borrow+repay flow（USD-8）
  - 访问：用户本人可读；非本人需 `VIEW_USER_DATA` / `ACTION_ADMIN`
- `getGlobalLoanFlowWithMeta()` → `(totalBorrowVolumeUsd8, totalRepayVolumeUsd8, totalBorrowCount, totalRepayCount, isValid, blockNumber)`
  - 访问：**公开只读**（适合前端公开展示“协议总量”类指标；如需敏感化可在后续版本再加 gate）

**非缓存 user-dim（同样要求 meta）**

- `UserView.getUserTokenBalance(user, token)` → `(balance, isValid, blockNumber)`
- `UserView.getUserSettlementBalanceStrict(user)` → `(balance, isValid, blockNumber)`
- `LoanNFTView.getUserLoanCount(user)` → `(count, isValid, blockNumber)`
- `LendingEngineView.canAccessLoanOrder(orderId, user)` → `(hasAccess, isValid, blockNumber)`
- `RiskView.calculateHealthFactorExcludingGuarantee(user, asset)` → `(healthFactor, isValid, blockNumber)`
- `ValuationOracleView.hasUpgradePermission(user)` → `(hasPermission, isValid, blockNumber)`
- `LiquidationRiskView.isLiquidatable(user)` → `(liquidatable, isValid, blockNumber)`
- `LiquidationRiskView.isLiquidatable(user, collateral, debt, asset)` → `(liquidatable, isValid, blockNumber)`
- `LiquidationRiskView.getLiquidationRiskScore(user)` → `(riskScore, isValid, blockNumber)`
- `LiquidationRiskView.batchIsLiquidatable(users[])` → `(flags[], isValid, blockNumber)`
- `LiquidationRiskView.batchGetLiquidationRiskScores(users[])` → `(scores[], isValid, blockNumber)`

**FeeRouterView（批量空数组严格校验）**

- `batchGetUserFeeStatisticsWithMeta(users[])` / `batchGetGlobalFeeStatisticsWithMeta(tokens[], feeTypes[])` /
  `getUserFeeAnalyticsWithMeta(user, feeTypes[])`：空数组必定 `revert EmptyArray()`。

#### 2.1.5 批量边界（MAX_BATCH_SIZE）与错误口径：必须 chunk + 识别 `BatchTooLarge`

- `MAX_BATCH_SIZE`（当前为 100）适用于多数组合批量入口（Dashboard/CacheOptimized/Batch 等）。
- **超限必须** `revert BatchTooLarge(length,max)`；空数组必须 `revert EmptyArray()`（全仓一致口径）。
- 前端建议：
  - 对大数组做 `chunk(assets/users, 100)` 分批并发调用
  - 错误识别优先用 **TypeChain ABI 的 custom error selector**；不要依赖 revert string
  - 参考本文档 “前端如何精准识别 custom error” 小节（见下方 5.3）

#### 2.1.6 可观测性与离线重试：DataPushed + CacheUpdateFailed 是前端/后端协同闭环

- **监听服务**统一订阅 `DataPushed(bytes32 indexed dataTypeHash, bytes payload)`（见本文档 §9）
- **push 失败**（主流程不中断）通过失败事件可观测：
  - `CacheUpdateFailed(...)`（SSOT，见本文档 §11）
  - `ViewCachePushFailed(...)`（CollateralManager best-effort push 失败提示）
- **离线重试**：后端/运维以 admin 身份调用 `PositionView.retryUserPositionUpdate(user, asset)`，前端只展示状态与发起请求（见本文档 §11.3）

> 本仓库已提供端到端验收脚本，可作为前后端联调与回归基准：
>
> - `scripts/e2e/e2e-localhost-batch-aggregators-acceptance.ts`（三聚合器职责/权限/超限）
> - `scripts/e2e/e2e-localhost-scenario-matrix.ts`（ARCH 5.1.3：E2E-01/02/03，包含“失败注入→重试→统计”闭环）

#### 2.1.7 前端与合约配合要点（写入/估值/权限）

**A) 地址与配置对齐（必须）**

- 启动时使用 `Registry.getModuleOrRevert(key)` 作为地址 SSOT；`SystemView.route*()` 仅做校验。
- 代币列表以 `FeeRouter.getSupportedTokens()` 为准，前端不要硬编码 symbol → address。
- 代币精度使用 `ERC20.decimals()`，不要假设 USDC=6 或 18。

**B) 估值与价格**

- 前端展示的“债务总值”应来自 `UserView/HealthView/PositionView` 的估值口径，而不是本地加总。
- 当 `isValid=false` 或 `blockNumber==0` 时必须降级展示（避免误导）。
- 如果引入新资产，确保链上已完成：
  - `AssetWhitelist.addAllowedAsset`
  - `PriceOracle.configureAsset + updatePrice`
  - `FeeRouter.addSupportedToken`

**C) 写入路径与权限**

- 业务写入走 `VaultCore` / `VaultBusinessLogic`；前端不要调用只读 View 作为写入入口。
- 读接口是 `VIEW_*_DATA` gated；生产建议使用后端 Read Service 代持角色。

**D) Guarantee Extension（如启用）**

- 若 `EarlyRepaymentGuaranteeManager` 对某资产启用：
  - `finalizeMatch` 期间会从 borrower 拉取保证金（期限语义以 block 口径为准；若启用 termBlocks 方案，则 termBlocks 为 SSOT）。
  - 前端需对 `GuaranteeFundManager` 预先 `approve` 足额的 promisedInterest，否则会报 `ERC20InsufficientAllowance`。
  - **平台费路由**：提前还款 `platformFee` 会先转入 `FeeRouter` 再 `distributePrepaid` 分发（feeType = `FEE_TYPE_EARLY_REPAYMENT_PLATFORM`）。

**E) 清算相关（Liquidation）**

- 前端只读使用 `LiquidatorView`；legacy / 通用订单的 keeper 入口为 `SettlementManager.settleOrLiquidate(...)`，但 blocks-only 订单的 keeper 入口是 `BlocksOnlyCoordinator.settleOrLiquidateBlocks(...)`。
- 若遇到 `MissingRole()`，需要检查 `ACTION_LIQUIDATE` 与 `VIEW_RISK_DATA` 是否授予给执行方与 SettlementManager。
  - **平台份额路由**：清算残值中的 platform share 先进入 `FeeRouter` 再分发（feeType = `FEE_TYPE_LIQUIDATION_PLATFORM`）。

### 3. 实现示例（TypeScript / Ethers v6）

```ts
import { ethers } from "ethers";
import { VaultRouter__factory } from "@/types/factories";

const signer = provider.getSigner();
const vaultRouter = VaultRouter__factory.connect(addresses.VaultRouter, signer);

// 用户存款操作
export async function deposit(asset: string, amount: bigint) {
  // 注意：本项目的“到期/过期/门槛语义”统一基于 block.number（见下方 Block-based Deadline 章节）。
  // 这里传入的 blockNumber 仅用于链下审计/可观测性（observability），不得被业务逻辑用于资金门槛判断。
  const clientObservedBlock = await provider.getBlockNumber();
  const tx = await vaultRouter.processUserOperation(
    await signer.getAddress(),
    utils.id("DEPOSIT"), // bytes32("DEPOSIT")
    asset,
    amount,
    clientObservedBlock,
  );
  await tx.wait();
}
```

### 4. 过渡期兼容

- 若后端或脚本仍依赖旧版 `IVaultRouter` 的只读接口，请 **迁移到对应子模块** 并删除旧调用。
- `VaultRouter` 合约已瘦身，但 ABI 变更会导致旧前端编译失败；务必同步更新 `@/types` 代码生成与合约地址配置。

---

以上即为最新 `VaultRouter` 协调器的前端集成规范，后续业务查询请直接面向子视图模块。

## 🧱 CollateralManager（抵押账本）前端配合要点（2026-01）

> 目标：避免前端“误把业务模块当 View 用”，同时保留必要的账本只读兼容能力（供清算/视图/统计/排障/过渡期使用）。

### 1) 查询入口选择（推荐顺序）

- **正常 UI 查询（推荐）**：优先调用各专属 View（0 gas `view` 查询 + 缓存/聚合能力）
  - 用户仓位/资产维度：`PositionView` / `UserView`
  - 系统统计：`StatisticsView`
  - 价格：`ValuationOracleView` / 批量价格：`BatchView`
- **账本只读兼容（谨慎使用）**：仅在“排障 / 兜底 / 过渡期兼容 / 枚举资产列表”时使用 `CollateralManager` 的 getter：
  - `getCollateral(user, asset)`：返回 **抵押账本数量**（不含估值）
  - `getTotalCollateralByAsset(asset)`：返回 **该资产全局抵押总量**（不含估值）
  - `getUserCollateralAssets(user)`：返回用户抵押过的资产列表（用于枚举；列表随抵押为 0 会移除）
- **明确禁止/已移除**：`CollateralManager` **不提供任何“估值/美元价值/抵押价值”接口**；估值请走 `ValuationOracleView` 或 View 层聚合（遵循 `docs/Architecture-Guide.md`）。

### 2) ERC20 授权（approve）协作约定

- **抵押存入**：前端需要对 **`CollateralManager` 地址**执行 `ERC20(asset).approve(CollateralManager, amount)`（或更高额度）。
- **抵押提取**：通常不需要 approve（提取由 `CollateralManager` 直接 `transfer` 到 receiver）。

### 3) 事件 / DataPush 订阅（前端/监听服务）

- `CollateralManager` 会发出业务事件：`DepositProcessed` / `WithdrawProcessed` / `BatchDepositProcessed` / `BatchWithdrawProcessed`（可用于 UI/索引服务同步）。
- 同时会通过统一入口 `DataPushed(bytes32 dataTypeHash, bytes payload)` 推送同等信息（建议监听服务统一只订阅 `DataPushed`，再按 `dataTypeHash` 解码）。
- View 推送失败告警（不回滚主流程）：`ViewCachePushFailed(address user, address asset, bytes reason)`
  - 含义：抵押账本写入成功，但 **View 层快照推送失败**；UI 侧应优先以 View 查询为主，如发现缓存陈旧可提示“数据可能延迟”，并配合后端重试/告警闭环（另见本文档 `CacheUpdateFailed` 章节）。

## 💸 资金链（Funds Flow / SSOT）前端配合（2026-01）

> 本节是 `docs/Usage-Guide/Funds-Flow-Architecture-Guide.md` 的前端落地版：只写“前端需要做什么”，不重复合约内部实现细节。

## Block-based Deadline 与 ETA 映射（前端/keeper 必须遵守）

> 对齐文档：`docs/Usage-Guide/Time-Dependency-Refactor-Guide.md`（本项目强约束：链上门槛统一用 `block.number/epoch/round`，链下做墙钟映射与调度）。

### 核心约束（必须理解为产品语义，而不是“实现细节”）

- **链上只认 block**：
  - `maturityBlock` / `deadlineBlock` / `maxAgeBlocks` 等字段，都是**区块高度口径**
  - 任何“是否到期/是否过期/是否可清算/是否允许动作”的判断都必须基于 `block.number`（或 round/epoch 单调性）
- **前端展示的是 ETA（估计值）**：
  - UI 展示的“到期时间/截止时间”只能是 **ETA**（estimated time of arrival）
  - ETA 可能在拥堵/停摆时漂移：这是链的现实约束，不能用“更精准的本地时间”解决
- **keeper 的计算机时间只用于调度**：
  - keeper/机器人可以用 NTP 对齐“什么时候发交易”
  - 但**链上判定永远不使用** keeper 的计算机时间

### 接口/返回值配合（避免误用）

> 对齐文档：`docs/Usage-Guide/Time-Dependency-Refactor-Guide.md` 的“命名规范（强制）”。

- **字段命名必须 block 化**：
  - 必须：`...Block` / `...Blocks`（门槛语义）
  - 必须：`updateBlock` / `cacheBlock`（观测/元数据）
  - 禁止：`timestamp` / `daysSince` / `hoursSince` / `secondsSince`（墙钟语义）
- **展示字段（可选）**：
  - 如果 UI 需要做“年龄/剩余时间”展示，合约侧**只需要返回** `updateBlock`（以及必要时的 `deadlineBlock`）
  - 前端自行计算 `ageBlocks = currentBlock - updateBlock`，再映射为“约 X 分钟/天（估计值）”
  - **坚决禁止**合约返回 `approxDays/approxHours` 之类字段（哪怕标注“仅展示”也容易被误用）
- **关于事件中的 `ts` 字段（历史遗留）**：
  - 在部分 `DataPushed` schema 里仍会出现 `ts`（时间戳）字段——它只能用于链下索引/活动流展示
  - UI/keeper **不得**把 `ts` 当作任何 deadline/门槛语义；门槛语义只能来自 `...Block/...Blocks`

### 推荐实现：用平均出块时间估算 ETA

公式：

- `ETA = now + (deadlineBlock - currentBlock) * avgBlockTimeSeconds`

建议：

- `avgBlockTimeSeconds` 作为**网络配置**（例如 Arbitrum/Arbitrum Sepolia），可在运行时按最近 N 个 block 采样做平滑更新。

#### 同一套 ETA 映射也适用于 “ageBlocks”（缓存/快照年龄展示）

- `ageBlocks = currentBlock - updateBlock`
- `ageSecondsApprox = ageBlocks * avgBlockTimeSeconds`
- UI 推荐展示：
  - “更新于约 \(ageBlocks\) 个区块前（约 X 分钟，估计值）”
  - 若 `updateBlock==0` 或 `updateBlock>currentBlock`：展示 “更新区块未知/不可用”，不要硬算 ETA

可复制示例（ethers v6）：

```ts
import { ethers } from "ethers";

export async function estimateEtaFromDeadlineBlock(
  provider: ethers.Provider,
  deadlineBlock: bigint,
  avgBlockTimeSeconds: number,
) {
  const currentBlock = BigInt(await provider.getBlockNumber());
  const nowMs = Date.now();
  if (deadlineBlock <= currentBlock) {
    return { currentBlock, deadlineBlock, etaMs: nowMs };
  }

  const blocksLeft = deadlineBlock - currentBlock;
  const etaMs = nowMs + Number(blocksLeft) * avgBlockTimeSeconds * 1000;
  return { currentBlock, deadlineBlock, etaMs };
}

export async function estimateAgeApproxFromUpdateBlock(
  provider: ethers.Provider,
  updateBlock: bigint,
  avgBlockTimeSeconds: number,
) {
  const currentBlock = BigInt(await provider.getBlockNumber());
  if (updateBlock === 0n || updateBlock > currentBlock) {
    return {
      currentBlock,
      updateBlock,
      ageBlocks: 0n,
      ageSecondsApprox: null as number | null,
    };
  }
  const ageBlocks = currentBlock - updateBlock;
  const ageSecondsApprox = Number(ageBlocks) * avgBlockTimeSeconds;
  return { currentBlock, updateBlock, ageBlocks, ageSecondsApprox };
}
```

### UI 文案建议（避免“blockNumber=deadline”的误导）

- 推荐展示：
  - “预计在约 \(N\) 个区块后到期（ETA：yyyy-mm-dd hh:mm，估计值）”
  - 当网络拥堵/停摆时：加提示 “ETA 会随区块速度变化”
- 不要展示：
  - “到期时间戳：xxxxx” 作为门槛语义

### 兼容迁移清单（legacy 字段名：`blockNumber` / `ts` 等）

> 目标：在不立即破坏旧 ABI/旧前端的情况下，把所有“门槛/有效性”语义收敛到 `...Block/...Blocks`，并把遗留字段**降级为观测/索引字段**，防止被误用成 deadline。

#### 1) 先做“字段语义归类”：新增字段 vs 保留字段

| 遗留字段名（示例）                                                       | 是否允许保留                    | 正确语义（必须写清                                                      | 推荐新增字段（SSOT）                                                  | 前端/keeper处理要点                                                                    |
| ------------------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `event.blockNumber`（日志元数据）                                        | ✅ 保留                         | **链上日志所在区块高度**（权威、不可伪造）                              | 无                                                                    | 可用于 UI 显示“发生于某区块”、用于索引幂等键。                                         |
| 入参叫 `blockNumber`（例如“客户端观测块高/链下来源块高”）                | ✅ 保留（但语义必须降级）       | **观测字段**：caller 观测到的块高/数据源块高；只允许做“单调不回退/审计” | 若有门槛语义：`deadlineBlock` / `maturityBlock` / `executeAfterBlock` | 不能把该 `blockNumber` 当 deadline；更不能与 `block.number` 做“是否过期”比较。         |
| 返回值/struct 里叫 `blockNumber`（例如 `(value, isValid, blockNumber)`） | ✅ 保留（常见，短期难以改 ABI） | **meta 口径的 cache/update block**：表示该快照写入/更新发生的区块       | `updateBlock` / `cacheBlock`（推荐作为新字段名）                      | 前端解包后请立刻重命名本地变量：`cacheBlock`/`updateBlock`，避免与 deadline 混淆。     |
| `ts` / `timestamp`（常见于 `DataPushed` payload schema）                 | ✅ 仅限索引/展示                | **仅用于活动流/索引排序/展示**，不参与任何门槛语义                      | 若有门槛语义：一律用 `...Block/...Blocks`                             | UI/keeper 不得用 `ts` 推导“是否到期/是否可执行”；必须用 `deadlineBlock/currentBlock`。 |
| `daysSince` / `hoursSince` / `secondsSince`                              | ❌ 禁止                         | 墙钟口径的“已过去时间”容易被误用成门槛                                  | `updateBlock`（链上）+ `ageBlocks`（链下计算）                        | 只返回 blocks 信息；“约 X 天/小时”由前端 ETA 映射计算并标注估计值。                    |

#### 2) 推荐新增字段（门槛/有效性 SSOT）

- **门槛类（必须）**：`deadlineBlock`、`maturityBlock`、`executeAfterBlock`、`cooldownBlocks`、`maxAgeBlocks`
- **meta 类（强烈推荐）**：`updateBlock`（或 `cacheBlock`）、`isValid`
- **派生值（链下计算，禁止链上输出“天/小时”）**：
  - `currentBlock = provider.getBlockNumber()`
  - `ageBlocks = currentBlock - updateBlock`
  - `blocksLeft = deadlineBlock - currentBlock`
  - 然后用 `avgBlockTimeSeconds` 做 ETA 映射并标注“估计值”

#### 3) 前端/keeper 兼容改造 checklist（可复制到迁移 PR）

- [ ] **解包即重命名**：对所有返回 tuple/struct 中的 `blockNumber`，在本地变量名改成 `cacheBlock` / `updateBlock`（避免误用）。
- [ ] **门槛只看 blocks**：所有“是否到期/是否过期/是否可执行/是否可清算”的判断只使用 `...Block/...Blocks` 与 `currentBlock`。
- [ ] **`ts` 只用于展示/索引**：UI/keeper 禁止用 `ts/timestamp` 做门槛判断或调度判定。
- [ ] **UI 展示统一走 ETA 映射**：对 `deadlineBlock` 或 `ageBlocks` 展示“约 X 分钟/天”时，必须标注“估计值”，并在拥堵/停摆时提示 ETA 漂移。
- [ ] **兼容期双读**（如果同时存在新旧字段）：优先使用 `...Block/...Blocks`；旧字段仅用于观测展示或 debug。

#### 4) ABI 演进建议（不破坏旧前端的最小策略）

- **不要在同一个 struct/tuple 里重排字段**（ABI tuple 顺序是强约束；重排会让旧前端 silent wrong decode）。
- **推荐做法**：保留旧函数/旧字段（标注 deprecated），新增 `*AtBlock/*WithBlockMeta` 函数返回“命名正确”的新字段（`...Block/...Blocks`）。
- **清理时机**：只在明确的 breaking release 里删除 legacy 字段/旧函数，并要求前端同步更新 TypeChain。

## 🧾 AI Credits 计费规范（按次计费：链上购买 + 链下扣次 + 多租户对账）

如果你的产品包含 AI 能力，并且希望使用“按次计费/次数包（USDC/USDT 购买）+ 链下幂等扣次 + 链上可审计余额（B）”的组合（不牺牲 AI 调用体验），请阅读：

- [AI-Credits-Billing-Guide.md（统一规范）](./Usage-Guide/AI-Credits-Billing-Guide.md)

### 0) 资产列表 / Token List 的 SSOT 口径（非常重要）

前端经常会遇到三类“看起来像 token list”的需求，但它们的**权威来源不同**，也**不保证完全相同**：

- **资产白名单（允许参与抵押/借贷/账本写入的资产集合）**：
  - SSOT：`AssetWhitelist.getAllowedAssets()`
  - 用途：前端的“可选抵押资产/可选借贷资产”候选集（写入口前的前置校验）
- **有价格的资产集合（价格系统支持的资产集合）**：
  - SSOT：`PriceOracle.getSupportedAssets()`（或走 View：`ValuationOracleView` / `BatchView` 进行批量查询）
  - 用途：前端的“可估值资产”集合（价格展示、健康因子、清算风险提示等）
- **会进入费用分发的 token 集合（FeeRouter 支持列表）**：
  - SSOT：`FeeRouter.getSupportedTokens()`
  - 用途：任何会走 `FeeRouter.distributeNormal/distributeDynamic/batchDistribute` 的 token 必须在此列表里，否则会 `TokenNotSupported`（见架构指南）

推荐实践（前端展示层）：

- **展示层 token universe（并集）**：`union(allowedAssets, supportedAssets, feeSupportedTokens)`，用于“系统支持资产总览/多 token 余额对账/调试面板”
- **写入口选择（交集/过滤）**：例如抵押存入只允许 `allowedAssets`；展示估值必须同时满足“有价格且价格有效”
- **不要假设三者一致**：部署/治理配置差异、dirty state、增量上新流程都会造成短时间不一致；UI 侧必须容错并清晰提示

### 1) 抵押存取（写入口速查）

本节只说明“approve 给谁 + 调哪个写入口”，不复述抵押托管者/真实资金去向等资金链细节（见 Funds-Flow SSOT）。

- **approve（必须）**：`ERC20(collateralAsset).approve(CollateralManager, amount)`
- **写入口（用户）**：`VaultCore.deposit(...)` / `VaultCore.withdraw(...)`
- **UI 查询（推荐）**：`UserView` / `PositionView`（0 gas）
- **资金链 SSOT**：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`

### 2) 出借 reserve（写入口速查）

本节只说明“approve 给谁 + 调哪个写入口”，不复述资金池托管者/真实资金去向等资金链细节（见 Funds-Flow SSOT）。

- **approve（必须）**：`ERC20(asset).approve(VaultBusinessLogic, amount)`
- **写入口**：`VaultBusinessLogic.reserveForLending(...)` / `VaultBusinessLogic.cancelReserve(...)`
- **前端职责**：生成/展示 `lendHash`（幂等键）与签名材料（可复现/可审计）
- **资金链 SSOT**：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`

> termBlocks 约定（termBlocks SSOT）：  
> `lendHash` 必须是 **LendIntentBlocks 的 EIP-712 struct hash**（不是 digest），并且其 `expireAt` 语义为 expireBlock。  
> 即：链下按 `SettlementIntentLib.hashLendIntentBlocks(LendIntentBlocks)` 等价的 type string/字段顺序计算 struct hash，用于：
>
> - `reserveForLending(..., lendHash)` 的幂等键
> - 撮合入口里与签名一起复现校验

#### TermBlocks 快照 SSOT（前端/keeper 集成规范）

在继续阅读本节前，建议先用 [Usage-Guide/Blocks-Only-Frontend-Matching-Checklist.md](Usage-Guide/Blocks-Only-Frontend-Matching-Checklist.md) 校验你当前接入的是“前端职责”“撮合职责”还是“keeper 职责”，避免把 legacy keeper 入口与 blocks-only coordinator 入口混用。

目标：在“链上只认 blocks”的前提下，让 `termDays` 的 UX 更贴近墙钟天数，同时保证 borrower/lender 使用**同一版本映射**，避免撮合失败。

- **SSOT 发布者（推荐）**：撮合服务/keeper（中心化服务可用；关键是要可审计、可复现）
- **快照频率**：建议每日 1 次（或每 N 小时一次，但不要过频导致版本碎片化）
- **前端原则**：
  - 只消费快照，不自行推导 `days -> blocks`
  - UI 必须同时展示：
    - `termBlocks` / `maturityBlock` / `blocksLeft`（确定值）
    - ETA（估计值，基于快照里的 `avgBlockTimeSeconds` 或前端采样值）

**推荐 API 结构（示例）**：

```json
{
  "chainId": 42161,
  "snapshotId": "arb1-2026-02-07",
  "window": {
    "fromBlock": 312345678,
    "toBlock": 312355678,
    "method": "EMA",
    "alpha": 0.2
  },
  "avgBlockTimeSeconds": 0.26,
  "termBuckets": [
    { "termDays": 5, "termBlocks": 166000 },
    { "termDays": 10, "termBlocks": 332000 }
  ],
  "blocksOnlyProducts": [
    {
      "productCode": "BLOCKS_ONLY_1",
      "label": "1 block maturity",
      "termBlocks": 1,
      "settlementMode": "immediate-after-maturity"
    }
  ],
  "generatedAtBlock": 312355700
}
```

说明：

- `termBuckets` 继续服务 legacy day-bucket 产品（5/10/15/.../360 天）。
- `blocksOnlyProducts` 用于显式 blocks-only 产品目录，不应被折叠进 `termDays` 桶。
- 对于 `BLOCKS_ONLY_1`，签名、撮合、风险与前端展示都应直接使用 `termBlocks = 1`；不要再套用 day-bucket 的 `maturityBlock = openBlock + termBlocks + 1` 兼容偏移。

**缓存/失败处理（必须）**：

- **缓存键**：`(chainId, snapshotId)`
- **取快照失败**：
  - 不建议继续签名新 intent（否则 borrower/lender 可能用不同版本）
  - 可允许用户“继续使用本地缓存的上一版快照”签名，但 UI 必须强提示“使用旧快照，可能降低撮合成功率”

**把 snapshotId 绑定进 `salt`（强烈推荐，便于审计与复现）**：

- 因为合约结构体里没有 `snapshotId` 字段，最简单的做法是把它编码进 `salt`，让“使用了哪个快照”可从签名材料复现出来。

示例（ethers v6，salt 构造）：

```ts
import { ethers } from "ethers";

export function buildSaltWithSnapshot(snapshotId: string, userNonce: bigint) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      [snapshotId, userNonce],
    ),
  );
}
```

### 3) 撮合放款（Finalize Match / Borrow Disbursement）

- **典型模式（推荐）**：由撮合服务/keeper 调 `VaultBusinessLogic.finalizeMatch(...)` 完成原子撮合（前端只负责签名与展示状态）。
- **兼容模式（legacy）**：仍可调 `VaultBusinessLogic.finalizeMatch(...)`（termDays bucket），但不再推荐；termBlocks 迁移后应尽快停用。
- **如何判断是否已启用 termBlocks 方案**：
  - 你的前端 ABI/TypeChain 若找不到 blocks-term 的结构体/签名（例如 `BorrowIntentBlocks/LendIntentBlocks`），说明当前部署仍在 legacy；需要先升级合约再切 termBlocks 签名与调用。
- **前端需要保证**：borrower 与 lenders 的签名数据可复现（用于追责与排障）

撮合放款的资金拨付、费用分发与 `LoanOrder` 字段语义等资金链口径请以 Funds-Flow 为唯一权威（本文件不复述）。

termBlocks 方案必须满足：

- **BorrowIntentBlocks.termBlocks** 来自链下显式映射表（不要链上推导）
- **BorrowIntentBlocks/LendIntentBlocks.expireAt** 语义为 expireBlock（`block.number > expireAt` 过期）
- EIP-712 域：`name="RwaLending"`, `version="1"`, `chainId`, `verifyingContract=VaultBusinessLogic`

### 4) 还款/结算（Repay → Settle）

- **approve（必须）**：`ERC20(debtAsset).approve(VaultCore, amount)`
- **写入口（用户）**：`VaultCore.repay(orderId, debtAsset, amount)`

还款后的结算分支、抵押释放与费用去向等资金链细节请以 Funds-Flow 为唯一权威（本文件不复述）。

### 5) 违约清算（写入口速查）

- **legacy / 通用订单入口（keeper 推荐，SSOT）**：`SettlementManager.settleOrLiquidate(orderId)`（需要 `ACTION_LIQUIDATE`）
- **blocks-only 订单入口（keeper 推荐，SSOT）**：`BlocksOnlyCoordinator.settleOrLiquidateBlocks(orderId)`（同样需要 `ACTION_LIQUIDATE`）
- **用户侧前端**：
  - 不应提供“直接清算”按钮给普通用户
  - 应校验 `keeper != borrower`，否则提示“清算需由第三方 keeper 执行”
  - 只读展示与事件订阅以 `LiquidatorView`/`LiquidationRiskManager`/`HealthView` 为准

#### 5.1 重要：`SettlementManager__NoCollateral` 不一定代表“用户没抵押”

我们在真实链路测试中观察到（非稳定币抵押 + `COLLATERAL_PRICE_MODE=stale`）：

`PriceOracle.getPrice` stale revert → `PositionView.getAssetValue` catch 返回 0 → `SettlementManager` 选不出 `bestAsset` → `SettlementManager__NoCollateral()`

因此，对前端/keeper UI 来说：

- `NoCollateral` 可能是 **估值不可用 / 价格过期 / 资产未配置价格**导致抵押价值为 0（而不是账本里没有抵押）
- 不能直接把 `NoCollateral` 翻译成“你没有抵押物”，否则会误导用户与运营

#### 5.2 前端/keeper UI 的推荐排障与提示（按 SSOT 分层）

当清算失败且错误包含 `SettlementManager__NoCollateral`（或你捕获到相同语义的 revert）时：

- **先查账本是否有抵押（数量口径）**（不依赖价格）：
  - `CollateralManager.getUserCollateralAssets(user)` + `CollateralManager.getCollateral(user, asset)`
- **再查价格是否可用（价格口径）**：
  - 推荐：`ValuationOracleView.isPriceValid(asset)`（返回 `isValid, blockNumber`；或 `BatchView.batchGetAssetPrices` 批量查）
  - 同时展示 `getAssetPrice` 返回的 blockNumber（提示 stale）
- **最后给出 UI 提示文案**（建议）：
  - “清算失败：系统无法对抵押资产估值（价格可能过期或未配置）。请刷新价格/检查预言机状态后重试。”

这套提示能在 dirty state / 配置差异下仍准确解释现象。

#### 5.3 前端如何“精准识别” custom error（包括 Hardhat/节点无法解码的情况）

在部分环境里你可能会遇到：

- 报错信息只包含 `unrecognized custom error (return data: 0x66e24701)`，**没有错误名**
- 这时仅靠 `error.message.includes("SettlementManager__NoCollateral")` 会失败

推荐做法（ethers v6）：

- **优先**：用合约的 `Interface` 去 `parseError(revertData)`（需要 ABI/TypeChain 包含 `error ...` 定义）
- **兜底**：提取 `revertData` 的前 4 字节 selector（如 `0x66e24701`），用 **selector→语义** 的映射表识别

示例（只展示核心逻辑）：

```ts
import { Interface, id } from "ethers";

// 1) 有 ABI 时：直接解析
const settlementIface = new Interface([
  "error SettlementManager__NoCollateral()",
  "error SettlementManager__NotLiquidatable()",
  "error SettlementManager__DebtNotCleared()",
  // ...按需补全
]);

export function decodeCustomError(e: any) {
  const msg = String(e?.message ?? e);
  const revertData: string | undefined =
    (e?.data as string) ||
    (e?.error?.data as string) ||
    (e?.info?.error?.data as string) ||
    undefined;

  if (revertData?.startsWith("0x")) {
    try {
      const parsed = settlementIface.parseError(revertData);
      return {
        kind: "named",
        name: parsed?.name,
        signature: parsed?.signature,
      };
    } catch {
      // 2) 兜底：selector
      const selector = revertData.slice(0, 10).toLowerCase();
      const NO_COLLATERAL = id("SettlementManager__NoCollateral()")
        .slice(0, 10)
        .toLowerCase();
      if (selector === NO_COLLATERAL)
        return {
          kind: "selector",
          name: "SettlementManager__NoCollateral",
          selector,
        };
      return { kind: "selector", name: "UnknownCustomError", selector };
    }
  }

  // 最差情况：只有 message
  return { kind: "message", message: msg };
}
```

注意：

- 如果你希望“精准识别”，前端应尽量使用 **TypeChain 生成的工厂/ABI**（让 custom error 进入 ABI）
- 当无法解析时，至少要保留 selector（例如上报 Sentry/日志），便于后续补全映射

### 6) 费用与分账（Fee Flow）

- **写入侧 SSOT**：费用类资金统一由 `FeeRouter` 路由与分发（前端通常不直接调用写入口）
- **预存分发**：清算/保证金等路径使用 `FeeRouter.distributePrepaid`；前端同样以 `FeeDistributed`/`FeeRouterView` 作为唯一拆分口径
- **读侧（推荐）**：`FeeRouterView` + 订阅 `DataPushed`

#### 6.1 重要：`platformTreasury` 与 `ecosystemVault` 可能相同（dirty state / 部署配置差异）

我们在本地（非清洁/dirty）环境实际跑出：`platformTreasury == ecosystemVault`。这种配置并不违反协议，但会导致一个常见误区：

- 如果你用“分别看两个地址余额变化（balance delta）”来推导 platform/eco 的拆分，
  - 你会看到 **两个 delta 都等于总额**（因为其实是同一个地址收到两笔转账/同一笔总额）
  - 从余额 delta 无法区分 platform/eco 的拆分比例

结论（必须写清楚）：

- **前端展示 platform/eco 拆分时，不要用余额 delta 推导**
- **拆分权威口径是 SSOT：`FeeDistributed` 事件 / `FeeRouterView` 推送统计**

#### 6.2 前端如何“正确展示拆分”（推荐两种实现）

**方案 A：基于交易回执解析 `FeeDistributed`（强一致，适合“本次交易详情页”）**

```ts
import { Interface } from "ethers";

const feeRouterIface = new Interface([
  "event FeeDistributed(address indexed token, uint256 platformAmount, uint256 ecoAmount)",
]);

export function parseFeeDistributed(
  receipt: any,
  feeRouterAddr: string,
  tokenAddr: string,
) {
  const target = tokenAddr.toLowerCase();
  const fr = feeRouterAddr.toLowerCase();
  for (const log of receipt.logs) {
    if ((log.address ?? "").toLowerCase() !== fr) continue;
    try {
      const parsed = feeRouterIface.parseLog(log);
      if (parsed?.name !== "FeeDistributed") continue;
      const token = String(parsed.args.token).toLowerCase();
      if (token !== target) continue;
      return {
        platformAmount: BigInt(parsed.args.platformAmount),
        ecoAmount: BigInt(parsed.args.ecoAmount),
      };
    } catch {
      // ignore
    }
  }
  return null;
}
```

**方案 B：基于 `FeeRouterView` / `DataPushed` 推送统计（适合“账户级历史/全局统计”）**

- 订阅 `DataPushed(bytes32 dataTypeHash, bytes payload)`：
  - `USER_FEE`（用户级费用记录）
  - `GLOBAL_FEE_STATS`（全局分发次数/分发总额）
- 或直接调用 `FeeRouterView` 的只读接口（如果你的前端不做链上事件索引）

#### 6.3 多租户/多环境的额外建议（避免 SSOT 漂移）

- 永远以 **Registry 解析出的模块地址**为准（FeeRouter/FeeRouterView/SettlementManager/各 View），不要硬编码“某个合约地址表”作为权威来源
- 费用拆分展示要容错：
  - 当 `platformTreasury == ecosystemVault` 时，UI 可以提示“平台与生态金库为同一地址（部署配置）”，但拆分金额仍以事件/统计展示

## 🔁 接口变更与迁移指南（2025-09）

### 1) 清算只读接口统一到 LiquidatorView（SystemView 不作为权威入口）

- 从本版本起，清算相关只读查询的权威入口为 `LiquidatorView`：
  - `getLiquidatorProfitView(liquidator)`
  - `getGlobalLiquidationView()`
  - `batchGetLiquidatorProfitViews(liquidators[])`
  - `getLiquidatorLeaderboard(limit)`
  - `getLiquidatorTempDebt(liquidator, asset)`
  - `getLiquidatorProfitRate()`
- `SystemView` 作为系统级聚合门面，可能会聚合/转发部分清算指标以便兼容旧调用，但**权威入口仍是 `LiquidatorView`**；前端请优先切换到 `LiquidatorView`。

示例（ethers v6）：

```ts
import { LiquidatorView__factory } from "@/types/factories";

export function getLiquidatorView(provider: any, addr: string) {
  return LiquidatorView__factory.connect(addr, provider);
}

export async function fetchLiquidatorStats(
  provider: any,
  addr: string,
  user: string,
) {
  const lv = getLiquidatorView(provider, addr);
  const profitView = await lv.getLiquidatorProfitView(user);
  const global = await lv.getGlobalLiquidationView();
  return { profitView, global };
}
```

### 2) 批量资产价格查询请使用 BatchView

- 批量资产价格：`BatchView.batchGetAssetPrices(assets[])`。
- 单资产价格：`ValuationOracleView.getAssetPrice(asset)`（返回 `price, blockNumber, isValid`）。

示例：

```ts
import { BatchView__factory } from "@/types/factories";

export async function batchFetchPrices(
  provider: any,
  batchViewAddr: string,
  assets: string[],
) {
  const bv = BatchView__factory.connect(batchViewAddr, provider);
  return bv.batchGetAssetPrices(assets); // 返回 { asset, price }[]
}
```

- 为了统一前端调用风格：所有 View 暴露 `registryAddrVar()`（部分合约仍保留 `registryAddr()` 兼容，后续移除）。

迁移建议：

```ts
const registryAddr = await systemView.registryAddrVar();
const registryAddr2 = await batchView.registryAddrVar(); // 推荐
```

### 3) SystemRiskView（system-only 风险参数入口）

- `SystemRiskView` 是 system-only 风险参数的**权威入口**：
  - `getLiquidationThreshold()`
  - `getMinHealthFactor()`
- `LiquidationRiskView` 已移除上述 system-only 接口；前端不得再调用旧入口。

### 4) UUPS \_authorizeUpgrade 与前端

- `_authorizeUpgrade` 为合约内部升级授权逻辑，不面向前端调用，无需在前端做任何适配。

- SystemView 为系统级聚合门面（可选）：可用于统一入口/兼容旧调用；但清算仍以 `LiquidatorView` 为权威入口，健康用 `HealthView`，价格用 `ValuationOracleView`，注册表用 `RegistryView`，统计用 `StatisticsView`，批量用 `BatchView`。
- 本文档示例基于 ethers v6 与自动生成的 TypeChain 工厂类（`@/types/factories`）。

## 🔄 接口变更与迁移指南（2026-01 · Breaking Changes）

本次升级对前端是 **破坏性变更**，请务必同步更新 TypeChain/ABI 与解包逻辑：

1. **UserView 用户维度新增 meta**
   - `getUserPosition/getUserPositionService/getUserCollateral/getUserDebt/getUserTotalCollateral/getUserTotalDebt`
   - `getHealthFactor/getUserHealthFactor/getUserStats`
   - `previewBorrow/previewDeposit/previewRepay/previewWithdraw`
   - `getUserTokenBalance/getUserSettlementBalanceStrict`（非缓存也统一返回 meta）

2. **DashboardView / CacheOptimizedView 返回结构调整**
   - `DashboardView.getUserOverview` → 追加 `positionValidFlags/positionBlockNumbers/positionVersions/healthBlockNumber`
   - `DashboardView.getUserAssetBreakdown` → 返回 `UserAssetOverviewMeta[]`（每项含 position meta）
   - `CacheOptimizedView.batchGetUserPositions` → `UserPositionItemMeta[]`
   - `CacheOptimizedView.getUserSummary` → 返回 `(summary, positionValidFlags, positionBlockNumbers, positionVersions, healthBlockNumber)`

3. **LiquidatorView / RewardView 用户读接口统一 meta**
   - `LiquidatorView.getUserLiquidationStats/getSeizableCollateralAmount/getSeizableCollaterals/getUserTotalCollateralValue`
   - `LiquidatorView.batchGetLiquidationStats`（返回 stats + meta）

- `RewardView.getUserBalanceWithMeta/getUserRewardSummaryWithMeta/getUserEarnStateWithMeta/getUserEasyEarnedWithMeta/getUserEasySpentWithMeta/getUserRecentActivitiesWithMeta`

4. **LendingEngineView / RiskView / ValuationOracleView / LiquidationRiskView（Scheme A）**
   - `getUserLoanCount/canAccessLoanOrder` → 增加 `isValid/blockNumber`
   - `calculateHealthFactorExcludingGuarantee` → 增加 `isValid/blockNumber`
   - `hasUpgradePermission` → 增加 `isValid/blockNumber`

- `getAssetPrice/getAssetPrices/isPriceValid/checkPriceOracleHealth/batchCheckPriceOracleHealth` → 增加 `isValid/blockNumber`（或 `validFlags[]/blockNumbers[]`）
- `LiquidationRiskView` 用户读与 batch 读均增加 `isValid/blockNumber`

5. **FeeRouterView 批量空数组必须 revert**
   - `batchGetUserFeeStatisticsWithMeta` / `batchGetGlobalFeeStatisticsWithMeta` / `getUserFeeAnalyticsWithMeta`
   - 空数组统一 `revert EmptyArray()`；长度不匹配仍 `ArrayLengthMismatch`

前端迁移建议：

- 先更新 TypeChain/ABI，再逐处替换解包（例如 `const [value] = await view.fn(...)`）。
- UI 必须处理 `isValid=false` / `blockNumber=0` 的降级展示（详见 §2.1.4）。

## 📦 监控相关新模块 (2025-08 升级)

| Registry Key              | 合约                 | 目录                                            |
| ------------------------- | -------------------- | ----------------------------------------------- |
| `KEY_DEGRADATION_CORE`    | `DegradationCore`    | `contracts/core/monitor/DegradationCore.sol`    |
| `KEY_DEGRADATION_MONITOR` | `DegradationMonitor` | `contracts/core/monitor/DegradationMonitor.sol` |

> ⚠️ 旧的 `GracefulDegradation*` 模块已迁移到 `core/monitor/` 路径，名称保持兼容，但前端应尽快切换到上表新 Key。

补充说明（重要）：

- **写路径 SSOT（单入口协调器）**：
  - 系统级降级事件记录应统一从 `DegradationMonitor` 进入（如 `recordDegradationEvent*`），由其协调写入 `DegradationCore`（聚合统计）与 `DegradationStorage`（ring-buffer 历史）。
  - 子模块写入默认允许 `msg.sender == Registry[KEY_DEGRADATION_MONITOR]`，避免给 Monitor 合约授 `ACTION_ADMIN`（最小权限）。
- **趋势查询 `getSystemDegradationTrends()` 的 SSOT/口径**：
  - 若 `DegradationMonitor` 配置了 analytics 子模块（`_analyticsModuleAddr != 0` 且有代码），则趋势读取为 **O(1)**，直接转发至 analytics。
  - 若 analytics **未配置/为空**（本仓库默认；历史实现已移除），则 `DegradationMonitor` 会采用 **方案 A**（read-time 计算）：
    - `recentEvents` / `mostFrequentModule`：从 `DegradationStorage` 的环形缓冲区（最多 **100** 条）扫描计算。
    - `totalEvents` / `averageFallbackValue`：优先读取 `DegradationCore` 的聚合统计（生命周期累计）；若 Core 不可用则退化为缓冲区窗口统计。
  - `recentEvents` 的“最近窗口”以 **block 口径**定义：`ViewConstants.CACHE_DURATION_BLOCKS`（链无关；不要用 seconds）。

## 🧾 EventHistoryManager（前端协作：历史/活动流的权威事件入口）

`EventHistoryManager` 是 **events-only** 的“历史记录入口”：链上不存储历史列表，所有历史/活动都应通过事件与 `DataPushed` 供链下索引服务消费。

- **写入侧（链上模块/后端）**：
  - `recordEvent(eventType, user, asset, amount, extraData)`（需要 `ACTION_MANAGE_EVENT_HISTORY`）
  - 触发事件：`HistoryRecorded(eventType, user, asset, amount, extraData, blockNumber)`
  - 同时发出 Unified DataPush：`DataPushed(DATA_TYPE_HISTORY, abi.encode(...))`

- **前端协作要点**：
  - **前端不应尝试“链上查询历史”**：合约没有 `getHistory(...)` 之类的读接口。
  - 前端应依赖 **链下 Indexer / Read Service**（订阅 `DataPushed` 或 `HistoryRecorded`）提供分页/筛选。
  - `eventType` 建议统一用 `keccak256("UPPER_SNAKE_CASE")`，并在前端/后端共享映射表（可与 `DataPushTypes` 统一管理）。

### 9. Unified DataPush Integration (v1)

所有前端监听服务应仅订阅 `DataPushed(bytes32 indexed dataTypeHash, bytes payload)`。

> Reward 事件解码口径：下表中的 Reward/Easy 数值字段都表示 Easy 数量（SSOT = `Registry[KEY_EASY_TOKEN]`；18 decimals）。前端/索引层只按当前 schema 解码；若本地历史 decoder 仍使用旧字段名，只允许在解析层做一次映射，不再在事件表逐项维护兼容别名。

```ts
// ethers v6 – example
const iface = new Interface([
  "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
]);
provider.on({ topics: [iface.getEvent("DataPushed").topic] }, (log) => {
  const { dataTypeHash, payload } = iface.parseLog(log).args;
  switch (dataTypeHash) {
    case keccak256(toUtf8Bytes("USER_FEE")):
      const [user, feeType, amount] = AbiCoder.defaultAbiCoder().decode(
        ["address", "bytes32", "uint256"],
        payload,
      );
      // ... handle
      break;
    // ... other cases
  }
});
```

| dataTypeHash                    | Producer                                              | Decoding Schema                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USER_FEE`                      | `FeeRouterView`                                       | `(address user, bytes32 feeType, uint256 amount, uint256 personalFeeBps)`                                                                                       |
| `GLOBAL_FEE_STATS`              | `FeeRouterView`                                       | `(uint256 totalDistributions, uint256 totalAmount)`                                                                                                             |
| `EASY_MINTED`                   | `RewardView`                                          | `(address borrower, address lender, uint256 totalMinted, uint256 borrowerShare, uint256 lenderShare, uint256 orderId, uint256 amountUsd8, uint256 blockNumber)` |
| `REWARD_BURNED`                 | `RewardView`                                          | `(address user, uint256 amount, string reason, uint256 blockNumber)`                                                                                            |
| `REWARD_LEVEL_UPDATED`          | `RewardView`                                          | `(address user, uint8 level, uint256 blockNumber)`                                                                                                              |
| `REWARD_STATS_UPDATED`          | `RewardView`                                          | `(uint256 totalBatchOps, uint256 totalCachedRewards, uint256 blockNumber)`                                                                                      |
| `REWARD_PENALTY_LEDGER_UPDATED` | `RewardView`                                          | `(address user, uint256 pendingDebt, uint256 blockNumber)`                                                                                                      |
| `REWARD_EARN_STATE_UPDATED`     | `RewardView`                                          | `(address user, uint256 lockedEasy, uint256 eligibleLoanCount, uint256 onTimeRepayCount, uint256 blockNumber)`                                                  |
| `EASY_SPENT`                    | `RewardView`                                          | `(address user, uint8 spendType, uint256 amount, uint256 blockNumber)`                                                                                          |
| `EASY_RECYCLED_SPLIT`           | `RewardView`                                          | `(address payer, uint256 amount, uint256 burnAmount, uint256 teamAmount, uint256 ecoAmount, uint8 spendType, uint256 blockNumber)`                              |
| `DEPOSIT_PROCESSED`             | `CollateralManager`                                   | `(address user, address asset, uint256 amount, uint256 blockNumber)`                                                                                            |
| `WITHDRAW_PROCESSED`            | `CollateralManager`                                   | `(address user, address asset, uint256 amount, uint256 blockNumber)`                                                                                            |
| `BATCH_DEPOSIT_PROCESSED`       | `CollateralManager`                                   | `(address user, uint256 operationCount, uint256 blockNumber)`                                                                                                   |
| `BATCH_WITHDRAW_PROCESSED`      | `CollateralManager`                                   | `(address user, uint256 operationCount, uint256 blockNumber)`                                                                                                   |
| `USER_DEGRADATION`              | `CollateralManager` / `LendingEngine` / `PriceOracle` | `(address user, address module, address asset, string reason, bool usedFallback, uint256 value, uint256 blockNumber)`                                           |
| `MODULE_HEALTH`                 | `ModuleHealthView`                                    | `(address module, bool ok, bytes32 detailsHash, uint32 failures, uint256 ts)`                                                                                   |
| `SYSTEM_STATUS_CACHE`           | `ViewCache`                                           | `(address asset, uint256 collateral, uint256 debt, uint256 util, uint256 ts)`                                                                                   |

| `USER_DATA_UPDATE` | `CacheOptimizedView` | `(address user, uint256 healthFactor, uint256 totalCollateral, uint256 totalDebt)` |
| `POSITION_DATA_UPDATE` | `CacheOptimizedView` | `(address user, address asset, uint256 collateral, uint256 debt)` |
| `GLOBAL_STATS_UPDATE` | `CacheOptimizedView` | `(bytes32 dataKey, uint256 value)` |
| `GLOBAL_DEGRADATION` | `DegradationMonitor` / `DegradationCore` | `(implementation-defined; see core/monitor)` |
| `ASSET_WHITELIST_ADDED` | `AssetWhitelist` | `(address asset, address actor, uint256 ts)` |
| `ASSET_WHITELIST_REMOVED` | `AssetWhitelist` | `(address asset, address actor, uint256 ts)` |
| `ASSET_WHITELIST_BATCH_ADDED` | `AssetWhitelist` | `(address[] assets, address actor, uint256 addedCount, uint256 totalCount, uint256 ts)` |
| `ASSET_WHITELIST_BATCH_REMOVED` | `AssetWhitelist` | `(address[] assets, address actor, uint256 removedCount, uint256 totalCount, uint256 ts)` |
| `ASSET_WHITELIST_INFO_UPDATED` | `AssetWhitelist` | `(address asset, address actor, uint256 ts)` |
| `ASSET_WHITELIST_REGISTRY_UPDATED` | `AssetWhitelist` | `(address oldRegistry, address newRegistry, address actor, uint256 ts)` |

Reward 事件表只保留当前 payload schema；不要再把 `points`、`walletPoints`、`availablePoints` 一类历史字段名写进前端契约文档。

#### Reward 字段命名对照表（前端强约束）

| 旧名（应移除）                                                 | 标准名（必须保留）                                                                | 适用范围                        | 约束说明                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `points` / `rewardPoints` / `userPoints`                       | `easyAmount` 或按语义拆分为 `walletEasyBalance` / `lockedEasy` / `pendingPenalty` | 通用 Reward 数值字段            | 禁止继续用 points 泛指 Reward 数量；进入前端业务层后必须改成 Easy 语义名。                                      |
| `walletPoints` / `rewardBalance`                               | `walletEasyBalance`                                                               | 用户钱包可见 Reward 余额        | 对应 `RewardView.getUserBalanceWithMeta(user).balance`；展示、store、selector、DTO 统一使用该名。               |
| `availablePoints` / `spendablePoints`                          | `availableEasyBalance`                                                            | 前端消费前校验、消费页展示      | 表示 `max(walletEasyBalance - pendingPenalty, 0)`；不要再创造第二套“可消费积分”命名。                           |
| `penaltyPoints` / `debtPoints`                                 | `pendingPenalty`                                                                  | Penalty 读模型、消费前校验      | 对应 `REWARD_PENALTY_LEDGER_UPDATED.pendingDebt` 和 RewardSummary 里的待抵扣负债；前端统一叫 `pendingPenalty`。 |
| `lockedPoints` / `frozenPoints`                                | `lockedEasy`                                                                      | Earn 状态、借贷锁定观测         | 对应 `getUserEarnStateWithMeta(user)` 与 `REWARD_EARN_STATE_UPDATED`。                                          |
| `qualifiedOrderCount` / `eligibleOrders`                       | `eligibleLoanCount`                                                               | Earn 状态                       | 与链上 schema 保持同名，不再改写成前端自造别名。                                                                |
| `repaySuccessCount` / `onTimeRepays` / `repayHits`             | `onTimeRepayCount`                                                                | Earn 状态                       | 与链上 schema 保持同名，不再缩写或改写。                                                                        |
| `levelId` / `rewardTier`                                       | `level`                                                                           | Reward 等级展示与事件解码       | 对应 `REWARD_LEVEL_UPDATED.level`；如果 UI 需要文案，再单独映射显示文本，不改底层字段名。                       |
| `spentPoints` / `consumedPoints`                               | `easySpentAmount` 或事件原名 `amount`                                             | 消费事件解码、前端活动流        | 事件解码层可保留 payload 原名 `amount`；进入前端业务对象后建议命名为 `easySpentAmount`。                        |
| `recycledPoints` / `burnedPoints` / `teamPoints` / `ecoPoints` | `recycledEasyAmount` / `burnAmount` / `teamAmount` / `ecoAmount`                  | `EASY_RECYCLED_SPLIT` 解码结果  | Split 结果必须保留 Easy / burn / team / eco 语义，禁止重新包装成 points 口径。                                  |
| `account` / `wallet`（在 Reward payload 中代替 user）          | `user`                                                                            | Reward 事件 payload、Reward DTO | 事件 schema 已固定用 `user`；前端解码对象默认也应保留 `user`。                                                  |
| `ts` / `timestamp`（替代 Reward 事件里的区块字段）             | `blockNumber`                                                                     | Reward 事件 payload、Reward DTO | Reward 事件当前统一使用 `blockNumber`；如果前端要展示 wall-clock time，应在索引层派生，不改 payload 字段名。    |

- 解析层兼容规则：如果历史 decoder 仍输出旧名，只允许在 decoder adapter 里做一次映射；进入前端 store / hook / selector / DTO 后必须全部切换到“标准名”。
- 文档与代码约束：新的前端示例、接口类型、状态字段、表格列名，不得再出现 `points`、`walletPoints`、`availablePoints` 这一类旧口径。
- 事件解码约束：事件 payload 字段优先保持与链上 schema 同名；只有进入前端业务对象时，才允许把通用 `amount` 显式命名成 `easyAmount` / `easySpentAmount` / `recycledEasyAmount`。

> 前端解析逻辑应**避免**硬编码 ABI，统一通过 Hash → Schema map 自动解码。

#### 9.1 AssetWhitelist DataPush “schema SSOT”（给 indexer 的最小建模建议）

> 说明：当前仓库尚未引入链下 indexer 的 schema 工程，因此本小节作为临时 SSOT。后续落地 indexer 时请把本节内容迁移为正式 schema/decoder。

- **订阅事件**：统一订阅 `DataPushed(bytes32 indexed dataTypeHash, bytes payload)`（不要同时依赖 `AssetAdded/AssetRemoved/...`，避免重复消费）
- **类型常量来源（SSOT）**：`src/constants/DataPushTypes.sol`
- **Producer 合约**：`src/access/AssetWhitelist.sol`

推荐 indexer 表结构（最小）：

- `asset_whitelist_events`：
  - `dataTypeHash` (bytes32)
  - `asset` (address, nullable) — 批量事件可置空，改用数组字段或拆分多行
  - `assets` (address[], nullable)
  - `actor` (address)
  - `addedCount/removedCount/totalCount` (uint256, nullable)
  - `oldRegistry/newRegistry` (address, nullable)
  - `blockNumber` (uint256)
  - `blockNumber` / `txHash` / `logIndex`（用于幂等与回溯）

解码要点：

- `ASSET_WHITELIST_*` 的 `payload` 均为 `abi.encode(...)`，按上表的 “Decoding Schema” 直接 `AbiCoder.defaultAbiCoder().decode([...], payload)` 即可。
- 对于批量事件：
  - **方案 A（推荐）**：indexer 拆分为多行（每个 asset 一行），并共享同一 `(blockNumber, txHash, logIndex)` 作为父关联键。
  - **方案 B**：保留数组字段（适合 Postgres/BigQuery），查询时再展开。

### 10. 用户级优雅降级事件订阅（前端）

> 说明：自 2025-08 起，业务合约会在“带降级”路径中直接上报用户级事件，前端可按登录地址过滤展示专属于该用户的降级记录。

```ts
import { Interface, AbiCoder, toUtf8Bytes, keccak256 } from "ethers";

const iface = new Interface([
  "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
]);
const TOPIC = iface.getEvent("DataPushed").topic;
const USER_DEGRADATION = keccak256(toUtf8Bytes("USER_DEGRADATION"));

provider.on({ topics: [TOPIC, USER_DEGRADATION] }, (log) => {
  const parsed = iface.parseLog(log);
  const { dataTypeHash, payload } = parsed.args as {
    dataTypeHash: string;
    payload: string;
  };
  if (dataTypeHash !== USER_DEGRADATION) return;
  const [user, module, asset, reason, usedFallback, value, blockNumber] =
    AbiCoder.defaultAbiCoder().decode(
      ["address", "address", "address", "string", "bool", "uint256", "uint256"],
      payload,
    );

  // 仅展示当前登录用户
  if (user.toLowerCase() !== connectedAddress.toLowerCase()) return;
  // 渲染到“我的降级记录”页签
  addUserDegradation({
    user,
    module,
    asset,
    reason,
    usedFallback,
    value,
    blockNumber: Number(blockNumber),
  });
});
```

提示：管理员/Owner 可继续通过 `DegradationMonitor` 的只读接口查看系统级统计与历史；普通用户仅依赖该事件进行“只看自己”的前端展示。

### 11. 缓存推送失败重试（CacheUpdateFailed）前端配合

> 说明：推送失败策略是**分层的**（不是“一刀切”）：
>
> - **PositionView guarded 读取失败**会 emit `CacheUpdateFailed(...)`（主流程不中断，靠链下重试/告警闭环）。
> - **部分 best-effort 推送模块**（如 `LendingEngineCore`/`LiquidationManager`）也会 emit 同 ABI 的 `CacheUpdateFailed(...)`；请用 `contract_address` 区分来源。
> - 其它写路径可能选择“失败即回滚”以维持强一致（以链上实际 revert 原因为准）。
>   前端需针对“有事件可观测”的场景做提示与交互闭环。

#### 11.1 事件监听

- 订阅 `CacheUpdateFailed` **与** `CacheUpdateFailedWithContext`：
  - `CacheUpdateFailed`：兼容事件，字段为 `(user, asset, viewAddr, collateral, debt, reason)`
  - `CacheUpdateFailedWithContext`：新增上下文字段 `(requestId, seq, nextVersion)`，用于并发/幂等诊断
- 主要来源：
  - `PositionView` 的 guarded 读取失败
  - 部分 best-effort 推送模块（如 `LendingEngineCore`/`LiquidationManager`）
  - 使用 `contract_address` 区分来源
  - 过滤当前登录用户：`args.user.toLowerCase() === connectedAddress.toLowerCase()`
  - 记录 `asset` / `viewAddr` / `reason` / `blockNumber` / `logIndex`，作为重试幂等键
- 可选：在同一监听服务中并入 `DataPushed`，便于统一管道

#### 11.2 UI/状态展示

- 当用户/资产存在未清理的失败记录：
  - 在资产卡/仓位页显示 “缓存更新失败，已排队人工处理”
  - 展示最近失败时间、原因摘要（截断 bytes reason）
  - 若来自 `CacheUpdateFailedWithContext`，可展示 `requestId/seq/nextVersion` 作为诊断信息
  - 标记缓存数据“可能陈旧”，提示刷新时间
- 若后端提供重试 API，则提供“请求重试”按钮（前端不直接持有 admin）

#### 11.3 后端协同（调用约定）

- 后端监听事件 → 写 `cache_retry_jobs` 队列 → 值班/自动策略调用链上 `PositionView.retryUserPositionUpdate(user, asset)`（仅 admin）。若推送因模块缓存过期被拒，可要求运维调用 `PositionView.refreshModuleCache()` 或 `VaultRouter.refreshModuleCache()` 后再重试。
- 前端调用后端 API：
  - `POST /cache-retry/request` `{ user, asset, viewAddr, blockNumber, logIndex }`
  - `GET /cache-retry/status?user=&asset=` 返回队列状态、最近重试时间、尝试次数
- 成功后端应广播/回写状态（可用 WebSocket/SSE）以更新前端提示

#### 11.4 兼容与降级

- 若前端未连接监听服务，可在用户登录后查询重试队列表（后端接口）并补渲染提示
- 未提供重试 API 时，只做告警提示，不露出“请求重试”按钮

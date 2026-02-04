# RWA 借贷平台借款/贷款使用指南

> 本文档提供 RWA 借贷平台借款和贷款功能的完整使用指南，涵盖存款、借款、还款、提取等核心操作。

## 📋 目录

1. [快速开始](#快速开始)
2. [系统概述](#系统概述)
3. [核心概念](#核心概念)
4. [基础操作](#基础操作)
5. [查询功能](#查询功能)
6. [高级功能](#高级功能)
7. [健康因子与风险管理](#健康因子与风险管理)
8. [实际应用示例](#实际应用示例)
9. [最佳实践](#最佳实践)
10. [故障排除](#故障排除)

---

## 🚀 快速开始

### 5分钟快速上手

#### 1. 连接合约

```typescript
import { ethers } from 'ethers';
import { IVaultCore__factory } from '../types/contracts/Vault';
import { IVaultRouter__factory } from '../types/contracts/Vault';

// 合约地址（部署后替换）
const VAULT_CORE_ADDRESS = "0x...";
const VAULT_VIEW_ADDRESS = "0x...";

const signer = await ethers.getSigner();
const vaultCore = IVaultCore__factory.connect(VAULT_CORE_ADDRESS, signer);
const vaultRouter = IVaultRouter__factory.connect(VAULT_VIEW_ADDRESS, signer);
```

#### 2. 存入抵押物

```typescript
// 1. 批准代币转账
const usdcAddress = "0x...";
const amount = ethers.parseUnits("1000", 6); // 1000 USDC

const erc20 = await ethers.getContractAt("IERC20", usdcAddress);
await erc20.approve(VAULT_CORE_ADDRESS, amount);

// 2. 存入抵押物
await vaultCore.deposit(usdcAddress, amount);
console.log("✅ 抵押物存入成功");
```

#### 3. 借款

```typescript
// 借款（需要足够的抵押物）
const borrowAmount = ethers.parseUnits("500", 6); // 借 500 USDC
await vaultCore.borrow(usdcAddress, borrowAmount);
console.log("✅ 借款成功");
```

#### 4. 查询状态

```typescript
// 查询抵押物
const [collateral] = await userView.getUserCollateral(userAddress, usdcAddress);
console.log(`抵押物: ${ethers.formatUnits(collateral, 6)} USDC`);

// 查询债务
const [debt] = await userView.getUserDebt(userAddress, usdcAddress);
console.log(`债务: ${ethers.formatUnits(debt, 6)} USDC`);

// 查询健康因子
const [healthFactor, isValid] = await userView.getUserHealthFactor(userAddress);
console.log(`健康因子: ${healthFactor.toString()} (valid=${isValid})`);
```

#### 5. 还款

```typescript
// 1. 批准还款金额
const repayAmount = ethers.parseUnits("500", 6);
await erc20.approve(VAULT_CORE_ADDRESS, repayAmount);

// 2. 还款
await vaultCore.repay(orderId, usdcAddress, repayAmount);
console.log("✅ 还款成功");
```

#### 6. 提取抵押物

```typescript
// 提取抵押物（需要健康因子足够高）
const withdrawAmount = ethers.parseUnits("500", 6);
await vaultCore.withdraw(usdcAddress, withdrawAmount);
console.log("✅ 提取成功");
```

---

## 系统概述

### 架构设计

RWA 借贷平台采用**双架构设计**：

```
用户操作流程：
┌──────────┐    ┌──────────┐    ┌──────────────┐    ┌─────────────────┐
│  用户    │───►│VaultCore │───►│  VaultRouter   │───►│ 业务模块        │
│          │    │ (入口)   │    │ (协调器)     │    │ (Collateral/LE) │
└──────────┘    └──────────┘    └──────────────┘    └─────────────────┘
                                                          │
                                                          ▼
                                                    ┌──────────────┐
                                                    │  View 模块    │
                                                    │ (查询接口)    │
                                                    └──────────────┘
```

### 核心组件

| 组件 | 功能 | 位置 |
|------|------|------|
| **VaultCore** | 用户操作入口 | `src/Vault/VaultCore.sol` |
| **VaultRouter** | 操作协调器 | `src/Vault/VaultRouter.sol` |
| **CollateralManager** | 抵押物管理 | `src/Vault/modules/CollateralManager.sol` |
| **VaultLendingEngine** | 借贷账本 | `src/Vault/modules/VaultLendingEngine.sol` |
| **LendingEngine** | 贷款订单管理 | `src/core/LendingEngine.sol` |
| **HealthView** | 健康因子查询 | `src/Vault/view/modules/HealthView.sol` |
| **UserView** | 用户数据查询 | `src/Vault/view/modules/UserView.sol` |

---

## 核心概念

### 1. 抵押物（Collateral）

用户存入的资产，用作借款的担保。

**特点**：
- 支持多资产抵押
- 资产必须在白名单中
- 抵押物价值用于计算可借额度

### 2. 债务（Debt）

用户借入的资产数量。

**特点**：
- 支持多资产借贷
- 需要支付利息
- 债务价值影响健康因子

### 3. 健康因子（Health Factor）

衡量用户借贷安全性的指标。

**计算公式**：
```
健康因子 = (抵押物价值 × 10000) / 债务价值
```

**阈值**：
- `≥ 11000` (110%)：安全
- `< 11000` (110%)：风险
- `< 10000` (100%)：可被清算

### 4. 贷款价值比（LTV）

债务价值与抵押物价值的比例。

**计算公式**：
```
LTV = (债务价值 × 10000) / 抵押物价值
```

---

## 基础操作

### 1. 存入抵押物（Deposit）

#### 操作流程

```typescript
/**
 * 存入抵押物
 * @param asset 资产地址
 * @param amount 存入金额
 */
async function depositCollateral(asset: string, amount: bigint) {
    // 1. 检查资产是否在白名单中（前端检查）
    // 2. 批准代币转账
    const erc20 = await ethers.getContractAt("IERC20", asset);
    const allowance = await erc20.allowance(userAddress, vaultCoreAddress);
    
    if (allowance < amount) {
        const tx = await erc20.approve(vaultCoreAddress, amount);
        await tx.wait();
        console.log("✅ 代币批准成功");
    }
    
    // 3. 存入抵押物
    const tx = await vaultCore.deposit(asset, amount);
    const receipt = await tx.wait();
    
    console.log(`✅ 存入成功: ${ethers.formatUnits(amount, decimals)}`);
    console.log(`交易哈希: ${receipt.hash}`);
    
    return receipt;
}
```

#### Solidity 调用

```solidity
// 直接调用 VaultCore
IVaultCore vaultCore = IVaultCore(vaultCoreAddress);
vaultCore.deposit(assetAddress, amount);
```

#### 前置条件

1. ✅ 资产必须在白名单中
2. ✅ 用户余额充足
3. ✅ 已批准足够的代币额度

#### 事件监听

```typescript
vaultCore.on("CollateralDeposited", (user, asset, amount, event) => {
    console.log(`用户 ${user} 存入 ${amount} 的 ${asset}`);
});
```

---

### 2. 借款（Borrow）

#### 操作流程

```typescript
/**
 * 借款
 * @param asset 借款资产地址
 * @param amount 借款金额
 */
async function borrowAsset(asset: string, amount: bigint) {
    // 1. 检查健康因子（借款前）
    const [healthFactorBefore, isValidBefore] = await userView.getUserHealthFactor(userAddress);
    console.log(`借款前健康因子: ${healthFactorBefore.toString()}`);
    
    // 2. 检查可借额度
    const [maxBorrowable] = await previewView.getMaxBorrowableWithMeta(userAddress, asset);
    if (amount > maxBorrowable) {
        throw new Error(`借款金额超过可借额度: ${maxBorrowable}`);
    }
    
    // 3. 执行借款
    const tx = await vaultCore.borrow(asset, amount);
    const receipt = await tx.wait();
    
    // 4. 检查健康因子（借款后）
    const [healthFactorAfter, isValidAfter] = await userView.getUserHealthFactor(userAddress);
    console.log(`借款后健康因子: ${healthFactorAfter.toString()}`);
    
    console.log(`✅ 借款成功: ${ethers.formatUnits(amount, decimals)}`);
    return receipt;
}
```

#### 前置条件

1. ✅ 有足够的抵押物
2. ✅ 健康因子满足要求（通常 ≥ 110%）
3. ✅ 合约有足够的流动性
4. ✅ 资产在白名单中

#### 健康因子检查

```typescript
/**
 * 检查是否可以借款
 * @param user 用户地址
 * @param asset 借款资产
 * @param amount 借款金额
 * @returns 是否可以借款
 */
async function canBorrow(user: string, asset: string, amount: bigint): Promise<boolean> {
    // 1. 获取当前健康因子
    const [currentHF, currentValid] = await userView.getUserHealthFactor(user);
    
    // 2. 预览借款后的健康因子
    const [previewHF] = await previewView.previewBorrow(user, asset, 0n, 0n, amount);
    
    // 3. 检查是否满足最小健康因子（110%）
    const minHF = 11000; // 110% in bps
    return previewHF >= minHF;
}
```

---

### 3. 还款（Repay）

#### 操作流程

```typescript
/**
 * 还款
 * @param asset 还款资产地址
 * @param amount 还款金额（0 表示全额还款）
 */
async function repayDebt(asset: string, amount: bigint = 0n) {
    // 1. 查询当前债务
    const [currentDebt] = await userView.getUserDebt(userAddress, asset);
    
    // 2. 确定还款金额
    const repayAmount = amount === 0n ? currentDebt : amount;
    
    if (repayAmount > currentDebt) {
        throw new Error("还款金额超过债务");
    }
    
    // 3. 批准代币转账
    const erc20 = await ethers.getContractAt("IERC20", asset);
    const allowance = await erc20.allowance(userAddress, vaultCoreAddress);
    
    if (allowance < repayAmount) {
        const approveTx = await erc20.approve(vaultCoreAddress, repayAmount);
        await approveTx.wait();
    }
    
    // 4. 执行还款
    const tx = await vaultCore.repay(orderId, asset, repayAmount);
    const receipt = await tx.wait();
    
    // 5. 查询剩余债务
    const [remainingDebt] = await userView.getUserDebt(userAddress, asset);
    console.log(`✅ 还款成功，剩余债务: ${ethers.formatUnits(remainingDebt, decimals)}`);
    
    return receipt;
}
```

#### 全额还款

```typescript
// 全额还款（传入 0）
await vaultCore.repay(orderId, assetAddress, 0);
```

#### 部分还款

```typescript
// 部分还款
const partialAmount = ethers.parseUnits("100", 6);
await vaultCore.repay(orderId, assetAddress, partialAmount);
```

---

### 4. 提取抵押物（Withdraw）

#### 操作流程

```typescript
/**
 * 提取抵押物
 * @param asset 资产地址
 * @param amount 提取金额
 */
async function withdrawCollateral(asset: string, amount: bigint) {
    // 1. 检查当前抵押物
    const [currentCollateral] = await userView.getUserCollateral(userAddress, asset);
    if (amount > currentCollateral) {
        throw new Error("提取金额超过抵押物");
    }
    
    // 2. 预览提取后的健康因子
    const [previewHF] = await previewView.previewWithdraw(userAddress, asset, amount);
    const minHF = 11000; // 110%
    
    if (previewHF < minHF) {
        throw new Error(`提取后健康因子过低: ${previewHF}, 最小要求: ${minHF}`);
    }
    
    // 3. 执行提取
    const tx = await vaultCore.withdraw(asset, amount);
    const receipt = await tx.wait();
    
    console.log(`✅ 提取成功: ${ethers.formatUnits(amount, decimals)}`);
    return receipt;
}
```

#### 前置条件

1. ✅ 有足够的抵押物
2. ✅ 提取后健康因子 ≥ 110%
3. ✅ 无未偿还债务（可选，取决于系统配置）

---

## 查询功能

### 用户状态查询

#### 查询抵押物

```typescript
/**
 * 查询用户抵押物
 * @param user 用户地址
 * @param asset 资产地址
 * @returns 抵押物数量
 */
async function getUserCollateral(user: string, asset: string): Promise<bigint> {
    const [collateral] = await userView.getUserCollateral(user, asset);
    return collateral;
}

// 查询所有资产的抵押物
async function getAllUserCollateral(user: string) {
    const assets = await vaultRouter.getUserCollateralAssets(user);
    const collateral: Record<string, bigint> = {};
    
    for (const asset of assets) {
        [collateral[asset]] = await userView.getUserCollateral(user, asset);
    }
    
    return collateral;
}
```

#### 查询债务

```typescript
/**
 * 查询用户债务
 * @param user 用户地址
 * @param asset 资产地址
 * @returns 债务数量
 */
async function getUserDebt(user: string, asset: string): Promise<bigint> {
    const [debt] = await userView.getUserDebt(user, asset);
    return debt;
}

// 查询所有资产的债务
async function getAllUserDebt(user: string) {
    const assets = await vaultRouter.getUserDebtAssets(user);
    const debt: Record<string, bigint> = {};
    
    for (const asset of assets) {
        [debt[asset]] = await userView.getUserDebt(user, asset);
    }
    
    return debt;
}
```

#### 查询总抵押物价值

```typescript
/**
 * 查询用户总抵押物价值（以结算币计价）
 * @param user 用户地址
 * @returns 总抵押物价值
 */
async function getUserTotalCollateral(user: string): Promise<bigint> {
    const [totalCollateral] = await userView.getUserTotalCollateral(user);
    return totalCollateral;
}
```

#### 查询总债务价值

```typescript
/**
 * 查询用户总债务价值（以结算币计价）
 * @param user 用户地址
 * @returns 总债务价值
 */
async function getUserTotalDebt(user: string): Promise<bigint> {
    const [totalDebt] = await userView.getUserTotalDebt(user);
    return totalDebt;
}
```

### 健康因子查询

#### 查询健康因子

```typescript
/**
 * 查询用户健康因子
 * @param user 用户地址
 * @returns {healthFactor, isValid}
 */
async function getUserHealthFactorWithMeta(user: string) {
    const healthView = await ethers.getContractAt(
        "HealthView",
        await getHealthViewAddress()
    );
    
    const [healthFactor, isValid] = await healthView.getUserHealthFactorWithMeta(user);
    
    return {
        healthFactor: healthFactor.toString(),
        isValid,
        healthFactorPercent: (Number(healthFactor) / 100).toFixed(2) + "%"
    };
}
```

#### 健康因子状态判断

```typescript
/**
 * 判断健康因子状态
 * @param healthFactor 健康因子（bps）
 * @returns 状态描述
 */
function getHealthFactorStatus(healthFactor: bigint): string {
    if (healthFactor >= 15000n) return "非常安全";
    if (healthFactor >= 11000n) return "安全";
    if (healthFactor >= 10000n) return "警告";
    return "危险（可能被清算）";
}
```

### 可借额度查询

#### 查询最大可借额度

```typescript
/**
 * 查询用户最大可借额度
 * @param user 用户地址
 * @param asset 借款资产
 * @returns 最大可借金额
 */
async function getMaxBorrowable(user: string, asset: string): Promise<bigint> {
    const [maxBorrowable] = await previewView.getMaxBorrowableWithMeta(user, asset);
    return maxBorrowable;
}
```

#### 预览操作

```typescript
/**
 * 预览借款后的健康因子
 * @param user 用户地址
 * @param asset 借款资产
 * @param amount 借款金额
 * @returns 预览健康因子
 */
async function previewBorrow(
    user: string,
    asset: string,
    amount: bigint
): Promise<bigint> {
    const [newHF] = await previewView.previewBorrow(user, asset, 0n, 0n, amount);
    return newHF;
}

/**
 * 预览提取后的健康因子
 * @param user 用户地址
 * @param asset 提取资产
 * @param amount 提取金额
 * @returns 预览健康因子
 */
async function previewWithdraw(
    user: string,
    asset: string,
    amount: bigint
): Promise<bigint> {
    const [hfAfter] = await previewView.previewWithdraw(user, asset, amount);
    return hfAfter;
}
```

---

## 高级功能

### 批量操作

#### 批量存入

```typescript
/**
 * 批量存入多个资产
 * @param assets 资产地址数组
 * @param amounts 金额数组
 */
async function batchDeposit(assets: string[], amounts: bigint[]) {
    if (assets.length !== amounts.length) {
        throw new Error("数组长度不匹配");
    }
    
    // 1. 批准所有代币
    for (let i = 0; i < assets.length; i++) {
        const erc20 = await ethers.getContractAt("IERC20", assets[i]);
        await erc20.approve(vaultCoreAddress, amounts[i]);
    }
    
    // 2. 批量存入
    const tx = await vaultCore.batchDeposit(assets, amounts);
    await tx.wait();
    
    console.log("✅ 批量存入成功");
}
```

#### 批量借款

```typescript
/**
 * 批量借款多个资产
 * @param assets 资产地址数组
 * @param amounts 金额数组
 */
async function batchBorrow(assets: string[], amounts: bigint[]) {
    // 检查健康因子
    const [healthFactor, isValid] = await userView.getUserHealthFactor(userAddress);
    if (healthFactor < 11000n) {
        throw new Error("健康因子不足，无法借款");
    }
    
    const tx = await vaultCore.batchBorrow(assets, amounts);
    await tx.wait();
    
    console.log("✅ 批量借款成功");
}
```

### 复合操作

#### 存入并借款（原子操作）

```typescript
/**
 * 存入抵押物并立即借款
 * @param collateralAsset 抵押资产
 * @param collateralAmount 抵押金额
 * @param borrowAsset 借款资产
 * @param borrowAmount 借款金额
 */
async function depositAndBorrow(
    collateralAsset: string,
    collateralAmount: bigint,
    borrowAsset: string,
    borrowAmount: bigint
) {
    // 1. 批准抵押资产
    const collateralToken = await ethers.getContractAt("IERC20", collateralAsset);
    await collateralToken.approve(vaultCoreAddress, collateralAmount);
    
    // 2. 执行复合操作（如果 VaultCore 支持）
    // 注意：需要检查 VaultCore 是否实现了 depositAndBorrow
    const tx = await vaultCore.depositAndBorrow(
        collateralAsset,
        collateralAmount,
        borrowAsset,
        borrowAmount
    );
    
    await tx.wait();
    console.log("✅ 存入并借款成功");
}
```

#### 还款并提取（原子操作）

```typescript
/**
 * 还款并提取抵押物
 * @param repayAsset 还款资产
 * @param repayAmount 还款金额
 * @param withdrawAsset 提取资产
 * @param withdrawAmount 提取金额
 */
async function repayAndWithdraw(
    repayAsset: string,
    repayAmount: bigint,
    withdrawAsset: string,
    withdrawAmount: bigint
) {
    // 1. 批准还款资产
    const repayToken = await ethers.getContractAt("IERC20", repayAsset);
    await repayToken.approve(vaultCoreAddress, repayAmount);
    
    // 2. 执行复合操作
    const tx = await vaultCore.repayAndWithdraw(
        repayAsset,
        repayAmount,
        withdrawAsset,
        withdrawAmount
    );
    
    await tx.wait();
    console.log("✅ 还款并提取成功");
}
```

---

## 健康因子与风险管理

### 健康因子计算

健康因子是衡量借贷安全性的核心指标：

```typescript
/**
 * 计算健康因子
 * @param collateralValue 抵押物价值（USD）
 * @param debtValue 债务价值（USD）
 * @returns 健康因子（bps）
 */
function calculateHealthFactor(collateralValue: bigint, debtValue: bigint): bigint {
    if (debtValue === 0n) {
        return BigInt(Number.MAX_SAFE_INTEGER); // 无债务，健康因子无限大
    }
    
    // 健康因子 = (抵押物价值 × 10000) / 债务价值
    return (collateralValue * 10000n) / debtValue;
}
```

### 风险等级

| 健康因子 | 状态 | 说明 | 建议操作 |
|---------|------|------|---------|
| `≥ 150%` | 非常安全 | 有充足的抵押物缓冲 | 可以继续借款 |
| `110% - 150%` | 安全 | 在安全范围内 | 正常使用 |
| `100% - 110%` | 警告 | 接近清算线 | 考虑增加抵押物或还款 |
| `< 100%` | 危险 | 可能被清算 | 立即增加抵押物或还款 |

### 风险管理工具

#### 健康因子监控

```typescript
/**
 * 监控用户健康因子
 * @param user 用户地址
 * @param callback 健康因子变化回调
 * @returns 停止监控的函数
 */
function monitorHealthFactor(
    user: string,
    callback: (hf: bigint, status: string) => void
) {
    let lastHF: bigint | null = null;
    
    const interval = setInterval(async () => {
        try {
            const [healthFactor, isValid] = await userView.getUserHealthFactor(user);
            
            if (lastHF !== null && healthFactor !== lastHF) {
                const status = getHealthFactorStatus(healthFactor);
                callback(healthFactor, status);
            }
            
            lastHF = healthFactor;
        } catch (error) {
            console.error("健康因子监控失败:", error);
        }
    }, 30000); // 每30秒检查一次
    
    return () => clearInterval(interval);
}

// 使用示例
const stopMonitoring = monitorHealthFactor(userAddress, (hf, status) => {
    console.log(`健康因子: ${hf}, 状态: ${status}`);
    
    if (hf < 11000n) {
        console.warn("⚠️ 健康因子过低，建议增加抵押物或还款");
    }
});
```

#### 自动风险管理

```typescript
/**
 * 自动风险管理：健康因子过低时发送告警
 * @param user 用户地址
 * @param threshold 告警阈值（默认 110%）
 */
async function setupRiskAlert(user: string, threshold: bigint = 11000n) {
    const [healthFactor, isValid] = await userView.getUserHealthFactor(user);
    
    if (healthFactor < threshold) {
        // 发送告警通知
        console.warn(`⚠️ 健康因子告警: ${healthFactor} < ${threshold}`);
        
        // 可以集成通知服务（邮件、短信、推送等）
        // await sendAlert(user, healthFactor);
    }
}
```

---

## 实际应用示例

### 完整借贷流程示例

```typescript
/**
 * 完整的借贷流程示例
 */
async function completeLendingFlow() {
    const userAddress = await signer.getAddress();
    const usdcAddress = "0x..."; // USDC 地址
    const wethAddress = "0x...";  // WETH 地址
    
    console.log("=== 开始借贷流程 ===\n");
    
    // 1. 存入抵押物
    console.log("1. 存入抵押物...");
    const depositAmount = ethers.parseUnits("10000", 6); // 10000 USDC
    await depositCollateral(usdcAddress, depositAmount);
    
    // 2. 查询抵押物
    const [collateral] = await userView.getUserCollateral(userAddress, usdcAddress);
    console.log(`   抵押物: ${ethers.formatUnits(collateral, 6)} USDC\n`);
    
    // 3. 查询可借额度
    console.log("2. 查询可借额度...");
    const [maxBorrowable] = await previewView.getMaxBorrowableWithMeta(userAddress, wethAddress);
    console.log(`   最大可借: ${ethers.formatUnits(maxBorrowable, 18)} WETH\n`);
    
    // 4. 预览借款
    console.log("3. 预览借款...");
    const borrowAmount = ethers.parseUnits("1", 18); // 1 WETH
    const [previewHF] = await previewView.previewBorrow(userAddress, wethAddress, 0n, 0n, borrowAmount);
    console.log(`   预览健康因子: ${previewHF.toString()} (${Number(previewHF) / 100}%)\n`);
    
    // 5. 执行借款
    if (previewHF >= 11000n) {
        console.log("4. 执行借款...");
        await borrowAsset(wethAddress, borrowAmount);
        console.log(`   借款成功: ${ethers.formatUnits(borrowAmount, 18)} WETH\n`);
    } else {
        console.log("   健康因子不足，无法借款\n");
        return;
    }
    
    // 6. 查询状态
    console.log("5. 查询当前状态...");
    const [healthFactor, isValid] = await userView.getUserHealthFactor(userAddress);
    const [totalCollateral] = await userView.getUserTotalCollateral(userAddress);
    const [totalDebt] = await userView.getUserTotalDebt(userAddress);
    
    console.log(`   健康因子: ${healthFactor.toString()} (${Number(healthFactor) / 100}%)`);
    console.log(`   总抵押物价值: $${ethers.formatUnits(totalCollateral, 8)}`);
    console.log(`   总债务价值: $${ethers.formatUnits(totalDebt, 8)}\n`);
    
    // 7. 还款
    console.log("6. 还款...");
    await repayDebt(wethAddress, borrowAmount);
    console.log("   还款成功\n");
    
    // 8. 提取抵押物
    console.log("7. 提取抵押物...");
    const withdrawAmount = ethers.parseUnits("5000", 6); // 5000 USDC
    await withdrawCollateral(usdcAddress, withdrawAmount);
    console.log("   提取成功\n");
    
    console.log("=== 借贷流程完成 ===");
}
```

### 前端集成示例

#### React Hook - 用户状态

```typescript
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';

interface UserPosition {
    collateral: Record<string, string>;
    debt: Record<string, string>;
    healthFactor: string;
    totalCollateral: string;
    totalDebt: string;
}

export function useUserPosition(userAddress: string) {
    const [position, setPosition] = useState<UserPosition | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>('');

    useEffect(() => {
        let mounted = true;

        async function fetchPosition() {
            try {
                setLoading(true);
                setError('');

                // 获取抵押物
                const collateralAssets = await vaultRouter.getUserCollateralAssets(userAddress);
                const collateral: Record<string, string> = {};
                for (const asset of collateralAssets) {
                    const [amount] = await userView.getUserCollateral(userAddress, asset);
                    collateral[asset] = ethers.formatUnits(amount, 6);
                }

                // 获取债务
                const debtAssets = await vaultRouter.getUserDebtAssets(userAddress);
                const debt: Record<string, string> = {};
                for (const asset of debtAssets) {
                    const [amount] = await userView.getUserDebt(userAddress, asset);
                    debt[asset] = ethers.formatUnits(amount, 6);
                }

                // 获取健康因子
                const [healthFactor, isValid] = await userView.getUserHealthFactor(userAddress);
                
                // 获取总价值
                const [totalCollateral] = await userView.getUserTotalCollateral(userAddress);
                const [totalDebt] = await userView.getUserTotalDebt(userAddress);

                if (mounted) {
                    setPosition({
                        collateral,
                        debt,
                        healthFactor: healthFactor.toString(),
                        totalCollateral: ethers.formatUnits(totalCollateral, 8),
                        totalDebt: ethers.formatUnits(totalDebt, 8)
                    });
                }
            } catch (err: any) {
                if (mounted) {
                    setError(err.message);
                }
            } finally {
                if (mounted) {
                    setLoading(false);
                }
            }
        }

        if (userAddress) {
            fetchPosition();
            const interval = setInterval(fetchPosition, 30000); // 每30秒更新
            return () => clearInterval(interval);
        }
    }, [userAddress]);

    return { position, loading, error };
}
```

#### React Hook - 操作执行

```typescript
export function useVaultOperations() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>('');

    const deposit = async (asset: string, amount: bigint) => {
        try {
            setLoading(true);
            setError('');
            
            // 批准代币
            const erc20 = await ethers.getContractAt("IERC20", asset);
            await erc20.approve(vaultCoreAddress, amount);
            
            // 存入
            const tx = await vaultCore.deposit(asset, amount);
            await tx.wait();
            
            return { success: true };
        } catch (err: any) {
            setError(err.message);
            return { success: false, error: err.message };
        } finally {
            setLoading(false);
        }
    };

    const borrow = async (asset: string, amount: bigint) => {
        try {
            setLoading(true);
            setError('');
            
            // 检查健康因子
            const [healthFactor, isValid] = await userView.getUserHealthFactor(userAddress);
            if (healthFactor < 11000n) {
                throw new Error("健康因子不足，无法借款");
            }
            
            // 借款
            const tx = await vaultCore.borrow(asset, amount);
            await tx.wait();
            
            return { success: true };
        } catch (err: any) {
            setError(err.message);
            return { success: false, error: err.message };
        } finally {
            setLoading(false);
        }
    };

    const repay = async (asset: string, amount: bigint) => {
        try {
            setLoading(true);
            setError('');
            
            // 批准代币
            const erc20 = await ethers.getContractAt("IERC20", asset);
            await erc20.approve(vaultCoreAddress, amount);
            
            // 还款
            const tx = await vaultCore.repay(orderId, asset, amount);
            await tx.wait();
            
            return { success: true };
        } catch (err: any) {
            setError(err.message);
            return { success: false, error: err.message };
        } finally {
            setLoading(false);
        }
    };

    const withdraw = async (asset: string, amount: bigint) => {
        try {
            setLoading(true);
            setError('');
            
            // 检查健康因子
            const [previewHF] = await previewView.previewWithdraw(userAddress, asset, amount);
            if (previewHF < 11000n) {
                throw new Error("提取后健康因子过低");
            }
            
            // 提取
            const tx = await vaultCore.withdraw(asset, amount);
            await tx.wait();
            
            return { success: true };
        } catch (err: any) {
            setError(err.message);
            return { success: false, error: err.message };
        } finally {
            setLoading(false);
        }
    };

    return { deposit, borrow, repay, withdraw, loading, error };
}
```

---

## 最佳实践

### 1. 操作前检查

```typescript
/**
 * 操作前完整检查
 */
async function preOperationCheck(operation: string, asset: string, amount: bigint) {
    // 1. 检查资产是否在白名单中
    const assetWhitelist = await getAssetWhitelist();
    const isAllowed = await assetWhitelist.isAssetAllowed(asset);
    if (!isAllowed) {
        throw new Error("资产不在白名单中");
    }
    
    // 2. 检查用户余额
    const erc20 = await ethers.getContractAt("IERC20", asset);
    const balance = await erc20.balanceOf(userAddress);
    
    if (operation === "deposit" || operation === "repay") {
        if (balance < amount) {
            throw new Error("余额不足");
        }
    }
    
    // 3. 检查健康因子（借款/提取前）
    if (operation === "borrow" || operation === "withdraw") {
        const [healthFactor, isValid] = await userView.getUserHealthFactor(userAddress);
        const minHF = 11000n;
        
        if (healthFactor < minHF) {
            throw new Error(`健康因子过低: ${healthFactor}, 最小要求: ${minHF}`);
        }
    }
    
    // 4. 预览操作
    if (operation === "borrow") {
        const [previewHF] = await previewView.previewBorrow(userAddress, asset, 0n, 0n, amount);
        if (previewHF < 11000n) {
            throw new Error("借款后健康因子将低于安全阈值");
        }
    }
    
    if (operation === "withdraw") {
        const [previewHF] = await previewView.previewWithdraw(userAddress, asset, amount);
        if (previewHF < 11000n) {
            throw new Error("提取后健康因子将低于安全阈值");
        }
    }
}
```

### 2. 错误处理

```typescript
/**
 * 安全的操作执行（带错误处理）
 */
async function safeOperation<T>(
    operation: () => Promise<T>,
    operationName: string
): Promise<{ success: boolean; result?: T; error?: string }> {
    try {
        const result = await operation();
        return { success: true, result };
    } catch (error: any) {
        console.error(`${operationName} 失败:`, error);
        
        // 解析错误信息
        let errorMessage = error.message || "未知错误";
        
        if (errorMessage.includes("insufficient balance")) {
            errorMessage = "余额不足";
        } else if (errorMessage.includes("health factor")) {
            errorMessage = "健康因子不足";
        } else if (errorMessage.includes("not whitelisted")) {
            errorMessage = "资产不在白名单中";
        }
        
        return { success: false, error: errorMessage };
    }
}

// 使用示例
const result = await safeOperation(
    () => vaultCore.deposit(assetAddress, amount),
    "存入抵押物"
);

if (!result.success) {
    console.error("操作失败:", result.error);
}
```

### 3. Gas 优化

```typescript
/**
 * 批量操作以节省 Gas
 */
async function optimizeGasOperations() {
    // ✅ 正确：使用批量操作
    const assets = [usdcAddress, wethAddress];
    const amounts = [
        ethers.parseUnits("1000", 6),
        ethers.parseUnits("0.5", 18)
    ];
    await vaultCore.batchDeposit(assets, amounts);
    
    // ❌ 错误：逐个操作（消耗更多 Gas）
    // await vaultCore.deposit(usdcAddress, amounts[0]);
    // await vaultCore.deposit(wethAddress, amounts[1]);
}
```

### 4. 事件监听

```typescript
/**
 * 监听所有相关事件
 */
function setupEventListeners() {
    // 监听存入事件
    vaultCore.on("CollateralDeposited", (user, asset, amount, event) => {
        console.log(`用户 ${user} 存入 ${amount} 的 ${asset}`);
        // 更新UI
    });
    
    // 监听借款事件
    vaultCore.on("Borrowed", (user, asset, amount, event) => {
        console.log(`用户 ${user} 借入 ${amount} 的 ${asset}`);
        // 更新UI
    });
    
    // 监听还款事件
    vaultCore.on("Repaid", (user, asset, amount, event) => {
        console.log(`用户 ${user} 还款 ${amount} 的 ${asset}`);
        // 更新UI
    });
    
    // 监听提取事件
    vaultCore.on("CollateralWithdrawn", (user, asset, amount, event) => {
        console.log(`用户 ${user} 提取 ${amount} 的 ${asset}`);
        // 更新UI
    });
}
```

---

## 故障排除

### 常见问题

#### Q1: 存入失败 - "AssetNotAllowed"

**症状**：调用 `deposit` 时返回资产不在白名单错误

**解决方案**：
```typescript
// 1. 检查资产是否在白名单中
const assetWhitelist = await getAssetWhitelist();
const isAllowed = await assetWhitelist.isAssetAllowed(assetAddress);

if (!isAllowed) {
    console.error("资产不在白名单中，请联系管理员添加");
    return;
}

// 2. 如果资产应该被支持，联系管理员添加
```

#### Q2: 借款失败 - "HealthFactorTooLow"

**症状**：借款时健康因子不足

**解决方案**：
```typescript
// 1. 查询当前健康因子
const [healthFactor, isValid] = await userView.getUserHealthFactor(userAddress);
console.log(`当前健康因子: ${healthFactor}`);

// 2. 增加抵押物
const additionalCollateral = ethers.parseUnits("1000", 6);
await vaultCore.deposit(assetAddress, additionalCollateral);

// 3. 或减少借款金额
const reducedAmount = ethers.parseUnits("400", 6); // 减少借款金额
await vaultCore.borrow(assetAddress, reducedAmount);
```

#### Q3: 提取失败 - "InsufficientCollateral"

**症状**：提取金额超过抵押物

**解决方案**：
```typescript
// 1. 查询当前抵押物
const [collateral] = await userView.getUserCollateral(userAddress, assetAddress);
console.log(`当前抵押物: ${ethers.formatUnits(collateral, decimals)}`);

// 2. 调整提取金额
const withdrawAmount = collateral; // 提取全部
await vaultCore.withdraw(assetAddress, withdrawAmount);
```

#### Q4: 还款失败 - "InsufficientBalance"

**症状**：还款时余额不足

**解决方案**：
```typescript
// 1. 检查余额
const erc20 = await ethers.getContractAt("IERC20", assetAddress);
const balance = await erc20.balanceOf(userAddress);
const [debt] = await userView.getUserDebt(userAddress, assetAddress);

console.log(`余额: ${ethers.formatUnits(balance, decimals)}`);
console.log(`债务: ${ethers.formatUnits(debt, decimals)}`);

// 2. 如果余额不足，需要先充值
if (balance < debt) {
    console.error("余额不足，请先充值");
    return;
}

// 3. 确保已批准足够的额度
const allowance = await erc20.allowance(userAddress, vaultCoreAddress);
if (allowance < debt) {
    await erc20.approve(vaultCoreAddress, debt);
}
```

#### Q5: 健康因子计算异常

**症状**：健康因子查询返回异常值

**排查步骤**：
```typescript
// 1. 检查价格数据（View 层）
const valuationOracleView = await getValuationOracleView();
const [price, blockNumber] = await valuationOracleView.getAssetPrice(assetAddress);
const [isValid, validTs] = await valuationOracleView.isPriceValid(assetAddress);

if (!isValid) {
    console.error("价格数据无效或已过期");
}

// 2. 检查抵押物和债务
const [collateral] = await userView.getUserCollateral(userAddress, assetAddress);
const [debt] = await userView.getUserDebt(userAddress, assetAddress);

console.log(`抵押物: ${collateral}`);
console.log(`债务: ${debt}`);

// 3. 手动计算健康因子
const [collateralValue] = await userView.getUserTotalCollateral(userAddress);
const [debtValue] = await userView.getUserTotalDebt(userAddress);
const manualHF = (collateralValue * 10000n) / debtValue;

console.log(`手动计算的健康因子: ${manualHF}`);
```

---

## 相关文档

- [Vault 模块文档](../src/Vault/README.md)
- [权限管理指南](./permission-management-guide.md)
- [PriceOracle 指南](./PriceOracle-Guide.md)
- [Registry 系统文档](../docs/registry-deployment.md)

---

## 总结

通过本指南，您可以：

1. ✅ 理解 RWA 借贷平台的核心概念
2. ✅ 掌握存款、借款、还款、提取等基础操作
3. ✅ 使用查询功能监控账户状态
4. ✅ 理解健康因子和风险管理
5. ✅ 集成到前端应用
6. ✅ 处理常见错误和异常情况

---

**版本**: 1.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team


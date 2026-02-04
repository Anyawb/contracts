# 保证金系统实现总结

## 🎯 概述

保证金系统是 RWA 借贷平台的核心风险控制机制，在借款时自动预收利息作为"保证金"，确保在正常还款时返还，在提前还款时按规则分配，在清算时没收。系统采用模块化设计，职责清晰，支持完整的状态追踪与事件记录。

## 📁 核心合约

### 1. GuaranteeFundManager.sol

**位置**: `src/Vault/modules/GuaranteeFundManager.sol`

**功能**: 资金托管和分发模块，负责保证金的实际资金管理

**核心功能**:
- ✅ `lockGuarantee()` - 锁定用户保证金（从用户转入托管池）
- ✅ `releaseGuarantee()` - 释放用户保证金（返还给用户）
- ✅ `forfeitGuarantee()` - 没收用户保证金（转给费用接收者）
- ✅ `settleEarlyRepayment()` - 提前还款三方结算（一次性完成返还/罚金/平台费三路分发）
- ✅ `forfeitPartial()` - 部分没收保证金

**查询功能**:
- ✅ `getLockedGuarantee()` - 获取用户锁定保证金金额
- ✅ `getTotalGuaranteeByAsset()` - 获取资产总保证金
- ✅ `isGuaranteePaid()` - 检查保证金支付状态
- ✅ `getUserGuaranteeAssets()` - 获取用户保证金资产列表

**权限控制**:
- 仅 `VaultCore` 可调用核心功能（`onlyVaultCore` 修饰符）
- 通过 `Registry` 获取 `AccessControlManager` 进行权限验证

### 2. EarlyRepaymentGuaranteeManager.sol

**位置**: `src/Vault/modules/EarlyRepaymentGuaranteeManager.sol`

**功能**: 提前还款保证金记录和规则计算模块

**核心功能**:
- ✅ `lockGuaranteeRecord()` - 记录保证金信息（borrower/lender/asset/principal/promisedInterest/termDays）
- ✅ `settleEarlyRepayment()` - 计算提前还款结果并关闭记录，调用 GFM 进行真实转账
- ✅ `processDefault()` - 处理违约，调用 GFM.forfeitPartial 完成真实转账

**数据结构**:
```solidity
struct GuaranteeRecord {
    uint256 principal;                    // 借款本金
    uint256 promisedInterest;             // 承诺的利息（保证金）
    uint256 startTime;                    // 借款开始时间
    uint256 maturityTime;                 // 到期时间
    uint256 earlyRepayPenaltyDays;       // 提前还款罚金天数（默认2天）
    bool isActive;                        // 是否活跃
    address lender;                       // 贷款方地址
    address asset;                        // 资产地址
}

struct EarlyRepaymentResult {
    uint256 penaltyToLender;              // 给贷款方的罚金
    uint256 refundToBorrower;            // 返还给借款方的金额
    uint256 platformFee;                  // 平台手续费
    uint256 actualInterestPaid;          // 实际支付的利息
}
```

**权限控制**:
- 仅 `VaultCore` 可调用核心功能
- 通过 `Registry` 获取 `AccessControlManager` 进行权限验证

### 3. VaultBusinessLogic.sol

**位置**: `src/Vault/modules/VaultBusinessLogic.sol`

**功能**: 业务编排模块，协调保证金锁定和释放

**核心功能**:
- ✅ `borrowWithRate()` - 低 gas 借款（通过 `SettlementMatchLib.finalizeAtomic` 执行）
- ✅ `repay()` - 还款操作
- ✅ `repayWithStop()` - 显式关单还款，触发早偿结算

**实现说明**:
- `borrowWithRate()` 现在通过 `SettlementMatchLib.finalizeAtomic()` 执行原子化操作
- 保证金锁定由 `SettlementMatchLib` 统一协调，调用 `EarlyRepaymentGuaranteeManager.lockGuaranteeRecord()` 和 `GuaranteeFundManager.lockGuarantee()`

### 4. SettlementMatchLib.sol

**位置**: `src/libraries/SettlementMatchLib.sol`

**功能**: 资金拨付与账本/订单落地的一体化原子流程库

**核心功能**:
- ✅ `finalizeAtomic()` - 原子完成：抵押（可选）→ 放款拨付 → 债务记账 → 订单落地 → 保证金锁定

## 📊 事件系统

### LoanEvents.sol

**位置**: `src/core/LoanEvents.sol`

**定义的事件**:
```solidity
event GuaranteeLocked(
    address indexed user,
    address indexed asset,
    uint256 amount,
    uint256 blockNumber
);

event GuaranteeReleased(
    address indexed user,
    address indexed asset,
    uint256 amount,
    uint256 blockNumber
);

event GuaranteeForfeited(
    address indexed user,
    address indexed asset,
    uint256 amount,
    address indexed feeReceiver,
    uint256 blockNumber
);
```

### EarlyRepaymentGuaranteeManager 事件

```solidity
event GuaranteeLocked(
    uint256 indexed guaranteeId,
    address indexed borrower,
    address indexed lender,
    address asset,
    uint256 principal,
    uint256 promisedInterest,
    uint256 startTime,
    uint256 maturityTime,
    uint256 earlyRepayPenaltyDays,
    uint256 blockNumber
);

event EarlyRepaymentProcessed(
    uint256 indexed guaranteeId,
    address indexed borrower,
    address indexed lender,
    address asset,
    uint256 penaltyToLender,
    uint256 refundToBorrower,
    uint256 platformFee,
    uint256 actualInterestPaid,
    uint256 blockNumber
);
```

## 🚨 错误定义

### StandardErrors.sol

**位置**: `src/errors/StandardErrors.sol`

**保证金相关错误**:
```solidity
error GuaranteeNotPaid();
error GuaranteeAlreadyReleased();
error InvalidGuaranteeAmount();
error NotEnoughGuarantee();
error GuaranteeNotActive();
error InvalidGuaranteeId();
error GuaranteeAlreadyProcessed();
error GuaranteeRecordNotFound();
error GuaranteeIdOverflow();
error InvalidGuaranteeTerm();
error GuaranteeInterestTooHigh();
error BorrowerCannotBeLender();
```

## 🔄 业务流程

### 借款流程（原子化操作）

```
1. 用户发起借款请求（通过 VaultBusinessLogic.borrowWithRate）
   │
   ├─> SettlementMatchLib.finalizeAtomic()
   │   │
   │   ├─> 2. 可选：补充抵押（CollateralManager.depositCollateral）
   │   │
   │   ├─> 3. 资金拨付：从业务层合约余额划转给借款人
   │   │
   │   ├─> 4. 债务记账：通过 VaultCore.borrowFor 写入账本
   │   │
   │   ├─> 5. 订单落地：LoanNFT + Reward + DataPush（由 LendingEngine 完成）
   │   │
   │   └─> 6. 保证金锁定：
   │       ├─> EarlyRepaymentGuaranteeManager.lockGuaranteeRecord()（记录）
   │       └─> GuaranteeFundManager.lockGuarantee()（真实转账）
   │
   └─> 7. 触发事件和数据推送
```

### 还款流程

```
1. 用户发起还款请求（通过 VaultBusinessLogic.repay 或 repayWithStop）
   │
   ├─> 2. 转移代币到合约
   │
   ├─> 3. 债务记账：通过 VaultCore.repay 更新账本
   │
   └─> 4. 若 stop=true 或债务=0，触发早偿结算：
       │
       └─> EarlyRepaymentGuaranteeManager.settleEarlyRepayment()
           │
           ├─> 计算提前还款结果（罚金/返还/平台费）
           │
           ├─> 关闭保证金记录
           │
           └─> 调用 GuaranteeFundManager.settleEarlyRepayment()
               │
               └─> 一次性三路分发：
                   ├─> 返还给借款方
                   ├─> 罚金给贷款方
                   └─> 平台手续费给平台
```

### 清算流程

```
1. 系统检测到清算条件
   │
   ├─> 2. 执行清算操作（通过 LiquidationManager）
   │
   └─> 3. 处理违约：
       │
       └─> EarlyRepaymentGuaranteeManager.processDefault()
           │
           └─> 调用 GuaranteeFundManager.forfeitPartial()
               │
               └─> 没收保证金给费用接收者
```

## 🔧 技术特性

### 安全特性

- ✅ **SafeERC20**: 所有 ERC20 交互使用安全转账
- ✅ **ReentrancyGuard**: 防止重入攻击
- ✅ **权限控制**: 仅授权合约（VaultCore）可调用保证金功能
- ✅ **状态验证**: 防止重复锁定和无效操作
- ✅ **CEI 模式**: 遵循 Checks-Effects-Interactions 模式

### 模块化设计

- ✅ **职责分离**: 
  - `EarlyRepaymentGuaranteeManager` - 记录和计算
  - `GuaranteeFundManager` - 资金托管和分发
  - `VaultBusinessLogic` - 业务编排
  - `SettlementMatchLib` - 原子化操作
- ✅ **接口驱动**: 通过接口进行模块间调用
- ✅ **可升级性**: 支持 UUPS 升级模式
- ✅ **Registry 集成**: 通过 Registry 系统统一管理模块地址

### 数据推送和缓存

- ✅ **统一数据推送**: 使用 `DataPushLibrary` 进行事件推送
- ✅ **View 层缓存**: 推送到 `StatisticsView`、`UserView`、`SystemView`
- ✅ **优先级策略**: 优先通过 `VaultCore.viewContractAddrVar()` 解析，回退到 `KEY_STATS`

## 📈 健康因子计算

### RiskView.sol

**位置**: `src/Vault/view/modules/RiskView.sol`

**功能**: 提供排除保证金的健康因子计算

```solidity
function calculateHealthFactorExcludingGuarantee(
    address user, 
    address asset
) external view returns (uint256 healthFactorExcludingGuarantee)
```

**计算逻辑**:
1. 读取用户总抵押物和总债务
2. 读取用户保证金
3. 计算有效抵押物（排除保证金）
4. 计算健康因子（有效抵押物 / 债务）

## 🧪 测试覆盖

### 测试文件

| 测试文件 | 位置 | 测试内容 |
|---------|------|---------|
| **EarlyRepaymentGuaranteeManager.test.ts** | `test/EarlyRepaymentGuaranteeManager.test.ts` | 提前还款保证金管理器核心功能测试 |
| **EarlyRepaymentGuaranteeManager.security.test.ts** | `test/EarlyRepaymentGuaranteeManager.security.test.ts` | 安全性和边界条件测试 |
| **GuaranteeFundManager.test.ts** | `test/Vault/modules/GuaranteeFundManager.test.ts` | 保证金基金管理器测试 |
| **GuaranteeAndRisk.integrated.test.ts** | `test/GuaranteeAndRisk.integrated.test.ts` | 保证金与风险模块集成测试 |
| **StatisticsView.guarantee-aggregation.test.ts** | `test/StatisticsView.guarantee-aggregation.test.ts` | 保证金统计聚合测试 |

### 测试场景

- ✅ 保证金锁定和释放
- ✅ 提前还款结算（三方分发）
- ✅ 清算时保证金没收
- ✅ 重复操作防护
- ✅ 事件触发验证
- ✅ 健康因子计算（排除保证金）
- ✅ 批量操作测试
- ✅ 边界条件测试
- ✅ 权限控制测试

## 🚀 部署和配置

### 初始化参数

#### GuaranteeFundManager

```typescript
await guaranteeFundManager.initialize(
    vaultCoreAddress,      // VaultCore 合约地址
    registryAddress,       // Registry 合约地址
    upgradeAdmin          // 升级管理员地址（可选，已迁移）
);
```

#### EarlyRepaymentGuaranteeManager

```typescript
await earlyRepaymentGuaranteeManager.initialize(
    vaultCoreAddress,           // VaultCore 合约地址
    registryAddress,            // Registry 合约地址
    platformFeeReceiverAddress, // 平台费用接收者地址
    platformFeeRate            // 平台手续费率（基点，默认100 = 1%）
);
```

### 配置参数

- **平台手续费率**: 默认 100 bps (1%)，可通过治理调整
- **提前还款罚金天数**: 默认 2 天
- **最大借款期限**: 10 年（365 * 10 天）
- **最大利息比例**: 利息不超过本金的 2 倍

## 📊 监控和统计

### 用户级别

- **个人保证金余额**: `getLockedGuarantee(user, asset)`
- **保证金支付状态**: `isGuaranteePaid(user, asset)`
- **保证金资产列表**: `getUserGuaranteeAssets(user)`

### 系统级别

- **各资产总保证金**: `getTotalGuaranteeByAsset(asset)`
- **保证金分布统计**: 通过 `StatisticsView` 查询
- **没收保证金统计**: 通过事件监听

### View 层集成

保证金系统与以下 View 模块集成：

- **StatisticsView**: 推送保证金统计更新
- **UserView**: 推送用户保证金状态
- **SystemView**: 推送系统保证金统计
- **RiskView**: 提供排除保证金的健康因子计算

## 🔍 接口定义

### IGuaranteeFundManager

**位置**: `src/interfaces/IGuaranteeFundManager.sol`

**主要接口**:
```solidity
function lockGuarantee(address user, address asset, uint256 amount) external;
function releaseGuarantee(address user, address asset, uint256 amount) external;
function forfeitGuarantee(address user, address asset, address feeReceiver) external;
function getLockedGuarantee(address user, address asset) external view returns (uint256);
function isGuaranteePaid(address user, address asset) external view returns (bool);
function batchLockGuarantees(address user, address[] calldata assets, uint256[] calldata amounts) external;
function batchReleaseGuarantees(address user, address[] calldata assets, uint256[] calldata amounts) external;
```

### IEarlyRepaymentGuaranteeManager

**位置**: `src/interfaces/IEarlyRepaymentGuaranteeManager.sol`

**主要接口**:
```solidity
function lockGuaranteeRecord(
    address borrower,
    address lender,
    address asset,
    uint256 principal,
    uint256 promisedInterest,
    uint256 termDays
) external returns (uint256 guaranteeId);

function settleEarlyRepayment(
    address borrower,
    address asset,
    uint256 actualRepayAmount
) external returns (EarlyRepaymentResult memory);

function processDefault(
    address borrower,
    address asset
) external returns (uint256 forfeitedAmount);
```

## 🔄 Registry 集成

### 模块键

保证金系统在 Registry 中注册的模块键：

| 模块键 | 模块名称 | 说明 |
|--------|----------|------|
| `KEY_GUARANTEE_FUND` | GuaranteeFundManager | 保证金基金管理器 |
| `KEY_EARLY_REPAYMENT_GUARANTEE` | EarlyRepaymentGuaranteeManager | 提前还款保证金管理器 |

### 依赖模块

保证金系统依赖以下模块：

- `KEY_VAULT_CORE` - VaultCore 合约（调用入口）
- `KEY_ACCESS_CONTROL` - AccessControlManager（权限控制）
- `KEY_STATS` / `KEY_VAULT_VIEW` - StatisticsView（统计推送）
- `KEY_USER_VIEW` - UserView（用户状态推送）
- `KEY_SYSTEM_VIEW` - SystemView（系统统计推送）

## 📝 使用示例

### 1. 锁定保证金

```typescript
import { IGuaranteeFundManager } from '../types/contracts';

const guaranteeFundManager = await ethers.getContractAt(
    'IGuaranteeFundManager',
    guaranteeFundManagerAddress
);

// 通过 VaultCore 调用（需要权限）
await vaultCore.borrowWithRate(
    userAddress,
    lenderAddress,
    assetAddress,
    amount,
    annualRateBps,
    termDays
);

// 系统会自动：
// 1. EarlyRepaymentGuaranteeManager.lockGuaranteeRecord() - 记录
// 2. GuaranteeFundManager.lockGuarantee() - 锁定资金
```

### 2. 查询保证金

```typescript
// 查询用户锁定保证金
const lockedAmount = await guaranteeFundManager.getLockedGuarantee(
    userAddress,
    assetAddress
);

// 检查是否已支付保证金
const isPaid = await guaranteeFundManager.isGuaranteePaid(
    userAddress,
    assetAddress
);

// 查询资产总保证金
const totalGuarantee = await guaranteeFundManager.getTotalGuaranteeByAsset(
    assetAddress
);
```

### 3. 提前还款结算

```typescript
// 通过 VaultBusinessLogic 还款并触发结算
await vaultBusinessLogic.repayWithStop(
    userAddress,
    assetAddress,
    repayAmount,
    true  // stop=true 触发早偿结算
);

// 系统会自动：
// 1. EarlyRepaymentGuaranteeManager.settleEarlyRepayment() - 计算并关闭记录
// 2. GuaranteeFundManager.settleEarlyRepayment() - 三路分发
```

### 4. 计算排除保证金的健康因子

```typescript
import { RiskView } from '../types/contracts';

const riskView = await ethers.getContractAt(
    'RiskView',
    riskViewAddress
);

// 计算排除保证金后的健康因子（新版返回带 meta）
const [healthFactor] = await riskView.calculateHealthFactorExcludingGuarantee(
    userAddress,
    assetAddress
);
```

## 🔮 未来扩展

### 功能扩展

- 多级保证金机制
- 动态保证金调整
- 保证金质押收益
- 保证金保险机制

### 技术优化

- Gas 优化（批量操作已支持）
- 跨链保证金
- 预言机集成（价值计算）

## 📋 总结

保证金系统已成功实现所有核心功能，包括：

1. **完整的业务流程**: 借款锁定 → 还款释放/提前还款结算 → 清算没收
2. **职责清晰的模块设计**: 记录管理、资金托管、业务编排分离
3. **安全的状态管理**: 防止重复操作和无效状态
4. **详细的事件记录**: 完整的操作追踪和审计
5. **灵活的配置管理**: 支持动态参数调整
6. **全面的测试覆盖**: 确保功能正确性和安全性
7. **View 层集成**: 提供查询和统计功能
8. **健康因子支持**: 排除保证金的健康因子计算

该系统为 RWA 借贷平台提供了强大的风险控制机制，有效保护了平台、出借人和借款人的利益。

---

**版本**: 2.0.0  
**最后更新**: 2025年1月  
**维护者**: RWA Lending Platform Team

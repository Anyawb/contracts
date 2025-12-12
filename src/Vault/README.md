# Vault 模块接口文档

## 概述

Vault模块是RWA借贷平台的核心组件，负责管理抵押物、借贷、还款等核心业务逻辑。该模块采用模块化设计，将不同功能分离到独立的合约中，以提高可维护性和可升级性。

## 核心合约

### 1. VaultCore.sol - 核心业务逻辑
**文件路径**: `contracts/Vault/VaultCore.sol`

**主要功能**: 处理用户的主要操作（存款、借款、还款、提取）

**暴露接口**:
```solidity
// 基础操作
function deposit(address asset, uint256 amount) external
function withdraw(address asset, uint256 amount) external
function borrow(address asset, uint256 amount) external
function repay(address asset, uint256 amount) external

// 复合操作
function depositAndBorrow(
    address collateralAsset,
    uint256 collateralAmount,
    address borrowAsset,
    uint256 borrowAmount
) external

function repayAndWithdraw(
    address repayAsset,
    uint256 repayAmount,
    address withdrawAsset,
    uint256 withdrawAmount
) external

// 批量操作
function batchDeposit(address[] calldata assets, uint256[] calldata amounts) external
function batchBorrow(address[] calldata assets, uint256[] calldata amounts) external
function batchRepay(address[] calldata assets, uint256[] calldata amounts) external
function batchWithdraw(address[] calldata assets, uint256[] calldata amounts) external
```

### 2. VaultView.sol - 查询接口
**文件路径**: `contracts/Vault/VaultView.sol`

**主要功能**: 提供所有查询功能，包括用户状态、健康因子、价格等

**暴露接口**:
```solidity
// 用户状态查询
function getUserCollateral(address user, address asset) external view returns (uint256)
function getUserDebt(address user, address asset) external view returns (uint256)
function getUserHealthFactor(address user) external view returns (uint256)
function getUserTotalCollateral(address user) external view returns (uint256)
function getUserTotalDebt(address user) external view returns (uint256)

// 资产状态查询
function getTotalCollateral(address asset) external view returns (uint256)
function getTotalDebt(address asset) external view returns (uint256)
function getAssetPrice(address asset) external view returns (uint256)

// 系统状态查询
function getVaultCap() external view returns (uint256)
function getMinHealthFactor() external view returns (uint256)
function getLiquidationThreshold() external view returns (uint256)

// 预览功能
function previewBorrow(address user, address asset, uint256 amount) external view returns (uint256)
function previewRepay(address user, address asset, uint256 amount) external view returns (uint256)
function previewWithdraw(address user, address asset, uint256 amount) external view returns (uint256)
```

### 3. VaultStorage.sol - 存储合约
**文件路径**: `contracts/Vault/VaultStorage.sol`

**主要功能**: 存储系统配置和模块地址

**暴露接口**:
```solidity
// 模块地址查询
function getNamedModule(string memory name) external view returns (address)
function getCollateralManager() external view returns (address)
function getLendingEngine() external view returns (address)
function getHealthFactorCalculator() external view returns (address)
function getVaultStatistics() external view returns (address)
function getFeeRouter() external view returns (address)
function getRewardManager() external view returns (address)
function getAssetWhitelist() external view returns (address)

// 代币地址查询
function getSettlementTokenAddr() external view returns (address)
function getRwaTokenAddr() external view returns (address)

// 系统配置
function vaultCap() external view returns (uint256)
function minHealthFactor() external view returns (uint256)
function liquidationThreshold() external view returns (uint256)
```

## 核心库

### 4. VaultMath.sol - 统一数学计算库
**文件路径**: `contracts/Vault/VaultMath.sol`

**主要功能**: 提供统一的数学计算功能，包括健康因子、LTV、百分比计算等

**核心接口**:
```solidity
library VaultMath {
    // 健康因子计算
    function calculateHealthFactor(uint256 collateral, uint256 debt) internal pure returns (uint256)
    
    // 贷款价值比计算
    function calculateLTV(uint256 debt, uint256 collateral) internal pure returns (uint256)
    
    // 百分比计算
    function percentageMul(uint256 value, uint256 percentage) internal pure returns (uint256)
    function percentageDiv(uint256 value, uint256 percentage) internal pure returns (uint256)
    
    // 债务和抵押计算
    function calculateMaxDebt(uint256 collateral, uint256 maxLTV) internal pure returns (uint256)
    function calculateMinCollateral(uint256 debt, uint256 maxLTV) internal pure returns (uint256)
    
    // 奖励和费用计算
    function calculateBonus(uint256 amount, uint256 bonus) internal pure returns (uint256)
    function calculateFee(uint256 amount, uint256 feeRate) internal pure returns (uint256)
}
```

**使用标准**:
```solidity
// ✅ 正确：使用 VaultMath 库
import { VaultMath } from "../VaultMath.sol";

function calculateUserHealthFactor(uint256 collateral, uint256 debt) internal pure returns (uint256) {
    return VaultMath.calculateHealthFactor(collateral, debt);
}

function calculateUserLTV(uint256 debt, uint256 collateral) internal pure returns (uint256) {
    return VaultMath.calculateLTV(debt, collateral);
}

function calculateFee(uint256 amount, uint256 feeRate) internal pure returns (uint256) {
    return VaultMath.calculateFee(amount, feeRate);
}
```

**精度标准**:
- **健康因子**：以 basis points (bps) 为单位，10000 = 100%
- **LTV**：以 basis points (bps) 为单位，10000 = 100%
- **费用率**：以 basis points (bps) 为单位，100 = 1%
- **奖励率**：以 basis points (bps) 为单位，100 = 1%

## 模块化组件

### 5. CollateralManager.sol - 抵押物管理
**文件路径**: `contracts/Vault/modules/CollateralManager.sol`

**主要功能**: 管理用户抵押物的存入、提取和查询

**暴露接口**:
```solidity
function depositCollateral(address user, address asset, uint256 amount) external
function withdrawCollateral(address user, address asset, uint256 amount) external
function getCollateral(address user, address asset) external view returns (uint256)
function getTotalCollateralByAsset(address asset) external view returns (uint256)
```

### 6. LendingEngine.sol - 借贷引擎
**文件路径**: `contracts/Vault/modules/LendingEngine.sol`

**主要功能**: 管理用户借贷记录和债务计算

**暴露接口**:
```solidity
function borrow(address user, address asset, uint256 amount, uint256 fee, uint256 timestamp) external
function repay(address user, address asset, uint256 amount) external
function getDebt(address user, address asset) external view returns (uint256)
function getTotalDebtByAsset(address asset) external view returns (uint256)
```

### 7. 健康因子与风险视图
已由 `LiquidationRiskManager` + `HealthView` 组合替代原 `HealthFactorCalculator`。

## 接口合约

### 8. IVaultCore.sol - 核心接口
**文件路径**: `contracts/interfaces/IVaultCore.sol`

**用途**: 定义VaultCore合约的标准接口

### 9. IVaultStorage.sol - 存储接口
**文件路径**: `contracts/interfaces/IVaultStorage.sol`

**用途**: 定义VaultStorage合约的标准接口

### 10. ICollateralManager.sol - 抵押物管理接口
**文件路径**: `contracts/interfaces/ICollateralManager.sol`

**用途**: 定义CollateralManager合约的标准接口

### 11. ILendingEngineBasic.sol - 借贷引擎接口
**文件路径**: `contracts/interfaces/ILendingEngineBasic.sol`

**用途**: 定义LendingEngine合约的标准接口

### 12. ILiquidationRiskManager.sol - 风险管理接口
**文件路径**: `contracts/interfaces/ILiquidationRiskManager.sol`

**用途**: 提供最小健康因子与清算风险评估等能力

## 前端集成指南

### 主要合约地址
前端需要获取以下合约地址：
1. `VaultCore` - 用户操作入口
2. `VaultView` - 查询操作入口
3. `VaultStorage` - 系统配置查询

### 常用操作流程

#### 存款操作
```javascript
// 1. 检查用户余额
const userBalance = await tokenContract.balanceOf(userAddress);

// 2. 检查资产是否在白名单中
const assetWhitelist = await vaultStorage.getAssetWhitelist();
const isAllowed = await assetWhitelist.isAssetAllowed(assetAddress);

// 3. 执行存款
await vaultCore.deposit(assetAddress, amount);

// 4. 查询存款后的状态
const userCollateral = await vaultView.getUserCollateral(userAddress, assetAddress);
const healthFactor = await vaultView.getUserHealthFactor(userAddress);
```

#### 借款操作
```javascript
// 1. 检查健康因子
const healthFactor = await vaultView.getUserHealthFactor(userAddress);

// 2. 检查合约流动性
const contractBalance = await tokenContract.balanceOf(vaultCoreAddress);

// 3. 执行借款
await vaultCore.borrow(assetAddress, amount);

// 4. 查询借款后的状态
const userDebt = await vaultView.getUserDebt(userAddress, assetAddress);
```

#### 还款操作
```javascript
// 1. 检查用户债务
const userDebt = await vaultView.getUserDebt(userAddress, assetAddress);

// 2. 检查用户余额
const userBalance = await tokenContract.balanceOf(userAddress);

// 3. 执行还款
await vaultCore.repay(assetAddress, amount);

// 4. 查询还款后的状态
const remainingDebt = await vaultView.getUserDebt(userAddress, assetAddress);
```

#### 提取操作
```javascript
// 1. 检查用户抵押物
const userCollateral = await vaultView.getUserCollateral(userAddress, assetAddress);

// 2. 检查健康因子
const healthFactor = await vaultView.getUserHealthFactor(userAddress);

// 3. 执行提取
await vaultCore.withdraw(assetAddress, amount);

// 4. 查询提取后的状态
const remainingCollateral = await vaultView.getUserCollateral(userAddress, assetAddress);
```

### 错误处理
所有操作都可能抛出以下错误：
- `AmountIsZero` - 金额为零
- `ZeroAddress` - 地址为零
- `AssetNotAllowed` - 资产不在白名单中
- `InsufficientBalance` - 余额不足
- `InsufficientCollateral` - 抵押物不足
- `InsufficientLiquidity` - 流动性不足
- `HealthFactorTooLow` - 健康因子过低
- `VaultCapExceeded` - 超过金库容量限制

### 事件监听
前端需要监听以下事件：
- `Deposit(address indexed user, address indexed asset, uint256 amount, uint256 timestamp)`
- `Withdraw(address indexed user, address indexed asset, uint256 amount, uint256 timestamp)`
- `Borrow(address indexed user, address indexed asset, uint256 amount, uint256 timestamp)`
- `Repay(address indexed user, address indexed asset, uint256 amount, uint256 timestamp)`
- `DepositAndBorrow(address indexed user, address indexed collateralAsset, uint256 collateralAmount, address indexed borrowAsset, uint256 borrowAmount, uint256 timestamp)`
- `RepayAndWithdraw(address indexed user, address indexed repayAsset, uint256 repayAmount, address indexed withdrawAsset, uint256 withdrawAmount, uint256 timestamp)`

## 注意事项

1. **权限控制**: 所有操作都需要通过AccessControlled合约进行权限验证
2. **重入保护**: 所有外部操作都使用ReentrancyGuard保护
3. **暂停机制**: 系统支持暂停功能，暂停时所有操作都会被阻止
4. **升级机制**: 合约支持UUPS升级模式，只有治理地址可以升级
5. **模块化设计**: 各功能模块独立部署，便于维护和升级
6. **错误处理**: 使用try/catch包装外部模块调用，提供统一的错误处理

## 版本信息

- **当前版本**: 1.0.0
- **最后更新**: 2025年7月
- **兼容性**: Solidity ^0.8.20
- **网络支持**: 支持所有EVM兼容网络 
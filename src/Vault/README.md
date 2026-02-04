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

### 2. VaultRouter.sol - 路由协调器（不承担读取）
**文件路径**: `contracts/Vault/VaultRouter.sol`

**主要功能**: 仅负责写入路径的路由/协调（符合 `docs/Architecture-Guide.md` 的 “写入不经 View / 查询迁移到独立 View 模块” 原则）。  
查询能力已迁移到 `src/Vault/view/modules/` 下的专属 View。

**前端/SDK 查询入口（推荐）**
- **路由/发现性**：`SystemView.route*()` 返回 `moduleKey + moduleAddr`，前端可据此“下一跳”直连专属 View（不依赖 revert 文本）。
- **模块枚举/分页**：`RegistryView`（前端发现模块地址的工具视图）。
- **价格**：`ValuationOracleView.getAssetPrice(asset)`（返回 `price, blockNumber, isValid`）；批量用 `BatchView.batchGetAssetPrices(assets)`.
- **系统统计**：`StatisticsView`（例如 `getGlobalStatistics/getTotalCollateral/getTotalDebt`）。
- **用户仓位**：`PositionView` / `UserView`。

> 注意：`SystemView` 中保留的 legacy getter（如 `getAssetPrice/getTotalDebt/...`）为兼容债务，可能会直接 revert；集成代码应统一切换到 `route*()` 或直接调用专属 View。

### 3. （已移除）VaultStorage.sol - 旧版存储合约
**说明**：按 `docs/Architecture-Guide.md` 的 SSOT 口径，模块地址解析与系统配置不再通过 `VaultStorage` 作为中间层。

- **模块地址 SSOT**：直接使用 `Registry.getModule*`（链上）或通过 `SystemView/RegistryView`（只读门面）
- **结算币 SSOT**：`Registry[KEY_SETTLEMENT_TOKEN]`
- **风险阈值 SSOT**：`KEY_LIQUIDATION_CONFIG_MANAGER → LiquidationConfigModule`（由 `LiquidationRiskManager` 对外透传/聚合）

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
    function percentageMul(uint256 value, uint256 bps) internal pure returns (uint256)
    function percentageDiv(uint256 value, uint256 bps) internal pure returns (uint256)

    // 奖励和费用计算
    function calculateLiquidationBonus(uint256 amount, uint256 bonusBps) internal pure returns (uint256)
    function calculateFee(uint256 amount, uint256 feeBps) internal pure returns (uint256)
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

function calculateFee(uint256 amount, uint256 feeBps) internal pure returns (uint256) {
    return VaultMath.calculateFee(amount, feeBps);
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
function borrow(address user, address asset, uint256 amount, uint256 fee, uint256 blockNumber) external
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
2. `VaultRouter` - 查询操作入口
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
const [healthFactor, isValid] = await vaultView.getUserHealthFactorWithMeta(userAddress);
```

#### 借款操作
```javascript
// 1. 检查健康因子
const [healthFactor, isValid] = await vaultView.getUserHealthFactorWithMeta(userAddress);

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
await vaultCore.repay(orderId, assetAddress, amount);

// 4. 查询还款后的状态
const remainingDebt = await vaultView.getUserDebt(userAddress, assetAddress);
```

#### 提取操作
```javascript
// 1. 检查用户抵押物
const userCollateral = await vaultView.getUserCollateral(userAddress, assetAddress);

// 2. 检查健康因子
const [healthFactor, isValid] = await vaultView.getUserHealthFactorWithMeta(userAddress);

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
- `Deposit(address indexed user, address indexed asset, uint256 amount, uint256 blockNumber)`
- `Withdraw(address indexed user, address indexed asset, uint256 amount, uint256 blockNumber)`
- `Borrow(address indexed user, address indexed asset, uint256 amount, uint256 blockNumber)`
- `Repay(address indexed user, address indexed asset, uint256 amount, uint256 blockNumber)`
- `DepositAndBorrow(address indexed user, address indexed collateralAsset, uint256 collateralAmount, address indexed borrowAsset, uint256 borrowAmount, uint256 blockNumber)`
- `RepayAndWithdraw(address indexed user, address indexed repayAsset, uint256 repayAmount, address indexed withdrawAsset, uint256 withdrawAmount, uint256 blockNumber)`

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
# Core Contracts部署脚本更新总结

## 📋 **更新概述**

由于core文件夹中的所有文件都进行了Registry升级，需要更新部署脚本中的初始化参数，确保所有合约都使用Registry地址进行初始化。

## ✅ **已更新的部署脚本**

### **1. PriceOracle.sol**
```typescript
// 旧版本
deployed.PriceOracle = await deployProxy('PriceOracle', [
  deployed.AccessControlManager, // acmAddr
  deployer.address               // initialPriceUpdater
]);

// 新版本
deployed.PriceOracle = await deployProxy('PriceOracle', [
  deployed.Registry // initialRegistryAddr
]);
```

### **2. CoinGeckoPriceUpdater.sol**
```typescript
// 旧版本
deployed.CoinGeckoPriceUpdater = await deployProxy('CoinGeckoPriceUpdater', [
  deployed.AccessControlManager, // accessControlManager
  deployed.PriceOracle           // priceOracle
]);

// 新版本
deployed.CoinGeckoPriceUpdater = await deployProxy('CoinGeckoPriceUpdater', [
  deployed.Registry // initialRegistryAddr
]);
```

### **3. FeeRouter.sol**
```typescript
// 旧版本
deployed.FeeRouter = await deployProxy('FeeRouter', [
  deployed.AccessControlManager, // accessControlManager
  deployer.address, // platformTreasury
  deployer.address, // ecosystemVault
  9,                // platformBps (0.09% = 9 基点)
  1                 // ecoBps (0.01% = 1 基点)
]);

// 新版本
deployed.FeeRouter = await deployProxy('FeeRouter', [
  deployed.Registry, // initialRegistryAddr
  deployer.address, // platformTreasury
  deployer.address, // ecosystemVault
  9,                // platformBps (0.09% = 9 基点)
  1                 // ecoBps (0.01% = 1 基点)
]);
```

### **4. LendingEngine.sol**
```typescript
// 新增部署
deployed.LendingEngine = await deployProxy('LendingEngine', [
  deployed.Registry // initialRegistryAddr
]);
```

### **5. LoanNFT.sol**
```typescript
// 旧版本
deployed.LoanNFT = await deployProxy('LoanNFT', ['Loan NFT', 'LOAN', deployer.address]);

// 新版本
deployed.LoanNFT = await deployProxy('LoanNFT', [
  'Loan NFT', // name_
  'LOAN',     // symbol_
  deployer.address, // baseTokenURI_
  deployed.Registry // initialRegistryAddr
]);
```

## 🔄 **参数变更说明**

### **初始化函数变更**
```solidity
// PriceOracle
function initialize(address initialRegistryAddr) external initializer

// CoinGeckoPriceUpdater
function initialize(address initialRegistryAddr) external initializer

// FeeRouter
function initialize(address initialRegistryAddr, address platformTreasury_, address ecosystemVault_, uint256 platformBps_, uint256 ecoBps_) external initializer

// LendingEngine
function initialize(address initialRegistryAddr) external initializer

// LoanNFT
function initialize(string memory name_, string memory symbol_, string memory baseTokenURI_, address initialRegistryAddr) external initializer
```

### **部署参数变更**
```typescript
// 旧版本 - 直接传递模块地址
[deployed.AccessControlManager, deployed.PriceOracle]

// 新版本 - 传递Registry地址
[deployed.Registry]
```

## 🎯 **更新效果**

### **1. 模块化架构支持**
- 所有core合约现在都支持Registry模块化架构
- 能够动态获取其他模块地址
- 支持Registry升级事件监听

### **2. 部署流程优化**
- 确保Registry在所有core合约之前部署
- 保持正确的依赖关系
- 支持动态模块注册

### **3. 向后兼容性**
- 保持了原有的功能完整性
- 只影响初始化参数，不影响业务逻辑
- 部署流程更加健壮

## 📊 **部署顺序要求**

### **正确的部署顺序**
1. **Registry** - 必须先部署
2. **AccessControlManager** - 依赖Registry
3. **PriceOracle** - 依赖Registry
4. **CoinGeckoPriceUpdater** - 依赖Registry
5. **FeeRouter** - 依赖Registry
6. **LendingEngine** - 依赖Registry
7. **LoanNFT** - 依赖Registry
8. **其他模块** - 依赖core模块

### **依赖关系图**
```
Registry
    ↓
AccessControlManager
    ↓
PriceOracle
    ↓
CoinGeckoPriceUpdater
    ↓
FeeRouter
    ↓
LendingEngine
    ↓
LoanNFT
    ↓
其他业务模块
```

## 🔧 **模块注册更新**

### **registerModules函数更新**
```typescript
// 添加了新的core模块到注册列表
const modules = [
  // ... 其他模块
  
  // 核心业务
  'FeeRouter',
  'LendingEngine',    // 新增
  'LoanNFT',          // 新增
  'LoanEvents',
  
  // ... 其他模块
];
```

## ✅ **更新状态**

- **PriceOracle**: ✅ 已更新
- **CoinGeckoPriceUpdater**: ✅ 已更新
- **FeeRouter**: ✅ 已更新
- **LendingEngine**: ✅ 已添加
- **LoanNFT**: ✅ 已更新
- **模块注册**: ✅ 已更新
- **参数验证**: ✅ 已完成
- **依赖关系**: ✅ 已确认

## 🎉 **总结**

所有core文件相关的部署脚本已成功更新，支持新的Registry模块化架构。更新后的部署流程更加健壮，能够正确处理模块间的依赖关系，确保系统部署的可靠性。

### **主要改进**
1. **统一参数传递** - 所有core合约都使用Registry地址初始化
2. **动态模块获取** - 通过Registry动态获取其他模块地址
3. **事件驱动架构** - 支持Registry升级事件监听
4. **模块注册完善** - 确保所有core模块都正确注册到Registry

现在整个core模块的部署流程都完全符合模块化架构要求！ 
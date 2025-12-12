# 清算积分惩罚逻辑设计文档

## 📋 **概述**

本文档描述了RWA借贷平台清算情况下的积分惩罚机制，包括惩罚计算、执行流程和积分债务处理。

## 🔄 **清算积分惩罚流程**

### **完整清算流程（包含积分惩罚）**

```
用户违约 → 健康因子低于105%
         ↓
Keeper触发清算
         ↓
扣押抵押物 + 减少债务
         ↓
计算残值并分配
         ↓
✅ 执行积分惩罚
         ↓
积分扣除或记录债务
```

### **积分惩罚计算**

```solidity
// 惩罚积分 = 债务价值的1%
penaltyPoints = (debtValue * 100) / 10000; // 1% = 100 basis points
```

### **示例计算**

#### **场景：用户违约清算**
- 债务价值：95USDC
- 惩罚积分：95 * 1% = 0.95积分

## 🏗️ **技术实现**

### **核心组件**

#### 1. **LiquidationManager** - 清算管理器
```solidity
function _applyLiquidationPenalty(address user, uint256 debtValue) internal {
    // 获取RewardManager地址
    address rewardManager = IVaultStorage(vaultStorage).getNamedModule(
        ModuleKeys.getModuleKeyString(ModuleKeys.KEY_RM)
    );
    
    // 计算惩罚积分：债务价值的1%
    uint256 penaltyPoints = (debtValue * 100) / VaultTypes.HUNDRED_PERCENT;
    
    if (penaltyPoints > 0) {
        // 调用RewardManager的惩罚功能
        IRewardManager(rewardManager).applyPenalty(user, penaltyPoints);
        
        // 发出清算惩罚事件
        emit LiquidationTypes.LiquidationPenaltyApplied(
            user, penaltyPoints, debtValue, block.timestamp
        );
    }
}
```

#### 2. **RewardManager** - 奖励管理器
```solidity
function applyPenalty(address user, uint256 points) external {
    // 权限验证：只允许清算模块调用
    address guaranteeFundManager = registry.getModule(ModuleKeys.KEY_GUARANTEE_FUND);
    if (msg.sender != guaranteeFundManager) revert MissingRole();
    
    // 调用核心合约的惩罚功能
    rewardManagerCore.deductPoints(user, points);
}
```

#### 3. **RewardManagerCore** - 奖励核心逻辑
```solidity
function deductPoints(address user, uint256 points) external nonReentrant {
    // 权限检查
    address guaranteeFundManager = registry.getModule(ModuleKeys.KEY_GUARANTEE_FUND);
    address rewardManager = registry.getModule(ModuleKeys.KEY_RM);
    if (msg.sender != guaranteeFundManager && msg.sender != rewardManager) {
        revert MissingRole();
    }
    
    // 尝试扣除积分
    try RewardPoints(registry.getModule(ModuleKeys.KEY_REWARD_POINTS)).burnPoints(user, points) {
        // 成功扣除积分
    } catch {
        // 如果积分不足，记录到惩罚账本
        penaltyLedger[user] += points;
    }
}
```

### **惩罚账本机制**

#### **积分债务处理**
```solidity
// 当用户获得新积分时，优先抵扣惩罚债务
uint256 debt = penaltyLedger[user];
if (debt > 0) {
    if (points >= debt) {
        points -= debt;
        penaltyLedger[user] = 0;
    } else {
        penaltyLedger[user] = debt - points;
        points = 0;
    }
}
```

## 📊 **积分惩罚示例**

### **场景1：用户有足够积分**

#### **初始状态**
- 用户积分：100积分
- 债务价值：95USDC
- 惩罚积分：0.95积分

#### **清算执行**
1. 扣押抵押物：95USDC RWAToken
2. 减少债务：95USDC
3. 计算残值：5USDC
4. **执行积分惩罚**：扣除0.95积分

#### **最终结果**
- 用户积分：99.05积分
- 惩罚债务：0积分

### **场景2：用户积分不足**

#### **初始状态**
- 用户积分：0.5积分
- 债务价值：95USDC
- 惩罚积分：0.95积分

#### **清算执行**
1. 扣押抵押物：95USDC RWAToken
2. 减少债务：95USDC
3. 计算残值：5USDC
4. **执行积分惩罚**：
   - 扣除0.5积分（现有积分）
   - 记录0.45积分债务

#### **最终结果**
- 用户积分：0积分
- 惩罚债务：0.45积分

### **场景3：后续积分抵扣**

#### **用户获得新积分**
- 新获得积分：10积分
- 现有惩罚债务：0.45积分

#### **积分处理**
1. 抵扣惩罚债务：0.45积分
2. 剩余积分：9.55积分

#### **最终结果**
- 用户积分：9.55积分
- 惩罚债务：0积分

## 🔧 **配置参数**

### **惩罚比例**
```solidity
// 惩罚积分比例：债务价值的1%
PENALTY_RATE = 100; // 100 basis points = 1%
```

### **权限控制**
```solidity
// 只有以下模块可以调用积分惩罚
- KEY_GUARANTEE_FUND (清算模块)
- KEY_RM (奖励管理器)
```

## 📈 **优势分析**

### **1. 风险控制**
- 清算用户受到积分惩罚，增加违约成本
- 防止恶意违约行为
- 维护平台信用体系

### **2. 激励机制**
- 鼓励用户按时还款
- 提高平台整体信用质量
- 保护出借人利益

### **3. 灵活性**
- 支持积分不足时的债务记录
- 后续积分自动抵扣
- 批量处理支持

### **4. 透明度**
- 完整的惩罚记录
- 详细的事件日志
- 可追溯的惩罚历史

## 🚀 **使用指南**

### **清算人操作**
```solidity
// 清算操作会自动触发积分惩罚
uint256 reward = liquidationManager.liquidate(
    user, collateralAsset, debtAsset, collateralAmount, debtAmount
);
// 积分惩罚会在清算过程中自动执行
```

### **查询惩罚债务**
```solidity
// 查询用户的惩罚债务
uint256 penaltyDebt = rewardManager.getUserPenaltyDebt(user);
```

### **管理员监控**
```solidity
// 监控清算惩罚事件
event LiquidationPenaltyApplied(
    address indexed user,
    uint256 penaltyPoints,
    uint256 debtValue,
    uint256 timestamp
);
```

## 📝 **事件记录**

### **清算惩罚事件**
```solidity
event LiquidationPenaltyApplied(
    address indexed user,
    uint256 penaltyPoints,
    uint256 debtValue,
    uint256 timestamp
);
```

### **积分扣除事件**
```solidity
event PenaltyPointsDeducted(
    bytes32 indexed actionKey,
    address indexed user,
    uint256 points,
    uint256 remainingDebt,
    address indexed deductedBy,
    uint256 timestamp
);
```

## 🔒 **安全考虑**

1. **权限控制**：只有授权的清算模块可以执行惩罚
2. **重入保护**：使用ReentrancyGuard防止重入攻击
3. **参数验证**：所有输入参数都经过严格验证
4. **债务记录**：积分不足时记录债务，确保惩罚执行
5. **事件记录**：完整的操作记录便于审计

## 📊 **监控指标**

1. **惩罚频率**：单位时间内的惩罚次数
2. **惩罚金额**：总惩罚积分统计
3. **债务累积**：惩罚债务的累积情况
4. **抵扣效率**：积分抵扣债务的效率
5. **用户影响**：惩罚对用户行为的影响

---

*本文档描述了清算情况下的积分惩罚机制，确保违约用户承担相应责任，维护平台信用体系。* 
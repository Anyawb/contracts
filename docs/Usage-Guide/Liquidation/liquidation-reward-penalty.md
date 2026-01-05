# 清算积分惩罚与奖励口径（与当前实现对齐）

## 🔗 References（口径来源与关联文档）

- **Architecture**: [`docs/Architecture-Guide.md`](../../Architecture-Guide.md)
- **Terminology**: [`docs/Architecture-Liquidation-DirectLedger-Terminology.md`](../../Architecture-Liquidation-DirectLedger-Terminology.md)
- **Related**
  - 清算机制与调用链（概要）：[`Liquidation-Mechanism-Logic.md`](./Liquidation-Mechanism-Logic.md)
  - 完整清算逻辑（端到端口径）：[`liquidation-complete-logic.md`](./liquidation-complete-logic.md)

## 📋 **概述**

本文档对齐当前实现的两个事实：

1) **清算写路径**（`LiquidationManager → CM.withdrawCollateralTo → LE.forceReduceDebt → LiquidatorView.push*`）目前**不包含**“积分惩罚/清算奖励”的链上结算逻辑。  
2) **积分系统（Reward）**主线写入口由 `ORDER_ENGINE(core/LendingEngine)` 在借/还落账后调用 `RewardManager.onLoanEvent*`；清算并非默认触发点。

因此：本文档中的“清算积分惩罚”属于**可选扩展设计**，需要显式接入写入口与权限，默认不启用。

## 🔄 **清算积分惩罚流程**

### **完整清算流程（包含积分惩罚）**

```
用户违约 → 健康因子低于105%
         ↓
Keeper触发清算
         ↓
扣押抵押物 + 减少债务
         ↓
（可选扩展）计算惩罚分值
         ↓
（可选扩展）执行积分惩罚（RewardManager.applyPenalty）
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

#### 1. **LiquidationManager（现状说明）**

当前实现中，`LiquidationManager` 的职责是“直达账本写入 + 单点推送”，**不会**调用 `RewardManager.applyPenalty`。

若要启用“清算积分惩罚”，推荐做法是：

- 由链下 keeper/服务在清算完成后计算 `penaltyPoints`
- 调用具备权限的模块触发 `RewardManager.applyPenalty(user, penaltyPoints)`（见下文权限约束）

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
// 写入口：RewardManager.applyPenalty 仅允许 KEY_GUARANTEE_FUND（GuaranteeFundManager）调用
// 核心：RewardManagerCore.deductPoints 仅允许 KEY_GUARANTEE_FUND 或 KEY_RM 调用
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
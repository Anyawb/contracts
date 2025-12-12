# 清算阈值详细说明文档

## 📋 **概述**

清算阈值是RWA借贷平台的核心风险控制参数，用于判断用户是否可以被清算。当用户的健康因子低于清算阈值时，系统允许清算人执行清算操作，确保平台资产安全。

## 🎯 **清算阈值概念**

### **定义**
清算阈值是触发清算操作的健康因子最低标准，以基点（basis points）表示：
- **默认值**: 105% = 10,500 bps
- **有效范围**: 100% - 150% (10,000 - 15,000 bps)
- **单位**: 基点（1% = 100 bps）

### **健康因子计算**
```solidity
健康因子 = (抵押物价值 / 债务价值) × 10000
```

### **清算触发条件**
```solidity
if (用户健康因子 < 清算阈值) {
    触发清算操作;
}
```

## 🏗️ **技术实现**

### **相关文件**
- **主文件**: `contracts/Vault/liquidation/modules/LiquidationRiskManager.sol`
- **类型定义**: `contracts/Vault/types/LiquidationTypes.sol`
- **数学计算**: `contracts/Vault/VaultMath.sol`

### **默认值定义**
```solidity
// LiquidationTypes.sol
uint256 internal constant DEFAULT_LIQUIDATION_THRESHOLD = 10_500; // 105% in basis points
uint256 internal constant MIN_LIQUIDATION_THRESHOLD = 10_000;     // 100% in basis points
uint256 internal constant MAX_LIQUIDATION_THRESHOLD = 15_000;     // 150% in basis points
```

### **存储变量**
```solidity
// LiquidationRiskManager.sol
uint256 public liquidationThresholdVar;
```

### **验证函数**
```solidity
// LiquidationTypes.sol
function isValidLiquidationThreshold(uint256 threshold) internal pure returns (bool valid) {
    return threshold >= MIN_LIQUIDATION_THRESHOLD && threshold <= MAX_LIQUIDATION_THRESHOLD;
}
```

## 📊 **清算阈值使用示例**

### **场景设定**
```
用户A借贷情况：
- 抵押物：100美金的RWAToken
- 借款：95美金USDC
- 借款期限：30天
- 年化利率：5%
```

### **1. 初始状态计算**

#### **健康因子计算**
```solidity
uint256 collateralValue = 100; // 抵押物价值
uint256 debtValue = 95;        // 债务价值

uint256 healthFactor = (collateralValue * 10000) / debtValue;
// healthFactor = (100 * 10000) / 95 = 10526 bps (约105.26%)

console.log("用户A初始健康因子：105.26%");
```

#### **清算判断**
```solidity
uint256 liquidationThreshold = 10500; // 105% = 10500 bps

if (healthFactor < liquidationThreshold) {
    console.log("用户可被清算！");
} else {
    console.log("用户健康，无需清算");
}
// 结果：10526 > 10500，用户A暂时安全
```

### **2. 价格下跌场景**

#### **RWAToken价格下跌10%**
```solidity
uint256 newCollateralValue = 100 * 0.9; // 90美金
uint256 debtValue = 95;                  // 债务不变

uint256 newHealthFactor = (newCollateralValue * 10000) / debtValue;
// newHealthFactor = (90 * 10000) / 95 = 9474 bps (94.74%)

console.log("价格下跌后健康因子：94.74%");
```

#### **清算触发**
```solidity
if (newHealthFactor < liquidationThreshold) {
    console.log("触发清算！用户A可被清算");
    // 清算人可以开始清算操作
}
// 结果：9474 < 10500，触发清算
```

### **3. 不同阈值的影响**

#### **阈值105%（默认）**
```solidity
uint256 threshold105 = 10500;
if (9474 < threshold105) {
    console.log("触发清算 - 用户A可被清算");
}
```

#### **阈值110%（更保守）**
```solidity
uint256 threshold110 = 11000;
if (9474 < threshold110) {
    console.log("触发清算 - 用户A可被清算");
}
// 更早触发清算，风险控制更严格
```

#### **阈值100%（更宽松）**
```solidity
uint256 threshold100 = 10000;
if (9474 < threshold100) {
    console.log("触发清算 - 用户A可被清算");
} else {
    console.log("用户A暂时安全");
}
// 结果：9474 < 10000，仍然触发清算
```

## 🔧 **参数配置**

### **更新清算阈值**
```solidity
// LiquidationRiskManager.sol
function updateLiquidationThreshold(uint256 newThreshold) external override {
    acmVar.requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
    
    if (!LiquidationTypes.isValidLiquidationThreshold(newThreshold)) {
        revert LiquidationTypes.InvalidLiquidationThreshold(newThreshold);
    }

    liquidationThresholdVar = newThreshold;
    emit LiquidationTypes.LiquidationThresholdUpdated(
        liquidationThresholdVar, newThreshold, block.timestamp
    );
}
```

### **权限要求**
- **角色**: `ACTION_SET_PARAMETER`
- **调用者**: 具有治理权限的地址
- **验证**: 参数必须在有效范围内（100%-150%）

### **事件记录**
```solidity
event LiquidationThresholdUpdated(
    uint256 oldThreshold,
    uint256 newThreshold,
    uint256 timestamp
);
```

## 📈 **清算阈值调整策略**

### **提高清算阈值（更保守）**

#### **适用场景**
- 市场波动较大
- 抵押物价格不稳定
- 需要更严格的风险控制

#### **调整示例**
```solidity
// 从105%调整到110%
updateLiquidationThreshold(11000); // 110%

// 影响：更早触发清算，降低平台风险
// 用户A在健康因子94.74%时被清算（原本在94.74%时被清算）
```

#### **优缺点**
- **优点**: 降低平台风险，保护资产安全
- **缺点**: 可能影响用户体验，增加清算频率

### **降低清算阈值（更宽松）**

#### **适用场景**
- 市场稳定
- 抵押物价格波动较小
- 希望减少清算频率

#### **调整示例**
```solidity
// 从105%调整到102%
updateLiquidationThreshold(10200); // 102%

// 影响：延迟清算触发，给用户更多缓冲时间
// 用户A在健康因子94.74%时被清算（原本在94.74%时被清算）
```

#### **优缺点**
- **优点**: 改善用户体验，减少不必要的清算
- **缺点**: 增加平台风险，可能影响资产安全

## 🔍 **监控与查询**

### **查询当前清算阈值**
```solidity
// 查询当前阈值
uint256 currentThreshold = liquidationRiskManager.getLiquidationThreshold();
console.log("当前清算阈值：", currentThreshold / 100, "%");
```

### **检查用户清算状态**
```solidity
// 检查用户是否可被清算
bool liquidatable = liquidationRiskManager.isLiquidatable(userAddress);
if (liquidatable) {
    console.log("用户可被清算");
} else {
    console.log("用户健康，无需清算");
}
```

### **获取用户健康因子**
```solidity
// 获取用户健康因子
uint256 healthFactor = liquidationRiskManager.getUserHealthFactor(userAddress);
console.log("用户健康因子：", healthFactor / 100, "%");
```

### **批量查询**
```solidity
// 批量检查多个用户
address[] memory users = [user1, user2, user3];
bool[] memory liquidatableFlags = liquidationRiskManager.batchIsLiquidatable(users);

for (uint256 i = 0; i < users.length; i++) {
    console.log("用户", i, "可清算：", liquidatableFlags[i]);
}
```

## 🛡️ **安全考虑**

### **参数验证**
```solidity
// 确保阈值在有效范围内
function isValidLiquidationThreshold(uint256 threshold) internal pure returns (bool valid) {
    return threshold >= MIN_LIQUIDATION_THRESHOLD && threshold <= MAX_LIQUIDATION_THRESHOLD;
}
```

### **权限控制**
- 只有具有治理权限的地址可以调整清算阈值
- 所有参数调整都有事件记录，便于审计
- 支持紧急暂停功能

### **风险监控**
- 实时监控用户健康因子
- 批量查询清算风险
- 缓存机制提高查询效率

## 📊 **清算阈值与其他参数的关系**

### **与清算奖励的关系**
```
清算阈值越低 → 清算频率越高 → 需要更多清算人参与 → 可能需要提高清算奖励
清算阈值越高 → 清算频率越低 → 清算人参与度可能降低 → 可能需要降低清算奖励
```

### **与最大清算比例的关系**
```
清算阈值越低 → 用户风险越高 → 可能需要降低最大清算比例以控制风险
清算阈值越高 → 用户风险相对较低 → 可以适当提高最大清算比例
```

### **与缓存有效期的关系**
```
清算阈值越低 → 需要更频繁的监控 → 可能需要缩短缓存有效期
清算阈值越高 → 监控频率可以降低 → 可以适当延长缓存有效期
```

## 🚀 **最佳实践**

### **1. 市场环境适配**
- **牛市**: 可以适当降低清算阈值，减少不必要的清算
- **熊市**: 建议提高清算阈值，加强风险控制
- **震荡市**: 保持适中阈值，平衡风险与用户体验

### **2. 抵押物特性考虑**
- **稳定币**: 可以设置较低阈值
- **波动性资产**: 建议设置较高阈值
- **新兴资产**: 需要更保守的阈值设置

### **3. 用户群体分析**
- **机构用户**: 可以设置较低阈值，信任度较高
- **个人用户**: 建议设置较高阈值，风险控制更严格

### **4. 监控指标**
- **清算频率**: 监控清算触发频率
- **用户反馈**: 关注用户对清算时机的反馈
- **市场表现**: 跟踪抵押物价格波动情况

## 📚 **相关文档**

- [清算模块整体介绍](./Liquidation-Module-Overview.md)
- [完整清算逻辑设计](./liquidation-complete-logic.md)
- [清算奖励与惩罚机制](./liquidation-reward-penalty.md)
- [正常还款与清算对比](./normal-repayment-vs-liquidation.md)

## 🤝 **技术支持**

如有关于清算阈值配置的问题，请联系：
- **技术团队**: tech@example.com
- **文档更新**: 2024年12月
- **版本**: v1.0.0

---

**注意**: 清算阈值的调整直接影响平台的风险控制策略，请在充分评估市场环境和用户反馈的基础上进行谨慎调整。 
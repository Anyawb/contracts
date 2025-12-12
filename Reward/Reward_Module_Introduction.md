# Reward积分系统模块介绍

## 概述

Reward积分系统是RWA借贷平台的核心激励机制，通过智能合约实现积分发放、消费、管理和查询的完整生态。系统采用模块化设计，确保高可扩展性、易维护性和部署合规性。

## 架构设计

### 模块化架构

```
RewardManager (主入口)
├── RewardManagerCore (核心业务逻辑)
├── RewardConsumption (消费管理)
│   └── RewardCore (消费核心逻辑)
└── RewardConfig (配置管理)
    ├── BaseServiceConfig (抽象基类)
    └── 具体配置实现 (5个服务配置合约)
        ├── AdvancedAnalyticsConfig
        ├── PriorityServiceConfig
        ├── FeatureUnlockConfig
        ├── GovernanceAccessConfig
        └── TestnetFeaturesConfig

RewardManager (入口层)
├── 权限验证：ACM.requireRole(ACTION_SET_PARAMETER)
├── 调用核心：rewardManagerCore.xxx()
└── 事件记录：VaultTypes.ActionExecuted

RewardManagerCore (核心层)
├── 权限验证：Registry.getModule() 地址验证
├── 业务逻辑：积分计算、缓存、等级管理
└── 事件记录：业务事件 + 标准化事件
```

### 设计原则

1. **单一职责原则**：每个合约专注于特定功能
2. **模块化分离**：业务逻辑与配置管理分离
3. **可扩展性**：支持新功能无缝集成
4. **部署合规**：单文件大小控制在24KB以内

## 核心功能

### 1. 积分发放系统 (RewardManager)

#### 功能特性
- **动态积分计算**：基于借款金额、时长、用户等级计算积分
- **批量操作优化**：支持批量积分发放，提升性能
- **用户等级系统**：1-5级用户等级，不同等级享受不同积分倍数
- **缓存机制**：积分计算缓存，减少重复计算
- **惩罚机制**：支持积分扣除和欠分记录
- **期限解锁机制**：积分驱动的长期期限解锁功能

#### 核心参数（现行）
```solidity
minEligibleAmount: 合格借款最低金额（默认 1000 USDT/USDC 等价）
onTimeWindow: 按期窗口（默认 ±24 小时）
earlyPenaltyBps: 提前还款扣罚（默认 300 = 3%）
latePenaltyBps: 逾期还款扣罚（默认 500 = 5%）
basePointPerHundredUsd: 每 100 USD 借款的基础积分（18 位精度）
durationPointPerDay: 每借款 1 天的积分（缩放项）
dynamicRewardThreshold: 动态奖励触发阈值
dynamicRewardMultiplier: 动态奖励倍数（BPS）
```

#### 积分计算与发放（锁定-释放-扣罚）
```
资格：借款本金 < 1000 USDT/USDC 不计分；≥1000 计为“合格借款”。
锁定：合格借款计算“锁定积分”，先不发放。
BaseRaw  = (eligibleAmount / 100) × (durationDays / 5)
Base     = BaseRaw × basePointPerHundredUsd / 1e18
Level    = Base × levelMultiplier[level] / 10000
Dynamic  = 若 Level ≥ dynamicRewardThreshold，则 Level × dynamicRewardMultiplier / 10000
Locked   = Level (+ Dynamic)
释放：按期且足额还款（到期±onTimeWindow 内）→ 一次性释放 Locked。
提前：不释放 Locked，并扣罚 earlyPenaltyBps。
逾期：不释放 Locked，并扣罚 latePenaltyBps。
欠分：余额不足时，进入欠分账本，后续积分优先抵扣。
```

#### 扣罚与欠分
- 提前还款：扣 3%（默认），不释放本笔锁定积分
- 逾期还款：扣 5%（默认），不释放本笔锁定积分
- 余额不足：进入欠分账本（PenaltyLedger），后续积分优先抵扣

#### 用户等级体系（次数+金额+履约）
| 等级 | 倍数   | 升级条件（同时满足）                                  |
|------|--------|---------------------------------------------------------|
| 1级  | 1.00x | 默认                                                   |
| 2级  | 1.10x | 累计金额 ≥ 10,000；合格借款次数 ≥ 3；履约次数 ≥ 1     |
| 3级  | 1.25x | 累计金额 ≥ 50,000；合格借款次数 ≥ 10；履约次数 ≥ 5    |
| 4级  | 1.50x | 累计金额 ≥ 100,000；合格借款次数 ≥ 20；履约次数 ≥ 10  |
| 5级  | 2.00x | 累计金额 ≥ 500,000；合格借款次数 ≥ 50；履约次数 ≥ 30  |

### 2. 积分消费系统 (RewardConsumption)

#### 服务类型
1. **高级数据分析** (AdvancedAnalytics)
   - 基础：基础数据分析报告
   - 标准：深度风险评估
   - 高级：个性化投资建议
   - VIP：专属分析师服务

2. **优先服务** (PriorityService)
   - 基础：优先贷款审批(24小时)
   - 标准：专属客户服务
   - 高级：紧急交易处理(4小时)
   - VIP：专属经理服务

3. **功能解锁** (FeatureUnlock)
   - 基础：自定义利率计算器
   - 标准：批量操作工具
   - 高级：高级风险管理工具
   - VIP：全功能解锁

4. **治理参与** (GovernanceAccess)
   - 基础：基础投票权
   - 标准：提案创建权
   - 高级：参数调整建议权
   - VIP：核心治理参与权

5. **测试网功能** (TestnetFeatures)
   - 基础：模拟大额贷款
   - 标准：压力测试工具
   - 高级：高级调试功能
   - VIP：全测试网权限

#### 服务等级
- **基础** (Basic)：入门级服务
- **标准** (Standard)：标准级服务
- **高级** (Premium)：高级服务
- **VIP** (VIP)：VIP专属服务

### 3. 配置管理系统 (RewardConfig)

#### 管理功能
- 服务价格配置
- 服务冷却期设置
- 升级倍数调整
- 测试网模式切换
- **服务使用统计**：记录各等级服务的使用次数和收入
- **服务描述管理**：支持动态更新服务描述
- **批量操作**：支持批量更新价格和激活状态
- **紧急控制**：支持紧急暂停和恢复所有服务

#### 高级数据分析服务配置
```solidity
// 服务等级配置
Basic: 100积分/30天 - 基础数据分析报告与市场趋势
Standard: 500积分/30天 - 深度风险评估与投资组合分析
Premium: 1000积分/30天 - 个性化投资建议与AI洞察
VIP: 2000积分/30天 - VIP专属分析师服务与24/7支持
```

#### 统计功能
- **使用统计**：`serviceUsageCount[level]` - 记录各等级服务使用次数
- **收入统计**：`serviceRevenue[level]` - 记录各等级服务总收入
- **实时监控**：支持实时查询服务使用情况和收入数据
- **批量统计**：`getAllServiceStats()` - 一次性获取所有服务统计信息

## 业务规则

### 1. 贷款期限与续约规则

#### 固定期限设置
开放 8 档贷款期限：5/10/15/30/60/90/180/360 天（对应秒数：432000/864000/1296000/2592000/5184000/7776000/15552000/31104000）。
合约侧应通过 `require(duration ∈ AllowedDurations)` 强校验。

#### 自动续约机制
- 借方、贷方均可在到期前勾选「自动续约」
- 续约时系统 **不再重复收取撮合手续费**；`FeeRouter` 仅在首次 `matchOrder()` 成功时扣 0.03%
- 续约会重置 `endTimestamp` 并触发新的 `BorrowMatched`/`LendMatched` 事件，以便前端刷新倒计时
- 每次续约都会重新计算 `BasePoints`，并再次评估是否满足 5% Bonus 条件

#### 期限解锁（按等级）

为奖励履约记录优秀的用户：当用户积分等级 ≥ 4 时，可解锁 90/180/360 天期限；否则仅开放 5/10/15/30/60 天。

**执行逻辑（链上建议）**：
1. 借款前通过 RewardManager 查询 `getUserLevel(user)`。
2. `_isAllowedTerm(termDays, level)` 校验：`termDays ∈ {5,10,15,30,60}` 或（`level ≥ 4 且 termDays ∈ {90,180,360}`）。
3. 校验通过后，将 `termDays * 1 days` 作为 `durationSec` 传入 `onLoanEvent()` 完成积分“锁定”计算。

## 技术特性

### 1. 智能合约优化
- **Gas优化**：批量操作减少Gas消耗
- **存储优化**：合理使用mapping和数组
- **计算优化**：缓存机制避免重复计算

### 2. 安全性保障
- **权限控制**：基于角色的访问控制
- **重入攻击防护**：使用ReentrancyGuard
- **参数验证**：严格的输入验证
- **升级机制**：UUPS代理模式支持升级

### 3. 可扩展性
- **模块化设计**：新功能可独立部署
- **接口标准化**：统一的调用接口
- **配置分离**：业务逻辑与配置分离

## 业务流程

### 积分发放流程
1. 用户进行借贷操作
2. LendingEngine调用RewardManager.onLoanEvent()
3. 系统计算积分（考虑用户等级、动态奖励）
4. 先抵扣欠分，再发放积分
5. 更新用户活跃度和等级

### 积分消费流程
1. 用户选择服务和等级
2. 调用RewardConsumption.consumePointsForService()
3. 验证用户余额和服务可用性
4. 扣除积分并授予特权
5. 记录消费历史
6. **更新服务统计**：调用AdvancedAnalyticsConfig.recordServiceUsage()更新使用次数和收入

### 批量操作流程
1. 系统收集批量操作数据
2. 调用批量接口（如onBatchLoanEvents）
3. 并行处理多个用户操作
4. 统一更新统计信息

### 期限解锁流程
1. 用户发起借款请求
2. 系统检查用户积分余额
3. 根据积分阈值确定可选期限
4. 验证用户选择的期限是否在允许范围内
5. 执行借款操作并发放积分

## 治理机制

### 参数调整
- 积分计算参数调整
- 服务价格配置更新
- 用户等级倍数设置
- 动态奖励参数调整
- 期限解锁阈值调整

### 权限管理
- 治理角色：系统参数调整
- Lending角色：积分发放
- Penalty角色：积分扣除

## 监控与统计

### 系统统计
- 总消费积分
- 批量操作次数
- 服务使用统计
- 用户活跃度追踪
- 期限解锁使用情况

### 高级数据分析服务统计
- **服务使用统计**：各等级服务的使用次数追踪
- **收入统计**：各等级服务的总收入统计
- **服务可用性监控**：实时监控各等级服务的激活状态
- **价格变更追踪**：记录服务价格的变更历史
- **服务描述管理**：支持动态更新服务描述

#### 统计数据结构
```solidity
// 服务使用统计
mapping(ServiceLevel => uint256) public serviceUsageCount;
mapping(ServiceLevel => uint256) public serviceRevenue;

// 统计查询接口
function getServiceStats(ServiceLevel level) external view returns (uint256 usageCount, uint256 revenue);
function getAllServiceStats() external view returns (uint256[4] memory usageCounts, uint256[4] memory revenues);
```

#### 事件监控
- `AdvancedAnalyticsConfigUpdated` - 服务配置更新事件
- `AdvancedAnalyticsServiceToggled` - 服务激活状态变更事件
- `AdvancedAnalyticsPriceUpdated` - 服务价格更新事件
- `AdvancedAnalyticsDurationUpdated` - 服务时长更新事件

### 用户统计
- 个人积分余额
- 消费历史记录
- 特权状态查询
- 等级信息查询
- 欠分记录查询

## 部署说明

### 部署顺序
1. 部署RewardTypes（共享类型）
2. 部署RewardConfig（配置管理）
3. 部署RewardCore（消费核心）
4. 部署RewardConsumption（消费入口）
5. 部署RewardManagerCore（奖励核心）
6. 部署RewardManager（奖励入口）

### 初始化参数
```solidity
// RewardConfig初始化
initialize()

// RewardCore初始化
initialize(tokenAddr, configAddr)

// RewardConsumption初始化
initialize(tokenAddr, configAddr, coreAddr)

// RewardManagerCore初始化
initialize(tokenAddr, baseEth, perDay, bonus, baseUsd)

// RewardManager初始化
initialize(tokenAddr, coreAddr)
```

## 未来规划

### 短期目标
- 完善积分兑换机制
- 增加更多服务类型
- 优化批量操作性能
- 完善期限解锁机制

### 长期目标
- 跨链积分系统
- 积分NFT化
- 去中心化治理
- 智能合约自动化治理

## 总结

Reward积分系统通过模块化设计实现了高效、安全、可扩展的积分生态。系统不仅解决了文件大小限制问题，还为未来的功能扩展奠定了坚实基础。通过合理的架构设计和优化，系统能够支持大规模用户和高频交易场景，为RWA借贷平台提供强大的激励机制。

**核心创新点**：
- **积分驱动的期限解锁**：通过积分余额解锁更长期限，激励用户良好履约
- **欠分惩罚机制**：创新的欠分记录系统，确保惩罚的有效性
- **续约积分重算**：每次续约重新计算积分，鼓励长期合作
- **健康因子奖励**：基于健康因子的动态奖励机制，促进风险管理 
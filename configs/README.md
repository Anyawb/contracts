# 服务配置模块 (Service Configuration Modules)

本目录包含 RWA Lending Platform 的所有服务配置合约。这些合约管理平台提供的各种增值服务的配置、价格和权限。

## 📋 目录结构

```
configs/
├── AdvancedAnalyticsConfig.sol      # 高级数据分析服务配置
├── FeatureUnlockConfig.sol          # 功能解锁服务配置
├── GovernanceAccessConfig.sol        # 治理访问服务配置
├── PriorityServiceConfig.sol         # 优先服务配置
├── TestnetFeaturesConfig.sol         # 测试网功能配置
└── README.md                         # 本文档
```

## 🏗️ 架构设计

### 基础架构

所有配置合约都继承自 `BaseServiceConfig`，该基类提供：

- **UUPS 可升级模式**：支持合约升级
- **Registry 集成**：与系统 Registry 模块集成
- **ACM 权限控制**：使用 AccessControlManager 进行权限验证
- **标准化事件**：记录所有配置变更操作
- **冷却期机制**：防止频繁配置变更

### 服务等级体系

所有服务都支持 4 个等级：

| 等级 | 说明 | 典型价格范围 |
|------|------|-------------|
| **Basic** | 基础服务 | 100-300 积分 |
| **Standard** | 标准服务 | 500-1000 积分 |
| **Premium** | 高级服务 | 1500-3000 积分 |
| **VIP** | VIP 专属服务 | 3000-6000 积分 |

### 配置结构

每个服务配置包含以下字段：

```solidity
struct ServiceConfig {
    uint256 price;        // 服务价格（积分）
    uint256 duration;     // 服务持续时间（秒）
    bool isActive;        // 是否激活
    ServiceLevel level;   // 服务等级
    string description;   // 服务描述
}
```

## 📦 模块详情

### 1. FeatureUnlockConfig - 功能解锁配置

**功能**：管理平台功能解锁服务的配置

**服务内容**：
- Basic: 自定义利率计算器
- Standard: 批量操作工具
- Premium: 高级风险管理工具
- VIP: 完整功能解锁

**默认配置**：
- Basic: 200 积分，30 天
- Standard: 800 积分，30 天
- Premium: 1500 积分，30 天
- VIP: 3000 积分，30 天

**冷却期**：7 天

**权限要求**：
- `ACTION_SET_PARAMETER`：更新配置

---

### 2. GovernanceAccessConfig - 治理访问配置

**功能**：管理用户参与平台治理的权限配置

**服务内容**：
- Basic: 基础投票权
- Standard: 提案创建权
- Premium: 参数调整建议权
- VIP: 核心治理参与权

**默认配置**：
- Basic: 200 积分，30 天
- Standard: 1000 积分，30 天
- Premium: 2500 积分，30 天
- VIP: 6000 积分，30 天

**冷却期**：30 天

**权限要求**：
- `ACTION_SET_PARAMETER`：更新配置

---

### 3. PriorityServiceConfig - 优先服务配置

**功能**：管理优先处理服务的配置

**服务内容**：
- Basic: 优先贷款处理（24小时）
- Standard: 专属客户服务
- Premium: 紧急交易处理（4小时）
- VIP: VIP 专属经理服务

**默认配置**：
- Basic: 200 积分，30 天
- Standard: 500 积分，30 天
- Premium: 1000 积分，30 天
- VIP: 2000 积分，30 天

**冷却期**：12 小时

**特殊功能**：
- 批量更新配置
- 详细的事件记录
- 配置摘要查询

**权限要求**：
- `ACTION_SET_PARAMETER`：更新配置

---

### 4. AdvancedAnalyticsConfig - 高级数据分析配置

**功能**：管理高级数据分析服务的配置

**服务内容**：
- Basic: 基础数据分析报告（市场趋势）
- Standard: 深度风险评估（投资组合分析）
- Premium: 个性化投资建议（AI 洞察）
- VIP: VIP 专属分析师服务（24/7 支持）

**默认配置**：
- Basic: 200 积分，30 天
- Standard: 500 积分，30 天
- Premium: 1000 积分，30 天
- VIP: 2000 积分，30 天

**冷却期**：1 天

**特殊功能**：
- 服务使用统计
- 服务收入统计
- 服务描述管理
- 批量价格更新
- 紧急暂停/恢复功能

**权限要求**：
- `ACTION_SET_PARAMETER`：更新配置
- `ACTION_CONSUME_POINTS`：记录服务使用
- `ACTION_PAUSE_SYSTEM`：紧急暂停
- `ACTION_UNPAUSE_SYSTEM`：恢复服务

---

### 5. TestnetFeaturesConfig - 测试网功能配置

**功能**：管理测试网环境下的特殊功能配置

**服务内容**：
- Basic: 模拟大额贷款（测试网）
- Standard: 压力测试工具
- Premium: 高级调试功能
- VIP: 完整测试网权限

**默认配置**：
- Basic: 100 积分，7 天
- Standard: 300 积分，7 天
- Premium: 800 积分，7 天
- VIP: 1500 积分，7 天

**冷却期**：1 小时

**特殊功能**：
- 配置版本追踪
- 配置更新历史记录
- 权限验证辅助函数
- 紧急暂停/恢复功能

**权限要求**：
- `ACTION_TESTNET_CONFIG`：更新配置
- `ACTION_TESTNET_ACTIVATE`：激活功能
- `ACTION_TESTNET_PAUSE`：暂停功能

---

## 🔧 使用指南

### 初始化配置合约

```solidity
// 部署并初始化
FeatureUnlockConfig config = FeatureUnlockConfig(proxyAddress);
config.initialize(registryAddress);
```

### 更新服务配置

```solidity
// 需要 ACTION_SET_PARAMETER 权限
config.updateConfig(
    ServiceLevel.Premium,  // 服务等级
    1500e18,               // 价格（1500 积分）
    30 days,               // 持续时间
    true                   // 是否激活
);
```

### 查询服务配置

```solidity
// 获取特定等级配置
ServiceConfig memory config = config.getConfig(ServiceLevel.Premium);

// 获取服务价格
uint256 price = config.getServicePrice(ServiceLevel.Premium);

// 检查服务是否可用
bool isAvailable = config.isServiceAvailable(ServiceLevel.Premium);
```

### 批量更新（部分合约支持）

```solidity
// PriorityServiceConfig 和 TestnetFeaturesConfig 支持批量更新
ServiceLevel[] memory levels = [ServiceLevel.Basic, ServiceLevel.Standard];
uint256[] memory prices = [200e18, 500e18];
uint256[] memory durations = [30 days, 30 days];
bool[] memory isActives = [true, true];

config.batchUpdateConfig(levels, prices, durations, isActives);
```

---

## 🔐 权限系统

所有配置合约都使用 ACM (AccessControlManager) 进行权限控制：

### 主要权限

| 权限 | 说明 | 使用场景 |
|------|------|----------|
| `ACTION_SET_PARAMETER` | 设置参数 | 更新服务配置 |
| `ACTION_CONSUME_POINTS` | 消费积分 | 记录服务使用 |
| `ACTION_TESTNET_CONFIG` | 测试网配置 | 测试网功能配置 |
| `ACTION_TESTNET_ACTIVATE` | 测试网激活 | 激活测试网功能 |
| `ACTION_TESTNET_PAUSE` | 测试网暂停 | 暂停测试网功能 |
| `ACTION_PAUSE_SYSTEM` | 系统暂停 | 紧急暂停所有服务 |
| `ACTION_UNPAUSE_SYSTEM` | 系统恢复 | 恢复所有服务 |

### 权限授予

```solidity
// 通过 AccessControlManager 授予权限
IAccessControlManager acm = IAccessControlManager(acmAddress);
bytes32 role = ActionKeys.ACTION_SET_PARAMETER;
acm.grantRole(role, adminAddress);
```

---

## 📊 事件系统

所有配置合约都发出标准化事件：

### 通用事件

- `ConfigUpdated(uint8 level, uint256 price, uint256 duration, bool isActive)`
- `CooldownUpdated(uint256 cooldown)`
- `RegistryUpdated(address oldRegistry, address newRegistry)`
- `ActionExecuted(bytes32 actionKey, string actionKeyString, address executor, uint256 timestamp)`

### 特定事件

**AdvancedAnalyticsConfig**：
- `AdvancedAnalyticsConfigUpdated`
- `AdvancedAnalyticsServiceToggled`
- `AdvancedAnalyticsPriceUpdated`
- `AdvancedAnalyticsDurationUpdated`

**PriorityServiceConfig**：
- `PriorityServiceConfigInitialized`
- `PriorityServiceConfigUpdated`
- `PriorityServiceCooldownUpdated`

**TestnetFeaturesConfig**：
- `TestnetFeaturesConfigInitialized`
- `TestnetFeaturesConfigUpdated`
- `TestnetFeaturesCooldownUpdated`

---

## 🔄 升级机制

所有配置合约都使用 UUPS (Universal Upgradeable Proxy Standard) 模式：

### 升级流程

1. **部署新实现合约**
2. **通过 RegistryUpgradeManager 升级**
3. **验证升级结果**

### 升级权限

需要 `ACTION_UPGRADE_MODULE` 权限。

---

## 🚨 紧急功能

部分配置合约提供紧急暂停功能：

### AdvancedAnalyticsConfig

```solidity
// 紧急暂停所有服务（需要 ACTION_PAUSE_SYSTEM 权限）
config.emergencyPauseAllServices();

// 恢复所有服务（需要 ACTION_UNPAUSE_SYSTEM 权限）
config.emergencyUnpauseAllServices();
```

### TestnetFeaturesConfig

```solidity
// 紧急暂停所有测试网功能（需要 ACTION_TESTNET_PAUSE 权限）
config.emergencyPauseAllFeatures();

// 恢复所有测试网功能（需要 ACTION_TESTNET_ACTIVATE 权限）
config.emergencyUnpauseAllFeatures();
```

---

## 📈 统计功能

**AdvancedAnalyticsConfig** 提供使用统计：

```solidity
// 记录服务使用
config.recordServiceUsage(ServiceLevel.Premium, 1000e18);

// 获取服务统计
(uint256 usageCount, uint256 revenue) = config.getServiceStats(ServiceLevel.Premium);

// 获取所有服务统计
(uint256[4] memory usageCounts, uint256[4] memory revenues) = config.getAllServiceStats();
```

---

## 🔍 查询功能

### 基础查询

```solidity
// 获取配置
ServiceConfig memory config = config.getConfig(ServiceLevel.Premium);

// 获取价格
uint256 price = config.getServicePrice(ServiceLevel.Premium);

// 获取时长
uint256 duration = config.getServiceDuration(ServiceLevel.Premium);

// 检查是否激活
bool isActive = config.isServiceActive(ServiceLevel.Premium);
```

### 高级查询（TestnetFeaturesConfig）

```solidity
// 获取配置版本
uint256 version = config.getConfigVersion();

// 获取最后更新时间
uint256 lastUpdate = config.getLastConfigUpdateTime();

// 获取最后更新者
address updater = config.getLastConfigUpdater();

// 获取配置摘要
(uint256 v, uint256 t, address u, uint256 c) = config.getConfigSummary();
```

---

## 🛠️ 开发指南

### 创建新的配置合约

1. **继承 BaseServiceConfig**

```solidity
contract MyServiceConfig is BaseServiceConfig {
    // 实现必要的方法
}
```

2. **实现抽象方法**

```solidity
function _initializeConfigs() internal override {
    // 初始化各等级配置
}

function _initializeCooldown() internal override {
    // 设置冷却期
}

function getServiceType() external pure override returns (ServiceType) {
    return ServiceType.MyService;
}
```

3. **添加自定义功能**（可选）

```solidity
// 添加特定于服务的功能
function customFunction() external {
    _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
    // 实现逻辑
}
```

### 最佳实践

1. **权限验证**：所有修改操作都应验证权限
2. **事件记录**：所有重要操作都应发出事件
3. **参数验证**：验证输入参数的有效性
4. **标准化事件**：使用 `ActionExecuted` 记录标准化动作
5. **冷却期**：合理设置冷却期防止频繁变更

---

## 📝 部署说明

### 部署步骤

1. **部署实现合约**
2. **通过 UUPS Proxy 部署**
3. **初始化合约**
4. **注册到 Registry**

### 部署脚本示例

```typescript
// 部署 FeatureUnlockConfig
const config = await deployProxy('FeatureUnlockConfig', [registryAddress]);

// 注册到 Registry
await registry.setModule(
    keyOf('FEATURE_UNLOCK_CONFIG'),
    configAddress
);
```

---

## 🔗 相关文档

- [BaseServiceConfig 文档](../src/Reward/BaseServiceConfig.sol)
- [Registry 系统文档](../docs/registry-deployment.md)
- [权限系统文档](../Usage-Guide/permission-management-guide.md)
- [奖励系统文档](../docs/Reward/)

---

## 📞 支持

如有问题，请参考：
- [架构指南](../docs/Architecture-Guide.md)
- [智能合约标准](../docs/SmartContractStandard.md)

---

## 📄 许可证

MIT License


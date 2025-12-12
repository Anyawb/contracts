# Graceful Degradation Deployment Strategy
# 优雅降级部署策略

## 🚨 重要发现：部署顺序依赖关系

通过代码分析发现，优雅降级监控系统存在**关键的部署顺序依赖**：

### 📊 依赖关系图

```
Registry (基础设施)
    ↓
GracefulDegradationMonitor (监控中心) 
    ↓ 
HealthView (需要监控合约地址)
    ↓
其他 View 合约
    ↓
业务合约监控集成
```

### ⚠️ 关键发现

#### 1. **HealthView 的强依赖**
```solidity
// contracts/Vault/view/modules/HealthView.sol
function initialize(
    address initialRegistryAddr,
    address initialGracefulDegradationMonitor  // ⚠️ 硬依赖
) external initializer {
    gracefulDegradationMonitor = GracefulDegradationMonitor(initialGracefulDegradationMonitor);
}
```

#### 2. **其他 View 合约的潜在依赖**
- **SystemView**: 可能需要监控数据查询
- **BatchView**: 可能需要批量监控统计
- **ValuationOracleView**: 直接涉及预言机监控

#### 3. **业务合约的软依赖**
- 业务合约**可以**独立部署
- 但监控功能需要监控中心**已经部署**才能完整工作

## 🎯 修正后的实施策略

### 策略A：分阶段部署（推荐）

#### 🏗️ **阶段1：基础设施先行**
```bash
# 1. 部署基础设施
Deploy Registry
Deploy GracefulDegradationMonitor
Deploy AccessControlManager
Deploy PriceOracle

# 2. 验证基础功能
Test Registry integration
Test Monitor initialization
Test basic monitoring events
```

#### 🔧 **阶段2：业务合约升级**
```bash
# 1. 升级现有业务合约
Upgrade CollateralManager (add monitoring)
Upgrade LendingEngine (add monitoring)  
Upgrade HealthFactorCalculator (add monitoring)

# 2. 部署新业务合约
Deploy LiquidationCoreOperations (with monitoring)
Deploy LiquidationDebtManager (with monitoring)
```

#### 👁️ **阶段3：View合约部署**
```bash
# 1. 部署 View 合约（传入监控地址）
Deploy HealthView(registry, gracefulMonitor)
Deploy SystemView(registry, gracefulMonitor)
Deploy BatchView(registry, gracefulMonitor)

# 2. 配置监控查询接口
Configure monitoring dashboards
Setup alert systems
```

### 策略B：全新部署（新项目）

#### 📋 **标准部署顺序**
```typescript
// 部署脚本示例
async function deployWithMonitoring() {
    // 1. 基础设施
    const registry = await deployRegistry();
    const monitor = await deployGracefulDegradationMonitor(registry.address);
    
    // 2. 核心合约（集成监控）
    const priceOracle = await deployPriceOracle(registry.address, monitor.address);
    const collateralMgr = await deployCollateralManager(registry.address, monitor.address);
    
    // 3. View 合约（传入监控地址）
    const healthView = await deployHealthView(registry.address, monitor.address);
    const systemView = await deploySystemView(registry.address, monitor.address);
    
    // 4. 监控配置
    await configureMonitoring(monitor, [priceOracle, collateralMgr]);
    
    return { registry, monitor, healthView, systemView };
}
```

## 🔧 具体实施调整

### 调整1：当前项目的渐进升级

由于您的项目**已经有部分合约部署**，我们采用**渐进升级策略**：

#### 第一步：检查监控合约状态
```bash
# 检查 GracefulDegradationMonitor 是否已部署
npx hardhat verify --network [network] [monitor_address]

# 检查 HealthView 等 View 合约的部署状态
ls deployments/[network]/ | grep -i "view\|monitor"
```

#### 第二步：确保监控基础设施就绪
```solidity
// 如果 GracefulDegradationMonitor 未部署，先部署
const monitor = await deployGracefulDegradationMonitor(registryAddress);

// 注册到 Registry 中
await registry.setModule(ModuleKeys.KEY_GRACEFUL_DEGRADATION_MONITOR, monitor.address, true);
```

#### 第三步：业务合约监控集成
```solidity
// 方案A：升级现有合约（如果支持）
await upgradeWithMonitoring(existingContract, monitorAddress);

// 方案B：部署新版本替换
const newContract = await deployWithMonitoring(registryAddress, monitorAddress);
await registry.setModule(moduleKey, newContract.address, true);
```

### 调整2：集成实施的新流程

#### 🎯 **修订后的优先级**

**立即优先级1：监控基础设施**
- ✅ 确保 `GracefulDegradationMonitor` 已部署
- ✅ 确保在 Registry 中正确注册
- ✅ 测试基础监控功能

**立即优先级2：核心业务合约集成**
- 🔧 `LiquidationCoreOperations.sol` + 监控集成
- 🔧 `LiquidationDebtManager.sol` + 监控集成
- 🔧 确保能正确发送监控事件到监控中心

**延后优先级：View合约完善**
- 📊 `HealthView` 监控查询完善
- 📊 `SystemView` 监控数据展示
- 📊 前端监控界面集成

### 调整3：代码模板更新

#### 业务合约监控集成模板
```solidity
contract BusinessContract {
    // 监控合约地址（从 Registry 获取）
    function _getMonitorAddress() internal view returns (address) {
        return Registry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_GRACEFUL_DEGRADATION_MONITOR);
    }
    
    // 发送监控事件到监控中心
    function _reportMonitoringEvent(
        string memory operation,
        bool usedFallback,
        string memory reason
    ) internal {
        address monitorAddr = _getMonitorAddress();
        if (monitorAddr != address(0)) {
            // 调用监控合约的记录函数
            IGracefulDegradationMonitor(monitorAddr).recordDegradationEvent(
                address(this),
                operation,
                usedFallback,
                reason,
                block.timestamp
            );
        }
    }
}
```

## 📋 立即行动计划

### 1. **现状确认** (30分钟)
- 检查当前部署的合约状态
- 确认 `GracefulDegradationMonitor` 是否已部署
- 检查 Registry 中的模块注册情况

### 2. **监控基础设施就绪** (1-2小时)
- 如需要，部署/升级 `GracefulDegradationMonitor`
- 确保在 Registry 中正确注册
- 测试基础监控功能

### 3. **业务合约集成** (按原计划)
- 从高风险模块开始集成
- 确保每个模块都能正确与监控中心通信
- 逐步验证监控功能

### 4. **View合约和前端** (最后阶段)
- 完善 View 合约的监控查询功能
- 集成前端监控界面
- 端到端测试

## 🎉 总结

您的观察非常准确！**部署顺序确实是关键**。我们需要：

1. ✅ **先确保监控基础设施就绪**
2. ✅ **再进行业务合约的监控集成**  
3. ✅ **最后完善 View 层的监控查询**

这样可以避免依赖关系问题，确保每一步都有坚实的基础支撑。

---

**文档版本**: v1.0  
**更新时间**: 2025年8月  
**重要性**: 🔴 高优先级 - 影响整个实施策略

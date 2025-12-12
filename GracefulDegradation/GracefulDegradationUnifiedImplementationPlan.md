# Graceful Degradation Unified Implementation Plan
# 优雅降级统一实施计划

## 📋 计划概述

基于最新的 `GracefulDegradation.sol` 库文件，对所有使用预言机的模块进行**优雅降级重构+监控集成**的统一实施。

**实施原则**：
- 🎯 **一次性集成** - 同时完成降级和监控功能
- 📊 **标准化接口** - 使用最新库文件的标准接口
- 🔔 **完整监控** - 集成事件记录和健康检查
- ✅ **渐进实施** - 按风险级别分阶段进行

## 🏗️ 技术架构更新

### 当前库文件核心接口

```solidity
// 主要降级函数
function getAssetValueWithFallback(
    address priceOracleAddr,
    address assetAddr,
    uint256 amountValue,
    DegradationConfig memory config
) internal view returns (PriceResult memory result)

// 带缓存的降级函数
function getAssetValueWithFallbackAndCache(
    address priceOracleAddr,
    address assetAddr,
    uint256 amountValue,
    DegradationConfig memory config,
    CacheStorage storage cacheStorage
) internal returns (PriceResult memory result)

// 健康检查函数
function checkPriceOracleHealth(
    address priceOracleAddr,
    address assetAddr
) internal view returns (bool isHealthy, string memory details)

// 配置创建函数
function createDefaultConfig(address settlementToken) internal pure returns (DegradationConfig memory)
```

### 标准化事件接口

```solidity
interface IGracefulDegradationEvents {
    event GracefulDegradationTriggered(
        address indexed module,
        address indexed asset,
        string indexed operation,
        string reason,
        uint256 fallbackValue,
        uint256 originalValue,
        uint8 severity,
        uint256 timestamp
    );
    
    event OracleHealthStatusChanged(
        address indexed oracle,
        address indexed asset,
        bool isHealthy,
        uint8 healthScore,
        uint256 consecutiveFailures,
        string details,
        uint256 timestamp
    );
    
    event ModuleMonitoringStatsUpdated(
        address indexed module,
        uint256 totalDegradations,
        uint256 successfulOperations,
        uint8 moduleHealthScore,
        uint256 timestamp
    );
}
```

## 🎯 分阶段实施计划

### 第一阶段：高风险核心模块 (1-2周)

#### 优先级1：核心清算操作
**文件**: `contracts/Vault/liquidation/libraries/LiquidationCoreOperations.sol`
- 🔴 **风险级别**: 极高 - 影响所有清算操作
- 🎯 **当前状态**: 未实施优雅降级
- 🔧 **实施内容**:
  - 集成最新GracefulDegradation库
  - 添加价格获取降级保护
  - 集成监控事件和健康检查
  - 完整的测试覆盖

#### 优先级2：债务管理模块
**文件**: `contracts/Vault/liquidation/modules/LiquidationDebtManager.sol`
- 🔴 **风险级别**: 高 - 直接影响清算决策
- 🎯 **当前状态**: 未实施优雅降级
- 🔧 **实施内容**:
  - 债务价值计算降级保护
  - 批量债务查询优化
  - 监控事件集成

#### 优先级3：视图查询模块
**文件**: `contracts/Vault/view/modules/ValuationOracleView.sol`
- 🔴 **风险级别**: 高 - 影响前端价格显示
- 🎯 **当前状态**: 未实施优雅降级
- 🔧 **实施内容**:
  - 价格查询降级机制
  - 批量查询优化
  - 实时监控集成

### 第二阶段：业务逻辑完善 (2-3周)

#### 已部分实施模块的完善
1. **LiquidationCollateralManager.sol** - 完善监控集成
2. **SystemView.sol** - 添加批量查询降级
3. **BatchView.sol** - 完善事件记录
4. **HealthView.sol** - 标准化健康检查

#### 中风险模块集成
1. **UserView.sol** - 用户数据查询保护
2. **LiquidationRewardManager.sol** - 奖励计算降级
3. **TokenUtils.sol** - 工具函数保护

### 第三阶段：系统优化和监控完善 (1-2周)

#### 低风险模块完善
1. **统计和记录模块**
2. **接口标准化**
3. **Mock文件完善**

#### 监控系统升级
1. **GracefulDegradationMonitor** 功能增强
2. **前端监控界面**
3. **告警系统完善**

## 🛠️ 标准实施模板

### 模块集成标准流程

#### Step 1: 文件准备
```solidity
// 1. 导入最新库文件
import { GracefulDegradation } from "../../libraries/GracefulDegradation.sol";

// 2. 实现监控事件接口
contract YourModule is IGracefulDegradationEvents {
    
    // 3. 添加监控配置
    struct ModuleMonitoringConfig {
        bool enableMonitoring;
        uint8 defaultSeverity;
        uint256 healthCheckInterval;
    }
    
    ModuleMonitoringConfig public monitoringConfig;
```

#### Step 2: 函数重构模板
```solidity
// 原始函数
function getAssetPrice(address asset) external view returns (uint256 price, uint256 timestamp) {
    // 旧的直接调用，无降级保护
    (price, timestamp,) = IPriceOracle(priceOracleAddr).getPrice(asset);
    return (price, timestamp);
}

// 重构后的函数
function getAssetPrice(address asset) external view returns (uint256 price, uint256 timestamp) {
    if (asset == address(0)) revert ZeroAddress();
    
    // 创建降级配置
    GracefulDegradation.DegradationConfig memory config = 
        GracefulDegradation.createDefaultConfig(settlementTokenAddr);
    
    // 使用优雅降级获取价格
    GracefulDegradation.PriceResult memory result = 
        GracefulDegradation.getAssetValueWithFallback(
            priceOracleAddr,
            asset,
            1e18, // 标准化数量
            config
        );
    
    // 记录监控事件（仅在非view函数中）
    _recordMonitoringEvent(asset, "getAssetPrice", result);
    
    return (result.value, block.timestamp);
}

// 监控事件记录函数
function _recordMonitoringEvent(
    address asset,
    string memory operation,
    GracefulDegradation.PriceResult memory result
) internal {
    if (!monitoringConfig.enableMonitoring) return;
    
    if (result.usedFallback) {
        emit GracefulDegradationTriggered(
            address(this),                  // module
            asset,                          // asset
            operation,                      // operation
            result.reason,                  // reason
            result.value,                   // fallbackValue
            0,                             // originalValue (unknown)
            monitoringConfig.defaultSeverity, // severity
            block.timestamp                // timestamp
        );
    }
    
    // 更新模块统计
    _updateModuleStats(result.usedFallback);
}
```

#### Step 3: 健康检查集成
```solidity
function checkModuleHealth() external view returns (bool isHealthy, string memory details, uint8 score) {
    // 检查基础配置
    if (priceOracleAddr == address(0)) {
        return (false, "Price oracle not configured", 0);
    }
    
    // 检查预言机健康状态
    (bool oracleHealthy, string memory oracleDetails) = 
        GracefulDegradation.checkPriceOracleHealth(priceOracleAddr, settlementTokenAddr);
    
    if (!oracleHealthy) {
        return (false, string(abi.encodePacked("Oracle unhealthy: ", oracleDetails)), 20);
    }
    
    // 计算综合健康评分
    uint8 healthScore = _calculateHealthScore();
    
    return (healthScore > 70, "Module health check completed", healthScore);
}
```

#### Step 4: 批量操作优化
```solidity
function batchGetAssetPrices(address[] calldata assets) 
    external 
    view 
    returns (uint256[] memory prices, uint256[] memory timestamps) 
{
    uint256 length = assets.length;
    if (length == 0) revert EmptyArray();
    
    prices = new uint256[](length);
    timestamps = new uint256[](length);
    
    // 统计降级情况
    uint256 fallbackCount = 0;
    GracefulDegradation.DegradationConfig memory config = 
        GracefulDegradation.createDefaultConfig(settlementTokenAddr);
    
    for (uint256 i = 0; i < length;) {
        GracefulDegradation.PriceResult memory result = 
            GracefulDegradation.getAssetValueWithFallback(
                priceOracleAddr,
                assets[i],
                1e18,
                config
            );
        
        prices[i] = result.value;
        timestamps[i] = block.timestamp;
        
        if (result.usedFallback) {
            fallbackCount++;
        }
        
        unchecked { ++i; }
    }
    
    // 记录批量操作统计
    if (fallbackCount > 0) {
        emit BatchOperationDegradationTriggered(
            "batchGetAssetPrices",
            length,
            fallbackCount,
            fallbackCount,
            "Batch price query with fallback"
        );
    }
    
    return (prices, timestamps);
}
```

## 📊 测试验证标准

### 单元测试模板
```typescript
describe("Module Graceful Degradation + Monitoring", function () {
    describe("Normal Operations", function () {
        it("Should execute normally and emit health events", async function () {
            // 测试正常情况
            const tx = await module.getAssetPrice(USDC);
            
            // 验证没有降级事件
            await expect(tx).to.not.emit(module, "GracefulDegradationTriggered");
            
            // 验证模块统计更新
            await expect(tx).to.emit(module, "ModuleMonitoringStatsUpdated");
        });
    });
    
    describe("Degradation Scenarios", function () {
        it("Should use fallback and emit monitoring events", async function () {
            // 模拟预言机故障
            await mockOracle.setFailure(true);
            
            const tx = await module.getAssetPrice(USDC);
            
            // 验证降级事件
            await expect(tx)
                .to.emit(module, "GracefulDegradationTriggered")
                .withArgs(
                    module.target,
                    USDC,
                    "getAssetPrice",
                    "Price oracle call failed",
                    anyValue,
                    0,
                    2, // severity
                    anyValue
                );
        });
    });
    
    describe("Health Monitoring", function () {
        it("Should correctly report module health", async function () {
            const [isHealthy, details, score] = await module.checkModuleHealth();
            expect(isHealthy).to.be.true;
            expect(score).to.be.gte(80);
        });
    });
});
```

## 🚀 实施时间安排

### 第一周：核心清算模块
- **Day 1-2**: LiquidationCoreOperations.sol
- **Day 3-4**: LiquidationDebtManager.sol  
- **Day 5-7**: ValuationOracleView.sol + 测试

### 第二周：业务逻辑模块
- **Day 1-3**: 完善部分实施的模块
- **Day 4-5**: 中风险模块集成
- **Day 6-7**: 集成测试和优化

### 第三周：系统完善
- **Day 1-3**: 低风险模块完善
- **Day 4-5**: 监控系统升级
- **Day 6-7**: 全面测试和文档

## 🎯 质量控制标准

### 代码质量要求
- ✅ 单元测试覆盖率 > 95%
- ✅ 集成测试覆盖率 > 90%
- ✅ 静态分析无严重问题
- ✅ Gas优化 < 15%增长

### 监控标准要求
- ✅ 所有预言机调用都有降级保护
- ✅ 关键操作都有监控事件
- ✅ 健康检查功能完整
- ✅ 统计数据准确可靠

### 文档更新要求
- ✅ 代码注释完整
- ✅ API文档更新
- ✅ 集成指南更新
- ✅ 运维手册完善

## 📞 协作和支持

### 实施团队分工
- **核心开发**: 负责高风险模块集成
- **测试工程师**: 负责测试用例编写和验证
- **DevOps**: 负责监控系统部署和配置
- **产品经理**: 负责需求确认和验收

### 沟通机制
- **每日站会**: 同步进度和问题
- **代码审查**: 每个模块完成后进行
- **集成测试**: 每周进行一次全面测试
- **里程碑评审**: 每阶段结束后评审

---

**文档版本**: v1.0  
**制定时间**: 2025年8月  
**实施团队**: RWA Lending Platform 开发团队  
**预计完成**: 2025年8月底

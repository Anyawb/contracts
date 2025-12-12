# Graceful Degradation Implementation Guide
# 优雅降级监控集成实施指南

## 📋 指南概述

本文档提供了 RWA Lending Platform 优雅降级监控集成的详细操作步骤、代码模板和测试用例，确保每个开发人员都能按照统一标准进行集成工作。

**使用说明**：
- 🎯 严格按照步骤顺序执行
- 📝 每完成一个步骤都要进行测试验证
- 🔍 遇到问题及时查阅故障排除章节
- ✅ 所有修改都要经过代码审查

## 🏗️ 总体实施计划

### 实施阶段划分

```
第一阶段（第1-2周）：高风险模块集成
├── LiquidationCoreOperations.sol
├── ValuationOracleView.sol
├── VaultView.sol
└── LiquidationDebtManager.sol

第二阶段（第3-4周）：中风险模块集成
├── UserView.sol
├── LiquidationRewardManager.sol
├── LiquidationRewardDistributor.sol
└── TokenUtils.sol

第三阶段（第5-6周）：完善和优化
├── 剩余低风险模块
├── 监控系统优化
├── 前端集成完善
└── 文档和培训
```

### 每个模块集成标准时间
- 🔴 **高风险模块**：2-3天/个
- 🟡 **中风险模块**：1-2天/个
- 🟢 **低风险模块**：0.5-1天/个

## 🛠️ 标准集成流程

### Step 1: 前期准备检查

#### 1.1 环境检查清单
```bash
# 检查项目结构
ls -la contracts/libraries/GracefulDegradation.sol
ls -la contracts/Vault/view/modules/GracefulDegradationMonitor.sol

# 检查依赖
grep -r "GracefulDegradation" contracts/ | wc -l

# 检查测试环境
npm test -- --grep "GracefulDegradation"
```

#### 1.2 分支和版本管理
```bash
# 创建功能分支
git checkout -b feature/graceful-degradation-monitoring-integration

# 确保基于最新主分支
git pull origin main
git rebase main
```

### Step 2: 模块分析和设计

#### 2.1 模块分析模板
对于每个要集成的模块，使用以下模板进行分析：

```markdown
## 模块分析：[模块名称]

### 基本信息
- **文件路径**: contracts/xxx/xxx.sol
- **风险级别**: 🔴高 / 🟡中 / 🟢低
- **模块类型**: 核心/视图/工具/清算
- **预言机使用**: 直接调用/间接调用/不使用

### 预言机使用分析
- **调用位置**: [列出所有调用预言机的函数]
- **调用频率**: 高/中/低
- **影响范围**: [描述故障影响]
- **当前错误处理**: [描述现有错误处理机制]

### 集成方案
- **导入库**: ✅已导入 / ❌需要导入
- **事件定义**: ✅已定义 / ❌需要定义
- **函数修改**: [列出需要修改的函数]
- **测试覆盖**: [描述测试计划]

### 风险评估
- **实施风险**: 高/中/低
- **业务影响**: 高/中/低
- **回滚方案**: [描述回滚计划]
```

#### 2.2 集成优先级评估矩阵

| 模块 | 风险级别 | 实施难度 | 业务影响 | 优先级得分 | 排序 |
|------|----------|----------|----------|------------|------|
| LiquidationCoreOperations | 🔴 高 | 中 | 高 | 9 | 1 |
| ValuationOracleView | 🔴 高 | 低 | 高 | 8 | 2 |
| VaultView | 🔴 高 | 中 | 中 | 7 | 3 |
| ... | ... | ... | ... | ... | ... |

### Step 3: 代码集成标准模板

#### 3.1 导入优雅降级库
```solidity
// 在文件顶部导入
import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";

// 如果需要使用事件，也导入接口
import { IGracefulDegradationEvents } from "../../../interfaces/IGracefulDegradationEvents.sol";
```

#### 3.2 事件定义标准模板
```solidity
// 在合约中添加标准事件
contract YourContract is IGracefulDegradationEvents {
    
    /* ============ Graceful Degradation Events ============ */
    
    /// @notice 模块特定的优雅降级事件
    /// @param asset 相关资产
    /// @param operation 操作类型
    /// @param fallbackValue 降级值
    /// @param reason 降级原因
    event ModuleGracefulDegradation(
        address indexed asset,
        string indexed operation,
        uint256 fallbackValue,
        string reason
    );
    
    /// @notice 模块健康状态事件
    /// @param isHealthy 是否健康
    /// @param details 详细信息
    event ModuleHealthCheck(
        bool isHealthy,
        string details
    );
    
    // 继承标准事件（自动获得）
    // - GracefulDegradationTriggered
    // - OracleHealthStatusChanged
    // - SystemDegradationStatsUpdated
}
```

#### 3.3 配置结构标准模板
```solidity
// 模块级别的监控配置
struct ModuleMonitoringConfig {
    bool enableMonitoring;           // 是否启用监控
    uint8 defaultSeverity;          // 默认严重级别
    uint256 healthCheckInterval;    // 健康检查间隔
    uint256 maxRetryCount;          // 最大重试次数
    bool enableAutoRecovery;        // 是否启用自动恢复
}

// 模块监控配置存储
ModuleMonitoringConfig public monitoringConfig;
```

#### 3.4 标准函数修改模板

##### 原始函数（修改前）
```solidity
function getAssetPrice(address asset) external view returns (uint256 price, uint256 timestamp) {
    if (asset == address(0)) revert ZeroAddress();
    
    // 直接调用预言机，无错误处理
    (price, timestamp,) = IPriceOracle(priceOracleAddr).getPrice(asset);
    
    if (price == 0) revert PriceOracle__InvalidPrice();
    
    return (price, timestamp);
}
```

##### 集成优雅降级后
```solidity
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
    if (!result.usedFallback) {
        // 价格获取成功
        emit ModuleHealthCheck(true, "Price retrieval successful");
    } else {
        // 使用了降级策略
        emit ModuleGracefulDegradation(
            asset,
            "getAssetPrice",
            result.value,
            result.reason
        );
        
        // 发出标准降级事件
        emit GracefulDegradationTriggered(
            address(this),      // module
            asset,              // asset
            "price_query",      // operation
            result.reason,      // reason
            result.value,       // fallbackValue
            0,                  // originalValue (未知)
            2,                  // severity (中级)
            block.timestamp     // timestamp
        );
    }
    
    return (result.value, block.timestamp);
}
```

#### 3.5 批量操作函数模板
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
    string[] memory reasons = new string[](length);
    
    // 创建降级配置
    GracefulDegradation.DegradationConfig memory config = 
        GracefulDegradation.createDefaultConfig(settlementTokenAddr);
    
    for (uint256 i = 0; i < length;) {
        if (assets[i] == address(0)) {
            prices[i] = 0;
            timestamps[i] = block.timestamp;
            reasons[i] = "Zero address";
            fallbackCount++;
        } else {
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
                reasons[i] = result.reason;
            }
        }
        
        unchecked { ++i; }
    }
    
    // 发出批量操作降级事件（如果有降级）
    if (fallbackCount > 0) {
        emit BatchOperationDegradationTriggered(
            "batchGetAssetPrices",
            length,
            fallbackCount,
            fallbackCount,
            "Multiple asset price queries with fallback"
        );
    }
    
    return (prices, timestamps);
}
```

#### 3.6 健康检查函数模板
```solidity
/// @notice 检查模块健康状态
/// @return isHealthy 是否健康
/// @return details 详细信息
/// @return score 健康评分 (0-100)
function checkModuleHealth() 
    external 
    view 
    returns (bool isHealthy, string memory details, uint8 score) 
{
    // 检查关键依赖
    if (priceOracleAddr == address(0)) {
        return (false, "Price oracle not configured", 0);
    }
    
    if (settlementTokenAddr == address(0)) {
        return (false, "Settlement token not configured", 10);
    }
    
    // 检查预言机健康状态
    try IPriceOracle(priceOracleAddr).getPrice(settlementTokenAddr) 
        returns (uint256 price, uint256 timestamp, uint256 decimals) {
        
        // 检查价格有效性
        if (price == 0) {
            return (false, "Price oracle returning zero price", 30);
        }
        
        // 检查价格时效性
        if (block.timestamp - timestamp > 3600) { // 1小时
            return (false, "Price oracle data stale", 50);
        }
        
        // 检查精度合理性
        if (decimals == 0 || decimals > 18) {
            return (false, "Price oracle invalid decimals", 40);
        }
        
        // 所有检查通过
        return (true, "All health checks passed", 100);
        
    } catch (bytes memory reason) {
        return (
            false, 
            string(abi.encodePacked("Price oracle call failed: ", reason)), 
            20
        );
    }
}
```

### Step 4: 测试用例标准模板

#### 4.1 单元测试模板
```typescript
// test/monitoring/YourContract.monitoring.test.ts

import { expect } from "chai";
import hardhat from "hardhat";
const { ethers } = hardhat;

import { YourContract, MockPriceOracle, GracefulDegradationMonitor } from "../../types";

describe("YourContract - Graceful Degradation Monitoring", function () {
    let yourContract: YourContract;
    let mockOracle: MockPriceOracle;
    let monitor: GracefulDegradationMonitor;
    let owner: any, user: any;

    const USDC = "0xA0b86a33E6441C15c4A2a3E0c8C95Fc2E0eA8ff5"; // 示例地址
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    const ONE_ETH = ethers.parseUnits("1", 18);

    beforeEach(async function () {
        [owner, user] = await ethers.getSigners();

        // 部署Mock预言机
        const MockPriceOracleFactory = await ethers.getContractFactory("MockPriceOracle");
        mockOracle = await MockPriceOracleFactory.deploy();

        // 部署监控合约
        const MonitorFactory = await ethers.getContractFactory("GracefulDegradationMonitor");
        monitor = await MonitorFactory.deploy();

        // 部署测试合约
        const YourContractFactory = await ethers.getContractFactory("YourContract");
        yourContract = await YourContractFactory.deploy();

        // 初始化
        await yourContract.initialize(mockOracle.target, USDC);
        await monitor.initialize(owner.address);
    });

    describe("正常情况下的价格获取", function () {
        it("应该成功获取价格并发出健康检查事件", async function () {
            // 设置正常价格
            await mockOracle.setPrice(USDC, ethers.parseUnits("1", 8), 8);

            // 执行价格获取
            const tx = await yourContract.getAssetPrice(USDC);
            const receipt = await tx.wait();

            // 验证返回值
            const [price, timestamp] = await yourContract.getAssetPrice(USDC);
            expect(price).to.be.gt(0);
            expect(timestamp).to.be.gt(0);

            // 验证健康检查事件
            await expect(tx)
                .to.emit(yourContract, "ModuleHealthCheck")
                .withArgs(true, "Price retrieval successful");
        });
    });

    describe("预言机故障时的优雅降级", function () {
        it("应该在预言机故障时使用降级策略", async function () {
            // 模拟预言机故障
            await mockOracle.setFailure(true);

            // 执行价格获取
            const tx = await yourContract.getAssetPrice(USDC);

            // 验证降级事件
            await expect(tx)
                .to.emit(yourContract, "ModuleGracefulDegradation")
                .withArgs(USDC, "getAssetPrice", anyValue, "Price oracle call failed");

            await expect(tx)
                .to.emit(yourContract, "GracefulDegradationTriggered")
                .withArgs(
                    yourContract.target,
                    USDC,
                    "price_query",
                    "Price oracle call failed",
                    anyValue,
                    0,
                    2, // 中级严重度
                    anyValue
                );
        });

        it("应该在零价格时使用降级策略", async function () {
            // 设置零价格
            await mockOracle.setPrice(USDC, 0, 8);

            const tx = await yourContract.getAssetPrice(USDC);

            await expect(tx)
                .to.emit(yourContract, "ModuleGracefulDegradation")
                .withArgs(USDC, "getAssetPrice", anyValue, "Zero price");
        });
    });

    describe("批量操作的优雅降级", function () {
        it("应该处理部分资产故障的情况", async function () {
            const assets = [USDC, ZERO_ADDRESS];
            
            // 设置一个正常价格，一个故障
            await mockOracle.setPrice(USDC, ethers.parseUnits("1", 8), 8);

            const tx = await yourContract.batchGetAssetPrices(assets);

            // 验证批量降级事件
            await expect(tx)
                .to.emit(yourContract, "BatchOperationDegradationTriggered")
                .withArgs(
                    "batchGetAssetPrices",
                    2, // 总数
                    1, // 失败数
                    1, // 降级数
                    "Multiple asset price queries with fallback"
                );
        });
    });

    describe("健康检查功能", function () {
        it("应该正确报告健康状态", async function () {
            await mockOracle.setPrice(USDC, ethers.parseUnits("1", 8), 8);

            const [isHealthy, details, score] = await yourContract.checkModuleHealth();

            expect(isHealthy).to.be.true;
            expect(details).to.equal("All health checks passed");
            expect(score).to.equal(100);
        });

        it("应该检测预言机故障", async function () {
            await mockOracle.setFailure(true);

            const [isHealthy, details, score] = await yourContract.checkModuleHealth();

            expect(isHealthy).to.be.false;
            expect(details).to.include("Price oracle call failed");
            expect(score).to.equal(20);
        });
    });

    describe("监控配置管理", function () {
        it("应该允许更新监控配置", async function () {
            const newConfig = {
                enableMonitoring: true,
                defaultSeverity: 3,
                healthCheckInterval: 300,
                maxRetryCount: 5,
                enableAutoRecovery: true
            };

            await yourContract.updateMonitoringConfig(newConfig);

            const config = await yourContract.monitoringConfig();
            expect(config.defaultSeverity).to.equal(3);
            expect(config.maxRetryCount).to.equal(5);
        });
    });
});
```

#### 4.2 集成测试模板
```typescript
// test/integration/MonitoringIntegration.test.ts

describe("监控系统集成测试", function () {
    // 测试多个模块的协同工作
    describe("跨模块监控协调", function () {
        it("应该在多个模块都出现问题时正确聚合事件", async function () {
            // 同时触发多个模块的降级
            // 验证监控系统的事件聚合功能
        });
    });

    describe("系统级健康监控", function () {
        it("应该正确计算系统整体健康评分", async function () {
            // 测试系统健康评分计算
        });
    });

    describe("告警系统集成", function () {
        it("应该在达到告警阈值时触发告警", async function () {
            // 测试告警系统
        });
    });
});
```

#### 4.3 性能测试模板
```typescript
// test/performance/MonitoringPerformance.test.ts

describe("监控系统性能测试", function () {
    describe("高并发事件处理", function () {
        it("应该能处理大量并发的降级事件", async function () {
            const startTime = Date.now();
            
            // 并发发送1000个事件
            const promises = Array(1000).fill(0).map(() => 
                yourContract.getAssetPrice(USDC)
            );
            
            await Promise.all(promises);
            
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            // 验证性能要求（例如：1000个事件在10秒内处理完成）
            expect(duration).to.be.lt(10000);
        });
    });

    describe("内存使用优化", function () {
        it("长期运行不应导致内存泄漏", async function () {
            // 测试长期运行的内存使用情况
        });
    });
});
```

### Step 5: 部署和验证流程

#### 5.1 本地测试流程
```bash
# 1. 运行单元测试
npm test -- --grep "YourContract.*Graceful Degradation"

# 2. 运行集成测试
npm test -- test/integration/MonitoringIntegration.test.ts

# 3. 运行性能测试
npm test -- test/performance/MonitoringPerformance.test.ts

# 4. 检查代码覆盖率
npm run test:coverage

# 5. 静态代码分析
npm run lint
npm run slither
```

#### 5.2 测试网部署流程
```bash
# 1. 部署到测试网
npm run deploy:testnet

# 2. 验证合约
npm run verify:testnet

# 3. 运行端到端测试
npm run test:e2e:testnet

# 4. 监控系统验证
npm run monitor:testnet
```

#### 5.3 生产环境部署检查清单
```markdown
## 生产部署前检查清单

### 代码质量
- [ ] 所有单元测试通过
- [ ] 集成测试通过
- [ ] 代码覆盖率 > 95%
- [ ] 静态分析无高危问题
- [ ] 代码审查完成

### 功能验证
- [ ] 正常情况功能验证
- [ ] 异常情况处理验证
- [ ] 性能要求验证
- [ ] 监控事件验证
- [ ] 告警机制验证

### 安全检查
- [ ] 权限控制验证
- [ ] 输入验证完整性
- [ ] 重入攻击防护
- [ ] 溢出检查完整性
- [ ] 第三方安全审计

### 运维准备
- [ ] 监控仪表板配置
- [ ] 告警规则配置
- [ ] 应急响应预案
- [ ] 回滚方案准备
- [ ] 文档更新完成
```

## 🔧 故障排除指南

### 常见问题和解决方案

#### 问题1：编译错误 - GracefulDegradation库导入失败
```bash
Error: Cannot find module '../../../libraries/GracefulDegradation.sol'
```

**解决方案**：
```solidity
// 检查相对路径是否正确
// 从当前文件位置到GracefulDegradation.sol的路径

// 正确的导入路径示例：
// 从 contracts/Vault/modules/ 到 contracts/libraries/
import { GracefulDegradation } from "../../libraries/GracefulDegradation.sol";

// 从 contracts/Vault/liquidation/modules/ 到 contracts/libraries/
import { GracefulDegradation } from "../../../libraries/GracefulDegradation.sol";
```

#### 问题2：事件定义冲突
```bash
Error: Identifier already declared
```

**解决方案**：
```solidity
// 检查是否重复定义了相同的事件
// 使用继承方式避免重复定义

contract YourContract is IGracefulDegradationEvents {
    // 不要重复定义已在接口中定义的事件
    // event GracefulDegradationTriggered(...); // ❌ 错误：重复定义
    
    // 只定义模块特定的事件
    event ModuleSpecificEvent(...); // ✅ 正确
}
```

#### 问题3：测试用例失败 - 事件验证问题
```bash
AssertionError: Expected event "GracefulDegradationTriggered" was not emitted
```

**解决方案**：
```typescript
// 检查事件参数是否匹配
await expect(tx)
    .to.emit(contract, "GracefulDegradationTriggered")
    .withArgs(
        contract.target,    // 确保使用正确的地址
        asset,              // 确保参数类型正确
        "price_query",      // 确保字符串完全匹配
        anyValue,           // 对于动态值使用 anyValue
        anyValue,
        0,
        2,
        anyValue
    );
```

#### 问题4：性能问题 - Gas消耗过高
```bash
Warning: Transaction gas usage is too high
```

**解决方案**：
```solidity
// 优化事件发出逻辑
if (monitoringConfig.enableMonitoring) {
    // 只在启用监控时发出事件
    emit GracefulDegradationTriggered(...);
}

// 批量操作优化
// 避免在循环中发出过多事件
// 使用汇总事件替代单独事件
```

## 📊 验收标准

### 功能完整性验收
- ✅ 所有预言机调用都集成了优雅降级
- ✅ 所有降级事件都正确发出
- ✅ 健康检查功能正常工作
- ✅ 监控配置可以正常管理

### 性能要求验收
- ✅ 单次价格查询增加的Gas < 10,000
- ✅ 批量操作性能退化 < 20%
- ✅ 事件处理延迟 < 100ms
- ✅ 内存使用增长 < 15%

### 质量标准验收
- ✅ 代码覆盖率 > 95%
- ✅ 所有测试用例通过
- ✅ 静态分析无严重问题
- ✅ 代码审查完成

### 监控标准验收
- ✅ 监控事件格式标准化
- ✅ 告警机制正常工作
- ✅ 统计数据准确性验证
- ✅ 前端监控界面集成

## 📞 支持和联系

### 技术支持
- 📧 **邮件**：dev@rwa-lending.com
- 💬 **Slack**：#graceful-degradation-monitoring
- 📚 **文档**：docs/monitoring/
- 🔧 **工具**：scripts/monitoring/

### 紧急联系
- 🚨 **紧急热线**：+86-xxx-xxxx-xxxx
- 📱 **值班手机**：+86-xxx-xxxx-xxxx
- 📧 **紧急邮箱**：emergency@rwa-lending.com

---

**文档版本**: v1.0  
**作者**: RWA Lending Platform 开发团队  
**最后更新**: 2024年12月  
**下次复查**: 2025年1月

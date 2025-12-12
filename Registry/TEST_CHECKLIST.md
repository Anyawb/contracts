# Registry 系统测试清单

## 概述

本文档提供 Registry 系统的完整测试清单，确保所有功能正确实现。

## 测试分类

### 1. 单元测试 (Unit Tests)
### 2. 集成测试 (Integration Tests)
### 3. Gas 测试 (Gas Tests)
### 4. 安全测试 (Security Tests)
### 5. 边界测试 (Edge Case Tests)

## 详细测试清单

### 1. 初始化测试

#### 1.1 基础初始化
- [ ] `initialize()` 成功设置 admin 地址
- [ ] `initialize()` 成功设置 minDelay
- [ ] `initialize()` 触发 `RegistryInitialized` 事件
- [ ] 重复调用 `initialize()` 导致 revert
- [ ] 零地址 admin 参数导致 revert
- [ ] 超过 MAX_DELAY 的 minDelay 导致 revert

#### 1.2 初始化事件验证
- [ ] `RegistryInitialized` 事件参数正确
- [ ] 事件中的 admin 地址与设置一致
- [ ] 事件中的 minDelay 与设置一致
- [ ] 事件中的 initializer 为 msg.sender
- [ ] 事件中的 timestamp 为 block.timestamp

### 2. 权限测试

#### 2.1 Admin 权限验证
- [ ] 非 admin 调用 `setModule()` 导致 revert
- [ ] 非 admin 调用 `setModules()` 导致 revert
- [ ] 非 admin 调用 `setMinDelay()` 导致 revert
- [ ] 非 admin 调用 `pause()` 导致 revert
- [ ] 非 admin 调用 `unpause()` 导致 revert
- [ ] 非 admin 调用 `upgradeStorageVersion()` 导致 revert
- [ ] 非 admin 调用 `setPendingAdmin()` 导致 revert

#### 2.2 权限检查函数
- [ ] `isAdmin(address)` 正确识别 admin
- [ ] `isAdmin(address)` 正确识别非 admin
- [ ] `requireAdmin()` 对 admin 不 revert
- [ ] `requireAdmin()` 对非 admin revert
- [ ] `requireAdminMsgSender()` 对 admin 不 revert
- [ ] `requireAdminMsgSender()` 对非 admin revert

#### 2.3 权限升级流程
- [ ] admin 可以设置 pendingAdmin
- [ ] 非 admin 不能设置 pendingAdmin
- [ ] pendingAdmin 可以调用 `acceptAdmin()`
- [ ] 非 pendingAdmin 调用 `acceptAdmin()` 导致 revert
- [ ] `acceptAdmin()` 在暂停状态下仍可执行
- [ ] `acceptAdmin()` 触发 `UpgradeAdminChanged` 事件

### 3. 模块管理测试

#### 3.1 单个模块设置
- [ ] `setModule()` 成功设置模块地址
- [ ] `setModule()` 触发 `ModuleChanged` 事件
- [ ] 零地址参数导致 revert
- [ ] 设置相同地址触发 `ModuleNoOp` 事件
- [ ] `setModuleWithStatus()` 返回正确的变更状态

#### 3.2 批量模块设置
- [ ] `setModules()` 成功设置多个模块
- [ ] 数组长度不匹配导致 revert
- [ ] 超过 MAX_BATCH_MODULES 导致 revert
- [ ] 批量操作触发 `BatchModuleChanged` 事件
- [ ] `setModulesWithStatus()` 返回正确的变更数量
- [ ] `setModulesWithStatus()` 返回正确的变更键名数组

#### 3.3 事件控制
- [ ] `setModulesWithEvents(emitIndividualEvents=false)` 不触发单个事件
- [ ] `setModulesWithEvents(emitIndividualEvents=true)` 触发单个事件
- [ ] 批量事件只包含实际变更的模块

### 4. 暂停功能测试

#### 4.1 暂停操作
- [ ] `pause()` 成功暂停系统
- [ ] `pause()` 触发 `Paused` 事件
- [ ] `pause()` 触发 `EmergencyActionExecuted` 事件
- [ ] 暂停后 `isPaused()` 返回 true

#### 4.2 恢复操作
- [ ] `unpause()` 成功恢复系统
- [ ] `unpause()` 触发 `Unpaused` 事件
- [ ] `unpause()` 触发 `EmergencyActionExecuted` 事件
- [ ] 恢复后 `isPaused()` 返回 false

#### 4.3 暂停状态下的操作限制
- [ ] 暂停状态下 `setModule()` 被阻止
- [ ] 暂停状态下 `setModules()` 被阻止
- [ ] 暂停状态下 `setMinDelay()` 被阻止
- [ ] 暂停状态下 `upgradeStorageVersion()` 被阻止
- [ ] 暂停状态下 `setPendingAdmin()` 被阻止
- [ ] 暂停状态下 `acceptAdmin()` 仍可执行（救急功能）

### 5. 存储版本管理测试

#### 5.1 版本升级
- [ ] `upgradeStorageVersion()` 成功升级版本
- [ ] `upgradeStorageVersion()` 触发 `StorageVersionUpgraded` 事件
- [ ] `upgradeStorageVersion()` 触发 `EmergencyActionExecuted` 事件
- [ ] `getStorageVersion()` 返回正确版本号

#### 5.2 版本验证
- [ ] `validateStorageLayout()` 验证存储布局
- [ ] `isInitialized()` 正确返回初始化状态

### 6. 配置管理测试

#### 6.1 最小延迟设置
- [ ] `setMinDelay()` 成功设置新的最小延迟
- [ ] 超过 MAX_DELAY 的参数导致 revert
- [ ] 超过 uint64 最大值的参数导致 revert
- [ ] `setMinDelay()` 触发 `MinDelayChanged` 事件
- [ ] `minDelay()` 返回正确的延迟值

### 7. 事件测试

#### 7.1 事件参数验证
- [ ] `ModuleChanged` 事件参数正确
- [ ] `ModuleNoOp` 事件参数正确
- [ ] `BatchModuleChanged` 事件参数正确
- [ ] `EmergencyActionExecuted` 事件参数正确
- [ ] `RegistryInitialized` 事件参数正确

#### 7.2 事件索引验证
- [ ] `EmergencyActionExecuted` 的 action 参数正确索引
- [ ] 地址参数正确索引
- [ ] 事件过滤功能正常

### 8. Gas 测试

#### 8.1 单个操作 Gas 消耗
- [ ] `setModule()` Gas 消耗 < 50,000
- [ ] `setModuleWithStatus()` Gas 消耗 < 55,000
- [ ] `pause()` Gas 消耗 < 30,000
- [ ] `unpause()` Gas 消耗 < 30,000

#### 8.2 批量操作 Gas 消耗
- [ ] `setModules(5个模块)` Gas 消耗 < 150,000
- [ ] `setModules(10个模块)` Gas 消耗 < 300,000
- [ ] `setModules(20个模块)` Gas 消耗 < 500,000
- [ ] `setModulesWithStatus(20个模块)` Gas 消耗 < 600,000

#### 8.3 Gas 优化验证
- [ ] 幂等操作（相同地址）Gas 消耗最低
- [ ] 批量操作比单个操作更节省 Gas
- [ ] 事件控制选项影响 Gas 消耗

### 9. 边界测试

#### 9.1 数组边界
- [ ] 空数组处理正确
- [ ] 最大长度数组（20个元素）处理正确
- [ ] 超过最大长度的数组导致 revert

#### 9.2 地址边界
- [ ] 零地址处理正确
- [ ] 无效地址处理正确
- [ ] 合约地址处理正确

#### 9.3 数值边界
- [ ] 零值处理正确
- [ ] 最大值处理正确
- [ ] 溢出检查正确

### 10. 安全测试

#### 10.1 重入攻击防护
- [ ] 所有写函数使用 `nonReentrant` 修饰符
- [ ] 重入攻击被正确阻止

#### 10.2 权限提升攻击
- [ ] 非授权用户无法提升权限
- [ ] 权限检查在所有关键函数中正确实现

#### 10.3 状态一致性
- [ ] 暂停状态在所有函数中正确检查
- [ ] 状态变更是原子性的
- [ ] 事件触发与实际状态变更一致

### 11. 集成测试

#### 11.1 与 RegistryStorage 集成
- [ ] 存储布局正确
- [ ] 存储版本兼容性
- [ ] 存储升级流程

#### 11.2 与 RegistryEvents 集成
- [ ] 事件定义与调用匹配
- [ ] 事件参数类型正确
- [ ] 事件索引正确

#### 11.3 与 UUPS 升级集成
- [ ] `_authorizeUpgrade()` 权限检查正确
- [ ] 升级流程正常
- [ ] 升级后状态正确

### 12. 性能测试

#### 12.1 批量操作性能
- [ ] 20个模块批量设置完成时间 < 5秒
- [ ] 批量操作内存使用合理
- [ ] 批量操作 Gas 消耗线性增长

#### 12.2 查询性能
- [ ] `getModule()` 查询时间 < 100ms
- [ ] `isModuleRegistered()` 查询时间 < 100ms
- [ ] 权限检查时间 < 50ms

## 测试执行命令

### 运行所有测试
```bash
npm test
```

### 运行特定测试类别
```bash
# 初始化测试
npm test -- --grep "initialize"

# 权限测试
npm test -- --grep "permission"

# 批量操作测试
npm test -- --grep "batch"

# 暂停功能测试
npm test -- --grep "pause"

# Gas 测试
npm run test:gas

# 安全测试
npm run test:security
```

### 生成测试报告
```bash
# 覆盖率报告
npm run test:coverage

# Gas 报告
npm run test:gas -- --gas-report

# 详细测试报告
npm test -- --verbose
```

## 测试数据准备

### 测试账户
- Admin 账户
- 非 Admin 账户
- Pending Admin 账户
- 普通用户账户

### 测试模块地址
- 有效的合约地址
- 零地址
- 无效地址

### 测试数据
- 有效的模块键名
- 无效的模块键名
- 边界值（0, MAX_DELAY, 20等）

## 测试结果验证

### 成功标准
- 所有测试用例通过
- 测试覆盖率 > 90%
- Gas 消耗在预期范围内
- 无安全漏洞

### 失败处理
- 记录失败的测试用例
- 分析失败原因
- 修复相关问题
- 重新运行测试

## 持续集成

### CI/CD 流程
1. 代码提交触发测试
2. 运行所有测试用例
3. 生成测试报告
4. 检查覆盖率要求
5. 验证 Gas 消耗
6. 部署到测试网络

### 自动化测试
- 每次提交自动运行测试
- 定期运行完整测试套件
- 监控测试结果趋势
- 及时发现问题

## 维护和更新

### 测试维护
- 定期更新测试用例
- 添加新的边界情况
- 优化测试性能
- 更新测试文档

### 测试扩展
- 添加新的功能测试
- 增加安全测试用例
- 扩展性能测试
- 完善集成测试 
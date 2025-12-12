# Liquidation Libraries 规范遵循检查清单

## 📋 概述

本检查清单确保所有清算库文件的整合工作都严格遵循项目的规范要求，包括存储结构统一规范、View函数规范和权限控制规范。

## 🎯 核心规范要求

### 1. 存储结构统一规范 (STORAGE_UNIFICATION_GUIDE.md)

#### ✅ 必须遵循的规范
- [ ] **BaseStorage 变量命名**：必须使用 `s` 作为变量名
- [ ] **ModuleCache 变量命名**：必须使用 `moduleCache` 作为变量名
- [ ] **LiquidationRewardStorage 变量命名**：必须使用 `liquidationRewardStorage` 作为变量名
- [ ] **存储变量可见性**：所有存储变量必须是 `internal`
- [ ] **私有存储变量命名**：必须以 `_` 开头

#### ✅ 禁止的命名
- [ ] 不使用 `baseStorage`、`_baseStorage`、`storage`、`base`
- [ ] 不使用 `_moduleCache`、`cache`、`modules`
- [ ] 不使用 `rewardStorage`、`_liquidationRewardStorage`、`reward`、`points`

### 2. View函数规范 (VIEW_FUNCTION_SPECIFICATION.md)

#### ✅ 函数分类转换
- [ ] **状态查询函数** → view函数
- [ ] **计算函数** → pure/view函数（精细判断）
- [ ] **缓存查询函数** → view函数

#### ✅ 缓存策略（增强安全性）
- [ ] **智能缓存机制**：带安全检查
- [ ] **缓存读取安全检查**：验证缓存值范围
- [ ] **缓存更新安全检查**：验证输入参数
- [ ] **批量缓存优化**：支持批量查询

#### ✅ 计算优化
- [ ] **纯计算函数**：使用 pure 修饰符
- [ ] **状态计算函数**：使用 view 修饰符
- [ ] **未来扩展性考虑**：预留参数化变量支持

### 3. 权限控制规范 (LiquidationAccessControl-Migration-Guide.md)

#### ✅ 权限控制迁移
- [ ] **使用 LiquidationAccessControl 库**：替换 IAccessControlManager 接口
- [ ] **Gas 优化**：节省约 70% 的 gas 消耗
- [ ] **权限检查函数**：使用库函数进行权限验证
- [ ] **权限管理函数**：提供角色授予和撤销功能

## 🔍 库文件整合检查清单

### LiquidationCoreOperations.sol 检查

#### ✅ 导入和依赖
- [ ] 正确导入 LiquidationAccessControl.sol
- [ ] 正确导入所有必要的库文件
- [ ] 使用正确的 using 语句

#### ✅ 函数规范
- [ ] **所有查询函数都是 view**：
  - `getUserHealthFactor()` → view
  - `isLiquidatable()` → view
  - `getLiquidationRiskScore()` → view
  - `getSeizableCollateralAmount()` → view
  - `getReducibleDebtAmount()` → view

- [ ] **所有计算函数都是 pure/view**：
  - `calculateHealthFactor()` → pure
  - `calculateLiquidationRiskScore()` → pure
  - `calculateLiquidationBonus()` → view
  - `calculateRiskScore()` → pure

- [ ] **所有批量操作函数都是 view**：
  - `batchGetUserHealthFactors()` → view
  - `batchIsLiquidatable()` → view
  - `batchGetLiquidationRiskScores()` → view

#### ✅ 权限控制
- [ ] 使用 LiquidationAccessControl 进行权限检查
- [ ] 提供权限管理函数（如需要）
- [ ] 遵循权限控制最佳实践

#### ✅ 缓存机制
- [ ] 实现智能缓存机制
- [ ] 添加缓存安全检查
- [ ] 支持缓存更新和清理

#### ✅ 错误处理
- [ ] 使用自定义错误（Custom Errors）
- [ ] 提供清晰的错误信息
- [ ] 实现输入验证

### 其他库文件检查

#### ✅ LiquidationViewLibrary.sol
- [ ] 所有函数都是 view
- [ ] 实现批量查询功能
- [ ] 添加缓存支持
- [ ] 遵循命名规范

#### ✅ LiquidationCacheLibrary.sol
- [ ] 实现缓存结构体
- [ ] 提供缓存操作函数
- [ ] 添加安全检查
- [ ] 支持批量操作

#### ✅ LiquidationCalculationLibrary.sol
- [ ] 纯计算函数使用 pure
- [ ] 涉及存储的函数使用 view
- [ ] 提供计算优化
- [ ] 支持参数化配置

## 🚀 实施检查步骤

### 步骤 1：规范验证
- [ ] 检查存储结构命名规范
- [ ] 验证函数可见性规范
- [ ] 确认权限控制规范
- [ ] 验证缓存机制规范

### 步骤 2：功能验证
- [ ] 测试所有 view 函数
- [ ] 验证批量查询功能
- [ ] 测试缓存机制
- [ ] 验证权限控制

### 步骤 3：性能验证
- [ ] 测试 Gas 优化效果
- [ ] 验证缓存性能
- [ ] 测试批量操作性能
- [ ] 验证计算优化

### 步骤 4：安全验证
- [ ] 测试输入验证
- [ ] 验证缓存安全检查
- [ ] 测试权限控制
- [ ] 验证错误处理

### 步骤 5：兼容性验证
- [ ] 验证接口兼容性
- [ ] 测试向后兼容性
- [ ] 验证升级路径
- [ ] 测试模块间交互

## 📊 检查结果记录

### LiquidationCoreOperations.sol 检查结果

#### ✅ 已完成
- [x] 创建基础库文件结构
- [x] 整合核心清算逻辑
- [x] 整合计算功能
- [x] 整合批量操作
- [x] 整合查询功能
- [x] 添加必要的导入语句
- [x] 实现基础错误处理

#### ⚠️ 需要完善
- [ ] 完善缓存机制实现
- [ ] 添加更多安全检查
- [ ] 优化批量查询性能
- [ ] 添加更多计算函数
- [ ] 完善权限控制集成

#### ❌ 需要修复
- [ ] 修复 LiquidationAccessControl 导入问题
- [ ] 完善存储结构规范遵循
- [ ] 添加更多 view 函数
- [ ] 优化错误处理机制

## 🎯 下一步行动计划

### 立即修复项目
1. **修复导入问题**：解决 LiquidationAccessControl 导入错误
2. **完善存储规范**：确保完全遵循存储结构统一规范
3. **添加缓存机制**：实现智能缓存机制（带安全检查）
4. **完善权限控制**：集成 LiquidationAccessControl 库

### 功能完善项目
1. **扩展计算函数**：添加更多纯计算和状态计算函数
2. **优化批量操作**：实现高效的批量查询和操作
3. **增强错误处理**：完善自定义错误和输入验证
4. **添加预览功能**：实现清算预览和Flash Loan影响计算

### 测试和验证项目
1. **编写单元测试**：为所有库函数编写测试
2. **性能测试**：验证 Gas 优化效果
3. **安全测试**：验证缓存安全检查和权限控制
4. **集成测试**：测试模块间交互

## 📝 注意事项

### 1. 规范遵循优先级
- **高优先级**：存储结构规范、View函数规范
- **中优先级**：权限控制规范、缓存机制规范
- **低优先级**：性能优化、功能扩展

### 2. 兼容性要求
- 保持现有接口的兼容性
- 确保向后兼容性
- 提供迁移指南

### 3. 安全要求
- 确保所有安全检查到位
- 验证权限控制完整性
- 测试边界情况和错误处理

### 4. 性能要求
- 验证 Gas 优化效果
- 测试缓存性能
- 确保批量操作效率

---

**检查清单制定日期**: 2024年12月
**负责人**: 开发团队
**审核人**: 技术负责人 
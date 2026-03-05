# Registry 存储迁移指南

## 📋 目录

1. [概述](#概述)
2. [存储迁移原理](#存储迁移原理)
3. [实现指南](#实现指南)
4. [操作流程](#操作流程)
5. [示例场景](#示例场景)
6. [最佳实践](#最佳实践)
7. [故障排查](#故障排查)
8. [常见问题](#常见问题)

---

## 概述

### 什么是存储迁移？

存储迁移是在保持**固定存储槽位（STORAGE_SLOT）**的前提下，对 Registry 合约的存储结构进行升级的过程。它允许我们在不丢失历史数据的情况下，安全地修改存储布局。

### 为什么需要存储迁移？

1. **添加新字段**：在存储布局中添加新的状态变量
2. **修改字段类型**：调整现有字段的数据类型（需谨慎）
3. **重新组织数据**：优化存储布局以提高 Gas 效率
4. **初始化新字段**：为新添加的字段设置初始值

### 核心原则

- ✅ **保持 STORAGE_SLOT 不变**：确保数据连续性
- ✅ **版本化控制**：通过 `storageVersion` 跟踪存储布局版本
- ✅ **迁移前后验证**：自动调用 `validateStorageLayout()` 确保数据完整性
- ✅ **治理驱动**：所有迁移操作必须通过治理流程执行

---

## 存储迁移原理

### 存储布局架构

Registry 使用**库式钻石存储模式**，所有 Registry 家族合约共享同一个存储槽位：

```solidity
// 固定存储槽位
bytes32 internal constant STORAGE_SLOT = keccak256("registry.storage.v1");

// 存储布局结构
struct Layout {
    uint256 storageVersion;    // 存储版本号
    address admin;             // 治理地址
    address pendingAdmin;      // 待接管地址
    uint8 paused;              // 暂停状态
    uint64 minDelay;           // 最小延迟时间
    mapping(bytes32 => address) modules;  // 模块映射
    mapping(bytes32 => PendingUpgrade) pendingUpgrades;  // 待执行升级
    mapping(bytes32 => UpgradeHistory[]) upgradeHistory; // 升级历史
    mapping(bytes32 => uint256) historyIndex; // 升级历史索引
    mapping(address => uint256) nonces;   // 签名 nonces
    uint256[50] __gap;          // 预留空间
}
```

### 迁移流程

```
1. 迁移前验证
   └─> validateStorageLayout()
       └─> 检查关键字段（admin, storageVersion、minDelay 上界等）

2. 执行迁移逻辑
   └─> Registry.migrateStorage(fromVersion, toVersion, migrator)
       └─> delegatecall migrator.migrate()
           └─> 迁移器修改存储数据（保持 STORAGE_SLOT 不变）

3. 版本升级
   └─> RegistryStorage.upgradeStorageVersion(toVersion)

4. 迁移后验证
   └─> validateStorageLayout()
       └─> 确保迁移后数据完整性

5. 发出事件
   └─> emit StorageMigrated(fromVersion, toVersion, migrator)
```

### 关键安全机制

1. **版本检查**：确保当前版本与 `fromVersion` 匹配
2. **版本递增**：`toVersion` 必须大于当前版本
3. **零地址检查**：迁移器地址不能为零
4. **布局验证**：迁移前后自动验证存储布局
5. **权限控制**：只有 owner 可以执行迁移

---

## 实现指南

### 步骤 1：定义迁移合约

创建一个实现 `IRegistryStorageMigrator` 接口的迁移合约：

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IRegistryStorageMigrator } from "../interfaces/IRegistryStorageMigrator.sol";
import { RegistryStorage } from "../registry/RegistryStorageLibrary.sol";

/// @title RegistryStorageMigratorExample
/// @notice 存储迁移示例（从 fromVersion 迁移到 toVersion）
contract RegistryStorageMigratorExample is IRegistryStorageMigrator {
    
    /// @inheritdoc IRegistryStorageMigrator
    function migrate(uint256 fromVersion, uint256 toVersion) external override {
        // 1. 验证当前版本
        RegistryStorage.requireCompatibleVersion(fromVersion);
        
        // 2. 获取存储布局
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 3. 执行数据迁移
        // 示例：添加新字段的初始化
        // l.newField = defaultValue;
        
        // 示例：修改现有字段
        // l.existingField = transformData(l.existingField);
        
        // 示例：重新组织数据
        // migrateDataStructure(l);
        
        // 4. 发出迁移事件（可选）
        // emit MigrationCompleted(fromVersion, toVersion);
        
        // 注意：不要修改 storageVersion，Registry 会自动处理
    }
}
```

### 步骤 2：迁移合约模板

#### 模板 A：添加新字段

```solidity
contract RegistryStorageMigratorAddField is IRegistryStorageMigrator {
    function migrate(uint256 fromVersion, uint256 toVersion) external override {
        RegistryStorage.requireCompatibleVersion(fromVersion);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 初始化新字段
        // 假设在 Layout 中添加了 uint256 newCounter 字段
        // l.newCounter = 0;  // 设置默认值
        
        // 如果新字段需要基于现有数据计算
        // l.newCounter = calculateInitialValue(l);
    }
}
```

#### 模板 B：修改字段类型

```solidity
contract RegistryStorageMigratorTypeChange is IRegistryStorageMigrator {
    function migrate(uint256 fromVersion, uint256 toVersion) external override {
        RegistryStorage.requireCompatibleVersion(fromVersion);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 注意：修改字段类型需要非常谨慎
        // 1. 读取旧值
        // uint256 oldValue = l.oldField;
        
        // 2. 转换到新类型
        // uint64 newValue = uint64(oldValue);
        
        // 3. 写入新字段（需要确保新字段在存储布局中的位置正确）
        // l.newField = newValue;
        
        // ⚠️ 警告：类型转换可能导致数据丢失，务必充分测试
    }
}
```

#### 模板 C：数据重组

```solidity
contract RegistryStorageMigratorReorganize is IRegistryStorageMigrator {
    function migrate(uint256 fromVersion, uint256 toVersion) external override {
        RegistryStorage.requireCompatibleVersion(fromVersion);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 示例：将多个字段合并为一个结构体
        // StructData memory newStruct = StructData({
        //     field1: l.oldField1,
        //     field2: l.oldField2,
        //     field3: l.oldField3
        // });
        // l.newStructField = newStruct;
        
        // 注意：确保新结构在存储布局中正确对齐
    }
}
```

### 步骤 3：编写测试

为迁移合约编写完整的测试：

```typescript
describe('RegistryStorageMigratorExample', function () {
  it('应当成功迁移存储', async function () {
    const fromVersion = await registry.getStorageVersion();
    expect(fromVersion).to.equal(1n);
    
    // 部署迁移器
    const MigratorFactory = await ethers.getContractFactory('RegistryStorageMigratorExample');
    const migrator = await MigratorFactory.deploy();
    await migrator.waitForDeployment();
    
    // 执行迁移
    const tx = await registry.migrateStorage(
      fromVersion,
      fromVersion + 1n,
      await migrator.getAddress()
    );
    
    // 验证事件
    await expect(tx)
      .to.emit(registry, 'StorageMigrated')
      .withArgs(fromVersion, fromVersion + 1n, await migrator.getAddress());
    
    // 验证版本已更新
    expect(await registry.getStorageVersion()).to.equal(fromVersion + 1n);
    
    // 验证数据完整性
    expect(await registry.owner()).to.equal(owner.address);
    // 验证新字段已正确初始化
    // expect(await registry.getNewField()).to.equal(expectedValue);
  });
  
  it('应当在版本不匹配时失败', async function () {
    // 测试错误场景
  });
});
```

### 步骤 4：更新存储布局

如果添加了新字段，需要在 `RegistryStorageLibrary.sol` 中更新 `Layout` 结构；注意 `upgradeHistory` 后还有 `historyIndex` 与 `nonces`，新增字段必须放在它们之后再调整 `__gap`：

```solidity
library RegistryStorage {
    struct Layout {
        // ... 现有字段（含 upgradeHistory、historyIndex、nonces） ...
        
        // 新增字段（添加到 __gap 之前）
        uint256 newCounter;     // 新字段示例
        
        // 调整 __gap 大小以保持总存储槽位不变（在已有字段之后再缩减）
        uint256[49] __gap;      // 从 50 减少到 49
    }
    
    // 更新版本常量
    uint256 internal constant CURRENT_STORAGE_VERSION = 2;
}
```

---

## 操作流程

### 阶段 1：准备阶段

#### 1.1 分析存储变更

- [ ] 确定需要修改的存储字段
- [ ] 评估变更对现有数据的影响
- [ ] 设计迁移策略
- [ ] 计算 Gas 成本

#### 1.2 开发迁移合约

- [ ] 实现 `IRegistryStorageMigrator` 接口
- [ ] 编写迁移逻辑
- [ ] 添加必要的验证和错误处理
- [ ] 编写单元测试

#### 1.3 测试验证

- [ ] 在本地环境测试迁移
- [ ] 验证数据完整性
- [ ] 测试回滚场景
- [ ] 进行 Gas 优化

### 阶段 2：部署阶段

#### 2.1 部署迁移合约

```bash
# 编译迁移合约
npx hardhat compile

# 部署到测试网
npx hardhat run scripts/deploy-migrator.ts --network arbitrum-sepolia

# 验证合约
npx hardhat verify --network arbitrum-sepolia <MIGRATOR_ADDRESS>
```

#### 2.2 验证当前状态

```typescript
// 检查当前存储版本
const currentVersion = await registry.getStorageVersion();
console.log('Current storage version:', currentVersion.toString());

// 验证存储布局
await registry.validateStorageLayout();
console.log('Storage layout validated');

// 备份关键数据（可选）
// owner 是 UUPS 代理管理员；admin 是存储层治理地址
const admin = await registry.owner();
const storageAdminOk = await registry.isAdmin(admin);
const minDelay = await registry.minDelay();
console.log('Admin:', admin);
console.log('Is storage admin valid:', storageAdminOk);
console.log('MinDelay:', minDelay.toString());
// validateStorageLayout 会同时检查 minDelay 不超过 10 年；运行时 setMinDelay 也受 _MAX_DELAY=7 days 约束
```

### 阶段 3：执行迁移

#### 3.1 通过治理执行

```typescript
// 方式 1：直接调用（仅限测试环境）
const tx = await registry.migrateStorage(
  fromVersion,      // 当前版本
  toVersion,        // 目标版本
  migratorAddress   // 迁移器地址
);
await tx.wait();

// 方式 2：通过 Timelock（生产环境推荐）
// 1. 创建治理提案
// 2. 等待投票通过
// 3. 等待 timelock 延迟
// 4. 执行迁移
```

#### 3.2 使用 CLI 工具

```bash
# 使用 registry-migrate 任务
npx hardhat registry:migrate:min \
  --registry <REGISTRY_ADDRESS> \
  --newStorageVersion <NEW_VERSION>

# 或完整迁移流程
npx hardhat registry:migrate \
  --registry <REGISTRY_ADDRESS> \
  --from-version <FROM_VERSION> \
  --to-version <TO_VERSION> \
  --migrator <MIGRATOR_ADDRESS>
```

### 阶段 4：验证阶段

#### 4.1 链上验证

```typescript
// 验证版本已更新
const newVersion = await registry.getStorageVersion();
expect(newVersion).to.equal(toVersion);

// 验证存储布局
await registry.validateStorageLayout();
console.log('Post-migration validation passed');

// 验证关键字段
expect(await registry.owner()).to.equal(admin);
expect(await registry.minDelay()).to.equal(minDelay);
expect(await registry.isAdmin(admin)).to.equal(true); // 存储层 admin 未被破坏

// 验证新字段（如果添加了）
// expect(await registry.getNewField()).to.equal(expectedValue);
```

#### 4.2 功能验证

- [ ] 测试核心功能是否正常
- [ ] 验证模块注册/查询功能
- [ ] 检查升级流程是否正常
- [ ] 验证权限控制是否正常

#### 4.3 事件检查

```typescript
// 检查迁移事件
const filter = registry.filters.StorageMigrated();
const events = await registry.queryFilter(filter);
const latestEvent = events[events.length - 1];

expect(latestEvent.args.fromVersion).to.equal(fromVersion);
expect(latestEvent.args.toVersion).to.equal(toVersion);
expect(latestEvent.args.migrator).to.equal(migratorAddress);
```

---

## 示例场景

### 场景 1：添加新的配置字段

**需求**：在 Registry 存储中添加一个新的 `maxModules` 字段，限制可注册的模块数量。

**实现**：

```solidity
// 1. 更新 RegistryStorageLibrary.sol
library RegistryStorage {
    struct Layout {
        // ... 现有字段 ...
        uint256 maxModules;     // 新增字段
        uint256[49] __gap;      // 调整 __gap
    }
}

// 2. 创建迁移合约
contract RegistryStorageMigratorAddMaxModules is IRegistryStorageMigrator {
    uint256 public constant DEFAULT_MAX_MODULES = 100;
    
    function migrate(uint256 fromVersion, uint256 toVersion) external override {
        RegistryStorage.requireCompatibleVersion(fromVersion);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 初始化新字段
        l.maxModules = DEFAULT_MAX_MODULES;
    }
}
```

### 场景 2：优化存储布局

**需求**：将 `paused` 和 `minDelay` 字段打包到同一个存储槽位以节省 Gas。

**实现**：

```solidity
contract RegistryStorageMigratorOptimizeLayout is IRegistryStorageMigrator {
    function migrate(uint256 fromVersion, uint256 toVersion) external override {
        RegistryStorage.requireCompatibleVersion(fromVersion);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 读取旧值
        uint8 oldPaused = l.paused;
        uint64 oldMinDelay = l.minDelay;
        
        // 在新布局中，这两个字段已经打包在一起
        // 只需确保数据正确迁移（通常布局变更会自动处理）
        // 但如果需要重新打包，可以这样做：
        // l.paused = oldPaused;
        // l.minDelay = oldMinDelay;
        
        // 注意：此场景通常不需要显式迁移，因为 Solidity 会自动处理存储对齐
    }
}
```

### 场景 3：迁移复杂数据结构

**需求**：将简单的 mapping 迁移为更复杂的结构体 mapping。

**实现**：

```solidity
contract RegistryStorageMigratorComplexData is IRegistryStorageMigrator {
    function migrate(uint256 fromVersion, uint256 toVersion) external override {
        RegistryStorage.requireCompatibleVersion(fromVersion);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 假设需要迁移 modules mapping 到包含额外信息的结构体
        // 这需要遍历所有现有模块并迁移数据
        
        // 注意：在合约中遍历 mapping 是不可能的
        // 解决方案：
        // 1. 维护一个模块键列表（在迁移前添加）
        // 2. 使用链下脚本生成迁移数据
        // 3. 采用延迟迁移策略（按需迁移）
        
        // 示例：延迟迁移模式
        // 在迁移时只设置标志，实际迁移在后续调用中完成
        // l.migrationFlag = true;
    }
}
```

### 场景 4：修复数据损坏

**需求**：修复由于 bug 导致的数据不一致问题。

**实现**：

```solidity
contract RegistryStorageMigratorFixCorruption is IRegistryStorageMigrator {
    function migrate(uint256 fromVersion, uint256 toVersion) external override {
        RegistryStorage.requireCompatibleVersion(fromVersion);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 检测并修复损坏的数据
        if (l.admin == address(0)) {
            // 如果 admin 被意外清空，从备份或其他来源恢复
            // 注意：这需要治理多重签名确认
            // l.admin = recoveredAdmin;
        }
        
        // 修复其他不一致的数据
        // if (l.minDelay == 0) {
        //     l.minDelay = DEFAULT_MIN_DELAY;
        // }
    }
}
```

---

## 最佳实践

### 1. 迁移合约设计

#### ✅ 推荐做法

- **保持无状态**：迁移合约应该是无状态的（使用 `immutable` 或常量）
- **验证版本**：始终调用 `requireCompatibleVersion()` 验证当前版本
- **原子操作**：确保迁移操作是原子的，要么全部成功，要么全部失败
- **发出事件**：在迁移过程中发出事件以便追踪和审计
- **Gas 优化**：避免在迁移中执行昂贵的操作（如遍历大型 mapping）

#### ❌ 避免做法

- **不要修改 storageVersion**：Registry 会自动处理版本升级
- **不要修改 STORAGE_SLOT**：保持存储槽位不变
- **不要执行外部调用**：避免在迁移中调用外部合约
- **不要修改实现地址**：不要尝试修改代理的实现地址
- **不要清空关键字段**：确保 admin、minDelay 等关键字段不被清空

### 2. 测试策略

#### 单元测试

```typescript
describe('Migration Tests', function () {
  it('应当验证版本匹配', async function () {
    // 测试版本验证逻辑
  });
  
  it('应当正确迁移数据', async function () {
    // 测试数据迁移逻辑
  });
  
  it('应当在版本不匹配时失败', async function () {
    // 测试错误处理
  });
  
  it('应当保持关键字段不变', async function () {
    // 测试数据完整性
  });
});
```

#### 集成测试

```typescript
describe('Migration Integration', function () {
  it('应当完成端到端迁移流程', async function () {
    // 1. 准备测试数据
    // 2. 执行迁移
    // 3. 验证所有功能正常
  });
  
  it('应当支持连续迁移', async function () {
    // 测试 1->2->3 的连续迁移
  });
});
```

### 3. 安全考虑

#### 权限控制

- ✅ 所有迁移必须通过治理流程（Timelock/Multisig）
- ✅ 迁移合约部署后应进行代码审计
- ✅ 在生产环境执行前，先在测试网充分测试

#### 数据备份

```typescript
// 迁移前备份关键数据
async function backupRegistryState(registry: Registry) {
  return {
    version: await registry.getStorageVersion(),
    admin: await registry.owner(),
    minDelay: await registry.minDelay(),
    paused: await registry.isPaused(),
    // 备份模块地址
    modules: await getAllModules(registry),
  };
}
```

#### 回滚计划

1. **准备回滚迁移器**：创建一个可以回滚到之前版本的迁移器
2. **监控迁移过程**：实时监控迁移执行状态
3. **快速响应**：如果发现问题，立即停止并评估回滚

### 4. Gas 优化

#### 批量操作

```solidity
// ❌ 低效：逐个迁移
for (uint i = 0; i < items.length; i++) {
    migrateItem(items[i]);
}

// ✅ 高效：批量迁移
function migrateBatch(bytes32[] memory keys) external {
    RegistryStorage.Layout storage l = RegistryStorage.layout();
    for (uint i = 0; i < keys.length; i++) {
        // 批量迁移逻辑
    }
}
```

#### 存储打包

```solidity
// ✅ 利用存储打包减少 Gas
struct PackedData {
    uint8 field1;   // 占用 1 字节
    uint64 field2;  // 占用 8 字节
    uint128 field3; // 占用 16 字节
    // 总共 32 字节，打包在一个 slot 中
}
```

### 5. 文档和审计

#### 迁移文档模板

```markdown
## 迁移 版本 1 -> 版本 2

### 变更内容
- 添加 `maxModules` 字段
- 优化存储布局

### 迁移步骤
1. 部署迁移合约
2. 执行迁移
3. 验证结果

### 回滚方案
如果迁移失败，使用 RollbackMigrator 回滚
```

#### 审计清单

- [ ] 迁移逻辑代码审查
- [ ] 安全漏洞扫描
- [ ] Gas 消耗分析
- [ ] 数据完整性验证
- [ ] 边界条件测试

---

## 故障排查

### 常见错误

#### 1. `StorageVersionMismatch`

**错误信息**：`StorageVersionMismatch(fromVersion, currentVersion)`

**原因**：当前存储版本与 `fromVersion` 参数不匹配

**解决方案**：
```typescript
// 检查当前版本
const currentVersion = await registry.getStorageVersion();
console.log('Current version:', currentVersion.toString());

// 使用正确的版本号
await registry.migrateStorage(currentVersion, toVersion, migrator);
```

#### 2. `InvalidMigrationTarget`

**错误信息**：`InvalidMigrationTarget(fromVersion, toVersion)`

**原因**：`toVersion` 必须大于 `fromVersion`

**解决方案**：
```typescript
// 确保版本递增
const fromVersion = await registry.getStorageVersion();
const toVersion = fromVersion + 1n; // 或更大的值

await registry.migrateStorage(fromVersion, toVersion, migrator);
```

#### 3. `MigratorFailed`

**错误信息**：`MigratorFailed(migrator, reason)`

**原因**：迁移合约执行失败（revert）

**解决方案**：
1. 检查迁移合约代码
2. 验证版本匹配
3. 检查数据完整性
4. 查看 revert 原因：
```typescript
try {
  await registry.migrateStorage(fromVersion, toVersion, migrator);
} catch (error) {
  console.error('Migration failed:', error);
  // 检查错误详情
}
```

#### 4. `ZeroAddress`

**错误信息**：`ZeroAddress()`

**原因**：迁移器地址为零

**解决方案**：
```typescript
// 确保迁移器地址有效
const migratorAddress = await migrator.getAddress();
if (migratorAddress === ethers.ZeroAddress) {
  throw new Error('Migrator not deployed');
}

await registry.migrateStorage(fromVersion, toVersion, migratorAddress);
```

#### 5. 存储布局验证失败

**错误信息**：`validateStorageLayout()` 失败

**原因**：迁移后关键字段被破坏（如 admin 被清空）

**解决方案**：
1. 检查迁移合约逻辑
2. 确保不修改关键字段
3. 如果必须修改，确保新值有效：
```solidity
function migrate(...) external override {
    RegistryStorage.Layout storage l = RegistryStorage.layout();
    
    // ❌ 错误：清空 admin
    // l.admin = address(0);
    
    // ✅ 正确：保持或设置为有效地址
    // l.admin = l.admin; // 保持不变
    // 或
    // l.admin = newAdmin; // 设置为新的有效地址
}
```

### 调试技巧

#### 1. 使用事件追踪

```typescript
// 监听迁移事件
registry.on(registry.filters.StorageMigrated(), (fromVersion, toVersion, migrator) => {
  console.log('Migration completed:', {
    fromVersion: fromVersion.toString(),
    toVersion: toVersion.toString(),
    migrator: migrator,
  });
});
```

#### 2. 分步执行

```typescript
// 先验证当前状态
await registry.validateStorageLayout();
const versionBefore = await registry.getStorageVersion();

// 执行迁移
const tx = await registry.migrateStorage(...);
await tx.wait();

// 验证迁移后状态
await registry.validateStorageLayout();
const versionAfter = await registry.getStorageVersion();
console.log('Version updated:', versionBefore.toString(), '->', versionAfter.toString());
```

#### 3. 使用 Hardhat Console

```bash
# 启动 Hardhat console
npx hardhat console --network localhost

# 在 console 中检查状态
const Registry = await ethers.getContractFactory('Registry');
const registry = Registry.attach('0x...');
const version = await registry.getStorageVersion();
console.log('Current version:', version.toString());
```

### 恢复方案

#### 方案 1：回滚迁移

如果迁移导致问题，可以创建回滚迁移器：

```solidity
contract RegistryStorageMigratorRollback is IRegistryStorageMigrator {
    function migrate(uint256 fromVersion, uint256 toVersion) external override {
        RegistryStorage.requireCompatibleVersion(fromVersion);
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 恢复之前的状态
        // 注意：这需要保存迁移前的状态快照
        // l.field = previousValue;
    }
}
```

#### 方案 2：紧急暂停

如果迁移导致严重问题，可以暂停 Registry：

```typescript
// 通过紧急管理员暂停
await registry.connect(emergencyAdmin).pause();
```

#### 方案 3：数据恢复

如果数据被破坏，需要从备份恢复：

```typescript
// 从备份恢复关键数据
const backup = loadBackup();
await registry.setAdmin(backup.admin);
await registry.setMinDelay(backup.minDelay);
// ... 恢复其他数据
```

---

## 常见问题

### Q1: 迁移会丢失数据吗？

**A**: 不会。迁移是在保持 `STORAGE_SLOT` 不变的前提下进行的，所有现有数据都会保留。迁移只是：
- 添加新字段并初始化
- 修改现有字段的值
- 重新组织数据结构

### Q2: 迁移可以回滚吗？

**A**: 可以，但需要创建专门的回滚迁移器。回滚迁移器需要：
- 保存迁移前的状态快照
- 实现反向迁移逻辑
- 通过治理流程执行

### Q3: 迁移需要多长时间？

**A**: 迁移本身是原子操作，通常在单个交易中完成。但整个流程包括：
- 治理提案：1-7 天（取决于治理流程）
- Timelock 延迟：取决于 `minDelay` 设置
- 迁移执行：单个交易（几秒到几分钟）
- 验证：几分钟到几小时

### Q4: 迁移失败会怎样？

**A**: 如果迁移失败：
- 交易会 revert，状态不会改变
- `storageVersion` 保持不变
- 所有数据保持原样
- 可以修复问题后重新尝试

### Q5: 可以跳过版本吗？

**A**: 可以。`toVersion` 可以是任意大于 `fromVersion` 的值。例如：
- 1 -> 2：正常升级
- 1 -> 10：跳过中间版本（需要迁移器处理所有变更）

### Q6: 迁移合约可以升级吗？

**A**: 迁移合约通常是**无状态的**，部署后不需要升级。如果需要修改迁移逻辑：
- 部署新的迁移合约
- 使用新的迁移器地址执行迁移

### Q7: 如何测试迁移？

**A**: 推荐测试流程：
1. **单元测试**：测试迁移合约逻辑
2. **集成测试**：在本地 Hardhat 网络测试完整流程
3. **测试网测试**：在测试网（如 Arbitrum Sepolia）测试
4. **主网测试**：小规模测试后全面部署

### Q8: 迁移会影响正在进行的操作吗？

**A**: 迁移是原子操作，不会影响：
- 正在进行的交易（迁移执行时会被阻塞，但迁移完成后可以继续）
- 已注册的模块地址
- 待执行的升级队列

但建议：
- 在低流量时段执行迁移
- 提前通知用户可能的短暂中断
- 监控迁移执行过程

---

## 总结

存储迁移是 Registry 系统升级的关键机制，它允许我们在保持数据连续性的同时安全地升级存储布局。遵循本指南的最佳实践，可以确保迁移过程的安全和可靠。

### 关键要点

1. ✅ **保持 STORAGE_SLOT 不变**：确保数据连续性
2. ✅ **充分测试**：在测试网充分测试后再部署到主网
3. ✅ **通过治理执行**：所有迁移必须经过治理流程
4. ✅ **数据备份**：迁移前备份关键数据
5. ✅ **监控验证**：迁移后验证数据完整性和功能正常性

### 相关资源

- [Registry 使用指南](./Registry-Guide.md)
- [架构指南](../Architecture-Guide.md)
- [测试指南](../Test-Guide/registry-testing-guide.md)
- [CLI 工具文档](../CLI.md)

### 获取帮助

如果遇到问题：
1. 查看本文档的[故障排查](#故障排查)部分
2. 检查测试用例：`test/RegistryStorageMigration.test.ts`
3. 参考示例实现：`src/Mocks/RegistryStorageMigratorMock.sol`
4. 联系开发团队获取支持

---

**最后更新**：2025-01-XX  
**文档版本**：1.0.0


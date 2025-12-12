# Registry 查询优化指南

## 概述

本文档详细说明了如何将 Registry 合约中的高 Gas 操作优化为高效的 view 函数，提供统一的查询解决方案。

## 1. 问题分析

### 1.1 当前高 Gas 操作

在 `RegistryQuery.sol` 中，以下函数存在高 Gas 消耗问题：

```solidity
// 高 Gas 操作列表
function getAllRegisteredModuleKeys() internal view returns (bytes32[] memory)
function getAllRegisteredModules() internal view returns (bytes32[] memory keys, address[] memory addresses)
function getAllUpgradeHistory(bytes32 key) internal view returns (RegistryStorage.UpgradeHistory[] memory)
function getRegisteredModuleKeysPaginated(uint256 offset, uint256 limit) internal view returns (bytes32[] memory keys, uint256 totalCount)
function getModuleInfoPaginated(uint256 offset, uint256 limit, uint256 maxTotalCount) internal view returns (ModuleInfo[] memory infos, uint256 totalCount)
```

### 1.2 Gas 消耗原因

1. **遍历所有模块键**：需要遍历 `ModuleKeys.getAllKeys()` 返回的所有键
2. **多次存储访问**：每个键都需要访问 `RegistryStorage.layout().modules[key]`
3. **数组操作**：动态数组的创建和填充操作
4. **分页计算**：需要计算偏移量和限制范围
5. **环形缓冲计算**：升级历史涉及复杂的环形缓冲逻辑

## 2. 解决方案：View 函数优化

### 2.1 核心优化策略

#### **1. 参数限制**
```solidity
uint256 private constant MAX_QUERY_LIMIT = 50;
uint256 private constant DEFAULT_PAGE_SIZE = 20;
uint256 private constant MAX_UPGRADE_HISTORY = 100;
```

#### **2. 结构化数据**
```solidity
/// @notice 模块信息结构体
struct ModuleInfo {
    bytes32 key;
    address addr;
}

/// @notice 分页结果结构体
struct PaginatedResult {
    ModuleInfo[] infos;
    uint256 totalCount;
    bool hasNext;
    bool hasPrev;
}
```

#### **3. 轻量级查询函数**

```solidity
/// @notice 获取单个模块信息
function getModuleInfo(bytes32 key) internal view returns (ModuleInfo memory)

/// @notice 获取多个模块信息（轻量级批量查询）
function getMultipleModuleInfo(bytes32[] memory keys) internal view returns (ModuleInfo[] memory)

/// @notice 获取已注册模块信息（限制数量）
function getAllModuleInfo(uint256 maxCount) internal view returns (ModuleInfo[] memory)

/// @notice 分页获取模块信息（轻量级版本）
function getModuleInfoPaginated(uint256 startIndex, uint256 count, uint256 maxTotalCount) internal view returns (PaginatedResult memory)

/// @notice 获取模块统计信息
function getModuleStatistics(uint256 maxCount) internal view returns (uint256 totalModules, uint256 registeredModules, uint256 unregisteredModules)

/// @notice 检查多个模块是否已注册
function batchIsModuleRegistered(bytes32[] memory keys) internal view returns (bool[] memory)
```

### 2.2 优化效果对比

| 方面 | 优化前 | 优化后 |
|------|--------|--------|
| **Gas 消耗** | 高（无限制遍历） | 低（参数限制） |
| **函数接口** | 固定限制 | 灵活参数控制 |
| **数据结构** | 分离数组 | 统一结构体 |
| **向后兼容** | 无 | 完全兼容 |
| **新增功能** | 无 | 统计、批量检查等 |

## 3. 前端集成指南

### 3.1 React Hook 集成

```typescript
// hooks/useRegistryQuery.ts
import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';

interface ModuleInfo {
  key: string;
  addr: string;
}

interface PaginatedResult {
  infos: ModuleInfo[];
  totalCount: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export const useRegistryQuery = (provider: ethers.Provider, registryAddress: string) => {
  const [queryService] = useState(() => 
    new RegistryQueryService(provider, registryAddress, REGISTRY_ABI)
  );

  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 获取所有已注册模块（限制数量）
  const getAllModuleInfo = useCallback(async (maxCount: number = 50) => {
    setLoading(true);
    try {
      const data = await queryService.getAllModuleInfo(maxCount);
      setModules(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [queryService]);

  // 获取单个模块信息
  const getModuleInfo = useCallback(async (key: string) => {
    try {
      return await queryService.getModuleInfo(key);
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }, [queryService]);

  // 分页获取模块信息
  const getModuleInfoPaginated = useCallback(async (startIndex: number, count: number) => {
    setLoading(true);
    try {
      const result = await queryService.getModuleInfoPaginated(startIndex, count);
      setModules(result.infos);
      return result;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [queryService]);

  return {
    modules,
    loading,
    error,
    getAllModuleInfo,
    getModuleInfo,
    getModuleInfoPaginated,
    queryService
  };
};
```

### 3.2 Vue Composable 集成

```typescript
// composables/useRegistryQuery.ts
import { ref, computed } from 'vue';
import { ethers } from 'ethers';

export const useRegistryQuery = (provider: ethers.Provider, registryAddress: string) => {
  const queryService = new RegistryQueryService(provider, registryAddress, REGISTRY_ABI);
  
  const modules = ref<ModuleInfo[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // 获取所有已注册模块
  const getAllModuleInfo = async (maxCount: number = 50) => {
    loading.value = true;
    error.value = null;
    
    try {
      const data = await queryService.getAllModuleInfo(maxCount);
      modules.value = data;
    } catch (err) {
      error.value = err.message;
    } finally {
      loading.value = false;
    }
  };

  // 获取单个模块信息
  const getModuleInfo = async (key: string) => {
    try {
      return await queryService.getModuleInfo(key);
    } catch (err) {
      error.value = err.message;
      throw err;
    }
  };

  // 分页获取模块信息
  const getModuleInfoPaginated = async (startIndex: number, count: number) => {
    loading.value = true;
    error.value = null;
    
    try {
      const result = await queryService.getModuleInfoPaginated(startIndex, count);
      modules.value = result.infos;
      return result;
    } catch (err) {
      error.value = err.message;
      throw err;
    } finally {
      loading.value = false;
    }
  };

  // 计算属性
  const registeredModules = computed(() => 
    modules.value.filter(m => m.addr !== ethers.ZeroAddress)
  );

  const moduleCount = computed(() => 
    registeredModules.value.length
  );

  return {
    modules,
    loading,
    error,
    registeredModules,
    moduleCount,
    getAllModuleInfo,
    getModuleInfo,
    getModuleInfoPaginated
  };
};
```

### 3.3 Registry 查询服务类

```typescript
// services/registryQueryService.ts
export class RegistryQueryService {
  private provider: ethers.Provider;
  private registryContract: ethers.Contract;

  constructor(
    provider: ethers.Provider,
    registryAddress: string,
    registryAbi: any
  ) {
    this.provider = provider;
    this.registryContract = new ethers.Contract(registryAddress, registryAbi, provider);
  }

  // 获取单个模块信息
  async getModuleInfo(key: string): Promise<ModuleInfo> {
    try {
      const result = await this.registryContract.getModuleInfo(key);
      return {
        key: result.key,
        addr: result.addr
      };
    } catch (error) {
      throw new Error(`Failed to get module info: ${error.message}`);
    }
  }

  // 获取多个模块信息
  async getMultipleModuleInfo(keys: string[]): Promise<ModuleInfo[]> {
    try {
      const result = await this.registryContract.getMultipleModuleInfo(keys);
      return result.map((item: any) => ({
        key: item.key,
        addr: item.addr
      }));
    } catch (error) {
      throw new Error(`Failed to get multiple module info: ${error.message}`);
    }
  }

  // 获取所有模块信息（限制数量）
  async getAllModuleInfo(maxCount: number = 50): Promise<ModuleInfo[]> {
    try {
      const result = await this.registryContract.getAllModuleInfo(maxCount);
      return result.map((item: any) => ({
        key: item.key,
        addr: item.addr
      }));
    } catch (error) {
      throw new Error(`Failed to get all module info: ${error.message}`);
    }
  }

  // 分页获取模块信息
  async getModuleInfoPaginated(
    startIndex: number,
    count: number,
    maxTotalCount: number = 50
  ): Promise<PaginatedResult> {
    try {
      const result = await this.registryContract.getModuleInfoPaginated(startIndex, count, maxTotalCount);
      return {
        infos: result.infos.map((item: any) => ({
          key: item.key,
          addr: item.addr
        })),
        totalCount: result.totalCount,
        hasNext: result.hasNext,
        hasPrev: result.hasPrev
      };
    } catch (error) {
      throw new Error(`Failed to get paginated module info: ${error.message}`);
    }
  }

  // 获取模块统计信息
  async getModuleStatistics(maxCount: number = 50): Promise<{
    totalModules: number;
    registeredModules: number;
    unregisteredModules: number;
  }> {
    try {
      const result = await this.registryContract.getModuleStatistics(maxCount);
      return {
        totalModules: result.totalModules,
        registeredModules: result.registeredModules,
        unregisteredModules: result.unregisteredModules
      };
    } catch (error) {
      throw new Error(`Failed to get module statistics: ${error.message}`);
    }
  }

  // 批量检查模块注册状态
  async batchIsModuleRegistered(keys: string[]): Promise<boolean[]> {
    try {
      return await this.registryContract.batchIsModuleRegistered(keys);
    } catch (error) {
      throw new Error(`Failed to batch check module registration: ${error.message}`);
    }
  }
}
```

## 4. 使用示例

### 4.1 基础查询

```typescript
// 获取单个模块信息
const moduleInfo = await registryQuery.getModuleInfo('KEY_VAULT_CORE');

// 获取多个模块信息
const moduleInfos = await registryQuery.getMultipleModuleInfo([
  'KEY_VAULT_CORE',
  'KEY_COLLATERAL_MANAGER',
  'KEY_LENDING_ENGINE'
]);

// 获取所有模块信息（限制50个）
const allModules = await registryQuery.getAllModuleInfo(50);
```

### 4.2 分页查询

```typescript
// 分页获取模块信息
const result = await registryQuery.getModuleInfoPaginated(0, 20, 50);

console.log('模块信息:', result.infos);
console.log('总数量:', result.totalCount);
console.log('是否有下一页:', result.hasNext);
console.log('是否有上一页:', result.hasPrev);
```

### 4.3 统计查询

```typescript
// 获取模块统计信息
const stats = await registryQuery.getModuleStatistics(50);

console.log('总模块数:', stats.totalModules);
console.log('已注册模块数:', stats.registeredModules);
console.log('未注册模块数:', stats.unregisteredModules);
```

### 4.4 批量检查

```typescript
// 批量检查模块注册状态
const keys = ['KEY_VAULT_CORE', 'KEY_COLLATERAL_MANAGER', 'KEY_LENDING_ENGINE'];
const registrationStatus = await registryQuery.batchIsModuleRegistered(keys);

registrationStatus.forEach((isRegistered, index) => {
  console.log(`${keys[index]}: ${isRegistered ? '已注册' : '未注册'}`);
});
```

## 5. 最佳实践

### 5.1 参数选择

| 查询类型 | 推荐 maxCount | 原因 |
|----------|---------------|------|
| **单个模块** | 1 | Gas 消耗极低 |
| **小批量（<20个）** | 20 | 可控的 Gas 消耗 |
| **中等批量（20-50个）** | 50 | 平衡性能和成本 |
| **大数据量** | 避免使用 | 考虑链下查询 |

### 5.2 错误处理

```typescript
try {
  const modules = await registryQuery.getAllModuleInfo(50);
  // 处理成功结果
} catch (error) {
  if (error.message.includes('Gas limit exceeded')) {
    // 降级到更小的查询数量
    const modules = await registryQuery.getAllModuleInfo(20);
  } else {
    // 处理其他错误
    console.error('查询失败:', error.message);
  }
}
```

### 5.3 性能优化

1. **缓存策略**：对频繁查询的数据进行缓存
2. **批量查询**：使用 `getMultipleModuleInfo` 减少调用次数
3. **参数限制**：根据实际需求选择合适的 `maxCount` 参数
4. **降级策略**：大查询失败时自动降级到小查询

## 6. 总结

通过 View 函数优化，我们实现了：

1. **Gas 消耗控制**：通过参数限制避免高 Gas 消耗
2. **结构化数据**：使用 `ModuleInfo` 和 `PaginatedResult` 提供清晰的数据结构
3. **向后兼容**：保持原有接口的同时提供新的优化功能
4. **前端友好**：提供完整的 TypeScript 集成方案
5. **性能优化**：支持批量查询和分页查询

这个方案既解决了 Gas 成本问题，又保持了良好的用户体验和系统可扩展性。所有查询都通过 view 函数实现，无需额外的链下服务，简化了架构复杂度。

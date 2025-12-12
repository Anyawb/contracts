# Registry 分页查询优化方案

## 问题分析

`getModuleInfoPaginated` 函数存在高 Gas 消耗问题：

```solidity
function getModuleInfoPaginated(
    uint256 offset,
    uint256 limit,
    uint256 maxTotalCount
) internal view returns (ModuleInfo[] memory infos, uint256 totalCount)
```

### Gas 消耗原因
1. **遍历所有模块键**：需要遍历 `ModuleKeys.getAllKeys()` 返回的所有键
2. **多次存储访问**：每个键都需要访问 `RegistryStorage.layout().modules[key]`
3. **分页计算**：需要计算偏移量和限制范围
4. **结构体创建**：动态创建 `ModuleInfo[]` 数组

## 解决方案

### 方案A：链下索引 + REST API（推荐）

#### 1. 链下索引服务

```typescript
// scripts/indexers/registryPaginatedIndexer.ts
import { ethers } from 'ethers';
import { Registry__factory } from '../types/factories/Registry__factory';

export class RegistryPaginatedIndexer {
  private provider: ethers.Provider;
  private registryContract: Registry;
  private db: Database;

  constructor(
    provider: ethers.Provider,
    registryAddress: string,
    db: Database
  ) {
    this.provider = provider;
    this.registryContract = Registry__factory.connect(registryAddress, provider);
    this.db = db;
  }

  // 监听模块事件并更新索引
  async listenToModuleEvents(): Promise<void> {
    const filter = this.registryContract.filters.ModuleRegistered();
    
    this.provider.on(filter, async (key, module, timestamp) => {
      await this.handleModuleRegistered(key, module, timestamp);
    });
  }

  // 处理模块注册事件
  private async handleModuleRegistered(
    key: string, 
    module: string, 
    timestamp: number
  ): Promise<void> {
    await this.db.insert('modules', {
      key,
      address: module,
      isRegistered: true,
      registeredAt: new Date(timestamp * 1000),
      updatedAt: new Date()
    });
  }

  // 分页获取模块信息（链下）
  async getModuleInfoPaginated(
    offset: number,
    limit: number,
    maxTotalCount?: number
  ): Promise<{
    infos: ModuleInfo[];
    totalCount: number;
    hasNext: boolean;
    hasPrev: boolean;
  }> {
    const query = `
      SELECT key, address, registered_at, updated_at
      FROM modules 
      WHERE is_registered = true
      ORDER BY registered_at DESC
      LIMIT $1 OFFSET $2
    `;
    
    const countQuery = `
      SELECT COUNT(*) as total
      FROM modules 
      WHERE is_registered = true
    `;
    
    const [dataResult, countResult] = await Promise.all([
      this.db.query(query, [limit, offset]),
      this.db.query(countQuery)
    ]);
    
    const totalCount = countResult[0].total;
    const hasNext = offset + limit < totalCount;
    const hasPrev = offset > 0;
    
    return {
      infos: dataResult.map(row => ({
        key: row.key,
        addr: row.address
      })),
      totalCount,
      hasNext,
      hasPrev
    };
  }
}
```

#### 2. REST API 服务

```typescript
// scripts/services/registryPaginatedService.ts
export class RegistryPaginatedService {
  constructor(private indexer: RegistryPaginatedIndexer) {}

  // 分页获取模块信息
  async getModuleInfoPaginated(
    offset: number = 0,
    limit: number = 20,
    maxTotalCount?: number
  ): Promise<PaginatedResult<ModuleInfo>> {
    try {
      const result = await this.indexer.getModuleInfoPaginated(offset, limit, maxTotalCount);
      
      return {
        data: result.infos,
        total: result.totalCount,
        offset,
        limit,
        hasNext: result.hasNext,
        hasPrev: result.hasPrev
      };
    } catch (error) {
      throw new Error(`Failed to get paginated module info: ${error.message}`);
    }
  }

  // 获取模块统计信息
  async getModuleStatistics(): Promise<ModuleStatistics> {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_modules,
          COUNT(CASE WHEN is_registered = true THEN 1 END) as registered_modules,
          COUNT(CASE WHEN is_registered = false THEN 1 END) as unregistered_modules
        FROM modules
      `;
      
      const result = await this.indexer.db.query(query);
      return result[0];
    } catch (error) {
      throw new Error(`Failed to get module statistics: ${error.message}`);
    }
  }
}
```

#### 3. Express.js API 路由

```typescript
// API 路由
app.get('/api/registry/modules/paginated', async (req, res) => {
  try {
    const { offset = 0, limit = 20, maxTotalCount } = req.query;
    const service = new RegistryPaginatedService(indexer);
    
    const result = await service.getModuleInfoPaginated(
      parseInt(offset as string),
      parseInt(limit as string),
      maxTotalCount ? parseInt(maxTotalCount as string) : undefined
    );
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/registry/modules/statistics', async (req, res) => {
  try {
    const service = new RegistryPaginatedService(indexer);
    const statistics = await service.getModuleStatistics();
    res.json(statistics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### 方案B：GraphQL 子图

```graphql
# 子图定义
type Module @entity {
  id: ID!
  key: String!
  address: String!
  isRegistered: Boolean!
  registeredAt: BigInt!
  updatedAt: BigInt!
}

# GraphQL 查询
query GetPaginatedModules($offset: Int!, $limit: Int!) {
  modules(
    first: $limit
    skip: $offset
    where: { isRegistered: true }
    orderBy: registeredAt
    orderDirection: desc
  ) {
    id
    key
    address
    isRegistered
    registeredAt
  }
}

query GetModuleStatistics {
  modules {
    totalCount
    registeredCount: count(where: { isRegistered: true })
    unregisteredCount: count(where: { isRegistered: false })
  }
}
```

### 方案C：前端缓存 + 链上轻量级查询

```typescript
// 前端缓存服务
export class RegistryCacheService {
  private cache: Map<string, ModuleInfo[]> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5分钟

  constructor(
    private provider: ethers.Provider,
    private registryAddress: string
  ) {}

  // 获取分页模块信息（带缓存）
  async getModuleInfoPaginated(
    offset: number,
    limit: number
  ): Promise<PaginatedResult<ModuleInfo>> {
    const cacheKey = `modules_${offset}_${limit}`;
    const now = Date.now();
    
    // 检查缓存
    const cached = this.cache.get(cacheKey);
    const expiry = this.cacheExpiry.get(cacheKey);
    
    if (cached && expiry && now < expiry) {
      return {
        data: cached,
        total: cached.length,
        offset,
        limit,
        hasNext: false, // 简化处理
        hasPrev: offset > 0
      };
    }
    
    // 从链上获取（轻量级查询）
    const modules = await this.fetchModulesFromChain(offset, limit);
    
    // 更新缓存
    this.cache.set(cacheKey, modules);
    this.cacheExpiry.set(cacheKey, now + this.CACHE_DURATION);
    
    return {
      data: modules,
      total: modules.length,
      offset,
      limit,
      hasNext: modules.length === limit,
      hasPrev: offset > 0
    };
  }

  // 从链上获取模块信息（轻量级）
  private async fetchModulesFromChain(
    offset: number,
    limit: number
  ): Promise<ModuleInfo[]> {
    // 使用轻量级的链上查询
    const contract = new ethers.Contract(
      this.registryAddress,
      REGISTRY_ABI,
      this.provider
    );
    
    // 获取所有模块键（限制数量）
    const allKeys = await contract.getAllRegisteredModuleKeys(limit * 2); // 获取更多以支持分页
    
    const modules: ModuleInfo[] = [];
    for (let i = offset; i < Math.min(offset + limit, allKeys.length); i++) {
      const key = allKeys[i];
      const addr = await contract.getModule(key);
      if (addr !== ethers.ZeroAddress) {
        modules.push({ key, addr });
      }
    }
    
    return modules;
  }
}
```

## 前端集成示例

### React Hook

```typescript
// hooks/useRegistryPaginated.ts
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';

interface ModuleInfo {
  key: string;
  addr: string;
}

interface PaginatedResult<T> {
  data: T[];
  total: number;
  offset: number;
  limit: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export const useRegistryPaginated = (registryAddress: string) => {
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState({
    offset: 0,
    limit: 20,
    total: 0,
    hasNext: false,
    hasPrev: false
  });

  const getModuleInfoPaginated = async (
    offset: number = 0,
    limit: number = 20
  ) => {
    setLoading(true);
    setError(null);
    
    try {
      // 优先使用链下 API
      const response = await fetch(
        `/api/registry/modules/paginated?offset=${offset}&limit=${limit}`
      );
      
      if (response.ok) {
        const result: PaginatedResult<ModuleInfo> = await response.json();
        setModules(result.data);
        setPagination({
          offset: result.offset,
          limit: result.limit,
          total: result.total,
          hasNext: result.hasNext,
          hasPrev: result.hasPrev
        });
      } else {
        // 降级到链上查询
        const provider = new ethers.BrowserProvider(window.ethereum);
        const contract = new ethers.Contract(
          registryAddress,
          REGISTRY_ABI,
          provider
        );
        
        const result = await contract.getModuleInfoPaginated(offset, limit);
        setModules(result.infos);
        setPagination({
          offset,
          limit,
          total: result.totalCount,
          hasNext: offset + limit < result.totalCount,
          hasPrev: offset > 0
        });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const nextPage = () => {
    if (pagination.hasNext) {
      getModuleInfoPaginated(pagination.offset + pagination.limit, pagination.limit);
    }
  };

  const prevPage = () => {
    if (pagination.hasPrev) {
      getModuleInfoPaginated(Math.max(0, pagination.offset - pagination.limit), pagination.limit);
    }
  };

  return {
    modules,
    loading,
    error,
    pagination,
    getModuleInfoPaginated,
    nextPage,
    prevPage
  };
};
```

### Vue Composable

```typescript
// composables/useRegistryPaginated.ts
import { ref, computed } from 'vue';
import { ethers } from 'ethers';

export const useRegistryPaginated = (registryAddress: string) => {
  const modules = ref<ModuleInfo[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const pagination = ref({
    offset: 0,
    limit: 20,
    total: 0,
    hasNext: false,
    hasPrev: false
  });

  const getModuleInfoPaginated = async (offset = 0, limit = 20) => {
    loading.value = true;
    error.value = null;
    
    try {
      const response = await fetch(
        `/api/registry/modules/paginated?offset=${offset}&limit=${limit}`
      );
      
      if (response.ok) {
        const result = await response.json();
        modules.value = result.data;
        pagination.value = {
          offset: result.offset,
          limit: result.limit,
          total: result.total,
          hasNext: result.hasNext,
          hasPrev: result.hasPrev
        };
      } else {
        // 降级到链上查询
        const provider = new ethers.BrowserProvider(window.ethereum);
        const contract = new ethers.Contract(
          registryAddress,
          REGISTRY_ABI,
          provider
        );
        
        const result = await contract.getModuleInfoPaginated(offset, limit);
        modules.value = result.infos;
        pagination.value = {
          offset,
          limit,
          total: result.totalCount,
          hasNext: offset + limit < result.totalCount,
          hasPrev: offset > 0
        };
      }
    } catch (err) {
      error.value = err.message;
    } finally {
      loading.value = false;
    }
  };

  const nextPage = () => {
    if (pagination.value.hasNext) {
      getModuleInfoPaginated(
        pagination.value.offset + pagination.value.limit,
        pagination.value.limit
      );
    }
  };

  const prevPage = () => {
    if (pagination.value.hasPrev) {
      getModuleInfoPaginated(
        Math.max(0, pagination.value.offset - pagination.value.limit),
        pagination.value.limit
      );
    }
  };

  return {
    modules,
    loading,
    error,
    pagination,
    getModuleInfoPaginated,
    nextPage,
    prevPage
  };
};
```

## 推荐实施策略

### 阶段1：基础架构（1周）
- [ ] 设置数据库和索引服务
- [ ] 实现基础事件监听
- [ ] 创建 REST API 服务

### 阶段2：前端集成（1周）
- [ ] 实现 React Hook 和 Vue Composable
- [ ] 添加缓存机制
- [ ] 实现降级策略

### 阶段3：优化和监控（1周）
- [ ] 性能优化和压力测试
- [ ] 添加监控和告警
- [ ] 完善错误处理

这样，您就可以在保持链上函数完整性的同时，提供高效的链下查询服务，大大降低 Gas 消耗并提升用户体验！

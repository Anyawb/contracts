# 🎯 前端应用查询示例

## �� 实际应用中的查询方式

### **架构说明**

我们的系统采用**事件驱动架构**，而非传统的链上缓存方案：

```
用户操作 → 业务合约 → Registry查询 → 发出事件 → 数据库实时收集 → View层提供查询
```

**优势对比：**
- ✅ **事件驱动**：Gas费用更低，实时性更好，架构更简洁
- ❌ **链上缓存**：Gas浪费，复杂性高，同步困难

### **1. 使用 Web3.js/ethers.js 直接查询**

```javascript
// 前端查询示例
import { ethers } from 'ethers';
import VaultViewABI from './abis/VaultView.json';

class VaultViewClient {
    constructor(contractAddress, provider) {
        this.contract = new ethers.Contract(contractAddress, VaultViewABI, provider);
    }

    // 获取用户完整状态（实时查询，无缓存）
    async getUserCompleteStatus(userAddress, assetAddress) {
        try {
            const result = await this.contract.getUserPosition(userAddress, assetAddress);
            return {
                collateral: result[0],
                debt: result[1],
                healthFactor: result[2],
                riskLevel: result[3],
                lastUpdated: new Date().toISOString() // 实时数据
            };
        } catch (error) {
            console.error('查询用户状态失败:', error);
            throw error;
        }
    }

    // 批量获取用户状态（优化版本，实时查询）
    async batchGetUserCompleteStatus(users, assets) {
        try {
            const result = await this.contract.batchGetUserCompleteStatus(users, assets);
            return {
                positions: result[0],
                healthFactors: result[1],
                riskLevels: result[2],
                queryTime: new Date().toISOString(),
                dataSource: 'real-time' // 明确标识数据来源
            };
        } catch (error) {
            console.error('批量查询失败:', error);
            throw error;
        }
    }

    // 获取系统状态（实时查询）
    async getSystemStatus(assets) {
        try {
            const result = await this.contract.batchGetSystemStatus(assets);
            return {
                totalCollaterals: result[0],
                totalDebts: result[1],
                prices: result[2],
                capsRemaining: result[3],
                lastUpdated: new Date().toISOString(),
                dataSource: 'real-time'
            };
        } catch (error) {
            console.error('查询系统状态失败:', error);
            throw error;
        }
    }

    // 预览操作（实时计算，无缓存）
    async previewOperations(operations) {
        try {
            const results = await this.contract.batchPreviewOperations(operations);
            return results.map(result => ({
                newHealthFactor: result.newHealthFactor,
                newLTV: result.newLTV,
                isSafe: result.isSafe,
                maxBorrowable: result.maxBorrowable,
                calculationTime: new Date().toISOString()
            }));
        } catch (error) {
            console.error('预览操作失败:', error);
            throw error;
        }
    }

    // 获取模块地址（直接查询Registry）
    async getModuleAddress(moduleKey) {
        try {
            const address = await this.contract.getModuleAddress(moduleKey);
            return {
                moduleKey,
                address,
                queryTime: new Date().toISOString(),
                dataSource: 'registry-direct'
            };
        } catch (error) {
            console.error('获取模块地址失败:', error);
            throw error;
        }
    }

    // 获取用户操作历史（从数据库）
    async getUserHistory(userAddress, limit = 50) {
        try {
            const history = await this.contract.getUserOperationHistory(userAddress, limit);
            return {
                operations: history.operations,
                totalCount: history.totalCount,
                queryTime: new Date().toISOString(),
                dataSource: 'database-history'
            };
        } catch (error) {
            console.error('获取用户历史失败:', error);
            throw error;
        }
    }
}

// 使用示例
const provider = new ethers.providers.Web3Provider(window.ethereum);
const vaultView = new VaultViewClient('0x...', provider);

// 查询单个用户状态（实时）
const userStatus = await vaultView.getUserCompleteStatus(
    '0x1234...', 
    '0x5678...'
);

// 批量查询多个用户（实时）
const batchStatus = await vaultView.batchGetUserCompleteStatus(
    ['0x1234...', '0x5678...'],
    ['0xabcd...', '0xefgh...']
);

// 获取模块地址（直接查询Registry）
const moduleAddress = await vaultView.getModuleAddress('COLLATERAL_MANAGER');
```

### **2. 使用 React Hook 封装**

```javascript
// React Hook 示例
import { useState, useEffect } from 'react';
import { useContract, useProvider } from 'wagmi';

export function useVaultView(contractAddress) {
    const provider = useProvider();
    const contract = useContract({
        address: contractAddress,
        abi: VaultViewABI,
        signerOrProvider: provider,
    });

    const [userStatus, setUserStatus] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [dataSource, setDataSource] = useState('real-time');

    // 查询用户状态（实时）
    const getUserStatus = async (userAddress, assetAddress) => {
        setLoading(true);
        setError(null);
        
        try {
            const result = await contract.getUserPosition(userAddress, assetAddress);
            setUserStatus({
                collateral: result[0],
                debt: result[1],
                healthFactor: result[2],
                riskLevel: result[3],
                lastUpdated: new Date().toISOString()
            });
            setDataSource('real-time');
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    // 批量查询（实时）
    const batchGetUserStatus = async (users, assets) => {
        setLoading(true);
        setError(null);
        
        try {
            const result = await contract.batchGetUserCompleteStatus(users, assets);
            const response = {
                positions: result[0],
                healthFactors: result[1],
                riskLevels: result[2],
                queryTime: new Date().toISOString(),
                dataSource: 'real-time'
            };
            setDataSource('real-time');
            return response;
        } catch (err) {
            setError(err.message);
            throw err;
        } finally {
            setLoading(false);
        }
    };

    // 获取历史数据（从数据库）
    const getHistoryData = async (userAddress, limit = 50) => {
        setLoading(true);
        setError(null);
        
        try {
            const history = await contract.getUserOperationHistory(userAddress, limit);
            const response = {
                operations: history.operations,
                totalCount: history.totalCount,
                queryTime: new Date().toISOString(),
                dataSource: 'database-history'
            };
            setDataSource('database-history');
            return response;
        } catch (err) {
            setError(err.message);
            throw err;
        } finally {
            setLoading(false);
        }
    };

    return {
        userStatus,
        loading,
        error,
        dataSource,
        getUserStatus,
        batchGetUserStatus,
        getHistoryData
    };
}

// 在组件中使用
function UserDashboard({ userAddress, assetAddress }) {
    const { userStatus, loading, error, dataSource, getUserStatus } = useVaultView('0x...');

    useEffect(() => {
        if (userAddress && assetAddress) {
            getUserStatus(userAddress, assetAddress);
        }
    }, [userAddress, assetAddress]);

    if (loading) return <div>实时查询中...</div>;
    if (error) return <div>错误: {error}</div>;

    return (
        <div>
            <h2>用户状态</h2>
            <p>抵押: {userStatus?.collateral}</p>
            <p>债务: {userStatus?.debt}</p>
            <p>健康因子: {userStatus?.healthFactor}</p>
            <p>风险等级: {userStatus?.riskLevel}</p>
            <p>数据来源: {dataSource === 'real-time' ? '实时查询' : '历史数据库'}</p>
            <p>更新时间: {userStatus?.lastUpdated}</p>
        </div>
    );
}
```

### **3. 使用 GraphQL 查询**

```javascript
// GraphQL 查询示例
import { gql, useQuery } from '@apollo/client';

const GET_USER_STATUS = gql`
  query GetUserStatus($userAddress: String!, $assetAddress: String!) {
    userPosition(userAddress: $userAddress, assetAddress: $assetAddress) {
      collateral
      debt
      healthFactor
      riskLevel
      lastUpdated
      dataSource
    }
  }
`;

const GET_SYSTEM_STATUS = gql`
  query GetSystemStatus($assets: [String!]!) {
    systemStatus(assets: $assets) {
      totalCollaterals
      totalDebts
      prices
      capsRemaining
      lastUpdated
      dataSource
    }
  }
`;

const GET_USER_HISTORY = gql`
  query GetUserHistory($userAddress: String!, $limit: Int!) {
    userHistory(userAddress: $userAddress, limit: $limit) {
      operations {
        type
        amount
        timestamp
        transactionHash
      }
      totalCount
      dataSource
    }
  }
`;

function UserStatusGraphQL({ userAddress, assetAddress }) {
    const { loading, error, data } = useQuery(GET_USER_STATUS, {
        variables: { userAddress, assetAddress }
    });

    if (loading) return <div>实时查询中...</div>;
    if (error) return <div>错误: {error.message}</div>;

    return (
        <div>
            <h2>用户状态 (GraphQL)</h2>
            <p>抵押: {data.userPosition.collateral}</p>
            <p>债务: {data.userPosition.debt}</p>
            <p>健康因子: {data.userPosition.healthFactor}</p>
            <p>数据来源: {data.userPosition.dataSource}</p>
            <p>更新时间: {data.userPosition.lastUpdated}</p>
        </div>
    );
}
```

### **4. 使用 REST API 查询**

```javascript
// REST API 查询示例
class VaultViewAPI {
    constructor(baseURL) {
        this.baseURL = baseURL;
    }

    // 获取用户状态（实时）
    async getUserStatus(userAddress, assetAddress) {
        const response = await fetch(
            `${this.baseURL}/user/status?user=${userAddress}&asset=${assetAddress}&source=real-time`
        );
        return response.json();
    }

    // 批量获取用户状态（实时）
    async batchGetUserStatus(users, assets) {
        const response = await fetch(`${this.baseURL}/user/batch-status`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                users, 
                assets,
                source: 'real-time'
            })
        });
        return response.json();
    }

    // 获取系统状态（实时）
    async getSystemStatus(assets) {
        const response = await fetch(
            `${this.baseURL}/system/status?assets=${assets.join(',')}&source=real-time`
        );
        return response.json();
    }

    // 预览操作（实时计算）
    async previewOperations(operations) {
        const response = await fetch(`${this.baseURL}/preview/operations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                operations,
                source: 'real-time-calculation'
            })
        });
        return response.json();
    }

    // 获取用户历史（从数据库）
    async getUserHistory(userAddress, limit = 50) {
        const response = await fetch(
            `${this.baseURL}/user/history?user=${userAddress}&limit=${limit}&source=database`
        );
        return response.json();
    }

    // 获取模块地址（直接查询Registry）
    async getModuleAddress(moduleKey) {
        const response = await fetch(
            `${this.baseURL}/module/address?key=${moduleKey}&source=registry-direct`
        );
        return response.json();
    }
}

// 使用示例
const api = new VaultViewAPI('https://api.vault.com');

// 查询用户状态（实时）
const userStatus = await api.getUserStatus('0x1234...', '0x5678...');

// 批量查询（实时）
const batchStatus = await api.batchGetUserStatus(
    ['0x1234...', '0x5678...'],
    ['0xabcd...', '0xefgh...']
);

// 获取历史数据（从数据库）
const userHistory = await api.getUserHistory('0x1234...', 100);
```

## 🔄 **查询方式对比**

| 查询方式 | 优点 | 缺点 | 适用场景 | 数据来源 |
|---------|------|------|----------|----------|
| **浏览器查询** | 简单直观，无需编程 | 功能有限，性能较低 | 简单查看，调试 | 实时查询 |
| **View 合约** | 高性能，功能强大，实时性 | 需要编程知识 | 应用集成，批量查询 | 实时查询 |
| **REST API** | 标准化，易于集成 | 需要后端服务 | 传统应用集成 | 实时+历史 |
| **GraphQL** | 灵活查询，类型安全 | 学习成本高 | 复杂数据查询 | 实时+历史 |

## 🎯 **推荐使用场景**

### **1. 开发阶段**
- 使用浏览器查询进行调试和验证
- 使用 View 合约进行功能测试
- 验证事件驱动架构的正确性

### **2. 生产环境**
- 前端应用使用 View 合约进行实时查询
- 后台系统使用 REST API 进行数据同步
- 复杂分析使用 GraphQL 进行灵活查询
- 历史数据分析使用数据库查询

### **3. 监控和告警**
- 使用 View 合约的批量查询功能
- 基于事件数据进行实时监控
- 实现智能告警和风险预警

### **4. AI 分析场景**
- 实时数据用于即时决策
- 历史数据用于模式识别
- 事件数据用于行为分析
- 向量化数据用于语义搜索

## 🚀 **事件驱动架构优势**

### **Gas 优化**
- ✅ 无需链上缓存存储
- ✅ 无需缓存时间戳管理
- ✅ 减少存储操作成本
- ✅ 优化合约执行效率

### **实时性保证**
- ✅ 数据始终是最新的
- ✅ 无需等待缓存过期
- ✅ 事件实时触发
- ✅ 数据库实时收集

### **架构简洁性**
- ✅ 业务逻辑更清晰
- ✅ 减少复杂性
- ✅ 易于维护和升级
- ✅ 更好的可扩展性

### **AI 友好**
- ✅ 完整的事件历史
- ✅ 实时数据流
- ✅ 便于模式识别
- ✅ 支持智能分析

这样，你就可以根据不同的使用场景选择最合适的查询方式，同时享受事件驱动架构带来的所有优势！🎉 
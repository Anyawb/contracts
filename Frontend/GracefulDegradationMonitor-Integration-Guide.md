# 优雅降级监控前端集成指南

## 📋 概述

优雅降级监控（Graceful Degradation Monitor）是 RWA Lending Platform 的核心健康管理模块，用于监控和管理系统中各个模块的健康状态。当某个模块出现问题时，系统不会完全崩溃，而是使用备用策略继续运行。

本文档为前端工程师提供完整的集成指南，包括 API 接口、使用模式、最佳实践和代码示例。

## 🎯 核心概念

### 什么是优雅降级？

优雅降级是一种系统设计模式，当系统的某个组件出现故障时，系统不会完全停止工作，而是：
- 使用备用策略继续运行
- 记录故障事件用于分析
- 提供降级后的功能服务
- 监控系统健康状态

### 监控模块的作用

1. **健康状态监控**：实时监控各个模块的健康状态
2. **降级事件记录**：记录系统降级事件和原因
3. **统计分析**：提供降级趋势和统计信息
4. **历史记录**：保存降级历史用于分析

## 🔧 API 接口文档

### 1. 健康状态查询

#### 获取优雅降级统计信息
```typescript
interface GracefulDegradationStats {
  totalDegradations: number;        // 总降级次数
  lastDegradationTime: number;      // 最后降级时间
  lastDegradedModule: string;       // 最后降级的模块地址
  lastDegradationReason: string;    // 最后降级原因
  fallbackValueUsed: number;        // 使用的降级值
  totalFallbackValue: number;       // 总降级值
  averageFallbackValue: number;     // 平均降级值
}

// 调用示例
const stats = await healthView.getGracefulDegradationStats();
console.log('总降级次数:', stats.totalDegradations);
console.log('最后降级时间:', new Date(stats.lastDegradationTime * 1000));
```

#### 检查模块健康状态
```typescript
interface ModuleHealthStatus {
  module: string;                   // 模块地址
  isHealthy: boolean;               // 是否健康
  details: string;                  // 详细信息
  lastCheckTime: number;            // 最后检查时间
  consecutiveFailures: number;      // 连续失败次数
  totalChecks: number;              // 总检查次数
  successRate: number;              // 成功率
}

// 调用示例
const healthStatus = await healthView.getModuleHealthStatus(moduleAddress);
if (!healthStatus.isHealthy) {
  console.log('模块不健康:', healthStatus.details);
  console.log('连续失败次数:', healthStatus.consecutiveFailures);
}
```

### 2. 历史记录查询

#### 获取系统降级历史
```typescript
interface DegradationEvent {
  module: string;                   // 模块地址
  reason: string;                   // 降级原因
  fallbackValue: number;            // 降级值
  usedFallback: boolean;            // 是否使用了降级策略
  timestamp: number;                // 时间戳
  blockNumber: number;              // 区块号
}

// 调用示例
const history = await healthView.getSystemDegradationHistory(10); // 获取最近10条记录
history.forEach(event => {
  console.log('模块:', event.module);
  console.log('原因:', event.reason);
  console.log('时间:', new Date(event.timestamp * 1000));
});
```

#### 获取降级趋势分析
```typescript
// 调用示例
const trends = await healthView.getSystemDegradationTrends();
console.log('总事件数:', trends.totalEvents);
console.log('最近24小时事件数:', trends.recentEvents);
console.log('最频繁降级的模块:', trends.mostFrequentModule);
console.log('平均降级值:', trends.averageFallbackValue);
```

## 🚀 前端集成示例

### 1. React Hook 封装

```typescript
// hooks/useGracefulDegradation.ts
import { useState, useEffect } from 'react';
import { useContract } from './useContract';

export const useGracefulDegradation = () => {
  const [stats, setStats] = useState<GracefulDegradationStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const healthView = useContract('HealthView');

  const fetchStats = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await healthView.getGracefulDegradationStats();
      setStats(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const checkModuleHealth = async (moduleAddress: string) => {
    try {
      const healthStatus = await healthView.getModuleHealthStatus(moduleAddress);
      return healthStatus;
    } catch (err) {
      throw new Error(`健康检查失败: ${err.message}`);
    }
  };

  const getDegradationHistory = async (limit: number = 10) => {
    try {
      return await healthView.getSystemDegradationHistory(limit);
    } catch (err) {
      throw new Error(`获取历史记录失败: ${err.message}`);
    }
  };

  const getDegradationTrends = async () => {
    try {
      return await healthView.getSystemDegradationTrends();
    } catch (err) {
      throw new Error(`获取趋势分析失败: ${err.message}`);
    }
  };

  useEffect(() => {
    fetchStats();
    // 每5分钟刷新一次
    const interval = setInterval(fetchStats, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return {
    stats,
    isLoading,
    error,
    checkModuleHealth,
    getDegradationHistory,
    getDegradationTrends,
    refreshStats: fetchStats,
  };
};
```

### 2. 健康状态监控组件

```typescript
// components/SystemHealthMonitor.tsx
import React, { useState, useEffect } from 'react';
import { useGracefulDegradation } from '../hooks/useGracefulDegradation';

interface SystemHealthMonitorProps {
  criticalModules: string[];
  onModuleUnhealthy?: (module: string, details: string) => void;
}

export const SystemHealthMonitor: React.FC<SystemHealthMonitorProps> = ({
  criticalModules,
  onModuleUnhealthy,
}) => {
  const { stats, checkModuleHealth, isLoading } = useGracefulDegradation();
  const [moduleHealth, setModuleHealth] = useState<Record<string, boolean>>({});

  const checkAllModules = async () => {
    const healthStatus: Record<string, boolean> = {};
    
    for (const module of criticalModules) {
      try {
        const status = await checkModuleHealth(module);
        healthStatus[module] = status.isHealthy;
        
        if (!status.isHealthy && onModuleUnhealthy) {
          onModuleUnhealthy(module, status.details);
        }
      } catch (error) {
        healthStatus[module] = false;
        console.error(`检查模块 ${module} 健康状态失败:`, error);
      }
    }
    
    setModuleHealth(healthStatus);
  };

  useEffect(() => {
    checkAllModules();
    // 每30秒检查一次
    const interval = setInterval(checkAllModules, 30 * 1000);
    return () => clearInterval(interval);
  }, [criticalModules]);

  if (isLoading) {
    return <div>正在检查系统健康状态...</div>;
  }

  return (
    <div className="system-health-monitor">
      <h3>系统健康状态</h3>
      
      {/* 总体统计 */}
      {stats && (
        <div className="stats-summary">
          <p>总降级次数: {stats.totalDegradations}</p>
          <p>最后降级时间: {new Date(stats.lastDegradationTime * 1000).toLocaleString()}</p>
          <p>平均降级值: {stats.averageFallbackValue}</p>
        </div>
      )}
      
      {/* 模块健康状态 */}
      <div className="module-health">
        <h4>关键模块状态</h4>
        {criticalModules.map(module => (
          <div key={module} className={`module-status ${moduleHealth[module] ? 'healthy' : 'unhealthy'}`}>
            <span>{module}</span>
            <span>{moduleHealth[module] ? '✅ 健康' : '❌ 异常'}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
```

### 3. 降级历史记录组件

```typescript
// components/DegradationHistory.tsx
import React, { useState, useEffect } from 'react';
import { useGracefulDegradation } from '../hooks/useGracefulDegradation';

export const DegradationHistory: React.FC = () => {
  const { getDegradationHistory } = useGracefulDegradation();
  const [history, setHistory] = useState<DegradationEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchHistory = async () => {
    try {
      setIsLoading(true);
      const result = await getDegradationHistory(20); // 获取最近20条记录
      setHistory(result);
    } catch (error) {
      console.error('获取降级历史失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  if (isLoading) {
    return <div>正在加载降级历史...</div>;
  }

  return (
    <div className="degradation-history">
      <h3>降级历史记录</h3>
      <div className="history-list">
        {history.map((event, index) => (
          <div key={index} className="history-item">
            <div className="event-header">
              <span className="module">{event.module}</span>
              <span className="time">{new Date(event.timestamp * 1000).toLocaleString()}</span>
            </div>
            <div className="event-details">
              <p><strong>原因:</strong> {event.reason}</p>
              <p><strong>降级值:</strong> {event.fallbackValue}</p>
              <p><strong>使用降级策略:</strong> {event.usedFallback ? '是' : '否'}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
```

### 4. 趋势分析组件

```typescript
// components/DegradationTrends.tsx
import React, { useState, useEffect } from 'react';
import { useGracefulDegradation } from '../hooks/useGracefulDegradation';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export const DegradationTrends: React.FC = () => {
  const { getDegradationTrends } = useGracefulDegradation();
  const [trends, setTrends] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchTrends = async () => {
    try {
      setIsLoading(true);
      const result = await getDegradationTrends();
      setTrends(result);
    } catch (error) {
      console.error('获取趋势分析失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTrends();
    // 每小时刷新一次
    const interval = setInterval(fetchTrends, 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (isLoading) {
    return <div>正在加载趋势分析...</div>;
  }

  if (!trends) {
    return <div>暂无趋势数据</div>;
  }

  return (
    <div className="degradation-trends">
      <h3>降级趋势分析</h3>
      
      <div className="trends-summary">
        <div className="trend-item">
          <label>总事件数:</label>
          <span>{trends.totalEvents}</span>
        </div>
        <div className="trend-item">
          <label>最近24小时事件数:</label>
          <span>{trends.recentEvents}</span>
        </div>
        <div className="trend-item">
          <label>最频繁降级的模块:</label>
          <span>{trends.mostFrequentModule}</span>
        </div>
        <div className="trend-item">
          <label>平均降级值:</label>
          <span>{trends.averageFallbackValue}</span>
        </div>
      </div>
    </div>
  );
};
```

## 🎨 样式示例

```css
/* styles/gracefulDegradation.css */
.system-health-monitor {
  padding: 20px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #f9f9f9;
}

.stats-summary {
  margin-bottom: 20px;
  padding: 15px;
  background: white;
  border-radius: 6px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.module-health {
  margin-top: 20px;
}

.module-status {
  display: flex;
  justify-content: space-between;
  padding: 10px;
  margin: 5px 0;
  border-radius: 4px;
  background: white;
}

.module-status.healthy {
  border-left: 4px solid #4caf50;
}

.module-status.unhealthy {
  border-left: 4px solid #f44336;
}

.degradation-history {
  margin-top: 30px;
}

.history-item {
  margin: 10px 0;
  padding: 15px;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: white;
}

.event-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 10px;
  font-weight: bold;
}

.event-details p {
  margin: 5px 0;
  color: #666;
}

.degradation-trends {
  margin-top: 30px;
}

.trends-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 15px;
  margin-top: 20px;
}

.trend-item {
  padding: 15px;
  background: white;
  border-radius: 6px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.trend-item label {
  display: block;
  font-weight: bold;
  margin-bottom: 5px;
  color: #333;
}

.trend-item span {
  font-size: 1.2em;
  color: #2196f3;
}
```

## 🔧 使用模式

### 1. 实时监控模式

```typescript
// 在应用启动时初始化监控
const App: React.FC = () => {
  const criticalModules = [
    '0x1234...', // 价格预言机
    '0x5678...', // 清算引擎
    '0x9abc...', // 健康因子计算器
  ];

  const handleModuleUnhealthy = (module: string, details: string) => {
    // 显示告警通知
    showNotification({
      type: 'warning',
      title: '模块异常',
      message: `模块 ${module} 出现异常: ${details}`,
    });
  };

  return (
    <div>
      <SystemHealthMonitor
        criticalModules={criticalModules}
        onModuleUnhealthy={handleModuleUnhealthy}
      />
      {/* 其他应用组件 */}
    </div>
  );
};
```

### 2. 仪表板模式

```typescript
// 在管理仪表板中显示详细监控信息
const AdminDashboard: React.FC = () => {
  return (
    <div className="admin-dashboard">
      <h2>系统监控仪表板</h2>
      
      <div className="dashboard-grid">
        <div className="dashboard-card">
          <SystemHealthMonitor criticalModules={criticalModules} />
        </div>
        
        <div className="dashboard-card">
          <DegradationHistory />
        </div>
        
        <div className="dashboard-card">
          <DegradationTrends />
        </div>
      </div>
    </div>
  );
};
```

### 3. 告警模式

```typescript
// 设置告警阈值和通知
const useDegradationAlerts = () => {
  const { stats } = useGracefulDegradation();
  
  useEffect(() => {
    if (stats) {
      // 检查最近24小时降级次数
      const recentDegradations = stats.totalDegradations; // 简化示例
      
      if (recentDegradations > 10) {
        // 发送高优先级告警
        sendAlert({
          level: 'high',
          message: `系统降级频率过高: ${recentDegradations} 次`,
        });
      } else if (recentDegradations > 5) {
        // 发送中等优先级告警
        sendAlert({
          level: 'medium',
          message: `系统降级次数增加: ${recentDegradations} 次`,
        });
      }
    }
  }, [stats]);
};
```

## 🎯 最佳实践

### 1. 错误处理

```typescript
const useGracefulDegradationWithErrorHandling = () => {
  const { checkModuleHealth } = useGracefulDegradation();
  
  const safeCheckModuleHealth = async (moduleAddress: string) => {
    try {
      return await checkModuleHealth(moduleAddress);
    } catch (error) {
      console.error('健康检查失败:', error);
      // 返回默认健康状态
      return {
        isHealthy: false,
        details: '健康检查失败',
        lastCheckTime: Date.now(),
        consecutiveFailures: 1,
        totalChecks: 1,
        successRate: 0,
      };
    }
  };
  
  return { safeCheckModuleHealth };
};
```

### 2. 缓存策略

```typescript
const useCachedHealthData = () => {
  const [cachedData, setCachedData] = useState<Record<string, any>>({});
  const { checkModuleHealth } = useGracefulDegradation();
  
  const getCachedHealthStatus = async (moduleAddress: string) => {
    const cacheKey = `health_${moduleAddress}`;
    const cached = cachedData[cacheKey];
    
    // 如果缓存时间小于5分钟，使用缓存数据
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
      return cached.data;
    }
    
    // 获取新数据并缓存
    const healthStatus = await checkModuleHealth(moduleAddress);
    setCachedData(prev => ({
      ...prev,
      [cacheKey]: {
        data: healthStatus,
        timestamp: Date.now(),
      },
    }));
    
    return healthStatus;
  };
  
  return { getCachedHealthStatus };
};
```

### 3. 性能优化

```typescript
const useOptimizedHealthMonitoring = () => {
  const [healthData, setHealthData] = useState<Record<string, boolean>>({});
  const { checkModuleHealth } = useGracefulDegradation();
  
  // 批量检查模块健康状态
  const batchCheckHealth = async (modules: string[]) => {
    const promises = modules.map(async (module) => {
      try {
        const status = await checkModuleHealth(module);
        return { module, isHealthy: status.isHealthy };
      } catch (error) {
        return { module, isHealthy: false };
      }
    });
    
    const results = await Promise.all(promises);
    const healthMap = results.reduce((acc, { module, isHealthy }) => {
      acc[module] = isHealthy;
      return acc;
    }, {} as Record<string, boolean>);
    
    setHealthData(healthMap);
  };
  
  return { healthData, batchCheckHealth };
};
```

## 📊 监控指标

### 关键指标

1. **降级频率**：单位时间内的降级次数
2. **模块健康率**：健康模块占总模块的比例
3. **平均降级值**：降级时使用的平均备用值
4. **最频繁降级模块**：需要重点关注的模块

### 告警阈值

```typescript
const ALERT_THRESHOLDS = {
  HIGH_DEGRADATION_FREQUENCY: 10,    // 24小时内超过10次降级
  MODULE_HEALTH_RATE: 0.8,           // 模块健康率低于80%
  CONSECUTIVE_FAILURES: 3,           // 连续失败超过3次
};
```

## 🔗 与其他模块集成

### 与价格预言机集成

```typescript
const usePriceOracleWithDegradation = () => {
  const { recordDegradationEvent } = useGracefulDegradation();
  
  const getPriceWithFallback = async (asset: string) => {
    try {
      const price = await priceOracle.getPrice(asset);
      return price;
    } catch (error) {
      // 记录降级事件
      await recordDegradationEvent(
        priceOracle.address,
        'Price oracle timeout',
        getFallbackPrice(asset),
        true
      );
      return getFallbackPrice(asset);
    }
  };
  
  return { getPriceWithFallback };
};
```

### 与清算引擎集成

```typescript
const useLiquidationEngineWithDegradation = () => {
  const { recordDegradationEvent } = useGracefulDegradation();
  
  const liquidateWithFallback = async (user: string) => {
    try {
      await liquidationEngine.liquidate(user);
      return { success: true };
    } catch (error) {
      // 记录降级事件
      await recordDegradationEvent(
        liquidationEngine.address,
        'Liquidation failed',
        0,
        false
      );
      
      // 使用备用清算策略
      return await emergencyLiquidation(user);
    }
  };
  
  return { liquidateWithFallback };
};
```

## 📝 总结

优雅降级监控模块为前端提供了强大的系统健康管理能力。通过合理使用这些 API 和组件，前端工程师可以：

1. **实时监控**系统各个模块的健康状态
2. **记录和分析**降级事件，了解系统稳定性
3. **提供备用策略**，确保系统在部分模块故障时仍能运行
4. **可视化展示**系统健康状态和趋势分析

通过本文档提供的集成指南，前端工程师可以轻松地将优雅降级监控功能集成到应用中，为用户提供更好的系统稳定性和用户体验。

---

**文档版本**: v1.0  
**最后更新**: 2025年8月  
**维护者**: RWA Lending Platform 开发团队 
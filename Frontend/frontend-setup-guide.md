# 🚀 RWA 借贷平台前端搭建指南

## 📋 概述

本指南将帮助你搭建一个基于 AI 驱动的现代化 RWA 借贷平台前端，集成 **DeepSeek R1 模型**、向量化数据库、多 Agent 系统、自动执行链等先进技术。

> **技术栈亮点**：
> - 🧠 **AI 驱动**：DeepSeek R1 + 向量搜索 + 多 Agent 系统
> - 🔍 **智能查询**：语义搜索 + 上下文理解
> - 🤖 **自动执行**：任务链 + 智能决策
> - ☁️ **云原生**：AWS + 容器化部署
> - 🔐 **安全可靠**：企业级安全架构
> - ⚡ **事件驱动**：实时数据流 + 无缓存架构

---

## 🏗️ 系统架构总览

```mermaid
graph TB
    %% 用户端与触发层
    subgraph "User Layer"
        U1[🧑 用户]
        U2[🔗 链上事件]
        U3[📈 数据触发器]
    end

    %% 查询入口和语言处理
    subgraph "Intent Layer"
        DeepSeek[🧠 DeepSeek R1 (指令解析器)]
        Embedder[🔍 嵌入服务 (DeepSeek/OpenAI)]
        VectorSearch[📚 向量搜索 Milvus]
        ContextStore[(🗂️ 上下文缓存 Redis)]
    end

    %% 多Agent系统
    subgraph "Multi-Agent Orchestrator"
        Agent1[📊 分析 Agent]
        Agent2[🛡️ 风控 Agent]
        Agent3[🤖 执行 Agent]
        Agent4[📄 报告 Agent]
        Agent5[🔍 安全 Agent]
    end

    %% 自动执行链控制器
    subgraph "Execution Chain Engine"
        TaskPlanner[🧩 LangGraph/CrewAI 任务链]
        ChainMemory[(🧠 共享上下文)]
        Executor[⚙️ 执行器 (脚本/API/合约)]
    end

    %% 存储层
    subgraph "Storage & Model Layer"
        Milvus[(Milvus 向量数据库)]
        PostgreSQL[(PostgreSQL/RDS 数据库)]
        ChainData[(📦 链上数据存储)]
        S3[(S3/MinIO 文本备份)]
    end

    %% 事件驱动数据流
    subgraph "Event-Driven Data Flow"
        EventListener[👂 事件监听器]
        EventProcessor[⚙️ 事件处理器]
        RealTimeDB[(🔄 实时数据库)]
    end

    %% 用户与入口连接
    U1 --> DeepSeek
    U2 --> EventListener
    U3 --> EventListener

    %% 事件处理流程
    EventListener --> EventProcessor
    EventProcessor --> RealTimeDB
    RealTimeDB --> PostgreSQL

    %% 检索增强流程
    DeepSeek --> Embedder --> VectorSearch --> Milvus
    VectorSearch --> ContextStore
    ContextStore --> DeepSeek

    %% 多Agent处理层
    DeepSeek --> Agent1
    DeepSeek --> Agent5
    Agent1 --> Agent2
    Agent2 --> Agent3
    Agent3 --> Agent4

    %% Agent 与执行链联动
    Agent1 --> TaskPlanner
    Agent2 --> TaskPlanner
    Agent3 --> TaskPlanner
    Agent4 --> TaskPlanner
    Agent5 --> TaskPlanner

    TaskPlanner --> ChainMemory
    ChainMemory --> Executor

    %% 执行器访问数据库与链
    Executor --> PostgreSQL
    Executor --> ChainData
    Executor --> Milvus
    Executor --> RealTimeDB
```

---

## 🚀 事件驱动架构优势

### **传统链上缓存 vs 事件驱动架构**

| 特性 | 链上缓存方案 | 事件驱动方案 |
|------|-------------|-------------|
| **Gas 消耗** | ❌ 高（存储缓存+时间戳） | ✅ 低（仅事件发出） |
| **实时性** | ❌ 依赖缓存过期 | ✅ 实时触发 |
| **架构复杂度** | ❌ 高（缓存管理） | ✅ 低（事件驱动） |
| **数据一致性** | ❌ 可能不同步 | ✅ 始终一致 |
| **AI 友好度** | ❌ 数据不完整 | ✅ 完整事件历史 |
| **扩展性** | ❌ 难以扩展 | ✅ 易于扩展 |

### **事件驱动数据流**

```
用户操作 → 业务合约 → Registry查询 → 发出事件 → 数据库实时收集 → AI分析 → 智能响应
```

**核心优势：**
- ✅ **零缓存管理**：无需链上缓存存储和时间戳
- ✅ **实时数据流**：事件立即触发，数据实时收集
- ✅ **完整历史**：所有操作都有完整的事件记录
- ✅ **AI 优化**：便于构建智能分析系统

---

## 🧠 DeepSeek R1 模型集成

### 为什么选择 DeepSeek R1？

**DeepSeek R1 优势：**
- ✅ **强大的推理能力**：128K 上下文窗口，支持复杂金融分析
- ✅ **多模态支持**：文本、代码、数学公式处理
- ✅ **中文优化**：对中文金融术语理解更准确
- ✅ **成本效益**：相比 GPT-4 更具成本优势
- ✅ **API 稳定**：企业级 API 服务，99.9% 可用性

### 环境变量配置

```bash
# DeepSeek API 配置
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_API_BASE=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-r1

# 备用模型配置
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
LOCAL_LLM_URL=http://localhost:11434

# 向量数据库配置
MILVUS_HOST=localhost
MILVUS_PORT=19530
MILVUS_USERNAME=root
MILVUS_PASSWORD=Milvus

# 数据库配置
DATABASE_URL=postgresql://username:password@localhost:5432/rwa_lending_platform
REDIS_URL=redis://localhost:6379

# 事件驱动配置
EVENT_LISTENER_ENABLED=true
EVENT_PROCESSOR_WORKERS=4
REAL_TIME_DB_URL=postgresql://username:password@localhost:5432/realtime_events
EVENT_STORE_CONNECTION_STRING=esdb://prod_eventstore:2113

# AWS 配置
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_S3_BUCKET=your-bucket-name

# 安全配置
JWT_SECRET=your_jwt_secret
ENCRYPTION_KEY=your_encryption_key
```

---

## 🛠️ 环境准备

### 1. 基础环境要求

```bash
# Node.js 版本要求
node >= 18.0.0
npm >= 9.0.0

# Python 环境（用于 AI 服务）
python >= 3.9
pip >= 21.0

# Docker 环境
docker >= 20.10
docker-compose >= 2.0
```

### 2. 安装依赖

```bash
# 克隆项目
git clone <repository-url>
cd frontend

# 安装 Node.js 依赖
npm install

# 安装 Python 依赖
pip install -r requirements.txt

# 安装 DeepSeek 相关依赖
npm install @deepseek/ai
pip install deepseek-ai

# 安装事件处理依赖
npm install @eventstore/client
pip install eventstore-client
```

---

## 🧠 DeepSeek R1 服务实现

### 1. DeepSeek 客户端配置

```typescript
// src/services/ai-query/deepseek-client.ts
import { DeepSeek } from '@deepseek/ai';

export class DeepSeekClient {
  private client: DeepSeek;
  private model: string;

  constructor() {
    this.client = new DeepSeek({
      apiKey: process.env.DEEPSEEK_API_KEY!,
      baseURL: process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com/v1',
    });
    
    this.model = process.env.DEEPSEEK_MODEL || 'deepseek-r1';
  }

  async generateResponse(prompt: string, context?: string, options?: {
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
  }) {
    try {
      const systemPrompt = options?.systemPrompt || 
        `你是一个专业的 RWA 借贷平台 AI 助手，具备以下能力：
        1. 理解用户关于借贷、抵押、风险管理的查询
        2. 分析智能合约功能和风险
        3. 提供专业的金融建议
        4. 协助用户进行投资决策
        5. 基于实时事件数据进行分析
        
        请用专业、准确、易懂的方式回答用户问题。${context || ''}`;

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: options?.temperature || 0.7,
        max_tokens: options?.maxTokens || 2000,
        stream: false
      });

      return {
        content: response.choices[0].message.content,
        usage: response.usage,
        model: this.model
      };
    } catch (error) {
      console.error('DeepSeek R1 请求失败:', error);
      throw error;
    }
  }

  async generateEmbedding(text: string) {
    try {
      const response = await this.client.embeddings.create({
        model: 'deepseek-embedding',
        input: text,
        encoding_format: 'float'
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error('DeepSeek 嵌入生成失败:', error);
      throw error;
    }
  }

  async analyzeFinancialRisk(userData: any, eventHistory?: any[]) {
    const eventContext = eventHistory ? 
      `\n用户操作历史：\n${eventHistory.map(e => `- ${e.type}: ${e.amount} at ${e.timestamp}`).join('\n')}` : '';

    const prompt = `
    请分析以下用户的金融风险状况：
    
    用户信息：
    - 总抵押价值：${userData.totalCollateral}
    - 总债务价值：${userData.totalDebt}
    - 健康因子：${userData.healthFactor}
    - 资产组合：${JSON.stringify(userData.assets)}
    ${eventContext}
    
    请提供：
    1. 风险等级评估（低/中/高）
    2. 具体风险点分析
    3. 风险缓解建议
    4. 投资组合优化建议
    5. 基于历史行为的风险评估
    `;

    return await this.generateResponse(prompt, undefined, {
      temperature: 0.3,
      maxTokens: 1500,
      systemPrompt: '你是一个专业的金融风险分析师，请基于实时数据和历史事件提供准确的风险评估和建议。'
    });
  }

  async explainContractFunction(contractName: string, functionName: string) {
    const prompt = `
    请详细解释智能合约 ${contractName} 中的 ${functionName} 函数：
    
    1. 函数功能说明
    2. 参数含义
    3. 返回值说明
    4. 使用场景
    5. 潜在风险
    6. 最佳实践建议
    7. 事件驱动架构中的角色
    `;

    return await this.generateResponse(prompt, undefined, {
      temperature: 0.4,
      maxTokens: 1200,
      systemPrompt: '你是一个智能合约专家，请用通俗易懂的语言解释复杂的合约功能，特别关注事件驱动架构的优势。'
    });
  }

  async generateInvestmentRecommendation(userProfile: any, marketData: any, eventData?: any[]) {
    const eventAnalysis = eventData ? 
      `\n用户行为分析：\n${eventData.map(e => `- ${e.pattern}: ${e.frequency} 次操作`).join('\n')}` : '';

    const prompt = `
    基于以下信息，为用户生成投资建议：
    
    用户画像：
    - 风险承受能力：${userProfile.riskTolerance}
    - 投资目标：${userProfile.investmentGoal}
    - 投资期限：${userProfile.investmentHorizon}
    - 资金规模：${userProfile.capitalAmount}
    
    市场数据：
    - 当前利率：${marketData.currentRates}
    - 市场趋势：${marketData.marketTrend}
    - 风险评估：${marketData.riskAssessment}
    ${eventAnalysis}
    
    请提供：
    1. 投资策略建议
    2. 资产配置比例
    3. 预期收益和风险
    4. 操作步骤指导
    5. 基于历史行为的个性化建议
    `;

    return await this.generateResponse(prompt, undefined, {
      temperature: 0.5,
      maxTokens: 1800,
      systemPrompt: '你是一个专业的投资顾问，请基于实时市场数据和用户历史行为提供个性化的投资建议。'
    });
  }
}
```

### 2. 事件驱动数据处理

```typescript
// src/services/event-driven/event-processor.ts
import { EventStoreClient } from '@eventstore/client';
import { DeepSeekClient } from '../ai-query/deepseek-client';

export class EventProcessor {
  private eventStore: EventStoreClient;
  private deepseek: DeepSeekClient;
  private realTimeDB: any;

  constructor() {
    this.eventStore = new EventStoreClient({
      connectionString: process.env.EVENT_STORE_CONNECTION_STRING
    });
    
    this.deepseek = new DeepSeekClient();
    this.realTimeDB = this.initializeRealTimeDB();
  }

  async processEvent(event: any) {
    try {
      // 1. 实时存储事件
      await this.storeEvent(event);
      
      // 2. 更新实时数据库
      await this.updateRealTimeData(event);
      
      // 3. 触发 AI 分析
      await this.triggerAIAnalysis(event);
      
      // 4. 发送通知
      await this.sendNotifications(event);
      
      console.log(`事件处理完成: ${event.type} - ${event.id}`);
    } catch (error) {
      console.error('事件处理失败:', error);
      throw error;
    }
  }

  private async storeEvent(event: any) {
    // 存储到事件存储
    await this.eventStore.appendToStream('user-events', event);
    
    // 存储到实时数据库
    await this.realTimeDB.query(`
      INSERT INTO events (id, type, user_address, data, timestamp)
      VALUES ($1, $2, $3, $4, $5)
    `, [event.id, event.type, event.userAddress, JSON.stringify(event.data), event.timestamp]);
  }

  private async updateRealTimeData(event: any) {
    // 根据事件类型更新实时数据
    switch (event.type) {
      case 'DEPOSIT':
        await this.updateUserPosition(event.userAddress, 'collateral', event.amount, 'add');
        break;
      case 'WITHDRAW':
        await this.updateUserPosition(event.userAddress, 'collateral', event.amount, 'subtract');
        break;
      case 'BORROW':
        await this.updateUserPosition(event.userAddress, 'debt', event.amount, 'add');
        break;
      case 'REPAY':
        await this.updateUserPosition(event.userAddress, 'debt', event.amount, 'subtract');
        break;
    }
  }

  private async triggerAIAnalysis(event: any) {
    // 获取用户历史事件
    const userHistory = await this.getUserEventHistory(event.userAddress, 100);
    
    // 使用 DeepSeek 分析用户行为
    const analysis = await this.deepseek.analyzeUserBehavior(event, userHistory);
    
    // 存储分析结果
    await this.realTimeDB.query(`
      INSERT INTO ai_analysis (user_address, event_id, analysis, timestamp)
      VALUES ($1, $2, $3, $4)
    `, [event.userAddress, event.id, JSON.stringify(analysis), new Date()]);
  }

  private async analyzeUserBehavior(event: any, history: any[]) {
    const prompt = `
    分析用户行为模式：
    
    当前事件：${event.type} - ${event.amount}
    历史事件：${history.map(h => `${h.type}: ${h.amount} at ${h.timestamp}`).join('\n')}
    
    请分析：
    1. 用户操作模式
    2. 风险偏好
    3. 投资策略
    4. 异常行为检测
    5. 个性化建议
    `;

    return await this.deepseek.generateResponse(prompt, undefined, {
      temperature: 0.3,
      maxTokens: 1000,
      systemPrompt: '你是一个用户行为分析师，请基于事件历史分析用户行为模式。'
    });
  }

  private async getUserEventHistory(userAddress: string, limit: number) {
    const result = await this.realTimeDB.query(`
      SELECT * FROM events 
      WHERE user_address = $1 
      ORDER BY timestamp DESC 
      LIMIT $2
    `, [userAddress, limit]);
    
    return result.rows;
  }

  private async updateUserPosition(userAddress: string, field: string, amount: number, operation: 'add' | 'subtract') {
    const sql = operation === 'add' 
      ? `UPDATE user_positions SET ${field} = ${field} + $2 WHERE user_address = $1`
      : `UPDATE user_positions SET ${field} = ${field} - $2 WHERE user_address = $1`;
    
    await this.realTimeDB.query(sql, [userAddress, amount]);
  }

  private async sendNotifications(event: any) {
    // 根据事件类型发送相应通知
    if (event.type === 'LIQUIDATION_RISK') {
      await this.sendRiskAlert(event);
    } else if (event.type === 'LARGE_TRANSACTION') {
      await this.sendTransactionAlert(event);
    }
  }

  private async sendRiskAlert(event: any) {
    // 发送风险告警
    console.log(`风险告警: 用户 ${event.userAddress} 面临清算风险`);
  }

  private async sendTransactionAlert(event: any) {
    // 发送大额交易告警
    console.log(`大额交易告警: 用户 ${event.userAddress} 进行了大额 ${event.type} 操作`);
  }

  private initializeRealTimeDB() {
    // 初始化实时数据库连接
    return new (require('pg').Client)({
      connectionString: process.env.REAL_TIME_DB_URL
    });
  }
}
```

### 3. 多模型回退机制

```typescript
// src/services/ai-query/llm-client.ts
import { DeepSeekClient } from './deepseek-client';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export class LLMClient {
  private deepseek: DeepSeekClient;
  private openai: OpenAI;
  private anthropic: Anthropic;
  private primaryModel: 'deepseek' | 'openai' | 'anthropic';

  constructor() {
    this.deepseek = new DeepSeekClient();
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    
    this.primaryModel = (process.env.PRIMARY_LLM_MODEL as any) || 'deepseek';
  }

  async generateResponse(prompt: string, context?: string, options?: any) {
    const models = [
      { name: 'deepseek', client: this.deepseek },
      { name: 'openai', client: this.openai },
      { name: 'anthropic', client: this.anthropic }
    ];

    // 按优先级排序
    const sortedModels = models.sort((a, b) => 
      a.name === this.primaryModel ? -1 : b.name === this.primaryModel ? 1 : 0
    );

    for (const model of sortedModels) {
      try {
        console.log(`尝试使用 ${model.name} 模型...`);
        
        if (model.name === 'deepseek') {
          return await this.deepseek.generateResponse(prompt, context, options);
        } else if (model.name === 'openai') {
          const response = await this.openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
              { role: 'system', content: context || '你是 RWA 借贷平台 AI 助手' },
              { role: 'user', content: prompt }
            ],
            temperature: options?.temperature || 0.7,
            max_tokens: options?.maxTokens || 2000
          });
          return { content: response.choices[0].message.content };
        } else if (model.name === 'anthropic') {
          const response = await this.anthropic.messages.create({
            model: 'claude-3-sonnet-20240229',
            max_tokens: options?.maxTokens || 2000,
            messages: [
              { role: 'user', content: `${context || ''}\n\n${prompt}` }
            ]
          });
          return { content: response.content[0].text };
        }
      } catch (error) {
        console.error(`${model.name} 模型请求失败:`, error);
        continue;
      }
    }

    throw new Error('所有 LLM 模型都请求失败');
  }
}
```

### 4. AI Agent 集成 DeepSeek

```typescript
// src/services/ai-query/agent-orchestrator.ts
import { DeepSeekClient } from './deepseek-client';
import { EventProcessor } from '../event-driven/event-processor';

export class AgentOrchestrator {
  private deepseek: DeepSeekClient;
  private eventProcessor: EventProcessor;
  private agents: Map<string, BaseAgent> = new Map();

  constructor() {
    this.deepseek = new DeepSeekClient();
    this.eventProcessor = new EventProcessor();
    this.initializeAgents();
  }

  private initializeAgents() {
    this.agents.set('analyzer', new AnalysisAgent(this.deepseek, this.eventProcessor));
    this.agents.set('risk', new RiskAgent(this.deepseek, this.eventProcessor));
    this.agents.set('executor', new ExecutionAgent(this.deepseek, this.eventProcessor));
    this.agents.set('reporter', new ReportAgent(this.deepseek, this.eventProcessor));
    this.agents.set('security', new SecurityAgent(this.deepseek, this.eventProcessor));
  }

  async processUserQuery(query: string, context: any) {
    try {
      // 1. 使用 DeepSeek R1 进行意图识别
      const intent = await this.identifyIntent(query);
      
      // 2. 获取用户实时数据
      const userData = await this.getUserRealTimeData(context.userAddress);
      
      // 3. 获取用户事件历史
      const eventHistory = await this.eventProcessor.getUserEventHistory(context.userAddress, 50);
      
      // 4. 选择合适的 Agent
      const selectedAgents = this.selectAgents(intent);
      
      // 5. 并行执行 Agent 任务
      const agentResults = await Promise.all(
        selectedAgents.map(agent => agent.process(query, { ...context, userData, eventHistory }))
      );
      
      // 6. 使用 DeepSeek R1 聚合结果
      const aggregatedResult = await this.aggregateResults(agentResults, query, eventHistory);
      
      return aggregatedResult;
    } catch (error) {
      console.error('Agent 处理失败:', error);
      throw error;
    }
  }

  private async identifyIntent(query: string) {
    const prompt = `
    分析以下用户查询的意图，请返回最匹配的类别：
    
    查询：${query}
    
    可选类别：
    - deposit: 存款/抵押相关
    - borrow: 借款相关
    - repay: 还款相关
    - withdraw: 提取相关
    - analyze: 分析/查询相关
    - risk_check: 风险检查相关
    - execute: 执行操作相关
    - history: 历史查询相关
    - general: 一般咨询
    
    请只返回类别名称，不要其他内容。
    `;

    const response = await this.deepseek.generateResponse(prompt, undefined, {
      temperature: 0.1,
      maxTokens: 50
    });

    return response.content?.toLowerCase().trim() || 'general';
  }

  private async getUserRealTimeData(userAddress: string) {
    // 从实时数据库获取用户最新数据
    const result = await this.eventProcessor.realTimeDB.query(`
      SELECT * FROM user_positions WHERE user_address = $1
    `, [userAddress]);
    
    return result.rows[0] || null;
  }

  private async aggregateResults(agentResults: any[], originalQuery: string, eventHistory: any[]) {
    const resultsSummary = agentResults.map((result, index) => 
      `Agent ${index + 1}: ${result.summary}`
    ).join('\n');

    const eventContext = eventHistory.length > 0 ? 
      `\n用户最近操作：\n${eventHistory.slice(0, 5).map(e => `- ${e.type}: ${e.amount}`).join('\n')}` : '';

    const prompt = `
    基于以下 Agent 分析结果和用户历史，为用户提供综合回答：
    
    原始查询：${originalQuery}
    ${eventContext}
    
    Agent 分析结果：
    ${resultsSummary}
    
    请提供：
    1. 综合建议
    2. 具体操作步骤
    3. 注意事项
    4. 基于历史行为的个性化建议
    5. 风险提醒
    
    请用专业、易懂的语言回答。
    `;

    const response = await this.deepseek.generateResponse(prompt, undefined, {
      temperature: 0.5,
      maxTokens: 1500
    });

    return {
      content: response.content,
      agentResults,
      eventHistory: eventHistory.slice(0, 10), // 返回最近10个事件
      metadata: {
        model: 'deepseek-r1',
        agents: agentResults.length,
        confidence: this.calculateConfidence(agentResults),
        dataSource: 'real-time'
      }
    };
  }

  private calculateConfidence(results: any[]): number {
    // 基于 Agent 结果的一致性计算置信度
    const validResults = results.filter(r => r.confidence > 0.5);
    return validResults.length > 0 ? 
      validResults.reduce((sum, r) => sum + r.confidence, 0) / validResults.length : 0;
  }
}
```

---

## 🎨 UI 组件集成

### 1. DeepSeek 聊天界面

```typescript
// src/components/ai/ChatInterface.tsx
import React, { useState, useRef, useEffect } from 'react';
import { useAIAgent } from '@/hooks/useAIAgent';

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  metadata?: {
    model?: string;
    agent?: string;
    confidence?: number;
    dataSource?: string;
    eventHistory?: any[];
  };
}

export const ChatInterface: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState('deepseek-r1');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const { sendMessage, agentStatus } = useAIAgent();

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      type: 'user',
      content: input,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await sendMessage(input, { model: selectedModel });
      
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'assistant',
        content: response.content,
        timestamp: new Date(),
        metadata: {
          model: response.metadata?.model || selectedModel,
          agent: response.metadata?.agents?.join(', '),
          confidence: response.metadata?.confidence,
          dataSource: response.metadata?.dataSource,
          eventHistory: response.eventHistory
        }
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('发送消息失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* 模型选择器 */}
      <div className="bg-white border-b p-4">
        <div className="flex items-center space-x-4">
          <label className="text-sm font-medium">AI 模型：</label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="px-3 py-1 border border-gray-300 rounded-md text-sm"
          >
            <option value="deepseek-r1">DeepSeek R1 (推荐)</option>
            <option value="gpt-4">GPT-4</option>
            <option value="claude-3">Claude 3</option>
          </select>
          <span className="text-xs text-gray-500">
            DeepSeek R1 提供最佳的中文金融分析能力
          </span>
        </div>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                message.type === 'user'
                  ? 'bg-blue-500 text-white'
                  : 'bg-white text-gray-800 shadow'
              }`}
            >
              <p className="text-sm">{message.content}</p>
              {message.metadata && (
                <div className="mt-2 text-xs opacity-75">
                  <p>模型: {message.metadata.model}</p>
                  {message.metadata.agent && <p>Agent: {message.metadata.agent}</p>}
                  {message.metadata.confidence && (
                    <p>置信度: {(message.metadata.confidence * 100).toFixed(1)}%</p>
                  )}
                  {message.metadata.dataSource && (
                    <p>数据来源: {message.metadata.dataSource}</p>
                  )}
                  {message.metadata.eventHistory && message.metadata.eventHistory.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer">最近操作历史</summary>
                      <div className="mt-1 space-y-1">
                        {message.metadata.eventHistory.map((event, index) => (
                          <div key={index} className="text-xs">
                            {event.type}: {event.amount}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white text-gray-800 shadow px-4 py-2 rounded-lg">
              <div className="flex items-center space-x-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500"></div>
                <span className="text-sm">DeepSeek R1 正在分析实时数据...</span>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* 输入框 */}
      <div className="border-t bg-white p-4">
        <div className="flex space-x-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            placeholder="用自然语言描述你的需求，DeepSeek R1 将基于实时数据为你提供专业分析..."
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            发送
          </button>
        </div>
        
        {/* Agent 状态 */}
        <div className="mt-2 text-xs text-gray-500">
          {agentStatus.map((status, index) => (
            <span key={index} className="mr-2">
              {status.name}: {status.status}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
```

---

## 🚀 部署配置

### 1. Docker 配置

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

# 安装 Python 和依赖
RUN apk add --no-cache python3 py3-pip

# 复制 package.json 和安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制 Python 依赖
COPY requirements.txt ./
RUN pip3 install -r requirements.txt

# 复制应用代码
COPY . .

# 构建应用
RUN npm run build

# 暴露端口
EXPOSE 3000

# 启动应用
CMD ["npm", "start"]
```

### 2. 环境变量配置

```bash
# .env.production
NODE_ENV=production

# DeepSeek 配置
DEEPSEEK_API_KEY=your_production_deepseek_api_key
DEEPSEEK_API_BASE=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-r1
PRIMARY_LLM_MODEL=deepseek

# 备用模型
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key

# 数据库配置
DATABASE_URL=postgresql://prod_user:prod_password@prod_host:5432/rwa_lending_platform
REDIS_URL=redis://prod_redis:6379

# 事件驱动配置
EVENT_LISTENER_ENABLED=true
EVENT_PROCESSOR_WORKERS=4
REAL_TIME_DB_URL=postgresql://prod_user:prod_password@prod_host:5432/realtime_events
EVENT_STORE_CONNECTION_STRING=esdb://prod_eventstore:2113

# AWS 配置
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_prod_access_key
AWS_SECRET_ACCESS_KEY=your_prod_secret_key
AWS_S3_BUCKET=prod-rwa-lending-bucket

# 安全配置
JWT_SECRET=your_production_jwt_secret
ENCRYPTION_KEY=your_production_encryption_key
```

---

## 📊 性能监控

### 1. DeepSeek 模型性能监控

```typescript
// src/utils/performance-monitor.ts
export class PerformanceMonitor {
  private metrics: Map<string, any[]> = new Map();

  trackModelPerformance(model: string, responseTime: number, success: boolean) {
    if (!this.metrics.has(model)) {
      this.metrics.set(model, []);
    }

    this.metrics.get(model)!.push({
      timestamp: Date.now(),
      responseTime,
      success,
      model
    });

    // 发送到监控服务
    this.sendMetrics({
      model,
      responseTime,
      success,
      timestamp: Date.now()
    });
  }

  getModelStats(model: string) {
    const modelMetrics = this.metrics.get(model) || [];
    
    if (modelMetrics.length === 0) return null;

    const responseTimes = modelMetrics.map(m => m.responseTime);
    const successCount = modelMetrics.filter(m => m.success).length;

    return {
      totalRequests: modelMetrics.length,
      successRate: successCount / modelMetrics.length,
      avgResponseTime: responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length,
      minResponseTime: Math.min(...responseTimes),
      maxResponseTime: Math.max(...responseTimes)
    };
  }

  private sendMetrics(metric: any) {
    // 发送到 CloudWatch 或其他监控服务
    console.log('Performance metric:', metric);
  }
}
```

### 2. 事件处理性能监控

```typescript
// src/utils/event-performance-monitor.ts
export class EventPerformanceMonitor {
  private eventMetrics: Map<string, any[]> = new Map();

  trackEventProcessing(eventType: string, processingTime: number, success: boolean) {
    if (!this.eventMetrics.has(eventType)) {
      this.eventMetrics.set(eventType, []);
    }

    this.eventMetrics.get(eventType)!.push({
      timestamp: Date.now(),
      processingTime,
      success,
      eventType
    });

    // 发送到监控服务
    this.sendEventMetrics({
      eventType,
      processingTime,
      success,
      timestamp: Date.now()
    });
  }

  getEventStats(eventType: string) {
    const metrics = this.eventMetrics.get(eventType) || [];
    
    if (metrics.length === 0) return null;

    const processingTimes = metrics.map(m => m.processingTime);
    const successCount = metrics.filter(m => m.success).length;

    return {
      totalEvents: metrics.length,
      successRate: successCount / metrics.length,
      avgProcessingTime: processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length,
      minProcessingTime: Math.min(...processingTimes),
      maxProcessingTime: Math.max(...processingTimes)
    };
  }

  private sendEventMetrics(metric: any) {
    // 发送到监控服务
    console.log('Event processing metric:', metric);
  }
}
```

---

## 🎯 总结

通过集成 **DeepSeek R1 模型**和**事件驱动架构**，我们的 RWA 借贷平台获得了：

### ✅ **核心优势**
- 🧠 **强大的推理能力**：128K 上下文窗口，支持复杂金融分析
- 🇨🇳 **中文优化**：对中文金融术语理解更准确
- 💰 **成本效益**：相比 GPT-4 更具成本优势
- 🔄 **多模型回退**：确保服务高可用性
- 🎯 **专业化**：针对金融场景优化的响应
- ⚡ **事件驱动**：实时数据流，无缓存架构

### 🚀 **技术特色**
- **智能意图识别**：准确理解用户查询意图
- **多 Agent 协作**：分析、风控、执行、报告、安全 Agent
- **实时向量搜索**：基于 Milvus 的语义搜索
- **自动执行链**：智能决策和自动执行
- **企业级安全**：完整的认证和授权机制
- **事件驱动架构**：实时数据处理，无缓存管理

### 🎯 **架构优势**
- **Gas 优化**：无需链上缓存存储和时间戳管理
- **实时性保证**：数据始终是最新的，无需等待缓存过期
- **架构简洁性**：业务逻辑更清晰，易于维护和升级
- **AI 友好**：完整的事件历史，便于模式识别和智能分析

这个架构为你的 RWA 借贷平台提供了真正智能化的用户体验，让用户可以用自然语言与平台交互，获得基于实时数据的专业金融分析和建议。

---

## 📞 技术支持

如果在搭建过程中遇到问题，请参考：

1. **DeepSeek 官方文档**：https://platform.deepseek.com/docs
2. **项目文档**：查看 `/docs` 目录下的详细文档
3. **社区支持**：加入我们的开发者社区
4. **邮件支持**：发送邮件到 support@rwa-lending.com

祝你搭建顺利！🚀 
# 数据库集成推荐方案

## 📋 概述

本文档为 RWA 借贷平台提供数据库集成推荐方案，涵盖开发、测试和生产环境的最佳实践。

## 🎯 推荐方案

### 1. 生产环境推荐：PostgreSQL + Prisma

**优势：**
- ✅ 关系型数据库，支持复杂查询和事务
- ✅ Prisma ORM 提供类型安全的数据库操作
- ✅ 支持 ACID 特性，数据一致性保证
- ✅ 成熟的生态系统和社区支持
- ✅ 支持 JSON 字段，灵活性好
- ✅ 优秀的性能和扩展性

**配置示例：**
```typescript
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Deployment {
  id              String   @id @default(cuid())
  network         String
  chainId         Int
  deployer        String
  deploymentTime  DateTime
  version         String
  contracts       Json     // 存储合约信息
  systemInfo      Json     // 存储系统信息
  registryInfo    Json?    // Registry 信息
  vaultInfo       Json?    // Vault 信息
  oracleInfo      Json?    // Oracle 信息
  rewardInfo      Json?    // Reward 信息
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([network, chainId])
  @@index([deployer])
  @@index([deploymentTime])
}

model Contract {
  id          String   @id @default(cuid())
  name        String
  address     String   @unique
  type        String   // proxy, implementation, library
  network     String
  chainId     Int
  abi         String?  // 存储 ABI
  bytecode    String?  // 存储字节码
  verified    Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([name])
  @@index([address])
  @@index([network, chainId])
}

model UserPosition {
  id              String   @id @default(cuid())
  userAddress     String
  assetAddress    String
  collateral      String   // 使用字符串存储大数
  debt            String
  healthFactor    String
  lastUpdated     DateTime @default(now())

  @@unique([userAddress, assetAddress])
  @@index([userAddress])
  @@index([assetAddress])
  @@index([healthFactor])
}

model AssetPrice {
  id          String   @id @default(cuid())
  assetAddress String
  price       String   // 使用字符串存储价格
  decimals    Int
  timestamp   DateTime
  source      String   // 价格来源
  isValid     Boolean  @default(true)

  @@index([assetAddress])
  @@index([timestamp])
  @@index([source])
}
```

### 2. 开发环境推荐：MongoDB + Mongoose

**优势：**
- ✅ 文档型数据库，灵活的数据结构
- ✅ 适合快速原型开发
- ✅ 支持 JSON 格式的数据存储
- ✅ 易于扩展和修改
- ✅ 优秀的开发体验

**配置示例：**
```typescript
// models/Deployment.ts
import mongoose from 'mongoose';

const DeploymentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  network: { type: String, required: true },
  chainId: { type: Number, required: true },
  deployer: { type: String, required: true },
  deploymentTime: { type: Date, required: true },
  version: { type: String, required: true },
  contracts: [{ type: mongoose.Schema.Types.Mixed }],
  systemInfo: { type: mongoose.Schema.Types.Mixed },
  registryInfo: { type: mongoose.Schema.Types.Mixed },
  vaultInfo: { type: mongoose.Schema.Types.Mixed },
  oracleInfo: { type: mongoose.Schema.Types.Mixed },
  rewardInfo: { type: mongoose.Schema.Types.Mixed }
}, {
  timestamps: true
});

DeploymentSchema.index({ network: 1, chainId: 1 });
DeploymentSchema.index({ deployer: 1 });
DeploymentSchema.index({ deploymentTime: 1 });

export const Deployment = mongoose.model('Deployment', DeploymentSchema);
```

### 3. 测试环境推荐：SQLite + TypeORM

**优势：**
- ✅ 轻量级数据库，无需服务器
- ✅ 适合单元测试和集成测试
- ✅ 支持内存数据库模式
- ✅ 快速启动和清理
- ✅ 零配置部署

**配置示例：**
```typescript
// entities/Deployment.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('deployments')
@Index(['network', 'chainId'])
@Index(['deployer'])
@Index(['deploymentTime'])
export class Deployment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  network: string;

  @Column()
  chainId: number;

  @Column()
  deployer: string;

  @Column()
  deploymentTime: Date;

  @Column()
  version: string;

  @Column('json')
  contracts: any[];

  @Column('json')
  systemInfo: any;

  @Column('json', { nullable: true })
  registryInfo?: any;

  @Column('json', { nullable: true })
  vaultInfo?: any;

  @Column('json', { nullable: true })
  oracleInfo?: any;

  @Column('json', { nullable: true })
  rewardInfo?: any;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
```

## 🔧 环境变量配置

### PostgreSQL 配置
```bash
# .env
DATABASE_URL="postgresql://username:password@localhost:5432/rwa_lending_platform"
DB_HOST=localhost
DB_PORT=5432
DB_NAME=rwa_lending_platform
DB_USER=postgres
DB_PASSWORD=your_password
DB_SSL=false
```

### MongoDB 配置
```bash
# .env
MONGODB_URI="mongodb://localhost:27017/rwa_lending_platform"
MONGODB_DB=rwa_lending_platform
```

### SQLite 配置
```bash
# .env
SQLITE_DB="./data/rwa_lending_platform.db"
SQLITE_MEMORY=false
```

## 📊 数据模型设计

### 核心实体

1. **Deployment（部署记录）**
   - 记录每次部署的完整信息
   - 包含合约地址、系统配置、版本信息

2. **Contract（合约信息）**
   - 存储所有已部署合约的详细信息
   - 包含 ABI、字节码、验证状态

3. **UserPosition（用户仓位）**
   - 记录用户的抵押和债务信息
   - 实时更新健康因子

4. **AssetPrice（资产价格）**
   - 存储资产价格历史
   - 支持多价格源

5. **SystemEvent（系统事件）**
   - 记录重要的系统事件
   - 用于审计和监控

## 🚀 部署集成

### 自动数据库初始化
```typescript
// scripts/database/init.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function initDatabase() {
  try {
    // 创建数据库表
    await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
    
    // 运行 Prisma 迁移
    await prisma.$executeRaw`SELECT 1`;
    
    console.log('✅ 数据库初始化完成');
  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

initDatabase();
```

### 部署后数据同步
```typescript
// scripts/database/sync-deployment.ts
import { DatabaseIntegrationManager } from '../deploy/deploy-local';

async function syncDeploymentToDatabase(deploymentData: any) {
  const dbManager = new DatabaseIntegrationManager({
    type: 'postgresql',
    database: 'rwa_lending_platform'
  });
  
  await dbManager.connect();
  await dbManager.saveDeploymentRecord(deploymentData);
}
```

## 🔍 监控和查询

### 常用查询示例

```sql
-- 获取最新部署信息
SELECT * FROM deployments 
WHERE network = 'localhost' 
ORDER BY deployment_time DESC 
LIMIT 1;

-- 获取用户仓位信息
SELECT * FROM user_positions 
WHERE user_address = '0x...' 
AND health_factor < 11000;

-- 获取资产价格历史
SELECT * FROM asset_prices 
WHERE asset_address = '0x...' 
AND timestamp > NOW() - INTERVAL '24 hours'
ORDER BY timestamp DESC;
```

## 📈 性能优化

### 索引策略
```sql
-- 为常用查询创建索引
CREATE INDEX idx_deployments_network_chain ON deployments(network, chain_id);
CREATE INDEX idx_contracts_address ON contracts(address);
CREATE INDEX idx_user_positions_health_factor ON user_positions(health_factor);
CREATE INDEX idx_asset_prices_timestamp ON asset_prices(timestamp);
```

### 分区策略
```sql
-- 按时间分区部署记录
CREATE TABLE deployments_2024 PARTITION OF deployments
FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
```

## 🔒 安全考虑

1. **数据加密**
   - 敏感数据使用加密存储
   - 数据库连接使用 SSL/TLS

2. **访问控制**
   - 使用最小权限原则
   - 定期轮换数据库密码

3. **备份策略**
   - 定期自动备份
   - 多地域备份存储

## 📝 总结

- **生产环境**：PostgreSQL + Prisma（推荐）
- **开发环境**：MongoDB + Mongoose（推荐）
- **测试环境**：SQLite + TypeORM（推荐）

选择合适的数据库方案取决于具体的需求和环境。建议在开发初期使用 MongoDB 进行快速原型开发，在生产环境使用 PostgreSQL 确保数据一致性和性能。 
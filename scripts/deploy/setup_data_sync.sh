#!/bin/bash

# 数据同步设置脚本
# 用于配置AWS RDS和本地数据库之间的数据同步

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== 数据同步设置脚本 ===${NC}"
echo ""

# 检查配置文件
if [ ! -f "/tmp/aws_rds_config.env" ]; then
    echo -e "${RED}错误: 未找到AWS RDS配置文件${NC}"
    echo "请先运行: ./scripts/deploy/setup_aws_rds.sh"
    exit 1
fi

if [ ! -f "/tmp/aws_tunnel_config.env" ]; then
    echo -e "${RED}错误: 未找到SSH隧道配置文件${NC}"
    echo "请先运行: ./scripts/deploy/setup_ssh_tunnel.sh"
    exit 1
fi

# 加载配置
source /tmp/aws_rds_config.env
source /tmp/aws_tunnel_config.env

echo -e "${GREEN}✓ 配置文件已加载${NC}"

# 创建数据同步脚本
echo -e "${YELLOW}=== 创建数据同步脚本 ===${NC}"
cat > /tmp/sync_aws_to_local.ts << 'EOF'
#!/usr/bin/env ts-node

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// 加载环境变量
require('dotenv').config();

// 数据库连接配置
const awsConfig = {
  host: process.env.LOCAL_AWS_DB_HOST || 'localhost',
  port: parseInt(process.env.LOCAL_AWS_DB_PORT || '5433'),
  database: process.env.LOCAL_AWS_DB_NAME || 'rwa_aws',
  user: process.env.LOCAL_AWS_DB_USER || 'rwa_admin',
  password: process.env.LOCAL_AWS_DB_PASSWORD || '',
  ssl: process.env.LOCAL_AWS_DB_SSL === 'true'
};

const localConfig = {
  host: process.env.LOCAL_DB_HOST || 'localhost',
  port: parseInt(process.env.LOCAL_DB_PORT || '5432'),
  database: process.env.LOCAL_DB_NAME || 'rwa_local',
  user: process.env.LOCAL_DB_USER || 'rwa',
  password: process.env.LOCAL_DB_PASSWORD || 'rwa_password',
  ssl: process.env.LOCAL_DB_SSL === 'true'
};

// 创建连接池
const awsPool = new Pool(awsConfig);
const localPool = new Pool(localConfig);

// 数据同步函数
async function syncData() {
  console.log('🔄 开始数据同步...');
  
  try {
    // 1. 从AWS RDS获取新数据
    console.log('📥 从AWS RDS获取数据...');
    const awsClient = await awsPool.connect();
    
    const newDataQuery = `
      SELECT id, source, external_id, data, fetched_at, created_at
      FROM raw_data 
      WHERE processed = false 
      ORDER BY created_at ASC 
      LIMIT 1000
    `;
    
    const awsResult = await awsClient.query(newDataQuery);
    const newData = awsResult.rows;
    
    console.log(`📊 找到 ${newData.length} 条新数据`);
    
    if (newData.length === 0) {
      console.log('✅ 没有新数据需要同步');
      awsClient.release();
      return;
    }
    
    // 2. 同步到本地数据库
    console.log('📤 同步到本地数据库...');
    const localClient = await localPool.connect();
    
    // 开始事务
    await localClient.query('BEGIN');
    
    try {
      // 批量插入数据
      for (const row of newData) {
        const insertQuery = `
          INSERT INTO raw_data (source, external_id, data, fetched_at, created_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (source, external_id) DO UPDATE SET
            data = EXCLUDED.data,
            fetched_at = EXCLUDED.fetched_at,
            updated_at = NOW()
        `;
        
        await localClient.query(insertQuery, [
          row.source,
          row.external_id,
          JSON.stringify(row.data),
          row.fetched_at,
          row.created_at
        ]);
      }
      
      // 提交事务
      await localClient.query('COMMIT');
      console.log(`✅ 成功同步 ${newData.length} 条数据`);
      
    } catch (error) {
      // 回滚事务
      await localClient.query('ROLLBACK');
      throw error;
    } finally {
      localClient.release();
    }
    
    // 3. 标记AWS数据为已处理
    console.log('🏷️  标记AWS数据为已处理...');
    const processedIds = newData.map(row => row.id);
    const updateQuery = `
      UPDATE raw_data 
      SET processed = true, processed_at = NOW()
      WHERE id = ANY($1)
    `;
    
    await awsClient.query(updateQuery, [processedIds]);
    console.log(`✅ 标记 ${processedIds.length} 条数据为已处理`);
    
    awsClient.release();
    
    // 4. 触发本地数据清洗
    console.log('🧹 触发本地数据清洗...');
    // 这里可以调用您的数据清洗脚本
    // 例如: await triggerLocalCleaning();
    
    console.log('🎉 数据同步完成！');
    
  } catch (error) {
    console.error('❌ 数据同步失败:', error);
    throw error;
  }
}

// 主函数
async function main() {
  try {
    await syncData();
    process.exit(0);
  } catch (error) {
    console.error('❌ 同步过程出错:', error);
    process.exit(1);
  }
}

// 运行主函数
if (require.main === module) {
  main();
}

export { syncData };
EOF

echo -e "${GREEN}✓ 数据同步脚本已创建${NC}"

# 创建定时同步脚本
echo -e "${YELLOW}=== 创建定时同步脚本 ===${NC}"
cat > /tmp/setup_cron_sync.sh << 'EOF'
#!/bin/bash

# 定时同步设置脚本
# 用于设置自动数据同步

# 检查是否已有定时任务
if crontab -l | grep -q "sync_aws_to_local"; then
    echo "定时任务已存在"
    exit 0
fi

# 添加定时任务（每15分钟同步一次）
(crontab -l 2>/dev/null; echo "*/15 * * * * cd /Volumes/AI-hosts/RwaLendingPlatform && /usr/local/bin/ts-node /tmp/sync_aws_to_local.ts >> /tmp/aws_sync.log 2>&1") | crontab -

echo "定时同步任务已设置（每15分钟）"
EOF

chmod +x /tmp/setup_cron_sync.sh

echo -e "${GREEN}✓ 定时同步脚本已创建${NC}"

# 创建数据清洗触发脚本
echo -e "${YELLOW}=== 创建数据清洗触发脚本 ===${NC}"
cat > /tmp/trigger_local_cleaning.sh << 'EOF'
#!/bin/bash

# 触发本地数据清洗脚本
# 在数据同步完成后自动执行

cd /Volumes/AI-hosts/RwaLendingPlatform

# 运行CoinGecko清洗
echo "🧹 运行CoinGecko数据清洗..."
pnpm -C Frontend exec ts-node ../scripts/ingest-coingecko-to-vector.ts

# 运行Messari清洗
echo "🧹 运行Messari数据清洗..."
pnpm -C Frontend exec ts-node ../scripts/ingest-messari-to-vector.ts

# 运行其他数据源清洗
echo "🧹 运行其他数据源清洗..."
pnpm -C Frontend exec ts-node ../scripts/ingest-defillama-to-vector.ts

echo "✅ 本地数据清洗完成"
EOF

chmod +x /tmp/trigger_local_cleaning.sh

echo -e "${GREEN}✓ 数据清洗触发脚本已创建${NC}"

# 创建监控脚本
echo -e "${YELLOW}=== 创建监控脚本 ===${NC}"
cat > /tmp/monitor_sync.sh << 'EOF'
#!/bin/bash

# 数据同步监控脚本
# 用于监控同步状态和性能

echo "=== 数据同步监控 ==="
echo "时间: $(date)"
echo ""

# 检查SSH隧道状态
if [ -f "/tmp/aws_rds_tunnel.pid" ]; then
    TUNNEL_PID=$(cat /tmp/aws_rds_tunnel.pid)
    if ps -p "$TUNNEL_PID" > /dev/null 2>&1; then
        echo "✅ SSH隧道: 运行中 (PID: $TUNNEL_PID)"
    else
        echo "❌ SSH隧道: 未运行"
    fi
else
    echo "❌ SSH隧道: 未配置"
fi

# 检查数据库连接
echo ""
echo "=== 数据库连接状态 ==="
if nc -z localhost 5433 2>/dev/null; then
    echo "✅ AWS RDS: 连接正常"
else
    echo "❌ AWS RDS: 连接失败"
fi

if nc -z localhost 5432 2>/dev/null; then
    echo "✅ 本地数据库: 连接正常"
else
    echo "❌ 本地数据库: 连接失败"
fi

# 检查同步日志
echo ""
echo "=== 同步日志 ==="
if [ -f "/tmp/aws_sync.log" ]; then
    echo "最近同步记录:"
    tail -5 /tmp/aws_sync.log
else
    echo "暂无同步记录"
fi

# 检查定时任务
echo ""
echo "=== 定时任务状态 ==="
if crontab -l | grep -q "sync_aws_to_local"; then
    echo "✅ 定时同步: 已配置"
else
    echo "❌ 定时同步: 未配置"
fi
EOF

chmod +x /tmp/monitor_sync.sh

echo -e "${GREEN}✓ 监控脚本已创建${NC}"

# 显示配置信息
echo ""
echo -e "${BLUE}=== 数据同步配置完成 ===${NC}"
echo "同步脚本: /tmp/sync_aws_to_local.ts"
echo "定时同步: /tmp/setup_cron_sync.sh"
echo "数据清洗: /tmp/trigger_local_cleaning.sh"
echo "监控脚本: /tmp/monitor_sync.sh"
echo ""
echo -e "${BLUE}=== 下一步操作 ===${NC}"
echo "1. 测试同步: /tmp/sync_aws_to_local.ts"
echo "2. 设置定时任务: /tmp/setup_cron_sync.sh"
echo "3. 监控状态: /tmp/monitor_sync.sh"
echo ""
echo -e "${YELLOW}⚠️  重要提醒:${NC}"
echo "- 确保SSH隧道正在运行"
echo "- 定期检查同步日志"
echo "- 监控数据库使用量"

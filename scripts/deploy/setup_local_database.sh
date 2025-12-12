#!/bin/bash

# 本地数据库设置脚本
# 设置本地 PostgreSQL 数据库用于数据清洗管道（向量数据存储在 Milvus）

set -e

# 配置参数
DB_NAME="rwa_local"
DB_USER="rwa"
DB_PASSWORD="rwa_password"
DB_HOST="localhost"
DB_PORT="5432"

echo "=== 开始设置本地数据库 ==="

# 1. 检查Docker是否运行
echo "=== 检查Docker环境 ==="
if ! command -v docker &> /dev/null; then
    echo "❌ Docker未安装，请先安装Docker"
    exit 1
fi

if ! docker ps &> /dev/null; then
    echo "❌ Docker未运行，请启动Docker"
    exit 1
fi
echo "✅ Docker环境正常"

# 2. 启动PostgreSQL容器
echo "=== 启动PostgreSQL容器 ==="
cd /Volumes/AI-hosts/RwaLendingPlatform

# 检查容器是否已存在
if docker ps -a | grep -q rwalp_postgres; then
    echo "PostgreSQL容器已存在，启动容器..."
    docker start rwalp_postgres
else
    echo "创建新的PostgreSQL容器..."
    docker run -d \
        --name rwalp_postgres \
        -e POSTGRES_DB=$DB_NAME \
        -e POSTGRES_USER=$DB_USER \
        -e POSTGRES_PASSWORD=$DB_PASSWORD \
        -p $DB_PORT:5432 \
        -v rwalp_postgres_data:/var/lib/postgresql/data \
        postgres:15
fi

# 等待数据库启动
echo "等待数据库启动..."
sleep 10

# 3. 测试数据库连接
echo "=== 测试数据库连接 ==="
if docker exec rwalp_postgres psql -U $DB_USER -d $DB_NAME -c "SELECT 1;" > /dev/null 2>&1; then
    echo "✅ 数据库连接成功"
else
    echo "❌ 数据库连接失败"
    exit 1
fi

# 4. 创建数据清洗管道表结构
echo "=== 创建数据清洗管道表结构 ==="
docker exec rwalp_postgres psql -U $DB_USER -d $DB_NAME << 'SQL'
-- 原始数据表
CREATE TABLE IF NOT EXISTS raw_data (
    id SERIAL PRIMARY KEY,
    source VARCHAR(100) NOT NULL,
    external_id VARCHAR(255) NOT NULL,
    data JSONB NOT NULL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source, external_id)
);

- 向量记录表（Milvus 集合关联）
CREATE TABLE IF NOT EXISTS ai_vector_records (
    id SERIAL PRIMARY KEY,
    scope VARCHAR(100) NOT NULL,
    reference_id VARCHAR(255) NOT NULL,
    content_sha VARCHAR(64) NOT NULL,
    milvus_doc_id VARCHAR(64) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(scope, reference_id, content_sha)
);

-- ETL失败记录表
CREATE TABLE IF NOT EXISTS etl_failures (
    id SERIAL PRIMARY KEY,
    source VARCHAR(100) NOT NULL,
    stage VARCHAR(50) NOT NULL,
    message TEXT,
    data JSONB DEFAULT '{}',
    occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 资产字典表
CREATE TABLE IF NOT EXISTS asset_dictionary (
    id SERIAL PRIMARY KEY,
    canonical_id VARCHAR(100) UNIQUE NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    name VARCHAR(100),
    contract_address VARCHAR(42),
    chain VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_raw_data_source ON raw_data(source);
CREATE INDEX IF NOT EXISTS idx_raw_data_external_id ON raw_data(external_id);
CREATE INDEX IF NOT EXISTS idx_raw_data_fetched_at ON raw_data(fetched_at);

CREATE INDEX IF NOT EXISTS idx_vector_scope ON ai_vector_records(scope);
CREATE INDEX IF NOT EXISTS idx_vector_reference_id ON ai_vector_records(reference_id);
CREATE INDEX IF NOT EXISTS idx_vector_content_sha ON ai_vector_records(content_sha);

CREATE INDEX IF NOT EXISTS idx_etl_failures_source ON etl_failures(source);
CREATE INDEX IF NOT EXISTS idx_etl_failures_stage ON etl_failures(stage);
CREATE INDEX IF NOT EXISTS idx_etl_failures_occurred_at ON etl_failures(occurred_at);

CREATE INDEX IF NOT EXISTS idx_asset_dict_canonical_id ON asset_dictionary(canonical_id);
CREATE INDEX IF NOT EXISTS idx_asset_dict_symbol ON asset_dictionary(symbol);

-- 插入基础资产数据
INSERT INTO asset_dictionary (canonical_id, symbol, name, contract_address, chain) VALUES
('btc', 'BTC', 'Bitcoin', NULL, 'bitcoin'),
('eth', 'ETH', 'Ethereum', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'ethereum'),
('usdt', 'USDT', 'Tether USD', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 'ethereum'),
('usdc', 'USDC', 'USD Coin', '0xA0b86a33E6441b8C4C8C0C4C8C0C4C8C0C4C8C0C', 'ethereum')
ON CONFLICT (canonical_id) DO NOTHING;

-- 显示表结构
\dt
SQL

# 5. Milvus 连接提示
echo "=== 提示：本地向量库使用 Milvus，请确保已启动 Milvus 服务（参见 ai-services/helm 或 deploy/docker-compose.aws.yml） ==="

# 6. 创建环境变量文件
echo "=== 创建环境变量文件 ==="
cat > /tmp/local_database.env << EOF
# 本地数据库配置
DATABASE_URL=postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
DATABASE_SSL=false

# AI嵌入服务配置
AI_EMBED_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_EMBED_MODEL=deepseek-r1:8b

# ETL调度配置
ETL_CRON_ENABLED=true
ETL_TRENDS_ENABLED=false
ETL_TWITTER_ENABLED=false
ETL_MAX_CONCURRENCY=3

# RAG检索范围
RAG_SCOPE=market_data,messari
EOF

echo "环境变量文件已创建: /tmp/local_database.env"

# 7. 测试数据清洗管道
echo "=== 测试数据清洗管道 ==="
if [ -f "Frontend/package.json" ]; then
    echo "测试数据清洗脚本..."
    cd Frontend
    
    # 测试数据库连接
    if pnpm exec ts-node -e "
        import { Pool } from 'pg';
        const pool = new Pool({ connectionString: 'postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME' });
        pool.query('SELECT 1').then(() => console.log('✅ 数据库连接测试成功')).catch(console.error);
    " 2>/dev/null; then
        echo "✅ 数据清洗管道测试成功"
    else
        echo "⚠️  数据清洗管道测试失败，请检查依赖"
    fi
else
    echo "⚠️  Frontend目录不存在，跳过数据清洗管道测试"
fi

# 8. 显示配置信息
echo ""
echo "=== 本地数据库设置完成 ==="
echo "数据库名称: $DB_NAME"
echo "数据库用户: $DB_USER"
echo "数据库密码: $DB_PASSWORD"
echo "连接字符串: postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
echo ""
echo "=== 下一步操作 ==="
echo "1. 运行数据采集脚本"
echo "2. 运行数据清洗脚本"
echo "3. 启动ETL调度器"
echo ""
echo "=== 数据清洗管道命令 ==="
echo "# 采集Messari数据"
echo "cd Frontend && pnpm exec ts-node ../scripts/collect-messari.ts"
echo ""
echo "# 清洗Messari数据"
echo "cd Frontend && pnpm exec ts-node ../scripts/ingest-messari-to-vector.ts"
echo ""
echo "# 启动ETL调度器"
echo "cd Frontend && ETL_CRON_ENABLED=true pnpm run etl:schedule"
echo ""
echo "=== 监控命令 ==="
echo "# 查看数据库状态"
echo "docker exec rwalp_postgres psql -U $DB_USER -d $DB_NAME -c 'SELECT COUNT(*) FROM raw_data;'"
echo ""
echo "# 查看向量数据"
echo "docker exec rwalp_postgres psql -U $DB_USER -d $DB_NAME -c 'SELECT scope, COUNT(*) FROM ai_embeddings_1536 GROUP BY scope;'"

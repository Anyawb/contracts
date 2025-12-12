#!/bin/bash

# AWS连接测试脚本
# 用于测试AWS RDS和本地数据库的连接

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== AWS连接测试脚本 ===${NC}"
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

# 测试SSH隧道
echo -e "${YELLOW}=== 测试SSH隧道 ===${NC}"
if [ -f "/tmp/aws_rds_tunnel.pid" ]; then
    TUNNEL_PID=$(cat /tmp/aws_rds_tunnel.pid)
    if ps -p "$TUNNEL_PID" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ SSH隧道: 运行中 (PID: $TUNNEL_PID)${NC}"
    else
        echo -e "${RED}❌ SSH隧道: 未运行${NC}"
        echo "请运行: ./scripts/deploy/setup_ssh_tunnel.sh"
        exit 1
    fi
else
    echo -e "${RED}❌ SSH隧道: 未配置${NC}"
    echo "请运行: ./scripts/deploy/setup_ssh_tunnel.sh"
    exit 1
fi

# 测试端口连接
echo -e "${YELLOW}=== 测试端口连接 ===${NC}"
if nc -z localhost $TUNNEL_PORT 2>/dev/null; then
    echo -e "${GREEN}✓ 隧道端口 $TUNNEL_PORT: 连接正常${NC}"
else
    echo -e "${RED}❌ 隧道端口 $TUNNEL_PORT: 连接失败${NC}"
    exit 1
fi

# 测试AWS RDS连接
echo -e "${YELLOW}=== 测试AWS RDS连接 ===${NC}"
if PGPASSWORD="$AWS_DB_PASSWORD" psql -h localhost -p $TUNNEL_PORT -U "$AWS_DB_USER" -d "$AWS_DB_NAME" -c "SELECT version();" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ AWS RDS: 连接正常${NC}"
    
    # 测试数据库表
    echo -e "${YELLOW}=== 测试数据库表 ===${NC}"
    if PGPASSWORD="$AWS_DB_PASSWORD" psql -h localhost -p $TUNNEL_PORT -U "$AWS_DB_USER" -d "$AWS_DB_NAME" -c "SELECT COUNT(*) FROM raw_data;" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ raw_data表: 存在${NC}"
    else
        echo -e "${YELLOW}⚠️  raw_data表: 不存在，将创建${NC}"
        
        # 创建表结构
        PGPASSWORD="$AWS_DB_PASSWORD" psql -h localhost -p $TUNNEL_PORT -U "$AWS_DB_USER" -d "$AWS_DB_NAME" << 'EOF'
CREATE TABLE IF NOT EXISTS raw_data (
    id SERIAL PRIMARY KEY,
    source VARCHAR(100) NOT NULL,
    external_id VARCHAR(255) NOT NULL,
    data JSONB NOT NULL,
    fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed BOOLEAN DEFAULT FALSE,
    processed_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_raw_data_source ON raw_data(source);
CREATE INDEX IF NOT EXISTS idx_raw_data_external_id ON raw_data(external_id);
CREATE INDEX IF NOT EXISTS idx_raw_data_processed ON raw_data(processed);
CREATE INDEX IF NOT EXISTS idx_raw_data_created_at ON raw_data(created_at);
EOF
        echo -e "${GREEN}✓ 数据库表结构已创建${NC}"
    fi
else
    echo -e "${RED}❌ AWS RDS: 连接失败${NC}"
    exit 1
fi

# 测试本地数据库连接
echo -e "${YELLOW}=== 测试本地数据库连接 ===${NC}"
if PGPASSWORD="$LOCAL_DB_PASSWORD" psql -h localhost -p 5432 -U "$LOCAL_DB_USER" -d "$LOCAL_DB_NAME" -c "SELECT version();" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 本地数据库: 连接正常${NC}"
else
    echo -e "${RED}❌ 本地数据库: 连接失败${NC}"
    echo "请检查本地数据库是否运行"
    exit 1
fi

# 测试数据同步脚本
echo -e "${YELLOW}=== 测试数据同步脚本 ===${NC}"
if [ -f "/tmp/sync_aws_to_local.ts" ]; then
    echo -e "${GREEN}✓ 数据同步脚本: 存在${NC}"
    
    # 检查TypeScript环境
    if command -v ts-node &> /dev/null; then
        echo -e "${GREEN}✓ TypeScript环境: 已安装${NC}"
    else
        echo -e "${YELLOW}⚠️  TypeScript环境: 未安装${NC}"
        echo "请安装: npm install -g ts-node typescript"
    fi
else
    echo -e "${RED}❌ 数据同步脚本: 不存在${NC}"
    echo "请运行: ./scripts/deploy/setup_data_sync.sh"
    exit 1
fi

# 测试环境变量
echo -e "${YELLOW}=== 测试环境变量 ===${NC}"
if [ -n "$AWS_DB_HOST" ] && [ -n "$AWS_DB_PORT" ] && [ -n "$AWS_DB_NAME" ] && [ -n "$AWS_DB_USER" ] && [ -n "$AWS_DB_PASSWORD" ]; then
    echo -e "${GREEN}✓ AWS环境变量: 完整${NC}"
else
    echo -e "${RED}❌ AWS环境变量: 不完整${NC}"
    exit 1
fi

if [ -n "$LOCAL_DB_HOST" ] && [ -n "$LOCAL_DB_PORT" ] && [ -n "$LOCAL_DB_NAME" ] && [ -n "$LOCAL_DB_USER" ] && [ -n "$LOCAL_DB_PASSWORD" ]; then
    echo -e "${GREEN}✓ 本地环境变量: 完整${NC}"
else
    echo -e "${RED}❌ 本地环境变量: 不完整${NC}"
    exit 1
fi

# 测试数据插入
echo -e "${YELLOW}=== 测试数据插入 ===${NC}"
TEST_DATA='{"test": "data", "timestamp": "'$(date -Iseconds)'"}'
if PGPASSWORD="$AWS_DB_PASSWORD" psql -h localhost -p $TUNNEL_PORT -U "$AWS_DB_USER" -d "$AWS_DB_NAME" -c "INSERT INTO raw_data (source, external_id, data) VALUES ('test', 'test_$(date +%s)', '$TEST_DATA') ON CONFLICT (source, external_id) DO NOTHING;" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 数据插入: 成功${NC}"
    
    # 清理测试数据
    PGPASSWORD="$AWS_DB_PASSWORD" psql -h localhost -p $TUNNEL_PORT -U "$AWS_DB_USER" -d "$AWS_DB_NAME" -c "DELETE FROM raw_data WHERE source = 'test';" > /dev/null 2>&1
    echo -e "${GREEN}✓ 测试数据: 已清理${NC}"
else
    echo -e "${RED}❌ 数据插入: 失败${NC}"
    exit 1
fi

# 显示连接信息
echo ""
echo -e "${BLUE}=== 连接信息汇总 ===${NC}"
echo "AWS RDS端点: $AWS_DB_HOST:$AWS_DB_PORT"
echo "隧道端口: localhost:$TUNNEL_PORT"
echo "数据库名称: $AWS_DB_NAME"
echo "数据库用户: $AWS_DB_USER"
echo ""
echo -e "${BLUE}=== 连接命令 ===${NC}"
echo "直接连接: psql -h localhost -p $TUNNEL_PORT -U $AWS_DB_USER -d $AWS_DB_NAME"
echo "环境变量: PGPASSWORD='$AWS_DB_PASSWORD' psql -h localhost -p $TUNNEL_PORT -U $AWS_DB_USER -d $AWS_DB_NAME"
echo ""
echo -e "${GREEN}✅ 所有连接测试通过！${NC}"
echo ""
echo -e "${BLUE}=== 下一步操作 ===${NC}"
echo "1. 启动数据同步: ./scripts/deploy/setup_data_sync.sh"
echo "2. 设置定时任务: /tmp/setup_cron_sync.sh"
echo "3. 监控服务状态: /tmp/monitor_sync.sh"

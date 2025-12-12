#!/bin/bash

# 环境变量配置更新脚本
# 用于更新项目环境变量以支持AWS RDS集成

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== 环境变量配置更新脚本 ===${NC}"
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

# 更新Frontend环境变量
echo -e "${YELLOW}=== 更新Frontend环境变量 ===${NC}"

# 创建AWS集成环境变量文件
cat > /Volumes/AI-hosts/RwaLendingPlatform/Frontend/.env.aws << EOF
# AWS RDS 集成配置
# 自动生成时间: $(date)

# AWS RDS 连接配置
AWS_DB_HOST=$AWS_DB_HOST
AWS_DB_PORT=$AWS_DB_PORT
AWS_DB_NAME=$AWS_DB_NAME
AWS_DB_USER=$AWS_DB_USER
AWS_DB_PASSWORD=$AWS_DB_PASSWORD
AWS_DB_URL=$AWS_DB_URL
AWS_DB_SSL=$AWS_DB_SSL

# 本地隧道连接配置
LOCAL_AWS_DB_HOST=$LOCAL_AWS_DB_HOST
LOCAL_AWS_DB_PORT=$LOCAL_AWS_DB_PORT
LOCAL_AWS_DB_NAME=$LOCAL_AWS_DB_NAME
LOCAL_AWS_DB_USER=$LOCAL_AWS_DB_USER
LOCAL_AWS_DB_PASSWORD=$LOCAL_AWS_DB_PASSWORD
LOCAL_AWS_DB_URL=$LOCAL_AWS_DB_URL
LOCAL_AWS_DB_SSL=$LOCAL_AWS_DB_SSL

# 数据同步配置
SYNC_ENABLED=true
SYNC_INTERVAL_MINUTES=15
SYNC_BATCH_SIZE=1000
SYNC_RETRY_ATTEMPTS=3

# 数据清洗配置
CLEANING_ENABLED=true
CLEANING_TRIGGER_SYNC=true
CLEANING_BATCH_SIZE=100

# 监控配置
MONITORING_ENABLED=true
LOG_LEVEL=info
LOG_FILE=/tmp/aws_sync.log
EOF

echo -e "${GREEN}✓ Frontend AWS环境变量已创建${NC}"

# 更新主环境变量文件
echo -e "${YELLOW}=== 更新主环境变量文件 ===${NC}"

# 检查是否存在.env文件
if [ -f "/Volumes/AI-hosts/RwaLendingPlatform/.env" ]; then
    # 备份原文件
    cp /Volumes/AI-hosts/RwaLendingPlatform/.env /Volumes/AI-hosts/RwaLendingPlatform/.env.backup.$(date +%Y%m%d_%H%M%S)
    echo -e "${GREEN}✓ 原环境变量文件已备份${NC}"
fi

# 添加AWS配置到主环境变量文件
cat >> /Volumes/AI-hosts/RwaLendingPlatform/.env << EOF

# AWS RDS 集成配置 (自动添加)
# 添加时间: $(date)

# AWS RDS 连接
AWS_DB_HOST=$AWS_DB_HOST
AWS_DB_PORT=$AWS_DB_PORT
AWS_DB_NAME=$AWS_DB_NAME
AWS_DB_USER=$AWS_DB_USER
AWS_DB_PASSWORD=$AWS_DB_PASSWORD
AWS_DB_URL=$AWS_DB_URL
AWS_DB_SSL=$AWS_DB_SSL

# 本地隧道连接
LOCAL_AWS_DB_HOST=$LOCAL_AWS_DB_HOST
LOCAL_AWS_DB_PORT=$LOCAL_AWS_DB_PORT
LOCAL_AWS_DB_NAME=$LOCAL_AWS_DB_NAME
LOCAL_AWS_DB_USER=$LOCAL_AWS_DB_USER
LOCAL_AWS_DB_PASSWORD=$LOCAL_AWS_DB_PASSWORD
LOCAL_AWS_DB_URL=$LOCAL_AWS_DB_URL
LOCAL_AWS_DB_SSL=$LOCAL_AWS_DB_SSL

# 数据同步设置
SYNC_ENABLED=true
SYNC_INTERVAL_MINUTES=15
SYNC_BATCH_SIZE=1000
SYNC_RETRY_ATTEMPTS=3

# 数据清洗设置
CLEANING_ENABLED=true
CLEANING_TRIGGER_SYNC=true
CLEANING_BATCH_SIZE=100

# 监控设置
MONITORING_ENABLED=true
LOG_LEVEL=info
LOG_FILE=/tmp/aws_sync.log
EOF

echo -e "${GREEN}✓ 主环境变量文件已更新${NC}"

# 更新Frontend环境变量
echo -e "${YELLOW}=== 更新Frontend环境变量 ===${NC}"

# 检查Frontend .env文件
if [ -f "/Volumes/AI-hosts/RwaLendingPlatform/Frontend/.env" ]; then
    # 备份原文件
    cp /Volumes/AI-hosts/RwaLendingPlatform/Frontend/.env /Volumes/AI-hosts/RwaLendingPlatform/Frontend/.env.backup.$(date +%Y%m%d_%H%M%S)
    echo -e "${GREEN}✓ Frontend环境变量文件已备份${NC}"
fi

# 添加AWS配置到Frontend环境变量文件
cat >> /Volumes/AI-hosts/RwaLendingPlatform/Frontend/.env << EOF

# AWS RDS 集成配置 (自动添加)
# 添加时间: $(date)

# AWS RDS 连接
AWS_DB_HOST=$AWS_DB_HOST
AWS_DB_PORT=$AWS_DB_PORT
AWS_DB_NAME=$AWS_DB_NAME
AWS_DB_USER=$AWS_DB_USER
AWS_DB_PASSWORD=$AWS_DB_PASSWORD
AWS_DB_URL=$AWS_DB_URL
AWS_DB_SSL=$AWS_DB_SSL

# 本地隧道连接
LOCAL_AWS_DB_HOST=$LOCAL_AWS_DB_HOST
LOCAL_AWS_DB_PORT=$LOCAL_AWS_DB_PORT
LOCAL_AWS_DB_NAME=$LOCAL_AWS_DB_NAME
LOCAL_AWS_DB_USER=$LOCAL_AWS_DB_USER
LOCAL_AWS_DB_PASSWORD=$LOCAL_AWS_DB_PASSWORD
LOCAL_AWS_DB_URL=$LOCAL_AWS_DB_URL
LOCAL_AWS_DB_SSL=$LOCAL_AWS_DB_SSL

# 数据同步设置
SYNC_ENABLED=true
SYNC_INTERVAL_MINUTES=15
SYNC_BATCH_SIZE=1000
SYNC_RETRY_ATTEMPTS=3

# 数据清洗设置
CLEANING_ENABLED=true
CLEANING_TRIGGER_SYNC=true
CLEANING_BATCH_SIZE=100

# 监控设置
MONITORING_ENABLED=true
LOG_LEVEL=info
LOG_FILE=/tmp/aws_sync.log
EOF

echo -e "${GREEN}✓ Frontend环境变量文件已更新${NC}"

# 创建数据库连接配置文件
echo -e "${YELLOW}=== 创建数据库连接配置文件 ===${NC}"

cat > /Volumes/AI-hosts/RwaLendingPlatform/frontend-config/aws-database-config.ts << EOF
// AWS RDS 数据库连接配置
// 自动生成时间: $(date)

export const AWS_DATABASE_CONFIG = {
  // AWS RDS 直接连接配置
  aws: {
    host: process.env.AWS_DB_HOST || 'localhost',
    port: parseInt(process.env.AWS_DB_PORT || '5432'),
    database: process.env.AWS_DB_NAME || 'rwa_aws',
    username: process.env.AWS_DB_USER || 'rwa_admin',
    password: process.env.AWS_DB_PASSWORD || '',
    ssl: process.env.AWS_DB_SSL === 'true',
    connectionString: process.env.AWS_DB_URL
  },

  // 本地隧道连接配置
  localTunnel: {
    host: process.env.LOCAL_AWS_DB_HOST || 'localhost',
    port: parseInt(process.env.LOCAL_AWS_DB_PORT || '5433'),
    database: process.env.LOCAL_AWS_DB_NAME || 'rwa_aws',
    username: process.env.LOCAL_AWS_DB_USER || 'rwa_admin',
    password: process.env.LOCAL_AWS_DB_PASSWORD || '',
    ssl: process.env.LOCAL_AWS_DB_SSL === 'true',
    connectionString: process.env.LOCAL_AWS_DB_URL
  },

  // 本地数据库配置
  local: {
    host: process.env.LOCAL_DB_HOST || 'localhost',
    port: parseInt(process.env.LOCAL_DB_PORT || '5432'),
    database: process.env.LOCAL_DB_NAME || 'rwa_local',
    username: process.env.LOCAL_DB_USER || 'rwa',
    password: process.env.LOCAL_DB_PASSWORD || 'rwa_password',
    ssl: process.env.LOCAL_DB_SSL === 'true',
    connectionString: process.env.LOCAL_DB_URL
  }
};

// 数据同步配置
export const SYNC_CONFIG = {
  enabled: process.env.SYNC_ENABLED === 'true',
  intervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES || '15'),
  batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '1000'),
  retryAttempts: parseInt(process.env.SYNC_RETRY_ATTEMPTS || '3')
};

// 数据清洗配置
export const CLEANING_CONFIG = {
  enabled: process.env.CLEANING_ENABLED === 'true',
  triggerSync: process.env.CLEANING_TRIGGER_SYNC === 'true',
  batchSize: parseInt(process.env.CLEANING_BATCH_SIZE || '100')
};

// 监控配置
export const MONITORING_CONFIG = {
  enabled: process.env.MONITORING_ENABLED === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',
  logFile: process.env.LOG_FILE || '/tmp/aws_sync.log'
};
EOF

echo -e "${GREEN}✓ 数据库连接配置文件已创建${NC}"

# 创建启动脚本
echo -e "${YELLOW}=== 创建启动脚本 ===${NC}"

cat > /Volumes/AI-hosts/RwaLendingPlatform/scripts/deploy/start_aws_integration.sh << 'EOF'
#!/bin/bash

# AWS集成启动脚本
# 用于启动完整的AWS RDS集成服务

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== 启动AWS RDS集成服务 ===${NC}"
echo ""

# 检查配置文件
if [ ! -f "/tmp/aws_rds_config.env" ]; then
    echo -e "${RED}错误: 未找到AWS RDS配置文件${NC}"
    echo "请先运行: ./scripts/deploy/setup_aws_rds.sh"
    exit 1
fi

# 加载配置
source /tmp/aws_rds_config.env

# 启动SSH隧道
echo -e "${YELLOW}=== 启动SSH隧道 ===${NC}"
./scripts/deploy/setup_ssh_tunnel.sh

# 等待隧道建立
sleep 5

# 测试连接
echo -e "${YELLOW}=== 测试数据库连接 ===${NC}"
if nc -z localhost 5433 2>/dev/null; then
    echo -e "${GREEN}✓ AWS RDS连接正常${NC}"
else
    echo -e "${RED}❌ AWS RDS连接失败${NC}"
    exit 1
fi

# 启动数据同步
echo -e "${YELLOW}=== 启动数据同步 ===${NC}"
./scripts/deploy/setup_data_sync.sh

# 设置定时任务
echo -e "${YELLOW}=== 设置定时任务 ===${NC}"
/tmp/setup_cron_sync.sh

echo -e "${GREEN}✅ AWS RDS集成服务已启动${NC}"
echo ""
echo -e "${BLUE}=== 服务状态 ===${NC}"
echo "SSH隧道: 运行中"
echo "数据同步: 已配置"
echo "定时任务: 已设置"
echo ""
echo -e "${BLUE}=== 管理命令 ===${NC}"
echo "监控状态: /tmp/monitor_sync.sh"
echo "手动同步: /tmp/sync_aws_to_local.ts"
echo "停止隧道: kill \$(cat /tmp/aws_rds_tunnel.pid)"
EOF

chmod +x /Volumes/AI-hosts/RwaLendingPlatform/scripts/deploy/start_aws_integration.sh

echo -e "${GREEN}✓ 启动脚本已创建${NC}"

# 显示配置信息
echo ""
echo -e "${BLUE}=== 环境变量配置完成 ===${NC}"
echo "主环境变量: .env"
echo "Frontend环境变量: Frontend/.env"
echo "AWS专用配置: Frontend/.env.aws"
echo "数据库配置: frontend-config/aws-database-config.ts"
echo "启动脚本: scripts/deploy/start_aws_integration.sh"
echo ""
echo -e "${BLUE}=== 下一步操作 ===${NC}"
echo "1. 启动集成服务: ./scripts/deploy/start_aws_integration.sh"
echo "2. 监控服务状态: /tmp/monitor_sync.sh"
echo "3. 测试数据同步: /tmp/sync_aws_to_local.ts"
echo ""
echo -e "${YELLOW}⚠️  重要提醒:${NC}"
echo "- 确保所有配置文件已正确加载"
echo "- 定期检查环境变量配置"
echo "- 监控数据库连接状态"

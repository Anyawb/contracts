#!/bin/bash

# AWS数据收集系统部署脚本
# 用于在AWS EC2实例上设置24小时数据收集系统

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== AWS数据收集系统部署 ===${NC}"
echo ""

# 检查系统环境
echo -e "${YELLOW}=== 检查系统环境 ===${NC}"

# 检查操作系统
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo -e "${GREEN}✓ 操作系统: Linux${NC}"
else
    echo -e "${RED}❌ 不支持的操作系统: $OSTYPE${NC}"
    exit 1
fi

# 检查Node.js
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}安装Node.js...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

NODE_VERSION=$(node --version)
echo -e "${GREEN}✓ Node.js版本: $NODE_VERSION${NC}"

# 检查pnpm
if ! command -v pnpm &> /dev/null; then
    echo -e "${YELLOW}安装pnpm...${NC}"
    npm install -g pnpm
fi

PNPM_VERSION=$(pnpm --version)
echo -e "${GREEN}✓ pnpm版本: $PNPM_VERSION${NC}"

# 检查TypeScript
if ! command -v tsc &> /dev/null; then
    echo -e "${YELLOW}安装TypeScript...${NC}"
    npm install -g typescript
fi

TS_VERSION=$(tsc --version)
echo -e "${GREEN}✓ TypeScript版本: $TS_VERSION${NC}"

# 检查PostgreSQL客户端
if ! command -v psql &> /dev/null; then
    echo -e "${YELLOW}安装PostgreSQL客户端...${NC}"
    sudo apt-get update
    sudo apt-get install -y postgresql-client
fi

echo -e "${GREEN}✓ PostgreSQL客户端已安装${NC}"

# 检查AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${YELLOW}安装AWS CLI...${NC}"
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
    unzip awscliv2.zip
    sudo ./aws/install
    rm -rf awscliv2.zip aws/
fi

AWS_VERSION=$(aws --version)
echo -e "${GREEN}✓ AWS CLI版本: $AWS_VERSION${NC}"

# 创建项目目录结构
echo -e "${YELLOW}=== 创建项目目录结构 ===${NC}"

PROJECT_DIR="/home/ubuntu/RwaLendingPlatform"
mkdir -p "$PROJECT_DIR/Frontend/src/services/data"
mkdir -p "$PROJECT_DIR/Frontend/src/services/db"
mkdir -p "$PROJECT_DIR/Frontend/src/utils"
mkdir -p "$PROJECT_DIR/scripts"
mkdir -p "$PROJECT_DIR/logs"

echo -e "${GREEN}✓ 项目目录结构已创建${NC}"

# 设置权限
chown -R ubuntu:ubuntu "$PROJECT_DIR"
chmod -R 755 "$PROJECT_DIR"

echo -e "${GREEN}✓ 目录权限已设置${NC}"

# 创建监控脚本
echo -e "${YELLOW}=== 创建监控脚本 ===${NC}"

cat > "$PROJECT_DIR/scripts/monitor-collection.sh" << 'EOF'
#!/bin/bash

# 数据收集监控脚本

echo "=== AWS数据收集系统监控 ==="
echo "时间: $(date)"
echo ""

# 检查系统状态
echo "=== 系统状态 ==="
echo "CPU使用率: $(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)%"
echo "内存使用: $(free -h | grep "Mem:" | awk '{print $3"/"$2}')"
echo "磁盘使用: $(df -h / | tail -1 | awk '{print $5}')"
echo ""

# 检查Node.js进程
echo "=== Node.js进程 ==="
if pgrep -f "aws-collect-only" > /dev/null; then
    echo "✅ 数据收集进程: 运行中"
    echo "进程ID: $(pgrep -f "aws-collect-only")"
else
    echo "❌ 数据收集进程: 未运行"
fi
echo ""

# 检查定时任务
echo "=== 定时任务状态 ==="
if crontab -l 2>/dev/null | grep -q "aws-collect-only"; then
    echo "✅ 定时任务: 已配置"
    echo "定时任务详情:"
    crontab -l | grep "aws-collect-only"
else
    echo "❌ 定时任务: 未配置"
fi
echo ""

# 检查AWS RDS连接
echo "=== AWS RDS连接状态 ==="
if nc -z rwa-lending-platform-db.c76ouyg423x6.ap-northeast-1.rds.amazonaws.com 5432 2>/dev/null; then
    echo "✅ AWS RDS: 连接正常"
else
    echo "❌ AWS RDS: 连接失败"
fi
echo ""

# 检查收集日志
echo "=== 收集日志 ==="
LOG_FILE="/home/ubuntu/RwaLendingPlatform/logs/collection.log"
if [ -f "$LOG_FILE" ]; then
    echo "最近收集记录:"
    tail -10 "$LOG_FILE"
    echo ""
    echo "日志文件大小: $(du -h "$LOG_FILE" | cut -f1)"
else
    echo "暂无收集记录"
fi
echo ""

# 检查数据量
echo "=== 数据统计 ==="
if command -v psql >/dev/null 2>&1; then
    echo "AWS RDS数据统计:"
    PGPASSWORD='RwaAdmin123!' psql -h rwa-lending-platform-db.c76ouyg423x6.ap-northeast-1.rds.amazonaws.com -U rwa_admin -d rwa_aws -c "SELECT source, COUNT(*) as count FROM raw_data GROUP BY source;" 2>/dev/null || echo "无法连接数据库"
    
    echo ""
    echo "最新数据:"
    PGPASSWORD='RwaAdmin123!' psql -h rwa-lending-platform-db.c76ouyg423x6.ap-northeast-1.rds.amazonaws.com -U rwa_admin -d rwa_aws -c "SELECT source, external_id, created_at FROM raw_data ORDER BY created_at DESC LIMIT 5;" 2>/dev/null || echo "无法连接数据库"
else
    echo "psql未安装，无法检查数据统计"
fi
EOF

chmod +x "$PROJECT_DIR/scripts/monitor-collection.sh"
echo -e "${GREEN}✓ 监控脚本已创建${NC}"

# 创建数据清理脚本
echo -e "${YELLOW}=== 创建数据清理脚本 ===${NC}"

cat > "$PROJECT_DIR/scripts/cleanup-old-data.sh" << 'EOF'
#!/bin/bash

# 数据清理脚本
# 清理7天前的旧数据

export AWS_DB_HOST=rwa-lending-platform-db.c76ouyg423x6.ap-northeast-1.rds.amazonaws.com
export AWS_DB_PORT=5432
export AWS_DB_NAME=rwa_aws
export AWS_DB_USER=rwa_admin
export AWS_DB_PASSWORD=RwaAdmin123!

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
LOG_FILE="/home/ubuntu/RwaLendingPlatform/logs/collection.log"

echo "[$TIMESTAMP] 开始清理旧数据..." >> "$LOG_FILE"

if command -v psql >/dev/null 2>&1; then
    # 清理7天前的数据
    PGPASSWORD='RwaAdmin123!' psql -h rwa-lending-platform-db.c76ouyg423x6.ap-northeast-1.rds.amazonaws.com -U rwa_admin -d rwa_aws -c "DELETE FROM raw_data WHERE created_at < NOW() - INTERVAL '7 days';" >> "$LOG_FILE" 2>&1 || true
    
    # 清理失败记录
    PGPASSWORD='RwaAdmin123!' psql -h rwa-lending-platform-db.c76ouyg423x6.ap-northeast-1.rds.amazonaws.com -U rwa_admin -d rwa_aws -c "DELETE FROM etl_failures WHERE occurred_at < NOW() - INTERVAL '7 days';" >> "$LOG_FILE" 2>&1 || true
    
    echo "[$TIMESTAMP] 数据清理完成" >> "$LOG_FILE"
else
    echo "[$TIMESTAMP] psql未安装，跳过数据清理" >> "$LOG_FILE"
fi
EOF

chmod +x "$PROJECT_DIR/scripts/cleanup-old-data.sh"
echo -e "${GREEN}✓ 数据清理脚本已创建${NC}"

echo ""
echo -e "${BLUE}=== AWS数据收集系统部署完成 ===${NC}"
echo "项目目录: $PROJECT_DIR"
echo "监控脚本: $PROJECT_DIR/scripts/monitor-collection.sh"
echo "数据清理脚本: $PROJECT_DIR/scripts/cleanup-old-data.sh"
echo ""
echo -e "${GREEN}🎉 系统已准备就绪，等待GitHub Actions部署代码！${NC}"

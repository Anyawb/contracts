#!/bin/bash

# AWS RDS 数据库设置脚本
# 用于创建和管理AWS RDS PostgreSQL实例

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置变量
DB_INSTANCE_IDENTIFIER="rwa-lending-platform-db"
DB_NAME="rwa_aws"
DB_USERNAME="rwa_admin"
DB_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-25)
DB_INSTANCE_CLASS="db.t3.micro"
DB_ENGINE="postgres"
DB_ENGINE_VERSION="15.4"
DB_ALLOCATED_STORAGE="20"
DB_STORAGE_TYPE="gp2"

# 安全组配置
SECURITY_GROUP_NAME="rwa-db-sg"
VPC_ID=""
SUBNET_GROUP_NAME="rwa-db-subnet-group"

echo -e "${BLUE}=== AWS RDS 数据库设置脚本 ===${NC}"
echo ""

# 检查AWS CLI是否安装
if ! command -v aws &> /dev/null; then
    echo -e "${RED}错误: AWS CLI 未安装${NC}"
    echo "请先安装 AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
fi

# 检查AWS配置
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}错误: AWS 未配置或认证失败${NC}"
    echo "请运行: aws configure"
    exit 1
fi

echo -e "${GREEN}✓ AWS CLI 已配置${NC}"

# 获取默认VPC ID
if [ -z "$VPC_ID" ]; then
    VPC_ID=$(aws ec2 describe-vpcs --filters "Name=is-default,Values=true" --query "Vpcs[0].VpcId" --output text)
    if [ "$VPC_ID" = "None" ] || [ -z "$VPC_ID" ]; then
        echo -e "${RED}错误: 未找到默认VPC${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ 使用默认VPC: $VPC_ID${NC}"
fi

# 创建安全组
echo -e "${YELLOW}=== 创建安全组 ===${NC}"
SECURITY_GROUP_ID=$(aws ec2 create-security-group \
    --group-name "$SECURITY_GROUP_NAME" \
    --description "Security group for RWA Lending Platform database" \
    --vpc-id "$VPC_ID" \
    --query "GroupId" \
    --output text 2>/dev/null || echo "")

if [ -z "$SECURITY_GROUP_ID" ]; then
    # 安全组已存在，获取ID
    SECURITY_GROUP_ID=$(aws ec2 describe-security-groups \
        --group-names "$SECURITY_GROUP_NAME" \
        --query "SecurityGroups[0].GroupId" \
        --output text)
    echo -e "${GREEN}✓ 安全组已存在: $SECURITY_GROUP_ID${NC}"
else
    echo -e "${GREEN}✓ 创建安全组: $SECURITY_GROUP_ID${NC}"
fi

# 添加入站规则（PostgreSQL端口）
echo -e "${YELLOW}=== 配置安全组规则 ===${NC}"
aws ec2 authorize-security-group-ingress \
    --group-id "$SECURITY_GROUP_ID" \
    --protocol tcp \
    --port 5432 \
    --cidr 0.0.0.0/0 \
    --output text > /dev/null 2>&1 || echo "规则可能已存在"

echo -e "${GREEN}✓ 安全组规则已配置${NC}"

# 创建子网组
echo -e "${YELLOW}=== 创建子网组 ===${NC}"
SUBNET_IDS=$(aws ec2 describe-subnets \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query "Subnets[0:2].SubnetId" \
    --output text)

aws rds create-db-subnet-group \
    --db-subnet-group-name "$SUBNET_GROUP_NAME" \
    --db-subnet-group-description "Subnet group for RWA Lending Platform database" \
    --subnet-ids $SUBNET_IDS \
    --output text > /dev/null 2>&1 || echo "子网组可能已存在"

echo -e "${GREEN}✓ 子网组已配置${NC}"

# 创建RDS实例
echo -e "${YELLOW}=== 创建RDS实例 ===${NC}"
aws rds create-db-instance \
    --db-instance-identifier "$DB_INSTANCE_IDENTIFIER" \
    --db-instance-class "$DB_INSTANCE_CLASS" \
    --engine "$DB_ENGINE" \
    --engine-version "$DB_ENGINE_VERSION" \
    --allocated-storage "$DB_ALLOCATED_STORAGE" \
    --storage-type "$DB_STORAGE_TYPE" \
    --db-name "$DB_NAME" \
    --master-username "$DB_USERNAME" \
    --master-user-password "$DB_PASSWORD" \
    --vpc-security-group-ids "$SECURITY_GROUP_ID" \
    --db-subnet-group-name "$SUBNET_GROUP_NAME" \
    --backup-retention-period 7 \
    --multi-az false \
    --publicly-accessible true \
    --storage-encrypted true \
    --output text > /dev/null 2>&1 || echo "RDS实例可能已存在"

echo -e "${GREEN}✓ RDS实例创建中...${NC}"

# 等待实例可用
echo -e "${YELLOW}=== 等待实例可用 ===${NC}"
aws rds wait db-instance-available --db-instance-identifier "$DB_INSTANCE_IDENTIFIER"

# 获取端点信息
DB_ENDPOINT=$(aws rds describe-db-instances \
    --db-instance-identifier "$DB_INSTANCE_IDENTIFIER" \
    --query "DBInstances[0].Endpoint.Address" \
    --output text)

DB_PORT=$(aws rds describe-db-instances \
    --db-instance-identifier "$DB_INSTANCE_IDENTIFIER" \
    --query "DBInstances[0].Endpoint.Port" \
    --output text)

echo -e "${GREEN}✓ RDS实例已可用${NC}"

# 创建连接配置文件
echo -e "${YELLOW}=== 创建连接配置 ===${NC}"
cat > /tmp/aws_rds_config.env << EOF
# AWS RDS 数据库配置
AWS_DB_HOST=$DB_ENDPOINT
AWS_DB_PORT=$DB_PORT
AWS_DB_NAME=$DB_NAME
AWS_DB_USER=$DB_USERNAME
AWS_DB_PASSWORD=$DB_PASSWORD
AWS_DB_URL=postgres://$DB_USERNAME:$DB_PASSWORD@$DB_ENDPOINT:$DB_PORT/$DB_NAME
AWS_DB_SSL=true

# 本地数据库配置（用于同步）
LOCAL_DB_HOST=localhost
LOCAL_DB_PORT=5432
LOCAL_DB_NAME=rwa_local
LOCAL_DB_USER=rwa
LOCAL_DB_PASSWORD=rwa_password
LOCAL_DB_URL=postgres://rwa:rwa_password@localhost:5432/rwa_local
LOCAL_DB_SSL=false
EOF

echo -e "${GREEN}✓ 配置文件已创建${NC}"

# 显示配置信息
echo ""
echo -e "${BLUE}=== AWS RDS 配置完成 ===${NC}"
echo "数据库标识符: $DB_INSTANCE_IDENTIFIER"
echo "数据库端点: $DB_ENDPOINT"
echo "数据库端口: $DB_PORT"
echo "数据库名称: $DB_NAME"
echo "数据库用户: $DB_USERNAME"
echo "数据库密码: $DB_PASSWORD"
echo ""
echo -e "${BLUE}=== 连接信息 ===${NC}"
echo "连接字符串: postgres://$DB_USERNAME:$DB_PASSWORD@$DB_ENDPOINT:$DB_PORT/$DB_NAME"
echo ""
echo -e "${BLUE}=== 下一步操作 ===${NC}"
echo "1. 配置SSH隧道: ./scripts/deploy/setup_ssh_tunnel.sh"
echo "2. 设置数据同步: ./scripts/deploy/setup_data_sync.sh"
echo "3. 测试连接: ./scripts/deploy/test_aws_connection.sh"
echo ""
echo -e "${YELLOW}⚠️  重要提醒:${NC}"
echo "- 请妥善保存数据库密码"
echo "- 生产环境建议启用SSL"
echo "- 定期备份数据库"
echo "- 监控数据库使用量（免费额度限制）"

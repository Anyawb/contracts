#!/bin/bash

# AWS EC2 部署配置设置脚本

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查 AWS CLI
check_aws_cli() {
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI 未安装，请先安装 AWS CLI"
        echo "安装方法："
        echo "  macOS: brew install awscli"
        echo "  Ubuntu: sudo apt-get install awscli"
        echo "  Windows: 下载并安装 AWS CLI"
        exit 1
    fi
    
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS 认证失败，请运行 'aws configure'"
        exit 1
    fi
    
    log_success "AWS CLI 配置正确"
}

# 获取当前用户信息
get_user_info() {
    log_info "获取当前 AWS 用户信息..."
    
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    USER_ARN=$(aws sts get-caller-identity --query Arn --output text)
    REGION=$(aws configure get region)
    REGION=${REGION:-ap-southeast-1}
    
    echo "Account ID: $ACCOUNT_ID"
    echo "User ARN: $USER_ARN"
    echo "Region: $REGION"
}

# 获取 VPC 信息
get_vpc_info() {
    log_info "获取 VPC 信息..."
    
    echo "可用的 VPC:"
    aws ec2 describe-vpcs \
        --query 'Vpcs[*].[VpcId,Tags[?Key==`Name`].Value|[0],CidrBlock,State]' \
        --output table
    
    echo ""
    read -p "请输入要使用的 VPC ID: " VPC_ID
    
    if [ -z "$VPC_ID" ]; then
        log_error "VPC ID 不能为空"
        exit 1
    fi
    
    # 验证 VPC 存在
    if ! aws ec2 describe-vpcs --vpc-ids $VPC_ID &> /dev/null; then
        log_error "VPC ID $VPC_ID 不存在"
        exit 1
    fi
    
    log_success "VPC ID: $VPC_ID"
}

# 获取子网信息
get_subnet_info() {
    log_info "获取子网信息..."
    
    echo "可用的子网:"
    aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=$VPC_ID" \
        --query 'Subnets[*].[SubnetId,Tags[?Key==`Name`].Value|[0],CidrBlock,AvailabilityZone]' \
        --output table
    
    echo ""
    read -p "请输入要使用的子网 ID: " SUBNET_ID
    
    if [ -z "$SUBNET_ID" ]; then
        log_error "子网 ID 不能为空"
        exit 1
    fi
    
    # 验证子网存在
    if ! aws ec2 describe-subnets --subnet-ids $SUBNET_ID &> /dev/null; then
        log_error "子网 ID $SUBNET_ID 不存在"
        exit 1
    fi
    
    log_success "子网 ID: $SUBNET_ID"
}

# 获取密钥对信息
get_keypair_info() {
    log_info "获取密钥对信息..."
    
    echo "可用的密钥对:"
    aws ec2 describe-key-pairs \
        --query 'KeyPairs[*].[KeyName,KeyFingerprint]' \
        --output table
    
    echo ""
    read -p "请输入要使用的密钥对名称: " KEY_NAME
    
    if [ -z "$KEY_NAME" ]; then
        log_error "密钥对名称不能为空"
        exit 1
    fi
    
    # 验证密钥对存在
    if ! aws ec2 describe-key-pairs --key-names $KEY_NAME &> /dev/null; then
        log_error "密钥对 $KEY_NAME 不存在"
        exit 1
    fi
    
    log_success "密钥对: $KEY_NAME"
}

# SSH 访问模式说明：
# - key_only: 22端口对公网开放，但仅允许密钥登录（不安全，易被扫描；满足“IP不稳定”的诉求）
# - ssm: 关闭22端口，通过SSM Session Manager登录（推荐，更安全）
# 如需切换，可编辑生成的 /tmp/ec2-deployment-config.env 中的 SSH_ACCESS_MODE

# 生成配置文件
generate_config() {
    log_info "生成部署配置文件..."
    
    cat > /tmp/ec2-deployment-config.env << EOF
# AWS EC2 部署配置
# 生成时间: $(date)

# 基本配置
export AWS_REGION=$REGION
export KEY_NAME=$KEY_NAME
export VPC_ID=$VPC_ID
export SUBNET_ID=$SUBNET_ID

# SSH 访问模式: key_only 或 ssm
export SSH_ACCESS_MODE=key_only

# 实例配置
export AI_INSTANCE_TYPE=g5.xlarge
export APP_INSTANCE_TYPE=t3.medium

# IAM 配置
export EC2_INSTANCE_PROFILE=rwa-instance-profile

# 项目配置
export PROJECT_NAME=rwa-lending-platform
export ENVIRONMENT=production

# 模型配置
export MODEL_S3_BUCKET=rwa-models
export MODEL_S3_PATH=s3://rwa-models/models/deepseek-0528/

# 数据库配置
export DB_NAME=rwa_production
export DB_USER=rwa_user
export DB_PASSWORD=\$(openssl rand -base64 32)

# Redis 配置
export REDIS_PASSWORD=\$(openssl rand -base64 32)

# JWT 配置
export JWT_SECRET=\$(openssl rand -base64 64)

# API 密钥（需要手动设置）
export DEEPSEEK_API_KEY=your_deepseek_api_key_here
export OPENAI_API_KEY=your_openai_api_key_here

echo "配置文件已生成: /tmp/ec2-deployment-config.env"
echo "请运行: source /tmp/ec2-deployment-config.env"
EOF
    
    log_success "配置文件已生成: /tmp/ec2-deployment-config.env"
}

# 显示下一步操作
show_next_steps() {
    echo ""
    echo "=== 下一步操作 ==="
    echo "1. 运行配置脚本:"
    echo "   source /tmp/ec2-deployment-config.env"
    echo ""
    echo "2. 创建 EC2 实例:"
    echo "   ./scripts/deploy/create-ec2-instances.sh"
    echo ""
    echo "3. 配置 AI 实例 (Phase 2):"
    echo "   ssh -i ~/.ssh/$KEY_NAME.pem ubuntu@\$AI_PUBLIC_IP"
    echo ""
    echo "4. 配置 APP 实例 (Phase 3):"
    echo "   ssh -i ~/.ssh/$KEY_NAME.pem ubuntu@\$APP_PUBLIC_IP"
    echo ""
    echo "5. 按照 EC2_DEPLOYMENT_GUIDE.md 继续执行后续步骤"
}

# 主函数
main() {
    log_info "开始配置 AWS EC2 部署环境..."
    
    check_aws_cli
    get_user_info
    get_vpc_info
    get_subnet_info
    get_keypair_info
    generate_config
    show_next_steps
    
    log_success "配置完成！"
}

# 执行主函数
main "$@"

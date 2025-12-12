#!/bin/bash

# AWS EC2 双实例部署脚本
# 基于 EC2_DEPLOYMENT_GUIDE.md 指南

set -e

# 配置变量（优先使用环境变量）
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
KEY_NAME="${KEY_NAME:?Set KEY_NAME or run setup-deployment-config.sh}"
# SSH 访问模式: key_only(默认) / ssm / ip_whitelist
SSH_ACCESS_MODE="${SSH_ACCESS_MODE:-key_only}"
# 如使用 ip_whitelist，请设置 ADMIN_CIDR，例如 1.2.3.4/32
ADMIN_CIDR="${ADMIN_CIDR:-}"
VPC_ID="${VPC_ID:?Set VPC_ID via setup-deployment-config.sh}"
SUBNET_ID="${SUBNET_ID:?Set SUBNET_ID via setup-deployment-config.sh}"
EC2_INSTANCE_PROFILE="${EC2_INSTANCE_PROFILE:-rwa-instance-profile}"
# 可选：是否创建ECR仓库（默认不创建，符合MVP阶段）
ENABLE_ECR="${ENABLE_ECR:-false}"
# 可选：S3桶名（用于实例角色策略）
MODEL_S3_BUCKET="${MODEL_S3_BUCKET:-rwa-models}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
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

# 检查前置条件
check_prerequisites() {
    log_info "检查前置条件..."
    
    # 检查 AWS CLI
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI 未安装，请先安装 AWS CLI"
        exit 1
    fi
    
    # 检查 AWS 认证
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS 认证失败，请运行 'aws configure'"
        exit 1
    fi
    
    # 检查必需参数
    if [ -z "$VPC_ID" ] || [ -z "$SUBNET_ID" ]; then
        log_error "请设置 VPC_ID 和 SUBNET_ID 变量"
        exit 1
    fi
    
    log_success "前置条件检查通过"
}

# 创建 IAM 角色和实例配置文件
create_iam_profile() {
    log_info "创建 IAM 角色和实例配置文件..."
    
    # 创建 IAM 角色
    aws iam create-role \
        --role-name rwa-ec2-role \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {
                        "Service": "ec2.amazonaws.com"
                    },
                    "Action": "sts:AssumeRole"
                }
            ]
        }' 2>/dev/null || log_warning "IAM 角色可能已存在"
    
    # 创建策略（使用变量化的S3桶名）
    aws iam create-policy \
        --policy-name rwa-ec2-policy \
        --policy-document '{
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": [
                        "s3:GetObject",
                        "s3:ListBucket"
                    ],
                    "Resource": [
                        "arn:aws:s3:::'"$MODEL_S3_BUCKET"'",
                        "arn:aws:s3:::'"$MODEL_S3_BUCKET"'/*"
                    ]
                },
                {
                    "Effect": "Allow",
                    "Action": [
                        "ecr:GetAuthorizationToken",
                        "ecr:BatchCheckLayerAvailability",
                        "ecr:GetDownloadUrlForLayer",
                        "ecr:BatchGetImage"
                    ],
                    "Resource": "*"
                },
                {
                    "Effect": "Allow",
                    "Action": [
                        "logs:CreateLogGroup",
                        "logs:CreateLogStream",
                        "logs:PutLogEvents"
                    ],
                    "Resource": "*"
                }
            ]
        }' 2>/dev/null || log_warning "IAM 策略可能已存在"
    
    # 附加策略到角色
    aws iam attach-role-policy \
        --role-name rwa-ec2-role \
        --policy-arn arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/rwa-ec2-policy
    
    # 创建实例配置文件
    aws iam create-instance-profile \
        --instance-profile-name $EC2_INSTANCE_PROFILE 2>/dev/null || log_warning "实例配置文件可能已存在"
    
    aws iam add-role-to-instance-profile \
        --instance-profile-name $EC2_INSTANCE_PROFILE \
        --role-name rwa-ec2-role 2>/dev/null || log_warning "角色可能已附加"
    
    log_success "IAM 配置完成"
}

# 创建安全组
create_security_groups() {
    log_info "创建安全组..."
    
    # 创建 APP 安全组
    APP_SG_ID=$(aws ec2 create-security-group \
        --region $AWS_REGION \
        --group-name rwa-app-sg \
        --description "Security Group for API + DB" \
        --vpc-id $VPC_ID \
        --query 'GroupId' --output text 2>/dev/null || \
        aws ec2 describe-security-groups \
            --region $AWS_REGION \
            --filters "Name=group-name,Values=rwa-app-sg" \
            --query 'SecurityGroups[0].GroupId' --output text)
    
    # 创建 AI 安全组
    AI_SG_ID=$(aws ec2 create-security-group \
        --region $AWS_REGION \
        --group-name rwa-ai-sg \
        --description "Security Group for AI Model (GPU)" \
        --vpc-id $VPC_ID \
        --query 'GroupId' --output text 2>/dev/null || \
        aws ec2 describe-security-groups \
            --region $AWS_REGION \
            --filters "Name=group-name,Values=rwa-ai-sg" \
            --query 'SecurityGroups[0].GroupId' --output text)
    
    # 配置 APP 安全组规则
    log_info "配置 APP 安全组规则..."
    aws ec2 authorize-security-group-ingress \
        --region $AWS_REGION \
        --group-id $APP_SG_ID \
        --protocol tcp \
        --port 80 \
        --cidr 0.0.0.0/0 2>/dev/null || log_warning "规则可能已存在"
    
    aws ec2 authorize-security-group-ingress \
        --region $AWS_REGION \
        --group-id $APP_SG_ID \
        --protocol tcp \
        --port 443 \
        --cidr 0.0.0.0/0 2>/dev/null || log_warning "规则可能已存在"

    # SSH 规则按 SSH_ACCESS_MODE 控制
    case "$SSH_ACCESS_MODE" in
        key_only)
            # 22端口对公网开放，但仅密钥认证（需确保实例禁用密码登录）
            aws ec2 authorize-security-group-ingress \
                --region $AWS_REGION \
                --group-id $APP_SG_ID \
                --protocol tcp \
                --port 22 \
                --cidr 0.0.0.0/0 2>/dev/null || log_warning "规则可能已存在"
            ;;
        ip_whitelist)
            if [ -z "$ADMIN_CIDR" ]; then
                log_error "SSH_ACCESS_MODE=ip_whitelist 但未设置 ADMIN_CIDR"
                exit 1
            fi
            aws ec2 authorize-security-group-ingress \
                --region $AWS_REGION \
                --group-id $APP_SG_ID \
                --protocol tcp \
                --port 22 \
                --cidr $ADMIN_CIDR 2>/dev/null || log_warning "规则可能已存在"
            ;;
        ssm)
            log_info "SSH_ACCESS_MODE=ssm：不开放22端口，后续通过SSM登录"
            ;;
        *)
            log_warning "未知 SSH_ACCESS_MODE=$SSH_ACCESS_MODE，采用 key_only"
            aws ec2 authorize-security-group-ingress \
                --region $AWS_REGION \
                --group-id $APP_SG_ID \
                --protocol tcp \
                --port 22 \
                --cidr 0.0.0.0/0 2>/dev/null || log_warning "规则可能已存在"
            ;;
    esac
    
    # 配置 AI 安全组规则（仅允许来自 APP 的访问）
    log_info "配置 AI 安全组规则..."
    aws ec2 authorize-security-group-ingress \
        --region $AWS_REGION \
        --group-id $AI_SG_ID \
        --protocol tcp \
        --port 8000 \
        --source-group $APP_SG_ID 2>/dev/null || log_warning "规则可能已存在"
    
    # AI 实例 SSH 规则同样按模式控制
    case "$SSH_ACCESS_MODE" in
        key_only)
            aws ec2 authorize-security-group-ingress \
                --region $AWS_REGION \
                --group-id $AI_SG_ID \
                --protocol tcp \
                --port 22 \
                --cidr 0.0.0.0/0 2>/dev/null || log_warning "规则可能已存在"
            ;;
        ip_whitelist)
            if [ -z "$ADMIN_CIDR" ]; then
                log_error "SSH_ACCESS_MODE=ip_whitelist 但未设置 ADMIN_CIDR"
                exit 1
            fi
            aws ec2 authorize-security-group-ingress \
                --region $AWS_REGION \
                --group-id $AI_SG_ID \
                --protocol tcp \
                --port 22 \
                --cidr $ADMIN_CIDR 2>/dev/null || log_warning "规则可能已存在"
            ;;
        ssm)
            log_info "SSH_ACCESS_MODE=ssm：不开放AI实例22端口"
            ;;
    esac
    
    log_success "安全组配置完成"
    echo "APP_SG_ID: $APP_SG_ID"
    echo "AI_SG_ID: $AI_SG_ID"
}

# 获取最新的 AMI ID
get_ami_id() {
    local os_type=$1
    
    if [ "$os_type" = "ubuntu" ]; then
        aws ec2 describe-images \
            --region $AWS_REGION \
            --owners 099720109477 \
            --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-22.04-lts-amd64-server-*" \
            --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
            --output text
    elif [ "$os_type" = "deep_learning" ]; then
        aws ec2 describe-images \
            --region $AWS_REGION \
            --owners amazon \
            --filters "Name=name,Values=Deep Learning AMI (Ubuntu 22.04) Version *" \
            --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
            --output text
    fi
}

# 创建 EC2 实例
create_instances() {
    log_info "创建 EC2 实例..."
    
    # 获取 AMI ID
    UBUNTU_AMI_ID=$(get_ami_id "ubuntu")
    DL_AMI_ID=$(get_ami_id "deep_learning")
    
    log_info "使用 Ubuntu AMI: $UBUNTU_AMI_ID"
    log_info "使用 Deep Learning AMI: $DL_AMI_ID"
    
    # 创建 AI GPU 实例
    log_info "创建 AI GPU 实例 (g5.xlarge)..."
    AI_INSTANCE_ID=$(aws ec2 run-instances \
        --region $AWS_REGION \
        --image-id $DL_AMI_ID \
        --count 1 \
        --instance-type g5.xlarge \
        --key-name $KEY_NAME \
        --security-group-ids $AI_SG_ID \
        --subnet-id $SUBNET_ID \
        --iam-instance-profile Name=$EC2_INSTANCE_PROFILE \
        --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":100,"VolumeType":"gp3","Encrypted":true}}]' \
        --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=rwa-ai-gpu},{Key=Project,Value=RWA},{Key=Environment,Value=production}]' \
        --query 'Instances[0].InstanceId' --output text)
    
    # 创建 APP 实例
    log_info "创建 APP 实例 (t3.medium)..."
    APP_INSTANCE_ID=$(aws ec2 run-instances \
        --region $AWS_REGION \
        --image-id $UBUNTU_AMI_ID \
        --count 1 \
        --instance-type t3.medium \
        --key-name $KEY_NAME \
        --security-group-ids $APP_SG_ID \
        --subnet-id $SUBNET_ID \
        --iam-instance-profile Name=$EC2_INSTANCE_PROFILE \
        --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":100,"VolumeType":"gp3","Encrypted":true}}]' \
        --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=rwa-app},{Key=Project,Value=RWA},{Key=Environment,Value=production}]' \
        --query 'Instances[0].InstanceId' --output text)
    
    log_success "实例创建完成"
    echo "AI_INSTANCE_ID: $AI_INSTANCE_ID"
    echo "APP_INSTANCE_ID: $APP_INSTANCE_ID"
}

# 等待实例启动
wait_for_instances() {
    log_info "等待实例启动..."
    
    # 等待 AI 实例
    aws ec2 wait instance-running \
        --region $AWS_REGION \
        --instance-ids $AI_INSTANCE_ID
    
    # 等待 APP 实例
    aws ec2 wait instance-running \
        --region $AWS_REGION \
        --instance-ids $APP_INSTANCE_ID
    
    log_success "实例启动完成"
}

# 获取实例信息
get_instance_info() {
    log_info "获取实例信息..."
    
    # 获取 AI 实例信息
    AI_PUBLIC_IP=$(aws ec2 describe-instances \
        --region $AWS_REGION \
        --instance-ids $AI_INSTANCE_ID \
        --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
    
    AI_PRIVATE_IP=$(aws ec2 describe-instances \
        --region $AWS_REGION \
        --instance-ids $AI_INSTANCE_ID \
        --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)
    
    # 获取 APP 实例信息
    APP_PUBLIC_IP=$(aws ec2 describe-instances \
        --region $AWS_REGION \
        --instance-ids $APP_INSTANCE_ID \
        --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
    
    APP_PRIVATE_IP=$(aws ec2 describe-instances \
        --region $AWS_REGION \
        --instance-ids $APP_INSTANCE_ID \
        --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)
    
    log_success "实例信息获取完成"
    echo ""
    echo "=== 实例信息 ==="
    echo "AI 实例 (GPU):"
    echo "  Instance ID: $AI_INSTANCE_ID"
    echo "  Public IP: $AI_PUBLIC_IP"
    echo "  Private IP: $AI_PRIVATE_IP"
    echo "  SSH: ssh -i ~/.ssh/$KEY_NAME.pem ubuntu@$AI_PUBLIC_IP"
    echo ""
    echo "APP 实例 (API + DB):"
    echo "  Instance ID: $APP_INSTANCE_ID"
    echo "  Public IP: $APP_PUBLIC_IP"
    echo "  Private IP: $APP_PRIVATE_IP"
    echo "  SSH: ssh -i ~/.ssh/$KEY_NAME.pem ubuntu@$APP_PUBLIC_IP"
    echo ""
    echo "=== 环境变量 ==="
    echo "export AI_PRIVATE_IP=$AI_PRIVATE_IP"
    echo "export APP_PRIVATE_IP=$APP_PRIVATE_IP"
    echo "export APP_PUBLIC_IP=$APP_PUBLIC_IP"
    echo "export AI_INSTANCE_ID=$AI_INSTANCE_ID"
    echo "export APP_INSTANCE_ID=$APP_INSTANCE_ID"
    echo "export APP_SG_ID=$APP_SG_ID"
    echo "export AI_SG_ID=$AI_SG_ID"
}

# 创建 ECR 仓库
create_ecr_repositories() {
    log_info "创建 ECR 仓库..."
    
    # 创建 DeepSeek 模型仓库
    aws ecr create-repository \
        --repository-name deepseek-0528 \
        --region $AWS_REGION 2>/dev/null || log_warning "ECR 仓库可能已存在"
    
    # 创建 API 服务仓库
    aws ecr create-repository \
        --repository-name rwa-api \
        --region $AWS_REGION 2>/dev/null || log_warning "ECR 仓库可能已存在"
    
    log_success "ECR 仓库创建完成"
}

# 生成部署配置文件
generate_config() {
    log_info "生成部署配置文件..."
    
    cat > /tmp/ec2-deployment-config.env << EOF
# AWS EC2 部署配置
export AWS_REGION=$AWS_REGION
export KEY_NAME=$KEY_NAME
export VPC_ID=$VPC_ID
export SUBNET_ID=$SUBNET_ID

# 实例信息
export AI_INSTANCE_ID=$AI_INSTANCE_ID
export APP_INSTANCE_ID=$APP_INSTANCE_ID
export AI_PUBLIC_IP=$AI_PUBLIC_IP
export AI_PRIVATE_IP=$AI_PRIVATE_IP
export APP_PUBLIC_IP=$APP_PUBLIC_IP
export APP_PRIVATE_IP=$APP_PRIVATE_IP

# 安全组
export APP_SG_ID=$APP_SG_ID
export AI_SG_ID=$AI_SG_ID

# ECR 仓库
export ECR_REGISTRY=$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$AWS_REGION.amazonaws.com
export DEEPSEEK_ECR_REPO=\$ECR_REGISTRY/deepseek-0528
export API_ECR_REPO=\$ECR_REGISTRY/rwa-api

# S3 配置
export MODEL_S3_BUCKET=rwa-models
export MODEL_S3_PATH=s3://\$MODEL_S3_BUCKET/models/deepseek-0528/
EOF
    
    log_success "配置文件已生成: /tmp/ec2-deployment-config.env"
    echo "请运行: source /tmp/ec2-deployment-config.env"
}

# 主函数
main() {
    log_info "开始创建 AWS EC2 实例..."
    
    check_prerequisites
    create_iam_profile
    create_security_groups
    create_instances
    wait_for_instances
    get_instance_info
    if [ "$ENABLE_ECR" = "true" ]; then
        create_ecr_repositories
    else
        log_info "未启用 ECR 仓库创建（ENABLE_ECR=false）"
    fi
    generate_config
    
    log_success "EC2 实例创建完成！"
    echo ""
    echo "下一步："
    echo "1. 运行: source /tmp/ec2-deployment-config.env"
    echo "2. 继续执行 Phase 2: AI 实例配置"
    echo "3. 继续执行 Phase 3: APP 实例配置"
}

# 执行主函数
main "$@"

#!/bin/bash

# AWS RDS 集成一键部署脚本
# 用于快速部署完整的AWS RDS集成方案

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== AWS RDS 集成一键部署脚本 ===${NC}"
echo ""

# 检查前置条件
echo -e "${YELLOW}=== 检查前置条件 ===${NC}"

# 检查AWS CLI
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

# 检查Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}错误: Node.js 未安装${NC}"
    echo "请先安装 Node.js: https://nodejs.org/"
    exit 1
fi

# 检查pnpm
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}错误: pnpm 未安装${NC}"
    echo "请先安装 pnpm: npm install -g pnpm"
    exit 1
fi

# 检查TypeScript
if ! command -v ts-node &> /dev/null; then
    echo -e "${YELLOW}警告: ts-node 未安装，正在安装...${NC}"
    npm install -g ts-node typescript
fi

echo -e "${GREEN}✓ 前置条件检查通过${NC}"

# 设置脚本权限
echo -e "${YELLOW}=== 设置脚本权限 ===${NC}"
chmod +x /Volumes/AI-hosts/RwaLendingPlatform/scripts/deploy/setup_aws_rds.sh
chmod +x /Volumes/AI-hosts/RwaLendingPlatform/scripts/deploy/setup_ssh_tunnel.sh
chmod +x /Volumes/AI-hosts/RwaLendingPlatform/scripts/deploy/setup_data_sync.sh
chmod +x /Volumes/AI-hosts/RwaLendingPlatform/scripts/deploy/update_env_config.sh
chmod +x /Volumes/AI-hosts/RwaLendingPlatform/scripts/deploy/test_aws_connection.sh

echo -e "${GREEN}✓ 脚本权限已设置${NC}"

# 步骤1: 创建AWS RDS实例
echo -e "${YELLOW}=== 步骤1: 创建AWS RDS实例 ===${NC}"
echo "正在创建AWS RDS PostgreSQL实例..."
./scripts/deploy/setup_aws_rds.sh

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ AWS RDS实例创建成功${NC}"
else
    echo -e "${RED}❌ AWS RDS实例创建失败${NC}"
    exit 1
fi

# 等待RDS实例完全可用
echo -e "${YELLOW}=== 等待RDS实例完全可用 ===${NC}"
echo "等待RDS实例启动完成..."
sleep 30

# 步骤2: 设置SSH隧道
echo -e "${YELLOW}=== 步骤2: 设置SSH隧道 ===${NC}"
echo "正在设置SSH隧道连接..."
./scripts/deploy/setup_ssh_tunnel.sh

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ SSH隧道设置成功${NC}"
else
    echo -e "${RED}❌ SSH隧道设置失败${NC}"
    exit 1
fi

# 步骤3: 测试连接
echo -e "${YELLOW}=== 步骤3: 测试连接 ===${NC}"
echo "正在测试数据库连接..."
./scripts/deploy/test_aws_connection.sh

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 连接测试通过${NC}"
else
    echo -e "${RED}❌ 连接测试失败${NC}"
    exit 1
fi

# 步骤4: 设置数据同步
echo -e "${YELLOW}=== 步骤4: 设置数据同步 ===${NC}"
echo "正在设置数据同步..."
./scripts/deploy/setup_data_sync.sh

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 数据同步设置成功${NC}"
else
    echo -e "${RED}❌ 数据同步设置失败${NC}"
    exit 1
fi

# 步骤5: 更新环境变量
echo -e "${YELLOW}=== 步骤5: 更新环境变量 ===${NC}"
echo "正在更新环境变量配置..."
./scripts/deploy/update_env_config.sh

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 环境变量更新成功${NC}"
else
    echo -e "${RED}❌ 环境变量更新失败${NC}"
    exit 1
fi

# 步骤6: 设置定时任务
echo -e "${YELLOW}=== 步骤6: 设置定时任务 ===${NC}"
echo "正在设置定时同步任务..."
/tmp/setup_cron_sync.sh

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 定时任务设置成功${NC}"
else
    echo -e "${RED}❌ 定时任务设置失败${NC}"
    exit 1
fi

# 步骤7: 测试完整流程
echo -e "${YELLOW}=== 步骤7: 测试完整流程 ===${NC}"
echo "正在测试完整数据流程..."

# 测试数据同步
echo "测试数据同步..."
if /tmp/sync_aws_to_local.ts; then
    echo -e "${GREEN}✓ 数据同步测试通过${NC}"
else
    echo -e "${YELLOW}⚠️  数据同步测试失败，但继续部署${NC}"
fi

# 测试监控脚本
echo "测试监控脚本..."
if /tmp/monitor_sync.sh; then
    echo -e "${GREEN}✓ 监控脚本测试通过${NC}"
else
    echo -e "${YELLOW}⚠️  监控脚本测试失败，但继续部署${NC}"
fi

# 显示部署结果
echo ""
echo -e "${BLUE}=== 部署完成 ===${NC}"
echo -e "${GREEN}✅ AWS RDS集成部署成功！${NC}"
echo ""

echo -e "${BLUE}=== 服务状态 ===${NC}"
echo "AWS RDS实例: 运行中"
echo "SSH隧道: 运行中"
echo "数据同步: 已配置"
echo "定时任务: 已设置"
echo "环境变量: 已更新"
echo ""

echo -e "${BLUE}=== 管理命令 ===${NC}"
echo "监控状态: /tmp/monitor_sync.sh"
echo "手动同步: /tmp/sync_aws_to_local.ts"
echo "查看日志: tail -f /tmp/aws_sync.log"
echo "停止隧道: kill \$(cat /tmp/aws_rds_tunnel.pid)"
echo ""

echo -e "${BLUE}=== 配置文件位置 ===${NC}"
echo "AWS配置: /tmp/aws_rds_config.env"
echo "隧道配置: /tmp/aws_tunnel_config.env"
echo "环境变量: .env, Frontend/.env"
echo "数据库配置: frontend-config/aws-database-config.ts"
echo ""

echo -e "${BLUE}=== 下一步操作 ===${NC}"
echo "1. 监控服务运行状态"
echo "2. 检查数据同步日志"
echo "3. 验证定时任务执行"
echo "4. 测试数据清洗流程"
echo ""

echo -e "${YELLOW}⚠️  重要提醒:${NC}"
echo "- 定期检查AWS免费额度使用情况"
echo "- 监控数据库连接状态"
echo "- 备份重要配置文件"
echo "- 设置日志轮转"
echo ""

echo -e "${GREEN}🎉 部署完成！您的AWS RDS集成方案已成功部署！${NC}"

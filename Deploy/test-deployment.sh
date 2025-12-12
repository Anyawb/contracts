#!/bin/bash

# 部署测试脚本
# 用于测试GitHub Actions部署到AWS EC2的流程

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== 部署测试脚本 ===${NC}"
echo ""

# 检查GitHub Actions工作流文件
echo -e "${YELLOW}=== 检查GitHub Actions工作流 ===${NC}"

if [ -f ".github/workflows/deploy-data-collection.yml" ]; then
    echo -e "${GREEN}✓ 数据收集部署工作流已创建${NC}"
else
    echo -e "${RED}❌ 数据收集部署工作流不存在${NC}"
    exit 1
fi

# 检查部署脚本
echo -e "${YELLOW}=== 检查部署脚本 ===${NC}"

DEPLOY_SCRIPTS=(
    "scripts/deploy/setup-data-collection.sh"
    "scripts/deploy/setup-aws-cron.sh"
    "scripts/deploy/env.production"
)

for script in "${DEPLOY_SCRIPTS[@]}"; do
    if [ -f "$script" ]; then
        echo -e "${GREEN}✓ $script${NC}"
    else
        echo -e "${RED}❌ $script 不存在${NC}"
        exit 1
    fi
done

# 检查数据收集脚本
echo -e "${YELLOW}=== 检查数据收集脚本 ===${NC}"

COLLECTION_SCRIPTS=(
    "scripts/aws-collect-only.ts"
    "scripts/aws-data-collection.ts"
    "scripts/aws-simple-collection.ts"
    "scripts/start-24h-collection.sh"
    "scripts/aws-cron-setup.sh"
)

for script in "${COLLECTION_SCRIPTS[@]}"; do
    if [ -f "$script" ]; then
        echo -e "${GREEN}✓ $script${NC}"
    else
        echo -e "${RED}❌ $script 不存在${NC}"
        exit 1
    fi
done

# 检查前端服务
echo -e "${YELLOW}=== 检查前端服务 ===${NC}"

FRONTEND_SERVICES=(
    "Frontend/src/services/data/coingeckoService.ts"
    "Frontend/src/services/data/messariService.ts"
    "Frontend/src/services/data/tokenTerminalService.ts"
    "Frontend/src/services/db/rawStore.ts"
    "Frontend/src/utils/logger.ts"
    "Frontend/src/utils/http.ts"
    "Frontend/package.json"
)

for service in "${FRONTEND_SERVICES[@]}"; do
    if [ -f "$service" ]; then
        echo -e "${GREEN}✓ $service${NC}"
    else
        echo -e "${RED}❌ $service 不存在${NC}"
        exit 1
    fi
done

# 检查package.json
echo -e "${YELLOW}=== 检查package.json ===${NC}"

if [ -f "package.json" ]; then
    echo -e "${GREEN}✓ 根目录package.json${NC}"
else
    echo -e "${RED}❌ 根目录package.json不存在${NC}"
    exit 1
fi

# 检查GitHub Secrets配置
echo -e "${YELLOW}=== 检查GitHub Secrets配置 ===${NC}"

echo "请确认以下GitHub Secrets已设置："
echo "  - EC2_HOST: 43.207.222.149"
echo "  - EC2_USERNAME: ec2-user"
echo "  - EC2_SSH_KEY: [您的SSH私钥]"
echo ""

# 显示部署流程
echo -e "${BLUE}=== 部署流程说明 ===${NC}"
echo ""
echo "1. 推送代码到main分支"
echo "2. GitHub Actions自动触发部署"
echo "3. 部署到AWS EC2实例 (43.207.222.149)"
echo "4. 设置定时任务进行24小时数据收集"
echo "5. 监控数据收集状态"
echo ""

# 显示部署后的目录结构
echo -e "${BLUE}=== 部署后的目录结构 ===${NC}"
echo ""
echo "/home/ubuntu/RwaLendingPlatform/"
echo "├── Frontend/"
echo "│   ├── src/services/data/"
echo "│   ├── src/services/db/"
echo "│   ├── src/utils/"
echo "│   └── package.json"
echo "├── scripts/"
echo "│   ├── aws-collect-only.ts"
echo "│   ├── aws-collector.sh"
echo "│   └── monitor-collection.sh"
echo "├── logs/"
echo "│   └── collection.log"
echo "└── .env"
echo ""

# 显示定时任务配置
echo -e "${BLUE}=== 定时任务配置 ===${NC}"
echo ""
echo "每15分钟: 快速数据收集"
echo "每小时: 完整数据收集"
echo "每天凌晨2点: 深度数据收集"
echo "每周日凌晨3点: 数据清理"
echo ""

# 显示管理命令
echo -e "${BLUE}=== 管理命令 ===${NC}"
echo ""
echo "查看状态: /home/ubuntu/RwaLendingPlatform/scripts/monitor-collection.sh"
echo "查看日志: tail -f /home/ubuntu/RwaLendingPlatform/logs/collection.log"
echo "手动收集: /home/ubuntu/RwaLendingPlatform/scripts/aws-collector.sh"
echo "停止收集: crontab -r"
echo ""

echo -e "${GREEN}🎉 部署测试完成！所有文件都已准备就绪。${NC}"
echo -e "${YELLOW}下一步: 推送代码到GitHub触发自动部署${NC}"

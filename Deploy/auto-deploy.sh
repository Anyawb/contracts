#!/bin/bash
# 自动部署脚本 - 用于GitHub Actions

set -e

echo "🚀 开始自动部署..."

# 配置参数
PROJECT_DIR="/var/www/easifi"
FRONTEND_DIR="$PROJECT_DIR/Frontend"
LOG_FILE="/home/ubuntu/deploy.log"

# 记录部署开始时间
echo "$(date): 开始部署" >> $LOG_FILE

# 1. 停止现有服务
echo "🛑 停止现有服务..."
sudo pkill -f 'next' || true
sudo pkill -f 'pnpm' || true
sudo pkill -f 'node.*3001' || true
sleep 3

# 2. 进入项目目录
cd $PROJECT_DIR

# 3. 拉取最新代码
echo "📥 拉取最新代码..."
git pull origin main

# 4. 更新环境变量
echo "⚙️ 更新环境变量..."
cd $FRONTEND_DIR
cat > .env.local << 'EOF'
# 数据库配置 - 连接到AWS RDS PostgreSQL
DATABASE_URL=postgres://easifi_admin:EasiFi2024!Secure@easifi-db.c76ouyg423x6.ap-northeast-1.rds.amazonaws.com:5432/easifi_users
DATABASE_SSL=true

# API配置
NEXT_PUBLIC_API_URL=https://api.easifi.io
NEXT_PUBLIC_APP_URL=https://easifi.io

# 区块链配置
NEXT_PUBLIC_RPC_URL=https://easifi.io/rpc
NEXT_PUBLIC_CHAIN_ID=1337

# AI服务配置
NEXT_PUBLIC_AI_API_URL=https://api.easifi.io/api
EOF

# 5. 安装依赖
echo "📦 安装依赖..."
pnpm install

# 6. 构建前端
echo "🔨 构建前端..."
rm -rf .next
pnpm build

# 7. 启动服务
echo "🚀 启动服务..."
PORT=3001 nohup pnpm start > ~/nextjs.log 2>&1 &

# 8. 等待服务启动
echo "⏳ 等待服务启动..."
sleep 10

# 9. 检查服务状态
echo "🔍 检查服务状态..."
if ps aux | grep 'next' | grep -v grep > /dev/null; then
    echo "✅ Next.js服务启动成功"
else
    echo "❌ Next.js服务启动失败"
    exit 1
fi

if ss -tlnp | grep :3001 > /dev/null; then
    echo "✅ 端口3001监听正常"
else
    echo "❌ 端口3001监听失败"
    exit 1
fi

# 10. 重新加载Nginx
echo "🔄 重新加载Nginx..."
sudo systemctl reload nginx

# 11. 测试服务
echo "🧪 测试服务..."
if curl -s http://localhost:3001/api/health > /dev/null; then
    echo "✅ 服务测试通过"
else
    echo "⚠️ 服务测试失败，但继续部署"
fi

# 12. 记录部署完成
echo "$(date): 部署完成" >> $LOG_FILE
echo "🎉 自动部署完成！"

# 13. 显示服务状态
echo "📊 服务状态："
ps aux | grep 'next' | grep -v grep
ss -tlnp | grep :3001

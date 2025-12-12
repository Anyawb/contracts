#!/bin/bash

# SSH隧道设置脚本
# 用于建立到AWS RDS的安全连接

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置变量
TUNNEL_PORT="5433"
LOCAL_PORT="5432"
TUNNEL_PID_FILE="/tmp/aws_rds_tunnel.pid"

echo -e "${BLUE}=== SSH隧道设置脚本 ===${NC}"
echo ""

# 检查配置文件
if [ ! -f "/tmp/aws_rds_config.env" ]; then
    echo -e "${RED}错误: 未找到AWS RDS配置文件${NC}"
    echo "请先运行: ./scripts/deploy/setup_aws_rds.sh"
    exit 1
fi

# 加载配置
source /tmp/aws_rds_config.env

# 检查必要的环境变量
if [ -z "$AWS_DB_HOST" ] || [ -z "$AWS_DB_PORT" ]; then
    echo -e "${RED}错误: AWS数据库配置不完整${NC}"
    exit 1
fi

echo -e "${GREEN}✓ 配置文件已加载${NC}"
echo "AWS数据库端点: $AWS_DB_HOST:$AWS_DB_PORT"

# 检查是否已有隧道运行
if [ -f "$TUNNEL_PID_FILE" ]; then
    TUNNEL_PID=$(cat "$TUNNEL_PID_FILE")
    if ps -p "$TUNNEL_PID" > /dev/null 2>&1; then
        echo -e "${YELLOW}SSH隧道已在运行 (PID: $TUNNEL_PID)${NC}"
        echo "如需重启，请先停止: kill $TUNNEL_PID"
        exit 0
    else
        echo -e "${YELLOW}清理旧的PID文件${NC}"
        rm -f "$TUNNEL_PID_FILE"
    fi
fi

# 检查SSH连接
echo -e "${YELLOW}=== 检查SSH连接 ===${NC}"
if ! ssh -o ConnectTimeout=10 -o BatchMode=yes ubuntu@$AWS_DB_HOST exit 2>/dev/null; then
    echo -e "${RED}错误: 无法连接到AWS实例${NC}"
    echo "请检查："
    echo "1. SSH密钥是否正确配置"
    echo "2. 安全组是否允许SSH连接"
    echo "3. 实例是否正在运行"
    exit 1
fi

echo -e "${GREEN}✓ SSH连接正常${NC}"

# 创建SSH隧道
echo -e "${YELLOW}=== 创建SSH隧道 ===${NC}"
ssh -f -N -L $TUNNEL_PORT:$AWS_DB_HOST:$AWS_DB_PORT ubuntu@$AWS_DB_HOST

# 获取隧道进程ID
TUNNEL_PID=$(ps aux | grep "ssh.*-L $TUNNEL_PORT:$AWS_DB_HOST:$AWS_DB_PORT" | grep -v grep | awk '{print $2}' | head -1)

if [ -n "$TUNNEL_PID" ]; then
    echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"
    echo -e "${GREEN}✓ SSH隧道已创建 (PID: $TUNNEL_PID)${NC}"
    echo "本地端口: $TUNNEL_PORT -> AWS RDS: $AWS_DB_HOST:$AWS_DB_PORT"
else
    echo -e "${RED}错误: 无法创建SSH隧道${NC}"
    exit 1
fi

# 等待隧道建立
echo -e "${YELLOW}=== 等待隧道建立 ===${NC}"
sleep 3

# 测试隧道连接
echo -e "${YELLOW}=== 测试隧道连接 ===${NC}"
if nc -z localhost $TUNNEL_PORT 2>/dev/null; then
    echo -e "${GREEN}✓ 隧道连接正常${NC}"
else
    echo -e "${RED}错误: 隧道连接失败${NC}"
    exit 1
fi

# 创建本地连接配置
echo -e "${YELLOW}=== 创建本地连接配置 ===${NC}"
cat > /tmp/aws_tunnel_config.env << EOF
# SSH隧道配置
TUNNEL_PORT=$TUNNEL_PORT
TUNNEL_PID=$TUNNEL_PID
TUNNEL_PID_FILE=$TUNNEL_PID_FILE

# 本地连接配置（通过隧道）
LOCAL_AWS_DB_HOST=localhost
LOCAL_AWS_DB_PORT=$TUNNEL_PORT
LOCAL_AWS_DB_NAME=$AWS_DB_NAME
LOCAL_AWS_DB_USER=$AWS_DB_USER
LOCAL_AWS_DB_PASSWORD=$AWS_DB_PASSWORD
LOCAL_AWS_DB_URL=postgres://$AWS_DB_USER:$AWS_DB_PASSWORD@localhost:$TUNNEL_PORT/$AWS_DB_NAME
LOCAL_AWS_DB_SSL=false
EOF

echo -e "${GREEN}✓ 本地连接配置已创建${NC}"

# 显示连接信息
echo ""
echo -e "${BLUE}=== SSH隧道配置完成 ===${NC}"
echo "隧道端口: $TUNNEL_PORT"
echo "隧道进程ID: $TUNNEL_PID"
echo "本地连接: localhost:$TUNNEL_PORT"
echo ""
echo -e "${BLUE}=== 连接测试 ===${NC}"
echo "测试连接: psql -h localhost -p $TUNNEL_PORT -U $AWS_DB_USER -d $AWS_DB_NAME"
echo ""
echo -e "${BLUE}=== 管理命令 ===${NC}"
echo "停止隧道: kill $TUNNEL_PID"
echo "检查状态: ps aux | grep ssh.*-L"
echo "查看日志: tail -f /tmp/aws_rds_tunnel.log"
echo ""
echo -e "${YELLOW}⚠️  重要提醒:${NC}"
echo "- 隧道进程会在后台运行"
echo "- 重启系统后需要重新建立隧道"
echo "- 建议设置自动重启脚本"

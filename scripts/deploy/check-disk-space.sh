#!/bin/bash

# 磁盘空间检查脚本
# 用于检查EC2实例的磁盘使用情况

set -e

EC2_IP="43.207.222.149"
SSH_KEY="~/.ssh/id_ed25519"

echo "💾 检查EC2实例磁盘空间..."
echo "=================================="

# 尝试SSH连接并检查磁盘空间
if ssh -i $SSH_KEY -o ConnectTimeout=10 ubuntu@$EC2_IP "echo 'SSH连接成功'" 2>/dev/null; then
    echo "✅ SSH连接正常"
    
    echo ""
    echo "📊 磁盘使用情况:"
    ssh -i $SSH_KEY ubuntu@$EC2_IP "df -h"
    
    echo ""
    echo "📁 目录大小分析:"
    ssh -i $SSH_KEY ubuntu@$EC2_IP "du -sh /var/www/* 2>/dev/null || echo '目录不存在'"
    ssh -i $SSH_KEY ubuntu@$EC2_IP "du -sh /home/ubuntu/* 2>/dev/null || echo '目录不存在'"
    ssh -i $SSH_KEY ubuntu@$EC2_IP "du -sh /tmp/* 2>/dev/null || echo '目录不存在'"
    
    echo ""
    echo "🗑️ 清理建议:"
    ssh -i $SSH_KEY ubuntu@$EC2_IP "echo '清理日志文件...' && sudo find /var/log -name '*.log' -size +100M -exec ls -lh {} \;"
    ssh -i $SSH_KEY ubuntu@$EC2_IP "echo '清理临时文件...' && sudo find /tmp -type f -mtime +7 -exec ls -lh {} \;"
    
else
    echo "❌ SSH连接失败 - 可能是磁盘空间不足导致系统不稳定"
    echo ""
    echo "🔧 建议解决方案:"
    echo "1. 通过AWS控制台重启实例"
    echo "2. 升级实例类型到t3.medium或t3.large"
    echo "3. 扩展EBS卷大小到20GB或更大"
    echo "4. 重新部署应用"
fi

echo ""
echo "=================================="
echo "💡 磁盘空间优化建议:"
echo "1. 清理日志文件: sudo find /var/log -name '*.log' -size +100M -delete"
echo "2. 清理临时文件: sudo rm -rf /tmp/*"
echo "3. 清理npm缓存: npm cache clean --force"
echo "4. 清理构建缓存: rm -rf node_modules/.cache"
echo "5. 升级实例类型: t3.small → t3.medium"
echo "6. 扩展EBS卷: 8GB → 20GB"

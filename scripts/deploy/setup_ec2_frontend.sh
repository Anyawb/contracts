#!/bin/bash

# EC2前端部署脚本
# 在现有的tunnel-jumper EC2上部署Next.js前端

set -e

# 配置参数
EC2_IP="43.207.222.149"
SSH_KEY="~/.ssh/id_ed25519"
DOMAIN="easifi.io"
API_DOMAIN="api.easifi.io"

echo "=== 开始部署前端到EC2 ==="

# 1. 连接EC2并安装Node.js
echo "=== 安装Node.js和依赖 ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
# 更新系统
sudo apt-get update

# 安装Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装pnpm
sudo npm install -g pnpm

# 安装PM2进程管理器
sudo npm install -g pm2

# 创建应用目录
sudo mkdir -p /var/www/easifi
sudo chown ubuntu:ubuntu /var/www/easifi
EOF

# 2. 上传前端代码
echo "=== 上传前端代码 ==="
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.git' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  /Volumes/AI-hosts/RwaLendingPlatform/Frontend/ \
  ubuntu@$EC2_IP:/var/www/easifi/

# 3. 在EC2上构建和启动前端
echo "=== 构建和启动前端 ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
cd /var/www/easifi

# 安装依赖
pnpm install

# 构建项目
pnpm build

# 创建PM2配置文件
cat > ecosystem.config.js << 'PM2EOF'
module.exports = {
  apps: [{
    name: 'easifi-frontend',
    script: 'npm',
    args: 'start',
    cwd: '/var/www/easifi',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      NEXT_PUBLIC_API_URL: 'https://api.easifi.io',
      NEXT_PUBLIC_APP_URL: 'https://easifi.io'
    }
  }]
};
PM2EOF

# 启动应用
pm2 start ecosystem.config.js
pm2 save
pm2 startup
EOF

# 4. 配置Nginx
echo "=== 配置Nginx ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
# 安装Nginx
sudo apt-get install -y nginx

# 创建Nginx配置
sudo tee /etc/nginx/sites-available/easifi.io << 'NGINXEOF'
server {
    listen 80;
    server_name easifi.io www.easifi.io;
    
    # 重定向到HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name easifi.io www.easifi.io;
    
    # SSL证书路径（稍后配置）
    ssl_certificate /etc/letsencrypt/live/easifi.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/easifi.io/privkey.pem;
    
    # SSL配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    
    # 安全头
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;
    add_header X-XSS-Protection "1; mode=block";
    
    # 代理到Next.js应用
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
    
    # 区块链节点代理
    location /rpc/ {
        proxy_pass http://127.0.0.1:8545/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
    
    # 静态文件缓存
    location /_next/static/ {
        proxy_pass http://localhost:3000;
        proxy_cache_valid 200 1y;
        add_header Cache-Control "public, immutable";
    }
}
NGINXEOF

# 启用站点
sudo ln -sf /etc/nginx/sites-available/easifi.io /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# 测试配置
sudo nginx -t

# 重启Nginx
sudo systemctl restart nginx
sudo systemctl enable nginx
EOF

# 5. 配置SSL证书
echo "=== 配置SSL证书 ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
# 安装Certbot
sudo apt-get install -y certbot python3-certbot-nginx

# 获取SSL证书
sudo certbot --nginx -d easifi.io -d www.easifi.io --non-interactive --agree-tos --email admin@easifi.io

# 设置自动续期
echo "0 12 * * * /usr/bin/certbot renew --quiet" | sudo crontab -
EOF

echo "=== 前端部署完成 ==="
echo "访问地址: https://easifi.io"
echo "API地址: https://api.easifi.io"

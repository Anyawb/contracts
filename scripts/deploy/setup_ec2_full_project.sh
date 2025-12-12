#!/bin/bash

# 完整项目部署到EC2脚本
# 包括：前端、智能合约、hardhat节点、数据库

set -e

# 配置参数
EC2_IP="43.207.222.149"
SSH_KEY="~/.ssh/id_ed25519"
DOMAIN="easifi.io"
API_DOMAIN="api.easifi.io"

echo "🚀 开始完整项目部署到EC2..."

# 第一步：清理EC2上的旧文件
echo ""
echo "=== 第一步：清理EC2上的旧文件 ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP "sudo rm -rf /var/www/easifi && sudo mkdir -p /var/www/easifi"

# 第二步：上传整个项目到EC2
echo ""
echo "=== 第二步：上传整个项目到EC2 ==="
echo "正在上传项目文件..."

# 创建临时目录，排除不需要的文件
mkdir -p /tmp/easifi-deploy
rsync -av --exclude='node_modules' --exclude='.git' --exclude='.next' --exclude='out' --exclude='build' --exclude='cache' --exclude='artifacts' --exclude='typechain-types' --exclude='.env*' /Volumes/AI-hosts/RwaLendingPlatform/ /tmp/easifi-deploy/

# 上传到EC2
scp -i $SSH_KEY -r /tmp/easifi-deploy/* ubuntu@$EC2_IP:/var/www/easifi/

# 清理临时目录
rm -rf /tmp/easifi-deploy

echo "✅ 项目文件上传完成"

# 第三步：在EC2上安装依赖
echo ""
echo "=== 第三步：在EC2上安装依赖 ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
cd /var/www/easifi

# 安装Node.js依赖
echo "安装Node.js依赖..."
npm install

# 安装Hardhat依赖
echo "安装Hardhat依赖..."
cd /var/www/easifi
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox

# 安装前端依赖
echo "安装前端依赖..."
cd /var/www/easifi/Frontend
npm install

echo "✅ 依赖安装完成"
EOF

# 第四步：设置环境变量
echo ""
echo "=== 第四步：设置环境变量 ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
cd /var/www/easifi

# 创建生产环境配置
cat > .env.production << 'ENVEOF'
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
NEXT_PUBLIC_ENV=production
NEXT_PUBLIC_INVITE_CODE_ENABLED=true
NEXT_PUBLIC_API_URL=https://api.easifi.io
NEXT_PUBLIC_APP_URL=https://easifi.io
NEXT_PUBLIC_BLOCKCHAIN_RPC_URL=https://easifi.io/rpc
NEXT_PUBLIC_BLOCKCHAIN_CHAIN_ID=1337
ENVEOF

# 创建Hardhat配置
cat > hardhat.config.ts << 'HARDHATEOF'
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.19",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 1337
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};

export default config;
HARDHATEOF

echo "✅ 环境配置完成"
EOF

# 第五步：启动Hardhat本地节点
echo ""
echo "=== 第五步：启动Hardhat本地节点 ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
cd /var/www/easifi

# 启动Hardhat节点（后台运行）
echo "启动Hardhat本地节点..."
nohup npx hardhat node --hostname 0.0.0.0 --port 8545 > /var/log/hardhat.log 2>&1 &
echo $! > /var/run/hardhat.pid

# 等待节点启动
sleep 10

echo "✅ Hardhat节点启动完成"
EOF

# 第六步：部署智能合约
echo ""
echo "=== 第六步：部署智能合约 ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
cd /var/www/easifi

# 等待节点完全启动
sleep 5

# 部署智能合约
echo "部署智能合约..."
npx hardhat run scripts/deploy/deploylocal.ts --network localhost

echo "✅ 智能合约部署完成"
EOF

# 第七步：构建前端
echo ""
echo "=== 第七步：构建前端 ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
cd /var/www/easifi/Frontend

# 构建前端
echo "构建前端..."
npm run build

echo "✅ 前端构建完成"
EOF

# 第八步：配置Nginx
echo ""
echo "=== 第八步：配置Nginx ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
# 创建Nginx配置
sudo tee /etc/nginx/sites-available/easifi << 'NGINXEOF'
server {
    listen 80;
    server_name easifi.io api.easifi.io;

    # 前端服务
    location / {
        root /var/www/easifi/Frontend/out;
        try_files $uri $uri.html $uri/index.html /index.html;
        
        # 添加CORS头
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS";
        add_header Access-Control-Allow-Headers "Origin, X-Requested-With, Content-Type, Accept, Authorization";
    }

    # API代理（AI服务）
    location /api/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
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
}
NGINXEOF

# 启用站点
sudo ln -sf /etc/nginx/sites-available/easifi /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# 测试配置
sudo nginx -t

# 重启Nginx
sudo systemctl restart nginx

echo "✅ Nginx配置完成"
EOF

# 第九步：设置SSL证书
echo ""
echo "=== 第九步：设置SSL证书 ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
# 安装Certbot
sudo apt update
sudo apt install -y certbot python3-certbot-nginx

# 获取SSL证书
sudo certbot --nginx -d easifi.io -d api.easifi.io --non-interactive --agree-tos --email admin@easifi.io

echo "✅ SSL证书设置完成"
EOF

# 第十步：启动PM2服务
echo ""
echo "=== 第十步：启动PM2服务 ==="
ssh -i $SSH_KEY ubuntu@$EC2_IP << 'EOF'
cd /var/www/easifi

# 安装PM2
npm install -g pm2

# 创建PM2配置文件
cat > ecosystem.config.js << 'PM2EOF'
module.exports = {
  apps: [{
    name: 'easifi-frontend',
    script: 'npm',
    args: 'start',
    cwd: '/var/www/easifi/Frontend',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
PM2EOF

# 启动服务
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo "✅ PM2服务启动完成"
EOF

echo ""
echo "🎉 完整项目部署完成！"
echo ""
echo "访问地址："
echo "  前端: https://easifi.io"
echo "  API: https://api.easifi.io"
echo "  区块链节点: https://easifi.io/rpc"
echo ""
echo "服务状态："
echo "  - 前端: PM2管理"
echo "  - 区块链节点: Hardhat本地节点"
echo "  - 数据库: PostgreSQL"
echo "  - 反向代理: Nginx + SSL"

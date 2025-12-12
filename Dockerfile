FROM node:20-bullseye-slim

# 设置工作目录
WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 设置Node.js内存限制
ENV NODE_OPTIONS="--max_old_space_size=4096"

# 复制package文件
COPY package.json package-lock.json ./

# 安装依赖 - 使用更稳定的方式
RUN npm ci --only=production --no-audit --no-fund || \
    (npm cache clean --force && npm install --only=production --no-audit --no-fund)

# 复制必要的文件（避免复制整个项目）
COPY hardhat.config.ts ./
COPY contracts/ ./contracts/
COPY scripts/ ./scripts/
COPY artifacts/ ./artifacts/

# 创建必要的目录
RUN mkdir -p build deployments

# 暴露端口
EXPOSE 8545

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8545 || exit 1

# 启动命令
CMD ["npx", "hardhat", "node", "--hostname", "0.0.0.0", "--port", "8545"]



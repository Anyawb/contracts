# RWA 借贷平台 Monorepo 架构设计

## 📁 项目结构

```
RwaLendingPlatform/
├── 📦 根目录配置
│   ├── package.json              # 工作区配置
│   ├── pnpm-workspace.yaml       # pnpm 工作区配置
│   ├── nx.json                   # Nx 构建配置
│   ├── .eslintrc.js              # 统一 ESLint 配置
│   ├── .prettierrc               # 统一 Prettier 配置
│   ├── tsconfig.base.json        # 基础 TypeScript 配置
│   └── .gitignore                # 统一 Git 忽略
│
├── 🏗️ 智能合约层
│   ├── contracts/                 # Solidity 合约
│   │   ├── core/                 # 核心合约
│   │   ├── vault/                # 金库合约
│   │   ├── reward/               # 奖励合约
│   │   └── interfaces/           # 接口定义
│   ├── test/                     # 合约测试
│   ├── scripts/                  # 部署脚本
│   ├── hardhat.config.ts         # Hardhat 配置
│   └── package.json              # 合约项目配置
│
├── 🎨 前端应用层
│   ├── frontend/                 # React 前端应用
│   │   ├── src/
│   │   │   ├── components/       # React 组件
│   │   │   ├── hooks/           # 自定义 Hooks
│   │   │   ├── pages/           # 页面组件
│   │   │   ├── services/        # API 服务
│   │   │   ├── store/           # 状态管理
│   │   │   ├── types/           # TypeScript 类型
│   │   │   └── utils/           # 工具函数
│   │   ├── public/              # 静态资源
│   │   ├── vite.config.ts       # Vite 配置
│   │   └── package.json         # 前端项目配置
│   │
│   ├── mobile/                  # React Native 移动应用
│   │   ├── src/
│   │   ├── android/
│   │   ├── ios/
│   │   └── package.json
│   │
│   └── admin/                   # 管理后台
│       ├── src/
│       └── package.json
│
├── 🔧 共享工具层
│   ├── packages/
│   │   ├── types/               # 共享类型定义
│   │   │   ├── src/
│   │   │   │   ├── contracts.ts # 合约类型
│   │   │   │   ├── api.ts       # API 类型
│   │   │   │   └── common.ts    # 通用类型
│   │   │   └── package.json
│   │   │
│   │   ├── utils/               # 共享工具函数
│   │   │   ├── src/
│   │   │   │   ├── web3.ts      # Web3 工具
│   │   │   │   ├── format.ts    # 格式化工具
│   │   │   │   └── validation.ts # 验证工具
│   │   │   └── package.json
│   │   │
│   │   ├── ui/                  # 共享 UI 组件
│   │   │   ├── src/
│   │   │   │   ├── components/  # 通用组件
│   │   │   │   ├── themes/      # 主题配置
│   │   │   │   └── styles/      # 样式文件
│   │   │   └── package.json
│   │   │
│   │   └── config/              # 共享配置
│   │       ├── src/
│   │       │   ├── networks.ts  # 网络配置
│   │       │   ├── contracts.ts # 合约配置
│   │       │   └── api.ts       # API 配置
│   │       └── package.json
│   │
│   └── frontend-config/         # 前端配置（现有）
│       └── contracts-localhost.ts
│
├── 📚 文档层
│   ├── docs/                    # 项目文档
│   │   ├── architecture/        # 架构文档
│   │   ├── api/                 # API 文档
│   │   ├── deployment/          # 部署文档
│   │   └── user-guide/          # 用户指南
│   │
│   └── README.md                # 项目说明
│
├── 🚀 CI/CD 层
│   ├── .github/
│   │   ├── workflows/           # GitHub Actions
│   │   │   ├── ci.yml           # 持续集成
│   │   │   ├── deploy.yml       # 部署流程
│   │   │   └── release.yml      # 发布流程
│   │   └── environments/        # 环境配置
│   │
│   └── scripts/
│       ├── build/               # 构建脚本
│       ├── deploy/              # 部署脚本
│       └── test/                # 测试脚本
│
└── 🧪 测试层
    ├── e2e/                     # 端到端测试
    ├── integration/             # 集成测试
    └── performance/             # 性能测试
```

## 🔄 工作流程

### 1. 开发流程
```bash
# 安装所有依赖
pnpm install

# 启动开发环境
pnpm dev                    # 启动所有项目
pnpm dev:frontend          # 只启动前端
pnpm dev:contracts         # 只启动合约开发

# 运行测试
pnpm test                  # 运行所有测试
pnpm test:contracts        # 运行合约测试
pnpm test:frontend         # 运行前端测试
pnpm test:e2e              # 运行端到端测试
```

### 2. 构建流程
```bash
# 构建所有项目
pnpm build

# 构建特定项目
pnpm build:contracts       # 编译合约
pnpm build:frontend        # 构建前端
pnpm build:mobile          # 构建移动应用
```

### 3. 部署流程
```bash
# 部署到测试网
pnpm deploy:testnet

# 部署到主网
pnpm deploy:mainnet

# 部署前端
pnpm deploy:frontend
```

## 📦 包管理策略

### 1. 工作区配置
```json
// 根目录 package.json
{
  "name": "rwa-lending-platform",
  "private": true,
  "workspaces": [
    "contracts",
    "frontend",
    "mobile",
    "admin",
    "packages/*"
  ],
  "scripts": {
    "dev": "nx run-many --target=dev --all",
    "build": "nx run-many --target=build --all",
    "test": "nx run-many --target=test --all",
    "deploy": "nx run-many --target=deploy --all"
  }
}
```

### 2. 依赖管理
```json
// packages/types/package.json
{
  "name": "@rwa/types",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "dependencies": {
    "ethers": "^6.4.0"
  }
}

// frontend/package.json
{
  "name": "@rwa/frontend",
  "dependencies": {
    "@rwa/types": "workspace:*",
    "@rwa/utils": "workspace:*",
    "@rwa/ui": "workspace:*",
    "@rwa/config": "workspace:*"
  }
}
```

## 🔧 工具配置

### 1. Nx 构建配置
```json
// nx.json
{
  "extends": "nx/presets/npm.json",
  "affected": {
    "defaultBase": "main"
  },
  "tasksRunnerOptions": {
    "default": {
      "runner": "nx/tasks-runners/default",
      "options": {
        "cacheableOperations": ["build", "test", "lint"]
      }
    }
  }
}
```

### 2. TypeScript 配置
```json
// tsconfig.base.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@rwa/types": ["packages/types/src"],
      "@rwa/utils": ["packages/utils/src"],
      "@rwa/ui": ["packages/ui/src"],
      "@rwa/config": ["packages/config/src"]
    }
  }
}
```

## 🚀 CI/CD 配置

### 1. 统一构建流程
```yaml
# .github/workflows/ci.yml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: pnpm install
      - run: pnpm build
      - run: pnpm test
```

### 2. 智能部署
```yaml
# .github/workflows/deploy.yml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      # 只构建受影响的包
      - run: npx nx affected:build
      # 只测试受影响的包
      - run: npx nx affected:test
      # 部署受影响的包
      - run: npx nx affected:deploy
```

## 📈 性能优化

### 1. 增量构建
```bash
# 只构建受影响的包
npx nx affected:build

# 只测试受影响的包
npx nx affected:test
```

### 2. 缓存策略
```bash
# 缓存构建结果
npx nx reset
npx nx build --parallel=4
```

### 3. 并行执行
```bash
# 并行运行多个任务
npx nx run-many --target=build --parallel=4
```

## 🎯 最佳实践

### 1. 代码组织
- 按功能模块组织代码
- 共享代码放在 packages 目录
- 保持模块间的低耦合

### 2. 版本管理
- 使用语义化版本控制
- 统一版本发布流程
- 自动化版本更新

### 3. 测试策略
- 单元测试覆盖每个包
- 集成测试验证模块间交互
- 端到端测试验证完整流程

### 4. 文档维护
- 每个包都有 README
- API 文档自动生成
- 架构文档保持更新

# Monorepo 实际配置示例

## 📦 包管理器配置

### 1. pnpm 工作区配置
```yaml
# pnpm-workspace.yaml
packages:
  - 'contracts'
  - 'frontend'
  - 'mobile'
  - 'admin'
  - 'packages/*'
  - '!**/node_modules/**'
  - '!**/dist/**'
  - '!**/build/**'
```

### 2. 根目录 package.json
```json
{
  "name": "rwa-lending-platform",
  "version": "1.0.0",
  "private": true,
  "description": "RWA Lending Platform - Monorepo",
  "workspaces": [
    "contracts",
    "frontend",
    "mobile",
    "admin",
    "packages/*"
  ],
  "scripts": {
    "dev": "nx run-many --target=dev --all",
    "dev:frontend": "nx run frontend:dev",
    "dev:contracts": "nx run contracts:dev",
    "build": "nx run-many --target=build --all",
    "build:frontend": "nx run frontend:build",
    "build:contracts": "nx run contracts:build",
    "test": "nx run-many --target=test --all",
    "test:frontend": "nx run frontend:test",
    "test:contracts": "nx run contracts:test",
    "lint": "nx run-many --target=lint --all",
    "lint:fix": "nx run-many --target=lint:fix --all",
    "deploy": "nx run contracts:deploy",
    "deploy:frontend": "nx run frontend:deploy",
    "clean": "nx reset && rm -rf node_modules && rm -rf packages/*/node_modules",
    "affected:build": "nx affected:build",
    "affected:test": "nx affected:test",
    "affected:deploy": "nx affected:deploy"
  },
  "devDependencies": {
    "@nx/workspace": "^17.0.0",
    "@nx/jest": "^17.0.0",
    "@nx/eslint-plugin": "^17.0.0",
    "@nx/vite": "^17.0.0",
    "@nx/react": "^17.0.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0",
    "eslint": "^8.0.0",
    "prettier": "^3.0.0",
    "typescript": "^5.0.0",
    "nx": "^17.0.0"
  },
  "engines": {
    "node": ">=18.0.0",
    "pnpm": ">=8.0.0"
  }
}
```

## 🏗️ Nx 构建系统配置

### 1. nx.json
```json
{
  "extends": "nx/presets/npm.json",
  "affected": {
    "defaultBase": "main"
  },
  "tasksRunnerOptions": {
    "default": {
      "runner": "nx/tasks-runners/default",
      "options": {
        "cacheableOperations": [
          "build",
          "test",
          "lint",
          "type-check"
        ],
        "parallel": 3
      }
    }
  },
  "targetDefaults": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["default", "^default"],
      "outputs": ["{projectRoot}/dist", "{projectRoot}/build"]
    },
    "test": {
      "dependsOn": ["^build"],
      "inputs": ["default", "^default", "{workspaceRoot}/jest.preset.js"]
    },
    "lint": {
      "inputs": ["default", "{workspaceRoot}/.eslintrc.js"]
    }
  },
  "generators": {
    "@nx/react": {
      "application": {
        "style": "css",
        "linter": "eslint",
        "bundler": "vite",
        "babel": false
      },
      "component": {
        "style": "css"
      },
      "library": {
        "style": "css",
        "linter": "eslint"
      }
    }
  }
}
```

### 2. project.json 示例（前端项目）
```json
{
  "name": "frontend",
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "frontend/src",
  "projectType": "application",
  "targets": {
    "dev": {
      "executor": "@nx/vite:dev-server",
      "defaultConfiguration": "development",
      "options": {
        "buildTarget": "frontend:build"
      },
      "configurations": {
        "development": {
          "buildTarget": "frontend:build:development",
          "hmr": true
        },
        "production": {
          "buildTarget": "frontend:build:production",
          "hmr": false
        }
      }
    },
    "build": {
      "executor": "@nx/vite:build",
      "outputs": ["{options.outputPath}"],
      "defaultConfiguration": "production",
      "options": {
        "outputPath": "dist/frontend"
      },
      "configurations": {
        "development": {
          "mode": "development"
        },
        "production": {
          "mode": "production"
        }
      }
    },
    "test": {
      "executor": "@nx/jest:jest",
      "outputs": ["{workspaceRoot}/coverage/{projectRoot}"],
      "options": {
        "jestConfig": "frontend/jest.config.ts",
        "passWithNoTests": true
      }
    },
    "lint": {
      "executor": "@nx/eslint:lint",
      "outputs": ["{options.outputFile}"]
    },
    "deploy": {
      "executor": "nx:run-commands",
      "options": {
        "command": "npm run deploy:frontend",
        "cwd": "frontend"
      }
    }
  },
  "tags": ["scope:frontend", "type:app"]
}
```

## 🔧 TypeScript 配置

### 1. tsconfig.base.json
```json
{
  "compileOnSave": false,
  "compilerOptions": {
    "rootDir": ".",
    "sourceMap": true,
    "declaration": false,
    "moduleResolution": "node",
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "importHelpers": true,
    "target": "es2015",
    "module": "esnext",
    "lib": ["es2020", "dom"],
    "skipLibCheck": true,
    "skipDefaultLibCheck": true,
    "baseUrl": ".",
    "paths": {
      "@rwa/types": ["packages/types/src/index.ts"],
      "@rwa/utils": ["packages/utils/src/index.ts"],
      "@rwa/ui": ["packages/ui/src/index.ts"],
      "@rwa/config": ["packages/config/src/index.ts"],
      "@rwa/contracts": ["contracts/src/index.ts"]
    }
  },
  "exclude": ["node_modules", "tmp"]
}
```

### 2. 前端项目 tsconfig.json
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "allowJs": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": false,
    "noImplicitAny": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": false,
    "noImplicitAny": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "exactOptionalPropertyTypes": true
  },
  "files": [],
  "include": [],
  "references": [
    {
      "path": "./tsconfig.app.json"
    },
    {
      "path": "./tsconfig.spec.json"
    }
  ]
}
```

## 🎨 共享包配置

### 1. 类型定义包 (packages/types/package.json)
```json
{
  "name": "@rwa/types",
  "version": "1.0.0",
  "description": "Shared TypeScript types for RWA Lending Platform",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "ethers": "^6.4.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

### 2. 工具函数包 (packages/utils/package.json)
```json
{
  "name": "@rwa/utils",
  "version": "1.0.0",
  "description": "Shared utility functions for RWA Lending Platform",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "jest",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@rwa/types": "workspace:*",
    "ethers": "^6.4.0"
  },
  "devDependencies": {
    "@types/jest": "^29.0.0",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "typescript": "^5.0.0"
  }
}
```

### 3. UI 组件包 (packages/ui/package.json)
```json
{
  "name": "@rwa/ui",
  "version": "1.0.0",
  "description": "Shared UI components for RWA Lending Platform",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch",
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build"
  },
  "dependencies": {
    "@rwa/types": "workspace:*",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "@storybook/react": "^7.0.0",
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^4.0.0"
  },
  "peerDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  }
}
```

## 🚀 CI/CD 配置

### 1. GitHub Actions - CI
```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

env:
  NODE_VERSION: '18'
  PNPM_VERSION: '8'

jobs:
  install:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - run: pnpm install --frozen-lockfile

  affected:
    runs-on: ubuntu-latest
    needs: install
    outputs:
      affected: ${{ steps.affected.outputs.affected }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - run: pnpm install --frozen-lockfile
      - run: npx nx affected:graph --file=affected.json
      - id: affected
        run: |
          echo "affected=$(cat affected.json)" >> $GITHUB_OUTPUT

  build:
    runs-on: ubuntu-latest
    needs: [install, affected]
    if: needs.affected.outputs.affected != '[]'
    strategy:
      matrix:
        project: ${{ fromJson(needs.affected.outputs.affected) }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - run: pnpm install --frozen-lockfile
      - run: npx nx build ${{ matrix.project }}

  test:
    runs-on: ubuntu-latest
    needs: [install, affected]
    if: needs.affected.outputs.affected != '[]'
    strategy:
      matrix:
        project: ${{ fromJson(needs.affected.outputs.affected) }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - run: pnpm install --frozen-lockfile
      - run: npx nx test ${{ matrix.project }}

  lint:
    runs-on: ubuntu-latest
    needs: [install, affected]
    if: needs.affected.outputs.affected != '[]'
    strategy:
      matrix:
        project: ${{ fromJson(needs.affected.outputs.affected) }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - run: pnpm install --frozen-lockfile
      - run: npx nx lint ${{ matrix.project }}
```

### 2. GitHub Actions - 部署
```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

env:
  NODE_VERSION: '18'
  PNPM_VERSION: '8'

jobs:
  deploy-contracts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - run: pnpm install --frozen-lockfile
      - run: npx nx build contracts
      - run: npx nx deploy contracts
        env:
          PRIVATE_KEY: ${{ secrets.PRIVATE_KEY }}
          RPC_URL: ${{ secrets.RPC_URL }}

  deploy-frontend:
    runs-on: ubuntu-latest
    needs: deploy-contracts
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
      - uses: pnpm/action-setup@v2
        with:
          version: ${{ env.PNPM_VERSION }}
      - run: pnpm install --frozen-lockfile
      - run: npx nx build frontend
      - run: npx nx deploy frontend
```

## 📊 性能优化配置

### 1. 缓存配置
```json
// nx.json 中的缓存配置
{
  "tasksRunnerOptions": {
    "default": {
      "runner": "nx/tasks-runners/default",
      "options": {
        "cacheableOperations": [
          "build",
          "test",
          "lint",
          "type-check"
        ],
        "parallel": 3,
        "cacheDirectory": ".nx-cache"
      }
    }
  }
}
```

### 2. 并行构建配置
```bash
# 并行构建所有项目
npx nx run-many --target=build --parallel=4

# 只构建受影响的包
npx nx affected:build --parallel=4

# 并行测试
npx nx run-many --target=test --parallel=4
```

## 🔍 开发工具配置

### 1. VS Code 配置
```json
// .vscode/settings.json
{
  "typescript.preferences.includePackageJsonAutoImports": "on",
  "typescript.suggest.autoImports": true,
  "typescript.updateImportsOnFileMove.enabled": "always",
  "eslint.workingDirectories": [
    "frontend",
    "packages/*"
  ],
  "prettier.requireConfig": true,
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
```

### 2. 调试配置
```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Frontend",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/frontend/src/main.tsx",
      "cwd": "${workspaceFolder}/frontend",
      "env": {
        "NODE_ENV": "development"
      }
    },
    {
      "name": "Debug Contracts",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/contracts/test/LendingEngine.test.ts",
      "cwd": "${workspaceFolder}/contracts"
    }
  ]
}
```

## 📈 监控和分析

### 1. 构建分析
```bash
# 分析构建依赖
npx nx graph

# 分析受影响的包
npx nx affected:graph

# 查看构建时间
npx nx show projects --with-target=build
```

### 2. 依赖分析
```bash
# 查看依赖关系
npx nx dep-graph

# 查看循环依赖
npx nx dep-graph --focus=frontend
```

这些配置展示了如何在你的 RWA 借贷平台项目中实现一个完整的 Monorepo 架构，包括包管理、构建系统、CI/CD 和开发工具配置。

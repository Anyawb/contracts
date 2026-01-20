# RWA 借贷平台智能合约仓库

这是 RWA（现实世界资产）借贷平台的独立智能合约仓库，包含完整的智能合约源代码、测试、部署脚本和文档。

## 📋 项目概述

本仓库包含 RWA 借贷平台的所有智能合约实现，采用模块化架构设计，通过 Registry 系统实现统一的模块管理和升级能力。

### 核心特性

- **模块化架构**：所有功能模块通过 Registry 系统统一管理
- **双架构设计**：事件驱动架构 + View 层缓存架构，优化 Gas 成本
- **可升级性**：使用 UUPS 代理模式，支持合约升级
- **权限控制**：统一的 AccessControlManager 权限管理系统
- **标准化**：使用 ModuleKeys 和 ActionKeys 进行标准化标识
- **完整测试**：全面的测试套件，覆盖核心功能模块

## 📁 项目结构

```
contracts/
├── src/                    # 智能合约源代码
│   ├── access/            # 访问控制模块
│   ├── constants/         # 常量定义（ModuleKeys, ActionKeys等）
│   ├── core/              # 核心业务合约（价格预言机等）
│   ├── errors/            # 标准错误定义
│   ├── Governance/        # 治理模块
│   ├── interfaces/        # 接口定义
│   ├── libraries/         # 共享库文件
│   ├── Mocks/             # 测试用 Mock 合约
│   ├── monitor/           # 系统监控模块
│   ├── registry/          # Registry 模块注册系统
│   ├── Reward/            # 奖励系统
│   ├── strategies/        # 策略合约
│   ├── Token/             # 代币合约
│   ├── utils/             # 工具库
│   └── Vault/             # 金库系统（核心业务逻辑）
│       ├── liquidation/   # 清算模块
│       ├── modules/       # 业务模块
│       └── view/          # 视图模块
├── test/                  # 测试文件
├── scripts/               # 部署和工具脚本
│   ├── deploy/           # 部署脚本
│   ├── checks/            # 检查脚本
│   ├── docs/             # 文档生成脚本
│   └── tasks/            # Hardhat 任务
├── docs/                  # 项目文档
│   ├── Usage-Guide/      # 使用指南
│   └── Test-Guide/       # 测试指南
├── deployments/           # 部署地址和配置
├── configs/               # 配置文件
└── hardhat.config.ts      # Hardhat 配置
```

## 🏗️ 核心模块

### 1. Registry 系统
模块注册中心，统一管理所有模块地址和升级流程。

### 2. Vault 系统
金库系统，管理抵押物、借贷、还款等核心业务逻辑，包括：
- **核心合约**：VaultCore、VaultRouter、VaultStorage、VaultRouter
- **业务模块**：CollateralManager、LendingEngine、GuaranteeFundManager 等
- **清算模块**：完整的清算系统，包含风险管理、奖励分配等
- **视图模块**：20+ 个视图模块，提供快速免费查询

### 3. Reward 系统
奖励积分系统，管理用户积分、消费和特权。

### 4. Core 模块
核心业务合约，包括价格预言机、手续费路由等。

详细文档请参考 [docs/PlatformLogic.md](./docs/PlatformLogic.md) 和 [src/README.md](./src/README.md)。

## 🚀 快速开始

### 环境要求

- **Node.js**: v18 或更高版本
- **pnpm**（本仓库使用 `pnpm-lock.yaml` 作为依赖解析的唯一来源；禁止混用 npm/yarn lockfile）
- **Hardhat**: 已包含在依赖中
- **OpenZeppelin**: v5（当前基线：`@openzeppelin/contracts(-upgradeable)@5.4.0`）

### 安装依赖

```bash
pnpm install
```

### 配置环境变量

1. 复制环境变量模板：
```bash
cp .env.template .env
```

2. 填写必要的环境变量：
   - RPC URLs（Arbitrum、Arbitrum Sepolia 等）
   - 私钥（用于部署和测试）
   - 其他配置项

### 编译合约

```bash
pnpm -s run compile
```

### 运行测试

```bash
# 运行所有测试
pnpm -s test

# 运行测试并生成 Gas 报告
pnpm -s run gas

# 生成测试覆盖率报告
pnpm -s run coverage
```

### 本地开发

```bash
# 启动本地 Hardhat 节点
pnpm -s run node

# 在另一个终端部署到本地网络
pnpm -s run deploy:localhost
```

## 📜 可用脚本

### 开发脚本

- `pnpm -s run compile` - 编译智能合约
- `pnpm -s test` - 运行测试套件
- `pnpm -s run node` - 启动本地 Hardhat 节点
- `pnpm -s run deploy:localhost` - 部署到本地网络
- `pnpm -s run coverage` - 生成测试覆盖率报告
- `pnpm -s run gas` - 运行测试并生成 Gas 报告

### 代码质量

- `pnpm -s run lint:sol` - 检查 Solidity 代码规范
- `pnpm -s run format:sol` - 格式化 Solidity 代码
- `pnpm -s run format:check:sol` - 检查代码格式
- `pnpm -s run size` - 检查合约大小

### 文档生成

- `pnpm -s run docs` - 生成 Solidity 文档
- `pnpm -s run docs:abi` - 生成 ABI 文档
- `pnpm -s run docs:errors` - 生成错误文档
- `pnpm -s run docs:all` - 生成所有文档

### 检查脚本

- `pnpm -s run checks:oz-v5` - OpenZeppelin v5 升级验收（一键：lockfiles + OZ 版本 + clean&compile）
- `pnpm -s run checks:oz-v5:tests` - OpenZeppelin v5 最小回归用例集（按迁移计划推荐用例）
- `pnpm -s run checks:oz-v5:full` - OpenZeppelin v5 一键验收 + 全量测试（等价于 `checks:oz-v5` + `pnpm test`）
- `pnpm -s run checks:lockfiles` - 检查锁文件是否符合 pnpm-only 策略
- `pnpm -s run checks:run-all` - 运行所有检查
- `pnpm -s run checks:env` - 检查环境变量
- `pnpm -s run checks:keys` - 检查模块键配置
- `pnpm -s run checks:roles` - 检查角色权限
- `pnpm -s run checks:registry` - 检查 Registry 配置

### 清理脚本

- `pnpm -s run clean` - 清理 Hardhat 缓存
- `pnpm -s run clean:all` - 清理所有缓存
- `pnpm -s run clean:hardhat` - 清理 Hardhat 缓存

### CLI 工具

- `pnpm -s run cli` - 运行 CLI 工具（交互式命令行工具）

## 🔒 依赖与锁文件策略（重要）

- **只使用 pnpm**：本仓库通过 `preinstall` 强制使用 pnpm，避免 npm/yarn 导致依赖解析漂移。
- **单一锁文件**：以 `pnpm-lock.yaml` 作为唯一真实来源（SSOT）。
- **禁止混用**：不要新增/提交 `package-lock.json` 或 `yarn.lock`（会导致依赖版本不一致，例如 OpenZeppelin v4/v5 混乱）。

## 🌐 支持的网络

- **localhost**: 本地开发网络（Hardhat 节点）
- **arbitrum**: Arbitrum One 主网
- **arbitrumSepolia**: Arbitrum Sepolia 测试网

## 📚 文档

项目包含完整的文档系统，位于 `docs/` 目录：

- **[平台逻辑说明](./docs/PlatformLogic.md)** - 系统架构和核心逻辑
- **[架构指南](./docs/Architecture-Guide.md)** - 架构设计说明
- **[使用指南](./docs/Usage-Guide/)** - 各模块使用指南
- **[测试指南](./docs/Test-Guide/)** - 测试相关文档
- **[智能合约标准](./docs/SmartContractStandard.md)** - 开发规范

## 🔧 技术栈

- **Solidity**: 0.8.20
- **Hardhat**: 开发框架
- **TypeScript**: 测试和脚本语言
- **OpenZeppelin**: 安全合约库
- **Ethers.js**: 以太坊交互库

## 🔐 安全特性

- UUPS 可升级代理模式
- 统一的权限管理系统（ACM）
- 资产白名单机制
- 价格预言机集成
- 完整的清算机制
- SafeERC20 安全转账

## 📝 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。在贡献代码前，请确保：

1. 代码通过所有测试
2. 遵循项目的代码规范
3. 更新相关文档

## 📞 联系方式

如有问题或建议，请通过 微信群 或 Telegram工作群 联系。

---

**注意**：部署到主网前，请务必进行充分测试和安全审计。

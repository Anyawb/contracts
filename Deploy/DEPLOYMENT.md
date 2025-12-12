# 🚀 部署指南

本文档详细说明如何部署 RWA Lending Platform 到各种网络。

## 📋 前置要求

### 1. 环境准备
- Node.js 18+ 
- npm 或 yarn
- Git

### 2. 获取必要的密钥和 URL

#### 🔑 私钥
- **测试网私钥**: 用于 Sepolia 等测试网部署
- **主网私钥**: 用于主网部署 (谨慎使用!)

#### 🌐 RPC URL
- **Infura**: 推荐使用 Infura 的免费计划
- **Alchemy**: 另一个优秀的 RPC 提供商
- **自建节点**: 如果你有自己的以太坊节点

#### 🔍 API 密钥
- **Etherscan API Key**: 用于合约验证
- **CoinMarketCap API Key**: 用于 Gas 报告 (可选)

## 🛠️ 环境配置

### 1. 创建环境文件
```bash
# 复制环境配置模板
cp env.example .env

# 编辑环境文件
nano .env
```

### 2. 配置环境变量

#### 🔧 必要配置 (必须填写)
```bash
# 测试网私钥 (用于测试网部署)
PRIVATE_KEY=your_testnet_private_key_here

# Sepolia RPC URL
SEPOLIA_URL=https://sepolia.infura.io/v3/YOUR_INFURA_PROJECT_ID

# Etherscan API 密钥
ETHERSCAN_API_KEY=your_etherscan_api_key_here
```

#### 🌉 二层网络配置 (推荐配置)
```bash
# Arbitrum 网络
ARBITRUM_SEPOLIA_URL=https://arbitrum-sepolia.infura.io/v3/YOUR_INFURA_PROJECT_ID
ARBITRUM_URL=https://arbitrum-mainnet.infura.io/v3/YOUR_INFURA_PROJECT_ID

# Optimism 网络
OPTIMISM_SEPOLIA_URL=https://optimism-sepolia.infura.io/v3/YOUR_INFURA_PROJECT_ID
OPTIMISM_URL=https://optimism-mainnet.infura.io/v3/YOUR_INFURA_PROJECT_ID

# Polygon zkEVM 网络
POLYGON_ZKEVM_TESTNET_URL=https://polygon-zkevm-testnet.infura.io/v3/YOUR_INFURA_PROJECT_ID
POLYGON_ZKEVM_URL=https://polygon-zkevm-mainnet.infura.io/v3/YOUR_INFURA_PROJECT_ID

# Base 网络
BASE_SEPOLIA_URL=https://base-sepolia.infura.io/v3/YOUR_INFURA_PROJECT_ID
BASE_URL=https://base-mainnet.infura.io/v3/YOUR_INFURA_PROJECT_ID

# Linea 网络
LINEA_SEPOLIA_URL=https://linea-sepolia.infura.io/v3/YOUR_INFURA_PROJECT_ID
LINEA_URL=https://linea-mainnet.infura.io/v3/YOUR_INFURA_PROJECT_ID

# Scroll 网络
SCROLL_SEPOLIA_URL=https://scroll-sepolia.infura.io/v3/YOUR_INFURA_PROJECT_ID
SCROLL_URL=https://scroll-mainnet.infura.io/v3/YOUR_INFURA_PROJECT_ID

# zkSync Era 网络
ZKSYNC_ERA_SEPOLIA_URL=https://sepolia.era.zksync.io
ZKSYNC_ERA_URL=https://mainnet.era.zksync.io

# Mantle 网络
MANTLE_SEPOLIA_URL=https://rpc.sepolia.mantle.xyz
MANTLE_URL=https://rpc.mantle.xyz

# Manta 网络
MANTA_SEPOLIA_URL=https://pacific-rpc.sepolia.manta.network
MANTA_URL=https://pacific-rpc.manta.network
```

#### 🌐 主网配置 (生产部署)
```bash
# 主网私钥 (谨慎使用!)
MAINNET_PRIVATE_KEY=your_mainnet_private_key_here

# 主网 RPC URL
MAINNET_URL=https://mainnet.infura.io/v3/YOUR_INFURA_PROJECT_ID
```

### 3. 验证环境配置
```bash
# 检查环境配置
npm run check:env
```

## 🚀 部署步骤

### 1. 安装依赖
```bash
npm install
```

### 2. 编译合约
```bash
npm run compile
```

### 3. 运行测试
```bash
npm run test
```

### 4. 部署到测试网

#### Sepolia 测试网
```bash
npm run deploy:sepolia
```

#### 二层网络测试网
```bash
# Arbitrum Sepolia
npm run deploy:arbitrum-sepolia

# Optimism Sepolia
npm run deploy:optimism-sepolia

# Polygon zkEVM 测试网
npm run deploy:polygon-zkevm-testnet

# Base Sepolia
npm run deploy:base-sepolia

# Linea Sepolia
npm run deploy:linea-sepolia

# Scroll Sepolia
npm run deploy:scroll-sepolia

# zkSync Era Sepolia
npm run deploy:zksync-era-sepolia

# Mantle Sepolia
npm run deploy:mantle-sepolia

# Manta Sepolia
npm run deploy:manta-sepolia
```

### 5. 验证合约
```bash
# 验证 Sepolia 部署
npm run verify:sepolia

# 验证主网部署
npm run verify:mainnet
```

### 6. 部署到主网 (谨慎!)

#### 以太坊主网
```bash
npm run deploy:mainnet
```

#### 二层网络主网
```bash
# Arbitrum 主网
npm run deploy:arbitrum

# Optimism 主网
npm run deploy:optimism

# Polygon zkEVM 主网
npm run deploy:polygon-zkevm

# Base 主网
npm run deploy:base

# Linea 主网
npm run deploy:linea

# Scroll 主网
npm run deploy:scroll

# zkSync Era 主网
npm run deploy:zksync-era

# Mantle 主网
npm run deploy:mantle

# Manta 主网
npm run deploy:manta
```

### 7. 平台级初始化（🆕 多 Vault 架构）

完成基础部署后，必须执行以下治理步骤才能让整个平台正常运转：

| 步骤 | 调用者 (角色) | 关键函数 | 说明 |
|------|---------------|----------|------|
| 1 | Governance 多签 | `FeeRouter.setCaller(collateralManager, true)` | 将 CollateralManager 加入 FeeRouter 的 caller 白名单，才能分账 0.03% 手续费 |
| 2 | Governance 多签 | `CollateralManager.setFeeRouter(feeRouter)` | 设置 CollateralManager 内部 feeRouterAddr |
| 3 | Governance 多签 | `LiquidationEngine.setCaller(...)` (若未预设) | 使 LiquidationEngine 获得分账权限（清算时可能调用 FeeRouter） |
| 4 | Governance 多签 | `LiquidationEngine.registerVaultBatch([vault1,vault2,...])` | 一次性注册所有新部署的 CollateralVault |
| 5 | KeeperAdmin | KeeperRegistry.addKeeper(liquidatorAddr, ROLE_LIQUIDATOR) | 添加清算 Keeper 及其角色 |
| 6 | DevOps | Verify 所有 proxy & impl 合约 | Etherscan/Sourcify 验证，便于前端交互 |

> ⚠️ 若忘记执行第 1 步，CollateralManager 调用 FeeRouter 时会直接 revert `FeeRouter__CallerNotAllowed()`。

### 7.1 权限标准（长期形态：ORDER_CREATE 专用）

为避免团队混淆、确保最小授权与一致的风控路径，订单创建执行权限采用专用键：

- `ACTION_ORDER_CREATE`: 唯一用于鉴权执行 `LendingEngine.createLoanOrder(...)`（由撮合/编排入口代行）
- `ACTION_BORROW`: 仅用作“借款动作”的事件/语义标识与视图分发，不再授予任何地址用于鉴权

授权示例（仅授予撮合/编排入口，如 `VaultBusinessLogic`）:

```ts
// 取得 ACM 地址（示意）
const acm = await ethers.getContractAt('AccessControlManager', acmAddr);
const ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes('ORDER_CREATE'));

await acm.grantRole(ORDER_CREATE, vblAddress);
```

最小清单：
- 仅 `vblAddress` ← `ACTION_ORDER_CREATE`
- 可选：`vblAddress` ← `ACTION_REPAY`（若允许代用户还款）
- 不授予任何地址 `ACTION_BORROW`

说明：
- Registry 模块键无需改动（`KEY_ORDER_ENGINE`/`KEY_LE` 等保持不变）
- ACM 为任意 `bytes32` 角色哈希校验，无需升级即可支持 `ORDER_CREATE`

### 8. 环境变量补充（与脚本配合）

```bash
# FeeRouter 首次部署者地址 (rootCaller)
FEE_ROUTER_ROOT_CALLER=0xYourDeployer

# KeeperRegistry 管理员 (可添加 keeper)
KEEPER_ADMIN=0xYourOps
```

### 9. 常见故障排查

| 现象 | 可能原因 | 解决方案 |
|------|----------|----------|
| 存款/提款成功但 0.03% 手续费未扣 | CollateralManager 未设置 feeRouterAddr 或 feeRouter 未授权 caller | 检查治理步骤 1/2 |
| 清算交易 revert `VaultNotAllowed` | Vault 未注册到 LiquidationEngine | 执行 `registerVault()` |
| `safeApprove` revert | RWA Token 不支持非 0→0 →N approve | 已使用 increaseAllowance，如仍失败需检查 token 实现 |

---

> 完整的脚本示例可参考 `scripts/deploy.js` 与 `scripts/verify-deployment.js`，其中已包含白名单与治理初始化的自动调用。

## 🔍 部署后验证

### 1. 检查部署状态
```bash
# 验证部署
npm run verify:deployment
```

### 2. 查看网络配置
```bash
# 查看所有网络配置
npm run networks

# 验证网络配置
npm run networks:validate

# 查看测试网配置
npm run networks:testnets

# 查看主网配置
npm run networks:mainnets

# 查看二层网络配置
npm run networks:l2
```

## 🛡️ 安全注意事项

### 1. 私钥安全
- ✅ 永远不要提交 `.env` 文件到 Git
- ✅ 使用硬件钱包或安全的密钥管理
- ✅ 定期轮换私钥
- ❌ 不要在代码中硬编码私钥
- ❌ 不要在不安全的环境中存储私钥

### 2. 测试网部署
- ✅ 先在测试网充分测试
- ✅ 确保有足够的测试币
- ✅ 验证所有功能正常

### 3. 主网部署
- ✅ 进行全面的安全审计
- ✅ 使用多签钱包
- ✅ 分阶段部署
- ✅ 准备应急响应计划

## 🔧 故障排除

### 常见问题

#### 1. 私钥错误
```
Error: invalid private key
```
**解决方案**: 检查私钥格式，确保没有 `0x` 前缀

#### 2. RPC URL 错误
```
Error: could not detect network
```
**解决方案**: 检查 RPC URL 是否正确，确保网络可访问

#### 3. Gas 费用不足
```
Error: insufficient funds for gas
```
**解决方案**: 确保账户有足够的 ETH 支付 Gas 费用

#### 4. 合约验证失败
```
Error: Already Verified
```
**解决方案**: 合约可能已经验证过，检查 Etherscan

### 获取帮助
- 查看 [README.md](../README.md)
- 检查 [CI-CD.md](CI-CD.md)
- 查看测试文件了解功能
- 检查 Hardhat 配置

## 📊 部署检查清单

### 部署前
- [ ] 环境配置完成
- [ ] 依赖安装完成
- [ ] 合约编译成功
- [ ] 测试全部通过
- [ ] 安全审计完成
- [ ] 有足够的测试币/ETH

### 部署后
- [ ] 合约部署成功
- [ ] 合约验证成功
- [ ] 功能测试通过
- [ ] Gas 费用合理
- [ ] 文档更新完成

## 🎯 最佳实践

1. **渐进式部署**: 先在测试网部署，再部署到主网
2. **多环境测试**: 在多个测试网验证功能
3. **监控部署**: 使用区块浏览器监控部署状态
4. **文档记录**: 记录每次部署的详细信息
5. **备份配置**: 备份重要的配置信息
6. **团队协作**: 多人审查部署过程 
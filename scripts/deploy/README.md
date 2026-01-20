# 智能合约部署脚本 (Smart Contract Deployment Scripts)

本目录包含 RWA Lending Platform 智能合约系统的部署脚本，支持部署到本地网络、Arbitrum Sepolia 测试网和 Arbitrum 主网。

## 📁 文件结构

```
scripts/deploy/
├── deploylocal.ts              # 本地网络部署脚本
├── deploy-arbitrum-sepolia.ts  # Arbitrum Sepolia 测试网部署脚本
├── deploy-arbitrum.ts          # Arbitrum 主网部署脚本
└── README.md                   # 本文档
```

## 🎯 脚本概览

### 1. deploylocal.ts - 本地网络部署

**用途**：在本地 Hardhat 网络部署完整的智能合约系统

**特点**：
- 每次部署前自动清理缓存和旧配置
- 使用 Mock 代币（MockUSDC）进行测试
- MIN_DELAY 设置为 60 秒（方便调试）
- 自动为本地管理员授予所有必要权限

**输出文件**：
- `scripts/deployments/localhost.json` - 部署地址记录
- `frontend-config/contracts-localhost.ts` - 前端配置文件

**运行方式**：
```bash
# 启动本地 Hardhat 节点
npm run node

# 在另一个终端运行部署脚本
npx hardhat run scripts/deploy/deploylocal.ts --network localhost
```

---

### 2. deploy-arbitrum-sepolia.ts - Arbitrum Sepolia 测试网部署

**用途**：部署到 Arbitrum Sepolia 测试网

**特点**：
- 环境检查和余额验证
- 自动备份钱包资产信息
- MIN_DELAY 设置为 2 天
- 从配置文件读取真实代币地址（不使用 Mock）
- 完整的预言机系统配置
- 奖励系统完整部署

**网络配置**：
- Chain ID: `421614`
- RPC URL: `https://sepolia-rollup.arbitrum.io/rpc`
- Explorer: `https://sepolia.arbiscan.io`

**输出文件**：
- `scripts/deployments/arbitrum-sepolia.json` - 部署地址记录
- `frontend-config/contracts-arbitrum-sepolia.ts` - 前端配置文件

**环境变量要求**：
```bash
PRIVATE_KEY=your_private_key          # 必需
ARBISCAN_API_KEY=your_api_key        # 可选（用于验证）
```

**运行方式**：
```bash
npx hardhat run scripts/deploy/deploy-arbitrum-sepolia.ts --network arbitrum-sepolia
```

---

### 3. deploy-arbitrum.ts - Arbitrum 主网部署

**用途**：部署到 Arbitrum 主网

**特点**：
- 严格的环境检查（余额要求 0.1 ETH）
- MIN_DELAY 设置为 7 天（更保守）
- 从配置文件读取真实代币地址
- 完整的系统部署（52+ 个合约）
- 主网级别的安全配置

**网络配置**：
- Chain ID: `42161`
- RPC URL: `https://arb1.arbitrum.io/rpc`
- Explorer: `https://arbiscan.io`

**输出文件**：
- `scripts/deployments/arbitrum.json` - 部署地址记录
- `frontend-config/contracts-arbitrum.ts` - 前端配置文件

**环境变量要求**：
```bash
PRIVATE_KEY=your_private_key          # 必需
ARBISCAN_API_KEY=your_api_key        # 可选（用于验证）
```

**运行方式**：
```bash
npx hardhat run scripts/deploy/deploy-arbitrum.ts --network arbitrum
```

---

## 🏗️ 部署架构

所有部署脚本遵循相同的架构模式，部署顺序如下：

### 阶段 1: Registry 核心模块（Scheme A）
1. **Registry** - 主注册表合约（UUPS 可升级，单一入口/单一 Proxy）
2. **RegistryDynamicModuleKey** - 动态模块键注册表（可选，独立存储/独立升级）

### 阶段 2: 访问控制与白名单
6. **AccessControlManager** - 权限管理（非升级合约）
7. **AssetWhitelist** - 资产白名单
8. **AuthorityWhitelist** - 授权机构白名单

### 阶段 3: 预言机系统
9. **PriceOracle** - 价格预言机
10. **CoinGeckoPriceUpdater** - CoinGecko 价格更新器
11. 配置资产（从配置文件读取）

### 阶段 4: 费用路由
12. **FeeRouter** - 费用路由
13. **FeeRouterView** - 费用路由视图

### 阶段 5: Vault 核心系统
14. **CollateralManager** - 抵押品管理器
15. **LendingEngine** - 借贷引擎
16. **LiquidationRiskManager** - 清算风险管理器（需要链接库）
17. **VaultBusinessLogic** - Vault 业务逻辑
18. **VaultRouter** - Vault 视图（临时部署用于初始化）
19. **VaultCore** - Vault 核心
20. **VaultLendingEngine** - Vault 借贷引擎
21. **EarlyRepaymentGuaranteeManager** - 提前还款保证金管理器
22. **GuaranteeFundManager** - 担保基金管理器

### 阶段 6: 视图模块
24. **HealthView** - 健康度视图
25. **RegistryView** - 注册表视图
26. **StatisticsView** - 统计视图
27. **PositionView** - 持仓视图
28. **PreviewView** - 预览视图
29. **DashboardView** - 仪表板视图
30. **UserView** - 用户视图
31. **AccessControlView** - 访问控制视图
32. **CacheOptimizedView** - 缓存优化视图
33. **LendingEngineView** - 借贷引擎视图
34. **RiskView** - 风险视图
35. **ViewCache** - 视图缓存
36. **EventHistoryManager** - 事件历史管理器
37. **ValuationOracleView** - 估值预言机视图
38. **LiquidatorView** - 清算视图
39. **BatchView** - 批量视图

### 阶段 7: 监控模块
40. **DegradationCore** - 降级核心
41. **DegradationStorage** - 降级存储
42. **ModuleHealthView** - 模块健康视图
43. **DegradationMonitor** - 降级监控器

### 阶段 8: 奖励系统
44. **RewardPoints** - 奖励积分代币
45. **RewardManagerCore** - 奖励管理核心
46. **RewardCore** - 奖励核心
47. **RewardConsumption** - 奖励消费
48. **RewardManager** - 奖励管理器
49. **RewardConfig** - 奖励配置
50. **RewardView** - 奖励视图

### 阶段 9: 其他模块
51. **LoanNFT** - 贷款 NFT
52. **MockUSDC** - Mock USDC（仅本地网络）

### 阶段 10: 模块注册
- 将所有已部署的模块注册到 Registry
- 设置动态模块键注册表
- 绑定关键模块（LIQUIDATION_MANAGER, HEALTH_VIEW 等）

### 阶段 11: 权限配置
- 为部署者授予必要的权限
- 配置 RewardPoints 的 MINTER_ROLE
- 配置预言机系统权限

### 阶段 12: 前端配置生成
- 生成前端配置文件（TypeScript）
- 包含所有合约地址和网络配置

---

## 🔧 部署配置

### 网络特定配置

| 配置项 | 本地网络 | Arbitrum Sepolia | Arbitrum 主网 |
|--------|---------|------------------|---------------|
| MIN_DELAY | 60 秒 | 2 天 | 7 天 |
| 代币来源 | MockUSDC | 配置文件 | 配置文件 |
| 余额要求 | 无 | 0.01 ETH | 0.1 ETH |
| 环境检查 | 无 | 完整检查 | 完整检查 |
| 备份功能 | 无 | 有 | 无 |

### 资产配置文件

测试网和主网部署需要资产配置文件：

**Arbitrum Sepolia**: `scripts/assets.arbitrum-sepolia.json`
```json
{
  "network": "arbitrum-sepolia",
  "chainId": 421614,
  "assets": [
    {
      "address": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      "coingeckoId": "usd-coin",
      "decimals": 6,
      "maxPriceAge": 3600,
      "active": true
    }
  ]
}
```

**Arbitrum**: `scripts/assets.arbitrum.json`
```json
{
  "network": "arbitrum",
  "chainId": 42161,
  "assets": [
    {
      "address": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      "coingeckoId": "usd-coin",
      "decimals": 6,
      "maxPriceAge": 3600,
      "active": true
    }
  ]
}
```

---

## 📋 部署前准备

### 1. 环境变量配置

创建 `.env` 文件（参考 `.env.template`）：

```bash
# 必需
PRIVATE_KEY=your_private_key_here

# 可选（用于合约验证）
ARBISCAN_API_KEY=your_arbiscan_api_key

# 本地网络可选
LOCAL_ADMIN_ADDRESS=your_local_admin_address
```

### 2. 安装依赖

```bash
npm install
```

### 3. 编译合约

```bash
npm run compile
```

### 4. 配置 Hardhat 网络

确保 `hardhat.config.ts` 中配置了正确的网络：

```typescript
networks: {
  localhost: {
    url: "http://127.0.0.1:8545"
  },
  "arbitrum-sepolia": {
    url: "https://sepolia-rollup.arbitrum.io/rpc",
    chainId: 421614,
    accounts: [process.env.PRIVATE_KEY]
  },
  arbitrum: {
    url: "https://arb1.arbitrum.io/rpc",
    chainId: 42161,
    accounts: [process.env.PRIVATE_KEY]
  }
}
```

---

## 🚀 快速开始

### 本地开发部署

```bash
# 1. 启动本地节点（终端 1）
npm run node

# 2. 部署合约（终端 2）
npx hardhat run scripts/deploy/deploylocal.ts --network localhost
```

### 测试网部署

```bash
# 1. 确保环境变量已配置
# 2. 确保账户有足够的测试 ETH
# 3. 运行部署脚本
npx hardhat run scripts/deploy/deploy-arbitrum-sepolia.ts --network arbitrum-sepolia
```

### 主网部署

```bash
# ⚠️ 主网部署前请仔细检查所有配置
# 1. 确保环境变量已配置
# 2. 确保账户有足够的 ETH（至少 0.1 ETH）
# 3. 检查所有配置是否正确
# 4. 运行部署脚本
npx hardhat run scripts/deploy/deploy-arbitrum.ts --network arbitrum
```

---

## 📊 部署输出

### 部署地址文件

部署完成后，会在 `scripts/deployments/` 目录生成 JSON 文件：

```json
{
  "Registry": "0x...",
  // "RegistryCore": REMOVED (Scheme A: no compat proxies)
  "AccessControlManager": "0x...",
  ...
}
```

### 前端配置文件

同时会在 `frontend-config/` 目录生成 TypeScript 配置文件：

```typescript
export const CONTRACT_ADDRESSES = {
  Registry: '0x...',
  // RegistryCore: REMOVED (Scheme A: no compat proxies)
  ...
};

export const NETWORK_CONFIG = {
  chainId: 421614,
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  explorer: 'https://sepolia.arbiscan.io',
  name: 'arbitrum-sepolia'
};
```

---

## 🔍 部署验证

### 检查部署状态

```bash
# 查看部署地址文件
cat scripts/deployments/localhost.json

# 查看前端配置
cat frontend-config/contracts-localhost.ts
```

### 验证合约

```bash
# 验证单个合约（需要 API Key）
npx hardhat verify --network arbitrum-sepolia <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS>
```

### 测试部署

部署完成后，可以运行测试脚本验证：

```bash
npm test
```

---

## ⚠️ 注意事项

### 本地网络

- 每次重启本地节点后，需要重新部署
- 本地部署会自动清理旧配置
- MockUSDC 会自动部署用于测试

### 测试网

- 确保账户有足够的测试 ETH（至少 0.01 ETH）
- 部署前会自动检查网络连接和余额
- 会自动备份钱包资产信息
- 需要配置资产文件（`assets.arbitrum-sepolia.json`）

### 主网

- ⚠️ **主网部署不可逆，请仔细检查所有配置**
- 确保账户有足够的 ETH（至少 0.1 ETH）
- MIN_DELAY 设置为 7 天，更保守
- 需要配置资产文件（`assets.arbitrum.json`）
- 建议先在测试网完整测试后再部署主网

### 通用注意事项

1. **私钥安全**：永远不要将私钥提交到版本控制系统
2. **Gas 费用**：部署大量合约需要较多 Gas，确保账户余额充足
3. **网络延迟**：部署过程可能需要较长时间，请耐心等待
4. **错误处理**：如果部署失败，检查错误信息并修复后重新运行
5. **增量部署**：脚本支持增量部署，已部署的合约不会重复部署

---

## 🔄 增量部署

所有部署脚本支持增量部署：

- 如果合约已部署，脚本会跳过该合约
- 只部署缺失的合约
- 已部署的合约地址会从部署文件中读取

**重新部署单个合约**：

如果需要重新部署某个合约，可以：
1. 从部署文件中删除该合约的地址
2. 重新运行部署脚本

---

## 🛠️ 故障排除

### 常见问题

**1. 编译错误**
```bash
# 清理缓存并重新编译
npm run clean
npm run compile
```

**2. 网络连接失败**
- 检查 RPC URL 是否正确
- 检查网络连接
- 尝试使用其他 RPC 端点

**3. 余额不足**
- 检查账户余额
- 测试网可以通过水龙头获取测试 ETH

**4. 权限错误**
- 检查私钥是否正确
- 检查账户是否有部署权限

**5. 合约验证失败**
- 检查构造函数参数是否正确
- 确保使用了正确的编译器版本

---

## 📚 相关文档

- [架构指南](../docs/Architecture-Guide.md)
- [Registry 系统](../docs/registry-deployment.md)
- [部署工具指南](../docs/cleanup-tools-guide.md)
- [环境变量配置](../docs/environment-variables.md)

---

## 🔗 相关脚本

- `scripts/utils/configure-assets.ts` - 资产配置工具
- `scripts/utils/deploymentUtils.ts` - 部署工具函数
- `scripts/utils/saveAddress.ts` - 地址保存工具

---

## 📝 更新日志

### 最新更新

- ✅ 统一了所有部署脚本的结构
- ✅ 添加了完整的模块注册逻辑
- ✅ 支持动态模块键注册表
- ✅ 自动生成前端配置文件
- ✅ 完善了权限配置流程

---

## 📞 支持

如有问题，请参考：
- [项目 README](../../README.md)
- [智能合约标准](../docs/SmartContractStandard.md)
- [测试文件标准](../docs/test-file-standards.md)

---

## 📄 许可证

MIT License

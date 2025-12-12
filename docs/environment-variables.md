# 环境变量配置指南

## 概述

本文档列出了 RWA Lending Platform 项目所需的所有环境变量。

## GitHub Secrets 配置

请在 GitHub 仓库的 Settings > Secrets and variables > Actions 中配置以下变量：

### 审批相关

| 变量名 | 描述 | 示例 |
|--------|------|------|
| `APPROVAL_SECRET` | 审批密钥 | `your_value_here` |
| `APPROVERS` | 审批者列表 | `your_value_here` |
| `PRIVATE_KEY` | 测试网私钥 | `your_value_here` |
| `SEPOLIA_URL` | Sepolia RPC URL | `your_value_here` |
| `MAINNET_PRIVATE_KEY` | 主网私钥 | `your_value_here` |
| `MAINNET_URL` | 主网 RPC URL | `your_value_here` |
| `ARBITRUM_SEPOLIA_URL` | Arbitrum Sepolia RPC URL | `your_value_here` |
| `OPTIMISM_SEPOLIA_URL` | Optimism Sepolia RPC URL | `your_value_here` |
| `POLYGON_ZKEVM_TESTNET_URL` | Polygon zkEVM 测试网 RPC URL | `your_value_here` |
| `BASE_SEPOLIA_URL` | Base Sepolia RPC URL | `your_value_here` |
| `LINEA_SEPOLIA_URL` | Linea Sepolia RPC URL | `your_value_here` |
| `SCROLL_SEPOLIA_URL` | Scroll Sepolia RPC URL | `your_value_here` |
| `ZKSYNC_ERA_SEPOLIA_URL` | zkSync Era Sepolia RPC URL | `your_value_here` |
| `MANTLE_SEPOLIA_URL` | Mantle Sepolia RPC URL | `your_value_here` |
| `MANTA_SEPOLIA_URL` | Manta Sepolia RPC URL | `your_value_here` |
| `ARBITRUM_URL` | Arbitrum 主网 RPC URL | `your_value_here` |
| `OPTIMISM_URL` | Optimism 主网 RPC URL | `your_value_here` |
| `POLYGON_ZKEVM_URL` | Polygon zkEVM 主网 RPC URL | `your_value_here` |
| `BASE_URL` | Base 主网 RPC URL | `your_value_here` |
| `LINEA_URL` | Linea 主网 RPC URL | `your_value_here` |
| `SCROLL_URL` | Scroll 主网 RPC URL | `your_value_here` |
| `ZKSYNC_ERA_URL` | zkSync Era 主网 RPC URL | `your_value_here` |
| `MANTLE_URL` | Mantle 主网 RPC URL | `your_value_here` |
| `MANTA_URL` | Manta 主网 RPC URL | `your_value_here` |
| `ETHERSCAN_API_KEY` | Etherscan API 密钥 | `your_value_here` |
| `SLACK_WEBHOOK_URL` | Slack Webhook URL | `your_value_here` |

## 网络配置

### 测试网配置

| 网络 | RPC URL 变量 | 私钥变量 | 浏览器 API 变量 |
|------|-------------|----------|----------------|
| sepolia | `SEPOLIA_URL` | `PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| arbitrum-sepolia | `ARBITRUM_SEPOLIA_URL` | `PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| optimism-sepolia | `OPTIMISM_SEPOLIA_URL` | `PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| polygon-zkevm-testnet | `POLYGON_ZKEVM_TESTNET_URL` | `PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| base-sepolia | `BASE_SEPOLIA_URL` | `PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| linea-sepolia | `LINEA_SEPOLIA_URL` | `PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| scroll-sepolia | `SCROLL_SEPOLIA_URL` | `PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| zksync-era-sepolia | `ZKSYNC_ERA_SEPOLIA_URL` | `PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| mantle-sepolia | `MANTLE_SEPOLIA_URL` | `PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| manta-sepolia | `MANTA_SEPOLIA_URL` | `PRIVATE_KEY` | `ETHERSCAN_API_KEY` |

### 主网配置

| 网络 | RPC URL 变量 | 私钥变量 | 浏览器 API 变量 |
|------|-------------|----------|----------------|
| mainnet | `MAINNET_URL` | `MAINNET_PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| arbitrum | `ARBITRUM_URL` | `MAINNET_PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| optimism | `OPTIMISM_URL` | `MAINNET_PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| polygon-zkevm | `POLYGON_ZKEVM_URL` | `MAINNET_PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| base | `BASE_URL` | `MAINNET_PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| linea | `LINEA_URL` | `MAINNET_PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| scroll | `SCROLL_URL` | `MAINNET_PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| zksync-era | `ZKSYNC_ERA_URL` | `MAINNET_PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| mantle | `MANTLE_URL` | `MAINNET_PRIVATE_KEY` | `ETHERSCAN_API_KEY` |
| manta | `MANTA_URL` | `MAINNET_PRIVATE_KEY` | `ETHERSCAN_API_KEY` |

## 配置验证

运行以下命令验证环境变量配置：

```bash
node scripts/check-env-vars.js
```

## 安全注意事项

1. **私钥安全**: 确保私钥变量使用安全的私钥，不要使用测试私钥
2. **API 密钥**: 定期轮换 API 密钥
3. **访问控制**: 限制对 GitHub Secrets 的访问权限
4. **监控**: 定期检查环境变量的使用情况

## 故障排除

### 常见问题

1. **环境变量未找到**: 确保在正确的 GitHub Secrets 中配置了变量
2. **权限不足**: 检查 GitHub Actions 是否有权限访问 Secrets
3. **网络连接**: 确保 RPC URL 是可访问的
4. **API 限制**: 检查 API 密钥是否有效且未超出使用限制

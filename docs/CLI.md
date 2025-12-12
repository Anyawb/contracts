## Contracts CLI 使用说明

本 CLI 封装了 Hardhat 任务，便于在 `contracts` 包内执行常用链上操作。

### 前置
- 在项目根目录配置环境变量（RPC_URL/ARBITRUM_SEPOLIA_RPC_URL、PRIVATE_KEY 等）。
- 在 `contracts` 目录执行命令：`pnpm -C contracts ...`。

### 可用命令

1) 检查 Registry 映射（只读）
```bash
pnpm -C contracts run cli registry:check --networkName localhost
# or
pnpm -C contracts run cli registry:check --networkName arbitrum-sepolia
```

2) 设置单个模块映射
```bash
pnpm -C contracts run cli registry:set --module VAULT_VIEW --address 0x... --networkName localhost
```

3) 批量同步部署文件到 Registry
```bash
pnpm -C contracts run cli registry:sync --networkName localhost
pnpm -C contracts run cli registry:sync --networkName arbitrum-sepolia --only VAULT_CORE,VAULT_VIEW
```

4) 验证 Registry 家族合约
```bash
pnpm -C contracts run cli registry:verify:family --deployFile scripts/deployments/localhost.json
```

5) 极简迁移（UUPS/存储版本）
```bash
pnpm -C contracts run cli registry:migrate:min --registry 0x... --newImpl 0x... --newStorageVersion 2
```

### 提示
- 如需扩展命令，可在 `contracts/scripts/cli.ts` 或 Hardhat 任务下追加新子命令。



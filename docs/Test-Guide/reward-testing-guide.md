# Reward 测试指南

本文档描述本仓库当前仍在使用的 Reward 相关测试（以 `test/Reward/` 目录为准）。

> 术语与 SSOT（重要）：
> - **奖励通证（EasyToken）地址 SSOT**：`Registry[KEY_EASY_TOKEN]`。

## 📁 测试文件结构（当前）

```
test/Reward/
├── RewardSSOT.acceptance.test.ts         # Reward SSOT / 关键不变量验收
├── RewardManagerIntegration.test.ts      # RewardManager / RMCore / RewardView 集成
├── EasyEconomics.integration.test.ts     # Easy 发行/消耗/回收经济路径集成
└── FeatureRegistry.test.ts               # FeatureRegistry / 功能开关相关测试
```

> 注意：旧的“订阅服务价格体系/升级/兑换/过期”等相关合约与测试已从仓库移除；本指南仅覆盖当前仍存在的 Reward 测试。

## 🚀 运行测试

运行全部 Reward 测试：

```bash
npx hardhat test test/Reward/
```

运行单个测试文件：

```bash
npx hardhat test test/Reward/RewardSSOT.acceptance.test.ts
npx hardhat test test/Reward/RewardManagerIntegration.test.ts
npx hardhat test test/Reward/EasyEconomics.integration.test.ts
npx hardhat test test/Reward/FeatureRegistry.test.ts
```

按关键字筛选（grep）：

```bash
npx hardhat test test/Reward/RewardSSOT.acceptance.test.ts --grep "SSOT"
```

带 Gas 报告：

```bash
REPORT_GAS=true npx hardhat test test/Reward/
```

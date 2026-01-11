# 清算系统测试指南（对齐当前实现）

## 🎯 概述

本指南以 `docs/Architecture-Guide.md` 为准，面向“当前清算域实现”的回归测试与排障：

- **唯一对外写入口（SSOT）**：`SettlementManager`
- **清算执行器**：`LiquidationManager`（直达账本写入 + best-effort 单点推送）
- **DataPush 单点**：`LiquidatorView`（`KEY_LIQUIDATION_VIEW`）
- **风控只读**：`LiquidationRiskManager`（健康因子 bps + 风险分数 0-100）
- **配置 SSOT**：`LiquidationConfigModule`
- **残值分配 SSOT**：`LiquidationPayoutManager`

> 旧清算模块族（如 `LiquidationCollateralManager` / `LiquidationDebtManager` / `LiquidationCoreOperations` / `LiquidationViewLibrary`）已下线/移除；对应旧测试也已移除。请以本文件列出的“真实测试目录”与当前代码为准。

## 📁 当前测试文件（真实目录）

清算域测试位于 `test/Vault/liquidation/`：

```
test/Vault/liquidation/
├── Liquidation.failure-scenarios.test.ts
├── LiquidationRiskManagerRegistry.test.ts
├── LiquidationRiskManager.graceful-degradation.test.ts
├── LiquidationGuaranteeManager.registry.test.ts
└── LegacyLiquidationModules.disabled.test.ts
```

## ✅ 推荐运行顺序（最小可信回归集）

```bash
pnpm -s run compile
pnpm -s exec hardhat test "test/Vault/liquidation/Liquidation.failure-scenarios.test.ts"
pnpm -s exec hardhat test "test/Vault/liquidation/LiquidationRiskManagerRegistry.test.ts"
pnpm -s exec hardhat test "test/Vault/liquidation/LiquidationRiskManager.graceful-degradation.test.ts"
```

## 🧪 每个测试文件覆盖什么

- **`Liquidation.failure-scenarios.test.ts`**
  - **目标**：验证清算关键回滚条件、权限边界、批量上限与 best-effort 推送失败的可观测性（事件）。
  - **关注点**：避免把 View/推送问题放大为“资金层不可用”；确保 write-path 原子性与权限严谨。

- **`LiquidationRiskManagerRegistry.test.ts`**
  - **目标**：验证 `LiquidationRiskManager` 的 Registry 集成、升级安全与 batch size 防 DoS。

- **`LiquidationRiskManager.graceful-degradation.test.ts`**
  - **目标**：验证风控只读聚合在依赖模块异常时的 graceful-degradation 行为与一致口径（bps/0-100）。

- **`LiquidationGuaranteeManager.registry.test.ts`**
  - **目标**：验证与保证金模块的注册/权限联动（按当前实现的 Registry 模块装配为准）。

- **`LegacyLiquidationModules.disabled.test.ts`**
  - **目标**：防止旧模块族被误部署/误注册/误调用（防“旧入口回流”）。

## 🔧 常用排障命令

```bash
# 单文件 solhint（改动合约后强烈建议）
npx -s solhint "src/Vault/liquidation/modules/SettlementManager.sol"
npx -s solhint "src/Vault/liquidation/modules/LiquidationManager.sol"
npx -s solhint "src/Vault/liquidation/modules/LiquidationRiskManager.sol"

# 对清算域整体做一次快速 lint
npx -s solhint "src/Vault/liquidation/modules/*.sol"
npx -s solhint "src/Vault/liquidation/libraries/*.sol"
```

---

**最后更新**：2026-01

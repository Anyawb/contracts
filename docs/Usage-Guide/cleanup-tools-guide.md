# 清算域清理/回归检查工具指南（对齐当前实现）

## 🎯 目的

本指南用于在清算域做“架构对齐/清理/重构”后，快速完成最小可信回归检查，避免旧模块族回流与文档/脚本口径漂移。

## ✅ 推荐检查顺序

```bash
# 1) 编译（必须）
pnpm -s run compile

# 2) Solhint（建议：只对改动文件/目录）
npx -s solhint "src/Vault/liquidation/modules/*.sol"
npx -s solhint "src/Vault/liquidation/libraries/*.sol"

# 3) 关键测试（至少跑一组最贴近改动的）
pnpm -s exec hardhat test "test/Vault/liquidation/Liquidation.failure-scenarios.test.ts"
pnpm -s exec hardhat test "test/Vault/liquidation/LiquidationRiskManagerRegistry.test.ts"
```

## 🔍 防“旧入口回流”检查（强烈建议）

- **目标**：确保旧清算模块族不会被误部署/误注册/误调用（例如 `LiquidationCollateralManager` / `LiquidationDebtManager` / `LiquidationCoreOperations` / `LiquidationViewLibrary`）。
- **执行**：运行禁用测试用例：

```bash
pnpm -s exec hardhat test "test/Vault/liquidation/LegacyLiquidationModules.disabled.test.ts"
```

## 🧾 文档一致性（建议）

清算域的权威口径以 `docs/Architecture-Guide.md` 为准；若本次变更涉及模块集合/入口/事件，建议再跑一次“文档残留关键词”扫描：

```bash
rg -n "LiquidationDebtManager|LiquidationCollateralManager|LiquidationCoreOperations|LiquidationViewLibrary" docs
```

---

**最后更新**：2026-01

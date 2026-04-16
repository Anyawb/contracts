# 清算残值分配配置指南（按当前代码对齐）

## References

- 资金链 SSOT: [`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`](../Funds-Flow-Architecture-Guide.md)
- 完整清算逻辑: [`liquidation-complete-logic.md`](./liquidation-complete-logic.md)
- SettlementManager 状态说明: [`SettlementManager-Refactor-Plan.md`](./SettlementManager-Refactor-Plan.md)

## 概述

当前代码中，清算残值分配的配置 SSOT 是 `LiquidationPayoutManager`。

- Registry key: `KEY_LIQUIDATION_PAYOUT_MANAGER`
- 该模块只负责两件事：
	- 保存 recipients 与 rates
	- 按 `calculateShares(collateralAmount)` 计算四份额
- 它本身不执行 seize collateral，也不直接转账；真正执行转账的是 `LiquidationManager` 或 `SettlementManager` fallback 路径

> 本文只说明如何配置 recipients / rates。清算资金从哪里来、先后顺序、具体资产去向与对账语义，统一以 Funds-Flow SSOT 为准。

## 当前实现的 recipients 与 shares

### 固定配置的 recipients

`LiquidationPayoutManager` 当前只存三类固定收款地址：

- `platform`
- `reserve`
- `lenderCompensation`

它们都必须是非零地址。

### 非固定配置的 liquidator recipient

liquidator 收款地址不存放在 `PayoutRecipients` 里。

- 直接走 `LiquidationManager.liquidate(...)` 时，liquidator recipient 默认是 `msg.sender`
- 走 `LiquidationManager.liquidateFromSettlementManager(...)` 时，liquidator recipient 是 SettlementManager 透传进来的原始 keeper 地址

也就是说，当前代码没有单独的 liquidator recipient 配置项或 whitelist 模块。

### rates 约束

`PayoutRates` 包含四项：

- `platformBps`
- `reserveBps`
- `lenderBps`
- `liquidatorBps`

代码硬约束：四项之和必须等于 `10_000`。

### rounding 规则

`calculateShares(collateralAmount)` 会：

- 先按前三项做整数除法
- 所有舍入余数统一给 `liquidatorShare`

因此始终满足：

`platformShare + reserveShare + lenderShare + liquidatorShare == collateralAmount`

## 初始化与部署要求

`LiquidationPayoutManager.initialize(...)` 需要：

- `registryAddr`
- `accessControlAddr`
- `PayoutRecipients`
- `PayoutRates`

初始化时会校验：

- `registryAddr != 0`
- `accessControlAddr != 0`
- 若 Registry 中已经设置 `KEY_ACCESS_CONTROL`，它必须与 `accessControlAddr` 一致
- 三个 recipients 都不是 0 地址
- 四项 rates 之和等于 `10_000`

## 治理更新路径

当前治理写入口有三种：

- `updateConfig(recipients, rates)`
- `updateRecipients(recipients)`
- `updateRates(rates)`

这三个入口都要求调用者具备 `ACTION_SET_PARAMETER`。

升级路径仍单独走 UUPS `_authorizeUpgrade(...)`，要求 `ACTION_UPGRADE_MODULE`。

## 运维与集成注意事项

1. `lenderCompensation` 当前是固定配置地址，不是按 `orderId` 动态解析的 lender。
2. `LiquidationPayoutManager` 只是配置模块，不会单独发起 liquidation。
3. 如果链下要读取当前配置，应先通过 Registry 解析 `KEY_LIQUIDATION_PAYOUT_MANAGER`，再读取 `getRecipients()` 与 `getRates()`。
4. 文档中如果仍出现“当前 lender 直接作为 payout recipient”的说法，应视为旧计划口径，不代表当前实现。

## 当前代码中的常量与默认示例

代码库里存在 liquidation 域常量：

- `DEFAULT_LIQUIDATION_BONUS = 1000`
- `PLATFORM_REVENUE_RATE = 300`
- `RISK_RESERVE_RATE = 200`
- `LENDER_COMPENSATION_RATE = 1700`
- `LIQUIDATOR_REWARD_RATE = 7800`

但要注意：这些只是 liquidation 域的常量示例。真正生效的 on-chain 分配比例仍以 `LiquidationPayoutManager.getRates()` 为准。

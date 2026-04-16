# 清算收款地址控制现状说明（替代旧白名单计划稿）

## 概述

这份文档原本是 recipient whitelist 计划稿。按当前代码看，协议里并没有一个独立落地的清算收款白名单模块；实际的收款控制是由各个清算编排与分账模块隐式完成的。

因此，当前正确口径不是“系统已经实现了一套动态 recipient whitelist”，而是：

- borrower 的 collateral 返还由 `SettlementManager` / `BlocksOnlyCoordinator` 显式指定给 borrower 自己
- liquidation payout 的 `platform / reserve / lenderCompensation` 由 `LiquidationPayoutManager` 固定配置
- liquidator recipient 由实际调用路径决定，默认就是 keeper / caller

## 当前实现的 recipient 控制来源

### 1. borrower collateral release

在非清算的结算分支里：

- `SettlementManager.repayAndSettle(...)` 会把 collateral 释放给 borrower
- `BlocksOnlyCoordinator._releaseAllCollateral(...)` 也会把 collateral 释放给 borrower

这部分没有额外 recipient whitelist；接收者就是 borrower 本人。

### 2. liquidation payout fixed recipients

`LiquidationPayoutManager` 当前固定保存三类 recipient：

- `platform`
- `reserve`
- `lenderCompensation`

这三个地址都是治理配置项，不是按订单动态解析。

### 3. liquidator recipient

当前 liquidator recipient 也没有独立 whitelist：

- `LiquidationManager.liquidate(...)` 中默认是 `msg.sender`
- `LiquidationManager.liquidateFromSettlementManager(...)` 中是 SettlementManager 透传进来的 keeper 地址

## 当前没有实现的内容

以下内容在当前代码中并没有作为落地功能存在：

1. 基于 `orderId -> currentLender(orderId)` 的 liquidation payout 动态收款白名单。
2. 单独的 `LiquidatorRewardVault` 或 liquidator recipient registry。
3. 一个专门负责 recipient allowlist / denylist 的清算模块。
4. 用 whitelist 合约对 borrower / lender / liquidator 收款地址再做二次许可。

如果旧文档或讨论里出现这些说法，应视为未来方案或历史草稿，不代表当前实现。

## 当前代码下的安全边界

### platform / reserve / lenderCompensation

- 由 `LiquidationPayoutManager` 配置
- 三个地址都必须非零
- 更新需要 `ACTION_SET_PARAMETER`

### liquidator

- 当前实现默认把 liquidator 份额给实际执行清算的一方
- legacy / 通用订单通过 SettlementManager compatibility path 保留原始 keeper 地址
- blocks-only maturity 收尾不走 `LiquidationManager.liquidate(...)`；当前产品语义下不存在额外 liquidator recipient 份额分配

### borrower

- 在结算释放路径里只能收到自己的 collateral
- 当前实现没有“把 borrower collateral release 改发给第三方地址”的独立配置面

## 对文档与集成方的建议口径

如果你是前端、运维或链下索引方，应按以下方式理解当前实现：

1. 不要寻找一个不存在的 recipient whitelist 合约。
2. 如需读取 payout 固定地址，请读 `LiquidationPayoutManager.getRecipients()`。
3. 如需理解谁拿到 liquidator 份额，请根据实际调用路径判断：
   - legacy / 通用订单：看 SettlementManager 传入的 keeper
   - blocks-only：当前 maturity 收尾为 borrower refund / lender delivery，不适用通用 liquidation recipient 模型
4. 如需未来实现“动态 lender recipient”或“liquidator 受限接收地址”，应作为新功能单独设计，不应假设当前代码已经支持。

## 若未来继续做 recipient whitelist，应新增而不是假定已存在

如果后续确实需要更强的 recipient 控制，建议作为新方案单独推进，例如：

- recipient registry / allowlist module
- liquidator reward vault
- order-scoped dynamic lender resolution and payout routing
- timelock-governed recipient mutation policy

但在这些功能真正落地前，本文档应只描述当前代码已实现的收款控制边界。


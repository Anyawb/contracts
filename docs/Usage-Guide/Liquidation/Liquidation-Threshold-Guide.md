# 清算阈值说明（与当前实现对齐）

## 概述

清算阈值用于判断用户是否进入 liquidation 分支。当前代码里，这个口径不是“某一个文件静态定义后到处复制”，而是一个带迁移兼容的参数读取链：

- 默认值与合法范围定义在 `LiquidationTypes`
- 对外读取入口主要是 `LiquidationRiskManager`
- 若已注册 `KEY_LIQUIDATION_CONFIG_MANAGER`，则优先读 `LiquidationConfigModule`
- 若未注册，则回退到 `LiquidationRiskManager` 本地 mirror 变量

因此，最准确的说法是：当前阈值读取已经优先收敛到 `LiquidationConfigModule`，但 `LiquidationRiskManager` 仍保留兼容镜像与透传更新能力。

## 默认值与合法范围

当前常量定义是：

```solidity
uint256 internal constant DEFAULT_LIQUIDATION_THRESHOLD = 10_500;
uint256 internal constant MIN_LIQUIDATION_THRESHOLD = 10_000;
uint256 internal constant MAX_LIQUIDATION_THRESHOLD = 15_000;
```

含义是：

- 默认阈值 105%
- 最低允许值 100%
- 最高允许值 150%

单位全部是 bps，`10_000 = 100%`。

## 当前判断逻辑

对外最常见的判断入口是：

```solidity
function isLiquidatable(address user) external view returns (bool) {
    (uint256 hf, bool valid) = _getUserHealthFactorFromHealthView(user);
    if (!valid) return false;
    return hf < _getLiquidationThresholdBps();
}
```

这里有两个必须明确的当前语义：

1. 判断标准是 `healthFactor < liquidationThreshold`。
2. 如果 `HealthView` 缓存无效，返回值直接是 `false`，而不是“保守地判定可清算”。

这意味着系统当前选择的是“缓存无效时不放行清算判断”，而不是“缓存无效时强制进入清算”。

## 风险模块与配置模块的分工

### LiquidationRiskManager

当前职责：

- 提供 `getLiquidationThreshold()`、`getMinHealthFactor()`、`getMaxLtvBps()` 等对外读取接口
- 提供 `isLiquidatable(...)`、`batchIsLiquidatable(...)`、`getUserRiskAssessment(...)` 等风险查询接口
- 提供治理兼容入口 `updateLiquidationThreshold(...)`、`updateMinHealthFactor(...)`、`updateMaxLtvBps(...)`

但它不是一个纯本地单点 SSOT。它的读取逻辑会优先转向 `KEY_LIQUIDATION_CONFIG_MANAGER`。

### LiquidationConfigModule

当前职责：

- 作为阈值、最小健康因子、最大 LTV 的配置承载体
- 接收来自 RiskManager 的兼容更新调用
- 对原始 caller 做 `ACTION_SET_PARAMETER` 权限校验

因此，如果部署里已经注册了 `KEY_LIQUIDATION_CONFIG_MANAGER`，链上有效阈值应以 `LiquidationConfigModule` 中的当前值为准。

## 更新路径

当前推荐理解方式不是“直接对某个 storage 变量写值”，而是：

1. 治理方调用 `LiquidationRiskManager.updateLiquidationThreshold(newThreshold)`。
2. RiskManager 先校验范围。
3. 如果 `KEY_LIQUIDATION_CONFIG_MANAGER` 已配置，则透传给 `LiquidationConfigModule.updateLiquidationThresholdFromRiskManager(newThreshold, msg.sender)`。
4. 同时更新 RiskManager 自己的 mirror 变量并发出事件。

这是一条兼容迁移路径，不是两个完全独立的配置系统。

## 最小健康因子与最大 LTV

当前文档不应只讲 liquidation threshold，因为代码里这三个参数是一组一起演进的：

- `liquidationThreshold`
- `minHealthFactor`
- `maxLtvBps`

它们都遵循同样的读取逻辑：

- 优先读 `LiquidationConfigModule`
- 未配置时回退到 RiskManager mirror

因此，前端和链下不要只读取一个字段就假设风险参数已经完整同步。

## 查询建议

如果你只是想知道当前阈值，应读取：

```solidity
uint256 threshold = liquidationRiskManager.getLiquidationThreshold();
```

如果你想判断用户是否可清算，应优先读取：

```solidity
bool liquidatable = liquidationRiskManager.isLiquidatable(user);
```

如果你还需要知道缓存是否有效，应该再读取：

```solidity
(uint256 healthFactor, bool isValid, uint256 blockNumber) =
    healthView.getUserHealthFactorWithMeta(user);
```

不要把 `isLiquidatable(user) == false` 简单解释成“仓位健康”，因为还有一种情况是 `HealthView` 缓存无效。

## 示例

例如：

- collateral value = 100
- debt value = 95
- health factor = `100 * 10000 / 95 = 10526`
- 默认 liquidation threshold = `10500`

此时不会进入清算，因为 `10526 >= 10500`。

如果 collateral value 下跌到 90，则：

- health factor = `90 * 10000 / 95 = 9473`（整数截断下约等于 94.73%）
- `9473 < 10500`

这时才满足 liquidation threshold 条件。

## 当前实现的边界

本文只说明“阈值从哪里来、怎么读、怎么更新、如何参与判断”。以下内容不在本文定义范围内：

1. liquidation 由哪个入口执行。
2. collateral 如何选择和扣押。
3. payout recipient 如何分账。
4. Reward penalty 是否触发。

这些问题分别属于 SettlementManager、BlocksOnlyCoordinator、LiquidationManager、LiquidationPayoutManager 和 Reward 文档的范围。

## 集成注意事项

1. 不要直接把 `LiquidationTypes.DEFAULT_LIQUIDATION_THRESHOLD` 当成链上实时值。
2. 运行中的实际阈值应通过 `LiquidationRiskManager.getLiquidationThreshold()` 获取。
3. 对“不可清算”的解释必须结合 `HealthView` 缓存有效性。
4. 如部署已启用 `KEY_LIQUIDATION_CONFIG_MANAGER`，应把 ConfigModule 视为参数承载 SSOT，RiskManager 视为读取与兼容更新入口。
- **个人用户**: 建议设置较高阈值，风险控制更严格

### **4. 监控指标**
- **清算频率**: 监控清算触发频率
- **用户反馈**: 关注用户对清算时机的反馈
- **市场表现**: 跟踪抵押物价格波动情况

## 📚 **相关文档**

- [清算机制与调用链（概要）](./Liquidation-Mechanism-Logic.md)
- [完整清算逻辑（端到端口径）](./liquidation-complete-logic.md)
- [清算积分惩罚/奖励（可选扩展）](./liquidation-reward-penalty.md)
- [清算残值分配收款地址指南](./Liquidation-Payout-Address-Guide.md)
- [清算收款地址与白名单方案（计划稿）](./Liquidation-Recipient-Whitelist-Plan.md)

## 🤝 **技术支持**

如有关于清算阈值配置的问题，请联系：
- **技术团队**: tech@example.com
- **文档更新**: 2024年12月
- **版本**: v1.0.0

---

**注意**: 清算阈值的调整直接影响平台的风险控制策略，请在充分评估市场环境和用户反馈的基础上进行谨慎调整。 
## 前端配置规范（moduleKeys 与合约地址 + 资产配置）

目的
- 统一前端对模块键与合约地址的载入方式；
- 明确移除 `KEY_HF_CALC`，改用 `KEY_HEALTH_VIEW` 与 `KEY_LIQUIDATION_RISK_MANAGER`；
- 增加资产字段 `oraclePriced: boolean` 控制是否触发健康检查相关流程。

模块键（必须存在）
- KEY_HEALTH_VIEW：HealthView 合约
- KEY_LIQUIDATION_RISK_MANAGER：清算风险管理器（提供 `getMinHealthFactor`）
- KEY_RISK_VIEW（可选，轻量视图）

合约地址配置示例
```ts
// frontend-config/moduleKeys.ts（自动生成或手工维护）
export const ModuleKeys = {
  KEY_HEALTH_VIEW: '0x…',
  KEY_LIQUIDATION_RISK_MANAGER: '0x…',
  KEY_RISK_VIEW: '0x…',
  // … 其他已存在键
};

// frontend-config/contracts-localhost-*.ts
export const contracts = {
  healthView: '0x…',
  liquidationRiskManager: '0x…',
  riskView: '0x…',
  // … 其他模块
};
```

资产配置示例
```ts
// frontend-config/assets.ts
export type AssetMeta = {
  address: string;
  symbol: string;
  decimals: number;
  coingeckoId?: string;
  oraclePriced: boolean; // 仅为 true 的资产触发健康检查/清算风险展示
};

export const assets: Record<string, AssetMeta> = {
  USDC: { address: '0x…', symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', oraclePriced: true },
  RWA1: { address: '0x…', symbol: 'RWA1', decimals: 18, oraclePriced: false },
};
```

迁移注意
- 移除：任何 `KEY_HF_CALC` 与 `IHealthFactorCalculator` 的解析和调用；
- 新增：HealthView 与 LiquidationRiskManager 的读取；
- UI：仅当 `oraclePriced` 为 true 时加载/展示“健康与风险”相关组件与流程。



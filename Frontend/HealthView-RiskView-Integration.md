## HealthView 与 RiskView 集成指南（前端）

目标
- 以 HealthView 为唯一“健康因子/风险状态”缓存接入点。
- 以 LiquidationRiskManager 提供的阈值 minHFBps 为风险判断依据。
- 仅在 oraclePriced 资产场景触发健康检查流程；否则跳过以节省调用与渲染。

核心概念
- 单位统一为 bps（basis points，万分位，10000=100%）。
- 健康因子 hfBps 与最小健康因子 minHFBps 比较：hfBps < minHFBps → 风险（可清算）。
- HealthView 仅缓存与展示，不负责计算；计算在后端/合约完成并推送。

链上接口（读）
- HealthView
  - getUserHealthFactor(address user) → (uint256 healthFactorBps, bool isValid)
  - batchGetHealthFactors(address[] users) → (uint256[] healthFactorsBps, bool[] validFlags)
- LiquidationRiskManager
  - getMinHealthFactor() → uint256 minHFBps

链上接口（事件/数据流）
- DataPushed
  - RISK_STATUS_UPDATE: abi.encode(user, hfBps, minHFBps, undercollateralized, timestamp)
  - RISK_STATUS_UPDATE_BATCH: abi.encode(users[], hfsBps[], minsBps[], unders[], timestamp)

集成流程
1) 前端启动时加载 moduleKeys 与合约地址（需包含 KEY_HEALTH_VIEW、KEY_LIQUIDATION_RISK_MANAGER）。
2) 页面渲染：
   - 读取 assets 配置中的 oraclePriced 标记；仅为 true 的资产/产品显示健康相关组件。
   - 通过 HealthView/ILiquidationRiskManager 获取 hfBps/minHFBps 并展示。
3) 用户操作（借款/提取等）后：
   - 优先订阅 DataPushed 捕获 RISK_STATUS_UPDATE(_BATCH)，更新 UI。
   - 若无事件（或网络异常），在短时间内轮询 HealthView 兜底。

错误/降级处理
- isValid=false：显示“缓存更新中/已过期”，触发短期限次轮询。
- 无预言机（或 oraclePriced=false）：隐藏风险组件，或显示“无需预言机估值”的静态提示。

示例（ethers v6 获取与比较）
```ts
const [hfBps, valid] = await healthView.getUserHealthFactor(user);
const minHFBps = await lrm.getMinHealthFactor();
const under = hfBps < minHFBps;
```

展示建议
- 将 bps 转成百分比显示（保留两位小数）。
- 同时展示阈值与当前值，增加“风险徽标/颜色等级”。



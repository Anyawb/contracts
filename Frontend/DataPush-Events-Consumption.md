## DataPush 事件订阅与消费（前端）

目标
- 统一从 DataPushed 事件订阅健康/风险变更，减少主动轮询。
- 支持单条与批量负载，UI 做增量更新。

事件类型（dataTypeHash）
- HEALTH_FACTOR_UPDATE
- RISK_STATUS_UPDATE
- RISK_STATUS_UPDATE_BATCH
-（可选）MODULE_HEALTH_UPDATE
 - LIQUIDATION_UPDATE
 - LIQUIDATION_BATCH_UPDATE
  - REWARD_EARNED
  - REWARD_BURNED
  - REWARD_LEVEL_UPDATED
  - REWARD_PRIVILEGE_UPDATED
  - REWARD_STATS_UPDATED

订阅策略
- 用户操作后的 1-2 个新区块内高频监听，之后降频或停止。
- 发生网络/节点异常时回退到 HealthView 轮询（10~15 秒，页面可见时）。

解码示例（ethers v6）
```ts
const ABI = ethers.AbiCoder.defaultAbiCoder();
const TYPES = {
  HEALTH_FACTOR_UPDATE: ethers.id('HEALTH_FACTOR_UPDATE'),
  RISK_STATUS_UPDATE: ethers.id('RISK_STATUS_UPDATE'),
  RISK_STATUS_UPDATE_BATCH: ethers.id('RISK_STATUS_UPDATE_BATCH'),
  LIQUIDATION_UPDATE: ethers.id('LIQUIDATION_UPDATE'),
  LIQUIDATION_BATCH_UPDATE: ethers.id('LIQUIDATION_BATCH_UPDATE'),
  REWARD_EARNED: ethers.id('REWARD_EARNED'),
  REWARD_BURNED: ethers.id('REWARD_BURNED'),
  REWARD_LEVEL_UPDATED: ethers.id('REWARD_LEVEL_UPDATED'),
  REWARD_PRIVILEGE_UPDATED: ethers.id('REWARD_PRIVILEGE_UPDATED'),
  REWARD_STATS_UPDATED: ethers.id('REWARD_STATS_UPDATED'),
};

dataPush.on('DataPushed', (hash: string, payload: string) => {
  if (hash === TYPES.RISK_STATUS_UPDATE) {
    const [user, hfBps, minHFBps, under, ts] = ABI.decode(
      ['address','uint256','uint256','bool','uint256'],
      payload
    );
    // 更新 store（单用户）
  }
  if (hash === TYPES.RISK_STATUS_UPDATE_BATCH) {
    const [users, hfs, mins, unders, ts] = ABI.decode(
      ['address[]','uint256[]','uint256[]','bool[]','uint256'],
      payload
    );
    // 批量更新 store
  }
  if (hash === TYPES.LIQUIDATION_UPDATE) {
    const [user, collateralAsset, debtAsset, collateralAmount, debtAmount, liquidator, bonus, ts] = ABI.decode(
      ['address','address','address','uint256','uint256','address','uint256','uint256'],
      payload
    );
    // upsert 清算明细表 & 资产日统计（链下聚合）
  }
  if (hash === TYPES.LIQUIDATION_BATCH_UPDATE) {
    const [users, collateralAssets, debtAssets, collateralAmounts, debtAmounts, liquidator, bonuses, ts] = ABI.decode(
      ['address[]','address[]','address[]','uint256[]','uint256[]','address','uint256[]','uint256'],
      payload
    );
    // 批量 upsert 清算明细表 & 资产/系统日统计（链下聚合）
  }

  // === RewardView 统一推送（由 RewardManagerCore / RewardCore 成功后触发） ===
  if (hash === TYPES.REWARD_EARNED) {
    const [user, amount, reason, ts] = ABI.decode(['address','uint256','string','uint256'], payload);
    // 前端：更新用户奖励视图 & 最近活动
  }
  if (hash === TYPES.REWARD_BURNED) {
    const [user, amount, reason, ts] = ABI.decode(['address','uint256','string','uint256'], payload);
    // 前端：更新用户扣减记录
  }
  if (hash === TYPES.REWARD_LEVEL_UPDATED) {
    const [user, newLevel, ts] = ABI.decode(['address','uint8','uint256'], payload);
    // 前端：徽章/权益刷新
  }
  if (hash === TYPES.REWARD_PRIVILEGE_UPDATED) {
    const [user, privilegePacked, ts] = ABI.decode(['address','uint256','uint256'], payload);
    // 前端：位图解码后刷新功能开关
  }
  if (hash === TYPES.REWARD_STATS_UPDATED) {
    // 可复用承载：系统统计/惩罚账本变更（参考合约注释）
    // 根据链下 schema 区分具体 payload 解码
  }
});
```

UI 更新建议
- 单条：直接更新用户详情与对应列表项。
- 批量：将数组展开后按用户维度合并到内存 store，再统一触发渲染。

资产/期间统计（链下聚合，供前端展示）
- 表 `liquidations`：明细。
- 表 `liquidations_agg_asset_daily(asset, date, liquidation_count, total_seized_value, last_liquidation_time)`。
- 表 `liquidations_agg_system_daily(date, liquidation_count, total_seized_value, active_liquidators)`。
- 表 `liquidations_agg_user_period(user, period_start, period_end, liquidation_count, total_seized_value)`。



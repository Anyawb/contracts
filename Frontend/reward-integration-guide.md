## Reward 前端集成指南（落账后触发 + 统一 DataPush）

### 架构要点
- 唯一路径：LendingEngine 落账成功 → RewardManager.onLoanEvent(user, amount, duration, hfHighEnough) → RewardManagerCore 计算/发放/扣减 → RewardView.push* → DataPush。
- View 只读：前端仅调用 RewardView 读接口；链下仅订阅统一 DataPush。

### 模块键（前端键位）
- `rewardView` → Registry: `KEY_REWARD_VIEW`（合约内部常量）

### 只读接口（0 gas）
- `getUserRewardSummary(address user)` → { totalEarned, totalBurned, pendingPenalty, level, privilegesPacked, lastActivity, totalLoans, totalVolume }
- `getUserRecentActivities(address user, uint256 fromTs, uint256 toTs, uint256 limit)` → Activity[]（逆序，最多扫描 500 条）
- `getSystemRewardStats()` → { totalBatchOps, totalCachedRewards, activeUsers }
- `getTopEarners()` → { addrs[10], amounts[10] }

### DataPush 类型（订阅 `DataPushed`）
- `REWARD_EARNED`（user, amount, reason, ts）
- `REWARD_BURNED`（user, amount, reason, ts）
- `REWARD_LEVEL_UPDATED`（user, level, ts）
- `REWARD_PRIVILEGE_UPDATED`（user, privilegePacked, ts）
- `REWARD_STATS_UPDATED`（totalBatchOps, totalCachedRewards, ts）

### 推荐前端用法
1. 合约地址解析：从 Registry 解析 `rewardView`（或从部署产物配置读取）。
2. 列表页：调用 `getTopEarners()` + `getSystemRewardStats()`；
3. 个人页：调用 `getUserRewardSummary(user)` + `getUserRecentActivities(user, last7d, now, limit)`；
4. 订阅链下索引：仅消费上述 5 类 `DataPushed`，避免消费旧的业务事件。

### 兼容性说明
- 旧入口 `onLoanEvent(address,int256,int256)` 仍存在，但仅白名单可调用且来自 VBL 不发放；请勿使用。
- 所有发放以落账后触发为准。



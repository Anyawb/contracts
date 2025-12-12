## Reward 模块执行计划（与双架构完全对齐）

### 1. 目标与范围
- 对齐架构：业务层编排 → 账本落账（LE）→ 奖励计算/发放（RM/Core）→ 只读视图与 DataPush（RewardView）。
- 关键目标：
  - 以“落账后触发”为准，杜绝未落账先发积分；
  - 收紧触发入口权限与调用者校验；
  - 新增 `RewardView` 汇聚只读数据与统一 DataPush；
  - 私有存储 + 显式 getter，命名/事件/错误统一遵循 §3.3；
  - 保持向后兼容与最小可行改动，平滑过渡测试与脚本。

### 2. 触发链路与入口
- 主链路：`VaultBusinessLogic` 完成编排 → `LendingEngine` 成功落账 → `RewardManager.onLoanEvent(user, amount, duration, hfHighEnough)` → `RewardManagerCore` 计算/惩罚/发放 → `RewardView` push 只读数据 + `DataPushLibrary` 统一事件。
- 入口策略：
  - 保留 `VaultBusinessLogic` 的通知调用，但在 `RewardManager` 中强校验：仅白名单（`KEY_LE`、`KEY_VAULT_BUSINESS_LOGIC`）可调用；当来源为 `KEY_VAULT_BUSINESS_LOGIC` 时不发放积分，直接返回；真正发放仅接受 `KEY_LE` 成功路径调用。

### 3. 访问控制与安全
- 收紧/重构 `onLoanEvent(address,int256,int256)`：
  - 仅允许 `KEY_LE` 或 `KEY_VAULT_BUSINESS_LOGIC` 调用；
  - 当 `msg.sender == KEY_VAULT_BUSINESS_LOGIC`：不再发放积分（避免未落账先发），直接返回；
  - 当 `msg.sender == KEY_LE`：走 `onLoanEvent(address,uint256,uint256,bool)` 标准路径（后续由 LE 直接调用）；
- `RewardPoints` 的 `MINTER_ROLE`、`BURNER_ROLE` 仅授予 `RewardManagerCore`；
- 惩罚/消费路径仅允许 `KEY_GUARANTEE_FUND`（或定义的消费模块）与 `RewardManager` 转发。

### 4. 新增 RewardView（只读 + 统一 DataPush）
- 新增常量：`KEY_REWARD_VIEW`（在 `ModuleKeys` 中注册）。
- 写入入口（仅模块可写，白名单：`onlyRewardManagerCore`、`onlyRewardConsumption`）：
  - `pushRewardEarned(user, amount, reason, ts)`
  - `pushPointsBurned(user, amount, reason, ts)`
  - `pushPenaltyLedger(user, pendingDebt, ts)`
  - `pushUserLevel(user, newLevel, ts)`
  - `pushUserPrivilege(user, privilegePacked, ts)`
  - `pushSystemStats(totalBatchOps, totalCachedRewards, ts)`
- 视图查询（0 gas）：
  - `getUserRewardSummary(user)` → `totalEarned、totalBurned、pendingPenalty、level、privileges、lastActivity、totalLoans、totalVolume`
  - `getUserRecentActivities(user, fromTs, toTs, limit)`（可选）
  - `getSystemRewardStats()` → `totalBatchOps、totalCachedRewards、activeUsers、topEarners`（先落必要字段，扩展留钩子）
- DataPush 统一事件（在 push* 内部触发）：
  - `DATA_TYPE_REWARD_EARNED`
  - `DATA_TYPE_REWARD_BURNED`
  - `DATA_TYPE_REWARD_LEVEL_UPDATED`
  - `DATA_TYPE_REWARD_PRIVILEGE_UPDATED`
  - `DATA_TYPE_REWARD_STATS_UPDATED`

### 5. 命名与可见性（§3.3）
- 存储全部改为 `private _camelCase`，公开 getter；
- 事件使用过去时；错误以 `__` 前缀；常量 `UPPER_SNAKE_CASE`；
- 文件/函数命名遵循 3.3；TS/测试遵循 `docs/test-file-standards.md`。

### 6. 最小改动包与顺序
1) 访问控制修复（本次提交）：
   - 收紧 `RewardManager.onLoanEvent(address,int256,int256)` 调用者：仅 `KEY_LE`、`KEY_VAULT_BUSINESS_LOGIC`；
   - 当来源为 `VBL` 时直接返回，不发放积分；保持 VBL 旧调用兼容而不再产生奖励；
2) 新增 `KEY_REWARD_VIEW` 与 `RewardView` 骨架；
   - 在 `RewardManagerCore`、`RewardConsumption` 成功路径中调用 `RewardView.push*`；
   - `RewardView.push*` 内统一 `DataPushLibrary._emitData(...)`；
3) 命名与可见性统一（分批文件，先 RewardManager/RewardManagerCore）；
4) 将 LE 成功路径补充为正式触发源（borrow/repay 成功后调用 `onLoanEvent(address,uint256,uint256,bool)`）；

### 7. 迁移与兼容
- 旧的 VBL 通知仍执行，但不会发放积分（避免副作用变化前出现重入/顺序问题）；
- 新增 `KEY_REWARD_VIEW` 后需：
  - 更新 Registry 部署脚本与前端 `frontend-config/moduleKeys.ts`；
  - 将 `RewardView` 地址注册到 Registry；
  - 为 `RewardManagerCore/RewardConsumption` 配置写入权限；

### 8. 测试计划（TS + Hardhat + Ethers v6）
- 单元：
  - 权限控制：`onLoanEvent(int256,int256)` 仅白名单可调用；`VBL` 调用不发积分；`LE` 调用正常发放；
  - `RewardView.push*` 权限与 DataPush 事件断言；
- 集成：
  - 借款/还款成功 → LE 触发 → RM 发放 → RewardView 记录/推送；
  - 惩罚路径：扣分不足 → `penaltyLedger` 累积 → 下次奖励优先抵扣；
- 安全：
  - 未授权来源调用 RM/RV 失败；
  - 升级授权与 Registry 解析稳定性；

### 9. 回滚策略
- 访问控制收紧为纯合约内改动，可通过升级回滚到上一个实现；
- `RewardView` 为新增模块，不影响现有路径，出现故障可从 Registry 下线，核心发放不受影响。

### 10. 里程碑
- M1：访问控制修复 + 架构计划文件（本提交）
- M2：`RewardView` 骨架 + `DataPushTypes` 扩展 + 集成 Core/Consumption push
- M3：LE 成功路径触发 + 端到端测试绿灯



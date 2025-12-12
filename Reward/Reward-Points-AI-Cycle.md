# 🎯 积分循环（Reward Points Cycle）设计与实现方案

## 1. 目标与范围
- **目标**: 建立“借贷成功发积分 → 使用 AI 查询/分析扣积分 → 继续借贷再得积分”的良性循环；每次 AI 使用固定消耗 5 积分。
- **范围**: 后端合约与前端交互链路，覆盖事件记录、权限控制、账号隔离、费用配置与升级兼容。
- **不做**: 本阶段不新增独立模块，优先融入现有 `RewardConsumption/RewardCore/RewardPoints` 体系。

## 2. 架构概览（与 Registry/前端隔离系统对齐）
```mermaid
graph LR
  subgraph Frontend [Frontend]
    UI[用户独立 AI 通道 UI]\n(基于账户隔离)
    Agent[多 Agent 分析层]
  end

  subgraph Contracts [On-chain]
    LE[LendingEngine]
    RMCore[RewardManagerCore]\n(放贷事件→积分发放)
    RCons[RewardConsumption]\n(统一消费入口)
    RCore[RewardCore]\n(扣分/特权/记录)
    RPT[RewardPoints]\n(ERC20 + Mint/Burn)
  end

  UI -->|调用前校验余额| Agent
  Agent -->|触发消费: 5 分/次| RCons
  RCons --> RCore -->|burn 5| RPT
  LE --> RMCore -->|mint X| RPT

  subgraph Registry
    REG[Registry]
  end
  RCons -.查询模块地址.-> REG
  RCore  -.查询模块地址.-> REG
  RMCore -.查询模块地址.-> REG
```

- **事件/动作标准化**: 复用 `ActionKeys.ACTION_CLAIM_REWARD`（发积分）、`ActionKeys.ACTION_CONSUME_POINTS`（扣积分）。
- **模块注册**: 复用 `ModuleKeys.KEY_REWARD_POINTS / KEY_RM / KEY_REWARD_CONSUMPTION / KEY_REWARD_VIEW`。
- **数据推送**: 复用 RewardView 最小写入接口（best-effort）。

## 3. 业务规则
- **AI 使用费用**: 固定 5 积分/次（代币精度 18，记作 `5e18`）。
- **发放时机**: 借贷成功（参考 `RewardManagerCore.onLoanEvent/onBatchLoanEvents`）触发积分计算与铸造。
- **扣除时机**: 前端每次调用 AI 通道前，先执行链上扣分；扣分成功后再调 AI；失败则中止。
- **余额不足**: 扣分路径直接 revert（不进入欠分账本，欠分仅保留用于清算惩罚路径）。
- **账号隔离**: 前端仅对当前 `JWT`/钱包地址本人发起扣分；合约以 `msg.sender` 为准。
- **可配置性**: AI 费用在合约中以常量/参数呈现；后续如需动态配置可迁移至配置模块。

## 4. 合约改动最小化方案（推荐）
- **原则**: 新能力融入现有模块，避免创建新模块；保持 Registry/ActionKeys 兼容；不改变已有接口签名。
- **改动点**:
  - 在 `RewardCore` 增加一个轻量入口：`consumeAiQuery()`（固定扣除 5 分），内部调用 `RewardPoints.burnPoints(msg.sender, AI_USE_COST)` 并记录事件/推送视图。
  - 在 `RewardConsumption` 暴露同名透传入口 `consumeAiQuery()`（对外唯一入口，保持一致的权限与 UUPS 升级治理）。
  - 在 `RewardPoints` 保持 `mintPoints/burnPoints` 语义不变，仅通过事件 `PointsMinted/PointsBurned` 体现闭环（无需新增存储/公共状态）。

- **为何不直接在 `RewardPoints` 新增 `burnAiUsage`**:
  - Pros: 变更最小。
  - Cons: 把业务语义下沉到 Token 层，弱化模块分层，后续治理/计费/统计难以扩展。
  - 结论: 仍然通过 `RewardConsumption/RewardCore` 统一消费，`RewardPoints` 只负责记账与事件。

## 5. 事件与可观测性
- 发放：`RewardPoints.PointsMinted(to, amount)` + `VaultTypes.ActionExecuted(ACTION_CLAIM_REWARD, ...)` + `RewardView.pushRewardEarned(...)`。
- 扣除：`RewardPoints.PointsBurned(from, amount)` + `VaultTypes.ActionExecuted(ACTION_CONSUME_POINTS, ...)` + `RewardView.pushPointsBurned(...)`。
- 统计：沿用 `RewardCore` 中的服务使用计数与系统统计（必要时新增 AI 使用计数器）。

## 6. 前端调用流程（与用户隔离一致）
1. 用户连接钱包并完成 `JWT`/会话初始化（参考 `docs/Frontend/user-account-isolation-system.md`）。
2. 用户点击“智能查询”，前端先发起链上扣分：
   - `RewardConsumption.consumeAiQuery()`（交易，扣除 1 分）
   - 成功后调用 `AI Agent` 完成链下分析（参考 `docs/Frontend/view-contract-ai-integration.md`）。
3. 若交易失败（余额不足/权限不足/合约暂停），前端展示错误与引导（去借贷赚积分）。
4. 生成报告并展示（AI 分析 + 链上数据）。

伪代码（ethers v6）：
```ts
const AI_USE_COST = ethers.parseUnits('5', 18);
const tx = await rewardConsumption.consumeAiQuery({ gasLimit: 200_000 });
await tx.wait();
// 然后再调用 AI Agent
```

## 7. 权限与安全
- 合约函数 `consumeAiQuery` 标记 `nonReentrant`，仅依赖 `msg.sender` 自扣，避免越权为他人扣分。
- `RewardPoints.burnPoints` 现有权限为 `onlyRole(MINTER_ROLE)`；部署需确保 `RewardCore`（或发起扣分的模块）具备该角色（项目已如此设计，用于清算惩罚扣分）。
- 可选速率限制：如需防刷，可在 `RewardCore` 为 AI 消费路径加入轻量级 `cooldown`（如 2-5 秒/次），默认关闭。
- 暂停联动：若系统暂停或 Reward 模块暂停，扣分入口自动不可用。

## 8. 参数与常量
- `AI_USE_COST = 5e18`（精度 18）。
- 未来如需动态调整：后续可把该成本下放到 `AdvancedAnalyticsConfig`（新增 `microPrice` 字段）并由 `RewardCore` 读取。

## 9. 升级与兼容
- 不新增 `ActionKeys/ModuleKeys`，与旧版保持兼容。
- 通过 `UUPSUpgradeable` 方式升级 `RewardConsumption/RewardCore`，`RewardPoints` 无需升级即可生效。
- 事件与 ABI 向后兼容；前端仅新增一次交易调用即可。

## 10. 方案对比
- 方案 A（推荐）: `RewardConsumption/RewardCore` 增加 `consumeAiQuery()` 固定 5 分。
  - 优点: 架构清晰、权限统一、统计完备、前后端改动小。
  - 缺点: 需发布一次 Reward 模块升级。
- 方案 B: 在 `RewardPoints` 新增 `burnAiUsage(from)` 直接扣分。
  - 优点: 代码改动最小。
  - 缺点: 业务下沉 Token 层，不利于后续配置与审计。
- 方案 C: 在 `AdvancedAnalyticsConfig` 增加 `microPrice=5`，引入 `consumeMicro(ServiceType.AdvancedAnalytics)`。
  - 优点: 完全配置化。
  - 缺点: 增加类型/接口复杂度，超出本阶段“最小变更”。

## 11. 实施清单（确认后执行）
- 合约
  - 在 `contracts/Reward/RewardCore.sol` 增加 `function consumeAiQuery() external`（扣 5 分 → 事件 → RewardView 推送）。
  - 在 `contracts/Reward/RewardConsumption.sol` 增加透传 `function consumeAiQuery() external`。
  - 确认部署脚本为 `RewardCore` 保持 `MINTER_ROLE`（用于 `burnPoints`）。
- 前端
  - 在 AI 入口调用前插入一笔扣分交易；交易成功后再调用 AI Agent。
  - UI 里显示当前积分、每次消耗 5 分、失败提示与“去借贷赚积分”引导。
- 测试
  - 单测：余额足/不足、重入保护、暂停状态、事件校验、视图推送。
  - 集成：借贷→得分→AI 扣分→再次借贷得分的闭环验证。

---

如对上述文档与“推荐方案 A”无异议，我将按本说明实现合约与前端最小改动并提交对应测试用例与部署说明。

# RWA 借贷平台权限管理使用指南（现行版）

> 本文档已按双架构与撮合落地（settlement-flow）对齐，替换旧版指南的过时内容。

## 目录

1. 总体原则（双架构对齐）
2. ActionKeys 与模块边界
3. 借贷设置发起阶段的权限
4. 管理员与系统级权限
5. 只读/查看权限与数据访问
6. 最小授权清单（部署后立即执行）
7. 迁移指引（从旧版到现行）
8. 常见问题与排查

---

## 总体原则（双架构对齐）

- 入口极简：`VaultCore` 仅转发用户操作到 `VaultView`，不做复杂权限；敏感写入在业务/账本模块内做权限校验（参考 docs/Architecture-Guide.md）。
- 写入唯一：账本与订单写入统一由相应引擎处理（账本：`KEY_LE`；订单：`KEY_ORDER_ENGINE`）。
- 奖励唯一路径：仅在 `LendingEngine` 落账后，由其调用 `RewardManager.onLoanEvent(...)` 触发（仅允许 `KEY_LE` 调用）。
- 事件/DataPush 统一：写入后由模块推送标准事件，View 层做缓存，前端 0 gas 查询。

---

## ActionKeys 与模块边界

- 业务动作（节选）：
  - `ACTION_ORDER_CREATE` 订单创建专用鉴权（唯一执行权）
  - `ACTION_BORROW` 借款动作语义/事件标识与视图分发用（不再用于鉴权）
  - `ACTION_REPAY` 还款入口（订单引擎）
  - `ACTION_DEPOSIT` / `ACTION_WITHDRAW` 抵押/提取（由 CollateralManager 路径处理）
- 管理动作（节选）：
  - `ACTION_SET_PARAMETER` 配置参数
  - `ACTION_UPGRADE_MODULE` 模块升级
  - `ACTION_PAUSE_SYSTEM` / `ACTION_UNPAUSE_SYSTEM` 系统暂停/恢复
- 查看动作（节选）：
  - `ACTION_VIEW_USER_DATA` / `ACTION_VIEW_SYSTEM_DATA` / `ACTION_VIEW_RISK_DATA` 等

注：具体常量定义见 `contracts/constants/ActionKeys.sol`。

---

## 借贷设置发起阶段的权限（与统一入口对齐）

结合 docs/Frontend/settlement-flow.md 与现行合约（`contracts/core/LendingEngine.sol`）：

- 调用方（Initiator）
  - 必须持有 `ACTION_ORDER_CREATE`，才能调用 `LendingEngine.createLoanOrder(...)` 发起创建订单。
  - 授权仅授予撮合/编排入口（如 `VaultBusinessLogic` / 撮合路由），由其代用户发起，统一风控与审计。
  - 账本落账统一由 `VaultCore.borrowFor(...)` 触发，禁止业务层或 View 直接写 `KEY_LE.borrow(...)`。

- 借方（Borrower）前置约束（由订单引擎强校验）
  - 期限白名单：仅支持 5/10/15/30/60/90/180/360 天，否则回滚 `InvalidTerm`。
  - 长期限（≥90 天）需积分等级 ≥ 4（从 `RewardManager` 读取），否则回滚 `LevelTooLow`。
  - 借方地址需合法（非零地址，且订单字段完整）。

- 贷方（Lender）
  - 发起阶段无需额外 ACM 角色；只需合法参与订单字段（资产、金额等）。
  - 资金拨付由撮合流程在 `VaultBusinessLogic` 内原子完成（参见 settlement-flow）。

- 还款（供参考）
  - `LendingEngine.repay(...)` 需要调用方具备 `ACTION_REPAY`（订单引擎侧）。
  - 账本侧还款沿用统一入口：由 `VaultCore` 调 `ILendingEngineBasic.repay(...)`，不从业务层/View 直接写账本。

---

## 管理员与系统级权限

- 暂停/恢复：
  - `pause()` 需要 `ACTION_PAUSE_SYSTEM`
  - `unpause()` 需要 `ACTION_UNPAUSE_SYSTEM`
- 参数与升级：
  - `updateRegistry(...)`、`setRegistryDynamicModuleKey(...)` 需要 `ACTION_SET_PARAMETER`
  - UUPS 升级授权 `_authorizeUpgrade(...)` 需要 `ACTION_UPGRADE_MODULE`
- 建议将上述权限仅授予治理地址（多签/时间锁）。

---

## 只读/查看权限与数据访问

- 订单明细访问（`LendingEngine._canAccessLoanOrderForView` 逻辑）：
  - 借方或贷方可直接查看自己参与的订单（无需额外查看权限）。
  - 第三方查看需具备管理员权限（当前实现以 `ACTION_SET_PARAMETER` 判定）。
- View 层缓存：`AccessControlView` / `VaultView` 提供 `view` 查询（0 gas），并缓存权限位/级别与仓位数据，用于前端与监控。

---

## 最小授权清单（部署后立即执行）

> 以 Registry + ACM 模式为准；以下示例为思路，具体地址以实际部署为准。

```typescript
// 核心业务权限（撮合/编排入口）
await acm.grantRole(ActionKeys.ACTION_ORDER_CREATE, vblAddress); // 允许撮合入口创建订单（长期形态）
await acm.grantRole(ActionKeys.ACTION_REPAY,        vblAddress); // 允许撮合/运营入口代用户还款（可选）

// 管理权限（治理）
await acm.grantRole(ActionKeys.ACTION_SET_PARAMETER, governance);
await acm.grantRole(ActionKeys.ACTION_UPGRADE_MODULE, governance);
await acm.grantRole(ActionKeys.ACTION_PAUSE_SYSTEM,   governance);
await acm.grantRole(ActionKeys.ACTION_UNPAUSE_SYSTEM, governance);

// 查看权限（按需，若有系统级只读服务账号）
await acm.grantRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, sysViewer);
await acm.grantRole(ActionKeys.ACTION_VIEW_RISK_DATA,   riskBot);
```

---

## 迁移指引（从旧版到现行）

- 移除对“为合约设置 OWNER/ADMIN 等级”的依赖与教程示例；以“按动作 Key 授权”为主（`grantRole(ActionKeys.X, addr)`）。
- 将“直接由业务层触发奖励”的逻辑迁移为：仅 `LendingEngine` 落账后调用 `RewardManager.onLoanEvent(...)`。
- 查询路径统一改为通过 View 层（`VaultView` / `AccessControlView` 等）0 gas 查询，避免业务层重复事件与双写。
- settlement 流程中订单创建与账本写入，统一按 `docs/Frontend/settlement-flow.md` 的顺序执行。

---

## 常见问题与排查

- 无权限创建订单：
  - 症状：调用 `createLoanOrder` 回滚权限错误
  - 处理：确认撮合/编排入口是否具有 `ACTION_ORDER_CREATE`

- 长期限下单失败：
  - 症状：回滚 `LendingEngine__LevelTooLow`
  - 处理：检查借方积分等级，或降低期限至 < 90 天

- 无权限还款：
  - 症状：调用 `repay` 回滚权限错误
  - 处理：为运营/路由入口授予 `ACTION_REPAY`，或为需要直接还款的账户授予该权限

- 管理函数回滚：
  - 症状：`pause` / `unpause` / `updateRegistry` / 升级授权失败
  - 处理：确认治理地址已具备对应管理 ActionKey

---

以上内容已与当前架构和撮合流程对齐，可直接作为权限配置与审计检查清单使用。

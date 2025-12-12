# Reward 模块白名单（调用访问）说明

## 1. 适用范围
- 本说明覆盖 Reward 模块核心合约的“写入/触发”入口白名单与治理权限，包括：
  - `contracts/Reward/RewardManagerCore.sol`
  - `contracts/Reward/RewardManager.sol`
  - `contracts/Vault/view/modules/RewardView.sol`
  - `contracts/Reward/RewardCore.sol`、`contracts/Reward/RewardConsumption.sol`（与消费/视图写入相关）

## 2. 唯一路径与入口收紧（必须遵守）
- 唯一路径：`LendingEngine (KEY_LE)` 成功落账后 → `RewardManager.onLoanEvent(address,uint256,uint256,bool)` → `RewardManagerCore.onLoanEvent(...)`。
- `RewardManagerCore.onLoanEvent` 与 `onBatchLoanEvents` 不再接受外部直接调用：
  - 仅允许 `RewardManager (KEY_RM)` 调用；
  - 非白名单调用将触发事件 `DeprecatedDirectEntryAttempt(caller,timestamp)` 并以自定义错误 `RewardManagerCore__UseRewardManagerEntry` 直接回退；
- 旧入口 `RewardManager.onLoanEvent(address,int256,int256)`：仅允许 `KEY_LE` 或 `KEY_VAULT_BUSINESS_LOGIC` 调用；若来源为 `VBL`，直接返回不发放（用于兼容与平滑迁移）。

## 3. 写入白名单矩阵（简表）
- **RewardManagerCore（核心计算/发放）**：
  - `onLoanEvent` / `onBatchLoanEvents`：仅 `KEY_RM`。
  - `deductPoints`（惩罚扣减）：`KEY_GUARANTEE_FUND` 或 `KEY_RM`。
  - 参数/倍率更新（如 `updateRewardParameters`、`updateLevelMultiplier` 等）：仅 `KEY_RM` 作为写入代理，外部治理通过 `RewardManager` 受控调用。
  - 升级授权 `_authorizeUpgrade`：仅 `KEY_RM`。

- **RewardManager（统一入口/治理代理）**：
  - 旧入口 `onLoanEvent(int256,int256)`：`KEY_LE`、`KEY_VAULT_BUSINESS_LOGIC`；来自 `VBL` 不发放。
  - 标准入口 `onLoanEvent(uint256,uint256,bool)`：仅 `KEY_LE`。
  - 管理/参数变更：通过 ACM 校验 `ActionKeys.ACTION_SET_PARAMETER` 等权限后，转调 `RewardManagerCore`。
  - 升级授权 `_authorizeUpgrade`：ACM `ActionKeys.ACTION_UPGRADE_MODULE`。

- **RewardView（只读聚合 + 统一 DataPush）**：
  - 写入白名单（`onlyWriter`）：仅 `KEY_REWARD_MANAGER_CORE` 或 `KEY_REWARD_CONSUMPTION`。
  - `setRegistry`：ACM `ActionKeys.ACTION_SET_PARAMETER`。
  - `_authorizeUpgrade`：ACM `ActionKeys.ACTION_UPGRADE_MODULE`。

- **RewardCore/RewardConsumption（积分消费侧）**：
  - 对用户级消费写入由合约自身逻辑控制，视图写入通过 `RewardView.onlyWriter` 白名单受限；
  - 管理/参数变更与升级授权均通过 ACM 的 `ActionKeys` 权限校验。

## 4. 权限来源与解析
- 模块白名单依赖 Registry 的模块键解析：
  - `KEY_RM`、`KEY_REWARD_MANAGER_CORE`、`KEY_REWARD_CONSUMPTION`、`KEY_REWARD_VIEW`、`KEY_LE`、`KEY_VAULT_BUSINESS_LOGIC`、`KEY_GUARANTEE_FUND` 等。
  - 典型写法：`Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM)` → 与 `msg.sender` 比较。
- 治理/角色白名单依赖 ACM（`IAccessControlManager`）：
  - 典型写法：`IAccessControlManager(acm).requireRole(ActionKeys.ACTION_SET_PARAMETER, user)`。
  - 常用动作键：`ACTION_SET_PARAMETER`、`ACTION_UPGRADE_MODULE`、（视业务）`ACTION_CLAIM_REWARD`、`ACTION_LIQUIDATE` 等。

## 5. 关键代码位置（导航）
- RewardManagerCore：入口收紧与 DEPRECATED 引导
  - 文件：`contracts/Reward/RewardManagerCore.sol`
  - 函数：`onLoanEvent`、`onBatchLoanEvents`、事件 `DeprecatedDirectEntryAttempt`、错误 `RewardManagerCore__UseRewardManagerEntry`。
- RewardManager：旧/新入口调用白名单与治理代理
  - 文件：`contracts/Reward/RewardManager.sol`
  - 函数：`onLoanEvent(address,int256,int256)`（LE/VBL）；`onLoanEvent(address,uint256,uint256,bool)`（仅 LE）。
- RewardView：写入白名单
  - 文件：`contracts/Vault/view/modules/RewardView.sol`
  - 修饰符：`onlyWriter`（仅 RMCore/RewardConsumption）。

## 6. 迁移与兼容建议
- 任何直接调用 `RewardManagerCore.onLoanEvent` 的脚本与测试将失败：
  - 迁移到标准路径：`LendingEngine → RewardManager → RewardManagerCore`。
  - 订阅 `DeprecatedDirectEntryAttempt` 以发现遗留调用并清理。
- 事件订阅迁移：仅订阅 `DataPushed`（`DATA_TYPE_REWARD_*`），不再依赖旧式事件。

## 7. 测试要点（建议）
- 标准入口：`LE → RM → RMCore` 正常发放并在 `RewardView` 可读。
- 旧入口（int,int）：白名单内的 `VBL` 调用不发放；非白名单调用被拒绝。
- 直接调用 `RMCore.onLoanEvent`：应触发 `DeprecatedDirectEntryAttempt` 并 revert 自定义错误。
- `RewardView` 写入：仅 `RMCore`/`RewardConsumption` 成功；其他调用 revert。
- 惩罚路径：`applyPenalty` 由 `KEY_GUARANTEE_FUND` 触发扣减/欠分账本更新，并同步 `RewardView`。

## 8. 安全与审计要点
- 写入路径须满足：模块白名单（Registry 比较）或 ACM 动作权限（二者之一或组合）。
- 升级授权统一走 ACM `ACTION_UPGRADE_MODULE`。
- 入口收紧后，入口最小化，利于审计与日志一致性。

## 9. 常见问题（FAQ）
- Q：为何旧入口保留？
  - A：兼容历史脚本/VBL 调用，且来源为 VBL 时不发放，确保“落账后触发”。
- Q：如何判断是否命中白名单？
  - A：在相关函数内通过 Registry 解析模块地址，与 `msg.sender` 比较；或通过 ACM `requireRole` 校验 `ActionKeys`。
- Q：如何新增写入方？
  - A：需在合约中显式扩展白名单逻辑（如 `onlyWriter` 中增加模块键判断），并更新 Registry/ACM 配置，完成测试与审计。

---

本说明与 `docs/Architecture-Guide.md` 的“入口收紧”规范一致，作为 Reward 模块访问控制的实现性补充。

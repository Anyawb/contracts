# E2E 测试脚本说明

本目录包含完整的端到端（End-to-End）测试脚本，用于在本地 Hardhat 节点上验证业务逻辑和 View 层功能。

## 脚本列表

### 1. `e2e-localhost-run.ts`
**基础业务流测试**
- 测试简单的 deposit → borrow → repay 流程
- 验证核心业务逻辑（VaultCore, CollateralManager, VaultLendingEngine）
- **不包含 View 层验证**

### 2. `e2e-localhost-orderflow.ts`
**订单引擎流程测试**
- 测试订单创建和还款流程
- 验证 `core/LendingEngine`（ORDER_ENGINE）的 `createLoanOrder` 和 `repay` 功能
- 验证 LoanNFT 的铸造和状态更新
- **不包含 View 层验证**

### 3. `e2e-localhost-matchflow.ts`
**撮合/结算流程测试**
- 测试完整的撮合流程：`reserveForLending` → `finalizeMatch` → `repay`
- 验证 EIP-712 签名验证
- 验证 `VaultBusinessLogic` 的撮合编排功能
- 验证 LoanNFT 的铸造
- **不包含 View 层验证**

### 4. `e2e-localhost-full-with-views.ts` ⭐ **推荐**
**完整业务流 + View 层验证**
- 包含所有业务操作：deposit → borrow → repay → matchflow
- **在每个步骤后验证 View 层数据**：
  - `PositionView`: 用户持仓（抵押物和债务）
  - `HealthView`: 健康因子
  - `UserView`: 用户视图聚合
  - `RiskView`: 风险评估
  - `StatisticsView`: 全局统计数据
  - `DashboardView`: 前端友好的聚合视图
  - `RewardView`: 奖励查询
- 验证 View 层缓存是否正确更新
- 验证多个 View 模块的数据一致性

### 4.1 `e2e-localhost-reward-privacy.ts` ⭐
**Reward 隐私 + Read-Gate 专项验收**
- 覆盖场景：
  - **隐私读取**：RewardView 的用户数据仅允许 **本人** 或 **运营团队（VIEW_USER_DATA）** 读取
  - **协议内读取**：`RewardView.getUserLevelForBorrowCheck` 仅允许 `KEY_LE` 调用（用于 LendingEngine 链上校验）
  - **Read-Gate**：`RewardManagerCore.get*` 查询接口禁止 EOA 直连（必须通过 RewardView）
  - **积分语义**：按期还款 +1；提前还款 +0；逾期还款扣 5%（默认 `latePenaltyBps=500`）

### 5. `e2e-localhost-batch-10-users.ts`
**10 用户批量撮合借贷（5 组 borrower+lender）+ 总数验收**
- 使用 10 个 signer，每 2 个一组：borrower deposit 抵押、lender reserve 资金、deployer finalizeMatch
- 分两次做总数一致性验收：
  - **撮合完成后**：校验 `Ledger(sum)` 与 `StatisticsView(total)` 的 `totalCollateral/totalDebt` 等于期望值
  - **全部还清后**：校验 `totalDebt == 0`
- Phase3 可观测性：在关键 checkpoint 显式输出一个“样本 borrower”的：
  - `PositionView.getPositionVersion(user, asset)`（version）
  - `PositionView.getUserPosition(user, asset)`（col/debt，便于对照）
  - `PositionView.getVersionInfo()` / `StatisticsView.getVersionInfo()`（apiVersion/schemaVersion/implementation，用于升级后快速识别版本）
- ViewScan（新增）：启动阶段从 Registry 扫描全部 View 模块并调用 `getVersionInfo()` + 少量只读 sanity-call。
  - 默认 best-effort（只打印告警不失败）
  - 可选严格模式：`E2E_VIEW_STRICT=1`（任何 View 扫描失败将直接终止脚本）
- Reward（新增）：按 `Architecture-Guide.md` 的唯一路径（LE 落账后触发）对 **积分/RewardView** 做最小端到端断言：
  - 输出 **人类可读积分**（`RewardPoints.decimals()`）与 raw 值
  - 断言 repay 后 `RewardPoints.balanceOf` 与 `RewardView.getUserRewardSummary.totalEarned` 的 **delta == 1.0**
- “样本 borrower”可配置：
  - **env**：`E2E_SAMPLE_BORROWER_INDEX=0..4`（默认 0）
  - **task/argv**：`npx hardhat e2e:batch-10-users --sample-borrower-index 0..4`（task 定义在 `scripts/tasks/e2e-batch-10-users.ts`，并已在 `hardhat.config.ts` 引入）

### 6. `e2e-localhost-batch-advanced-10-users.ts` ⭐
**高级批量测试：部分还款 / 逾期还款 / 多 lender 拆单 + 每步 View 断言**
- 10 个 signer：5 个 borrower + 5 个 lender
- 覆盖场景：
  - **部分还款**：同一笔订单分两次 repay，并断言每次后 `PositionView/UserView` 与账本一致
  - **逾期还款**：`evm_increaseTime` 快进到超过到期日后再 repay
  - **多 lender 拆单**：将 500 拆成两笔 250/250（两笔订单），分别由不同 lender 出借（更贴近真实“拆单”）
- 每一步都断言：
  - `PositionView.getUserPosition` == `UserView.getUserPosition` == `CollateralManager/VaultLendingEngine`（账本）
  - `RiskView.getUserRiskAssessment` 可正常调用（不对语义做强约束）
- Phase3 可观测性：在关键 checkpoint 显式输出一个“样本 borrower”的 `PositionView` version（用于观察严格 `nextVersion` 的单调递增写入）
- 同时在启动阶段输出关键 View 的 `getVersionInfo()`（apiVersion/schemaVersion/implementation），便于定位升级影响
- ViewScan（新增）：同上（支持 `E2E_VIEW_STRICT=1`）
- Reward（新增）：同上
- “样本 borrower”可配置：
  - **env**：`E2E_SAMPLE_BORROWER_INDEX=0..4`（默认 0）
  - **task/argv**：`npx hardhat e2e:batch-advanced --sample-borrower-index 0..4`（task 定义在 `scripts/tasks/e2e-batch-advanced.ts`，并已在 `hardhat.config.ts` 引入）

## 运行方式

### 前置条件

1. **启动本地 Hardhat 节点**：
```bash
npm run node
```

2. **部署合约到本地节点**（在另一个终端）：
```bash
npm run deploy:localhost
```

### 运行测试脚本

#### 基础业务流测试
```bash
npx hardhat run scripts/e2e/e2e-localhost-run.ts --network localhost
```

#### 订单引擎流程测试
```bash
npx hardhat run scripts/e2e/e2e-localhost-orderflow.ts --network localhost
```

#### 撮合流程测试
```bash
npx hardhat run scripts/e2e/e2e-localhost-matchflow.ts --network localhost
```

#### 完整测试（推荐）⭐
```bash
npx hardhat run scripts/e2e/e2e-localhost-full-with-views.ts --network localhost
```

#### Reward 隐私 + Read-Gate 专项验收 ⭐
```bash
npx hardhat run scripts/e2e/e2e-localhost-reward-privacy.ts --network localhost
```

#### Reward Edge Cases（多订单/partial repay/提前-按期-逾期/penaltyLedger）⭐
```bash
npx hardhat e2e:reward-edgecases --network localhost
```

#### 10 用户批量撮合借贷（推荐用于压测/一致性验收）
```bash
npx hardhat run scripts/e2e/e2e-localhost-batch-10-users.ts --network localhost
```

##### 可配置：选择一个 “样本 borrower” 打印 PositionView.version（Phase3 可观测性）
- **env 方式（兼容旧用法）**：

```bash
E2E_SAMPLE_BORROWER_INDEX=2 npx hardhat run scripts/e2e/e2e-localhost-batch-10-users.ts --network localhost
```

- **argv/task 方式（推荐）**：

```bash
npx hardhat e2e:batch-10-users --network localhost --sample-borrower-index 2
```

#### 高级批量测试（部分还款/逾期/拆单 + 每步 View 断言）⭐
```bash
npx hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
```

##### 可配置：选择一个 “样本 borrower” 打印 PositionView.version / getPositionVersion（Phase3 可观测性）
- **env 方式（仍然支持）**：

```bash
E2E_SAMPLE_BORROWER_INDEX=2 npx hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
```

- **argv/task 方式（推荐）**：
  - task 定义在 `scripts/tasks/e2e-batch-advanced.ts`
  - 已在 `hardhat.config.ts` 引入（只要用 hardhat 运行即可生效）

```bash
npx hardhat e2e:batch-advanced --network localhost --sample-borrower-index 2
```

## 输出说明

### `e2e-localhost-full-with-views.ts` 输出示例

```
=== E2E Full Test with View Layer Verification ===

📋 View Modules:
  PositionView: 0x...
  HealthView: 0x...
  ...

=== Step 1: Borrower Deposits Collateral ===
✅ Deposit completed. Collateral: 1000.0

📊 View Layer Verification [After Deposit]:
  PositionView: collateral=1000.0, debt=0.0
  HealthView: healthFactor=0, isValid=false
  UserView: collateral=1000.0, debt=0.0
  RiskView: healthFactor=10000, riskLevel=N/A
  StatisticsView: totalUsers=0, totalCollateral=0.0, totalDebt=0.0
  DashboardView: totalCollateral=1000.0, totalDebt=0.0, healthFactor=0
  RewardView: totalEarned=0, level=0, totalLoans=0

...
```

## 验证内容

### 业务逻辑验证
- ✅ 抵押物存入和提取
- ✅ 直接借款和还款（通过 VaultCore）
- ✅ 撮合流程（资金保留 → 撮合落地 → 还款）
- ✅ LoanNFT 的铸造和状态更新
- ✅ 订单引擎的订单创建和还款

### View 层验证
- ✅ **PositionView**: 验证抵押物和债务数据是否正确缓存
- ✅ **HealthView**: 验证健康因子查询（注意：某些情况下可能需要推送更新）
- ✅ **UserView**: 验证用户视图聚合数据
- ✅ **RiskView**: 验证风险评估数据
- ✅ **StatisticsView**: 验证全局统计数据（注意：可能需要触发统计更新）
- ✅ **DashboardView**: 验证前端友好的聚合视图
- ✅ **RewardView**: 验证奖励数据查询

## 注意事项

1. **StatisticsView 的全局统计**：某些统计数据可能需要特定的触发条件才会更新，因此可能显示为 0。这是正常的。

2. **HealthView 的健康因子**：健康因子可能需要通过 `pushHealthFactor` 或 `pushRiskStatus` 推送更新。如果显示为 0 或 `isValid=false`，可能是缓存尚未更新。

3. **View 层缓存更新**：View 层的缓存更新是"尽力而为"的，如果缓存更新失败，不会影响主业务逻辑。脚本会捕获并显示这些错误。

4. **权限设置**：脚本会自动设置所需的权限，但确保部署脚本正确配置了所有模块的 Registry 绑定。

5. **资产白名单和价格**：脚本会自动将 USDC 添加到资产白名单并设置价格。

## 故障排查

### 问题：View 层查询返回错误
- 检查 View 模块是否正确部署并注册到 Registry
- 检查调用者是否有正确的权限（某些 View 查询需要特定角色）

### 问题：业务操作失败
- 检查权限是否正确授予
- 检查资产是否在白名单中
- 检查价格预言机是否已设置价格
- 检查用户余额是否充足

### 问题：撮合流程失败
- 检查 EIP-712 签名是否正确
- 检查资金是否已正确保留
- 检查意向是否过期或已匹配

## 扩展建议

1. **添加更多业务场景**：
   - 多资产操作
   - 清算流程
   - 早偿流程

2. **添加更多 View 层验证**：
   - 批量查询验证
   - 缓存失效验证
   - 数据一致性验证

3. **添加性能测试**：
   - Gas 消耗统计
   - 查询响应时间

4. **添加错误场景测试**：
   - 权限不足
   - 余额不足
   - 过期意向



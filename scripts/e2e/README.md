# E2E 测试脚本说明

本目录包含完整的端到端（End-to-End）测试脚本，用于在本地 Hardhat 节点上验证业务逻辑和 View 层功能。

## ✅ Strict 模式（默认开启）

从 2026-01 起，**推荐把 E2E 当作“部署前的最后一道闸”**：只要 View/Stats 与账本（SSOT）出现不一致，就应立即失败，避免把“推送链路未接好/权限缺失/缓存逻辑缺口”带到测试网或 Arbitrum 主网。

- **默认行为**：`strict=true`（即大多数 View/Stats 不一致会直接抛错退出，而不是仅打印 ⚠️）
- **关闭 strict**：显式设置 `E2E_STRICT_VIEWS=0`

> SSOT 不变：账本仍由 `CollateralManager` / `VaultLendingEngine`（以及 `SettlementManager` 的 repay/settle/liquidation 语义）作为最终真相。  
> strict 只是把“缓存/视图层是否正确跟随账本更新”变成 **可自动验收** 的硬指标。

### Strict 相关环境变量（统一约定）

- **`E2E_STRICT_VIEWS`**（默认开启）
  - `E2E_STRICT_VIEWS=0`：关闭严格校验（回退为 best-effort，允许打印 ⚠️ 继续跑）
  - 其它值/不设置：开启严格校验
- **`E2E_ALLOW_DIRTY_STATE=1`**（仅在需要时使用）
  - 允许在“非干净状态”（已有历史仓位/债务）下跑严格 E2E（更贴近 testnet/mainnet）
- **`E2E_VIEW_STRICT=1`**
  - 仅用于 **ViewScan**（启动阶段扫描所有 View 模块）强制失败策略；
  - 说明：部分脚本会把 ViewScan.strict 直接绑定到 `E2E_STRICT_VIEWS`（因此 `E2E_VIEW_STRICT` 只对未显式传 strict 的脚本生效）。

## 脚本列表

### 1. `e2e-localhost-run.ts`
**基础业务流测试**
- 测试简单的 deposit → borrow → repay 流程
- 验证核心业务逻辑（VaultCore, CollateralManager, VaultLendingEngine）
- 适合做 SSOT/资金链路 smoke test（**不做严格 View/Stats 断言**）

### 2. `e2e-localhost-orderflow.ts`
**订单引擎流程测试**
- 测试订单创建和还款流程
- 验证 `core/LendingEngine`（ORDER_ENGINE）的 `createLoanOrder` 和 `repay` 功能
- 验证 LoanNFT 的铸造和状态更新
- 适合做 ORDER_ENGINE/签名/LoanNFT 的 smoke test（**不做严格 View/Stats 断言**）

### 3. `e2e-localhost-matchflow.ts`
**撮合/结算流程测试**
- 测试完整的撮合流程：`reserveForLending` → `finalizeMatch` → `repay`
- 验证 EIP-712 签名验证
- 验证 `VaultBusinessLogic` 的撮合编排功能
- 验证 LoanNFT 的铸造
- 适合做 matchflow 的 smoke test（**不做严格 View/Stats 断言**）

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
- 每一步都断言（strict 模式下为硬失败）：
  - `PositionView.getUserPosition` == `UserView.getUserPosition` == `CollateralManager/VaultLendingEngine`（账本）
  - `RiskView.getUserRiskAssessment` 可正常调用（不对语义做强约束）
- Phase3 可观测性：在关键 checkpoint 显式输出一个“样本 borrower”的 `PositionView` version（用于观察严格 `nextVersion` 的单调递增写入）
- 同时在启动阶段输出关键 View 的 `getVersionInfo()`（apiVersion/schemaVersion/implementation），便于定位升级影响
- ViewScan（新增）：同上
  - 默认：随 strict 策略（本脚本中 strict 默认开启）
  - 关闭 strict：`E2E_STRICT_VIEWS=0`
- Reward（新增）：同上
- “样本 borrower”可配置：
  - **env**：`E2E_SAMPLE_BORROWER_INDEX=0..4`（默认 0）
  - **task/argv**：`npx hardhat e2e:batch-advanced --sample-borrower-index 0..4`（task 定义在 `scripts/tasks/e2e-batch-advanced.ts`，并已在 `hardhat.config.ts` 引入）

## 运行方式

### 快速命令参考（针对批量测试）

#### 完整流程（3 个终端窗口）

**终端 1：启动本地 Hardhat 节点**
```bash
pnpm -s run node
```
或者使用完整命令：
```bash
hardhat node --hostname 127.0.0.1 --port 8545
```

**终端 2：部署合约到本地节点**
```bash
pnpm -s run deploy:localhost
```
或者使用完整命令：
```bash
hardhat run scripts/deploy/deploylocal.ts --network localhost
```

**终端 3：运行 E2E 测试**

运行 `e2e-localhost-batch-10-users.ts`：
```bash
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-10-users.ts --network localhost
```

运行 `e2e-localhost-batch-advanced-10-users.ts`：
```bash
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
```

### 前置条件

1. **启动本地 Hardhat 节点**：
```bash
pnpm -s run node
```
或者使用完整命令：
```bash
hardhat node --hostname 127.0.0.1 --port 8545
```

2. **部署合约到本地节点**（在另一个终端）：
```bash
pnpm -s run deploy:localhost
```
或者使用完整命令：
```bash
hardhat run scripts/deploy/deploylocal.ts --network localhost
```

### 运行测试脚本

#### 基础业务流测试
```bash
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-run.ts --network localhost
```

#### 订单引擎流程测试
```bash
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-orderflow.ts --network localhost
```

#### 撮合流程测试
```bash
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-matchflow.ts --network localhost
```

#### 完整测试（推荐）⭐
```bash
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-full-with-views.ts --network localhost
```

#### Reward 隐私 + Read-Gate 专项验收 ⭐
```bash
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-reward-privacy.ts --network localhost
```

#### Reward Edge Cases（多订单/partial repay/提前-按期-逾期/penaltyLedger）⭐
```bash
npx hardhat e2e:reward-edgecases --network localhost
```

#### 10 用户批量撮合借贷（推荐用于压测/一致性验收）
```bash
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-10-users.ts --network localhost
```

##### 可配置：选择一个 “样本 borrower” 打印 PositionView.version（Phase3 可观测性）
- **env 方式（兼容旧用法）**：

```bash
E2E_SAMPLE_BORROWER_INDEX=2 pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-10-users.ts --network localhost
```

- **argv/task 方式（推荐）**：

```bash
pnpm -s exec hardhat e2e:batch-10-users --network localhost --sample-borrower-index 2
```

#### 高级批量测试（部分还款/逾期/拆单 + 每步 View 断言）⭐
```bash
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
```

##### Strict 模式相关（本脚本默认开启）

- **默认（推荐）**：严格校验（任何 View/Stats 与账本不一致会直接失败）

```bash
pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
```

- **关闭 strict（仅用于临时排障）**：

```bash
E2E_STRICT_VIEWS=0 pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
```

- **允许 dirty state（更贴近 testnet/mainnet）**：

```bash
E2E_ALLOW_DIRTY_STATE=1 pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
```

##### 可配置：选择一个 “样本 borrower” 打印 PositionView.version / getPositionVersion（Phase3 可观测性）
- **env 方式（仍然支持）**：

```bash
E2E_SAMPLE_BORROWER_INDEX=2 pnpm -s exec hardhat run scripts/e2e/e2e-localhost-batch-advanced-10-users.ts --network localhost
```

- **argv/task 方式（推荐）**：
  - task 定义在 `scripts/tasks/e2e-batch-advanced.ts`
  - 已在 `hardhat.config.ts` 引入（只要用 hardhat 运行即可生效）

```bash
pnpm -s exec hardhat e2e:batch-advanced --network localhost --sample-borrower-index 2
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

1. **StatisticsView 的全局统计（重要）**：在严格模式下，我们把 `StatisticsView.totalCollateral/totalDebt` 作为“推送链路是否正确”的硬指标。  
   - 如果在 E2E 中出现 `totalDebt/totalCollateral` 长期为 0 或与账本不一致，通常表示：Stats push 权限缺失 / push 路径未覆盖 / 逻辑被 try/catch 吞掉。

2. **缓存过期与 time travel**：`ViewConstants.CACHE_DURATION = 5 minutes`。如果脚本使用 `evm_increaseTime` 快进超过该阈值，PositionView 的缓存会变为 `isValid=false`。  
   - 严格模式下应确保 Stats/PositionView 的更新路径不会依赖“缓存是否仍然有效”（否则会出现“漏计/残留”的假阴性）。

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



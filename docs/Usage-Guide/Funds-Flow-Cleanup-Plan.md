# 资金链相关接口与库清理方案

## 目标

本方案基于 `docs/Usage-Guide/Funds-Flow-Architecture-Guide.md` 当前定义的资金链 SSOT，清理 `src/interfaces` 与 `src/libraries` 中不再符合现行架构、未被代码使用、或可通过迁移进一步收敛的内容。

本方案按三类执行：

- 直接删：仓库内无代码引用，且与当前资金链边界不再匹配。
- 迁移后删：内容仍有价值，但当前位置不合理，需先迁移到正式边界后删除原定义。
- 保留：虽然文件较薄，但属于当前资金链关键边界，不能删除。

## 直接删

### 第一批低风险接口

以下 6 个接口文件在仓库内仅有自身定义，无 Solidity/TS/JS 调用点，可先删除并做编译与测试验证：

1. `src/interfaces/IVaultModules.sol`
   - 仅为聚合 `IVaultCore + IVaultRouter + IVaultAdmin` 的便利接口。
   - 不参与当前资金链主路径。

2. `src/interfaces/ILiquidationOrchestrator.sol`
   - 表达的是更早期的一体化清算编排边界。
   - 当前清算 SSOT 已拆分为 `SettlementManager / LiquidationManager / LiquidationRiskManager / LiquidationCalculator`。

3. `src/interfaces/ILiquidationExecutor.sol`
   - 与当前 `ILiquidationManager` 的执行边界重复。

4. `src/interfaces/IKeeperRegistry.sol`
   - 与当前 keeper 角色控制路径无关。

5. `src/interfaces/ILoanFactory.sol`
   - 不在当前 `VaultBusinessLogic -> VaultCore.borrowFor -> OrderEngine.createLoanOrder` 主路径中。

6. `src/interfaces/IResidualAllocation.sol`
   - 已被 `LiquidationPayoutManager` 的残值分配 SSOT 替代。

### 第二批直接删除项

1. `src/libraries/GracefulDegradation.sol` 中的 `getAssetValueWithFallbackAndCache(...)`
   - 当前生产代码无调用点。
   - 会引入独立价格缓存语义，不符合当前 `PositionView / LoanFlow / Statistics` 的缓存 SSOT。

2. `src/libraries/GracefulDegradation.sol` 中的 `getAssetValueWithFallbackNew(...)`
   - 当前生产代码无调用点。
   - 对应的按调用上下文覆写配置模型不符合资金链统一估值口径。

3. 与上述新路径绑定但无外部消费者的结构体与辅助函数
   - `GlobalDegradationConfig`
   - `CallContextConfig`
   - `_applyFallbackStrategyNew(...)`
   - `mergeConfigs(...)`
   - `validateGlobalConfig(...)`
   - `validateCallContextConfig(...)`
   - `createDefaultGlobalConfig(...)`
   - `createDefaultCallContextConfig(...)`

## 迁移后删

### 从库内嵌最小接口迁移到正式接口目录

1. `src/libraries/VaultBusinessLogicLibrary.sol`
   - `IStatisticsViewMinimal`
   - `IStatisticsViewGuaranteeMinimal`
   - 处理方式：迁移到 `src/interfaces`，再删除库内定义。

2. `src/libraries/SettlementMatchLib.sol`
   - `IVaultCoreBorrowFor`
   - 处理方式：迁移到 `src/interfaces`，再删除库内定义。

## 保留

以下文件虽然较薄，但属于当前资金链关键边界，不建议删除：

1. `src/interfaces/IVaultCoreMinimal.sol`
   - 多个账本/费用模块依赖它解析 `VaultCore.viewContractAddrVar()`。

2. `src/interfaces/IVaultCoreDataPush.sol`
   - 用于把用户写入口与缓存推送入口解耦。

3. `src/interfaces/IOrderEngineViewAdapter.sol`
   - Settlement/View 层需要的最小只读边界。

4. `src/interfaces/IOrderEngineRepayAdapter.sol`
   - SettlementManager 的最小 repay 边界。

5. `src/interfaces/IPositionViewValuation.sol`
   - 清算、风控、统计只读估值依赖该边界。

6. `src/interfaces/IFeeRouterView.sol`
   - FeeRouter 到 FeeRouterView 的推送边界。

7. 当前仍在资金链主路径中的核心库
   - `SettlementIntentLib`
   - `SettlementReserveLib`
   - `SettlementMatchLib`
   - `VaultBusinessLogicLibrary`
   - `HealthFactorLib`
   - `TermBlocksLib`
   - `ViewAccessLib`
   - `AccessControlLibrary`
   - `ModuleAccessLibrary`
   - `DataPushLibrary`
   - `EventLibrary`
   - `ProxyIntrospectionLib`

## 待改名 / 待拆分清单（命名与职责收敛）

以下清单不是“立即大改名”，而是按风险分批，把调用方依赖先收窄，再决定是否做实现名与文件名收敛。

### A. 第一批低风险收敛（本轮开始执行）

1. `ILiquidationRiskManager.sol`
   - 问题：同一接口同时承载只读风险查询、纯计算、阈值读取、治理写入。
   - 收敛方向：先把读侧依赖收敛到独立窄接口 `ILiquidationRiskRead`；治理写入继续留在现有管理接口，后续再评估是否进一步迁移到 `ILiquidationConfigManager`。
   - 本轮动作：新增 `src/interfaces/ILiquidationRiskRead.sol`，并让只读消费者优先依赖该接口。
   - 首批迁移点：`SystemRiskView`、`LiquidationRiskView`、`SettlementManager`、`LendingEngineCore`。

2. `IFeeRouter.sol`
   - 问题：同一接口混合费用计算、费用分发、治理配置、统计/镜像相关能力，调用方普遍只用其中一小部分。
   - 收敛方向：先按动作裁剪出分发专用窄接口，再逐步把计费查询、治理配置、只读镜像分别收敛。
   - 本轮动作：新增 `src/interfaces/IFeeRouterDistribution.sol`，承接 `distributeNormal / distributeDynamic / distributePrepaid / batchDistribute`。
   - 首批迁移点：`SettlementMatchLib`、`LiquidationManager`、`GuaranteeFundManager`。

### B. 第二批候选（暂不在本轮实施）

1. `ILendingEngineBasic.sol`
   - 问题：`Basic` 后缀过于模糊，当前实际表达的是 debt-ledger 主边界，而非“基础版”能力。
   - 建议方向：收敛为更明确的 debt-ledger 命名，并拆成读/写最小接口族。
   - 当前进展：已新增 `ILendingEngineDebtRead` / `ILendingEngineDebtWrite`，并开始让生产调用方按读写依赖收窄；`ILendingEngineBasic` 暂保留为兼容聚合口。

2. `IPriceOracle.sol` / `IPriceOracleAdapter.sol` / `IRWAPriceOracle.sol`
   - 问题：权威源、外部适配层、领域化专用 oracle 的角色命名不够清晰。
   - 建议方向：按“权威源 / adapter / view facade”三层显式收敛，再处理 RWA 专用命名。
   - 当前进展：已新增 `IPriceOracleRead` / `IPriceOracleAdmin`、`IPriceOracleAdapterRead` / `IPriceOracleAdapterAdmin`、`IRWAAssetPriceRead` / `IRWAAssetPriceAdmin`；主要调用方已开始按读/管边界改依赖，旧接口暂保留为兼容聚合口。

3. `IWhitelistRegistry.sol` / `IAuthorityWhitelist.sol` / `IAssetWhitelist.sol`
   - 问题：同属 whitelist 家族，但“注册表”和“单点判定接口”的命名层级没有完全拉开。
   - 建议方向：统一为“主体白名单接口”与“集中注册表接口”两层命名体系。
   - 当前进展：`IAssetWhitelistRead` / `IAssetWhitelistAdmin`、`IAuthorityWhitelistRead` / `IAuthorityWhitelistAdmin` 已作为主体白名单的窄接口 SSOT；脚本层治理入口也已统一切换到读/管拆分口径，避免再直接依赖宽接口类名。
   - WhitelistRegistry 审查结论：仓库内当前只有 `IWhitelistRegistryRead.isWhitelisted(address)` 语义、接口聚合壳 `IWhitelistRegistry.sol` 与 `MockWhitelistRegistry`；`src/` 与 `scripts/` 都没有生产级写入口、治理脚本或 DataPush 消费路径，因此暂不新增 `IWhitelistRegistryAdmin`。在出现真实的链上治理写需求前，保持纯读注册表语义更清晰，也更符合当前架构事实。

4. `AccessControlLibrary.sol` / `ModuleAccessLibrary.sol` / `DataPushLibrary.sol`
   - 问题：名称容易让人误判为纯 helper，但实际带有审计事件、模块解析、统一发射边界等副作用。
   - 建议方向：优先补足 NatSpec 与标准文档；若未来继续扩职，再决定是否改名或拆库。

## 执行顺序

1. 先删除 6 个明显未使用的接口文件。
2. 运行 compile 与测试验证，确认低风险阶段稳定。
3. 清理 `GracefulDegradation` 中未落地的新/缓存分支。
4. 迁移库内嵌最小接口到 `src/interfaces`，并删除原定义。
5. 将“待改名 / 待拆分”命名收敛清单回写到本方案文档。
6. 第一批低风险命名收敛先采用“新增窄接口 + 调用方改依赖”的方式落地。
7. 同步更新文档中对已删除路径和已收敛路径的描述。

## 验证要求

每一阶段完成后至少执行：

1. `pnpm run -s compile`
2. 目标模块相关测试
3. 在阶段性删除较大时，执行 `pnpm exec hardhat test`

## 风险说明

- 本方案以仓库内 Solidity、TS、JS、MD 引用关系为依据。
- 若仓库外仍有独立前端、脚本仓或 SDK 直接依赖这些接口文件，需要额外同步。
- `GracefulDegradation` 清理时必须同时更新代码注释与架构文档，避免残留失真描述。
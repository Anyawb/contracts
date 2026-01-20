# 清算架构对齐执行步骤（按确认方案）

1) 入口与注册（对齐 `docs/Architecture-Guide.md`：**SettlementManager 为唯一对外写入口（SSOT）**）  
- 部署并注册 `KEY_SETTLEMENT_MANAGER → SettlementManager`：keeper/机器人 **默认/推荐入口** 为 `SettlementManager.settleOrLiquidate(orderId)`（统一入口，参数由其内部根据 `orderId` 计算）。  
- 部署并注册 `KEY_LIQUIDATION_MANAGER → LiquidationManager`：作为 **清算执行器**（仅供 SettlementManager 在清算分支内部调用，或用于测试/应急的“显式参数执行器入口”）。  
- 写入直达账本：清算分支写路径直达 `KEY_CM.withdrawCollateralTo` 与 `KEY_LE.forceReduceDebt`；成功后由 `KEY_LIQUIDATION_VIEW.pushLiquidationUpdate/Batch` 单点推送（best-effort）。

2) 清算域精简与口径统一（已完成）  
- 旧模块族（如 `LiquidationCoreOperations`、`LiquidationDebtManager`、`LiquidationCollateralManager`、`LiquidationViewLibrary` 等）已下线/移除，避免职责边界与口径分叉。  
- 当前清算域保留并对齐 Architecture-Guide 的模块集合：`SettlementManager`（SSOT 写入口）、`LiquidationManager`（执行器）、`LiquidationRiskManager`（风控只读）、`LiquidationCalculator`（只读预览）、`LiquidationConfigModule`（配置 SSOT）、`LiquidationPayoutManager`（残值分配 SSOT）。

3) 只读/推送层对齐（已完成）  
- 事件/DataPush 单点入口统一为 `KEY_LIQUIDATION_VIEW → LiquidatorView`。  
- 清算执行器的 View push 采用 best-effort；失败 emit `CacheUpdateFailed`，供链下重试。

4) 调整视图层  
- `LiquidatorView` 去除对被删除子模块（Record/ProfitStats/Reward/BatchQuery 等）的依赖与查询接口；必要时以空/0 返回或直接移除。  
- 保持 `pushLiquidationUpdate/Batch` 单点推送。

5) 部署脚本对齐  
- `deploylocal.ts` 部署/注册轻量版 `LiquidationManager`。  
- 移除未部署子模块的注册与地址占位。

6) 文档对齐  
- 更新 Usage-Guide/Liquidation 文档，补充“实际入口/模块键”说明，反映精简后的模块集合与事件路径。

7) 校验  
- 编译检查（Solidity 编译）。  
- 如需，最小化测试/脚本检查注册逻辑。

补充说明（结合现有 Usage-Guide 与架构指南）
- `liquidation-complete-logic.md` 与 `Liquidation-Mechanism-Logic.md` 已明确“直达账本 + LiquidatorView 单点事件 + 风控只读”，本计划保持一致，并删除任何经 View 转发或多子模块路由的残留实现。
- `liquidation-reward-penalty.md` 的积分惩罚逻辑若继续保留，应仅在账本写入成功后由业务入口调用（不新增清算子模块）；如不需要链上积分惩罚，可在本轮一并下线相关子模块引用。
- 架构指南要求的模块键：入口 `KEY_SETTLEMENT_MANAGER`（SSOT）、执行器 `KEY_LIQUIDATION_MANAGER`、账本 `KEY_CM`/`KEY_LE`、事件 `KEY_LIQUIDATION_VIEW`、风控只读 `KEY_LIQUIDATION_RISK_MANAGER`/`LiquidationView`；其他清算子模块不再注册。
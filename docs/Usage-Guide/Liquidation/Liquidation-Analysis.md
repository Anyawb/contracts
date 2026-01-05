# 清算架构对齐执行步骤（按确认方案）

1) 入口与注册（按架构指南方案 B：直达账本 + 单点推送）  
- 提供轻量版 `LiquidationManager`：仅做 `ACTION_LIQUIDATE` 权限校验；写路径直调 `KEY_CM.withdrawCollateral` 和 `KEY_LE.forceReduceDebt`；成功后单点调用 `KEY_LIQUIDATION_VIEW.pushLiquidationUpdate/Batch`。不在清算入口持有链上记录/统计存储。  
- 部署脚本中部署并注册 `KEY_LIQUIDATION_MANAGER →` 轻量版 `LiquidationManager`，移除其他清算子模块的注册/占位（Calculator/BatchQuery/Record/ProfitStats/Reward/Guarantee 等）。

2) 精简 CoreOperations/依赖  
- `LiquidationCoreOperations` 直接调用 CM/LE；删除/绕过对 `KEY_LIQUIDATION_DEBT_MANAGER` 等子模块的调用。  
- 保留必要校验/计算，移除链上记录/统计写入。

3) 删除清算子模块文件及接口/Mock  
- 删除/移除：`LiquidationCalculator`、`LiquidationBatchQueryManager`、`LiquidationRecordManager`、`LiquidationProfitStatsManager`、`LiquidationRewardManager`、`LiquidationRewardDistributor`、`LiquidationDebtRecordManager`、`LiquidationGuaranteeManager`、`LiquidationConfigManager` 等对应模块、接口、Mock。  
- 清理 `ModuleKeys`、接口引用、编译依赖。

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
- 架构指南要求的模块键：入口 `KEY_LIQUIDATION_MANAGER`、账本 `KEY_CM`/`KEY_LE`、事件 `KEY_LIQUIDATION_VIEW`、风控只读 `KEY_LIQUIDATION_RISK_MANAGER`/`LiquidationView`；其他清算子模块不再注册。
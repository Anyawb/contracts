# Collateral Valuation Migration Plan

目标：将抵押估值查询从 `CollateralManager` 迁移到 View 层（`PositionView`），并移除 `ICollateralManager` 中的估值接口，保持架构指南的一致性。

## 范围
- 移除估值接口的原位置：`ICollateralManager.getUserTotalCollateralValue/getTotalCollateralValue/getAssetValue` 及 `CollateralManager` 中对应实现（当前已改为 revert）。
- 目标位置：在 `PositionView` 暴露统一估值入口（用户总抵押、系统总抵押、单资产估值），供各模块复用。
- 更新所有调用方（Router、LiquidatorView、Liquidation 库/风险视图、LendingEngineCore、mocks 等）改用 `PositionView` 的新接口。

## 步骤
1) **新增 View 估值接口**
   - 在 `PositionView` 增加 `getUserTotalCollateralValue`, `getTotalCollateralValue`, `getAssetValue`（使用同一预言机/精度逻辑，含批量上限/回退策略）。

2) **路由调用方到 View**
   - `VaultRouter`：改为调用 `PositionView` 估值接口。
  - `LiquidatorView`/`LiquidationRiskQueryLib`：统一改为调用 `PositionView` 估值接口（`LiquidationViewLibrary` 已移除）。
   - 其他引用 `ICollateralManager` 估值的业务或视图（含 `LendingEngineCore`）一并切换。

3) **清理 CollateralManager 接口/实现**
   - 从 `ICollateralManager` 删除估值相关签名。
   - 从 `CollateralManager` 删除估值函数（已改为 revert 的部分），保持只读查询：`getCollateral`、`getTotalCollateralByAsset`、`getUserCollateralAssets`。

4) **更新 Mocks 与测试依赖**
   - `MockCollateralManager`/`BadCollateralManager`：仅保留 `ICollateralManager` 账本接口，移除旧估值方法（估值统一走 `PositionView`）。
   - `RevertingCollateralTotals`：作为“估值/账本读取失败”的测试桩（可用于 KEY_POSITION_VIEW / KEY_CM 的负面路径），不再伪装为 `ICollateralManager` 的估值实现。
   - 调整测试/脚本中对估值的直接调用，改指向 `PositionView`（或使用 `IPositionViewValuation` 最小接口）。

5) **风险与验证**
   - 确认 `PositionView` 使用与 LE 同步的预言机与精度，避免口径分叉。
   - 批量接口保留 `MAX_BATCH_SIZE` 校验，防 DoS。
   - 运行相关测试/静态检查，确保所有依赖处已更新。

## 备注
- View 估值为只读，不改变写入安全边界；Keeper/前端仍需对返回值不可用场景进行降级处理。 

# LiquidationCollateralManager 优雅降级实施报告（对齐 Architecture-Guide）

> ⚠️ **归档说明（Legacy）**：`LiquidationCollateralManager` 属于旧清算模块族，已在当前实现中下线/移除。  
> 当前清算写路径为 `SettlementManager`（SSOT）→ `CollateralManager`/`VaultLendingEngine`（直达账本）→ `LiquidatorView`（DataPush 单点）。  
> 本文仅保留为历史设计记录，勿作为当前代码实现/测试入口依据。

## 🎯 概述

本版报告已按 `docs/Architecture-Guide.md` 对齐：抵押物管理仅负责账本扣押，不在合约内执行价格获取或优雅降级；估值与降级统一由 `LendingEngine` 估值路径完成；写入口统一由 `SettlementManager` 承接，在进入清算分支时直达账本；事件/DataPush 由 `LiquidatorView.pushLiquidationUpdate/Batch` 单点触发。

## 🔧 主要改动

- **职责收敛**：抵押扣押/划转仅做账本写入（`withdrawCollateralTo`），不挂载 `GracefulDegradation`、不直接调用预言机、不过度缓存。
- **估值归口**：价格与降级仅在 `LendingEngine` 估值路径执行（如 `getAssetValueWithFallback*`）；只读/预览由 `LiquidationView` 调用 `LendingEngine` 只读估值接口完成。
- **事件单点**：清算写入成功后，仅通过 `LiquidatorView.pushLiquidationUpdate/Batch` 推送事件/DataPush，避免在 `CollateralManager` 重复发事件。
- **权限与命名**：账本层内部做权限校验（如 `ACM.requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender)`）；存储命名遵循统一规范（`s`、`moduleCache` 等）。

## 🧭 设计修订（示意代码）

```solidity
// 账本层：仅执行扣押，权限/余额校验在账本内
function seizeCollateral(address user, address asset, uint256 amount) internal {
    _seize(user, asset, amount);
}

// 只读层：估值与降级由 LendingEngine 提供
function getCollateralValue(address asset, uint256 amount) external view returns (uint256 value) {
    return ILendingEngineView(lendingEngine).getAssetValueWithFallback(asset, amount);
}
```

> 如仍存在 `calculateCollateralValue*`、批量估值或降级事件等实现位于 `CollateralManager`，应迁移/删除，改为调用 `LendingEngine` 估值接口或通过视图层只读聚合完成。

## ✅ 对齐清单

- [x] 移除 CollateralManager 内的优雅降级实现与相关事件
- [x] 清算写路径：`SettlementManager`（进入清算分支）→ `CollateralManager.withdrawCollateralTo` / `LendingEngine.forceReduceDebt`
- [x] 事件/DataPush：仅 `LiquidatorView.pushLiquidationUpdate/Batch`
- [x] 预言机健康/降级：仅在 `LendingEngine` 估值路径
- [x] 存储/命名/权限：遵循统一规范，不经 View 放行写权限

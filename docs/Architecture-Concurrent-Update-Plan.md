# 并发更新高一致性改进方案（基于 Architecture-Guide）

## 目标
- 避免同一 `(user, asset)` 在并发推送时被后写覆盖，提升缓存/账本一致性。
- 严格遵循 `Architecture-Guide.md` 的“写入不经 View、统一入口、事件驱动 + 链下重放”原则。
- 形成可执行的分阶段改进路径，逐步演进到“强一致 + 可审计 + 可回放”。

## 范围
- 链上合约：`VaultRouter`、`PositionView`、`CacheOptimizedView`、`CollateralManager`、`LendingEngine` 等涉及缓存推送的模块。
- 链下流程：事件消费、重试/重放、去重/顺序控制。

## 当前状态（基线）
- 推送前读取最新账本值（`CollateralManager` 先读债务；`LendingEngine` 先读抵押），一定程度缓解旧值覆盖。
- 推送失败事件与链下重放流程已在 `Architecture-Guide.md` 中定义并落地。
- 风险：同一区块/短窗口内的两次推送仍可互相覆盖；缺少版本/序列号、增量接口和并发测试。

## 分阶段改进路线

### Phase 0：统一入口与链下节流（低成本，立即执行） （已完成（部分））
- **强制统一入口（已完成）**：
  - 约束目标：所有头寸/统计类“写缓存”入口只能走 `VaultCore → VaultRouter → PositionView/StatisticsView`，业务模块（CM/LE/Liquidation 等）不得绕过路由直接写 View。
  - 链上实现要点：
    - `VaultRouter` 的 push 写路径对外采用 `onlyVaultCore`/`_onlyVaultCore()` 校验（生产路径下只有 `VaultCore` 能调用；从而强制所有推送经过核心入口）。
    - 兼容/测试例外：`testingMode` 且 `PositionView` 缺失时，允许 `VaultBusinessLogic` 走兼容写路径（仅用于本地/测试，不作为生产设计的一部分）。
- **事件携带上下文（已完成）**：
  - `VaultRouter` 推送事件已携带 `requestId/seq`（如 `UserPositionPushed/UserPositionDeltaPushed/AssetStatsPushed`），用于链下：
    - 去重：用 `requestId`（或 `(blockNumber, logIndex)`）做幂等键
    - 排序：优先 `blockNumber/logIndex`，可选用业务侧生成的 `seq` 做更强顺序约束
  - 说明：`requestId/seq` 的“链上强一致语义”由 Phase 3 的 `nextVersion`/幂等规则兜底；Phase 0 主要解决“可观测与可重放输入”。
- **链下节流/租约（已完成（部分））**：
  - 推荐实践（详见 `docs/Cache-Push-Manual-Retry.md`）：
    - 对同一 `(user, asset, view)` 申请租约/行级锁（例如 Redis/DB lock），避免多 worker 并发重放。
    - 失败重试做最小间隔/指数退避；重试前重读账本，避免旧值覆盖。
    - 重放任务键建议 `(user, asset, view, blockNumber, logIndex)`（或附带 `requestId/seq`）确保幂等与可审计。
  - 注：该条目主要属于链下运维/后端工程落地；本仓库提供事件与重试流程规范，具体实现视部署栈而定。

### Phase 1：顺序与幂等（中等成本，提升一致性） （已完成）
- **推送版本号/时间戳比对（已完成）**：在推送参数中增加 `nextVersion`（或 `lastUpdatedAt`），`PositionView` 在写入前比对本地版本；不匹配则拒绝，保持单调递增。
- **事件顺序消费（已完成（部分））**：链下消费者按 `blockNumber/logIndex` 或 `seq` 严格有序应用，并对重复/乱序做去重（链下落地视具体后端实现；本仓库已提供失败事件与手动重试/重放流程文档与脚本约束）。

### Phase 2：增量接口（减少覆盖风险） （已完成）
- **已完成（链上接口/视图侧 + 路由/业务改造）**
  - `IVaultRouter` / `VaultRouter` / `VaultCore` 已新增 `pushUserPositionUpdateDelta`（含 requestId/seq）（已完成）。
  - `IVaultRouter`/`VaultCore` 已补齐携带 `nextVersion` 的推送重载（含 delta 版），保留旧版兼容；`VaultRouter` 直呼 `PositionView.pushUserPositionUpdate{Delta}` 并保留事件 `UserPositionPushed/UserPositionDeltaPushed` 供链下幂等（已完成）。
  - `VaultRouter` 已引入 `KEY_POSITION_VIEW` 解析并在写路径中使用 `_getCachedPositionView()`（已完成）。
  - `CollateralManager`/`LendingEngine`/`Liquidation` 在推送前调用 `PositionView.getPositionVersion(user, asset)`，生成 `nextVersion = version + 1` 透传；读取失败则传 `nextVersion=0` 降级为合约自增模式（已完成）。
  - `PositionView` 已支持 delta 写入，带版本自增/指定版本，落后版本拒绝（`StaleVersion`），防下溢（`InvalidDelta`），事件新增 `UserPositionCachedV2`（含 version）（已完成）。
  - 统计视图写路径已同步引入严格 `nextVersion` 校验（`StatisticsView`）（已完成）。
  - `CacheOptimizedView` 当前为读路径，不存在写入入口：该条目移除/合并到“已完成清单”（无额外工作项）。
- **批量聚合写入（移除：可选优化，暂不纳入本轮）**
  - 批处理（存/借/还/清算）在合约内合并 delta 后一次推送可缩短竞争窗口，但不影响 Phase 1-3 交付；后续若有明确 gas/吞吐压力再单独立项。

### Phase 3：乐观并发控制（高一致性） （已完成）
- **版本锁/乐观并发（严格 nextVersion）（已完成）**：`PositionView` 维护 `(user, asset) -> version`，推送时需要 `nextVersion`（期望写入的“下一版本号”）；当 `nextVersion!=0` 时必须满足 `nextVersion == currentVersion + 1`，否则 revert（要求重读后重试）。开销：一次 SLOAD + 一次 SSTORE（另加可选幂等键写入开销）。
- **幂等写入标识（推荐：版本绑定 O(1)）（已完成）**：使用 `requestId` 作为幂等键，但**不做全量 mapping 累积**；仅在合约内为每个 `(user, asset)` 记录 `lastAppliedRequestId`（O(1) 存储）。当 `nextVersion!=0` 且发生重放时，若 `nextVersion == currentVersion` 且 `requestId == lastAppliedRequestId`，则视为幂等重复并忽略（不重复写缓存）。`seq` 可选做严格递增约束（非递增则 revert），但对同一 `requestId` 的重复重放应优先按幂等忽略处理。`nextVersion==0`（自增模式）下不提供强幂等保证；如确有需求可再引入 ring buffer（仅缓存最近 N 个 requestId）作为增强。

### Phase 4：高一致消费与审计
- **强一致消费器**：链下进程按顺序消费并落地 DB/缓存，记录 apply 日志（含 `seq/requestId/blockNumber/logIndex`），支持回放与审计。
- **监控与告警**：对“拒写/落后版本/重复 seq”计数并告警，辅助排查并发热点。

## 代码改动建议（按阶段）

- Phase 0
  - `VaultRouter`：仅事件，不改逻辑；收紧 `onlyBusinessModule` 白名单，只允许 VaultCore。
  - 事件增加可选 `requestId/seq` 字段（保持向后兼容，新增事件或扩展参数）。

- Phase 1
  - `PositionView` / `CacheOptimizedView`：存储 `version` 或 `lastUpdatedAt`，推送前校验；拒写则发事件说明原因。
  - 推送参数新增 `nextVersion`（向后兼容可选字段；`nextVersion==0` 表示合约自增）。

- Phase 2
  - `IVaultRouter` / `PositionView` 增加 `pushUserPositionUpdateDelta`，内部以 delta 叠加。
  - `CollateralManager` / `LendingEngine` 在同一事务内计算 delta 后调用 delta 接口（或批处理后一次推送）。

- Phase 3
  - `PositionView` 引入 `(user, asset) -> version` 乐观锁；推送接口要求 `expectedVersion`，不匹配 revert。
  - 为防止死锁/饥饿，可提供“读最新版本后重试”的工具/入口（链下或治理脚本）。

- Phase 4
  - 无需链上改动，完善链下消费、审计、回放工具（与 `Cache-Push-Manual-Retry.md` 协同）。

## 测试计划
- **并发覆盖测试**：同一区块内两次推送，验证版本/seq 防止旧写覆盖。
- **delta 累加测试**：连续 delta 推送与快照推送的结果一致性。
- **拒写路径测试**：落后版本、无权限、无效输入时的事件与状态保持。
- **链下回放演练**：模拟多 worker 并发重放，验证租约/去重/顺序。
- **端到端**：借贷、清算、批量存取款场景下的缓存一致性。

## 推进节奏（建议）
1) Phase 0：本周落地（低风险，主要是入口收敛与链下节流配置）。  
2) Phase 1：下周完成版本/seq 校验与对应测试。  
3) Phase 2：两周内补 delta 接口并改造调用方，补充测试。  
4) Phase 3：评估链上 Gas 与复杂度后落地乐观锁（若链下顺序消费足够，可择机实施）。  
5) Phase 4：与运维/后端协同完善消费与审计。  

## 关联文档与原则
- `docs/Architecture-Guide.md`：写入不经 View、事件驱动、失败事件 + 链下重放。
- `docs/Cache-Push-Manual-Retry.md`：链下重试、去重与限流。
- `docs/PlatformLogic.md` / `Architecture-Analysis.md`：现有问题与风险背景。

## 交付物清单
- 链上：接口/事件调整、版本或 seq 校验、增量接口、（可选）乐观锁实现。
- 链下：顺序消费与去重、重放节流、监控与审计、演练脚本。
- 测试：并发/拒写/增量/端到端完整用例。


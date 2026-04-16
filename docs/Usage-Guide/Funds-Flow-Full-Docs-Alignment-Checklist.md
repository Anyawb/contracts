# Funds-Flow 扩圈审计：docs 全目录对齐清单（closeReason / 三层状态机 / debt-free open）

> 审计时间：2026-04-16
> 审计范围：`docs/**` 全目录
> 基准文档：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`

## 1) 审计覆盖结论

- docs 文件总数：90
- 命中目标语义关键词文件数：21
- 非目标语义文件数：69（未发现 closeReason / 三层状态机 / debt-free open 相关语义）

本清单仅对 21 个命中文件给出“已对齐/待修正”结论。

## 2) 对齐标准（本轮固定）

- 终态读取：不得再用 `remainingDebt == 0`、旧 mixed enum、或单一 `status` 推断 clean close。
- 状态模型：统一按三层表达。
- 第一层：`lifecycle + closeReason`。
- 第二层：`shortfallStatus`。
- 第三层：`collateralDisposition`。
- blocks-only：必须显式区分“债务已清但仍未关闭（debt-free open）”与“已收尾（trade closeout / maturity closeout / maturity delivery closeout）”。
- 兼容枚举（如 `LiquidatedWithShortfall`、`TRADE_CLOSED`、`SETTLED`）只能作为兼容读面/事件名，不得再写成主状态机语义。

## 3) P0（必须先改）

- [x] `docs/FRONTEND_CONTRACTS_INTEGRATION.md:7`
  - 问题：仍写“blocks-only 暂不作为默认前端接入/上线 checklist”。
  - 对齐要求：改为“blocks-only 已进入主线；按 trade closeout / maturity closeout / maturity delivery closeout + 三层状态模型接入”。

- [x] `docs/FRONTEND_CONTRACTS_INTEGRATION.md:30`
  - 问题：仍写“blocks-only 不纳入默认建模要求”。
  - 对齐要求：改为“blocks-only 默认 DTO 采用 `lifecycle + closeReason + shortfallStatus + collateralDisposition`”。

- [x] `docs/FRONTEND_CONTRACTS_INTEGRATION.md:37`
  - 问题：仍写“blocks-only 只保留边界说明，不展开接入步骤”。
  - 对齐要求：改为“保留边界说明同时提供主线接入步骤（含 debt-free open）”。

- [x] `docs/FRONTEND_CONTRACTS_INTEGRATION.md:35`
  - 问题：把 `LiquidatedWithShortfall` / `DefaultedWithShortfall` 写成“订单终态”。
  - 对齐要求：改为“兼容终态标签”；主终态口径改为三层状态快照。

- [x] `docs/FRONTEND_CONTRACTS_INTEGRATION.md:2863`
  - 问题：仍写“blocks-only 不纳入默认前端/keeper 集成范围”。
  - 对齐要求：改为“纳入默认范围，区分 trade closeout、maturity closeout 与 maturity delivery closeout”。

- [x] `docs/FRONTEND_CONTRACTS_INTEGRATION.md:2943`
  - 问题：仍写“blocks-only 订单入口不在默认 keeper 范围内”。
  - 对齐要求：改为“默认 keeper/后端需覆盖 maturity closeout；debt-free open 可走 trade closeout”。

- [x] `docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md:34`
  - 问题：仍写“blocks-only 不纳入默认后端实施范围”。
  - 对齐要求：改为“纳入默认后端实施范围，表结构按三层状态模型建模”。

- [x] `docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md:38`
  - 问题：把 `LiquidatedWithShortfall` / `DefaultedWithShortfall` 写成“订单终态”。
  - 对齐要求：改为“兼容层标签”；主判定改为 `lifecycle + shortfallStatus + collateralDisposition`。

- [x] `docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md:40`
  - 问题：仍写“blocks-only shortfall/状态机文档暂不改写”。
  - 对齐要求：改为“已进入主线口径；blocks-only 第二层固定 `NONE`（当前正式写路径）”。

- [x] `docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md:922`
  - 问题：仍写“blocks-only 事件族未来单列/deferred”。
  - 对齐要求：改为“当前必须落库并回读三层状态收敛”。

## 4) P1（建议本轮同步）

- [x] `docs/FRONTEND_CONTRACTS_INTEGRATION.md`
  - 补充显式术语：加入“债务已清但仍未关闭（debt-free open）”固定文案，避免仅写 debt-free。

- [x] `docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md`
  - 补充显式术语：加入“debt-free open”固定文案，并给出列表页筛选规则示例。

- [x] `docs/Usage-Guide/UserFlow.md:30`
  - 现状：已有“不能从 `remainingDebt == 0` 反推”的约束。
  - 建议：补一行固定模板术语“debt-free open vs closeout”。

- [x] `docs/frontend-backend-unified-schema-ssot.md:457-481`
  - 现状：三层字段齐全。
  - 建议：在 `status` 字段说明旁补充“debt-free open”映射示例，避免消费方误将 `REPAID` 视为已关闭。

- [x] `docs/Usage-Guide/Blocks-Only-Product-Guide.md:41`
  - 现状：保留“maturity delivery closeout”词项。
  - 建议：补注“其为 maturity closeout 下的 lender delivery 结果态”，与 Funds-Flow 四态口径保持一一映射。

## 5) 已对齐（本轮抽检通过）

- [x] `docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`
- [x] `docs/Architecture-Guide.md`
- [x] `docs/events.md`
- [x] `docs/Usage-Guide/Blocks-Only-Frontend-Matching-Checklist.md`
- [x] `docs/Usage-Guide/runbook/BNB-Testnet-Funds-Flow-Live-Matrix.md`
- [x] `docs/Test-Guide/pre-launch-comprehensive-testing-requirements.md`
- [x] `docs/Usage-Guide/Liquidation/liquidation-complete-logic.md`
- [x] `docs/Usage-Guide/Liquidation/Liquidation-Mechanism-Logic.md`

## 6) 执行顺序建议

- 第 1 步：先改 P0 的 10 项（两份总指南优先）。
- 第 2 步：补 P1 的术语覆盖与映射注释。
- 第 3 步：全目录回归检索以下残留模式并清零：
  - `blocks-only.*不纳入|暂不|deferred`
  - `订单终态写成 .*WithShortfall`
  - `remainingDebt == 0` 被直接用于“已关闭”判定

## 7) 回归口径（完成标准）

- docs 中不再出现“blocks-only 不纳入主线/默认接入”叙事。
- 文档中凡提及终态判定，均能追溯到三层状态模型。
- `debt-free open` 至少在 Funds-Flow、前端总指南、后端总指南、UserFlow 四处显式可见并一致。

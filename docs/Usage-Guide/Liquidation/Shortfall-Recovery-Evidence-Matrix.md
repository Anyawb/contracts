# Shortfall Recovery Evidence Matrix (SSOT)

## 1. 目的

本文档给出 shortfall recovery 的统一审计口径：

1. 按 `RecoverySource` 列出可用入口与约束。
2. 明确每个来源的证据要求（`evidenceHash` 与链下归档材料）。
3. 提供审计映射：`source -> 必填证据类型 -> 责任角色`。

本页是 shortfall recovery 证据要求的单点 SSOT；与代码不一致时，以合约实现与回滚规则为准并同步修订本页。

## 2. 合约事实边界（当前实现）

- 合约入口：`SettlementManager.applyShortfallRecovery(...)`。
- 状态写入口：`SettlementManager.setShortfallStatus(..., WRITTEN_OFF, evidenceHash)`。
- 角色模型：
  - 具有 `ACTION_SET_PARAMETER` 的治理调用者可直接上报 recovery。
  - 或者由治理通过 `setShortfallRecoveryReporter(reporter, source, true)` 绑定 source 专属 reporter 后上报 recovery。
- 强制证据（当前已落地）：
  - `INSURANCE_FUND`、`OFFCHAIN_RECOVERY` 在 recovery 时必须 `evidenceHash != 0x0`。
  - `WRITTEN_OFF` 在 `setShortfallStatus` 时必须 `evidenceHash != 0x0`。

## 3. RecoverySource 完整证据矩阵

| RecoverySource | 允许入口 | `evidenceHash` 规则 | 必填证据类型（链下归档） | 责任角色（RACI 主责） |
| --- | --- | --- | --- | --- |
| `NONE` | 禁止作为 recovery source | N/A | N/A | N/A |
| `GUARANTEE_FUND` | 1) `settleOrLiquidate` default 分支自动冲减 2) `applyShortfallRecovery` | 允许为 0；建议非零 | Guarantee default 结算记录、罚没明细、订单号与区块锚点 | 保证金模块运营方 + 治理复核 |
| `INSURANCE_FUND` | `applyShortfallRecovery` | **必须非零** | 保险金池出账凭证、链上转账哈希/批次号、内部审批单号 | 保险资金管理员 + 治理复核 |
| `OFFCHAIN_RECOVERY` | `applyShortfallRecovery` | **必须非零** | 链下回款凭证、清分流水、对账报告、入账时间戳 | 链下清算运营 + 财务复核 + 治理抽检 |
| `MANUAL_SETTLEMENT` | `applyShortfallRecovery` | 允许为 0；建议非零 | 人工处置工单、处置计算单、审批链路、执行日志 | 治理操作员 |
| `GOVERNANCE_WRITE_OFF` | 不允许通过 `applyShortfallRecovery`；仅可 `setShortfallStatus(...WRITTEN_OFF...)` | **必须非零**（写核销状态时） | 治理核销提案、投票/多签执行证据、风险备忘录 | 治理（提案人/执行人/审计人） |

## 4. 审计映射（source -> 必填证据类型 -> 责任角色）

| source | 必填证据类型 | 责任角色 |
| --- | --- | --- |
| `GUARANTEE_FUND` | default 罚没执行事实（事件/交易）+ 对应订单 shortfall 对账单 | Guarantee 运营负责人 |
| `INSURANCE_FUND` | 保险池资金划拨证据（tx hash/批次）+ 审批凭据 | Insurance 资金管理员 |
| `OFFCHAIN_RECOVERY` | 链下回款凭证 + 清分/核销报告 + 入账批次 | Offchain 回收运营负责人 |
| `MANUAL_SETTLEMENT` | 人工结算工单 + 审批记录 + 执行日志 | 治理操作员 |
| `GOVERNANCE_WRITE_OFF` | 治理核销提案与执行证据（多签/投票）+ 风险披露 | 治理委员会/授权执行人 |

## 5. 回滚与风险提示（审计重点）

- `applyShortfallRecovery` 下列 source 会直接回滚：
  - `NONE`
  - `GOVERNANCE_WRITE_OFF`
- `INSURANCE_FUND` / `OFFCHAIN_RECOVERY` 传 `0x0` 证据会回滚。
- `WRITTEN_OFF` 状态变更传 `0x0` 证据会回滚。
- 不应把 liquidation payout 的 collateral 分账事件直接等价为 shortfall 已恢复；shortfall recovery 必须单独落账并可追溯证据。

## 6. 运营执行最小清单

1. 先确认 `orderId` 对应 shortfall ledger 仍为 active/pending 状态，且 recoveryAmount 不超过 remainingDebt。
2. 根据 source 归集并归档证据材料，计算 `evidenceHash`。
3. 使用具备授权的调用者（治理或受信 reporter）执行 recovery/write-off。
4. 校验链上事件与 ledger 字段：`recoveredAmount`、`remainingDebt`、`recoverySource`、`evidenceHash`。
5. 将交易哈希与归档材料回填到审计台账。

## 7. 与其它 SSOT 的关系

- 资金链总纲：`docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`
- 架构总纲：`docs/Architecture-Guide.md`
- shortfall 接口：`src/interfaces/IShortfallLedger.sol`
- 入口实现：`src/Vault/liquidation/modules/SettlementManager.sol`

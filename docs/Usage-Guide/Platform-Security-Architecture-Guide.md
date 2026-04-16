# 平台安全架构指南（五步强化版）

目标：从“合约安全”升级为“平台级安全工程”，并把安全要求固化为可执行、可监控、可演练、可审计的体系。

> 当前安全架构主线只覆盖 legacy / 通用订单与已纳入当前发布范围的核心模块。blocks-only 不作为当前默认 CLI baseline、默认 runbook 或默认放行证据；待其 trade-like 交割方案定稿后再单列。

适用对象：Security Architect、Protocol Security Auditor、DevSecOps Engineer、Detection Engineer、Incident Commander。

---

## 相关文档

- [docs/Usage-Guide/Platform-Security-Acceptance-Checklist.md](Platform-Security-Acceptance-Checklist.md)
- [docs/Usage-Guide/Security-Guards-Registry-and-Entrypoints.md](Security-Guards-Registry-and-Entrypoints.md)
- [docs/Usage-Guide/Monitoring-Observability-Implementation-Guide.md](Monitoring-Observability-Implementation-Guide.md)

---

## Step 1：架构强化（Security Architect）

### 1.1 安全目标

平台必须同时保护：

1. 用户资金域（抵押、借贷池、结算在途）。
2. 平台资金域（FeeRouter、GuaranteeFund、平台金库）。
3. 奖励资金域（mint、分发、回收）。
4. 控制面（升级、Registry、角色、pause）。
5. 运行面（密钥、RPC、CI/CD、配置产物）。

安全目标不是“零事故”，而是：

- 降低攻击面。
- 杜绝单点失守导致系统级资金失控。
- 让异常可检测、可止血、可恢复。

### 1.2 六层安全模型（强化后）

#### L1 资金与账本层（Fund and Ledger SSOT）

- 所有资金写入必须走 SSOT 入口。
- 旁路入口、内部函数误暴露、隐式转账必须被阻断。
- 关键不变量（资金守恒、余额变更可解释）必须可验证。

#### L2 合约与权限控制层（Contract Guards）

- 入口按用户、keeper、治理、诊断严格分层。
- `nonReentrant`、pause、strict 与 best-effort 边界必须清晰。
- ActionKeys 与 AccessControl 必须满足最小权限原则。
- 自动清算、自动减债、自动结算这类 fail-closed 业务决策必须绑定 strict authoritative valuation，不得被 best-effort/fallback 读口驱动。
- 对 legacy / 通用订单，抵押不足后的剩余债务必须进入显式 shortfall ledger 与显式终态，不允许依赖会计副作用把坏账“看起来归零”。

#### L3 治理与升级层（Governance and Upgrade）

- 升级、Registry 重绑、关键参数变更必须通过 multisig + timelock。
- break-glass 独立主体、独立审计、独立撤销。
- 升级前后必须执行 storage、地址绑定、角色、事件兼容性校验。

#### L4 运行与供应链层（Runtime and Supply Chain）

- 密钥托管在受控 secret manager。
- RPC 多路冗余、熔断、降级与隔离池。
- CI/CD 强制审批与制品一致性校验，禁止手工漂移发布。

#### L5 检测与监控层（Detection and Observability）

- 所有 P0/P1 风险必须有实时指标与告警。
- 所有关键治理动作必须有链上事件 + 审计日志双证据。
- 配置漂移、权限漂移、实现地址漂移必须持续检测。

#### L6 响应与恢复层（Response and Recovery）

- 定义统一 runbook 与指挥链。
- 演练 pause、RPC 切换、升级回滚、keeper 停机与恢复。
- 建立恢复准入条件与复盘闭环。

### 1.3 Missing Layer 判定规则

任一层满足以下之一即判定缺失：

- 只有文档，没有命令或系统实现。
- 只有实现，没有监控和告警。
- 只有监控，没有响应流程与负责人。

---

## Step 2：攻击建模（Protocol Security Auditor，最关键）

从攻击者视角列出可绕过架构的路径，并按资金影响排序。

### 2.1 攻击路径优先级矩阵

#### P0（可能导致系统级资金损失）

1. 升级权限劫持：接管 upgrade admin 或绕过升级授权逻辑，注入恶意实现直接提款。
2. Registry 重绑投毒：将关键 key 指向恶意模块，引导前端/keeper 调用错误地址。
3. 高权限角色漂移：误授/盗用 guardian、admin、break-glass，执行未授权操作。
4. 资金入口旁路：利用未收敛入口或内部编排暴露绕过 SSOT 约束。
5. Oracle 操纵联动清算：制造价格异常触发恶性清算和资产错误迁移。

#### P1（高概率造成局部资金损失或大面积业务中断）

1. 前端地址/ABI 污染：将用户交易导向错误合约、错误 selector、错误参数。
2. keeper 身份冒用或白名单缺口：非法主体调用清算/修复路径。
3. 链切换与 provider 劫持：错误 chainId 下执行高价值交易。
4. 事件收敛污染：索引滞后或错解导致风控与用户读模型偏离真实账本。

#### P2（放大攻击窗口或降低发现能力）

1. 监控静默：告警通道失效导致攻击长时间潜伏。
2. CI 门禁缺失：高风险变更无阻断直接进入生产。

### 2.2 每条攻击路径必须回答

1. 攻击前置条件是什么。
2. 攻击面入口在哪里。
3. 资金最大影响上限是多少。
4. 何种信号可以最先发现。
5. 5 分钟内止血动作是什么。
6. 如何验证已恢复安全状态。

### 2.3 攻击建模产物

- Attack Tree（版本化）。
- Abuse Case 清单（按 P0/P1/P2 标注）。
- 对应测试与演练编号。
- 与监控规则的一一映射关系。

---

## Step 3：工程化落地（DevSecOps Engineer）

把所有“必须”转成 CLI、CI、infra 三类可执行控制。

### 3.1 CLI 命令基线

以下命令必须在发布前流水线或值班手册中可直接执行：

```bash
pnpm -s run compile
pnpm -s run test:live:release-gates:bnb-testnet:strict:stream
pnpm -s run test:live:reward-baseline:bnb-testnet
pnpm exec hardhat run --network bnbTestnet scripts/tests/live-test/networks/bnb-testnet/live-reward-penalty-recycle-recovery.ts
pnpm exec tsx scripts/check-deployment.ts --network bnbTestnet
pnpm exec tsx scripts/check-pv-modules.ts --network bnbTestnet
pnpm exec tsx scripts/check-bnb-balances.ts
```

### 3.1.A Runbook 命令分层（防误用模型）

为防止开发者通过模糊命令混用 pg-mem 与真实数据库，测试入口必须按风险分层并绑定不可绕过约束。

命令分层矩阵：

1. `test:fast`
	- `REQUIRE_REAL_POSTGRES=0`
	- 允许 `USE_PG_MEM=1`
	- 使用 `jest.config.fast.cjs`
2. `test:real-db-core`
	- `REQUIRE_REAL_POSTGRES=1`
	- 禁止 `USE_PG_MEM=1`
	- 使用 `jest.config.real-db-core.cjs`
3. `test:critical-path`
	- `REQUIRE_REAL_POSTGRES=1`
	- 禁止 `USE_PG_MEM=1`（检测即失败）
	- 使用 `jest.config.critical-path.cjs`
4. `test:integration`
	- `REQUIRE_REAL_POSTGRES=1`
	- 禁止 `USE_PG_MEM=1`
	- 使用 `jest.config.integration.cjs`
5. `test:invariant`
	- `REQUIRE_REAL_POSTGRES=1`
	- 禁止 `USE_PG_MEM=1`
	- 使用 `jest.config.invariant.cjs`

`test:unit` 的迁移策略：

- 立即将 `test:unit` 改为硬失败脚本，仅输出迁移提示。
- 将原 `test:unit` 用例按用途迁移到 `fast` 或 `real-db-core`。
- 在 CI 中加入“发现 `test:unit` 调用则阻断”。

CLI 硬约束：

- 在 `test:critical-path` 检测到 `USE_PG_MEM=1` 必须立即退出非 0。
- 在任何 `REQUIRE_REAL_POSTGRES=1` 的命令中，若 `DATABASE_URL` 缺失必须立即退出非 0。
- 守卫脚本必须先于 Jest 执行，不允许测试框架自行容错降级。

### 3.2 CI 强制门禁

- 编译、类型、关键 live gates 失败即阻断。
- Registry key 缺失、ModuleKeys 漂移、ABI 与部署快照不一致即阻断。
- 高权限角色变化无审批记录即阻断。
- 关键脚本执行证据与日志未归档即阻断。
- 测试分层规则不满足（配置错配、数据库约束错配、旧命令误用）即阻断。

### 3.3 infra 安全结构

- 多 RPC 池：主池、备池、只读池、隔离池。
- 密钥结构：治理签名、应急签名、运行签名、只读签名分离。
- 可观测栈：metrics、alert、log、trace 与证据仓常驻。
- 发布结构：prod/stage/test 环境隔离，凭证不共享，告警不混用。

---

## Step 4：监控系统设计（Detection Engineer）

### 4.1 Metrics Schema

安全监控最小 schema 建议：

```text
security_tx_total{
	network, module, entrypoint, status, revert_selector, signer_type
}

security_governance_change_total{
	action, target, executor, timelock_id, approved
}

security_role_change_total{
	role, account, operator, action
}

security_fund_delta{
	vault, asset, direction, reason
}

security_reconciliation_lag_seconds{
	network, module, stage  # onchain->indexer, indexer->projection
}

security_config_drift{
	kind, key, expected, actual
}
```

### 4.2 Alert Rules

- P0：未经批准的 upgrade、Registry 重绑、关键角色变更。
- P0：关键资金域短时异常净流出超过阈值。
- P0：高风险入口短时间重复失败且错误模式一致（疑似攻击探测）。
- P1：Oracle 偏离或不可用持续超过阈值。
- P1：reconciliation lag 持续超时。
- P1：RPC 错误率、revert 率、provider 错误率异常上升。
- P1：配置漂移持续存在且未进入处置流程。

### 4.3 Dashboard 结构

1. 安全总览：P0/P1 告警、风险趋势、值班状态。
2. 资金安全：分资金域展示净流入/流出、异常事件、关联 tx。
3. 治理与权限：升级、Registry、角色变化时间线。
4. 执行健康：交易成功率、确认时延、错误分类、RPC 健康。
5. 收敛健康：链上成功到索引、索引到读模型的一致性链路。

---

## Step 5：事故演练系统（Incident Commander）

### 5.1 Runbook 体系

至少具备以下 runbook：

- RB-01 升级权限异常。
- RB-02 Registry 重绑异常。
- RB-03 资金异常外流。
- RB-04 Oracle 异常导致清算风险。
- RB-05 前端地址/ABI 污染。
- RB-06 监控静默和告警链路故障。

每个 runbook 必须包含：

- 触发条件。
- 5 分钟止血动作。
- 30 分钟定位动作。
- 外部沟通模板。
- 恢复准入检查项。
- 复盘模板与补丁追踪编号。

### 5.2 响应流程图

```text
Detect -> Triage -> Contain -> Preserve Evidence -> Diagnose -> Recover -> Postmortem
```

每个阶段明确：

- 责任角色（IC/SecEng/Protocol/Infra/Comms）。
- 时间目标（例如 5 分钟内止血决策）。
- 进入下一阶段的准入条件。

### 5.3 权限调用路径

事故期必须有可审计权限路径：

1. 谁可触发 pause/局部只读。
2. 谁可停止 keeper/自动任务。
3. 谁可执行紧急升级/回滚。
4. 谁可更改 Registry/ActionKeys。
5. 谁负责临时权限撤销与恢复确认。

所有动作必须保留：审批记录、执行 tx、执行人、时间戳、关联工单。

---

## 结论

平台安全不是单个函数正确，而是“六层防御 + 攻击建模 + 工程门禁 + 检测系统 + 演练体系”同时成立。

只有把“必须”变成命令、配置、结构和演练，平台才具备在真实攻击与真实事故中持续生存的能力。
# 平台安全验收 Checklist（五步法）

本文档用于上线前、重大变更前、事故复盘后安全验收。验收通过标准为：所有“必须”项均具备证据，且可通过命令、CI、监控与演练复验。

> 当前安全验收主线只覆盖 legacy / 通用订单与已纳入当前发布范围的核心模块。blocks-only 不作为当前默认放行项；待其 trade-like 交割方案定稿后再单列 runbook 与验收证据。

关联文档：

- [docs/Usage-Guide/Platform-Security-Architecture-Guide.md](docs/Usage-Guide/Platform-Security-Architecture-Guide.md)
- [docs/Usage-Guide/Monitoring-Observability-Implementation-Guide.md](docs/Usage-Guide/Monitoring-Observability-Implementation-Guide.md)
- [docs/Usage-Guide/Security-Guards-Registry-and-Entrypoints.md](docs/Usage-Guide/Security-Guards-Registry-and-Entrypoints.md)

---

## Step 1：架构强化（Security Architect）

目标：确认无 missing layer，并把六层安全模型落到具体控制点。

### 1.1 六层模型完整性

- [ ] L1 资金与账本层：所有资金写路径均收敛到 SSOT 模块，禁止旁路写入。
- [ ] L2 合约控制层：入口边界、权限边界、pause、reentrancy、strict/best-effort 边界完整。
- [ ] 自动风险/自动清算/自动结算已证明使用 strict authoritative valuation；best-effort/fallback 读口不会驱动自动 debt reduction。
- [ ] 对 legacy / 通用订单已证明“抵押不足”会生成显式 shortfall ledger 与 with-shortfall 终态，而不是隐式吞没坏账。
- [ ] L3 治理与升级层：multisig + timelock + 变更审计 + 回滚路径完整。
- [ ] L4 运行与供应链层：密钥、RPC、CI/CD、产物签名/校验、环境隔离完整。
- [ ] L5 监控检测层：指标、告警、审计日志、漂移检测与证据归档完整。
- [ ] L6 响应与恢复层：runbook、权限调用链、演练、RTO/RPO 目标完整。

### 1.2 Missing Layer 阻断项

- [ ] 任一层缺失则直接阻断发布。
- [ ] 任一层只有“文档承诺”但无技术实现证据则阻断发布。
- [ ] 任一层无法给出负责人、值班与回滚动作则阻断发布。

### 1.3 架构证据

- [ ] 提供模块边界图、权限图、升级路径图。
- [ ] 提供 Registry key 清单与当前链上绑定快照。
- [ ] 提供关键入口 allowlist 与“禁止暴露入口”清单。

---

## Step 2：攻击建模（Protocol Security Auditor，最关键）

目标：从攻击者视角列出绕过路径，并按资金影响排序。

### 2.1 攻击路径清单（按资金影响排序）

- [ ] P0-1 升级权限劫持：获取 upgrade admin 或绕过 `_authorizeUpgrade`，直接替换实现窃取资金。
- [ ] P0-2 Registry 重绑投毒：将关键模块 key 指向恶意合约，诱导用户与 keeper 调用错误地址。
- [ ] P0-3 权限漂移滥权：错误授予 admin/guardian/break-glass，执行 pause 绕过或非法转移。
- [ ] P0-4 资金入口旁路：通过未收敛入口或内部函数暴露，绕过 SSOT 账本约束。
- [ ] P0-5 Oracle/价格操纵联动清算：操纵价格窗口触发异常清算或错误结算。
- [ ] P1-1 前端地址/ABI 污染：把用户交易导向错误合约或错误参数编码导致资产损失。
- [ ] P1-2 Keeper 身份冒用：仿冒 keeper 调用高权限流程（清算、回收、修复）。
- [ ] P1-3 跨链/链切换错误：错误 chainId 或 provider 导致在错误网络执行高价值交易。
- [ ] P2-1 监控静默：告警链路失效导致攻击长时间未发现。
- [ ] P2-2 事件收敛污染：索引或聚合错乱导致风险判断失真，放大后续损失。

### 2.2 每条路径必须具备

- [ ] 攻击前置条件。
- [ ] 可利用窗口与检测信号。
- [ ] 资金影响上限估算。
- [ ] 立即止血动作与恢复动作。
- [ ] 对应测试用例或演练编号。

### 2.3 攻击建模验收

- [ ] 形成攻击树（Attack Tree）并纳入版本管理。
- [ ] 红队/审计意见已映射到具体修复项。
- [ ] 所有 P0/P1 攻击路径均已绑定检测与响应动作。

---

## Step 3：工程化落地（DevSecOps Engineer）

目标：把所有“必须”转化为 CLI、CI、infra 三类可执行控制。

### 3.1 CLI 命令（必须可在发布前执行）

- [ ] `pnpm -s run compile`：编译与类型产物一致性检查。
- [ ] `pnpm -s run test:live:release-gates:bnb-testnet:strict:stream`：严格发布门禁。
- [ ] `pnpm -s run test:live:reward-baseline:bnb-testnet`：奖励基线与回收路径门禁。
- [ ] `pnpm exec hardhat run --network <network> scripts/tests/live-test/networks/<network>/live-reward-penalty-recycle-recovery.ts`：处罚/回收恢复路径验证。
- [ ] `pnpm exec tsx scripts/check-deployment.ts --network <network>`：部署与 Registry 绑定核对。
- [ ] `pnpm exec tsx scripts/check-pv-modules.ts --network <network>`：关键视图模块绑定核对。
- [ ] `pnpm exec tsx scripts/check-bnb-balances.ts`：运行账户与关键资金地址余额基线核对。

### 3.1.A 测试命令分层（防误用强约束）

- [ ] 已拆分并启用五个明确入口：`test:fast`、`test:real-db-core`、`test:critical-path`、`test:integration`、`test:invariant`。
- [ ] 每个入口均声明并由守卫脚本校验：`REQUIRE_REAL_POSTGRES`、`USE_PG_MEM` 是否允许、绑定的 jest config。
- [ ] `test:critical-path` 下若检测到 `USE_PG_MEM=1` 直接失败。
- [ ] `test:critical-path`、`test:real-db-core`、`test:integration`、`test:invariant` 下若 `DATABASE_URL` 缺失直接失败。
- [ ] 旧入口 `test:unit` 已改为“硬失败 + 迁移提示”，禁止继续混用 pg-mem 与真实数据库。
- [ ] CI 已加入“禁止调用 test:unit”的阻断检查。

### 3.2 CI 配置（必须阻断）

- [ ] PR 阶段阻断：编译失败、关键测试失败、关键脚本失败立即阻断。
- [ ] 发布前阻断：release-gates 失败、Registry key 缺失、ModuleKeys 产物漂移即阻断。
- [ ] 产物一致性阻断：ABI、TypeChain、moduleKeys、部署地址快照必须同批次生成。
- [ ] 安全基线阻断：检测到高权限角色异常变更且无审批记录时阻断。
- [ ] 测试分层阻断：若关键路径命令未使用对应 jest config 或数据库约束不符，直接阻断。

### 3.3 infra 结构（必须常驻）

- [ ] 多 RPC 池：主/备/隔离池与自动降级策略。
- [ ] 密钥托管：生产签名与 API secret 必须在受控 secret manager。
- [ ] 可观测栈：Prometheus + Alertmanager + Dashboard + 长期日志归档。
- [ ] 发布隔离：prod/stage/test 凭证、告警、任务、数据库严格隔离。
- [ ] 证据归档：每次发布保存命令输出、告警状态、审批记录、回滚包。

---

## Step 4：监控系统设计（Detection Engineer）

目标：提供可执行的 metrics schema、alert rules、dashboard 结构。

### 4.1 Metrics Schema（核心字段）

- [ ] 交易执行：`network`、`module`、`entrypoint`、`sender`、`txHash`、`status`、`revertSelector`、`latencyMs`。
- [ ] 治理变更：`action`、`target`、`oldValue`、`newValue`、`executor`、`timelockId`。
- [ ] 权限变更：`role`、`account`、`grantor`、`txHash`。
- [ ] 资金异动：`vault`、`asset`、`delta`、`reason`、`correlationId`。
- [ ] 收敛状态：`onchainSuccess`、`indexed`、`projectionReady`、`driftDetected`。

### 4.2 Alert Rules（最小规则集）

- [ ] P0：未经审批的 upgrade/Registry 重绑/关键角色变更。
- [ ] P0：资金托管地址短时异常净流出超过阈值。
- [ ] P0：连续高风险入口失败且错误模式一致（疑似攻击探测）。
- [ ] P1：Oracle 长时间不可用或偏离阈值。
- [ ] P1：收敛失败率、revert 率、provider 错误率持续升高。
- [ ] P1：配置漂移（地址、ABI、ModuleKeys、ActionKeys）持续存在。

### 4.3 Dashboard 结构

- [ ] D1 安全总览：P0/P1 告警、风险趋势、值班态。
- [ ] D2 资金托管：按资金域展示净流入/流出、异常点、可追踪 tx。
- [ ] D3 治理与权限：升级、Registry、角色变化时间线。
- [ ] D4 执行质量：成功率、确认时延、revert 分类、RPC 健康。
- [ ] D5 收敛健康：链上成功 vs 索引收敛 vs 读模型一致性。

---

## Step 5：事故演练系统（Incident Commander）

目标：输出 runbook、响应流程图、权限调用路径并完成演练。

### 5.1 Runbook（必须存在并可执行）

- [ ] RB-01 升级权限异常。
- [ ] RB-02 Registry 重绑异常。
- [ ] RB-03 资金异常流出。
- [ ] RB-04 Oracle 异常引发清算风险。
- [ ] RB-05 前端地址污染/ABI 污染。
- [ ] RB-06 监控静默与告警链路故障。

每个 Runbook 必须包含：触发条件、5 分钟动作、30 分钟动作、外部沟通模板、恢复准入条件、复盘模板。

### 5.2 响应流程图（必须固化）

- [ ] 侦测 -> 分级 -> 止血 -> 证据保全 -> 根因定位 -> 恢复 -> 复盘。
- [ ] 每一步均绑定责任角色（IC、SecEng、Protocol、Infra、Comms）。
- [ ] 每一步均有时间目标（SLO）与交接条件。

### 5.3 权限调用路径（必须可审计）

- [ ] 谁可以触发 pause / 局部只读 / keeper 停机。
- [ ] 谁可以执行紧急升级或回滚。
- [ ] 谁可以变更 Registry / ActionKeys / 白名单。
- [ ] 紧急权限的申请、审批、执行、撤销必须全链路留痕。

---

## 最终验收结论

- [ ] 所有 Step 的“必须项”已完成并有证据。
- [ ] 所有 P0/P1 攻击路径均有检测与响应映射。
- [ ] 若存在例外，已记录风险接受人、缓解计划与最晚关闭时间。
- [ ] 给出明确结论：允许灰度 / 允许全量 / 阻断发布。
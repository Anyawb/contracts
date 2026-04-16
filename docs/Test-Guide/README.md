# 测试指南总入口

## 概述

本目录不再只是测试文档索引，也作为合约升级、部署对齐、fork 验证、live gate 验证的统一入口。

当协议合约发生任何变更，尤其是以下类型变更时，必须把本文件作为第一入口重新执行完整流程：

1. 可升级代理实现变更。
2. Registry 路由变更。
3. 新增或替换模块 key。
4. View / DataPush / schemaVersion 变更。
5. 前端消费的地址表、模块键、错误码、网络配置变更。
6. fork / live 使用的 deploy output、mock asset pack、frontend network config 变更。

核心原则只有一句：

1. 先确认升级和部署一致性，再跑 fork，再跑 live。

对应的严格要求见 [pre-launch-comprehensive-testing-requirements.md](pre-launch-comprehensive-testing-requirements.md)。

如果当前变更重点是资产设计、风险管理、strict valuation、liquidation shortfall，而不是 blocks-only，请直接配合阅读 [asset-risk-management-testing-guide.md](asset-risk-management-testing-guide.md)。该文件把 requirement ID、localhost E2E、fork、live 入口和当前缺口放在了一张可执行矩阵里。

如涉及 blocks-only 状态与收尾语义，统一词典以 [pre-launch-comprehensive-testing-requirements.md](pre-launch-comprehensive-testing-requirements.md) 第 5 章 Gate 9 的“词典约束（blocks-only）”为准：主术语统一为“交易收尾（trade closeout）/到期收尾（maturity closeout）/到期交付收尾（maturity delivery closeout）”，“交割收尾”仅作同义注释。

## 先看哪份事实源

升级后最容易出错的不是单个合约逻辑，而是多份地址源、不同消费者、不同脚本入口之间的漂移。

当前仓库里，必须按下面优先级理解“哪份配置才算真相”：

1. 链上 Registry 路由。
2. 当前网络 deploy output。
3. live / fork profile 指向的地址文件。
4. 前端网络配置。
5. 其他历史产物、临时脚本输出、人工复制文件。

以 BNB Testnet 为例：

1. live / fork 默认读取 [scripts/config/profiles/live.ts](scripts/config/profiles/live.ts#L13) 中的 `scripts/deployments/bnb-testnet/core.json`。
2. 地址解析器会优先吃 `DEPLOY_OUTPUT_FILE` 或网络对应部署文件，见 [scripts/tests/_addressResolver.ts](scripts/tests/_addressResolver.ts#L82)。
3. 前端网络配置 [frontend-config/networks/bnb-testnet.ts](frontend-config/networks/bnb-testnet.ts) 不是 live 的唯一事实源，必须和 deploy output 对齐后才可信。

如果这些来源不一致，结论按下面规则处理：

1. 链上 Registry 和 deploy output 一致，但前端配置不同：视为前端配置过期。
2. deploy output 与链上 Registry 不一致：视为部署/升级未完成或产物未同步，禁止继续 fork/live 放行。
3. 同一网络存在多个 deploy output 且没有明确当前基线：先定基线，再继续测试。

## 升级后必须同步的内容

每次升级合约后，不能只看 `compile` 通过，也不能只看单测通过。至少要同步下面几类内容。

### 1. 链上与部署产物

1. 代理 implementation 是否已切到目标实现。
2. Registry 路由是否已更新到新模块地址。
3. deploy output 是否写入当前最新地址。
4. manifest / mock-suite / mock asset pack 是否仍可被后续脚本消费。

BNB 相关关键文件：

1. [scripts/deployments/bnb-testnet/core.json](scripts/deployments/bnb-testnet/core.json)
2. [scripts/deployments/bnb-testnet/manifest.json](scripts/deployments/bnb-testnet/manifest.json)
3. [scripts/deployments/bnb-testnet/mock-suite.json](scripts/deployments/bnb-testnet/mock-suite.json)
4. [deployments/assets.bnb-testnet.mock.json](deployments/assets.bnb-testnet.mock.json)
5. [deployments/mock-assets.bnb-testnet.json](deployments/mock-assets.bnb-testnet.json)

### 2. 前端与消费侧配置

1. 前端网络地址表。
2. frontend module keys。
3. contract errors / ABI / 生成物。
4. 任何依赖 Registry key 的后端、脚本、观测工具。

当前常见文件：

1. [frontend-config/networks/bnb-testnet.ts](frontend-config/networks/bnb-testnet.ts)
2. [frontend-config/moduleKeys.ts](frontend-config/moduleKeys.ts)
3. [frontend-config/contractErrors.ts](frontend-config/contractErrors.ts)

### 3. 测试与运行时前置

1. live/fork profile 是否指向正确 deploy output。
2. relayer / updater / viewer / borrower / lender 是否具备运行所需角色。
3. 资产白名单、预言机配置、FeeRouter token 支持是否齐全。
4. mock asset pack 和 settlement token 选择是否仍与当前部署一致。

### 4. 文档与操作入口

1. 部署 README。
2. 测试总入口。
3. 特定产品或专项 gate 的运行文档。
4. 升级步骤与回滚步骤。

## 升级后必须注意的事项

### A. 不要默认认为“部署成功 = 升级完成”

部署脚本跑完，只能说明有链上写操作成功，不代表以下内容已经自动完成：

1. 所有 Registry key 都已改到新地址。
2. 所有前端配置都已同步。
3. 所有 live / fork profile 都在使用最新地址。
4. 所有代理 implementation 都与本地编译产物一致。

### B. 不要把前端配置当成唯一真相

前端网络配置可能滞后于 deploy output。遇到冲突时，先查链上 Registry，再查当前 deploy output。

### C. 不要在地址漂移时继续跑 gate 结论

出现以下任一情况，应先停下修复，不要继续把 fork/live 失败归因为协议逻辑：

1. Registry 地址与 frontend network config 不同。
2. deploy output 与链上 getModule 返回值不同。
3. implementation bytecode hash 与本地产物不匹配。
4. mock-suite / manifest 为空、缺字段或无法被脚本消费。

### D. 角色问题和部署问题要分开判断

live gate 失败常见有两类：

1. 部署/路由不一致。
2. relayer、updater、业务模块缺角色。

例如 gate 9 blocks-only funds-chain，即使核心地址正确，也会因为 relayer 缺 `DEPOSIT` 或 `ACTION_VIEW_PUSH` 而在环境检查阶段直接失败。这类失败不能直接归为“合约升级坏了”，但也说明升级后的运行配套未完成。

### E. fork 失败未必等于合约失败

如果 fork 报 `missing trie node`、`not supported`、`timeout` 之类错误，应优先归类为 RPC / 节点基础设施问题。只有在 deploy output、Registry、implementation 都对齐后，fork 业务断言失败才有资格被当成协议问题排查。

## 升级后需要配合的事项

合约升级不是单人动作，至少需要下面几类配合同时完成。

### 协议研发

1. 确认本次变更影响到哪些代理、模块、Registry key、View、事件、DataPush。
2. 说明是否涉及新增 initializer / reinitializer。
3. 说明是否允许 rollback，若不允许必须写明阻断机制。

### 部署负责人

1. 产出本次升级后的 deploy output。
2. 对账链上 Registry 与 deploy output。
3. 对账 implementation slot 与本地编译产物。
4. 保留日志、交易 hash、时间戳目录。

### 前端 / 集成方

1. 同步最新网络地址表。
2. 同步 module keys、错误码、ABI、schemaVersion。
3. 确认前端调用路径、轮询字段、状态机假设没有沿用旧语义。

### QA / 测试

1. 先执行构建层、单测层、集成层。
2. 再执行 fork 对齐。
3. 最后按 Layer-A / Layer-B 执行 live gate。

### 安全 / 发布

1. 复核 upgrade 权限、timelock、多签或治理门禁。
2. 复核升级失败路径和回滚路径。
3. 复核最终放行证据目录。

## 推荐执行顺序

### 第 0 步：静态与构建

```bash
pnpm -s run compile
pnpm -s run typecheck
pnpm -s run e2e:typecheck
pnpm -s test
```

### 第 1 步：部署前置检查

```bash
pnpm -s run deploy:preflight:bnb-testnet
```

用途：确认 BNB 网络入口、部署文件、fork/live 入口、前端网络文件、mock asset pack 文件链条都存在且可被消费。

### 第 2 步：执行升级或重新部署

```bash
pnpm -s run deploy:bnb-testnet
```

如本次需要刷新 mock 资产包：

```bash
pnpm -s run deploy:mock-assets:bnb-testnet
```

### 第 3 步：部署后一致性检查

最低要做以下检查：

1. Registry route 对 deploy output。
2. implementation slot 对本地 artifact。
3. frontend network config 对 deploy output。
4. live/fork profile 是否仍指向当前输出。

建议命令：

```bash
pnpm -s run debug:audit-order-engine-deployment-consistency:bnb-testnet
```

如怀疑 Registry 路由没同步，可结合：

1. [scripts/debug/check-live-registry-keys.ts](../../scripts/debug/check-live-registry-keys.ts)
2. [scripts/tools/repair-registry-from-deploy-output.ts](../../scripts/tools/repair-registry-from-deploy-output.ts)

### 第 4 步：修复运行时角色与治理配套

必须确认：

1. relayer 是否有 `VIEW_PRICE_DATA`、`DEPOSIT`、`VIEW_SYSTEM_DATA`、`ACTION_VIEW_PUSH`。
2. updater 是否有 `UPDATE_PRICE`。
3. 业务模块是否具备执行路径需要的角色。

严格模式下，如果这些角色缺失，live gate 会在业务断言前直接失败。

### 第 5 步：fork 对齐

```bash
pnpm -s run test:live:release-gates:fork:bnb-testnet
```

前提：

1. deploy output 与 Registry 已一致。
2. 使用的 BNB RPC 节点支持 fork。

如果 fork 因上游节点失败，不得直接得出协议失败结论，但也不得跳过部署一致性检查。

### 第 6 步：live Layer-A

```bash
pnpm -s run test:live:release-gates:bnb-testnet:layer-a
```

要求：

1. Gate 1 到 Gate 9 全部通过。
2. Gate 9 稳定后，再进入 Gate 10。

### 第 7 步：live Gate 10 / Layer-B / 专项门

按上线前要求文档继续执行专项门、架构一致性门和证据归档。

## 自动化是否可行

可以，而且应该尽量自动化；但必须区分“能自动触发”与“能自动证明正确”。

### 可以自动化的部分

1. compile / typecheck / test。
2. deploy preflight。
3. 部署脚本执行。
4. deploy output 与 frontend config 的差异检查。
5. Registry route 与 deploy output 的差异检查。
6. implementation hash 与本地 artifact 的一致性检查。
7. module keys、contract errors、ABI 生成。
8. fork/live 运行前环境快照和日志目录创建。

### 不能只靠“自动化成功”就放行的部分

1. 上游 RPC 是否健康。
2. timelock / governance / rollback 风险是否可接受。
3. Layer-B 架构专项门是否需要风险签字。
4. live shared-state 噪声是否已被正确解释。

### 当前仓库的自动化现状

当前已经具备部分自动化基础：

1. [scripts/deploy/deploy-preflight.ts](../../scripts/deploy/deploy-preflight.ts)
2. [scripts/config/profiles/live.ts](../../scripts/config/profiles/live.ts)
3. [scripts/tests/_addressResolver.ts](../../scripts/tests/_addressResolver.ts)
4. [scripts/debug/audit-order-engine-deployment-consistency.ts](../../scripts/debug/audit-order-engine-deployment-consistency.ts)
5. [scripts/tests/tools/run-single-live-with-sweep.sh](../../scripts/tests/tools/run-single-live-with-sweep.sh)

但当前仍存在需要修补的自动化缺口：

1. `frontend-config/networks/*.ts` 不保证总是和最新 deploy output 自动同步。
2. `mock-suite.json`、`manifest.json` 可能不完整，无法作为统一事实源。
3. 缺少一个统一的“升级后全量同步脚本”，自动刷新 deploy output、frontend config、module keys、errors、ABI，并立即做差异审计。
4. 缺少一个统一的“升级后验收脚本”，把 compile、typecheck、deploy audit、fork、gate 9、gate 10 串成单一流水线。

## 推荐新增的自动化目标

建议后续把以下能力做成一条命令：

```bash
pnpm -s run release:sync-and-verify:bnb-testnet
```

这条流水线应该自动做：

1. 编译与类型检查。
2. 执行升级/部署。
3. 更新 core.json / manifest.json / mock-suite.json。
4. 重新生成 frontend-config/networks/bnb-testnet.ts。
5. 重新生成 module keys、contract errors、必要 ABI。
6. 对账 Registry route 与 deploy output。
7. 对账 implementation hash 与本地 artifact。
8. 对账 frontend config 与 deploy output。
9. 校验关键角色是否齐全。
10. 跑 fork 预检。
11. 跑 live gate 9。
12. gate 9 稳定后再跑 gate 10。
13. 生成统一证据目录。

## 升级后放行前必须回答的 12 个问题

1. 本次变更涉及哪些代理或模块？
2. 是否新增或替换了 Registry key？
3. 链上 implementation 是否与本地 artifact 一致？
4. deploy output 是否与链上 Registry 一致？
5. frontend network config 是否与 deploy output 一致？
6. module keys、ABI、错误码是否已同步生成？
7. mock asset pack 和 settlement token 是否仍匹配？
8. relayer / updater / 模块角色是否齐全？
9. fork 是否在正确 deploy output 上运行？
10. gate 9 是否已稳定通过？
11. gate 10 是否在 gate 9 通过后再执行？
12. 是否已保留完整证据和日志目录？

## 相关文档

1. [pre-launch-comprehensive-testing-requirements.md](pre-launch-comprehensive-testing-requirements.md)
2. [asset-risk-management-testing-guide.md](asset-risk-management-testing-guide.md)
3. [release-acceptance-standard.md](release-acceptance-standard.md)
4. [scripts/deploy/README.md](../../scripts/deploy/README.md)
5. [test-file-standards.md](../test-file-standards.md)
6. [Architecture-Guide.md](../Architecture-Guide.md)

## 结论

每次升级合约后，理论上可以让相关文件和前端尽量自动跟着升级，但前提是把“生成”和“审计”一起自动化。

只自动生成而不自动审计，会产生新的漂移。

因此推荐的目标不是“升级后自动改一堆文件”，而是：

1. 升级后自动刷新所有相关产物。
2. 自动对账链上、deploy output、frontend config、module keys。
3. 自动执行 fork 和 live 的分层 gate。
4. 任一关键差异直接阻断。

只有这样，升级后的一整套配套文件、前端配置和测试结论才真正可信。

---

最后更新：2026年4月13日

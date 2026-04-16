# 智能合约上线前全面测试要求

## 1. 目的

本文件用于定义智能合约上线前必须满足的测试要求，目标是同时满足：

1. 严格性：关键业务路径和安全约束必须被强阻断校验。
2. 准确性：避免把 live 共享状态噪声误判为协议缺陷。
3. 可审计：所有结论必须有日志、摘要、环境快照可复核。

## 2. 适用范围

覆盖：

1. 协议核心模块与跨模块资金链路。
2. 注册表路由、权限角色、升级一致性。
3. live 运行期的写路径与关键观测链路。

不覆盖：

1. 纯前端视觉或交互问题。
2. 与上线无关的实验脚本。

## 3. 质量原则

任何单一测试层都不能证明“合约完全正确”。

上线通过必须同时满足：

1. 静态与构建层通过。
2. 单元与模块层通过。
3. 性质与不变量层通过。
4. 集成与端到端层通过。
5. Fork 对齐层通过。
6. Live strict gate 通过。
7. 安全审查层通过。
8. 升级与部署一致性层通过。

## 4. Gate 分层设计（重点）

为同时保证严格与准确，live gate 必须分层执行。

### 4.1 Layer-A：Correctness Strict（默认放行门）

定义：

1. 以“协议正确性不变量”为阻断条件。
2. 允许已知、可解释的路径差异。
3. 严禁未知路径、未知状态迁移、未知资金变化。

目的：

1. 避免因为共享 testnet 状态导致误报。
2. 仍保持对真实协议错误的高敏感度。

### 4.2 Layer-B：Architecture Strict（专项一致性门）

定义：

1. 强制架构口径，但只验证“目标架构是否被实现”，不把共享 live 噪声直接当作协议错误。
2. 使用独立的 architecture suite；每项 gate 对应专门的架构脚本，而不是简单重跑 Layer-A。
3. 在隔离账户、隔离状态、可控前置条件下执行；需要硬前置条件的 gate 由专项脚本显式声明。

目的：

1. 验证实现是否严格遵循目标架构语义、治理边界和 registry/view 契约。
2. 把“架构一致性”与“业务正确性”分开留痕，避免 Layer-A 与 Layer-B 互相污染结论。

### 4.3 为什么要分层

如果把“路径唯一性”直接放进默认 gate，可能出现：

1. 协议行为正确但被误判失败。
2. 团队对 gate 失去信任，导致门禁价值下降。

分层后：

1. Layer-A 负责上线可运行正确性。
2. Layer-B 负责架构强一致性。

## 5. 十项 Gate 的分层要求

当前十项 gate：

1. platform full baseline
2. fee full baseline
3. reward full baseline
4. guarantee full baseline
5. reserve cancel restore
6. withdraw collateral
7. lending engine view ssot
8. legacy liquidation funds-chain
9. blocks-only 收尾链路
10. ops extension modules

建议分层矩阵：

| Gate | Layer-A（默认放行） | Layer-B（专项一致性） |
| --- | --- | --- |
| 1 Platform | 关键状态迁移、资金守恒、权限正确 | registry 写路由与核心模块绑定不可漂移 |
| 2 Fee | 分账守恒、费用去向正确、publish-ready 严格 | fee config 治理写入的 caller gate、view cache、系统参数一致性 |
| 3 Reward | 计提/惩罚/回收链路正确、无越权 | reward config 治理写入的 caller gate、版本形态、缓存一致性 |
| 4 Guarantee | 担保生命周期与边界分支正确 | guarantee 事件/数据推送与释放、没收语义一致 |
| 5 Reserve/Cancel | 已知合法终态集合内严格校验，未知终态阻断 | reserve 阶段要求 transfer-strict；cancel 阶段仅允许文档化终态集合，未知终态阻断 |
| 6 Withdraw | 提现权限、余额变化、账本一致 | 提现边界、风控前置条件与失败路径一致性 |
| 7 LendingView SSOT | 写后读一致、关键字段不漂移 | facade / view 契约兼容性与字段稳定性 |
| 8 Legacy Liquidation | 清算执行、分配、债务收敛正确 | liquidation registry 绑定、模块前置条件与清算路由一致性 |
| 9 Blocks-Only | term/状态机/DataPush 严格校验 | pre-maturity proof、产品固定约束与收尾架构边界强一致校验 |
| 10 Ops Extension | 未授权必须失败、门禁必须生效 | 动态模块、governance guardian、运维职责边界一致性 |

当前 BNB Testnet 的 Layer-B 不再是单独的 reserve gate，而是独立的十步 architecture suite。建议按下表理解当前实现：

| Gate | Layer-B 当前脚本 | 目的 |
| --- | --- | --- |
| 1 | `live-view-registry-routes.ts` | 校验 platform 核心 registry 路由与模块绑定 |
| 2 | `live-fee-config-governance.ts` | 校验 fee 治理 caller gate、idempotent 写入与 FeeRouterView 对齐 |
| 3 | `live-reward-config-governance.ts` | 校验 reward 治理 caller gate、配置形态与 RewardView 对齐 |
| 4 | `live-guarantee-events-datapush.ts` | 校验 guarantee 的事件、数据推送与释放/没收语义 |
| 5 | `live-cancel-reserve.ts` | 校验 reserve transfer 架构；在 transfer-strict 模式下要求隔离前置条件 |
| 6 | `live-withdraw-collateral.ts` | 校验 withdraw 边界和风控一致性 |
| 7 | `live-view-facade-gate.ts` | 校验 facade/view 读模型契约兼容性 |
| 8 | `live-liquidation-registry-preflight.ts` | 校验 liquidation registry 绑定与执行前置条件 |
| 9 | `live-blocks-only-liquidation.ts` | 校验 blocks-only pre-maturity 收尾边界与固定产品约束 |
| 10 | `live-ops-extension-modules.ts` | 校验 ops 扩展模块与治理边界 |

Blocks-Only 补充口径（pre-maturity guard）：

词典约束（blocks-only）：

1. `trade closeout` 统一称“交易收尾（trade closeout）”。
2. `settleOrLiquidateBlocks(...)` 统一称“到期收尾入口（maturity closeout，ABI 历史命名保留）”。
3. maturity 且 `remainingDebt > 0` 的分支统一称“到期交付收尾（maturity delivery closeout）”，不再写成“清算完成”。
4. “交割收尾”仅允许作为“到期交付收尾（maturity delivery closeout）”的同义注释，不作为主术语。
5. `SETTLED`（兼容状态）在 blocks-only 兼容回退中必须按真实到期收尾结果区分：debt-free maturity closeout 解释为 borrower-return，maturity delivery closeout 解释为 lender-delivery。
6. `TRADE_CLOSED`（兼容状态）在 blocks-only 兼容回退中统一解释为“交易收尾（trade closeout）”。

命名约束（blocks-only 专项 case ID）：

1. 涉及 maturity 竞态或终态一致性的 case，统一包含 `maturity_closeout`。
2. 涉及 maturity 且 `remainingDebt > 0` 的 case，统一包含 `maturity_delivery_closeout`。
3. 涉及兼容回退的 case，统一包含 `legacy_fallback`，并显式覆盖 debt-free maturity closeout 与 maturity delivery closeout 双分支。

1. Layer-A 允许在共享 testnet 出块过快导致“finalize 后已成熟”时记录 `notice` 并跳过 pre-maturity guard 断言，但成熟后状态机与对齐断言必须继续严格通过。
2. Layer-B 必须对 pre-maturity guard 使用硬失败策略；当无法验证 pre-maturity guard 时直接 FAIL。
3. 运行开关：`LIVE_STRICT_BLOCKS_ONLY_PREMATURITY=0`（Layer-A）与 `LIVE_STRICT_BLOCKS_ONLY_PREMATURITY=1`（Layer-B）。

## 6. 各测试层最低通过标准

### 6.1 静态与构建

1. 编译、lint、类型检查全通过。
2. 发布脚本无类型错误。

### 6.2 单元与模块

1. 每个入口至少覆盖成功路径与回滚路径。
2. 权限、边界值、事件与状态必须有断言。

### 6.3 性质与不变量

1. 资金守恒、债务一致性、权限不可绕过等不变量必须通过。
2. 固定种子与随机种子至少各一轮。

### 6.4 集成与端到端

1. 核心业务链路必须完整走通。
2. 多角色并发场景必须有覆盖。

### 6.5 Fork 与部署对齐

1. Registry 与模块地址对齐无漂移。
2. 发现错配必须先修复再重跑。

### 6.6 Live strict gate

1. Layer-A 必须全 PASS 才可放行。
2. Layer-B 作为架构专项门，失败不自动放行，需要明确风险处理。
3. 对 blocks-only pre-maturity guard，Layer-A 允许 `notice+skip`，Layer-B 必须硬失败。

### 6.7 安全审查

1. 无未处理的 Critical/High 问题。
2. Medium 必须有处理计划与责任人。

### 6.8 升级与部署安全

1. 存储布局兼容。
2. 代理与实现路由正确。
3. 升级演练通过。

#### 6.8.1 升级失败路径测试

目标：

1. 验证升级在失败路径上会安全失败，而不是留下半升级、错路由或未初始化状态。
2. 验证部署脚本、升级脚本、proxy 管理流程不会把错误实现推到线上。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 |
| --- | --- | --- | --- |
| UPG-FAIL-01 | storage layout 冲突 | 将代理从旧实现升级到故意改变关键槽位顺序/类型的新实现 | 升级必须在升级前检查或升级时直接失败；若失败后 proxy 仍可用，则旧状态必须保持不变 |
| UPG-FAIL-02 | initializer 未调用 | 升级到需要新增 reinitializer/initializer 步骤的实现，但故意不执行初始化调用 | 新增状态变量不得处于危险默认值而继续放行业务；缺失初始化必须被测试识别并判定 FAIL |
| UPG-FAIL-03 | proxy 指向错误实现 | 将 proxy 指向错误模块、零代码地址、错误版本实现或不兼容实现 | 调用必须失败或被升级授权逻辑阻断；不得静默进入错误实现继续提供业务功能 |
| UPG-FAIL-04 | deployment artifact / registry 漂移 | 升级后读取 proxy implementation slot、registry 路由、view version | 链上 implementation、脚本产物、registry/module route 三者必须一致，否则 FAIL |

执行要求：

1. 对 UUPS/Transparent/ERC1967 proxy，必须同时校验链上 implementation slot 与业务路由地址。
2. 对新增初始化步骤，必须分别测试“正确调用初始化”和“漏调初始化”两条路径。
3. 对每次失败路径测试，都必须验证失败后旧实现的可读状态、核心余额、权限配置未被破坏。

#### 6.8.2 Rollback 测试

目标：

1. 验证升级后回滚是否安全，不会因布局漂移、状态迁移或版本门禁导致系统不可恢复。
2. 验证回滚后关键业务状态、治理状态和权限状态仍可继续工作。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 |
| --- | --- | --- | --- |
| UPG-RB-01 | 升级后回滚到前一实现 | 执行 v1 -> v2 -> v1 rollback | 回滚后关键状态可读、关键业务入口可用、未出现 storage 污染 |
| UPG-RB-02 | 升级后写入新状态再回滚 | 在 v2 写入新增字段/执行新逻辑后回滚到 v1 | v1 不得因未知状态而卡死、错读或错误放权；如设计上不支持回滚，测试必须明确阻断 |
| UPG-RB-03 | 升级失败后的恢复 | 故意进行一次失败升级，再执行恢复到已知安全实现 | 恢复后 implementation、admin、registry route、核心业务状态必须回到安全可用状态 |

执行要求：

1. rollback 不是可选演示，而是必须验证的恢复路径。
2. 若某模块声明“不可回滚”，必须通过测试证明回滚会被显式阻断，而不是依赖人工记忆避免操作。
3. rollback 后至少复跑一条核心业务链路，不能只检查 slot 值。

#### 6.8.3 权限滥用测试

目标：

1. 验证 upgrade 权限不会被普通管理员、错误角色、脚本账户或模块账户误用。
2. 验证 timelock、多签、治理门禁不会被绕过。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 |
| --- | --- | --- | --- |
| UPG-AUTH-01 | upgrade 权限被误用 | 用非 upgrade admin、普通 owner、业务 operator、模块合约尝试升级 | 所有未授权调用必须失败，且不得改变 implementation 或 admin 状态 |
| UPG-AUTH-02 | timelock 绕过 | 绕过排队、缩短 delay、伪造执行者或直接调用 upgrade 入口 | 必须失败；timelock 队列、eta、执行权限不可被伪造或跳过 |
| UPG-AUTH-03 | 升级权限与业务权限串扰 | 持有业务高权限但不持有 upgrade 权限的账户执行升级相关操作 | 不得因角色混淆获得升级能力 |
| UPG-AUTH-04 | 错误实现借 upgradeToAndCall 放权 | 使用带恶意初始化 payload 的实现执行 upgradeToAndCall | 即使升级入口成功，也不得越权改写 admin、timelock、核心治理角色 |

执行要求：

1. 任何 `_authorizeUpgrade`、ProxyAdmin、TimelockController、GovernanceGate 或自定义治理门必须分别单测与集成测试。
2. 必须覆盖直接调用、delegatecall 路径、脚本账户调用、治理账户调用、多签/时锁执行调用。
3. 必须记录升级前后 admin、pendingAdmin、owner、role holder、timelock queue 的完整快照。

#### 6.8.4 上线阻断 Gate

以下升级与部署安全测试属于上线阻断 gate，任一 FAIL 即 No-Go：

1. UPG-FAIL-01 storage layout 冲突测试。
2. UPG-FAIL-02 initializer 未调用测试。
3. UPG-FAIL-03 proxy 指向错误实现测试。
4. UPG-RB-01 升级后标准回滚测试。
5. UPG-RB-03 升级失败后的恢复测试。
6. UPG-AUTH-01 upgrade 权限误用测试。
7. UPG-AUTH-02 timelock 绕过测试。

以下属于高风险但可按模块裁剪的专项 gate；若模块可升级且存在对应机制，则同样必须 PASS：

1. UPG-RB-02 升级后写入新状态再回滚。
2. UPG-AUTH-03 升级权限与业务权限串扰。
3. UPG-AUTH-04 恶意 upgradeToAndCall 放权。

直接 No-Go 条件：

1. 升级失败后 proxy 仍指向错误实现且未被检测。
2. 任一可升级模块存在漏初始化后仍可进入业务路径的情况。
3. 任一未授权账户可触发升级、替换实现、缩短 timelock 或绕过 timelock。
4. 回滚后关键状态不可读、关键业务路径不可恢复或 admin/role 状态被污染。

## 7. 证据与留痕要求

必须留存：

1. 每步日志。
2. 总结摘要（PASS/FAIL、退出码、时间戳）。
3. 环境变量快照。
4. 部署审计与地址对账输出。

要求：

1. 使用时间戳目录。
2. 结果不可覆盖。
3. 可供工程、安全、QA 联合复核。

## 8. 放行规则（Go/No-Go）

只有同时满足以下条件才可 GO：

1. 必选测试层全部通过。
2. Layer-A 十项 gate 全部通过。
3. 无未处理 Critical/High 安全问题。
4. 无未处理部署错配。
5. 升级与部署安全阻断 gate 全部通过。
6. 证据完整且签字完成。

任一条件不满足即 No-Go。

## 9. 签字与责任

至少需要以下角色签字：

1. 协议研发负责人。
2. 安全负责人。
3. 测试负责人。
4. 发布负责人。

签字必须关联：

1. 证据目录。
2. 提交版本。
3. 环境与网络。
4. 已接受残余风险（如有）。

## 10. 上线前执行清单

1. 构建、lint、类型检查通过。
2. 单元与模块测试通过。
3. 不变量测试通过。
4. 集成与端到端通过。
5. Fork 与部署对齐通过。
6. Layer-A 十项 gate 通过。
7. 升级与部署安全阻断 gate 通过。
8. Layer-B 架构专项门完成并留痕。
9. 安全问题清零到可接受状态。
10. 证据归档并完成复核。
11. 正式签字完成。

## 11. 执行模板脚本清单（可直接复制）

以下模板以 BNB Testnet 为例，团队可直接执行。

### 11.1 Layer-A（Correctness Strict）

用途：默认放行门，验证十项 gate 的协议正确性。

```bash
pnpm -s run test:live:release-gates:bnb-testnet:layer-a
```

流式留痕版本：

```bash
pnpm -s run test:live:release-gates:bnb-testnet:layer-a:stream
```

### 11.2 Layer-B（Architecture Strict）

用途：架构专项门，执行独立的十步 architecture suite，覆盖 registry route、fee/reward governance、guarantee datapush、reserve 架构、withdraw 边界、view 契约、liquidation preflight、blocks-only pre-maturity 收尾、ops governance boundary。

执行口径：

1. Layer-B 不是重跑 Layer-A，而是跑独立的专项脚本集合。
2. `reserve cancel restore` 在 Layer-B 中只对 reserve 阶段执行 transfer-strict；cancel 阶段仍必须落在文档化合法终态集合内，未知终态直接 FAIL。
3. `blocks-only` 在 Layer-B 中继续使用 pre-maturity 硬失败策略。
4. Layer-B 日志目录写 `checkpoint.json`，允许次日按 `LIVE_RELEASE_LOG_DIR` 与 `LIVE_RELEASE_RESUME_ON_RETRY=1` 续跑未完成步骤。

```bash
pnpm -s run test:live:release-gates:bnb-testnet:layer-b
```

流式留痕版本：

```bash
pnpm -s run test:live:release-gates:bnb-testnet:layer-b:stream
```

如需从已有证据目录续跑：

```bash
LIVE_RELEASE_LOG_DIR=scripts/tests/logs/<existing-layer-b-dir> \
LIVE_RELEASE_RESUME_ON_RETRY=1 \
pnpm -s run test:live:release-gates:bnb-testnet:layer-b
```

### 11.3 兼容命令映射

为兼容历史流程，以下命令已映射到 Layer-A：

```bash
pnpm -s run test:live:release-gates:bnb-testnet:strict
pnpm -s run test:live:release-gates:bnb-testnet:strict:stream
```

### 11.4 单命令串联执行（先 Layer-A 再 Layer-B）

默认串联命令：

```bash
pnpm -s run test:live:release-gates:bnb-testnet:layered
```

该命令会：

1. 先执行 Layer-A 流式门禁。
2. 再执行 Layer-B 流式门禁。
3. 自动生成总证据目录，并写入双层子证据路径与汇总状态。

可选参数：

```bash
# 当 Layer-A 失败时仍继续执行 Layer-B（默认 0）
ALLOW_LAYER_B_ON_LAYER_A_FAIL=1 pnpm -s run test:live:release-gates:bnb-testnet:layered
```

### 11.5 执行顺序建议

1. 先执行 Layer-A（作为放行主证据）。
2. 再执行 Layer-B（作为架构专项证据）。
3. 两层证据目录必须分开归档。

## 12. 攻击路径与经济安全测试（Attack & Economic Security Testing）

本章是上线阻断要求，不是研究说明。

要求：

1. 所有攻击测试必须有可重复执行的脚本、固定断言、失败即阻断的 PASS/FAIL 结论。
2. 所有攻击测试至少覆盖 integration 层与 invariant 层中的一个；高优先级攻击必须同时覆盖两层。
3. 不允许以“主网流动性不足”“testnet 不稳定”“需要人工判断经济合理性”作为放行理由。

### 12.1 攻击优先级与阻断等级

| 优先级 | 攻击类别 | 默认阻断等级 | 最低测试层要求 |
| --- | --- | --- | --- |
| P0 | flash loan 攻击 | 必须 PASS | integration + invariant |
| P0 | oracle manipulation | 必须 PASS | integration + invariant |
| P0 | liquidation manipulation | 必须 PASS | integration + invariant |
| P1 | reward farming exploit | 必须 PASS | integration + invariant |
| P1 | fee extraction attack | 必须 PASS | integration + invariant |
| P2 | sandwich / MEV 攻击 | 需完成专项 Gate | integration 必选，invariant 视架构适配 |

### 12.2 Flash Loan 攻击测试

攻击前提：

1. 攻击者可在单笔交易内获得大额临时流动性。
2. 协议关键价格、抵押率、奖励、手续费或清算资格在同一交易内可被即时读取和使用。

攻击路径：

1. 借入大额资产。
2. 在同笔交易内放大仓位、改变池子状态、触发借贷/清算/奖励计算。
3. 套利后归还闪电贷并保留净收益。

可利用点：

1. 以瞬时余额、瞬时价格、瞬时流动性作为结算依据。
2. 关键风控缺少时间窗口、TWAP、最小持有期、跨块确认或快照隔离。
3. 奖励、费用、清算折价在同块内可被放大后立即兑现。

必须设计的测试用例：

| 测试 ID | 层级 | 构造 | 执行动作 | 必须断言 |
| --- | --- | --- | --- | --- |
| FL-INT-01 | integration | 部署 attacker 合约，接入 mock flash lender，准备深流动性交易对 | 单笔交易内执行 borrow -> price impact -> protocol action -> repay | 攻击者净资产增量 <= 允许误差；协议总抵押、总债务、总费用不出现无因漂移 |
| FL-INT-02 | integration | 选择 reward/fee/liquidation 任一即时结算路径 | 单笔交易内重复放大头寸并触发结算 | 不允许在单交易内获得超出正常持仓时长的奖励、折价或返佣 |
| FL-INV-01 | invariant | handler 引入 attacker、lender、keeper 三类 actor 与可变借款规模 | 随机序列执行 flash borrow、deposit、borrow、repay、liquidate、claim | 协议净值非负；坏账不因零持有期套利产生；奖励铸造量与费用累计满足上界 |

### 12.3 Oracle Manipulation 测试

攻击前提：

1. 协议依赖单点价格、低流动性现货价格、可延迟更新缓存或易被推高/打低的预言机读数。
2. 借贷、清算、奖励、费用任一逻辑直接使用该价格。

攻击路径：

1. 在参考市场推高或打低标的价格，或构造陈旧/异常价格输入。
2. 使用异常价格执行 borrow、withdraw、liquidate、claim、mint、redeem。
3. 在价格恢复后保留协议损失或套利收益。

可利用点：

1. 缺少价格新鲜度检查、偏离阈值检查、双源校验、TWAP 或 fallback 限流。
2. 读缓存与写缓存之间存在可利用时差。
3. 价格异常时仍允许关键写操作继续成交。

必须设计的测试用例：

| 测试 ID | 层级 | 构造 | 执行动作 | 必须断言 |
| --- | --- | --- | --- | --- |
| ORA-INT-01 | integration | mock oracle 支持瞬时跳价、陈旧价格、零价、极端偏离价 | 分别在异常价格下执行 borrow、withdraw、liquidate | 关键写路径必须 revert 或降级到安全模式；不得放出超额可借额度 |
| ORA-INT-02 | integration | 双资产市场，一边操纵抵押品价格，一边维持债务资产正常 | 利用高估抵押借出稳定资产，随后恢复价格 | 恢复后系统不出现新增坏账；若存在坏账则测试必须 FAIL |
| ORA-INV-01 | invariant | handler 在任意步可切换 oracle 模式：normal、stale、spike-up、spike-down | 随机执行撮合、借贷、清算、奖励更新 | 任意价格模式下不得突破 collateralization、debt accounting、fee accounting 的核心不变量 |

### 12.4 Liquidation Manipulation 测试

攻击前提：

1. 清算资格、清算折价、可清算数量或清算奖励依赖可被操纵的状态。
2. 攻击者可同时扮演 borrower、keeper、liquidator 或关联账户。

攻击路径：

1. 人为制造临界健康因子、临界 close factor 或临界坏账状态。
2. 通过价格、舍入、最小清算量、角色切换、前后顺序控制，触发异常清算。
3. 获得不应有的折价、重复奖励、过量扣押或绕过应有损失承担。

可利用点：

1. 健康因子边界舍入方向错误。
2. 部分清算与全额清算切换条件不稳。
3. 同一债仓可被重复清算、超额清算或先奖励后回滚。

必须设计的测试用例：

| 测试 ID | 层级 | 构造 | 执行动作 | 必须断言 |
| --- | --- | --- | --- | --- |
| LIQ-INT-01 | integration | 构造健康因子刚好位于阈值上、下、等于阈值三种账户 | 分别执行 liquidate / settle / repay / re-liquidate | 仅真正可清算账户可被清算；不可清算账户必须拒绝 |
| LIQ-INT-02 | integration | 同一 borrower 配置多个 collateral 与多个 liquidator | 连续触发部分清算、重复清算、跨资产清算 | 累计扣押抵押不得超过上限；债务减少量与抵押转移量必须一致 |
| LIQ-INV-01 | invariant | handler 混入价格扰动、奖励更新、repay、liquidate、settle | 长序列随机执行并记录每次清算前后快照 | 不允许出现重复奖励、负债务、负抵押、超额扣押、清算后系统坏账恶化而攻击者获利 |

### 12.5 Reward Farming Exploit 测试

攻击前提：

1. 奖励与时间、仓位规模、行为次数、借款量、匹配量或清算事件相关。
2. 奖励可在低成本循环路径中被重复铸造、重复累计或提前兑现。

攻击路径：

1. 低成本反复执行 deposit/borrow/repay/stake/unstake/claim 或借助多账户切分。
2. 利用最小计量单位、缓存延迟、快照时序、回滚分支、惩罚抵扣缺口获取额外奖励。
3. 通过即时 claim、转移或 recycle 保留收益。

可利用点：

1. 奖励发放与真实风险暴露时间不匹配。
2. 一次业务事件可多次触发 reward update。
3. liquidation penalty、offset、recycle、mint 之间存在记账裂缝。

必须设计的测试用例：

| 测试 ID | 层级 | 构造 | 执行动作 | 必须断言 |
| --- | --- | --- | --- | --- |
| RWD-INT-01 | integration | 单账户最小成本循环脚本，覆盖 deposit -> borrow -> repay -> claim | 连续执行 N 轮，N 至少覆盖边界轮次与高频轮次 | 奖励增量必须与配置模型一致；零净暴露或极短暴露不得产生超额奖励 |
| RWD-INT-02 | integration | 双账户或多账户互相配合，穿插 liquidation penalty、offset、recycle | 制造 earn、penalty、offset、consume 交错路径 | 奖励总发行量、惩罚总回收量、回收后分配量三者必须守恒 |
| RWD-INV-01 | invariant | handler 随机执行 reward earn/claim/penalty/offset/consume/liquidate | 对任意序列追踪 totalMinted、totalPenalty、totalRecycle | 不允许通过循环路径让任一账户在低于阈值的真实风险暴露下获得无限增长收益 |

### 12.6 Fee Extraction Attack 测试

攻击前提：

1. 协议费用在 borrow、repay、match、withdraw、liquidate、claim 或路由分账中收取。
2. 攻击者可以通过拆单、并单、回滚边界、最小金额、多跳路径反复触发费用结算。

攻击路径：

1. 将一笔业务拆成多笔，或通过多个入口重复穿越 fee hook。
2. 利用舍入、最小收费单位、退款顺序、view/push 不一致等缺陷回收超过应得费用。
3. 从协议金库、手续费池、返佣池或第三方分账地址提取净收益。

可利用点：

1. fee on fee 计算顺序错误。
2. 多入口共享状态未去重，导致重复计费或重复返佣。
3. fee view 与 fee ledger 不一致，可被选择性结算。

必须设计的测试用例：

| 测试 ID | 层级 | 构造 | 执行动作 | 必须断言 |
| --- | --- | --- | --- | --- |
| FEE-INT-01 | integration | 设计等价经济规模的单笔路径与拆单路径 | 分别执行单笔、两笔、十笔、最小金额碎片化操作 | 总费用差异必须落在明确舍入容忍范围内；不得因拆单产生净正收益 |
| FEE-INT-02 | integration | 同时覆盖 direct path 与 router path | 在不同入口重复执行相同经济动作 | 收费总额、归集去向、返佣金额必须一致或满足明确设计差异 |
| FEE-INV-01 | invariant | handler 随机切换金额粒度、入口路径、claim 顺序 | 连续执行费用产生与提取动作 | fee vault、treasury、user 三方净额守恒；任意 actor 不得通过循环把协议 fee 池抽成负值 |

### 12.7 Sandwich / MEV 攻击测试

攻击前提：

1. 用户成交价格、清算价格、奖励触发价格或费用档位可被前后夹击交易影响。
2. 协议执行层允许公开 mempool 观察后插队。

攻击路径：

1. 攻击者前置交易推高或打低价格/状态。
2. 用户交易在不利价格成交。
3. 攻击者后置交易恢复价格并锁定利润。

可利用点：

1. 缺少 minOut、maxIn、slippage cap、deadline、quote binding。
2. 清算和强平路径对区块内价格跳动过于敏感。
3. 用户与 keeper 使用相同公开路径但无保护参数。

必须设计的测试用例：

| 测试 ID | 层级 | 构造 | 执行动作 | 必须断言 |
| --- | --- | --- | --- | --- |
| MEV-INT-01 | integration | 三账户：attacker-front、victim、attacker-back；支持块内顺序控制 | 按 front-run -> victim -> back-run 顺序执行同一市场操作 | 若 victim 未提供保护参数则风险必须被识别并标记；若提供保护参数则交易必须 revert 或价格受限 |
| MEV-INT-02 | integration | keeper 与 attacker 竞争清算/成交窗口 | 在临界价附近重排交易顺序 | 不允许因排序差异导致协议层资金守恒破坏或重复奖励 |
| MEV-INV-01 | invariant（如适配） | handler 支持同块多 actor 重排与 quote 参数随机化 | 随机模拟 front/back-run 组合 | 若协议声明带保护参数，则任何重排不得突破用户 max loss 上界 |

### 12.8 攻击测试 Gate

上线前必须 PASS 的攻击 Gate：

1. flash loan 攻击测试全 PASS。
2. oracle manipulation 测试全 PASS。
3. liquidation manipulation 测试全 PASS。
4. reward farming exploit 测试全 PASS。
5. fee extraction attack 测试全 PASS。

有条件可接受风险：

1. sandwich / MEV 风险只可在“协议层无法完全消除、但已通过 slippage/deadline/minOut/maxIn/quote binding 把损失限制在用户显式接受范围内”时接受。
2. 任何“可接受风险”都不得导致协议坏账增加、系统性资不抵债、奖励超发、费用池被抽干、清算折价被重复领取。
3. 可接受风险必须写入上线签字记录，明确边界、监控项、告警阈值与回滚条件；未写入即视为不可接受。

直接 No-Go 条件：

1. 任一 P0/P1 攻击用例 FAIL。
2. 任一攻击场景下出现可稳定复现的正期望套利且收益来自协议资产负债表。
3. 任一攻击场景下只能靠人工运营盯盘或临时暂停权限才能维持安全。

### 12.9 集成到 invariant / integration 层的要求

integration 层必须这样接入：

1. 每类攻击至少新增一个确定性场景文件，命名采用 `*.integration.test.ts` 或现有安全测试风格 `*.security.test.ts`。
2. 每个场景必须显式创建 attacker actor、victim actor、keeper 或 liquidator actor，不允许复用单一默认账户掩盖攻击路径。
3. 每个场景必须同时断言：攻击者净收益、协议净损失、核心账本一致性、事件与 view/cache 最终一致性。
4. 每个场景必须提供“有保护参数”和“无保护参数”两组断言；只有预期允许裸露风险的 MEV 场景可放宽。

invariant 层必须这样接入：

1. 将 flash loan、oracle mode、liquidation、reward、fee、claim、consume、quote 参数变化纳入同一个 stateful handler。
2. handler 必须支持多 actor、多资产、多价格模式、多路径入口随机组合，不能只覆盖 happy path。
3. 至少维护以下全局不变量：资金守恒、债务非负、抵押非负、奖励发行上界、费用池非负、坏账不因攻击路径无界扩大。
4. 对于协议声称“可接受”的 MEV 风险，必须把用户最大可损失边界写成可断言的不变量，而不是文字说明。

最低落地要求：

1. `test:integration` 必须纳入全部攻击 integration 用例。
2. `test:invariant` 必须纳入至少 flash loan、oracle、liquidation、reward、fee 五类攻击状态机。
3. 若当前 invariant 基础设施不足，必须先补 handler 与 actor 抽象，再允许进入上线评审；不得以“暂时只有 integration”替代 P0/P1 要求。

### 12.10 执行与留痕要求

1. 每类攻击测试都必须输出独立摘要：攻击类别、测试 ID、初始状态、最终状态、攻击者收益、协议损失、结论。
2. 所有 FAIL 必须保留可复跑参数：随机种子、价格输入、账户快照、区块高度、配置版本。
3. 攻击测试结果必须进入上线证据目录，并与第 8 章 Go/No-Go 和第 9 章签字流程绑定。

## 13. 并发执行与 MEV 风险测试

本章针对执行顺序竞争、同块状态竞争、交易重排和部分执行失败链路。

上线评审不得再假设“交易天然按业务预期顺序执行”。

要求：

1. 所有关键写路径必须在“同一区块多交易、顺序被打乱、部分交易失败、部分交易成功”的前提下验证。
2. 所有并发与 MEV 测试必须输出确定性的交易顺序、区块号、排序方案、预期状态与最终状态。
3. 只要业务正确性依赖“先 A 后 B”，就必须把该顺序依赖显式写成可验证约束；不能默认由链保证。

### 13.1 风险分类与阻断等级

| 优先级 | 风险类型 | 默认阻断等级 | 最低测试层要求 |
| --- | --- | --- | --- |
| P0 | 同一区块多交易模拟 | 必须 PASS | integration |
| P0 | transaction reordering | 必须 PASS | integration + invariant/sequence-model |
| P0 | liquidation race condition | 必须 PASS | integration + invariant/sequence-model |
| P1 | partial execution / revert-chain | 必须 PASS | integration |

说明：

1. 这里的 `invariant/sequence-model` 指允许用状态机或序列模型替代传统 invariant，但必须能表达“同组交易不同顺序”的结果边界。
2. 若协议包含 keeper、matcher、liquidator、relayer、router、batch executor，以上四类风险全部视为 critical execution risk。

### 13.2 同一区块多交易模拟测试

目标：

1. 验证多个相关交易落在同一区块时，协议不会因为缓存、快照、排序或事件观察差异而产生错误状态。
2. 验证 view/cache/push 类模块不会把区块内中间态误当成最终态。

必须覆盖的场景：

1. borrow / repay / liquidate 在同一区块连续发生。
2. deposit / withdraw / match 在同一区块交错发生。
3. reward update / claim / penalty / recycle 在同一区块交错发生。
4. fee accrue / distribute / claim 在同一区块交错发生。

必须设计的测试用例：

| 测试 ID | 构造 | 执行动作 | 必须断言 |
| --- | --- | --- | --- |
| BLK-INT-01 | 关闭 automine，准备 borrower、keeper、attacker 三方待发送交易 | 将 borrow、price update、liquidate 打包进同一块 | 最终状态必须与协议定义的链上执行顺序一致；不得出现缓存沿用前态导致的错误清算 |
| BLK-INT-02 | 关闭 automine，准备 reward 与 fee 相关多笔交易 | 将 earn、claim、penalty、fee distribute 放入同一区块 | 区块内中间态不得被重复记账；最终奖励、费用、惩罚净额必须守恒 |
| BLK-INT-03 | 同一用户同块发起相互竞争的 deposit / withdraw / repay | 构造不同 nonce 和 gas price 组合 | 最终账本必须只反映实际落链顺序；不得因脚本预期顺序不同而通过 |

### 13.3 Transaction Reordering 测试

目标：

1. 验证当同组交易顺序被 builder、searcher、keeper 或 RPC 入口改变时，协议仍满足核心安全边界。
2. 显式证明哪些路径对顺序敏感，哪些路径在顺序改变后必须 revert。

风险点：

1. 先读后写依赖同块旧状态。
2. quote、price、health factor、fee tier 在交易进入区块前已失效。
3. 业务依赖“先授权、后成交”“先刷新、后读取”“先 repay、后 settle”之类隐含顺序。

必须设计的测试用例：

| 测试 ID | 构造 | 执行动作 | 必须断言 |
| --- | --- | --- | --- |
| ORD-INT-01 | 选定 3 笔互相关联交易 A/B/C | 枚举 A-B-C、A-C-B、B-A-C、B-C-A、C-A-B、C-B-A 六种顺序 | 每种顺序都必须有预期结果；不得存在未建模但可获利的异常顺序 |
| ORD-INT-02 | 选定需要 quote binding 或 slippage 参数的用户交易 | 在交易入块前插入状态改变交易，再执行用户交易 | 若保护参数仍满足则可成交；若不满足必须 revert，不能静默接受劣化价格 |
| ORD-MDL-01 | 为关键三元组动作建立 sequence model | 在状态机中随机改变相对顺序 | 任意顺序下必须保持资金守恒、债务约束、奖励/费用上界、不可重复清算 |

### 13.4 Liquidation Race Condition 测试

目标：

1. 验证多个 liquidator、borrower、keeper 在同一清算窗口竞争时，不会产生双花、重复奖励、超额扣押或状态撕裂。
2. 验证 borrower 的补仓、还款、撤押与 liquidator 的清算竞争时，边界条件正确。

必须覆盖的场景：

1. 两个 liquidator 竞争同一笔可清算头寸。
2. borrower 在被清算前同块补仓或 repay。
3. keeper 在读取旧 health factor 后，另一笔交易先改变风险状态。
4. 部分清算后第二个 liquidator 再次进入。

必须设计的测试用例：

| 测试 ID | 构造 | 执行动作 | 必须断言 |
| --- | --- | --- | --- |
| RACE-LIQ-01 | borrower 处于临界可清算状态，liquidator-A/B 同时准备交易 | 同块发送 A/B 两笔清算交易 | 最多只允许一笔获得完整可执行额度；第二笔必须按新状态缩量或 revert |
| RACE-LIQ-02 | borrower 与 liquidator 同时提交 repay / top-up / liquidate | 对三笔交易做全排列 | 任意顺序下都不能出现重复奖励、债务为负、抵押超扣 |
| RACE-LIQ-03 | 清算后立即再次尝试清算同一仓位 | 在同块和跨块各执行一次 | 同块与跨块语义必须一致：已被消费的清算额度不能再次被领取 |

### 13.5 Partial Execution / Revert-Chain 测试

目标：

1. 验证多模块调用链中，前半段成功、后半段失败时，不会留下可套利或不可恢复的中间状态。
2. 验证 best-effort push、外部 call、router 分发、batch 执行在局部失败时的账本一致性。

风险点：

1. 主状态已提交，但奖励、缓存、费用、事件、辅助 view 写入失败。
2. batch executor 中部分子调用成功、部分子调用失败，导致外部观察者与内部账本不一致。
3. 回滚链条中存在“先发奖励后回滚主动作”“先扣费后失败但未退款”之类错误顺序。

必须设计的测试用例：

| 测试 ID | 构造 | 执行动作 | 必须断言 |
| --- | --- | --- | --- |
| RVT-INT-01 | mock 一个下游模块在主动作后失败 | 执行 borrow / repay / liquidate 主路径并让辅助 push revert | 主账本必须保持设计语义；若辅助模块是 best-effort，则失败只能记录告警，不能破坏资金状态 |
| RVT-INT-02 | batch/router 中包含 1 笔成功子调用与 1 笔失败子调用 | 分别测试 all-or-nothing 与 partial-allowed 两种模式 | 模式语义必须明确且可验证；禁止出现文档说原子、实现却部分提交 |
| RVT-INT-03 | 在 reward / fee / liquidation 链路中插入可重现 revert 点 | 让回滚发生在不同阶段 | 不允许出现奖励已发、费用已提、抵押已转但主债务未更新的撕裂状态 |

### 13.6 如何在 Foundry 中实现

必须实现手段：

1. 使用 `vm.roll`、`vm.warp`、`vm.prank`、`vm.startPrank` 控制区块、时间与 actor。
2. 使用 `vm.pauseGasMetering` 仅限性能辅助，禁止借此掩盖顺序依赖。
3. 使用自定义 sequence harness，把同一组动作在多个排列下重复执行。
4. 对同块多交易，使用同一 `block.number` 下依次发送多笔调用，不在每步之间推进区块。
5. 对 partial execution，使用 mock 合约或 `expectRevert` 精确打断调用链中的指定节点。

Foundry 最低落地模式：

1. 建一个 `ConcurrentExecutionHarness`，封装 actor、nonce 语义、价格更新、清算入口、奖励入口。
2. 建一个 `PermutationRunner`，输入 2 到 4 笔关键交易，自动跑全排列。
3. 对每轮排列输出统一快照：用户净资产、协议总抵押、总债务、奖励累计、费用累计、清算奖励累计。
4. 把“必须 revert 的顺序”和“允许成功但结果必须受限的顺序”分开断言。

### 13.7 如何在 Hardhat 中实现

必须实现手段：

1. 使用 `evm_setAutomine(false)` 关闭自动挖矿。
2. 使用 `eth_sendTransaction` 或 signer 发送多笔待处理交易，再用 `evm_mine` 打包进同一区块。
3. 使用不同 gas price 或 EIP-1559 参数控制同块内相对排序；不能只测默认 nonce 顺序。
4. 使用 `evm_snapshot` / `evm_revert` 回到相同初始状态，重复跑多种排序。
5. 对 revert-chain，使用 mock 合约、故障注入分支或可切换的 test-only hook，让调用链在指定阶段失败。

Hardhat 最低落地模式：

1. 建一个 `runSameBlockBundle(transactions[])` 辅助函数，负责关 automine、发送交易、挖块、恢复 automine。
2. 建一个 `runPermutations(baseState, actions[])` 辅助函数，针对关键交易组跑全排列。
3. 建一个 `expectFinalLedgerInvariant(snapshotBefore, snapshotAfter)` 辅助断言，统一校验资金守恒、债务一致、奖励/费用上界。
4. 对 liquidation race 与 MEV 测试，必须显式记录每笔交易的 `hash`、`nonce`、`maxFeePerGas`、`maxPriorityFeePerGas`、入块顺序和最终 receipt。

### 13.8 必须纳入 critical-path gate 的测试

以下测试必须作为 critical-path gate，FAIL 即 No-Go：

1. 任一 borrow / repay / liquidate 三元组的同块重排测试。
2. 任一 quote-sensitive 或 slippage-sensitive 用户交易的重排保护测试。
3. 任一 liquidation race condition 测试。
4. 任一 reward / fee / liquidation 主路径的 partial execution / revert-chain 测试。

critical-path gate 最低集合：

| Gate ID | 必测内容 | 放行条件 |
| --- | --- | --- |
| CP-MEV-01 | borrow -> price move -> liquidate 同块模拟 | 不发生错误清算、重复清算、账本撕裂 |
| CP-MEV-02 | victim tx 前插后插重排保护 | 带保护参数的用户交易必须受限或 revert |
| CP-MEV-03 | 双 liquidator 竞争同一仓位 | 不得双重领取清算收益 |
| CP-MEV-04 | 主业务成功但辅助模块失败 | 主账本与设计语义保持一致，辅助失败可观测且不可套利 |

### 13.9 集成到测试分层的要求

integration 层必须这样接入：

1. 所有并发与 MEV 风险用例必须单独归类，命名采用 `*.concurrency.integration.test.ts`、`*.mev.integration.test.ts` 或 `*.race.security.test.ts`。
2. 每个用例必须至少执行两种不同排序；critical-path 用例必须执行全排列或覆盖所有高风险排列。
3. 每个用例必须同时断言最终账本和可观测副作用，不能只断言 revert 或只断言事件。

invariant 或 sequence-model 层必须这样接入：

1. 把“动作集合相同但排序不同”的语义写入状态机，而不是只随机动作内容。
2. 引入 actor 竞争模型：borrower、liquidator-A、liquidator-B、keeper、attacker、victim。
3. 至少维护以下顺序安全不变量：不可重复结算、不可重复清算、不可重复奖励、不可重复收费、保护参数失效时必须失败。

最低落地要求：

1. `test:critical-path` 必须纳入 CP-MEV-01 到 CP-MEV-04。
2. `test:integration` 必须纳入所有并发与 MEV integration 用例。
3. 若仓库暂无 Foundry，也必须先在 Hardhat 完成同块打包、重排与回滚链测试；不能因为工具栈限制而跳过。

### 13.10 执行与证据要求

1. 每次并发测试必须记录：初始快照、交易组、交易排列、同块入块顺序、最终账本、结论。
2. 每次 MEV 测试必须记录：victim 保护参数、attacker 前后置动作、攻击者收益、victim 滑点损失、协议损失。
3. 每次 revert-chain 测试必须记录：失败注入点、失败前已提交状态、失败后最终状态、是否可恢复。
4. 所有 critical-path gate 的证据必须进入上线留痕目录，并与第 8 章和第 9 章签字流程绑定。

## 14. RWA 特有风险测试

本章针对 RWA 借贷协议的跨系统风险。

RWA 不是纯 DeFi，测试不能只覆盖链上账本，还必须覆盖链上价格、链下资产、清结算流程、白名单/KYC/合规状态之间的联动风险。

要求：

1. 所有 RWA 风险测试必须同时给出链上断言与跨系统断言。
2. 只要链上可放款、可清算、可释放抵押、可结算的前提依赖链下系统或链下数据，就必须有显式失败测试。
3. 不允许把“后台会人工处理”当作默认安全前提；凡依赖人工介入的路径都必须被视为失败分支。

### 14.1 风险分类与测试层要求

| 优先级 | 风险类别 | 必须加入的测试层 | 是否属于 Layer-A gate |
| --- | --- | --- | --- |
| P0 | Oracle 价格延迟 | integration + fork/live preflight + live strict | 是 |
| P0 | Oracle 错误喂价 | integration + invariant/sequence-model + fork | 是 |
| P0 | 自动估值资产分层失效 | integration + fork/live preflight + architecture gate | 是 |
| P0 | 数据源不一致 | integration + fork/live preflight | 是 |
| P0 | 链上债务 vs 链下资产 mismatch | integration + end-to-end + reconciliation runbook test | 是 |
| P0 | liquidation shortfall 被隐式吞没 | integration + end-to-end + reconciliation runbook test | 是 |
| P0 | settlement failure | integration + end-to-end + live strict | 是 |
| P1 | whitelist race condition | integration + concurrency/MEV layer | 视入口而定，通常是 |
| P1 | KYC 状态变化 | integration + end-to-end + live preflight | 是 |

说明：

1. 只要 RWA 风险会直接影响放款、估值、结算、清算或赎回，它就属于上线阻断范围。
2. RWA 风险默认不允许仅靠 unit test 证明通过，至少要覆盖 integration 层与一个接近真实系统边界的测试层。

### 14.2 Oracle 风险测试

#### 14.2.1 价格延迟

风险定义：

1. 链上价格更新晚于链下真实市场或晚于协议要求的结算窗口。
2. 协议继续基于过期价格放款、清算、释放抵押或计算净值。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 | 测试层 | Layer-A |
| --- | --- | --- | --- | --- | --- |
| RWA-ORA-STALE-01 | 价格超过 maxAge 但业务入口仍可达 | 构造 stale price 后执行 borrow / withdraw / settle / liquidate | 关键入口必须 revert、降级到安全模式，或明确标记 `needsSync` 且禁止放行 | integration | 是 |
| RWA-ORA-STALE-02 | keeper/后台未及时刷新价格 | 在 stale price 下执行 live/fork preflight 与最小结算路径 | 协议必须输出可观测阻断信号，不能静默使用旧价继续成交 | fork/live preflight | 是 |
| RWA-ORA-STALE-03 | 价格延迟与同块业务竞争 | stale price 与价格刷新交易、放款交易同块交错 | 最终结果只能基于链上实际生效的最新可接受价格；不能对过期价格成交后再补解释 | concurrency/integration | 是 |

#### 14.2.2 错误喂价

风险定义：

1. 后台或预言机把明显错误的价格写上链。
2. 协议对极端高估、低估、零价、符号错误、精度错误价格缺乏防护。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 | 测试层 | Layer-A |
| --- | --- | --- | --- | --- | --- |
| RWA-ORA-BAD-01 | 喂入高估价格 | 用异常高价执行借款与净值评估 | 不得放出超额信用；超出阈值必须失败 | integration | 是 |
| RWA-ORA-BAD-02 | 喂入低估价格 | 用异常低价执行清算或 margin 检查 | 不得触发错误清算、错误违约、错误保证金没收 | integration | 是 |
| RWA-ORA-BAD-03 | 精度或单位错误 | 模拟 price decimals、quote units、currency mapping 错误 | 系统必须 detect mismatch 或在跨资产归一化前失败；不能静默接受错误单位 | integration + invariant | 是 |

#### 14.2.3 数据源不一致

风险定义：

1. 主数据源、备份数据源、后台导出文件或链下价格目录口径不一致。
2. 协议读到的价格与后台结算系统使用的价格不是同一版本。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 | 测试层 | Layer-A |
| --- | --- | --- | --- | --- | --- |
| RWA-ORA-DIV-01 | 双源价格偏差超阈值 | 主源与备源分别返回不同价格 | 超阈值必须阻断放款/结算，或进入明确人工审查状态且默认 No-Go | integration | 是 |
| RWA-ORA-DIV-02 | 链上 price 与链下 price catalog 版本不一致 | 用旧 catalog 驱动后台、用新 price 驱动链上预言机 | 对账必须直接 FAIL；不得把不同版本数据拼接成一次成功结算 | end-to-end | 是 |
| RWA-ORA-DIV-03 | 资产映射不一致 | 链下 ticker、ISIN、assetId 与链上 asset key 错配 | 不得把 A 资产价格用于 B 资产；发现映射错配必须阻断 | integration + reconciliation | 是 |

#### 14.2.4 自动估值资产分层与 fallback 边界

风险定义：

1. 协议没有把“可用于自动放贷/自动清算决策的资产”与“只能展示参考价的资产”明确分层。
2. `GracefulDegradation` fallback、缓存价、参考价被误用到自动授信、自动清算、自动债务收口入口。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 | 测试层 | Layer-A |
| --- | --- | --- | --- | --- | --- |
| RWA-ORA-TIER-01 | Tier-2 参考价资产误入自动借贷 | 将资产标记为仅参考价展示，随后执行 borrow / increase exposure | 必须直接失败；不得因为存在参考价或 fallback value 而放出信用 | integration | 是 |
| RWA-ORA-TIER-02 | Tier-1 资产在本次调用中降级为 fallback | 让 `PriceOracle.getPrice` 失败，但 `GracefulDegradation` 仍返回保守值，再执行 liquidate / settle | 写路径必须 fail closed；fallback 只能进入展示/诊断事件，不能驱动自动清算或自动关账 | integration + fork/live preflight | 是 |
| RWA-ORA-TIER-03 | 文档/实现边界不一致 | 对关键入口逐个验证其价格依赖边界 | 所有自动决策入口都必须明确证明“严格依赖 `PriceOracle.getPrice`”；任何 silent fallback 都视为 FAIL | architecture gate + integration | 是 |
| RWA-ORA-TIER-04 | no-price close path 被估值污染 | 对 `repayAndSettle`、`repayBlocks`、`closeRepaidTradeBlocks` 注入 oracle failure / fallback state | 这些入口仍必须可按真实 debt ledger 完成收口；不得因为 strict price 缺失而把真实已还清仓位卡死，也不得反向引入 fallback valuation 来“证明已清” | integration | 是 |
| RWA-ORA-TIER-05 | debt valuation strict / best-effort 未拆分 | 自动借贷 / 自动清算入口调用 debt valuation API | 自动决策只能调用 strict 版本；若仍复用带 `GracefulDegradation` fallback 的 best-effort API，则直接 FAIL | architecture gate + integration | 是 |

### 14.3 Off-chain 对账测试

#### 14.3.1 链上债务 vs 链下资产 mismatch

风险定义：

1. 链上记录的债务、抵押、可回收金额与链下 SPV、托管账户、应收账款或资产台账不一致。
2. 协议继续基于错误对账结果放款、续期、结算或释放抵押。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 | 测试层 | Layer-A |
| --- | --- | --- | --- | --- | --- |
| RWA-REC-01 | 链上债务高于链下可支持资产 | 构造链下资产余额偏低、链上债务偏高的对账快照 | 对账必须 FAIL；新增放款、放款续作、抵押释放必须阻断 | end-to-end + reconciliation | 是 |
| RWA-REC-02 | 链上债务低于链下资产 | 构造链上少记债务或链下多记资产 | 必须标记会计异常并阻断自动结算；不能因“看起来更安全”而忽略 | integration + reconciliation | 是 |
| RWA-REC-03 | 分资产桶 mismatch | 单一资产池对上，但分借款人/分票据台账不一致 | 协议不得执行 borrower 级释放、提前结算或违约解除 | end-to-end | 是 |

#### 14.3.2 Settlement Failure

风险定义：

1. 链上记录应结算成功，但链下法币、SPV、托管账户或清算代理未完成实际交割。
2. 协议在链下交割失败时仍把订单视为完成、已回款或可释放抵押。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 | 测试层 | Layer-A |
| --- | --- | --- | --- | --- | --- |
| RWA-SETTLE-01 | 链下 settlement 超时 | 模拟后台在 SLA 内未返回成功确认 | 链上不得把债务关闭、抵押释放、收益分配当作已完成 | integration + end-to-end | 是 |
| RWA-SETTLE-02 | 链下 settlement 明确失败 | 模拟银行/托管/清算方返回失败状态 | 协议必须进入失败分支、保留追索状态，不能静默吞错 | integration | 是 |
| RWA-SETTLE-03 | 链上成功事件先发，链下后续失败 | 先写链上状态，再注入链下失败回执 | 必须有补偿/冻结/回滚策略；若无，则该路径直接 No-Go | end-to-end + live strict | 是 |

#### 14.3.3 Liquidation Shortfall 显式状态与显式记账

风险定义：

1. 清算后 collateral 已处理完，但 residual debt 仍存在；系统却因为估值看起来“差不多合理”而把仓位视为已清。
2. `forceReduceDebt` 或等价写路径把未被真实覆盖的 debt 直接减为 0，导致坏账、追索、核销责任被隐藏。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 | 测试层 | Layer-A |
| --- | --- | --- | --- | --- | --- |
| RWA-SHORTFALL-01 | collateral 不足以覆盖 debt | 构造真实 shortfall 并执行 liquidation | 订单必须进入显式 shortfall 状态，且留下 `remainingDebt/shortfallAmount` 等显式账；不得直接落成 closed/liquidated-clean | integration | 是 |
| RWA-SHORTFALL-02 | fallback/reference price 误把 shortfall 吞掉 | 让清算估值仅能读取 fallback/reference price，再执行 liquidation | 不得因为参考价“看起来能覆盖”就把 debt 归零；必须保留 shortfall ledger 并阻断自动收口 | integration + end-to-end | 是 |
| RWA-SHORTFALL-03 | shortfall 后续收口 | 对同一 shortfall 仓位分别执行 guarantee absorb / recovery / governance write-off | 只有真实 recovery 或显式核销后，`remainingDebt` 才能归零；状态迁移和事件必须与 ledger 一致 | end-to-end + reconciliation | 是 |
| RWA-SHORTFALL-04 | shortfall outcome 与 ORDER_ENGINE / LoanNFT 状态不一致 | 执行带 residual debt 的 liquidation，再读取 order status、NFT status、shortfall ledger、DataPush | `LoanStatus`、shortfall status、ledger 字段、事件负载必须同交易内一致；不得出现 “状态说 liquidated-clean，但 ledger 仍有 shortfall” | integration + invariant | 是 |
| RWA-SHORTFALL-05 | shortfall 历史被后续 recovery 改写 | 先打开 shortfall，再完成 recovery 或 write-off | shortfall coarse lifecycle 必须保留历史痕迹；只能把 shortfall ledger 迁移为 `RESOLVED` / `WRITTEN_OFF`，不能把历史改写成从未 shortfall | end-to-end + reconciliation | 是 |

#### 14.3.3.1 坏账短缺专项补充矩阵（基于当前代码审查）

当前代码审查结论：

1. legacy keeper SSOT `SettlementManager.settleOrLiquidate(...)` 当前已经按 `coveredDebtAmount/remainingDebtAmount` 分叉，并在 residual debt 存在时写入 shortfall ledger，同时把 ORDER_ENGINE / LoanNFT 状态写成 `LiquidatedWithShortfall` 或 `DefaultedWithShortfall`；这一路径应以防回归 PASS 为目标。
2. legacy repay-after-liquidation 当前已经先做显式终态校验，`repay(...)` 会因 `Liquidated/Defaulted/(WithShortfall)` 直接 revert，不再依赖底层 overpay 金额路径兜底。
3. `BlocksOnlyCoordinator.settleOrLiquidateBlocks(...)` 在 maturity 且 `remainingDebt > 0` 时，当前会直接把 order-bound collateral 交付给 lender，并将订单收口为到期交付收尾终态（`CLOSED + BLOCKS_MATURITY_CLOSE + DELIVERED_TO_LENDER`）；该路径不打开 shortfall ledger，这一点需要显式留痕。
4. reward penalty/offset 侧已有部分命令模型覆盖多用户并发与长序列，但仍缺少同用户多单、maturity race、fallback shortfall receipt-level observability、以及 RewardView 高频 push 后最终镜像一致性的专门矩阵。

必须补充的专项测试矩阵：

| 优先级 | 测试 ID | 场景 | 必须断言 | 当前代码审查结论 | 当前预期 |
| --- | --- | --- | --- | --- | --- |
| P0 | `legacy_shortfall_force_reduce_mismatch` | 债务价值高于可处分抵押价值，执行 `settleOrLiquidate` | 如果业务入口仍把全债直接 `forceReduce` 为 0，则必须显式留下 `remainingDebt/shortfallAmount` 和 with-shortfall terminal status；不得出现“账清了但损失消失了” | 当前 legacy keeper SSOT 已具备 shortfall-aware 终态与账本；该用例应固定为防回归门，专门阻止未来回退到“全债 forceReduce” | 应 PASS；若回归则 FAIL |
| P0 | `blocks_only_maturity_delivery_closeout_shortfall_observability_gap` | `remainingDebt > selectedCollateralValue`，执行 `settleOrLiquidateBlocks` | 不能仅因订单进入到期交付收尾（maturity delivery closeout）且 collateral 已全部交付就认定系统无损；必须证明未覆盖损失有显式账，否则测试 FAIL | 当前 blocks-only 到期交付收尾仅交付 collateral 并收口为 `CLOSED + BLOCKS_MATURITY_CLOSE + DELIVERED_TO_LENDER`，没有 shortfall ledger / bad debt observability | 应 FAIL，作为设计缺口留痕 |
| P0 | `blocks_only_legacy_fallback_settled_dual_disposition_by_maturity_outcome` | 订单 maturity 收尾为 `SETTLED`，随后禁用 `ORDER_STATE_STORE` 再读取 `BlocksOnlyView.getBlocksOnlyOrderState` | legacy 兼容回退必须与到期收尾结果一致：debt-free maturity closeout -> `CLOSED + BLOCKS_MATURITY_CLOSE + RETURNED_TO_BORROWER + hasLoss=false`；maturity delivery closeout -> `CLOSED + BLOCKS_MATURITY_CLOSE + DELIVERED_TO_LENDER + hasLoss=true`；`TRADE_CLOSED` 仍映射 `RETURNED_TO_BORROWER` | 当前修复口径为按 maturity outcome 双分支映射，需固定为 P0 防回归门 | 应 PASS，若回归则 FAIL |
| P0 | `legacy_repay_after_liquidation_reverts_with_explicit_status` | 先清算，再 repay | 必须因 `Liquidated/Defaulted/(WithShortfall)` 显式状态直接 revert；不得落到底层 overpay/amount 校验才失败 | 当前 `LendingEngine.repay(...)` 已先检查 order status 并抛出 `RepayBlockedByOrderStatus` | 应 PASS，作为防回归 |
| P0 | `legacy_order_state_after_liquidation` | 清算完成 | `OrderEngine` / `LoanNFT` / `OrderStateStoreV2` 对外必须能读到 `Liquidated` / `Defaulted` 或对应 with-shortfall 状态；不得只改 debt ledger 不改终态 | 当前 legacy path 已通过 `_finalizeShortfallAwareOutcome(...)` 写终态 | 应 PASS，作为防回归 |
| P1 | `reward_penalty_multi_order_same_user` | 同一用户多笔 borrow 锁定 `lockedEasy`，交错发生 late penalty、liquidation penalty、on-time repay mint | `lockedEasy + minted + penaltyLedger` 变动必须守恒；同一用户多单交错时不得重复抵扣、漏抵扣或跨单串账 | 当前实现是 user 聚合 `lockedEasy` + order 级 unlock；已有基础设施，但缺少该专门矩阵 | 应新增并要求 PASS |
| P1 | `reward_penalty_multi_user_cross_offset` | borrower 和 lender 都累积 `penaltyLedger`，再完成多笔订单结清 | 双方净 mint 结果必须只受各自 penalty debt 影响，不得相互污染；borrower/lender penalty conservation 必须逐边校验 | 当前已有多用户并发命令模型，但缺少“双方交叉 offset”命名明确的专项 case | 应新增并要求 PASS |
| P1 | `reward_penalty_long_sequence` | 长序列执行 borrow、late repay、liquidation penalty、offset、mint、second borrow | 任意一步后 `penaltyLedger >= 0`；不得因重复 offset 变负，不得出现“债已清但继续吞 mint” | 当前已有 interleaved penalty/liquidation 长序列基础，但断言口径仍可继续收紧 | 应新增或补强并要求 PASS |
| P1 | `blocks_only_maturity_closeout_repay_vs_keeper_race` | 订单已 maturity，borrower `repayBlocks` 与 keeper `settleOrLiquidateBlocks` 竞争 | 任意顺序下都不能出现重复 close、重复到期收尾（maturity closeout）、debt 已清但 collateral disposition 仍错误、或状态撕裂 | 当前仅覆盖 repay-then-settle 等单一路径，未覆盖同块/全排列竞争 | 应新增并要求 PASS |
| P2 | `fallback_liquidation_shortfall_observability` | `SettlementManager` fallback 路径触发且 shortfall 存在 | 除 payout 事件外，还必须在同 receipt 或同交易可读状态中暴露 `LiquidationShortfallOpened` / shortfall ledger / with-shortfall status；不得只有 payout 没有坏账证据 | 当前 fallback 路径最终仍调用 `_finalizeShortfallAwareOutcome(...)`，理论上已具备 shortfall observability，但缺少专门 receipt-level 断言 | 应新增并要求 PASS |
| P2 | `reward_penalty_view_consistency_after_many_pushes` | 单 tx 多次 push，多 tx 连续 push | `RewardView` 最终镜像必须与主账 `pendingPenalty/lockedEasy/eligibleLoanCount/onTimeRepayCount` 完全一致；不得因多次 push 保留中间态 | 当前有单点 DataPush 与 offset 测试，但缺少“高频多 push 后最终一致性”专项 case | 应新增并要求 PASS |

P2 结构性差异统一规则（Test-Guide 全目录执行）：

1. 凡子文档提到 blocks-only 且未展开状态映射词典，必须增加单行锚点：术语与状态映射以本文件第 5 章 Gate 9 的“词典约束（blocks-only）”为准。
2. 子文档正文主术语统一采用“交易收尾（trade closeout）/到期收尾（maturity closeout）/到期交付收尾（maturity delivery closeout）”三分法。
3. “交割收尾”仅作同义注释，不作为标题术语、case 命名术语或主断言术语。
4. 若子文档只讨论运行边界或执行入口，可不重复长定义，但必须保留上述锚点以降低跨文档跳转成本。

落地要求：

1. 上表中所有 P0 项必须进入 Layer-A gate；其中 `blocks_only_maturity_delivery_closeout_shortfall_observability_gap` 在实现未补齐前应允许作为已知 FAIL 留痕存在，但不得被误判为已通过。
2. 所有 reward penalty 类 case 都必须同时校验主账与 `RewardView` 镜像，不能只看事件或只看 view。
3. 所有 blocks-only 类 case 都必须同时校验 order status、collateral disposition、是否存在 shortfall ledger（若期望存在），以及 lender 与 borrower 的真实资产分配结果。
4. Test-Guide 子文档中凡出现 blocks-only 状态语义处，必须添加第 5 章 Gate 9 词典锚点，且主术语必须满足三分法。

### 14.4 权限与合规测试

#### 14.4.1 Whitelist Race Condition

风险定义：

1. 用户交易提交时仍在白名单，但入块或结算时白名单状态已变化。
2. 资产、借款人、出借人、托管方或清算方在不同系统中的白名单状态不一致。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 | 测试层 | Layer-A |
| --- | --- | --- | --- | --- | --- |
| RWA-WL-01 | 用户提交后被移出白名单 | 同块或跨块执行 `removeWhitelist` 与 borrow/finalize/settle | 最终检查必须以执行时有效状态为准；不允许使用提交时旧状态放行 | integration + concurrency | 是 |
| RWA-WL-02 | 资产被移出白名单 | 在订单已创建但未最终结算前移除资产白名单 | 不得继续新增该资产风险敞口；后续路径必须进入明确的风控分支 | integration | 是 |
| RWA-WL-03 | 链上白名单与链下合规系统不一致 | 链上允许但链下禁止，或反之 | 对账与执行必须 FAIL；不允许“先做链上、后补合规” | end-to-end | 是 |

#### 14.4.2 KYC 状态变化

风险定义：

1. 用户在借款存续期间 KYC/AML/制裁状态发生变化。
2. 协议对存量债仓、提款、还款、收益领取、资产转移缺少状态切换策略。

必须加入的测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 | 测试层 | Layer-A |
| --- | --- | --- | --- | --- | --- |
| RWA-KYC-01 | KYC 从 valid 变 invalid | 在持仓中途切换用户合规状态，再执行 borrow/withdraw/claim/transfer | 新增风险敞口必须阻断；允许的收口动作必须明确定义且被测试覆盖 | integration | 是 |
| RWA-KYC-02 | KYC 状态恢复 | 从 invalid 恢复为 valid 后继续执行业务 | 恢复前后的可执行动作边界必须清晰，不得出现冻结后残余越权路径 | integration + end-to-end | 是 |
| RWA-KYC-03 | 借款人与出借人状态不同步 | borrower、lender、beneficiary 三方中仅一方状态变化 | 不得因部分账户仍合规而绕过整体合规检查 | end-to-end | 是 |

### 14.5 必须加入的测试层

RWA 风险测试至少必须加入以下测试层：

1. integration：覆盖链上业务入口与跨模块状态联动，是最低要求。
2. end-to-end：覆盖链上事件、链下回执、对账文件、清结算结果的一致性。
3. fork 或 live preflight：覆盖真实网络价格发布、真实缓存状态、真实配置版本与真实路由状态。
4. reconciliation runbook test：覆盖链上账本与链下资产台账、price catalog、settlement 回执的对账流程。
5. concurrency/MEV layer：对白名单变更、价格刷新、结算确认等与交易竞争有关的路径做顺序测试。

不充分的测试方式：

1. 只有链上单元测试，没有链下回执或对账模拟。
2. 只有静态 price mock，没有 stale/divergent/bad feed 场景。
3. 只有 happy path settlement，没有 settlement failure 分支。

### 14.6 是否属于 Layer-A gate

属于 Layer-A gate 的项目：

1. 所有会直接影响放款、清算、结算、抵押释放的 Oracle 风险测试。
2. 所有链上债务 vs 链下资产 mismatch 测试。
3. 所有“自动估值资产分层失效”测试，包括 fallback/reference price 被误用到自动授信或自动清算的情况。
4. 所有 liquidation shortfall 被隐式吞没的测试。
5. 所有 settlement failure 测试。
6. 所有 whitelist race condition 与 KYC 状态变化中，会导致协议错误放款、错误结算、错误释放风险敞口的测试。

不属于“可选专项门”的情况：

1. 价格延迟只要还能继续放款，就必须视为 Layer-A FAIL。
2. 对账 mismatch 只要还能继续释放抵押或关闭债务，就必须视为 Layer-A FAIL。
3. fallback/reference price 只要还能继续驱动自动放贷、自动清算或自动债务收口，就必须视为 Layer-A FAIL。
4. liquidation 后 residual debt 只要被静默归零、静默挪出视图或静默混入已结清仓位，就必须视为 Layer-A FAIL。
5. 合规状态变化只要还能继续新增风险头寸，就必须视为 Layer-A FAIL。

可作为 Layer-B 或专项证据补充的项目：

1. 纯监控质量、报表格式、告警文案正确性。
2. 不影响资金安全和合规边界的二级运营流程。

### 14.7 执行与证据要求

1. 每个 RWA 风险测试都必须记录链上状态快照、链下输入版本、对账结果、结论。
2. 对 Oracle 风险，必须记录 price source、publish block、max age、fallback 状态、资产分层（auto-valued / reference-only）、使用的 catalog 版本。
3. 对 shortfall 风险，必须记录 liquidation 前后 `remainingDebt`、`coveredDebt`、`shortfallAmount`、pricing mode、状态迁移与最终 recovery/write-off 动作。
4. 对 reconciliation 与 settlement 风险，必须记录链下回执 ID、清结算状态、失败原因、补偿动作或冻结动作。
5. 对 whitelist / KYC 风险，必须记录状态变更时间、入块时间、执行时间与最终采用的有效状态。
6. 所有 Layer-A 级别的 RWA 风险证据必须进入上线留痕目录，并与第 8 章 Go/No-Go 和第 9 章签字流程绑定。

## 15. 测试可信度与误判防护（False Confidence Prevention）

本章用于回答一个核心问题：为什么测试可以全部通过，但系统仍然可能在上线后出事。

目标不是追求“更多绿色”，而是防止错误的绿色结论进入上线决策。

要求：

1. 每个测试层都必须声明它证明什么、不证明什么。
2. 任何会显著降低真实世界约束的测试环境，都必须被视为“只提供局部证据”，不能直接等价成上线证明。
3. 凡是历史上出现过“本地通过、fork 通过、testnet 失败”或“testnet 通过、真链异常”的路径，都必须新增 canary 或对照测试。

### 15.1 哪些测试“通过但仍然可能出错”

以下测试通过后，仍然可能不足以证明系统可上线：

1. 只验证单函数回滚与 happy path 的 unit test。
2. 只依赖 mock 合约的 integration test。
3. 只依赖 localhost 的 fork-less 测试。
4. 只在 fork 上运行、但没有验证真实 RPC、真实 finality、真实异步对账的测试。
5. 只验证 `tx.wait()` 成功，而没有验证 post-write convergence、cache 同步、最终账务状态的测试。
6. 只验证事件 emitted，而没有验证 ledger state、view/cache state、外部依赖状态一致性的测试。
7. 只验证“脚本 exit code=0”，没有验证脚本是否跑到了正确网络、正确部署输出、正确 proxy/registry 路由的测试。

高风险假阳性模式：

| 假阳性模式 | 为什么会绿 | 实际风险 |
| --- | --- | --- |
| Mock oracle 永远及时、永不偏离 | 测试环境删掉了真实数据问题 | 上线后 stale / bad feed 直接触发错误放款或错误清算 |
| Mock token / mock settlement 永远成功 | 测试环境删掉了失败回执与异步交割 | 上线后 settlement failure、reconcile mismatch 不被发现 |
| localhost 读写强一致 | 本地节点不会复现真实 RPC 的陈旧读与负载均衡差异 | 上线后出现“交易已上链但下一次读取仍旧旧状态” |
| fork 使用单一稳定块状态 | fork 把真实链压扁成静态快照 | 上线后遇到实时竞争、热配置变化、后台数据更新时失败 |

### 15.2 fork / testnet / local 测试的差异

三类环境的结论不能互相替代。

| 环境 | 能证明什么 | 不能证明什么 | 典型误判 |
| --- | --- | --- | --- |
| local | 纯逻辑正确性、权限、边界、可重复回滚 | 真实 RPC、真实 finality、真实部署错配、真实异步外部依赖 | 本地强一致导致误以为写后读立即可信 |
| fork | 基于真实链状态的逻辑与路由验证、真实合约数据兼容性 | 真实链持续变化、真实 mempool、真实 RPC 健康、真实链下系统回执 | 误把“快照时刻正确”当成“运行时持续正确” |
| testnet/live | 真实 RPC、真实部署、真实角色、真实最终性、真实异步延迟 | 不能完整代替主网流动性和业务规模，但最接近真实运行 | 误把 testnet 噪声都归因于环境，从而忽略真实缺陷 |

必须遵守的结论规则：

1. local 通过，只能证明逻辑层初步正确，不能证明运行态正确。
2. fork 通过，只能证明在某个链上快照和某套 RPC 条件下路径可行，不能证明持续运行安全。
3. testnet/live strict 通过，才可作为运行态放行证据的一部分。
4. 若 local 与 fork 结果一致，但 testnet/live 不一致，默认优先排查真实网络约束，而不是优先认为 testnet“有噪声”。

### 15.3 mock / fork 的风险

#### 15.3.1 Mock 风险

Mock 的主要问题不是“假”，而是经常删掉了真实失败模式。

主要风险：

1. mock oracle 永远返回正确价格。
2. mock settlement 永远成功，没有异步失败、延迟确认、重复回执。
3. mock access control 没有真实治理延迟、角色漂移、多签/timelock 限制。
4. mock view/cache 没有真实 best-effort push 失败与 cold cache 行为。

必须要求：

1. 每个 mock integration 用例都必须写明它删掉了哪些真实约束。
2. 对 price、settlement、roles、cache、RPC 相关路径，必须有一层非 mock 验证作为对照。
3. mock 只能证明业务编排逻辑，不能单独证明生产环境可用性。

#### 15.3.2 Fork 风险

fork 的主要问题不是不真实，而是“只真实了一部分”。

主要风险：

1. fork 固定在某个快照块，无法自然覆盖真实链持续变化。
2. 远端 RPC 可能出现 `missing trie node`、超时、日志范围限制、陈旧读或负载均衡差异。
3. fork 通常不包含真实链下系统，如价格后台、清结算系统、白名单/KYC 后台。
4. fork 上的 signer、nonce、gas、mempool 竞争与真实 testnet/live 仍有差异。

必须要求：

1. fork 结果必须配套 live preflight 或 testnet/live strict 结果解释。
2. 任何 fork-only 绿色结果，不能直接作为上线放行结论。
3. fork 失败要区分协议失败与 RPC/infra 失败，避免把基础设施问题误写成协议回归，也避免反过来掩盖协议缺陷。

### 15.4 如何设计 canary 测试检测错误

canary 测试不是业务完整回归，而是用最小成本持续探测“测试体系自己是不是在骗你”。

canary 的目标：

1. 检测测试环境配置错误。
2. 检测假阳性来源是否重新出现。
3. 检测真实环境与测试假设是否发生漂移。

必须设计的 canary 类型：

| Canary 类型 | 目的 | 最低要求 |
| --- | --- | --- |
| Environment Canary | 确认当前测试跑在预期网络、预期部署输出上，且严格门禁未误用 `pg-mem` | 运行前硬校验网络 ID、registry、proxy implementation、关键 env，并在禁用层拒绝 `USE_PG_MEM=1` |
| Semantic Canary | 确认关键语义没有被 mock / helper 偷偷弱化 | 至少对 1 条关键路径同时跑低约束版和高约束版，对结果差异做断言 |
| Drift Canary | 检测部署、路由、价格、角色、catalog 是否与预期漂移 | 在 critical-path 前先跑只读 drift 检查，发现漂移直接阻断 |
| Failure Canary | 确认失败路径真的会失败 | 定期执行 1 条故意错误配置/错误权限/错误路由用例，若未失败则视为测试体系失真 |

必须加入的 canary 测试用例：

| 测试 ID | 场景 | 执行动作 | 必须断言 |
| --- | --- | --- | --- |
| CANARY-ENV-01 | 禁用层误用 `pg-mem` | 在 critical-path / integration / live strict 入口注入 `USE_PG_MEM=1` | 测试入口必须硬失败，不能降级继续跑 |
| CANARY-ENV-02 | 错误部署输出 | 故意提供漂移的 registry/proxy/module 地址 | preflight 必须直接 FAIL，不能继续执行业务测试 |
| CANARY-SEM-01 | 低约束与高约束对照 | 对同一路径分别在 mock 与 fork/live-preflight 条件下执行 | 若低约束通过但高约束失败，必须显式报告“false confidence risk” |
| CANARY-FAIL-01 | 故意构造应失败路径 | 注入 stale price、缺失角色、错误 whitelist、错误 settlement 回执 | 测试必须失败；若未失败，说明门禁或断言失效 |
| CANARY-DRIFT-01 | 真实网络漂移探测 | 只读检查关键路由、price freshness、role binding、cache readiness | 漂移必须在业务测试前被发现，而不是等业务断言间接失败 |

### 15.5 False Confidence 阻断规则

以下情况必须直接判定为 No-Go：

1. critical-path、integration 或 live strict 仍允许在 `pg-mem` 环境下运行。
2. 测试报告只有 mock/local 绿色，没有 fork/testnet/live 证据，却尝试申请上线。
3. 已知 failure canary 不再失败。
4. 环境 canary 无法证明当前运行使用了正确网络、正确部署输出，或未能拦截禁用层的 `pg-mem` 误用。
5. 测试只验证交易成功，不验证最终账务、缓存收敛、对账状态或真实失败分支。

以下情况必须补充说明并保留风险记录：

1. fork 与 testnet/live 结果不一致，但已证明是 RPC/infra 问题而非协议问题。
2. mock 用例仅作为开发反馈存在，但对应真实约束用例尚在排队执行。

### 15.6 执行与证据要求

1. 每个测试层的报告必须包含“本层证明范围”和“不证明范围”。
2. 每次 critical-path 执行必须附带 environment canary 结果。
3. 每次上线前必须附带至少一条 failure canary 成功拦截的证据，证明门禁不是虚设。
4. 若发生“测试全绿但线上事故”，事后复盘必须把根因归类到本章某一类假阳性模式，并补充新的 canary 或层级约束。

## 16. 参考文档

1. docs/Test-Guide/release-acceptance-standard.md
2. docs/Test-Guide/end-to-end-testing-guide.md
3. docs/Test-Guide/core-modules-testing-guide.md
4. docs/Test-Guide/view-layer-testing-guide.md
5. docs/Test-Guide/reward-testing-guide.md
6. docs/Test-Guide/liquidation-testing-guide.md
7. docs/Test-Guide/registry-testing-guide.md
8. docs/Test-Guide/vault-modules-testing-guide.md

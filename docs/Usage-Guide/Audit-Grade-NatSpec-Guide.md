# 审计级 NatSpec 注释指南（Draft，待测试回填）

> 本文档面向“上线/审计前”的注释标准（Audit-grade NatSpec）。  
> **重要**：当前版本为 **Draft**。在关键路径测试连续跑稳定、并完成集成验证后，必须按本文末尾的“测试回填清单”把注释校准到最终口径。

## 📋 目录

1. [目标与适用范围](#目标与适用范围)
2. [审计级 vs 规范合规（差异速览）](#审计级-vs-规范合规差异速览)
3. [强制规则（Must）](#强制规则must)
4. [推荐规则（Should）](#推荐规则should)
5. [团队内核对照表（短版）](#团队内核对照表短版)
6. [统一 NatSpec 模板（可复制）](#统一-natspec-模板可复制)
7. [审计级写法：把注释“绑定到可验证事实”](#审计级写法把注释绑定到可验证事实)
8. [常见高风险点：如何在注释中说清楚](#常见高风险点如何在注释中说清楚)
9. [工具与检查](#工具与检查)
10. [提交前检查清单（团队 SOP）](#提交前检查清单团队-sop)
11. [测试回填清单（跑稳定后必须补齐）](#测试回填清单跑稳定后必须补齐)

---

## 目标与适用范围

### 目标

审计级 NatSpec 的目标不是“写得更长”，而是让注释成为可被审计/链下工具直接消费的**可验证规格说明**：

- **口径一致**：注释、代码、测试三者对“回滚条件/权限边界/安全假设/单位精度”一致。
- **可追溯**：读者能从注释快速定位到对应的 `error`、权限 key（`ActionKeys`）、模块地址解析（`Registry`）、以及外部调用边界。
- **减少审计噪声**：把“故意的 best-effort 降级 / 不 revert”写清楚，避免被误判为缺陷。
- **降低集成风险**：明确返回值语义（尤其是 “0 表示失败/未知” vs “0 是合法值”），避免前端/机器人误用。

### 适用范围（必须覆盖）

- 所有 `public/external` 函数（尤其：写状态、转账、升级、权限校验、跨模块调用入口）
- 所有 `interface`（尤其：本地最小 adapter、跨模块治理写接口、view-only read adapter、事件接口）
- 所有 `error` / `event`
- 关键 `internal` 逻辑（建议）：金额/精度转换、外部调用封装、降级分支、缓存一致性分支

---

## 审计级 vs 规范合规（差异速览）

> “规范合规”满足结构、格式、基本信息；“审计级”要求**把关键断言写到可以被验证**。

| 维度       | 规范合规（团队基线）                       | 审计级（上线/审计前）                                             |
| ---------- | ------------------------------------------ | ----------------------------------------------------------------- |
| Reverts if | 说明大类回滚原因                           | **逐条对应**到具体 `error` / `requireRole` / 外部调用的 revert 源 |
| Security   | 写安全标签（role-gated、nonReentrant）     | 写清**信任假设、攻击面、降级语义、不可变边界**                    |
| 单位/精度  | “oracle-defined precision”等抽象描述可接受 | 优先落到 SSOT；若无法落地，明确 “depends on X” 与误用风险         |
| 外部调用   | 提及“外部调用”即可                         | 明确：**会不会吞错、失败后返回语义、是否影响安全关键决策**        |
| 升级/治理  | 说明“可升级、权限控制”                     | 写清：权限来源、执行路径、是否 timelock/三步升级、可观测性        |

---

## 强制规则（Must）

### 1) NatSpec 结构固定且英文输出

统一模板顺序（禁止乱序），并用英文书写（与仓库 SSOT 风格一致）：

1. `@notice`
2. `@dev Reverts if:`
3. 空行
4. `Security:`
5. `@param/@return`

> 对外可读的业务语义必须在 `@notice` 中一行说清楚：做什么 + 对谁/哪条路径生效。

### 2) Reverts if 必须“穷举可预期回滚”

必须覆盖（按实际情况取舍）：

- 权限（ActionKeys / role）
- 地址/数组/范围参数校验（含 batch size）
- 状态机条件（暂停、阶段、是否初始化、是否绑定 uid 等）
- 外部调用 revert（若会向上传递）
- 依赖模块缺失/未注册（`Registry.getModuleOrRevert`）

### 3) 安全属性必须显式写清

至少覆盖：

- 是否 role-gated、使用哪个 `ActionKeys`
- 是否 Non-reentrant / onlyVaultCore / onlyModule 等边界
- 对外部调用的信任假设与失败语义（是否吞错、是否降级）

### 4) 分区分隔符必须使用 SSOT 风格

合约内主要分区使用：

```solidity
/*━━━━━━━━━━━━━━━ <Section> ━━━━━━━━━━━━━━━*/
```

禁止任何 `/* ============ ... ============ */` / `// ============ ...` 风格。

### 5) 普通注释与标题分隔也必须统一为英文 + SSOT 风格

不仅 NatSpec，普通行注释、块注释、辅助函数内的分组标题也必须统一：

- 注释默认使用英文；不要在同一文件中混用中文注释与英文 NatSpec；
- 普通分组标题也必须使用 SSOT 分隔符，例如 `/*━━━━━━━━━━━━━━━ View Modules ━━━━━━━━━━━━━━━*/`；
- 禁止保留 `// ===== Views =====`、`// ============ Storage ============`、`/* ============ ... ============ */` 这类旧样式；
- 如果只是为了“视觉分组”，也不要新增中文标题注释；统一使用英文 section 名称。

### 6) 注释修改完成后，必须同时通过 Prettier 和 Solhint

NatSpec/注释整改不是“写完就结束”，必须把格式与 lint 一起收口：

- `Prettier` 负责版式统一：import 空格、折行、空白行、文件结尾换行、长常量换行等；
- `solhint` 负责 Solidity 规则与风险模式检查：如时间依赖、命名、最大行长、gas 类提示等；
- 两者都要跑，不能只跑其中一个；
- 若 `Prettier --check` 报 warn，而 `solhint` 通过，这通常表示“版式未统一”而不是“语义错误”，但在团队流程里仍应修复；
- 若 `solhint` 报错，则必须先区分它是纯样式问题、真实风险模式，还是架构 SSOT 问题，再决定是否修改代码或更新文档口径。

---

## 推荐规则（Should）

### 1) 写清“返回 0/空值”的语义

如果函数在失败时返回默认值（例如价格查询失败返回 `(0,0)`），必须写明：

- 这是 **best-effort** 设计决策
- `0` 表示 “unknown/failed” 而不是合法业务值（若确实可能是合法值，必须说明区分方式）
- 集成方必须如何处理（例如：遇到 `blockNumber == 0` 视为无效）

### 2) 注释中的名词必须与系统 SSOT 对齐

例如：

- 模块地址解析：`Registry.getModuleOrRevert(ModuleKeys.KEY_*)`
- 权限校验：`ViewAccessLib.requireRole(registry, ActionKeys.ACTION_*, caller)`
- 标准错误：`StandardErrors`（避免字符串 revert）

---

## 团队内核对照表（短版）

> 用于 PR 自检和 review 快速核对。若时间有限，先看这一节。

### 1) Function

- 顺序固定：`@notice` → `@dev Reverts if:` → 空行 → `Security:` → `@param/@return`
- `@notice` 只写一件事：做什么、对谁、走哪条路径
- `Reverts if` 尽量落到具体 `error`、角色 key、Registry 依赖
- `Security` 只写边界和假设：role-gated、nonReentrant、best-effort、external call trust

### 2) Interface

- interface 头部统一写 `@title`、`@notice`、`@dev Reverts if:`、`Security:`
- umbrella / compatibility interface 统一写法：说明它是兼容聚合层，并指出推荐依赖的窄接口
- local/minimal adapter 也要写清调用方、下游模块、为什么不用完整实现

### 3) Event

- 优先统一成块注释 `/** ... */`
- 推荐写法：`@notice Emitted when ...` + `@dev Event only.`
- 如有必要，再补“谁发出 / 为什么保留 ABI / 为什么便于 indexing”
- 参数注释只写业务语义、单位、是否 best-effort 或 informational

### 4) Error

- 默认写成单行：`/// @dev Reverts when ...`
- 不用 `@notice` 描述 error
- 参数存在时，说明触发条件，不重复函数实现细节

### 5) Struct / Enum

- struct 前优先有明确 section：`STRUCTS`、`EVENTS`、`ERRORS`
- 字段注释优先说明单位、时间语义、兼容字段名、是否 informational
- 遗留 ABI 字段统一口径：`Legacy field name kept for ABI stability.`
- 时间语义统一口径：明确是 block-based 还是 seconds，不混写

### 6) Section / Wording

- 分区统一用 SSOT：`/*━━━━━━━━━━━━━━━ <SECTION> ━━━━━━━━━━━━━━━*/`
- section 名称统一全大写：`STRUCTS`、`EVENTS`、`ERRORS`、`EXTERNAL API`
- 对失败返回默认值的 view，优先统一写 `Graceful degradation:`
- event-only / compatibility / best-effort 这三类描述在同类文件内保持同一套措辞，不混用多个近义写法

### 7) 收口检查

- 跑 `prettier` 和 `solhint`，不要只看编译
- 若只是样式修复，不要顺手改逻辑
- 同一类文件改法要前后一致，不要在一个目录里混用两套注释风格

---

## 统一 NatSpec 模板（可复制）

### Function（external/public）

```solidity
/**
 * @notice <One sentence: what it does + for whom / which path>
 * @dev Reverts if:
 *      - <condition 1> (see {ErrorName} / role / dependency)
 *      - <condition 2>
 *
 * Security:
 * - <property 1>
 * - <property 2>
 *
 * @param <name> <meaning + unit/precision/range>
 * @return <name> <meaning + unit/precision>
 */
```

### Error

```solidity
/// @dev Reverts when <precise condition>. Used by <functions>.
error ContractName__SomeError(<args>);
```

### Event

```solidity
/// @notice Emitted when <action happened>.
/// @dev <who emits / under what conditions / indexing rationale if needed>.
event SomethingHappened(
  address indexed user,
  uint256 amount,
  uint256 blockNumber
);
```

### Interface（local/minimal adapter）

```solidity
/// @title <InterfaceName>
/// @notice Minimal interface for <target module / purpose>.
/// @dev Used by <caller contract> to avoid importing the full implementation
///      and to make the cross-module boundary explicit for review and audit.
interface InterfaceName {
  /// @notice <One sentence for the method purpose>.
  /// @dev Reverts if:
  ///      - implementation-defined in the target module unless constrained here
  function foo(address user) external;
}
```

> 即使 interface 只是“当前文件内的本地最小适配层”，也必须至少写清：
>
> - 它服务于哪个调用方；
> - 它映射到哪个下游模块/用途；
> - 为什么这里使用最小 interface 而不是直接 import 完整实现。

---

## 审计级写法：把注释“绑定到可验证事实”

审计级的关键动作是：把每条注释落到可验证的“事实来源”。

### 1) 绑定到错误（error）或标准错误（StandardErrors）

在 Reverts if 中优先写：

- “`x` is zero (see {ZeroAddress})”
- “`assets` is empty (see {EmptyArray})”
- “batch too large (see {BatchTooLarge})”

避免写模糊表述如 “invalid params”。

### 2) 绑定到权限 key（ActionKeys）

必须写清具体 key：

- “caller lacks `ACTION_VIEW_PRICE_DATA`”
- “caller lacks `ACTION_UPGRADE_MODULE`”

并说明校验入口（例如 `ViewAccessLib.requireRole(...)`）。

### 3) 绑定到依赖模块（Registry）

若依赖通过 Registry 解析：

- 在 Reverts if 中写明 “Registry missing KEY\_\* (reverts in {Registry.getModuleOrRevert})”
- 如果该依赖故障会被吞掉（try/catch），在 Security 中写明 “best-effort; returns default values on failure”

---

## 常见高风险点：如何在注释中说清楚

### A) best-effort / try-catch 吞错（常见于 View）

**必须写清**：

- 是否会 revert
- 失败返回的语义
- 失败是否影响安全关键路径（例如：是否用于清算/风控决策）

推荐句式：

- “Best-effort call: returns (0,0) if oracle call fails; callers MUST treat blockNumber==0 as invalid.”

### B) 升级授权（UUPS）

必须写清：

- 权限 key（如 `ACTION_UPGRADE_MODULE`）
- newImplementation 校验（零地址/是否合约）
- 升级模型与系统治理的关系（若采用 Registry 的 schedule/execute 三步，注明并链接到对应指南）

### C) 单位/精度

必须写清：

- 金额：decimals（6/18）、bps（1e4）、时间（seconds）
- 价格：若统一精度未确定，必须写 “depends on oracle” 并明确不可假设为 1e18

---

## 工具与检查

### 编译（必须）

```bash
pnpm -s run compile
```

### Prettier（必须）

检查单个 Solidity 文件是否符合统一版式：

```bash
pnpm -s exec prettier --plugin prettier-plugin-solidity --check "src/<path>/<contract>.sol"
```

批量整改时，可直接写回：

```bash
pnpm -s exec prettier --plugin prettier-plugin-solidity --write "src/<path>/<contract>.sol"
```

必须关注的点：

- `Prettier --check` 的 warn 通常表示版式不一致，不一定是逻辑问题；
- 但只要团队要求统一版式，这类 warn 就必须清零；
- Solidity 文件若未显式加载插件，Prettier 可能无法自动识别 parser，因此仓库内检查命令应固定带上 `--plugin prettier-plugin-solidity`。

### Solhint（必须）

```bash
pnpm -s exec solhint "src/<path>/<contract>.sol"
```

> 审计前建议准备更严格配置（例如 `.solhint.perfection.json`），把部分 gas/文档规则提升为 error。

### 建议的最小检查闭环（必须执行）

每次 NatSpec / 注释整改后，至少按下面顺序执行一次：

```bash
pnpm -s run compile
pnpm -s exec prettier --plugin prettier-plugin-solidity --check "src/<path>/<contract>.sol"
pnpm -s exec solhint "src/<path>/<contract>.sol"
```

如果是多文件批量整改，推荐流程：

```bash
pnpm -s exec prettier --plugin prettier-plugin-solidity --write "src/**/*.sol"
pnpm -s run compile
pnpm -s run lint:sol
```

审计前提交标准：

- `compile` 通过；
- `Prettier --check` 不再报 warn；
- `solhint` 没有 error；
- 所有保留的 warning 都已经确认“不会破坏升级安全 / 架构 SSOT / 兼容性”，并且有明确理由。

### Gas warning 处置口径（生产优先）

对 `gas-struct-packing`、`gas-small-strings`、`gas-calldata-parameters` 这类 warning，**不要**看到 warning 就直接修改代码，必须先做“生产部署面优先”的分类。

先判断该 warning 是否影响以下任一稳定面：

- 实际部署到链上的 `external/public` ABI；
- upgrade-safe storage layout；
- EIP-712 type hash / 签名字段顺序；
- module key / data type / salt 等兼容常量的哈希值；
- 前端、索引器、监控依赖的链上可观测文案或 payload schema。

若 **不影响** 上述稳定面，可归类为“可直接修”：

- mock / test-only 合约中的 struct 重排；
- mock / test-only 合约中的长 revert 文案；
- 不改变 ABI 编码的 `memory -> calldata` 调整；
- 用 `abi.encodeCall` / selector 替换仅用于测试的长 signature string。

若 **影响** 上述稳定面，则归类为“保守处理”，不得为清 warning 直接修改：

- struct 顺序已进入生产 ABI 返回值/参数；
- struct 位于生产 storage 布局中；
- 字段顺序受 EIP-712 canonical order 约束；
- 长字符串本身就是 canonical module key / data type / salt / hash input；
- 长字符串属于对外可观测语义，需要前端/索引器/监控同步迁移。

对保守项，PR / 审计记录里至少要写清三点：

- 为什么它不能作为“纯优化”直接修改；
- 如果后续要改，需要同步哪些 ABI / storage / signer / indexer / frontend；
- 当前选择保留 warning 是否可接受，以及接受依据是什么。

---

## 提交前检查清单（团队 SOP）

> 目标：让 NatSpec / 注释整改成为可重复执行的团队流程，而不是“改完注释就结束”。

### 适用场景

- 新增或修改 Solidity 合约 / library / interface；
- 批量清理 NatSpec、事件注释、错误注释、普通注释；
- 替换旧分隔符、删除中文注释、统一版式；
- 提交审计前整改、发布前整理、PR 收口。

### 提交前必须逐项确认

1. 注释口径一致

- NatSpec、普通注释、事件/error 注释与当前实现一致；
- 注释中的权限、模块依赖、返回值语义、单位精度与代码 SSOT 一致；
- 不再保留“历史语义”或已经过期的描述。

2. 语言与版式一致

- 普通注释、NatSpec、分组标题统一使用英文；
- 分区标题统一使用 `/*━━━━━━━━━━━━━━━ <Section> ━━━━━━━━━━━━━━━*/`；
- 不允许出现 `// ===== ... =====`、`/* ============ ... ============ */`、中文分组标题。

3. 运行格式化检查

- 单文件或指定文件集整改后，先执行：

```bash
pnpm -s exec prettier --plugin prettier-plugin-solidity --write "src/<path>/<contract>.sol"
```

- 提交前必须再次确认：

```bash
pnpm -s exec prettier --plugin prettier-plugin-solidity --check "src/<path>/<contract>.sol"
```

- `--check` 仍有 warn 时，不允许直接提交；必须先统一版式。

4. 运行 Solidity lint 检查

- 至少对本次修改文件执行：

```bash
pnpm -s exec solhint "src/<path>/<contract>.sol"
```

- 批量整改时，建议直接跑仓库级：

```bash
pnpm -s run lint:sol
```

- 若存在 warning，必须确认其属于已知且可接受的架构/兼容性约束；
- 对 gas warning，必须先判断它是否进入生产 ABI、storage 布局、签名哈希或兼容常量，再决定“直接修”还是“保守保留”；
- 若存在 error，不允许提交，必须先修复或明确调整规则/口径。

5. 运行编译检查

- 至少执行一次：

```bash
pnpm -s run compile
```

- 注释整改也必须过编译，避免因为注释周边改动引入格式或语法问题。

6. 提交说明必须可审阅

- PR / 提交说明中应明确：
  - 本次是否只改注释和版式；
  - 是否涉及任何运行时逻辑变更；
  - 若保留 warning，理由是什么。

### 推荐执行顺序

```bash
pnpm -s exec prettier --plugin prettier-plugin-solidity --write "src/<path>/<contract>.sol"
pnpm -s run compile
pnpm -s exec prettier --plugin prettier-plugin-solidity --check "src/<path>/<contract>.sol"
pnpm -s exec solhint "src/<path>/<contract>.sol"
```

如果是多文件批量整改，推荐用下面这组命令做最终收口：

```bash
pnpm -s exec prettier --plugin prettier-plugin-solidity --write "src/**/*.sol"
pnpm -s run compile
pnpm -s exec prettier --plugin prettier-plugin-solidity --check "src/**/*.sol"
pnpm -s run lint:sol
```

### 提交阻断标准

- `compile` 必须通过；
- `Prettier --check` 不得再报 warn；
- `solhint` 不得有 error；
- 所有保留 warning 都必须有明确理由，且不会破坏升级安全、架构 SSOT 或兼容性；
- 对保留的 gas warning，提交说明必须写明它属于 ABI / storage / signature / constant compatibility / observability 中的哪一类约束；
- 若本次整改只涉及注释/版式，应在提交说明中明确标注 “no runtime logic change”。

## 测试回填清单（跑稳定后必须补齐）

> 你提到“现在还需要测试再确定代码”，因此审计级注释必须在测试验证后做二次校准。以下是回填清单。

### 1) 回滚口径校准（逐条对齐）

- 将每个 `external/public` 函数的 “Reverts if” 与测试用例逐条对齐：
  - 确认每个 revert 条件都有覆盖（正向 + 反向）
  - 若存在“实际会 revert 但注释未写”的情况：必须补齐
  - 若存在“注释写会 revert 但实际不 revert（被吞错/降级）”：必须更正并写清返回语义

### 2) 权限口径校准

- 确认每个入口标注的 `ActionKeys` 与实际 `requireRole/hasRole` 一致
- 如果权限策略会影响前端 `eth_call` 可用性，必须在 Security 中明确写出

### 3) 单位/精度校准

- 用测试/集成输出确认：
  - 价格精度是否统一（如 1e18）
  - blockNumber 语义是否为 block height
  - “0/空值”是否可能为合法值（若可能，必须明确区分方案）

### 4) 外部依赖与降级语义校准

- 对所有 try/catch 路径：
  - 明确是否吞掉 revert
  - 明确 fallback 值语义与集成方处理方式

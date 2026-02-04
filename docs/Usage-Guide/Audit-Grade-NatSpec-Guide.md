# 审计级 NatSpec 注释指南（Draft，待测试回填）

> 本文档面向“上线/审计前”的注释标准（Audit-grade NatSpec）。  
> **重要**：当前版本为 **Draft**。在关键路径测试连续跑稳定、并完成集成验证后，必须按本文末尾的“测试回填清单”把注释校准到最终口径。

## 📋 目录

1. [目标与适用范围](#目标与适用范围)
2. [审计级 vs 规范合规（差异速览）](#审计级-vs-规范合规差异速览)
3. [强制规则（Must）](#强制规则must)
4. [推荐规则（Should）](#推荐规则should)
5. [统一 NatSpec 模板（可复制）](#统一-natspec-模板可复制)
6. [审计级写法：把注释“绑定到可验证事实”](#审计级写法把注释绑定到可验证事实)
7. [常见高风险点：如何在注释中说清楚](#常见高风险点如何在注释中说清楚)
8. [工具与检查](#工具与检查)
9. [测试回填清单（跑稳定后必须补齐）](#测试回填清单跑稳定后必须补齐)

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
- 所有 `error` / `event`
- 关键 `internal` 逻辑（建议）：金额/精度转换、外部调用封装、降级分支、缓存一致性分支

---

## 审计级 vs 规范合规（差异速览）

> “规范合规”满足结构、格式、基本信息；“审计级”要求**把关键断言写到可以被验证**。

| 维度 | 规范合规（团队基线） | 审计级（上线/审计前） |
|------|----------------------|------------------------|
| Reverts if | 说明大类回滚原因 | **逐条对应**到具体 `error` / `requireRole` / 外部调用的 revert 源 |
| Security | 写安全标签（role-gated、nonReentrant） | 写清**信任假设、攻击面、降级语义、不可变边界** |
| 单位/精度 | “oracle-defined precision”等抽象描述可接受 | 优先落到 SSOT；若无法落地，明确 “depends on X” 与误用风险 |
| 外部调用 | 提及“外部调用”即可 | 明确：**会不会吞错、失败后返回语义、是否影响安全关键决策** |
| 升级/治理 | 说明“可升级、权限控制” | 写清：权限来源、执行路径、是否 timelock/三步升级、可观测性 |

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
event SomethingHappened(address indexed user, uint256 amount, uint256 blockNumber);
```

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

- 在 Reverts if 中写明 “Registry missing KEY_* (reverts in {Registry.getModuleOrRevert})”
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

### Solhint（必须）

```bash
pnpm -s exec solhint "src/<path>/<contract>.sol"
```

> 审计前建议准备更严格配置（例如 `.solhint.perfection.json`），把部分 gas/文档规则提升为 error。

---

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


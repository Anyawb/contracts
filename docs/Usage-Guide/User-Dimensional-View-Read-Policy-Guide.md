## 用户维度 View 读取权限策略（方案 U / Scheme U）

### 目标

本文档定义 **方案 U（Scheme U）**：让**所有用户维度（user-dimensional）的 View 模块**成为**真正面向终端用户（user-facing）的只读查询接口**。

具体规则如下：
- **Self read 必须允许（MUST）**：用户读取自己的数据，不得要求任何角色。
- **Non-self read 必须受控（MUST）**：读取他人数据时，调用者必须具备 `ACTION_VIEW_USER_DATA` **或** `ACTION_ADMIN`。
- **无权限回滚原因必须统一（MUST）**：权限不足时必须统一 `revert MissingRole()`（来自 `src/errors/StandardErrors.sol`）；仅在**必须保持 ABI 兼容**的遗留入口上允许例外，但必须明确记录。

本文档是**实施指南**（如何迁移 / 如何测试），不是抽象的政策宣言。

---

### 定义

#### 什么是“用户维度（user-dimensional）View”？

如果一个函数（或模块）返回的是**按用户维度（per-user）**的数据（直接或间接），则它属于**用户维度**，例如：
- `getUser*` 风格的接口（仓位、债务、奖励、快照、费用分析、清算统计等）
- `*WithMeta(user, ...)` 这类变体
- 接收用户地址的批量读取（`batchGetUsers*`、`batchGet*ForUsers` 等）

即使数据“只是缓存”，只要它以用户为 key 或能够泄露用户状态，它仍然属于用户维度数据。

#### 什么不是用户维度？

通常**不属于**用户维度的例子：
- 全局/系统级快照（`getGlobal*`、`getSystem*`）
- 模块注册查询辅助（`getRegistry`、`getModule*`）
- 与用户地址无关的纯计算
- 仅记录事件、且不暴露用户范围读取（user-scoped reads）的记录器

---

### 规范访问规则（方案 U / Scheme U）

对于目标用户为 `user` 的“用户范围读取（user-scoped read）”：

- 若 `msg.sender == user`，则**允许（Allow）**。
- 否则，若调用者具备下列任一角色，则**允许（Allow）**：
  - `ActionKeys.ACTION_VIEW_USER_DATA`，或
  - `ActionKeys.ACTION_ADMIN`。
- 否则必须 **revert**：`MissingRole()`。

备注：
- 这只是**读权限策略**；不改变任何写路径权限。
- 不要把下游适配器当作权限仲裁者：当某个 View 被设计为边界（boundary）时，应在该 View 的入口处完成权限约束。

---

### 推荐实现模式

#### 1) 每个模块新增/统一为一个单一 modifier

推荐命名（部分模块已有同名实现）：
- `onlyUserOrViewer(address user)`
- 或 `onlyAuthorizedFor(address user)`

建议参考模板：

```solidity
/// @dev Scheme U：允许 self；非 self 需 VIEW_USER_DATA 或 ADMIN。
modifier onlyUserOrViewer(address user) {
    if (
        msg.sender != user
            && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
            && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
    ) revert MissingRole();
    _;
}
```

#### 2) 将该 modifier 应用于所有“用户维度”的外部只读入口

示例：
- `getUserPositionWithMeta(user, asset)`
- `getUserRewardSummary(user)` / `getUserRewardSummaryWithMeta(user)`
- `getUserLoanCount(user)`（返回 `count, isValid, blockNumber`）
- `getUserFeeAnalytics(user)` / `getUserFeeConfig(user)`
- 等等

#### 3) 批量读取（Batch reads）

批量读取通常**不属于 self-scoped**（因为一次包含多个用户）。在方案 U 下：
- 如果批量读取接收 `address[] users`，则它**必须**要求 `ACTION_VIEW_USER_DATA` 或 `ACTION_ADMIN`（不得提供 self bypass）。

建议模板：

```solidity
modifier onlyOpsForUserBatch() {
    if (
        !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
            && !ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)
    ) revert MissingRole();
    _;
}
```

理由：批量读取本质上具有“枚举能力”（enumeration risk），因此应被视为特权操作。

---

### 迁移检查清单（最小风险步骤）

#### Step A — 确定迁移范围（Identify scope）

在 `src/Vault/view/**/*.sol` 中，列出所有满足以下条件的 `external view` 函数：
- 接收 `user` 参数，或
- 返回的结构体包含用户字段，或
- 接收 `users[]`（用户数组）。

将每个函数标记为：
- **用户维度（user-dimensional）**：必须遵循方案 U
- **非用户维度（non-user-dimensional）**：不在本规则范围内

#### Step B — 统一权限约束（Unify the gating）

对每个用户维度读取入口：
- 将“仅角色 gating（role-only gating）”替换为**方案 U** modifier（self bypass + ops/admin）。
- 除非明确需要且已文档化，否则移除“反直觉/倒置”的规则（例如“self 需要角色，non-self 反而只需 admin”等）。

#### Step C — 统一回滚风格（Unify revert style）

推荐：
- `revert MissingRole();`

避免：
- 字符串 `require(..., "Unauthorized")`
- 对新路径引入模块私有的 unauthorized error（导致全仓口径分叉）

若某模块必须保留遗留错误以保持 ABI 兼容：
- 仅在确实需要的入口保留，并在 NatSpec 中明确说明原因与替代路径。

#### Step D — 文档与测试同步更新（Update docs and tests together）

任何读权限迁移都必须同步更新：
- 架构文档引用（本指南 + `docs/Architecture-Guide.md`）
- 单元测试（self 成功、non-self（ops/admin）成功、outsider 回滚）
- 本地链 e2e 验收脚本（若该模块存在对应脚本）

---

### 测试要求（验收级）

对每个用户维度读取入口（entrypoint）：

- **U-READ-01 Self read 成功**  
  `user` 调用 `fn(user, ...)` → 成功

- **U-READ-02 Ops read 成功**  
  `ops`（具备 `ACTION_VIEW_USER_DATA`）调用 `fn(user, ...)` → 成功

- **U-READ-03 Admin read 成功**  
  `admin`（具备 `ACTION_ADMIN`，且不要求同时具备 `VIEW_USER_DATA`）调用 `fn(user, ...)` → 成功

- **U-READ-04 Outsider 被拒绝**  
  `outsider` 调用 `fn(user, ...)` → `revert MissingRole()`（断言 selector）

对批量读取（batch reads）：
- **U-BATCH-01 Ops/Admin 允许**
- **U-BATCH-02 Self-only 不是 bypass**（普通用户在无角色情况下必须被拒绝）

---

### 安全性与权衡（为什么选择方案 U）

#### 好处（Benefits）
- **真正用户可读**：终端用户无需角色即可查询自身状态。
- **运维灵活**：服务账号可用 `VIEW_USER_DATA` 完成代查；治理/管理员仍是“紧急开关（break-glass）”。
- **一致性**：避免出现“模块 A 允许 admin 代查、模块 B 却拒绝”的口径漂移。

#### 风险/成本（Risks / Costs）
- **隐私面扩大（但符合预期）**：self-only 用户永远能读到自己的状态——这是目标行为。
- **枚举风险（enumeration risk）**：必须确保 non-self 读取强制 `VIEW_USER_DATA`/`ADMIN`，且批量读取永不允许 self-bypass。
- **角色语义需要清晰**：若 `ACTION_ADMIN` 由 timelock/multisig 持有，日常代查可能不便；建议运维使用 `VIEW_USER_DATA`，把 admin 留作应急。

---

### 非目标（Non-goals）

方案 U **不要求**：
- 为纯只读函数补充 `DataPushed`，
- 修改函数是 `view` 还是 `non-view`，
- 修改写路径权限（`onlyWriter`、业务模块 gating 等），
- 把所有缓存数据变成公开数据。


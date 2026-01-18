## VaultCore ABI/Interface 强约束清单（Architecture-Guide 对齐）

目标：把 **VaultCore 的“用户写入口 ABI”** 与 **“模块侧数据推送入口（push*）”** 明确分离，避免接口漂移与依赖污染。

---

### 背景与动机

- **问题 1：接口漂移**：多个模块各自内联 `IVaultCoreMinimal`，很容易出现签名不一致、含义变形（尤其是 `push*`）。
- **问题 2：依赖不清晰**：模块究竟只需要 “resolve view address” 还是还需要 “push cache update”，在 import 层面看不出来。
- **强约束原则**：按架构指南 SSOT，把 VaultCore 的职责拆成“用户入口（authority path）/ view 地址解析 / 数据推送”三个可组合接口面。

---

### 现状（本仓库当前实现）

- VaultCore 合约 **确实包含** `pushUserPositionUpdate*` / `pushAssetStatsUpdate*` 等入口（供业务/账本模块 best-effort 推送 View）。
- 但 **前端 ABI 不应依赖这些 push* 入口**；前端应仅关注 `deposit/withdraw/borrow/repay` 等用户入口与必要 getter。

---

### 推荐接口分层（强约束）

#### 1) 用户入口 ABI：`IVaultCore`

- **包含**：`deposit/withdraw/borrow/repay`（以及是否保留 `batch*`、`borrowFor` 取决于产品需求）
- **不包含**：任何 `push*`（模块推送入口）

> 前端类型生成/集成，只 import `IVaultCore`。

#### 2) View 地址解析：`IVaultCoreMinimal`

- **只包含**：`viewContractAddrVar()`
- **用途**：模块通过 `KEY_VAULT_CORE` 解析 View 地址（VaultRouter），严格遵循架构指南的统一解析策略。

> 任何仅需要解析 View 地址的模块，只 import `IVaultCoreMinimal`。

#### 3) 数据推送：`IVaultCoreDataPush`

- **包含**：上下文版本化的 `pushUserPositionUpdate` / `pushUserPositionUpdateDelta` / `pushAssetStatsUpdate`
- **用途**：业务/账本模块把“仓位/统计更新”推送到 VaultCore，由 VaultCore 转发到 VaultRouter（或对应 View 模块）。

> 任何需要向 View 推送缓存的模块，只 import `IVaultCoreDataPush`（可同时 import `IVaultCoreMinimal` 做 view 解析）。

---

### 迁移清单（实施步骤）

- **Step A：新增接口文件**
  - `src/interfaces/IVaultCoreDataPush.sol`
  - `src/interfaces/IVaultCoreMinimal.sol` 收敛为 resolver-only（只保留 `viewContractAddrVar()`）

- **Step B：替换模块内联接口**
  - 搜索并删除模块文件中内联的 `interface IVaultCoreMinimal { ... push* ... }`
  - 改为：
    - 解析 View：`import { IVaultCoreMinimal } ...`
    - 推送更新：`import { IVaultCoreDataPush } ...` 并用 `IVaultCoreDataPush(vaultCore).push...`

- **Step C：保持 VaultCore 实现不变（仅接口依赖变更）**
  - 这一步不需要修改 VaultCore 合约代码逻辑；只改变“模块侧如何声明依赖”的方式。

---

### 约束与注意事项（必须遵守）

- **不要把 push* 加回 IVaultCore / IVaultCoreMinimal**：否则会再次污染前端 ABI 或导致“minimal”语义失真。
- **push 链路必须 best-effort**：推送失败不应阻断账本写入（失败应以事件记录便于链下重试）。
- **版本化参数优先**：模块推送优先使用带 `nextVersion/requestId/seq` 的版本化 push，避免缓存覆盖与顺序问题。

---

### 可选增强（更强约束，后续 PR）

- **进一步拆分**：将 `pushAssetStatsUpdate` 独立为 `IVaultCoreStatsPush`（如果统计推送与仓位推送的调用方完全不同）。
- **禁止用户调用 push**：在 VaultCore 的 push* 入口增加更严格的 `onlyBusinessModule`（目前已存在）并在文档/测试中断言。
- **为 view 地址更新增加治理入口**：若后续需要升级 VaultRouter 地址，考虑提供 role-gated 的 `setViewContractAddr(...)`（需严格评审治理与升级流程）。


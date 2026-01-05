# Vault View Layer

本目录包含 Vault 的 **View（只读/聚合/缓存）** 合约：

- `modules/`：可升级的 View 模块（UUPS），提供前端/Offchain 友好的聚合查询与（轻量）缓存能力
- `ViewConstants.sol`：View 层统一常量（缓存时长、批量上限等）

---

## Upgrade Compatibility（升级兼容性）— 存储布局必须稳定

### 背景问题（对应 `docs/Architecture-Analysis.md` 的风险点）

View 层存在缓存（例如用户维度缓存、系统快照缓存等）。当 View 模块通过代理升级时，**必须保持存储布局（storage layout）兼容**，否则会出现：

- 历史缓存数据读错槽位（数据错乱）
- 升级后需要复杂迁移逻辑（高风险、高成本）
- 甚至导致合约不可用（严重）

### 当前代码库的工程约束（必须遵守）

本仓库的 View 模块采用 **OpenZeppelin UUPSUpgradeable**，并统一执行以下“升级基线”：

- **UUPS 基线**：
  - `contract X is Initializable, UUPSUpgradeable`
  - `constructor() { _disableInitializers(); }`
  - `initialize(...) external initializer { __UUPSUpgradeable_init(); ... }`
  - `_authorizeUpgrade(address newImplementation)` 做权限校验 + 零地址校验
- **Storage gap 预留槽**：
  - 每个可升级实现合约保留 `uint256[__] private __gap;`（通常 50）
  - 用于未来新增状态变量时维持布局稳定

> 说明：`__gap` 的作用是“预留未来变量的槽位”。它不是自动安全网；升级时仍需遵循“只追加变量”的规则。

---

## Versioning Standard（版本化标准）— C+B 为主，A 为关键模块

为降低未来升级/审计/排障时的理解成本，本仓库对 View 层采用以下组合策略：

- **C（全模块统一）**：所有 `modules/*.sol` 必须继承 `ViewVersioned`，并暴露统一入口：
  - `getVersionInfo() -> (apiVersion, schemaVersion, implementation)`
  - 其中 `implementation` 会在代理调用时返回 **ERC1967 proxy 的实现地址**（便于链下定位版本/实现）
- **B（默认策略）**：模块通过 `apiVersion()` / `schemaVersion()` 明确表达“接口/输出结构”的演进。
  - 升级时保持 **append-only** 的状态变量规则，必要时递增 `schemaVersion`，并在注释/README 里说明差异点
- **A（关键模块才使用）**：当外部集成或离链消费依赖强、历史包袱重时，显式提供 `V2/V3` 事件/旧入口兼容。

### 当前关键模块（A 路线）
- `PositionView`：提供 `UserPositionCachedV2`（保留旧事件），并维护 `version/nextVersion/requestId/seq` 以支持并发与幂等。
- `StatisticsView`：保留旧接口入口（如 `updateUserStats/updateGuaranteeStats`）以平滑迁移，内部转调新 `push*` 体系。

### 升级规则（非常关键）

当你需要在某个 View 模块里新增状态变量/新字段时：

- **只允许追加（append-only）**：新状态变量必须添加在现有状态变量之后、`__gap` 之前
- **禁止插入/重排/删除**：不能把新变量插到已有变量之间，也不能重排已有变量声明顺序
- **缩减 `__gap`**：每增加一个新的 storage slot，必须相应减少 `__gap` 的长度（保持总布局可预测）

---

## “版本化/兼容”建议（缓存类尤其重要）

缓存数据会随着业务演进发生字段扩展。为了降低迁移成本与升级风险，建议采用以下策略之一（或组合）：

- **版本化事件 / 兼容输出**：
  - 新增 `V2/V3` 事件或输出结构，保留旧事件/旧接口以便 offchain 消费者平滑升级
- **幂等/顺序控制（写缓存的可靠性）**：
  - 对写入型缓存接口引入 `version/seq/requestId` 等上下文，避免乱序/重复推送导致的缓存回滚或不一致
- **缓存可重建优先**：
  - 对缓存设计 timestamp/isValid 失效窗口，让“升级后重建缓存”成为主要恢复路径，尽量避免链上复杂迁移

---

## 快速自检（新增/改动 View 模块时）

新增或修改 `modules/*.sol` 后，建议至少检查以下关键点是否都存在：

- `Initializable` / `UUPSUpgradeable`
- `_disableInitializers()`
- `__UUPSUpgradeable_init()`
- `_authorizeUpgrade(...)`
- `__gap`

---

## 现状说明（仓库当前实现）

截至当前仓库版本，`src/Vault/view/modules/` 下的 **全部 21 个 View 模块**已通过全量 grep 校验，均满足上述 UUPS + `__gap` 升级基线。



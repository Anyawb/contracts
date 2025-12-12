# Registry Upgrade Flow（模块升级流程文档）

本文件描述当前 Registry 的模块升级流程、安全机制、以及未来引入多签与 Timelock 的建议演化路径。

---

## 📌 当前设计（开发/测试阶段）

- 所有模块（如 CollateralManager、LendingEngine 等）在 Registry 中以 `bytes32 key` → `address` 的形式进行注册与读取。
- 模块升级采用 **延时机制**：
  - `scheduleModuleUpgrade()` 安排升级，记录 `newAddress` 与 `executeAfter` 时间戳；
  - 达到延时后，可由 `owner` 执行 `executeModuleUpgrade()`；
  - 可通过 `cancelModuleUpgrade()` 中止升级计划。
- `minDelay` 在构造时设定，默认建议为 `48 hours`，但本地测试时可设为 `0`；
- `MAX_DELAY` 固定为 `7 days` 上限；
- 所有权 `owner` 当前由单一开发者控制（开发方便），**尚未接入多签/DAO**；
- 重入保护采用 `nonReentrant` 修饰符，确保 `executeModuleUpgrade` 的安全执行。

---

## ⚠️ 安全注意事项

- 初次部署模块需调用 `setModule()`，**只能设置一次**，不能覆盖；
- 执行升级前需检查 `block.timestamp >= executeAfter`；
- 如需撤回升级计划，务必在 `executeAfter` 前调用 `cancelModuleUpgrade()`；
- 当前 `owner` 拥有所有升级权限，建议上线前转移给多签地址。

---

## ✅ 推荐升级演进路径（按阶段部署）

| 阶段 | Owner 权限 | Timelock / 多签 | 特别说明 |
|------|------------|----------------|----------|
| ✅ 开发阶段（本地/测试网） | 单一账户 | ❌ 暂不接入 | 保持敏捷开发 |
| ✅ 功能验收阶段（测试网） | 单一账户 + 延时机制 | 🔄 可选 Timelock | 初步引入升级流程控制 |
| 🚀 主网上线前 | 替换为 Safe（多签） | ✅ 强制接入 | 使用 Zodiac 模块加强升级路径 |
| 🛡️ 主网维护阶段 | 多签 + 延时升级 | ✅ 完整接入 | 所有模块升级需经过签名 + timelock |

---

## 🧠 模块升级示意图

```mermaid
sequenceDiagram
    participant Owner
    participant Registry

    Note over Owner: 1. 安排升级
    Owner->>Registry: scheduleModuleUpgrade(key, newAddress)
    Note over Registry: 记录 executeAfter

    Note over Owner: 2. 等待 minDelay 秒

    Note over Owner: 3. 执行升级
    Owner->>Registry: executeModuleUpgrade(key)
    Registry-->>Owner: 完成升级

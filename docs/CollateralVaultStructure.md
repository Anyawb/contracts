# CollateralVault 模块化拆分说明

> 旨在提升代码可读性、审计便利性与升级灵活性。

---

## 1. 拆分目标

* **审计友好**：将业务、治理、只读逻辑解耦，审核更聚焦。
* **升级安全**：仅 `Storage` 负责存储槽，其他文件不新增状态变量，配合 UUPS 可安全升级。
* **团队协作**：不同角色可并行编写/评审各自负责的文件。

---

## 2. 合约文件一览

| 文件名 | 描述 | 主要权限 / 特点 |
|--------|------|------------------|
| `CollateralVaultStorage.sol` | 所有状态变量、事件、modifier 定义。**禁止**包含业务逻辑 | 保证存储布局一致性；升级友好
| `CollateralVaultUserOps.sol` | 面向用户的核心操作逻辑，如 `depositAndBorrow` / `repayAndWithdraw` | 用户入口；允许少量 `internal` helper
| `CollateralVaultAdmin.sol` | 治理相关逻辑：费率设置、暂停、升级授权等 | `onlyGovernance`；包含 `_authorizeUpgrade`
| `CollateralVaultView.sol` | 纯只读方法：`isLiquidatable()`、`getHealthFactor()` 等 | `view` / `pure`；不改状态
| `CollateralVault.sol` | 顶层 Facade，仅保留 `initialize()` 与极少路由 | 继承上述四模块；UUPS 入口

---

## 3. 继承关系示意

```solidity
contract CollateralVault is
    CollateralVaultStorage,
    CollateralVaultUserOps,
    CollateralVaultAdmin,
    CollateralVaultView,
    UUPSUpgradeable
{
    function initialize(/* params */) external initializer {
        // ...
    }

    function _authorizeUpgrade(address newImpl)
        internal
        override
        onlyGovernance
    {}
}
```

继承顺序：`Storage → UserOps → Admin → View → Upgradeable`  
仅 `Storage` 文件可声明状态变量，其余模块 **禁止** 新增存储槽。

---

## 4. 实施步骤

| 步骤 | 说明 |
|------|------|
| 1 | 在 `contracts/Core/collateralVault/` 下新建四个 `.sol` 文件 |
| 2 | `Storage` 文件保留 `__gap` 预留槽，满足 OZ Upgrade 检查 |
| 3 | 拷贝对应逻辑段落，确保无重复 & 无交叉依赖 |
| 4 | 顶层 `CollateralVault.sol` 仅保留 `initialize` 与路由函数 |
| 5 | 更新其他合约 import 路径，LiquidationEngine 继续引用顶层合约接口即可 |
| 6 | 本地执行 `npx hardhat compile && npx hardhat test && npx hardhat contract-sizer` 确认一切通过 |

---

## 5. 目录推荐

```text
contracts/Core/collateralVault/
├─ CollateralVault.sol
├─ CollateralVaultStorage.sol
├─ CollateralVaultUserOps.sol
├─ CollateralVaultAdmin.sol
└─ CollateralVaultView.sol
```

---

## 6. 拆分收益

* ✅ **职责清晰**：用户操作 / 治理 / 视图互不干扰。
* ✅ **审计高效**：安全敏感逻辑集中在 `Admin`，只读逻辑集中在 `View`。
* ✅ **升级灵活**：修改单一模块时 diff 最小；存储冲突风险低。
* ✅ **协作友好**：不同开发者可同时迭代不同文件，降低冲突。

---

> 文档路径：`docs/Contracts/CollateralVaultStructure.md`  
> 请在 Cursor 编辑器或审计流程中随时参考。 
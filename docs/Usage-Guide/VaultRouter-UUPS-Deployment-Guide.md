# VaultRouter 升级版（UUPS）部署指南（严格版）

本指南用于将 `src/Vault/VaultRouter.sol:VaultRouter` **严格改造成可升级（UUPS + initialize）**，并要求所有测试网/主网部署脚本 **使用 `deployProxy` 部署 VaultRouter**，以对齐 `docs/Architecture-Guide.md` 的“本地存储 + UUPS（独立状态）”原则。

---

## 0. 目标与硬约束（必须满足）

- **VaultRouter 必须是 UUPS 可升级合约**：
  - 采用 `Initializable + UUPSUpgradeable + OwnableUpgradeable`
  - `constructor()` 必须 `_disableInitializers()`
  - 必须提供单一 `initialize(...)` 入口（不可重入）
  - 必须实现 `_authorizeUpgrade(...)`（通常 `onlyOwner`）

- **禁止使用 `immutable` 存储配置地址**：
  - Proxy 部署下，`immutable` 会固化在实现合约 bytecode 中，**与 proxy 状态无关**，属于架构级错误。

- **View 地址单一真实来源（SSOT）**：
  - 禁止引入/依赖 `KEY_VAULT_VIEW` / `KEY_VAULT_ROUTER` 等 Registry key。
  - VaultRouter 的权威地址应通过：
    - `Registry.getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE)`
    - `VaultCore.viewContractAddrVar()`

- **Registry 模块键必须以 `src/constants/ModuleKeys.sol` 为唯一标准**：
  - 部署脚本里用 `keccak256("SOME_UPPER_SNAKE")` 时，`SOME_UPPER_SNAKE` 必须与 `ModuleKeys` 常量注释中的字符串完全一致。

---

## 1. 合约侧改造规范（VaultRouter）

### 1.1 继承与基类（必须）

VaultRouter 必须使用 upgradeable 版本基类：

- `@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol`
- `@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol`
- `@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol`
- `@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol`
- `@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol`

禁止继续使用非 upgradeable 的 `Pausable` / `ReentrancyGuard`（否则 storage layout 不可控）。

### 1.2 initializer 形状（必须）

推荐 initializer（与当前仓库实现对齐）：

```
initialize(
  address registry,
  address assetWhitelist,
  address priceOracle,
  address settlementToken,
  address owner
)
```

要求：
- 所有地址非零
- `__Ownable_init(owner)`，避免 owner 默认为 deployer
- 初始化时 emit `VaultRouterInitialized(...)`

### 1.3 upgrade 授权（必须）

最小安全实现：
- `_authorizeUpgrade(address)` 使用 `onlyOwner`

> 测试网/主网应将 owner 设为多签或 Timelock。

---

## 2. 部署脚本规范（严格版）

### 2.1 部署顺序（必须）

在部署 VaultCore 之前，必须先拿到 VaultRouter 地址（proxy 地址），因为：
- `VaultCore.initialize(registry, viewAddr)` 需要传入 viewAddr

推荐顺序：

1) 部署 `Registry`（proxy）
2) 部署并挂载 `RegistryCore` / `RegistryUpgradeManager` / `RegistryAdmin`
3) 部署 `AccessControlManager`（按仓库现状可能是 regular 部署）
4) 部署 `AssetWhitelist` / `PriceOracle` / `SettlementToken`（或 mock）
5) **部署 `VaultRouter`（deployProxy）**
6) 部署 `VaultCore`（deployProxy，传入 `VaultRouter` 地址）
7) 其余模块按需要部署并注册到 Registry
8) 做强制断言校验（见 2.4）

### 2.2 VaultRouter 的 deployProxy 参数（必须）

部署脚本必须使用：

- 合约：`src/Vault/VaultRouter.sol:VaultRouter`
- 参数：`[registry, assetWhitelist, priceOracle, settlementToken, vaultRouterOwner]`
- initializer：默认 `initialize`

### 2.3 Registry 模块注册（必须）

VaultRouter **不需要**注册到 Registry（也不应创造新 key）。  
权威解析路径始终是：`VaultCore.viewContractAddrVar()`。

### 2.4 部署后强制断言（必须）

部署脚本必须在末尾做如下断言，否则认为部署失败：

- `VaultCore.viewContractAddrVar() == VaultRouter.address`
- `Registry.getModuleOrRevert(KEY_VAULT_CORE) == VaultCore.address`
- 若使用动态模块键：
  - `Registry.getModule(KEY_DYNAMIC_MODULE_REGISTRY) == Registry.getDynamicModuleKeyRegistry()`

---

## 3. 测试网部署脚本写法建议（强烈建议）

- 将 `vaultRouterOwner` 设为：
  - 测试网：你们的多签地址（推荐），或临时 timelock
  - 本地：deployer（方便调试）

- 将 `Registry.initialize(minDelay, upgradeAdmin, emergencyAdmin, owner)` 的三个权限地址拆分：
  - 不要全用 deployer（否则测试网部署不具备治理真实性）

---

## 4. 常见错误（必须避免）

- **继续用 constructor + immutable**：proxy 下等同“没初始化”，属于架构错误。
- **为了前端方便新增 `KEY_VAULT_VIEW`**：破坏单一真实来源，容易发生配置漂移与安全事故。
- **ModuleKeys 字符串拼错**：`keccak256("...")` 一旦错，Registry 就会永远绑错地址（线上灾难级）。


# OpenZeppelin v5 整体整改计划（Solidity/Hardhat）

> 目标：在 **继续使用 OpenZeppelin v5** 的前提下，让仓库 **可稳定编译、测试全绿、升级路径清晰、权限/安全语义一致**。  
> 适用：Hardhat + OZ Upgradeable（UUPS/Transparent）+ Solidity 0.8.x 项目。

---

## 背景与结论

- **现状**：仓库依赖已切换到 **OpenZeppelin v5**，因此会出现：
  - `OwnableUpgradeable` 初始化函数签名变化（`__Ownable_init(initialOwner)`）
  - `Address.isContract()` 移除（改用 `addr.code.length > 0`）
  - `SafeMath` 移除（Solidity 0.8+ 内建溢出检查）
  - ERC721/其他基类内部 API 变化（例如 `_exists` 不再存在）
  - 一部分 Upgradeable/Proxy 相关文件的 `pragma` 变为 `^0.8.22+`

- **关键结论**：
  - **不需要“全仓合约 pragma 全量改成 0.8.24”**。
  - 但 **Hardhat 编译器版本必须 ≥0.8.22**，否则无法编译 OZ v5 的依赖（你已经遇到 HH606）。
  - 建议直接统一使用 **Solidity 0.8.27** 作为 Hardhat 编译器版本（兼容 OZ v5 的 pragma；并且在本仓库实测下，可消除 `viaIR` + `ReentrancyGuardUpgradeable` 的 “Unreachable code” 编译 warning）。

---

## 总体策略（推荐）

### 迁移策略：以“可编译”为门槛分阶段推进

- **Phase 0：工具链对齐（先让编译器能跑）**
  - Hardhat `solidity.version` 提升到 `0.8.24`（或至少 `0.8.22`）
  - 确认 CI / 本地使用相同 Node/pnpm/Hardhat 版本

- **Phase 1：OZ v5 破坏性变更“全仓修复”**
  - 统一替换 `__Ownable_init()` → `__Ownable_init(msg.sender)`（或更严格的 `initialOwner`）
  - 替换合约检测：`Address.isContract()` / `addr.isContract()` → `addr.code.length > 0`
  - 清理 `SafeMath` import 与用法（按项目策略选择：直接改算术 vs 兼容 shim）
  - 替换 `ECDSAUpgradeable` → `ECDSA`（按当前 OZ v5 的实际库结构）
  - 修复 ERC721/AccessControl 等基类内部 API 变动（例如 `_exists`）

- **Phase 2：语义核对（权限/升级/事件/存储）**
  - 所有升级入口权限检查一致（UUPS `_authorizeUpgrade`）
  - 所有权/管理员变更事件一致
  - Storage layout 与升级安全检查文档化

- **Phase 3：回归测试与链上可操作性验证**
  - 单测、端到端测试、部署脚本、升级脚本全部跑通
  - 关键路径（Vault/Lending/Registry/Reward）做最小可用验收

---

## Phase 0：工具链对齐（必须）

### 必做项
- **Hardhat 编译器版本**：设置为 `0.8.27`
  - 原因：OZ v5 Upgradeable 依赖 `^0.8.22`，Hardhat 必须提供匹配版本
- **合约 pragma**：通常保持 `pragma solidity ^0.8.20;` 不动即可
  - `^0.8.20` 允许 0.8.27 编译

### 验收标准
- `pnpm hardhat compile` 能进入 Solidity 编译阶段，不再报 HH606。

---

## Phase 0b：Solidity 升级到 0.8.27（viaIR）——消除 ReentrancyGuardUpgradeable warning

### 目标
- **全仓统一使用 solc 0.8.27（Hardhat `solidity.version = "0.8.27"`）**
- 在保持 `viaIR: true` 的前提下，实现：
  - `pnpm -s hardhat clean && pnpm -s hardhat compile` **0 warning**
  - `pnpm test` **全绿**

### 背景：为什么要做这一步
- 在 solc 0.8.24 + `viaIR: true` 时，OpenZeppelin v5 的 `ReentrancyGuardUpgradeable.sol` 可能触发编译 warning：`Warning: Unreachable code.`
- 本仓库通过“探针合约”实测：将 Hardhat solc 升级到 **0.8.27** 后，即便显式编译 `ReentrancyGuardUpgradeable`，也不再出现该 warning。

### 实施步骤（推荐顺序）
1. **创建临时分支**（避免污染主分支）
   - 例如：`chore/solc-0.8.27-probe`
2. **修改 Hardhat 编译器版本**
   - `hardhat.config.ts`：`solidity.version: "0.8.27"`（保持 `viaIR: true`）
3. **用最小“探针合约”做一次确认**
   - 在 `src/` 下放一个最小合约，直接 `import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";`
   - 跑：`pnpm -s hardhat clean && pnpm -s hardhat compile`
   - 预期：**0 warning**
4. **全量回归**
   - 跑：`pnpm test`
   - 若项目有本地部署链路：再跑一次 `pnpm run deploy:localhost`（可选，但推荐）
5. **清理探针**
   - 探针仅用于验证，不建议长期留在 `src/`（会增加编译/Typechain 负担）

### 风险与注意事项
- **字节码差异**：solc patch 版本升级可能导致 bytecode 变化（即使源码不变），需要接受“重新验收”的现实。
- **gas/IR 行为变化**：viaIR 的优化器会随版本变化，建议至少跑一次关键路径测试（Vault/Lending/Registry）。
- **回滚策略**：若出现不可接受的差异/bug，可立即回退 `hardhat.config.ts` 的 solc 版本到 0.8.24，并恢复之前的零告警方案（例如自研 guard / 或 CI 白名单过滤）。

### 验收标准（必须同时满足）
- ✅ `pnpm -s hardhat clean && pnpm -s hardhat compile`：**0 warning**
- ✅ `pnpm test`：**0 failing**

---

## Phase 0c：部署脚本严格化（UUPS kind 固化）+ initializer 形式化核对（deploylocal）

### 目标
- **部署脚本严格化**：所有使用 OZ Upgrades 的 `deployProxy(...)` 默认显式指定 `kind: "uups"`，避免插件自动推断造成误用。
- **形式化核对**：对 `scripts/deploy/deploylocal.ts` 做“逐一形式化核对”，确保每个 `deployProxy('X', args, opts)`：
  - initializer **确实存在于 ABI**（含重载时必须显式指定 signature）
  - initializer **入参数量与 args 数量一致**
  - initializer 被显式关闭（`initializer: false`）的合约，后续必须在脚本中显式调用一次 `initialize(...)`（延迟初始化必须可追踪）

### 背景：为什么需要这一步
- OZ Upgrades 在未指定 `kind` 时会尝试推断（多数情况下没问题），但在“混合 UUPS/Transparent”或“升级模式逐步迁移”的项目中，**推断**会提高误配置概率。
- 部署脚本是生产/测试网的入口，属于高风险面；我们希望把错误尽可能前移到“脚本审计阶段”而不是链上事故。

### 实施步骤
1. **部署脚本改造**
   - 在以下脚本内，将 `deployProxy()` helper 的默认行为改为：`opts.kind ??= "uups"`（或等价实现）
   - 目标文件：
     - `scripts/deploy/deploylocal.ts`
     - `scripts/deploy/deploy-arbitrum.ts`
     - `scripts/deploy/deploy-arbitrum-sepolia.ts`
2. **新增审计脚本：deploylocal initializer 审计**
   - 新增：`scripts/checks/audit-deploylocal-initializers.ts`
   - 该脚本会解析 `deploylocal.ts` 中所有 `deployProxy(...)` 调用点，读取 Hardhat artifacts ABI，并输出一份可审计报告（Markdown 表格）：
     - 合约名（支持 fully-qualified name）
     - initializer（默认/显式/关闭）
     - initialize 签名（来自 ABI）
     - args 数量（脚本）
     - 结论（OK / FAIL）
3. **执行与验收**
   - 运行：
     - `pnpm -s hardhat clean && pnpm -s hardhat compile`
     - `pnpm -s ts-node --project ./tsconfig.scripts.json scripts/checks/audit-deploylocal-initializers.ts`
   - 验收：
     - 审计脚本输出 **无 FAIL**
     - 不引入新的编译/测试问题（建议跑 `pnpm test`）

### 回滚策略
- 若发现某些合约并非 UUPS（需要 Transparent），可在对应 `deployProxy(..., opts)` 显式覆盖：`{ kind: "transparent" }`，避免全局默认误伤。
- 若审计脚本对某些“延迟初始化”模式不适配，可以对这些合约做白名单（但必须在报告中明确记录原因与风险）。

## Phase 1：OZ v5 破坏性变更修复（重点整改清单）

### 1) OwnableUpgradeable 初始化签名变化（高频）

#### 症状
- 编译报错：`Wrong argument count ... expected 1`

#### 规则
- **Upgradeable 合约（强制，按架构指南）**：必须显式注入 `initialOwner`，并使用 `__Ownable_init(initialOwner)`  
  - **禁止**：`__Ownable_init(msg.sender)`（会把“谁调用 initialize”误当成最终 owner，违背治理口径，增加误用风险）
- **非 Upgradeable 合约**：一般不受影响（除非你使用的是 upgradeable 版本基类/库）

#### 建议做法（统一规范）
- 所有 Upgradeable 合约的 `initialize(...)` 统一写成（示例）：
  - `initialize(..., address initialOwner) external initializer`
  - `if (initialOwner == address(0)) revert ZeroAddress();`
  - `__Ownable_init(initialOwner);`
- 部署侧必须“同交易初始化”（`deployProxy(..., { initializer: "initialize(...)" })`），并且 `initialOwner` 必须来自受控配置（Timelock/Multisig），禁止从前端/用户输入/不可信 calldata 透传。
- 若存在工厂/路由创建代理：要么 owner 固定为治理主体；要么在工厂侧做 allowlist / role-gated，并记录事件便于链上追踪。

---

### 2) `Address.isContract` / `address.isContract()` 移除（高频）

#### 症状
- `Member "isContract" not found`

#### 替换规则
- 统一替换为：
  - `if (addr.code.length == 0) revert NotAContract(addr);`

#### 注意
- `code.length` 在构造函数期间为 0（这是 EVM 行为），如有依赖需调整逻辑。

---

### 3) SafeMath 移除（中高频）

#### 现状选择（两种路线，推荐 A）
- **A. 推荐：去 SafeMath 化**
  - 将 `.add/.sub/.mul/.div` 替换为 `+/-/*//`
  - 保留必要的 `require(b != 0)`、精度/边界检查
  - 优点：代码更简洁、贴合 0.8+；避免“假安全”封装
  - 缺点：改动面较大（但可批量替换）

- **B. 兼容：引入最小 shim**
  - 在少数遗留文件中内联一个轻量 `SafeMath` library（只为通过编译）
  - 优点：改动小、快速恢复编译
  - 缺点：会让工程长期背负历史包袱；且可能掩盖不合理的检查/错误消息

#### 验收标准
- 全仓不再 import `@openzeppelin/contracts/utils/math/SafeMath.sol`。

---

### 4) ECDSA / EIP712 Upgradeable 相关（中频）

#### 常见变化
- `ECDSAUpgradeable` 可能不存在/路径变化：改用 `@openzeppelin/contracts/utils/cryptography/ECDSA.sol`
- 若使用 EIP-712：
  - 推荐使用 OZ 提供的 `EIP712`/`EIP712Upgradeable`（如果现有实现自建 domain separator，需复核链 ID 变更逻辑与缓存）

#### 验收标准
- 签名相关合约可编译
- permit/nonce 逻辑有单测覆盖（至少 happy path + nonce replay + expired）

---

### 5) ERC721 `_exists` 消失（你当前已遇到）

#### 症状
- `DeclarationError: Undeclared identifier: _exists`

#### 推荐替代方式（语义等价）
- 如果你需要“token 是否已 mint”的判断：
  - 使用 `_ownerOf(tokenId) != address(0)`（OZ v5 ERC721 内部函数）
  - 或使用 OZ v5 提供的 `_requireOwned(tokenId)`（会 revert，适合“必须存在”的场景）

#### 整改步骤
- 在 `LoanNFT.sol` 这类文件中，将：
  - `if (!_exists(tokenId)) revert ...;`
  - 替换为：
    - `if (_ownerOf(tokenId) == address(0)) revert ...;`
    - 或直接 `_requireOwned(tokenId);`（再按需要处理 revert 信息/自定义错误）

#### 风险点
- `_ownerOf` 与 `ownerOf` 的 revert 行为不同（`ownerOf` 会 revert；`_ownerOf` 返回 0）
- 若原逻辑依赖 `_exists` 的“存在但 burned”的边界语义，需要确认 burn 实现

---

## Phase 2：权限/升级/存储语义核对（避免“编过但不安全/不可升级”）

### 1) UUPS 升级授权一致性
- 所有 UUPS 合约必须实现 `_authorizeUpgrade(newImplementation)`
- 推荐统一校验：
  - `newImplementation.code.length > 0`
  - `msg.sender` 必须是 upgrade admin / owner / timelock（按你治理模型）

### 2) Ownable 与 Registry/Admin 双轨治理核对
- Owner 与 Registry storage 内 admin/pendingAdmin 的一致性（谁是单一真相）
- 事件：AdminChanged / PendingAdminChanged 等是否在所有路径都触发

### 3) Storage layout（升级安全）
- 对所有 Upgradeable 合约：
  - 保留 `__gap`
  - 升级前后跑 storage layout 检查（已有 `RegistryStorage.validateStorageLayout()` 可复用）

---

## Phase 3：测试、脚本、发布流程（最后一公里）

### 必跑清单
- `pnpm hardhat compile`
- 单测（按模块）
  - Registry / Vault / LendingEngine / LoanNFT / Reward
- 脚本任务
  - `scripts/tasks/*` 与部署脚本（尤其 registry 相关 migrate/verify）

### 回归重点（建议最小验收用例）
- ✅ **已完成（本仓库已跑通最小回归用例）**
- **Registry**
  - 覆盖点：setModule / batchSetModules / schedule/execute upgrade；事件语义（AdminChanged / PendingAdminChanged 等）
  - 已跑命令：
    - `pnpm -s hardhat compile`
    - `pnpm -s test test/Registry.test.ts test/Registry-Admin-Events.test.ts test/RegistryAdmin.security.test.ts`
  - 备注：签名 permit（如果启用）已由 `RegistrySignatureManager` 的测试覆盖（见 `test/RegistrySignatureManager.test.ts`）
- **LoanNFT**
  - 覆盖点：mint / burn / read-only getter 对不存在 token 的行为一致；SBT 转移限制；暂停与权限（ACM）
  - 已跑命令：`pnpm -s test test/core/LoanNFT.test.ts`
- **Vault/Lending**
  - 覆盖点：关键入口（VaultRouter/VaultBusinessLogic/LendingEngine）能走通；权限/暂停状态一致；View 核心读取稳定
  - 已跑命令：
    - `pnpm -s test test/LendingEngine.test.ts`
    - `pnpm -s test test/VaultRouter.test.ts test/VaultBusinessLogic.test.ts test/VaultCap.test.ts`
    - `pnpm -s test test/Vault/view/HealthView.test.ts test/Vault/view/LendingEngineView.test.ts`

---

## 建议的落地执行顺序（给你一个可操作的“路线图”）

1. 固化 Hardhat `solidity.version = 0.8.27`（完成/按 Phase 0b 验收）
2. 全仓扫描并修复：
   - `__Ownable_init()`（升级为带 owner 参数）
   - `.isContract()`（改为 `code.length`）
   - `SafeMath` import（移除/替换）
   - `ECDSAUpgradeable`（替换为 `ECDSA`）
3. 修复编译器报出的下一批“具体合约 API 断裂”（例如 `LoanNFT` 的 `_exists`）
4. 编译通过后，跑最关键的一组测试（Registry + LoanNFT + Lending/Vault 核心）
5. 通过后再做“语义核对”（权限/升级/存储）与文档更新

---

## 产出物（迁移完成的“交付标准”）

- ✅ `hardhat compile` 全绿
- ✅ 核心测试全绿（至少覆盖 Registry/LoanNFT/核心资金流路径）
- ✅ 关键治理/升级路径有文档（谁能升级、如何升级、如何回滚、如何验收）
- ✅ 不再依赖 OZ v4-only 的 import / API

最终目标是 0 warning
在本仓库中，已通过 **Phase 0b（升级到 0.8.27 + 探针验证）** 达成 `clean && compile` 的 **0 warning**，因此后续整改应以 0.8.27 为基线继续推进。


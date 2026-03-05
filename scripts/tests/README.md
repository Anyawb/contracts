# Smoke / Acceptance 脚本运行指南（默认按 Arbitrum 真链模式）

本 README 列出准备与运行 smoke / acceptance 脚本所需的完整 CLI 步骤，并将“真实网络（如 Arbitrum）”的运行约束写成默认口径：

- **默认 read-only（推荐）**：不写链、不依赖 Hardhat 本地 RPC（无 `evm_snapshot/impersonate/hardhat_mine`）
- **地址解析 SSOT**：优先从 `deployments/addresses.<network>.json` 或环境变量 `REGISTRY_ADDRESS` 解析 Registry
- **写入模式（可选，谨慎）**：仅在你明确需要“真链写入验收”时开启 `ENABLE_WRITE=1`（会消耗 gas 并改变链上状态）

> 说明：部分脚本本质是 localhost 写入型（用于确定性回归/CI），它们在真实网络上会自动降级为只读校验并跳过写入步骤（确保“Arbitrum 模式”可运行）。

---

## Arbitrum 模式（默认推荐）

### 通用约定（所有 smoke 脚本统一口径）

- **READ_ONLY**
  - 默认：`READ_ONLY=1`（当 `--network != localhost` 时）
  - 行为：只做读取/selector gate/staticCall 校验；不发送交易；不使用 hardhat 专用 RPC
- **ENABLE_WRITE**
  - 默认：`ENABLE_WRITE=0`（当 `READ_ONLY=1` 时）
  - 行为：允许发送交易（仅当你真的希望在测试网/真链上写入验收）
- **REGISTRY_ADDRESS**
  - 推荐：在真实网络上显式提供 `REGISTRY_ADDRESS=<your_registry>`
  - 也可通过 `deployments/addresses.<network>.json` 自动解析（见 `scripts/tests/_addressResolver.ts`）

### 示例：在 Arbitrum Sepolia 只读跑 smoke

```bash
READ_ONLY=1 pnpm -s exec hardhat run scripts/tests/view-schemeu-smoke-local.ts --network arbitrumSepolia
READ_ONLY=1 pnpm -s exec hardhat run scripts/tests/viewcache-smoke-local.ts --network arbitrumSepolia
READ_ONLY=1 pnpm -s exec hardhat run scripts/tests/ai-credits-exchange-idempotency-smoke.ts --network arbitrumSepolia
```

### 一键命令清单（Arbitrum / Arbitrum Sepolia）

> 下方命令分两套：**只读验收（推荐）** 和 **可写验收（谨慎）**。  
> 如果地址文件未配置，请先导出：`export REGISTRY_ADDRESS=<your_registry_address>`。

#### A) 只读验收（推荐，复制即跑）

**Arbitrum 主网**

```bash
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/preconfig-strict-smoke-local.ts --network arbitrum
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/view-schemeu-smoke-local.ts --network arbitrum
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/viewcache-smoke-local.ts --network arbitrum
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/lendingengine-smoke-local.ts --network arbitrum
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/reward-smoke-local.ts --network arbitrum
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/ai-credits-exchange-idempotency-smoke.ts --network arbitrum
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-create-order.ts --network arbitrum
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-conservation.ts --network arbitrum
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-local.ts --network arbitrum
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-invariants-suite.ts --network arbitrum
```

**Arbitrum Sepolia**

```bash
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/preconfig-strict-smoke-local.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/view-schemeu-smoke-local.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/viewcache-smoke-local.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/lendingengine-smoke-local.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/reward-smoke-local.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/ai-credits-exchange-idempotency-smoke.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-create-order.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-conservation.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-smoke-local.ts --network arbitrumSepolia
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run scripts/tests/funds-flow-invariants-suite.ts --network arbitrumSepolia
```

#### B) 可写验收（谨慎，建议先在 Sepolia）

**Arbitrum 主网（高风险，先小流量）**

```bash
READ_ONLY=0 ENABLE_WRITE=1 pnpm -s exec hardhat run scripts/tests/preconfig-strict-smoke-local.ts --network arbitrum
READ_ONLY=0 ENABLE_WRITE=1 pnpm -s exec hardhat run scripts/tests/viewcache-smoke-local.ts --network arbitrum
READ_ONLY=0 ENABLE_WRITE=1 pnpm -s exec hardhat run scripts/tests/reward-smoke-local.ts --network arbitrum
READ_ONLY=0 ENABLE_WRITE=1 pnpm -s exec hardhat run scripts/tests/ai-credits-exchange-idempotency-smoke.ts --network arbitrum
```

**Arbitrum Sepolia（推荐先跑）**

```bash
READ_ONLY=0 ENABLE_WRITE=1 pnpm -s exec hardhat run scripts/tests/preconfig-strict-smoke-local.ts --network arbitrumSepolia
READ_ONLY=0 ENABLE_WRITE=1 pnpm -s exec hardhat run scripts/tests/viewcache-smoke-local.ts --network arbitrumSepolia
READ_ONLY=0 ENABLE_WRITE=1 pnpm -s exec hardhat run scripts/tests/reward-smoke-local.ts --network arbitrumSepolia
READ_ONLY=0 ENABLE_WRITE=1 pnpm -s exec hardhat run scripts/tests/ai-credits-exchange-idempotency-smoke.ts --network arbitrumSepolia
```

> 可写验收前请确认：  
> - 执行账户具备对应角色（否则会 `MissingRole()`）  
> - 账户 gas 余额充足  
> - 你接受脚本会改变链上状态（特别是 cache / reward 相关写入）

## 冒烟运行器 “方案 A/B/C/D” （推荐） — `test:smoke:prodlike:localhost`

团队建议优先使用统一的 smoke runner（`pnpm -s run test:smoke:prodlike:localhost`）来跑“生产环境近似”的冒烟；通过环境变量开关来选择不同强度/不同约束的执行方式。

## View 测试矩阵自检（无 CI 也推荐跑）

当你们还没有 CI 时，建议在跑 smoke / acceptance 之前先跑一次“矩阵自检”，用于防止 §5.1.2 漂移：

```bash
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/tests/view-matrix-selfcheck.ts
```

- **检查内容**：
  - `ARCH-VIEW-ALIGNMENT-WORKGUIDE.md` 的每个 `##### 4.x`（测试矩阵）小节至少绑定一个脚本路径
  - 引用的 `scripts/e2e/*.ts` / `scripts/tests/*.ts` 文件真实存在
  - 脚本在 `scripts/e2e/README.md` 或 `scripts/tests/README.md` 中被提及（避免“孤儿脚本”）

**相关脚本（本 README 覆盖）**：
- `scripts/tests/phase3-positionview-acceptance.ts`
- `scripts/tests/viewcache-smoke-local.ts`

### Runner 开关（env）
- `RUN_VIEW_SMOKE=1`：新增 view + Scheme U 冒烟（`SystemRiskView` 路由、`HealthView` 公开读、`RiskView/BatchView` Scheme U gate）
- `RUN_VIEWCACHE_SMOKE=1`：新增 ViewCache 冒烟（写权限 gate、TTL 过期、DataPushed payload 可解码）
- `RUN_REWARD_SMOKE=1`：新增 Reward 冒烟（Earn 闸门 + GFM penalty + RewardView DataPushed + EasyToken 相关状态变更 + Easy 消耗可观测性）
- `RUN_CACHE_REFRESH=1`：A-class cache refresh 入口检查
- `RUN_SSOT_VERIFY=1`：SSOT wiring 检查
- `RUN_FUNDS=1`：funds-flow invariants suite
- `RUN_ATTACK=1`：attack suite

## 如何运行 Smoke（localhost：推荐一键）

> 推荐优先用 “ephemeral fresh node” 方式跑（最稳定、最接近 CI，一次命令自动起节点并执行 smoke）。

### 方式 0：快速 Smoke（最轻量，默认跳过 funds/attack）

适合本地快速判断“主要链路是否正常”，默认只跑 cache/SSOT/view/viewcache/reward 等关键读写校验：

```bash
pnpm -s run test:smoke:quick:localhost
```

常用开关（与 prodlike runner 一致）：

```bash
RUN_REWARD_SMOKE=0 pnpm -s run test:smoke:quick:localhost
RUN_VIEWCACHE_SMOKE=0 pnpm -s run test:smoke:quick:localhost
```

### 方式 1（最推荐）：一键 fresh（自动起临时节点 + deploy/grant/preconfig）

```bash
pnpm -s run test:smoke:prodlike:localhost:autonode
```

- **默认行为**（见 runner 输出）：`MODE=fresh RUN_DEPLOY=1 RUN_GRANT=1 RUN_PRECONFIG=1`，并执行 cache/SSOT/view/viewcache/reward/funds/attack 等步骤。
- **只想快速验证 Reward**，可跳过 funds/attack（更快）：

```bash
RUN_FUNDS=0 RUN_ATTACK=0 pnpm -s run test:smoke:prodlike:localhost:autonode
```

### 方式 2：手动起 localhost 节点（适合反复调试）

终端 A（起节点）：

```bash
pnpm -s run node
```

终端 B（跑 smoke；fresh 模式会要求“真 fresh node”）：

```bash
MODE=fresh RUN_DEPLOY=1 RUN_GRANT=1 RUN_PRECONFIG=1 pnpm -s run test:smoke:prodlike:localhost
```

如果你是在 dirty state 上跑（更贴近 testnet/mainnet），用：

```bash
MODE=dirty RUN_DEPLOY=0 RUN_GRANT=0 RUN_PRECONFIG=0 pnpm -s run test:smoke:prodlike:localhost
```

## 常见失败与排查（高频）

- **报 `function selector was not recognized`**
  - **含义**：ABI/部署不匹配（代理指向旧实现或未重新部署）。
  - **处理**：`pnpm -s hardhat clean && pnpm -s compile` 后重新 `deploy:localhost`，或直接用 `test:smoke:prodlike:localhost:autonode`。

- **`MissingRole()`**
  - **含义**：角色未授予（常见于手动跑、或 `RUN_GRANT/RUN_PRECONFIG` 关掉了）。
  - **处理**：用 fresh 一键跑；或至少 `RUN_GRANT=1 RUN_PRECONFIG=1`。

- **`ModuleNotRegistered(REWARD_EARN_CONFIG)` / `getModuleOrRevert` 报错**
  - **含义**：Registry 漏绑模块（常见是 EarnConfig/RewardView/LoanFlowView 等）。
  - **处理**：重新 deploy 并确认绑定阶段成功；优先用 autonode runner。

### Reward smoke（本次回归总结）
- **关键前置**：Reward 的可写参数（level multiplier / dynamic params）会通过 `RewardConfig -> Registry[REWARD_EARN_CONFIG] -> EarnConfig` 写入。
  - 若本地链报 `ModuleNotRegistered(REWARD_EARN_CONFIG)`：说明 Registry 漏绑 `REWARD_EARN_CONFIG -> EarnConfig`，需要先修复部署/绑定流程再跑 smoke。
- **常见失败点 1（MODE=fresh）**：`MODE=fresh` 必须在“真 fresh node”上跑，否则 runner 会拒绝执行。
  - 推荐：重启 hardhat node，或使用 `test:smoke:prodlike:localhost:autonode`。
- **常见失败点 2（penalty 抵扣导致余额不足）**：当存在 `pendingPenalty` 时，后续奖励会先抵扣欠分再入账，因此“mint 1 point”不一定让钱包余额立刻达到 1 point。
  - 结论：脚本应按“余额达到阈值”为准（必要时多轮补分），而不是假设一次 mint 足够。

### 方案 A（dirty + 不自动准备；跑 attack 套件做安全/误配扫描）

```bash
MODE=dirty \
RUN_DEPLOY=0 RUN_GRANT=0 RUN_PRECONFIG=0 RUN_CACHE_REFRESH=0 RUN_SSOT_VERIFY=0 \
pnpm -s run test:smoke:prodlike:localhost
```

- **含义**：复用本地链上既有状态（dirty），runner 不做部署/授角色/预配置/刷新/SSOT 校验等“铺路动作”，直接跑攻击/误配/防护类检查（attack suite）。
- **适用**：你想在“最接近真实约束”的前提下，快速暴露 **权限漂移（MissingRole）/误配/升级后风险入口** 等问题。
- **重要说明（你实际跑到的情况）**：
  - 这套配置 **只是在关闭“自动准备环境”的步骤**（deploy / grant / preconfig / cacheRefresh / SSOT verify）。
  - smoke runner 仍可能 **默认继续跑** `funds-flow-invariants-suite` 与 `e2e-localhost-attack-suite`（除非你显式设置 `RUN_FUNDS=0` 或 `RUN_ATTACK=0`）。
  - 因此如果你在方案 A 下看到：
    - **资金流测试套件（funds-flow-invariants-suite）通过**
    - **攻击套件（e2e-localhost-attack-suite）通过**
    这并不矛盾，反而说明：在当前 dirty state 上，所需 **角色/配置/链路** 已经齐备，系统能在“真实约束（不自动 grant）”下稳定跑通。

#### Shell 写法提示（避免 `\RUN_DEPLOY=...` 这种容易写错的形式）

- 推荐最稳妥的 **单行写法**：

```bash
MODE=dirty RUN_DEPLOY=0 RUN_GRANT=0 RUN_PRECONFIG=0 RUN_CACHE_REFRESH=0 RUN_SSOT_VERIFY=0 pnpm -s run test:smoke:prodlike:localhost
```

- 如果用多行续行：请只在 **行尾** 使用 `\`（不要写成 `\RUN_DEPLOY=...`）：

```bash
MODE=dirty \
RUN_DEPLOY=0 RUN_GRANT=0 RUN_PRECONFIG=0 RUN_CACHE_REFRESH=0 RUN_SSOT_VERIFY=0 \
pnpm -s run test:smoke:prodlike:localhost
```

### 方案 B（dirty + 维护链路检查：包含 cache refresh；用于在既有状态上验证缓存机制）

```bash
MODE=dirty \
RUN_DEPLOY=0 RUN_GRANT=0 RUN_PRECONFIG=0 RUN_CACHE_REFRESH=1 RUN_SSOT_VERIFY=0 \
pnpm -s run test:smoke:prodlike:localhost
```

- **含义**：仍然不做 deploy/grant/preconfig（不自动准备环境），但会跑 **cache-refresh-local** 这类维护链路检查：
  - **A-class cache 刷新链路正常**（维护者入口可用）
  - **非授权直刷被拒绝**（防止绕过维护者入口）
- **适用**：你想在 dirty state 下，额外确认“升级/替换模块后缓存刷新与 stale-route 防线”这条链路是可用的。

#### Dirty 模式下的数值变化（例如 aggregated debtValue 变化）如何解读

在 dirty state 中，链上可能已经存在：
- 历史订单/借贷/还款/清算导致的累计状态
- 上一次测试留下的余额、利息、聚合债务等

因此在 `funds-flow-invariants-suite` 里看到 **aggregated debtValue 从 A 的值变成 B 的值** 属于预期（它反映“链状态不同”），只要 suite 的 **不变量/断言通过**，就说明行为在 dirty 模式下依然正确。

### 方案 C（一键跑通、快速回归：fresh + deploy + grant + preconfig）

```bash
MODE=fresh RUN_DEPLOY=1 RUN_GRANT=1 RUN_PRECONFIG=1 \
pnpm -s run test:smoke:prodlike:localhost
```

- **含义**：从干净起点（fresh）自动部署 + 自动授关键角色 + 自动做最小可运行预配置，然后跑 smoke（包含 attack/funds/SSOT/cache 等，具体以 runner 输出的 steps 为准）。
- **适用**：本地快速回归、CI 风格的确定性验证（“一键跑通”优先）。
- **重要**：现在 `MODE=fresh` 会做“真 fresh”检查：如果检测到 localhost 节点不是刚启动的（例如 blockNumber/nonce 已变化、旧 Registry bytecode 已存在），runner 会 **直接失败并提示你重启 node**。
  - **推荐做法**：先停掉旧的 hardhat node，再 `pnpm -s run node` 启一个新的，然后再跑方案 C。
  - **想完全自动**：可用 `pnpm -s run test:smoke:prodlike:localhost:autonode`（会起一个临时 hardhat node 并在结束后自动关闭）。
  - **不推荐的绕过**：`ALLOW_NONFRESH_NODE=1`（相当于把 fresh 降级成 dirty，可能引入跨测试耦合）。

### 方案 D（最轻量上线前 sanity：只跑 cache/SSOT，不跑 funds/attack）

```bash
MODE=dirty RUN_FUNDS=0 RUN_ATTACK=0 \
pnpm -s run test:smoke:prodlike:localhost
```

- **含义**：复用既有链状态（dirty），不跑资金流与攻击套件，主要验证：
  - **A-class cache 刷新链路**（维护者入口可用，非授权直刷被拒绝）
  - **SSOT wiring**（关键参数能从 SSOT 写入并传播到读侧）
- **适用**：上线前/升级后做最短路径“系统连线是否正常”的冒烟。

### 给你一个“如何用这四套方案”的直观对照（团队推荐）

- **想一键跑通、快速回归**：用 **C**（fresh + deploy + grant + preconfig）。
- **想模拟真实：不让脚本帮你补环境，暴露缺口**：用 **A/B**（dirty + 不自动准备）。
- **只想做最轻量的上线前 sanity（cache/SSOT wiring）**：用 **D**。

### funds-flow “不自动 grant” 最接近真实：推荐两段跑法

如果你的目标是 **funds-flow 在真实约束下运行**（不自动授角色/不自动补配置，最贴近真实上线/运维），建议：

1) **先用 A 或 B 跑一遍**，让系统在真实约束下“自然失败”，从输出里定位缺口（通常是缺角色/缺白名单/缺价格/缺参数/链路未联通）。
2) **再由你按团队真实 SOP 补齐**（例如部署后授角色、配置 oracle/whitelist、刷新 cache、核对 SSOT 绑定），然后反复跑 funds-flow，直到在“真实约束”下也能稳定通过。

## 推荐“类生产”冒烟流程（最接近真实运维）

若你的目标是 **最贴近真实上线/运维**（dirty state + 权限最小化 + 升级/刷新/观测链路都覆盖），建议按下面顺序跑：

### A) 全新状态（CI 风格，确定性）

在一个终端中：

```bash
pnpm -s exec hardhat node
```

在另一个终端中：

```bash
pnpm -s exec hardhat run "scripts/deploy/deploylocal.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/grant-required-roles-local.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/preconfig-strict-smoke-local.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/cache-refresh-local.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/verify-config-ssot-local.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/view-schemeu-smoke-local.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/lendingengine-smoke-local.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
pnpm -s exec hardhat run "scripts/e2e/e2e-localhost-attack-suite.ts" --network localhost
```

### B) 脏状态（最接近测试网/主网实际情况）

此模式假定节点已有既有状态（此前部署/升级/用户余额）。
最适合用来暴露：
- 升级后 A 类缓存路由陈旧
- 角色漂移/缺失角色
- view/cache 推送尽力可观测性问题

```bash
pnpm -s exec hardhat run "scripts/tests/cache-refresh-local.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/verify-config-ssot-local.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/view-schemeu-smoke-local.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/lendingengine-smoke-local.ts" --network localhost
E2E_ALLOW_DIRTY_STATE=1 pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
pnpm -s exec hardhat run "scripts/e2e/e2e-localhost-attack-suite.ts" --network localhost
```

---

## Real-chain CI (arbitrum / arbitrum-sepolia)

已提供一个可直接用于 CI 的模板脚本：`scripts/tests/ci-realchain-template.sh`。
它会根据分支名推断 `arbitrum` / `arbitrumSepolia`，并按“读路径必跑、写路径可选”的方式执行。

**推荐组合（最接近真实但安全）**：
- **必跑（读路径）**：
  - `verify-config-ssot-local.ts`
  - `view-schemeu-smoke-local.ts`
  - `viewcache-smoke-local.ts`
- **可选（写路径，需权限）**：
  - `cache-refresh-local.ts`（维护者入口，需要写权限）

**CI 一键模板**：

```bash
bash scripts/tests/ci-realchain-template.sh
```

**必需环境变量**：
- `PRIVATE_KEY`：签名用私钥（即使只读脚本也需要 signer）
- `ARBITRUM_RPC_URL` 或 `ARBITRUM_SEPOLIA_RPC_URL`：按网络选择其一

**可选环境变量（用于覆盖部署/配置）**：
- `REGISTRY_ADDRESS`：目标网络的 Registry 地址
- `VAULT_ROUTER_ADDRESS`：cache-refresh 需要（若脚本无法自行解析）

**可选开关**：
- `CI_NETWORK`：`arbitrum` | `arbitrumSepolia`（覆盖分支推断）
- `RUN_CACHE_REFRESH=1`：启用写路径 `cache-refresh-local.ts`
- `GRANT_ROLE=1`：为 `view-schemeu-smoke-local.ts` 自动授 `VIEW_RISK_DATA`（写路径）
- `REQUIRE_AUTHZ=0`：缺少 `VIEW_RISK_DATA` 时跳过授权读（读路径仍可执行）

**权限清单（真实链）**：
- **只读路径**：无额外角色需求（若 `VIEW_RISK_DATA` 不具备，将自动降级为只跑自读/未授权断言）
- **`view-schemeu-smoke-local.ts` 授权读**：需要 `VIEW_RISK_DATA`
- **`cache-refresh-local.ts` 写路径**：需要维护者/管理员权限（可刷新 A-class cache）

**Hardhat fork（模拟 arbitrumSepolia，最接近真实但不花测试币）**：

```bash
# 1) 启 fork 节点（从 arbitrumSepolia 拉取状态）
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc_url>" \
pnpm -s exec hardhat node --fork "$ARBITRUM_SEPOLIA_RPC_URL"

# 2) 在 fork 上跑“真实链 CI 读路径”（注意：网络仍是 localhost）
READ_ONLY=1 \
pnpm -s exec hardhat run "scripts/tests/verify-config-ssot-local.ts" --network localhost
GRANT_ROLE=0 REQUIRE_AUTHZ=0 \
pnpm -s exec hardhat run "scripts/tests/view-schemeu-smoke-local.ts" --network localhost
READ_ONLY=1 ENABLE_WRITE=0 \
pnpm -s exec hardhat run "scripts/tests/viewcache-smoke-local.ts" --network localhost
```

说明：
- fork 模式下是本地链，**不会消耗**测试网 ETH。
- 若合约地址无法自动解析，可用 `REGISTRY_ADDRESS` 指定目标 Registry。

## LendingEngine 冒烟（更精准反映 LendingEngine 状态）

目标：用**最短链路**验证本地链“借贷引擎链路”可跑通，并对 `LendingEngineView` 提供更精准的可观测断言：

- `VaultCore.deposit` → 质押入账（`CollateralManager.getCollateral`）
- `VaultBusinessLogic.reserveForLending` → 池子资金入账
- `VaultBusinessLogic.finalizeMatch` → 创建订单（解析 `LoanOrderCreated`）
- `LendingEngineView`（对齐 e2e scenario-matrix / batch-advanced 与 ARCH 4.12）：
  - **可观测性**：`getVersionInfo()` 打印 api/schema/implementation；`getRegistryFromEngine()` 与 Registry 地址硬对齐断言；`isMatchEngine(ORDER_ENGINE)` 打印便于定位引擎绑定
  - borrower self-read `getLoanOrder(orderId)` 正常
  - ops read `getLoanOrder(orderId)`（需要 `VIEW_USER_DATA`）与 borrower 视图一致
  - `getDebt(user, asset)` 在借出后等于 principal，完全还款后归零
  - `getFailedFeeAmount/getNftRetryCount`（需要 `VIEW_SYSTEM_DATA`）可调用
  - **LEV-02 相关方可读**：`canAccessLoanOrder(orderId, borrower) === true`；`LoanNFTView.getUserLoanCount(borrower) >= 1` 在 match 后断言
  - **还款后一致性**：repay 后再次用 ops 调 `getLoanOrder(orderId)`，断言 `repaidAmount` 与 borrower 视角一致
- `VaultCore.repay` → 全额还款后 debt 清零；并 best-effort 检查是否自动释放抵押

运行：

```bash
pnpm -s exec hardhat run "scripts/tests/lendingengine-smoke-local.ts" --network localhost
```

常用开关（env）：
- `STRICT=1/0`：默认 1。0 时把“抵押未自动释放”等环境差异降级为 warning（不 hard fail）。
- `E2E_ALLOW_DIRTY_STATE=1`：允许在 dirty state 运行（会优先挑选“无债务且无抵押”的 signer；找不到才回退）。
- `NO_AUTO_GRANT=1`：production-like。脚本不自动授角色；缺角色直接失败（更贴近真实运维约束）。

### 为何更“贴近真实”

- 冒烟脚本本身 **不隐藏自动授角色**（角色必须已存在，与生产一致）。
- **SSOT 健全性检查** 在资金流之前执行（及早发现错误绑定）。
- **缓存刷新入口** 通过统一维护者路径执行（A 类缓存正确性）。
- **View/Scheme U 冒烟** 覆盖 SystemRiskView 路由 + HealthView 公开读 + Scheme U 门控。
- **攻击套件** 广泛扫描入口 + UUPS + 注册表模块集 + view 部署防护。

## 0) 类生产：预先授予所需角色（冒烟脚本内不自动授角色）

冒烟脚本刻意保持 **类生产**：**不会** 在缺少时自动授角色。

所需角色（SSOT：`AccessControlManager`）：

**A) 创建订单冒烟（`funds-flow-smoke-create-order.ts`）**
- **deployer**（执行安装步骤的脚本签名者）必须拥有：
  - **`ACTION_ADD_WHITELIST`**（`keccak256("ADD_WHITELIST")`）— 用于在 `AssetWhitelist` 中放行抵押/债务代币（若尚未放行）
  - **`ACTION_UPDATE_PRICE`**（`keccak256("UPDATE_PRICE")`）— 用于在 `PriceOracle` 中设置价格（若尚未设置）
  - **`ACTION_SET_PARAMETER`**（`keccak256("SET_PARAMETER")`）— 用于更新配置，如 `FeeRouter` 支持代币列表（若需要）
- **VaultBusinessLogic**（模块合约地址）必须拥有：
  - **`ACTION_ORDER_CREATE`**（`keccak256("ORDER_CREATE")`）— 用于调用 `OrderEngine.createLoanOrder`
  - **`ACTION_DEPOSIT`**（`keccak256("DEPOSIT")`）— 用于 match 结算时的费用路由路径
- **OrderEngine**（模块合约地址）必须拥有：
  - **`ACTION_BORROW`**（`keccak256("BORROW")`）— 用于铸造 `LoanNFT` 凭证

此外，协议配置必须已就绪（本脚本 **不会** 自动配置）：
- **AssetWhitelist** 必须放行冒烟使用的代币（localhost 默认：`MockUSDC`）。
- **PriceOracle** 必须具有：
  - **已启用** 的资产配置（如 `coingeckoId="usd-coin"`、`decimals=8`、`maxPriceAge=3600`）
  - **新鲜且有效** 的价格（使 `PriceOracle.getPrice(token)` 不会因 `StalePrice/InvalidPrice` 回滚）
- **FeeRouter** 必须已 **支持** 该代币（即 `FeeRouter.isTokenSupported(token) == true`）。

**B) Keeper 路径严格冒烟（`funds-flow-smoke-local.ts`）**
- **keeper**（调用 `SettlementManager.settleOrLiquidate` 的账户）必须拥有：
  - **`ACTION_LIQUIDATE`**（`keccak256("LIQUIDATE")`）
- **SettlementManager** 必须拥有：
  - **`ACTION_REPAY`**（`keccak256("REPAY")`）
  - **`ACTION_VIEW_SYSTEM_DATA`**（`keccak256("VIEW_SYSTEM_DATA")`）
  - **`ACTION_VIEW_USER_DATA`**（`keccak256("VIEW_USER_DATA")`）— 清算检查时 HealthView Scheme U 读取所需
- **LiquidationRiskManager** 必须拥有：
  - **`ACTION_VIEW_USER_DATA`**（`keccak256("VIEW_USER_DATA")`）— 读取 HealthView 缓存的用户健康因子所需

在 localhost 上（部署后）用以下命令授予：

```bash
pnpm -s exec hardhat run "scripts/tests/grant-required-roles-local.ts" --network localhost
```

## 1) 创建订单并获取 `ORDER_ID`

```bash
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-create-order.ts" --network localhost
```

脚本会输出 `orderId <N>`。后续步骤请使用该值。

## 2) 准备前置条件（余额与授权）

```bash
ORDER_ID=<N> pnpm -s exec hardhat run "scripts/tests/setup-and-test.ts" --network localhost
```

该步骤会设置：
- 借款人抵押代币余额
- 借款人债务代币余额
- 对 `CollateralManager` 的授权（存款路径）
- 对 `VaultCore` 的授权（还款路径）

## 3) 运行严格冒烟测试

```bash
ORDER_ID=<N> pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-local.ts" --network localhost
```

## 说明：严格还款模式（batchRepay）

`SettlementManager` 可启用“必须全额还款才自动释放”的严格模式：

- 若 `requireFullRepayRelease == true`，则 **批量还款必须还清全部债务**。
- 部分还款会以自定义错误 `SettlementManager__DebtNotCleared` 回滚。

`setup-and-test.ts` 会检测该模式，若启用则按 **全额债务** 准备借款人余额与授权。

---

# 资金守恒冒烟测试（代币级不变量）

本冒烟测试校验 ERC20 **totalSupply 不变** 以及 **跟踪地址余额之和守恒**，覆盖清算与还款流程。

```bash
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-conservation.ts" --network localhost
```

常用开关：
- 仅跑清算：`RUN_REPAY=0 ...`
- 仅跑还款：`RUN_LIQUIDATION=0 ...`
- 指定自有订单：
  - `ORDER_ID_LIQ=<N> ORDER_ID_REPAY=<M> ...`

## （新增）非稳定抵押品（mWETH）+ 清算链 oracle/估值边界用例

在稳定币抵押之外扩展冒烟：部署非稳定 ERC20（`mWETH`），作为抵押存入、借出 `MockUSDC`，使仓位逾期后执行
`SettlementManager.settleOrLiquidate`。

用于暴露 **真实清算入口** 中的 oracle/估值边界行为：
- `stale` 抵押价格：`PriceOracle.getPrice` 回滚；`PositionView.getAssetValue` 返回 0；清算可能回滚 `SettlementManager__NoCollateral`。
- `unreasonable` 价格：清算继续（oracle 仍可能返回价格；估值可能极端）。
- `bad_decimals`（<6）：清算继续（PositionView 接受小精度；仅 GD 检查不同）。

### 前置条件（建议以保证可复现）

先启本地节点、部署新模块，再跑冒烟（dirty state 也可；冒烟使用增量）：

```bash
pnpm -s exec hardhat node
```

在新终端中：

```bash
pnpm -s exec hardhat run "scripts/deploy/deploylocal.ts" --network localhost
```

### 1) 新鲜抵押价格（应成功清算）

```bash
CREATE_ORDER=1 RUN_LIQUIDATION=1 RUN_REPAY=0 \
USE_NONSTABLE_COLLATERAL=1 COLLATERAL_PRICE_MODE=fresh \
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-conservation.ts" --network localhost
```

### 2) 陈旧抵押价格（预期边界行为：清算回滚）

在此模式下，因抵押价值被视为 0，清算预期会以 `SettlementManager__NoCollateral` 回滚。
设置 `EXPECT_LIQUIDATION_REVERT`，脚本会将其视为 **预期** 的边界断言并继续执行。

```bash
CREATE_ORDER=1 RUN_LIQUIDATION=1 RUN_REPAY=0 \
USE_NONSTABLE_COLLATERAL=1 COLLATERAL_PRICE_MODE=stale \
EXPECT_LIQUIDATION_REVERT=SettlementManager__NoCollateral \
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-conservation.ts" --network localhost
```

### 3) 不合理抵押价格（应成功清算）

```bash
CREATE_ORDER=1 RUN_LIQUIDATION=1 RUN_REPAY=0 \
USE_NONSTABLE_COLLATERAL=1 COLLATERAL_PRICE_MODE=unreasonable \
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-conservation.ts" --network localhost
```

### 4) 抵押价格精度过小（< 6）（应成功清算）

```bash
CREATE_ORDER=1 RUN_LIQUIDATION=1 RUN_REPAY=0 \
USE_NONSTABLE_COLLATERAL=1 COLLATERAL_PRICE_MODE=bad_decimals \
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-conservation.ts" --network localhost
```

### 说明（dirty state 与费用断言）

- 冒烟设计为在 **dirty state** 下运行：
  - 断言基于 **前后增量**，而非绝对余额。
  - 费用断言使用 SSOT（`FeeDistributed` 事件 + FeeRouter 统计增量）。若环境中 `platformTreasury == ecosystemVault`，脚本仍会正确校验分配。
- 仅做守恒时可关闭费用断言：`ASSERT_FEES_ON_CREATE=0`

---

# 资金流不变量套件（更贴近真实的多场景）

本套件在单条干净流程之外扩展，用于暴露真实借贷平台上会遇到的问题：
- reserve → cancel（资金进出 `LenderPoolVault`）
- partial repay → full repay（需关闭严格模式）
- 严格全额还款模式 + 聚合债务行为（预期先回滚，关闭严格后成功）
- 逾期清算（keeper 路径）

运行：

```bash
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
```

代币选择：
- 默认：使用 `FeeRouter.getSupportedTokens()`
- 覆盖：`TOKENS=tokenAddr1,tokenAddr2`（逗号分隔）

注意：
- `TOKENS` 必须是 **地址** 的逗号分隔列表（如 `TOKENS=0x...`），不能是符号名如 `MockUSDC`。
- localhost 下可从 `frontend-config/contracts-localhost.ts` 使用 `CONTRACT_ADDRESSES.MockUSDC`。

环境开关（默认均启用）：
- 最小模式（关闭其余用例；仅用第一个代币）：
  - `RUN_FINALIZE_MATCH_ONLY=1`：校验 `finalizeMatch` 消耗可观测性：
    - `LendReserveConsumed`
    - `DataPushed(RESERVE_CONSUMED, ...)`（payload 解码并校验）
  - `RUN_MATCH_DISBURSEMENT_ONLY=1`：校验 match → 借出发放的 SSOT 不变量：
    - 池子资金（`LenderPoolVault` 余额减少 principal）
    - `VaultBusinessLogic` 无滞留（余额增量 == 0）
    - 借款人净收入在 (0, principal]
    - 费用接收方 exactly `principal - net`（处理 `platformTreasury == ecosystemVault`）
    - match 期间无抵押追加（CollateralManager 代币余额增量 == 0）
    - 订单/账本一致（`LoanOrder.lender == LenderPoolVault`，`debt == principal`）
- `RUN_RESERVE_CANCEL=0`
- `RUN_PARTIAL_REPAY=0`
- `RUN_STRICT_AGGREGATED_DEBT=0`
- `RUN_LIQUIDATION=0`

严格聚合债务和断言（精确数值检查）：

```bash
ASSERT_AGG_DEBT_SUM=1 AGG_DEBT_PRINCIPAL_A=200 AGG_DEBT_PRINCIPAL_B=300 \
RUN_RESERVE_CANCEL=0 RUN_PARTIAL_REPAY=0 RUN_LIQUIDATION=0 RUN_GUARANTEE_EXTENSION=0 \
RUN_STRICT_AGGREGATED_DEBT=1 \
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
```

说明：
- 在任意还款前断言 `getUserTotalDebtValue == 200 + 300`（按 oracle 价格）。
- 为避免 `finalizeMatch` 时出现 `ERC20InsufficientAllowance`，请确保该资产的 guarantee extension 关闭，
  或若有意保持开启，则预先对借款人授权 `GuaranteeFundManager`。

脏状态累计（10+ 轮）先还款再借：

```bash
E2E_ALLOW_DIRTY_STATE=1 BORROWER_INDEX=2 STRICT_AGG_DEBT_ITERATIONS=10 REBORROW_AFTER_REPAY=1 \
ASSERT_AGG_DEBT_SUM=1 AGG_DEBT_PRINCIPAL_A=200 AGG_DEBT_PRINCIPAL_B=300 AGG_DEBT_PRINCIPAL_C=100 \
RUN_RESERVE_CANCEL=0 RUN_PARTIAL_REPAY=0 RUN_LIQUIDATION=0 RUN_GUARANTEE_EXTENSION=0 \
RUN_STRICT_AGGREGATED_DEBT=1 \
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
```

说明：
- `BORROWER_INDEX` 强制复用同一 signer，以在多轮中验证脏状态累计行为。
- `REBORROW_AFTER_REPAY=1` 在每轮增加「还款后再借」一步。
- 若跑很多轮，可加 `ALLOW_SIGNER_REUSE=1` 避免耗尽未用 signer。
- `BORROWER_INDEXES=2,3,4` 每轮轮换借款人（多借款人脏跑有用）。
- `USE_VARIANT_AMOUNTS=1` 每轮变化 A/B/C 本金（大小混合）。

部分还款 clean vs dirty 对比：

```bash
# Clean (no dirty fallback)
RUN_PARTIAL_REPAY=1 RUN_RESERVE_CANCEL=0 RUN_STRICT_AGGREGATED_DEBT=0 RUN_LIQUIDATION=0 \
RUN_GUARANTEE_EXTENSION=0 \
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost

# Dirty (allow dirty fallback)
E2E_ALLOW_DIRTY_STATE=1 RUN_PARTIAL_REPAY=1 RUN_RESERVE_CANCEL=0 RUN_STRICT_AGGREGATED_DEBT=0 RUN_LIQUIDATION=0 \
RUN_GUARANTEE_EXTENSION=0 \
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
```

---

## 完整压测手册（clean + dirty，50 轮，多借款人，多资产）

### A) Clean 基线（部分还款 + 清算）

```bash
# 1) Fresh node + deploy + grant + preconfig
pnpm -s exec hardhat run "scripts/deploy/deploylocal.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/grant-required-roles-local.ts" --network localhost
pnpm -s exec hardhat run "scripts/tests/preconfig-strict-smoke-local.ts" --network localhost

# 2) Partial repay + liquidation (USDC only)
TOKENS=<MockUSDC> RUN_PARTIAL_REPAY=1 RUN_LIQUIDATION=1 \
RUN_RESERVE_CANCEL=0 RUN_STRICT_AGGREGATED_DEBT=0 RUN_GUARANTEE_EXTENSION=0 \
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
```

### B) Dirty 压测（50 轮循环、借款人轮换、3 代币、再借）

准备（执行一次）：

```bash
# Deploy + configure GOLD/SILV (see helper in local testing scripts)
pnpm -s exec hardhat run "scripts/tests/deploy-gold-silver.ts" --network localhost
```

运行：

```bash
E2E_ALLOW_DIRTY_STATE=1 BORROWER_INDEXES=6,7,8,9,10,11,12 \
STRICT_AGG_DEBT_ITERATIONS=50 REBORROW_AFTER_REPAY=1 ALLOW_SIGNER_REUSE=1 \
USE_VARIANT_AMOUNTS=1 ASSERT_AGG_DEBT_SUM=1 \
AGG_DEBT_PRINCIPAL_A=500 AGG_DEBT_PRINCIPAL_B=25 AGG_DEBT_PRINCIPAL_C=7 \
PRICE_REFRESH_MAP="<GOLD_ADDR>:2000,<SILV_ADDR>:25" \
TOKENS=<MockUSDC>,<GOLD_ADDR>,<SILV_ADDR> \
RUN_RESERVE_CANCEL=0 RUN_PARTIAL_REPAY=0 RUN_LIQUIDATION=0 RUN_GUARANTEE_EXTENSION=0 \
RUN_STRICT_AGGREGATED_DEBT=1 \
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
```

说明：
- 将 `<MockUSDC>` 替换为 `frontend-config/contracts-localhost.ts` 中的地址。
- 将 `<GOLD_ADDR>`/`<SILV_ADDR>` 替换为部署输出中的地址。
- `PRICE_REFRESH_MAP` 可避免新增资产的陈旧价格失败。

---

## 报告模板（复制粘贴）

```
环境：
- Node: localhost
- Deploy: fresh (deploylocal + grant-required-roles + preconfig-strict-smoke)

Clean 基线：
- 部分还款: ✅/❌
- 清算: ✅/❌
- Command:

Dirty 压测：
- 轮数: 50
- 借款人: 6..12 轮换
- 代币: USDC + GOLD + SILV
- 再借: 是
- 变体: 启用
- 结果: ✅/❌
- Command:

备注：
- 错误/日志（如有）：
```

可选角色门控检查（需 AccessControlManager owner）：
- `ASSERT_ROLE_GATES=1`：
  - 临时撤销/授予 `ORDER_CREATE` 和 `DEPOSIT` 角色，以确认 `finalizeMatch` 正确受角色门控。
  - 若非 ACM owner，请保持关闭（默认）。

状态模式：
- Clean/CI 风格：重启 localhost 节点 + 跑 deploylocal + 跑套件。
- Dirty state（更接近测试网/主网）：设置 `E2E_ALLOW_DIRTY_STATE=1`
  （套件会尽量选用「干净」signer；若无则回退到未用 signer）。

推荐最小命令（复制粘贴）：

1) 最小 finalizeMatch 消耗 + RESERVE_CONSUMED DataPush（输出很短）：

```bash
TOKENS=0x071586BA1b380B00B793Cc336fe01106B0BFbE6D \
E2E_ALLOW_DIRTY_STATE=1 RUN_FINALIZE_MATCH_ONLY=1 \
RUN_RESERVE_CANCEL=0 RUN_PARTIAL_REPAY=0 RUN_STRICT_AGGREGATED_DEBT=0 RUN_LIQUIDATION=0 \
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
```

2) 最小 match → 借出发放 SSOT 断言（覆盖 Funds-Flow-Architecture-Guide.md「Finalize Match」+ 发放语义）：

```bash
TOKENS=0x071586BA1b380B00B793Cc336fe01106B0BFbE6D \
E2E_ALLOW_DIRTY_STATE=1 RUN_MATCH_DISBURSEMENT_ONLY=1 \
RUN_RESERVE_CANCEL=0 RUN_PARTIAL_REPAY=0 RUN_STRICT_AGGREGATED_DEBT=0 RUN_LIQUIDATION=0 \
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
```

跟踪地址集：
- `funds-flow-smoke-conservation.ts` 与套件均从 SSOT 配置 **自动发现** 跟踪地址集
  （Registry 模块 + FeeRouter 接收方 + LiquidationPayoutManager 接收方 + VaultCore.viewContractAddrVar()）。
  若资金泄漏到该集外的意外地址，测试会失败并打印差异。

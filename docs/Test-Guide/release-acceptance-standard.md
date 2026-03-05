# 上线/合并验收标准（E2E / Smoke / CI）

> 目的：把“能跑通”变成可重复、可自动化的硬指标，避免把 **SSOT 连线缺口 / View 推送缺口 / 权限漂移** 带到测试网或主网。  
> 参考：`scripts/e2e/README.md`、`scripts/tests/README.md`、`scripts/tests/ci-realchain-template.sh`

---

## 0) 验收范围与核心原则

- **SSOT**：账本（CollateralManager / VaultLendingEngine）与资金链（SettlementManager/OrderEngine）是最终真相；View 只是缓存与聚合。
- **Strict 默认开启**：E2E 作为“部署前最后一道闸”，View/Stats 与 SSOT 不一致应 **硬失败**（除非明确关闭）。
- **不依赖 revert string**：验收必须以 **custom error selector** 或“确实失败/确实成功”的行为为准。

### 0.1 预检（强烈推荐先跑）

在跑 smoke / E2E 前，先做一次“测试矩阵自检”，避免出现“脚本漂移/孤儿脚本/文档引用失效”导致的假阳性：

```bash
pnpm -s exec ts-node --project ./tsconfig.scripts.json scripts/tests/view-matrix-selfcheck.ts
```

---

## 1) E2E 验收（本地 localhost）

> E2E 负责验证：**业务写路径 + View 层一致性 + 路由/权限/版本信息可观测**。  
> 运行方式与 Strict 策略详见：`scripts/e2e/README.md`

### 1.1 必须通过（MUST）

以下脚本在默认 strict 模式下必须通过（exit code=0）：

- **E2E-全量（推荐闸门）**
  - `scripts/e2e/e2e-localhost-full-with-views.ts`
  - 要求：每个步骤后 View 层断言通过；Reward delta 断言通过；产出 artifacts。

- **Reward 专项**
  - `scripts/e2e/e2e-localhost-rewardview-acceptance.ts`
  - `scripts/e2e/e2e-localhost-reward-privacy.ts`
  - `scripts/e2e/e2e-localhost-reward-edgecases.ts`（通过 hardhat task 运行，见 `scripts/e2e/README.md`）

- **路由/发现性（防止地址漂移）**
  - `scripts/e2e/e2e-localhost-systemview-routing.ts`

- **安全攻击套件（最小安全闸）**
  - `scripts/e2e/e2e-localhost-attack-suite.ts`

### 1.2 建议通过（SHOULD）

这些脚本能显著降低“升级后隐藏回归”的概率，建议纳入发布前验收：

- **场景矩阵（含推送失败模拟与重试闭环）**
  - `scripts/e2e/e2e-localhost-scenario-matrix.ts`
- **批量（更贴近真实多用户/多订单）**
  - `scripts/e2e/e2e-localhost-batch-10-users.ts`
  - `scripts/e2e/e2e-localhost-batch-advanced-10-users.ts`

### 1.3 统一 Preflight（强制要求）

- 所有 `e2e-localhost-*-acceptance.ts` 必须在 `main()` 开头执行 view preflight：
  - 统一入口：`scripts/e2e/utils/view-preflight.ts` 的 `runViewPreflight(...)`
- Preflight 必须硬失败的项（摘要）：
  - SystemView ↔ Registry 路由表对齐
  - 版本信息可观测（api/schema/implementation）
  - price 路由 fallback 一致性
  - admin/deployer 具备必要只读角色（避免“临时 grant 混过”）

### 1.4 推荐一键跑法（本地）

严格全量（含 registry rebind + 全脚本循环 + 对齐报告）：

```bash
pnpm -s exec hardhat run scripts/e2e/utils/registry-rebind-from-config.ts --network localhost \
  && for f in scripts/e2e/*.ts; do echo "\n=== Running $f ==="; pnpm -s exec hardhat run "$f" --network localhost || exit $?; done \
  && pnpm -s exec hardhat run scripts/e2e/utils/registry-alignment-report.ts --network localhost
```

**验收判据**：
- 所有脚本 exit code = 0
- `registry-alignment-report` 输出 `mismatches=0`
- E2E artifacts 文件生成（`scripts/e2e/artifacts/*.json`），且包含 RewardView 相关计数与 versionInfo（脚本已内置输出）

---

## 2) Smoke 验收（本地 prod-like runner）

> Smoke 目标：用“生产近似约束”快速发现 **缺角色/缺配置/SSOT wiring 断裂/cache refresh 失效**。  
> 入口与方案 A/B/C/D 见：`scripts/tests/README.md`

### 2.1 必须通过（MUST）

#### A) 推荐默认：方案 C（fresh + deploy + grant + preconfig，一键确定性）

```bash
MODE=fresh RUN_DEPLOY=1 RUN_GRANT=1 RUN_PRECONFIG=1 pnpm -s run test:smoke:prodlike:localhost
```

**验收判据**：
- runner 全步骤完成且 exit code=0
- 输出中包含：SSOT verify、view-schemeu smoke、funds-flow invariants、attack suite（以 runner 实际 steps 为准）

#### B) 生产近似：方案 A 或 B（dirty + 不自动准备，暴露真实缺口）

至少选择 A 或 B 跑通一次，证明“在不自动补环境的情况下系统仍然自洽”：

```bash
# A: 只跑攻击/误配扫描（最贴近真实约束）
MODE=dirty RUN_DEPLOY=0 RUN_GRANT=0 RUN_PRECONFIG=0 RUN_CACHE_REFRESH=0 RUN_SSOT_VERIFY=0 pnpm -s run test:smoke:prodlike:localhost

# B: dirty + 额外验证 cache refresh 维护链路
MODE=dirty RUN_DEPLOY=0 RUN_GRANT=0 RUN_PRECONFIG=0 RUN_CACHE_REFRESH=1 RUN_SSOT_VERIFY=0 pnpm -s run test:smoke:prodlike:localhost
```

### 2.2 建议通过（SHOULD）：拆分脚本的 CI 风格串跑

当你希望更可控的步骤化验收（也便于 CI 并行/重试）：

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

**验收判据**：每一步 exit code=0。

---

## 3) CI 验收（Real-chain / Fork / 常规 CI）

### 3.1 Real-chain CI（arbitrum / arbitrum-sepolia）— 必跑基线

使用模板脚本（参考并按需集成到 CI 平台）：

```bash
bash scripts/tests/ci-realchain-template.sh
```

**默认必跑（读路径）**：
- `scripts/tests/verify-config-ssot-local.ts`
- `scripts/tests/view-schemeu-smoke-local.ts`（允许按开关降级授权读）
- `scripts/tests/viewcache-smoke-local.ts`

**可选（写路径，需要维护者权限）**：
- `scripts/tests/cache-refresh-local.ts`（通过 `RUN_CACHE_REFRESH=1` 启用）

**必需环境变量**（模板脚本会硬失败）：
- `PRIVATE_KEY`
- `ARBITRUM_RPC_URL` 或 `ARBITRUM_SEPOLIA_RPC_URL`

### 3.2 Fork CI（推荐：不花测试币，但用真实链状态）

```bash
ARBITRUM_SEPOLIA_RPC_URL="<your_rpc_url>" pnpm -s exec hardhat node --fork "$ARBITRUM_SEPOLIA_RPC_URL"

READ_ONLY=1 pnpm -s exec hardhat run "scripts/tests/verify-config-ssot-local.ts" --network localhost
GRANT_ROLE=0 REQUIRE_AUTHZ=0 pnpm -s exec hardhat run "scripts/tests/view-schemeu-smoke-local.ts" --network localhost
READ_ONLY=1 ENABLE_WRITE=0 pnpm -s exec hardhat run "scripts/tests/viewcache-smoke-local.ts" --network localhost
```

**验收判据**：三条脚本 exit code=0，且输出明确指出 SSOT wiring 正常、Scheme U 行为符合预期、ViewCache 行为符合 TTL/权限约束。

### 3.3 常规 CI（本地编译/单测）

最低要求：
- `hardhat compile` / TypeChain 生成成功
- `npx hardhat test`（或至少 `test/Reward/` + 关键 View/Registry 测试集）

> 注：本文件重点是“上线闸门标准”，单测的细分清单请以各模块测试指南为准（`docs/Test-Guide/*-testing-guide.md`）。

---

## 4) 验收产物（Evidence）要求

每次“准备合并/准备部署”的验收应至少保留：

- **E2E artifacts**：`scripts/e2e/artifacts/*.json`（包含模块快照、RewardView versionInfo、DataPushed 计数等）
- **Registry 对齐报告**：`registry-alignment-report` 输出（`mismatches=0`）
- **Smoke runner 输出日志**：至少包含 mode/steps/失败原因（用于排障复现）


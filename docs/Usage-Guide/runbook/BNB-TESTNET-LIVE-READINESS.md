# BNB Testnet Live 测试就绪检查清单

**生成时间**: 2026-04-05  
**状态**: ✅ 就绪（待补充 tBNB）

---

## 1. 代码修补完成

### ✅ 统一接入 `runWithNetworkRetry`

已为以下脚本应用网络重试包装，保证网络抖动时的自动重试能力：

**Fee Domain (5个脚本)**
- [x] `live-fee-accounting.ts` (line 143)
- [x] `live-fee-prepaid-gate.ts` (line 246)
- [x] `live-fee-remaining-gate.ts` (line 219)
- [x] `live-fee-dynamic-gate.ts` (line 281)
- [x] `live-fee-baseline.ts` (line 46)

**Guarantee Domain (2个脚本)**
- [x] `live-guarantee-baseline.ts` (line 44)
- [x] `live-guarantee-flow.ts` (line 569)

**Release Gates Orchestrator (1个脚本)**
- [x] `live-release-gates.ts` (line 214)

**修改模式**: 统一替换为
```typescript
export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
```

**导入已补充**:
```typescript
import { runWithNetworkRetry } from "./_networkRetry";
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "./_scriptStatus";
```

---

## 2. 测试边界清晰性

### BNB Testnet 测试范围

**统一入口** (共享脚本，自动在两条链间复用)
- 数量: 40+ 脚本（无网络后缀）
- 位置: `scripts/tests/live-test/live-*.ts`
- 包含: Platform、Fee、Reward、Guarantee、Liquidation、View modules

**BNB 专用入口** (thin wrappers with `runBnbSharedLiveScript`)
- 位置: `scripts/tests/live-test/networks/bnb-testnet/`
- 模式: 代理到共享实现 + 环境配置
- 例: `live-platform-baseline.ts` → 调用 `../../live-platform-baseline.ts`

### Arbitrum Sepolia 专用脚本

**仅 Arbitrum 运行** (10个脚本，带 `-arbitrum-sepolia` 后缀)
```
live-blocks-only-liquidation.ts
live-event-history-manager-arbitrum-sepolia.ts
live-guarantee-events-datapush-arbitrum-sepolia.ts
live-lending-engine-view-arbitrum-sepolia.ts
live-liquidation-arbitrum-sepolia.ts
live-liquidation-view-assertions-arbitrum-sepolia.ts
live-ops-extension-modules-arbitrum-sepolia.ts
live-release-dryrun-arbitrum-sepolia.ts
live-release-gates-arbitrum-sepolia.ts
live-reward-lender-view-arbitrum-sepolia.ts
```

**边界规则**
| 维度 | BNB Testnet | Arbitrum Sepolia |
|-----|-----------|------------------|
| 共享脚本 | ✅ 40+ 脚本 | ✅ 40+ 脚本 |
| 专用脚本 | 0 | 10 个 `-arbitrum-sepolia` |
| 部署方式 | 真实网络 RPC | 真实网络 RPC |
| Fresh Borrower | ✅ 自动补资 + Sweep | ❌ 不适用 |
| 焦点 | 整体资金链上线验证 | Arbitrum 专用特性验证 |

---

## 3. tBNB 账户充足性

### 当前余额（BNB Testnet 检测结果）

```
=== BNB Testnet Account Balance Check ===

Deployer (PRIVATE_KEY):
  Address: 0xe8a87c766E5612E47dCbb403b1551108910E12D3
  Balance: 1.079306523578653362 tBNB
  ✅ Sufficient (>0.5)

Borrower (BORROWER_PRIVATE_KEY):
  Address: 0x381fE833cceac267AB0e41d17373D9e16e7118a7
  Balance: 0.2001971786 tBNB
  ⚠️  LOW - 需要补充

Lender (LENDER_PRIVATE_KEY):
  Address: 0x4d24F8dd96e1DB55BBA487877A1Ef87103EF4E26
  Balance: 0.2044762382 tBNB
  ⚠️  LOW - 需要补充

Viewer (VIEWER_ADDRESS):
  Address: 0x381fE833cceac267AB0e41d17373D9e16e7118a7
  Balance: 0.2001971786 tBNB
  (Same as Borrower)
```

### 💰 需要补充的账户

**立即行动:**

1. **Borrower** (`0x381fE833cceac267AB0e41d17373D9e16e7118a7`)
   - 当前: 0.20 tBNB
   - 建议补充: **0.5 tBNB** (合计达 0.7)
   - 用途: Fresh borrower allocation + 多轮测试 buffer

2. **Lender** (`0x4d24F8dd96e1DB55BBA487877A1Ef87103EF4E26`)
   - 当前: 0.20 tBNB
   - 建议补充: **0.5 tBNB** (合计达 0.7)
   - 用途: Reserve + lending flow

**补充方式:**
- BNB Testnet 官方 Faucet: https://testnet.binance.org/faucet-smart
- 或从 Deployer (1.07 tBNB 充足) 手工转账

---

## 4. 网络重试策略完整激活

### 环境变量配置

推荐在执行 live 测试前设置：

```bash
export LIVE_NETWORK_MAX_ATTEMPTS=3
export LIVE_NETWORK_BASE_DELAY_MS=1500
export LIVE_RPC_POOL="https://bsc-testnet.bnbchain.org,https://bsc-testnet-dataseed.bnbchain.org,https://bsc-prebsc-dataseed.bnbchain.org"
export LIVE_FRESH_BORROWER_NATIVE_ETH=0.0003
export LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH=0.00005
export LIVE_RELAYER_NATIVE_TARGET_ETH=0.0003
export LIVE_FRESH_BORROWER_SWEEP_ERC20=1
```

### 重试覆盖范围

| 脚本 | 重试 | 备注 |
|-----|-----|------|
| Platform Baseline | ✅ | 核心资金链 |
| Fee Accounting | ✅ | *刚修复* |
| Fee Gates (Prepaid/Remaining/Dynamic) | ✅ | *刚修复* |
| Guarantee Flow | ✅ | *刚修复* |
| Reward Baseline | ✅ | 包括多借款人压力 |
| Release Gates Orchestrator | ✅ | *刚修复* |

**重试逻辑**: 仅在网络错误（ECONNRESET、ETIMEDOUT、socket hang up 等）时自动重试，业务错误立即失败。

---

## 5. Fresh Borrower & Sweep 系统就绪

### ✅ 自动补资确认

```typescript
// 来自 _freshBorrowerManager.ts
ensureRecoverableNativeTopUp() // 从 sponsor 池自动补充原生 BNB
  - Relayer 账户: 0.0003 tBNB per fresh borrower
  - Lender 账户: 0.0003 tBNB per fresh borrower
  - Viewer 账户: 0.0003 tBNB per fresh borrower
  - Updater 账户: 0.0003 tBNB per fresh borrower
```

### ✅ 自动 Sweep 确认

```typescript
// 来自 _freshBorrowerManager.ts
installAutoSweepHooks()
  + process.beforeExit 监听器
  + process.exit 拦截器
  ⇒ 保证成功/失败都会 sweep
```

### ✅ 手工 Sweep 兜底

```bash
set -a && source .env && set +a && \
pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/sweep-fresh-borrowers.ts --network bnbTestnet
```

**State 文件位置**: `scripts/tests/logs/fresh-borrowers/bnb-testnet/`

---

## 6. 执行顺序建议

### Gate 分层执行（推荐）

为兼顾“严格测试”和“结果准确”，建议按两层执行：

1. Layer-A（Correctness Strict，默认放行门）
2. Layer-B（Architecture Strict，专项一致性门）

执行规则：

1. 先跑 Layer-A，作为上线主证据。
2. 再跑 Layer-B，作为架构一致性专项证据。
3. 两层证据目录分开保存，避免相互覆盖。

reserve 相关配置建议：

1. Layer-A：`LIVE_STRICT_RESERVE_EXPECTED_MODEL=auto`
2. Layer-B：`LIVE_STRICT_RESERVE_EXPECTED_MODEL=transfer`

### Phase 1: 基础验证

```bash
set -a && source .env && set +a

# 1.1 Platform 双层
  pnpm -s run test:live:platform-runtime-baseline:bnb-testnet
  pnpm -s run test:live:platform-observability-evidence:bnb-testnet

# 1.2 Fee baseline
  pnpm -s run test:live:fee-baseline:bnb-testnet
```

### Phase 2: 域验证

```bash
# 2.1 Reward baseline (含多借款人压力)
  pnpm -s run test:live:reward-baseline:bnb-testnet

# 2.2 Guarantee baseline (含边界)
  pnpm -s run test:live:guarantee-baseline:bnb-testnet
```

### Phase 3: 统一门禁

```bash
# 3.1 Layer-A（默认放行门）
  pnpm -s run test:live:release-gates:bnb-testnet:layer-a

# 3.2 Layer-B（架构专项门）
  pnpm -s run test:live:release-gates:bnb-testnet:layer-b
```

### Phase 4: 手工 Sweep + 证据检查

```bash
set -a && source .env && set +a && \
pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/sweep-fresh-borrowers.ts --network bnbTestnet

# 检查日志
cat scripts/tests/logs/fresh-borrowers/bnb-testnet/sweep-*.json
```

---

## 7. 上线前检查清单

- [ ] **tBNB 充足**  
  - [ ] Borrower: 0.7 tBNB (当前 0.2, 需补 0.5)
  - [ ] Lender: 0.7 tBNB (当前 0.2, 需补 0.5)

- [ ] **网络配置**
  - [ ] `LIVE_RPC_POOL` 已配置并可轮换
  - [ ] `LIVE_NETWORK_MAX_ATTEMPTS=3`
  - [ ] `LIVE_NETWORK_BASE_DELAY_MS=1500`

- [ ] **Gate 分层执行**
  - [ ] Layer-A（Correctness Strict）通过
  - [ ] Layer-B（Architecture Strict）完成并留痕

- [ ] **代码编译**
  - [ ] `pnpm run -s compile` 成功
  - [ ] 无 TypeScript 类型错误

- [ ] **Phase 1-3 执行**
  - [ ] Platform baseline 通过 (runtime + observability)
  - [ ] Fee baseline 通过
  - [ ] Reward baseline 通过 (含多借款人压力)
  - [ ] Guarantee baseline 通过
  - [ ] Layer-A gate 通过
  - [ ] Layer-B gate 完成并留痕

- [ ] **Sweep 证明**
  - [ ] 手工 sweep 完成
  - [ ] `scripts/tests/logs/fresh-borrowers/bnb-testnet/` 中有兜底证据

- [ ] **文档更新**
  - [ ] BNB-Testnet-Live-Runbook.md Section 3.1 (网络重试策略) 已应用

---

## 8. 故障回源指南

### 网络抖动时

```bash
# 1. 启用重试
export LIVE_NETWORK_MAX_ATTEMPTS=3
export LIVE_NETWORK_BASE_DELAY_MS=1500

# 2. 从失败的层重启，不要全量重跑
pnpm -s run test:live:fee-baseline:bnb-testnet        # 若 fee 失败
pnpm -s run test:live:reward-baseline:bnb-testnet     # 若 reward 失败
pnpm -s run test:live:guarantee-baseline:bnb-testnet  # 若 guarantee 失败

# 3. 若连续两轮同类错误，切换 RPC 节点
```

### 资金不足时

```bash
# 检查 relayer/sponsor 账户
pnpm exec hardhat run scripts/check-bnb-balances.ts --network bnbTestnet

# 若低于 0.5，执行补资
DEBUG_NATIVE_MIN_ETH=0.01 \
DEBUG_NATIVE_SPONSOR_RESERVE_ETH=0.0002 \
pnpm -s exec hardhat run scripts/debug/fund-live-native.ts --network bnbTestnet
```

### Fresh Borrower 残余积累时

```bash
# 显式 cleanup
set -a && source .env && set +a && \
pnpm -s exec hardhat run scripts/tests/live-test/networks/bnb-testnet/sweep-fresh-borrowers.ts --network bnbTestnet
```

---

## 9. 改动摘要

### 代码修补

| 文件 | 改动 | 验证状态 |
|-----|-----|--------|
| live-fee-accounting.ts | 导入 + export | ✅ |
| live-fee-prepaid-gate.ts | 导入 + export | ✅ |
| live-fee-remaining-gate.ts | 导入 + export | ✅ |
| live-fee-dynamic-gate.ts | 导入 + export | ✅ |
| live-fee-baseline.ts | 导入 + export | ✅ |
| live-guarantee-baseline.ts | 导入 + export | ✅ |
| live-guarantee-flow.ts | 导入 + export | ✅ |
| live-release-gates.ts | 导入 + export | ✅ |

### 新增脚本

- `scripts/check-bnb-balances.ts` - tBNB 余额检查工具（可复用）

### 文档更新

- `docs/Usage-Guide/runbook/BNB-Testnet-Live-Runbook.md` - Section 3.1 已补充

---

## 10. 下一步行动

### 立即完成

1. **补充 tBNB**
   - Borrower: 发送 0.5 tBNB 到 `0x381fE833cceac267AB0e41d17373D9e16e7118a7`
   - Lender: 发送 0.5 tBNB 到 `0x4d24F8dd96e1DB55BBA487877A1Ef87103EF4E26`

2. **触发测试执行**
   ```bash
   cd /Volumes/AI-hosts/contracts
   set -a && source .env && set +a
   pnpm -s run test:live:platform-runtime-baseline:bnb-testnet
   ```

### 可选优化

- [ ] 增加 Section 3.2: "常见网络错误决策树"
- [ ] 补充 Arbitrum 专用脚本的执行说明
- [ ] 记录各阶段典型执行时间（用于超时配置）

---

**检查完成**: 2026-04-05  
**下次建议复查**: 首次上线后 7 天  
**联系方式**: 详见 [Runbook README](./README.md)

# 前端修改指南（Frontend Modification Guide）

> **文档定位**：基于链上合约架构升级（`docs/Architecture-Guide.md`）、前端集成规范（`docs/FRONTEND_CONTRACTS_INTEGRATION.md`）和 SaaS 后端修正计划（`docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md`）的综合评估，为 `easifi-monorepo-wt/Frontend` 给出**逐模块、逐文件的修改指南**。
>
> **核心策略**：在现有前端代码库上**原地修正**，不推倒重来。现有代码已具备 Next.js 14 + wagmi/viem + ethers v6 + Zustand 全套能力，问题集中在：
> 1. View 层接口未对齐（仍在用旧 VaultRouter 读接口）
> 2. Meta 字段（`isValid/blockNumber/version`）未做降级展示
> 3. Block-based 时间语义未实现 ETA 映射
> 4. Reward/AI Credits 链下镜像与后端幂等 Key 未统一
> 5. Module Keys 与链上 `ModuleKeys.sol` 存在偏差

---

## 目录

1. [修改优先级总览](#1-修改优先级总览)
2. [P0：合约地址解析与 Registry 对齐](#2-p0合约地址解析与-registry-对齐)
3. [P0：View 层接口迁移（VaultRouter → 专属 View）](#3-p0view-层接口迁移vaultrouter--专属-view)
4. [P0：Meta 字段处理（isValid/blockNumber/version）](#4-p0meta-字段处理isvalidblocknumberversion)
5. [P1：Block-based 时间与 ETA 映射](#5-p1block-based-时间与-eta-映射)
6. [P1：Reward 系统前端适配](#6-p1reward-系统前端适配)
7. [P1：AI Credits 计费集成](#7-p1ai-credits-计费集成)
8. [P2：EIP-712 签名与撮合流程](#8-p2eip-712-签名与撮合流程)
9. [P2：统一事件订阅（DataPushed）](#9-p2统一事件订阅datapushed)
10. [P2：Custom Error 精准识别](#10-p2custom-error-精准识别)
11. [P3：后端幂等 Key 与多租户适配](#11-p3后端幂等-key-与多租户适配)
12. [P3：Stripe 计费前端集成](#12-p3stripe-计费前端集成)
13. [逐文件修改清单](#13-逐文件修改清单)
14. [新增文件清单](#14-新增文件清单)
15. [TypeChain / ABI 更新流程](#15-typechain--abi-更新流程)
16. [测试与验收标准](#16-测试与验收标准)
17. [前后端并行实施计划](#17-前后端并行实施计划)

---

## 1. 修改优先级总览

| 优先级 | 模块 | 影响范围 | 预计工期 |
|--------|------|---------|---------|
| **P0** | Registry 地址解析对齐 | 全局（所有合约交互） | 1–2 天 |
| **P0** | View 层接口迁移 | 所有读数据的页面/Hook | 2–3 天 |
| **P0** | Meta 字段降级展示 | 所有展示合约数据的组件 | 1–2 天 |
| **P1** | Block-based ETA 映射 | 到期/截止/缓存年龄展示 | 1 天 |
| **P1** | Reward 系统适配 | 积分/等级/消费相关页面 | 2 天 |
| **P1** | AI Credits 计费集成 | AI 功能相关页面 | 2 天 |
| **P2** | EIP-712 签名（termBlocks） | 借贷/撮合流程 | 1–2 天 |
| **P2** | DataPushed 事件订阅 | 实时数据更新 | 1 天 |
| **P2** | Custom Error 识别 | 错误处理 | 1 天 |
| **P3** | 后端幂等/多租户适配 | API 调用层 | 1 天 |
| **P3** | Stripe 计费 UI | 订阅管理页面 | 1–2 天 |

**总预计工期**：2–3 周（与后端修正并行）

---

## 2. P0：合约地址解析与 Registry 对齐

### 2.1 现状分析

当前前端地址解析已有基础：
- `src/services/client/registryClient.ts` — Registry 合约客户端
- `src/lib/registryResolver.ts` — 动态解析 + 缓存
- `src/services/config/moduleKeys.ts` — Module Key 常量

**问题**：
1. `moduleKeys.ts` 中的 KEY 列表与链上 `src/constants/ModuleKeys.sol` 不完整（缺少新增 View、Reward、AI Credits 等模块）
2. 缺少 Preflight 对齐校验（确保 Registry 与 SystemView 一致）
3. 启动时未统一"先读 `frontend-config/contracts-localhost.ts` → 再用 Registry 覆盖"的策略

### 2.2 必须修改的文件

#### `src/services/config/moduleKeys.ts`（重写）

```typescript
import { keccak256, toUtf8Bytes } from 'ethers';

/**
 * Module Keys
 * - 合约侧“强约束/被合约内部引用”的 KEY：应与链上 src/constants/ModuleKeys.sol 对齐（SSOT）
 * - 仅用于前端/脚本解析 View 模块的 KEY：可走 Registry 动态 key 体系（以部署脚本绑定的字符串为准）
 *
 * 新增/改动任何 KEY 必须同步到这里（以及对应的部署绑定/环境配置）。
 * 生成规则：keccak256(toUtf8Bytes("UPPER_SNAKE_CASE"))
 */
export const MODULE_KEY_NAMES = {
  // ===== 核心模块 =====
  REGISTRY: 'REGISTRY',
  VAULT_CORE: 'VAULT_CORE',
  VAULT_ROUTER: 'VAULT_ROUTER',
  LENDING_ENGINE: 'LENDING_ENGINE',
  COLLATERAL_MANAGER: 'COLLATERAL_MANAGER',
  SETTLEMENT_MANAGER: 'SETTLEMENT_MANAGER',
  ORDER_ENGINE: 'ORDER_ENGINE',
  VAULT_BUSINESS_LOGIC: 'VAULT_BUSINESS_LOGIC',

  // ===== 权限与白名单 =====
  ACCESS_CONTROL_MANAGER: 'ACCESS_CONTROL_MANAGER',
  ASSET_WHITELIST: 'ASSET_WHITELIST',

  // ===== 预言机与价格 =====
  PRICE_ORACLE: 'PRICE_ORACLE',
  COIN_GECKO_PRICE_UPDATER: 'COIN_GECKO_PRICE_UPDATER',

  // ===== 费用 =====
  FEE_ROUTER: 'FEE_ROUTER',

  // ===== Reward 系统 =====
  REWARD_MANAGER: 'REWARD_MANAGER',
  REWARD_MANAGER_CORE: 'REWARD_MANAGER_CORE',
  REWARD_CONSUMPTION: 'REWARD_CONSUMPTION',
  EASY_TOKEN: 'EASY_TOKEN', // EasyToken SSOT（Registry[KEY_EASY_TOKEN]）
  REWARD_VIEW: 'REWARD_VIEW',
  REWARD_CONFIG: 'REWARD_CONFIG',
  REWARD_EARN_CONFIG: 'REWARD_EARN_CONFIG',

  // ===== AI Credits =====
  AI_CREDITS_VAULT: 'AI_CREDITS_VAULT',

  // ===== View 模块 =====
  POSITION_VIEW: 'POSITION_VIEW',
  HEALTH_VIEW: 'HEALTH_VIEW',
  VAULT_STATISTICS: 'VAULT_STATISTICS',  // KEY_STATS → StatisticsView
  STATS_PUSH_MANAGER: 'STATS_PUSH_MANAGER',
  USER_VIEW: 'USER_VIEW',
  SYSTEM_VIEW: 'SYSTEM_VIEW',
  BATCH_VIEW: 'BATCH_VIEW',
  REGISTRY_VIEW: 'REGISTRY_VIEW',
  DASHBOARD_VIEW: 'DASHBOARD_VIEW',
  CACHE_OPTIMIZED_VIEW: 'CACHE_OPTIMIZED_VIEW',
  PREVIEW_VIEW: 'PREVIEW_VIEW',
  RISK_VIEW: 'RISK_VIEW',
  SYSTEM_RISK_VIEW: 'SYSTEM_RISK_VIEW',
  VALUATION_ORACLE_VIEW: 'VALUATION_ORACLE_VIEW',
  FEE_ROUTER_VIEW: 'FEE_ROUTER_VIEW',
  LENDING_ENGINE_VIEW: 'LENDING_ENGINE_VIEW',
  MODULE_HEALTH_VIEW: 'MODULE_HEALTH_VIEW',
  ACCESS_CONTROL_VIEW: 'ACCESS_CONTROL_VIEW',
  VIEW_CACHE: 'VIEW_CACHE',
  LOAN_FLOW_VIEW: 'LOAN_FLOW_VIEW',
  // 用户维度借贷枚举（LoanNFT 枚举入口）
  LOAN_NFT_VIEW: 'LOAN_NFT_VIEW',

  // ===== 清算 =====
  LIQUIDATION_MANAGER: 'LIQUIDATION_MANAGER',
  LIQUIDATION_CONFIG_MANAGER: 'LIQUIDATION_CONFIG_MANAGER',
  LIQUIDATION_RISK_MANAGER: 'LIQUIDATION_RISK_MANAGER',
  LIQUIDATION_RISK_VIEW: 'LIQUIDATION_RISK_VIEW',
  LIQUIDATOR_VIEW: 'LIQUIDATOR_VIEW',
  LIQUIDATION_PAYOUT_MANAGER: 'LIQUIDATION_PAYOUT_MANAGER',

  // ===== 资金池 =====
  LENDER_POOL_VAULT: 'LENDER_POOL_VAULT',
  GUARANTEE_FUND_MANAGER: 'GUARANTEE_FUND_MANAGER',
  EARLY_REPAYMENT_GUARANTEE_MANAGER: 'EARLY_REPAYMENT_GUARANTEE_MANAGER',

  // ===== 监控 =====
  DEGRADATION_CORE: 'DEGRADATION_CORE',
  DEGRADATION_MONITOR: 'DEGRADATION_MONITOR',

  // ===== NFT =====
  LOAN_NFT: 'LOAN_NFT',
} as const;

export type ModuleKeyName = keyof typeof MODULE_KEY_NAMES;

/** 生成 bytes32 module key */
export const key = (name: ModuleKeyName): string =>
  keccak256(toUtf8Bytes(MODULE_KEY_NAMES[name]));

/** 反向映射：bytes32 → 可读名称 */
const _reverseMap = new Map<string, ModuleKeyName>();
(Object.keys(MODULE_KEY_NAMES) as ModuleKeyName[]).forEach((k) => {
  _reverseMap.set(key(k).toLowerCase(), k);
});

export const decodeModuleKey = (bytes32Key: string): ModuleKeyName | null =>
  _reverseMap.get(bytes32Key.toLowerCase()) ?? null;
```

#### `src/lib/registryResolver.ts`（修正）

需要修正以下内容：
1. 启动时先读 `frontend-config/contracts-localhost.ts` 作为初始值
2. 随后用 Registry 解析结果覆盖
3. 对每个 View 调用 `getVersionInfo()` 做 Preflight 校验
4. 监听 `ModuleAddressUpdated` 事件保持热更新

```typescript
// 在现有 registryResolver.ts 中新增/修改：

import { key, MODULE_KEY_NAMES, type ModuleKeyName } from '@/services/config/moduleKeys';

interface ResolvedModule {
  address: string;
  resolvedAt: number;     // block number
  source: 'registry' | 'fallback';
}

// 启动时"先 fallback 后 Registry"策略
export async function initializeModuleAddresses(
  registryAddr: string,
  provider: ethers.Provider,
  fallbackConfig: Record<string, string>
): Promise<Map<ModuleKeyName, ResolvedModule>> {
  const resolved = new Map<ModuleKeyName, ResolvedModule>();

  // Phase 1: 使用 fallback config 填充初始值
  for (const [name, addr] of Object.entries(fallbackConfig)) {
    if (addr && addr !== ethers.ZeroAddress) {
      resolved.set(name as ModuleKeyName, {
        address: addr,
        resolvedAt: 0,
        source: 'fallback',
      });
    }
  }

  // Phase 2: 用 Registry 覆盖
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, provider);
  const currentBlock = await provider.getBlockNumber();

  for (const name of Object.keys(MODULE_KEY_NAMES) as ModuleKeyName[]) {
    try {
      const moduleKey = key(name);
      const addr = await registry.getModule(moduleKey);
      if (addr && addr !== ethers.ZeroAddress) {
        // 可选：getCode 校验
        const code = await provider.getCode(addr);
        if (code !== '0x') {
          resolved.set(name, {
            address: addr,
            resolvedAt: currentBlock,
            source: 'registry',
          });
        }
      }
    } catch {
      // Registry 解析失败，保留 fallback
    }
  }

  return resolved;
}
```

#### `src/hooks/useRegistry.ts`（扩展）

新增 Preflight 和热更新逻辑：

```typescript
// 新增：Preflight 权限检查 hook
export function usePermissionPreflight(accessControlViewAddr: string | undefined) {
  const { data: signer } = useAccount();
  // ... 调用 AccessControlView.getUserPermissionWithMeta 做权限预检
  // 返回 { canViewUserData, canViewSystemData, meta }
}
```

---

## 3. P0：View 层接口迁移（VaultRouter → 专属 View）

### 3.1 迁移映射表

| 旧接口（VaultRouter/直连） | 新接口（专属 View） | 前端文件影响 |
|-------------------------|-----------------|------------|
| `VaultRouter.getUserCollateral` | `UserView.getUserCollateral(user, asset)` | `usePortfolio`, `fetchers.ts` |
| `VaultRouter.getUserPosition` | `PositionView.getUserPositionWithMeta(user, asset)` | `usePortfolio`, `VaultViewService.ts` |
| `VaultRouter.getUserDebt` | `UserView.getUserDebt(user, asset)` | `usePortfolio` |
| `VaultRouter.getHealthFactor` | `UserView.getHealthFactor(user)` 或 `HealthView.getUserHealthFactorWithMeta(user)` | 仪表盘组件 |
| 直连 `RewardManagerCore` | `RewardView.getUserBalanceWithMeta(user)` | `useRewardBalance`, `rewardStore` |
| 批量查询（自行循环） | `CacheOptimizedView.batchGetUserPositionsWithMeta(users[], assets[])` | 列表页 |
| 价格查询 | `ValuationOracleView.getAssetPrice(asset)` | 价格展示组件 |
| 清算查询 | `LiquidatorView.getLiquidatorProfitView(user)` | 清算相关页面 |
| 系统风险参数 | `SystemRiskView.getLiquidationThreshold()` | 风控展示 |
| 用户借贷枚举（列表/数量） | `LoanNFTView.getUserLoansPaginated(user, offset, limit)` / `LoanNFTView.getUserLoanCount(user)` + `LendingEngineView.getLoanOrder(orderId)` | 借贷订单列表页、用户中心 |

### 3.3 P0：用户借贷枚举改造（LoanNFTView + LendingEngineView）

> **目标**：前端不要通过“全局 orderId 扫描/猜测”来拿到用户订单列表。
> 推荐路径：
> 1) 通过 `LoanNFTView` 枚举 `user -> (tokenId, orderId, status)`
> 2) 再用 `LendingEngineView.getLoanOrder(orderId)` 拉订单详情

#### 3.3.1 地址解析（通过 Registry 动态 key）

```typescript
import { ethers } from 'ethers';
import { key } from '@/services/config/moduleKeys';

export async function resolveLoanViews(provider: ethers.Provider, registryAddr: string) {
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, provider);

  const lendingEngineViewAddr = await registry.getModuleOrRevert(key('LENDING_ENGINE_VIEW'));
  const loanNftViewAddr = await registry.getModuleOrRevert(key('LOAN_NFT_VIEW'));

  const lendingEngineView = new ethers.Contract(lendingEngineViewAddr, LENDING_ENGINE_VIEW_ABI, provider);
  const loanNftView = new ethers.Contract(loanNftViewAddr, LOAN_NFT_VIEW_ABI, provider);

  return { lendingEngineView, loanNftView };
}
```

#### 3.3.2 列表页拉取流程（分页 + 限制）

注意：`LoanNFTView` 的分页 `limit` 受 `MAX_BATCH_SIZE=100` 约束，超过会 revert；列表页必须做分页或分片。

```typescript
type UserLoanNftItem = {
  tokenId: bigint;
  orderId: bigint;
  status: bigint; // enum ordinal
};

export async function fetchUserLoanOrders(
  provider: ethers.Provider,
  registryAddr: string,
  user: string,
  offset: bigint,
  limit: bigint,
) {
  const { lendingEngineView, loanNftView } = await resolveLoanViews(provider, registryAddr);

  const [items, totalCount, isValid, blockNumber] = await loanNftView.getUserLoansPaginated(user, offset, limit);

  // items: { tokenId, orderId, status }[]
  const orderDetails = await Promise.all(
    (items as UserLoanNftItem[]).map((it) => lendingEngineView.getLoanOrder(it.orderId))
  );

  return {
    items,
    orderDetails,
    meta: { isValid, blockNumber },
    totalCount,
  };
}
```

#### 3.3.3 权限/隐私口径（Scheme U）

- `LoanNFTView.getUser*`：
  - **用户本人**读取自己的数据：允许
  - 非本人读取：需要 `VIEW_USER_DATA` 或 `ACTION_ADMIN`
- `LendingEngineView.getLoanOrder(orderId)`：
  - borrower/lender/self（在 `canAccessLoanOrder` gate 下）允许；否则需要 `VIEW_USER_DATA`/admin

因此：
- 纯前端（用户自己浏览自己的订单）：用用户 signer/provider 直连 `LoanNFTView` 是 OK 的
- SaaS 后端代查（帮用户查别人的数据）：后端 signer 必须具备 `VIEW_USER_DATA` 或 admin

### 3.2 需要修改的文件

#### `src/services/contracts/VaultViewService.ts`（重构）

当前该文件 re-exports 自 `@backend`。需要重构为直接调用链上 View 模块：

```typescript
import { ethers } from 'ethers';
import { key } from '@/services/config/moduleKeys';

export class VaultViewService {
  private provider: ethers.Provider;
  private moduleAddresses: Map<string, string>;

  /**
   * 获取用户仓位（推荐入口：PositionView）
   * 返回含 meta 的 tuple
   */
  async getUserPosition(user: string, asset: string) {
    const pvAddr = this.moduleAddresses.get('POSITION_VIEW');
    if (!pvAddr) throw new Error('PositionView not resolved');
    const pv = new ethers.Contract(pvAddr, POSITION_VIEW_ABI, this.provider);
    const [collateral, debt, isValid, blockNumber, version] =
      await pv.getUserPositionWithMeta(user, asset);
    return { collateral, debt, isValid, blockNumber, version };
  }

  /**
   * 获取用户概览（推荐入口：DashboardView）
   */
  async getUserOverview(user: string, assets: string[]) {
    const dvAddr = this.moduleAddresses.get('DASHBOARD_VIEW');
    if (!dvAddr) throw new Error('DashboardView not resolved');
    const dv = new ethers.Contract(dvAddr, DASHBOARD_VIEW_ABI, this.provider);
    return dv.getUserOverviewWithMeta(user, assets);
  }

  /**
   * 批量查询（推荐入口：CacheOptimizedView）
   * 注意 MAX_BATCH_SIZE=100，超限需分片
   */
  async batchGetUserPositions(users: string[], assets: string[]) {
    const MAX_BATCH = 100;
    const coAddr = this.moduleAddresses.get('CACHE_OPTIMIZED_VIEW');
    if (!coAddr) throw new Error('CacheOptimizedView not resolved');
    const co = new ethers.Contract(coAddr, CACHE_OPTIMIZED_VIEW_ABI, this.provider);

    // 分片处理
    const chunks = chunkArray(users, MAX_BATCH);
    const results = await Promise.all(
      chunks.map(chunk => co.batchGetUserPositionsWithMeta(chunk, assets))
    );
    return results.flat();
  }
}
```

#### `src/lib/portfolio/fetchers.ts`（重构）

```typescript
// 旧代码（直连 CollateralManager/LendingEngine）→ 新代码（走 View 层）

// 旧：
// const collateral = await collateralManager.getCollateral(user, asset);
// const debt = await lendingEngine.getUserDebt(user, asset);

// 新：
import { key } from '@/services/config/moduleKeys';

export async function fetchUserPortfolio(
  provider: ethers.Provider,
  registryAddr: string,
  user: string,
  assets: string[]
) {
  // 通过 Registry 解析 DashboardView
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, provider);
  const dvAddr = await registry.getModule(key('DASHBOARD_VIEW'));

  const dv = new ethers.Contract(dvAddr, DASHBOARD_VIEW_ABI, provider);
  const overview = await dv.getUserOverviewWithMeta(user, assets);

  // 处理 meta
  return {
    ...overview,
    // 标注每个仓位的有效性
    positions: overview.positionValidFlags.map((valid: boolean, i: number) => ({
      asset: assets[i],
      isValid: valid,
      blockNumber: overview.positionBlockNumbers[i],
      version: overview.positionVersions[i],
    })),
  };
}
```

#### `src/hooks/useVaultViewService.ts`（适配）

改为使用新的 `VaultViewService` 实例，确保 View 地址通过 Registry 解析。

#### `src/hooks/usePortfolio.ts`（适配）

改为调用 `fetchUserPortfolio`（使用 DashboardView），并处理 meta 降级。

---

## 4. P0：Meta 字段处理（isValid/blockNumber/version）

### 4.1 设计原则

所有来自 View 层的返回值都包含 `isValid`/`blockNumber`（可选 `version`）。前端**必须**：
- 当 `isValid === false` 时展示"数据可能延迟/陈旧"的提示
- 当 `blockNumber === 0n` 或 `blockNumber > currentBlock` 时标记为"不可用"
- 不要静默把 `0` 值当作真实值（尤其是 price/healthFactor/统计总量）

### 4.2 新增通用组件

#### `src/components/ui/DataFreshness.tsx`（新增）

```tsx
interface DataFreshnessProps {
  isValid: boolean;
  blockNumber: bigint;
  currentBlock?: bigint;
  avgBlockTimeSeconds?: number; // 网络平均出块时间
  label?: string;
}

export function DataFreshness({
  isValid,
  blockNumber,
  currentBlock,
  avgBlockTimeSeconds = 0.26, // Arbitrum 默认
  label = '数据',
}: DataFreshnessProps) {
  if (!isValid) {
    return (
      <div className="text-amber-500 text-sm flex items-center gap-1">
        <WarningIcon />
        <span>{label}可能延迟/陈旧</span>
        {blockNumber > 0n && (
          <span className="text-xs text-gray-400">
            (更新于区块 #{blockNumber.toString()})
          </span>
        )}
      </div>
    );
  }

  if (currentBlock && blockNumber > 0n) {
    const ageBlocks = currentBlock - blockNumber;
    const ageSeconds = Number(ageBlocks) * avgBlockTimeSeconds;
    const ageDisplay = formatAge(ageSeconds);
    return (
      <span className="text-xs text-gray-400">
        更新于约 {ageDisplay} 前（估计值）
      </span>
    );
  }

  return null;
}
```

#### `src/utils/metaHelpers.ts`（新增）

```typescript
/**
 * 统一 Meta 字段处理工具
 * 
 * 所有 View 返回值的 meta 字段应通过本模块处理，
 * 避免各组件各自实现导致降级逻辑不一致。
 */

export interface ViewMeta {
  isValid: boolean;
  blockNumber: bigint;
  version?: bigint;
}

/** 判断 meta 是否表示"数据可用" */
export function isDataAvailable(meta: ViewMeta): boolean {
  return meta.isValid && meta.blockNumber > 0n;
}

/** 判断 meta 是否表示"数据陈旧但有值" */
export function isDataStale(meta: ViewMeta): boolean {
  return !meta.isValid && meta.blockNumber > 0n;
}

/** 判断 meta 是否表示"完全不可用" */
export function isDataUnavailable(meta: ViewMeta): boolean {
  return meta.blockNumber === 0n;
}

/**
 * 安全地展示来自 View 的数值
 * 当 meta 表示不可用时，返回 fallback
 */
export function safeDisplayValue<T>(
  value: T,
  meta: ViewMeta,
  fallback: T
): { value: T; confidence: 'high' | 'low' | 'none' } {
  if (isDataAvailable(meta)) return { value, confidence: 'high' };
  if (isDataStale(meta)) return { value, confidence: 'low' };
  return { value: fallback, confidence: 'none' };
}
```

### 4.3 现有组件改造示例

所有展示链上数据的组件都需要引入 meta 处理。以仪表盘为例：

```tsx
// src/components/dashboard/PositionCard.tsx
// 旧：直接展示 collateral/debt
// 新：展示 collateral/debt + DataFreshness 组件

const { value: collateral, confidence } = safeDisplayValue(
  position.collateral,
  { isValid: position.isValid, blockNumber: position.blockNumber },
  0n
);

return (
  <Card>
    <CardHeader>仓位</CardHeader>
    <CardContent>
      {confidence === 'none' ? (
        <span className="text-gray-400">数据不可用</span>
      ) : (
        <>
          <span className={confidence === 'low' ? 'opacity-60' : ''}>
            {formatAmount(collateral)}
          </span>
          <DataFreshness
            isValid={position.isValid}
            blockNumber={position.blockNumber}
            currentBlock={currentBlock}
          />
        </>
      )}
    </CardContent>
  </Card>
);
```

---

## 5. P1：Block-based 时间与 ETA 映射

### 5.1 核心约束（必须理解）

链上所有门槛/截止/到期判断都基于 `block.number`，前端展示的是 **ETA（估计值）**。

### 5.2 新增工具

#### `src/utils/blockTime.ts`（新增）

```typescript
import { ethers } from 'ethers';

// 网络平均出块时间配置
const AVG_BLOCK_TIME: Record<number, number> = {
  31337: 1.0,      // localhost (hardhat)
  421614: 0.26,    // Arbitrum Sepolia
  42161: 0.26,     // Arbitrum One
};

export function getAvgBlockTime(chainId: number): number {
  return AVG_BLOCK_TIME[chainId] ?? 1.0;
}

/** 从 deadlineBlock 计算 ETA（毫秒级 Unix 时间戳） */
export async function estimateEta(
  provider: ethers.Provider,
  deadlineBlock: bigint,
  chainId: number
): Promise<{ currentBlock: bigint; deadlineBlock: bigint; etaMs: number }> {
  const currentBlock = BigInt(await provider.getBlockNumber());
  const nowMs = Date.now();
  if (deadlineBlock <= currentBlock) {
    return { currentBlock, deadlineBlock, etaMs: nowMs };
  }
  const blocksLeft = deadlineBlock - currentBlock;
  const avgBlockTime = getAvgBlockTime(chainId);
  const etaMs = nowMs + Number(blocksLeft) * avgBlockTime * 1000;
  return { currentBlock, deadlineBlock, etaMs };
}

/** 从 updateBlock 计算"约多久前"（秒） */
export async function estimateAge(
  provider: ethers.Provider,
  updateBlock: bigint,
  chainId: number
): Promise<{ ageBlocks: bigint; ageSecondsApprox: number | null }> {
  const currentBlock = BigInt(await provider.getBlockNumber());
  if (updateBlock === 0n || updateBlock > currentBlock) {
    return { ageBlocks: 0n, ageSecondsApprox: null };
  }
  const ageBlocks = currentBlock - updateBlock;
  const ageSecondsApprox = Number(ageBlocks) * getAvgBlockTime(chainId);
  return { ageBlocks, ageSecondsApprox };
}

/** 格式化"约X分钟/小时/天"（UI 展示） */
export function formatBlockAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return '未知';
  if (ageSeconds < 60) return `约 ${Math.round(ageSeconds)} 秒`;
  if (ageSeconds < 3600) return `约 ${Math.round(ageSeconds / 60)} 分钟`;
  if (ageSeconds < 86400) return `约 ${Math.round(ageSeconds / 3600)} 小时`;
  return `约 ${Math.round(ageSeconds / 86400)} 天`;
}
```

### 5.3 前端展示要求

| 场景 | 展示内容 | 禁止 |
|------|---------|------|
| 贷款到期 | "预计在约 N 个区块后到期（ETA: yyyy-mm-dd hh:mm，估计值）" | "到期时间戳: xxxxx" |
| 缓存年龄 | "更新于约 X 分钟前（估计值）" | "最后更新: 2026-02-11 10:00:00" |
| 网络拥堵 | 加提示 "ETA 会随区块速度变化" | 隐藏提示 |
| updateBlock=0 | "更新区块未知/不可用" | 硬算 ETA |

---

## 6. P1：Reward 系统前端适配

### 6.1 展示口径（必须遵守）

```
walletPoints     = getUserBalanceWithMeta(user).balance
pendingPenalty   = getUserRewardSummaryWithMeta(user).pendingPenalty
availablePoints  = max(walletPoints - pendingPenalty, 0)  // 可消费/可兑换
```

### 6.2 需要修改的文件

#### `src/stores/rewardStore.ts`（重构）

```typescript
import { create } from 'zustand';
import { key } from '@/services/config/moduleKeys';

interface RewardState {
  walletPoints: bigint;
  pendingPenalty: bigint;
  availablePoints: bigint;
  userLevel: number;
  privilegesPacked: bigint;
  isValid: boolean;
  cacheBlock: bigint;
  loading: boolean;
  error: string | null;

  fetchRewardData: (provider: any, rewardViewAddr: string, user: string) => Promise<void>;
}

export const useRewardStore = create<RewardState>((set) => ({
  walletPoints: 0n,
  pendingPenalty: 0n,
  availablePoints: 0n,
  userLevel: 1,
  privilegesPacked: 0n,
  isValid: false,
  cacheBlock: 0n,
  loading: false,
  error: null,

  fetchRewardData: async (provider, rewardViewAddr, user) => {
    set({ loading: true, error: null });
    try {
      const rv = new ethers.Contract(rewardViewAddr, REWARD_VIEW_ABI, provider);

      // 并行查询 balance 和 summary
      const [balanceResult, summaryResult] = await Promise.all([
        rv.getUserBalanceWithMeta(user),
        rv.getUserRewardSummaryWithMeta(user),
      ]);

      const [balance, balanceCacheBlock, balanceIsValid] = balanceResult;
      const [
        totalEarned, totalBurned, pendingPenalty, level,
        privilegesPacked, lastActivity, summaryCacheBlock, summaryIsValid
      ] = summaryResult;

      const availablePoints = balance > pendingPenalty
        ? balance - pendingPenalty
        : 0n;

      set({
        walletPoints: balance,
        pendingPenalty,
        availablePoints,
        userLevel: Number(level),
        privilegesPacked,
        isValid: balanceIsValid && summaryIsValid,
        cacheBlock: balanceCacheBlock,
        loading: false,
      });
    } catch (err: any) {
      set({ loading: false, error: err.message });
    }
  },
}));
```

#### `src/hooks/useRewardBalance.ts`（适配）

改为从 `useRewardStore` 获取数据，不再直接调用合约。

### 6.3 写前校验（兑换/消费前必须）

```typescript
// 消费前必须先检查 availablePoints
const { availablePoints, fetchRewardData } = useRewardStore();

async function handleConsume() {
  // 1. 先刷新一次（避免并发下 UI 误判）
  await fetchRewardData(provider, rewardViewAddr, userAddress);

  // 2. 检查可用积分
  const { availablePoints: refreshed } = useRewardStore.getState();
  if (refreshed < requiredPoints) {
    toast.error('积分不足（可能存在待抵扣 penalty 或余额不足）');
    return;
  }

  // 3. 发起链上消费交易
  // ...
}
```

### 6.4 事件联动（推荐最小集合）

订阅以下 `DataPushed` 事件后刷新 Reward 数据：
- `REWARD_EARNED`
- `REWARD_BURNED`
- `REWARD_PENALTY_LEDGER_UPDATED`

收到事件后调用 `fetchRewardData`（不要本地累加/相减）。

---

## 7. P1：AI Credits 计费集成

### 7.1 架构概述（与 SaaS-Backend-Implementation-Guide 对齐）

```
前端用户调用 AI → API 请求到后端（api-server）
  → 后端 Redis DECRBY 扣次 → 转发到 ai-services 处理
  → 成功: 扣次生效 / 失败: INCRBY 退回

前端展示余额：从后端 API 获取（链下实时余额 + 链上审计余额）
链上购买/兑换：已移除（当前不提供链上兑换入口）
```

### 7.2 新增文件

#### `src/services/aiCredits.ts`（新增）

```typescript
import { authFetch } from '@/lib/authFetch';

export interface AICreditsBalance {
  available: number;        // 链下实时可用额度
  onChainAudit: number;     // 链上审计余额（AICreditsVault.creditsBalance）
  reserved: number;         // 占用中（RESERVED 状态）
  isAligned: boolean;       // 链上/链下是否对齐
}

/** 获取 AI Credits 余额（走后端 API） */
export async function getAICreditsBalance(tenantId: string): Promise<AICreditsBalance> {
  const res = await authFetch(`/api/ai-credits/balance?tenantId=${tenantId}`);
  return res.json();
}
```

### 7.3 AI 调用流程（前端侧）

```typescript
// 发起 AI 请求时的前端流程
async function callAIService(prompt: string) {
  // 1. 生成 requestId（前端侧，UUID v7）
  const requestId = crypto.randomUUID();

  // 2. 调用后端 API（后端负责扣次 + 幂等）
  const response = await authFetch('/api/ai/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `usage:t-${tenantId}:u${userId}:llm:${requestId}`,
    },
    body: JSON.stringify({ prompt, requestId }),
  });

  if (response.status === 402) {
    // AI Credits 不足
    toast.error('AI 额度不足');
    return;
  }

  return response.json();
}
```

---

## 8. P2：EIP-712 签名与撮合流程

### 8.1 termBlocks SSOT

借贷撮合签名**必须使用 termBlocks**（不是 termDays）。

#### `src/utils/intentSigning.ts`（新增）

```typescript
import { ethers } from 'ethers';

const EIP712_DOMAIN = {
  name: 'RwaLending',
  version: '1',
};

const BORROW_INTENT_BLOCKS_TYPES = {
  BorrowIntentBlocks: [
    { name: 'borrower', type: 'address' },
    { name: 'collateralAsset', type: 'address' },
    { name: 'collateralAmount', type: 'uint256' },
    { name: 'borrowAsset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'termBlocks', type: 'uint256' },
    { name: 'rateBps', type: 'uint256' },
    { name: 'expireAt', type: 'uint256' },    // 语义：expireBlock
    { name: 'salt', type: 'bytes32' },
  ],
};

const LEND_INTENT_BLOCKS_TYPES = {
  LendIntentBlocks: [
    { name: 'lenderSigner', type: 'address' },
    { name: 'asset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'minTermBlocks', type: 'uint256' },
    { name: 'maxTermBlocks', type: 'uint256' },
    { name: 'minRateBps', type: 'uint256' },
    { name: 'expireAt', type: 'uint256' },    // 语义：expireBlock
    { name: 'salt', type: 'bytes32' },
  ],
};

/**
 * 生成 BorrowIntent 的 EIP-712 签名
 * 
 * termBlocks 必须来自链下 TermBlocks 快照，不要自行推导
 * verifyingContract 必须是 VaultBusinessLogic 地址（撮合入口）
 */
export async function signBorrowIntent(
  signer: ethers.Signer,
  vaultBusinessLogicAddr: string,
  intent: BorrowIntentBlocks
) {
  const chainId = await signer.provider!.getNetwork().then(n => n.chainId);
  const domain = {
    ...EIP712_DOMAIN,
    chainId,
    verifyingContract: vaultBusinessLogicAddr,
  };
  return signer.signTypedData(domain, BORROW_INTENT_BLOCKS_TYPES, intent);
}

/**
 * 构造 salt（绑定 snapshotId，便于审计与复现）
 */
export function buildSaltWithSnapshot(snapshotId: string, userNonce: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'uint256'],
      [snapshotId, userNonce]
    )
  );
}
```

### 8.2 TermBlocks 快照消费

```typescript
// 前端只消费快照，不自行推导 days -> blocks
// 快照来源：撮合服务 API

interface TermBlocksSnapshot {
  chainId: number;
  snapshotId: string;
  avgBlockTimeSeconds: number;
  termBuckets: { termDays: number; termBlocks: number }[];
  generatedAtBlock: number;
}

async function fetchTermBlocksSnapshot(chainId: number): Promise<TermBlocksSnapshot> {
  const res = await fetch(`/api/term-blocks/snapshot?chainId=${chainId}`);
  if (!res.ok) {
    // 取快照失败：不建议继续签名
    throw new Error('TermBlocks 快照不可用，请稍后重试');
  }
  return res.json();
}
```

---

## 9. P2：统一事件订阅（DataPushed）

### 9.1 订阅入口

所有前端监听服务应仅订阅 `DataPushed(bytes32 indexed dataTypeHash, bytes payload)`。

#### `src/services/eventListener.ts`（新增）

```typescript
import { ethers, keccak256, toUtf8Bytes, AbiCoder } from 'ethers';

const DATA_TYPES = {
  REWARD_EARNED: keccak256(toUtf8Bytes('REWARD_EARNED')),
  REWARD_BURNED: keccak256(toUtf8Bytes('REWARD_BURNED')),
  REWARD_PENALTY_LEDGER_UPDATED: keccak256(toUtf8Bytes('REWARD_PENALTY_LEDGER_UPDATED')),
  DEPOSIT_PROCESSED: keccak256(toUtf8Bytes('DEPOSIT_PROCESSED')),
  WITHDRAW_PROCESSED: keccak256(toUtf8Bytes('WITHDRAW_PROCESSED')),
  USER_DEGRADATION: keccak256(toUtf8Bytes('USER_DEGRADATION')),
  // ... 按需扩展
} as const;

type DataTypeKey = keyof typeof DATA_TYPES;
type EventHandler = (decoded: any, raw: ethers.Log) => void;

export class DataPushedListener {
  private handlers = new Map<string, EventHandler[]>();
  private iface = new ethers.Interface([
    'event DataPushed(bytes32 indexed dataTypeHash, bytes payload)',
  ]);

  /** 注册处理函数 */
  on(dataType: DataTypeKey, handler: EventHandler) {
    const hash = DATA_TYPES[dataType];
    const list = this.handlers.get(hash) || [];
    list.push(handler);
    this.handlers.set(hash, list);
  }

  /** 开始监听 */
  start(provider: ethers.Provider, contractAddresses: string[]) {
    const topic = this.iface.getEvent('DataPushed')!.topicHash;
    provider.on({ topics: [topic] }, (log) => {
      try {
        const parsed = this.iface.parseLog(log);
        if (!parsed) return;
        const { dataTypeHash, payload } = parsed.args;
        const handlers = this.handlers.get(dataTypeHash);
        if (!handlers?.length) return;

        const decoder = AbiCoder.defaultAbiCoder();
        // 按 dataTypeHash 解码 payload（查映射表）
        // ...
        handlers.forEach(h => h(decoded, log));
      } catch { /* ignore */ }
    });
  }
}
```

---

## 10. P2：Custom Error 精准识别

### 10.1 新增错误处理工具

#### `src/utils/contractErrors.ts`（新增）

```typescript
import { Interface, id } from 'ethers';

// 常见合约错误的 ABI
const ERROR_FRAGMENTS = [
  'error SettlementManager__NoCollateral()',
  'error SettlementManager__NotLiquidatable()',
  'error MissingRole()',
  'error BatchTooLarge(uint256 length, uint256 max)',
  'error EmptyArray()',
  'error TokenNotSupported()',
  'error CollateralManager__UnauthorizedAccess()',
];

const errorIface = new Interface(ERROR_FRAGMENTS);

/** 精准识别 custom error（含 selector 兜底） */
export function decodeContractError(error: any): {
  name: string;
  args?: Record<string, any>;
  userMessage: string;
} {
  const revertData =
    error?.data || error?.error?.data || error?.info?.error?.data;

  if (revertData?.startsWith('0x')) {
    try {
      const parsed = errorIface.parseError(revertData);
      if (parsed) {
        return {
          name: parsed.name,
          args: parsed.args ? Object.fromEntries(parsed.args.entries()) : undefined,
          userMessage: getErrorMessage(parsed.name),
        };
      }
    } catch {
      // selector 兜底
      const selector = revertData.slice(0, 10).toLowerCase();
      const known = KNOWN_SELECTORS[selector];
      if (known) {
        return { name: known, userMessage: getErrorMessage(known) };
      }
    }
  }

  return {
    name: 'UnknownError',
    userMessage: error?.message || '交易失败，请稍后重试',
  };
}

const KNOWN_SELECTORS: Record<string, string> = {
  [id('SettlementManager__NoCollateral()').slice(0, 10).toLowerCase()]:
    'SettlementManager__NoCollateral',
  [id('MissingRole()').slice(0, 10).toLowerCase()]: 'MissingRole',
  // ... 按需补全
};

function getErrorMessage(errorName: string): string {
  const messages: Record<string, string> = {
    'SettlementManager__NoCollateral':
      '系统无法对抵押资产估值（价格可能过期或未配置）。请刷新价格后重试。',
    'MissingRole': '当前账户缺少执行此操作的权限。',
    'BatchTooLarge': '请求数量超出限制，请减少批量大小后重试。',
    'EmptyArray': '请至少选择一个项目。',
    'TokenNotSupported': '当前资产不受支持。',
    'CollateralManager__UnauthorizedAccess': '未授权的访问。',
  };
  return messages[errorName] || '交易失败，请稍后重试。';
}
```

---

## 11. P3：后端幂等 Key 与多租户适配

### 11.1 HTTP 请求适配

#### `src/lib/authFetch.ts`（修改）

在现有 `authFetch` 基础上添加统一 Header：

```typescript
// 新增：所有请求自动携带 X-Tenant-ID
// 修改：支持 X-Idempotency-Key

export async function authFetch(
  url: string,
  options: RequestInit & { idempotencyKey?: string } = {}
) {
  const tenantId = getTenantId(); // 从 store 或 env 获取

  const headers = new Headers(options.headers);
  headers.set('X-Tenant-ID', tenantId);

  if (options.idempotencyKey) {
    headers.set('X-Idempotency-Key', options.idempotencyKey);
  }

  // ... 其余现有逻辑（token、refresh 等）
}
```

### 11.2 API 调用示例

```typescript
// 消费积分（幂等）
await authFetch('/api/rewards/consume', {
  method: 'POST',
  idempotencyKey: `reward:u${userId}:consume:${requestId}`,
  body: JSON.stringify({ amount, serviceType }),
});
```

---

## 12. P3：Stripe 计费前端集成

### 12.1 新增页面/组件

| 组件 | 路径 | 功能 |
|------|------|------|
| SubscriptionPage | `pages/settings/subscription.tsx` | 显示当前订阅计划、升级/降级 |
| PricingCards | `src/components/billing/PricingCards.tsx` | 展示价格方案 |
| UsageChart | `src/components/billing/UsageChart.tsx` | 用量图表 |
| InvoiceList | `src/components/billing/InvoiceList.tsx` | 历史账单列表 |

### 12.2 Stripe.js 集成

```typescript
// pages/settings/subscription.tsx
import { loadStripe } from '@stripe/stripe-js';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLIC_KEY!);

async function handleSubscribe(priceId: string) {
  const res = await authFetch('/api/stripe/create-checkout-session', {
    method: 'POST',
    body: JSON.stringify({ priceId }),
  });
  const { sessionId } = await res.json();
  const stripe = await stripePromise;
  await stripe!.redirectToCheckout({ sessionId });
}
```

---

## 13. 逐文件修改清单

> 未列出的文件 = 零修改，保持原样。

| 优先级 | 文件路径 | 改动类型 | 改动内容 |
|--------|---------|---------|---------|
| **P0** | `src/services/config/moduleKeys.ts` | **重写** | 与链上 `ModuleKeys.sol` 完全对齐；新增 `key()`/`decodeModuleKey()` |
| **P0** | `src/lib/registryResolver.ts` | **修正** | 新增 `initializeModuleAddresses`（先 fallback 后 Registry）；Preflight 校验；热更新 |
| **P0** | `src/services/contracts/VaultViewService.ts` | **重构** | 从 re-export 改为直接调用链上 View 模块（PositionView/DashboardView/CacheOptimizedView） |
| **P0** | `src/lib/portfolio/fetchers.ts` | **重构** | 改为走 DashboardView.getUserOverviewWithMeta；处理 meta 返回值 |
| **P0** | `src/hooks/usePortfolio.ts` | **适配** | 使用新的 fetchers.ts；处理 meta 降级 |
| **P0** | `src/hooks/useVaultViewService.ts` | **适配** | 使用重构后的 VaultViewService |
| **P0** | `src/hooks/useRegistry.ts` | **扩展** | 新增 Preflight 权限检查 hook |
| **P0** | `src/services/client/registryClient.ts` | **微调** | 确保使用新的 `key()` 函数生成 module key |
| **P1** | `src/stores/rewardStore.ts` | **重构** | 全面对齐 RewardView API（balance + summary + meta）；新增 availablePoints 计算 |
| **P1** | `src/hooks/useRewardBalance.ts` | **适配** | 改为从 rewardStore 获取数据 |
| **P1** | `src/services/reward/RewardService.ts` | **重构** | 从 re-export 改为调用 RewardView 只读接口 |
| **P1** | `src/config/blockchain.ts` | **扩展** | 新增 `AVG_BLOCK_TIME` 配置（per network） |
| **P1** | `src/context/Web3Provider.tsx` | **微调** | 确保 provider 在 context 中可访问 chainId |
| **P2** | `src/lib/authFetch.ts` | **修正** | 新增 `X-Tenant-ID` Header 和 `idempotencyKey` 支持 |
| **P2** | `src/context/SessionContext.tsx` | **扩展** | 新增 tenantId 到 session 上下文 |
| **P2** | `src/stores/auth.ts` | **扩展** | 新增 tenantId 持久化 |

---

## 14. 新增文件清单

| 文件路径 | 用途 |
|---------|------|
| `src/utils/metaHelpers.ts` | View meta 字段处理工具（isValid/blockNumber/version） |
| `src/utils/blockTime.ts` | Block-based 时间 ETA 映射工具 |
| `src/utils/contractErrors.ts` | Custom error 精准识别 + 用户友好提示 |
| `src/utils/intentSigning.ts` | EIP-712 签名工具（BorrowIntentBlocks/LendIntentBlocks） |
| `src/utils/dataPushTypes.ts` | DataPushed dataTypeHash 常量（与链上 `DataPushTypes.sol` 对齐） |
| `src/services/eventListener.ts` | 统一 DataPushed 事件订阅管理器 |
| `src/services/aiCredits.ts` | AI Credits 余额查询与兑换服务 |
| `src/components/ui/DataFreshness.tsx` | 数据新鲜度/降级提示通用组件 |
| `src/components/billing/PricingCards.tsx` | Stripe 订阅价格卡片 |
| `src/components/billing/UsageChart.tsx` | AI 用量图表 |
| `src/components/billing/InvoiceList.tsx` | 历史账单列表 |
| `pages/settings/subscription.tsx` | 订阅管理页面 |

---

## 15. TypeChain / ABI 更新流程

### 15.1 ABI 同步步骤

```bash
# 1. 在 contracts/ 项目中编译
cd /Volumes/AI-hosts/contracts
npx hardhat compile

# 2. TypeChain 自动生成类型
npx hardhat typechain

# 3. 复制 ABI 到前端可访问位置
# 当前前端通过 tsconfig 的 path alias "abi/*" 引用 ../contracts/abi/*
# 确保 abi/ 目录包含以下新增合约的 ABI：
#   - PositionView.json
#   - UserView.json
#   - HealthView.json
#   - DashboardView.json
#   - CacheOptimizedView.json
#   - BatchView.json
#   - RewardView.json
#   - LiquidatorView.json
#   - ValuationOracleView.json
#   - SystemRiskView.json
#   - FeeRouterView.json
#   - LoanFlowView.json
#   - AccessControlView.json
#   - AICreditsVault.json
```

### 15.2 Breaking Changes（必须同步更新 ABI）

以下接口返回值结构已变更（2026-01），旧 ABI 解包会导致 silent wrong decode：

1. **UserView**: `getUserPosition` → 新增 `isValid/blockNumber/version` 字段
2. **DashboardView**: `getUserOverview` → 新增 `positionValidFlags/positionBlockNumbers/positionVersions/healthBlockNumber`
3. **LiquidatorView**: 所有用户维度接口新增 `blockNumber/isValid`
4. **RewardView**: 所有 `*WithMeta` 接口已统一返回 `(data..., cacheBlock, isValid)`
5. **FeeRouterView**: 空数组输入改为 `revert EmptyArray()`（原来可能静默返回空结果）

**重要**：严禁按旧字段顺序做手工 `abi.decode`。必须使用最新 ABI/TypeChain 重新生成类型。

---

## 16. 测试与验收标准

### 16.1 单元测试

| 测试项 | 验收标准 |
|--------|---------|
| `moduleKeys.ts` | 所有 KEY 与链上 `ModuleKeys.sol` keccak256 值一致 |
| `registryResolver.ts` | Registry 解析结果覆盖 fallback；零地址跳过；事件热更新 |
| `metaHelpers.ts` | `isValid=false` 时返回 `confidence='low'`；`blockNumber=0` 时返回 `none` |
| `blockTime.ts` | ETA 计算正确；`updateBlock > currentBlock` 返回 null |
| `contractErrors.ts` | 已知 selector 正确映射；未知 selector 返回 `UnknownError` |

### 16.2 集成测试

| 测试项 | 验收标准 |
|--------|---------|
| 用户仓位查询 | 通过 PositionView 获取仓位 + meta，UI 正确展示降级提示 |
| Reward 余额 | `walletPoints - pendingPenalty = availablePoints`；meta 陈旧时有提示 |
| 批量查询分片 | 超过 100 条自动 chunk，不触发 `BatchTooLarge` |
| EIP-712 签名 | 生成的签名可被链上合约验证 |
| DataPushed 监听 | 收到 `REWARD_EARNED` 后自动刷新 Reward 数据 |

### 16.3 端到端测试

| 测试项 | 验收标准 |
|--------|---------|
| 完整借贷流程 | 签名 → 撮合 → 放款 → 还款，全程 UI 展示正确 |
| 错误处理 | `MissingRole`/`NoCollateral` 等错误显示用户友好提示 |
| 多租户隔离 | 租户 A 无法看到租户 B 的数据 |

---

## 17. 前后端并行实施计划

> **核心思路**：前端的 P0/P1 大部分不依赖后端修正（纯链上交互），P2/P3 才需要后端 API 就绪。
> 因此可以错位并行，总工期 18 天（与后端 21 天基本同步），而不是串行的 6 周。
>
> **关联文档**：后端侧并行计划见 `docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md` 第 14 节。

### 17.1 并行时间线总览

```
后端 Phase 1 (Day 1-5)        后端 Phase 2 (Day 6-12)       后端 Phase 3 (Day 13-21)
┌─────────────────────┐  ┌──────────────────────────┐  ┌─────────────────────────┐
│ 幂等层 + 账本隔离修正 │  │ ai-services 修正          │  │ AWS 部署 + 生产加固       │
│ packages/shared      │  │ Ponder 链上索引            │  │ Docker + CI/CD            │
│ LedgerService 修正   │  │ Stripe 路由                │  │ 对账脚本                  │
│ RLS 策略             │  │ AI Credits 余额同步        │  │ 灰度发布                  │
└─────────────────────┘  └──────────────────────────┘  └─────────────────────────┘
         ↕ 无依赖               ↕ 部分依赖                    ↕ 联调
┌─────────────────────┐  ┌──────────────────────────┐  ┌─────────────────────────┐
│ 前端 P0 (Day 1-5)    │  │ 前端 P1 + P2 (Day 6-12)  │  │ 前端 P3 + 联调 (Day 13-18)│
│ ① moduleKeys 重写    │  │ ⑤ Reward 系统适配         │  │ ⑨ authFetch 幂等 Header   │
│ ② registryResolver  │  │ ⑥ blockTime ETA 映射      │  │ ⑩ Stripe 订阅 UI          │
│ ③ View 层接口迁移    │  │ ⑦ DataPushed 事件监听     │  │ ⑪ AI Credits 余额页面     │
│ ④ Meta 降级组件      │  │ ⑧ EIP-712 签名工具        │  │ ⑫ E2E 联调测试            │
│   + ABI 更新         │  │   + contractErrors 工具   │  │   + 多租户验证             │
└─────────────────────┘  └──────────────────────────┘  └─────────────────────────┘
```

### 17.2 阶段一（Day 1-5）：完全独立，各干各的

| 前端任务 | 依赖后端？ | 原因 |
|---------|-----------|------|
| moduleKeys.ts 重写 | **否** | 纯链上常量对齐 |
| registryResolver.ts 修正 | **否** | 直接调用链上 Registry |
| VaultViewService 重构（→ View 层） | **否** | 直接调用链上 View 合约 |
| fetchers.ts / usePortfolio 适配 | **否** | 走链上 DashboardView |
| Meta 降级组件 + metaHelpers.ts | **否** | 纯前端 UI 逻辑 |
| ABI 文件更新（从 contracts/ 编译） | **否** | 本地编译即可 |

**后端同一时段做的事**：幂等层 + 账本 `tenant_id` + RLS — 与前端链上交互无关。

**前端验收标准（Day 5）**：
- [ ] 所有 View 层读接口已迁移（不再调用 VaultRouter 读方法）
- [ ] Meta 降级 UI 组件可用（`isValid=false` 时有提示）
- [ ] 在 localhost 链上可跑通完整读路径

### 17.3 阶段二（Day 6-12）：大部分独立，少量需要后端 Mock

| 前端任务 | 依赖后端？ | 说明 |
|---------|-----------|------|
| rewardStore.ts 重构 | **否** | 直接调用链上 RewardView |
| blockTime.ts ETA 映射 | **否** | 纯前端计算 |
| DataPushed 事件监听 | **否** | 直接订阅链上事件 |
| EIP-712 签名工具 | **否** | 纯前端 + 链上验签 |
| contractErrors.ts | **否** | 纯前端错误解码 |
| AI Credits 余额查询（链下） | **是，Day 11** | 需要后端 `/api/ai-credits/balance` API |

**前端应对策略**：
- Day 6-10 期间：用 Mock API 或直接读链上 `AICreditsVault.creditsBalance()` 做开发
- Day 11 后端 `chainSync.ts` 就绪后：切换到后端 API

**前端验收标准（Day 12）**：
- [ ] Reward 余额展示正确（`walletPoints - pendingPenalty = availablePoints`）
- [ ] Block-based ETA 映射可用（到期/缓存年龄展示"约 X 分钟，估计值"）
- [ ] DataPushed 事件监听后自动刷新数据
- [ ] EIP-712 签名可被链上合约验证

### 17.4 阶段三（Day 13-18）：联调为主

| 前端任务 | 依赖后端？ | 说明 |
|---------|-----------|------|
| authFetch 加 `X-Idempotency-Key` | **是** | 后端 Phase 1 已就绪 |
| authFetch 加 `X-Tenant-ID` | **是** | 后端 RLS 中间件已就绪 |
| Stripe 订阅页面 | **是** | 后端 Stripe 路由已就绪 |
| AI 调用流程（扣次） | **是** | 后端 `ai-services` 修正已就绪 |
| E2E 联调 | **是** | 全链路：前端 → 后端 → 链上 → Ponder → 链下 |

**E2E 联调重点验证**：
- [ ] 同一请求重试不重复扣费（幂等 Key 端到端透传）
- [ ] 租户 A 看不到租户 B 数据（多租户隔离）
- [ ] 链上/链下 AI Credits 余额对齐
- [ ] Stripe Checkout 回调正确处理

### 17.5 协同检查点（必须对齐的时刻）

| 时间 | 检查点 | 前端动作 | 后端动作 |
|------|--------|---------|---------|
| **Day 1** | ABI 对齐 | 拿到最新 ABI 开始 View 层迁移 | 确认 `contracts/` 编译通过 |
| **Day 5** | 前端 P0 验收 | localhost 链上读路径全部跑通 | 幂等层 + 账本隔离修正完成 |
| **Day 8** | API 接口契约 | 拿到接口文档后写 Mock 先行开发 | 提供 API 接口契约（OpenAPI spec 或文档） |
| **Day 12** | 前端 P1+P2 验收；后端 Phase 2 完成 | 开始联调 AI Credits 余额查询 | Ponder + Stripe + chainSync 就绪 |
| **Day 15** | E2E 联调 | 前端 → 后端 → 链上全链路 | 配合联调、修复对接问题 |
| **Day 18** | 全部验收 | 所有修改完成，准备灰度 | AWS 部署就绪 |

### 17.6 Day 8 后端需要提供给前端的 API 接口契约

> 这是阶段二并行的关键交付物。后端**不需要实现完毕**，只需要给出接口定义，前端用 Mock 先行。

```
必须提供的接口定义：
  GET  /api/ai-credits/balance?tenantId=
       → { available: number, onChainAudit: number, reserved: number, isAligned: boolean }

  POST /api/ai/generate
       Headers: X-Idempotency-Key, X-Tenant-ID, Authorization
       Body: { prompt: string, requestId: string }
       → { result: string, tokensUsed: number } | 402 Insufficient Credits

  POST /api/stripe/create-checkout-session
       Body: { priceId: string }
       → { sessionId: string }

  GET  /api/stripe/subscriptions
       → { plan: string, status: string, currentPeriodEnd: string }

  POST /api/cache-retry/request
       Body: { user: string, asset: string, viewAddr: string, blockNumber: number, logIndex: number }
       → { queued: boolean }

  GET  /api/cache-retry/status?user=&asset=
       → { status: string, lastRetry: string, attempts: number }

    # ===== Explorer-like（链下读模型 + DB + 分页 API）=====
    # 说明：这类接口用于“历史/列表/筛选/搜索”等浏览器能力，不应在浏览器里直连 RPC 大范围扫链。
    # 前端使用场景：
    # - 资产/仓位时间序列（history）
    # - 用户中心的历史记录页（分页）
    # - 风控/运营面板的多用户列表（分页 + server-side filter）
    #
    # 与链上 View 的分工：
    # - “当前状态/强一致”→ 链上 View（PositionView/HealthView/LoanNFTView 等，带 isValid/blockNumber/version）
    # - “历史/搜索/跨用户聚合”→ 后端读模型 API（分页；必要时异步回填）

    GET  /api/portfolio/positions?user=
      → { user, collaterals: [], debts: [], health: { healthFactor, totalCollateralUSD, totalDebtUSD }, lastUpdated }

    POST /api/portfolio/positions/refresh
      Body: { userAddress: string, data: PortfolioPayload }
      → { ok: boolean, message: string, data: { positionId: number, timestamp: string } }

    GET  /api/portfolio/history?user=&limit=&offset=
      约束：limit 建议 1-100；offset >= 0
      → { ok: boolean, user, total, limit, offset, history: [{ id, totalCollateral, totalDebt, healthFactor, timestamp, source }] }

    GET  /api/portfolio/summary?user=
      → { ok: boolean, user, summary: { totalCollateral, totalDebt, netWorth, healthFactor, totalTransactions, lastUpdated } | null }
```

#### 17.6.1 后端本地启动与 API 自检（可直接执行）

> 本节用于保证前端/后端对齐：`lending-backend` 实际入口为 `pnpm dev -> src/index.ts -> src/server.ts`，所有路由统一挂在 `/api/*`。

1) 启动依赖（Postgres + Redis）

```bash
docker compose up -d postgres redis
```

2) 配置环境变量（至少这些）

```bash
cp env.example .env

# 必需（示例值按你本地实际填写）
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/rwalp?schema=public"
REDIS_URL="redis://localhost:6379"
PORT=3001

# 重要：portfolio 路由在后端受开关控制
ENABLE_PORTFOLIO_ROUTES=true

# 可选：用于后端链上同步/刷新接口
CHAIN_RPC_URL="https://..."
```

3) 初始化数据库并启动

```bash
pnpm install
pnpm exec prisma migrate dev
pnpm exec prisma generate
pnpm dev
```

4) API 自检（curl）

```bash
# positions（当前态）
curl "http://localhost:3001/api/portfolio/positions?user=0xYourAddress"

# summary（聚合态）
curl "http://localhost:3001/api/portfolio/summary?user=0xYourAddress"

# history（分页）
curl "http://localhost:3001/api/portfolio/history?user=0xYourAddress&limit=50&offset=0"

# refresh（触发后端更新/修复缓存；具体 body 以 lending-backend 实现为准）
curl -X POST "http://localhost:3001/api/portfolio/positions/refresh" \
  -H 'Content-Type: application/json' \
  -d '{"user":"0xYourAddress"}'
```

> 若返回 404：优先检查 `ENABLE_PORTFOLIO_ROUTES=true` 是否生效，以及后端是否统一挂载在 `/api` 前缀下。

### 17.7 Git 分支策略（前后端并行）

```
main
  ├── fix/unified-idempotency          # 后端修正主分支
  │     ├── Day 1-5: 幂等层 + 账本隔离
  │     ├── Day 6-12: ai-services + Ponder + Stripe
  │     └── Day 13-21: 部署 + 加固
  │
  └── feat/frontend-view-migration     # 前端修改主分支
        ├── Day 1-5: P0（View 迁移 + Meta + Registry）
        ├── Day 6-12: P1+P2（Reward + ETA + 签名 + 事件）
        └── Day 13-18: P3 + 联调

合并策略：
  1. Day 5: 后端 Phase 1 验收通过 → merge 到 main
  2. Day 5: 前端 P0 验收通过 → merge 到 main
  3. Day 12: 后端 Phase 2 + 前端 P1/P2 → 分别 merge 到 main
  4. Day 18: 前端 P3 + E2E 联调通过 → merge 到 main
  5. Day 21: 后端 Phase 3 灰度验证 → merge 到 main → 发布
```

---

## 附录 A：Token List SSOT 速查

前端经常用到三类"token list"，它们的权威来源不同：

| 用途 | SSOT | 前端用法 |
|------|------|---------|
| 可抵押/可借贷资产 | `AssetWhitelist.getAllowedAssets()` | 存入/借贷资产选择器 |
| 可估值资产（有价格） | `PriceOracle.getSupportedAssets()` 或 `ValuationOracleView` | 价格展示、健康因子 |
| 可收费 token | `FeeRouter.getSupportedTokens()` | 费用展示 |
| 展示层总集（并集） | `union(上述三者)` | 系统支持资产总览 |

**不要假设三者一致**，部署/治理差异会造成短时不一致。

## 附录 B：Approve Spender 速查

| 操作 | approve spender | 原因 |
|------|----------------|------|
| 抵押存入 | `CollateralManager` | CM 做 `transferFrom(user → CM)` |
| 出借入池 | `VaultBusinessLogic` | VBL 做 `transferFrom(lenderSigner → LenderPoolVault)` |
| 还款 | `VaultCore` | VaultCore 做 `transferFrom(user → SettlementManager)` |
| AI Credits 购买（USDC） | `AICreditsVault` | AVault 做 `transferFrom(buyer → AICreditsVault)` |

**关键错误**：不要把 spender 误配成 VaultCore/VaultRouter 做抵押存入（会 `ERC20InsufficientAllowance`）。

## 附录 C：权限键速查

| 权限键 | 用途 | 前端关注 |
|--------|------|---------|
| `VIEW_USER_DATA` | 用户私域（Position/User/Preview 等；Scheme U） | 后端 Read Service 代持 |
| `VIEW_RISK_DATA` | 风险/健康系统级读权限 | 运维侧 |
| `VIEW_PRICE_DATA` | 价格数据 | 后端代持 |
| `VIEW_SYSTEM_DATA` | 系统级信息 | 后端代持 |
| `ACTION_LIQUIDATE` | 清算执行权限 | keeper 持有 |

> 生产推荐走"方案 A（后端 Read Service）"：前端不需要为每个用户 grant 链上角色。

---

## 统一验收清单（同款模板）

- [ ] View 读路径：Registry 能解析到正确的 View 地址（含 `LOAN_NFT_VIEW` 等），且 `apiVersion()/schemaVersion()` 预检通过
- [ ] 浏览器直读：前端对所有 View 返回的 `isValid/blockNumber/version` 做降级展示（不会 silent wrong）
- [ ] 分页边界：所有批量/分页接口遵守链上 `MAX_BATCH_SIZE`（默认 100），超限会分片或拒绝
- [ ] 后端读模型：历史/搜索 API 走 DB，具备 cursor 分页与必要索引（不扫 RPC）
- [ ] 幂等与重试：链上事件写库按 `(chainId, txHash, logIndex)` 幂等；失败可观测并可重放
- [ ] 权限与多租户：Scheme U/系统权限边界清晰；后端 API 做租户隔离与鉴权（不能靠 `eth_call from` 冒充）

## 上线前统一 Checklist（DB/Redis/Feature Flag/Routes/Pagination/Idempotency/Reorg）

- [ ] DB 就绪：迁移已跑完；关键表/索引存在；读写账号最小权限；RLS/tenant 规则（如有）已启用
- [ ] Redis 就绪：连接/ACL/TTL 策略明确；幂等锁前缀包含 `tenantId`；监控命中率与容量
- [ ] Feature Flag：新读路径（View/Explorer API）有开关；支持按租户/环境灰度；默认关闭可回退
- [ ] 生效路由：`/api/portfolio/*`、`/api/rewards/*`、`/api/ai-credits/balance`、`/api/cache-retry/*`、`/api/contracts/*` 已注册并纳入鉴权/限流（含相应开关）
- [ ] 分页边界：`limit` 默认/上限固定；`cursor/offset` 越界返回空列表而非 500；排序稳定（按 `(blockNumber, logIndex)`）
- [ ] 幂等键约定：跨服务透传 `X-Idempotency-Key`；链上事件幂等键格式固定为 `chain:c{chainId}:{txHash}:log-{logIndex}`
- [ ] 重组窗口约定：明确 `finalityDepth`（如 64 blocks）与状态（`PENDING/CONFIRMED/REORGED`）；窗口内数据可回滚重算

---

> **文档维护说明**：本文档为前端修改的活文档，随着合约/后端架构变更同步更新。
>
> **版本历史**：
> - v1.1（2026-02-11）：新增第 17 节"前后端并行实施计划"——与后端 SaaS-Backend-Implementation-Guide 第 14 节对齐
> - v1.0（2026-02-11）：初版，基于 Architecture-Guide.md + FRONTEND_CONTRACTS_INTEGRATION.md + SaaS-Backend-Implementation-Guide.md 综合评估
>
> **关联文档**：
> - `docs/Architecture-Guide.md`（链上架构 SSOT）
> - `docs/FRONTEND_CONTRACTS_INTEGRATION.md`（前端集成 SSOT）
> - `docs/Usage-Guide/SaaS-Backend-Implementation-Guide.md`（后端实施总纲）
> - `docs/Usage-Guide/Reward-Best-Practices-Guide.md`（Reward 最优实践）
> - `docs/Usage-Guide/AI-Credits-Billing-Guide.md`（AI Credits 计费）
> - `docs/Usage-Guide/Time-Dependency-Refactor-Guide.md`（时间依赖改造）
> - `docs/Usage-Guide/Funds-Flow-Architecture-Guide.md`（资金链架构）

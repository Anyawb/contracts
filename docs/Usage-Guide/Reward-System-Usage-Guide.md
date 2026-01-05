# Reward 系统使用说明

> 最后更新：2025-01-27  
> 本文档提供 Reward 积分奖励系统的完整使用指南

---

## 📋 目录

1. [系统概述](#系统概述)
2. [部署后配置](#部署后配置)
3. [管理员操作](#管理员操作)
4. [用户操作](#用户操作)
5. [前端集成](#前端集成)
6. [API 参考](#api-参考)
7. [故障排除](#故障排除)

---

## 🎯 系统概述

Reward 系统是一个完整的用户激励和特权管理系统，通过积分奖励机制激励用户参与平台活动，并提供基于积分的特权服务。

### 核心组件（按现行实现）

- **RewardManager（Earn gateway）**：**借贷触发的奖励写入口门面 + 参数治理入口**（仅供 `LendingEngine` 落账后回调触发积分；治理权限走 ACM）
- **RewardManagerCore（Earn core）**：**发放与惩罚核心**（借款锁定/还款释放、欠分账本、等级/统计；向 `RewardView` 推送）
- **RewardConsumption（Spend gateway）**：**用户消费对外入口**（对外入口 + 批量入口，转发到 `RewardCore`；同时在 `RewardView.onlyWriter` 白名单内，负责消费侧推送）
- **RewardCore（Spend core）**：**消费核心**（服务购买/升级、消费记录、特权状态；业务逻辑核心，不推荐作为对外统一入口）
- **RewardView**：**统一只读 + 统一 DataPush**（前端/链下查询与订阅的推荐入口；链下统一订阅 `DataPushed + DATA_TYPE_REWARD_*`）
- **RewardPoints**: 积分代币（ERC20Upgradeable，18 decimals；`mintPoints/burnPoints` 仅 `MINTER_ROLE` 可调用）
- **ServiceConfigs（5个独立配置模块）**: 服务价格/时长/冷却等配置（通过 `ModuleKeys` 从 `Registry` 解析）

> 重要：**前端/链下只读查询统一从 `RewardView` 读取**（或透传），**不要直接依赖 `RewardManagerCore` 的事件/存储/查询接口**；写入路径严格遵循“落账后触发”。  
> 说明：`RewardManagerCore.getUserLevel/getRewardParameters/getUserCache/...` 等 `get*` 查询接口仅为协议内校验（如 `LendingEngine` 期限门槛）与 `RewardView` 透传/兼容保留，外部调用视为 **DEPRECATED**。

### 唯一路径（强约束，和合约一致）

1. **落账**：`LendingEngine.createLoanOrder` / `LendingEngine.repay` 成功更新账本后触发奖励回调  
2. **积分入口**：`LendingEngine` 调用 `RewardManager.onLoanEvent(user, amount, duration, flag)`  
3. **核心处理**：`RewardManager` 转发到 `RewardManagerCore.onLoanEvent(...)`（外部直接调会被拒绝并 revert：`RewardManagerCore__UseRewardManagerEntry`）  
4. **只读聚合与推送**：  
   - **发放（Earn）侧**：`RewardManagerCore` 调用 `RewardView.push*`（writer 白名单）→ `RewardView` 统一发出 `DataPushed(dataTypeHash,payload)`  
   - **消费（Spend）侧**：`RewardConsumption` 调用 `RewardView.push*`（writer 白名单）→ `RewardView` 统一发出 `DataPushed(dataTypeHash,payload)`
   - **例外（cache-only）**：`RewardView.pushConsumptionRecord(...)` 仅用于写入“可查缓存明细”，默认不额外发 `DataPushed`，以避免与 `REWARD_BURNED/REWARD_PRIVILEGE_UPDATED` 重复并降低日志成本；链下如需消费明细请直接调用 `RewardView.getUserConsumptions` 拉取。

### 服务类型（按合约枚举顺序）

1. AdvancedAnalytics（高级数据分析）
2. PriorityService（优先服务）
3. FeatureUnlock（功能解锁）
4. GovernanceAccess（治理参与）
5. TestnetFeatures（测试网功能）

注意：不要在前端/脚本中硬编码数字索引，使用枚举名或 ABI 常量以避免错位。

### 服务等级

- **Basic** (0): 基础等级
- **Standard** (1): 标准等级
- **Premium** (2): 高级等级
- **VIP** (3): VIP等级

### 积分规则与期限门槛（现行）

- **积分精度**：`RewardPoints.decimals() = 18`，当前“1 积分”在链上表示为 `1e18`。
- **锁定-释放（当前链上基线）**：
  - **借款（duration > 0）**：每次借款成功后，`RewardManagerCore` 为用户**锁定 1 积分**（仅记录锁定，不铸币）。
  - **还款（duration = 0）**：若 `LendingEngine` 判定该笔订单**按期且足额还清**，会传入 `flag=true`，此时释放用户锁定积分并铸币发放（`RewardPoints.mintPoints`）。
- **提前/逾期扣罚**（当 `flag=false`，即未满足“按期且足额”）：
  - **提前还款**：**不释放锁定积分，不处罚**（仅不给积分）。
  - **逾期还款**：不释放锁定积分，并按锁定积分的 **5%** 扣罚（`latePenaltyBps=500`）。
  - **余额不足**：若 `burnPoints` 失败，扣罚会累积到**欠分账本**（`penaltyLedger`），后续发放时会先抵扣欠分再铸币。
- **期限白名单（链上硬约束）**：`LendingEngine` 仅允许 `5/10/15/30/60/90/180/360` 天（以秒存储）。
- **期限门槛（链上硬约束）**：当期限为 `90/180/360` 天时，`LendingEngine` 会读取 `RewardManagerCore.getUserLevel(borrower)`（从 `Registry.getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE)` 解析），要求等级 **≥ 4**。
- **按期窗口（现行实现细节）**：
  - “是否按期且足额还清”的权威判定发生在 `LendingEngine`（当前固定 `ON_TIME_WINDOW = 24 hours`）。
  - `RewardManager.setOnTimeWindow(...)` 当前影响的是 **惩罚路径中“提前/逾期”的判定窗口**，并不会改变 `LendingEngine` 的按期判断。

> 注意（重要一致性）：**当前链上实现已强制“本金 < 1000 USDC 不计分/不锁定”**（`RewardManagerCore` 在 `onLoanEvent` / `onLoanEventV2` 中直接 return）。如果你需要不同的门槛，请同时更新合约与测试，并同步前后端说明。

---

## ⚙️ 部署后配置

### 1. 初始化系统（UUPS + Registry 版）

部署完成后，按以下顺序初始化系统（实现合约 → 代理 → initialize）：

```typescript
// 1) 部署并初始化 RewardPoints（仅需 admin）
const RewardPoints = await ethers.getContractFactory('RewardPoints');
const implToken = await RewardPoints.deploy();
const proxy = await ethers.getContractFactory('ERC1967Proxy');
const token = RewardPoints.attach((await (await proxy.deploy(
  await implToken.getAddress(),
  implToken.interface.encodeFunctionData('initialize', [admin])
)).getAddress()));

// 2) 部署并初始化 RewardManagerCore（registry + 参数）
const RewardManagerCore = await ethers.getContractFactory('RewardManagerCore');
const implRMCore = await RewardManagerCore.deploy();
const rmCore = RewardManagerCore.attach((await (await proxy.deploy(
  await implRMCore.getAddress(),
  implRMCore.interface.encodeFunctionData('initialize', [registry, baseUsd, perDay, bonusBps, baseEth])
)).getAddress()));

// 3) 部署并初始化 RewardManager（registry）
const RewardManager = await ethers.getContractFactory('RewardManager');
const implRM = await RewardManager.deploy();
const rm = RewardManager.attach((await (await proxy.deploy(
  await implRM.getAddress(),
  implRM.interface.encodeFunctionData('initialize', [registry])
)).getAddress()));

// 4) 部署并初始化 RewardCore（registry）
const RewardCore = await ethers.getContractFactory('RewardCore');
const implCore = await RewardCore.deploy();
const rewardCore = RewardCore.attach((await (await proxy.deploy(
  await implCore.getAddress(),
  implCore.interface.encodeFunctionData('initialize', [registry])
)).getAddress()));

// 5) 部署并初始化 RewardConsumption（coreAddr + registry）
const RewardConsumption = await ethers.getContractFactory('RewardConsumption');
const implConsumption = await RewardConsumption.deploy();
const consumption = RewardConsumption.attach((await (await proxy.deploy(
  await implConsumption.getAddress(),
  implConsumption.interface.encodeFunctionData('initialize', [await rewardCore.getAddress(), registry])
)).getAddress()));

// 6) 部署并初始化 RewardView（registry）
const RewardView = await ethers.getContractFactory('RewardView');
const implView = await RewardView.deploy();
const rewardView = RewardView.attach((await (await proxy.deploy(
  await implView.getAddress(),
  implView.interface.encodeFunctionData('initialize', [registry])
)).getAddress()));

// 7) 部署并初始化 5 个服务配置模块（均为 initialize(registry)），并在 Registry 中设置对应 ModuleKeys
```

### 2. 配置权限（ACM 角色）

```typescript
// 授予必要的权限（基于 ActionKeys）
const SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
const UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
const BATCH_WITHDRAW = ethers.keccak256(ethers.toUtf8Bytes('BATCH_WITHDRAW'));

await acm.grantRole(SET_PARAMETER, governanceAddress);
await acm.grantRole(UPGRADE_MODULE, governanceAddress);
await acm.grantRole(BATCH_WITHDRAW, operatorAddress); // 可选：批量消费入口

// 可选：运营/后台读取其他用户的 RewardView 数据（否则仅本人可查）
const VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
await acm.grantRole(VIEW_USER_DATA, operatorAddress);
```

### 3. 配置奖励参数（按现行接口）

```typescript
// 设置基础奖励参数（入口转发到 RewardManagerCore）
await rewardManager.updateRewardParameters(
  ethers.parseUnits('100', 18), // baseEth（保留字段）
  10,                            // perDay（缩放项）
  500,                           // bonusBps（历史字段名 earlyRepayBonus；用于“公式计算/示例计算”，当前锁定-释放基线不依赖该值）
  ethers.parseUnits('100', 18)   // baseUsd
);

// 设置等级倍数（BPS）
await rewardManager.setLevelMultiplier(2, 11000);
await rewardManager.setLevelMultiplier(3, 12500);

// 设置动态奖励
await rewardManager.setDynamicRewardParams(
  ethers.parseUnits('1000', 18), // threshold
  12000                           // multiplier (1.2x)
);
```

### 4. 配置服务价格（子模块示例：AdvancedAnalyticsConfig）

```typescript
// 以高级数据分析为例（其余 4 个子模块同理）
await advancedAnalyticsConfig.updateConfig(0, ethers.parseUnits('200', 18), 30 * 24 * 60 * 60, true);  // Basic
await advancedAnalyticsConfig.updateConfig(1, ethers.parseUnits('500', 18), 30 * 24 * 60 * 60, true);  // Standard
await advancedAnalyticsConfig.updateConfig(2, ethers.parseUnits('1000', 18), 30 * 24 * 60 * 60, true); // Premium
await advancedAnalyticsConfig.updateConfig(3, ethers.parseUnits('2000', 18), 30 * 24 * 60 * 60, true); // VIP
```

### 5. 配置 RewardPoints 铸/销权限（必须）

`RewardManagerCore` 需要具备 `RewardPoints.MINTER_ROLE` 才能 `mintPoints/burnPoints`：

```typescript
const MINTER_ROLE = await token.MINTER_ROLE();
await token.grantRole(MINTER_ROLE, await rmCore.getAddress());
// 可选：减少权限面，撤销 admin 的 MINTER_ROLE（仅保留 DEFAULT_ADMIN_ROLE 管理权限）
// await token.revokeRole(MINTER_ROLE, admin);
```

---

## 👨‍💼 管理员操作（按现行实现）

### 1. 管理奖励参数（建议默认值）

```typescript
// 更新奖励参数
const updateRewardParameters = async () => {
  const rewardManager = new ethers.Contract(
    rewardManagerAddress,
    REWARD_MANAGER_ABI,
    signer
  );

  await rewardManager.updateRewardParameters(
    ethers.parseUnits('120', 18), // baseEth（保留字段）
    20,                           // perDay
    0,                            // earlyRepayBonus（按现行扣罚规则关闭）
    ethers.parseUnits('200', 18)  // baseUsd
  );

  // 动态奖励（可选）
  await rewardManager.setDynamicRewardParams(
    ethers.parseUnits('1000', 18),
    12000
  );
};
```

### 2. 管理服务配置（通过 RewardConfig + 子模块）

```typescript
// 更新服务价格
const updateServicePrice = async (serviceType: number, level: number, newPrice: string) => {
  // 推荐：直接调用具体子配置模块（AdvancedAnalyticsConfig/PriorityServiceConfig/...）
  const serviceConfig = getServiceConfigContract(serviceType); // 指向具体子模块
  // 可选：如果你部署了 RewardConfig 并在 Registry 中设置了 KEY_REWARD_CONFIG，也可以通过 RewardConfig.updateServiceConfig(...) 统一管理
  
  await serviceConfig.updateConfig(
    level,
    ethers.parseUnits(newPrice, 18),
    30 * 24 * 60 * 60, // 30 days
    true
  );
};

// 激活/停用服务
const toggleService = async (serviceType: number, level: number, isActive: boolean) => {
  const serviceConfig = getServiceConfigContract(serviceType);
  const currentConfig = await serviceConfig.getConfig(level);
  
  await serviceConfig.updateConfig(
    level,
    currentConfig.price,
    currentConfig.duration,
    isActive
  );
};
```

### 3. 管理用户等级

```typescript
// 手动更新用户等级
const updateUserLevel = async (userAddress: string, newLevel: number) => {
  const rewardManager = new ethers.Contract(
    rewardManagerAddress,
    REWARD_MANAGER_ABI,
    signer
  );

  await rewardManager.updateUserLevel(userAddress, newLevel);
};

// 说明：暂不提供批量更新接口，请逐个调用 updateUserLevel
```

### 4. 系统监控（统计与地址）

```typescript
// 获取系统统计信息（RewardManager + RewardPoints）
const getSystemStats = async () => {
  const rewardManager = new ethers.Contract(
    rewardManagerAddress,
    REWARD_MANAGER_ABI,
    provider
  );
  const rewardPoints = new ethers.Contract(
    rewardPointsAddress,
    REWARD_POINTS_ABI,
    provider
  );

  const [totalSupply, stats] = await Promise.all([
    rewardPoints.totalSupply(),
    rewardManager.getSystemStats()
  ]);

  const [totalBatchOps, totalCachedRewards, dynamicThreshold, dynamicMultiplier] = stats;
  return {
    totalPoints: totalSupply.toString(),
    totalBatchOps: Number(totalBatchOps),
    totalCachedRewards: Number(totalCachedRewards),
    dynamicThreshold: dynamicThreshold.toString(),
    dynamicMultiplier: Number(dynamicMultiplier)
  };
};
```

---

## 👤 用户操作（按期释放模型）

### 1. 查看积分信息

```typescript
// 获取用户积分仪表板
const getUserDashboard = async (userAddress: string) => {
  // 推荐：统一从 RewardView 查询（只读聚合 + 透传 RewardCore/RewardManagerCore 的必要视图）
  const [balance, summary, recentActivities] = await Promise.all([
    rewardView.getUserBalance(userAddress),
    rewardView.getUserRewardSummary(userAddress),
    rewardView.getUserRecentActivities(userAddress, 0, 0, 20),
  ]);

  return {
    balance: balance.toString(),
    summary,
    recentActivities,
  };
};
```

### 2. 购买服务（按配置价格自动扣除）

```typescript
// 购买服务
const purchaseService = async (serviceType: number, level: number) => {
  try {
    // 1. 检查服务是否可用
    const config = await rewardView.getServiceConfig(serviceType, level);
    if (!config.isActive) {
      throw new Error('Service is not available');
    }

    // 2. 检查积分余额
    const balance = await rewardView.getUserBalance(userAddress);
    if (balance < config.price) {
      throw new Error('Insufficient points');
    }

    // 3. 执行购买
    const rewardConsumption = new ethers.Contract(
      rewardConsumptionAddress,
      REWARD_CONSUMPTION_ABI,
      signer
    );

    const tx = await rewardConsumption.consumePointsForService(serviceType, level);
    const receipt = await tx.wait();

    return {
      success: true,
      transactionHash: receipt.transactionHash,
      serviceType,
      level,
      pointsSpent: config.price,
      duration: config.duration
    };
  } catch (error) {
    console.error('Purchase failed:', error);
    throw error;
  }
};
```

### 3. 查看特权状态（以消费记录为准）

```typescript
// 说明：
// - RewardCore.getUserPrivilege(user) 返回的是“功能开关 + 等级”的结构体（不带过期时间）
// - 服务是否有效/何时过期，以 ConsumptionRecord.isActive + expirationTime 为准
const checkPrivilegeStatus = async (userAddress: string, serviceType: number) => {
  const records = await rewardView.getUserConsumptions(userAddress); // 透传 RewardCore
  const now = BigInt(Math.floor(Date.now() / 1000));
  let latest: any | undefined;

  for (const r of records) {
    // ethers v6：enum 字段通常为 number/bigint（按 ABI 输出），这里按 number 处理示例
    if (Number(r.serviceType) !== serviceType) continue;
    if (!latest || BigInt(r.timestamp) > BigInt(latest.timestamp)) latest = r;
  }

  if (!latest) return { hasPrivilege: false, reason: 'No consumption record' };
  if (!latest.isActive) return { hasPrivilege: false, reason: 'Not active' };
  if (BigInt(latest.expirationTime) <= now) return { hasPrivilege: false, reason: 'Expired' };

  return {
    hasPrivilege: true,
    serviceType,
    level: Number(latest.serviceLevel),
    expiresAt: Number(latest.expirationTime),
  };
};
```

### 4. 积分历史查询（监听核心层事件）

```typescript
// 获取积分获取历史
const getRewardHistory = async (userAddress: string) => {
  // 推荐：监听 RewardView 统一 DataPushed 事件（REWARD_EARNED/REWARD_BURNED/...）
  // 旧版：直接监听 VaultTypes.RewardEarned 仍可用，但不建议作为长期接入方式。
  const filter = rewardView.filters.DataPushed(DataPushTypes.DATA_TYPE_REWARD_EARNED);
  const events = await rewardView.queryFilter(filter);

  return events.map(event => ({
    // payload 解码见“前端集成：统一 DataPushed 订阅”
    dataType: event.args?.dataTypeHash,
    payload: event.args?.payload,
    blockNumber: event.blockNumber,
  }));
};
```

---

## 🖥️ 前端集成

### 1. 初始化 Reward 系统

```typescript
class RewardSystem {
  private rewardView: Contract;
  private rewardConsumption: Contract;

  constructor(
    rewardConsumptionAddress: string,
    rewardViewAddress: string,
    signer: Signer
  ) {
    this.rewardConsumption = new Contract(rewardConsumptionAddress, REWARD_CONSUMPTION_ABI, signer);
    this.rewardView = new Contract(rewardViewAddress, REWARD_VIEW_ABI, signer);
  }

  // 获取用户仪表板
  async getUserDashboard(userAddress: string) {
    const [balance, summary] = await Promise.all([
      this.rewardView.getUserBalance(userAddress),
      this.rewardView.getUserRewardSummary(userAddress),
    ]);

    return {
      balance: balance.toString(),
      summary,
      // 服务配置也可统一从 RewardView 透传读取：getServiceConfig(serviceType, level)
    };
  }

  // 购买服务
  async purchaseService(serviceType: number, level: number) {
    const config = await this.rewardView.getServiceConfig(serviceType, level);
    
    if (!config.isActive) {
      throw new Error('Service not available');
    }

    const user = await this.rewardConsumption.signer.getAddress();
    const balance = await this.rewardView.getUserBalance(user);
    if (balance < config.price) {
      throw new Error('Insufficient points');
    }

    const tx = await this.rewardConsumption.consumePointsForService(serviceType, level);
    return await tx.wait();
  }
}
```

### 2. React Hook 示例

```typescript
// useReward.ts
import { useState, useEffect } from 'react';
import { useContract, useProvider, useSigner } from 'wagmi';

export const useReward = (userAddress: string) => {
  const [rewardData, setRewardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const provider = useProvider();
  const { data: signer } = useSigner();

  const rewardView = useContract({
    address: rewardViewAddress,
    abi: REWARD_VIEW_ABI,
    signerOrProvider: provider
  });

  useEffect(() => {
    const fetchRewardData = async () => {
      try {
        setLoading(true);
        
        const [balance, summary] = await Promise.all([
          rewardView.getUserBalance(userAddress),
          rewardView.getUserRewardSummary(userAddress),
        ]);

        setRewardData({
          balance: balance.toString(),
          summary
        });
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    };

    if (userAddress) {
      fetchRewardData();
    }
  }, [userAddress]);

  const purchaseService = async (serviceType: number, level: number) => {
    if (!signer) throw new Error('No signer');
    
    const rewardConsumption = new Contract(
      rewardConsumptionAddress,
      REWARD_CONSUMPTION_ABI,
      signer
    );

    const config = await rewardView.getServiceConfig(serviceType, level);
    const tx = await rewardConsumption.consumePointsForService(serviceType, level);
    return await tx.wait();
  };

  return {
    rewardData,
    loading,
    error,
    purchaseService,
    refetch: () => fetchRewardData()
  };
};
```

### 3. UI 组件示例

```typescript
// RewardDashboard.tsx
import React from 'react';
import { useReward } from './useReward';

export const RewardDashboard: React.FC<{ userAddress: string }> = ({ userAddress }) => {
  const { rewardData, loading, error, purchaseService } = useReward(userAddress);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!rewardData) return <div>No data</div>;

  return (
    <div className="reward-dashboard">
      <h2>Reward Dashboard</h2>
      
      <div className="reward-stats">
        <div className="stat">
          <label>Points Balance:</label>
          <span>{ethers.formatEther(rewardData.balance)}</span>
        </div>
        <div className="stat">
          <label>User Level:</label>
          <span>{rewardData.summary.level}</span>
        </div>
      </div>

      <div className="privileges">
        <h3>Active Privileges</h3>
        {/* 特权展示建议：从 RewardView.getUserPrivilegePacked 或 getUserConsumptions 透传拿数据后再解码/渲染 */}
      </div>

      <div className="available-services">
        <h3>Available Services</h3>
        {/* 渲染可用服务列表 */}
      </div>
    </div>
  );
};
```

### 3. 期限白名单与等级校验工具（TermGuard.ts）

```typescript
// TermGuard.ts —— 前端可复用的期限与等级校验工具
export const ALLOWED_TERMS_DAYS = [5, 10, 15, 30, 60, 90, 180, 360] as const;
export type AllowedTerm = typeof ALLOWED_TERMS_DAYS[number];

export const MIN_LEVEL_FOR_LONG_TERMS = 4; // 90/180/360 天的最低等级

export function isAllowedTerm(termDays: number): termDays is AllowedTerm {
  return (ALLOWED_TERMS_DAYS as readonly number[]).includes(termDays);
}

export function canBorrowTerm(userLevel: number, termDays: AllowedTerm): {
  allowed: boolean;
  reason?: string;
  requiredLevel?: number;
} {
  if (!isAllowedTerm(termDays)) {
    return { allowed: false, reason: 'Term not in whitelist' };
  }
  if (termDays >= 90 && userLevel < MIN_LEVEL_FOR_LONG_TERMS) {
    return {
      allowed: false,
      reason: 'Level too low for long-term borrowing',
      requiredLevel: MIN_LEVEL_FOR_LONG_TERMS,
    };
  }
  return { allowed: true };
}

export function ensureEligibleAmount(amountUSDT: bigint, minEligibleAmountUSDT: bigint = 1000n): {
  eligible: boolean;
  reason?: string;
} {
  if (amountUSDT < minEligibleAmountUSDT) {
    return { eligible: false, reason: 'Amount below 1000 USDT — no points' };
  }
  return { eligible: true };
}
```

用法示例：

```typescript
import { canBorrowTerm, ensureEligibleAmount } from './TermGuard';

export async function preSubmitBorrowCheck(userLevel: number, termDays: number, amountUSDT: bigint) {
  const termCheck = canBorrowTerm(userLevel, termDays as any);
  if (!termCheck.allowed) {
    throw new Error(termCheck.reason + (termCheck.requiredLevel ? `, need level ≥ ${termCheck.requiredLevel}` : ''));
  }

  const amtCheck = ensureEligibleAmount(amountUSDT);
  if (!amtCheck.eligible) {
    // 允许借款，但提示：本次不产生积分
    console.warn(amtCheck.reason);
  }
}
```

---

## 📚 API 参考

### RewardManager 主要方法（按现行）

```typescript
// 标准写入口（唯一路径：LendingEngine 落账后触发）
function onLoanEvent(address user, uint256 amount, uint256 duration, bool flag) external;

// 更新奖励参数（治理入口，入口转发到 RewardManagerCore）
function updateRewardParameters(
  uint256 baseEth,
  uint256 perDay,
  uint256 earlyRepayBonusBps,
  uint256 baseUsd
) external;

// 等级与动态奖励参数
function setLevelMultiplier(uint8 level, uint256 newMultiplier) external;
function setDynamicRewardParams(uint256 newThreshold, uint256 newMultiplier) external;

// 缓存与等级管理
function setCacheExpirationTime(uint256 newExpirationTime) external;
function clearUserCache(address user) external;
function updateUserLevel(address user, uint8 newLevel) external;
```

> 说明：`RewardManager` 的只读查询接口已移除，前端/链下查询请统一使用 `RewardView`。

### RewardPoints 主要方法（代币层）

```typescript
// 查询余额
function balanceOf(address account) external view returns (uint256);

// 查询总供应量
function totalSupply() external view returns (uint256);

// 查询授权额度
function allowance(address owner, address spender) external view returns (uint256);
```

### RewardConsumption / RewardCore 主要方法（按现行）

```typescript
// 消费服务（入口）
function consumePointsForService(uint8 serviceType, uint8 level) external;

// 获取用户特权（在 RewardCore）
function getUserPrivilege(address user) external view returns (UserPrivilege memory);

// 获取用户消费记录（在 RewardCore）
function getUserConsumptions(address user) external view returns (ConsumptionRecord[] memory);

// 获取用户最后消费时间（在 RewardCore）
function getUserLastConsumption(address user, uint8 serviceType) external view returns (uint256);
```

### ServiceConfig 主要方法

```typescript
// 获取服务配置
function getConfig(uint8 level) external view returns (ServiceConfig memory);

// 更新服务配置
function updateConfig(uint8 level, uint256 price, uint256 duration, bool isActive) external;

// 获取冷却期
function getCooldown() external view returns (uint256);

// 设置冷却期
function setCooldown(uint256 cooldown) external;
```

### RewardView（推荐只读入口）

```typescript
// 统一只读入口（推荐）
function getUserRewardSummary(address user) external view returns (
  uint256 totalEarned,
  uint256 totalBurned,
  uint256 pendingPenalty,
  uint8 level,
  uint256 privilegesPacked,
  uint256 lastActivity,
  uint256 totalLoans,
  uint256 totalVolume
);

function getUserBalance(address user) external view returns (uint256 balance);
function getUserRecentActivities(address user, uint256 fromTs, uint256 toTs, uint256 limit) external view returns (tuple(uint8 kind,uint256 amount,uint256 ts)[] out);
function getSystemRewardStats() external view returns (uint256 totalBatchOps, uint256 totalCachedRewards, uint256 activeUsers);
function getTopEarners() external view returns (address[] memory addrs, uint256[] memory amounts);
```

---

## 🔧 故障排除

### 常见问题

#### 1. 借款后“未见发放积分”（锁定模型下的常见误解）

**现象**: 用户借款成功后，余额未增加。

**解决方案**:
```typescript
// 按现行规则：借款只计算“锁定积分”，按期且足额还清后才会一次性发放。
// 请在到期后（按期窗口内）检查：
// 1) RewardPoints.balanceOf 是否增加（铸币发生在按期且足额还清时）
// 2) RewardView 的 DataPushed(REWARD_EARNED) 是否出现（推荐订阅方式）
// 3) 借款/还款时间是否满足 LendingEngine 的 ON_TIME_WINDOW=24h（当前不可配置）
```

#### 2. 服务购买失败

**问题**: 用户购买服务时交易失败

**解决方案**:
```typescript
// 检查服务配置
const config = await serviceConfig.getConfig(level);
if (!config.isActive) {
  console.error('Service is not active');
  return;
}

// 检查积分余额
const balance = await rewardPoints.balanceOf(userAddress);
if (balance < config.price) {
  console.error('Insufficient points');
  return;
}

// 检查冷却期
const lastConsumption = await rewardCore.getUserLastConsumption(userAddress, serviceType);
const cooldown = await serviceConfig.getCooldown();
const now = BigInt(Math.floor(Date.now() / 1000));

if (lastConsumption + cooldown > now) {
  console.error('Cooldown period not met');
  return;
}
```

#### 3. 权限错误

**问题**: 管理员操作时出现权限错误

**解决方案**:
```typescript
// 检查用户权限
const hasRole = await acm.hasRole(SET_PARAMETER_ROLE, userAddress);
if (!hasRole) {
  console.error('User does not have SET_PARAMETER role');
  return;
}

// 授予权限
await acm.grantRole(SET_PARAMETER_ROLE, userAddress);
```

#### 4. 事件监听失败

**问题**: 前端无法监听到 Reward 事件

**解决方案**:
```typescript
// 确保正确设置事件监听器
const setupEventListeners = () => {
  // 推荐：统一订阅 RewardView 的 DataPushed（REWARD_*）
  rewardView.on('DataPushed', (dataTypeHash, payload) => {
    if (dataTypeHash === DataPushTypes.DATA_TYPE_REWARD_EARNED) {
      // payload = abi.encode(user, amount, reason, ts)
    }
    if (dataTypeHash === DataPushTypes.DATA_TYPE_REWARD_BURNED) {
      // payload = abi.encode(user, amount, reason, ts)
    }
  });
};

// 在组件卸载时清理监听器
useEffect(() => {
  setupEventListeners();
  
  return () => {
    rewardView.removeAllListeners();
    rewardConsumption.removeAllListeners();
  };
}, []);
```

### 调试工具（按现行模块）

#### 1. 检查合约状态

```typescript
const debugContractState = async () => {
  const [managerAddress, managerCoreAddress, pointsAddress, consumptionAddress, rewardCoreAddress] = await Promise.all([
    registry.getModule(ModuleKeys.KEY_REWARD_MANAGER),
    registry.getModule(ModuleKeys.KEY_REWARD_MANAGER_CORE),
    registry.getModule(ModuleKeys.KEY_REWARD_POINTS),
    registry.getModule(ModuleKeys.KEY_REWARD_CONSUMPTION),
    registry.getModule(ModuleKeys.KEY_REWARD_CORE)
  ]);

  console.log('Contract addresses:', {
    manager: managerAddress,
    points: pointsAddress,
    managerCore: managerCoreAddress,
    consumption: consumptionAddress,
    rewardCore: rewardCoreAddress
  });
};
```

#### 2. 检查用户状态

```typescript
const debugUserState = async (userAddress: string) => {
  const [points, level, privileges] = await Promise.all([
    rewardPoints.balanceOf(userAddress),
    rewardManager.getUserLevel(userAddress),
    rewardCore.getUserPrivilege(userAddress)
  ]);

  console.log('User state:', {
    points: points.toString(),
    level: level.toNumber(),
    privileges
  });
};
```

---

## 📞 技术支持

如有问题，请联系：
- 📧 Email: support@example.com
- 💬 Discord: #reward-support
- 📖 文档: https://docs.example.com/reward

---

*本文档将随着 Reward 系统的更新而持续更新。请定期检查最新版本。* 
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

- **RewardManager**: 积分入口与管理（权限校验、参数管理、对外入口）
- **RewardManagerCore**: 发放核心（积分计算、锁定/释放、统计、等级）
- **RewardConsumption**: 消费入口（权限校验、批量入口）
- **RewardCore**: 消费核心（余额校验、扣除、特权状态与历史）
- **RewardConfig**: 服务配置聚合（价格/时长/冷却/批量）
- **ServiceConfigs**: 5 个独立服务配置模块
- **RewardPoints**: 积分代币（仅负责铸/销与暂停，不含业务规则）

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

- 合格借款门槛：借款本金 < 1000 USDT/USDC 不计分；≥ 1000 记为“合格借款”。
- 锁定-释放：合格借款会计算“锁定积分”，在按期且足额还清后一次性释放；提前或逾期不释放。
- 提前/逾期扣罚：
  - 提前还款：不释放该笔锁定积分，且额外扣罚 3%（earlyPenaltyBps=300）。
  - 逾期还款：不释放该笔锁定积分，且额外扣罚 5%（latePenaltyBps=500）。
  - 余额不足扣罚将记入欠分账本，后续积分优先抵扣。
- 固定期限白名单：5/10/15/30/60/90/180/360 天。
- 期限门槛：借款期限为 90/180/360 天时，借款人积分等级需 ≥ 4。
- 履约判定：还款时间需位于到期“按期窗口”（默认 ±24h，可配置）且足额。

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

// 4) 部署并初始化 RewardCore / RewardConsumption / RewardConfig 与 5 个子配置
//   子配置均为 initialize(registry)
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
```

### 3. 配置奖励参数（按现行接口）

```typescript
// 设置基础奖励参数（入口转发到 RewardManagerCore）
await rewardManager.updateRewardParameters(
  ethers.parseUnits('100', 18), // baseEth（保留字段）
  10,                            // perDay（缩放项）
  500,                           // earlyRepayBonus（如采用扣罚，请置 0）
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
  const serviceConfig = getServiceConfigContract(serviceType); // 指向具体子模块
  
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
  const [points, level, privileges, history] = await Promise.all([
    getPointsBalance(userAddress),
    getUserLevel(userAddress),
    getUserPrivileges(userAddress),
    getPointsHistory(userAddress)
  ]);

  return {
    points,
    level,
    privileges,
    history,
    availableServices: await getAvailableServices(userAddress)
  };
};
```

### 2. 购买服务（按配置价格自动扣除）

```typescript
// 购买服务
const purchaseService = async (serviceType: number, level: number) => {
  try {
    // 1. 检查服务是否可用
    const config = await getServiceConfig(serviceType, level);
    if (!config.isActive) {
      throw new Error('Service is not available');
    }

    // 2. 检查积分余额
    const balance = await getPointsBalance(userAddress);
    if (ethers.BigNumber.from(balance).lt(config.price)) {
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

### 3. 查看特权状态（从 RewardCore 查询）

```typescript
// 检查特权是否有效
const checkPrivilegeStatus = async (userAddress: string, serviceType: number) => {
  const privilege = await rewardCore.getUserPrivilege(userAddress);
  
  if (!privilege.isActive) {
    return { hasPrivilege: false, reason: 'No active privilege' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (privilege.expirationTime < now) {
    return { hasPrivilege: false, reason: 'Privilege expired' };
  }

  return {
    hasPrivilege: true,
    level: privilege.level,
    expiresAt: privilege.expirationTime,
    remainingTime: privilege.expirationTime - now
  };
};
```

### 4. 积分历史查询（监听核心层事件）

```typescript
// 获取积分获取历史
const getRewardHistory = async (userAddress: string) => {
  const rewardManagerCore = new ethers.Contract(
    rewardManagerCoreAddress,
    REWARD_MANAGER_CORE_ABI,
    provider
  );

  // 监听核心层 RewardEarned 事件（解锁发放）
  const filter = rewardManagerCore.filters.RewardEarned(userAddress);
  const events = await rewardManagerCore.queryFilter(filter);

  return events.map(event => ({
    points: event.args?.points.toString(),
    reason: event.args?.reason,
    timestamp: Number(event.args?.timestamp ?? 0),
    blockNumber: event.blockNumber
  }));
};
```

---

## 🖥️ 前端集成

### 1. 初始化 Reward 系统

```typescript
class RewardSystem {
  private rewardManager: Contract;
  private rewardPoints: Contract;
  private rewardConsumption: Contract;
  private serviceConfigs: Contract[];

  constructor(
    rewardManagerAddress: string,
    rewardPointsAddress: string,
    rewardConsumptionAddress: string,
    serviceConfigAddresses: string[],
    signer: Signer
  ) {
    this.rewardManager = new Contract(rewardManagerAddress, REWARD_MANAGER_ABI, signer);
    this.rewardPoints = new Contract(rewardPointsAddress, REWARD_POINTS_ABI, signer);
    this.rewardConsumption = new Contract(rewardConsumptionAddress, REWARD_CONSUMPTION_ABI, signer);
    
    this.serviceConfigs = serviceConfigAddresses.map(address => 
      new Contract(address, SERVICE_CONFIG_ABI, signer)
    );
  }

  // 获取用户仪表板
  async getUserDashboard(userAddress: string) {
    const [points, level, privileges] = await Promise.all([
      this.rewardPoints.balanceOf(userAddress),
      this.rewardManager.getUserLevel(userAddress),
      this.getUserPrivileges(userAddress)
    ]);

    return {
      points: points.toString(),
      level: level.toNumber(),
      privileges,
      availableServices: await this.getAvailableServices(userAddress, points)
    };
  }

  // 购买服务
  async purchaseService(serviceType: number, level: number) {
    const config = await this.serviceConfigs[serviceType].getConfig(level);
    
    if (!config.isActive) {
      throw new Error('Service not available');
    }

    const balance = await this.rewardPoints.balanceOf(await this.rewardManager.signer.getAddress());
    if (balance.lt(config.price)) {
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

  const rewardManager = useContract({
    address: rewardManagerAddress,
    abi: REWARD_MANAGER_ABI,
    signerOrProvider: provider
  });

  const rewardPoints = useContract({
    address: rewardPointsAddress,
    abi: REWARD_POINTS_ABI,
    signerOrProvider: provider
  });

  useEffect(() => {
    const fetchRewardData = async () => {
      try {
        setLoading(true);
        
        const [points, level, privileges] = await Promise.all([
          rewardPoints.balanceOf(userAddress),
          rewardManager.getUserLevel(userAddress),
          getUserPrivileges(userAddress)
        ]);

        setRewardData({
          points: points.toString(),
          level: level.toNumber(),
          privileges
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

    const config = await getServiceConfig(serviceType, level);
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
          <span>{ethers.formatEther(rewardData.points)}</span>
        </div>
        <div className="stat">
          <label>User Level:</label>
          <span>{rewardData.level}</span>
        </div>
      </div>

      <div className="privileges">
        <h3>Active Privileges</h3>
        {Object.entries(rewardData.privileges).map(([serviceType, privilege]) => (
          <div key={serviceType} className="privilege">
            <span>{getServiceTypeName(parseInt(serviceType))}</span>
            <span>Level: {privilege.level}</span>
            <span>Expires: {new Date(privilege.expirationTime * 1000).toLocaleDateString()}</span>
          </div>
        ))}
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
// 查询用户等级
function getUserLevel(address user) external view returns (uint8);

// 查询用户奖励（本质为 RewardPoints.balanceOf(user)）
function getUserReward(address user) external view returns (uint256);

// 查询用户缓存积分
function getPointCache(address user) external view returns (uint256 points);

// 查询系统统计（批量/缓存/动态奖励参数）
function getSystemStats() external view returns (
  uint256 totalBatchOps,
  uint256 totalCachedRewards,
  uint256 dynamicThreshold,
  uint256 dynamicMultiplier
);

// 更新奖励参数（入口转发到 RewardManagerCore）
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

---

## 🔧 故障排除

### 常见问题

#### 1. 借款后“未见发放积分”（锁定模型下的常见误解）

**现象**: 用户借款成功后，余额未增加。

**解决方案**:
```typescript
// 按现行规则：借款只计算“锁定积分”，按期且足额还清后才会一次性发放。
// 请在到期后（按期窗口内）检查 RewardManagerCore.RewardEarned 事件或余额变动。
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
if (balance.lt(config.price)) {
  console.error('Insufficient points');
  return;
}

// 检查冷却期
const lastConsumption = await rewardCore.getUserLastConsumption(userAddress, serviceType);
const cooldown = await serviceConfig.getCooldown();
const now = Math.floor(Date.now() / 1000);

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
  // 按现行实现：监听 RewardManagerCore 的 RewardEarned
  rewardManagerCore.on('RewardEarned', (user, points, reason, timestamp) => {
    console.log('Reward earned:', { user, points: points.toString(), reason });
  });

  rewardConsumption.on('ServiceConsumed', (user, serviceType, level, points, timestamp) => {
    console.log('Service consumed:', { 
      user, 
      serviceType: serviceType.toNumber(), 
      level: level.toNumber(),
      points: points.toString() 
    });
  });
};

// 在组件卸载时清理监听器
useEffect(() => {
  setupEventListeners();
  
  return () => {
    rewardManager.removeAllListeners();
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
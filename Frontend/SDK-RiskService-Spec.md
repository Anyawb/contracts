## SDK RiskService 约定（前端服务层）

目标
- 统一对 HealthView 与 LiquidationRiskManager 的读取接口；
- 提供单用户与批量的健康/风险拉取；
- 内置 isValid 处理与 bps→百分比展示的辅助。

API 设计
```ts
export type UserRisk = {
  user: string;
  hfBps: bigint;
  minHFBps: bigint;
  under: boolean;
  isValid: boolean;
};

export interface RiskService {
  fetchUserRisk(user: string): Promise<UserRisk>;
  fetchBatchRisk(users: string[]): Promise<UserRisk[]>;
}
```

参考实现（伪代码，ethers v6）
```ts
import { ethers } from 'ethers';

export function createRiskService(healthView: any, lrm: any): RiskService {
  const fetchUserRisk = async (user: string): Promise<UserRisk> => {
    const [hfBps, isValid] = await healthView.getUserHealthFactor(user);
    const minHFBps = await lrm.getMinHealthFactor();
    const under = hfBps < minHFBps;
    return { user, hfBps, minHFBps, under, isValid };
  };

  const fetchBatchRisk = async (users: string[]): Promise<UserRisk[]> => {
    const [hfs, validFlags] = await healthView.batchGetHealthFactors(users);
    const minHFBps = await lrm.getMinHealthFactor();
    return users.map((u, i) => ({
      user: u,
      hfBps: hfs[i],
      minHFBps,
      under: hfs[i] < minHFBps,
      isValid: validFlags[i],
    }));
  };

  return { fetchUserRisk, fetchBatchRisk };
}
```

UI 辅助
```ts
export const bpsToPercent = (bps: bigint) => Number(bps) / 100;
export const formatBps = (bps: bigint) => `${bpsToPercent(bps).toFixed(2)}%`;
```

策略
- 仅当资产或产品标记为 `oraclePriced=true` 时调用此服务；
- 事件驱动优先：监听 DataPushed，落库到本地 store；无事件时再调用服务层拉取。



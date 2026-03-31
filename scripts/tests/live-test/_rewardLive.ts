import { ethers } from "hardhat";

import {
  bootstrapFundsFlowLiveTest,
  type FundsFlowLiveContext,
} from "./_fundsFlowLive";
import { key } from "./_mockLiveUtils";

export type RewardUserSnapshot = {
  totalBurned: bigint;
  pendingPenalty: bigint;
  level: bigint;
  lastActivity: bigint;
  summaryBlock: bigint;
  summaryValid: boolean;
  easyEarned: bigint;
  easyEarnedBlock: bigint;
  easyEarnedValid: boolean;
  lockedEasy: bigint;
  eligibleLoanCount: bigint;
  onTimeRepayCount: bigint;
  earnBlock: bigint;
  earnValid: boolean;
  easySpent: bigint;
  easySpentBlock: bigint;
  easySpentValid: boolean;
  recentActivityCount: bigint;
  activityBlock: bigint;
  activityValid: boolean;
  easyBalance: bigint;
  penaltyDebt: bigint;
};

export type RewardSpendStats = {
  totalSpent: bigint;
  totalRecycled: bigint;
  totalBurned: bigint;
  totalTeam: bigint;
  totalEco: bigint;
  blockNumber: bigint;
  isValid: boolean;
};

export type RewardModules = {
  registry: any;
  rewardManagerAddr: string;
  rewardManagerCoreAddr: string;
  rewardAccrualManagerAddr: string;
  rewardConfigAddr: string;
  featureRegistryAddr: string;
  easyEmissionConfigAddr: string;
  easyEmissionControllerAddr: string;
  easyConsumptionAddr: string;
  easyRecycleDistributorAddr: string;
  easyTokenAddr: string;
  rewardManager: any;
  rewardManagerCore: any;
  rewardAccrualManager: any;
  rewardConfig: any;
  featureRegistry: any;
  easyEmissionConfig: any;
  easyEmissionController: any;
  easyConsumption: any;
  easyRecycleDistributor: any;
  easyToken: any;
  rewardView: any;
};

export type RewardViewPush = {
  dataTypeHash: string;
  payload: string;
};

export type RewardBootstrapResult = {
  ctx: FundsFlowLiveContext;
  reward: RewardModules;
};

export async function bootstrapRewardLiveTest(params: {
  label: string;
  noticeLabel: string;
  collateralAmountUnitsDefault?: string;
  borrowAmountUnitsDefault?: string;
  fundActors?: {
    borrowerBorrowAmount?: bigint;
    borrowerCollateralAmount?: bigint;
    lenderBorrowAmount?: bigint;
  };
}) : Promise<RewardBootstrapResult> {
  const { ctx } = await bootstrapFundsFlowLiveTest({
    label: params.label,
    noticeLabel: params.noticeLabel,
    collateralAmountUnitsDefault: params.collateralAmountUnitsDefault,
    borrowAmountUnitsDefault: params.borrowAmountUnitsDefault,
    withFreshBorrower: true,
    useDefaultActorFunding: true,
    fundActors: {
      borrowerBorrowAmount: params.fundActors?.borrowerBorrowAmount,
      borrowerCollateralAmount: params.fundActors?.borrowerCollateralAmount,
      lenderBorrowAmount: params.fundActors?.lenderBorrowAmount,
    },
  });

  const reward = await loadRewardModules(ctx);
  return { ctx, reward };
}

export function expectRevert(error: unknown, label: string) {
  const message = String((error as any)?.shortMessage ?? (error as any)?.message ?? error);
  if (/revert|missing role|unauthorized|invalid caller|use rewardmanager entry/i.test(message)) {
    return;
  }
  throw new Error(`${label}: expected revert, got ${message}`);
}

export async function expectStaticRevert(label: string, invoke: () => Promise<unknown>) {
  try {
    await invoke();
  } catch (error: unknown) {
    expectRevert(error, label);
    return;
  }
  throw new Error(`${label}: expected revert, but call succeeded`);
}

export async function loadRewardModules(ctx: FundsFlowLiveContext): Promise<RewardModules> {
  const registry = (await ethers.getContractAt(
    [
      "function getModuleOrRevert(bytes32) view returns (address)",
      "function getModule(bytes32) view returns (address)",
    ],
    ctx.registryAddr,
  )) as any;

  const rewardManagerAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER"))) as string;
  const rewardManagerCoreAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER_CORE"))) as string;
  const rewardAccrualManagerAddr = (await registry.getModuleOrRevert(key("REWARD_ACCRUAL_MANAGER"))) as string;
  const rewardConfigAddr = (await registry.getModuleOrRevert(key("REWARD_CONFIG"))) as string;
  const featureRegistryAddr = (await registry.getModuleOrRevert(key("FEATURE_REGISTRY"))) as string;
  const easyEmissionConfigAddr = (await registry.getModuleOrRevert(key("EASY_EMISSION_CONFIG"))) as string;
  const easyEmissionControllerAddr = (await registry.getModuleOrRevert(key("EASY_EMISSION_CONTROLLER"))) as string;
  const easyConsumptionAddr = (await registry.getModuleOrRevert(key("EASY_CONSUMPTION"))) as string;
  const easyRecycleDistributorAddr = (await registry.getModuleOrRevert(key("EASY_RECYCLE_DISTRIBUTOR"))) as string;
  const easyTokenAddr = (await registry.getModuleOrRevert(key("EASY_TOKEN"))) as string;

  const rewardManager = (await ethers.getContractAt(
    [
      "event PenaltyApplied(address indexed user,uint256 easyAmount,uint256 remainingDebt)",
      "function onLoanEventByOrder(address user,uint256 orderId,uint256 amount,uint256 maturity,uint8 outcome)",
      "function onLoanEventByOrderWithLender(address borrower,address lender,address asset,uint256 orderId,uint256 amount,uint256 maturity,uint8 outcome)",
      "function quoteLiquidationPenalty(address user) view returns (uint256)",
      "function applyLiquidationPenalty(address user) returns (uint256)",
      "function setDynamicRewardParams(uint256 thresholdEasy,uint256 multiplierBps)",
      "function setLevelMultiplier(uint8 level,uint256 multiplierBps)",
    ],
    rewardManagerAddr,
  )) as any;
  const rewardManagerCore = (await ethers.getContractAt(
    ["function onLoanEventByOrder(address user,uint256 orderId,uint256 amount,uint256 maturity,uint8 outcome)"],
    rewardManagerCoreAddr,
  )) as any;
  const rewardAccrualManager = (await ethers.getContractAt(
    [
      "event PenaltyApplied(bytes32 indexed actionKey,address indexed user,uint256 easyAmount,uint256 remainingDebt,string reason,address indexed executor,uint256 blockNumber)",
      "function applyPenaltyByGfm(address user,uint256 easyAmount)",
      "function applyPenaltyFromGateway(address user,uint256 easyAmount,address executor)",
      "function applyLateRepayPenalty(address user,uint256 easyAmount,address executor)",
      "function offsetPenaltyOnReward(address user,uint256 easyRewardAmount,string reason) returns (uint256)",
      "function getPenaltyDebt(address user) view returns (uint256)",
    ],
    rewardAccrualManagerAddr,
  )) as any;
  const rewardConfig = (await ethers.getContractAt(
    [
      "function setFeature(bytes32 featureKey,uint8 minLevel,bool enabled,string nameOrUri)",
      "function batchSetFeatures(bytes32[] keys,uint8[] minLevels,bool[] enableds,string[] uris)",
    ],
    rewardConfigAddr,
  )) as any;
  const featureRegistry = (await ethers.getContractAt(
    [
      "function getFeature(bytes32 featureKey) view returns (uint8,bool,string)",
      "function listFeatureKeys(uint256 offset,uint256 limit) view returns (bytes32[] memory,uint256)",
      "function setFeature(bytes32 featureKey,uint8 minLevel,bool enabled,string nameOrUri)",
    ],
    featureRegistryAddr,
  )) as any;
  const easyEmissionConfig = (await ethers.getContractAt(
    [
      "function getEmissionParams() view returns (uint256,uint256,uint256,uint256,uint256)",
      "function setEmissionParams(uint256 thresholdUsd8,uint256 mintPer1000Usd,uint256 kNum,uint256 kDen)",
    ],
    easyEmissionConfigAddr,
  )) as any;
  const easyEmissionController = (await ethers.getContractAt(
    [
      "event EasyMinted(address indexed borrower,address indexed lender,uint256 indexed orderId,uint256 amountUsd8,uint256 totalMinted,uint256 borrowerShare,uint256 lenderShare,uint8 stage,uint256 retainedEasy,uint256 totalBorrowVolumeUsd8,bool flowValid,uint256 blockNumber)",
      "event EasyMintSkipped(address indexed borrower,address indexed lender,uint256 indexed orderId,string reason)",
      "function onLoanEventByOrderWithLender(address borrower,address lender,address asset,uint256 orderId,uint256 amountBaseUnits,uint256 maturity,uint8 outcome)",
    ],
    easyEmissionControllerAddr,
  )) as any;
  const easyConsumption = (await ethers.getContractAt(
    [
      "function consumeEasiMCall(address user)",
      "function consumeStrategyApiCall(address user)",
    ],
    easyConsumptionAddr,
  )) as any;
  const easyRecycleDistributor = (await ethers.getContractAt(
    [
      "function getRecipients() view returns (address,address)",
      "function settleOutstandingEasyBalance() returns (uint256)",
      "function setRecipients(address teamRecipient,address ecoRecipient)",
    ],
    easyRecycleDistributorAddr,
  )) as any;
  const easyToken = (await ethers.getContractAt(
    [
      "function balanceOf(address owner) view returns (uint256)",
      "function totalSupply() view returns (uint256)",
      "function allowance(address owner,address spender) view returns (uint256)",
      "function approve(address spender,uint256 amount) returns (bool)",
      "function transfer(address to,uint256 amount) returns (bool)",
    ],
    easyTokenAddr,
  )) as any;
  const rewardView = (await ethers.getContractAt(
    [
      "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
      "function getUserRewardSummaryWithMeta(address user) view returns (uint256,uint256,uint8,uint256,uint256,bool)",
      "function getUserEasyEarnedWithMeta(address user) view returns (uint256,uint256,bool)",
      "function getUserEarnStateWithMeta(address user) view returns (uint256,uint256,uint256,uint256,bool)",
      "function getUserEasySpentWithMeta(address user) view returns (uint256,uint256,bool)",
      "function getUserRecentActivitiesWithMeta(address user,uint256 fromBlock,uint256 toBlock,uint256 limit) view returns (tuple(uint8 kind,uint256 amount,uint256 blockNumber)[] memory,uint256,bool)",
      "function getEasySpendStatsWithMeta() view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool)",
      "function getDynamicRewardParamsWithMeta() view returns (uint256,uint256,uint256,bool)",
      "function getLevelMultiplierWithMeta(uint8 level) view returns (uint256,uint256,bool)",
      "function getEasyEmissionParamsWithMeta() view returns (uint256,uint256,uint256,uint256,uint256,bool)",
      "function getSystemRewardStatsWithMeta() view returns (uint256,uint256,uint256,uint256,bool)",
      "function getTopEarnersWithMeta() view returns (address[] memory,uint256[] memory,uint256,bool)",
      "function retryPushPenaltyLedger(address user,uint256 pendingDebt,uint256 blockNumber)",
      "function retryPushEasyBurned(address user,uint256 easyAmount,string reason,uint256 blockNumber)",
    ],
    ctx.rewardView.target as string,
  )) as any;

  return {
    registry,
    rewardManagerAddr,
    rewardManagerCoreAddr,
    rewardAccrualManagerAddr,
    rewardConfigAddr,
    featureRegistryAddr,
    easyEmissionConfigAddr,
    easyEmissionControllerAddr,
    easyConsumptionAddr,
    easyRecycleDistributorAddr,
    easyTokenAddr,
    rewardManager,
    rewardManagerCore,
    rewardAccrualManager,
    rewardConfig,
    featureRegistry,
    easyEmissionConfig,
    easyEmissionController,
    easyConsumption,
    easyRecycleDistributor,
    easyToken,
    rewardView,
  } satisfies RewardModules;
}

export async function readRewardUser(modules: RewardModules, caller: any, user: string): Promise<RewardUserSnapshot> {
  const [summary, easyEarned, earnState, easySpent, recent, easyBalance, penaltyDebt] = await Promise.all([
    modules.rewardView.connect(caller).getUserRewardSummaryWithMeta(user),
    modules.rewardView.connect(caller).getUserEasyEarnedWithMeta(user),
    modules.rewardView.connect(caller).getUserEarnStateWithMeta(user),
    modules.rewardView.connect(caller).getUserEasySpentWithMeta(user),
    modules.rewardView.connect(caller).getUserRecentActivitiesWithMeta(user, 0n, 0n, 16n),
    modules.easyToken.balanceOf(user),
    modules.rewardAccrualManager.getPenaltyDebt(user),
  ]);

  const [totalBurned, pendingPenalty, level, lastActivity, summaryBlock, summaryValid] = summary as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    boolean,
  ];
  const [earned, earnedBlock, earnedValid] = easyEarned as [bigint, bigint, boolean];
  const [lockedEasy, eligibleLoanCount, onTimeRepayCount, earnBlock, earnValid] = earnState as [
    bigint,
    bigint,
    bigint,
    bigint,
    boolean,
  ];
  const [spent, spentBlock, spentValid] = easySpent as [bigint, bigint, boolean];
  const [activities, activityBlock, activityValid] = recent as [any[], bigint, boolean];

  return {
    totalBurned,
    pendingPenalty,
    level,
    lastActivity,
    summaryBlock,
    summaryValid,
    easyEarned: earned,
    easyEarnedBlock: earnedBlock,
    easyEarnedValid: earnedValid,
    lockedEasy,
    eligibleLoanCount,
    onTimeRepayCount,
    earnBlock,
    earnValid,
    easySpent: spent,
    easySpentBlock: spentBlock,
    easySpentValid: spentValid,
    recentActivityCount: BigInt(activities.length),
    activityBlock,
    activityValid,
    easyBalance: easyBalance as bigint,
    penaltyDebt: penaltyDebt as bigint,
  } satisfies RewardUserSnapshot;
}

export async function tryReadSpendStats(modules: RewardModules, caller: any): Promise<RewardSpendStats | null> {
  try {
    const stats = (await modules.rewardView.connect(caller).getEasySpendStatsWithMeta()) as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
    ];
    return {
      totalSpent: stats[0],
      totalRecycled: stats[1],
      totalBurned: stats[2],
      totalTeam: stats[3],
      totalEco: stats[4],
      blockNumber: stats[5],
      isValid: stats[6],
    } satisfies RewardSpendStats;
  } catch {
    return null;
  }
}

export function decodeEasyMinted(modules: RewardModules, receipt: any) {
  const topic = modules.easyEmissionController.interface.getEvent("EasyMinted").topicHash.toLowerCase();
  return (receipt.logs ?? [])
    .filter(
      (log: any) =>
        String(log.address ?? "").toLowerCase() === modules.easyEmissionControllerAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === topic,
    )
    .map((log: any) => modules.easyEmissionController.interface.parseLog({ topics: log.topics, data: log.data }));
}

export function decodeEasyMintSkipped(modules: RewardModules, receipt: any) {
  const topic = modules.easyEmissionController.interface.getEvent("EasyMintSkipped").topicHash.toLowerCase();
  return (receipt.logs ?? [])
    .filter(
      (log: any) =>
        String(log.address ?? "").toLowerCase() === modules.easyEmissionControllerAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === topic,
    )
    .map((log: any) => modules.easyEmissionController.interface.parseLog({ topics: log.topics, data: log.data }));
}

export function decodeRewardViewPushes(modules: RewardModules, receipt: any): RewardViewPush[] {
  const topic = modules.rewardView.interface.getEvent("DataPushed").topicHash.toLowerCase();
  return (receipt.logs ?? [])
    .filter(
      (log: any) =>
        String(log.address ?? "").toLowerCase() === modules.rewardView.target.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === topic,
    )
    .map((log: any) => {
      const parsed = modules.rewardView.interface.parseLog({ topics: log.topics, data: log.data });
      return {
        dataTypeHash: String(parsed?.args?.dataTypeHash ?? parsed?.args?.[0] ?? ""),
        payload: String(parsed?.args?.payload ?? parsed?.args?.[1] ?? "0x"),
      } satisfies RewardViewPush;
    });
}

export function findRewardViewPush(receiptPushes: RewardViewPush[], typeName: string): RewardViewPush | undefined {
  const typeHash = key(typeName).toLowerCase();
  for (let index = receiptPushes.length - 1; index >= 0; index -= 1) {
    if (receiptPushes[index].dataTypeHash.toLowerCase() === typeHash) {
      return receiptPushes[index];
    }
  }
  return undefined;
}

export function requireRewardViewPush(
  receiptPushes: RewardViewPush[],
  typeName: string,
  message?: string,
): RewardViewPush {
  const push = findRewardViewPush(receiptPushes, typeName);
  if (!push) {
    throw new Error(message ?? `missing RewardView DataPushed(${typeName})`);
  }
  return push;
}

export function requireNoEasyMintSkipped(
  skippedLogs: any[],
  contextMessage?: string,
) {
  if (skippedLogs.length === 0) {
    return;
  }
  const reason = String(skippedLogs[0]?.args?.reason ?? "unknown");
  throw new Error(
    contextMessage
      ? `${contextMessage}: ${reason}`
      : `expected EasyMinted, got EasyMintSkipped: ${reason}`,
  );
}

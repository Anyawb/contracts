import { ethers, network } from "hardhat";

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

export type EasyMintRepayOutcome = {
  mintedPush?: RewardViewPush;
  skippedLogs: any[];
  skipReason?: string;
  hasAcceptedSkip: boolean;
};

export type EasyEmissionParamsShape = "current-6" | "legacy-5" | "unknown";

export type EasyEmissionParamsSnapshot = {
  thresholdValue: bigint;
  mintPer1000Usd: bigint;
  kNum: bigint;
  kDen: bigint;
  valuationDecimals: bigint | null;
  updateBlock: bigint;
  shape: EasyEmissionParamsShape;
};

export type RewardGovernanceCompatibility = {
  shape: EasyEmissionParamsShape;
  legacyEasyEmissionConfig: boolean;
  logicalNetwork: string;
  address: string;
};

export const DEFAULT_ACCEPTED_EASY_MINT_SKIP_REASONS = [
  "below-min-1000u",
  "price-unavailable",
  "unsupported-valuation-decimals",
  "offset-fully",
] as const;

const CURRENT_EASY_EMISSION_CONFIG_INTERFACE = new ethers.Interface([
  "function getEmissionParams() view returns (uint256,uint256,uint256,uint256,uint8,uint256)",
]);
const LEGACY_EASY_EMISSION_CONFIG_INTERFACE = new ethers.Interface([
  "function getEmissionParams() view returns (uint256,uint256,uint256,uint256,uint256)",
]);

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
    collateralAmountUnitsDefault: params.collateralAmountUnitsDefault ?? "1000",
    borrowAmountUnitsDefault: params.borrowAmountUnitsDefault ?? "100",
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

function envBool(name: string, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveLogicalNetwork() {
  const alias = process.env.LIVE_NETWORK_ALIAS?.trim();
  if (alias) {
    return alias;
  }
  return network.name;
}

export async function probeEasyEmissionConfigShape(easyEmissionConfigAddr: string): Promise<EasyEmissionParamsShape> {
  const data = CURRENT_EASY_EMISSION_CONFIG_INTERFACE.encodeFunctionData("getEmissionParams");
  const raw = await ethers.provider.call({
    to: easyEmissionConfigAddr,
    data,
  });

  const payload = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (payload.length === 0 || payload.length % 64 !== 0) {
    return "unknown";
  }

  const words = payload.length / 64;
  if (words === 6) {
    return "current-6";
  }
  if (words === 5) {
    return "legacy-5";
  }
  return "unknown";
}

export async function readEasyEmissionParamsSnapshot(easyEmissionConfigAddr: string): Promise<EasyEmissionParamsSnapshot> {
  const data = CURRENT_EASY_EMISSION_CONFIG_INTERFACE.encodeFunctionData("getEmissionParams");
  const raw = await ethers.provider.call({
    to: easyEmissionConfigAddr,
    data,
  });
  const shape = await probeEasyEmissionConfigShape(easyEmissionConfigAddr);

  if (shape === "current-6") {
    const [thresholdValue, mintPer1000Usd, kNum, kDen, valuationDecimals, updateBlock] =
      CURRENT_EASY_EMISSION_CONFIG_INTERFACE.decodeFunctionResult("getEmissionParams", raw) as unknown as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
    return {
      thresholdValue,
      mintPer1000Usd,
      kNum,
      kDen,
      valuationDecimals,
      updateBlock,
      shape,
    };
  }

  if (shape === "legacy-5") {
    const [thresholdValue, mintPer1000Usd, kNum, kDen, updateBlock] =
      LEGACY_EASY_EMISSION_CONFIG_INTERFACE.decodeFunctionResult("getEmissionParams", raw) as unknown as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
    return {
      thresholdValue,
      mintPer1000Usd,
      kNum,
      kDen,
      valuationDecimals: null,
      updateBlock,
      shape,
    };
  }

  throw new Error(
    `reward-governance-preflight failed: unsupported EasyEmissionConfig getEmissionParams shape at ${easyEmissionConfigAddr}`,
  );
}

export async function prepareRewardGovernanceCompatibility(
  easyEmissionConfigAddr: string,
): Promise<RewardGovernanceCompatibility> {
  const logicalNetwork = resolveLogicalNetwork();
  const shape = await probeEasyEmissionConfigShape(easyEmissionConfigAddr);

  if (shape === "current-6") {
    delete process.env.LIVE_REWARD_LEGACY_EASY_EMISSION_CONFIG;
    return {
      shape,
      legacyEasyEmissionConfig: false,
      logicalNetwork,
      address: easyEmissionConfigAddr,
    };
  }

  if (shape === "legacy-5") {
    if (!envBool("LIVE_REWARD_ALLOW_LEGACY_EASY_EMISSION_CONFIG", false)) {
      throw new Error(
        `reward-governance-preflight failed: EasyEmissionConfig ABI drift on ${logicalNetwork} (address=${easyEmissionConfigAddr}, observed=legacy-5, expected=current-6)`,
      );
    }

    process.env.LIVE_REWARD_LEGACY_EASY_EMISSION_CONFIG = "1";
    console.log(
      `  [Notice] reward-governance-preflight: legacyEasyEmissionConfig=true logicalNetwork=${logicalNetwork} address=${easyEmissionConfigAddr} observedShape=legacy-5; governance will run in downgraded compatibility mode`,
    );
    return {
      shape,
      legacyEasyEmissionConfig: true,
      logicalNetwork,
      address: easyEmissionConfigAddr,
    };
  }

  throw new Error(
    `reward-governance-preflight failed: EasyEmissionConfig ABI drift on ${logicalNetwork} (address=${easyEmissionConfigAddr}, observed=unknown, expected=current-6)`,
  );
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

  const rewardManager = (await ethers.getContractAt("RewardManager", rewardManagerAddr)) as any;
  const rewardManagerCore = (await ethers.getContractAt("RewardManagerCore", rewardManagerCoreAddr)) as any;
  const rewardAccrualManager = (await ethers.getContractAt("RewardAccrualManager", rewardAccrualManagerAddr)) as any;
  const rewardConfig = (await ethers.getContractAt("RewardConfig", rewardConfigAddr)) as any;
  const featureRegistry = (await ethers.getContractAt("FeatureRegistry", featureRegistryAddr)) as any;
  const easyEmissionConfig = (await ethers.getContractAt("EasyEmissionConfig", easyEmissionConfigAddr)) as any;
  const easyEmissionController = (await ethers.getContractAt("EasyEmissionController", easyEmissionControllerAddr)) as any;
  const easyConsumption = (await ethers.getContractAt("EasyConsumption", easyConsumptionAddr)) as any;
  const easyRecycleDistributor = (await ethers.getContractAt("EasyRecycleDistributor", easyRecycleDistributorAddr)) as any;
  const easyToken = (await ethers.getContractAt("EasyToken", easyTokenAddr)) as any;
  const rewardView = (await ethers.getContractAt("RewardView", ctx.rewardView.target as string)) as any;

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

export function inspectEasyMintRepayOutcome(
  modules: RewardModules,
  receipt: any,
  options: {
    rewardViewPushes?: RewardViewPush[];
    acceptedSkipReasons?: readonly string[];
  } = {},
): EasyMintRepayOutcome {
  const rewardViewPushes = options.rewardViewPushes ?? decodeRewardViewPushes(modules, receipt);
  const skippedLogs = decodeEasyMintSkipped(modules, receipt);
  const skipReason = skippedLogs.length > 0 ? String(skippedLogs[0]?.args?.reason ?? "unknown") : undefined;
  const acceptedSkipReasons = new Set((options.acceptedSkipReasons ?? []).map((reason) => reason.toLowerCase()));

  return {
    mintedPush: findRewardViewPush(rewardViewPushes, "EASY_MINTED"),
    skippedLogs,
    skipReason,
    hasAcceptedSkip: Boolean(skipReason && acceptedSkipReasons.has(skipReason.toLowerCase())),
  };
}

export function requireEasyMintedOrAcceptedSkip(
  outcome: EasyMintRepayOutcome,
  contextMessage?: string,
) : RewardViewPush | null {
  if (outcome.mintedPush || outcome.hasAcceptedSkip) {
    return outcome.mintedPush ?? null;
  }

  const reason = outcome.skipReason ?? "missing-push";
  throw new Error(
    contextMessage
      ? `${contextMessage}: ${reason}`
      : `repay tx did not emit RewardView DataPushed(EASY_MINTED): ${reason}`,
  );
}

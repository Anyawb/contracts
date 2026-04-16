import { ethers } from "hardhat";

import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  finalizeSingleMatch,
  fundFundsFlowActors,
  observeExtendedViews,
  repayOrder,
  reserveForLending,
} from "../core/_fundsFlowLive";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

type UserRewardRead = {
  totalBurned: bigint;
  pendingPenalty: bigint;
  level: bigint;
  lastActivity: bigint;
  blockNumber: bigint;
  isValid: boolean;
  easyEarned: bigint;
  easyBlock: bigint;
  easyValid: boolean;
  lockedEasy: bigint;
  eligibleLoanCount: bigint;
  onTimeRepayCount: bigint;
  earnBlock: bigint;
  earnValid: boolean;
  recentActivityCount: bigint;
  activityBlock: bigint;
  activityValid: boolean;
};

function requireValidLoanFlowUser(snapshot: Awaited<ReturnType<typeof observeExtendedViews>>, stage: string) {
  if (!snapshot.loanFlowUser) {
    throw new Error(`${stage}: LoanFlowView user snapshot should be available in reward boundary script`);
  }
  if (!snapshot.loanFlowUser.isValid) {
    throw new Error(`${stage}: LoanFlowView user snapshot is present but not publish-ready`);
  }
  return true;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLoanFlowUserPublishReady(
  ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>,
  stage: string,
  options?: { attempts?: number; pollMs?: number },
) {
  const attempts = Math.max(1, options?.attempts ?? 8);
  const pollMs = Math.max(200, options?.pollMs ?? 1200);
  let lastSnapshot: Awaited<ReturnType<typeof observeExtendedViews>> | null = null;

  for (let i = 1; i <= attempts; i += 1) {
    lastSnapshot = await observeExtendedViews(ctx, `${stage}-publish-ready-${i}/${attempts}`);
    const user = lastSnapshot.loanFlowUser;
    if (user?.isValid) {
      return lastSnapshot;
    }
    if (i < attempts) {
      await delay(pollMs);
    }
  }

  if (lastSnapshot?.loanFlowUser) {
    throw new Error(
      `${stage}: LoanFlowView user snapshot is present but not publish-ready after polling attempts=${attempts}`,
    );
  }
  throw new Error(`${stage}: LoanFlowView user snapshot should be available in reward boundary script`);
}

async function readUserReward(rewardView: any, userAddr: string) {
  const [summary, easy, earnState, recent] = await Promise.all([
    rewardView.getUserRewardSummaryWithMeta(userAddr),
    rewardView.getUserEasyEarnedWithMeta(userAddr),
    rewardView.getUserEarnStateWithMeta(userAddr),
    rewardView.getUserRecentActivitiesWithMeta(userAddr, 0n, 0n, 8n),
  ]);

  const [totalBurned, pendingPenalty, level, lastActivity, blockNumber, isValid] = summary as [bigint, bigint, bigint, bigint, bigint, boolean];
  const [easyEarned, easyBlock, easyValid] = easy as [bigint, bigint, boolean];
  const [lockedEasy, eligibleLoanCount, onTimeRepayCount, earnBlock, earnValid] = earnState as [bigint, bigint, bigint, bigint, boolean];
  const [activities, activityBlock, activityValid] = recent as [any[], bigint, boolean];

  return {
    totalBurned,
    pendingPenalty,
    level,
    lastActivity,
    blockNumber,
    isValid,
    easyEarned,
    easyBlock,
    easyValid,
    lockedEasy,
    eligibleLoanCount,
    onTimeRepayCount,
    earnBlock,
    earnValid,
    recentActivityCount: BigInt(activities.length),
    activityBlock,
    activityValid,
  } satisfies UserRewardRead;
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live View Reward LoanFlow Boundary",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh loanflow-boundary borrower" });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);
  await fundFundsFlowActors(ctx, {
    borrowerBorrowAmount: ctx.totalDue,
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });

  const rewardView = (await ethers.getContractAt(
    [
      "function getRegistry() view returns (address)",
      "function getUserRewardSummaryWithMeta(address user) view returns (uint256,uint256,uint8,uint256,uint256,bool)",
      "function getUserEasyEarnedWithMeta(address user) view returns (uint256,uint256,bool)",
      "function getUserEarnStateWithMeta(address user) view returns (uint256,uint256,uint256,uint256,bool)",
      "function getUserRecentActivitiesWithMeta(address user,uint256 fromBlock,uint256 toBlock,uint256 limit) view returns (tuple(uint8 kind,uint256 amount,uint256 blockNumber)[] memory,uint256,bool)",
      "function getDynamicRewardParamsWithMeta() view returns (uint256,uint256,uint256,bool)",
      "function getLevelMultiplierWithMeta(uint8 level) view returns (uint256,uint256,bool)",
      "function getEasyEmissionParamsWithMeta() view returns (uint256,uint256,uint256,uint256,uint8,uint256,bool)",
      "function getSystemRewardStatsWithMeta() view returns (uint256,uint256,uint256,uint256,bool)",
      "function getTopEarnersWithMeta() view returns (address[] memory,uint256[] memory,uint256,bool)",
    ],
    ctx.rewardView.target as string,
  )) as any;

  const beforeViews = await observeExtendedViews(ctx, "reward-boundary-before");
  const beforeBorrower = await readUserReward(rewardView.connect(ctx.borrower), ctx.borrower.address);
  const beforeLender = await readUserReward(rewardView.connect(ctx.lender), ctx.lender.address);
  const dynamicBefore = (await rewardView.getDynamicRewardParamsWithMeta()) as [bigint, bigint, bigint, boolean];
  const levelBefore = (await rewardView.getLevelMultiplierWithMeta(1)) as [bigint, bigint, boolean];

  let systemBefore: [bigint, bigint, bigint, bigint, boolean] | null = null;
  let topEarnersBefore: [string[], bigint[], bigint, boolean] | null = null;
  try {
    systemBefore = (await rewardView.connect(ctx.relayer).getSystemRewardStatsWithMeta()) as [bigint, bigint, bigint, bigint, boolean];
    topEarnersBefore = (await rewardView.connect(ctx.relayer).getTopEarnersWithMeta()) as [string[], bigint[], bigint, boolean];
  } catch {
    console.log("  [Notice] RewardView ops reads unavailable for current relayer");
  }

  await depositCollateral(ctx, ctx.collateralAmount);
  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);
  const afterBorrowViews = await waitForLoanFlowUserPublishReady(ctx, "after-borrow");
  const afterBorrowBorrower = await readUserReward(rewardView.connect(ctx.borrower), ctx.borrower.address);
  const afterBorrowLender = await readUserReward(rewardView.connect(ctx.lender), ctx.lender.address);

  await repayOrder(ctx, finalized.orderId, ctx.totalDue);
  const afterRepayViews = await waitForLoanFlowUserPublishReady(ctx, "after-repay");
  const afterRepayBorrower = await readUserReward(rewardView.connect(ctx.borrower), ctx.borrower.address);
  const afterRepayLender = await readUserReward(rewardView.connect(ctx.lender), ctx.lender.address);
  const dynamicAfter = (await rewardView.getDynamicRewardParamsWithMeta()) as [bigint, bigint, bigint, boolean];
  const levelAfter = (await rewardView.getLevelMultiplierWithMeta(1)) as [bigint, bigint, boolean];

  const loanFlowReadyAfterBorrow = requireValidLoanFlowUser(afterBorrowViews, "after-borrow");
  const loanFlowReadyAfterRepay = requireValidLoanFlowUser(afterRepayViews, "after-repay");
  if (loanFlowReadyAfterBorrow) {
    const beforeBorrowCount = beforeViews.loanFlowUser?.isValid ? beforeViews.loanFlowUser.borrowCount : 0n;
    if (afterBorrowViews.loanFlowUser!.borrowCount <= beforeBorrowCount) {
      throw new Error("LoanFlowView borrowCount should increase after finalizeMatch");
    }
  }
  if (loanFlowReadyAfterBorrow && loanFlowReadyAfterRepay) {
    if (afterRepayViews.loanFlowUser!.repayCount <= afterBorrowViews.loanFlowUser!.repayCount) {
      throw new Error("LoanFlowView repayCount should increase after repay");
    }
  }

  for (const [label, before, afterBorrow, afterRepay] of [
    ["borrower", beforeBorrower, afterBorrowBorrower, afterRepayBorrower],
    ["lender", beforeLender, afterBorrowLender, afterRepayLender],
  ] as const) {
    if (afterBorrow.blockNumber < before.blockNumber) {
      throw new Error(`${label}: reward summary block should not go backwards after borrow`);
    }
    if (afterRepay.blockNumber < afterBorrow.blockNumber) {
      throw new Error(`${label}: reward summary block should not go backwards after repay`);
    }
    if (afterBorrow.lastActivity < before.lastActivity) {
      throw new Error(`${label}: reward lastActivity should not go backwards after borrow`);
    }
    if (afterRepay.lastActivity < afterBorrow.lastActivity) {
      throw new Error(`${label}: reward lastActivity should not go backwards after repay`);
    }
    if (afterRepay.onTimeRepayCount > afterRepay.eligibleLoanCount) {
      throw new Error(`${label}: onTimeRepayCount cannot exceed eligibleLoanCount`);
    }
    if (afterRepay.recentActivityCount < before.recentActivityCount) {
      console.log(`  [Notice] ${label} recent activities window rolled; count did not monotonically increase`);
    }
  }

  if (dynamicAfter[0] !== dynamicBefore[0] || dynamicAfter[1] !== dynamicBefore[1]) {
    throw new Error("RewardView dynamic reward params should remain stable across a normal borrow/repay flow");
  }
  if (levelAfter[0] !== levelBefore[0]) {
    throw new Error("RewardView level multiplier should remain stable across a normal borrow/repay flow");
  }
  const rewardRegistry = (await rewardView.getRegistry()) as string;
  if (rewardRegistry.toLowerCase() !== ctx.registryAddr.toLowerCase()) {
    throw new Error(`RewardView registry mismatch: expected ${ctx.registryAddr} got ${rewardRegistry}`);
  }

  if (systemBefore) {
    const systemAfter = (await rewardView.connect(ctx.relayer).getSystemRewardStatsWithMeta()) as [bigint, bigint, bigint, bigint, boolean];
    if (systemAfter[0] < systemBefore[0]) {
      throw new Error("RewardView totalBatchOps should not decrease");
    }
    if (systemAfter[1] < systemBefore[1]) {
      throw new Error("RewardView totalCachedRewards should not decrease");
    }
  }
  if (topEarnersBefore) {
    const topEarnersAfter = (await rewardView.connect(ctx.relayer).getTopEarnersWithMeta()) as [string[], bigint[], bigint, boolean];
    if (topEarnersAfter[0].length !== topEarnersAfter[1].length) {
      throw new Error("RewardView top earners addresses/amounts length mismatch");
    }
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
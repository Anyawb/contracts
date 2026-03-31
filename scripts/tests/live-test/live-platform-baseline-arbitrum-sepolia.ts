import { ethers } from "hardhat";

import {
  type FundsFlowLiveContext,
  depositCollateral,
  expectEqual,
  finalizeSingleMatch,
  getGuaranteeState,
  observeExtendedViews,
  repayOrder,
  reserveForLending,
} from "./_fundsFlowLive";
import { runWithNetworkRetry } from "./_networkRetry";
import {
  bootstrapRewardLiveTest,
  decodeEasyMintSkipped,
  decodeRewardViewPushes,
  findRewardViewPush,
  readRewardUser,
  requireRewardViewPush,
  tryReadSpendStats,
} from "./_rewardLive";
import { explainRevert, key } from "./_mockLiveUtils";
import { isRetryableNetworkError } from "./_networkRetry";

type FacadeSnapshot = {
  statsUser: {
    collateral: bigint;
    debt: bigint;
    isValid: boolean;
    blockNumber: bigint;
    version: bigint;
    seq: bigint;
  };
  userTotals: {
    totalCollateral: bigint;
    totalDebt: bigint;
    isValid: boolean;
    blockNumber: bigint;
    version: bigint;
    seq: bigint;
  };
  userHealth: {
    healthFactor: bigint;
    isValid: boolean;
    blockNumber: bigint;
  };
  dashboardOverview: {
    totalCollateral: bigint;
    totalDebt: bigint;
    healthFactor: bigint;
    healthFactorValid: boolean;
    isRisky: boolean;
  };
  cacheSummary: {
    totalCollateral: bigint;
    totalDebt: bigint;
    healthFactor: bigint;
    cacheValid: boolean;
  };
  rawPositions: {
    totalCollateral: bigint;
    totalDebt: bigint;
  };
};

type NormalFlowSummary = {
  orderId: bigint;
  rewardPushCount: number;
  easySpentDelta: bigint;
  easyEarnedDelta: bigint;
};

type LiquidationFlowSummary = {
  orderId: bigint;
  penaltyDelta: bigint;
  burnedDelta: bigint;
  debtBefore: bigint;
  debtAfter: bigint;
};

const ACCESS_CONTROL_ERROR_INTERFACE = new ethers.Interface([
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
]);

const ACCESS_CONTROL_VIEW_INTERFACE = [
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function grantRole(bytes32 role,address account)",
  "function paused() view returns (bool)",
] as const;

const EASY_BURNER_ROLE = ethers.id("BURNER_ROLE");
const EASY_MINTER_ROLE = ethers.id("MINTER_ROLE");
const DEFAULT_ADMIN_ROLE = `0x${"00".repeat(32)}`;

function topicHash(signature: string) {
  return ethers.id(signature);
}

function withGasBuffer(estimate: bigint, multiplierBps = 12_000n) {
  return (estimate * multiplierBps) / 10_000n + 50_000n;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendPopulatedTxWithNetworkRetry(params: {
  signer: any;
  tx: { to?: string | null; data?: string; value?: bigint };
  label: string;
  multipliersBps?: bigint[];
}) {
  const multipliers = params.multipliersBps ?? [15_000n, 20_000n, 25_000n];
  let lastError: unknown;

  for (let i = 0; i < multipliers.length; i += 1) {
    const multiplier = multipliers[i];
    try {
      const estimate = await ethers.provider.estimateGas({
        from: params.signer.address,
        to: params.tx.to,
        data: params.tx.data,
        value: params.tx.value ?? 0n,
      });
      const gasLimit = withGasBuffer(estimate, multiplier);
      if (i === 0) {
        console.log(`  [Diag.ConsumeGas] ${params.label} estimate=${estimate.toString()} limit=${gasLimit.toString()}`);
      } else {
        console.log(`  [Retry.Tx] ${params.label} attempt=${i + 1}/${multipliers.length} limit=${gasLimit.toString()}`);
      }
      const response = await params.signer.sendTransaction({
        to: params.tx.to,
        data: params.tx.data,
        gasLimit,
        value: params.tx.value ?? 0n,
      });
      return await response.wait();
    } catch (error: any) {
      lastError = error;
      if (i >= multipliers.length - 1 || !isRetryableNetworkError(error)) {
        break;
      }
      await sleep(800 * (i + 1));
    }
  }

  throw lastError;
}

function decodeAddressTriplet(payload: string) {
  return ethers.AbiCoder.defaultAbiCoder().decode(["address", "uint256", "uint256"], payload) as [string, bigint, bigint];
}

function envFlag(name: string) {
  const raw = process.env[name];
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

async function readEasyRoleDiagnostics(ctx: FundsFlowLiveContext, reward: any) {
  const easyTokenAccess = (await ethers.getContractAt(
    ACCESS_CONTROL_VIEW_INTERFACE,
    reward.easyTokenAddr,
  )) as any;

  const [paused, recycleIsBurner, emissionIsMinter, relayerIsAdmin, borrowerIsBurner, borrowerIsMinter] = await Promise.all([
    easyTokenAccess.paused(),
    easyTokenAccess.hasRole(EASY_BURNER_ROLE, reward.easyRecycleDistributorAddr),
    easyTokenAccess.hasRole(EASY_MINTER_ROLE, reward.easyEmissionControllerAddr),
    easyTokenAccess.hasRole(DEFAULT_ADMIN_ROLE, ctx.relayer.address),
    easyTokenAccess.hasRole(EASY_BURNER_ROLE, ctx.borrower.address),
    easyTokenAccess.hasRole(EASY_MINTER_ROLE, ctx.borrower.address),
  ]);

  return {
    paused: Boolean(paused),
    recycleIsBurner: Boolean(recycleIsBurner),
    emissionIsMinter: Boolean(emissionIsMinter),
    relayerIsAdmin: Boolean(relayerIsAdmin),
    borrowerIsBurner: Boolean(borrowerIsBurner),
    borrowerIsMinter: Boolean(borrowerIsMinter),
  };
}

async function maybeRepairEasyRoles(ctx: FundsFlowLiveContext, reward: any) {
  if (!envFlag("ALLOW_EASY_ROLE_REPAIR")) {
    return;
  }

  const easyTokenAccess = (await ethers.getContractAt(
    ACCESS_CONTROL_VIEW_INTERFACE,
    reward.easyTokenAddr,
  )) as any;

  const relayerIsAdmin = (await easyTokenAccess.hasRole(DEFAULT_ADMIN_ROLE, ctx.relayer.address)) as boolean;
  if (!relayerIsAdmin) {
    console.log("  [Diag.EasyRoleRepair] skipped: relayer is not EasyToken DEFAULT_ADMIN_ROLE");
    return;
  }

  const recycleIsBurner = (await easyTokenAccess.hasRole(EASY_BURNER_ROLE, reward.easyRecycleDistributorAddr)) as boolean;
  if (!recycleIsBurner) {
    console.log(`  [Diag.EasyRoleRepair] granting BURNER_ROLE to recycle distributor ${reward.easyRecycleDistributorAddr}`);
    await (await easyTokenAccess.connect(ctx.relayer).grantRole(EASY_BURNER_ROLE, reward.easyRecycleDistributorAddr)).wait();
  }

  const emissionIsMinter = (await easyTokenAccess.hasRole(EASY_MINTER_ROLE, reward.easyEmissionControllerAddr)) as boolean;
  if (!emissionIsMinter) {
    console.log(`  [Diag.EasyRoleRepair] granting MINTER_ROLE to emission controller ${reward.easyEmissionControllerAddr}`);
    await (await easyTokenAccess.connect(ctx.relayer).grantRole(EASY_MINTER_ROLE, reward.easyEmissionControllerAddr)).wait();
  }
}

function formatReceiptLog(log: any) {
  return `address=${String(log.address ?? "")} topic0=${String(log.topics?.[0] ?? "")} topics=${JSON.stringify(log.topics ?? [])} data=${String(log.data ?? "")}`;
}

function summarizeRewardRelevantLogs(ctx: FundsFlowLiveContext, reward: any, receipt: any) {
  const relevantAddresses = new Set([
    String(ctx.gfm?.target ?? ctx.guaranteeFundAddr ?? "").toLowerCase(),
    String(reward.rewardManagerAddr ?? "").toLowerCase(),
    String(reward.rewardAccrualManagerAddr ?? "").toLowerCase(),
    String(ctx.rewardView.target ?? "").toLowerCase(),
  ]);

  const lines = (receipt.logs ?? [])
    .filter((log: any) => relevantAddresses.has(String(log.address ?? "").toLowerCase()))
    .map((log: any) => formatReceiptLog(log));

  return lines.length > 0 ? lines.join("\n") : "<no reward-relevant logs found on receipt>";
}

async function readFacadeSnapshot(ctx: FundsFlowLiveContext): Promise<FacadeSnapshot | null> {
  if (!ctx.statisticsView || !ctx.userView || !ctx.dashboardView || !ctx.cacheOptimizedView) {
    return null;
  }

  const trackedAssets = [ctx.collateralAssetAddr, ctx.borrowAssetAddr];
  const [statsSnapshot, userTotals, userHealth, dashboardOverview, cacheSummary, collateralPos, borrowPos] = await Promise.all([
    ctx.statisticsView.connect(ctx.borrower).getUserSnapshotWithMeta(ctx.borrower.address),
    ctx.userView.connect(ctx.borrower).getUserTotalsWithMeta(ctx.borrower.address),
    ctx.userView.connect(ctx.borrower).getHealthFactorWithMeta(ctx.borrower.address),
    ctx.dashboardView.connect(ctx.borrower).getUserOverviewWithMeta(ctx.borrower.address, trackedAssets),
    ctx.cacheOptimizedView.connect(ctx.borrower).getUserSummaryWithMeta(ctx.borrower.address, trackedAssets),
    ctx.positionView.connect(ctx.borrower).getUserPositionWithBlockMeta(ctx.borrower.address, ctx.collateralAssetAddr),
    ctx.positionView.connect(ctx.borrower).getUserPositionWithBlockMeta(ctx.borrower.address, ctx.borrowAssetAddr),
  ]);

  const [stats, version, seq, , statsValid, statsBlock] = statsSnapshot as [any, bigint, bigint, string, boolean, bigint];
  const [totalCollateral, totalDebt, totalsValid, totalsBlock, totalsVersion, totalsSeq] = userTotals as [bigint, bigint, boolean, bigint, bigint, bigint];
  const [healthFactor, healthValid, healthBlock] = userHealth as [bigint, boolean, bigint];
  const [overview] = dashboardOverview as [any, boolean[], bigint[], bigint[], bigint];
  const [summary] = cacheSummary as [any, boolean[], bigint[], bigint[], bigint];
  const [collateralCollateral, collateralDebt] = collateralPos as [bigint, bigint, boolean, bigint, bigint, bigint];
  const [borrowCollateral, borrowDebt] = borrowPos as [bigint, bigint, boolean, bigint, bigint, bigint];

  return {
    statsUser: {
      collateral: BigInt(stats.collateral ?? stats[0] ?? 0),
      debt: BigInt(stats.debt ?? stats[1] ?? 0),
      isValid: statsValid,
      blockNumber: statsBlock,
      version,
      seq,
    },
    userTotals: {
      totalCollateral,
      totalDebt,
      isValid: totalsValid,
      blockNumber: totalsBlock,
      version: totalsVersion,
      seq: totalsSeq,
    },
    userHealth: {
      healthFactor,
      isValid: healthValid,
      blockNumber: healthBlock,
    },
    dashboardOverview: {
      totalCollateral: BigInt(overview.totalCollateral ?? overview[0] ?? 0),
      totalDebt: BigInt(overview.totalDebt ?? overview[1] ?? 0),
      healthFactor: BigInt(overview.healthFactor ?? overview[2] ?? 0),
      healthFactorValid: Boolean(overview.healthFactorValid ?? overview[3] ?? false),
      isRisky: Boolean(overview.isRisky ?? overview[4] ?? false),
    },
    cacheSummary: {
      totalCollateral: BigInt(summary.totalCollateral ?? summary[0] ?? 0),
      totalDebt: BigInt(summary.totalDebt ?? summary[1] ?? 0),
      healthFactor: BigInt(summary.healthFactor ?? summary[2] ?? 0),
      cacheValid: Boolean(summary.cacheValid ?? summary[3] ?? false),
    },
    rawPositions: {
      totalCollateral: collateralCollateral + borrowCollateral,
      totalDebt: collateralDebt + borrowDebt,
    },
  } satisfies FacadeSnapshot;
}

function assertFacadeConsistency(snapshot: FacadeSnapshot, label: string) {
  expectEqual(snapshot.userTotals.totalCollateral, snapshot.statsUser.collateral, `${label}: UserView collateral vs StatisticsView`);
  expectEqual(snapshot.userTotals.totalDebt, snapshot.statsUser.debt, `${label}: UserView debt vs StatisticsView`);
  expectEqual(snapshot.userTotals.version, snapshot.statsUser.version, `${label}: UserView version vs StatisticsView`);
  expectEqual(snapshot.userTotals.seq, snapshot.statsUser.seq, `${label}: UserView seq vs StatisticsView`);
  expectEqual(snapshot.dashboardOverview.totalCollateral, snapshot.cacheSummary.totalCollateral, `${label}: DashboardView collateral vs CacheOptimizedView`);
  expectEqual(snapshot.dashboardOverview.totalDebt, snapshot.cacheSummary.totalDebt, `${label}: DashboardView debt vs CacheOptimizedView`);
  expectEqual(snapshot.dashboardOverview.totalCollateral, snapshot.rawPositions.totalCollateral, `${label}: DashboardView collateral vs PositionView sum`);
  expectEqual(snapshot.dashboardOverview.totalDebt, snapshot.rawPositions.totalDebt, `${label}: DashboardView debt vs PositionView sum`);
  expectEqual(snapshot.dashboardOverview.healthFactor, snapshot.cacheSummary.healthFactor, `${label}: DashboardView health vs CacheOptimizedView`);
  expectEqual(snapshot.dashboardOverview.healthFactor, snapshot.userHealth.healthFactor, `${label}: DashboardView health vs UserView health`);

  if (!snapshot.userTotals.isValid) {
    throw new Error(`${label}: UserView totals should be valid`);
  }
  if (!snapshot.userHealth.isValid) {
    throw new Error(`${label}: UserView health should be valid`);
  }
  if (!snapshot.dashboardOverview.healthFactorValid) {
    throw new Error(`${label}: DashboardView health factor should be valid`);
  }
  if (!snapshot.cacheSummary.cacheValid) {
    throw new Error(`${label}: CacheOptimizedView summary should be valid`);
  }
}

async function runNormalRepayBranch(): Promise<NormalFlowSummary> {
  const { ctx, reward } = await bootstrapRewardLiveTest({
    label: "Live Platform Baseline Normal Branch",
    noticeLabel: "using fresh platform-baseline normal borrower",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });
  const hasAdmin = (await ctx.acm.hasRole(key("ACTION_ADMIN"), ctx.relayer.address)) as boolean;

  const beforeBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const beforeLender = await readRewardUser(reward, ctx.lender, ctx.lender.address);
  const beforeSpendStats = await tryReadSpendStats(reward, ctx.relayer);

  await observeExtendedViews(ctx, "platform-baseline-normal-before");
  await depositCollateral(ctx, ctx.collateralAmount);
  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);
  const repayReceipt = await repayOrder(ctx, finalized.orderId, ctx.totalDue);

  const repayPushes = decodeRewardViewPushes(reward, repayReceipt);
  const repaySkipped = decodeEasyMintSkipped(reward, repayReceipt);
  const mintedPush = findRewardViewPush(repayPushes, "EASY_MINTED");
  if (!mintedPush) {
    const reason = repaySkipped.length > 0 ? String(repaySkipped[0]?.args?.reason ?? "unknown") : "missing-push";
    throw new Error(
      `repay tx did not emit RewardView DataPushed(EASY_MINTED); reason=${reason} borrowerPenaltyDebt=${beforeBorrower.penaltyDebt} lenderPenaltyDebt=${beforeLender.penaltyDebt}`,
    );
  }

  const afterRepayBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const afterRepayLender = await readRewardUser(reward, ctx.lender, ctx.lender.address);
  if (afterRepayBorrower.easyEarned < beforeBorrower.easyEarned) {
    throw new Error("borrower RewardView easyEarned regressed after repay mint");
  }
  if (afterRepayLender.easyEarned < beforeLender.easyEarned) {
    throw new Error("lender RewardView easyEarned regressed after repay mint");
  }

  const allowance = (await reward.easyToken.allowance(ctx.borrower.address, reward.easyConsumptionAddr)) as bigint;
  const totalSpend = 2n * 10n ** 18n;
  const recoveryAmount = 1n * 10n ** 18n;
  if (allowance < totalSpend) {
    await (await reward.easyToken.connect(ctx.borrower).approve(reward.easyConsumptionAddr, ethers.MaxUint256)).wait();
  }
  if (afterRepayBorrower.easyBalance < totalSpend + recoveryAmount) {
    throw new Error(`borrower Easy balance is too low to chain spend+recovery assertions: ${afterRepayBorrower.easyBalance}`);
  }

  await maybeRepairEasyRoles(ctx, reward);
  const easyRoleDiag = await readEasyRoleDiagnostics(ctx, reward);
  console.log(
    `  [Diag.EasyRoles] paused=${easyRoleDiag.paused} recycleIsBurner=${easyRoleDiag.recycleIsBurner} emissionIsMinter=${easyRoleDiag.emissionIsMinter} relayerIsAdmin=${easyRoleDiag.relayerIsAdmin}`,
  );

  try {
    await reward.easyConsumption.connect(ctx.borrower).consumeEasiMCall.staticCall(ctx.borrower.address);
  } catch (error: any) {
    throw new Error(
      `consumeEasiMCall.staticCall failed: ${explainRevert(error, [reward.easyConsumption.interface, reward.easyRecycleDistributor.interface, reward.easyToken.interface, ACCESS_CONTROL_ERROR_INTERFACE])} borrower=${ctx.borrower.address} recycle=${reward.easyRecycleDistributorAddr} easyToken=${reward.easyTokenAddr}`,
    );
  }

  try {
    await reward.easyConsumption.connect(ctx.borrower).consumeStrategyApiCall.staticCall(ctx.borrower.address);
  } catch (error: any) {
    throw new Error(
      `consumeStrategyApiCall.staticCall failed: ${explainRevert(error, [reward.easyConsumption.interface, reward.easyRecycleDistributor.interface, reward.easyToken.interface, ACCESS_CONTROL_ERROR_INTERFACE])} borrower=${ctx.borrower.address} recycle=${reward.easyRecycleDistributorAddr} easyToken=${reward.easyTokenAddr}`,
    );
  }

  const consumeEasiMPopulated = await reward.easyConsumption
    .connect(ctx.borrower)
    .consumeEasiMCall.populateTransaction(ctx.borrower.address);

  let consumeEasiMReceipt;
  try {
    consumeEasiMReceipt = await sendPopulatedTxWithNetworkRetry({
      signer: ctx.borrower,
      tx: {
        to: consumeEasiMPopulated.to,
        data: consumeEasiMPopulated.data,
        value: consumeEasiMPopulated.value ?? 0n,
      },
      label: "easim",
    });
  } catch (error: any) {
    throw new Error(
      `consumeEasiMCall tx failed: ${explainRevert(error, [reward.easyConsumption.interface, reward.easyRecycleDistributor.interface, reward.easyToken.interface, ACCESS_CONTROL_ERROR_INTERFACE])} code=${String(error?.code ?? "n/a")} message=${String(error?.message ?? "")} receiptStatus=${String(error?.receipt?.status ?? "n/a")} gasUsed=${String(error?.receipt?.gasUsed ?? "n/a")}`,
    );
  }

  const consumeStrategyPopulated = await reward.easyConsumption
    .connect(ctx.borrower)
    .consumeStrategyApiCall.populateTransaction(ctx.borrower.address);

  let consumeStrategyReceipt;
  try {
    consumeStrategyReceipt = await sendPopulatedTxWithNetworkRetry({
      signer: ctx.borrower,
      tx: {
        to: consumeStrategyPopulated.to,
        data: consumeStrategyPopulated.data,
        value: consumeStrategyPopulated.value ?? 0n,
      },
      label: "strategy",
    });
  } catch (error: any) {
    throw new Error(
      `consumeStrategyApiCall tx failed: ${explainRevert(error, [reward.easyConsumption.interface, reward.easyRecycleDistributor.interface, reward.easyToken.interface, ACCESS_CONTROL_ERROR_INTERFACE])} code=${String(error?.code ?? "n/a")} message=${String(error?.message ?? "")} receiptStatus=${String(error?.receipt?.status ?? "n/a")} gasUsed=${String(error?.receipt?.gasUsed ?? "n/a")}`,
    );
  }
  const recoveryTransferReceipt = await (await reward.easyToken.connect(ctx.borrower).transfer(reward.easyRecycleDistributorAddr, recoveryAmount)).wait();
  recoveryTransferReceipt;

  const recycleBalanceBeforeRecovery = (await reward.easyToken.balanceOf(reward.easyRecycleDistributorAddr)) as bigint;
  let recoveryReceipt: any = null;
  let recoveryPushes: any[] = [];

  try {
    await reward.easyRecycleDistributor.connect(ctx.relayer).settleOutstandingEasyBalance.staticCall();

    const recoveryPopulated = await reward.easyRecycleDistributor.connect(ctx.relayer).settleOutstandingEasyBalance.populateTransaction();
    console.log(`  [Diag.Recovery] recycleBalance=${recycleBalanceBeforeRecovery.toString()}`);

    recoveryReceipt = await sendPopulatedTxWithNetworkRetry({
      signer: ctx.relayer,
      tx: {
        to: recoveryPopulated.to,
        data: recoveryPopulated.data,
        value: recoveryPopulated.value ?? 0n,
      },
      label: "recovery",
    });
    recoveryPushes = decodeRewardViewPushes(reward, recoveryReceipt);
  } catch (error: any) {
    const revertText = explainRevert(error, [reward.easyRecycleDistributor.interface, reward.easyToken.interface, ACCESS_CONTROL_ERROR_INTERFACE]);
    const recycleBalanceAfterFailedRecovery = (await reward.easyToken.balanceOf(reward.easyRecycleDistributorAddr)) as bigint;

    if (/InvalidCaller/i.test(revertText) && recycleBalanceAfterFailedRecovery === 0n) {
      console.log(
        `  [Notice] settleOutstandingEasyBalance skipped: recycle has no outstanding Easy balance (before=${recycleBalanceBeforeRecovery.toString()} after=${recycleBalanceAfterFailedRecovery.toString()})`,
      );
    } else {
      throw new Error(
        `settleOutstandingEasyBalance tx failed: ${revertText} recycleBalanceBefore=${recycleBalanceBeforeRecovery.toString()} recycleBalanceAfter=${recycleBalanceAfterFailedRecovery.toString()} receiptStatus=${String(error?.receipt?.status ?? "n/a")} gasUsed=${String(error?.receipt?.gasUsed ?? "n/a")}`,
      );
    }
  }

  const consumeEasiMPushes = decodeRewardViewPushes(reward, consumeEasiMReceipt);
  const consumeStrategyPushes = decodeRewardViewPushes(reward, consumeStrategyReceipt);
  requireRewardViewPush(consumeEasiMPushes, "EASY_SPENT", "consumeEasiMCall tx did not emit RewardView DataPushed(EASY_SPENT)");
  requireRewardViewPush(consumeEasiMPushes, "EASY_RECYCLED_SPLIT", "consumeEasiMCall tx did not emit RewardView DataPushed(EASY_RECYCLED_SPLIT)");
  requireRewardViewPush(consumeStrategyPushes, "EASY_SPENT", "consumeStrategyApiCall tx did not emit RewardView DataPushed(EASY_SPENT)");
  requireRewardViewPush(consumeStrategyPushes, "EASY_RECYCLED_SPLIT", "consumeStrategyApiCall tx did not emit RewardView DataPushed(EASY_RECYCLED_SPLIT)");
  if (recoveryReceipt) {
    requireRewardViewPush(recoveryPushes, "EASY_RECYCLED_SPLIT", "settleOutstandingEasyBalance tx did not emit RewardView DataPushed(EASY_RECYCLED_SPLIT)");
  }

  const afterConsumeBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  if (afterConsumeBorrower.easySpent - afterRepayBorrower.easySpent !== totalSpend) {
    throw new Error("RewardView easySpent delta mismatch after consume sequence");
  }

  if (beforeBorrower.penaltyDebt > 0n) {
    const penaltyPush = requireRewardViewPush(
      repayPushes,
      "REWARD_PENALTY_LEDGER_UPDATED",
      "borrower had existing penalty debt, but repay tx did not emit RewardView DataPushed(REWARD_PENALTY_LEDGER_UPDATED)",
    );
    const [pushedUser, pushedDebt] = decodeAddressTriplet(penaltyPush.payload);
    if (pushedUser.toLowerCase() !== ctx.borrower.address.toLowerCase()) {
      throw new Error("penalty ledger push user mismatch on repay path");
    }
    if (pushedDebt !== afterConsumeBorrower.penaltyDebt) {
      throw new Error(`penalty ledger push debt mismatch: pushed=${pushedDebt} current=${afterConsumeBorrower.penaltyDebt}`);
    }
  } else if (hasAdmin && afterConsumeBorrower.penaltyDebt > 0n) {
    const retryReceipt = await (
      await reward.rewardView.connect(ctx.relayer).retryPushPenaltyLedger(
        ctx.borrower.address,
        afterConsumeBorrower.penaltyDebt,
        BigInt(await ethers.provider.getBlockNumber()),
      )
    ).wait();
    const penaltyPush = requireRewardViewPush(
      decodeRewardViewPushes(reward, retryReceipt),
      "REWARD_PENALTY_LEDGER_UPDATED",
      "RewardView.retryPushPenaltyLedger did not emit DataPushed(REWARD_PENALTY_LEDGER_UPDATED)",
    );
    const [pushedUser, pushedDebt] = decodeAddressTriplet(penaltyPush.payload);
    if (pushedUser.toLowerCase() !== ctx.borrower.address.toLowerCase()) {
      throw new Error("retry penalty ledger push user mismatch");
    }
    if (pushedDebt !== afterConsumeBorrower.penaltyDebt) {
      throw new Error(`retry penalty ledger push debt mismatch: pushed=${pushedDebt} current=${afterConsumeBorrower.penaltyDebt}`);
    }
  } else {
    console.log(
      "  [Notice] skip retryPushPenaltyLedger: borrower has no outstanding penalty debt (or relayer lacks ACTION_ADMIN); state mirror assertion only",
    );
  }

  const finalBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const finalSpendStats = await tryReadSpendStats(reward, ctx.relayer);
  if (finalBorrower.pendingPenalty !== finalBorrower.penaltyDebt) {
    throw new Error("final RewardView pendingPenalty should mirror RewardAccrualManager penalty debt");
  }
  if (beforeSpendStats && finalSpendStats && finalSpendStats.totalSpent - beforeSpendStats.totalSpent !== totalSpend) {
    throw new Error("RewardView totalSpent delta mismatch in chained assertion script");
  }

  const repayViews = await observeExtendedViews(ctx, "platform-baseline-normal-after-repay");
  if (repayViews.base.debtPositionDebt !== 0n) {
    throw new Error(`PositionView debt should be zero after repay: ${repayViews.base.debtPositionDebt}`);
  }

  const facadeSnapshot = await readFacadeSnapshot(ctx);
  if (facadeSnapshot) {
    assertFacadeConsistency(facadeSnapshot, "platform-baseline-normal-after-repay");
    expectEqual(facadeSnapshot.dashboardOverview.totalDebt, 0n, "platform-baseline-normal-after-repay dashboard debt");
    expectEqual(facadeSnapshot.userTotals.totalDebt, 0n, "platform-baseline-normal-after-repay user totals debt");
  }

  console.log(
    `  [PlatformBaseline.Normal] orderId=${finalized.orderId.toString()} repayPushes=${repayPushes.length} easyEarned=${beforeBorrower.easyEarned.toString()}->${finalBorrower.easyEarned.toString()} easySpent=${afterRepayBorrower.easySpent.toString()}->${finalBorrower.easySpent.toString()}`,
  );

  return {
    orderId: finalized.orderId,
    rewardPushCount: repayPushes.length,
    easySpentDelta: finalBorrower.easySpent - beforeBorrower.easySpent,
    easyEarnedDelta: finalBorrower.easyEarned - beforeBorrower.easyEarned,
  } satisfies NormalFlowSummary;
}

async function runGuaranteeDefaultBranch(): Promise<LiquidationFlowSummary> {
  const { ctx, reward } = await bootstrapRewardLiveTest({
    label: "Live Platform Baseline Liquidation Branch",
    noticeLabel: "using fresh platform-baseline liquidation borrower",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "500",
  });

  if (!ctx.gfm || !ctx.ergm) {
    throw new Error("guarantee modules are not registered in current environment");
  }

  const hasActionLiquidate = (await ctx.acm.hasRole(key("LIQUIDATE"), ctx.relayer.address)) as boolean;
  const hasActionViewPush = (await ctx.acm.hasRole(key("ACTION_VIEW_PUSH"), ctx.relayer.address)) as boolean;
  if (!hasActionLiquidate) {
    throw new Error(`relayer ${ctx.relayer.address} lacks LIQUIDATE role required by SettlementManager`);
  }
  if (!hasActionViewPush) {
    throw new Error(`relayer ${ctx.relayer.address} lacks ACTION_VIEW_PUSH role required to force liquidation health status`);
  }

  const ergmAdmin = (await ethers.getContractAt(
    [
      "function setGuaranteeEnabled(address asset,bool enabled)",
      "function isGuaranteeEnabled(address asset) view returns (bool)",
    ],
    ctx.ergmAddr,
    ctx.relayer,
  )) as any;

  if ((ctx.totalDue + ctx.interest) > ctx.totalDue) {
    const borrowGap = (ctx.totalDue + ctx.interest) - ctx.totalDue;
    if (borrowGap > 0n) {
      await (await ctx.borrowToken.connect(ctx.relayer).transfer(ctx.borrower.address, borrowGap)).wait();
    }
  }

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const liquidationViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
  const lendingEngine = (await ethers.getContractAt(
    [
      "function getDebt(address user,address asset) view returns (uint256)",
      "function getReducibleDebtAmount(address user,address asset) view returns (uint256)",
    ],
    lendingEngineAddr,
  )) as any;
  const settlementManager = (await ethers.getContractAt(
    ["function settleOrLiquidate(uint256 orderId)"],
    ctx.settlementManagerAddr,
    ctx.relayer,
  )) as any;
  const healthViewWriter = (await ethers.getContractAt(
    [
      "function pushRiskStatus(address user,uint256 healthFactorBps,uint256 minHFBps,bool undercollateralized,uint256 blockNumber)",
    ],
    String(ctx.healthView.target),
    ctx.relayer,
  )) as any;
  const liquidatorView = (await ethers.getContractAt(
    ["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"],
    liquidationViewAddr,
    ctx.viewer,
  )) as any;

  const beforeReward = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const beforeGuarantee = await getGuaranteeState(ctx);
  const beforeQuote = (await reward.rewardManager.quoteLiquidationPenalty(ctx.borrower.address)) as bigint;
  const wasEnabled = (await ergmAdmin.isGuaranteeEnabled(ctx.borrowAssetAddr)) as boolean;

  if (!wasEnabled) {
    await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, true)).wait();
  }

  try {
    if (ctx.interest > 0n) {
      await (await ctx.borrowToken.connect(ctx.borrower).approve(ctx.guaranteeFundAddr, ctx.interest)).wait();
    }
    await observeExtendedViews(ctx, "platform-baseline-liquidation-before");
    await depositCollateral(ctx, ctx.collateralAmount);
    const reserve = await reserveForLending(ctx);
    const finalized = await finalizeSingleMatch(ctx, reserve);
    const afterBorrowGuarantee = await getGuaranteeState(ctx);
    const quoteAfterBorrow = (await reward.rewardManager.quoteLiquidationPenalty(ctx.borrower.address)) as bigint;

    if (!afterBorrowGuarantee.active || afterBorrowGuarantee.locked === 0n) {
      throw new Error("expected active guarantee with locked amount after guarantee-enabled finalizeMatch");
    }
    if (quoteAfterBorrow <= beforeQuote) {
      throw new Error(`expected liquidation penalty quote to increase after borrow lock: before=${beforeQuote} after=${quoteAfterBorrow}`);
    }

    const debtBefore = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
    const reducibleBefore = (await lendingEngine.getReducibleDebtAmount(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
    if (debtBefore === 0n || reducibleBefore === 0n) {
      throw new Error("active debt is required before triggering guarantee-default liquidation");
    }

    try {
      await healthViewWriter.connect(ctx.relayer).pushRiskStatus.staticCall(ctx.borrower.address, 0n, 10000n, true, 0n);
    } catch (error: any) {
      throw new Error(`pushRiskStatus staticCall reverted: ${explainRevert(error, [healthViewWriter.interface])}`);
    }

    const pushRiskStatusGas = withGasBuffer(
      await healthViewWriter.connect(ctx.relayer).pushRiskStatus.estimateGas(ctx.borrower.address, 0n, 10000n, true, 0n),
    );
    await (
      await healthViewWriter.connect(ctx.relayer).pushRiskStatus(ctx.borrower.address, 0n, 10000n, true, 0n, {
        gasLimit: pushRiskStatusGas,
      })
    ).wait();

    try {
      await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(finalized.orderId);
    } catch (error: any) {
      throw new Error(
        `settleOrLiquidate.staticCall reverted on guarantee-default path: ${explainRevert(error, [
          settlementManager.interface,
          ctx.gfm.interface,
          ctx.ergm.interface,
          reward.rewardManager.interface,
          reward.rewardAccrualManager.interface,
          healthViewWriter.interface,
          ACCESS_CONTROL_ERROR_INTERFACE,
        ])}`,
      );
    }

    const settleOrLiquidateEstimate = await settlementManager.connect(ctx.relayer).settleOrLiquidate.estimateGas(finalized.orderId);
    const settleOrLiquidateGas = withGasBuffer(settleOrLiquidateEstimate, 13_000n);
    console.log(
      `  [Diag.GuaranteeDefaultGas] settleOrLiquidate estimate=${settleOrLiquidateEstimate} limit=${settleOrLiquidateGas}`,
    );

    const liquidationReceipt = await (
      await settlementManager.connect(ctx.relayer).settleOrLiquidate(finalized.orderId, {
        gasLimit: settleOrLiquidateGas,
      })
    ).wait();
    const afterReward = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
    const afterGuarantee = await getGuaranteeState(ctx);
    const quoteAfterLiquidation = (await reward.rewardManager.quoteLiquidationPenalty(ctx.borrower.address)) as bigint;
    const debtAfter = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;

    if (afterGuarantee.active) {
      throw new Error("guarantee should be inactive after SettlementManager default path");
    }
    if (afterGuarantee.locked !== 0n) {
      throw new Error(`guarantee locked amount should be zero after default: ${afterGuarantee.locked}`);
    }
    if (quoteAfterLiquidation > quoteAfterBorrow) {
      throw new Error("liquidation/default should not increase liquidation penalty quote after guarantee path is processed");
    }
    if (debtAfter > debtBefore) {
      throw new Error(`debt increased after liquidation/default: before=${debtBefore} after=${debtAfter}`);
    }

    const rewardPushes = decodeRewardViewPushes(reward, liquidationReceipt);
    const penaltyPush = findRewardViewPush(rewardPushes, "REWARD_PENALTY_LEDGER_UPDATED");
    const burnedPush = findRewardViewPush(rewardPushes, "REWARD_BURNED");
    const rewardPenaltyAppliedTopic = topicHash("RewardLiquidationPenaltyApplied(address,address,uint256,uint256)").toLowerCase();
    const rewardPenaltyFailedTopic = topicHash("RewardLiquidationPenaltyApplyFailed(address,address,bytes,uint256)").toLowerCase();
    const gfmPenaltyAppliedLog = (liquidationReceipt.logs ?? []).find((log: any) => String(log.topics?.[0] ?? "").toLowerCase() === rewardPenaltyAppliedTopic) as any;
    const gfmPenaltyFailedLog = (liquidationReceipt.logs ?? []).find((log: any) => String(log.topics?.[0] ?? "").toLowerCase() === rewardPenaltyFailedTopic) as any;
    if (gfmPenaltyFailedLog) {
      throw new Error("GuaranteeFundManager emitted RewardLiquidationPenaltyApplyFailed during default penalty path");
    }
    if (!gfmPenaltyAppliedLog) {
      throw new Error("missing GuaranteeFundManager RewardLiquidationPenaltyApplied event on default penalty path");
    }

    const rewardAccrualPenaltyTopic = reward.rewardAccrualManager.interface.getEvent("PenaltyApplied").topicHash.toLowerCase();
    const rewardAccrualPenaltyLog = (liquidationReceipt.logs ?? []).find(
      (log: any) =>
        String(log.address ?? "").toLowerCase() === reward.rewardAccrualManagerAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === rewardAccrualPenaltyTopic,
    ) as any;
    if (!rewardAccrualPenaltyLog) {
      throw new Error(
        `missing RewardAccrualManager PenaltyApplied event on guarantee-default path\n${summarizeRewardRelevantLogs(ctx, reward, liquidationReceipt)}`,
      );
    }

    const positivePenaltyState = afterReward.pendingPenalty > beforeReward.pendingPenalty
      || afterReward.totalBurned > beforeReward.totalBurned;
    if (!positivePenaltyState) {
      throw new Error(
        `guarantee-default penalty path did not change RewardView penalty/burn state: pending ${beforeReward.pendingPenalty} -> ${afterReward.pendingPenalty}, burned ${beforeReward.totalBurned} -> ${afterReward.totalBurned}`,
      );
    }
    if (!penaltyPush && !burnedPush) {
      throw new Error("guarantee-default penalty path emitted neither RewardView REWARD_PENALTY_LEDGER_UPDATED nor REWARD_BURNED push");
    }

    const liquidationUpdateTopic = liquidatorView.interface.getEvent("DataPushed").topicHash.toLowerCase();
    const liquidatorLogs = (liquidationReceipt.logs ?? []).filter(
      (log: any) =>
        String(log.address ?? "").toLowerCase() === liquidationViewAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === liquidationUpdateTopic,
    );
    if (liquidatorLogs.length === 0) {
      throw new Error("expected LiquidatorView DataPushed log on guarantee-default liquidation receipt");
    }

    await observeExtendedViews(ctx, "platform-baseline-liquidation-after");
    console.log(
      `  [PlatformBaseline.Liquidation] orderId=${finalized.orderId.toString()} guaranteeBefore=${beforeGuarantee.locked.toString()} guaranteeAfterBorrow=${afterBorrowGuarantee.locked.toString()} guaranteeAfter=${afterGuarantee.locked.toString()} pendingPenalty=${beforeReward.pendingPenalty.toString()}->${afterReward.pendingPenalty.toString()} totalBurned=${beforeReward.totalBurned.toString()}->${afterReward.totalBurned.toString()} debt=${debtBefore.toString()}->${debtAfter.toString()}`,
    );

    return {
      orderId: finalized.orderId,
      penaltyDelta: afterReward.pendingPenalty - beforeReward.pendingPenalty,
      burnedDelta: afterReward.totalBurned - beforeReward.totalBurned,
      debtBefore,
      debtAfter,
    } satisfies LiquidationFlowSummary;
  } finally {
    if (!wasEnabled) {
      await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, false)).wait();
    }
  }
}

async function main() {
  const normal = await runNormalRepayBranch();
  const liquidation = await runGuaranteeDefaultBranch();

  console.log(
    `  [PlatformBaseline.Summary] normalOrder=${normal.orderId.toString()} liquidationOrder=${liquidation.orderId.toString()} easyEarnedDelta=${normal.easyEarnedDelta.toString()} easySpentDelta=${normal.easySpentDelta.toString()} penaltyDelta=${liquidation.penaltyDelta.toString()} burnedDelta=${liquidation.burnedDelta.toString()} debt=${liquidation.debtBefore.toString()}->${liquidation.debtAfter.toString()}`,
  );
  console.log("\n✅ live-platform-baseline-arbitrum-sepolia PASSED\n");
}

void runWithNetworkRetry("live-platform-baseline-arbitrum-sepolia", main);
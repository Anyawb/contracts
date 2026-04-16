import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  expectEqual,
  finalizeSingleMatch,
  fundFundsFlowActors,
  observeExtendedViews,
  repayOrder,
  reserveForLending,
} from "../core/_fundsFlowLive";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

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

async function readFacadeSnapshot(ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>): Promise<FacadeSnapshot> {
  if (!ctx.statisticsView || !ctx.userView || !ctx.dashboardView || !ctx.cacheOptimizedView) {
    throw new Error("facade consistency script requires StatisticsView/UserView/DashboardView/CacheOptimizedView");
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
  };
}

function assertFacadeConsistency(snapshot: FacadeSnapshot, label: string, options?: { requireValidCaches?: boolean }) {
  const requireValidCaches = options?.requireValidCaches ?? true;
  expectEqual(snapshot.userTotals.totalCollateral, snapshot.statsUser.collateral, `${label}: UserView collateral vs StatisticsView`);
  expectEqual(snapshot.userTotals.totalDebt, snapshot.statsUser.debt, `${label}: UserView debt vs StatisticsView`);
  expectEqual(snapshot.userTotals.version, snapshot.statsUser.version, `${label}: UserView version vs StatisticsView`);
  expectEqual(snapshot.userTotals.seq, snapshot.statsUser.seq, `${label}: UserView seq vs StatisticsView`);

  expectEqual(snapshot.dashboardOverview.totalCollateral, snapshot.cacheSummary.totalCollateral, `${label}: DashboardView collateral vs CacheOptimizedView`);
  expectEqual(snapshot.dashboardOverview.totalDebt, snapshot.cacheSummary.totalDebt, `${label}: DashboardView debt vs CacheOptimizedView`);
  expectEqual(snapshot.dashboardOverview.totalCollateral, snapshot.rawPositions.totalCollateral, `${label}: DashboardView collateral vs PositionView sum`);
  expectEqual(snapshot.dashboardOverview.totalDebt, snapshot.rawPositions.totalDebt, `${label}: DashboardView debt vs PositionView sum`);
  expectEqual(snapshot.cacheSummary.totalCollateral, snapshot.rawPositions.totalCollateral, `${label}: CacheOptimizedView collateral vs PositionView sum`);
  expectEqual(snapshot.cacheSummary.totalDebt, snapshot.rawPositions.totalDebt, `${label}: CacheOptimizedView debt vs PositionView sum`);
  expectEqual(snapshot.dashboardOverview.healthFactor, snapshot.cacheSummary.healthFactor, `${label}: DashboardView health vs CacheOptimizedView`);
  expectEqual(snapshot.dashboardOverview.healthFactor, snapshot.userHealth.healthFactor, `${label}: DashboardView health vs UserView health`);

  if (requireValidCaches && !snapshot.userTotals.isValid) {
    throw new Error(`${label}: UserView totals should be valid`);
  }
  if (requireValidCaches && !snapshot.userHealth.isValid) {
    throw new Error(`${label}: UserView health should be valid`);
  }
  if (requireValidCaches && !snapshot.dashboardOverview.healthFactorValid) {
    throw new Error(`${label}: DashboardView health factor should be valid`);
  }
  if (requireValidCaches && !snapshot.cacheSummary.cacheValid) {
    throw new Error(`${label}: CacheOptimizedView summary should be valid`);
  }
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live View Facade Consistency",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh facade-consistency borrower" });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);
  await fundFundsFlowActors(ctx, {
    borrowerBorrowAmount: ctx.totalDue,
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });

  await observeExtendedViews(ctx, "facade-consistency-before");

  await depositCollateral(ctx, ctx.collateralAmount);
  const afterDeposit = await readFacadeSnapshot(ctx);
  assertFacadeConsistency(afterDeposit, "after-deposit", { requireValidCaches: false });

  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);
  const afterBorrow = await readFacadeSnapshot(ctx);
  assertFacadeConsistency(afterBorrow, "after-borrow");

  await repayOrder(ctx, finalized.orderId, ctx.totalDue);
  const afterRepay = await readFacadeSnapshot(ctx);
  assertFacadeConsistency(afterRepay, "after-repay");

  expectEqual(afterRepay.dashboardOverview.totalDebt, 0n, "after-repay raw debt should be zero");
  expectEqual(afterRepay.cacheSummary.totalDebt, 0n, "after-repay cache summary debt should be zero");
  expectEqual(afterRepay.userTotals.totalDebt, 0n, "after-repay statistics debt should be zero");

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});
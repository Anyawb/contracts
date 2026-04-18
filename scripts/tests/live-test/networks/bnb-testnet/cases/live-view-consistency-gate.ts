import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  expectEqual,
  expectGt,
  finalizeSingleMatch,
  fundFundsFlowActors,
  getOrderForView,
  observeExtendedViews,
  repayOrder,
  reserveForLending,
} from "../core/_fundsFlowLive";
import { requireFeeRouterSyncAdvance } from "../core/_feeLiveUtils";
import { primeMockLiveViewCache } from "../core/_mockLiveViewCache";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

const ORDER_PRODUCT_LOAN = 1n;
const ORDER_LIFECYCLE_REPAID = 2n;
const ORDER_CLOSE_REASON_FULL_REPAY = 1n;

function expectTrue(condition: boolean, label: string) {
  if (!condition) {
    throw new Error(label);
  }
}

function requireCoreViewGate(
  snapshot: Awaited<ReturnType<typeof observeExtendedViews>>,
  stage: string,
  options?: { requireSystemCache?: boolean; requireUserCaches?: boolean },
) {
  const requireSystemCache = options?.requireSystemCache ?? true;
  const requireUserCaches = options?.requireUserCaches ?? true;
  if (requireUserCaches) {
    expectTrue(snapshot.base.borrowerHealthValid, `${stage}: HealthView should be valid`);
    expectTrue(snapshot.base.collateralPositionValid, `${stage}: collateral PositionView should be valid`);
    expectTrue(snapshot.base.debtPositionValid, `${stage}: debt PositionView should be valid`);
  }
  if (requireSystemCache) {
    expectTrue(snapshot.base.debtAssetSystemValid, `${stage}: borrow-asset ViewCache should be valid`);
    expectTrue(snapshot.base.collateralSystemValid, `${stage}: collateral ViewCache should be valid`);
  }
}

function requireFeeRouterGate(snapshot: Awaited<ReturnType<typeof observeExtendedViews>>, stage: string) {
  if (!snapshot.feeRouterSync) {
    throw new Error(`${stage}: FeeRouterView sync status is unavailable`);
  }
  if (!snapshot.feeRouterSync.isValid || snapshot.feeRouterSync.needsSync) {
    console.log(
      `  [Notice] ${stage}: FeeRouterView is not publish-ready yet (valid=${snapshot.feeRouterSync.isValid} needsSync=${snapshot.feeRouterSync.needsSync}); skipping strict FeeRouter publish assertions`,
    );
    return false;
  }
  if (!snapshot.feeRouterUser) {
    throw new Error(`${stage}: FeeRouterView user stats are unavailable`);
  }
  return true;
}

function requireFeeRouterPresence(snapshot: Awaited<ReturnType<typeof observeExtendedViews>>, stage: string) {
  if (!snapshot.feeRouterSync) {
    throw new Error(`${stage}: FeeRouterView sync status is unavailable`);
  }
  if (!snapshot.feeRouterUser) {
    throw new Error(`${stage}: FeeRouterView user stats are unavailable`);
  }
}

function requireStatisticsGate(snapshot: Awaited<ReturnType<typeof observeExtendedViews>>, stage: string) {
  if (!snapshot.statisticsGlobal || !snapshot.statisticsGlobal.isValid) {
    throw new Error(`${stage}: StatisticsView global snapshot is unavailable or invalid`);
  }
}

function requireLoanFlowGate(snapshot: Awaited<ReturnType<typeof observeExtendedViews>>, stage: string) {
  if (!snapshot.loanFlowUser || !snapshot.loanFlowUser.isValid) {
    throw new Error(`${stage}: LoanFlowView user snapshot is unavailable or invalid`);
  }
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live View Consistency Gate",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh guarantee-sensitive borrower" });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);
  await primeMockLiveViewCache({ label: "Live View Consistency Gate Prime" });
  await fundFundsFlowActors(ctx, {
    borrowerBorrowAmount: ctx.totalDue,
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });

  const before = await observeExtendedViews(ctx, "before-full-flow");
  requireCoreViewGate(before, "before-full-flow", { requireSystemCache: false, requireUserCaches: false });
  requireFeeRouterPresence(before, "before-full-flow");

  await depositCollateral(ctx, ctx.collateralAmount);
  const afterDeposit = await observeExtendedViews(ctx, "after-deposit");
  expectTrue(afterDeposit.base.debtAssetSystemValid, "after-deposit: borrow-asset ViewCache should be valid");
  expectTrue(afterDeposit.base.collateralSystemValid, "after-deposit: collateral ViewCache should be valid");
  expectTrue(afterDeposit.base.collateralPositionValid, "after-deposit: collateral PositionView should be valid");
  expectEqual(
    afterDeposit.base.collateralPositionCollateral - before.base.collateralPositionCollateral,
    ctx.collateralAmount,
    "deposit collateral delta",
  );

  await fundFundsFlowActors(ctx, {
    lenderBorrowAmount: ctx.borrowAmount,
  });

  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);
  const afterBorrow = await observeExtendedViews(ctx, "after-borrow");
  requireCoreViewGate(afterBorrow, "after-borrow");
  const feeRouterReadyAfterBorrow = requireFeeRouterGate(afterBorrow, "after-borrow");
  if (feeRouterReadyAfterBorrow) {
    requireFeeRouterSyncAdvance(before, afterBorrow, "after-borrow");
  }
  requireStatisticsGate(afterBorrow, "after-borrow");
  requireLoanFlowGate(afterBorrow, "after-borrow");
  const beforeLoanFlowUser = before.loanFlowUser;
  const beforeStatisticsGlobal = before.statisticsGlobal;
  const afterBorrowLoanFlowUser = afterBorrow.loanFlowUser;
  const afterBorrowStatisticsGlobal = afterBorrow.statisticsGlobal;
  if (!beforeLoanFlowUser || !beforeStatisticsGlobal || !afterBorrowLoanFlowUser || !afterBorrowStatisticsGlobal) {
    throw new Error("view consistency gate: required LoanFlow/Statistics snapshots missing after borrow");
  }

  expectGt(
    afterBorrow.base.debtPositionDebt,
    before.base.debtPositionDebt,
    "debt position should increase after finalizeMatch",
  );
  expectGt(afterBorrowLoanFlowUser.borrowVolumeUsd8, beforeLoanFlowUser.borrowVolumeUsd8, "LoanFlowView borrow volume should increase");
  expectGt(afterBorrowLoanFlowUser.borrowCount, beforeLoanFlowUser.borrowCount, "LoanFlowView borrow count should increase");
  expectGt(afterBorrowStatisticsGlobal.totalCollateral, beforeStatisticsGlobal.totalCollateral, "StatisticsView collateral should increase after deposit/match");

  await repayOrder(ctx, finalized.orderId, ctx.totalDue);
  const afterRepay = await observeExtendedViews(ctx, "after-repay");
  requireCoreViewGate(afterRepay, "after-repay");
  const feeRouterReadyAfterRepay = requireFeeRouterGate(afterRepay, "after-repay");
  if (feeRouterReadyAfterRepay) {
    requireFeeRouterSyncAdvance(afterBorrow, afterRepay, "after-repay");
  }
  requireStatisticsGate(afterRepay, "after-repay");
  requireLoanFlowGate(afterRepay, "after-repay");
  const afterRepayLoanFlowUser = afterRepay.loanFlowUser;
  if (!afterRepayLoanFlowUser) {
    throw new Error("view consistency gate: required LoanFlow snapshot missing after repay");
  }

  expectEqual(afterRepay.base.debtPositionDebt, before.base.debtPositionDebt, "debt position should return to baseline after repay");
  expectGt(afterRepayLoanFlowUser.repayVolumeUsd8, beforeLoanFlowUser.repayVolumeUsd8, "LoanFlowView repay volume should increase");
  expectGt(afterRepayLoanFlowUser.repayCount, beforeLoanFlowUser.repayCount, "LoanFlowView repay count should increase");
  if (feeRouterReadyAfterBorrow && feeRouterReadyAfterRepay) {
    const afterRepayFeeRouterUser = afterRepay.feeRouterUser;
    const afterBorrowFeeRouterUser = afterBorrow.feeRouterUser;
    if (!afterRepayFeeRouterUser || !afterBorrowFeeRouterUser) {
      throw new Error("view consistency gate: required FeeRouterView snapshot missing after repay");
    }
    expectGt(afterRepayFeeRouterUser.transactionCount, afterBorrowFeeRouterUser.transactionCount, "FeeRouterView tx count should increase again after repay");
  }

  const order = await getOrderForView(ctx, finalized.orderId);
  if (!ctx.lendingEngineView) {
    throw new Error("view consistency gate: LendingEngineView is required for explicit order status checks");
  }
  const orderState = await ctx.lendingEngineView.connect(ctx.relayer).getOrderStateSnapshot(finalized.orderId);
  expectEqual(BigInt(orderState.productType), ORDER_PRODUCT_LOAN, "order product type");
  expectEqual(BigInt(orderState.lifecycle), ORDER_LIFECYCLE_REPAID, "order lifecycle snapshot");
  expectEqual(BigInt(orderState.closeReason), ORDER_CLOSE_REASON_FULL_REPAY, "order close reason snapshot");
  expectEqual(order.repaidAmount, ctx.totalDue, "order repaidAmount");
  if (order.borrower.toLowerCase() !== ctx.borrower.address.toLowerCase()) {
    throw new Error(`order borrower mismatch: expected ${ctx.borrower.address} got ${order.borrower}`);
  }
  if (order.asset.toLowerCase() !== ctx.borrowAssetAddr.toLowerCase()) {
    throw new Error(`order asset mismatch: expected ${ctx.borrowAssetAddr} got ${order.asset}`);
  }

  if (afterRepay.systemRisk) {
    expectGt(afterRepay.systemRisk.liquidationThreshold, 0n, "SystemRiskView liquidation threshold");
    expectGt(afterRepay.systemRisk.minHealthFactor, 0n, "SystemRiskView min health factor");
    expectGt(afterRepay.systemRisk.maxLtvBps, 0n, "SystemRiskView max ltv");
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});
import { ethers } from "hardhat";

import {
  assignFreshBorrower,
  assignFreshLender,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  expectEqual,
  finalizeSingleMatch,
  fundFundsFlowActors,
  getOrderForView,
  getTokenBalances,
  observeExtendedViews,
  repayOrder,
  reserveForLending,
  sumTokenBalances,
} from "../core/_fundsFlowLive";
import { requireFeeRouterSyncAdvance } from "../core/_feeLiveUtils";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

const ORDER_PRODUCT_LOAN = 1n;
const ORDER_LIFECYCLE_REPAID = 2n;
const ORDER_CLOSE_REASON_FULL_REPAY = 1n;

function uniqAddresses(addresses: string[]) {
  return [...new Set(addresses.filter((address) => address && address !== ethers.ZeroAddress))];
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

function isStrictFeeCustodyMonotonic() {
  const raw = process.env.LIVE_STRICT_FEE_CUSTODY_NONDECREASING?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Fee Accounting",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh fee-accounting borrower" });
  await assignFreshLender(ctx, { noticeLabel: "using fresh fee-accounting lender" });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  const platformTreasury = (await ctx.feeRouter.getPlatformTreasury()) as string;
  const ecosystemVault = (await ctx.feeRouter.getEcosystemVault()) as string;

  await fundFundsFlowActors(ctx, {
    borrowerBorrowAmount: ctx.totalDue,
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });

  const tracked = uniqAddresses([
    ctx.relayer.address,
    ctx.borrower.address,
    ctx.lender.address,
    platformTreasury,
    ecosystemVault,
    ctx.feeRouterAddr,
    ctx.guaranteeFundAddr,
    ctx.lenderPoolVaultAddr,
    ctx.vblAddr,
    ctx.vaultCoreAddr,
    ctx.orderEngineAddr,
    ctx.settlementManagerAddr,
  ]);

  const beforeBalances = await getTokenBalances(ctx, ctx.borrowToken, tracked);
  const beforeViews = await observeExtendedViews(ctx, "before-fee-flow");
  requireFeeRouterPresence(beforeViews, "before-fee-flow");
  const beforeFeeCustody =
    beforeBalances.get(platformTreasury)! + beforeBalances.get(ecosystemVault)! + beforeBalances.get(ctx.feeRouterAddr)!;

  await depositCollateral(ctx, ctx.collateralAmount);

  const reserve = await reserveForLending(ctx);
  const afterReserveBalances = await getTokenBalances(ctx, ctx.borrowToken, tracked);
  const reserveLenderDelta = beforeBalances.get(ctx.lender.address)! - afterReserveBalances.get(ctx.lender.address)!;
  const reservePoolDelta = afterReserveBalances.get(ctx.lenderPoolVaultAddr)! - beforeBalances.get(ctx.lenderPoolVaultAddr)!;
  const transferOnReserve = reserveLenderDelta === ctx.borrowAmount && reservePoolDelta === ctx.borrowAmount;
  const bookkeepingReserve = reserveLenderDelta === 0n && reservePoolDelta === 0n;
  const poolOnlyReserve = reserveLenderDelta === 0n && reservePoolDelta === ctx.borrowAmount;
  if (!transferOnReserve && !bookkeepingReserve && !poolOnlyReserve) {
    throw new Error(
      `reserve balance model mismatch: lenderDelta=${reserveLenderDelta.toString()} poolDelta=${reservePoolDelta.toString()} expected transfer(${ctx.borrowAmount.toString()},${ctx.borrowAmount.toString()}), pool-only(0,${ctx.borrowAmount.toString()}) or bookkeeping(0,0)`,
    );
  }
  if (bookkeepingReserve) {
    console.log("  [Notice] reserve uses bookkeeping mode on this deployment (no immediate token movement)");
  } else if (poolOnlyReserve) {
    console.log("  [Notice] reserve uses pool-only custody mode on this deployment (lender wallet unchanged at reserve edge)");
  }
  const reserveSumBefore = sumTokenBalances(beforeBalances);
  const reserveSumAfter = sumTokenBalances(afterReserveBalances);
  const reserveNetDelta = reserveSumAfter - reserveSumBefore;
  if (poolOnlyReserve) {
    expectEqual(
      reserveNetDelta,
      ctx.borrowAmount,
      "reserve tracked token conservation (pool-only mode delta)",
    );
  } else {
    expectEqual(reserveSumAfter, reserveSumBefore, "reserve tracked token conservation");
  }

  const finalized = await finalizeSingleMatch(ctx, reserve);
  const afterBorrowBalances = await getTokenBalances(ctx, ctx.borrowToken, tracked);
  const afterBorrowViews = await observeExtendedViews(ctx, "after-fee-borrow");
  if (requireFeeRouterGate(afterBorrowViews, "after-fee-borrow")) {
    requireFeeRouterSyncAdvance(beforeViews, afterBorrowViews, "after-fee-borrow");
  }
  expectEqual(sumTokenBalances(afterBorrowBalances), sumTokenBalances(beforeBalances), "borrow tracked token conservation");
  const afterBorrowFeeCustody =
    afterBorrowBalances.get(platformTreasury)! + afterBorrowBalances.get(ecosystemVault)! + afterBorrowBalances.get(ctx.feeRouterAddr)!;

  if (afterBorrowFeeCustody < beforeFeeCustody) {
    if (isStrictFeeCustodyMonotonic()) {
      throw new Error("fee custody should not shrink when finalizeMatch reports higher paid fees");
    }
    console.log(
      `  [Notice] fee custody decreased after finalizeMatch (before=${beforeFeeCustody.toString()} after=${afterBorrowFeeCustody.toString()}); continue in BNB shared-state mode`,
    );
  }

  await repayOrder(ctx, finalized.orderId, ctx.totalDue);
  const afterRepayBalances = await getTokenBalances(ctx, ctx.borrowToken, tracked);
  const afterRepayViews = await observeExtendedViews(ctx, "after-fee-repay");
  if (requireFeeRouterGate(afterRepayViews, "after-fee-repay")) {
    requireFeeRouterSyncAdvance(afterBorrowViews, afterRepayViews, "after-fee-repay");
  }
  expectEqual(sumTokenBalances(afterRepayBalances), sumTokenBalances(beforeBalances), "repay tracked token conservation");

  const afterFeeCustody =
    afterRepayBalances.get(platformTreasury)! + afterRepayBalances.get(ecosystemVault)! + afterRepayBalances.get(ctx.feeRouterAddr)!;

  if (afterFeeCustody < afterBorrowFeeCustody) {
    if (isStrictFeeCustodyMonotonic()) {
      throw new Error("fee custody should not shrink when repay reports additional paid fees");
    }
    console.log(
      `  [Notice] fee custody decreased after repay (borrowStage=${afterBorrowFeeCustody.toString()} repayStage=${afterFeeCustody.toString()}); continue in BNB shared-state mode`,
    );
  }

  const order = await getOrderForView(ctx, finalized.orderId);
  if (!ctx.lendingEngineView) {
    throw new Error("fee accounting: LendingEngineView is required for explicit order status checks");
  }
  const orderState = await ctx.lendingEngineView.connect(ctx.borrower).getOrderStateSnapshot(finalized.orderId);
  expectEqual(
    BigInt(orderState.productType),
    ORDER_PRODUCT_LOAN,
    "order product type after fee flow",
  );
  expectEqual(
    BigInt(orderState.lifecycle),
    ORDER_LIFECYCLE_REPAID,
    "order lifecycle snapshot after fee flow",
  );
  expectEqual(
    BigInt(orderState.closeReason),
    ORDER_CLOSE_REASON_FULL_REPAY,
    "order close reason snapshot after fee flow",
  );
  expectEqual(order.repaidAmount, ctx.totalDue, "order repaidAmount after fee flow");

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
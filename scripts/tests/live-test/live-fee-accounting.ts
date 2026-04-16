import { ethers } from "hardhat";

import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  expectEqual,
  finalizeSingleMatch,
  fundFundsFlowActors,
  getOrderLifecycleStatus,
  getOrderForView,
  getTokenBalances,
  LOAN_STATUS,
  observeExtendedViews,
  repayOrder,
  reserveForLending,
  sumTokenBalances,
} from "./_fundsFlowLive";
import { requireFeeRouterSyncAdvance } from "./_feeLiveUtils";
import { runWithNetworkRetry } from "./_networkRetry";
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "./_scriptStatus";

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

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Fee Accounting",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh fee-accounting borrower" });

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
  expectEqual(
    beforeBalances.get(ctx.lender.address)! - afterReserveBalances.get(ctx.lender.address)!,
    ctx.borrowAmount,
    "reserve lender wallet delta",
  );
  expectEqual(
    afterReserveBalances.get(ctx.lenderPoolVaultAddr)! - beforeBalances.get(ctx.lenderPoolVaultAddr)!,
    ctx.borrowAmount,
    "reserve lender pool vault delta",
  );
  expectEqual(sumTokenBalances(afterReserveBalances), sumTokenBalances(beforeBalances), "reserve tracked token conservation");

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
    throw new Error("fee custody should not shrink when finalizeMatch reports higher paid fees");
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
    throw new Error("fee custody should not shrink when repay reports additional paid fees");
  }

  const order = await getOrderForView(ctx, finalized.orderId);
  expectEqual(await getOrderLifecycleStatus(ctx, finalized.orderId), LOAN_STATUS.Repaid, "order lifecycle status after fee flow");
  expectEqual(order.repaidAmount, ctx.totalDue, "order repaidAmount after fee flow");

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
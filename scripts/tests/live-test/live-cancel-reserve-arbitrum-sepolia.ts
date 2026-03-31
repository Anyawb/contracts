import {
  cancelReserve,
  createFundsFlowLiveContext,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  expectEqual,
  fundFundsFlowActors,
  getTokenBalances,
  observeExtendedViews,
  reserveForLending,
} from "./_fundsFlowLive";

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Cancel Reserve",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);
  await fundFundsFlowActors(ctx, {
    lenderBorrowAmount: ctx.borrowAmount,
  });

  const beforeViews = await observeExtendedViews(ctx, "before-cancel-reserve");
  const beforeBalances = await getTokenBalances(ctx, ctx.borrowToken, [ctx.lender.address, ctx.lenderPoolVaultAddr]);

  const reserve = await reserveForLending(ctx);

  const afterReserveBalances = await getTokenBalances(ctx, ctx.borrowToken, [ctx.lender.address, ctx.lenderPoolVaultAddr]);
  expectEqual(
    (afterReserveBalances.get(ctx.lender.address) ?? 0n) - (beforeBalances.get(ctx.lender.address) ?? 0n),
    -ctx.borrowAmount,
    "reserve lender delta",
  );
  expectEqual(
    (afterReserveBalances.get(ctx.lenderPoolVaultAddr) ?? 0n) - (beforeBalances.get(ctx.lenderPoolVaultAddr) ?? 0n),
    ctx.borrowAmount,
    "reserve pool delta",
  );

  await cancelReserve(ctx, reserve.lendHash);

  const afterCancelBalances = await getTokenBalances(ctx, ctx.borrowToken, [ctx.lender.address, ctx.lenderPoolVaultAddr]);
  expectEqual(
    afterCancelBalances.get(ctx.lender.address) ?? 0n,
    beforeBalances.get(ctx.lender.address) ?? 0n,
    "cancel lender balance restore",
  );
  expectEqual(
    afterCancelBalances.get(ctx.lenderPoolVaultAddr) ?? 0n,
    beforeBalances.get(ctx.lenderPoolVaultAddr) ?? 0n,
    "cancel pool balance restore",
  );

  const afterViews = await observeExtendedViews(ctx, "after-cancel-reserve");

  if (beforeViews.loanFlowGlobal && afterViews.loanFlowGlobal) {
    expectEqual(afterViews.loanFlowGlobal.borrowVolumeUsd8, beforeViews.loanFlowGlobal.borrowVolumeUsd8, "cancel should not change global borrow volume");
    expectEqual(afterViews.loanFlowGlobal.repayVolumeUsd8, beforeViews.loanFlowGlobal.repayVolumeUsd8, "cancel should not change global repay volume");
  }

  console.log("\n✅ live-cancel-reserve-arbitrum-sepolia PASSED\n");
}

main().catch((error) => {
  console.error("\n❌ live-cancel-reserve-arbitrum-sepolia FAILED\n");
  console.error(error);
  process.exit(1);
});
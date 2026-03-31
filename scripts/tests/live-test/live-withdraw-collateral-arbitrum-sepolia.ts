import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  expectEqual,
  fundFundsFlowActors,
  observeExtendedViews,
  withdrawCollateral,
} from "./_fundsFlowLive";

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Withdraw Collateral",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh withdraw borrower" });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);
  await fundFundsFlowActors(ctx, {
    borrowerCollateralAmount: ctx.collateralAmount,
  });

  const withdrawAmount = ctx.collateralAmount / 2n;
  if (withdrawAmount === 0n) {
    throw new Error("withdraw amount resolved to zero");
  }

  const walletBefore = (await ctx.collateralToken.balanceOf(ctx.borrower.address)) as bigint;
  const beforeViews = await observeExtendedViews(ctx, "before-withdraw");

  await depositCollateral(ctx, ctx.collateralAmount);

  const walletAfterDeposit = (await ctx.collateralToken.balanceOf(ctx.borrower.address)) as bigint;
  expectEqual(walletBefore - walletAfterDeposit, ctx.collateralAmount, "deposit wallet delta");

  const afterDepositViews = await observeExtendedViews(ctx, "after-deposit-for-withdraw");
  expectEqual(
    afterDepositViews.base.collateralPositionCollateral - beforeViews.base.collateralPositionCollateral,
    ctx.collateralAmount,
    "deposit collateral position delta",
  );

  await withdrawCollateral(ctx, withdrawAmount);

  const walletAfterWithdraw = (await ctx.collateralToken.balanceOf(ctx.borrower.address)) as bigint;
  expectEqual(walletAfterWithdraw - walletAfterDeposit, withdrawAmount, "withdraw wallet delta");

  const afterWithdrawViews = await observeExtendedViews(ctx, "after-withdraw");
  expectEqual(
    afterDepositViews.base.collateralPositionCollateral - afterWithdrawViews.base.collateralPositionCollateral,
    withdrawAmount,
    "withdraw collateral position delta",
  );

  if (!afterWithdrawViews.base.borrowerHealthValid) {
    console.log("  [Notice] HealthView remained cold after collateral-only withdraw flow; relying on collateral position delta instead");
  }

  console.log("\n✅ live-withdraw-collateral-arbitrum-sepolia PASSED\n");
}

main().catch((error) => {
  console.error("\n❌ live-withdraw-collateral-arbitrum-sepolia FAILED\n");
  console.error(error);
  process.exit(1);
});
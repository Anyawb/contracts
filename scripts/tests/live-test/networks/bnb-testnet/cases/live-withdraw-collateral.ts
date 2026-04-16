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
} from "../core/_fundsFlowLive";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

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
  const depositWalletDelta = walletBefore - walletAfterDeposit;

  const afterDepositViews = await observeExtendedViews(ctx, "after-deposit-for-withdraw");
  expectEqual(
    afterDepositViews.base.collateralPositionCollateral - beforeViews.base.collateralPositionCollateral,
    ctx.collateralAmount,
    "deposit collateral position delta",
  );
  if (depositWalletDelta !== ctx.collateralAmount) {
    console.log(
      `  [Notice] deposit wallet delta mismatch on ${ctx.collateralSymbol}; relying on collateral position delta instead: expected=${ctx.collateralAmount.toString()} actual=${depositWalletDelta.toString()}`,
    );
  }

  await withdrawCollateral(ctx, withdrawAmount);

  const walletAfterWithdraw = (await ctx.collateralToken.balanceOf(ctx.borrower.address)) as bigint;
  const withdrawWalletDelta = walletAfterWithdraw - walletAfterDeposit;

  const afterWithdrawViews = await observeExtendedViews(ctx, "after-withdraw");
  expectEqual(
    afterDepositViews.base.collateralPositionCollateral - afterWithdrawViews.base.collateralPositionCollateral,
    withdrawAmount,
    "withdraw collateral position delta",
  );
  if (withdrawWalletDelta !== withdrawAmount) {
    console.log(
      `  [Notice] withdraw wallet delta mismatch on ${ctx.collateralSymbol}; relying on collateral position delta instead: expected=${withdrawAmount.toString()} actual=${withdrawWalletDelta.toString()}`,
    );
  }

  if (!afterWithdrawViews.base.borrowerHealthValid) {
    console.log("  [Notice] HealthView remained cold after collateral-only withdraw flow; relying on collateral position delta instead");
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});
import {
  assignFreshLender,
  cancelReserve,
  createFundsFlowLiveContext,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  expectEqual,
  fundFundsFlowActors,
  getTokenBalances,
  observeExtendedViews,
  reserveForLending,
} from "../core/_fundsFlowLive";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

function envFlag(name: string, def = false) {
  const raw = process.env[name];
  if (raw === undefined) {
    return def;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

type ConcreteReserveModel = "transfer" | "bookkeeping" | "pool-only";
type ReserveModel = ConcreteReserveModel | "auto";

function resolveStrictReserveExpectedModel(): ReserveModel {
  const raw = process.env.LIVE_STRICT_RESERVE_EXPECTED_MODEL?.trim().toLowerCase();
  if (!raw) {
    return "auto";
  }
  if (raw === "transfer" || raw === "bookkeeping" || raw === "pool-only" || raw === "auto") {
    return raw;
  }
  throw new Error(
    `unsupported LIVE_STRICT_RESERVE_EXPECTED_MODEL=${raw}; expected transfer | bookkeeping | pool-only | auto`,
  );
}

function detectReserveModel(ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>, lenderDelta: bigint, poolDelta: bigint): ConcreteReserveModel | null {
  if (lenderDelta === 0n - ctx.borrowAmount && poolDelta === ctx.borrowAmount) {
    return "transfer";
  }
  if (lenderDelta === 0n && poolDelta === 0n) {
    return "bookkeeping";
  }
  if (lenderDelta === 0n && poolDelta === ctx.borrowAmount) {
    return "pool-only";
  }
  return null;
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Cancel Reserve",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });
  const strictSingleModel = envFlag("LIVE_STRICT_RESERVE_SINGLE_MODEL", envFlag("LIVE_FAIL_ON_MISSING_RUNTIME_ROLES", false));
  const configuredModel = resolveStrictReserveExpectedModel();

  if (strictSingleModel && configuredModel === "transfer") {
    await assignFreshLender(ctx, { noticeLabel: "using fresh cancel-reserve lender" });
  }

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);
  await fundFundsFlowActors(ctx, {
    lenderBorrowAmount: ctx.borrowAmount,
  });

  const beforeViews = await observeExtendedViews(ctx, "before-cancel-reserve");
  const beforeBalances = await getTokenBalances(ctx, ctx.borrowToken, [ctx.lender.address, ctx.lenderPoolVaultAddr]);

  const reserve = await reserveForLending(ctx);

  const afterReserveBalances = await getTokenBalances(ctx, ctx.borrowToken, [ctx.lender.address, ctx.lenderPoolVaultAddr]);
  const reserveLenderDelta = (afterReserveBalances.get(ctx.lender.address) ?? 0n) - (beforeBalances.get(ctx.lender.address) ?? 0n);
  const reservePoolDelta = (afterReserveBalances.get(ctx.lenderPoolVaultAddr) ?? 0n) - (beforeBalances.get(ctx.lenderPoolVaultAddr) ?? 0n);
  let strictModelForCancel: ConcreteReserveModel | null = null;

  // Some deployments transfer funds at reserve time, while others only record intent and transfer later.
  const reserveObservedModel = detectReserveModel(ctx, reserveLenderDelta, reservePoolDelta);
  const transferOnReserve = reserveObservedModel === "transfer";
  const bookkeepingReserve = reserveObservedModel === "bookkeeping";
  const poolOnlyReserve = reserveObservedModel === "pool-only";
  if (strictSingleModel) {
    const expectedModel = resolveStrictReserveExpectedModel();
    if (!reserveObservedModel) {
      throw new Error(
        `strict reserve model violation: reserve produced unknown balance movement lenderDelta=${reserveLenderDelta.toString()} poolDelta=${reservePoolDelta.toString()}`,
      );
    }
    const strictModel = expectedModel === "auto" ? reserveObservedModel : expectedModel;
    strictModelForCancel = strictModel;
    const strictReserveMatch = strictModel === reserveObservedModel;
    if (!strictReserveMatch) {
      throw new Error(
        `strict reserve model violation: expected model=${strictModel} on reserve, observed=${reserveObservedModel} lenderDelta=${reserveLenderDelta.toString()} poolDelta=${reservePoolDelta.toString()}`,
      );
    }
  }
  if (!transferOnReserve && !bookkeepingReserve && !poolOnlyReserve) {
    throw new Error(
      `reserve balance model mismatch: lenderDelta=${reserveLenderDelta.toString()} poolDelta=${reservePoolDelta.toString()} expected transfer(-${ctx.borrowAmount.toString()},+${ctx.borrowAmount.toString()}), bookkeeping(0,0), or pool-only(0,+${ctx.borrowAmount.toString()})`,
    );
  }
  if (bookkeepingReserve) {
    console.log("  [Notice] reserve uses bookkeeping mode on this deployment (no immediate token movement)");
  } else if (poolOnlyReserve) {
    console.log("  [Notice] reserve uses pool-only custody mode on this deployment (lender wallet unchanged)");
  }

  await cancelReserve(ctx, reserve.lendHash);

  const afterCancelBalances = await getTokenBalances(ctx, ctx.borrowToken, [ctx.lender.address, ctx.lenderPoolVaultAddr]);
  const cancelLenderDelta = (afterCancelBalances.get(ctx.lender.address) ?? 0n) - (beforeBalances.get(ctx.lender.address) ?? 0n);
  const cancelPoolDelta = (afterCancelBalances.get(ctx.lenderPoolVaultAddr) ?? 0n) - (beforeBalances.get(ctx.lenderPoolVaultAddr) ?? 0n);
  const cancelRestored = cancelLenderDelta === 0n && cancelPoolDelta === 0n;
  const cancelRetainedInPool = cancelLenderDelta === 0n - ctx.borrowAmount && cancelPoolDelta === ctx.borrowAmount;
  const cancelPoolOnly = cancelLenderDelta === 0n && cancelPoolDelta === ctx.borrowAmount;
  if (strictSingleModel) {
    const expectedModel = strictModelForCancel ?? configuredModel;
    const strictCancelMatch = configuredModel === "auto"
      ? (cancelRestored || cancelRetainedInPool || cancelPoolOnly)
      : (expectedModel === "transfer" && (cancelRestored || cancelRetainedInPool))
        || (expectedModel === "bookkeeping" && cancelRestored)
        || (expectedModel === "pool-only" && cancelPoolOnly);
    if (!strictCancelMatch) {
      throw new Error(
        `strict reserve model violation: expected model=${configuredModel === "auto" ? "auto-known-terminal-state" : expectedModel} after cancel, got lenderDelta=${cancelLenderDelta.toString()} poolDelta=${cancelPoolDelta.toString()}`,
      );
    }
  }
  if (!cancelRestored && !cancelRetainedInPool && !cancelPoolOnly) {
    throw new Error(
      `cancel reserve balance model mismatch: lenderDelta=${cancelLenderDelta.toString()} poolDelta=${cancelPoolDelta.toString()} expected restore(0,0), pool-retained(-${ctx.borrowAmount.toString()},+${ctx.borrowAmount.toString()}), or pool-only(0,+${ctx.borrowAmount.toString()})`,
    );
  }
  if (cancelRetainedInPool) {
    console.log("  [Notice] cancel reserve kept custody in lender pool vault on this deployment");
  } else if (cancelPoolOnly) {
    console.log("  [Notice] cancel reserve preserved pool-only custody mode on this deployment");
  }

  const afterViews = await observeExtendedViews(ctx, "after-cancel-reserve");

  if (beforeViews.loanFlowGlobal && afterViews.loanFlowGlobal) {
    expectEqual(afterViews.loanFlowGlobal.borrowVolumeUsd8, beforeViews.loanFlowGlobal.borrowVolumeUsd8, "cancel should not change global borrow volume");
    expectEqual(afterViews.loanFlowGlobal.repayVolumeUsd8, beforeViews.loanFlowGlobal.repayVolumeUsd8, "cancel should not change global repay volume");
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});
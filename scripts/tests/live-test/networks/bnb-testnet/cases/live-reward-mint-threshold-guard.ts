import {
  depositCollateral,
  finalizeSingleMatch,
  fundFundsFlowActors,
  repayOrder,
  reserveForLending,
} from "../core/_fundsFlowLive";
import {
  bootstrapRewardLiveTest,
  DEFAULT_ACCEPTED_EASY_MINT_SKIP_REASONS,
  decodeRewardViewPushes,
  inspectEasyMintRepayOutcome,
  readRewardUser,
} from "../core/_rewardLive";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

function envInt(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function main() {
  const rounds = envInt("LIVE_REWARD_THRESHOLD_GUARD_ROUNDS", 3);
  const borrowUnits = envInt("LIVE_REWARD_THRESHOLD_GUARD_BORROW_UNITS", 999);

  if (borrowUnits >= 1000) {
    throw new Error(`LIVE_REWARD_THRESHOLD_GUARD_BORROW_UNITS must be < 1000, got ${borrowUnits}`);
  }

  const previousBorrowAmountUnits = process.env.BORROW_AMOUNT_UNITS;
  process.env.BORROW_AMOUNT_UNITS = String(borrowUnits);

  try {
    const { ctx, reward } = await bootstrapRewardLiveTest({
      label: "Live Reward Mint Threshold Guard",
      noticeLabel: "using fresh reward-threshold borrower",
      collateralAmountUnitsDefault: "10",
      borrowAmountUnitsDefault: String(borrowUnits),
    });

    const baseline = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);

    for (let i = 0; i < rounds; i += 1) {
      await fundFundsFlowActors(ctx, {
        borrowerBorrowAmount: ctx.totalDue,
        borrowerCollateralAmount: ctx.collateralAmount,
        lenderBorrowAmount: ctx.borrowAmount,
      });

      await depositCollateral(ctx, ctx.collateralAmount);
      const reserve = await reserveForLending(ctx);
      const finalized = await finalizeSingleMatch(ctx, reserve);
      const repayReceipt = await repayOrder(ctx, finalized.orderId, ctx.totalDue);

      const repayOutcome = inspectEasyMintRepayOutcome(reward, repayReceipt, {
        rewardViewPushes: decodeRewardViewPushes(reward, repayReceipt),
        acceptedSkipReasons: DEFAULT_ACCEPTED_EASY_MINT_SKIP_REASONS,
      });

      if (repayOutcome.mintedPush) {
        throw new Error(
          `threshold guard round #${i + 1}: got EASY_MINTED unexpectedly for sub-threshold borrowUnits=${borrowUnits}`,
        );
      }

      if (!repayOutcome.hasAcceptedSkip || repayOutcome.skipReason !== "below-min-1000u") {
        throw new Error(
          `threshold guard round #${i + 1}: expected below-min-1000u skip, got ${String(repayOutcome.skipReason ?? "none")}`,
        );
      }

      const afterRepay = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
      if (afterRepay.easyEarned !== baseline.easyEarned) {
        throw new Error(
          `threshold guard round #${i + 1}: easyEarned changed unexpectedly ${baseline.easyEarned.toString()} -> ${afterRepay.easyEarned.toString()}`,
        );
      }
      if (afterRepay.easyBalance !== baseline.easyBalance) {
        throw new Error(
          `threshold guard round #${i + 1}: easyBalance changed unexpectedly ${baseline.easyBalance.toString()} -> ${afterRepay.easyBalance.toString()}`,
        );
      }

      console.log(
        `  [RewardThresholdGuard] round=${i + 1}/${rounds} orderId=${finalized.orderId.toString()} skipReason=${repayOutcome.skipReason} easyEarned=${afterRepay.easyEarned.toString()}`,
      );
    }

    console.log(
      `  [RewardThresholdGuardSummary] rounds=${rounds} borrowUnits=${borrowUnits} result=sub-threshold-and-cumulative-no-mint`,
    );
    logLiveScriptSuccess(__filename);
  } finally {
    if (previousBorrowAmountUnits === undefined) {
      delete process.env.BORROW_AMOUNT_UNITS;
    } else {
      process.env.BORROW_AMOUNT_UNITS = previousBorrowAmountUnits;
    }
  }
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);

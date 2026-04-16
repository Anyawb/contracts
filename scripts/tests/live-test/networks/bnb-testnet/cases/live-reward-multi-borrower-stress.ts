import { ethers } from "hardhat";

import {
  assignFreshBorrower,
  bootstrapFundsFlowLiveTest,
  depositCollateral,
  ensureTokenAllowance,
  finalizeSingleMatch,
  fundFundsFlowActors,
  repayOrder,
  reserveForLending,
} from "../core/_fundsFlowLive";
import {
  DEFAULT_ACCEPTED_EASY_MINT_SKIP_REASONS,
  decodeRewardViewPushes,
  inspectEasyMintRepayOutcome,
  loadRewardModules,
  readRewardUser,
  requireEasyMintedOrAcceptedSkip,
  requireRewardViewPush,
  tryReadSpendStats,
} from "../core/_rewardLive";
import { explainRevert, key } from "../core/_mockLiveUtils";
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForObservedState<T>(
  label: string,
  read: () => Promise<T>,
  isReady: (state: T) => boolean,
  timeoutMs = 45_000,
  pollMs = 1_500,
) {
  const deadline = Date.now() + timeoutMs;
  let lastState: T | null = null;

  while (Date.now() < deadline) {
    lastState = await read();
    if (isReady(lastState)) {
      return lastState;
    }
    await delay(pollMs);
  }

  throw new Error(`${label}: observed state did not converge before timeout`);
}

async function readSystemStats(rewardView: any, caller: any) {
  const [totalBatchOps, totalCachedRewards, totalPendingPenalty, totalBurned, isValid] =
    (await rewardView.connect(caller).getSystemRewardStatsWithMeta()) as [bigint, bigint, bigint, bigint, boolean];
  return { totalBatchOps, totalCachedRewards, totalPendingPenalty, totalBurned, isValid };
}

async function readTopEarners(rewardView: any, caller: any) {
  const [users, amounts, blockNumber, isValid] =
    (await rewardView.connect(caller).getTopEarnersWithMeta()) as [string[], bigint[], bigint, boolean];
  return { users, amounts, blockNumber, isValid };
}

async function ensureBorrowerEasyForConsume(params: {
  reward: Awaited<ReturnType<typeof loadRewardModules>>;
  borrower: any;
  relayer: any;
  lender: any;
  viewer: any;
  minAmount: bigint;
  borrowerIndex: number;
}) {
  const { reward, borrower, relayer, lender, viewer, minAmount, borrowerIndex } = params;
  const current = (await reward.easyToken.balanceOf(borrower.address)) as bigint;
  if (current >= minAmount) {
    return current;
  }

  const shortfall = minAmount - current;
  const sponsors = [relayer, lender, viewer].filter((signer) => signer && signer.address.toLowerCase() !== borrower.address.toLowerCase());
  const sponsorFailures: string[] = [];

  for (const sponsor of sponsors) {
    const sponsorBalance = (await reward.easyToken.balanceOf(sponsor.address)) as bigint;
    if (sponsorBalance < shortfall) {
      sponsorFailures.push(`transfer:${sponsor.address}:balance=${sponsorBalance.toString()}`);
      continue;
    }
    await (await reward.easyToken.connect(sponsor).transfer(borrower.address, shortfall)).wait();
    const after = (await reward.easyToken.balanceOf(borrower.address)) as bigint;
    console.log(
      `  [RewardStress] borrower #${borrowerIndex + 1} EASY top-up sponsor=${sponsor.address} amount=${shortfall.toString()} balance=${after.toString()}`,
    );
    return after;
  }

  // Fallback for environments where sponsor is expected to mint EASY instead of transferring inventory.
  const minterRole = (await reward.easyToken.MINTER_ROLE()) as string;
  for (const sponsor of sponsors) {
    let hasMinterRole = false;
    try {
      hasMinterRole = (await reward.easyToken.hasRole(minterRole, sponsor.address)) as boolean;
    } catch (error: any) {
      sponsorFailures.push(`mint-check:${sponsor.address}:${String(error?.message ?? error)}`);
      continue;
    }
    if (!hasMinterRole) {
      sponsorFailures.push(`mint:${sponsor.address}:missing-minter-role`);
      continue;
    }

    try {
      await (await reward.easyToken.connect(sponsor).mint(borrower.address, shortfall)).wait();
      const after = (await reward.easyToken.balanceOf(borrower.address)) as bigint;
      console.log(
        `  [RewardStress] borrower #${borrowerIndex + 1} EASY mint-top-up sponsor=${sponsor.address} amount=${shortfall.toString()} balance=${after.toString()}`,
      );
      return after;
    } catch (error: any) {
      sponsorFailures.push(`mint:${sponsor.address}:${String(error?.message ?? error)}`);
    }
  }

  throw new Error(
    `reward stress borrower #${borrowerIndex + 1}: insufficient EASY for consume and no sponsor could top up shortfall=${shortfall.toString()} details=${sponsorFailures.join(";")}`,
  );
}

async function main() {
  const borrowerCount = envInt("LIVE_REWARD_STRESS_BORROWERS", 3);
  if (borrowerCount < 2) {
    throw new Error(`LIVE_REWARD_STRESS_BORROWERS must be >= 2, got ${borrowerCount}`);
  }

  const { ctx } = await bootstrapFundsFlowLiveTest({
    label: "Live Reward Multi Borrower Stress",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });
  const reward = await loadRewardModules(ctx);

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const easyStakingAddr = (await registry.getModuleOrRevert(key("EASY_STAKING"))) as string;
  const easyStaking = (await ethers.getContractAt(
    [
      "function stake(uint256 amount)",
      "function balanceOf(address owner) view returns (uint256)",
      "function totalSupply() view returns (uint256)",
    ],
    easyStakingAddr,
  )) as any;

  let systemBefore = await readSystemStats(reward.rewardView, ctx.relayer);
  let topEarnersBefore = await readTopEarners(reward.rewardView, ctx.relayer);
  const spendBefore = await tryReadSpendStats(reward, ctx.relayer);

  for (let index = 0; index < borrowerCount; index += 1) {
    await assignFreshBorrower(ctx, { noticeLabel: `using fresh reward-stress borrower #${index + 1}` });
    await fundFundsFlowActors(ctx, {
      borrowerBorrowAmount: ctx.totalDue,
      borrowerCollateralAmount: ctx.collateralAmount,
      lenderBorrowAmount: ctx.borrowAmount,
    });

    const beforeBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);

    await depositCollateral(ctx, ctx.collateralAmount);
    const reserve = await reserveForLending(ctx);
    const finalized = await finalizeSingleMatch(ctx, reserve);
    const repayReceipt = await repayOrder(ctx, finalized.orderId, ctx.totalDue);

    const repayPushes = decodeRewardViewPushes(reward, repayReceipt);
    const repayMintOutcome = inspectEasyMintRepayOutcome(reward, repayReceipt, {
      rewardViewPushes: repayPushes,
      acceptedSkipReasons: DEFAULT_ACCEPTED_EASY_MINT_SKIP_REASONS,
    });
    const mintedPush = requireEasyMintedOrAcceptedSkip(
      repayMintOutcome,
      `reward stress borrower #${index + 1} repay did not produce mint-or-accepted-skip`,
    );
    if (!mintedPush) {
      const reason = repayMintOutcome.skipReason ?? "missing-push";
      console.log(`  [Notice] borrower #${index + 1} repay accepted skip RewardView DataPushed(EASY_MINTED); reason=${reason}`);
    }

    const borrowerAfterRepay = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
    if (!borrowerAfterRepay.summaryValid || !borrowerAfterRepay.easyEarnedValid || !borrowerAfterRepay.activityValid) {
      throw new Error(`reward view should be valid after repay for borrower #${index + 1}`);
    }
    if (borrowerAfterRepay.easyEarned < beforeBorrower.easyEarned) {
      throw new Error(`easyEarned regressed after repay for borrower #${index + 1}`);
    }

    let consumeLabel = "skipped";
    let borrowerAfterConsume = borrowerAfterRepay;
    if (mintedPush) {
      const consumeAmount = 10n ** 18n;
      await ensureBorrowerEasyForConsume({
        reward,
        borrower: ctx.borrower,
        relayer: ctx.relayer,
        lender: ctx.lender,
        viewer: ctx.viewer,
        minAmount: consumeAmount,
        borrowerIndex: index,
      });

      const allowanceToConsume = (await reward.easyToken.allowance(ctx.borrower.address, reward.easyConsumptionAddr)) as bigint;

      if (allowanceToConsume < consumeAmount) {
        await ensureTokenAllowance(reward.easyToken, ctx.borrower, reward.easyConsumptionAddr, consumeAmount, "EasyToken -> EasyConsumption");
      }

      const consumeCandidates = index % 2 === 0
        ? [
            {
              label: "EasiMCall",
              staticCall: () => reward.easyConsumption.connect(ctx.borrower).consumeEasiMCall.staticCall(ctx.borrower.address),
              send: () => reward.easyConsumption.connect(ctx.borrower).consumeEasiMCall(ctx.borrower.address),
            },
            {
              label: "StrategyApiCall",
              staticCall: () => reward.easyConsumption.connect(ctx.borrower).consumeStrategyApiCall.staticCall(ctx.borrower.address),
              send: () => reward.easyConsumption.connect(ctx.borrower).consumeStrategyApiCall(ctx.borrower.address),
            },
          ]
        : [
            {
              label: "StrategyApiCall",
              staticCall: () => reward.easyConsumption.connect(ctx.borrower).consumeStrategyApiCall.staticCall(ctx.borrower.address),
              send: () => reward.easyConsumption.connect(ctx.borrower).consumeStrategyApiCall(ctx.borrower.address),
            },
            {
              label: "EasiMCall",
              staticCall: () => reward.easyConsumption.connect(ctx.borrower).consumeEasiMCall.staticCall(ctx.borrower.address),
              send: () => reward.easyConsumption.connect(ctx.borrower).consumeEasiMCall(ctx.borrower.address),
            },
          ];

      let consumeReceipt: any | null = null;
      const consumeErrors: string[] = [];
      for (const candidate of consumeCandidates) {
        try {
          await candidate.staticCall();
        } catch (error: any) {
          consumeErrors.push(`${candidate.label} staticCall: ${explainRevert(error, [reward.easyConsumption.interface, reward.easyRecycleDistributor.interface, reward.easyToken.interface])}`);
          continue;
        }

        try {
          consumeReceipt = await (await candidate.send()).wait();
          consumeLabel = candidate.label;
          break;
        } catch (error: any) {
          consumeErrors.push(`${candidate.label} send: ${explainRevert(error, [reward.easyConsumption.interface, reward.easyRecycleDistributor.interface, reward.easyToken.interface])}`);
        }
      }

      if (!consumeReceipt) {
        throw new Error(`all consume paths failed for borrower #${index + 1}: ${consumeErrors.join(" | ")}`);
      }
      if (consumeLabel !== consumeCandidates[0]?.label) {
        console.log(`  [Notice] borrower #${index + 1} consume fallback ${consumeCandidates[0]?.label} -> ${consumeLabel}`);
      }

      const consumePushes = decodeRewardViewPushes(reward, consumeReceipt);
      requireRewardViewPush(consumePushes, "EASY_SPENT", "consume should emit RewardView DataPushed(EASY_SPENT)");
      requireRewardViewPush(consumePushes, "EASY_RECYCLED_SPLIT", "consume should emit RewardView DataPushed(EASY_RECYCLED_SPLIT)");

      borrowerAfterConsume = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
    } else {
      console.log(`  [Notice] borrower #${index + 1} skip consume/stake because repay skip is accepted by policy`);
    }
    if (!borrowerAfterConsume.summaryValid || !borrowerAfterConsume.easyEarnedValid || !borrowerAfterConsume.activityValid) {
      throw new Error(`reward view should be valid after repay/consume for borrower #${index + 1}`);
    }
    if (mintedPush) {
      if (borrowerAfterConsume.easyEarned <= beforeBorrower.easyEarned) {
        throw new Error(`easyEarned should increase for borrower #${index + 1} when EASY_MINTED push is present`);
      }
    } else if (borrowerAfterConsume.easyEarned < beforeBorrower.easyEarned) {
      throw new Error(`easyEarned regressed for borrower #${index + 1} without EASY_MINTED push`);
    }
    if (mintedPush && borrowerAfterConsume.easySpent <= beforeBorrower.easySpent) {
      throw new Error(`easySpent should increase for borrower #${index + 1}`);
    }

    const remainingEasy = (await reward.easyToken.balanceOf(ctx.borrower.address)) as bigint;
    if (mintedPush && remainingEasy > 0n) {
      const stakingAllowance = (await reward.easyToken.allowance(ctx.borrower.address, easyStakingAddr)) as bigint;
      if (stakingAllowance < remainingEasy) {
        await ensureTokenAllowance(reward.easyToken, ctx.borrower, easyStakingAddr, remainingEasy, "EasyToken->EasyStaking");
      }
      const stBefore = (await easyStaking.balanceOf(ctx.borrower.address)) as bigint;
      const totalSupplyBefore = (await easyStaking.totalSupply()) as bigint;
      await (await easyStaking.connect(ctx.borrower).stake(remainingEasy)).wait();
      const { easyAfterStake, stAfter, totalSupplyAfter } = await waitForObservedState(
        `reward stress borrower #${index + 1} post-stake`,
        async () => {
          const [easyAfterStake, stAfter, totalSupplyAfter] = await Promise.all([
            reward.easyToken.balanceOf(ctx.borrower.address),
            easyStaking.balanceOf(ctx.borrower.address),
            easyStaking.totalSupply(),
          ]);
          return {
            easyAfterStake: BigInt(easyAfterStake),
            stAfter: BigInt(stAfter),
            totalSupplyAfter: BigInt(totalSupplyAfter),
          };
        },
        (state) =>
          state.easyAfterStake < remainingEasy
          && (state.totalSupplyAfter > totalSupplyBefore || state.stAfter > stBefore),
      );
      if (easyAfterStake >= remainingEasy) {
        throw new Error(`EasyToken balance should decrease after staking for borrower #${index + 1}`);
      }
      if (totalSupplyAfter <= totalSupplyBefore && stAfter <= stBefore) {
        console.log(`  [Notice] borrower #${index + 1} EasyStaking readback did not advance; accepting EASY spend as runtime proof`);
      } else if (stAfter <= stBefore) {
        console.log(`  [Notice] borrower #${index + 1} EasyStaking balance did not advance on readback; accepting totalSupply growth as runtime proof`);
      }
    } else if (mintedPush) {
      console.log(`  [Notice] borrower #${index + 1} has no EASY remaining after consume; staking step skipped`);
    }

    const systemAfter = await readSystemStats(reward.rewardView, ctx.relayer);
    const topEarnersAfter = await readTopEarners(reward.rewardView, ctx.relayer);
    if (!systemAfter.isValid) {
      throw new Error("RewardView system stats should remain valid during multi-borrower stress");
    }
    if (systemAfter.totalBatchOps < systemBefore.totalBatchOps) {
      throw new Error("RewardView totalBatchOps regressed during multi-borrower stress");
    }
    if (systemAfter.totalCachedRewards < systemBefore.totalCachedRewards) {
      throw new Error("RewardView totalCachedRewards regressed during multi-borrower stress");
    }
    if (topEarnersAfter.users.length !== topEarnersAfter.amounts.length) {
      throw new Error("RewardView top earners users/amounts length mismatch during stress");
    }
    if (topEarnersAfter.blockNumber < topEarnersBefore.blockNumber) {
      throw new Error("RewardView top earners block regressed during stress");
    }

    systemBefore = systemAfter;
    topEarnersBefore = topEarnersAfter;

    console.log(
      `  [RewardStress] borrower#${index + 1} orderId=${finalized.orderId.toString()} consume=${consumeLabel} easyEarned=${beforeBorrower.easyEarned.toString()}->${borrowerAfterConsume.easyEarned.toString()} easySpent=${beforeBorrower.easySpent.toString()}->${borrowerAfterConsume.easySpent.toString()} staked=${remainingEasy.toString()}`,
    );
  }

  const spendAfter = await tryReadSpendStats(reward, ctx.relayer);
  if (spendBefore && spendAfter && spendAfter.totalSpent < spendBefore.totalSpent) {
    throw new Error("RewardView totalSpent regressed after multi-borrower stress");
  }

  console.log(`  [RewardStressSummary] borrowers=${borrowerCount} totalBatchOps=${systemBefore.totalBatchOps.toString()} totalCachedRewards=${systemBefore.totalCachedRewards.toString()}`);
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
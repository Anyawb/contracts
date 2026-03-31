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
} from "./_fundsFlowLive";
import {
  decodeRewardViewPushes,
  loadRewardModules,
  readRewardUser,
  requireRewardViewPush,
  tryReadSpendStats,
} from "./_rewardLive";
import { key } from "./_mockLiveUtils";
import { runWithNetworkRetry } from "./_networkRetry";

function envInt(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
    requireRewardViewPush(repayPushes, "EASY_MINTED", "repay should emit RewardView DataPushed(EASY_MINTED)");

    const allowanceToConsume = (await reward.easyToken.allowance(ctx.borrower.address, reward.easyConsumptionAddr)) as bigint;
    const consumeAmount = 10n ** 18n;
    if (allowanceToConsume < consumeAmount) {
      await (await reward.easyToken.connect(ctx.borrower).approve(reward.easyConsumptionAddr, ethers.MaxUint256)).wait();
    }

    const consumeReceipt = index % 2 === 0
      ? await (await reward.easyConsumption.connect(ctx.borrower).consumeEasiMCall(ctx.borrower.address)).wait()
      : await (await reward.easyConsumption.connect(ctx.borrower).consumeStrategyApiCall(ctx.borrower.address)).wait();

    const consumePushes = decodeRewardViewPushes(reward, consumeReceipt);
    requireRewardViewPush(consumePushes, "EASY_SPENT", "consume should emit RewardView DataPushed(EASY_SPENT)");
    requireRewardViewPush(consumePushes, "EASY_RECYCLED_SPLIT", "consume should emit RewardView DataPushed(EASY_RECYCLED_SPLIT)");

    const borrowerAfterConsume = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
    if (!borrowerAfterConsume.summaryValid || !borrowerAfterConsume.easyEarnedValid || !borrowerAfterConsume.activityValid) {
      throw new Error(`reward view should be valid after repay/consume for borrower #${index + 1}`);
    }
    if (borrowerAfterConsume.easyEarned <= beforeBorrower.easyEarned) {
      throw new Error(`easyEarned should increase for borrower #${index + 1}`);
    }
    if (borrowerAfterConsume.easySpent <= beforeBorrower.easySpent) {
      throw new Error(`easySpent should increase for borrower #${index + 1}`);
    }

    const remainingEasy = (await reward.easyToken.balanceOf(ctx.borrower.address)) as bigint;
    if (remainingEasy <= 0n) {
      throw new Error(`borrower #${index + 1} has no EASY remaining to stake after consume`);
    }

    const stakingAllowance = (await reward.easyToken.allowance(ctx.borrower.address, easyStakingAddr)) as bigint;
    if (stakingAllowance < remainingEasy) {
      await ensureTokenAllowance(reward.easyToken, ctx.borrower, easyStakingAddr, remainingEasy, "EasyToken->EasyStaking");
    }
    const stBefore = (await easyStaking.balanceOf(ctx.borrower.address)) as bigint;
    const totalSupplyBefore = (await easyStaking.totalSupply()) as bigint;
    await (await easyStaking.connect(ctx.borrower).stake(remainingEasy)).wait();
    const stAfter = (await easyStaking.balanceOf(ctx.borrower.address)) as bigint;
    const totalSupplyAfter = (await easyStaking.totalSupply()) as bigint;
    if (stAfter <= stBefore) {
      throw new Error(`EasyStaking balance should increase for borrower #${index + 1}`);
    }
    if (totalSupplyAfter <= totalSupplyBefore) {
      throw new Error(`EasyStaking totalSupply should increase for borrower #${index + 1}`);
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
      `  [RewardStress] borrower#${index + 1} orderId=${finalized.orderId.toString()} easyEarned=${beforeBorrower.easyEarned.toString()}->${borrowerAfterConsume.easyEarned.toString()} easySpent=${beforeBorrower.easySpent.toString()}->${borrowerAfterConsume.easySpent.toString()} staked=${remainingEasy.toString()}`,
    );
  }

  const spendAfter = await tryReadSpendStats(reward, ctx.relayer);
  if (spendBefore && spendAfter && spendAfter.totalSpent < spendBefore.totalSpent) {
    throw new Error("RewardView totalSpent regressed after multi-borrower stress");
  }

  console.log(`  [RewardStressSummary] borrowers=${borrowerCount} totalBatchOps=${systemBefore.totalBatchOps.toString()} totalCachedRewards=${systemBefore.totalCachedRewards.toString()}`);
  console.log("\n✅ live-reward-multi-borrower-stress-arbitrum-sepolia PASSED\n");
}

void runWithNetworkRetry("live-reward-multi-borrower-stress-arbitrum-sepolia", main);
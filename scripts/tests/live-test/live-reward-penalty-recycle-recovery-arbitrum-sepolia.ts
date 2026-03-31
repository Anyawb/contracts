import { ethers } from "hardhat";

import {
  assignFreshBorrower,
  depositCollateral,
  ensureTokenAllowance,
  finalizeSingleMatch,
  fundFundsFlowActors,
  repayOrder,
  reserveForLending,
} from "./_fundsFlowLive";
import {
  bootstrapRewardLiveTest,
  decodeRewardViewPushes,
  findRewardViewPush,
  readRewardUser,
  requireRewardViewPush,
  tryReadSpendStats,
} from "./_rewardLive";
import { explainRevert, key } from "./_mockLiveUtils";
import { runWithNetworkRetry } from "./_networkRetry";

const ACCESS_CONTROL_ERROR_INTERFACE = new ethers.Interface([
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
]);
const STANDARD_ERROR_INTERFACE = new ethers.Interface([
  "error MissingRole()",
]);

function withGasBuffer(estimate: bigint, multiplierBps = 12_000n) {
  return (estimate * multiplierBps) / 10_000n + 50_000n;
}

function decodeAddressTriplet(payload: string) {
  return ethers.AbiCoder.defaultAbiCoder().decode(["address", "uint256", "uint256"], payload) as [string, bigint, bigint];
}

async function runPenaltyRetryBranch() {
  const { ctx, reward } = await bootstrapRewardLiveTest({
    label: "Live Reward Penalty Retry",
    noticeLabel: "using fresh reward-penalty borrower",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "500",
  });

  if (!ctx.gfm || !ctx.ergm) {
    throw new Error("reward penalty retry live requires guarantee modules");
  }

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const lendingEngine = (await ethers.getContractAt(
    ["function getDebt(address user,address asset) view returns (uint256)"],
    lendingEngineAddr,
  )) as any;
  const settlementManager = (await ethers.getContractAt(
    ["function settleOrLiquidate(uint256 orderId)"],
    ctx.settlementManagerAddr,
    ctx.relayer,
  )) as any;
  const healthViewWriter = (await ethers.getContractAt(
    ["function pushRiskStatus(address user,uint256 healthFactorBps,uint256 minHFBps,bool undercollateralized,uint256 blockNumber)"],
    String(ctx.healthView.target),
    ctx.relayer,
  )) as any;
  const ergmAdmin = (await ethers.getContractAt(
    [
      "function setGuaranteeEnabled(address asset,bool enabled)",
      "function isGuaranteeEnabled(address asset) view returns (bool)",
    ],
    ctx.ergmAddr,
    ctx.relayer,
  )) as any;

  const before = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const wasEnabled = (await ergmAdmin.isGuaranteeEnabled(ctx.borrowAssetAddr)) as boolean;
  if (!wasEnabled) {
    await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, true)).wait();
  }

  try {
    if (ctx.interest > 0n) {
      await ensureTokenAllowance(ctx.borrowToken, ctx.borrower, ctx.guaranteeFundAddr, ctx.interest, "borrow asset -> GuaranteeFundManager");
    }

    await depositCollateral(ctx, ctx.collateralAmount);
    const reserve = await reserveForLending(ctx);
    const finalized = await finalizeSingleMatch(ctx, reserve);

    const debtBefore = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
    if (debtBefore === 0n) {
      throw new Error("reward penalty retry live requires non-zero debt before liquidation");
    }

    await healthViewWriter.connect(ctx.relayer).pushRiskStatus.staticCall(ctx.borrower.address, 0n, 10_000n, true, 0n);
    const riskGas = withGasBuffer(
      await healthViewWriter.connect(ctx.relayer).pushRiskStatus.estimateGas(ctx.borrower.address, 0n, 10_000n, true, 0n),
    );
    await (
      await healthViewWriter.connect(ctx.relayer).pushRiskStatus(ctx.borrower.address, 0n, 10_000n, true, 0n, {
        gasLimit: riskGas,
      })
    ).wait();

    await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(finalized.orderId);
    const liquidationGas = withGasBuffer(
      await settlementManager.connect(ctx.relayer).settleOrLiquidate.estimateGas(finalized.orderId),
      13_000n,
    );
    const liquidationReceipt = await (
      await settlementManager.connect(ctx.relayer).settleOrLiquidate(finalized.orderId, {
        gasLimit: liquidationGas,
      })
    ).wait();

    const afterPenalty = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
    if (afterPenalty.penaltyDebt <= 0n) {
      throw new Error(
        `expected outstanding penalty debt after guarantee-default liquidation, got ${afterPenalty.penaltyDebt.toString()}`,
      );
    }

    const liquidationPushes = decodeRewardViewPushes(reward, liquidationReceipt);
    if (!findRewardViewPush(liquidationPushes, "REWARD_PENALTY_LEDGER_UPDATED")) {
      throw new Error("liquidation receipt should emit RewardView DataPushed(REWARD_PENALTY_LEDGER_UPDATED)");
    }

    let retryVerified = false;
    const retryBlock = BigInt(await ethers.provider.getBlockNumber());
    try {
      await reward.rewardView.connect(ctx.relayer).retryPushPenaltyLedger.staticCall(
        ctx.borrower.address,
        afterPenalty.penaltyDebt,
        retryBlock,
      );
      const retryReceipt = await (
        await reward.rewardView.connect(ctx.relayer).retryPushPenaltyLedger(
          ctx.borrower.address,
          afterPenalty.penaltyDebt,
          retryBlock,
        )
      ).wait();
      const retryPush = requireRewardViewPush(
        decodeRewardViewPushes(reward, retryReceipt),
        "REWARD_PENALTY_LEDGER_UPDATED",
        "retryPushPenaltyLedger should emit RewardView DataPushed(REWARD_PENALTY_LEDGER_UPDATED)",
      );
      const [pushedUser, pushedDebt] = decodeAddressTriplet(retryPush.payload);
      if (pushedUser.toLowerCase() !== ctx.borrower.address.toLowerCase()) {
        throw new Error("retryPushPenaltyLedger user mismatch");
      }
      if (pushedDebt !== afterPenalty.penaltyDebt) {
        throw new Error(
          `retryPushPenaltyLedger debt mismatch: pushed=${pushedDebt.toString()} current=${afterPenalty.penaltyDebt.toString()}`,
        );
      }
      retryVerified = true;
    } catch (error: any) {
      const decoded = explainRevert(error, [reward.rewardView.interface, STANDARD_ERROR_INTERFACE, ACCESS_CONTROL_ERROR_INTERFACE]);
      if (!/MissingRole|AccessControlUnauthorizedAccount/i.test(decoded)) {
        throw new Error(`retryPushPenaltyLedger failed: ${decoded}`);
      }
      console.log(`  [Notice] skip retryPushPenaltyLedger under current runtime roles: ${decoded}`);
    }

    console.log(
      `  [RewardPenaltyRetry] orderId=${finalized.orderId.toString()} pendingPenalty=${before.pendingPenalty.toString()}->${afterPenalty.pendingPenalty.toString()} penaltyDebt=${afterPenalty.penaltyDebt.toString()} retryVerified=${retryVerified}`,
    );
  } finally {
    if (!wasEnabled) {
      await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, false)).wait();
    }
  }
}

async function runRecycleRecoveryBranch() {
  const { ctx, reward } = await bootstrapRewardLiveTest({
    label: "Live Reward Recycle Recovery",
    noticeLabel: "using fresh reward-recycle borrower",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const beforeSpendStats = await tryReadSpendStats(reward, ctx.relayer);
  await depositCollateral(ctx, ctx.collateralAmount);
  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);
  await repayOrder(ctx, finalized.orderId, ctx.totalDue);

  const afterRepay = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  if (afterRepay.easyBalance <= 0n) {
    throw new Error("reward recycle recovery live requires positive EASY balance after repay");
  }

  const recoveryAmount = afterRepay.easyBalance >= 10n ** 18n ? 10n ** 18n : afterRepay.easyBalance;
  await (await reward.easyToken.connect(ctx.borrower).transfer(reward.easyRecycleDistributorAddr, recoveryAmount)).wait();
  const recycleBalanceBefore = (await reward.easyToken.balanceOf(reward.easyRecycleDistributorAddr)) as bigint;
  if (recycleBalanceBefore < recoveryAmount) {
    throw new Error("recycle distributor did not receive transferred EASY before recovery");
  }

  try {
    await reward.easyRecycleDistributor.connect(ctx.relayer).settleOutstandingEasyBalance.staticCall();
  } catch (error: any) {
    throw new Error(
      `settleOutstandingEasyBalance.staticCall failed: ${explainRevert(error, [reward.easyRecycleDistributor.interface, reward.easyToken.interface, ACCESS_CONTROL_ERROR_INTERFACE])}`,
    );
  }

  const recoveryReceipt = await (await reward.easyRecycleDistributor.connect(ctx.relayer).settleOutstandingEasyBalance()).wait();
  requireRewardViewPush(
    decodeRewardViewPushes(reward, recoveryReceipt),
    "EASY_RECYCLED_SPLIT",
    "settleOutstandingEasyBalance should emit RewardView DataPushed(EASY_RECYCLED_SPLIT)",
  );

  const recycleBalanceAfter = (await reward.easyToken.balanceOf(reward.easyRecycleDistributorAddr)) as bigint;
  if (recycleBalanceAfter >= recycleBalanceBefore) {
    throw new Error("recycle distributor EASY balance should decrease after recovery");
  }

  const afterSpendStats = await tryReadSpendStats(reward, ctx.relayer);
  if (beforeSpendStats && afterSpendStats && afterSpendStats.totalRecycled < beforeSpendStats.totalRecycled) {
    throw new Error("RewardView totalRecycled should not regress after recycle recovery");
  }

  console.log(
    `  [RewardRecycleRecovery] orderId=${finalized.orderId.toString()} transferred=${recoveryAmount.toString()} recycleBalance=${recycleBalanceBefore.toString()}->${recycleBalanceAfter.toString()}`,
  );
}

async function main() {
  await runPenaltyRetryBranch();
  await runRecycleRecoveryBranch();
  console.log("\n✅ live-reward-penalty-recycle-recovery-arbitrum-sepolia PASSED\n");
}

void runWithNetworkRetry("live-reward-penalty-recycle-recovery-arbitrum-sepolia", main);
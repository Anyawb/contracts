import { ethers } from "hardhat";

import {
  depositCollateral,
  ensureTokenAllowance,
  finalizeSingleMatch,
  repayOrder,
  reserveForLending,
} from "./_fundsFlowLive";
import { bootstrapRewardLiveTest } from "./_rewardLive";
import { key } from "./_mockLiveUtils";
import { runWithNetworkRetry } from "./_networkRetry";

async function expectRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
}

async function main() {
  const { ctx, reward } = await bootstrapRewardLiveTest({
    label: "Live EasyStaking",
    noticeLabel: "using fresh easy-staking borrower",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const easyStakingAddr = (await registry.getModuleOrRevert(key("EASY_STAKING"))) as string;
  const easyStaking = (await ethers.getContractAt(
    [
      "function stake(uint256 amount)",
      "function unstake(uint256 amount)",
      "function balanceOf(address owner) view returns (uint256)",
      "function totalSupply() view returns (uint256)",
      "function delegates(address owner) view returns (address)",
      "function transfer(address to,uint256 amount) returns (bool)",
      "function allowance(address owner,address spender) view returns (uint256)",
    ],
    easyStakingAddr,
  )) as any;

  let finalized: Awaited<ReturnType<typeof finalizeSingleMatch>> | null = null;
  try {
    await depositCollateral(ctx, ctx.collateralAmount);
    const reserve = await reserveForLending(ctx);
    finalized = await finalizeSingleMatch(ctx, reserve);
    await repayOrder(ctx, finalized.orderId, ctx.totalDue);

    const easyBalanceBefore = (await reward.easyToken.balanceOf(ctx.borrower.address)) as bigint;
    if (easyBalanceBefore <= 0n) {
      throw new Error("EasyStaking test requires borrower to have EASY after repay, but balance is zero");
    }

    const stakeAmount = easyBalanceBefore;
    await ensureTokenAllowance(reward.easyToken, ctx.borrower, easyStakingAddr, stakeAmount, "EasyToken->EasyStaking");

    const totalSupplyBefore = (await easyStaking.totalSupply()) as bigint;
    const stBalanceBefore = (await easyStaking.balanceOf(ctx.borrower.address)) as bigint;
    if (stBalanceBefore !== 0n) {
      throw new Error("EasyStaking borrower stEASY balance should start at zero for fresh borrower");
    }

    await (await easyStaking.connect(ctx.borrower).stake(stakeAmount)).wait();

    const [
      easyBalanceAfterStake,
      stBalanceAfterStake,
      totalSupplyAfterStake,
      delegateAfterStake,
    ] = await Promise.all([
      reward.easyToken.balanceOf(ctx.borrower.address),
      easyStaking.balanceOf(ctx.borrower.address),
      easyStaking.totalSupply(),
      easyStaking.delegates(ctx.borrower.address),
    ]);

    if (BigInt(easyBalanceAfterStake) !== 0n) {
      throw new Error("EasyStaking borrower EASY balance should be zero after staking all EASY");
    }
    if (BigInt(stBalanceAfterStake) !== stakeAmount) {
      throw new Error("EasyStaking stEASY balance mismatch after stake");
    }
    if (BigInt(totalSupplyAfterStake) !== totalSupplyBefore + stakeAmount) {
      throw new Error("EasyStaking totalSupply mismatch after stake");
    }
    if (String(delegateAfterStake).toLowerCase() !== ctx.borrower.address.toLowerCase()) {
      throw new Error("EasyStaking should self-delegate on first stake");
    }

    await expectRevert("EasyStaking transfer should revert because stEASY is non-transferable", async () =>
      easyStaking.connect(ctx.borrower).transfer.staticCall(ctx.relayer.address, stakeAmount),
    );

    await (await easyStaking.connect(ctx.borrower).unstake(stakeAmount)).wait();

    const [easyBalanceAfterUnstake, stBalanceAfterUnstake, totalSupplyAfterUnstake] = await Promise.all([
      reward.easyToken.balanceOf(ctx.borrower.address),
      easyStaking.balanceOf(ctx.borrower.address),
      easyStaking.totalSupply(),
    ]);

    if (BigInt(easyBalanceAfterUnstake) !== stakeAmount) {
      throw new Error("EasyStaking EASY balance mismatch after unstake");
    }
    if (BigInt(stBalanceAfterUnstake) !== 0n) {
      throw new Error("EasyStaking stEASY balance should return to zero after unstake");
    }
    if (BigInt(totalSupplyAfterUnstake) !== totalSupplyBefore) {
      throw new Error("EasyStaking totalSupply should return to original level after unstake");
    }

    console.log(
      `  [EasyStaking] easyMinted=${stakeAmount.toString()} staked=${stakeAmount.toString()} delegate=${String(delegateAfterStake)}`,
    );
    console.log("\n✅ live-easy-staking-arbitrum-sepolia PASSED\n");
  } finally {
    if (finalized) {
      try {
        await ctx.vaultCore.getAddress();
      } catch {
        // no-op guard to keep finally non-empty for lints
      }
    }
  }
}

void runWithNetworkRetry("live-easy-staking-arbitrum-sepolia", main);
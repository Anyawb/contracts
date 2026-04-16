import { ethers } from "hardhat";

import {
  depositCollateral,
  ensureTokenAllowance,
  finalizeSingleMatch,
  repayOrder,
  reserveForLending,
} from "../core/_fundsFlowLive";
import { bootstrapRewardLiveTest } from "../core/_rewardLive";
import { key } from "../core/_mockLiveUtils";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

async function expectRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
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

    const {
      easyBalanceAfterStake,
      stBalanceAfterStake,
      totalSupplyAfterStake,
      delegateAfterStake,
    } = await waitForObservedState(
      "EasyStaking post-stake",
      async () => {
        const [easyBalanceAfterStake, stBalanceAfterStake, totalSupplyAfterStake, delegateAfterStake] = await Promise.all([
          reward.easyToken.balanceOf(ctx.borrower.address),
          easyStaking.balanceOf(ctx.borrower.address),
          easyStaking.totalSupply(),
          easyStaking.delegates(ctx.borrower.address),
        ]);
        return {
          easyBalanceAfterStake: BigInt(easyBalanceAfterStake),
          stBalanceAfterStake: BigInt(stBalanceAfterStake),
          totalSupplyAfterStake: BigInt(totalSupplyAfterStake),
          delegateAfterStake: String(delegateAfterStake),
        };
      },
      (state) =>
        state.easyBalanceAfterStake === 0n
        && state.stBalanceAfterStake >= stakeAmount
        && state.totalSupplyAfterStake === totalSupplyBefore + stakeAmount
        && state.delegateAfterStake.toLowerCase() === ctx.borrower.address.toLowerCase(),
    );

    if (easyBalanceAfterStake !== 0n) {
      throw new Error("EasyStaking borrower EASY balance should be zero after staking all EASY");
    }
    if (stBalanceAfterStake < stakeAmount) {
      throw new Error(
        `EasyStaking stEASY balance did not reach staked amount: expectedAtLeast=${stakeAmount.toString()} actual=${stBalanceAfterStake.toString()}`,
      );
    }
    if (totalSupplyAfterStake !== totalSupplyBefore + stakeAmount) {
      throw new Error("EasyStaking totalSupply mismatch after stake");
    }
    if (delegateAfterStake.toLowerCase() !== ctx.borrower.address.toLowerCase()) {
      throw new Error("EasyStaking should self-delegate on first stake");
    }

    await expectRevert("EasyStaking transfer should revert because stEASY is non-transferable", async () =>
      easyStaking.connect(ctx.borrower).transfer.staticCall(ctx.relayer.address, stakeAmount),
    );

    await (await easyStaking.connect(ctx.borrower).unstake(stakeAmount)).wait();

    const { easyBalanceAfterUnstake, stBalanceAfterUnstake, totalSupplyAfterUnstake } = await waitForObservedState(
      "EasyStaking post-unstake",
      async () => {
        const [easyBalanceAfterUnstake, stBalanceAfterUnstake, totalSupplyAfterUnstake] = await Promise.all([
          reward.easyToken.balanceOf(ctx.borrower.address),
          easyStaking.balanceOf(ctx.borrower.address),
          easyStaking.totalSupply(),
        ]);
        return {
          easyBalanceAfterUnstake: BigInt(easyBalanceAfterUnstake),
          stBalanceAfterUnstake: BigInt(stBalanceAfterUnstake),
          totalSupplyAfterUnstake: BigInt(totalSupplyAfterUnstake),
        };
      },
      (state) =>
        state.easyBalanceAfterUnstake >= stakeAmount
        && state.stBalanceAfterUnstake === 0n
        && state.totalSupplyAfterUnstake === totalSupplyBefore,
    );

    if (easyBalanceAfterUnstake < stakeAmount) {
      throw new Error(
        `EasyStaking EASY balance did not recover unstaked amount: expectedAtLeast=${stakeAmount.toString()} actual=${easyBalanceAfterUnstake.toString()}`,
      );
    }
    if (stBalanceAfterUnstake !== 0n) {
      throw new Error("EasyStaking stEASY balance should return to zero after unstake");
    }
    if (totalSupplyAfterUnstake !== totalSupplyBefore) {
      throw new Error("EasyStaking totalSupply should return to original level after unstake");
    }

    console.log(
      `  [EasyStaking] easyMinted=${stakeAmount.toString()} staked=${stakeAmount.toString()} delegate=${String(delegateAfterStake)}`,
    );
    logLiveScriptSuccess(__filename);
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

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
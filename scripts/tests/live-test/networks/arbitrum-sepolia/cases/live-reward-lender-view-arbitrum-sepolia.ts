import {
  bootstrapRewardLiveTest,
  DEFAULT_ACCEPTED_EASY_MINT_SKIP_REASONS,
  decodeRewardViewPushes,
  inspectEasyMintRepayOutcome,
  readRewardUser,
  requireEasyMintedOrAcceptedSkip,
} from "../core/_rewardLive";
import { ethers } from "hardhat";
import { depositCollateral, finalizeSingleMatch, repayOrder, reserveForLending } from "../core/_fundsFlowLive";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

function expectTrue(condition: boolean, label: string) {
  if (!condition) {
    throw new Error(label);
  }
}

function expectGt(value: bigint, baseline: bigint, label: string) {
  if (value <= baseline) {
    throw new Error(`${label}: expected ${value.toString()} > ${baseline.toString()}`);
  }
}

function expectGte(value: bigint, baseline: bigint, label: string) {
  if (value < baseline) {
    throw new Error(`${label}: expected ${value.toString()} >= ${baseline.toString()}`);
  }
}

function expectEq(value: bigint, expected: bigint, label: string) {
  if (value !== expected) {
    throw new Error(`${label}: expected ${value.toString()} == ${expected.toString()}`);
  }
}

function expectBoolEq(value: boolean, expected: boolean, label: string) {
  if (value !== expected) {
    throw new Error(`${label}: expected ${String(value)} == ${String(expected)}`);
  }
}

async function selectRewardReader(
  reward: Awaited<ReturnType<typeof bootstrapRewardLiveTest>>["reward"],
  targetUser: string,
  candidates: Array<{ label: string; signer: any | null | undefined }>,
) {
  for (const candidate of candidates) {
    if (!candidate.signer) {
      continue;
    }
    try {
      await reward.rewardView.connect(candidate.signer).getUserRewardSummaryWithMeta(targetUser);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`no reward reader could access ${targetUser}`);
}

async function main() {
  const { ctx, reward } = await bootstrapRewardLiveTest({
    label: "Live Reward Lender View",
    noticeLabel: "using fresh reward-lender-view borrower",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const lenderVaultReader = await selectRewardReader(reward, ctx.lenderPoolVaultAddr, [
    { label: "relayer", signer: ctx.relayer },
    { label: "viewer", signer: ctx.viewer },
    { label: "updater", signer: ctx.updater },
    { label: "borrower", signer: ctx.borrower },
    { label: "lender", signer: ctx.lender },
  ]);

  const beforeBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const beforeLenderSigner = await readRewardUser(reward, ctx.lender, ctx.lender.address);
  const beforeLenderVault = await readRewardUser(reward, lenderVaultReader.signer, ctx.lenderPoolVaultAddr);

  await depositCollateral(ctx, ctx.collateralAmount);
  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);

  if (!ctx.lendingEngineView) {
    throw new Error("lendingEngineView is required for reward lender view live assertions");
  }
  const loanOrder = await ctx.lendingEngineView.connect(ctx.borrower).getLoanOrder(finalized.orderId);
  const runtimeLender = String(loanOrder.lender ?? loanOrder[4] ?? "");
  if (runtimeLender.toLowerCase() !== ctx.lenderPoolVaultAddr.toLowerCase()) {
    throw new Error(`loan order lender mismatch: expected ${ctx.lenderPoolVaultAddr} got ${runtimeLender}`);
  }

  const afterBorrowBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const afterBorrowLenderSigner = await readRewardUser(reward, ctx.lender, ctx.lender.address);
  const afterBorrowLenderVault = await readRewardUser(reward, lenderVaultReader.signer, ctx.lenderPoolVaultAddr);

  expectTrue(afterBorrowBorrower.summaryValid, "borrower reward summary should be valid after borrow");
  expectTrue(afterBorrowBorrower.easyEarnedValid, "borrower easyEarned should be valid after borrow");
  expectTrue(afterBorrowBorrower.activityValid, "borrower activity should be valid after borrow");

  expectGte(afterBorrowBorrower.summaryBlock, beforeBorrower.summaryBlock, "borrower summary block after borrow");
  expectGte(afterBorrowBorrower.easyEarnedBlock, beforeBorrower.easyEarnedBlock, "borrower easyEarned block after borrow");
  expectGte(afterBorrowBorrower.lastActivity, beforeBorrower.lastActivity, "borrower lastActivity after borrow");
  expectGte(afterBorrowBorrower.recentActivityCount, beforeBorrower.recentActivityCount, "borrower activity count after borrow");

  expectEq(afterBorrowLenderSigner.easyEarned, beforeLenderSigner.easyEarned, "lender signer easyEarned should not change after borrow");
  expectEq(afterBorrowLenderSigner.summaryBlock, beforeLenderSigner.summaryBlock, "lender signer summary block should not change after borrow");
  expectEq(afterBorrowLenderSigner.easyEarnedBlock, beforeLenderSigner.easyEarnedBlock, "lender signer easyEarned block should not change after borrow");
  expectEq(afterBorrowLenderSigner.lastActivity, beforeLenderSigner.lastActivity, "lender signer lastActivity should not change after borrow");
  expectEq(afterBorrowLenderSigner.recentActivityCount, beforeLenderSigner.recentActivityCount, "lender signer activity count should not change after borrow");
  expectBoolEq(afterBorrowLenderSigner.summaryValid, beforeLenderSigner.summaryValid, "lender signer summary validity should not change after borrow");
  expectBoolEq(afterBorrowLenderSigner.easyEarnedValid, beforeLenderSigner.easyEarnedValid, "lender signer easyEarned validity should not change after borrow");
  expectBoolEq(afterBorrowLenderSigner.activityValid, beforeLenderSigner.activityValid, "lender signer activity validity should not change after borrow");

  expectEq(afterBorrowLenderVault.easyEarned, beforeLenderVault.easyEarned, "lender vault easyEarned should not change before repay");
  expectEq(afterBorrowLenderVault.summaryBlock, beforeLenderVault.summaryBlock, "lender vault summary block should not change before repay");
  expectEq(afterBorrowLenderVault.easyEarnedBlock, beforeLenderVault.easyEarnedBlock, "lender vault easyEarned block should not change before repay");
  expectEq(afterBorrowLenderVault.lastActivity, beforeLenderVault.lastActivity, "lender vault lastActivity should not change before repay");
  expectEq(afterBorrowLenderVault.recentActivityCount, beforeLenderVault.recentActivityCount, "lender vault activity count should not change before repay");
  expectBoolEq(afterBorrowLenderVault.summaryValid, beforeLenderVault.summaryValid, "lender vault summary validity should not change before repay");
  expectBoolEq(afterBorrowLenderVault.easyEarnedValid, beforeLenderVault.easyEarnedValid, "lender vault easyEarned validity should not change before repay");
  expectBoolEq(afterBorrowLenderVault.activityValid, beforeLenderVault.activityValid, "lender vault activity validity should not change before repay");

  const repayReceipt = await repayOrder(ctx, finalized.orderId, ctx.totalDue);
  const repayPushes = decodeRewardViewPushes(reward, repayReceipt);
  const repayOutcome = inspectEasyMintRepayOutcome(reward, repayReceipt, {
    rewardViewPushes: repayPushes,
    acceptedSkipReasons: DEFAULT_ACCEPTED_EASY_MINT_SKIP_REASONS,
  });
  const easyMintPush = requireEasyMintedOrAcceptedSkip(repayOutcome, "repay reward mint path should mint or accepted-skip");
  if (repayOutcome.hasAcceptedSkip) {
    console.log(`  [Notice] repay reward mint accepted skip: ${repayOutcome.skipReason}`);
  }
  if (easyMintPush) {
    const [pushBorrower, pushLender, , borrowerShare, lenderShare, pushedOrderId] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
      easyMintPush.payload,
    ) as unknown as [string, string, bigint, bigint, bigint, bigint, bigint, bigint];
    if (pushBorrower.toLowerCase() !== ctx.borrower.address.toLowerCase()) {
      throw new Error(`EASY_MINTED borrower mismatch: expected ${ctx.borrower.address} got ${pushBorrower}`);
    }
    if (pushLender.toLowerCase() !== ctx.lenderPoolVaultAddr.toLowerCase()) {
      throw new Error(`EASY_MINTED lender mismatch: expected ${ctx.lenderPoolVaultAddr} got ${pushLender}`);
    }
    if (pushedOrderId !== finalized.orderId) {
      throw new Error(`EASY_MINTED orderId mismatch: expected ${finalized.orderId.toString()} got ${pushedOrderId.toString()}`);
    }
    expectGt(borrowerShare, 0n, "borrower share should be positive");
    expectGt(lenderShare, 0n, "lender share should be positive");
  }

  const afterRepayBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const afterRepayLenderSigner = await readRewardUser(reward, ctx.lender, ctx.lender.address);
  const afterRepayLenderVault = await readRewardUser(reward, lenderVaultReader.signer, ctx.lenderPoolVaultAddr);

  expectTrue(afterRepayBorrower.summaryValid, "borrower reward summary should be valid after repay");
  expectTrue(afterRepayBorrower.easyEarnedValid, "borrower easyEarned should be valid after repay");
  expectTrue(afterRepayBorrower.activityValid, "borrower activity should be valid after repay");
  if (easyMintPush) {
    expectTrue(afterRepayLenderVault.summaryValid, "lender vault reward summary should be valid after repay");
    expectTrue(afterRepayLenderVault.easyEarnedValid, "lender vault easyEarned should be valid after repay");
    expectTrue(afterRepayLenderVault.activityValid, "lender vault activity should be valid after repay");
  } else {
    expectBoolEq(afterRepayLenderVault.summaryValid, beforeLenderVault.summaryValid, "lender vault summary validity should remain unchanged on accepted skip");
    expectBoolEq(afterRepayLenderVault.easyEarnedValid, beforeLenderVault.easyEarnedValid, "lender vault easyEarned validity should remain unchanged on accepted skip");
    expectBoolEq(afterRepayLenderVault.activityValid, beforeLenderVault.activityValid, "lender vault activity validity should remain unchanged on accepted skip");
  }

  if (easyMintPush) {
    expectGt(afterRepayBorrower.easyEarned, beforeBorrower.easyEarned, "borrower easyEarned delta after repay");
    expectGt(afterRepayLenderVault.easyEarned, beforeLenderVault.easyEarned, "lender vault easyEarned delta after repay");
  } else {
    expectEq(afterRepayBorrower.easyEarned, beforeBorrower.easyEarned, "borrower easyEarned should remain unchanged on accepted skip");
    expectEq(afterRepayLenderVault.easyEarned, beforeLenderVault.easyEarned, "lender vault easyEarned should remain unchanged on accepted skip");
  }
  expectGte(afterRepayBorrower.summaryBlock, afterBorrowBorrower.summaryBlock, "borrower summary block after repay");
  if (easyMintPush) {
    expectGt(afterRepayLenderVault.summaryBlock, afterBorrowLenderVault.summaryBlock, "lender vault summary block after repay");
  } else {
    expectEq(afterRepayLenderVault.summaryBlock, afterBorrowLenderVault.summaryBlock, "lender vault summary block should remain unchanged on accepted skip");
  }
  expectGte(afterRepayBorrower.easyEarnedBlock, afterBorrowBorrower.easyEarnedBlock, "borrower easyEarned block after repay");
  if (easyMintPush) {
    expectGt(afterRepayLenderVault.easyEarnedBlock, afterBorrowLenderVault.easyEarnedBlock, "lender vault easyEarned block after repay");
  } else {
    expectEq(afterRepayLenderVault.easyEarnedBlock, afterBorrowLenderVault.easyEarnedBlock, "lender vault easyEarned block should remain unchanged on accepted skip");
  }
  expectGte(afterRepayBorrower.lastActivity, afterBorrowBorrower.lastActivity, "borrower lastActivity after repay");
  if (easyMintPush) {
    expectGt(afterRepayLenderVault.lastActivity, afterBorrowLenderVault.lastActivity, "lender vault lastActivity after repay");
  } else {
    expectEq(afterRepayLenderVault.lastActivity, afterBorrowLenderVault.lastActivity, "lender vault lastActivity should remain unchanged on accepted skip");
  }
  expectGte(afterRepayBorrower.recentActivityCount, afterBorrowBorrower.recentActivityCount, "borrower activity count after repay");
  if (easyMintPush) {
    expectGte(afterRepayLenderVault.recentActivityCount, afterBorrowLenderVault.recentActivityCount, "lender vault activity count after repay");
  } else {
    expectEq(afterRepayLenderVault.recentActivityCount, afterBorrowLenderVault.recentActivityCount, "lender vault activity count should remain unchanged on accepted skip");
  }

  expectEq(afterRepayLenderSigner.easyEarned, beforeLenderSigner.easyEarned, "lender signer easyEarned should remain unchanged after repay");
  expectEq(afterRepayLenderSigner.summaryBlock, beforeLenderSigner.summaryBlock, "lender signer summary block should remain unchanged after repay");
  expectEq(afterRepayLenderSigner.easyEarnedBlock, beforeLenderSigner.easyEarnedBlock, "lender signer easyEarned block should remain unchanged after repay");
  expectEq(afterRepayLenderSigner.lastActivity, beforeLenderSigner.lastActivity, "lender signer lastActivity should remain unchanged after repay");
  expectEq(afterRepayLenderSigner.recentActivityCount, beforeLenderSigner.recentActivityCount, "lender signer activity count should remain unchanged after repay");

  console.log(
    `  [RewardLenderView] orderId=${finalized.orderId.toString()} runtimeLender=${runtimeLender} lenderVaultReader=${lenderVaultReader.label}:${lenderVaultReader.signer.address} borrowerEasy=${beforeBorrower.easyEarned.toString()}->${afterRepayBorrower.easyEarned.toString()} lenderVaultEasy=${beforeLenderVault.easyEarned.toString()}->${afterRepayLenderVault.easyEarned.toString()} lenderSignerEasy=${beforeLenderSigner.easyEarned.toString()}->${afterRepayLenderSigner.easyEarned.toString()} borrowerActivity=${beforeBorrower.recentActivityCount.toString()}->${afterRepayBorrower.recentActivityCount.toString()} lenderVaultActivity=${beforeLenderVault.recentActivityCount.toString()}->${afterRepayLenderVault.recentActivityCount.toString()}`,
  );
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
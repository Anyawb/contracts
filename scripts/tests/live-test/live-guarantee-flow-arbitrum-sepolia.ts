import { ethers } from "hardhat";

import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  expectEqual,
  finalizeSingleMatch,
  fundFundsFlowActors,
  getGuaranteeState,
  getTokenBalances,
  observeExtendedViews,
  repayOrder,
  reserveForLending,
  sumTokenBalances,
} from "./_fundsFlowLive";

function uniqAddresses(addresses: string[]) {
  return [...new Set(addresses.filter((address) => address && address !== ethers.ZeroAddress))];
}

function absDiff(a: bigint, b: bigint) {
  return a >= b ? a - b : b - a;
}

function expectWithinDelta(label: string, actual: bigint, expected: bigint, allowedDelta: bigint) {
  const diff = absDiff(actual, expected);
  if (diff > allowedDelta) {
    throw new Error(
      `${label}: expected=${expected.toString()} actual=${actual.toString()} diff=${diff.toString()} allowed=${allowedDelta.toString()}`,
    );
  }
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Guarantee Flow",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "500",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh guarantee borrower" });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  if (!ctx.gfm || !ctx.ergm) {
    throw new Error("guarantee modules are not registered in current environment");
  }

  const ergmAdmin = (await ethers.getContractAt(
    [
      "function setGuaranteeEnabled(address asset,bool enabled)",
      "function isGuaranteeEnabled(address asset) view returns (bool)",
      "function platformFeeReceiver() view returns (address)",
      "function previewEarlyRepayment(uint256 guaranteeId,uint256 actualRepayAmount) view returns ((uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid))",
    ],
    ctx.ergmAddr,
    ctx.relayer,
  )) as any;
  const platformFeeReceiver = (await ergmAdmin.platformFeeReceiver()) as string;
  const platformTreasury = (await ctx.feeRouter.getPlatformTreasury()) as string;
  const ecosystemVault = (await ctx.feeRouter.getEcosystemVault()) as string;

  await fundFundsFlowActors(ctx, {
    borrowerBorrowAmount: ctx.totalDue + ctx.interest,
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });

  const tracked = uniqAddresses([
    ctx.borrower.address,
    ctx.lender.address,
    ctx.guaranteeFundAddr,
    ctx.lenderPoolVaultAddr,
    ctx.vaultCoreAddr,
    ctx.orderEngineAddr,
    ctx.settlementManagerAddr,
    ctx.feeRouterAddr,
    platformTreasury,
    ecosystemVault,
    platformFeeReceiver,
  ]);

  const wasEnabled = (await ergmAdmin.isGuaranteeEnabled(ctx.borrowAssetAddr)) as boolean;
  if (!wasEnabled) {
    await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, true)).wait();
  }

  const beforeBalances = await getTokenBalances(ctx, ctx.borrowToken, tracked);
  const beforeGuarantee = await getGuaranteeState(ctx);
  const beforeViews = await observeExtendedViews(ctx, "before-guarantee-flow");

  if (ctx.interest > 0n) {
    await (await ctx.borrowToken.connect(ctx.borrower).approve(ctx.guaranteeFundAddr, ctx.interest)).wait();
  }
  await depositCollateral(ctx, ctx.collateralAmount);
  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);

  const afterFinalizeGuarantee = await getGuaranteeState(ctx);
  const afterFinalizeViews = await observeExtendedViews(ctx, "after-guarantee-finalize");

  expectEqual(afterFinalizeGuarantee.locked, ctx.interest, "guarantee locked amount after finalize");
  if (!afterFinalizeGuarantee.enabled) {
    throw new Error("guarantee should be enabled after finalize flow");
  }
  if (!afterFinalizeGuarantee.active) {
    throw new Error("guarantee should be active after finalize flow");
  }
  if (afterFinalizeGuarantee.guaranteeId === 0n) {
    throw new Error("guaranteeId should be non-zero after finalize flow");
  }
  if (!afterFinalizeGuarantee.record) {
    throw new Error("guarantee record should exist after finalize flow");
  }
  expectEqual(afterFinalizeGuarantee.record.principal, ctx.borrowAmount, "guarantee principal");
  expectEqual(afterFinalizeGuarantee.record.promisedInterest, ctx.interest, "guarantee promised interest");
  if (afterFinalizeGuarantee.record.asset.toLowerCase() !== ctx.borrowAssetAddr.toLowerCase()) {
    throw new Error(`guarantee asset mismatch: expected ${ctx.borrowAssetAddr} got ${afterFinalizeGuarantee.record.asset}`);
  }

  const previewBlock = BigInt(await ethers.provider.getBlockNumber());
  const preview = (await ergmAdmin.previewEarlyRepayment(afterFinalizeGuarantee.guaranteeId, ctx.totalDue)) as any;
  const beforeFailedFee = (await ctx.orderEngine.getFailedFeeAmountForView(finalized.orderId)) as bigint;
  const repayReceipt = await repayOrder(ctx, finalized.orderId, ctx.totalDue);
  const afterRepayBalances = await getTokenBalances(ctx, ctx.borrowToken, tracked);
  const afterRepayGuarantee = await getGuaranteeState(ctx);
  const afterRepayViews = await observeExtendedViews(ctx, "after-guarantee-repay");
  const afterFailedFee = (await ctx.orderEngine.getFailedFeeAmountForView(finalized.orderId)) as bigint;

  expectEqual(sumTokenBalances(afterRepayBalances), sumTokenBalances(beforeBalances), "guarantee tracked token conservation");
  const failedFeeDelta = afterFailedFee - beforeFailedFee;
  const orderEngineBalanceDelta = afterRepayBalances.get(ctx.orderEngineAddr)! - beforeBalances.get(ctx.orderEngineAddr)!;
  expectEqual(orderEngineBalanceDelta, failedFeeDelta, "guarantee failed fee custody delta");
  expectEqual(afterRepayGuarantee.locked, 0n, "guarantee locked amount after repay");
  if (afterRepayGuarantee.active) {
    throw new Error("guarantee should be inactive after early repay");
  }

  const ergmIface = new ethers.Interface([
    "event EarlyRepaymentProcessed(uint256 indexed guaranteeId,address indexed borrower,address indexed lender,address asset,uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid,uint256 blockNumber)",
  ]);

  let sawEarlyRepayment = false;
  const previewPenaltyToLender = BigInt(preview.penaltyToLender ?? preview[0] ?? 0);
  const previewRefundToBorrower = BigInt(preview.refundToBorrower ?? preview[1] ?? 0);
  const previewPlatformFee = BigInt(preview.platformFee ?? preview[2] ?? 0);
  const previewActualInterestPaid = BigInt(preview.actualInterestPaid ?? preview[3] ?? 0);
  const totalBlocks = (() => {
    const record = afterFinalizeGuarantee.record;
    if (!record) {
      return 1n;
    }
    const blocks = record.maturityTime - record.startTime;
    return blocks > 0n ? blocks : 1n;
  })();
  const repayBlock = BigInt(repayReceipt.blockNumber ?? Number(previewBlock));
  const blockDrift = repayBlock > previewBlock ? repayBlock - previewBlock : 0n;
  const perBlockDelta = (ctx.interest + totalBlocks - 1n) / totalBlocks;
  const allowedPreviewDrift = perBlockDelta * (blockDrift + 1n);

  for (const log of repayReceipt.logs) {
    try {
      const parsed = ergmIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== "EarlyRepaymentProcessed") {
        continue;
      }
      sawEarlyRepayment = true;
      expectEqual(parsed.args.guaranteeId, afterFinalizeGuarantee.guaranteeId, "early repayment event guaranteeId");
      expectWithinDelta(
        "early repayment penaltyToLender",
        BigInt(parsed.args.penaltyToLender),
        previewPenaltyToLender,
        allowedPreviewDrift,
      );
      expectWithinDelta(
        "early repayment refundToBorrower",
        BigInt(parsed.args.refundToBorrower),
        previewRefundToBorrower,
        allowedPreviewDrift,
      );
      expectEqual(parsed.args.platformFee, previewPlatformFee, "early repayment platformFee");
      expectWithinDelta(
        "early repayment actualInterestPaid",
        BigInt(parsed.args.actualInterestPaid),
        previewActualInterestPaid,
        allowedPreviewDrift,
      );
    } catch {}
  }
  if (!sawEarlyRepayment) {
    throw new Error("missing EarlyRepaymentProcessed event");
  }

  if (afterRepayViews.feeRouterUser && beforeViews.feeRouterUser) {
    if (afterRepayViews.feeRouterUser.totalFeePaid < beforeViews.feeRouterUser.totalFeePaid) {
      throw new Error("FeeRouterView totalFeePaid should not decrease in guarantee flow");
    }
  }
  if (afterFinalizeViews.loanFlowUser && beforeViews.loanFlowUser) {
    if (afterFinalizeViews.loanFlowUser.borrowCount <= beforeViews.loanFlowUser.borrowCount) {
      throw new Error("LoanFlowView borrowCount should increase in guarantee flow");
    }
  }
  if (afterRepayViews.loanFlowUser && afterFinalizeViews.loanFlowUser) {
    if (afterRepayViews.loanFlowUser.repayCount <= afterFinalizeViews.loanFlowUser.repayCount) {
      throw new Error("LoanFlowView repayCount should increase after guarantee repay");
    }
  }

  if (!wasEnabled) {
    await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, false)).wait();
  }

  console.log("\n✅ live-guarantee-flow-arbitrum-sepolia PASSED\n");
}

main().catch((error) => {
  console.error("\n❌ live-guarantee-flow-arbitrum-sepolia FAILED\n");
  console.error(error);
  process.exit(1);
});
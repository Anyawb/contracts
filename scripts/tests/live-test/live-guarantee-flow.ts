import { ethers } from "hardhat";

import {
  AssetRuntimeConfig,
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  depositCollateralAsset,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  ensureTokenAllowance,
  expectEqual,
  finalizeSingleMatch,
  finalizeSingleMatchCustom,
  fundFundsFlowActors,
  getGuaranteeState,
  getTokenBalances,
  observeExtendedViews,
  repayOrder,
  repayOrderAsset,
  reserveForLending,
  reserveForLendingAsset,
  sumTokenBalances,
} from "./_fundsFlowLive";
import { calcInterest } from "./_mockLiveUtils";
import { runWithNetworkRetry } from "./_networkRetry";
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "./_scriptStatus";

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

const ERGM_EVENT_IFACE = new ethers.Interface([
  "event EarlyRepaymentProcessed(uint256 indexed guaranteeId,address indexed borrower,address indexed lender,address asset,uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid,uint256 blockNumber)",
]);

function totalDueFor(amount: bigint, rateBps: bigint, termDays: number) {
  return amount + calcInterest(amount, rateBps, BigInt(termDays) * 24n * 60n * 60n);
}

function hasParsedEvent(receipt: any, emitterAddr: string, eventName: string) {
  for (const log of receipt?.logs ?? []) {
    try {
      if (String(log.address ?? "").toLowerCase() !== emitterAddr.toLowerCase()) {
        continue;
      }
      const parsed = ERGM_EVENT_IFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === eventName) {
        return true;
      }
    } catch {
      // ignore unrelated logs
    }
  }
  return false;
}

async function getLedgerReaders(ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>) {
  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const lendingEngineAddr = (await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("LENDING_ENGINE")))) as string;
  const lendingEngine = (await ethers.getContractAt(
    ["function getDebt(address user,address asset) view returns (uint256)"],
    lendingEngineAddr,
  )) as any;
  const collateralManager = (await ethers.getContractAt(
    ["function getCollateral(address user,address asset) view returns (uint256)"],
    ctx.collateralManagerAddr,
  )) as any;
  return { lendingEngine, collateralManager };
}

function borrowAssetConfig(ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>): AssetRuntimeConfig {
  return {
    assetAddr: ctx.borrowAssetAddr,
    token: ctx.borrowToken,
    decimals: ctx.borrowDecimals,
    symbol: ctx.borrowSymbol,
  };
}

function collateralAssetConfig(ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>): AssetRuntimeConfig {
  return {
    assetAddr: ctx.collateralAssetAddr,
    token: ctx.collateralToken,
    decimals: ctx.collateralDecimals,
    symbol: ctx.collateralSymbol,
  };
}

async function runCrossAssetBoundaryBranch() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Guarantee Boundary Cross Asset",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "220",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh guarantee-boundary borrower (cross asset)" });
  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  if (!ctx.gfm || !ctx.ergm) {
    throw new Error("guarantee modules are not registered in current environment");
  }

  const ergmAdmin = (await ethers.getContractAt(
    [
      "function setGuaranteeEnabled(address asset,bool enabled)",
      "function isGuaranteeEnabled(address asset) view returns (bool)",
    ],
    ctx.ergmAddr,
    ctx.relayer,
  )) as any;
  const { lendingEngine, collateralManager } = await getLedgerReaders(ctx);
  const borrowAsset = borrowAssetConfig(ctx);
  const altAsset = collateralAssetConfig(ctx);
  const guaranteedPrincipal = ethers.parseUnits("220", borrowAsset.decimals);
  const altPrincipal = ethers.parseUnits("2", altAsset.decimals);
  const totalCollateral = ctx.collateralAmount * 2n;
  const previousBorrowEnabled = (await ergmAdmin.isGuaranteeEnabled(borrowAsset.assetAddr)) as boolean;
  const previousAltEnabled = (await ergmAdmin.isGuaranteeEnabled(altAsset.assetAddr)) as boolean;

  try {
    if (!previousBorrowEnabled) {
      await (await ergmAdmin.setGuaranteeEnabled(borrowAsset.assetAddr, true)).wait();
    }
    if (previousAltEnabled) {
      await (await ergmAdmin.setGuaranteeEnabled(altAsset.assetAddr, false)).wait();
    }

    await fundFundsFlowActors(ctx, {
      borrowerBorrowAmount: totalDueFor(guaranteedPrincipal, ctx.rateBps, ctx.termDays),
      borrowerCollateralAmount: totalCollateral + altPrincipal,
      lenderBorrowAmount: guaranteedPrincipal,
    });
    await (await altAsset.token.connect(ctx.relayer).transfer(ctx.lender.address, altPrincipal)).wait();

    await depositCollateralAsset(ctx, {
      ...altAsset,
      amount: totalCollateral,
    });

    const guaranteedReserve = await reserveForLendingAsset(ctx, {
      ...borrowAsset,
      amount: guaranteedPrincipal,
    });
    const guaranteedFinalize = await finalizeSingleMatchCustom(ctx, guaranteedReserve, {
      borrowAsset,
      collateralAsset: altAsset,
      borrowAmount: guaranteedPrincipal,
      collateralAmount: ctx.collateralAmount,
    });

    const guaranteeAfterFinalize = await waitForGuaranteeState({
      ctx,
      expectedLocked: calcInterest(guaranteedPrincipal, ctx.rateBps, BigInt(ctx.termDays) * 24n * 60n * 60n),
    });
    if (!guaranteeAfterFinalize.active) {
      throw new Error("cross-asset boundary: guarantee should be active after guaranteed finalize");
    }

    const altReserve = await reserveForLendingAsset(ctx, {
      ...altAsset,
      amount: altPrincipal,
    });
    const altFinalize = await finalizeSingleMatchCustom(ctx, altReserve, {
      borrowAsset: altAsset,
      collateralAsset: altAsset,
      borrowAmount: altPrincipal,
      collateralAmount: ctx.collateralAmount,
    });

    const collateralBefore = (await collateralManager.getCollateral(ctx.borrower.address, altAsset.assetAddr)) as bigint;
    const altDebtBefore = (await lendingEngine.getDebt(ctx.borrower.address, altAsset.assetAddr)) as bigint;
    if (altDebtBefore !== altPrincipal) {
      throw new Error(`cross-asset boundary: expected alt debt ${altPrincipal.toString()} got ${altDebtBefore.toString()}`);
    }

    const guaranteedDue = totalDueFor(guaranteedPrincipal, ctx.rateBps, ctx.termDays);
    const repayReceipt = await repayOrderAsset(ctx, {
      orderId: guaranteedFinalize.orderId,
      asset: borrowAsset,
      amount: guaranteedDue,
    });

    const borrowDebtAfter = (await lendingEngine.getDebt(ctx.borrower.address, borrowAsset.assetAddr)) as bigint;
    const altDebtAfter = (await lendingEngine.getDebt(ctx.borrower.address, altAsset.assetAddr)) as bigint;
    const collateralAfter = (await collateralManager.getCollateral(ctx.borrower.address, altAsset.assetAddr)) as bigint;
    const guaranteeAfterRepay = await getGuaranteeState(ctx, ctx.borrower.address, borrowAsset.assetAddr);

    if (!hasParsedEvent(repayReceipt, ctx.ergmAddr, "EarlyRepaymentProcessed")) {
      console.log("  [Notice] cross-asset boundary: EarlyRepaymentProcessed event not observed; relying on settled guarantee state here, event coverage stays in live-guarantee-events-datapush");
    }
    if (borrowDebtAfter !== 0n) {
      throw new Error(`cross-asset boundary: borrow asset debt should be cleared, got ${borrowDebtAfter.toString()}`);
    }
    if (altDebtAfter !== altDebtBefore) {
      throw new Error(`cross-asset boundary: alt debt changed unexpectedly ${altDebtAfter.toString()} != ${altDebtBefore.toString()}`);
    }
    if (collateralAfter !== collateralBefore) {
      throw new Error("cross-asset boundary: collateral should remain locked while another asset debt exists");
    }
    if (guaranteeAfterRepay.active || guaranteeAfterRepay.locked !== 0n) {
      throw new Error("cross-asset boundary: guarantee should settle once current order and current asset debt are cleared");
    }

    const altDue = totalDueFor(altPrincipal, ctx.rateBps, ctx.termDays);
    await repayOrderAsset(ctx, {
      orderId: altFinalize.orderId,
      asset: altAsset,
      amount: altDue,
    });

    console.log("  [GuaranteeBoundary.CrossAsset] guarantee settled while cross-asset debt remained, collateral stayed locked until total debt cleanup");
  } finally {
    if (!previousBorrowEnabled) {
      await (await ergmAdmin.setGuaranteeEnabled(borrowAsset.assetAddr, false)).wait();
    }
    if (previousAltEnabled) {
      await (await ergmAdmin.setGuaranteeEnabled(altAsset.assetAddr, true)).wait();
    }
  }
}

async function runSameAssetBoundaryBranch() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live Guarantee Boundary Same Asset",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "220",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh guarantee-boundary borrower (same asset)" });
  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  if (!ctx.gfm || !ctx.ergm) {
    throw new Error("guarantee modules are not registered in current environment");
  }

  const ergmAdmin = (await ethers.getContractAt(
    [
      "function setGuaranteeEnabled(address asset,bool enabled)",
      "function isGuaranteeEnabled(address asset) view returns (bool)",
    ],
    ctx.ergmAddr,
    ctx.relayer,
  )) as any;
  const { lendingEngine, collateralManager } = await getLedgerReaders(ctx);
  const borrowAsset = borrowAssetConfig(ctx);
  const collateralAsset = collateralAssetConfig(ctx);
  const plainPrincipal = ethers.parseUnits("180", borrowAsset.decimals);
  const guaranteedPrincipal = ethers.parseUnits("220", borrowAsset.decimals);
  const totalCollateral = ctx.collateralAmount * 2n;
  const previousEnabled = (await ergmAdmin.isGuaranteeEnabled(borrowAsset.assetAddr)) as boolean;

  try {
    if (previousEnabled) {
      await (await ergmAdmin.setGuaranteeEnabled(borrowAsset.assetAddr, false)).wait();
    }

    await fundFundsFlowActors(ctx, {
      borrowerBorrowAmount:
        totalDueFor(guaranteedPrincipal, ctx.rateBps, ctx.termDays)
        + totalDueFor(plainPrincipal, ctx.rateBps, ctx.termDays),
      borrowerCollateralAmount: totalCollateral,
      lenderBorrowAmount: plainPrincipal + guaranteedPrincipal,
    });
    await depositCollateral(ctx, totalCollateral);

    const plainReserve = await reserveForLendingAsset(ctx, {
      ...borrowAsset,
      amount: plainPrincipal,
    });
    const plainFinalize = await finalizeSingleMatchCustom(ctx, plainReserve, {
      borrowAsset,
      collateralAsset,
      borrowAmount: plainPrincipal,
      collateralAmount: ctx.collateralAmount,
    });

    await (await ergmAdmin.setGuaranteeEnabled(borrowAsset.assetAddr, true)).wait();
    const guaranteedReserve = await reserveForLendingAsset(ctx, {
      ...borrowAsset,
      amount: guaranteedPrincipal,
    });
    const guaranteedFinalize = await finalizeSingleMatchCustom(ctx, guaranteedReserve, {
      borrowAsset,
      collateralAsset,
      borrowAmount: guaranteedPrincipal,
      collateralAmount: ctx.collateralAmount,
    });

    const guaranteeAfterFinalize = await waitForGuaranteeState({
      ctx,
      expectedLocked: calcInterest(guaranteedPrincipal, ctx.rateBps, BigInt(ctx.termDays) * 24n * 60n * 60n),
    });
    const lockedBefore = guaranteeAfterFinalize.locked;
    const collateralBefore = (await collateralManager.getCollateral(ctx.borrower.address, collateralAsset.assetAddr)) as bigint;
    const debtBefore = (await lendingEngine.getDebt(ctx.borrower.address, borrowAsset.assetAddr)) as bigint;
    const expectedRemainingDebt = debtBefore - guaranteedPrincipal;

    const guaranteedDue = totalDueFor(guaranteedPrincipal, ctx.rateBps, ctx.termDays);
    const repayReceipt = await repayOrderAsset(ctx, {
      orderId: guaranteedFinalize.orderId,
      asset: borrowAsset,
      amount: guaranteedDue,
    });

    const debtAfter = (await lendingEngine.getDebt(ctx.borrower.address, borrowAsset.assetAddr)) as bigint;
    const collateralAfter = (await collateralManager.getCollateral(ctx.borrower.address, collateralAsset.assetAddr)) as bigint;
    const guaranteeAfterRepay = await getGuaranteeState(ctx, ctx.borrower.address, borrowAsset.assetAddr);

    if (hasParsedEvent(repayReceipt, ctx.ergmAddr, "EarlyRepaymentProcessed")) {
      throw new Error("same-asset boundary: guarantee should not settle while same-asset debt remains");
    }
    if (debtAfter !== expectedRemainingDebt) {
      throw new Error(`same-asset boundary: remaining debt mismatch ${debtAfter.toString()} != ${expectedRemainingDebt.toString()}`);
    }
    if (collateralAfter !== collateralBefore) {
      throw new Error("same-asset boundary: collateral should remain locked while same-asset debt remains");
    }
    if (!guaranteeAfterRepay.active || guaranteeAfterRepay.locked !== lockedBefore) {
      throw new Error("same-asset boundary: guarantee should remain active and custody should stay locked until debt asset is fully cleared");
    }

    const plainDue = totalDueFor(plainPrincipal, ctx.rateBps, ctx.termDays);
    await repayOrderAsset(ctx, {
      orderId: plainFinalize.orderId,
      asset: borrowAsset,
      amount: plainDue,
    });

    console.log("  [GuaranteeBoundary.SameAsset] guarantee stayed active while same-asset debt remained and released only after full asset clearance");
  } finally {
    if (!previousEnabled) {
      await (await ergmAdmin.setGuaranteeEnabled(borrowAsset.assetAddr, false)).wait();
    }
  }
}

async function waitForGuaranteeState(params: {
  ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>;
  expectedLocked: bigint;
  attempts?: number;
  delayMs?: number;
}) {
  let state = await getGuaranteeState(params.ctx);
  const attempts = Math.max(1, params.attempts ?? 6);
  const delayMs = Math.max(0, params.delayMs ?? 1200);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (state.locked >= params.expectedLocked && state.active && state.guaranteeId > 0n) {
      return state;
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    state = await getGuaranteeState(params.ctx);
  }

  return state;
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
    await ensureTokenAllowance(ctx.borrowToken, ctx.borrower, ctx.guaranteeFundAddr, ctx.interest, "borrow asset -> GuaranteeFundManager");
  }
  await depositCollateral(ctx, ctx.collateralAmount);
  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);

  const afterFinalizeGuarantee = await waitForGuaranteeState({
    ctx,
    expectedLocked: ctx.interest,
  });
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
  const repayBlock = BigInt(repayReceipt.blockNumber ?? previewBlock);
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

  await runCrossAssetBoundaryBranch();
  await runSameAssetBoundaryBranch();

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
import { ethers } from "hardhat";

import { envStr } from "../_addressResolver";
import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  finalizeSingleMatch,
  fundFundsFlowActors,
  repayOrder,
  reserveForLending,
} from "./_fundsFlowLive";
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

async function sweepEphemeralNativeBackToRelayer(params: {
  borrower: any;
  relayer: any;
}) {
  if (String(params.borrower.address).toLowerCase() === String(params.relayer.address).toLowerCase()) {
    return;
  }

  const balance = await ethers.provider.getBalance(params.borrower.address);
  const feeData = await ethers.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 50_000_000n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 10_000_000n;
  const gasLimit = 21_000n;
  const txCost = gasLimit * maxFeePerGas;
  if (balance <= txCost) {
    console.log(`  [NativeSweep] skipped: borrower balance=${ethers.formatEther(balance)} ETH is not enough to cover gas`);
    return;
  }

  const value = balance - txCost;
  const tx = await params.borrower.sendTransaction({
    to: params.relayer.address,
    value,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  await tx.wait();
  console.log(`  [NativeSweep] returned ${ethers.formatEther(value)} ETH -> ${params.relayer.address}`);
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live LendingEngineView",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const hasFreshBorrowerRecovery = Boolean(
    envStr("LIVE_FRESH_BORROWER_MNEMONIC")?.trim() || envStr("LIVE_FRESH_BORROWER_PHRASE")?.trim(),
  ) && Boolean(envStr("LIVE_FRESH_BORROWER_STATE_FILE")?.trim());
  await assignFreshBorrower(ctx, { noticeLabel: "using fresh lending-engine-view borrower" });
  const needsInlineNativeSweep = !hasFreshBorrowerRecovery;
  if (needsInlineNativeSweep) {
    console.log("  [Notice] fresh borrower recovery is not configured; this script will sweep remaining native ETH back to relayer in finally");
  }

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);
  await fundFundsFlowActors(ctx, {
    borrowerBorrowAmount: ctx.totalDue,
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });

  if (!ctx.lendingEngineView || !ctx.lendingEngineViewAddr || ctx.lendingEngineViewAddr === ethers.ZeroAddress) {
    throw new Error("LendingEngineView is not deployed or not registered");
  }

  const registryAddr = await ctx.lendingEngineView.getRegistry() as string;
  if (registryAddr.toLowerCase() !== ctx.registryAddr.toLowerCase()) {
    throw new Error(`LendingEngineView registry mismatch: expected ${ctx.registryAddr} got ${registryAddr}`);
  }

  let finalized: Awaited<ReturnType<typeof finalizeSingleMatch>> | null = null;
  try {
    await depositCollateral(ctx, ctx.collateralAmount);
    const reserve = await reserveForLending(ctx);
    finalized = await finalizeSingleMatch(ctx, reserve);

    const orderId = finalized.orderId;
    const acmOwner = await ctx.acm.owner() as string;
    const ownerReader = new ethers.VoidSigner(acmOwner, ethers.provider);
    const [borrowerOrder, adminOrder] = await Promise.all([
      ctx.lendingEngineView.connect(ctx.borrower).getLoanOrder(orderId),
      ctx.lendingEngineView.connect(ownerReader).getLoanOrder(orderId),
    ]);

    if (BigInt(borrowerOrder.principal ?? borrowerOrder[0] ?? 0) !== ctx.borrowAmount) {
      throw new Error("LendingEngineView borrower order principal mismatch");
    }
    if (String(borrowerOrder.borrower ?? borrowerOrder[3] ?? "").toLowerCase() !== ctx.borrower.address.toLowerCase()) {
      throw new Error("LendingEngineView borrower address mismatch");
    }
    if (String(borrowerOrder.lender ?? borrowerOrder[4] ?? "").toLowerCase() !== ctx.lenderPoolVaultAddr.toLowerCase()) {
      throw new Error("LendingEngineView lender should resolve to LenderPoolVault");
    }
    if (BigInt(adminOrder.principal ?? adminOrder[0] ?? 0) !== BigInt(borrowerOrder.principal ?? borrowerOrder[0] ?? 0)) {
      throw new Error("LendingEngineView admin read mismatch vs borrower read");
    }

    const outsider = new ethers.VoidSigner(ethers.Wallet.createRandom().address, ethers.provider);
    await expectRevert("LendingEngineView outsider getLoanOrder should revert", async () =>
      ctx.lendingEngineView.connect(outsider).getLoanOrder(orderId),
    );
    const outsiderAccess = await ctx.lendingEngineView.connect(outsider).canAccessLoanOrder(orderId, outsider.address);
    if (Boolean(outsiderAccess[0])) {
      throw new Error("LendingEngineView outsider self-check should report no access");
    }

    const [borrowerAccess, lenderPoolAccess] = await Promise.all([
      ctx.lendingEngineView.connect(ctx.borrower).canAccessLoanOrder(orderId, ctx.borrower.address),
      ctx.lendingEngineView.connect(ownerReader).canAccessLoanOrder(orderId, ctx.lenderPoolVaultAddr),
    ]);
    if (!Boolean(borrowerAccess[0])) {
      throw new Error("LendingEngineView borrower should have access to own order");
    }
    if (!Boolean(lenderPoolAccess[0])) {
      throw new Error("LendingEngineView lender pool vault should have access to the matched order");
    }

    const [failedFeeAmount, nftRetryCount, engineRegistry, isMatchEngine, adminOrderCheck] = await Promise.all([
      ctx.lendingEngineView.connect(ownerReader).getFailedFeeAmount(orderId),
      ctx.lendingEngineView.connect(ownerReader).getNftRetryCount(orderId),
      ctx.lendingEngineView.connect(ownerReader).getRegistryFromEngine(),
      ctx.lendingEngineView.connect(ownerReader).isMatchEngine(ctx.vblAddr),
      ctx.lendingEngineView.connect(ownerReader).getLoanOrder(orderId),
    ]);

    if (BigInt(failedFeeAmount) < 0n) {
      throw new Error("LendingEngineView failed fee amount should not be negative");
    }
    if (BigInt(nftRetryCount) < 0n) {
      throw new Error("LendingEngineView NFT retry count should not be negative");
    }
    if (String(engineRegistry).toLowerCase() !== ctx.registryAddr.toLowerCase()) {
      throw new Error(`LendingEngineView engine registry mismatch: expected ${ctx.registryAddr} got ${String(engineRegistry)}`);
    }
    if (!Boolean(isMatchEngine)) {
      throw new Error(`LendingEngineView expected ${ctx.vblAddr} to be recognized as match engine`);
    }
    if (BigInt(adminOrderCheck.principal ?? adminOrderCheck[0] ?? 0) !== BigInt(borrowerOrder.principal ?? borrowerOrder[0] ?? 0)) {
      throw new Error("LendingEngineView admin read mismatch vs borrower read");
    }

    console.log(
      `  [OpsRead] failedFee=${BigInt(failedFeeAmount).toString()} nftRetry=${BigInt(nftRetryCount).toString()} isMatchEngine=${String(isMatchEngine)} lender=${String(adminOrderCheck.lender ?? adminOrderCheck[4] ?? "")}`,
    );

    console.log("\n✅ live-lending-engine-view-arbitrum-sepolia PASSED\n");
  } finally {
    if (finalized) {
      await repayOrder(ctx, finalized.orderId, ctx.totalDue);
    }
    if (needsInlineNativeSweep) {
      await sweepEphemeralNativeBackToRelayer({
        borrower: ctx.borrower,
        relayer: ctx.relayer,
      });
    }
  }
}

void runWithNetworkRetry("live-lending-engine-view-arbitrum-sepolia", main);
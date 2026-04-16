import { ethers, network } from "hardhat";

import {
  AssetRuntimeConfig,
  assignFreshBorrower,
  assignFreshLender,
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
  getOrderLifecycleStatus,
  getOrderForView,
  getOrderTotalDueForView,
  getTokenBalances,
  LOAN_STATUS,
  observeExtendedViews,
  repayOrder,
  repayOrderAsset,
  reserveForLending,
  reserveForLendingAsset,
  retryLoanFlowBorrowPush,
  retryLoanFlowRepayPush,
  sumTokenBalances,
} from "../core/_fundsFlowLive";
import { calcInterest, resolveBnbMinGasPriceWei } from "../core/_mockLiveUtils";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptFailure, logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveLiveAssertionAttempts() {
  const raw = process.env.LIVE_ASSERTION_RETRY_ATTEMPTS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
}

function resolveLiveAssertionDelayMs() {
  const raw = process.env.LIVE_ASSERTION_RETRY_DELAY_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1_200;
}

function resolveGuaranteeLoanFlowInitialWaitBlocks() {
  const raw = process.env.LIVE_GUARANTEE_LOAN_FLOW_INITIAL_WAIT_BLOCKS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
}

function resolveGuaranteeLoanFlowPostRetryWaitBlocks() {
  const raw = process.env.LIVE_GUARANTEE_LOAN_FLOW_POST_RETRY_WAIT_BLOCKS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
}

function resolveGuaranteeLoanFlowPollMs() {
  const raw = process.env.LIVE_GUARANTEE_LOAN_FLOW_POLL_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1_200;
}

function resolveGuaranteeLoanFlowBorrowInitialWaitBlocks() {
  const raw = process.env.LIVE_GUARANTEE_LOAN_FLOW_BORROW_INITIAL_WAIT_BLOCKS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
}

function resolveGuaranteeLoanFlowBorrowPostRetryWaitBlocks() {
  const raw = process.env.LIVE_GUARANTEE_LOAN_FLOW_BORROW_POST_RETRY_WAIT_BLOCKS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
}

function resolveGuaranteeBoundaryDebtWaitBlocks() {
  const raw = process.env.LIVE_GUARANTEE_BOUNDARY_DEBT_WAIT_BLOCKS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
}

function resolveGuaranteeFreshActorNativeEth() {
  return process.env.LIVE_GUARANTEE_FRESH_ACTOR_NATIVE_ETH?.trim() || "0.005";
}

async function ensureFreshActorNativeBudget(params: {
  ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>;
  actor: { address: string; sendTransaction: (tx: { to: string; value: bigint }) => Promise<any> };
  label: string;
  desiredWei: bigint;
}) {
  const initialBalance = await ethers.provider.getBalance(params.actor.address);
  if (initialBalance >= params.desiredWei) {
    return initialBalance;
  }

  const sponsorReserveWei = ethers.parseEther(process.env.LIVE_GUARANTEE_FRESH_ACTOR_SPONSOR_RESERVE_ETH?.trim() || "0.00005");
  let remaining: bigint = params.desiredWei - initialBalance;
  const seen = new Set<string>([params.actor.address.toLowerCase()]);

  const sponsors = [params.ctx.relayer, params.ctx.viewer, params.ctx.borrower, params.ctx.lender]
    .filter(Boolean)
    .filter((signer) => {
      const key = String(signer.address).toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

  for (const sponsor of sponsors) {
    if (remaining === 0n) {
      break;
    }
    try {
      const sponsorBalance = await ethers.provider.getBalance(sponsor.address);
      const affordable = sponsorBalance > sponsorReserveWei ? sponsorBalance - sponsorReserveWei : 0n;
      const topUp = BigInt(remaining > affordable ? affordable : remaining);
      if (topUp === 0n) {
        continue;
      }
      await (await sponsor.sendTransaction({ to: params.actor.address, value: topUp })).wait();
      remaining -= topUp;
    } catch {
      // Ignore unusable sponsors; final balance check below is authoritative.
    }
  }

  const finalBalance = await ethers.provider.getBalance(params.actor.address);
  const toleranceWei = ethers.parseEther(process.env.LIVE_GUARANTEE_FRESH_ACTOR_NATIVE_TOLERANCE_ETH?.trim() || "0.0001");
  if (finalBalance + toleranceWei < params.desiredWei) {
    throw new Error(
      `${params.label} native budget shortfall: have=${ethers.formatEther(finalBalance)} ETH required=${ethers.formatEther(params.desiredWei)} ETH`,
    );
  }
  if (finalBalance < params.desiredWei) {
    console.log(
      `  [Notice] ${params.label} native budget accepted within tolerance: have=${ethers.formatEther(finalBalance)} required=${ethers.formatEther(params.desiredWei)} tolerance=${ethers.formatEther(toleranceWei)} ETH`,
    );
  }
  return finalBalance;
}

async function resolveGuaranteeFreshActorNativeBudgetWei(label: string) {
  const configuredEth = resolveGuaranteeFreshActorNativeEth();
  const configuredWei = ethers.parseEther(configuredEth);

  const feeData = await ethers.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? resolveBnbMinGasPriceWei();
  const txBudget = Math.max(6, Number(process.env.LIVE_GUARANTEE_FRESH_ACTOR_TX_BUDGET?.trim() ?? "12"));
  const gasPerTx = BigInt(Math.max(100_000, Number(process.env.LIVE_GUARANTEE_FRESH_ACTOR_GAS_PER_TX?.trim() ?? "220000")));
  const estimatedWei = maxFeePerGas * gasPerTx * BigInt(txBudget) * 2n;
  const floorWei = ethers.parseEther(process.env.LIVE_GUARANTEE_FRESH_ACTOR_MIN_NATIVE_ETH?.trim() || "0.005");
  const desiredWei = configuredWei > estimatedWei ? configuredWei : estimatedWei;
  const budgetWei = desiredWei > floorWei ? desiredWei : floorWei;

  if (budgetWei > configuredWei) {
    console.log(
      `  [Preflight] ${label} fresh actor native budget raised from ${ethers.formatEther(configuredWei)} to ${ethers.formatEther(budgetWei)} ETH (gas estimate=${ethers.formatEther(estimatedWei)} ETH)`,
    );
  } else {
    console.log(`  [Preflight] ${label} fresh actor native budget=${ethers.formatEther(budgetWei)} ETH`);
  }

  return budgetWei;
}

function shouldSkipBoundaryBranches() {
  const raw = process.env.LIVE_GUARANTEE_SKIP_BOUNDARY_BRANCHES?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function shouldRelaxGlobalConservationAssertion() {
  return !["1", "true", "yes"].includes((process.env.LIVE_GUARANTEE_STRICT_GLOBAL_CONSERVATION ?? "").trim().toLowerCase());
}

function describeBalanceDrift(before: Map<string, bigint>, after: Map<string, bigint>) {
  const keys = uniqAddresses([...before.keys(), ...after.keys()]);
  return keys
    .map((address) => {
      const beforeValue = before.get(address) ?? 0n;
      const afterValue = after.get(address) ?? 0n;
      const delta = afterValue - beforeValue;
      return { address, delta };
    })
    .filter((entry) => entry.delta !== 0n)
    .map((entry) => `${entry.address}:${entry.delta.toString()}`)
    .join(", ");
}

async function waitForCondition(label: string, predicate: () => Promise<boolean>) {
  const attempts = resolveLiveAssertionAttempts();
  const delayMs = resolveLiveAssertionDelayMs();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await predicate()) {
      return true;
    }
    if (attempt < attempts && delayMs > 0) {
      await delay(delayMs);
    }
  }

  throw new Error(`${label} did not converge after ${attempts} attempts`);
}

async function waitForLoanFlowBorrowCountIncrease(
  ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>,
  previousBorrowCount: bigint,
) {
  let lastBorrowCount = previousBorrowCount;
  await waitForCondition("LoanFlowView borrowCount should increase in guarantee flow", async () => {
    const snapshot = await observeExtendedViews(ctx, "after-guarantee-finalize-convergence");
    const borrowCount = snapshot.loanFlowUser?.borrowCount;
    if (typeof borrowCount === "bigint") {
      lastBorrowCount = borrowCount;
      return borrowCount > previousBorrowCount;
    }
    return false;
  });
  return lastBorrowCount;
}

async function waitForLoanFlowRepayCountIncreaseByBlocks(params: {
  ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>;
  previousRepayCount: bigint;
  waitBlocks: number;
  observeLabel: string;
}) {
  const startBlock = await ethers.provider.getBlockNumber();
  const targetBlock = startBlock + Math.max(0, params.waitBlocks);
  const pollMs = resolveGuaranteeLoanFlowPollMs();
  let lastRepayCount = params.previousRepayCount;

  while (true) {
    const snapshot = await observeExtendedViews(params.ctx, params.observeLabel);
    const repayCount = snapshot.loanFlowUser?.repayCount;
    if (typeof repayCount === "bigint") {
      lastRepayCount = repayCount;
      if (repayCount > params.previousRepayCount) {
        return {
          converged: true,
          lastRepayCount,
          currentBlock: await ethers.provider.getBlockNumber(),
        };
      }
    }

    const currentBlock = await ethers.provider.getBlockNumber();
    if (currentBlock >= targetBlock) {
      return {
        converged: false,
        lastRepayCount,
        currentBlock,
      };
    }

    await delay(pollMs);
  }
}

async function waitForLoanFlowBorrowCountIncreaseByBlocks(params: {
  ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>;
  previousBorrowCount: bigint;
  waitBlocks: number;
  observeLabel: string;
}) {
  const startBlock = await ethers.provider.getBlockNumber();
  const targetBlock = startBlock + Math.max(0, params.waitBlocks);
  const pollMs = resolveGuaranteeLoanFlowPollMs();
  let lastBorrowCount = params.previousBorrowCount;

  while (true) {
    const snapshot = await observeExtendedViews(params.ctx, params.observeLabel);
    const borrowCount = snapshot.loanFlowUser?.borrowCount;
    if (typeof borrowCount === "bigint") {
      lastBorrowCount = borrowCount;
      if (borrowCount > params.previousBorrowCount) {
        return {
          converged: true,
          lastBorrowCount,
          currentBlock: await ethers.provider.getBlockNumber(),
        };
      }
    }

    const currentBlock = await ethers.provider.getBlockNumber();
    if (currentBlock >= targetBlock) {
      return {
        converged: false,
        lastBorrowCount,
        currentBlock,
      };
    }

    await delay(pollMs);
  }
}

async function waitForDebtAmountByBlocks(params: {
  lendingEngine: any;
  borrowerAddr: string;
  assetAddr: string;
  expectedDebt: bigint;
  waitBlocks: number;
}) {
  const startBlock = await ethers.provider.getBlockNumber();
  const targetBlock = startBlock + Math.max(0, params.waitBlocks);
  const pollMs = resolveGuaranteeLoanFlowPollMs();
  let lastDebt = -1n;

  while (true) {
    const debt = (await params.lendingEngine.getDebt(params.borrowerAddr, params.assetAddr)) as bigint;
    lastDebt = BigInt(debt);
    if (lastDebt === params.expectedDebt) {
      return {
        converged: true,
        lastDebt,
        currentBlock: await ethers.provider.getBlockNumber(),
      };
    }

    const currentBlock = await ethers.provider.getBlockNumber();
    if (currentBlock >= targetBlock) {
      return {
        converged: false,
        lastDebt,
        currentBlock,
      };
    }

    await delay(pollMs);
  }
}

async function waitForSameAssetBoundaryState(params: {
  ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>;
  lendingEngine: any;
  collateralManager: any;
  assetAddr: string;
  collateralAssetAddr: string;
  expectedRemainingDebt: bigint;
  expectedLocked: bigint;
  expectedCollateral: bigint;
}) {
  let lastDebt = -1n;
  let lastLocked = -1n;
  let lastCollateral = -1n;
  let lastActive = false;

  await waitForCondition("same-asset boundary state convergence", async () => {
    const [debtAfter, collateralAfter, guaranteeAfterRepay] = await Promise.all([
      params.lendingEngine.getDebt(params.ctx.borrower.address, params.assetAddr) as Promise<bigint>,
      params.collateralManager.getCollateral(params.ctx.borrower.address, params.collateralAssetAddr) as Promise<bigint>,
      getGuaranteeState(params.ctx, params.ctx.borrower.address, params.assetAddr),
    ]);
    lastDebt = BigInt(debtAfter);
    lastCollateral = BigInt(collateralAfter);
    lastLocked = guaranteeAfterRepay.locked;
    lastActive = guaranteeAfterRepay.active;
    return lastDebt === params.expectedRemainingDebt
      && lastCollateral === params.expectedCollateral
      && lastActive
      && lastLocked === params.expectedLocked;
  });

  return {
    debtAfter: lastDebt,
    collateralAfter: lastCollateral,
    guaranteeAfterRepay: {
      active: lastActive,
      locked: lastLocked,
    },
  };
}

const ERGM_EVENT_IFACE = new ethers.Interface([
  "event EarlyRepaymentProcessed(uint256 indexed guaranteeId,address indexed borrower,address indexed lender,address asset,uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid,uint256 blockNumber)",
]);

const LENDING_ENGINE_EVENT_IFACE = new ethers.Interface([
  "event FeeDistributionFailed(uint256 indexed orderId,uint256 feeAmount,string reason)",
]);

const SETTLEMENT_ON_TIME_WINDOW_BLOCKS = 7200n;

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

async function getGuaranteeRecordForAsset(
  ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>,
  assetAddr: string,
) {
  const ergmView = (await ethers.getContractAt(
    [
      "function getUserGuaranteeId(address user,address asset) view returns (uint256)",
      "function getGuaranteeRecord(uint256 guaranteeId) view returns ((uint256 principal,uint256 promisedInterest,uint256 startTime,uint256 maturityTime,uint256 earlyRepayPenaltyDays,bool isActive,address lender,address asset))",
    ],
    ctx.ergmAddr,
  )) as any;

  const guaranteeId = (await ergmView.getUserGuaranteeId(ctx.borrower.address, assetAddr)) as bigint;
  if (guaranteeId === 0n) {
    return {
      guaranteeId,
      maturityTime: 0n,
      isActive: false,
    };
  }

  const record = await ergmView.getGuaranteeRecord(guaranteeId);
  return {
    guaranteeId,
    maturityTime: BigInt(record.maturityTime),
    isActive: Boolean(record.isActive),
  };
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

  const nativeAmountWei = await resolveGuaranteeFreshActorNativeBudgetWei("cross-asset boundary");
  await assignFreshBorrower(ctx, {
    noticeLabel: "using fresh guarantee-boundary borrower (cross asset)",
    nativeAmountWei,
  });
  await assignFreshLender(ctx, {
    noticeLabel: "using fresh guarantee-boundary lender (cross asset)",
    nativeAmountWei,
  });
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
    const altDebtBeforeState = await waitForDebtAmountByBlocks({
      lendingEngine,
      borrowerAddr: ctx.borrower.address,
      assetAddr: altAsset.assetAddr,
      expectedDebt: altPrincipal,
      waitBlocks: resolveGuaranteeBoundaryDebtWaitBlocks(),
    });
    const altDebtBefore = altDebtBeforeState.lastDebt;
    if (!altDebtBeforeState.converged) {
      throw new Error(
        `cross-asset boundary: expected alt debt ${altPrincipal.toString()} got ${altDebtBefore.toString()} by block ${altDebtBeforeState.currentBlock}`,
      );
    }

    const guaranteedDue = await getOrderTotalDueForView(ctx, guaranteedFinalize.orderId);
    const repayReceipt = await repayOrderAsset(ctx, {
      orderId: guaranteedFinalize.orderId,
      asset: borrowAsset,
      amount: guaranteedDue,
    });

    const borrowDebtAfter = (await lendingEngine.getDebt(ctx.borrower.address, borrowAsset.assetAddr)) as bigint;
    const altDebtAfter = (await lendingEngine.getDebt(ctx.borrower.address, altAsset.assetAddr)) as bigint;
    const collateralAfter = (await collateralManager.getCollateral(ctx.borrower.address, altAsset.assetAddr)) as bigint;
    const guaranteeAfterRepay = await waitForGuaranteeSettled({
      ctx,
      attempts: 10,
      delayMs: 1200,
    });

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
      const guaranteeRecord = await getGuaranteeRecordForAsset(ctx, borrowAsset.assetAddr);
      const currentBlock = BigInt(await ethers.provider.getBlockNumber());
      const isEarlyAtCheck =
        guaranteeRecord.guaranteeId !== 0n
        && currentBlock + SETTLEMENT_ON_TIME_WINDOW_BLOCKS < guaranteeRecord.maturityTime;

      if (isEarlyAtCheck && guaranteeRecord.isActive) {
        throw new Error("cross-asset boundary: guarantee remained active even though repay still satisfies SettlementManager early-settle condition");
      }

      console.log(
        `  [Notice] cross-asset boundary: guarantee remained active outside SettlementManager early window (block=${currentBlock.toString()} maturity=${guaranteeRecord.maturityTime.toString()} window=${SETTLEMENT_ON_TIME_WINDOW_BLOCKS.toString()})`,
      );
    }

    const altDue = await getOrderTotalDueForView(ctx, altFinalize.orderId);
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

  const nativeAmountWei = await resolveGuaranteeFreshActorNativeBudgetWei("same-asset boundary");
  await assignFreshBorrower(ctx, {
    noticeLabel: "using fresh guarantee-boundary borrower (same asset)",
    nativeAmountWei,
  });
  await assignFreshLender(ctx, {
    noticeLabel: "using fresh guarantee-boundary lender (same asset)",
    nativeAmountWei,
  });
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

    const guaranteedDue = await getOrderTotalDueForView(ctx, guaranteedFinalize.orderId);
    const repayReceipt = await repayOrderAsset(ctx, {
      orderId: guaranteedFinalize.orderId,
      asset: borrowAsset,
      amount: guaranteedDue,
    });

    const { debtAfter, collateralAfter, guaranteeAfterRepay } = await waitForSameAssetBoundaryState({
      ctx,
      lendingEngine,
      collateralManager,
      assetAddr: borrowAsset.assetAddr,
      collateralAssetAddr: collateralAsset.assetAddr,
      expectedRemainingDebt,
      expectedLocked: lockedBefore,
      expectedCollateral: collateralBefore,
    });

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

    const plainDue = await getOrderTotalDueForView(ctx, plainFinalize.orderId);
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

async function waitForGuaranteeSettled(params: {
  ctx: Awaited<ReturnType<typeof createFundsFlowLiveContext>>;
  attempts?: number;
  delayMs?: number;
}) {
  let state = await getGuaranteeState(params.ctx);
  const attempts = Math.max(1, params.attempts ?? 8);
  const delayMs = Math.max(0, params.delayMs ?? 1200);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!state.active && state.locked === 0n) {
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

  const nativeAmountWei = await resolveGuaranteeFreshActorNativeBudgetWei("main guarantee flow");
  await assignFreshBorrower(ctx, {
    noticeLabel: "using fresh guarantee borrower",
    nativeAmountWei,
  });
  await ensureFreshActorNativeBudget({
    ctx,
    actor: ctx.borrower,
    label: "guarantee borrower",
    desiredWei: nativeAmountWei,
  });
  await assignFreshLender(ctx, {
    noticeLabel: "using fresh guarantee lender",
    nativeAmountWei,
  });
  await ensureFreshActorNativeBudget({
    ctx,
    actor: ctx.lender,
    label: "guarantee lender",
    desiredWei: nativeAmountWei,
  });
  await ensureFreshActorNativeBudget({
    ctx,
    actor: ctx.relayer,
    label: "guarantee relayer",
    desiredWei: ethers.parseEther(process.env.LIVE_GUARANTEE_RELAYER_NATIVE_MIN_ETH?.trim() || "0.005"),
  });

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
  const { lendingEngine } = await getLedgerReaders(ctx);
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

  const repayTotalDue = await getOrderTotalDueForView(ctx, finalized.orderId);
  const previewBlock = BigInt(await ethers.provider.getBlockNumber());
  const preview = (await ergmAdmin.previewEarlyRepayment(afterFinalizeGuarantee.guaranteeId, repayTotalDue)) as any;
  const beforeFailedFee = (await ctx.orderEngine.getFailedFeeAmountForView(finalized.orderId)) as bigint;
  const orderBeforeRepay = await getOrderForView(ctx, finalized.orderId);
  const debtBeforeRepay = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  const repayReceipt = await repayOrder(ctx, finalized.orderId, repayTotalDue);
  const orderAfterRepay = await getOrderForView(ctx, finalized.orderId);
  const orderStatusAfterRepay = await getOrderLifecycleStatus(ctx, finalized.orderId);
  const debtAfterRepay = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
  const afterRepayBalances = await getTokenBalances(ctx, ctx.borrowToken, tracked);
  const afterRepayGuarantee = await getGuaranteeState(ctx);
  const afterRepayViews = await observeExtendedViews(ctx, "after-guarantee-repay");
  const afterFailedFee = (await ctx.orderEngine.getFailedFeeAmountForView(finalized.orderId)) as bigint;

  // Stage A strict: ledger path must be correct regardless of eventual view convergence.
  if (!repayReceipt || repayReceipt.status !== 1) {
    throw new Error(`stage-A ledger check failed: repay receipt status=${String(repayReceipt?.status)}`);
  }
  if (orderAfterRepay.repaidAmount <= orderBeforeRepay.repaidAmount) {
    throw new Error(
      `stage-A ledger check failed: order.repaidAmount did not increase before=${orderBeforeRepay.repaidAmount.toString()} after=${orderAfterRepay.repaidAmount.toString()}`,
    );
  }
  if (orderStatusAfterRepay !== LOAN_STATUS.Repaid) {
    throw new Error(`stage-A ledger check failed: expected Repaid order status, got ${orderStatusAfterRepay.toString()}`);
  }
  if (debtAfterRepay > debtBeforeRepay) {
    throw new Error(
      `stage-A ledger check failed: borrower debt increased unexpectedly before=${debtBeforeRepay.toString()} after=${debtAfterRepay.toString()}`,
    );
  }

  const beforeTrackedTotal = sumTokenBalances(beforeBalances);
  const afterTrackedTotal = sumTokenBalances(afterRepayBalances);
  if (shouldRelaxGlobalConservationAssertion()) {
    if (afterTrackedTotal !== beforeTrackedTotal) {
      console.log(
        `  [Notice] guarantee tracked token conservation drift ignored on shared live network: before=${beforeTrackedTotal.toString()} after=${afterTrackedTotal.toString()} delta=${(afterTrackedTotal - beforeTrackedTotal).toString()} changed={${describeBalanceDrift(beforeBalances, afterRepayBalances)}}`,
      );
    }
  } else {
    expectEqual(afterTrackedTotal, beforeTrackedTotal, "guarantee tracked token conservation");
  }
  const failedFeeDelta = afterFailedFee - beforeFailedFee;
  expectEqual(afterRepayGuarantee.locked, 0n, "guarantee locked amount after repay");
  if (afterRepayGuarantee.active) {
    throw new Error("guarantee should be inactive after early repay");
  }

  const ergmIface = new ethers.Interface([
    "event EarlyRepaymentProcessed(uint256 indexed guaranteeId,address indexed borrower,address indexed lender,address asset,uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid,uint256 blockNumber)",
  ]);

  let sawEarlyRepayment = false;
  let observedFailedFeeEventAmount = 0n;
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
      const parsed = LENDING_ENGINE_EVENT_IFACE.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "FeeDistributionFailed" && BigInt(parsed.args.orderId) === finalized.orderId) {
        observedFailedFeeEventAmount += BigInt(parsed.args.feeAmount);
      }
    } catch {}
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
  if (failedFeeDelta > 0n) {
    expectEqual(observedFailedFeeEventAmount, failedFeeDelta, "guarantee failed fee event amount");
  } else if (observedFailedFeeEventAmount > 0n) {
    throw new Error(
      `guarantee failed fee event amount should be zero when order failed fee delta is zero: observed=${observedFailedFeeEventAmount.toString()}`,
    );
  }

  if (afterRepayViews.feeRouterUser && beforeViews.feeRouterUser) {
    if (afterRepayViews.feeRouterUser.totalFeePaid < beforeViews.feeRouterUser.totalFeePaid) {
      throw new Error("FeeRouterView totalFeePaid should not decrease in guarantee flow");
    }
  }
  if (!beforeViews.loanFlowUser) {
    throw new Error("stage-A view check failed: missing LoanFlowView.user snapshot before finalize");
  }
  if (!afterFinalizeViews.loanFlowUser) {
    throw new Error("stage-A view check failed: missing LoanFlowView.user snapshot after finalize");
  }

  const stageABorrowPreviousCount = beforeViews.loanFlowUser.borrowCount;
  const stageABorrowInitialWaitBlocks = resolveGuaranteeLoanFlowBorrowInitialWaitBlocks();
  const stageABorrowPostRetryWaitBlocks = resolveGuaranteeLoanFlowBorrowPostRetryWaitBlocks();
  const stageABorrowInitial = await waitForLoanFlowBorrowCountIncreaseByBlocks({
    ctx,
    previousBorrowCount: stageABorrowPreviousCount,
    waitBlocks: stageABorrowInitialWaitBlocks,
    observeLabel: "after-guarantee-finalize-stageA-borrow-initial",
  });

  if (stageABorrowInitial.converged) {
    console.log(
      `  [GuaranteeStageA] borrowCount converged in ${stageABorrowInitialWaitBlocks} blocks without retryBorrow (borrowCount=${stageABorrowInitial.lastBorrowCount.toString()})`,
    );
  } else {
    console.log(
      `  [GuaranteeStageA] borrowCount not converged after ${stageABorrowInitialWaitBlocks} blocks, executing retryBorrow compensation`,
    );

    await retryLoanFlowBorrowPush(ctx, {
      orderId: finalized.orderId,
      amountBaseUnits: ctx.borrowAmount,
    });

    const stageABorrowPostRetry = await waitForLoanFlowBorrowCountIncreaseByBlocks({
      ctx,
      previousBorrowCount: stageABorrowPreviousCount,
      waitBlocks: stageABorrowPostRetryWaitBlocks,
      observeLabel: "after-guarantee-finalize-stageA-borrow-post-retry",
    });

    if (!stageABorrowPostRetry.converged) {
      throw new Error(
        `stage-A borrow view check failed after retryBorrow: borrowCount remained ${stageABorrowPostRetry.lastBorrowCount.toString()} at block ${stageABorrowPostRetry.currentBlock} (expected > ${stageABorrowPreviousCount.toString()}, windows=${stageABorrowInitialWaitBlocks}+${stageABorrowPostRetryWaitBlocks} blocks)`,
      );
    }

    console.log(
      `  [GuaranteeStageA] borrowCount converged after retryBorrow within ${stageABorrowPostRetryWaitBlocks} blocks (borrowCount=${stageABorrowPostRetry.lastBorrowCount.toString()})`,
    );
  }
  if (!afterFinalizeViews.loanFlowUser) {
    throw new Error("stage-B strict check failed: missing LoanFlowView.user snapshot after finalize");
  }
  if (!afterRepayViews.loanFlowUser) {
    throw new Error("stage-B strict check failed: missing LoanFlowView.user snapshot after repay");
  }

  const stageBPreviousRepayCount = afterFinalizeViews.loanFlowUser.repayCount;
  const stageBInitialWaitBlocks = resolveGuaranteeLoanFlowInitialWaitBlocks();
  const stageBPostRetryWaitBlocks = resolveGuaranteeLoanFlowPostRetryWaitBlocks();

  const stageBInitial = await waitForLoanFlowRepayCountIncreaseByBlocks({
    ctx,
    previousRepayCount: stageBPreviousRepayCount,
    waitBlocks: stageBInitialWaitBlocks,
    observeLabel: "after-guarantee-repay-stageB-initial",
  });

  if (stageBInitial.converged) {
    console.log(
      `  [GuaranteeStageB] initial window converged in ${stageBInitialWaitBlocks} blocks without retryRepay (repayCount=${stageBInitial.lastRepayCount.toString()})`,
    );
  } else {
    console.log(
      `  [GuaranteeStageB] initial window not converged after ${stageBInitialWaitBlocks} blocks, executing retryRepay compensation`,
    );

    await retryLoanFlowRepayPush(ctx, {
      orderId: finalized.orderId,
      amountBaseUnits: repayTotalDue,
      repaidAmountAfter: orderAfterRepay.repaidAmount,
    });

    const stageBPostRetry = await waitForLoanFlowRepayCountIncreaseByBlocks({
      ctx,
      previousRepayCount: stageBPreviousRepayCount,
      waitBlocks: stageBPostRetryWaitBlocks,
      observeLabel: "after-guarantee-repay-stageB-post-retry",
    });

    if (!stageBPostRetry.converged) {
      throw new Error(
        `stage-B strict check failed after retryRepay: repayCount remained ${stageBPostRetry.lastRepayCount.toString()} at block ${stageBPostRetry.currentBlock} (expected > ${stageBPreviousRepayCount.toString()}, windows=${stageBInitialWaitBlocks}+${stageBPostRetryWaitBlocks} blocks)`,
      );
    }

    console.log(
      `  [GuaranteeStageB] converged after retryRepay within ${stageBPostRetryWaitBlocks} blocks (repayCount=${stageBPostRetry.lastRepayCount.toString()})`,
    );
  }

  if (!wasEnabled) {
    await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, false)).wait();
  }

  if (shouldSkipBoundaryBranches()) {
    console.log("  [Notice] skipping guarantee boundary branches for concurrent isolation run");
  } else {
    await runCrossAssetBoundaryBranch();
    await runSameAssetBoundaryBranch();
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
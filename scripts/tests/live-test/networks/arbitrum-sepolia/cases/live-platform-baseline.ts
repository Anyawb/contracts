import { ethers } from "hardhat";

import {
  type FundsFlowLiveContext,
  depositCollateral,
  ensureTokenAllowance,
  expectEqual,
  finalizeSingleMatch,
  fundFundsFlowActors,
  getGuaranteeState,
  observeExtendedViews,
  repayOrder,
  reserveForLending,
  waitForPostWriteOrderReadConvergence,
} from "../core/_fundsFlowLive";
import { runWithNetworkRetry } from "../core/_networkRetry";
import {
  bootstrapRewardLiveTest,
  DEFAULT_ACCEPTED_EASY_MINT_SKIP_REASONS,
  decodeRewardViewPushes,
  findRewardViewPush,
  inspectEasyMintRepayOutcome,
  readRewardUser,
  requireEasyMintedOrAcceptedSkip,
  requireRewardViewPush,
  tryReadSpendStats,
} from "../core/_rewardLive";
import { explainRevert, key } from "../core/_mockLiveUtils";
import { runLiveDomainPreflight } from "../core/_liveDomainPreflight";
import { isRetryableNetworkError } from "../core/_networkRetry";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

type FacadeSnapshot = {
  statsUser: {
    collateral: bigint;
    debt: bigint;
    isValid: boolean;
    blockNumber: bigint;
    version: bigint;
    seq: bigint;
  };
  userTotals: {
    totalCollateral: bigint;
    totalDebt: bigint;
    isValid: boolean;
    blockNumber: bigint;
    version: bigint;
    seq: bigint;
  };
  userHealth: {
    healthFactor: bigint;
    isValid: boolean;
    blockNumber: bigint;
  };
  dashboardOverview: {
    totalCollateral: bigint;
    totalDebt: bigint;
    healthFactor: bigint;
    healthFactorValid: boolean;
    isRisky: boolean;
  };
  cacheSummary: {
    totalCollateral: bigint;
    totalDebt: bigint;
    healthFactor: bigint;
    cacheValid: boolean;
  };
  rawPositions: {
    totalCollateral: bigint;
    totalDebt: bigint;
  };
};

type NormalFlowSummary = {
  orderId: bigint;
  rewardPushCount: number;
  easySpentDelta: bigint;
  easyEarnedDelta: bigint;
  easySpendSequenceSkipped: boolean;
};

type LiquidationFlowSummary = {
  orderId: bigint;
  penaltyDelta: bigint;
  burnedDelta: bigint;
  debtBefore: bigint;
  debtAfter: bigint;
};

type DefaultLiquidationExecutionState = {
  debt: bigint;
  reducibleDebt: bigint;
  staticCallReady: boolean;
};

type PlatformBaselineLayer = "runtime" | "observability";

const ACCESS_CONTROL_ERROR_INTERFACE = new ethers.Interface([
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
]);

const ACCESS_CONTROL_VIEW_INTERFACE: string[] = [
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function grantRole(bytes32 role,address account)",
  "function paused() view returns (bool)",
];

const EASY_BURNER_ROLE = ethers.id("BURNER_ROLE");
const EASY_MINTER_ROLE = ethers.id("MINTER_ROLE");
const DEFAULT_ADMIN_ROLE = `0x${"00".repeat(32)}`;

function topicHash(signature: string) {
  return ethers.id(signature);
}

function withGasBuffer(estimate: bigint, multiplierBps = 12_000n) {
  return (estimate * multiplierBps) / 10_000n + 50_000n;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendPopulatedTxWithNetworkRetry(params: {
  signer: any;
  tx: { to?: string | null; data?: string; value?: bigint };
  label: string;
  multipliersBps?: bigint[];
}) {
  const multipliers = params.multipliersBps ?? [15_000n, 20_000n, 25_000n];
  let lastError: unknown;

  for (let i = 0; i < multipliers.length; i += 1) {
    const multiplier = multipliers[i];
    try {
      const estimate = await ethers.provider.estimateGas({
        from: params.signer.address,
        to: params.tx.to,
        data: params.tx.data,
        value: params.tx.value ?? 0n,
      });
      const gasLimit = withGasBuffer(estimate, multiplier);
      if (i === 0) {
        console.log(`  [Diag.ConsumeGas] ${params.label} estimate=${estimate.toString()} limit=${gasLimit.toString()}`);
      } else {
        console.log(`  [Retry.Tx] ${params.label} attempt=${i + 1}/${multipliers.length} limit=${gasLimit.toString()}`);
      }
      const response = await params.signer.sendTransaction({
        to: params.tx.to,
        data: params.tx.data,
        gasLimit,
        value: params.tx.value ?? 0n,
      });
      return await response.wait();
    } catch (error: any) {
      lastError = error;
      if (i >= multipliers.length - 1 || !isRetryableNetworkError(error)) {
        break;
      }
      await sleep(800 * (i + 1));
    }
  }

  throw lastError;
}

function decodeAddressTriplet(payload: string) {
  return ethers.AbiCoder.defaultAbiCoder().decode(["address", "uint256", "uint256"], payload) as unknown as [
    string,
    bigint,
    bigint,
  ];
}

function envFlag(name: string) {
  const raw = process.env[name];
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolvePlatformBaselineMode(): "runtime" | "observability" | "all" {
  const raw = process.env.LIVE_PLATFORM_BASELINE_LAYER?.trim().toLowerCase();
  if (raw === "runtime" || raw === "observability" || raw === "all") {
    return raw;
  }
  return "all";
}

function notice(message: string) {
  console.log(`  [Notice] ${message}`);
}

async function waitForDefaultLiquidationExecutionWindow(params: {
  settlementManager: any;
  lendingEngine: any;
  borrower: string;
  debtAsset: string;
  orderId: bigint;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const timeoutMs = Math.max(1_000, params.timeoutMs ?? 60_000);
  const pollMs = Math.max(200, params.pollMs ?? 2_000);
  const deadline = Date.now() + timeoutMs;

  let lastState: DefaultLiquidationExecutionState = {
    debt: 0n,
    reducibleDebt: 0n,
    staticCallReady: false,
  };
  let lastStaticCallError = "n/a";
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const [debt, reducibleDebt] = await Promise.all([
      params.lendingEngine.getDebt(params.borrower, params.debtAsset) as Promise<bigint>,
      params.lendingEngine.getReducibleDebtAmount(params.borrower, params.debtAsset) as Promise<bigint>,
    ]);

    let staticCallReady = false;
    try {
      await params.settlementManager.settleOrLiquidate.staticCall(params.orderId);
      staticCallReady = true;
      lastStaticCallError = "n/a";
    } catch (error: any) {
      staticCallReady = false;
      lastStaticCallError = explainRevert(error, [params.settlementManager.interface]);
    }

    lastState = { debt, reducibleDebt, staticCallReady };
    console.log(
      `  [Poll.LiquidationWindow] attempt=${attempt} debt=${debt.toString()} reducibleDebt=${reducibleDebt.toString()} staticCallReady=${String(staticCallReady)}${staticCallReady ? "" : ` lastError=${lastStaticCallError}`}`,
    );

    if (debt > 0n && reducibleDebt > 0n && staticCallReady) {
      return lastState;
    }

    await sleep(pollMs);
  }

  throw new Error(
    `liquidation execution window did not converge within ${timeoutMs}ms: debt=${lastState.debt.toString()} reducibleDebt=${lastState.reducibleDebt.toString()} staticCallReady=${String(lastState.staticCallReady)} lastStaticCallError=${lastStaticCallError}`,
  );
}

async function waitForGuaranteeState(params: {
  ctx: FundsFlowLiveContext;
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

async function waitForBorrowStateConvergence(params: {
  borrower: string;
  borrowAssetAddr: string;
  collateralAssetAddr: string;
  collateralManagerAddr: string;
  lendingEngine: any;
  expectedCollateralAtLeast: bigint;
  expectedDebtAtLeast: bigint;
  attempts?: number;
  delayMs?: number;
}) {
  const collateralManager = (await ethers.getContractAt(
    ["function getCollateral(address user,address asset) view returns (uint256)"],
    params.collateralManagerAddr,
  )) as any;
  const attempts = Math.max(1, params.attempts ?? 8);
  const delayMs = Math.max(0, params.delayMs ?? 1500);

  let collateral = 0n;
  let debt = 0n;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    [collateral, debt] = await Promise.all([
      collateralManager.getCollateral(params.borrower, params.collateralAssetAddr) as Promise<bigint>,
      params.lendingEngine.getDebt(params.borrower, params.borrowAssetAddr) as Promise<bigint>,
    ]);
    if (collateral >= params.expectedCollateralAtLeast && debt >= params.expectedDebtAtLeast) {
      return { collateral, debt };
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { collateral, debt };
}

async function readEasyRoleDiagnostics(ctx: FundsFlowLiveContext, reward: any) {
  const easyTokenAccess = (await ethers.getContractAt(
    ACCESS_CONTROL_VIEW_INTERFACE,
    reward.easyTokenAddr,
  )) as any;

  const [paused, recycleIsBurner, emissionIsMinter, relayerIsAdmin, borrowerIsBurner, borrowerIsMinter] = await Promise.all([
    easyTokenAccess.paused(),
    easyTokenAccess.hasRole(EASY_BURNER_ROLE, reward.easyRecycleDistributorAddr),
    easyTokenAccess.hasRole(EASY_MINTER_ROLE, reward.easyEmissionControllerAddr),
    easyTokenAccess.hasRole(DEFAULT_ADMIN_ROLE, ctx.relayer.address),
    easyTokenAccess.hasRole(EASY_BURNER_ROLE, ctx.borrower.address),
    easyTokenAccess.hasRole(EASY_MINTER_ROLE, ctx.borrower.address),
  ]);

  return {
    paused: Boolean(paused),
    recycleIsBurner: Boolean(recycleIsBurner),
    emissionIsMinter: Boolean(emissionIsMinter),
    relayerIsAdmin: Boolean(relayerIsAdmin),
    borrowerIsBurner: Boolean(borrowerIsBurner),
    borrowerIsMinter: Boolean(borrowerIsMinter),
  };
}

async function maybeRepairEasyRoles(ctx: FundsFlowLiveContext, reward: any) {
  if (!envFlag("ALLOW_EASY_ROLE_REPAIR")) {
    return;
  }

  const easyTokenAccess = (await ethers.getContractAt(
    ACCESS_CONTROL_VIEW_INTERFACE,
    reward.easyTokenAddr,
  )) as any;

  const relayerIsAdmin = (await easyTokenAccess.hasRole(DEFAULT_ADMIN_ROLE, ctx.relayer.address)) as boolean;
  if (!relayerIsAdmin) {
    console.log("  [Diag.EasyRoleRepair] skipped: relayer is not EasyToken DEFAULT_ADMIN_ROLE");
    return;
  }

  const recycleIsBurner = (await easyTokenAccess.hasRole(EASY_BURNER_ROLE, reward.easyRecycleDistributorAddr)) as boolean;
  if (!recycleIsBurner) {
    console.log(`  [Diag.EasyRoleRepair] granting BURNER_ROLE to recycle distributor ${reward.easyRecycleDistributorAddr}`);
    await (await easyTokenAccess.connect(ctx.relayer).grantRole(EASY_BURNER_ROLE, reward.easyRecycleDistributorAddr)).wait();
  }

  const emissionIsMinter = (await easyTokenAccess.hasRole(EASY_MINTER_ROLE, reward.easyEmissionControllerAddr)) as boolean;
  if (!emissionIsMinter) {
    console.log(`  [Diag.EasyRoleRepair] granting MINTER_ROLE to emission controller ${reward.easyEmissionControllerAddr}`);
    await (await easyTokenAccess.connect(ctx.relayer).grantRole(EASY_MINTER_ROLE, reward.easyEmissionControllerAddr)).wait();
  }
}

function formatReceiptLog(log: any) {
  return `address=${String(log.address ?? "")} topic0=${String(log.topics?.[0] ?? "")} topics=${JSON.stringify(log.topics ?? [])} data=${String(log.data ?? "")}`;
}

function summarizeRewardRelevantLogs(ctx: FundsFlowLiveContext, reward: any, receipt: any) {
  const relevantAddresses = new Set([
    String(ctx.gfm?.target ?? ctx.guaranteeFundAddr ?? "").toLowerCase(),
    String(reward.rewardManagerAddr ?? "").toLowerCase(),
    String(reward.rewardAccrualManagerAddr ?? "").toLowerCase(),
    String(ctx.rewardView.target ?? "").toLowerCase(),
  ]);

  const lines = (receipt.logs ?? [])
    .filter((log: any) => relevantAddresses.has(String(log.address ?? "").toLowerCase()))
    .map((log: any) => formatReceiptLog(log));

  return lines.length > 0 ? lines.join("\n") : "<no reward-relevant logs found on receipt>";
}

async function readFacadeSnapshot(ctx: FundsFlowLiveContext): Promise<FacadeSnapshot | null> {
  if (!ctx.statisticsView || !ctx.userView || !ctx.dashboardView || !ctx.cacheOptimizedView) {
    return null;
  }

  const trackedAssets = [ctx.collateralAssetAddr, ctx.borrowAssetAddr];
  const [statsSnapshot, userTotals, userHealth, dashboardOverview, cacheSummary, collateralPos, borrowPos] = await Promise.all([
    ctx.statisticsView.connect(ctx.borrower).getUserSnapshotWithMeta(ctx.borrower.address),
    ctx.userView.connect(ctx.borrower).getUserTotalsWithMeta(ctx.borrower.address),
    ctx.userView.connect(ctx.borrower).getHealthFactorWithMeta(ctx.borrower.address),
    ctx.dashboardView.connect(ctx.borrower).getUserOverviewWithMeta(ctx.borrower.address, trackedAssets),
    ctx.cacheOptimizedView.connect(ctx.borrower).getUserSummaryWithMeta(ctx.borrower.address, trackedAssets),
    ctx.positionView.connect(ctx.borrower).getUserPositionWithBlockMeta(ctx.borrower.address, ctx.collateralAssetAddr),
    ctx.positionView.connect(ctx.borrower).getUserPositionWithBlockMeta(ctx.borrower.address, ctx.borrowAssetAddr),
  ]);

  const [stats, version, seq, , statsValid, statsBlock] = statsSnapshot as [any, bigint, bigint, string, boolean, bigint];
  const [totalCollateral, totalDebt, totalsValid, totalsBlock, totalsVersion, totalsSeq] = userTotals as [bigint, bigint, boolean, bigint, bigint, bigint];
  const [healthFactor, healthValid, healthBlock] = userHealth as [bigint, boolean, bigint];
  const [overview] = dashboardOverview as [any, boolean[], bigint[], bigint[], bigint];
  const [summary] = cacheSummary as [any, boolean[], bigint[], bigint[], bigint];
  const [collateralCollateral, collateralDebt] = collateralPos as [bigint, bigint, boolean, bigint, bigint, bigint];
  const [borrowCollateral, borrowDebt] = borrowPos as [bigint, bigint, boolean, bigint, bigint, bigint];

  return {
    statsUser: {
      collateral: BigInt(stats.collateral ?? stats[0] ?? 0),
      debt: BigInt(stats.debt ?? stats[1] ?? 0),
      isValid: statsValid,
      blockNumber: statsBlock,
      version,
      seq,
    },
    userTotals: {
      totalCollateral,
      totalDebt,
      isValid: totalsValid,
      blockNumber: totalsBlock,
      version: totalsVersion,
      seq: totalsSeq,
    },
    userHealth: {
      healthFactor,
      isValid: healthValid,
      blockNumber: healthBlock,
    },
    dashboardOverview: {
      totalCollateral: BigInt(overview.totalCollateral ?? overview[0] ?? 0),
      totalDebt: BigInt(overview.totalDebt ?? overview[1] ?? 0),
      healthFactor: BigInt(overview.healthFactor ?? overview[2] ?? 0),
      healthFactorValid: Boolean(overview.healthFactorValid ?? overview[3] ?? false),
      isRisky: Boolean(overview.isRisky ?? overview[4] ?? false),
    },
    cacheSummary: {
      totalCollateral: BigInt(summary.totalCollateral ?? summary[0] ?? 0),
      totalDebt: BigInt(summary.totalDebt ?? summary[1] ?? 0),
      healthFactor: BigInt(summary.healthFactor ?? summary[2] ?? 0),
      cacheValid: Boolean(summary.cacheValid ?? summary[3] ?? false),
    },
    rawPositions: {
      totalCollateral: collateralCollateral + borrowCollateral,
      totalDebt: collateralDebt + borrowDebt,
    },
  } satisfies FacadeSnapshot;
}

function assertFacadeConsistency(snapshot: FacadeSnapshot, label: string) {
  expectEqual(snapshot.userTotals.totalCollateral, snapshot.statsUser.collateral, `${label}: UserView collateral vs StatisticsView`);
  expectEqual(snapshot.userTotals.totalDebt, snapshot.statsUser.debt, `${label}: UserView debt vs StatisticsView`);
  expectEqual(snapshot.userTotals.version, snapshot.statsUser.version, `${label}: UserView version vs StatisticsView`);
  expectEqual(snapshot.userTotals.seq, snapshot.statsUser.seq, `${label}: UserView seq vs StatisticsView`);
  expectEqual(snapshot.dashboardOverview.totalCollateral, snapshot.cacheSummary.totalCollateral, `${label}: DashboardView collateral vs CacheOptimizedView`);
  expectEqual(snapshot.dashboardOverview.totalDebt, snapshot.cacheSummary.totalDebt, `${label}: DashboardView debt vs CacheOptimizedView`);
  expectEqual(snapshot.dashboardOverview.totalCollateral, snapshot.rawPositions.totalCollateral, `${label}: DashboardView collateral vs PositionView sum`);
  expectEqual(snapshot.dashboardOverview.totalDebt, snapshot.rawPositions.totalDebt, `${label}: DashboardView debt vs PositionView sum`);
  expectEqual(snapshot.dashboardOverview.healthFactor, snapshot.cacheSummary.healthFactor, `${label}: DashboardView health vs CacheOptimizedView`);
  expectEqual(snapshot.dashboardOverview.healthFactor, snapshot.userHealth.healthFactor, `${label}: DashboardView health vs UserView health`);

  if (!snapshot.userTotals.isValid) {
    throw new Error(`${label}: UserView totals should be valid`);
  }
  if (!snapshot.userHealth.isValid) {
    throw new Error(`${label}: UserView health should be valid`);
  }
  if (!snapshot.dashboardOverview.healthFactorValid) {
    throw new Error(`${label}: DashboardView health factor should be valid`);
  }
  if (!snapshot.cacheSummary.cacheValid) {
    throw new Error(`${label}: CacheOptimizedView summary should be valid`);
  }
}

async function runNormalRepayBranch(layer: PlatformBaselineLayer): Promise<NormalFlowSummary> {
  const strictObservability = layer === "observability";
  const { ctx, reward } = await bootstrapRewardLiveTest({
    label: `Live Platform Baseline Normal Branch (${layer})`,
    noticeLabel: "using fresh platform-baseline normal borrower",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });
  const hasAdmin = (await ctx.acm.hasRole(key("ACTION_ADMIN"), ctx.relayer.address)) as boolean;

  const beforeBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const beforeLender = await readRewardUser(reward, ctx.lender, ctx.lender.address);
  const beforeSpendStats = await tryReadSpendStats(reward, ctx.relayer);

  await observeExtendedViews(ctx, "platform-baseline-normal-before");
  await depositCollateral(ctx, ctx.collateralAmount);
  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);
  const repayReceipt = await repayOrder(ctx, finalized.orderId, ctx.totalDue);

  const repayPushes = decodeRewardViewPushes(reward, repayReceipt);
  const repayMintOutcome = inspectEasyMintRepayOutcome(reward, repayReceipt, {
    rewardViewPushes: repayPushes,
    acceptedSkipReasons: DEFAULT_ACCEPTED_EASY_MINT_SKIP_REASONS,
  });
  if (!repayMintOutcome.mintedPush) {
    const reason = repayMintOutcome.skipReason ?? "missing-push";
    if (strictObservability) {
      requireEasyMintedOrAcceptedSkip(
        repayMintOutcome,
        `repay tx did not emit RewardView DataPushed(EASY_MINTED); borrowerPenaltyDebt=${beforeBorrower.penaltyDebt} lenderPenaltyDebt=${beforeLender.penaltyDebt}`,
      );
    }
    notice(
      `${strictObservability ? 'observability' : 'normal runtime'} layer: EASY_MINTED push missing after repay; reason=${reason} borrowerPenaltyDebt=${beforeBorrower.penaltyDebt} lenderPenaltyDebt=${beforeLender.penaltyDebt}`,
    );
  }

  const afterRepayBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const afterRepayLender = await readRewardUser(reward, ctx.lender, ctx.lender.address);
  if (afterRepayBorrower.easyEarned < beforeBorrower.easyEarned) {
    throw new Error("borrower RewardView easyEarned regressed after repay mint");
  }
  if (afterRepayLender.easyEarned < beforeLender.easyEarned) {
    throw new Error("lender RewardView easyEarned regressed after repay mint");
  }

  const allowance = (await reward.easyToken.allowance(ctx.borrower.address, reward.easyConsumptionAddr)) as bigint;
  const totalSpend = 2n * 10n ** 18n;
  const recoveryAmount = 1n * 10n ** 18n;
  const requiredEasyBalance = totalSpend + recoveryAmount;
  const easyBalanceInsufficient = afterRepayBorrower.easyBalance < requiredEasyBalance;
  const shouldSkipEasySpendSequence = easyBalanceInsufficient && (
    repayMintOutcome.hasAcceptedSkip || !repayMintOutcome.mintedPush
  );

  let afterConsumeBorrower = afterRepayBorrower;
  if (shouldSkipEasySpendSequence) {
    notice(
      `${strictObservability ? 'observability' : 'normal runtime'} layer: skip EASY spend+recovery assertions; balance=${afterRepayBorrower.easyBalance} required=${requiredEasyBalance} mintedPush=${repayMintOutcome.mintedPush ? 'yes' : 'no'} skipReason=${repayMintOutcome.skipReason}`,
    );
  } else {
    if (allowance < totalSpend) {
      await ensureTokenAllowance(reward.easyToken, ctx.borrower, reward.easyConsumptionAddr, totalSpend, "EasyToken -> EasyConsumption");
    }
    if (easyBalanceInsufficient) {
      throw new Error(`borrower Easy balance is too low to chain spend+recovery assertions: ${afterRepayBorrower.easyBalance}`);
    }

    await maybeRepairEasyRoles(ctx, reward);
    const easyRoleDiag = await readEasyRoleDiagnostics(ctx, reward);
    console.log(
      `  [Diag.EasyRoles] paused=${easyRoleDiag.paused} recycleIsBurner=${easyRoleDiag.recycleIsBurner} emissionIsMinter=${easyRoleDiag.emissionIsMinter} relayerIsAdmin=${easyRoleDiag.relayerIsAdmin}`,
    );

    try {
      await reward.easyConsumption.connect(ctx.borrower).consumeEasiMCall.staticCall(ctx.borrower.address);
    } catch (error: any) {
      throw new Error(
        `consumeEasiMCall.staticCall failed: ${explainRevert(error, [reward.easyConsumption.interface, reward.easyRecycleDistributor.interface, reward.easyToken.interface, ACCESS_CONTROL_ERROR_INTERFACE])} borrower=${ctx.borrower.address} recycle=${reward.easyRecycleDistributorAddr} easyToken=${reward.easyTokenAddr}`,
      );
    }

    try {
      await reward.easyConsumption.connect(ctx.borrower).consumeStrategyApiCall.staticCall(ctx.borrower.address);
    } catch (error: any) {
      throw new Error(
        `consumeStrategyApiCall.staticCall failed: ${explainRevert(error, [reward.easyConsumption.interface, reward.easyRecycleDistributor.interface, reward.easyToken.interface, ACCESS_CONTROL_ERROR_INTERFACE])} borrower=${ctx.borrower.address} recycle=${reward.easyRecycleDistributorAddr} easyToken=${reward.easyTokenAddr}`,
      );
    }

    const consumeEasiMPopulated = await reward.easyConsumption
      .connect(ctx.borrower)
      .consumeEasiMCall.populateTransaction(ctx.borrower.address);

    let consumeEasiMReceipt;
    try {
      consumeEasiMReceipt = await sendPopulatedTxWithNetworkRetry({
        signer: ctx.borrower,
        tx: {
          to: consumeEasiMPopulated.to,
          data: consumeEasiMPopulated.data,
          value: consumeEasiMPopulated.value ?? 0n,
        },
        label: "easim",
      });
    } catch (error: any) {
      throw new Error(
        `consumeEasiMCall tx failed: ${explainRevert(error, [reward.easyConsumption.interface, reward.easyRecycleDistributor.interface, reward.easyToken.interface, ACCESS_CONTROL_ERROR_INTERFACE])} code=${String(error?.code ?? "n/a")} message=${String(error?.message ?? "")} receiptStatus=${String(error?.receipt?.status ?? "n/a")} gasUsed=${String(error?.receipt?.gasUsed ?? "n/a")}`,
      );
    }

    const consumeStrategyPopulated = await reward.easyConsumption
      .connect(ctx.borrower)
      .consumeStrategyApiCall.populateTransaction(ctx.borrower.address);

    let consumeStrategyReceipt;
    try {
      consumeStrategyReceipt = await sendPopulatedTxWithNetworkRetry({
        signer: ctx.borrower,
        tx: {
          to: consumeStrategyPopulated.to,
          data: consumeStrategyPopulated.data,
          value: consumeStrategyPopulated.value ?? 0n,
        },
        label: "strategy",
      });
    } catch (error: any) {
      throw new Error(
        `consumeStrategyApiCall tx failed: ${explainRevert(error, [reward.easyConsumption.interface, reward.easyRecycleDistributor.interface, reward.easyToken.interface, ACCESS_CONTROL_ERROR_INTERFACE])} code=${String(error?.code ?? "n/a")} message=${String(error?.message ?? "")} receiptStatus=${String(error?.receipt?.status ?? "n/a")} gasUsed=${String(error?.receipt?.gasUsed ?? "n/a")}`,
      );
    }
    const recoveryTransferReceipt = await (await reward.easyToken.connect(ctx.borrower).transfer(reward.easyRecycleDistributorAddr, recoveryAmount)).wait();
    recoveryTransferReceipt;

    const recycleBalanceBeforeRecovery = (await reward.easyToken.balanceOf(reward.easyRecycleDistributorAddr)) as bigint;
    let recoveryReceipt: any = null;
    let recoveryPushes: any[] = [];

    try {
      await reward.easyRecycleDistributor.connect(ctx.relayer).settleOutstandingEasyBalance.staticCall();

      const recoveryPopulated = await reward.easyRecycleDistributor.connect(ctx.relayer).settleOutstandingEasyBalance.populateTransaction();
      console.log(`  [Diag.Recovery] recycleBalance=${recycleBalanceBeforeRecovery.toString()}`);

      recoveryReceipt = await sendPopulatedTxWithNetworkRetry({
        signer: ctx.relayer,
        tx: {
          to: recoveryPopulated.to,
          data: recoveryPopulated.data,
          value: recoveryPopulated.value ?? 0n,
        },
        label: "recovery",
      });
      recoveryPushes = decodeRewardViewPushes(reward, recoveryReceipt);
    } catch (error: any) {
      const revertText = explainRevert(error, [reward.easyRecycleDistributor.interface, reward.easyToken.interface, ACCESS_CONTROL_ERROR_INTERFACE]);
      const recycleBalanceAfterFailedRecovery = (await reward.easyToken.balanceOf(reward.easyRecycleDistributorAddr)) as bigint;

      if (/InvalidCaller/i.test(revertText) && recycleBalanceAfterFailedRecovery === 0n) {
        console.log(
          `  [Notice] settleOutstandingEasyBalance skipped: recycle has no outstanding Easy balance (before=${recycleBalanceBeforeRecovery.toString()} after=${recycleBalanceAfterFailedRecovery.toString()})`,
        );
      } else {
        throw new Error(
          `settleOutstandingEasyBalance tx failed: ${revertText} recycleBalanceBefore=${recycleBalanceBeforeRecovery.toString()} recycleBalanceAfter=${recycleBalanceAfterFailedRecovery.toString()} receiptStatus=${String(error?.receipt?.status ?? "n/a")} gasUsed=${String(error?.receipt?.gasUsed ?? "n/a")}`,
        );
      }
    }

    const consumeEasiMPushes = decodeRewardViewPushes(reward, consumeEasiMReceipt);
    const consumeStrategyPushes = decodeRewardViewPushes(reward, consumeStrategyReceipt);
    if (strictObservability) {
      requireRewardViewPush(consumeEasiMPushes, "EASY_SPENT", "consumeEasiMCall tx did not emit RewardView DataPushed(EASY_SPENT)");
      requireRewardViewPush(consumeEasiMPushes, "EASY_RECYCLED_SPLIT", "consumeEasiMCall tx did not emit RewardView DataPushed(EASY_RECYCLED_SPLIT)");
      requireRewardViewPush(consumeStrategyPushes, "EASY_SPENT", "consumeStrategyApiCall tx did not emit RewardView DataPushed(EASY_SPENT)");
      requireRewardViewPush(consumeStrategyPushes, "EASY_RECYCLED_SPLIT", "consumeStrategyApiCall tx did not emit RewardView DataPushed(EASY_RECYCLED_SPLIT)");
    } else {
      if (!findRewardViewPush(consumeEasiMPushes, "EASY_SPENT")) {
        notice("normal runtime layer: consumeEasiMCall missing RewardView DataPushed(EASY_SPENT)");
      }
      if (!findRewardViewPush(consumeEasiMPushes, "EASY_RECYCLED_SPLIT")) {
        notice("normal runtime layer: consumeEasiMCall missing RewardView DataPushed(EASY_RECYCLED_SPLIT)");
      }
      if (!findRewardViewPush(consumeStrategyPushes, "EASY_SPENT")) {
        notice("normal runtime layer: consumeStrategyApiCall missing RewardView DataPushed(EASY_SPENT)");
      }
      if (!findRewardViewPush(consumeStrategyPushes, "EASY_RECYCLED_SPLIT")) {
        notice("normal runtime layer: consumeStrategyApiCall missing RewardView DataPushed(EASY_RECYCLED_SPLIT)");
      }
    }
    if (recoveryReceipt) {
      if (strictObservability) {
        requireRewardViewPush(recoveryPushes, "EASY_RECYCLED_SPLIT", "settleOutstandingEasyBalance tx did not emit RewardView DataPushed(EASY_RECYCLED_SPLIT)");
      } else if (!findRewardViewPush(recoveryPushes, "EASY_RECYCLED_SPLIT")) {
        notice("normal runtime layer: settleOutstandingEasyBalance missing RewardView DataPushed(EASY_RECYCLED_SPLIT)");
      }
    }

    afterConsumeBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
    if (afterConsumeBorrower.easySpent - afterRepayBorrower.easySpent !== totalSpend) {
      throw new Error("RewardView easySpent delta mismatch after consume sequence");
    }
  }

  if (beforeBorrower.penaltyDebt > 0n) {
    const penaltyPush = findRewardViewPush(repayPushes, "REWARD_PENALTY_LEDGER_UPDATED");
    if (!penaltyPush) {
      if (strictObservability) {
        throw new Error("borrower had existing penalty debt, but repay tx did not emit RewardView DataPushed(REWARD_PENALTY_LEDGER_UPDATED)");
      }
      notice("normal runtime layer: repay path missing RewardView DataPushed(REWARD_PENALTY_LEDGER_UPDATED)");
    } else {
      const [pushedUser, pushedDebt] = decodeAddressTriplet(penaltyPush.payload);
      if (pushedUser.toLowerCase() !== ctx.borrower.address.toLowerCase()) {
        throw new Error("penalty ledger push user mismatch on repay path");
      }
      if (pushedDebt !== afterConsumeBorrower.penaltyDebt) {
        throw new Error(`penalty ledger push debt mismatch: pushed=${pushedDebt} current=${afterConsumeBorrower.penaltyDebt}`);
      }
    }
  } else if (hasAdmin && afterConsumeBorrower.penaltyDebt > 0n) {
    if (strictObservability) {
      const retryReceipt = await (
        await reward.rewardView.connect(ctx.relayer).retryPushPenaltyLedger(
          ctx.borrower.address,
          afterConsumeBorrower.penaltyDebt,
          BigInt(await ethers.provider.getBlockNumber()),
        )
      ).wait();
      const penaltyPush = requireRewardViewPush(
        decodeRewardViewPushes(reward, retryReceipt),
        "REWARD_PENALTY_LEDGER_UPDATED",
        "RewardView.retryPushPenaltyLedger did not emit DataPushed(REWARD_PENALTY_LEDGER_UPDATED)",
      );
      const [pushedUser, pushedDebt] = decodeAddressTriplet(penaltyPush.payload);
      if (pushedUser.toLowerCase() !== ctx.borrower.address.toLowerCase()) {
        throw new Error("retry penalty ledger push user mismatch");
      }
      if (pushedDebt !== afterConsumeBorrower.penaltyDebt) {
        throw new Error(`retry penalty ledger push debt mismatch: pushed=${pushedDebt} current=${afterConsumeBorrower.penaltyDebt}`);
      }
    } else {
      notice("normal runtime layer: skip retryPushPenaltyLedger strict push verification; state mirror assertion only");
    }
  } else {
    console.log(
      "  [Notice] skip retryPushPenaltyLedger: borrower has no outstanding penalty debt (or relayer lacks ACTION_ADMIN); state mirror assertion only",
    );
  }

  const finalBorrower = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const finalSpendStats = await tryReadSpendStats(reward, ctx.relayer);
  if (finalBorrower.pendingPenalty !== finalBorrower.penaltyDebt) {
    throw new Error("final RewardView pendingPenalty should mirror RewardAccrualManager penalty debt");
  }
  const expectedTotalSpentDelta = shouldSkipEasySpendSequence ? 0n : totalSpend;
  if (beforeSpendStats && finalSpendStats && finalSpendStats.totalSpent - beforeSpendStats.totalSpent !== expectedTotalSpentDelta) {
    throw new Error("RewardView totalSpent delta mismatch in chained assertion script");
  }

  const repayViews = await observeExtendedViews(ctx, "platform-baseline-normal-after-repay");
  if (repayViews.base.debtPositionDebt !== 0n) {
    throw new Error(`PositionView debt should be zero after repay: ${repayViews.base.debtPositionDebt}`);
  }

  const facadeSnapshot = await readFacadeSnapshot(ctx);
  if (facadeSnapshot) {
    assertFacadeConsistency(facadeSnapshot, "platform-baseline-normal-after-repay");
    expectEqual(facadeSnapshot.dashboardOverview.totalDebt, 0n, "platform-baseline-normal-after-repay dashboard debt");
    expectEqual(facadeSnapshot.userTotals.totalDebt, 0n, "platform-baseline-normal-after-repay user totals debt");
  }

  console.log(
    `  [PlatformBaseline.Normal] orderId=${finalized.orderId.toString()} repayPushes=${repayPushes.length} easyEarned=${beforeBorrower.easyEarned.toString()}->${finalBorrower.easyEarned.toString()} easySpent=${afterRepayBorrower.easySpent.toString()}->${finalBorrower.easySpent.toString()}`,
  );

  return {
    orderId: finalized.orderId,
    rewardPushCount: repayPushes.length,
    easySpentDelta: finalBorrower.easySpent - beforeBorrower.easySpent,
    easyEarnedDelta: finalBorrower.easyEarned - beforeBorrower.easyEarned,
    easySpendSequenceSkipped: shouldSkipEasySpendSequence,
  } satisfies NormalFlowSummary;
}

async function runGuaranteeDefaultBranch(layer: PlatformBaselineLayer): Promise<LiquidationFlowSummary> {
  const strictObservability = layer === "observability";
  const { ctx, reward } = await bootstrapRewardLiveTest({
    label: `Live Platform Baseline Liquidation Branch (${layer})`,
    noticeLabel: "using fresh platform-baseline liquidation borrower",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "500",
  });

  if (!ctx.gfm || !ctx.ergm) {
    throw new Error("guarantee modules are not registered in current environment");
  }

  const hasActionLiquidate = (await ctx.acm.hasRole(key("LIQUIDATE"), ctx.relayer.address)) as boolean;
  const hasActionViewPush = (await ctx.acm.hasRole(key("ACTION_VIEW_PUSH"), ctx.relayer.address)) as boolean;
  if (!hasActionLiquidate) {
    throw new Error(`relayer ${ctx.relayer.address} lacks LIQUIDATE role required by SettlementManager`);
  }
  if (!hasActionViewPush) {
    throw new Error(`relayer ${ctx.relayer.address} lacks ACTION_VIEW_PUSH role required to force liquidation health status`);
  }

  const ergmAdmin = (await ethers.getContractAt(
    [
      "function setGuaranteeEnabled(address asset,bool enabled)",
      "function isGuaranteeEnabled(address asset) view returns (bool)",
    ],
    ctx.ergmAddr,
    ctx.relayer,
  )) as any;

  await fundFundsFlowActors(ctx, {
    borrowerBorrowAmount: ctx.totalDue + ctx.interest,
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const liquidationViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
  const lendingEngine = (await ethers.getContractAt(
    [
      "function getDebt(address user,address asset) view returns (uint256)",
      "function getReducibleDebtAmount(address user,address asset) view returns (uint256)",
    ],
    lendingEngineAddr,
  )) as any;
  const settlementManager = (await ethers.getContractAt(
    ["function settleOrLiquidate(uint256 orderId)"],
    ctx.settlementManagerAddr,
    ctx.relayer,
  )) as any;
  const healthViewWriter = (await ethers.getContractAt(
    [
      "function pushRiskStatus(address user,uint256 healthFactorBps,uint256 minHFBps,bool undercollateralized,uint256 blockNumber)",
    ],
    String(ctx.healthView.target),
    ctx.relayer,
  )) as any;
  const liquidatorView = (await ethers.getContractAt(
    ["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"],
    liquidationViewAddr,
    ctx.viewer,
  )) as any;

  const beforeReward = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
  const beforeGuarantee = await getGuaranteeState(ctx);
  const beforeQuote = (await reward.rewardManager.quoteLiquidationPenalty(ctx.borrower.address)) as bigint;
  const wasEnabled = (await ergmAdmin.isGuaranteeEnabled(ctx.borrowAssetAddr)) as boolean;

  if (!wasEnabled) {
    await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, true)).wait();
  }

  try {
    if (ctx.interest > 0n) {
      await ensureTokenAllowance(ctx.borrowToken, ctx.borrower, ctx.guaranteeFundAddr, ctx.interest, "borrow asset -> GuaranteeFundManager");
    }
    await observeExtendedViews(ctx, "platform-baseline-liquidation-before");
    await depositCollateral(ctx, ctx.collateralAmount);
    const reserve = await reserveForLending(ctx);
    const finalized = await finalizeSingleMatch(ctx, reserve);
    const afterBorrowGuarantee = await waitForGuaranteeState({
      ctx,
      expectedLocked: ctx.interest,
    });
    const afterBorrowState = await waitForBorrowStateConvergence({
      borrower: ctx.borrower.address,
      borrowAssetAddr: ctx.borrowAssetAddr,
      collateralAssetAddr: ctx.collateralAssetAddr,
      collateralManagerAddr: ctx.collateralManagerAddr,
      lendingEngine,
      expectedCollateralAtLeast: ctx.collateralAmount,
      expectedDebtAtLeast: ctx.borrowAmount,
    });
    const quoteAfterBorrow = (await reward.rewardManager.quoteLiquidationPenalty(ctx.borrower.address)) as bigint;

    if (!afterBorrowGuarantee.active || afterBorrowGuarantee.locked === 0n) {
      throw new Error("expected active guarantee with locked amount after guarantee-enabled finalizeMatch");
    }
    if (quoteAfterBorrow <= beforeQuote) {
      throw new Error(`expected liquidation penalty quote to increase after borrow lock: before=${beforeQuote} after=${quoteAfterBorrow}`);
    }
    if (afterBorrowState.collateral < ctx.collateralAmount || afterBorrowState.debt < ctx.borrowAmount) {
      throw new Error(
        `borrow state did not converge after finalizeMatch: collateral=${afterBorrowState.collateral.toString()} debt=${afterBorrowState.debt.toString()}`,
      );
    }

    const debtBefore = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
    const reducibleBefore = (await lendingEngine.getReducibleDebtAmount(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;
    if (debtBefore === 0n || reducibleBefore === 0n) {
      throw new Error("active debt is required before triggering guarantee-default liquidation");
    }

    try {
      await healthViewWriter.connect(ctx.relayer).pushRiskStatus.staticCall(ctx.borrower.address, 0n, 10000n, true, 0n);
    } catch (error: any) {
      throw new Error(`pushRiskStatus staticCall reverted: ${explainRevert(error, [healthViewWriter.interface])}`);
    }

    const pushRiskStatusGas = withGasBuffer(
      await healthViewWriter.connect(ctx.relayer).pushRiskStatus.estimateGas(ctx.borrower.address, 0n, 10000n, true, 0n),
    );
    await (
      await healthViewWriter.connect(ctx.relayer).pushRiskStatus(ctx.borrower.address, 0n, 10000n, true, 0n, {
        gasLimit: pushRiskStatusGas,
      })
    ).wait();

    await waitForDefaultLiquidationExecutionWindow({
      settlementManager: settlementManager.connect(ctx.relayer),
      lendingEngine,
      borrower: ctx.borrower.address,
      debtAsset: ctx.borrowAssetAddr,
      orderId: finalized.orderId,
      timeoutMs: Number(process.env.LIVE_LIQUIDATION_WINDOW_TIMEOUT_MS ?? "60000"),
      pollMs: Number(process.env.LIVE_LIQUIDATION_WINDOW_POLL_MS ?? "2000"),
    });

    const settleOrLiquidatePopulated = await settlementManager
      .connect(ctx.relayer)
      .settleOrLiquidate.populateTransaction(finalized.orderId);
    const liquidationReceipt = await sendPopulatedTxWithNetworkRetry({
      signer: ctx.relayer,
      tx: {
        to: settleOrLiquidatePopulated.to,
        data: settleOrLiquidatePopulated.data,
        value: settleOrLiquidatePopulated.value ?? 0n,
      },
      label: "settleOrLiquidate-default",
      multipliersBps: [13_000n, 16_000n, 20_000n],
    });
    await waitForPostWriteOrderReadConvergence(ctx, finalized.orderId, "settleOrLiquidate", liquidationReceipt.blockNumber);
    const afterReward = await readRewardUser(reward, ctx.borrower, ctx.borrower.address);
    const afterGuarantee = await getGuaranteeState(ctx);
    const quoteAfterLiquidation = (await reward.rewardManager.quoteLiquidationPenalty(ctx.borrower.address)) as bigint;
    const debtAfter = (await lendingEngine.getDebt(ctx.borrower.address, ctx.borrowAssetAddr)) as bigint;

    if (afterGuarantee.active) {
      throw new Error("guarantee should be inactive after SettlementManager default path");
    }
    if (afterGuarantee.locked !== 0n) {
      throw new Error(`guarantee locked amount should be zero after default: ${afterGuarantee.locked}`);
    }
    if (quoteAfterLiquidation > quoteAfterBorrow) {
      throw new Error("liquidation/default should not increase liquidation penalty quote after guarantee path is processed");
    }
    if (debtAfter > debtBefore) {
      throw new Error(`debt increased after liquidation/default: before=${debtBefore} after=${debtAfter}`);
    }

    const rewardPushes = decodeRewardViewPushes(reward, liquidationReceipt);
    const penaltyPush = findRewardViewPush(rewardPushes, "REWARD_PENALTY_LEDGER_UPDATED");
    const burnedPush = findRewardViewPush(rewardPushes, "REWARD_BURNED");
    const rewardPenaltyAppliedTopic = topicHash("RewardLiquidationPenaltyApplied(address,address,uint256,uint256)").toLowerCase();
    const rewardPenaltyFailedTopic = topicHash("RewardLiquidationPenaltyApplyFailed(address,address,bytes,uint256)").toLowerCase();
    const gfmPenaltyAppliedLog = (liquidationReceipt.logs ?? []).find((log: any) => String(log.topics?.[0] ?? "").toLowerCase() === rewardPenaltyAppliedTopic) as any;
    const gfmPenaltyFailedLog = (liquidationReceipt.logs ?? []).find((log: any) => String(log.topics?.[0] ?? "").toLowerCase() === rewardPenaltyFailedTopic) as any;
    if (gfmPenaltyFailedLog) {
      throw new Error("GuaranteeFundManager emitted RewardLiquidationPenaltyApplyFailed during default penalty path");
    }
    if (!gfmPenaltyAppliedLog) {
      if (strictObservability) {
        throw new Error("missing GuaranteeFundManager RewardLiquidationPenaltyApplied event on default penalty path");
      }
      notice("guarantee-default runtime layer: missing GuaranteeFundManager RewardLiquidationPenaltyApplied event");
    }

    const rewardAccrualPenaltyTopic = reward.rewardAccrualManager.interface.getEvent("PenaltyApplied").topicHash.toLowerCase();
    const rewardAccrualPenaltyLog = (liquidationReceipt.logs ?? []).find(
      (log: any) =>
        String(log.address ?? "").toLowerCase() === reward.rewardAccrualManagerAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === rewardAccrualPenaltyTopic,
    ) as any;
    if (!rewardAccrualPenaltyLog) {
      if (strictObservability) {
        throw new Error(
          `missing RewardAccrualManager PenaltyApplied event on guarantee-default path\n${summarizeRewardRelevantLogs(ctx, reward, liquidationReceipt)}`,
        );
      }
      notice("guarantee-default runtime layer: missing RewardAccrualManager PenaltyApplied event");
    }

    const positivePenaltyState = afterReward.pendingPenalty > beforeReward.pendingPenalty
      || afterReward.totalBurned > beforeReward.totalBurned;
    if (!positivePenaltyState) {
      throw new Error(
        `guarantee-default penalty path did not change RewardView penalty/burn state: pending ${beforeReward.pendingPenalty} -> ${afterReward.pendingPenalty}, burned ${beforeReward.totalBurned} -> ${afterReward.totalBurned}`,
      );
    }
    if (!penaltyPush && !burnedPush) {
      if (strictObservability) {
        throw new Error("guarantee-default penalty path emitted neither RewardView REWARD_PENALTY_LEDGER_UPDATED nor REWARD_BURNED push");
      }
      notice("guarantee-default runtime layer: missing RewardView penalty/burn DataPushed evidence");
    }

    const liquidationUpdateTopic = liquidatorView.interface.getEvent("DataPushed").topicHash.toLowerCase();
    const liquidatorLogs = (liquidationReceipt.logs ?? []).filter(
      (log: any) =>
        String(log.address ?? "").toLowerCase() === liquidationViewAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === liquidationUpdateTopic,
    );
    if (liquidatorLogs.length === 0) {
      if (strictObservability) {
        throw new Error("expected LiquidatorView DataPushed log on guarantee-default liquidation receipt");
      }
      notice("guarantee-default runtime layer: missing LiquidatorView DataPushed log on liquidation receipt");
    }

    await observeExtendedViews(ctx, "platform-baseline-liquidation-after");
    console.log(
      `  [PlatformBaseline.Liquidation] orderId=${finalized.orderId.toString()} guaranteeBefore=${beforeGuarantee.locked.toString()} guaranteeAfterBorrow=${afterBorrowGuarantee.locked.toString()} guaranteeAfter=${afterGuarantee.locked.toString()} pendingPenalty=${beforeReward.pendingPenalty.toString()}->${afterReward.pendingPenalty.toString()} totalBurned=${beforeReward.totalBurned.toString()}->${afterReward.totalBurned.toString()} debt=${debtBefore.toString()}->${debtAfter.toString()}`,
    );

    return {
      orderId: finalized.orderId,
      penaltyDelta: afterReward.pendingPenalty - beforeReward.pendingPenalty,
      burnedDelta: afterReward.totalBurned - beforeReward.totalBurned,
      debtBefore,
      debtAfter,
    } satisfies LiquidationFlowSummary;
  } finally {
    if (!wasEnabled) {
      await (await ergmAdmin.setGuaranteeEnabled(ctx.borrowAssetAddr, false)).wait();
    }
  }
}

async function runLayer(layer: PlatformBaselineLayer) {
  console.log(`=== Live Platform Baseline Layer: ${layer} ===`);
  const normal = await runNormalRepayBranch(layer);
  const liquidation = await runGuaranteeDefaultBranch(layer);

  console.log(
    `  [PlatformBaseline.${layer}] normalOrder=${normal.orderId.toString()} liquidationOrder=${liquidation.orderId.toString()} easyEarnedDelta=${normal.easyEarnedDelta.toString()} easySpentDelta=${normal.easySpentDelta.toString()} easySpendSequenceSkipped=${normal.easySpendSequenceSkipped} penaltyDelta=${liquidation.penaltyDelta.toString()} burnedDelta=${liquidation.burnedDelta.toString()} debt=${liquidation.debtBefore.toString()}->${liquidation.debtAfter.toString()}`,
  );
}

async function main() {
  await runLiveDomainPreflight("platform");
  const mode = resolvePlatformBaselineMode();
  if (mode === "all") {
    await runLayer("runtime");
    await runLayer("observability");
  } else {
    await runLayer(mode);
  }
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), main);
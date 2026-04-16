import { ethers, network } from "hardhat";

import { envBool, envStr } from "../../../../_addressResolver";
import { decodeRevert } from "../../../../../utils/decodeRevert";
import {
  bootstrapFundsFlowLiveTest,
  formatLoanStatus,
  type FundsFlowLiveContext,
  getGuaranteeState,
  getLoanNftViewStatus,
  getOrderLifecycleStatus,
  getOrderForView,
  LOAN_STATUS,
  waitForPostWriteOrderReadConvergence,
} from "../core/_fundsFlowLive";
import { isRetryableNetworkError, runWithNetworkRetry } from "../core/_networkRetry";
import { readSeededLiquidationLog, seedLiquidatableOrder } from "../core/_liquidationSeed";
import { key } from "../core/_mockLiveUtils";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

function topicHash(signature: string) {
  return ethers.id(signature).toLowerCase();
}

function extractRevertData(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as Record<string, any>;
  const direct = candidate.data;
  if (typeof direct === "string" && direct.startsWith("0x")) {
    return direct;
  }
  const nestedError = candidate.error;
  if (nestedError && typeof nestedError === "object") {
    const nestedData = (nestedError as Record<string, any>).data;
    if (typeof nestedData === "string" && nestedData.startsWith("0x")) {
      return nestedData;
    }
  }
  const info = candidate.info;
  if (info && typeof info === "object") {
    const infoData = (info as Record<string, any>).data;
    if (typeof infoData === "string" && infoData.startsWith("0x")) {
      return infoData;
    }
    const infoError = (info as Record<string, any>).error;
    if (infoError && typeof infoError === "object") {
      const infoErrorData = (infoError as Record<string, any>).data;
      if (typeof infoErrorData === "string" && infoErrorData.startsWith("0x")) {
        return infoErrorData;
      }
    }
  }
  return undefined;
}

function describeRevert(error: unknown) {
  const revertData = extractRevertData(error);
  if (revertData) {
    return `${decodeRevert(revertData)} raw=${revertData}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function expectRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
}

function expectBigintEq(label: string, actual: bigint, expected: bigint) {
  if (actual !== expected) {
    throw new Error(`${label}: expected=${expected.toString()} actual=${actual.toString()}`);
  }
}

function expectAddressEq(label: string, actual: string, expected: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label}: expected=${expected} actual=${actual}`);
  }
}

function expectedTerminalStatuses(isOverdue: boolean) {
  if (isOverdue) {
    return { clean: LOAN_STATUS.Defaulted, withShortfall: LOAN_STATUS.DefaultedWithShortfall };
  }
  return { clean: LOAN_STATUS.Liquidated, withShortfall: LOAN_STATUS.LiquidatedWithShortfall };
}

type DecodedPushes = {
  update: {
    user: string;
    collateralAsset: string;
    debtAsset: string;
    collateralAmount: bigint;
    debtAmount: bigint;
    liquidator: string;
    bonus: bigint;
    blockNumber: bigint;
  };
  payout: {
    user: string;
    collateralAsset: string;
    platform: string;
    reserve: string;
    lender: string;
    liquidator: string;
    platformShare: bigint;
    reserveShare: bigint;
    lenderShare: bigint;
    liquidatorShare: bigint;
    blockNumber: bigint;
  };
};

function decodeTrackedPushes(liquidatorView: any, receipt: any): DecodedPushes {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const pushTopic = liquidatorView.interface.getEvent("DataPushed").topicHash.toLowerCase();
  const updateType = key("LIQUIDATION_UPDATE").toLowerCase();
  const payoutType = key("LIQUIDATION_PAYOUT").toLowerCase();
  const trackedLogs = (receipt.logs ?? [])
    .filter(
      (log: any) =>
        String(log.topics?.[0] ?? "").toLowerCase() === pushTopic
        && (String(log.topics?.[1] ?? "").toLowerCase() === updateType || String(log.topics?.[1] ?? "").toLowerCase() === payoutType),
    )
    .map((log: any) => liquidatorView.interface.parseLog({ topics: log.topics, data: log.data }));

  const updatePush = trackedLogs.find((entry: any) => entry && String(entry.args[0]).toLowerCase() === updateType);
  const payoutPush = trackedLogs.find((entry: any) => entry && String(entry.args[0]).toLowerCase() === payoutType);
  if (!updatePush) {
    throw new Error("missing LIQUIDATION_UPDATE DataPushed");
  }
  if (!payoutPush) {
    throw new Error("missing LIQUIDATION_PAYOUT DataPushed");
  }

  const updatePayload = abiCoder.decode(
    ["address", "address", "address", "uint256", "uint256", "address", "uint256", "uint256"],
    updatePush.args[1],
  );
  const payoutPayload = abiCoder.decode(
    ["address", "address", "address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
    payoutPush.args[1],
  );

  return {
    update: {
      user: String(updatePayload[0]),
      collateralAsset: String(updatePayload[1]),
      debtAsset: String(updatePayload[2]),
      collateralAmount: BigInt(updatePayload[3]),
      debtAmount: BigInt(updatePayload[4]),
      liquidator: String(updatePayload[5]),
      bonus: BigInt(updatePayload[6]),
      blockNumber: BigInt(updatePayload[7]),
    },
    payout: {
      user: String(payoutPayload[0]),
      collateralAsset: String(payoutPayload[1]),
      platform: String(payoutPayload[2]),
      reserve: String(payoutPayload[3]),
      lender: String(payoutPayload[4]),
      liquidator: String(payoutPayload[5]),
      platformShare: BigInt(payoutPayload[6]),
      reserveShare: BigInt(payoutPayload[7]),
      lenderShare: BigInt(payoutPayload[8]),
      liquidatorShare: BigInt(payoutPayload[9]),
      blockNumber: BigInt(payoutPayload[10]),
    },
  };
}

function compareParity(mainPath: DecodedPushes, fallbackPath: DecodedPushes) {
  expectAddressEq("main/fallback collateralAsset", fallbackPath.update.collateralAsset, mainPath.update.collateralAsset);
  expectAddressEq("main/fallback debtAsset", fallbackPath.update.debtAsset, mainPath.update.debtAsset);
  expectAddressEq("main/fallback liquidator", fallbackPath.update.liquidator, mainPath.update.liquidator);
  expectBigintEq("main/fallback collateralAmount", fallbackPath.update.collateralAmount, mainPath.update.collateralAmount);
  expectBigintEq("main/fallback debtAmount", fallbackPath.update.debtAmount, mainPath.update.debtAmount);
  expectBigintEq("main/fallback bonus", fallbackPath.update.bonus, mainPath.update.bonus);

  expectAddressEq("main/fallback payout collateralAsset", fallbackPath.payout.collateralAsset, mainPath.payout.collateralAsset);
  expectAddressEq("main/fallback payout platform", fallbackPath.payout.platform, mainPath.payout.platform);
  expectAddressEq("main/fallback payout reserve", fallbackPath.payout.reserve, mainPath.payout.reserve);
  expectAddressEq("main/fallback payout lender", fallbackPath.payout.lender, mainPath.payout.lender);
  expectAddressEq("main/fallback payout liquidator", fallbackPath.payout.liquidator, mainPath.payout.liquidator);
  expectBigintEq("main/fallback payout platformShare", fallbackPath.payout.platformShare, mainPath.payout.platformShare);
  expectBigintEq("main/fallback payout reserveShare", fallbackPath.payout.reserveShare, mainPath.payout.reserveShare);
  expectBigintEq("main/fallback payout lenderShare", fallbackPath.payout.lenderShare, mainPath.payout.lenderShare);
  expectBigintEq("main/fallback payout liquidatorShare", fallbackPath.payout.liquidatorShare, mainPath.payout.liquidatorShare);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSignerNativeBalance(
  ctx: FundsFlowLiveContext,
  target: { address: string },
  requiredBalanceWei: bigint,
  label: string,
) {
  const beforeBalance = await ethers.provider.getBalance(target.address);
  if (beforeBalance >= requiredBalanceWei) {
    return beforeBalance;
  }

  const sponsorReserve = ethers.parseEther(envStr("LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH") ?? "0.0002");
  let remainingTopUp: bigint = requiredBalanceWei - beforeBalance;
  const seenSponsors = new Set<string>();
  const sponsors = [ctx.lender, ctx.viewer, ctx.updater].filter((signer): signer is NonNullable<typeof signer> => {
    if (!signer?.address) {
      return false;
    }
    const signerKey = signer.address.toLowerCase();
    if (signerKey === target.address.toLowerCase() || seenSponsors.has(signerKey)) {
      return false;
    }
    seenSponsors.add(signerKey);
    return true;
  });

  for (const sponsor of sponsors) {
    if (remainingTopUp === 0n) {
      break;
    }
    const sponsorBalance = await ethers.provider.getBalance(sponsor.address);
    const affordableTopUp = sponsorBalance > sponsorReserve ? sponsorBalance - sponsorReserve : 0n;
    const topUpAmount = BigInt(remainingTopUp > affordableTopUp ? affordableTopUp : remainingTopUp);
    if (topUpAmount === 0n) {
      continue;
    }
    await (await sponsor.sendTransaction({ to: target.address, value: topUpAmount })).wait();
    remainingTopUp -= topUpAmount;
  }

  const finalBalance = await ethers.provider.getBalance(target.address);
  console.log(
    `  [FallbackCheck] nativeTopUp label=${label} before=${ethers.formatEther(beforeBalance)} after=${ethers.formatEther(finalBalance)} required=${ethers.formatEther(requiredBalanceWei)}`,
  );
  if (finalBalance < requiredBalanceWei) {
    throw new Error(
      `${label}: insufficient native balance for fallback execution: have=${ethers.formatEther(finalBalance)} ETH required=${ethers.formatEther(requiredBalanceWei)} ETH`,
    );
  }
  return finalBalance;
}

async function refreshPrice(ctx: FundsFlowLiveContext, asset: string, label: string) {
  const nowBlock = BigInt(await ethers.provider.getBlockNumber());
  const [price, priceBlock] = (await ctx.priceOracle.getPrice(asset)) as [bigint, bigint, bigint];
  if (price === 0n || priceBlock === 0n) {
    throw new Error(`${label}: price oracle returned zero/invalid price for asset ${asset}`);
  }
  const hasUpdatePrice = (await ctx.acm.hasRole(key("UPDATE_PRICE"), ctx.relayer.address)) as boolean;
  if (!hasUpdatePrice) {
    throw new Error(`relayer ${ctx.relayer.address} lacks UPDATE_PRICE role required by keeper refresh runbook`);
  }
  if (ctx.updater) {
    await (await ctx.updater.connect(ctx.relayer).updateAssetPrice(asset, price, nowBlock)).wait();
    return;
  }
  if (!ctx.allowDirectOraclePriceWrite) {
    throw new Error(`${label}: PriceUpdater is unavailable and direct oracle writes are disabled`);
  }
  await (await ctx.priceOracle.connect(ctx.relayer).updatePrice(asset, price, nowBlock)).wait();
}

async function mineTo(targetBlock: bigint) {
  const current = BigInt(await ethers.provider.getBlockNumber());
  if (current >= targetBlock) {
    return;
  }
  const delta = targetBlock - current;
  try {
    await network.provider.send("hardhat_mine", [`0x${delta.toString(16)}`]);
  } catch {
    for (let remaining = delta; remaining > 0n; remaining -= 1n) {
      await network.provider.send("evm_mine", []);
    }
  }
}

export async function runLiquidationFallbackParity() {
  const configuredOrderId = envStr("LIQUIDATION_FALLBACK_ORDER_ID");
  const configuredSeedLogFile = envStr("LIQUIDATION_FALLBACK_SEED_LOG_FILE");
  const allowRiskTriggeredConfiguredOrder = envBool("LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER", false);
  const supportsParityComparison = !configuredOrderId && !configuredSeedLogFile;
  const { ctx } = await bootstrapFundsFlowLiveTest({
    label: "Live Liquidation Fallback",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  const hasActionLiquidate = (await ctx.acm.hasRole(key("LIQUIDATE"), ctx.relayer.address)) as boolean;
  const hasActionAdmin = (await ctx.acm.hasRole(key("ACTION_ADMIN"), ctx.relayer.address)) as boolean;
  if (!hasActionLiquidate) {
    throw new Error(`relayer ${ctx.relayer.address} lacks LIQUIDATE role required by SettlementManager`);
  }
  if (!hasActionAdmin) {
    throw new Error(`relayer ${ctx.relayer.address} lacks ACTION_ADMIN role required to pause LiquidationManager`);
  }
  if (network.name !== "localhost" && network.name !== "hardhat" && !envBool("ALLOW_LIQUIDATION_MANAGER_PAUSE", false)) {
    throw new Error("set ALLOW_LIQUIDATION_MANAGER_PAUSE=1 before pausing LiquidationManager on a non-local network");
  }

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const settlementManagerAddr = ctx.settlementManagerAddr;
  const liquidationManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"))) as string;
  const liquidationViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
  const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const liquidationPayoutManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_PAYOUT_MANAGER"))) as string;
  const feeRouterAddr = ctx.feeRouterAddr;

  const liquidationPayoutManager = (await ethers.getContractAt(
    [
      "function calculateShares(uint256 collateralAmount) view returns (uint256,uint256,uint256,uint256)",
      "function getRecipients() view returns ((address platform,address reserve,address lenderCompensation))",
    ],
    liquidationPayoutManagerAddr,
    ctx.viewer,
  )) as any;
  const collateralManager = (await ethers.getContractAt(
    ["function getCollateral(address user,address asset) view returns (uint256)"],
    ctx.collateralManagerAddr,
    ctx.viewer,
  )) as any;
  const feeRouter = (await ethers.getContractAt(
    [
      "function getPlatformTreasury() view returns (address)",
      "function getEcosystemVault() view returns (address)",
      "function isTokenSupported(address token) view returns (bool)",
      "function addSupportedToken(address token)",
    ],
    feeRouterAddr,
    ctx.relayer,
  )) as any;
  const collateralToken = (await ethers.getContractAt(
    ["function balanceOf(address account) view returns (uint256)"],
    ctx.collateralAssetAddr,
    ctx.viewer,
  )) as any;

  const settlementManagerHasLiquidateRole = (await ctx.acm.hasRole(key("LIQUIDATE"), settlementManagerAddr)) as boolean;
  if (!settlementManagerHasLiquidateRole) {
    try {
      await (await ctx.acm.connect(ctx.relayer).grantRole(key("LIQUIDATE"), settlementManagerAddr)).wait();
    } catch {
      // fall through to explicit verification below
    }
  }
  if (!((await ctx.acm.hasRole(key("LIQUIDATE"), settlementManagerAddr)) as boolean)) {
    throw new Error(`SettlementManager ${settlementManagerAddr} lacks LIQUIDATE role required for fallback collateral exits`);
  }

  const settlementManagerHasDepositRole = (await ctx.acm.hasRole(key("DEPOSIT"), settlementManagerAddr)) as boolean;
  if (!settlementManagerHasDepositRole) {
    try {
      await (await ctx.acm.connect(ctx.relayer).grantRole(key("DEPOSIT"), settlementManagerAddr)).wait();
    } catch {
      // fall through to explicit verification below
    }
  }
  if (!((await ctx.acm.hasRole(key("DEPOSIT"), settlementManagerAddr)) as boolean)) {
    throw new Error(`SettlementManager ${settlementManagerAddr} lacks DEPOSIT role required for FeeRouter.distributePrepaid`);
  }

  let orderId: bigint;
  let borrowerAddr: string;
  let allowRiskTriggeredOrder = allowRiskTriggeredConfiguredOrder;
  if (configuredOrderId) {
    orderId = BigInt(configuredOrderId);
    borrowerAddr = ethers.ZeroAddress;
  } else if (configuredSeedLogFile) {
    const seeded = readSeededLiquidationLog(configuredSeedLogFile);
    orderId = seeded.orderId;
    borrowerAddr = seeded.borrower;
    allowRiskTriggeredOrder = seeded.acceptRiskTriggeredOrder;
    console.log(`  [FallbackCheck] using seeded fallback order from ${configuredSeedLogFile}: orderId=${orderId.toString()} borrower=${borrowerAddr}`);
  } else {
    const seeded = await seedLiquidatableOrder({
      label: "Seed Liquidatable Fallback Order",
      noticeLabel: "using fresh seeded liquidation-fallback borrower",
      collateralAmountUnitsDefault: "10",
      borrowAmountUnitsDefault: "1200",
    });
    orderId = seeded.orderId;
    borrowerAddr = seeded.borrower;
    allowRiskTriggeredOrder = seeded.acceptRiskTriggeredOrder;
    console.log(`  [FallbackCheck] auto-seeded isolated fallback orderId=${orderId.toString()} borrower=${borrowerAddr}`);
  }

  const existingOrder = await getOrderForView(ctx, orderId);
  if (!existingOrder.borrower || existingOrder.borrower === ethers.ZeroAddress || !existingOrder.asset || existingOrder.asset === ethers.ZeroAddress) {
    throw new Error(
      `configured fallback liquidation order is stale or missing on current registry: orderId=${orderId.toString()} registry=${ctx.registryAddr} borrower=${String(existingOrder.borrower)} asset=${String(existingOrder.asset)}`,
    );
  }
  borrowerAddr = existingOrder.borrower;
  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  if (currentBlock <= existingOrder.maturity && !allowRiskTriggeredOrder) {
    throw new Error(
      `configured fallback liquidation order is not overdue: currentBlock=${currentBlock.toString()} maturity=${existingOrder.maturity.toString()}`,
    );
  }
  if (currentBlock <= existingOrder.maturity && allowRiskTriggeredOrder) {
    console.log(
      `  [Notice] fallback order is not overdue but risk-triggered execution is allowed: orderId=${orderId.toString()} maturity=${existingOrder.maturity.toString()} currentBlock=${currentBlock.toString()}`,
    );
  }

  await refreshPrice(ctx, ctx.borrowAssetAddr, "fallback-debt-asset");
  await refreshPrice(ctx, ctx.collateralAssetAddr, "fallback-collateral-asset");

  const lendingEngine = (await ethers.getContractAt(
    ["function getDebt(address user,address asset) view returns (uint256)", "function getReducibleDebtAmount(address user,address asset) view returns (uint256)"],
    lendingEngineAddr,
  )) as any;
  const settlementManager = (await ethers.getContractAt(
    [
      "event LiquidationManagerFallbackActivated(uint256 indexed orderId,address indexed user,address indexed collateralAsset,address debtAsset,address liquidator,bytes reason,uint256 blockNumber)",
      "event FallbackPayoutExecuted(address indexed user,address indexed collateralAsset,address platform,address reserve,address lenderCompensation,address indexed liquidator,uint256 platformShare,uint256 reserveShare,uint256 lenderShare,uint256 liquidatorShare)",
      "function settleOrLiquidate(uint256 orderId)",
      "function hasActiveShortfall(uint256 orderId) view returns (bool)",
      "function getShortfallLedger(uint256 orderId) view returns ((uint8 status,address borrower,address debtAsset,address collateralAsset,uint8 pricingMode,uint8 recoverySource,uint256 liquidationBlock,uint256 valuationBlock,uint256 coveredDebt,uint256 remainingDebt,uint256 shortfallAmount,uint256 recoveredAmount,uint256 lastRecoveryBlock,bytes32 evidenceHash))",
    ],
    settlementManagerAddr,
    ctx.relayer,
  )) as any;
  const liquidationManager = (await ethers.getContractAt(
    ["function pause()", "function unpause()", "function paused() view returns (bool)"],
    liquidationManagerAddr,
    ctx.relayer,
  )) as any;
  const liquidatorView = (await ethers.getContractAt(
    ["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"],
    liquidationViewAddr,
    ctx.viewer,
  )) as any;

  let mainPathPushes: DecodedPushes | undefined;
  if (supportsParityComparison) {
    const mainPathSeed = await seedLiquidatableOrder({
      label: "Seed Liquidatable Main-Path Order",
      noticeLabel: "using fresh seeded liquidation main-path borrower",
      collateralAmountUnitsDefault: "10",
      borrowAmountUnitsDefault: "1200",
    });
    console.log(`  [ParityCheck] main-path seeded orderId=${mainPathSeed.orderId.toString()} borrower=${mainPathSeed.borrower}`);

    const mainReceipt = await (
      await settlementManager.connect(ctx.relayer).settleOrLiquidate(mainPathSeed.orderId)
    ).wait();
    await waitForPostWriteOrderReadConvergence(ctx, mainPathSeed.orderId, "settleOrLiquidate", mainReceipt.blockNumber);
    const mainPathOrderBefore = await getOrderForView(ctx, mainPathSeed.orderId);
    const mainDebtAfter = (await lendingEngine.getDebt(mainPathSeed.borrower, ctx.borrowAssetAddr)) as bigint;
    const mainExplicitStatus = await getOrderLifecycleStatus(ctx, mainPathSeed.orderId);
    const mainLoanNftStatus = await getLoanNftViewStatus(ctx, mainPathSeed.borrower, mainPathSeed.orderId);
    const mainHasShortfall = (await settlementManager.hasActiveShortfall(mainPathSeed.orderId)) as boolean;
    const mainTerminalStatuses = expectedTerminalStatuses(BigInt(mainReceipt.blockNumber) > mainPathOrderBefore.maturity);
    if (mainExplicitStatus !== mainTerminalStatuses.clean && mainExplicitStatus !== mainTerminalStatuses.withShortfall) {
      throw new Error(
        `unexpected main-path order terminal status: status=${formatLoanStatus(mainExplicitStatus)} expected=${formatLoanStatus(mainTerminalStatuses.clean)}|${formatLoanStatus(mainTerminalStatuses.withShortfall)}`,
      );
    }
    expectBigintEq("main-path LoanNFTView status", mainLoanNftStatus, mainExplicitStatus);
    if (mainExplicitStatus === mainTerminalStatuses.withShortfall) {
      if (!mainHasShortfall) {
        throw new Error("main-path with-shortfall order status requires an active shortfall ledger");
      }
      const mainShortfallLedger = await settlementManager.getShortfallLedger(mainPathSeed.orderId);
      expectBigintEq("main-path shortfall remaining debt", BigInt(mainShortfallLedger.remainingDebt), mainDebtAfter);
      expectBigintEq("main-path shortfall pricingMode", BigInt(mainShortfallLedger.pricingMode), 0n);
    } else {
      if (mainHasShortfall) {
        throw new Error("main-path clean terminal status should not leave an active shortfall ledger");
      }
      expectBigintEq("main-path debt after clean liquidation", mainDebtAfter, 0n);
    }
    const fallbackTopic = settlementManager.interface.getEvent("LiquidationManagerFallbackActivated").topicHash.toLowerCase();
    const fallbackLog = (mainReceipt.logs ?? []).find(
      (log: any) =>
        log.address.toLowerCase() === ctx.settlementManagerAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === fallbackTopic,
    );
    if (fallbackLog) {
      throw new Error("main-path parity run unexpectedly entered SettlementManager fallback");
    }
    mainPathPushes = decodeTrackedPushes(liquidatorView, mainReceipt);
    expectAddressEq("main-path update borrower", mainPathPushes.update.user, mainPathSeed.borrower);
    expectAddressEq("main-path payout borrower", mainPathPushes.payout.user, mainPathSeed.borrower);
    console.log(
      `  [StateMachine] main-path orderStatus=${formatLoanStatus(mainExplicitStatus)} loanNftStatus=${formatLoanStatus(mainLoanNftStatus)}`,
    );
  }

  const debtBefore = (await lendingEngine.getDebt(borrowerAddr, ctx.borrowAssetAddr)) as bigint;
  const reducibleBefore = (await lendingEngine.getReducibleDebtAmount(borrowerAddr, ctx.borrowAssetAddr)) as bigint;
  if (debtBefore === 0n || reducibleBefore === 0n) {
    throw new Error("fallback liquidation requires active reducible debt");
  }

  const guaranteeState = await getGuaranteeState(ctx, borrowerAddr, ctx.borrowAssetAddr);
  const collateralBalanceBefore = (await collateralManager.getCollateral(borrowerAddr, ctx.collateralAssetAddr)) as bigint;
  const [platformShare] = (await liquidationPayoutManager.calculateShares(collateralBalanceBefore)) as [bigint, bigint, bigint, bigint];
  const payoutRecipients = await liquidationPayoutManager.getRecipients();
  const feeRouterPlatformTreasury = (await feeRouter.getPlatformTreasury()) as string;
  const feeRouterEcosystemVault = (await feeRouter.getEcosystemVault()) as string;
  const guaranteeFundTokenBalance = ctx.guaranteeFundAddr && ctx.guaranteeFundAddr !== ethers.ZeroAddress
    ? (await ctx.borrowToken.balanceOf(ctx.guaranteeFundAddr)) as bigint
    : 0n;
  const feeRouterCollateralBalanceBefore = (await collateralToken.balanceOf(feeRouterAddr)) as bigint;

  console.log(`  [FallbackCheck] orderId=${orderId.toString()} borrower=${borrowerAddr}`);
  console.log(
    `  [FallbackCheck] debtBefore=${debtBefore.toString()} reducibleBefore=${reducibleBefore.toString()} collateralBefore=${collateralBalanceBefore.toString()}`,
  );
  console.log(
    `  [FallbackCheck] payoutRecipients platform=${String(payoutRecipients.platform)} reserve=${String(payoutRecipients.reserve)} lenderCompensation=${String(payoutRecipients.lenderCompensation)}`,
  );
  console.log(
    `  [FallbackCheck] feeRouter platformTreasury=${feeRouterPlatformTreasury} ecosystemVault=${feeRouterEcosystemVault} collateralBalanceBefore=${feeRouterCollateralBalanceBefore.toString()}`,
  );
  console.log(
    `  [FallbackCheck] guarantee enabled=${guaranteeState.enabled} active=${guaranteeState.active} guaranteeId=${guaranteeState.guaranteeId.toString()} locked=${guaranteeState.locked.toString()} promisedInterest=${guaranteeState.record?.promisedInterest?.toString() ?? "0"} gfmTokenBalance=${guaranteeFundTokenBalance.toString()}`,
  );

  if (
    guaranteeState.enabled
    && guaranteeState.active
    && guaranteeState.record
    && guaranteeState.locked < guaranteeState.record.promisedInterest
  ) {
    throw new Error(
      `active guarantee underfunded for fallback default: locked=${guaranteeState.locked.toString()} promisedInterest=${guaranteeState.record.promisedInterest.toString()}`,
    );
  }

  if (platformShare > 0n) {
    const collateralTokenSupported = (await feeRouter.isTokenSupported(ctx.collateralAssetAddr)) as boolean;
    if (!collateralTokenSupported) {
      const relayerHasSetParameter = (await ctx.acm.hasRole(key("SET_PARAMETER"), ctx.relayer.address)) as boolean;
      if (!relayerHasSetParameter) {
        throw new Error(
          `FeeRouter does not support collateral asset ${ctx.collateralAssetAddr} and relayer ${ctx.relayer.address} lacks SET_PARAMETER role to add it`,
        );
      }
      await (await feeRouter.connect(ctx.relayer).addSupportedToken(ctx.collateralAssetAddr)).wait();
    }
    if (!((await feeRouter.isTokenSupported(ctx.collateralAssetAddr)) as boolean)) {
      throw new Error(`FeeRouter does not support collateral asset ${ctx.collateralAssetAddr} required for fallback platform-share prepaid routing`);
    }
  }

  try {
    await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(orderId);
  } catch (error) {
    console.log(
      `  [Notice] pre-pause settleOrLiquidate.staticCall reverted; continuing to paused fallback validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let paused = false;
  let passed = false;
  try {
      const pausedBefore = (await liquidationManager.paused()) as boolean;
      if (pausedBefore) {
        console.log("  [FallbackCheck] liquidationManager already paused before test; reusing paused state");
        paused = true;
      } else {
        try {
          await liquidationManager.connect(ctx.relayer).pause.staticCall();
        } catch (error) {
          throw new Error(
            `LiquidationManager.pause preflight reverted: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await (await liquidationManager.connect(ctx.relayer).pause()).wait();
        paused = true;
      }

    let fallbackGasLimit = 5_000_000n;
    try {
      const estimated = await settlementManager.connect(ctx.relayer).settleOrLiquidate.estimateGas(orderId);
      const buffered = (estimated * 12n) / 10n + 250_000n;
      fallbackGasLimit = buffered > fallbackGasLimit ? buffered : fallbackGasLimit;
      console.log(`  [FallbackCheck] paused-path gasEstimate=${estimated.toString()} gasLimit=${fallbackGasLimit.toString()}`);
    } catch (error) {
      console.log(
        `  [Notice] paused-path gas estimate failed; using fallback gasLimit=${fallbackGasLimit.toString()}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(orderId);
    } catch (error) {
      throw new Error(`paused-path settleOrLiquidate.staticCall reverted: ${describeRevert(error)}`);
    }

    const feeData = await ethers.provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!maxFeePerGas || maxFeePerGas <= 0n) {
      throw new Error("unable to determine maxFeePerGas for fallback native balance check");
    }
    const requiredNativeBalance = fallbackGasLimit * maxFeePerGas + ethers.parseEther("0.00005");
    await ensureSignerNativeBalance(ctx, ctx.relayer, requiredNativeBalance, "fallback relayer gas reserve");

    const liquidationReceipt = await (
      await settlementManager.connect(ctx.relayer).settleOrLiquidate(orderId, { gasLimit: fallbackGasLimit })
    ).wait();
    await waitForPostWriteOrderReadConvergence(ctx, orderId, "settleOrLiquidate", liquidationReceipt.blockNumber);
    const fallbackTopic = settlementManager.interface.getEvent("LiquidationManagerFallbackActivated").topicHash.toLowerCase();
    const fallbackLog = (liquidationReceipt.logs ?? []).find(
      (log: any) =>
        log.address.toLowerCase() === ctx.settlementManagerAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase() === fallbackTopic,
    );
    if (!fallbackLog) {
      throw new Error("missing LiquidationManagerFallbackActivated event");
    }

    const fallbackPayoutLog = (liquidationReceipt.logs ?? [])
      .map((log: any) => {
        try {
          return settlementManager.interface.parseLog({ topics: log.topics, data: log.data });
        } catch {
          return undefined;
        }
      })
      .find((entry: any) => entry?.name === "FallbackPayoutExecuted");
    if (!fallbackPayoutLog) {
      throw new Error("missing FallbackPayoutExecuted event");
    }

    const fallbackPushes = decodeTrackedPushes(liquidatorView, liquidationReceipt);
    expectAddressEq("fallback update borrower", fallbackPushes.update.user, borrowerAddr);
    expectAddressEq("fallback payout borrower", fallbackPushes.payout.user, borrowerAddr);
    expectAddressEq("fallback payout liquidator", fallbackPushes.payout.liquidator, ctx.relayer.address);
    expectBigintEq("fallback payout platformShare", fallbackPushes.payout.platformShare, BigInt(fallbackPayoutLog.args.platformShare));
    expectBigintEq("fallback payout reserveShare", fallbackPushes.payout.reserveShare, BigInt(fallbackPayoutLog.args.reserveShare));
    expectBigintEq("fallback payout lenderShare", fallbackPushes.payout.lenderShare, BigInt(fallbackPayoutLog.args.lenderShare));
    expectBigintEq("fallback payout liquidatorShare", fallbackPushes.payout.liquidatorShare, BigInt(fallbackPayoutLog.args.liquidatorShare));

    if (mainPathPushes) {
      compareParity(mainPathPushes, fallbackPushes);
      console.log("  [ParityCheck] main-path and fallback LiquidatorView payloads are aligned for all economic fields");
    } else {
      console.log("  [ParityCheck] skipped cross-path comparison because a configured fallback order or seed log was provided");
    }

    const debtAfter = (await lendingEngine.getDebt(borrowerAddr, ctx.borrowAssetAddr)) as bigint;
    if (debtAfter > debtBefore) {
      throw new Error(`fallback liquidation increased debt: before=${debtBefore.toString()} after=${debtAfter.toString()}`);
    }
    expectBigintEq("fallback debt delta", debtBefore - debtAfter, reducibleBefore);

    const fallbackExplicitStatus = await getOrderLifecycleStatus(ctx, orderId);
    const fallbackLoanNftStatus = await getLoanNftViewStatus(ctx, borrowerAddr, orderId);
    const fallbackHasShortfall = (await settlementManager.hasActiveShortfall(orderId)) as boolean;
    const fallbackTerminalStatuses = expectedTerminalStatuses(BigInt(liquidationReceipt.blockNumber) > existingOrder.maturity);
    if (fallbackExplicitStatus !== fallbackTerminalStatuses.clean && fallbackExplicitStatus !== fallbackTerminalStatuses.withShortfall) {
      throw new Error(
        `unexpected fallback order terminal status: status=${formatLoanStatus(fallbackExplicitStatus)} expected=${formatLoanStatus(fallbackTerminalStatuses.clean)}|${formatLoanStatus(fallbackTerminalStatuses.withShortfall)}`,
      );
    }
    expectBigintEq("fallback LoanNFTView status", fallbackLoanNftStatus, fallbackExplicitStatus);
    if (fallbackExplicitStatus === fallbackTerminalStatuses.withShortfall) {
      if (!fallbackHasShortfall) {
        throw new Error("fallback with-shortfall order status requires an active shortfall ledger");
      }
      const fallbackShortfallLedger = await settlementManager.getShortfallLedger(orderId);
      expectBigintEq("fallback shortfall remaining debt", BigInt(fallbackShortfallLedger.remainingDebt), debtAfter);
      expectBigintEq("fallback shortfall pricingMode", BigInt(fallbackShortfallLedger.pricingMode), 0n);
    } else {
      if (fallbackHasShortfall) {
        throw new Error("fallback clean terminal status should not leave an active shortfall ledger");
      }
      expectBigintEq("fallback debt after clean liquidation", debtAfter, 0n);
    }
    console.log(
      `  [StateMachine] fallback orderStatus=${formatLoanStatus(fallbackExplicitStatus)} loanNftStatus=${formatLoanStatus(fallbackLoanNftStatus)}`,
    );

    passed = true;
  } finally {
    if (paused) {
      let unpauseError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          if (!((await liquidationManager.paused()) as boolean)) {
            unpauseError = undefined;
            break;
          }
          await (await liquidationManager.connect(ctx.relayer).unpause()).wait();
          unpauseError = undefined;
          break;
        } catch (error) {
          unpauseError = error;
          if (attempt >= 3 || !isRetryableNetworkError(error)) {
            break;
          }
          console.log(`  [Retry] liquidationManager.unpause network error on attempt ${attempt}/3: ${error instanceof Error ? error.message : String(error)}`);
          await sleep(1000 * attempt);
        }
      }
      if (unpauseError) {
        throw unpauseError;
      }
    }
  }

  if (passed) {
    logLiveScriptSuccess(__filename);
  }
}

export const liveScriptPromise = runWithNetworkRetry(resolveLiveScriptId(__filename), runLiquidationFallbackParity);
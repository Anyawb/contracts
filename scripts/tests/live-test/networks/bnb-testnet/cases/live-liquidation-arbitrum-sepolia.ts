import hre, { network } from "hardhat";

import { envBool, envStr } from "../../../../_addressResolver";
import { decodeRevert } from "../../../../../utils/decodeRevert";

import {
  assignFreshBorrower,
  bootstrapFundsFlowLiveTest,
  depositCollateral,
  finalizeSingleMatch,
  fundFundsFlowActors,
  type FundsFlowLiveContext,
  getOrderForView,
  observeExtendedViews,
  reserveForLending,
  waitForPostWriteOrderReadConvergence,
} from "../core/_fundsFlowLive";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { key, parseAssetBootstrapPrice } from "../core/_mockLiveUtils";
import { logLiveScriptSuccess, resolveLiveScriptId } from "../core/_scriptStatus";

const { ethers } = hre;

function topicHash(signature: string) {
  return ethers.id(signature);
}

function envInt(name: string, fallback: number) {
  const raw = envStr(name)?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function formatDecodedArg(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatDecodedArg(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function decodeFailureReason(reason: string, errorInterface?: any): string {
  if (!reason || reason === "0x") {
    return "Empty revert data";
  }

  try {
    const [label, nestedReason] = ethers.AbiCoder.defaultAbiCoder().decode(["string", "bytes"], reason);
    if (typeof label === "string" && typeof nestedReason === "string" && nestedReason !== "0x") {
      return `${label}: ${decodeFailureReason(nestedReason, errorInterface)}`;
    }
  } catch {
    // Not a nested abi.encode(string, bytes) payload.
  }

  if (errorInterface) {
    try {
      const parsed = errorInterface.parseError(reason);
      return `${parsed.name}(${parsed.args.toArray().map((value: unknown) => formatDecodedArg(value)).join(", ")})`;
    } catch {
      // Fall through to generic decoders.
    }
  }

  const decoded = decodeRevert(reason);
  if (!decoded.startsWith("Unknown selector:")) {
    return decoded;
  }

  try {
    const utf8 = ethers.toUtf8String(reason).replace(/\0/g, "").trim();
    if (utf8.length > 0) {
      return utf8;
    }
  } catch {
    // Raw bytes are not valid UTF-8.
  }

  return decoded;
}

function findAssetAmount(assets: string[], amounts: bigint[], asset: string) {
  const index = assets.findIndex((candidate) => candidate.toLowerCase() === asset.toLowerCase());
  return index >= 0 ? amounts[index] : 0n;
}

type LiquidationOrderSource = "configured" | "fresh" | "candidate";

type LiquidationReadiness = {
  orderId: bigint;
  borrower: string;
  currentBlock: bigint;
  maturity: bigint;
  debt: bigint;
  reducible: bigint;
  totalSeizable: bigint;
  liquidatable: boolean;
  metadataValid: boolean;
  riskScore: bigint;
  source: LiquidationOrderSource;
};

type ParsedDataPushLog = {
  address: string;
  parsed: any;
};

function formatLiquidationReadiness(params: {
  orderId: bigint;
  borrower: string;
  currentBlock: bigint;
  maturity: bigint;
  debt: bigint;
  reducible: bigint;
  totalSeizable: bigint;
  liquidatable: boolean;
  metadataValid: boolean;
  riskScore: bigint;
  source: LiquidationOrderSource;
}) {
  const blockers: string[] = [];
  if (params.currentBlock <= params.maturity) {
    blockers.push(`not overdue (currentBlock=${params.currentBlock.toString()} maturity=${params.maturity.toString()})`);
  }
  if (params.debt === 0n) {
    blockers.push("debt=0");
  }
  if (params.reducible === 0n) {
    blockers.push("reducibleDebt=0");
  }
  if (params.totalSeizable === 0n) {
    blockers.push("seizableCollateral=0");
  }
  if (!params.metadataValid) {
    blockers.push("LiquidationRiskView metadata invalid");
  }
  if (!params.liquidatable) {
    blockers.push(`LiquidationRiskView reports non-liquidatable (riskScore=${params.riskScore.toString()})`);
  }
  return `orderId=${params.orderId.toString()} source=${params.source} borrower=${params.borrower} blockers=[${blockers.join("; ") || "none"}]`;
}

function isGetLogsRangeLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("eth_getLogs")
    || message.includes("block range")
    || message.includes("max block range")
    || message.includes("Free tier")
    || message.includes("Upgrade to PAYG");
}

async function getLogsAdaptive(params: {
  address: string;
  topic0: string;
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<any[]> {
  try {
    return await ethers.provider.getLogs({
      address: params.address,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      topics: [params.topic0],
    });
  } catch (error) {
    if (!isGetLogsRangeLimitError(error) || params.fromBlock >= params.toBlock) {
      throw error;
    }
    const midpoint = (params.fromBlock + params.toBlock) / 2n;
    const left = await getLogsAdaptive({
      address: params.address,
      topic0: params.topic0,
      fromBlock: params.fromBlock,
      toBlock: midpoint,
    });
    const right = await getLogsAdaptive({
      address: params.address,
      topic0: params.topic0,
      fromBlock: midpoint + 1n,
      toBlock: params.toBlock,
    });
    return left.concat(right);
  }
}

async function collectRecentLoanOrderCandidates(params: {
  orderEngine: any;
  currentBlock: bigint;
  excludeOrderIds: bigint[];
}) {
  const lookbackBlocks = BigInt(envStr("LIQUIDATION_SEARCH_LOOKBACK_BLOCKS") ?? "250000");
  const chunkSize = BigInt(envStr("LIQUIDATION_SEARCH_CHUNK_BLOCKS") ?? "20000");
  const maxWindows = envInt(
    "LIQUIDATION_SEARCH_MAX_WINDOWS",
    chunkSize <= 9n ? 12 : 50,
  );
  const maxOrdersPerWindow = envInt(
    "LIQUIDATION_SEARCH_MAX_ORDERS_PER_WINDOW",
    chunkSize <= 9n ? 2 : 10,
  );
  const maxOrders = envInt(
    "LIQUIDATION_SEARCH_MAX_ORDERS",
    maxWindows * maxOrdersPerWindow,
  );
  const orderEngineAddr = await params.orderEngine.getAddress();
  const event = params.orderEngine.interface.getEvent("LoanOrderCreated");
  const topic0 = event.topicHash;
  const excluded = new Set(params.excludeOrderIds.map((value) => value.toString()));
  const discovered = new Map<string, { orderId: bigint; borrower: string; blockNumber: bigint }>();
  let fromBlock = params.currentBlock > lookbackBlocks ? params.currentBlock - lookbackBlocks + 1n : 0n;
  let chunkEnd = params.currentBlock;
  let scannedWindows = 0;

  while (chunkEnd >= fromBlock && discovered.size < maxOrders && scannedWindows < maxWindows) {
    const chunkStart = chunkEnd >= chunkSize - 1n ? chunkEnd - chunkSize + 1n : 0n;
    const boundedStart = chunkStart > fromBlock ? chunkStart : fromBlock;
    const logs = await getLogsAdaptive({
      address: orderEngineAddr,
      fromBlock: boundedStart,
      toBlock: chunkEnd,
      topic0,
    });
    let windowSelections = 0;
    const remainingBudget = maxOrders - discovered.size;
    const windowBudget = Math.min(maxOrdersPerWindow, remainingBudget);

    for (
      let index = logs.length - 1;
      index >= 0 && discovered.size < maxOrders && windowSelections < windowBudget;
      index -= 1
    ) {
      const log = logs[index];
      try {
        const parsed = params.orderEngine.interface.parseLog({ topics: log.topics, data: log.data });
        if (!parsed || parsed.name !== "LoanOrderCreated") {
          continue;
        }
        const orderId = BigInt(parsed.args.orderId);
        if (excluded.has(orderId.toString()) || discovered.has(orderId.toString())) {
          continue;
        }
        discovered.set(orderId.toString(), {
          orderId,
          borrower: String(parsed.args.borrower),
          blockNumber: BigInt(log.blockNumber),
        });
        windowSelections += 1;
      } catch {
        // ignore unrelated or malformed logs
      }
    }

    scannedWindows += 1;

    if (boundedStart === 0n) {
      break;
    }
    chunkEnd = boundedStart - 1n;
  }

  return Array.from(discovered.values());
}

async function ensureSignerNativeTopUp(params: {
  ctx: FundsFlowLiveContext;
  target: any;
  desiredBalanceWei: bigint;
  reserveWei: bigint;
  label: string;
}) {
  const beforeBalance = await ethers.provider.getBalance(params.target.address);
  if (beforeBalance >= params.desiredBalanceWei) {
    return beforeBalance;
  }

  const requiredTopUp = params.desiredBalanceWei - beforeBalance;
  const seenSponsors = new Set<string>();
  const sponsors = [params.ctx.relayer, params.ctx.lender, params.ctx.viewer, params.ctx.updater].filter(
    (signer): signer is NonNullable<typeof signer> => {
      if (!signer?.address) {
        return false;
      }
      const signerKey = signer.address.toLowerCase();
      if (signerKey === params.target.address.toLowerCase() || seenSponsors.has(signerKey)) {
        return false;
      }
      seenSponsors.add(signerKey);
      return true;
    },
  );

  let remainingTopUp = requiredTopUp;
  for (const sponsor of sponsors) {
    if (remainingTopUp === 0n) {
      break;
    }
    const sponsorBalance = await ethers.provider.getBalance(sponsor.address);
    const affordableTopUp = sponsorBalance > params.reserveWei ? sponsorBalance - params.reserveWei : 0n;
    const topUpAmount = remainingTopUp > affordableTopUp ? affordableTopUp : remainingTopUp;
    if (topUpAmount === 0n) {
      continue;
    }
    await (await sponsor.sendTransaction({ to: params.target.address, value: topUpAmount })).wait();
    remainingTopUp -= topUpAmount;
  }

  const finalBalance = await ethers.provider.getBalance(params.target.address);
  if (finalBalance < params.desiredBalanceWei) {
    console.log(
      `  [Notice] ${params.label} native top-up capped by sponsor balances: desired=${ethers.formatEther(params.desiredBalanceWei)} ETH actual=${ethers.formatEther(finalBalance)} ETH reserveLeft=${ethers.formatEther(params.reserveWei)} ETH`,
    );
  }
  return finalBalance;
}

async function readLiquidationReadiness(params: {
  ctx: FundsFlowLiveContext;
  orderId: bigint;
  source: LiquidationOrderSource;
  lendingEngine: any;
  liquidatorView: any;
  liquidationRiskView: any;
  refreshPrices?: boolean;
}) {
  const order = await getOrderForView(params.ctx, params.orderId);
  const borrowerCaller = new ethers.VoidSigner(order.borrower, ethers.provider);
  const debt = (await params.lendingEngine.getDebt(order.borrower, order.asset)) as bigint;
  const reducible = (await params.lendingEngine.getReducibleDebtAmount(order.borrower, order.asset)) as bigint;
  const [seizableAssets, seizableAmounts] = (await params.liquidatorView
    .connect(borrowerCaller)
    .getSeizableCollaterals(order.borrower)) as [string[], bigint[], bigint, boolean];
  if (params.refreshPrices !== false) {
    for (const asset of [order.asset, ...seizableAssets]) {
      await refreshPrice(params.ctx, asset, `liquidation refresh ${asset}`);
    }
  }
  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  const [liquidatable, metadataValid] = (await params.liquidationRiskView
    .connect(borrowerCaller)
    ["isLiquidatable(address)"](order.borrower)) as [boolean, boolean, bigint];
  const [riskScore] = (await params.liquidationRiskView
    .connect(borrowerCaller)
    .getLiquidationRiskScore(order.borrower)) as [bigint, boolean, bigint];

  return {
    order,
    readiness: {
      orderId: params.orderId,
      borrower: order.borrower,
      currentBlock,
      maturity: order.maturity,
      debt,
      reducible,
      totalSeizable: seizableAmounts.reduce((sum, value) => sum + value, 0n),
      liquidatable,
      metadataValid,
      riskScore,
      source: params.source,
    } satisfies LiquidationReadiness,
    seizableAssets,
    seizableAmounts,
  };
}

async function findAlternativeLiquidationCandidate(params: {
  ctx: FundsFlowLiveContext;
  currentOrderId: bigint;
  lendingEngine: any;
  liquidatorView: any;
  liquidationRiskView: any;
  settlementManager: any;
}) {
  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  const candidates = await collectRecentLoanOrderCandidates({
    orderEngine: params.ctx.orderEngine,
    currentBlock,
    excludeOrderIds: [params.currentOrderId],
  });
  console.log(
    `  [CandidateSearch] scanning recent orders count=${candidates.length} excludeOrderId=${params.currentOrderId.toString()} chunkBlocks=${envStr("LIQUIDATION_SEARCH_CHUNK_BLOCKS") ?? "20000"} maxWindows=${envStr("LIQUIDATION_SEARCH_MAX_WINDOWS") ?? "auto"} maxOrdersPerWindow=${envStr("LIQUIDATION_SEARCH_MAX_ORDERS_PER_WINDOW") ?? "auto"}`,
  );

  for (const candidate of candidates) {
    try {
      const { order, readiness } = await readLiquidationReadiness({
        ctx: params.ctx,
        orderId: candidate.orderId,
        source: "candidate",
        lendingEngine: params.lendingEngine,
        liquidatorView: params.liquidatorView,
        liquidationRiskView: params.liquidationRiskView,
        refreshPrices: false,
      });
      if (readiness.currentBlock <= readiness.maturity) {
        console.log(`  [CandidateSearch] skip ${formatLiquidationReadiness(readiness)}`);
        continue;
      }
      if (readiness.debt === 0n || readiness.reducible === 0n || readiness.totalSeizable === 0n) {
        console.log(`  [CandidateSearch] skip ${formatLiquidationReadiness(readiness)}`);
        continue;
      }
      if (!readiness.metadataValid || !readiness.liquidatable) {
        console.log(`  [CandidateSearch] skip ${formatLiquidationReadiness(readiness)}`);
        continue;
      }
      await params.settlementManager.connect(params.ctx.relayer).settleOrLiquidate.staticCall(candidate.orderId);
      console.log(
        `  [CandidateSearch] selected orderId=${candidate.orderId.toString()} borrower=${order.borrower} block=${candidate.blockNumber.toString()}`,
      );
      const { seizableAssets, seizableAmounts } = await readLiquidationReadiness({
        ctx: params.ctx,
        orderId: candidate.orderId,
        source: "candidate",
        lendingEngine: params.lendingEngine,
        liquidatorView: params.liquidatorView,
        liquidationRiskView: params.liquidationRiskView,
        refreshPrices: false,
      });
      return { order, readiness, seizableAssets, seizableAmounts };
    } catch (error) {
      console.log(
        `  [CandidateSearch] skip orderId=${candidate.orderId.toString()} reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return null;
}

async function refreshPrice(ctx: FundsFlowLiveContext, asset: string, label: string) {
  let price: bigint | undefined;
  let blockNumber: bigint | undefined;
  try {
    const priceTuple = (await ctx.priceOracle.getPrice(asset)) as [bigint, bigint, bigint];
    price = priceTuple[0];
    blockNumber = priceTuple[1];
  } catch {
    // Localhost runs routinely mine past maxPriceAge; fall back to the pack bootstrap price and republish it.
  }

  if (!price || price === 0n || !blockNumber || blockNumber === 0n) {
    const matchedAsset = [ctx.pair.settlementAsset, ctx.pair.borrowAsset, ctx.pair.collateralAsset].find(
      (candidate) => candidate.address.toLowerCase() === asset.toLowerCase(),
    );
    if (!matchedAsset) {
      throw new Error(`${label}: price oracle returned zero/invalid price for asset ${asset}`);
    }
    price = parseAssetBootstrapPrice(matchedAsset);
  }
  const hasUpdatePrice = (await ctx.acm.hasRole(key("UPDATE_PRICE"), ctx.relayer.address)) as boolean;
  if (!hasUpdatePrice) {
    throw new Error(`relayer ${ctx.relayer.address} lacks UPDATE_PRICE role required by keeper refresh runbook`);
  }
  const nowBlock = BigInt(await ethers.provider.getBlockNumber());
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
  const configuredOrderId = envStr("LIQUIDATION_ORDER_ID");
  const allowRiskTriggeredConfiguredOrder = envBool("LIQUIDATION_ACCEPT_RISK_TRIGGERED_ORDER", false);
  const { ctx } = await bootstrapFundsFlowLiveTest({
    label: "Live Liquidation",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await ensureSignerNativeTopUp({
    ctx,
    target: ctx.relayer,
    desiredBalanceWei: ethers.parseEther(envStr("LIVE_LIQUIDATION_RELAYER_NATIVE_ETH") ?? "0.00002"),
    reserveWei: ethers.parseEther(envStr("LIVE_LIQUIDATION_SPONSOR_RESERVE_ETH") ?? "0.0002"),
    label: "liquidation relayer",
  });

  if (!configuredOrderId && network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error("set LIQUIDATION_ORDER_ID to an existing overdue order on non-local networks");
  }

  const hasActionLiquidate = (await ctx.acm.hasRole(key("LIQUIDATE"), ctx.relayer.address)) as boolean;
  if (!hasActionLiquidate) {
    throw new Error(`relayer ${ctx.relayer.address} lacks LIQUIDATE role required by SettlementManager`);
  }

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const liquidationManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"))) as string;
  const liquidationViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_VIEW"))) as string;
  const liquidationRiskViewAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_RISK_VIEW"))) as string;

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
  const liquidationRiskView = (await ethers.getContractAt(
    [
      "function isLiquidatable(address user) view returns (bool,bool,uint256)",
      "function getLiquidationRiskScore(address user) view returns (uint256,bool,uint256)",
    ],
    liquidationRiskViewAddr,
    ctx.viewer,
  )) as any;
  const liquidatorView = (await ethers.getContractAt(
    [
      "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
      "function getSeizableCollateralAmount(address user,address asset) view returns (uint256,uint256,bool)",
      "function getSeizableCollaterals(address user) view returns (address[] memory,uint256[] memory,uint256,bool)",
    ],
    liquidationViewAddr,
    ctx.viewer,
  )) as any;

  let orderId: bigint;
  let orderBefore: Awaited<ReturnType<typeof getOrderForView>>;
  let orderSource: LiquidationOrderSource;
  let configuredOrderValid = true;
  if (configuredOrderId) {
    orderId = BigInt(configuredOrderId);
    orderBefore = await getOrderForView(ctx, orderId);
    if (!orderBefore.borrower || orderBefore.borrower === ethers.ZeroAddress || !orderBefore.asset || orderBefore.asset === ethers.ZeroAddress) {
      configuredOrderValid = false;
      console.log(
        `  [Notice] configured liquidation order is stale or missing on current registry: orderId=${orderId.toString()} registry=${ctx.registryAddr} borrower=${String(orderBefore.borrower)} asset=${String(orderBefore.asset)}; falling back to candidate search`,
      );
    }
    orderSource = "configured";
  } else {
    await assignFreshBorrower(ctx, { noticeLabel: "using fresh liquidation borrower" });
    await fundFundsFlowActors(ctx, {
      borrowerBorrowAmount: ctx.totalDue,
      borrowerCollateralAmount: ctx.collateralAmount,
      lenderBorrowAmount: ctx.borrowAmount,
    });

    if (ctx.relayer.address.toLowerCase() === ctx.borrower.address.toLowerCase()) {
      throw new Error("relayer must differ from borrower for liquidation keeper flow");
    }

    await depositCollateral(ctx, ctx.collateralAmount);
    const reserve = await reserveForLending(ctx);
    const finalized = await finalizeSingleMatch(ctx, reserve);
    orderId = finalized.orderId;
    orderBefore = await getOrderForView(ctx, orderId);
    await observeExtendedViews(ctx, "liquidation-before-overdue");
    await expectRevert("settleOrLiquidate should reject before overdue trigger", async () => {
      await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(orderId);
    });
    await mineTo(orderBefore.maturity + 1n);
    orderSource = "fresh";
  }

  let readinessResult: Awaited<ReturnType<typeof readLiquidationReadiness>> | null = null;
  if (configuredOrderValid) {
    readinessResult = await readLiquidationReadiness({
      ctx,
      orderId,
      source: orderSource,
      lendingEngine,
      liquidatorView,
      liquidationRiskView,
    });
  }

  if (readinessResult) {
    console.log(
      `  [LiquidationRiskView] borrower=${readinessResult.readiness.borrower} liquidatable=${String(readinessResult.readiness.liquidatable)} riskScore=${readinessResult.readiness.riskScore.toString()}`,
    );
  }

  if ((configuredOrderId && (!configuredOrderValid || !readinessResult?.readiness.liquidatable))) {
    const alternative = await findAlternativeLiquidationCandidate({
      ctx,
      currentOrderId: orderId,
      lendingEngine,
      liquidatorView,
      liquidationRiskView,
      settlementManager,
    });
    if (alternative) {
      orderId = alternative.readiness.orderId;
      orderBefore = alternative.order;
      orderSource = alternative.readiness.source;
      console.log(
        `  [CandidateSearch] using fallback orderId=${orderId.toString()} borrower=${orderBefore.borrower}`,
      );
      readinessResult = await readLiquidationReadiness({
        ctx,
        orderId,
        source: orderSource,
        lendingEngine,
        liquidatorView,
        liquidationRiskView,
      });
      orderBefore = readinessResult.order;
    }
  }

  if (!readinessResult) {
    throw new Error(
      `no usable liquidation order found for current registry: configuredOrderId=${configuredOrderId ?? "none"} registry=${ctx.registryAddr}`,
    );
  }

  let { readiness, seizableAssets, seizableAmounts } = readinessResult;

  if (readiness.currentBlock <= orderBefore.maturity && !(configuredOrderId && allowRiskTriggeredConfiguredOrder && readiness.liquidatable)) {
    throw new Error(
      `liquidation order is not overdue: currentBlock=${readiness.currentBlock.toString()} maturity=${orderBefore.maturity.toString()}`,
    );
  }
  if (readiness.currentBlock <= orderBefore.maturity && configuredOrderId && allowRiskTriggeredConfiguredOrder && readiness.liquidatable) {
    console.log(
      `  [Notice] configured mock-suite liquidation order is not overdue but risk-triggered execution is allowed: orderId=${orderId.toString()} maturity=${orderBefore.maturity.toString()} currentBlock=${readiness.currentBlock.toString()}`,
    );
  }

  const debtAsset = orderBefore.asset;
  const debtBefore = readiness.debt;
  const reducibleBefore = readiness.reducible;
  if (debtBefore === 0n || reducibleBefore === 0n) {
    throw new Error("active debt is required before triggering liquidation");
  }

  const totalSeizableBefore = readiness.totalSeizable;
  if (totalSeizableBefore === 0n) {
    throw new Error("seizable collateral should be non-zero before liquidation");
  }

  if (!readiness.metadataValid) {
    throw new Error("LiquidationRiskView returned invalid metadata before trigger assertion");
  }

  if (!readiness.liquidatable) {
    throw new Error(
      `configured liquidation order is not currently liquidatable: ${formatLiquidationReadiness({
        ...readiness,
      })}`,
    );
  }

  try {
    await settlementManager.connect(ctx.relayer).settleOrLiquidate.staticCall(orderId);
  } catch {
    throw new Error(
      `settleOrLiquidate.staticCall reverted despite liquidation prechecks: ${formatLiquidationReadiness({
        ...readiness,
      })}`,
    );
  }

  const liquidationReceipt = await (
    await settlementManager.connect(ctx.relayer).settleOrLiquidate(orderId)
  ).wait();

  await waitForPostWriteOrderReadConvergence(ctx, orderId, "settleOrLiquidate", liquidationReceipt.blockNumber);

  const orderAfter = await getOrderForView(ctx, orderId);
  const debtAfter = (await lendingEngine.getDebt(orderBefore.borrower, debtAsset)) as bigint;

  if (debtAfter > debtBefore) {
    throw new Error(`debt increased after liquidation: before=${debtBefore.toString()} after=${debtAfter.toString()}`);
  }
  if (debtBefore - debtAfter !== reducibleBefore) {
    throw new Error(
      `debt delta mismatch: before=${debtBefore.toString()} after=${debtAfter.toString()} reducible=${reducibleBefore.toString()}`,
    );
  }
  if (orderAfter.borrower.toLowerCase() !== orderBefore.borrower.toLowerCase()) {
    throw new Error("order borrower changed unexpectedly after liquidation");
  }

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const liquidationUpdateTopic = liquidatorView.interface.getEvent("DataPushed").topicHash;
  const liquidationUpdateType = key("LIQUIDATION_UPDATE").toLowerCase();
  const liquidationPayoutType = key("LIQUIDATION_PAYOUT").toLowerCase();
  const dataPushTypeNames = new Map<string, string>([
    [liquidationUpdateType, "LIQUIDATION_UPDATE"],
    [liquidationPayoutType, "LIQUIDATION_PAYOUT"],
  ]);
  const allDataPushLogs = (liquidationReceipt.logs ?? []).flatMap((log: any): ParsedDataPushLog[] => {
    if (String(log.topics?.[0] ?? "").toLowerCase() !== liquidationUpdateTopic.toLowerCase()) {
      return [];
    }
    try {
      const parsed = liquidatorView.interface.parseLog({
        topics: log.topics,
        data: log.data,
      });
      return [{
        address: String(log.address ?? "").toLowerCase(),
        parsed,
      }];
    } catch {
      return [];
    }
  });
  const liquidatorLogs = allDataPushLogs.filter((entry: ParsedDataPushLog) => entry.address === liquidationViewAddr.toLowerCase());
  const settlementLogs = allDataPushLogs.filter((entry: ParsedDataPushLog) => entry.address === ctx.settlementManagerAddr.toLowerCase());

  const settlementFallbackIface = new ethers.Interface([
    "event LiquidationManagerFallbackActivated(uint256 indexed orderId,address indexed user,address indexed collateralAsset,address debtAsset,address liquidator,bytes reason,uint256 blockNumber)",
  ]);
  const liquidationManagerFallbackActivatedEvent = settlementFallbackIface.getEvent("LiquidationManagerFallbackActivated");
  const fallbackActivation = (liquidationReceipt.logs ?? []).find((log: any) => {
    return (
      String(log.address ?? "").toLowerCase() === ctx.settlementManagerAddr.toLowerCase()
      && String(log.topics?.[0] ?? "").toLowerCase()
        === liquidationManagerFallbackActivatedEvent?.topicHash.toLowerCase()
    );
  }) as any;

  const standardErrorIface = new ethers.Interface([
    "error InvalidCaller()",
    "error MissingRole()",
    "error ZeroAddress()",
    "error NotAContract(address)",
    "error ArrayLengthMismatch(uint256,uint256)",
    "error BatchTooLarge(uint256,uint256)",
    "error EmptyArray()",
  ]);
  const cacheFailureIface = new ethers.Interface([
    "event CacheUpdateFailed(address indexed user,address indexed asset,address viewAddr,uint256 collateral,uint256 debt,bytes reason)",
  ]);
  const cacheUpdateFailedEvent = cacheFailureIface.getEvent("CacheUpdateFailed");
  const liquidationManagerCacheFailures = (liquidationReceipt.logs ?? [])
    .filter(
      (log: any) =>
        String(log.address ?? "").toLowerCase() === liquidationManagerAddr.toLowerCase()
        && String(log.topics?.[0] ?? "").toLowerCase()
          === cacheUpdateFailedEvent?.topicHash.toLowerCase(),
    )
    .map((log: any) => cacheFailureIface.parseLog({ topics: log.topics, data: log.data }))
    .filter((entry: any) => String(entry.args.viewAddr ?? "").toLowerCase() === liquidationViewAddr.toLowerCase())
    .map((entry: any) => decodeFailureReason(String(entry.args.reason), standardErrorIface));
  const liquidationUpdateCacheFailures = liquidationManagerCacheFailures.filter(
    (reason: string) => !reason.includes("pushLiquidationPayout failed")
      && !reason.includes("calculateShares failed")
      && !reason.includes("getRecipients failed"),
  );
  const liquidationPayoutCacheFailures = liquidationManagerCacheFailures.filter(
    (reason: string) => reason.includes("pushLiquidationPayout failed")
      || reason.includes("calculateShares failed")
      || reason.includes("getRecipients failed"),
  );

  const settlementDataPushTypes = allDataPushLogs
    .filter((entry: ParsedDataPushLog) => entry.address === ctx.settlementManagerAddr.toLowerCase())
    .map((entry: ParsedDataPushLog) => dataPushTypeNames.get(String(entry.parsed.args[0]).toLowerCase()) ?? String(entry.parsed.args[0]));
  const liquidatorPushTypes = liquidatorLogs.map(
    (entry: ParsedDataPushLog) => dataPushTypeNames.get(String(entry.parsed.args[0]).toLowerCase()) ?? String(entry.parsed.args[0]),
  );

  let fallbackReason = "none";
  if (fallbackActivation) {
    const parsedFallback = settlementFallbackIface.parseLog({
      topics: fallbackActivation.topics,
      data: fallbackActivation.data,
    });
    if (parsedFallback) {
      fallbackReason = decodeFailureReason(String(parsedFallback.args.reason), standardErrorIface);
      console.log(`  [Notice] liquidation executed via SettlementManager fallback: reason=${fallbackReason}`);
    }
  }

  const liquidatorUpdatePush = liquidatorLogs
    .map((entry: ParsedDataPushLog) => entry.parsed)
    .find((entry: any) => entry && String(entry.args[0]).toLowerCase() === liquidationUpdateType);
  const settlementUpdatePush = settlementLogs
    .map((entry: ParsedDataPushLog) => entry.parsed)
    .find((entry: any) => entry && String(entry.args[0]).toLowerCase() === liquidationUpdateType);

  let liquidatedCollateralAsset = seizableAssets[0] ?? ethers.ZeroAddress;
  const selectedUpdatePush = fallbackActivation ? settlementUpdatePush : liquidatorUpdatePush;
  if (!selectedUpdatePush) {
    const failureReasons = liquidationUpdateCacheFailures.length > 0
      ? `reasons=[${liquidationUpdateCacheFailures.join(" | ")}]`
      : `no CacheUpdateFailed emitted; liquidatorDataPushes=[${liquidatorPushTypes.join(",") || "none"}] settlementDataPushes=[${settlementDataPushTypes.join(",") || "none"}] allCacheFailures=[${liquidationManagerCacheFailures.join(" | ") || "none"}]`;
    console.log(
      `  [Notice] liquidation update observability missing after successful ledger write; fallbackActivated=${String(Boolean(fallbackActivation))} fallbackReason=${fallbackReason}; ${failureReasons}`,
    );
  } else {
    const updatePayload = abiCoder.decode(
      ["address", "address", "address", "uint256", "uint256", "address", "uint256", "uint256"],
      selectedUpdatePush.args[1],
    );
    if (String(updatePayload[0]).toLowerCase() !== orderBefore.borrower.toLowerCase()) {
      throw new Error("liquidation update payload borrower mismatch");
    }
    liquidatedCollateralAsset = String(updatePayload[1]);
    if (findAssetAmount(seizableAssets, seizableAmounts, liquidatedCollateralAsset) === 0n) {
      throw new Error("liquidation update payload collateral asset was not present in pre-liquidation seizable set");
    }
    if (String(updatePayload[2]).toLowerCase() !== debtAsset.toLowerCase()) {
      throw new Error("liquidation update payload debt asset mismatch");
    }
    if (String(updatePayload[5]).toLowerCase() !== ctx.relayer.address.toLowerCase()) {
      throw new Error("liquidation update payload liquidator mismatch");
    }
  }

  const payoutTopic = topicHash(
    "PayoutExecuted(address,address,address,address,address,address,uint256,uint256,uint256,uint256)",
  ).toLowerCase();
  const fallbackPayoutTopic = topicHash(
    "FallbackPayoutExecuted(address,address,address,address,address,address,uint256,uint256,uint256,uint256)",
  ).toLowerCase();
  const payoutIface = new ethers.Interface([
    "event PayoutExecuted(address indexed user,address indexed collateralAsset,address platform,address reserve,address lenderCompensation,address indexed liquidator,uint256 platformShare,uint256 reserveShare,uint256 lenderShare,uint256 liquidatorShare)",
    "event FallbackPayoutExecuted(address indexed user,address indexed collateralAsset,address platform,address reserve,address lenderCompensation,address indexed liquidator,uint256 platformShare,uint256 reserveShare,uint256 lenderShare,uint256 liquidatorShare)",
  ]);
  const payoutLog = (liquidationReceipt.logs ?? []).find((log: any) => {
    const topic = String(log.topics?.[0] ?? "").toLowerCase();
    return topic === payoutTopic || topic === fallbackPayoutTopic;
  }) as any;
  if (!payoutLog) {
    throw new Error("expected payout event on liquidation receipt");
  }
  const parsedPayout = payoutIface.parseLog({ topics: payoutLog.topics, data: payoutLog.data });
  if (!parsedPayout) {
    throw new Error("failed to parse payout event");
  }
  if (String(parsedPayout.args.liquidator).toLowerCase() !== ctx.relayer.address.toLowerCase()) {
    throw new Error("payout event liquidator does not match relayer keeper");
  }

  const liquidatorPayoutPush = liquidatorLogs
    .map((entry: ParsedDataPushLog) => entry.parsed)
    .find((entry: any) => entry && String(entry.args[0]).toLowerCase() === liquidationPayoutType);
  const settlementPayoutPush = settlementLogs
    .map((entry: ParsedDataPushLog) => entry.parsed)
    .find((entry: any) => entry && String(entry.args[0]).toLowerCase() === liquidationPayoutType);
  const selectedPayoutPush = fallbackActivation ? settlementPayoutPush : liquidatorPayoutPush;
  if (!selectedPayoutPush) {
    const failureReasons = liquidationPayoutCacheFailures.length > 0
      ? `reasons=[${liquidationPayoutCacheFailures.join(" | ")}]`
      : `no CacheUpdateFailed emitted; liquidatorDataPushes=[${liquidatorPushTypes.join(",") || "none"}] settlementDataPushes=[${settlementDataPushTypes.join(",") || "none"}] allCacheFailures=[${liquidationManagerCacheFailures.join(" | ") || "none"}]`;
    console.log(
      `  [Notice] liquidation payout observability missing after payout event emission; fallbackActivated=${String(Boolean(fallbackActivation))} fallbackReason=${fallbackReason}; ${failureReasons}`,
    );
  } else {
    const payoutPayload = abiCoder.decode(
      [
        "address",
        "address",
        "address",
        "address",
        "address",
        "address",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
      ],
      selectedPayoutPush.args[1],
    );
    if (String(payoutPayload[0]).toLowerCase() !== orderBefore.borrower.toLowerCase()) {
      throw new Error("liquidation payout payload borrower mismatch");
    }
    if (String(payoutPayload[1]).toLowerCase() !== liquidatedCollateralAsset.toLowerCase()) {
      throw new Error("liquidation payout payload collateral asset mismatch");
    }
    if (String(payoutPayload[5]).toLowerCase() !== ctx.relayer.address.toLowerCase()) {
      throw new Error("liquidation payout payload liquidator mismatch");
    }
    if (String(payoutPayload[2]).toLowerCase() !== String(parsedPayout.args.platform).toLowerCase()) {
      throw new Error("liquidation payout payload platform recipient mismatch");
    }
    if (String(payoutPayload[3]).toLowerCase() !== String(parsedPayout.args.reserve).toLowerCase()) {
      throw new Error("liquidation payout payload reserve recipient mismatch");
    }
    if (String(payoutPayload[4]).toLowerCase() !== String(parsedPayout.args.lenderCompensation).toLowerCase()) {
      throw new Error("liquidation payout payload lender recipient mismatch");
    }
    if (
      BigInt(payoutPayload[6]) !== BigInt(parsedPayout.args.platformShare)
      || BigInt(payoutPayload[7]) !== BigInt(parsedPayout.args.reserveShare)
      || BigInt(payoutPayload[8]) !== BigInt(parsedPayout.args.lenderShare)
      || BigInt(payoutPayload[9]) !== BigInt(parsedPayout.args.liquidatorShare)
    ) {
      throw new Error("liquidation payout payload shares mismatch payout event");
    }
  }

  await observeExtendedViews(ctx, "liquidation-after-exec");

  const borrowerCaller = new ethers.VoidSigner(orderBefore.borrower, ethers.provider);
  const [seizableAfter] = (await liquidatorView
    .connect(borrowerCaller)
    .getSeizableCollateralAmount(orderBefore.borrower, liquidatedCollateralAsset)) as [bigint, bigint, boolean];
  const seizableBeforeSelected = findAssetAmount(seizableAssets, seizableAmounts, liquidatedCollateralAsset);
  if (seizableAfter > seizableBeforeSelected) {
    throw new Error("seizable collateral increased after liquidation");
  }

  console.log(
    `  [Liquidation] orderId=${orderId.toString()} debtBefore=${debtBefore.toString()} debtAfter=${debtAfter.toString()} seizableBefore=${seizableBeforeSelected.toString()} seizableAfter=${seizableAfter.toString()}`,
  );
  logLiveScriptSuccess(__filename);
}

void runWithNetworkRetry(resolveLiveScriptId(__filename), main);
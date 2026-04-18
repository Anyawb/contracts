import { ethers, network } from "hardhat";

import { configureDynamicEip1559Fees } from "../../../../../utils/eip1559-fees";
import { envBool, envStr, loadAddressMap, resolveAddress } from "../../../../_addressResolver";
import {
  BORROW_INTENT_TYPES,
  LEND_INTENT_TYPES,
  buildLendIntentHash,
  calcInterest,
  createBestEffortValuationView,
  ensureRoleForAccount,
  explainRevert,
  fmtErr,
  formatUnits,
  getActorSigner,
  getAssetBootstrapPriceValue,
  getLivePriceMode,
  getRelayerSigner,
  getReadCaller,
  key,
  loadMockAssetPack,
  loadMockAssetPackData,
  observeLiveState,
  parseLoanOrderId,
  parseAssetBootstrapPrice,
  printObservation,
  resolveBnbMinGasPriceWei,
  requireCode,
  type LiveObservation,
  updateAssetPriceWithRepair,
  withNonceManagedSigner,
} from "./_mockLiveUtils";
import {
  assignFreshBorrowerWithRecovery,
  ensureRecoverableNativeTopUp,
  getManagedFreshBorrowerSponsors,
  type Sponsor,
} from "./_freshBorrowerManager";

const ONE_DAY = 24n * 60n * 60n;
const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";
const ERC20_ERROR_INTERFACE = new ethers.Interface([
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

const LIVE_FLOW_ERROR_INTERFACE = new ethers.Interface([
  "error GuaranteeAlreadyProcessed()",
  "error GuaranteeNotActive()",
  "error GuaranteeRecordNotFound()",
  "error MissingRole()",
]);

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAllowanceConvergenceTimeoutMs() {
  const raw = process.env.LIVE_ALLOWANCE_CONVERGENCE_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20_000;
}

function resolveAllowanceConvergencePollMs() {
  const raw = process.env.LIVE_ALLOWANCE_CONVERGENCE_POLL_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1_000;
}

function resolveAllowanceConvergenceConfirmations() {
  const raw = process.env.LIVE_ALLOWANCE_CONVERGENCE_CONFIRMATIONS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
}

function resolvePriceRepairMinAgeBlocks() {
  const raw = process.env.LIVE_PRICE_REPAIR_MIN_AGE_BLOCKS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? BigInt(Math.floor(parsed)) : 5n;
}

function resolvePriceReadRetryAttempts() {
  const raw = process.env.LIVE_PRICE_READ_RETRY_ATTEMPTS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(1, Math.min(8, Math.floor(parsed)));
}

function resolvePriceReadRetryWaitBlocks() {
  const raw = process.env.LIVE_PRICE_READ_RETRY_WAIT_BLOCKS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, Math.min(3, Math.floor(parsed)));
}

function resolvePriceReadRetryPollMs() {
  const raw = process.env.LIVE_PRICE_READ_RETRY_POLL_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1_500;
}

function resolvePriceReadRetryBlockTimeoutMs() {
  const raw = process.env.LIVE_PRICE_READ_RETRY_BLOCK_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 45_000;
}

function resolveOrderBridgeConvergenceTimeoutMs() {
  const raw = process.env.LIVE_ORDER_BRIDGE_CONVERGENCE_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 12_000;
}

function resolveOrderBridgeConvergencePollMs() {
  const raw = process.env.LIVE_ORDER_BRIDGE_CONVERGENCE_POLL_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1_000;
}

export function isRetryableFreshOrderReadMessage(message: string) {
  return message.includes("[SSOT_DEPLOYMENT_MISMATCH]")
    || message.includes("LendingEngine__InvalidOrder")
    || message.includes("InvalidOrder")
    || message.includes("execution reverted");
}

export async function waitForFreshOrderReadRecovery(params: {
  sourceLabel: string;
  orderId: bigint;
  probe: () => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const timeoutMs = params.timeoutMs ?? resolveOrderBridgeConvergenceTimeoutMs();
  const pollMs = params.pollMs ?? resolveOrderBridgeConvergencePollMs();
  const now = params.now ?? (() => Date.now());
  const sleep = params.sleep ?? delay;
  const deadline = now() + timeoutMs;
  let lastError: unknown;

  while (now() < deadline) {
    try {
      await params.probe();
      return;
    } catch (error: any) {
      lastError = error;
      const reason = error?.message ?? error?.shortMessage ?? error?.info?.error?.message ?? fmtErr(error);
      if (!isRetryableFreshOrderReadMessage(String(reason))) {
        throw error;
      }
      await sleep(pollMs);
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(
    `fresh order read recovery timed out after ${params.sourceLabel}: orderId=${params.orderId.toString()}`,
  );
}

async function waitForBlockAdvance(requiredBlocks: number) {
  if (requiredBlocks <= 0) return;
  const start = await ethers.provider.getBlockNumber();
  const target = start + requiredBlocks;
  const pollMs = resolvePriceReadRetryPollMs();
  const deadline = Date.now() + resolvePriceReadRetryBlockTimeoutMs();

  while (Date.now() < deadline) {
    const current = await ethers.provider.getBlockNumber();
    if (current >= target) {
      return;
    }
    await delay(pollMs);
  }

  throw new Error(`Timed out waiting for ${requiredBlocks} block(s) to advance from ${start} to >= ${target}`);
}

type TokenFundingPlan = {
  tokenLabel: string;
  decimals: number;
  relayerBalance: bigint;
  targets: Map<string, bigint>;
};

export type FundsFlowLiveContext = {
  label: string;
  registryAddr: string;
  pair: ReturnType<typeof loadMockAssetPack>;
  relayer: any;
  viewer: any;
  borrower: any;
  lender: any;
  priceOracle: any;
  updater: any | null;
  acm: any;
  assetWhitelist: any;
  feeRouter: any;
  gfm: any | null;
  ergm: any | null;
  vaultCore: any;
  vbl: any;
  orderEngine: any;
  settlementToken: any;
  borrowToken: any;
  collateralToken: any;
  valuationView: any;
  viewCache: any;
  rewardView: any;
  healthView: any;
  positionView: any;
  statisticsView: any | null;
  loanFlowView: any | null;
  feeRouterView: any | null;
  systemRiskView: any | null;
  riskView: any | null;
  previewView: any | null;
  userView: any | null;
  dashboardView: any | null;
  cacheOptimizedView: any | null;
  registryView: any | null;
  batchView: any | null;
  loanNftView: any | null;
  moduleHealthView: any | null;
  accessControlView: any | null;
  lendingEngineView: any | null;
  eventHistoryManager: any | null;
  lenderPoolVaultAddr: string;
  vaultCoreAddr: string;
  collateralManagerAddr: string;
  vblAddr: string;
  orderEngineAddr: string;
  feeRouterAddr: string;
  guaranteeFundAddr: string;
  ergmAddr: string;
  settlementManagerAddr: string;
  accessControlViewAddr: string;
  lendingEngineViewAddr: string;
  eventHistoryManagerAddr: string;
  borrowAssetAddr: string;
  collateralAssetAddr: string;
  settlementTokenAddr: string;
  borrowSymbol: string;
  collateralSymbol: string;
  settlementSymbol: string;
  borrowDecimals: number;
  collateralDecimals: number;
  settlementDecimals: number;
  collateralAmount: bigint;
  borrowAmount: bigint;
  termDays: number;
  rateBps: bigint;
  interest: bigint;
  totalDue: bigint;
  livePriceMode: "bootstrap" | "backend-required";
  allowBootstrapPriceOnMissing: boolean;
  allowDirectOraclePriceWrite: boolean;
  relayerHasSetParameter: boolean;
};

export type ExtendedViewSnapshot = {
  base: LiveObservation;
  statisticsGlobal?: {
    totalUsers: bigint;
    activeUsers: bigint;
    totalCollateral: bigint;
    totalDebt: bigint;
    isValid: boolean;
    blockNumber: bigint;
  };
  statisticsUser?: {
    collateral: bigint;
    debt: bigint;
    isValid: boolean;
    blockNumber: bigint;
  };
  loanFlowGlobal?: {
    borrowVolumeUsd8: bigint;
    repayVolumeUsd8: bigint;
    borrowCount: bigint;
    repayCount: bigint;
    isValid: boolean;
    blockNumber: bigint;
  };
  loanFlowUser?: {
    borrowVolumeUsd8: bigint;
    repayVolumeUsd8: bigint;
    borrowCount: bigint;
    repayCount: bigint;
    isValid: boolean;
    blockNumber: bigint;
  };
  feeRouterSync?: {
    isValid: boolean;
    lastSyncBlock: bigint;
    needsSync: boolean;
  };
  feeRouterUser?: {
    totalFeePaid: bigint;
    transactionCount: bigint;
    lastActivityBlock: bigint;
  };
  systemRisk?: {
    liquidationThreshold: bigint;
    minHealthFactor: bigint;
    maxLtvBps: bigint;
  };
  notices: string[];
};

export type ReserveResult = {
  lendIntent: {
    lenderSigner: string;
    asset: string;
    amount: bigint;
    minTermDays: number;
    maxTermDays: number;
    minRateBps: bigint;
    expireAt: bigint;
    salt: string;
  };
  lendHash: string;
  receipt: any;
};

export type FinalizeResult = {
  orderId: bigint;
  receipt: any;
  borrowIntent: {
    borrower: string;
    collateralAsset: string;
    collateralAmount: bigint;
    borrowAsset: string;
    amount: bigint;
    termDays: number;
    rateBps: bigint;
    expireAt: bigint;
    salt: string;
  };
  lendIntent: ReserveResult["lendIntent"];
};

export const LOAN_STATUS = {
  Active: 0n,
  Repaid: 1n,
  Liquidated: 2n,
  Defaulted: 3n,
  LiquidatedWithShortfall: 4n,
  DefaultedWithShortfall: 5n,
} as const;

export function formatLoanStatus(status: bigint | number) {
  const normalized = BigInt(status);
  switch (normalized) {
    case LOAN_STATUS.Active:
      return "Active";
    case LOAN_STATUS.Repaid:
      return "Repaid";
    case LOAN_STATUS.Liquidated:
      return "Liquidated";
    case LOAN_STATUS.Defaulted:
      return "Defaulted";
    case LOAN_STATUS.LiquidatedWithShortfall:
      return "LiquidatedWithShortfall";
    case LOAN_STATUS.DefaultedWithShortfall:
      return "DefaultedWithShortfall";
    default:
      return `Unknown(${normalized.toString()})`;
  }
}

type LoanNftViewLoanEntry = {
  orderId?: bigint;
  status?: bigint | number;
  1?: bigint;
  2?: bigint | number;
};

export type AssetRuntimeConfig = {
  assetAddr: string;
  token: any;
  decimals: number;
  symbol: string;
};

export type GuaranteeState = {
  enabled: boolean;
  locked: bigint;
  guaranteeId: bigint;
  active: boolean;
  record?: {
    principal: bigint;
    promisedInterest: bigint;
    startTime: bigint;
    maturityTime: bigint;
    earlyRepayPenaltyDays: bigint;
    isActive: boolean;
    lender: string;
    asset: string;
  };
};

export type FundsFlowBootstrapResult = {
  ctx: FundsFlowLiveContext;
};

function addTarget(map: Map<string, bigint>, address: string, amount: bigint) {
  map.set(address, (map.get(address) ?? 0n) + amount);
}

async function fundTokenTargets(erc20: any, symbol: string, relayer: any, plan: TokenFundingPlan) {
  let totalGap = 0n;
  const gaps: Array<{ address: string; gap: bigint; current: bigint }> = [];

  for (const [address, target] of plan.targets.entries()) {
    const current = (await erc20.balanceOf(address)) as bigint;
    const gap = target > current ? target - current : 0n;
    if (gap > 0n) {
      gaps.push({ address, gap, current });
      totalGap += gap;
    }
  }

  if (totalGap === 0n) {
    return;
  }
  if (plan.relayerBalance < totalGap) {
    throw new Error(
      `${plan.tokenLabel} relayer balance is insufficient. need=${formatUnits(totalGap, plan.decimals)} have=${formatUnits(plan.relayerBalance, plan.decimals)} ${symbol}`,
    );
  }

  console.log(
    `[Funding] ${plan.tokenLabel} totalGap=${formatUnits(totalGap, plan.decimals)} ${symbol} relayer=${formatUnits(plan.relayerBalance, plan.decimals)} ${symbol}`,
  );

  for (const gap of gaps) {
    await (await erc20.connect(relayer).transfer(gap.address, gap.gap)).wait();
    console.log(
      `  funded ${gap.address} with ${formatUnits(gap.gap, plan.decimals)} ${symbol} (pre=${formatUnits(gap.current, plan.decimals)})`,
    );
  }
}

async function tryRead<T>(label: string, read: () => Promise<T>, notices: string[]): Promise<T | undefined> {
  try {
    return await read();
  } catch (error: any) {
    notices.push(`${label}: ${fmtErr(error)}`);
    return undefined;
  }
}

function summarizeTraceError(node: any, path = "root"): string | null {
  if (!node || typeof node !== "object") {
    return null;
  }
  const childCalls = Array.isArray(node.calls) ? node.calls : [];
  for (let index = childCalls.length - 1; index >= 0; index -= 1) {
    const childSummary = summarizeTraceError(childCalls[index], `${path}.${childCalls[index]?.type ?? "call"}[${index}]`);
    if (childSummary) {
      return childSummary;
    }
  }
  const errorText = [node.error, node.revertReason].find((value) => typeof value === "string" && value.length > 0);
  if (!errorText) {
    return null;
  }
  return `${path}: ${errorText}`;
}

function withGasBuffer(estimate: bigint, multiplierBps = 12_000n) {
  return (estimate * multiplierBps) / 10_000n + 50_000n;
}

function resolveRepayNativeReserveWei() {
  const configured = envStr("LIVE_FUNDS_FLOW_REPAY_NATIVE_RESERVE_ETH")?.trim();
  if (configured) {
    return ethers.parseEther(configured);
  }
  return ethers.parseEther("0.00005");
}

function resolveDepositNativeReserveWei() {
  const configured = envStr("LIVE_FUNDS_FLOW_DEPOSIT_NATIVE_RESERVE_ETH")?.trim();
  if (configured) {
    return ethers.parseEther(configured);
  }
  return ethers.parseEther("0.00005");
}

function resolveFreshBorrowerSponsorReserveEth() {
  return envStr("LIVE_FRESH_BORROWER_SPONSOR_RESERVE_ETH") ?? envStr("LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH") ?? "0.00005";
}

function asNativeTopUpSponsor<T extends { address?: string; sendTransaction?: unknown }>(signer: T | null | undefined) {
  if (signer instanceof ethers.VoidSigner) {
    return null;
  }
  return typeof signer?.address === "string" && typeof signer?.sendTransaction === "function"
    ? ({ address: signer.address, sendTransaction: signer.sendTransaction as Sponsor["sendTransaction"] } satisfies Sponsor)
    : null;
}

function collectNativeTopUpSponsors(
  ...candidates: Array<{ address?: string; sendTransaction?: unknown } | null | undefined>
): Sponsor[] {
  return candidates
    .map((candidate) => asNativeTopUpSponsor(candidate))
    .filter((signer): signer is NonNullable<ReturnType<typeof asNativeTopUpSponsor>> => Boolean(signer));
}

function buildNativeTopUpSponsors(
  excludeAddresses: string[],
  ...candidates: Array<{ address?: string; sendTransaction?: unknown } | null | undefined>
): Sponsor[] {
  return [...collectNativeTopUpSponsors(...candidates), ...getManagedFreshBorrowerSponsors(excludeAddresses)];
}

function resolveFundsFlowFreshBorrowerNativeAmount(options: { nativeAmountWei?: bigint; nativeAmountEth?: string }) {
  if (typeof options.nativeAmountWei !== "undefined") {
    return options.nativeAmountWei;
  }
  if (options.nativeAmountEth?.trim()) {
    return ethers.parseEther(options.nativeAmountEth.trim());
  }
  const configured = envStr("LIVE_FUNDS_FLOW_FRESH_BORROWER_NATIVE_ETH")?.trim();
  if (configured) {
    return ethers.parseEther(configured);
  }
  return undefined;
}

function resolveFundsFlowFreshLenderNativeAmount(options: { nativeAmountWei?: bigint; nativeAmountEth?: string }) {
  if (typeof options.nativeAmountWei !== "undefined") {
    return options.nativeAmountWei;
  }
  if (options.nativeAmountEth?.trim()) {
    return ethers.parseEther(options.nativeAmountEth.trim());
  }
  const configured = envStr("LIVE_FUNDS_FLOW_FRESH_LENDER_NATIVE_ETH")?.trim();
  if (configured) {
    return ethers.parseEther(configured);
  }
  return resolveFundsFlowFreshBorrowerNativeAmount({});
}

function resolveFreshActorMaxAttempts() {
  const raw = envStr("LIVE_FRESH_ACTOR_MAX_ATTEMPTS") ?? envStr("LIVE_FRESH_BORROWER_MAX_ATTEMPTS") ?? "8";
  return Math.max(1, Number(raw));
}

function isConcurrentIsolationMode() {
  if (envBool("LIVE_CONCURRENT_ISOLATION", false)) return true;
  return Boolean(envStr("LIVE_WORKER_INDEX") ?? envStr("LIVE_WORKER_ID"));
}

const allocatedFreshActorAddresses = new Set<string>();

function markFreshActorAddress(address: string) {
  allocatedFreshActorAddresses.add(address.toLowerCase());
}

function hasFreshActorAddress(address: string) {
  return allocatedFreshActorAddresses.has(address.toLowerCase());
}

async function readFeeRouterViewBinding(params: {
  vaultCoreAddr: string;
  expectedFeeRouterViewAddr: string;
}) {
  const vaultCore = (await ethers.getContractAt(
    ["function viewContractAddrVar() view returns (address)"],
    params.vaultCoreAddr,
  )) as any;
  const viewGatewayAddr = (await vaultCore.viewContractAddrVar()) as string;
  if (!viewGatewayAddr || viewGatewayAddr === ethers.ZeroAddress) {
    return {
      viewGatewayAddr,
      configuredFeeRouterViewAddr: ethers.ZeroAddress,
      expectedFeeRouterViewAddr: params.expectedFeeRouterViewAddr,
      aligned: false,
    };
  }

  const vaultRouter = (await ethers.getContractAt(
    ["function feeRouterViewAddrVar() view returns (address)"],
    viewGatewayAddr,
  )) as any;
  const configuredFeeRouterViewAddr = (await vaultRouter.feeRouterViewAddrVar()) as string;
  return {
    viewGatewayAddr,
    configuredFeeRouterViewAddr,
    expectedFeeRouterViewAddr: params.expectedFeeRouterViewAddr,
    aligned: configuredFeeRouterViewAddr.toLowerCase() === params.expectedFeeRouterViewAddr.toLowerCase(),
  };
}

export async function createFundsFlowLiveContext(params: {
  label: string;
  collateralAmountUnitsDefault: string;
  borrowAmountUnitsDefault: string;
}) {
  await configureDynamicEip1559Fees({
    ethers,
    networkName: network.name,
    label: params.label,
  });

  const livePriceMode = getLivePriceMode("bootstrap");
  const allowBootstrapPriceOnMissing = livePriceMode === "bootstrap";
  const allowDirectOraclePriceWrite = envBool("ALLOW_DIRECT_PRICE_ORACLE", false);

  const addressMap = loadAddressMap(network.name, { preferMockSuite: true });
  const registryAddr = resolveAddress({
    name: "Registry",
    map: addressMap,
    envVar: "REGISTRY_ADDRESS",
  });

  const pair = loadMockAssetPack();
  const [rawRelayer] = await ethers.getSigners();
  const relayerActor = await getRelayerSigner(rawRelayer);
  const relayer = relayerActor.signer;
  const readCaller = getReadCaller("viewer", "VIEWER_ADDRESS", relayer);
  const viewer = readCaller.signer;
  const borrowerActor = await getActorSigner("borrower", "BORROWER_PRIVATE_KEY", relayer);
  const lenderActor = await getActorSigner("lender", "LENDER_PRIVATE_KEY", relayer);
  const borrower = borrowerActor.signer;
  const lender = lenderActor.signer;

  if (borrower.address.toLowerCase() === lender.address.toLowerCase()) {
    throw new Error("Borrower and lender must be different addresses for live funds-flow scripts.");
  }
  if (isConcurrentIsolationMode() && relayer.address.toLowerCase() === lender.address.toLowerCase()) {
    throw new Error(
      `concurrent isolation mode requires distinct relayer/lender addresses; relayer=${relayer.address} lender=${lender.address}`,
    );
  }

  const registry = (await ethers.getContractAt(
    [
      "function getModuleOrRevert(bytes32) view returns (address)",
      "function getModule(bytes32) view returns (address)",
    ],
    registryAddr,
  )) as any;

  const currentSettlementToken = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const { pack } = loadMockAssetPackData();
  let settlementAsset = pair.settlementAsset;
  let borrowAsset = pair.borrowAsset;
  const selectionSource = [...pair.selectionSource];
  if (!envStr("SETTLEMENT_TOKEN_ADDRESS") && settlementAsset.address.toLowerCase() !== currentSettlementToken.toLowerCase()) {
    const registrySettlementAsset = pack.assets.find(
      (asset) => asset.address.toLowerCase() === currentSettlementToken.toLowerCase(),
    ) ?? {
      ...settlementAsset,
      address: ethers.getAddress(currentSettlementToken),
    };
    const previousSettlementAddr = settlementAsset.address.toLowerCase();
    settlementAsset = registrySettlementAsset;
    selectionSource.push(`settlement aligned to registry=${settlementAsset.address}`);
    const borrowSelectionOverridden = Boolean(
      envStr("BORROW_ASSET_ADDRESS") || envStr("BORROW_SYMBOL") || envStr("BORROW_SOURCE_ID") || envStr("BORROW_COINGECKO_ID"),
    );
    if (!borrowSelectionOverridden && borrowAsset.address.toLowerCase() === previousSettlementAddr) {
      borrowAsset = settlementAsset;
      selectionSource.push(`borrow realigned to registry settlement=${borrowAsset.symbol}`);
    }
  }

  const settlementTokenAddr = settlementAsset.address;
  const borrowAssetAddr = borrowAsset.address;
  const collateralAssetAddr = pair.collateralAsset.address;

  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const updaterAddr = (await registry.getModule(key(PRICE_UPDATER_REGISTRY_RAW_KEY))) as string;
  const awAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const guaranteeFundAddr = (await registry.getModule(key("GUARANTEE_FUND_MANAGER"))) as string;
  const ergmAddr = (await registry.getModule(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string;
  const collateralManagerAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
  const settlementManagerAddr = (await registry.getModule(key("SETTLEMENT_MANAGER"))) as string;
  const lenderPoolVaultAddr = (await registry.getModuleOrRevert(key("LENDER_POOL_VAULT"))) as string;
  const valuationViewAddr = (await registry.getModuleOrRevert(key("VALUATION_ORACLE_VIEW"))) as string;
  const viewCacheAddr = (await registry.getModuleOrRevert(key("VIEW_CACHE"))) as string;
  const rewardViewAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
  const healthViewAddr = (await registry.getModuleOrRevert(key("HEALTH_VIEW"))) as string;
  const positionViewAddr = (await registry.getModuleOrRevert(key("POSITION_VIEW"))) as string;
  const statisticsViewAddr = (await registry.getModule(key("VAULT_STATISTICS"))) as string;
  const loanFlowViewAddr = (await registry.getModule(key("LOAN_FLOW_VIEW"))) as string;
  const feeRouterViewAddr = (await registry.getModule(key("FEE_ROUTER_VIEW"))) as string;
  const systemRiskViewAddr = (await registry.getModule(key("SYSTEM_RISK_VIEW"))) as string;
  const riskViewAddr = (await registry.getModule(key("RISK_VIEW"))) as string;
  const previewViewAddr = (await registry.getModule(key("PREVIEW_VIEW"))) as string;
  const userViewAddr = (await registry.getModule(key("USER_VIEW"))) as string;
  const dashboardViewAddr = (await registry.getModule(key("DASHBOARD_VIEW"))) as string;
  const cacheOptimizedViewAddr = (await registry.getModule(key("CACHE_OPTIMIZED_VIEW"))) as string;
  const registryViewAddr = (await registry.getModule(key("REGISTRY_VIEW"))) as string;
  const batchViewAddr = (await registry.getModule(key("BATCH_VIEW"))) as string;
  const loanNftViewAddr = (await registry.getModule(key("LOAN_NFT_VIEW"))) as string;
  const moduleHealthViewAddr = (await registry.getModule(key("MODULE_HEALTH_VIEW"))) as string;
  const accessControlViewAddr = (await registry.getModule(key("ACCESS_CONTROL_VIEW"))) as string;
  const lendingEngineViewAddr = (await registry.getModule(key("LENDING_ENGINE_VIEW"))) as string;
  const eventHistoryManagerAddr = (await registry.getModule(key("EVENT_HISTORY_MANAGER"))) as string;

  const settlementToken = (await ethers.getContractAt(
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function balanceOf(address owner) view returns (uint256)",
      "function allowance(address owner,address spender) view returns (uint256)",
      "function transfer(address to,uint256 amount) returns (bool)",
      "function approve(address spender,uint256 amount) returns (bool)",
    ],
    settlementTokenAddr,
  )) as any;
  const borrowToken = (await ethers.getContractAt(
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function balanceOf(address owner) view returns (uint256)",
      "function allowance(address owner,address spender) view returns (uint256)",
      "function transfer(address to,uint256 amount) returns (bool)",
      "function approve(address spender,uint256 amount) returns (bool)",
    ],
    borrowAssetAddr,
  )) as any;
  const collateralToken = (await ethers.getContractAt(
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function balanceOf(address owner) view returns (uint256)",
      "function allowance(address owner,address spender) view returns (uint256)",
      "function transfer(address to,uint256 amount) returns (bool)",
      "function approve(address spender,uint256 amount) returns (bool)",
    ],
    collateralAssetAddr,
  )) as any;
  const acm = (await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function hasRole(bytes32 role,address account) view returns (bool)",
      "function grantRole(bytes32 role,address account)",
    ],
    acmAddr,
  )) as any;
  const autoGrantRuntimeRoles = envBool("LIVE_AUTO_GRANT_RUNTIME_ROLES", true);
  const acmOwner = (await acm.owner()) as string;
  const relayerIsAcmOwner = acmOwner.toLowerCase() === relayer.address.toLowerCase();
  const relayerHasViewPriceData = await ensureRoleForAccount({
    acm,
    roleName: "VIEW_PRICE_DATA",
    account: relayer.address,
    granter: relayer,
    ownerAddress: acmOwner,
    autoGrant: autoGrantRuntimeRoles,
    label: `relayer ${relayer.address}`,
  });
  const relayerHasLiquidate = await ensureRoleForAccount({
    acm,
    roleName: "LIQUIDATE",
    account: relayer.address,
    granter: relayer,
    ownerAddress: acmOwner,
    autoGrant: autoGrantRuntimeRoles,
    label: `relayer ${relayer.address}`,
  });
  const relayerHasDeposit = await ensureRoleForAccount({
    acm,
    roleName: "DEPOSIT",
    account: relayer.address,
    granter: relayer,
    ownerAddress: acmOwner,
    autoGrant: autoGrantRuntimeRoles,
    label: `relayer ${relayer.address}`,
  });
  const relayerHasViewSystemData = await ensureRoleForAccount({
    acm,
    roleName: "VIEW_SYSTEM_DATA",
    account: relayer.address,
    granter: relayer,
    ownerAddress: acmOwner,
    autoGrant: autoGrantRuntimeRoles,
    label: `relayer ${relayer.address}`,
  });
  const relayerHasActionViewPush = await ensureRoleForAccount({
    acm,
    roleName: "ACTION_VIEW_PUSH",
    account: relayer.address,
    granter: relayer,
    ownerAddress: acmOwner,
    autoGrant: autoGrantRuntimeRoles,
    label: `relayer ${relayer.address}`,
  });
  const relayerHasSetParameter = await ensureRoleForAccount({
    acm,
    roleName: "SET_PARAMETER",
    account: relayer.address,
    granter: relayer,
    ownerAddress: acmOwner,
    autoGrant: autoGrantRuntimeRoles,
    label: `relayer ${relayer.address}`,
  });
  const settlementManagerHasRepay = settlementManagerAddr && settlementManagerAddr !== ethers.ZeroAddress
    ? await ensureRoleForAccount({
        acm,
        roleName: "REPAY",
        account: settlementManagerAddr,
        granter: relayer,
        ownerAddress: acmOwner,
        autoGrant: autoGrantRuntimeRoles,
        label: `SettlementManager ${settlementManagerAddr}`,
      })
    : false;
  const settlementManagerHasViewSystemData = settlementManagerAddr && settlementManagerAddr !== ethers.ZeroAddress
    ? await ensureRoleForAccount({
        acm,
        roleName: "VIEW_SYSTEM_DATA",
        account: settlementManagerAddr,
        granter: relayer,
        ownerAddress: acmOwner,
        autoGrant: autoGrantRuntimeRoles,
        label: `SettlementManager ${settlementManagerAddr}`,
      })
    : false;
  const priceOracle = (await ethers.getContractAt(
    [
      "function getAssetConfig(address asset) view returns (tuple(string sourceId,uint256 assetDecimals,bool isActive,uint256 maxPriceAgeBlocks))",
      "function getPrice(address asset) view returns (uint256,uint256,uint256)",
      "function configureAsset(address asset,string sourceId,uint256 assetDecimals,uint256 maxPriceAgeBlocks)",
      "function updatePrice(address asset,uint256 price,uint256 blockNumber)",
    ],
    priceOracleAddr,
  )) as any;
  const updater = updaterAddr && updaterAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function updateAssetPrice(address asset,uint256 price,uint256 blockNumber)",
          "function configureAssetWithDecimals(address asset,string sourceId,uint8 decimals)",
        ],
        updaterAddr,
      )) as any)
    : null;
  const assetWhitelist = (await ethers.getContractAt(
    ["function isAssetAllowed(address asset) view returns (bool)"],
    awAddr,
  )) as any;
  const feeRouter = (await ethers.getContractAt(
    [
      "function isTokenSupported(address token) view returns (bool)",
      "function getPlatformFeeBps() view returns (uint256)",
      "function getEcosystemFeeBps() view returns (uint256)",
      "function getPlatformTreasury() view returns (address)",
      "function getEcosystemVault() view returns (address)",
      "function getFeeRate() view returns (uint256)",
    ],
    feeRouterAddr,
  )) as any;
  const gfm = guaranteeFundAddr && guaranteeFundAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getLockedGuarantee(address user,address asset) view returns (uint256)",
          "function getTotalGuaranteeByAsset(address asset) view returns (uint256)",
        ],
        guaranteeFundAddr,
      )) as any)
    : null;
  const ergm = ergmAddr && ergmAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function isGuaranteeEnabled(address asset) view returns (bool)",
          "function getUserGuaranteeId(address user,address asset) view returns (uint256)",
          "function hasActiveGuarantee(address user,address asset) view returns (bool)",
          "function previewEarlyRepayment(uint256 guaranteeId,uint256 actualRepayAmount) view returns ((uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid))",
          "function getGuaranteeRecord(uint256 guaranteeId) view returns ((uint256 principal,uint256 promisedInterest,uint256 startTime,uint256 maturityTime,uint256 earlyRepayPenaltyDays,bool isActive,address lender,address asset))",
        ],
        ergmAddr,
      )) as any)
    : null;
  const vaultCore = (await ethers.getContractAt(
    [
      "function deposit(address asset,uint256 amount)",
      "function withdraw(address asset,uint256 amount)",
      "function repay(uint256 orderId,address asset,uint256 amount)",
    ],
    vaultCoreAddr,
  )) as any;
  const vbl = (await ethers.getContractAt(
    [
      "function reserveForLending(address lenderSigner,address asset,uint256 amount,bytes32 lendIntentHash)",
      "function cancelReserve(bytes32 lendIntentHash)",
      "function finalizeMatch((address borrower,address collateralAsset,uint256 collateralAmount,address borrowAsset,uint256 amount,uint16 termDays,uint256 rateBps,uint256 expireAt,bytes32 salt),(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)[] lendIntents,bytes sigBorrower,bytes[] sigLenders)",
    ],
    vblAddr,
  )) as any;
  const orderEngine = (await ethers.getContractAt(
    [
      "event LoanOrderCreated(uint256 indexed orderId,address indexed borrower,address indexed lender,uint256 principal)",
      "function getLoanOrderForView(uint256 orderId) view returns (tuple(uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startBlock,uint256 maturity,uint256 repaidAmount))",
      "function getOrderTotalDueForView(uint256 orderId) view returns (uint256)",
      "function getFailedFeeAmountForView(uint256 orderId) view returns (uint256)",
    ],
    orderEngineAddr,
  )) as any;
  const valuationView = createBestEffortValuationView(
    valuationViewAddr,
    relayerHasViewPriceData ? relayer : undefined,
  );
  const viewCache = (await ethers.getContractAt(
    ["function getSystemStatus(address asset) view returns (tuple(uint256 totalCollateral,uint256 totalDebt,uint256 utilizationRate,uint256 updateBlock,bool isValid),bool)"],
    viewCacheAddr,
    viewer,
  )) as any;
  const rewardView = (await ethers.getContractAt(
    [
      "function getUserRewardSummaryWithMeta(address user) view returns (uint256,uint256,uint8,uint256,uint256,bool)",
      "function getUserEasyEarnedWithMeta(address user) view returns (uint256,uint256,bool)",
    ],
    rewardViewAddr,
    viewer,
  )) as any;
  const healthView = (await ethers.getContractAt(
    ["function getUserHealthFactorWithMeta(address user) view returns (uint256,bool,uint256)"],
    healthViewAddr,
    viewer,
  )) as any;
  const positionView = (await ethers.getContractAt(
    ["function getUserPositionWithBlockMeta(address user,address asset) view returns (uint256,uint256,bool,uint256,uint256,uint64)"],
    positionViewAddr,
    viewer,
  )) as any;
  const statisticsView = statisticsViewAddr && statisticsViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getGlobalStatisticsWithMeta() view returns ((uint256 totalUsers,uint256 activeUsers,uint256 totalCollateral,uint256 totalDebt,uint256 lastUpdateBlock),bool,uint256)",
          "function getUserSnapshotWithMeta(address user) view returns ((uint256 collateral,uint256 debt,uint256 ltvBps,uint256 healthFactor,uint256 blockNumber,bool isActive),uint64,uint64,bytes32,bool,uint256)",
        ],
        statisticsViewAddr,
        viewer,
      )) as any)
    : null;
  const loanFlowView = loanFlowViewAddr && loanFlowViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getGlobalLoanFlowWithMeta() view returns (uint256,uint256,uint256,uint256,bool,uint256)",
          "function getUserLoanFlowWithMeta(address user) view returns (uint256,uint256,uint256,uint256,uint64,uint64,bytes32,bool,uint256)",
        ],
        loanFlowViewAddr,
        viewer,
      )) as any)
    : null;
  const feeRouterView = feeRouterViewAddr && feeRouterViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getSyncStatus() view returns (bool,uint256,bool)",
          "function getUserStatsWithMeta(address user) view returns ((uint256 totalFeePaid,uint256 transactionCount,uint256 lastActivityBlock),uint256,bool)",
        ],
        feeRouterViewAddr,
        viewer,
      )) as any)
    : null;
  const systemRiskView = systemRiskViewAddr && systemRiskViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getLiquidationThreshold() view returns (uint256)",
          "function getMinHealthFactor() view returns (uint256)",
          "function getMaxLtvBps() view returns (uint256)",
        ],
        systemRiskViewAddr,
        viewer,
      )) as any)
    : null;
  const riskView = riskViewAddr && riskViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getUserRiskAssessment(address user) view returns ((bool liquidatable,uint8 warningLevel,uint256 healthFactor,bool isValid,uint256 blockNumber))",
          "function batchGetRiskAssessments(address[] users) view returns ((bool liquidatable,uint8 warningLevel,uint256 healthFactor,bool isValid,uint256 blockNumber)[])",
        ],
        riskViewAddr,
        viewer,
      )) as any)
    : null;
  const previewView = previewViewAddr && previewViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function previewDeposit(address user,address asset,uint256 amount) view returns (uint256,bool,bool,uint256,uint64)",
          "function previewWithdraw(address user,address asset,uint256 amount) view returns (uint256,bool,bool,uint256,uint64)",
        ],
        previewViewAddr,
        viewer,
      )) as any)
    : null;
  const userView = userViewAddr && userViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getUserTotalsWithMeta(address user) view returns (uint256,uint256,bool,uint256,uint64,uint64)",
          "function getHealthFactorWithMeta(address user) view returns (uint256,bool,uint256)",
        ],
        userViewAddr,
        viewer,
      )) as any)
    : null;
  const dashboardView = dashboardViewAddr && dashboardViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getUserOverviewWithMeta(address user,address[] trackedAssets) view returns ((uint256 totalCollateral,uint256 totalDebt,uint256 healthFactor,bool healthFactorValid,bool isRisky),bool[],uint256[],uint64[],uint256)",
          "function getSystemOverviewWithMeta() view returns ((uint256 totalUsers,uint256 activeUsers,uint256 totalCollateral,uint256 totalDebt,uint256 lastUpdateBlock),bool,uint256)",
        ],
        dashboardViewAddr,
        viewer,
      )) as any)
    : null;
  const cacheOptimizedView = cacheOptimizedViewAddr && cacheOptimizedViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getUserSummaryWithMeta(address user,address[] trackedAssets) view returns ((uint256 totalCollateral,uint256 totalDebt,uint256 healthFactor,bool cacheValid),bool[],uint256[],uint64[],uint256)",
          "function getSystemStats() view returns ((uint256 totalUsers,uint256 activeUsers,uint256 totalCollateral,uint256 totalDebt,uint256 lastUpdateBlock))",
        ],
        cacheOptimizedViewAddr,
        viewer,
      )) as any)
    : null;
  const registryView = registryViewAddr && registryViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getRegisteredModuleKeysPaginated(uint256 offset,uint256 limit) view returns (bytes32[] memory,uint256)",
          "function getRegistry() view returns (address)",
        ],
        registryViewAddr,
        viewer,
      )) as any)
    : null;
  const batchView = batchViewAddr && batchViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function batchGetHealthFactors(address[] users) view returns ((address user,bool isValid,uint256 healthFactor,uint256 blockNumber)[])",
          "function batchGetRiskAssessments(address[] users) view returns ((address user,bool liquidatable,bool isValid,uint8 warningLevel,uint256 healthFactor,uint256 blockNumber)[])",
          "function batchGetModuleHealth(address[] modules) view returns ((address module,uint32 lastCheckTime,uint32 consecutiveFailures,bool isHealthy,bool isValid,bytes32 detailsHash,uint256 blockNumber)[])",
        ],
        batchViewAddr,
        viewer,
      )) as any)
    : null;
  const loanNftView = loanNftViewAddr && loanNftViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getUserLoanCount(address user) view returns (uint256,bool,uint256)",
          "function getUserTokenIdsPaginated(address user,uint256 offset,uint256 limit) view returns (uint256[] memory,uint256,bool,uint256)",
          "function getUserLoansPaginated(address user,uint256 offset,uint256 limit) view returns ((uint256 tokenId,uint256 orderId,uint8 status)[] memory,uint256,bool,uint256)",
        ],
        loanNftViewAddr,
        viewer,
      )) as any)
    : null;
  const moduleHealthView = moduleHealthViewAddr && moduleHealthViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getModuleHealthStatusWithMeta(address module) view returns ((address module,bool isHealthy,bytes32 detailsHash,uint256 lastCheckTime,uint256 consecutiveFailures,uint256 totalChecks,uint256 successRate),uint256,bool)",
          "function getModuleHealthWithMeta(address module) view returns ((bool isHealthy,bytes32 detailsHash,uint32 lastCheckTime,uint32 consecutiveFailures),bool,uint256)",
        ],
        moduleHealthViewAddr,
        viewer,
      )) as any)
    : null;
  const accessControlView = accessControlViewAddr && accessControlViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getACM() view returns (address)",
          "function registryAddrVar() view returns (address)",
          "function getUserPermissionWithMeta(address user,bytes32 actionKey) view returns (bool,bool,uint256)",
          "function isUserAdminWithMeta(address user) view returns (bool,bool,uint256)",
          "function getUserPermissionLevelWithMeta(address user) view returns (uint8,bool,uint256)",
        ],
        accessControlViewAddr,
        viewer,
      )) as any)
    : null;
  const lendingEngineView = lendingEngineViewAddr && lendingEngineViewAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "function getRegistry() view returns (address)",
          "function getLoanOrder(uint256 orderId) view returns (tuple(uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startBlock,uint256 maturity,uint256 repaidAmount))",
          "function getOrderStatus(uint256 orderId) view returns (uint8)",
          "function getOrderStateSnapshot(uint256 orderId) view returns ((uint8 productType,uint8 lifecycle,uint8 closeReason,uint8 shortfallStatus,uint8 collateralDisposition,bool hasLoss,uint256 createdBlock,uint256 updatedBlock,uint256 closedBlock))",
          "function getFailedFeeAmount(uint256 orderId) view returns (uint256)",
          "function getNftRetryCount(uint256 orderId) view returns (uint256)",
          "function canAccessLoanOrder(uint256 orderId,address user) view returns (bool,bool,uint256)",
          "function isMatchEngine(address account) view returns (bool)",
          "function getRegistryFromEngine() view returns (address)",
        ],
        lendingEngineViewAddr,
        viewer,
      )) as any)
    : null;
  const eventHistoryManager = eventHistoryManagerAddr && eventHistoryManagerAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        [
          "event HistoryRecorded(bytes32 indexed eventType,address indexed user,address indexed asset,uint256 amount,bytes extraData,uint256 blockNumber)",
          "event DataPushed(bytes32 indexed dataType,bytes payload)",
          "function getRegistry() view returns (address)",
          "function recordEvent(bytes32 eventType,address user,address asset,uint256 amount,bytes extraData)",
        ],
        eventHistoryManagerAddr,
        relayer,
      )) as any)
    : null;

  await Promise.all([
    requireCode(registryAddr, "Registry"),
    requireCode(settlementTokenAddr, "SettlementToken"),
    requireCode(borrowAssetAddr, "BorrowAsset"),
    requireCode(collateralAssetAddr, "CollateralAsset"),
    requireCode(vaultCoreAddr, "VaultCore"),
    requireCode(vblAddr, "VaultBusinessLogic"),
    requireCode(orderEngineAddr, "OrderEngine"),
    requireCode(positionViewAddr, "PositionView"),
    requireCode(rewardViewAddr, "RewardView"),
  ]);

  const settlementSymbol = String(await settlementToken.symbol().catch(() => settlementAsset.symbol));
  const settlementDecimals = Number(await settlementToken.decimals().catch(() => settlementAsset.decimals));
  const borrowSymbol = String(await borrowToken.symbol().catch(() => borrowAsset.symbol));
  const borrowDecimals = Number(await borrowToken.decimals().catch(() => borrowAsset.decimals));
  const collateralSymbol = String(await collateralToken.symbol().catch(() => pair.collateralAsset.symbol));
  const collateralDecimals = Number(await collateralToken.decimals().catch(() => pair.collateralAsset.decimals));

  const collateralAmount = ethers.parseUnits(
    envStr("COLLATERAL_AMOUNT_UNITS") ?? params.collateralAmountUnitsDefault,
    collateralDecimals,
  );
  const borrowAmount = ethers.parseUnits(
    envStr("BORROW_AMOUNT_UNITS") ?? params.borrowAmountUnitsDefault,
    borrowDecimals,
  );
  const termDays = Number(envStr("TERM_DAYS") ?? "5");
  const rateBps = BigInt(envStr("RATE_BPS") ?? "1000");
  const interest = calcInterest(borrowAmount, rateBps, BigInt(termDays) * ONE_DAY);
  const totalDue = borrowAmount + interest;

  console.log(`=== ${params.label} (${network.name}) ===`);
  console.log(`Registry=${registryAddr}`);
  console.log(`MockAssetPack=${pair.packFile}`);
  console.log(`CurrentSettlementToken=${currentSettlementToken}`);
  console.log(`SelectedSettlementToken=${settlementTokenAddr} symbol=${settlementSymbol}`);
  console.log(`SelectedBorrowAsset=${borrowAssetAddr} symbol=${borrowSymbol}`);
  console.log(`SelectedCollateralAsset=${collateralAssetAddr} symbol=${collateralSymbol}`);
  console.log(`SelectionSource=${selectionSource.join(" | ")}`);
  console.log(`Relayer=${relayer.address}`);
  console.log(`Viewer=${viewer.address} source=${readCaller.source}`);
  console.log(`Borrower=${borrower.address} source=${borrowerActor.source}`);
  console.log(`Lender=${lender.address} source=${lenderActor.source}`);
  console.log(`RelayerSource=${relayerActor.source}`);
  console.log(`RelayerHasViewPriceData=${relayerHasViewPriceData}`);
  console.log(`RelayerHasLiquidate=${relayerHasLiquidate}`);
  console.log(`RelayerHasDeposit=${relayerHasDeposit}`);
  console.log(`RelayerHasViewSystemData=${relayerHasViewSystemData}`);
  console.log(`RelayerHasActionViewPush=${relayerHasActionViewPush}`);
  console.log(`RelayerIsAcmOwner=${relayerIsAcmOwner}`);
  console.log(`SettlementManagerHasRepay=${settlementManagerHasRepay}`);
  console.log(`SettlementManagerHasViewSystemData=${settlementManagerHasViewSystemData}`);
  console.log(`AutoGrantRuntimeRoles=${autoGrantRuntimeRoles}`);
  if (feeRouterViewAddr && feeRouterViewAddr !== ethers.ZeroAddress) {
    const feeRouterViewBinding = await readFeeRouterViewBinding({
      vaultCoreAddr,
      expectedFeeRouterViewAddr: feeRouterViewAddr,
    });
    console.log(
      `FeeRouterViewBinding viewGateway=${feeRouterViewBinding.viewGatewayAddr} configured=${feeRouterViewBinding.configuredFeeRouterViewAddr} registry=${feeRouterViewBinding.expectedFeeRouterViewAddr} aligned=${feeRouterViewBinding.aligned}`,
    );
  }

  return {
    label: params.label,
    registryAddr,
    pair: {
      ...pair,
      settlementAsset,
      borrowAsset,
      selectionSource,
    },
    relayer,
    viewer,
    borrower,
    lender,
    priceOracle,
    updater,
    acm,
    assetWhitelist,
    feeRouter,
    gfm,
    ergm,
    vaultCore,
    vbl,
    orderEngine,
    settlementToken,
    borrowToken,
    collateralToken,
    valuationView,
    viewCache,
    rewardView,
    healthView,
    positionView,
    statisticsView,
    loanFlowView,
    feeRouterView,
    systemRiskView,
    riskView,
    previewView,
    userView,
    dashboardView,
    cacheOptimizedView,
    registryView,
    batchView,
    loanNftView,
    moduleHealthView,
    accessControlView,
    lendingEngineView,
    eventHistoryManager,
    lenderPoolVaultAddr,
    vaultCoreAddr,
    collateralManagerAddr,
    vblAddr,
    orderEngineAddr,
    feeRouterAddr,
    guaranteeFundAddr,
    ergmAddr,
    settlementManagerAddr,
    accessControlViewAddr,
    lendingEngineViewAddr,
    eventHistoryManagerAddr,
    borrowAssetAddr,
    collateralAssetAddr,
    settlementTokenAddr,
    borrowSymbol,
    collateralSymbol,
    settlementSymbol,
    borrowDecimals,
    collateralDecimals,
    settlementDecimals,
    collateralAmount,
    borrowAmount,
    termDays,
    rateBps,
    interest,
    totalDue,
    livePriceMode,
    allowBootstrapPriceOnMissing,
    allowDirectOraclePriceWrite,
    relayerHasSetParameter,
  } satisfies FundsFlowLiveContext;
}

export async function ensureFundsFlowEnvironmentReady(ctx: FundsFlowLiveContext) {
  const blockers: string[] = [];
  const failOnMissingRuntimeRoles = envBool(
    "LIVE_FAIL_ON_MISSING_RUNTIME_ROLES",
    envBool("LIVE_AUTO_GRANT_RUNTIME_ROLES", true) === false,
  );
  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const settlementFromRegistry = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;

  const settlementConfig = (await ctx.priceOracle.getAssetConfig(ctx.settlementTokenAddr)) as any;
  const borrowConfig = (await ctx.priceOracle.getAssetConfig(ctx.borrowAssetAddr)) as any;
  const collateralConfig = (await ctx.priceOracle.getAssetConfig(ctx.collateralAssetAddr)) as any;
  const settlementWhitelisted = (await ctx.assetWhitelist.isAssetAllowed(ctx.settlementTokenAddr)) as boolean;
  const borrowWhitelisted = (await ctx.assetWhitelist.isAssetAllowed(ctx.borrowAssetAddr)) as boolean;
  const collateralWhitelisted = (await ctx.assetWhitelist.isAssetAllowed(ctx.collateralAssetAddr)) as boolean;
  const settlementFeeSupported = (await ctx.feeRouter.isTokenSupported(ctx.settlementTokenAddr)) as boolean;
  const borrowFeeSupported = (await ctx.feeRouter.isTokenSupported(ctx.borrowAssetAddr)) as boolean;

  if (settlementFromRegistry.toLowerCase() !== ctx.settlementTokenAddr.toLowerCase()) {
    blockers.push(`Registry settlement token ${settlementFromRegistry} does not match selected ${ctx.settlementTokenAddr}`);
  }
  if (!settlementWhitelisted) blockers.push("Settlement token is not allowed by AssetWhitelist");
  if (!borrowWhitelisted) blockers.push("Borrow asset is not allowed by AssetWhitelist");
  if (!collateralWhitelisted) blockers.push("Collateral asset is not allowed by AssetWhitelist");
  if (!settlementFeeSupported) blockers.push("FeeRouter does not support settlement token");
  if (!borrowFeeSupported) blockers.push("FeeRouter does not support borrow asset");
  if (!(settlementConfig.isActive ?? settlementConfig[2])) blockers.push("Settlement token price config is not active");
  if (!(borrowConfig.isActive ?? borrowConfig[2])) blockers.push("Borrow asset price config is not active");
  if (!(collateralConfig.isActive ?? collateralConfig[2])) blockers.push("Collateral asset price config is not active");
  if (ctx.feeRouterView) {
    const feeRouterViewBinding = await readFeeRouterViewBinding({
      vaultCoreAddr: ctx.vaultCoreAddr,
      expectedFeeRouterViewAddr: String(ctx.feeRouterView.target),
    });
    if (!feeRouterViewBinding.viewGatewayAddr || feeRouterViewBinding.viewGatewayAddr === ethers.ZeroAddress) {
      blockers.push("VaultCore.viewContractAddrVar() is unset; FeeRouterView push gateway cannot be resolved");
    } else if (!feeRouterViewBinding.aligned) {
      blockers.push(
        `VaultRouter FeeRouterView target ${feeRouterViewBinding.configuredFeeRouterViewAddr} does not match Registry FEE_ROUTER_VIEW ${feeRouterViewBinding.expectedFeeRouterViewAddr}`,
      );
    }
  }

  if (failOnMissingRuntimeRoles) {
    const relayerRolesToCheck = ["VIEW_PRICE_DATA", "DEPOSIT", "VIEW_SYSTEM_DATA", "ACTION_VIEW_PUSH"] as const;
    for (const roleName of relayerRolesToCheck) {
      const hasRole = (await ctx.acm.hasRole(key(roleName), ctx.relayer.address)) as boolean;
      if (!hasRole) {
        blockers.push(`relayer ${ctx.relayer.address} lacks ${roleName}`);
      }
    }
  }

  if (blockers.length > 0) {
    throw new Error(blockers.join("; "));
  }
}

export async function ensureFundsFlowPrices(ctx: FundsFlowLiveContext) {
  const autoGrantUpdatePrice = envBool("AUTO_GRANT_UPDATE_PRICE", false);
  const forcePriceUpdate = envBool("FORCE_PRICE_UPDATE", false);
  const minPriceAgeBlocks = resolvePriceRepairMinAgeBlocks();
  const readRetryAttempts = resolvePriceReadRetryAttempts();
  const readRetryWaitBlocks = resolvePriceReadRetryWaitBlocks();
  const updatePriceRole = key("UPDATE_PRICE");
  let relayerHasUpdatePrice = (await ctx.acm.hasRole(updatePriceRole, ctx.relayer.address)) as boolean;
  const acmOwner = (await ctx.acm.owner()) as string;
  const relayerIsOwner = acmOwner.toLowerCase() === ctx.relayer.address.toLowerCase();

  if (!ctx.allowDirectOraclePriceWrite && !ctx.updater) {
    throw new Error("PriceUpdater is not configured. Set ALLOW_DIRECT_PRICE_ORACLE=1 only for break-glass fallback.");
  }

  if (forcePriceUpdate && !relayerHasUpdatePrice && relayerIsOwner && autoGrantUpdatePrice) {
    await (await ctx.acm.connect(ctx.relayer).grantRole(updatePriceRole, ctx.relayer.address)).wait();
    relayerHasUpdatePrice = true;
  }

  const pricesToCheck = [
    {
      asset: ctx.pair.borrowAsset,
      priceHint: envStr("BORROW_PRICE_VALUE") ?? getAssetBootstrapPriceValue(ctx.pair.borrowAsset),
    },
    {
      asset: ctx.pair.collateralAsset,
      priceHint: envStr("COLLATERAL_PRICE_VALUE") ?? getAssetBootstrapPriceValue(ctx.pair.collateralAsset),
    },
  ];

  const ensureOracleReadable = async (
    item: (typeof pricesToCheck)[number],
    oraclePrice: bigint,
    updateBlock: bigint,
  ) => {
    try {
      const [price, blockNumber] = (await ctx.priceOracle.getPrice(item.asset.address)) as [bigint, bigint, bigint];
      if (price > 0n && blockNumber > 0n) {
        return;
      }
    } catch {
      // Fall through to direct-oracle repair.
    }

    if (!envBool("LIVE_AUTO_REPAIR_PRICE_ORACLE", true)) {
      throw new Error(`PriceOracle remains unreadable for ${item.asset.symbol} after updater path; set LIVE_AUTO_REPAIR_PRICE_ORACLE=1 to repair in-place`);
    }

    const config = (await ctx.priceOracle.getAssetConfig(item.asset.address)) as {
      sourceId: string;
      assetDecimals: bigint;
      isActive: boolean;
      maxPriceAgeBlocks: bigint;
    };
    const sourceId = String(config.sourceId ?? "");
    const configuredDecimals = BigInt(config.assetDecimals ?? 0n);
    const configuredMaxPriceAgeBlocks = BigInt(config.maxPriceAgeBlocks ?? 0n);
    const needsConfigure =
      !config.isActive ||
      configuredDecimals !== BigInt(item.asset.decimals) ||
      sourceId.length === 0 ||
      configuredMaxPriceAgeBlocks < minPriceAgeBlocks;

    if (needsConfigure) {
      if (!ctx.relayerHasSetParameter) {
        throw new Error(`PriceOracle asset repair required for ${item.asset.symbol}, but relayer lacks SET_PARAMETER`);
      }
      await (await ctx.priceOracle.connect(ctx.relayer).configureAsset(
        item.asset.address,
        item.asset.sourceId,
        item.asset.decimals,
        minPriceAgeBlocks,
      )).wait();
      console.log(`[PriceRepair] configured ${item.asset.symbol} directly in PriceOracle sourceId=${item.asset.sourceId} decimals=${item.asset.decimals} maxPriceAgeBlocks=${minPriceAgeBlocks.toString()}`);
    }

    await (await ctx.priceOracle.connect(ctx.relayer).updatePrice(item.asset.address, oraclePrice, updateBlock)).wait();
    console.log(`[PriceRepair] updated ${item.asset.symbol} directly in PriceOracle -> ${item.priceHint} price-value(decimals=${item.asset.decimals})`);

    let lastError: unknown;
    for (let attempt = 1; attempt <= readRetryAttempts; attempt++) {
      try {
        const [price, blockNumber] = (await ctx.priceOracle.getPrice(item.asset.address)) as [bigint, bigint, bigint];
        if (price > 0n && blockNumber > 0n) {
          if (attempt > 1) {
            console.log(`[PriceRepair] readable after retry ${attempt}/${readRetryAttempts} for ${item.asset.symbol}`);
          }
          return;
        }
        lastError = new Error(`PriceOracle repair read returned non-positive values for ${item.asset.symbol}`);
      } catch (err) {
        lastError = err;
      }

      if (attempt < readRetryAttempts) {
        if (readRetryWaitBlocks > 0) {
          await waitForBlockAdvance(readRetryWaitBlocks);
        } else {
          await delay(resolvePriceReadRetryPollMs());
        }
      }
    }

    throw new Error(
      `PriceOracle repair did not produce a readable price for ${item.asset.symbol} after ${readRetryAttempts} attempt(s). lastError=${fmtErr(lastError)}`,
    );
  };

  if (minPriceAgeBlocks < 5n) {
    console.log(`[PriceRepair] LIVE_PRICE_REPAIR_MIN_AGE_BLOCKS=${minPriceAgeBlocks.toString()} (recommended >= 5 on bnbTestnet for stability)`);
  } else {
    console.log(`[PriceRepair] minimum maxPriceAgeBlocks floor=${minPriceAgeBlocks.toString()}`);
    }

  for (const item of pricesToCheck) {
    let readable = false;
    try {
      const [price, blockNumber] = (await ctx.priceOracle.getPrice(item.asset.address)) as [bigint, bigint, bigint];
      readable = price > 0n && blockNumber > 0n;
    } catch {
      readable = false;
    }

    if (!forcePriceUpdate && readable) {
      continue;
    }
    if (!readable && !ctx.allowBootstrapPriceOnMissing && !forcePriceUpdate) {
      throw new Error(`Missing on-chain final price for ${item.asset.symbol}. LIVE_PRICE_MODE=backend-required blocks automatic bootstrap publication.`);
    }
    if (!relayerHasUpdatePrice) {
      if (relayerIsOwner && autoGrantUpdatePrice) {
        await (await ctx.acm.connect(ctx.relayer).grantRole(updatePriceRole, ctx.relayer.address)).wait();
        relayerHasUpdatePrice = true;
      } else {
        throw new Error(`Price update required for ${item.asset.symbol}, but relayer lacks UPDATE_PRICE`);
      }
    }

    const oraclePrice = ethers.parseUnits(item.priceHint, item.asset.decimals);
    const updateBlock = BigInt(await ethers.provider.getBlockNumber());
    if (ctx.updater) {
      await (await updateAssetPriceWithRepair({
        updater: ctx.updater,
        acm: ctx.acm,
        relayer: ctx.relayer,
        asset: item.asset,
        price: oraclePrice,
        blockNumber: updateBlock,
      })).wait();
      console.log(`[Price] ${item.asset.symbol} via updater -> ${item.priceHint} price-value(decimals=${item.asset.decimals})`);
      await ensureOracleReadable(item, oraclePrice, updateBlock);
      continue;
    }
    await (await ctx.priceOracle.connect(ctx.relayer).updatePrice(item.asset.address, oraclePrice, updateBlock)).wait();
    console.log(`[Price] ${item.asset.symbol} via PriceOracle -> ${item.priceHint} price-value(decimals=${item.asset.decimals})`);
  }
}

export async function fundFundsFlowActors(
  ctx: FundsFlowLiveContext,
  options: {
    borrowerBorrowAmount?: bigint;
    borrowerCollateralAmount?: bigint;
    lenderBorrowAmount?: bigint;
  } = {},
) {
  const borrowerBorrowAmount = options.borrowerBorrowAmount ?? 0n;
  const borrowerCollateralAmount = options.borrowerCollateralAmount ?? 0n;
  const lenderBorrowAmount = options.lenderBorrowAmount ?? 0n;

  const borrowFunding: TokenFundingPlan = {
    tokenLabel: "borrow",
    decimals: ctx.borrowDecimals,
    relayerBalance: (await ctx.borrowToken.balanceOf(ctx.relayer.address)) as bigint,
    targets: new Map<string, bigint>(),
  };
  if (borrowerBorrowAmount > 0n) addTarget(borrowFunding.targets, ctx.borrower.address, borrowerBorrowAmount);
  if (lenderBorrowAmount > 0n) addTarget(borrowFunding.targets, ctx.lender.address, lenderBorrowAmount);

  const collateralFunding: TokenFundingPlan = {
    tokenLabel: "collateral",
    decimals: ctx.collateralDecimals,
    relayerBalance: (await ctx.collateralToken.balanceOf(ctx.relayer.address)) as bigint,
    targets: new Map<string, bigint>(),
  };
  if (borrowerCollateralAmount > 0n) {
    addTarget(collateralFunding.targets, ctx.borrower.address, borrowerCollateralAmount);
  }

  await fundTokenTargets(ctx.borrowToken, ctx.borrowSymbol, ctx.relayer, borrowFunding);
  await fundTokenTargets(ctx.collateralToken, ctx.collateralSymbol, ctx.relayer, collateralFunding);
}

async function collectBorrowerDirtyReasons(
  ctx: FundsFlowLiveContext,
  borrowerAddress: string,
  deps?: {
    lendingEngine?: any;
    collateralManager?: any;
  },
) {
  const registry = deps?.lendingEngine && deps?.collateralManager
    ? null
    : ((await ethers.getContractAt(
        ["function getModuleOrRevert(bytes32) view returns (address)"],
        ctx.registryAddr,
      )) as any);
  const lendingEngine = deps?.lendingEngine ?? (await ethers.getContractAt(
    ["function getDebt(address user,address asset) view returns (uint256)"],
    ((await registry!.getModuleOrRevert(key("LENDING_ENGINE"))) as string),
  )) as any;
  const collateralManager = deps?.collateralManager ?? (await ethers.getContractAt(
    ["function getCollateral(address user,address asset) view returns (uint256)"],
    ctx.collateralManagerAddr,
  )) as any;

  const dirtyReasons: string[] = [];

  if (ctx.userView) {
    try {
      const [totalCollateral, totalDebt, isValid] = (await ctx.userView.getUserTotalsWithMeta(borrowerAddress)) as [
        bigint,
        bigint,
        boolean,
        bigint,
        bigint,
        bigint,
      ];
      if (isValid) {
        if (BigInt(totalCollateral) > 0n) {
          dirtyReasons.push(`userTotals collateral=${BigInt(totalCollateral).toString()}`);
        }
        if (BigInt(totalDebt) > 0n) {
          dirtyReasons.push(`userTotals debt=${BigInt(totalDebt).toString()}`);
        }
      }
    } catch {
      // Fall back to direct module reads below.
    }
  }

  const [collateralBalance, debtBalance, guaranteeState] = await Promise.all([
    collateralManager.getCollateral(borrowerAddress, ctx.collateralAssetAddr) as Promise<bigint>,
    lendingEngine.getDebt(borrowerAddress, ctx.borrowAssetAddr) as Promise<bigint>,
    getGuaranteeState(ctx, borrowerAddress, ctx.borrowAssetAddr),
  ]);

  if (BigInt(collateralBalance) > 0n) {
    dirtyReasons.push(`${ctx.collateralSymbol} collateral=${BigInt(collateralBalance).toString()}`);
  }
  if (BigInt(debtBalance) > 0n) {
    dirtyReasons.push(`${ctx.borrowSymbol} debt=${BigInt(debtBalance).toString()}`);
  }
  if (guaranteeState.active || guaranteeState.locked > 0n || guaranteeState.guaranteeId > 0n) {
    dirtyReasons.push(
      `guarantee active=${guaranteeState.active} locked=${guaranteeState.locked.toString()} id=${guaranteeState.guaranteeId.toString()}`,
    );
  }

  if (ctx.loanNftView) {
    try {
      const [loanCount, isValid] = (await ctx.loanNftView.getUserLoanCount(borrowerAddress)) as [bigint, boolean, bigint];
      if (isValid && BigInt(loanCount) > 0n) {
        dirtyReasons.push(`loanCount=${BigInt(loanCount).toString()}`);
      }
    } catch {
      // Keep the allocation if loan-count read is unavailable.
    }
  }

  return dirtyReasons;
}

export async function assignFreshBorrower(
  ctx: FundsFlowLiveContext,
  options: {
    nativeAmountWei?: bigint;
    nativeAmountEth?: string;
    noticeLabel?: string;
  } = {},
) {
  const isForkAliasMode = (network.name === "localhost" || network.name === "hardhat") && Boolean(envStr("LIVE_NETWORK_ALIAS"));
  const keepConfiguredBorrower = isForkAliasMode && !envBool("LIVE_FORK_FORCE_FRESH_BORROWER", false);

  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const lendingEngine = (await ethers.getContractAt(
    ["function getDebt(address user,address asset) view returns (uint256)"],
    lendingEngineAddr,
  )) as any;
  const collateralManager = (await ethers.getContractAt(
    ["function getCollateral(address user,address asset) view returns (uint256)"],
    ctx.collateralManagerAddr,
  )) as any;
  const maxAttempts = resolveFreshActorMaxAttempts();

  if (keepConfiguredBorrower) {
    const dirtyReasons = await collectBorrowerDirtyReasons(ctx, ctx.borrower.address, {
      lendingEngine,
      collateralManager,
    });
    if (dirtyReasons.length === 0) {
      console.log(
        `  [Notice] keeping configured borrower ${ctx.borrower.address} for fork alias mode (set LIVE_FORK_FORCE_FRESH_BORROWER=1 to allocate a fresh borrower)`,
      );
      return ctx.borrower;
    }
    console.log(
      `  [Notice] configured borrower ${ctx.borrower.address} is not chain-clean in fork alias mode; allocating fresh borrower instead. reasons=${dirtyReasons.join(", ")}`,
    );
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const allocation = await assignFreshBorrowerWithRecovery({
      label: options.noticeLabel ?? `${ctx.label}-fresh-borrower`,
      noticeLabel: options.noticeLabel,
      sponsors: buildNativeTopUpSponsors([], ctx.relayer, ctx.lender, ctx.viewer),
      nativeAmountWei: resolveFundsFlowFreshBorrowerNativeAmount(options),
      nativeAmountEth: options.nativeAmountEth,
      sponsorReserveEth: resolveFreshBorrowerSponsorReserveEth(),
    });

    const borrowerAddress = allocation.wallet.address;
    if (hasFreshActorAddress(borrowerAddress)) {
      console.log(
        `  [Notice] skipping duplicate fresh borrower ${borrowerAddress} attempt=${attempt}/${maxAttempts} reason=dedupe-cache`,
      );
      continue;
    }

    const dirtyReasons = await collectBorrowerDirtyReasons(ctx, borrowerAddress, {
      lendingEngine,
      collateralManager,
    });

    if (dirtyReasons.length === 0) {
      ctx.borrower = allocation.wallet;
      markFreshActorAddress(borrowerAddress);
      return allocation.wallet;
    }

    console.log(
      `  [Notice] skipping reused fresh borrower ${borrowerAddress} attempt=${attempt}/${maxAttempts} reasons=${dirtyReasons.join(", ")}`,
    );
  }

  throw new Error(`unable to allocate a chain-clean fresh borrower after ${maxAttempts} attempts`);
}

export async function assignFreshLender(
  ctx: FundsFlowLiveContext,
  options: {
    nativeAmountWei?: bigint;
    nativeAmountEth?: string;
    noticeLabel?: string;
  } = {},
) {
  const registry = (await ethers.getContractAt(
    ["function getModuleOrRevert(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const lendingEngineAddr = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const lendingEngine = (await ethers.getContractAt(
    ["function getDebt(address user,address asset) view returns (uint256)"],
    lendingEngineAddr,
  )) as any;
  const collateralManager = (await ethers.getContractAt(
    ["function getCollateral(address user,address asset) view returns (uint256)"],
    ctx.collateralManagerAddr,
  )) as any;
  const maxAttempts = resolveFreshActorMaxAttempts();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const allocation = await assignFreshBorrowerWithRecovery({
      label: options.noticeLabel ?? `${ctx.label}-fresh-lender`,
      noticeLabel: options.noticeLabel ?? "using fresh lender",
      sponsors: buildNativeTopUpSponsors([], ctx.relayer, ctx.viewer, ctx.borrower),
      nativeAmountWei: resolveFundsFlowFreshLenderNativeAmount(options),
      nativeAmountEth: options.nativeAmountEth,
      sponsorReserveEth: resolveFreshBorrowerSponsorReserveEth(),
    });

    const lenderAddress = allocation.wallet.address;
    if (lenderAddress.toLowerCase() === ctx.borrower.address.toLowerCase()) {
      console.log(
        `  [Notice] skipping duplicate fresh lender ${lenderAddress} attempt=${attempt}/${maxAttempts} reason=same-as-borrower`,
      );
      continue;
    }
    if (hasFreshActorAddress(lenderAddress)) {
      console.log(
        `  [Notice] skipping duplicate fresh lender ${lenderAddress} attempt=${attempt}/${maxAttempts} reason=dedupe-cache`,
      );
      continue;
    }

    const dirtyReasons = await collectBorrowerDirtyReasons(ctx, lenderAddress, {
      lendingEngine,
      collateralManager,
    });
    if (dirtyReasons.length > 0) {
      console.log(
        `  [Notice] skipping reused fresh lender ${lenderAddress} attempt=${attempt}/${maxAttempts} reasons=${dirtyReasons.join(", ")}`,
      );
      continue;
    }

    ctx.lender = allocation.wallet;
    markFreshActorAddress(lenderAddress);
    return allocation.wallet;
  }

  throw new Error(`unable to allocate a chain-clean fresh lender after ${maxAttempts} attempts`);
}

export async function ensureRelayerNativeGasReserve(
  ctx: FundsFlowLiveContext,
  label: string,
  sponsors?: Array<Sponsor | null | undefined>,
  options?: {
    desiredBalanceWei?: bigint;
    reserveWei?: bigint;
  },
) {
  const normalizedSponsors = sponsors?.filter((sponsor): sponsor is Sponsor => Boolean(sponsor));
  await ensureRecoverableNativeTopUp({
    label,
    target: ctx.relayer,
    sponsors: normalizedSponsors ?? buildNativeTopUpSponsors([ctx.relayer.address], ctx.borrower, ctx.lender, ctx.viewer),
    desiredBalanceWei: options?.desiredBalanceWei ?? ethers.parseEther(envStr("LIVE_RELAYER_NATIVE_TARGET_ETH") ?? "0.00015"),
    reserveWei: options?.reserveWei ?? ethers.parseEther(
      envStr("LIVE_RELAYER_NATIVE_SPONSOR_RESERVE_ETH")
        ?? envStr("LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH")
        ?? "0.00005",
    ),
  });
}

export async function bootstrapFundsFlowLiveTest(params: {
  label: string;
  collateralAmountUnitsDefault: string;
  borrowAmountUnitsDefault: string;
  noticeLabel?: string;
  withFreshBorrower?: boolean;
  withFreshLender?: boolean;
  fundActors?: {
    borrowerBorrowAmount?: bigint;
    borrowerCollateralAmount?: bigint;
    lenderBorrowAmount?: bigint;
  };
  useDefaultActorFunding?: boolean;
}): Promise<FundsFlowBootstrapResult> {
  const ctx = await createFundsFlowLiveContext({
    label: params.label,
    collateralAmountUnitsDefault: params.collateralAmountUnitsDefault,
    borrowAmountUnitsDefault: params.borrowAmountUnitsDefault,
  });

  if (params.withFreshBorrower) {
    await assignFreshBorrower(ctx, { noticeLabel: params.noticeLabel });
  }
  if (params.withFreshLender) {
    await assignFreshLender(ctx, { noticeLabel: params.noticeLabel ? `${params.noticeLabel} lender` : undefined });
  }

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);

  if (params.useDefaultActorFunding || params.fundActors) {
    await fundFundsFlowActors(ctx, {
      borrowerBorrowAmount: params.fundActors?.borrowerBorrowAmount ?? (params.useDefaultActorFunding ? ctx.totalDue : 0n),
      borrowerCollateralAmount: params.fundActors?.borrowerCollateralAmount ?? (params.useDefaultActorFunding ? ctx.collateralAmount : 0n),
      lenderBorrowAmount: params.fundActors?.lenderBorrowAmount ?? (params.useDefaultActorFunding ? ctx.borrowAmount : 0n),
    });
  }

  return { ctx };
}

export async function ensureTokenAllowance(token: any, owner: any, spender: string, amount: bigint, label: string) {
  const allowance = (await token.allowance(owner.address, spender)) as bigint;
  if (allowance >= amount) {
    return;
  }
  await (await token.connect(owner).approve(spender, ethers.MaxUint256)).wait();
  console.log(`[Approve] ${label} owner=${owner.address} spender=${spender}`);

  const timeoutMs = resolveAllowanceConvergenceTimeoutMs();
  const pollMs = resolveAllowanceConvergencePollMs();
  const confirmationsNeeded = resolveAllowanceConvergenceConfirmations();
  const deadline = Date.now() + timeoutMs;
  let lastAllowance = allowance;
  let confirmations = 0;

  while (Date.now() < deadline) {
    lastAllowance = (await token.allowance(owner.address, spender)) as bigint;
    if (lastAllowance >= amount) {
      if (lastAllowance === ethers.MaxUint256) {
        return;
      }
      confirmations += 1;
      if (confirmations >= confirmationsNeeded) {
        return;
      }
    } else {
      confirmations = 0;
    }
    await delay(pollMs);
  }

  throw new Error(
    `${label}: allowance did not converge before timeout; owner=${owner.address} spender=${spender} needed=${amount.toString()} last=${lastAllowance.toString()}`,
  );
}

export async function ensureApprovalNativeTopUp(params: {
  token: any;
  owner: any;
  spender: string;
  sponsors: Sponsor[];
  label: string;
  reserveEthEnvKey?: string;
}) {
  const populatedApproveTx = await params.token.connect(params.owner).approve.populateTransaction(
    params.spender,
    ethers.MaxUint256,
  );
  const approvalEstimate = await ethers.provider.estimateGas({
    from: params.owner.address,
    to: populatedApproveTx.to,
    data: populatedApproveTx.data,
    value: populatedApproveTx.value ?? 0n,
  });
  const approvalGasLimit = withGasBuffer(approvalEstimate);
  const feeData = await ethers.provider.getFeeData();
  const approvalGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? resolveBnbMinGasPriceWei();
  const approvalNativeTargetWei = approvalGasLimit * approvalGasPrice
    + (populatedApproveTx.value ?? 0n)
    + ethers.parseEther(envStr("LIVE_FUNDS_FLOW_APPROVE_NATIVE_RESERVE_ETH") ?? "0.00003");

  await ensureRecoverableNativeTopUp({
    label: `${params.label}-approve-native-gas`,
    target: params.owner,
    sponsors: params.sponsors,
    desiredBalanceWei: approvalNativeTargetWei,
    reserveWei: ethers.parseEther(
      envStr(params.reserveEthEnvKey ?? "LIVE_FUNDS_FLOW_APPROVE_SPONSOR_RESERVE_ETH")
        ?? resolveFreshBorrowerSponsorReserveEth(),
    ),
    failOnShortfall: true,
  });
}

export async function observeExtendedViews(ctx: FundsFlowLiveContext, label: string) {
  const notices: string[] = [];
  const base = await observeLiveState({
    debtAsset: ctx.pair.borrowAsset,
    collateralAsset: ctx.pair.collateralAsset,
    borrower: ctx.borrower,
    lender: ctx.lender,
    valuationView: ctx.valuationView,
    viewCache: ctx.viewCache,
    rewardView: ctx.rewardView,
    healthView: ctx.healthView,
    positionView: ctx.positionView,
  });

  printObservation(label, base);

  const snapshot: ExtendedViewSnapshot = {
    base,
    notices,
  };

  if (ctx.statisticsView) {
    const global = await tryRead("StatisticsView.getGlobalStatisticsWithMeta", async () => {
      const [stats, isValid, blockNumber] = (await ctx.statisticsView.getGlobalStatisticsWithMeta()) as [any, boolean, bigint];
      return {
        totalUsers: BigInt(stats.totalUsers ?? stats[0] ?? 0),
        activeUsers: BigInt(stats.activeUsers ?? stats[1] ?? 0),
        totalCollateral: BigInt(stats.totalCollateral ?? stats[2] ?? 0),
        totalDebt: BigInt(stats.totalDebt ?? stats[3] ?? 0),
        isValid,
        blockNumber,
      };
    }, notices);
    if (global) snapshot.statisticsGlobal = global;

    const user = await tryRead("StatisticsView.getUserSnapshotWithMeta", async () => {
      const [stats, , , , isValid, blockNumber] = (await ctx.statisticsView
        .connect(ctx.borrower)
        .getUserSnapshotWithMeta(ctx.borrower.address)) as [any, bigint, bigint, string, boolean, bigint];
      return {
        collateral: BigInt(stats.collateral ?? stats[0] ?? 0),
        debt: BigInt(stats.debt ?? stats[1] ?? 0),
        isValid,
        blockNumber,
      };
    }, notices);
    if (user) snapshot.statisticsUser = user;
  }

  if (ctx.loanFlowView) {
    const global = await tryRead("LoanFlowView.getGlobalLoanFlowWithMeta", async () => {
      const [borrowVolumeUsd8, repayVolumeUsd8, borrowCount, repayCount, isValid, blockNumber] =
        (await ctx.loanFlowView.getGlobalLoanFlowWithMeta()) as [bigint, bigint, bigint, bigint, boolean, bigint];
      return {
        borrowVolumeUsd8,
        repayVolumeUsd8,
        borrowCount,
        repayCount,
        isValid,
        blockNumber,
      };
    }, notices);
    if (global) snapshot.loanFlowGlobal = global;

    const user = await tryRead("LoanFlowView.getUserLoanFlowWithMeta", async () => {
      const [borrowVolumeUsd8, repayVolumeUsd8, borrowCount, repayCount, , , , isValid, blockNumber] =
        (await ctx.loanFlowView.connect(ctx.borrower).getUserLoanFlowWithMeta(ctx.borrower.address)) as [
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          string,
          boolean,
          bigint,
        ];
      return {
        borrowVolumeUsd8,
        repayVolumeUsd8,
        borrowCount,
        repayCount,
        isValid,
        blockNumber,
      };
    }, notices);
    if (user) snapshot.loanFlowUser = user;
  }

  if (ctx.feeRouterView) {
    const sync = await tryRead("FeeRouterView.getSyncStatus", async () => {
      const [isValid, lastSyncBlock, needsSync] = (await ctx.feeRouterView.getSyncStatus()) as [boolean, bigint, boolean];
      return { isValid, lastSyncBlock, needsSync };
    }, notices);
    if (sync) snapshot.feeRouterSync = sync;

    const user = await tryRead("FeeRouterView.getUserStatsWithMeta", async () => {
      const [stats] = (await ctx.feeRouterView
        .connect(ctx.borrower)
        .getUserStatsWithMeta(ctx.borrower.address)) as [any, bigint, boolean];
      return {
        totalFeePaid: BigInt(stats.totalFeePaid ?? stats[0] ?? 0),
        transactionCount: BigInt(stats.transactionCount ?? stats[1] ?? 0),
        lastActivityBlock: BigInt(stats.lastActivityBlock ?? stats[2] ?? 0),
      };
    }, notices);
    if (user) snapshot.feeRouterUser = user;
  }

  if (ctx.systemRiskView) {
    const risk = await tryRead("SystemRiskView", async () => {
      const [liquidationThreshold, minHealthFactor, maxLtvBps] = await Promise.all([
        ctx.systemRiskView.connect(ctx.relayer).getLiquidationThreshold(),
        ctx.systemRiskView.connect(ctx.relayer).getMinHealthFactor(),
        ctx.systemRiskView.connect(ctx.relayer).getMaxLtvBps(),
      ]);
      return { liquidationThreshold, minHealthFactor, maxLtvBps };
    }, notices);
    if (risk) snapshot.systemRisk = risk;
  }

  if (snapshot.statisticsGlobal) {
    console.log(
      `  [StatisticsView.global] totalUsers=${snapshot.statisticsGlobal.totalUsers.toString()} activeUsers=${snapshot.statisticsGlobal.activeUsers.toString()} totalCollateral=${snapshot.statisticsGlobal.totalCollateral.toString()} totalDebt=${snapshot.statisticsGlobal.totalDebt.toString()} valid=${snapshot.statisticsGlobal.isValid}`,
    );
  }
  if (snapshot.statisticsUser) {
    console.log(
      `  [StatisticsView.user] collateral=${snapshot.statisticsUser.collateral.toString()} debt=${snapshot.statisticsUser.debt.toString()} valid=${snapshot.statisticsUser.isValid}`,
    );
  }
  if (snapshot.loanFlowGlobal) {
    console.log(
      `  [LoanFlowView.global] borrow=${snapshot.loanFlowGlobal.borrowVolumeUsd8.toString()} repay=${snapshot.loanFlowGlobal.repayVolumeUsd8.toString()} borrowCount=${snapshot.loanFlowGlobal.borrowCount.toString()} repayCount=${snapshot.loanFlowGlobal.repayCount.toString()} valid=${snapshot.loanFlowGlobal.isValid}`,
    );
  }
  if (snapshot.loanFlowUser) {
    console.log(
      `  [LoanFlowView.user] borrow=${snapshot.loanFlowUser.borrowVolumeUsd8.toString()} repay=${snapshot.loanFlowUser.repayVolumeUsd8.toString()} borrowCount=${snapshot.loanFlowUser.borrowCount.toString()} repayCount=${snapshot.loanFlowUser.repayCount.toString()} valid=${snapshot.loanFlowUser.isValid}`,
    );
  }
  if (snapshot.feeRouterSync) {
    console.log(
      `  [FeeRouterView.sync] valid=${snapshot.feeRouterSync.isValid} lastSyncBlock=${snapshot.feeRouterSync.lastSyncBlock.toString()} needsSync=${snapshot.feeRouterSync.needsSync}`,
    );
  }
  if (snapshot.feeRouterUser) {
    console.log(
      `  [FeeRouterView.user] totalFeePaid=${snapshot.feeRouterUser.totalFeePaid.toString()} txCount=${snapshot.feeRouterUser.transactionCount.toString()} lastActivityBlock=${snapshot.feeRouterUser.lastActivityBlock.toString()}`,
    );
  }
  if (snapshot.systemRisk) {
    console.log(
      `  [SystemRiskView] liquidationThreshold=${snapshot.systemRisk.liquidationThreshold.toString()} minHealthFactor=${snapshot.systemRisk.minHealthFactor.toString()} maxLtvBps=${snapshot.systemRisk.maxLtvBps.toString()}`,
    );
  }
  for (const notice of notices) {
    console.log(`  [Notice] ${notice}`);
  }

  return snapshot;
}

export async function depositCollateral(ctx: FundsFlowLiveContext, amount = ctx.collateralAmount) {
  return depositCollateralAsset(ctx, {
    assetAddr: ctx.collateralAssetAddr,
    token: ctx.collateralToken,
    amount,
    decimals: ctx.collateralDecimals,
    symbol: ctx.collateralSymbol,
  });
}

export async function depositCollateralAsset(
  ctx: FundsFlowLiveContext,
  params: AssetRuntimeConfig & { amount: bigint },
) {
  const { assetAddr, token, amount, decimals, symbol } = params;
  await ensureApprovalNativeTopUp({
    token,
    owner: ctx.borrower,
    spender: ctx.collateralManagerAddr,
    sponsors: buildNativeTopUpSponsors([ctx.borrower.address], ctx.relayer, ctx.lender, ctx.viewer),
    label: `${ctx.label}-${symbol.toLowerCase()}-deposit-allowance`,
    reserveEthEnvKey: "LIVE_FUNDS_FLOW_DEPOSIT_SPONSOR_RESERVE_ETH",
  });
  await ensureTokenAllowance(
    token,
    ctx.borrower,
    ctx.collateralManagerAddr,
    amount,
    `${symbol} -> CollateralManager`,
  );
  const populatedDepositTx = await ctx.vaultCore.connect(ctx.borrower).deposit.populateTransaction(assetAddr, amount);
  const depositEstimate = await ethers.provider.estimateGas({
    from: ctx.borrower.address,
    to: populatedDepositTx.to,
    data: populatedDepositTx.data,
    value: populatedDepositTx.value ?? 0n,
  });
  const depositGasLimit = withGasBuffer(depositEstimate);
  const feeData = await ethers.provider.getFeeData();
  const depositGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? resolveBnbMinGasPriceWei();
  const depositNativeTargetWei = depositGasLimit * depositGasPrice + (populatedDepositTx.value ?? 0n) + resolveDepositNativeReserveWei();
  await ensureRecoverableNativeTopUp({
    label: `${ctx.label}-deposit-native-gas`,
    target: ctx.borrower,
    sponsors: buildNativeTopUpSponsors([ctx.borrower.address], ctx.relayer, ctx.lender, ctx.viewer),
    desiredBalanceWei: depositNativeTargetWei,
    reserveWei: ethers.parseEther(envStr("LIVE_FUNDS_FLOW_DEPOSIT_SPONSOR_RESERVE_ETH") ?? resolveFreshBorrowerSponsorReserveEth()),
    failOnShortfall: true,
  });
  const feeOverrides = feeData.maxFeePerGas
    ? {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
      }
    : {
        gasPrice: feeData.gasPrice ?? depositGasPrice,
      };
  const response = await ctx.borrower.sendTransaction({
    to: populatedDepositTx.to,
    data: populatedDepositTx.data,
    gasLimit: depositGasLimit,
    ...feeOverrides,
    value: populatedDepositTx.value ?? 0n,
  });
  const receipt = await response.wait();
  console.log(`[Deposit] ${formatUnits(amount, decimals)} ${symbol}`);
  return receipt;
}

export async function reserveForLending(ctx: FundsFlowLiveContext, amount = ctx.borrowAmount) {
  return reserveForLendingAsset(ctx, {
    assetAddr: ctx.borrowAssetAddr,
    token: ctx.borrowToken,
    amount,
    decimals: ctx.borrowDecimals,
    symbol: ctx.borrowSymbol,
  });
}

export async function reserveForLendingAsset(
  ctx: FundsFlowLiveContext,
  params: AssetRuntimeConfig & { amount: bigint },
) {
  const { assetAddr, token, amount, decimals, symbol } = params;

  const ensureLenderReserveBalance = async () => {
    const lenderBalance = (await token.balanceOf(ctx.lender.address)) as bigint;
    if (lenderBalance >= amount) {
      return { lenderBalance, toppedUp: false as const };
    }
    const topUp = amount - lenderBalance;
    const relayerBalance = (await token.balanceOf(ctx.relayer.address)) as bigint;
    if (relayerBalance < topUp) {
      throw new Error(
        `insufficient relayer ${symbol} balance for lender top-up: required=${formatUnits(topUp, decimals)} available=${formatUnits(relayerBalance, decimals)}`,
      );
    }
    await (await token.connect(ctx.relayer).transfer(ctx.lender.address, topUp)).wait();
    console.log(`[Funding] lender reserve top-up ${ctx.lender.address} +${formatUnits(topUp, decimals)} ${symbol} (pre=${formatUnits(lenderBalance, decimals)})`);
    return { lenderBalance, toppedUp: true as const };
  };

  // Retry rounds can consume lender balance; ensure the lender can always reserve this round's amount.
  await ensureLenderReserveBalance();

  await ensureApprovalNativeTopUp({
    token,
    owner: ctx.lender,
    spender: ctx.vblAddr,
    sponsors: buildNativeTopUpSponsors([ctx.lender.address], ctx.relayer, ctx.borrower, ctx.viewer),
    label: `${ctx.label}-${symbol.toLowerCase()}-reserve-allowance`,
  });
  await ensureTokenAllowance(token, ctx.lender, ctx.vblAddr, amount, `${symbol} -> VaultBusinessLogic`);
  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  const lendIntent = {
    lenderSigner: ctx.lender.address,
    asset: assetAddr,
    amount,
    minTermDays: ctx.termDays,
    maxTermDays: Math.max(ctx.termDays, 30),
    minRateBps: ctx.rateBps,
    expireAt: currentBlock + 1_800n,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`${ctx.label}-lend-${Date.now()}`)),
  };
  const lendHash = buildLendIntentHash(lendIntent);
  let staticCallFailed = false;
  try {
    await ctx.vbl.connect(ctx.lender).reserveForLending.staticCall(ctx.lender.address, assetAddr, amount, lendHash);
  } catch (error: any) {
    const explained = explainRevert(error, [ctx.vbl.interface, token.interface, LIVE_FLOW_ERROR_INTERFACE, ERC20_ERROR_INTERFACE].filter(Boolean as any));
    const rawCode = String(error?.code ?? "");
    const rawProvider = String(error?.shortMessage ?? error?.info?.error?.message ?? "");
    const rawText = `${explained} ${rawCode} ${rawProvider} ${fmtErr(error)}`;
    const likelyTransient = /(timeout|connect|socket|headers|econn|network|und_err)/i.test(rawText);
    const emptyRevert = /empty revert data/i.test(explained);

    const lenderBalanceError = /ERC20InsufficientBalance/i.test(rawText);

    if (lenderBalanceError) {
      await ensureLenderReserveBalance();
      try {
        await ctx.vbl.connect(ctx.lender).reserveForLending.staticCall(ctx.lender.address, assetAddr, amount, lendHash);
      } catch (retryError: any) {
        const retryExplained = explainRevert(retryError, [ctx.vbl.interface, token.interface, LIVE_FLOW_ERROR_INTERFACE, ERC20_ERROR_INTERFACE].filter(Boolean as any));
        throw new Error(`reserveForLending staticCall reverted after lender top-up retry: ${retryExplained}`);
      }
    } else if (likelyTransient || emptyRevert) {
      staticCallFailed = true;
      console.log(
        `  [Notice] reserveForLending staticCall preflight degraded for ${symbol}; continuing with direct tx (reason=${explained}${rawCode ? ` code=${rawCode}` : ""}${rawProvider ? ` provider=${rawProvider}` : ""})`,
      );
    } else {
      throw new Error(
        `reserveForLending staticCall reverted: ${explained}${rawCode ? ` code=${rawCode}` : ""}${rawProvider ? ` provider=${rawProvider}` : ""}`,
      );
    }
  }
  const populatedReserveTx = await ctx.vbl.connect(ctx.lender).reserveForLending.populateTransaction(
    ctx.lender.address,
    assetAddr,
    amount,
    lendHash,
  );
  const reserveEstimate = await ethers.provider.estimateGas({
    from: ctx.lender.address,
    to: populatedReserveTx.to,
    data: populatedReserveTx.data,
    value: populatedReserveTx.value ?? 0n,
  });
  const reserveGasLimit = withGasBuffer(reserveEstimate);
  const reserveFeeData = await ethers.provider.getFeeData();
  const reserveGasPrice = reserveFeeData.maxFeePerGas ?? reserveFeeData.gasPrice ?? 50_000_000n;
  const reserveNativeTargetWei = reserveGasLimit * reserveGasPrice
    + (populatedReserveTx.value ?? 0n)
    + ethers.parseEther(envStr("LIVE_FUNDS_FLOW_RESERVE_NATIVE_RESERVE_ETH") ?? "0.00005");
  await ensureRecoverableNativeTopUp({
    label: `${ctx.label}-${symbol.toLowerCase()}-reserve-native-gas`,
    target: ctx.lender,
    sponsors: buildNativeTopUpSponsors([ctx.lender.address], ctx.relayer, ctx.borrower, ctx.viewer),
    desiredBalanceWei: reserveNativeTargetWei,
    reserveWei: ethers.parseEther(
      envStr("LIVE_FUNDS_FLOW_RESERVE_SPONSOR_RESERVE_ETH") ?? resolveFreshBorrowerSponsorReserveEth(),
    ),
    failOnShortfall: true,
  });
  const receipt = await (await ctx.vbl.connect(ctx.lender).reserveForLending(ctx.lender.address, assetAddr, amount, lendHash)).wait();
  if (staticCallFailed) {
    console.log(`  [Notice] reserveForLending tx succeeded after staticCall degradation (lendHash=${lendHash})`);
  }
  console.log(`[Reserve] lendHash=${lendHash} amount=${formatUnits(amount, decimals)} ${symbol}`);
  return { lendIntent, lendHash, receipt } satisfies ReserveResult;
}

export async function cancelReserve(ctx: FundsFlowLiveContext, lendHash: string) {
  const receipt = await (await ctx.vbl.connect(ctx.lender).cancelReserve(lendHash)).wait();
  console.log(`[CancelReserve] lendHash=${lendHash}`);
  return receipt;
}

export async function waitForPostWriteOrderReadConvergence(
  ctx: FundsFlowLiveContext,
  orderId: bigint,
  sourceLabel: string,
  minBlockNumber?: number,
) {
  await waitForFreshOrderReadRecovery({
    sourceLabel,
    orderId,
    probe: async () => {
      if (typeof minBlockNumber === "number") {
        const currentBlock = await ethers.provider.getBlockNumber();
        if (currentBlock < minBlockNumber) {
          throw new Error(
            `[SSOT_DEPLOYMENT_MISMATCH][ORDER_READ_NOT_YET_VISIBLE] currentBlock=${currentBlock} targetBlock=${minBlockNumber}`,
          );
        }
      }
      await getOrderForView(ctx, orderId);
      await assertOrderEngineSettlementViewBridge(ctx, orderId);
    },
  });
}

export async function finalizeSingleMatch(ctx: FundsFlowLiveContext, reserve: ReserveResult) {
  return finalizeSingleMatchCustom(ctx, reserve, {
    borrowAsset: {
      assetAddr: ctx.borrowAssetAddr,
      token: ctx.borrowToken,
      decimals: ctx.borrowDecimals,
      symbol: ctx.borrowSymbol,
    },
    collateralAsset: {
      assetAddr: ctx.collateralAssetAddr,
      token: ctx.collateralToken,
      decimals: ctx.collateralDecimals,
      symbol: ctx.collateralSymbol,
    },
    borrowAmount: ctx.borrowAmount,
    collateralAmount: ctx.collateralAmount,
  });
}

export async function finalizeSingleMatchCustom(
  ctx: FundsFlowLiveContext,
  reserve: ReserveResult,
  params: {
    borrowAsset: AssetRuntimeConfig;
    collateralAsset: AssetRuntimeConfig;
    borrowAmount: bigint;
    collateralAmount: bigint;
  },
) {
  const { borrowAsset, collateralAsset, borrowAmount, collateralAmount } = params;
  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  const interest = calcInterest(borrowAmount, ctx.rateBps, BigInt(ctx.termDays) * ONE_DAY);
  if (ctx.ergm && ctx.guaranteeFundAddr !== ethers.ZeroAddress) {
    const guaranteeState = await getGuaranteeState(ctx, ctx.borrower.address, borrowAsset.assetAddr);
    if (guaranteeState.enabled && guaranteeState.active) {
      throw new Error(
        `active guarantee already exists for borrower=${ctx.borrower.address} asset=${borrowAsset.assetAddr} guaranteeId=${guaranteeState.guaranteeId.toString()}; finalizeMatch would revert with GuaranteeAlreadyProcessed() until the existing guarantee is settled or a fresh borrower is used`,
      );
    }
  }
  if (ctx.gfm && ctx.guaranteeFundAddr !== ethers.ZeroAddress && interest > 0n) {
    await ensureTokenAllowance(
      borrowAsset.token,
      ctx.borrower,
      ctx.guaranteeFundAddr,
      interest,
      `${borrowAsset.symbol} -> GuaranteeFundManager`,
    );
  }

  const borrowIntent = {
    borrower: ctx.borrower.address,
    collateralAsset: collateralAsset.assetAddr,
    collateralAmount,
    borrowAsset: borrowAsset.assetAddr,
    amount: borrowAmount,
    termDays: ctx.termDays,
    rateBps: ctx.rateBps,
    expireAt: currentBlock + 1_800n,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`${ctx.label}-borrow-${Date.now()}`)),
  };
  const domain = {
    name: "RwaLending",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: ctx.vblAddr,
  } as const;
  const sigBorrower = await ctx.borrower.signTypedData(domain, BORROW_INTENT_TYPES as any, borrowIntent as any);
  const sigLender = await ctx.lender.signTypedData(domain, LEND_INTENT_TYPES as any, reserve.lendIntent as any);

  try {
    await ctx.vbl.connect(ctx.relayer).finalizeMatch.staticCall(
      borrowIntent as any,
      [reserve.lendIntent] as any,
      sigBorrower,
      [sigLender],
    );
  } catch (error: any) {
    throw new Error(
      `finalizeMatch staticCall reverted: ${explainRevert(error, [ctx.vbl.interface, ctx.vaultCore.interface, ctx.orderEngine.interface, borrowAsset.token.interface, ctx.feeRouter.interface, ctx.gfm?.interface, ctx.ergm?.interface, LIVE_FLOW_ERROR_INTERFACE, ERC20_ERROR_INTERFACE].filter(Boolean as any))}`,
    );
  }

  const populatedFinalizeTx = await ctx.vbl.connect(ctx.relayer).finalizeMatch.populateTransaction(
    borrowIntent as any,
    [reserve.lendIntent] as any,
    sigBorrower,
    [sigLender],
  );
  const finalizeGasLimit = withGasBuffer(
    await ctx.vbl.connect(ctx.relayer).finalizeMatch.estimateGas(
      borrowIntent as any,
      [reserve.lendIntent] as any,
      sigBorrower,
      [sigLender],
    ),
  );

  await ensureRelayerNativeGasReserve(ctx, `${ctx.label}: finalizeMatch relayer gas reserve`);

  let receipt;
  let txResponse;
  try {
    txResponse = await ctx.relayer.sendTransaction({
      to: populatedFinalizeTx.to,
      data: populatedFinalizeTx.data,
      gasLimit: finalizeGasLimit,
      value: populatedFinalizeTx.value ?? 0n,
    });
    receipt = await txResponse.wait();
  } catch (error: any) {
    let traceSummary = "";
    try {
      const traced = await network.provider.send("debug_traceCall", [
        {
          from: ctx.relayer.address,
          to: populatedFinalizeTx.to,
          data: populatedFinalizeTx.data,
          gas: "0x7a1200",
          value: "0x0",
        },
        "latest",
        { tracer: "callTracer" },
      ]);
      const summarized = summarizeTraceError(traced);
      if (summarized) {
        traceSummary = ` trace=${summarized}`;
      }
    } catch (traceError: any) {
      traceSummary = ` trace-unavailable=${fmtErr(traceError)}`;
    }
    const errorHash = error?.transactionHash ?? error?.receipt?.hash ?? error?.receipt?.transactionHash ?? error?.info?.error?.data?.txHash;
    const errorCode = error?.code ?? error?.info?.error?.code;
    const errorShort = error?.shortMessage ?? error?.info?.error?.message ?? fmtErr(error);
    const receiptStatus = error?.receipt?.status;
    const receiptGasUsed = error?.receipt?.gasUsed;
    throw new Error(
      `finalizeMatch tx reverted: ${explainRevert(error, [ctx.vbl.interface, ctx.vaultCore.interface, ctx.orderEngine.interface, borrowAsset.token.interface, ctx.feeRouter.interface, ctx.gfm?.interface, ctx.ergm?.interface, LIVE_FLOW_ERROR_INTERFACE, ERC20_ERROR_INTERFACE].filter(Boolean as any))}${txResponse?.hash ? ` sentTxHash=${txResponse.hash}` : ""}${errorHash ? ` errorTxHash=${errorHash}` : ""}${typeof errorCode !== "undefined" ? ` code=${String(errorCode)}` : ""}${errorShort ? ` provider=${errorShort}` : ""}${typeof receiptStatus !== "undefined" ? ` receiptStatus=${String(receiptStatus)}` : ""}${typeof receiptGasUsed !== "undefined" ? ` gasUsed=${receiptGasUsed.toString()}` : ""}${traceSummary}`,
    );
  }

  const orderId = parseLoanOrderId(receipt, ctx.orderEngine);
  console.log(`[FinalizeMatch] orderId=${orderId.toString()}`);
  await waitForPostWriteOrderReadConvergence(ctx, orderId, "finalizeMatch", receipt?.blockNumber);
  return { orderId, receipt, borrowIntent, lendIntent: reserve.lendIntent } satisfies FinalizeResult;
}

export async function repayOrder(ctx: FundsFlowLiveContext, orderId: bigint, amount = ctx.totalDue) {
  return repayOrderAsset(ctx, {
    orderId,
    asset: {
      assetAddr: ctx.borrowAssetAddr,
      token: ctx.borrowToken,
      decimals: ctx.borrowDecimals,
      symbol: ctx.borrowSymbol,
    },
    amount,
  });
}

export async function repayOrderAsset(
  ctx: FundsFlowLiveContext,
  params: {
    orderId: bigint;
    asset: AssetRuntimeConfig;
    amount: bigint;
  },
) {
  const { orderId, asset, amount } = params;
  await ensureApprovalNativeTopUp({
    token: asset.token,
    owner: ctx.borrower,
    spender: ctx.vaultCoreAddr,
    sponsors: buildNativeTopUpSponsors([ctx.borrower.address], ctx.relayer, ctx.lender, ctx.viewer),
    label: `${ctx.label}-${asset.symbol.toLowerCase()}-repay-allowance`,
    reserveEthEnvKey: "LIVE_FUNDS_FLOW_REPAY_SPONSOR_RESERVE_ETH",
  });
  await ensureTokenAllowance(asset.token, ctx.borrower, ctx.vaultCoreAddr, amount, `${asset.symbol} -> VaultCore.repay`);
  let receipt;
  let txResponse;
  try {
    const populatedRepayTx = await ctx.vaultCore.connect(ctx.borrower).repay.populateTransaction(orderId, asset.assetAddr, amount);
    const repayEstimate = await ethers.provider.estimateGas({
      from: ctx.borrower.address,
      to: populatedRepayTx.to,
      data: populatedRepayTx.data,
      value: populatedRepayTx.value ?? 0n,
    });
    const repayGasLimit = withGasBuffer(repayEstimate);
    const feeData = await ethers.provider.getFeeData();
    const repayGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? resolveBnbMinGasPriceWei();
    const repayNativeTargetWei = repayGasLimit * repayGasPrice + (populatedRepayTx.value ?? 0n) + resolveRepayNativeReserveWei();
    await ensureRecoverableNativeTopUp({
      label: `${ctx.label}-repay-native-gas`,
      target: ctx.borrower,
      sponsors: buildNativeTopUpSponsors([ctx.borrower.address], ctx.relayer, ctx.lender, ctx.viewer),
      desiredBalanceWei: repayNativeTargetWei,
      reserveWei: ethers.parseEther(envStr("LIVE_FUNDS_FLOW_REPAY_SPONSOR_RESERVE_ETH") ?? resolveFreshBorrowerSponsorReserveEth()),
      failOnShortfall: true,
    });
    const feeOverrides = feeData.maxFeePerGas
      ? {
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
        }
      : {
          gasPrice: feeData.gasPrice ?? repayGasPrice,
        };
    txResponse = await ctx.borrower.sendTransaction({
      to: populatedRepayTx.to,
      data: populatedRepayTx.data,
      gasLimit: repayGasLimit,
      ...feeOverrides,
      value: populatedRepayTx.value ?? 0n,
    });
    receipt = await txResponse.wait();
  } catch (error: any) {
    let traceSummary = "";
    try {
      const traced = await network.provider.send("debug_traceCall", [
        {
          from: ctx.borrower.address,
          to: ctx.vaultCoreAddr,
          data: ctx.vaultCore.interface.encodeFunctionData("repay", [orderId, asset.assetAddr, amount]),
          gas: "0x7a1200",
          value: "0x0",
        },
        "latest",
        { tracer: "callTracer" },
      ]);
      const summarized = summarizeTraceError(traced);
      if (summarized) {
        traceSummary = ` trace=${summarized}`;
      }
    } catch (traceError: any) {
      traceSummary = ` trace-unavailable=${fmtErr(traceError)}`;
    }
    const errorHash = error?.transactionHash ?? error?.receipt?.hash ?? error?.receipt?.transactionHash ?? error?.info?.error?.data?.txHash;
    const errorCode = error?.code ?? error?.info?.error?.code;
    const errorShort = error?.shortMessage ?? error?.info?.error?.message ?? fmtErr(error);
    const receiptStatus = error?.receipt?.status;
    const receiptGasUsed = error?.receipt?.gasUsed;
    throw new Error(
      `repay tx reverted: ${explainRevert(error, [ctx.vaultCore.interface, ctx.orderEngine.interface, asset.token.interface, ctx.feeRouter.interface, ctx.gfm?.interface, ctx.ergm?.interface, LIVE_FLOW_ERROR_INTERFACE, ERC20_ERROR_INTERFACE].filter(Boolean as any))}${txResponse?.hash ? ` sentTxHash=${txResponse.hash}` : ""}${errorHash ? ` errorTxHash=${errorHash}` : ""}${typeof errorCode !== "undefined" ? ` code=${String(errorCode)}` : ""}${errorShort ? ` provider=${errorShort}` : ""}${typeof receiptStatus !== "undefined" ? ` receiptStatus=${String(receiptStatus)}` : ""}${typeof receiptGasUsed !== "undefined" ? ` gasUsed=${receiptGasUsed.toString()}` : ""}${traceSummary}`,
    );
  }
  console.log(`[Repay] orderId=${orderId.toString()} amount=${formatUnits(amount, asset.decimals)} ${asset.symbol}`);
  await waitForPostWriteOrderReadConvergence(ctx, orderId, "repay", receipt?.blockNumber);
  return receipt;
}

export async function retryLoanFlowRepayPush(
  ctx: FundsFlowLiveContext,
  params: {
    orderId: bigint;
    amountBaseUnits: bigint;
    repaidAmountAfter: bigint;
    borrowerAddr?: string;
    assetAddr?: string;
  },
) {
  const borrowerAddr = params.borrowerAddr ?? ctx.borrower.address;
  const assetAddr = params.assetAddr ?? ctx.borrowAssetAddr;
  const actionViewPushRole = key("ACTION_VIEW_PUSH");
  const hasActionViewPush = (await ctx.acm.hasRole(actionViewPushRole, ctx.relayer.address)) as boolean;
  if (!hasActionViewPush) {
    throw new Error(`retryLoanFlowRepayPush requires ACTION_VIEW_PUSH role for relayer ${ctx.relayer.address}`);
  }

  const registry = (await ethers.getContractAt(
    ["function getModule(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const loanFlowPushManagerAddr = (await registry.getModule(key("LOAN_FLOW_PUSH_MANAGER"))) as string;
  if (!loanFlowPushManagerAddr || loanFlowPushManagerAddr === ethers.ZeroAddress) {
    throw new Error("LOAN_FLOW_PUSH_MANAGER is not registered in Registry");
  }

  const loanFlowPushManager = (await ethers.getContractAt(
    [
      "function retryRepay(address user,address asset,uint256 amountBaseUnits,uint256 orderId,uint256 repaidAmountAfter)",
    ],
    loanFlowPushManagerAddr,
    ctx.relayer,
  )) as any;

  const receipt = await (
    await loanFlowPushManager.retryRepay(
      borrowerAddr,
      assetAddr,
      params.amountBaseUnits,
      params.orderId,
      params.repaidAmountAfter,
    )
  ).wait();
  console.log(
    `[LoanFlowRetry] orderId=${params.orderId.toString()} amount=${formatUnits(params.amountBaseUnits, ctx.borrowDecimals)} ${ctx.borrowSymbol} repaidAfter=${params.repaidAmountAfter.toString()}`,
  );
  return receipt;
}

export async function retryLoanFlowBorrowPush(
  ctx: FundsFlowLiveContext,
  params: {
    orderId: bigint;
    amountBaseUnits: bigint;
    borrowerAddr?: string;
    assetAddr?: string;
  },
) {
  const borrowerAddr = params.borrowerAddr ?? ctx.borrower.address;
  const assetAddr = params.assetAddr ?? ctx.borrowAssetAddr;
  const actionViewPushRole = key("ACTION_VIEW_PUSH");
  const hasActionViewPush = (await ctx.acm.hasRole(actionViewPushRole, ctx.relayer.address)) as boolean;
  if (!hasActionViewPush) {
    throw new Error(`retryLoanFlowBorrowPush requires ACTION_VIEW_PUSH role for relayer ${ctx.relayer.address}`);
  }

  const registry = (await ethers.getContractAt(
    ["function getModule(bytes32) view returns (address)"],
    ctx.registryAddr,
  )) as any;
  const loanFlowPushManagerAddr = (await registry.getModule(key("LOAN_FLOW_PUSH_MANAGER"))) as string;
  if (!loanFlowPushManagerAddr || loanFlowPushManagerAddr === ethers.ZeroAddress) {
    throw new Error("LOAN_FLOW_PUSH_MANAGER is not registered in Registry");
  }

  const loanFlowPushManager = (await ethers.getContractAt(
    [
      "function retryBorrow(address user,address asset,uint256 amountBaseUnits,uint256 orderId)",
    ],
    loanFlowPushManagerAddr,
    ctx.relayer,
  )) as any;

  const receipt = await (
    await loanFlowPushManager.retryBorrow(
      borrowerAddr,
      assetAddr,
      params.amountBaseUnits,
      params.orderId,
    )
  ).wait();
  console.log(
    `[LoanFlowBorrowRetry] orderId=${params.orderId.toString()} amount=${formatUnits(params.amountBaseUnits, ctx.borrowDecimals)} ${ctx.borrowSymbol}`,
  );
  return receipt;
}

export async function withdrawCollateral(ctx: FundsFlowLiveContext, amount: bigint) {
  const receipt = await (await ctx.vaultCore.connect(ctx.borrower).withdraw(ctx.collateralAssetAddr, amount)).wait();
  console.log(`[Withdraw] amount=${formatUnits(amount, ctx.collateralDecimals)} ${ctx.collateralSymbol}`);
  return receipt;
}

export async function getOrderForView(ctx: FundsFlowLiveContext, orderId: bigint) {
  return (await ctx.orderEngine.getLoanOrderForView(orderId)) as {
    principal: bigint;
    rate: bigint;
    term: bigint;
    borrower: string;
    lender: string;
    asset: string;
    startBlock: bigint;
    maturity: bigint;
    repaidAmount: bigint;
  };
}

export async function getOrderLifecycleStatus(ctx: FundsFlowLiveContext, orderId: bigint) {
  if (!ctx.lendingEngineView) {
    throw new Error("LendingEngineView is required for explicit order status reads");
  }
  return BigInt(await ctx.lendingEngineView.getOrderStatus(orderId));
}

export async function getLoanNftViewStatus(ctx: FundsFlowLiveContext, borrower: string, orderId: bigint) {
  if (!ctx.loanNftView) {
    throw new Error("LoanNFTView is required for user-dimensional status verification");
  }
  const borrowerCaller = new ethers.VoidSigner(borrower, ethers.provider);
  const [loans] = (await ctx.loanNftView
    .connect(borrowerCaller)
    .getUserLoansPaginated(borrower, 0, 50)) as [LoanNftViewLoanEntry[], bigint, boolean, bigint];
  const loan = loans.find((entry) => BigInt(entry.orderId ?? entry[1] ?? 0) === orderId);
  if (!loan) {
    throw new Error(`LoanNFTView missing orderId=${orderId.toString()} for borrower=${borrower}`);
  }
  return BigInt(loan.status ?? loan[2] ?? 0);
}

async function callOrderEngineViewAsSettlement(
  ctx: FundsFlowLiveContext,
  fragment: string,
  functionName: string,
  args: readonly unknown[],
) {
  const iface = new ethers.Interface([fragment]);
  const raw = await ethers.provider.call({
    to: ctx.orderEngineAddr,
    from: ctx.settlementManagerAddr,
    data: iface.encodeFunctionData(functionName, args),
  });
  return iface.decodeFunctionResult(functionName, raw);
}

export async function assertOrderEngineSettlementViewBridge(ctx: FundsFlowLiveContext, orderId: bigint) {
  let loanOrderBridgeReason = "";
  let totalDueBridgeReason = "";

  try {
    await callOrderEngineViewAsSettlement(
      ctx,
      "function getLoanOrderForView(uint256 orderId) view returns ((uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startBlock,uint256 maturity,uint256 repaidAmount))",
      "getLoanOrderForView",
      [orderId],
    );
  } catch (error: any) {
    loanOrderBridgeReason = error?.shortMessage ?? error?.info?.error?.message ?? fmtErr(error);
  }

  try {
    await callOrderEngineViewAsSettlement(
      ctx,
      "function getOrderTotalDueForView(uint256 orderId) view returns (uint256)",
      "getOrderTotalDueForView",
      [orderId],
    );
  } catch (error: any) {
    totalDueBridgeReason = error?.shortMessage ?? error?.info?.error?.message ?? fmtErr(error);
  }

  if (!loanOrderBridgeReason && !totalDueBridgeReason) {
    return;
  }

  if (!loanOrderBridgeReason && totalDueBridgeReason) {
    throw new Error(
      `[SSOT_DEPLOYMENT_MISMATCH][ORDER_ENGINE_VIEW_ADAPTER_DIVERGENCE] SettlementManager->ORDER_ENGINE bridge is inconsistent for orderId=${orderId.toString()}: getLoanOrderForView=ok, getOrderTotalDueForView=fail(${totalDueBridgeReason}).`,
    );
  }

  throw new Error(
    `[SSOT_DEPLOYMENT_MISMATCH][ORDER_ENGINE_SETTLEMENT_BRIDGE_BROKEN] SettlementManager->ORDER_ENGINE view bridge failed for orderId=${orderId.toString()}: getLoanOrderForView=${loanOrderBridgeReason || "ok"}, getOrderTotalDueForView=${totalDueBridgeReason || "ok"}.`,
  );
}

export async function getOrderTotalDueForView(ctx: FundsFlowLiveContext, orderId: bigint) {
  try {
    await assertOrderEngineSettlementViewBridge(ctx, orderId);
    const [totalDue] = await callOrderEngineViewAsSettlement(
      ctx,
      "function getOrderTotalDueForView(uint256 orderId) view returns (uint256)",
      "getOrderTotalDueForView",
      [orderId],
    );
    return BigInt(totalDue ?? 0n);
  } catch (error: any) {
    const reason = error?.shortMessage ?? error?.info?.error?.message ?? fmtErr(error);
    if (String(reason).includes("[SSOT_DEPLOYMENT_MISMATCH]")) {
      throw error;
    }
    throw new Error(
      `[SSOT_DEPLOYMENT_MISMATCH][ORDER_ENGINE_TOTAL_DUE_UNREADABLE] ORDER_ENGINE.getOrderTotalDueForView read failed via SettlementManager caller orderId=${orderId.toString()} reason=${reason}`,
    );
  }
}

export async function getTokenBalances(ctx: FundsFlowLiveContext, token: any, addresses: string[]) {
  const result = new Map<string, bigint>();
  for (const address of addresses) {
    result.set(address, (await token.balanceOf(address)) as bigint);
  }
  return result;
}

export function sumTokenBalances(balances: Map<string, bigint>) {
  let total = 0n;
  for (const value of balances.values()) {
    total += value;
  }
  return total;
}

export async function getGuaranteeState(
  ctx: FundsFlowLiveContext,
  borrowerAddr = ctx.borrower.address,
  assetAddr = ctx.borrowAssetAddr,
) {
  if (!ctx.gfm || !ctx.ergm) {
    return {
      enabled: false,
      locked: 0n,
      guaranteeId: 0n,
      active: false,
    } satisfies GuaranteeState;
  }

  const enabled = (await ctx.ergm.isGuaranteeEnabled(assetAddr)) as boolean;
  const locked = (await ctx.gfm.getLockedGuarantee(borrowerAddr, assetAddr)) as bigint;
  const guaranteeId = (await ctx.ergm.getUserGuaranteeId(borrowerAddr, assetAddr)) as bigint;
  const active = (await ctx.ergm.hasActiveGuarantee(borrowerAddr, assetAddr)) as boolean;

  let record: GuaranteeState["record"];
  if (guaranteeId > 0n) {
    const raw = (await ctx.ergm.getGuaranteeRecord(guaranteeId)) as any;
    record = {
      principal: BigInt(raw.principal ?? raw[0] ?? 0),
      promisedInterest: BigInt(raw.promisedInterest ?? raw[1] ?? 0),
      startTime: BigInt(raw.startTime ?? raw[2] ?? 0),
      maturityTime: BigInt(raw.maturityTime ?? raw[3] ?? 0),
      earlyRepayPenaltyDays: BigInt(raw.earlyRepayPenaltyDays ?? raw[4] ?? 0),
      isActive: Boolean(raw.isActive ?? raw[5] ?? false),
      lender: String(raw.lender ?? raw[6] ?? ethers.ZeroAddress),
      asset: String(raw.asset ?? raw[7] ?? ethers.ZeroAddress),
    };
  }

  return {
    enabled,
    locked,
    guaranteeId,
    active,
    record,
  } satisfies GuaranteeState;
}

export function expectEqual(actual: bigint, expected: bigint, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected.toString()} got ${actual.toString()}`);
  }
}

export function expectGt(actual: bigint, minimum: bigint, label: string) {
  if (actual <= minimum) {
    throw new Error(`${label}: expected > ${minimum.toString()} got ${actual.toString()}`);
  }
}
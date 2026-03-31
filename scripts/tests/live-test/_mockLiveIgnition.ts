import { ethers, network } from "hardhat";
import { configureDynamicEip1559Fees } from "../../utils/eip1559-fees";

import { envBool, envStr, loadAddressMap, resolveAddress } from "../_addressResolver";
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
  getAssetBootstrapPriceUsd8,
  getActorSigner,
  getLivePriceMode,
  getReadCaller,
  key,
  loadMockAssetPack,
  observeLiveState,
  parseLoanOrderId,
  printObservation,
  requireCode,
  withNonceManagedSigner,
} from "./_mockLiveUtils";
import { assignFreshBorrowerWithRecovery } from "./_freshBorrowerManager";

const ONE_DAY = 24n * 60n * 60n;
const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";

const LIVE_FLOW_ERROR_INTERFACE = new ethers.Interface([
  "error GuaranteeAlreadyProcessed()",
  "error GuaranteeNotActive()",
  "error GuaranteeRecordNotFound()",
  "error MissingRole()",
]);

function withGasBuffer(estimate: bigint, multiplierBps = 12_000n) {
  return (estimate * multiplierBps) / 10_000n + 50_000n;
}

async function sendWithBufferedGasRetries(params: {
  signer: any;
  tx: {
    to?: string | null;
    data?: string;
    value?: bigint;
  };
  label: string;
  multiplierBpsList?: bigint[];
}) {
  const multipliers = params.multiplierBpsList ?? [12_000n, 15_000n, 20_000n];
  let lastError: unknown;

  for (let index = 0; index < multipliers.length; index += 1) {
    const multiplierBps = multipliers[index];
    try {
      const estimate = await ethers.provider.estimateGas({
        from: params.signer.address,
        to: params.tx.to,
        data: params.tx.data,
        value: params.tx.value ?? 0n,
      });
      const gasLimit = withGasBuffer(estimate, multiplierBps);
      const response = await params.signer.sendTransaction({
        to: params.tx.to,
        data: params.tx.data,
        gasLimit,
        value: params.tx.value ?? 0n,
      });
      return await response.wait();
    } catch (error: any) {
      lastError = error;
      if (index === multipliers.length - 1) {
        break;
      }
      console.log(
        `[Retry] ${params.label} retrying with larger gas buffer after attempt ${index + 1}/${multipliers.length}: ${fmtErr(error)}`,
      );
    }
  }

  throw lastError;
}

async function ensureSignerNativeTopUp(params: {
  target: any;
  sponsors: any[];
  desiredBalanceWei: bigint;
  reserveWei: bigint;
  label: string;
}) {
  const beforeBalance = await ethers.provider.getBalance(params.target.address);
  if (beforeBalance >= params.desiredBalanceWei) {
    return beforeBalance;
  }

  let remainingTopUp = params.desiredBalanceWei - beforeBalance;
  const seenSponsors = new Set<string>();
  for (const sponsor of params.sponsors) {
    if (!sponsor?.address) {
      continue;
    }
    const signerKey = String(sponsor.address).toLowerCase();
    if (signerKey === params.target.address.toLowerCase() || seenSponsors.has(signerKey)) {
      continue;
    }
    seenSponsors.add(signerKey);
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

type RunOptions = {
  label: string;
  defaultEnableWrite: boolean;
  defaultAllowSingleParty: boolean;
  collateralAmountUnitsDefault: string;
  borrowAmountUnitsDefault: string;
};

type TokenFundingPlan = {
  tokenLabel: string;
  tokenAddress: string;
  decimals: number;
  relayerBalance: bigint;
  targets: Map<string, bigint>;
};

async function estimateDefaultFreshBorrowerNativeAmount() {
  const configured = envStr("LIVE_FRESH_BORROWER_NATIVE_ETH")?.trim();
  if (configured) {
    return ethers.parseEther(configured);
  }
  const txBudget = Math.max(1, Number(envStr("LIVE_FRESH_BORROWER_TX_BUDGET") ?? "8"));
  const gasPerTx = BigInt(Math.max(21_000, Number(envStr("LIVE_FRESH_BORROWER_GAS_PER_TX") ?? "100000")));
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 50_000_000n;
  const estimate = gasPrice * gasPerTx * BigInt(txBudget) * 2n;
  const floor = ethers.parseEther("0.00005");
  return estimate > floor ? estimate : floor;
}

// 同一地址可能需要多笔用途的资金，这里统一累加成目标余额。
function addTarget(map: Map<string, bigint>, address: string, amount: bigint) {
  map.set(address, (map.get(address) ?? 0n) + amount);
}

// 按目标余额为 borrower / lender 补币：
// 先算缺口，再由 relayer 一次性补足，确保后续步骤不会因为余额不足中断。
async function fundTokenTargets(
  erc20: any,
  symbol: string,
  relayer: any,
  plan: TokenFundingPlan,
) {
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

  console.log(
    `Funding plan ${plan.tokenLabel}: relayer=${formatUnits(plan.relayerBalance, plan.decimals)} ${symbol} totalGap=${formatUnits(totalGap, plan.decimals)} ${symbol}`,
  );

  if (totalGap === 0n) {
    return;
  }
  if (plan.relayerBalance < totalGap) {
    throw new Error(
      `${plan.tokenLabel} relayer balance is insufficient. need=${formatUnits(totalGap, plan.decimals)} have=${formatUnits(plan.relayerBalance, plan.decimals)} ${symbol}`,
    );
  }

  for (const gap of gaps) {
    await (await erc20.connect(relayer).transfer(gap.address, gap.gap)).wait();
    console.log(
      `  funded ${gap.address} with ${formatUnits(gap.gap, plan.decimals)} ${symbol} (pre=${formatUnits(gap.current, plan.decimals)})`,
    );
  }
}

// 核心 smoke / warmup 流程：
// 1. 读取当前 mock 资产选择和系统模块。
// 2. 做只读 preflight，并打印基线观测值。
// 3. 如启用写模式，则补价格、补资金、抵押、撮合、借款、还款。
// 4. 在关键阶段持续观测 Reward/View/Health/Position 是否被写热。
export async function runMockLiveIgnition(options: RunOptions) {
  await configureDynamicEip1559Fees({
    ethers,
    networkName: network.name,
    label: options.label,
  });
  const enableWrite = envBool("ENABLE_WRITE", options.defaultEnableWrite);
  const autoGrantUpdatePrice = envBool("AUTO_GRANT_UPDATE_PRICE", false);
  const forcePriceUpdate = envBool("FORCE_PRICE_UPDATE", false);
  const allowDirectOraclePriceWrite = envBool("ALLOW_DIRECT_PRICE_ORACLE", false);
  const allowSingleParty = envBool("ALLOW_SINGLE_PARTY", options.defaultAllowSingleParty);
  const livePriceMode = getLivePriceMode("bootstrap");
  const allowBootstrapPriceOnMissing = livePriceMode === "bootstrap";

  const addressMap = loadAddressMap(network.name, { preferMockSuite: true });
  const registryAddr = resolveAddress({
    name: "Registry",
    map: addressMap,
    envVar: "REGISTRY_ADDRESS",
  });

  const pair = loadMockAssetPack();
  const [rawRelayer] = await ethers.getSigners();
  const relayer = await withNonceManagedSigner(rawRelayer);
  const readCaller = getReadCaller("viewer", "VIEWER_ADDRESS", relayer);
  const viewer = readCaller.signer;
  const borrowerActor = await getActorSigner("borrower", "BORROWER_PRIVATE_KEY", relayer);
  const lenderActor = await getActorSigner("lender", "LENDER_PRIVATE_KEY", relayer);
  let borrower = borrowerActor.signer;
  let borrowerSource = borrowerActor.source;
  const lender = lenderActor.signer;

  // 默认强制 borrower / lender 分离，避免单地址路径掩盖真实撮合问题。
  if (!allowSingleParty && borrower.address.toLowerCase() === lender.address.toLowerCase()) {
    throw new Error("Borrower and lender must be different addresses unless ALLOW_SINGLE_PARTY=1.");
  }

  const registry = (await ethers.getContractAt(
    [
      "function getModuleOrRevert(bytes32) view returns (address)",
      "function getModule(bytes32) view returns (address)",
    ],
    registryAddr,
  )) as any;

  const currentSettlementToken = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const settlementTokenAddr = pair.settlementAsset.address;
  const borrowAssetAddr = pair.borrowAsset.address;
  const collateralAssetAddr = pair.collateralAsset.address;
  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const updaterAddr = (await registry.getModule(key(PRICE_UPDATER_REGISTRY_RAW_KEY))) as string;
  const awAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const cmAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
  const settlementManagerAddr = (await registry.getModule(key("SETTLEMENT_MANAGER"))) as string;
  const valuationViewAddr = (await registry.getModuleOrRevert(key("VALUATION_ORACLE_VIEW"))) as string;
  const viewCacheAddr = (await registry.getModuleOrRevert(key("VIEW_CACHE"))) as string;
  const rewardViewAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
  const healthViewAddr = (await registry.getModuleOrRevert(key("HEALTH_VIEW"))) as string;
  const positionViewAddr = (await registry.getModuleOrRevert(key("POSITION_VIEW"))) as string;
  const gfmAddr = (await registry.getModule(key("GUARANTEE_FUND_MANAGER"))) as string;
  const ergmAddr = (await registry.getModule(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string;

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
  const relayerIsOwner = acmOwner.toLowerCase() === relayer.address.toLowerCase();
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
      "function updatePrice(address asset,uint256 price,uint256 blockNumber)",
    ],
    priceOracleAddr,
  )) as any;
  const updater = updaterAddr && updaterAddr !== ethers.ZeroAddress
    ? ((await ethers.getContractAt(
        ["function updateAssetPrice(address asset,uint256 price,uint256 blockNumber)"],
        updaterAddr,
      )) as any)
    : null;
  const assetWhitelist = (await ethers.getContractAt(
    ["function isAssetAllowed(address asset) view returns (bool)"],
    awAddr,
  )) as any;
  const feeRouter = (await ethers.getContractAt(
    ["function isTokenSupported(address token) view returns (bool)"],
    feeRouterAddr,
  )) as any;
  const vaultCore = (await ethers.getContractAt(
    [
      "function deposit(address asset,uint256 amount)",
      "function repay(uint256 orderId,address asset,uint256 amount)",
    ],
    vaultCoreAddr,
  )) as any;
  const vbl = (await ethers.getContractAt(
    [
      "function reserveForLending(address lenderSigner,address asset,uint256 amount,bytes32 lendIntentHash)",
      "function finalizeMatch((address borrower,address collateralAsset,uint256 collateralAmount,address borrowAsset,uint256 amount,uint16 termDays,uint256 rateBps,uint256 expireAt,bytes32 salt),(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)[] lendIntents,bytes sigBorrower,bytes[] sigLenders)",
    ],
    vblAddr,
  )) as any;
  const orderEngine = (await ethers.getContractAt(
    ["event LoanOrderCreated(uint256 indexed orderId,address indexed borrower,address indexed lender,uint256 principal)"],
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

  const settlementSymbol = String(await settlementToken.symbol().catch(() => pair.settlementAsset.symbol));
  const settlementDecimals = Number(await settlementToken.decimals().catch(() => pair.settlementAsset.decimals));
  const borrowSymbol = String(await borrowToken.symbol().catch(() => pair.borrowAsset.symbol));
  const borrowDecimals = Number(await borrowToken.decimals().catch(() => pair.borrowAsset.decimals));
  const collateralSymbol = String(await collateralToken.symbol().catch(() => pair.collateralAsset.symbol));
  const collateralDecimals = Number(await collateralToken.decimals().catch(() => pair.collateralAsset.decimals));

  const collateralAmount = ethers.parseUnits(
    envStr("COLLATERAL_AMOUNT_UNITS") ?? options.collateralAmountUnitsDefault,
    collateralDecimals,
  );
  const borrowAmount = ethers.parseUnits(
    envStr("BORROW_AMOUNT_UNITS") ?? options.borrowAmountUnitsDefault,
    borrowDecimals,
  );
  const termDays = Number(envStr("TERM_DAYS") ?? "5");
  const rateBps = BigInt(envStr("RATE_BPS") ?? "1000");
  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  const expireAt = currentBlock + 1_800n;
  const interest = calcInterest(borrowAmount, rateBps, BigInt(termDays) * ONE_DAY);
  const totalDue = borrowAmount + interest;

  const settlementConfig = (await priceOracle.getAssetConfig(settlementTokenAddr)) as any;
  const borrowConfig = (await priceOracle.getAssetConfig(borrowAssetAddr)) as any;
  const collateralConfig = (await priceOracle.getAssetConfig(collateralAssetAddr)) as any;
  const settlementWhitelisted = (await assetWhitelist.isAssetAllowed(settlementTokenAddr)) as boolean;
  const borrowWhitelisted = (await assetWhitelist.isAssetAllowed(borrowAssetAddr)) as boolean;
  const collateralWhitelisted = (await assetWhitelist.isAssetAllowed(collateralAssetAddr)) as boolean;
  const settlementFeeSupported = (await feeRouter.isTokenSupported(settlementTokenAddr)) as boolean;
  const borrowFeeSupported = (await feeRouter.isTokenSupported(borrowAssetAddr)) as boolean;
  const collateralFeeSupported = (await feeRouter.isTokenSupported(collateralAssetAddr)) as boolean;

  const updatePriceRole = key("UPDATE_PRICE");
  let relayerHasUpdatePrice = (await acm.hasRole(updatePriceRole, relayer.address)) as boolean;

  console.log(`=== ${options.label} (${network.name}) ===`);
  console.log(`Registry=${registryAddr}`);
  console.log(`MockAssetPack=${pair.packFile}`);
  console.log(`CurrentSettlementToken=${currentSettlementToken}`);
  console.log(`SelectedSettlementToken=${settlementTokenAddr} symbol=${settlementSymbol} decimals=${settlementDecimals}`);
  console.log(`SelectedBorrowAsset=${borrowAssetAddr} symbol=${borrowSymbol} decimals=${borrowDecimals}`);
  console.log(`SelectedCollateralAsset=${collateralAssetAddr} symbol=${collateralSymbol} decimals=${collateralDecimals}`);
  console.log(`SelectionSource=${pair.selectionSource.join(" | ")}`);
  console.log(`Relayer=${relayer.address}`);
  console.log(`Viewer=${viewer.address} source=${readCaller.source}`);
  console.log(`Borrower=${borrower.address} source=${borrowerSource}`);
  console.log(`Lender=${lender.address} source=${lenderActor.source}`);
  console.log(`EnableWrite=${enableWrite}`);
  console.log(`LivePriceMode=${livePriceMode}`);
  console.log(`AllowBootstrapPriceOnMissing=${allowBootstrapPriceOnMissing}`);
  console.log(`AllowDirectPriceOracle=${allowDirectOraclePriceWrite}`);
  console.log(`AllowSingleParty=${allowSingleParty}`);
  console.log(`CollateralAmount=${formatUnits(collateralAmount, collateralDecimals)} ${collateralSymbol}`);
  console.log(`BorrowAmount=${formatUnits(borrowAmount, borrowDecimals)} ${borrowSymbol}`);
  console.log(`EstimatedInterest=${formatUnits(interest, borrowDecimals)} ${borrowSymbol}`);
  console.log(`TotalDue=${formatUnits(totalDue, borrowDecimals)} ${borrowSymbol}`);
  console.log(`SettlementWhitelisted=${settlementWhitelisted}`);
  console.log(`BorrowWhitelisted=${borrowWhitelisted}`);
  console.log(`CollateralWhitelisted=${collateralWhitelisted}`);
  console.log(`SettlementFeeSupported=${settlementFeeSupported}`);
  console.log(`BorrowFeeSupported=${borrowFeeSupported}`);
  console.log(`CollateralFeeSupported=${collateralFeeSupported}`);
  console.log(`SettlementConfigActive=${String(settlementConfig.isActive ?? settlementConfig[2])}`);
  console.log(`BorrowConfigActive=${String(borrowConfig.isActive ?? borrowConfig[2])}`);
  console.log(`CollateralConfigActive=${String(collateralConfig.isActive ?? collateralConfig[2])}`);
  console.log(`RelayerHasViewPriceData=${relayerHasViewPriceData}`);
  console.log(`RelayerHasLiquidate=${relayerHasLiquidate}`);
  console.log(`RelayerHasDeposit=${relayerHasDeposit}`);
  console.log(`RelayerHasUpdatePrice=${relayerHasUpdatePrice}`);
  console.log(`RelayerHasViewSystemData=${relayerHasViewSystemData}`);
  console.log(`RelayerIsAcmOwner=${relayerIsOwner}`);
  console.log(`SettlementManagerHasRepay=${settlementManagerHasRepay}`);
  console.log(`SettlementManagerHasViewSystemData=${settlementManagerHasViewSystemData}`);
  console.log(`AutoGrantRuntimeRoles=${autoGrantRuntimeRoles}`);

  const blockers: string[] = [];
  if (currentSettlementToken.toLowerCase() !== settlementTokenAddr.toLowerCase()) {
    blockers.push(
      `Registry settlement token ${currentSettlementToken} does not match mock pack settlement ${settlementTokenAddr}`,
    );
  }
  if (!borrowWhitelisted) blockers.push("Borrow asset is not allowed by AssetWhitelist");
  if (!settlementWhitelisted) blockers.push("Settlement token is not allowed by AssetWhitelist");
  if (!collateralWhitelisted) blockers.push("Collateral asset is not allowed by AssetWhitelist");
  if (!borrowFeeSupported) blockers.push("FeeRouter does not support the borrow asset");
  if (!settlementFeeSupported) blockers.push("FeeRouter does not support the settlement token");
  if (!(borrowConfig.isActive ?? borrowConfig[2])) blockers.push("Borrow asset price config is not active");
  if (!(settlementConfig.isActive ?? settlementConfig[2])) blockers.push("Settlement token price config is not active");
  if (!(collateralConfig.isActive ?? collateralConfig[2])) blockers.push("Collateral asset price config is not active");

  if (blockers.length > 0) {
    console.log("Preflight blockers:");
    for (const blocker of blockers) {
      console.log(`  - ${blocker}`);
    }
  }

  const autoFreshBorrowerOnActiveGuarantee = envBool("AUTO_FRESH_BORROWER_ON_ACTIVE_GUARANTEE", true);
  if (enableWrite && autoFreshBorrowerOnActiveGuarantee && ergmAddr && ergmAddr !== ethers.ZeroAddress && gfmAddr && gfmAddr !== ethers.ZeroAddress) {
    const ergmRead = (await ethers.getContractAt(
      [
        "function isGuaranteeEnabled(address asset) view returns (bool)",
        "function hasActiveGuarantee(address user,address asset) view returns (bool)",
      ],
      ergmAddr,
    )) as any;
    const guaranteeEnabled = (await ergmRead.isGuaranteeEnabled(borrowAssetAddr)) as boolean;
    const guaranteeActive = (await ergmRead.hasActiveGuarantee(borrower.address, borrowAssetAddr)) as boolean;
    if (guaranteeEnabled && guaranteeActive) {
      const allocation = await assignFreshBorrowerWithRecovery({
        label: `${options.label}-ignition-guarantee-borrower`,
        noticeLabel: "switched to fresh ignition borrower to avoid pre-existing guarantee lock",
        sponsors: [relayer, lender, viewer],
        nativeAmountWei: await estimateDefaultFreshBorrowerNativeAmount(),
        sponsorReserveEth: envStr("LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH") ?? "0.0002",
      });
      borrower = allocation.wallet;
      borrowerSource = "fresh-borrower";
    }
  }

  // 在任何写动作之前，先抓一份全量基线状态，后续每个阶段都拿它做对照。
  const before = await observeLiveState({
    debtAsset: pair.borrowAsset,
    collateralAsset: pair.collateralAsset,
    borrower,
    lender,
    valuationView,
    viewCache,
    rewardView,
    healthView,
    positionView,
  });
  printObservation("before-flow", before);

  if (!enableWrite) {
    console.log("\nDry-run only. Set ENABLE_WRITE=1 after the registry is aligned to the mock asset pack.");
    console.log("The rewritten flow uses RWA collateral + selected borrowAsset reserve/borrow/repay to warm RewardView, ViewCache, and HealthView.");
    return;
  }
  if (blockers.length > 0) {
    throw new Error(blockers.join("; "));
  }

  const pricesToCheck = [
    {
      label: "borrow",
      asset: pair.borrowAsset,
      priceHint: envStr("BORROW_PRICE_UNITS_8") ?? getAssetBootstrapPriceUsd8(pair.borrowAsset),
    },
    {
      label: "collateral",
      asset: pair.collateralAsset,
      priceHint: envStr("COLLATERAL_PRICE_UNITS_8") ?? getAssetBootstrapPriceUsd8(pair.collateralAsset),
    },
  ];

  if (ergmAddr && ergmAddr !== ethers.ZeroAddress && gfmAddr && gfmAddr !== ethers.ZeroAddress) {
    const ergmRead = (await ethers.getContractAt(
      [
        "function isGuaranteeEnabled(address asset) view returns (bool)",
        "function getUserGuaranteeId(address user,address asset) view returns (uint256)",
        "function hasActiveGuarantee(address user,address asset) view returns (bool)",
      ],
      ergmAddr,
    )) as any;
    const gfmRead = (await ethers.getContractAt(
      ["function getLockedGuarantee(address user,address asset) view returns (uint256)"],
      gfmAddr,
    )) as any;
    const guaranteeEnabled = (await ergmRead.isGuaranteeEnabled(borrowAssetAddr)) as boolean;
    const guaranteeId = (await ergmRead.getUserGuaranteeId(borrower.address, borrowAssetAddr)) as bigint;
    const guaranteeActive = (await ergmRead.hasActiveGuarantee(borrower.address, borrowAssetAddr)) as boolean;
    const guaranteeLocked = (await gfmRead.getLockedGuarantee(borrower.address, borrowAssetAddr)) as bigint;
    if (guaranteeEnabled && guaranteeActive) {
      throw new Error(
        `active guarantee already exists for borrower=${borrower.address} asset=${borrowAssetAddr} guaranteeId=${guaranteeId.toString()} locked=${guaranteeLocked.toString()}; finalizeMatch would revert with GuaranteeAlreadyProcessed() until the existing guarantee is settled or a fresh borrower is used`,
      );
    }
  }

  if (!allowDirectOraclePriceWrite && !updater) {
    throw new Error("PriceUpdater is not configured. Set ALLOW_DIRECT_PRICE_ORACLE=1 only for break-glass fallback.");
  }

  if (forcePriceUpdate && !relayerHasUpdatePrice && relayerIsOwner && autoGrantUpdatePrice) {
    await (await acm.connect(relayer).grantRole(updatePriceRole, relayer.address)).wait();
    relayerHasUpdatePrice = true;
    console.log(`Granted UPDATE_PRICE to relayer ${relayer.address}`);
  }

  for (const item of pricesToCheck) {
    let readable = false;
    try {
      const [price, blockNumber] = (await priceOracle.getPrice(item.asset.address)) as [bigint, bigint, bigint];
      readable = price > 0n && blockNumber > 0n;
    } catch {
      readable = false;
    }
    if (!forcePriceUpdate && readable) {
      console.log(`Price for ${item.label} asset ${item.asset.symbol} is already readable; skipped update.`);
      continue;
    }

    if (!readable && !allowBootstrapPriceOnMissing && !forcePriceUpdate) {
      throw new Error(
        `Missing on-chain final price for ${item.asset.symbol}. LIVE_PRICE_MODE=backend-required blocks automatic bootstrap publication.`,
      );
    }

    if (forcePriceUpdate && !allowBootstrapPriceOnMissing) {
      console.log(
        `Force override enabled for ${item.asset.symbol}. LIVE_PRICE_MODE=backend-required is bypassed by FORCE_PRICE_UPDATE=1.`,
      );
    }

    if (!relayerHasUpdatePrice) {
      if (relayerIsOwner && autoGrantUpdatePrice) {
        await (await acm.connect(relayer).grantRole(updatePriceRole, relayer.address)).wait();
        relayerHasUpdatePrice = true;
        console.log(`Granted UPDATE_PRICE to relayer ${relayer.address}`);
      } else {
        throw new Error(`Price update required for ${item.asset.symbol}, but relayer lacks UPDATE_PRICE`);
      }
    }

    const oraclePrice = ethers.parseUnits(item.priceHint, 8);
    const updateBlock = await ethers.provider.getBlockNumber();
    let updated = false;
    if (updater) {
      await (await updater.connect(relayer).updateAssetPrice(item.asset.address, oraclePrice, updateBlock)).wait();
      updated = true;
      console.log(
        `Updated ${item.label} price through PriceUpdater.updateAssetPrice -> ${item.priceHint} USD-8 (mode=${livePriceMode})`,
      );
    }
    if (!updated && allowDirectOraclePriceWrite) {
      try {
        await (await priceOracle.connect(relayer).updatePrice(item.asset.address, oraclePrice, updateBlock)).wait();
        updated = true;
        console.log(
          `Updated ${item.label} price through PriceOracle.updatePrice (break-glass) -> ${item.priceHint} USD-8 (mode=${livePriceMode})`,
        );
      } catch (error: any) {
        console.log(`Break-glass PriceOracle.updatePrice failed for ${item.asset.symbol}: ${fmtErr(error)}`);
      }
    }
    if (!updated) {
      throw new Error(`Unable to update price for ${item.asset.symbol}`);
    }
  }

  // 先把 borrower / lender 的代币缺口补齐，再开始真实借贷动作。
  const borrowFunding: TokenFundingPlan = {
    tokenLabel: "borrow",
    tokenAddress: borrowAssetAddr,
    decimals: borrowDecimals,
    relayerBalance: (await borrowToken.balanceOf(relayer.address)) as bigint,
    targets: new Map<string, bigint>(),
  };
  addTarget(borrowFunding.targets, borrower.address, totalDue);
  addTarget(borrowFunding.targets, lender.address, borrowAmount);

  const collateralFunding: TokenFundingPlan = {
    tokenLabel: "collateral",
    tokenAddress: collateralAssetAddr,
    decimals: collateralDecimals,
    relayerBalance: (await collateralToken.balanceOf(relayer.address)) as bigint,
    targets: new Map<string, bigint>(),
  };
  addTarget(collateralFunding.targets, borrower.address, collateralAmount);

  await fundTokenTargets(borrowToken, borrowSymbol, relayer, borrowFunding);
  await fundTokenTargets(collateralToken, collateralSymbol, relayer, collateralFunding);

  await ensureSignerNativeTopUp({
    target: borrower,
    sponsors: [relayer, lender, viewer, updater],
    desiredBalanceWei: ethers.parseEther(envStr("LIVE_IGNITE_BORROWER_NATIVE_ETH") ?? "0.0003"),
    reserveWei: ethers.parseEther(envStr("LIVE_IGNITE_SPONSOR_RESERVE_ETH") ?? envStr("LIVE_FRESH_BORROWER_RELAYER_RESERVE_ETH") ?? "0.0002"),
    label: "ignite borrower",
  });

  // 先授权并抵押 collateral，验证借款前的资产进入 VaultCore / CollateralManager 路径。
  const cmAllowance = (await collateralToken.allowance(borrower.address, cmAddr)) as bigint;
  if (cmAllowance < collateralAmount) {
    await (await collateralToken.connect(borrower).approve(cmAddr, ethers.MaxUint256)).wait();
    console.log("Approved CollateralManager from borrower.");
  }
  await (await vaultCore.connect(borrower).deposit(collateralAssetAddr, collateralAmount)).wait();
  console.log(
    `Deposited ${formatUnits(collateralAmount, collateralDecimals)} ${collateralSymbol} from borrower as collateral.`,
  );
  printObservation(
    "after-deposit",
    await observeLiveState({
      debtAsset: pair.borrowAsset,
      collateralAsset: pair.collateralAsset,
      borrower,
      lender,
      valuationView,
      viewCache,
      rewardView,
      healthView,
      positionView,
    }),
  );

  // lender 侧预留借款资产流动性，后续 finalizeMatch 会消耗这部分 reserve。
  const vblAllowance = (await borrowToken.allowance(lender.address, vblAddr)) as bigint;
  if (vblAllowance < borrowAmount) {
    await (await borrowToken.connect(lender).approve(vblAddr, ethers.MaxUint256)).wait();
    console.log("Approved VaultBusinessLogic from lender for reserveForLending.");
  }

  const borrowIntent = {
    borrower: borrower.address,
    collateralAsset: collateralAssetAddr,
    collateralAmount,
    borrowAsset: borrowAssetAddr,
    amount: borrowAmount,
    termDays,
    rateBps,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`mock-live-borrow-${Date.now()}`)),
  };
  const lendIntent = {
    lenderSigner: lender.address,
    asset: borrowAssetAddr,
    amount: borrowAmount,
    minTermDays: termDays,
    maxTermDays: Math.max(termDays, 30),
    minRateBps: rateBps,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes(`mock-live-lend-${Date.now()}`)),
  };

  const lendHash = buildLendIntentHash(lendIntent);
  try {
    await vbl.connect(lender).reserveForLending.staticCall(lender.address, borrowAssetAddr, borrowAmount, lendHash);
  } catch (error: any) {
    throw new Error(
      `reserveForLending staticCall reverted: ${explainRevert(error, [vbl.interface, borrowToken.interface, settlementToken.interface, LIVE_FLOW_ERROR_INTERFACE])}`,
    );
  }
  await (await vbl.connect(lender).reserveForLending(lender.address, borrowAssetAddr, borrowAmount, lendHash)).wait();
  console.log(`Reserved ${formatUnits(borrowAmount, borrowDecimals)} ${borrowSymbol} from lender.`);

  if (ergmAddr && ergmAddr !== ethers.ZeroAddress && gfmAddr && gfmAddr !== ethers.ZeroAddress && interest > 0n) {
    try {
      const ergm = (await ethers.getContractAt(
        ["function isGuaranteeEnabled(address asset) view returns (bool)"],
        ergmAddr,
      )) as any;
      const guaranteeEnabled = (await ergm.isGuaranteeEnabled(borrowAssetAddr)) as boolean;
      if (guaranteeEnabled) {
        const allowance = (await borrowToken.allowance(borrower.address, gfmAddr)) as bigint;
        if (allowance < interest) {
          await (await borrowToken.connect(borrower).approve(gfmAddr, ethers.MaxUint256)).wait();
          console.log("Approved GuaranteeFundManager from borrower.");
        }
      }
    } catch (error: any) {
      console.log(`Guarantee pre-approve skipped: ${fmtErr(error)}`);
    }
  }

  const domain = {
    name: "RwaLending",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: vblAddr,
  } as const;
  const sigBorrower = await borrower.signTypedData(domain, BORROW_INTENT_TYPES as any, borrowIntent as any);
  const sigLender = await lender.signTypedData(domain, LEND_INTENT_TYPES as any, lendIntent as any);

  // 先做 staticCall，把最常见的权限/资产/签名错误尽量提前暴露在链下。
  try {
    await vbl
      .connect(relayer)
      .finalizeMatch.staticCall(borrowIntent as any, [lendIntent] as any, sigBorrower, [sigLender]);
  } catch (error: any) {
    throw new Error(
      `finalizeMatch staticCall reverted: ${explainRevert(error, [vbl.interface, vaultCore.interface, settlementToken.interface, LIVE_FLOW_ERROR_INTERFACE])}`,
    );
  }

  let receipt;
  try {
    const tx = await vbl.connect(relayer).finalizeMatch(
      borrowIntent as any,
      [lendIntent] as any,
      sigBorrower,
      [sigLender],
    );
    receipt = await tx.wait();
  } catch (error: any) {
    throw new Error(
      `finalizeMatch tx reverted: ${explainRevert(error, [vbl.interface, vaultCore.interface, settlementToken.interface, LIVE_FLOW_ERROR_INTERFACE])}`,
    );
  }

  // finalizeMatch 成功后从事件里解析 orderId，避免假定新订单编号从 0 开始。
  const orderId = parseLoanOrderId(receipt, orderEngine);
  console.log(`Created orderId=${orderId.toString()} via finalizeMatch.`);
  printObservation(
    "after-borrow",
    await observeLiveState({
      debtAsset: pair.borrowAsset,
      collateralAsset: pair.collateralAsset,
      borrower,
      lender,
      valuationView,
      viewCache,
      rewardView,
      healthView,
      positionView,
    }),
  );

  // repay 走 VaultCore.repay，验证借款闭环以及相关视图缓存是否继续更新。
  const repayAllowance = (await borrowToken.allowance(borrower.address, vaultCoreAddr)) as bigint;
  if (repayAllowance < totalDue) {
    await (await borrowToken.connect(borrower).approve(vaultCoreAddr, ethers.MaxUint256)).wait();
    console.log("Approved VaultCore from borrower for repay.");
  }

  try {
    await vaultCore.connect(borrower).repay.staticCall(orderId, borrowAssetAddr, totalDue);
  } catch (error: any) {
    throw new Error(
      `repay staticCall reverted: ${explainRevert(error, [vaultCore.interface, vbl.interface, LIVE_FLOW_ERROR_INTERFACE])}`,
    );
  }

  try {
    const populatedRepayTx = await vaultCore.connect(borrower).repay.populateTransaction(orderId, borrowAssetAddr, totalDue);
    await sendWithBufferedGasRetries({
      signer: borrower,
      label: `repay order ${orderId.toString()}`,
      tx: {
      to: populatedRepayTx.to,
      data: populatedRepayTx.data,
      value: populatedRepayTx.value ?? 0n,
      },
    });
  } catch (error: any) {
    throw new Error(
      `repay tx reverted: ${explainRevert(error, [vaultCore.interface, vbl.interface, LIVE_FLOW_ERROR_INTERFACE])}`,
    );
  }
  console.log(`Repaid order ${orderId.toString()} with ${formatUnits(totalDue, borrowDecimals)} ${borrowSymbol}.`);
  printObservation(
    "after-repay",
    await observeLiveState({
      debtAsset: pair.borrowAsset,
      collateralAsset: pair.collateralAsset,
      borrower,
      lender,
      valuationView,
      viewCache,
      rewardView,
      healthView,
      positionView,
    }),
  );

  const relayerBorrowFinal = (await borrowToken.balanceOf(relayer.address)) as bigint;
  const borrowerBorrowFinal = (await borrowToken.balanceOf(borrower.address)) as bigint;
  const lenderBorrowFinal = (await borrowToken.balanceOf(lender.address)) as bigint;
  const relayerCollateralFinal = (await collateralToken.balanceOf(relayer.address)) as bigint;
  const borrowerCollateralFinal = (await collateralToken.balanceOf(borrower.address)) as bigint;
  const lenderCollateralFinal = (await collateralToken.balanceOf(lender.address)) as bigint;

  console.log("\n[Final balances]");
  console.log(`  borrow.relayer=${formatUnits(relayerBorrowFinal, borrowDecimals)} ${borrowSymbol}`);
  console.log(`  borrow.borrower=${formatUnits(borrowerBorrowFinal, borrowDecimals)} ${borrowSymbol}`);
  console.log(`  borrow.lender=${formatUnits(lenderBorrowFinal, borrowDecimals)} ${borrowSymbol}`);
  console.log(`  collateral.relayer=${formatUnits(relayerCollateralFinal, collateralDecimals)} ${collateralSymbol}`);
  console.log(`  collateral.borrower=${formatUnits(borrowerCollateralFinal, collateralDecimals)} ${collateralSymbol}`);
  console.log(`  collateral.lender=${formatUnits(lenderCollateralFinal, collateralDecimals)} ${collateralSymbol}`);
}
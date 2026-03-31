import { ethers, network } from "hardhat";

import { loadAddressMap, resolveAddress } from "../_addressResolver";
import {
  describePriceCatalog,
  formatUnits,
  getAssetBootstrapPriceUsd8,
  getLivePriceMode,
  key,
  loadMockAssetPack,
  shortAddr,
} from "./_mockLiveUtils";

const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";

// 对单个资产做只读体检：白名单、费率支持、价格配置、余额分布和最终价格可读性。
async function inspectAsset(params: {
  label: string;
  asset: { address: string; symbol: string; decimals: number; sourceId: string; bootstrapPriceUsd8?: string; defaultPriceUsd8?: string };
  viewer: string;
  borrower: string;
  lender: string;
  relayer: string;
  assetWhitelist: any;
  feeRouter: any;
  priceOracle: any;
}) {
  const erc20 = (await ethers.getContractAt(
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function totalSupply() view returns (uint256)",
      "function balanceOf(address owner) view returns (uint256)",
    ],
    params.asset.address,
  )) as any;

  const symbol = String(await erc20.symbol().catch(() => params.asset.symbol));
  const decimals = Number(await erc20.decimals().catch(() => params.asset.decimals));
  const [totalSupply, viewerBalance, borrowerBalance, lenderBalance, relayerBalance] = (await Promise.all([
    erc20.totalSupply().catch(() => 0n),
    erc20.balanceOf(params.viewer).catch(() => 0n),
    erc20.balanceOf(params.borrower).catch(() => 0n),
    erc20.balanceOf(params.lender).catch(() => 0n),
    erc20.balanceOf(params.relayer).catch(() => 0n),
  ])) as [bigint, bigint, bigint, bigint, bigint];

  const whitelistAllowed = (await params.assetWhitelist.isAssetAllowed(params.asset.address).catch(() => false)) as boolean;
  const feeSupported = (await params.feeRouter.isTokenSupported(params.asset.address).catch(() => false)) as boolean;
  const cfg = (await params.priceOracle.getAssetConfig(params.asset.address).catch(() => null)) as any;

  let oracleReadable = false;
  let oraclePrice = 0n;
  let oracleBlock = 0n;
  let oracleDecimals = 0n;
  try {
    const [price, blockNumber, assetDecimals] = (await params.priceOracle.getPrice(params.asset.address)) as [
      bigint,
      bigint,
      bigint,
    ];
    oracleReadable = price > 0n && blockNumber > 0n;
    oraclePrice = price;
    oracleBlock = blockNumber;
    oracleDecimals = assetDecimals;
  } catch {
    oracleReadable = false;
  }

  console.log(`[${params.label}] ${symbol} ${shortAddr(params.asset.address)}`);
  console.log(`  ${describePriceCatalog(params.asset as any)} bootstrapPriceUsd8=${getAssetBootstrapPriceUsd8(params.asset as any)}`);
  console.log(
    `  whitelist=${whitelistAllowed} feeSupported=${feeSupported} cfgActive=${Boolean(cfg?.isActive ?? cfg?.[2] ?? false)} oracleReadable=${oracleReadable}`,
  );
  console.log(
    `  balances relayer=${formatUnits(relayerBalance, decimals)} viewer=${formatUnits(viewerBalance, decimals)} borrower=${formatUnits(borrowerBalance, decimals)} lender=${formatUnits(lenderBalance, decimals)}`,
  );
  console.log(
    `  totalSupply=${formatUnits(totalSupply, decimals)} oraclePrice=${oraclePrice.toString()} oracleBlock=${oracleBlock.toString()} oracleDecimals=${oracleDecimals.toString()}`,
  );

  return {
    oracleReadable,
    whitelistAllowed,
    feeSupported,
    cfgActive: Boolean(cfg?.isActive ?? cfg?.[2] ?? false),
  };
}

// ZeroAddress 或空地址都视作模块未部署。
function hasCodeAddress(address?: string | null) {
  return Boolean(address && address !== ethers.ZeroAddress);
}

// 这个脚本用于正式 warmup 前的资产预检查，重点回答三件事：
// 1. 当前选中的资产到底是哪几个；
// 2. 价格发布应走哪条链路；
// 3. relayer 是否具备足够权限完成写模式。
async function main() {
  const addressMap = loadAddressMap(network.name, { preferMockSuite: true });
  const registryAddr = resolveAddress({
    name: "Registry",
    map: addressMap,
    envVar: "REGISTRY_ADDRESS",
  });
  const pair = loadMockAssetPack();
  const [relayer] = await ethers.getSigners();
  const viewer = relayer.address;
  const borrower = process.env.BORROWER_ADDRESS?.trim() || relayer.address;
  const lender = process.env.LENDER_ADDRESS?.trim() || relayer.address;

  const registry = (await ethers.getContractAt(
    [
      "function getModuleOrRevert(bytes32) view returns (address)",
    ],
    registryAddr,
  )) as any;
  const currentSettlementToken = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const awAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const updaterAddr = (await registry.getModuleOrRevert(key(PRICE_UPDATER_REGISTRY_RAW_KEY))) as string;
  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;

  const assetWhitelist = (await ethers.getContractAt(
    ["function isAssetAllowed(address asset) view returns (bool)"],
    awAddr,
  )) as any;
  const feeRouter = (await ethers.getContractAt(
    ["function isTokenSupported(address token) view returns (bool)"],
    feeRouterAddr,
  )) as any;
  const priceOracle = (await ethers.getContractAt(
    [
      "function getAssetConfig(address asset) view returns (tuple(string sourceId,uint256 assetDecimals,bool isActive,uint256 maxPriceAgeBlocks))",
      "function getPrice(address asset) view returns (uint256,uint256,uint256)",
    ],
    priceOracleAddr,
  )) as any;
  const acm = (await ethers.getContractAt(
    ["function hasRole(bytes32 role,address account) view returns (bool)"],
    acmAddr,
  )) as any;

  const hasUpdatePrice = (await acm.hasRole(key("UPDATE_PRICE"), relayer.address)) as boolean;
  const allowDirectPriceOracle = (process.env.ALLOW_DIRECT_PRICE_ORACLE?.trim() || "") === "1";
  const autoGrantUpdatePrice = (process.env.AUTO_GRANT_UPDATE_PRICE?.trim() || "") === "1";
  const livePriceMode = getLivePriceMode("bootstrap");
  const allowBootstrapPriceOnMissing = livePriceMode === "bootstrap";
  const updaterCode = hasCodeAddress(updaterAddr)
    ? await ethers.provider.getCode(updaterAddr).catch(() => "0x")
    : "0x";
  const updaterConfigured = updaterCode !== "0x";
  const publishRoute = updaterConfigured
    ? "PriceUpdater.updateAssetPrice"
    : allowDirectPriceOracle
      ? "PriceOracle.updatePrice (break-glass)"
      : "unavailable";

  const collateralAmountUnits = process.env.COLLATERAL_AMOUNT_UNITS?.trim() || "10";
  const borrowAmountUnits = process.env.BORROW_AMOUNT_UNITS?.trim() || "500";

  console.log(`=== Mock Live Asset Precheck (${network.name}) ===`);
  console.log(`Registry=${registryAddr}`);
  console.log(`MockAssetPack=${pair.packFile}`);
  console.log(`Viewer=${viewer}`);
  console.log(`BorrowerAddress=${borrower}`);
  console.log(`LenderAddress=${lender}`);
  console.log(`CurrentSettlementToken=${currentSettlementToken}`);
  console.log(`SelectedSettlementToken=${pair.settlementAsset.address}`);
  console.log(`SelectedBorrowAsset=${pair.borrowAsset.address}`);
  console.log(`SelectedCollateralAsset=${pair.collateralAsset.address}`);
  console.log(`SelectionSource=${pair.selectionSource.join(" | ")}`);
  console.log(`PriceUpdater=${updaterAddr}`);
  console.log(`PriceUpdaterRegistryKey=PRICE_UPDATER (compat raw: ${PRICE_UPDATER_REGISTRY_RAW_KEY})`);
  console.log(`UpdaterConfigured=${updaterConfigured}`);
  console.log(`PublishRoute=${publishRoute}`);
  console.log(`LivePriceMode=${livePriceMode}`);
  console.log(`AllowBootstrapPriceOnMissing=${allowBootstrapPriceOnMissing}`);
  console.log(`AllowDirectPriceOracle=${allowDirectPriceOracle}`);
  console.log(`AutoGrantUpdatePrice=${autoGrantUpdatePrice}`);
  console.log(`ViewerHasUpdatePriceRole=${hasUpdatePrice}`);
  console.log(`SuggestedCollateralAmountUnits=${collateralAmountUnits}`);
  console.log(`SuggestedBorrowAmountUnits=${borrowAmountUnits}`);
  console.log("");

  // 把 settlement / borrow / collateral 三条腿逐个展开，方便快速定位缺口。
  const settlementStatus = await inspectAsset({
    label: "settlement",
    asset: pair.settlementAsset,
    viewer,
    borrower,
    lender,
    relayer: relayer.address,
    assetWhitelist,
    feeRouter,
    priceOracle,
  });
  console.log("");
  const borrowStatus = await inspectAsset({
    label: "borrow",
    asset: pair.borrowAsset,
    viewer,
    borrower,
    lender,
    relayer: relayer.address,
    assetWhitelist,
    feeRouter,
    priceOracle,
  });
  console.log("");
  const collateralStatus = await inspectAsset({
    label: "collateral",
    asset: pair.collateralAsset,
    viewer,
    borrower,
    lender,
    relayer: relayer.address,
    assetWhitelist,
    feeRouter,
    priceOracle,
  });

  const missingFinalPrices = [
    { label: "borrow", symbol: pair.borrowAsset.symbol, status: borrowStatus },
    { label: "collateral", symbol: pair.collateralAsset.symbol, status: collateralStatus },
  ].filter((item) => !item.status.oracleReadable);

  console.log("");
  // 价格发布优先走统一的 updater；仅在明确允许时才提示 break-glass 直写 Oracle。
  if (!updaterConfigured && !allowDirectPriceOracle) {
    console.log("[Blocker] PriceUpdater is not available and ALLOW_DIRECT_PRICE_ORACLE is not enabled.");
    console.log("          The unified live price publish path is currently unavailable.");
  } else if (!updaterConfigured && allowDirectPriceOracle) {
    console.log("[Warning] PriceUpdater is not available. Live warmup would fall back to PriceOracle.updatePrice.");
  } else {
    console.log("[Ready] Unified live price publish path is available through PriceUpdater.updateAssetPrice.");
  }

  if (missingFinalPrices.length === 0) {
    console.log("[Ready] Borrow/collateral assets already have readable on-chain final prices.");
  } else if (allowBootstrapPriceOnMissing) {
    console.log(
      `[Warning] Missing on-chain final price for ${missingFinalPrices.map((item) => item.symbol).join(", ")}. bootstrap mode allows warmup to auto-publish from bootstrap hints.`,
    );
  } else {
    console.log(
      `[Blocker] Missing on-chain final price for ${missingFinalPrices.map((item) => item.symbol).join(", ")}. backend-required mode will fail warmup until backend publish succeeds.`,
    );
  }

  if (!hasUpdatePrice) {
    // 这里只报告风险，不直接失败，因为有些环境会在写模式前临时补权。
    console.log("[Warning] Current relayer does not have UPDATE_PRICE.");
    if (autoGrantUpdatePrice) {
      console.log("          AUTO_GRANT_UPDATE_PRICE=1 is set, so write-mode scripts will attempt self-grant if relayer is ACM owner.");
    } else {
      console.log("          Write-mode warmup will fail unless UPDATE_PRICE is granted or AUTO_GRANT_UPDATE_PRICE=1 is used by ACM owner.");
    }
  }

  console.log("");
  if (currentSettlementToken.toLowerCase() !== pair.settlementAsset.address.toLowerCase()) {
    console.log("[Warning] Registry settlement token does not match the mock asset pack settlement token.");
    console.log("          Re-run the live deploy using the mock asset pack before attempting write-mode warmup.");
  } else {
    console.log("[Ready] Registry settlement token matches the mock asset pack settlement token.");
  }

  if (!settlementStatus.oracleReadable) {
    console.log("[Warning] Settlement asset has no readable price. This does not block reserve/match directly, but it indicates the pack is not fully normalized.");
  }

  console.log(
    `[Recommendation] collateral=${pair.collateralAsset.symbol} borrow=${pair.borrowAsset.symbol}. This matches the actual funds flow: borrower deposits collateral through VaultCore, lender reserves borrowAsset liquidity through VaultBusinessLogic, then finalizeMatch creates the order and repay goes through VaultCore.repay(orderId, borrowAsset, ...).`,
  );
}

main().catch((error) => {
  console.error("\n❌ live-asset-precheck-arbitrum-sepolia FAILED\n");
  console.error(error);
  process.exit(1);
});
import { ethers, network } from "hardhat";

import { envBool, loadAddressMap, resolveAddress } from "../_addressResolver";
import { fmtErr, getReadCaller, key, loadMockAssetPack, requireCode } from "./_mockLiveUtils";

// 大于 0 的 block 代表历史上至少写过一次缓存，可用于区分“冷缓存”和“旧缓存”。
function hasCacheBlock(value: bigint): boolean {
  return value > 0n;
}

// 全量 preflight：检查 live 读路径是否达到 smoke / gate 所需的最低健康度。
async function main() {
  const strictOracle = envBool("LIVE_PREFLIGHT_STRICT_ORACLE", false);
  const strictRewardCache = envBool("LIVE_PREFLIGHT_STRICT_REWARD_CACHE", false);
  const strictViewCache = envBool("LIVE_PREFLIGHT_STRICT_VIEW_CACHE", false);

  const addressMap = loadAddressMap(network.name, { preferMockSuite: true });
  const registryAddr = resolveAddress({
    name: "Registry",
    map: addressMap,
    envVar: "REGISTRY_ADDRESS",
  });
  const pair = loadMockAssetPack();
  const [defaultSigner] = await ethers.getSigners();
  const viewerActor = getReadCaller("viewer", "VIEWER_ADDRESS", defaultSigner);
  const viewer = viewerActor.signer;

  const registry = (await ethers.getContractAt(
    [
      "function getModuleOrRevert(bytes32) view returns (address)",
      "function getModule(bytes32) view returns (address)",
    ],
    registryAddr,
  )) as any;

  const currentSettlementToken = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const rewardViewAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
  const viewCacheAddr = (await registry.getModuleOrRevert(key("VIEW_CACHE"))) as string;
  const valuationOracleViewAddr = (await registry.getModuleOrRevert(key("VALUATION_ORACLE_VIEW"))) as string;
  const healthViewAddr = (await registry.getModule(key("HEALTH_VIEW"))) as string;
  const positionViewAddr = (await registry.getModule(key("POSITION_VIEW"))) as string;
  const awAddr = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const feeRouterAddr = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;

  await Promise.all([
    requireCode(registryAddr, "Registry"),
    requireCode(currentSettlementToken, "SettlementToken"),
    requireCode(priceOracleAddr, "PriceOracle"),
    requireCode(rewardViewAddr, "RewardView"),
    requireCode(viewCacheAddr, "ViewCache"),
    requireCode(valuationOracleViewAddr, "ValuationOracleView"),
  ]);
  if (healthViewAddr && healthViewAddr !== ethers.ZeroAddress) {
    await requireCode(healthViewAddr, "HealthView");
  }
  if (positionViewAddr && positionViewAddr !== ethers.ZeroAddress) {
    await requireCode(positionViewAddr, "PositionView");
  }

  const priceOracle = (await ethers.getContractAt(
    ["function getPrice(address asset) view returns (uint256,uint256,uint256)"],
    priceOracleAddr,
  )) as any;
  const rewardView = (await ethers.getContractAt(
    [
      "function getUserRewardSummaryWithMeta(address user) view returns (uint256,uint256,uint8,uint256,uint256,bool)",
      "function getUserEasyEarnedWithMeta(address user) view returns (uint256,uint256,bool)",
      "function getDynamicRewardParamsWithMeta() view returns (uint256,uint256,uint256,bool)",
      "function getLevelMultiplierWithMeta(uint8 level) view returns (uint256,uint256,bool)",
    ],
    rewardViewAddr,
  )) as any;
  const valuationView = (await ethers.getContractAt(
    ["function getAssetPrice(address asset) view returns (uint256,uint256,bool)"],
    valuationOracleViewAddr,
  )) as any;
  const viewCache = (await ethers.getContractAt(
    ["function getSystemStatus(address asset) view returns ((uint256,uint256,uint256,uint256),bool)"],
    viewCacheAddr,
  )) as any;
  const assetWhitelist = (await ethers.getContractAt(
    ["function isAssetAllowed(address asset) view returns (bool)"],
    awAddr,
  )) as any;
  const feeRouter = (await ethers.getContractAt(
    ["function isTokenSupported(address token) view returns (bool)"],
    feeRouterAddr,
  )) as any;

  // 所有非致命问题统一记入 warning，最后集中展示；是否升级为失败由 strict 开关决定。
  const warnings: string[] = [];

  console.log(`=== Mock Live Preflight (${network.name}) ===`);
  console.log(`Registry=${registryAddr}`);
  console.log(`MockAssetPack=${pair.packFile}`);
  console.log(`Viewer=${viewer.address}`);
  console.log(`ViewerSource=${viewerActor.source}`);
  console.log(`CurrentSettlementToken=${currentSettlementToken}`);
  console.log(`SelectedSettlementToken=${pair.settlementAsset.address}`);
  console.log(`SelectedBorrowAsset=${pair.borrowAsset.address}`);
  console.log(`SelectedCollateralAsset=${pair.collateralAsset.address}`);
  console.log(`SelectionSource=${pair.selectionSource.join(" | ")}`);

  if (currentSettlementToken.toLowerCase() !== pair.settlementAsset.address.toLowerCase()) {
    warnings.push("Registry settlement token is still not aligned with the mock asset pack settlement token");
  }

  const settlementWhitelisted = (await assetWhitelist.isAssetAllowed(pair.settlementAsset.address)) as boolean;
  const borrowWhitelisted = (await assetWhitelist.isAssetAllowed(pair.borrowAsset.address)) as boolean;
  const collateralWhitelisted = (await assetWhitelist.isAssetAllowed(pair.collateralAsset.address)) as boolean;
  const settlementFeeSupported = (await feeRouter.isTokenSupported(pair.settlementAsset.address)) as boolean;
  const borrowFeeSupported = (await feeRouter.isTokenSupported(pair.borrowAsset.address)) as boolean;
  console.log(`AssetWhitelist.settlement=${settlementWhitelisted}`);
  console.log(`AssetWhitelist.borrow=${borrowWhitelisted}`);
  console.log(`AssetWhitelist.collateral=${collateralWhitelisted}`);
  console.log(`FeeRouter.settlement=${settlementFeeSupported}`);
  console.log(`FeeRouter.borrow=${borrowFeeSupported}`);
  if (!settlementWhitelisted) warnings.push("Settlement token is not allowed by AssetWhitelist");
  if (!borrowWhitelisted) warnings.push("Borrow asset is not allowed by AssetWhitelist");
  if (!collateralWhitelisted) warnings.push("Collateral asset is not allowed by AssetWhitelist");
  if (!settlementFeeSupported) warnings.push("FeeRouter does not support the settlement token");
  if (!borrowFeeSupported) warnings.push("FeeRouter does not support the borrow asset");

  // 价格检查分两层：原始 PriceOracle 和聚合后的 ValuationOracleView。
  let settlementOracleReadable = false;
  let collateralOracleReadable = false;
  try {
    const [price, blockNumber, decimals] = (await priceOracle.getPrice(pair.borrowAsset.address)) as [bigint, bigint, bigint];
    settlementOracleReadable = price > 0n && blockNumber > 0n;
    console.log(`PriceOracle.borrow price=${price.toString()} block=${blockNumber.toString()} decimals=${decimals.toString()}`);
  } catch (error: any) {
    warnings.push(`PriceOracle borrow read reverted: ${fmtErr(error)}`);
  }
  try {
    const [price, blockNumber, decimals] = (await priceOracle.getPrice(pair.collateralAsset.address)) as [bigint, bigint, bigint];
    collateralOracleReadable = price > 0n && blockNumber > 0n;
    console.log(`PriceOracle.collateral price=${price.toString()} block=${blockNumber.toString()} decimals=${decimals.toString()}`);
  } catch (error: any) {
    warnings.push(`PriceOracle collateral read reverted: ${fmtErr(error)}`);
  }

  const [settlementViewPrice, settlementViewBlock, settlementViewValid] =
    (await valuationView.getAssetPrice(pair.borrowAsset.address)) as [bigint, bigint, boolean];
  const [collateralViewPrice, collateralViewBlock, collateralViewValid] =
    (await valuationView.getAssetPrice(pair.collateralAsset.address)) as [bigint, bigint, boolean];
  console.log(
    `ValuationOracleView.borrow price=${settlementViewPrice.toString()} block=${settlementViewBlock.toString()} valid=${settlementViewValid}`,
  );
  console.log(
    `ValuationOracleView.collateral price=${collateralViewPrice.toString()} block=${collateralViewBlock.toString()} valid=${collateralViewValid}`,
  );

  if (!settlementOracleReadable && !settlementViewValid) {
    warnings.push("Neither PriceOracle nor ValuationOracleView produced a readable borrow-asset price");
  }
  if (!collateralOracleReadable && !collateralViewValid) {
    warnings.push("Neither PriceOracle nor ValuationOracleView produced a readable collateral price");
  }
  if (strictOracle && warnings.some((warning) => warning.toLowerCase().includes("price"))) {
    throw new Error("[Preflight] oracle price checks failed and LIVE_PREFLIGHT_STRICT_ORACLE=1");
  }

  const rewardSummary =
    (await rewardView.getUserRewardSummaryWithMeta(viewer.address)) as [bigint, bigint, number, bigint, bigint, boolean];
  const easyEarned = (await rewardView.getUserEasyEarnedWithMeta(viewer.address)) as [bigint, bigint, boolean];
  const dynamicParams = (await rewardView.getDynamicRewardParamsWithMeta()) as [bigint, bigint, bigint, boolean];
  const level1 = (await rewardView.getLevelMultiplierWithMeta(1)) as [bigint, bigint, boolean];
  console.log(
    `RewardSummaryCache block=${rewardSummary[4].toString()} valid=${rewardSummary[5]} pendingPenalty=${rewardSummary[1].toString()}`,
  );
  console.log(
    `RewardEasyEarnedCache block=${easyEarned[1].toString()} valid=${easyEarned[2]} easyEarned=${easyEarned[0].toString()}`,
  );
  console.log(
    `RewardDynamicParamsCache block=${dynamicParams[2].toString()} valid=${dynamicParams[3]} threshold=${dynamicParams[0].toString()} multiplier=${dynamicParams[1].toString()}`,
  );
  console.log(`RewardLevel1Cache block=${level1[1].toString()} valid=${level1[2]} multiplier=${level1[0].toString()}`);
  const viewerRewardCachesWarm = rewardSummary[5] && easyEarned[2];
  const globalRewardCachesWarm = dynamicParams[3] && level1[2];
  if (!viewerRewardCachesWarm) {
    // viewer 维度缓存是否被真实写路径写热，是判断 warmup 是否有效的核心信号之一。
    const viewerRewardCachePresent = hasCacheBlock(rewardSummary[4]) || hasCacheBlock(easyEarned[1]);
    if (viewerRewardCachePresent) {
      console.log("Info: RewardView viewer caches are stale for the current viewer, but readable historical data exists");
    } else {
      warnings.push("RewardView viewer caches are not initialized for the current viewer");
    }
    if (strictRewardCache) {
      throw new Error("[Preflight] RewardView caches are cold and LIVE_PREFLIGHT_STRICT_REWARD_CACHE=1");
    }
  }
  if (!globalRewardCachesWarm) {
    console.log("Info: RewardView global caches are still cold; viewer-scoped reward reads are already warm");
  }

  const [settlementStatus, settlementStatusValid] = (await viewCache.getSystemStatus(
    pair.borrowAsset.address,
  )) as [any, boolean];
  const [collateralStatus, collateralStatusValid] = (await viewCache.getSystemStatus(
    pair.collateralAsset.address,
  )) as [any, boolean];
  console.log(
    `ViewCache.borrow valid=${settlementStatusValid} updateBlock=${String(settlementStatus.updateBlock ?? settlementStatus[3] ?? 0)} totalCollateral=${String(settlementStatus.totalCollateral ?? settlementStatus[0] ?? 0)} totalDebt=${String(settlementStatus.totalDebt ?? settlementStatus[1] ?? 0)}`,
  );
  console.log(
    `ViewCache.collateral valid=${collateralStatusValid} updateBlock=${String(collateralStatus.updateBlock ?? collateralStatus[3] ?? 0)} totalCollateral=${String(collateralStatus.totalCollateral ?? collateralStatus[0] ?? 0)} totalDebt=${String(collateralStatus.totalDebt ?? collateralStatus[1] ?? 0)}`,
  // ViewCache 是系统维度缓存，最常见的问题是某一条资产腿仍然冷着。
  );
  if (!settlementStatusValid || !collateralStatusValid) {
    warnings.push("ViewCache system status is still cold for at least one mock-asset leg");
    if (strictViewCache) {
      throw new Error("[Preflight] ViewCache system status is cold and LIVE_PREFLIGHT_STRICT_VIEW_CACHE=1");
    }
  }

  if (healthViewAddr && healthViewAddr !== ethers.ZeroAddress) {
    try {
      const healthView = (await ethers.getContractAt(
        ["function getUserHealthFactorWithMeta(address user) view returns (uint256,bool,uint256)"],
        healthViewAddr,
      )) as any;
      const [hf, valid, blockNumber] = (await healthView.getUserHealthFactorWithMeta(viewer.address)) as [
        bigint,
        boolean,
        bigint,
      ];
      console.log(`HealthView.self hf=${hf.toString()} valid=${valid} block=${blockNumber.toString()}`);
      if (!valid) {
        if (hasCacheBlock(blockNumber)) {
          console.log("Info: HealthView self cache is stale for the current viewer, but historical data exists");
        } else {
          warnings.push("HealthView self cache is cold/invalid for the current viewer");
        }
      }
    } catch (error: any) {
      warnings.push(`HealthView self read failed: ${fmtErr(error)}`);
    }
  }

  if (positionViewAddr && positionViewAddr !== ethers.ZeroAddress) {
    try {
      const positionView = (await ethers.getContractAt(
        ["function getUserPositionWithBlockMeta(address user,address asset) view returns (uint256,uint256,bool,uint256,uint256,uint64)"],
        positionViewAddr,
      )) as any;
      const [collateralAmount, debtAmount, valid, updateBlock] =
        (await positionView.getUserPositionWithBlockMeta(viewer.address, pair.collateralAsset.address)) as [
          bigint,
          bigint,
          boolean,
          bigint,
          bigint,
          bigint,
        ];
      console.log(
        `PositionView.self collateralAsset collateral=${collateralAmount.toString()} debt=${debtAmount.toString()} valid=${valid} updateBlock=${updateBlock.toString()}`,
      );
      if (!valid) {
        if (hasCacheBlock(updateBlock)) {
          console.log("Info: PositionView collateral cache is stale for the current viewer, but historical data exists");
        } else {
          warnings.push("PositionView collateral cache is cold/invalid for the current viewer");
        }
      }

      const [borrowCollateralAmount, borrowDebtAmount, borrowValid, borrowUpdateBlock] =
        (await positionView.getUserPositionWithBlockMeta(viewer.address, pair.borrowAsset.address)) as [
          bigint,
          bigint,
          boolean,
          bigint,
          bigint,
          bigint,
        ];
      console.log(
        `PositionView.self borrowAsset collateral=${borrowCollateralAmount.toString()} debt=${borrowDebtAmount.toString()} valid=${borrowValid} updateBlock=${borrowUpdateBlock.toString()}`,
      );
      if (!borrowValid) {
        if (hasCacheBlock(borrowUpdateBlock)) {
          console.log("Info: PositionView borrow-asset cache is stale for the current viewer, but historical data exists");
        } else {
          warnings.push("PositionView borrow-asset cache is cold/invalid for the current viewer");
        }
      }
    } catch (error: any) {
      warnings.push(`PositionView self read failed: ${fmtErr(error)}`);
    }
  }

  if (warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`  - ${warning}`);
    }
  }

  console.log("\n✅ live-preflight-arbitrum-sepolia PASSED\n");
}

main().catch((error) => {
  console.error("\n❌ live-preflight-arbitrum-sepolia FAILED\n");
  console.error(error);
  process.exit(1);
});
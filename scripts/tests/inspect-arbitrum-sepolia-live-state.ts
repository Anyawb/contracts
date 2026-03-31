import { ethers, network } from "hardhat";
import { envBool, loadAddressMap, resolveAddress } from "./_addressResolver";

function key(name: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";

function displayModuleKey(moduleKey: string) {
  if (moduleKey === PRICE_UPDATER_REGISTRY_RAW_KEY) {
    return "PRICE_UPDATER (compat raw: COINGECKO_PRICE_UPDATER)";
  }
  return moduleKey;
}

function fmtErr(error: any) {
  return error?.shortMessage ?? error?.message ?? String(error);
}

async function codeState(address: string) {
  const code = await ethers.provider.getCode(address);
  return code && code !== "0x" ? "present" : "missing";
}

async function ensureRole(
  acm: any,
  roleName: string,
  account: string,
  label: string,
  enableWrite: boolean,
) {
  const role = key(roleName);
  const has = (await acm.hasRole(role, account)) as boolean;
  if (has) {
    console.log(`- ${roleName} -> ${label}: already granted`);
    return "already-granted" as const;
  }
  if (!enableWrite) {
    console.log(`- ${roleName} -> ${label}: MISSING (dry-run)`);
    return "missing" as const;
  }

  await (await acm.grantRole(role, account)).wait();
  console.log(`- ${roleName} -> ${label}: granted`);
  return "granted" as const;
}

async function main() {
  const enableRepair = envBool("ENABLE_WRITE", false) || envBool("REPAIR_MISSING_ROLES", false);
  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({
    name: "Registry",
    map: addressMap,
    envVar: "REGISTRY_ADDRESS",
  });

  const [viewer] = await ethers.getSigners();
  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
  const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const settlementTokenAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;

  const moduleKeys = [
    "PRICE_ORACLE",
    PRICE_UPDATER_REGISTRY_RAW_KEY,
    "VALUATION_ORACLE_VIEW",
    "REWARD_VIEW",
    "REWARD_MANAGER",
    "REWARD_MANAGER_CORE",
    "REWARD_ACCRUAL_MANAGER",
    "REWARD_EARN_CONFIG",
    "EASY_TOKEN",
    "EASY_EMISSION_CONFIG",
    "EASY_EMISSION_CONTROLLER",
    "EASY_CONSUMPTION",
    "EASY_RECYCLE_DISTRIBUTOR",
    "EASY_STAKING",
    "VIEW_CACHE",
    "HEALTH_VIEW",
    "VAULT_CORE",
    "VAULT_ROUTER",
    "LENDING_ENGINE",
    "ORDER_ENGINE",
    "SETTLEMENT_MANAGER",
    "LIQUIDATION_MANAGER",
    "LIQUIDATION_RISK_MANAGER",
    "MODULE_HEALTH_VIEW",
  ] as const;

  const modules = new Map<string, string>();
  for (const moduleKey of moduleKeys) {
    try {
      const addr = (await registry.getModule(key(moduleKey))) as string;
      modules.set(moduleKey, addr);
    } catch {
      modules.set(moduleKey, ethers.ZeroAddress);
    }
  }

  const vaultCoreAddr = modules.get("VAULT_CORE")!;
  let vaultRouterAddr = modules.get("VAULT_ROUTER")!;
  if ((!vaultRouterAddr || vaultRouterAddr === ethers.ZeroAddress) && vaultCoreAddr && vaultCoreAddr !== ethers.ZeroAddress) {
    try {
      const vaultCore = (await ethers.getContractAt(
        ["function viewContractAddrVar() view returns (address)"],
        vaultCoreAddr,
      )) as any;
      vaultRouterAddr = (await vaultCore.viewContractAddrVar()) as string;
      modules.set("VAULT_ROUTER", vaultRouterAddr);
    } catch (error: any) {
      console.log(`\n[warn] failed to resolve VaultRouter via VaultCore: ${fmtErr(error)}`);
    }
  }

  const acm = (await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function hasRole(bytes32 role,address account) view returns (bool)",
      "function grantRole(bytes32 role,address account)",
    ],
    acmAddr,
  )) as any;
  const acmOwner = (await acm.owner()) as string;
  const signerIsAcmOwner = acmOwner.toLowerCase() === viewer.address.toLowerCase();
  const priceOracleAddr = modules.get("PRICE_ORACLE")!;
  const priceOracle = (await ethers.getContractAt(
    [
      "function getAssetConfig(address asset) view returns (tuple(string sourceId,uint8 assetDecimals,uint256 maxPriceAgeBlocks,bool isActive))",
      "function getPrice(address asset) view returns (uint256,uint256,uint256)",
      "function getPriceData(address asset) view returns (tuple(uint256 price,uint256 blockNumber,uint256 assetDecimals,bool isValid))",
      "function getPriceUpdateBlock(address asset) view returns (uint256)",
      "function getSupportedAssets() view returns (address[])",
    ],
    priceOracleAddr,
  )) as any;

  const rewardViewAddr = modules.get("REWARD_VIEW")!;
  const rewardView = (await ethers.getContractAt(
    [
      "function getUserRewardSummaryWithMeta(address user) view returns (uint256,uint256,uint8,uint256,uint256,bool)",
      "function getUserEasyEarnedWithMeta(address user) view returns (uint256,uint256,bool)",
      "function getDynamicRewardParamsWithMeta() view returns (uint256,uint256,uint256,bool)",
      "function getLevelMultiplierWithMeta(uint8 level) view returns (uint256,uint256,bool)",
      "function getVersionInfo() view returns (uint256,uint256,address)",
    ],
    rewardViewAddr,
  )) as any;

  const earnConfigAddr = modules.get("REWARD_EARN_CONFIG")!;
  const earnConfig = (await ethers.getContractAt(
    [
      "function getDynamicRewardParams() view returns (uint256,uint256,uint256)",
      "function getLevelMultiplierBps(uint8 level) view returns (uint256)",
      "function getLevelConfigUpdateBlock() view returns (uint256)",
    ],
    earnConfigAddr,
  )) as any;

  const easyTokenAddr = modules.get("EASY_TOKEN")!;
  const easyToken = (await ethers.getContractAt(
    [
      "function MINTER_ROLE() view returns (bytes32)",
      "function BURNER_ROLE() view returns (bytes32)",
      "function hasRole(bytes32 role,address account) view returns (bool)",
      "function totalSupply() view returns (uint256)",
      "function balanceOf(address owner) view returns (uint256)",
      "function decimals() view returns (uint8)",
    ],
    easyTokenAddr,
  )) as any;

  const viewCacheAddr = modules.get("VIEW_CACHE")!;
  const viewCache = (await ethers.getContractAt(
    [
      "function getSystemStatus(address asset) view returns (tuple(uint256 totalCollateral,uint256 totalDebt,uint256 utilizationRate,uint256 updateBlock,bool isValid),bool)",
      "function getSystemStatusWithBlockMeta(address asset) view returns (tuple(uint256 totalCollateral,uint256 totalDebt,uint256 utilizationRate,uint256 updateBlock,bool isValid),bool,uint256,uint256)",
    ],
    viewCacheAddr,
  )) as any;

  const healthViewAddr = modules.get("HEALTH_VIEW")!;
  const healthView = (await ethers.getContractAt(
    [
      "function getUserHealthFactorWithMeta(address user) view returns (uint256,bool,uint256)",
      "function getVersionInfo() view returns (uint256,uint256,address)",
    ],
    healthViewAddr,
  )) as any;

  console.log(`=== Inspect Live State (${network.name}) ===`);
  console.log(`Registry=${registryAddr}`);
  console.log(`Viewer=${viewer.address}`);
  console.log(`RepairMode=${enableRepair}`);
  console.log(`AccessControlManager=${acmAddr}`);
  console.log(`AcmOwner=${acmOwner}`);
  console.log(`SignerIsAcmOwner=${signerIsAcmOwner}`);
  console.log(`ResolvedVaultRouter=${vaultRouterAddr}`);
  console.log(`SettlementToken=${settlementTokenAddr}`);

  console.log("\n[Modules]");
  for (const [moduleKey, addr] of modules.entries()) {
    console.log(`- ${displayModuleKey(moduleKey)}=${addr} code=${await codeState(addr)}`);
  }

  console.log("\n[Repair plan]");
  const repairTargets: Array<{ roleName: string; account: string; label: string }> = [];
  if (vaultRouterAddr && vaultRouterAddr !== ethers.ZeroAddress) {
    repairTargets.push({
      roleName: "SET_PARAMETER",
      account: vaultRouterAddr,
      label: "VaultRouter",
    });
    repairTargets.push({
      roleName: "ACTION_VIEW_PUSH",
      account: vaultRouterAddr,
      label: "VaultRouter",
    });
  }
  if (
    modules.get("LIQUIDATION_RISK_MANAGER") &&
    modules.get("LIQUIDATION_RISK_MANAGER") !== ethers.ZeroAddress
  ) {
    repairTargets.push({
      roleName: "VIEW_USER_DATA",
      account: modules.get("LIQUIDATION_RISK_MANAGER")!,
      label: "LiquidationRiskManager",
    });
  }

  if (enableRepair && !signerIsAcmOwner) {
    throw new Error(
      `Repair mode requested but signer ${viewer.address} is not ACM owner ${acmOwner}`,
    );
  }

  for (const target of repairTargets) {
    await ensureRole(
      acm,
      target.roleName,
      target.account,
      target.label,
      enableRepair,
    );
  }

  console.log("\n[PriceOracle]");
  const assetConfig = (await priceOracle.getAssetConfig(settlementTokenAddr)) as any;
  console.log(
    `- assetConfig: sourceId=${assetConfig.sourceId ?? assetConfig[0]} decimals=${String(assetConfig.assetDecimals ?? assetConfig[1])} maxPriceAgeBlocks=${String(assetConfig.maxPriceAgeBlocks ?? assetConfig[2])} isActive=${String(assetConfig.isActive ?? assetConfig[3])}`,
  );
  const supportedAssets = (await priceOracle.getSupportedAssets()) as string[];
  console.log(`- supportedAssets.count=${supportedAssets.length}`);
  console.log(`- settlementToken.supported=${supportedAssets.map((x) => x.toLowerCase()).includes(settlementTokenAddr.toLowerCase())}`);
  try {
    const [price, blockNumber, assetDecimals] =
      (await priceOracle.getPrice(settlementTokenAddr)) as [bigint, bigint, bigint];
    console.log(`- getPrice: price=${price} blockNumber=${blockNumber} assetDecimals=${assetDecimals}`);
  } catch (error: any) {
    console.log(`- getPrice: REVERT ${fmtErr(error)}`);
  }
  try {
    const priceData = (await priceOracle.getPriceData(settlementTokenAddr)) as any;
    console.log(
      `- getPriceData: price=${String(priceData.price ?? priceData[0])} blockNumber=${String(priceData.blockNumber ?? priceData[1])} assetDecimals=${String(priceData.assetDecimals ?? priceData[2])} isValid=${String(priceData.isValid ?? priceData[3])}`,
    );
  } catch (error: any) {
    console.log(`- getPriceData: REVERT ${fmtErr(error)}`);
  }
  try {
    const updateBlock = (await priceOracle.getPriceUpdateBlock(settlementTokenAddr)) as bigint;
    console.log(`- getPriceUpdateBlock=${updateBlock}`);
  } catch (error: any) {
    console.log(`- getPriceUpdateBlock: REVERT ${fmtErr(error)}`);
  }

  console.log("\n[RewardView / EarnConfig]");
  const [rvApi, rvSchema, rvImpl] = (await rewardView.getVersionInfo()) as [bigint, bigint, string];
  console.log(`- RewardView.version api=${rvApi} schema=${rvSchema} impl=${rvImpl}`);
  const rewardSummary =
    (await rewardView.getUserRewardSummaryWithMeta(viewer.address)) as [bigint, bigint, number, bigint, bigint, boolean];
  const easyEarned = (await rewardView.getUserEasyEarnedWithMeta(viewer.address)) as [bigint, bigint, boolean];
  const dynamicMeta = (await rewardView.getDynamicRewardParamsWithMeta()) as [bigint, bigint, bigint, boolean];
  const level1Meta = (await rewardView.getLevelMultiplierWithMeta(1)) as [bigint, bigint, boolean];
  console.log(`- RewardSummary cacheBlock=${rewardSummary[4]} valid=${rewardSummary[5]} level=${rewardSummary[2]} pendingPenalty=${rewardSummary[1]}`);
  console.log(`- EasyEarned cacheBlock=${easyEarned[1]} valid=${easyEarned[2]} earned=${easyEarned[0]}`);
  console.log(`- DynamicMeta threshold=${dynamicMeta[0]} multiplier=${dynamicMeta[1]} cacheBlock=${dynamicMeta[2]} valid=${dynamicMeta[3]}`);
  console.log(`- Level1Meta multiplier=${level1Meta[0]} cacheBlock=${level1Meta[1]} valid=${level1Meta[2]}`);
  const [earnThreshold, earnMultiplier, earnUpdateBlock] = (await earnConfig.getDynamicRewardParams()) as [bigint, bigint, bigint];
  const earnLevel1 = (await earnConfig.getLevelMultiplierBps(1)) as bigint;
  const earnLevelUpdateBlock = (await earnConfig.getLevelConfigUpdateBlock()) as bigint;
  console.log(`- EarnConfig.dynamic threshold=${earnThreshold} multiplier=${earnMultiplier} updateBlock=${earnUpdateBlock}`);
  console.log(`- EarnConfig.level1 multiplier=${earnLevel1} levelConfigUpdateBlock=${earnLevelUpdateBlock}`);

  console.log("\n[Reward writers / token roles]");
  const minterRole = (await easyToken.MINTER_ROLE()) as string;
  const burnerRole = (await easyToken.BURNER_ROLE()) as string;
  console.log(`- EasyToken.decimals=${await easyToken.decimals()} totalSupply=${await easyToken.totalSupply()} viewerBalance=${await easyToken.balanceOf(viewer.address)}`);
  const rewardWriterKeys = [
    "REWARD_MANAGER_CORE",
    "REWARD_ACCRUAL_MANAGER",
    "EASY_STAKING",
    "EASY_EMISSION_CONFIG",
    "EASY_EMISSION_CONTROLLER",
    "EASY_CONSUMPTION",
    "EASY_RECYCLE_DISTRIBUTOR",
  ] as const;
  for (const writerKey of rewardWriterKeys) {
    const writerAddr = modules.get(writerKey)!;
    const hasMinter = await easyToken.hasRole(minterRole, writerAddr).catch(() => false);
    const hasBurner = await easyToken.hasRole(burnerRole, writerAddr).catch(() => false);
    console.log(`- ${writerKey}=${writerAddr} minter=${hasMinter} burner=${hasBurner}`);
  }

  console.log("\n[ACM roles]");
  const roleChecks: Array<[string, string | undefined]> = [
    ["UPDATE_PRICE", modules.get(PRICE_UPDATER_REGISTRY_RAW_KEY)],
    ["ACTION_VIEW_PUSH", modules.get("VAULT_ROUTER")],
    ["ACTION_VIEW_PUSH", modules.get("VAULT_CORE")],
    ["ACTION_VIEW_PUSH", modules.get("LENDING_ENGINE")],
    ["ACTION_VIEW_PUSH", modules.get("LIQUIDATION_MANAGER")],
    ["ACTION_VIEW_PUSH", modules.get("SETTLEMENT_MANAGER")],
    ["VIEW_RISK_DATA", modules.get("HEALTH_VIEW")],
    ["ACTION_VIEW_SYSTEM_STATUS", modules.get("MODULE_HEALTH_VIEW")],
    ["VIEW_USER_DATA", modules.get("LIQUIDATION_RISK_MANAGER")],
  ];
  for (const [roleName, account] of roleChecks) {
    if (!account || account === ethers.ZeroAddress) continue;
    const has = (await acm.hasRole(key(roleName), account)) as boolean;
    console.log(`- ${roleName} -> ${account}: ${has}`);
  }

  console.log("\n[View caches]");
  const [systemStatus, systemValid, updateBlock, ageBlocks] =
    (await viewCache.getSystemStatusWithBlockMeta(settlementTokenAddr)) as [any, boolean, bigint, bigint];
  console.log(
    `- ViewCache.system valid=${systemValid} structValid=${String(systemStatus.isValid ?? systemStatus[4])} updateBlock=${updateBlock} ageBlocks=${ageBlocks} totalCollateral=${String(systemStatus.totalCollateral ?? systemStatus[0])} totalDebt=${String(systemStatus.totalDebt ?? systemStatus[1])}`,
  );
  const [hvApi, hvSchema, hvImpl] = (await healthView.getVersionInfo()) as [bigint, bigint, string];
  console.log(`- HealthView.version api=${hvApi} schema=${hvSchema} impl=${hvImpl}`);
  const [hf, hfValid, hfBlock] =
    (await healthView.getUserHealthFactorWithMeta(viewer.address)) as [bigint, boolean, bigint];
  console.log(`- HealthView.self hf=${hf} valid=${hfValid} block=${hfBlock}`);
}

main().catch((error) => {
  console.error("\n❌ inspect-arbitrum-sepolia-live-state FAILED\n");
  console.error(error);
  process.exit(1);
});
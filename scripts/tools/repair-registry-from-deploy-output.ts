import fs from "fs";
import path from "path";

const hre = require("hardhat");
const { ethers, network } = hre;

type DeployMap = Record<string, string>;

const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";

const NAME_TO_KEY: Record<string, string> = {
  RegistryDynamicModuleKey: "DYNAMIC_MODULE_REGISTRY",
  AccessControlManager: "ACCESS_CONTROL_MANAGER",
  CacheMaintenanceManager: "CACHE_MAINTENANCE_MANAGER",
  WhitelistRegistry: "WHITELIST_REGISTRY",
  AssetWhitelist: "ASSET_WHITELIST",
  AuthorityWhitelist: "AUTHORITY_WHITELIST",
  PriceOracle: "PRICE_ORACLE",
  PriceUpdater: PRICE_UPDATER_REGISTRY_RAW_KEY,
  FeeRouter: "FEE_ROUTER",
  FeeRouterView: "FEE_ROUTER_VIEW",
  SettlementToken: "SETTLEMENT_TOKEN",
  EasyToken: "EASY_TOKEN",
  EasyEmissionConfig: "EASY_EMISSION_CONFIG",
  EasyEmissionController: "EASY_EMISSION_CONTROLLER",
  EasyConsumption: "EASY_CONSUMPTION",
  EasyRecycleDistributor: "EASY_RECYCLE_DISTRIBUTOR",
  EasyStaking: "EASY_STAKING",
  CrossChainGovernance: "CROSS_CHAIN_GOVERNANCE",
  GovernanceGate: "GOVERNANCE_GATE",
  FeatureRegistry: "FEATURE_REGISTRY",
  GovernanceGuardian: "GOVERNANCE_GUARDIAN",
  AICreditsVault: "AI_CREDITS_VAULT",
  RewardManagerCore: "REWARD_MANAGER_CORE",
  RewardAccrualManager: "REWARD_ACCRUAL_MANAGER",
  RewardManager: "REWARD_MANAGER",
  RewardConfig: "REWARD_CONFIG",
  EarnConfig: "REWARD_EARN_CONFIG",
  RewardView: "REWARD_VIEW",
  CollateralManager: "COLLATERAL_MANAGER",
  LendingEngine: "ORDER_ENGINE",
  LendingEngineView: "LENDING_ENGINE_VIEW",
  LoanNFTView: "LOAN_NFT_VIEW",
  VaultBusinessLogic: "VAULT_BUSINESS_LOGIC",
  VaultCore: "VAULT_CORE",
  VaultLendingEngine: "LENDING_ENGINE",
  EarlyRepaymentGuaranteeManager: "EARLY_REPAYMENT_GUARANTEE_MANAGER",
  HealthView: "HEALTH_VIEW",
  SystemView: "SYSTEM_VIEW",
  StatisticsView: "VAULT_STATISTICS",
  StatisticsPushManager: "STATISTICS_PUSH_MANAGER",
  LoanFlowView: "LOAN_FLOW_VIEW",
  LoanFlowPushManager: "LOAN_FLOW_PUSH_MANAGER",
  PositionView: "POSITION_VIEW",
  PreviewView: "PREVIEW_VIEW",
  DashboardView: "DASHBOARD_VIEW",
  UserView: "USER_VIEW",
  RegistryView: "REGISTRY_VIEW",
  AccessControlView: "ACCESS_CONTROL_VIEW",
  CacheOptimizedView: "CACHE_OPTIMIZED_VIEW",
  RiskView: "RISK_VIEW",
  SystemRiskView: "SYSTEM_RISK_VIEW",
  ViewCache: "VIEW_CACHE",
  EventHistoryManager: "EVENT_HISTORY_MANAGER",
  ValuationOracleView: "VALUATION_ORACLE_VIEW",
  LiquidatorView: "LIQUIDATION_VIEW",
  LiquidationManager: "LIQUIDATION_MANAGER",
  SettlementManager: "SETTLEMENT_MANAGER",
  LiquidationPayoutManager: "LIQUIDATION_PAYOUT_MANAGER",
  LenderPoolVault: "LENDER_POOL_VAULT",
  BlocksOnlyCoordinator: "BLOCKS_ONLY_COORDINATOR",
  BlocksOnlyView: "BLOCKS_ONLY_VIEW",
  GuaranteeFundManager: "GUARANTEE_FUND_MANAGER",
  LoanNFT: "LOAN_NFT",
  DegradationCore: "DEGRADATION_CORE",
  DegradationMonitor: "DEGRADATION_MONITOR",
  DegradationStorage: "DEGRADATION_STORAGE",
  ModuleHealthView: "MODULE_HEALTH_VIEW",
  BatchView: "BATCH_VIEW",
  LiquidationRiskView: "LIQUIDATION_RISK_VIEW",
  LiquidationRiskManager: "LIQUIDATION_RISK_MANAGER",
};

const MODULES = [
  "AccessControlManager",
  "CacheMaintenanceManager",
  "WhitelistRegistry",
  "AssetWhitelist",
  "AuthorityWhitelist",
  "PriceOracle",
  "PriceUpdater",
  "LiquidationManager",
  "SettlementManager",
  "VaultLendingEngine",
  "EarlyRepaymentGuaranteeManager",
  "DegradationCore",
  "DegradationMonitor",
  "DegradationStorage",
  "ModuleHealthView",
  "BatchView",
  "LiquidationRiskView",
  "LiquidationPayoutManager",
  "LenderPoolVault",
  "BlocksOnlyCoordinator",
  "BlocksOnlyView",
  "SettlementToken",
  "FeeRouter",
  "FeeRouterView",
  "CollateralManager",
  "LendingEngine",
  "LendingEngineView",
  "LoanNFTView",
  "VaultBusinessLogic",
  "VaultCore",
  "HealthView",
  "SystemView",
  "StatisticsView",
  "StatisticsPushManager",
  "LoanFlowView",
  "LoanFlowPushManager",
  "PositionView",
  "PreviewView",
  "DashboardView",
  "UserView",
  "RegistryView",
  "AccessControlView",
  "CacheOptimizedView",
  "RiskView",
  "SystemRiskView",
  "ViewCache",
  "EventHistoryManager",
  "EasyToken",
  "EasyEmissionConfig",
  "EasyEmissionController",
  "EasyConsumption",
  "EasyRecycleDistributor",
  "EasyStaking",
  "CrossChainGovernance",
  "GovernanceGate",
  "FeatureRegistry",
  "GovernanceGuardian",
  "AICreditsVault",
  "RewardManagerCore",
  "RewardAccrualManager",
  "RewardManager",
  "RewardView",
  "RewardConfig",
  "EarnConfig",
  "ValuationOracleView",
  "LiquidatorView",
  "GuaranteeFundManager",
  "LoanNFT",
  "RegistryDynamicModuleKey",
  "LiquidationRiskManager",
] as const;

const EXTRA_ALIASES: Array<{ deployName: keyof DeployMap; keyName: string }> = [
  { deployName: "CollateralManager", keyName: "CM" },
];

const NO_CODE_ALLOWED = new Set<string>(["GovernanceGuardian"]);

function keyOf(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function resolveDeployFile(): string {
  const explicit = process.env.DEPLOY_OUTPUT_FILE?.trim();
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.resolve(__dirname, "..", "deployments", explicit);
  }
  return path.resolve(__dirname, "..", "deployments", "arbitrum-sepolia.mock-suite.json");
}

function loadDeployMap(file: string): DeployMap {
  return JSON.parse(fs.readFileSync(file, "utf8")) as DeployMap;
}

async function ensureCode(addr: string, label: string) {
  const code = await ethers.provider.getCode(addr);
  if (code === "0x") {
    if (NO_CODE_ALLOWED.has(label)) {
      console.log(`WARN ${label} has no code at ${addr}; allowing EOA-style registry binding`);
      return;
    }
    throw new Error(`${label} has no code at ${addr}`);
  }
}

async function bindModule(registry: any, keyName: string, addr: string) {
  const key = keyOf(keyName);
  const current = ((await registry.getModule(key).catch(() => ethers.ZeroAddress)) ||
    ethers.ZeroAddress) as string;
  if (current.toLowerCase() === addr.toLowerCase()) {
    return false;
  }
  await (await registry.setModule(key, addr)).wait();
  const rebound = (await registry.getModule(key)) as string;
  if (rebound.toLowerCase() !== addr.toLowerCase()) {
    throw new Error(`bind verification failed for ${keyName}: expected ${addr}, got ${rebound}`);
  }
  return true;
}

async function main() {
  const deployFile = resolveDeployFile();
  const deployed = loadDeployMap(deployFile);
  const registryAddr = process.env.REGISTRY_ADDRESS?.trim() || deployed.Registry;
  if (!registryAddr) {
    throw new Error("REGISTRY_ADDRESS is not set and DeployMap.Registry is missing");
  }

  const [signer] = await ethers.getSigners();
  const registry = await ethers.getContractAt(
    [
      "function getModule(bytes32) view returns (address)",
      "function setModule(bytes32,address) external",
      "function setDynamicModuleKeyRegistry(address) external",
    ],
    registryAddr,
    signer,
  );

  console.log(`== Registry Repair ==`);
  console.log(`network=${network.name}`);
  console.log(`deployFile=${deployFile}`);
  console.log(`registry=${registryAddr}`);
  console.log(`signer=${signer.address}`);

  let updated = 0;
  let unchanged = 0;

  for (const name of MODULES) {
    const addr = deployed[name];
    const keyName = NAME_TO_KEY[name];
    if (!addr || !keyName || addr === ethers.ZeroAddress) continue;
    await ensureCode(addr, String(name));
    const changed = await bindModule(registry, keyName, addr);
    if (changed) {
      updated += 1;
      console.log(`SET ${keyName} -> ${addr}`);
    } else {
      unchanged += 1;
    }
  }

  for (const alias of EXTRA_ALIASES) {
    const addr = deployed[alias.deployName];
    if (!addr || addr === ethers.ZeroAddress) continue;
    await ensureCode(addr, String(alias.deployName));
    const changed = await bindModule(registry, alias.keyName, addr);
    if (changed) {
      updated += 1;
      console.log(`SET ${alias.keyName} -> ${addr}`);
    } else {
      unchanged += 1;
    }
  }

  if (deployed.RegistryDynamicModuleKey && deployed.RegistryDynamicModuleKey !== ethers.ZeroAddress) {
    try {
      await ensureCode(deployed.RegistryDynamicModuleKey, "RegistryDynamicModuleKey");
      await (await registry.setDynamicModuleKeyRegistry(deployed.RegistryDynamicModuleKey)).wait();
      console.log(`SET dynamic module key registry -> ${deployed.RegistryDynamicModuleKey}`);
    } catch (error) {
      console.log(`WARN setDynamicModuleKeyRegistry skipped: ${error}`);
    }
  }

  console.log(`Registry repair summary: updated=${updated}, unchanged=${unchanged}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
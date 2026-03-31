import fs from "fs";
import path from "path";

const hre = require("hardhat");
const { ethers, network } = hre;

type DeployMap = Record<string, string>;

type LiveCoverage = {
  level: "direct-script" | "flow-exercised" | "read-asserted" | "none";
  evidence: string;
};

type AuditRow = {
  name: string;
  registryKey: string | null;
  deployOutput: string | null;
  registryValue: string | null;
  outputHasCode: boolean | null;
  registryHasCode: boolean | null;
  alignment: "match" | "mismatch" | "missing-output" | "missing-registry" | "not-registered";
  liveLevel: LiveCoverage["level"];
  liveEvidence: string;
};

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

const DEPLOY_TARGETS = [
  "Registry",
  "RegistryDynamicModuleKey",
  "AccessControlManager",
  "CacheMaintenanceManager",
  "WhitelistRegistry",
  "AssetWhitelist",
  "AuthorityWhitelist",
  "PriceOracle",
  "PriceUpdater",
  "FeeRouter",
  "FeeRouterView",
  "SettlementToken",
  "CollateralManager",
  "LendingEngine",
  "VaultLendingEngine",
  "VaultBusinessLogic",
  "VaultRouter",
  "VaultCore",
  "LenderPoolVault",
  "SettlementManager",
  "LiquidationManager",
  "LiquidationPayoutManager",
  "LiquidationRiskManager",
  "LiquidationRiskView",
  "LiquidatorView",
  "BlocksOnlyCoordinator",
  "BlocksOnlyView",
  "GuaranteeFundManager",
  "EarlyRepaymentGuaranteeManager",
  "HealthView",
  "SystemView",
  "RegistryView",
  "StatisticsView",
  "StatisticsPushManager",
  "LoanFlowView",
  "LoanFlowPushManager",
  "PositionView",
  "PreviewView",
  "DashboardView",
  "UserView",
  "AccessControlView",
  "CacheOptimizedView",
  "LendingEngineView",
  "LoanNFTView",
  "RiskView",
  "SystemRiskView",
  "ViewCache",
  "EventHistoryManager",
  "ValuationOracleView",
  "ModuleHealthView",
  "BatchView",
  "DegradationCore",
  "DegradationStorage",
  "DegradationMonitor",
  "FeatureRegistry",
  "GovernanceGate",
  "CrossChainGovernance",
  "GovernanceGuardian",
  "AICreditsVault",
  "RewardManagerCore",
  "RewardAccrualManager",
  "RewardManager",
  "RewardConfig",
  "EarnConfig",
  "RewardView",
  "EasyToken",
  "EasyEmissionConfig",
  "EasyEmissionController",
  "EasyConsumption",
  "EasyRecycleDistributor",
  "EasyStaking",
  "LoanNFT",
] as const;

const LIVE_COVERAGE: Record<string, LiveCoverage> = {
  Registry: { level: "read-asserted", evidence: "live-view-registry-routes, live-liquidation-registry-preflight" },
  RegistryDynamicModuleKey: { level: "none", evidence: "no explicit live script" },
  AccessControlManager: { level: "read-asserted", evidence: "live-access-control-view, live-preflight" },
  CacheMaintenanceManager: { level: "none", evidence: "no explicit live script" },
  WhitelistRegistry: { level: "read-asserted", evidence: "live-asset-precheck" },
  AssetWhitelist: { level: "read-asserted", evidence: "live-asset-precheck" },
  AuthorityWhitelist: { level: "read-asserted", evidence: "live-asset-precheck" },
  PriceOracle: { level: "read-asserted", evidence: "live-asset-precheck, live-preflight" },
  PriceUpdater: { level: "read-asserted", evidence: "live-asset-precheck" },
  FeeRouter: { level: "direct-script", evidence: "live-fee-accounting, live-fee-prepaid/remaining/dynamic-gate" },
  FeeRouterView: { level: "direct-script", evidence: "live-fee-accounting, live-fee-prepaid/remaining/dynamic-gate, live-view-consistency-gate" },
  SettlementToken: { level: "flow-exercised", evidence: "platform-baseline, guarantee-flow, liquidation, fee gates" },
  CollateralManager: { level: "flow-exercised", evidence: "platform-baseline, warmup, withdraw, liquidation flows" },
  LendingEngine: { level: "flow-exercised", evidence: "platform-baseline, warmup, live-lending-engine-view" },
  VaultLendingEngine: { level: "flow-exercised", evidence: "platform-baseline, guarantee-flow, liquidation flows" },
  VaultBusinessLogic: { level: "flow-exercised", evidence: "warmup, platform-baseline, reserve/cancel-reserve" },
  VaultRouter: { level: "flow-exercised", evidence: "deposit/withdraw/repay flows, platform-baseline" },
  VaultCore: { level: "flow-exercised", evidence: "deposit/withdraw/repay/liquidation flows" },
  LenderPoolVault: { level: "flow-exercised", evidence: "reserve/cancel-reserve, warmup" },
  SettlementManager: { level: "direct-script", evidence: "live-liquidation, live-liquidation-fallback, platform-baseline" },
  LiquidationManager: { level: "direct-script", evidence: "live-liquidation, live-liquidation-fallback" },
  LiquidationPayoutManager: { level: "direct-script", evidence: "live-liquidation, live-liquidation-fallback" },
  LiquidationRiskManager: { level: "read-asserted", evidence: "live-liquidation-registry-preflight, live-liquidation-view-assertions" },
  LiquidationRiskView: { level: "direct-script", evidence: "live-liquidation-view-assertions, live-liquidation" },
  LiquidatorView: { level: "direct-script", evidence: "live-liquidation-registry-preflight, live-liquidation-view-assertions, live-liquidation, live-liquidation-fallback" },
  BlocksOnlyCoordinator: { level: "direct-script", evidence: "live-blocks-only-liquidation" },
  BlocksOnlyView: { level: "direct-script", evidence: "live-liquidation-view-assertions, live-blocks-only-liquidation" },
  GuaranteeFundManager: { level: "flow-exercised", evidence: "live-guarantee-flow, platform-baseline" },
  EarlyRepaymentGuaranteeManager: { level: "flow-exercised", evidence: "live-guarantee-flow, platform-baseline" },
  HealthView: { level: "read-asserted", evidence: "live-preflight, live-view-consistency-gate, live-view-facade-consistency" },
  SystemView: { level: "read-asserted", evidence: "live-view-registry-routes, liquidation registry preflight" },
  RegistryView: { level: "direct-script", evidence: "live-view-registry-routes, live-view-facade-gate" },
  StatisticsView: { level: "read-asserted", evidence: "live-view-consistency-gate, live-view-facade-consistency, platform-baseline" },
  StatisticsPushManager: { level: "flow-exercised", evidence: "platform-baseline and consistency gates depend on pushed statistics" },
  LoanFlowView: { level: "read-asserted", evidence: "live-view-consistency-gate, live-view-reward-loanflow-boundary, guarantee-flow" },
  LoanFlowPushManager: { level: "flow-exercised", evidence: "loan flow counters asserted after borrow/repay flows" },
  PositionView: { level: "read-asserted", evidence: "live-preflight, live-view-consistency-gate, platform-baseline" },
  PreviewView: { level: "read-asserted", evidence: "live-view-facade-gate, live-read-pressure" },
  DashboardView: { level: "read-asserted", evidence: "live-view-facade-gate, live-view-facade-consistency" },
  UserView: { level: "read-asserted", evidence: "live-view-facade-gate, live-view-facade-consistency" },
  AccessControlView: { level: "direct-script", evidence: "live-access-control-view" },
  CacheOptimizedView: { level: "read-asserted", evidence: "live-view-facade-gate, live-view-facade-consistency" },
  LendingEngineView: { level: "direct-script", evidence: "live-lending-engine-view" },
  LoanNFTView: { level: "read-asserted", evidence: "live-view-registry-routes, live-view-facade-gate" },
  RiskView: { level: "read-asserted", evidence: "live-view-facade-gate" },
  SystemRiskView: { level: "read-asserted", evidence: "live-view-consistency-gate, live-view-facade-gate" },
  ViewCache: { level: "read-asserted", evidence: "live-prime-viewcache, live-preflight" },
  EventHistoryManager: { level: "direct-script", evidence: "live-event-history-manager" },
  ValuationOracleView: { level: "read-asserted", evidence: "live-asset-precheck, live-preflight, live-blocks-only-liquidation" },
  ModuleHealthView: { level: "read-asserted", evidence: "live-view-facade-gate, live-view-registry-routes" },
  BatchView: { level: "read-asserted", evidence: "live-view-facade-gate, live-view-registry-routes" },
  DegradationCore: { level: "none", evidence: "no explicit live script" },
  DegradationStorage: { level: "none", evidence: "no explicit live script" },
  DegradationMonitor: { level: "none", evidence: "no explicit live script" },
  FeatureRegistry: { level: "none", evidence: "no explicit live script" },
  GovernanceGate: { level: "flow-exercised", evidence: "live-reward-config-governance" },
  CrossChainGovernance: { level: "flow-exercised", evidence: "live-reward-config-governance" },
  GovernanceGuardian: { level: "none", evidence: "no explicit live script" },
  AICreditsVault: { level: "none", evidence: "no explicit live script" },
  RewardManagerCore: { level: "flow-exercised", evidence: "platform-baseline, reward-config-governance" },
  RewardAccrualManager: { level: "flow-exercised", evidence: "platform-baseline, reward-config-governance" },
  RewardManager: { level: "flow-exercised", evidence: "platform-baseline, reward-config-governance" },
  RewardConfig: { level: "flow-exercised", evidence: "live-reward-config-governance" },
  EarnConfig: { level: "flow-exercised", evidence: "live-reward-config-governance" },
  RewardView: { level: "read-asserted", evidence: "live-view-reward-loanflow-boundary, live-preflight, platform-baseline" },
  EasyToken: { level: "flow-exercised", evidence: "platform-baseline" },
  EasyEmissionConfig: { level: "flow-exercised", evidence: "platform-baseline, live-reward-config-governance" },
  EasyEmissionController: { level: "flow-exercised", evidence: "platform-baseline" },
  EasyConsumption: { level: "flow-exercised", evidence: "platform-baseline" },
  EasyRecycleDistributor: { level: "flow-exercised", evidence: "platform-baseline" },
  EasyStaking: { level: "none", evidence: "no explicit live script" },
  LoanNFT: { level: "flow-exercised", evidence: "platform-baseline, live-view-registry-routes" },
};

const COVERAGE_RANK: Record<LiveCoverage["level"], number> = {
  "direct-script": 3,
  "flow-exercised": 2,
  "read-asserted": 1,
  none: 0,
};

function keyOf(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

function resolveDeployFile(): string {
  const explicit = process.env.DEPLOY_OUTPUT_FILE?.trim();
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.resolve(process.cwd(), explicit.startsWith("scripts/") ? explicit : path.join("scripts", "deployments", explicit));
  }
  return path.resolve(process.cwd(), "scripts/deployments/arbitrum-sepolia.mock-suite.json");
}

function loadDeployMap(file: string): DeployMap {
  return JSON.parse(fs.readFileSync(file, "utf8")) as DeployMap;
}

async function hasCode(addr: string | null): Promise<boolean | null> {
  if (!addr || addr === ethers.ZeroAddress) {
    return null;
  }
  const code = await ethers.provider.getCode(addr);
  return code !== "0x";
}

function normalize(addr: string | null): string | null {
  if (!addr || addr === ethers.ZeroAddress) {
    return null;
  }
  return addr.toLowerCase();
}

function coverageFor(name: string): LiveCoverage {
  return LIVE_COVERAGE[name] ?? { level: "none", evidence: "no explicit live evidence mapping" };
}

async function main() {
  const deployFile = resolveDeployFile();
  const deployed = loadDeployMap(deployFile);
  const registryAddr = process.env.REGISTRY_ADDRESS?.trim() || deployed.Registry;
  if (!registryAddr) {
    throw new Error("Registry address missing from env and deploy output");
  }

  const registry = await ethers.getContractAt(
    ["function getModule(bytes32) view returns (address)"],
    registryAddr,
  );

  const rows: AuditRow[] = [];

  for (const name of DEPLOY_TARGETS) {
    const registryKey = NAME_TO_KEY[name] ?? null;
    const deployOutput = deployed[name] ?? null;
    const registryValue = registryKey
      ? (((await registry.getModule(keyOf(registryKey))) as string) || ethers.ZeroAddress)
      : null;
    const normalizedRegistryValue = normalize(registryValue);
    const normalizedDeployOutput = normalize(deployOutput);
    const outputHasCode = await hasCode(deployOutput);
    const registryHasCode = await hasCode(registryValue);

    let alignment: AuditRow["alignment"] = "not-registered";
    if (!registryKey) {
      alignment = "not-registered";
    } else if (!normalizedDeployOutput) {
      alignment = "missing-output";
    } else if (!normalizedRegistryValue) {
      alignment = "missing-registry";
    } else if (normalizedDeployOutput === normalizedRegistryValue) {
      alignment = "match";
    } else {
      alignment = "mismatch";
    }

    const live = coverageFor(name);
    rows.push({
      name,
      registryKey,
      deployOutput,
      registryValue: normalizedRegistryValue ? registryValue : null,
      outputHasCode,
      registryHasCode,
      alignment,
      liveLevel: live.level,
      liveEvidence: live.evidence,
    });
  }

  const summary = {
    totalTargets: rows.length,
    matches: rows.filter((row) => row.alignment === "match").length,
    mismatches: rows.filter((row) => row.alignment === "mismatch").length,
    missingOutput: rows.filter((row) => row.alignment === "missing-output").length,
    missingRegistry: rows.filter((row) => row.alignment === "missing-registry").length,
    notRegistered: rows.filter((row) => row.alignment === "not-registered").length,
    noLiveEvidence: rows.filter((row) => row.liveLevel === "none").length,
    weakLiveEvidence: rows.filter((row) => COVERAGE_RANK[row.liveLevel] <= 1).length,
  };

  console.log(`# Arbitrum Sepolia Deploy Closure Audit`);
  console.log(`network=${network.name}`);
  console.log(`deployFile=${deployFile}`);
  console.log(`registry=${registryAddr}`);
  console.log(`summary=${JSON.stringify(summary)}`);
  console.log("");
  console.log(`| Module | RegistryKey | DeployOutput | Registry | Align | OutputCode | RegistryCode | Live | Evidence |`);
  console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);

  for (const row of rows) {
    console.log(
      `| ${row.name} | ${row.registryKey ?? "-"} | ${row.deployOutput ?? "-"} | ${row.registryValue ?? "-"} | ${row.alignment} | ${row.outputHasCode === null ? "-" : row.outputHasCode ? "yes" : "no"} | ${row.registryHasCode === null ? "-" : row.registryHasCode ? "yes" : "no"} | ${row.liveLevel} | ${row.liveEvidence} |`,
    );
  }

  const flagged = rows.filter(
    (row) => row.alignment !== "match" || COVERAGE_RANK[row.liveLevel] === 0,
  );
  console.log("");
  console.log(`## Flagged`);
  for (const row of flagged) {
    console.log(
      `- ${row.name}: align=${row.alignment}, live=${row.liveLevel}, deployOutput=${row.deployOutput ?? "-"}, registry=${row.registryValue ?? "-"}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
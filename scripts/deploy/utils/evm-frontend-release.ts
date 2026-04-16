import fs from "fs";
import path from "path";

export type AddressMap = Record<string, string>;

export type FrontendReleaseArtifact = {
  network: string;
  chainId: number;
  releaseId: string;
  generatedAt: string;
  registry: string;
  sourceFiles: Record<string, string>;
  contracts: Record<string, { address: string; registryKey: string | null }>;
};

const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";

export const EVM_NAME_TO_KEY: Record<string, string> = {
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
  OrderStateStoreV2: "ORDER_STATE_STORE",
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJson(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function buildContractMetadata(core: AddressMap) {
  return Object.fromEntries(
    Object.entries(core).map(([name, address]) => [name, { address, registryKey: EVM_NAME_TO_KEY[name] ?? null }]),
  );
}

export function buildFrontendReleaseArtifact(params: {
  network: string;
  chainId: number;
  releaseId: string;
  generatedAt: string;
  registry: string;
  sourceFiles: Record<string, string>;
  core: AddressMap;
}): FrontendReleaseArtifact {
  return {
    network: params.network,
    chainId: params.chainId,
    releaseId: params.releaseId,
    generatedAt: params.generatedAt,
    registry: params.registry,
    sourceFiles: params.sourceFiles,
    contracts: buildContractMetadata(params.core),
  };
}

export function generateFrontendModuleContent(params: {
  displayLabel: string;
  network: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  releaseArtifact: FrontendReleaseArtifact;
}) {
  return `// Auto-generated contract configuration file - ${params.displayLabel}\n// Generated at: ${params.releaseArtifact.generatedAt}\n// Release ID: ${params.releaseArtifact.releaseId}\n//\n// Naming:\n// - OrderEngine = core/LendingEngine (Registry KEY_ORDER_ENGINE)\n// - VaultLendingEngine = debt ledger engine (Registry KEY_LE)\n// - LendingEngine is a legacy alias of OrderEngine (kept for backward compatibility)\n\nexport const DEPLOYMENT_METADATA = ${JSON.stringify({
    network: params.releaseArtifact.network,
    chainId: params.releaseArtifact.chainId,
    releaseId: params.releaseArtifact.releaseId,
    generatedAt: params.releaseArtifact.generatedAt,
    registry: params.releaseArtifact.registry,
    sourceFiles: params.releaseArtifact.sourceFiles,
  }, null, 2)} as const;\n\nexport const CONTRACT_METADATA = ${JSON.stringify(params.releaseArtifact.contracts, null, 2)} as const;\n\nexport const CONTRACT_ADDRESSES = {\n${Object.entries(params.releaseArtifact.contracts)
    .map(([key, value]) => `  ${key}: '${value.address}'`)
    .join(",\n")}\n};\n\nexport const NETWORK_CONFIG = {\n  chainId: ${params.chainId},\n  rpcUrl: '${params.rpcUrl}',\n  explorer: '${params.explorer}',\n  name: '${params.network}'\n};\n`;
}

export function writeFrontendArtifacts(params: {
  frontendFile: string;
  canonicalFrontendFile: string;
  frontendReleaseFile: string;
  manifestFile?: string;
  mockSuiteFile?: string;
  core: AddressMap;
  releaseArtifact: FrontendReleaseArtifact;
  displayLabel: string;
  network: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
}) {
  const frontendContent = generateFrontendModuleContent({
    displayLabel: params.displayLabel,
    network: params.network,
    chainId: params.chainId,
    rpcUrl: params.rpcUrl,
    explorer: params.explorer,
    releaseArtifact: params.releaseArtifact,
  });

  ensureDir(path.dirname(params.frontendFile));
  ensureDir(path.dirname(params.canonicalFrontendFile));
  ensureDir(path.dirname(params.frontendReleaseFile));
  fs.writeFileSync(params.frontendFile, frontendContent, "utf8");
  fs.writeFileSync(params.canonicalFrontendFile, frontendContent, "utf8");
  writeJson(params.frontendReleaseFile, params.releaseArtifact);

  if (params.manifestFile) {
    writeJson(params.manifestFile, {
      network: params.network,
      chainId: params.chainId,
      releaseId: params.releaseArtifact.releaseId,
      generatedAt: params.releaseArtifact.generatedAt,
      deployOutputFile: params.releaseArtifact.sourceFiles.deployOutputFile,
      frontendConfigFile: params.releaseArtifact.sourceFiles.frontendConfigFile,
      frontendReleaseFile: params.releaseArtifact.sourceFiles.frontendReleaseFile,
      baselineFile: params.releaseArtifact.sourceFiles.baselineFile ?? null,
      mockSuiteDeployFile: params.releaseArtifact.sourceFiles.mockSuiteFile ?? null,
      registry: params.releaseArtifact.registry,
      contracts: params.releaseArtifact.contracts,
    });
  }

  if (params.mockSuiteFile && !fs.existsSync(params.mockSuiteFile)) {
    writeJson(params.mockSuiteFile, params.core);
  }
}
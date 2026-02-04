import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../../frontend-config/contracts-localhost";

type ModuleKeyMap = Record<string, string>;

const NAME_TO_KEY: ModuleKeyMap = {
  RegistryHelper: "REGISTRY_HELPER",
  RegistryDynamicModuleKey: "DYNAMIC_MODULE_REGISTRY",
  AccessControlManager: "ACCESS_CONTROL_MANAGER",
  CacheMaintenanceManager: "CACHE_MAINTENANCE_MANAGER",
  AssetWhitelist: "ASSET_WHITELIST",
  AuthorityWhitelist: "AUTHORITY_WHITELIST",
  PriceOracle: "PRICE_ORACLE",
  CoinGeckoPriceUpdater: "COINGECKO_PRICE_UPDATER",
  FeeRouter: "FEE_ROUTER",
  FeeRouterView: "FEE_ROUTER_VIEW",
  RewardPoints: "REWARD_POINTS",
  RewardManagerCore: "REWARD_MANAGER_CORE",
  RewardCore: "REWARD_CORE",
  RewardManager: "REWARD_MANAGER",
  CollateralManager: "COLLATERAL_MANAGER",
  LendingEngine: "ORDER_ENGINE",
  LendingEngineView: "LENDING_ENGINE_VIEW",
  VaultBusinessLogic: "VAULT_BUSINESS_LOGIC",
  VaultCore: "VAULT_CORE",
  VaultLendingEngine: "LENDING_ENGINE",
  EarlyRepaymentGuaranteeManager: "EARLY_REPAYMENT_GUARANTEE_MANAGER",
  HealthView: "HEALTH_VIEW",
  SystemView: "SYSTEM_VIEW",
  StatisticsView: "VAULT_STATISTICS",
  StatisticsPushManager: "STATISTICS_PUSH_MANAGER",
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
  RewardView: "REWARD_VIEW",
  RewardConfig: "REWARD_CONFIG",
  RewardConsumption: "REWARD_CONSUMPTION",
  ValuationOracleView: "VALUATION_ORACLE_VIEW",
  LiquidatorView: "LIQUIDATION_VIEW",
  LiquidationConfigModule: "LIQUIDATION_CONFIG_MANAGER",
  LiquidationManager: "LIQUIDATION_MANAGER",
  SettlementManager: "SETTLEMENT_MANAGER",
  LiquidationPayoutManager: "LIQUIDATION_PAYOUT_MANAGER",
  LenderPoolVault: "LENDER_POOL_VAULT",
  GuaranteeFundManager: "GUARANTEE_FUND_MANAGER",
  LoanNFT: "LOAN_NFT",
  MockUSDC: "SETTLEMENT_TOKEN",
  LiquidationRiskManager: "LIQUIDATION_RISK_MANAGER",
  DegradationCore: "DEGRADATION_CORE",
  DegradationMonitor: "DEGRADATION_MONITOR",
  DegradationStorage: "DEGRADATION_STORAGE",
  ModuleHealthView: "MODULE_HEALTH_VIEW",
  BatchView: "BATCH_VIEW",
  LiquidationRiskView: "LIQUIDATION_RISK_VIEW",
};

const MODULE_ORDER = [
  "AccessControlManager",
  "CacheMaintenanceManager",
  "AssetWhitelist",
  "AuthorityWhitelist",
  "PriceOracle",
  "CoinGeckoPriceUpdater",
  "VaultLendingEngine",
  "EarlyRepaymentGuaranteeManager",
  "DegradationCore",
  "DegradationMonitor",
  "DegradationStorage",
  "ModuleHealthView",
  "BatchView",
  "LiquidationRiskView",
  "LiquidationPayoutManager",
  "LiquidationManager",
  "SettlementManager",
  "LenderPoolVault",
  "FeeRouter",
  "FeeRouterView",
  "CollateralManager",
  "LendingEngine",
  "LendingEngineView",
  "VaultBusinessLogic",
  "VaultCore",
  "HealthView",
  "SystemView",
  "StatisticsView",
  "StatisticsPushManager",
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
  "RewardPoints",
  "RewardManagerCore",
  "RewardCore",
  "RewardManager",
  "RewardView",
  "RewardConfig",
  "RewardConsumption",
  "ValuationOracleView",
  "LiquidatorView",
  "LiquidationConfigModule",
  "GuaranteeFundManager",
  "LoanNFT",
  "MockUSDC",
  "RegistryDynamicModuleKey",
  "LiquidationRiskManager",
];

const toKey = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name));

const fmtAddr = (addr: string | null | undefined) => (addr ? addr : "N/A");

async function main() {
  const registryAddr = CONTRACT_ADDRESSES.Registry;
  const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;

  const lines: string[] = [];
  lines.push(`Registry: ${registryAddr}`);
  lines.push("");
  lines.push("| Module | Key | Registry | Config | Match |");
  lines.push("|---|---|---|---|---|");

  let mismatches = 0;
  let missing = 0;

  for (const name of MODULE_ORDER) {
    const keyName = NAME_TO_KEY[name];
    if (!keyName) continue;
    const key = toKey(keyName);

    let registryAddrValue: string | null = null;
    try {
      registryAddrValue = (await registry.getModuleOrRevert(key)) as string;
    } catch {
      registryAddrValue = null;
    }

    const configAddrValue =
      (CONTRACT_ADDRESSES as any)[name] ??
      (name === "LendingEngine" ? (CONTRACT_ADDRESSES as any).OrderEngine : undefined);

    const registryAddrLower = registryAddrValue?.toLowerCase();
    const configAddrLower = configAddrValue?.toLowerCase();

    let match = "✅";
    if (!registryAddrValue || !configAddrValue) {
      match = "⚠️";
      missing += 1;
    } else if (registryAddrLower !== configAddrLower) {
      match = "❌";
      mismatches += 1;
    }

    lines.push(
      `| ${name} | ${keyName} | ${fmtAddr(registryAddrValue)} | ${fmtAddr(
        configAddrValue
      )} | ${match} |`
    );
  }

  lines.push("");
  lines.push(`Summary: mismatches=${mismatches}, missing=${missing}`);

  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

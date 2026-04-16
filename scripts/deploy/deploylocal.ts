/**
 * 本地网络一键部署脚本（符合 contracts/docs/Architecture-Guide.md）
 * - 部署 Registry（单一入口 / 单一 Proxy，Scheme A）
 * - 部署并注册核心业务与视图模块（ACM/白名单/Oracle/Updater/FeeRouter/CM/LE/VBL/VaultRouter/VaultCore/HealthView）
 * - 写入 scripts/deployments/localhost.json 与 frontend-config/contracts-localhost.ts
 * - 确保前端 `Frontend/src/services/config/network.ts` 读取的地址齐全
 */

import fs from "fs";
import path from "path";
import { deployRegistryStack } from "./modules/registry";
import { initStableDeploymentOutput } from "./utils/stable-output";
import {
  ensureRewardConfigEmergencyGranted,
  ensureRewardConfigEmergencyRevoked,
} from "./utils/reward-config-emergency";

// Must run BEFORE requiring Hardhat to prevent redraw-style output from polluting logs.
initStableDeploymentOutput();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const hre = require("hardhat");
const { ethers, upgrades, network } = hre;

type DeployMap = Record<string, string>;

const DEPLOY_DIR = path.join(__dirname, "..", "deployments");
const DEPLOY_FILE = path.join(DEPLOY_DIR, "localhost.json");
// 将前端配置输出到 contracts/frontend-config，供前端直接导入使用
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend-config");
const FRONTEND_FILE = path.join(FRONTEND_DIR, "contracts-localhost.ts");
const LOCALHOST_RPC_URL =
  process.env.LOCALHOST_RPC_URL || "http://127.0.0.1:8545";
const DEFAULT_PAYOUT_BPS = {
  platform: 300,
  reserve: 200,
  lender: 1700,
  liquidator: 7800,
};

function load(): DeployMap {
  if (fs.existsSync(DEPLOY_FILE))
    return JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf8")) as DeployMap;
  return {};
}

function save(map: DeployMap) {
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  fs.writeFileSync(DEPLOY_FILE, JSON.stringify(map, null, 2));
}

function logDeployed(name: string, addr: string, kind: "proxy" | "regular") {
  // Avoid long single-line logs: some terminal recorders duplicate/truncate long lines.
  const suffix = kind === "proxy" ? " (proxy) deployed" : " deployed";
  console.log(`✅ ${name}${suffix}`);
  console.log(`   ${addr}`);
}

function logBound(label: string, addr: string) {
  console.log(`✅ Bound ${label}`);
  console.log(`   ${addr}`);
}

function logActionTo(label: string, addr: string) {
  console.log(label);
  console.log(`   ${addr}`);
}

function keyOf(upperSnake: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(upperSnake));
}

const PRICE_UPDATER_REGISTRY_RAW_KEY = "COINGECKO_PRICE_UPDATER";

function registryLabel(keyUpperSnake: string): string {
  if (keyUpperSnake === PRICE_UPDATER_REGISTRY_RAW_KEY) {
    return "PRICE_UPDATER (compat raw: COINGECKO_PRICE_UPDATER)";
  }
  return keyUpperSnake;
}

async function ensureVaultRouterFeeRouterViewBinding(deployed: DeployMap) {
  if (!deployed.VaultCore || !deployed.VaultRouter || !deployed.FeeRouterView) {
    return;
  }

  const vaultCore = (await ethers.getContractAt(
    ["function viewContractAddrVar() view returns (address)"],
    deployed.VaultCore,
  )) as any;
  const viewGatewayAddr = (await vaultCore.viewContractAddrVar()) as string;
  if (!viewGatewayAddr || viewGatewayAddr === ethers.ZeroAddress) {
    throw new Error("VaultCore.viewContractAddrVar() is zero before FeeRouterView binding");
  }

  const vaultRouter = (await ethers.getContractAt(
    [
      "function feeRouterViewAddrVar() view returns (address)",
      "function setFeeRouterView(address newFeeRouterView)",
    ],
    viewGatewayAddr,
  )) as any;
  const before = (await vaultRouter.feeRouterViewAddrVar()) as string;
  if (before.toLowerCase() === deployed.FeeRouterView.toLowerCase()) {
    console.log("↪️ VaultRouter FeeRouterView binding already set");
    return;
  }

  await (await vaultRouter.setFeeRouterView(deployed.FeeRouterView)).wait();
  const after = (await vaultRouter.feeRouterViewAddrVar()) as string;
  if (after.toLowerCase() !== deployed.FeeRouterView.toLowerCase()) {
    throw new Error(
      `VaultRouter FeeRouterView binding mismatch after set: after=${after} expected=${deployed.FeeRouterView}`,
    );
  }
  logBound("VaultRouter.FeeRouterView", after);
}

type BindModuleOptions = {
  /** If provided, used in logs instead of keyUpperSnake */
  label?: string;
  /** Whether to log when binding is already correct */
  logIfUnchanged?: boolean;
};

async function bindRegistryModule(
  registry: any,
  keyUpperSnake: string,
  addr: string | undefined,
  opts: BindModuleOptions = {},
): Promise<{ changed: boolean }> {
  if (!addr || addr === ethers.ZeroAddress) return { changed: false };
  const key = keyOf(keyUpperSnake);
  const label = opts.label ?? keyUpperSnake;
  try {
    const existing: string = await registry.getModule(key);
    if (
      existing &&
      existing !== ethers.ZeroAddress &&
      existing.toLowerCase() === addr.toLowerCase()
    ) {
      if (opts.logIfUnchanged) console.log(`↪️ ${label} already set`);
      return { changed: false };
    }
    await (await registry.setModule(key, addr)).wait();
    logBound(label, addr);
    return { changed: true };
  } catch (e) {
    console.log(`⚠️ Failed to bind ${label}:`, e);
    return { changed: false };
  }
}

async function deployRegular(
  name: string,
  ...args: unknown[]
): Promise<string> {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  logDeployed(name, addr, "regular");
  return addr;
}

async function deployProxy(
  name: string,
  args: unknown[] = [],
  opts: Record<string, unknown> = {},
): Promise<string> {
  const f = await ethers.getContractFactory(name);
  // ⚠️ 安全策略：默认严格（不自动 unsafeAllow）。
  // - 如果合约含 constructor(_disableInitializers)，请在合约里加：
  //   `/// @custom:oz-upgrades-unsafe-allow constructor`
  // - 如果确实需要 delegatecall / 外部库链接，请在合约里用对应的
  //   `@custom:oz-upgrades-unsafe-allow ...` 精准标注并在代码层做权限/输入约束。
  // Phase 0c (OZ v5 migration): default to UUPS unless explicitly overridden.
  const defaultOpts = { kind: "uups", ...opts };
  const p = await upgrades.deployProxy(f, args, defaultOpts);
  await p.waitForDeployment();
  const addr = await p.getAddress();
  logDeployed(name, addr, "proxy");
  return addr;
}

async function upgradeProxy(
  name: string,
  proxyAddr: string,
  opts: Record<string, unknown> = {},
): Promise<string> {
  const f = await ethers.getContractFactory(name);
  const defaultOpts = { kind: "uups", ...opts };
  const p = await upgrades.upgradeProxy(proxyAddr, f, defaultOpts);
  await p.waitForDeployment();
  const addr = await p.getAddress();
  console.log(`🔄 ${name} upgraded`);
  console.log(`   ${addr}`);
  return addr;
}

async function ensureViewProxyVersion(
  name: string,
  proxyAddr: string | undefined,
  expectedApi: bigint,
  expectedSchema: bigint,
): Promise<boolean> {
  if (!proxyAddr || proxyAddr === ethers.ZeroAddress) return false;

  const view = await ethers.getContractAt("ViewVersioned", proxyAddr);
  let api: bigint | undefined;
  let schema: bigint | undefined;
  let impl: string | undefined;

  try {
    [api, schema, impl] = (await (view as any).getVersionInfo()) as [
      bigint,
      bigint,
      string,
    ];
  } catch {
    console.log(`⚠️ ${name} version probe failed; forcing upgrade`);
  }

  if (api === expectedApi && schema === expectedSchema) {
    console.log(
      `↪️ ${name} already at api=${api.toString()} schema=${schema.toString()}`,
    );
    return false;
  }

  const before =
    api !== undefined && schema !== undefined
      ? `api=${api.toString()} schema=${schema.toString()} impl=${impl ?? "<unknown>"}`
      : "unavailable";
  console.log(
    `🔎 ${name} version mismatch: current=${before} expected=api=${expectedApi.toString()} schema=${expectedSchema.toString()}`,
  );
  await upgradeProxy(name, proxyAddr);

  const [nextApi, nextSchema, nextImpl] = (await (
    view as any
  ).getVersionInfo()) as [bigint, bigint, string];
  if (nextApi !== expectedApi || nextSchema !== expectedSchema) {
    throw new Error(
      `${name} upgrade verification failed: api=${nextApi.toString()} schema=${nextSchema.toString()} impl=${nextImpl}`,
    );
  }
  console.log(
    `✅ ${name} version verified after upgrade: api=${nextApi.toString()} schema=${nextSchema.toString()} impl=${nextImpl}`,
  );
  return true;
}

async function ensureAcmRole(
  acm: any,
  roleUpperSnake: string,
  grantee: string | undefined,
  label: string,
): Promise<void> {
  if (!grantee || grantee === ethers.ZeroAddress) return;
  const role = ethers.keccak256(ethers.toUtf8Bytes(roleUpperSnake));
  try {
    const already = await acm.hasRole(role, grantee);
    if (already) return;
    await (await acm.grantRole(role, grantee)).wait();
    logActionTo(`🔑 Granted ${roleUpperSnake} to ${label}`, grantee);
  } catch (e) {
    console.log(`⚠️ Grant ${roleUpperSnake} to ${label} skipped/failed:`, e);
  }
}

async function ensureVaultLendingEngineHealthRoles(deployed: DeployMap) {
  if (!deployed.AccessControlManager || !deployed.VaultLendingEngine) return;

  const acm = await ethers.getContractAt(
    "AccessControlManager",
    deployed.AccessControlManager,
  );
  await ensureAcmRole(
    acm,
    "ACTION_VIEW_PUSH",
    deployed.VaultLendingEngine,
    "VaultLendingEngine",
  );
  await ensureAcmRole(
    acm,
    "VIEW_RISK_DATA",
    deployed.VaultLendingEngine,
    "VaultLendingEngine",
  );
}

async function ensureFeeRouterSupportedToken(
  feeRouterAddr: string,
  token: string,
  label: string,
) {
  if (!feeRouterAddr || feeRouterAddr === ethers.ZeroAddress) return;
  if (!token || token === ethers.ZeroAddress) return;
  const fr = await ethers.getContractAt(
    "src/Vault/FeeRouter.sol:FeeRouter",
    feeRouterAddr,
  );
  const supported: boolean = await fr.isTokenSupported(token);
  if (supported) {
    logActionTo(`↪️ FeeRouter already supports ${label}`, token);
    return;
  }
  await (await fr.addSupportedToken(token)).wait();
  logActionTo(`✅ FeeRouter added supported token (${label})`, token);
}

/**
 * Phase B (SSOT): Bind deployed module addresses into Registry.
 * - This must happen AFTER all deployments, but BEFORE any validation that depends on `getModuleOrRevert(...)`.
 */
async function phaseBBindRegistry(registry: any, deployed: DeployMap) {
  const NAME_TO_KEY: Record<string, string> = {
    RegistryDynamicModuleKey: "DYNAMIC_MODULE_REGISTRY",
    AccessControlManager: "ACCESS_CONTROL_MANAGER",
    CacheMaintenanceManager: "CACHE_MAINTENANCE_MANAGER",
    WhitelistRegistry: "WHITELIST_REGISTRY",
    AssetWhitelist: "ASSET_WHITELIST",
    AuthorityWhitelist: "AUTHORITY_WHITELIST",
    PriceOracle: "PRICE_ORACLE",
    // Code-facing name is PRICE_UPDATER; on-chain raw key remains legacy for compatibility.
    PriceUpdater: PRICE_UPDATER_REGISTRY_RAW_KEY,
    FeeRouter: "FEE_ROUTER",
    FeeRouterView: "FEE_ROUTER_VIEW",
    CrossChainGovernance: "CROSS_CHAIN_GOVERNANCE",
    GovernanceGate: "GOVERNANCE_GATE",
    FeatureRegistry: "FEATURE_REGISTRY",
    GovernanceGuardian: "GOVERNANCE_GUARDIAN",
    AICreditsVault: "AI_CREDITS_VAULT",
    RewardManagerCore: "REWARD_MANAGER_CORE",
    RewardManager: "REWARD_MANAGER",
    RewardAccrualManager: "REWARD_ACCRUAL_MANAGER",
    EarnConfig: "REWARD_EARN_CONFIG",
    CollateralManager: "COLLATERAL_MANAGER",
    // core/LendingEngine is the order engine (createLoanOrder/repay order) => KEY_ORDER_ENGINE
    LendingEngine: "ORDER_ENGINE",
    OrderStateStoreV2: "ORDER_STATE_STORE",
    LendingEngineView: "LENDING_ENGINE_VIEW",
    LoanNFTView: "LOAN_NFT_VIEW",
    VaultBusinessLogic: "VAULT_BUSINESS_LOGIC",
    VaultCore: "VAULT_CORE",
    // VaultLendingEngine implements ILendingEngineBasic (VaultCore.borrow/repay) => KEY_LE
    VaultLendingEngine: "LENDING_ENGINE",
    EarlyRepaymentGuaranteeManager: "EARLY_REPAYMENT_GUARANTEE_MANAGER",
    HealthView: "HEALTH_VIEW",
    SystemView: "SYSTEM_VIEW",
    // Canonical Registry key for StatisticsView (ModuleKeys.KEY_STATS)
    StatisticsView: "VAULT_STATISTICS",
    // Strict B+ (snapshot + single-entry orchestrator)
    StatisticsPushManager: "STATISTICS_PUSH_MANAGER",
    // Protocol flow cache (value SSOT, strict B+)
    LoanFlowView: "LOAN_FLOW_VIEW",
    LoanFlowPushManager: "LOAN_FLOW_PUSH_MANAGER",
    PositionView: "POSITION_VIEW",
    BlocksOnlyView: "BLOCKS_ONLY_VIEW",
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
    EasyToken: "EASY_TOKEN",
    EasyEmissionConfig: "EASY_EMISSION_CONFIG",
    EasyEmissionController: "EASY_EMISSION_CONTROLLER",
    EasyConsumption: "EASY_CONSUMPTION",
    EasyRecycleDistributor: "EASY_RECYCLE_DISTRIBUTOR",
    EasyStaking: "EASY_STAKING",
    ValuationOracleView: "VALUATION_ORACLE_VIEW",
    LiquidatorView: "LIQUIDATION_VIEW",
    LiquidationConfigModule: "LIQUIDATION_CONFIG_MANAGER",
    LiquidationManager: "LIQUIDATION_MANAGER",
    SettlementManager: "SETTLEMENT_MANAGER",
    LiquidationPayoutManager: "LIQUIDATION_PAYOUT_MANAGER",
    LenderPoolVault: "LENDER_POOL_VAULT",
    BlocksOnlyCoordinator: "BLOCKS_ONLY_COORDINATOR",
    GuaranteeFundManager: "GUARANTEE_FUND_MANAGER",
    LoanNFT: "LOAN_NFT",
    MockUSDC: "SETTLEMENT_TOKEN",
    LiquidationRiskManager: "LIQUIDATION_RISK_MANAGER",
    // Monitor modules
    DegradationCore: "DEGRADATION_CORE",
    // IMPORTANT (Write-path SSOT):
    // Core/Storage treat `Registry[DEGRADATION_MONITOR]` as the single-entry write coordinator.
    // Phase B MUST bind this key; otherwise DegradationMonitor won't be recognized and writes may be role-blocked.
    DegradationMonitor: "DEGRADATION_MONITOR",
    DegradationStorage: "DEGRADATION_STORAGE",
    ModuleHealthView: "MODULE_HEALTH_VIEW",
    BatchView: "BATCH_VIEW",
    LiquidationRiskView: "LIQUIDATION_RISK_VIEW",
  };

  // Actual module list to bind (only bind those that are deployed).
  const modules = [
    "AccessControlManager",
    "CacheMaintenanceManager",
    "WhitelistRegistry",
    "AssetWhitelist",
    "AuthorityWhitelist",
    "PriceOracle",
    "PriceUpdater",
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
    "BlocksOnlyCoordinator",
    "FeeRouter",
    "FeeRouterView",
    "CollateralManager",
    "LendingEngine",
    "OrderStateStoreV2",
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
    "BlocksOnlyView",
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
    "CrossChainGovernance",
    "GovernanceGate",
    "FeatureRegistry",
    "GovernanceGuardian",
    "AICreditsVault",
    "RewardManagerCore",
    "RewardManager",
    "RewardAccrualManager",
    "EarnConfig",
    "RewardView",
    "RewardConfig",
    "EasyToken",
    "EasyEmissionConfig",
    "EasyEmissionController",
    "EasyConsumption",
    "EasyRecycleDistributor",
    "EasyStaking",
    "ValuationOracleView",
    "LiquidatorView",
    "LiquidationConfigModule",
    "GuaranteeFundManager",
    "LoanNFT",
    "MockUSDC",
    "RegistryDynamicModuleKey",
    "LiquidationRiskManager",
  ];

  // SSOT: single pass registry binding (only logs on change)
  let registryChanged = 0;
  let registryUnchanged = 0;
  for (const name of modules) {
    const addr = deployed[name];
    if (!addr) continue;
    const upperSnake = NAME_TO_KEY[name];
    if (!upperSnake) continue;
    const { changed } = await bindRegistryModule(registry, upperSnake, addr, {
      label: registryLabel(upperSnake),
    });
    if (changed) registryChanged += 1;
    else registryUnchanged += 1;
  }

  console.log(
    `🧾 Registry binding summary: changed=${registryChanged}, unchanged=${registryUnchanged}`,
  );

  // Bind the dynamic module key registry into Registry (best-effort).
  if (deployed.RegistryDynamicModuleKey) {
    try {
      await (
        await registry.setDynamicModuleKeyRegistry(
          deployed.RegistryDynamicModuleKey,
        )
      ).wait();
      console.log("✅ Dynamic module key registry set in Registry");
    } catch (error) {
      console.log("⚠️ Failed to set dynamic module key registry:", error);
    }
  }
}

/**
 * Phase C: Validate architecture invariants and write outputs (frontend config, summary).
 */
async function phaseCValidateAndWriteOutputs(
  registry: any,
  deployed: DeployMap,
) {
  // Architecture invariant:
  // - View address must be resolved via KEY_VAULT_CORE -> viewContractAddrVar()
  // - Avoid binding/depending on extra keys like VAULT_VIEW to prevent multi-source drift.
  try {
    await ensureVaultRouterFeeRouterViewBinding(deployed);

    if (!deployed.VaultCore || !deployed.VaultRouter)
      throw new Error("Missing VaultCore or VaultRouter address");

    const code = await ethers.provider.getCode(deployed.VaultCore);
    console.log("🔎 VaultCore code check");
    logActionTo("   address", deployed.VaultCore);
    console.log(`   codeLen = ${code.length}`);
    if (!code || code === "0x")
      throw new Error("VaultCore address has no code");

    const vaultCore = await ethers.getContractAt(
      "VaultCore",
      deployed.VaultCore,
    );
    const viewAddr = await vaultCore.viewContractAddrVar();
    if (!viewAddr || viewAddr === ethers.ZeroAddress) {
      throw new Error("VaultCore.viewContractAddrVar() is zero");
    }
    if (viewAddr.toLowerCase() !== deployed.VaultRouter.toLowerCase()) {
      throw new Error(
        `VaultCore.viewContractAddrVar mismatch: core=${viewAddr} expected VaultRouter=${deployed.VaultRouter}`,
      );
    }
    if (deployed.FeeRouterView) {
      const vaultRouter = await ethers.getContractAt(
        ["function feeRouterViewAddrVar() view returns (address)"],
        viewAddr,
      );
      const feeRouterViewAddr = (await vaultRouter.feeRouterViewAddrVar()) as string;
      if (!feeRouterViewAddr || feeRouterViewAddr === ethers.ZeroAddress) {
        throw new Error("VaultRouter.feeRouterViewAddrVar() is zero");
      }
      if (feeRouterViewAddr.toLowerCase() !== deployed.FeeRouterView.toLowerCase()) {
        throw new Error(
          `VaultRouter.feeRouterViewAddrVar mismatch: router=${feeRouterViewAddr} expected FeeRouterView=${deployed.FeeRouterView}`,
        );
      }
      console.log(
        "✅ Architecture check: VaultRouter.feeRouterViewAddrVar matches deployed FeeRouterView",
      );
    }
    console.log(
      "✅ Architecture check: VaultCore.viewContractAddrVar matches deployed VaultRouter",
    );
  } catch (e) {
    console.log("❌ Architecture check failed:", e);
    throw e;
  }

  // Before writing frontend config, initialize PositionView (if not initialized yet).
  try {
    if (deployed.PositionView) {
      const pv = await ethers.getContractAt(
        "PositionView",
        deployed.PositionView,
      );
      let regAddr = ethers.ZeroAddress;
      try {
        regAddr = await pv.getRegistry();
      } catch (_) {
        /* ignore */
      }
      if (regAddr === ethers.ZeroAddress) {
        console.log("🔧 Initializing PositionView...");
        await (await pv.initialize(deployed.Registry)).wait();
        logActionTo(
          "✅ PositionView initialized with registry",
          deployed.Registry,
        );
      }
    }
  } catch (error) {
    console.log(
      "⚠️ PositionView initialization after module registration failed:",
      error,
    );
  }

  fs.mkdirSync(FRONTEND_DIR, { recursive: true });
  const frontendContent = `// 自动生成的合约配置文件 - Localhost
// Auto-generated contract configuration file - Localhost
// 生成时间 Generated at: ${new Date().toISOString()}
//
// Naming:
// - OrderEngine = core/LendingEngine (Registry KEY_ORDER_ENGINE)
// - VaultLendingEngine = debt ledger engine (Registry KEY_LE)
// - LendingEngine is a legacy alias of OrderEngine (kept for backward compatibility)

export const CONTRACT_ADDRESSES = {
  ${Object.entries(deployed)
    .map(([k, v]) => `  ${k}: '${v}'`)
    .join(",\n")}
};

export const NETWORK_CONFIG = {
  chainId: 1337,
  rpcUrl: '${LOCALHOST_RPC_URL}',
  explorer: '${LOCALHOST_RPC_URL}',
  name: 'localhost'
};

// 使用示例 Usage example:
// import { CONTRACT_ADDRESSES, NETWORK_CONFIG } from './contracts-localhost';
// const vaultCoreAddress = CONTRACT_ADDRESSES.VaultCore;
`;
  fs.writeFileSync(FRONTEND_FILE, frontendContent);
  logActionTo("📝 Frontend config written", FRONTEND_FILE);

  // Output summary.
  console.log("\n==== Deployment Addresses (localhost) ====");
  Object.entries(deployed).forEach(([n, a]) => console.log(`${n}: ${a}`));
  console.log("========================================\n");
}

async function main() {
  console.log(`Network: ${network.name}`);
  // 本地网络预清理：清空 Hardhat 缓存/构建产物与旧的前端地址文件，保证每次干净部署
  if (network.name === "localhost") {
    try {
      await hre.run("clean");
      console.log("🧼 Hardhat clean executed (artifacts/cache cleared)");
    } catch (e) {
      console.log("⚠️ Hardhat clean skipped:", e);
    }
    try {
      if (fs.existsSync(FRONTEND_FILE)) {
        fs.unlinkSync(FRONTEND_FILE);
        console.log("🧹 Removed previous frontend config file");
      }
    } catch (e) {
      console.log("⚠️ Frontend config cleanup skipped:", e);
    }
  }
  // 确保 artifacts 可用：在脚本开始时编译（适配 CI/冷启动）
  try {
    await hre.run("compile");
  } catch (e) {
    console.log("⚠️ Compile step failed or skipped:", e);
  }
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const deployed: DeployMap = load();
  // 本地网络：每次启动都从干净状态部署，避免使用残留地址
  if (network.name === "localhost") {
    try {
      if (fs.existsSync(DEPLOY_FILE)) fs.unlinkSync(DEPLOY_FILE);
    } catch (err) {
      console.log("⚠️ Failed to remove previous deployment file:", err);
    }
    for (const k of Object.keys(deployed))
      delete (deployed as Record<string, unknown>)[k];
    save(deployed);
    console.log("🧹 Localhost mode: cleared previous deployments");
  }
  // 清理不再部署的残留（如历史 JSON 中的 RWAToken）
  const residuals = ["RWAToken"];
  for (const key of residuals) {
    if ((deployed as Record<string, unknown>)[key]) {
      delete (deployed as Record<string, unknown>)[key];
      save(deployed);
      console.log(`🧹 Removed residual from deployments: ${key}`);
    }
  }

  // ===================== Phase A: Deploy & Init =====================
  // Keep deploy/init side-effects grouped. Do NOT rely on full Registry key bindings here (that's Phase B).
  const phaseADeployAndInit = async () => {
    // 1) 部署 Registry（Scheme A：单一入口，Registry 本身提供 setModule）
    // 建议最小延迟 1 小时（本地可设为 ~60 blocks 方便调试）
    const MIN_DELAY_BLOCKS = 60; // blocks (local dev)
    const MAX_DELAY_BLOCKS = 302_400; // explicit blocks cap (Strategy A)

    await deployRegistryStack({
      ethers,
      deployed,
      save,
      deployProxy,
      config: {
        minDelayBlocks: MIN_DELAY_BLOCKS,
        maxDelayBlocks: MAX_DELAY_BLOCKS,
        initialOwner: deployer.address,
        upgradeAdmin: deployer.address,
        emergencyAdmin: deployer.address,
        deployerAddress: deployer.address,
        deployDynamicModuleKeyRegistry: true,
      },
    });

    // 2) 部署核心/视图/账本与支撑模块
    if (!deployed.AccessControlManager) {
      // 非升级合约（构造函数接收 owner）
      deployed.AccessControlManager = await deployRegular(
        "AccessControlManager",
        deployer.address,
      );
      save(deployed);
    }
    // IMPORTANT (SSOT): bind AccessControlManager to Registry early.
    // Many modules (e.g. FeeRouter) resolve permissions via Registry[KEY_ACCESS_CONTROL] and will revert if missing.
    try {
      const registry = await ethers.getContractAt(
        "Registry",
        deployed.Registry,
      );
      await bindRegistryModule(
        registry,
        "ACCESS_CONTROL_MANAGER",
        deployed.AccessControlManager,
        { label: "KEY_ACCESS_CONTROL" },
      );
    } catch (e) {
      console.log("⚠️ Early bind KEY_ACCESS_CONTROL skipped/failed:", e);
    }

    // 2.1) 统一缓存维护器（A 类模块地址缓存：统一刷新入口）
    // - 非升级合约（constructor 接收 Registry 地址）
    // - Registry 将以 KEY_CACHE_MAINTENANCE_MANAGER 指向该合约
    // - 目标合约侧 refreshModuleCache() 将严格校验 msg.sender == Registry[KEY_CACHE_MAINTENANCE_MANAGER]
    if (!deployed.CacheMaintenanceManager) {
      try {
        deployed.CacheMaintenanceManager = await deployRegular(
          "src/registry/CacheMaintenanceManager.sol:CacheMaintenanceManager",
          deployed.Registry,
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ CacheMaintenanceManager deployment failed:", error);
      }
    }

    // Payout recipients（可用占位地址，默认 deployer；若部署了 LenderPoolVault 且未显式指定 PAYOUT_LENDER_ADDR，将自动指向资金池）
    let payoutRecipients = {
      platform: process.env.PAYOUT_PLATFORM_ADDR || deployer.address,
      reserve: process.env.PAYOUT_RESERVE_ADDR || deployer.address,
      lenderCompensation: process.env.PAYOUT_LENDER_ADDR || deployer.address,
    };
    const payoutRates = [
      DEFAULT_PAYOUT_BPS.platform,
      DEFAULT_PAYOUT_BPS.reserve,
      DEFAULT_PAYOUT_BPS.lender,
      DEFAULT_PAYOUT_BPS.liquidator,
    ];

    // 为本地管理员赋权：ADMIN + 只读（VIEW_*）权限，满足 onlyUserOrStrictAdmin / onlyAuthorizedFor 检查
    try {
      const acm = await ethers.getContractAt(
        "AccessControlManager",
        deployed.AccessControlManager,
      );
      const adminAddress = process.env.LOCAL_ADMIN_ADDRESS || deployer.address;

      const roleNames = [
        "ACTION_ADMIN",
        // 本地可配置参数（用于 setTestingMode / StatisticsView.pushUserStatsUpdate 等）
        "SET_PARAMETER",
        // 本地 keeper / strict smoke 预检
        "LIQUIDATE",
        // Easy ops: API call consumption
        "CONSUME_EASY",
        // 运维/重试入口（Strict B+）
        "ACTION_VIEW_PUSH",
        // 读权限（全量覆盖）
        "VIEW_SYSTEM_DATA",
        "VIEW_USER_DATA",
        "VIEW_DEGRADATION_DATA",
        "VIEW_CACHE_DATA",
        "VIEW_PRICE_DATA",
        "VIEW_RISK_DATA",
        "VIEW_LIQUIDATION_DATA",
        "ADD_WHITELIST",
        "REMOVE_WHITELIST",
        // 可选：查询管理
        "QUERY_MANAGER",
      ];
      for (const r of roleNames) {
        const role = ethers.keccak256(ethers.toUtf8Bytes(r));
        try {
          // 先检查，避免 AccessControlManager__RoleAlreadyGranted() 回退
          const already = await acm.hasRole(role, adminAddress);
          if (already) {
            continue;
          }
          await (await acm.grantRole(role, adminAddress)).wait();
          logActionTo(`🔑 Granted ${r} to`, adminAddress);
        } catch (e) {
          // 角色已存在会 revert: AccessControlManager__RoleAlreadyGranted()，忽略
          console.log(`⚠️ Role ${r} grant skipped/failed:`, e);
        }
      }
      console.log(
        "🔐 AccessControlManager: local admin granted ADMIN + read-only roles",
      );
    } catch (e) {
      console.log("⚠️ AccessControlManager grant roles skipped:", e);
    }

    if (!deployed.AssetWhitelist) {
      deployed.AssetWhitelist = await deployProxy("AssetWhitelist", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    if (!deployed.WhitelistRegistry) {
      deployed.WhitelistRegistry = await deployProxy("WhitelistRegistry", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    if (!deployed.AuthorityWhitelist) {
      deployed.AuthorityWhitelist = await deployProxy("AuthorityWhitelist", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    if (!deployed.PriceOracle) {
      deployed.PriceOracle = await deployProxy("PriceOracle", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    if (!deployed.PriceUpdater) {
      deployed.PriceUpdater = await deployProxy(
        "PriceUpdater",
        [deployed.Registry],
      );
      save(deployed);
    }

    if (!deployed.FeeRouter) {
      // platformBps / ecoBps：30 (=0.30%), 0 (=0.00%)
      deployed.FeeRouter = await deployProxy(
        "src/Vault/FeeRouter.sol:FeeRouter",
        [deployed.Registry, deployer.address, deployer.address, 30, 0],
      );
      save(deployed);
    }

    // 代币（Settlement）
    if (!deployed.MockUSDC) {
      // SSOT (Architecture-Guide): use a USDC-like token with 6 decimals on localhost.
      const usdcDecimals = 6;
      const billion = ethers.parseUnits("1000000000", usdcDecimals);
      deployed.MockUSDC = await deployRegular(
        "MockERC20",
        "USDC",
        "USDC",
        usdcDecimals,
        billion,
      );
      save(deployed);
    }

    // FeeRouter 必须显式支持 settlementToken，否则分发会 TokenNotSupported（Architecture-Guide SSOT）
    await ensureFeeRouterSupportedToken(
      deployed.FeeRouter,
      deployed.MockUSDC,
      "MockUSDC/settlementToken",
    );

    if (!deployed.VaultBusinessLogic) {
      deployed.VaultBusinessLogic = await deployProxy("VaultBusinessLogic", [
        deployed.Registry,
        deployed.MockUSDC,
      ]);
      save(deployed);
    }

    // 部署 VaultRouter（View / Router 协调器）
    // 按 Architecture-Guide：View 地址应通过 KEY_VAULT_CORE → viewContractAddrVar() 解析，因此 VaultCore 初始化时必须拿到最终 VaultRouter 地址。
    if (!deployed.VaultRouter) {
      console.log("🚀 Deploying VaultRouter...");
      deployed.VaultRouter = await deployProxy(
        "src/Vault/VaultRouter.sol:VaultRouter",
        [
          deployed.Registry,
          deployed.AssetWhitelist,
          deployed.PriceOracle,
          deployed.MockUSDC, // settlement token
          deployer.address, // owner (UUPS)
        ],
        {},
      );
      save(deployed);
      // NOTE: deployProxy already printed the deployed address; keep this log semantically distinct.
      console.log("✅ VaultRouter ready");
    }

    // 给 VaultRouter 授权 SET_PARAMETER：用于在业务路径内 best-effort 推送 StatisticsView（pushUserStatsUpdate）
    // 以及本地脚本中可能调用的 setTestingMode 等能力。
    try {
      const acm = await ethers.getContractAt(
        "AccessControlManager",
        deployed.AccessControlManager,
      );
      const SET_PARAMETER = ethers.keccak256(
        ethers.toUtf8Bytes("SET_PARAMETER"),
      );
      await (await acm.grantRole(SET_PARAMETER, deployed.VaultRouter)).wait();
      console.log("🔑 Granted SET_PARAMETER to VaultRouter");
    } catch (e) {
      console.log("⚠️ Grant SET_PARAMETER to VaultRouter skipped:", e);
    }

    // 给 VaultRouter 授权 ACTION_VIEW_PUSH：PositionView/HealthView 等 View Push API 需要该角色
    // （VaultRouter 是 View 推送的统一转发点：VaultCore → VaultRouter → PositionView/…）
    try {
      const acm = await ethers.getContractAt(
        "AccessControlManager",
        deployed.AccessControlManager,
      );
      const ACTION_VIEW_PUSH = ethers.keccak256(
        ethers.toUtf8Bytes("ACTION_VIEW_PUSH"),
      );
      await (
        await acm.grantRole(ACTION_VIEW_PUSH, deployed.VaultRouter)
      ).wait();
      console.log("🔑 Granted ACTION_VIEW_PUSH to VaultRouter");
    } catch (e) {
      console.log("⚠️ Grant ACTION_VIEW_PUSH to VaultRouter skipped:", e);
    }

    if (!deployed.VaultCore) {
      // VaultCore.initialize(registry, view)
      deployed.VaultCore = await deployProxy("VaultCore", [
        deployed.Registry,
        deployed.VaultRouter,
      ]);
      save(deployed);
    }

    // 确认 VaultCore 地址有效（本地链重启后旧地址可能无代码），无代码则自动重部署
    try {
      if (deployed.VaultCore) {
        const vcoreCode = await ethers.provider.getCode(deployed.VaultCore);
        if (!vcoreCode || vcoreCode === "0x") {
          console.log(
            "⚠️ Detected empty code at VaultCore address, re-deploying VaultCore...",
          );
          deployed.VaultCore = await deployProxy("VaultCore", [
            deployed.Registry,
            deployed.VaultRouter,
          ]);
          save(deployed);
          console.log("✅ VaultCore re-deployed @", deployed.VaultCore);
        }
      }
    } catch (err) {
      console.log("⚠️ VaultCore code check failed:", err);
    }

    // CollateralManager（CM）
    if (!deployed.CollateralManager) {
      // CollateralManager has legacy overloaded initializer; disambiguate for OZ upgrades.
      deployed.CollateralManager = await deployProxy(
        "CollateralManager",
        [deployed.Registry],
        { initializer: "initialize(address)" },
      );
      save(deployed);
    }

    // OrderEngine（订单引擎，SSOT: src/core/LendingEngine.sol, Registry KEY_ORDER_ENGINE）
    // NOTE: `LendingEngine` is a legacy alias kept for backward compatibility in configs/scripts.
    {
      const existingOrderEngine =
        deployed.OrderEngine ?? deployed.LendingEngine;
      if (!existingOrderEngine) {
        const addr = await deployProxy(
          "src/core/LendingEngine.sol:LendingEngine",
          [deployed.Registry],
        );
        deployed.OrderEngine = addr;
        deployed.LendingEngine = addr; // legacy alias
        save(deployed);
      } else {
        // Normalize: ensure both keys exist and point to the same address.
        deployed.OrderEngine = existingOrderEngine;
        deployed.LendingEngine = existingOrderEngine;
        save(deployed);
      }
    }

    // VaultLendingEngine（Vault借贷引擎）
    if (!deployed.VaultLendingEngine) {
      try {
        deployed.VaultLendingEngine = await deployProxy(
          "src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine",
          [deployed.PriceOracle, deployed.MockUSDC, deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ VaultLendingEngine deployment failed:", error);
      }
    }

    // EarlyRepaymentGuaranteeManager（提前还款保证金管理器）
    if (!deployed.EarlyRepaymentGuaranteeManager) {
      try {
        // NOTE: ERGM initializer signature (SSOT-aligned) is:
        //   initialize(registryAddr, platformFeeReceiverAddr, platformFeeRateBps)
        deployed.EarlyRepaymentGuaranteeManager = await deployProxy(
          "src/Vault/modules/EarlyRepaymentGuaranteeManager.sol:EarlyRepaymentGuaranteeManager",
          [deployed.Registry, deployer.address, 500],
        ); // 5% 平台费率
        save(deployed);
      } catch (error) {
        console.log(
          "⚠️ EarlyRepaymentGuaranteeManager deployment failed:",
          error,
        );
      }
    }

    // ====== View 层（全面）======
    // HealthView（可选但前端会优先尝试，存在更佳）
    if (!deployed.HealthView) {
      try {
        deployed.HealthView = await deployProxy("HealthView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch {
        // 模块缺失不阻断部署
      }
    }

    // LiquidationConfigModule（清算配置模块，方案B：阈值/最小健康因子 SSOT）
    // - 作为 KEY_LIQUIDATION_CONFIG_MANAGER 的权威实现
    // - RiskManager 会 best-effort 读取该模块作为阈值 SSOT；写路径将通过该模块保留原始 caller 的 role 校验语义
    if (!deployed.LiquidationConfigModule) {
      try {
        deployed.LiquidationConfigModule = await deployProxy(
          "src/Vault/liquidation/modules/LiquidationConfigModule.sol:LiquidationConfigModule",
          [deployed.Registry, deployed.AccessControlManager],
        );
        save(deployed);
        // NOTE: deployProxy already printed the deployed address; keep this log semantically distinct.
        console.log("✅ LiquidationConfigModule ready");
      } catch (error) {
        console.log("⚠️ LiquidationConfigModule deployment failed:", error);
      }
    }

    // LiquidationRiskManager（清算风险管理器）
    // NOTE:
    // LiquidationRiskManager.initialize() 会在初始化阶段 _primeCoreModules()：
    //  - KEY_CM
    //  - KEY_LE
    //  - (optional) KEY_POSITION_VIEW
    //  - KEY_HEALTH_VIEW
    // 因此必须在部署前先把上述模块键绑定到 Registry，否则会因 MissingModule(KEY_*) 回滚。
    if (!deployed.LiquidationRiskManager) {
      try {
        const registry = await ethers.getContractAt(
          "Registry",
          deployed.Registry,
        );

        // 最小前置绑定（不依赖后续“统一注册模块”步骤）
        // NOTE: LiquidationRiskManager.initialize() will prime these modules and revert if missing.
        await bindRegistryModule(
          registry,
          "COLLATERAL_MANAGER",
          deployed.CollateralManager,
        );
        await bindRegistryModule(
          registry,
          "LENDING_ENGINE",
          deployed.VaultLendingEngine,
        );
        await bindRegistryModule(registry, "HEALTH_VIEW", deployed.HealthView);
        // Optional (Option B): ConfigManager SSOT for thresholds
        await bindRegistryModule(
          registry,
          "LIQUIDATION_CONFIG_MANAGER",
          deployed.LiquidationConfigModule,
        );

        const initialMaxCacheDuration = 300; // 5分钟
        const initialMaxBatchSize = 50;
        // 重要：LiquidationRiskLib / LiquidationRiskBatchLib 已改为纯 internal 库（不再外部链接），
        // 因此这里不再部署/链接 library，避免 OZ Upgrades error-006。
        deployed.LiquidationRiskManager = await deployProxy(
          "src/Vault/liquidation/modules/LiquidationRiskManager.sol:LiquidationRiskManager",
          [
            deployed.Registry,
            deployed.AccessControlManager,
            initialMaxCacheDuration,
            initialMaxBatchSize,
          ],
        );
        save(deployed);
        // NOTE: deployProxy already printed the deployed address; keep this log semantically distinct.
        console.log("✅ LiquidationRiskManager ready");
      } catch (error) {
        console.log("⚠️ LiquidationRiskManager deployment failed:", error);
      }
    }

    // SystemView / StatisticsView / PositionView / PreviewView / DashboardView / UserView
    // SystemView：系统级只读聚合门面（与 docs/Architecture-Guide.md 对齐）
    if (!deployed.SystemView) {
      try {
        deployed.SystemView = await deployProxy("SystemView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ SystemView deployment failed:", error);
      }
    }
    // 授予 SystemView 只读权限（SystemView 调用其他模块时 msg.sender 为合约自身）
    try {
      if (deployed.SystemView && deployed.AccessControlManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
        const VIEW_SYSTEM_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_SYSTEM_DATA"),
        );
        await (
          await acm.grantRole(VIEW_SYSTEM_DATA, deployed.SystemView)
        ).wait();
        console.log("🔑 Granted VIEW_SYSTEM_DATA to SystemView");
      }
    } catch (e) {
      console.log("⚠️ Grant VIEW_SYSTEM_DATA to SystemView skipped:", e);
    }
    if (!deployed.RegistryView) {
      try {
        deployed.RegistryView = await deployProxy(
          "src/Vault/view/modules/RegistryView.sol:RegistryView",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ RegistryView deployment failed:", error);
      }
    }

    if (!deployed.StatisticsView) {
      try {
        deployed.StatisticsView = await deployProxy("StatisticsView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ StatisticsView deployment failed:", error);
      }
    }

    // Strict B+ (snapshot + single-entry orchestrator): StatisticsPushManager
    if (!deployed.StatisticsPushManager) {
      try {
        deployed.StatisticsPushManager = await deployProxy(
          "src/Vault/modules/StatisticsPushManager.sol:StatisticsPushManager",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ StatisticsPushManager deployment failed:", error);
      }
    }

    // Grant required read roles to StatisticsPushManager (strict B+ snapshot orchestrator).
    // - VIEW_PRICE_DATA: needed to read PositionView value valuations.
    // - VIEW_SYSTEM_DATA: kept for backward compatibility with older helpers/scripts (not strictly required by Scheme B).
    try {
      if (deployed.StatisticsPushManager && deployed.AccessControlManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
        const VIEW_SYSTEM_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_SYSTEM_DATA"),
        );
        const VIEW_PRICE_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_PRICE_DATA"),
        );
        const VIEW_RISK_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_RISK_DATA"),
        );
        const already = await acm.hasRole(
          VIEW_SYSTEM_DATA,
          deployed.StatisticsPushManager,
        );
        if (!already) {
          await (
            await acm.grantRole(
              VIEW_SYSTEM_DATA,
              deployed.StatisticsPushManager,
            )
          ).wait();
          console.log("🔑 Granted VIEW_SYSTEM_DATA to StatisticsPushManager");
        } else {
          console.log(
            "✅ StatisticsPushManager has VIEW_SYSTEM_DATA (verified)",
          );
        }

        const alreadyPrice = await acm.hasRole(
          VIEW_PRICE_DATA,
          deployed.StatisticsPushManager,
        );
        if (!alreadyPrice) {
          await (
            await acm.grantRole(VIEW_PRICE_DATA, deployed.StatisticsPushManager)
          ).wait();
          console.log("🔑 Granted VIEW_PRICE_DATA to StatisticsPushManager");
        } else {
          console.log(
            "✅ StatisticsPushManager has VIEW_PRICE_DATA (verified)",
          );
        }

        const alreadyRisk = await acm.hasRole(
          VIEW_RISK_DATA,
          deployed.StatisticsPushManager,
        );
        if (!alreadyRisk) {
          await (
            await acm.grantRole(VIEW_RISK_DATA, deployed.StatisticsPushManager)
          ).wait();
          console.log("🔑 Granted VIEW_RISK_DATA to StatisticsPushManager");
        } else {
          console.log("✅ StatisticsPushManager has VIEW_RISK_DATA (verified)");
        }
      }
    } catch (e) {
      console.log("⚠️ Grant roles to StatisticsPushManager skipped/failed:", e);
    }

    // Strict B+ protocol flow cache: LoanFlowView + LoanFlowPushManager (value SSOT)
    // - LendingEngine best-effort notifies LoanFlowPushManager on borrow/repay.
    // - RewardManagerCore best-effort reads LoanFlowView for user level auto-upgrades.
    if (!deployed.LoanFlowView) {
      try {
        deployed.LoanFlowView = await deployProxy(
          "src/Vault/view/modules/LoanFlowView.sol:LoanFlowView",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ LoanFlowView deployment failed:", error);
      }
    }
    if (!deployed.LoanFlowPushManager) {
      try {
        deployed.LoanFlowPushManager = await deployProxy(
          "src/Vault/modules/LoanFlowPushManager.sol:LoanFlowPushManager",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ LoanFlowPushManager deployment failed:", error);
      }
    }
    if (!deployed.PositionView) {
      try {
        deployed.PositionView = await deployProxy(
          "src/Vault/view/modules/PositionView.sol:PositionView",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ PositionView deployment failed:", error);
      }
    }
    if (!deployed.PreviewView) {
      try {
        deployed.PreviewView = await deployProxy("PreviewView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ PreviewView deployment failed:", error);
      }
    }
    if (!deployed.DashboardView) {
      try {
        deployed.DashboardView = await deployProxy("DashboardView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ DashboardView deployment failed:", error);
      }
    }
    if (!deployed.UserView) {
      try {
        deployed.UserView = await deployProxy("UserView", [deployed.Registry]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ UserView deployment failed:", error);
      }
    }

    // 其它 View 与工具视图
    if (!deployed.AccessControlView) {
      try {
        deployed.AccessControlView = await deployProxy("AccessControlView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ AccessControlView deployment failed:", error);
      }
    }
    if (!deployed.CacheOptimizedView) {
      try {
        deployed.CacheOptimizedView = await deployProxy("CacheOptimizedView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ CacheOptimizedView deployment failed:", error);
      }
    }
    if (!deployed.LendingEngineView) {
      try {
        deployed.LendingEngineView = await deployProxy("LendingEngineView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ LendingEngineView deployment failed:", error);
      }
    }
    if (!deployed.LoanNFTView) {
      try {
        deployed.LoanNFTView = await deployProxy("LoanNFTView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ LoanNFTView deployment failed:", error);
      }
    }
    if (!deployed.BlocksOnlyView) {
      try {
        deployed.BlocksOnlyView = await deployProxy("BlocksOnlyView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ BlocksOnlyView deployment failed:", error);
      }
    }
    if (!deployed.FeeRouterView) {
      try {
        deployed.FeeRouterView = await deployProxy("FeeRouterView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ FeeRouterView deployment failed:", error);
      }
    }
    if (!deployed.RiskView) {
      try {
        deployed.RiskView = await deployProxy("RiskView", [deployed.Registry]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ RiskView deployment failed:", error);
      }
    }
    if (!deployed.SystemRiskView) {
      try {
        deployed.SystemRiskView = await deployProxy("SystemRiskView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ SystemRiskView deployment failed:", error);
      }
    }
    if (!deployed.ViewCache) {
      try {
        deployed.ViewCache = await deployProxy("ViewCache", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ ViewCache deployment failed:", error);
      }
    }
    if (!deployed.EventHistoryManager) {
      try {
        deployed.EventHistoryManager = await deployProxy(
          "EventHistoryManager",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ EventHistoryManager deployment failed:", error);
      }
    }
    // 估值视图（可选）
    if (!deployed.ValuationOracleView) {
      try {
        deployed.ValuationOracleView = await deployProxy(
          "ValuationOracleView",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ ValuationOracleView deployment failed:", error);
      }
    }

    // LiquidationRiskView（清算风险只读视图）
    if (!deployed.LiquidationRiskView) {
      try {
        // 同上：LiquidationRiskLib 已为 internal 库，无需链接
        deployed.LiquidationRiskView = await deployProxy(
          "src/Vault/view/modules/LiquidationRiskView.sol:LiquidationRiskView",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ LiquidationRiskView deployment failed:", error);
      }
    }

    // ====== 监控模块 ======
    // 第一步：部署不依赖其他监控模块的基础模块
    if (!deployed.DegradationCore) {
      try {
        deployed.DegradationCore = await deployProxy(
          "src/monitor/DegradationCore.sol:DegradationCore",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ DegradationCore deployment failed:", error);
      }
    }

    if (!deployed.DegradationStorage) {
      try {
        deployed.DegradationStorage = await deployProxy(
          "src/monitor/DegradationStorage.sol:DegradationStorage",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ DegradationStorage deployment failed:", error);
      }
    }

    if (!deployed.ModuleHealthView) {
      try {
        deployed.ModuleHealthView = await deployProxy(
          "src/Vault/view/modules/ModuleHealthView.sol:ModuleHealthView",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ ModuleHealthView deployment failed:", error);
      }
    }

    // 第二步：部署依赖其他监控模块的 DegradationMonitor
    if (
      !deployed.DegradationMonitor &&
      deployed.DegradationCore &&
      deployed.DegradationStorage &&
      deployed.ModuleHealthView
    ) {
      try {
        const upgradeWindowBlocks =
          Number(process.env.DEGRADATION_UPGRADE_WINDOW_BLOCKS || "1800") ||
          1800;
        deployed.DegradationMonitor = await deployProxy(
          "src/monitor/DegradationMonitor.sol:DegradationMonitor",
          [
            deployed.Registry,
            deployer.address,
            deployed.DegradationCore,
            deployed.DegradationStorage,
            deployed.ModuleHealthView,
            ethers.ZeroAddress, // analytics module removed; keep unset (best-effort)
            deployer.address, // placeholder admin module addr (interface is empty; backward-compat)
            upgradeWindowBlocks,
          ],
        );
        save(deployed);
        // NOTE: deployProxy already printed the deployed address; keep this log semantically distinct.
        console.log("✅ DegradationMonitor ready");
      } catch (error) {
        console.log("⚠️ DegradationMonitor deployment failed:", error);
      }
    }

    // BatchView（批量视图）
    if (!deployed.BatchView) {
      try {
        deployed.BatchView = await deployProxy(
          "src/Vault/view/modules/BatchView.sol:BatchView",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ BatchView deployment failed:", error);
      }
    }

    // 为“只读聚合器 ↔ 专属 View”权限一致性提供支撑（部署后补齐）：
    // 当下游专属 View 引入只读权限检查时，聚合器/适配层合约地址也必须具备对应 view 角色，否则模块间调用会被误拦。
    // 注意：聚合器仍会对外部 caller 做权限校验；这里仅用于模块间内部调用通过。
    try {
      const acm = await ethers.getContractAt(
        "AccessControlManager",
        deployed.AccessControlManager,
      );
      const grants: Array<{ role: string; to?: string; label: string }> = [
        // BatchView calls HealthView (public) / RiskView (Scheme U) / ValuationOracleView
        { role: "VIEW_USER_DATA", to: deployed.BatchView, label: "BatchView" },
        { role: "VIEW_PRICE_DATA", to: deployed.BatchView, label: "BatchView" },
        {
          role: "ACTION_VIEW_SYSTEM_STATUS",
          to: deployed.BatchView,
          label: "BatchView",
        },

        // Dashboard/CacheOptimized call PositionView + HealthView + (Dashboard also reads prices)
        {
          role: "VIEW_USER_DATA",
          to: deployed.DashboardView,
          label: "DashboardView",
        },
        {
          role: "VIEW_RISK_DATA",
          to: deployed.DashboardView,
          label: "DashboardView",
        },
        {
          role: "VIEW_PRICE_DATA",
          to: deployed.DashboardView,
          label: "DashboardView",
        },

        {
          role: "VIEW_USER_DATA",
          to: deployed.CacheOptimizedView,
          label: "CacheOptimizedView",
        },
        {
          role: "VIEW_RISK_DATA",
          to: deployed.CacheOptimizedView,
          label: "CacheOptimizedView",
        },
        {
          role: "VIEW_SYSTEM_DATA",
          to: deployed.CacheOptimizedView,
          label: "CacheOptimizedView",
        },

        // UserView internally calls multiple view modules (positions + health + stats)
        { role: "VIEW_USER_DATA", to: deployed.UserView, label: "UserView" },
        { role: "VIEW_RISK_DATA", to: deployed.UserView, label: "UserView" },
        { role: "VIEW_SYSTEM_DATA", to: deployed.UserView, label: "UserView" },

        // RiskView internally calls PositionView valuation (Scheme U)
        { role: "VIEW_USER_DATA", to: deployed.RiskView, label: "RiskView" },

        // PreviewView internally calls PositionView for user positions
        {
          role: "VIEW_USER_DATA",
          to: deployed.PreviewView,
          label: "PreviewView",
        },
        // PreviewView also calls SystemRiskView (minHF/maxLTV) for previews.
        {
          role: "VIEW_RISK_DATA",
          to: deployed.PreviewView,
          label: "PreviewView",
        },

        // HealthView calls SystemRiskView (minHealthFactor) during best-effort liquidation checks.
        {
          role: "VIEW_RISK_DATA",
          to: deployed.HealthView,
          label: "HealthView",
        },

        // LendingEngineView calls ORDER_ENGINE view-adapter methods (order/user data + ops diagnostics)
        {
          role: "VIEW_USER_DATA",
          to: deployed.LendingEngineView,
          label: "LendingEngineView",
        },
        {
          role: "VIEW_SYSTEM_DATA",
          to: deployed.LendingEngineView,
          label: "LendingEngineView",
        },

        // ModuleHealthView internally calls HealthView.pushModuleHealth (msg.sender is ModuleHealthView)
        {
          role: "ACTION_VIEW_SYSTEM_STATUS",
          to: deployed.ModuleHealthView,
          label: "ModuleHealthView",
        },
      ];

      for (const g of grants) {
        if (!g.to) continue;
        const role = ethers.keccak256(ethers.toUtf8Bytes(g.role));
        const already = await acm.hasRole(role, g.to);
        if (already) continue;
        await (await acm.grantRole(role, g.to)).wait();
        console.log(`🔑 Granted ${g.role} to ${g.label}`);
      }

      // Explicit verification: PreviewView must be granted VIEW_USER_DATA to call PositionView internally.
      if (deployed.PreviewView) {
        const VIEW_USER_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_USER_DATA"),
        );
        const ok = await acm.hasRole(VIEW_USER_DATA, deployed.PreviewView);
        if (!ok) {
          await (
            await acm.grantRole(VIEW_USER_DATA, deployed.PreviewView)
          ).wait();
          console.log(
            "🔑 Granted VIEW_USER_DATA to PreviewView (explicit verification)",
          );
        } else {
          console.log("✅ PreviewView has VIEW_USER_DATA (verified)");
        }
      }
    } catch (e) {
      console.log(
        "⚠️ Grant view roles to aggregator/view modules skipped/failed:",
        e,
      );
    }

    // LiquidatorView（需要 SystemView）
    if (!deployed.LiquidatorView) {
      // 第二个参数为 SystemView 占位参数，这里使用非零占位（Registry）
      try {
        deployed.LiquidatorView = await deployProxy("LiquidatorView", [
          deployed.Registry,
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ LiquidatorView deployment failed:", error);
      }
    }

    // LoanNFT（账本用到的 NFT）
    if (!deployed.LoanNFT) {
      try {
        deployed.LoanNFT = await deployProxy("LoanNFT", [
          "RWA Loan",
          "RWLN",
          "https://example.com/metadata/",
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ LoanNFT deployment failed:", error);
      }
    }

    // GuaranteeFundManager（如文件存在且需要）
    if (!deployed.GuaranteeFundManager) {
      try {
        // initialize(address vaultCore, address registry, address upgradeAdmin)
        deployed.GuaranteeFundManager = await deployProxy(
          "GuaranteeFundManager",
          [deployed.VaultCore, deployed.Registry, deployer.address],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ GuaranteeFundManager deployment failed:", error);
      }
    }

    // 确认 GuaranteeFundManager 地址不与 VaultCore 冲突且功能可用；如冲突或不可用则重部署
    try {
      if (deployed.GuaranteeFundManager) {
        if (
          deployed.VaultCore &&
          deployed.GuaranteeFundManager.toLowerCase() ===
            deployed.VaultCore.toLowerCase()
        ) {
          console.log(
            "⚠️ GuaranteeFundManager address equals VaultCore. Re-deploying GuaranteeFundManager to avoid collision...",
          );
          deployed.GuaranteeFundManager = await deployProxy(
            "GuaranteeFundManager",
            [deployed.VaultCore, deployed.Registry, deployer.address],
          );
          save(deployed);
          console.log(
            "✅ GuaranteeFundManager re-deployed @",
            deployed.GuaranteeFundManager,
          );
        } else {
          // Deploy-order safe verification: avoid calling methods that depend on Registry bindings (e.g., vaultCoreAddr()).
          // Instead, validate that the address has code and that the proxy was initialized with the expected Registry.
          try {
            const code = await ethers.provider.getCode(
              deployed.GuaranteeFundManager,
            );
            if (!code || code === "0x")
              throw new Error("empty code at GuaranteeFundManager address");

            const gfm = await ethers.getContractAt(
              "GuaranteeFundManager",
              deployed.GuaranteeFundManager,
            );
            const reg = await gfm.getRegistry();
            if (reg.toLowerCase() !== deployed.Registry.toLowerCase()) {
              throw new Error(
                `registry mismatch: expected=${deployed.Registry} got=${reg}`,
              );
            }
          } catch (verifyErr) {
            console.log(
              "⚠️ GuaranteeFundManager at address is not functioning. Re-deploying...",
              verifyErr,
            );
            deployed.GuaranteeFundManager = await deployProxy(
              "GuaranteeFundManager",
              [deployed.VaultCore, deployed.Registry, deployer.address],
            );
            save(deployed);
            console.log(
              "✅ GuaranteeFundManager re-deployed @",
              deployed.GuaranteeFundManager,
            );
          }
        }
      }
    } catch (err) {
      console.log("⚠️ GuaranteeFundManager validation failed:", err);
    }

    // ====== 奖励系统（完整）======
    // ====== Governance voting token (SSOT) ======
    // SSOT target-state: governance votes token is stEASY (Registry[KEY_EASY_STAKING]).

    // ====== AI Credits Vault（链上 credits SSOT）======
    if (!deployed.AICreditsVault) {
      try {
        deployed.AICreditsVault = await deployProxy(
          "src/core/AICreditsVault.sol:AICreditsVault",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ AICreditsVault deployment failed:", error);
      }
    }
    if (!deployed.RewardManagerCore) {
      try {
        deployed.RewardManagerCore = await deployProxy("RewardManagerCore", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ RewardManagerCore deployment failed:", error);
      }
    }
    if (!deployed.RewardAccrualManager) {
      try {
        deployed.RewardAccrualManager = await deployProxy(
          "RewardAccrualManager",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ RewardAccrualManager deployment failed:", error);
      }
    }
    if (!deployed.RewardManager) {
      try {
        deployed.RewardManager = await deployProxy("RewardManager", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ RewardManager deployment failed:", error);
      }
    }
    if (!deployed.RewardConfig) {
      try {
        deployed.RewardConfig = await deployProxy("RewardConfig", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ RewardConfig deployment failed:", error);
      }
    }
    if (!deployed.EarnConfig) {
      try {
        deployed.EarnConfig = await deployProxy("EarnConfig", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ EarnConfig deployment failed:", error);
      }
    }
    if (!deployed.RewardView) {
      try {
        deployed.RewardView = await deployProxy("RewardView", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ RewardView deployment failed:", error);
      }
    } else {
      try {
        const upgraded = await ensureViewProxyVersion(
          "RewardView",
          deployed.RewardView,
          3n,
          2n,
        );
        if (upgraded) save(deployed);
      } catch (error) {
        console.log("⚠️ RewardView upgrade/verification failed:", error);
        throw error;
      }
    }

    // ====== Easy tokenomics (EasyToken + emission/consumption + staking) ======
    const easyTeamRecipient =
      process.env.EASY_TEAM_RECIPIENT || deployer.address;
    const easyEcoRecipient = process.env.EASY_ECO_RECIPIENT || deployer.address;

    if (!deployed.EasyToken) {
      try {
        deployed.EasyToken = await deployProxy(
          "src/Token/EasyToken.sol:EasyToken",
          [deployer.address],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ EasyToken deployment failed:", error);
      }
    }
    if (!deployed.EasyEmissionConfig) {
      try {
        deployed.EasyEmissionConfig = await deployProxy("EasyEmissionConfig", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ EasyEmissionConfig deployment failed:", error);
      }
    }
    if (!deployed.EasyEmissionController) {
      try {
        deployed.EasyEmissionController = await deployProxy(
          "EasyEmissionController",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ EasyEmissionController deployment failed:", error);
      }
    }
    if (!deployed.EasyConsumption) {
      try {
        deployed.EasyConsumption = await deployProxy("EasyConsumption", [
          deployed.Registry,
        ]);
        save(deployed);
      } catch (error) {
        console.log("⚠️ EasyConsumption deployment failed:", error);
      }
    }
    if (!deployed.EasyRecycleDistributor) {
      try {
        deployed.EasyRecycleDistributor = await deployProxy(
          "EasyRecycleDistributor",
          [deployed.Registry, easyTeamRecipient, easyEcoRecipient],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ EasyRecycleDistributor deployment failed:", error);
      }
    }
    if (!deployed.EasyStaking) {
      try {
        deployed.EasyStaking = await deployProxy(
          "src/Governance/EasyStaking.sol:EasyStaking",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ EasyStaking deployment failed:", error);
      }
    }

    // EasyToken roles (SSOT):
    // - MINTER_ROLE: issuance (sole minter = EasyEmissionController)
    // - BURNER_ROLE: burn paths (penalty/ledger + recycle burn)
    try {
      if (deployed.EasyToken) {
        const easyToken = await ethers.getContractAt(
          "src/Token/EasyToken.sol:EasyToken",
          deployed.EasyToken,
        );
        const MINTER_ROLE = await easyToken.MINTER_ROLE();
        const BURNER_ROLE = await easyToken.BURNER_ROLE();

        if (deployed.EasyEmissionController) {
          const hasController = await easyToken.hasRole(
            MINTER_ROLE,
            deployed.EasyEmissionController,
          );
          if (!hasController) {
            await (
              await easyToken.setSoleMinter(deployed.EasyEmissionController)
            ).wait();
            console.log(
              "✅ EasyToken sole minter set to EasyEmissionController",
            );
          }
        }

        if (deployed.EasyRecycleDistributor) {
          const hasBurner = await easyToken.hasRole(
            BURNER_ROLE,
            deployed.EasyRecycleDistributor,
          );
          if (!hasBurner) {
            await (
              await easyToken.grantRole(
                BURNER_ROLE,
                deployed.EasyRecycleDistributor,
              )
            ).wait();
            console.log(
              "✅ EasyToken BURNER_ROLE granted to EasyRecycleDistributor",
            );
          }
        }

        if (deployed.RewardAccrualManager) {
          const hasRam = await easyToken.hasRole(
            BURNER_ROLE,
            deployed.RewardAccrualManager,
          );
          if (!hasRam) {
            await (
              await easyToken.grantRole(
                BURNER_ROLE,
                deployed.RewardAccrualManager,
              )
            ).wait();
            console.log(
              "✅ EasyToken BURNER_ROLE granted to RewardAccrualManager",
            );
          }
        }

        if (deployed.RewardManagerCore) {
          const hasRmcore = await easyToken.hasRole(
            BURNER_ROLE,
            deployed.RewardManagerCore,
          );
          if (hasRmcore) {
            await (
              await easyToken.revokeRole(
                BURNER_ROLE,
                deployed.RewardManagerCore,
              )
            ).wait();
            console.log(
              "🔐 Revoked legacy EasyToken BURNER_ROLE from RewardManagerCore",
            );
          }
        }

        // Localhost hardening: deployer should not retain burn powers by default.
        const deployerHasBurner = await easyToken.hasRole(
          BURNER_ROLE,
          deployer.address,
        );
        if (deployerHasBurner) {
          await (
            await easyToken.revokeRole(BURNER_ROLE, deployer.address)
          ).wait();
          console.log(
            "🔐 Revoked EasyToken BURNER_ROLE from deployer (localhost hardening)",
          );
        }
      }
    } catch (error) {
      console.log("⚠️ EasyToken role setup failed:", error);
    }

    // ====== FeatureRegistry (SSOT: on-chain feature semantics) ======
    if (!deployed.FeatureRegistry) {
      try {
        deployed.FeatureRegistry = await deployProxy(
          "src/Reward/FeatureRegistry.sol:FeatureRegistry",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ FeatureRegistry deployment failed:", error);
      }
    }

    // ====== GovernanceGate (SSOT: propose/vote eligibility) ======
    if (!deployed.GovernanceGate) {
      try {
        deployed.GovernanceGate = await deployProxy(
          "src/Governance/GovernanceGate.sol:GovernanceGate",
          [deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ GovernanceGate deployment failed:", error);
      }
    }

    // ====== CrossChainGovernance (gate + veto) ======
    if (!deployed.CrossChainGovernance) {
      try {
        deployed.CrossChainGovernance = await deployProxy(
          "src/Governance/CrossChainGovernance.sol:CrossChainGovernance",
          [deployer.address, deployed.Registry],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ CrossChainGovernance deployment failed:", error);
      }
    }

    // ====== Governance guardian (foundation veto SSOT) ======
    // Stored as Registry module-address entry under KEY_GOVERNANCE_GUARDIAN.
    if (!deployed.GovernanceGuardian) {
      deployed.GovernanceGuardian =
        process.env.GOVERNANCE_GUARDIAN || deployer.address;
      save(deployed);
    }

    // Reward governance roles (write-path SSOT):
    // - RewardConfig governance entrypoints are role-gated via AccessControlManager.
    try {
      if (deployed.AccessControlManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
        await ensureAcmRole(
          acm,
          "SET_PARAMETER",
          deployed.RewardConfig,
          "RewardConfig",
        );

        // Break-glass (revocable): mimic non-localhost hardening on localhost by default.
        // - DO NOT auto-grant to deployer.
        // - If needed for a one-off local run, explicitly set `REWARD_CONFIG_EMERGENCY_GRANTEE`
        //   to a separate EOA/timelock/multisig address.
        const emergencyGrantee = process.env.REWARD_CONFIG_EMERGENCY_GRANTEE;
        if (emergencyGrantee && emergencyGrantee !== ethers.ZeroAddress) {
          await ensureRewardConfigEmergencyGranted(acm, emergencyGrantee, (m) =>
            logActionTo(m, emergencyGrantee),
          );
        }

        // Localhost default hardening: always ensure deployer break-glass is revoked.
        await ensureRewardConfigEmergencyRevoked(acm, deployer.address, (m) =>
          logActionTo(m, deployer.address),
        );
      }
    } catch (e) {
      console.log("⚠️ Reward governance role grants skipped/failed:", e);
    }

    // NOTE: CrossChainGovernance.setRegistry() moved to Phase B+ (after phaseBBindRegistry)
    // because setRegistry() internally syncs governance token cache from Registry[KEY_EASY_STAKING].
    // That key is only bound in Phase B, so calling it here can revert with ModuleNotRegistered.

    // 2.99) 部署 LiquidationManager（方案A：直达账本 + View 单点推送）
    // NOTE: 该模块将作为 Registry.KEY_LIQUIDATION_MANAGER 的唯一清算入口；
    //       VaultBusinessLogic 不再作为清算入口绑定（避免写路径分叉/权限不一致）。
    if (!deployed.LiquidationManager) {
      try {
        deployed.LiquidationManager = await deployProxy("LiquidationManager", [
          deployed.Registry,
        ]);
        save(deployed);
        // NOTE: deployProxy already printed the deployed address; keep this log semantically distinct.
        console.log("✅ LiquidationManager ready");
      } catch (error) {
        console.log("⚠️ LiquidationManager deployment failed:", error);
      }
    }

    // 2.99.0) 部署 SettlementManager（统一结算/清算写入口，SSOT）
    // NOTE: 该模块将作为 Registry.KEY_SETTLEMENT_MANAGER 的唯一对外写入口；
    if (!deployed.SettlementManager) {
      try {
        deployed.SettlementManager = await deployProxy("SettlementManager", [
          deployed.Registry,
        ]);
        save(deployed);
        // NOTE: deployProxy already printed the deployed address; keep this log semantically distinct.
        console.log("✅ SettlementManager ready");
      } catch (error) {
        console.log("⚠️ SettlementManager deployment failed:", error);
      }
    }

    // 2.99.0.1) 部署 OrderStateStoreV2（三层订单状态 SSOT）
    if (!deployed.OrderStateStoreV2) {
      try {
        deployed.OrderStateStoreV2 = await deployProxy("OrderStateStoreV2", [
          deployed.Registry,
        ]);
        save(deployed);
        console.log("✅ OrderStateStoreV2 ready");
      } catch (error) {
        console.log("⚠️ OrderStateStoreV2 deployment failed:", error);
      }
    }

    // 2.99.0.5) 部署 LenderPoolVault（线上流动性资金池，推荐）
    if (!deployed.LenderPoolVault) {
      try {
        deployed.LenderPoolVault = await deployProxy("LenderPoolVault", [
          deployed.Registry,
        ]);
        save(deployed);
        // NOTE: deployProxy already printed the deployed address; keep this log semantically distinct.
        console.log("✅ LenderPoolVault ready");
      } catch (error) {
        console.log("⚠️ LenderPoolVault deployment failed:", error);
      }
    }

    // 2.99.0.6) 部署 BlocksOnlyCoordinator（blocks-only 独立产品协调器）
    // - 该模块是当前 blocks-only 写路径 SSOT：负责 finalize / repay / debt-free trade-close / maturity 后 settle-or-liquidate。
    // - 它不是 legacy SettlementManager 的别名，因此部署成功后应视为独立产品入口已经存在。
    if (!deployed.BlocksOnlyCoordinator) {
      try {
        deployed.BlocksOnlyCoordinator = await deployProxy(
          "BlocksOnlyCoordinator",
          [deployed.Registry],
        );
        save(deployed);
        console.log("✅ BlocksOnlyCoordinator ready");
      } catch (error) {
        console.log("⚠️ BlocksOnlyCoordinator deployment failed:", error);
      }
    }

    // 若未显式提供 PAYOUT_LENDER_ADDR，则默认将 lenderCompensation 指向 LenderPoolVault（与“lender=资金池地址”语义一致）
    if (!process.env.PAYOUT_LENDER_ADDR && deployed.LenderPoolVault) {
      payoutRecipients = {
        ...payoutRecipients,
        lenderCompensation: deployed.LenderPoolVault,
      };
    }

    // 2.99.2) 部署 LiquidationPayoutManager（残值分配）
    if (!deployed.LiquidationPayoutManager) {
      try {
        deployed.LiquidationPayoutManager = await deployProxy(
          "LiquidationPayoutManager",
          [
            deployed.Registry,
            deployed.AccessControlManager,
            [
              payoutRecipients.platform,
              payoutRecipients.reserve,
              payoutRecipients.lenderCompensation,
            ],
            payoutRates,
          ],
        );
        save(deployed);
        // NOTE: deployProxy already printed the deployed address; keep this log semantically distinct.
        console.log("✅ LiquidationPayoutManager ready");
      } catch (error) {
        console.log("⚠️ LiquidationPayoutManager deployment failed:", error);
      }
    }

    // 2.99.1) 授权 LiquidationManager 执行清算（ACTION_LIQUIDATE）
    // - Vault/LendingEngine/CollateralManager 内部会对 msg.sender 做 ACTION_LIQUIDATE 校验；
    // - 因此必须给 LiquidationManager 授权，否则清算会在 CM/LE 处回滚。
    try {
      if (deployed.AccessControlManager && deployed.LiquidationManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
        const ACTION_LIQUIDATE = ethers.keccak256(
          ethers.toUtf8Bytes("LIQUIDATE"),
        );
        const already = await acm.hasRole(
          ACTION_LIQUIDATE,
          deployed.LiquidationManager,
        );
        if (!already) {
          await (
            await acm.grantRole(ACTION_LIQUIDATE, deployed.LiquidationManager)
          ).wait();
          console.log("🔑 Granted ACTION_LIQUIDATE to LiquidationManager");
        }

        // LiquidationManager routes liquidation platform fees via FeeRouter.distributePrepaid.
        const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
        const hasDeposit = await acm.hasRole(
          ACTION_DEPOSIT,
          deployed.LiquidationManager,
        );
        if (!hasDeposit) {
          await (
            await acm.grantRole(ACTION_DEPOSIT, deployed.LiquidationManager)
          ).wait();
          console.log("🔑 Granted ACTION_DEPOSIT to LiquidationManager");
        }
      }
    } catch (e) {
      console.log(
        "⚠️ Grant ACTION_LIQUIDATE to LiquidationManager skipped/failed:",
        e,
      );
    }

    // 2.99.1.0) 授权 LiquidationRiskManager 读取 HealthView 的 user 维度缓存。
    // NOTE: LiquidationRiskManager.isLiquidatable(user) -> HealthView.getUserHealthFactorWithMeta(user)
    // 触发 Scheme U：非本人读取需要 VIEW_USER_DATA 或 ADMIN。
    try {
      if (deployed.AccessControlManager && deployed.LiquidationRiskManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
        const ACTION_VIEW_USER_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_USER_DATA"),
        );
        const has = await acm.hasRole(
          ACTION_VIEW_USER_DATA,
          deployed.LiquidationRiskManager,
        );
        if (!has) {
          await (
            await acm.grantRole(
              ACTION_VIEW_USER_DATA,
              deployed.LiquidationRiskManager,
            )
          ).wait();
          console.log(
            "🔑 Granted ACTION_VIEW_USER_DATA to LiquidationRiskManager",
          );
        }
      }
    } catch (e) {
      console.log(
        "⚠️ Grant ACTION_VIEW_USER_DATA to LiquidationRiskManager skipped/failed:",
        e,
      );
    }

    try {
      await ensureVaultLendingEngineHealthRoles(deployed);
    } catch (e) {
      console.log(
        "⚠️ Grant VaultLendingEngine health roles skipped/failed:",
        e,
      );
    }

    // 2.99.1.1) 授权 SettlementManager 触发清算执行器（LiquidationManager 会校验 caller 具备 LIQUIDATE）
    try {
      if (deployed.AccessControlManager && deployed.SettlementManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
        const ACTION_LIQUIDATE = ethers.keccak256(
          ethers.toUtf8Bytes("LIQUIDATE"),
        );
        const already = await acm.hasRole(
          ACTION_LIQUIDATE,
          deployed.SettlementManager,
        );
        if (!already) {
          await (
            await acm.grantRole(ACTION_LIQUIDATE, deployed.SettlementManager)
          ).wait();
          console.log("🔑 Granted ACTION_LIQUIDATE to SettlementManager");
        }
      }
    } catch (e) {
      console.log(
        "⚠️ Grant ACTION_LIQUIDATE to SettlementManager skipped/failed:",
        e,
      );
    }

    // 2.99.1.1.1) 授权 BlocksOnlyCoordinator 执行 maturity 后清算与估值读取
    // - ACTION_LIQUIDATE: 允许 coordinator 在 blocks-only maturity 分支下直接触发清算执行器。
    // - ACTION_VIEW_RISK_DATA: 允许 coordinator 读取估值/风险视图后决定是释放抵押还是进入清算。
    // - 这里授权的是 blocks-only 独立收尾路径，不应被理解成 legacy SettlementManager 的补充别名。
    try {
      if (deployed.AccessControlManager && deployed.BlocksOnlyCoordinator) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
        const ACTION_LIQUIDATE = ethers.keccak256(
          ethers.toUtf8Bytes("LIQUIDATE"),
        );
        const ACTION_VIEW_RISK_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_RISK_DATA"),
        );

        const hasLiquidate = await acm.hasRole(
          ACTION_LIQUIDATE,
          deployed.BlocksOnlyCoordinator,
        );
        if (!hasLiquidate) {
          await (
            await acm.grantRole(
              ACTION_LIQUIDATE,
              deployed.BlocksOnlyCoordinator,
            )
          ).wait();
          console.log("🔑 Granted ACTION_LIQUIDATE to BlocksOnlyCoordinator");
        }

        const hasRiskView = await acm.hasRole(
          ACTION_VIEW_RISK_DATA,
          deployed.BlocksOnlyCoordinator,
        );
        if (!hasRiskView) {
          await (
            await acm.grantRole(
              ACTION_VIEW_RISK_DATA,
              deployed.BlocksOnlyCoordinator,
            )
          ).wait();
          console.log(
            "🔑 Granted ACTION_VIEW_RISK_DATA to BlocksOnlyCoordinator",
          );
        }
      }
    } catch (e) {
      console.log(
        "⚠️ Grant ACTION_LIQUIDATE/VIEW_RISK_DATA to BlocksOnlyCoordinator skipped/failed:",
        e,
      );
    }

    // 2.99.1.2) 授权 SettlementManager 执行订单级还款与只读查询（ORDER_ENGINE.repay / getLoanOrderForView）
    try {
      if (deployed.AccessControlManager && deployed.SettlementManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
        const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes("REPAY"));
        const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_SYSTEM_DATA"),
        );
        const ACTION_VIEW_RISK_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_RISK_DATA"),
        );

        const hasRepay = await acm.hasRole(
          ACTION_REPAY,
          deployed.SettlementManager,
        );
        if (!hasRepay) {
          await (
            await acm.grantRole(ACTION_REPAY, deployed.SettlementManager)
          ).wait();
          console.log("🔑 Granted ACTION_REPAY to SettlementManager");
        }

        const hasView = await acm.hasRole(
          ACTION_VIEW_SYSTEM_DATA,
          deployed.SettlementManager,
        );
        if (!hasView) {
          await (
            await acm.grantRole(
              ACTION_VIEW_SYSTEM_DATA,
              deployed.SettlementManager,
            )
          ).wait();
          console.log(
            "🔑 Granted ACTION_VIEW_SYSTEM_DATA to SettlementManager",
          );
        }

        // SettlementManager liquidation path calls PositionView.getAssetValue (valuation helper),
        // which is gated by VIEW_RISK_DATA.
        const hasRiskView = await acm.hasRole(
          ACTION_VIEW_RISK_DATA,
          deployed.SettlementManager,
        );
        if (!hasRiskView) {
          await (
            await acm.grantRole(
              ACTION_VIEW_RISK_DATA,
              deployed.SettlementManager,
            )
          ).wait();
          console.log("🔑 Granted ACTION_VIEW_RISK_DATA to SettlementManager");
        }
      }
    } catch (e) {
      console.log(
        "⚠️ Grant ACTION_REPAY/VIEW_SYSTEM_DATA to SettlementManager skipped/failed:",
        e,
      );
    }

    // 2.99.1.2.1) 授权 GuaranteeFundManager 分发平台罚金（FeeRouter.distributePrepaid -> ACTION_DEPOSIT）
    try {
      if (deployed.AccessControlManager && deployed.GuaranteeFundManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
        const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
        const already = await acm.hasRole(
          ACTION_DEPOSIT,
          deployed.GuaranteeFundManager,
        );
        if (!already) {
          await (
            await acm.grantRole(ACTION_DEPOSIT, deployed.GuaranteeFundManager)
          ).wait();
          console.log("🔑 Granted ACTION_DEPOSIT to GuaranteeFundManager");
        }
      }
    } catch (e) {
      console.log(
        "⚠️ Grant ACTION_DEPOSIT to GuaranteeFundManager skipped/failed:",
        e,
      );
    }

    // 2.99.1.3) 强制本地环境：全额还款必须自动释放抵押
    try {
      if (deployed.SettlementManager) {
        const sm = await ethers.getContractAt(
          "SettlementManager",
          deployed.SettlementManager,
        );
        const enabled = await sm.requireFullRepayRelease();
        if (!enabled) {
          await (await sm.setRequireFullRepayRelease(true)).wait();
          console.log(
            "✅ Enabled strict full-repay auto-release on SettlementManager",
          );
        }
      }
    } catch (e) {
      console.log(
        "⚠️ Enable strict full-repay auto-release skipped/failed:",
        e,
      );
    }
  };

  await phaseADeployAndInit();

  // ===================== Phase B: Bind Registry (SSOT) =====================
  // NOTE: Some modules require minimal pre-binding during Phase A for their initializer to succeed.
  //       Phase B is the canonical single pass that binds all deployed modules into Registry (SSOT).
  const registry = await ethers.getContractAt("Registry", deployed.Registry);
  await phaseBBindRegistry(registry, deployed);

  // ===================== Phase B+: Post-binding wiring =====================
  // Wire Registry SSOT into CrossChainGovernance (enables gate + guardian + token cache sync).
  // MUST run AFTER Phase B so the governance SSOT keys (e.g., KEY_EASY_STAKING) are already bound; otherwise
  // setRegistry() → _syncGovernanceTokenFromRegistry() → getModuleOrRevert() reverts.
  try {
    if (deployed.CrossChainGovernance) {
      const gov = await ethers.getContractAt(
        "src/Governance/CrossChainGovernance.sol:CrossChainGovernance",
        deployed.CrossChainGovernance,
      );
      await (await gov.setRegistry(deployed.Registry)).wait();
      console.log(
        "✅ CrossChainGovernance registry wired (gate+guardian enabled)",
      );
    }
  } catch (e) {
    console.log("⚠️ CrossChainGovernance.setRegistry skipped/failed:", e);
  }

  // ===================== Phase C: Validate & Outputs =====================
  await phaseCValidateAndWriteOutputs(registry, deployed);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

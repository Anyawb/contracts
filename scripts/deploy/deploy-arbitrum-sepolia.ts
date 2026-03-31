/**
 * Arbitrum Sepolia 测试网部署脚本（符合 contracts/docs/Architecture-Guide.md）
 * Arbitrum Sepolia Testnet Deployment Script
 *
 * 该脚本用于将智能合约系统部署到 Arbitrum Sepolia 测试网
 * This script deploys the smart contract system to Arbitrum Sepolia testnet
 * - 部署 Registry（单一入口 / 单一 Proxy，Scheme A）
 * - 部署并注册核心业务与视图模块
 * - 写入 deployments/arbitrum-sepolia.json 与 frontend-config/contracts-arbitrum-sepolia.ts
 */

import fs from "fs";
import path from "path";
import {
  configureAssets,
  resolveSettlementAssetConfig,
} from "../utils/configure-assets";
import { initStableDeploymentOutput } from "./utils/stable-output";
import {
  ensureRewardConfigEmergencyGranted,
  ensureRewardConfigEmergencyRevoked,
} from "./utils/reward-config-emergency";
import { configureDynamicEip1559Fees } from "../utils/eip1559-fees";

// Must run BEFORE requiring Hardhat to prevent redraw-style output from polluting logs.
initStableDeploymentOutput();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const hre = require("hardhat");
const { ethers, upgrades, network } = hre;

type DeployMap = Record<string, string>;
type EnsureRoleOutcome = "granted" | "already-granted";

/**
 * Arbitrum Sepolia 网络配置
 * Arbitrum Sepolia network configuration
 */
const ARBITRUM_SEPOLIA_CONFIG = {
  name: "arbitrum-sepolia",
  chainId: 421614,
  rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  explorer: "https://sepolia.arbiscan.io",
};

const DEPLOY_DIR = path.join(__dirname, "..", "deployments");
const DEPLOY_FILE = resolveDeployFile();
// 将前端配置输出到当前仓库的 frontend-config，避免写到工作区外部路径
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend-config");
const FRONTEND_FILE = path.join(FRONTEND_DIR, "contracts-arbitrum-sepolia.ts");
const DEFAULT_PAYOUT_BPS = {
  platform: 300,
  reserve: 200,
  lender: 1700,
  liquidator: 7800,
};
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC";

function resolveConfiguredSettlementAsset() {
  return resolveSettlementAssetConfig(
    ARBITRUM_SEPOLIA_CONFIG.name,
    ARBITRUM_SEPOLIA_CONFIG.chainId,
  );
}

function resolveDeployFile() {
  const explicit = process.env.DEPLOY_OUTPUT_FILE?.trim();
  if (!explicit) return path.join(DEPLOY_DIR, "arbitrum-sepolia.json");
  return path.isAbsolute(explicit)
    ? explicit
    : path.resolve(DEPLOY_DIR, explicit);
}

function shouldFreshDeploy() {
  return process.env.FRESH_DEPLOY === "1";
}

function shouldUpgradeFeeRouterView() {
  return process.env.UPGRADE_FEE_ROUTER_VIEW === "1";
}

function hasExplicitSettlementOverride() {
  return Boolean(process.env.SETTLEMENT_TOKEN_ADDRESS?.trim());
}

function load(): DeployMap {
  if (shouldFreshDeploy()) return {};
  if (fs.existsSync(DEPLOY_FILE))
    return JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf8")) as DeployMap;
  return {};
}

function save(map: DeployMap) {
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  fs.writeFileSync(DEPLOY_FILE, JSON.stringify(map, null, 2));
}

function applySettlementOverrideToDeployMap(map: DeployMap) {
  const { settlementAsset, source } = resolveConfiguredSettlementAsset();
  const current = map.SettlementToken;
  const explicitOverride = hasExplicitSettlementOverride();

  if (!current) {
    map.SettlementToken = settlementAsset.address;
    console.log(
      `ℹ️ SettlementToken initialized from configured asset: ${settlementAsset.address} (${source})`,
    );
    return;
  }

  if (current.toLowerCase() === settlementAsset.address.toLowerCase()) return;

  if (explicitOverride) {
    map.SettlementToken = settlementAsset.address;
    console.log(
      `♻️ SettlementToken override applied: ${current} -> ${settlementAsset.address} (${source})`,
    );
    return;
  }

  if (!shouldFreshDeploy()) {
    console.log(
      `ℹ️ Reusing cached SettlementToken=${current}; configured settlement asset is ${settlementAsset.address} (${source})`,
    );
  }
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

async function deployRegular(
  name: string,
  ...args: unknown[]
): Promise<string> {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`✅ ${name} deployed @ ${addr}`);
  return addr;
}

async function deployProxy(
  name: string,
  args: unknown[] = [],
  opts: Record<string, unknown> = {},
): Promise<string> {
  const f = await ethers.getContractFactory(name);
  // 默认添加unsafeAllow配置来处理构造函数问题
  // Phase 0c (OZ v5 migration): default to UUPS unless explicitly overridden.
  const defaultOpts = { kind: "uups", unsafeAllow: ["constructor"], ...opts };
  const p = await upgrades.deployProxy(f, args, defaultOpts);
  await p.waitForDeployment();
  const addr = await p.getAddress();
  console.log(`✅ ${name} (proxy) deployed @ ${addr}`);
  return addr;
}

async function upgradeProxy(
  name: string,
  proxyAddr: string,
  opts: Record<string, unknown> = {},
): Promise<string> {
  const f = await ethers.getContractFactory(name);
  const defaultOpts = { kind: "uups", unsafeAllow: ["constructor"], ...opts };
  const p = await upgrades.upgradeProxy(proxyAddr, f, defaultOpts);
  await p.waitForDeployment();
  const addr = await p.getAddress();
  console.log(`🔄 ${name} upgraded @ ${addr}`);
  return addr;
}

async function getImplementationAddress(proxyAddr: string) {
  const raw = await ethers.provider.getStorage(
    proxyAddr,
    EIP1967_IMPLEMENTATION_SLOT,
  );
  if (!raw || raw === "0x") {
    return ethers.ZeroAddress;
  }
  return ethers.getAddress(`0x${raw.slice(26)}`);
}

async function lookupRegistryModule(
  registryAddr: string | undefined,
  upperSnakeKey: string,
) {
  if (!registryAddr || registryAddr === ethers.ZeroAddress) {
    return undefined;
  }
  const registry = await ethers.getContractAt("Registry", registryAddr);
  const addr = (await registry.getModule(keyOf(upperSnakeKey))) as string;
  if (!addr || addr === ethers.ZeroAddress) {
    return undefined;
  }
  return ethers.getAddress(addr);
}

async function upgradeProxyAndVerify(
  name: string,
  proxyAddr: string,
  opts: Record<string, unknown> = {},
) {
  const expectedProxy = ethers.getAddress(proxyAddr);
  const beforeImpl = await getImplementationAddress(expectedProxy);
  const upgradedProxy = ethers.getAddress(
    await upgradeProxy(name, expectedProxy, opts),
  );

  if (upgradedProxy.toLowerCase() !== expectedProxy.toLowerCase()) {
    throw new Error(
      `${name} upgrade changed proxy address: expected ${expectedProxy}, got ${upgradedProxy}`,
    );
  }

  const afterImpl = await getImplementationAddress(expectedProxy);
  if (afterImpl === ethers.ZeroAddress) {
    throw new Error(`${name} upgrade verification failed: implementation is zero`);
  }

  if (beforeImpl !== ethers.ZeroAddress && beforeImpl.toLowerCase() === afterImpl.toLowerCase()) {
    console.log(`↪️ ${name} implementation unchanged: ${afterImpl}`);
  } else {
    console.log(
      `✅ ${name} implementation updated: ${beforeImpl} -> ${afterImpl}`,
    );
  }

  return {
    proxy: expectedProxy,
    beforeImpl,
    afterImpl,
  };
}

async function ensureFeeRouterSupportedToken(
  feeRouterAddr: string,
  token: string,
  label: string,
) {
  if (!feeRouterAddr || feeRouterAddr === ethers.ZeroAddress) return;
  if (!token || token === ethers.ZeroAddress) return;
  const fr = await ethers.getContractAt("FeeRouter", feeRouterAddr);
  const supported: boolean = await fr.isTokenSupported(token);
  if (supported) {
    console.log(`↪️ FeeRouter already supports ${label}: ${token}`);
    return;
  }
  await (await fr.addSupportedToken(token)).wait();
  console.log(`✅ FeeRouter added supported token (${label}) -> ${token}`);
}

async function ensureAssetWhitelistAllowed(
  assetWhitelistAddr: string,
  token: string,
  label: string,
) {
  if (!assetWhitelistAddr || assetWhitelistAddr === ethers.ZeroAddress) return;
  if (!token || token === ethers.ZeroAddress) return;
  const awRead = await ethers.getContractAt(
    "IAssetWhitelistRead",
    assetWhitelistAddr,
  );
  const allowed: boolean = await awRead.isAssetAllowed(token);
  if (allowed) {
    console.log(`↪️ AssetWhitelist already allows ${label}: ${token}`);
    return;
  }
  const awAdmin = await ethers.getContractAt(
    "IAssetWhitelistAdmin",
    assetWhitelistAddr,
  );
  await (await awAdmin.addAllowedAsset(token)).wait();
  console.log(`✅ AssetWhitelist added ${label}: ${token}`);
}

async function ensureConfiguredAssetsProtocolEnabled(deployed: DeployMap) {
  const { assets } = resolveConfiguredSettlementAsset();
  if (!assets.length) return;
  for (const asset of assets) {
    await ensureAssetWhitelistAllowed(
      deployed.AssetWhitelist,
      asset.address,
      asset.sourceId,
    );
    await ensureFeeRouterSupportedToken(
      deployed.FeeRouter,
      asset.address,
      asset.sourceId,
    );
  }
}

async function ensureRegistryModuleBound(
  registry: any,
  upperSnakeKey: string,
  expectedAddr: string,
  label: string,
) {
  if (!expectedAddr || expectedAddr === ethers.ZeroAddress) return;

  const expected = ethers.getAddress(expectedAddr);
  let current = ethers.ZeroAddress;
  try {
    current = (await registry.getModule(keyOf(upperSnakeKey))) as string;
  } catch {
    current = ethers.ZeroAddress;
  }

  if (current !== ethers.ZeroAddress && current.toLowerCase() === expected.toLowerCase()) {
    console.log(`↪️ ${label} already aligned -> ${expected}`);
    return;
  }

  await (await registry.setModule(keyOf(upperSnakeKey), expected)).wait();
  const rebound = (await registry.getModuleOrRevert(keyOf(upperSnakeKey))) as string;
  if (ethers.getAddress(rebound).toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${label} rebind verification failed: expected ${expected}, got ${rebound}`,
    );
  }
  console.log(`✅ Bound ${label} -> ${expected}`);
}

async function reconcileVaultLendingEngineSettlementToken(deployed: DeployMap) {
  if (!hasExplicitSettlementOverride()) return;
  if (!deployed.VaultLendingEngine || !deployed.SettlementToken) return;

  const vaultLendingEngine = await ethers.getContractAt(
    [
      "function setSettlementToken(address newSettlementToken)",
    ],
    deployed.VaultLendingEngine,
  );

  await (await vaultLendingEngine.setSettlementToken(deployed.SettlementToken)).wait();
  console.log(
    `✅ VaultLendingEngine settlement token reconciled -> ${deployed.SettlementToken}`,
  );
}

async function ensureAcmRole(
  acm: any,
  roleName: string,
  account: string,
  label?: string,
): Promise<EnsureRoleOutcome> {
  const role = ethers.keccak256(ethers.toUtf8Bytes(roleName));
  const alreadyGranted = await acm.hasRole(role, account);
  if (alreadyGranted) {
    return "already-granted";
  }
  await (await acm.grantRole(role, account)).wait();
  console.log(`🔑 Granted ${roleName} to ${label || account}`);
  return "granted";
}

function logRoleEnsureSummary(
  scope: string,
  results: Array<{ roleName: string; outcome: EnsureRoleOutcome }>,
) {
  const granted = results
    .filter((item) => item.outcome === "granted")
    .map((item) => item.roleName);
  const alreadyGranted = results
    .filter((item) => item.outcome === "already-granted")
    .map((item) => item.roleName);

  if (granted.length > 0) {
    console.log(`🔐 ${scope}: granted ${granted.join(", ")}`);
  }
  if (alreadyGranted.length > 0) {
    console.log(`↪️ ${scope}: already granted ${alreadyGranted.join(", ")}`);
  }
}

async function ensureAcmRoles(
  acm: any,
  scope: string,
  grants: Array<{ roleName: string; account?: string; label: string }>,
) {
  const results: Array<{ roleName: string; outcome: EnsureRoleOutcome }> = [];
  for (const grant of grants) {
    if (!grant.account) continue;
    const outcome = await ensureAcmRole(
      acm,
      grant.roleName,
      grant.account,
      grant.label,
    );
    results.push({ roleName: `${grant.roleName}->${grant.label}`, outcome });
  }
  logRoleEnsureSummary(scope, results);
}

async function ensureLiveSafeViewModuleRoles(deployed: DeployMap) {
  if (!deployed.AccessControlManager) return;
  const acm = await ethers.getContractAt(
    "AccessControlManager",
    deployed.AccessControlManager,
  );

  await ensureAcmRoles(acm, "Live view modules", [
    { roleName: "VIEW_USER_DATA", account: deployed.BatchView, label: "BatchView" },
    { roleName: "VIEW_PRICE_DATA", account: deployed.BatchView, label: "BatchView" },
    {
      roleName: "ACTION_VIEW_SYSTEM_STATUS",
      account: deployed.BatchView,
      label: "BatchView",
    },
    { roleName: "VIEW_USER_DATA", account: deployed.DashboardView, label: "DashboardView" },
    { roleName: "VIEW_RISK_DATA", account: deployed.DashboardView, label: "DashboardView" },
    { roleName: "VIEW_PRICE_DATA", account: deployed.DashboardView, label: "DashboardView" },
    {
      roleName: "VIEW_USER_DATA",
      account: deployed.CacheOptimizedView,
      label: "CacheOptimizedView",
    },
    {
      roleName: "VIEW_RISK_DATA",
      account: deployed.CacheOptimizedView,
      label: "CacheOptimizedView",
    },
    {
      roleName: "VIEW_SYSTEM_DATA",
      account: deployed.CacheOptimizedView,
      label: "CacheOptimizedView",
    },
    { roleName: "VIEW_USER_DATA", account: deployed.UserView, label: "UserView" },
    { roleName: "VIEW_RISK_DATA", account: deployed.UserView, label: "UserView" },
    { roleName: "VIEW_SYSTEM_DATA", account: deployed.UserView, label: "UserView" },
    { roleName: "VIEW_USER_DATA", account: deployed.RiskView, label: "RiskView" },
    { roleName: "VIEW_USER_DATA", account: deployed.PreviewView, label: "PreviewView" },
    { roleName: "VIEW_RISK_DATA", account: deployed.PreviewView, label: "PreviewView" },
    { roleName: "VIEW_RISK_DATA", account: deployed.HealthView, label: "HealthView" },
    {
      roleName: "VIEW_USER_DATA",
      account: deployed.LendingEngineView,
      label: "LendingEngineView",
    },
    {
      roleName: "VIEW_SYSTEM_DATA",
      account: deployed.LendingEngineView,
      label: "LendingEngineView",
    },
    {
      roleName: "ACTION_VIEW_SYSTEM_STATUS",
      account: deployed.ModuleHealthView,
      label: "ModuleHealthView",
    },
  ]);
}

async function ensureVaultRouterOperationalRoles(deployed: DeployMap) {
  if (!deployed.AccessControlManager || !deployed.VaultRouter) return;
  const acm = await ethers.getContractAt(
    "AccessControlManager",
    deployed.AccessControlManager,
  );

  await ensureAcmRoles(acm, "VaultRouter operational roles", [
    {
      roleName: "SET_PARAMETER",
      account: deployed.VaultRouter,
      label: "VaultRouter",
    },
    {
      roleName: "ACTION_VIEW_PUSH",
      account: deployed.VaultRouter,
      label: "VaultRouter",
    },
  ]);
}

async function ensureVaultBusinessLogicMatchRoles(deployed: DeployMap) {
  if (!deployed.AccessControlManager || !deployed.VaultBusinessLogic) return;
  const acm = await ethers.getContractAt(
    "AccessControlManager",
    deployed.AccessControlManager,
  );

  await ensureAcmRoles(acm, "VaultBusinessLogic match roles", [
    {
      roleName: "ORDER_CREATE",
      account: deployed.VaultBusinessLogic,
      label: "VaultBusinessLogic",
    },
    {
      roleName: "DEPOSIT",
      account: deployed.VaultBusinessLogic,
      label: "VaultBusinessLogic",
    },
  ]);
}

async function ensureLoanNftMinterRoles(deployed: DeployMap) {
  if (!deployed.AccessControlManager || !deployed.LendingEngine) return;
  const acm = await ethers.getContractAt(
    "AccessControlManager",
    deployed.AccessControlManager,
  );

  await ensureAcmRoles(acm, "LoanNFT minter roles", [
    {
      roleName: "BORROW",
      account: deployed.LendingEngine,
      label: "LendingEngine",
    },
  ]);
}

async function ensureVaultLendingEngineHealthRoles(deployed: DeployMap) {
  if (!deployed.AccessControlManager || !deployed.VaultLendingEngine) return;
  const acm = await ethers.getContractAt(
    "AccessControlManager",
    deployed.AccessControlManager,
  );

  await ensureAcmRoles(acm, "VaultLendingEngine health roles", [
    {
      roleName: "ACTION_VIEW_PUSH",
      account: deployed.VaultLendingEngine,
      label: "VaultLendingEngine",
    },
    {
      roleName: "VIEW_RISK_DATA",
      account: deployed.VaultLendingEngine,
      label: "VaultLendingEngine",
    },
  ]);
}

async function ensureLiquidationRiskManagerViewRole(deployed: DeployMap) {
  if (!deployed.AccessControlManager || !deployed.LiquidationRiskManager) return;
  const acm = await ethers.getContractAt(
    "AccessControlManager",
    deployed.AccessControlManager,
  );

  await ensureAcmRoles(acm, "LiquidationRiskManager read role", [
    {
      roleName: "VIEW_USER_DATA",
      account: deployed.LiquidationRiskManager,
      label: "LiquidationRiskManager",
    },
  ]);
}

async function ensureRewardBaselineInitialized(
  deployed: DeployMap,
  deployer: any,
) {
  if (!deployed.RewardManager || !deployed.EarnConfig) return;

  const rewardManager = await ethers.getContractAt(
    "RewardManager",
    deployed.RewardManager,
  );
  const earnConfig = await ethers.getContractAt(
    "EarnConfig",
    deployed.EarnConfig,
  );

  const currentLevel1 =
    (await earnConfig.getLevelMultiplierBps(1)) as bigint;
  const levelConfigUpdateBlock =
    (await earnConfig.getLevelConfigUpdateBlock()) as bigint;
  if (currentLevel1 !== 10_000n || levelConfigUpdateBlock === 0n) {
    await (
      await rewardManager.connect(deployer).setLevelMultiplier(1, 10_000)
    ).wait();
    console.log("🔧 Post-register init Reward level multiplier L1=10000 (1x)");
  } else {
    console.log("✅ Post-register Reward level multiplier L1 already initialized");
  }

  const [dynThreshold, dynMultiplier, dynUpdateBlock] =
    (await earnConfig.getDynamicRewardParams()) as [bigint, bigint, bigint];
  if (dynThreshold !== 0n || dynMultiplier !== 0n || dynUpdateBlock === 0n) {
    await (
      await rewardManager.connect(deployer).setDynamicRewardParams(0n, 0n)
    ).wait();
    console.log("🔧 Post-register init Reward dynamic params to off (0/0)");
  } else {
    console.log("✅ Post-register Reward dynamic params already initialized");
  }
}

async function getDeployerSignerOrThrow() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    throw new Error(
      "缺少可用部署账户。请配置 PRIVATE_KEY，并确认当前网络配置能为 arbitrumSepolia 生成 signer。",
    );
  }
  return deployer;
}

async function validateDeployerNativeBalance(
  minBalanceWei: bigint,
): Promise<void> {
  const deployer = await getDeployerSignerOrThrow();
  const provider = deployer.provider ?? ethers.provider;
  const balance = await provider.getBalance(deployer.address);
  console.log(`部署账户 Deployer: ${deployer.address}`);
  console.log(`账户余额 Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance < minBalanceWei) {
    throw new Error(
      `部署账户余额不足，至少需要 ${ethers.formatEther(minBalanceWei)} ETH 支付 Gas，当前仅有 ${ethers.formatEther(balance)} ETH`,
    );
  }
}

/**
 * 检查环境配置
 * Check environment configuration
 */
async function checkEnvironment(): Promise<void> {
  console.log("🔍 检查 Arbitrum Sepolia 环境配置...");
  console.log("🔍 Checking Arbitrum Sepolia environment...");

  const runtimeNet = await ethers.provider.getNetwork();
  const isLocalFork =
    network.name === "localhost" || network.name === "hardhat";

  if (!isLocalFork && !process.env.PRIVATE_KEY) {
    throw new Error("缺少必需的环境变量: PRIVATE_KEY");
  }

  if (isLocalFork) {
    console.log(
      "ℹ️ 当前为 localhost/hardhat fork，部署 signer 由 ethers.getSigners() 提供，不读取 PRIVATE_KEY。",
    );
  }

  if (!process.env.ARBISCAN_API_KEY) {
    console.log("⚠️ 建议配置环境变量: ARBISCAN_API_KEY");
  }

  try {
    if (
      !isLocalFork &&
      runtimeNet.chainId !== BigInt(ARBITRUM_SEPOLIA_CONFIG.chainId)
    ) {
      throw new Error(
        `网络配置错误，期望 Chain ID: ${ARBITRUM_SEPOLIA_CONFIG.chainId}，实际为 ${runtimeNet.chainId}`,
      );
    }
    console.log(
      `✅ 当前网络连接正常: ${network.name} (chainId=${runtimeNet.chainId})`,
    );
  } catch (error) {
    throw new Error("Arbitrum Sepolia 网络连接失败");
  }

  await validateDeployerNativeBalance(ethers.parseEther("0.01"));
}

/**
 * 备份钱包资产
 * Backup wallet assets
 */
async function backupWalletAssets(): Promise<void> {
  console.log("💾 备份钱包资产...");
  console.log("💾 Backing up wallet assets...");

  const [deployer] = await ethers.getSigners();
  const balance = await deployer.provider.getBalance(deployer.address);

  // 创建备份目录 Create backup directory
  const backupDir = path.join(__dirname, "../secrets/backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // 生成备份文件名（区块号口径） Generate backup filename (block-based)
  const backupBlock = await deployer.provider.getBlockNumber();
  const backupFile = path.join(
    backupDir,
    `arbitrum-sepolia-backup-${backupBlock}.json`,
  );

  // 保存备份信息 Save backup information
  const backupData = {
    blockNumber: backupBlock,
    network: ARBITRUM_SEPOLIA_CONFIG.name,
    deployer: deployer.address,
    balance: ethers.formatEther(balance),
    balanceWei: balance.toString(),
    chainId: ARBITRUM_SEPOLIA_CONFIG.chainId,
  };

  fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
  console.log(`✅ 钱包资产已备份到 Wallet assets backed up to: ${backupFile}`);
}

async function main() {
  console.log(`Network: ${network.name}`);
  await configureDynamicEip1559Fees({
    ethers,
    networkName: network.name,
    label: "deploy-arbitrum-sepolia",
  });
  // 确保 artifacts 可用：在脚本开始时编译（适配 CI/冷启动）
  try {
    await hre.run("compile");
  } catch (e) {
    console.log("⚠️ Compile step failed or skipped:", e);
  }
  const deployer = await getDeployerSignerOrThrow();
  console.log(`Deployer: ${deployer.address}`);

  const deployed: DeployMap = load();
  applySettlementOverrideToDeployMap(deployed);
  console.log(`📦 Deploy output file: ${DEPLOY_FILE}`);
  if (shouldFreshDeploy()) {
    console.log("🆕 Fresh deploy enabled: ignoring cached deploy output");
  }

  try {
    // 1. 环境检查 Environment check
    await checkEnvironment();

    // 2. 备份钱包资产 Backup wallet assets
    await backupWalletAssets();

    // 3. 部署 Registry（Scheme A：单一入口）
    // 建议最小延迟 2 天（测试网）
    const MIN_DELAY_BLOCKS = (2 * 24 * 60 * 60) / 2; // 2 days in blocks (2s baseline)
    const MAX_DELAY_BLOCKS = (7 * 24 * 60 * 60) / 2; // cap = 7 days in blocks (explicit blocks)

    if (!deployed.Registry) {
      // UUPS 可升级合约，使用 Proxy 部署并初始化
      deployed.Registry = await deployProxy("Registry", [
        MIN_DELAY_BLOCKS,
        MAX_DELAY_BLOCKS,
        deployer.address,
        deployer.address,
        deployer.address,
      ]);
      save(deployed);
    }

    // 部署动态模块键注册表
    if (!deployed.RegistryDynamicModuleKey) {
      try {
        deployed.RegistryDynamicModuleKey = await deployProxy(
          "RegistryDynamicModuleKey",
          [
            deployer.address, // registrationAdmin
            deployer.address, // systemAdmin
            deployer.address, // owner (OwnableUpgradeable)
          ],
        );
        save(deployed);
        console.log(
          "✅ RegistryDynamicModuleKey deployed @",
          deployed.RegistryDynamicModuleKey,
        );
      } catch (error) {
        console.log("⚠️ RegistryDynamicModuleKey deployment failed:", error);
      }
    }

    // 绑定 dynamic module key registry 到 Registry（可选）
    try {
      if (deployed.Registry && deployed.RegistryDynamicModuleKey) {
        const registry = await ethers.getContractAt(
          "Registry",
          deployed.Registry,
        );
        await (
          await registry.setDynamicModuleKeyRegistry(
            deployed.RegistryDynamicModuleKey,
          )
        ).wait();
        console.log("✅ Dynamic module key registry set in Registry");
      }
    } catch (error) {
      console.log("⚠️ Failed to set dynamic module key registry:", error);
    }

    // 4. 部署核心/视图/账本与支撑模块
    if (!deployed.AccessControlManager) {
      // 非升级合约（构造函数接收 owner）
      deployed.AccessControlManager = await deployRegular(
        "AccessControlManager",
        deployer.address,
      );
      save(deployed);
    }

    try {
      const registryForBootstrap = await ethers.getContractAt(
        "Registry",
        deployed.Registry,
      );
      await (
        await registryForBootstrap.setModule(
          keyOf("ACCESS_CONTROL_MANAGER"),
          deployed.AccessControlManager,
        )
      ).wait();
      console.log(
        "📌 Bootstrapped AccessControlManager -> ACCESS_CONTROL_MANAGER",
      );
    } catch (error) {
      console.log(
        "⚠️ AccessControlManager bootstrap registration skipped/failed:",
        error,
      );
    }

    // 统一缓存维护器（A 类模块地址缓存：统一刷新入口）
    if (!deployed.CacheMaintenanceManager) {
      try {
        deployed.CacheMaintenanceManager = await deployRegular(
          "src/registry/CacheMaintenanceManager.sol:CacheMaintenanceManager",
          deployed.Registry,
        );
        save(deployed);
        console.log(
          "✅ CacheMaintenanceManager deployed @",
          deployed.CacheMaintenanceManager,
        );
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

    // 为部署者赋权：ADMIN + 只读（VIEW_*）权限
    try {
      const acm = await ethers.getContractAt(
        "AccessControlManager",
        deployed.AccessControlManager,
      );
      const adminAddress = deployer.address;

      const roleNames = [
        "ACTION_ADMIN",
        // 读权限（全量覆盖）
        "VIEW_SYSTEM_DATA",
        "VIEW_USER_DATA",
        "VIEW_DEGRADATION_DATA",
        "VIEW_CACHE_DATA",
        "VIEW_PRICE_DATA",
        "VIEW_RISK_DATA",
        "VIEW_LIQUIDATION_DATA",
        // 事件/索引管理
        "MANAGE_EVENT_HISTORY",
        // 可选：查询管理
        "QUERY_MANAGER",
      ];
      const roleResults: Array<{
        roleName: string;
        outcome: EnsureRoleOutcome;
      }> = [];
      for (const r of roleNames) {
        try {
          roleResults.push({
            roleName: r,
            outcome: await ensureAcmRole(acm, r, adminAddress, "deployer"),
          });
        } catch (e) {
          console.log(`⚠️ Failed to ensure role ${r} for ${adminAddress}:`, e);
        }
      }
      logRoleEnsureSummary(
        "AccessControlManager bootstrap for deployer",
        roleResults,
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

    // 5. 部署预言机系统 Deploy oracle system
    if (!deployed.PriceOracle) {
      console.log("🔮 部署预言机系统...");
      console.log("🔮 Deploying Oracle System...");
      const [deployer] = await ethers.getSigners();

      // 1. 部署 PriceOracle（主预言机合约）
      console.log("🔮 部署 PriceOracle（主预言机合约）...");
      console.log("🔮 Deploying PriceOracle (Main Oracle Contract)...");
      // initialize(address initialRegistryAddr)
      deployed.PriceOracle = await deployProxy("PriceOracle", [
        deployed.Registry,
      ]);

      // 2. 部署 PriceUpdater（价格更新器）
      console.log("📊 部署 PriceUpdater（价格更新器）...");
      console.log("📊 Deploying PriceUpdater (Price Updater)...");
      // ⚠️ 注意：新版本只需要 Registry 地址
      deployed.PriceUpdater = await deployProxy(
        "PriceUpdater",
        [
          deployed.Registry, // initialRegistryAddr (新版本接口)
        ],
      );

      // 3. ValuationOracleAdapter 已废弃（DEPRECATED），不再部署

      // 4. 配置预言机系统权限
      console.log("🔐 配置预言机系统权限...");
      console.log("🔐 Configuring Oracle System Permissions...");

      try {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );

        // 为 PriceUpdater 授予 UPDATE_PRICE 权限
        await ensureAcmRole(
          acm,
          "UPDATE_PRICE",
          deployed.PriceUpdater,
          "PriceUpdater",
        );
        console.log("✅ PriceUpdater UPDATE_PRICE 权限已确认");

        // 为 deployer 授予 SET_PARAMETER 权限（用于配置资产）
        await ensureAcmRole(acm, "SET_PARAMETER", deployer.address, "deployer");
        console.log("✅ Deployer SET_PARAMETER 权限已确认");

        // 为 deployer 授予 ADD_WHITELIST 权限
        await ensureAcmRole(acm, "ADD_WHITELIST", deployer.address, "deployer");
        console.log("✅ Deployer ADD_WHITELIST 权限已确认");

        await ensureAcmRole(acm, "LIQUIDATE", deployer.address, "deployer");
        console.log("✅ Deployer LIQUIDATE 权限已确认");

        await ensureAcmRole(
          acm,
          "REMOVE_WHITELIST",
          deployer.address,
          "deployer",
        );
        console.log("✅ Deployer REMOVE_WHITELIST 权限已确认");
      } catch (error) {
        console.log("⚠️ 权限配置失败，可能已经配置过:", error);
      }

      // 5. 配置网络资产（通用配置文件驱动）
      console.log("📝 配置网络资产（配置文件驱动）...");
      try {
        const { assets, settlementAsset, source } = resolveConfiguredSettlementAsset();
        if (assets.length) {
          await configureAssets(
            ethers,
            deployed.PriceOracle,
            assets,
            deployed.PriceUpdater,
          );
          console.log(`✅ 已按配置文件添加/更新 ${assets.length} 个资产`);
          console.log(
            `✅ SettlementToken 选择: ${settlementAsset.address} (${source})`,
          );
        } else {
          console.log("ℹ️ 未检测到资产配置文件，跳过资产配置");
        }
      } catch (error) {
        console.log("⚠️ 资产配置失败:", error);
      }

      // 6. 验证预言机系统部署
      console.log("🔍 验证预言机系统部署...");
      console.log("🔍 Verifying Oracle System Deployment...");

      try {
        const priceOracle = await ethers.getContractAt(
          "PriceOracle",
          deployed.PriceOracle,
        );
        const assetCount = await priceOracle.getAssetCount();
        console.log(`✅ PriceOracle 支持的资产数量: ${assetCount}`);

        const supportedAssets = await priceOracle.getSupportedAssets();
        console.log(`✅ 支持的资产列表: ${supportedAssets.join(", ")}`);
      } catch (error) {
        console.log("⚠️ 预言机系统验证失败:", error);
      }

      save(deployed);
    }

    console.log("🔁 Reconciling oracle permissions and configured assets...");
    try {
      const [deployer] = await ethers.getSigners();
      const acm = await ethers.getContractAt(
        "AccessControlManager",
        deployed.AccessControlManager,
      );

      await ensureAcmRole(
        acm,
        "UPDATE_PRICE",
        deployed.PriceUpdater,
        "PriceUpdater",
      );
      await ensureAcmRole(acm, "SET_PARAMETER", deployer.address, "deployer");
      await ensureAcmRole(acm, "ADD_WHITELIST", deployer.address, "deployer");
      await ensureAcmRole(acm, "LIQUIDATE", deployer.address, "deployer");
      await ensureAcmRole(
        acm,
        "REMOVE_WHITELIST",
        deployer.address,
        "deployer",
      );

      const { assets, settlementAsset, source } = resolveConfiguredSettlementAsset();
      if (assets.length) {
        await configureAssets(
          ethers,
          deployed.PriceOracle,
          assets,
          deployed.PriceUpdater,
        );
        console.log(`✅ Oracle assets reconciled: ${assets.length}`);
        console.log(
          `✅ SettlementToken reconciliation target: ${settlementAsset.address} (${source})`,
        );
      } else {
        console.log("ℹ️ No configured assets found for oracle reconciliation");
      }
    } catch (error) {
      console.log("⚠️ Oracle reconciliation failed:", error);
    }

    if (!deployed.FeeRouter) {
      // platformBps / ecoBps：30 (=0.30%), 0 (=0.00%)
      deployed.FeeRouter = await deployProxy("FeeRouter", [
        deployed.Registry,
        deployer.address,
        deployer.address,
        30,
        0,
      ]);
      save(deployed);
    }

    try {
      await ensureConfiguredAssetsProtocolEnabled(deployed);
    } catch (error) {
      console.log("⚠️ Enable configured assets in protocol skipped/failed:", error);
    }

    // 5. 部署完整的奖励系统 Deploy complete reward system
    console.log("🎁 部署完整的奖励系统...");
    console.log("🎁 Deploying Complete Reward System...");

    // AI credits vault (on-chain credits SSOT)
    if (!deployed.AICreditsVault) {
      deployed.AICreditsVault = await deployProxy(
        "src/core/AICreditsVault.sol:AICreditsVault",
        [deployed.Registry],
      );
      save(deployed);
    }

    if (!deployed.RewardManagerCore) {
      deployed.RewardManagerCore = await deployProxy("RewardManagerCore", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    if (!deployed.RewardAccrualManager) {
      deployed.RewardAccrualManager = await deployProxy(
        "RewardAccrualManager",
        [deployed.Registry],
      );
      save(deployed);
    }

    if (!deployed.RewardManager) {
      console.log("🎮 部署奖励管理合约...");
      deployed.RewardManager = await deployProxy("RewardManager", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    if (!deployed.RewardConfig) {
      deployed.RewardConfig = await deployProxy("RewardConfig", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    if (!deployed.EarnConfig) {
      deployed.EarnConfig = await deployProxy("EarnConfig", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    if (!deployed.RewardView) {
      deployed.RewardView = await deployProxy("RewardView", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    const easyTeamRecipient =
      process.env.EASY_TEAM_RECIPIENT || deployer.address;
    const easyEcoRecipient = process.env.EASY_ECO_RECIPIENT || deployer.address;

    if (!deployed.EasyToken) {
      deployed.EasyToken = await deployProxy(
        "src/Token/EasyToken.sol:EasyToken",
        [deployer.address],
      );
      save(deployed);
    }

    if (!deployed.EasyEmissionConfig) {
      deployed.EasyEmissionConfig = await deployProxy("EasyEmissionConfig", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    if (!deployed.EasyEmissionController) {
      deployed.EasyEmissionController = await deployProxy(
        "EasyEmissionController",
        [deployed.Registry],
      );
      save(deployed);
    }

    if (!deployed.EasyConsumption) {
      deployed.EasyConsumption = await deployProxy("EasyConsumption", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    if (!deployed.EasyRecycleDistributor) {
      deployed.EasyRecycleDistributor = await deployProxy(
        "EasyRecycleDistributor",
        [deployed.Registry, easyTeamRecipient, easyEcoRecipient],
      );
      save(deployed);
    }

    if (!deployed.EasyStaking) {
      deployed.EasyStaking = await deployProxy(
        "src/Governance/EasyStaking.sol:EasyStaking",
        [deployed.Registry],
      );
      save(deployed);
    }

    // Governance modules (SSOT: gate + guardian + cross-chain governance)
    // SSOT note:
    // - Target state is one-token: reward token == EasyToken (Registry[KEY_EASY_TOKEN]).
    // - Governance votes token is stEASY (Registry[KEY_EASY_STAKING]) when EasyStaking is deployed.
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

    if (!deployed.CrossChainGovernance) {
      try {
        deployed.CrossChainGovernance = await deployProxy(
          "src/Governance/CrossChainGovernance.sol:CrossChainGovernance",
          [deployer.address, deployed.Registry],
          { unsafeAllow: ["constructor"] },
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ CrossChainGovernance deployment failed:", error);
      }
    }

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
        const SET_PARAMETER = ethers.keccak256(
          ethers.toUtf8Bytes("SET_PARAMETER"),
        );
        if (deployed.RewardConfig) {
          const has = await acm.hasRole(SET_PARAMETER, deployed.RewardConfig);
          if (!has)
            await (
              await acm.grantRole(SET_PARAMETER, deployed.RewardConfig)
            ).wait();
        }

        // Break-glass (revocable): DO NOT auto-grant on non-localhost networks.
        // If needed, explicitly set `REWARD_CONFIG_EMERGENCY_GRANTEE` to a timelock/multisig for temporary usage.
        const emergencyGrantee = process.env.REWARD_CONFIG_EMERGENCY_GRANTEE;
        if (emergencyGrantee && emergencyGrantee !== ethers.ZeroAddress) {
          await ensureRewardConfigEmergencyGranted(acm, emergencyGrantee);
        }

        // Non-localhost default hardening: always ensure deployer break-glass is revoked.
        await ensureRewardConfigEmergencyRevoked(acm, deployer.address);
      }
    } catch (e) {
      console.log("⚠️ Reward governance role grants skipped/failed:", e);
    }

    // EasyToken role wiring (target state):
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
      }
    } catch (error) {
      console.log("⚠️ EasyToken role setup failed:", error);
    }

    // 6. 部署 Vault 系统 Deploy Vault system
    // CollateralManager（CM）
    if (!deployed.CollateralManager) {
      deployed.CollateralManager = await deployProxy("CollateralManager", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    // LendingEngine（核心账本）
    if (!deployed.LendingEngine) {
      deployed.LendingEngine = await deployProxy("LendingEngine", [
        deployed.Registry,
      ]);
      save(deployed);
    }

    // LiquidationManager（轻量清算入口，方案B：直达账本 + View 单点推送）
    if (!deployed.LiquidationManager) {
      try {
        deployed.LiquidationManager = await deployProxy("LiquidationManager", [
          deployed.Registry,
        ]);
        save(deployed);
        console.log(
          "✅ LiquidationManager deployed @",
          deployed.LiquidationManager,
        );
      } catch (error) {
        console.log("⚠️ LiquidationManager deployment failed:", error);
      }
    }

    // SettlementManager（统一结算/清算写入口，SSOT）
    if (!deployed.SettlementManager) {
      try {
        deployed.SettlementManager = await deployProxy("SettlementManager", [
          deployed.Registry,
        ]);
        save(deployed);
        console.log(
          "✅ SettlementManager deployed @",
          deployed.SettlementManager,
        );
      } catch (error) {
        console.log("⚠️ SettlementManager deployment failed:", error);
      }
    }

    // LenderPoolVault（线上流动性资金池，推荐）
    if (!deployed.LenderPoolVault) {
      try {
        deployed.LenderPoolVault = await deployProxy("LenderPoolVault", [
          deployed.Registry,
        ]);
        save(deployed);
        console.log("✅ LenderPoolVault deployed @", deployed.LenderPoolVault);
      } catch (error) {
        console.log("⚠️ LenderPoolVault deployment failed:", error);
      }
    }

    if (!deployed.BlocksOnlyCoordinator) {
      try {
        deployed.BlocksOnlyCoordinator = await deployProxy(
          "BlocksOnlyCoordinator",
          [deployed.Registry],
        );
        save(deployed);
        console.log(
          "✅ BlocksOnlyCoordinator deployed @",
          deployed.BlocksOnlyCoordinator,
        );
      } catch (error) {
        console.log("⚠️ BlocksOnlyCoordinator deployment failed:", error);
      }
    }

    if (!deployed.BlocksOnlyView) {
      try {
        deployed.BlocksOnlyView = await deployProxy("BlocksOnlyView", [
          deployed.Registry,
        ]);
        save(deployed);
        console.log("✅ BlocksOnlyView deployed @", deployed.BlocksOnlyView);
        // Blocks-only rollout note:
        // - BlocksOnlyCoordinator is the dedicated write boundary for the current one-block product.
        // - BlocksOnlyView is the dedicated permissioned read surface for borrower/system pagination and runtime flags.
        // - These modules should be consumed as a separate product lane, not folded back into legacy day-bucket routing.
      } catch (error) {
        console.log("⚠️ BlocksOnlyView deployment failed:", error);
      }
    }

    // 若未显式提供 PAYOUT_LENDER_ADDR，则默认将 lenderCompensation 指向 LenderPoolVault（与“lender=资金池地址”语义一致）
    if (!process.env.PAYOUT_LENDER_ADDR && deployed.LenderPoolVault) {
      payoutRecipients = {
        ...payoutRecipients,
        lenderCompensation: deployed.LenderPoolVault,
      };
    }

    // 4.99.2) 部署 LiquidationPayoutManager（残值分配）
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
        console.log(
          "✅ LiquidationPayoutManager deployed @",
          deployed.LiquidationPayoutManager,
        );
      } catch (error) {
        console.log("⚠️ LiquidationPayoutManager deployment failed:", error);
      }
    }

    // 授权 SettlementManager 执行订单级还款与只读查询（ORDER_ENGINE.repay / getLoanOrderForView）
    try {
      if (deployed.AccessControlManager && deployed.SettlementManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
          const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes("REPAY"));
          const ACTION_LIQUIDATE = ethers.keccak256(
            ethers.toUtf8Bytes("LIQUIDATE"),
          );
        const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_SYSTEM_DATA"),
        );
          const ACTION_VIEW_RISK_DATA = ethers.keccak256(
            ethers.toUtf8Bytes("VIEW_RISK_DATA"),
          );

          const hasLiquidate = await acm.hasRole(
            ACTION_LIQUIDATE,
            deployed.SettlementManager,
          );
          if (!hasLiquidate) {
            await (
              await acm.grantRole(ACTION_LIQUIDATE, deployed.SettlementManager)
            ).wait();
            console.log("🔑 Granted ACTION_LIQUIDATE to SettlementManager");
          }

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
        "⚠️ Grant ACTION_LIQUIDATE/REPAY/VIEW_* to SettlementManager skipped/failed:",
        e,
      );
    }

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

        // Coordinator needs both permissions because current blocks-only maturity handling is self-contained:
        // it reads risk/valuation state and, if repayment did not clear the order, can directly trigger liquidation.
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

    // 授权 LiquidationManager 与 GuaranteeFundManager 路由平台费到 FeeRouter（ACTION_DEPOSIT）
    try {
      if (deployed.AccessControlManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
          const ACTION_LIQUIDATE = ethers.keccak256(
            ethers.toUtf8Bytes("LIQUIDATE"),
          );
        const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));

        if (deployed.LiquidationManager) {
            const hasLiquidate = await acm.hasRole(
              ACTION_LIQUIDATE,
              deployed.LiquidationManager,
            );
            if (!hasLiquidate) {
              await (
                await acm.grantRole(ACTION_LIQUIDATE, deployed.LiquidationManager)
              ).wait();
              console.log("🔑 Granted ACTION_LIQUIDATE to LiquidationManager");
            }

          const hasLm = await acm.hasRole(
            ACTION_DEPOSIT,
            deployed.LiquidationManager,
          );
          if (!hasLm) {
            await (
              await acm.grantRole(ACTION_DEPOSIT, deployed.LiquidationManager)
            ).wait();
            console.log("🔑 Granted ACTION_DEPOSIT to LiquidationManager");
          }
        }

        if (deployed.GuaranteeFundManager) {
          const hasGfm = await acm.hasRole(
            ACTION_DEPOSIT,
            deployed.GuaranteeFundManager,
          );
          if (!hasGfm) {
            await (
              await acm.grantRole(ACTION_DEPOSIT, deployed.GuaranteeFundManager)
            ).wait();
            console.log("🔑 Granted ACTION_DEPOSIT to GuaranteeFundManager");
          }
        }
      }
    } catch (e) {
      console.log(
        "⚠️ Grant ACTION_LIQUIDATE/DEPOSIT to LiquidationManager/GuaranteeFundManager skipped/failed:",
        e,
      );
    }

    // LiquidationRiskManager（清算风险管理器）
    // 依赖 Registry 中的 COLLATERAL_MANAGER / LENDING_ENGINE / HEALTH_VIEW，
    // 因此只在 HealthView 就绪后的 late retry 阶段部署，避免无效初始化重试。

    // VaultLendingEngine（Vault借贷引擎）
    if (!deployed.VaultLendingEngine) {
      try {
        const { settlementAsset, source } = resolveConfiguredSettlementAsset();
        if (!deployed.SettlementToken) {
          deployed.SettlementToken = settlementAsset.address;
          save(deployed);
        }
        console.log(
          `ℹ️ VaultLendingEngine 使用 SettlementToken=${deployed.SettlementToken} (${source})`,
        );
        // FeeRouter 必须显式支持 settlementToken，否则分发会 TokenNotSupported（Architecture-Guide SSOT）
        await ensureFeeRouterSupportedToken(
          deployed.FeeRouter,
          deployed.SettlementToken,
          "SettlementToken",
        );
        deployed.VaultLendingEngine = await deployProxy(
          "src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine",
          [deployed.PriceOracle, deployed.SettlementToken, deployed.Registry],
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

    // VaultBusinessLogic + VaultRouter + VaultCore
    if (!deployed.VaultBusinessLogic) {
      if (!deployed.SettlementToken) {
        const { settlementAsset, source } = resolveConfiguredSettlementAsset();
        deployed.SettlementToken = settlementAsset.address;
        console.log(
          `ℹ️ VaultBusinessLogic 使用 SettlementToken=${deployed.SettlementToken} (${source})`,
        );
        save(deployed);
      }
      deployed.VaultBusinessLogic = await deployProxy("VaultBusinessLogic", [
        deployed.Registry,
        deployed.SettlementToken,
      ]);
      save(deployed);
    }

    // 部署 VaultRouter（UUPS Proxy，严格对齐 Architecture-Guide：本地存储 + UUPS）
    // 注意：VaultCore.initialize(registry, viewAddr) 需要最终 VaultRouter 地址，因此必须先部署 VaultRouter。
    if (!deployed.VaultRouter) {
      if (!deployed.SettlementToken) {
        throw new Error(
          "Missing SettlementToken (required for VaultRouter.initialize)",
        );
      }
      deployed.VaultRouter = await deployProxy(
        "src/Vault/VaultRouter.sol:VaultRouter",
        [
          deployed.Registry,
          deployed.AssetWhitelist,
          deployed.PriceOracle,
          deployed.SettlementToken,
          deployer.address, // owner (testnet: recommend multisig/timelock)
        ],
      );
      save(deployed);
    }

    try {
      await ensureVaultRouterOperationalRoles(deployed);
    } catch (error) {
      console.log("⚠️ Grant VaultRouter operational roles skipped/failed:", error);
    }

    try {
      await ensureVaultBusinessLogicMatchRoles(deployed);
    } catch (error) {
      console.log("⚠️ Grant VaultBusinessLogic match roles skipped/failed:", error);
    }

    try {
      await ensureLoanNftMinterRoles(deployed);
    } catch (error) {
      console.log("⚠️ Grant LoanNFT minter roles skipped/failed:", error);
    }

    try {
      await ensureVaultLendingEngineHealthRoles(deployed);
    } catch (error) {
      console.log(
        "⚠️ Grant VaultLendingEngine health roles skipped/failed:",
        error,
      );
    }

    if (!deployed.VaultCore) {
      // VaultCore.initialize(registry, view)
      deployed.VaultCore = await deployProxy("VaultCore", [
        deployed.Registry,
        deployed.VaultRouter,
      ]);
      save(deployed);
    }

    // GuaranteeFundManager
    if (!deployed.GuaranteeFundManager) {
      try {
        // initialize(address vaultCore, address registry, address upgradeAdmin)
        deployed.GuaranteeFundManager = await deployProxy(
          "GuaranteeFundManager",
          [
            deployed.VaultCore || ethers.ZeroAddress,
            deployed.Registry,
            deployer.address,
          ],
        );
        save(deployed);
      } catch (error) {
        console.log("⚠️ GuaranteeFundManager deployment failed:", error);
      }
    }

    try {
      if (deployed.AccessControlManager && deployed.GuaranteeFundManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
        const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
        const hasGfmDeposit = await acm.hasRole(
          ACTION_DEPOSIT,
          deployed.GuaranteeFundManager,
        );
        if (!hasGfmDeposit) {
          await (
            await acm.grantRole(ACTION_DEPOSIT, deployed.GuaranteeFundManager)
          ).wait();
          console.log("🔑 Granted ACTION_DEPOSIT to GuaranteeFundManager (post-deploy)");
        }
      }
    } catch (error) {
      console.log(
        "⚠️ Post-deploy ACTION_DEPOSIT grant for GuaranteeFundManager skipped/failed:",
        error,
      );
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

    if (
      !deployed.LiquidationRiskManager &&
      deployed.CollateralManager &&
      deployed.VaultLendingEngine &&
      deployed.HealthView
    ) {
      try {
        const registryForRiskBootstrap = await ethers.getContractAt(
          "Registry",
          deployed.Registry,
        );
        await (
          await registryForRiskBootstrap.setModule(
            keyOf("COLLATERAL_MANAGER"),
            deployed.CollateralManager,
          )
        ).wait();
        await (
          await registryForRiskBootstrap.setModule(
            keyOf("LENDING_ENGINE"),
            deployed.VaultLendingEngine,
          )
        ).wait();
        await (
          await registryForRiskBootstrap.setModule(
            keyOf("HEALTH_VIEW"),
            deployed.HealthView,
          )
        ).wait();

        deployed.LiquidationRiskManager = await deployProxy(
          "src/Vault/liquidation/modules/LiquidationRiskManager.sol:LiquidationRiskManager",
          [deployed.Registry, deployed.AccessControlManager, 300, 50],
        );
        save(deployed);
        console.log(
          "✅ LiquidationRiskManager deployed (late retry) @",
          deployed.LiquidationRiskManager,
        );
      } catch (error) {
        console.log("⚠️ LiquidationRiskManager late retry failed:", error);
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
        await ensureAcmRole(acm, "VIEW_SYSTEM_DATA", deployed.SystemView);
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

    // Grant VIEW_* roles to StatisticsPushManager so it can read PositionView valuations.
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
          const alreadySystem = await acm.hasRole(
            VIEW_SYSTEM_DATA,
            deployed.StatisticsPushManager,
          );
          if (!alreadySystem) {
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
        const already = await acm.hasRole(
          VIEW_PRICE_DATA,
          deployed.StatisticsPushManager,
        );
        if (!already) {
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
      console.log(
        "⚠️ Grant VIEW_*_DATA to StatisticsPushManager skipped/failed:",
        e,
      );
    }

    // Strict B+ protocol flow cache: LoanFlowView + LoanFlowPushManager (USD-8 SSOT)
    // - LendingEngine best-effort notifies LoanFlowPushManager on borrow/repay.
    // - RewardManagerCore / EasyEmissionController read LoanFlowView during reward flows.
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
        deployed.PositionView = await deployProxy("PositionView", [
          deployed.Registry,
        ]);
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

    const feeRouterViewFromRegistry = await lookupRegistryModule(
      deployed.Registry,
      "FEE_ROUTER_VIEW",
    );
    if (!deployed.FeeRouterView && feeRouterViewFromRegistry) {
      deployed.FeeRouterView = feeRouterViewFromRegistry;
      save(deployed);
      console.log(
        `ℹ️ FeeRouterView recovered from Registry: ${deployed.FeeRouterView}`,
      );
    }
    if (
      deployed.FeeRouterView &&
      feeRouterViewFromRegistry &&
      deployed.FeeRouterView.toLowerCase() !== feeRouterViewFromRegistry.toLowerCase()
    ) {
      throw new Error(
        `FeeRouterView address mismatch between deploy output (${deployed.FeeRouterView}) and Registry (${feeRouterViewFromRegistry})`,
      );
    }
    if (shouldUpgradeFeeRouterView()) {
      if (!deployed.FeeRouterView) {
        throw new Error(
          "UPGRADE_FEE_ROUTER_VIEW=1 was set, but no existing FeeRouterView proxy was found in deploy output or Registry",
        );
      }
      try {
        const result = await upgradeProxyAndVerify(
          "FeeRouterView",
          deployed.FeeRouterView,
        );
        deployed.FeeRouterView = result.proxy;
        save(deployed);
      } catch (error) {
        console.log("⚠️ FeeRouterView upgrade failed:", error);
        throw error;
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

    // LiquidationRiskView（清算风险只读视图，UUPS Proxy + initialize）
    if (!deployed.LiquidationRiskView) {
      try {
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
        console.log(
          "✅ DegradationMonitor deployed @ " + deployed.DegradationMonitor,
        );
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

    // 授予视图聚合器内部调用所需的只读权限。
    // 这些模块会以合约自身作为 msg.sender 去调用下游 View，live 链也需要与 localhost 相同的角色绑定。
    try {
      await ensureLiveSafeViewModuleRoles(deployed);
    } catch (error) {
      console.log(
        "⚠️ Grant view roles to aggregator/view modules skipped/failed:",
        error,
      );
    }

    // LiquidatorView（需要 SystemView）
    if (!deployed.LiquidatorView) {
      // 第二个参数为历史兼容位（LiquidatorView.initialize 的 legacy SystemView），不再使用，这里使用非零占位（Registry）
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

    // 7) 注册模块到 Registry（通过 NAME -> UPPER_SNAKE -> bytes32 key）
    const registry = await ethers.getContractAt("Registry", deployed.Registry);

    const NAME_TO_KEY: Record<string, string> = {
      // ModuleKeys.KEY_DYNAMIC_MODULE_REGISTRY = keccak256("DYNAMIC_MODULE_REGISTRY")
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
      // core/LendingEngine is the OrderEngine -> ModuleKeys.KEY_ORDER_ENGINE = keccak256("ORDER_ENGINE")
      LendingEngine: "ORDER_ENGINE",
      LendingEngineView: "LENDING_ENGINE_VIEW",
      LoanNFTView: "LOAN_NFT_VIEW",
      VaultBusinessLogic: "VAULT_BUSINESS_LOGIC",
      VaultCore: "VAULT_CORE",
      // VaultRouter: 'VAULT_VIEW', // 架构建议通过 KEY_VAULT_CORE 解析，不强依赖
      // VaultLendingEngine is the ledger engine -> ModuleKeys.KEY_LE = keccak256("LENDING_ENGINE")
      VaultLendingEngine: "LENDING_ENGINE",
      EarlyRepaymentGuaranteeManager: "EARLY_REPAYMENT_GUARANTEE_MANAGER",
      HealthView: "HEALTH_VIEW",
      // 不注册未部署的 RWA Token
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
      // ModuleKeys.KEY_LIQUIDATION_VIEW = keccak256("LIQUIDATION_VIEW")
      LiquidatorView: "LIQUIDATION_VIEW",
      LiquidationManager: "LIQUIDATION_MANAGER",
      SettlementManager: "SETTLEMENT_MANAGER",
      LiquidationPayoutManager: "LIQUIDATION_PAYOUT_MANAGER",
      LenderPoolVault: "LENDER_POOL_VAULT",
      BlocksOnlyCoordinator: "BLOCKS_ONLY_COORDINATOR",
      BlocksOnlyView: "BLOCKS_ONLY_VIEW",
      GuaranteeFundManager: "GUARANTEE_FUND_MANAGER",
      LoanNFT: "LOAN_NFT",
      // 监控模块
      DegradationCore: "DEGRADATION_CORE",
      DegradationMonitor: "DEGRADATION_MONITOR",
      DegradationStorage: "DEGRADATION_STORAGE",
      ModuleHealthView: "MODULE_HEALTH_VIEW",
      BatchView: "BATCH_VIEW",
      LiquidationRiskView: "LIQUIDATION_RISK_VIEW",
    };

    // 实际注册的模块清单（只注册已部署的）
    const modules = [
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
      "RegistryDynamicModuleKey", // 添加动态模块键注册表
    ];

    for (const name of modules) {
      const addr = deployed[name];
      if (!addr) continue;
      const upperSnake = NAME_TO_KEY[name];
      if (!upperSnake) continue;
      try {
        await (await registry.setModule(keyOf(upperSnake), addr)).wait();
        console.log(`📌 Registered ${name} -> ${registryLabel(upperSnake)}`);
      } catch (e) {
        console.log(`⚠️ Skip register ${name}:`, e);
      }
    }

    // RewardConfig -> EarnConfig 的治理转发依赖 Registry[REWARD_EARN_CONFIG]。
    // 因此基线初始化必须在模块注册完成后执行，避免 fresh live deploy 出现 RewardView 只读配置永久无效。
    try {
      await ensureRewardBaselineInitialized(deployed, deployer);
    } catch (e) {
      console.log("⚠️ Post-register Reward baseline init skipped/failed:", e);
    }

    // 补充：若存在 LiquidationRiskManager，但未在映射中，则单独注册到 KEY_LIQUIDATION_RISK_MANAGER
    if (deployed.LiquidationRiskManager) {
      try {
        await (
          await registry.setModule(
            keyOf("LIQUIDATION_RISK_MANAGER"),
            deployed.LiquidationRiskManager,
          )
        ).wait();
        console.log(
          "📌 Registered LiquidationRiskManager -> LIQUIDATION_RISK_MANAGER",
        );
      } catch (e) {
        console.log("⚠️ Skip register LiquidationRiskManager:", e);
      }
    }

    try {
      await ensureLiquidationRiskManagerViewRole(deployed);
    } catch (e) {
      console.log(
        "⚠️ Grant VIEW_USER_DATA to LiquidationRiskManager skipped/failed:",
        e,
      );
    }

    // 设置动态模块键注册表到Registry
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

    try {
      await ensureRegistryModuleBound(
        registry,
        "SETTLEMENT_TOKEN",
        deployed.SettlementToken,
        "SettlementToken",
      );
    } catch (error) {
      console.log("⚠️ SettlementToken hard rebind failed:", error);
      throw error;
    }

    try {
      await reconcileVaultLendingEngineSettlementToken(deployed);
    } catch (error) {
      console.log("⚠️ VaultLendingEngine settlement-token reconciliation failed:", error);
      throw error;
    }

    // VaultRouter 已在 VaultCore 之前部署（见上），这里不再重复部署

    // 3.1 附加绑定：将 KEY_LIQUIDATION_MANAGER 绑定到 VaultBusinessLogic（统一清算入口）
    try {
      if (deployed.LiquidationManager) {
        await (
          await registry.setModule(
            keyOf("LIQUIDATION_MANAGER"),
            deployed.LiquidationManager,
          )
        ).wait();
        console.log(
          `✅ Bound KEY_LIQUIDATION_MANAGER -> ${deployed.LiquidationManager}`,
        );
      }
      if (deployed.SettlementManager) {
        try {
          await (
            await registry.setModule(
              keyOf("SETTLEMENT_MANAGER"),
              deployed.SettlementManager,
            )
          ).wait();
          console.log(
            `✅ Bound KEY_SETTLEMENT_MANAGER -> ${deployed.SettlementManager}`,
          );
        } catch (error) {
          console.log("⚠️ SettlementManager binding failed:", error);
        }
      }
      if (deployed.HealthView) {
        try {
          await (
            await registry.setModule(keyOf("HEALTH_VIEW"), deployed.HealthView)
          ).wait();
        } catch (error) {
          console.log("⚠️ HealthView binding failed:", error);
        }
      }
      if (deployed.LiquidatorView) {
        try {
          await (
            await registry.setModule(
              keyOf("LIQUIDATION_VIEW"),
              deployed.LiquidatorView,
            )
          ).wait();
        } catch (error) {
          console.log("⚠️ LiquidatorView binding failed:", error);
        }
        if (deployed.LiquidationPayoutManager) {
          try {
            await (
              await registry.setModule(
                keyOf("LIQUIDATION_PAYOUT_MANAGER"),
                deployed.LiquidationPayoutManager,
              )
            ).wait();
          } catch (error) {
            console.log("⚠️ LiquidationPayoutManager binding failed:", error);
          }
        }
      }
      if (deployed.StatisticsView) {
        try {
          await (
            await registry.setModule(
              keyOf("VAULT_STATISTICS"),
              deployed.StatisticsView,
            )
          ).wait();
          console.log(
            `✅ Bound KEY_STATS (VAULT_STATISTICS) -> ${deployed.StatisticsView}`,
          );
        } catch (error) {
          console.log("⚠️ StatisticsView binding failed:", error);
        }
      }
    } catch (e) {
      console.log("⚠️ Extra KEY binding failed:", e);
    }

    // Enable gate + guardian resolution in CrossChainGovernance only after Registry bindings exist.
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

    // 3.2 断言校验（严格版）：
    // - 禁止引入 KEY_VAULT_VIEW（多来源）；VaultRouter 的权威来源是 VaultCore.viewContractAddrVar()
    try {
      if (!deployed.VaultCore || !deployed.VaultRouter)
        throw new Error("Missing VaultCore or VaultRouter address");

      const code = await ethers.provider.getCode(deployed.VaultCore);
      console.log(
        "🔎 VaultCore @",
        deployed.VaultCore,
        "codeLen =",
        code.length,
      );
      if (!code || code === "0x")
        throw new Error("VaultCore address has no code");

      const vaultCore = await ethers.getContractAt(
        "VaultCore",
        deployed.VaultCore,
      );
      const viewAddr = await vaultCore.viewContractAddrVar();
      if (!viewAddr || viewAddr === ethers.ZeroAddress)
        throw new Error("VaultCore.viewContractAddrVar() is zero");
      if (viewAddr.toLowerCase() !== deployed.VaultRouter.toLowerCase()) {
        throw new Error(
          `VaultCore.viewContractAddrVar mismatch: core=${viewAddr} expected VaultRouter=${deployed.VaultRouter}`,
        );
      }
      console.log(
        "✅ Architecture check: VaultCore.viewContractAddrVar matches deployed VaultRouter",
      );
    } catch (e) {
      // strict: fail fast on testnet deployment
      throw e;
    }

    // 4) 生成前端配置
    fs.mkdirSync(FRONTEND_DIR, { recursive: true });
    const frontendContent = `// 自动生成的合约配置文件 - Arbitrum Sepolia
// Auto-generated contract configuration file - Arbitrum Sepolia
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
  chainId: ${ARBITRUM_SEPOLIA_CONFIG.chainId},
  rpcUrl: '${ARBITRUM_SEPOLIA_CONFIG.rpcUrl}',
  explorer: '${ARBITRUM_SEPOLIA_CONFIG.explorer}',
  name: '${ARBITRUM_SEPOLIA_CONFIG.name}'
};

// 使用示例 Usage example:
// import { CONTRACT_ADDRESSES, NETWORK_CONFIG } from './contracts-arbitrum-sepolia';
// const vaultCoreAddress = CONTRACT_ADDRESSES.VaultCore;
`;
    fs.writeFileSync(FRONTEND_FILE, frontendContent);
    console.log(`📝 Frontend config written: ${FRONTEND_FILE}`);

    // 5) 输出摘要
    console.log("\n==== Deployment Addresses (arbitrum-sepolia) ====");
    Object.entries(deployed).forEach(([n, a]) => console.log(`${n}: ${a}`));
    console.log("========================================\n");
  } catch (error) {
    console.error("❌ 部署失败 Deployment failed:", error);
    throw error;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Arbitrum 主网部署脚本（符合 contracts/docs/Architecture-Guide.md）
 * Arbitrum Mainnet Deployment Script
 * - 部署 Registry（单一入口 / 单一 Proxy，Scheme A）
 * - 部署并注册核心业务与视图模块
 * - 写入 deployments/arbitrum.json 与 frontend-config/contracts-arbitrum.ts
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

// Must run BEFORE requiring Hardhat to prevent redraw-style output from polluting logs.
initStableDeploymentOutput();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const hre = require("hardhat");
const { ethers, upgrades, network } = hre;

type DeployMap = Record<string, string>;
type EnsureRoleOutcome = "granted" | "already-granted";

/**
 * Arbitrum 主网配置
 * Arbitrum Mainnet configuration
 */
const ARBITRUM_CONFIG = {
  name: "arbitrum",
  chainId: 42161,
  rpcUrl: "https://arb1.arbitrum.io/rpc",
  explorer: "https://arbiscan.io",
};

const DEPLOY_DIR = path.join(__dirname, "..", "deployments");
const DEPLOY_FILE = path.join(DEPLOY_DIR, "arbitrum.json");
// 将前端配置输出到当前仓库的 frontend-config，避免写到工作区外部路径
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend-config");
const FRONTEND_FILE = path.join(FRONTEND_DIR, "contracts-arbitrum.ts");
const CANONICAL_FRONTEND_FILE = path.join(FRONTEND_DIR, "networks", "arbitrum.ts");
const DEFAULT_PAYOUT_BPS = {
  platform: 300,
  reserve: 200,
  lender: 1700,
  liquidator: 7800,
};

function resolveConfiguredSettlementAsset() {
  return resolveSettlementAssetConfig(
    ARBITRUM_CONFIG.name,
    ARBITRUM_CONFIG.chainId,
  );
}

function load(): DeployMap {
  if (fs.existsSync(DEPLOY_FILE))
    return JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf8")) as DeployMap;
  return {};
}

function save(map: DeployMap) {
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  fs.writeFileSync(DEPLOY_FILE, JSON.stringify(map, null, 2));
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
  console.log(`✅ VaultRouter FeeRouterView bound -> ${after}`);
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

async function ensureVaultLendingEngineHealthRoles(deployed: DeployMap) {
  if (!deployed.AccessControlManager || !deployed.VaultLendingEngine) return;

  const acm = await ethers.getContractAt(
    "AccessControlManager",
    deployed.AccessControlManager,
  );
  const results = [
    {
      roleName: "ACTION_VIEW_PUSH",
      outcome: await ensureAcmRole(
        acm,
        "ACTION_VIEW_PUSH",
        deployed.VaultLendingEngine,
        "VaultLendingEngine",
      ),
    },
    {
      roleName: "VIEW_RISK_DATA",
      outcome: await ensureAcmRole(
        acm,
        "VIEW_RISK_DATA",
        deployed.VaultLendingEngine,
        "VaultLendingEngine",
      ),
    },
  ];
  logRoleEnsureSummary("VaultLendingEngine health roles", results);
}

async function validateDeployerNativeBalance(
  minBalanceWei: bigint,
): Promise<void> {
  const [deployer] = await ethers.getSigners();
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
  console.log("🔍 检查 Arbitrum 主网环境配置...");
  console.log("🔍 Checking Arbitrum Mainnet environment...");

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
      runtimeNet.chainId !== BigInt(ARBITRUM_CONFIG.chainId)
    ) {
      throw new Error(
        `网络配置错误，期望 Chain ID: ${ARBITRUM_CONFIG.chainId}，实际为 ${runtimeNet.chainId}`,
      );
    }
    console.log(
      `✅ 当前网络连接正常: ${network.name} (chainId=${runtimeNet.chainId})`,
    );
  } catch (error) {
    throw new Error("Arbitrum 主网连接失败");
  }

  await validateDeployerNativeBalance(ethers.parseEther("0.01"));
}

async function main() {
  console.log(`Network: ${network.name}`);
  // 确保 artifacts 可用：在脚本开始时编译（适配 CI/冷启动）
  try {
    await hre.run("compile");
  } catch (e) {
    console.log("⚠️ Compile step failed or skipped:", e);
  }
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const deployed: DeployMap = load();

  try {
    // 1. 环境检查
    await checkEnvironment();

    // 2. 部署 Registry（Scheme A：单一入口）
    // 主网建议最小延迟 7 天（更保守）
    const MIN_DELAY_BLOCKS = (7 * 24 * 60 * 60) / 2; // 7 days in blocks (2s baseline)
    const MAX_DELAY_BLOCKS = MIN_DELAY_BLOCKS; // cap = 7 days (explicit blocks)

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

    // 3. 部署核心/视图/账本与支撑模块
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

    // 配置预言机系统权限
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

    // 配置网络资产（通用配置文件驱动）
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

    // 4. 部署 Vault 系统（从配置文件读取真实代币地址，不使用 Mock）
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
          deployer.address, // owner (mainnet: MUST be multisig/timelock)
        ],
      );
      save(deployed);
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
        const VIEW_PRICE_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_PRICE_DATA"),
        );
        const VIEW_RISK_DATA = ethers.keccak256(
          ethers.toUtf8Bytes("VIEW_RISK_DATA"),
        );
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

    // Strict B+ protocol flow cache: LoanFlowView + LoanFlowPushManager (value SSOT)
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

    // ====== 奖励系统（完整）======
    // SSOT note:
    // - Target state is one-token: reward token == EasyToken (Registry[KEY_EASY_TOKEN]).
    // - Governance votes token is stEASY (Registry[KEY_EASY_STAKING]) when EasyStaking is deployed.
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
    }

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

    // FeatureRegistry (SSOT) + GovernanceGate (SSOT) + CrossChainGovernance (gate + veto)
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
          if (!has) {
            await (
              await acm.grantRole(SET_PARAMETER, deployed.RewardConfig)
            ).wait();
            console.log("🔑 Granted SET_PARAMETER to RewardConfig");
          }
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

    // 4.99) 部署轻量版 LiquidationManager（方案B：直达账本 + View 单点推送）
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

    // 4.99.1) 部署 SettlementManager（统一结算/清算写入口，SSOT）
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

    if (!deployed.OrderStateStoreV2) {
      try {
        deployed.OrderStateStoreV2 = await deployProxy("OrderStateStoreV2", [
          deployed.Registry,
        ]);
        save(deployed);
        console.log(
          "✅ OrderStateStoreV2 deployed @",
          deployed.OrderStateStoreV2,
        );
      } catch (error) {
        console.log("⚠️ OrderStateStoreV2 deployment failed:", error);
      }
    }

    // 4.99.1.5) 部署 LenderPoolVault（线上流动性资金池，推荐）
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

    // 4.99.2.1) 授权 SettlementManager 执行订单级还款与只读查询（ORDER_ENGINE.repay / getLoanOrderForView）
    try {
      await ensureVaultLendingEngineHealthRoles(deployed);
    } catch (e) {
      console.log(
        "⚠️ Grant VaultLendingEngine health roles skipped/failed:",
        e,
      );
    }

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
      }
    } catch (e) {
      console.log(
        "⚠️ Grant ACTION_REPAY/VIEW_SYSTEM_DATA to SettlementManager skipped/failed:",
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

    // 4.99.2.2) 授权 LiquidationManager 与 GuaranteeFundManager 路由平台费到 FeeRouter（ACTION_DEPOSIT）
    try {
      if (deployed.AccessControlManager) {
        const acm = await ethers.getContractAt(
          "AccessControlManager",
          deployed.AccessControlManager,
        );
        const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));

        if (deployed.LiquidationManager) {
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
        "⚠️ Grant ACTION_DEPOSIT to LiquidationManager/GuaranteeFundManager skipped/failed:",
        e,
      );
    }

    // 5) 注册模块到 Registry（通过 NAME -> UPPER_SNAKE -> bytes32 key）
    const registry = await ethers.getContractAt("Registry", deployed.Registry);

    const NAME_TO_KEY: Record<string, string> = {
      // ModuleKeys.KEY_DYNAMIC_MODULE_REGISTRY = keccak256("DYNAMIC_MODULE_REGISTRY")
      RegistryDynamicModuleKey: "DYNAMIC_MODULE_REGISTRY",
      CacheMaintenanceManager: "CACHE_MAINTENANCE_MANAGER",
      AccessControlManager: "ACCESS_CONTROL_MANAGER",
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
      CollateralManager: "COLLATERAL_MANAGER",
      // core/LendingEngine is the OrderEngine -> ModuleKeys.KEY_ORDER_ENGINE = keccak256("ORDER_ENGINE")
      LendingEngine: "ORDER_ENGINE",
      OrderStateStoreV2: "ORDER_STATE_STORE",
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
      CrossChainGovernance: "CROSS_CHAIN_GOVERNANCE",
      GovernanceGate: "GOVERNANCE_GATE",
      FeatureRegistry: "FEATURE_REGISTRY",
      GovernanceGuardian: "GOVERNANCE_GUARDIAN",
      AICreditsVault: "AI_CREDITS_VAULT",
      RewardManagerCore: "REWARD_MANAGER_CORE",
      RewardAccrualManager: "REWARD_ACCRUAL_MANAGER",
      RewardManager: "REWARD_MANAGER",
      RewardView: "REWARD_VIEW",
      RewardConfig: "REWARD_CONFIG",
      EarnConfig: "REWARD_EARN_CONFIG",
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
      "CacheMaintenanceManager",
      "AccessControlManager",
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

    // VaultRouter 已在 VaultCore 之前部署（见上），这里不再重复部署

    // 3.1 附加绑定：将 KEY_LIQUIDATION_MANAGER 绑定到 LiquidationManager（统一清算入口）
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
              keyOf("LIQUIDATOR_VIEW"),
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
      await ensureVaultRouterFeeRouterViewBinding(deployed);

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
        console.log("✅ Architecture check: VaultRouter.feeRouterViewAddrVar matches deployed FeeRouterView");
      }
      console.log(
        "✅ Architecture check: VaultCore.viewContractAddrVar matches deployed VaultRouter",
      );
    } catch (e) {
      // strict: fail fast on mainnet deployment
      throw e;
    }

    // 4) 生成前端配置
    fs.mkdirSync(FRONTEND_DIR, { recursive: true });
    const frontendContent = `// 自动生成的合约配置文件 - Arbitrum Mainnet
// Auto-generated contract configuration file - Arbitrum Mainnet
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
  chainId: ${ARBITRUM_CONFIG.chainId},
  rpcUrl: '${ARBITRUM_CONFIG.rpcUrl}',
  explorer: '${ARBITRUM_CONFIG.explorer}',
  name: '${ARBITRUM_CONFIG.name}'
};

// 使用示例 Usage example:
// import { CONTRACT_ADDRESSES, NETWORK_CONFIG } from './contracts-arbitrum';
// const vaultCoreAddress = CONTRACT_ADDRESSES.VaultCore;
`;
    fs.writeFileSync(FRONTEND_FILE, frontendContent);
    console.log(`📝 Frontend config written: ${FRONTEND_FILE}`);
  fs.mkdirSync(path.dirname(CANONICAL_FRONTEND_FILE), { recursive: true });
  fs.writeFileSync(CANONICAL_FRONTEND_FILE, frontendContent);
  console.log(`📝 Canonical frontend config written: ${CANONICAL_FRONTEND_FILE}`);

    // 5) 输出摘要
    console.log("\n==== Deployment Addresses (arbitrum) ====");
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

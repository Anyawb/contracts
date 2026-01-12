/**
 * Arbitrum 主网部署脚本（符合 contracts/docs/Architecture-Guide.md）
 * Arbitrum Mainnet Deployment Script
 * - 部署 Registry 核心模块（Registry + RegistryCore）
 * - 部署并注册核心业务与视图模块
 * - 写入 deployments/arbitrum.json 与 frontend-config/contracts-arbitrum.ts
 */

import fs from 'fs';
import path from 'path';
import { loadAssetsConfig, configureAssets } from '../utils/configure-assets';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const hre = require('hardhat');
const { ethers, upgrades, network } = hre;

type DeployMap = Record<string, string>;

/**
 * Arbitrum 主网配置
 * Arbitrum Mainnet configuration
 */
const ARBITRUM_CONFIG = {
  name: 'arbitrum',
  chainId: 42161,
  rpcUrl: 'https://arb1.arbitrum.io/rpc',
  explorer: 'https://arbiscan.io'
};

const DEPLOY_DIR = path.join(__dirname, '..', 'deployments');
const DEPLOY_FILE = path.join(DEPLOY_DIR, 'arbitrum.json');
// 将前端配置输出到仓库根目录的 frontend-config，供前端直接导入使用
const FRONTEND_DIR = path.join(__dirname, '..', '..', '..', 'frontend-config');
const FRONTEND_FILE = path.join(FRONTEND_DIR, 'contracts-arbitrum.ts');
const DEFAULT_PAYOUT_BPS = {
  platform: 300,
  reserve: 200,
  lender: 1700,
  liquidator: 7800,
};

function load(): DeployMap {
  if (fs.existsSync(DEPLOY_FILE)) return JSON.parse(fs.readFileSync(DEPLOY_FILE, 'utf8')) as DeployMap;
  return {};
}

function save(map: DeployMap) {
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  fs.writeFileSync(DEPLOY_FILE, JSON.stringify(map, null, 2));
}

function keyOf(upperSnake: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(upperSnake));
}

async function deployRegular(name: string, ...args: unknown[]): Promise<string> {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`✅ ${name} deployed @ ${addr}`);
  return addr;
}

async function deployProxy(name: string, args: unknown[] = [], opts: Record<string, unknown> = {}): Promise<string> {
  const f = await ethers.getContractFactory(name);
  // 默认添加unsafeAllow配置来处理构造函数问题
  // Phase 0c (OZ v5 migration): default to UUPS unless explicitly overridden.
  const defaultOpts = { kind: 'uups', unsafeAllow: ['constructor'], ...opts };
  const p = await upgrades.deployProxy(f, args, defaultOpts);
  await p.waitForDeployment();
  const addr = await p.getAddress();
  console.log(`✅ ${name} (proxy) deployed @ ${addr}`);
  return addr;
}

/**
 * 检查环境配置
 * Check environment configuration
 */
async function checkEnvironment(): Promise<void> {
  console.log('🔍 检查 Arbitrum 主网环境配置...');
  console.log('🔍 Checking Arbitrum Mainnet environment...');
  
  // 检查必需环境变量
  if (!process.env.PRIVATE_KEY) {
    throw new Error('缺少必需的环境变量: PRIVATE_KEY');
  }
  
  // 检查可选环境变量
  if (!process.env.ARBISCAN_API_KEY) {
    console.log('⚠️ 建议配置环境变量: ARBISCAN_API_KEY');
  }
  
  // 检查网络连接
  const provider = new ethers.JsonRpcProvider(ARBITRUM_CONFIG.rpcUrl);
  try {
    const net = await provider.getNetwork();
    if (net.chainId !== BigInt(ARBITRUM_CONFIG.chainId)) {
      throw new Error(`网络配置错误，期望 Chain ID: ${ARBITRUM_CONFIG.chainId}`);
    }
    console.log('✅ Arbitrum 主网连接正常');
  } catch (error) {
    throw new Error('Arbitrum 主网连接失败');
  }
  
  // 检查部署账户余额
  const [deployer] = await ethers.getSigners();
  const balance = await deployer.provider.getBalance(deployer.address);
  console.log(`部署账户 Deployer: ${deployer.address}`);
  console.log(`账户余额 Balance: ${ethers.formatEther(balance)} ETH`);
  
  if (balance < ethers.parseEther('0.1')) {
    throw new Error('部署账户余额不足，请确保有至少 0.1 ETH 支付 Gas 费用');
  }
}

async function main() {
  console.log(`Network: ${network.name}`);
  // 确保 artifacts 可用：在脚本开始时编译（适配 CI/冷启动）
  try {
    await hre.run('compile');
  } catch (e) {
    console.log('⚠️ Compile step failed or skipped:', e);
  }
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const deployed: DeployMap = load();
  
  try {
    // 1. 环境检查
    await checkEnvironment();
    
    // 2. 部署 Registry + 核心子模块
    // 主网建议最小延迟 7 天（更保守）
    const MIN_DELAY = 7 * 24 * 60 * 60; // 7 days

    if (!deployed.Registry) {
      // UUPS 可升级合约，使用 Proxy 部署并初始化
      deployed.Registry = await deployProxy('Registry', [MIN_DELAY, deployer.address, deployer.address, deployer.address]);
      save(deployed);
    }

    if (!deployed.RegistryCore) {
      // 关键：将 RegistryCore 的 admin 设为 Registry 地址
      deployed.RegistryCore = await deployProxy('RegistryCore', [deployed.Registry, MIN_DELAY]);
      save(deployed);
      const registry = await ethers.getContractAt('Registry', deployed.Registry);
      await (await registry.setRegistryCore(deployed.RegistryCore)).wait();
      console.log('🔗 RegistryCore linked to Registry');
    }

    // 可选：部署并挂载升级/治理子模块
    if (!deployed.RegistryUpgradeManager) {
      // NOTE: RegistryUpgradeManager is NOT UUPSUpgradeable (transparent proxy required).
      deployed.RegistryUpgradeManager = await deployProxy('RegistryUpgradeManager', [deployed.Registry, deployer.address], {
        kind: 'transparent',
      });
      save(deployed);
      try {
        const registry = await ethers.getContractAt('Registry', deployed.Registry);
        await (await registry.setUpgradeManager(deployed.RegistryUpgradeManager)).wait();
        console.log('🔗 RegistryUpgradeManager linked');
      } catch (error) {
        console.log('⚠️ RegistryUpgradeManager linking failed:', error);
      }
    }

    if (!deployed.RegistryAdmin) {
      // NOTE: RegistryAdmin is NOT UUPSUpgradeable (transparent proxy required).
      deployed.RegistryAdmin = await deployProxy('RegistryAdmin', [deployer.address], { kind: 'transparent' });
      save(deployed);
      try {
        const registry = await ethers.getContractAt('Registry', deployed.Registry);
        await (await registry.setRegistryAdmin(deployed.RegistryAdmin)).wait();
        console.log('🔗 RegistryAdmin linked');
      } catch (error) {
        console.log('⚠️ RegistryAdmin linking failed:', error);
      }
    }

    // 部署动态模块键注册表
    if (!deployed.RegistryDynamicModuleKey) {
      try {
        deployed.RegistryDynamicModuleKey = await deployProxy('RegistryDynamicModuleKey', [
          deployer.address, // registrationAdmin
          deployer.address, // systemAdmin
          deployer.address, // owner (OwnableUpgradeable)
        ]);
        save(deployed);
        console.log('✅ RegistryDynamicModuleKey deployed @', deployed.RegistryDynamicModuleKey);
      } catch (error) {
        console.log('⚠️ RegistryDynamicModuleKey deployment failed:', error);
      }
    }

    // 3. 部署核心/视图/账本与支撑模块
    if (!deployed.AccessControlManager) {
      // 非升级合约（构造函数接收 owner）
      deployed.AccessControlManager = await deployRegular('AccessControlManager', deployer.address);
      save(deployed);
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
      const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
      const adminAddress = deployer.address;

      const roleNames = [
        'ACTION_ADMIN',
        // 读权限（全量覆盖）
        'VIEW_SYSTEM_DATA',
        'VIEW_USER_DATA',
        'VIEW_DEGRADATION_DATA',
        'VIEW_CACHE_DATA',
        'VIEW_PRICE_DATA',
        'VIEW_RISK_DATA',
        'VIEW_LIQUIDATION_DATA',
        // 可选：查询管理
        'QUERY_MANAGER',
      ];
      for (const r of roleNames) {
        const role = ethers.keccak256(ethers.toUtf8Bytes(r));
        try {
          await (await acm.grantRole(role, adminAddress)).wait();
          console.log(`🔑 Granted ${r} to ${adminAddress}`);
        } catch (e) {
          // 角色已存在会 revert: RoleAlreadyGranted()，忽略
          console.log(`⚠️ Role ${r} already granted or failed:`, e);
        }
      }
      console.log('🔐 AccessControlManager: admin granted ADMIN + read-only roles');
    } catch (e) {
      console.log('⚠️ AccessControlManager grant roles skipped:', e);
    }

    if (!deployed.AssetWhitelist) {
      deployed.AssetWhitelist = await deployProxy('AssetWhitelist', [deployed.Registry]);
      save(deployed);
    }

    if (!deployed.AuthorityWhitelist) {
      deployed.AuthorityWhitelist = await deployProxy('AuthorityWhitelist', [deployed.Registry]);
      save(deployed);
    }

    if (!deployed.PriceOracle) {
      deployed.PriceOracle = await deployProxy('PriceOracle', [deployed.Registry]);
      save(deployed);
    }

    if (!deployed.CoinGeckoPriceUpdater) {
      deployed.CoinGeckoPriceUpdater = await deployProxy('CoinGeckoPriceUpdater', [deployed.Registry]);
      save(deployed);
    }

    // 配置预言机系统权限
    try {
      const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
      
      // 为 CoinGeckoPriceUpdater 授予 UPDATE_PRICE 权限
      const UPDATE_PRICE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('UPDATE_PRICE'));
      await acm.grantRole(UPDATE_PRICE_ROLE, deployed.CoinGeckoPriceUpdater);
      console.log('✅ CoinGeckoPriceUpdater 已获得 UPDATE_PRICE 权限');
      
      // 为 deployer 授予 SET_PARAMETER 权限（用于配置资产）
      const SET_PARAMETER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
      await acm.grantRole(SET_PARAMETER_ROLE, deployer.address);
      console.log('✅ Deployer 已获得 SET_PARAMETER 权限');
      
      // 为 deployer 授予 ADD_WHITELIST 权限
      const ADD_WHITELIST_ROLE = ethers.keccak256(ethers.toUtf8Bytes('ADD_WHITELIST'));
      await acm.grantRole(ADD_WHITELIST_ROLE, deployer.address);
      console.log('✅ Deployer 已获得 ADD_WHITELIST 权限');
      
    } catch (error) {
      console.log('⚠️ 权限配置失败，可能已经配置过:', error);
    }
    
    // 配置网络资产（通用配置文件驱动）
    console.log('📝 配置网络资产（配置文件驱动）...');
    try {
      const assets = loadAssetsConfig(ARBITRUM_CONFIG.name, ARBITRUM_CONFIG.chainId);
      if (assets.length) {
        await configureAssets(ethers, deployed.PriceOracle, assets);
        console.log(`✅ 已按配置文件添加/更新 ${assets.length} 个资产`);
      } else {
        console.log('ℹ️ 未检测到资产配置文件，跳过资产配置');
      }
    } catch (error) {
      console.log('⚠️ 资产配置失败:', error);
    }

    if (!deployed.FeeRouter) {
      // platformBps / ecoBps 示例：9 (=0.09%), 1 (=0.01%)
      deployed.FeeRouter = await deployProxy('FeeRouter', [deployed.Registry, deployer.address, deployer.address, 9, 1]);
      save(deployed);
    }

    // 4. 部署 Vault 系统（从配置文件读取真实代币地址，不使用 Mock）
    // CollateralManager（CM）
    if (!deployed.CollateralManager) {
      deployed.CollateralManager = await deployProxy('CollateralManager', [deployed.Registry]);
      save(deployed);
    }

    // LendingEngine（核心账本）
    if (!deployed.LendingEngine) {
      deployed.LendingEngine = await deployProxy('LendingEngine', [deployed.Registry]);
      save(deployed);
    }

    // LiquidationRiskManager（清算风险管理器）
    if (!deployed.LiquidationRiskManager) {
      try {
        const initialMaxCacheDuration = 300; // 5分钟
        const initialMaxBatchSize = 50;
        // 先部署所需库
      const riskLibFactory = await ethers.getContractFactory('src/Vault/liquidation/libraries/LiquidationRiskLib.sol:LiquidationRiskLib');
      const riskLib = await riskLibFactory.deploy();
      await riskLib.waitForDeployment();
      const riskLibAddr = await riskLib.getAddress();
      deployed.LiquidationRiskLib = riskLibAddr;
      save(deployed);
      console.log('📚 LiquidationRiskLib deployed @', riskLibAddr);

      const riskBatchLibFactory = await ethers.getContractFactory('src/Vault/liquidation/libraries/LiquidationRiskBatchLib.sol:LiquidationRiskBatchLib');
      const riskBatchLib = await riskBatchLibFactory.deploy();
      await riskBatchLib.waitForDeployment();
      const riskBatchLibAddr = await riskBatchLib.getAddress();
      deployed.LiquidationRiskBatchLib = riskBatchLibAddr;
      save(deployed);
      console.log('📚 LiquidationRiskBatchLib deployed @', riskBatchLibAddr);

        // 使用已链接库创建工厂并通过 Proxy 部署
        const lrmFactory = await ethers.getContractFactory(
          'src/Vault/liquidation/modules/LiquidationRiskManager.sol:LiquidationRiskManager',
          {
            libraries: {
              LiquidationRiskLib: riskLibAddr,
              LiquidationRiskBatchLib: riskBatchLibAddr,
            },
          }
        );
        // 通过 UUPS Proxy 部署，并允许链接外部库
        const lrmProxy = await upgrades.deployProxy(
          lrmFactory,
          [
            deployed.Registry,
            deployed.AccessControlManager,
            initialMaxCacheDuration,
            initialMaxBatchSize
          ],
          {
            unsafeAllowLinkedLibraries: true,
            unsafeAllow: ['constructor'],
          }
        );
        await lrmProxy.waitForDeployment();
        deployed.LiquidationRiskManager = await lrmProxy.getAddress();
        save(deployed);
        console.log('✅ LiquidationRiskManager deployed @', deployed.LiquidationRiskManager);
      } catch (error) {
        console.log('⚠️ LiquidationRiskManager deployment failed:', error);
      }
    }

    // VaultLendingEngine（Vault借贷引擎）
    if (!deployed.VaultLendingEngine) {
      try {
        const assets = loadAssetsConfig(ARBITRUM_CONFIG.name, ARBITRUM_CONFIG.chainId);
        const usdc = assets.find((a) => a.coingeckoId === 'usd-coin');
        if (!usdc || !usdc.address) {
          throw new Error('缺少 USDC/Settlement Token 配置');
        }
        if (!deployed.SettlementToken) {
          deployed.SettlementToken = usdc.address;
          save(deployed);
        }
        deployed.VaultLendingEngine = await deployProxy('src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine', [deployed.PriceOracle, deployed.SettlementToken, deployed.Registry]);
        save(deployed);
      } catch (error) {
        console.log('⚠️ VaultLendingEngine deployment failed:', error);
      }
    }

    // EarlyRepaymentGuaranteeManager（提前还款保证金管理器）
    if (!deployed.EarlyRepaymentGuaranteeManager) {
      try {
        deployed.EarlyRepaymentGuaranteeManager = await deployProxy('src/Vault/modules/EarlyRepaymentGuaranteeManager.sol:EarlyRepaymentGuaranteeManager', [deployed.VaultCore || ethers.ZeroAddress, deployed.Registry, deployer.address, 500]); // 5% 平台费率
        save(deployed);
      } catch (error) {
        console.log('⚠️ EarlyRepaymentGuaranteeManager deployment failed:', error);
      }
    }

    // VaultStorage + VaultBusinessLogic + VaultRouter + VaultCore
    if (!deployed.VaultStorage) {
      const assets = loadAssetsConfig(ARBITRUM_CONFIG.name, ARBITRUM_CONFIG.chainId);
      const usdc = assets.find((a) => a.coingeckoId === 'usd-coin');
      if (!usdc || !usdc.address) {
        throw new Error('缺少 USDC/Settlement Token 配置，请在 assets.arbitrum.json 配置 usd-coin 地址');
      }
      // RWA Token：主网必须使用真实 RWA Token 地址
      if (!deployed.RWAToken) {
        const rwa = assets.find((a) => a.coingeckoId && a.coingeckoId !== 'usd-coin');
        if (!rwa || !rwa.address) throw new Error('缺少 RWA Token 配置，请在 assets.arbitrum.json 添加一个 RWA 资产地址');
        deployed.RWAToken = rwa.address;
        save(deployed);
      }
      if (!deployed.SettlementToken) {
        deployed.SettlementToken = usdc.address;
        save(deployed);
      }
      deployed.VaultStorage = await deployProxy('VaultStorage', [deployed.Registry, deployed.RWAToken, deployed.SettlementToken]);
      save(deployed);
    }

    if (!deployed.VaultBusinessLogic) {
      if (!deployed.SettlementToken) {
        const assets = loadAssetsConfig(ARBITRUM_CONFIG.name, ARBITRUM_CONFIG.chainId);
        const usdc = assets.find((a) => a.coingeckoId === 'usd-coin');
        if (!usdc || !usdc.address) throw new Error('缺少 SettlementToken 配置');
        deployed.SettlementToken = usdc.address;
        save(deployed);
      }
      deployed.VaultBusinessLogic = await deployProxy('VaultBusinessLogic', [deployed.Registry, deployed.SettlementToken]);
      save(deployed);
    }

    // 部署 VaultRouter（UUPS Proxy，严格对齐 Architecture-Guide：本地存储 + UUPS）
    // 注意：VaultCore.initialize(registry, viewAddr) 需要最终 VaultRouter 地址，因此必须先部署 VaultRouter。
    if (!deployed.VaultRouter) {
      if (!deployed.SettlementToken) {
        throw new Error('Missing SettlementToken (required for VaultRouter.initialize)');
      }
      deployed.VaultRouter = await deployProxy(
        'src/Vault/VaultRouter.sol:VaultRouter',
        [
          deployed.Registry,
          deployed.AssetWhitelist,
          deployed.PriceOracle,
          deployed.SettlementToken,
          deployer.address, // owner (mainnet: MUST be multisig/timelock)
        ]
      );
      save(deployed);
    }

    if (!deployed.VaultCore) {
      // VaultCore.initialize(registry, view)
      deployed.VaultCore = await deployProxy('VaultCore', [deployed.Registry, deployed.VaultRouter]);
      save(deployed);
    }

    // GuaranteeFundManager
    if (!deployed.GuaranteeFundManager) {
      try {
        // initialize(address vaultCore, address registry, address upgradeAdmin)
        deployed.GuaranteeFundManager = await deployProxy('GuaranteeFundManager', [deployed.VaultCore || ethers.ZeroAddress, deployed.Registry, deployer.address]);
        save(deployed);
      } catch (error) {
        console.log('⚠️ GuaranteeFundManager deployment failed:', error);
      }
    }

    // ====== View 层（全面）======
    // HealthView（可选但前端会优先尝试，存在更佳）
    if (!deployed.HealthView) {
      try {
        deployed.HealthView = await deployProxy('HealthView', [deployed.Registry]);
        save(deployed);
      } catch {
        // 模块缺失不阻断部署
      }
    }

    // SystemView / StatisticsView / PositionView / PreviewView / DashboardView / UserView
    // SystemView：系统级只读聚合门面（与 docs/Architecture-Guide.md 对齐）
    if (!deployed.SystemView) {
      try { deployed.SystemView = await deployProxy('SystemView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ SystemView deployment failed:', error); }
    }
    // 授予 SystemView 只读权限（SystemView 调用其他模块时 msg.sender 为合约自身）
    try {
      if (deployed.SystemView && deployed.AccessControlManager) {
        const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
        const VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
        await (await acm.grantRole(VIEW_SYSTEM_DATA, deployed.SystemView)).wait();
        console.log('🔑 Granted VIEW_SYSTEM_DATA to SystemView');
      }
    } catch (e) {
      console.log('⚠️ Grant VIEW_SYSTEM_DATA to SystemView skipped:', e);
    }
    if (!deployed.RegistryView) {
      try { deployed.RegistryView = await deployProxy('src/Vault/view/modules/RegistryView.sol:RegistryView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ RegistryView deployment failed:', error); }
    }

    if (!deployed.StatisticsView) {
      try { deployed.StatisticsView = await deployProxy('StatisticsView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ StatisticsView deployment failed:', error); }
    }
    if (!deployed.PositionView) {
      try { deployed.PositionView = await deployProxy('PositionView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ PositionView deployment failed:', error); }
    }
    if (!deployed.PreviewView) {
      try { deployed.PreviewView = await deployProxy('PreviewView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ PreviewView deployment failed:', error); }
    }
    if (!deployed.DashboardView) {
      try { deployed.DashboardView = await deployProxy('DashboardView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ DashboardView deployment failed:', error); }
    }
    if (!deployed.UserView) {
      try { deployed.UserView = await deployProxy('UserView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ UserView deployment failed:', error); }
    }

    // 其它 View 与工具视图
    if (!deployed.AccessControlView) {
      try { deployed.AccessControlView = await deployProxy('AccessControlView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ AccessControlView deployment failed:', error); }
    }
    if (!deployed.CacheOptimizedView) {
      try { deployed.CacheOptimizedView = await deployProxy('CacheOptimizedView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ CacheOptimizedView deployment failed:', error); }
    }
    if (!deployed.LendingEngineView) {
      try { deployed.LendingEngineView = await deployProxy('LendingEngineView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ LendingEngineView deployment failed:', error); }
    }
    if (!deployed.FeeRouterView) {
      try { deployed.FeeRouterView = await deployProxy('FeeRouterView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ FeeRouterView deployment failed:', error); }
    }
    if (!deployed.RiskView) {
      try { deployed.RiskView = await deployProxy('RiskView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ RiskView deployment failed:', error); }
    }
    if (!deployed.ViewCache) {
      try { deployed.ViewCache = await deployProxy('ViewCache', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ ViewCache deployment failed:', error); }
    }
    if (!deployed.EventHistoryManager) {
      try { deployed.EventHistoryManager = await deployProxy('EventHistoryManager', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ EventHistoryManager deployment failed:', error); }
    }
    // 估值视图（可选）
    if (!deployed.ValuationOracleView) {
      try { deployed.ValuationOracleView = await deployProxy('ValuationOracleView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ ValuationOracleView deployment failed:', error); }
    }

    // LiquidationRiskView（清算风险只读视图，非可升级：构造函数 + 库）
    if (!deployed.LiquidationRiskView) {
      try {
        const libAddr = deployed.LiquidationRiskLib;
        if (!libAddr) throw new Error('LiquidationRiskLib address missing (deploy LiquidationRiskManager first)');
        const factory = await ethers.getContractFactory(
          'src/Vault/view/modules/LiquidationRiskView.sol:LiquidationRiskView',
          { libraries: { LiquidationRiskLib: libAddr } }
        );
        const view = await factory.deploy(deployed.Registry);
        await view.waitForDeployment();
        deployed.LiquidationRiskView = await view.getAddress();
        save(deployed);
      } catch (error) {
        console.log('⚠️ LiquidationRiskView deployment failed:', error);
      }
    }

    // ====== 监控模块 ======
    // 第一步：部署不依赖其他监控模块的基础模块
    if (!deployed.DegradationCore) {
      try {
        deployed.DegradationCore = await deployProxy('src/monitor/DegradationCore.sol:DegradationCore', [deployed.Registry]);
        save(deployed);
      } catch (error) {
        console.log('⚠️ DegradationCore deployment failed:', error);
      }
    }

    if (!deployed.DegradationStorage) {
      try {
        deployed.DegradationStorage = await deployProxy('src/monitor/DegradationStorage.sol:DegradationStorage', [deployed.Registry]);
        save(deployed);
      } catch (error) {
        console.log('⚠️ DegradationStorage deployment failed:', error);
      }
    }

    if (!deployed.ModuleHealthView) {
      try {
        deployed.ModuleHealthView = await deployProxy('src/Vault/view/modules/ModuleHealthView.sol:ModuleHealthView', [deployed.Registry]);
        save(deployed);
      } catch (error) {
        console.log('⚠️ ModuleHealthView deployment failed:', error);
      }
    }

    // 第二步：部署依赖其他监控模块的 DegradationMonitor
    if (!deployed.DegradationMonitor && deployed.DegradationCore && deployed.DegradationStorage && deployed.ModuleHealthView) {
      try {
        deployed.DegradationMonitor = await deployProxy('src/monitor/DegradationMonitor.sol:DegradationMonitor', [deployed.Registry, deployer.address, deployed.DegradationCore, deployed.DegradationStorage, deployed.ModuleHealthView, ethers.ZeroAddress, deployer.address]);
        save(deployed);
        console.log('✅ DegradationMonitor deployed @ ' + deployed.DegradationMonitor);
      } catch (error) {
        console.log('⚠️ DegradationMonitor deployment failed:', error);
      }
    }

    // BatchView（批量视图）
    if (!deployed.BatchView) {
      try {
        deployed.BatchView = await deployProxy('src/Vault/view/modules/BatchView.sol:BatchView', [deployed.Registry]);
        save(deployed);
      } catch (error) {
        console.log('⚠️ BatchView deployment failed:', error);
      }
    }

    // LiquidatorView（需要 SystemView）
    if (!deployed.LiquidatorView) {
      // 第二个参数为历史兼容位（LiquidatorView.initialize 的 legacy SystemView），不再使用，这里使用非零占位（Registry）
      try { deployed.LiquidatorView = await deployProxy('LiquidatorView', [deployed.Registry, deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ LiquidatorView deployment failed:', error); }
    }

    // LoanNFT（账本用到的 NFT）
    if (!deployed.LoanNFT) {
      try { deployed.LoanNFT = await deployProxy('LoanNFT', ['RWA Loan', 'RWLN', 'https://example.com/metadata/', deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ LoanNFT deployment failed:', error); }
    }

    // ====== 奖励系统（完整）======
    if (!deployed.RewardPoints) {
      try { deployed.RewardPoints = await deployProxy('RewardPoints', [deployer.address], { unsafeAllow: ['constructor'] }); save(deployed); } catch (error) { console.log('⚠️ RewardPoints deployment failed:', error); }
    }
    if (!deployed.RewardManagerCore) {
      try { deployed.RewardManagerCore = await deployProxy('RewardManagerCore', [deployed.Registry, ethers.parseUnits('10', 18), ethers.parseUnits('1', 18), ethers.parseUnits('500', 18), ethers.parseUnits('100', 18)]); save(deployed); } catch (error) { console.log('⚠️ RewardManagerCore deployment failed:', error); }
    }
    if (!deployed.RewardCore) {
      try { deployed.RewardCore = await deployProxy('RewardCore', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ RewardCore deployment failed:', error); }
    }
    if (!deployed.RewardConsumption) {
      try { deployed.RewardConsumption = await deployProxy('RewardConsumption', [deployed.RewardCore || ethers.ZeroAddress, deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ RewardConsumption deployment failed:', error); }
    }
    if (!deployed.RewardManager) {
      try { deployed.RewardManager = await deployProxy('RewardManager', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ RewardManager deployment failed:', error); }
    }
    if (!deployed.RewardConfig) {
      try { deployed.RewardConfig = await deployProxy('RewardConfig', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ RewardConfig deployment failed:', error); }
    }
    if (!deployed.RewardView) {
      try { deployed.RewardView = await deployProxy('RewardView', [deployed.Registry]); save(deployed); } catch (error) { console.log('⚠️ RewardView deployment failed:', error); }
    }

    // MINTER_ROLE 授权（RewardPoints -> RMCore/RewardCore）
    try {
      if (deployed.RewardPoints) {
        const code = await ethers.provider.getCode(deployed.RewardPoints);
        if (!code || code === '0x') {
          console.log('⚠️ RewardPoints has no code at', deployed.RewardPoints, '- skip MINTER_ROLE grant');
        } else {
          const rp = await ethers.getContractAt('RewardPoints', deployed.RewardPoints);
          
          // 检查合约是否已初始化
          try {
            const name = await rp.name();
            console.log('✅ RewardPoints is initialized, name:', name);
          } catch (initError) {
            console.log('⚠️ RewardPoints not initialized, attempting to initialize...');
            try {
              await (await rp.initialize(deployer.address)).wait();
              console.log('✅ RewardPoints initialized with deployer as admin');
            } catch (initErr) {
              console.log('⚠️ RewardPoints initialization failed:', initErr);
            }
          }
          
          // 使用合约的MINTER_ROLE常量
          try {
            const MINTER_ROLE = await rp.MINTER_ROLE();
            console.log('✅ Got MINTER_ROLE from contract:', MINTER_ROLE);
            
            if (deployed.RewardManagerCore) {
              try { 
                await (await rp.grantRole(MINTER_ROLE, deployed.RewardManagerCore)).wait(); 
                console.log('✅ Granted MINTER_ROLE to RewardManagerCore');
              } catch (error) { 
                console.log('⚠️ RewardManagerCore MINTER_ROLE grant failed:', error); 
              }
            }
            console.log('🔐 RewardPoints MINTER_ROLE granted');
          } catch (roleError) {
            console.log('⚠️ Failed to get MINTER_ROLE from contract, using fallback:', roleError);
            // 回退方案：使用手动计算的哈希
            const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MINTER_ROLE'));
            if (deployed.RewardManagerCore) {
              try { await (await rp.grantRole(MINTER_ROLE, deployed.RewardManagerCore)).wait(); } catch (error) { console.log('⚠️ RewardManagerCore MINTER_ROLE grant failed (fallback):', error); }
            }
          }
        }
      }
    } catch (error) {
      console.log('⚠️ RewardPoints MINTER_ROLE setup failed:', error);
    }

    // 4.99) 部署轻量版 LiquidationManager（方案B：直达账本 + View 单点推送）
    if (!deployed.LiquidationManager) {
      try {
        deployed.LiquidationManager = await deployProxy('LiquidationManager', [deployed.Registry]);
        save(deployed);
        console.log('✅ LiquidationManager deployed @', deployed.LiquidationManager);
      } catch (error) {
        console.log('⚠️ LiquidationManager deployment failed:', error);
      }
    }

    // 4.99.1) 部署 SettlementManager（统一结算/清算写入口，SSOT）
    if (!deployed.SettlementManager) {
      try {
        deployed.SettlementManager = await deployProxy('SettlementManager', [deployed.Registry]);
        save(deployed);
        console.log('✅ SettlementManager deployed @', deployed.SettlementManager);
      } catch (error) {
        console.log('⚠️ SettlementManager deployment failed:', error);
      }
    }

    // 4.99.1.5) 部署 LenderPoolVault（线上流动性资金池，推荐）
    if (!deployed.LenderPoolVault) {
      try {
        deployed.LenderPoolVault = await deployProxy('LenderPoolVault', [deployed.Registry]);
        save(deployed);
        console.log('✅ LenderPoolVault deployed @', deployed.LenderPoolVault);
      } catch (error) {
        console.log('⚠️ LenderPoolVault deployment failed:', error);
      }
    }

    // 若未显式提供 PAYOUT_LENDER_ADDR，则默认将 lenderCompensation 指向 LenderPoolVault（与“lender=资金池地址”语义一致）
    if (!process.env.PAYOUT_LENDER_ADDR && deployed.LenderPoolVault) {
      payoutRecipients = { ...payoutRecipients, lenderCompensation: deployed.LenderPoolVault };
    }

    // 4.99.2) 部署 LiquidationPayoutManager（残值分配）
    if (!deployed.LiquidationPayoutManager) {
      try {
        deployed.LiquidationPayoutManager = await deployProxy('LiquidationPayoutManager', [
          deployed.Registry,
          deployed.AccessControlManager,
          [payoutRecipients.platform, payoutRecipients.reserve, payoutRecipients.lenderCompensation],
          payoutRates,
        ]);
        save(deployed);
        console.log('✅ LiquidationPayoutManager deployed @', deployed.LiquidationPayoutManager);
      } catch (error) {
        console.log('⚠️ LiquidationPayoutManager deployment failed:', error);
      }
    }

    // 4.99.2.1) 授权 SettlementManager 执行订单级还款与只读查询（ORDER_ENGINE.repay / _getLoanOrderForView）
    try {
      if (deployed.AccessControlManager && deployed.SettlementManager) {
        const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
        const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes('REPAY'));
        const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));

        const hasRepay = await acm.hasRole(ACTION_REPAY, deployed.SettlementManager);
        if (!hasRepay) {
          await (await acm.grantRole(ACTION_REPAY, deployed.SettlementManager)).wait();
          console.log('🔑 Granted ACTION_REPAY to SettlementManager');
        }

        const hasView = await acm.hasRole(ACTION_VIEW_SYSTEM_DATA, deployed.SettlementManager);
        if (!hasView) {
          await (await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, deployed.SettlementManager)).wait();
          console.log('🔑 Granted ACTION_VIEW_SYSTEM_DATA to SettlementManager');
        }
      }
    } catch (e) {
      console.log('⚠️ Grant ACTION_REPAY/VIEW_SYSTEM_DATA to SettlementManager skipped/failed:', e);
    }

    // 5) 注册模块到 Registry（通过 NAME -> UPPER_SNAKE -> bytes32 key）
    const registry = await ethers.getContractAt('Registry', deployed.Registry);

    const NAME_TO_KEY: Record<string, string> = {
      RegistrySignatureManager: 'REGISTRY_SIGNATURE_MANAGER',
      RegistryHistoryManager: 'REGISTRY_HISTORY_MANAGER',
      RegistryBatchManager: 'REGISTRY_BATCH_MANAGER',
      RegistryHelper: 'REGISTRY_HELPER',
      // ModuleKeys.KEY_DYNAMIC_MODULE_REGISTRY = keccak256("DYNAMIC_MODULE_REGISTRY")
      RegistryDynamicModuleKey: 'DYNAMIC_MODULE_REGISTRY',
      AccessControlManager: 'ACCESS_CONTROL_MANAGER',
      AssetWhitelist: 'ASSET_WHITELIST',
      AuthorityWhitelist: 'AUTHORITY_WHITELIST',
      PriceOracle: 'PRICE_ORACLE',
      CoinGeckoPriceUpdater: 'COINGECKO_PRICE_UPDATER',
      FeeRouter: 'FEE_ROUTER',
      FeeRouterView: 'FEE_ROUTER_VIEW',
      CollateralManager: 'COLLATERAL_MANAGER',
      // core/LendingEngine is the OrderEngine -> ModuleKeys.KEY_ORDER_ENGINE = keccak256("ORDER_ENGINE")
      LendingEngine: 'ORDER_ENGINE',
      LendingEngineView: 'LENDING_ENGINE_VIEW',
      VaultBusinessLogic: 'VAULT_BUSINESS_LOGIC',
      VaultCore: 'VAULT_CORE',
      // VaultRouter: 'VAULT_VIEW', // 架构建议通过 KEY_VAULT_CORE 解析，不强依赖
      VaultStorage: 'VAULT_STORAGE',
      // VaultLendingEngine is the ledger engine -> ModuleKeys.KEY_LE = keccak256("LENDING_ENGINE")
      VaultLendingEngine: 'LENDING_ENGINE',
      EarlyRepaymentGuaranteeManager: 'EARLY_REPAYMENT_GUARANTEE_MANAGER',
      HealthView: 'HEALTH_VIEW',
      // 不注册未部署的 RWA Token
      SystemView: 'SYSTEM_VIEW',
      StatisticsView: 'STATISTICS_VIEW',
      PositionView: 'POSITION_VIEW',
      PreviewView: 'PREVIEW_VIEW',
      DashboardView: 'DASHBOARD_VIEW',
      UserView: 'USER_VIEW',
      RegistryView: 'REGISTRY_VIEW',
      AccessControlView: 'ACCESS_CONTROL_VIEW',
      CacheOptimizedView: 'CACHE_OPTIMIZED_VIEW',
      RiskView: 'RISK_VIEW',
      ViewCache: 'VIEW_CACHE',
      EventHistoryManager: 'EVENT_HISTORY_MANAGER',
      RewardView: 'REWARD_VIEW',
      RewardConfig: 'REWARD_CONFIG',
      RewardConsumption: 'REWARD_CONSUMPTION',
      ValuationOracleView: 'VALUATION_ORACLE_VIEW',
      // ModuleKeys.KEY_LIQUIDATION_VIEW = keccak256("LIQUIDATION_VIEW")
      LiquidatorView: 'LIQUIDATION_VIEW',
      LiquidationManager: 'LIQUIDATION_MANAGER',
      SettlementManager: 'SETTLEMENT_MANAGER',
      LiquidationPayoutManager: 'LIQUIDATION_PAYOUT_MANAGER',
      LenderPoolVault: 'LENDER_POOL_VAULT',
      GuaranteeFundManager: 'GUARANTEE_FUND_MANAGER',
      LoanNFT: 'LOAN_NFT',
      // 监控模块
      DegradationCore: 'DEGRADATION_CORE',
      DegradationMonitor: 'DEGRADATION_MONITOR',
      DegradationStorage: 'DEGRADATION_STORAGE',
      ModuleHealthView: 'MODULE_HEALTH_VIEW',
      BatchView: 'BATCH_VIEW',
      LiquidationRiskView: 'LIQUIDATION_RISK_VIEW',
    };

    // 实际注册的模块清单（只注册已部署的）
    const modules = [
      'AccessControlManager',
      'AssetWhitelist',
      'AuthorityWhitelist',
      'PriceOracle',
      'CoinGeckoPriceUpdater',
      'LiquidationManager',
      'SettlementManager',
      'VaultLendingEngine',
      'EarlyRepaymentGuaranteeManager',
      'DegradationCore',
      'DegradationMonitor',
      'DegradationStorage',
      'ModuleHealthView',
      'BatchView',
      'LiquidationRiskView',
      'LiquidationPayoutManager',
      'LenderPoolVault',
      'FeeRouter',
      'FeeRouterView',
      'CollateralManager',
      'LendingEngine',
      'LendingEngineView',
      'VaultBusinessLogic',
      'VaultCore',
      'VaultStorage',
      'HealthView',
      'SystemView',
      'StatisticsView',
      'PositionView',
      'PreviewView',
      'DashboardView',
      'UserView',
      'RegistryView',
      'AccessControlView',
      'CacheOptimizedView',
      'RiskView',
      'ViewCache',
      'EventHistoryManager',
      'RewardView',
      'RewardConfig',
      'RewardConsumption',
      'ValuationOracleView',
      'LiquidatorView',
      'GuaranteeFundManager',
      'LoanNFT',
      'RegistryDynamicModuleKey', // 添加动态模块键注册表
    ];

    for (const name of modules) {
      const addr = deployed[name];
      if (!addr) continue;
      const upperSnake = NAME_TO_KEY[name];
      if (!upperSnake) continue;
      try {
        await (await registry.setModule(keyOf(upperSnake), addr)).wait();
        console.log(`📌 Registered ${name} -> ${upperSnake}`);
      } catch (e) {
        console.log(`⚠️ Skip register ${name}:`, e);
      }
    }

    // 补充：若存在 LiquidationRiskManager，但未在映射中，则单独注册到 KEY_LIQUIDATION_RISK_MANAGER
    if (deployed.LiquidationRiskManager) {
      try {
        await (await registry.setModule(keyOf('LIQUIDATION_RISK_MANAGER'), deployed.LiquidationRiskManager)).wait();
        console.log('📌 Registered LiquidationRiskManager -> LIQUIDATION_RISK_MANAGER');
      } catch (e) {
        console.log('⚠️ Skip register LiquidationRiskManager:', e);
      }
    }

    // 设置动态模块键注册表到Registry
    if (deployed.RegistryDynamicModuleKey) {
      try {
        await (await registry.setDynamicModuleKeyRegistry(deployed.RegistryDynamicModuleKey)).wait();
        console.log('✅ Dynamic module key registry set in Registry');
      } catch (error) {
        console.log('⚠️ Failed to set dynamic module key registry:', error);
      }
    }

    // VaultRouter 已在 VaultCore 之前部署（见上），这里不再重复部署

    // 3.1 附加绑定：将 KEY_LIQUIDATION_MANAGER 绑定到 LiquidationManager（统一清算入口）
    try {
      if (deployed.LiquidationManager) {
        await (await registry.setModule(keyOf('LIQUIDATION_MANAGER'), deployed.LiquidationManager)).wait();
        console.log(`✅ Bound KEY_LIQUIDATION_MANAGER -> ${deployed.LiquidationManager}`);
      }
      if (deployed.SettlementManager) {
        try {
          await (await registry.setModule(keyOf('SETTLEMENT_MANAGER'), deployed.SettlementManager)).wait();
          console.log(`✅ Bound KEY_SETTLEMENT_MANAGER -> ${deployed.SettlementManager}`);
        } catch (error) {
          console.log('⚠️ SettlementManager binding failed:', error);
        }
      }
      if (deployed.HealthView) {
        try { await (await registry.setModule(keyOf('HEALTH_VIEW'), deployed.HealthView)).wait(); } catch (error) { console.log('⚠️ HealthView binding failed:', error); }
      }
      if (deployed.LiquidatorView) {
        try { await (await registry.setModule(keyOf('LIQUIDATOR_VIEW'), deployed.LiquidatorView)).wait(); } catch (error) { console.log('⚠️ LiquidatorView binding failed:', error); }
        if (deployed.LiquidationPayoutManager) {
          try { await (await registry.setModule(keyOf('LIQUIDATION_PAYOUT_MANAGER'), deployed.LiquidationPayoutManager)).wait(); } catch (error) { console.log('⚠️ LiquidationPayoutManager binding failed:', error); }
        }
      }
      if (deployed.StatisticsView) {
        try { await (await registry.setModule(keyOf('VAULT_STATISTICS'), deployed.StatisticsView)).wait(); console.log(`✅ Bound KEY_STATS (VAULT_STATISTICS) -> ${deployed.StatisticsView}`); } catch (error) { console.log('⚠️ StatisticsView binding failed:', error); }
      }
    } catch (e) {
      console.log('⚠️ Extra KEY binding failed:', e);
    }

    // 3.2 断言校验（严格版）：
    // - 禁止引入 KEY_VAULT_VIEW（多来源）；VaultRouter 的权威来源是 VaultCore.viewContractAddrVar()
    try {
      if (!deployed.VaultCore || !deployed.VaultRouter) throw new Error('Missing VaultCore or VaultRouter address');

      const code = await ethers.provider.getCode(deployed.VaultCore);
      console.log('🔎 VaultCore @', deployed.VaultCore, 'codeLen =', code.length);
      if (!code || code === '0x') throw new Error('VaultCore address has no code');

      const vaultCore = await ethers.getContractAt('VaultCore', deployed.VaultCore);
      const viewAddr = await vaultCore.viewContractAddrVar();
      if (!viewAddr || viewAddr === ethers.ZeroAddress) throw new Error('VaultCore.viewContractAddrVar() is zero');
      if (viewAddr.toLowerCase() !== deployed.VaultRouter.toLowerCase()) {
        throw new Error(`VaultCore.viewContractAddrVar mismatch: core=${viewAddr} expected VaultRouter=${deployed.VaultRouter}`);
      }
      console.log('✅ Architecture check: VaultCore.viewContractAddrVar matches deployed VaultRouter');
    } catch (e) {
      // strict: fail fast on mainnet deployment
      throw e;
    }

    // 4) 生成前端配置
    fs.mkdirSync(FRONTEND_DIR, { recursive: true });
    const frontendContent = `// 自动生成的合约配置文件 - Arbitrum Mainnet
// Auto-generated contract configuration file - Arbitrum Mainnet
// 生成时间 Generated at: ${new Date().toISOString()}

export const CONTRACT_ADDRESSES = {
  ${Object.entries(deployed).map(([k, v]) => `  ${k}: '${v}'`).join(',\n')}
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

    // 5) 输出摘要
    console.log('\n==== Deployment Addresses (arbitrum) ====');
    Object.entries(deployed).forEach(([n, a]) => console.log(`${n}: ${a}`));
    console.log('========================================\n');
    
  } catch (error) {
    console.error('❌ 部署失败 Deployment failed:', error);
    throw error;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

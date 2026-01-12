/**
 * 本地网络一键部署脚本（符合 contracts/docs/Architecture-Guide.md）
 * - 部署 Registry 核心模块（Registry + RegistryCore）
 * - 部署并注册核心业务与视图模块（ACM/白名单/Oracle/Updater/FeeRouter/CM/LE/VaultStorage/VBL/VaultRouter/VaultCore/HealthView）
 * - 写入 scripts/deployments/localhost.json 与 frontend-config/contracts-localhost.ts
 * - 确保前端 `Frontend/src/services/config/network.ts` 读取的地址齐全
 */

import fs from 'fs';
import path from 'path';
import { deployRegistryStack } from './modules/registry';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const hre = require('hardhat');
const { ethers, upgrades, network } = hre;

type DeployMap = Record<string, string>;

const DEPLOY_DIR = path.join(__dirname, '..', 'deployments');
const DEPLOY_FILE = path.join(DEPLOY_DIR, 'localhost.json');
// 将前端配置输出到 contracts/frontend-config，供前端直接导入使用
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend-config');
const FRONTEND_FILE = path.join(FRONTEND_DIR, 'contracts-localhost.ts');
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
  opts: BindModuleOptions = {}
): Promise<{ changed: boolean }> {
  if (!addr || addr === ethers.ZeroAddress) return { changed: false };
  const key = keyOf(keyUpperSnake);
  const label = opts.label ?? keyUpperSnake;
  try {
    const existing: string = await registry.getModule(key);
    if (existing && existing !== ethers.ZeroAddress && existing.toLowerCase() === addr.toLowerCase()) {
      if (opts.logIfUnchanged) console.log(`↪️ ${label} already set`);
      return { changed: false };
    }
    await (await registry.setModule(key, addr)).wait();
    console.log(`✅ Bound ${label} -> ${addr}`);
    return { changed: true };
  } catch (e) {
    console.log(`⚠️ Failed to bind ${label}:`, e);
    return { changed: false };
  }
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
  // ⚠️ 安全策略：默认严格（不自动 unsafeAllow）。
  // - 如果合约含 constructor(_disableInitializers)，请在合约里加：
  //   `/// @custom:oz-upgrades-unsafe-allow constructor`
  // - 如果确实需要 delegatecall / 外部库链接，请在合约里用对应的
  //   `@custom:oz-upgrades-unsafe-allow ...` 精准标注并在代码层做权限/输入约束。
  // Phase 0c (OZ v5 migration): default to UUPS unless explicitly overridden.
  const defaultOpts = { kind: 'uups', ...opts };
  const p = await upgrades.deployProxy(f, args, defaultOpts);
  await p.waitForDeployment();
  const addr = await p.getAddress();
  console.log(`✅ ${name} (proxy) deployed @ ${addr}`);
  return addr;
}

async function main() {
  console.log(`Network: ${network.name}`);
  // 本地网络预清理：清空 Hardhat 缓存/构建产物与旧的前端地址文件，保证每次干净部署
  if (network.name === 'localhost') {
    try {
      await hre.run('clean');
      console.log('🧼 Hardhat clean executed (artifacts/cache cleared)');
    } catch (e) {
      console.log('⚠️ Hardhat clean skipped:', e);
    }
    try {
      if (fs.existsSync(FRONTEND_FILE)) {
        fs.unlinkSync(FRONTEND_FILE);
        console.log('🧹 Removed previous frontend config file');
      }
    } catch (e) {
      console.log('⚠️ Frontend config cleanup skipped:', e);
    }
  }
  // 确保 artifacts 可用：在脚本开始时编译（适配 CI/冷启动）
  try {
    await hre.run('compile');
  } catch (e) {
    console.log('⚠️ Compile step failed or skipped:', e);
  }
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  const deployed: DeployMap = load();
  // 本地网络：每次启动都从干净状态部署，避免使用残留地址
  if (network.name === 'localhost') {
    try {
      if (fs.existsSync(DEPLOY_FILE)) fs.unlinkSync(DEPLOY_FILE);
    } catch (err) {
      console.log('⚠️ Failed to remove previous deployment file:', err);
    }
    for (const k of Object.keys(deployed)) delete (deployed as Record<string, unknown>)[k];
    save(deployed);
    console.log('🧹 Localhost mode: cleared previous deployments');
  }
  // 清理不再部署的残留（如历史 JSON 中的 RWAToken）
  const residuals = ['RWAToken'];
  for (const key of residuals) {
    if ((deployed as Record<string, unknown>)[key]) {
      delete (deployed as Record<string, unknown>)[key];
      save(deployed);
      console.log(`🧹 Removed residual from deployments: ${key}`);
    }
  }

  // 1) 部署 Registry + 核心子模块（仅需 RegistryCore 支持 setModule）
  // 建议最小延迟 1 小时（本地可设为 1 分钟方便调试）
  const MIN_DELAY = 60; // seconds (local dev)

  await deployRegistryStack({
    ethers,
    deployed,
    save,
    deployProxy,
    config: {
      minDelaySeconds: MIN_DELAY,
      initialOwner: deployer.address,
      upgradeAdmin: deployer.address,
      emergencyAdmin: deployer.address,
      deployerAddress: deployer.address,
      // Local keeps legacy modules for compatibility/testing.
      deployCompatModules: true,
      deployDynamicModuleKeyRegistry: true,
    },
  });

  // 2) 部署核心/视图/账本与支撑模块
  if (!deployed.AccessControlManager) {
    // 非升级合约（构造函数接收 owner）
    deployed.AccessControlManager = await deployRegular('AccessControlManager', deployer.address);
    save(deployed);
  }

  // 2.1) 统一缓存维护器（A 类模块地址缓存：统一刷新入口）
  // - 非升级合约（constructor 接收 Registry 地址）
  // - Registry 将以 KEY_CACHE_MAINTENANCE_MANAGER 指向该合约
  // - 目标合约侧 refreshModuleCache() 将严格校验 msg.sender == Registry[KEY_CACHE_MAINTENANCE_MANAGER]
  if (!deployed.CacheMaintenanceManager) {
    try {
      deployed.CacheMaintenanceManager = await deployRegular(
        'src/registry/CacheMaintenanceManager.sol:CacheMaintenanceManager',
        deployed.Registry
      );
      save(deployed);
    } catch (error) {
      console.log('⚠️ CacheMaintenanceManager deployment failed:', error);
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
    const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
    const adminAddress = process.env.LOCAL_ADMIN_ADDRESS || deployer.address;

    const roleNames = [
      'ACTION_ADMIN',
      // 本地可配置参数（用于 setTestingMode / StatisticsView.pushUserStatsUpdate 等）
      'SET_PARAMETER',
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
        // 先检查，避免 RoleAlreadyGranted() 回退
        const already = await acm.hasRole(role, adminAddress);
        if (already) {
          continue;
        }
        await (await acm.grantRole(role, adminAddress)).wait();
        console.log(`🔑 Granted ${r} to ${adminAddress}`);
      } catch (e) {
        // 角色已存在会 revert: RoleAlreadyGranted()，忽略
        console.log(`⚠️ Role ${r} grant skipped/failed:`, e);
      }
    }
    console.log('🔐 AccessControlManager: local admin granted ADMIN + read-only roles');
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

  if (!deployed.FeeRouter) {
    // platformBps / ecoBps 示例：9 (=0.09%), 1 (=0.01%)
    deployed.FeeRouter = await deployProxy('src/Vault/FeeRouter.sol:FeeRouter', [deployed.Registry, deployer.address, deployer.address, 9, 1]);
    save(deployed);
  }

  // 代币（Settlement）
  if (!deployed.MockUSDC) {
    const billion = ethers.parseUnits('1000000000', 18);
    deployed.MockUSDC = await deployRegular('MockERC20', 'USDC', 'USDC', billion);
    save(deployed);
  }

  // VaultStorage + VaultBusinessLogic + VaultRouter + VaultCore
  if (!deployed.VaultStorage) {
    // 暂以 MockUSDC 作为 RWA Token 占位，后续如需引入 RWA 再替换
    const rwaTokenForNow = deployed.MockUSDC;
    deployed.VaultStorage = await deployProxy('VaultStorage', [deployed.Registry, rwaTokenForNow, deployed.MockUSDC]);
    save(deployed);
  }

  if (!deployed.VaultBusinessLogic) {
    deployed.VaultBusinessLogic = await deployProxy('VaultBusinessLogic', [deployed.Registry, deployed.MockUSDC]);
    save(deployed);
  }

  // 部署 VaultRouter（View / Router 协调器）
  // 按 Architecture-Guide：View 地址应通过 KEY_VAULT_CORE → viewContractAddrVar() 解析，因此 VaultCore 初始化时必须拿到最终 VaultRouter 地址。
  if (!deployed.VaultRouter) {
    console.log('🚀 Deploying VaultRouter...');
    deployed.VaultRouter = await deployProxy(
      'src/Vault/VaultRouter.sol:VaultRouter',
      [
        deployed.Registry,
        deployed.AssetWhitelist,
        deployed.PriceOracle,
        deployed.MockUSDC, // settlement token
        deployer.address, // owner (UUPS)
      ],
      {}
    );
    save(deployed);
    console.log('✅ VaultRouter deployed @', deployed.VaultRouter);
  }

  // 给 VaultRouter 授权 SET_PARAMETER：用于在业务路径内 best-effort 推送 StatisticsView（pushUserStatsUpdate）
  // 以及本地脚本中可能调用的 setTestingMode 等能力。
  try {
    const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
    const SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    await (await acm.grantRole(SET_PARAMETER, deployed.VaultRouter)).wait();
    console.log('🔑 Granted SET_PARAMETER to VaultRouter');
  } catch (e) {
    console.log('⚠️ Grant SET_PARAMETER to VaultRouter skipped:', e);
  }

  // 给 VaultRouter 授权 ACTION_VIEW_PUSH：PositionView/HealthView 等 View Push API 需要该角色
  // （VaultRouter 是 View 推送的统一转发点：VaultCore → VaultRouter → PositionView/…）
  try {
    const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
    const ACTION_VIEW_PUSH = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_PUSH'));
    await (await acm.grantRole(ACTION_VIEW_PUSH, deployed.VaultRouter)).wait();
    console.log('🔑 Granted ACTION_VIEW_PUSH to VaultRouter');
  } catch (e) {
    console.log('⚠️ Grant ACTION_VIEW_PUSH to VaultRouter skipped:', e);
  }

  if (!deployed.VaultCore) {
    // VaultCore.initialize(registry, view)
    deployed.VaultCore = await deployProxy('VaultCore', [deployed.Registry, deployed.VaultRouter]);
    save(deployed);
  }

  // 确认 VaultCore 地址有效（本地链重启后旧地址可能无代码），无代码则自动重部署
  try {
    if (deployed.VaultCore) {
      const vcoreCode = await ethers.provider.getCode(deployed.VaultCore);
      if (!vcoreCode || vcoreCode === '0x') {
        console.log('⚠️ Detected empty code at VaultCore address, re-deploying VaultCore...');
        deployed.VaultCore = await deployProxy('VaultCore', [deployed.Registry, deployed.VaultRouter]);
        save(deployed);
        console.log('✅ VaultCore re-deployed @', deployed.VaultCore);
      }
    }
  } catch (err) {
    console.log('⚠️ VaultCore code check failed:', err);
  }

  // CollateralManager（CM）
  if (!deployed.CollateralManager) {
    // CollateralManager has legacy overloaded initializer; disambiguate for OZ upgrades.
    deployed.CollateralManager = await deployProxy('CollateralManager', [deployed.Registry], { initializer: 'initialize(address)' });
    save(deployed);
  }

  // LendingEngine（核心账本，使用 core/LendingEngine）
  if (!deployed.LendingEngine) {
    deployed.LendingEngine = await deployProxy('src/core/LendingEngine.sol:LendingEngine', [deployed.Registry]);
    save(deployed);
  }

  // VaultLendingEngine（Vault借贷引擎）
  if (!deployed.VaultLendingEngine) {
    try {
      deployed.VaultLendingEngine = await deployProxy('src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine', [deployed.PriceOracle, deployed.MockUSDC, deployed.Registry]);
      save(deployed);
    } catch (error) {
      console.log('⚠️ VaultLendingEngine deployment failed:', error);
    }
  }

  // EarlyRepaymentGuaranteeManager（提前还款保证金管理器）
  if (!deployed.EarlyRepaymentGuaranteeManager) {
    try {
      deployed.EarlyRepaymentGuaranteeManager = await deployProxy('src/Vault/modules/EarlyRepaymentGuaranteeManager.sol:EarlyRepaymentGuaranteeManager', [deployed.VaultCore, deployed.Registry, deployer.address, 500]); // 5% 平台费率
      save(deployed);
    } catch (error) {
      console.log('⚠️ EarlyRepaymentGuaranteeManager deployment failed:', error);
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

  // LiquidationConfigModule（清算配置模块，方案B：阈值/最小健康因子 SSOT）
  // - 作为 KEY_LIQUIDATION_CONFIG_MANAGER 的权威实现
  // - RiskManager 会 best-effort 读取该模块作为阈值 SSOT；写路径将通过该模块保留原始 caller 的 role 校验语义
  if (!deployed.LiquidationConfigModule) {
    try {
      deployed.LiquidationConfigModule = await deployProxy(
        'src/Vault/liquidation/modules/LiquidationConfigModule.sol:LiquidationConfigModule',
        [deployed.Registry, deployed.AccessControlManager]
      );
      save(deployed);
      console.log('✅ LiquidationConfigModule deployed @', deployed.LiquidationConfigModule);
    } catch (error) {
      console.log('⚠️ LiquidationConfigModule deployment failed:', error);
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
      const registry = await ethers.getContractAt('Registry', deployed.Registry);

      // 最小前置绑定（不依赖后续“统一注册模块”步骤）
      // NOTE: LiquidationRiskManager.initialize() will prime these modules and revert if missing.
      await bindRegistryModule(registry, 'COLLATERAL_MANAGER', deployed.CollateralManager);
      await bindRegistryModule(registry, 'LENDING_ENGINE', deployed.VaultLendingEngine);
      await bindRegistryModule(registry, 'HEALTH_VIEW', deployed.HealthView);
      // Optional (Option B): ConfigManager SSOT for thresholds
      await bindRegistryModule(registry, 'LIQUIDATION_CONFIG_MANAGER', deployed.LiquidationConfigModule);

      const initialMaxCacheDuration = 300; // 5分钟
      const initialMaxBatchSize = 50;
      // 重要：LiquidationRiskLib / LiquidationRiskBatchLib 已改为纯 internal 库（不再外部链接），
      // 因此这里不再部署/链接 library，避免 OZ Upgrades error-006。
      deployed.LiquidationRiskManager = await deployProxy(
        'src/Vault/liquidation/modules/LiquidationRiskManager.sol:LiquidationRiskManager',
        [
          deployed.Registry,
          deployed.AccessControlManager,
          initialMaxCacheDuration,
          initialMaxBatchSize,
        ]
      );
      save(deployed);
      console.log('✅ LiquidationRiskManager deployed @', deployed.LiquidationRiskManager);
    } catch (error) {
      console.log('⚠️ LiquidationRiskManager deployment failed:', error);
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
    try {
      // 部署但不执行 initialize，避免 Registry 模块尚未注册导致 _refreshModuleCache 失败
      deployed.PositionView = await deployProxy(
        'src/Vault/view/modules/PositionView.sol:PositionView',
        [],
        { initializer: false }
      );
      save(deployed);
    } catch (error) { console.log('⚠️ PositionView deployment failed:', error); }
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

  // LiquidationRiskView（清算风险只读视图）
  if (!deployed.LiquidationRiskView) {
    try {
      // 同上：LiquidationRiskLib 已为 internal 库，无需链接
      deployed.LiquidationRiskView = await deployProxy(
        'src/Vault/view/modules/LiquidationRiskView.sol:LiquidationRiskView',
        [deployed.Registry]
      );
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

  // GuaranteeFundManager（如文件存在且需要）
  if (!deployed.GuaranteeFundManager) {
    try {
      // initialize(address vaultCore, address registry, address upgradeAdmin)
      deployed.GuaranteeFundManager = await deployProxy('GuaranteeFundManager', [deployed.VaultCore, deployed.Registry, deployer.address]);
      save(deployed);
    } catch (error) {
      console.log('⚠️ GuaranteeFundManager deployment failed:', error);
    }
  }

  // 确认 GuaranteeFundManager 地址不与 VaultCore 冲突且功能可用；如冲突或不可用则重部署
  try {
    if (deployed.GuaranteeFundManager) {
      if (deployed.VaultCore && deployed.GuaranteeFundManager.toLowerCase() === deployed.VaultCore.toLowerCase()) {
        console.log('⚠️ GuaranteeFundManager address equals VaultCore. Re-deploying GuaranteeFundManager to avoid collision...');
        deployed.GuaranteeFundManager = await deployProxy('GuaranteeFundManager', [deployed.VaultCore, deployed.Registry, deployer.address]);
        save(deployed);
        console.log('✅ GuaranteeFundManager re-deployed @', deployed.GuaranteeFundManager);
      } else {
        // 调用只在 GFM 上存在的方法来验证合约类型
        try {
          const gfm = await ethers.getContractAt('GuaranteeFundManager', deployed.GuaranteeFundManager);
          await gfm.vaultCoreAddr();
        } catch (verifyErr) {
          console.log('⚠️ GuaranteeFundManager at address is not functioning. Re-deploying...', verifyErr);
          deployed.GuaranteeFundManager = await deployProxy('GuaranteeFundManager', [deployed.VaultCore, deployed.Registry, deployer.address]);
          save(deployed);
          console.log('✅ GuaranteeFundManager re-deployed @', deployed.GuaranteeFundManager);
        }
      }
    }
  } catch (err) {
    console.log('⚠️ GuaranteeFundManager validation failed:', err);
  }

  // ====== 奖励系统（完整）======
  if (!deployed.RewardPoints) {
    try {
      deployed.RewardPoints = await deployProxy(
        'src/Token/RewardPoints.sol:RewardPoints',
        [deployer.address],
        {}
      );
      save(deployed);
    } catch (error) { console.log('⚠️ RewardPoints deployment failed:', error); }
  }
  // 确认 RewardPoints 地址有效（本地链重启后旧地址可能无代码），无代码则自动重部署
  try {
    if (deployed.RewardPoints) {
      const rpCode = await ethers.provider.getCode(deployed.RewardPoints);
      if (!rpCode || rpCode === '0x') {
        console.log('⚠️ Detected empty code at RewardPoints address, re-deploying RewardPoints...');
        deployed.RewardPoints = await deployProxy(
          'src/Token/RewardPoints.sol:RewardPoints',
          [deployer.address],
          {}
        );
        save(deployed);
        console.log('✅ RewardPoints re-deployed @', deployed.RewardPoints);
      }
    }
  } catch (err) {
    console.log('⚠️ RewardPoints code check failed:', err);
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
        const rp = await ethers.getContractAt('src/Token/RewardPoints.sol:RewardPoints', deployed.RewardPoints);
        
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
        
        // 使用合约的MINTER_ROLE常量，而不是手动计算
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

  // 2.99) 部署 LiquidationManager（方案A：直达账本 + View 单点推送）
  // NOTE: 该模块将作为 Registry.KEY_LIQUIDATION_MANAGER 的唯一清算入口；
  //       VaultBusinessLogic 不再作为清算入口绑定（避免写路径分叉/权限不一致）。
  if (!deployed.LiquidationManager) {
    try {
      deployed.LiquidationManager = await deployProxy('LiquidationManager', [deployed.Registry]);
      save(deployed);
      console.log('✅ LiquidationManager deployed @', deployed.LiquidationManager);
    } catch (error) {
      console.log('⚠️ LiquidationManager deployment failed:', error);
    }
  }

  // 2.99.0) 部署 SettlementManager（统一结算/清算写入口，SSOT）
  // NOTE: 该模块将作为 Registry.KEY_SETTLEMENT_MANAGER 的唯一对外写入口；
  if (!deployed.SettlementManager) {
    try {
      deployed.SettlementManager = await deployProxy('SettlementManager', [deployed.Registry]);
      save(deployed);
      console.log('✅ SettlementManager deployed @', deployed.SettlementManager);
    } catch (error) {
      console.log('⚠️ SettlementManager deployment failed:', error);
    }
  }

  // 2.99.0.5) 部署 LenderPoolVault（线上流动性资金池，推荐）
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

  // 2.99.2) 部署 LiquidationPayoutManager（残值分配）
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

  // 2.99.1) 授权 LiquidationManager 执行清算（ACTION_LIQUIDATE）
  // - Vault/LendingEngine/CollateralManager 内部会对 msg.sender 做 ACTION_LIQUIDATE 校验；
  // - 因此必须给 LiquidationManager 授权，否则清算会在 CM/LE 处回滚。
  try {
    if (deployed.AccessControlManager && deployed.LiquidationManager) {
      const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
      const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'));
      const already = await acm.hasRole(ACTION_LIQUIDATE, deployed.LiquidationManager);
      if (!already) {
        await (await acm.grantRole(ACTION_LIQUIDATE, deployed.LiquidationManager)).wait();
        console.log('🔑 Granted ACTION_LIQUIDATE to LiquidationManager');
      }
    }
  } catch (e) {
    console.log('⚠️ Grant ACTION_LIQUIDATE to LiquidationManager skipped/failed:', e);
  }

  // 2.99.1.1) 授权 SettlementManager 触发清算执行器（LiquidationManager 会校验 caller 具备 LIQUIDATE）
  try {
    if (deployed.AccessControlManager && deployed.SettlementManager) {
      const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
      const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'));
      const already = await acm.hasRole(ACTION_LIQUIDATE, deployed.SettlementManager);
      if (!already) {
        await (await acm.grantRole(ACTION_LIQUIDATE, deployed.SettlementManager)).wait();
        console.log('🔑 Granted ACTION_LIQUIDATE to SettlementManager');
      }
    }
  } catch (e) {
    console.log('⚠️ Grant ACTION_LIQUIDATE to SettlementManager skipped/failed:', e);
  }

  // 2.99.1.2) 授权 SettlementManager 执行订单级还款与只读查询（ORDER_ENGINE.repay / _getLoanOrderForView）
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

  // 3) 注册模块到 Registry（通过 NAME -> UPPER_SNAKE -> bytes32 key）
  const registry = await ethers.getContractAt('Registry', deployed.Registry);

  const NAME_TO_KEY: Record<string, string> = {
    RegistrySignatureManager: 'REGISTRY_SIGNATURE_MANAGER',
    RegistryHistoryManager: 'REGISTRY_HISTORY_MANAGER',
    RegistryBatchManager: 'REGISTRY_BATCH_MANAGER',
    RegistryHelper: 'REGISTRY_HELPER',
    RegistryDynamicModuleKey: 'DYNAMIC_MODULE_REGISTRY',
    AccessControlManager: 'ACCESS_CONTROL_MANAGER',
    CacheMaintenanceManager: 'CACHE_MAINTENANCE_MANAGER',
    AssetWhitelist: 'ASSET_WHITELIST',
    AuthorityWhitelist: 'AUTHORITY_WHITELIST',
    PriceOracle: 'PRICE_ORACLE',
    CoinGeckoPriceUpdater: 'COINGECKO_PRICE_UPDATER',
    FeeRouter: 'FEE_ROUTER',
    FeeRouterView: 'FEE_ROUTER_VIEW',
    RewardPoints: 'REWARD_POINTS',
    RewardManagerCore: 'REWARD_MANAGER_CORE',
    RewardCore: 'REWARD_CORE',
    RewardManager: 'REWARD_MANAGER',
    CollateralManager: 'COLLATERAL_MANAGER',
    // core/LendingEngine 是订单引擎（createLoanOrder/repay order），应绑定到 ORDER_ENGINE（ModuleKeys.KEY_ORDER_ENGINE）
    LendingEngine: 'ORDER_ENGINE',
    LendingEngineView: 'LENDING_ENGINE_VIEW',
    VaultBusinessLogic: 'VAULT_BUSINESS_LOGIC',
    VaultCore: 'VAULT_CORE',
    // VaultRouter: 'VAULT_VIEW', // 架构建议通过 KEY_VAULT_CORE 解析，不强依赖
    VaultStorage: 'VAULT_STORAGE',
    // VaultLendingEngine 实现 ILendingEngineBasic（供 VaultCore.borrow/repay 使用）
    // 需要绑定到 LENDING_ENGINE（ModuleKeys.KEY_LE）
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
    LiquidatorView: 'LIQUIDATION_VIEW',
    LiquidationConfigModule: 'LIQUIDATION_CONFIG_MANAGER',
    LiquidationManager: 'LIQUIDATION_MANAGER',
    SettlementManager: 'SETTLEMENT_MANAGER',
    LiquidationPayoutManager: 'LIQUIDATION_PAYOUT_MANAGER',
    LenderPoolVault: 'LENDER_POOL_VAULT',
    GuaranteeFundManager: 'GUARANTEE_FUND_MANAGER',
    LoanNFT: 'LOAN_NFT',
    MockUSDC: 'SETTLEMENT_TOKEN',
    LiquidationRiskManager: 'LIQUIDATION_RISK_MANAGER',
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
    'CacheMaintenanceManager',
    'AssetWhitelist',
    'AuthorityWhitelist',
    'PriceOracle',
    'CoinGeckoPriceUpdater',
    'VaultLendingEngine',
    'EarlyRepaymentGuaranteeManager',
    'DegradationCore',
    'DegradationMonitor',
    'DegradationStorage',
    'ModuleHealthView',
    'BatchView',
    'LiquidationRiskView',
    'LiquidationPayoutManager',
    'LiquidationManager',
    'SettlementManager',
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
    'RewardPoints',
    'RewardManagerCore',
    'RewardCore',
    'RewardManager',
    'RewardView',
    'RewardConfig',
    'RewardConsumption',
    'ValuationOracleView',
    'LiquidatorView',
    'LiquidationConfigModule',
    'GuaranteeFundManager',
    'LoanNFT',
    'MockUSDC',
    'RegistryDynamicModuleKey', // 添加动态模块键注册表
    'LiquidationRiskManager',
  ];

  // SSOT: single pass registry binding (only logs on change)
  let registryChanged = 0;
  let registryUnchanged = 0;
  for (const name of modules) {
    const addr = deployed[name];
    if (!addr) continue;
    const upperSnake = NAME_TO_KEY[name];
    if (!upperSnake) continue;
    const { changed } = await bindRegistryModule(registry, upperSnake, addr);
    if (changed) registryChanged += 1;
    else registryUnchanged += 1;
  }

  // Legacy compatibility: bind KEY_STATS (VAULT_STATISTICS) -> StatisticsView
  const stats = await bindRegistryModule(registry, 'VAULT_STATISTICS', deployed.StatisticsView, {
    label: 'KEY_STATS (VAULT_STATISTICS)',
  });
  if (stats.changed) registryChanged += 1;
  else registryUnchanged += 1;

  console.log(`🧾 Registry binding summary: changed=${registryChanged}, unchanged=${registryUnchanged}`);

  // 设置动态模块键注册表到Registry
  if (deployed.RegistryDynamicModuleKey) {
    try {
      await (await registry.setDynamicModuleKeyRegistry(deployed.RegistryDynamicModuleKey)).wait();
      console.log('✅ Dynamic module key registry set in Registry');
    } catch (error) {
      console.log('⚠️ Failed to set dynamic module key registry:', error);
    }
  }



  // 3.2 架构一致性断言（关键）：
  // - 按 Architecture-Guide：View 地址应通过 KEY_VAULT_CORE → viewContractAddrVar() 解析；
  // - 不再写入/依赖额外的 Registry key（如 VAULT_VIEW），避免多来源导致地址漂移。
  try {
    if (!deployed.VaultCore || !deployed.VaultRouter) throw new Error('Missing VaultCore or VaultRouter address');

    const code = await ethers.provider.getCode(deployed.VaultCore);
    console.log('🔎 VaultCore @', deployed.VaultCore, 'codeLen =', code.length);
    if (!code || code === '0x') throw new Error('VaultCore address has no code');

    const vaultCore = await ethers.getContractAt('VaultCore', deployed.VaultCore);
    const viewAddr = await vaultCore.viewContractAddrVar();
    if (!viewAddr || viewAddr === ethers.ZeroAddress) {
      throw new Error('VaultCore.viewContractAddrVar() is zero');
    }
    if (viewAddr.toLowerCase() !== deployed.VaultRouter.toLowerCase()) {
      throw new Error(
        `VaultCore.viewContractAddrVar mismatch: core=${viewAddr} expected VaultRouter=${deployed.VaultRouter}`
      );
    }
    console.log('✅ Architecture check: VaultCore.viewContractAddrVar matches deployed VaultRouter');
  } catch (e) {
    console.log('❌ Architecture check failed:', e);
    throw e;
  }

  // 4) 生成前端配置
  // 在生成前端配置前，初始化 PositionView（若尚未初始化）
  try {
    if (deployed.PositionView) {
      const pv = await ethers.getContractAt('PositionView', deployed.PositionView);
      let regAddr = ethers.ZeroAddress;
      try { regAddr = await pv.getRegistry(); } catch (_) { /* ignore */ }
      if (regAddr === ethers.ZeroAddress) {
        console.log('🔧 Initializing PositionView...');
        await (await pv.initialize(deployed.Registry)).wait();
        console.log('✅ PositionView initialized with registry', deployed.Registry);
      }
    }
  } catch (error) {
    console.log('⚠️ PositionView initialization after module registration failed:', error);
  }
  fs.mkdirSync(FRONTEND_DIR, { recursive: true });
  const frontendContent = `// 自动生成的合约配置文件 - Localhost
// Auto-generated contract configuration file - Localhost
// 生成时间 Generated at: ${new Date().toISOString()}

export const CONTRACT_ADDRESSES = {
  ${Object.entries(deployed).map(([k, v]) => `  ${k}: '${v}'`).join(',\n')}
};

export const NETWORK_CONFIG = {
  chainId: 1337,
  rpcUrl: 'http://127.0.0.1:8545',
  explorer: 'http://127.0.0.1:8545',
  name: 'localhost'
};

// 使用示例 Usage example:
// import { CONTRACT_ADDRESSES, NETWORK_CONFIG } from './contracts-localhost';
// const vaultCoreAddress = CONTRACT_ADDRESSES.VaultCore;
`;
  fs.writeFileSync(FRONTEND_FILE, frontendContent);
  console.log(`📝 Frontend config written: ${FRONTEND_FILE}`);

  // 5)（可选）动态模块键功能验证：为避免不同版本 ABI 差异导致的 BAD_DATA，这里省略主动验证

  // 6) 输出摘要
  console.log('\n==== Deployment Addresses (localhost) ====');
  Object.entries(deployed).forEach(([n, a]) => console.log(`${n}: ${a}`));
  console.log('========================================\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});



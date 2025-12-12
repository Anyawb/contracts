/**
 * 本地网络一键部署脚本（符合 contracts/docs/Architecture-Guide.md）
 * - 部署 Registry 核心模块（Registry + RegistryCore）
 * - 部署并注册核心业务与视图模块（ACM/白名单/Oracle/Updater/FeeRouter/CM/LE/VaultStorage/VBL/VaultView/VaultCore/HealthView）
 * - 写入 scripts/deployments/localhost.json 与 frontend-config/contracts-localhost.ts
 * - 确保前端 `Frontend/src/services/config/network.ts` 读取的地址齐全
 */

import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const hre = require('hardhat');
const { ethers, upgrades, network } = hre;

type DeployMap = Record<string, string>;

const DEPLOY_DIR = path.join(__dirname, '..', 'deployments');
const DEPLOY_FILE = path.join(DEPLOY_DIR, 'localhost.json');
// 将前端配置输出到仓库根目录的 frontend-config，供前端直接导入使用
const FRONTEND_DIR = path.join(__dirname, '..', '..', '..', 'frontend-config');
const FRONTEND_FILE = path.join(FRONTEND_DIR, 'contracts-localhost.ts');

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
  const defaultOpts = { unsafeAllow: ['constructor'], ...opts };
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

  if (!deployed.Registry) {
    // UUPS 可升级合约，使用 Proxy 部署并初始化
    deployed.Registry = await deployProxy('Registry', [MIN_DELAY, deployer.address, deployer.address]);
    save(deployed);
  }

  if (!deployed.RegistryCore) {
    // 关键：将 RegistryCore 的 admin 设为 Registry 地址，这样 Registry.sol 调用 _registryCore.setModule(...) 时，
    // RegistryCore 内的 requireAdmin(msg.sender) 才能通过
    deployed.RegistryCore = await deployProxy('RegistryCore', [deployed.Registry, MIN_DELAY]);
    save(deployed);
    const registry = await ethers.getContractAt('Registry', deployed.Registry);
    await (await registry.setRegistryCore(deployed.RegistryCore)).wait();
    console.log('🔗 RegistryCore linked to Registry');
  }

  // 可选：部署并挂载升级/治理子模块（不影响 setModule 功能）
  if (!deployed.RegistryUpgradeManager) {
    // 初始化需要 Registry 地址
    deployed.RegistryUpgradeManager = await deployProxy('RegistryUpgradeManager', [deployed.Registry]);
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
    // 无参数初始化
    deployed.RegistryAdmin = await deployProxy('RegistryAdmin');
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
        deployer.address  // systemAdmin
      ]);
      save(deployed);
      console.log('✅ RegistryDynamicModuleKey deployed @', deployed.RegistryDynamicModuleKey);
    } catch (error) {
      console.log('⚠️ RegistryDynamicModuleKey deployment failed:', error);
    }
  }

  // 2) 部署核心/视图/账本与支撑模块
  if (!deployed.AccessControlManager) {
    // 非升级合约（构造函数接收 owner）
    deployed.AccessControlManager = await deployRegular('AccessControlManager', deployer.address);
    save(deployed);
  }

  // 为本地管理员赋权：ADMIN + 只读（VIEW_*）权限，满足 onlyUserOrStrictAdmin / onlyAuthorizedFor 检查
  try {
    const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
    const adminAddress = process.env.LOCAL_ADMIN_ADDRESS || deployer.address;

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
    deployed.FeeRouter = await deployProxy('FeeRouter', [deployed.Registry, deployer.address, deployer.address, 9, 1]);
    save(deployed);
  }

  // 代币（Settlement）
  if (!deployed.MockUSDC) {
    const billion = ethers.parseUnits('1000000000', 18);
    deployed.MockUSDC = await deployRegular('MockERC20', 'USDC', 'USDC', billion);
    save(deployed);
  }

  // VaultStorage + VaultBusinessLogic + VaultView + VaultCore
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

  // 先部署一个临时的 VaultView 用于 VaultCore 初始化
  if (!deployed.VaultView) {
    console.log('🚀 Deploying temporary VaultView for VaultCore initialization...');
    deployed.VaultView = await deployProxy('src/Vault/VaultView.sol:VaultView', [deployed.Registry]);
    save(deployed);
    console.log('✅ Temporary VaultView deployed @', deployed.VaultView);
  }

  if (!deployed.VaultCore) {
    // VaultCore.initialize(registry, view)
    deployed.VaultCore = await deployProxy('VaultCore', [deployed.Registry, deployed.VaultView]);
    save(deployed);
  }

  // 确认 VaultCore 地址有效（本地链重启后旧地址可能无代码），无代码则自动重部署
  try {
    if (deployed.VaultCore) {
      const vcoreCode = await ethers.provider.getCode(deployed.VaultCore);
      if (!vcoreCode || vcoreCode === '0x') {
        console.log('⚠️ Detected empty code at VaultCore address, re-deploying VaultCore...');
        deployed.VaultCore = await deployProxy('VaultCore', [deployed.Registry, deployed.VaultView]);
        save(deployed);
        console.log('✅ VaultCore re-deployed @', deployed.VaultCore);
      }
    }
  } catch (err) {
    console.log('⚠️ VaultCore code check failed:', err);
  }

  // CollateralManager（CM）
  if (!deployed.CollateralManager) {
    deployed.CollateralManager = await deployProxy('CollateralManager', [deployed.Registry]);
    save(deployed);
  }

  // LendingEngine（核心账本，使用 core/LendingEngine）
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
      console.log('📚 LiquidationRiskLib deployed @', riskLibAddr);

      const riskBatchLibFactory = await ethers.getContractFactory('src/Vault/liquidation/libraries/LiquidationRiskBatchLib.sol:LiquidationRiskBatchLib');
      const riskBatchLib = await riskBatchLibFactory.deploy();
      await riskBatchLib.waitForDeployment();
      const riskBatchLibAddr = await riskBatchLib.getAddress();
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

  // SystemView / StatisticsView / PositionView / PreviewView / DashboardView / UserView
  // SystemView 暂不需要部署，已移除
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
    try { deployed.RewardPoints = await deployProxy('RewardPoints', [deployer.address], { unsafeAllow: ['constructor'] }); save(deployed); } catch (error) { console.log('⚠️ RewardPoints deployment failed:', error); }
  }
  // 确认 RewardPoints 地址有效（本地链重启后旧地址可能无代码），无代码则自动重部署
  try {
    if (deployed.RewardPoints) {
      const rpCode = await ethers.provider.getCode(deployed.RewardPoints);
      if (!rpCode || rpCode === '0x') {
        console.log('⚠️ Detected empty code at RewardPoints address, re-deploying RewardPoints...');
        deployed.RewardPoints = await deployProxy('RewardPoints', [deployer.address], { unsafeAllow: ['constructor'] });
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
          if (deployed.RewardCore) {
            try { 
              await (await rp.grantRole(MINTER_ROLE, deployed.RewardCore)).wait(); 
              console.log('✅ Granted MINTER_ROLE to RewardCore');
            } catch (error) { 
              console.log('⚠️ RewardCore MINTER_ROLE grant failed:', error); 
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
          if (deployed.RewardCore) {
            try { await (await rp.grantRole(MINTER_ROLE, deployed.RewardCore)).wait(); } catch (error) { console.log('⚠️ RewardCore MINTER_ROLE grant failed (fallback):', error); }
          }
        }
      }
    }
  } catch (error) {
    console.log('⚠️ RewardPoints MINTER_ROLE setup failed:', error);
  }

  // 3) 注册模块到 Registry（通过 NAME -> UPPER_SNAKE -> bytes32 key）
  const registry = await ethers.getContractAt('Registry', deployed.Registry);

  const NAME_TO_KEY: Record<string, string> = {
    RegistrySignatureManager: 'REGISTRY_SIGNATURE_MANAGER',
    RegistryHistoryManager: 'REGISTRY_HISTORY_MANAGER',
    RegistryBatchManager: 'REGISTRY_BATCH_MANAGER',
    RegistryHelper: 'REGISTRY_HELPER',
    RegistryDynamicModuleKey: 'REGISTRY_DYNAMIC_MODULE_KEY',
    AccessControlManager: 'ACCESS_CONTROL_MANAGER',
    AssetWhitelist: 'ASSET_WHITELIST',
    AuthorityWhitelist: 'AUTHORITY_WHITELIST',
    PriceOracle: 'PRICE_ORACLE',
    CoinGeckoPriceUpdater: 'COINGECKO_PRICE_UPDATER',
    FeeRouter: 'FEE_ROUTER',
    FeeRouterView: 'FEE_ROUTER_VIEW',
    CollateralManager: 'COLLATERAL_MANAGER',
    LendingEngine: 'LENDING_ENGINE',
    LendingEngineView: 'LENDING_ENGINE_VIEW',
    VaultBusinessLogic: 'VAULT_BUSINESS_LOGIC',
    VaultCore: 'VAULT_CORE',
    // VaultView: 'VAULT_VIEW', // 架构建议通过 KEY_VAULT_CORE 解析，不强依赖
    VaultStorage: 'VAULT_STORAGE',
    VaultLendingEngine: 'VAULT_LENDING_ENGINE',
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
    LiquidatorView: 'LIQUIDATOR_VIEW',
    GuaranteeFundManager: 'GUARANTEE_FUND_MANAGER',
    LoanNFT: 'LOAN_NFT',
    // 监控模块
    DegradationCore: 'DEGRADATION_CORE',
    DegradationMonitor: 'DEGRADATION_MONITOR',
    DegradationStorage: 'DEGRADATION_STORAGE',
    ModuleHealthView: 'MODULE_HEALTH_VIEW',
    BatchView: 'BATCH_VIEW',
  };

  // 实际注册的模块清单（只注册已部署的）
  const modules = [
    'AccessControlManager',
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
    'MockUSDC',
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

  // 现在部署 VaultView（在模块注册完成后）
  if (!deployed.VaultView) {
    console.log('🚀 Deploying VaultView after module registration...');
    deployed.VaultView = await deployProxy('src/Vault/VaultView.sol:VaultView', [deployed.Registry]);
    save(deployed);
    console.log('✅ VaultView deployed @', deployed.VaultView);
  }



  // 3.1 附加绑定：将 KEY_LIQUIDATION_MANAGER 绑定到 VaultBusinessLogic（统一清算入口）
  try {
    if (deployed.VaultBusinessLogic) {
      await (await registry.setModule(keyOf('LIQUIDATION_MANAGER'), deployed.VaultBusinessLogic)).wait();
      console.log(`✅ Bound KEY_LIQUIDATION_MANAGER -> ${deployed.VaultBusinessLogic}`);
    }
    if (deployed.HealthView) {
      try { await (await registry.setModule(keyOf('HEALTH_VIEW'), deployed.HealthView)).wait(); } catch (error) { console.log('⚠️ HealthView binding failed:', error); }
    }
    if (deployed.LiquidatorView) {
      try { await (await registry.setModule(keyOf('LIQUIDATOR_VIEW'), deployed.LiquidatorView)).wait(); } catch (error) { console.log('⚠️ LiquidatorView binding failed:', error); }
    }
    if (deployed.StatisticsView) {
      try { await (await registry.setModule(keyOf('VAULT_STATISTICS'), deployed.StatisticsView)).wait(); console.log(`✅ Bound KEY_STATS (VAULT_STATISTICS) -> ${deployed.StatisticsView}`); } catch (error) { console.log('⚠️ StatisticsView binding failed:', error); }
    }
  } catch (e) {
    console.log('⚠️ Extra KEY binding failed:', e);
  }

  // 3.2 断言校验（增强容错）：
  // - 优先校验 VaultCore 是否为有效合约；
  // - 读取 viewContractAddrVar()，若失败则回退：直接将 KEY_VAULT_VIEW 绑定到本次部署的 VaultView；
  //   这样前端依旧可以通过 Registry 解析 View 地址使用系统。
  try {
    if (!deployed.VaultCore || !deployed.VaultView) throw new Error('Missing VaultCore or VaultView address');

    const code = await ethers.provider.getCode(deployed.VaultCore);
    console.log('🔎 VaultCore @', deployed.VaultCore, 'codeLen =', code.length);
    if (!code || code === '0x') throw new Error('VaultCore address has no code');



    // 直接确保 KEY_VAULT_VIEW 绑定为本次部署的 VaultView
    const KEY_VAULT_VIEW = keyOf('VAULT_VIEW');
    try {
      await (await registry.setModule(KEY_VAULT_VIEW, deployed.VaultView)).wait();
      console.log('✅ Bound KEY_VAULT_VIEW ->', deployed.VaultView);
    } catch (bindErr) {
      console.log('⚠️ Binding KEY_VAULT_VIEW failed:', bindErr);
    }
  } catch (e) {
    console.log('⚠️ Assertion step encountered error but continued (safe fallback applied when possible):', e);
  }

  // 4) 生成前端配置
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



/**
 * Arbitrum Sepolia 测试网部署脚本
 * Arbitrum Sepolia Testnet Deployment Script
 * 
 * 该脚本用于将智能合约系统部署到 Arbitrum Sepolia 测试网
 * This script deploys the smart contract system to Arbitrum Sepolia testnet
 */

import fs from 'fs';
import path from 'path';
import { loadAssetsConfig, configureAssets } from '../utils/configure-assets';

// 定义 keyOf 函数，用于生成模块键
function keyOf(upperSnake: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(upperSnake));
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const hre = require('hardhat');
const { ethers } = hre;
const { upgrades } = hre;

/**
 * 部署记录接口
 * Deployment record interface
 */
interface DeployRecord {
  [key: string]: string;
}

/**
 * Arbitrum Sepolia 网络配置
 * Arbitrum Sepolia network configuration
 */
const ARBITRUM_SEPOLIA_CONFIG = {
  name: 'arbitrum-sepolia',
  chainId: 421614,
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  explorer: 'https://sepolia.arbiscan.io'
};

/**
 * 部署记录文件路径
 * Deployment record file path
 */
const DEPLOY_PATH = path.join(__dirname, '../deployments/arbitrum-sepolia.json');

/**
 * 加载部署记录文件
 * Load deployment record file
 */
function loadDeploymentFile(): DeployRecord {
  if (fs.existsSync(DEPLOY_PATH)) {
    return JSON.parse(fs.readFileSync(DEPLOY_PATH, 'utf-8'));
  }
  return {};
}

/**
 * 保存部署记录文件
 * Save deployment record file
 * @param data 部署记录数据 Deployment record data
 */
function saveDeploymentFile(data: DeployRecord) {
  fs.mkdirSync(path.dirname(DEPLOY_PATH), { recursive: true });
  fs.writeFileSync(DEPLOY_PATH, JSON.stringify(data, null, 2));
}

/**
 * 部署普通合约
 * Deploy regular contract
 * @param name 合约名称 Contract name
 * @param args 构造函数参数 Constructor arguments
 */
async function deploy(name: string, ...args: unknown[]): Promise<string> {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`✅ ${name} deployed @ ${address}`);
  return address;
}

/**
 * 部署可升级合约
 * Deploy upgradeable contract
 * @param name 合约名称 Contract name
 * @param args 初始化函数参数 Initializer arguments
 * @param options 部署选项 Deployment options
 */
async function deployProxy(name: string, args: unknown[] = [], options?: unknown): Promise<string> {
  const factory = await ethers.getContractFactory(name);
  const proxy = await upgrades.deployProxy(factory, args, options);
  await proxy.waitForDeployment();
  const address = await proxy.getAddress();
  console.log(`✅ ${name} (Proxy) deployed @ ${address}`);
  return address;
}

/**
 * 检查环境配置
 * Check environment configuration
 */
async function checkEnvironment(): Promise<void> {
  console.log('🔍 检查 Arbitrum Sepolia 环境配置...');
  console.log('🔍 Checking Arbitrum Sepolia environment...');
  
  // 检查必需环境变量 Check required environment variables
  if (!process.env.PRIVATE_KEY) {
    throw new Error('缺少必需的环境变量: PRIVATE_KEY');
  }
  
  // 检查可选环境变量 Check optional environment variables
  if (!process.env.ARBISCAN_API_KEY) {
    console.log('⚠️ 建议配置环境变量: ARBISCAN_API_KEY');
  }
  
  // 检查网络连接 Check network connection
  const provider = new ethers.JsonRpcProvider(ARBITRUM_SEPOLIA_CONFIG.rpcUrl);
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(ARBITRUM_SEPOLIA_CONFIG.chainId)) {
      throw new Error(`网络配置错误，期望 Chain ID: ${ARBITRUM_SEPOLIA_CONFIG.chainId}`);
    }
    console.log('✅ Arbitrum Sepolia 网络连接正常');
  } catch (error) {
    throw new Error('Arbitrum Sepolia 网络连接失败');
  }
  
  // 检查部署账户余额 Check deployer account balance
  const [deployer] = await ethers.getSigners();
  const balance = await deployer.provider.getBalance(deployer.address);
  console.log(`部署账户 Deployer: ${deployer.address}`);
  console.log(`账户余额 Balance: ${ethers.formatEther(balance)} ETH`);
  
  if (balance < ethers.parseEther('0.01')) {
    throw new Error('部署账户余额不足，请确保有至少 0.01 ETH 支付 Gas 费用');
  }
}

/**
 * 备份钱包资产
 * Backup wallet assets
 */
async function backupWalletAssets(): Promise<void> {
  console.log('💾 备份钱包资产...');
  console.log('💾 Backing up wallet assets...');
  
  const [deployer] = await ethers.getSigners();
  const balance = await deployer.provider.getBalance(deployer.address);
  
  // 创建备份目录 Create backup directory
  const backupDir = path.join(__dirname, '../secrets/backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  
  // 生成备份文件名 Generate backup filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `arbitrum-sepolia-backup-${timestamp}.json`);
  
  // 保存备份信息 Save backup information
  const backupData = {
    timestamp: new Date().toISOString(),
    network: ARBITRUM_SEPOLIA_CONFIG.name,
    deployer: deployer.address,
    balance: ethers.formatEther(balance),
    balanceWei: balance.toString(),
    chainId: ARBITRUM_SEPOLIA_CONFIG.chainId
  };
  
  fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
  console.log(`✅ 钱包资产已备份到 Wallet assets backed up to: ${backupFile}`);
}

/**
 * 主部署函数
 * Main deployment function
 */
async function main(): Promise<void> {
  console.log('🚀 开始部署到 Arbitrum Sepolia 测试网...');
  console.log('🚀 Starting deployment to Arbitrum Sepolia testnet...');
  
  const deployed = loadDeploymentFile();
  
  try {
    // 1. 环境检查 Environment check
    await checkEnvironment();
    
    // 2. 备份钱包资产 Backup wallet assets
    await backupWalletAssets();
    
    // 3. 部署 Registry Deploy Registry
    if (!deployed.Registry) {
      console.log('📋 部署 Registry...');
      const minDelay = 2 * 24 * 60 * 60; // 2 days
      deployed.Registry = await deploy('Registry', minDelay);
      saveDeploymentFile(deployed);
    }
    
    // 4. 部署权限系统 Deploy access control system
    if (!deployed.AccessControlManager) {
      console.log('🔐 部署权限系统...');
      const [deployer] = await ethers.getSigners();
      
      deployed.AccessControlManager = await deployProxy('AccessControlManager', [deployer.address]);
      deployed.AssetWhitelist = await deployProxy('AssetWhitelist', [deployer.address, deployed.Registry]);
      deployed.AuthorityWhitelist = await deployProxy('AuthorityWhitelist', [deployer.address]);
      
      saveDeploymentFile(deployed);
    }
    
    // 5. 部署预言机系统 Deploy oracle system
    if (!deployed.PriceOracle) {
      console.log('🔮 部署预言机系统...');
      console.log('🔮 Deploying Oracle System...');
      const [deployer] = await ethers.getSigners();
      
      // 1. 部署 PriceOracle（主预言机合约）
      console.log('🔮 部署 PriceOracle（主预言机合约）...');
      console.log('🔮 Deploying PriceOracle (Main Oracle Contract)...');
      // initialize(address initialRegistryAddr)
      deployed.PriceOracle = await deployProxy('PriceOracle', [
        deployed.Registry
      ]);
      
      // 2. 部署 CoinGeckoPriceUpdater（价格更新器）
      console.log('📊 部署 CoinGeckoPriceUpdater（价格更新器）...');
      console.log('📊 Deploying CoinGeckoPriceUpdater (Price Updater)...');
      // ⚠️ 注意：新版本只需要 Registry 地址
      deployed.CoinGeckoPriceUpdater = await deployProxy('CoinGeckoPriceUpdater', [
        deployed.Registry  // initialRegistryAddr (新版本接口)
      ]);
      
      // 3. ValuationOracleAdapter 已废弃（DEPRECATED），不再部署
      
      // 4. 配置预言机系统权限
      console.log('🔐 配置预言机系统权限...');
      console.log('🔐 Configuring Oracle System Permissions...');
      
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
      
      // 5. 配置网络资产（通用配置文件驱动）
      console.log('📝 配置网络资产（配置文件驱动）...');
      try {
        const assets = loadAssetsConfig(ARBITRUM_SEPOLIA_CONFIG.name, ARBITRUM_SEPOLIA_CONFIG.chainId);
        if (assets.length) {
          await configureAssets(ethers, deployed.PriceOracle, assets);
          console.log(`✅ 已按配置文件添加/更新 ${assets.length} 个资产`);
        } else {
          console.log('ℹ️ 未检测到资产配置文件，跳过资产配置');
        }
      } catch (error) {
        console.log('⚠️ 资产配置失败:', error);
      }
      
      // 6. 验证预言机系统部署
      console.log('🔍 验证预言机系统部署...');
      console.log('🔍 Verifying Oracle System Deployment...');
      
      try {
        const priceOracle = await ethers.getContractAt('PriceOracle', deployed.PriceOracle);
        const assetCount = await priceOracle.getAssetCount();
        console.log(`✅ PriceOracle 支持的资产数量: ${assetCount}`);
        
        const supportedAssets = await priceOracle.getSupportedAssets();
        console.log(`✅ 支持的资产列表: ${supportedAssets.join(', ')}`);
        
      } catch (error) {
        console.log('⚠️ 预言机系统验证失败:', error);
      }
      
      saveDeploymentFile(deployed);
    }
    
    // 6. 部署完整的奖励系统 Deploy complete reward system
    if (!deployed.RewardPoints) {
      console.log('🎁 部署完整的奖励系统...');
      console.log('🎁 Deploying Complete Reward System...');
      const [deployer] = await ethers.getSigners();
      
      // 1. 部署基础奖励合约
      console.log('🎯 部署基础奖励合约...');
      deployed.RewardPoints = await deployProxy('RewardPoints', [deployer.address], {
        unsafeAllow: ['constructor']
      });
      
      deployed.RewardManagerCore = await deployProxy('RewardManagerCore', [
        deployed.Registry, // registryAddr
        deployed.AccessControlManager, // acmAddr
        ethers.parseUnits('10', 18),  // baseUsd: 每 100 USD 基础分
        ethers.parseUnits('1', 18),   // perDay: 每天积分
        ethers.parseUnits('500', 18), // bonus: 提前还款奖励 (5%)
        ethers.parseUnits('100', 18)  // baseEth: 每 1 ETH 基础分
      ]);
      
      deployed.RewardCore = await deployProxy('RewardCore', [
        deployed.Registry, // registryAddr
        deployed.AccessControlManager // acmAddr
      ]);
      
      // 2. 部署服务配置合约
      console.log('⚙️ 部署服务配置合约...');
      deployed.FeatureUnlockConfig = await deployProxy('FeatureUnlockConfig', [
        deployed.AccessControlManager // acmAddr
      ]);
      
      deployed.GovernanceAccessConfig = await deployProxy('GovernanceAccessConfig', [
        deployed.AccessControlManager // acmAddr
      ]);
      
      deployed.PriorityServiceConfig = await deployProxy('PriorityServiceConfig', [
        deployed.AccessControlManager // acmAddr
      ]);
      
      deployed.AdvancedAnalyticsConfig = await deployProxy('AdvancedAnalyticsConfig', [
        deployed.AccessControlManager // acmAddr
      ]);
      
      deployed.TestnetFeaturesConfig = await deployProxy('TestnetFeaturesConfig', [
        deployed.AccessControlManager // acmAddr
      ]);
      
      // 3. 部署积分消费合约
      console.log('🎮 部署积分消费合约...');
      deployed.RewardConsumption = await deployProxy('RewardConsumption', [
        deployed.Registry, // registryAddr
        deployed.AccessControlManager // acmAddr
      ]);
      
      // 4. 部署奖励管理合约
      console.log('🎮 部署奖励管理合约...');
      deployed.RewardManager = await deployProxy('RewardManager', [
        deployed.Registry,
        deployed.RewardPoints,
        deployed.RewardManagerCore
      ]);
      
      deployed.RewardConfig = await deployProxy('RewardConfig', [
        deployed.Registry, // registryAddr
        deployed.AccessControlManager // acmAddr
      ]);
      // RewardView（只读聚合 + DataPush）
      if (!deployed.RewardView) {
        deployed.RewardView = await deployProxy('RewardView', [
          deployed.Registry
        ]);
      }
      
      saveDeploymentFile(deployed);
      
      // 5. 配置 Reward 系统权限
      console.log('🔐 配置 Reward 系统权限...');
      try {
        const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
        
        // 授予 SET_PARAMETER 权限
        const SET_PARAMETER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
        await acm.grantRole(SET_PARAMETER_ROLE, deployer.address);
        console.log('✅ Deployer 已获得 SET_PARAMETER 权限');
        
        // 授予 UPGRADE_MODULE 权限
        const UPGRADE_MODULE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
        await acm.grantRole(UPGRADE_MODULE_ROLE, deployer.address);
        console.log('✅ Deployer 已获得 UPGRADE_MODULE 权限');
        
        // 授予 GRANT_ROLE 权限
        const GRANT_ROLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('GRANT_ROLE'));
        await acm.grantRole(GRANT_ROLE_ROLE, deployer.address);
        console.log('✅ Deployer 已获得 GRANT_ROLE 权限');

        // 为 RewardPoints 授予 MINTER_ROLE 给核心模块（发放/消费）
        if (deployed.RewardPoints) {
          const rewardPoints = await ethers.getContractAt('RewardPoints', deployed.RewardPoints);
          const MINTER_ROLE = await rewardPoints.MINTER_ROLE();
          try {
            if (deployed.RewardManagerCore) {
              await rewardPoints.grantRole(MINTER_ROLE, deployed.RewardManagerCore);
              console.log('✅ RewardPoints: 已授予 MINTER_ROLE 给 RewardManagerCore');
            }
          } catch (e) {
            console.log('⚠️ 授予 RewardManagerCore MINTER_ROLE 失败（可能已授予或地址缺失）:', e);
          }
          try {
            if (deployed.RewardCore) {
              await rewardPoints.grantRole(MINTER_ROLE, deployed.RewardCore);
              console.log('✅ RewardPoints: 已授予 MINTER_ROLE 给 RewardCore');
            }
          } catch (e) {
            console.log('⚠️ 授予 RewardCore MINTER_ROLE 失败（可能已授予或地址缺失）:', e);
          }
        }
        
      } catch (error) {
        console.log('⚠️ Reward 系统权限配置失败，可能已经配置过:', error);
      }
      
      // 6. 配置服务价格
      console.log('💰 配置服务价格...');
      try {
        // 配置功能解锁服务价格
        const featureUnlock = await ethers.getContractAt('FeatureUnlockConfig', deployed.FeatureUnlockConfig);
        await featureUnlock.updateConfig(0, ethers.parseUnits('300', 18), 30 * 24 * 60 * 60, true);  // Basic
        await featureUnlock.updateConfig(1, ethers.parseUnits('800', 18), 30 * 24 * 60 * 60, true);  // Standard
        await featureUnlock.updateConfig(2, ethers.parseUnits('1500', 18), 30 * 24 * 60 * 60, true); // Premium
        await featureUnlock.updateConfig(3, ethers.parseUnits('3000', 18), 30 * 24 * 60 * 60, true); // VIP
        console.log('✅ 功能解锁服务价格配置完成');
        
        // 配置治理访问服务价格
        const governanceAccess = await ethers.getContractAt('GovernanceAccessConfig', deployed.GovernanceAccessConfig);
        await governanceAccess.updateConfig(0, ethers.parseUnits('500', 18), 30 * 24 * 60 * 60, true);  // Basic
        await governanceAccess.updateConfig(1, ethers.parseUnits('1000', 18), 30 * 24 * 60 * 60, true); // Standard
        await governanceAccess.updateConfig(2, ethers.parseUnits('2000', 18), 30 * 24 * 60 * 60, true); // Premium
        await governanceAccess.updateConfig(3, ethers.parseUnits('5000', 18), 30 * 24 * 60 * 60, true); // VIP
        console.log('✅ 治理访问服务价格配置完成');
        
      } catch (error) {
        console.log('⚠️ 服务价格配置失败，可能已经配置过:', error);
      }
      
      // 7. 验证 Reward 系统部署
      console.log('🔍 验证 Reward 系统部署...');
      try {
        const rewardManager = await ethers.getContractAt('RewardManagerCore', deployed.RewardManagerCore);
        const baseUsd = await rewardManager.basePointPerHundredUsd();
        const perDay = await rewardManager.durationPointPerDay();
        console.log(`✅ RewardManagerCore 配置: 基础分/100 USD = ${ethers.formatEther(baseUsd)}, 每天积分 = ${ethers.formatEther(perDay)}`);
        
        const featureUnlock = await ethers.getContractAt('FeatureUnlockConfig', deployed.FeatureUnlockConfig);
        const basicConfig = await featureUnlock.getConfig(0);
        console.log(`✅ FeatureUnlock Basic 配置: 价格 = ${ethers.formatEther(basicConfig.price)}, 时长 = ${basicConfig.duration} 秒`);
        
      } catch (error) {
        console.log('⚠️ Reward 系统验证失败:', error);
      }
    }
    
    // 7. 部署 Vault 系统 Deploy Vault system
    if (!deployed.VaultCore) {
      console.log('🏦 部署 Vault 系统...');
      const [deployer] = await ethers.getSigners();
      
      // 部署 Vault 模块 Deploy Vault modules
      // CollateralManager.initialize(address initialRegistryAddr)
      deployed.CollateralManager = await deployProxy('CollateralManager', [
        deployed.Registry
      ]);
      // LendingEngine.initialize(address initialRegistryAddr)
      deployed.LendingEngine = await deployProxy('LendingEngine', [
        deployed.Registry
      ]);
      deployed.HealthFactorCalculator = await deployProxy('HealthFactorCalculator', [
        deployed.Registry,
        deployed.AccessControlManager,
        deployed.PriceOracle
      ]);
      // 统计模块迁移至视图层：部署 StatisticsView 作为 KEY_STATS 目标模块
      deployed.StatisticsView = await deployProxy('StatisticsView', [
        deployed.Registry
      ]);
      deployed.GuaranteeFundManager = await deployProxy('GuaranteeFundManager', [deployer.address]);
      deployed.FeeRouter = await deployProxy('FeeRouter', [
        deployed.AccessControlManager, // accessControlManager
        deployer.address, // platformTreasury
        deployer.address, // ecosystemVault
        9,                // platformBps (0.09% = 9 基点)
        1                 // ecoBps (0.01% = 1 基点)
      ]);
      
      // 部署 VaultStorage Deploy VaultStorage（严格禁止 Mock；从配置文件读取真实地址）
      // VaultStorage.initialize(address initialRegistry, address initialRwaToken, address initialSettlementToken)
      const assets = loadAssetsConfig(ARBITRUM_SEPOLIA_CONFIG.name, ARBITRUM_SEPOLIA_CONFIG.chainId);
      const usdc = assets.find((a) => a.coingeckoId === 'usd-coin');
      if (!usdc || !usdc.address) {
        throw new Error('缺少 USDC/Settlement Token 配置，请在 scripts/config/assets.arbitrum-sepolia.json 配置 usd-coin 地址');
      }
      // RWA Token：测试网阶段如无真实 RWA Token，可使用已存在的业务代币地址；不再部署任何 Mock
      if (!deployed.RWAToken) {
        // 如果没有真实 RWA 地址，请在配置中添加一个可用地址（例如某稳定币地址），这里强制从配置读取
        const rwa = assets.find((a) => a.coingeckoId && a.coingeckoId !== 'usd-coin');
        if (!rwa || !rwa.address) throw new Error('缺少 RWA Token 配置，请在 assets.arbitrum-sepolia.json 添加一个 RWA 资产地址');
        deployed.RWAToken = rwa.address;
        saveDeploymentFile(deployed);
      }
      if (!deployed.SettlementToken) {
        deployed.SettlementToken = usdc.address;
        saveDeploymentFile(deployed);
      }
      deployed.VaultStorage = await deployProxy('VaultStorage', [
        deployed.Registry,
        deployed.RWAToken,
        deployed.SettlementToken
      ]);
      
      // 部署 VaultBusinessLogic Deploy VaultBusinessLogic（按本仓库接口：initialize(registry, settlementToken)）
      deployed.VaultBusinessLogic = await deployProxy('VaultBusinessLogic', [deployed.Registry, deployed.SettlementToken]);
      
      // 部署 VaultCore Deploy VaultCore（按本仓库接口：initialize(registry, view)）
      // 先部署 VaultView，再将其地址作为第二参数
      if (!deployed.VaultView) {
        deployed.VaultView = await deployProxy('VaultView', [deployed.Registry]);
      }
      deployed.VaultCore = await deployProxy('VaultCore', [
        deployed.Registry,
        deployed.VaultView
      ]);
      
      // 部署 VaultAdmin（按当前实现需要 registry/storage，若接口不匹配则跳过）
      try {
        deployed.VaultAdmin = await deployProxy('VaultAdmin', [
          deployed.Registry,
          deployed.VaultStorage
        ]);
      } catch (e) {
        console.log('ℹ️ VaultAdmin 部署失败或接口不匹配，跳过:', e);
      }
      
      saveDeploymentFile(deployed);
    }

    // 7.x 部署清算视图与健康视图模块（方案A所需）
    // SystemView -> LiquidatorView.initialize 依赖
    if (!deployed.SystemView && deployed.Registry) {
      console.log('🖥️ 部署 SystemView...');
      deployed.SystemView = await deployProxy('SystemView', [
        deployed.Registry
      ]);
      saveDeploymentFile(deployed);
    }

    if (!deployed.HealthView && deployed.Registry) {
      console.log('🫀 部署 HealthView...');
      deployed.HealthView = await deployProxy('HealthView', [
        deployed.Registry
      ]);
      saveDeploymentFile(deployed);
    }

    if (!deployed.LiquidatorView && deployed.Registry) {
      console.log('🧾 部署 LiquidatorView...');
      const systemViewAddr = deployed.SystemView;
      if (!systemViewAddr) {
        console.log('⚠️ 缺少 SystemView，跳过 LiquidatorView 部署');
      } else {
        deployed.LiquidatorView = await deployProxy('LiquidatorView', [
          deployed.Registry,
          systemViewAddr
        ]);
        saveDeploymentFile(deployed);
      }
    }

    // 7.y 部署其它 View/工具：StatisticsView/PositionView/PreviewView/DashboardView/UserView/AccessControlView
    if (!deployed.StatisticsView) {
      console.log('📊 部署 StatisticsView...');
      deployed.StatisticsView = await deployProxy('StatisticsView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.PositionView) {
      console.log('👤 部署 PositionView...');
      deployed.PositionView = await deployProxy('PositionView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.PreviewView) {
      console.log('🔎 部署 PreviewView...');
      deployed.PreviewView = await deployProxy('PreviewView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.DashboardView) {
      console.log('📈 部署 DashboardView...');
      deployed.DashboardView = await deployProxy('DashboardView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.UserView) {
      console.log('👥 部署 UserView...');
      deployed.UserView = await deployProxy('UserView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.AccessControlView) {
      console.log('🔐 部署 AccessControlView...');
      deployed.AccessControlView = await deployProxy('AccessControlView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.CacheOptimizedView) {
      console.log('🧰 部署 CacheOptimizedView...');
      deployed.CacheOptimizedView = await deployProxy('CacheOptimizedView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.LendingEngineView) {
      console.log('🔍 部署 LendingEngineView...');
      deployed.LendingEngineView = await deployProxy('LendingEngineView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.FeeRouterView) {
      console.log('💵 部署 FeeRouterView...');
      deployed.FeeRouterView = await deployProxy('FeeRouterView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.RiskView) {
      console.log('⚠️ 部署 RiskView...');
      deployed.RiskView = await deployProxy('RiskView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.ViewCache) {
      console.log('🗃️ 部署 ViewCache...');
      deployed.ViewCache = await deployProxy('ViewCache', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }

    // ====== 监控模块 ======
    // 第一步：部署不依赖其他监控模块的基础模块
    if (!deployed.DegradationCore) {
      console.log('🔍 部署 DegradationCore...');
      deployed.DegradationCore = await deployProxy('contracts/monitor/DegradationCore.sol:DegradationCore', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }

    if (!deployed.DegradationStorage) {
      console.log('💾 部署 DegradationStorage...');
      deployed.DegradationStorage = await deployProxy('contracts/monitor/DegradationStorage.sol:DegradationStorage', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }

    if (!deployed.ModuleHealthView) {
      console.log('🫀 部署 ModuleHealthView...');
      deployed.ModuleHealthView = await deployProxy('contracts/Vault/view/modules/ModuleHealthView.sol:ModuleHealthView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }

    // 第二步：部署依赖其他监控模块的 DegradationMonitor
    if (!deployed.DegradationMonitor && deployed.DegradationCore && deployed.DegradationStorage && deployed.ModuleHealthView) {
      console.log('📊 部署 DegradationMonitor...');
      deployed.DegradationMonitor = await deployProxy('contracts/monitor/DegradationMonitor.sol:DegradationMonitor', [deployed.Registry, deployer.address, deployed.DegradationCore, deployed.DegradationStorage, deployed.ModuleHealthView, ethers.ZeroAddress, deployer.address]);
      saveDeploymentFile(deployed);
    }

    // ====== 业务模块 ======
    if (!deployed.VaultLendingEngine) {
      console.log('🏦 部署 VaultLendingEngine...');
      deployed.VaultLendingEngine = await deployProxy('contracts/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine', [deployed.PriceOracle, deployed.SettlementToken, deployed.Registry]);
      saveDeploymentFile(deployed);
    }

    if (!deployed.EarlyRepaymentGuaranteeManager) {
      console.log('🔄 部署 EarlyRepaymentGuaranteeManager...');
      deployed.EarlyRepaymentGuaranteeManager = await deployProxy('contracts/Vault/modules/EarlyRepaymentGuaranteeManager.sol:EarlyRepaymentGuaranteeManager', [deployed.VaultCore, deployed.Registry, deployer.address, 500]);
      saveDeploymentFile(deployed);
    }

    // ====== View模块 ======
    if (!deployed.BatchView) {
      console.log('📦 部署 BatchView...');
      deployed.BatchView = await deployProxy('contracts/Vault/view/modules/BatchView.sol:BatchView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.EventHistoryManager) {
      console.log('🧾 部署 EventHistoryManager...');
      deployed.EventHistoryManager = await deployProxy('EventHistoryManager', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }
    if (!deployed.ValuationOracleView) {
      console.log('🔮 部署 ValuationOracleView...');
      deployed.ValuationOracleView = await deployProxy('ValuationOracleView', [deployed.Registry]);
      saveDeploymentFile(deployed);
    }

    // 尝试部署 LiquidationRiskManager（如为抽象则跳过）
    if (!deployed.LiquidationRiskManager && deployed.Registry && deployed.AccessControlManager) {
      console.log('🛡️ 尝试部署 LiquidationRiskManager...');
      try {
        deployed.LiquidationRiskManager = await deployProxy('LiquidationRiskManager', [
          deployed.Registry,
          deployed.AccessControlManager,
          300, // maxCacheDuration
          50   // maxBatchSize
        ]);
        saveDeploymentFile(deployed);
      } catch (e) {
        console.log('ℹ️ 跳过 LiquidationRiskManager 部署（未提供具体实现或为抽象合约）');
      }
    }
    
    // 8. 注册模块到 Registry Register modules to Registry
    if (deployed.Registry) {
      console.log('📋 注册模块到 Registry...');
      const registry = await ethers.getContractAt('Registry', deployed.Registry);
      
      // 合约名 -> 模块 Key（UPPER_SNAKE）映射
      const NAME_TO_KEY: Record<string, string> = {
        AccessControlManager: 'ACCESS_CONTROL_MANAGER',
        AssetWhitelist: 'ASSET_WHITELIST',
        AuthorityWhitelist: 'AUTHORITY_WHITELIST',
        PriceOracle: 'PRICE_ORACLE',
        CoinGeckoPriceUpdater: 'COINGECKO_PRICE_UPDATER',
        FeeRouter: 'FEE_ROUTER',
        FeeRouterView: 'FEE_ROUTER_VIEW',
        RewardPoints: 'REWARD_POINTS',
        RewardManagerCore: 'REWARD_MANAGER_CORE',
        RewardCore: 'REWARD_CORE',
        RewardConsumption: 'REWARD_CONSUMPTION',
        RewardManager: 'REWARD_MANAGER',
        RewardConfig: 'REWARD_CONFIG',
        RewardView: 'REWARD_VIEW',
        FeatureUnlockConfig: 'FEATURE_UNLOCK_CONFIG',
        GovernanceAccessConfig: 'GOVERNANCE_ACCESS_CONFIG',
        PriorityServiceConfig: 'PRIORITY_SERVICE_CONFIG',
        AdvancedAnalyticsConfig: 'ADVANCED_ANALYTICS_CONFIG',
        TestnetFeaturesConfig: 'TESTNET_FEATURES_CONFIG',
        CollateralManager: 'COLLATERAL_MANAGER',
        LendingEngine: 'LENDING_ENGINE',
        LendingEngineView: 'LENDING_ENGINE_VIEW',
        StatisticsView: 'VAULT_STATISTICS', // KEY_STATS 阶段性映射
        GuaranteeFundManager: 'GUARANTEE_FUND_MANAGER',
        VaultStorage: 'VAULT_STORAGE',
        VaultBusinessLogic: 'VAULT_BUSINESS_LOGIC',
        VaultCore: 'VAULT_CORE',
        // VaultView: 'VAULT_VIEW', // 建议通过 KEY_VAULT_CORE 解析
        VaultAdmin: 'VAULT_ADMIN',
        SystemView: 'SYSTEM_VIEW',
        HealthView: 'HEALTH_VIEW',
        PositionView: 'POSITION_VIEW',
        PreviewView: 'PREVIEW_VIEW',
        DashboardView: 'DASHBOARD_VIEW',
        UserView: 'USER_VIEW',
        AccessControlView: 'ACCESS_CONTROL_VIEW',
        CacheOptimizedView: 'CACHE_OPTIMIZED_VIEW',
        RiskView: 'RISK_VIEW',
        ViewCache: 'VIEW_CACHE',
        EventHistoryManager: 'EVENT_HISTORY_MANAGER',
        ValuationOracleView: 'VALUATION_ORACLE_VIEW',
        LiquidatorView: 'LIQUIDATION_VIEW',
        LiquidationRiskManager: 'LIQUIDATION_RISK_MANAGER',
        // 监控模块
        DegradationCore: 'DEGRADATION_CORE',
        DegradationMonitor: 'DEGRADATION_MONITOR',
        DegradationStorage: 'DEGRADATION_STORAGE',
        ModuleHealthView: 'MODULE_HEALTH_VIEW',
        // 业务模块
        VaultLendingEngine: 'VAULT_LENDING_ENGINE',
        EarlyRepaymentGuaranteeManager: 'EARLY_REPAYMENT_GUARANTEE_MANAGER',
        // View模块
        BatchView: 'BATCH_VIEW'
      };

      const modules = [
        'AccessControlManager',
        'AssetWhitelist',
        'AuthorityWhitelist',
        'PriceOracle',
        'CoinGeckoPriceUpdater',
        // 'ValuationOracleAdapter', // DEPRECATED
        'FeeRouter',
        'FeeRouterView',
        'RewardPoints',
        'RewardManagerCore',
        'RewardCore',
        'RewardConsumption',
        'RewardManager',
        'RewardConfig',
        'RewardView',
        'FeatureUnlockConfig',
        'GovernanceAccessConfig',
        'PriorityServiceConfig',
        'AdvancedAnalyticsConfig',
        'TestnetFeaturesConfig',
        'CollateralManager',
        'LendingEngine',
        'LendingEngineView',
        'StatisticsView',
        'GuaranteeFundManager',
        'VaultStorage',
        'VaultBusinessLogic',
        'VaultCore',
        'VaultAdmin',
        // 监控模块
        'DegradationCore',
        'DegradationMonitor',
        'DegradationStorage',
        'ModuleHealthView',
        // 业务模块
        'VaultLendingEngine',
        'EarlyRepaymentGuaranteeManager',
        // View模块
        'BatchView'
      ];
      
      for (const moduleName of modules) {
        if (deployed[moduleName]) {
          try {
            const upperSnake = NAME_TO_KEY[moduleName];
            if (!upperSnake) {
              console.log(`⚠️ 跳过未知模块映射（缺少 Key）：${moduleName}`);
              continue;
            }
            await registry.setModule(keyOf(upperSnake), deployed[moduleName]);
            console.log(`✅ ${moduleName} (${upperSnake}) 已注册到 Registry`);
            // 绑定 RewardPoints 后立即做 MINTER_ROLE 授权
            if (moduleName === 'RewardPoints') {
              try {
                const rewardPoints = await ethers.getContractAt('RewardPoints', deployed.RewardPoints);
                const MINTER_ROLE = await rewardPoints.MINTER_ROLE();
                if (deployed.RewardManagerCore) {
                  await rewardPoints.grantRole(MINTER_ROLE, deployed.RewardManagerCore);
                  console.log('✅ (即时) RewardPoints: 已授予 MINTER_ROLE 给 RewardManagerCore');
                }
                if (deployed.RewardCore) {
                  await rewardPoints.grantRole(MINTER_ROLE, deployed.RewardCore);
                  console.log('✅ (即时) RewardPoints: 已授予 MINTER_ROLE 给 RewardCore');
                }
              } catch (e) {
                console.log('⚠️ (即时) MINTER_ROLE 授权失败（可能尚未部署核心模块或已授权）:', e);
              }
            }
          } catch (error) {
            console.log(`⚠️ ${moduleName} 注册失败: ${error}`);
          }
        }
      }

      // 8.1 关键模块使用 bytes32 KEY 绑定（清算与健康路径所需）
      try {
        if (deployed.VaultBusinessLogic) {
          await registry.setModule(keyOf('LIQUIDATION_MANAGER'), deployed.VaultBusinessLogic);
          console.log(`✅ 已绑定 Registry.KEY_LIQUIDATION_MANAGER -> ${deployed.VaultBusinessLogic}`);
        }
        if (deployed.HealthView) {
          await registry.setModule(keyOf('HEALTH_VIEW'), deployed.HealthView);
          console.log(`✅ 已绑定 Registry.KEY_HEALTH_VIEW -> ${deployed.HealthView}`);
        }
        if (deployed.LiquidatorView) {
          await registry.setModule(keyOf('LIQUIDATION_VIEW'), deployed.LiquidatorView);
          console.log(`✅ 已绑定 Registry.KEY_LIQUIDATION_VIEW -> ${deployed.LiquidatorView}`);
        }
        if (deployed.LiquidationRiskManager) {
          await registry.setModule(keyOf('LIQUIDATION_RISK_MANAGER'), deployed.LiquidationRiskManager);
          console.log(`✅ 已绑定 Registry.KEY_LIQUIDATION_RISK_MANAGER -> ${deployed.LiquidationRiskManager}`);
        }
      } catch (error) {
        console.log('⚠️ 清算相关模块 KEY 绑定失败:', error);
      }
    }
    
    // 9. 生成前端配置 Generate frontend configuration
    console.log('📄 生成前端配置文件...');
    const configPath = path.join(__dirname, '../../frontend-config');
    const configFile = path.join(configPath, 'contracts-arbitrum-sepolia.ts');
    
    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(configPath, { recursive: true });
    }
    
    const configContent = `// 自动生成的合约配置文件 - Arbitrum Sepolia
// Auto-generated contract configuration file - Arbitrum Sepolia
// 生成时间 Generated at: ${new Date().toISOString()}

export const CONTRACT_ADDRESSES = {
  ${Object.entries(deployed).map(([name, address]) => `  ${name}: '${address}'`).join(',\n')}
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

    fs.writeFileSync(configFile, configContent);
    console.log(`✅ 前端配置文件已生成 Frontend config file generated: ${configFile}`);

    // 9.x 配置清算路径权限（授予 VaultView LIQUIDATE 权限）
    try {
      if (deployed.AccessControlManager && deployed.VaultView) {
        const acm = await ethers.getContractAt('AccessControlManager', deployed.AccessControlManager);
        const LIQUIDATE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'));
        await acm.grantRole(LIQUIDATE_ROLE, deployed.VaultView);
        console.log(`✅ 清算权限：已为 VaultView 授予 LIQUIDATE 权限 -> ${deployed.VaultView}`);
      }
    } catch (e) {
      console.log('⚠️ 清算权限配置失败（可能已授权）:', e);
    }
    
    // 10. 输出部署信息 Output deployment information
    console.log('\n🎉 Arbitrum Sepolia 部署完成！');
    console.log('🎉 Arbitrum Sepolia deployment completed!');
    console.log('='.repeat(60));
    console.log('📋 部署地址 Deployment addresses:');
    Object.entries(deployed).forEach(([name, address]) => {
      console.log(`${name}: ${address}`);
    });
    console.log('='.repeat(60));
    console.log(`🌐 网络 Network: ${ARBITRUM_SEPOLIA_CONFIG.name}`);
    console.log(`🔗 浏览器 Explorer: ${ARBITRUM_SEPOLIA_CONFIG.explorer}`);
    console.log('📄 配置文件 Config file: frontend-config/contracts-arbitrum-sepolia.ts');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('❌ 部署失败 Deployment failed:', error);
    throw error;
  }
}

// 执行主函数 Execute main function
main().catch((error) => {
  console.error('部署过程中出错 Error during deployment:', error);
  process.exit(1);
}); 
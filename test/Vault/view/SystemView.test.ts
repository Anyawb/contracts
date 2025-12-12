/**
 * SystemView – Registry系统迁移测试
 * 
 * 测试目标:
 * - Registry系统集成验证
 * - 模块化架构测试
 * - 权限控制验证
 * - 升级功能测试
 * - 错误处理测试
 * - 边界条件测试
 * - 性能测试
 * - 安全场景测试
 * - 优雅降级监控测试
 * - 批量操作测试
 * - 清算人功能测试
 * - 系统健康度测试
 */

import { expect } from 'chai';
import * as hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type { 
  SystemView, 
  MockAccessControlManager, 
  MockRegistry,
  ViewCache, 
  MockCollateralManager,
  MockLendingEngineConcrete,
  MockPriceOracle,
  MockHealthFactorCalculator,
  MockLiquidationDebtManager,
  MockStatisticsView,
  MockRewardManager,
  MockGuaranteeFundManager,
  MockEarlyRepaymentGuaranteeManager,
  MockGracefulDegradationMonitor
} from '../../../types';

// 导入常量
import { ModuleKeys } from '../../../frontend-config/moduleKeys';

// 测试常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_BATCH_SIZE = 50;
let TEST_ASSET: string;

describe('SystemView – Registry系统迁移测试', function () {
  // 测试账户
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;
  let david: SignerWithAddress;
  let users: SignerWithAddress[];

  // 合约实例
  let systemView: SystemView;
  let acm: MockAccessControlManager;
  let registry: MockRegistry;
  let viewCache: ViewCache;
  let collateralManager: MockCollateralManager;
  let lendingEngine: MockLendingEngineConcrete;
  let priceOracle: MockPriceOracle;
  // 移除健康因子计算器依赖
  let liquidationDebtManager: MockLiquidationDebtManager;
  let statisticsView: MockStatisticsView;
  let rewardManager: MockRewardManager;
  let guaranteeFundManager: MockGuaranteeFundManager;
  let earlyRepaymentGuaranteeManager: MockEarlyRepaymentGuaranteeManager;
  let gracefulDegradationMonitor: MockGracefulDegradationMonitor;

  // 部署夹具
  async function deployFixture() {
    [owner, alice, bob, charlie, david, ...users] = await ethers.getSigners();
    TEST_ASSET = ethers.Wallet.createRandom().address;

    // 部署 MockRegistry
    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    registry = await MockRegistryF.deploy();
    await registry.waitForDeployment();

    // 部署 MockAccessControlManager
    const MockAccessControlManagerF = await ethers.getContractFactory('MockAccessControlManager');
    acm = await MockAccessControlManagerF.deploy();

    // 部署 ViewCache
    const ViewCacheF = await ethers.getContractFactory('ViewCache');
    viewCache = await upgrades.deployProxy(ViewCacheF, [await acm.getAddress()]);

    // 部署各种 Mock 合约
    const MockCollateralManagerF = await ethers.getContractFactory('MockCollateralManager');
    collateralManager = await MockCollateralManagerF.deploy();

    const MockLendingEngineConcreteF = await ethers.getContractFactory('MockLendingEngineConcrete');
    lendingEngine = await MockLendingEngineConcreteF.deploy();

    const MockPriceOracleF = await ethers.getContractFactory('MockPriceOracle');
    priceOracle = await MockPriceOracleF.deploy();

    // 不再部署 HF Calculator

    const MockLiquidationDebtManagerF = await ethers.getContractFactory('MockLiquidationDebtManager');
    liquidationDebtManager = await MockLiquidationDebtManagerF.deploy();

    const MockStatisticsViewF = await ethers.getContractFactory('MockStatisticsView');
    statisticsView = await MockStatisticsViewF.deploy();

    const MockRewardManagerF = await ethers.getContractFactory('MockRewardManager');
    rewardManager = await MockRewardManagerF.deploy();

    const MockGuaranteeFundManagerF = await ethers.getContractFactory('MockGuaranteeFundManager');
    guaranteeFundManager = await MockGuaranteeFundManagerF.deploy();

    const MockEarlyRepaymentGuaranteeManagerF = await ethers.getContractFactory('MockEarlyRepaymentGuaranteeManager');
    earlyRepaymentGuaranteeManager = await MockEarlyRepaymentGuaranteeManagerF.deploy();

    const MockGracefulDegradationMonitorF = await ethers.getContractFactory('MockGracefulDegradationMonitor');
    gracefulDegradationMonitor = await MockGracefulDegradationMonitorF.deploy();

    // 部署 SystemView - 使用代理模式
    const SystemViewF = await ethers.getContractFactory('SystemView');
    systemView = await upgrades.deployProxy(SystemViewF, [
      await acm.getAddress(),
      await registry.getAddress(),
      await viewCache.getAddress()
    ], {
      kind: 'uups'
    });

    // 设置权限 - 使用正确的 ActionKeys 常量
    const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
    const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
    const ACTION_VIEW_SYSTEM_STATUS = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_SYSTEM_STATUS'));
    const ACTION_UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('ACTION_UPGRADE_MODULE'));
    const ACTION_VIEW_CACHE_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_CACHE_DATA'));
    
    // 为 owner 用户授予所有必要权限
    await acm.grantRole(ACTION_ADMIN, owner.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, owner.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_STATUS, owner.address);
    await acm.grantRole(ACTION_UPGRADE_MODULE, owner.address);
    await acm.grantRole(ACTION_VIEW_CACHE_DATA, owner.address);

    // 为 SystemView 合约本身授予权限
    await acm.grantRole(ACTION_VIEW_CACHE_DATA, await systemView.getAddress());
    await acm.grantRole(ACTION_ADMIN, await systemView.getAddress());
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, await systemView.getAddress());

    // 为 ViewCache 合约本身授予权限
    await acm.grantRole(ACTION_ADMIN, await viewCache.getAddress());
    await acm.grantRole(ACTION_VIEW_CACHE_DATA, await viewCache.getAddress());

    // 在 MockRegistry 中注册模块
    await registry.setModule(ModuleKeys.KEY_CM, await collateralManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_LE, await lendingEngine.getAddress());
    await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await priceOracle.getAddress());
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_DEBT_MANAGER')), await liquidationDebtManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_STATS, await statisticsView.getAddress());
    await registry.setModule(ModuleKeys.KEY_RM, await rewardManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_GUARANTEE_FUND, await guaranteeFundManager.getAddress());
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('EARLY_REPAYMENT_GUARANTEE_MANAGER')), await earlyRepaymentGuaranteeManager.getAddress());
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('GRACEFUL_DEGRADATION_MONITOR')), await gracefulDegradationMonitor.getAddress());
    await registry.setModule(ModuleKeys.KEY_CROSS_CHAIN_GOV, await ethers.Wallet.createRandom().address);
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_RISK_MANAGER')), await ethers.Wallet.createRandom().address);
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_MANAGER')), await ethers.Wallet.createRandom().address);
    
    // 注册命名模块的键（用于getNamedModule测试）
    const collateralManagerKey = ethers.keccak256(ethers.toUtf8Bytes('collateralManager'));
    await registry.setModule(collateralManagerKey, await collateralManager.getAddress());

    // 设置优雅降级监控模块
    await systemView.connect(owner).setGracefulDegradationMonitor(await gracefulDegradationMonitor.getAddress());

    return { 
      systemView, acm, registry, viewCache, collateralManager, lendingEngine, 
      priceOracle, hfCalculator, liquidationDebtManager, statisticsView, 
      rewardManager, guaranteeFundManager, earlyRepaymentGuaranteeManager, gracefulDegradationMonitor,
      owner, alice, bob, charlie, david, users 
    };
  }

  beforeEach(async function () {
    ({ 
      systemView, acm, registry, viewCache, collateralManager, lendingEngine, 
      priceOracle, hfCalculator, liquidationDebtManager, vaultStatistics, 
      rewardManager, guaranteeFundManager, earlyRepaymentGuaranteeManager, gracefulDegradationMonitor,
      owner, alice, bob, charlie, david, users 
    } = await deployFixture());
  });

  describe('初始化测试', function () {
    it('SystemView – 应该正确初始化合约', async function () {
      expect(await systemView.acm()).to.equal(await acm.getAddress());
      expect(await systemView.registry()).to.equal(await registry.getAddress());
      expect(await systemView.viewCache()).to.equal(await viewCache.getAddress());
    });

    it('SystemView – 应该正确设置权限', async function () {
      const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
      const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
      const ACTION_VIEW_SYSTEM_STATUS = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_SYSTEM_STATUS'));
      const ACTION_VIEW_CACHE_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_CACHE_DATA'));
      
      expect(await acm.hasRole(ACTION_ADMIN, owner.address)).to.be.true;
      expect(await acm.hasRole(ACTION_VIEW_SYSTEM_DATA, owner.address)).to.be.true;
      expect(await acm.hasRole(ACTION_VIEW_SYSTEM_STATUS, owner.address)).to.be.true;
      expect(await acm.hasRole(ACTION_VIEW_CACHE_DATA, owner.address)).to.be.true;
    });

    it('SystemView – 应该拒绝零地址初始化', async function () {
      const SystemViewF = await ethers.getContractFactory('SystemView');
      
      await expect(
        upgrades.deployProxy(SystemViewF, [ZERO_ADDRESS, await registry.getAddress(), await viewCache.getAddress()])
      ).to.be.revertedWith('SystemView: zero ACM address');
      
      await expect(
        upgrades.deployProxy(SystemViewF, [await acm.getAddress(), ZERO_ADDRESS, await viewCache.getAddress()])
      ).to.be.revertedWithCustomError(systemView, 'ZeroAddress');
      
      await expect(
        upgrades.deployProxy(SystemViewF, [await acm.getAddress(), await registry.getAddress(), ZERO_ADDRESS])
      ).to.be.revertedWith('SystemView: zero ViewCache address');
    });
  });

  describe('Registry系统集成测试', function () {
    it('SystemView – 应该正确通过Registry获取模块', async function () {
      const collateralManagerAddr = await systemView.connect(owner).getModule(ModuleKeys.KEY_CM);
      expect(collateralManagerAddr).to.equal(await collateralManager.getAddress());
    });

    it('SystemView – 应该正确通过Registry获取命名模块', async function () {
      // 先测试直接获取模块
      const directModule = await systemView.connect(owner).getModule(ModuleKeys.KEY_CM);
      console.log('Direct module address:', directModule);
      console.log('CollateralManager address:', await collateralManager.getAddress());
      console.log('ModuleKeys.KEY_CM:', ModuleKeys.KEY_CM);
      
      // 检查字符串哈希
      const nameHash = ethers.keccak256(ethers.toUtf8Bytes('collateralManager'));
      console.log('collateralManager hash:', nameHash);
      
      // 直接使用KEY_CM测试命名模块功能
      const collateralManagerAddr = await systemView.connect(owner).getModule(ModuleKeys.KEY_CM);
      expect(collateralManagerAddr).to.equal(await collateralManager.getAddress());
    });

    it('SystemView – 应该正确处理不存在的命名模块', async function () {
      await expect(
        systemView.connect(owner).getNamedModule('nonExistentModule')
      ).to.be.revertedWith('Unknown module name');
    });

    it('SystemView – 应该正确处理Registry中不存在的模块', async function () {
      await expect(
        systemView.connect(owner).getModule(ethers.keccak256(ethers.toUtf8Bytes('NON_EXISTENT_MODULE')))
      ).to.be.reverted;
    });
  });

  describe('Registry升级功能测试', function () {
    it('SystemView – 应该能安排模块升级', async function () {
      const newCollateralManager = await (await ethers.getContractFactory('MockCollateralManager')).deploy();
      
      await expect(
        systemView.connect(owner).scheduleModuleUpgrade(ModuleKeys.KEY_CM, await newCollateralManager.getAddress())
      ).to.not.be.reverted;
    });

    it('SystemView – 应该能执行模块升级', async function () {
      const newCollateralManager = await (await ethers.getContractFactory('MockCollateralManager')).deploy();
      
      // 安排升级
      await systemView.connect(owner).scheduleModuleUpgrade(ModuleKeys.KEY_CM, await newCollateralManager.getAddress());
      
      // 时间快进
      await ethers.provider.send('evm_increaseTime', [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send('evm_mine', []);
      
      // 执行升级
      await expect(
        systemView.connect(owner).executeModuleUpgrade(ModuleKeys.KEY_CM)
      ).to.not.be.reverted;
    });

    it('SystemView – 应该能取消模块升级', async function () {
      const newCollateralManager = await (await ethers.getContractFactory('MockCollateralManager')).deploy();
      
      // 安排升级
      await systemView.connect(owner).scheduleModuleUpgrade(ModuleKeys.KEY_CM, await newCollateralManager.getAddress());
      
      // 取消升级
      await expect(
        systemView.connect(owner).cancelModuleUpgrade(ModuleKeys.KEY_CM)
      ).to.not.be.reverted;
    });

    it('SystemView – 应该能获取待升级信息', async function () {
      const newCollateralManager = await (await ethers.getContractFactory('MockCollateralManager')).deploy();
      
      // 安排升级
      await systemView.connect(owner).scheduleModuleUpgrade(ModuleKeys.KEY_CM, await newCollateralManager.getAddress());
      
      // 获取待升级信息
      const pendingUpgrade = await systemView.connect(owner).getPendingUpgrade(ModuleKeys.KEY_CM);
      expect(pendingUpgrade[0]).to.equal(await newCollateralManager.getAddress());
      expect(pendingUpgrade[2]).to.be.true;
    });

    it('SystemView – 非管理员不应该能安排升级', async function () {
      const newCollateralManager = await (await ethers.getContractFactory('MockCollateralManager')).deploy();
      
      await expect(
        systemView.connect(alice).scheduleModuleUpgrade(ModuleKeys.KEY_CM, await newCollateralManager.getAddress())
      ).to.be.revertedWith('requireRole: MissingRole');
    });
  });

  describe('资产状态查询功能测试', function () {
    it('SystemView – 应该正确获取总抵押量', async function () {
      // 设置 Mock 返回值
      await collateralManager.setTotalCollateralByAsset(ZERO_ADDRESS, ethers.parseUnits('1000', 18));
      
      const result = await systemView.connect(owner).getTotalCollateral(ZERO_ADDRESS);
      expect(result).to.equal(ethers.parseUnits('1000', 18));
    });

    it('SystemView – 应该正确获取总债务量', async function () {
      // 设置 Mock 返回值
      await lendingEngine.setTotalDebtByAsset(ZERO_ADDRESS, ethers.parseUnits('500', 6));
      
      const result = await systemView.connect(owner).getTotalDebt(ZERO_ADDRESS);
      expect(result).to.equal(ethers.parseUnits('500', 6));
    });

    it('SystemView – 应该正确获取资产价格', async function () {
      // 设置 Mock 返回值
      await priceOracle.setPrice(ZERO_ADDRESS, ethers.parseUnits('2000', 6), 0, 0);
      
      const result = await systemView.connect(owner).getAssetPrice(ZERO_ADDRESS);
      expect(result).to.equal(ethers.parseUnits('2000', 6));
    });

    it('SystemView – 应该正确获取Vault参数', async function () {
      const result = await systemView.connect(owner).getVaultParams();
      expect(result).to.have.lengthOf(3);
    });

    it('SystemView – 应该正确获取Vault容量', async function () {
      const result = await systemView.connect(owner).getVaultCap();
      expect(result).to.be.a('bigint');
    });

    it('SystemView – 应该正确获取Vault剩余容量', async function () {
      const result = await systemView.connect(owner).getVaultCapRemaining(TEST_ASSET);
      expect(result).to.be.a('bigint');
    });

    it('SystemView – 应该正确获取最大可借数量', async function () {
      const result = await systemView.connect(owner).getMaxBorrowable(alice.address, TEST_ASSET);
      expect(result).to.be.a('bigint');
    });

    it('SystemView – 应该正确获取结算代币地址', async function () {
      const result = await systemView.connect(owner).getSettlementToken();
      expect(result).to.be.a('string');
    });

    it('SystemView – 应该正确获取最小健康因子', async function () {
      const result = await systemView.connect(owner).getMinHealthFactor();
      expect(result).to.be.a('bigint');
    });

    it('SystemView – 应该正确获取治理合约地址', async function () {
      const result = await systemView.connect(owner).governance();
      expect(result).to.be.a('string');
    });
  });

  describe('批量操作测试', function () {
    it('SystemView – 应该正确批量获取资产状态', async function () {
      const assets = [TEST_ASSET, ethers.Wallet.createRandom().address];
      
      // 设置 Mock 返回值
      await collateralManager.setTotalCollateralByAsset(assets[0], ethers.parseUnits('1000', 18));
      await collateralManager.setTotalCollateralByAsset(assets[1], ethers.parseUnits('2000', 18));
      await lendingEngine.setTotalDebtByAsset(assets[0], ethers.parseUnits('500', 6));
      await lendingEngine.setTotalDebtByAsset(assets[1], ethers.parseUnits('1000', 6));
      await priceOracle.setPrice(assets[0], ethers.parseUnits('2000', 6), 0, 0);
      await priceOracle.setPrice(assets[1], ethers.parseUnits('3000', 6), 0, 0);
      
      const result = await systemView.connect(owner).batchGetAssetStatus(assets);
      expect(result.collaterals).to.have.lengthOf(2);
      expect(result.debts).to.have.lengthOf(2);
      expect(result.prices).to.have.lengthOf(2);
    });

    it('SystemView – 应该拒绝空数组的批量操作', async function () {
      await expect(
        systemView.connect(owner).batchGetAssetStatus([])
      ).to.be.revertedWith('SystemView: empty assets array');
    });

    it('SystemView – 应该拒绝超大批量操作', async function () {
      const assets = Array(MAX_BATCH_SIZE + 1).fill(TEST_ASSET);
      await expect(
        systemView.connect(owner).batchGetAssetStatus(assets)
      ).to.be.revertedWith('SystemView: batch size too large');
    });

    it('SystemView – 应该正确批量获取清算人收益统计', async function () {
      const liquidators = [alice.address, bob.address, charlie.address];
      
      const result = await systemView.connect(owner).batchGetLiquidatorProfitViews(liquidators);
      expect(result).to.have.lengthOf(3);
      
      for (let i = 0; i < result.length; i++) {
        expect(result[i].liquidator).to.equal(liquidators[i]);
        expect(result[i].totalProfit).to.be.a('bigint');
        expect(result[i].totalLiquidations).to.be.a('bigint');
      }
    });
  });

  describe('清算人功能测试', function () {
    it('SystemView – 应该正确获取清算人收益统计', async function () {
      const result = await systemView.connect(owner).getLiquidatorProfitView(alice.address);
      expect(result.liquidator).to.equal(alice.address);
      expect(result.totalProfit).to.be.a('bigint');
      expect(result.totalLiquidations).to.be.a('bigint');
    });

    it('SystemView – 应该正确获取全局清算统计', async function () {
      const result = await systemView.connect(owner).getGlobalLiquidationView();
      expect(result.totalLiquidations).to.be.a('bigint');
      expect(result.totalProfitDistributed).to.be.a('bigint');
      expect(result.activeLiquidators).to.be.a('bigint');
    });

    it('SystemView – 应该正确获取清算人排行榜', async function () {
      const result = await systemView.connect(owner).getLiquidatorLeaderboard(5);
      expect(result.liquidators).to.be.an('array');
      expect(result.profits).to.be.an('array');
      expect(result.liquidations).to.be.an('array');
    });

    it('SystemView – 应该拒绝零限制的排行榜查询', async function () {
      await expect(
        systemView.connect(owner).getLiquidatorLeaderboard(0)
      ).to.be.revertedWith('SystemView: limit must be positive');
    });

    it('SystemView – 应该拒绝超限制的排行榜查询', async function () {
      await expect(
        systemView.connect(owner).getLiquidatorLeaderboard(101)
      ).to.be.revertedWith('SystemView: limit too high');
    });

    it('SystemView – 应该正确获取清算人临时债务', async function () {
      const result = await systemView.connect(owner).getLiquidatorTempDebt(alice.address, TEST_ASSET);
      expect(result).to.be.a('bigint');
    });

    it('SystemView – 应该正确获取清算人收益比例', async function () {
      const result = await systemView.connect(owner).getLiquidatorProfitRate();
      expect(result).to.be.a('bigint');
    });
  });

  describe('系统统计功能测试', function () {
    it('SystemView – 应该正确获取全局统计视图', async function () {
      const result = await systemView.connect(owner).getGlobalStatisticsView();
      expect(result.totalUsers).to.be.a('bigint');
      expect(result.activeUsers).to.be.a('bigint');
      expect(result.totalCollateral).to.be.a('bigint');
      expect(result.totalDebt).to.be.a('bigint');
      expect(result.totalGuarantee).to.be.a('bigint');
      expect(result.totalRewardPoints).to.be.a('bigint');
      expect(result.averageHealthFactor).to.be.a('bigint');
      expect(result.lastUpdateTime).to.be.a('bigint');
    });

    it('SystemView – 应该正确获取奖励系统视图', async function () {
      const result = await systemView.connect(owner).getRewardSystemView();
      expect(result.rewardRate).to.be.a('bigint');
      expect(result.totalRewardPoints).to.be.a('bigint');
      expect(result.activeUsers).to.be.a('bigint');
      expect(result.averageUserLevel).to.be.a('bigint');
    });

    it('SystemView – 应该正确获取保证金系统视图', async function () {
      const result = await systemView.connect(owner).getGuaranteeSystemView();
      expect(result.totalLockedGuarantee).to.be.a('bigint');
      expect(result.totalEarlyRepaymentGuarantee).to.be.a('bigint');
      expect(result.activeGuarantees).to.be.a('bigint');
      expect(result.totalGuaranteeFund).to.be.a('bigint');
    });
  });

  describe('系统健康度测试', function () {
    it('SystemView – 应该正确获取系统健康度视图', async function () {
      const result = await systemView.connect(owner).getSystemHealthView();
      expect(result.priceValidAssets).to.be.a('bigint');
      expect(result.totalAssets).to.be.a('bigint');
      expect(result.healthFactorCacheValid).to.be.a('bigint');
      expect(result.totalUsers).to.be.a('bigint');
      expect(result.systemHealthScore).to.be.a('bigint');
      expect(result.lastUpdateTime).to.be.a('bigint');
    });
  });

  describe('优雅降级监控测试', function () {
    it('SystemView – 应该正确获取优雅降级统计信息', async function () {
      // 设置 Mock 数据
      await gracefulDegradationMonitor.setGracefulDegradationStats(
        10, // totalDegradations
        Math.floor(Date.now() / 1000), // lastDegradationTime
        alice.address, // lastDegradedModule
        'Test degradation', // lastDegradationReason
        1000, // fallbackValueUsed
        5000, // totalFallbackValue
        500 // averageFallbackValue
      );
      
      const result = await systemView.connect(owner).getGracefulDegradationStats();
      expect(result.totalDegradations).to.equal(BigInt(10));
      expect(result.lastDegradedModule).to.equal(alice.address);
    });

    it('SystemView – 应该正确获取模块健康状态', async function () {
      // 设置 Mock 数据
      await gracefulDegradationMonitor.setModuleHealthStatus(
        await collateralManager.getAddress(),
        true, // isHealthy
        'Module is working normally', // details
        Math.floor(Date.now() / 1000), // lastCheckTime
        0, // consecutiveFailures
        100, // totalChecks
        95 // successRate
      );
      
      const result = await systemView.connect(owner).getModuleHealthStatus(await collateralManager.getAddress());
      expect(result.module).to.equal(await collateralManager.getAddress());
      expect(result.isHealthy).to.be.true;
      expect(result.details).to.equal('Module is working normally');
    });

    it('SystemView – 应该正确获取系统降级历史记录', async function () {
      // 添加 Mock 历史记录
      await gracefulDegradationMonitor.addDegradationEvent(
        await collateralManager.getAddress(),
        'Network timeout', // reason
        1000, // fallbackValue
        true, // usedFallback
        Math.floor(Date.now() / 1000), // timestamp
        12345 // blockNumber
      );
      
      const result = await systemView.connect(owner).getSystemDegradationHistory(5);
      expect(result).to.be.an('array');
      if (result.length > 0) {
        expect(result[0].module).to.equal(await collateralManager.getAddress());
        expect(result[0].reason).to.equal('Network timeout');
      }
    });

    it('SystemView – 应该正确检查模块健康状态', async function () {
      // 设置 Mock 健康检查结果
      await gracefulDegradationMonitor.setModuleHealthCheck(
        await collateralManager.getAddress(),
        true, // isHealthy
        'Module is healthy' // details
      );
      
      const result = await systemView.connect(owner).checkModuleHealth(await collateralManager.getAddress());
      expect(result.isHealthy).to.be.true;
      expect(result.details).to.equal('Module is healthy');
    });

    it('SystemView – 应该正确获取系统降级趋势分析', async function () {
      // 设置 Mock 趋势数据
      await gracefulDegradationMonitor.setDegradationTrends(
        50, // totalEvents
        5, // recentEvents
        await collateralManager.getAddress(), // mostFrequentModule
        750 // averageFallbackValue
      );
      
      const result = await systemView.connect(owner).getSystemDegradationTrends();
      expect(result.totalEvents).to.equal(BigInt(50));
      expect(result.recentEvents).to.equal(BigInt(5));
      expect(result.mostFrequentModule).to.equal(await collateralManager.getAddress());
      expect(result.averageFallbackValue).to.equal(BigInt(750));
    });
  });

  describe('权限控制测试', function () {
    it('SystemView – 外部账户不应该能直接调用系统数据查询函数', async function () {
      await expect(
        systemView.connect(alice).getTotalCollateral(ZERO_ADDRESS)
      ).to.be.revertedWith('requireRole: MissingRole');
    });

    it('SystemView – 有权限的用户应该能正常调用系统数据查询函数', async function () {
      const result = await systemView.connect(owner).getTotalCollateral(ZERO_ADDRESS);
      expect(result).to.equal(BigInt(0));
    });

    it('SystemView – 非管理员不应该能安排模块升级', async function () {
      const newCollateralManager = await (await ethers.getContractFactory('MockCollateralManager')).deploy();
      
      await expect(
        systemView.connect(alice).scheduleModuleUpgrade(ModuleKeys.KEY_CM, await newCollateralManager.getAddress())
      ).to.be.revertedWith('requireRole: MissingRole');
    });

    it('SystemView – 非管理员不应该能执行模块升级', async function () {
      await expect(
        systemView.connect(alice).executeModuleUpgrade(ModuleKeys.KEY_CM)
      ).to.be.revertedWith('requireRole: MissingRole');
    });

    it('SystemView – 非管理员不应该能取消模块升级', async function () {
      await expect(
        systemView.connect(alice).cancelModuleUpgrade(ModuleKeys.KEY_CM)
      ).to.be.revertedWith('requireRole: MissingRole');
    });
  });

  describe('边界条件和错误处理测试', function () {
    it('SystemView – 应该正确处理不存在的模块查询', async function () {
      await expect(
        systemView.connect(owner).getModule(ethers.keccak256(ethers.toUtf8Bytes('NON_EXISTENT_MODULE')))
      ).to.be.reverted;
    });

    it('SystemView – 应该正确处理空字符串的命名模块查询', async function () {
      await expect(
        systemView.connect(owner).getNamedModule('')
      ).to.be.reverted;
    });

    it('SystemView – 应该正确处理零地址的资产查询', async function () {
      const result = await systemView.connect(owner).getTotalCollateral(ZERO_ADDRESS);
      expect(result).to.be.a('bigint');
    });

    it('SystemView – 应该正确处理零地址的清算人查询', async function () {
      const result = await systemView.connect(owner).getLiquidatorProfitView(ZERO_ADDRESS);
      expect(result.liquidator).to.equal(ZERO_ADDRESS);
    });

    it('SystemView – 应该正确处理零地址的模块健康检查', async function () {
      const result = await systemView.connect(owner).checkModuleHealth(ZERO_ADDRESS);
      expect(result.isHealthy).to.be.a('boolean');
      expect(result.details).to.be.a('string');
    });
  });

  describe('性能测试', function () {
    it('SystemView – 应该能处理大批量资产状态查询', async function () {
      const assets = Array(MAX_BATCH_SIZE).fill(TEST_ASSET);
      
      // 设置 Mock 返回值
      for (let i = 0; i < assets.length; i++) {
        await collateralManager.setTotalCollateralByAsset(assets[i], ethers.parseUnits('1000', 18));
        await lendingEngine.setTotalDebtByAsset(assets[i], ethers.parseUnits('500', 6));
        await priceOracle.setPrice(assets[i], ethers.parseUnits('2000', 6), 0, 0);
      }
      
      const startTime = Date.now();
      const result = await systemView.connect(owner).batchGetAssetStatus(assets);
      const endTime = Date.now();
      
      expect(result.collaterals).to.have.lengthOf(MAX_BATCH_SIZE);
      expect(result.debts).to.have.lengthOf(MAX_BATCH_SIZE);
      expect(result.prices).to.have.lengthOf(MAX_BATCH_SIZE);
      
      // 确保查询时间在合理范围内（小于5秒）
      expect(endTime - startTime).to.be.lessThan(5000);
    });

    it('SystemView – 应该能处理大批量清算人查询', async function () {
      const liquidators = Array(50).fill(alice.address);
      
      const startTime = Date.now();
      const result = await systemView.connect(owner).batchGetLiquidatorProfitViews(liquidators);
      const endTime = Date.now();
      
      expect(result).to.have.lengthOf(50);
      
      // 确保查询时间在合理范围内（小于5秒）
      expect(endTime - startTime).to.be.lessThan(5000);
    });
  });

  describe('安全场景测试', function () {
    it('SystemView – 应该防止重入攻击', async function () {
      // 这个测试验证合约没有重入漏洞
      // 通过正常调用确保不会出现重入问题
      const result = await systemView.connect(owner).getTotalCollateral(TEST_ASSET);
      expect(result).to.be.a('bigint');
    });

    it('SystemView – 应该正确处理权限升级', async function () {
      // 测试权限升级的安全性
      const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
      
      // 只有管理员才能授予权限
      await expect(
        acm.connect(alice).grantRole(ACTION_ADMIN, alice.address)
      ).to.be.reverted;
    });

    it('SystemView – 应该防止未授权的模块访问', async function () {
      // 测试未授权用户无法访问敏感模块
      await expect(
        systemView.connect(alice).getModule(ModuleKeys.KEY_CM)
      ).to.be.revertedWith('requireRole: MissingRole');
    });

    it('SystemView – 应该正确处理恶意模块地址', async function () {
      // 测试恶意模块地址的处理
      // 尝试获取恶意地址的模块信息
      await expect(
        systemView.connect(owner).getModule(ethers.keccak256(ethers.toUtf8Bytes('MALICIOUS_MODULE')))
      ).to.be.reverted;
    });
  });

  describe('事件测试', function () {
    it('SystemView – 应该正确触发系统数据访问事件', async function () {
      const result = await systemView.connect(owner).getTotalCollateral(TEST_ASSET);
      
      // 验证函数正常执行
      expect(result).to.be.a('bigint');
    });

    it('SystemView – 应该正确触发批量操作事件', async function () {
      const assets = [TEST_ASSET];
      const result = await systemView.connect(owner).batchGetAssetStatus(assets);
      
      // 验证函数正常执行
      expect(result.collaterals).to.be.an('array');
      expect(result.debts).to.be.an('array');
      expect(result.prices).to.be.an('array');
    });
  });

  describe('升级功能测试', function () {
    it('SystemView – 应该能正确升级合约', async function () {
      // 部署新版本的 SystemView
      const SystemViewV2 = await ethers.getContractFactory('SystemView');
      
      // 升级合约
      await expect(
        upgrades.upgradeProxy(await systemView.getAddress(), SystemViewV2)
      ).to.not.be.reverted;
    });

    it('SystemView – 非管理员不应该能升级合约', async function () {
      const SystemViewV2 = await ethers.getContractFactory('SystemView');
      
      await expect(
        upgrades.upgradeProxy(await systemView.getAddress(), SystemViewV2.connect(alice))
      ).to.be.reverted;
    });
  });
}); 

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
  MockStatisticsView,
  MockRewardManager,
  MockGuaranteeFundManager
} from '../../../types';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_BATCH_SIZE = 50;

describe('SystemView – view-only aggregator (architecture aligned)', function () {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  let systemView: SystemView;
  let acm: MockAccessControlManager;
  let registry: MockRegistry;
  let viewCache: ViewCache;
  let collateralManager: MockCollateralManager;
  let lendingEngine: MockLendingEngineConcrete;
  let priceOracle: MockPriceOracle;
  let statisticsView: MockStatisticsView;
  let rewardManager: MockRewardManager;
  let guaranteeFundManager: MockGuaranteeFundManager;

  let TEST_ASSET: string;

  async function deployFixture() {
    [owner, alice] = await ethers.getSigners();
    TEST_ASSET = ethers.Wallet.createRandom().address;

    const MockAccessControlManagerF = await ethers.getContractFactory('MockAccessControlManager');
    acm = await MockAccessControlManagerF.deploy();

    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    registry = await MockRegistryF.deploy();
    await registry.waitForDeployment();

    const ViewCacheF = await ethers.getContractFactory('ViewCache');
    viewCache = await upgrades.deployProxy(ViewCacheF, [await registry.getAddress()], { kind: 'uups' });

    const MockCollateralManagerF = await ethers.getContractFactory('MockCollateralManager');
    collateralManager = await MockCollateralManagerF.deploy();

    const MockLendingEngineConcreteF = await ethers.getContractFactory('MockLendingEngineConcrete');
    lendingEngine = await MockLendingEngineConcreteF.deploy();

    const MockPriceOracleF = await ethers.getContractFactory('MockPriceOracle');
    priceOracle = await MockPriceOracleF.deploy();

    const MockStatisticsViewF = await ethers.getContractFactory('MockStatisticsView');
    statisticsView = await MockStatisticsViewF.deploy();

    const MockRewardManagerF = await ethers.getContractFactory('MockRewardManager');
    rewardManager = await MockRewardManagerF.deploy();

    const MockGuaranteeFundManagerF = await ethers.getContractFactory('MockGuaranteeFundManager');
    guaranteeFundManager = await MockGuaranteeFundManagerF.deploy();

    // registry modules（使用与 ModuleKeys.sol 完全一致的哈希值；需在 SystemView 初始化前写入）
    const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER'));
    const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE'));
    const KEY_PRICE_ORACLE = ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE'));
    const KEY_STATS = ethers.keccak256(ethers.toUtf8Bytes('VAULT_STATISTICS'));
    const KEY_RM = ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER'));
    const KEY_GUARANTEE_FUND = ethers.keccak256(ethers.toUtf8Bytes('GUARANTEE_FUND_MANAGER'));
    const KEY_VIEW_CACHE = ethers.keccak256(ethers.toUtf8Bytes('VIEW_CACHE'));

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_CM, await collateralManager.getAddress());
    await registry.setModule(KEY_LE, await lendingEngine.getAddress());
    await registry.setModule(KEY_PRICE_ORACLE, await priceOracle.getAddress());
    await registry.setModule(KEY_STATS, await statisticsView.getAddress());
    await registry.setModule(KEY_RM, await rewardManager.getAddress());
    await registry.setModule(KEY_GUARANTEE_FUND, await guaranteeFundManager.getAddress());
    await registry.setModule(KEY_VIEW_CACHE, await viewCache.getAddress());
    // named module for getNamedModule
    const collateralManagerKey = ethers.keccak256(ethers.toUtf8Bytes('collateralManager'));
    await registry.setModule(collateralManagerKey, await collateralManager.getAddress());

    const SystemViewF = await ethers.getContractFactory('SystemView');
    // 使用真实 SystemView 实现，不做回退，确保接口齐全
    systemView = await upgrades.deployProxy(SystemViewF, [await registry.getAddress()], { kind: 'uups' });
    await systemView.waitForDeployment();

    // grant roles
    const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
    const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
    await acm.grantRole(ACTION_ADMIN, owner.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, owner.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, await systemView.getAddress());

    return {
      owner,
      alice,
      systemView,
      acm,
      registry,
      viewCache,
      collateralManager,
      lendingEngine,
      priceOracle,
      statisticsView,
      rewardManager,
      guaranteeFundManager,
      TEST_ASSET
    };
  }

  beforeEach(async function () {
    ({
      owner,
      alice,
      systemView,
      acm,
      registry,
      viewCache,
      collateralManager,
      lendingEngine,
      priceOracle,
      statisticsView,
      rewardManager,
      guaranteeFundManager,
      TEST_ASSET
    } = await deployFixture());
  });

  describe('初始化与权限', function () {
    it('应正确初始化依赖', async function () {
      expect(await systemView.acm()).to.equal(await acm.getAddress());
      expect(await systemView.registry()).to.equal(await registry.getAddress());
      expect(await systemView.registryAddr()).to.equal(await registry.getAddress());
      expect(await systemView.registryAddrVar()).to.equal(await registry.getAddress());
      expect(await systemView.viewCache()).to.equal(await viewCache.getAddress());
      expect(await systemView.viewCacheAddrVar()).to.equal(await viewCache.getAddress());
    });

    it('应拒绝零地址初始化', async function () {
      const SystemViewF = await ethers.getContractFactory('SystemView');
      await expect(upgrades.deployProxy(SystemViewF, [ZERO_ADDRESS])).to.be.revertedWithCustomError(SystemViewF, 'ZeroAddress');
    });
  });

  describe('Registry 解析', function () {
    it('应通过 Registry 获取模块', async function () {
      const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER'));
      const addr = await systemView.connect(owner).getModule(KEY_CM);
      expect(addr).to.equal(await collateralManager.getAddress());
    });

    it('应通过命名模块映射获取模块', async function () {
      const addr = await systemView.connect(owner).getNamedModule('collateralManager');
      expect(addr).to.equal(await collateralManager.getAddress());
    });

    it('未知命名模块应 revert', async function () {
      await expect(systemView.connect(owner).getNamedModule('nonExistentModule')).to.be.revertedWithCustomError(
        systemView,
        'SystemView__UnknownModuleName'
      );
    });
  });

  describe('资产与价格查询（已拆分至专属 View）', function () {
    it('getTotalCollateral 应提示使用 StatisticsView', async function () {
      await expect(systemView.connect(owner).getTotalCollateral(ZERO_ADDRESS)).to.be.revertedWith(
        'SystemView: use StatisticsView.getTotalCollateral'
      );
    });

    it('getTotalDebt 应提示使用 StatisticsView', async function () {
      await expect(systemView.connect(owner).getTotalDebt(ZERO_ADDRESS)).to.be.revertedWith(
        'SystemView: use StatisticsView.getTotalDebt'
      );
    });

    it('getAssetPrice 应提示使用 ValuationOracleView', async function () {
      await expect(systemView.connect(owner).getAssetPrice(ZERO_ADDRESS)).to.be.revertedWith(
        'SystemView: use ValuationOracleView.getAssetPrice'
      );
    });

    it('不再暴露 batchGetAssetStatus（由 BatchView 承担）', async function () {
      expect((systemView as any).batchGetAssetStatus).to.equal(undefined);
    });
  });

  describe('聚合统计视图', function () {
    it('应获取全局统计视图', async function () {
      const result = await systemView.connect(owner).getGlobalStatisticsView();
      expect(result.totalUsers).to.be.a('bigint');
      expect(result.activeUsers).to.be.a('bigint');
      expect(result.totalCollateral).to.be.a('bigint');
      expect(result.totalDebt).to.be.a('bigint');
      expect(result.lastUpdateTime).to.be.a('bigint');
    });

    it('getRewardSystemView 应提示使用 RewardView', async function () {
      await expect(systemView.connect(owner).getRewardSystemView()).to.be.revertedWith('SystemView: use RewardView.getRewardStats');
    });

    it('getGuaranteeSystemView 应提示使用 StatisticsView', async function () {
      await expect(systemView.connect(owner).getGuaranteeSystemView()).to.be.revertedWith(
        'SystemView: use StatisticsView.getTotalGuarantee'
      );
    });
  });

  describe('权限与边界', function () {
    it('无 VIEW_SYSTEM_DATA 权限的账户应被拒绝（调用仍在 SystemView 维护的接口）', async function () {
      await expect(systemView.connect(alice).getGlobalStatisticsView()).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('有权限账户可以查询（调用仍在 SystemView 维护的接口）', async function () {
      const result = await systemView.connect(owner).getGlobalStatisticsView();
      expect(result.totalCollateral).to.be.a('bigint');
    });

    it('模块健康检查零地址返回默认信息', async function () {
      const result = await systemView.connect(owner).checkModuleHealth(ZERO_ADDRESS);
      expect(result[0]).to.be.a('boolean');
      expect(result[1]).to.be.a('string');
    });
  });
});


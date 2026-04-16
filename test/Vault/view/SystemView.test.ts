import { expect } from 'chai';
import * as hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_BATCH_SIZE = 50;

describe('SystemView – view-only aggregator (architecture aligned)', function () {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;

  let systemView: any;
  let acm: any;
  let registry: any;
  let viewCache: any;
  let collateralManager: any;
  let lendingEngine: any;
  let priceOracle: any;
  let statisticsView: any;
  let rewardManager: any;
  let guaranteeFundManager: any;

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

    // SystemView route*() keys (integration path; MUST be consumable without relying on revert strings)
    const KEY_VALUATION_ORACLE_VIEW = ethers.keccak256(ethers.toUtf8Bytes('VALUATION_ORACLE_VIEW'));
    const KEY_REWARD_VIEW = ethers.keccak256(ethers.toUtf8Bytes('REWARD_VIEW'));
    const KEY_LIQUIDATION_VIEW = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_VIEW'));
    const KEY_RISK_VIEW = ethers.keccak256(ethers.toUtf8Bytes('RISK_VIEW'));
    const KEY_SYSTEM_RISK_VIEW = ethers.keccak256(ethers.toUtf8Bytes('SYSTEM_RISK_VIEW'));
    const KEY_USER_VIEW = ethers.keccak256(ethers.toUtf8Bytes('USER_VIEW'));
    const KEY_POSITION_VIEW = ethers.keccak256(ethers.toUtf8Bytes('POSITION_VIEW'));
    const KEY_BATCH_VIEW = ethers.keccak256(ethers.toUtf8Bytes('BATCH_VIEW'));
    const KEY_DASHBOARD_VIEW = ethers.keccak256(ethers.toUtf8Bytes('DASHBOARD_VIEW'));
    const KEY_PREVIEW_VIEW = ethers.keccak256(ethers.toUtf8Bytes('PREVIEW_VIEW'));

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_CM, await collateralManager.getAddress());
    await registry.setModule(KEY_LE, await lendingEngine.getAddress());
    await registry.setModule(KEY_PRICE_ORACLE, await priceOracle.getAddress());
    await registry.setModule(KEY_STATS, await statisticsView.getAddress());
    await registry.setModule(KEY_RM, await rewardManager.getAddress());
    await registry.setModule(KEY_GUARANTEE_FUND, await guaranteeFundManager.getAddress());
    await registry.setModule(KEY_VIEW_CACHE, await viewCache.getAddress());

    // Bind route targets (addresses do not need to implement specific interfaces for routing tests;
    // they only need to be non-zero and Registry-consistent).
    await registry.setModule(KEY_VALUATION_ORACLE_VIEW, await priceOracle.getAddress());
    await registry.setModule(KEY_REWARD_VIEW, await rewardManager.getAddress());
    await registry.setModule(KEY_LIQUIDATION_VIEW, await guaranteeFundManager.getAddress());
    await registry.setModule(KEY_RISK_VIEW, await lendingEngine.getAddress());
    await registry.setModule(KEY_SYSTEM_RISK_VIEW, await priceOracle.getAddress());
    await registry.setModule(KEY_USER_VIEW, await collateralManager.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await collateralManager.getAddress());
    await registry.setModule(KEY_BATCH_VIEW, await statisticsView.getAddress());
    await registry.setModule(KEY_DASHBOARD_VIEW, await viewCache.getAddress());
    await registry.setModule(KEY_PREVIEW_VIEW, await viewCache.getAddress());
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
    it('不再暴露 batchGetAssetStatus（由 BatchView 承担）', async function () {
      expect((systemView as any).batchGetAssetStatus).to.equal(undefined);
    });
  });

  describe('路由/发现性（MUST：可消费下一跳，不依赖 revert 文本）', function () {
    it('routePrice 应返回 primary+fallback 路由信息（moduleKey/moduleAddr 与 Registry 一致）', async function () {
      const expectedPrimaryKey = ethers.keccak256(ethers.toUtf8Bytes('VALUATION_ORACLE_VIEW'));
      const expectedFallbackKey = ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE'));

      const expectedPrimaryAddr = await registry.getModule(expectedPrimaryKey);
      const expectedFallbackAddr = await registry.getModule(expectedFallbackKey);

      const hint = await systemView.connect(owner).routePrice();
      expect(hint.primaryRoute.moduleKey).to.equal(expectedPrimaryKey);
      expect(hint.primaryRoute.moduleAddr).to.equal(expectedPrimaryAddr);
      expect(hint.primaryRoute.moduleAddr).to.not.equal(ZERO_ADDRESS);

      expect(hint.fallbackRoute.moduleKey).to.equal(expectedFallbackKey);
      expect(hint.fallbackRoute.moduleAddr).to.equal(expectedFallbackAddr);
      expect(hint.fallbackRoute.moduleAddr).to.not.equal(ZERO_ADDRESS);
    });

    it('routeStatistics/routeReward/routeLiquidation 等应返回可消费路由（moduleKey/moduleAddr 与 Registry 一致）', async function () {
      const cases = [
        { label: 'routeStatistics', fn: () => systemView.connect(owner).routeStatistics(), key: 'VAULT_STATISTICS' },
        { label: 'routeReward', fn: () => systemView.connect(owner).routeReward(), key: 'REWARD_VIEW' },
        { label: 'routeLiquidation', fn: () => systemView.connect(owner).routeLiquidation(), key: 'LIQUIDATION_VIEW' },
        { label: 'routeRisk', fn: () => systemView.connect(owner).routeRisk(), key: 'RISK_VIEW' },
        { label: 'routeSystemRisk', fn: () => systemView.connect(owner).routeSystemRisk(), key: 'SYSTEM_RISK_VIEW' },
        { label: 'routeUser', fn: () => systemView.connect(owner).routeUser(), key: 'USER_VIEW' },
        { label: 'routePosition', fn: () => systemView.connect(owner).routePosition(), key: 'POSITION_VIEW' },
        { label: 'routeBatch', fn: () => systemView.connect(owner).routeBatch(), key: 'BATCH_VIEW' },
        { label: 'routeDashboard', fn: () => systemView.connect(owner).routeDashboard(), key: 'DASHBOARD_VIEW' },
        { label: 'routePreview', fn: () => systemView.connect(owner).routePreview(), key: 'PREVIEW_VIEW' }
      ] as const;

      for (const c of cases) {
        const expectedKey = ethers.keccak256(ethers.toUtf8Bytes(c.key));
        const expectedAddr = await registry.getModule(expectedKey);
        const r = await c.fn();
        expect(r.moduleKey, `${c.label}: moduleKey`).to.equal(expectedKey);
        expect(r.moduleAddr, `${c.label}: moduleAddr`).to.equal(expectedAddr);
        expect(r.moduleAddr, `${c.label}: moduleAddr non-zero`).to.not.equal(ZERO_ADDRESS);
      }
    });
  });

  describe('权限与边界', function () {
    it('无 VIEW_SYSTEM_DATA 权限的账户应被拒绝（路由接口）', async function () {
      await expect(systemView.connect(alice).routeStatistics()).to.be.revertedWithCustomError(systemView, 'MissingRole');
    });

    it('有权限账户可以查询（路由接口）', async function () {
      const expectedKey = ethers.keccak256(ethers.toUtf8Bytes('VAULT_STATISTICS'));
      const expectedAddr = await registry.getModule(expectedKey);
      const r = await systemView.connect(owner).routeStatistics();
      expect(r.moduleKey).to.equal(expectedKey);
      expect(r.moduleAddr).to.equal(expectedAddr);
    });

  });
});


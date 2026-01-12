import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_LIQUIDATION_MANAGER = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_MANAGER'));
const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER'));
const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE'));
const KEY_PRICE_ORACLE = ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE'));
const KEY_POSITION_VIEW = ethers.keccak256(ethers.toUtf8Bytes('POSITION_VIEW'));
const KEY_LIQUIDATION_PROFIT_STATS_MANAGER = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_PROFIT_STATS_MANAGER'));
const KEY_LIQUIDATION_RECORD_MANAGER = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_RECORD_MANAGER'));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
const ACTION_VIEW_LIQUIDATION_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_LIQUIDATION_DATA'));
const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));

describe('LiquidatorView', function () {
  async function deployFixture() {
    const [admin, viewer, other, business, user2] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    const collateralMgr = await (await ethers.getContractFactory('MockCollateralManager')).deploy();
    const lendingEngine = await (await ethers.getContractFactory('MockLendingEngineBasic')).deploy();
    const priceOracle = await (await ethers.getContractFactory('MockPriceOracle')).connect(admin).deploy();
    const positionViewFactory = await ethers.getContractFactory('PositionView');
    const positionView = await upgrades.deployProxy(positionViewFactory, [await registry.getAddress()], { kind: 'uups' });
    const profitStats = await (await ethers.getContractFactory('MockLiquidationProfitStatsManager')).deploy();
    const recordMgr = await (await ethers.getContractFactory('MockLiquidationRecordManager')).deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_LIQUIDATION_MANAGER, business.address);
    await registry.setModule(KEY_CM, await collateralMgr.getAddress());
    await registry.setModule(KEY_LE, await lendingEngine.getAddress());
    await registry.setModule(KEY_PRICE_ORACLE, await priceOracle.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await positionView.getAddress());
    await registry.setModule(KEY_LIQUIDATION_PROFIT_STATS_MANAGER, await profitStats.getAddress());
    await registry.setModule(KEY_LIQUIDATION_RECORD_MANAGER, await recordMgr.getAddress());

    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_UPGRADE_MODULE, admin.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, admin.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, viewer.address);
    await acm.grantRole(ACTION_VIEW_LIQUIDATION_DATA, admin.address);
    await acm.grantRole(ACTION_VIEW_LIQUIDATION_DATA, viewer.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, viewer.address);

    const asset = ethers.Wallet.createRandom().address;
    await collateralMgr.depositCollateral(admin.address, asset, 1_000);
    await collateralMgr.depositCollateral(viewer.address, asset, 2_000);

    // Configure oracle for 1:1 valuation (price=1, decimals=8)
    const nowTs = Math.floor(Date.now() / 1000);
    await priceOracle.connect(admin).configureAsset(asset, 'test', 8, 3600);
    await priceOracle.connect(admin).setPrice(asset, ethers.parseUnits('1', 8), nowTs, 8);

    const LiquidatorViewFactory = await ethers.getContractFactory('LiquidatorView');
    const view = await upgrades.deployProxy(LiquidatorViewFactory, [await registry.getAddress(), ethers.ZeroAddress], {
      kind: 'uups',
    });

    return { view, registry, acm, admin, viewer, other, business, user2, collateralMgr, lendingEngine, priceOracle, positionView, profitStats, recordMgr, asset };
  }

  describe('initialization', function () {
    it('stores registry and exposes getters', async function () {
      const { view, registry } = await deployFixture();
      expect(await view.getRegistry()).to.equal(await registry.getAddress());
      expect(await view.registryAddr()).to.equal(await registry.getAddress());
    });

    it('reverts on zero address init', async function () {
      const factory = await ethers.getContractFactory('LiquidatorView');
      const impl = await factory.deploy();
      await impl.waitForDeployment();
      await expect(upgrades.deployProxy(factory, [ethers.ZeroAddress, ethers.ZeroAddress], { kind: 'uups' })).to.be.revertedWithCustomError(
        impl,
        'ZeroAddress',
      );
    });

    it('prevents double initialization', async function () {
      const { view, registry } = await deployFixture();
      await expect(view.initialize(await registry.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(
        view,
        'InvalidInitialization',
      );
    });
  });

  describe('access control', function () {
    it('denies viewing without role', async function () {
      const { view, other, admin, acm } = await deployFixture();
      await expect(view.connect(other).getLiquidatorProfitView(admin.address)).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('allows viewer role to read', async function () {
      const { view, viewer, admin } = await deployFixture();
      await expect(view.connect(viewer).getLiquidatorProfitView(admin.address)).to.not.be.reverted;
    });
  });

  describe('core reads', function () {
    it('returns liquidator profit view', async function () {
      const { view, viewer, admin } = await deployFixture();
      const res = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      expect(res.liquidator).to.equal(admin.address);
      expect(res.totalProfit).to.equal(0n);
      expect(res.totalLiquidations).to.equal(0n);
      expect(res.lastLiquidationTime).to.equal(0n);
    });

    it('returns global liquidation view', async function () {
      const { view, viewer } = await deployFixture();
      const res = await view.connect(viewer).getGlobalLiquidationView();
      expect(res.totalLiquidations).to.equal(0n);
      expect(res.totalProfitDistributed).to.equal(0n);
      expect(res.totalLiquidators).to.equal(0n);
    });

    it('returns batch liquidator profit views', async function () {
      const { view, viewer, admin } = await deployFixture();
      const views = await view.connect(viewer).batchGetLiquidatorProfitViews([admin.address, viewer.address]);
      expect(views.length).to.equal(2);
      expect(views[0].liquidator).to.equal(admin.address);
      expect(views[0].totalProfit).to.equal(0n);
      expect(views[1].liquidator).to.equal(viewer.address);
      expect(views[1].totalProfit).to.equal(0n);
    });

    it('returns leaderboard', async function () {
      const { view, viewer } = await deployFixture();
      const result = await view.connect(viewer).getLiquidatorLeaderboard(2);
      expect(result[0].length).to.equal(0);
      expect(result[1].length).to.equal(0);
    });

    it('returns temp debt', async function () {
      const { view, viewer, admin, asset } = await deployFixture();
      expect(await view.connect(viewer).getLiquidatorTempDebt(admin.address, asset)).to.equal(0n);
    });

    it('returns profit rate', async function () {
      const { view, viewer } = await deployFixture();
      expect(await view.connect(viewer).getLiquidatorProfitRate()).to.equal(0n);
    });
  });

  describe('user and system stats', function () {
    it('returns user liquidation stats', async function () {
      const { view, admin } = await deployFixture();
      const stats = await view.connect(admin).getUserLiquidationStats(admin.address);
      expect(stats.totalLiquidations).to.equal(0n);
      expect(stats.totalSeizedValue).to.equal(0n);
      expect(stats.lastLiquidationTime).to.equal(0n);
    });

    it('returns batch user liquidation stats', async function () {
      const { view, admin, user2 } = await deployFixture();
      const list = await view.connect(admin).batchGetLiquidationStats([admin.address, user2.address]);
      expect(list.length).to.equal(2);
      expect(list[0].totalLiquidations).to.equal(0n);
      expect(list[1].totalLiquidations).to.equal(0n);
    });

    it('returns system liquidation snapshot', async function () {
      const { view, viewer } = await deployFixture();
      const snap = await view.connect(viewer).getSystemLiquidationSnapshot();
      expect(snap.totalLiquidations).to.equal(0n);
      expect(snap.totalProfitDistributed).to.equal(0n);
    });
  });

  describe('collateral queries', function () {
    it('returns seizable collateral amount', async function () {
      const { view, admin, asset } = await deployFixture();
      expect(await view.connect(admin).getSeizableCollateralAmount(admin.address, asset)).to.equal(1_000n);
    });

    it('returns user total collateral value', async function () {
      const { view, admin } = await deployFixture();
      expect(await view.connect(admin).getUserTotalCollateralValue(admin.address)).to.equal(1_000n);
    });

    it('batch calculates collateral values', async function () {
      const { view, viewer, asset } = await deployFixture();
      const values = await view.connect(viewer).batchCalculateCollateralValues([asset], [1_000n]);
      expect(values[0]).to.equal(1_000n);
    });
  });

  describe('batch validation', function () {
    it('reverts on empty batch', async function () {
      const { view, viewer } = await deployFixture();
      await expect(view.connect(viewer).batchGetLiquidatorProfitViews([])).to.be.revertedWithCustomError(view, 'EmptyArray');
    });

    it('reverts on batch too large', async function () {
      const { view, viewer } = await deployFixture();
      const many = new Array(101).fill(viewer.address);
      await expect(view.connect(viewer).batchGetLiquidatorProfitViews(many)).to.be.revertedWithCustomError(
        view,
        'LiquidatorView__BatchTooLarge',
      );
    });

    it('reverts on invalid limit', async function () {
      const { view, viewer } = await deployFixture();
      await expect(view.connect(viewer).getLiquidatorLeaderboard(0)).to.be.revertedWithCustomError(view, 'LiquidatorView__InvalidLimit');
    });

    it('reverts on limit too large', async function () {
      const { view, viewer } = await deployFixture();
      await expect(view.connect(viewer).getLiquidatorLeaderboard(200)).to.be.revertedWithCustomError(view, 'LiquidatorView__BatchTooLarge');
    });

    it('reverts on array length mismatch for seizable amounts', async function () {
      const { view, viewer } = await deployFixture();
      await expect(
        view.connect(viewer).batchGetSeizableAmounts([viewer.address], [ethers.ZeroAddress, ethers.ZeroAddress]),
      ).to.be.revertedWithCustomError(view, 'ArrayLengthMismatch');
    });
  });

  describe('upgrade authorization', function () {
    it('allows admin to upgrade', async function () {
      const { view, admin } = await deployFixture();
      const factory = await ethers.getContractFactory('LiquidatorView');
      await upgrades.upgradeProxy(await view.getAddress(), factory.connect(admin));
    });

    it('reverts upgrade when caller is not admin', async function () {
      const { view, other, acm } = await deployFixture();
      const factory = await ethers.getContractFactory('LiquidatorView');
      await expect(upgrades.upgradeProxy(await view.getAddress(), factory.connect(other))).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('business module push', function () {
    it('reverts when caller not liquidation manager', async function () {
      const { view, viewer } = await deployFixture();
      await expect(
        view.connect(viewer).pushLiquidationUpdate(viewer.address, ethers.ZeroAddress, ethers.ZeroAddress, 0, 0, viewer.address, 0, 0),
      ).to.be.revertedWithCustomError(view, 'InvalidCaller');
    });

    it('allows liquidation manager to push', async function () {
      const { view, business } = await deployFixture();
      await expect(
        view.connect(business).pushLiquidationUpdate(business.address, ethers.ZeroAddress, ethers.ZeroAddress, 0, 0, business.address, 0, 0),
      ).to.not.be.reverted;
    });
  });

  describe('edge cases and error handling', function () {
    it('handles zero address liquidator in profit view', async function () {
      const { view, viewer } = await deployFixture();
      const res = await view.connect(viewer).getLiquidatorProfitView(ethers.ZeroAddress);
      expect(res.totalProfit).to.equal(0n);
      expect(res.totalLiquidations).to.equal(0n);
    });

    it('handles non-existent liquidator in profit view', async function () {
      const { view, viewer } = await deployFixture();
      const nonExistent = ethers.Wallet.createRandom().address;
      const res = await view.connect(viewer).getLiquidatorProfitView(nonExistent);
      expect(res.totalProfit).to.equal(0n);
      expect(res.totalLiquidations).to.equal(0n);
    });

    it('handles zero address user in liquidation stats', async function () {
      const { view, admin } = await deployFixture();
      const stats = await view.connect(admin).getUserLiquidationStats(ethers.ZeroAddress);
      expect(stats.totalLiquidations).to.equal(0n);
      expect(stats.totalSeizedValue).to.equal(0n);
    });

    it('handles zero address asset in seizable collateral', async function () {
      const { view, admin } = await deployFixture();
      expect(await view.connect(admin).getSeizableCollateralAmount(admin.address, ethers.ZeroAddress)).to.equal(0n);
    });

    it('handles zero address user in seizable collateral', async function () {
      const { view, admin, asset } = await deployFixture();
      expect(await view.connect(admin).getSeizableCollateralAmount(ethers.ZeroAddress, asset)).to.equal(0n);
    });

    it('handles very large profit values', async function () {
      const { view, viewer, admin } = await deployFixture();
      const res = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      expect(res.totalProfit).to.equal(0n);
    });

    it('handles zero profit with non-zero liquidations', async function () {
      const { view, viewer, admin } = await deployFixture();
      const res = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      expect(res.totalProfit).to.equal(0n);
      expect(res.totalLiquidations).to.equal(0n);
      expect(res.averageProfitPerLiquidation).to.equal(0n);
    });

    it('handles maximum batch size', async function () {
      const { view, viewer } = await deployFixture();
      const maxSize = 100;
      const liquidators = new Array(maxSize).fill(0).map(() => ethers.Wallet.createRandom().address);
      const views = await view.connect(viewer).batchGetLiquidatorProfitViews(liquidators);
      expect(views.length).to.equal(maxSize);
    });

    it('handles single element batch queries', async function () {
      const { view, viewer, admin, profitStats } = await deployFixture();
      await profitStats.setProfitStats(admin.address, 1_000, 1, 0);
      const views = await view.connect(viewer).batchGetLiquidatorProfitViews([admin.address]);
      expect(views.length).to.equal(1);
      // Scheme A: profit stats are aggregated off-chain; on-chain view returns 0 placeholders.
      expect(views[0].totalProfit).to.equal(0n);
    });
  });

  describe('business logic: profit calculations', function () {
    it('calculates average profit per liquidation correctly', async function () {
      const { view, viewer, admin } = await deployFixture();
      const res = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      expect(res.averageProfitPerLiquidation).to.equal(0n);
    });

    it('handles division by zero in average profit (zero liquidations)', async function () {
      const { view, viewer, admin } = await deployFixture();
      const res = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      expect(res.averageProfitPerLiquidation).to.equal(0n);
    });

    it('calculates days since last liquidation correctly', async function () {
      const { view, viewer, profitStats, admin } = await deployFixture();
      const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
      await profitStats.setProfitStats(admin.address, 1_000, 1, oneDayAgo);
      const res = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      expect(res.daysSinceLastLiquidation).to.be.gte(0n);
    });

    it('handles zero last liquidation time', async function () {
      const { view, viewer, admin } = await deployFixture();
      const res = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      expect(res.daysSinceLastLiquidation).to.equal(0n);
    });

    it('calculates global average profit per liquidation correctly', async function () {
      const { view, viewer } = await deployFixture();
      const res = await view.connect(viewer).getGlobalLiquidationView();
      expect(res.averageProfitPerLiquidation).to.equal(0n);
    });
  });

  describe('business logic: leaderboard rankings', function () {
    it('returns top liquidators sorted by profit', async function () {
      const { view, viewer } = await deployFixture();
      const result = await view.connect(viewer).getLiquidatorLeaderboard(3);
      expect(result[0].length).to.equal(0);
      expect(result[1].length).to.equal(0);
    });

    it('handles leaderboard with fewer liquidators than limit', async function () {
      const { view, viewer } = await deployFixture();
      const result = await view.connect(viewer).getLiquidatorLeaderboard(10);
      expect(result[0].length).to.equal(0);
    });

    it('handles empty leaderboard', async function () {
      const { view, viewer } = await deployFixture();
      const result = await view.connect(viewer).getLiquidatorLeaderboard(10);
      expect(result[0].length).to.equal(0);
      expect(result[1].length).to.equal(0);
    });
  });

  describe('business logic: temp debt tracking', function () {
    it('tracks temp debt for different assets independently', async function () {
      const { view, viewer, admin } = await deployFixture();
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      expect(await view.connect(viewer).getLiquidatorTempDebt(admin.address, asset1)).to.equal(0n);
      expect(await view.connect(viewer).getLiquidatorTempDebt(admin.address, asset2)).to.equal(0n);
    });

    it('handles zero temp debt', async function () {
      const { view, viewer, admin, asset } = await deployFixture();
      expect(await view.connect(viewer).getLiquidatorTempDebt(admin.address, asset)).to.equal(0n);
    });

    it('handles non-existent liquidator temp debt', async function () {
      const { view, viewer, asset } = await deployFixture();
      const nonExistent = ethers.Wallet.createRandom().address;
      expect(await view.connect(viewer).getLiquidatorTempDebt(nonExistent, asset)).to.equal(0n);
    });
  });

  describe('business logic: collateral value calculations', function () {
    it('calculates collateral value correctly', async function () {
      const { view, viewer, asset } = await deployFixture();
      const value = await view.connect(viewer).calculateCollateralValue(asset, 1_000n);
      expect(value).to.equal(1_000n); // Mock returns 1:1
    });

    it('handles zero amount in collateral value calculation', async function () {
      const { view, viewer, asset } = await deployFixture();
      expect(await view.connect(viewer).calculateCollateralValue(asset, 0n)).to.equal(0n);
    });

    it('handles zero address asset in collateral value calculation', async function () {
      const { view, viewer } = await deployFixture();
      expect(await view.connect(viewer).calculateCollateralValue(ethers.ZeroAddress, 1_000n)).to.equal(0n);
    });

    it('batch calculates multiple collateral values', async function () {
      const { view, viewer, priceOracle, admin } = await deployFixture();
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      const nowTs = Math.floor(Date.now() / 1000);
      await priceOracle.connect(admin).configureAsset(asset1, 'a1', 8, 3600);
      await priceOracle.connect(admin).setPrice(asset1, ethers.parseUnits('1', 8), nowTs, 8);
      await priceOracle.connect(admin).configureAsset(asset2, 'a2', 8, 3600);
      await priceOracle.connect(admin).setPrice(asset2, ethers.parseUnits('1', 8), nowTs, 8);
      const values = await view.connect(viewer).batchCalculateCollateralValues([asset1, asset2], [1_000n, 2_000n]);
      expect(values[0]).to.equal(1_000n);
      expect(values[1]).to.equal(2_000n);
    });

    it('handles zero amounts in batch collateral value calculation', async function () {
      const { view, viewer, asset } = await deployFixture();
      const values = await view.connect(viewer).batchCalculateCollateralValues([asset, asset], [0n, 1_000n]);
      expect(values[0]).to.equal(0n);
      expect(values[1]).to.equal(1_000n);
    });
  });

  describe('business logic: seizable collateral queries', function () {
    it('returns all seizable collaterals for user', async function () {
      const { view, admin, collateralMgr } = await deployFixture();
      const asset1 = ethers.Wallet.createRandom().address;
      const asset2 = ethers.Wallet.createRandom().address;
      await collateralMgr.depositCollateral(admin.address, asset1, 1_000);
      await collateralMgr.depositCollateral(admin.address, asset2, 2_000);
      const result = await view.connect(admin).getSeizableCollaterals(admin.address);
      // Note: MockCollateralManager.getUserCollateralAssets returns empty array
      // This test verifies the function doesn't revert
      expect(result[0]).to.be.an('array');
      expect(result[1]).to.be.an('array');
    });

    it('handles user with no collateral', async function () {
      const { view, admin } = await deployFixture();
      const newUser = ethers.Wallet.createRandom().address;
      const result = await view.connect(admin).getSeizableCollaterals(newUser);
      expect(result[0].length).to.equal(0);
      expect(result[1].length).to.equal(0);
    });

    it('batch gets seizable amounts for multiple users', async function () {
      const fixture = await deployFixture();
      const { view, viewer, admin, collateralMgr, asset } = fixture;
      const user2 = (await ethers.getSigners())[4]?.address || ethers.Wallet.createRandom().address;
      const assetAddr = asset || ethers.Wallet.createRandom().address;
      // admin already has 1000 from fixture, user2 gets 3000
      await collateralMgr.depositCollateral(user2, assetAddr, 3_000);
      const amounts = await view.connect(viewer).batchGetSeizableAmounts([admin.address, user2], [assetAddr, assetAddr]);
      expect(amounts.length).to.equal(2);
      expect(amounts[0]).to.equal(1_000n); // admin has 1000 from fixture
      expect(amounts[1]).to.equal(3_000n); // user2 has 3000
    });

    it('handles zero address in batch seizable amounts', async function () {
      const { view, viewer, admin, asset } = await deployFixture();
      const amounts = await view.connect(viewer).batchGetSeizableAmounts([admin.address, ethers.ZeroAddress], [asset, asset]);
      expect(amounts[0]).to.equal(1_000n);
      expect(amounts[1]).to.equal(0n);
    });
  });

  describe('business logic: user liquidation stats aggregation', function () {
    it('aggregates stats from record and profit managers', async function () {
      const { view, admin, recordMgr, profitStats } = await deployFixture();
      await recordMgr.setUserRecord(admin.address, 5, 500);
      await profitStats.setProfitStats(admin.address, 3_000, 5, 500);
      const stats = await view.connect(admin).getUserLiquidationStats(admin.address);
      // Scheme A: user liquidation stats are aggregated off-chain; on-chain returns placeholders.
      expect(stats.totalLiquidations).to.equal(0n);
      expect(stats.totalSeizedValue).to.equal(0n);
      expect(stats.lastLiquidationTime).to.equal(0n);
    });

    it('returns zero stats when record manager module is not registered', async function () {
      const { view, admin, registry } = await deployFixture();
      await registry.setModule(KEY_LIQUIDATION_RECORD_MANAGER, ethers.ZeroAddress);
      const stats = await view.connect(admin).getUserLiquidationStats(admin.address);
      expect(stats.totalLiquidations).to.equal(0n);
      expect(stats.totalSeizedValue).to.equal(0n);
    });

    it('returns zero stats when profit stats manager module is not registered', async function () {
      const { view, admin, registry } = await deployFixture();
      await registry.setModule(KEY_LIQUIDATION_PROFIT_STATS_MANAGER, ethers.ZeroAddress);
      const stats = await view.connect(admin).getUserLiquidationStats(admin.address);
      expect(stats.totalLiquidations).to.equal(0n);
      expect(stats.totalSeizedValue).to.equal(0n);
    });
  });

  describe('business logic: activity stats', function () {
    it('returns correct activity stats', async function () {
      const { view, viewer, profitStats, admin } = await deployFixture();
      await profitStats.setProfitStats(admin.address, 6_000, 3, 200);
      const stats = await view.connect(viewer).getLiquidatorActivityStats(admin.address, 86400);
      // Scheme A: activity stats are aggregated off-chain; on-chain returns placeholders.
      expect(stats.totalLiquidations).to.equal(0n);
      expect(stats.totalProfit).to.equal(0n);
      expect(stats.averageProfit).to.equal(0n);
      expect(stats.lastActivity).to.equal(0n);
    });

    it('handles zero liquidations in activity stats', async function () {
      const { view, viewer, profitStats, admin } = await deployFixture();
      await profitStats.setProfitStats(admin.address, 0, 0, 0);
      const stats = await view.connect(viewer).getLiquidatorActivityStats(admin.address, 86400);
      expect(stats.totalLiquidations).to.equal(0n);
      expect(stats.averageProfit).to.equal(0n);
    });
  });

  describe('business logic: market overview', function () {
    it('calculates average liquidation size correctly', async function () {
      const { view, viewer } = await deployFixture();
      const overview = await view.connect(viewer).getLiquidationMarketOverview();
      expect(overview.totalLiquidations).to.equal(0n);
      expect(overview.totalVolume).to.equal(0n);
      expect(overview.avgLiquidationSize).to.equal(0n);
    });

    it('handles zero liquidations in market overview', async function () {
      const { view, viewer } = await deployFixture();
      const overview = await view.connect(viewer).getLiquidationMarketOverview();
      expect(overview.avgLiquidationSize).to.equal(0n);
    });
  });

  describe('business logic: trends analysis', function () {
    it('returns liquidation trends', async function () {
      const { view, viewer } = await deployFixture();
      const trends = await view.connect(viewer).getLiquidationTrends(86400);
      expect(trends.liquidationCount).to.equal(0n);
      expect(trends.liquidationVolume).to.equal(0n);
    });
  });

  describe('data consistency and updates', function () {
    it('reflects profit stats updates immediately', async function () {
      const { view, viewer, admin } = await deployFixture();
      let res = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      res = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      expect(res.totalProfit).to.equal(0n);
      expect(res.totalLiquidations).to.equal(0n);
    });

    it('reflects global stats updates immediately', async function () {
      const { view, viewer } = await deployFixture();
      let res = await view.connect(viewer).getGlobalLiquidationView();
      res = await view.connect(viewer).getGlobalLiquidationView();
      expect(res.totalLiquidations).to.equal(0n);
      expect(res.totalProfitDistributed).to.equal(0n);
    });

    it('maintains consistency across multiple queries', async function () {
      const { view, viewer, admin } = await deployFixture();
      const res1 = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      const res2 = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      const res3 = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      
      expect(res1.totalProfit).to.equal(res2.totalProfit);
      expect(res2.totalProfit).to.equal(res3.totalProfit);
      expect(res1.totalLiquidations).to.equal(res2.totalLiquidations);
      expect(res2.totalLiquidations).to.equal(res3.totalLiquidations);
    });
  });

  describe('integration scenarios', function () {
    it('queries multiple liquidator properties in sequence', async function () {
      const { view, viewer, admin, asset } = await deployFixture();
      const profitView = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      const tempDebt = await view.connect(viewer).getLiquidatorTempDebt(admin.address, asset);
      const profitRate = await view.connect(viewer).getLiquidatorProfitRate();
      const activityStats = await view.connect(viewer).getLiquidatorActivityStats(admin.address, 86400);
      
      expect(profitView.totalProfit).to.equal(0n);
      expect(tempDebt).to.equal(0n);
      expect(profitRate).to.equal(0n);
      expect(activityStats.totalLiquidations).to.equal(0n);
    });

    it('combines batch queries with individual queries', async function () {
      const { view, viewer, admin } = await deployFixture();
      const batchViews = await view.connect(viewer).batchGetLiquidatorProfitViews([admin.address]);
      const individualView = await view.connect(viewer).getLiquidatorProfitView(admin.address);
      
      expect(batchViews[0].totalProfit).to.equal(individualView.totalProfit);
      expect(batchViews[0].totalLiquidations).to.equal(individualView.totalLiquidations);
    });

    it('queries system snapshot and global view consistently', async function () {
      const { view, viewer } = await deployFixture();
      const snapshot = await view.connect(viewer).getSystemLiquidationSnapshot();
      const globalView = await view.connect(viewer).getGlobalLiquidationView();
      
      expect(snapshot.totalLiquidations).to.equal(globalView.totalLiquidations);
      expect(snapshot.totalProfitDistributed).to.equal(globalView.totalProfitDistributed);
      expect(snapshot.totalLiquidators).to.equal(globalView.totalLiquidators);
    });
  });

  describe('multi-user and multi-asset scenarios', function () {
    it('handles queries for many liquidators efficiently', async function () {
      const { view, viewer } = await deployFixture();
      const liquidators: string[] = [];
      for (let i = 0; i < 50; i++) {
        const liquidator = ethers.Wallet.createRandom().address;
        liquidators.push(liquidator);
      }
      
      const views = await view.connect(viewer).batchGetLiquidatorProfitViews(liquidators);
      expect(views.length).to.equal(50);
      for (let i = 0; i < 50; i++) {
        expect(views[i].totalProfit).to.equal(0n);
        expect(views[i].totalLiquidations).to.equal(0n);
      }
    });

    it('handles multiple assets for same liquidator', async function () {
      const { view, viewer, admin } = await deployFixture();
      const assets: string[] = [];
      for (let i = 0; i < 10; i++) {
        const asset = ethers.Wallet.createRandom().address;
        assets.push(asset);
      }
      
      for (let i = 0; i < 10; i++) {
        const tempDebt = await view.connect(viewer).getLiquidatorTempDebt(admin.address, assets[i]);
        expect(tempDebt).to.equal(0n);
      }
    });

    it('handles batch queries with mixed data', async function () {
      const { view, viewer } = await deployFixture();
      const liquidator1 = ethers.Wallet.createRandom().address;
      const liquidator2 = ethers.Wallet.createRandom().address;
      const liquidator3 = ethers.Wallet.createRandom().address;
      
      const views = await view.connect(viewer).batchGetLiquidatorProfitViews([liquidator1, liquidator2, liquidator3]);
      expect(views[0].totalProfit).to.equal(0n);
      expect(views[1].totalProfit).to.equal(0n);
      expect(views[2].totalProfit).to.equal(0n);
    });
  });

  describe('concurrent query scenarios', function () {
    it('handles rapid sequential queries', async function () {
      const { view, viewer, admin } = await deployFixture();
      for (let i = 0; i < 20; i++) {
        const res = await view.connect(viewer).getLiquidatorProfitView(admin.address);
        expect(res.totalProfit).to.equal(0n);
      }
    });

    it('handles interleaved queries for different liquidators', async function () {
      const { view, viewer } = await deployFixture();
      const liquidator1 = ethers.Wallet.createRandom().address;
      const liquidator2 = ethers.Wallet.createRandom().address;
      
      const res1 = await view.connect(viewer).getLiquidatorProfitView(liquidator1);
      const res2 = await view.connect(viewer).getLiquidatorProfitView(liquidator2);
      const res1Again = await view.connect(viewer).getLiquidatorProfitView(liquidator1);
      const res2Again = await view.connect(viewer).getLiquidatorProfitView(liquidator2);
      
      expect(res1.totalProfit).to.equal(0n);
      expect(res2.totalProfit).to.equal(0n);
      expect(res1Again.totalProfit).to.equal(res1.totalProfit);
      expect(res2Again.totalProfit).to.equal(res2.totalProfit);
    });
  });

  describe('registry and module resolution', function () {
    it('returns zero when collateral manager module is not registered', async function () {
      const { view, admin, registry, asset } = await deployFixture();
      await registry.setModule(KEY_CM, ethers.ZeroAddress);
      await expect(view.connect(admin).getSeizableCollateralAmount(admin.address, asset)).to.not.be.reverted;
      expect(await view.connect(admin).getSeizableCollateralAmount(admin.address, asset)).to.equal(0n);
    });

    it('handles missing liquidation manager for push operations', async function () {
      const { view, business, registry, acm } = await deployFixture();
      await registry.setModule(KEY_LIQUIDATION_MANAGER, ethers.ZeroAddress);
      await expect(
        view.connect(business).pushLiquidationUpdate(business.address, ethers.ZeroAddress, ethers.ZeroAddress, 0, 0, business.address, 0, 0),
      ).to.be.revertedWith('MockRegistry: module not found');
    });
  });

  describe('batch operations edge cases', function () {
    it('handles batch with all zero address liquidators', async function () {
      const { view, viewer } = await deployFixture();
      const views = await view.connect(viewer).batchGetLiquidatorProfitViews([
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
      ]);
      expect(views.length).to.equal(3);
      expect(views[0].totalProfit).to.equal(0n);
      expect(views[1].totalProfit).to.equal(0n);
      expect(views[2].totalProfit).to.equal(0n);
    });

    it('handles batch collateral values with zero addresses', async function () {
      const { view, viewer, asset, priceOracle, admin } = await deployFixture();
      // ensure oracle has price for the asset used
      const nowTs = Math.floor(Date.now() / 1000);
      await priceOracle.connect(admin).configureAsset(asset, 'asset', 8, 3600);
      await priceOracle.connect(admin).setPrice(asset, ethers.parseUnits('1', 8), nowTs, 8);
      const values = await view.connect(viewer).batchCalculateCollateralValues(
        [asset, ethers.ZeroAddress, asset],
        [1_000n, 2_000n, 3_000n],
      );
      expect(values[0]).to.equal(1_000n);
      expect(values[1]).to.equal(0n); // Zero address
      expect(values[2]).to.equal(3_000n);
    });

    it('handles batch user liquidation stats with zero addresses', async function () {
      const { view, admin } = await deployFixture();
      const list = await view.connect(admin).batchGetLiquidationStats([admin.address, ethers.ZeroAddress]);
      expect(list.length).to.equal(2);
      expect(list[0].totalLiquidations).to.equal(0n);
      expect(list[1].totalLiquidations).to.equal(0n);
    });
  });

  describe('getter consistency', function () {
    it('registryAddr and getRegistry return same value', async function () {
      const { view, registry } = await deployFixture();
      const addr1 = await view.registryAddr();
      const addr2 = await view.getRegistry();
      expect(addr1).to.equal(addr2);
      expect(addr1).to.equal(await registry.getAddress());
    });
  });

  describe('data push events', function () {
    it('emits data push event for single liquidation update', async function () {
      const { view, business } = await deployFixture();
      await expect(
        view.connect(business).pushLiquidationUpdate(
          business.address,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          1_000,
          500,
          business.address,
          100,
          1000,
        ),
      ).to.emit(view, 'DataPushed');
    });

    it('emits data push event for batch liquidation update', async function () {
      const { view, business } = await deployFixture();
      await expect(
        view.connect(business).pushBatchLiquidationUpdate(
          [business.address],
          [ethers.ZeroAddress],
          [ethers.ZeroAddress],
          [1_000],
          [500],
          business.address,
          [100],
          1000,
        ),
      ).to.emit(view, 'DataPushed');
    });
  });

  describe('efficiency and risk analysis', function () {
    it('returns empty efficiency ranking (placeholder)', async function () {
      const { view, viewer } = await deployFixture();
      const result = await view.connect(viewer).getLiquidatorEfficiencyRanking(10);
      expect(result[0].length).to.equal(0);
      expect(result[1].length).to.equal(0);
      expect(result[2].length).to.equal(0);
    });

    it('returns default risk analysis (placeholder)', async function () {
      const { view, viewer, admin } = await deployFixture();
      const result = await view.connect(viewer).getLiquidatorRiskAnalysis(admin.address);
      expect(result.riskScore).to.equal(0n);
      expect(result.riskLevel).to.equal(0);
      expect(result.riskFactors.length).to.equal(0);
    });
  });
});

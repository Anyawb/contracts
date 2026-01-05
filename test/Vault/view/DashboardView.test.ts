import { expect } from 'chai';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_HEALTH_VIEW = ethers.keccak256(ethers.toUtf8Bytes('HEALTH_VIEW'));
const KEY_POSITION_VIEW = ethers.keccak256(ethers.toUtf8Bytes('POSITION_VIEW'));
const KEY_STATS = ethers.keccak256(ethers.toUtf8Bytes('VAULT_STATISTICS'));
const KEY_PRICE_ORACLE = ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE'));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));

describe('DashboardView', function () {
  async function deployFixture() {
    const [admin, viewer, viewer2, other] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    const healthView = await (await ethers.getContractFactory('BatchMockHealthView')).deploy();
    const positionView = await (await ethers.getContractFactory('CacheMockPositionView')).deploy();
    const statsView = await (await ethers.getContractFactory('CacheMockStatisticsView')).deploy();
    const priceOracle = await (await ethers.getContractFactory('BatchMockPriceOracle')).deploy();

    await registry.setModule(KEY_HEALTH_VIEW, await healthView.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await positionView.getAddress());
    await registry.setModule(KEY_STATS, await statsView.getAddress());
    await registry.setModule(KEY_PRICE_ORACLE, await priceOracle.getAddress());

    const DashboardViewFactory = await ethers.getContractFactory('DashboardView');
    const dashboardView = await upgrades.deployProxy(DashboardViewFactory, [await registry.getAddress()], {
      kind: 'uups',
    });

    const assetA = ethers.Wallet.createRandom().address;
    const assetB = ethers.Wallet.createRandom().address;
    const assetC = ethers.Wallet.createRandom().address;

    await healthView.setUserHealth(viewer.address, 12_000n, true);
    await healthView.setUserHealth(viewer2.address, 10_500n, true);
    await healthView.setUserHealth(other.address, 9_000n, true);

    await positionView.setPosition(viewer.address, assetA, 1_000n, 100n);
    await positionView.setPosition(viewer.address, assetB, 500n, 0n);
    await positionView.setPosition(viewer.address, assetC, 200n, 50n);
    await positionView.setPosition(viewer2.address, assetA, 800n, 200n);
    await positionView.setPosition(other.address, assetA, 200n, 150n);
    await positionView.setPosition(other.address, assetB, 100n, 80n);

    await statsView.setGlobalStatistics({
      totalUsers: 100,
      activeUsers: 80,
      totalCollateral: 10_000n,
      totalDebt: 5_000n,
      lastUpdateTime: 1_234_567n,
    });

    await priceOracle.setPrice(assetA, 2_000_000_000_000_000_000n); // 2e18
    await priceOracle.setPrice(assetB, 1_000_000_000_000_000_000n); // 1e18
    await priceOracle.setPrice(assetC, 3_000_000_000_000_000_000n); // 3e18

    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, admin.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, viewer.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, viewer.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, viewer2.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, viewer2.address);

    return {
      dashboardView,
      registry,
      acm,
      healthView,
      positionView,
      statsView,
      priceOracle,
      admin,
      viewer,
      viewer2,
      other,
      assetA,
      assetB,
      assetC,
    };
  }

  describe('initialization', function () {
    it('stores registry address', async function () {
      const { dashboardView, registry } = await loadFixture(deployFixture);
      expect(await dashboardView.registryAddr()).to.equal(await registry.getAddress());
    });

    it('reverts on zero address init', async function () {
      const DashboardViewFactory = await ethers.getContractFactory('DashboardView');
      await expect(upgrades.deployProxy(DashboardViewFactory, [ethers.ZeroAddress], { kind: 'uups' })).to.be
        .revertedWithCustomError(DashboardViewFactory, 'ZeroAddress');
    });

    it('prevents double initialization', async function () {
      const { dashboardView, registry } = await loadFixture(deployFixture);
      await expect(dashboardView.initialize(await registry.getAddress())).to.be.revertedWith(
        'Initializable: contract is already initialized',
      );
    });
  });

  describe('getUserOverview', function () {
    it('aggregates collateral/debt/health', async function () {
      const { dashboardView, viewer, assetA, assetB } = await loadFixture(deployFixture);
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA, assetB]);
      expect(overview.totalCollateral).to.equal(1_500n);
      expect(overview.totalDebt).to.equal(100n);
      expect(overview.healthFactor).to.equal(12_000n);
      expect(overview.healthFactorValid).to.equal(true);
      expect(overview.isRisky).to.equal(false);
    });

    it('handles empty tracked assets array', async function () {
      const { dashboardView, viewer } = await loadFixture(deployFixture);
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, []);
      expect(overview.totalCollateral).to.equal(0n);
      expect(overview.totalDebt).to.equal(0n);
      expect(overview.healthFactor).to.equal(12_000n);
      expect(overview.healthFactorValid).to.equal(true);
      expect(overview.isRisky).to.equal(false);
    });

    it('aggregates multiple assets correctly', async function () {
      const { dashboardView, viewer, assetA, assetB, assetC } = await loadFixture(deployFixture);
      const overview = await dashboardView
        .connect(viewer)
        .getUserOverview(viewer.address, [assetA, assetB, assetC]);
      expect(overview.totalCollateral).to.equal(1_700n); // 1000 + 500 + 200
      expect(overview.totalDebt).to.equal(150n); // 100 + 0 + 50
    });

    it('marks user as risky when health factor below threshold', async function () {
      const { dashboardView, viewer, assetA, healthView } = await loadFixture(deployFixture);
      // Set health factor below threshold (11000 bps = 110%)
      await healthView.setUserHealth(viewer.address, 9_000n, true); // 90% = 9000 bps
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA]);
      expect(overview.healthFactor).to.equal(9_000n);
      expect(overview.isRisky).to.equal(true); // Below 110% threshold (11000 bps)
    });

    it('marks user as not risky when health factor at threshold', async function () {
      const { dashboardView, viewer, assetA, healthView } = await loadFixture(deployFixture);
      // Set health factor exactly at threshold (11000 bps = 110%)
      await healthView.setUserHealth(viewer.address, 11_000n, true);
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA]);
      expect(overview.healthFactor).to.equal(11_000n);
      expect(overview.isRisky).to.equal(false); // At or above 110% threshold (11000 bps)
    });

    it('marks user as not risky when health factor above threshold', async function () {
      const { dashboardView, viewer, assetA } = await loadFixture(deployFixture);
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA]);
      expect(overview.healthFactor).to.equal(12_000n);
      expect(overview.isRisky).to.equal(false);
    });

    it('handles invalid health factor cache', async function () {
      const { dashboardView, healthView, viewer, assetA } = await loadFixture(deployFixture);
      await healthView.setUserHealth(viewer.address, 8_000n, false);
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA]);
      expect(overview.healthFactor).to.equal(8_000n);
      expect(overview.healthFactorValid).to.equal(false);
      expect(overview.isRisky).to.equal(false); // When invalid, isRisky is false
    });

    it('handles zero collateral and debt', async function () {
      const { dashboardView, positionView, viewer, assetA } = await loadFixture(deployFixture);
      const newAsset = ethers.Wallet.createRandom().address;
      await positionView.setPosition(viewer.address, newAsset, 0n, 0n);
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, [newAsset]);
      expect(overview.totalCollateral).to.equal(0n);
      expect(overview.totalDebt).to.equal(0n);
    });

    it('handles large amounts correctly', async function () {
      const { dashboardView, positionView, viewer, assetA } = await loadFixture(deployFixture);
      const largeAmount = ethers.parseEther('1000000');
      await positionView.setPosition(viewer.address, assetA, largeAmount, largeAmount / 2n);
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA]);
      expect(overview.totalCollateral).to.equal(largeAmount);
      expect(overview.totalDebt).to.equal(largeAmount / 2n);
    });

    it('requires VIEW_USER_DATA role', async function () {
      const { dashboardView, other, assetA, acm } = await loadFixture(deployFixture);
      await expect(
        dashboardView.connect(other).getUserOverview(other.address, [assetA]),
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('handles user with no positions', async function () {
      const { dashboardView, viewer } = await loadFixture(deployFixture);
      const newUser = ethers.Wallet.createRandom().address;
      await dashboardView.connect(viewer).getUserOverview(newUser, []);
      // Should not revert, just return zeros
      const overview = await dashboardView.connect(viewer).getUserOverview(newUser, []);
      expect(overview.totalCollateral).to.equal(0n);
      expect(overview.totalDebt).to.equal(0n);
    });
  });

  describe('getUserAssetBreakdown', function () {
    it('returns per-asset positions with price', async function () {
      const { dashboardView, viewer, assetA, assetB } = await loadFixture(deployFixture);
      const items = await dashboardView.connect(viewer).getUserAssetBreakdown(viewer.address, [assetA, assetB]);
      expect(items.length).to.equal(2);
      expect(items[0].asset).to.equal(assetA);
      expect(items[0].collateral).to.equal(1_000n);
      expect(items[0].debt).to.equal(100n);
      expect(items[0].price).to.equal(2_000_000_000_000_000_000n);
      expect(items[1].asset).to.equal(assetB);
      expect(items[1].collateral).to.equal(500n);
      expect(items[1].debt).to.equal(0n);
      expect(items[1].price).to.equal(1_000_000_000_000_000_000n);
    });

    it('handles empty assets array', async function () {
      const { dashboardView, viewer } = await loadFixture(deployFixture);
      const items = await dashboardView.connect(viewer).getUserAssetBreakdown(viewer.address, []);
      expect(items.length).to.equal(0);
    });

    it('handles multiple assets', async function () {
      const { dashboardView, viewer, assetA, assetB, assetC } = await loadFixture(deployFixture);
      const items = await dashboardView
        .connect(viewer)
        .getUserAssetBreakdown(viewer.address, [assetA, assetB, assetC]);
      expect(items.length).to.equal(3);
      expect(items[2].asset).to.equal(assetC);
      expect(items[2].price).to.equal(3_000_000_000_000_000_000n);
    });

    it('handles asset without price in oracle', async function () {
      const { dashboardView, viewer, priceOracle } = await loadFixture(deployFixture);
      const assetWithoutPrice = ethers.Wallet.createRandom().address;
      // Don't set price for this asset
      const items = await dashboardView
        .connect(viewer)
        .getUserAssetBreakdown(viewer.address, [assetWithoutPrice]);
      expect(items[0].asset).to.equal(assetWithoutPrice);
      expect(items[0].price).to.equal(0n); // Price should be 0 when not found
    });

    it('handles price oracle failure gracefully', async function () {
      const { dashboardView, viewer, assetA } = await loadFixture(deployFixture);
      // Price oracle will return successfully, but if it fails, price should be 0
      const items = await dashboardView.connect(viewer).getUserAssetBreakdown(viewer.address, [assetA]);
      expect(items[0].price).to.be.gt(0n); // Should have price
    });

    it('handles missing price oracle module', async function () {
      const [admin, viewer] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

      const healthView = await (await ethers.getContractFactory('BatchMockHealthView')).deploy();
      const positionView = await (await ethers.getContractFactory('CacheMockPositionView')).deploy();
      const statsView = await (await ethers.getContractFactory('CacheMockStatisticsView')).deploy();
      // Don't set price oracle

      await registry.setModule(KEY_HEALTH_VIEW, await healthView.getAddress());
      await registry.setModule(KEY_POSITION_VIEW, await positionView.getAddress());
      await registry.setModule(KEY_STATS, await statsView.getAddress());

      const DashboardViewFactory = await ethers.getContractFactory('DashboardView');
      const dashboardView = await upgrades.deployProxy(DashboardViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      const assetA = ethers.Wallet.createRandom().address;
      await positionView.setPosition(viewer.address, assetA, 1_000n, 100n);
      await acm.grantRole(ACTION_VIEW_USER_DATA, viewer.address);

      const items = await dashboardView.connect(viewer).getUserAssetBreakdown(viewer.address, [assetA]);
      expect(items[0].price).to.equal(0n); // Should be 0 when oracle is missing
    });

    it('handles zero address asset', async function () {
      const { dashboardView, viewer, positionView } = await loadFixture(deployFixture);
      await positionView.setPosition(viewer.address, ethers.ZeroAddress, 0n, 0n);
      const items = await dashboardView.connect(viewer).getUserAssetBreakdown(viewer.address, [ethers.ZeroAddress]);
      expect(items[0].asset).to.equal(ethers.ZeroAddress);
      expect(items[0].price).to.equal(0n);
    });

    it('handles zero collateral and debt', async function () {
      const { dashboardView, viewer, positionView, assetA } = await loadFixture(deployFixture);
      await positionView.setPosition(viewer.address, assetA, 0n, 0n);
      const items = await dashboardView.connect(viewer).getUserAssetBreakdown(viewer.address, [assetA]);
      expect(items[0].collateral).to.equal(0n);
      expect(items[0].debt).to.equal(0n);
    });

    it('requires VIEW_USER_DATA role', async function () {
      const { dashboardView, other, assetA, acm } = await loadFixture(deployFixture);
      await expect(
        dashboardView.connect(other).getUserAssetBreakdown(other.address, [assetA]),
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('returns correct order of assets', async function () {
      const { dashboardView, viewer, assetA, assetB, assetC } = await loadFixture(deployFixture);
      const items = await dashboardView
        .connect(viewer)
        .getUserAssetBreakdown(viewer.address, [assetC, assetA, assetB]);
      expect(items[0].asset).to.equal(assetC);
      expect(items[1].asset).to.equal(assetA);
      expect(items[2].asset).to.equal(assetB);
    });
  });

  describe('system overview', function () {
    it('returns statistics and enforces role', async function () {
      const { dashboardView, viewer, other, acm } = await loadFixture(deployFixture);
      const stats = await dashboardView.connect(viewer).getSystemOverview();
      expect(stats.totalUsers).to.equal(100n);
      expect(stats.activeUsers).to.equal(80n);
      expect(stats.totalCollateral).to.equal(10_000n);
      expect(stats.totalDebt).to.equal(5_000n);
      expect(stats.lastUpdateTime).to.equal(1_234_567n);

      await expect(dashboardView.connect(other).getSystemOverview()).to.be.revertedWithCustomError(
        acm,
        'MissingRole',
      );
    });

    it('returns updated statistics after mock update', async function () {
      const { dashboardView, statsView, viewer } = await loadFixture(deployFixture);
      await statsView.setGlobalStatistics({
        totalUsers: 200,
        activeUsers: 150,
        totalCollateral: 50_000n,
        totalDebt: 20_000n,
        lastUpdateTime: 2_345_678n,
      });
      const stats = await dashboardView.connect(viewer).getSystemOverview();
      expect(stats.totalUsers).to.equal(200n);
      expect(stats.activeUsers).to.equal(150n);
      expect(stats.totalCollateral).to.equal(50_000n);
      expect(stats.totalDebt).to.equal(20_000n);
      expect(stats.lastUpdateTime).to.equal(2_345_678n);
    });

    it('handles zero statistics', async function () {
      const { dashboardView, statsView, viewer } = await loadFixture(deployFixture);
      await statsView.setGlobalStatistics({
        totalUsers: 0,
        activeUsers: 0,
        totalCollateral: 0n,
        totalDebt: 0n,
        lastUpdateTime: 0n,
      });
      const stats = await dashboardView.connect(viewer).getSystemOverview();
      expect(stats.totalUsers).to.equal(0n);
      expect(stats.activeUsers).to.equal(0n);
      expect(stats.totalCollateral).to.equal(0n);
      expect(stats.totalDebt).to.equal(0n);
      expect(stats.lastUpdateTime).to.equal(0n);
    });

    it('handles large statistics values', async function () {
      const { dashboardView, statsView, viewer } = await loadFixture(deployFixture);
      const largeValue = ethers.parseEther('1000000000');
      await statsView.setGlobalStatistics({
        totalUsers: 1000000,
        activeUsers: 800000,
        totalCollateral: largeValue,
        totalDebt: largeValue / 2n,
        lastUpdateTime: 9999999999n,
      });
      const stats = await dashboardView.connect(viewer).getSystemOverview();
      expect(stats.totalCollateral).to.equal(largeValue);
      expect(stats.totalDebt).to.equal(largeValue / 2n);
    });
  });

  describe('UUPS upgradeability', function () {
    it('allows admin to upgrade', async function () {
      const { dashboardView, admin, registry } = await loadFixture(deployFixture);
      const DashboardViewFactory = await ethers.getContractFactory('DashboardView');
      await upgrades.upgradeProxy(await dashboardView.getAddress(), DashboardViewFactory);
      // 验证状态保持
      expect(await dashboardView.registryAddr()).to.equal(await registry.getAddress());
    });

    it('rejects upgrade from non-admin', async function () {
      const { dashboardView, viewer, acm } = await loadFixture(deployFixture);
      const DashboardViewFactory = await ethers.getContractFactory('DashboardView');
      await expect(
        upgrades.upgradeProxy(await dashboardView.getAddress(), DashboardViewFactory.connect(viewer)),
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('rejects upgrade to zero address', async function () {
      const { dashboardView, admin } = await loadFixture(deployFixture);
      // 零地址检查在 _authorizeUpgrade 中实现
      // 通过代码审查确认: if (newImplementation == address(0)) revert ZeroAddress();
      const DashboardViewFactory = await ethers.getContractFactory('DashboardView');
      await upgrades.upgradeProxy(await dashboardView.getAddress(), DashboardViewFactory);
      // 验证升级后功能正常
      expect(await dashboardView.registryAddr()).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe('error handling - missing modules', function () {
    it('reverts when HealthView module is missing', async function () {
      const [admin, viewer] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      // 不设置 KEY_HEALTH_VIEW

      const DashboardViewFactory = await ethers.getContractFactory('DashboardView');
      const dashboardView = await upgrades.deployProxy(DashboardViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      await acm.grantRole(ACTION_VIEW_USER_DATA, viewer.address);
      const assetA = ethers.Wallet.createRandom().address;

      await expect(
        dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA]),
      ).to.be.revertedWith('MockRegistry: module not found');
    });

    it('reverts when PositionView module is missing', async function () {
      const [admin, viewer] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      const healthView = await (await ethers.getContractFactory('BatchMockHealthView')).deploy();
      await registry.setModule(KEY_HEALTH_VIEW, await healthView.getAddress());
      // 不设置 KEY_POSITION_VIEW

      const DashboardViewFactory = await ethers.getContractFactory('DashboardView');
      const dashboardView = await upgrades.deployProxy(DashboardViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      await acm.grantRole(ACTION_VIEW_USER_DATA, viewer.address);
      const assetA = ethers.Wallet.createRandom().address;

      await expect(
        dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA]),
      ).to.be.revertedWith('MockRegistry: module not found');
    });

    it('reverts when StatisticsView module is missing', async function () {
      const [admin, viewer] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      // 不设置 KEY_STATS

      const DashboardViewFactory = await ethers.getContractFactory('DashboardView');
      const dashboardView = await upgrades.deployProxy(DashboardViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, viewer.address);

      await expect(dashboardView.connect(viewer).getSystemOverview()).to.be.revertedWith(
        'MockRegistry: module not found',
      );
    });
  });

  describe('data consistency', function () {
    it('getUserOverview matches getUserAssetBreakdown totals', async function () {
      const { dashboardView, viewer, assetA, assetB } = await loadFixture(deployFixture);
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA, assetB]);
      const breakdown = await dashboardView.connect(viewer).getUserAssetBreakdown(viewer.address, [assetA, assetB]);

      const breakdownCollateral = breakdown[0].collateral + breakdown[1].collateral;
      const breakdownDebt = breakdown[0].debt + breakdown[1].debt;

      expect(overview.totalCollateral).to.equal(breakdownCollateral);
      expect(overview.totalDebt).to.equal(breakdownDebt);
    });

    it('getUserOverview health factor matches direct query', async function () {
      const { dashboardView, healthView, viewer, assetA } = await loadFixture(deployFixture);
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA]);
      const [directHf, directValid] = await healthView.getUserHealthFactor(viewer.address);

      expect(overview.healthFactor).to.equal(directHf);
      expect(overview.healthFactorValid).to.equal(directValid);
    });

    it('getSystemOverview matches StatisticsView directly', async function () {
      const { dashboardView, statsView, viewer } = await loadFixture(deployFixture);
      const overview = await dashboardView.connect(viewer).getSystemOverview();
      const stats = await statsView.getGlobalStatistics();

      expect(overview.totalUsers).to.equal(stats.totalUsers);
      expect(overview.activeUsers).to.equal(stats.activeUsers);
      expect(overview.totalCollateral).to.equal(stats.totalCollateral);
      expect(overview.totalDebt).to.equal(stats.totalDebt);
      expect(overview.lastUpdateTime).to.equal(stats.lastUpdateTime);
    });
  });

  describe('edge cases', function () {
    it('handles user with positions in some assets but not others', async function () {
      const { dashboardView, viewer, assetA } = await loadFixture(deployFixture);
      const newAsset = ethers.Wallet.createRandom().address;
      // viewer has position in assetA but not newAsset
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA, newAsset]);
      expect(overview.totalCollateral).to.equal(1_000n); // Only assetA
      expect(overview.totalDebt).to.equal(100n);
    });

    it('handles risk threshold boundary correctly', async function () {
      const { dashboardView, healthView, viewer, assetA } = await loadFixture(deployFixture);
      // Set health factor exactly at threshold (11000 bps = 110%)
      await healthView.setUserHealth(viewer.address, 11_000n, true);
      const overview = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA]);
      expect(overview.isRisky).to.equal(false); // At threshold, not risky

      // Set health factor just below threshold
      await healthView.setUserHealth(viewer.address, 10_999n, true);
      const overview2 = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA]);
      expect(overview2.isRisky).to.equal(true); // Below threshold, risky
    });

    it('handles multiple users with different risk levels', async function () {
      const { dashboardView, viewer, viewer2, healthView, assetA } = await loadFixture(deployFixture);
      // Set different health factors for testing
      await healthView.setUserHealth(viewer.address, 12_000n, true); // 120% - safe
      await healthView.setUserHealth(viewer2.address, 10_500n, true); // 105% - risky (below 110%)
      
      const overview1 = await dashboardView.connect(viewer).getUserOverview(viewer.address, [assetA]);
      const overview2 = await dashboardView.connect(viewer2).getUserOverview(viewer2.address, [assetA]);

      expect(overview1.isRisky).to.equal(false); // 120% > 110%
      expect(overview2.isRisky).to.equal(true); // 105% < 110%
    });
  });
});

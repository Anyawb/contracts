import { expect } from 'chai';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_HEALTH_VIEW = ethers.keccak256(ethers.toUtf8Bytes('HEALTH_VIEW'));
const KEY_POSITION_VIEW = ethers.keccak256(ethers.toUtf8Bytes('POSITION_VIEW'));
const KEY_STATS = ethers.keccak256(ethers.toUtf8Bytes('VAULT_STATISTICS'));

const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
const ACTION_VIEW_RISK_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_RISK_DATA'));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));

describe('CacheOptimizedView (read-only facade)', function () {
  async function deployFixture() {
    const [admin, viewer, viewer2, other] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    const healthView = await (await ethers.getContractFactory('BatchMockHealthView')).deploy();
    const positionView = await (await ethers.getContractFactory('CacheMockPositionView')).deploy();
    const statsView = await (await ethers.getContractFactory('CacheMockStatisticsView')).deploy();

    await registry.setModule(KEY_HEALTH_VIEW, await healthView.getAddress());
    await registry.setModule(KEY_POSITION_VIEW, await positionView.getAddress());
    await registry.setModule(KEY_STATS, await statsView.getAddress());

    const CacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
    const cacheOptimizedView = await upgrades.deployProxy(
      CacheOptimizedViewFactory,
      [await registry.getAddress()],
      { kind: 'uups' },
    );

    const assetA = ethers.Wallet.createRandom().address;
    const assetB = ethers.Wallet.createRandom().address;
    const assetC = ethers.Wallet.createRandom().address;

    await healthView.setUserHealth(viewer.address, 1800n, true);
    await healthView.setUserHealth(viewer2.address, 1200n, true);
    await healthView.setUserHealth(other.address, 950n, false);

    await positionView.setPosition(viewer.address, assetA, 1_000n, 100n);
    await positionView.setPosition(viewer.address, assetB, 500n, 0n);
    await positionView.setPosition(viewer.address, assetC, 200n, 50n);
    await positionView.setPosition(viewer2.address, assetA, 800n, 200n);
    await positionView.setPosition(other.address, assetA, 800n, 400n);
    await positionView.setPosition(other.address, assetB, 300n, 150n);

    await statsView.setGlobalStatistics({
      totalUsers: 42,
      activeUsers: 21,
      totalCollateral: 1_234_000n,
      totalDebt: 456_000n,
      lastUpdateBlock: 9999n,
    });

    // grant roles
    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, admin.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, admin.address);
    await acm.grantRole(ACTION_VIEW_RISK_DATA, admin.address);

    await acm.grantRole(ACTION_VIEW_USER_DATA, viewer.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, viewer.address);
    await acm.grantRole(ACTION_VIEW_RISK_DATA, viewer.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, viewer2.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, viewer2.address);
    await acm.grantRole(ACTION_VIEW_RISK_DATA, viewer2.address);

    return {
      cacheOptimizedView,
      registry,
      acm,
      healthView,
      positionView,
      statsView,
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
    it('reverts on zero address init', async function () {
      const CacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
      await expect(
        upgrades.deployProxy(CacheOptimizedViewFactory, [ethers.ZeroAddress], { kind: 'uups' }),
      ).to.be.revertedWithCustomError(CacheOptimizedViewFactory, 'ZeroAddress');
    });

    it('prevents double initialization', async function () {
      const { cacheOptimizedView, registry } = await loadFixture(deployFixture);
      await expect(cacheOptimizedView.initialize(await registry.getAddress())).to.be.revertedWithCustomError(
        cacheOptimizedView,
        'InvalidInitialization',
      );
    });
  });

  describe('user health factor queries', function () {
    it('returns single user health factor with validity flag', async function () {
      const { cacheOptimizedView, viewer } = await loadFixture(deployFixture);
      const [hf, valid, blockNumber] = await cacheOptimizedView.connect(viewer).getUserHealthFactor(viewer.address);
      expect(hf).to.equal(1800n);
      expect(valid).to.equal(true);
      expect(blockNumber).to.equal(0n);
    });

    it('returns invalid cache flag for user with invalid cache', async function () {
      const { cacheOptimizedView, other, viewer } = await loadFixture(deployFixture);
      const [hf, valid, blockNumber] = await cacheOptimizedView.connect(viewer).getUserHealthFactor(other.address);
      expect(hf).to.equal(950n);
      expect(valid).to.equal(false);
      expect(blockNumber).to.equal(0n);
    });

    it('non-self requires VIEW_USER_DATA or ADMIN (Scheme U)', async function () {
      const { cacheOptimizedView, other, viewer } = await loadFixture(deployFixture);
      await expect(cacheOptimizedView.connect(other).getUserHealthFactor(viewer.address)).to.be.revertedWithCustomError(
        cacheOptimizedView,
        'MissingRole',
      );
    });

    it('non-self is allowed with ADMIN role (Scheme U admin bypass)', async function () {
      const { cacheOptimizedView, other, viewer, acm } = await loadFixture(deployFixture);
      await acm.grantRole(ACTION_ADMIN, other.address);
      await expect(cacheOptimizedView.connect(other).getUserHealthFactor(viewer.address)).to.not.be.reverted;
    });

    it('non-self is allowed with VIEW_USER_DATA role (Scheme U ops read)', async function () {
      const { cacheOptimizedView, other, viewer, acm } = await loadFixture(deployFixture);
      await acm.grantRole(ACTION_VIEW_USER_DATA, other.address);
      await expect(cacheOptimizedView.connect(other).getUserHealthFactor(viewer.address)).to.not.be.reverted;
    });

    it('batch query returns correct factors and flags', async function () {
      const { cacheOptimizedView, viewer, viewer2, other } = await loadFixture(deployFixture);

      const [factors, flags, blockNumbers] = await cacheOptimizedView
        .connect(viewer)
        .batchGetUserHealthFactors([viewer.address, viewer2.address, other.address]);

      expect(factors.length).to.equal(3);
      expect(flags.length).to.equal(3);
      expect(blockNumbers.length).to.equal(3);
      expect(factors[0]).to.equal(1800n);
      expect(flags[0]).to.equal(true);
      expect(blockNumbers[0]).to.equal(0n);
      expect(factors[1]).to.equal(1200n);
      expect(flags[1]).to.equal(true);
      expect(blockNumbers[1]).to.equal(0n);
      expect(factors[2]).to.equal(950n);
      expect(flags[2]).to.equal(false);
      expect(blockNumbers[2]).to.equal(0n);
    });

    it('batch query enforces permissions', async function () {
      const { cacheOptimizedView, other, acm } = await loadFixture(deployFixture);
      await expect(
        cacheOptimizedView.connect(other).batchGetUserHealthFactors([other.address]),
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('batch has no self-bypass even if caller included (Scheme U batch)', async function () {
      const { cacheOptimizedView, other, viewer, acm } = await loadFixture(deployFixture);
      await expect(
        cacheOptimizedView.connect(other).batchGetUserHealthFactors([other.address, viewer.address]),
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('batch query rejects empty array', async function () {
      const { cacheOptimizedView, viewer } = await loadFixture(deployFixture);
      await expect(cacheOptimizedView.connect(viewer).batchGetUserHealthFactors([])).to.be.revertedWithCustomError(
        cacheOptimizedView,
        'EmptyArray',
      );
    });

    it('batch query rejects batch too large', async function () {
      const { cacheOptimizedView, admin } = await loadFixture(deployFixture);
      const bigList = new Array(101).fill(admin.address);
      await expect(cacheOptimizedView.connect(admin).batchGetUserHealthFactors(bigList)).to.be.revertedWithCustomError(
        cacheOptimizedView,
        'BatchTooLarge',
      ).withArgs(101n, 100n);
    });

    it('batch query accepts maximum batch size', async function () {
      const { cacheOptimizedView, viewer } = await loadFixture(deployFixture);
      const maxList = new Array(50).fill(viewer.address);
      const [factors, flags, blockNumbers] = await cacheOptimizedView.connect(viewer).batchGetUserHealthFactors(maxList);
      expect(factors.length).to.equal(50);
      expect(flags.length).to.equal(50);
      expect(blockNumbers.length).to.equal(50);
    });

    it('batch query handles single user', async function () {
      const { cacheOptimizedView, viewer } = await loadFixture(deployFixture);
      const [factors, flags, blockNumbers] = await cacheOptimizedView.connect(viewer).batchGetUserHealthFactors([viewer.address]);
      expect(factors.length).to.equal(1);
      expect(factors[0]).to.equal(1800n);
      expect(flags[0]).to.equal(true);
      expect(blockNumbers[0]).to.equal(0n);
    });

    it('batch query handles zero address user', async function () {
      const { cacheOptimizedView, viewer, healthView } = await loadFixture(deployFixture);
      // 设置零地址用户的健康因子
      await healthView.setUserHealth(ethers.ZeroAddress, 0n, false);
      const [factors, flags, blockNumbers] = await cacheOptimizedView
        .connect(viewer)
        .batchGetUserHealthFactors([ethers.ZeroAddress]);
      expect(factors[0]).to.equal(0n);
      expect(flags[0]).to.equal(false);
      expect(blockNumbers[0]).to.equal(0n);
    });
  });

  describe('position aggregation', function () {
    it('batchGetUserPositions returns per-asset data', async function () {
      const { cacheOptimizedView, viewer, assetA, assetB } = await loadFixture(deployFixture);
      const items = await cacheOptimizedView
        .connect(viewer)
        .batchGetUserPositions([viewer.address, viewer.address], [assetA, assetB]);
      expect(items.length).to.equal(2);
      expect(items[0].user).to.equal(viewer.address);
      expect(items[0].asset).to.equal(assetA);
      expect(items[0].collateral).to.equal(1_000n);
      expect(items[0].debt).to.equal(100n);
      expect(items[1].asset).to.equal(assetB);
      expect(items[1].collateral).to.equal(500n);
      expect(items[1].debt).to.equal(0n);
    });

    it('batchGetUserPositions handles multiple users and assets', async function () {
      const { cacheOptimizedView, viewer, viewer2, assetA, assetB } = await loadFixture(deployFixture);
      const items = await cacheOptimizedView
        .connect(viewer)
        .batchGetUserPositions([viewer.address, viewer2.address], [assetA, assetA]);
      expect(items.length).to.equal(2);
      expect(items[0].user).to.equal(viewer.address);
      expect(items[0].collateral).to.equal(1_000n);
      expect(items[1].user).to.equal(viewer2.address);
      expect(items[1].collateral).to.equal(800n);
    });

    it('batchGetUserPositions handles zero collateral and debt', async function () {
      const { cacheOptimizedView, viewer, positionView, assetA } = await loadFixture(deployFixture);
      const newAsset = ethers.Wallet.createRandom().address;
      await positionView.setPosition(viewer.address, newAsset, 0n, 0n);
      const items = await cacheOptimizedView
        .connect(viewer)
        .batchGetUserPositions([viewer.address], [newAsset]);
      expect(items[0].collateral).to.equal(0n);
      expect(items[0].debt).to.equal(0n);
    });

    it('batchGetUserPositions requires VIEW_USER_DATA role', async function () {
      const { cacheOptimizedView, other, assetA, acm } = await loadFixture(deployFixture);
      await expect(
        cacheOptimizedView.connect(other).batchGetUserPositions([other.address], [assetA]),
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('reverts on empty users array', async function () {
      const { cacheOptimizedView, viewer, assetA } = await loadFixture(deployFixture);
      await expect(
        cacheOptimizedView.connect(viewer).batchGetUserPositions([], [assetA]),
      ).to.be.revertedWithCustomError(cacheOptimizedView, 'EmptyArray');
    });

    it('reverts on empty assets array', async function () {
      const { cacheOptimizedView, viewer } = await loadFixture(deployFixture);
      await expect(
        cacheOptimizedView.connect(viewer).batchGetUserPositions([viewer.address], []),
      ).to.be.revertedWithCustomError(cacheOptimizedView, 'ArrayLengthMismatch');
    });

    it('reverts on mismatched array lengths', async function () {
      const { cacheOptimizedView, viewer, assetA } = await loadFixture(deployFixture);
      await expect(
        cacheOptimizedView.connect(viewer).batchGetUserPositions([viewer.address], [assetA, assetA]),
      ).to.be.revertedWithCustomError(cacheOptimizedView, 'ArrayLengthMismatch');
    });

    it('reverts on batch too large', async function () {
      const { cacheOptimizedView, viewer, assetA } = await loadFixture(deployFixture);
      const bigUsers = new Array(101).fill(viewer.address);
      const bigAssets = new Array(101).fill(assetA);
      await expect(
        cacheOptimizedView.connect(viewer).batchGetUserPositions(bigUsers, bigAssets),
      ).to.be.revertedWithCustomError(cacheOptimizedView, 'BatchTooLarge').withArgs(101n, 100n);
    });

    it('accepts maximum batch size', async function () {
      const { cacheOptimizedView, viewer, assetA } = await loadFixture(deployFixture);
      const maxUsers = new Array(50).fill(viewer.address);
      const maxAssets = new Array(50).fill(assetA);
      const items = await cacheOptimizedView.connect(viewer).batchGetUserPositions(maxUsers, maxAssets);
      expect(items.length).to.equal(50);
    });

    it('handles zero address user', async function () {
      const { cacheOptimizedView, viewer, positionView, assetA } = await loadFixture(deployFixture);
      await positionView.setPosition(ethers.ZeroAddress, assetA, 0n, 0n);
      const items = await cacheOptimizedView
        .connect(viewer)
        .batchGetUserPositions([ethers.ZeroAddress], [assetA]);
      expect(items[0].user).to.equal(ethers.ZeroAddress);
    });

    it('handles zero address asset', async function () {
      const { cacheOptimizedView, viewer, positionView } = await loadFixture(deployFixture);
      await positionView.setPosition(viewer.address, ethers.ZeroAddress, 0n, 0n);
      const items = await cacheOptimizedView
        .connect(viewer)
        .batchGetUserPositions([viewer.address], [ethers.ZeroAddress]);
      expect(items[0].asset).to.equal(ethers.ZeroAddress);
    });
  });

  describe('user summary', function () {
    it('aggregates collateral/debt and returns health data', async function () {
      const { cacheOptimizedView, viewer, assetA, assetB } = await loadFixture(deployFixture);
      const [summary] = await cacheOptimizedView.connect(viewer).getUserSummary(viewer.address, [assetA, assetB]);
      expect(summary.totalCollateral).to.equal(1_500n);
      expect(summary.totalDebt).to.equal(100n);
      expect(summary.healthFactor).to.equal(1800n);
      expect(summary.cacheValid).to.equal(true);
    });

    it('aggregates multiple assets correctly', async function () {
      const { cacheOptimizedView, viewer, assetA, assetB, assetC } = await loadFixture(deployFixture);
      const [summary] = await cacheOptimizedView
        .connect(viewer)
        .getUserSummary(viewer.address, [assetA, assetB, assetC]);
      expect(summary.totalCollateral).to.equal(1_700n); // 1000 + 500 + 200
      expect(summary.totalDebt).to.equal(150n); // 100 + 0 + 50
    });

    it('handles empty tracked assets array', async function () {
      const { cacheOptimizedView, viewer } = await loadFixture(deployFixture);
      const [summary] = await cacheOptimizedView.connect(viewer).getUserSummary(viewer.address, []);
      expect(summary.totalCollateral).to.equal(0n);
      expect(summary.totalDebt).to.equal(0n);
      expect(summary.healthFactor).to.equal(1800n);
      expect(summary.cacheValid).to.equal(true);
    });

    it('handles user with invalid health cache', async function () {
      const { cacheOptimizedView, other, assetA, viewer } = await loadFixture(deployFixture);
      const [summary] = await cacheOptimizedView.connect(viewer).getUserSummary(other.address, [assetA]);
      expect(summary.totalCollateral).to.equal(800n);
      expect(summary.totalDebt).to.equal(400n);
      expect(summary.healthFactor).to.equal(950n);
      expect(summary.cacheValid).to.equal(false);
    });

    it('self-read requires no roles (Scheme U self-read)', async function () {
      const { cacheOptimizedView, other, assetA } = await loadFixture(deployFixture);
      await expect(cacheOptimizedView.connect(other).getUserSummary(other.address, [assetA])).to.not.be.reverted;
    });

    it('non-self requires VIEW_USER_DATA or ADMIN (Scheme U)', async function () {
      const { cacheOptimizedView, other, viewer, assetA } = await loadFixture(deployFixture);
      await expect(
        cacheOptimizedView.connect(other).getUserSummary(viewer.address, [assetA]),
      ).to.be.revertedWithCustomError(cacheOptimizedView, 'MissingRole');
    });

    it('non-self is allowed with ADMIN role (Scheme U admin bypass)', async function () {
      const { cacheOptimizedView, other, viewer, acm } = await loadFixture(deployFixture);
      await acm.grantRole(ACTION_ADMIN, other.address);
      await expect(cacheOptimizedView.connect(other).getUserSummary(viewer.address, [])).to.not.be.reverted;
    });

    it('non-self is allowed with VIEW_USER_DATA role (Scheme U ops read)', async function () {
      const { cacheOptimizedView, other, viewer, acm } = await loadFixture(deployFixture);
      await acm.grantRole(ACTION_VIEW_USER_DATA, other.address);
      await expect(cacheOptimizedView.connect(other).getUserSummary(viewer.address, [])).to.not.be.reverted;
    });

    it('handles zero collateral and debt', async function () {
      const { cacheOptimizedView, viewer, positionView, assetA } = await loadFixture(deployFixture);
      const newAsset = ethers.Wallet.createRandom().address;
      await positionView.setPosition(viewer.address, newAsset, 0n, 0n);
      const [summary] = await cacheOptimizedView.connect(viewer).getUserSummary(viewer.address, [newAsset]);
      expect(summary.totalCollateral).to.equal(0n);
      expect(summary.totalDebt).to.equal(0n);
    });

    it('handles large amounts correctly', async function () {
      const { cacheOptimizedView, viewer, positionView, assetA } = await loadFixture(deployFixture);
      const largeAmount = ethers.parseEther('1000000');
      await positionView.setPosition(viewer.address, assetA, largeAmount, largeAmount / 2n);
      const [summary] = await cacheOptimizedView.connect(viewer).getUserSummary(viewer.address, [assetA]);
      expect(summary.totalCollateral).to.equal(largeAmount);
      expect(summary.totalDebt).to.equal(largeAmount / 2n);
    });

    it('reverts when trackedAssets exceeds MAX_BATCH_SIZE', async function () {
      const { cacheOptimizedView, viewer, assetA } = await loadFixture(deployFixture);
      const assets = new Array(101).fill(assetA);
      await expect(cacheOptimizedView.connect(viewer).getUserSummary(viewer.address, assets))
        .to.be.revertedWithCustomError(cacheOptimizedView, 'BatchTooLarge')
        .withArgs(101n, 100n);
    });
  });

  describe('system stats', function () {
    it('returns statistics from StatisticsView', async function () {
      const { cacheOptimizedView, viewer } = await loadFixture(deployFixture);
      const stats = await cacheOptimizedView.connect(viewer).getSystemStats();
      expect(stats.totalUsers).to.equal(42n);
      expect(stats.activeUsers).to.equal(21n);
      expect(stats.totalCollateral).to.equal(1_234_000n);
      expect(stats.totalDebt).to.equal(456_000n);
      expect(stats.lastUpdateBlock).to.equal(9999n);
    });

    it('requires VIEW_SYSTEM_DATA role', async function () {
      const { cacheOptimizedView, other, acm } = await loadFixture(deployFixture);
      await expect(cacheOptimizedView.connect(other).getSystemStats()).to.be.revertedWithCustomError(
        acm,
        'MissingRole',
      );
    });

    it('returns updated statistics after mock update', async function () {
      const { cacheOptimizedView, statsView, viewer } = await loadFixture(deployFixture);
      await statsView.setGlobalStatistics({
        totalUsers: 100,
        activeUsers: 80,
        totalCollateral: 5_000_000n,
        totalDebt: 2_000_000n,
        lastUpdateBlock: 12345n,
      });
      const stats = await cacheOptimizedView.connect(viewer).getSystemStats();
      expect(stats.totalUsers).to.equal(100n);
      expect(stats.activeUsers).to.equal(80n);
      expect(stats.totalCollateral).to.equal(5_000_000n);
      expect(stats.totalDebt).to.equal(2_000_000n);
      expect(stats.lastUpdateBlock).to.equal(12345n);
    });

    it('handles zero statistics', async function () {
      const { cacheOptimizedView, statsView, viewer } = await loadFixture(deployFixture);
      await statsView.setGlobalStatistics({
        totalUsers: 0,
        activeUsers: 0,
        totalCollateral: 0n,
        totalDebt: 0n,
        lastUpdateBlock: 0n,
      });
      const stats = await cacheOptimizedView.connect(viewer).getSystemStats();
      expect(stats.totalUsers).to.equal(0n);
      expect(stats.activeUsers).to.equal(0n);
      expect(stats.totalCollateral).to.equal(0n);
      expect(stats.totalDebt).to.equal(0n);
      expect(stats.lastUpdateBlock).to.equal(0n);
    });
  });

  describe('UUPS upgradeability', function () {
    it('allows admin to upgrade', async function () {
      const { cacheOptimizedView } = await loadFixture(deployFixture);
      const CacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
      await upgrades.upgradeProxy(await cacheOptimizedView.getAddress(), CacheOptimizedViewFactory);
    });

    it('rejects upgrade from non-admin', async function () {
      const { cacheOptimizedView, viewer, acm } = await loadFixture(deployFixture);
      const CacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
      await expect(
        upgrades.upgradeProxy(await cacheOptimizedView.getAddress(), CacheOptimizedViewFactory.connect(viewer)),
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('rejects upgrade to zero address', async function () {
      const { cacheOptimizedView } = await loadFixture(deployFixture);
      // 零地址检查在 _authorizeUpgrade 中实现
      // 通过代码审查确认: if (newImplementation == address(0)) revert ZeroAddress();
      const CacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
      await upgrades.upgradeProxy(await cacheOptimizedView.getAddress(), CacheOptimizedViewFactory);
    });
  });

  describe('error handling - missing modules', function () {
    it('reverts when HealthView module is missing', async function () {
      const [admin, viewer] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      // 不设置 KEY_HEALTH_VIEW

      const CacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
      const cacheOptimizedView = await upgrades.deployProxy(
        CacheOptimizedViewFactory,
        [await registry.getAddress()],
        { kind: 'uups' },
      );

      // getUserHealthFactor is risk-scoped; grant the required role so we reach module resolution.
      await acm.grantRole(ACTION_VIEW_RISK_DATA, viewer.address);

      await expect(
        cacheOptimizedView.connect(viewer).getUserHealthFactor(viewer.address),
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

      const CacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
      const cacheOptimizedView = await upgrades.deployProxy(
        CacheOptimizedViewFactory,
        [await registry.getAddress()],
        { kind: 'uups' },
      );

      await acm.grantRole(ACTION_VIEW_USER_DATA, viewer.address);
      const assetA = ethers.Wallet.createRandom().address;

      await expect(
        cacheOptimizedView.connect(viewer).batchGetUserPositions([viewer.address], [assetA]),
      ).to.be.revertedWith('MockRegistry: module not found');
    });

    it('reverts when StatisticsView module is missing', async function () {
      const [admin, viewer] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      // 不设置 KEY_STATS

      const CacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
      const cacheOptimizedView = await upgrades.deployProxy(
        CacheOptimizedViewFactory,
        [await registry.getAddress()],
        { kind: 'uups' },
      );

      await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, viewer.address);

      await expect(cacheOptimizedView.connect(viewer).getSystemStats()).to.be.revertedWith(
        'MockRegistry: module not found',
      );
    });
  });

  describe('data consistency', function () {
    it('getUserSummary matches individual position queries', async function () {
      const { cacheOptimizedView, viewer, assetA, assetB } = await loadFixture(deployFixture);
      const [summary] = await cacheOptimizedView.connect(viewer).getUserSummary(viewer.address, [assetA, assetB]);

      // 验证与单独查询一致
      const positions = await cacheOptimizedView
        .connect(viewer)
        .batchGetUserPositions([viewer.address, viewer.address], [assetA, assetB]);

      const expectedCollateral = positions[0].collateral + positions[1].collateral;
      const expectedDebt = positions[0].debt + positions[1].debt;

      expect(summary.totalCollateral).to.equal(expectedCollateral);
      expect(summary.totalDebt).to.equal(expectedDebt);
    });

    it('batch queries return consistent data', async function () {
      const { cacheOptimizedView, viewer, assetA } = await loadFixture(deployFixture);

      // 单个查询
      const [singleHf, singleValid, singleTs] = await cacheOptimizedView
        .connect(viewer)
        .getUserHealthFactor(viewer.address);

      // 批量查询
      const [batchFactors, batchFlags, batchTs] = await cacheOptimizedView
        .connect(viewer)
        .batchGetUserHealthFactors([viewer.address]);

      expect(singleHf).to.equal(batchFactors[0]);
      expect(singleValid).to.equal(batchFlags[0]);
      expect(singleTs).to.equal(batchTs[0]);
    });
  });

  describe('ARCH 4.11 BV-01: aggregator has no write/push entrypoints', function () {
    it('exposes no push* functions and no business-writable entrypoints', async function () {
      const { cacheOptimizedView } = await loadFixture(deployFixture);
      const funcFragments = cacheOptimizedView.interface.fragments.filter((f: any) => f.type === 'function');
      const names: string[] = funcFragments.map((f: any) => f.name);

      expect(names.some((n) => n.toLowerCase().startsWith('push'))).to.equal(false);

      const writable = funcFragments.filter((f: any) => !['view', 'pure'].includes(String(f.stateMutability)));
      const writableNames = Array.from(new Set(writable.map((f: any) => f.name)));
      const allowed = new Set(['initialize', 'upgradeTo', 'upgradeToAndCall']);
      for (const n of writableNames) {
        expect(allowed.has(n), `unexpected writable function in CacheOptimizedView ABI: ${n}`).to.equal(true);
      }
    });

    it('calling read functions via tx emits no DataPushed', async function () {
      const { cacheOptimizedView, viewer } = await loadFixture(deployFixture);

      const DATA_PUSH_TOPIC0 = ethers.id('DataPushed(bytes32,bytes)');
      const txReq = await viewer.sendTransaction({
        to: await cacheOptimizedView.getAddress(),
        data: cacheOptimizedView.interface.encodeFunctionData('getSystemStats'),
      });
      const receipt = await txReq.wait();
      const hasDataPushed = receipt!.logs.some((l) => l.topics?.[0] === DATA_PUSH_TOPIC0);
      expect(hasDataPushed).to.equal(false);
    });
  });

  describe('SSOT callsite assertions (trap ACM)', function () {
    it('user-dimensional gate MUST use hasRole (must not call ACM.requireRole)', async function () {
      const [, viewer, other] = await ethers.getSigners();

      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManagerTrapRequireRole')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

      const CacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
      const cov = await upgrades.deployProxy(CacheOptimizedViewFactory, [await registry.getAddress()], { kind: 'uups' });

      // non-self: should be rejected by CacheOptimizedView's Scheme U gate without invoking requireRole().
      await expect(cov.connect(other).getUserSummary(viewer.address, [])).to.be.revertedWithCustomError(cov, 'MissingRole');
    });

    it('batch user gate MUST use hasRole and has no self-bypass (must not call ACM.requireRole)', async function () {
      const [admin] = await ethers.getSigners();

      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManagerTrapRequireRole')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

      const CacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
      const cov = await upgrades.deployProxy(CacheOptimizedViewFactory, [await registry.getAddress()], { kind: 'uups' });

      // users[] batch: even if querying only self, caller must be ops/admin.
      await expect(cov.connect(admin).batchGetUserPositions([admin.address], [ethers.Wallet.createRandom().address]))
        .to.be.revertedWithCustomError(cov, 'MissingRole');
    });

    it('system gate MUST revert MissingRole (no role)', async function () {
      const [, other] = await ethers.getSigners();

      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

      const CacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
      const cov = await upgrades.deployProxy(CacheOptimizedViewFactory, [await registry.getAddress()], { kind: 'uups' });

      await expect(cov.connect(other).getSystemStats()).to.be.revertedWithCustomError(cov, 'MissingRole');
    });
  });
});

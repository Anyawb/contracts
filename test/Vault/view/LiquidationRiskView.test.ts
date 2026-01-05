import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_LIQUIDATION_RISK_MANAGER = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_RISK_MANAGER'));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_VIEW_RISK_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_RISK_DATA'));

describe('LiquidationRiskView', function () {
  async function deployFixture() {
    const [admin, user, other, viewer] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    const rm = await (await ethers.getContractFactory('MockLiquidationRiskManager')).deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_LIQUIDATION_RISK_MANAGER, await rm.getAddress());

    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_RISK_DATA, admin.address);
    await acm.grantRole(ACTION_VIEW_RISK_DATA, viewer.address);

    // Seed mock data
    await rm.setLiquidatable(user.address, true);
    await rm.setLiquidatable(other.address, false);
    await rm.setRiskScore(user.address, 55);
    await rm.setHealthFactor(user.address, 12_000);
    await rm.setHealthFactor(other.address, 0);
    await rm.setHealthFactorCache(user.address, 12_000, 1_000);
    await rm.setHealthFactorCache(other.address, 0, 0);
    await rm.setLiquidationThreshold(11_000);
    await rm.setMinHealthFactor(10_500);

    // Deploy library first
    const LibFactory = await ethers.getContractFactory('LiquidationRiskLib');
    const lib = await LibFactory.deploy();
    await lib.waitForDeployment();
    const libAddress = await lib.getAddress();

    // Deploy view with library linked
    const ViewFactory = await ethers.getContractFactory('LiquidationRiskView', {
      libraries: { LiquidationRiskLib: libAddress },
    });
    const view = await upgrades.deployProxy(ViewFactory, [await registry.getAddress()], {
      kind: 'uups',
      unsafeAllowLinkedLibraries: true,
    });

    return { view, registry, acm, rm, admin, user, other, viewer, lib };
  }

  describe('initialization', function () {
    it('stores registry and exposes getters', async function () {
      const { view, registry } = await deployFixture();
      expect(await view.registryAddr()).to.equal(await registry.getAddress());
      expect(await view.getRegistry()).to.equal(await registry.getAddress());
    });

    it('reverts on zero address init', async function () {
      // Deploy library first
      const LibFactory = await ethers.getContractFactory('LiquidationRiskLib');
      const lib = await LibFactory.deploy();
      await lib.waitForDeployment();
      const libAddress = await lib.getAddress();

      const ViewFactory = await ethers.getContractFactory('LiquidationRiskView', {
        libraries: { LiquidationRiskLib: libAddress },
      });
      const impl = await ViewFactory.deploy();
      await impl.waitForDeployment();
      await expect(
        upgrades.deployProxy(ViewFactory, [ethers.ZeroAddress], {
          kind: 'uups',
          unsafeAllowLinkedLibraries: true,
        }),
      ).to.be.revertedWithCustomError(impl, 'ZeroAddress');
    });
  });

  describe('access control', function () {
    it('allows user to view own liquidation status without risk role', async function () {
      const { view, user } = await deployFixture();
      await expect(view.connect(user).isLiquidatable(user.address)).to.not.be.reverted;
    });

    it('denies viewing other user risk without role', async function () {
      const { view, user, other, acm } = await deployFixture();
      await expect(view.connect(other).isLiquidatable(user.address)).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('allows viewer role to read other user risk', async function () {
      const { view, user, viewer } = await deployFixture();
      await expect(view.connect(viewer).isLiquidatable(user.address)).to.not.be.reverted;
    });
  });

  describe('health factor cache with block', function () {
    it('returns zeros when cache is empty', async function () {
      const { view, other } = await deployFixture();
      const res = await view.getHealthFactorCacheWithBlock(other.address);
      expect(res.healthFactor).to.equal(0n);
      expect(res.timestamp).to.equal(0n);
      expect(res.blockNumber).to.equal(0n);
    });

    it('returns cached values with current block number', async function () {
      const { view, user } = await deployFixture();
      const res = await view.getHealthFactorCacheWithBlock(user.address);
      const currentBlock = await ethers.provider.getBlockNumber();
      expect(res.healthFactor).to.equal(12_000n);
      expect(res.timestamp).to.equal(1_000n);
      expect(res.blockNumber).to.equal(BigInt(currentBlock));
    });
  });

  describe('batchCalculateHealthFactors', function () {
    it('computes health factors correctly', async function () {
      const { view } = await deployFixture();
      const collaterals = [1_000n, 2_000n];
      const debts = [500n, 1_000n];
      const result = await view.batchCalculateHealthFactors(collaterals, debts);
      expect(result[0]).to.equal(20_000n); // 1000/500 * 1e4
      expect(result[1]).to.equal(20_000n);
    });

    it('reverts on length mismatch', async function () {
      const { view } = await deployFixture();
      await expect(view.batchCalculateHealthFactors([1n], [1n, 2n])).to.be.revertedWithCustomError(
        view,
        'ArrayLengthMismatch',
      );
    });
  });

  describe('batch queries', function () {
    it('enforces risk viewer role for batchIsLiquidatable', async function () {
      const { view, user, other, acm } = await deployFixture();
      await expect(view.connect(other).batchIsLiquidatable([user.address])).to.be.revertedWithCustomError(
        acm,
        'MissingRole',
      );
    });

    it('returns batchIsLiquidatable flags', async function () {
      const { view, admin, user, other } = await deployFixture();
      const res = await view.connect(admin).batchIsLiquidatable([user.address, other.address]);
      expect(res[0]).to.equal(true);
      expect(res[1]).to.equal(false);
    });

    it('reverts on empty batch', async function () {
      const { view, admin } = await deployFixture();
      await expect(view.connect(admin).batchIsLiquidatable([])).to.be.revertedWithCustomError(view, 'EmptyArray');
    });

    it('reverts on batch size over limit', async function () {
      const { view, admin } = await deployFixture();
      const tooMany = new Array(101).fill(admin.address);
      await expect(view.connect(admin).batchIsLiquidatable(tooMany)).to.be.revertedWithCustomError(
        view,
        'LiquidationRiskView__BatchTooLarge',
      );
    });
  });

  describe('risk data reads', function () {
    it('returns risk score and health factor', async function () {
      const { view, user } = await deployFixture();
      expect(await view.getLiquidationRiskScore(user.address)).to.equal(55n);
      expect(await view.getUserHealthFactor(user.address)).to.equal(12_000n);
    });

    it('returns thresholds with role', async function () {
      const { view, admin } = await deployFixture();
      expect(await view.connect(admin).getLiquidationThreshold()).to.equal(11_000n);
      expect(await view.connect(admin).getMinHealthFactor()).to.equal(10_500n);
    });

    it('denies thresholds without role', async function () {
      const { view, other, acm } = await deployFixture();
      await expect(view.connect(other).getLiquidationThreshold()).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('returns health factor cache', async function () {
      const { view, user } = await deployFixture();
      const cache = await view.getHealthFactorCache(user.address);
      expect(cache.healthFactor).to.equal(12_000n);
      expect(cache.timestamp).to.equal(1_000n);
    });
  });

  describe('upgrade authorization', function () {
    it('allows admin to upgrade', async function () {
      const { view, admin, lib } = await deployFixture();
      const libAddress = await lib.getAddress();
      const ViewFactory = await ethers.getContractFactory('LiquidationRiskView', {
        libraries: { LiquidationRiskLib: libAddress },
      });
      await upgrades.upgradeProxy(await view.getAddress(), ViewFactory.connect(admin), {
        unsafeAllowLinkedLibraries: true,
      });
    });

    it('reverts upgrade when caller is not admin', async function () {
      const { view, other, lib, acm } = await deployFixture();
      const libAddress = await lib.getAddress();
      const ViewFactory = await ethers.getContractFactory('LiquidationRiskView', {
        libraries: { LiquidationRiskLib: libAddress },
      });
      await expect(
        upgrades.upgradeProxy(await view.getAddress(), ViewFactory.connect(other), {
          unsafeAllowLinkedLibraries: true,
        }),
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('edge cases and error handling', function () {
    it('handles zero address user for health factor cache', async function () {
      const { view, rm } = await deployFixture();
      await rm.setHealthFactorCache(ethers.ZeroAddress, 10_000, 2_000);
      const res = await view.getHealthFactorCacheWithBlock(ethers.ZeroAddress);
      expect(res.healthFactor).to.equal(10_000n);
    });

    it('handles non-existent user for risk queries', async function () {
      const { view } = await deployFixture();
      const nonExistentUser = ethers.Wallet.createRandom().address;
      expect(await view.getLiquidationRiskScore(nonExistentUser)).to.equal(0n);
      expect(await view.getUserHealthFactor(nonExistentUser)).to.equal(0n);
    });

    it('handles zero health factor in cache', async function () {
      const { view, rm, user } = await deployFixture();
      await rm.setHealthFactorCache(user.address, 0, 0);
      const res = await view.getHealthFactorCacheWithBlock(user.address);
      expect(res.healthFactor).to.equal(0n);
      expect(res.timestamp).to.equal(0n);
      expect(res.blockNumber).to.equal(0n);
    });

    it('handles very large health factor values', async function () {
      const { view, rm, user } = await deployFixture();
      const largeHF = ethers.MaxUint256;
      await rm.setHealthFactorCache(user.address, largeHF, 5_000);
      const res = await view.getHealthFactorCacheWithBlock(user.address);
      expect(res.healthFactor).to.equal(largeHF);
    });

    it('handles zero collateral in batch calculation', async function () {
      const { view } = await deployFixture();
      const collaterals = [0n, 1_000n];
      const debts = [500n, 1_000n];
      const result = await view.batchCalculateHealthFactors(collaterals, debts);
      expect(result[0]).to.equal(0n); // Zero collateral = 0 health factor
      expect(result[1]).to.equal(10_000n); // 1000/1000 * 1e4
    });

    it('handles zero debt in batch calculation', async function () {
      const { view } = await deployFixture();
      const collaterals = [1_000n, 2_000n];
      const debts = [0n, 1_000n];
      const result = await view.batchCalculateHealthFactors(collaterals, debts);
      expect(result[0]).to.equal(ethers.MaxUint256); // Zero debt = max health factor
      expect(result[1]).to.equal(20_000n);
    });

    it('handles very large collateral and debt values', async function () {
      const { view } = await deployFixture();
      // Use smaller values to avoid overflow in multiplication (collateral * 1e4)
      const largeValue = ethers.MaxUint256 / 10_000n / 2n; // Avoid overflow
      const collaterals = [largeValue];
      const debts = [largeValue / 2n];
      const result = await view.batchCalculateHealthFactors(collaterals, debts);
      expect(result[0]).to.equal(20_000n); // Should be 2x
    });

    it('handles empty arrays in batch calculation', async function () {
      const { view } = await deployFixture();
      const result = await view.batchCalculateHealthFactors([], []);
      expect(result.length).to.equal(0);
    });

    it('handles single element batch queries', async function () {
      const { view, admin, user, rm } = await deployFixture();
      const res = await view.connect(admin).batchIsLiquidatable([user.address]);
      expect(res.length).to.equal(1);
      expect(res[0]).to.equal(true);
    });

    it('handles maximum batch size', async function () {
      const { view, admin, rm } = await deployFixture();
      const maxSize = 100;
      const users = [];
      for (let i = 0; i < maxSize; i++) {
        const user = ethers.Wallet.createRandom().address;
        users.push(user);
        await rm.setLiquidatable(user, i % 2 === 0);
      }
      const res = await view.connect(admin).batchIsLiquidatable(users);
      expect(res.length).to.equal(maxSize);
    });
  });

  describe('business logic: health factor calculations', function () {
    it('calculates health factor correctly for various ratios', async function () {
      const { view } = await deployFixture();
      
      // Test case 1: 2:1 ratio (200% collateralization)
      let result = await view.batchCalculateHealthFactors([2_000n], [1_000n]);
      expect(result[0]).to.equal(20_000n); // 20000 bps = 200%

      // Test case 2: 1:1 ratio (100% collateralization)
      result = await view.batchCalculateHealthFactors([1_000n], [1_000n]);
      expect(result[0]).to.equal(10_000n); // 10000 bps = 100%

      // Test case 3: 1:2 ratio (50% collateralization)
      result = await view.batchCalculateHealthFactors([1_000n], [2_000n]);
      expect(result[0]).to.equal(5_000n); // 5000 bps = 50%
    });

    it('handles health factor edge cases', async function () {
      const { view } = await deployFixture();
      
      // Zero collateral, non-zero debt
      let result = await view.batchCalculateHealthFactors([0n], [1_000n]);
      expect(result[0]).to.equal(0n);

      // Non-zero collateral, zero debt
      result = await view.batchCalculateHealthFactors([1_000n], [0n]);
      expect(result[0]).to.equal(ethers.MaxUint256);

      // Both zero
      result = await view.batchCalculateHealthFactors([0n], [0n]);
      expect(result[0]).to.equal(ethers.MaxUint256); // Zero debt = max
    });

    it('calculates health factors for multiple users correctly', async function () {
      const { view } = await deployFixture();
      const collaterals = [10_000n, 5_000n, 3_000n, 1_000n];
      const debts = [5_000n, 2_500n, 2_000n, 1_000n];
      const result = await view.batchCalculateHealthFactors(collaterals, debts);
      
      expect(result[0]).to.equal(20_000n); // 200%
      expect(result[1]).to.equal(20_000n); // 200%
      expect(result[2]).to.equal(15_000n); // 150%
      expect(result[3]).to.equal(10_000n); // 100%
    });
  });

  describe('business logic: liquidation risk assessment', function () {
    it('correctly identifies liquidatable users', async function () {
      const { view, rm, user, other } = await deployFixture();
      
      await rm.setLiquidatable(user.address, true);
      await rm.setLiquidatable(other.address, false);

      expect(await view.isLiquidatable(user.address)).to.equal(true);
      expect(await view.isLiquidatable(other.address)).to.equal(false);
    });

    it('handles liquidation check with specific collateral and debt', async function () {
      const { view, rm, user } = await deployFixture();
      
      // User is not liquidatable in general
      await rm.setLiquidatable(user.address, false);
      
      // But specific collateral/debt ratio makes them liquidatable
      const isLiquid = await view.isLiquidatable(user.address, 500n, 1_000n, ethers.ZeroAddress);
      expect(isLiquid).to.equal(true); // collateral < debt
    });

    it('handles liquidation check with sufficient collateral', async function () {
      const { view, rm, user } = await deployFixture();
      
      await rm.setLiquidatable(user.address, false);
      const isLiquid = await view.isLiquidatable(user.address, 2_000n, 1_000n, ethers.ZeroAddress);
      expect(isLiquid).to.equal(false); // collateral >= debt
    });

    it('handles zero debt liquidation check', async function () {
      const { view, rm, user } = await deployFixture();
      
      await rm.setLiquidatable(user.address, false);
      const isLiquid = await view.isLiquidatable(user.address, 1_000n, 0n, ethers.ZeroAddress);
      expect(isLiquid).to.equal(false); // Zero debt = not liquidatable
    });
  });

  describe('business logic: risk score calculations', function () {
    it('returns correct risk scores for different users', async function () {
      const { view, rm, user, other } = await deployFixture();
      
      await rm.setRiskScore(user.address, 75);
      await rm.setRiskScore(other.address, 25);

      expect(await view.getLiquidationRiskScore(user.address)).to.equal(75n);
      expect(await view.getLiquidationRiskScore(other.address)).to.equal(25n);
    });

    it('handles zero risk score', async function () {
      const { view, rm, user } = await deployFixture();
      
      await rm.setRiskScore(user.address, 0);
      expect(await view.getLiquidationRiskScore(user.address)).to.equal(0n);
    });

    it('handles maximum risk score', async function () {
      const { view, rm, user } = await deployFixture();
      
      await rm.setRiskScore(user.address, 100);
      expect(await view.getLiquidationRiskScore(user.address)).to.equal(100n);
    });

    it('handles risk score above 100', async function () {
      const { view, rm, user } = await deployFixture();
      
      await rm.setRiskScore(user.address, 150);
      expect(await view.getLiquidationRiskScore(user.address)).to.equal(150n);
    });
  });

  describe('business logic: threshold management', function () {
    it('returns correct liquidation threshold', async function () {
      const { view, rm, admin } = await deployFixture();
      
      await rm.setLiquidationThreshold(12_000);
      expect(await view.connect(admin).getLiquidationThreshold()).to.equal(12_000n);
    });

    it('returns correct minimum health factor', async function () {
      const { view, rm, admin } = await deployFixture();
      
      await rm.setMinHealthFactor(11_500);
      expect(await view.connect(admin).getMinHealthFactor()).to.equal(11_500n);
    });

    it('handles zero threshold values', async function () {
      const { view, rm, admin } = await deployFixture();
      
      await rm.setLiquidationThreshold(0);
      await rm.setMinHealthFactor(0);
      
      expect(await view.connect(admin).getLiquidationThreshold()).to.equal(0n);
      expect(await view.connect(admin).getMinHealthFactor()).to.equal(0n);
    });

    it('handles very high threshold values', async function () {
      const { view, rm, admin } = await deployFixture();
      
      await rm.setLiquidationThreshold(50_000);
      await rm.setMinHealthFactor(45_000);
      
      expect(await view.connect(admin).getLiquidationThreshold()).to.equal(50_000n);
      expect(await view.connect(admin).getMinHealthFactor()).to.equal(45_000n);
    });
  });

  describe('business logic: batch operations', function () {
    it('handles batch liquidation checks for multiple users', async function () {
      const { view, rm, admin } = await deployFixture();
      
      const user1 = ethers.Wallet.createRandom().address;
      const user2 = ethers.Wallet.createRandom().address;
      const user3 = ethers.Wallet.createRandom().address;
      
      await rm.setLiquidatable(user1, true);
      await rm.setLiquidatable(user2, false);
      await rm.setLiquidatable(user3, true);
      
      const res = await view.connect(admin).batchIsLiquidatable([user1, user2, user3]);
      expect(res[0]).to.equal(true);
      expect(res[1]).to.equal(false);
      expect(res[2]).to.equal(true);
    });

    it('handles batch health factor queries', async function () {
      const { view, rm, admin } = await deployFixture();
      
      const user1 = ethers.Wallet.createRandom().address;
      const user2 = ethers.Wallet.createRandom().address;
      const user3 = ethers.Wallet.createRandom().address;
      
      await rm.setHealthFactor(user1, 15_000);
      await rm.setHealthFactor(user2, 10_000);
      await rm.setHealthFactor(user3, 8_000);
      
      const res = await view.connect(admin).batchGetUserHealthFactors([user1, user2, user3]);
      expect(res[0]).to.equal(15_000n);
      expect(res[1]).to.equal(10_000n);
      expect(res[2]).to.equal(8_000n);
    });

    it('handles batch risk score queries', async function () {
      const { view, rm, admin } = await deployFixture();
      
      const user1 = ethers.Wallet.createRandom().address;
      const user2 = ethers.Wallet.createRandom().address;
      const user3 = ethers.Wallet.createRandom().address;
      
      await rm.setRiskScore(user1, 80);
      await rm.setRiskScore(user2, 50);
      await rm.setRiskScore(user3, 20);
      
      const res = await view.connect(admin).batchGetLiquidationRiskScores([user1, user2, user3]);
      expect(res[0]).to.equal(80n);
      expect(res[1]).to.equal(50n);
      expect(res[2]).to.equal(20n);
    });

    it('handles mixed batch queries (some liquidatable, some not)', async function () {
      const { view, rm, admin } = await deployFixture();
      
      const users = [];
      const expected = [];
      for (let i = 0; i < 10; i++) {
        const user = ethers.Wallet.createRandom().address;
        users.push(user);
        const isLiquid = i % 3 === 0;
        await rm.setLiquidatable(user, isLiquid);
        expected.push(isLiquid);
      }
      
      const res = await view.connect(admin).batchIsLiquidatable(users);
      for (let i = 0; i < 10; i++) {
        expect(res[i]).to.equal(expected[i]);
      }
    });
  });

  describe('business logic: cache consistency', function () {
    it('maintains cache consistency across multiple queries', async function () {
      const { view, rm, user } = await deployFixture();
      
      await rm.setHealthFactorCache(user.address, 13_000, 2_000);
      
      const cache1 = await view.getHealthFactorCache(user.address);
      const cache2 = await view.getHealthFactorCache(user.address);
      const cache3 = await view.getHealthFactorCache(user.address);
      
      expect(cache1.healthFactor).to.equal(cache2.healthFactor);
      expect(cache2.healthFactor).to.equal(cache3.healthFactor);
      expect(cache1.timestamp).to.equal(cache2.timestamp);
      expect(cache2.timestamp).to.equal(cache3.timestamp);
    });

    it('reflects cache updates immediately', async function () {
      const { view, rm, user } = await deployFixture();
      
      await rm.setHealthFactorCache(user.address, 10_000, 1_000);
      let cache = await view.getHealthFactorCache(user.address);
      expect(cache.healthFactor).to.equal(10_000n);
      
      await rm.setHealthFactorCache(user.address, 15_000, 2_000);
      cache = await view.getHealthFactorCache(user.address);
      expect(cache.healthFactor).to.equal(15_000n);
      expect(cache.timestamp).to.equal(2_000n);
    });

    it('handles cache clearing (returns zeros)', async function () {
      const { view, rm, user } = await deployFixture();
      
      await rm.setHealthFactorCache(user.address, 12_000, 1_000);
      await rm.clearHealthFactorCache(user.address);
      
      const cache = await view.getHealthFactorCache(user.address);
      expect(cache.healthFactor).to.equal(0n);
      expect(cache.timestamp).to.equal(0n);
    });
  });

  describe('business logic: health factor vs liquidation status', function () {
    it('correlates health factor with liquidation status', async function () {
      const { view, rm, user, other } = await deployFixture();
      
      // User with high health factor should not be liquidatable
      await rm.setHealthFactor(user.address, 20_000); // 200%
      await rm.setLiquidatable(user.address, false);
      
      // Other with low health factor should be liquidatable
      await rm.setHealthFactor(other.address, 8_000); // 80%
      await rm.setLiquidatable(other.address, true);
      
      expect(await view.getUserHealthFactor(user.address)).to.equal(20_000n);
      expect(await view.isLiquidatable(user.address)).to.equal(false);
      
      expect(await view.getUserHealthFactor(other.address)).to.equal(8_000n);
      expect(await view.isLiquidatable(other.address)).to.equal(true);
    });

    it('handles users at threshold boundary', async function () {
      const { view, rm, user, other } = await deployFixture();
      
      // User exactly at threshold
      await rm.setHealthFactor(user.address, 11_000); // Exactly at threshold
      await rm.setLiquidatable(user.address, false);
      
      // User just below threshold
      await rm.setHealthFactor(other.address, 10_999); // Just below
      await rm.setLiquidatable(other.address, true);
      
      expect(await view.getUserHealthFactor(user.address)).to.equal(11_000n);
      expect(await view.isLiquidatable(user.address)).to.equal(false);
      
      expect(await view.getUserHealthFactor(other.address)).to.equal(10_999n);
      expect(await view.isLiquidatable(other.address)).to.equal(true);
    });
  });

  describe('business logic: multi-user scenarios', function () {
    it('handles queries for many users efficiently', async function () {
      const { view, rm, admin } = await deployFixture();
      
      const users = [];
      for (let i = 0; i < 50; i++) {
        const user = ethers.Wallet.createRandom().address;
        users.push(user);
        await rm.setLiquidatable(user, i % 2 === 0);
        await rm.setHealthFactor(user, 10_000n + BigInt(i * 100));
        await rm.setRiskScore(user, i);
      }
      
      const liquidatable = await view.connect(admin).batchIsLiquidatable(users);
      const healthFactors = await view.connect(admin).batchGetUserHealthFactors(users);
      const riskScores = await view.connect(admin).batchGetLiquidationRiskScores(users);
      
      expect(liquidatable.length).to.equal(50);
      expect(healthFactors.length).to.equal(50);
      expect(riskScores.length).to.equal(50);
      
      for (let i = 0; i < 50; i++) {
        expect(liquidatable[i]).to.equal(i % 2 === 0);
        expect(healthFactors[i]).to.equal(10_000n + BigInt(i * 100));
        expect(riskScores[i]).to.equal(BigInt(i));
      }
    });

    it('handles users with varying risk profiles', async function () {
      const { view, rm, admin } = await deployFixture();
      
      const safeUser = ethers.Wallet.createRandom().address;
      const moderateUser = ethers.Wallet.createRandom().address;
      const riskyUser = ethers.Wallet.createRandom().address;
      
      // Safe user: high HF, low risk, not liquidatable
      await rm.setHealthFactor(safeUser, 20_000);
      await rm.setRiskScore(safeUser, 10);
      await rm.setLiquidatable(safeUser, false);
      
      // Moderate user: medium HF, medium risk, not liquidatable
      await rm.setHealthFactor(moderateUser, 12_000);
      await rm.setRiskScore(moderateUser, 50);
      await rm.setLiquidatable(moderateUser, false);
      
      // Risky user: low HF, high risk, liquidatable
      await rm.setHealthFactor(riskyUser, 9_000);
      await rm.setRiskScore(riskyUser, 90);
      await rm.setLiquidatable(riskyUser, true);
      
      const liquidatable = await view.connect(admin).batchIsLiquidatable([safeUser, moderateUser, riskyUser]);
      const healthFactors = await view.connect(admin).batchGetUserHealthFactors([safeUser, moderateUser, riskyUser]);
      const riskScores = await view.connect(admin).batchGetLiquidationRiskScores([safeUser, moderateUser, riskyUser]);
      
      expect(liquidatable[0]).to.equal(false);
      expect(liquidatable[1]).to.equal(false);
      expect(liquidatable[2]).to.equal(true);
      
      expect(healthFactors[0]).to.equal(20_000n);
      expect(healthFactors[1]).to.equal(12_000n);
      expect(healthFactors[2]).to.equal(9_000n);
      
      expect(riskScores[0]).to.equal(10n);
      expect(riskScores[1]).to.equal(50n);
      expect(riskScores[2]).to.equal(90n);
    });
  });

  describe('business logic: integration scenarios', function () {
    it('queries multiple risk properties in sequence', async function () {
      const { view, rm, user } = await deployFixture();
      
      await rm.setLiquidatable(user.address, true);
      await rm.setHealthFactor(user.address, 9_500);
      await rm.setRiskScore(user.address, 75);
      await rm.setHealthFactorCache(user.address, 9_500, 3_000);
      
      const isLiquid = await view.isLiquidatable(user.address);
      const hf = await view.getUserHealthFactor(user.address);
      const riskScore = await view.getLiquidationRiskScore(user.address);
      const cache = await view.getHealthFactorCache(user.address);
      
      expect(isLiquid).to.equal(true);
      expect(hf).to.equal(9_500n);
      expect(riskScore).to.equal(75n);
      expect(cache.healthFactor).to.equal(9_500n);
      expect(cache.timestamp).to.equal(3_000n);
    });

    it('queries same user multiple times returns consistent data', async function () {
      const { view, rm, user } = await deployFixture();
      
      await rm.setHealthFactor(user.address, 12_000);
      await rm.setRiskScore(user.address, 55);
      
      const hf1 = await view.getUserHealthFactor(user.address);
      const hf2 = await view.getUserHealthFactor(user.address);
      const hf3 = await view.getUserHealthFactor(user.address);
      
      const score1 = await view.getLiquidationRiskScore(user.address);
      const score2 = await view.getLiquidationRiskScore(user.address);
      const score3 = await view.getLiquidationRiskScore(user.address);
      
      expect(hf1).to.equal(hf2);
      expect(hf2).to.equal(hf3);
      expect(score1).to.equal(score2);
      expect(score2).to.equal(score3);
    });

    it('combines batch calculations with individual queries', async function () {
      const { view, rm, admin } = await deployFixture();
      
      const user1 = ethers.Wallet.createRandom().address;
      const user2 = ethers.Wallet.createRandom().address;
      
      await rm.setHealthFactor(user1, 15_000);
      await rm.setHealthFactor(user2, 10_000);
      
      // Batch query
      const batchHFs = await view.connect(admin).batchGetUserHealthFactors([user1, user2]);
      
      // Individual queries
      const hf1 = await view.getUserHealthFactor(user1);
      const hf2 = await view.getUserHealthFactor(user2);
      
      expect(batchHFs[0]).to.equal(hf1);
      expect(batchHFs[1]).to.equal(hf2);
    });
  });

  describe('business logic: risk state transitions', function () {
    it('tracks user risk from safe to risky', async function () {
      const { view, rm, user } = await deployFixture();
      
      // Initial state: Safe
      await rm.setHealthFactor(user.address, 20_000);
      await rm.setRiskScore(user.address, 10);
      await rm.setLiquidatable(user.address, false);
      
      expect(await view.getUserHealthFactor(user.address)).to.equal(20_000n);
      expect(await view.getLiquidationRiskScore(user.address)).to.equal(10n);
      expect(await view.isLiquidatable(user.address)).to.equal(false);
      
      // Transition: Moderate risk
      await rm.setHealthFactor(user.address, 12_000);
      await rm.setRiskScore(user.address, 50);
      await rm.setLiquidatable(user.address, false);
      
      expect(await view.getUserHealthFactor(user.address)).to.equal(12_000n);
      expect(await view.getLiquidationRiskScore(user.address)).to.equal(50n);
      expect(await view.isLiquidatable(user.address)).to.equal(false);
      
      // Transition: Risky
      await rm.setHealthFactor(user.address, 9_000);
      await rm.setRiskScore(user.address, 90);
      await rm.setLiquidatable(user.address, true);
      
      expect(await view.getUserHealthFactor(user.address)).to.equal(9_000n);
      expect(await view.getLiquidationRiskScore(user.address)).to.equal(90n);
      expect(await view.isLiquidatable(user.address)).to.equal(true);
    });

    it('tracks user recovery from risky to safe', async function () {
      const { view, rm, user } = await deployFixture();
      
      // Initial state: Risky
      await rm.setHealthFactor(user.address, 8_000);
      await rm.setLiquidatable(user.address, true);
      
      // Recovery: Add collateral
      await rm.setHealthFactor(user.address, 15_000);
      await rm.setLiquidatable(user.address, false);
      
      expect(await view.getUserHealthFactor(user.address)).to.equal(15_000n);
      expect(await view.isLiquidatable(user.address)).to.equal(false);
    });
  });

  describe('business logic: concurrent queries', function () {
    it('handles rapid sequential queries', async function () {
      const { view, rm, admin } = await deployFixture();
      
      const users = [];
      for (let i = 0; i < 20; i++) {
        const user = ethers.Wallet.createRandom().address;
        users.push(user);
        await rm.setLiquidatable(user, i % 2 === 0);
      }
      
      // Query all rapidly
      for (let i = 0; i < users.length; i++) {
        const isLiquid = await view.isLiquidatable(users[i]);
        expect(isLiquid).to.equal(i % 2 === 0);
      }
    });

    it('handles interleaved queries for different users', async function () {
      const { view, rm, user, other } = await deployFixture();
      
      await rm.setHealthFactor(user.address, 15_000);
      await rm.setHealthFactor(other.address, 10_000);
      
      // Interleaved queries
      const hf1 = await view.getUserHealthFactor(user.address);
      const hf2 = await view.getUserHealthFactor(other.address);
      const hf1Again = await view.getUserHealthFactor(user.address);
      const hf2Again = await view.getUserHealthFactor(other.address);
      
      expect(hf1).to.equal(15_000n);
      expect(hf2).to.equal(10_000n);
      expect(hf1Again).to.equal(hf1);
      expect(hf2Again).to.equal(hf2);
    });
  });

  describe('registry and module resolution', function () {
    it('reverts when liquidation risk manager module is not registered', async function () {
      const [admin] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      // Intentionally not setting KEY_LIQUIDATION_RISK_MANAGER
      
      const LibFactory = await ethers.getContractFactory('LiquidationRiskLib');
      const lib = await LibFactory.deploy();
      await lib.waitForDeployment();
      const libAddress = await lib.getAddress();
      
      const ViewFactory = await ethers.getContractFactory('LiquidationRiskView', {
        libraries: { LiquidationRiskLib: libAddress },
      });
      const view = await upgrades.deployProxy(ViewFactory, [await registry.getAddress()], {
        kind: 'uups',
        unsafeAllowLinkedLibraries: true,
      });
      
      await acm.grantRole(ACTION_VIEW_RISK_DATA, admin.address);
      
      await expect(view.connect(admin).isLiquidatable(admin.address)).to.be.revertedWith('MockRegistry: module not found');
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

  describe('prevent double initialization', function () {
    it('reverts on second initialization', async function () {
      const { view, registry } = await deployFixture();
      await expect(view.initialize(await registry.getAddress())).to.be.revertedWith(
        'Initializable: contract is already initialized',
      );
    });
  });
});


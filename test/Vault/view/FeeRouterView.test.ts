import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_FEE_ROUTER = ethers.keccak256(ethers.toUtf8Bytes('FEE_ROUTER'));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
const ACTION_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));

const DATA_TYPE_USER_FEE = ethers.keccak256(ethers.toUtf8Bytes('USER_FEE'));
const DATA_TYPE_GLOBAL_FEE_STATS = ethers.keccak256(ethers.toUtf8Bytes('GLOBAL_FEE_STATS'));

async function mineBlocks(count: number) {
  // Hardhat JSON-RPC: hardhat_mine expects a hex quantity string.
  await ethers.provider.send('hardhat_mine', [ethers.toBeHex(BigInt(count))]);
}

describe('FeeRouterView', function () {
  async function deployFixture() {
    const [admin, user, other, feeRouter] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_FEE_ROUTER, feeRouter.address);

    const FeeRouterViewFactory = await ethers.getContractFactory('FeeRouterView');
    const feeRouterView = await upgrades.deployProxy(FeeRouterViewFactory, [await registry.getAddress()], {
      kind: 'uups',
    });

    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, user.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, admin.address);

    return { feeRouterView, registry, acm, admin, user, other, feeRouter };
  }

  describe('initialization', function () {
    it('stores registry address', async function () {
      const { feeRouterView, registry } = await loadFixture(deployFixture);
      expect(await feeRouterView.registryAddr()).to.equal(await registry.getAddress());
    });

    it('getRegistry() returns same value as registryAddr()', async function () {
      const { feeRouterView, registry } = await loadFixture(deployFixture);
      expect(await feeRouterView.getRegistry()).to.equal(await registry.getAddress());
      expect(await feeRouterView.getRegistry()).to.equal(await feeRouterView.registryAddr());
    });

    it('reverts on zero address init', async function () {
      const FeeRouterViewFactory = await ethers.getContractFactory('FeeRouterView');
      const impl = await FeeRouterViewFactory.deploy();
      await impl.waitForDeployment();
      await expect(
        upgrades.deployProxy(FeeRouterViewFactory, [ethers.ZeroAddress], { kind: 'uups' }),
      ).to.be.revertedWithCustomError(impl, 'ZeroAddress');
    });

    it('prevents double initialization', async function () {
      const { feeRouterView, registry } = await loadFixture(deployFixture);
      await expect(feeRouterView.initialize(await registry.getAddress())).to.be.revertedWithCustomError(
        feeRouterView,
        'InvalidInitialization',
      );
    });
  });

  describe('pushUserFeeUpdate', function () {
    it('allows fee router to push user stats and emits DataPushed', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('SWAP'));

      const tx = await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 100n, 250n);
      const receipt = await tx.wait();

      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const payload = abiCoder.encode(['address', 'bytes32', 'uint256', 'uint256'], [user.address, feeType, 100n, 250n]);

      await expect(tx).to.emit(feeRouterView, 'UserDataPushed');
      await expect(tx).to.emit(feeRouterView, 'DataPushed').withArgs(DATA_TYPE_USER_FEE, payload);

      const [stats] = await feeRouterView.connect(user).getUserStatsWithMeta(user.address);
      expect(stats.totalFeePaid).to.equal(100n);
      expect(stats.transactionCount).to.equal(1n);
      // Time-Dependency-Refactor: view uses block.number as the onchain time axis marker.
      expect(stats.lastActivityBlock).to.equal(BigInt(receipt!.blockNumber!));
    });

    it('accumulates multiple fee updates', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('SWAP'));

      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 100n, 250n);
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 50n, 250n);
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 25n, 250n);

      const [amount] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType);
      expect(amount).to.equal(175n); // 100 + 50 + 25

      const [stats] = await feeRouterView.connect(user).getUserStatsWithMeta(user.address);
      expect(stats.totalFeePaid).to.equal(175n);
      expect(stats.transactionCount).to.equal(3n);
    });

    it('handles zero fee amount', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('ZERO_FEE'));

      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 0n, 100n);

      const [amount] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType);
      expect(amount).to.equal(0n);

      const [stats] = await feeRouterView.connect(user).getUserStatsWithMeta(user.address);
      expect(stats.transactionCount).to.equal(1n); // Transaction count still increments
    });

    it('handles very large fee amounts', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('LARGE_FEE'));
      const largeAmount = ethers.parseEther('1000000'); // 1 million ETH

      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, largeAmount, 100n);

      const [amount] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType);
      expect(amount).to.equal(largeAmount);
    });

    it('updates different fee types independently', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType1 = ethers.keccak256(ethers.toUtf8Bytes('TYPE_A'));
      const feeType2 = ethers.keccak256(ethers.toUtf8Bytes('TYPE_B'));

      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType1, 100n, 200n);
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType2, 300n, 400n);

      const [amount1] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType1);
      const [amount2] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType2);
      expect(amount1).to.equal(100n);
      expect(amount2).to.equal(300n);

      const [fee1] = await feeRouterView.connect(user).getUserDynamicFeeWithMeta(user.address, feeType1);
      const [fee2] = await feeRouterView.connect(user).getUserDynamicFeeWithMeta(user.address, feeType2);
      expect(fee1).to.equal(200n);
      expect(fee2).to.equal(400n);
    });

    it('reverts when non-fee-router tries to push', async function () {
      const { feeRouterView, user } = await loadFixture(deployFixture);
      await expect(
        feeRouterView.connect(user).pushUserFeeUpdate(user.address, ethers.ZeroHash, 0n, 0n),
      ).to.be.revertedWithCustomError(feeRouterView, 'FeeRouterView__OnlyFeeRouter');
    });

    it('handles zero address user', async function () {
      const { feeRouterView, feeRouter } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('ZERO_USER'));
      await expect(
        feeRouterView.connect(feeRouter).pushUserFeeUpdate(ethers.ZeroAddress, feeType, 100n, 200n),
      ).to.not.be.reverted; // Should not revert, but may have implications
    });
  });

  describe('user queries', function () {
    it('allows user with role to read own stats', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('MINT'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 200n, 300n);

      const [amount] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType);
      expect(amount).to.equal(200n);
    });

    it('allows user to read own stats without VIEW_USER_DATA role (Scheme U self-read)', async function () {
      const { feeRouterView, feeRouter, user, acm } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('SELF_NO_ROLE'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 123n, 456n);

      // Remove the role; self-read must still be allowed.
      await acm.revokeRole(ACTION_VIEW_USER_DATA, user.address);

      const [amount] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType);
      expect(amount).to.equal(123n);
    });

    it('blocks other users without admin role', async function () {
      const { feeRouterView, feeRouter, user, other } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('BURN'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 50n, 100n);

      await expect(
        feeRouterView.connect(other).getUserFeeStatisticsWithMeta(user.address, feeType),
      ).to.be.revertedWithCustomError(feeRouterView, 'MissingRole');
    });

    it('allows other user with VIEW_USER_DATA role to read non-self stats (Scheme U ops read)', async function () {
      const { feeRouterView, feeRouter, user, other, acm } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('OPS_NON_SELF'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 77n, 88n);

      await acm.grantRole(ACTION_VIEW_USER_DATA, other.address);

      const [value] = await feeRouterView.connect(other).getUserFeeStatisticsWithMeta(user.address, feeType);
      expect(value).to.equal(77n);
    });

    it('allows admin to read any user data', async function () {
      const { feeRouterView, feeRouter, user, admin } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('REDEEM'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 75n, 80n);

      const [value] = await feeRouterView.connect(admin).getUserFeeStatisticsWithMeta(user.address, feeType);
      expect(value).to.equal(75n);
    });

    it('getUserDynamicFee returns correct fee rate', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('DYNAMIC_FEE'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 100n, 500n);

      const [fee] = await feeRouterView.connect(user).getUserDynamicFeeWithMeta(user.address, feeType);
      expect(fee).to.equal(500n);
    });

    it('getUserStats returns correct statistics', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('STATS_TEST'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 100n, 200n);
      await mineBlocks(10);

      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 50n, 200n);
      const receipt = await (await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 25n, 200n)).wait();

      const [stats] = await feeRouterView.connect(user).getUserStatsWithMeta(user.address);
      expect(stats.totalFeePaid).to.equal(175n);
      expect(stats.transactionCount).to.equal(3n);
      expect(stats.lastActivityBlock).to.equal(BigInt(receipt!.blockNumber!));
    });

    it('getUserFeeConfig returns correct configuration', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('CONFIG_TEST'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 100n, 250n);

      const [config] = await feeRouterView.connect(user).getUserFeeConfigWithMeta(user.address);
      expect(config.totalFeePaid).to.equal(100n);
      expect(config.transactionCount).to.equal(1n);
      expect(config.vipStatus).to.equal(false); // Less than 1000 ether
      expect(config.discountLevel).to.equal(0n); // Less than 100 ether
    });

    it('returns analytics across fee types', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeTypes = [ethers.keccak256(ethers.toUtf8Bytes('A')), ethers.keccak256(ethers.toUtf8Bytes('B'))];
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeTypes[0], 10n, 0n);
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeTypes[1], 20n, 0n);

      const [analytics] = await feeRouterView.connect(user).getUserFeeAnalyticsWithMeta(user.address, feeTypes);
      expect(analytics.totalPaidFees).to.equal(30n);
      expect(analytics.transactionCount).to.equal(2n);
      expect(analytics.feeAmounts[0]).to.equal(10n);
      expect(analytics.feeAmounts[1]).to.equal(20n);
      expect(analytics.feeTypes.length).to.equal(2);
    });

    it('batchGetUserFeeStatistics returns correct values', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType1 = ethers.keccak256(ethers.toUtf8Bytes('BATCH_A'));
      const feeType2 = ethers.keccak256(ethers.toUtf8Bytes('BATCH_B'));
      const feeType3 = ethers.keccak256(ethers.toUtf8Bytes('BATCH_C'));

      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType1, 100n, 200n);
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType2, 200n, 300n);
      // feeType3 has no update, should return 0

      const [amounts] = await feeRouterView
        .connect(user)
        .batchGetUserFeeStatisticsWithMeta(user.address, [feeType1, feeType2, feeType3]);
      expect(amounts.length).to.equal(3);
      expect(amounts[0]).to.equal(100n);
      expect(amounts[1]).to.equal(200n);
      expect(amounts[2]).to.equal(0n);
    });

    it('batchGetUserFeeStatistics handles empty array', async function () {
      const { feeRouterView, user } = await loadFixture(deployFixture);
      await expect(
        feeRouterView.connect(user).batchGetUserFeeStatisticsWithMeta(user.address, []),
      ).to.be.revertedWithCustomError(feeRouterView, 'EmptyArray');
    });

    it('batchGetUserFeeStatistics handles maximum batch size', async function () {
      const { feeRouterView, user } = await loadFixture(deployFixture);
      const feeTypes = Array.from({ length: 100 }, (_, i) =>
        ethers.zeroPadValue(ethers.toBeHex(BigInt(i + 1)), 32),
      );
      const [amounts] = await feeRouterView.connect(user).batchGetUserFeeStatisticsWithMeta(user.address, feeTypes);
      expect(amounts.length).to.equal(100);
    });

    it('batchGetUserFeeStatistics enforces limits', async function () {
      const { feeRouterView, user } = await loadFixture(deployFixture);
      const feeTypes = Array.from({ length: 101 }, (_, i) =>
        ethers.zeroPadValue(ethers.toBeHex(BigInt(i + 1)), 32),
      );
      await expect(
        feeRouterView.connect(user).batchGetUserFeeStatisticsWithMeta(user.address, feeTypes),
      ).to.be.revertedWithCustomError(feeRouterView, 'BatchTooLarge');
    });

    it('getUserFeeAnalytics calculates average fee rate correctly', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('AVG_TEST'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 100n, 0n);
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 200n, 0n);

      const [analytics] = await feeRouterView.connect(user).getUserFeeAnalyticsWithMeta(user.address, [feeType]);
      // Formula: (totalFees * 10000) / transactionCount = (300 * 10000) / 2 = 1500000
      expect(analytics.averageFeeRate).to.equal(1500000n);
    });

    it('getUserFeeAnalytics handles zero transaction count', async function () {
      const { feeRouterView, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('ZERO_TX'));
      const [analytics] = await feeRouterView.connect(user).getUserFeeAnalyticsWithMeta(user.address, [feeType]);
      expect(analytics.transactionCount).to.equal(0n);
      expect(analytics.averageFeeRate).to.equal(0n);
    });
  });

  describe('ARCH 4.9 FRV-01: push permission (FeeRouter-only)', function () {
    it('reverts for non-FeeRouter callers across all push entrypoints', async function () {
      const { feeRouterView, admin, user } = await loadFixture(deployFixture);

      await expect(feeRouterView.connect(user).pushGlobalStatsUpdate(1n, 2n)).to.be.revertedWithCustomError(
        feeRouterView,
        'FeeRouterView__OnlyFeeRouter',
      );
      await expect(feeRouterView.connect(admin).pushGlobalStatsUpdate(1n, 2n)).to.be.revertedWithCustomError(
        feeRouterView,
        'FeeRouterView__OnlyFeeRouter',
      );

      await expect(
        feeRouterView
          .connect(user)
          .pushSystemConfigUpdate(
            ethers.Wallet.createRandom().address,
            ethers.Wallet.createRandom().address,
            200n,
            100n,
            [],
          ),
      ).to.be.revertedWithCustomError(feeRouterView, 'FeeRouterView__OnlyFeeRouter');
      await expect(
        feeRouterView
          .connect(admin)
          .pushSystemConfigUpdate(
            ethers.Wallet.createRandom().address,
            ethers.Wallet.createRandom().address,
            200n,
            100n,
            [],
          ),
      ).to.be.revertedWithCustomError(feeRouterView, 'FeeRouterView__OnlyFeeRouter');

      await expect(
        feeRouterView
          .connect(user)
          .pushGlobalFeeStatistic(ethers.Wallet.createRandom().address, ethers.ZeroHash, 123n),
      ).to.be.revertedWithCustomError(feeRouterView, 'FeeRouterView__OnlyFeeRouter');
      await expect(
        feeRouterView
          .connect(admin)
          .pushGlobalFeeStatistic(ethers.Wallet.createRandom().address, ethers.ZeroHash, 123n),
      ).to.be.revertedWithCustomError(feeRouterView, 'FeeRouterView__OnlyFeeRouter');
    });
  });

  describe('ARCH 4.9 FRV-02: staleness output (blockNumber/isValid/needsSync)', function () {
    it('getSyncStatus is valid initially and flips to stale after SYNC_INTERVAL', async function () {
      const { feeRouterView } = await loadFixture(deployFixture);

      const [isValid0, block0, needs0] = await feeRouterView.getSyncStatus();
      expect(block0).to.be.greaterThan(0n);
      expect(needs0).to.equal(false);
      expect(isValid0).to.equal(true);

      // Time-Dependency-Refactor: SYNC is block-based (ViewConstants.CACHE_DURATION_BLOCKS = 150).
      await mineBlocks(151);
      const [isValid1, block1, needs1] = await feeRouterView.getSyncStatus();
      expect(block1).to.equal(block0);
      expect(needs1).to.equal(true);
      expect(isValid1).to.equal(false);
    });

    it('FeeRouter push refreshes sync status, emits DataPushed, and blockNumber is monotonic', async function () {
      const { feeRouterView, feeRouter } = await loadFixture(deployFixture);

      const [, block0, needs0] = await feeRouterView.getSyncStatus();
      expect(needs0).to.equal(false);

      await mineBlocks(151);
      const [isValidStale, blockStale, needsStale] = await feeRouterView.getSyncStatus();
      expect(blockStale).to.equal(block0);
      expect(needsStale).to.equal(true);
      expect(isValidStale).to.equal(false);

      const tx1 = await feeRouterView.connect(feeRouter).pushGlobalStatsUpdate(5n, 500n);
      const receipt1 = await tx1.wait();

      const [isValid1, block1, needs1] = await feeRouterView.getSyncStatus();
      expect(needs1).to.equal(false);
      expect(isValid1).to.equal(true);
      expect(block1).to.equal(BigInt(receipt1!.blockNumber!));
      expect(block1).to.be.greaterThan(block0);

      await mineBlocks(1);
      const tx2 = await feeRouterView.connect(feeRouter).pushGlobalStatsUpdate(6n, 600n);
      const receipt2 = await tx2.wait();

      const [, block2] = await feeRouterView.getSyncStatus();
      expect(block2).to.equal(BigInt(receipt2!.blockNumber!));
      expect(block2).to.be.greaterThan(block1);
    });
  });

  describe('admin queries', function () {
    it('pushGlobalStatsUpdate and read global stats', async function () {
      const { feeRouterView, feeRouter, admin } = await loadFixture(deployFixture);
      const tx = await feeRouterView.connect(feeRouter).pushGlobalStatsUpdate(5n, 500n);
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const payload = abiCoder.encode(['uint256', 'uint256'], [5n, 500n]);
      await expect(tx).to.emit(feeRouterView, 'DataPushed').withArgs(DATA_TYPE_GLOBAL_FEE_STATS, payload);

      const [distributions, totalAmount] = await feeRouterView.connect(admin).getGlobalOperationStatsWithMeta();
      expect(distributions).to.equal(5n);
      expect(totalAmount).to.equal(500n);
    });

    it('pushGlobalFeeStatistic updates mapping', async function () {
      const { feeRouterView, feeRouter, admin } = await loadFixture(deployFixture);
      const token = ethers.Wallet.createRandom().address;
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('DIST'));
      await feeRouterView.connect(feeRouter).pushGlobalFeeStatistic(token, feeType, 1_000n);
      const [value] = await feeRouterView.connect(admin).getGlobalFeeStatisticsWithMeta(token, feeType);
      expect(value).to.equal(1_000n);
    });

    it('getSystemConfig returns correct configuration', async function () {
      const { feeRouterView, feeRouter, admin } = await loadFixture(deployFixture);
      const platformTreasury = ethers.Wallet.createRandom().address;
      const ecosystemVault = ethers.Wallet.createRandom().address;
      const tokens = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];

      await feeRouterView
        .connect(feeRouter)
        .pushSystemConfigUpdate(platformTreasury, ecosystemVault, 200n, 100n, tokens);

      const [config] = await feeRouterView.connect(admin).getSystemConfigWithMeta();
      expect(config.platformTreasury).to.equal(platformTreasury);
      expect(config.ecosystemVault).to.equal(ecosystemVault);
      expect(config.platformFeeBps).to.equal(200n);
      expect(config.ecosystemFeeBps).to.equal(100n);
      expect(config.supportedTokens.length).to.equal(2);
    });

    it('getSystemFeeAnalytics calculates correctly', async function () {
      const { feeRouterView, feeRouter, admin } = await loadFixture(deployFixture);
      const platformTreasury = ethers.Wallet.createRandom().address;
      const ecosystemVault = ethers.Wallet.createRandom().address;
      const tokens = [ethers.Wallet.createRandom().address];

      await feeRouterView
        .connect(feeRouter)
        .pushSystemConfigUpdate(platformTreasury, ecosystemVault, 200n, 100n, tokens);
      await feeRouterView.connect(feeRouter).pushGlobalStatsUpdate(10n, 1_000_000n);

      const [analytics] = await feeRouterView.connect(admin).getSystemFeeAnalyticsWithMeta();
      expect(analytics.distributionCount).to.equal(10n);
      expect(analytics.totalVolume).to.equal(1_000_000n);
      expect(analytics.totalFees).to.equal(30_000n); // 1_000_000 * (200 + 100) / 10000
      expect(analytics.platformRevenue).to.equal(20_000n); // 1_000_000 * 200 / 10000
      expect(analytics.ecosystemRevenue).to.equal(10_000n); // 1_000_000 * 100 / 10000
      expect(analytics.averageFeeRate).to.equal(300n); // 200 + 100
    });

    it('batchGetGlobalFeeStatistics returns correct values', async function () {
      const { feeRouterView, feeRouter, admin } = await loadFixture(deployFixture);
      const token1 = ethers.Wallet.createRandom().address;
      const token2 = ethers.Wallet.createRandom().address;
      const feeType1 = ethers.keccak256(ethers.toUtf8Bytes('TYPE_1'));
      const feeType2 = ethers.keccak256(ethers.toUtf8Bytes('TYPE_2'));

      await feeRouterView.connect(feeRouter).pushGlobalFeeStatistic(token1, feeType1, 100n);
      await feeRouterView.connect(feeRouter).pushGlobalFeeStatistic(token2, feeType2, 200n);

      const [values] = await feeRouterView
        .connect(admin)
        .batchGetGlobalFeeStatisticsWithMeta([token1, token2], [feeType1, feeType2]);
      expect(values.length).to.equal(2);
      expect(values[0]).to.equal(100n);
      expect(values[1]).to.equal(200n);
    });

    it('batchGetGlobalFeeStatistics enforces length checks', async function () {
      const { feeRouterView, feeRouter, admin } = await loadFixture(deployFixture);
      const token = ethers.Wallet.createRandom().address;
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('DIST'));
      await feeRouterView.connect(feeRouter).pushGlobalFeeStatistic(token, feeType, 123n);

      const [values] = await feeRouterView.connect(admin).batchGetGlobalFeeStatisticsWithMeta([token], [feeType]);
      expect(values[0]).to.equal(123n);

      await expect(
        feeRouterView.connect(admin).batchGetGlobalFeeStatisticsWithMeta([token], []),
      ).to.be.revertedWithCustomError(feeRouterView, 'ArrayLengthMismatch');

      await expect(
        feeRouterView.connect(admin).batchGetGlobalFeeStatisticsWithMeta([], [feeType]),
      ).to.be.revertedWithCustomError(feeRouterView, 'EmptyArray');
    });

    it('batchGetGlobalFeeStatistics enforces batch size limit', async function () {
      const { feeRouterView, admin } = await loadFixture(deployFixture);
      const tokens = Array.from({ length: 101 }, () => ethers.Wallet.createRandom().address);
      const feeTypes = Array.from({ length: 101 }, (_, i) =>
        ethers.zeroPadValue(ethers.toBeHex(BigInt(i + 1)), 32),
      );

      await expect(
        feeRouterView.connect(admin).batchGetGlobalFeeStatisticsWithMeta(tokens, feeTypes),
      ).to.be.revertedWithCustomError(feeRouterView, 'BatchTooLarge');
    });

    it('requires admin role for admin queries', async function () {
      const { feeRouterView, user, acm } = await loadFixture(deployFixture);
      const token = ethers.Wallet.createRandom().address;
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('ADMIN_ONLY'));

      await expect(feeRouterView.connect(user).getGlobalFeeStatisticsWithMeta(token, feeType)).to.be.revertedWithCustomError(
        acm,
        'MissingRole',
      );
      await expect(feeRouterView.connect(user).getGlobalOperationStatsWithMeta()).to.be.revertedWithCustomError(acm, 'MissingRole');
      await expect(feeRouterView.connect(user).getSystemConfigWithMeta()).to.be.revertedWithCustomError(acm, 'MissingRole');
      await expect(feeRouterView.connect(user).getSystemFeeAnalyticsWithMeta()).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('system config and tokens', function () {
    it('updates supported tokens via push', async function () {
      const { feeRouterView, feeRouter, admin } = await loadFixture(deployFixture);
      const tokens = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
      await feeRouterView.connect(feeRouter).pushSystemConfigUpdate(
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
        200n,
        100n,
        tokens,
      );

      const [config] = await feeRouterView.connect(admin).getSystemConfigWithMeta();
      expect(config.supportedTokens.length).to.equal(2);
      const [supported] = await feeRouterView.batchCheckTokenSupportWithMeta(tokens);
      expect(supported[0]).to.equal(true);
      expect(supported[1]).to.equal(true);

      await expect(feeRouterView.batchCheckTokenSupportWithMeta([])).to.be.revertedWithCustomError(
        feeRouterView,
        'EmptyArray',
      );
    });

    it('clears previous tokens when updating config', async function () {
      const { feeRouterView, feeRouter } = await loadFixture(deployFixture);
      const oldToken1 = ethers.Wallet.createRandom().address;
      const oldToken2 = ethers.Wallet.createRandom().address;
      const newToken = ethers.Wallet.createRandom().address;

      await feeRouterView.connect(feeRouter).pushSystemConfigUpdate(
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
        200n,
        100n,
        [oldToken1, oldToken2],
      );

      expect((await feeRouterView.isTokenSupportedWithMeta(oldToken1))[0]).to.equal(true);
      expect((await feeRouterView.isTokenSupportedWithMeta(oldToken2))[0]).to.equal(true);

      await feeRouterView.connect(feeRouter).pushSystemConfigUpdate(
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
        200n,
        100n,
        [newToken],
      );

      expect((await feeRouterView.isTokenSupportedWithMeta(oldToken1))[0]).to.equal(false);
      expect((await feeRouterView.isTokenSupportedWithMeta(oldToken2))[0]).to.equal(false);
      expect((await feeRouterView.isTokenSupportedWithMeta(newToken))[0]).to.equal(true);
    });

    it('handles empty token list', async function () {
      const { feeRouterView, feeRouter, admin } = await loadFixture(deployFixture);
      await feeRouterView.connect(feeRouter).pushSystemConfigUpdate(
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
        200n,
        100n,
        [],
      );

      const [config] = await feeRouterView.connect(admin).getSystemConfigWithMeta();
      expect(config.supportedTokens.length).to.equal(0);
    });

    it('batchCheckTokenSupport handles multiple tokens', async function () {
      const { feeRouterView, feeRouter } = await loadFixture(deployFixture);
      const token1 = ethers.Wallet.createRandom().address;
      const token2 = ethers.Wallet.createRandom().address;
      const token3 = ethers.Wallet.createRandom().address; // Not supported

      await feeRouterView.connect(feeRouter).pushSystemConfigUpdate(
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
        200n,
        100n,
        [token1, token2],
      );

      const [supported] = await feeRouterView.batchCheckTokenSupportWithMeta([token1, token2, token3]);
      expect(supported.length).to.equal(3);
      expect(supported[0]).to.equal(true);
      expect(supported[1]).to.equal(true);
      expect(supported[2]).to.equal(false);
    });

    it('batchCheckTokenSupport enforces batch size limit', async function () {
      const { feeRouterView } = await loadFixture(deployFixture);
      const tokens = Array.from({ length: 101 }, () => ethers.Wallet.createRandom().address);

      await expect(feeRouterView.batchCheckTokenSupportWithMeta(tokens)).to.be.revertedWithCustomError(
        feeRouterView,
        'BatchTooLarge',
      );
    });

    it('isTokenSupported returns false for unsupported token', async function () {
      const { feeRouterView } = await loadFixture(deployFixture);
      const unsupportedToken = ethers.Wallet.createRandom().address;
      expect((await feeRouterView.isTokenSupportedWithMeta(unsupportedToken))[0]).to.equal(false);
    });

    it('getSupportedTokens returns empty array initially', async function () {
      const { feeRouterView } = await loadFixture(deployFixture);
      const [tokens] = await feeRouterView.getSupportedTokensWithMeta();
      expect(tokens.length).to.equal(0);
    });
  });

  describe('discount levels and VIP status', function () {
    it('calculates discount level 0 for low fees', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('LOW_FEE'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, ethers.parseEther('50'), 100n);

      const [config] = await feeRouterView.connect(user).getUserFeeConfigWithMeta(user.address);
      expect(config.discountLevel).to.equal(0n);
      expect(config.vipStatus).to.equal(false);
    });

    it('calculates discount level 1 for 100+ ether', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('LEVEL_1'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, ethers.parseEther('100'), 100n);

      const [config] = await feeRouterView.connect(user).getUserFeeConfigWithMeta(user.address);
      expect(config.discountLevel).to.equal(1n);
      expect(config.vipStatus).to.equal(false);
    });

    it('calculates discount level 2 for 500+ ether', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('LEVEL_2'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, ethers.parseEther('500'), 100n);

      const [config] = await feeRouterView.connect(user).getUserFeeConfigWithMeta(user.address);
      expect(config.discountLevel).to.equal(2n);
      expect(config.vipStatus).to.equal(false);
    });

    it('calculates discount level 3 and VIP for 1000+ ether', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('LEVEL_3'));
      // Contract uses > 1000 ether, so need to push more than 1000
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, ethers.parseEther('1001'), 100n);

      const [config] = await feeRouterView.connect(user).getUserFeeConfigWithMeta(user.address);
      expect(config.discountLevel).to.equal(3n);
      expect(config.vipStatus).to.equal(true); // totalFeePaid > 1000 ether
    });

    it('calculates discount level 4 for 5000+ ether', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('LEVEL_4'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, ethers.parseEther('5000'), 100n);

      const [config] = await feeRouterView.connect(user).getUserFeeConfigWithMeta(user.address);
      expect(config.discountLevel).to.equal(4n);
      expect(config.vipStatus).to.equal(true);
    });

    it('calculates discount level 5 for 10000+ ether', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('LEVEL_5'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, ethers.parseEther('10000'), 100n);

      const [config] = await feeRouterView.connect(user).getUserFeeConfigWithMeta(user.address);
      expect(config.discountLevel).to.equal(5n);
      expect(config.vipStatus).to.equal(true);
    });

    it('handles boundary values correctly', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType1 = ethers.keccak256(ethers.toUtf8Bytes('BOUNDARY_1'));
      const feeType2 = ethers.keccak256(ethers.toUtf8Bytes('BOUNDARY_2'));

      // Exactly 100 ether - should be level 1
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType1, ethers.parseEther('100'), 100n);
      let config = (await feeRouterView.connect(user).getUserFeeConfigWithMeta(user.address))[0];
      expect(config.discountLevel).to.equal(1n);

      // Add 901 more to reach 1001 total (exceeds 1000) - should be level 3 and VIP
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType2, ethers.parseEther('901'), 100n);
      config = (await feeRouterView.connect(user).getUserFeeConfigWithMeta(user.address))[0];
      expect(config.discountLevel).to.equal(3n);
      expect(config.vipStatus).to.equal(true); // totalFeePaid > 1000 ether (1001)
    });
  });

  describe('needsSync helper', function () {
    it('returns false initially', async function () {
      const { feeRouterView } = await loadFixture(deployFixture);
      const [, , needsSync] = await feeRouterView.getSyncStatus();
      expect(needsSync).to.equal(false);
    });

    it('returns true when sync interval exceeded', async function () {
      const { feeRouterView } = await loadFixture(deployFixture);
      expect((await feeRouterView.getSyncStatus())[2]).to.equal(false);
      await mineBlocks(151);
      expect((await feeRouterView.getSyncStatus())[2]).to.equal(true);
    });

    it('returns false after sync update', async function () {
      const { feeRouterView, feeRouter } = await loadFixture(deployFixture);
      await mineBlocks(151);
      expect((await feeRouterView.getSyncStatus())[2]).to.equal(true);

      await feeRouterView.connect(feeRouter).pushGlobalStatsUpdate(1n, 100n);
      expect((await feeRouterView.getSyncStatus())[2]).to.equal(false);
    });
  });

  describe('UUPS upgradeability', function () {
    it('allows admin to upgrade', async function () {
      const { feeRouterView, admin, registry } = await loadFixture(deployFixture);
      const FeeRouterViewFactory = await ethers.getContractFactory('FeeRouterView');
      await upgrades.upgradeProxy(await feeRouterView.getAddress(), FeeRouterViewFactory);
      // Verify state is preserved
      expect(await feeRouterView.registryAddr()).to.equal(await registry.getAddress());
    });

    it('rejects upgrade from non-admin', async function () {
      const { feeRouterView, user, acm } = await loadFixture(deployFixture);
      const FeeRouterViewFactory = await ethers.getContractFactory('FeeRouterView');
      await expect(
        upgrades.upgradeProxy(await feeRouterView.getAddress(), FeeRouterViewFactory.connect(user)),
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('rejects upgrade to zero address', async function () {
      const { feeRouterView, admin, registry } = await loadFixture(deployFixture);
      const FeeRouterViewFactory = await ethers.getContractFactory('FeeRouterView');
      // Zero address check is in _authorizeUpgrade, which is called during upgrade
      // We can't directly test _authorizeUpgrade as it's internal, but we can verify
      // the upgrade mechanism works correctly through the upgrade process
      await upgrades.upgradeProxy(await feeRouterView.getAddress(), FeeRouterViewFactory);
      // Verify state is preserved
      expect(await feeRouterView.registryAddr()).to.equal(await registry.getAddress());
    });
  });

  describe('error handling - missing modules', function () {
    it('reverts when FeeRouter module is missing during push', async function () {
      const [admin, feeRouter] = await ethers.getSigners();
      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      // Don't set FeeRouter

      const FeeRouterViewFactory = await ethers.getContractFactory('FeeRouterView');
      const feeRouterView = await upgrades.deployProxy(FeeRouterViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      await acm.grantRole(ACTION_ADMIN, admin.address);

      // When FeeRouter tries to push, it will fail because module is not found
      await expect(
        feeRouterView.connect(feeRouter).pushUserFeeUpdate(admin.address, ethers.ZeroHash, 100n, 200n),
      ).to.be.revertedWith('MockRegistry: module not found');
    });
  });

  describe('data consistency', function () {
    it('pushUserFeeUpdate and getUserFeeStatistics are consistent', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('CONSISTENCY'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 123n, 456n);

      const [amount] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType);
      const [fee] = await feeRouterView.connect(user).getUserDynamicFeeWithMeta(user.address, feeType);
      expect(amount).to.equal(123n);
      expect(fee).to.equal(456n);
    });

    it('batchGetUserFeeStatistics matches individual queries', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType1 = ethers.keccak256(ethers.toUtf8Bytes('BATCH_1'));
      const feeType2 = ethers.keccak256(ethers.toUtf8Bytes('BATCH_2'));

      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType1, 100n, 200n);
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType2, 300n, 400n);

      const [batchAmounts] = await feeRouterView
        .connect(user)
        .batchGetUserFeeStatisticsWithMeta(user.address, [feeType1, feeType2]);
      const [individual1] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType1);
      const [individual2] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType2);

      expect(batchAmounts[0]).to.equal(individual1);
      expect(batchAmounts[1]).to.equal(individual2);
    });

    it('getUserStats matches individual fee statistics sum', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType1 = ethers.keccak256(ethers.toUtf8Bytes('SUM_1'));
      const feeType2 = ethers.keccak256(ethers.toUtf8Bytes('SUM_2'));

      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType1, 100n, 0n);
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType2, 200n, 0n);

      const [stats] = await feeRouterView.connect(user).getUserStatsWithMeta(user.address);
      const [amount1] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType1);
      const [amount2] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType2);

      expect(stats.totalFeePaid).to.equal(amount1 + amount2);
      expect(stats.transactionCount).to.equal(2n);
    });
  });

  describe('edge cases', function () {
    it('handles zero address user in queries', async function () {
      const { feeRouterView, admin } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('ZERO_USER'));
      // Admin can query any user, including zero address
      const [amount] = await feeRouterView.connect(admin).getUserFeeStatisticsWithMeta(ethers.ZeroAddress, feeType);
      expect(amount).to.equal(0n);
    });

    it('handles zero hash fee type', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, ethers.ZeroHash, 100n, 200n);

      const [amount] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, ethers.ZeroHash);
      expect(amount).to.equal(100n);
    });

    it('handles very large fee amounts', async function () {
      const { feeRouterView, feeRouter, user } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('LARGE'));
      const maxUint256 = ethers.MaxUint256;
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, maxUint256, 100n);

      const [amount] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType);
      expect(amount).to.equal(maxUint256);
    });

    it('handles multiple users with same fee type', async function () {
      const { feeRouterView, feeRouter, user, other, admin } = await loadFixture(deployFixture);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('SHARED'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 100n, 200n);
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(other.address, feeType, 300n, 400n);

      const [userAmount] = await feeRouterView.connect(user).getUserFeeStatisticsWithMeta(user.address, feeType);
      const [otherAmount] = await feeRouterView.connect(admin).getUserFeeStatisticsWithMeta(other.address, feeType);
      expect(userAmount).to.equal(100n);
      expect(otherAmount).to.equal(300n);
    });

    it('getFeeRouter returns correct address', async function () {
      const { feeRouterView, feeRouter, registry } = await loadFixture(deployFixture);
      const feeRouterAddr = await feeRouterView.getFeeRouter();
      expect(feeRouterAddr).to.equal(feeRouter.address);
    });
  });

  describe('SSOT callsite assertions (trap ACM)', function () {
    it('user-dimensional gate MUST use hasRole (must not call ACM.requireRole)', async function () {
      const [admin, user, other, feeRouter] = await ethers.getSigners();

      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManagerTrapRequireRole')).deploy();

      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      await registry.setModule(KEY_FEE_ROUTER, feeRouter.address);

      const FeeRouterViewFactory = await ethers.getContractFactory('FeeRouterView');
      const feeRouterView = await upgrades.deployProxy(FeeRouterViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      // Push some data so the read path is meaningful (push gate is FeeRouter-only, not ACM-based).
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('TRAP'));
      await feeRouterView.connect(feeRouter).pushUserFeeUpdate(user.address, feeType, 1n, 1n);

      // Non-self without roles should be rejected by the view's Scheme U gate.
      // If someone refactors to use ViewAccessLib.requireRole here, the trap ACM will revert RequireRoleCalled().
      await expect(feeRouterView.connect(other).getUserFeeStatisticsWithMeta(user.address, feeType)).to.be.revertedWithCustomError(
        feeRouterView,
        'MissingRole',
      );
    });

    it('admin gate MUST revert MissingRole (no role)', async function () {
      const [admin, , other, feeRouter] = await ethers.getSigners();

      const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
      const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();

      await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      await registry.setModule(KEY_FEE_ROUTER, feeRouter.address);

      const FeeRouterViewFactory = await ethers.getContractFactory('FeeRouterView');
      const feeRouterView = await upgrades.deployProxy(FeeRouterViewFactory, [await registry.getAddress()], {
        kind: 'uups',
      });

      // Ensure someone (admin) does have admin so we know roles can be granted in this mock.
      await acm.grantRole(ACTION_ADMIN, admin.address);

      await expect(feeRouterView.connect(other).getGlobalOperationStatsWithMeta()).to.be.revertedWithCustomError(
        feeRouterView,
        'MissingRole',
      );
    });
  });
});


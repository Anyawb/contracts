import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import type { StatisticsView, StatisticsView__factory, Registry, MockAccessControlManager } from '../types';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('StatisticsView (VaultStatistics 替代)', function () {
  async function deployFixture() {
    const [admin] = await ethers.getSigners();

    const MockRegistryFactory = await ethers.getContractFactory('MockRegistry');
    const registry = (await MockRegistryFactory.deploy()) as unknown as Registry;
    await registry.waitForDeployment();

    const MockACMFactory = await ethers.getContractFactory('MockAccessControlManager');
    const acm = (await MockACMFactory.deploy()) as unknown as MockAccessControlManager;
    await acm.waitForDeployment();

    const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    const StatisticsViewFactory = (await ethers.getContractFactory('StatisticsView')) as StatisticsView__factory;
    const stats = (await upgrades.deployProxy(StatisticsViewFactory, [await registry.getAddress()], {
      kind: 'uups',
    })) as StatisticsView;

    const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
    await acm.grantRole(ACTION_ADMIN, admin.address);

    return { admin, registry, acm, stats };
  }

  describe('初始化', function () {
    it('应正确初始化（proxy）', async function () {
      const { stats, registry } = await deployFixture();
      expect(await stats.registryAddr()).to.equal(await registry.getAddress());
      const global = await stats.getGlobalStatistics();
      expect(global.totalCollateral).to.equal(0n);
    });

    it('零地址初始化应被拒绝', async function () {
      const StatisticsViewFactory = (await ethers.getContractFactory('StatisticsView')) as StatisticsView__factory;
      await expect(
        upgrades.deployProxy(StatisticsViewFactory, [ZERO_ADDRESS], { kind: 'uups' }),
      ).to.be.revertedWithCustomError(StatisticsViewFactory, 'ZeroAddress');
    });

    it('重复初始化应失败', async function () {
      const { stats, registry } = await deployFixture();
      await expect(stats.initialize(await registry.getAddress())).to.be.revertedWithCustomError(
        stats,
        'InvalidInitialization',
      );
    });
  });

  describe('只读函数', function () {
    it('getGlobalStatistics 返回零值基线', async function () {
      const { stats } = await deployFixture();
      const global = await stats.getGlobalStatistics();
      expect(global.totalCollateral).to.equal(0n);
      expect(global.totalDebt).to.equal(0n);
      expect(global.activeUsers).to.equal(0n);
    });

    it('getDegradationStats 默认返回空值', async function () {
      const { stats } = await deployFixture();
      const s = await stats.getDegradationStats();
      expect(s.totalDegradations).to.equal(0);
    });

    it('getUserGuaranteeBalance 默认为 0', async function () {
      const { stats } = await deployFixture();
      const user = ethers.Wallet.createRandom().address;
      const asset = ethers.Wallet.createRandom().address;
      expect(await stats.getUserGuaranteeBalance(user, asset)).to.equal(0n);
    });
  });

  describe('升级权限', function () {
    it('非管理员无法升级', async function () {
      const { stats } = await deployFixture();
      const [, stranger] = await ethers.getSigners();
      await expect(
        stats.connect(stranger).upgradeToAndCall(ethers.Wallet.createRandom().address, '0x'),
      ).to.be.reverted;
    });
  });
});

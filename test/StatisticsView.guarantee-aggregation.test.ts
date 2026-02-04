import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';

describe('StatisticsView – 保证金聚合（pushGuaranteeUpdate）', function () {
  const KEY_ACM = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
  const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));

  async function deployFixture() {
    const [owner, user] = await ethers.getSigners();
    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory('MockAccessControlManager');
    const acm = await ACMF.deploy();
    await registry.setModule(KEY_ACM, await acm.getAddress());
    await acm.grantRole(ACTION_ADMIN, await owner.getAddress());

    const StatsF = await ethers.getContractFactory('StatisticsView');
    const stats = await upgrades.deployProxy(StatsF, [await registry.getAddress()]);

    return { stats, user };
  }

  it('锁定与释放保证金应更新聚合总量', async function () {
    const { stats, user } = await deployFixture();
    const asset = ethers.Wallet.createRandom().address;

    const DATA_TYPE_GUARANTEE_STATS_UPDATE = ethers.keccak256(ethers.toUtf8Bytes('GUARANTEE_STATS_UPDATE'));
    const tx1 = await stats.pushGuaranteeUpdate(await user.getAddress(), asset, ethers.parseUnits('30', 18), true);
    await expect(tx1).to.emit(stats, 'DataPushed').withArgs(DATA_TYPE_GUARANTEE_STATS_UPDATE, anyValue);
    const [s1] = await stats.getGlobalSnapshotWithMeta();
    expect(s1.blockNumber).to.be.greaterThan(0n);

    const tx2 = await stats.pushGuaranteeUpdate(await user.getAddress(), asset, ethers.parseUnits('10', 18), false);
    await expect(tx2).to.emit(stats, 'DataPushed').withArgs(DATA_TYPE_GUARANTEE_STATS_UPDATE, anyValue);
    const [s2] = await stats.getGlobalSnapshotWithMeta();
    expect(s2.blockNumber).to.be.greaterThanOrEqual(s1.blockNumber);

    // meta reads should expose freshness
    const [total, isValid, blockNumber] = await stats.getTotalGuaranteeByAssetWithMeta(asset);
    expect(total).to.equal(ethers.parseUnits('20', 18));
    expect(blockNumber).to.be.greaterThan(0n);
    // In hardhat tests, blockNumber is "fresh" by default
    expect(isValid).to.equal(true);
  });
});


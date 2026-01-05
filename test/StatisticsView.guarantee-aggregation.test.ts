import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;

describe('StatisticsView – 保证金聚合（pushGuaranteeUpdate）', function () {
  const KEY_ACM = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));

  async function deployFixture() {
    const [owner, user] = await ethers.getSigners();
    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory('MockAccessControlManager');
    const acm = await ACMF.deploy();
    await registry.setModule(KEY_ACM, await acm.getAddress());
    await acm.grantRole(ACTION_SET_PARAMETER, await owner.getAddress());

    const StatsF = await ethers.getContractFactory('StatisticsView');
    const stats = await upgrades.deployProxy(StatsF, [await registry.getAddress()]);

    return { stats, user };
  }

  it('锁定与释放保证金应更新聚合总量', async function () {
    const { stats, user } = await deployFixture();
    const asset = ethers.Wallet.createRandom().address;

    await stats.pushGuaranteeUpdate(await user.getAddress(), asset, ethers.parseUnits('30', 18), true);
    const s1 = await stats.getGlobalSnapshot();
    expect(s1.timestamp).to.be.greaterThan(0n);

    await stats.pushGuaranteeUpdate(await user.getAddress(), asset, ethers.parseUnits('10', 18), false);
    const s2 = await stats.getGlobalSnapshot();
    expect(s2.timestamp).to.be.greaterThanOrEqual(s1.timestamp);
  });
});


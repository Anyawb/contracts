import { expect } from 'chai';
import hardhat from 'hardhat';

const { ethers, upgrades } = hardhat;

// 常量
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('StatisticsView – 活跃用户与全局快照', function () {
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

  it('当仓位>0 视为活跃；归零后不活跃', async function () {
    const { stats, user } = await deployFixture();

    let snap = await stats.getGlobalSnapshot();
    expect(snap.activeUsers).to.equal(0n);
    expect(snap.totalCollateral).to.equal(0n);
    expect(snap.totalDebt).to.equal(0n);

    await stats.pushUserStatsUpdate(await user.getAddress(), ethers.parseUnits('100', 18), 0n, 0n, 0n);
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(ethers.parseUnits('100', 18));
    expect(snap.activeUsers).to.equal(1n);

    await stats.pushUserStatsUpdate(await user.getAddress(), 0n, ethers.parseUnits('100', 18), 0n, 0n);
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(0n);
    expect(snap.totalDebt).to.equal(0n);
    expect(snap.activeUsers).to.equal(0n);

    await stats.pushUserStatsUpdate(await user.getAddress(), 0n, 0n, ethers.parseUnits('50', 18), 0n);
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalDebt).to.equal(ethers.parseUnits('50', 18));
    expect(snap.activeUsers).to.equal(1n);

    await stats.pushUserStatsUpdate(await user.getAddress(), 0n, 0n, 0n, ethers.parseUnits('50', 18));
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalDebt).to.equal(0n);
    expect(snap.activeUsers).to.equal(0n);

    expect(ZERO_ADDRESS).to.be.a('string');
  });
});


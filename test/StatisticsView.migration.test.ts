import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;

describe('StatisticsView migration – minimal', function () {
  const KEY_ACM = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
  const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
  const ACTION_VIEW_SYSTEM_STATUS = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_SYSTEM_STATUS'));
  const KEY_RM = ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER'));

  async function deployFixture() {
    const [deployer, user, other] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory('MockAccessControlManager');
    const acm = await ACMF.deploy();

    await registry.setModule(KEY_ACM, await acm.getAddress());
    await acm.grantRole(ACTION_SET_PARAMETER, await deployer.getAddress());
    await acm.grantRole(ACTION_ADMIN, await deployer.getAddress());
    await acm.grantRole(ACTION_VIEW_SYSTEM_STATUS, await user.getAddress());

    const StatsF = await ethers.getContractFactory('StatisticsView');
    const stats = await upgrades.deployProxy(StatsF, [await registry.getAddress()]);

    return { stats, registry, acm, deployer, user, other };
  }

  it('should update global snapshot and active users via pushUserStatsUpdate', async function () {
    const { stats, user } = await deployFixture();

    let snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(0n);
    expect(snap.totalDebt).to.equal(0n);
    expect(snap.activeUsers).to.equal(0n);

    await stats.pushUserStatsUpdate(await user.getAddress(), ethers.parseUnits('100', 18), 0n, 0n, 0n);
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(ethers.parseUnits('100', 18));
    expect(snap.activeUsers).to.equal(1n);

    await stats.pushUserStatsUpdate(await user.getAddress(), 0n, ethers.parseUnits('100', 18), 0n, 0n);
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(0n);
    expect(snap.activeUsers).to.equal(0n);
  });

  it('should revert initialize with zero registry', async function () {
    const StatsF = await ethers.getContractFactory('StatisticsView');
    await expect(upgrades.deployProxy(StatsF, [ethers.ZeroAddress])).to.be.reverted;
  });

  it('getRewardStats should return zero when module missing and rewardRate should remain 0 even when RM present', async function () {
    const { stats, registry, acm, deployer } = await deployFixture();

    let reward = await stats.getRewardStats();
    expect(reward.rewardRate).to.equal(0n);

    const RmF = await ethers.getContractFactory('MockRewardManager');
    const rm = await RmF.deploy();
    await registry.setModule(KEY_RM, await rm.getAddress());
    await acm.grantRole(ACTION_SET_PARAMETER, await deployer.getAddress()); // already granted, safe

    reward = await stats.getRewardStats();
    expect(reward.rewardRate).to.equal(0n);
  });

  it('pushDegradationStats requires admin or viewSystemStatus role', async function () {
    const { stats, user, other, acm } = await deployFixture();

    await expect(
      stats.connect(other).pushDegradationStats({
        totalDegradations: 1,
        lastDegradationTime: 1,
        lastDegradedModule: await user.getAddress(),
        lastDegradationReasonHash: ethers.keccak256(ethers.toUtf8Bytes('reason')),
        fallbackValueUsed: 1,
        totalFallbackValue: 1,
        averageFallbackValue: 1
      })
    ).to.be.revertedWithCustomError(acm, 'MissingRole');

    await expect(
      stats.connect(user).pushDegradationStats({
        totalDegradations: 1,
        lastDegradationTime: 1,
        lastDegradedModule: await user.getAddress(),
        lastDegradationReasonHash: ethers.keccak256(ethers.toUtf8Bytes('reason')),
        fallbackValueUsed: 1,
        totalFallbackValue: 1,
        averageFallbackValue: 1
      })
    ).to.not.be.reverted;
  });
});


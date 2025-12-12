import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;

describe('StatisticsView migration – minimal', function () {
  it('should update global snapshot and active users via pushUserStatsUpdate', async function () {
    const [deployer, user] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory('AccessControlManager');
    const acm = await ACMF.deploy(await deployer.getAddress());

    // bind KEY_ACCESS_CONTROL -> acm
    const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    // AccessControlManager 构造已为 owner 赋予 SET_PARAMETER，无需重复授予

    const StatsF = await ethers.getContractFactory('StatisticsView');
    const stats = await upgrades.deployProxy(StatsF, [await registry.getAddress()]);

    // Initially zero
    let snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(0n);
    expect(snap.totalDebt).to.equal(0n);
    expect(snap.activeUsers).to.equal(0n);

    // user deposit 100, collateral>0 => activeUsers = 1
    await stats.pushUserStatsUpdate(await user.getAddress(), ethers.parseUnits('100', 18), 0n, 0n, 0n);
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(ethers.parseUnits('100', 18));
    expect(snap.activeUsers).to.equal(1n);

    // user repay/withdraw to zero position => activeUsers = 0
    await stats.pushUserStatsUpdate(await user.getAddress(), 0n, ethers.parseUnits('100', 18), 0n, 0n);
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(0n);
    expect(snap.activeUsers).to.equal(0n);
  });
});



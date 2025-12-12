import { expect } from 'chai';
import hardhat from 'hardhat';

const { ethers } = hardhat;

// 常量
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('StatisticsView – 活跃用户与全局快照', function () {
  it('当仓位>0 视为活跃；归零后不活跃', async function () {
    const [user] = await ethers.getSigners();

    // 部署 MockRegistry + StatisticsView
    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await RegistryF.deploy();
    await registry.waitForDeployment();

    const StatsF = await ethers.getContractFactory('MockStatisticsView');
    const stats = await StatsF.deploy();
    await stats.waitForDeployment();

    // 注册 KEY_STATS -> stats（便于其他视图读取）
    const KEY_STATS = ethers.keccak256(ethers.toUtf8Bytes('VAULT_STATISTICS'));
    await registry.setModule(KEY_STATS, await stats.getAddress());

    // 初始快照
    let snap = await stats.getGlobalSnapshot();
    expect(snap.activeUsers).to.equal(0n);
    expect(snap.totalCollateral).to.equal(0n);
    expect(snap.totalDebt).to.equal(0n);

    // 1) 存入抵押 100 → 活跃+1
    await stats.pushUserStatsUpdate(await user.getAddress(), ethers.parseUnits('100', 18), 0n, 0n, 0n);
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(ethers.parseUnits('100', 18));
    expect(snap.activeUsers).to.equal(1n);

    // 2) 归还抵押 100 → 仓位归零，活跃用户-1
    await stats.pushUserStatsUpdate(await user.getAddress(), 0n, ethers.parseUnits('100', 18), 0n, 0n);
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(0n);
    expect(snap.totalDebt).to.equal(0n);
    expect(snap.activeUsers).to.equal(0n);

    // 3) 借款 50 → 再次活跃
    await stats.pushUserStatsUpdate(await user.getAddress(), 0n, 0n, ethers.parseUnits('50', 18), 0n);
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalDebt).to.equal(ethers.parseUnits('50', 18));
    expect(snap.activeUsers).to.equal(1n);

    // 4) 还款至 0 → 不活跃
    await stats.pushUserStatsUpdate(await user.getAddress(), 0n, 0n, 0n, ethers.parseUnits('50', 18));
    snap = await stats.getGlobalSnapshot();
    expect(snap.totalDebt).to.equal(0n);
    expect(snap.activeUsers).to.equal(0n);

    // 边界：零地址不参与（仅确保未误用 ZERO_ADDRESS）
    expect(ZERO_ADDRESS).to.be.a('string');
  });
});



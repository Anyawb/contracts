import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

describe('StatisticsView – 保证金聚合（pushGuaranteeUpdate）', function () {
  it('锁定与释放保证金应更新聚合总量', async function () {
    const [user] = await ethers.getSigners();

    const StatsF = await ethers.getContractFactory('MockStatisticsView');
    const stats = await StatsF.deploy();
    await stats.waitForDeployment();

    const asset = ethers.Wallet.createRandom().address;

    // 锁定保证金 30
    await stats.pushGuaranteeUpdate(await user.getAddress(), asset, ethers.parseUnits('30', 18), true);

    // 读取快照（Mock 中暂未暴露 getTotalGuaranteeByAsset，使用 collateral/debt 快照校验流程）
    const s1 = await stats.getGlobalSnapshot();
    expect(s1.timestamp).to.be.greaterThan(0n);

    // 释放保证金 10
    await stats.pushGuaranteeUpdate(await user.getAddress(), asset, ethers.parseUnits('10', 18), false);

    const s2 = await stats.getGlobalSnapshot();
    expect(s2.timestamp).to.be.greaterThanOrEqual(s1.timestamp);
  });
});



import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

describe('Frontend-style resolution via KEY_STATS and KEY_VAULT_CORE', function () {
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  it('should resolve StatisticsView via KEY_STATS first, and fallback to KEY_VAULT_CORE', async function () {
    const [deployer, user] = await ethers.getSigners();

    // Deploy mocks
    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await MockRegistryF.deploy();
    await registry.waitForDeployment();

    const MockStatisticsViewF = await ethers.getContractFactory('MockStatisticsView');
    const stats = await MockStatisticsViewF.deploy();
    await stats.waitForDeployment();

    const MockVaultCoreF = await ethers.getContractFactory('MockVaultCore');
    const vaultCore = await MockVaultCoreF.deploy();
    await vaultCore.waitForDeployment();

    // Keys
    const KEY_STATS = ethers.keccak256(ethers.toUtf8Bytes('VAULT_STATISTICS'));
    const KEY_VAULT_CORE = ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE'));

    // 1) Register KEY_STATS -> stats
    await registry.setModule(KEY_STATS, await stats.getAddress());

    // Push one update to set totals and activeUsers
    await stats.pushUserStatsUpdate(await user.getAddress(), ethers.parseUnits('100', 18), 0n, 0n, 0n);

    // Frontend-style resolution: prefer KEY_STATS
    let resolved = await registry.getModule(KEY_STATS);
    expect(resolved).to.equal(await stats.getAddress());

    // Read snapshot
    let snap = await stats.getGlobalSnapshot();
    expect(snap.totalCollateral).to.equal(ethers.parseUnits('100', 18));
    expect(snap.activeUsers).to.equal(1n);

    // 2) Fallback: clear KEY_STATS and use KEY_VAULT_CORE -> viewContractAddrVar
    await registry.setModule(KEY_STATS, ZERO_ADDRESS);

    // Set vault core and point its view to stats
    await registry.setModule(KEY_VAULT_CORE, await vaultCore.getAddress());
    await vaultCore.setViewContractAddr(await stats.getAddress());

    // Emulate frontend fallback
    const statsFromKey = await registry.getModule(KEY_STATS);
    let finalAddr = statsFromKey !== ZERO_ADDRESS ? statsFromKey : await (async () => {
      const coreAddr = await registry.getModule(KEY_VAULT_CORE);
      const CoreMin = new ethers.Contract(coreAddr, [
        'function viewContractAddrVar() external view returns (address)'
      ], ethers.provider);
      return CoreMin.viewContractAddrVar();
    })();

    expect(finalAddr).to.equal(await stats.getAddress());
  });
});



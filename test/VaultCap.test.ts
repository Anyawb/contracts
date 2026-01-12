import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';

import { ModuleKeys } from '../frontend-config/moduleKeys';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * CollateralVault – VaultCap 相关测试
 *
 * 测试目标:
 * - VaultCap 可配置并可读取（当前架构：cap 为配置项，存储于 VaultStorage）
 * - 权限控制：仅具备 SET_PARAMETER 可设置；仅具备 ACTION_ADMIN 可读取
 */
describe('VaultStorage – VaultCap 配置测试', function () {
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
  const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));

  async function deployFixture() {
    const [governance, alice] = await ethers.getSigners();

    // Registry + ACM (mock)
    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    await registry.waitForDeployment();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    await acm.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());

    // Tokens required by VaultStorage.initialize
    const erc20Factory = await ethers.getContractFactory('MockERC20');
    const rwaToken = await erc20Factory.connect(governance).deploy('RWA', 'RWA', ethers.parseUnits('1000000', 18));
    await rwaToken.waitForDeployment();
    const settlementToken = await erc20Factory.connect(governance).deploy('SETTLE', 'SET', ethers.parseUnits('1000000', 18));
    await settlementToken.waitForDeployment();

    // VaultStorage via UUPS proxy
    const VaultStorageFactory = await ethers.getContractFactory('VaultStorage');
    const vaultStorage = await upgrades.deployProxy(
      VaultStorageFactory,
      [await registry.getAddress(), await rwaToken.getAddress(), await settlementToken.getAddress()],
      { kind: 'uups', initializer: 'initialize' },
    );
    await vaultStorage.waitForDeployment();

    return { vaultStorage, registry, acm, rwaToken, settlementToken, governance, alice };
  }

  it('VaultCap 可由参数管理员设置，并可由管理员读取', async function () {
    const { vaultStorage, acm, governance } = await deployFixture();

    // governance gets both roles in mock ACM
    await acm.grantRole(ACTION_SET_PARAMETER, governance.address);
    await acm.grantRole(ACTION_ADMIN, governance.address);

    const cap = ethers.parseUnits('100', 18);
    await expect(vaultStorage.connect(governance).setVaultCap(cap)).to.not.be.reverted;
    expect(await vaultStorage.connect(governance).getVaultCap()).to.equal(cap);
  });

  it('无权限用户不能设置或读取 VaultCap', async function () {
    const { vaultStorage, acm, alice } = await deployFixture();

    // no roles granted to alice
    await expect(vaultStorage.connect(alice).setVaultCap(1)).to.be.revertedWithCustomError(acm, 'MissingRole');
    await expect(vaultStorage.connect(alice).getVaultCap()).to.be.revertedWithCustomError(acm, 'MissingRole');
  });
}); 
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));

describe('AuthorityWhitelist registry semantics', function () {
  async function deployFixture() {
    const [admin] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    const AuthorityWhitelistFactory = await ethers.getContractFactory('AuthorityWhitelist');
    const authorityWhitelist = await upgrades.deployProxy(AuthorityWhitelistFactory, [await registry.getAddress()], {
      kind: 'uups',
      initializer: 'initialize',
    });

    await acm.grantRole(ACTION_SET_PARAMETER, admin.address);
    await acm.grantRole(ACTION_ADMIN, admin.address);

    return { admin, acm, registry, authorityWhitelist };
  }

  it('emits RegistryUpdated and does not emit ModuleAddressUpdated when registry changes', async function () {
    const { admin, acm, registry, authorityWhitelist } = await loadFixture(deployFixture);

    const newRegistry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    await newRegistry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    const tx = await authorityWhitelist.connect(admin).setRegistry(await newRegistry.getAddress());
    await expect(tx)
      .to.emit(authorityWhitelist, 'RegistryUpdated')
      .withArgs(await registry.getAddress(), await newRegistry.getAddress());

    const receipt = await tx.wait();
    const moduleAddressUpdatedTopic = ethers.id('ModuleAddressUpdated(string,address,address,uint256)');
    const hasModuleAddressUpdated =
      receipt?.logs.some((log: { topics: readonly string[] }) => log.topics[0] === moduleAddressUpdatedTopic) ?? false;
    expect(hasModuleAddressUpdated).to.equal(false);

    expect(await authorityWhitelist.connect(admin).getRegistry()).to.equal(await newRegistry.getAddress());
  });

  it('rejects zero-address registry updates', async function () {
    const { admin, authorityWhitelist } = await loadFixture(deployFixture);

    await expect(authorityWhitelist.connect(admin).setRegistry(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      authorityWhitelist,
      'ZeroAddress',
    );
  });
});
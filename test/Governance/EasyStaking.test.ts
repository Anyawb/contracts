import { expect } from 'chai';
import hardhat from 'hardhat';

const { ethers } = hardhat;

describe('EasyStaking (stake/unstake + voting power)', () => {
  let owner: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let alice: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let bob: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  let registry: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let easy: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let staking: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  const KEY_EASY_TOKEN = ethers.keccak256(ethers.toUtf8Bytes('EASY_TOKEN'));

  beforeEach(async () => {
    [owner, alice, bob] = await ethers.getSigners();

    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    registry = await MockRegistryF.deploy();
    await registry.waitForDeployment();

    const ProxyF = await ethers.getContractFactory('ERC1967Proxy');

    const EasyImplF = await ethers.getContractFactory('src/Token/EasyToken.sol:EasyToken');
    const easyImpl = await EasyImplF.deploy();
    await easyImpl.waitForDeployment();
    const easyProxy = await ProxyF.deploy(
      await easyImpl.getAddress(),
      easyImpl.interface.encodeFunctionData('initialize', [owner.address])
    );
    await easyProxy.waitForDeployment();
    easy = EasyImplF.attach(await easyProxy.getAddress());

    const MINTER_ROLE = await easy.MINTER_ROLE();
    await easy.connect(owner).grantRole(MINTER_ROLE, owner.address);

    const StakingImplF = await ethers.getContractFactory('src/Governance/EasyStaking.sol:EasyStaking');
    const stakingImpl = await StakingImplF.deploy();
    await stakingImpl.waitForDeployment();
    const stakingProxy = await ProxyF.deploy(
      await stakingImpl.getAddress(),
      stakingImpl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
    );
    await stakingProxy.waitForDeployment();
    staking = StakingImplF.attach(await stakingProxy.getAddress());

    await registry.setModule(KEY_EASY_TOKEN, await easy.getAddress());

    // Seed balances
    await easy.connect(owner).mint(alice.address, ethers.parseUnits('100', 18));
  });

  it('stakes Easy and mints stEASY 1:1 with voting power', async () => {
    const amt = ethers.parseUnits('10', 18);

    await easy.connect(alice).approve(await staking.getAddress(), amt);
    await staking.connect(alice).stake(amt);

    expect(await staking.balanceOf(alice.address)).to.equal(amt);
    expect(await easy.balanceOf(alice.address)).to.equal(ethers.parseUnits('90', 18));
    expect(await staking.getVotes(alice.address)).to.equal(amt);
  });

  it('unstakes and returns Easy', async () => {
    const amt = ethers.parseUnits('5', 18);

    await easy.connect(alice).approve(await staking.getAddress(), amt);
    await staking.connect(alice).stake(amt);

    await staking.connect(alice).unstake(amt);

    expect(await staking.balanceOf(alice.address)).to.equal(0n);
    expect(await easy.balanceOf(alice.address)).to.equal(ethers.parseUnits('100', 18));
  });

  it('reverts on zero amount', async () => {
    await expect(staking.connect(alice).stake(0)).to.be.reverted;
    await expect(staking.connect(alice).unstake(0)).to.be.reverted;
  });

  it('is non-transferable', async () => {
    const amt = ethers.parseUnits('3', 18);
    await easy.connect(alice).approve(await staking.getAddress(), amt);
    await staking.connect(alice).stake(amt);

    await expect(staking.connect(alice).transfer(bob.address, amt)).to.be.reverted;
  });

  it('reverts when unstaking more than balance', async () => {
    const amt = ethers.parseUnits('2', 18);
    await easy.connect(alice).approve(await staking.getAddress(), amt);
    await staking.connect(alice).stake(amt);

    await expect(staking.connect(alice).unstake(ethers.parseUnits('3', 18))).to.be.reverted;
  });
});

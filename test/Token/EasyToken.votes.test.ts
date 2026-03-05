import { expect } from 'chai';
import hardhat from 'hardhat';

const { ethers } = hardhat;

describe('EasyToken as IVotes (SSOT: one-token-two-uses)', () => {
  let owner: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let alice: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let bob: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  let easyToken: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeEach(async () => {
    [owner, alice, bob] = await ethers.getSigners();

    const EasyTokenImplF = await ethers.getContractFactory('src/Token/EasyToken.sol:EasyToken');
    const impl = await EasyTokenImplF.deploy();
    await impl.waitForDeployment();

    const ProxyF = await ethers.getContractFactory('ERC1967Proxy');
    const proxy = await ProxyF.deploy(
      await impl.getAddress(),
      impl.interface.encodeFunctionData('initialize', [owner.address])
    );
    await proxy.waitForDeployment();

    easyToken = EasyTokenImplF.attach(await proxy.getAddress());

    // Make owner the sole minter for tests.
    await easyToken.connect(owner).setSoleMinter(owner.address);
  });

  it('requires delegation to activate voting checkpoints', async () => {
    const amt = ethers.parseUnits('100', 18);
    await easyToken.connect(owner).mint(alice.address, amt);

    // balance exists, but votes default to 0 until delegation
    expect(await easyToken.balanceOf(alice.address)).to.equal(amt);
    expect(await easyToken.getVotes(alice.address)).to.equal(0n);

    await easyToken.connect(alice).delegate(alice.address);
    expect(await easyToken.getVotes(alice.address)).to.equal(amt);
  });

  it('getPastVotes and getPastTotalSupply track snapshots (block.number)', async () => {
    const a = ethers.parseUnits('50', 18);
    const b = ethers.parseUnits('25', 18);

    await easyToken.connect(owner).mint(alice.address, a);
    await easyToken.connect(owner).mint(bob.address, b);
    await easyToken.connect(alice).delegate(alice.address);
    await easyToken.connect(bob).delegate(bob.address);

    // mine 1 so we have a stable past timepoint
    const snap = await ethers.provider.getBlockNumber();
    await ethers.provider.send('hardhat_mine', [ethers.toBeHex(1)]);

    expect(await easyToken.getPastVotes(alice.address, snap)).to.equal(a);
    expect(await easyToken.getPastVotes(bob.address, snap)).to.equal(b);
    expect(await easyToken.getPastTotalSupply(snap)).to.equal(a + b);
  });

  it('transfers move voting units when delegated', async () => {
    const a = ethers.parseUnits('100', 18);
    const t = ethers.parseUnits('40', 18);
    await easyToken.connect(owner).mint(alice.address, a);

    await easyToken.connect(alice).delegate(alice.address);
    await easyToken.connect(bob).delegate(bob.address);

    expect(await easyToken.getVotes(alice.address)).to.equal(a);
    expect(await easyToken.getVotes(bob.address)).to.equal(0n);

    await easyToken.connect(alice).transfer(bob.address, t);

    expect(await easyToken.getVotes(alice.address)).to.equal(a - t);
    expect(await easyToken.getVotes(bob.address)).to.equal(t);
  });
});

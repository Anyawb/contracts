import { expect } from 'chai';
import hardhat from 'hardhat';

const { ethers } = hardhat;

describe('GovernanceGate (SSOT)', () => {
  let owner: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let rewardConfig: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let alice: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  let registry: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let gate: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let easyToken: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  const KEY_REWARD_CONFIG = ethers.keccak256(ethers.toUtf8Bytes('REWARD_CONFIG'));

  beforeEach(async () => {
    [owner, rewardConfig, alice] = await ethers.getSigners();

    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    registry = await MockRegistryF.deploy();
    await registry.waitForDeployment();

    // bind writer identities
    await registry.setModule(KEY_REWARD_CONFIG, rewardConfig.address);

    // GovernanceGate (proxy)
    const GateImplF = await ethers.getContractFactory('src/Governance/GovernanceGate.sol:GovernanceGate');
    const gateImpl = await GateImplF.deploy();
    await gateImpl.waitForDeployment();

    const ProxyF = await ethers.getContractFactory('ERC1967Proxy');
    const gateProxy = await ProxyF.deploy(
      await gateImpl.getAddress(),
      gateImpl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
    );
    await gateProxy.waitForDeployment();
    gate = GateImplF.attach(await gateProxy.getAddress());

    // EasyToken (ERC20Votes) as the governance voting token (IVotes)
    const EasyTokenImplF = await ethers.getContractFactory('src/Token/EasyToken.sol:EasyToken');
    const easyImpl = await EasyTokenImplF.deploy();
    await easyImpl.waitForDeployment();

    const easyProxy = await ProxyF.deploy(
      await easyImpl.getAddress(),
      easyImpl.interface.encodeFunctionData('initialize', [owner.address])
    );
    await easyProxy.waitForDeployment();
    easyToken = EasyTokenImplF.attach(await easyProxy.getAddress());

    // Allow owner to mint for tests.
    const MINTER_ROLE = await easyToken.MINTER_ROLE();
    await (await easyToken.connect(owner).grantRole(MINTER_ROLE, owner.address)).wait();

    // Mine one block so snapshots are always < current block.
    await ethers.provider.send('hardhat_mine', [ethers.toBeHex(1)]);
  });

  it('defaults to enabled, VIP-only; users without access are level-insufficient', async () => {
    const snap = (await ethers.provider.getBlockNumber()) - 1;
    const [ok, reason] = await gate.isEligibleToVote(alice.address, snap, await easyToken.getAddress());
    expect(ok).to.equal(false);
    expect(reason).to.equal(await gate.REASON_LEVEL_INSUFFICIENT());
  });

  it('RewardConfig SSOT writer can push user access; eligibility passes', async () => {
    await gate.connect(rewardConfig).pushUserGovernanceAccess(alice.address, 3); // VIP

    const snap = (await ethers.provider.getBlockNumber()) - 1;
    const [ok, reason] = await gate.isEligibleToVote(alice.address, snap, await easyToken.getAddress());
    expect(ok).to.equal(true);
    expect(reason).to.equal(await gate.REASON_OK());
  });

  it('rejects push from non-RewardConfig writer', async () => {
    await expect(gate.connect(owner).pushUserGovernanceAccess(alice.address, 3)).to.be.reverted;
  });

  it('votesToken==0 is strictly rejected (misconfigured gate)', async () => {
    await gate.connect(rewardConfig).pushUserGovernanceAccess(alice.address, 3); // VIP

    // require votes for voting
    await gate.connect(rewardConfig).setGovernanceGateParams(true, 3, 3, ethers.parseUnits('10', 18), 0);

    const snap = (await ethers.provider.getBlockNumber()) - 1;
    const [ok, reason] = await gate.isEligibleToVote(alice.address, snap, ethers.ZeroAddress);
    expect(ok).to.equal(false);
    expect(reason).to.equal(await gate.REASON_VOTES_TOKEN_ZERO());
  });

  it('enforces getPastVotes threshold when votes token is set', async () => {
    await gate.connect(rewardConfig).pushUserGovernanceAccess(alice.address, 3); // VIP

    await gate.connect(rewardConfig).setGovernanceGateParams(true, 3, 3, ethers.parseUnits('10', 18), 0);

    // votes insufficient (5)
    await (await easyToken.connect(owner).mint(alice.address, ethers.parseUnits('5', 18))).wait();
    await (await easyToken.connect(alice).delegate(alice.address)).wait();
    await ethers.provider.send('hardhat_mine', [ethers.toBeHex(1)]);
    const snap1 = (await ethers.provider.getBlockNumber()) - 1;
    const [ok1, r1] = await gate.isEligibleToVote(alice.address, snap1, await easyToken.getAddress());
    expect(ok1).to.equal(false);
    expect(r1).to.equal(await gate.REASON_VOTES_INSUFFICIENT());

    // votes sufficient (10)
    await (await easyToken.connect(owner).mint(alice.address, ethers.parseUnits('5', 18))).wait();
    await ethers.provider.send('hardhat_mine', [ethers.toBeHex(1)]);
    const snap2 = (await ethers.provider.getBlockNumber()) - 1;
    const [ok2, r2] = await gate.isEligibleToVote(alice.address, snap2, await easyToken.getAddress());
    expect(ok2).to.equal(true);
    expect(r2).to.equal(await gate.REASON_OK());
  });
});


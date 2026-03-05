import { expect } from 'chai';
import hardhat from 'hardhat';

const { ethers } = hardhat;

describe('CrossChainGovernance (gate + veto)', () => {
  let admin: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let alice: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let guardian: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  let registry: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let gate: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let gov: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let easyToken: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let easyStaking: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  const KEY_GOVERNANCE_GATE = ethers.keccak256(ethers.toUtf8Bytes('GOVERNANCE_GATE'));
  const KEY_GOVERNANCE_GUARDIAN = ethers.keccak256(ethers.toUtf8Bytes('GOVERNANCE_GUARDIAN'));
  const KEY_REWARD_CONFIG = ethers.keccak256(ethers.toUtf8Bytes('REWARD_CONFIG'));
  const KEY_EASY_TOKEN = ethers.keccak256(ethers.toUtf8Bytes('EASY_TOKEN'));
  const KEY_EASY_STAKING = ethers.keccak256(ethers.toUtf8Bytes('EASY_STAKING'));

  beforeEach(async () => {
    [admin, alice, guardian] = await ethers.getSigners();

    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    registry = await MockRegistryF.deploy();
    await registry.waitForDeployment();

    // Bind minimal writer identities expected by GovernanceGate
    await registry.setModule(KEY_REWARD_CONFIG, admin.address);

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

    // Bind gate into registry (SSOT)
    await registry.setModule(KEY_GOVERNANCE_GATE, await gate.getAddress());

    // EasyToken (ERC20Votes) is the single governance token (SSOT)
    const EasyTokenImplF = await ethers.getContractFactory('src/Token/EasyToken.sol:EasyToken');
    const easyTokenImpl = await EasyTokenImplF.deploy();
    await easyTokenImpl.waitForDeployment();

    const easyTokenProxy = await ProxyF.deploy(
      await easyTokenImpl.getAddress(),
      easyTokenImpl.interface.encodeFunctionData('initialize', [admin.address])
    );
    await easyTokenProxy.waitForDeployment();
    easyToken = EasyTokenImplF.attach(await easyTokenProxy.getAddress());

    // Bind EasyToken into registry SSOT (staking reads this)
    await registry.setModule(KEY_EASY_TOKEN, await easyToken.getAddress());

    // EasyStaking (stEASY) is the governance voting power SSOT (Registry[KEY_EASY_STAKING])
    const EasyStakingImplF = await ethers.getContractFactory('src/Governance/EasyStaking.sol:EasyStaking');
    const easyStakingImpl = await EasyStakingImplF.deploy();
    await easyStakingImpl.waitForDeployment();

    const easyStakingProxy = await ProxyF.deploy(
      await easyStakingImpl.getAddress(),
      easyStakingImpl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
    );
    await easyStakingProxy.waitForDeployment();
    easyStaking = EasyStakingImplF.attach(await easyStakingProxy.getAddress());

    await registry.setModule(KEY_EASY_STAKING, await easyStaking.getAddress());

    // Allow admin to mint Easy for staking in tests.
    const MINTER_ROLE = await easyToken.MINTER_ROLE();
    await (await easyToken.connect(admin).grantRole(MINTER_ROLE, admin.address)).wait();
    await (await easyToken.connect(admin).mint(alice.address, ethers.parseUnits('100', 18))).wait();

    // Stake to obtain votes; stake() auto self-delegates on first stake.
    await (await easyToken.connect(alice).approve(await easyStaking.getAddress(), ethers.parseUnits('100', 18))).wait();
    await (await easyStaking.connect(alice).stake(ethers.parseUnits('100', 18))).wait();
    await ethers.provider.send('hardhat_mine', [ethers.toBeHex(1)]); // make votes visible to snapshots

    // CrossChainGovernance (proxy)
    const GovImplF = await ethers.getContractFactory('src/Governance/CrossChainGovernance.sol:CrossChainGovernance');
    const govImpl = await GovImplF.deploy();
    await govImpl.waitForDeployment();

    const govProxy = await ProxyF.deploy(
      await govImpl.getAddress(),
      govImpl.interface.encodeFunctionData('initialize', [admin.address, await registry.getAddress()])
    );
    await govProxy.waitForDeployment();
    gov = GovImplF.attach(await govProxy.getAddress());

  // Defaults must be initialized via initializer (upgrade-safe: no inline init in storage vars).
  // We assert here to prevent regressions where defaults accidentally stay 0.
  expect(await gov.minProposalBlocks()).to.be.gt(0n);
  expect(await gov.maxProposalBlocks()).to.be.gt(0n);
  // quorum/voteThreshold can be non-zero by default; keep this assertion loose.
  expect(await gov.quorumBPS()).to.be.gt(0n);
  expect(await gov.voteThresholdBPS()).to.be.gt(0n);

    // Ensure registry is wired (idempotent) and token cache is in sync
    await gov.connect(admin).setRegistry(await registry.getAddress());

    // Make proposals/test fast: min=1, max=100, delay=0; quorumBPS=0 => quorum=0
    await gov.connect(admin).updateGovernanceParameters(1, 100, 0, 0, 0);

    // Configure alice as VIP in GovernanceGate (writer: RewardConfig / admin in this fixture)
    await gate.connect(admin).pushUserGovernanceAccess(alice.address, 3);
  });

  async function mine(n: number) {
    await ethers.provider.send('hardhat_mine', [ethers.toBeHex(n)]);
  }

  it('uses GovernanceGate to allow createProposal without legacy role when gate is configured', async () => {
    await expect(gov.connect(alice).createProposal('p', [], [], 2)).to.not.be.reverted;
  });

  it('guardian veto cancels and blocks execute', async () => {
    const tx = await gov.connect(alice).createProposal('p', [], [], 2);
    const receipt = await tx.wait();
    const proposalId = receipt?.logs?.[0] ? await gov.proposalCount() : await gov.proposalCount();

    await gov.connect(alice).vote(proposalId, 1); // For
    await mine(3);

    await registry.setModule(KEY_GOVERNANCE_GUARDIAN, guardian.address);

    await gov.connect(guardian).vetoProposal(proposalId);

    await expect(gov.connect(admin).executeProposal(proposalId)).to.be.reverted;
  });

  it('non-guardian cannot veto', async () => {
    const tx = await gov.connect(alice).createProposal('p', [], [], 2);
    await tx.wait();
    const proposalId = await gov.proposalCount();

    await registry.setModule(KEY_GOVERNANCE_GUARDIAN, guardian.address);
    await expect(gov.connect(alice).vetoProposal(proposalId)).to.be.reverted;
  });

  it('enforces governanceToken SSOT invariant and supports sync', async () => {
    // Deploy a NEW EasyToken + NEW stEASY and switch Registry[KEY_EASY_STAKING] without syncing governance cache.
    const EasyTokenImplF = await ethers.getContractFactory('src/Token/EasyToken.sol:EasyToken');
    const easyToken2Impl = await EasyTokenImplF.deploy();
    await easyToken2Impl.waitForDeployment();

    const ProxyF = await ethers.getContractFactory('ERC1967Proxy');
    const easyToken2Proxy = await ProxyF.deploy(
      await easyToken2Impl.getAddress(),
      easyToken2Impl.interface.encodeFunctionData('initialize', [admin.address])
    );
    await easyToken2Proxy.waitForDeployment();
    const easyToken2: any = EasyTokenImplF.attach(await easyToken2Proxy.getAddress());

    const MINTER_ROLE = await easyToken2.MINTER_ROLE();
    await (await easyToken2.connect(admin).grantRole(MINTER_ROLE, admin.address)).wait();
    await (await easyToken2.connect(admin).mint(alice.address, ethers.parseUnits('100', 18))).wait();

    // Switch underlying EasyToken for staking module
    await registry.setModule(KEY_EASY_TOKEN, await easyToken2.getAddress());

    const EasyStakingImplF = await ethers.getContractFactory('src/Governance/EasyStaking.sol:EasyStaking');
    const easyStaking2Impl = await EasyStakingImplF.deploy();
    await easyStaking2Impl.waitForDeployment();

    const easyStaking2Proxy = await ProxyF.deploy(
      await easyStaking2Impl.getAddress(),
      easyStaking2Impl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
    );
    await easyStaking2Proxy.waitForDeployment();
    const easyStaking2: any = EasyStakingImplF.attach(await easyStaking2Proxy.getAddress());

    await (await easyToken2.connect(alice).approve(await easyStaking2.getAddress(), ethers.parseUnits('100', 18))).wait();
    await (await easyStaking2.connect(alice).stake(ethers.parseUnits('100', 18))).wait();
    await ethers.provider.send('hardhat_mine', [ethers.toBeHex(1)]);

    await registry.setModule(KEY_EASY_STAKING, await easyStaking2.getAddress());

    // Out-of-sync must revert on security-critical path.
    await expect(gov.connect(alice).createProposal('p', [], [], 2)).to.be.reverted;

    // After syncing, it should work.
    await (await gov.connect(admin).syncGovernanceTokenFromRegistry()).wait();
    await expect(gov.connect(alice).createProposal('p', [], [], 2)).to.not.be.reverted;
  });
});


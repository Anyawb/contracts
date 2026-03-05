import { expect } from 'chai';
import hardhat from 'hardhat';

const { ethers } = hardhat;

describe('FeatureRegistry (SSOT)', () => {
  let owner: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let alice: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let bob: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  let registry: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let fr: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let acm: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  const KEY_REWARD_CONFIG = ethers.keccak256(ethers.toUtf8Bytes('REWARD_CONFIG'));
  const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));

  beforeEach(async () => {
    [owner, alice, bob] = await ethers.getSigners();

    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    registry = await MockRegistryF.deploy();
    await registry.waitForDeployment();

    // ACM (only needed for break-glass / missing role checks)
    const ACMF = await ethers.getContractFactory('AccessControlManager');
    acm = await ACMF.deploy(owner.address);
    await acm.waitForDeployment();
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());

    // Bind RewardConfig SSOT writer as an EOA for unit tests
    await registry.setModule(KEY_REWARD_CONFIG, owner.address);

    // FeatureRegistry (proxy)
    const FRImplF = await ethers.getContractFactory('src/Reward/FeatureRegistry.sol:FeatureRegistry');
    const frImpl = await FRImplF.deploy();
    await frImpl.waitForDeployment();

    const ProxyF = await ethers.getContractFactory('ERC1967Proxy');
    const frProxy = await ProxyF.deploy(
      await frImpl.getAddress(),
      frImpl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
    );
    await frProxy.waitForDeployment();
    fr = FRImplF.attach(await frProxy.getAddress());
  });

  it('allows RewardConfig SSOT writer to set features and enumerates keys', async () => {
    const keyA = ethers.keccak256(ethers.toUtf8Bytes('FEATURE_A'));
    const keyB = ethers.keccak256(ethers.toUtf8Bytes('FEATURE_B'));

    await fr.connect(owner).setFeature(keyA, 3, true, 'ipfs://a'); // VIP
    await fr.connect(owner).setFeature(keyB, 1, false, 'docs://b'); // Standard

    const a = await fr.getFeature(keyA);
    expect(a.minLevel).to.equal(3);
    expect(a.enabled).to.equal(true);
    expect(a.nameOrUri).to.equal('ipfs://a');

    const [keys, total] = await fr.listFeatureKeys(0, 10);
    expect(total).to.equal(2);
    expect(keys).to.deep.equal([keyA, keyB]);
  });

  it('rejects non-writer when missing emergency role', async () => {
    const key = ethers.keccak256(ethers.toUtf8Bytes('FEATURE_X'));
    await expect(fr.connect(alice).setFeature(key, 3, true, 'x')).to.be.reverted;
  });

  it('allows break-glass emergency writer to set features', async () => {
    const ACTION_REWARD_CONFIG_EMERGENCY = ethers.keccak256(ethers.toUtf8Bytes('ACTION_REWARD_CONFIG_EMERGENCY'));

    // grant emergency role to alice
    await acm.grantRole(ACTION_REWARD_CONFIG_EMERGENCY, alice.address);

    const key = ethers.keccak256(ethers.toUtf8Bytes('FEATURE_EMERGENCY'));
    await fr.connect(alice).setFeature(key, 0, true, 'emergency');

    const f = await fr.getFeature(key);
    expect(f.minLevel).to.equal(0);
    expect(f.enabled).to.equal(true);
    expect(f.nameOrUri).to.equal('emergency');
  });

  it('batchSetFeatures enforces array lengths', async () => {
    const key = ethers.keccak256(ethers.toUtf8Bytes('FEATURE_BATCH'));
    await expect(
      fr.connect(owner).batchSetFeatures([key], [3], [true, false], ['u'])
    ).to.be.reverted;
  });
});


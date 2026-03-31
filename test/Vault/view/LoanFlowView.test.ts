import { expect } from 'chai';
import { loadFixture, mine } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
const KEY_LOAN_FLOW_PUSH_MANAGER = ethers.keccak256(ethers.toUtf8Bytes('LOAN_FLOW_PUSH_MANAGER'));
const KEY_REWARD_MANAGER_CORE = ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER_CORE'));

const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
const DATA_TYPE_LOAN_FLOW_UPDATED = ethers.keccak256(ethers.toUtf8Bytes('LOAN_FLOW_UPDATED'));

describe('LoanFlowView', function () {
  async function deployFixture() {
    const [admin, pushManager, rewardManagerCore, viewer, user, other] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_LOAN_FLOW_PUSH_MANAGER, pushManager.address);
    await registry.setModule(KEY_REWARD_MANAGER_CORE, rewardManagerCore.address);

    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, viewer.address);

    const loanFlowView = await upgrades.deployProxy(
      await ethers.getContractFactory('LoanFlowView'),
      [await registry.getAddress()],
      { kind: 'uups', initializer: 'initialize' },
    );

    return { loanFlowView, registry, acm, admin, pushManager, rewardManagerCore, viewer, user, other };
  }

  it('initializes with registry and version info', async function () {
    const { loanFlowView, registry } = await loadFixture(deployFixture);

    expect(await loanFlowView.getRegistry()).to.equal(await registry.getAddress());
    expect(await loanFlowView.apiVersion()).to.equal(1n);
    expect(await loanFlowView.schemaVersion()).to.equal(1n);
  });

  it('caches user/global loan flow and emits DataPushed', async function () {
    const { loanFlowView, pushManager, user } = await loadFixture(deployFixture);

    const requestId = ethers.keccak256(ethers.toUtf8Bytes('loan-flow-1'));
    const tx = await loanFlowView
      .connect(pushManager)
      .pushUserLoanFlowUpdate(user.address, 150_00000000n, 25_00000000n, 2n, 1n, requestId, 7n, 1n);

    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber!);
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256', 'uint256', 'uint64', 'bytes32', 'uint64', 'uint256'],
      [user.address, 150_00000000n, 25_00000000n, 1n, requestId, 7n, block!.number],
    );

    await expect(tx).to.emit(loanFlowView, 'DataPushed').withArgs(DATA_TYPE_LOAN_FLOW_UPDATED, payload);

    const [borrowVolume, repayVolume, borrowCount, repayCount, version, seq, lastRequestId, isValid, blockNumber] =
      await loanFlowView.connect(user).getUserLoanFlowWithMeta(user.address);
    expect(borrowVolume).to.equal(150_00000000n);
    expect(repayVolume).to.equal(25_00000000n);
    expect(borrowCount).to.equal(2n);
    expect(repayCount).to.equal(1n);
    expect(version).to.equal(1n);
    expect(seq).to.equal(7n);
    expect(lastRequestId).to.equal(requestId);
    expect(isValid).to.equal(true);
    expect(blockNumber).to.equal(block!.number);

    const [globalBorrow, globalRepay, globalBorrowCount, globalRepayCount, globalValid, globalBlockNumber] =
      await loanFlowView.getGlobalLoanFlowWithMeta();
    expect(globalBorrow).to.equal(150_00000000n);
    expect(globalRepay).to.equal(25_00000000n);
    expect(globalBorrowCount).to.equal(2n);
    expect(globalRepayCount).to.equal(1n);
    expect(globalValid).to.equal(true);
    expect(globalBlockNumber).to.equal(block!.number);
  });

  it('allows self-read, blocks unauthorized non-self reads, and permits VIEW_USER_DATA readers', async function () {
    const { loanFlowView, pushManager, user, other, viewer } = await loadFixture(deployFixture);

    await loanFlowView
      .connect(pushManager)
      .pushUserLoanFlowUpdate(user.address, 10n, 0n, 1n, 0n, ethers.ZeroHash, 0n, 0n);

    await expect(loanFlowView.connect(user).getUserLoanFlowWithMeta(user.address)).to.not.be.reverted;
    await expect(loanFlowView.connect(other).getUserLoanFlowWithMeta(user.address)).to.be.revertedWithCustomError(
      loanFlowView,
      'MissingRole',
    );
    await expect(loanFlowView.connect(viewer).getUserLoanFlowWithMeta(user.address)).to.not.be.reverted;
  });

  it('restricts reward borrow-flow reads to RewardManagerCore or admin', async function () {
    const { loanFlowView, pushManager, rewardManagerCore, admin, user, other } = await loadFixture(deployFixture);

    await loanFlowView
      .connect(pushManager)
      .pushUserLoanFlowUpdate(user.address, 99n, 12n, 1n, 1n, ethers.ZeroHash, 0n, 0n);

    await expect(loanFlowView.connect(other).getUserBorrowFlowForReward(user.address)).to.be.revertedWithCustomError(
      loanFlowView,
      'MissingRole',
    );

    const [borrowFlow, borrowCount, isValid, blockNumber] = await loanFlowView
      .connect(rewardManagerCore)
      .getUserBorrowFlowForReward(user.address);
    expect(borrowFlow).to.equal(99n);
    expect(borrowCount).to.equal(1n);
    expect(isValid).to.equal(true);
    expect(blockNumber).to.not.equal(0n);

    await expect(loanFlowView.connect(admin).getUserBorrowFlowForReward(user.address)).to.not.be.reverted;
  });

  it('enforces writer gating, idempotent replay, and sequence/version monotonicity', async function () {
    const { loanFlowView, pushManager, user, other } = await loadFixture(deployFixture);

    await expect(
      loanFlowView.connect(other).pushUserLoanFlowUpdate(user.address, 1n, 0n, 1n, 0n, ethers.ZeroHash, 0n, 0n),
    ).to.be.revertedWithCustomError(loanFlowView, 'MissingRole');

    const requestId = ethers.keccak256(ethers.toUtf8Bytes('loan-flow-idempotent'));
    await loanFlowView
      .connect(pushManager)
      .pushUserLoanFlowUpdate(user.address, 20n, 0n, 1n, 0n, requestId, 1n, 1n);

    await expect(
      loanFlowView
        .connect(pushManager)
        .pushUserLoanFlowUpdate(user.address, 20n, 0n, 1n, 0n, requestId, 1n, 1n),
    ).to.emit(loanFlowView, 'IdempotentRequestIgnored').withArgs(user.address, requestId, 1n);

    await expect(
      loanFlowView
        .connect(pushManager)
        .pushUserLoanFlowUpdate(user.address, 1n, 0n, 0n, 0n, ethers.keccak256(ethers.toUtf8Bytes('stale-version')), 2n, 3n),
    ).to.be.revertedWithCustomError(loanFlowView, 'LoanFlowView__StaleVersion');

    await expect(
      loanFlowView
        .connect(pushManager)
        .pushUserLoanFlowUpdate(user.address, 1n, 0n, 0n, 0n, ethers.keccak256(ethers.toUtf8Bytes('stale-seq')), 1n, 2n),
    ).to.be.revertedWithCustomError(loanFlowView, 'LoanFlowView__OutOfOrderSeq');
  });

  it('expires cache validity after TTL and exposes version to the pusher', async function () {
    const { loanFlowView, pushManager, user, other, admin } = await loadFixture(deployFixture);

    await loanFlowView
      .connect(pushManager)
      .pushUserLoanFlowUpdate(user.address, 100n, 50n, 1n, 1n, ethers.ZeroHash, 0n, 0n);

    expect(await loanFlowView.connect(pushManager).getUserLoanFlowVersionForPusher(user.address)).to.equal(1n);
    expect(await loanFlowView.connect(admin).getUserLoanFlowVersionForPusher(user.address)).to.equal(1n);
    await expect(loanFlowView.connect(other).getUserLoanFlowVersionForPusher(user.address)).to.be.revertedWithCustomError(
      loanFlowView,
      'MissingRole',
    );

    await mine(151);
    const [, , , , , , , isValid] = await loanFlowView.connect(user).getUserLoanFlowWithMeta(user.address);
    expect(isValid).to.equal(false);
  });
});
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import hardhat from 'hardhat';
const { ethers } = hardhat;

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { maturityBlockAfterDays, REWARD_ON_LOAN_EVENT_BY_ORDER_FULL_SIGNATURE } from '../helpers/rewardSsot';

// Dynamic signature helper to avoid TS type drift.
function callBySignature(contract: unknown, signature: string) {
  return (...args: unknown[]) => (contract as { [k: string]: (...xs: unknown[]) => Promise<unknown> })[signature](...args);
}

const PUSH_FAILED_IFACE = new ethers.Interface([
  'event RewardViewPushFailed(address indexed user, address indexed rewardView, bytes32 indexed op, bytes payload, bytes reason)',
]);
const REWARD_VIEW_UNAVAILABLE_HEX = ethers.hexlify(ethers.toUtf8Bytes('rewardView unavailable')).toLowerCase();
const REWARD_VIEW_OP_USER_LEVEL = ethers.id('USER_LEVEL');

function getRewardViewPushFailed(receipt: any, emitter: string) {
  return (receipt?.logs ?? [])
    .filter((log: any) => String(log.address ?? '').toLowerCase() === emitter.toLowerCase())
    .map((log: any) => {
      try {
        const parsed = PUSH_FAILED_IFACE.parseLog(log);
        return parsed?.args ?? null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

describe('RewardManager ↔ RewardManagerCore (architecture-aligned integration)', function () {
  const SIG_ON_LOAN_EVENT_BY_ORDER = REWARD_ON_LOAN_EVENT_BY_ORDER_FULL_SIGNATURE;

  let governance!: SignerWithAddress;
  let alice!: SignerWithAddress;
  let bob!: SignerWithAddress;
  let orderEngine!: SignerWithAddress;

  async function fixture() {
    [governance, alice, bob, orderEngine] = await ethers.getSigners();

    // Deploy ACM.
    const ACM = await ethers.getContractFactory('AccessControlManager');
    const acm: any = await ACM.deploy(governance.address);
    await acm.waitForDeployment();

    // Mock Registry (simple module map).
    const MockRegistry = await ethers.getContractFactory('MockRegistry');
    const registry: any = await MockRegistry.deploy();
    await registry.waitForDeployment();

    const proxyFactory = await ethers.getContractFactory('ERC1967Proxy');

    // EasyToken proxy (governance token SSOT).
    const EasyToken = await ethers.getContractFactory('src/Token/EasyToken.sol:EasyToken');
    const easyTokenImpl: any = await EasyToken.deploy();
    await easyTokenImpl.waitForDeployment();
    const easyTokenProxy = await proxyFactory.deploy(
      await easyTokenImpl.getAddress(),
      (easyTokenImpl.interface as any).encodeFunctionData('initialize', [governance.address]),
    );
    await easyTokenProxy.waitForDeployment();
    const easyToken: any = EasyToken.attach(await easyTokenProxy.getAddress());

    // RewardManagerCore proxy (strict initializer: registry only).
    const RewardManagerCore = await ethers.getContractFactory('RewardManagerCore');
    const rewardManagerCoreImpl: any = await RewardManagerCore.deploy();
    await rewardManagerCoreImpl.waitForDeployment();
    const rewardManagerCoreProxy = await proxyFactory.deploy(
      await rewardManagerCoreImpl.getAddress(),
      (rewardManagerCoreImpl.interface as any).encodeFunctionData('initialize', [registry.target]),
    );
    await rewardManagerCoreProxy.waitForDeployment();
    const rewardManagerCore: any = RewardManagerCore.attach(await rewardManagerCoreProxy.getAddress());

    // RewardAccrualManager proxy (penalty ledger SSOT).
    const RewardAccrualManager = await ethers.getContractFactory('RewardAccrualManager');
    const rewardAccrualManagerImpl: any = await RewardAccrualManager.deploy();
    await rewardAccrualManagerImpl.waitForDeployment();
    const rewardAccrualManagerProxy = await proxyFactory.deploy(
      await rewardAccrualManagerImpl.getAddress(),
      (rewardAccrualManagerImpl.interface as any).encodeFunctionData('initialize', [registry.target]),
    );
    await rewardAccrualManagerProxy.waitForDeployment();
    const rewardAccrualManager: any = RewardAccrualManager.attach(await rewardAccrualManagerProxy.getAddress());

    // RewardManager proxy.
    const RewardManager = await ethers.getContractFactory('RewardManager');
    const rewardManagerImpl: any = await RewardManager.deploy();
    await rewardManagerImpl.waitForDeployment();
    const rewardManagerProxy = await proxyFactory.deploy(
      await rewardManagerImpl.getAddress(),
      (rewardManagerImpl.interface as any).encodeFunctionData('initialize', [registry.target]),
    );
    await rewardManagerProxy.waitForDeployment();
    const rewardManager: any = RewardManager.attach(await rewardManagerProxy.getAddress());

    // EarnConfig proxy (governance SSOT submodule).
    const EarnConfig = await ethers.getContractFactory('EarnConfig');
    const earnConfigImpl: any = await EarnConfig.deploy();
    await earnConfigImpl.waitForDeployment();
    const earnConfigProxy = await proxyFactory.deploy(
      await earnConfigImpl.getAddress(),
      (earnConfigImpl.interface as any).encodeFunctionData('initialize', [registry.target]),
    );
    await earnConfigProxy.waitForDeployment();
    const earnConfig: any = EarnConfig.attach(await earnConfigProxy.getAddress());

    // RewardConfig proxy (governance SSOT facade).
    const RewardConfig = await ethers.getContractFactory('RewardConfig');
    const rewardConfigImpl: any = await RewardConfig.deploy();
    await rewardConfigImpl.waitForDeployment();
    const rewardConfigProxy = await proxyFactory.deploy(
      await rewardConfigImpl.getAddress(),
      (rewardConfigImpl.interface as any).encodeFunctionData('initialize', [registry.target]),
    );
    await rewardConfigProxy.waitForDeployment();
    const rewardConfig: any = RewardConfig.attach(await rewardConfigProxy.getAddress());

    // RewardView proxy (read SSOT).
    const RewardView = await ethers.getContractFactory('RewardView');
    const rewardViewImpl: any = await RewardView.deploy();
    await rewardViewImpl.waitForDeployment();
    const rewardViewProxy = await proxyFactory.deploy(
      await rewardViewImpl.getAddress(),
      (rewardViewImpl.interface as any).encodeFunctionData('initialize', [registry.target]),
    );
    await rewardViewProxy.waitForDeployment();
    const rewardView: any = RewardView.attach(await rewardViewProxy.getAddress());

    // LoanFlowView proxy (protocol value SSOT). RMCore reads best-effort.
    const LoanFlowView = await ethers.getContractFactory('LoanFlowView');
    const loanFlowViewImpl: any = await LoanFlowView.deploy();
    await loanFlowViewImpl.waitForDeployment();
    const loanFlowViewProxy = await proxyFactory.deploy(
      await loanFlowViewImpl.getAddress(),
      (loanFlowViewImpl.interface as any).encodeFunctionData('initialize', [registry.target]),
    );
    await loanFlowViewProxy.waitForDeployment();
    const loanFlowView: any = LoanFlowView.attach(await loanFlowViewProxy.getAddress());

    // Registry module wiring (ModuleKeys SSOT).
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')), await acm.getAddress());
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('ORDER_ENGINE')), orderEngine.address);
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER')), await rewardManager.getAddress());
    await registry.setModule(
      ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER_CORE')),
      await rewardManagerCore.getAddress(),
    );
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('REWARD_CONFIG')), await rewardConfig.getAddress());
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('REWARD_EARN_CONFIG')), await earnConfig.getAddress());
    await registry.setModule(
      ethers.keccak256(ethers.toUtf8Bytes('REWARD_ACCRUAL_MANAGER')),
      await rewardAccrualManager.getAddress(),
    );
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('EASY_TOKEN')), easyToken.target);
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('GUARANTEE_FUND_MANAGER')), governance.address);
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('REWARD_VIEW')), await rewardView.getAddress());
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('LOAN_FLOW_VIEW')), await loanFlowView.getAddress());

    // Roles.
    const ROLE_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    const ROLE_UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
    const ROLE_CLAIM_REWARD = ethers.keccak256(ethers.toUtf8Bytes('CLAIM_REWARD'));
    const ROLE_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
    const ROLE_VIEW_SYSTEM_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
    const ROLE_ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));

    // AccessControlManager reverts on duplicate grants; keep fixture idempotent.
    const ensureRole = async (role: string, who: string) => {
      const has = await acm.hasRole(role, who);
      if (!has) await acm.grantRole(role, who);
    };
    await ensureRole(ROLE_SET_PARAMETER, governance.address);
    await ensureRole(ROLE_UPGRADE_MODULE, governance.address);
    await ensureRole(ROLE_VIEW_USER_DATA, governance.address);
    await ensureRole(ROLE_VIEW_SYSTEM_DATA, governance.address);
    await ensureRole(ROLE_ACTION_ADMIN, governance.address);
    await ensureRole(ROLE_CLAIM_REWARD, orderEngine.address);

    // Penalty SSOT moved to RewardAccrualManager: it attempts EasyToken.burn first, then falls back to penalty ledger.
    await easyToken.connect(governance).grantRole(await easyToken.BURNER_ROLE(), await rewardAccrualManager.getAddress());

    return { registry, easyToken, rewardManagerCore, rewardAccrualManager, rewardManager, rewardView, rewardConfig, earnConfig };
  }

  it('RewardManager write entry only allows OrderEngine (order-based)', async function () {
    const { rewardManager } = await loadFixture(fixture);
    const maturity = await maturityBlockAfterDays(30n);

    await expect(
      callBySignature(rewardManager.connect(alice), SIG_ON_LOAN_EVENT_BY_ORDER)(alice.address, 1, 1_000e6, maturity, 0),
    ).to.be.revertedWithCustomError(rewardManager, 'MissingRole');
  });

  it('RewardManagerCore rejects direct earn entry (order-based)', async function () {
    const { rewardManagerCore } = await loadFixture(fixture);
    const maturity = await maturityBlockAfterDays(30n);

    await expect(
      callBySignature(rewardManagerCore.connect(alice), SIG_ON_LOAN_EVENT_BY_ORDER)(alice.address, 1, 1_000e6, maturity, 0),
    ).to.be.revertedWithCustomError(rewardManagerCore, 'RewardManagerCore__UseRewardManagerEntry');
  });

  it('Order-based: borrow locks, on-time repay releases and records earned (1e18 baseline)', async function () {
    const { rewardManager, easyToken, rewardView } = await loadFixture(fixture);

    const principal = 1_000e6; // 1000 USDC (6 decimals) min-eligible threshold
    const maturity = await maturityBlockAfterDays(30n);

    // Borrow (outcome=Borrow): lock 1 point (no mint yet).
    await expect(
      callBySignature(rewardManager.connect(orderEngine), SIG_ON_LOAN_EVENT_BY_ORDER)(
        alice.address,
        1,
        principal,
        maturity,
        0,
      ),
    ).to.not.be.reverted;
    expect(await easyToken.balanceOf(alice.address)).to.equal(0n);

    const [lockedAfterBorrow, eligibleAfterBorrow, onTimeAfterBorrow] = await rewardView
      .connect(alice)
      .getUserEarnStateWithMeta(alice.address);
    expect(lockedAfterBorrow).to.equal(ethers.parseUnits('1', 18));
    expect(eligibleAfterBorrow).to.equal(1n);
    expect(onTimeAfterBorrow).to.equal(0n);

    // Repay on-time full (outcome=1): token minting is handled elsewhere (EasyEmissionController).
    // RewardManagerCore does not update the EasyToken lifetime mint read model directly on this path.
    // We only assert that repay does not introduce penalty side effects on this path.
    await expect(
      callBySignature(rewardManager.connect(orderEngine), SIG_ON_LOAN_EVENT_BY_ORDER)(
        alice.address,
        1,
        principal,
        maturity,
        1,
      ),
    ).to.not.be.reverted;
    expect(await easyToken.balanceOf(alice.address)).to.equal(0n);

    // RewardView is the read SSOT: should not show penalty/burn for on-time full repay.
    const [burned, pendingPenalty] = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    expect(burned).to.equal(0n);
    expect(pendingPenalty).to.equal(0n);

    const [lockedAfterRepay, eligibleAfterRepay, onTimeAfterRepay] = await rewardView
      .connect(alice)
      .getUserEarnStateWithMeta(alice.address);
    expect(lockedAfterRepay).to.equal(0n);
    expect(eligibleAfterRepay).to.equal(1n);
    expect(onTimeAfterRepay).to.equal(1n);
  });

  it('Locked points formula: level multiplier + dynamic reward are reflected in late penalty base', async function () {
    const { rewardManager, rewardView } = await loadFixture(fixture);

    const principal = 1_000e6;
    const maturity = await maturityBlockAfterDays(30n);

    // Governance sets user level and parameters.
    await rewardManager.connect(governance).updateUserLevel(alice.address, 3);
    await rewardManager.connect(governance).setLevelMultiplier(3, 20_000); // 2x
    await rewardManager.connect(governance).setDynamicRewardParams(ethers.parseUnits('1', 18), 2_000); // +20%
    await rewardManager.connect(governance).setLatePenaltyBps(500n); // latePenaltyBps = 5%

    // Borrow locks: 1e18 * 2x => 2e18; then +20% => 2.4e18
    await callBySignature(rewardManager.connect(orderEngine), SIG_ON_LOAN_EVENT_BY_ORDER)(
      alice.address,
      10,
      principal,
      maturity,
      0,
    );
    // Late repay: burn fails (0 balance), so pendingPenalty tracks the computed penalty.
    await callBySignature(rewardManager.connect(orderEngine), SIG_ON_LOAN_EVENT_BY_ORDER)(
      alice.address,
      10,
      principal,
      maturity,
      3,
    );
    const [, pendingPenalty0] = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    expect(pendingPenalty0).to.equal(ethers.parseUnits('0.12', 18)); // 2.4e18 * 5%

    // Disable dynamic reward: next order penalty base becomes 2e18 (2x only).
    await rewardManager.connect(governance).setDynamicRewardParams(0n, 0n);
    await callBySignature(rewardManager.connect(orderEngine), SIG_ON_LOAN_EVENT_BY_ORDER)(
      alice.address,
      11,
      principal,
      maturity,
      0,
    );
    await callBySignature(rewardManager.connect(orderEngine), SIG_ON_LOAN_EVENT_BY_ORDER)(
      alice.address,
      11,
      principal,
      maturity,
      3,
    );
    const [, pendingPenalty1] = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    expect(pendingPenalty1).to.equal(ethers.parseUnits('0.22', 18)); // 0.12 + (2.0e18 * 5% = 0.10)
  });

  it('Late repay penalty is best-effort: if burn fails, penaltyLedger is pushed to RewardView', async function () {
    const { rewardManager, rewardView } = await loadFixture(fixture);

    const principal = 1_000e6;
    const maturity = await maturityBlockAfterDays(30n);

    // Borrow locks.
    await callBySignature(rewardManager.connect(orderEngine), SIG_ON_LOAN_EVENT_BY_ORDER)(
      bob.address,
      2,
      principal,
      maturity,
      0,
    );

    // Late repay: bob has 0 points, so burn will fail and penalty ledger should increase.
    await callBySignature(rewardManager.connect(orderEngine), SIG_ON_LOAN_EVENT_BY_ORDER)(
      bob.address,
      2,
      principal,
      maturity,
      3,
    );

    const [, pendingPenalty] = await rewardView.connect(bob).getUserRewardSummaryWithMeta(bob.address);
    expect(pendingPenalty).to.be.greaterThan(0n);
  });

  it('Late penalty scales linearly with lockedPoints (multiplier affects penalty base)', async function () {
    const { rewardManager, rewardView } = await loadFixture(fixture);

    const principal = 1_000e6;
    const maturity = await maturityBlockAfterDays(30n);

    // Governance: set bob level=3 (2x) and enable late penalty 5%.
    await rewardManager.connect(governance).updateUserLevel(bob.address, 3);
    await rewardManager.connect(governance).setLevelMultiplier(3, 20_000); // 2x
    await rewardManager.connect(governance).setDynamicRewardParams(0n, 0n); // keep clean
    await rewardManager.connect(governance).setLatePenaltyBps(500n); // latePenaltyBps = 5%

    // Borrow locks 2e18.
    await callBySignature(rewardManager.connect(orderEngine), SIG_ON_LOAN_EVENT_BY_ORDER)(
      bob.address,
      20,
      principal,
      maturity,
      0,
    );

    // Late repay: burn fails (0 points), so penaltyLedger should be 2e18 * 5% = 0.1e18
    await callBySignature(rewardManager.connect(orderEngine), SIG_ON_LOAN_EVENT_BY_ORDER)(
      bob.address,
      20,
      principal,
      maturity,
      3,
    );

    const [, pendingPenalty] = await rewardView.connect(bob).getUserRewardSummaryWithMeta(bob.address);
    expect(pendingPenalty).to.equal(ethers.parseUnits('0.1', 18));
  });

  it('Governance can set late penalty bps via RewardManager', async function () {
    const { rewardManager } = await loadFixture(fixture);

    await expect(rewardManager.connect(governance).setLatePenaltyBps(500)).to.not.be.reverted;
  });

  it('GuaranteeFund-triggered liquidation penalty uses lockedEasy as the reward-unit base', async function () {
    const { rewardManager, rewardView } = await loadFixture(fixture);

    const principal = 1_000e6;
    const maturity = await maturityBlockAfterDays(30n);

    await rewardManager.connect(governance).setLiquidationPenaltyBps(500n);

    await callBySignature(rewardManager.connect(orderEngine), SIG_ON_LOAN_EVENT_BY_ORDER)(
      alice.address,
      77,
      principal,
      maturity,
      0,
    );

    const quotedPenalty = await rewardManager.quoteLiquidationPenalty(alice.address);
    expect(quotedPenalty).to.equal(ethers.parseUnits('0.05', 18));

    await expect(rewardManager.connect(governance).applyLiquidationPenalty(alice.address))
      .to.emit(rewardManager, 'PenaltyApplied')
      .withArgs(governance.address, alice.address, quotedPenalty, anyValue);

    const [, pendingPenalty] = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    expect(pendingPenalty).to.equal(quotedPenalty);
  });

  it('Governance can update user level (mirrored into RewardView)', async function () {
    const { rewardManager, rewardView } = await loadFixture(fixture);

    await rewardManager.connect(governance).updateUserLevel(alice.address, 3);
    const [, , level] = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    expect(level).to.equal(3);

    await expect(rewardManager.connect(governance).updateUserLevel(alice.address, 0)).to.be.revertedWithCustomError(
      rewardManager,
      'RewardManager__InvalidLevel',
    );
  });

  it('best-effort USER_LEVEL push failure emits RewardViewPushFailed and admin replay repairs RewardView cache', async function () {
    const { registry, rewardManager, rewardManagerCore, rewardView } = await loadFixture(fixture);

    const MockRewardViewUnavailable = await ethers.getContractFactory('MockRewardViewUnavailable');
    const unavailableRewardView: any = await MockRewardViewUnavailable.deploy();
    await unavailableRewardView.waitForDeployment();

    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('REWARD_VIEW')), await unavailableRewardView.getAddress());

    const tx = await rewardManager.connect(governance).updateUserLevel(alice.address, 4);
    const receipt = await tx.wait();

    const events = getRewardViewPushFailed(receipt, await rewardManagerCore.getAddress());
    expect(events).to.have.length(1);
    expect(events[0].user).to.equal(alice.address);
    expect(String(events[0].rewardView)).to.equal(await unavailableRewardView.getAddress());
    expect(String(events[0].op).toLowerCase()).to.equal(REWARD_VIEW_OP_USER_LEVEL.toLowerCase());
    expect(ethers.hexlify(events[0].reason).toLowerCase()).to.equal(REWARD_VIEW_UNAVAILABLE_HEX);

    const [, , staleLevel] = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    expect(staleLevel).to.equal(0n);

    expect(await rewardView.connect(orderEngine).getUserLevelForBorrowCheck(alice.address)).to.equal(0n);

    await rewardView.connect(governance).retryPushUserLevel(alice.address, 4, BigInt(receipt!.blockNumber));

    const [, , repairedLevel, lastActivity] = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    expect(repairedLevel).to.equal(4n);
    expect(lastActivity).to.equal(BigInt(receipt!.blockNumber));
    expect(await rewardView.connect(orderEngine).getUserLevelForBorrowCheck(alice.address)).to.equal(4n);
  });
});


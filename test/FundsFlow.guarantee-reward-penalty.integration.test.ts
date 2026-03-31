import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import hardhat from 'hardhat';

const { ethers } = hardhat;

describe('FundsFlow – guarantee default reward penalty integration', function () {
  const MODULE_KEYS = {
    ACCESS_CONTROL: ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
    VAULT_CORE: ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE')),
    SETTLEMENT_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('SETTLEMENT_MANAGER')),
    GUARANTEE_FUND: ethers.keccak256(ethers.toUtf8Bytes('GUARANTEE_FUND_MANAGER')),
    EARLY_REPAYMENT_GUARANTEE: ethers.keccak256(ethers.toUtf8Bytes('EARLY_REPAYMENT_GUARANTEE_MANAGER')),
    REWARD_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER')),
    REWARD_MANAGER_CORE: ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER_CORE')),
    REWARD_ACCRUAL_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('REWARD_ACCRUAL_MANAGER')),
    REWARD_VIEW: ethers.keccak256(ethers.toUtf8Bytes('REWARD_VIEW')),
    EASY_TOKEN: ethers.keccak256(ethers.toUtf8Bytes('EASY_TOKEN')),
    ORDER_ENGINE: ethers.keccak256(ethers.toUtf8Bytes('ORDER_ENGINE')),
  } as const;

  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
  const PRINCIPAL = ethers.parseEther('1000');
  const PROMISED_INTEREST = ethers.parseEther('100');
  const TERM_DAYS = 30;
  const LIQUIDATION_BPS = 500n;

  async function fixture() {
    const [governance, vaultCore, settlementManager, orderEngine, borrower, lender] = await ethers.getSigners();

    const proxyFactory = await ethers.getContractFactory('ERC1967Proxy');

    const MockRegistry = await ethers.getContractFactory('MockRegistry');
    const registry: any = await MockRegistry.deploy();
    await registry.waitForDeployment();

    const MockACM = await ethers.getContractFactory('MockAccessControlManager');
    const acm: any = await MockACM.deploy();
    await acm.waitForDeployment();
    await acm.grantRole(ACTION_SET_PARAMETER, governance.address);

    const EasyToken = await ethers.getContractFactory('src/Token/EasyToken.sol:EasyToken');
    const easyTokenImpl: any = await EasyToken.deploy();
    await easyTokenImpl.waitForDeployment();
    const easyTokenProxy = await proxyFactory.deploy(
      await easyTokenImpl.getAddress(),
      (easyTokenImpl.interface as any).encodeFunctionData('initialize', [governance.address]),
    );
    await easyTokenProxy.waitForDeployment();
    const easyToken: any = EasyToken.attach(await easyTokenProxy.getAddress());

    const RewardManagerCore = await ethers.getContractFactory('RewardManagerCore');
    const rewardManagerCoreImpl: any = await RewardManagerCore.deploy();
    await rewardManagerCoreImpl.waitForDeployment();
    const rewardManagerCoreProxy = await proxyFactory.deploy(
      await rewardManagerCoreImpl.getAddress(),
      (rewardManagerCoreImpl.interface as any).encodeFunctionData('initialize', [registry.target]),
    );
    await rewardManagerCoreProxy.waitForDeployment();
    const rewardManagerCore: any = RewardManagerCore.attach(await rewardManagerCoreProxy.getAddress());

    const RewardAccrualManager = await ethers.getContractFactory('RewardAccrualManager');
    const rewardAccrualManagerImpl: any = await RewardAccrualManager.deploy();
    await rewardAccrualManagerImpl.waitForDeployment();
    const rewardAccrualManagerProxy = await proxyFactory.deploy(
      await rewardAccrualManagerImpl.getAddress(),
      (rewardAccrualManagerImpl.interface as any).encodeFunctionData('initialize', [registry.target]),
    );
    await rewardAccrualManagerProxy.waitForDeployment();
    const rewardAccrualManager: any = RewardAccrualManager.attach(await rewardAccrualManagerProxy.getAddress());

    const RewardManager = await ethers.getContractFactory('RewardManager');
    const rewardManagerImpl: any = await RewardManager.deploy();
    await rewardManagerImpl.waitForDeployment();
    const rewardManagerProxy = await proxyFactory.deploy(
      await rewardManagerImpl.getAddress(),
      (rewardManagerImpl.interface as any).encodeFunctionData('initialize', [registry.target]),
    );
    await rewardManagerProxy.waitForDeployment();
    const rewardManager: any = RewardManager.attach(await rewardManagerProxy.getAddress());

    const RewardView = await ethers.getContractFactory('RewardView');
    const rewardViewImpl: any = await RewardView.deploy();
    await rewardViewImpl.waitForDeployment();
    const rewardViewProxy = await proxyFactory.deploy(
      await rewardViewImpl.getAddress(),
      (rewardViewImpl.interface as any).encodeFunctionData('initialize', [registry.target]),
    );
    await rewardViewProxy.waitForDeployment();
    const rewardView: any = RewardView.attach(await rewardViewProxy.getAddress());

    const GuaranteeFundManager = await ethers.getContractFactory('GuaranteeFundManager');
    const gfmImpl: any = await GuaranteeFundManager.deploy();
    await gfmImpl.waitForDeployment();
    const gfmProxy = await proxyFactory.deploy(
      await gfmImpl.getAddress(),
      (gfmImpl.interface as any).encodeFunctionData('initialize', [vaultCore.address, registry.target, governance.address]),
    );
    await gfmProxy.waitForDeployment();
    const gfm: any = GuaranteeFundManager.attach(await gfmProxy.getAddress());

    const ERGM = await ethers.getContractFactory('EarlyRepaymentGuaranteeManager');
    const ergmImpl: any = await ERGM.deploy();
    await ergmImpl.waitForDeployment();
    const ergmProxy = await proxyFactory.deploy(
      await ergmImpl.getAddress(),
      (ergmImpl.interface as any).encodeFunctionData('initialize', [registry.target, governance.address, 100]),
    );
    await ergmProxy.waitForDeployment();
    const ergm: any = ERGM.attach(await ergmProxy.getAddress());

    const MockERC20 = await ethers.getContractFactory('MockERC20');
    const guaranteeAsset: any = await MockERC20.deploy('Guarantee Asset', 'GUA', 18, ethers.parseEther('1000000'));
    await guaranteeAsset.waitForDeployment();

    await registry.setModule(MODULE_KEYS.ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(MODULE_KEYS.VAULT_CORE, vaultCore.address);
    await registry.setModule(MODULE_KEYS.SETTLEMENT_MANAGER, settlementManager.address);
    await registry.setModule(MODULE_KEYS.ORDER_ENGINE, orderEngine.address);
    await registry.setModule(MODULE_KEYS.GUARANTEE_FUND, await gfm.getAddress());
    await registry.setModule(MODULE_KEYS.EARLY_REPAYMENT_GUARANTEE, await ergm.getAddress());
    await registry.setModule(MODULE_KEYS.REWARD_MANAGER, await rewardManager.getAddress());
    await registry.setModule(MODULE_KEYS.REWARD_MANAGER_CORE, await rewardManagerCore.getAddress());
    await registry.setModule(MODULE_KEYS.REWARD_ACCRUAL_MANAGER, await rewardAccrualManager.getAddress());
    await registry.setModule(MODULE_KEYS.REWARD_VIEW, await rewardView.getAddress());
    await registry.setModule(MODULE_KEYS.EASY_TOKEN, easyToken.target);

    await easyToken.connect(governance).grantRole(await easyToken.BURNER_ROLE(), await rewardAccrualManager.getAddress());

    await guaranteeAsset.mint(borrower.address, PROMISED_INTEREST);
    await guaranteeAsset.connect(borrower).approve(await gfm.getAddress(), PROMISED_INTEREST);

    return {
      governance,
      vaultCore,
      settlementManager,
      orderEngine,
      borrower,
      lender,
      rewardManager,
      rewardView,
      gfm,
      ergm,
      guaranteeAsset,
    };
  }

  it('processDefault routes reward penalty via GFM after guarantee forfeiture', async function () {
    const {
      governance,
      vaultCore,
      settlementManager,
      orderEngine,
      borrower,
      lender,
      rewardManager,
      rewardView,
      gfm,
      ergm,
      guaranteeAsset,
    } = await loadFixture(fixture);

    const currentBlock = await ethers.provider.getBlockNumber();
    const maturity = BigInt(currentBlock) + 216000n;

    await rewardManager.connect(governance).setLiquidationPenaltyBps(LIQUIDATION_BPS);

    await rewardManager.connect(orderEngine).onLoanEventByOrder(
      borrower.address,
      9001,
      1_000e6,
      maturity,
      0,
    );

    const quotedPenalty = await rewardManager.quoteLiquidationPenalty(borrower.address);
    expect(quotedPenalty).to.equal(ethers.parseUnits('0.05', 18));

    await gfm.connect(vaultCore).lockGuarantee(borrower.address, guaranteeAsset.target, PROMISED_INTEREST);
    await ergm.connect(vaultCore).lockGuaranteeRecord(
      borrower.address,
      lender.address,
      guaranteeAsset.target,
      PRINCIPAL,
      PROMISED_INTEREST,
      TERM_DAYS,
    );

    await expect(ergm.connect(settlementManager).processDefault(borrower.address, guaranteeAsset.target))
      .to.emit(gfm, 'RewardLiquidationPenaltyApplied')
      .withArgs(borrower.address, await rewardManager.getAddress(), quotedPenalty, anyValue);

    const [, pendingPenalty] = await rewardView.connect(borrower).getUserRewardSummaryWithMeta(borrower.address);
    expect(pendingPenalty).to.equal(quotedPenalty);
  });
});
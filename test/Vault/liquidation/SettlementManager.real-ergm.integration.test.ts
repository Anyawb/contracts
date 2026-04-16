import hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;
import { expect } from 'chai';
import { loadFixture, mine } from '@nomicfoundation/hardhat-network-helpers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';

import { ModuleKeys } from '../../../frontend-config/moduleKeys';

describe('SettlementManager – real ERGM integration', function () {
  async function deployFixture() {
    const [deployer, user, lender, platformFeeReceiver] = await ethers.getSigners();

    const MockRegistry = await ethers.getContractFactory('MockRegistry');
    const registry = await MockRegistry.deploy();
    await registry.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory('MockERC20');
    const debtToken = await MockERC20.deploy('DebtToken', 'DEBT', 18, ethers.parseUnits('1000000', 18));
    await debtToken.waitForDeployment();

    const MockCollateralManager = await ethers.getContractFactory('MockCollateralManager');
    const cm = await MockCollateralManager.deploy();
    await cm.waitForDeployment();

    const MockLendingEngineBasic = await ethers.getContractFactory('MockLendingEngineBasic');
    const le = await MockLendingEngineBasic.deploy();
    await le.waitForDeployment();

    const MockOrderEngine = await ethers.getContractFactory('MockOrderEngineForSettlementManager');
    const orderEngine = await MockOrderEngine.deploy();
    await orderEngine.waitForDeployment();
    await orderEngine.setLendingEngine(le.target);

    const MockGuaranteeFundManager = await ethers.getContractFactory('MockGuaranteeFundManager');
    const guaranteeFund = await MockGuaranteeFundManager.deploy();
    await guaranteeFund.waitForDeployment();

    const SettlementManager = await ethers.getContractFactory('SettlementManager');
    const settlementManagerImpl = await SettlementManager.deploy();
    await settlementManagerImpl.waitForDeployment();

    const Proxy = await ethers.getContractFactory('ERC1967Proxy');
    const settlementProxy = await Proxy.deploy(
      settlementManagerImpl.target,
      settlementManagerImpl.interface.encodeFunctionData('initialize', [registry.target])
    );
    await settlementProxy.waitForDeployment();
    const settlementManager = settlementManagerImpl.attach(settlementProxy.target);

    const EarlyRepaymentGuaranteeManager = await ethers.getContractFactory('EarlyRepaymentGuaranteeManager');
    const ergm = await upgrades.deployProxy(
      EarlyRepaymentGuaranteeManager,
      [registry.target, platformFeeReceiver.address, 100],
      { kind: 'uups', initializer: 'initialize' }
    );
    await ergm.waitForDeployment();

    const MockVaultCore = await ethers.getContractFactory('MockVaultCoreForSettlementManager');
    const vaultCore = await MockVaultCore.deploy();
    await vaultCore.waitForDeployment();

    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, vaultCore.target);
    await registry.setModule(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC, deployer.address);
    await registry.setModule(ModuleKeys.KEY_SETTLEMENT_MANAGER, settlementManager.target);
    await registry.setModule(ModuleKeys.KEY_LE, le.target);
    await registry.setModule(ModuleKeys.KEY_CM, cm.target);
    await registry.setModule(ModuleKeys.KEY_ORDER_ENGINE, orderEngine.target);
    await registry.setModule(ModuleKeys.KEY_GUARANTEE_FUND, guaranteeFund.target);
    await registry.setModule(ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE, ergm.target);

    await debtToken.mint(user.address, ethers.parseUnits('1000', 18));
    await debtToken.connect(user).approve(vaultCore.target, ethers.parseUnits('1000', 18));

    return {
      deployer,
      user,
      lender,
      platformFeeReceiver,
      registry,
      debtToken,
      cm,
      le,
      orderEngine,
      guaranteeFund,
      settlementManager,
      ergm,
      vaultCore,
    };
  }

  it('settles through real ERGM and GFM when a later same-asset repayment clears debt but the guarantee record is still early', async function () {
    const {
      deployer,
      user,
      lender,
      debtToken,
      le,
      orderEngine,
      guaranteeFund,
      settlementManager,
      ergm,
      vaultCore,
    } = await loadFixture(deployFixture);

    const guaranteedOrderId = 101n;
    const laterOrderId = 102n;
    const guaranteedPrincipal = ethers.parseUnits('10', 18);
    const laterPrincipal = ethers.parseUnits('4', 18);
    const promisedInterest = ethers.parseUnits('1', 18);
    const currentBlock = await ethers.provider.getBlockNumber();

    await le.setUserDebt(user.address, debtToken.target, guaranteedPrincipal + laterPrincipal);
    await orderEngine.setOrder(guaranteedOrderId, {
      principal: guaranteedPrincipal,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: lender.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock),
      maturity: BigInt(currentBlock + 20000),
      repaidAmount: 0n,
    });
    await orderEngine.setOrder(laterOrderId, {
      principal: laterPrincipal,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: lender.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock + 1),
      maturity: BigInt(currentBlock + 100),
      repaidAmount: 0n,
    });

    await ergm.connect(deployer).lockGuaranteeRecord(
      user.address,
      lender.address,
      debtToken.target,
      guaranteedPrincipal,
      promisedInterest,
      30
    );
    await guaranteeFund.lockGuarantee(user.address, debtToken.target, promisedInterest);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(
        settlementManager.target,
        guaranteedOrderId,
        debtToken.target,
        guaranteedPrincipal
      )
    ).to.not.emit(ergm, 'EarlyRepaymentProcessed');

    const guaranteeId = await ergm.getUserGuaranteeId(user.address, debtToken.target);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(
        settlementManager.target,
        laterOrderId,
        debtToken.target,
        laterPrincipal
      )
    )
      .to.emit(ergm, 'EarlyRepaymentProcessed')
      .withArgs(
        guaranteeId,
        user.address,
        lender.address,
        debtToken.target,
        anyValue,
        anyValue,
        anyValue,
        anyValue,
        anyValue
      );

    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(false);
    expect(await ergm.getUserGuaranteeId(user.address, debtToken.target)).to.equal(0n);
    expect(await guaranteeFund.getLockedGuarantee(user.address, debtToken.target)).to.equal(0n);
    expect(await le.getDebt(user.address, debtToken.target)).to.equal(0n);
  });

  it('does not settle when the guarantee record is no longer early even if the clearing order itself is still early', async function () {
    const {
      deployer,
      user,
      lender,
      debtToken,
      le,
      orderEngine,
      guaranteeFund,
      settlementManager,
      ergm,
      vaultCore,
    } = await loadFixture(deployFixture);

    const orderId = 201n;
    const repayAmount = ethers.parseUnits('10', 18);
    const promisedInterest = ethers.parseUnits('1', 18);
    const currentBlock = await ethers.provider.getBlockNumber();

    await le.setUserDebt(user.address, debtToken.target, repayAmount);
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: lender.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock),
      maturity: BigInt(currentBlock + 100000),
      repaidAmount: 0n,
    });

    await ergm.connect(deployer).lockGuaranteeRecord(
      user.address,
      lender.address,
      debtToken.target,
      repayAmount,
      promisedInterest,
      5
    );
    await guaranteeFund.lockGuarantee(user.address, debtToken.target, promisedInterest);

    await mine(28800);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(
        settlementManager.target,
        orderId,
        debtToken.target,
        repayAmount
      )
    ).to.not.emit(ergm, 'EarlyRepaymentProcessed');

    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(true);
    expect(await guaranteeFund.getLockedGuarantee(user.address, debtToken.target)).to.equal(promisedInterest);
    expect(await le.getDebt(user.address, debtToken.target)).to.equal(0n);
  });

  it('bubbles GuaranteeFund failure through real ERGM and reverts the whole repay flow', async function () {
    const {
      deployer,
      user,
      lender,
      debtToken,
      le,
      orderEngine,
      guaranteeFund,
      settlementManager,
      ergm,
      vaultCore,
    } = await loadFixture(deployFixture);

    const orderId = 301n;
    const repayAmount = ethers.parseUnits('10', 18);
    const promisedInterest = ethers.parseUnits('1', 18);
    const currentBlock = await ethers.provider.getBlockNumber();

    await le.setUserDebt(user.address, debtToken.target, repayAmount);
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: lender.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock),
      maturity: BigInt(currentBlock + 20000),
      repaidAmount: 0n,
    });

    await ergm.connect(deployer).lockGuaranteeRecord(
      user.address,
      lender.address,
      debtToken.target,
      repayAmount,
      promisedInterest,
      30
    );
    await guaranteeFund.lockGuarantee(user.address, debtToken.target, promisedInterest);
    await guaranteeFund.setMockSuccess(false);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(
        settlementManager.target,
        orderId,
        debtToken.target,
        repayAmount
      )
    ).to.be.revertedWithCustomError(ergm, 'ExternalModuleRevertedRaw');

    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(true);
    expect(await guaranteeFund.getLockedGuarantee(user.address, debtToken.target)).to.equal(promisedInterest);
    expect(await le.getDebt(user.address, debtToken.target)).to.equal(repayAmount);
  });

  it('rejects direct VaultCore calls to ERGM settlement/default entrypoints', async function () {
    const { user, debtToken, ergm, vaultCore } = await loadFixture(deployFixture);

    const vaultCoreSigner = await ethers.getImpersonatedSigner(vaultCore.target as string);
    await ethers.provider.send('hardhat_setBalance', [vaultCore.target as string, '0x3635C9ADC5DEA00000']);

    await expect(
      ergm.connect(vaultCoreSigner).settleEarlyRepayment(user.address, debtToken.target, 1n)
    ).to.be.revertedWithCustomError(ergm, 'EarlyRepaymentGuaranteeManager__OnlySettlementManager');

    await expect(
      ergm.connect(vaultCoreSigner).processDefault(user.address, debtToken.target)
    ).to.be.revertedWithCustomError(ergm, 'EarlyRepaymentGuaranteeManager__OnlySettlementManager');
  });
});
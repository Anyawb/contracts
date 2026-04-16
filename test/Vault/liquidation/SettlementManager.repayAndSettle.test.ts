import hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';

import { ModuleKeys } from '../../../frontend-config/moduleKeys';

describe('SettlementManager – repayAndSettle (SSOT)', function () {
  async function deployFixture() {
    const [deployer, user] = await ethers.getSigners();

    const MockRegistry = await ethers.getContractFactory('MockRegistry');
    const registry = await MockRegistry.deploy();
    await registry.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory('MockERC20');
    const debtToken = await MockERC20.deploy('DebtToken', 'DEBT', 18, ethers.parseUnits('1000000', 18));
    await debtToken.waitForDeployment();
    const otherDebtToken = await MockERC20.deploy('OtherDebtToken', 'ODEBT', 18, ethers.parseUnits('1000000', 18));
    await otherDebtToken.waitForDeployment();

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

    const MockEarlyRepaymentGuaranteeManager = await ethers.getContractFactory('MockEarlyRepaymentGuaranteeManager');
    const ergm = await MockEarlyRepaymentGuaranteeManager.deploy();
    await ergm.waitForDeployment();

    const SettlementManager = await ethers.getContractFactory('SettlementManager');
    const settlementManagerImpl = await SettlementManager.deploy();
    await settlementManagerImpl.waitForDeployment();

    // Deploy as ERC1967Proxy (like other tests)
    const Proxy = await ethers.getContractFactory('ERC1967Proxy');
    const settlementProxy = await Proxy.deploy(
      settlementManagerImpl.target,
      settlementManagerImpl.interface.encodeFunctionData('initialize', [registry.target])
    );
    await settlementProxy.waitForDeployment();
    const settlementManager = settlementManagerImpl.attach(settlementProxy.target);

    const MockVaultCore = await ethers.getContractFactory('MockVaultCoreForSettlementManager');
    const vaultCore = await MockVaultCore.deploy();
    await vaultCore.waitForDeployment();

    // Wire modules used by repayAndSettle
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, vaultCore.target);
    await registry.setModule(ModuleKeys.KEY_LE, le.target);
    await registry.setModule(ModuleKeys.KEY_CM, cm.target);
    await registry.setModule(ModuleKeys.KEY_ORDER_ENGINE, orderEngine.target);
    await registry.setModule(ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE, ergm.target);

    // Seed user balances and approvals
    await debtToken.mint(user.address, ethers.parseUnits('1000', 18));
    await debtToken.connect(user).approve(vaultCore.target, ethers.parseUnits('1000', 18));
    await debtToken.mint(cm.target, ethers.parseUnits('1000', 18));

    return { registry, debtToken, otherDebtToken, cm, le, orderEngine, ergm, settlementManager, vaultCore, deployer, user };
  }

  it('releases collateral only when totalDebtValue == 0', async function () {
    const { debtToken, cm, le, orderEngine, settlementManager, vaultCore, user } = await loadFixture(deployFixture);

    const orderId = 1n;
    const repayAmount = ethers.parseUnits('10', 18);

    // Set debt in ledger so total debt value is non-zero before repay
    await le.setUserDebt(user.address, debtToken.target, repayAmount);

    // Seed collateral
    const collateralAsset = debtToken.target;
    await cm.setUserCollateral(user.address, collateralAsset, ethers.parseUnits('5', 18));

    // Configure order
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 0n,
      borrower: user.address,
      lender: ethers.ZeroAddress,
      asset: debtToken.target,
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n
    });

    // Call via VaultCore mock (enforces onlyVaultCore)
    await expect(vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount))
      .to.emit(settlementManager, 'RepayAndSettleProcessed');

    // After repay, mock order engine also called LE.repay so debt is now 0 -> collateral should be released
    expect(await cm.getCollateral(user.address, collateralAsset)).to.equal(0n);
  });

  it('releases collateral when debt ledger is cleared even if valuation cache remains stale', async function () {
    const { debtToken, cm, le, orderEngine, settlementManager, vaultCore, user } = await loadFixture(deployFixture);

    const orderId = 5n;
    const repayAmount = ethers.parseUnits('10', 18);
    const staleDebtValue = ethers.parseUnits('999', 18);

    await le.setUserDebt(user.address, debtToken.target, repayAmount);
    await le.setUserTotalDebtValue(user.address, staleDebtValue);

    const collateralAsset = debtToken.target;
    await cm.setUserCollateral(user.address, collateralAsset, ethers.parseUnits('5', 18));

    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 0n,
      borrower: user.address,
      lender: ethers.ZeroAddress,
      asset: debtToken.target,
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n
    });

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount)
    )
      .to.emit(settlementManager, 'RepayAndSettleProcessed')
      .withArgs(user.address, debtToken.target, repayAmount, orderId, true, anyValue);

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(0n);
    expect(await cm.getCollateral(user.address, collateralAsset)).to.equal(0n);
    expect(await le.getUserTotalDebtValue(user.address)).to.equal(staleDebtValue - repayAmount);
  });

  it('triggers OrderEngine repay (SSOT orderId path)', async function () {
    const { debtToken, le, orderEngine, settlementManager, vaultCore, user } = await loadFixture(deployFixture);

    const orderId = 4n;
    const repayAmount = ethers.parseUnits('10', 18);

    await le.setUserDebt(user.address, debtToken.target, repayAmount);
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 0n,
      borrower: user.address,
      lender: ethers.ZeroAddress,
      asset: debtToken.target,
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n
    });

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount)
    )
      .to.emit(orderEngine, 'MockRepaid')
      .withArgs(orderId, repayAmount);

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(0n);
  });

  it('reverts when OrderEngine pulls less than the forwarded repay amount so funds cannot remain stranded in SettlementManager', async function () {
    const { debtToken, le, orderEngine, settlementManager, vaultCore, user } = await loadFixture(deployFixture);

    const orderId = 12n;
    const repayAmount = ethers.parseUnits('10', 18);
    const partialPullAmount = ethers.parseUnits('4', 18);

    await le.setUserDebt(user.address, debtToken.target, repayAmount);
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 0n,
      borrower: user.address,
      lender: ethers.ZeroAddress,
      asset: debtToken.target,
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n
    });
    await orderEngine.setRepayPullAmountOverride(partialPullAmount);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(
        settlementManager.target,
        orderId,
        debtToken.target,
        repayAmount
      )
    ).to.be.revertedWithCustomError(settlementManager, 'SettlementManager__RepayPullMismatch');

    expect(await debtToken.allowance(settlementManager.target, orderEngine.target)).to.equal(0n);
    expect(await debtToken.balanceOf(settlementManager.target)).to.equal(0n);
    expect(await le.getDebt(user.address, debtToken.target)).to.equal(repayAmount);
  });

  it('does NOT release collateral when debt remains after repay', async function () {
    const { debtToken, cm, le, orderEngine, settlementManager, vaultCore, user } = await loadFixture(deployFixture);

    const orderId = 2n;
    const repayAmount = ethers.parseUnits('10', 18);
    const initialDebt = ethers.parseUnits('100', 18);

    // Set debt in ledger so user remains in debt after repay
    await le.setUserDebt(user.address, debtToken.target, initialDebt);

    // Seed collateral
    const collateralAsset = debtToken.target;
    const initialCollateral = ethers.parseUnits('5', 18);
    await cm.setUserCollateral(user.address, collateralAsset, initialCollateral);

    // Configure order (must match user + debtAsset)
    await orderEngine.setOrder(orderId, {
      principal: initialDebt,
      rate: 0n,
      term: 0n,
      borrower: user.address,
      lender: ethers.ZeroAddress,
      asset: debtToken.target,
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n
    });

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount)
    )
      .to.emit(settlementManager, 'RepayAndSettleProcessed')
      .withArgs(user.address, debtToken.target, repayAmount, orderId, false, anyValue);

    // Collateral must remain untouched (still in debt)
    expect(await cm.getCollateral(user.address, collateralAsset)).to.equal(initialCollateral);
  });

  it('reverts when orderId does not match user/debtAsset (OrderMismatch)', async function () {
    const { debtToken, orderEngine, settlementManager, vaultCore, user, deployer } = await loadFixture(deployFixture);

    const orderId = 3n;
    const repayAmount = ethers.parseUnits('1', 18);

    // Order borrower is NOT the user argument that will be passed
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 0n,
      borrower: deployer.address,
      lender: ethers.ZeroAddress,
      asset: debtToken.target,
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n
    });

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount)
    ).to.be.revertedWithCustomError(settlementManager, 'SettlementManager__OrderMismatch');
  });

  it('reverts early when the order was already liquidated', async function () {
    const { debtToken, le, orderEngine, settlementManager, vaultCore, user } = await loadFixture(deployFixture);

    const orderId = 14n;
    const repayAmount = ethers.parseUnits('10', 18);

    await le.setUserDebt(user.address, debtToken.target, repayAmount);
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 0n,
      borrower: user.address,
      lender: ethers.ZeroAddress,
      asset: debtToken.target,
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n
    });
    await orderEngine.setOrderStatus(orderId, 2);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount)
    )
      .to.be.revertedWithCustomError(settlementManager, 'SettlementManager__OrderTerminalStatus')
      .withArgs(2n);

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(repayAmount);
  });

  it('reverts early when the order was already defaulted', async function () {
    const { debtToken, le, orderEngine, settlementManager, vaultCore, user } = await loadFixture(deployFixture);

    const orderId = 15n;
    const repayAmount = ethers.parseUnits('10', 18);

    await le.setUserDebt(user.address, debtToken.target, repayAmount);
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 0n,
      borrower: user.address,
      lender: ethers.ZeroAddress,
      asset: debtToken.target,
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n
    });
    await orderEngine.setOrderStatus(orderId, 3);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount)
    )
      .to.be.revertedWithCustomError(settlementManager, 'SettlementManager__OrderTerminalStatus')
      .withArgs(3n);

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(repayAmount);
  });

  it('reverts when called not from VaultCore', async function () {
    const { debtToken, orderEngine, settlementManager, user } = await loadFixture(deployFixture);

    const orderId = 1n;
    const repayAmount = ethers.parseUnits('1', 18);
    await debtToken.mint(settlementManager.target, repayAmount);

    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 0n,
      borrower: user.address,
      lender: ethers.ZeroAddress,
      asset: debtToken.target,
      startTimestamp: 0n,
      maturity: 0n,
      repaidAmount: 0n
    });

    await expect(settlementManager.connect(user).repayAndSettle(user.address, debtToken.target, repayAmount, orderId))
      .to.be.revertedWithCustomError(settlementManager, 'SettlementManager__OnlyVaultCore');
  });

  it('settles early-repayment guarantee when current order is fully repaid and current debt asset is cleared, even if other asset debt remains', async function () {
    const { debtToken, otherDebtToken, cm, le, orderEngine, ergm, settlementManager, vaultCore, user, deployer } = await loadFixture(deployFixture);

    const orderId = 6n;
    const repayAmount = ethers.parseUnits('10', 18);
    const collateralAmount = ethers.parseUnits('5', 18);
    const currentBlock = await ethers.provider.getBlockNumber();

    await le.setUserDebt(user.address, debtToken.target, repayAmount);
    await le.setUserDebt(user.address, otherDebtToken.target, ethers.parseUnits('3', 18));
    await cm.setUserCollateral(user.address, debtToken.target, collateralAmount);

    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: deployer.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock),
      maturity: BigInt(currentBlock + 20000),
      repaidAmount: 0n
    });

    await ergm.setGuaranteeEnabled(debtToken.target, true);
    await ergm.lockGuaranteeRecord(user.address, deployer.address, debtToken.target, repayAmount, repayAmount / 10n, 30);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount)
    )
      .to.emit(ergm, 'EarlyRepaymentSettled')
      .withArgs(user.address, debtToken.target, repayAmount);

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(0n);
    expect(await le.getDebt(user.address, otherDebtToken.target)).to.equal(ethers.parseUnits('3', 18));
    expect(await cm.getCollateral(user.address, debtToken.target)).to.equal(collateralAmount);
    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(false);
  });

  it('does not settle early-repayment guarantee when principal debt is cleared but the order is not fully repaid', async function () {
    const { debtToken, le, orderEngine, ergm, settlementManager, vaultCore, user, deployer } = await loadFixture(deployFixture);

    const orderId = 7n;
    const repayAmount = ethers.parseUnits('10', 18);
    const currentBlock = await ethers.provider.getBlockNumber();

    await le.setUserDebt(user.address, debtToken.target, repayAmount);
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 1000n,
      term: 2628000n,
      borrower: user.address,
      lender: deployer.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock),
      maturity: BigInt(currentBlock + 20000),
      repaidAmount: 0n
    });

    await ergm.setGuaranteeEnabled(debtToken.target, true);
    await ergm.lockGuaranteeRecord(user.address, deployer.address, debtToken.target, repayAmount, repayAmount / 10n, 30);
    await ergm.setGuaranteeMaturity(user.address, debtToken.target, BigInt(currentBlock + 100));

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount)
    ).to.not.emit(ergm, 'EarlyRepaymentSettled');

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(0n);
    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(true);
  });

  it('uses ORDER_ENGINE totalDue as the only full-repayment authority for guarantee settlement', async function () {
    const { debtToken, le, orderEngine, ergm, settlementManager, vaultCore, user, deployer } = await loadFixture(deployFixture);

    const orderId = 70n;
    const repayAmount = ethers.parseUnits('10', 18);
    const currentBlock = await ethers.provider.getBlockNumber();

    await le.setUserDebt(user.address, debtToken.target, repayAmount);
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: deployer.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock),
      maturity: BigInt(currentBlock + 20000),
      repaidAmount: 0n
    });

    // Deliberately diverge from the mock's local principal+interest math so the test fails
    // if SettlementManager ever goes back to recomputing totalDue on its own.
    await orderEngine.setOrderTotalDueOverride(orderId, repayAmount + 1n);

    await ergm.setGuaranteeEnabled(debtToken.target, true);
    await ergm.lockGuaranteeRecord(user.address, deployer.address, debtToken.target, repayAmount, repayAmount / 10n, 30);
    await ergm.setGuaranteeMaturity(user.address, debtToken.target, BigInt(currentBlock + 1000));

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount)
    ).to.not.emit(ergm, 'EarlyRepaymentSettled');

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(0n);
    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(true);
  });

  it('does not settle early-repayment guarantee when the same debt asset still has other debt after the current order is fully repaid', async function () {
    const { debtToken, le, orderEngine, ergm, settlementManager, vaultCore, user, deployer } = await loadFixture(deployFixture);

    const orderId = 8n;
    const repayAmount = ethers.parseUnits('10', 18);
    const otherSameAssetDebt = ethers.parseUnits('4', 18);
    const currentBlock = await ethers.provider.getBlockNumber();

    await le.setUserDebt(user.address, debtToken.target, repayAmount + otherSameAssetDebt);
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: deployer.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock),
      maturity: BigInt(currentBlock + 20000),
      repaidAmount: 0n
    });

    await ergm.setGuaranteeEnabled(debtToken.target, true);
    await ergm.lockGuaranteeRecord(user.address, deployer.address, debtToken.target, repayAmount, repayAmount / 10n, 30);
    await ergm.setGuaranteeMaturity(user.address, debtToken.target, BigInt(currentBlock + 100));

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount)
    ).to.not.emit(ergm, 'EarlyRepaymentSettled');

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(otherSameAssetDebt);
    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(true);
  });

  it('does not settle early-repayment guarantee when the repay is no longer early even if the order and asset debt are fully cleared', async function () {
    const { debtToken, le, orderEngine, ergm, settlementManager, vaultCore, user, deployer } = await loadFixture(deployFixture);

    const orderId = 9n;
    const repayAmount = ethers.parseUnits('10', 18);
    const currentBlock = await ethers.provider.getBlockNumber();

    await le.setUserDebt(user.address, debtToken.target, repayAmount);
    await orderEngine.setOrder(orderId, {
      principal: repayAmount,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: deployer.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock),
      maturity: BigInt(currentBlock + 100),
      repaidAmount: 0n
    });

    await ergm.setGuaranteeEnabled(debtToken.target, true);
    await ergm.lockGuaranteeRecord(user.address, deployer.address, debtToken.target, repayAmount, repayAmount / 10n, 30);
    await ergm.setGuaranteeMaturity(user.address, debtToken.target, BigInt(currentBlock + 100));

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, orderId, debtToken.target, repayAmount)
    ).to.not.emit(ergm, 'EarlyRepaymentSettled');

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(0n);
    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(true);
  });

  it('settles a lingering same-asset guarantee when a later order repayment is the one that finally clears the asset debt', async function () {
    const { debtToken, le, orderEngine, ergm, settlementManager, vaultCore, user, deployer } = await loadFixture(deployFixture);

    const guaranteedOrderId = 10n;
    const laterOrderId = 11n;
    const guaranteedPrincipal = ethers.parseUnits('10', 18);
    const laterPrincipal = ethers.parseUnits('4', 18);
    const currentBlock = await ethers.provider.getBlockNumber();

    await le.setUserDebt(user.address, debtToken.target, guaranteedPrincipal + laterPrincipal);
    await orderEngine.setOrder(guaranteedOrderId, {
      principal: guaranteedPrincipal,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: deployer.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock),
      maturity: BigInt(currentBlock + 20000),
      repaidAmount: 0n
    });
    await orderEngine.setOrder(laterOrderId, {
      principal: laterPrincipal,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: deployer.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock + 1),
      maturity: BigInt(currentBlock + 100),
      repaidAmount: 0n
    });

    await ergm.setGuaranteeEnabled(debtToken.target, true);
    await ergm.lockGuaranteeRecord(user.address, deployer.address, debtToken.target, guaranteedPrincipal, guaranteedPrincipal / 10n, 30);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, guaranteedOrderId, debtToken.target, guaranteedPrincipal)
    ).to.not.emit(ergm, 'EarlyRepaymentSettled');

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(laterPrincipal);
    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(true);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, laterOrderId, debtToken.target, laterPrincipal)
    )
      .to.emit(ergm, 'EarlyRepaymentSettled')
      .withArgs(user.address, debtToken.target, laterPrincipal);

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(0n);
    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(false);
  });

  it('keeps a lingering same-asset guarantee active through intermediate follow-up repayments until the final clearing repayment', async function () {
    const { debtToken, le, orderEngine, ergm, settlementManager, vaultCore, user, deployer } = await loadFixture(deployFixture);

    const guaranteedOrderId = 12n;
    const laterOrderId = 13n;
    const guaranteedPrincipal = ethers.parseUnits('10', 18);
    const laterPrincipal = ethers.parseUnits('4', 18);
    const laterPartialRepay = ethers.parseUnits('2', 18);
    const laterFinalRepay = laterPrincipal - laterPartialRepay;
    const currentBlock = await ethers.provider.getBlockNumber();

    await le.setUserDebt(user.address, debtToken.target, guaranteedPrincipal + laterPrincipal);
    await orderEngine.setOrder(guaranteedOrderId, {
      principal: guaranteedPrincipal,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: deployer.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock),
      maturity: BigInt(currentBlock + 20000),
      repaidAmount: 0n
    });
    await orderEngine.setOrder(laterOrderId, {
      principal: laterPrincipal,
      rate: 0n,
      term: 216000n,
      borrower: user.address,
      lender: deployer.address,
      asset: debtToken.target,
      startTimestamp: BigInt(currentBlock + 1),
      maturity: BigInt(currentBlock + 100),
      repaidAmount: 0n
    });

    await ergm.setGuaranteeEnabled(debtToken.target, true);
    await ergm.lockGuaranteeRecord(user.address, deployer.address, debtToken.target, guaranteedPrincipal, guaranteedPrincipal / 10n, 30);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, guaranteedOrderId, debtToken.target, guaranteedPrincipal)
    ).to.not.emit(ergm, 'EarlyRepaymentSettled');

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, laterOrderId, debtToken.target, laterPartialRepay)
    ).to.not.emit(ergm, 'EarlyRepaymentSettled');

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(laterFinalRepay);
    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(true);

    await expect(
      vaultCore.connect(user).repayViaSettlementManager(settlementManager.target, laterOrderId, debtToken.target, laterFinalRepay)
    )
      .to.emit(ergm, 'EarlyRepaymentSettled')
      .withArgs(user.address, debtToken.target, laterFinalRepay);

    expect(await le.getDebt(user.address, debtToken.target)).to.equal(0n);
    expect(await ergm.hasActiveGuarantee(user.address, debtToken.target)).to.equal(false);
  });
});


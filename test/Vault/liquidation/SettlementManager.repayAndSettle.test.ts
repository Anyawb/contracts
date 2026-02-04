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

    // Seed user balances and approvals
    await debtToken.mint(user.address, ethers.parseUnits('1000', 18));
    await debtToken.connect(user).approve(vaultCore.target, ethers.parseUnits('1000', 18));

    return { registry, debtToken, cm, le, orderEngine, settlementManager, vaultCore, deployer, user };
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
});


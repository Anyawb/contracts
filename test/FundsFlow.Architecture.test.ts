import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

import { ModuleKeys } from '../frontend-config/moduleKeys';

const ActionKeys = {
  ACTION_DEPOSIT: ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT')),
  ACTION_WITHDRAW: ethers.keccak256(ethers.toUtf8Bytes('WITHDRAW')),
  ACTION_LIQUIDATE: ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE')),
  ACTION_DEPOSIT_FEE: ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT')),
  ACTION_SET_PARAMETER: ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')),
};

describe('Funds Flow Architecture (SSOT)', function () {
  async function deployCollateralFlowFixture() {
    const [owner, user] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory('MockAccessControlManager');
    const acm = await ACMF.deploy();

    const CMF = await ethers.getContractFactory('MockCollateralManager');
    const cm = await CMF.deploy();

    const LEF = await ethers.getContractFactory('MockLendingEngineBasic');
    const le = await LEF.deploy();

    const PriceOracleF = await ethers.getContractFactory('MockPriceOracle');
    const po = await PriceOracleF.deploy();

    const AssetWhitelistF = await ethers.getContractFactory('MockAssetWhitelist');
    const aw = await AssetWhitelistF.deploy();

    const TokenF = await ethers.getContractFactory('MockERC20');
    const settlementToken = await TokenF.deploy('Settlement', 'SET', 18, ethers.parseUnits('1000000', 18));

    const VaultRouterF = await ethers.getContractFactory('VaultRouter');
    const vaultRouter = await upgrades.deployProxy(
      VaultRouterF,
      [registry.target, aw.target, po.target, settlementToken.target, owner.address],
      { kind: 'uups', initializer: 'initialize' }
    );

    const VaultCoreViewF = await ethers.getContractFactory('MockVaultCoreView');
    const vaultCore = await VaultCoreViewF.deploy();
    await vaultCore.setViewContractAddr(vaultRouter.target);
    await vaultCore.setLendingEngine(le.target);

    const testAsset = ethers.Wallet.createRandom().address;
    await aw.setAssetAllowed(testAsset, true);

    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, acm.target);
    await registry.setModule(ModuleKeys.KEY_CM, cm.target);
    await registry.setModule(ModuleKeys.KEY_LE, le.target);
    await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, po.target);
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, vaultCore.target);

    return { user, cm, vaultCore, testAsset };
  }

  it('Collateral Flow: deposit/withdraw routes via VaultCore -> VaultRouter -> CollateralManager', async function () {
    const { user, cm, vaultCore, testAsset } = await loadFixture(deployCollateralFlowFixture);

    await expect(
      vaultCore.processUserOperation(user.address, ActionKeys.ACTION_DEPOSIT, testAsset, 100, 123)
    )
      .to.emit(cm, 'CollateralDeposited')
      .withArgs(user.address, testAsset, 100);
    expect(await cm.getCollateral(user.address, testAsset)).to.equal(100);

    await expect(
      vaultCore.processUserOperation(user.address, ActionKeys.ACTION_WITHDRAW, testAsset, 40, 124)
    )
      .to.emit(cm, 'CollateralWithdrawn')
      .withArgs(user.address, testAsset, 40);
    expect(await cm.getCollateral(user.address, testAsset)).to.equal(60);
  });

  async function deployLiquidationFlowFixture() {
    const [owner, user, liquidator] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory('MockAccessControlManager');
    const acm = await ACMF.deploy();

    const CMF = await ethers.getContractFactory('MockCollateralManager');
    const cm = await CMF.deploy();

    const LEF = await ethers.getContractFactory('MockLendingEngineBasic');
    const le = await LEF.deploy();

    const TokenF = await ethers.getContractFactory('MockERC20');
    const collateralToken = await TokenF.deploy('Collateral', 'COL', 18, ethers.parseUnits('1000000', 18));

    const FeeRouterF = await ethers.getContractFactory('FeeRouter');
    const feeRouter = await upgrades.deployProxy(
      FeeRouterF,
      [registry.target, owner.address, owner.address, 300, 0],
      { kind: 'uups', initializer: 'initialize' }
    );

    const PayoutF = await ethers.getContractFactory('LiquidationPayoutManager');
    const payout = await upgrades.deployProxy(
      PayoutF,
      [
        registry.target,
        acm.target,
        { platform: owner.address, reserve: owner.address, lenderCompensation: owner.address },
        { platformBps: 300, reserveBps: 200, lenderBps: 1700, liquidatorBps: 7800 },
      ],
      { kind: 'uups', initializer: 'initialize' }
    );

    const LiquidationF = await ethers.getContractFactory('LiquidationManager');
    const liquidation = await upgrades.deployProxy(
      LiquidationF,
      [registry.target],
      { kind: 'uups', initializer: 'initialize' }
    );

    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, acm.target);
    await registry.setModule(ModuleKeys.KEY_CM, cm.target);
    await registry.setModule(ModuleKeys.KEY_LE, le.target);
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_PAYOUT_MANAGER, payout.target);
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_MANAGER, liquidation.target);
    await registry.setModule(ModuleKeys.KEY_FR, feeRouter.target);

    await acm.grantRole(ActionKeys.ACTION_LIQUIDATE, liquidator.address);
    await acm.grantRole(ActionKeys.ACTION_DEPOSIT, liquidation.target);
    await acm.grantRole(ActionKeys.ACTION_SET_PARAMETER, owner.address);
    await feeRouter.connect(owner).addSupportedToken(collateralToken.target);

    return { user, liquidator, cm, le, payout, liquidation, collateralToken };
  }

  it('Liquidation Flow: LiquidationManager writes CM/LE and emits payout', async function () {
    const { user, liquidator, cm, le, payout, liquidation, collateralToken } = await loadFixture(deployLiquidationFlowFixture);
    const collateralAsset = collateralToken.target;
    const debtAsset = ethers.Wallet.createRandom().address;

    await cm.setUserCollateral(user.address, collateralAsset, 1000);
    await collateralToken.mint(cm.target, 1000);
    await le.setUserDebt(user.address, debtAsset, 500);

    const collateralAmount = 400;
    const debtAmount = 200;
    const shares = await payout.calculateShares(collateralAmount);
    const recipients = await payout.getRecipients();

    await expect(
      liquidation.connect(liquidator).liquidate(user.address, collateralAsset, debtAsset, collateralAmount, debtAmount, 0)
    )
      .to.emit(liquidation, 'PayoutExecuted')
      .withArgs(
        user.address,
        collateralAsset,
        recipients.platform,
        recipients.reserve,
        recipients.lenderCompensation,
        liquidator.address,
        shares.platformShare,
        shares.reserveShare,
        shares.lenderShare,
        shares.liquidatorShare
      );

    expect(await cm.getCollateral(user.address, collateralAsset)).to.equal(600);
    expect(await le.getDebt(user.address, debtAsset)).to.equal(300);
  });

  async function deployFeeRouterFixture() {
    const [owner] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory('MockAccessControlManager');
    const acm = await ACMF.deploy();

    const FeeRouterF = await ethers.getContractFactory('FeeRouter');
    const feeRouter = await upgrades.deployProxy(
      FeeRouterF,
      [registry.target, owner.address, owner.address, 300, 200],
      { kind: 'uups', initializer: 'initialize' }
    );

    const TokenF = await ethers.getContractFactory('MockERC20');
    const token = await TokenF.deploy('Token', 'TKN', 18, ethers.parseUnits('1000000', 18));

    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, acm.target);
    await acm.grantRole(ActionKeys.ACTION_DEPOSIT_FEE, owner.address);
    await acm.grantRole(ActionKeys.ACTION_SET_PARAMETER, owner.address);

    return { owner, feeRouter, token };
  }

  it('FeeRouter token support: distributeNormal reverts until token is supported', async function () {
    const { owner, feeRouter, token } = await loadFixture(deployFeeRouterFixture);
    const amount = 100;

    await expect(feeRouter.connect(owner).distributeNormal(token.target, amount))
      .to.be.revertedWithCustomError(feeRouter, 'FeeRouter__TokenNotSupported');

    await feeRouter.connect(owner).addSupportedToken(token.target);
    await token.mint(owner.address, amount);
    await token.connect(owner).approve(feeRouter.target, amount);

    await expect(feeRouter.connect(owner).distributeNormal(token.target, amount))
      .to.emit(feeRouter, 'FeeDistributed')
      .withArgs(token.target, 3, 2);
  });
});

/**
 * CollateralManager / PositionView – migration-aligned tests
 *
 * This file was rewritten as part of the "Collateral Valuation Migration Plan":
 * - Collateral valuation APIs moved from CollateralManager to PositionView
 * - CollateralManager remains a ledger + token-pool (deposit/withdraw) module
 */

import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

import { ModuleKeys } from '../frontend-config/moduleKeys';

describe('CollateralManager / PositionView – migration-aligned', function () {
  const ACTION_UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));

  async function deployFixture() {
    const [admin, routerEOA, user, liquidator] = await ethers.getSigners();

    // Registry + ACM
    const Registry = await ethers.getContractFactory('MockRegistry');
    const registry = await Registry.deploy();
    await registry.waitForDeployment();

    const ACM = await ethers.getContractFactory('MockAccessControlManager');
    const acm = await ACM.deploy();
    await acm.waitForDeployment();

    // Oracle + asset
    const Oracle = await ethers.getContractFactory('MockPriceOracle');
    const oracle = await Oracle.deploy();
    await oracle.waitForDeployment();

    const ERC20 = await ethers.getContractFactory('MockERC20');
    const asset = await ERC20.deploy('Test Asset', 'TST', ethers.parseUnits('1000000', 18));
    await asset.waitForDeployment();

    // MockVaultCoreView: used only to return "router address" for CM permission gate
    const VaultCoreView = await ethers.getContractFactory('MockVaultCoreView');
    const vaultCoreView = await VaultCoreView.deploy();
    await vaultCoreView.waitForDeployment();
    await vaultCoreView.setViewContractAddr(routerEOA.address);

    // Deploy CM via UUPS proxy
    const CM = await ethers.getContractFactory('CollateralManager');
    const collateralManager = await upgrades.deployProxy(
      CM,
      [await registry.getAddress()],
      // CollateralManager has overloaded initialize; disambiguate for OZ upgrades
      { kind: 'uups', initializer: 'initialize(address)' }
    );
    await collateralManager.waitForDeployment();

    // Deploy PositionView (valuation lives here now) via UUPS proxy
    const PV = await ethers.getContractFactory('PositionView');
    const positionView = await upgrades.deployProxy(
      PV,
      [await registry.getAddress()],
      { kind: 'uups' }
    );
    await positionView.waitForDeployment();

    // Registry wiring required by CM + PV
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, await vaultCoreView.getAddress());
    await registry.setModule(ModuleKeys.KEY_CM, await collateralManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_POSITION_VIEW, await positionView.getAddress());
    await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await oracle.getAddress());
    // PositionView resolves KEY_LE even if it doesn't use it in valuation right now
    await registry.setModule(ModuleKeys.KEY_LE, admin.address);
    // Liquidation manager (for withdrawCollateralTo paths)
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_MANAGER, liquidator.address);

    // Configure oracle supported assets + price
    const nowTs = await time.latest();
    await oracle.configureAsset(await asset.getAddress(), 'tst', 8, 3600);
    await oracle.setPrice(await asset.getAddress(), ethers.parseUnits('1', 8), nowTs, 8);

    // Fund user + approve CM
    const depositAmount = ethers.parseUnits('1000', 18);
    const assetAddr = await asset.getAddress();
    const collateralManagerAddr = await collateralManager.getAddress();
    await asset.mint(user.address, depositAmount);
    await asset.connect(user).approve(collateralManagerAddr, depositAmount);

    return {
      admin,
      routerEOA,
      user,
      liquidator,
      registry,
      acm,
      oracle,
      asset,
      assetAddr,
      collateralManager,
      collateralManagerAddr,
      positionView,
      depositAmount,
    };
  }

  it('CollateralManager: only router/core can deposit', async function () {
    const { collateralManager, user, assetAddr, depositAmount } = await loadFixture(deployFixture);

    await expect(
      collateralManager.connect(user).depositCollateral(user.address, assetAddr, depositAmount)
    ).to.be.revertedWithCustomError(collateralManager, 'CollateralManager__UnauthorizedAccess');
  });

  it('CollateralManager: router deposit updates ledger + transfers tokens', async function () {
    const { collateralManager, routerEOA, user, asset, assetAddr, depositAmount, collateralManagerAddr } = await loadFixture(deployFixture);

    const cmAddr = collateralManagerAddr;
    const beforeUser = await asset.balanceOf(user.address);
    const beforeCM = await asset.balanceOf(cmAddr);

    await collateralManager.connect(routerEOA).depositCollateral(user.address, assetAddr, depositAmount);

    expect(await collateralManager.getCollateral(user.address, assetAddr)).to.equal(depositAmount);
    expect(await collateralManager.getTotalCollateralByAsset(assetAddr)).to.equal(depositAmount);

    expect(await asset.balanceOf(user.address)).to.equal(beforeUser - depositAmount);
    expect(await asset.balanceOf(cmAddr)).to.equal(beforeCM + depositAmount);
  });

  it('PositionView: getUserTotalCollateralValue uses oracle and returns value', async function () {
    const { collateralManager, routerEOA, user, assetAddr, positionView, depositAmount } = await loadFixture(deployFixture);

    await collateralManager.connect(routerEOA).depositCollateral(user.address, assetAddr, depositAmount);

    // With price=1 and decimals=8, value = amount * 1e8 / 1e8 = amount.
    expect(await positionView.getUserTotalCollateralValue(user.address)).to.equal(depositAmount);
  });

  it('PositionView: oracle failure falls back to 0 (best-effort)', async function () {
    const { oracle, positionView, user } = await loadFixture(deployFixture);

    await oracle.setShouldFail(true);
    expect(await positionView.getUserTotalCollateralValue(user.address)).to.equal(0);
  });

  it('PositionView: getTotalCollateralValue returns system total value', async function () {
    const { collateralManager, routerEOA, user, assetAddr, positionView, depositAmount } = await loadFixture(deployFixture);

    await collateralManager.connect(routerEOA).depositCollateral(user.address, assetAddr, depositAmount);
    expect(await positionView.getTotalCollateralValue()).to.equal(depositAmount);
  });

  it('CollateralManager: withdrawCollateralTo receiver==user restricted to router/settlementManager', async function () {
    const { collateralManager, routerEOA, user, liquidator, assetAddr, depositAmount } = await loadFixture(deployFixture);

    await collateralManager.connect(routerEOA).depositCollateral(user.address, assetAddr, depositAmount);

    await expect(
      collateralManager.connect(liquidator).withdrawCollateralTo(user.address, assetAddr, 1n, user.address)
    ).to.be.revertedWithCustomError(collateralManager, 'CollateralManager__UnauthorizedAccess');
  });

  it('CollateralManager: liquidation manager can withdrawCollateralTo(receiver!=user)', async function () {
    const { collateralManager, routerEOA, user, liquidator, asset, assetAddr, depositAmount, collateralManagerAddr } = await loadFixture(deployFixture);

    await collateralManager.connect(routerEOA).depositCollateral(user.address, assetAddr, depositAmount);

    const cmAddr = collateralManagerAddr;
    const beforeCM = await asset.balanceOf(cmAddr);
    const beforeLiq = await asset.balanceOf(liquidator.address);

    await collateralManager.connect(liquidator).withdrawCollateralTo(user.address, assetAddr, 10n, liquidator.address);

    expect(await collateralManager.getCollateral(user.address, assetAddr)).to.equal(depositAmount - 10n);
    expect(await collateralManager.getTotalCollateralByAsset(assetAddr)).to.equal(depositAmount - 10n);
    expect(await asset.balanceOf(cmAddr)).to.equal(beforeCM - 10n);
    expect(await asset.balanceOf(liquidator.address)).to.equal(beforeLiq + 10n);
  });

  it('CollateralManager: UUPS upgrade requires ACTION_UPGRADE_MODULE', async function () {
    const { collateralManager, acm, admin } = await loadFixture(deployFixture);

    const CM = await ethers.getContractFactory('CollateralManager');
    const newImpl = await CM.deploy();
    await newImpl.waitForDeployment();

    await expect(
      collateralManager.connect(admin).upgradeToAndCall(await newImpl.getAddress(), '0x')
    ).to.be.revertedWithCustomError(acm, 'MissingRole');

    await acm.grantRole(ACTION_UPGRADE_MODULE, admin.address);
    await expect(collateralManager.connect(admin).upgradeToAndCall(await newImpl.getAddress(), '0x')).to.not.be.reverted;
  });
});


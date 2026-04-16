import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, upgrades } from 'hardhat';

import { ModuleKeys } from '../frontend-config/moduleKeys';

const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'));
const ACTION_VIEW_RISK_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_RISK_DATA'));

function makeRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1103515245 + 12345) % 0x80000000;
    return state;
  };
}

describe('CollateralManager / PositionView - invariant accounting', function () {
  async function deployFixture() {
    const [admin, routerEOA, userA, userB, liquidator] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    await registry.waitForDeployment();

    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    await acm.waitForDeployment();

    const oracle = await (await ethers.getContractFactory('MockPriceOracle')).deploy();
    await oracle.waitForDeployment();

    const asset = await (await ethers.getContractFactory('MockERC20')).deploy(
      'Invariant Asset',
      'IAT',
      18,
      ethers.parseUnits('1000000', 18),
    );
    await asset.waitForDeployment();

    const vaultCoreView = await (await ethers.getContractFactory('MockVaultCoreView')).deploy();
    await vaultCoreView.waitForDeployment();
    await vaultCoreView.setViewContractAddr(routerEOA.address);

    const CM = await ethers.getContractFactory('CollateralManager');
    const collateralManager = await upgrades.deployProxy(
      CM,
      [await registry.getAddress()],
      { kind: 'uups', initializer: 'initialize(address)' },
    );
    await collateralManager.waitForDeployment();

    const PV = await ethers.getContractFactory('PositionView');
    const positionView = await upgrades.deployProxy(PV, [await registry.getAddress()], { kind: 'uups' });
    await positionView.waitForDeployment();

    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, await vaultCoreView.getAddress());
    await registry.setModule(ModuleKeys.KEY_CM, await collateralManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_POSITION_VIEW, await positionView.getAddress());
    await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await oracle.getAddress());
    await registry.setModule(ModuleKeys.KEY_LE, admin.address);
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_MANAGER, liquidator.address);

    await acm.grantRole(ACTION_LIQUIDATE, liquidator.address);
    await acm.grantRole(ACTION_VIEW_RISK_DATA, admin.address);

    const nowBlock = await ethers.provider.getBlockNumber();
    const assetAddress = await asset.getAddress();
    await oracle.configureAsset(assetAddress, 'iat', 18, 3600);
    await oracle.setPrice(assetAddress, ethers.parseUnits('1', 18), nowBlock, 18);

    const initialUserBalance = ethers.parseUnits('1000', 18);
    for (const user of [userA, userB]) {
      await asset.mint(user.address, initialUserBalance);
      await asset.connect(user).approve(await collateralManager.getAddress(), initialUserBalance);
    }

    return {
      routerEOA,
      userA,
      userB,
      liquidator,
      asset,
      assetAddress,
      collateralManager,
      positionView,
    };
  }

  it('keeps ledger totals, token custody, and valuation totals aligned under mixed operations', async function () {
    const { routerEOA, userA, userB, liquidator, asset, assetAddress, collateralManager, positionView } = await loadFixture(deployFixture);

    const cmAddress = await collateralManager.getAddress();
    const rng = makeRng(20260412);
    const users = [userA, userB];

    for (let step = 0; step < 30; step += 1) {
      const actor = users[rng() % users.length];
      const balance = await collateralManager.getCollateral(actor.address, assetAddress);
      const amount = ethers.parseUnits(String(1 + (rng() % 5)), 18);
      const mode = rng() % 3;

      if (mode === 0) {
        await collateralManager.connect(routerEOA).depositCollateral(actor.address, assetAddress, amount);
      } else if (mode === 1) {
        if (balance >= amount) {
          await collateralManager.connect(routerEOA).withdrawCollateral(actor.address, assetAddress, amount);
        }
      } else if (balance >= amount) {
        await collateralManager.connect(liquidator).withdrawCollateralTo(actor.address, assetAddress, amount, liquidator.address);
      }

      const balanceA = await collateralManager.getCollateral(userA.address, assetAddress);
      const balanceB = await collateralManager.getCollateral(userB.address, assetAddress);
      const totalCollateral = await collateralManager.getTotalCollateralByAsset(assetAddress);
      const poolBalance = await asset.balanceOf(cmAddress);

      expect(totalCollateral).to.equal(balanceA + balanceB);
      expect(poolBalance).to.equal(totalCollateral);
      expect(await positionView.getUserTotalCollateralValue(userA.address)).to.equal(balanceA);
      expect(await positionView.getUserTotalCollateralValue(userB.address)).to.equal(balanceB);
      expect(await positionView.getTotalCollateralValue()).to.equal(totalCollateral);
    }
  });
});
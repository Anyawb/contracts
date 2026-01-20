/**
 * Strict Architecture-Guide alignment:
 * - VaultRouter no longer maintains any business cache or read APIs.
 * - Cache validity / ledger fallback behavior belongs to PositionView.
 * - VaultRouter responsibilities tested here:
 *   - push* forwarding (VaultCore -> VaultRouter -> PositionView)
 *   - refreshModuleCache (A-class module address cache) via CacheMaintenanceManager
 */

import { expect } from 'chai';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ethers, upgrades } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

import type {
  MockAccessControlManager,
  MockCollateralManager,
  MockLendingEngineBasic,
  MockPriceOracle,
  MockRegistry,
  MockVaultCoreView,
  PositionView,
  VaultRouter,
} from '../../../types';

import type { CacheMaintenanceManager } from '../../../types';

const ModuleKeys = {
  KEY_CM: ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER')),
  KEY_LE: ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE')),
  KEY_ACCESS_CONTROL: ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
  KEY_VAULT_CORE: ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE')),
  KEY_VAULT_BUSINESS_LOGIC: ethers.keccak256(ethers.toUtf8Bytes('VAULT_BUSINESS_LOGIC')),
  KEY_PRICE_ORACLE: ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE')),
  KEY_POSITION_VIEW: ethers.keccak256(ethers.toUtf8Bytes('POSITION_VIEW')),
  KEY_CACHE_MAINTENANCE_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('CACHE_MAINTENANCE_MANAGER')),
};

const ACTION_VIEW_PUSH = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_PUSH'));
const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));

describe('PositionView – cache consistency and ledger fallback (strict)', function () {
  async function deployFixture() {
    const [admin, user, maint] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory('MockRegistry');
    const registry = (await RegistryFactory.deploy()) as MockRegistry;

    const ACMFactory = await ethers.getContractFactory('MockAccessControlManager');
    const acm = (await ACMFactory.deploy()) as MockAccessControlManager;

    const CMFactory = await ethers.getContractFactory('MockCollateralManager');
    const cm = (await CMFactory.deploy()) as MockCollateralManager;

    const LEFactory = await ethers.getContractFactory('MockLendingEngineBasic');
    const le = (await LEFactory.deploy()) as MockLendingEngineBasic;

    const PriceOracleFactory = await ethers.getContractFactory('MockPriceOracle');
    const priceOracle = (await PriceOracleFactory.deploy()) as MockPriceOracle;

    const AssetWhitelistFactory = await ethers.getContractFactory('MockAssetWhitelist');
    const assetWhitelist = await AssetWhitelistFactory.deploy();

    const ERC20Factory = await ethers.getContractFactory('MockERC20');
    const settlementToken = await ERC20Factory.deploy('Settlement Token', 'SETTLE', ethers.parseUnits('1000000', 18));

    // Deploy VaultRouter (slim; initializer keeps signature but ignores oracle/token in strict mode)
    const VaultRouterFactory = await ethers.getContractFactory('VaultRouter');
    const vaultRouter = (await upgrades.deployProxy(
      VaultRouterFactory,
      [
        await registry.getAddress(),
        await assetWhitelist.getAddress(),
        await priceOracle.getAddress(),
        await settlementToken.getAddress(),
        admin.address, // initialOwner
      ],
      { kind: 'uups', initializer: 'initialize' }
    )) as VaultRouter;

    // Deploy CacheMaintenanceManager (A-class cache SSOT entrypoint)
    const CacheMaintF = await ethers.getContractFactory('CacheMaintenanceManager');
    const cacheMaint = (await CacheMaintF.deploy(await registry.getAddress())) as CacheMaintenanceManager;
    await cacheMaint.waitForDeployment();

    // Deploy PositionView
    const PositionViewFactory = await ethers.getContractFactory('PositionView');
    const positionView = (await upgrades.deployProxy(PositionViewFactory, [await registry.getAddress()], {
      kind: 'uups',
      initializer: 'initialize',
    })) as PositionView;

    // VaultCore mock resolves VaultRouter address for PositionView.onlyBusinessContract and satisfies VaultRouter.onlyVaultCore.
    const VaultCoreViewFactory = await ethers.getContractFactory('MockVaultCoreView');
    const vaultCoreModule = (await VaultCoreViewFactory.deploy()) as MockVaultCoreView;
    await vaultCoreModule.setViewContractAddr(await vaultRouter.getAddress());
    await vaultCoreModule.setLendingEngine(await le.getAddress());

    // Registry wiring
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(ModuleKeys.KEY_CM, await cm.getAddress());
    await registry.setModule(ModuleKeys.KEY_LE, await le.getAddress());
    await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await priceOracle.getAddress());
    await registry.setModule(ModuleKeys.KEY_POSITION_VIEW, await positionView.getAddress());
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, await vaultCoreModule.getAddress());
    // Required by PositionView module resolution (can be any address in this test)
    await registry.setModule(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC, admin.address);
    await registry.setModule(ModuleKeys.KEY_CACHE_MAINTENANCE_MANAGER, await cacheMaint.getAddress());

    // Allow VaultRouter (caller) to push into PositionView
    await acm.grantRole(ACTION_VIEW_PUSH, await vaultRouter.getAddress());

    // Allow maint to run A-class cache refresh batches
    await acm.grantRole(ACTION_SET_PARAMETER, maint.address);

    // Seed module cache once via SSOT entrypoint (A-class cache)
    await cacheMaint.connect(maint).batchRefresh([await vaultRouter.getAddress()]);

    return { admin, user, maint, registry, acm, cm, le, priceOracle, vaultRouter, positionView, vaultCoreModule, cacheMaint };
  }

  it('push via VaultCore -> VaultRouter forwards to PositionView and marks cache valid', async function () {
    const { user, cm, le, vaultRouter, positionView, vaultCoreModule } = await loadFixture(deployFixture);
    const userAddr = user.address;
    const asset = ethers.Wallet.createRandom().address;

    // ledger writes
    await cm.depositCollateral(userAddr, asset, 100);
    await le.borrow(userAddr, asset, 50, 0, 0);

    const requestId = ethers.keccak256(ethers.toUtf8Bytes('req-1'));
    const seq = 7;

    await expect(vaultCoreModule.pushUserPositionUpdate(userAddr, asset, 100, 50, requestId, seq, 0))
      .to.emit(vaultRouter, 'UserPositionPushed')
      .withArgs(userAddr, asset, 100, 50, anyValue, requestId, seq);

    const [collateral, debt, isValid] = await positionView.getUserPositionWithValidity(userAddr, asset);
    expect(isValid).to.equal(true);
    expect(collateral).to.equal(100);
    expect(debt).to.equal(50);
  });

  it('cache expiry should fall back to ledger values and return isValid=false', async function () {
    const { user, cm, le, positionView, vaultCoreModule } = await loadFixture(deployFixture);
    const userAddr = user.address;
    const asset = ethers.Wallet.createRandom().address;

    // initial ledger + push
    await cm.depositCollateral(userAddr, asset, 10);
    await le.borrow(userAddr, asset, 5, 0, 0);
    await vaultCoreModule.pushUserPositionUpdate(userAddr, asset, 10, 5, ethers.keccak256(ethers.toUtf8Bytes('req-2')), 1, 0);

    // mutate ledger without pushing again
    await cm.depositCollateral(userAddr, asset, 10); // collateral: 20
    await le.borrow(userAddr, asset, 15, 0, 0); // debt: 20

    // CACHE_DURATION is 5 minutes in ViewConstants
    await time.increase(301);

    const [collateral, debt, isValid] = await positionView.getUserPositionWithValidity(userAddr, asset);
    expect(isValid).to.equal(false);
    expect(collateral).to.equal(20);
    expect(debt).to.equal(20);
  });

  it('when cache was never written, it should return ledger values with isValid=false', async function () {
    const { user, cm, le, positionView } = await loadFixture(deployFixture);
    const userAddr = user.address;
    const asset = ethers.Wallet.createRandom().address;

    await cm.depositCollateral(userAddr, asset, 9);
    await le.borrow(userAddr, asset, 4, 0, 0);

    const [collateral, debt, isValid] = await positionView.getUserPositionWithValidity(userAddr, asset);
    expect(isValid).to.equal(false);
    expect(collateral).to.equal(9);
    expect(debt).to.equal(4);
  });

  it('VaultRouter.refreshModuleCache should be restricted to CacheMaintenanceManager', async function () {
    const { maint, user, vaultRouter, cacheMaint } = await loadFixture(deployFixture);

    await expect(vaultRouter.connect(maint).refreshModuleCache()).to.be.revertedWithCustomError(
      vaultRouter,
      'VaultRouter__UnauthorizedAccess'
    );
    await expect(vaultRouter.connect(user).refreshModuleCache()).to.be.revertedWithCustomError(
      vaultRouter,
      'VaultRouter__UnauthorizedAccess'
    );
    await expect(cacheMaint.connect(maint).batchRefresh([await vaultRouter.getAddress()])).to.emit(
      vaultRouter,
      'ModuleCacheRefreshed'
    );
  });
});


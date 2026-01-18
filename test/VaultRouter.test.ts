/**
 * VaultRouter – strict Architecture-Guide tests (slim router)
 *
 * VaultRouter responsibilities in strict mode:
 * - `processUserOperation`: only VaultCore can call; routes deposit/withdraw to CollateralManager.
 * - `pushUserPositionUpdate*` / `pushUserPositionUpdateDelta*`: only VaultCore can call; forwards to PositionView and emits push events.
 * - `refreshModuleCache`: only CacheMaintenanceManager can call (A-class module address cache).
 *
 * VaultRouter must NOT:
 * - expose any read-only queries (moved to View modules)
 * - provide atomic user write entrypoints like depositAndBorrow/repayAndWithdraw (moved to VaultCore/SettlementManager)
 * - maintain compat caches or testing harnesses
 */

import { expect } from 'chai';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

import type {
  MockAccessControlManager,
  MockCollateralManager,
  MockLendingEngineBasic,
  MockPriceOracle,
  MockRegistry,
  MockVaultCoreView,
  PositionView,
  VaultRouter,
} from '../../types';

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

const ActionKeys = {
  ACTION_DEPOSIT: ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT')),
  ACTION_WITHDRAW: ethers.keccak256(ethers.toUtf8Bytes('WITHDRAW')),
  ACTION_BORROW: ethers.keccak256(ethers.toUtf8Bytes('BORROW')),
  ACTION_VIEW_PUSH: ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_PUSH')),
};

describe('VaultRouter – strict (slim) behavior', function () {
  async function deployFixture() {
    const [owner, user, maint] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory('MockRegistry');
    const registry = (await RegistryF.deploy()) as MockRegistry;

    const ACMF = await ethers.getContractFactory('MockAccessControlManager');
    const acm = (await ACMF.deploy()) as MockAccessControlManager;

    const CMF = await ethers.getContractFactory('MockCollateralManager');
    const cm = (await CMF.deploy()) as MockCollateralManager;

    const LEF = await ethers.getContractFactory('MockLendingEngineBasic');
    const le = (await LEF.deploy()) as MockLendingEngineBasic;

    const PriceOracleF = await ethers.getContractFactory('MockPriceOracle');
    const po = (await PriceOracleF.deploy()) as MockPriceOracle;

    const AssetWhitelistF = await ethers.getContractFactory('MockAssetWhitelist');
    const aw = await AssetWhitelistF.deploy();

    const TokenF = await ethers.getContractFactory('MockERC20');
    const settlementToken = await TokenF.deploy('Settlement', 'SET', ethers.parseUnits('1000000', 18));

    const VaultRouterF = await ethers.getContractFactory('VaultRouter');
    const vaultRouter = (await upgrades.deployProxy(
      VaultRouterF,
      [await registry.getAddress(), await aw.getAddress(), await po.getAddress(), await settlementToken.getAddress(), owner.address],
      { kind: 'uups', initializer: 'initialize' }
    )) as VaultRouter;

    const PositionViewF = await ethers.getContractFactory('PositionView');
    const positionView = (await upgrades.deployProxy(PositionViewF, [await registry.getAddress()], {
      kind: 'uups',
      initializer: 'initialize',
    })) as PositionView;

    // VaultCore mock: satisfies VaultRouter.onlyVaultCore and provides viewContractAddrVar for PositionView business allowlist.
    const VaultCoreViewF = await ethers.getContractFactory('MockVaultCoreView');
    const vaultCoreModule = (await VaultCoreViewF.deploy()) as MockVaultCoreView;
    await vaultCoreModule.setViewContractAddr(await vaultRouter.getAddress());
    await vaultCoreModule.setLendingEngine(await le.getAddress());

    // whitelist one random asset for processUserOperation tests
    const testAsset = ethers.Wallet.createRandom().address;
    await (aw as any).setAssetAllowed(testAsset, true);

    // Registry wiring
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(ModuleKeys.KEY_CM, await cm.getAddress());
    await registry.setModule(ModuleKeys.KEY_LE, await le.getAddress());
    await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await po.getAddress());
    await registry.setModule(ModuleKeys.KEY_POSITION_VIEW, await positionView.getAddress());
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, await vaultCoreModule.getAddress());
    await registry.setModule(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC, owner.address);
    await registry.setModule(ModuleKeys.KEY_CACHE_MAINTENANCE_MANAGER, maint.address);

    // Allow VaultRouter to write PositionView cache
    await acm.grantRole(ActionKeys.ACTION_VIEW_PUSH, await vaultRouter.getAddress());

    // Seed module cache
    await vaultRouter.connect(maint).refreshModuleCache();

    return { owner, user, maint, registry, acm, cm, le, po, aw, settlementToken, vaultRouter, positionView, vaultCoreModule, testAsset };
  }

  describe('processUserOperation routing', function () {
    it('should reject non-VaultCore callers', async function () {
      const { user, vaultRouter, testAsset } = await loadFixture(deployFixture);
      await expect(
        vaultRouter.connect(user).processUserOperation(user.address, ActionKeys.ACTION_DEPOSIT, testAsset, 1, 123)
      ).to.be.revertedWithCustomError(vaultRouter, 'VaultRouter__UnauthorizedAccess');
    });

    it('should route deposit/withdraw to CollateralManager', async function () {
      const { user, cm, vaultCoreModule, vaultRouter, testAsset } = await loadFixture(deployFixture);

      // sanity: direct call should revert (onlyVaultCore)
      await expect(
        vaultRouter.connect(user).processUserOperation(user.address, ActionKeys.ACTION_DEPOSIT, testAsset, 10, 100)
      ).to.be.revertedWithCustomError(vaultRouter, 'VaultRouter__UnauthorizedAccess');

      // deposit via VaultCore mock (caller == KEY_VAULT_CORE)
      await expect(vaultCoreModule.processUserOperation(user.address, ActionKeys.ACTION_DEPOSIT, testAsset, 10, 100))
        .to.emit(cm, 'CollateralDeposited')
        .withArgs(user.address, testAsset, 10);
      expect(await cm.getCollateral(user.address, testAsset)).to.equal(10);

      // withdraw via VaultCore mock
      await expect(vaultCoreModule.processUserOperation(user.address, ActionKeys.ACTION_WITHDRAW, testAsset, 4, 101))
        .to.emit(cm, 'CollateralWithdrawn')
        .withArgs(user.address, testAsset, 4);
      expect(await cm.getCollateral(user.address, testAsset)).to.equal(6);
    });

    it('should revert unsupported operationType', async function () {
      const { vaultCoreModule, vaultRouter, testAsset, user } = await loadFixture(deployFixture);
      await expect(vaultCoreModule.processUserOperation(user.address, ActionKeys.ACTION_BORROW, testAsset, 1, 123)).to.be
        .revertedWithCustomError(vaultRouter, 'VaultRouter__UnsupportedOperation');
    });
  });

  describe('push forwarding to PositionView', function () {
    it('pushUserPositionUpdate should forward and emit UserPositionPushed', async function () {
      const { user, vaultCoreModule, vaultRouter, positionView, testAsset, cm, le } = await loadFixture(deployFixture);

      await cm.depositCollateral(user.address, testAsset, 100);
      await le.borrow(user.address, testAsset, 50, 0, 0);

      const requestId = ethers.keccak256(ethers.toUtf8Bytes('router-test-req'));
      const seq = 1;

      await expect(vaultCoreModule.pushUserPositionUpdate(user.address, testAsset, 100, 50, requestId, seq, 0))
        .to.emit(vaultRouter, 'UserPositionPushed')
        .withArgs(user.address, testAsset, 100, 50, anyValue, requestId, seq)
        .and.to.emit(positionView, 'UserPositionCachedV2');
    });
  });

  describe('refreshModuleCache restriction', function () {
    it('only CacheMaintenanceManager can refresh', async function () {
      const { maint, user, vaultRouter } = await loadFixture(deployFixture);
      await expect(vaultRouter.connect(maint).refreshModuleCache()).to.emit(vaultRouter, 'ModuleCacheRefreshed');
      await expect(vaultRouter.connect(user).refreshModuleCache()).to.be.revertedWithCustomError(
        vaultRouter,
        'VaultRouter__UnauthorizedAccess'
      );
    });
  });
});


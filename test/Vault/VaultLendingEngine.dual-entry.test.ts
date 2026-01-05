/**
 * VaultLendingEngine 双入口一致性回归测试
 *
 * 覆盖 Architecture-Analysis.md §8（双入口风险）：
 * - 业务入口：borrow/repay 只能由 KEY_VAULT_CORE 调用
 * - 清算入口：forceReduceDebt 允许直达账本但需 ACTION_LIQUIDATE，并同步 View/Health
 * - 账本与缓存一致性：借/还/清算后 View 与 Health 缓存与账本一致
 *
 * 规范遵循 docs/test-file-standards.md
 */

import { expect } from 'chai';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type {
  VaultLendingEngine,
  MockRegistry,
  MockAccessControlManager,
  MockCollateralManager,
  MockVaultRouter,
  MockHealthView,
  MockRewardManager,
  MockPriceOracle,
  MockERC20,
  MockVaultCoreView,
  MockLiquidationRiskManager,
} from '../../types';

const ModuleKeys = {
  KEY_CM: ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER')),
  KEY_HEALTH_VIEW: ethers.keccak256(ethers.toUtf8Bytes('HEALTH_VIEW')),
  KEY_LIQUIDATION_RISK_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_RISK_MANAGER')),
  KEY_VAULT_CORE: ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE')),
  KEY_ACCESS_CONTROL: ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
  KEY_REWARD_MANAGER_V1: ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER_V1')),
  KEY_LIQUIDATION_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_MANAGER')),
};

const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'));

describe('VaultLendingEngine – dual entry invariants', function () {
  async function deployDualEntryFixture() {
    const [vaultCore, liquidator, liquidationManager, user, randomCaller] = await ethers.getSigners();

    // Deploy mocks
    const Registry = await ethers.getContractFactory('MockRegistry');
    const registry = (await Registry.deploy()) as MockRegistry;

    const ACM = await ethers.getContractFactory('MockAccessControlManager');
    const acm = (await ACM.deploy()) as MockAccessControlManager;

    const CM = await ethers.getContractFactory('MockCollateralManager');
    const cm = (await CM.deploy()) as MockCollateralManager;

    const VaultRouter = await ethers.getContractFactory('MockVaultRouter');
    const vaultRouter = (await VaultRouter.deploy()) as MockVaultRouter;

    const HealthView = await ethers.getContractFactory('MockHealthView');
    const healthView = (await HealthView.deploy()) as MockHealthView;

    const RewardManager = await ethers.getContractFactory('MockRewardManager');
    const rewardManager = (await RewardManager.deploy()) as MockRewardManager;

    const PriceOracle = await ethers.getContractFactory('MockPriceOracle');
    const priceOracle = (await PriceOracle.deploy()) as MockPriceOracle;

    const LRM = await ethers.getContractFactory('MockLiquidationRiskManager');
    const lrm = (await LRM.deploy()) as MockLiquidationRiskManager;

    const ERC20 = await ethers.getContractFactory('MockERC20');
    const settlementToken = (await ERC20.deploy('Settlement', 'ST', ethers.parseEther('1000000'))) as MockERC20;

    // Configure oracle price (ensure within GracefulDegradation limit)
    const nowTs = Math.floor(Date.now() / 1000);
    const priceValue = ethers.parseUnits('1', 8);
    const debtAsset = ethers.Wallet.createRandom().address;
    await priceOracle.connect(vaultCore).setPrice(await settlementToken.getAddress(), priceValue, nowTs, 8);
    await priceOracle.connect(vaultCore).setPrice(debtAsset, priceValue, nowTs, 8);

    // Deploy LendingEngine
    const LendingEngine = await ethers.getContractFactory('VaultLendingEngine');
    const lending = (await LendingEngine.deploy()) as VaultLendingEngine;
    await lending.initialize(await priceOracle.getAddress(), await settlementToken.getAddress(), await registry.getAddress());

    // VaultCore mock (resolves view + forwards borrow/repay)
    const VaultCoreView = await ethers.getContractFactory('MockVaultCoreView');
    const vaultCoreModule = await VaultCoreView.deploy();
    await vaultCoreModule.setViewContractAddr(await vaultRouter.getAddress());
    await vaultCoreModule.setLendingEngine(await lending.getAddress());

    // Registry wiring
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(ModuleKeys.KEY_CM, await cm.getAddress());
    await registry.setModule(ModuleKeys.KEY_HEALTH_VIEW, await healthView.getAddress());
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, await lrm.getAddress());
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, await vaultCoreModule.getAddress());
    await registry.setModule(ModuleKeys.KEY_REWARD_MANAGER_V1, await rewardManager.getAddress());
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_MANAGER, liquidationManager.address);

    // Roles: liquidation actors
    await acm.grantRole(ACTION_LIQUIDATE, liquidator.address);
    await acm.grantRole(ACTION_LIQUIDATE, liquidationManager.address);

    // Seed collateral to make health factor meaningful
    await cm.depositCollateral(user.address, debtAsset, 200);
    await cm.depositCollateral(liquidationManager.address, debtAsset, 150);

    return {
      vaultCoreModule,
      vaultCore,
      liquidator,
      liquidationManager,
      user,
      randomCaller,
      lending,
      registry,
      cm,
      vaultRouter,
      healthView,
      debtAsset,
      acm,
      priceOracle,
      lrm,
      rewardManager,
    };
  }

  describe('borrow / repay entry guard', function () {
    it('borrow should revert for non KEY_VAULT_CORE caller', async function () {
      const { lending, user, debtAsset } = await loadFixture(deployDualEntryFixture);
      await expect(
        lending.connect(user).borrow(user.address, debtAsset, 10, 0, 0)
      ).to.be.revertedWithCustomError(lending, 'VaultLendingEngine__OnlyVaultCore');
    });

    it('repay should revert for non KEY_VAULT_CORE caller', async function () {
      const { lending, user, debtAsset, vaultCoreModule } = await loadFixture(deployDualEntryFixture);
      await vaultCoreModule.borrow(user.address, debtAsset, 20, 0, 0);
      await expect(
        lending.connect(user).repay(user.address, debtAsset, 5)
      ).to.be.revertedWithCustomError(lending, 'VaultLendingEngine__OnlyVaultCore');
    });

    it('borrow/repay via VaultCore updates ledger and View/Health caches', async function () {
      const { vaultCoreModule, user, debtAsset, lending, vaultRouter, healthView } = await loadFixture(deployDualEntryFixture);

      await expect(
        vaultCoreModule.borrow(user.address, debtAsset, 50, 0, 0)
      ).to.emit(vaultRouter, 'UserPositionUpdated').withArgs(user.address, debtAsset, 200, 50);

      const hfAfterBorrow = await healthView.getUserHealthFactor(user.address);
      expect(hfAfterBorrow).to.be.gt(0);
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(50);

      await expect(
        vaultCoreModule.repay(user.address, debtAsset, 20)
      ).to.emit(vaultRouter, 'UserPositionUpdated').withArgs(user.address, debtAsset, 200, 30);

      const hfAfterRepay = await healthView.getUserHealthFactor(user.address);
      expect(hfAfterRepay).to.be.gt(0);
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(30);
    });

    it('borrow should emit CacheUpdateFailed when VaultRouter push fails (best effort, no revert)', async function () {
      const { vaultCoreModule, lending, user, debtAsset, cm } = await loadFixture(deployDualEntryFixture);
      const RevertingView = await ethers.getContractFactory('RevertingVaultRouter');
      const revertingView = await RevertingView.deploy();

      await vaultCoreModule.setViewContractAddr(await revertingView.getAddress());

      // 设置抵押物以便计算健康因子
      await cm.depositCollateral(user.address, debtAsset, 100);

      // borrow 应该成功完成（不回滚），但发出 CacheUpdateFailed 事件
      const tx = await vaultCoreModule.borrow(user.address, debtAsset, 10, 0, 0);
      
      // 验证账本已更新
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(10);
      
      // 验证发出了 CacheUpdateFailed 事件（符合 Architecture-Guide.md 的最佳努力模式）
      await expect(tx)
        .to.emit(lending, 'CacheUpdateFailed')
        .withArgs(
          user.address,
          debtAsset,
          await revertingView.getAddress(),
          anyValue, // collateral
          10n, // debt
          anyValue // reason bytes
        );
    });

    it('borrow should emit HealthPushFailed when HealthView is misconfigured (best effort, no revert)', async function () {
      const { vaultCoreModule, lending, registry, user, randomCaller, debtAsset } = await loadFixture(deployDualEntryFixture);

      // 配置一个无代码的 HealthView 地址，触发最佳努力路径
      await registry.setModule(ModuleKeys.KEY_HEALTH_VIEW, randomCaller.address);

      const tx = await vaultCoreModule.borrow(user.address, debtAsset, 10, 0, 0);

      // 账本已更新
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(10);

      // 健康推送失败但不回滚，触发 HealthPushFailed 事件
      await expect(tx)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(
          user.address,
          randomCaller.address,
          anyValue, // totalCollateral
          10n,      // totalDebt
          anyValue  // reason bytes
        );
    });

    it('borrow should emit HealthPushFailed when LiquidationRiskManager has no code (best effort, no revert)', async function () {
      const { vaultCoreModule, lending, registry, user, randomCaller, debtAsset } = await loadFixture(deployDualEntryFixture);

      // 将 LRM 配置为无代码地址，健康推送将走最佳努力事件告警
      await registry.setModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, randomCaller.address);

      const tx = await vaultCoreModule.borrow(user.address, debtAsset, 12, 0, 0);

      // 账本已更新
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(12);

      await expect(tx)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(
          user.address,
          anyValue,   // healthView address
          anyValue,   // totalCollateral
          12n,        // totalDebt
          anyValue    // reason bytes
        );
    });

    it('borrow should emit HealthPushFailed when HealthView reverts (best effort, no revert)', async function () {
      const { vaultCoreModule, lending, registry, user, debtAsset } = await loadFixture(deployDualEntryFixture);
      const RevertingHealthView = await ethers.getContractFactory('RevertingHealthView');
      const revertingHV = await RevertingHealthView.deploy();

      await registry.setModule(ModuleKeys.KEY_HEALTH_VIEW, await revertingHV.getAddress());

      const tx = await vaultCoreModule.borrow(user.address, debtAsset, 14, 0, 0);

      expect(await lending.getDebt(user.address, debtAsset)).to.equal(14);

      await expect(tx)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(
          user.address,
          await revertingHV.getAddress(),
          anyValue,
          14n,
          anyValue
        );
    });

    it('borrow should emit HealthPushFailed when getUserTotalCollateralValue reverts (best effort, no revert)', async function () {
      const { vaultCoreModule, lending, registry, user, debtAsset } = await loadFixture(deployDualEntryFixture);
      const RevertingTotals = await ethers.getContractFactory('RevertingCollateralTotals');
      const revertingCM = await RevertingTotals.deploy();

      await registry.setModule(ModuleKeys.KEY_CM, await revertingCM.getAddress());

      const tx = await vaultCoreModule.borrow(user.address, debtAsset, 16, 0, 0);

      expect(await lending.getDebt(user.address, debtAsset)).to.equal(16);

      await expect(tx)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(
          user.address,
          anyValue, // healthView address
          0n,       // totalCollateral default before revert
          16n,
          anyValue
        );
    });

    it('repay should emit HealthPushFailed when HealthView is misconfigured (best effort, no revert)', async function () {
      const { vaultCoreModule, lending, registry, user, debtAsset, randomCaller } = await loadFixture(deployDualEntryFixture);

      // 先正常借款，生成债务
      await vaultCoreModule.borrow(user.address, debtAsset, 20, 0, 0);
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(20);

      // 将 HealthView 替换为无代码地址，触发健康推送失败
      await registry.setModule(ModuleKeys.KEY_HEALTH_VIEW, randomCaller.address);

      const tx = await vaultCoreModule.repay(user.address, debtAsset, 5);

      // 账本已更新
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(15);

      // 健康推送失败但不回滚
      await expect(tx)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(
          user.address,
          randomCaller.address,
          anyValue, // totalCollateral
          anyValue, // totalDebt
          anyValue  // reason bytes
        );
    });
  });

  describe('forceReduceDebt liquidation entry', function () {
    it('should revert when caller lacks ACTION_LIQUIDATE', async function () {
      const { vaultCoreModule, lending, debtAsset, randomCaller, acm } = await loadFixture(deployDualEntryFixture);
      await vaultCoreModule.borrow(randomCaller.address, debtAsset, 25, 0, 0);
      await expect(
        lending.connect(randomCaller).forceReduceDebt(randomCaller.address, debtAsset, 10)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('should reduce debt directly with ACTION_LIQUIDATE and push View/Health', async function () {
      const { vaultCoreModule, liquidationManager, lending, debtAsset, vaultRouter, healthView } = await loadFixture(deployDualEntryFixture);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 40, 0, 0);

      await expect(
        lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 15)
      ).to.emit(vaultRouter, 'UserPositionUpdated').withArgs(liquidationManager.address, debtAsset, 150, 25)
        .and.to.emit(healthView, 'HealthFactorCached');

      expect(await lending.getDebt(liquidationManager.address, debtAsset)).to.equal(25);
    });

    it('should not underflow debt when reducing more than outstanding', async function () {
      const { vaultCoreModule, liquidator, lending, debtAsset, vaultRouter } = await loadFixture(deployDualEntryFixture);
      await vaultCoreModule.borrow(liquidator.address, debtAsset, 30, 0, 0);

      await expect(
        lending.connect(liquidator).forceReduceDebt(liquidator.address, debtAsset, 80)
      ).to.emit(lending, 'DebtRecorded').withArgs(liquidator.address, debtAsset, 30, false)
        .and.to.emit(vaultRouter, 'UserPositionUpdated').withArgs(liquidator.address, debtAsset, 0, 0);

      expect(await lending.getDebt(liquidator.address, debtAsset)).to.equal(0);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(0);
      expect(await lending.getTotalDebtValue()).to.equal(0);
    });

    it('forceReduceDebt should emit HealthPushFailed when HealthView is misconfigured (best effort, no revert)', async function () {
      const { vaultCoreModule, liquidationManager, lending, registry, debtAsset, randomCaller } = await loadFixture(deployDualEntryFixture);

      // 正常路径先生成债务
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 30, 0, 0);

      // 将 HealthView 替换为无代码地址
      await registry.setModule(ModuleKeys.KEY_HEALTH_VIEW, randomCaller.address);

      const tx = await lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 10);

      // 债务已减少
      expect(await lending.getDebt(liquidationManager.address, debtAsset)).to.equal(20);

      // 健康推送失败但不回滚
      await expect(tx)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(
          liquidationManager.address,
          randomCaller.address,
          anyValue, // totalCollateral
          anyValue, // totalDebt
          anyValue  // reason bytes
        );
    });

    it('forceReduceDebt (multi-asset) should emit HealthPushFailed when HealthView reverts (best effort)', async function () {
      const {
        vaultCoreModule,
        liquidationManager,
        lending,
        registry,
        priceOracle,
        cm,
        debtAsset,
      } = await loadFixture(deployDualEntryFixture);

      const debtAsset2 = ethers.Wallet.createRandom().address;
      const nowTs = Math.floor(Date.now() / 1000);
      const priceValue = ethers.parseUnits('1', 8);
      await priceOracle.setPrice(debtAsset2, priceValue, nowTs, 8);

      await cm.depositCollateral(liquidationManager.address, debtAsset2, 180);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset2, 50, 0, 0);

      const RevertingHealthView = await ethers.getContractFactory('RevertingHealthView');
      const revertingHV = await RevertingHealthView.deploy();
      await registry.setModule(ModuleKeys.KEY_HEALTH_VIEW, await revertingHV.getAddress());

      const tx = await lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset2, 20);

      expect(await lending.getDebt(liquidationManager.address, debtAsset2)).to.equal(30);

      await expect(tx)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(
          liquidationManager.address,
          await revertingHV.getAddress(),
          anyValue,
          anyValue,
          anyValue
        );
    });

    it('forceReduceDebt should emit HealthPushFailed when CM total collateral reverts (best effort)', async function () {
      const {
        vaultCoreModule,
        liquidationManager,
        lending,
        registry,
        debtAsset,
      } = await loadFixture(deployDualEntryFixture);

      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 30, 0, 0);

      const RevertingTotals = await ethers.getContractFactory('RevertingCollateralTotals');
      const revertingCM = await RevertingTotals.deploy();
      await registry.setModule(ModuleKeys.KEY_CM, await revertingCM.getAddress());

      const tx = await lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 10);

      expect(await lending.getDebt(liquidationManager.address, debtAsset)).to.equal(20);

      await expect(tx)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(
          liquidationManager.address,
          anyValue, // healthView
          0n,       // totalCollateral fallback when revert
          anyValue, // totalDebt
          anyValue  // reason
        );
    });

    it('forceReduceDebt batch-style over multiple assets should emit HealthPushFailed for each when HealthView reverts', async function () {
      const {
        vaultCoreModule,
        liquidationManager,
        lending,
        registry,
        priceOracle,
        cm,
        debtAsset,
      } = await loadFixture(deployDualEntryFixture);

      const debtAsset2 = ethers.Wallet.createRandom().address;
      const nowTs = Math.floor(Date.now() / 1000);
      await priceOracle.setPrice(debtAsset2, ethers.parseUnits('1', 8), nowTs, 8);

      await cm.depositCollateral(liquidationManager.address, debtAsset2, 160);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 30, 0, 0);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset2, 45, 0, 0);

      const RevertingHealthView = await ethers.getContractFactory('RevertingHealthView');
      const revertingHV = await RevertingHealthView.deploy();
      await registry.setModule(ModuleKeys.KEY_HEALTH_VIEW, await revertingHV.getAddress());

      const tx1 = await lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 10);
      const tx2 = await lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset2, 15);

      await expect(tx1)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(liquidationManager.address, await revertingHV.getAddress(), anyValue, anyValue, anyValue);

      await expect(tx2)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(liquidationManager.address, await revertingHV.getAddress(), anyValue, anyValue, anyValue);
    });

    it('forceReduceDebt batch-style should emit HealthPushFailed when CM total collateral reverts across assets', async function () {
      const {
        vaultCoreModule,
        liquidationManager,
        lending,
        registry,
        cm,
        priceOracle,
        debtAsset,
      } = await loadFixture(deployDualEntryFixture);

      const debtAsset2 = ethers.Wallet.createRandom().address;
      const nowTs = Math.floor(Date.now() / 1000);
      await priceOracle.setPrice(debtAsset2, ethers.parseUnits('1', 8), nowTs, 8);

      await cm.depositCollateral(liquidationManager.address, debtAsset2, 140);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 35, 0, 0);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset2, 40, 0, 0);

      const RevertingTotals = await ethers.getContractFactory('RevertingCollateralTotals');
      const revertingCM = await RevertingTotals.deploy();
      await registry.setModule(ModuleKeys.KEY_CM, await revertingCM.getAddress());

      const tx1 = await lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 10);
      const tx2 = await lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset2, 12);

      await expect(tx1)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(liquidationManager.address, anyValue, 0n, anyValue, anyValue);

      await expect(tx2)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(liquidationManager.address, anyValue, 0n, anyValue, anyValue);
    });
  });

  describe('ledger vs cache consistency across paths', function () {
    it('VaultCore borrow followed by direct liquidation keeps View in sync', async function () {
      const { vaultCoreModule, liquidationManager, lending, debtAsset, vaultRouter } = await loadFixture(deployDualEntryFixture);

      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 60, 0, 0);
      expect(await lending.getDebt(liquidationManager.address, debtAsset)).to.equal(60);

      await lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 20);

      expect(await vaultRouter.getUserDebt(liquidationManager.address, debtAsset)).to.equal(40);
      expect(await lending.getDebt(liquidationManager.address, debtAsset)).to.equal(40);
    });
  });

  describe('additional liquidation coverage', function () {
    it('KEY_LIQUIDATION_MANAGER with ACTION_LIQUIDATE can liquidate other users', async function () {
      const { vaultCoreModule, liquidationManager, lending, user, debtAsset, vaultRouter } = await loadFixture(deployDualEntryFixture);

      await vaultCoreModule.borrow(user.address, debtAsset, 70, 0, 0);

      await lending.connect(liquidationManager).forceReduceDebt(user.address, debtAsset, 30);

      expect(await lending.getDebt(user.address, debtAsset)).to.equal(40);
      expect(await vaultRouter.getUserDebt(user.address, debtAsset)).to.equal(40);
    });

    it('should emit health cache update with timestamp on liquidation', async function () {
      const { vaultCoreModule, liquidationManager, lending, debtAsset, healthView } = await loadFixture(deployDualEntryFixture);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 35, 0, 0);

      const beforeTs = await healthView.getCacheTimestamp(liquidationManager.address);

      await expect(
        lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 10)
      ).to.emit(healthView, 'HealthFactorCached');

      const afterTs = await healthView.getCacheTimestamp(liquidationManager.address);
      expect(afterTs).to.be.gt(beforeTs);
    });

    it('should revert forceReduceDebt when amount is zero', async function () {
      const { vaultCoreModule, liquidationManager, lending, debtAsset } = await loadFixture(deployDualEntryFixture);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 20, 0, 0);

      await expect(
        lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 0)
      ).to.be.revertedWithCustomError(lending, 'AmountIsZero');
    });

    it('borrow -> liquidation -> borrow keeps totals in sync', async function () {
      const { vaultCoreModule, liquidationManager, lending, debtAsset, vaultRouter } = await loadFixture(deployDualEntryFixture);

      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 40, 0, 0);
      await lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 15);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 25, 0, 0);

      expect(await lending.getDebt(liquidationManager.address, debtAsset)).to.equal(50);
      expect(await lending.getTotalDebtByAsset(debtAsset)).to.equal(50);
      expect(await vaultRouter.getUserDebt(liquidationManager.address, debtAsset)).to.equal(50);
    });

    it('forceReduceDebt on never-borrowed asset keeps state unchanged (idempotent)', async function () {
      const { lending, liquidationManager, debtAsset, vaultRouter, healthView } = await loadFixture(deployDualEntryFixture);
      const unusedAsset = ethers.Wallet.createRandom().address;

      const beforeTotal = await lending.getTotalDebtValue();

      await expect(
        lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, unusedAsset, 20)
      ).to.emit(lending, 'DebtRecorded').withArgs(liquidationManager.address, unusedAsset, 0, false)
        .and.to.emit(vaultRouter, 'UserPositionUpdated').withArgs(liquidationManager.address, unusedAsset, 0, 0);

      expect(await lending.getDebt(liquidationManager.address, unusedAsset)).to.equal(0);
      expect(await lending.getTotalDebtByAsset(unusedAsset)).to.equal(0);
      expect(await lending.getTotalDebtValue()).to.equal(beforeTotal);
      expect(await vaultRouter.getUserDebt(liquidationManager.address, unusedAsset)).to.equal(0);
      // NOTE: forceReduceDebt always pushes HealthView cache. With zero debt, health factor should be "infinite" (MaxUint256).
      expect(await healthView.getUserHealthFactor(liquidationManager.address)).to.equal(ethers.MaxUint256);
    });

    it('multi-asset liquidation only affects targeted asset and totals', async function () {
      const { vaultCoreModule, liquidationManager, lending, vaultRouter, healthView, debtAsset, priceOracle, vaultCore } = await loadFixture(deployDualEntryFixture);
      const debtAsset2 = ethers.Wallet.createRandom().address;
      const nowTs = Math.floor(Date.now() / 1000);
      await priceOracle.connect(vaultCore).setPrice(debtAsset2, ethers.parseEther('1'), nowTs, 18);

      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 40, 0, 0);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset2, 60, 0, 0);

      const totalBefore = await lending.getTotalDebtValue();

      await lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 25);

      expect(await lending.getDebt(liquidationManager.address, debtAsset)).to.equal(15);
      expect(await lending.getDebt(liquidationManager.address, debtAsset2)).to.equal(60);
      expect(await vaultRouter.getUserDebt(liquidationManager.address, debtAsset)).to.equal(15);
      expect(await vaultRouter.getUserDebt(liquidationManager.address, debtAsset2)).to.equal(60);

      const totalAfter = await lending.getTotalDebtValue();
      expect(totalAfter).to.be.lt(totalBefore);
      expect(await healthView.getUserHealthFactor(liquidationManager.address)).to.be.gt(0);
    });

    it('liquidating user A does not affect user B view/health', async function () {
      const { vaultCoreModule, liquidationManager, lending, vaultRouter, healthView, debtAsset, cm } = await loadFixture(deployDualEntryFixture);
      const userB = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userB, debtAsset, 300);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 50, 0, 0);
      await vaultCoreModule.borrow(userB, debtAsset, 40, 0, 0);

      const bDebtBefore = await lending.getDebt(userB, debtAsset);
      const bViewBefore = await vaultRouter.getUserDebt(userB, debtAsset);
      const bHFBefore = await healthView.getUserHealthFactor(userB);

      await lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 30);

      expect(await lending.getDebt(userB, debtAsset)).to.equal(bDebtBefore);
      expect(await vaultRouter.getUserDebt(userB, debtAsset)).to.equal(bViewBefore);
      expect(await healthView.getUserHealthFactor(userB)).to.equal(bHFBefore);
    });

    it('forceReduceDebt emits DebtRecorded and ActionExecuted for offchain indexing', async function () {
      const { vaultCoreModule, liquidationManager, lending, debtAsset } = await loadFixture(deployDualEntryFixture);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 18, 0, 0);

      await expect(
        lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 8)
      ).to.emit(lending, 'DebtRecorded').withArgs(liquidationManager.address, debtAsset, 8, false)
        .and.to.emit(lending, 'ActionExecuted');
    });
  });

  describe('registry missing module (best effort push, no revert)', function () {
    it('borrow should NOT revert when KEY_HEALTH_VIEW missing (emit HealthPushFailed)', async function () {
      const { registry, vaultCoreModule, user, debtAsset, lending, cm, acm, lrm, rewardManager } = await loadFixture(deployDualEntryFixture);
      await registry.setModule(ModuleKeys.KEY_HEALTH_VIEW, ethers.ZeroAddress);
      // re-wire essentials to avoid accidental zeroing
      await registry.setModule(ModuleKeys.KEY_CM, await cm.getAddress());
      await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());
      await registry.setModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER, await lrm.getAddress());
      await registry.setModule(ModuleKeys.KEY_REWARD_MANAGER_V1, await rewardManager.getAddress());

      const tx = await vaultCoreModule.borrow(user.address, debtAsset, 10, 0, 0);

      // ledger still updates
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(10);

      // best effort: health push fails but does not revert
      await expect(tx)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(
          user.address,
          ethers.ZeroAddress, // healthView missing
          anyValue, // totalCollateral (fallback)
          anyValue, // totalDebt
          anyValue  // reason
        );
    });

    it('repay should NOT revert when KEY_CM missing (emit CacheUpdateFailed + HealthPushFailed)', async function () {
      const { registry, vaultCoreModule, user, debtAsset, lending } = await loadFixture(deployDualEntryFixture);
      await vaultCoreModule.borrow(user.address, debtAsset, 10, 0, 0);
      await registry.setModule(ModuleKeys.KEY_CM, ethers.ZeroAddress);

      const tx = await vaultCoreModule.repay(user.address, debtAsset, 5);

      // ledger still updates
      expect(await lending.getDebt(user.address, debtAsset)).to.equal(5);

      // best effort: position snapshot push fails due to missing CM
      await expect(tx)
        .to.emit(lending, 'CacheUpdateFailed')
        .withArgs(
          user.address,
          debtAsset,
          ethers.ZeroAddress, // viewAddr unknown when CM missing in snapshot computation
          0n,                 // collateral fallback
          5n,                 // expected debt after repay
          anyValue
        );

      // best effort: health push also fails due to missing deps
      await expect(tx)
        .to.emit(lending, 'HealthPushFailed')
        .withArgs(
          user.address,
          anyValue, // healthView (could be zero or address depending on registry config)
          anyValue,
          anyValue,
          anyValue
        );
    });

    it('forceReduceDebt should revert when KEY_ACCESS_CONTROL missing', async function () {
      const { registry, vaultCoreModule, liquidationManager, lending, debtAsset } = await loadFixture(deployDualEntryFixture);
      await vaultCoreModule.borrow(liquidationManager.address, debtAsset, 12, 0, 0);
      await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, ethers.ZeroAddress);

      await expect(
        lending.connect(liquidationManager).forceReduceDebt(liquidationManager.address, debtAsset, 6)
      ).to.be.revertedWith('MockRegistry: module not found');
    });
  });
});



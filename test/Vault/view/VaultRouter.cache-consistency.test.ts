/**
 * VaultRouter 缓存一致性与回退路径测试
 *
 * 覆盖点：
 * - 缓存有效时返回缓存并标记有效
 * - 缓存过期时自动回退到账本（CollateralManager / LendingEngine）并标记无效
 * - 模块缓存过期时依旧能通过 Registry 解析模块地址完成回退
 * - 管理员手动同步入口 syncUserPositionFromLedger 更新缓存并发出事件/DataPush
 *
 * 规范：参考 docs/test-file-standards.md（权限、断言、导入方式、revertedWith 语法）
 */

import { expect } from 'chai';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type {
  VaultRouter,
  MockRegistry,
  MockAccessControlManager,
  MockCollateralManager,
  MockLendingEngineBasic,
  MockPriceOracle,
} from '../../../types';

// 最小 ModuleKeys 常量（测试所需）
const ModuleKeys = {
  KEY_CM: ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER')),
  KEY_LE: ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE')),
  KEY_ACCESS_CONTROL: ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
  KEY_VAULT_CORE: ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE')),
  KEY_VAULT_BUSINESS_LOGIC: ethers.keccak256(ethers.toUtf8Bytes('VAULT_BUSINESS_LOGIC')),
  KEY_PRICE_ORACLE: ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE')),
};

// 权限常量（只需 ACTION_ADMIN）
const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));

describe('VaultRouter – 缓存一致性与回退路径', function () {
  async function deployFixture() {
    const [admin, user] = await ethers.getSigners();

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

    const VaultRouterFactory = await ethers.getContractFactory('VaultRouter');
    const vaultRouter = (await VaultRouterFactory.deploy(
      await registry.getAddress(),
      await assetWhitelist.getAddress(),
      await priceOracle.getAddress(),
      await settlementToken.getAddress()
    )) as VaultRouter;

    // 配置 Registry 模块
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(ModuleKeys.KEY_CM, await cm.getAddress());
    await registry.setModule(ModuleKeys.KEY_LE, await le.getAddress());
    await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await priceOracle.getAddress());
    // VaultCore 仅用于授权入口校验，这里指向 admin
    await registry.setModule(ModuleKeys.KEY_VAULT_CORE, admin.address);
    // VaultBusinessLogic 仅用于业务白名单校验，这里指向 admin
    await registry.setModule(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC, admin.address);

    // 赋权 admin 调用 refreshModuleCache / syncUserPositionFromLedger
    await acm.grantRole(ACTION_ADMIN, admin.address);

    // 刷新模块缓存，确保 onlyBusinessContract 使用的缓存有效
    await vaultRouter.connect(admin).refreshModuleCache();
    const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    await acm.grantRole(ACTION_SET_PARAMETER, admin.address);
    await vaultRouter.connect(admin).setTestingMode(true);

    return { admin, user, registry, acm, cm, le, priceOracle, vaultRouter };
  }

  describe('缓存有效路径', function () {
    it('缓存有效时应返回缓存值并标记有效', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      // 账本写入
      await cm.depositCollateral(userAddr, asset, 100);
      await le.borrow(userAddr, asset, 50, 0, 0);

      // 管理员同步到缓存
      await vaultRouter.connect(admin).syncUserPositionFromLedger(userAddr, asset);

      const [collateral, debt, isValid] = await vaultRouter.getUserPositionWithValidity(userAddr, asset);
      expect(isValid).to.equal(true);
      expect(collateral).to.equal(100);
      expect(debt).to.equal(50);
    });

    it('同步后 isUserCacheValid 应为 true', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userAddr, asset, 1);
      await le.borrow(userAddr, asset, 1, 0, 0);
      await vaultRouter.connect(admin).syncUserPositionFromLedger(userAddr, asset);

      expect(await vaultRouter.isUserCacheValid(userAddr)).to.equal(true);
    });

    it('缓存未过期时应返回旧缓存值（即便账本已更新）', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      // 初始账本 + 缓存
      await cm.depositCollateral(userAddr, asset, 30);
      await le.borrow(userAddr, asset, 12, 0, 0);
      await vaultRouter.connect(admin).syncUserPositionFromLedger(userAddr, asset);

      // 账本更新但缓存未过期
      await cm.depositCollateral(userAddr, asset, 5); // 账本变为 35
      await le.borrow(userAddr, asset, 8, 0, 0); // 账本债务变为 20

      // 不推进时间，缓存仍有效
      const [collateral, debt, isValid] = await vaultRouter.getUserPositionWithValidity(userAddr, asset);
      expect(isValid).to.equal(true);
      expect(collateral).to.equal(30);
      expect(debt).to.equal(12);
    });
  });

  describe('缓存过期回退到账本', function () {
    it('缓存过期时应回退到账本最新值并标记无效', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      // 初始账本 + 缓存
      await cm.depositCollateral(userAddr, asset, 10);
      await le.borrow(userAddr, asset, 5, 0, 0);
      await vaultRouter.connect(admin).syncUserPositionFromLedger(userAddr, asset);

      // 账本更新但未推送，制造“缓存过时”
      await cm.depositCollateral(userAddr, asset, 10); // 变为 20
      await le.borrow(userAddr, asset, 15, 0, 0); // 变为 20

      // 等待超过 CACHE_DURATION (5 分钟 = 300s)
      await time.increase(301);

      const [collateral, debt, isValid] = await vaultRouter.getUserPositionWithValidity(userAddr, asset);
      expect(isValid).to.equal(false);
      expect(collateral).to.equal(20);
      expect(debt).to.equal(20);
    });

    it('缓存过期后 isUserCacheValid 应为 false', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userAddr, asset, 5);
      await le.borrow(userAddr, asset, 5, 0, 0);
      await vaultRouter.connect(admin).syncUserPositionFromLedger(userAddr, asset);

      await time.increase(301); // > CACHE_DURATION
      expect(await vaultRouter.isUserCacheValid(userAddr)).to.equal(false);
    });

    it('从未缓存过时应直接回退到账本且标记无效', async function () {
      const { user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userAddr, asset, 9);
      await le.borrow(userAddr, asset, 4, 0, 0);

      const [collateral, debt, isValid] = await vaultRouter.getUserPositionWithValidity(userAddr, asset);
      expect(isValid).to.equal(false);
      expect(collateral).to.equal(9);
      expect(debt).to.equal(4);
      expect(await vaultRouter.isUserCacheValid(userAddr)).to.equal(false);
    });

    it('模块缓存过期时也应通过 Registry 回退到账本', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userAddr, asset, 5);
      await le.borrow(userAddr, asset, 3, 0, 0);
      await vaultRouter.connect(admin).syncUserPositionFromLedger(userAddr, asset);

      // 再次更新账本
      await cm.depositCollateral(userAddr, asset, 7); // 变为 12
      await le.borrow(userAddr, asset, 9, 0, 0); // 变为 12

      // 让用户缓存过期 + 模块缓存过期 (> 3600s)
      await time.increase(4001);

      const [collateral, debt, isValid] = await vaultRouter.getUserPositionWithValidity(userAddr, asset);
      expect(isValid).to.equal(false);
      expect(collateral).to.equal(12);
      expect(debt).to.equal(12);
    });
  });

  describe('管理员手动同步', function () {
    it('syncUserPositionFromLedger 应刷新缓存并发出事件', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userAddr, asset, 42);
      await le.borrow(userAddr, asset, 24, 0, 0);

      await expect(
        vaultRouter.connect(admin).syncUserPositionFromLedger(userAddr, asset)
      ).to.emit(vaultRouter, 'UserPositionUpdated');

      const [collateral, debt, isValid] = await vaultRouter.getUserPositionWithValidity(userAddr, asset);
      expect(isValid).to.equal(true);
      expect(collateral).to.equal(42);
      expect(debt).to.equal(24);
      expect(await vaultRouter.isUserCacheValid(userAddr)).to.equal(true);
    });

    it('非管理员调用 syncUserPositionFromLedger 应被拒绝', async function () {
      const { user, vaultRouter } = await loadFixture(deployFixture);
      const asset = ethers.Wallet.createRandom().address;
      await expect(
        vaultRouter.connect(user).syncUserPositionFromLedger(user.address, asset)
      ).to.be.reverted;
    });
  });

  describe('业务白名单与模块缓存', function () {
    it('缓存失效时白名单地址调用应自动刷新并放行', async function () {
      const { admin, user, vaultRouter, registry } = await loadFixture(deployFixture);
      const [, , biz] = await ethers.getSigners();
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      // 将业务模块地址切换为新的白名单地址
      await registry.setModule(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC, biz.address);

      // 使模块缓存过期（> 3600s）
      await time.increase(4001);

      // 调用应自动刷新缓存并允许白名单地址推送
      await expect(
        vaultRouter.connect(biz).pushUserPositionUpdateCompat(userAddr, asset, 11, 22)
      ).to.emit(vaultRouter, 'UserPositionUpdated').withArgs(userAddr, asset, 11, 22, anyValue);
    });

    it('非白名单地址调用应被拒绝', async function () {
      const { user, vaultRouter } = await loadFixture(deployFixture);
      const asset = ethers.Wallet.createRandom().address;

      await expect(
        vaultRouter.connect(user).pushUserPositionUpdate(user.address, asset, 1, 1)
      ).to.be.revertedWithCustomError(vaultRouter, 'VaultRouter__UnauthorizedAccess');
    });
  });

  describe('模块缓存管理', function () {
    it('refreshModuleCache 应更新模块缓存并发出事件', async function () {
      const { admin, registry, vaultRouter } = await loadFixture(deployFixture);
      const [, , , beforeTs] = await vaultRouter.getCacheStats();

      // 模拟模块地址变更并推进时间，验证刷新后时间戳更新
      const NewCMFactory = await ethers.getContractFactory('MockCollateralManager');
      const newCm = await NewCMFactory.deploy();
      await registry.setModule(ModuleKeys.KEY_CM, await newCm.getAddress());
      await time.increase(2);

      await expect(vaultRouter.connect(admin).refreshModuleCache()).to.emit(vaultRouter, 'ModuleCacheRefreshed');

      const [, , , afterTs] = await vaultRouter.getCacheStats();
      expect(afterTs).to.be.gt(beforeTs);
      // 刷新后模块缓存应有效
      expect(await vaultRouter.isModuleCacheValid()).to.equal(true);
    });

    it('模块缓存过期后 isModuleCacheValid 应为 false', async function () {
      const { vaultRouter } = await loadFixture(deployFixture);
      await time.increase(3601);
      expect(await vaultRouter.isModuleCacheValid()).to.equal(false);
    });
  });

  describe('缓存清理与统计', function () {
    it('clearExpiredCache 应清除过期缓存并更新统计', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userAddr, asset, 7);
      await le.borrow(userAddr, asset, 3, 0, 0);
      // 使用 pushUserPositionUpdate 创建缓存，这样会更新 _totalCachedUsers
      await vaultRouter.connect(admin).pushUserPositionUpdate(userAddr, asset, 7, 3);
      const [totalBefore] = await vaultRouter.getCacheStats();
      expect(totalBefore).to.equal(1);

      await time.increase(301);
      await expect(vaultRouter.connect(admin).clearExpiredCache(userAddr))
        .to.emit(vaultRouter, 'CacheCleared')
        .withArgs(userAddr, anyValue);

      const [totalAfter] = await vaultRouter.getCacheStats();
      expect(totalAfter).to.equal(0);
      // 时间戳被删除，视为未缓存
      expect(await vaultRouter.isUserCacheValid(userAddr)).to.equal(false);
    });

    it('clearExpiredCache 不应清除未过期缓存', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userAddr, asset, 5);
      await le.borrow(userAddr, asset, 2, 0, 0);
      await vaultRouter.connect(admin).syncUserPositionFromLedger(userAddr, asset);
      const [totalBefore] = await vaultRouter.getCacheStats();

      await vaultRouter.connect(admin).clearExpiredCache(userAddr);
      const [totalAfter] = await vaultRouter.getCacheStats();

      expect(totalAfter).to.equal(totalBefore);
      const [, , , moduleTsAfter] = await vaultRouter.getCacheStats();
      expect(moduleTsAfter).to.be.gt(0);
      const [, , isValid] = await vaultRouter.getUserPositionWithValidity(userAddr, asset);
      expect(isValid).to.equal(true);
    });

    it('getCacheStats 应返回正确的缓存统计', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userAddr, asset, 9);
      await le.borrow(userAddr, asset, 4, 0, 0);
      // 使用 pushUserPositionUpdate 创建缓存，这样会更新 _totalCachedUsers
      await vaultRouter.connect(admin).pushUserPositionUpdate(userAddr, asset, 9, 4);

      const [totalUsers, validCaches, cacheDuration, moduleCacheTimestamp] = await vaultRouter.getCacheStats();
      expect(totalUsers).to.equal(1);
      expect(validCaches).to.equal(1);
      expect(cacheDuration).to.equal(300);
      expect(moduleCacheTimestamp).to.be.gt(0);
    });
  });

  describe('业务推送与覆盖', function () {
    it('pushUserPositionUpdate 应覆盖缓存并标记有效', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userAddr, asset, 10);
      await le.borrow(userAddr, asset, 5, 0, 0);
      await vaultRouter.connect(admin).syncUserPositionFromLedger(userAddr, asset);

      // 业务模块（这里使用 admin 作为业务逻辑地址）推送新数据
      await vaultRouter.connect(admin).pushUserPositionUpdate(userAddr, asset, 21, 11);

      const [collateral, debt, isValid] = await vaultRouter.getUserPositionWithValidity(userAddr, asset);
      expect(isValid).to.equal(true);
      expect(collateral).to.equal(21);
      expect(debt).to.equal(11);
    });

    it('pushUserPositionUpdate 非业务地址应被拒绝', async function () {
      const { user, vaultRouter } = await loadFixture(deployFixture);
      const asset = ethers.Wallet.createRandom().address;
      await expect(
        vaultRouter.connect(user).pushUserPositionUpdate(user.address, asset, 1, 1)
      ).to.be.revertedWithCustomError(vaultRouter, 'VaultRouter__UnauthorizedAccess');
    });
  });

  describe('缓存有效期边界', function () {
    it('缓存时间差等于 CACHE_DURATION 应视为过期', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userAddr, asset, 3);
      await le.borrow(userAddr, asset, 1, 0, 0);
      await vaultRouter.connect(admin).syncUserPositionFromLedger(userAddr, asset);

      await time.increase(300);
      const [, , isValid] = await vaultRouter.getUserPositionWithValidity(userAddr, asset);
      expect(isValid).to.equal(false);
    });

    it('缓存时间差小于 CACHE_DURATION 应保持有效', async function () {
      const { admin, user, cm, le, vaultRouter } = await loadFixture(deployFixture);
      const userAddr = user.address;
      const asset = ethers.Wallet.createRandom().address;

      await cm.depositCollateral(userAddr, asset, 6);
      await le.borrow(userAddr, asset, 2, 0, 0);
      await vaultRouter.connect(admin).syncUserPositionFromLedger(userAddr, asset);

      await time.increase(299);
      const [, , isValid] = await vaultRouter.getUserPositionWithValidity(userAddr, asset);
      expect(isValid).to.equal(true);
    });
  });
});


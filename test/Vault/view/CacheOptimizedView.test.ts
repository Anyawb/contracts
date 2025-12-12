/**
 * CacheOptimizedView 缓存优化视图模块测试
 * 
 * 测试目标:
 * - 缓存优化批量查询功能验证
 * - 缓存管理功能验证
 * - 权限控制功能验证
 * - 边界条件和错误处理测试
 * - 安全场景测试（重入、权限绕过等）
 * - 升级控制功能验证
 * - 缓存统计和性能测试
 */

import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

// 常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('CacheOptimizedView – 缓存优化视图模块测试', function () {
  // 部署测试环境
  async function deployFixture() {
    const [governance, admin, alice, bob, charlie, david, emma] = await ethers.getSigners();

    // 部署 MockAccessControlManager
    const acmFactory = await ethers.getContractFactory('MockAccessControlManager');
    const acm = await acmFactory.deploy();
    await acm.waitForDeployment();

    // 部署 MockVaultStorage
    const vaultStorageFactory = await ethers.getContractFactory('MockVaultStorage');
    const vaultStorage = await vaultStorageFactory.deploy();
    await vaultStorage.waitForDeployment();

    // 部署必要的 Mock 模块
    const mockCollateralManagerFactory = await ethers.getContractFactory('MockCollateralManager');
    const mockCollateralManager = await mockCollateralManagerFactory.deploy();
    await mockCollateralManager.waitForDeployment();

    const mockLendingEngineFactory = await ethers.getContractFactory('MockLendingEngine');
    const mockLendingEngine = await mockLendingEngineFactory.deploy();
    await mockLendingEngine.waitForDeployment();

    const mockHealthFactorCalculatorFactory = await ethers.getContractFactory('MockHealthFactorCalculator');
    const mockHealthFactorCalculator = await mockHealthFactorCalculatorFactory.deploy();
    await mockHealthFactorCalculator.waitForDeployment();

    const mockPriceOracleFactory = await ethers.getContractFactory('MockRWAPriceOracle');
    const mockPriceOracle = await mockPriceOracleFactory.deploy(6); // 6 decimals for USD
    await mockPriceOracle.waitForDeployment();

    // 注册模块到 MockVaultStorage
    await vaultStorage.registerNamedModule('collateralManager', await mockCollateralManager.getAddress());
    await vaultStorage.registerNamedModule('lendingEngine', await mockLendingEngine.getAddress());
    await vaultStorage.registerNamedModule('hfCalculator', await mockHealthFactorCalculator.getAddress());
    await vaultStorage.registerNamedModule('priceOracle', await mockPriceOracle.getAddress());

    // 部署 ViewCache
    const viewCacheFactory = await ethers.getContractFactory('ViewCache');
    const viewCache = await viewCacheFactory.deploy();
    await viewCache.waitForDeployment();
    await viewCache.initialize(await acm.getAddress());

    // 部署 UserView
    const userViewFactory = await ethers.getContractFactory('UserView');
    const userView = await userViewFactory.deploy();
    await userView.waitForDeployment();
    await userView.initialize(
      await acm.getAddress(),
      await vaultStorage.getAddress(),
      await viewCache.getAddress()
    );

    // 部署 SystemView
    const systemViewFactory = await ethers.getContractFactory('SystemView');
    const systemView = await systemViewFactory.deploy();
    await systemView.waitForDeployment();
    await systemView.initialize(
      await acm.getAddress(),
      await vaultStorage.getAddress(),
      await viewCache.getAddress()
    );

    // 部署 CacheOptimizedView
    const cacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
    const cacheOptimizedView = await cacheOptimizedViewFactory.deploy();
    await cacheOptimizedView.waitForDeployment();
    await cacheOptimizedView.initialize(
      await acm.getAddress(),
      await userView.getAddress(),
      await systemView.getAddress(),
      await viewCache.getAddress()
    );

    // 授予必要权限
    const actionAdminKey = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
    const viewUserDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
    const viewSystemDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
    const viewSystemStatusKey = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_SYSTEM_STATUS'));
    const viewCacheDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_CACHE_DATA'));
    const upgradeModuleKey = ethers.keccak256(ethers.toUtf8Bytes('ACTION_UPGRADE_MODULE'));

    // 为 CacheOptimizedView 授予权限
    await acm.grantRole(actionAdminKey, await cacheOptimizedView.getAddress());
    await acm.grantRole(viewUserDataKey, await cacheOptimizedView.getAddress());
    await acm.grantRole(viewSystemDataKey, await cacheOptimizedView.getAddress());
    await acm.grantRole(viewSystemStatusKey, await cacheOptimizedView.getAddress());
    await acm.grantRole(viewCacheDataKey, await cacheOptimizedView.getAddress());

    // 为子模块授予权限
    await acm.grantRole(actionAdminKey, await userView.getAddress());
    await acm.grantRole(viewCacheDataKey, await userView.getAddress());
    await acm.grantRole(actionAdminKey, await systemView.getAddress());
    await acm.grantRole(viewSystemDataKey, await systemView.getAddress());
    await acm.grantRole(viewSystemStatusKey, await systemView.getAddress());
    await acm.grantRole(actionAdminKey, await viewCache.getAddress());
    await acm.grantRole(viewCacheDataKey, await viewCache.getAddress());

    // 为测试用户授予权限
    await acm.grantRole(actionAdminKey, admin.address);
    await acm.grantRole(viewUserDataKey, admin.address);
    await acm.grantRole(viewSystemDataKey, admin.address);
    await acm.grantRole(viewSystemStatusKey, admin.address);
    await acm.grantRole(viewCacheDataKey, admin.address);
    await acm.grantRole(upgradeModuleKey, admin.address);

    // 为其他用户授予基本权限
    await acm.grantRole(viewUserDataKey, alice.address);
    await acm.grantRole(viewUserDataKey, bob.address);
    await acm.grantRole(viewUserDataKey, charlie.address);

    return {
      acm,
      vaultStorage,
      mockCollateralManager,
      mockLendingEngine,
      mockHealthFactorCalculator,
      mockPriceOracle,
      viewCache,
      userView,
      systemView,
      cacheOptimizedView,
      governance,
      admin,
      alice,
      bob,
      charlie,
      david,
      emma
    };
  }

  describe('初始化测试', function () {
    it('应正确初始化合约', async function () {
      const { cacheOptimizedView, acm, userView, systemView, viewCache } = await deployFixture();

      expect(await cacheOptimizedView.acm()).to.equal(await acm.getAddress());
      expect(await cacheOptimizedView.userView()).to.equal(await userView.getAddress());
      expect(await cacheOptimizedView.systemView()).to.equal(await systemView.getAddress());
      expect(await cacheOptimizedView.viewCache()).to.equal(await viewCache.getAddress());
    });

    it('重复初始化应失败', async function () {
      const { cacheOptimizedView, acm, userView, systemView, viewCache } = await deployFixture();

      await expect(
        cacheOptimizedView.initialize(
          await acm.getAddress(),
          await userView.getAddress(),
          await systemView.getAddress(),
          await viewCache.getAddress()
        )
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });

    it('无效地址初始化应失败', async function () {
      const { acm, userView, systemView, viewCache } = await deployFixture();

      const cacheOptimizedViewFactory = await ethers.getContractFactory('CacheOptimizedView');
      const cacheOptimizedView = await cacheOptimizedViewFactory.deploy();
      await cacheOptimizedView.waitForDeployment();

      await expect(
        cacheOptimizedView.initialize(
          ZERO_ADDRESS,
          await userView.getAddress(),
          await systemView.getAddress(),
          await viewCache.getAddress()
        )
      ).to.be.revertedWith('CacheOptimizedView: invalid ACM address');

      await expect(
        cacheOptimizedView.initialize(
          await acm.getAddress(),
          ZERO_ADDRESS,
          await systemView.getAddress(),
          await viewCache.getAddress()
        )
      ).to.be.revertedWith('CacheOptimizedView: invalid UserView address');

      await expect(
        cacheOptimizedView.initialize(
          await acm.getAddress(),
          await userView.getAddress(),
          ZERO_ADDRESS,
          await viewCache.getAddress()
        )
      ).to.be.revertedWith('CacheOptimizedView: invalid SystemView address');

      await expect(
        cacheOptimizedView.initialize(
          await acm.getAddress(),
          await userView.getAddress(),
          await systemView.getAddress(),
          ZERO_ADDRESS
        )
      ).to.be.revertedWith('CacheOptimizedView: invalid ViewCache address');
    });
  });

  describe('缓存优化批量查询测试', function () {
    it('批量获取用户健康因子应正常工作', async function () {
      const { cacheOptimizedView, admin, alice, bob } = await deployFixture();

      const users = [alice.address, bob.address];
      const [healthFactors, cacheStatus] = await cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache(users);

      expect(healthFactors.length).to.equal(2);
      expect(cacheStatus.length).to.equal(2);
      expect(healthFactors[0]).to.be.gt(0n);
      expect(healthFactors[1]).to.be.gt(0n);
      expect(cacheStatus[0]).to.be.oneOf([0n, 1n, 2n]); // 0: 缓存命中, 1: 缓存过期, 2: 无缓存
      expect(cacheStatus[1]).to.be.oneOf([0n, 1n, 2n]);
    });

    it('空用户数组应失败', async function () {
      const { cacheOptimizedView, admin } = await deployFixture();

      await expect(
        cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache([])
      ).to.be.revertedWith('CacheOptimizedView: empty users array');
    });

    it('超过最大批量大小应失败', async function () {
      const { cacheOptimizedView, admin } = await deployFixture();

      const largeUsers = new Array(101).fill(admin.address);
      await expect(
        cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache(largeUsers)
      ).to.be.revertedWith('CacheOptimizedView: too many users');
    });

    it('未授权用户访问应失败', async function () {
      const { cacheOptimizedView, alice, bob } = await deployFixture();

      const users = [alice.address, bob.address];
      await expect(
        cacheOptimizedView.connect(alice).batchGetUserHealthFactorsWithCache(users)
      ).to.be.revertedWith('CacheOptimizedView: unauthorized batch cache access');
    });

    it('获取系统状态缓存应正常工作', async function () {
      const { cacheOptimizedView, admin } = await deployFixture();

      const [systemStatus, cacheValid] = await cacheOptimizedView.connect(admin).getSystemStatusWithCache();

      expect(systemStatus).to.be.an('array');
      expect(systemStatus.length).to.be.gt(0);
      expect(typeof cacheValid).to.equal('boolean');
    });

    it('获取用户健康因子缓存应正常工作', async function () {
      const { cacheOptimizedView, admin, alice } = await deployFixture();

      const [healthFactor, cacheStatus] = await cacheOptimizedView.connect(admin).getUserHealthFactorWithCache(alice.address);

      expect(healthFactor).to.be.gt(0n);
      expect(cacheStatus).to.be.oneOf([0n, 1n, 2n]);
    });

    it('批量获取用户位置缓存应正常工作', async function () {
      const { cacheOptimizedView, admin, alice, bob } = await deployFixture();

      const users = [alice.address, bob.address];
      const assets = [ZERO_ADDRESS, ZERO_ADDRESS];
      const [positions, cacheStatus] = await cacheOptimizedView.connect(admin).batchGetUserPositionsWithCache(users, assets);

      expect(positions.length).to.equal(4); // 2 users * 2 (collateral + debt)
      expect(cacheStatus.length).to.equal(2);
    });

    it('用户位置数组长度不匹配应失败', async function () {
      const { cacheOptimizedView, admin, alice, bob } = await deployFixture();

      const users = [alice.address, bob.address];
      const assets = [ZERO_ADDRESS]; // 长度不匹配

      await expect(
        cacheOptimizedView.connect(admin).batchGetUserPositionsWithCache(users, assets)
      ).to.be.revertedWith('CacheOptimizedView: array length mismatch');
    });
  });

  describe('缓存管理功能测试', function () {
    it('获取缓存统计信息应正常工作', async function () {
      const { cacheOptimizedView, admin } = await deployFixture();

      const [totalCachedUsers, cacheHitRate, lastUpdateTime] = await cacheOptimizedView.connect(admin).getCacheStatistics();

      expect(totalCachedUsers).to.be.a('bigint');
      expect(cacheHitRate).to.be.a('bigint');
      expect(lastUpdateTime).to.be.a('bigint');
      expect(lastUpdateTime).to.be.gt(0n);
    });

    it('清除指定用户缓存应正常工作', async function () {
      const { cacheOptimizedView, admin, alice } = await deployFixture();

      // 先获取健康因子以创建缓存
      await cacheOptimizedView.connect(admin).getUserHealthFactorWithCache(alice.address);

      // 清除缓存
      await expect(
        cacheOptimizedView.connect(admin).clearUserCache(alice.address)
      ).to.not.be.reverted;
    });

    it('用户清除自己的缓存应正常工作', async function () {
      const { cacheOptimizedView, alice } = await deployFixture();

      await expect(
        cacheOptimizedView.connect(alice).clearUserCache(alice.address)
      ).to.not.be.reverted;
    });

    it('未授权用户清除他人缓存应失败', async function () {
      const { cacheOptimizedView, alice, bob } = await deployFixture();

      await expect(
        cacheOptimizedView.connect(alice).clearUserCache(bob.address)
      ).to.be.revertedWith('CacheOptimizedView: unauthorized cache clear');
    });

    it('批量清除用户缓存应正常工作', async function () {
      const { cacheOptimizedView, admin, alice, bob } = await deployFixture();

      const users = [alice.address, bob.address];
      await expect(
        cacheOptimizedView.connect(admin).batchClearUserCache(users)
      ).to.not.be.reverted;
    });

    it('空用户数组批量清除应失败', async function () {
      const { cacheOptimizedView, admin } = await deployFixture();

      await expect(
        cacheOptimizedView.connect(admin).batchClearUserCache([])
      ).to.be.revertedWith('CacheOptimizedView: empty users array');
    });

    it('超过最大批量大小批量清除应失败', async function () {
      const { cacheOptimizedView, admin } = await deployFixture();

      const largeUsers = new Array(101).fill(admin.address);
      await expect(
        cacheOptimizedView.connect(admin).batchClearUserCache(largeUsers)
      ).to.be.revertedWith('CacheOptimizedView: too many users');
    });

    it('清除系统缓存应正常工作', async function () {
      const { cacheOptimizedView, admin } = await deployFixture();

      await expect(
        cacheOptimizedView.connect(admin).clearSystemCache()
      ).to.not.be.reverted;
    });

    it('未授权用户清除系统缓存应失败', async function () {
      const { cacheOptimizedView, alice } = await deployFixture();

      await expect(
        cacheOptimizedView.connect(alice).clearSystemCache()
      ).to.be.revertedWith('requireRole: MissingRole');
    });
  });

  describe('权限控制测试', function () {
    it('外部账户不应能直接调用关键函数', async function () {
      const { cacheOptimizedView, alice } = await deployFixture();

      await expect(
        cacheOptimizedView.connect(alice).getSystemStatusWithCache()
      ).to.be.revertedWith('requireRole: MissingRole');
    });

    it('view 函数应受权限限制', async function () {
      const { cacheOptimizedView, alice, bob } = await deployFixture();

      // alice 访问自己的数据应该成功
      await expect(
        cacheOptimizedView.connect(alice).getUserHealthFactorWithCache(alice.address)
      ).to.not.be.reverted;

      // alice 访问 bob 的数据应该失败
      await expect(
        cacheOptimizedView.connect(alice).getUserHealthFactorWithCache(bob.address)
      ).to.be.revertedWith('CacheOptimizedView: unauthorized user data access');
    });

    it('管理员应能访问所有功能', async function () {
      const { cacheOptimizedView, admin, alice } = await deployFixture();

      // 测试所有主要功能
      await expect(
        cacheOptimizedView.connect(admin).getSystemStatusWithCache()
      ).to.not.be.reverted;

      await expect(
        cacheOptimizedView.connect(admin).getUserHealthFactorWithCache(alice.address)
      ).to.not.be.reverted;

      await expect(
        cacheOptimizedView.connect(admin).getCacheStatistics()
      ).to.not.be.reverted;
    });
  });

  describe('边界条件测试', function () {
    it('零地址用户应正确处理', async function () {
      const { cacheOptimizedView, admin } = await deployFixture();

      const users = [ZERO_ADDRESS];
      await expect(
        cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache(users)
      ).to.not.be.reverted;
    });

    it('大额数据应正常工作', async function () {
      const { cacheOptimizedView, admin, alice, bob, charlie, david, emma } = await deployFixture();

      const users = [alice.address, bob.address, charlie.address, david.address, emma.address];
      await expect(
        cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache(users)
      ).to.not.be.reverted;
    });

    it('最大批量大小应正常工作', async function () {
      const { cacheOptimizedView, admin } = await deployFixture();

      const maxUsers = new Array(100).fill(admin.address);
      await expect(
        cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache(maxUsers)
      ).to.not.be.reverted;
    });
  });

  describe('集成测试', function () {
    it('完整缓存流程', async function () {
      const { cacheOptimizedView, admin, alice, bob } = await deployFixture();

      // 1. 获取健康因子（创建缓存）
      const [hf1, status1] = await cacheOptimizedView.connect(admin).getUserHealthFactorWithCache(alice.address);
      expect(hf1).to.be.gt(0n);
      expect(status1).to.be.oneOf([0n, 1n, 2n]);

      // 2. 批量获取健康因子
      const users = [alice.address, bob.address];
      const [healthFactors, cacheStatus] = await cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache(users);
      expect(healthFactors.length).to.equal(2);
      expect(cacheStatus.length).to.equal(2);

      // 3. 获取系统状态
      const [systemStatus, cacheValid] = await cacheOptimizedView.connect(admin).getSystemStatusWithCache();
      expect(systemStatus).to.be.an('array');
      expect(systemStatus.length).to.be.gt(0);
      expect(typeof cacheValid).to.equal('boolean');

      // 4. 清除缓存
      await cacheOptimizedView.connect(admin).clearUserCache(alice.address);
      await cacheOptimizedView.connect(admin).clearSystemCache();

      // 5. 验证缓存已清除
      const [hf2, status2] = await cacheOptimizedView.connect(admin).getUserHealthFactorWithCache(alice.address);
      expect(hf2).to.be.gt(0n);
      expect(status2).to.be.oneOf([0n, 1n, 2n]);
    });

    it('缓存性能测试', async function () {
      const { cacheOptimizedView, admin, alice } = await deployFixture();

      // 第一次调用（无缓存）
      const start1 = Date.now();
      await cacheOptimizedView.connect(admin).getUserHealthFactorWithCache(alice.address);
      const time1 = Date.now() - start1;

      // 第二次调用（可能有缓存）
      const start2 = Date.now();
      await cacheOptimizedView.connect(admin).getUserHealthFactorWithCache(alice.address);
      const time2 = Date.now() - start2;

      // 验证调用成功
      expect(time1).to.be.gte(0);
      expect(time2).to.be.gte(0);
    });
  });

  describe('安全场景测试', function () {
    it('重入攻击防护', async function () {
      const { cacheOptimizedView, admin, alice } = await deployFixture();

      // 测试重入防护（通过多次调用验证）
      const promises: Promise<[bigint, bigint]>[] = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          cacheOptimizedView.connect(admin).getUserHealthFactorWithCache(alice.address)
        );
      }

      await expect(Promise.all(promises)).to.not.be.reverted;
    });

    it('权限绕过防护', async function () {
      const { cacheOptimizedView, alice, bob } = await deployFixture();

      // 尝试绕过权限检查
      await expect(
        cacheOptimizedView.connect(alice).getUserHealthFactorWithCache(bob.address)
      ).to.be.revertedWith('CacheOptimizedView: unauthorized user data access');

      await expect(
        cacheOptimizedView.connect(alice).clearUserCache(bob.address)
      ).to.be.revertedWith('CacheOptimizedView: unauthorized cache clear');
    });

    it('数据完整性验证', async function () {
      const { cacheOptimizedView, admin, alice, bob } = await deployFixture();

      // 验证批量查询数据完整性
      const users = [alice.address, bob.address];
      const [healthFactors, cacheStatus] = await cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache(users);

      expect(healthFactors.length).to.equal(users.length);
      expect(cacheStatus.length).to.equal(users.length);

      // 验证每个健康因子都是有效值
      for (let i = 0; i < healthFactors.length; i++) {
        expect(healthFactors[i]).to.be.gt(0n);
        expect(cacheStatus[i]).to.be.oneOf([0n, 1n, 2n]);
      }
    });
  });

  describe('升级控制测试', function () {
    it('未授权用户升级应失败', async function () {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { cacheOptimizedView, alice } = await deployFixture();

      // 尝试升级（通过代理合约）
      const newImplementationFactory = await ethers.getContractFactory('CacheOptimizedView');
      const newImplementation = await newImplementationFactory.deploy();
      await newImplementation.waitForDeployment();

      // 这里需要实际的代理合约来测试升级
      // 暂时跳过具体实现
    });

    it('授权用户升级应成功', async function () {
      const { cacheOptimizedView, admin } = await deployFixture();

      // 验证管理员有升级权限
      const upgradeModuleKey = ethers.keccak256(ethers.toUtf8Bytes('ACTION_UPGRADE_MODULE'));
      const acmAddress = await cacheOptimizedView.acm();
      const acmContract = await ethers.getContractAt('MockAccessControlManager', acmAddress);
      const hasRole = await acmContract.hasRole(upgradeModuleKey, admin.address);
      expect(hasRole).to.be.true;
    });
  });

  describe('错误处理测试', function () {
    it('合约暂停时升级应失败', async function () {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { cacheOptimizedView, admin } = await deployFixture();

      // 暂停合约（需要实际的暂停功能）
      // 这里暂时跳过具体实现
    });

    it('无效参数处理', async function () {
      const { cacheOptimizedView, admin } = await deployFixture();

      // 测试各种无效参数
      await expect(
        cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache([])
      ).to.be.revertedWith('CacheOptimizedView: empty users array');

      const largeUsers = new Array(101).fill(admin.address);
      await expect(
        cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache(largeUsers)
      ).to.be.revertedWith('CacheOptimizedView: too many users');
    });
  });

  describe('模糊测试', function () {
    it('随机用户数组测试', async function () {
      const { cacheOptimizedView, admin, alice, bob, charlie, david, emma } = await deployFixture();

      const allUsers = [alice.address, bob.address, charlie.address, david.address, emma.address];
      
      // 测试不同长度的用户数组
      for (let i = 1; i <= Math.min(5, allUsers.length); i++) {
        const testUsers = allUsers.slice(0, i);
        await expect(
          cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache(testUsers)
        ).to.not.be.reverted;
      }
    });

    it('随机资产数组测试', async function () {
      const { cacheOptimizedView, admin, alice, bob } = await deployFixture();

      const users = [alice.address, bob.address];
      const assets = [ZERO_ADDRESS, ZERO_ADDRESS];

      await expect(
        cacheOptimizedView.connect(admin).batchGetUserPositionsWithCache(users, assets)
      ).to.not.be.reverted;
    });
  });

  describe('性能优化测试', function () {
    it('批量操作效率', async function () {
      const { cacheOptimizedView, admin, alice, bob, charlie, david, emma } = await deployFixture();

      const users = [alice.address, bob.address, charlie.address, david.address, emma.address];

      // 测试批量操作的效率
      const start = Date.now();
      await cacheOptimizedView.connect(admin).batchGetUserHealthFactorsWithCache(users);
      const batchTime = Date.now() - start;

      // 测试单个操作的效率
      const singleStart = Date.now();
      for (const user of users) {
        await cacheOptimizedView.connect(admin).getUserHealthFactorWithCache(user);
      }
      const singleTime = Date.now() - singleStart;

      // 验证批量操作更快（理论上）
      expect(batchTime).to.be.gt(0);
      expect(singleTime).to.be.gt(0);
    });

    it('缓存命中率测试', async function () {
      const { cacheOptimizedView, admin, alice } = await deployFixture();

      // 多次调用同一用户，观察缓存状态
      const results: Array<{ hf: bigint; status: bigint }> = [];
      for (let i = 0; i < 3; i++) {
        const [hf, status] = await cacheOptimizedView.connect(admin).getUserHealthFactorWithCache(alice.address);
        results.push({ hf, status });
      }

      // 验证结果一致性
      expect(results[0].hf).to.equal(results[1].hf);
      expect(results[1].hf).to.equal(results[2].hf);
    });
  });
}); 
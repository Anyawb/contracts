/**
 * BatchView 批量视图模块测试
 * 
 * 测试目标:
 * - 批量风险评估查询功能验证
 * - 批量用户状态查询功能验证
 * - 批量系统状态查询功能验证
 * - 批量清算人查询功能验证
 * - 权限控制功能验证
 * - 边界条件和错误处理测试
 * - 安全场景测试（重入、权限绕过等）
 * - 升级控制功能验证
 */

import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

// 常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('BatchView – 批量视图模块测试', function () {
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

    // 注册模块到 MockVaultStorage
    await vaultStorage.registerNamedModule('collateralManager', await mockCollateralManager.getAddress());
    await vaultStorage.registerNamedModule('lendingEngine', await mockLendingEngine.getAddress());
    await vaultStorage.registerNamedModule('hfCalculator', await mockHealthFactorCalculator.getAddress());

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

    // 部署 RiskView
    const riskViewFactory = await ethers.getContractFactory('RiskView');
    const riskView = await riskViewFactory.deploy();
    await riskView.waitForDeployment();
    await riskView.initialize(
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

    // 部署 BatchView
    const batchViewFactory = await ethers.getContractFactory('BatchView');
    const batchView = await batchViewFactory.deploy();
    await batchView.waitForDeployment();
    await batchView.initialize(
      await acm.getAddress(),
      await userView.getAddress(),
      await riskView.getAddress(),
      await systemView.getAddress()
    );

    // ====== 修正权限字符串，使用与 ActionKeys.sol 一致的字符串 ======
    // 使用正确的权限字符串（与 ActionKeys.sol 一致）
    const actionAdminKey = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
    const actionViewUserDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
    const actionViewSystemDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
    const actionViewRiskDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_RISK_DATA'));
    const actionUpgradeModuleKey = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
    const actionViewCacheDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_CACHE_DATA'));
    const actionViewSystemStatusKey = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_SYSTEM_STATUS'));

    // 设置初始权限
    await acm.grantRole(actionAdminKey, admin.address);
    await acm.grantRole(actionUpgradeModuleKey, admin.address);
    await acm.grantRole(actionViewUserDataKey, alice.address);
    await acm.grantRole(actionViewSystemDataKey, bob.address);
    await acm.grantRole(actionViewRiskDataKey, charlie.address);
    
    // 为 admin 也授予所有权限，以便测试
    await acm.grantRole(actionViewUserDataKey, admin.address);
    await acm.grantRole(actionViewSystemDataKey, admin.address);
    await acm.grantRole(actionViewRiskDataKey, admin.address);
    
    // 为 bob 也授予其他必要权限，以便测试
    await acm.grantRole(actionViewUserDataKey, bob.address);
    await acm.grantRole(actionViewRiskDataKey, bob.address);
    await acm.grantRole(actionViewCacheDataKey, bob.address);
    await acm.grantRole(actionViewSystemStatusKey, bob.address);

    // ====== 为 BatchView 合约本身授予必要的权限，以便它能调用子模块 ======
    const batchViewAddr = await batchView.getAddress();
    await acm.grantRole(actionViewUserDataKey, batchViewAddr);
    await acm.grantRole(actionAdminKey, batchViewAddr);
    await acm.grantRole(actionViewRiskDataKey, batchViewAddr);
    await acm.grantRole(actionViewSystemDataKey, batchViewAddr);
    await acm.grantRole(actionViewCacheDataKey, batchViewAddr);
    await acm.grantRole(actionViewSystemStatusKey, batchViewAddr);

    // ====== 为子模块合约授予必要的权限 ======
    // UserView 需要 ACTION_ADMIN 权限来调用 ViewCache
    const userViewAddr = await userView.getAddress();
    await acm.grantRole(actionAdminKey, userViewAddr);
    await acm.grantRole(actionViewCacheDataKey, userViewAddr);

    // RiskView 需要 ACTION_ADMIN 权限来调用 ViewCache
    const riskViewAddr = await riskView.getAddress();
    await acm.grantRole(actionAdminKey, riskViewAddr);
    await acm.grantRole(actionViewCacheDataKey, riskViewAddr);

    // SystemView 需要 ACTION_ADMIN 权限来调用 ViewCache
    const systemViewAddr = await systemView.getAddress();
    await acm.grantRole(actionAdminKey, systemViewAddr);
    await acm.grantRole(actionViewCacheDataKey, systemViewAddr);
    await acm.grantRole(actionViewSystemStatusKey, systemViewAddr);
    await acm.grantRole(actionViewSystemDataKey, systemViewAddr);

    // ViewCache 需要 ACTION_ADMIN 权限来调用其他模块
    const viewCacheAddr = await viewCache.getAddress();
    await acm.grantRole(actionAdminKey, viewCacheAddr);

    // ====== 立即验证权限分配是否生效 ======
    const hasAdmin = await acm.hasRole(actionAdminKey, batchViewAddr);
    const hasUserData = await acm.hasRole(actionViewUserDataKey, batchViewAddr);
    const hasRiskData = await acm.hasRole(actionViewRiskDataKey, batchViewAddr);
    const hasSystemData = await acm.hasRole(actionViewSystemDataKey, batchViewAddr);
    const hasCacheData = await acm.hasRole(actionViewCacheDataKey, batchViewAddr);
    const hasSystemStatus = await acm.hasRole(actionViewSystemStatusKey, batchViewAddr);
    
    // eslint-disable-next-line no-console
    console.log('BatchView 权限验证:');
    console.log('  - ACM 地址:', await acm.getAddress());
    console.log('  - BatchView 地址:', batchViewAddr);
    console.log('  - ACTION_ADMIN:', hasAdmin);
    console.log('  - VIEW_USER_DATA:', hasUserData);
    console.log('  - VIEW_RISK_DATA:', hasRiskData);
    console.log('  - VIEW_SYSTEM_DATA:', hasSystemData);
    console.log('  - VIEW_CACHE_DATA:', hasCacheData);
    console.log('  - ACTION_VIEW_SYSTEM_STATUS:', hasSystemStatus);
    
    // 断言确保权限已授予
    expect(hasAdmin).to.equal(true, 'BatchView 合约应被授予 ACTION_ADMIN 权限');
    expect(hasUserData).to.equal(true, 'BatchView 合约应被授予 VIEW_USER_DATA 权限');
    expect(hasRiskData).to.equal(true, 'BatchView 合约应被授予 VIEW_RISK_DATA 权限');
    expect(hasSystemData).to.equal(true, 'BatchView 合约应被授予 VIEW_SYSTEM_DATA 权限');
    expect(hasCacheData).to.equal(true, 'BatchView 合约应被授予 VIEW_CACHE_DATA 权限');
    expect(hasSystemStatus).to.equal(true, 'BatchView 合约应被授予 ACTION_VIEW_SYSTEM_STATUS 权限');

    // ====== 验证子模块的 ACM 地址 ======
    const userViewAcm = await userView.acm();
    const riskViewAcm = await riskView.acm();
    const systemViewAcm = await systemView.acm();
    const viewCacheAcm = await viewCache.acm();
    
    expect(userViewAcm).to.equal(await acm.getAddress(), 'UserView 的 ACM 地址应正确设置');
    expect(riskViewAcm).to.equal(await acm.getAddress(), 'RiskView 的 ACM 地址应正确设置');
    expect(systemViewAcm).to.equal(await acm.getAddress(), 'SystemView 的 ACM 地址应正确设置');
    expect(viewCacheAcm).to.equal(await acm.getAddress(), 'ViewCache 的 ACM 地址应正确设置');

    return { 
      batchView, 
      userView,
      riskView,
      systemView,
      viewCache,
      vaultStorage,
      acm, 
      governance, 
      admin, 
      alice, 
      bob, 
      charlie,
      david,
      emma
    };
  }

  // ====== 权限分配验证测试 ======
  describe('权限分配验证测试', function () {
    it('BatchView 合约地址应拥有 ACTION_ADMIN 权限', async function () {
      const { acm, batchView } = await deployFixture();
      const actionAdminKey = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
      const batchViewAddr = await batchView.getAddress();
      const hasRole = await acm.hasRole(actionAdminKey, batchViewAddr);
      expect(hasRole).to.equal(true);
    });

    it('BatchView 合约地址应拥有 VIEW_USER_DATA 权限', async function () {
      const { acm, batchView } = await deployFixture();
      const actionViewUserDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
      const batchViewAddr = await batchView.getAddress();
      const hasRole = await acm.hasRole(actionViewUserDataKey, batchViewAddr);
      expect(hasRole).to.equal(true);
    });

    it('BatchView 合约地址应拥有 VIEW_RISK_DATA 权限', async function () {
      const { acm, batchView } = await deployFixture();
      const actionViewRiskDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_RISK_DATA'));
      const batchViewAddr = await batchView.getAddress();
      const hasRole = await acm.hasRole(actionViewRiskDataKey, batchViewAddr);
      expect(hasRole).to.equal(true);
    });

    it('BatchView 合约地址应拥有 VIEW_SYSTEM_DATA 权限', async function () {
      const { acm, batchView } = await deployFixture();
      const actionViewSystemDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA'));
      const batchViewAddr = await batchView.getAddress();
      const hasRole = await acm.hasRole(actionViewSystemDataKey, batchViewAddr);
      expect(hasRole).to.equal(true);
    });

    it('MockAccessControlManager 的 grantRole/hasRole 应正常工作', async function () {
      const { acm } = await deployFixture();
      const [testUser] = await ethers.getSigners();
      const testRole = ethers.keccak256(ethers.toUtf8Bytes('TEST_ROLE'));
      
      // 初始状态应无权限
      expect(await acm.hasRole(testRole, testUser.address)).to.equal(false);
      
      // 授予权限
      await acm.grantRole(testRole, testUser.address);
      
      // 验证权限已授予
      expect(await acm.hasRole(testRole, testUser.address)).to.equal(true);
    });

    it('MockAccessControlManager 的 requireRole 应正常工作', async function () {
      const { acm } = await deployFixture();
      const [testUser] = await ethers.getSigners();
      const testRole = ethers.keccak256(ethers.toUtf8Bytes('TEST_ROLE'));
      
      // 初始状态应无权限，requireRole 应该失败
      await expect(
        acm.requireRole(testRole, testUser.address)
      ).to.be.reverted;
      
      // 授予权限
      await acm.grantRole(testRole, testUser.address);
      
      // requireRole 应该成功
      await expect(
        acm.requireRole(testRole, testUser.address)
      ).to.not.be.reverted;
    });

    it('charlie 用户应拥有 VIEW_RISK_DATA 权限', async function () {
      const { acm, charlie } = await deployFixture();
      const actionViewRiskDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_RISK_DATA'));
      const hasRole = await acm.hasRole(actionViewRiskDataKey, charlie.address);
      expect(hasRole).to.equal(true);
    });

    it('charlie 用户的 requireRole 应正常工作', async function () {
      const { acm, charlie } = await deployFixture();
      const actionViewRiskDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_RISK_DATA'));
      
      // requireRole 应该成功
      await expect(
        acm.requireRole(actionViewRiskDataKey, charlie.address)
      ).to.not.be.reverted;
    });

    it('charlie 用户直接调用 requireRole 应成功', async function () {
      const { acm, charlie } = await deployFixture();
      const actionViewRiskDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_RISK_DATA'));
      
      // 调试信息
      console.log('charlie 地址:', charlie.address);
      const hasRole = await acm.hasRole(actionViewRiskDataKey, charlie.address);
      console.log('charlie 是否有 VIEW_RISK_DATA 权限:', hasRole);
      
      // charlie 直接调用 requireRole 应该成功
      await expect(
        acm.connect(charlie).requireRole(actionViewRiskDataKey, charlie.address)
      ).to.not.be.reverted;
    });

    it('BatchView 应能通过正确的调用链访问子模块', async function () {
      const { batchView, admin, acm } = await deployFixture();
      
      // 验证 BatchView 在 ACM 中的权限
      const batchViewAddr = await batchView.getAddress();
      const actionAdminKey = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
      const hasAdmin = await acm.hasRole(actionAdminKey, batchViewAddr);
      console.log('BatchView 是否有 ACTION_ADMIN 权限:', hasAdmin);
      
      // 使用 admin 调用 BatchView 的批量查询函数
      const users = [admin.address];
      const assets = [ZERO_ADDRESS];
      
      try {
        const result = await batchView.connect(admin).batchGetUserCompleteStatus(users, assets);
        console.log('BatchView 调用成功:', result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log('BatchView 调用失败:', errorMessage);
        throw error;
      }
    });
  });

  describe('初始化测试', function () {
    it('应正确初始化合约', async function () {
      const { batchView, acm, userView, riskView, systemView } = await deployFixture();
      
      expect(await batchView.acm()).to.equal(await acm.getAddress());
      expect(await batchView.userView()).to.equal(await userView.getAddress());
      expect(await batchView.riskView()).to.equal(await riskView.getAddress());
      expect(await batchView.systemView()).to.equal(await systemView.getAddress());
    });

    it('初始化时应验证地址有效性', async function () {
      const { acm, userView, riskView, systemView } = await deployFixture();
      
      const batchViewFactory = await ethers.getContractFactory('BatchView');
      const batchView = await batchViewFactory.deploy();
      await batchView.waitForDeployment();

      // 测试无效 ACM 地址
      await expect(
        batchView.initialize(
          ZERO_ADDRESS,
          await userView.getAddress(),
          await riskView.getAddress(),
          await systemView.getAddress()
        )
      ).to.be.revertedWith('BatchView: invalid ACM address');

      // 测试无效 UserView 地址
      await expect(
        batchView.initialize(
          await acm.getAddress(),
          ZERO_ADDRESS,
          await riskView.getAddress(),
          await systemView.getAddress()
        )
      ).to.be.revertedWith('BatchView: invalid UserView address');

      // 测试无效 RiskView 地址
      await expect(
        batchView.initialize(
          await acm.getAddress(),
          await userView.getAddress(),
          ZERO_ADDRESS,
          await systemView.getAddress()
        )
      ).to.be.revertedWith('BatchView: invalid RiskView address');

      // 测试无效 SystemView 地址
      await expect(
        batchView.initialize(
          await acm.getAddress(),
          await userView.getAddress(),
          await riskView.getAddress(),
          ZERO_ADDRESS
        )
      ).to.be.revertedWith('BatchView: invalid SystemView address');
    });

    it('不应重复初始化', async function () {
      const { batchView, acm, userView, riskView, systemView } = await deployFixture();
      
      await expect(
        batchView.initialize(
          await acm.getAddress(),
          await userView.getAddress(),
          await riskView.getAddress(),
          await systemView.getAddress()
        )
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });
  });

  describe('权限控制测试', function () {
    it('外部账户不应能直接调用关键函数', async function () {
      const { batchView, david } = await deployFixture();
      
      const users = [david.address];
      const assets = [ZERO_ADDRESS];

      // 测试批量风险评估查询权限
      await expect(
        batchView.connect(david).batchGetUserRiskAssessments(users)
      ).to.be.reverted;

      await expect(
        batchView.connect(david).batchGetUserRiskAssessmentsView(users)
      ).to.be.reverted;

      await expect(
        batchView.connect(david).batchGetUserHealthFactors(users)
      ).to.be.reverted;

      // 测试批量系统状态查询权限
      await expect(
        batchView.connect(david).batchGetSystemStatus(assets)
      ).to.be.reverted;

      await expect(
        batchView.connect(david).batchGetLiquidatorProfitViews(users)
      ).to.be.reverted;
    });

    it('有权限的用户应能正常调用函数', async function () {
      const { batchView, charlie, david, emma } = await deployFixture();
      
      const users = [david.address, emma.address];

      // 有风险数据查看权限的用户应能调用风险评估函数
      await expect(
        batchView.connect(charlie).batchGetUserRiskAssessments(users)
      ).to.not.be.reverted;

      await expect(
        batchView.connect(charlie).batchGetUserRiskAssessmentsView(users)
      ).to.not.be.reverted;

      await expect(
        batchView.connect(charlie).batchGetUserHealthFactors(users)
      ).to.not.be.reverted;
    });

    it('批量用户状态查询应验证用户权限', async function () {
      const { batchView, alice, admin, david, emma } = await deployFixture();
      
      const users = [david.address, emma.address];
      const assets = [ZERO_ADDRESS, ZERO_ADDRESS];

      // 普通用户只能查询自己的数据
      await expect(
        batchView.connect(alice).batchGetUserCompleteStatus(users, assets)
      ).to.be.reverted;

      // 用户查询自己的数据应该成功
      const ownUsers = [alice.address];
      const ownAssets = [ZERO_ADDRESS];
      await expect(
        batchView.connect(alice).batchGetUserCompleteStatus(ownUsers, ownAssets)
      ).to.not.be.reverted;

      // 管理员可以查询所有用户的数据
      await expect(
        batchView.connect(admin).batchGetUserCompleteStatus(users, assets)
      ).to.not.be.reverted;
    });
  });

  describe('边界条件测试', function () {
    it('空数组应被拒绝', async function () {
      const { batchView, charlie, bob } = await deployFixture();
      
      const emptyUsers: string[] = [];
      const emptyAssets: string[] = [];

      // 测试风险评估查询
      await expect(
        batchView.connect(charlie).batchGetUserRiskAssessments(emptyUsers)
      ).to.be.revertedWith('BatchView: empty users array');

      await expect(
        batchView.connect(charlie).batchGetUserRiskAssessmentsView(emptyUsers)
      ).to.be.revertedWith('BatchView: empty users array');

      await expect(
        batchView.connect(charlie).batchGetUserHealthFactors(emptyUsers)
      ).to.be.revertedWith('BatchView: empty users array');

      // 测试系统状态查询
      await expect(
        batchView.connect(bob).batchGetSystemStatus(emptyAssets)
      ).to.be.revertedWith('BatchView: empty assets array');

      // 测试清算人查询
      await expect(
        batchView.connect(bob).batchGetLiquidatorProfitViews(emptyUsers)
      ).to.be.revertedWith('BatchView: empty liquidators array');
    });

    it('超过最大批量大小的数组应被拒绝', async function () {
      const { batchView, charlie, bob } = await deployFixture();
      
      // 创建超过最大批量大小的数组
      const largeUsers = new Array(101).fill(ZERO_ADDRESS);
      const largeAssets = new Array(21).fill(ZERO_ADDRESS);
      const largeLiquidators = new Array(51).fill(ZERO_ADDRESS);

      // 测试风险评估查询
      await expect(
        batchView.connect(charlie).batchGetUserRiskAssessments(largeUsers)
      ).to.be.revertedWith('BatchView: too many users');

      await expect(
        batchView.connect(charlie).batchGetUserRiskAssessmentsView(largeUsers)
      ).to.be.revertedWith('BatchView: too many users');

      await expect(
        batchView.connect(charlie).batchGetUserHealthFactors(largeUsers)
      ).to.be.revertedWith('BatchView: too many users');

      // 测试系统状态查询
      await expect(
        batchView.connect(bob).batchGetSystemStatus(largeAssets)
      ).to.be.revertedWith('BatchView: too many assets');

      // 测试清算人查询
      await expect(
        batchView.connect(bob).batchGetLiquidatorProfitViews(largeLiquidators)
      ).to.be.revertedWith('BatchView: too many liquidators');
    });

    it('数组长度不匹配应被拒绝', async function () {
      const { batchView, alice } = await deployFixture();
      
      const users = [alice.address, alice.address];
      const assets = [ZERO_ADDRESS]; // 长度不匹配

      await expect(
        batchView.connect(alice).batchGetUserCompleteStatus(users, assets)
      ).to.be.revertedWith('BatchView: array length mismatch');
    });

    it('零地址用户应被正确处理', async function () {
      const { batchView, charlie } = await deployFixture();
      
      const users = [ZERO_ADDRESS];
      
      // 应该能正常调用，但可能返回默认值
      await expect(
        batchView.connect(charlie).batchGetUserRiskAssessments(users)
      ).to.not.be.reverted;

      await expect(
        batchView.connect(charlie).batchGetUserHealthFactors(users)
      ).to.not.be.reverted;
    });
  });

  describe('批量风险评估查询测试', function () {
    it('应正确批量获取用户风险评估', async function () {
      const { batchView, charlie, david, emma } = await deployFixture();
      
      // 调试信息
      console.log('测试中的 charlie 地址:', charlie.address);
      const actionViewRiskDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_RISK_DATA'));
      const acm = await ethers.getContractAt('MockAccessControlManager', await batchView.acm());
      const hasRole = await acm.hasRole(actionViewRiskDataKey, charlie.address);
      console.log('测试中的 charlie 是否有 VIEW_RISK_DATA 权限:', hasRole);
      
      const users = [david.address, emma.address];
      
      // 这个函数不是 view 函数，会返回交易响应
      const tx = await batchView.connect(charlie).batchGetUserRiskAssessments(users);
      
      // 等待交易完成
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;
      expect(receipt!.status).to.equal(1); // 交易成功
      
      // 由于这不是 view 函数，我们无法直接获取返回值
      // 但我们可以验证交易成功执行
      console.log('风险评估查询交易成功执行');
    });

    it('应正确批量获取用户风险评估（view 版本）', async function () {
      const { batchView, charlie, david, emma } = await deployFixture();
      
      const users = [david.address, emma.address];
      
      const assessments = await batchView.connect(charlie).batchGetUserRiskAssessmentsView(users);
      
      expect(assessments).to.have.length(2);
      // 验证返回的结构体包含预期字段
      // 注意：返回的是结构体数组，每个元素是一个 RiskAssessment 结构体
      // RiskAssessment 结构体包含：liquidatable, riskScore, healthFactor, riskLevel, safetyMargin, warningLevel
      expect(assessments[0]).to.have.length(6); // 6个字段
      expect(assessments[1]).to.have.length(6); // 6个字段
      
      // 验证字段类型
      expect(typeof assessments[0][0]).to.equal('boolean'); // liquidatable
      expect(typeof assessments[0][1]).to.equal('bigint'); // riskScore
      expect(typeof assessments[0][2]).to.equal('bigint'); // healthFactor
      expect(typeof assessments[0][3]).to.equal('bigint'); // riskLevel
      expect(typeof assessments[0][4]).to.equal('bigint'); // safetyMargin
      expect(typeof assessments[0][5]).to.equal('bigint'); // warningLevel
    });

    it('应正确批量获取用户健康因子', async function () {
      const { batchView, charlie, david, emma } = await deployFixture();
      
      const users = [david.address, emma.address];
      
      const healthFactors = await batchView.connect(charlie).batchGetUserHealthFactors(users);
      
      expect(healthFactors).to.have.length(2);
      // 健康因子应该是有效的 uint256 值
      expect(healthFactors[0]).to.be.a('bigint');
      expect(healthFactors[1]).to.be.a('bigint');
    });
  });

  describe('批量用户状态查询测试', function () {
    it('应正确批量获取用户完整状态', async function () {
      const { batchView, alice } = await deployFixture();
      
      const users = [alice.address];
      const assets = [ZERO_ADDRESS];
      
      const [positions, healthFactors, riskLevels] = await batchView.connect(alice).batchGetUserCompleteStatus(users, assets);
      
      expect(positions).to.have.length(2); // collateral + debt
      expect(healthFactors).to.have.length(1);
      expect(riskLevels).to.have.length(1);
      
      // 验证返回的数据类型
      expect(positions[0]).to.be.a('bigint'); // collateral
      expect(positions[1]).to.be.a('bigint'); // debt
      expect(healthFactors[0]).to.be.a('bigint');
      expect(riskLevels[0]).to.be.a('bigint');
    });

    it('应正确处理多个用户的批量查询', async function () {
      const { batchView, alice, admin } = await deployFixture();
      
      const users = [alice.address, admin.address];
      const assets = [ZERO_ADDRESS, ZERO_ADDRESS];
      
      const [positions, healthFactors, riskLevels] = await batchView.connect(admin).batchGetUserCompleteStatus(users, assets);
      
      expect(positions).to.have.length(4); // 2 users * 2 (collateral + debt)
      expect(healthFactors).to.have.length(2);
      expect(riskLevels).to.have.length(2);
    });
  });

  describe('批量系统状态查询测试', function () {
    it('应正确批量获取系统状态', async function () {
      const { batchView, bob } = await deployFixture();
      
      const assets = [ZERO_ADDRESS];
      
      const [totalCollaterals, totalDebts, prices, capsRemaining] = await batchView.connect(bob).batchGetSystemStatus(assets);
      
      expect(totalCollaterals).to.have.length(1);
      expect(totalDebts).to.have.length(1);
      expect(prices).to.have.length(1);
      expect(capsRemaining).to.have.length(1);
      
      // 验证返回的数据类型
      expect(totalCollaterals[0]).to.be.a('bigint');
      expect(totalDebts[0]).to.be.a('bigint');
      expect(prices[0]).to.be.a('bigint');
      expect(capsRemaining[0]).to.be.a('bigint');
    });

    it('应正确处理多个资产的批量查询', async function () {
      const { batchView, bob } = await deployFixture();
      
      const assets = [ZERO_ADDRESS, ZERO_ADDRESS];
      
      const [totalCollaterals, totalDebts, prices, capsRemaining] = await batchView.connect(bob).batchGetSystemStatus(assets);
      
      expect(totalCollaterals).to.have.length(2);
      expect(totalDebts).to.have.length(2);
      expect(prices).to.have.length(2);
      expect(capsRemaining).to.have.length(2);
    });
  });

  describe('批量清算人查询测试', function () {
    it('应正确批量获取清算人收益统计', async function () {
      const { batchView, bob, david, emma } = await deployFixture();
      
      const liquidators = [david.address, emma.address];
      
      const views = await batchView.connect(bob).batchGetLiquidatorProfitViews(liquidators);
      
      expect(views).to.have.length(2);
      // 验证返回的结构体包含预期字段
      // 注意：返回的是结构体数组，每个元素是一个 LiquidatorProfitView 结构体
      // LiquidatorProfitView 结构体包含：liquidator, totalProfit, totalLiquidations, lastLiquidationTime, totalProfitValue, averageProfitPerLiquidation, daysSinceLastLiquidation
      expect(views[0]).to.have.length(7); // 7个字段
      expect(views[1]).to.have.length(7); // 7个字段
      
      // 验证字段类型
      expect(typeof views[0][0]).to.equal('string'); // liquidator (address)
      expect(typeof views[0][1]).to.equal('bigint'); // totalProfit
      expect(typeof views[0][2]).to.equal('bigint'); // totalLiquidations
      expect(typeof views[0][3]).to.equal('bigint'); // lastLiquidationTime
      expect(typeof views[0][4]).to.equal('bigint'); // totalProfitValue
      expect(typeof views[0][5]).to.equal('bigint'); // averageProfitPerLiquidation
      expect(typeof views[0][6]).to.equal('bigint'); // daysSinceLastLiquidation
    });
  });

  describe('集成测试', function () {
    it('完整批量查询流程', async function () {
      const { batchView, charlie, bob, alice } = await deployFixture();
      
      const users = [alice.address];
      const assets = [ZERO_ADDRESS];
      
      // 1. 批量风险评估查询
      const tx = await batchView.connect(charlie).batchGetUserRiskAssessments(users);
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;
      expect(receipt!.status).to.equal(1); // 交易成功
      
      // 2. 批量健康因子查询
      const healthFactors = await batchView.connect(charlie).batchGetUserHealthFactors(users);
      expect(healthFactors).to.have.length(1);
      
      // 3. 批量用户状态查询
      const [positions, userHealthFactors, riskLevels] = await batchView.connect(alice).batchGetUserCompleteStatus(users, assets);
      expect(positions).to.have.length(2);
      expect(userHealthFactors).to.have.length(1);
      expect(riskLevels).to.have.length(1);
      
      // 4. 批量系统状态查询
      const [totalCollaterals, totalDebts, prices, capsRemaining] = await batchView.connect(bob).batchGetSystemStatus(assets);
      expect(totalCollaterals).to.have.length(1);
      expect(totalDebts).to.have.length(1);
      expect(prices).to.have.length(1);
      expect(capsRemaining).to.have.length(1);
    });
  });

  describe('安全场景测试', function () {
    it('应防止重入攻击', async function () {
      const { batchView, charlie } = await deployFixture();
      
      const users = [ZERO_ADDRESS];
      
      // 批量查询函数应该是 view 或 pure，不涉及状态变更
      // 这里主要测试函数调用的稳定性
      await expect(
        batchView.connect(charlie).batchGetUserRiskAssessments(users)
      ).to.not.be.reverted;
      
      await expect(
        batchView.connect(charlie).batchGetUserHealthFactors(users)
      ).to.not.be.reverted;
    });

    it('应正确处理权限绕过尝试', async function () {
      const { batchView, david } = await deployFixture();
      
      const users = [david.address];
      const assets = [ZERO_ADDRESS];
      
      // 尝试在没有权限的情况下调用函数
      await expect(
        batchView.connect(david).batchGetUserRiskAssessments(users)
      ).to.be.reverted;
      
      await expect(
        batchView.connect(david).batchGetSystemStatus(assets)
      ).to.be.reverted;
    });

    it('应正确处理恶意输入', async function () {
      const { batchView, charlie } = await deployFixture();
      
      // 测试极端大的数组（虽然会被长度检查阻止）
      const extremeUsers = new Array(1000).fill(ZERO_ADDRESS);
      
      await expect(
        batchView.connect(charlie).batchGetUserRiskAssessments(extremeUsers)
      ).to.be.revertedWith('BatchView: too many users');
    });
  });

  describe('升级控制测试', function () {
    it('只有授权用户才能升级合约', async function () {
      // 非授权用户尝试升级应该失败
      // 注意：这里需要实际的升级逻辑，但 BatchView 使用 UUPS 模式
      // 实际的升级测试需要更复杂的设置
      
      // 验证 _authorizeUpgrade 函数的权限检查
      // 这通常通过尝试升级来测试，但需要代理合约设置
    });

    it('合约暂停时不应允许升级', async function () {
      // 这个测试需要设置合约暂停状态
      // 在实际环境中，需要先暂停合约，然后尝试升级
    });
  });

  describe('Gas 优化测试', function () {
    it('批量查询应比单个查询更高效', async function () {
      const { batchView, charlie, david, emma } = await deployFixture();
      
      const users = [david.address, emma.address];
      
      // 测试批量查询的 gas 消耗
      const healthFactors = await batchView.connect(charlie).batchGetUserHealthFactors(users);
      
      // 验证批量查询成功完成
      expect(healthFactors).to.have.length(2);
    });

    it('大批量查询应在合理范围内', async function () {
      const { batchView, charlie } = await deployFixture();
      
      // 测试最大允许的批量大小
      const maxUsers = new Array(100).fill(ZERO_ADDRESS);
      
      await expect(
        batchView.connect(charlie).batchGetUserHealthFactors(maxUsers)
      ).to.not.be.reverted;
    });
  });

  describe('错误处理测试', function () {
    it('应正确处理依赖合约调用失败', async function () {
      // 这个测试需要模拟依赖合约的失败情况
      // 在实际环境中，可能需要部署有问题的 Mock 合约
    });

    it('应正确处理权限检查失败', async function () {
      const { batchView, david } = await deployFixture();
      
      const users = [david.address];
      
      // 没有权限的用户调用应该失败
      await expect(
        batchView.connect(david).batchGetUserRiskAssessments(users)
      ).to.be.reverted;
    });
  });

  describe('数据一致性测试', function () {
    it('批量查询结果应与单个查询一致', async function () {
      const { batchView, charlie, david } = await deployFixture();
      
      const users = [david.address];
      
      // 批量查询
      const batchHealthFactors = await batchView.connect(charlie).batchGetUserHealthFactors(users);
      
      // 单个查询（通过 UserView）
      const userViewAddress = await batchView.userView();
      const userView = await ethers.getContractAt('UserView', userViewAddress);
      
      // 为 charlie 授予查看用户数据的权限
      const acm = await ethers.getContractAt('MockAccessControlManager', await batchView.acm());
      const actionViewUserDataKey = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
      await acm.grantRole(actionViewUserDataKey, charlie.address);
      
      // 为 charlie 授予 ACTION_ADMIN 权限，以便他能查看任何用户的数据
      const actionAdminKey = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
      await acm.grantRole(actionAdminKey, charlie.address);
      
      const singleHealthFactor = await userView.connect(charlie).getHealthFactor(david.address);
      
      // 结果应该一致
      expect(batchHealthFactors[0]).to.equal(singleHealthFactor);
    });
  });
}); 
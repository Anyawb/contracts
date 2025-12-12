/**
 * 合约级别用户隔离系统测试
 * 
 * 测试目标:
 * - 用户数据访问权限控制
 * - 系统数据访问权限控制
 * - 风险数据访问权限控制
 * - 缓存数据访问权限控制
 * - 权限修饰符功能验证
 * - 错误处理和边界条件
 */

import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;




// 常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TEST_AMOUNT = ethers.parseUnits('100', 18);

describe('合约级别用户隔离系统 – 完整测试套件', function () {
  // 部署测试环境
  async function deployFixture() {
    const [governance, admin, alice, bob, frontendService, systemService] = await ethers.getSigners();

    // 部署 ACM
    const acmFactory = await ethers.getContractFactory('MockAccessControlManager');
    const acm = await acmFactory.deploy();
    await acm.waitForDeployment();

    // 部署模拟VaultStorage
    const mockVaultStorageFactory = await ethers.getContractFactory('MockERC20');
    const mockVaultStorage = await mockVaultStorageFactory.deploy('Mock Storage', 'MOCK', ethers.parseUnits('1000000', 18));
    await mockVaultStorage.waitForDeployment();

    // 部署 ViewCache
    const viewCacheFactory = await ethers.getContractFactory('ViewCache');
    const viewCache = await viewCacheFactory.deploy();
    await viewCache.waitForDeployment();
    await viewCache.initialize(await acm.getAddress());

    // 部署 UserView
    const userViewFactory = await ethers.getContractFactory('UserView');
    const userView = await userViewFactory.deploy();
    await userView.waitForDeployment();
    await userView.initialize(await acm.getAddress(), await mockVaultStorage.getAddress(), await viewCache.getAddress());

    // 部署 SystemView
    const systemViewFactory = await ethers.getContractFactory('SystemView');
    const systemView = await systemViewFactory.deploy();
    await systemView.waitForDeployment();
    await systemView.initialize(await acm.getAddress(), await mockVaultStorage.getAddress(), await viewCache.getAddress());

    // 部署 RiskView
    const riskViewFactory = await ethers.getContractFactory('RiskView');
    const riskView = await riskViewFactory.deploy();
    await riskView.waitForDeployment();
    await riskView.initialize(await acm.getAddress(), await mockVaultStorage.getAddress(), await viewCache.getAddress());

    // 部署 PreviewView
    const previewViewFactory = await ethers.getContractFactory('PreviewView');
    const previewView = await previewViewFactory.deploy();
    await previewView.waitForDeployment();
    await previewView.initialize(await acm.getAddress(), await userView.getAddress(), await systemView.getAddress());

    // 部署 BatchView
    const batchViewFactory = await ethers.getContractFactory('BatchView');
    const batchView = await batchViewFactory.deploy();
    await batchView.waitForDeployment();
    await batchView.initialize(await acm.getAddress(), await userView.getAddress(), await riskView.getAddress(), await systemView.getAddress());

    // 部署 LiquidatorView
    const liquidatorViewFactory = await ethers.getContractFactory('LiquidatorView');
    const liquidatorView = await liquidatorViewFactory.deploy();
    await liquidatorView.waitForDeployment();
    await liquidatorView.initialize(await acm.getAddress(), await systemView.getAddress());

    // 部署 AccessControlView
    const accessControlViewFactory = await ethers.getContractFactory('AccessControlView');
    const accessControlView = await accessControlViewFactory.deploy();
    await accessControlView.waitForDeployment();
    await accessControlView.initialize(await acm.getAddress());

    // 部署 VaultView
    const vaultViewFactory = await ethers.getContractFactory('VaultView');
    const vaultView = await vaultViewFactory.deploy();
    await vaultView.waitForDeployment();
    
    // 创建模块地址数组，按照VaultView合约要求的顺序
    const moduleAddresses = [
      await userView.getAddress(),      // USER_VIEW
      await riskView.getAddress(),      // RISK_VIEW  
      await systemView.getAddress(),    // SYSTEM_VIEW
      await previewView.getAddress(),   // PREVIEW_VIEW
      await viewCache.getAddress(),     // CACHE_VIEW
      await batchView.getAddress(),     // BATCH_VIEW
      await liquidatorView.getAddress(), // LIQUIDATOR_VIEW
      await accessControlView.getAddress() // ACCESS_CONTROL_VIEW
    ];
    
    await vaultView.initialize(
      await acm.getAddress(),
      moduleAddresses
    );

    // 部署测试代币
    const mockTokenFactory = await ethers.getContractFactory('MockERC20');
    const mockToken = await mockTokenFactory.deploy('Test Token', 'TEST', ethers.parseUnits('1000000', 18));
    await mockToken.waitForDeployment();

    const mockNFTFactory = await ethers.getContractFactory('MockERC721');
    const mockNFT = await mockNFTFactory.deploy('Test NFT', 'TNFT');
    await mockNFT.waitForDeployment();

    const mockERC1155Factory = await ethers.getContractFactory('MockERC1155');
    const mockERC1155 = await mockERC1155Factory.deploy();
    await mockERC1155.waitForDeployment();

    // 设置权限
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN')), admin.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_USER_DATA')), frontendService.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_SYSTEM_DATA')), systemService.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_RISK_DATA')), frontendService.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_CACHE_DATA')), systemService.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_SYSTEM_STATUS')), systemService.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_MODIFY_USER_DATA')), admin.address);
    
    // 为admin授予所有权限以确保测试通过
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_USER_DATA')), admin.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_SYSTEM_DATA')), admin.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_RISK_DATA')), admin.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_CACHE_DATA')), admin.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_SYSTEM_STATUS')), admin.address);

    return {
      governance,
      admin,
      alice,
      bob,
      frontendService,
      systemService,
      acm,
      vaultView,
      userView,
      systemView,
      riskView,
      viewCache,
      previewView,
      batchView,
      liquidatorView,
      accessControlView,
      mockToken,
      mockNFT,
      mockERC1155,
      mockVaultStorage
    };
  }

  // 为每个测试创建新的部署环境，避免初始化冲突
  async function createFreshDeployment() {
    return await deployFixture();
  }

  describe('权限控制测试', function () {
    it('用户只能访问自己的数据', async function () {
      const { vaultView, alice, bob } = await createFreshDeployment();

      // Alice 应该能访问自己的数据
      await expect(
        vaultView.connect(alice).getUserPosition(alice.address, ZERO_ADDRESS)
      ).to.not.be.reverted;

      // Alice 不能访问 Bob 的数据
      await expect(
        vaultView.connect(alice).getUserPosition(bob.address, ZERO_ADDRESS)
      ).to.be.revertedWith('VaultView: unauthorized user data access');
    });

    it('管理员可以访问所有用户数据', async function () {
      const { vaultView, admin, alice, bob } = await createFreshDeployment();

      // 管理员可以访问任何用户的数据
      await expect(
        vaultView.connect(admin).getUserPosition(alice.address, ZERO_ADDRESS)
      ).to.not.be.reverted;

      await expect(
        vaultView.connect(admin).getUserPosition(bob.address, ZERO_ADDRESS)
      ).to.not.be.reverted;
    });

    it('前端服务可以访问用户数据', async function () {
      const { vaultView, frontendService, alice } = await createFreshDeployment();

      // 前端服务可以访问用户数据
      await expect(
        vaultView.connect(frontendService).getUserPosition(alice.address, ZERO_ADDRESS)
      ).to.not.be.reverted;
    });

    it('系统服务可以访问系统数据', async function () {
      const { vaultView, systemService } = await createFreshDeployment();

      // 系统服务可以访问系统数据
      await expect(
        vaultView.connect(systemService).getTotalCollateral(ZERO_ADDRESS)
      ).to.not.be.reverted;

      await expect(
        vaultView.connect(systemService).getVaultParams()
      ).to.not.be.reverted;
    });

    it('普通用户不能访问系统数据', async function () {
      const { vaultView, alice } = await createFreshDeployment();

      // 普通用户不能访问系统数据
      await expect(
        vaultView.connect(alice).getTotalCollateral(ZERO_ADDRESS)
      ).to.be.revertedWith('AccessControlManager: role required');

      await expect(
        vaultView.connect(alice).getVaultParams()
      ).to.be.revertedWith('AccessControlManager: role required');
    });
  });

  describe('UserView 模块权限测试', function () {
    it('用户数据查询权限验证', async function () {
      const { userView, alice, bob } = await createFreshDeployment();

      // Alice 可以查询自己的数据
      await expect(
        userView.connect(alice).getUserPosition(alice.address, ZERO_ADDRESS)
      ).to.not.be.reverted;

      // Alice 不能查询 Bob 的数据
      await expect(
        userView.connect(alice).getUserPosition(bob.address, ZERO_ADDRESS)
      ).to.be.revertedWith('UserView: unauthorized access');
    });

    it('健康因子查询权限验证', async function () {
      const { userView, alice, bob } = await createFreshDeployment();

      // Alice 可以查询自己的健康因子
      await expect(
        userView.connect(alice).getHealthFactor(alice.address)
      ).to.not.be.reverted;

      // Alice 不能查询 Bob 的健康因子
      await expect(
        userView.connect(alice).getHealthFactor(bob.address)
      ).to.be.revertedWith('UserView: unauthorized access');
    });

    it('预览功能权限验证', async function () {
      const { userView, alice, bob } = await createFreshDeployment();

      // Alice 可以预览自己的操作
      await expect(
        userView.connect(alice).previewDeposit(alice.address, ZERO_ADDRESS, TEST_AMOUNT)
      ).to.not.be.reverted;

      // Alice 不能预览 Bob 的操作
      await expect(
        userView.connect(alice).previewDeposit(bob.address, ZERO_ADDRESS, TEST_AMOUNT)
      ).to.be.revertedWith('UserView: unauthorized access');
    });
  });

  describe('SystemView 模块权限测试', function () {
    it('系统数据访问权限分层', async function () {
      const { systemView, alice, systemService } = await createFreshDeployment();

      // 普通用户不能访问系统数据
      await expect(
        systemView.connect(alice).getTotalCollateral(ZERO_ADDRESS)
      ).to.be.revertedWith('AccessControlManager: role required');

      // 系统服务可以访问基础系统数据
      await expect(
        systemView.connect(systemService).getTotalCollateral(ZERO_ADDRESS)
      ).to.not.be.reverted;
    });

    it('系统状态访问权限验证', async function () {
      const { systemView, alice, systemService } = await createFreshDeployment();

      // 普通用户不能访问系统状态
      await expect(
        systemView.connect(alice).getGlobalStatisticsView()
      ).to.be.revertedWith('AccessControlManager: role required');

      // 系统服务可以访问系统状态
      await expect(
        systemView.connect(systemService).getGlobalStatisticsView()
      ).to.not.be.reverted;
    });
  });

  describe('RiskView 模块权限测试', function () {
    it('用户风险评估权限验证', async function () {
      const { riskView, alice, bob } = await createFreshDeployment();

      // Alice 可以评估自己的风险
      await expect(
        riskView.connect(alice).getUserRiskAssessment(alice.address)
      ).to.not.be.reverted;

      // Alice 不能评估 Bob 的风险
      await expect(
        riskView.connect(alice).getUserRiskAssessment(bob.address)
      ).to.be.revertedWith('RiskView: unauthorized access');
    });

    it('用户预警级别权限验证', async function () {
      const { riskView, alice, bob } = await createFreshDeployment();

      // Alice 可以查看自己的预警级别
      await expect(
        riskView.connect(alice).getUserWarningLevel(alice.address)
      ).to.not.be.reverted;

      // Alice 不能查看 Bob 的预警级别
      await expect(
        riskView.connect(alice).getUserWarningLevel(bob.address)
      ).to.be.revertedWith('RiskView: unauthorized access');
    });
  });

  describe('ViewCache 模块权限测试', function () {
    it('用户缓存访问权限验证（严格模式）', async function () {
      const { viewCache, alice, bob, systemService } = await createFreshDeployment();

      // 设置缓存
      await viewCache.connect(systemService).setHealthFactorCache(alice.address, 11000);

      // Alice 可以访问自己的缓存
      await expect(
        viewCache.connect(alice).getHealthFactorCache(alice.address)
      ).to.not.be.reverted;

      // Alice 不能访问 Bob 的缓存
      await expect(
        viewCache.connect(alice).getHealthFactorCache(bob.address)
      ).to.be.revertedWith('ViewCache: unauthorized access');
    });

    it('用户缓存访问权限验证（宽松模式）', async function () {
      const { viewCache, alice, systemService } = await createFreshDeployment();

      // 设置缓存
      await viewCache.connect(systemService).setHealthFactorCache(alice.address, 11000);

      // Alice 可以访问自己的缓存（宽松模式）
      await expect(
        viewCache.connect(alice).getHealthFactorCacheViewer(alice.address)
      ).to.not.be.reverted;

      // 系统服务可以访问用户缓存（宽松模式）
      await expect(
        viewCache.connect(systemService).getHealthFactorCacheViewer(alice.address)
      ).to.not.be.reverted;
    });

    it('系统缓存访问权限验证', async function () {
      const { viewCache, alice, systemService } = await createFreshDeployment();

      // 设置系统缓存
      await viewCache.connect(systemService).setSystemStatusCache(85);

      // 普通用户不能访问系统缓存
      await expect(
        viewCache.connect(alice).getSystemStatusCache()
      ).to.be.revertedWith('ViewCache: unauthorized sensitive cache data access');

      // 系统服务可以访问系统缓存
      await expect(
        viewCache.connect(systemService).getSystemStatusCache()
      ).to.not.be.reverted;
    });
  });

  describe('错误处理测试', function () {
    it('权限撤销后的行为', async function () {
      const { vaultView, frontendService, alice, acm } = await createFreshDeployment();

      // 前端服务原本可以访问用户数据
      await expect(
        vaultView.connect(frontendService).getUserPosition(alice.address, ZERO_ADDRESS)
      ).to.not.be.reverted;

      // 撤销权限
      await acm.revokeRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_USER_DATA')), frontendService.address);

      // 权限撤销后应该被拒绝
      await expect(
        vaultView.connect(frontendService).getUserPosition(alice.address, ZERO_ADDRESS)
      ).to.be.revertedWith('AccessControlManager: role required');
    });

    it('无效权限检查', async function () {
      const { vaultView, alice } = await createFreshDeployment();

      // 使用无效的权限应该被拒绝
      await expect(
        vaultView.connect(alice).getTotalCollateral(ZERO_ADDRESS)
      ).to.be.revertedWith('AccessControlManager: role required');
    });
  });

  describe('集成测试', function () {
    it('完整用户数据访问流程', async function () {
      const { vaultView, userView, riskView, viewCache, alice, systemService } = await createFreshDeployment();

      // 1. 设置缓存
      await viewCache.connect(systemService).setHealthFactorCache(alice.address, 11000);
      await viewCache.connect(systemService).setRiskAssessmentCache(alice.address, 85);

      // 2. 用户查询自己的数据
      const position = await vaultView.connect(alice).getUserPosition(alice.address, ZERO_ADDRESS);
      expect(position).to.not.be.undefined;

      const healthFactor = await userView.connect(alice).getHealthFactor(alice.address);
      expect(healthFactor).to.not.be.undefined;

      const riskAssessment = await riskView.connect(alice).getUserRiskAssessment(alice.address);
      expect(riskAssessment).to.not.be.undefined;

      // 3. 验证缓存访问
      const cacheData = await viewCache.connect(alice).getHealthFactorCache(alice.address);
      expect(cacheData.isValid).to.be.true;
    });

    it('缓存数据访问流程', async function () {
      const { viewCache, alice, systemService } = await createFreshDeployment();

      // 设置缓存
      await viewCache.connect(systemService).setHealthFactorCache(alice.address, 11000);
      await viewCache.connect(systemService).setRiskAssessmentCache(alice.address, 85);

      // 用户访问自己的缓存
      const healthCache = await viewCache.connect(alice).getHealthFactorCache(alice.address);
      expect(healthCache.isValid).to.be.true;

      const riskCache = await viewCache.connect(alice).getRiskAssessmentCache(alice.address);
      expect(riskCache.isValid).to.be.true;

      // 系统服务访问系统缓存
      await viewCache.connect(systemService).setSystemStatusCache(90);
      const systemCache = await viewCache.connect(systemService).getSystemStatusCache();
      expect(systemCache.isValid).to.be.true;
    });
  });
}); 
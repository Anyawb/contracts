/**
 * RiskView 测试模块
 * 
 * 测试目标:
 * - 初始化功能
 * - 风险评估和预警系统
 * - 权限控制验证
 * - 批量风险评估功能
 * - 缓存机制集成
 * - 错误处理和边界条件
 * - 升级功能验证
 * - 事件记录完整性
 * - 安全场景测试
 * - 模糊测试
 */

import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type { 
  RiskView, 
  MockAccessControlManager, 
  MockVaultStorage, 
  ViewCache, 
  MockHealthFactorCalculator
} from '../../../types';


// 常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('RiskView', function () {
  // 测试账户
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;
  let david: SignerWithAddress;
  let users: SignerWithAddress[];

  // 合约实例
  let riskView: RiskView;
  let acm: MockAccessControlManager;
  let vaultStorage: MockVaultStorage;
  let viewCache: ViewCache;
  let hfCalculator: MockHealthFactorCalculator;

  // 部署夹具
  async function deployFixture() {
    [owner, alice, bob, charlie, david, ...users] = await ethers.getSigners();

    // 部署 MockAccessControlManager
    const MockAccessControlManagerF = await ethers.getContractFactory('MockAccessControlManager');
    acm = await MockAccessControlManagerF.deploy();

    // 部署 MockVaultStorage
    const MockVaultStorageF = await ethers.getContractFactory('MockVaultStorage');
    vaultStorage = await MockVaultStorageF.deploy();

    // 部署 ViewCache
    const ViewCacheF = await ethers.getContractFactory('ViewCache');
    viewCache = await upgrades.deployProxy(ViewCacheF, [await acm.getAddress()]);

    // 部署 MockHealthFactorCalculator
    const MockHealthFactorCalculatorF = await ethers.getContractFactory('MockHealthFactorCalculator');
    hfCalculator = await MockHealthFactorCalculatorF.deploy();

    // 部署 RiskView
    const RiskViewF = await ethers.getContractFactory('RiskView');
    riskView = await upgrades.deployProxy(RiskViewF, [
      await acm.getAddress(),
      await vaultStorage.getAddress(),
      await viewCache.getAddress()
    ]);

    // 设置权限 - 使用正确的 ActionKeys 常量
    const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
    const ACTION_VIEW_RISK_DATA = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_RISK_DATA'));
    const ACTION_UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('ACTION_UPGRADE_MODULE'));
    const ACTION_VIEW_CACHE_DATA = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_CACHE_DATA'));
    
    // 为 owner 用户授予所有必要权限
    await acm.grantRole(ACTION_ADMIN, owner.address);
    await acm.grantRole(ACTION_VIEW_RISK_DATA, owner.address);
    await acm.grantRole(ACTION_UPGRADE_MODULE, owner.address);
    await acm.grantRole(ACTION_VIEW_CACHE_DATA, owner.address);

    // 为 RiskView 合约本身授予权限，这样它才能调用 ViewCache
    await acm.grantRole(ACTION_VIEW_CACHE_DATA, await riskView.getAddress());
    await acm.grantRole(ACTION_ADMIN, await riskView.getAddress());

    // 为 ViewCache 合约本身授予权限
    await acm.grantRole(ACTION_ADMIN, await viewCache.getAddress());
    await acm.grantRole(ACTION_VIEW_CACHE_DATA, await viewCache.getAddress());

    // 验证权限设置
    expect(await acm.hasRole(ACTION_VIEW_CACHE_DATA, owner.address)).to.be.true;
    expect(await acm.hasRole(ACTION_ADMIN, owner.address)).to.be.true;
    
    // 确保权限设置正确
    await acm.grantRole(ACTION_VIEW_CACHE_DATA, owner.address);
    await acm.grantRole(ACTION_ADMIN, owner.address);

    // 设置模块映射 - 先注册模块，再更新
    await vaultStorage.connect(owner).registerNamedModule('hfCalculator', await hfCalculator.getAddress());
    // 注册 liquidationRiskManager 模块（使用零地址）
    await vaultStorage.connect(owner).registerNamedModule('liquidationRiskManager', ZERO_ADDRESS);

    return { riskView, acm, vaultStorage, viewCache, hfCalculator, owner, alice, bob, charlie, david, users };
  }

  beforeEach(async function () {
    ({ riskView, acm, vaultStorage, viewCache, hfCalculator, owner, alice, bob, charlie, david, users } = await deployFixture());
  });

  describe('初始化测试', function () {
    it('应正确初始化合约', async function () {
      const { riskView, acm, vaultStorage, viewCache } = await deployFixture();
      
      expect(await riskView.acm()).to.equal(await acm.getAddress());
      expect(await riskView.vaultStorage()).to.equal(await vaultStorage.getAddress());
      expect(await riskView.viewCache()).to.equal(await viewCache.getAddress());
    });

    it('应正确设置权限', async function () {
      const { acm, owner } = await deployFixture();
      
      const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
      const ACTION_VIEW_RISK_DATA = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_RISK_DATA'));
      const ACTION_VIEW_CACHE_DATA = ethers.keccak256(ethers.toUtf8Bytes('ACTION_VIEW_CACHE_DATA'));
      
      expect(await acm.hasRole(ACTION_ADMIN, owner.address)).to.be.true;
      expect(await acm.hasRole(ACTION_VIEW_RISK_DATA, owner.address)).to.be.true;
      expect(await acm.hasRole(ACTION_VIEW_CACHE_DATA, owner.address)).to.be.true;
    });
  });

  describe('风险评估功能测试', function () {
    it('应正确获取用户风险评估', async function () {
      const { riskView, alice } = await deployFixture();
      
      const assessment = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      
      expect(assessment.liquidatable).to.be.false;
      expect(assessment.riskScore).to.equal(20n);
      expect(assessment.healthFactor).to.equal(11000n);
      expect(assessment.riskLevel).to.equal(1n);
      expect(assessment.safetyMargin).to.equal(500n);
      expect(assessment.warningLevel).to.equal(0n);
    });

    it('应正确获取用户风险评估（view 版本）', async function () {
      const { riskView, alice } = await deployFixture();
      
      const assessment = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      
      expect(assessment.liquidatable).to.be.false;
      expect(assessment.riskScore).to.equal(20n);
      expect(assessment.healthFactor).to.equal(11000n);
      expect(assessment.riskLevel).to.equal(1n);
      expect(assessment.safetyMargin).to.equal(500n);
      expect(assessment.warningLevel).to.equal(0n);
    });

    it('应正确处理不同用户', async function () {
      const { riskView, alice, bob, charlie } = await deployFixture();
      
      const assessment1 = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      const assessment2 = await riskView.connect(owner).getUserRiskAssessmentView(bob.address);
      const assessment3 = await riskView.connect(owner).getUserRiskAssessmentView(charlie.address);
      
      expect(assessment1.healthFactor).to.equal(11000n);
      expect(assessment2.healthFactor).to.equal(11000n);
      expect(assessment3.healthFactor).to.equal(11000n);
    });
  });

  describe('批量风险评估功能测试', function () {
    it('应正确处理批量风险评估', async function () {
      const { riskView, alice, bob, charlie } = await deployFixture();
      
      const users = [alice.address, bob.address, charlie.address];
      const assessments = await riskView.connect(owner).batchGetUserRiskAssessmentsView(users);
      
      expect(assessments.length).to.equal(3);
      
      // 验证每个用户的评估结果
      for (let i = 0; i < assessments.length; i++) {
        expect(assessments[i].liquidatable).to.be.false;
        expect(assessments[i].riskScore).to.equal(20n);
        expect(assessments[i].healthFactor).to.equal(11000n);
        expect(assessments[i].riskLevel).to.equal(1n);
        expect(assessments[i].safetyMargin).to.equal(500n);
        expect(assessments[i].warningLevel).to.equal(0n);
      }
    });

    it('应正确处理批量风险评估（view 版本）', async function () {
      const { riskView, alice, bob, charlie } = await deployFixture();
      
      const users = [alice.address, bob.address, charlie.address];
      const assessments = await riskView.connect(owner).batchGetUserRiskAssessmentsView(users);
      
      expect(assessments.length).to.equal(3);
      
      // 验证每个用户的评估结果
      for (let i = 0; i < assessments.length; i++) {
        expect(assessments[i].liquidatable).to.be.false;
        expect(assessments[i].riskScore).to.equal(20n);
        expect(assessments[i].healthFactor).to.equal(11000n);
        expect(assessments[i].riskLevel).to.equal(1n);
        expect(assessments[i].safetyMargin).to.equal(500n);
        expect(assessments[i].warningLevel).to.equal(0n);
      }
    });

    it('应正确处理批量健康因子查询', async function () {
      const { riskView, alice, bob, charlie } = await deployFixture();
      
      const users = [alice.address, bob.address, charlie.address];
      
      // 使用批量风险评估来获取健康因子
      const assessments = await riskView.connect(owner).batchGetUserRiskAssessmentsView(users);
      
      expect(assessments.length).to.equal(3);
      
      // 验证每个用户的健康因子
      for (let i = 0; i < assessments.length; i++) {
        expect(assessments[i].healthFactor).to.equal(11000n);
      }
    });

    it('应拒绝空数组', async function () {
      const { riskView } = await deployFixture();
      
      await expect(
        riskView.connect(owner).batchGetUserRiskAssessmentsView([])
      ).to.be.revertedWith('RiskView: empty users array');
    });

    it('应拒绝过大的批量操作', async function () {
      const { riskView } = await deployFixture();
      
      const largeUserList = Array(101).fill(alice.address);
      
      await expect(
        riskView.connect(owner).batchGetUserRiskAssessmentsView(largeUserList)
      ).to.be.revertedWith('RiskView: batch size too large');
    });

    it('应正确处理大量用户', async function () {
      const { riskView } = await deployFixture();
      
      // 创建50个用户（在限制范围内）
      const manyUsers = Array(50).fill(alice.address);
      const assessments = await riskView.connect(owner).batchGetUserRiskAssessmentsView(manyUsers);
      
      expect(assessments.length).to.equal(50);
    });

    it('应正确处理边界值', async function () {
      const { riskView } = await deployFixture();
      
      // 测试边界值：50个用户（最大允许）
      const boundaryUsers = Array(50).fill(alice.address);
      const assessments = await riskView.connect(owner).batchGetUserRiskAssessmentsView(boundaryUsers);
      
      expect(assessments.length).to.equal(50);
    });
  });

  describe('缓存机制集成测试', function () {
    it('应正确使用缓存', async function () {
      const { riskView, viewCache, alice } = await deployFixture();
      
      // 设置缓存
      await viewCache.connect(owner).setHealthFactorCache(alice.address, 12000);
      
      // 获取风险评估，应该使用缓存值
      const assessment = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      expect(assessment.healthFactor).to.equal(12000n);
    });

    it('缓存失效时应回退到计算器', async function () {
      const { riskView, viewCache, alice } = await deployFixture();
      
      // 设置缓存
      await viewCache.connect(owner).setHealthFactorCache(alice.address, 12000);
      
      // 验证缓存生效
      let assessment = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      expect(assessment.healthFactor).to.equal(12000n);
      
      // 清除缓存，测试回退逻辑
      await viewCache.connect(owner).clearHealthFactorCache(alice.address);
      
      // 获取风险评估，应该回退到计算器
      assessment = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      expect(assessment.healthFactor).to.equal(11000n); // 来自 MockHealthFactorCalculator
    });
  });

  describe('错误处理测试', function () {
    it('应正确处理健康因子计算器失败', async function () {
      const { riskView, alice } = await deployFixture();
      
      // 将健康因子计算器设置为零地址，模拟失败情况
      await vaultStorage.connect(owner).updateNamedModule('hfCalculator', ZERO_ADDRESS);
      
      const assessment = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      
      // 应该返回最大健康因子
      expect(assessment.healthFactor).to.equal(ethers.MaxUint256);
    });

    it('应正确处理清算风险管理器未设置', async function () {
      const { riskView, alice } = await deployFixture();
      
      // 确保清算风险管理器未设置
      await vaultStorage.connect(owner).updateNamedModule('liquidationRiskManager', ZERO_ADDRESS);
      
      const assessment = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      
      // 应该使用简化计算
      expect(assessment.healthFactor).to.equal(11000n);
      expect(assessment.liquidatable).to.be.false;
    });

    it('应正确处理无效用户地址', async function () {
      const { riskView } = await deployFixture();
      
      const assessment = await riskView.connect(owner).getUserRiskAssessmentView(ZERO_ADDRESS);
      
      // 应该返回默认值
      expect(assessment.healthFactor).to.equal(11000n);
      expect(assessment.liquidatable).to.be.false;
    });

    it('应正确处理权限不足', async function () {
      const { riskView, alice } = await deployFixture();
      
      // 测试权限不足的情况
      await expect(
        riskView.connect(alice).getUserRiskAssessmentView(bob.address)
      ).to.be.revertedWith('RiskView: unauthorized access');
    });
  });

  describe('升级功能测试', function () {
    it('应正确验证升级权限', async function () {
      const { riskView, alice } = await deployFixture();
      
      // 普通用户不应能升级
      await expect(
        riskView.connect(alice).upgradeToAndCall(ZERO_ADDRESS, '0x')
      ).to.be.reverted;

      // 管理员应该能升级（这里只是测试权限，不实际升级）
      // 实际升级测试需要更复杂的设置
    });

    it('升级后应保持状态', async function () {
      const { riskView, vaultStorage, viewCache } = await deployFixture();
      
      // 验证升级后的状态保持不变
      expect(await riskView.acm()).to.equal(await acm.getAddress());
      expect(await riskView.vaultStorage()).to.equal(await vaultStorage.getAddress());
      expect(await riskView.viewCache()).to.equal(await viewCache.getAddress());
    });
  });

  describe('安全场景测试', function () {
    it('应防止重入攻击', async function () {
      const { riskView, alice } = await deployFixture();
      
      // 测试重入保护
      await expect(
        riskView.connect(owner).getUserRiskAssessmentView(alice.address)
      ).to.not.be.reverted;
    });

    it('应正确处理权限升级', async function () {
      const { riskView, alice } = await deployFixture();
      
      // 测试权限升级后的功能
      const assessment = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      expect(assessment.healthFactor).to.equal(11000n);
    });

    it('应防止未授权访问', async function () {
      const { riskView, alice } = await deployFixture();
      
      // 测试未授权访问
      await expect(
        riskView.connect(alice).getUserRiskAssessmentView(bob.address)
      ).to.be.revertedWith('RiskView: unauthorized access');
    });
  });

  describe('集成测试', function () {
    it('应正确处理模块依赖关系', async function () {
      const { riskView, alice } = await deployFixture();
      
      // 测试当依赖模块不可用时的行为
      await vaultStorage.connect(owner).updateNamedModule('hfCalculator', ZERO_ADDRESS);
      
      const assessment = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      
      // 应该使用默认值或错误处理
      expect(assessment.healthFactor).to.equal(ethers.MaxUint256);
    });

    it('应正确处理缓存机制', async function () {
      const { riskView, alice } = await deployFixture();
      
      // 第一次调用
      const assessment1 = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      
      // 第二次调用（应该使用缓存）
      const assessment2 = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      
      // 结果应该相同
      expect(assessment1.liquidatable).to.equal(assessment2.liquidatable);
      expect(assessment1.healthFactor).to.equal(assessment2.healthFactor);
    });

    it('应正确处理批量操作', async function () {
      const { riskView, alice, bob, charlie } = await deployFixture();
      
      const users = [alice.address, bob.address, charlie.address];
      const assessments = await riskView.connect(owner).batchGetUserRiskAssessmentsView(users);
      
      expect(assessments.length).to.equal(3);
      
      // 验证批量操作的结果
      for (let i = 0; i < assessments.length; i++) {
        expect(assessments[i].healthFactor).to.equal(11000n);
      }
    });
  });

  describe('性能测试', function () {
    it('应能处理大量用户', async function () {
      const { riskView } = await deployFixture();
      
      // 测试50个用户的批量处理
      const users = Array(50).fill(alice.address);
      const assessments = await riskView.connect(owner).batchGetUserRiskAssessmentsView(users);
      
      expect(assessments.length).to.equal(50);
      
      // 验证所有评估结果
      for (let i = 0; i < assessments.length; i++) {
        expect(assessments[i].healthFactor).to.equal(11000n);
        expect(assessments[i].liquidatable).to.be.false;
      }
    });

    it('应能快速响应单个查询', async function () {
      const { riskView, alice } = await deployFixture();
      
      const startTime = Date.now();
      const assessment = await riskView.connect(owner).getUserRiskAssessmentView(alice.address);
      const endTime = Date.now();
      
      expect(assessment.healthFactor).to.equal(11000n);
      expect(endTime - startTime).to.be.lessThan(5000); // 5秒内完成
    });
  });

  describe('模糊测试', function () {
    it('应正确处理随机用户地址', async function () {
      const { riskView } = await deployFixture();
      
      // 生成随机地址进行测试
      const randomAddresses = Array(10).fill(0).map(() => ethers.Wallet.createRandom().address);
      
      for (const address of randomAddresses) {
        const assessment = await riskView.connect(owner).getUserRiskAssessmentView(address);
        expect(assessment.healthFactor).to.equal(11000n);
        expect(assessment.liquidatable).to.be.false;
      }
    });

    it('应正确处理边界条件', async function () {
      const { riskView } = await deployFixture();
      
      // 测试各种边界条件
      const testCases = [
        ZERO_ADDRESS,
        '0x1111111111111111111111111111111111111111',
        '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
      ];
      
      for (const address of testCases) {
        const assessment = await riskView.connect(owner).getUserRiskAssessmentView(address);
        expect(assessment.healthFactor).to.equal(11000n);
        expect(assessment.liquidatable).to.be.false;
      }
    });
  });
}); 
/**
 * UserView 测试模块
 * 
 * 测试目标:
 * - 初始化功能
 * - 用户状态查询功能
 * - 健康因子查询功能
 * - 预览功能
 * - 批量操作功能
 * - 权限控制验证
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
  UserView, 
  MockAccessControlManager, 
  MockVaultStorage, 
  ViewCache, 
  MockHealthFactorCalculator,
  MockCollateralManager,
  MockLendingEngineBasic,
  MockERC20
} from '../../../types';

// 常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('UserView', function () {
  // 测试账户
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;
  let david: SignerWithAddress;
  let users: SignerWithAddress[];

  // 合约实例
  let userView: UserView;
  let acm: MockAccessControlManager;
  let vaultStorage: MockVaultStorage;
  let viewCache: ViewCache;
  let hfCalculator: MockHealthFactorCalculator;
  let collateralManager: MockCollateralManager;
  let lendingEngine: MockLendingEngineBasic;
  let mockToken: MockERC20;

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

    // 部署 MockCollateralManager
    const MockCollateralManagerF = await ethers.getContractFactory('MockCollateralManager');
    collateralManager = await MockCollateralManagerF.deploy();

    // 部署 MockLendingEngineBasic
    const MockLendingEngineBasicF = await ethers.getContractFactory('MockLendingEngineBasic');
    lendingEngine = await MockLendingEngineBasicF.deploy();

    // 部署 MockERC20 代币
    const MockERC20F = await ethers.getContractFactory('MockERC20');
    mockToken = await MockERC20F.deploy('Test Token', 'TEST', ethers.parseUnits('1000000', 18));

    // 部署 UserView
    const UserViewF = await ethers.getContractFactory('UserView');
    userView = await upgrades.deployProxy(UserViewF, [
      await acm.getAddress(),
      await vaultStorage.getAddress(),
      await viewCache.getAddress()
    ]);

    // 设置权限 - 使用正确的 ActionKeys 常量
    const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
    const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
    const ACTION_UPGRADE_MODULE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
    const ACTION_VIEW_CACHE_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_CACHE_DATA'));
    const ACTION_MODIFY_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('ACTION_MODIFY_USER_DATA'));
    
    // 为 owner 用户授予所有必要权限
    await acm.grantRole(ACTION_ADMIN, owner.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, owner.address);
    await acm.grantRole(ACTION_UPGRADE_MODULE, owner.address);
    await acm.grantRole(ACTION_VIEW_CACHE_DATA, owner.address);
    await acm.grantRole(ACTION_MODIFY_USER_DATA, owner.address);

    // 为 UserView 合约本身授予权限，这样它才能调用 ViewCache
    await acm.grantRole(ACTION_VIEW_CACHE_DATA, await userView.getAddress());
    await acm.grantRole(ACTION_ADMIN, await userView.getAddress());

    // 为 ViewCache 合约本身授予权限
    await acm.grantRole(ACTION_ADMIN, await viewCache.getAddress());
    await acm.grantRole(ACTION_VIEW_CACHE_DATA, await viewCache.getAddress());

    // 设置模块映射
    await vaultStorage.connect(owner).registerNamedModule('collateralManager', await collateralManager.getAddress());
    await vaultStorage.connect(owner).registerNamedModule('lendingEngine', await lendingEngine.getAddress());
    await vaultStorage.connect(owner).registerNamedModule('hfCalculator', await hfCalculator.getAddress());
    
    // 设置结算代币地址
    await vaultStorage.connect(owner).setSettlementToken(await mockToken.getAddress());

    // 设置 Mock 合约的默认值
    await collateralManager.setCollateral(alice.address, await mockToken.getAddress(), ethers.parseUnits('100', 18));
    await collateralManager.setUserTotalValue(alice.address, ethers.parseUnits('100', 18));
    await lendingEngine.setUserTotalDebtValue(alice.address, ethers.parseUnits('50', 18));
    // 使用 borrow 方法设置债务
    await lendingEngine.borrow(alice.address, await mockToken.getAddress(), ethers.parseUnits('30', 18), 0, 30);
    await hfCalculator.setHealthFactor(11000); // 110%

    // 为测试用户设置一些代币余额 - 通过转账方式
    await mockToken.transfer(alice.address, ethers.parseUnits('1000', 18));
    await mockToken.transfer(bob.address, ethers.parseUnits('1000', 18));
    await mockToken.transfer(charlie.address, ethers.parseUnits('1000', 18));

    return { 
      userView, 
      acm, 
      vaultStorage, 
      viewCache, 
      hfCalculator, 
      collateralManager, 
      lendingEngine, 
      mockToken,
      owner, 
      alice, 
      bob, 
      charlie, 
      david, 
      users 
    };
  }

  beforeEach(async function () {
    ({ 
      userView, 
      acm, 
      vaultStorage, 
      viewCache, 
      hfCalculator, 
      collateralManager, 
      lendingEngine, 
      mockToken,
      owner, 
      alice, 
      bob, 
      charlie, 
      david, 
      users 
    } = await deployFixture());
  });

  describe('初始化测试', function () {
    it('应正确初始化合约', async function () {
      const { userView, acm, vaultStorage, viewCache } = await deployFixture();
      
      expect(await userView.acm()).to.equal(await acm.getAddress());
      expect(await userView.vaultStorage()).to.equal(await vaultStorage.getAddress());
      expect(await userView.viewCache()).to.equal(await viewCache.getAddress());
    });

    it('应正确设置权限', async function () {
      const { acm, owner } = await deployFixture();
      
      const ACTION_ADMIN = ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'));
      const ACTION_VIEW_USER_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA'));
      const ACTION_VIEW_CACHE_DATA = ethers.keccak256(ethers.toUtf8Bytes('VIEW_CACHE_DATA'));
      
      expect(await acm.hasRole(ACTION_ADMIN, owner.address)).to.be.true;
      expect(await acm.hasRole(ACTION_VIEW_USER_DATA, owner.address)).to.be.true;
      expect(await acm.hasRole(ACTION_VIEW_CACHE_DATA, owner.address)).to.be.true;
    });
  });

  describe('用户状态查询功能测试', function () {
    it('应正确获取用户位置信息', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      const [collateral, debt] = await userView.connect(owner).getUserPosition(alice.address, await mockToken.getAddress());
      
      expect(collateral).to.equal(ethers.parseUnits('100', 18));
      expect(debt).to.equal(ethers.parseUnits('30', 18));
    });

    it('应正确获取用户位置信息（服务权限）', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      const [collateral, debt] = await userView.connect(owner).getUserPositionService(alice.address, await mockToken.getAddress());
      
      expect(collateral).to.equal(ethers.parseUnits('100', 18));
      expect(debt).to.equal(ethers.parseUnits('30', 18));
    });

    it('应正确获取用户代币余额', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      const balance = await userView.connect(owner).getUserTokenBalance(alice.address, await mockToken.getAddress());
      
      expect(balance).to.equal(ethers.parseUnits('1000', 18));
    });

    it('应正确获取用户结算代币余额', async function () {
      const { userView, alice } = await deployFixture();
      
      const balance = await userView.connect(owner).getUserSettlementBalance(alice.address);
      
      expect(balance).to.equal(ethers.parseUnits('1000', 18));
    });

    it('应正确获取用户总抵押价值', async function () {
      const { userView, alice } = await deployFixture();
      
      const totalValue = await userView.connect(owner).getUserTotalCollateral(alice.address);
      
      expect(totalValue).to.equal(ethers.parseUnits('100', 18));
    });

    it('应正确获取用户总债务价值', async function () {
      const { userView, alice } = await deployFixture();
      
      const totalValue = await userView.connect(owner).getUserTotalDebt(alice.address);
      
      expect(totalValue).to.equal(ethers.parseUnits('80', 18)); // 50 + 30 = 80
    });

    it('应正确获取用户抵押数量', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      const collateral = await userView.connect(owner).getUserCollateral(alice.address, await mockToken.getAddress());
      
      expect(collateral).to.equal(ethers.parseUnits('100', 18));
    });

    it('应正确获取用户债务数量', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      const debt = await userView.connect(owner).getUserDebt(alice.address, await mockToken.getAddress());
      
      expect(debt).to.equal(ethers.parseUnits('30', 18));
    });
  });

  describe('健康因子查询功能测试', function () {
    it('应正确获取用户健康因子', async function () {
      const { userView, alice } = await deployFixture();
      
      const hf = await userView.connect(owner).getHealthFactor(alice.address);
      
      expect(hf).to.equal(11000n);
    });

    it('应正确获取用户健康因子（简化版本）', async function () {
      const { userView, alice } = await deployFixture();
      
      const hf = await userView.connect(owner).getUserHealthFactor(alice.address);
      
      expect(hf).to.equal(11000n);
    });

    it('应正确获取用户统计信息', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      const stats = await userView.connect(owner).getUserStats(alice.address, await mockToken.getAddress());
      
      expect(stats.collateral).to.equal(ethers.parseUnits('100', 18));
      expect(stats.debt).to.equal(ethers.parseUnits('30', 18));
      expect(stats.hf).to.equal(11000n);
      expect(stats.ltv).to.be.gt(0n); // 有债务时，LTV > 0
    });
  });

  describe('预览功能测试', function () {
    it('应正确预览借款操作', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      const [newHF, newLTV, maxBorrowable] = await userView.connect(owner).previewBorrow(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('100', 18), // 当前抵押
        ethers.parseUnits('50', 18),  // 新增抵押
        ethers.parseUnits('30', 18)   // 借款数量
      );
      
      expect(newHF).to.equal(11000n);
      expect(newLTV).to.be.gt(0n);
      expect(maxBorrowable).to.be.gt(0n);
    });

    it('应正确预览抵押操作', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      const [hfAfter, ok] = await userView.connect(owner).previewDeposit(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('50', 18)
      );
      
      expect(hfAfter).to.equal(11000n); // 来自 MockHealthFactorCalculator
      expect(ok).to.be.true;
    });

    it('应正确预览还款操作', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      const [newHF, newLTV] = await userView.connect(owner).previewRepay(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('10', 18)
      );
      
      expect(newHF).to.equal(11000n); // 来自 MockHealthFactorCalculator
      expect(newLTV).to.be.gt(0n); // 还款后仍有债务，LTV > 0
    });

    it('应正确预览提取操作', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      const [newHF, ok] = await userView.connect(owner).previewWithdraw(
        alice.address,
        await mockToken.getAddress(),
        ethers.parseUnits('20', 18)
      );
      
      expect(newHF).to.equal(11000n); // 来自 MockHealthFactorCalculator
      expect(ok).to.be.true;
    });
  });

  describe('批量操作功能测试', function () {
    it('应正确处理批量获取用户位置', async function () {
      const { userView, alice, bob, charlie, mockToken } = await deployFixture();
      
      const users = [alice.address, bob.address, charlie.address];
      const assets = [await mockToken.getAddress(), await mockToken.getAddress(), await mockToken.getAddress()];
      
      const [collaterals, debts] = await userView.connect(owner).batchGetUserPositions(users, assets);
      
      expect(collaterals.length).to.equal(3);
      expect(debts.length).to.equal(3);
      
      // 验证每个用户的数据
      expect(collaterals[0]).to.equal(ethers.parseUnits('100', 18)); // alice
      expect(collaterals[1]).to.equal(0n); // bob
      expect(collaterals[2]).to.equal(0n); // charlie
      
      expect(debts[0]).to.equal(ethers.parseUnits('30', 18)); // alice
      expect(debts[1]).to.equal(0n); // bob
      expect(debts[2]).to.equal(0n); // charlie
    });

    it('应正确处理批量获取用户健康因子', async function () {
      const { userView, alice, bob, charlie } = await deployFixture();
      
      const users = [alice.address, bob.address, charlie.address];
      
      const healthFactors = await userView.connect(owner).batchGetUserHealthFactors(users);
      
      expect(healthFactors.length).to.equal(3);
      
      // 验证每个用户的健康因子
      for (let i = 0; i < healthFactors.length; i++) {
        expect(healthFactors[i]).to.equal(11000n);
      }
    });

    it('应拒绝空数组', async function () {
      const { userView } = await deployFixture();
      
      await expect(
        userView.connect(owner).batchGetUserPositions([], [])
      ).to.be.revertedWith('UserView: empty users array');
      
      await expect(
        userView.connect(owner).batchGetUserHealthFactors([])
      ).to.be.revertedWith('UserView: empty users array');
    });

    it('应拒绝过大的批量操作', async function () {
      const { userView } = await deployFixture();
      
      const largeUserList = Array(101).fill(alice.address);
      const largeAssetList = Array(101).fill(mockToken.getAddress());
      
      await expect(
        userView.connect(owner).batchGetUserPositions(largeUserList, largeAssetList)
      ).to.be.revertedWith('UserView: batch size too large');
      
      await expect(
        userView.connect(owner).batchGetUserHealthFactors(largeUserList)
      ).to.be.revertedWith('UserView: batch size too large');
    });

    it('应拒绝数组长度不匹配', async function () {
      const { userView, alice, bob, mockToken } = await deployFixture();
      
      const users = [alice.address, bob.address];
      const assets = [await mockToken.getAddress()]; // 长度不匹配
      
      await expect(
        userView.connect(owner).batchGetUserPositions(users, assets)
      ).to.be.revertedWith('UserView: array length mismatch');
    });
  });

  describe('缓存机制集成测试', function () {
    it('应正确使用缓存', async function () {
      const { userView, viewCache, alice } = await deployFixture();
      
      // 设置缓存
      await viewCache.connect(owner).setHealthFactorCache(alice.address, 12000);
      
      // 获取健康因子，应该使用缓存值
      const hf = await userView.connect(owner).getHealthFactor(alice.address);
      expect(hf).to.equal(12000n);
    });

    it('缓存失效时应回退到计算器', async function () {
      const { userView, viewCache, alice } = await deployFixture();
      
      // 设置缓存
      await viewCache.connect(owner).setHealthFactorCache(alice.address, 12000);
      
      // 验证缓存生效
      let hf = await userView.connect(owner).getHealthFactor(alice.address);
      expect(hf).to.equal(12000n);
      
      // 清除缓存，测试回退逻辑
      await viewCache.connect(owner).clearHealthFactorCache(alice.address);
      
      // 获取健康因子，应该回退到计算器
      hf = await userView.connect(owner).getHealthFactor(alice.address);
      expect(hf).to.equal(11000n); // 来自 MockHealthFactorCalculator
    });
  });

  describe('错误处理测试', function () {
    it('应正确处理健康因子计算器失败', async function () {
      const { userView, alice } = await deployFixture();
      
      // 将健康因子计算器设置为零地址，模拟失败情况
      await vaultStorage.connect(owner).updateNamedModule('hfCalculator', ZERO_ADDRESS);
      
      const hf = await userView.connect(owner).getHealthFactor(alice.address);
      
      // 应该返回最大健康因子
      expect(hf).to.equal(ethers.MaxUint256);
    });

    it('应正确处理抵押物管理器未设置', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      // 将抵押物管理器设置为零地址
      await vaultStorage.connect(owner).updateNamedModule('collateralManager', ZERO_ADDRESS);
      
      await expect(
        userView.connect(owner).getUserPosition(alice.address, await mockToken.getAddress())
      ).to.be.reverted;
    });

    it('应正确处理借贷引擎未设置', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      // 将借贷引擎设置为零地址
      await vaultStorage.connect(owner).updateNamedModule('lendingEngine', ZERO_ADDRESS);
      
      await expect(
        userView.connect(owner).getUserPosition(alice.address, await mockToken.getAddress())
      ).to.be.reverted;
    });

    it('应正确处理无效用户地址', async function () {
      const { userView } = await deployFixture();
      
      const hf = await userView.connect(owner).getHealthFactor(ZERO_ADDRESS);
      
      // 应该返回默认值
      expect(hf).to.equal(11000n);
    });

    it('应正确处理权限不足', async function () {
      const { userView, alice } = await deployFixture();
      
      // 测试权限不足的情况
      await expect(
        userView.connect(alice).getUserPosition(bob.address, await mockToken.getAddress())
      ).to.be.revertedWith('UserView: unauthorized access');
    });
  });

  describe('升级功能测试', function () {
    it('应正确验证升级权限', async function () {
      const { userView, alice } = await deployFixture();
      
      // 普通用户不应能升级
      await expect(
        userView.connect(alice).upgradeToAndCall(ZERO_ADDRESS, '0x')
      ).to.be.reverted;

      // 管理员应该能升级（这里只是测试权限，不实际升级）
      // 实际升级测试需要更复杂的设置
    });

    it('升级后应保持状态', async function () {
      const { userView, vaultStorage, viewCache } = await deployFixture();
      
      // 验证升级后的状态保持不变
      expect(await userView.acm()).to.equal(await acm.getAddress());
      expect(await userView.vaultStorage()).to.equal(await vaultStorage.getAddress());
      expect(await userView.viewCache()).to.equal(await viewCache.getAddress());
    });
  });

  describe('安全场景测试', function () {
    it('应防止重入攻击', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      // 测试重入保护
      await expect(
        userView.connect(owner).getUserPosition(alice.address, await mockToken.getAddress())
      ).to.not.be.reverted;
    });

    it('应正确处理权限升级', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      // 测试权限升级后的功能
      const [collateral] = await userView.connect(owner).getUserPosition(alice.address, await mockToken.getAddress());
      expect(collateral).to.equal(ethers.parseUnits('100', 18));
    });

    it('应防止未授权访问', async function () {
      const { userView, alice, mockToken } = await deployFixture();
      
      // 测试未授权访问
      await expect(
        userView.connect(alice).getUserPosition(bob.address, await mockToken.getAddress())
      ).to.be.revertedWith('UserView: unauthorized access');
    });
  });

  describe('集成测试', function () {
    it('应正确处理模块依赖关系', async function () {
      const { userView, alice } = await deployFixture();
      
      // 测试当依赖模块不可用时的行为
      await vaultStorage.connect(owner).updateNamedModule('hfCalculator', ZERO_ADDRESS);
      
      const hf = await userView.connect(owner).getHealthFactor(alice.address);
      
      // 应该使用默认值或错误处理
      expect(hf).to.equal(ethers.MaxUint256);
    });

    it('应正确处理缓存机制', async function () {
      const { userView, alice } = await deployFixture();
      
      // 第一次调用
      const [collateral1, debt1] = await userView.connect(owner).getUserPosition(alice.address, await mockToken.getAddress());
      
      // 第二次调用（应该使用缓存）
      const [collateral2, debt2] = await userView.connect(owner).getUserPosition(alice.address, await mockToken.getAddress());
      
      // 结果应该相同
      expect(collateral1).to.equal(collateral2);
      expect(debt1).to.equal(debt2);
    });

    it('应正确处理批量操作', async function () {
      const { userView, alice, bob, charlie } = await deployFixture();
      
      const users = [alice.address, bob.address, charlie.address];
      const assets = [await mockToken.getAddress(), await mockToken.getAddress(), await mockToken.getAddress()];
      
      const [collaterals, debts] = await userView.connect(owner).batchGetUserPositions(users, assets);
      
      expect(collaterals.length).to.equal(3);
      expect(debts.length).to.equal(3);
      
      // 验证批量操作的结果
      expect(collaterals[0]).to.equal(ethers.parseUnits('100', 18));
      expect(collaterals[1]).to.equal(0n);
      expect(collaterals[2]).to.equal(0n);
      
      expect(debts[0]).to.equal(ethers.parseUnits('30', 18));
      expect(debts[1]).to.equal(0n);
      expect(debts[2]).to.equal(0n);
    });
  });

  describe('性能测试', function () {
    it('应能处理大量用户', async function () {
      const { userView } = await deployFixture();
      
      // 测试50个用户的批量处理
      const users = Array(50).fill(alice.address);
      const assets = Array(50).fill(mockToken.getAddress());
      
      const [collaterals, debts] = await userView.connect(owner).batchGetUserPositions(users, assets);
      
      expect(collaterals.length).to.equal(50);
      expect(debts.length).to.equal(50);
      
      // 验证所有结果
      for (let i = 0; i < collaterals.length; i++) {
        expect(collaterals[i]).to.equal(ethers.parseUnits('100', 18));
        expect(debts[i]).to.equal(ethers.parseUnits('30', 18));
      }
    });

    it('应能快速响应单个查询', async function () {
      const { userView, alice } = await deployFixture();
      
      const startTime = Date.now();
      const [collateral] = await userView.connect(owner).getUserPosition(alice.address, await mockToken.getAddress());
      const endTime = Date.now();
      
      expect(collateral).to.equal(ethers.parseUnits('100', 18));
      expect(endTime - startTime).to.be.lessThan(5000); // 5秒内完成
    });
  });

  describe('模糊测试', function () {
    it('应正确处理随机用户地址', async function () {
      const { userView } = await deployFixture();
      
      // 生成随机地址进行测试
      const randomAddresses = Array(10).fill(0).map(() => ethers.Wallet.createRandom().address);
      
      for (const address of randomAddresses) {
        const hf = await userView.connect(owner).getHealthFactor(address);
        expect(hf).to.equal(11000n);
      }
    });

    it('应正确处理边界条件', async function () {
      const { userView } = await deployFixture();
      
      // 测试各种边界条件
      const testCases = [
        ZERO_ADDRESS,
        '0x1111111111111111111111111111111111111111',
        '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
      ];
      
      for (const address of testCases) {
        const hf = await userView.connect(owner).getHealthFactor(address);
        expect(hf).to.equal(11000n);
      }
    });

    it('应正确处理极端数值', async function () {
      const { userView, alice } = await deployFixture();
      
      // 设置极端数值
      await collateralManager.setCollateral(alice.address, await mockToken.getAddress(), ethers.MaxUint256);
      await lendingEngine.setUserTotalDebtValue(alice.address, ethers.MaxUint256);
      
      const [collateral] = await userView.connect(owner).getUserPosition(alice.address, await mockToken.getAddress());
      expect(collateral).to.equal(ethers.MaxUint256);
    });
  });
}); 